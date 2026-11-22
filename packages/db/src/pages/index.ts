import {
  assertNoForbiddenTenantSelectors,
  extractDraftSnapshotForAdmin,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  serializeDraftStoragePayload,
  StaleRevisionError,
  validatePageLayoutMode,
  validatePageSeoOverrides,
  type AdminDraftResourceDto,
  type PageLayoutMode,
  type PageSeoOverrides,
  type PageSnapshot,
  type PublishedResourceDto,
  type ResourceLifecycleStatus,
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
  allocateNextSequenceId,
  buildFormerSlugTransitionStatements,
  findResourceSlug,
  isSlugTakenInNamespace,
  isUniqueConstraintError,
  listResourceSlugsForResource,
} from "../identifiers/index.ts";
import {
  bumpTenantCacheVersion,
  getDraftResourceForAdmin,
  getPublishedResource,
  publishResourceAtomically,
  unpublishResourceAtomically,
} from "../publication/index.ts";
import { ensurePagesLayoutModeColumn } from "./migrations.ts";

export {
  ensurePagesLayoutModeColumn,
  PAGES_LAYOUT_MODE_MIGRATION,
  PAGES_LAYOUT_MODE_MIGRATION_SQL,
} from "./migrations.ts";

/**
 * Per-Tenant Static Pages Repository (`packages/db/src/pages/index.ts`; TASK-005, REQ-008, REQ-036, REQ-061).
 *
 * Operates exclusively against a tenant's physically isolated `TenantStore` SQLite Durable Object
 * and coordinates publication/unpublication/trash cache invalidation with `PLATFORM_DB`.
 */

interface RawPageRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly is_homepage: number;
  readonly layout_mode?: PageLayoutMode | null;
  readonly draft_sections_json: string;
  readonly published_sections_json: string | null;
  readonly seo_json: string | null;
  readonly status: ResourceLifecycleStatus;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PageRecord {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: ResourceLifecycleStatus;
  readonly isHomepage: boolean;
  readonly layoutMode: PageLayoutMode;
  readonly sections: PageSnapshot["sections"];
  readonly seo: PageSeoOverrides | null;
  readonly published: PageSnapshot | null;
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly formerSlugs: readonly string[];
}

export interface CreatePageInput {
  readonly title: string;
  readonly slug?: string;
  readonly isHomepage?: boolean;
  readonly layoutMode?: PageLayoutMode;
  readonly sections?: unknown;
  readonly seo?: unknown;
  readonly nowMs?: number;
}

export interface UpdatePageInput {
  readonly pageId: number;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly slug?: string;
  readonly confirmSlugChange?: boolean;
  readonly isHomepage?: boolean;
  readonly layoutMode?: PageLayoutMode;
  readonly sections?: unknown;
  readonly seo?: unknown;
  readonly nowMs?: number;
}

export interface PublishPageInput {
  readonly tenantId: string;
  readonly pageId: number;
  readonly expectedVersion: number;
  readonly confirmSlugChange?: boolean;
  readonly actorUserId?: string | null;
  readonly nowMs?: number;
}

export interface PublishPageResult {
  readonly page: PageRecord;
  readonly cacheVersion: number;
  readonly revisionNumber: number | null;
}

export interface UnpublishPageInput {
  readonly tenantId: string;
  readonly pageId: number;
  readonly expectedVersion: number;
  readonly nowMs?: number;
}

export interface UnpublishPageResult {
  readonly page: PageRecord;
  readonly cacheVersion: number;
}

export interface TrashPageInput {
  readonly tenantId: string;
  readonly pageId: number;
  readonly expectedVersion?: number;
  readonly nowMs?: number;
}

export interface TrashPageResult {
  readonly page: PageRecord;
  readonly cacheVersion: number | null;
}

export interface RestorePageInput {
  readonly pageId: number;
  readonly expectedVersion: number;
  readonly resolvedSlug?: string;
  readonly nowMs?: number;
}

export interface ListPagesOptions {
  readonly status?: ResourceLifecycleStatus | "all";
  readonly includeTrashed?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sortOrder?: "asc" | "desc";
}

export interface ListPagesResult {
  readonly items: readonly PageRecord[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface PageRevisionSummary {
  readonly revisionNumber: number;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly summary: string;
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(Number(ms)).toISOString();
}

function assertValidPageId(pageId: number): void {
  if (!Number.isSafeInteger(pageId) || pageId < 1 || pageId > 2_147_483_647) {
    throw new PublicationValidationError("pageId must be a positive integer", [
      { field: "pageId", code: "INVALID_PAGE_ID", message: "pageId must be a positive integer" },
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

function extractDraftStateFromRow(row: RawPageRow): {
  readonly draft: PageSnapshot;
  readonly published: PageSnapshot | null;
  readonly hasUnpublishedChanges: boolean;
} {
  const adminDto = extractDraftSnapshotForAdmin("page", {
    resourceId: Number(row.id),
    status: row.status,
    deletedAt: row.deleted_at,
    draftJson: row.draft_sections_json,
    publishedJson: row.published_sections_json,
    publishedAt: row.published_at,
    contentModifiedAt: row.content_modified_at,
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  });

  if (adminDto?.draft) {
    const layoutMode: PageLayoutMode =
      adminDto.draft.layoutMode ??
      (row.layout_mode === "focused" ? "focused" : "standard");
    return {
      draft: {
        ...adminDto.draft,
        layoutMode,
      },
      published: adminDto.published,
      hasUnpublishedChanges: adminDto.hasUnpublishedChanges,
    };
  }

  // Fallback for rows seeded with raw section arrays directly in SQLite
  const parsedSections = safeJsonParse(row.draft_sections_json);
  const parsedSeo = safeJsonParse(row.seo_json);
  let seo: PageSeoOverrides | null = null;
  if (parsedSeo && typeof parsedSeo === "object" && !Array.isArray(parsedSeo)) {
    try {
      seo = validatePageSeoOverrides(parsedSeo);
    } catch {
      seo = null;
    }
  }
  const draft: PageSnapshot = {
    slug: String(row.slug),
    title: String(row.title),
    isHomepage: Number(row.is_homepage) === 1,
    layoutMode: row.layout_mode === "focused" ? "focused" : "standard",
    sections: Array.isArray(parsedSections) ? (parsedSections as PageSnapshot["sections"]) : [],
    seo,
  };
  const published = adminDto?.published ?? null;
  const hasUnpublishedChanges =
    published === null || JSON.stringify(draft) !== JSON.stringify(published);

  return { draft, published, hasUnpublishedChanges };
}

function mapRowToPageRecord(row: RawPageRow, formerSlugs: readonly string[]): PageRecord {
  const { draft, published, hasUnpublishedChanges } = extractDraftStateFromRow(row);
  return {
    id: Number(row.id),
    slug: draft.slug,
    title: draft.title,
    status: row.status,
    isHomepage: draft.isHomepage,
    layoutMode: draft.layoutMode,
    sections: draft.sections,
    seo: draft.seo ?? null,
    published,
    hasUnpublishedChanges,
    version: Number(row.version),
    publishedAt: toIsoOrNull(row.published_at),
    contentModifiedAt: toIsoOrNull(row.content_modified_at),
    deletedAt: toIsoOrNull(row.deleted_at),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    formerSlugs,
  };
}

async function fetchRawPageRow(
  tenantDb: D1Database,
  pageId: number,
  options: { readonly includeTrashed?: boolean } = {},
): Promise<RawPageRow | null> {
  const sql = options.includeTrashed
    ? `SELECT * FROM pages WHERE id = ? LIMIT 1`
    : `SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL LIMIT 1`;
  return tenantDb.prepare(sql).bind(pageId).first<RawPageRow>();
}

async function fetchFormerSlugsForPage(tenantDb: D1Database, pageId: number): Promise<string[]> {
  const slugs = await listResourceSlugsForResource(tenantDb, "pages", pageId);
  return slugs.filter((s) => !s.isCurrent).map((s) => s.slug);
}

async function fetchFormerSlugsBatch(
  tenantDb: D1Database,
  pageIds: readonly number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (pageIds.length === 0) return map;
  const placeholders = pageIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT resource_id, slug
       FROM resource_slugs
       WHERE namespace = 'pages' AND is_current = 0 AND resource_id IN (${placeholders})
       ORDER BY updated_at DESC, slug ASC`,
    )
    .bind(...pageIds)
    .all<{ readonly resource_id: number; readonly slug: string }>();

  for (const row of res.results) {
    const id = Number(row.resource_id);
    const list = map.get(id) ?? [];
    list.push(String(row.slug));
    map.set(id, list);
  }
  return map;
}

async function isPageSlugTaken(
  tenantDb: D1Database,
  slug: string,
  excludePageId?: number,
): Promise<boolean> {
  if (await isSlugTakenInNamespace(tenantDb, "pages", slug, { excludeResourceId: excludePageId })) {
    return true;
  }
  const existingPage = await tenantDb
    .prepare(`SELECT id FROM pages WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<{ readonly id: number }>();
  if (!existingPage) return false;
  return excludePageId === undefined || Number(existingPage.id) !== excludePageId;
}

/**
 * Creates a new draft static page with:
 * - Atomic per-tenant sequential ID (`sequences.kind = 'page'`)
 * - Shared slug normalization (NFKD diacritics, 80-char cap, fallback, `-2` auto-suffix)
 *   or strict manual slug validation (reserved/conflict -> 422, NEVER silently renamed)
 * - `layoutMode` (`standard` | `focused` Landing Page Focus Mode)
 * - Validated SEO overrides (`seoTitle` <= 70, `seoDescription` <= 160, `ogImageMediaId`, `noindex`, `canonicalOverride`)
 */
export async function createPage(
  tenantDb: D1Database,
  input: CreatePageInput,
): Promise<PageRecord> {
  assertNoForbiddenTenantSelectors(input);
  await ensurePagesLayoutModeColumn(tenantDb);

  const nowMs = input.nowMs ?? Date.now();
  const isHomepage = input.isHomepage ?? false;
  if (typeof isHomepage !== "boolean") {
    throw new PublicationValidationError("isHomepage must be a boolean", [
      { field: "isHomepage", code: "INVALID_TYPE", message: "isHomepage must be a boolean" },
    ]);
  }
  const layoutMode =
    input.layoutMode !== undefined ? validatePageLayoutMode(input.layoutMode) : "standard";
  const seo = input.seo !== undefined ? validatePageSeoOverrides(input.seo) : null;
  const sections = input.sections ?? [];

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new PublicationValidationError("title is required", [
      { field: "title", code: "REQUIRED", message: "Judul halaman tidak boleh kosong." },
    ]);
  }
  const cleanTitle = input.title.trim();

  // Validate manual slug BEFORE allocating a sequence ID
  const manualSlug =
    input.slug !== undefined ? validateManualSlug(input.slug, { namespace: "pages" }) : null;

  // Pre-validate snapshot (sections, HTML sanitization, CTA URLs, title bounds) BEFORE sequence allocation
  const probeSlug = manualSlug ?? "valid-probe-slug";
  serializeDraftStoragePayload("page", {
    slug: probeSlug,
    title: cleanTitle,
    isHomepage,
    layoutMode,
    sections,
    seo,
  });

  if (isHomepage) {
    const existingHome = await tenantDb
      .prepare(`SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1`)
      .first<{ readonly id: number }>();
    if (existingHome) {
      throw new PublicationValidationError("Another active page is already designated as homepage", [
        {
          field: "isHomepage",
          code: "HOMEPAGE_ALREADY_SET",
          message: `Halaman #${existingHome.id} sudah menjadi beranda aktif.`,
        },
      ]);
    }
  }

  // If manual slug already exists, fail 422 SLUG_CONFLICT BEFORE allocating a sequence ID
  if (manualSlug !== null && (await isPageSlugTaken(tenantDb, manualSlug))) {
    const suggested = await suggestAlternativeSlug(
      manualSlug,
      (candidate) => isPageSlugTaken(tenantDb, candidate),
      { namespace: "pages" },
    );
    throw new SlugValidationError(
      "SLUG_CONFLICT",
      `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
      { field: "slug", suggestedSlug: suggested },
    );
  }

  // Allocate monotonic per-tenant sequential ID atomically
  const pageId = await allocateNextSequenceId(tenantDb, "page");

  if (manualSlug !== null) {
    const serialized = serializeDraftStoragePayload("page", {
      slug: manualSlug,
      title: cleanTitle,
      isHomepage,
      layoutMode,
      sections,
      seo,
    });

    try {
      await tenantDb.batch([
        tenantDb
          .prepare(
            `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             VALUES ('pages', ?, ?, 1, NULL, ?)`,
          )
          .bind(manualSlug, pageId, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO pages (
               id, slug, title, is_homepage, layout_mode,
               draft_sections_json, published_sections_json, seo_json,
               status, published_at, content_modified_at, deleted_at,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'draft', NULL, NULL, NULL, 1, ?, ?)`,
          )
          .bind(
            pageId,
            manualSlug,
            serialized.data.title,
            isHomepage ? 1 : 0,
            layoutMode,
            serialized.json,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            nowMs,
            nowMs,
          ),
      ]);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/pages_single_homepage_idx|is_homepage/i.test(msg)) {
          throw new PublicationValidationError("Another active page is already designated as homepage", [
            {
              field: "isHomepage",
              code: "HOMEPAGE_ALREADY_SET",
              message: "Halaman beranda aktif sudah ditetapkan.",
            },
          ]);
        }
        const suggested = await suggestAlternativeSlug(
          manualSlug,
          (candidate) => isPageSlugTaken(tenantDb, candidate),
          { namespace: "pages" },
        );
        throw new SlugValidationError(
          "SLUG_CONFLICT",
          `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
          { field: "slug", suggestedSlug: suggested },
        );
      }
      throw err;
    }

    const created = await getPageById(tenantDb, pageId);
    if (!created) {
      throw new Error(`Failed to reload newly created page #${pageId}`);
    }
    return created;
  }

  // Auto-generate slug from title with atomic `-2`, `-3`, ... collision handling
  const baseSlug = normalizeTitleToSlug(cleanTitle, {
    fallbackPrefix: "halaman",
    fallbackId: pageId,
  });

  const maxAttempts = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? baseSlug : buildSuffixedSlug(baseSlug, attempt);
    if (isReservedSlug(candidate, "pages")) {
      continue;
    }

    const serialized = serializeDraftStoragePayload("page", {
      slug: candidate,
      title: cleanTitle,
      isHomepage,
      layoutMode,
      sections,
      seo,
    });

    try {
      await tenantDb.batch([
        tenantDb
          .prepare(
            `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             VALUES ('pages', ?, ?, 1, NULL, ?)`,
          )
          .bind(candidate, pageId, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO pages (
               id, slug, title, is_homepage, layout_mode,
               draft_sections_json, published_sections_json, seo_json,
               status, published_at, content_modified_at, deleted_at,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'draft', NULL, NULL, NULL, 1, ?, ?)`,
          )
          .bind(
            pageId,
            candidate,
            serialized.data.title,
            isHomepage ? 1 : 0,
            layoutMode,
            serialized.json,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            nowMs,
            nowMs,
          ),
      ]);

      const created = await getPageById(tenantDb, pageId);
      if (!created) {
        throw new Error(`Failed to reload newly created page #${pageId}`);
      }
      return created;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/pages_single_homepage_idx|is_homepage/i.test(msg)) {
          throw new PublicationValidationError("Another active page is already designated as homepage", [
            {
              field: "isHomepage",
              code: "HOMEPAGE_ALREADY_SET",
              message: "Halaman beranda aktif sudah ditetapkan.",
            },
          ]);
        }
        continue;
      }
      throw err;
    }
  }

  throw new SlugValidationError(
    "SLUG_CONFLICT",
    `Unable to allocate a unique auto-generated slug from "${baseSlug}".`,
    { field: "slug" },
  );
}

/**
 * Loads a single page by per-tenant sequential ID (admin view with draft + published separation).
 */
export async function getPageById(
  tenantDb: D1Database,
  pageId: number,
  options: { readonly includeTrashed?: boolean } = {},
): Promise<PageRecord | null> {
  assertValidPageId(pageId);
  const row = await fetchRawPageRow(tenantDb, pageId, options);
  if (!row) return null;
  const formerSlugs = await fetchFormerSlugsForPage(tenantDb, pageId);
  return mapRowToPageRecord(row, formerSlugs);
}

/**
 * Public-safe loader returning ONLY the validated published snapshot of a page.
 * Strictly returns `null` for draft, unpublished, trashed, or missing pages.
 */
export async function getPublishedPage(
  tenantDb: D1Database,
  selector: { readonly pageId?: number; readonly slug?: string },
): Promise<PublishedResourceDto<"page"> | null> {
  return getPublishedResource(tenantDb, {
    resourceType: "page",
    resourceId: selector.pageId,
    slug: selector.slug,
  });
}

/**
 * Admin-only private draft preview loader returning separated draft & published snapshots.
 */
export async function getDraftPagePreview(
  tenantDb: D1Database,
  pageId: number,
): Promise<AdminDraftResourceDto<"page"> | null> {
  assertValidPageId(pageId);
  return getDraftResourceForAdmin(tenantDb, {
    resourceType: "page",
    resourceId: pageId,
  });
}

/**
 * Lists pages in the scoped tenant with status filtering and bounded cursor pagination.
 */
export async function listPages(
  tenantDb: D1Database,
  options: ListPagesOptions = {},
): Promise<ListPagesResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const sortOrder = options.sortOrder === "asc" ? "asc" : "desc";
  const status = options.status ?? "all";

  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (status === "trashed") {
    conditions.push("status = 'trashed'");
  } else if (status === "draft" || status === "published") {
    conditions.push("status = ?");
    conditions.push("deleted_at IS NULL");
    binds.push(status);
  } else if (!options.includeTrashed) {
    conditions.push("deleted_at IS NULL");
  }

  if (options.cursor !== undefined && options.cursor.trim() !== "") {
    if (!/^\d+$/.test(options.cursor.trim())) {
      throw new PublicationValidationError("Invalid pagination cursor", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Cursor must be a numeric page ID." },
      ]);
    }
    const cursorId = Number(options.cursor.trim());
    conditions.push(sortOrder === "asc" ? "id > ?" : "id < ?");
    binds.push(cursorId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderSql = sortOrder === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";

  const res = await tenantDb
    .prepare(`SELECT * FROM pages ${whereClause} ${orderSql} LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<RawPageRow>();

  const hasMore = res.results.length > limit;
  const pageRows = hasMore ? res.results.slice(0, limit) : res.results;
  const formerSlugsMap = await fetchFormerSlugsBatch(
    tenantDb,
    pageRows.map((r) => Number(r.id)),
  );

  const items = pageRows.map((row) =>
    mapRowToPageRecord(row, formerSlugsMap.get(Number(row.id)) ?? []),
  );
  const nextCursor =
    hasMore && items.length > 0 ? String(items[items.length - 1]!.id) : null;

  return {
    items,
    page: {
      nextCursor,
      limit,
      hasMore,
    },
  };
}

export interface UpdatePageOptions {
  /**
   * Optional platform DB + tenantId pair so an explicit confirmed slug change on a
   * currently-published page also invalidates edge caches (`PLATFORM_DB.tenants.cache_version`).
   */
  readonly platformDb?: D1Database;
  readonly tenantId?: string;
}

function rewritePublishedEnvelopeSlug(
  rawPublishedJson: string | null,
  newSlug: string,
): string | null {
  if (!rawPublishedJson) return null;
  const parsed = safeJsonParse(rawPublishedJson);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).snapshotVersion === 1 &&
    (parsed as Record<string, unknown>).data &&
    typeof (parsed as Record<string, unknown>).data === "object"
  ) {
    const obj = parsed as Record<string, unknown>;
    return JSON.stringify({
      ...obj,
      data: {
        ...(obj.data as Record<string, unknown>),
        slug: newSlug,
      },
    });
  }
  return rawPublishedJson;
}

/**
 * Saves draft edits to an existing page with optimistic concurrency (`expectedVersion` -> 409):
 * - Draft edits NEVER overwrite published title/sections/seo/layoutMode, `published_at`, or `content_modified_at`.
 * - Free slug edits while `draft` (never published).
 * - After first publication (`published_at != null` or `status = 'published'`), changing the slug
 *   requires explicit `confirmSlugChange: true`, demotes the old `resource_slugs` row to
 *   `is_current = 0`, and inserts the new `is_current = 1` row in ONE atomic `tenantDb.batch([...])`
 *   alongside the version-guarded `UPDATE pages ... WHERE id = ? AND version = ?`.
 */
export async function updatePage(
  tenantDb: D1Database,
  input: UpdatePageInput,
  options: UpdatePageOptions = {},
): Promise<PageRecord> {
  assertNoForbiddenTenantSelectors(input);
  assertValidPageId(input.pageId);
  assertValidExpectedVersion(input.expectedVersion);
  await ensurePagesLayoutModeColumn(tenantDb);

  const nowMs = input.nowMs ?? Date.now();
  const row = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
  if (!row) {
    throw new PublicationNotFoundError("page", input.pageId);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const { draft: currentDraft } = extractDraftStateFromRow(row);
  const nextTitle = input.title !== undefined ? input.title.trim() : currentDraft.title;
  if (!nextTitle) {
    throw new PublicationValidationError("title cannot be empty", [
      { field: "title", code: "REQUIRED", message: "Judul halaman tidak boleh kosong." },
    ]);
  }

  const nextIsHomepage =
    input.isHomepage !== undefined ? input.isHomepage : currentDraft.isHomepage;
  if (typeof nextIsHomepage !== "boolean") {
    throw new PublicationValidationError("isHomepage must be a boolean", [
      { field: "isHomepage", code: "INVALID_TYPE", message: "isHomepage must be a boolean" },
    ]);
  }

  const nextLayoutMode =
    input.layoutMode !== undefined
      ? validatePageLayoutMode(input.layoutMode)
      : currentDraft.layoutMode;

  const nextSections = input.sections !== undefined ? input.sections : currentDraft.sections;
  const nextSeo =
    input.seo !== undefined
      ? validatePageSeoOverrides(input.seo)
      : (currentDraft.seo ?? null);

  const nextSlug =
    input.slug !== undefined
      ? validateManualSlug(input.slug, { namespace: "pages" })
      : currentDraft.slug;

  // Validate complete next draft snapshot BEFORE touching SQLite
  const serialized = serializeDraftStoragePayload("page", {
    slug: nextSlug,
    title: nextTitle,
    isHomepage: nextIsHomepage,
    layoutMode: nextLayoutMode,
    sections: nextSections,
    seo: nextSeo,
  });

  if (nextIsHomepage && Number(row.is_homepage) !== 1) {
    const existingHome = await tenantDb
      .prepare(
        `SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL AND id != ? LIMIT 1`,
      )
      .bind(input.pageId)
      .first<{ readonly id: number }>();
    if (existingHome) {
      throw new PublicationValidationError("Another active page is already designated as homepage", [
        {
          field: "isHomepage",
          code: "HOMEPAGE_ALREADY_SET",
          message: `Halaman #${existingHome.id} sudah menjadi beranda aktif.`,
        },
      ]);
    }
  }

  const wasEverPublished = row.published_at !== null || row.status === "published";
  const slugChanged = nextSlug !== String(row.slug);
  const nextVersion = input.expectedVersion + 1;

  // Build guarded `resource_slugs` statements BEFORE mutating anything. Every statement is
  // gated on `EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ?)` matching
  // Statement 0's newly committed `(id, nextSlug, nextVersion)` so a stale writer is a guaranteed
  // 0-row no-op and any UNIQUE collision aborts & rolls back Statement 0 atomically.
  const slugTransition = slugChanged
    ? await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "pages",
        resourceId: input.pageId,
        oldSlug: String(row.slug),
        newSlug: nextSlug,
        wasEverPublished,
        confirmSlugChange: input.confirmSlugChange,
        allowSelfRevert: false,
        nowMs,
        guard: {
          sql: "EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ? AND deleted_at IS NULL)",
          binds: [input.pageId, nextSlug, nextVersion],
        },
      })
    : null;

  // Build Statement 0 (version-guarded `UPDATE pages ... WHERE id = ? AND version = ?`).
  // Draft isolation: if the page is currently published, ONLY update `draft_sections_json`
  // (plus `slug` and the published snapshot's `data.slug` when an explicit confirmed slug
  // change occurred), leaving published title/sections/seo/layoutMode/timestamps untouched!
  const nextPublishedSectionsJson =
    row.status === "published" && slugChanged
      ? rewritePublishedEnvelopeSlug(row.published_sections_json, nextSlug)
      : row.published_sections_json;

  const updateStmt =
    row.status === "published"
      ? slugChanged
        ? tenantDb
            .prepare(
              `UPDATE pages
               SET slug = ?,
                   draft_sections_json = ?,
                   published_sections_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(
              nextSlug,
              serialized.json,
              nextPublishedSectionsJson,
              nowMs,
              input.pageId,
              input.expectedVersion,
            )
        : tenantDb
            .prepare(
              `UPDATE pages
               SET draft_sections_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(serialized.json, nowMs, input.pageId, input.expectedVersion)
      : tenantDb
          .prepare(
            `UPDATE pages
             SET slug = ?,
                 title = ?,
                 is_homepage = ?,
                 layout_mode = ?,
                 seo_json = ?,
                 draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .bind(
            nextSlug,
            serialized.data.title,
            nextIsHomepage ? 1 : 0,
            nextLayoutMode,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            serialized.json,
            nowMs,
            input.pageId,
            input.expectedVersion,
          );

  const batchStmts: D1PreparedStatement[] = [
    updateStmt,
    ...(slugTransition ? slugTransition.statements : []),
  ];

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Distinguish concurrent stale version (409) from genuine slug/homepage conflict (422)
      const latest = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new StaleRevisionError({
          resourceType: "page",
          resourceId: input.pageId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/pages_single_homepage_idx|is_homepage/i.test(msg)) {
        throw new PublicationValidationError("Another active page is already designated as homepage", [
          {
            field: "isHomepage",
            code: "HOMEPAGE_ALREADY_SET",
            message: "Halaman beranda aktif sudah ditetapkan.",
          },
        ]);
      }
      const suggested = await suggestAlternativeSlug(
        nextSlug,
        (candidate) => isPageSlugTaken(tenantDb, candidate, input.pageId),
        { namespace: "pages" },
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
    const latest = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
    if (!latest) {
      throw new PublicationNotFoundError("page", input.pageId);
    }
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  // If a currently-published page's live slug changed, bump PLATFORM_DB.tenants.cache_version
  // so edge caches immediately serve the new slug and former-slug 308 redirect (fail-closed rollback on failure).
  if (row.status === "published" && slugChanged && options.platformDb && options.tenantId) {
    try {
      await bumpTenantCacheVersion(options.platformDb, options.tenantId, nowMs);
    } catch (platformError) {
      let compensated = false;
      try {
        const rollbackStmts: D1PreparedStatement[] = [
          tenantDb
            .prepare(
              `UPDATE pages
               SET slug = ?,
                   draft_sections_json = ?,
                   published_sections_json = ?,
                   version = ?,
                   updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .bind(
              row.slug,
              row.draft_sections_json,
              row.published_sections_json,
              row.version,
              row.updated_at,
              input.pageId,
              nextVersion,
            ),
          tenantDb
            .prepare(
              `DELETE FROM resource_slugs
               WHERE namespace = 'pages' AND slug = ? AND resource_id = ? AND is_current = 1`,
            )
            .bind(nextSlug, input.pageId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET is_current = 1, redirect_target_slug = NULL, updated_at = ?
               WHERE namespace = 'pages' AND slug = ? AND resource_id = ?`,
            )
            .bind(row.updated_at, row.slug, input.pageId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET redirect_target_slug = ?, updated_at = ?
               WHERE namespace = 'pages' AND resource_id = ? AND is_current = 0`,
            )
            .bind(row.slug, row.updated_at, input.pageId),
        ];
        const restoreRes = await tenantDb.batch(rollbackStmts);
        compensated = (restoreRes[0]?.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation failed; compensated remains false
      }
      throw new PublicationAtomicError(
        `Failed to bump tenant cache_version after published page slug change${
          compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
        }`,
        { compensated, cause: platformError },
      );
    }
  }

  const updated = await getPageById(tenantDb, input.pageId);
  if (!updated) {
    throw new Error(`Failed to reload updated page #${input.pageId}`);
  }
  return updated;
}

/**
 * Atomically publishes a page's current draft snapshot, records a content revision,
 * syncs `pages.layout_mode` and `resource_slugs` guarded by the newly committed version,
 * and bumps `PLATFORM_DB.tenants.cache_version`.
 */
export async function publishPage(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: PublishPageInput,
): Promise<PublishPageResult> {
  assertValidPageId(input.pageId);
  assertValidExpectedVersion(input.expectedVersion);
  await ensurePagesLayoutModeColumn(tenantDb);

  const nowMs = input.nowMs ?? Date.now();
  const priorRow = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
  if (!priorRow) {
    throw new PublicationNotFoundError("page", input.pageId);
  }
  if (Number(priorRow.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(priorRow.version),
    });
  }

  const { draft } = extractDraftStateFromRow(priorRow);
  const wasEverPublished = priorRow.published_at !== null || priorRow.status === "published";
  const slugChanged = draft.slug !== String(priorRow.slug);
  const swappedVersion = input.expectedVersion + 1;

  // Pre-validate slug rules & build guarded `resource_slugs` statements BEFORE mutating anything.
  // Executing `publishResourceAtomically` FIRST guarantees zero orphan `resource_slugs` rows if
  // `expectedVersion` is stale (409), validation fails (422), or `PLATFORM_DB` fails (503).
  const slugTransition = slugChanged
    ? await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "pages",
        resourceId: input.pageId,
        oldSlug: String(priorRow.slug),
        newSlug: draft.slug,
        wasEverPublished,
        confirmSlugChange: input.confirmSlugChange,
        allowSelfRevert: false,
        nowMs,
        guard: {
          sql: "EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ? AND deleted_at IS NULL)",
          binds: [input.pageId, draft.slug, swappedVersion],
        },
      })
    : null;

  const published = await publishResourceAtomically(platformDb, tenantDb, {
    tenantId: input.tenantId,
    resourceType: "page",
    resourceId: input.pageId,
    expectedVersion: input.expectedVersion,
    actorUserId: input.actorUserId,
    nowMs,
  });

  // Atomically sync `pages.layout_mode` and `resource_slugs` gated on the exact published `(id, slug, version)`
  const postPublishStmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(`UPDATE pages SET layout_mode = ? WHERE id = ? AND version = ?`)
      .bind(published.publishedSnapshot.data.layoutMode, input.pageId, published.version),
  ];

  if (slugTransition && slugTransition.statements.length > 0) {
    postPublishStmts.push(...slugTransition.statements);
  } else {
    const existingSlug = await findResourceSlug(tenantDb, "pages", draft.slug);
    if (!existingSlug) {
      postPublishStmts.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             SELECT 'pages', ?, ?, 1, NULL, ?
             WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ? AND deleted_at IS NULL)`,
          )
          .bind(draft.slug, input.pageId, nowMs, input.pageId, draft.slug, published.version),
      );
    }
  }

  await tenantDb.batch(postPublishStmts);

  const page = await getPageById(tenantDb, input.pageId);
  if (!page) {
    throw new Error(`Failed to reload published page #${input.pageId}`);
  }
  return {
    page,
    cacheVersion: published.cacheVersion,
    revisionNumber: published.revisionNumber,
  };
}

/**
 * Atomically unpublishes a live page back to `draft` and bumps `PLATFORM_DB.tenants.cache_version`.
 */
export async function unpublishPage(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: UnpublishPageInput,
): Promise<UnpublishPageResult> {
  assertValidPageId(input.pageId);
  assertValidExpectedVersion(input.expectedVersion);

  const result = await unpublishResourceAtomically(platformDb, tenantDb, {
    tenantId: input.tenantId,
    resourceType: "page",
    resourceId: input.pageId,
    expectedVersion: input.expectedVersion,
    nowMs: input.nowMs,
  });

  const page = await getPageById(tenantDb, input.pageId);
  if (!page) {
    throw new Error(`Failed to reload unpublished page #${input.pageId}`);
  }
  return {
    page,
    cacheVersion: result.cacheVersion,
  };
}

/**
 * Soft-deletes (trashes) a page: unpublishes public snapshot, sets `status = 'trashed'` and
 * `deleted_at = nowMs`, never reuses its sequential ID, and bumps `tenants.cache_version` if
 * it was previously published (with fail-closed compensation).
 */
export async function trashPage(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: TrashPageInput,
): Promise<TrashPageResult> {
  assertValidPageId(input.pageId);
  if (input.expectedVersion !== undefined) {
    assertValidExpectedVersion(input.expectedVersion);
  }
  const nowMs = input.nowMs ?? Date.now();

  const priorRow = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
  if (!priorRow) {
    throw new PublicationNotFoundError("page", input.pageId);
  }

  const targetVersion = input.expectedVersion ?? Number(priorRow.version);
  if (Number(priorRow.version) !== targetVersion) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: targetVersion,
      actualVersion: Number(priorRow.version),
    });
  }

  const wasPublished =
    priorRow.status === "published" || priorRow.published_sections_json !== null;

  const updateRes = await tenantDb
    .prepare(
      `UPDATE pages
       SET status = 'trashed',
           published_sections_json = NULL,
           deleted_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(nowMs, nowMs, input.pageId, targetVersion)
    .run();

  if ((updateRes.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: false });
    if (!latest) {
      throw new PublicationNotFoundError("page", input.pageId);
    }
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: targetVersion,
      actualVersion: Number(latest.version),
    });
  }

  let cacheVersion: number | null = null;
  if (wasPublished) {
    const swappedVersion = targetVersion + 1;
    try {
      cacheVersion = await bumpTenantCacheVersion(platformDb, input.tenantId, nowMs);
    } catch (platformError) {
      let compensated = false;
      try {
        const restoreRes = await tenantDb
          .prepare(
            `UPDATE pages
             SET status = ?,
                 published_sections_json = ?,
                 deleted_at = NULL,
                 version = ?,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            priorRow.status,
            priorRow.published_sections_json,
            priorRow.version,
            priorRow.updated_at,
            input.pageId,
            swappedVersion,
          )
          .run();
        compensated = (restoreRes.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation failed; compensated remains false
      }
      throw new PublicationAtomicError(
        `Failed to bump tenant cache_version during page trash${
          compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
        }`,
        { compensated, cause: platformError },
      );
    }
  }

  const trashed = await getPageById(tenantDb, input.pageId, { includeTrashed: true });
  if (!trashed) {
    throw new Error(`Failed to reload trashed page #${input.pageId}`);
  }
  return { page: trashed, cacheVersion };
}

/**
 * Restores a trashed page back into `draft` state only (never auto-publishes; PLAN §5.2).
 */
export async function restorePage(
  tenantDb: D1Database,
  input: RestorePageInput,
): Promise<PageRecord> {
  assertValidPageId(input.pageId);
  assertValidExpectedVersion(input.expectedVersion);
  const nowMs = input.nowMs ?? Date.now();

  const row = await tenantDb
    .prepare(`SELECT * FROM pages WHERE id = ? AND status = 'trashed' AND deleted_at IS NOT NULL LIMIT 1`)
    .bind(input.pageId)
    .first<RawPageRow>();

  if (!row) {
    throw new PublicationNotFoundError("page", input.pageId);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const { draft } = extractDraftStateFromRow(row);
  let nextSlug = String(row.slug);
  let nextDraftJson = row.draft_sections_json;
  const nextVersion = input.expectedVersion + 1;

  let slugTransition: Awaited<ReturnType<typeof buildFormerSlugTransitionStatements>> | null = null;
  if (input.resolvedSlug !== undefined) {
    const validated = validateManualSlug(input.resolvedSlug, { namespace: "pages" });
    if (validated !== nextSlug) {
      slugTransition = await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "pages",
        resourceId: input.pageId,
        oldSlug: nextSlug,
        newSlug: validated,
        wasEverPublished: row.published_at !== null,
        confirmSlugChange: true,
        allowSelfRevert: false,
        nowMs,
        guard: {
          sql: "EXISTS (SELECT 1 FROM pages WHERE id = ? AND slug = ? AND version = ? AND deleted_at IS NULL)",
          binds: [input.pageId, validated, nextVersion],
        },
      });
      nextSlug = validated;
      nextDraftJson = serializeDraftStoragePayload("page", {
        ...draft,
        slug: nextSlug,
      }).json;
    }
  }

  // If another active homepage was set while this page was trashed, demote `is_homepage` safely
  let nextIsHomepage = Number(row.is_homepage) === 1;
  if (nextIsHomepage) {
    const activeHome = await tenantDb
      .prepare(`SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1`)
      .first<{ readonly id: number }>();
    if (activeHome) {
      nextIsHomepage = false;
      nextDraftJson = serializeDraftStoragePayload("page", {
        ...draft,
        slug: nextSlug,
        isHomepage: false,
      }).json;
    }
  }

  const batchStmts: D1PreparedStatement[] = [
    tenantDb
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
         WHERE id = ? AND version = ? AND status = 'trashed'`,
      )
      .bind(nextSlug, nextIsHomepage ? 1 : 0, nextDraftJson, nowMs, input.pageId, input.expectedVersion),
    ...(slugTransition ? slugTransition.statements : []),
  ];

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const latest = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: true });
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new StaleRevisionError({
          resourceType: "page",
          resourceId: input.pageId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const suggested = await suggestAlternativeSlug(
        nextSlug,
        (candidate) => isPageSlugTaken(tenantDb, candidate, input.pageId),
        { namespace: "pages" },
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
    const latest = await fetchRawPageRow(tenantDb, input.pageId, { includeTrashed: true });
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: input.pageId,
      expectedVersion: input.expectedVersion,
      actualVersion: latest ? Number(latest.version) : null,
    });
  }

  const restored = await getPageById(tenantDb, input.pageId);
  if (!restored) {
    throw new Error(`Failed to reload restored page #${input.pageId}`);
  }
  return restored;
}

/**
 * Lists up to the latest 20 published revisions for a page.
 */
export async function listPageRevisions(
  tenantDb: D1Database,
  pageId: number,
): Promise<readonly PageRevisionSummary[]> {
  assertValidPageId(pageId);
  const exists = await fetchRawPageRow(tenantDb, pageId, { includeTrashed: true });
  if (!exists) {
    throw new PublicationNotFoundError("page", pageId);
  }

  const res = await tenantDb
    .prepare(
      `SELECT revision_number, snapshot_json, created_by, created_at
       FROM content_revisions
       WHERE resource_type = 'page' AND resource_id = ?
       ORDER BY revision_number DESC
       LIMIT 20`,
    )
    .bind(pageId)
    .all<{
      readonly revision_number: number;
      readonly snapshot_json: string;
      readonly created_by: string | null;
      readonly created_at: number;
    }>();

  return res.results.map((r) => {
    const parsed = safeJsonParse(r.snapshot_json) as { data?: { title?: string; slug?: string } } | null;
    const title = parsed?.data?.title ?? exists.title;
    const slug = parsed?.data?.slug ?? exists.slug;
    return {
      revisionNumber: Number(r.revision_number),
      createdByUserId: r.created_by ?? null,
      createdAt: new Date(Number(r.created_at)).toISOString(),
      summary: `Published "${title}" (/${slug})`,
    };
  });
}
