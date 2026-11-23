import type {
  ContentMediaReferenceReport,
  ContentResourceType,
  MediaReferenceWarning,
  ProtectedContentReference,
} from "./types.ts";

/**
 * Protected-reference & media-reference inspection helpers for Content Trash & Purge
 * (`packages/db/src/trash/references.ts`; TASK-044, REQ-048, PLAN §11.5).
 *
 * Pure read-only SQL queries — ZERO DDL, ZERO writes, strict tenant DB scope.
 */

const MEDIA_ID_SINGLE_KEYS = new Set([
  "mediaId",
  "media_id",
  "imageMediaId",
  "image_media_id",
  "coverMediaId",
  "cover_media_id",
  "featuredMediaId",
  "featured_media_id",
  "videoMediaId",
  "video_media_id",
  "posterMediaId",
  "poster_media_id",
  "ogImageMediaId",
  "og_image_media_id",
  "logoMediaId",
  "logo_media_id",
  "avatarMediaId",
  "avatar_media_id",
  "faviconMediaId",
  "favicon_media_id",
]);

const MEDIA_ID_ARRAY_KEYS = new Set([
  "galleryMediaIds",
  "gallery_media_ids",
  "mediaIds",
  "media_ids",
  "imageMediaIds",
  "image_media_ids",
]);

const POLICY_SETTING_PAGE_ID_KEYS = new Set([
  "privacyPageId",
  "privacy_page_id",
  "termsPageId",
  "terms_page_id",
  "policyPageId",
  "policy_page_id",
  "legalPageId",
  "legal_page_id",
  "cookiePolicyPageId",
  "cookie_policy_page_id",
]);

const HOMEPAGE_SETTING_PAGE_ID_KEYS = new Set([
  "homepagePageId",
  "homepage_page_id",
  "frontPageId",
  "front_page_id",
]);

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Recursively extracts positive integer media IDs referenced inside arbitrary
 * section, rich-text, SEO, or offering snapshot JSON trees.
 */
export function extractMediaIdsFromJsonValue(value: unknown, out: Set<number>): void {
  if (value === null || value === undefined || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractMediaIdsFromJsonValue(item, out);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (MEDIA_ID_SINGLE_KEYS.has(key) && isPositiveInt(nested)) {
      out.add(nested);
    } else if (MEDIA_ID_ARRAY_KEYS.has(key) && Array.isArray(nested)) {
      for (const entry of nested) {
        if (isPositiveInt(entry)) {
          out.add(entry);
        }
      }
    } else if (key === "media" && Array.isArray(nested)) {
      for (const entry of nested) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const maybeId = (entry as Record<string, unknown>).id;
          if (isPositiveInt(maybeId)) {
            out.add(maybeId);
          }
        }
        extractMediaIdsFromJsonValue(entry, out);
      }
    } else if (nested !== null && typeof nested === "object") {
      extractMediaIdsFromJsonValue(nested, out);
    }
  }
}

export function extractMediaIdsFromJsonString(raw: string | null | undefined, out: Set<number>): void {
  const parsed = safeParseJson(raw);
  if (parsed !== null) {
    extractMediaIdsFromJsonValue(parsed, out);
  }
}

export interface InspectableContentMediaRow {
  readonly cover_media_id?: number | null;
  readonly video_media_id?: number | null;
  readonly gallery_media_ids_json?: string | null;
  readonly draft_sections_json?: string | null;
  readonly draft_body_json?: string | null;
  readonly draft_snapshot_json?: string | null;
  readonly attributes_json?: string | null;
  readonly seo_json?: string | null;
}

export function collectReferencedMediaIdsFromRow(
  resourceType: ContentResourceType,
  row: InspectableContentMediaRow,
): readonly number[] {
  const ids = new Set<number>();

  if (isPositiveInt(row.cover_media_id)) {
    ids.add(row.cover_media_id);
  }
  if (isPositiveInt(row.video_media_id)) {
    ids.add(row.video_media_id);
  }
  if (row.gallery_media_ids_json) {
    const parsedGallery = safeParseJson(row.gallery_media_ids_json);
    if (Array.isArray(parsedGallery)) {
      for (const entry of parsedGallery) {
        if (isPositiveInt(entry)) {
          ids.add(entry);
        }
      }
    }
  }

  if (resourceType === "page") {
    extractMediaIdsFromJsonString(row.draft_sections_json, ids);
  } else if (resourceType === "post") {
    extractMediaIdsFromJsonString(row.draft_body_json, ids);
  } else {
    extractMediaIdsFromJsonString(row.draft_snapshot_json, ids);
    extractMediaIdsFromJsonString(row.attributes_json, ids);
  }
  extractMediaIdsFromJsonString(row.seo_json, ids);

  return [...ids].sort((a, b) => a - b);
}

/**
 * Inspects all media IDs referenced by a trashed content item against the tenant's
 * `media_items` table WITHOUT mutating or corrupting the item's draft JSON.
 */
export async function inspectContentMediaReferences(
  tenantDb: D1Database,
  resourceType: ContentResourceType,
  row: InspectableContentMediaRow,
): Promise<ContentMediaReferenceReport> {
  const referencedMediaIds = collectReferencedMediaIdsFromRow(resourceType, row);
  if (referencedMediaIds.length === 0) {
    return {
      referencedMediaIds: [],
      validMediaIds: [],
      missingMediaIds: [],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [],
    };
  }

  const placeholders = referencedMediaIds.map(() => "?").join(", ");
  // `SELECT *` works whether migration 0002 (`deleted_at`) was applied or only 0001_initial_tenant
  const mediaRes = await tenantDb
    .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
    .bind(...referencedMediaIds)
    .all<{
      readonly id: number;
      readonly status: string;
      readonly deleted_at?: number | null;
    }>();

  const byId = new Map<number, { readonly status: string; readonly deletedAt: number | null }>();
  for (const m of mediaRes.results) {
    byId.set(Number(m.id), {
      status: String(m.status),
      deletedAt: m.deleted_at !== undefined && m.deleted_at !== null ? Number(m.deleted_at) : null,
    });
  }

  const validMediaIds: number[] = [];
  const missingMediaIds: number[] = [];
  const trashedMediaIds: number[] = [];
  const unavailableMediaIds: number[] = [];
  const warnings: MediaReferenceWarning[] = [];

  for (const mediaId of referencedMediaIds) {
    const found = byId.get(mediaId);
    if (!found) {
      missingMediaIds.push(mediaId);
      warnings.push({
        mediaId,
        status: "missing",
        message: `Media #${mediaId} sudah dihapus permanen dari pustaka media.`,
      });
    } else if (found.deletedAt !== null) {
      trashedMediaIds.push(mediaId);
      warnings.push({
        mediaId,
        status: "trashed",
        message: `Media #${mediaId} saat ini berada di Sampah media dan perlu dipulihkan atau diganti sebelum publikasi.`,
      });
    } else if (found.status !== "ready" && found.status !== "processing") {
      unavailableMediaIds.push(mediaId);
      warnings.push({
        mediaId,
        status: "unavailable",
        message: `Media #${mediaId} tidak tersedia untuk publikasi (status: ${found.status}).`,
      });
    } else {
      validMediaIds.push(mediaId);
    }
  }

  return {
    referencedMediaIds,
    validMediaIds,
    missingMediaIds,
    trashedMediaIds,
    unavailableMediaIds,
    warnings,
  };
}

interface MenuItemLike {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly targetType?: unknown;
  readonly targetResourceId?: unknown;
  readonly children?: unknown;
}

function collectMenuMatches(
  nodes: unknown,
  resourceType: ContentResourceType,
  resourceId: number,
  location: string,
  sourceField: string,
  seenKeys: Set<string>,
  out: ProtectedContentReference[],
): void {
  if (!Array.isArray(nodes)) return;
  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as MenuItemLike;
    if (
      node.targetType === resourceType &&
      typeof node.targetResourceId === "number" &&
      node.targetResourceId === resourceId
    ) {
      const itemId = typeof node.id === "string" ? node.id : undefined;
      const label = typeof node.label === "string" ? node.label : undefined;
      const dedupKey = `menu:${location}:${itemId ?? label ?? resourceId}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        out.push({
          kind: "navigation_menu",
          sourceTable: "menus",
          location,
          itemId,
          label,
          field: sourceField,
          reason: `Tautan menu navigasi (${location}${label ? `: "${label}"` : ""}) masih mengarah ke konten ini.`,
        });
      }
    }
    if (Array.isArray(node.children)) {
      collectMenuMatches(
        node.children,
        resourceType,
        resourceId,
        location,
        sourceField,
        seenKeys,
        out,
      );
    }
  }
}

function scanSettingsJsonForProtectedPageRefs(
  value: unknown,
  pageId: number,
  pathPrefix: string,
  seenKeys: Set<string>,
  out: ProtectedContentReference[],
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanSettingsJsonForProtectedPageRefs(value[i], pageId, `${pathPrefix}[${i}]`, seenKeys, out);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (HOMEPAGE_SETTING_PAGE_ID_KEYS.has(key) && nested === pageId) {
      const dedupKey = `settings:homepage:${pageId}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        out.push({
          kind: "homepage",
          sourceTable: "site_settings",
          field: fieldPath,
          reason: `Halaman ini masih terdaftar sebagai beranda di pengaturan situs (${fieldPath}).`,
        });
      }
    } else if (POLICY_SETTING_PAGE_ID_KEYS.has(key) && nested === pageId) {
      const dedupKey = `settings:policy:${key}:${pageId}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        out.push({
          kind: "policy_setting",
          sourceTable: "site_settings",
          field: fieldPath,
          reason: `Halaman ini masih ditautkan sebagai halaman kebijakan/privasi aktif di pengaturan situs (${fieldPath}).`,
        });
      }
    } else if (nested !== null && typeof nested === "object") {
      scanSettingsJsonForProtectedPageRefs(nested, pageId, fieldPath, seenKeys, out);
    }
  }
}

/**
 * Finds protected references that must block permanent purge of a content item:
 * 1. Active homepage designation (`pages.is_homepage = 1` or `site_settings` homepagePageId)
 * 2. Active policy / legal page reference in `site_settings` (`published_json` or `draft_json`)
 * 3. Active navigation menu item references in `menus` (`published_items_json`, `draft_items_json`, `items_json`)
 */
export async function findProtectedContentReferences(
  tenantDb: D1Database,
  resourceType: ContentResourceType,
  resourceId: number,
  options?: { readonly isHomepageFlag?: boolean },
): Promise<readonly ProtectedContentReference[]> {
  const refs: ProtectedContentReference[] = [];
  const seenKeys = new Set<string>();

  const [pageRow, replacementHomeRow, settingsRow, menusRes] = await Promise.all([
    resourceType === "page" && options?.isHomepageFlag === undefined
      ? tenantDb
          .prepare(`SELECT is_homepage FROM pages WHERE id = ? LIMIT 1`)
          .bind(resourceId)
          .first<{ readonly is_homepage: number }>()
      : Promise.resolve(null),
    resourceType === "page"
      ? tenantDb
          .prepare(`SELECT id FROM pages WHERE id != ? AND is_homepage = 1 AND deleted_at IS NULL LIMIT 1`)
          .bind(resourceId)
          .first<{ readonly id: number }>()
      : Promise.resolve(null),
    resourceType === "page"
      ? tenantDb
          .prepare(`SELECT draft_json, published_json FROM site_settings WHERE id = 1 LIMIT 1`)
          .first<{ readonly draft_json: string | null; readonly published_json: string | null }>()
      : Promise.resolve(null),
    tenantDb
      .prepare(`SELECT location, items_json, draft_items_json, published_items_json FROM menus`)
      .all<{
        readonly location: string;
        readonly items_json: string;
        readonly draft_items_json: string | null;
        readonly published_items_json: string | null;
      }>(),
  ]);

  if (resourceType === "page") {
    const isHomepage =
      options?.isHomepageFlag !== undefined
        ? options.isHomepageFlag
        : pageRow !== null && Number(pageRow.is_homepage) === 1;

    // A trashed page's `is_homepage = 1` flag blocks purge ONLY while no replacement active
    // homepage exists; once another active page is set as homepage, the trashed ex-homepage can be purged.
    if (isHomepage && !replacementHomeRow) {
      seenKeys.add(`pages:homepage:${resourceId}`);
      refs.push({
        kind: "homepage",
        sourceTable: "pages",
        field: "is_homepage",
        reason: "Halaman ini masih menjadi satu-satunya Beranda situs. Tetapkan beranda aktif lain terlebih dahulu sebelum menghapus permanen.",
      });
    }

    if (settingsRow) {
      if (settingsRow.published_json) {
        scanSettingsJsonForProtectedPageRefs(
          safeParseJson(settingsRow.published_json),
          resourceId,
          "published",
          seenKeys,
          refs,
        );
      }
      if (settingsRow.draft_json) {
        scanSettingsJsonForProtectedPageRefs(
          safeParseJson(settingsRow.draft_json),
          resourceId,
          "draft",
          seenKeys,
          refs,
        );
      }
    }
  }

  for (const menu of menusRes.results) {
    if (menu.published_items_json) {
      collectMenuMatches(
        safeParseJson(menu.published_items_json),
        resourceType,
        resourceId,
        menu.location,
        "published_items_json",
        seenKeys,
        refs,
      );
    }
    if (menu.draft_items_json) {
      collectMenuMatches(
        safeParseJson(menu.draft_items_json),
        resourceType,
        resourceId,
        menu.location,
        "draft_items_json",
        seenKeys,
        refs,
      );
    }
    if (menu.items_json) {
      collectMenuMatches(
        safeParseJson(menu.items_json),
        resourceType,
        resourceId,
        menu.location,
        "items_json",
        seenKeys,
        refs,
      );
    }
  }

  return refs;
}
