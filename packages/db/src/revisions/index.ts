import {
  projectToPublicOfferingAttributes,
  type CatalogDescription,
  type CatalogOfferingType,
  type ValidatedOfferingDraftInput,
} from "@punyasitus/core/catalog/index";
import {
  serializeDraftStoragePayload,
  StaleRevisionError,
  type OfferingSnapshot,
  type ResourceLifecycleStatus,
} from "@punyasitus/core/content/index";
import { getCatalogOfferingById } from "../catalog/index.ts";
import { getPageById } from "../pages/index.ts";
import { getPostById } from "../posts/index.ts";
import { buildAppendRevisionStatements } from "./append.ts";
import { hasContentRevisionHistoryColumns } from "./migrations.ts";
import {
  CURRENT_REVISION_SCHEMA_VERSION,
  formatRevisionId,
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
  RevisionConflictError,
  RevisionNotFoundError,
  RevisionValidationError,
  type ContentRevisionDetail,
  type ContentRevisionSummary,
  type ListContentRevisionsResult,
  type RestoreContentRevisionInput,
  type RestoreContentRevisionResult,
  type RevisionResourceType,
} from "./types.ts";
import {
  buildRevisionSummaryText,
  extractRevisionMetadataFromJson,
  extractSnapshotReferences,
  sanitizeRevisionSnapshotReferences,
  validateAndParseRevisionSnapshot,
  type RevisionReferenceLookup,
} from "./validation.ts";

/**
 * Per-Tenant Content Revision History & Safe Draft-Only Restore Repository
 * (`packages/db/src/revisions/index.ts`; TASK-064, REQ-048, PLAN §5 & §11.5).
 *
 * Invariants:
 * - Zero runtime DDL (`CREATE TABLE`/`ALTER TABLE` never executed at request time).
 * - Atomic latest-20 retention per `(resource_type, resource_id)` inside the exact same
 *   `tenantDb.batch([...])` as the parent create/update/publish/restore mutation.
 * - Restore writes DRAFT ONLY — `published_*_json`, `published_at`, `content_modified_at`,
 *   and `PLATFORM_DB.tenants.cache_version` remain 100% untouched until explicit Publish.
 * - Strict schema & single-tenant reference validation (rejects unsupported schemaVersion `422`,
 *   safely detaches deleted/foreign-tenant media/taxonomy/author references with warnings,
 *   enforces `expectedVersion` -> `409 STALE_VERSION`, and rejects restoring directly onto trashed items).
 */

export * from "./append.ts";
export * from "./migrations.ts";
export * from "./types.ts";
export * from "./validation.ts";

interface RawRevisionRow {
  readonly resource_type: RevisionResourceType;
  readonly resource_id: number;
  readonly revision_number: number;
  readonly snapshot_json: string;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly trigger_kind?: string | null;
  readonly schema_version?: number | null;
  readonly summary?: string | null;
}

interface RawTargetResourceRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: ResourceLifecycleStatus;
  readonly version: number;
  readonly deleted_at: number | null;
  readonly is_homepage?: number;
  readonly offering_type?: CatalogOfferingType;
  readonly published_at?: number | null;
  readonly content_modified_at?: number | null;
}

function getResourceTableName(resourceType: RevisionResourceType): "pages" | "posts" | "offerings" {
  if (resourceType === "page") return "pages";
  if (resourceType === "post") return "posts";
  return "offerings";
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RevisionValidationError(`Parameter ${field} harus berupa bilangan bulat positif.`, [
      { field, code: "INVALID_ID", message: `Expected a positive integer for ${field}.` },
    ]);
  }
}

async function fetchTargetResourceRow(
  tenantDb: D1Database,
  resourceType: RevisionResourceType,
  resourceId: number,
): Promise<RawTargetResourceRow | null> {
  const table = getResourceTableName(resourceType);
  return tenantDb
    .prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(resourceId)
    .first<RawTargetResourceRow>();
}

function mapRevisionRowToSummary(
  row: RawRevisionRow,
  resourceFallback: { readonly title?: string | null; readonly slug?: string | null },
): ContentRevisionSummary {
  const resourceType = row.resource_type;
  const resourceId = Number(row.resource_id);
  const revisionNumber = Number(row.revision_number);
  const revisionId = formatRevisionId(resourceType, resourceId, revisionNumber);
  const meta = extractRevisionMetadataFromJson(row.snapshot_json, {
    resourceType,
    rowTriggerKind: row.trigger_kind,
    rowSchemaVersion: row.schema_version !== undefined && row.schema_version !== null ? Number(row.schema_version) : null,
    rowSummary: row.summary,
    fallbackTitle: resourceFallback.title ?? null,
    fallbackSlug: resourceFallback.slug ?? null,
  });

  return {
    id: revisionId,
    revisionId,
    resourceType,
    resourceId,
    revisionNumber,
    schemaVersion: meta.schemaVersion,
    triggerKind: meta.triggerKind,
    actorUserId: row.created_by ?? null,
    summary: meta.summary ?? buildRevisionSummaryText({ resourceType, triggerKind: meta.triggerKind }),
    title: meta.title,
    slug: meta.slug,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

async function loadTenantReferenceLookup(
  tenantDb: D1Database,
  refs: {
    readonly mediaIds: readonly number[];
    readonly taxonomyIds: readonly number[];
    readonly authorId: number | null;
  },
): Promise<RevisionReferenceLookup> {
  const mediaById = new Map<number, { readonly status: string; readonly deletedAt: number | null }>();
  const taxonomyById = new Map<
    number,
    { readonly taxonomyType: string; readonly offeringType: string | null }
  >();
  const existingAuthorIds = new Set<number>();

  const queries: Promise<void>[] = [];

  if (refs.mediaIds.length > 0) {
    const placeholders = refs.mediaIds.map(() => "?").join(", ");
    queries.push(
      tenantDb
        .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
        .bind(...refs.mediaIds)
        .all<{ readonly id: number; readonly status: string; readonly deleted_at?: number | null }>()
        .then((res) => {
          for (const row of res.results) {
            mediaById.set(Number(row.id), {
              status: String(row.status),
              deletedAt:
                row.deleted_at !== undefined && row.deleted_at !== null ? Number(row.deleted_at) : null,
            });
          }
        }),
    );
  }

  if (refs.taxonomyIds.length > 0) {
    const placeholders = refs.taxonomyIds.map(() => "?").join(", ");
    queries.push(
      tenantDb
        .prepare(`SELECT id, taxonomy_type, offering_type FROM taxonomies WHERE id IN (${placeholders})`)
        .bind(...refs.taxonomyIds)
        .all<{
          readonly id: number;
          readonly taxonomy_type: string;
          readonly offering_type: string | null;
        }>()
        .then((res) => {
          for (const row of res.results) {
            taxonomyById.set(Number(row.id), {
              taxonomyType: String(row.taxonomy_type),
              offeringType: row.offering_type ?? null,
            });
          }
        }),
    );
  }

  if (refs.authorId !== null) {
    queries.push(
      tenantDb
        .prepare(`SELECT id FROM authors WHERE id = ? LIMIT 1`)
        .bind(refs.authorId)
        .first<{ readonly id: number }>()
        .then((row) => {
          if (row) existingAuthorIds.add(Number(row.id));
        }),
    );
  }

  await Promise.all(queries);

  return {
    mediaById,
    taxonomyById,
    existingAuthorIds,
  };
}

async function resolveTenantWhatsAppNumber(tenantDb: D1Database): Promise<string | null> {
  try {
    const row = await tenantDb
      .prepare(`SELECT whatsapp_e164 FROM business_profile WHERE id = 1 LIMIT 1`)
      .first<{ readonly whatsapp_e164: string | null }>();
    return row?.whatsapp_e164 ?? null;
  } catch {
    return null;
  }
}

/**
 * Lists up to the latest 20 content revisions for a `(resourceType, resourceId)` inside
 * the scoped tenant's `TenantStore`.
 */
export async function listContentRevisions(
  tenantDb: D1Database,
  params: {
    readonly resourceType: RevisionResourceType;
    readonly resourceId: number;
    readonly limit?: number;
  },
): Promise<ListContentRevisionsResult> {
  assertPositiveInt(params.resourceId, "resourceId");
  const limit = Math.max(
    1,
    Math.min(MAX_CONTENT_REVISIONS_PER_RESOURCE, params.limit ?? MAX_CONTENT_REVISIONS_PER_RESOURCE),
  );

  const resourceRow = await fetchTargetResourceRow(tenantDb, params.resourceType, params.resourceId);
  if (!resourceRow) {
    throw new RevisionNotFoundError(
      `Konten ${params.resourceType} #${params.resourceId} tidak ditemukan.`,
      { resourceType: params.resourceType, resourceId: params.resourceId },
    );
  }

  const res = await tenantDb
    .prepare(
      `SELECT *
       FROM content_revisions
       WHERE resource_type = ? AND resource_id = ?
       ORDER BY revision_number DESC
       LIMIT ?`,
    )
    .bind(params.resourceType, params.resourceId, limit)
    .all<RawRevisionRow>();

  const items = res.results.map((row) =>
    mapRevisionRowToSummary(row, { title: resourceRow.title, slug: resourceRow.slug }),
  );

  return {
    items,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    currentVersion: Number(resourceRow.version),
    resourceStatus: resourceRow.status,
    maxRetained: MAX_CONTENT_REVISIONS_PER_RESOURCE,
  };
}

/**
 * Loads one content revision including its validated snapshot payload and a live
 * single-tenant reference health report (media/taxonomy/author availability).
 */
export async function getContentRevision(
  tenantDb: D1Database,
  params: {
    readonly resourceType: RevisionResourceType;
    readonly resourceId: number;
    readonly revisionNumber: number;
  },
): Promise<ContentRevisionDetail> {
  assertPositiveInt(params.resourceId, "resourceId");
  assertPositiveInt(params.revisionNumber, "revisionNumber");

  const [resourceRow, revRow] = await Promise.all([
    fetchTargetResourceRow(tenantDb, params.resourceType, params.resourceId),
    tenantDb
      .prepare(
        `SELECT *
         FROM content_revisions
         WHERE resource_type = ? AND resource_id = ? AND revision_number = ?
         LIMIT 1`,
      )
      .bind(params.resourceType, params.resourceId, params.revisionNumber)
      .first<RawRevisionRow>(),
  ]);

  if (!resourceRow || !revRow) {
    throw new RevisionNotFoundError(
      `Revisi #${params.revisionNumber} untuk ${params.resourceType} #${params.resourceId} tidak ditemukan.`,
      {
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        revisionNumber: params.revisionNumber,
      },
    );
  }

  const tenantWhatsAppE164 =
    params.resourceType === "offering" ? await resolveTenantWhatsAppNumber(tenantDb) : null;

  const parsed = validateAndParseRevisionSnapshot(params.resourceType, revRow.snapshot_json, {
    rowSchemaVersion:
      revRow.schema_version !== undefined && revRow.schema_version !== null
        ? Number(revRow.schema_version)
        : null,
    rowTriggerKind: revRow.trigger_kind,
    expectedOfferingType: resourceRow.offering_type ?? null,
    tenantWhatsAppE164,
  });

  const refs = extractSnapshotReferences(parsed);
  const lookup = await loadTenantReferenceLookup(tenantDb, refs);
  const { report } = sanitizeRevisionSnapshotReferences(parsed, lookup, {
    detachMissingReferences: true,
  });

  const summary = mapRevisionRowToSummary(revRow, {
    title: resourceRow.title,
    slug: resourceRow.slug,
  });

  return {
    ...summary,
    snapshot: parsed.data as unknown as Record<string, unknown>,
    referenceReport: report,
    currentVersion: Number(resourceRow.version),
    resourceStatus: resourceRow.status,
  };
}

function serializeOfferingDescriptionForStorage(desc: CatalogDescription | null): string | null {
  if (desc === null) return null;
  return typeof desc === "string" ? desc : JSON.stringify(desc);
}

function createRestoreWriteToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Attaches a unique per-request `writeToken` to `_draftMetadata` inside a stored
 * draft envelope JSON string (`draft_sections_json` / `draft_body_json`) so concurrent
 * restores with identical `(expectedVersion, nowMs, revisionNumber)` produce distinct
 * draft column values and the losing writer's `commitGuard` / `post_taxonomies` guard
 * ALWAYS matches 0 rows.
 */
function attachDraftEnvelopeWriteToken(serializedJson: string, writeToken: string): string {
  const parsed = JSON.parse(serializedJson) as Record<string, unknown>;
  const existingMeta =
    parsed._draftMetadata &&
    typeof parsed._draftMetadata === "object" &&
    !Array.isArray(parsed._draftMetadata)
      ? (parsed._draftMetadata as Record<string, unknown>)
      : {};
  return JSON.stringify({
    ...parsed,
    _draftMetadata: {
      ...existingMeta,
      writeToken,
    },
  });
}

function buildRestoredOfferingDraftSnapshotJson(
  slug: string,
  validated: ValidatedOfferingDraftInput,
  writeToken: string,
): string {
  const data: OfferingSnapshot = {
    offeringType: validated.offeringType,
    slug,
    title: validated.title,
    summary: validated.summary,
    description: validated.description,
    coverMediaId: validated.coverMediaId,
    galleryMediaIds: [...validated.galleryMediaIds],
    videoMediaId: validated.videoMediaId,
    youtubeVideoId: validated.youtubeVideoId,
    priceMode: validated.pricing.priceMode,
    price: validated.pricing.price,
    priceMax: validated.pricing.priceMax,
    negotiable: validated.pricing.negotiable,
    originalAmount: validated.pricing.originalAmount,
    badge: validated.badge,
    badges: [...validated.badges],
    ctaMode: validated.cta.ctaMode,
    ctaLabel: validated.cta.ctaLabel,
    externalUrl: validated.cta.externalUrl,
    whatsappOverride: validated.cta.whatsappOverride,
    whatsappTemplate: validated.cta.whatsappTemplate,
    unitStatus: validated.unitStatus,
    categoryIds: [...validated.categoryIds],
    attributesVersion: validated.attributesVersion,
    attributes: projectToPublicOfferingAttributes(validated.offeringType, validated.attributes),
    verticalAttributes: { ...(validated.attributes as Record<string, unknown>) },
    seo: validated.seo,
  };
  return JSON.stringify({
    snapshotVersion: CURRENT_REVISION_SCHEMA_VERSION,
    resourceType: "offering",
    data,
    _draftMetadata: {
      badges: [...validated.badges],
      ctaLabel: validated.cta.ctaLabel,
      whatsappOverride: validated.cta.whatsappOverride,
      whatsappTemplate: validated.cta.whatsappTemplate,
      writeToken,
    },
  });
}

/**
 * Safely restores a historical revision into DRAFT state ONLY:
 * - ZERO mutation to `published_sections_json`, `published_body_json`, `published_snapshot_json`,
 *   `published_at`, `content_modified_at`, or `PLATFORM_DB.tenants.cache_version`.
 * - Enforces `expectedVersion` optimistic concurrency (`409 STALE_VERSION`).
 * - Rejects restoring directly onto a trashed resource (`409 CONFLICT` — restore from Trash first).
 * - Validates snapshot schema version (`422`) and sanitizes/detaches deleted or foreign-tenant
 *   media/taxonomy/author references cleanly.
 * - Atomically writes the restored draft, appends a `trigger_kind = 'restore'` revision
 *   (pruning to latest 20), and appends a PII-free `tenant_activity_log` audit row inside ONE
 *   `tenantDb.batch([...])`.
 */
export async function restoreContentRevision(
  tenantDb: D1Database,
  input: RestoreContentRevisionInput,
): Promise<RestoreContentRevisionResult> {
  assertPositiveInt(input.resourceId, "resourceId");
  assertPositiveInt(input.revisionNumber, "revisionNumber");
  assertPositiveInt(input.expectedVersion, "expectedVersion");

  const nowMs = input.nowMs ?? Date.now();
  const detachMissingReferences = input.detachMissingReferences ?? true;

  const [resourceRow, revRow, hasExtendedColumns] = await Promise.all([
    fetchTargetResourceRow(tenantDb, input.resourceType, input.resourceId),
    tenantDb
      .prepare(
        `SELECT *
         FROM content_revisions
         WHERE resource_type = ? AND resource_id = ? AND revision_number = ?
         LIMIT 1`,
      )
      .bind(input.resourceType, input.resourceId, input.revisionNumber)
      .first<RawRevisionRow>(),
    hasContentRevisionHistoryColumns(tenantDb),
  ]);

  if (!resourceRow) {
    throw new RevisionNotFoundError(
      `Konten ${input.resourceType} #${input.resourceId} tidak ditemukan.`,
      { resourceType: input.resourceType, resourceId: input.resourceId },
    );
  }

  if (resourceRow.status === "trashed" || resourceRow.deleted_at !== null) {
    throw new RevisionConflictError(
      "Konten sedang berada di Sampah. Pulihkan dari Sampah terlebih dahulu sebelum memulihkan revisi.",
      {
        code: "CONFLICT",
        currentVersion: Number(resourceRow.version),
        fields: [
          {
            field: "status",
            code: "RESOURCE_TRASHED",
            message: "Cannot restore a revision while the content item is in trash.",
          },
        ],
      },
    );
  }

  if (Number(resourceRow.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(resourceRow.version),
    });
  }

  if (!revRow) {
    throw new RevisionNotFoundError(
      `Revisi #${input.revisionNumber} untuk ${input.resourceType} #${input.resourceId} tidak ditemukan.`,
      {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        revisionNumber: input.revisionNumber,
      },
    );
  }

  const tenantWhatsAppE164 =
    input.resourceType === "offering" ? await resolveTenantWhatsAppNumber(tenantDb) : null;

  const parsed = validateAndParseRevisionSnapshot(input.resourceType, revRow.snapshot_json, {
    rowSchemaVersion:
      revRow.schema_version !== undefined && revRow.schema_version !== null
        ? Number(revRow.schema_version)
        : null,
    rowTriggerKind: revRow.trigger_kind,
    expectedOfferingType: resourceRow.offering_type ?? null,
    tenantWhatsAppE164,
  });

  const refs = extractSnapshotReferences(parsed);
  const lookup = await loadTenantReferenceLookup(tenantDb, refs);
  const { sanitized, report } = sanitizeRevisionSnapshotReferences(parsed, lookup, {
    detachMissingReferences,
  });

  const nextVersion = input.expectedVersion + 1;
  const preservedSlug = String(resourceRow.slug);
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "editor";

  const batchStmts: D1PreparedStatement[] = [];
  let revisionSnapshotData: Record<string, unknown>;
  let revisionTitle: string;
  const writeToken = createRestoreWriteToken();
  let commitGuard: { readonly sql: string; readonly binds: readonly unknown[] };

  if (sanitized.resourceType === "page") {
    let nextIsHomepage = Number(resourceRow.is_homepage ?? 0) === 1;
    if (resourceRow.status === "draft" && sanitized.data.isHomepage && !nextIsHomepage) {
      const existingHome = await tenantDb
        .prepare(`SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL AND id != ? LIMIT 1`)
        .bind(input.resourceId)
        .first<{ readonly id: number }>();
      nextIsHomepage = !existingHome;
    }

    const serialized = serializeDraftStoragePayload("page", {
      ...sanitized.data,
      slug: preservedSlug,
      isHomepage: nextIsHomepage,
    });
    const draftJsonWithToken = attachDraftEnvelopeWriteToken(serialized.json, writeToken);
    revisionSnapshotData = serialized.data as unknown as Record<string, unknown>;
    revisionTitle = serialized.data.title;
    commitGuard = {
      sql: `EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND draft_sections_json = ? AND updated_at = ? AND deleted_at IS NULL AND status != 'trashed')`,
      binds: [input.resourceId, nextVersion, draftJsonWithToken, nowMs] as const,
    };

    // DRAFT ONLY:
    // - If published: ONLY update `draft_sections_json`, `version`, `updated_at`.
    //   `published_sections_json`, `status`, `published_at`, `content_modified_at`, `slug`, `title`,
    //   `layout_mode`, `seo_json` remain 100% UNTOUCHED!
    // - If draft: update draft columns + `draft_sections_json`; `published_sections_json` stays NULL.
    if (resourceRow.status === "published") {
      batchStmts.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
          )
          .bind(draftJsonWithToken, nowMs, input.resourceId, input.expectedVersion),
      );
    } else if ("layout_mode" in resourceRow) {
      batchStmts.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET title = ?,
                 is_homepage = ?,
                 layout_mode = ?,
                 seo_json = ?,
                 draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
          )
          .bind(
            serialized.data.title,
            nextIsHomepage ? 1 : 0,
            serialized.data.layoutMode,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            draftJsonWithToken,
            nowMs,
            input.resourceId,
            input.expectedVersion,
          ),
      );
    } else {
      batchStmts.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET title = ?,
                 is_homepage = ?,
                 seo_json = ?,
                 draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
          )
          .bind(
            serialized.data.title,
            nextIsHomepage ? 1 : 0,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            draftJsonWithToken,
            nowMs,
            input.resourceId,
            input.expectedVersion,
          ),
      );
    }
  } else if (sanitized.resourceType === "post") {
    const serialized = serializeDraftStoragePayload("post", {
      ...sanitized.data,
      slug: preservedSlug,
    });
    const draftJsonWithToken = attachDraftEnvelopeWriteToken(serialized.json, writeToken);
    revisionSnapshotData = serialized.data as unknown as Record<string, unknown>;
    revisionTitle = serialized.data.title;
    commitGuard = {
      sql: `EXISTS (SELECT 1 FROM posts WHERE id = ? AND version = ? AND draft_body_json = ? AND updated_at = ? AND deleted_at IS NULL AND status != 'trashed')`,
      binds: [input.resourceId, nextVersion, draftJsonWithToken, nowMs] as const,
    };

    // DRAFT ONLY:
    // - If published: ONLY update `draft_body_json`, `version`, `updated_at` — live published body,
    //   metadata columns, `published_at`, `content_modified_at`, AND live `post_taxonomies` stay untouched!
    // - If draft: update draft columns + `draft_body_json` + sync `post_taxonomies`.
    if (resourceRow.status === "published") {
      batchStmts.push(
        tenantDb
          .prepare(
            `UPDATE posts
             SET draft_body_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
          )
          .bind(draftJsonWithToken, nowMs, input.resourceId, input.expectedVersion),
      );
    } else {
      batchStmts.push(
        tenantDb
          .prepare(
            `UPDATE posts
             SET title = ?,
                 excerpt = ?,
                 draft_body_json = ?,
                 primary_category_id = ?,
                 author_id = ?,
                 cover_media_id = ?,
                 reading_time_minutes = ?,
                 show_toc = ?,
                 seo_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
          )
          .bind(
            serialized.data.title,
            serialized.data.excerpt ?? null,
            draftJsonWithToken,
            serialized.data.primaryCategoryId ?? null,
            serialized.data.authorId ?? null,
            serialized.data.coverMediaId ?? null,
            serialized.data.readingTimeMinutes,
            serialized.data.showToc ? 1 : 0,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            nowMs,
            input.resourceId,
            input.expectedVersion,
          ),
      );

      const allTaxIds = [
        ...(serialized.data.categoryIds ?? []),
        ...(serialized.data.tagIds ?? []),
      ];

      batchStmts.push(
        tenantDb
          .prepare(`DELETE FROM post_taxonomies WHERE post_id = ? AND ${commitGuard.sql}`)
          .bind(input.resourceId, ...commitGuard.binds),
      );
      for (const taxId of allTaxIds) {
        batchStmts.push(
          tenantDb
            .prepare(
              `INSERT OR IGNORE INTO post_taxonomies (post_id, taxonomy_id)
               SELECT ?, ?
               WHERE ${commitGuard.sql}`,
            )
            .bind(input.resourceId, taxId, ...commitGuard.binds),
        );
      }
    }
  } else {
    // Offering (draft columns + draft_snapshot_json + offering_taxonomies;
    // `published_snapshot_json`, `status`, `published_at`, `content_modified_at` remain 100% UNTOUCHED!)
    const v = sanitized.validatedOffering;
    const draftSnapshotJson = buildRestoredOfferingDraftSnapshotJson(preservedSlug, v, writeToken);
    revisionSnapshotData = {
      ...sanitized.data,
      slug: preservedSlug,
    } as unknown as Record<string, unknown>;
    revisionTitle = v.title;
    commitGuard = {
      sql: `EXISTS (SELECT 1 FROM offerings WHERE id = ? AND version = ? AND draft_snapshot_json = ? AND updated_at = ? AND deleted_at IS NULL AND status != 'trashed')`,
      binds: [input.resourceId, nextVersion, draftSnapshotJson, nowMs] as const,
    };

    batchStmts.push(
      tenantDb
        .prepare(
          `UPDATE offerings
           SET title = ?,
               summary = ?,
               description = ?,
               cover_media_id = ?,
               gallery_media_ids_json = ?,
               video_media_id = ?,
               youtube_video_id = ?,
               price_mode = ?,
               price = ?,
               price_max = ?,
               negotiable = ?,
               original_amount = ?,
               badge = ?,
               cta_mode = ?,
               external_url = ?,
               unit_status = ?,
               attributes_version = ?,
               attributes_json = ?,
               draft_snapshot_json = ?,
               seo_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
        )
        .bind(
          v.title,
          v.summary,
          serializeOfferingDescriptionForStorage(v.description),
          v.coverMediaId,
          JSON.stringify(v.galleryMediaIds),
          v.videoMediaId,
          v.youtubeVideoId,
          v.pricing.priceMode,
          v.pricing.price,
          v.pricing.priceMax,
          v.pricing.negotiable ? 1 : 0,
          v.pricing.originalAmount,
          v.badge,
          v.cta.ctaMode,
          v.cta.externalUrl,
          v.unitStatus,
          v.attributesVersion,
          JSON.stringify(v.attributes),
          draftSnapshotJson,
          v.seo ? JSON.stringify(v.seo) : null,
          nowMs,
          input.resourceId,
          input.expectedVersion,
        ),
    );

    batchStmts.push(
      tenantDb
        .prepare(`DELETE FROM offering_taxonomies WHERE offering_id = ? AND ${commitGuard.sql}`)
        .bind(input.resourceId, ...commitGuard.binds),
    );
    for (const catId of v.categoryIds) {
      batchStmts.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO offering_taxonomies (offering_id, taxonomy_id)
             SELECT ?, ?
             WHERE ${commitGuard.sql}`,
          )
          .bind(input.resourceId, catId, ...commitGuard.binds),
      );
    }
  }

  const restoreSummary = buildRevisionSummaryText({
    resourceType: input.resourceType,
    triggerKind: "restore",
    title: revisionTitle,
    slug: preservedSlug,
    restoredFromRevisionNumber: input.revisionNumber,
  });

  // Append `trigger_kind = 'restore'` revision + prune to latest 20 atomically in the same batch!
  batchStmts.push(
    ...buildAppendRevisionStatements(tenantDb, {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      triggerKind: "restore",
      data: revisionSnapshotData,
      actorUserId,
      summary: restoreSummary,
      nowMs,
      hasExtendedColumns,
      guard: commitGuard,
    }),
  );

  // Append PII-free tenant activity audit log gated on commitGuard
  batchStmts.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'content.revision_restored', ?, ?, ?, ?, ?
         WHERE ${commitGuard.sql}`,
      )
      .bind(
        actorUserId,
        actorRole,
        input.resourceType,
        String(input.resourceId),
        restoreSummary,
        JSON.stringify({
          restoredFromRevisionNumber: input.revisionNumber,
          previousVersion: input.expectedVersion,
          nextVersion,
          draftOnly: true,
          detachedMediaCount: report.detachedMediaIds.length,
          missingTaxonomyCount: report.missingTaxonomyIds.length,
          detachedAuthor: report.missingAuthorId !== null,
        }),
        nowMs,
        ...commitGuard.binds,
      ),
  );

  const batchResults = await tenantDb.batch(batchStmts);
  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await fetchTargetResourceRow(tenantDb, input.resourceType, input.resourceId);
    if (!latest) {
      throw new RevisionNotFoundError(
        `Konten ${input.resourceType} #${input.resourceId} tidak ditemukan.`,
        { resourceType: input.resourceType, resourceId: input.resourceId },
      );
    }
    if (latest.status === "trashed" || latest.deleted_at !== null) {
      throw new RevisionConflictError(
        "Konten telah dipindahkan ke Sampah sebelum pemulihan revisi selesai.",
        { code: "CONFLICT", currentVersion: Number(latest.version) },
      );
    }
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  // Read back the newly created revision_number and refreshed draft resource DTO
  const [latestRevRow, refreshedResource] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT COALESCE(MAX(revision_number), 1) AS max_rev
         FROM content_revisions
         WHERE resource_type = ? AND resource_id = ?`,
      )
      .bind(input.resourceType, input.resourceId)
      .first<{ readonly max_rev: number }>(),
    input.resourceType === "page"
      ? getPageById(tenantDb, input.resourceId)
      : input.resourceType === "post"
        ? getPostById(tenantDb, input.resourceId)
        : getCatalogOfferingById(tenantDb, input.resourceId),
  ]);

  const newRevisionNumber = Number(latestRevRow?.max_rev ?? input.revisionNumber + 1);
  const resourceDto = (refreshedResource ?? {}) as unknown as Record<string, unknown>;
  const hasUnpublishedChanges =
    typeof resourceDto.hasUnpublishedChanges === "boolean"
      ? resourceDto.hasUnpublishedChanges
      : true;

  return {
    restored: true,
    revisionId: formatRevisionId(input.resourceType, input.resourceId, newRevisionNumber),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    restoredFromRevisionNumber: input.revisionNumber,
    newRevisionNumber,
    version: nextVersion,
    status: resourceRow.status,
    draftOnly: true,
    hasUnpublishedChanges,
    referenceReport: report,
    warnings: report.warnings,
    restoredAt: new Date(nowMs).toISOString(),
    resource: resourceDto,
  };
}

/**
 * Deletes all stored revisions for a hard-purged resource inside a tenant's `TenantStore`.
 * Mirrors the transactional revision cleanup performed by `purgeContentItem` (TASK-044).
 */
export async function purgeContentRevisionsForResource(
  tenantDb: D1Database,
  resourceType: RevisionResourceType,
  resourceId: number,
): Promise<{ readonly deletedCount: number }> {
  assertPositiveInt(resourceId, "resourceId");
  const res = await tenantDb
    .prepare(`DELETE FROM content_revisions WHERE resource_type = ? AND resource_id = ?`)
    .bind(resourceType, resourceId)
    .run();
  return { deletedCount: Number(res.meta?.changes ?? 0) };
}
