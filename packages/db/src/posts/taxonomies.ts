import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  type PublicationValidationField,
} from "@punyasitus/core/content/index";
import {
  buildSuffixedSlug,
  isReservedSlug,
  normalizeTitleToSlug,
  SlugValidationError,
  suggestAlternativeSlug,
  validateManualSlug,
  type SlugNamespace,
} from "@punyasitus/core/slug/index";
import {
  allocateNextSequenceId,
  buildFormerSlugTransitionStatements,
  isSlugTakenInNamespace,
  isUniqueConstraintError,
  listResourceSlugsForResource,
  type SequenceKind,
} from "../identifiers/index.ts";

/**
 * Per-Tenant Blog Categories (`post_category`) & Flat Tags (`post_tag`) Repository
 * (`packages/db/src/posts/taxonomies.ts`; TASK-006, REQ-009, REQ-034, REQ-036, REQ-061).
 *
 * Guarantees:
 * - Strict tenant-local namespace separation (`post_category` -> `blog_category`, `post_tag` -> `blog_tag`).
 * - Shared slug rules (NFKD diacritics, 80-char cap, `-2` auto-suffix, manual 422 SLUG_CONFLICT, reserved slugs).
 * - Category hierarchy max depth 3, cycle prevention, and same-tenant same-kind parent validation.
 * - Tags are strictly flat (`parentId` forbidden).
 * - Optimistic concurrency (`expectedVersion` -> 409 STALE_VERSION) with single-batch atomic
 *   `EXISTS`-guarded `resource_slugs` & `post_taxonomies` mutations (ZERO side effects on losing concurrent writes).
 * - Safe guarded deletion protecting parent categories with children (409) and referenced taxonomies (409 unless detached/reassigned).
 */

export type BlogTaxonomyKind = "post_category" | "post_tag";

export const MAX_CATEGORY_DEPTH = 3 as const;

interface RawTaxonomyRow {
  readonly id: number;
  readonly taxonomy_type: BlogTaxonomyKind;
  readonly offering_type: string | null;
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

export interface BlogTaxonomyRecord {
  readonly id: number;
  readonly kind: BlogTaxonomyKind;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly parentId: number | null;
  readonly depth: number;
  readonly sortOrder: number;
  readonly publishedCount: number;
  readonly usageCount: number;
  readonly indexable: boolean;
  readonly formerSlugs: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBlogTaxonomyInput {
  readonly kind: BlogTaxonomyKind;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly parentId?: number | null;
  readonly sortOrder?: number;
  readonly nowMs?: number;
}

export interface UpdateBlogTaxonomyInput {
  readonly kind: BlogTaxonomyKind;
  readonly taxonomyId: number;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly slug?: string;
  readonly confirmSlugChange?: boolean;
  readonly description?: string | null;
  readonly parentId?: number | null;
  readonly sortOrder?: number;
  readonly nowMs?: number;
}

export interface DeleteBlogTaxonomyInput {
  readonly kind: BlogTaxonomyKind;
  readonly taxonomyId: number;
  readonly expectedVersion?: number;
  readonly detach?: boolean;
  readonly reassignToCategoryId?: number;
  readonly nowMs?: number;
}

export interface ListBlogTaxonomiesOptions {
  readonly kind: BlogTaxonomyKind;
  readonly parentId?: number | null;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sortOrder?: "asc" | "desc";
}

export interface ListBlogTaxonomiesResult {
  readonly items: readonly BlogTaxonomyRecord[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export class TaxonomyNotFoundError extends Error {
  readonly httpStatus = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly kind: BlogTaxonomyKind;
  readonly taxonomyId: number;

  constructor(kind: BlogTaxonomyKind, taxonomyId: number) {
    super(`Taxonomy ${kind}#${taxonomyId} not found`);
    this.name = "TaxonomyNotFoundError";
    this.kind = kind;
    this.taxonomyId = taxonomyId;
  }
}

export class TaxonomyStaleVersionError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "STALE_VERSION" as const;
  readonly kind: BlogTaxonomyKind;
  readonly taxonomyId: number;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(params: {
    readonly kind: BlogTaxonomyKind;
    readonly taxonomyId: number;
    readonly expectedVersion: number;
    readonly actualVersion?: number | null;
  }) {
    super(
      `Stale version for ${params.kind}#${params.taxonomyId}: expected ${params.expectedVersion}${
        params.actualVersion !== undefined && params.actualVersion !== null
          ? `, actual ${params.actualVersion}`
          : ""
      }`,
    );
    this.name = "TaxonomyStaleVersionError";
    this.kind = params.kind;
    this.taxonomyId = params.taxonomyId;
    this.expectedVersion = params.expectedVersion;
    this.actualVersion = params.actualVersion ?? null;
  }
}

export class TaxonomyConflictError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "CONFLICT" as const;
  readonly reason: "TAXONOMY_HAS_CHILDREN" | "TAXONOMY_IN_USE";
  readonly fields: readonly PublicationValidationField[];
  readonly usageCount: number;
  readonly childCount: number;

  constructor(
    reason: "TAXONOMY_HAS_CHILDREN" | "TAXONOMY_IN_USE",
    message: string,
    meta: { readonly usageCount?: number; readonly childCount?: number } = {},
  ) {
    super(message);
    this.name = "TaxonomyConflictError";
    this.reason = reason;
    this.usageCount = meta.usageCount ?? 0;
    this.childCount = meta.childCount ?? 0;
    this.fields = [{ field: "taxonomyId", code: reason, message }];
  }
}

function getSlugNamespaceForKind(kind: BlogTaxonomyKind): SlugNamespace {
  return kind === "post_category" ? "blog_category" : "blog_tag";
}

/**
 * All taxonomy kinds (`post_category`, `post_tag`, `offering_category`) share the
 * single `taxonomies(id INTEGER PRIMARY KEY)` table, so they MUST allocate from one
 * shared per-tenant sequence (`category`) to guarantee globally unique `taxonomies.id`.
 */
function getSequenceKindForTaxonomy(_kind: BlogTaxonomyKind): SequenceKind {
  return "category";
}

function isSlugUniqueConstraintError(err: unknown): boolean {
  if (!isUniqueConstraintError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/taxonomies\.id\b/i.test(msg)) return false;
  return true;
}

function getFallbackPrefixForKind(kind: BlogTaxonomyKind): string {
  return kind === "post_category" ? "kategori" : "tag";
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertValidTaxonomyId(id: number, field = "taxonomyId"): void {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new PublicationValidationError(`${field} must be a positive integer`, [
      { field, code: "INVALID_ID", message: `${field} must be a positive integer` },
    ]);
  }
}

function assertValidExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0 || version > 2_147_483_647) {
    throw new PublicationValidationError("expectedVersion must be a nonnegative integer", [
      {
        field: "version",
        code: "INVALID_VERSION",
        message: "expectedVersion must be a nonnegative integer",
      },
    ]);
  }
}

function validateTaxonomyName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PublicationValidationError("name must be a string", [
      { field: "name", code: "INVALID_TYPE", message: "Nama harus berupa string." },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new PublicationValidationError("name must be 1..100 characters", [
      { field: "name", code: "INVALID_LENGTH", message: "Nama harus 1 hingga 100 karakter." },
    ]);
  }
  if (hasControlChars(trimmed) || /<\s*\/?\s*(?:script|iframe|style|object|embed|svg)\b/i.test(trimmed)) {
    throw new PublicationValidationError("name contains disallowed characters", [
      { field: "name", code: "INVALID_CHARACTERS", message: "Nama mengandung karakter tidak diizinkan." },
    ]);
  }
  return trimmed;
}

function validateTaxonomyDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new PublicationValidationError("description must be a string or null", [
      { field: "description", code: "INVALID_TYPE", message: "Deskripsi harus berupa string atau null." },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed.length > 500) {
    throw new PublicationValidationError("description must be at most 500 characters", [
      { field: "description", code: "INVALID_LENGTH", message: "Deskripsi maksimal 500 karakter." },
    ]);
  }
  if (hasControlChars(trimmed) || /<\s*\/?\s*(?:script|iframe|style|object|embed|svg)\b/i.test(trimmed)) {
    throw new PublicationValidationError("description contains disallowed characters", [
      {
        field: "description",
        code: "INVALID_CHARACTERS",
        message: "Deskripsi mengandung karakter tidak diizinkan.",
      },
    ]);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function validateSortOrder(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 10_000) {
    throw new PublicationValidationError("sortOrder must be an integer 0..10000", [
      { field: "sortOrder", code: "INVALID_SORT_ORDER", message: "sortOrder harus bilangan bulat 0..10000." },
    ]);
  }
  return raw;
}

function normalizeDepth(rawDepth: number): number {
  const d = Number(rawDepth);
  if (!Number.isFinite(d) || d < 1) return 1;
  return Math.min(MAX_CATEGORY_DEPTH, Math.floor(d));
}

async function fetchRawTaxonomy(
  tenantDb: D1Database,
  kind: BlogTaxonomyKind,
  taxonomyId: number,
): Promise<RawTaxonomyRow | null> {
  return tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, parent_id, depth, slug, name, description,
              sort_order, version, created_at, updated_at
       FROM taxonomies
       WHERE id = ? AND taxonomy_type = ?
       LIMIT 1`,
    )
    .bind(taxonomyId, kind)
    .first<RawTaxonomyRow>();
}

async function isTaxonomySlugTaken(
  tenantDb: D1Database,
  kind: BlogTaxonomyKind,
  slug: string,
  excludeId?: number,
): Promise<boolean> {
  const namespace = getSlugNamespaceForKind(kind);
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

async function fetchTaxonomyCountsBatch(
  tenantDb: D1Database,
  taxonomyIds: readonly number[],
): Promise<Map<number, { readonly publishedCount: number; readonly usageCount: number }>> {
  const counts = new Map<number, { readonly publishedCount: number; readonly usageCount: number }>();
  if (taxonomyIds.length === 0) return counts;

  const placeholders = taxonomyIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT tax_id,
              COUNT(DISTINCT post_id) AS usage_count,
              COUNT(DISTINCT CASE WHEN status = 'published' THEN post_id END) AS published_count
       FROM (
         SELECT pt.taxonomy_id AS tax_id, p.id AS post_id, p.status AS status
         FROM post_taxonomies pt
         JOIN posts p ON p.id = pt.post_id
         WHERE pt.taxonomy_id IN (${placeholders}) AND p.deleted_at IS NULL
         UNION
         SELECT p.primary_category_id AS tax_id, p.id AS post_id, p.status AS status
         FROM posts p
         WHERE p.primary_category_id IN (${placeholders}) AND p.deleted_at IS NULL
       )
       GROUP BY tax_id`,
    )
    .bind(...taxonomyIds, ...taxonomyIds)
    .all<{
      readonly tax_id: number;
      readonly usage_count: number;
      readonly published_count: number;
    }>();

  for (const row of res.results) {
    counts.set(Number(row.tax_id), {
      usageCount: Number(row.usage_count ?? 0),
      publishedCount: Number(row.published_count ?? 0),
    });
  }
  return counts;
}

async function fetchFormerSlugsForTaxonomies(
  tenantDb: D1Database,
  kind: BlogTaxonomyKind,
  taxonomyIds: readonly number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (taxonomyIds.length === 0) return map;
  const namespace = getSlugNamespaceForKind(kind);
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

  for (const row of res.results) {
    const id = Number(row.resource_id);
    const list = map.get(id) ?? [];
    list.push(String(row.slug));
    map.set(id, list);
  }
  return map;
}

function mapRawTaxonomyToRecord(
  row: RawTaxonomyRow,
  counts: { readonly publishedCount: number; readonly usageCount: number },
  formerSlugs: readonly string[],
): BlogTaxonomyRecord {
  return {
    id: Number(row.id),
    kind: row.taxonomy_type,
    name: String(row.name),
    slug: String(row.slug),
    description: row.description !== null && row.description !== undefined ? String(row.description) : null,
    parentId: row.parent_id !== null && row.parent_id !== undefined ? Number(row.parent_id) : null,
    depth: normalizeDepth(row.depth),
    sortOrder: Number(row.sort_order ?? 0),
    publishedCount: counts.publishedCount,
    usageCount: counts.usageCount,
    indexable: counts.publishedCount > 0,
    formerSlugs,
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

/**
 * Creates a tenant-scoped blog category (`post_category`, max depth 3) or flat tag (`post_tag`).
 */
export async function createBlogTaxonomy(
  tenantDb: D1Database,
  input: CreateBlogTaxonomyInput,
): Promise<BlogTaxonomyRecord> {
  assertNoForbiddenTenantSelectors(input);
  const nowMs = input.nowMs ?? Date.now();
  const kind = input.kind;
  const namespace = getSlugNamespaceForKind(kind);

  const cleanName = validateTaxonomyName(input.name);
  const cleanDesc = validateTaxonomyDescription(input.description);
  const sortOrder = validateSortOrder(input.sortOrder);

  let parentId: number | null = null;
  let depth = 1;

  if (input.parentId !== undefined && input.parentId !== null) {
    if (kind === "post_tag") {
      throw new PublicationValidationError("Tags are flat and cannot declare a parent category", [
        {
          field: "parentId",
          code: "INVALID_PARENT",
          message: "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
        },
      ]);
    }
    assertValidTaxonomyId(input.parentId, "parentId");
    const parent = await fetchRawTaxonomy(tenantDb, "post_category", input.parentId);
    if (!parent) {
      throw new PublicationValidationError("Parent category not found in this tenant", [
        {
          field: "parentId",
          code: "INVALID_PARENT",
          message: `Kategori induk #${input.parentId} tidak ditemukan di tenant ini.`,
        },
      ]);
    }
    const parentDepth = normalizeDepth(parent.depth);
    depth = parentDepth + 1;
    if (depth > MAX_CATEGORY_DEPTH) {
      throw new PublicationValidationError(
        `Category hierarchy cannot exceed depth ${MAX_CATEGORY_DEPTH}`,
        [
          {
            field: "parentId",
            code: "MAX_DEPTH_EXCEEDED",
            message: `Kedalaman kategori maksimal ${MAX_CATEGORY_DEPTH} tingkat.`,
          },
        ],
      );
    }
    parentId = Number(parent.id);
  }

  // Validate manual slug BEFORE allocating sequence ID
  const manualSlug =
    input.slug !== undefined ? validateManualSlug(input.slug, { namespace }) : null;

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

  const taxonomyId = await allocateNextSequenceId(tenantDb, getSequenceKindForTaxonomy(kind));

  if (manualSlug !== null) {
    try {
      await tenantDb.batch([
        tenantDb
          .prepare(
            `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             VALUES (?, ?, ?, 1, NULL, ?)`,
          )
          .bind(namespace, manualSlug, taxonomyId, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO taxonomies (
               id, taxonomy_type, offering_type, parent_id, depth,
               slug, name, description, sort_order,
               version, created_at, updated_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            taxonomyId,
            kind,
            parentId,
            depth,
            manualSlug,
            cleanName,
            cleanDesc,
            sortOrder,
            nowMs,
            nowMs,
          ),
      ]);
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

    const created = await getBlogTaxonomyById(tenantDb, kind, taxonomyId);
    if (!created) {
      throw new Error(`Failed to reload newly created taxonomy ${kind}#${taxonomyId}`);
    }
    return created;
  }

  const baseSlug = normalizeTitleToSlug(cleanName, {
    fallbackPrefix: getFallbackPrefixForKind(kind),
    fallbackId: taxonomyId,
  });

  const maxAttempts = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? baseSlug : buildSuffixedSlug(baseSlug, attempt);
    if (isReservedSlug(candidate, namespace)) {
      continue;
    }

    try {
      await tenantDb.batch([
        tenantDb
          .prepare(
            `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             VALUES (?, ?, ?, 1, NULL, ?)`,
          )
          .bind(namespace, candidate, taxonomyId, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO taxonomies (
               id, taxonomy_type, offering_type, parent_id, depth,
               slug, name, description, sort_order,
               version, created_at, updated_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            taxonomyId,
            kind,
            parentId,
            depth,
            candidate,
            cleanName,
            cleanDesc,
            sortOrder,
            nowMs,
            nowMs,
          ),
      ]);

      const created = await getBlogTaxonomyById(tenantDb, kind, taxonomyId);
      if (!created) {
        throw new Error(`Failed to reload newly created taxonomy ${kind}#${taxonomyId}`);
      }
      return created;
    } catch (err) {
      if (isSlugUniqueConstraintError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new SlugValidationError(
    "SLUG_CONFLICT",
    `Unable to allocate a unique slug derived from "${baseSlug}".`,
    { field: "slug" },
  );
}

export async function getBlogTaxonomyById(
  tenantDb: D1Database,
  kind: BlogTaxonomyKind,
  taxonomyId: number,
): Promise<BlogTaxonomyRecord | null> {
  assertValidTaxonomyId(taxonomyId);
  const row = await fetchRawTaxonomy(tenantDb, kind, taxonomyId);
  if (!row) return null;
  const countsMap = await fetchTaxonomyCountsBatch(tenantDb, [taxonomyId]);
  const slugs = await listResourceSlugsForResource(tenantDb, getSlugNamespaceForKind(kind), taxonomyId);
  const formerSlugs = slugs.filter((s) => !s.isCurrent).map((s) => s.slug);
  return mapRawTaxonomyToRecord(
    row,
    countsMap.get(taxonomyId) ?? { publishedCount: 0, usageCount: 0 },
    formerSlugs,
  );
}

export async function listBlogTaxonomies(
  tenantDb: D1Database,
  options: ListBlogTaxonomiesOptions,
): Promise<ListBlogTaxonomiesResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const sortOrder = options.sortOrder === "asc" ? "asc" : "desc";
  const conditions: string[] = ["taxonomy_type = ?"];
  const binds: unknown[] = [options.kind];

  if (options.parentId !== undefined) {
    if (options.parentId === null) {
      conditions.push("parent_id IS NULL");
    } else {
      assertValidTaxonomyId(options.parentId, "parentId");
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
      throw new PublicationValidationError("Invalid pagination cursor", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Cursor must be a numeric taxonomy ID." },
      ]);
    }
    const cursorId = Number(options.cursor.trim());
    conditions.push(sortOrder === "asc" ? "id > ?" : "id < ?");
    binds.push(cursorId);
  }

  const orderSql = sortOrder === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";
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

  const [countsMap, formerSlugsMap] = await Promise.all([
    fetchTaxonomyCountsBatch(tenantDb, ids),
    fetchFormerSlugsForTaxonomies(tenantDb, options.kind, ids),
  ]);

  const items = rows.map((row) =>
    mapRawTaxonomyToRecord(
      row,
      countsMap.get(Number(row.id)) ?? { publishedCount: 0, usageCount: 0 },
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

/**
 * Updates a blog category or tag with strict optimistic concurrency (`expectedVersion` -> 409)
 * inside ONE atomic `tenantDb.batch([...])` where every follow-up `resource_slugs` and
 * descendant-depth statement is gated on `EXISTS (SELECT 1 FROM taxonomies WHERE ...)`.
 */
export async function updateBlogTaxonomy(
  tenantDb: D1Database,
  input: UpdateBlogTaxonomyInput,
): Promise<BlogTaxonomyRecord> {
  assertNoForbiddenTenantSelectors(input);
  assertValidTaxonomyId(input.taxonomyId);
  assertValidExpectedVersion(input.expectedVersion);

  const kind = input.kind;
  const namespace = getSlugNamespaceForKind(kind);
  const row = await fetchRawTaxonomy(tenantDb, kind, input.taxonomyId);
  if (!row) {
    throw new TaxonomyNotFoundError(kind, input.taxonomyId);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new TaxonomyStaleVersionError({
      kind,
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const nextName = input.name !== undefined ? validateTaxonomyName(input.name) : String(row.name);
  const nextDesc =
    input.description !== undefined ? validateTaxonomyDescription(input.description) : row.description;
  const nextSortOrder =
    input.sortOrder !== undefined ? validateSortOrder(input.sortOrder) : Number(row.sort_order ?? 0);
  const nextSlug =
    input.slug !== undefined ? validateManualSlug(input.slug, { namespace }) : String(row.slug);

  const currentParentId = row.parent_id !== null ? Number(row.parent_id) : null;
  const currentDepth = normalizeDepth(row.depth);
  let nextParentId = currentParentId;
  let nextDepth = currentDepth;
  const descendantIds: number[] = [];

  if (input.parentId !== undefined) {
    if (kind === "post_tag") {
      if (input.parentId !== null) {
        throw new PublicationValidationError("Tags are flat and cannot declare a parent category", [
          {
            field: "parentId",
            code: "INVALID_PARENT",
            message: "Tag bersifat datar (flat) dan tidak boleh memiliki induk.",
          },
        ]);
      }
      nextParentId = null;
      nextDepth = 1;
    } else if (input.parentId === null) {
      nextParentId = null;
      nextDepth = 1;
    } else {
      assertValidTaxonomyId(input.parentId, "parentId");
      if (input.parentId === input.taxonomyId) {
        throw new PublicationValidationError("Category cannot be its own parent", [
          { field: "parentId", code: "CYCLIC_PARENT", message: "Kategori tidak boleh menjadi induk dirinya sendiri." },
        ]);
      }

      // Load all post_category rows in this tenant for cycle + subtree depth check
      const allCatsRes = await tenantDb
        .prepare(
          `SELECT id, parent_id, depth
           FROM taxonomies
           WHERE taxonomy_type = 'post_category'`,
        )
        .all<{ readonly id: number; readonly parent_id: number | null; readonly depth: number }>();

      const catById = new Map<number, { readonly parentId: number | null; readonly depth: number }>();
      const childrenByParent = new Map<number, number[]>();
      for (const c of allCatsRes.results) {
        const cid = Number(c.id);
        const pid = c.parent_id !== null ? Number(c.parent_id) : null;
        catById.set(cid, { parentId: pid, depth: normalizeDepth(c.depth) });
        if (pid !== null) {
          const list = childrenByParent.get(pid) ?? [];
          list.push(cid);
          childrenByParent.set(pid, list);
        }
      }

      const targetParent = catById.get(input.parentId);
      if (!targetParent) {
        throw new PublicationValidationError("Parent category not found in this tenant", [
          {
            field: "parentId",
            code: "INVALID_PARENT",
            message: `Kategori induk #${input.parentId} tidak ditemukan di tenant ini.`,
          },
        ]);
      }

      // Walk ancestors of targetParent to detect cycles
      let cursor: number | null = input.parentId;
      const visited = new Set<number>();
      while (cursor !== null) {
        if (cursor === input.taxonomyId) {
          throw new PublicationValidationError("Cyclic category hierarchy is forbidden", [
            {
              field: "parentId",
              code: "CYCLIC_PARENT",
              message: "Hierarki kategori melingkar (cyclic) tidak diizinkan.",
            },
          ]);
        }
        if (visited.has(cursor)) break;
        visited.add(cursor);
        cursor = catById.get(cursor)?.parentId ?? null;
      }

      // Compute max height of descendants under input.taxonomyId
      let maxSubtreeHeight = 0;
      const queue: Array<{ readonly id: number; readonly height: number }> = [
        { id: input.taxonomyId, height: 0 },
      ];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const kids = childrenByParent.get(curr.id) ?? [];
        for (const kid of kids) {
          descendantIds.push(kid);
          const nextH = curr.height + 1;
          if (nextH > maxSubtreeHeight) maxSubtreeHeight = nextH;
          queue.push({ id: kid, height: nextH });
        }
      }

      nextParentId = input.parentId;
      nextDepth = targetParent.depth + 1;
      if (nextDepth + maxSubtreeHeight > MAX_CATEGORY_DEPTH) {
        throw new PublicationValidationError(
          `Moving category would exceed maximum depth ${MAX_CATEGORY_DEPTH}`,
          [
            {
              field: "parentId",
              code: "MAX_DEPTH_EXCEEDED",
              message: `Memindahkan kategori akan melebihi kedalaman maksimal ${MAX_CATEGORY_DEPTH}.`,
            },
          ],
        );
      }
    }
  }

  const nowMs = input.nowMs ?? Date.now();
  const nextVersion = input.expectedVersion + 1;
  const slugChanged = nextSlug !== String(row.slug);

  const countsMap = slugChanged ? await fetchTaxonomyCountsBatch(tenantDb, [input.taxonomyId]) : null;
  const hasPublishedPosts = (countsMap?.get(input.taxonomyId)?.publishedCount ?? 0) > 0;

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
        wasEverPublished: hasPublishedPosts,
        confirmSlugChange: input.confirmSlugChange ?? true,
        allowSelfRevert: false,
        nowMs,
        guard: atomicGuard,
      })
    : null;

  const depthDelta = nextDepth - currentDepth;
  const descendantStmts: D1PreparedStatement[] = [];
  if (depthDelta !== 0 && descendantIds.length > 0) {
    for (const descId of descendantIds) {
      descendantStmts.push(
        tenantDb
          .prepare(
            `UPDATE taxonomies
             SET depth = depth + ?, updated_at = ?
             WHERE id = ? AND taxonomy_type = 'post_category' AND ${atomicGuard.sql}`,
          )
          .bind(depthDelta, nowMs, descId, ...atomicGuard.binds),
      );
    }
  }

  const updateStmt = tenantDb
    .prepare(
      `UPDATE taxonomies
       SET name = ?,
           slug = ?,
           description = ?,
           parent_id = ?,
           depth = ?,
           sort_order = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND taxonomy_type = ? AND version = ?`,
    )
    .bind(
      nextName,
      nextSlug,
      nextDesc,
      nextParentId,
      nextDepth,
      nextSortOrder,
      nowMs,
      input.taxonomyId,
      kind,
      input.expectedVersion,
    );

  const batchStmts: D1PreparedStatement[] = [
    updateStmt,
    ...(slugTransition ? slugTransition.statements : []),
    ...descendantStmts,
  ];

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const latest = await fetchRawTaxonomy(tenantDb, kind, input.taxonomyId);
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new TaxonomyStaleVersionError({
          kind,
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
    const latest = await fetchRawTaxonomy(tenantDb, kind, input.taxonomyId);
    if (!latest) {
      throw new TaxonomyNotFoundError(kind, input.taxonomyId);
    }
    throw new TaxonomyStaleVersionError({
      kind,
      taxonomyId: input.taxonomyId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  const updated = await getBlogTaxonomyById(tenantDb, kind, input.taxonomyId);
  if (!updated) {
    throw new Error(`Failed to reload updated taxonomy ${kind}#${input.taxonomyId}`);
  }
  return updated;
}

/**
 * Deletes a blog category or tag atomically with version guard and zero side effects on stale version:
 * - Rejects with 409 `TAXONOMY_HAS_CHILDREN` if any child category exists.
 * - Rejects with 409 `TAXONOMY_IN_USE` if referenced by posts unless `detach: true` or `reassignToCategoryId` is supplied.
 * - Executes sentinel version lock, `posts.primary_category_id` / `post_taxonomies` cleanup,
 *   `resource_slugs` cleanup, and row delete in ONE atomic `tenantDb.batch([...])`.
 */
export async function deleteBlogTaxonomy(
  tenantDb: D1Database,
  input: DeleteBlogTaxonomyInput,
): Promise<void> {
  assertValidTaxonomyId(input.taxonomyId);
  if (input.expectedVersion !== undefined) {
    assertValidExpectedVersion(input.expectedVersion);
  }

  const kind = input.kind;
  const namespace = getSlugNamespaceForKind(kind);

  const row = await fetchRawTaxonomy(tenantDb, kind, input.taxonomyId);
  if (!row) {
    throw new TaxonomyNotFoundError(kind, input.taxonomyId);
  }

  const targetVersion = input.expectedVersion ?? Number(row.version);
  if (Number(row.version) !== targetVersion) {
    throw new TaxonomyStaleVersionError({
      kind,
      taxonomyId: input.taxonomyId,
      expectedVersion: targetVersion,
      actualVersion: Number(row.version),
    });
  }

  // Protect parent categories that still have children (PLAN §11.3)
  if (kind === "post_category") {
    const childRow = await tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM taxonomies WHERE parent_id = ?`)
      .bind(input.taxonomyId)
      .first<{ readonly cnt: number }>();
    const childCount = Number(childRow?.cnt ?? 0);
    if (childCount > 0) {
      throw new TaxonomyConflictError(
        "TAXONOMY_HAS_CHILDREN",
        `Kategori #${input.taxonomyId} masih memiliki ${childCount} sub-kategori. Pindahkan sub-kategori terlebih dahulu.`,
        { childCount },
      );
    }
  }

  // Validate optional reassign target
  let reassignTargetId: number | null = null;
  if (input.reassignToCategoryId !== undefined) {
    if (kind !== "post_category") {
      throw new PublicationValidationError("reassignToCategoryId is only supported for categories", [
        {
          field: "reassignToCategoryId",
          code: "INVALID_REASSIGN_TARGET",
          message: "reassignToCategoryId hanya berlaku untuk kategori blog.",
        },
      ]);
    }
    assertValidTaxonomyId(input.reassignToCategoryId, "reassignToCategoryId");
    if (input.reassignToCategoryId === input.taxonomyId) {
      throw new PublicationValidationError("Cannot reassign category to itself", [
        {
          field: "reassignToCategoryId",
          code: "INVALID_REASSIGN_TARGET",
          message: "Kategori pengganti tidak boleh sama dengan kategori yang dihapus.",
        },
      ]);
    }
    const targetCat = await fetchRawTaxonomy(tenantDb, "post_category", input.reassignToCategoryId);
    if (!targetCat) {
      throw new PublicationValidationError("Reassign target category not found in this tenant", [
        {
          field: "reassignToCategoryId",
          code: "INVALID_REASSIGN_TARGET",
          message: `Kategori pengganti #${input.reassignToCategoryId} tidak ditemukan di tenant ini.`,
        },
      ]);
    }
    reassignTargetId = Number(targetCat.id);
  }

  // Check references in posts (including drafts!)
  const countsMap = await fetchTaxonomyCountsBatch(tenantDb, [input.taxonomyId]);
  const usageCount = countsMap.get(input.taxonomyId)?.usageCount ?? 0;

  if (usageCount > 0 && input.detach !== true && reassignTargetId === null) {
    throw new TaxonomyConflictError(
      "TAXONOMY_IN_USE",
      `Taksonomi #${input.taxonomyId} masih digunakan oleh ${usageCount} artikel (termasuk draf). Kirim detach: true atau reassignToCategoryId untuk melanjutkan.`,
      { usageCount },
    );
  }

  // Sentinel negative version guarantees ONLY the winning DELETE's Statement 0 unlocks follow-up statements
  const sentinelVersion = -(targetVersion + 1);
  const sentinelGuardSql =
    "EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND taxonomy_type = ? AND version = ?)";
  const sentinelGuardBinds = [input.taxonomyId, kind, sentinelVersion] as const;

  const stmts: D1PreparedStatement[] = [
    // Statement 0: atomic version + no-children lock using negative sentinel version
    tenantDb
      .prepare(
        `UPDATE taxonomies
         SET version = ?
         WHERE id = ? AND taxonomy_type = ? AND version = ?
           AND NOT EXISTS (SELECT 1 FROM taxonomies WHERE parent_id = ?)`,
      )
      .bind(sentinelVersion, input.taxonomyId, kind, targetVersion, input.taxonomyId),
    // Statement 1: detach or reassign posts.primary_category_id (satisfies FK before delete)
    tenantDb
      .prepare(
        `UPDATE posts
         SET primary_category_id = ?
         WHERE primary_category_id = ? AND ${sentinelGuardSql}`,
      )
      .bind(reassignTargetId, input.taxonomyId, ...sentinelGuardBinds),
  ];

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

  const batchResults = await tenantDb.batch(stmts);
  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawTaxonomy(tenantDb, kind, input.taxonomyId);
    if (!latest) {
      throw new TaxonomyNotFoundError(kind, input.taxonomyId);
    }
    if (kind === "post_category") {
      const childRow = await tenantDb
        .prepare(`SELECT COUNT(*) AS cnt FROM taxonomies WHERE parent_id = ?`)
        .bind(input.taxonomyId)
        .first<{ readonly cnt: number }>();
      const childCount = Number(childRow?.cnt ?? 0);
      if (childCount > 0) {
        throw new TaxonomyConflictError(
          "TAXONOMY_HAS_CHILDREN",
          `Kategori #${input.taxonomyId} masih memiliki ${childCount} sub-kategori.`,
          { childCount },
        );
      }
    }
    throw new TaxonomyStaleVersionError({
      kind,
      taxonomyId: input.taxonomyId,
      expectedVersion: targetVersion,
      actualVersion: Number(latest.version),
    });
  }
}
