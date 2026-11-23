import {
  assertNoForbiddenTenantSelectors,
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  htmlToRestrictedRichTextDoc,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  renderRichTextDocToSanitizedHtml,
  sanitizeRichTextDoc,
  sanitizeRichTextHtml,
  serializeDraftStoragePayload,
  StaleRevisionError,
  validatePageSeoOverrides,
  type AdminDraftResourceDto,
  type PageSeoOverrides,
  type PostSnapshot,
  type PublicationValidationField,
  type PublishedResourceDto,
  type ResourceLifecycleStatus,
  type RestrictedRichTextDoc,
  type TocHeadingEntry,
} from "@punyasitus/core/content/index";
import {
  calculateLinearReadingTimeMinutes,
  extractAndInjectServerToc,
  resolvePublishedContentModifiedAt,
} from "@punyasitus/core/posts/index";
import { RestrictedRichTextDocSchema } from "@punyasitus/core/schemas";
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
  unpublishResourceAtomically,
} from "../publication/index.ts";
import { buildAppendRevisionStatements } from "../revisions/append.ts";
import { hasContentRevisionHistoryColumns } from "../revisions/migrations.ts";
import { buildRevisionSummaryText } from "../revisions/validation.ts";

export * from "./authors.ts";
export * from "./migrations.ts";
export * from "./taxonomies.ts";

/**
 * Per-Tenant Blog Posts Repository (`packages/db/src/posts/index.ts`;
 * TASK-006, REQ-009, REQ-034, REQ-036, REQ-061).
 *
 * Operates strictly against the verified tenant's physically isolated `TenantStore`
 * SQLite Durable Object and coordinates active-member author verification & cache
 * invalidation with `PLATFORM_DB`.
 */

interface RawPostRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly draft_body_json: string;
  readonly published_body_json: string | null;
  readonly primary_category_id: number | null;
  readonly author_id: number | null;
  readonly cover_media_id: number | null;
  readonly reading_time_minutes: number;
  readonly show_toc: number;
  readonly seo_json: string | null;
  readonly status: ResourceLifecycleStatus;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly content_fingerprint?: string | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PostRecord {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly status: ResourceLifecycleStatus;
  readonly body: RestrictedRichTextDoc;
  readonly sanitizedHtml: string;
  readonly toc: readonly TocHeadingEntry[];
  readonly readingTimeMinutes: number;
  readonly featuredMediaId: number | null;
  readonly coverMediaId: number | null;
  readonly primaryCategoryId: number | null;
  readonly categoryIds: readonly number[];
  readonly tagIds: readonly number[];
  readonly authorId: number | null;
  readonly authorProfileId: number | null;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
  readonly enableToc: boolean;
  readonly showToc: boolean;
  readonly tocEnabled: boolean;
  readonly seo: PageSeoOverrides | null;
  readonly published: PostSnapshot | null;
  readonly hasUnpublishedChanges: boolean;
  readonly formerSlugs: readonly string[];
  readonly version: number;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly contentFingerprint: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PostAuthorScope {
  readonly platformDb?: D1Database;
  readonly organizationId?: string;
  readonly actorUserId: string;
}

export interface CreatePostInput {
  readonly title: string;
  readonly slug?: string;
  readonly excerpt?: string | null;
  readonly body?: unknown;
  readonly bodyHtml?: string;
  readonly featuredMediaId?: number | null;
  readonly coverMediaId?: number | null;
  readonly primaryCategoryId?: number | null;
  readonly categoryIds?: readonly number[];
  readonly tagIds?: readonly number[];
  readonly authorId?: number | null;
  readonly authorProfileId?: number | null;
  readonly authorUserId?: string | null;
  readonly authorName?: string | null;
  readonly enableToc?: boolean;
  readonly showToc?: boolean;
  readonly tocEnabled?: boolean;
  readonly seo?: unknown;
  readonly nowMs?: number;
}

export interface UpdatePostInput {
  readonly postId: number;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly slug?: string;
  readonly confirmSlugChange?: boolean;
  readonly excerpt?: string | null;
  readonly body?: unknown;
  readonly bodyHtml?: string;
  readonly featuredMediaId?: number | null;
  readonly coverMediaId?: number | null;
  readonly primaryCategoryId?: number | null;
  readonly categoryIds?: readonly number[];
  readonly tagIds?: readonly number[];
  readonly authorId?: number | null;
  readonly authorProfileId?: number | null;
  readonly authorUserId?: string | null;
  readonly authorName?: string | null;
  readonly enableToc?: boolean;
  readonly showToc?: boolean;
  readonly tocEnabled?: boolean;
  readonly seo?: unknown;
  readonly nowMs?: number;
}

export interface UpdatePostOptions {
  readonly platformDb?: D1Database;
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly actorUserId?: string;
}

export interface PublishPostInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly postId: number;
  readonly expectedVersion: number;
  readonly confirmSlugChange?: boolean;
  readonly actorUserId?: string | null;
  readonly nowMs?: number;
}

export interface PublishPostResult {
  readonly post: PostRecord;
  readonly cacheVersion: number;
  readonly revisionNumber: number | null;
  readonly substantiveChanged: boolean;
  readonly contentFingerprint: string;
}

export interface UnpublishPostInput {
  readonly tenantId: string;
  readonly postId: number;
  readonly expectedVersion: number;
  readonly nowMs?: number;
}

export interface UnpublishPostResult {
  readonly post: PostRecord;
  readonly cacheVersion: number;
}

export interface TrashPostInput {
  readonly tenantId: string;
  readonly postId: number;
  readonly expectedVersion?: number;
  readonly nowMs?: number;
}

export interface TrashPostResult {
  readonly post: PostRecord;
  readonly cacheVersion: number | null;
}

export interface RestorePostInput {
  readonly postId: number;
  readonly expectedVersion: number;
  readonly resolvedSlug?: string;
  readonly nowMs?: number;
}

export interface ListPostsOptions {
  readonly status?: ResourceLifecycleStatus | "all";
  readonly includeTrashed?: boolean;
  readonly categoryId?: number;
  readonly tagId?: number;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sortOrder?: "asc" | "desc";
}

export interface ListPostsResult {
  readonly items: readonly PostRecord[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export interface PostRevisionSummary {
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

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertValidPostId(postId: number): void {
  if (!Number.isSafeInteger(postId) || postId < 1 || postId > 2_147_483_647) {
    throw new PublicationValidationError("postId must be a positive integer", [
      { field: "postId", code: "INVALID_POST_ID", message: "postId must be a positive integer" },
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

function assertValidPositiveId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new PublicationValidationError(`${field} must be a positive integer`, [
      { field, code: "INVALID_ID", message: `${field} must be a positive integer` },
    ]);
  }
  return value;
}

function normalizeIdArray(raw: unknown, field: string, maxLen: number): number[] {
  if (!Array.isArray(raw)) {
    throw new PublicationValidationError(`${field} must be an array of positive integers`, [
      { field, code: "INVALID_TYPE", message: `${field} must be an array` },
    ]);
  }
  if (raw.length > maxLen) {
    throw new PublicationValidationError(`${field} exceeds maximum length of ${maxLen}`, [
      { field, code: "TOO_MANY_ITEMS", message: `${field} maksimal ${maxLen} item.` },
    ]);
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const id = assertValidPositiveId(raw[i], `${field}[${i}]`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function resolveCoverMediaIdInput(
  featuredMediaId: number | null | undefined,
  coverMediaId: number | null | undefined,
): { readonly supplied: boolean; readonly value: number | null } {
  const hasFeatured = featuredMediaId !== undefined;
  const hasCover = coverMediaId !== undefined;
  if (hasFeatured && hasCover && featuredMediaId !== coverMediaId) {
    throw new PublicationValidationError("featuredMediaId and coverMediaId must match when both are provided", [
      {
        field: "featuredMediaId",
        code: "CONFLICTING_FIELDS",
        message: "featuredMediaId dan coverMediaId harus sama jika keduanya dikirim.",
      },
    ]);
  }
  if (!hasFeatured && !hasCover) {
    return { supplied: false, value: null };
  }
  const chosen = hasFeatured ? featuredMediaId : coverMediaId;
  if (chosen === null) {
    return { supplied: true, value: null };
  }
  return { supplied: true, value: assertValidPositiveId(chosen, hasFeatured ? "featuredMediaId" : "coverMediaId") };
}

function resolveShowTocInput(
  enableToc: boolean | undefined,
  showToc: boolean | undefined,
  tocEnabled?: boolean | undefined,
): { readonly supplied: boolean; readonly value: boolean } {
  const candidates: Array<{ readonly field: string; readonly val: boolean }> = [];
  if (enableToc !== undefined) {
    if (typeof enableToc !== "boolean") {
      throw new PublicationValidationError("enableToc must be a boolean", [
        { field: "enableToc", code: "INVALID_TYPE", message: "enableToc harus berupa boolean." },
      ]);
    }
    candidates.push({ field: "enableToc", val: enableToc });
  }
  if (showToc !== undefined) {
    if (typeof showToc !== "boolean") {
      throw new PublicationValidationError("showToc must be a boolean", [
        { field: "showToc", code: "INVALID_TYPE", message: "showToc harus berupa boolean." },
      ]);
    }
    candidates.push({ field: "showToc", val: showToc });
  }
  if (tocEnabled !== undefined) {
    if (typeof tocEnabled !== "boolean") {
      throw new PublicationValidationError("tocEnabled must be a boolean", [
        { field: "tocEnabled", code: "INVALID_TYPE", message: "tocEnabled harus berupa boolean." },
      ]);
    }
    candidates.push({ field: "tocEnabled", val: tocEnabled });
  }
  if (candidates.length === 0) return { supplied: false, value: false };
  const firstVal = candidates[0]!.val;
  if (candidates.some((c) => c.val !== firstVal)) {
    throw new PublicationValidationError("enableToc, showToc, and tocEnabled must match when provided", [
      {
        field: "tocEnabled",
        code: "CONFLICTING_FIELDS",
        message: "enableToc, showToc, dan tocEnabled harus bernilai sama.",
      },
    ]);
  }
  return { supplied: true, value: firstVal };
}

function resolveAuthorIdInput(
  authorId: number | null | undefined,
  authorProfileId: number | null | undefined,
): number | null | undefined {
  if (authorId !== undefined && authorProfileId !== undefined && authorId !== authorProfileId) {
    throw new PublicationValidationError("authorId and authorProfileId must match when both are provided", [
      {
        field: "authorProfileId",
        code: "CONFLICTING_FIELDS",
        message: "authorId dan authorProfileId harus bernilai sama jika keduanya dikirim.",
      },
    ]);
  }
  return authorId !== undefined ? authorId : authorProfileId;
}

function validateExcerpt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new PublicationValidationError("excerpt must be a string or null", [
      { field: "excerpt", code: "INVALID_TYPE", message: "Ringkasan artikel harus berupa string atau null." },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed.length > 500) {
    throw new PublicationValidationError("excerpt must be at most 500 characters", [
      { field: "excerpt", code: "INVALID_LENGTH", message: "Ringkasan artikel maksimal 500 karakter." },
    ]);
  }
  if (hasControlChars(trimmed) || /<\s*\/?\s*(?:script|iframe|style|object|embed|svg)\b/i.test(trimmed)) {
    throw new PublicationValidationError("excerpt contains disallowed characters or tags", [
      {
        field: "excerpt",
        code: "INVALID_CHARACTERS",
        message: "Ringkasan artikel mengandung tag atau karakter tidak diizinkan.",
      },
    ]);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePostBodyInput(params: {
  readonly body?: unknown;
  readonly bodyHtml?: unknown;
}): {
  readonly body: RestrictedRichTextDoc;
  readonly sanitizedHtml: string;
  readonly readingTimeMinutes: number;
} {
  if (params.bodyHtml !== undefined && typeof params.bodyHtml !== "string") {
    throw new PublicationValidationError("bodyHtml must be a string", [
      { field: "bodyHtml", code: "INVALID_TYPE", message: "bodyHtml harus berupa string HTML." },
    ]);
  }

  if (typeof params.bodyHtml === "string") {
    const sanitizedHtml = sanitizeRichTextHtml(params.bodyHtml);
    const derivedBody = htmlToRestrictedRichTextDoc(sanitizedHtml);
    const readingTimeMinutes = calculateLinearReadingTimeMinutes(sanitizedHtml);
    return { body: derivedBody, sanitizedHtml, readingTimeMinutes };
  }

  if (typeof params.body === "string") {
    const sanitizedHtml = sanitizeRichTextHtml(params.body);
    const derivedBody = htmlToRestrictedRichTextDoc(sanitizedHtml);
    const readingTimeMinutes = calculateLinearReadingTimeMinutes(sanitizedHtml);
    return { body: derivedBody, sanitizedHtml, readingTimeMinutes };
  }

  if (params.body !== undefined) {
    const parsed = RestrictedRichTextDocSchema.safeParse(params.body);
    if (!parsed.success) {
      const fields: PublicationValidationField[] = parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? `body.${issue.path.join(".")}` : "body",
        code: issue.code.toUpperCase(),
        message: issue.message,
      }));
      throw new PublicationValidationError("Invalid rich-text post body", fields);
    }
    const cleanBody = sanitizeRichTextDoc(parsed.data);
    const sanitizedHtml = renderRichTextDocToSanitizedHtml(cleanBody);
    const readingTimeMinutes = calculateLinearReadingTimeMinutes(sanitizedHtml || cleanBody);
    return { body: cleanBody, sanitizedHtml, readingTimeMinutes };
  }

  return {
    body: { schemaVersion: 1, blocks: [] },
    sanitizedHtml: "",
    readingTimeMinutes: 1,
  };
}

/**
 * Validates all media references owned by THIS tenant's `TenantStore.media_items`:
 * - Always rejects missing, cross-tenant, non-image, trashed (`deleted_at != null`),
 *   `failed`, or `quarantined` media (`422 MEDIA_NOT_FOUND`).
 * - When `requireReady: true` (publish time), also rejects `processing` media (`422 MEDIA_NOT_READY`).
 */
export async function verifyOwnedPostMediaIds(
  tenantDb: D1Database,
  refs: {
    readonly coverMediaId?: number | null;
    readonly ogImageMediaId?: number | null;
    readonly bodyMediaIds?: readonly number[];
  },
  options: { readonly requireReady?: boolean } = {},
): Promise<void> {
  const checks: Array<{ readonly field: string; readonly mediaId: number }> = [];
  const uniqueIds = new Set<number>();

  if (refs.coverMediaId !== undefined && refs.coverMediaId !== null) {
    checks.push({ field: "featuredMediaId", mediaId: refs.coverMediaId });
    uniqueIds.add(refs.coverMediaId);
  }
  if (refs.ogImageMediaId !== undefined && refs.ogImageMediaId !== null) {
    checks.push({ field: "seo.ogImageMediaId", mediaId: refs.ogImageMediaId });
    uniqueIds.add(refs.ogImageMediaId);
  }
  if (refs.bodyMediaIds) {
    for (let i = 0; i < refs.bodyMediaIds.length; i += 1) {
      const mid = refs.bodyMediaIds[i]!;
      checks.push({ field: `body.blocks[${i}].mediaId`, mediaId: mid });
      uniqueIds.add(mid);
    }
  }

  if (uniqueIds.size === 0) return;

  const ids = [...uniqueIds];
  const placeholders = ids.map(() => "?").join(", ");
  // `SELECT *` works seamlessly whether 0002_media_upload_pipeline (`deleted_at`) was applied or only 0001_initial_tenant
  const res = await tenantDb
    .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{
      readonly id: number;
      readonly kind: string;
      readonly status: string;
      readonly deleted_at?: number | null;
    }>();

  const rowById = new Map<
    number,
    { readonly kind: string; readonly status: string; readonly deletedAt: number | null }
  >();
  for (const row of res.results) {
    rowById.set(Number(row.id), {
      kind: String(row.kind),
      status: String(row.status),
      deletedAt: row.deleted_at !== undefined && row.deleted_at !== null ? Number(row.deleted_at) : null,
    });
  }

  const errors: PublicationValidationField[] = [];
  for (const check of checks) {
    const media = rowById.get(check.mediaId);
    if (
      !media ||
      media.kind !== "image" ||
      media.deletedAt !== null ||
      media.status === "failed" ||
      media.status === "quarantined"
    ) {
      errors.push({
        field: check.field,
        code: "MEDIA_NOT_FOUND",
        message: `Media #${check.mediaId} tidak ditemukan atau tidak valid sebagai gambar aktif milik tenant ini.`,
      });
    } else if (options.requireReady && media.status !== "ready") {
      errors.push({
        field: check.field,
        code: "MEDIA_NOT_READY",
        message: `Media #${check.mediaId} masih dalam status "${media.status}" dan belum siap dipublikasikan.`,
      });
    }
  }

  if (errors.length > 0) {
    throw new PublicationValidationError(
      options.requireReady
        ? "One or more referenced post media items are missing or not ready for publication."
        : "One or more referenced post media items were not found in this tenant.",
      errors,
    );
  }
}

/**
 * Validates that every category ID belongs to THIS tenant as `post_category`
 * and every tag ID belongs to THIS tenant as `post_tag`.
 */
async function verifyOwnedPostTaxonomies(
  tenantDb: D1Database,
  params: {
    readonly primaryCategoryId: number | null;
    readonly categoryIds: readonly number[];
    readonly tagIds: readonly number[];
  },
): Promise<{ readonly categoryIds: number[]; readonly tagIds: number[] }> {
  const categorySet = new Set<number>(params.categoryIds);
  if (params.primaryCategoryId !== null) {
    categorySet.add(params.primaryCategoryId);
  }
  const uniqueCategoryIds = [...categorySet];
  if (uniqueCategoryIds.length > 10) {
    throw new PublicationValidationError("A post can have at most 10 categories", [
      { field: "categoryIds", code: "TOO_MANY_ITEMS", message: "Maksimal 10 kategori per artikel." },
    ]);
  }
  const uniqueTagIds = [...new Set<number>(params.tagIds)];

  const allIds = [...new Set<number>([...uniqueCategoryIds, ...uniqueTagIds])];
  if (allIds.length === 0) {
    return { categoryIds: [], tagIds: [] };
  }

  const placeholders = allIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT id, taxonomy_type
       FROM taxonomies
       WHERE id IN (${placeholders})`,
    )
    .bind(...allIds)
    .all<{ readonly id: number; readonly taxonomy_type: string }>();

  const typeById = new Map<number, string>();
  for (const row of res.results) {
    typeById.set(Number(row.id), String(row.taxonomy_type));
  }

  const errors: PublicationValidationField[] = [];
  if (params.primaryCategoryId !== null && typeById.get(params.primaryCategoryId) !== "post_category") {
    errors.push({
      field: "primaryCategoryId",
      code: "CATEGORY_NOT_FOUND",
      message: `Kategori utama #${params.primaryCategoryId} tidak ditemukan sebagai kategori blog milik tenant ini.`,
    });
  }
  for (const cid of uniqueCategoryIds) {
    if (cid === params.primaryCategoryId) continue;
    if (typeById.get(cid) !== "post_category") {
      errors.push({
        field: "categoryIds",
        code: "CATEGORY_NOT_FOUND",
        message: `Kategori #${cid} tidak ditemukan sebagai kategori blog milik tenant ini.`,
      });
    }
  }
  for (const tid of uniqueTagIds) {
    if (typeById.get(tid) !== "post_tag") {
      errors.push({
        field: "tagIds",
        code: "TAG_NOT_FOUND",
        message: `Tag #${tid} tidak ditemukan sebagai tag blog milik tenant ini.`,
      });
    }
  }

  if (errors.length > 0) {
    throw new PublicationValidationError(
      "One or more referenced categories or tags do not belong to this tenant.",
      errors,
    );
  }

  return { categoryIds: uniqueCategoryIds, tagIds: uniqueTagIds };
}

/**
 * Validates and resolves author attribution strictly within the current tenant:
 * - `authorUserId` defaults to the authenticated session user (`actorUserId`).
 * - If an explicit `authorUserId` is passed, verifies active membership in `PLATFORM_DB.members`
 *   for `organizationId` (NEVER allows forging a cross-tenant or non-member user ID!).
 * - If an explicit `authorId` (sequential integer) is passed, verifies it exists in THIS tenant's
 *   `TenantStore.authors` table.
 */
async function resolveAndValidatePostAuthor(
  tenantDb: D1Database,
  params: {
    readonly authorId?: number | null;
    readonly authorUserId?: string | null;
    readonly authorName?: string | null;
    readonly fallbackAuthorId?: number | null;
    readonly fallbackAuthorUserId?: string | null;
    readonly fallbackAuthorName?: string | null;
    readonly scope?: PostAuthorScope;
  },
): Promise<{
  readonly authorId: number | null;
  readonly authorUserId: string | null;
  readonly authorName: string | null;
}> {
  let authorId: number | null =
    params.authorId !== undefined ? params.authorId : (params.fallbackAuthorId ?? null);
  let resolvedAuthorName: string | null =
    params.authorName !== undefined ? params.authorName : (params.fallbackAuthorName ?? null);

  if (resolvedAuthorName !== null) {
    if (typeof resolvedAuthorName !== "string") {
      throw new PublicationValidationError("authorName must be a string or null", [
        { field: "authorName", code: "INVALID_TYPE", message: "authorName harus berupa string atau null." },
      ]);
    }
    const clean = resolvedAuthorName.trim();
    if (clean.length > 120 || hasControlChars(clean) || /<\s*\/?\s*(?:script|iframe|style|svg)\b/i.test(clean)) {
      throw new PublicationValidationError("Invalid authorName", [
        { field: "authorName", code: "INVALID_AUTHOR_NAME", message: "Nama penulis tidak valid." },
      ]);
    }
    resolvedAuthorName = clean.length > 0 ? clean : null;
  }

  if (authorId !== null) {
    authorId = assertValidPositiveId(authorId, "authorId");
    const authorRow = await tenantDb
      .prepare(`SELECT id, name FROM authors WHERE id = ? LIMIT 1`)
      .bind(authorId)
      .first<{ readonly id: number; readonly name: string }>();
    if (!authorRow) {
      throw new PublicationValidationError("Author profile not found in this tenant", [
        {
          field: "authorId",
          code: "AUTHOR_NOT_FOUND",
          message: `Profil penulis #${authorId} tidak ditemukan di tenant ini.`,
        },
      ]);
    }
    if (!resolvedAuthorName) {
      resolvedAuthorName = String(authorRow.name);
    }
  }

  let authorUserId: string | null;
  if (params.authorUserId !== undefined) {
    if (params.authorUserId === null) {
      authorUserId = params.scope?.actorUserId ?? null;
    } else if (typeof params.authorUserId !== "string" || params.authorUserId.trim().length === 0) {
      throw new PublicationValidationError("authorUserId must be a non-empty string", [
        { field: "authorUserId", code: "INVALID_AUTHOR", message: "authorUserId tidak valid." },
      ]);
    } else {
      const candidateUserId = params.authorUserId.trim();
      if (candidateUserId.length > 64 || hasControlChars(candidateUserId)) {
        throw new PublicationValidationError("authorUserId is malformed", [
          { field: "authorUserId", code: "INVALID_AUTHOR", message: "authorUserId tidak valid." },
        ]);
      }

      if (params.scope?.platformDb && params.scope.organizationId) {
        const memberRow = await params.scope.platformDb
          .prepare(
            `SELECT u.id AS user_id, u.name AS user_name
             FROM members m
             JOIN users u ON u.id = m.user_id
             WHERE m.organization_id = ? AND m.user_id = ?
             LIMIT 1`,
          )
          .bind(params.scope.organizationId, candidateUserId)
          .first<{ readonly user_id: string; readonly user_name: string }>();

        if (!memberRow) {
          throw new PublicationValidationError(
            "Specified authorUserId is not an active member of this tenant",
            [
              {
                field: "authorUserId",
                code: "AUTHOR_NOT_FOUND",
                message: "Penulis yang dipilih bukan anggota aktif tenant ini.",
              },
            ],
          );
        }
        authorUserId = String(memberRow.user_id);
        if (!resolvedAuthorName && memberRow.user_name) {
          resolvedAuthorName = String(memberRow.user_name).trim().slice(0, 120) || null;
        }
      } else if (params.scope && candidateUserId !== params.scope.actorUserId) {
        // Fail closed: never accept another user ID without verifying active tenant membership
        throw new PublicationValidationError(
          "Cannot assign another authorUserId without active tenant membership verification",
          [
            {
              field: "authorUserId",
              code: "AUTHOR_NOT_FOUND",
              message: "Tidak dapat menetapkan penulis lain tanpa verifikasi keanggotaan tenant.",
            },
          ],
        );
      } else {
        authorUserId = candidateUserId;
      }
    }
  } else {
    authorUserId = params.fallbackAuthorUserId ?? params.scope?.actorUserId ?? null;
    if (
      authorUserId &&
      !resolvedAuthorName &&
      params.scope?.platformDb &&
      params.scope.organizationId
    ) {
      const actorRow = await params.scope.platformDb
        .prepare(
          `SELECT u.name AS user_name
           FROM members m
           JOIN users u ON u.id = m.user_id
           WHERE m.organization_id = ? AND m.user_id = ?
           LIMIT 1`,
        )
        .bind(params.scope.organizationId, authorUserId)
        .first<{ readonly user_name: string }>();
      if (actorRow?.user_name) {
        resolvedAuthorName = String(actorRow.user_name).trim().slice(0, 120) || null;
      }
    }
  }

  return {
    authorId,
    authorUserId,
    authorName: resolvedAuthorName,
  };
}

function extractBodyMediaIds(body: RestrictedRichTextDoc): number[] {
  const ids: number[] = [];
  for (const block of body.blocks) {
    if (block.type === "image" && block.mediaId !== undefined) {
      ids.push(block.mediaId);
    }
  }
  return ids;
}

function extractPostDraftStateFromRow(
  row: RawPostRow,
  joinTaxonomies: { readonly categoryIds: readonly number[]; readonly tagIds: readonly number[] },
): {
  readonly draft: PostSnapshot;
  readonly published: PostSnapshot | null;
  readonly hasUnpublishedChanges: boolean;
} {
  const adminDto = extractDraftSnapshotForAdmin("post", {
    resourceId: Number(row.id),
    status: row.status,
    deletedAt: row.deleted_at,
    draftJson: row.draft_body_json,
    publishedJson: row.published_body_json,
    publishedAt: row.published_at,
    contentModifiedAt: row.content_modified_at,
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  });

  if (adminDto?.draft) {
    const cleanHtml =
      adminDto.draft.sanitizedHtml !== undefined
        ? sanitizeRichTextHtml(adminDto.draft.sanitizedHtml)
        : renderRichTextDocToSanitizedHtml(adminDto.draft.body);
    return {
      draft: {
        ...adminDto.draft,
        sanitizedHtml: cleanHtml,
        categoryIds: adminDto.draft.categoryIds ?? [...joinTaxonomies.categoryIds],
        tagIds: adminDto.draft.tagIds ?? [...joinTaxonomies.tagIds],
      },
      published: adminDto.published,
      hasUnpublishedChanges: adminDto.hasUnpublishedChanges,
    };
  }

  // Fallback for raw SQL-seeded rows
  const parsedBody = safeJsonParse(row.draft_body_json);
  const bodyParsed = RestrictedRichTextDocSchema.safeParse(parsedBody);
  const body: RestrictedRichTextDoc = bodyParsed.success
    ? sanitizeRichTextDoc(bodyParsed.data)
    : { schemaVersion: 1, blocks: [] };
  const sanitizedHtml = renderRichTextDocToSanitizedHtml(body);

  const parsedSeo = safeJsonParse(row.seo_json);
  let seo: PageSeoOverrides | null = null;
  if (parsedSeo && typeof parsedSeo === "object" && !Array.isArray(parsedSeo)) {
    try {
      seo = validatePageSeoOverrides(parsedSeo);
    } catch {
      seo = null;
    }
  }

  const draft: PostSnapshot = {
    slug: String(row.slug),
    title: String(row.title),
    excerpt: row.excerpt ?? null,
    body,
    sanitizedHtml,
    primaryCategoryId: row.primary_category_id !== null ? Number(row.primary_category_id) : null,
    categoryIds: [...joinTaxonomies.categoryIds],
    tagIds: [...joinTaxonomies.tagIds],
    authorId: row.author_id !== null ? Number(row.author_id) : null,
    authorUserId: null,
    authorName: null,
    coverMediaId: row.cover_media_id !== null ? Number(row.cover_media_id) : null,
    readingTimeMinutes: Math.max(1, Number(row.reading_time_minutes ?? 1)),
    showToc: Number(row.show_toc) === 1,
    seo,
  };

  const published = adminDto?.published ?? null;
  const hasUnpublishedChanges =
    published === null || JSON.stringify(draft) !== JSON.stringify(published);
  return { draft, published, hasUnpublishedChanges };
}

function mapRowToPostRecord(
  row: RawPostRow,
  joinTaxonomies: { readonly categoryIds: readonly number[]; readonly tagIds: readonly number[] },
  formerSlugs: readonly string[],
): PostRecord {
  const { draft, published, hasUnpublishedChanges } = extractPostDraftStateFromRow(row, joinTaxonomies);
  const sanitizedHtml = draft.sanitizedHtml ?? renderRichTextDocToSanitizedHtml(draft.body);
  const coverMediaId = draft.coverMediaId ?? null;
  const showToc = Boolean(draft.showToc);
  const categoryIds = draft.categoryIds ?? joinTaxonomies.categoryIds;
  const tagIds = draft.tagIds ?? joinTaxonomies.tagIds;

  const anchored = extractAndInjectServerToc(sanitizedHtml);
  const resolvedAuthorId = draft.authorId ?? null;

  return {
    id: Number(row.id),
    slug: draft.slug,
    title: draft.title,
    excerpt: draft.excerpt ?? null,
    status: row.status,
    body: draft.body,
    sanitizedHtml,
    toc: showToc ? anchored.toc : [],
    readingTimeMinutes: draft.readingTimeMinutes,
    featuredMediaId: coverMediaId,
    coverMediaId,
    primaryCategoryId: draft.primaryCategoryId ?? null,
    categoryIds,
    tagIds,
    authorId: resolvedAuthorId,
    authorProfileId: resolvedAuthorId,
    authorUserId: draft.authorUserId ?? null,
    authorName: draft.authorName ?? null,
    enableToc: showToc,
    showToc,
    tocEnabled: showToc,
    seo: draft.seo ?? null,
    published,
    hasUnpublishedChanges,
    formerSlugs,
    version: Number(row.version),
    publishedAt: toIsoOrNull(row.published_at),
    contentModifiedAt: toIsoOrNull(row.content_modified_at),
    contentFingerprint:
      typeof row.content_fingerprint === "string" && row.content_fingerprint.trim()
        ? row.content_fingerprint
        : null,
    deletedAt: toIsoOrNull(row.deleted_at),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

async function fetchRawPostRow(
  tenantDb: D1Database,
  postId: number,
  options: { readonly includeTrashed?: boolean } = {},
): Promise<RawPostRow | null> {
  const sql = options.includeTrashed
    ? `SELECT * FROM posts WHERE id = ? LIMIT 1`
    : `SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1`;
  return tenantDb.prepare(sql).bind(postId).first<RawPostRow>();
}

async function fetchPostTaxonomiesBatch(
  tenantDb: D1Database,
  postIds: readonly number[],
): Promise<Map<number, { readonly categoryIds: number[]; readonly tagIds: number[] }>> {
  const map = new Map<number, { readonly categoryIds: number[]; readonly tagIds: number[] }>();
  if (postIds.length === 0) return map;

  const placeholders = postIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT pt.post_id, pt.taxonomy_id, t.taxonomy_type
       FROM post_taxonomies pt
       JOIN taxonomies t ON t.id = pt.taxonomy_id
       WHERE pt.post_id IN (${placeholders})
       ORDER BY pt.taxonomy_id ASC`,
    )
    .bind(...postIds)
    .all<{
      readonly post_id: number;
      readonly taxonomy_id: number;
      readonly taxonomy_type: string;
    }>();

  for (const row of res.results) {
    const pid = Number(row.post_id);
    const tid = Number(row.taxonomy_id);
    const bucket = map.get(pid) ?? { categoryIds: [], tagIds: [] };
    if (row.taxonomy_type === "post_category") {
      bucket.categoryIds.push(tid);
    } else if (row.taxonomy_type === "post_tag") {
      bucket.tagIds.push(tid);
    }
    map.set(pid, bucket);
  }

  return map;
}

async function fetchFormerSlugsForPostsBatch(
  tenantDb: D1Database,
  postIds: readonly number[],
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (postIds.length === 0) return map;
  const placeholders = postIds.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT resource_id, slug
       FROM resource_slugs
       WHERE namespace = 'blog' AND is_current = 0 AND resource_id IN (${placeholders})
       ORDER BY updated_at DESC, slug ASC`,
    )
    .bind(...postIds)
    .all<{ readonly resource_id: number; readonly slug: string }>();

  for (const row of res.results) {
    const id = Number(row.resource_id);
    const list = map.get(id) ?? [];
    list.push(String(row.slug));
    map.set(id, list);
  }
  return map;
}

async function isPostSlugTaken(
  tenantDb: D1Database,
  slug: string,
  excludePostId?: number,
): Promise<boolean> {
  if (await isSlugTakenInNamespace(tenantDb, "blog", slug, { excludeResourceId: excludePostId })) {
    return true;
  }
  const existing = await tenantDb
    .prepare(`SELECT id FROM posts WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first<{ readonly id: number }>();
  if (!existing) return false;
  return excludePostId === undefined || Number(existing.id) !== excludePostId;
}

async function hasPostContentFingerprintColumn(tenantDb: D1Database): Promise<boolean> {
  try {
    const res = await tenantDb
      .prepare(`PRAGMA table_info(posts)`)
      .all<{ readonly name: string }>();
    return res.results.some((col) => col.name === "content_fingerprint");
  } catch {
    return false;
  }
}

const MAX_RETAINED_POST_REVISIONS = 20 as const;

function rewritePublishedPostEnvelopeSlug(
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
 * Creates a new draft blog post with:
 * - Atomic per-tenant sequential ID (`sequences.kind = 'post'`)
 * - Shared slug engine (`namespace = 'blog'`, NFKD, 80-char cap, `-2` suffix, 422 manual conflict)
 * - Strict rich-text sanitization & deterministic reading-time calculation
 * - Verified same-tenant author, categories (`post_category`), tags (`post_tag`), and owned media
 */
export async function createPost(
  tenantDb: D1Database,
  input: CreatePostInput,
  authorScope?: PostAuthorScope,
): Promise<PostRecord> {
  assertNoForbiddenTenantSelectors(input);
  const nowMs = input.nowMs ?? Date.now();

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new PublicationValidationError("title is required", [
      { field: "title", code: "REQUIRED", message: "Judul artikel tidak boleh kosong." },
    ]);
  }
  const cleanTitle = input.title.trim();
  if (cleanTitle.length > 200) {
    throw new PublicationValidationError("title must be at most 200 characters", [
      { field: "title", code: "INVALID_LENGTH", message: "Judul artikel maksimal 200 karakter." },
    ]);
  }

  const excerpt = validateExcerpt(input.excerpt);
  const { body, sanitizedHtml, readingTimeMinutes } = normalizePostBodyInput({
    body: input.body,
    bodyHtml: input.bodyHtml,
  });
  const coverResolution = resolveCoverMediaIdInput(input.featuredMediaId, input.coverMediaId);
  const coverMediaId = coverResolution.value;
  const showToc = resolveShowTocInput(input.enableToc, input.showToc, input.tocEnabled).value;
  const resolvedAuthorIdInput = resolveAuthorIdInput(input.authorId, input.authorProfileId);
  const seo = input.seo !== undefined ? validatePageSeoOverrides(input.seo) : null;

  const primaryCategoryId =
    input.primaryCategoryId !== undefined && input.primaryCategoryId !== null
      ? assertValidPositiveId(input.primaryCategoryId, "primaryCategoryId")
      : null;
  const rawCategoryIds =
    input.categoryIds !== undefined ? normalizeIdArray(input.categoryIds, "categoryIds", 10) : [];
  const rawTagIds =
    input.tagIds !== undefined ? normalizeIdArray(input.tagIds, "tagIds", 20) : [];

  // Validate manual slug BEFORE touching sequence allocator
  const manualSlug =
    input.slug !== undefined ? validateManualSlug(input.slug, { namespace: "blog" }) : null;

  // Validate same-tenant author, categories, tags, and media references
  const [author, verifiedTaxonomies] = await Promise.all([
    resolveAndValidatePostAuthor(tenantDb, {
      authorId: resolvedAuthorIdInput,
      authorUserId: input.authorUserId,
      authorName: input.authorName,
      scope: authorScope,
    }),
    verifyOwnedPostTaxonomies(tenantDb, {
      primaryCategoryId,
      categoryIds: rawCategoryIds,
      tagIds: rawTagIds,
    }),
    verifyOwnedPostMediaIds(
      tenantDb,
      {
        coverMediaId,
        ogImageMediaId: seo?.ogImageMediaId ?? null,
        bodyMediaIds: extractBodyMediaIds(body),
      },
      { requireReady: false },
    ),
  ]);

  const draftBase: Omit<PostSnapshot, "slug"> = {
    title: cleanTitle,
    excerpt,
    body,
    sanitizedHtml,
    primaryCategoryId,
    categoryIds: verifiedTaxonomies.categoryIds,
    tagIds: verifiedTaxonomies.tagIds,
    authorId: author.authorId,
    authorUserId: author.authorUserId,
    authorName: author.authorName,
    coverMediaId,
    readingTimeMinutes,
    showToc,
    seo,
  };

  // Pre-validate complete snapshot BEFORE sequence allocation
  serializeDraftStoragePayload("post", {
    ...draftBase,
    slug: manualSlug ?? "valid-probe-slug",
  });

  if (manualSlug !== null && (await isPostSlugTaken(tenantDb, manualSlug))) {
    const suggested = await suggestAlternativeSlug(
      manualSlug,
      (candidate) => isPostSlugTaken(tenantDb, candidate),
      { namespace: "blog" },
    );
    throw new SlugValidationError(
      "SLUG_CONFLICT",
      `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
      { field: "slug", suggestedSlug: suggested },
    );
  }

  const [postId, hasRevisionHistory] = await Promise.all([
    allocateNextSequenceId(tenantDb, "post"),
    hasContentRevisionHistoryColumns(tenantDb),
  ]);
  const allTaxIds = [...verifiedTaxonomies.categoryIds, ...verifiedTaxonomies.tagIds];

  const buildCreateBatch = (slug: string, serialized: { readonly json: string; readonly data: PostSnapshot }) => {
    const stmts: D1PreparedStatement[] = [
      tenantDb
        .prepare(
          `INSERT INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
           VALUES ('blog', ?, ?, 1, NULL, ?)`,
        )
        .bind(slug, postId, nowMs),
      tenantDb
        .prepare(
          `INSERT INTO posts (
             id, slug, title, excerpt,
             draft_body_json, published_body_json,
             primary_category_id, author_id, cover_media_id,
             reading_time_minutes, show_toc, seo_json,
             status, published_at, content_modified_at, deleted_at,
             version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, 1, ?, ?)`,
        )
        .bind(
          postId,
          slug,
          serialized.data.title,
          serialized.data.excerpt ?? null,
          serialized.json,
          primaryCategoryId,
          author.authorId,
          coverMediaId,
          readingTimeMinutes,
          showToc ? 1 : 0,
          serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
          nowMs,
          nowMs,
        ),
    ];

    for (const taxId of allTaxIds) {
      stmts.push(
        tenantDb
          .prepare(`INSERT INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, ?)`)
          .bind(postId, taxId),
      );
    }
    if (hasRevisionHistory) {
      stmts.push(
        ...buildAppendRevisionStatements(tenantDb, {
          resourceType: "post",
          resourceId: postId,
          triggerKind: "save",
          data: serialized.data as unknown as Record<string, unknown>,
          actorUserId: authorScope?.actorUserId ?? null,
          nowMs,
          hasExtendedColumns: true,
        }),
      );
    }
    return stmts;
  };

  if (manualSlug !== null) {
    const serialized = serializeDraftStoragePayload("post", { ...draftBase, slug: manualSlug });
    try {
      await tenantDb.batch(buildCreateBatch(manualSlug, serialized));
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const suggested = await suggestAlternativeSlug(
          manualSlug,
          (candidate) => isPostSlugTaken(tenantDb, candidate),
          { namespace: "blog" },
        );
        throw new SlugValidationError(
          "SLUG_CONFLICT",
          `Slug "${manualSlug}" sudah digunakan di tenant ini. Saran alternatif: "${suggested}".`,
          { field: "slug", suggestedSlug: suggested },
        );
      }
      throw err;
    }

    const created = await getPostById(tenantDb, postId);
    if (!created) {
      throw new Error(`Failed to reload newly created post #${postId}`);
    }
    return created;
  }

  const baseSlug = normalizeTitleToSlug(cleanTitle, {
    fallbackPrefix: "post",
    fallbackId: postId,
  });

  const maxAttempts = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? baseSlug : buildSuffixedSlug(baseSlug, attempt);
    if (isReservedSlug(candidate, "blog")) {
      continue;
    }

    const serialized = serializeDraftStoragePayload("post", { ...draftBase, slug: candidate });
    try {
      await tenantDb.batch(buildCreateBatch(candidate, serialized));
      const created = await getPostById(tenantDb, postId);
      if (!created) {
        throw new Error(`Failed to reload newly created post #${postId}`);
      }
      return created;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
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

export async function getPostById(
  tenantDb: D1Database,
  postId: number,
  options: { readonly includeTrashed?: boolean } = {},
): Promise<PostRecord | null> {
  assertValidPostId(postId);
  const row = await fetchRawPostRow(tenantDb, postId, options);
  if (!row) return null;

  const [taxMap, slugs] = await Promise.all([
    fetchPostTaxonomiesBatch(tenantDb, [postId]),
    listResourceSlugsForResource(tenantDb, "blog", postId),
  ]);
  const formerSlugs = slugs.filter((s) => !s.isCurrent).map((s) => s.slug);
  return mapRowToPostRecord(
    row,
    taxMap.get(postId) ?? { categoryIds: [], tagIds: [] },
    formerSlugs,
  );
}

/**
 * Public-safe loader returning ONLY the validated published snapshot of a post.
 * Strictly returns `null` for draft, unpublished, trashed, or missing posts.
 */
export async function getPublishedPost(
  tenantDb: D1Database,
  selector: { readonly postId?: number; readonly slug?: string },
): Promise<PublishedResourceDto<"post"> | null> {
  return getPublishedResource(tenantDb, {
    resourceType: "post",
    resourceId: selector.postId,
    slug: selector.slug,
  });
}

/**
 * Admin-only private draft preview loader returning separated draft & published snapshots.
 */
export async function getDraftPostPreview(
  tenantDb: D1Database,
  postId: number,
): Promise<AdminDraftResourceDto<"post"> | null> {
  assertValidPostId(postId);
  return getDraftResourceForAdmin(tenantDb, {
    resourceType: "post",
    resourceId: postId,
  });
}

export async function listPosts(
  tenantDb: D1Database,
  options: ListPostsOptions = {},
): Promise<ListPostsResult> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const sortOrder = options.sortOrder === "asc" ? "asc" : "desc";
  const status = options.status ?? "all";

  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (status === "trashed") {
    conditions.push("p.status = 'trashed'");
  } else if (status === "draft" || status === "published") {
    conditions.push("p.status = ?");
    conditions.push("p.deleted_at IS NULL");
    binds.push(status);
  } else if (!options.includeTrashed) {
    conditions.push("p.deleted_at IS NULL");
  }

  if (options.categoryId !== undefined) {
    const cid = assertValidPositiveId(options.categoryId, "categoryId");
    conditions.push(
      `(p.primary_category_id = ? OR EXISTS (SELECT 1 FROM post_taxonomies pt JOIN taxonomies t ON t.id = pt.taxonomy_id WHERE pt.post_id = p.id AND pt.taxonomy_id = ? AND t.taxonomy_type = 'post_category'))`,
    );
    binds.push(cid, cid);
  }

  if (options.tagId !== undefined) {
    const tid = assertValidPositiveId(options.tagId, "tagId");
    conditions.push(
      `EXISTS (SELECT 1 FROM post_taxonomies pt JOIN taxonomies t ON t.id = pt.taxonomy_id WHERE pt.post_id = p.id AND pt.taxonomy_id = ? AND t.taxonomy_type = 'post_tag')`,
    );
    binds.push(tid);
  }

  if (options.search !== undefined && options.search.trim() !== "") {
    const q = `%${options.search.trim().toLowerCase()}%`;
    conditions.push("(LOWER(p.title) LIKE ? OR LOWER(COALESCE(p.excerpt, '')) LIKE ?)");
    binds.push(q, q);
  }

  if (options.cursor !== undefined && options.cursor.trim() !== "") {
    if (!/^\d+$/.test(options.cursor.trim())) {
      throw new PublicationValidationError("Invalid pagination cursor", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Cursor must be a numeric post ID." },
      ]);
    }
    const cursorId = Number(options.cursor.trim());
    conditions.push(sortOrder === "asc" ? "p.id > ?" : "p.id < ?");
    binds.push(cursorId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderSql = sortOrder === "asc" ? "ORDER BY p.id ASC" : "ORDER BY p.id DESC";

  const res = await tenantDb
    .prepare(`SELECT p.* FROM posts p ${whereClause} ${orderSql} LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<RawPostRow>();

  const hasMore = res.results.length > limit;
  const rows = hasMore ? res.results.slice(0, limit) : res.results;
  const ids = rows.map((r) => Number(r.id));

  const [taxMap, formerSlugsMap] = await Promise.all([
    fetchPostTaxonomiesBatch(tenantDb, ids),
    fetchFormerSlugsForPostsBatch(tenantDb, ids),
  ]);

  const items = rows.map((row) =>
    mapRowToPostRecord(
      row,
      taxMap.get(Number(row.id)) ?? { categoryIds: [], tagIds: [] },
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
 * Saves draft updates to an existing blog post with strict optimistic concurrency (`expectedVersion` -> 409):
 * - Draft edits NEVER overwrite live published content, timestamps, or published taxonomy associations.
 * - Executes Statement 0 (`UPDATE posts ... WHERE id = ? AND version = ?`) and ALL dependent
 *   `resource_slugs` & `post_taxonomies` mutations in ONE atomic `tenantDb.batch([...])`, gating
 *   every follow-up statement on `EXISTS (SELECT 1 FROM posts WHERE id = ? AND version = ? AND slug = ? AND draft_body_json = ? AND updated_at = ? AND deleted_at IS NULL)`
 *   so a losing concurrent PATCH commits ZERO side effects and returns `409 STALE_VERSION`.
 */
export async function updatePost(
  tenantDb: D1Database,
  input: UpdatePostInput,
  options: UpdatePostOptions = {},
): Promise<PostRecord> {
  assertNoForbiddenTenantSelectors(input);
  assertValidPostId(input.postId);
  assertValidExpectedVersion(input.expectedVersion);

  const nowMs = input.nowMs ?? Date.now();
  const row = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
  if (!row) {
    throw new PublicationNotFoundError("post", input.postId);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const taxMap = await fetchPostTaxonomiesBatch(tenantDb, [input.postId]);
  const existingTax = taxMap.get(input.postId) ?? { categoryIds: [], tagIds: [] };
  const { draft: currentDraft } = extractPostDraftStateFromRow(row, existingTax);

  const nextTitle = input.title !== undefined ? input.title.trim() : currentDraft.title;
  if (!nextTitle || nextTitle.length > 200) {
    throw new PublicationValidationError("title must be 1..200 characters", [
      { field: "title", code: "INVALID_LENGTH", message: "Judul artikel harus 1 hingga 200 karakter." },
    ]);
  }

  const nextExcerpt =
    input.excerpt !== undefined ? validateExcerpt(input.excerpt) : (currentDraft.excerpt ?? null);

  let nextBody = currentDraft.body;
  let nextSanitizedHtml =
    currentDraft.sanitizedHtml ?? renderRichTextDocToSanitizedHtml(currentDraft.body);
  let nextReadingTime = currentDraft.readingTimeMinutes;

  if (input.body !== undefined || input.bodyHtml !== undefined) {
    const normalizedBody = normalizePostBodyInput({
      body: input.body,
      bodyHtml: input.bodyHtml,
    });
    nextBody = normalizedBody.body;
    nextSanitizedHtml = normalizedBody.sanitizedHtml;
    nextReadingTime = normalizedBody.readingTimeMinutes;
  }

  const coverRes = resolveCoverMediaIdInput(input.featuredMediaId, input.coverMediaId);
  const nextCoverMediaId = coverRes.supplied
    ? coverRes.value
    : (currentDraft.coverMediaId ?? null);

  const tocRes = resolveShowTocInput(input.enableToc, input.showToc, input.tocEnabled);
  const nextShowToc = tocRes.supplied ? tocRes.value : Boolean(currentDraft.showToc);
  const resolvedAuthorIdInput = resolveAuthorIdInput(input.authorId, input.authorProfileId);

  const nextSeo =
    input.seo !== undefined ? validatePageSeoOverrides(input.seo) : (currentDraft.seo ?? null);

  const nextSlug =
    input.slug !== undefined
      ? validateManualSlug(input.slug, { namespace: "blog" })
      : currentDraft.slug;

  const nextPrimaryCategoryId =
    input.primaryCategoryId !== undefined
      ? input.primaryCategoryId === null
        ? null
        : assertValidPositiveId(input.primaryCategoryId, "primaryCategoryId")
      : (currentDraft.primaryCategoryId ?? null);

  const rawCategoryIds =
    input.categoryIds !== undefined
      ? normalizeIdArray(input.categoryIds, "categoryIds", 10)
      : [...(currentDraft.categoryIds ?? existingTax.categoryIds)];

  const rawTagIds =
    input.tagIds !== undefined
      ? normalizeIdArray(input.tagIds, "tagIds", 20)
      : [...(currentDraft.tagIds ?? existingTax.tagIds)];

  // Validate same-tenant author, categories, tags, and media
  const [author, verifiedTaxonomies] = await Promise.all([
    resolveAndValidatePostAuthor(tenantDb, {
      authorId: resolvedAuthorIdInput,
      authorUserId: input.authorUserId,
      authorName: input.authorName,
      fallbackAuthorId: currentDraft.authorId ?? null,
      fallbackAuthorUserId: currentDraft.authorUserId ?? null,
      fallbackAuthorName: currentDraft.authorName ?? null,
      scope: options.actorUserId
        ? {
            platformDb: options.platformDb,
            organizationId: options.organizationId,
            actorUserId: options.actorUserId,
          }
        : undefined,
    }),
    verifyOwnedPostTaxonomies(tenantDb, {
      primaryCategoryId: nextPrimaryCategoryId,
      categoryIds: rawCategoryIds,
      tagIds: rawTagIds,
    }),
    verifyOwnedPostMediaIds(
      tenantDb,
      {
        coverMediaId: nextCoverMediaId,
        ogImageMediaId: nextSeo?.ogImageMediaId ?? null,
        bodyMediaIds: extractBodyMediaIds(nextBody),
      },
      { requireReady: false },
    ),
  ]);

  const serialized = serializeDraftStoragePayload("post", {
    slug: nextSlug,
    title: nextTitle,
    excerpt: nextExcerpt,
    body: nextBody,
    sanitizedHtml: nextSanitizedHtml,
    primaryCategoryId: nextPrimaryCategoryId,
    categoryIds: verifiedTaxonomies.categoryIds,
    tagIds: verifiedTaxonomies.tagIds,
    authorId: author.authorId,
    authorUserId: author.authorUserId,
    authorName: author.authorName,
    coverMediaId: nextCoverMediaId,
    readingTimeMinutes: nextReadingTime,
    showToc: nextShowToc,
    seo: nextSeo,
  });

  const wasEverPublished = row.published_at !== null || row.status === "published";
  const slugChanged = nextSlug !== String(row.slug);
  const nextVersion = input.expectedVersion + 1;

  // Bind the EXACT new `(id, version, slug, draft_body_json, updated_at)` written by Statement 0
  // so a losing concurrent PATCH is guaranteed to have ZERO side effects in `resource_slugs` or `post_taxonomies`.
  const atomicGuard = {
    sql: "EXISTS (SELECT 1 FROM posts WHERE id = ? AND version = ? AND slug = ? AND draft_body_json = ? AND updated_at = ? AND deleted_at IS NULL)",
    binds: [input.postId, nextVersion, nextSlug, serialized.json, nowMs] as const,
  };

  const slugTransition = slugChanged
    ? await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "blog",
        resourceId: input.postId,
        oldSlug: String(row.slug),
        newSlug: nextSlug,
        wasEverPublished,
        confirmSlugChange: input.confirmSlugChange,
        allowSelfRevert: false,
        nowMs,
        guard: atomicGuard,
      })
    : null;

  const nextPublishedBodyJson =
    row.status === "published" && slugChanged
      ? rewritePublishedPostEnvelopeSlug(row.published_body_json, nextSlug)
      : row.published_body_json;

  // Draft isolation: if currently published, ONLY mutate `draft_body_json` (plus `slug` and
  // `published_body_json`'s `data.slug` on explicit confirmed slug change), leaving published
  // columns, `published_at`, `content_modified_at`, and live `post_taxonomies` untouched!
  const updateStmt =
    row.status === "published"
      ? slugChanged
        ? tenantDb
            .prepare(
              `UPDATE posts
               SET slug = ?,
                   draft_body_json = ?,
                   published_body_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(
              nextSlug,
              serialized.json,
              nextPublishedBodyJson,
              nowMs,
              input.postId,
              input.expectedVersion,
            )
        : tenantDb
            .prepare(
              `UPDATE posts
               SET draft_body_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(serialized.json, nowMs, input.postId, input.expectedVersion)
      : tenantDb
          .prepare(
            `UPDATE posts
             SET slug = ?,
                 title = ?,
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
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .bind(
            nextSlug,
            serialized.data.title,
            serialized.data.excerpt ?? null,
            serialized.json,
            nextPrimaryCategoryId,
            author.authorId,
            nextCoverMediaId,
            nextReadingTime,
            nextShowToc ? 1 : 0,
            serialized.data.seo ? JSON.stringify(serialized.data.seo) : null,
            nowMs,
            input.postId,
            input.expectedVersion,
          );

  const hasRevisionHistory = await hasContentRevisionHistoryColumns(tenantDb);
  const batchStmts: D1PreparedStatement[] = [
    updateStmt,
    ...(slugTransition ? slugTransition.statements : []),
    ...(hasRevisionHistory
      ? buildAppendRevisionStatements(tenantDb, {
          resourceType: "post",
          resourceId: input.postId,
          triggerKind: "save",
          data: serialized.data as unknown as Record<string, unknown>,
          actorUserId: options.actorUserId ?? null,
          nowMs,
          hasExtendedColumns: true,
          guard: atomicGuard,
        })
      : []),
  ];

  // For draft posts, sync `post_taxonomies` inside the EXACT SAME atomic batch gated on `atomicGuard`
  if (row.status !== "published") {
    const allTaxIds = [...verifiedTaxonomies.categoryIds, ...verifiedTaxonomies.tagIds];
    batchStmts.push(
      tenantDb
        .prepare(`DELETE FROM post_taxonomies WHERE post_id = ? AND ${atomicGuard.sql}`)
        .bind(input.postId, ...atomicGuard.binds),
    );
    for (const taxId of allTaxIds) {
      batchStmts.push(
        tenantDb
          .prepare(
            `INSERT INTO post_taxonomies (post_id, taxonomy_id)
             SELECT ?, ?
             WHERE ${atomicGuard.sql}`,
          )
          .bind(input.postId, taxId, ...atomicGuard.binds),
      );
    }
  }

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new StaleRevisionError({
          resourceType: "post",
          resourceId: input.postId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const suggested = await suggestAlternativeSlug(
        nextSlug,
        (candidate) => isPostSlugTaken(tenantDb, candidate, input.postId),
        { namespace: "blog" },
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
    const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
    if (!latest) {
      throw new PublicationNotFoundError("post", input.postId);
    }
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  // If a currently-published post's live slug changed, bump PLATFORM_DB.tenants.cache_version
  if (row.status === "published" && slugChanged && options.platformDb && options.tenantId) {
    try {
      await bumpTenantCacheVersion(options.platformDb, options.tenantId, nowMs);
    } catch (platformError) {
      let compensated = false;
      try {
        const restoreRes = await tenantDb.batch([
          tenantDb
            .prepare(
              `UPDATE posts
               SET slug = ?,
                   draft_body_json = ?,
                   published_body_json = ?,
                   version = ?,
                   updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .bind(
              row.slug,
              row.draft_body_json,
              row.published_body_json,
              row.version,
              row.updated_at,
              input.postId,
              nextVersion,
            ),
          tenantDb
            .prepare(
              `DELETE FROM resource_slugs
               WHERE namespace = 'blog' AND slug = ? AND resource_id = ? AND is_current = 1`,
            )
            .bind(nextSlug, input.postId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET is_current = 1, redirect_target_slug = NULL, updated_at = ?
               WHERE namespace = 'blog' AND slug = ? AND resource_id = ?`,
            )
            .bind(row.updated_at, row.slug, input.postId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET redirect_target_slug = ?, updated_at = ?
               WHERE namespace = 'blog' AND resource_id = ? AND is_current = 0`,
            )
            .bind(row.slug, row.updated_at, input.postId),
        ]);
        compensated = (restoreRes[0]?.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation failed
      }
      throw new PublicationAtomicError(
        `Failed to bump tenant cache_version after published post slug change${
          compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
        }`,
        { compensated, cause: platformError },
      );
    }
  }

  const updated = await getPostById(tenantDb, input.postId);
  if (!updated) {
    throw new Error(`Failed to reload updated post #${input.postId}`);
  }
  return updated;
}

/**
 * Atomically publishes a blog post's current draft snapshot:
 * - Re-verifies non-empty body, ready owned media (`status = 'ready'`), owned categories/tags, and author.
 * - Executes `publishResourceAtomically` (recording revision + bumping `PLATFORM_DB.tenants.cache_version`).
 * - Syncs `resource_slugs` and `post_taxonomies` in one version-guarded batch.
 */
export async function publishPost(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: PublishPostInput,
): Promise<PublishPostResult> {
  assertValidPostId(input.postId);
  assertValidExpectedVersion(input.expectedVersion);

  const nowMs = input.nowMs ?? Date.now();
  const priorRow = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
  if (!priorRow) {
    throw new PublicationNotFoundError("post", input.postId);
  }
  if (Number(priorRow.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(priorRow.version),
    });
  }

  const taxMap = await fetchPostTaxonomiesBatch(tenantDb, [input.postId]);
  const existingTax = taxMap.get(input.postId) ?? { categoryIds: [], tagIds: [] };
  const { draft, published: priorPublished } = extractPostDraftStateFromRow(priorRow, existingTax);

  // Re-verify all referenced media (strictly `ready` on publish!), taxonomies, and author
  const [verifiedTaxonomies, supportsFingerprint] = await Promise.all([
    verifyOwnedPostTaxonomies(tenantDb, {
      primaryCategoryId: draft.primaryCategoryId ?? null,
      categoryIds: draft.categoryIds ?? existingTax.categoryIds,
      tagIds: draft.tagIds ?? existingTax.tagIds,
    }),
    hasPostContentFingerprintColumn(tenantDb),
    verifyOwnedPostMediaIds(
      tenantDb,
      {
        coverMediaId: draft.coverMediaId ?? null,
        ogImageMediaId: draft.seo?.ogImageMediaId ?? null,
        bodyMediaIds: extractBodyMediaIds(draft.body),
      },
      { requireReady: true },
    ),
    draft.authorId !== undefined && draft.authorId !== null
      ? resolveAndValidatePostAuthor(tenantDb, {
          authorId: draft.authorId,
          authorUserId: draft.authorUserId ?? null,
          authorName: draft.authorName ?? null,
          scope:
            input.actorUserId && input.organizationId
              ? {
                  platformDb,
                  organizationId: input.organizationId,
                  actorUserId: input.actorUserId,
                }
              : undefined,
        })
      : Promise.resolve(null),
  ]);

  const wasEverPublished = priorRow.published_at !== null || priorRow.status === "published";
  const slugChanged = draft.slug !== String(priorRow.slug);
  const swappedVersion = input.expectedVersion + 1;

  const publishGuard = {
    sql: "EXISTS (SELECT 1 FROM posts WHERE id = ? AND slug = ? AND version = ? AND deleted_at IS NULL)",
    binds: [input.postId, draft.slug, swappedVersion] as const,
  };

  const slugTransition = slugChanged
    ? await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "blog",
        resourceId: input.postId,
        oldSlug: String(priorRow.slug),
        newSlug: draft.slug,
        wasEverPublished,
        confirmSlugChange: input.confirmSlugChange,
        allowSelfRevert: false,
        nowMs,
        guard: publishGuard,
      })
    : null;

  const renderedHtml = draft.sanitizedHtml ?? renderRichTextDocToSanitizedHtml(draft.body);
  const anchoredHtml = extractAndInjectServerToc(renderedHtml).html;
  const readingTimeMinutes = calculateLinearReadingTimeMinutes(anchoredHtml || draft.body);

  const normalizedDraftForPublish: PostSnapshot = {
    ...draft,
    sanitizedHtml: anchoredHtml,
    readingTimeMinutes,
    categoryIds: verifiedTaxonomies.categoryIds,
    tagIds: verifiedTaxonomies.tagIds,
  };

  // Normalize legacy prior snapshot HTML identically before fingerprinting so legacy
  // rows without `content_fingerprint` or heading `id`s never spuriously bump on no-op republish.
  const priorPublishedForCompare: PostSnapshot | null = priorPublished
    ? {
        ...priorPublished,
        sanitizedHtml:
          priorPublished.sanitizedHtml && priorPublished.sanitizedHtml.trim().length > 0
            ? priorPublished.sanitizedHtml
            : renderRichTextDocToSanitizedHtml(priorPublished.body),
      }
    : null;

  // Strict `content_modified_at` discipline (REQ-092):
  // Only advance `content_modified_at` when substantive published content actually changed.
  const modDecision = resolvePublishedContentModifiedAt({
    priorPublished: priorPublishedForCompare,
    nextPublished: normalizedDraftForPublish,
    priorContentModifiedAt: priorRow.content_modified_at,
    priorPublishedAt: priorRow.published_at,
    priorFingerprint: priorRow.content_fingerprint ?? null,
    nowMs,
  });

  const cleanTenantId = input.tenantId.trim();
  if (!cleanTenantId) {
    throw new PublicationValidationError("tenantId is required to publish", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId must be non-empty" },
    ]);
  }

  const publishedAt = priorRow.published_at ?? nowMs;
  const envelope = buildPublishedSnapshot("post", normalizedDraftForPublish, {
    publishedAt,
    contentModifiedAt: modDecision.contentModifiedAt,
  });
  const publishedJson = JSON.stringify(envelope);

  const revRow = await tenantDb
    .prepare(
      `SELECT COALESCE(MAX(revision_number), 0) AS max_rev
       FROM content_revisions
       WHERE resource_type = 'post' AND resource_id = ?`,
    )
    .bind(input.postId)
    .first<{ readonly max_rev: number }>();
  const revisionNumber = (revRow?.max_rev ?? 0) + 1;

  // Single atomic TenantStore batch: swap published snapshot with the EXACT disciplined
  // `content_modified_at` & `content_fingerprint`, record revision snapshot with identical
  // `contentModifiedAt`, prune revisions to 20, and sync `resource_slugs` & `post_taxonomies`.
  const committedGuardSql =
    "EXISTS (SELECT 1 FROM posts WHERE id = ? AND slug = ? AND version = ? AND published_body_json = ? AND deleted_at IS NULL)";
  const committedGuardBinds = [input.postId, envelope.data.slug, swappedVersion, publishedJson] as const;

  const updatePostStmt = supportsFingerprint
    ? tenantDb
        .prepare(
          `UPDATE posts
           SET slug = ?,
               title = ?,
               excerpt = ?,
               primary_category_id = ?,
               author_id = ?,
               cover_media_id = ?,
               reading_time_minutes = ?,
               show_toc = ?,
               seo_json = ?,
               published_body_json = ?,
               status = 'published',
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               content_fingerprint = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(
          envelope.data.slug,
          envelope.data.title,
          envelope.data.excerpt ?? null,
          envelope.data.primaryCategoryId ?? null,
          envelope.data.authorId ?? null,
          envelope.data.coverMediaId ?? null,
          envelope.data.readingTimeMinutes,
          envelope.data.showToc ? 1 : 0,
          envelope.data.seo ? JSON.stringify(envelope.data.seo) : null,
          publishedJson,
          envelope.publishedAt,
          modDecision.contentModifiedAt,
          modDecision.fingerprint,
          nowMs,
          input.postId,
          input.expectedVersion,
        )
    : tenantDb
        .prepare(
          `UPDATE posts
           SET slug = ?,
               title = ?,
               excerpt = ?,
               primary_category_id = ?,
               author_id = ?,
               cover_media_id = ?,
               reading_time_minutes = ?,
               show_toc = ?,
               seo_json = ?,
               published_body_json = ?,
               status = 'published',
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(
          envelope.data.slug,
          envelope.data.title,
          envelope.data.excerpt ?? null,
          envelope.data.primaryCategoryId ?? null,
          envelope.data.authorId ?? null,
          envelope.data.coverMediaId ?? null,
          envelope.data.readingTimeMinutes,
          envelope.data.showToc ? 1 : 0,
          envelope.data.seo ? JSON.stringify(envelope.data.seo) : null,
          publishedJson,
          envelope.publishedAt,
          modDecision.contentModifiedAt,
          nowMs,
          input.postId,
          input.expectedVersion,
        );

  const hasRevisionHistory = await hasContentRevisionHistoryColumns(tenantDb);
  const pubSummary = buildRevisionSummaryText({
    resourceType: "post",
    triggerKind: "publish",
    title: envelope.data.title,
    slug: envelope.data.slug,
  });

  const atomicBatchStmts: D1PreparedStatement[] = [
    updatePostStmt,
    hasRevisionHistory
      ? tenantDb
          .prepare(
            `INSERT INTO content_revisions (
               resource_type, resource_id, revision_number, snapshot_json,
               created_by, created_at, trigger_kind, schema_version, summary
             )
             SELECT 'post', ?, ?, ?, ?, ?, 'publish', 1, ?
             WHERE ${committedGuardSql}`,
          )
          .bind(
            input.postId,
            revisionNumber,
            publishedJson,
            input.actorUserId ?? null,
            nowMs,
            pubSummary,
            ...committedGuardBinds,
          )
      : tenantDb
          .prepare(
            `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
             SELECT 'post', ?, ?, ?, ?, ?
             WHERE ${committedGuardSql}`,
          )
          .bind(
            input.postId,
            revisionNumber,
            publishedJson,
            input.actorUserId ?? null,
            nowMs,
            ...committedGuardBinds,
          ),
    tenantDb
      .prepare(
        `DELETE FROM content_revisions
         WHERE resource_type = 'post' AND resource_id = ?
           AND ${committedGuardSql}
           AND revision_number NOT IN (
             SELECT revision_number
             FROM content_revisions
             WHERE resource_type = 'post' AND resource_id = ?
             ORDER BY revision_number DESC
             LIMIT ?
           )`,
      )
      .bind(input.postId, ...committedGuardBinds, input.postId, MAX_RETAINED_POST_REVISIONS),
  ];

  if (slugTransition && slugTransition.statements.length > 0) {
    atomicBatchStmts.push(...slugTransition.statements);
  } else {
    const existingSlug = await findResourceSlug(tenantDb, "blog", envelope.data.slug);
    if (!existingSlug) {
      atomicBatchStmts.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO resource_slugs (namespace, slug, resource_id, is_current, redirect_target_slug, updated_at)
             SELECT 'blog', ?, ?, 1, NULL, ?
             WHERE ${committedGuardSql}`,
          )
          .bind(envelope.data.slug, input.postId, nowMs, ...committedGuardBinds),
      );
    }
  }

  const allTaxIds = [...verifiedTaxonomies.categoryIds, ...verifiedTaxonomies.tagIds];
  atomicBatchStmts.push(
    tenantDb
      .prepare(`DELETE FROM post_taxonomies WHERE post_id = ? AND ${committedGuardSql}`)
      .bind(input.postId, ...committedGuardBinds),
  );
  for (const taxId of allTaxIds) {
    atomicBatchStmts.push(
      tenantDb
        .prepare(
          `INSERT INTO post_taxonomies (post_id, taxonomy_id)
           SELECT ?, ?
           WHERE ${committedGuardSql}`,
        )
        .bind(input.postId, taxId, ...committedGuardBinds),
    );
  }

  const batchResults = await tenantDb.batch(atomicBatchStmts);
  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
    if (!latest) {
      throw new PublicationNotFoundError("post", input.postId);
    }
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  // Bump PLATFORM_DB.tenants.cache_version with fail-closed TenantStore compensation
  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(platformDb, cleanTenantId, nowMs);
  } catch (platformError) {
    let compensated = false;
    try {
      const priorTaxIds = [...existingTax.categoryIds, ...existingTax.tagIds];
      const restoreStmts: D1PreparedStatement[] = [
        supportsFingerprint
          ? tenantDb
              .prepare(
                `UPDATE posts
                 SET slug = ?, title = ?, excerpt = ?, primary_category_id = ?,
                     author_id = ?, cover_media_id = ?, reading_time_minutes = ?,
                     show_toc = ?, seo_json = ?, published_body_json = ?,
                     status = ?, published_at = ?, content_modified_at = ?,
                     content_fingerprint = ?, version = ?, updated_at = ?
                 WHERE id = ? AND version = ?`,
              )
              .bind(
                priorRow.slug,
                priorRow.title,
                priorRow.excerpt,
                priorRow.primary_category_id,
                priorRow.author_id,
                priorRow.cover_media_id,
                priorRow.reading_time_minutes,
                priorRow.show_toc,
                priorRow.seo_json,
                priorRow.published_body_json,
                priorRow.status,
                priorRow.published_at,
                priorRow.content_modified_at,
                priorRow.content_fingerprint ?? null,
                priorRow.version,
                priorRow.updated_at,
                input.postId,
                swappedVersion,
              )
          : tenantDb
              .prepare(
                `UPDATE posts
                 SET slug = ?, title = ?, excerpt = ?, primary_category_id = ?,
                     author_id = ?, cover_media_id = ?, reading_time_minutes = ?,
                     show_toc = ?, seo_json = ?, published_body_json = ?,
                     status = ?, published_at = ?, content_modified_at = ?,
                     version = ?, updated_at = ?
                 WHERE id = ? AND version = ?`,
              )
              .bind(
                priorRow.slug,
                priorRow.title,
                priorRow.excerpt,
                priorRow.primary_category_id,
                priorRow.author_id,
                priorRow.cover_media_id,
                priorRow.reading_time_minutes,
                priorRow.show_toc,
                priorRow.seo_json,
                priorRow.published_body_json,
                priorRow.status,
                priorRow.published_at,
                priorRow.content_modified_at,
                priorRow.version,
                priorRow.updated_at,
                input.postId,
                swappedVersion,
              ),
        tenantDb
          .prepare(
            `DELETE FROM content_revisions
             WHERE resource_type = 'post' AND resource_id = ? AND revision_number = ?`,
          )
          .bind(input.postId, revisionNumber),
        tenantDb.prepare(`DELETE FROM post_taxonomies WHERE post_id = ?`).bind(input.postId),
        ...priorTaxIds.map((tid) =>
          tenantDb
            .prepare(`INSERT OR IGNORE INTO post_taxonomies (post_id, taxonomy_id) VALUES (?, ?)`)
            .bind(input.postId, tid),
        ),
      ];
      if (slugChanged) {
        restoreStmts.push(
          tenantDb
            .prepare(
              `DELETE FROM resource_slugs
               WHERE namespace = 'blog' AND slug = ? AND resource_id = ? AND is_current = 1`,
            )
            .bind(envelope.data.slug, input.postId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET is_current = 1, redirect_target_slug = NULL, updated_at = ?
               WHERE namespace = 'blog' AND slug = ? AND resource_id = ?`,
            )
            .bind(priorRow.updated_at, priorRow.slug, input.postId),
          tenantDb
            .prepare(
              `UPDATE resource_slugs
               SET redirect_target_slug = ?, updated_at = ?
               WHERE namespace = 'blog' AND resource_id = ? AND is_current = 0`,
            )
            .bind(priorRow.slug, priorRow.updated_at, input.postId),
        );
      }
      const restoreRes = await tenantDb.batch(restoreStmts);
      compensated = (restoreRes[0]?.meta?.changes ?? 0) === 1;
    } catch {
      // Compensation failed
    }
    throw new PublicationAtomicError(
      `Failed to complete atomic post publication (cache_version)${
        compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
      }`,
      { compensated, cause: platformError },
    );
  }

  const post = await getPostById(tenantDb, input.postId);
  if (!post) {
    throw new Error(`Failed to reload published post #${input.postId}`);
  }
  return {
    post,
    cacheVersion,
    revisionNumber,
    substantiveChanged: modDecision.substantiveChanged,
    contentFingerprint: modDecision.fingerprint,
  };
}

/**
 * Atomically unpublishes a live blog post back to `draft` and bumps `PLATFORM_DB.tenants.cache_version`.
 */
export async function unpublishPost(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: UnpublishPostInput,
): Promise<UnpublishPostResult> {
  assertValidPostId(input.postId);
  assertValidExpectedVersion(input.expectedVersion);

  const result = await unpublishResourceAtomically(platformDb, tenantDb, {
    tenantId: input.tenantId,
    resourceType: "post",
    resourceId: input.postId,
    expectedVersion: input.expectedVersion,
    nowMs: input.nowMs,
  });

  const post = await getPostById(tenantDb, input.postId);
  if (!post) {
    throw new Error(`Failed to reload unpublished post #${input.postId}`);
  }
  return {
    post,
    cacheVersion: result.cacheVersion,
  };
}

/**
 * Soft-deletes (trashes) a blog post: unpublishes public snapshot, sets `status = 'trashed'`
 * and `deleted_at = nowMs`, never reuses sequential ID, and bumps `tenants.cache_version`
 * if it was previously published (with fail-closed compensation).
 */
export async function trashPost(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: TrashPostInput,
): Promise<TrashPostResult> {
  assertValidPostId(input.postId);
  if (input.expectedVersion !== undefined) {
    assertValidExpectedVersion(input.expectedVersion);
  }
  const nowMs = input.nowMs ?? Date.now();

  const priorRow = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
  if (!priorRow) {
    throw new PublicationNotFoundError("post", input.postId);
  }

  const targetVersion = input.expectedVersion ?? Number(priorRow.version);
  if (Number(priorRow.version) !== targetVersion) {
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: targetVersion,
      actualVersion: Number(priorRow.version),
    });
  }

  const wasPublished = priorRow.status === "published" || priorRow.published_body_json !== null;

  const updateRes = await tenantDb
    .prepare(
      `UPDATE posts
       SET status = 'trashed',
           published_body_json = NULL,
           deleted_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(nowMs, nowMs, input.postId, targetVersion)
    .run();

  if ((updateRes.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: false });
    if (!latest) {
      throw new PublicationNotFoundError("post", input.postId);
    }
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
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
            `UPDATE posts
             SET status = ?,
                 published_body_json = ?,
                 deleted_at = NULL,
                 version = ?,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            priorRow.status,
            priorRow.published_body_json,
            priorRow.version,
            priorRow.updated_at,
            input.postId,
            swappedVersion,
          )
          .run();
        compensated = (restoreRes.meta?.changes ?? 0) === 1;
      } catch {
        // Compensation failed
      }
      throw new PublicationAtomicError(
        `Failed to bump tenant cache_version during post trash${
          compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
        }`,
        { compensated, cause: platformError },
      );
    }
  }

  const trashed = await getPostById(tenantDb, input.postId, { includeTrashed: true });
  if (!trashed) {
    throw new Error(`Failed to reload trashed post #${input.postId}`);
  }
  return { post: trashed, cacheVersion };
}

/**
 * Restores a trashed blog post back into `draft` state ONLY (never auto-publishes; PLAN §5.2).
 * Executes the version-guarded `UPDATE posts` and any `resource_slugs` transition inside ONE
 * atomic `tenantDb.batch([...])` gated on `EXISTS (SELECT 1 FROM posts WHERE ...)`.
 */
export async function restorePost(
  tenantDb: D1Database,
  input: RestorePostInput,
): Promise<PostRecord> {
  assertValidPostId(input.postId);
  assertValidExpectedVersion(input.expectedVersion);
  const nowMs = input.nowMs ?? Date.now();

  const row = await tenantDb
    .prepare(`SELECT * FROM posts WHERE id = ? AND status = 'trashed' AND deleted_at IS NOT NULL LIMIT 1`)
    .bind(input.postId)
    .first<RawPostRow>();

  if (!row) {
    throw new PublicationNotFoundError("post", input.postId);
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(row.version),
    });
  }

  const taxMap = await fetchPostTaxonomiesBatch(tenantDb, [input.postId]);
  const { draft } = extractPostDraftStateFromRow(
    row,
    taxMap.get(input.postId) ?? { categoryIds: [], tagIds: [] },
  );
  let nextSlug = String(row.slug);
  let nextDraftJson = row.draft_body_json;
  const nextVersion = input.expectedVersion + 1;

  let slugTransition: Awaited<ReturnType<typeof buildFormerSlugTransitionStatements>> | null = null;
  if (input.resolvedSlug !== undefined) {
    const validated = validateManualSlug(input.resolvedSlug, { namespace: "blog" });
    if (validated !== nextSlug) {
      const nextSerialized = serializeDraftStoragePayload("post", {
        ...draft,
        slug: validated,
      });
      slugTransition = await buildFormerSlugTransitionStatements(tenantDb, {
        namespace: "blog",
        resourceId: input.postId,
        oldSlug: nextSlug,
        newSlug: validated,
        wasEverPublished: row.published_at !== null,
        confirmSlugChange: true,
        allowSelfRevert: false,
        nowMs,
        guard: {
          sql: "EXISTS (SELECT 1 FROM posts WHERE id = ? AND slug = ? AND version = ? AND updated_at = ? AND deleted_at IS NULL)",
          binds: [input.postId, validated, nextVersion, nowMs],
        },
      });
      nextSlug = validated;
      nextDraftJson = nextSerialized.json;
    }
  }

  const batchStmts: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE posts
         SET slug = ?,
             draft_body_json = ?,
             status = 'draft',
             published_body_json = NULL,
             deleted_at = NULL,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ? AND status = 'trashed'`,
      )
      .bind(nextSlug, nextDraftJson, nowMs, input.postId, input.expectedVersion),
    ...(slugTransition ? slugTransition.statements : []),
  ];

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(batchStmts);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: true });
      if (latest && Number(latest.version) !== input.expectedVersion) {
        throw new StaleRevisionError({
          resourceType: "post",
          resourceId: input.postId,
          expectedVersion: input.expectedVersion,
          actualVersion: Number(latest.version),
        });
      }
      const suggested = await suggestAlternativeSlug(
        nextSlug,
        (candidate) => isPostSlugTaken(tenantDb, candidate, input.postId),
        { namespace: "blog" },
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
    const latest = await fetchRawPostRow(tenantDb, input.postId, { includeTrashed: true });
    throw new StaleRevisionError({
      resourceType: "post",
      resourceId: input.postId,
      expectedVersion: input.expectedVersion,
      actualVersion: latest ? Number(latest.version) : null,
    });
  }

  const restored = await getPostById(tenantDb, input.postId);
  if (!restored) {
    throw new Error(`Failed to reload restored post #${input.postId}`);
  }
  return restored;
}

/**
 * Lists up to the latest 20 published revisions for a blog post.
 */
export async function listPostRevisions(
  tenantDb: D1Database,
  postId: number,
): Promise<readonly PostRevisionSummary[]> {
  assertValidPostId(postId);
  const exists = await fetchRawPostRow(tenantDb, postId, { includeTrashed: true });
  if (!exists) {
    throw new PublicationNotFoundError("post", postId);
  }

  const res = await tenantDb
    .prepare(
      `SELECT revision_number, snapshot_json, created_by, created_at
       FROM content_revisions
       WHERE resource_type = 'post' AND resource_id = ?
       ORDER BY revision_number DESC
       LIMIT 20`,
    )
    .bind(postId)
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
      summary: `Published "${title}" (/blog/${slug})`,
    };
  });
}
