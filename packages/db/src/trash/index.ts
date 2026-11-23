import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import {
  PublicationAtomicError,
  StaleRevisionError,
  type ResourceLifecycleStatus,
} from "@punyasitus/core/content/index";
import {
  SlugValidationError,
  suggestAlternativeSlug,
  validateManualSlug,
  type SlugNamespace,
} from "@punyasitus/core/slug/index";
import {
  buildFormerSlugTransitionStatements,
  findResourceSlug,
  isSlugTakenInNamespace,
} from "../identifiers/index.ts";
import { bumpTenantCacheVersion } from "../publication/index.ts";
import {
  collectReferencedMediaIdsFromRow,
  findProtectedContentReferences,
  inspectContentMediaReferences,
} from "./references.ts";
import {
  computeTrashRetentionMeta,
  resolveContentPublicPath,
  resolveContentSlugNamespace,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
  TrashConflictError,
  TrashNotFoundError,
  TrashProtectedReferenceError,
  TrashValidationError,
  type ContentMediaReferenceReport,
  type ContentResourceType,
  type ProtectedContentReference,
  type ProtectedReferencePurgeFailure,
  type PurgeContentInput,
  type PurgeContentResult,
  type RestoreContentInput,
  type RestoreContentResult,
  type TenantContentPurgeSweepInput,
  type TenantContentPurgeSweepResult,
  type TrashContentInput,
  type TrashContentResult,
  type TrashedContentSummary,
} from "./types.ts";

/**
 * Unified, atomic Content Trash, Recovery & 30-Day Purge Repository
 * (`packages/db/src/trash/index.ts`; TASK-044, REQ-048, PLAN §11.5).
 *
 * Architectural & R3 Invariants:
 * - Zero runtime DDL (`CREATE TABLE` / `ALTER TABLE` never executed at request time).
 * - Trash: single `tenantDb.batch()` unpublishes (`published_*_json = NULL`, `status = 'trashed'`,
 *   `deleted_at = nowMs`), preserves draft content verbatim, appends PII-free audit
 *   (`WHERE changes() = 1`), and bumps `PLATFORM_DB.tenants.cache_version` with fail-closed
 *   compensation rollback if the platform DB bump fails.
 * - Restore: requires `expectedVersion` (`409 STALE_VERSION`), checks active/former slug and
 *   redirect collisions (`409 CONFLICT` with `suggestedSlug` and optional `resolvedSlug` rename),
 *   inspects media references cleanly without corrupting content, and restores strictly to `draft`
 *   (NEVER auto-publishes).
 * - Permanent Purge & 30-Day Expiry: verifies protected references (homepage, policy settings,
 *   active navigation menus), atomically clears join rows (`post_taxonomies`, `offering_taxonomies`),
 *   `resource_slugs`, and `content_revisions` (ready for TASK-064), permanently deletes the trashed
 *   row, records audit (`WHERE changes() = 1`), and ALWAYS preserves shared `media_items`!
 */

export * from "./types.ts";
export {
  collectReferencedMediaIdsFromRow,
  extractMediaIdsFromJsonString,
  extractMediaIdsFromJsonValue,
  findProtectedContentReferences,
  inspectContentMediaReferences,
} from "./references.ts";

interface RawContentRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: ResourceLifecycleStatus;
  readonly version: number;
  readonly published_at: number | null;
  readonly deleted_at: number | null;
  readonly updated_at: number;
  // page columns
  readonly is_homepage?: number;
  readonly draft_sections_json?: string | null;
  readonly published_sections_json?: string | null;
  // post columns
  readonly draft_body_json?: string | null;
  readonly published_body_json?: string | null;
  readonly cover_media_id?: number | null;
  // offering columns
  readonly offering_type?: CatalogOfferingType;
  readonly draft_snapshot_json?: string | null;
  readonly published_snapshot_json?: string | null;
  readonly gallery_media_ids_json?: string | null;
  readonly video_media_id?: number | null;
  readonly attributes_json?: string | null;
  // shared
  readonly seo_json?: string | null;
}

interface ResourceTableConfig {
  readonly table: "pages" | "posts" | "offerings";
  readonly draftCol: "draft_sections_json" | "draft_body_json" | "draft_snapshot_json";
  readonly publishedCol: "published_sections_json" | "published_body_json" | "published_snapshot_json";
  readonly taxonomyJoinTable: "post_taxonomies" | "offering_taxonomies" | null;
  readonly taxonomyJoinFkCol: "post_id" | "offering_id" | null;
}

const RESOURCE_TABLE_CONFIG: Readonly<Record<ContentResourceType, ResourceTableConfig>> = {
  page: {
    table: "pages",
    draftCol: "draft_sections_json",
    publishedCol: "published_sections_json",
    taxonomyJoinTable: null,
    taxonomyJoinFkCol: null,
  },
  post: {
    table: "posts",
    draftCol: "draft_body_json",
    publishedCol: "published_body_json",
    taxonomyJoinTable: "post_taxonomies",
    taxonomyJoinFkCol: "post_id",
  },
  offering: {
    table: "offerings",
    draftCol: "draft_snapshot_json",
    publishedCol: "published_snapshot_json",
    taxonomyJoinTable: "offering_taxonomies",
    taxonomyJoinFkCol: "offering_id",
  },
};

function assertValidResourceId(resourceId: number): void {
  if (!Number.isSafeInteger(resourceId) || resourceId < 1 || resourceId > 2_147_483_647) {
    throw new TrashValidationError("ID konten harus berupa bilangan bulat positif.", [
      { field: "id", code: "INVALID_ID", message: "Expected a positive sequential integer ID." },
    ]);
  }
}

function assertValidExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new TrashValidationError("Versi konten harus berupa bilangan bulat positif.", [
      { field: "version", code: "INVALID_VERSION", message: "Expected a positive integer version." },
    ]);
  }
}

function isSlugUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(msg)) return false;
  if (/pages_single_homepage_idx|is_homepage/i.test(msg)) return false;
  return /slug|resource_slugs/i.test(msg);
}

const PROTECTED_SETTINGS_PAGE_KEYS_SQL =
  "('homepagePageId','homepage_page_id','frontPageId','front_page_id','privacyPageId','privacy_page_id','termsPageId','terms_page_id','policyPageId','policy_page_id','legalPageId','legal_page_id','cookiePolicyPageId','cookie_policy_page_id')";

/**
 * Builds atomic in-SQL `NOT EXISTS` protected-reference predicates so concurrent menu,
 * site_settings, or homepage updates landing between pre-check and `batch()` execution
 * cause the purge `batch()` to match 0 rows cleanly.
 */
function buildAtomicProtectedReferenceGuard(
  resourceType: ContentResourceType,
  resourceId: number,
  tableAlias: string,
): { readonly sql: string; readonly binds: readonly unknown[] } {
  const clauses: string[] = [
    `NOT EXISTS (
       SELECT 1 FROM menus m,
         json_tree(CASE WHEN json_valid(m.items_json) THEN m.items_json ELSE '[]' END) jt
       WHERE jt.type = 'object'
         AND json_extract(jt.value, '$.targetType') = ?
         AND json_extract(jt.value, '$.targetResourceId') = ?
     )`,
    `NOT EXISTS (
       SELECT 1 FROM menus m,
         json_tree(CASE WHEN json_valid(m.draft_items_json) THEN m.draft_items_json ELSE '[]' END) jt
       WHERE jt.type = 'object'
         AND json_extract(jt.value, '$.targetType') = ?
         AND json_extract(jt.value, '$.targetResourceId') = ?
     )`,
    `NOT EXISTS (
       SELECT 1 FROM menus m,
         json_tree(CASE WHEN json_valid(m.published_items_json) THEN m.published_items_json ELSE '[]' END) jt
       WHERE jt.type = 'object'
         AND json_extract(jt.value, '$.targetType') = ?
         AND json_extract(jt.value, '$.targetResourceId') = ?
     )`,
  ];
  const binds: unknown[] = [
    resourceType,
    resourceId,
    resourceType,
    resourceId,
    resourceType,
    resourceId,
  ];

  if (resourceType === "page") {
    // Trashed ex-homepage is protected ONLY if no replacement active homepage exists
    clauses.push(
      `NOT (
         ${tableAlias}.is_homepage = 1
         AND NOT EXISTS (
           SELECT 1 FROM pages p_home
           WHERE p_home.id != ${tableAlias}.id
             AND p_home.is_homepage = 1
             AND p_home.deleted_at IS NULL
         )
       )`,
    );
    clauses.push(
      `NOT EXISTS (
         SELECT 1 FROM site_settings s,
           json_tree(CASE WHEN json_valid(s.published_json) THEN s.published_json ELSE '{}' END) jt
         WHERE s.id = 1
           AND jt.key IN ${PROTECTED_SETTINGS_PAGE_KEYS_SQL}
           AND jt.value = ?
       )`,
    );
    binds.push(resourceId);
    clauses.push(
      `NOT EXISTS (
         SELECT 1 FROM site_settings s,
           json_tree(CASE WHEN json_valid(s.draft_json) THEN s.draft_json ELSE '{}' END) jt
         WHERE s.id = 1
           AND jt.key IN ${PROTECTED_SETTINGS_PAGE_KEYS_SQL}
           AND jt.value = ?
       )`,
    );
    binds.push(resourceId);
  }

  return {
    sql: clauses.join(" AND "),
    binds,
  };
}

function updateSlugInsideStoredDraftJson(
  rawJson: string | null | undefined,
  nextSlug: string,
  demoteHomepage: boolean,
): string | null {
  if (rawJson === null || rawJson === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return rawJson;
    }
    const obj = parsed as Record<string, unknown>;
    // Draft envelope shape `{ kind, schemaVersion, data: { slug, isHomepage?, ... } }`
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      const dataObj = { ...(obj.data as Record<string, unknown>), slug: nextSlug };
      if (demoteHomepage && "isHomepage" in dataObj) {
        dataObj.isHomepage = false;
      }
      return JSON.stringify({ ...obj, data: dataObj });
    }
    // Flat snapshot shape (e.g. offerings `draft_snapshot_json`)
    if ("slug" in obj) {
      return JSON.stringify({ ...obj, slug: nextSlug });
    }
    return rawJson;
  } catch {
    return rawJson;
  }
}

async function fetchRawContentRow(
  tenantDb: D1Database,
  resourceType: ContentResourceType,
  resourceId: number,
): Promise<RawContentRow | null> {
  const cfg = RESOURCE_TABLE_CONFIG[resourceType];
  return tenantDb
    .prepare(`SELECT * FROM ${cfg.table} WHERE id = ? LIMIT 1`)
    .bind(resourceId)
    .first<RawContentRow>();
}

async function isSlugOccupiedForRestore(
  tenantDb: D1Database,
  params: {
    readonly resourceType: ContentResourceType;
    readonly offeringType: CatalogOfferingType | null;
    readonly namespace: SlugNamespace;
    readonly resourceId: number;
    readonly slug: string;
  },
): Promise<{
  readonly conflict: boolean;
  readonly kind?: "active_resource" | "former_slug_redirect" | "custom_redirect";
}> {
  const { resourceType, offeringType, namespace, resourceId, slug } = params;

  // 1. Check active/other rows in the content table itself
  if (resourceType === "page") {
    const clash = await tenantDb
      .prepare(`SELECT id FROM pages WHERE slug = ? AND id != ? LIMIT 1`)
      .bind(slug, resourceId)
      .first<{ readonly id: number }>();
    if (clash) return { conflict: true, kind: "active_resource" };
  } else if (resourceType === "post") {
    const clash = await tenantDb
      .prepare(`SELECT id FROM posts WHERE slug = ? AND id != ? LIMIT 1`)
      .bind(slug, resourceId)
      .first<{ readonly id: number }>();
    if (clash) return { conflict: true, kind: "active_resource" };
  } else {
    const clash = await tenantDb
      .prepare(`SELECT id FROM offerings WHERE offering_type = ? AND slug = ? AND id != ? LIMIT 1`)
      .bind(offeringType ?? "service", slug, resourceId)
      .first<{ readonly id: number }>();
    if (clash) return { conflict: true, kind: "active_resource" };
  }

  // 2. Check `resource_slugs` (both current slugs AND former-slug 308 redirects of OTHER resources)
  const slugRow = await findResourceSlug(tenantDb, namespace, slug);
  if (slugRow && slugRow.resourceId !== resourceId) {
    return {
      conflict: true,
      kind: slugRow.isCurrent ? "active_resource" : "former_slug_redirect",
    };
  }

  // 3. Check active migration redirects table (`redirects`) so restore never collides with an active redirect
  const publicPath = resolveContentPublicPath(resourceType, slug, offeringType, false);
  const redirectRow = await tenantDb
    .prepare(`SELECT source_path FROM redirects WHERE source_path = ? AND active = 1 LIMIT 1`)
    .bind(publicPath)
    .first<{ readonly source_path: string }>();
  if (redirectRow) {
    return { conflict: true, kind: "custom_redirect" };
  }

  return { conflict: false };
}

async function suggestFreeRestoreSlug(
  tenantDb: D1Database,
  params: {
    readonly resourceType: ContentResourceType;
    readonly offeringType: CatalogOfferingType | null;
    readonly namespace: SlugNamespace;
    readonly resourceId: number;
    readonly baseSlug: string;
  },
): Promise<string> {
  return suggestAlternativeSlug(
    params.baseSlug,
    async (candidate) => {
      const check = await isSlugOccupiedForRestore(tenantDb, {
        ...params,
        slug: candidate,
      });
      if (check.conflict) return true;
      return isSlugTakenInNamespace(tenantDb, params.namespace, candidate);
    },
    { namespace: params.namespace },
  );
}

/**
 * Atomically moves a page, blog post, or catalog offering to 30-day trash:
 * - Clears published snapshot (`published_*_json = NULL`) so public routes, archives,
 *   former-slug redirects, and sitemap immediately exclude it.
 * - Preserves all draft content columns untouched for lossless recovery.
 * - Records a PII-free `tenant_activity_log` audit entry (`WHERE changes() = 1`)
 *   inside the same `tenantDb.batch()`.
 * - Bumps `PLATFORM_DB.tenants.cache_version` if previously published, with fail-closed
 *   compensation rollback on failure.
 */
export async function trashContentItem(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: TrashContentInput,
): Promise<TrashContentResult> {
  assertValidResourceId(input.resourceId);
  if (input.expectedVersion !== undefined) {
    assertValidExpectedVersion(input.expectedVersion);
  }
  const nowMs = input.nowMs ?? Date.now();
  const cfg = RESOURCE_TABLE_CONFIG[input.resourceType];

  const priorRow = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
  if (!priorRow || priorRow.status === "trashed" || priorRow.deleted_at !== null) {
    throw new TrashNotFoundError(
      input.resourceType,
      input.resourceId,
      `${input.resourceType} #${input.resourceId} tidak ditemukan.`,
    );
  }

  const targetVersion = input.expectedVersion ?? Number(priorRow.version);
  if (Number(priorRow.version) !== targetVersion) {
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: targetVersion,
      actualVersion: Number(priorRow.version),
    });
  }

  const priorPublishedJson =
    input.resourceType === "page"
      ? (priorRow.published_sections_json ?? null)
      : input.resourceType === "post"
        ? (priorRow.published_body_json ?? null)
        : (priorRow.published_snapshot_json ?? null);

  const wasPublished = priorRow.status === "published" || priorPublishedJson !== null;
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "editor";
  const auditSummary = `Memindahkan ${input.resourceType} "${priorRow.slug}" ke Sampah (retensi ${TRASH_RETENTION_DAYS} hari).`;
  const auditMeta = JSON.stringify({
    slug: priorRow.slug,
    wasPublished,
    previousVersion: targetVersion,
    nextVersion: targetVersion + 1,
    retentionDays: TRASH_RETENTION_DAYS,
  });

  const batchResults = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE ${cfg.table}
         SET status = 'trashed',
             ${cfg.publishedCol} = NULL,
             deleted_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL AND status != 'trashed'`,
      )
      .bind(nowMs, nowMs, input.resourceId, targetVersion),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'content.trashed', ?, ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        input.resourceType,
        String(input.resourceId),
        auditSummary,
        auditMeta,
        nowMs,
      ),
  ]);

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
    if (!latest || latest.status === "trashed" || latest.deleted_at !== null) {
      throw new TrashNotFoundError(input.resourceType, input.resourceId);
    }
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: targetVersion,
      actualVersion: Number(latest.version),
    });
  }

  const nextVersion = targetVersion + 1;
  let cacheVersion: number | null = null;

  if (wasPublished) {
    try {
      cacheVersion = await bumpTenantCacheVersion(platformDb, input.tenantId, nowMs);
    } catch (platformError) {
      let compensated = false;
      try {
        const compRes = await tenantDb
          .prepare(
            `UPDATE ${cfg.table}
             SET status = ?,
                 ${cfg.publishedCol} = ?,
                 deleted_at = NULL,
                 version = ?,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            priorRow.status,
            priorPublishedJson,
            priorRow.version,
            priorRow.updated_at,
            input.resourceId,
            nextVersion,
          )
          .run();
        compensated = (compRes.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation rollback failed; compensated remains false
      }
      throw new PublicationAtomicError(
        `Gagal menyinkronkan cache_version saat memindahkan ${input.resourceType} ke sampah${
          compensated ? "; perubahan dibatalkan secara atomik" : "; kompensasi gagal"
        }`,
        { compensated, cause: platformError },
      );
    }
  }

  const retention = computeTrashRetentionMeta(nowMs, nowMs);
  return {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    slug: String(priorRow.slug),
    title: String(priorRow.title),
    offeringType: input.resourceType === "offering" ? (priorRow.offering_type ?? "service") : null,
    status: "trashed",
    wasPublished,
    version: nextVersion,
    deletedAt: retention.deletedAt,
    purgeEligibleAt: retention.purgeEligibleAt,
    daysRemaining: retention.daysRemaining,
    cacheVersion,
    auditRecorded: (batchResults[1]?.meta?.changes ?? 0) === 1,
  };
}

/**
 * Restores a trashed page, blog post, or catalog offering strictly back into `draft` state
 * (NEVER auto-publishes; PLAN §11.5):
 * - Enforces `expectedVersion` (`409 STALE_VERSION`).
 * - Checks slug conflicts against active items, former-slug 308 redirects, and active custom
 *   redirects -> returns `409 CONFLICT` with `suggestedSlug` and ZERO partial writes.
 * - Supports explicit `resolvedSlug` rename path when resolving a slug collision.
 * - Inspects media references cleanly without corrupting draft content.
 * - Records audit (`WHERE changes() = 1`) in the same atomic `tenantDb.batch()`.
 */
export async function restoreContentItem(
  tenantDb: D1Database,
  input: RestoreContentInput,
): Promise<RestoreContentResult> {
  assertValidResourceId(input.resourceId);
  assertValidExpectedVersion(input.expectedVersion);
  const nowMs = input.nowMs ?? Date.now();
  const cfg = RESOURCE_TABLE_CONFIG[input.resourceType];

  const row = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
  if (!row) {
    throw new TrashNotFoundError(input.resourceType, input.resourceId);
  }
  if (row.status !== "trashed" || row.deleted_at === null) {
    throw new TrashConflictError(
      `Konten #${input.resourceId} tidak sedang berada di Sampah.`,
      {
        code: "CONFLICT",
        field: "status",
        fieldCode: "NOT_TRASHED",
        conflictKind: "not_trashed",
      },
    );
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const offeringType: CatalogOfferingType | null =
    input.resourceType === "offering" ? (row.offering_type ?? "service") : null;
  const namespace = resolveContentSlugNamespace(input.resourceType, offeringType);
  const previousSlug = String(row.slug);

  let targetSlug = previousSlug;
  if (input.resolvedSlug !== undefined) {
    targetSlug = validateManualSlug(input.resolvedSlug, { namespace });
  }

  // Check slug collisions BEFORE any write -> fail closed with 409 CONFLICT + suggestedSlug
  const conflictCheck = await isSlugOccupiedForRestore(tenantDb, {
    resourceType: input.resourceType,
    offeringType,
    namespace,
    resourceId: input.resourceId,
    slug: targetSlug,
  });

  if (conflictCheck.conflict) {
    const suggestedSlug = await suggestFreeRestoreSlug(tenantDb, {
      resourceType: input.resourceType,
      offeringType,
      namespace,
      resourceId: input.resourceId,
      baseSlug: targetSlug,
    });
    const detail =
      conflictCheck.kind === "former_slug_redirect"
        ? `Slug "${targetSlug}" sudah dipakai sebagai redirect slug lama konten lain.`
        : conflictCheck.kind === "custom_redirect"
          ? `Slug "${targetSlug}" bentrok dengan aturan redirect aktif.`
          : `Slug "${targetSlug}" sudah digunakan oleh konten lain di situs ini.`;
    throw new TrashConflictError(`${detail} Saran slug alternatif: "${suggestedSlug}".`, {
      code: "CONFLICT",
      field: "slug",
      fieldCode: "SLUG_CONFLICT",
      suggestedSlug,
      conflictKind: conflictCheck.kind,
    });
  }

  const nextVersion = input.expectedVersion + 1;
  let nextIsHomepage = input.resourceType === "page" && Number(row.is_homepage ?? 0) === 1;
  let homepageDemoted = false;

  if (nextIsHomepage) {
    const activeHome = await tenantDb
      .prepare(`SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL AND id != ? LIMIT 1`)
      .bind(input.resourceId)
      .first<{ readonly id: number }>();
    if (activeHome) {
      nextIsHomepage = false;
      homepageDemoted = true;
    }
  }

  const slugChanged = targetSlug !== previousSlug;
  const currentDraftRaw =
    input.resourceType === "page"
      ? (row.draft_sections_json ?? "[]")
      : input.resourceType === "post"
        ? (row.draft_body_json ?? "{}")
        : (row.draft_snapshot_json ?? null);

  const nextDraftRaw =
    slugChanged || homepageDemoted
      ? updateSlugInsideStoredDraftJson(currentDraftRaw, targetSlug, homepageDemoted)
      : currentDraftRaw;

  const slugStatements: D1PreparedStatement[] = [];
  if (slugChanged) {
    try {
      const transition = await buildFormerSlugTransitionStatements(tenantDb, {
        namespace,
        resourceId: input.resourceId,
        oldSlug: previousSlug,
        newSlug: targetSlug,
        wasEverPublished: row.published_at !== null,
        confirmSlugChange: true,
        allowSelfRevert: false,
        nowMs,
        guard: {
          sql: `EXISTS (SELECT 1 FROM ${cfg.table} WHERE id = ? AND slug = ? AND version = ? AND status = 'draft' AND deleted_at IS NULL)`,
          binds: [input.resourceId, targetSlug, nextVersion],
        },
      });
      slugStatements.push(...transition.statements);
    } catch (err) {
      if (err instanceof SlugValidationError && err.code === "SLUG_CONFLICT") {
        const suggestedSlug =
          err.suggestedSlug ??
          (await suggestFreeRestoreSlug(tenantDb, {
            resourceType: input.resourceType,
            offeringType,
            namespace,
            resourceId: input.resourceId,
            baseSlug: targetSlug,
          }));
        throw new TrashConflictError(
          `Slug "${targetSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggestedSlug}".`,
          {
            code: "CONFLICT",
            field: "slug",
            fieldCode: "SLUG_CONFLICT",
            suggestedSlug,
            conflictKind: "former_slug_redirect",
          },
        );
      }
      throw err;
    }
  } else {
    // Atomically ensure/refresh current resource_slugs row ONLY if Statement 0 restored this row
    // and ONLY if the slug row is owned by this same resourceId (never silently ignoring a foreign owner)
    slugStatements.push(
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           SELECT ?, ?, ?, 1, NULL, ?
           FROM ${cfg.table}
           WHERE id = ? AND slug = ? AND version = ? AND status = 'draft' AND deleted_at IS NULL
           ON CONFLICT(namespace, slug) DO UPDATE
             SET is_current = 1,
                 redirect_target_slug = NULL,
                 updated_at = excluded.updated_at
             WHERE resource_slugs.resource_id = excluded.resource_id`,
        )
        .bind(namespace, targetSlug, input.resourceId, nowMs, input.resourceId, targetSlug, nextVersion),
    );
  }

  const targetPublicPath = resolveContentPublicPath(
    input.resourceType,
    targetSlug,
    offeringType,
    false,
  );
  const atomicSlugOccupancyGuardSql = `
    AND NOT EXISTS (
      SELECT 1 FROM resource_slugs
      WHERE namespace = ? AND slug = ? AND resource_id != ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM redirects
      WHERE source_path = ? AND active = 1
    )`;
  const atomicSlugOccupancyBinds = [
    namespace,
    targetSlug,
    input.resourceId,
    targetPublicPath,
  ] as const;

  const updateStmt =
    input.resourceType === "page"
      ? tenantDb
          .prepare(
            `UPDATE pages
             SET slug = ?,
                 is_homepage = ?,
                 draft_sections_json = ?,
                 status = 'draft',
                 published_sections_json = NULL,
                 deleted_at = NULL,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND status = 'trashed' AND deleted_at IS NOT NULL
             ${atomicSlugOccupancyGuardSql}`,
          )
          .bind(
            targetSlug,
            nextIsHomepage ? 1 : 0,
            nextDraftRaw ?? "[]",
            nowMs,
            input.resourceId,
            input.expectedVersion,
            ...atomicSlugOccupancyBinds,
          )
      : input.resourceType === "post"
        ? tenantDb
            .prepare(
              `UPDATE posts
               SET slug = ?,
                   draft_body_json = ?,
                   status = 'draft',
                   published_body_json = NULL,
                   deleted_at = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND status = 'trashed' AND deleted_at IS NOT NULL
               ${atomicSlugOccupancyGuardSql}`,
            )
            .bind(
              targetSlug,
              nextDraftRaw ?? "{}",
              nowMs,
              input.resourceId,
              input.expectedVersion,
              ...atomicSlugOccupancyBinds,
            )
        : tenantDb
            .prepare(
              `UPDATE offerings
               SET slug = ?,
                   draft_snapshot_json = ?,
                   status = 'draft',
                   published_snapshot_json = NULL,
                   deleted_at = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND status = 'trashed' AND deleted_at IS NOT NULL
               ${atomicSlugOccupancyGuardSql}`,
            )
            .bind(
              targetSlug,
              nextDraftRaw,
              nowMs,
              input.resourceId,
              input.expectedVersion,
              ...atomicSlugOccupancyBinds,
            );

  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "editor";
  const auditSummary = slugChanged
    ? `Memulihkan ${input.resourceType} #${input.resourceId} sebagai draf dengan slug baru "${targetSlug}" (sebelumnya "${previousSlug}").`
    : `Memulihkan ${input.resourceType} "${targetSlug}" dari Sampah sebagai draf.`;
  const auditMeta = JSON.stringify({
    slug: targetSlug,
    previousSlug,
    slugChanged,
    homepageDemoted,
    nextVersion,
  });

  const auditStmt = tenantDb
    .prepare(
      `INSERT INTO tenant_activity_log (
         actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
       )
       SELECT ?, ?, 'content.restored', ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      actorUserId,
      actorRole,
      input.resourceType,
      String(input.resourceId),
      auditSummary,
      auditMeta,
      nowMs,
    );

  // Put auditStmt immediately after updateStmt so `changes() = 1` strictly observes the parent UPDATE!
  const batchStmts: D1PreparedStatement[] = [updateStmt, auditStmt, ...slugStatements];

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isSlugUniqueConstraintError(err)) {
      const latest = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new StaleRevisionError({
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const suggestedSlug = await suggestFreeRestoreSlug(tenantDb, {
        resourceType: input.resourceType,
        offeringType,
        namespace,
        resourceId: input.resourceId,
        baseSlug: targetSlug,
      });
      throw new TrashConflictError(
        `Slug "${targetSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggestedSlug}".`,
        {
          code: "CONFLICT",
          field: "slug",
          fieldCode: "SLUG_CONFLICT",
          suggestedSlug,
          conflictKind: "active_resource",
        },
      );
    }
    throw err;
  }

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    // Distinguish concurrent slug/redirect claim (409 SLUG_CONFLICT) from concurrent version edit (409 STALE_VERSION)
    const liveConflict = await isSlugOccupiedForRestore(tenantDb, {
      resourceType: input.resourceType,
      offeringType,
      namespace,
      resourceId: input.resourceId,
      slug: targetSlug,
    });
    if (liveConflict.conflict) {
      const suggestedSlug = await suggestFreeRestoreSlug(tenantDb, {
        resourceType: input.resourceType,
        offeringType,
        namespace,
        resourceId: input.resourceId,
        baseSlug: targetSlug,
      });
      throw new TrashConflictError(
        `Slug "${targetSlug}" baru saja diklaim oleh konten atau redirect lain. Saran alternatif: "${suggestedSlug}".`,
        {
          code: "CONFLICT",
          field: "slug",
          fieldCode: "SLUG_CONFLICT",
          suggestedSlug,
          conflictKind: liveConflict.kind,
        },
      );
    }
    const latest = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      actualVersion: latest ? Number(latest.version) : null,
    });
  }

  const mediaReferences = await inspectContentMediaReferences(tenantDb, input.resourceType, row);

  return {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    slug: targetSlug,
    previousSlug,
    slugChanged,
    title: String(row.title),
    offeringType,
    status: "draft",
    isHomepage: nextIsHomepage,
    homepageDemoted,
    version: nextVersion,
    restoredAt: new Date(nowMs).toISOString(),
    mediaReferences,
    auditRecorded: (batchResults[1]?.meta?.changes ?? 0) === 1,
  };
}

/**
 * Permanently purges a trashed page, blog post, or catalog offering:
 * - Refuses non-trashed items (`409 CONFLICT` `NOT_TRASHED`).
 * - Checks `expectedVersion` (`409 STALE_VERSION`) if provided (and always guards the DELETE
 *   on the row's current version so concurrent restores never lose data).
 * - Blocks with `TrashProtectedReferenceError` (`409 CONFLICT` `PROTECTED_REFERENCE`) if any
 *   protected homepage, policy setting, or navigation menu reference still points to this item.
 * - Atomically clears taxonomy joins (`post_taxonomies` / `offering_taxonomies`), `resource_slugs`,
 *   `content_revisions` (TASK-064 ready), deletes the content row, and records audit (`WHERE changes() = 1`).
 * - NEVER deletes `media_items` rows or R2 objects — shared media is preserved unconditionally.
 */
export async function purgeContentItem(
  tenantDb: D1Database,
  input: PurgeContentInput,
): Promise<PurgeContentResult> {
  assertValidResourceId(input.resourceId);
  if (input.expectedVersion !== undefined) {
    assertValidExpectedVersion(input.expectedVersion);
  }
  const nowMs = input.nowMs ?? Date.now();
  const cfg = RESOURCE_TABLE_CONFIG[input.resourceType];

  const row = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
  if (!row) {
    throw new TrashNotFoundError(input.resourceType, input.resourceId);
  }
  if (row.status !== "trashed" || row.deleted_at === null) {
    throw new TrashConflictError(
      `Konten #${input.resourceId} harus dipindahkan ke Sampah terlebih dahulu sebelum dihapus permanen.`,
      {
        code: "CONFLICT",
        field: "status",
        fieldCode: "NOT_TRASHED",
        conflictKind: "not_trashed",
      },
    );
  }

  const targetVersion = input.expectedVersion ?? Number(row.version);
  if (Number(row.version) !== targetVersion) {
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: targetVersion,
      actualVersion: Number(row.version),
    });
  }

  // Protected reference guard (homepage, policy settings, navigation menus)
  const protectedRefs = await findProtectedContentReferences(
    tenantDb,
    input.resourceType,
    input.resourceId,
    input.resourceType === "page" ? { isHomepageFlag: Number(row.is_homepage ?? 0) === 1 } : undefined,
  );
  if (protectedRefs.length > 0) {
    throw new TrashProtectedReferenceError(input.resourceType, input.resourceId, protectedRefs);
  }

  const offeringType: CatalogOfferingType | null =
    input.resourceType === "offering" ? (row.offering_type ?? "service") : null;
  const namespace = resolveContentSlugNamespace(input.resourceType, offeringType);
  const preservedMediaIds = collectReferencedMediaIdsFromRow(input.resourceType, row);

  const protectedGuardSubquery = buildAtomicProtectedReferenceGuard(
    input.resourceType,
    input.resourceId,
    "target_row",
  );
  const protectedGuardDelete = buildAtomicProtectedReferenceGuard(
    input.resourceType,
    input.resourceId,
    cfg.table,
  );

  const rowGuardExistsSql = `EXISTS (
    SELECT 1 FROM ${cfg.table} AS target_row
    WHERE target_row.id = ?
      AND target_row.version = ?
      AND target_row.status = 'trashed'
      AND target_row.deleted_at IS NOT NULL
      AND ${protectedGuardSubquery.sql}
  )`;
  const rowGuardBinds = [
    input.resourceId,
    targetVersion,
    ...protectedGuardSubquery.binds,
  ] as const;

  const batchStmts: D1PreparedStatement[] = [];

  // 1. Clear taxonomy join rows (atomically guarded on trashed row version + zero protected refs)
  let taxonomyStmtIdx: number | null = null;
  if (cfg.taxonomyJoinTable && cfg.taxonomyJoinFkCol) {
    taxonomyStmtIdx = batchStmts.length;
    batchStmts.push(
      tenantDb
        .prepare(
          `DELETE FROM ${cfg.taxonomyJoinTable}
           WHERE ${cfg.taxonomyJoinFkCol} = ? AND ${rowGuardExistsSql}`,
        )
        .bind(input.resourceId, ...rowGuardBinds),
    );
  }

  // 2. Clear resource_slugs rows (current + former slugs for this resource)
  const slugStmtIdx = batchStmts.length;
  batchStmts.push(
    tenantDb
      .prepare(
        `DELETE FROM resource_slugs
         WHERE namespace = ? AND resource_id = ? AND ${rowGuardExistsSql}`,
      )
      .bind(namespace, input.resourceId, ...rowGuardBinds),
  );

  // 3. Clear content_revisions rows (TASK-064 readiness + existing revisions)
  const revStmtIdx = batchStmts.length;
  batchStmts.push(
    tenantDb
      .prepare(
        `DELETE FROM content_revisions
         WHERE resource_type = ? AND resource_id = ? AND ${rowGuardExistsSql}`,
      )
      .bind(input.resourceType, input.resourceId, ...rowGuardBinds),
  );

  // 4. Permanently delete the trashed content row (atomically guarded on version + trashed + zero protected refs)
  const deleteStmtIdx = batchStmts.length;
  batchStmts.push(
    tenantDb
      .prepare(
        `DELETE FROM ${cfg.table}
         WHERE id = ? AND version = ? AND status = 'trashed' AND deleted_at IS NOT NULL
           AND ${protectedGuardDelete.sql}`,
      )
      .bind(input.resourceId, targetVersion, ...protectedGuardDelete.binds),
  );

  // 5. Conditional PII-free audit entry (`WHERE changes() = 1` right after DELETE)
  const source = input.source ?? "manual_purge";
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? (source === "scheduled_purge" ? "system" : "owner");
  const auditAction =
    source === "scheduled_purge" ? "content.purged_scheduled" : "content.purged_permanent";
  const auditSummary =
    source === "scheduled_purge"
      ? `Menghapus permanen ${input.resourceType} "${row.slug}" setelah masa retensi sampah 30 hari berakhir.`
      : `Menghapus permanen ${input.resourceType} "${row.slug}" dari Sampah.`;
  const auditMeta = JSON.stringify({
    slug: row.slug,
    source,
    preservedMediaCount: preservedMediaIds.length,
  });

  const auditStmtIdx = batchStmts.length;
  batchStmts.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        auditAction,
        input.resourceType,
        String(input.resourceId),
        auditSummary,
        auditMeta,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(batchStmts);
  const deletedRows = results[deleteStmtIdx]?.meta?.changes ?? 0;

  if (deletedRows !== 1) {
    const latest = await fetchRawContentRow(tenantDb, input.resourceType, input.resourceId);
    if (!latest) {
      throw new TrashNotFoundError(input.resourceType, input.resourceId);
    }
    // Check whether a concurrent protected reference (menu/site_settings/homepage) blocked the atomic DELETE
    const liveProtectedRefs = await findProtectedContentReferences(
      tenantDb,
      input.resourceType,
      input.resourceId,
      input.resourceType === "page" ? { isHomepageFlag: Number(latest.is_homepage ?? 0) === 1 } : undefined,
    );
    if (liveProtectedRefs.length > 0) {
      throw new TrashProtectedReferenceError(input.resourceType, input.resourceId, liveProtectedRefs);
    }
    throw new StaleRevisionError({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: targetVersion,
      actualVersion: Number(latest.version),
    });
  }

  return {
    purged: true,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    slug: String(row.slug),
    title: String(row.title),
    offeringType,
    clearedCounts: {
      taxonomies: taxonomyStmtIdx !== null ? (results[taxonomyStmtIdx]?.meta?.changes ?? 0) : 0,
      resourceSlugs: results[slugStmtIdx]?.meta?.changes ?? 0,
      revisions: results[revStmtIdx]?.meta?.changes ?? 0,
    },
    preservedMediaIds,
    purgedAt: new Date(nowMs).toISOString(),
    auditRecorded: (results[auditStmtIdx]?.meta?.changes ?? 0) === 1,
  };
}

/**
 * Lists trashed items for one content type (`page` | `post` | `offering`) enriched with
 * 30-day retention countdown, protected references, and media reference health.
 */
export async function listTrashedContentByType(
  tenantDb: D1Database,
  resourceType: ContentResourceType,
  options: {
    readonly offeringType?: CatalogOfferingType;
    readonly limit?: number;
    readonly nowMs?: number;
    readonly retentionMs?: number;
  } = {},
): Promise<readonly TrashedContentSummary[]> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? TRASH_RETENTION_MS;
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const cfg = RESOURCE_TABLE_CONFIG[resourceType];

  const whereParts = ["status = 'trashed'", "deleted_at IS NOT NULL"];
  const binds: unknown[] = [];

  if (resourceType === "offering" && options.offeringType) {
    whereParts.push("offering_type = ?");
    binds.push(options.offeringType);
  }
  binds.push(limit);

  const res = await tenantDb
    .prepare(
      `SELECT * FROM ${cfg.table}
       WHERE ${whereParts.join(" AND ")}
       ORDER BY deleted_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<RawContentRow>();

  const summaries: TrashedContentSummary[] = [];
  for (const row of res.results) {
    const offeringType: CatalogOfferingType | null =
      resourceType === "offering" ? (row.offering_type ?? "service") : null;
    const isHomepage = resourceType === "page" && Number(row.is_homepage ?? 0) === 1;
    const deletedAtMs = Number(row.deleted_at ?? nowMs);
    const retention = computeTrashRetentionMeta(deletedAtMs, nowMs, retentionMs);

    const [protectedReferences, mediaReferences]: [
      readonly ProtectedContentReference[],
      ContentMediaReferenceReport,
    ] = await Promise.all([
      findProtectedContentReferences(
        tenantDb,
        resourceType,
        Number(row.id),
        resourceType === "page" ? { isHomepageFlag: isHomepage } : undefined,
      ),
      inspectContentMediaReferences(tenantDb, resourceType, row),
    ]);

    summaries.push({
      resourceType,
      resourceId: Number(row.id),
      offeringType,
      slug: String(row.slug),
      publicPath: resolveContentPublicPath(resourceType, String(row.slug), offeringType, isHomepage),
      title: String(row.title),
      isHomepage,
      version: Number(row.version),
      deletedAt: retention.deletedAt,
      purgeEligibleAt: retention.purgeEligibleAt,
      daysRemaining: retention.daysRemaining,
      isExpired: retention.isExpired,
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      protectedReferences,
      mediaReferences,
    });
  }

  return summaries;
}

/**
 * Executes the 30-day scheduled expiry purge sweep across `pages`, `posts`, and `offerings`
 * inside a single tenant's `TenantStore`.
 *
 * - Uses the exact same `purgeContentItem` protected-reference checks as manual purge.
 * - When an expired item is blocked by protected references, records a structured
 *   `ProtectedReferencePurgeFailure`, logs an operator-visible audit row in `tenant_activity_log`,
 *   and continues sweeping remaining expired items without failing the batch.
 * - Always preserves shared media (`media_items` & R2 untouched).
 */
export async function sweepExpiredTrashedContent(
  tenantDb: D1Database,
  input: TenantContentPurgeSweepInput,
): Promise<TenantContentPurgeSweepResult> {
  if (!input.tenantId.trim()) {
    throw new Error("tenantId is required for sweepExpiredTrashedContent");
  }
  const nowMs = input.nowMs ?? Date.now();
  const retentionMs = input.retentionMs ?? TRASH_RETENTION_MS;
  const cutoffMs = nowMs - retentionMs;

  const resourceTypes: readonly ContentResourceType[] = ["page", "post", "offering"];
  const purgedItems: PurgeContentResult[] = [];
  const blockedItems: ProtectedReferencePurgeFailure[] = [];
  let scannedCount = 0;
  let skippedConcurrentCount = 0;

  for (const resourceType of resourceTypes) {
    const cfg = RESOURCE_TABLE_CONFIG[resourceType];
    const expiredRes = await tenantDb
      .prepare(
        `SELECT id, slug, version, deleted_at
         FROM ${cfg.table}
         WHERE status = 'trashed' AND deleted_at IS NOT NULL AND deleted_at <= ?
         ORDER BY deleted_at ASC, id ASC`,
      )
      .bind(cutoffMs)
      .all<{
        readonly id: number;
        readonly slug: string;
        readonly version: number;
        readonly deleted_at: number;
      }>();

    for (const candidate of expiredRes.results) {
      scannedCount += 1;
      try {
        const result = await purgeContentItem(tenantDb, {
          resourceType,
          resourceId: Number(candidate.id),
          expectedVersion: Number(candidate.version),
          source: "scheduled_purge",
          actorUserId: null,
          actorRole: "system",
          nowMs,
        });
        purgedItems.push(result);
      } catch (err) {
        if (err instanceof TrashProtectedReferenceError) {
          const failure: ProtectedReferencePurgeFailure = {
            tenantId: input.tenantId,
            resourceType,
            resourceId: Number(candidate.id),
            slug: String(candidate.slug),
            deletedAt: new Date(Number(candidate.deleted_at)).toISOString(),
            errorCode: "PROTECTED_REFERENCE",
            protectedReferences: err.references,
          };
          blockedItems.push(failure);

          // Record operator-visible PII-free audit failure at most once per (resource, deleted_at, UTC day)
          // so repeated cron sweeps never spam `tenant_activity_log`.
          const utcDayStartMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
          await tenantDb
            .prepare(
              `INSERT INTO tenant_activity_log (
                 actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
               )
               SELECT NULL, 'system', 'content.purge_blocked_protected_ref', ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM tenant_activity_log
                 WHERE action = 'content.purge_blocked_protected_ref'
                   AND resource_type = ?
                   AND resource_id = ?
                   AND created_at >= ?
                   AND json_extract(metadata_json, '$.deletedAtMs') = ?
               )`,
            )
            .bind(
              resourceType,
              String(candidate.id),
              `Penghapusan otomatis 30 hari diblokir untuk ${resourceType} "${candidate.slug}" karena referensi terlindungi masih aktif.`,
              JSON.stringify({
                errorCode: "PROTECTED_REFERENCE",
                slug: candidate.slug,
                deletedAtMs: Number(candidate.deleted_at),
                references: err.references.map((r) => ({
                  kind: r.kind,
                  sourceTable: r.sourceTable,
                  location: r.location ?? null,
                  field: r.field ?? null,
                })),
              }),
              nowMs,
              resourceType,
              String(candidate.id),
              utcDayStartMs,
              Number(candidate.deleted_at),
            )
            .run();
        } else if (err instanceof StaleRevisionError || err instanceof TrashNotFoundError) {
          // Concurrent restore or already purged — safe skip
          skippedConcurrentCount += 1;
        } else {
          throw err;
        }
      }
    }
  }

  return {
    tenantId: input.tenantId,
    cutoffMs,
    scannedCount,
    purgedCount: purgedItems.length,
    skippedConcurrentCount,
    blockedCount: blockedItems.length,
    purgedItems,
    blockedItems,
  };
}
