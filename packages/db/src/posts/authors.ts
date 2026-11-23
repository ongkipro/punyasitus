import {
  assertNoForbiddenTenantSelectors,
  type PublicationValidationField,
} from "@punyasitus/core/content/index";
import {
  assertTenantR2Key,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import {
  DEFAULT_MEDIA_CDN_ORIGIN,
  validateTrustedMediaOrigin,
} from "@punyasitus/core/og-generator";
import {
  normalizeAuthorRoleTitle,
  validateAuthorProfilePayload,
} from "@punyasitus/core/posts/index";
import { sanitizeSeoText } from "@punyasitus/core/seo/index";
import {
  normalizeAuthorBio,
  normalizeAuthorSameAsUrls,
  type PublicAuthorAvatarDto,
  type PublicAuthorProfileDto,
} from "@punyasitus/core/seo/local-entity";
import { allocateNextSequenceId, isUniqueConstraintError } from "../identifiers/index.ts";

/**
 * Tenant-Scoped Blog Author Profiles Repository (`packages/db/src/posts/authors.ts`;
 * REQ-092, PLAN §5.2 & §19.5, TASK-092).
 *
 * Operates strictly on the verified tenant's physically isolated `TenantStore.authors`
 * table, supporting additive `role_title` from `0020_blog_author_toc_modified.sql` while
 * remaining backward-compatible with pre-0020 databases.
 *
 * Security Invariants:
 * - Strictly tenant-scoped (never accepts `tenantId`/`organizationId` in payload).
 * - `avatarMediaId` is verified against THIS tenant's `media_items` (`kind = 'image'`,
 *   `status = 'ready'`, `deleted_at IS NULL`, and R2 key prefixed with `t/<tenantId>/media/...`).
 * - Optimistic concurrency (`expectedVersion` -> 409 `STALE_VERSION`).
 * - Guarded delete protecting authors referenced by posts (`409 AUTHOR_IN_USE`) unless
 *   explicitly detached (`detach: true`) or reassigned (`reassignToAuthorId`).
 */

export interface PostAuthorRecord extends PublicAuthorProfileDto {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly roleTitle: string | null;
  readonly bio: string | null;
  readonly avatarMediaId: number | null;
  readonly avatar: PublicAuthorAvatarDto | null;
  readonly sameAs: readonly string[];
  readonly postCount: number;
  readonly publishedPostCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePostAuthorInput {
  readonly name: string;
  readonly slug?: string | null;
  readonly roleTitle?: string | null;
  readonly role_title?: string | null;
  readonly bio?: string | null;
  readonly avatarMediaId?: number | null;
  readonly avatar_media_id?: number | null;
  readonly sameAs?: readonly string[] | string | null;
  readonly nowMs?: number;
}

export interface UpdatePostAuthorInput {
  readonly authorId: number;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly slug?: string | null;
  readonly roleTitle?: string | null;
  readonly role_title?: string | null;
  readonly bio?: string | null;
  readonly avatarMediaId?: number | null;
  readonly avatar_media_id?: number | null;
  readonly sameAs?: readonly string[] | string | null;
  readonly nowMs?: number;
}

export interface DeletePostAuthorInput {
  readonly authorId: number;
  readonly expectedVersion: number;
  readonly detach?: boolean;
  readonly reassignToAuthorId?: number | null;
  readonly nowMs?: number;
}

export interface PostAuthorScopeOptions {
  readonly tenantId: string;
  readonly mediaBaseOrigin?: string | null;
}

export class PostAuthorValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly PublicationValidationField[];

  constructor(message: string, fields: readonly PublicationValidationField[]) {
    super(message);
    this.name = "PostAuthorValidationError";
    this.fields = fields;
  }
}

export class PostAuthorNotFoundError extends Error {
  readonly httpStatus = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly authorId: number;

  constructor(authorId: number) {
    super(`Profil penulis #${authorId} tidak ditemukan.`);
    this.name = "PostAuthorNotFoundError";
    this.authorId = authorId;
  }
}

export class PostAuthorStaleVersionError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "STALE_VERSION" as const;
  readonly authorId: number;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(params: {
    readonly authorId: number;
    readonly expectedVersion: number;
    readonly actualVersion?: number | null;
  }) {
    super(
      `Versi profil penulis #${params.authorId} sudah berubah (diharapkan v${params.expectedVersion}${
        params.actualVersion !== undefined && params.actualVersion !== null
          ? `, saat ini v${params.actualVersion}`
          : ""
      }).`,
    );
    this.name = "PostAuthorStaleVersionError";
    this.authorId = params.authorId;
    this.expectedVersion = params.expectedVersion;
    this.actualVersion = params.actualVersion ?? null;
  }
}

export class PostAuthorConflictError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "CONFLICT" as const;
  readonly reason: "AUTHOR_IN_USE" | "SLUG_CONFLICT";
  readonly postCount: number;
  readonly publishedPostCount: number;
  readonly fields: readonly PublicationValidationField[];

  constructor(
    reason: "AUTHOR_IN_USE" | "SLUG_CONFLICT",
    message: string,
    meta: { readonly postCount?: number; readonly publishedPostCount?: number; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "PostAuthorConflictError";
    this.reason = reason;
    this.postCount = meta.postCount ?? 0;
    this.publishedPostCount = meta.publishedPostCount ?? 0;
    this.fields = [{ field: meta.field ?? "authorId", code: reason, message }];
  }
}

interface RawAuthorRow {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly role_title?: string | null;
  readonly bio: string | null;
  readonly avatar_media_id: number | null;
  readonly social_url: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawAvatarMediaRow {
  readonly id: number;
  readonly kind: string;
  readonly r2_key: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt_text: string;
  readonly variants_json: string | null;
  readonly status: string;
  readonly deleted_at?: number | null;
}

function toIsoTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function assertValidAuthorId(authorId: number, field = "authorId"): void {
  if (!Number.isSafeInteger(authorId) || authorId < 1 || authorId > 2_147_483_647) {
    throw new PostAuthorValidationError(`${field} harus berupa bilangan bulat positif.`, [
      { field, code: "INVALID_ID", message: `${field} must be a positive integer.` },
    ]);
  }
}

function assertValidExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0 || version > 2_147_483_647) {
    throw new PostAuthorValidationError("version harus berupa bilangan bulat non-negatif.", [
      { field: "version", code: "INVALID_VERSION", message: "Expected a non-negative integer version." },
    ]);
  }
}

function resolveMediaOrigin(rawOrigin?: string | null): string {
  if (rawOrigin) {
    const valid = validateTrustedMediaOrigin(rawOrigin);
    if (valid) return valid;
  }
  return DEFAULT_MEDIA_CDN_ORIGIN;
}

function deriveAuthorBaseSlug(name: string, fallbackId: number): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || `penulis-${fallbackId}`;
}

function serializeSameAsColumn(sameAs: readonly string[]): string | null {
  if (sameAs.length === 0) return null;
  if (sameAs.length === 1) return sameAs[0] ?? null;
  return JSON.stringify(sameAs);
}

async function hasAuthorRoleTitleColumn(tenantDb: D1Database): Promise<boolean> {
  try {
    const res = await tenantDb
      .prepare(`PRAGMA table_info(authors)`)
      .all<{ readonly name: string }>();
    return res.results.some((col) => col.name === "role_title");
  } catch {
    return false;
  }
}

function assertRequiredTenantId(tenantId: string): string {
  const clean = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!clean) {
    throw new PostAuthorValidationError("tenantId wajib disediakan untuk validasi isolasi media.", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId is required." },
    ]);
  }
  return clean;
}

function mapAvatarRow(
  row: RawAvatarMediaRow,
  authorName: string,
  options: PostAuthorScopeOptions,
): PublicAuthorAvatarDto | null {
  if (row.kind !== "image" || row.status !== "ready") return null;
  if (row.deleted_at !== undefined && row.deleted_at !== null) return null;

  const tenantId = typeof options.tenantId === "string" ? options.tenantId.trim() : "";
  if (!tenantId) return null;

  let preferredKey = row.r2_key;
  let width = row.width ?? 256;
  let height = row.height ?? 256;

  if (row.variants_json) {
    try {
      const variants = JSON.parse(row.variants_json) as Partial<MediaVariantsManifest>;
      const chosen = variants.w640 ?? variants.master ?? variants.w1280 ?? variants.og ?? null;
      if (chosen?.key) {
        preferredKey = chosen.key;
        width = chosen.width ?? width;
        height = chosen.height ?? height;
      }
    } catch {
      // Fall back to base r2_key
    }
  }

  if (!preferredKey || typeof preferredKey !== "string") return null;

  let verifiedKey: string;
  try {
    verifiedKey = assertTenantR2Key(tenantId, preferredKey, ["media"]).replace(/^\/+/, "");
  } catch {
    return null;
  }

  const origin = resolveMediaOrigin(options.mediaBaseOrigin);
  return {
    id: Number(row.id),
    url: `${origin}/${verifiedKey}`,
    alt: sanitizeSeoText(row.alt_text || `Foto profil ${authorName}`, { maxLength: 160 }),
    width: Math.max(1, Number(width) || 256),
    height: Math.max(1, Number(height) || 256),
  };
}

async function loadAvatarsByIds(
  tenantDb: D1Database,
  mediaIds: ReadonlySet<number>,
): Promise<Map<number, RawAvatarMediaRow>> {
  const map = new Map<number, RawAvatarMediaRow>();
  const ids = Array.from(mediaIds).filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return map;

  const placeholders = ids.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<RawAvatarMediaRow>();
    for (const row of res.results) {
      map.set(Number(row.id), row);
    }
  } catch {
    return map;
  }
  return map;
}

async function loadAuthorPostCountsBatch(
  tenantDb: D1Database,
  authorIds: readonly number[],
): Promise<Map<number, { readonly postCount: number; readonly publishedPostCount: number }>> {
  const map = new Map<number, { readonly postCount: number; readonly publishedPostCount: number }>();
  if (authorIds.length === 0) return map;

  const placeholders = authorIds.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(
        `SELECT author_id,
                COUNT(*) AS post_count,
                SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published_count
         FROM posts
         WHERE author_id IN (${placeholders}) AND deleted_at IS NULL
         GROUP BY author_id`,
      )
      .bind(...authorIds)
      .all<{
        readonly author_id: number;
        readonly post_count: number;
        readonly published_count: number;
      }>();
    for (const row of res.results) {
      map.set(Number(row.author_id), {
        postCount: Number(row.post_count ?? 0),
        publishedPostCount: Number(row.published_count ?? 0),
      });
    }
  } catch {
    return map;
  }
  return map;
}

async function verifyOwnedReadyAuthorAvatar(
  tenantDb: D1Database,
  avatarMediaId: number | null,
  options: PostAuthorScopeOptions,
): Promise<number | null> {
  if (avatarMediaId === null) return null;
  const tenantId = assertRequiredTenantId(options.tenantId);

  const row = await tenantDb
    .prepare(`SELECT * FROM media_items WHERE id = ? LIMIT 1`)
    .bind(avatarMediaId)
    .first<RawAvatarMediaRow>()
    .catch(() => null);

  if (!row || row.kind !== "image" || row.status !== "ready" || row.deleted_at) {
    throw new PostAuthorValidationError(
      "Avatar penulis wajib menggunakan gambar milik situs ini yang berstatus siap (ready).",
      [
        {
          field: "avatarMediaId",
          code: "MEDIA_NOT_FOUND",
          message: `Media #${avatarMediaId} tidak ditemukan atau bukan gambar siap milik tenant ini.`,
        },
      ],
    );
  }

  try {
    assertTenantR2Key(tenantId, row.r2_key, ["media"]);
  } catch {
    throw new PostAuthorValidationError(
      "Avatar penulis wajib berada di bawah penyimpanan media milik tenant ini.",
      [
        {
          field: "avatarMediaId",
          code: "MEDIA_FORBIDDEN",
          message: `Media #${avatarMediaId} tidak sesuai dengan prefix tenant ini.`,
        },
      ],
    );
  }

  return Number(row.id);
}

function mapRawAuthorRow(
  row: RawAuthorRow,
  avatarsById: ReadonlyMap<number, RawAvatarMediaRow>,
  countsById: ReadonlyMap<number, { readonly postCount: number; readonly publishedPostCount: number }>,
  options: PostAuthorScopeOptions,
): PostAuthorRecord {
  const name = sanitizeSeoText(row.name, { maxLength: 120 }) || "Tim Redaksi";
  const avatarMediaId =
    typeof row.avatar_media_id === "number" && Number.isSafeInteger(row.avatar_media_id)
      ? row.avatar_media_id
      : null;
  const rawAvatar = avatarMediaId ? (avatarsById.get(avatarMediaId) ?? null) : null;
  const counts = countsById.get(Number(row.id)) ?? { postCount: 0, publishedPostCount: 0 };

  return {
    id: Number(row.id),
    name,
    slug: String(row.slug),
    roleTitle: normalizeAuthorRoleTitle(row.role_title),
    bio: normalizeAuthorBio(row.bio),
    avatarMediaId,
    avatar: rawAvatar ? mapAvatarRow(rawAvatar, name, options) : null,
    sameAs: normalizeAuthorSameAsUrls(row.social_url),
    postCount: counts.postCount,
    publishedPostCount: counts.publishedPostCount,
    version: Number(row.version ?? 1),
    createdAt: toIsoTimestamp(Number(row.created_at)),
    updatedAt: toIsoTimestamp(Number(row.updated_at)),
  };
}

export async function getPostAuthorById(
  tenantDb: D1Database,
  authorId: number,
  options: PostAuthorScopeOptions,
): Promise<PostAuthorRecord | null> {
  assertRequiredTenantId(options.tenantId);
  if (!Number.isSafeInteger(authorId) || authorId < 1) return null;
  const row = await tenantDb
    .prepare(`SELECT * FROM authors WHERE id = ? LIMIT 1`)
    .bind(authorId)
    .first<RawAuthorRow>()
    .catch(() => null);
  if (!row) return null;

  const mediaIds = new Set<number>();
  if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  const [avatars, counts] = await Promise.all([
    loadAvatarsByIds(tenantDb, mediaIds),
    loadAuthorPostCountsBatch(tenantDb, [Number(row.id)]),
  ]);
  return mapRawAuthorRow(row, avatars, counts, options);
}

export async function loadPostAuthorsByIds(
  tenantDb: D1Database,
  authorIds: ReadonlySet<number> | readonly number[],
  options: PostAuthorScopeOptions,
): Promise<Map<number, PostAuthorRecord>> {
  assertRequiredTenantId(options.tenantId);
  const result = new Map<number, PostAuthorRecord>();
  const ids = Array.from(new Set(authorIds)).filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT * FROM authors WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<RawAuthorRow>()
    .catch(() => ({ results: [] as RawAuthorRow[] }));

  const mediaIds = new Set<number>();
  const foundIds: number[] = [];
  for (const row of res.results) {
    foundIds.push(Number(row.id));
    if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  }
  const [avatars, counts] = await Promise.all([
    loadAvatarsByIds(tenantDb, mediaIds),
    loadAuthorPostCountsBatch(tenantDb, foundIds),
  ]);

  for (const row of res.results) {
    const mapped = mapRawAuthorRow(row, avatars, counts, options);
    result.set(mapped.id, mapped);
  }
  return result;
}

export async function listPostAuthors(
  tenantDb: D1Database,
  options: PostAuthorScopeOptions & { readonly limit?: number },
): Promise<readonly PostAuthorRecord[]> {
  assertRequiredTenantId(options.tenantId);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const res = await tenantDb
    .prepare(`SELECT * FROM authors ORDER BY id ASC LIMIT ?`)
    .bind(limit)
    .all<RawAuthorRow>()
    .catch(() => ({ results: [] as RawAuthorRow[] }));

  const mediaIds = new Set<number>();
  const ids: number[] = [];
  for (const row of res.results) {
    ids.push(Number(row.id));
    if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  }

  const [avatars, counts] = await Promise.all([
    loadAvatarsByIds(tenantDb, mediaIds),
    loadAuthorPostCountsBatch(tenantDb, ids),
  ]);

  return res.results.map((row) => mapRawAuthorRow(row, avatars, counts, options));
}

export async function createPostAuthor(
  tenantDb: D1Database,
  input: CreatePostAuthorInput,
  options: PostAuthorScopeOptions,
): Promise<PostAuthorRecord> {
  assertRequiredTenantId(options.tenantId);
  assertNoForbiddenTenantSelectors(input);

  const validated = validateAuthorProfilePayload(input);
  if (!validated.ok) {
    throw new PostAuthorValidationError(
      validated.errors[0]?.message ?? "Data profil penulis tidak valid.",
      validated.errors,
    );
  }

  const { name, slug: manualSlug, roleTitle, bio, avatarMediaId, sameAs } = validated.data;
  const verifiedAvatarId = await verifyOwnedReadyAuthorAvatar(tenantDb, avatarMediaId, options);
  const socialUrl = serializeSameAsColumn(sameAs);
  const supportsRoleTitle = await hasAuthorRoleTitleColumn(tenantDb);
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  if (manualSlug !== null) {
    const existingSlug = await tenantDb
      .prepare(`SELECT id FROM authors WHERE slug = ? LIMIT 1`)
      .bind(manualSlug)
      .first<{ readonly id: number }>();
    if (existingSlug) {
      throw new PostAuthorConflictError(
        "SLUG_CONFLICT",
        `Slug penulis "${manualSlug}" sudah digunakan di situs ini.`,
        { field: "slug" },
      );
    }
  }

  const id = await allocateNextSequenceId(tenantDb, "author");
  const baseSlug = manualSlug ?? deriveAuthorBaseSlug(name, id);
  const maxAttempts = manualSlug !== null ? 1 : 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidateSlug = attempt === 1 ? baseSlug : `${baseSlug.slice(0, 72)}-${attempt}`;
    try {
      if (supportsRoleTitle) {
        await tenantDb
          .prepare(
            `INSERT INTO authors (
               id, name, slug, role_title, bio, avatar_media_id, social_url,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(id, name, candidateSlug, roleTitle, bio, verifiedAvatarId, socialUrl, nowMs, nowMs)
          .run();
      } else {
        await tenantDb
          .prepare(
            `INSERT INTO authors (
               id, name, slug, bio, avatar_media_id, social_url,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(id, name, candidateSlug, bio, verifiedAvatarId, socialUrl, nowMs, nowMs)
          .run();
      }

      const created = await getPostAuthorById(tenantDb, id, options);
      if (!created) {
        throw new Error(`Failed to reload newly created author #${id}.`);
      }
      return created;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        if (manualSlug !== null) {
          throw new PostAuthorConflictError(
            "SLUG_CONFLICT",
            `Slug penulis "${manualSlug}" sudah digunakan di situs ini.`,
            { field: "slug" },
          );
        }
        continue;
      }
      throw err;
    }
  }

  throw new PostAuthorConflictError(
    "SLUG_CONFLICT",
    `Gagal mengalokasikan slug unik untuk penulis "${name}".`,
    { field: "slug" },
  );
}

export async function updatePostAuthor(
  tenantDb: D1Database,
  input: UpdatePostAuthorInput,
  options: PostAuthorScopeOptions,
): Promise<PostAuthorRecord> {
  assertRequiredTenantId(options.tenantId);
  assertNoForbiddenTenantSelectors(input);
  assertValidAuthorId(input.authorId);
  assertValidExpectedVersion(input.expectedVersion);

  const existing = await tenantDb
    .prepare(`SELECT * FROM authors WHERE id = ? LIMIT 1`)
    .bind(input.authorId)
    .first<RawAuthorRow>();
  if (!existing) {
    throw new PostAuthorNotFoundError(input.authorId);
  }
  if (Number(existing.version) !== input.expectedVersion) {
    throw new PostAuthorStaleVersionError({
      authorId: input.authorId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(existing.version),
    });
  }

  const nextRoleInput =
    input.roleTitle !== undefined
      ? input.roleTitle
      : input.role_title !== undefined
        ? input.role_title
        : (existing.role_title ?? null);
  const nextAvatarInput =
    input.avatarMediaId !== undefined
      ? input.avatarMediaId
      : input.avatar_media_id !== undefined
        ? input.avatar_media_id
        : existing.avatar_media_id;

  const validated = validateAuthorProfilePayload({
    name: input.name !== undefined ? input.name : existing.name,
    slug: input.slug !== undefined ? input.slug : existing.slug,
    roleTitle: nextRoleInput,
    bio: input.bio !== undefined ? input.bio : existing.bio,
    avatarMediaId: nextAvatarInput,
    sameAs:
      input.sameAs !== undefined ? input.sameAs : normalizeAuthorSameAsUrls(existing.social_url),
  });
  if (!validated.ok) {
    throw new PostAuthorValidationError(
      validated.errors[0]?.message ?? "Data pembaruan profil penulis tidak valid.",
      validated.errors,
    );
  }

  const { name, slug, roleTitle, bio, avatarMediaId, sameAs } = validated.data;
  const nextSlug = slug ?? existing.slug;
  const verifiedAvatarId = await verifyOwnedReadyAuthorAvatar(tenantDb, avatarMediaId, options);
  const socialUrl = serializeSameAsColumn(sameAs);
  const supportsRoleTitle = await hasAuthorRoleTitleColumn(tenantDb);
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  let res: D1Result;
  try {
    if (supportsRoleTitle) {
      res = await tenantDb
        .prepare(
          `UPDATE authors
           SET name = ?,
               slug = ?,
               role_title = ?,
               bio = ?,
               avatar_media_id = ?,
               social_url = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          name,
          nextSlug,
          roleTitle,
          bio,
          verifiedAvatarId,
          socialUrl,
          nowMs,
          input.authorId,
          input.expectedVersion,
        )
        .run();
    } else {
      res = await tenantDb
        .prepare(
          `UPDATE authors
           SET name = ?,
               slug = ?,
               bio = ?,
               avatar_media_id = ?,
               social_url = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          name,
          nextSlug,
          bio,
          verifiedAvatarId,
          socialUrl,
          nowMs,
          input.authorId,
          input.expectedVersion,
        )
        .run();
    }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new PostAuthorConflictError(
        "SLUG_CONFLICT",
        `Slug penulis "${nextSlug}" sudah digunakan oleh penulis lain di situs ini.`,
        { field: "slug" },
      );
    }
    throw err;
  }

  if ((res.meta?.changes ?? 0) !== 1) {
    const latest = await tenantDb
      .prepare(`SELECT version FROM authors WHERE id = ? LIMIT 1`)
      .bind(input.authorId)
      .first<{ readonly version: number }>();
    if (!latest) {
      throw new PostAuthorNotFoundError(input.authorId);
    }
    throw new PostAuthorStaleVersionError({
      authorId: input.authorId,
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest.version),
    });
  }

  const updated = await getPostAuthorById(tenantDb, input.authorId, options);
  if (!updated) {
    throw new PostAuthorNotFoundError(input.authorId);
  }
  return updated;
}

export async function deletePostAuthor(
  tenantDb: D1Database,
  input: DeletePostAuthorInput,
): Promise<void> {
  assertNoForbiddenTenantSelectors(input);
  assertValidAuthorId(input.authorId);
  assertValidExpectedVersion(input.expectedVersion);

  const existing = await tenantDb
    .prepare(`SELECT id, version FROM authors WHERE id = ? LIMIT 1`)
    .bind(input.authorId)
    .first<{ readonly id: number; readonly version: number }>();
  if (!existing) {
    throw new PostAuthorNotFoundError(input.authorId);
  }

  const targetVersion = input.expectedVersion;
  if (Number(existing.version) !== targetVersion) {
    throw new PostAuthorStaleVersionError({
      authorId: input.authorId,
      expectedVersion: targetVersion,
      actualVersion: Number(existing.version),
    });
  }

  let reassignId: number | null = null;
  if (input.reassignToAuthorId !== undefined && input.reassignToAuthorId !== null) {
    assertValidAuthorId(input.reassignToAuthorId, "reassignToAuthorId");
    if (input.reassignToAuthorId === input.authorId) {
      throw new PostAuthorValidationError("Penulis tujuan pengalihan tidak boleh sama.", [
        {
          field: "reassignToAuthorId",
          code: "INVALID_REASSIGN_TARGET",
          message: "reassignToAuthorId must differ from authorId.",
        },
      ]);
    }
    const targetAuthor = await tenantDb
      .prepare(`SELECT id FROM authors WHERE id = ? LIMIT 1`)
      .bind(input.reassignToAuthorId)
      .first<{ readonly id: number }>();
    if (!targetAuthor) {
      throw new PostAuthorValidationError("Profil penulis tujuan tidak ditemukan di situs ini.", [
        {
          field: "reassignToAuthorId",
          code: "AUTHOR_NOT_FOUND",
          message: `Author #${input.reassignToAuthorId} not found in this tenant.`,
        },
      ]);
    }
    reassignId = input.reassignToAuthorId;
  }

  const countsMap = await loadAuthorPostCountsBatch(tenantDb, [input.authorId]);
  const counts = countsMap.get(input.authorId) ?? { postCount: 0, publishedPostCount: 0 };

  if (counts.postCount > 0 && !input.detach && reassignId === null) {
    throw new PostAuthorConflictError(
      "AUTHOR_IN_USE",
      `Profil penulis masih digunakan oleh ${counts.postCount} artikel (${counts.publishedPostCount} terbit). Lepaskan tautan penulis atau alihkan ke penulis lain terlebih dahulu.`,
      {
        postCount: counts.postCount,
        publishedPostCount: counts.publishedPostCount,
      },
    );
  }

  const batchStmts: D1PreparedStatement[] = [];
  if (reassignId !== null) {
    batchStmts.push(
      tenantDb
        .prepare(
          `UPDATE posts
           SET author_id = ?
           WHERE author_id = ?
             AND EXISTS (SELECT 1 FROM authors WHERE id = ? AND version = ?)`,
        )
        .bind(reassignId, input.authorId, input.authorId, targetVersion),
    );
  } else {
    batchStmts.push(
      tenantDb
        .prepare(
          `UPDATE posts
           SET author_id = NULL
           WHERE author_id = ?
             AND EXISTS (SELECT 1 FROM authors WHERE id = ? AND version = ?)`,
        )
        .bind(input.authorId, input.authorId, targetVersion),
    );
  }

  batchStmts.push(
    tenantDb
      .prepare(`DELETE FROM authors WHERE id = ? AND version = ?`)
      .bind(input.authorId, targetVersion),
  );

  const results = await tenantDb.batch(batchStmts);
  const deleteResult = results[results.length - 1];
  if ((deleteResult?.meta?.changes ?? 0) !== 1) {
    const latest = await tenantDb
      .prepare(`SELECT version FROM authors WHERE id = ? LIMIT 1`)
      .bind(input.authorId)
      .first<{ readonly version: number }>();
    if (!latest) {
      throw new PostAuthorNotFoundError(input.authorId);
    }
    throw new PostAuthorStaleVersionError({
      authorId: input.authorId,
      expectedVersion: targetVersion,
      actualVersion: Number(latest.version),
    });
  }
}
