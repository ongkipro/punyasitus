import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import {
  assertNoForbiddenTenantSelectors,
  extractPublishedSnapshot,
} from "@punyasitus/core/content/index";
import {
  buildSuffixedSlug,
  isReservedSlug,
  normalizeTitleToSlug,
  SlugValidationError,
  suggestAlternativeSlug,
  validateManualSlug,
} from "@punyasitus/core/slug/index";
import {
  assertSafeTaxonomyDelete,
  computeTaxonomyIndexable,
  getTaxonomyFallbackPrefix,
  getTaxonomyPublicBasePath,
  getTaxonomySlugNamespace,
  hasUsefulTaxonomyIntro,
  MAX_TAXONOMY_DEPTH,
  normalizeDepthValue,
  TaxonomyDomainError,
  validatePositiveTaxonomyId,
  validateTaxonomyDescription,
  validateTaxonomyHierarchy,
  validateTaxonomyName,
  validateTaxonomyOfferingType,
  validateTaxonomySortOrder,
  type TaxonomyHierarchyNode,
  type TaxonomyKind,
} from "@punyasitus/core/taxonomy/index";
import {
  allocateNextSequenceId,
  buildFormerSlugTransitionStatements,
  findResourceSlug,
  isSlugTakenInNamespace,
  isUniqueConstraintError,
  listResourceSlugsForResource,
} from "../identifiers/index.ts";
import { bumpTenantCacheVersion } from "../publication/index.ts";

/**
 * Unified Per-Tenant Taxonomy Repository (`packages/db/src/taxonomy/index.ts`;
 * TASK-041, REQ-045, REQ-009, REQ-012, REQ-034, REQ-036, REQ-061).
 *
 * ZERO runtime DDL:
 * - Reuses `taxonomies`, `post_taxonomies`, `offering_taxonomies`, `posts`, `offerings`,
 *   `resource_slugs`, `sequences`, `tenant_activity_log` (`0001_initial_tenant.sql`), and
 *   durable `taxonomy_archive_settings` (`0008_taxonomy_archive_settings.sql`).
 * - Enforces depth <= 3, cycle rejection (`422 TAXONOMY_CYCLE_OR_DEPTH`), flat tags (`parentId = null`),
 *   same-`offeringType` parents for `offering_category`, and tenant-local slug uniqueness — BOTH
 *   in pre-validation AND atomically inside SQLite `WITH RECURSIVE` Statement 0 guards so concurrent
 *   reparents or parent deletions NEVER produce cycles, depth > 3 drift, or raw FK 503 errors!
 * - Computes published-only counts strictly from frozen published snapshots (`published_body_json` /
 *   `published_snapshot_json`) so draft assignments or trashed items NEVER leak publicly, while
 *   authorized editors see complete `publishedCount`, `draftCount`, `totalUsageCount`, and `childCount`.
 * - Enforces safe guarded deletion (`409 CATEGORY_HAS_CHILDREN`, `409 TAXONOMY_IN_USE`) with atomic
 *   in-SQL usage checks, per-item optimistic `version` guards on every rewritten post/offering
 *   (preventing lost concurrent edits + bumping `version` and `updated_at`), mixed offeringType
 *   reassignment protection, and atomic `tenant_activity_log` audit entries (`WHERE changes() = 1`).
 */

export interface TaxonomyAuditContext {
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly platformDb?: D1Database | null;
  readonly tenantId?: string | null;
}

interface RawTaxonomyRow {
  readonly id: number;
  readonly taxonomy_type: TaxonomyKind;
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
}

export interface TaxonomyUsageCounts {
  readonly publishedCount: number;
  readonly draftCount: number;
  readonly totalUsageCount: number;
  readonly childCount: number;
}

export interface TaxonomyRecord {
  readonly id: number;
  readonly kind: TaxonomyKind;
  readonly offeringType: CatalogOfferingType | null;
  readonly parentId: number | null;
  readonly depth: number;
  readonly slug: string;
  readonly publicPath: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly publishedCount: number;
  readonly draftCount: number;
  readonly totalUsageCount: number;
  readonly usageCount: number;
  readonly childCount: number;
  readonly indexOptIn: boolean;
  readonly hasUsefulIntro: boolean;
  readonly indexable: boolean;
  readonly formerSlugs: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListTaxonomiesOptions {
  readonly kind: TaxonomyKind;
  readonly offeringType?: CatalogOfferingType;
  readonly parentId?: number | null;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sortOrder?: "asc" | "desc";
}

export interface ListTaxonomiesResult {
  readonly items: readonly TaxonomyRecord[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface CreateTaxonomyInput {
  readonly kind: TaxonomyKind;
  readonly offeringType?: CatalogOfferingType | null;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly parentId?: number | null;
  readonly sortOrder?: number;
  readonly indexOptIn?: boolean;
  readonly nowMs?: number;
}

export interface UpdateTaxonomyInput {
  readonly kind?: TaxonomyKind;
  readonly taxonomyId: number;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly slug?: string;
  readonly confirmSlugChange?: boolean;
  readonly description?: string | null;
  readonly parentId?: number | null;
  readonly offeringType?: CatalogOfferingType | null;
  readonly sortOrder?: number;
  readonly indexOptIn?: boolean;
  readonly nowMs?: number;
}

export interface DeleteTaxonomyInput {
  readonly kind?: TaxonomyKind;
  readonly taxonomyId: number;
  readonly expectedVersion: number;
  readonly detach?: boolean;
  readonly reassignToId?: number;
  readonly nowMs?: number;
}

export class TaxonomyNotFoundError extends Error {
  readonly httpStatus = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly taxonomyId: number;

  constructor(taxonomyId: number, kind?: TaxonomyKind) {
    super(
      kind
        ? `Taksonomi ${kind}#${taxonomyId} tidak ditemukan.`
        : `Taksonomi #${taxonomyId} tidak ditemukan.`,
    );
    this.name = "TaxonomyNotFoundError";
    this.taxonomyId = taxonomyId;
  }
}

export class TaxonomyStaleVersionError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "STALE_VERSION" as const;
  readonly taxonomyId: number;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(params: {
    readonly taxonomyId: number;
    readonly expectedVersion: number;
    readonly actualVersion?: number | null;
    readonly detail?: string;
  }) {
    super(
      params.detail ??
        `Konflik versi pada taksonomi #${params.taxonomyId}: diharapkan ${params.expectedVersion}${
          params.actualVersion !== undefined && params.actualVersion !== null
            ? `, saat ini ${params.actualVersion}`
            : ""
        }.`,
    );
    this.name = "TaxonomyStaleVersionError";
    this.taxonomyId = params.taxonomyId;
    this.expectedVersion = params.expectedVersion;
    this.actualVersion = params.actualVersion ?? null;
  }
}

function assertValidExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new TaxonomyDomainError(
      422,
      "VALIDATION_ERROR",
      "expectedVersion harus berupa bilangan bulat positif.",
      [
        {
          field: "version",
          code: "INVALID_VERSION",
          message: "expectedVersion must be a positive integer.",
        },
      ],
    );
  }
}

function isSlugUniqueConstraintError(err: unknown): boolean {
  if (!isUniqueConstraintError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/taxonomies\.id\b/i.test(msg)) return false;
  return true;
}

function isForeignKeyConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(msg);
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read-only check whether additive migration `0008_taxonomy_archive_settings` has been
 * applied on this TenantStore (ZERO DDL; tolerates pre-0008 legacy test fixtures cleanly).
 */
async function hasTaxonomyArchiveSettingsTable(tenantDb: D1Database): Promise<boolean> {
  const row = await tenantDb
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'taxonomy_archive_settings'
       LIMIT 1`,
    )
    .first<{ readonly present: number }>();
  return Number(row?.present ?? 0) === 1;
}

async function fetchRawTaxonomy(
  tenantDb: D1Database,
  taxonomyId: number,
  expectedKind?: TaxonomyKind,
): Promise<RawTaxonomyRow | null> {
  if (expectedKind) {
    return tenantDb
      .prepare(
        `SELECT id, taxonomy_type, offering_type, parent_id, depth, slug, name, description,
                sort_order, version, created_at, updated_at
         FROM taxonomies
         WHERE id = ? AND taxonomy_type = ?
         LIMIT 1`,
      )
      .bind(taxonomyId, expectedKind)
      .first<RawTaxonomyRow>();
  }
  return tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, parent_id, depth, slug, name, description,
              sort_order, version, created_at, updated_at
       FROM taxonomies
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(taxonomyId)
    .first<RawTaxonomyRow>();
}

async function fetchAllSameKindNodes(
  tenantDb: D1Database,
  kind: TaxonomyKind,
): Promise<TaxonomyHierarchyNode[]> {
  const res = await tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, parent_id, depth, sort_order, name
       FROM taxonomies
       WHERE taxonomy_type = ?`,
    )
    .bind(kind)
    .all<{
      readonly id: number;
      readonly taxonomy_type: TaxonomyKind;
      readonly offering_type: CatalogOfferingType | null;
      readonly parent_id: number | null;
      readonly depth: number;
      readonly sort_order: number;
      readonly name: string;
    }>();

  return res.results.map((r) => ({
    id: Number(r.id),
    kind: r.taxonomy_type,
    offeringType: r.offering_type ?? null,
    parentId: r.parent_id !== null ? Number(r.parent_id) : null,
    depth: normalizeDepthValue(r.depth),
    sortOrder: Number(r.sort_order ?? 0),
    name: String(r.name),
  }));
}

async function isTaxonomySlugTaken(
  tenantDb: D1Database,
  kind: TaxonomyKind,
  slug: string,
  excludeId?: number,
): Promise<boolean> {
  const namespace = getTaxonomySlugNamespace(kind);
  if (await isSlugTakenInNamespace(tenantDb, namespace, slug, { excludeResourceId: excludeId })) {
    return true;
  }
  const existing = await tenantDb
    .prepare(`SELECT id FROM taxonomies WHERE taxonomy_type = ? AND slug = ? LIMIT 1`)
    .bind(kind, slug)
    .first<{ readonly id: number }>();
  if (!existing) return false;
  return excludeId === undefined || Number(existing.id) !== excludeId;
}

function extractPostSnapshotTaxonomyIds(
  rawJson: string | null | undefined,
  kind: "post_category" | "post_tag",
): Set<number> {
  const ids = new Set<number>();
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ids;
  const obj = parsed as Record<string, unknown>;
  const data =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : obj;

  if (kind === "post_category") {
    if (typeof data.primaryCategoryId === "number" && Number.isSafeInteger(data.primaryCategoryId)) {
      ids.add(data.primaryCategoryId);
    }
    if (Array.isArray(data.categoryIds)) {
      for (const v of data.categoryIds) {
        if (typeof v === "number" && Number.isSafeInteger(v)) ids.add(v);
      }
    }
  } else {
    if (Array.isArray(data.tagIds)) {
      for (const v of data.tagIds) {
        if (typeof v === "number" && Number.isSafeInteger(v)) ids.add(v);
      }
    }
  }
  return ids;
}

function extractOfferingSnapshotCategoryIds(rawJson: string | null | undefined): Set<number> {
  const ids = new Set<number>();
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ids;
  const obj = parsed as Record<string, unknown>;
  const data =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : obj;

  if (Array.isArray(data.categoryIds)) {
    for (const v of data.categoryIds) {
      if (typeof v === "number" && Number.isSafeInteger(v)) ids.add(v);
    }
  }
  return ids;
}

/**
 * Computes exact published-only, draft, total usage, and child counts for a batch of taxonomies:
 * - `publishedCount` reads ONLY `status = 'published' AND deleted_at IS NULL` AND respects frozen
 *   published snapshots (`published_body_json` / `published_snapshot_json`), NEVER leaking draft assignments!
 * - `draftCount` includes non-trashed `draft` items AND unpublished draft-only assignments on published items.
 * - `totalUsageCount` is the distinct count of non-trashed items referencing the taxonomy in published OR draft state.
 * - `childCount` is the direct child count in `taxonomies.parent_id`.
 */
export async function fetchTaxonomyUsageCountsBatch(
  tenantDb: D1Database,
  kind: TaxonomyKind,
  taxonomyIds: readonly number[],
): Promise<Map<number, TaxonomyUsageCounts>> {
  const map = new Map<number, TaxonomyUsageCounts>();
  if (taxonomyIds.length === 0) return map;

  const targetSet = new Set<number>(taxonomyIds);
  const publishedSets = new Map<number, Set<number>>();
  const draftSets = new Map<number, Set<number>>();
  const totalSets = new Map<number, Set<number>>();
  const childCounts = new Map<number, number>();

  for (const id of taxonomyIds) {
    publishedSets.set(id, new Set());
    draftSets.set(id, new Set());
    totalSets.set(id, new Set());
    childCounts.set(id, 0);
  }

  if (kind !== "post_tag") {
    const placeholders = taxonomyIds.map(() => "?").join(", ");
    const childRes = await tenantDb
      .prepare(
        `SELECT parent_id, COUNT(*) AS cnt
         FROM taxonomies
         WHERE parent_id IN (${placeholders})
         GROUP BY parent_id`,
      )
      .bind(...taxonomyIds)
      .all<{ readonly parent_id: number; readonly cnt: number }>();

    for (const r of childRes.results) {
      childCounts.set(Number(r.parent_id), Number(r.cnt ?? 0));
    }
  }

  if (kind === "post_category" || kind === "post_tag") {
    const [postsRes, joinsRes] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT id, status, primary_category_id, draft_body_json, published_body_json, version
           FROM posts
           WHERE deleted_at IS NULL AND status != 'trashed'`,
        )
        .all<{
          readonly id: number;
          readonly status: string;
          readonly primary_category_id: number | null;
          readonly draft_body_json: string;
          readonly published_body_json: string | null;
          readonly version: number;
        }>(),
      tenantDb
        .prepare(
          `SELECT pt.post_id, pt.taxonomy_id
           FROM post_taxonomies pt
           INNER JOIN posts p ON p.id = pt.post_id
           WHERE pt.taxonomy_id IN (${taxonomyIds.map(() => "?").join(", ")})
             AND p.deleted_at IS NULL AND p.status != 'trashed'`,
        )
        .bind(...taxonomyIds)
        .all<{ readonly post_id: number; readonly taxonomy_id: number }>(),
    ]);

    const joinTaxByPost = new Map<number, Set<number>>();
    for (const j of joinsRes.results) {
      const pid = Number(j.post_id);
      const set = joinTaxByPost.get(pid) ?? new Set<number>();
      set.add(Number(j.taxonomy_id));
      joinTaxByPost.set(pid, set);
    }

    for (const p of postsRes.results) {
      const postId = Number(p.id);
      const draftIds = extractPostSnapshotTaxonomyIds(p.draft_body_json, kind);
      const joinIds = joinTaxByPost.get(postId) ?? new Set<number>();
      if (kind === "post_category" && p.primary_category_id !== null) {
        joinIds.add(Number(p.primary_category_id));
      }

      if (p.status === "published" && p.published_body_json) {
        const pubDto = extractPublishedSnapshot("post", {
          resourceId: postId,
          status: "published",
          deletedAt: null,
          publishedJson: p.published_body_json,
          version: Number(p.version ?? 1),
        });
        const pubIds = new Set<number>();
        if (pubDto) {
          if (kind === "post_category") {
            if (pubDto.data.primaryCategoryId) pubIds.add(pubDto.data.primaryCategoryId);
            for (const cid of pubDto.data.categoryIds ?? []) pubIds.add(cid);
          } else {
            for (const tid of pubDto.data.tagIds ?? []) pubIds.add(tid);
          }
        } else {
          for (const tid of extractPostSnapshotTaxonomyIds(p.published_body_json, kind)) {
            pubIds.add(tid);
          }
        }

        for (const tid of pubIds) {
          if (targetSet.has(tid)) {
            publishedSets.get(tid)!.add(postId);
            totalSets.get(tid)!.add(postId);
          }
        }
        for (const tid of draftIds) {
          if (targetSet.has(tid) && !pubIds.has(tid)) {
            draftSets.get(tid)!.add(postId);
            totalSets.get(tid)!.add(postId);
          }
        }
      } else {
        const allDraftRefIds = new Set<number>([...draftIds, ...joinIds]);
        for (const tid of allDraftRefIds) {
          if (targetSet.has(tid)) {
            draftSets.get(tid)!.add(postId);
            totalSets.get(tid)!.add(postId);
          }
        }
      }
    }
  } else {
    const [offeringsRes, joinsRes] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT id, status, draft_snapshot_json, published_snapshot_json, version
           FROM offerings
           WHERE deleted_at IS NULL AND status != 'trashed'`,
        )
        .all<{
          readonly id: number;
          readonly status: string;
          readonly draft_snapshot_json: string | null;
          readonly published_snapshot_json: string | null;
          readonly version: number;
        }>(),
      tenantDb
        .prepare(
          `SELECT ot.offering_id, ot.taxonomy_id
           FROM offering_taxonomies ot
           INNER JOIN offerings o ON o.id = ot.offering_id
           WHERE ot.taxonomy_id IN (${taxonomyIds.map(() => "?").join(", ")})
             AND o.deleted_at IS NULL AND o.status != 'trashed'`,
        )
        .bind(...taxonomyIds)
        .all<{ readonly offering_id: number; readonly taxonomy_id: number }>(),
    ]);

    const joinTaxByOffering = new Map<number, Set<number>>();
    for (const j of joinsRes.results) {
      const oid = Number(j.offering_id);
      const set = joinTaxByOffering.get(oid) ?? new Set<number>();
      set.add(Number(j.taxonomy_id));
      joinTaxByOffering.set(oid, set);
    }

    for (const o of offeringsRes.results) {
      const offeringId = Number(o.id);
      const draftIds = extractOfferingSnapshotCategoryIds(o.draft_snapshot_json);
      const joinIds = joinTaxByOffering.get(offeringId) ?? new Set<number>();

      if (o.status === "published" && o.published_snapshot_json) {
        const pubDto = extractPublishedSnapshot("offering", {
          resourceId: offeringId,
          status: "published",
          deletedAt: null,
          publishedJson: o.published_snapshot_json,
          version: Number(o.version ?? 1),
        });
        const pubIds = new Set<number>(
          pubDto
            ? pubDto.data.categoryIds ?? []
            : [...extractOfferingSnapshotCategoryIds(o.published_snapshot_json)],
        );

        for (const tid of pubIds) {
          if (targetSet.has(tid)) {
            publishedSets.get(tid)!.add(offeringId);
            totalSets.get(tid)!.add(offeringId);
          }
        }
        const draftOnlyUnion = new Set<number>([...draftIds, ...joinIds]);
        for (const tid of draftOnlyUnion) {
          if (targetSet.has(tid) && !pubIds.has(tid)) {
            draftSets.get(tid)!.add(offeringId);
            totalSets.get(tid)!.add(offeringId);
          }
        }
      } else {
        const allDraftRefIds = new Set<number>([...draftIds, ...joinIds]);
        for (const tid of allDraftRefIds) {
          if (targetSet.has(tid)) {
            draftSets.get(tid)!.add(offeringId);
            totalSets.get(tid)!.add(offeringId);
          }
        }
      }
    }
  }

  for (const id of taxonomyIds) {
    map.set(id, {
      publishedCount: publishedSets.get(id)!.size,
      draftCount: draftSets.get(id)!.size,
      totalUsageCount: totalSets.get(id)!.size,
      childCount: childCounts.get(id) ?? 0,
    });
  }
  return map;
}

/**
 * Loads durable `indexOptIn` flags from `taxonomy_archive_settings` (`0008_taxonomy_archive_settings.sql`).
 * NEVER reads from prunable `tenant_activity_log`! Defaults to `false` (PLAN §15.2 default `noindex`).
 */
export async function fetchTaxonomyIndexOptInBatch(
  tenantDb: D1Database,
  taxonomyIds: readonly number[],
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (taxonomyIds.length === 0) return result;
  if (!(await hasTaxonomyArchiveSettingsTable(tenantDb))) {
    return result;
  }

  const placeholders = taxonomyIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT taxonomy_id, index_opt_in
       FROM taxonomy_archive_settings
       WHERE taxonomy_id IN (${placeholders})`,
    )
    .bind(...taxonomyIds)
    .all<{ readonly taxonomy_id: number; readonly index_opt_in: number }>();

  for (const row of res.results) {
    result.set(Number(row.taxonomy_id), Number(row.index_opt_in) === 1);
  }
  return result;
}

async function fetchFormerSlugsBatch(
  tenantDb: D1Database,
  kind: TaxonomyKind,
  taxonomyIds: readonly number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (taxonomyIds.length === 0) return map;
  const namespace = getTaxonomySlugNamespace(kind);
  const placeholders = taxonomyIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT resource_id, slug
       FROM resource_slugs
       WHERE namespace = ? AND is_current = 0 AND resource_id IN (${placeholders})
       ORDER BY updated_at DESC, slug ASC`,
    )
    .bind(namespace, ...taxonomyIds)
    .all<{ readonly resource_id: number; readonly slug: string }>();

  for (const r of res.results) {
    const id = Number(r.resource_id);
    const list = map.get(id) ?? [];
    list.push(String(r.slug));
    map.set(id, list);
  }
  return map;
}

function mapRowToRecord(
  row: RawTaxonomyRow,
  counts: TaxonomyUsageCounts,
  indexOptIn: boolean,
  formerSlugs: readonly string[],
): TaxonomyRecord {
  const kind = row.taxonomy_type;
  const offeringType = row.offering_type ?? null;
  const slug = String(row.slug);
  const description =
    row.description !== null && row.description !== undefined ? String(row.description) : null;
  const usefulIntro = hasUsefulTaxonomyIntro(description);

  return {
    id: Number(row.id),
    kind,
    offeringType,
    parentId: row.parent_id !== null && row.parent_id !== undefined ? Number(row.parent_id) : null,
    depth: normalizeDepthValue(row.depth),
    slug,
    publicPath: getTaxonomyPublicBasePath(kind, slug, offeringType),
    name: String(row.name),
    description,
    sortOrder: Number(row.sort_order ?? 0),
    publishedCount: counts.publishedCount,
    draftCount: counts.draftCount,
    totalUsageCount: counts.totalUsageCount,
    usageCount: counts.totalUsageCount,
    childCount: counts.childCount,
    indexOptIn,
    hasUsefulIntro: usefulIntro,
    indexable: computeTaxonomyIndexable({
      indexOptIn,
      description,
      publishedCount: counts.publishedCount,
    }),
    formerSlugs,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

export async function getTaxonomyById(
  tenantDb: D1Database,
  taxonomyId: number,
  expectedKind?: TaxonomyKind,
): Promise<TaxonomyRecord | null> {
  validatePositiveTaxonomyId(taxonomyId, "taxonomyId");
  const row = await fetchRawTaxonomy(tenantDb, taxonomyId, expectedKind);
  if (!row) return null;

  const [countsMap, optInMap, slugs] = await Promise.all([
    fetchTaxonomyUsageCountsBatch(tenantDb, row.taxonomy_type, [taxonomyId]),
    fetchTaxonomyIndexOptInBatch(tenantDb, [taxonomyId]),
    listResourceSlugsForResource(tenantDb, getTaxonomySlugNamespace(row.taxonomy_type), taxonomyId),
  ]);

  const counts = countsMap.get(taxonomyId) ?? {
    publishedCount: 0,
    draftCount: 0,
    totalUsageCount: 0,
    childCount: 0,
  };
  const indexOptIn = optInMap.get(taxonomyId) ?? false;
  const formerSlugs = slugs.filter((s) => !s.isCurrent).map((s) => s.slug);

  return mapRowToRecord(row, counts, indexOptIn, formerSlugs);
}

export async function listTaxonomies(
  tenantDb: D1Database,
  options: ListTaxonomiesOptions,
): Promise<ListTaxonomiesResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const sortOrder = options.sortOrder === "desc" ? "desc" : "asc";
  const conditions: string[] = ["taxonomy_type = ?"];
  const binds: unknown[] = [options.kind];

  if (options.kind === "offering_category" && options.offeringType) {
    conditions.push("(offering_type = ? OR offering_type IS NULL)");
    binds.push(options.offeringType);
  }

  if (options.parentId !== undefined) {
    if (options.parentId === null) {
      conditions.push("parent_id IS NULL");
    } else {
      validatePositiveTaxonomyId(options.parentId, "parentId");
      conditions.push("parent_id = ?");
      binds.push(options.parentId);
    }
  }

  if (options.search !== undefined && options.search.trim() !== "") {
    const q = `%${options.search.trim().toLowerCase()}%`;
    conditions.push("(LOWER(name) LIKE ? OR LOWER(slug) LIKE ?)");
    binds.push(q, q);
  }

  if (options.cursor !== undefined && options.cursor.trim() !== "") {
    if (!/^\d+$/.test(options.cursor.trim())) {
      throw new TaxonomyDomainError(422, "VALIDATION_ERROR", "Cursor paginasi tidak valid.", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Cursor must be a numeric ID." },
      ]);
    }
    const cursorId = Number(options.cursor.trim());
    conditions.push(sortOrder === "asc" ? "id > ?" : "id < ?");
    binds.push(cursorId);
  }

  const orderSql =
    options.cursor !== undefined && options.cursor.trim() !== ""
      ? sortOrder === "asc"
        ? "ORDER BY id ASC"
        : "ORDER BY id DESC"
      : sortOrder === "asc"
        ? "ORDER BY sort_order ASC, id ASC"
        : "ORDER BY id DESC";

  const res = await tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, parent_id, depth, slug, name, description,
              sort_order, version, created_at, updated_at
       FROM taxonomies
       WHERE ${conditions.join(" AND ")}
       ${orderSql}
       LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RawTaxonomyRow>();

  const hasMore = res.results.length > limit;
  const rows = hasMore ? res.results.slice(0, limit) : res.results;
  const ids = rows.map((r) => Number(r.id));

  const [countsMap, optInMap, formerSlugsMap] = await Promise.all([
    fetchTaxonomyUsageCountsBatch(tenantDb, options.kind, ids),
    fetchTaxonomyIndexOptInBatch(tenantDb, ids),
    fetchFormerSlugsBatch(tenantDb, options.kind, ids),
  ]);

  const items = rows.map((row) =>
    mapRowToRecord(
      row,
      countsMap.get(Number(row.id)) ?? {
        publishedCount: 0,
        draftCount: 0,
        totalUsageCount: 0,
        childCount: 0,
      },
      optInMap.get(Number(row.id)) ?? false,
      formerSlugsMap.get(Number(row.id)) ?? [],
    ),
  );

  const nextCursor = hasMore && items.length > 0 ? String(items[items.length - 1]!.id) : null;

  return {
    items,
    page: {
      nextCursor,
      limit,
      hasMore,
    },
  };
}

export async function resolveTaxonomyByPublicSlug(
  tenantDb: D1Database,
  params: {
    readonly kind: TaxonomyKind;
    readonly slug: string;
    readonly offeringType?: CatalogOfferingType;
  },
): Promise<
  | { readonly kind: "not_found" }
  | { readonly kind: "former_slug_redirect"; readonly targetSlug: string; readonly taxonomy: TaxonomyRecord }
  | { readonly kind: "found"; readonly taxonomy: TaxonomyRecord }
> {
  const namespace = getTaxonomySlugNamespace(params.kind);
  const slugRow = await findResourceSlug(tenantDb, namespace, params.slug);

  if (slugRow && !slugRow.isCurrent) {
    const target = await getTaxonomyById(tenantDb, slugRow.resourceId, params.kind);
    if (!target) return { kind: "not_found" };
    if (
      params.kind === "offering_category" &&
      params.offeringType &&
      target.offeringType !== null &&
      target.offeringType !== params.offeringType
    ) {
      return { kind: "not_found" };
    }
    return {
      kind: "former_slug_redirect",
      targetSlug: target.slug,
      taxonomy: target,
    };
  }

  const row = await tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, parent_id, depth, slug, name, description,
              sort_order, version, created_at, updated_at
       FROM taxonomies
       WHERE taxonomy_type = ? AND slug = ?
       LIMIT 1`,
    )
    .bind(params.kind, params.slug)
    .first<RawTaxonomyRow>();

  if (!row) return { kind: "not_found" };
  if (
    params.kind === "offering_category" &&
    params.offeringType &&
    row.offering_type !== null &&
    row.offering_type !== params.offeringType
  ) {
    return { kind: "not_found" };
  }

  const tax = await getTaxonomyById(tenantDb, Number(row.id), params.kind);
  if (!tax) return { kind: "not_found" };
  return { kind: "found", taxonomy: tax };
}

/**
 * Creates a scoped taxonomy (`post_category`, `post_tag`, or `offering_category`)
 * with atomic in-SQL parent/depth guard (zero FK 503 / zero depth > 3 race) +
 * durable `taxonomy_archive_settings` + `resource_slugs` + `tenant_activity_log`.
 */
export async function createTaxonomy(
  tenantDb: D1Database,
  input: CreateTaxonomyInput,
  audit: TaxonomyAuditContext = {},
): Promise<TaxonomyRecord> {
  assertNoForbiddenTenantSelectors(input);
  const nowMs = input.nowMs ?? Date.now();
  const kind = input.kind;
  const namespace = getTaxonomySlugNamespace(kind);

  const cleanName = validateTaxonomyName(input.name);
  const cleanDesc = validateTaxonomyDescription(input.description);
  const sortOrder = validateTaxonomySortOrder(input.sortOrder);
  const offeringType = validateTaxonomyOfferingType(kind, input.offeringType);
  const indexOptIn = input.indexOptIn === true;

  let parentId: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (kind === "post_tag") {
      throw new TaxonomyDomainError(
        422,
        "INVALID_PARENT",
        "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
        [{ field: "parentId", code: "INVALID_PARENT", message: "Tags cannot have a parent." }],
      );
    }
    parentId = validatePositiveTaxonomyId(input.parentId, "parentId");
  }

  const [allSameKind, hasArchiveSettings] = await Promise.all([
    kind === "post_tag" ? Promise.resolve([]) : fetchAllSameKindNodes(tenantDb, kind),
    hasTaxonomyArchiveSettingsTable(tenantDb),
  ]);
  const hierarchy = validateTaxonomyHierarchy({
    kind,
    offeringType,
    parentId,
    allSameKindNodes: allSameKind,
  });

  const manualSlug =
    input.slug !== undefined && input.slug.trim() !== ""
      ? validateManualSlug(input.slug, { namespace })
      : null;

  if (manualSlug !== null && (await isTaxonomySlugTaken(tenantDb, kind, manualSlug))) {
    const suggested = await suggestAlternativeSlug(
      manualSlug,
      (candidate) => isTaxonomySlugTaken(tenantDb, kind, candidate),
      { namespace },
    );
    throw new SlugValidationError(
      "SLUG_CONFLICT",
      `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
      { field: "slug", suggestedSlug: suggested },
    );
  }

  const taxonomyId = await allocateNextSequenceId(tenantDb, "category");
  const auditMetadata = JSON.stringify({
    kind,
    offeringType,
    parentId,
    depth: hierarchy.depth,
    indexOptIn,
  });
  const actorUserId = audit.actorUserId ?? null;
  const actorRole = audit.actorRole ?? "editor";

  const diagnoseFailedParentInsert = async (): Promise<never> => {
    const liveNodes = await fetchAllSameKindNodes(tenantDb, kind);
    // Re-run pure validator on live DB state to produce exact 422 INVALID_PARENT or 422 TAXONOMY_CYCLE_OR_DEPTH
    validateTaxonomyHierarchy({
      kind,
      offeringType,
      parentId,
      allSameKindNodes: liveNodes,
    });
    throw new TaxonomyDomainError(
      409,
      "STALE_VERSION",
      "Struktur hierarki kategori berubah secara bersamaan; muat ulang dan coba lagi.",
      [{ field: "parentId", code: "STALE_VERSION", message: "Concurrent parent hierarchy change." }],
    );
  };

  const insertWithSlug = async (slugCandidate: string): Promise<void> => {
    const insertTaxStmt =
      parentId === null
        ? tenantDb
            .prepare(
              `INSERT INTO taxonomies (
                 id, taxonomy_type, offering_type, parent_id, depth,
                 slug, name, description, sort_order,
                 version, created_at, updated_at
               ) VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .bind(
              taxonomyId,
              kind,
              offeringType,
              slugCandidate,
              cleanName,
              cleanDesc,
              sortOrder,
              nowMs,
              nowMs,
            )
        : tenantDb
            .prepare(
              `INSERT INTO taxonomies (
                 id, taxonomy_type, offering_type, parent_id, depth,
                 slug, name, description, sort_order,
                 version, created_at, updated_at
               )
               SELECT ?, ?, ?, ?,
                      (
                        WITH RECURSIVE anc(id, parent_id, lvl) AS (
                          SELECT id, parent_id, 1
                          FROM taxonomies
                          WHERE id = ? AND taxonomy_type = ?
                            AND (? IS NULL OR offering_type IS NULL OR offering_type = ?)
                          UNION ALL
                          SELECT t.id, t.parent_id, a.lvl + 1
                          FROM taxonomies t
                          JOIN anc a ON t.id = a.parent_id
                          WHERE a.lvl < 10
                        )
                        SELECT MAX(lvl) + 1 FROM anc
                      ),
                      ?, ?, ?, ?, 1, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM taxonomies
                 WHERE id = ? AND taxonomy_type = ?
                   AND (? IS NULL OR offering_type IS NULL OR offering_type = ?)
               )
               AND (
                 WITH RECURSIVE anc(id, parent_id, lvl) AS (
                   SELECT id, parent_id, 1
                   FROM taxonomies
                   WHERE id = ? AND taxonomy_type = ?
                   UNION ALL
                   SELECT t.id, t.parent_id, a.lvl + 1
                   FROM taxonomies t
                   JOIN anc a ON t.id = a.parent_id
                   WHERE a.lvl < 10
                 )
                 SELECT MAX(lvl) + 1 FROM anc
               ) <= ?`,
            )
            .bind(
              taxonomyId,
              kind,
              offeringType,
              parentId,
              parentId,
              kind,
              offeringType,
              offeringType,
              slugCandidate,
              cleanName,
              cleanDesc,
              sortOrder,
              nowMs,
              nowMs,
              parentId,
              kind,
              offeringType,
              offeringType,
              parentId,
              kind,
              MAX_TAXONOMY_DEPTH,
            );

    const insertedGuardSql =
      "EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = ? AND slug = ? AND version = 1)";
    const insertedGuardBinds = [taxonomyId, kind, slugCandidate] as const;

    const batchStmts: D1PreparedStatement[] = [
      insertTaxStmt,
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'taxonomy.created', 'taxonomy', ?, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          actorUserId,
          actorRole,
          String(taxonomyId),
          `Membuat taksonomi ${kind} "${cleanName}" (${slugCandidate})`,
          auditMetadata,
          nowMs,
        ),
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           SELECT ?, ?, ?, 1, NULL, ?
           WHERE ${insertedGuardSql}`,
        )
        .bind(namespace, slugCandidate, taxonomyId, nowMs, ...insertedGuardBinds),
    ];

    if (hasArchiveSettings) {
      batchStmts.push(
        tenantDb
          .prepare(
            `INSERT INTO taxonomy_archive_settings (taxonomy_id, index_opt_in, updated_at)
             SELECT ?, ?, ?
             WHERE ${insertedGuardSql}
             ON CONFLICT (taxonomy_id) DO UPDATE
             SET index_opt_in = excluded.index_opt_in,
                 updated_at = excluded.updated_at`,
          )
          .bind(taxonomyId, indexOptIn ? 1 : 0, nowMs, ...insertedGuardBinds),
      );
    }

    let results: D1Result[];
    try {
      results = await tenantDb.batch(batchStmts);
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        await diagnoseFailedParentInsert();
      }
      throw err;
    }

    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      await diagnoseFailedParentInsert();
    }
  };

  if (manualSlug !== null) {
    try {
      await insertWithSlug(manualSlug);
    } catch (err) {
      if (isSlugUniqueConstraintError(err)) {
        const suggested = await suggestAlternativeSlug(
          manualSlug,
          (candidate) => isTaxonomySlugTaken(tenantDb, kind, candidate),
          { namespace },
        );
        throw new SlugValidationError(
          "SLUG_CONFLICT",
          `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
          { field: "slug", suggestedSlug: suggested },
        );
      }
      throw err;
    }
  } else {
    const baseSlug = normalizeTitleToSlug(cleanName, {
      fallbackPrefix: getTaxonomyFallbackPrefix(kind),
      fallbackId: taxonomyId,
    });
    let inserted = false;
    for (let attempt = 1; attempt <= 1000; attempt += 1) {
      const candidate = attempt === 1 ? baseSlug : buildSuffixedSlug(baseSlug, attempt);
      if (isReservedSlug(candidate, namespace)) continue;
      try {
        await insertWithSlug(candidate);
        inserted = true;
        break;
      } catch (err) {
        if (isSlugUniqueConstraintError(err)) continue;
        throw err;
      }
    }
    if (!inserted) {
      throw new SlugValidationError(
        "SLUG_CONFLICT",
        `Tidak dapat menghasilkan slug unik dari "${baseSlug}".`,
        { field: "slug" },
      );
    }
  }

  const created = await getTaxonomyById(tenantDb, taxonomyId, kind);
  if (!created) {
    throw new Error(`Failed to reload newly created taxonomy ${kind}#${taxonomyId}`);
  }
  return created;
}

/**
 * Updates a taxonomy atomically with required `expectedVersion`, atomic in-SQL `WITH RECURSIVE`
 * cycle/depth/parent verification (zero concurrent cycles, zero depth > 3 drift, zero FK 503),
 * durable `taxonomy_archive_settings` upsert, former-slug 308 preservation, live descendant depth
 * recomputation, and `WHERE changes() = 1` guarded `tenant_activity_log`.
 */
export async function updateTaxonomy(
  tenantDb: D1Database,
  input: UpdateTaxonomyInput,
  audit: TaxonomyAuditContext = {},
): Promise<TaxonomyRecord> {
  assertNoForbiddenTenantSelectors(input);
  validatePositiveTaxonomyId(input.taxonomyId, "taxonomyId");
  assertValidExpectedVersion(input.expectedVersion);

  const [row, hasArchiveSettings] = await Promise.all([
    fetchRawTaxonomy(tenantDb, input.taxonomyId, input.kind),
    hasTaxonomyArchiveSettingsTable(tenantDb),
  ]);
  if (!row) {
    throw new TaxonomyNotFoundError(input.taxonomyId, input.kind);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new TaxonomyStaleVersionError({
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const kind = row.taxonomy_type;
  const namespace = getTaxonomySlugNamespace(kind);
  const nextName = input.name !== undefined ? validateTaxonomyName(input.name) : String(row.name);
  const nextDesc =
    input.description !== undefined ? validateTaxonomyDescription(input.description) : row.description;
  const nextSortOrder =
    input.sortOrder !== undefined
      ? validateTaxonomySortOrder(input.sortOrder)
      : Number(row.sort_order ?? 0);
  const nextSlug =
    input.slug !== undefined ? validateManualSlug(input.slug, { namespace }) : String(row.slug);
  const nextOfferingType =
    input.offeringType !== undefined
      ? validateTaxonomyOfferingType(kind, input.offeringType)
      : row.offering_type ?? null;

  if (kind === "offering_category" && nextOfferingType !== (row.offering_type ?? null)) {
    const [countsMap, childRow] = await Promise.all([
      fetchTaxonomyUsageCountsBatch(tenantDb, kind, [input.taxonomyId]),
      tenantDb
        .prepare(`SELECT id FROM taxonomies WHERE parent_id = ? LIMIT 1`)
        .bind(input.taxonomyId)
        .first<{ readonly id: number }>(),
    ]);
    const usage = countsMap.get(input.taxonomyId)?.totalUsageCount ?? 0;
    if (usage > 0 || childRow) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_OFFERING_TYPE",
        `Tipe penawaran kategori #${input.taxonomyId} tidak dapat diubah saat masih memiliki penawaran atau sub-kategori.`,
        [
          {
            field: "offeringType",
            code: "CATEGORY_IN_USE",
            message: "Cannot change offeringType while offerings or child categories exist.",
          },
        ],
      );
    }
  }

  const currentParentId = row.parent_id !== null ? Number(row.parent_id) : null;
  let nextParentId = currentParentId;

  if (input.parentId !== undefined) {
    if (kind === "post_tag") {
      if (input.parentId !== null) {
        throw new TaxonomyDomainError(
          422,
          "INVALID_PARENT",
          "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
          [{ field: "parentId", code: "INVALID_PARENT", message: "Tags cannot have a parent." }],
        );
      }
      nextParentId = null;
    } else if (input.parentId === null) {
      nextParentId = null;
    } else {
      nextParentId = validatePositiveTaxonomyId(input.parentId, "parentId");
    }
  }

  const allSameKind = kind === "post_tag" ? [] : await fetchAllSameKindNodes(tenantDb, kind);
  const hierarchy = validateTaxonomyHierarchy({
    kind,
    offeringType: nextOfferingType,
    parentId: nextParentId,
    selfId: input.taxonomyId,
    allSameKindNodes: allSameKind,
  });

  const existingOptInMap = await fetchTaxonomyIndexOptInBatch(tenantDb, [input.taxonomyId]);
  const nextIndexOptIn =
    input.indexOptIn !== undefined ? input.indexOptIn : (existingOptInMap.get(input.taxonomyId) ?? false);

  const nowMs = input.nowMs ?? Date.now();
  const nextVersion = input.expectedVersion + 1;
  const slugChanged = nextSlug !== String(row.slug);

  const countsMap = await fetchTaxonomyUsageCountsBatch(tenantDb, kind, [input.taxonomyId]);
  const publishedCount = countsMap.get(input.taxonomyId)?.publishedCount ?? 0;

  const atomicGuard = {
    sql: "EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = ? AND version = ? AND slug = ? AND name = ? AND updated_at = ?)",
    binds: [input.taxonomyId, kind, nextVersion, nextSlug, nextName, nowMs] as const,
  };

  const slugTransition = slugChanged
    ? await buildFormerSlugTransitionStatements(tenantDb, {
        namespace,
        resourceId: input.taxonomyId,
        oldSlug: String(row.slug),
        newSlug: nextSlug,
        wasEverPublished: publishedCount > 0,
        confirmSlugChange: input.confirmSlugChange ?? true,
        allowSelfRevert: false,
        nowMs,
        guard: atomicGuard,
      })
    : null;

  // Build atomic Statement 0 with live in-SQL parent/cycle/depth checks when hierarchical with parentId != null
  let updateStmt: D1PreparedStatement;
  if (kind !== "post_tag" && nextParentId !== null) {
    updateStmt = tenantDb
      .prepare(
        `UPDATE taxonomies
         SET offering_type = ?,
             name = ?,
             slug = ?,
             description = ?,
             parent_id = ?,
             depth = (
               WITH RECURSIVE anc(id, parent_id, lvl) AS (
                 SELECT id, parent_id, 1
                 FROM taxonomies
                 WHERE id = ? AND taxonomy_type = ?
                 UNION ALL
                 SELECT t.id, t.parent_id, a.lvl + 1
                 FROM taxonomies t
                 JOIN anc a ON t.id = a.parent_id
                 WHERE a.lvl < 10
               )
               SELECT MAX(lvl) + 1 FROM anc
             ),
             sort_order = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND taxonomy_type = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM taxonomies p
             WHERE p.id = ? AND p.taxonomy_type = ?
               AND (? IS NULL OR p.offering_type IS NULL OR p.offering_type = ?)
           )
           AND NOT EXISTS (
             WITH RECURSIVE anc(id, parent_id, lvl) AS (
               SELECT id, parent_id, 1
               FROM taxonomies
               WHERE id = ? AND taxonomy_type = ?
               UNION ALL
               SELECT t.id, t.parent_id, a.lvl + 1
               FROM taxonomies t
               JOIN anc a ON t.id = a.parent_id
               WHERE a.lvl < 10
             )
             SELECT 1 FROM anc WHERE id = ?
           )
           AND (
             WITH RECURSIVE anc(id, parent_id, lvl) AS (
               SELECT id, parent_id, 1
               FROM taxonomies
               WHERE id = ? AND taxonomy_type = ?
               UNION ALL
               SELECT t.id, t.parent_id, a.lvl + 1
               FROM taxonomies t
               JOIN anc a ON t.id = a.parent_id
               WHERE a.lvl < 10
             ),
             sub(id, h) AS (
               SELECT id, 0 FROM taxonomies WHERE id = ?
               UNION ALL
               SELECT t.id, s.h + 1
               FROM taxonomies t
               JOIN sub s ON t.parent_id = s.id
               WHERE s.h < 10
             )
             SELECT COALESCE((SELECT MAX(lvl) + 1 FROM anc), 1) + COALESCE((SELECT MAX(h) FROM sub), 0)
           ) <= ?`,
      )
      .bind(
        nextOfferingType,
        nextName,
        nextSlug,
        nextDesc,
        nextParentId,
        nextParentId,
        kind,
        nextSortOrder,
        nowMs,
        input.taxonomyId,
        kind,
        input.expectedVersion,
        nextParentId,
        kind,
        nextOfferingType,
        nextOfferingType,
        nextParentId,
        kind,
        input.taxonomyId,
        nextParentId,
        kind,
        input.taxonomyId,
        MAX_TAXONOMY_DEPTH,
      );
  } else {
    updateStmt = tenantDb
      .prepare(
        `UPDATE taxonomies
         SET offering_type = ?,
             name = ?,
             slug = ?,
             description = ?,
             parent_id = NULL,
             depth = 1,
             sort_order = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND taxonomy_type = ? AND version = ?`,
      )
      .bind(
        nextOfferingType,
        nextName,
        nextSlug,
        nextDesc,
        nextSortOrder,
        nowMs,
        input.taxonomyId,
        kind,
        input.expectedVersion,
      );
  }

  const auditMetadata = JSON.stringify({
    kind,
    offeringType: nextOfferingType,
    parentId: nextParentId,
    depth: hierarchy.depth,
    slugChanged,
    previousSlug: slugChanged ? String(row.slug) : undefined,
    indexOptIn: nextIndexOptIn,
  });

  // Statement 1 immediately after updateStmt uses `WHERE changes() = 1` so losing writes insert ZERO audit rows!
  const auditStmt = tenantDb
    .prepare(
      `INSERT INTO tenant_activity_log (
         actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
       )
       SELECT ?, ?, 'taxonomy.updated', 'taxonomy', ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      audit.actorUserId ?? null,
      audit.actorRole ?? "editor",
      String(input.taxonomyId),
      `Memperbarui taksonomi ${kind} "${nextName}" (${nextSlug})`,
      auditMetadata,
      nowMs,
    );

  // Recompute live depths of direct children & grandchildren atomically from the updated node's actual depth
  const descendantStmts: D1PreparedStatement[] = [];
  if (kind !== "post_tag") {
    descendantStmts.push(
      tenantDb
        .prepare(
          `UPDATE taxonomies
           SET depth = MIN(?, (SELECT depth + 1 FROM taxonomies WHERE id = ?)),
               updated_at = ?
           WHERE parent_id = ? AND taxonomy_type = ? AND ${atomicGuard.sql}`,
        )
        .bind(MAX_TAXONOMY_DEPTH, input.taxonomyId, nowMs, input.taxonomyId, kind, ...atomicGuard.binds),
      tenantDb
        .prepare(
          `UPDATE taxonomies
           SET depth = MIN(?, (SELECT depth + 2 FROM taxonomies WHERE id = ?)),
               updated_at = ?
           WHERE parent_id IN (SELECT id FROM taxonomies WHERE parent_id = ?)
             AND taxonomy_type = ? AND ${atomicGuard.sql}`,
        )
        .bind(MAX_TAXONOMY_DEPTH, input.taxonomyId, nowMs, input.taxonomyId, kind, ...atomicGuard.binds),
    );
  }

  const archiveSettingStmts: D1PreparedStatement[] = hasArchiveSettings
    ? [
        tenantDb
          .prepare(
            `INSERT INTO taxonomy_archive_settings (taxonomy_id, index_opt_in, updated_at)
             SELECT ?, ?, ?
             WHERE ${atomicGuard.sql}
             ON CONFLICT (taxonomy_id) DO UPDATE
             SET index_opt_in = excluded.index_opt_in,
                 updated_at = excluded.updated_at`,
          )
          .bind(input.taxonomyId, nextIndexOptIn ? 1 : 0, nowMs, ...atomicGuard.binds),
      ]
    : [];

  const batchStmts: D1PreparedStatement[] = [
    updateStmt,
    auditStmt,
    ...archiveSettingStmts,
    ...(slugTransition ? slugTransition.statements : []),
    ...descendantStmts,
  ];

  const diagnoseFailedUpdate = async (): Promise<never> => {
    const latest = await fetchRawTaxonomy(tenantDb, input.taxonomyId, kind);
    if (!latest) {
      throw new TaxonomyNotFoundError(input.taxonomyId, kind);
    }
    if (Number(latest.version) !== input.expectedVersion) {
      throw new TaxonomyStaleVersionError({
        taxonomyId: input.taxonomyId,
        expectedVersion: input.expectedVersion,
        actualVersion: Number(latest.version),
      });
    }
    if (kind !== "post_tag" && nextParentId !== null) {
      const liveNodes = await fetchAllSameKindNodes(tenantDb, kind);
      validateTaxonomyHierarchy({
        kind,
        offeringType: nextOfferingType,
        parentId: nextParentId,
        selfId: input.taxonomyId,
        allSameKindNodes: liveNodes,
      });
    }
    throw new TaxonomyStaleVersionError({
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  };

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      await diagnoseFailedUpdate();
    }
    if (isUniqueConstraintError(err)) {
      const latest = await fetchRawTaxonomy(tenantDb, input.taxonomyId, kind);
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new TaxonomyStaleVersionError({
          taxonomyId: input.taxonomyId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const suggested = await suggestAlternativeSlug(
        nextSlug,
        (candidate) => isTaxonomySlugTaken(tenantDb, kind, candidate, input.taxonomyId),
        { namespace },
      );
      throw new SlugValidationError(
        "SLUG_CONFLICT",
        `Slug "${nextSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
        { field: "slug", suggestedSlug: suggested },
      );
    }
    throw err;
  }

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    await diagnoseFailedUpdate();
  }

  if (publishedCount > 0 && audit.platformDb && audit.tenantId) {
    try {
      await bumpTenantCacheVersion(audit.platformDb, audit.tenantId, nowMs);
    } catch {
      // Metadata already persisted; cache version bump is best-effort on live metadata edits
    }
  }

  const updated = await getTaxonomyById(tenantDb, input.taxonomyId, kind);
  if (!updated) {
    throw new Error(`Failed to reload updated taxonomy ${kind}#${input.taxonomyId}`);
  }
  return updated;
}

function rewritePostEnvelopeTaxonomyId(
  rawJson: string | null | undefined,
  kind: "post_category" | "post_tag",
  removedId: number,
  reassignToId: number | null,
): string | null {
  if (!rawJson) return null;
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  const target =
    clone.data && typeof clone.data === "object" && !Array.isArray(clone.data)
      ? (clone.data as Record<string, unknown>)
      : clone;

  let changed = false;

  if (kind === "post_category") {
    if (target.primaryCategoryId === removedId) {
      target.primaryCategoryId = reassignToId;
      changed = true;
    }
    if (Array.isArray(target.categoryIds)) {
      const nextIds: number[] = [];
      let arrChanged = false;
      for (const rawId of target.categoryIds) {
        if (rawId === removedId) {
          arrChanged = true;
          if (reassignToId !== null && !nextIds.includes(reassignToId)) {
            nextIds.push(reassignToId);
          }
        } else if (typeof rawId === "number" && !nextIds.includes(rawId)) {
          nextIds.push(rawId);
        }
      }
      if (
        reassignToId !== null &&
        target.primaryCategoryId === reassignToId &&
        !nextIds.includes(reassignToId)
      ) {
        nextIds.push(reassignToId);
        arrChanged = true;
      }
      if (arrChanged) {
        target.categoryIds = nextIds;
        changed = true;
      }
    }
  } else {
    if (Array.isArray(target.tagIds)) {
      const nextIds: number[] = [];
      let arrChanged = false;
      for (const rawId of target.tagIds) {
        if (rawId === removedId) {
          arrChanged = true;
          if (reassignToId !== null && !nextIds.includes(reassignToId)) {
            nextIds.push(reassignToId);
          }
        } else if (typeof rawId === "number" && !nextIds.includes(rawId)) {
          nextIds.push(rawId);
        }
      }
      if (arrChanged) {
        target.tagIds = nextIds;
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(clone) : null;
}

function rewriteOfferingEnvelopeCategoryId(
  rawJson: string | null | undefined,
  removedId: number,
  reassignToId: number | null,
): string | null {
  if (!rawJson) return null;
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  const target =
    clone.data && typeof clone.data === "object" && !Array.isArray(clone.data)
      ? (clone.data as Record<string, unknown>)
      : clone;

  if (!Array.isArray(target.categoryIds)) return null;

  const nextIds: number[] = [];
  let changed = false;
  for (const rawId of target.categoryIds) {
    if (rawId === removedId) {
      changed = true;
      if (reassignToId !== null && !nextIds.includes(reassignToId)) {
        nextIds.push(reassignToId);
      }
    } else if (typeof rawId === "number" && !nextIds.includes(rawId)) {
      nextIds.push(rawId);
    }
  }

  if (!changed) return null;
  target.categoryIds = nextIds;
  return JSON.stringify(clone);
}

/**
 * Deletes a taxonomy atomically inside ONE sentinel-locked `tenantDb.batch([...])`:
 * - Requires `expectedVersion` (`409 STALE_VERSION` on mismatch with ZERO side effects).
 * - Rejects `childCount > 0` with `409 CATEGORY_HAS_CHILDREN` (never deletes children).
 * - Rejects `totalUsageCount > 0` without `detach: true` or `reassignToId` with `409 TAXONOMY_IN_USE`,
 *   AND enforces in-SQL `NOT EXISTS` usage predicates inside Statement 0 so an interleaved assignment
 *   cannot slip past the pre-read check!
 * - Guards every rewritten post/offering with its exact pre-read `version` inside BOTH Statement 0
 *   and the row `UPDATE` (bumping `version = version + 1` and `updated_at = ?`), so a concurrent
 *   edit/publish/unpublish fails cleanly with `409 STALE_VERSION` and ZERO overwritten content!
 * - Prevents mixed `offering_type` reassignment when reassigning an untyped (`offering_type IS NULL`)
 *   catalog category into a typed (`offering_type IS NOT NULL`) category (`422 INVALID_REASSIGN_TARGET`).
 */
export async function deleteTaxonomy(
  tenantDb: D1Database,
  input: DeleteTaxonomyInput,
  audit: TaxonomyAuditContext = {},
): Promise<{
  readonly deletedId: number;
  readonly kind: TaxonomyKind;
  readonly reassignedToId: number | null;
  readonly detached: boolean;
  readonly affectedPublishedCount: number;
}> {
  validatePositiveTaxonomyId(input.taxonomyId, "taxonomyId");
  assertValidExpectedVersion(input.expectedVersion);

  const [row, hasArchiveSettings] = await Promise.all([
    fetchRawTaxonomy(tenantDb, input.taxonomyId, input.kind),
    hasTaxonomyArchiveSettingsTable(tenantDb),
  ]);
  if (!row) {
    throw new TaxonomyNotFoundError(input.taxonomyId, input.kind);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new TaxonomyStaleVersionError({
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const kind = row.taxonomy_type;
  const namespace = getTaxonomySlugNamespace(kind);
  const nowMs = input.nowMs ?? Date.now();

  let reassignTargetId: number | null = null;
  let reassignTargetOfferingType: CatalogOfferingType | null = null;
  if (input.reassignToId !== undefined) {
    validatePositiveTaxonomyId(input.reassignToId, "reassignToId");
    if (input.reassignToId === input.taxonomyId) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_REASSIGN_TARGET",
        "Target pengalihan tidak boleh sama dengan taksonomi yang dihapus.",
        [
          {
            field: "reassignToId",
            code: "INVALID_REASSIGN_TARGET",
            message: "reassignToId cannot equal taxonomyId.",
          },
        ],
      );
    }
    const targetRow = await fetchRawTaxonomy(tenantDb, input.reassignToId, kind);
    if (!targetRow) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_REASSIGN_TARGET",
        `Taksonomi pengganti #${input.reassignToId} tidak ditemukan dengan tipe yang sama di tenant ini.`,
        [
          {
            field: "reassignToId",
            code: "INVALID_REASSIGN_TARGET",
            message: `Reassign target #${input.reassignToId} not found for kind ${kind}.`,
          },
        ],
      );
    }
    if (
      kind === "offering_category" &&
      row.offering_type !== null &&
      targetRow.offering_type !== null &&
      row.offering_type !== targetRow.offering_type
    ) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_REASSIGN_TARGET",
        `Kategori pengganti #${input.reassignToId} memiliki tipe penawaran "${targetRow.offering_type}", tidak cocok dengan "${row.offering_type}".`,
        [
          {
            field: "reassignToId",
            code: "INVALID_REASSIGN_TARGET",
            message: `Reassign target offeringType "${targetRow.offering_type}" does not match "${row.offering_type}".`,
          },
        ],
      );
    }
    reassignTargetId = Number(targetRow.id);
    reassignTargetOfferingType = targetRow.offering_type ?? null;
  }

  const countsMap = await fetchTaxonomyUsageCountsBatch(tenantDb, kind, [input.taxonomyId]);
  const counts = countsMap.get(input.taxonomyId) ?? {
    publishedCount: 0,
    draftCount: 0,
    totalUsageCount: 0,
    childCount: 0,
  };

  const allowUsageRewrite = input.detach === true || reassignTargetId !== null;
  assertSafeTaxonomyDelete(input.taxonomyId, {
    ...counts,
    detach: input.detach === true,
    reassignToId: reassignTargetId,
  });

  // Pre-collect affected posts/offerings and their exact optimistic versions ONLY when rewriting references
  interface PostRewritePlan {
    readonly id: number;
    readonly version: number;
    readonly nextDraft: string | null;
    readonly nextPublished: string | null;
    readonly touchesPrimary: boolean;
  }
  interface OfferingRewritePlan {
    readonly id: number;
    readonly version: number;
    readonly offeringType: CatalogOfferingType;
    readonly nextDraft: string | null;
    readonly nextPublished: string | null;
  }

  const postRewrites: PostRewritePlan[] = [];
  const offeringRewrites: OfferingRewritePlan[] = [];
  const idTokenPattern = `%${input.taxonomyId}%`;

  if (allowUsageRewrite && counts.totalUsageCount > 0) {
    if (kind === "post_category" || kind === "post_tag") {
      const candidatePosts = await tenantDb
        .prepare(
          `SELECT id, version, primary_category_id, draft_body_json, published_body_json
           FROM posts
           WHERE primary_category_id = ?
              OR id IN (SELECT post_id FROM post_taxonomies WHERE taxonomy_id = ?)
              OR draft_body_json LIKE ?
              OR published_body_json LIKE ?`,
        )
        .bind(input.taxonomyId, input.taxonomyId, idTokenPattern, idTokenPattern)
        .all<{
          readonly id: number;
          readonly version: number;
          readonly primary_category_id: number | null;
          readonly draft_body_json: string;
          readonly published_body_json: string | null;
        }>();

      for (const p of candidatePosts.results) {
        const nextDraft = rewritePostEnvelopeTaxonomyId(
          p.draft_body_json,
          kind,
          input.taxonomyId,
          reassignTargetId,
        );
        const nextPublished = rewritePostEnvelopeTaxonomyId(
          p.published_body_json,
          kind,
          input.taxonomyId,
          reassignTargetId,
        );
        const touchesPrimary =
          kind === "post_category" &&
          p.primary_category_id !== null &&
          Number(p.primary_category_id) === input.taxonomyId;

        if (nextDraft !== null || nextPublished !== null || touchesPrimary) {
          postRewrites.push({
            id: Number(p.id),
            version: Number(p.version),
            nextDraft,
            nextPublished,
            touchesPrimary,
          });
        }
      }
    } else {
      const candidateOfferings = await tenantDb
        .prepare(
          `SELECT id, offering_type, status, deleted_at, version, draft_snapshot_json, published_snapshot_json
           FROM offerings
           WHERE id IN (SELECT offering_id FROM offering_taxonomies WHERE taxonomy_id = ?)
              OR draft_snapshot_json LIKE ?
              OR published_snapshot_json LIKE ?`,
        )
        .bind(input.taxonomyId, idTokenPattern, idTokenPattern)
        .all<{
          readonly id: number;
          readonly offering_type: CatalogOfferingType;
          readonly status: string;
          readonly deleted_at: number | null;
          readonly version: number;
          readonly draft_snapshot_json: string | null;
          readonly published_snapshot_json: string | null;
        }>();

      for (const o of candidateOfferings.results) {
        const nextDraft = rewriteOfferingEnvelopeCategoryId(
          o.draft_snapshot_json,
          input.taxonomyId,
          reassignTargetId,
        );
        const nextPublished = rewriteOfferingEnvelopeCategoryId(
          o.published_snapshot_json,
          input.taxonomyId,
          reassignTargetId,
        );
        const isActiveNonTrashed = o.deleted_at === null && o.status !== "trashed";

        // Prevent reassigning offerings of a different offering_type into a typed target category!
        if (
          reassignTargetId !== null &&
          reassignTargetOfferingType !== null &&
          isActiveNonTrashed &&
          o.offering_type !== reassignTargetOfferingType
        ) {
          throw new TaxonomyDomainError(
            422,
            "INVALID_REASSIGN_TARGET",
            `Penawaran #${o.id} bertipe "${o.offering_type}" tidak dapat dialihkan ke kategori bertipe "${reassignTargetOfferingType}".`,
            [
              {
                field: "reassignToId",
                code: "INVALID_REASSIGN_TARGET",
                message: `Offering #${o.id} (${o.offering_type}) cannot be reassigned to category scoped to "${reassignTargetOfferingType}".`,
              },
            ],
          );
        }

        if (nextDraft !== null || nextPublished !== null) {
          offeringRewrites.push({
            id: Number(o.id),
            version: Number(o.version),
            offeringType: o.offering_type,
            nextDraft,
            nextPublished,
          });
        }
      }
    }
  }

  // Build Statement 0 sentinel lock with ALL atomic invariants!
  const sentinelVersion = -(input.expectedVersion + 1);
  const sentinelConditions: string[] = [
    "id = ?",
    "taxonomy_type = ?",
    "version = ?",
    "NOT EXISTS (SELECT 1 FROM taxonomies WHERE parent_id = ?)",
  ];
  const sentinelBinds: unknown[] = [
    sentinelVersion,
    input.taxonomyId,
    kind,
    input.expectedVersion,
    input.taxonomyId,
  ];

  // Ensure reassign target still exists atomically
  if (reassignTargetId !== null) {
    sentinelConditions.push("EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = ?)");
    sentinelBinds.push(reassignTargetId, kind);
  }

  // When neither detach nor reassignToId was supplied, enforce ZERO usage atomically inside SQL!
  if (!allowUsageRewrite) {
    if (kind === "post_category") {
      sentinelConditions.push(
        `NOT EXISTS (
           SELECT 1 FROM post_taxonomies pt
           INNER JOIN posts p ON p.id = pt.post_id
           WHERE pt.taxonomy_id = ? AND p.deleted_at IS NULL AND p.status != 'trashed'
         )`,
        `NOT EXISTS (
           SELECT 1 FROM posts p
           WHERE p.primary_category_id = ? AND p.deleted_at IS NULL AND p.status != 'trashed'
         )`,
      );
      sentinelBinds.push(input.taxonomyId, input.taxonomyId);
    } else if (kind === "post_tag") {
      sentinelConditions.push(
        `NOT EXISTS (
           SELECT 1 FROM post_taxonomies pt
           INNER JOIN posts p ON p.id = pt.post_id
           WHERE pt.taxonomy_id = ? AND p.deleted_at IS NULL AND p.status != 'trashed'
         )`,
      );
      sentinelBinds.push(input.taxonomyId);
    } else {
      sentinelConditions.push(
        `NOT EXISTS (
           SELECT 1 FROM offering_taxonomies ot
           INNER JOIN offerings o ON o.id = ot.offering_id
           WHERE ot.taxonomy_id = ? AND o.deleted_at IS NULL AND o.status != 'trashed'
         )`,
      );
      sentinelBinds.push(input.taxonomyId);
    }
  } else {
    // Constant O(1) bind parameters using SQLite `json_each(?)` so categories/tags with
    // dozens or hundreds of posts/offerings NEVER exceed D1/DO SQLite's 100-bind limit!
    if (kind === "post_category" || kind === "post_tag") {
      const expectedPostsJson = JSON.stringify(
        postRewrites.map((p) => ({ id: p.id, version: p.version })),
      );
      if (postRewrites.length > 0) {
        sentinelConditions.push(
          `(SELECT COUNT(*)
            FROM json_each(?) AS e
            INNER JOIN posts AS p
              ON p.id = CAST(json_extract(e.value, '$.id') AS INTEGER)
             AND p.version = CAST(json_extract(e.value, '$.version') AS INTEGER)) = ?`,
        );
        sentinelBinds.push(expectedPostsJson, postRewrites.length);
      }
      // Always guard against concurrent new assignments even when pre-read count was 0 (`[]`)!
      sentinelConditions.push(
        `NOT EXISTS (
           SELECT 1 FROM post_taxonomies pt
           INNER JOIN posts p ON p.id = pt.post_id
           WHERE pt.taxonomy_id = ? AND p.deleted_at IS NULL AND p.status != 'trashed'
             AND pt.post_id NOT IN (
               SELECT CAST(json_extract(e.value, '$.id') AS INTEGER)
               FROM json_each(?) AS e
             )
         )`,
      );
      sentinelBinds.push(input.taxonomyId, expectedPostsJson);
      if (kind === "post_category") {
        sentinelConditions.push(
          `NOT EXISTS (
             SELECT 1 FROM posts p
             WHERE p.primary_category_id = ? AND p.deleted_at IS NULL AND p.status != 'trashed'
               AND p.id NOT IN (
                 SELECT CAST(json_extract(e.value, '$.id') AS INTEGER)
                 FROM json_each(?) AS e
               )
           )`,
        );
        sentinelBinds.push(input.taxonomyId, expectedPostsJson);
      }
    } else {
      const expectedOfferingsJson = JSON.stringify(
        offeringRewrites.map((o) => ({ id: o.id, version: o.version })),
      );
      if (offeringRewrites.length > 0) {
        sentinelConditions.push(
          `(SELECT COUNT(*)
            FROM json_each(?) AS e
            INNER JOIN offerings AS o
              ON o.id = CAST(json_extract(e.value, '$.id') AS INTEGER)
             AND o.version = CAST(json_extract(e.value, '$.version') AS INTEGER)) = ?`,
        );
        sentinelBinds.push(expectedOfferingsJson, offeringRewrites.length);
      }
      sentinelConditions.push(
        `NOT EXISTS (
           SELECT 1 FROM offering_taxonomies ot
           INNER JOIN offerings o ON o.id = ot.offering_id
           WHERE ot.taxonomy_id = ? AND o.deleted_at IS NULL AND o.status != 'trashed'
             AND ot.offering_id NOT IN (
               SELECT CAST(json_extract(e.value, '$.id') AS INTEGER)
               FROM json_each(?) AS e
             )
         )`,
      );
      sentinelBinds.push(input.taxonomyId, expectedOfferingsJson);
      if (reassignTargetId !== null && reassignTargetOfferingType !== null) {
        sentinelConditions.push(
          `NOT EXISTS (
             SELECT 1 FROM offering_taxonomies ot
             INNER JOIN offerings o ON o.id = ot.offering_id
             WHERE ot.taxonomy_id = ? AND o.deleted_at IS NULL AND o.status != 'trashed'
               AND o.offering_type != ?
           )`,
        );
        sentinelBinds.push(input.taxonomyId, reassignTargetOfferingType);
      }
    }
  }

  const sentinelGuardSql =
    "EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = ? AND version = ?)";
  const sentinelGuardBinds = [input.taxonomyId, kind, sentinelVersion] as const;

  const stmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE taxonomies
         SET version = ?
         WHERE ${sentinelConditions.join(" AND ")}`,
      )
      .bind(...sentinelBinds),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'taxonomy.deleted', 'taxonomy', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        audit.actorUserId ?? null,
        audit.actorRole ?? "editor",
        String(input.taxonomyId),
        `Menghapus taksonomi ${kind} "${row.name}" (${row.slug})`,
        JSON.stringify({
          kind,
          offeringType: row.offering_type ?? null,
          slug: row.slug,
          detach: input.detach === true,
          reassignToId: reassignTargetId,
          publishedCount: counts.publishedCount,
          draftCount: counts.draftCount,
        }),
        nowMs,
      ),
  ];

  if (kind === "post_category" || kind === "post_tag") {
    if (kind === "post_category") {
      stmts.push(
        tenantDb
          .prepare(
            `UPDATE posts
             SET primary_category_id = ?
             WHERE primary_category_id = ? AND ${sentinelGuardSql}`,
          )
          .bind(reassignTargetId, input.taxonomyId, ...sentinelGuardBinds),
      );
    }

    if (reassignTargetId !== null) {
      stmts.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO post_taxonomies (post_id, taxonomy_id)
             SELECT post_id, ?
             FROM post_taxonomies
             WHERE taxonomy_id = ? AND ${sentinelGuardSql}`,
          )
          .bind(reassignTargetId, input.taxonomyId, ...sentinelGuardBinds),
      );
    }

    stmts.push(
      tenantDb
        .prepare(
          `DELETE FROM post_taxonomies
           WHERE taxonomy_id = ? AND ${sentinelGuardSql}`,
        )
        .bind(input.taxonomyId, ...sentinelGuardBinds),
    );

    for (const plan of postRewrites) {
      stmts.push(
        tenantDb
          .prepare(
            `UPDATE posts
             SET draft_body_json = COALESCE(?, draft_body_json),
                 published_body_json = CASE WHEN ? IS NOT NULL THEN ? ELSE published_body_json END,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND ${sentinelGuardSql}`,
          )
          .bind(
            plan.nextDraft,
            plan.nextPublished,
            plan.nextPublished,
            nowMs,
            plan.id,
            plan.version,
            ...sentinelGuardBinds,
          ),
      );
    }
  } else {
    if (reassignTargetId !== null) {
      stmts.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO offering_taxonomies (offering_id, taxonomy_id)
             SELECT offering_id, ?
             FROM offering_taxonomies
             WHERE taxonomy_id = ? AND ${sentinelGuardSql}`,
          )
          .bind(reassignTargetId, input.taxonomyId, ...sentinelGuardBinds),
      );
    }

    stmts.push(
      tenantDb
        .prepare(
          `DELETE FROM offering_taxonomies
           WHERE taxonomy_id = ? AND ${sentinelGuardSql}`,
        )
        .bind(input.taxonomyId, ...sentinelGuardBinds),
    );

    for (const plan of offeringRewrites) {
      stmts.push(
        tenantDb
          .prepare(
            `UPDATE offerings
             SET draft_snapshot_json = CASE WHEN ? IS NOT NULL THEN ? ELSE draft_snapshot_json END,
                 published_snapshot_json = CASE WHEN ? IS NOT NULL THEN ? ELSE published_snapshot_json END,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND ${sentinelGuardSql}`,
          )
          .bind(
            plan.nextDraft,
            plan.nextDraft,
            plan.nextPublished,
            plan.nextPublished,
            nowMs,
            plan.id,
            plan.version,
            ...sentinelGuardBinds,
          ),
      );
    }
  }

  if (hasArchiveSettings) {
    stmts.push(
      tenantDb
        .prepare(
          `DELETE FROM taxonomy_archive_settings
           WHERE taxonomy_id = ? AND ${sentinelGuardSql}`,
        )
        .bind(input.taxonomyId, ...sentinelGuardBinds),
    );
  }

  stmts.push(
    tenantDb
      .prepare(
        `DELETE FROM resource_slugs
         WHERE namespace = ? AND resource_id = ? AND ${sentinelGuardSql}`,
      )
      .bind(namespace, input.taxonomyId, ...sentinelGuardBinds),
    tenantDb
      .prepare(
        `DELETE FROM taxonomies
         WHERE id = ? AND taxonomy_type = ? AND version = ?`,
      )
      .bind(input.taxonomyId, kind, sentinelVersion),
  );

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(stmts);
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      throw new TaxonomyDomainError(
        422,
        "INVALID_REASSIGN_TARGET",
        "Taksonomi pengganti tidak lagi tersedia saat penghapusan dijalankan.",
        [{ field: "reassignToId", code: "INVALID_REASSIGN_TARGET", message: "Reassign target removed concurrently." }],
      );
    }
    throw err;
  }

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawTaxonomy(tenantDb, input.taxonomyId, kind);
    if (!latest) {
      throw new TaxonomyNotFoundError(input.taxonomyId, kind);
    }
    const liveCountsMap = await fetchTaxonomyUsageCountsBatch(tenantDb, kind, [input.taxonomyId]);
    const liveCounts = liveCountsMap.get(input.taxonomyId) ?? {
      publishedCount: 0,
      draftCount: 0,
      totalUsageCount: 0,
      childCount: 0,
    };

    if (liveCounts.childCount > 0) {
      assertSafeTaxonomyDelete(input.taxonomyId, {
        ...liveCounts,
        detach: input.detach === true,
        reassignToId: reassignTargetId,
      });
    }
    if (!allowUsageRewrite && liveCounts.totalUsageCount > 0) {
      assertSafeTaxonomyDelete(input.taxonomyId, {
        ...liveCounts,
        detach: false,
        reassignToId: null,
      });
    }
    if (reassignTargetId !== null) {
      const liveTarget = await fetchRawTaxonomy(tenantDb, reassignTargetId, kind);
      if (!liveTarget) {
        throw new TaxonomyDomainError(
          422,
          "INVALID_REASSIGN_TARGET",
          `Taksonomi pengganti #${reassignTargetId} tidak lagi ditemukan.`,
          [{ field: "reassignToId", code: "INVALID_REASSIGN_TARGET", message: "Reassign target no longer exists." }],
        );
      }
      if (kind === "offering_category" && reassignTargetOfferingType !== null) {
        const badOffering = await tenantDb
          .prepare(
            `SELECT o.id, o.offering_type
             FROM offering_taxonomies ot
             INNER JOIN offerings o ON o.id = ot.offering_id
             WHERE ot.taxonomy_id = ? AND o.deleted_at IS NULL AND o.status != 'trashed'
               AND o.offering_type != ?
             LIMIT 1`,
          )
          .bind(input.taxonomyId, reassignTargetOfferingType)
          .first<{ readonly id: number; readonly offering_type: string }>();
        if (badOffering) {
          throw new TaxonomyDomainError(
            422,
            "INVALID_REASSIGN_TARGET",
            `Penawaran #${badOffering.id} bertipe "${badOffering.offering_type}" tidak cocok dengan kategori pengganti bertipe "${reassignTargetOfferingType}".`,
            [
              {
                field: "reassignToId",
                code: "INVALID_REASSIGN_TARGET",
                message: "Mixed offeringType detected during reassignment.",
              },
            ],
          );
        }
      }
    }

    throw new TaxonomyStaleVersionError({
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
      detail:
        Number(latest.version) === input.expectedVersion
          ? `Konten terkait taksonomi #${input.taxonomyId} baru saja diubah secara bersamaan. Muat ulang dan coba lagi.`
          : undefined,
    });
  }

  if (counts.publishedCount > 0 && audit.platformDb && audit.tenantId) {
    try {
      await bumpTenantCacheVersion(audit.platformDb, audit.tenantId, nowMs);
    } catch {
      // Deletion already committed cleanly
    }
  }

  return {
    deletedId: input.taxonomyId,
    kind,
    reassignedToId: reassignTargetId,
    detached: input.detach === true,
    affectedPublishedCount: counts.publishedCount,
  };
}
