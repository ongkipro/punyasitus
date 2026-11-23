import {
  assertTenantR2Key,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import {
  DEFAULT_MEDIA_CDN_ORIGIN,
  validateTrustedMediaOrigin,
} from "@punyasitus/core/og-generator";
import { sanitizeSeoText } from "@punyasitus/core/seo/index";
import {
  MAX_AUTHOR_BIO_LENGTH,
  MAX_AUTHOR_SAME_AS_LINKS,
  normalizeAuthorBio,
  normalizeAuthorSameAsUrls,
  type PublicAuthorAvatarDto,
  type PublicAuthorProfileDto,
} from "@punyasitus/core/seo/local-entity";
import { allocateNextSequenceId } from "../identifiers/index.ts";

/**
 * Tenant-Scoped Public Author Profiles Repository
 * (`packages/db/src/authors/index.ts`; REQ-054, PLAN §15.7, TASK-053).
 *
 * Operates strictly on the existing `authors` table provisioned in `0001_initial_tenant.sql`
 * (zero request-time DDL, zero new migration required):
 * - Display name (bounded, sanitized)
 * - Bio (max 300 chars per PLAN §15.7)
 * - Verified ready tenant avatar (`media_items.kind = 'image' AND status = 'ready' AND deleted_at IS NULL`)
 * - Up to 5 validated public HTTPS `sameAs` profile links stored in `social_url`
 * - No public author archive route in v1 (PLAN §15.7)
 */

export interface PublicAuthorRecord extends PublicAuthorProfileDto {
  readonly id: number;
  readonly slug: string;
  readonly avatarMediaId: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertPublicAuthorInput {
  readonly name: string;
  readonly slug?: string | null;
  readonly bio?: string | null;
  readonly avatarMediaId?: number | null;
  readonly sameAs?: readonly string[] | string | null;
  readonly nowMs?: number;
}

export interface LoadPublicAuthorOptions {
  readonly tenantId?: string | null;
  readonly mediaBaseOrigin?: string | null;
}

export class AuthorValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly field: string;

  constructor(message: string, field = "author") {
    super(message);
    this.name = "AuthorValidationError";
    this.field = field;
  }
}

interface RawAuthorRow {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
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

function resolveMediaOrigin(rawOrigin?: string | null): string {
  if (rawOrigin) {
    const valid = validateTrustedMediaOrigin(rawOrigin);
    if (valid) return valid;
  }
  return DEFAULT_MEDIA_CDN_ORIGIN;
}

function normalizeAuthorSlug(raw: string | null | undefined, fallbackName: string): string {
  const source = (raw && raw.trim().length > 0 ? raw : fallbackName).trim();
  const slug = source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new AuthorValidationError("Slug penulis tidak valid.", "slug");
  }
  return slug;
}

export function parseAuthorSameAsLinks(rawSocialUrl: string | null | undefined): readonly string[] {
  return normalizeAuthorSameAsUrls(rawSocialUrl);
}

/**
 * Serializes up to 5 validated HTTPS `sameAs` links into `authors.social_url`:
 * - 0 links -> `null`
 * - 1 link -> plain HTTPS URL string (backwards-compatible)
 * - 2..5 links -> JSON array string
 */
export function serializeAuthorSameAsLinks(
  rawLinks: string | readonly string[] | null | undefined,
): string | null {
  if (rawLinks === null || rawLinks === undefined) return null;
  const rawList = Array.isArray(rawLinks)
    ? rawLinks
    : typeof rawLinks === "string" && rawLinks.trim().length > 0
      ? rawLinks.trim().startsWith("[")
        ? (() => {
            try {
              const parsed: unknown = JSON.parse(rawLinks);
              return Array.isArray(parsed) ? parsed : [rawLinks];
            } catch {
              return [rawLinks];
            }
          })()
        : [rawLinks]
      : [];

  if (rawList.length > MAX_AUTHOR_SAME_AS_LINKS) {
    throw new AuthorValidationError(
      `Maksimal ${MAX_AUTHOR_SAME_AS_LINKS} tautan profil (sameAs) per penulis.`,
      "sameAs",
    );
  }

  const normalized = normalizeAuthorSameAsUrls(rawList as readonly string[]);
  if (rawList.length > 0 && normalized.length !== rawList.length) {
    throw new AuthorValidationError(
      "Setiap tautan profil penulis (sameAs) wajib berupa URL HTTPS publik yang valid.",
      "sameAs",
    );
  }

  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0] ?? null;
  return JSON.stringify(normalized);
}

function mapAvatarMediaRow(
  row: RawAvatarMediaRow,
  authorName: string,
  options: LoadPublicAuthorOptions,
): PublicAuthorAvatarDto | null {
  if (row.kind !== "image" || row.status !== "ready") return null;
  if (row.deleted_at !== undefined && row.deleted_at !== null) return null;

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

  let verifiedKey = preferredKey.replace(/^\/+/, "");
  if (options.tenantId) {
    try {
      verifiedKey = assertTenantR2Key(options.tenantId, preferredKey, ["media"]).replace(/^\/+/, "");
    } catch {
      return null;
    }
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

async function loadAvatarMediaByIds(
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

function mapRawAuthorRow(
  row: RawAuthorRow,
  avatarsByMediaId: ReadonlyMap<number, RawAvatarMediaRow>,
  options: LoadPublicAuthorOptions,
): PublicAuthorRecord {
  const name = sanitizeSeoText(row.name, { maxLength: 120 }) || "Tim Redaksi";
  const avatarMediaId =
    typeof row.avatar_media_id === "number" && Number.isSafeInteger(row.avatar_media_id)
      ? row.avatar_media_id
      : null;
  const rawAvatar = avatarMediaId ? avatarsByMediaId.get(avatarMediaId) ?? null : null;

  return {
    id: Number(row.id),
    name,
    slug: String(row.slug),
    bio: normalizeAuthorBio(row.bio),
    avatarMediaId,
    avatar: rawAvatar ? mapAvatarMediaRow(rawAvatar, name, options) : null,
    sameAs: parseAuthorSameAsLinks(row.social_url),
    version: Number(row.version ?? 1),
    createdAt: toIsoTimestamp(Number(row.created_at)),
    updatedAt: toIsoTimestamp(Number(row.updated_at)),
  };
}

export async function getPublicAuthorById(
  tenantDb: D1Database,
  authorId: number,
  options: LoadPublicAuthorOptions = {},
): Promise<PublicAuthorRecord | null> {
  if (!Number.isSafeInteger(authorId) || authorId < 1) return null;
  const row = await tenantDb
    .prepare(
      `SELECT id, name, slug, bio, avatar_media_id, social_url, version, created_at, updated_at
       FROM authors
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(authorId)
    .first<RawAuthorRow>()
    .catch(() => null);
  if (!row) return null;

  const mediaIds = new Set<number>();
  if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  const avatars = await loadAvatarMediaByIds(tenantDb, mediaIds);
  return mapRawAuthorRow(row, avatars, options);
}

export async function loadPublicAuthorsByIds(
  tenantDb: D1Database,
  authorIds: ReadonlySet<number> | readonly number[],
  options: LoadPublicAuthorOptions = {},
): Promise<Map<number, PublicAuthorRecord>> {
  const result = new Map<number, PublicAuthorRecord>();
  const ids = Array.from(new Set(authorIds)).filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT id, name, slug, bio, avatar_media_id, social_url, version, created_at, updated_at
       FROM authors
       WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<RawAuthorRow>()
    .catch(() => ({ results: [] as RawAuthorRow[] }));

  const mediaIds = new Set<number>();
  for (const row of res.results) {
    if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  }
  const avatars = await loadAvatarMediaByIds(tenantDb, mediaIds);

  for (const row of res.results) {
    const mapped = mapRawAuthorRow(row, avatars, options);
    result.set(mapped.id, mapped);
  }
  return result;
}

export async function listPublicAuthors(
  tenantDb: D1Database,
  options: LoadPublicAuthorOptions & { readonly limit?: number } = {},
): Promise<readonly PublicAuthorRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const res = await tenantDb
    .prepare(
      `SELECT id, name, slug, bio, avatar_media_id, social_url, version, created_at, updated_at
       FROM authors
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<RawAuthorRow>()
    .catch(() => ({ results: [] as RawAuthorRow[] }));

  const mediaIds = new Set<number>();
  for (const row of res.results) {
    if (row.avatar_media_id) mediaIds.add(Number(row.avatar_media_id));
  }
  const avatars = await loadAvatarMediaByIds(tenantDb, mediaIds);
  return res.results.map((row) => mapRawAuthorRow(row, avatars, options));
}

async function verifyOwnedReadyAvatarMediaId(
  tenantDb: D1Database,
  avatarMediaId: number | null | undefined,
): Promise<number | null> {
  if (avatarMediaId === null || avatarMediaId === undefined) return null;
  if (!Number.isSafeInteger(avatarMediaId) || avatarMediaId < 1) {
    throw new AuthorValidationError("ID media avatar penulis tidak valid.", "avatarMediaId");
  }
  const row = await tenantDb
    .prepare(`SELECT * FROM media_items WHERE id = ? LIMIT 1`)
    .bind(avatarMediaId)
    .first<{
      readonly id: number;
      readonly kind: string;
      readonly status: string;
      readonly deleted_at?: number | null;
    }>()
    .catch(() => null);
  if (!row || row.kind !== "image" || row.status !== "ready" || row.deleted_at) {
    throw new AuthorValidationError(
      "Avatar penulis wajib menggunakan gambar milik situs ini yang berstatus siap (ready).",
      "avatarMediaId",
    );
  }
  return Number(row.id);
}

/**
 * Creates a tenant-scoped public author profile (`PLAN §15.7`):
 * display name, bio (<= 300 chars), optional ready avatar, up to 5 validated HTTPS `sameAs` links.
 */
export async function createPublicAuthor(
  tenantDb: D1Database,
  input: UpsertPublicAuthorInput,
  options: LoadPublicAuthorOptions = {},
): Promise<PublicAuthorRecord> {
  const name = sanitizeSeoText(input.name ?? "", { maxLength: 120 });
  if (!name) {
    throw new AuthorValidationError("Nama tampilan penulis wajib diisi.", "name");
  }
  if (typeof input.bio === "string" && input.bio.trim().length > MAX_AUTHOR_BIO_LENGTH) {
    throw new AuthorValidationError(
      `Bio penulis maksimal ${MAX_AUTHOR_BIO_LENGTH} karakter.`,
      "bio",
    );
  }
  const bio = normalizeAuthorBio(input.bio);
  const slug = normalizeAuthorSlug(input.slug, name);
  const socialUrl = serializeAuthorSameAsLinks(input.sameAs);
  const avatarMediaId = await verifyOwnedReadyAvatarMediaId(tenantDb, input.avatarMediaId);
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const id = await allocateNextSequenceId(tenantDb, "author");

  await tenantDb
    .prepare(
      `INSERT INTO authors (
         id, name, slug, bio, avatar_media_id, social_url, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, name, slug, bio, avatarMediaId, socialUrl, nowMs, nowMs)
    .run();

  const created = await getPublicAuthorById(tenantDb, id, options);
  if (!created) {
    throw new Error(`Failed to reload newly created author #${id}.`);
  }
  return created;
}

/**
 * Updates an existing tenant-scoped public author profile with strict bio (<= 300),
 * avatar ownership/ready check, and `sameAs` (<= 5 HTTPS URLs) validation.
 */
export async function updatePublicAuthor(
  tenantDb: D1Database,
  authorId: number,
  input: Partial<UpsertPublicAuthorInput>,
  options: LoadPublicAuthorOptions = {},
): Promise<PublicAuthorRecord | null> {
  const existing = await getPublicAuthorById(tenantDb, authorId, options);
  if (!existing) return null;

  const nextName =
    input.name !== undefined ? sanitizeSeoText(input.name, { maxLength: 120 }) : existing.name;
  if (!nextName) {
    throw new AuthorValidationError("Nama tampilan penulis wajib diisi.", "name");
  }
  if (typeof input.bio === "string" && input.bio.trim().length > MAX_AUTHOR_BIO_LENGTH) {
    throw new AuthorValidationError(
      `Bio penulis maksimal ${MAX_AUTHOR_BIO_LENGTH} karakter.`,
      "bio",
    );
  }
  const nextBio = input.bio !== undefined ? normalizeAuthorBio(input.bio) : existing.bio;
  const nextSlug = input.slug !== undefined ? normalizeAuthorSlug(input.slug, nextName) : existing.slug;
  const nextSocialUrl =
    input.sameAs !== undefined
      ? serializeAuthorSameAsLinks(input.sameAs)
      : serializeAuthorSameAsLinks(existing.sameAs);
  const nextAvatarMediaId =
    input.avatarMediaId !== undefined
      ? await verifyOwnedReadyAvatarMediaId(tenantDb, input.avatarMediaId)
      : existing.avatarMediaId;
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  await tenantDb
    .prepare(
      `UPDATE authors
       SET name = ?,
           slug = ?,
           bio = ?,
           avatar_media_id = ?,
           social_url = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextName, nextSlug, nextBio, nextAvatarMediaId, nextSocialUrl, nowMs, authorId)
    .run();

  return getPublicAuthorById(tenantDb, authorId, options);
}
