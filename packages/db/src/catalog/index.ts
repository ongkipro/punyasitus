import {
  buildUniqueAutoSlug,
  CATEGORY_SLUG_NAMESPACE,
  CatalogValidationError,
  generateSlugFromTitle,
  getCategoryPublicPath,
  getOfferingPublicPath,
  getOfferingSlugNamespace,
  MAX_CATEGORY_DEPTH,
  projectToPublicOfferingAttributes,
  validateCategoryInput,
  validateOfferingInput,
  type CatalogCtaMode,
  type CatalogDescription,
  type CatalogOfferingAttributes,
  type CatalogOfferingType,
  type CatalogPriceMode,
  type CatalogVehicleUnitStatus,
  type OfferingSlugNamespace,
  type ValidatedOfferingDraftInput,
} from "@punyasitus/core/catalog/index";
import {
  PublicationAtomicError,
  type OfferingSnapshot,
  type ResourceLifecycleStatus,
} from "@punyasitus/core/content/index";
import {
  bumpTenantCacheVersion,
  publishResourceAtomically,
  unpublishResourceAtomically,
} from "../publication/index.ts";

/**
 * Per-Tenant Catalog & Categories Repository (`packages/db/src/catalog/index.ts`; TASK-009).
 *
 * Operates exclusively against a tenant's physically isolated `TenantStore`
 * (`D1Database`-compatible adapter) tables:
 * - `offerings`, `taxonomies` (`taxonomy_type = 'offering_category'`),
 *   `offering_taxonomies`, `sequences`, `resource_slugs`, `media_items`, `business_profile`.
 * - Reuses `publishResourceAtomically` / `unpublishResourceAtomically` from
 *   `@punyasitus/db/publication/index` for atomic snapshot publish + `PLATFORM_DB.tenants.cache_version` bump.
 */

const OFFERING_SEQUENCE_KIND = "offering" as const;
const CATEGORY_SEQUENCE_KIND = "category" as const;

// ---------------------------------------------------------------------------
// Repository Error Types
// ---------------------------------------------------------------------------

export class CatalogNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly resourceType: "offering" | "category";
  readonly resourceId: number;

  constructor(resourceType: "offering" | "category", resourceId: number) {
    super(
      resourceType === "offering"
        ? `Penawaran #${resourceId} tidak ditemukan.`
        : `Kategori katalog #${resourceId} tidak ditemukan.`,
    );
    this.name = "CatalogNotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

export class CatalogConflictError extends Error {
  readonly status = 409 as const;
  readonly code: "STALE_VERSION" | "CONFLICT";
  readonly field: string;
  readonly fieldCode: string;
  readonly expectedVersion?: number;
  readonly currentVersion?: number;

  constructor(
    message: string,
    options: {
      readonly code?: "STALE_VERSION" | "CONFLICT";
      readonly field?: string;
      readonly fieldCode?: string;
      readonly expectedVersion?: number;
      readonly currentVersion?: number;
    } = {},
  ) {
    super(message);
    this.name = "CatalogConflictError";
    this.code = options.code ?? "CONFLICT";
    this.field = options.field ?? "version";
    this.fieldCode = options.fieldCode ?? this.code;
    this.expectedVersion = options.expectedVersion;
    this.currentVersion = options.currentVersion;
  }
}

// ---------------------------------------------------------------------------
// Stored DTO Shapes
// ---------------------------------------------------------------------------

export interface StoredCatalogCategory {
  readonly id: number;
  readonly kind: "offering_category";
  readonly offeringType: CatalogOfferingType | null;
  readonly parentId: number | null;
  readonly depth: number;
  readonly slug: string;
  readonly publicPath: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly publishedCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredCatalogOffering {
  readonly id: number;
  readonly offeringType: CatalogOfferingType;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly summary: string | null;
  readonly description: CatalogDescription | null;
  readonly coverMediaId: number | null;
  readonly galleryMediaIds: readonly number[];
  readonly videoMediaId: number | null;
  readonly youtubeVideoId: string | null;
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
  readonly originalAmount: number | null;
  readonly badge: string | null;
  readonly badges: readonly string[];
  readonly ctaMode: CatalogCtaMode;
  readonly ctaKind: CatalogCtaMode;
  readonly ctaLabel: string | null;
  readonly externalUrl: string | null;
  readonly whatsappOverride: string | null;
  readonly whatsappTemplate: string | null;
  readonly unitStatus: CatalogVehicleUnitStatus | null;
  readonly categoryIds: readonly number[];
  readonly attributesVersion: number;
  readonly attributes: CatalogOfferingAttributes;
  readonly seo: Readonly<Record<string, unknown>> | null;
  readonly status: ResourceLifecycleStatus;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly deletedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogPageMeta {
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface ListCatalogOfferingsOptions {
  readonly offeringType?: CatalogOfferingType;
  readonly status?: ResourceLifecycleStatus;
  readonly categoryId?: number;
  readonly includeTrashed?: boolean;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface ListCatalogCategoriesOptions {
  readonly offeringType?: CatalogOfferingType;
  readonly cursor?: number;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Raw SQLite Row Shapes
// ---------------------------------------------------------------------------

interface RawCategoryRow {
  readonly id: number;
  readonly taxonomy_type: string;
  readonly offering_type: CatalogOfferingType | null;
  readonly parent_id: number | null;
  readonly depth: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly sort_order: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly published_count?: number;
}

interface RawOfferingRow {
  readonly id: number;
  readonly offering_type: CatalogOfferingType;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly cover_media_id: number | null;
  readonly gallery_media_ids_json: string;
  readonly video_media_id: number | null;
  readonly youtube_video_id: string | null;
  readonly price_mode: CatalogPriceMode;
  readonly price: number | null;
  readonly price_max: number | null;
  readonly negotiable: number;
  readonly original_amount: number | null;
  readonly badge: string | null;
  readonly cta_mode: CatalogCtaMode;
  readonly external_url: string | null;
  readonly unit_status: CatalogVehicleUnitStatus | null;
  readonly attributes_version: number;
  readonly attributes_json: string;
  readonly draft_snapshot_json: string | null;
  readonly published_snapshot_json: string | null;
  readonly seo_json: string | null;
  readonly status: ResourceLifecycleStatus;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface StoredDraftExtras {
  readonly badges?: readonly string[];
  readonly ctaLabel?: string | null;
  readonly whatsappOverride?: string | null;
  readonly whatsappTemplate?: string | null;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeLimit(raw?: number): number {
  if (raw === undefined || !Number.isInteger(raw)) return 20;
  return Math.max(1, Math.min(100, raw));
}

function assertValidExpectedVersion(version: number, field = "expectedVersion"): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new CatalogValidationError(`${field} harus berupa integer positif.`, [
      { field, code: "INVALID_VERSION", message: `${field} must be a positive integer.` },
    ]);
  }
}

function createWriteToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function isSlugUniqueConstraintError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    /UNIQUE constraint failed:\s*(?:resource_slugs\.|offerings\.|taxonomies\.)/i.test(text) ||
    /SQLITE_CONSTRAINT_UNIQUE/i.test(text)
  );
}

function mapSlugConstraintError(slug: string): CatalogConflictError {
  return new CatalogConflictError(
    `Slug "${slug}" baru saja digunakan oleh permintaan lain secara bersamaan.`,
    {
      code: "CONFLICT",
      field: "slug",
      fieldCode: "SLUG_CONFLICT",
    },
  );
}

/**
 * Atomically allocates the next per-tenant sequential ID in `sequences` (PLAN §7.1).
 * Deleted numbers are never reused.
 */
async function allocateTenantSequence(
  tenantDb: D1Database,
  kind: typeof OFFERING_SEQUENCE_KIND | typeof CATEGORY_SEQUENCE_KIND,
): Promise<number> {
  const row = await tenantDb
    .prepare(
      `INSERT INTO sequences (kind, next) VALUES (?, 1)
       ON CONFLICT (kind) DO UPDATE SET next = next + 1
       RETURNING next`,
    )
    .bind(kind)
    .first<{ readonly next: number }>();

  if (!row || typeof row.next !== "number" || row.next < 1) {
    throw new Error(`Failed to allocate sequential ID for "${kind}".`);
  }
  return Number(row.next);
}

/**
 * Reads the tenant's configured WhatsApp E.164 number from `business_profile` (id = 1).
 */
export async function resolveTenantWhatsAppNumber(
  tenantDb: D1Database,
): Promise<string | null> {
  const row = await tenantDb
    .prepare(
      `SELECT whatsapp_e164, draft_json, published_json
       FROM business_profile
       WHERE id = 1
       LIMIT 1`,
    )
    .first<{
      readonly whatsapp_e164: string | null;
      readonly draft_json: string | null;
      readonly published_json: string | null;
    }>();

  if (!row) return null;
  if (row.whatsapp_e164 && row.whatsapp_e164.trim()) {
    return row.whatsapp_e164.trim();
  }

  for (const rawJson of [row.draft_json, row.published_json]) {
    const parsed = safeJsonParse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const candidate =
      (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>).whatsappE164
        : undefined) ?? obj.whatsappE164;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Verifies every referenced media ID (`coverMediaId`, `videoMediaId`, `galleryMediaIds`,
 * `seo.ogImageMediaId`) exists inside THIS tenant's `media_items` table and is not
 * failed/quarantined (and is `ready` when publishing). Rejects missing/foreign IDs with `422 MEDIA_NOT_FOUND`.
 */
async function verifyTenantMediaReferences(
  tenantDb: D1Database,
  refs: {
    readonly coverMediaId: number | null;
    readonly videoMediaId: number | null;
    readonly galleryMediaIds: readonly number[];
    readonly ogImageMediaId: number | null;
  },
  options: { readonly requireReady?: boolean } = {},
): Promise<void> {
  const idToFields = new Map<number, { readonly fields: string[]; readonly expectedKind: "image" | "video" }>();

  const register = (id: number | null, field: string, expectedKind: "image" | "video") => {
    if (id === null) return;
    const existing = idToFields.get(id);
    if (existing) {
      existing.fields.push(field);
    } else {
      idToFields.set(id, { fields: [field], expectedKind });
    }
  };

  register(refs.coverMediaId, "coverMediaId", "image");
  register(refs.ogImageMediaId, "seo.ogImageMediaId", "image");
  refs.galleryMediaIds.forEach((id, idx) => register(id, `galleryMediaIds[${idx}]`, "image"));
  register(refs.videoMediaId, "videoMediaId", "video");

  if (idToFields.size === 0) return;

  const ids = [...idToFields.keys()];
  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT id, kind, status FROM media_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ readonly id: number; readonly kind: string; readonly status: string }>();

  const found = new Map<number, { readonly kind: string; readonly status: string }>();
  for (const row of res.results) {
    found.set(Number(row.id), { kind: String(row.kind), status: String(row.status) });
  }

  for (const [id, meta] of idToFields.entries()) {
    const row = found.get(id);
    const primaryField = meta.fields[0] ?? "coverMediaId";
    const isUsableDraftStatus = row !== undefined && (row.status === "ready" || row.status === "processing");
    if (!row || !isUsableDraftStatus) {
      throw new CatalogValidationError(
        `Media #${id} tidak ditemukan di pustaka media tenant ini.`,
        [
          {
            field: primaryField,
            code: "MEDIA_NOT_FOUND",
            message: `Media #${id} does not exist or is unavailable in this tenant.`,
          },
        ],
      );
    }
    if (options.requireReady && row.status !== "ready") {
      throw new CatalogValidationError(
        `Media #${id} belum siap dipublikasikan (status: ${row.status}).`,
        [
          {
            field: primaryField,
            code: "MEDIA_NOT_FOUND",
            message: `Media #${id} must be in "ready" status before publishing.`,
          },
        ],
      );
    }
    if (row.kind !== meta.expectedKind) {
      throw new CatalogValidationError(
        `Media #${id} bertipe "${row.kind}", diharapkan "${meta.expectedKind}".`,
        [
          {
            field: primaryField,
            code: "INVALID_MEDIA",
            message: `Media #${id} has kind "${row.kind}" but "${meta.expectedKind}" is required.`,
          },
        ],
      );
    }
  }
}

/**
 * Verifies every referenced `categoryId` exists inside THIS tenant's `taxonomies`
 * with `taxonomy_type = 'offering_category'` and compatible `offering_type`.
 * Rejects missing/foreign IDs with `422 CATEGORY_NOT_FOUND`.
 */
async function verifyTenantCategoryReferences(
  tenantDb: D1Database,
  offeringType: CatalogOfferingType,
  categoryIds: readonly number[],
): Promise<void> {
  if (categoryIds.length === 0) return;

  const placeholders = categoryIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT id, offering_type
       FROM taxonomies
       WHERE id IN (${placeholders}) AND taxonomy_type = 'offering_category'`,
    )
    .bind(...categoryIds)
    .all<{ readonly id: number; readonly offering_type: CatalogOfferingType | null }>();

  const found = new Map<number, CatalogOfferingType | null>();
  for (const row of res.results) {
    found.set(Number(row.id), row.offering_type ?? null);
  }

  for (let i = 0; i < categoryIds.length; i += 1) {
    const id = categoryIds[i]!;
    if (!found.has(id)) {
      throw new CatalogValidationError(
        `Kategori katalog #${id} tidak ditemukan di tenant ini.`,
        [
          {
            field: `categoryIds[${i}]`,
            code: "CATEGORY_NOT_FOUND",
            message: `Offering category #${id} does not exist in this tenant.`,
          },
        ],
      );
    }
    const scopedType = found.get(id);
    if (scopedType !== null && scopedType !== offeringType) {
      throw new CatalogValidationError(
        `Kategori #${id} hanya untuk tipe "${scopedType}", tidak cocok dengan "${offeringType}".`,
        [
          {
            field: `categoryIds[${i}]`,
            code: "CATEGORY_TYPE_MISMATCH",
            message: `Category #${id} is scoped to "${scopedType}" and cannot be assigned to "${offeringType}".`,
          },
        ],
      );
    }
  }
}

/**
 * Loads all taken slugs in a namespace across both `resource_slugs` (including former slugs!)
 * and the primary table (`offerings` or `taxonomies`), optionally excluding the current resource's
 * own rows when updating.
 */
async function collectTakenSlugs(
  tenantDb: D1Database,
  namespace: OfferingSlugNamespace | typeof CATEGORY_SLUG_NAMESPACE,
  options: {
    readonly offeringType?: CatalogOfferingType;
    readonly excludeResourceId?: number;
  } = {},
): Promise<Set<string>> {
  const taken = new Set<string>();

  const slugRows = await tenantDb
    .prepare(
      `SELECT slug, resource_id FROM resource_slugs WHERE namespace = ?`,
    )
    .bind(namespace)
    .all<{ readonly slug: string; readonly resource_id: number }>();

  for (const row of slugRows.results) {
    if (
      options.excludeResourceId !== undefined &&
      Number(row.resource_id) === options.excludeResourceId
    ) {
      continue;
    }
    taken.add(String(row.slug));
  }

  if (namespace === CATEGORY_SLUG_NAMESPACE) {
    const catRows = await tenantDb
      .prepare(
        `SELECT id, slug FROM taxonomies WHERE taxonomy_type = 'offering_category'`,
      )
      .all<{ readonly id: number; readonly slug: string }>();
    for (const row of catRows.results) {
      if (
        options.excludeResourceId !== undefined &&
        Number(row.id) === options.excludeResourceId
      ) {
        continue;
      }
      taken.add(String(row.slug));
    }
  } else if (options.offeringType) {
    const offRows = await tenantDb
      .prepare(`SELECT id, slug FROM offerings WHERE offering_type = ?`)
      .bind(options.offeringType)
      .all<{ readonly id: number; readonly slug: string }>();
    for (const row of offRows.results) {
      if (
        options.excludeResourceId !== undefined &&
        Number(row.id) === options.excludeResourceId
      ) {
        continue;
      }
      taken.add(String(row.slug));
    }
  }

  return taken;
}

async function resolveSlugForCreate(
  tenantDb: D1Database,
  params: {
    readonly namespace: OfferingSlugNamespace | typeof CATEGORY_SLUG_NAMESPACE;
    readonly offeringType?: CatalogOfferingType;
    readonly title: string;
    readonly manualSlug: string | null;
    readonly sequenceId: number;
  },
): Promise<string> {
  const taken = await collectTakenSlugs(tenantDb, params.namespace, {
    offeringType: params.offeringType,
  });

  if (params.manualSlug !== null) {
    if (taken.has(params.manualSlug)) {
      const suggestedSlug = buildUniqueAutoSlug(params.manualSlug, (c) => taken.has(c));
      throw new CatalogValidationError(
        `Slug "${params.manualSlug}" sudah digunakan. Alternatif yang tersedia: "${suggestedSlug}".`,
        [
          {
            field: "slug",
            code: "SLUG_CONFLICT",
            message: `Slug "${params.manualSlug}" is already in use (suggested: "${suggestedSlug}").`,
          },
        ],
        { suggestedSlug },
      );
    }
    return params.manualSlug;
  }

  const baseSlug = generateSlugFromTitle(params.title, params.namespace, params.sequenceId);
  return buildUniqueAutoSlug(baseSlug, (c) => taken.has(c));
}

async function resolveSlugForUpdate(
  tenantDb: D1Database,
  params: {
    readonly namespace: OfferingSlugNamespace | typeof CATEGORY_SLUG_NAMESPACE;
    readonly offeringType?: CatalogOfferingType;
    readonly resourceId: number;
    readonly currentSlug: string;
    readonly nextManualSlug: string | null;
  },
): Promise<{ readonly slug: string; readonly changed: boolean }> {
  if (params.nextManualSlug === null || params.nextManualSlug === params.currentSlug) {
    return { slug: params.currentSlug, changed: false };
  }

  const taken = await collectTakenSlugs(tenantDb, params.namespace, {
    offeringType: params.offeringType,
    excludeResourceId: params.resourceId,
  });

  if (taken.has(params.nextManualSlug)) {
    const suggestedSlug = buildUniqueAutoSlug(params.nextManualSlug, (c) => taken.has(c));
    throw new CatalogValidationError(
      `Slug "${params.nextManualSlug}" sudah digunakan. Alternatif yang tersedia: "${suggestedSlug}".`,
      [
        {
          field: "slug",
          code: "SLUG_CONFLICT",
          message: `Slug "${params.nextManualSlug}" is already in use (suggested: "${suggestedSlug}").`,
        },
      ],
      { suggestedSlug },
    );
  }

  return { slug: params.nextManualSlug, changed: true };
}

interface BatchMutationGuard {
  readonly existsSql: string;
  readonly binds: readonly unknown[];
}

function buildResourceSlugSyncStatements(
  tenantDb: D1Database,
  params: {
    readonly namespace: OfferingSlugNamespace | typeof CATEGORY_SLUG_NAMESPACE;
    readonly resourceId: number;
    readonly oldSlug: string;
    readonly newSlug: string;
    readonly keepFormerSlug: boolean;
    readonly nowMs: number;
    readonly guard: BatchMutationGuard;
  },
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const { existsSql, binds: guardBinds } = params.guard;
  if (params.keepFormerSlug) {
    // Keep old slug & any existing former slugs pointing directly to newSlug (single-hop 308),
    // gated so a losing concurrent batch leaves ZERO side effects.
    stmts.push(
      tenantDb
        .prepare(
          `UPDATE resource_slugs
           SET is_current = 0, redirect_target_slug = ?, updated_at = ?
           WHERE namespace = ? AND resource_id = ? AND slug != ?
             AND EXISTS (${existsSql})`,
        )
        .bind(
          params.newSlug,
          params.nowMs,
          params.namespace,
          params.resourceId,
          params.newSlug,
          ...guardBinds,
        ),
    );
    stmts.push(
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           SELECT ?, ?, ?, 1, NULL, ?
           WHERE EXISTS (${existsSql})
           ON CONFLICT (namespace, slug) DO UPDATE
           SET resource_id = excluded.resource_id,
               is_current = 1,
               redirect_target_slug = NULL,
               updated_at = excluded.updated_at`,
        )
        .bind(params.namespace, params.newSlug, params.resourceId, params.nowMs, ...guardBinds),
    );
  } else {
    // Never published: freely replace uncommitted slug without leaving dead redirect rows,
    // gated so a losing concurrent batch leaves ZERO side effects.
    stmts.push(
      tenantDb
        .prepare(
          `DELETE FROM resource_slugs
           WHERE namespace = ? AND resource_id = ? AND slug = ?
             AND EXISTS (${existsSql})`,
        )
        .bind(params.namespace, params.resourceId, params.oldSlug, ...guardBinds),
    );
    stmts.push(
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           SELECT ?, ?, ?, 1, NULL, ?
           WHERE EXISTS (${existsSql})
           ON CONFLICT (namespace, slug) DO UPDATE
           SET is_current = 1, redirect_target_slug = NULL, updated_at = excluded.updated_at`,
        )
        .bind(params.namespace, params.newSlug, params.resourceId, params.nowMs, ...guardBinds),
    );
  }
  return stmts;
}

function serializeDescriptionForStorage(desc: CatalogDescription | null): string | null {
  if (desc === null) return null;
  return typeof desc === "string" ? desc : JSON.stringify(desc);
}

function parseDescriptionFromStorage(raw: string | null): CatalogDescription | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.schemaVersion === 1 && Array.isArray(obj.blocks)) {
        return obj as CatalogDescription;
      }
    }
  }
  return raw;
}

function parseDraftExtras(rawDraftSnapshot: string | null): StoredDraftExtras {
  const parsed = safeJsonParse(rawDraftSnapshot);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const meta =
    obj._draftMetadata && typeof obj._draftMetadata === "object" && !Array.isArray(obj._draftMetadata)
      ? (obj._draftMetadata as Record<string, unknown>)
      : obj;
  return {
    badges: Array.isArray(meta.badges) ? (meta.badges as string[]) : undefined,
    ctaLabel: typeof meta.ctaLabel === "string" ? meta.ctaLabel : null,
    whatsappOverride: typeof meta.whatsappOverride === "string" ? meta.whatsappOverride : null,
    whatsappTemplate: typeof meta.whatsappTemplate === "string" ? meta.whatsappTemplate : null,
  };
}

function buildOfferingSnapshotForPublication(
  slug: string,
  validated: ValidatedOfferingDraftInput,
): OfferingSnapshot {
  return {
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
    ctaMode: validated.cta.ctaMode,
    externalUrl: validated.cta.externalUrl,
    unitStatus: validated.unitStatus,
    attributesVersion: validated.attributesVersion,
    attributes: projectToPublicOfferingAttributes(validated.offeringType, validated.attributes),
    seo: validated.seo,
  };
}

function buildDraftSnapshotStorageJson(
  slug: string,
  validated: ValidatedOfferingDraftInput,
): string {
  const data = buildOfferingSnapshotForPublication(slug, validated);
  return JSON.stringify({
    snapshotVersion: 1,
    resourceType: "offering",
    data,
    _draftMetadata: {
      badges: [...validated.badges],
      ctaLabel: validated.cta.ctaLabel,
      whatsappOverride: validated.cta.whatsappOverride,
      whatsappTemplate: validated.cta.whatsappTemplate,
      writeToken: createWriteToken(),
    },
  });
}

function mapCategoryRow(row: RawCategoryRow): StoredCatalogCategory {
  const offeringType = row.offering_type ?? null;
  const slug = String(row.slug);
  return {
    id: Number(row.id),
    kind: "offering_category",
    offeringType,
    parentId: row.parent_id !== null ? Number(row.parent_id) : null,
    depth: Math.max(1, Number(row.depth)),
    slug,
    publicPath: getCategoryPublicPath(offeringType, slug),
    name: String(row.name),
    description: row.description ?? null,
    sortOrder: Number(row.sort_order),
    publishedCount: Number(row.published_count ?? 0),
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function mapOfferingRow(
  row: RawOfferingRow,
  categoryIds: readonly number[],
): StoredCatalogOffering {
  const galleryParsed = safeJsonParse(row.gallery_media_ids_json);
  const galleryMediaIds = Array.isArray(galleryParsed)
    ? galleryParsed.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];

  const attrsParsed = safeJsonParse(row.attributes_json);
  const attributes =
    attrsParsed && typeof attrsParsed === "object" && !Array.isArray(attrsParsed)
      ? (attrsParsed as CatalogOfferingAttributes)
      : {};

  const seoParsed = safeJsonParse(row.seo_json);
  const seo =
    seoParsed && typeof seoParsed === "object" && !Array.isArray(seoParsed)
      ? (seoParsed as Record<string, unknown>)
      : null;

  const extras = parseDraftExtras(row.draft_snapshot_json);
  const primaryBadge = row.badge ?? null;
  const badges =
    extras.badges && extras.badges.length > 0
      ? [...extras.badges]
      : primaryBadge
        ? [primaryBadge]
        : [];

  const offeringType = row.offering_type;
  const slug = String(row.slug);
  const ctaMode = row.cta_mode;

  return {
    id: Number(row.id),
    offeringType,
    slug,
    publicPath: getOfferingPublicPath(offeringType, slug),
    title: String(row.title),
    summary: row.summary ?? null,
    description: parseDescriptionFromStorage(row.description),
    coverMediaId: row.cover_media_id !== null ? Number(row.cover_media_id) : null,
    galleryMediaIds,
    videoMediaId: row.video_media_id !== null ? Number(row.video_media_id) : null,
    youtubeVideoId: row.youtube_video_id ?? null,
    priceMode: row.price_mode,
    price: row.price !== null ? Number(row.price) : null,
    priceMax: row.price_max !== null ? Number(row.price_max) : null,
    negotiable: Number(row.negotiable) === 1,
    originalAmount: row.original_amount !== null ? Number(row.original_amount) : null,
    badge: primaryBadge,
    badges,
    ctaMode,
    ctaKind: ctaMode,
    ctaLabel: extras.ctaLabel ?? null,
    externalUrl: row.external_url ?? null,
    whatsappOverride: extras.whatsappOverride ?? null,
    whatsappTemplate: extras.whatsappTemplate ?? null,
    unitStatus: row.unit_status ?? null,
    categoryIds: [...categoryIds],
    attributesVersion: Number(row.attributes_version),
    attributes,
    seo,
    status: row.status,
    publishedAt: row.published_at !== null ? new Date(Number(row.published_at)).toISOString() : null,
    contentModifiedAt:
      row.content_modified_at !== null
        ? new Date(Number(row.content_modified_at)).toISOString()
        : null,
    deletedAt: row.deleted_at !== null ? new Date(Number(row.deleted_at)).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

async function fetchCategoryIdsForOfferings(
  tenantDb: D1Database,
  offeringIds: readonly number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (offeringIds.length === 0) return result;
  const placeholders = offeringIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT offering_id, taxonomy_id
       FROM offering_taxonomies
       WHERE offering_id IN (${placeholders})
       ORDER BY taxonomy_id ASC`,
    )
    .bind(...offeringIds)
    .all<{ readonly offering_id: number; readonly taxonomy_id: number }>();

  for (const row of res.results) {
    const oId = Number(row.offering_id);
    const list = result.get(oId) ?? [];
    list.push(Number(row.taxonomy_id));
    result.set(oId, list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Categories CRUD (`taxonomies` where `taxonomy_type = 'offering_category'`)
// ---------------------------------------------------------------------------

export async function listCatalogCategories(
  tenantDb: D1Database,
  options: ListCatalogCategoriesOptions = {},
): Promise<{ readonly items: StoredCatalogCategory[]; readonly page: CatalogPageMeta }> {
  const limit = normalizeLimit(options.limit);
  const conditions = ["t.taxonomy_type = 'offering_category'"];
  const binds: unknown[] = [];

  if (options.offeringType) {
    conditions.push("(t.offering_type = ? OR t.offering_type IS NULL)");
    binds.push(options.offeringType);
  }
  if (options.cursor !== undefined && Number.isInteger(options.cursor) && options.cursor > 0) {
    conditions.push("t.id > ?");
    binds.push(options.cursor);
  }

  const sql = `
    SELECT t.*,
      (
        SELECT COUNT(*)
        FROM offering_taxonomies ot
        INNER JOIN offerings o ON o.id = ot.offering_id
        WHERE ot.taxonomy_id = t.id
          AND o.status = 'published'
          AND o.deleted_at IS NULL
      ) AS published_count
    FROM taxonomies t
    WHERE ${conditions.join(" AND ")}
    ORDER BY t.sort_order ASC, t.id ASC
    LIMIT ?
  `;

  const res = await tenantDb
    .prepare(sql)
    .bind(...binds, limit + 1)
    .all<RawCategoryRow>();

  const hasMore = res.results.length > limit;
  const rows = hasMore ? res.results.slice(0, limit) : res.results;
  const items = rows.map(mapCategoryRow);
  const lastItem = items[items.length - 1];

  return {
    items,
    page: {
      nextCursor: hasMore && lastItem ? String(lastItem.id) : null,
      limit,
      hasMore,
    },
  };
}

export async function getCatalogCategoryById(
  tenantDb: D1Database,
  categoryId: number,
): Promise<StoredCatalogCategory | null> {
  const row = await tenantDb
    .prepare(
      `SELECT t.*,
        (
          SELECT COUNT(*)
          FROM offering_taxonomies ot
          INNER JOIN offerings o ON o.id = ot.offering_id
          WHERE ot.taxonomy_id = t.id
            AND o.status = 'published'
            AND o.deleted_at IS NULL
        ) AS published_count
       FROM taxonomies t
       WHERE t.id = ? AND t.taxonomy_type = 'offering_category'
       LIMIT 1`,
    )
    .bind(categoryId)
    .first<RawCategoryRow>();

  return row ? mapCategoryRow(row) : null;
}

async function resolveCategoryParentDepth(
  tenantDb: D1Database,
  parentId: number | null,
  offeringType: CatalogOfferingType | null,
  selfCategoryId?: number,
): Promise<number> {
  if (parentId === null) return 1;
  if (selfCategoryId !== undefined && parentId === selfCategoryId) {
    throw new CatalogValidationError("Kategori tidak dapat menjadi induk dirinya sendiri.", [
      {
        field: "parentId",
        code: "CATEGORY_CYCLE",
        message: "Category cannot reference itself as parent.",
      },
    ]);
  }

  const allRes = await tenantDb
    .prepare(
      `SELECT id, parent_id, depth, offering_type
       FROM taxonomies
       WHERE taxonomy_type = 'offering_category'`,
    )
    .all<{
      readonly id: number;
      readonly parent_id: number | null;
      readonly depth: number;
      readonly offering_type: CatalogOfferingType | null;
    }>();

  const byId = new Map<
    number,
    { readonly parentId: number | null; readonly depth: number; readonly offeringType: CatalogOfferingType | null }
  >();
  for (const r of allRes.results) {
    byId.set(Number(r.id), {
      parentId: r.parent_id !== null ? Number(r.parent_id) : null,
      depth: Math.max(1, Number(r.depth)),
      offeringType: r.offering_type ?? null,
    });
  }

  const parent = byId.get(parentId);
  if (!parent) {
    throw new CatalogValidationError(`Kategori induk #${parentId} tidak ditemukan.`, [
      {
        field: "parentId",
        code: "CATEGORY_NOT_FOUND",
        message: `Parent category #${parentId} does not exist in this tenant.`,
      },
    ]);
  }

  if (parent.offeringType !== null && offeringType !== null && parent.offeringType !== offeringType) {
    throw new CatalogValidationError(
      `Tipe penawaran kategori tidak cocok dengan kategori induk (#${parentId}).`,
      [
        {
          field: "offeringType",
          code: "CATEGORY_TYPE_MISMATCH",
          message: `Parent category #${parentId} is scoped to "${parent.offeringType}".`,
        },
      ],
    );
  }

  // Walk upward to verify no cycles and compute exact depth
  let depth = 2;
  let cursor = parent.parentId;
  const visited = new Set<number>([parentId]);
  while (cursor !== null) {
    if (cursor === selfCategoryId || visited.has(cursor)) {
      throw new CatalogValidationError("Referensi induk kategori membentuk siklus.", [
        {
          field: "parentId",
          code: "CATEGORY_CYCLE",
          message: "Circular parent category reference detected.",
        },
      ]);
    }
    visited.add(cursor);
    const anc = byId.get(cursor);
    if (!anc) break;
    depth += 1;
    cursor = anc.parentId;
  }

  if (depth > MAX_CATEGORY_DEPTH) {
    throw new CatalogValidationError(
      `Kedalaman hierarki kategori maksimal ${MAX_CATEGORY_DEPTH} tingkat.`,
      [
        {
          field: "parentId",
          code: "CATEGORY_DEPTH_EXCEEDED",
          message: `Category hierarchy depth cannot exceed ${MAX_CATEGORY_DEPTH}.`,
        },
      ],
    );
  }

  // If updating an existing category, ensure none of its descendants would exceed MAX_CATEGORY_DEPTH
  if (selfCategoryId !== undefined) {
    const childrenByParent = new Map<number, number[]>();
    for (const [id, info] of byId.entries()) {
      if (info.parentId !== null) {
        const list = childrenByParent.get(info.parentId) ?? [];
        list.push(id);
        childrenByParent.set(info.parentId, list);
      }
    }
    const maxSubtreeHeight = (nodeId: number): number => {
      const children = childrenByParent.get(nodeId) ?? [];
      let maxH = 0;
      for (const childId of children) {
        maxH = Math.max(maxH, 1 + maxSubtreeHeight(childId));
      }
      return maxH;
    };
    if (depth + maxSubtreeHeight(selfCategoryId) > MAX_CATEGORY_DEPTH) {
      throw new CatalogValidationError(
        `Pemindahan ini akan membuat sub-kategori melebihi batas ${MAX_CATEGORY_DEPTH} tingkat.`,
        [
          {
            field: "parentId",
            code: "CATEGORY_DEPTH_EXCEEDED",
            message: `Moving category would push descendant categories past max depth ${MAX_CATEGORY_DEPTH}.`,
          },
        ],
      );
    }
  }

  return depth;
}

export async function createCatalogCategory(
  tenantDb: D1Database,
  rawInput: unknown,
  options: { readonly nowMs?: number } = {},
): Promise<StoredCatalogCategory> {
  const validated = validateCategoryInput(rawInput);
  const nowMs = options.nowMs ?? Date.now();
  const depth = await resolveCategoryParentDepth(
    tenantDb,
    validated.parentId,
    validated.offeringType,
  );

  // Pre-check manual slug conflicts BEFORE allocating a sequential ID (no wasted IDs on 422)
  if (validated.manualSlug !== null) {
    const taken = await collectTakenSlugs(tenantDb, CATEGORY_SLUG_NAMESPACE);
    if (taken.has(validated.manualSlug)) {
      const suggestedSlug = buildUniqueAutoSlug(validated.manualSlug, (c) => taken.has(c));
      throw new CatalogValidationError(
        `Slug kategori "${validated.manualSlug}" sudah digunakan.`,
        [
          {
            field: "slug",
            code: "SLUG_CONFLICT",
            message: `Slug "${validated.manualSlug}" is already in use (suggested: "${suggestedSlug}").`,
          },
        ],
        { suggestedSlug },
      );
    }
  }

  const id = await allocateTenantSequence(tenantDb, CATEGORY_SEQUENCE_KIND);
  const slug = await resolveSlugForCreate(tenantDb, {
    namespace: CATEGORY_SLUG_NAMESPACE,
    title: validated.name,
    manualSlug: validated.manualSlug,
    sequenceId: id,
  });

  try {
    await tenantDb.batch([
      tenantDb
        .prepare(
          `INSERT INTO taxonomies (
             id, taxonomy_type, offering_type, parent_id, depth,
             slug, name, description, sort_order, version, created_at, updated_at
           ) VALUES (?, 'offering_category', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          id,
          validated.offeringType,
          validated.parentId,
          depth,
          slug,
          validated.name,
          validated.description,
          validated.sortOrder,
          nowMs,
          nowMs,
        ),
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           VALUES (?, ?, ?, 1, NULL, ?)`,
        )
        .bind(CATEGORY_SLUG_NAMESPACE, slug, id, nowMs),
    ]);
  } catch (err) {
    if (isSlugUniqueConstraintError(err)) {
      throw mapSlugConstraintError(slug);
    }
    throw err;
  }

  const created = await getCatalogCategoryById(tenantDb, id);
  if (!created) {
    throw new Error(`Failed to reload newly created catalog category #${id}.`);
  }
  return created;
}

export async function updateCatalogCategory(
  tenantDb: D1Database,
  categoryId: number,
  rawPatch: Record<string, unknown>,
  options: { readonly expectedVersion: number; readonly nowMs?: number },
): Promise<StoredCatalogCategory> {
  assertValidExpectedVersion(options.expectedVersion);
  const nowMs = options.nowMs ?? Date.now();

  const existing = await tenantDb
    .prepare(
      `SELECT * FROM taxonomies WHERE id = ? AND taxonomy_type = 'offering_category' LIMIT 1`,
    )
    .bind(categoryId)
    .first<RawCategoryRow>();

  if (!existing) {
    throw new CatalogNotFoundError("category", categoryId);
  }
  if (Number(existing.version) !== options.expectedVersion) {
    throw new CatalogConflictError(
      `Konflik versi pada kategori #${categoryId} (diharapkan ${options.expectedVersion}, saat ini ${existing.version}).`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: options.expectedVersion,
        currentVersion: Number(existing.version),
      },
    );
  }

  const merged: Record<string, unknown> = {
    name: rawPatch.name !== undefined ? rawPatch.name : existing.name,
    offeringType:
      rawPatch.offeringType !== undefined ? rawPatch.offeringType : existing.offering_type,
    description:
      rawPatch.description !== undefined ? rawPatch.description : existing.description,
    parentId: rawPatch.parentId !== undefined ? rawPatch.parentId : existing.parent_id,
    sortOrder: rawPatch.sortOrder !== undefined ? rawPatch.sortOrder : existing.sort_order,
    ...(rawPatch.slug !== undefined ? { slug: rawPatch.slug } : {}),
  };

  // Validate unknown/forbidden keys from rawPatch as well
  for (const [k, v] of Object.entries(rawPatch)) {
    if (k === "version" || k === "expectedVersion") continue;
    if (!(k in merged)) {
      merged[k] = v;
    }
  }

  const validated = validateCategoryInput(merged);

  // Prevent changing a category's offeringType while non-trashed offerings are linked to it.
  if (validated.offeringType !== (existing.offering_type ?? null)) {
    const linkedOffering = await tenantDb
      .prepare(
        `SELECT ot.offering_id
         FROM offering_taxonomies ot
         INNER JOIN offerings o ON o.id = ot.offering_id
         WHERE ot.taxonomy_id = ? AND o.deleted_at IS NULL AND o.status != 'trashed'
         LIMIT 1`,
      )
      .bind(categoryId)
      .first<{ readonly offering_id: number }>();

    if (linkedOffering) {
      throw new CatalogValidationError(
        `Tipe penawaran kategori #${categoryId} tidak dapat diubah karena sudah terhubung ke penawaran (#${linkedOffering.offering_id}).`,
        [
          {
            field: "offeringType",
            code: "CATEGORY_IN_USE",
            message: `Category #${categoryId} offeringType cannot be changed while linked to offering #${linkedOffering.offering_id}.`,
          },
        ],
      );
    }
  }

  const depth = await resolveCategoryParentDepth(
    tenantDb,
    validated.parentId,
    validated.offeringType,
    categoryId,
  );

  const slugResolution = await resolveSlugForUpdate(tenantDb, {
    namespace: CATEGORY_SLUG_NAMESPACE,
    resourceId: categoryId,
    currentSlug: existing.slug,
    nextManualSlug: validated.manualSlug,
  });

  const nextVersion = options.expectedVersion + 1;
  const stmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE taxonomies
         SET offering_type = ?,
             parent_id = ?,
             depth = ?,
             slug = ?,
             name = ?,
             description = ?,
             sort_order = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND taxonomy_type = 'offering_category' AND version = ?`,
      )
      .bind(
        validated.offeringType,
        validated.parentId,
        depth,
        slugResolution.slug,
        validated.name,
        validated.description,
        validated.sortOrder,
        nowMs,
        categoryId,
        options.expectedVersion,
      ),
  ];

  if (slugResolution.changed) {
    stmts.push(
      ...buildResourceSlugSyncStatements(tenantDb, {
        namespace: CATEGORY_SLUG_NAMESPACE,
        resourceId: categoryId,
        oldSlug: existing.slug,
        newSlug: slugResolution.slug,
        keepFormerSlug: true,
        nowMs,
        guard: {
          existsSql:
            "SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = 'offering_category' AND version = ? AND slug = ? AND name = ? AND updated_at = ?",
          binds: [categoryId, nextVersion, slugResolution.slug, validated.name, nowMs],
        },
      }),
    );
  }

  let results: D1Result[];
  try {
    results = await tenantDb.batch(stmts);
  } catch (err) {
    if (isSlugUniqueConstraintError(err)) {
      throw mapSlugConstraintError(slugResolution.slug);
    }
    throw err;
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await getCatalogCategoryById(tenantDb, categoryId);
    throw new CatalogConflictError(
      `Konflik versi saat memperbarui kategori #${categoryId}.`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: options.expectedVersion,
        currentVersion: latest?.version,
      },
    );
  }

  const updated = await getCatalogCategoryById(tenantDb, categoryId);
  if (!updated) {
    throw new Error(`Failed to reload updated catalog category #${categoryId}.`);
  }
  return updated;
}

export async function deleteCatalogCategory(
  tenantDb: D1Database,
  categoryId: number,
  options: { readonly expectedVersion?: number } = {},
): Promise<{ readonly id: number; readonly deleted: true }> {
  if (options.expectedVersion !== undefined) {
    assertValidExpectedVersion(options.expectedVersion);
  }

  const existing = await tenantDb
    .prepare(
      `SELECT id, version FROM taxonomies WHERE id = ? AND taxonomy_type = 'offering_category' LIMIT 1`,
    )
    .bind(categoryId)
    .first<{ readonly id: number; readonly version: number }>();

  if (!existing) {
    throw new CatalogNotFoundError("category", categoryId);
  }
  if (
    options.expectedVersion !== undefined &&
    Number(existing.version) !== options.expectedVersion
  ) {
    throw new CatalogConflictError(
      `Konflik versi saat menghapus kategori #${categoryId}.`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: options.expectedVersion,
        currentVersion: Number(existing.version),
      },
    );
  }

  const childRow = await tenantDb
    .prepare(`SELECT id FROM taxonomies WHERE parent_id = ? LIMIT 1`)
    .bind(categoryId)
    .first<{ readonly id: number }>();
  if (childRow) {
    throw new CatalogConflictError(
      `Kategori #${categoryId} masih memiliki sub-kategori; pindahkan atau hapus sub-kategori terlebih dahulu.`,
      { code: "CONFLICT", field: "categoryId" },
    );
  }

  const publishedRef = await tenantDb
    .prepare(
      `SELECT o.id
       FROM offering_taxonomies ot
       INNER JOIN offerings o ON o.id = ot.offering_id
       WHERE ot.taxonomy_id = ? AND o.status = 'published' AND o.deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(categoryId)
    .first<{ readonly id: number }>();
  if (publishedRef) {
    throw new CatalogConflictError(
      `Kategori #${categoryId} masih digunakan oleh penawaran yang dipublikasikan (#${publishedRef.id}).`,
      { code: "CONFLICT", field: "categoryId" },
    );
  }

  // Gate dependent deletes on the exact expected version inside ONE atomic batch so a stale/losing
  // concurrent DELETE leaves ZERO side effects on `offering_taxonomies` or `resource_slugs`.
  const targetVersion = options.expectedVersion ?? Number(existing.version);
  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `DELETE FROM offering_taxonomies
         WHERE taxonomy_id = ?
           AND EXISTS (
             SELECT 1 FROM taxonomies
             WHERE id = ? AND taxonomy_type = 'offering_category' AND version = ?
           )`,
      )
      .bind(categoryId, categoryId, targetVersion),
    tenantDb
      .prepare(
        `DELETE FROM resource_slugs
         WHERE namespace = ? AND resource_id = ?
           AND EXISTS (
             SELECT 1 FROM taxonomies
             WHERE id = ? AND taxonomy_type = 'offering_category' AND version = ?
           )`,
      )
      .bind(CATEGORY_SLUG_NAMESPACE, categoryId, categoryId, targetVersion),
    tenantDb
      .prepare(
        `DELETE FROM taxonomies
         WHERE id = ? AND taxonomy_type = 'offering_category' AND version = ?`,
      )
      .bind(categoryId, targetVersion),
  ]);

  if ((results[2]?.meta?.changes ?? 0) !== 1) {
    const latest = await getCatalogCategoryById(tenantDb, categoryId);
    throw new CatalogConflictError(
      `Konflik versi saat menghapus kategori #${categoryId}.`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: targetVersion,
        currentVersion: latest?.version,
      },
    );
  }

  return { id: categoryId, deleted: true };
}

// ---------------------------------------------------------------------------
// Offerings CRUD + Atomic Publish / Unpublish + Soft Delete
// ---------------------------------------------------------------------------

export async function listCatalogOfferings(
  tenantDb: D1Database,
  options: ListCatalogOfferingsOptions = {},
): Promise<{ readonly items: StoredCatalogOffering[]; readonly page: CatalogPageMeta }> {
  const limit = normalizeLimit(options.limit);
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (!options.includeTrashed) {
    conditions.push("o.deleted_at IS NULL");
    conditions.push("o.status != 'trashed'");
  }
  if (options.offeringType) {
    conditions.push("o.offering_type = ?");
    binds.push(options.offeringType);
  }
  if (options.status) {
    conditions.push("o.status = ?");
    binds.push(options.status);
  }
  if (options.categoryId !== undefined && Number.isInteger(options.categoryId) && options.categoryId > 0) {
    conditions.push(
      "EXISTS (SELECT 1 FROM offering_taxonomies ot WHERE ot.offering_id = o.id AND ot.taxonomy_id = ?)",
    );
    binds.push(options.categoryId);
  }
  if (options.cursor !== undefined && Number.isInteger(options.cursor) && options.cursor > 0) {
    conditions.push("o.id < ?");
    binds.push(options.cursor);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT o.*
    FROM offerings o
    ${whereSql}
    ORDER BY o.id DESC
    LIMIT ?
  `;

  const res = await tenantDb
    .prepare(sql)
    .bind(...binds, limit + 1)
    .all<RawOfferingRow>();

  const hasMore = res.results.length > limit;
  const rows = hasMore ? res.results.slice(0, limit) : res.results;
  const catMap = await fetchCategoryIdsForOfferings(
    tenantDb,
    rows.map((r) => Number(r.id)),
  );
  const items = rows.map((row) => mapOfferingRow(row, catMap.get(Number(row.id)) ?? []));
  const lastItem = items[items.length - 1];

  return {
    items,
    page: {
      nextCursor: hasMore && lastItem ? String(lastItem.id) : null,
      limit,
      hasMore,
    },
  };
}

export async function getCatalogOfferingById(
  tenantDb: D1Database,
  offeringId: number,
  options: { readonly includeTrashed?: boolean } = {},
): Promise<StoredCatalogOffering | null> {
  const trashedPredicate = options.includeTrashed ? "" : " AND deleted_at IS NULL AND status != 'trashed'";
  const row = await tenantDb
    .prepare(`SELECT * FROM offerings WHERE id = ?${trashedPredicate} LIMIT 1`)
    .bind(offeringId)
    .first<RawOfferingRow>();

  if (!row) return null;
  const catMap = await fetchCategoryIdsForOfferings(tenantDb, [Number(row.id)]);
  return mapOfferingRow(row, catMap.get(Number(row.id)) ?? []);
}

export async function createCatalogOffering(
  tenantDb: D1Database,
  rawInput: unknown,
  options: { readonly nowMs?: number } = {},
): Promise<StoredCatalogOffering> {
  const nowMs = options.nowMs ?? Date.now();
  const tenantWhatsAppE164 = await resolveTenantWhatsAppNumber(tenantDb);
  const validated = validateOfferingInput(rawInput, { tenantWhatsAppE164 });

  // Verify intra-tenant media & category ownership BEFORE allocating sequence IDs
  await verifyTenantMediaReferences(tenantDb, {
    coverMediaId: validated.coverMediaId,
    videoMediaId: validated.videoMediaId,
    galleryMediaIds: validated.galleryMediaIds,
    ogImageMediaId: validated.seo?.ogImageMediaId ?? null,
  });
  await verifyTenantCategoryReferences(tenantDb, validated.offeringType, validated.categoryIds);

  const namespace = getOfferingSlugNamespace(validated.offeringType);

  // Pre-check manual slug conflicts before burning a sequence ID
  if (validated.manualSlug !== null) {
    const taken = await collectTakenSlugs(tenantDb, namespace, {
      offeringType: validated.offeringType,
    });
    if (taken.has(validated.manualSlug)) {
      const suggestedSlug = buildUniqueAutoSlug(validated.manualSlug, (c) => taken.has(c));
      throw new CatalogValidationError(
        `Slug "${validated.manualSlug}" sudah digunakan di namespace "${namespace}".`,
        [
          {
            field: "slug",
            code: "SLUG_CONFLICT",
            message: `Slug "${validated.manualSlug}" is already in use (suggested: "${suggestedSlug}").`,
          },
        ],
        { suggestedSlug },
      );
    }
  }

  const id = await allocateTenantSequence(tenantDb, OFFERING_SEQUENCE_KIND);
  const slug = await resolveSlugForCreate(tenantDb, {
    namespace,
    offeringType: validated.offeringType,
    title: validated.title,
    manualSlug: validated.manualSlug,
    sequenceId: id,
  });

  const draftSnapshotJson = buildDraftSnapshotStorageJson(slug, validated);

  const stmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `INSERT INTO offerings (
           id, offering_type, slug, title, summary, description,
           cover_media_id, gallery_media_ids_json, video_media_id, youtube_video_id,
           price_mode, price, price_max, negotiable, original_amount, badge,
           cta_mode, external_url, unit_status,
           attributes_version, attributes_json, draft_snapshot_json, published_snapshot_json, seo_json,
           status, published_at, content_modified_at, deleted_at, version, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, NULL, ?,
           'draft', NULL, NULL, NULL, 1, ?, ?
         )`,
      )
      .bind(
        id,
        validated.offeringType,
        slug,
        validated.title,
        validated.summary,
        serializeDescriptionForStorage(validated.description),
        validated.coverMediaId,
        JSON.stringify(validated.galleryMediaIds),
        validated.videoMediaId,
        validated.youtubeVideoId,
        validated.pricing.priceMode,
        validated.pricing.price,
        validated.pricing.priceMax,
        validated.pricing.negotiable ? 1 : 0,
        validated.pricing.originalAmount,
        validated.badge,
        validated.cta.ctaMode,
        validated.cta.externalUrl,
        validated.unitStatus,
        validated.attributesVersion,
        JSON.stringify(validated.attributes),
        draftSnapshotJson,
        validated.seo ? JSON.stringify(validated.seo) : null,
        nowMs,
        nowMs,
      ),
    tenantDb
      .prepare(
        `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?)`,
      )
      .bind(namespace, slug, id, nowMs),
  ];

  for (const catId of validated.categoryIds) {
    stmts.push(
      tenantDb
        .prepare(`INSERT INTO offering_taxonomies (offering_id, taxonomy_id) VALUES (?, ?)`)
        .bind(id, catId),
    );
  }

  try {
    await tenantDb.batch(stmts);
  } catch (err) {
    if (isSlugUniqueConstraintError(err)) {
      throw mapSlugConstraintError(slug);
    }
    throw err;
  }

  const created = await getCatalogOfferingById(tenantDb, id);
  if (!created) {
    throw new Error(`Failed to reload newly created offering #${id}.`);
  }
  return created;
}

export async function updateCatalogOffering(
  tenantDb: D1Database,
  offeringId: number,
  rawPatch: Record<string, unknown>,
  options: { readonly expectedVersion: number; readonly nowMs?: number },
): Promise<StoredCatalogOffering> {
  assertValidExpectedVersion(options.expectedVersion);
  const nowMs = options.nowMs ?? Date.now();

  const existingRow = await tenantDb
    .prepare(
      `SELECT * FROM offerings WHERE id = ? AND deleted_at IS NULL AND status != 'trashed' LIMIT 1`,
    )
    .bind(offeringId)
    .first<RawOfferingRow>();

  if (!existingRow) {
    throw new CatalogNotFoundError("offering", offeringId);
  }
  if (Number(existingRow.version) !== options.expectedVersion) {
    throw new CatalogConflictError(
      `Konflik versi pada penawaran #${offeringId} (diharapkan ${options.expectedVersion}, saat ini ${existingRow.version}).`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: options.expectedVersion,
        currentVersion: Number(existingRow.version),
      },
    );
  }

  if (
    rawPatch.offeringType !== undefined &&
    rawPatch.offeringType !== existingRow.offering_type
  ) {
    throw new CatalogValidationError(
      `Tipe penawaran tidak dapat diubah dari "${existingRow.offering_type}".`,
      [
        {
          field: "offeringType",
          code: "INVALID_OFFERING_TYPE",
          message: `offeringType is immutable after creation (expected "${existingRow.offering_type}").`,
        },
      ],
    );
  }

  const existingCatsMap = await fetchCategoryIdsForOfferings(tenantDb, [offeringId]);
  const existingDto = mapOfferingRow(existingRow, existingCatsMap.get(offeringId) ?? []);

  // Build merged draft candidate preserving untouched fields while honoring explicit nulls/updates
  const merged: Record<string, unknown> = {
    offeringType: existingDto.offeringType,
    title: rawPatch.title !== undefined ? rawPatch.title : existingDto.title,
    summary: rawPatch.summary !== undefined ? rawPatch.summary : existingDto.summary,
    description:
      rawPatch.description !== undefined ? rawPatch.description : existingDto.description,
    coverMediaId:
      rawPatch.coverMediaId !== undefined ? rawPatch.coverMediaId : existingDto.coverMediaId,
    galleryMediaIds:
      rawPatch.galleryMediaIds !== undefined
        ? rawPatch.galleryMediaIds
        : existingDto.galleryMediaIds,
    videoMediaId:
      rawPatch.videoMediaId !== undefined ? rawPatch.videoMediaId : existingDto.videoMediaId,
    youtubeVideoId:
      rawPatch.youtubeVideoId !== undefined
        ? rawPatch.youtubeVideoId
        : rawPatch.youtubeId !== undefined
          ? rawPatch.youtubeId
          : existingDto.youtubeVideoId,
    priceMode: rawPatch.priceMode !== undefined ? rawPatch.priceMode : existingDto.priceMode,
    price: rawPatch.price !== undefined ? rawPatch.price : existingDto.price,
    priceMax: rawPatch.priceMax !== undefined ? rawPatch.priceMax : existingDto.priceMax,
    negotiable: rawPatch.negotiable !== undefined ? rawPatch.negotiable : existingDto.negotiable,
    originalAmount:
      rawPatch.originalAmount !== undefined
        ? rawPatch.originalAmount
        : existingDto.originalAmount,
    badge:
      rawPatch.badge !== undefined
        ? rawPatch.badge
        : rawPatch.badges !== undefined
          ? undefined
          : existingDto.badge,
    badges:
      rawPatch.badges !== undefined
        ? rawPatch.badges
        : rawPatch.badge !== undefined
          ? undefined
          : existingDto.badges,
    ctaMode:
      rawPatch.ctaMode !== undefined
        ? rawPatch.ctaMode
        : rawPatch.ctaKind !== undefined
          ? rawPatch.ctaKind
          : existingDto.ctaMode,
    ctaLabel: rawPatch.ctaLabel !== undefined ? rawPatch.ctaLabel : existingDto.ctaLabel,
    externalUrl:
      rawPatch.externalUrl !== undefined ? rawPatch.externalUrl : existingDto.externalUrl,
    whatsappOverride:
      rawPatch.whatsappOverride !== undefined
        ? rawPatch.whatsappOverride
        : existingDto.whatsappOverride,
    whatsappTemplate:
      rawPatch.whatsappTemplate !== undefined
        ? rawPatch.whatsappTemplate
        : existingDto.whatsappTemplate,
    unitStatus: rawPatch.unitStatus !== undefined ? rawPatch.unitStatus : existingDto.unitStatus,
    categoryIds:
      rawPatch.categoryIds !== undefined ? rawPatch.categoryIds : existingDto.categoryIds,
    attributesVersion:
      rawPatch.attributesVersion !== undefined
        ? rawPatch.attributesVersion
        : existingDto.attributesVersion,
    attributes: rawPatch.attributes !== undefined ? rawPatch.attributes : existingDto.attributes,
    seo: rawPatch.seo !== undefined ? rawPatch.seo : existingDto.seo,
    ...(rawPatch.slug !== undefined ? { slug: rawPatch.slug } : {}),
  };

  // Preserve conflict checks when both aliases or unknown keys were passed in rawPatch
  if (rawPatch.ctaMode !== undefined && rawPatch.ctaKind !== undefined) {
    merged.ctaKind = rawPatch.ctaKind;
  }
  if (rawPatch.youtubeVideoId !== undefined && rawPatch.youtubeId !== undefined) {
    merged.youtubeId = rawPatch.youtubeId;
  }
  for (const [k, v] of Object.entries(rawPatch)) {
    if (k === "version" || k === "expectedVersion") continue;
    if (!(k in merged)) {
      merged[k] = v;
    }
  }

  const tenantWhatsAppE164 = await resolveTenantWhatsAppNumber(tenantDb);
  const validated = validateOfferingInput(merged, { tenantWhatsAppE164 });

  await verifyTenantMediaReferences(tenantDb, {
    coverMediaId: validated.coverMediaId,
    videoMediaId: validated.videoMediaId,
    galleryMediaIds: validated.galleryMediaIds,
    ogImageMediaId: validated.seo?.ogImageMediaId ?? null,
  });
  await verifyTenantCategoryReferences(tenantDb, validated.offeringType, validated.categoryIds);

  const namespace = getOfferingSlugNamespace(validated.offeringType);
  const slugResolution = await resolveSlugForUpdate(tenantDb, {
    namespace,
    offeringType: validated.offeringType,
    resourceId: offeringId,
    currentSlug: existingRow.slug,
    nextManualSlug: validated.manualSlug,
  });

  const draftSnapshotJson = buildDraftSnapshotStorageJson(slugResolution.slug, validated);

  const nextVersion = options.expectedVersion + 1;
  // Every follow-up statement in the atomic batch is gated on Statement 0 having won
  // (matching `id`, incremented `version`, `slug`, AND this write's unique `draft_snapshot_json`
  // containing a per-request `writeToken`). If Statement 0 affects 0 rows under a concurrent race,
  // ALL subsequent statements affect 0 rows and leave ZERO side effects.
  const offeringBatchGuard: BatchMutationGuard = {
    existsSql:
      "SELECT 1 FROM offerings WHERE id = ? AND version = ? AND slug = ? AND draft_snapshot_json = ?",
    binds: [offeringId, nextVersion, slugResolution.slug, draftSnapshotJson],
  };

  // Draft update NEVER mutates `published_snapshot_json`, `status`, `published_at`, or `content_modified_at`.
  const stmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE offerings
         SET slug = ?,
             title = ?,
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
        slugResolution.slug,
        validated.title,
        validated.summary,
        serializeDescriptionForStorage(validated.description),
        validated.coverMediaId,
        JSON.stringify(validated.galleryMediaIds),
        validated.videoMediaId,
        validated.youtubeVideoId,
        validated.pricing.priceMode,
        validated.pricing.price,
        validated.pricing.priceMax,
        validated.pricing.negotiable ? 1 : 0,
        validated.pricing.originalAmount,
        validated.badge,
        validated.cta.ctaMode,
        validated.cta.externalUrl,
        validated.unitStatus,
        validated.attributesVersion,
        JSON.stringify(validated.attributes),
        draftSnapshotJson,
        validated.seo ? JSON.stringify(validated.seo) : null,
        nowMs,
        offeringId,
        options.expectedVersion,
      ),
    tenantDb
      .prepare(
        `DELETE FROM offering_taxonomies
         WHERE offering_id = ?
           AND EXISTS (${offeringBatchGuard.existsSql})`,
      )
      .bind(offeringId, ...offeringBatchGuard.binds),
  ];

  for (const catId of validated.categoryIds) {
    stmts.push(
      tenantDb
        .prepare(
          `INSERT INTO offering_taxonomies (offering_id, taxonomy_id)
           SELECT ?, ?
           WHERE EXISTS (${offeringBatchGuard.existsSql})`,
        )
        .bind(offeringId, catId, ...offeringBatchGuard.binds),
    );
  }

  if (slugResolution.changed) {
    stmts.push(
      ...buildResourceSlugSyncStatements(tenantDb, {
        namespace,
        resourceId: offeringId,
        oldSlug: existingRow.slug,
        newSlug: slugResolution.slug,
        keepFormerSlug: existingRow.published_at !== null,
        nowMs,
        guard: offeringBatchGuard,
      }),
    );
  }

  let results: D1Result[];
  try {
    results = await tenantDb.batch(stmts);
  } catch (err) {
    if (isSlugUniqueConstraintError(err)) {
      throw mapSlugConstraintError(slugResolution.slug);
    }
    throw err;
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await getCatalogOfferingById(tenantDb, offeringId);
    throw new CatalogConflictError(
      `Konflik versi saat memperbarui penawaran #${offeringId}.`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: options.expectedVersion,
        currentVersion: latest?.version,
      },
    );
  }

  const updated = await getCatalogOfferingById(tenantDb, offeringId);
  if (!updated) {
    throw new Error(`Failed to reload updated offering #${offeringId}.`);
  }
  return updated;
}

/**
 * Re-validates the complete offering (media readiness, categories, WA/HTTPS CTA, per-type attributes)
 * and atomically publishes via `publishResourceAtomically` (`@punyasitus/db/publication/index`),
 * preserving full per-type `attributes_json` alongside the `OfferingSnapshotSchema`-valid published snapshot.
 */
export async function publishCatalogOffering(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly offeringId: number;
    readonly expectedVersion: number;
    readonly actorUserId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly offering: StoredCatalogOffering;
  readonly cacheVersion: number;
  readonly revisionNumber: number | null;
}> {
  assertValidExpectedVersion(params.expectedVersion);

  const existing = await getCatalogOfferingById(tenantDb, params.offeringId);
  if (!existing) {
    throw new CatalogNotFoundError("offering", params.offeringId);
  }
  if (existing.version !== params.expectedVersion) {
    throw new CatalogConflictError(
      `Konflik versi saat mempublikasikan penawaran #${params.offeringId} (diharapkan ${params.expectedVersion}, saat ini ${existing.version}).`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: params.expectedVersion,
        currentVersion: existing.version,
      },
    );
  }

  // Re-validate full offering invariants before publication
  const tenantWhatsAppE164 = await resolveTenantWhatsAppNumber(tenantDb);
  const validated = validateOfferingInput(
    {
      offeringType: existing.offeringType,
      title: existing.title,
      slug: existing.slug,
      summary: existing.summary,
      description: existing.description,
      coverMediaId: existing.coverMediaId,
      galleryMediaIds: existing.galleryMediaIds,
      videoMediaId: existing.videoMediaId,
      youtubeVideoId: existing.youtubeVideoId,
      priceMode: existing.priceMode,
      price: existing.price,
      priceMax: existing.priceMax,
      negotiable: existing.negotiable,
      originalAmount: existing.originalAmount,
      badge: existing.badge,
      badges: existing.badges,
      ctaMode: existing.ctaMode,
      ctaLabel: existing.ctaLabel,
      externalUrl: existing.externalUrl,
      whatsappOverride: existing.whatsappOverride,
      whatsappTemplate: existing.whatsappTemplate,
      unitStatus: existing.unitStatus,
      categoryIds: existing.categoryIds,
      attributesVersion: existing.attributesVersion,
      attributes: existing.attributes,
      seo: existing.seo,
    },
    { tenantWhatsAppE164 },
  );

  await verifyTenantMediaReferences(
    tenantDb,
    {
      coverMediaId: validated.coverMediaId,
      videoMediaId: validated.videoMediaId,
      galleryMediaIds: validated.galleryMediaIds,
      ogImageMediaId: validated.seo?.ogImageMediaId ?? null,
    },
    { requireReady: true },
  );
  await verifyTenantCategoryReferences(tenantDb, validated.offeringType, validated.categoryIds);

  const publishSnapshotData = buildOfferingSnapshotForPublication(existing.slug, validated);

  const published = await publishResourceAtomically(platformDb, tenantDb, {
    tenantId: params.tenantId,
    resourceType: "offering",
    resourceId: params.offeringId,
    expectedVersion: params.expectedVersion,
    actorUserId: params.actorUserId ?? null,
    draftOverride: publishSnapshotData,
    nowMs: params.nowMs,
  });

  // Restore full rich per-type `attributes_json` on the offering row without altering
  // `published_snapshot_json` or `version`, so both public DTO extraction and rich
  // vertical catalog attributes remain intact.
  await tenantDb
    .prepare(
      `UPDATE offerings
       SET attributes_json = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(JSON.stringify(validated.attributes), params.offeringId, published.version)
    .run();

  const reloaded = await getCatalogOfferingById(tenantDb, params.offeringId);
  if (!reloaded) {
    throw new Error(`Failed to reload published offering #${params.offeringId}.`);
  }

  return {
    offering: reloaded,
    cacheVersion: published.cacheVersion,
    revisionNumber: published.revisionNumber,
  };
}

/**
 * Atomically unpublishes an offering via `unpublishResourceAtomically`, returning it
 * to `draft` and bumping `PLATFORM_DB.tenants.cache_version`.
 */
export async function unpublishCatalogOffering(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly offeringId: number;
    readonly expectedVersion: number;
    readonly nowMs?: number;
  },
): Promise<{
  readonly offering: StoredCatalogOffering;
  readonly cacheVersion: number;
  readonly unpublishedAt: number;
}> {
  assertValidExpectedVersion(params.expectedVersion);

  const result = await unpublishResourceAtomically(platformDb, tenantDb, {
    tenantId: params.tenantId,
    resourceType: "offering",
    resourceId: params.offeringId,
    expectedVersion: params.expectedVersion,
    nowMs: params.nowMs,
  });

  const reloaded = await getCatalogOfferingById(tenantDb, params.offeringId);
  if (!reloaded) {
    throw new Error(`Failed to reload unpublished offering #${params.offeringId}.`);
  }

  return {
    offering: reloaded,
    cacheVersion: result.cacheVersion,
    unpublishedAt: result.unpublishedAt,
  };
}

/**
 * Soft-deletes an offering into 30-day trash (`status = 'trashed'`, `deleted_at = nowMs`,
 * `published_snapshot_json = NULL`). If it was published, bumps `PLATFORM_DB.tenants.cache_version`
 * with fail-closed compensation on failure.
 */
export async function softDeleteCatalogOffering(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly offeringId: number;
    readonly expectedVersion: number;
    readonly nowMs?: number;
  },
): Promise<{
  readonly id: number;
  readonly deleted: true;
  readonly version: number;
  readonly cacheVersion: number | null;
}> {
  assertValidExpectedVersion(params.expectedVersion);
  const nowMs = params.nowMs ?? Date.now();

  const prior = await tenantDb
    .prepare(
      `SELECT id, status, published_snapshot_json, deleted_at, version, updated_at
       FROM offerings
       WHERE id = ? AND deleted_at IS NULL AND status != 'trashed'
       LIMIT 1`,
    )
    .bind(params.offeringId)
    .first<{
      readonly id: number;
      readonly status: ResourceLifecycleStatus;
      readonly published_snapshot_json: string | null;
      readonly deleted_at: number | null;
      readonly version: number;
      readonly updated_at: number;
    }>();

  if (!prior) {
    throw new CatalogNotFoundError("offering", params.offeringId);
  }
  if (Number(prior.version) !== params.expectedVersion) {
    throw new CatalogConflictError(
      `Konflik versi saat menghapus penawaran #${params.offeringId}.`,
      {
        code: "STALE_VERSION",
        field: "version",
        expectedVersion: params.expectedVersion,
        currentVersion: Number(prior.version),
      },
    );
  }

  const updateRes = await tenantDb
    .prepare(
      `UPDATE offerings
       SET status = 'trashed',
           published_snapshot_json = NULL,
           deleted_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(nowMs, nowMs, params.offeringId, params.expectedVersion)
    .run();

  if ((updateRes.meta?.changes ?? 0) !== 1) {
    throw new CatalogConflictError(
      `Konflik versi saat menghapus penawaran #${params.offeringId}.`,
      { code: "STALE_VERSION", field: "version", expectedVersion: params.expectedVersion },
    );
  }

  const nextVersion = params.expectedVersion + 1;
  let cacheVersion: number | null = null;
  if (prior.status === "published") {
    try {
      cacheVersion = await bumpTenantCacheVersion(platformDb, params.tenantId, nowMs);
    } catch (err) {
      let compensated = false;
      try {
        const restoreRes = await tenantDb
          .prepare(
            `UPDATE offerings
             SET status = ?,
                 published_snapshot_json = ?,
                 deleted_at = NULL,
                 version = ?,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            prior.status,
            prior.published_snapshot_json,
            prior.version,
            prior.updated_at,
            params.offeringId,
            nextVersion,
          )
          .run();
        compensated = (restoreRes.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation failed
      }
      throw new PublicationAtomicError(
        `Failed to bump tenant cache_version during offering trash${
          compensated ? "; TenantStore rolled back cleanly" : "; compensation failed"
        }`,
        { compensated, cause: err },
      );
    }
  }

  return {
    id: params.offeringId,
    deleted: true,
    version: nextVersion,
    cacheVersion,
  };
}
