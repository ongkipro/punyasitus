import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  extractPublishedSnapshot,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  serializeDraftStoragePayload,
  StaleRevisionError,
  type AdminDraftResourceDto,
  type BusinessProfileSnapshot,
  type MenuSnapshot,
  type OfferingSnapshot,
  type PageSnapshot,
  type PostSnapshot,
  type PublishableResourceType,
  type PublishedResourceDto,
  type PublishedSnapshotEnvelope,
  type RawPublishableRecord,
  type ResourceLifecycleStatus,
  type ResourceSnapshotMap,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import type { ThemeConfigSnapshot } from "@punyasitus/core/theme/index";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Atomic Draft/Publish & Tenant Revision Engine (REQ-036, REQ-001, PLAN §3 & §5.2, TASK-027).
 *
 * Coordinates per-tenant SQLite Durable Object (`TenantStore` via D1-compatible RPC adapter)
 * with `PLATFORM_DB` (`tenants.cache_version`) using strict optimistic concurrency control
 * (`WHERE <pk> = ? AND version = ?`) and fail-closed compensation if cross-tier cache-version
 * bump fails.
 */

const MAX_RETAINED_REVISIONS = 20;

export interface SaveDraftResourceParams<K extends PublishableResourceType> {
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly expectedVersion: number;
  readonly draft: unknown;
  readonly nowMs?: number;
}

export interface SaveDraftResourceResult<K extends PublishableResourceType> {
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly version: number;
  readonly updatedAt: number;
  readonly draft: ResourceSnapshotMap[K];
  readonly draftMetadata: Readonly<Record<string, unknown>>;
}

export interface PublishResourceAtomicallyParams<K extends PublishableResourceType> {
  readonly tenantId: string;
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly draftOverride?: unknown;
  readonly nowMs?: number;
}

export interface PublishResourceAtomicallyResult<K extends PublishableResourceType> {
  readonly tenantId: string;
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly version: number;
  readonly cacheVersion: number;
  readonly publishedAt: number;
  readonly contentModifiedAt: number;
  readonly revisionNumber: number | null;
  readonly publishedSnapshot: PublishedSnapshotEnvelope<K>;
}

export interface UnpublishResourceAtomicallyParams<K extends PublishableResourceType> {
  readonly tenantId: string;
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly expectedVersion: number;
  readonly nowMs?: number;
}

export interface UnpublishResourceAtomicallyResult<K extends PublishableResourceType> {
  readonly tenantId: string;
  readonly resourceType: K;
  readonly resourceId: K extends "theme_config" ? string : number;
  readonly version: number;
  readonly cacheVersion: number;
  readonly unpublishedAt: number;
}

export interface GetResourceParams<K extends PublishableResourceType> {
  readonly resourceType: K;
  readonly resourceId?: K extends "theme_config" ? string : number;
  readonly slug?: string;
  readonly offeringType?: OfferingSnapshot["offeringType"];
  readonly location?: MenuSnapshot["location"];
  readonly includeTrashed?: boolean;
}

// ---------------------------------------------------------------------------
// Internal Raw Row Shapes (Exact 0001_initial_tenant.sql columns)
// ---------------------------------------------------------------------------

interface PageRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly is_homepage: number;
  readonly draft_sections_json: string;
  readonly published_sections_json: string | null;
  readonly seo_json: string | null;
  readonly status: ResourceLifecycleStatus;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface PostRow {
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
  readonly deleted_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface OfferingRow {
  readonly id: number;
  readonly offering_type: OfferingSnapshot["offeringType"];
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly cover_media_id: number | null;
  readonly gallery_media_ids_json: string;
  readonly video_media_id: number | null;
  readonly youtube_video_id: string | null;
  readonly price_mode: OfferingSnapshot["priceMode"];
  readonly price: number | null;
  readonly price_max: number | null;
  readonly negotiable: number;
  readonly original_amount: number | null;
  readonly badge: string | null;
  readonly cta_mode: OfferingSnapshot["ctaMode"];
  readonly external_url: string | null;
  readonly unit_status: OfferingSnapshot["unitStatus"] | null;
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
  readonly updated_at: number;
}

interface SiteSettingsRow {
  readonly id: number;
  readonly site_title: string;
  readonly tagline: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly active_theme_id: string;
  readonly favicon_media_id: number | null;
  readonly og_image_media_id: number | null;
  readonly blog_enabled: number;
  readonly catalog_enabled: number;
  readonly ai_training_policy: "allow" | "disallow";
  readonly analytics_config_json: string | null;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface BusinessProfileRow {
  readonly id: number;
  readonly business_name: string;
  readonly business_category: string;
  readonly description: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postal_code: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly maps_url: string | null;
  readonly weekday_hours_json: string | null;
  readonly holiday_hours_json: string | null;
  readonly service_areas_json: string | null;
  readonly whatsapp_e164: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly social_links_json: string | null;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface ThemeConfigRow {
  readonly theme_id: string;
  readonly tokens_json: string;
  readonly variants_json: string;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

interface MenuRow {
  readonly id: number;
  readonly location: MenuSnapshot["location"];
  readonly items_json: string;
  readonly draft_items_json: string | null;
  readonly published_items_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

type AnyResourceRow =
  | PageRow
  | PostRow
  | OfferingRow
  | SiteSettingsRow
  | BusinessProfileRow
  | ThemeConfigRow
  | MenuRow;

interface TableConfig {
  readonly table: string;
  readonly pkColumn: string;
  readonly draftColumn: string;
  readonly publishedColumn: string;
  readonly hasStatus: boolean;
  readonly hasPublishedTimestamps: boolean;
  readonly hasDeletedAt: boolean;
  readonly tracksContentRevisions: boolean;
}

const TABLE_CONFIGS: Readonly<Record<PublishableResourceType, TableConfig>> = {
  page: {
    table: "pages",
    pkColumn: "id",
    draftColumn: "draft_sections_json",
    publishedColumn: "published_sections_json",
    hasStatus: true,
    hasPublishedTimestamps: true,
    hasDeletedAt: true,
    tracksContentRevisions: true,
  },
  post: {
    table: "posts",
    pkColumn: "id",
    draftColumn: "draft_body_json",
    publishedColumn: "published_body_json",
    hasStatus: true,
    hasPublishedTimestamps: true,
    hasDeletedAt: true,
    tracksContentRevisions: true,
  },
  offering: {
    table: "offerings",
    pkColumn: "id",
    draftColumn: "draft_snapshot_json",
    publishedColumn: "published_snapshot_json",
    hasStatus: true,
    hasPublishedTimestamps: true,
    hasDeletedAt: true,
    tracksContentRevisions: true,
  },
  site_settings: {
    table: "site_settings",
    pkColumn: "id",
    draftColumn: "draft_json",
    publishedColumn: "published_json",
    hasStatus: false,
    hasPublishedTimestamps: true,
    hasDeletedAt: false,
    tracksContentRevisions: false,
  },
  business_profile: {
    table: "business_profile",
    pkColumn: "id",
    draftColumn: "draft_json",
    publishedColumn: "published_json",
    hasStatus: false,
    hasPublishedTimestamps: true,
    hasDeletedAt: false,
    tracksContentRevisions: false,
  },
  theme_config: {
    table: "theme_configs",
    pkColumn: "theme_id",
    draftColumn: "draft_json",
    publishedColumn: "published_json",
    hasStatus: false,
    hasPublishedTimestamps: false,
    hasDeletedAt: false,
    tracksContentRevisions: false,
  },
  menu: {
    table: "menus",
    pkColumn: "id",
    draftColumn: "draft_items_json",
    publishedColumn: "published_items_json",
    hasStatus: false,
    hasPublishedTimestamps: false,
    hasDeletedAt: false,
    tracksContentRevisions: false,
  },
};

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function assertValidExpectedVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new PublicationValidationError("expectedVersion must be a nonnegative integer", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "expectedVersion must be a nonnegative integer",
      },
    ]);
  }
}

async function fetchRowByPk(
  tenantDb: D1Database,
  resourceType: PublishableResourceType,
  resourceId: number | string,
): Promise<AnyResourceRow | null> {
  const cfg = TABLE_CONFIGS[resourceType];
  return tenantDb
    .prepare(`SELECT * FROM ${cfg.table} WHERE ${cfg.pkColumn} = ? LIMIT 1`)
    .bind(resourceId)
    .first<AnyResourceRow>();
}

function getRowPk(resourceType: PublishableResourceType, row: AnyResourceRow): number | string {
  if (resourceType === "theme_config") {
    return (row as ThemeConfigRow).theme_id;
  }
  return (row as { readonly id: number }).id;
}

function getRowDeletedAt(resourceType: PublishableResourceType, row: AnyResourceRow): number | null {
  if (!TABLE_CONFIGS[resourceType].hasDeletedAt) return null;
  return (row as { readonly deleted_at: number | null }).deleted_at;
}

function rowToRawPublishableRecord(
  resourceType: PublishableResourceType,
  row: AnyResourceRow,
): RawPublishableRecord {
  const cfg = TABLE_CONFIGS[resourceType];
  const rec = row as unknown as Record<string, unknown>;
  const rawDraft = rec[cfg.draftColumn];
  const rawPublished = rec[cfg.publishedColumn];
  return {
    resourceId: getRowPk(resourceType, row),
    status: cfg.hasStatus ? (rec.status as ResourceLifecycleStatus) : undefined,
    deletedAt: cfg.hasDeletedAt ? ((rec.deleted_at as number | null) ?? null) : null,
    draftJson: typeof rawDraft === "string" ? rawDraft : null,
    publishedJson: typeof rawPublished === "string" ? rawPublished : null,
    publishedAt: cfg.hasPublishedTimestamps ? ((rec.published_at as number | null) ?? null) : null,
    contentModifiedAt: cfg.hasPublishedTimestamps
      ? ((rec.content_modified_at as number | null) ?? null)
      : null,
    version: rec.version as number,
    updatedAt: rec.updated_at as number,
  };
}

/**
 * Resolves the source draft payload to validate & snapshot when `publishResourceAtomically`
 * is invoked without an explicit `draftOverride`.
 * Supports both canonical envelope JSON saved via `saveDraftResource` AND raw initial
 * table rows seeded directly in SQLite.
 */
function resolveDraftSourceFromRow(
  resourceType: PublishableResourceType,
  row: AnyResourceRow,
): unknown {
  const cfg = TABLE_CONFIGS[resourceType];
  const rec = row as unknown as Record<string, unknown>;
  const rawDraftStr = typeof rec[cfg.draftColumn] === "string" ? (rec[cfg.draftColumn] as string) : null;
  const parsedDraft = safeJsonParse(rawDraftStr);

  if (
    parsedDraft &&
    typeof parsedDraft === "object" &&
    !Array.isArray(parsedDraft) &&
    (parsedDraft as Record<string, unknown>).snapshotVersion === 1 &&
    "data" in (parsedDraft as Record<string, unknown>)
  ) {
    return (parsedDraft as Record<string, unknown>).data;
  }

  switch (resourceType) {
    case "page": {
      const r = row as PageRow;
      return {
        slug: r.slug,
        title: r.title,
        isHomepage: r.is_homepage === 1,
        layoutMode: "standard",
        sections: Array.isArray(parsedDraft) ? parsedDraft : [],
        seo: safeJsonParse(r.seo_json),
      };
    }
    case "post": {
      const r = row as PostRow;
      return {
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        body: parsedDraft ?? { schemaVersion: 1, blocks: [] },
        primaryCategoryId: r.primary_category_id,
        authorId: r.author_id,
        coverMediaId: r.cover_media_id,
        readingTimeMinutes: r.reading_time_minutes,
        showToc: r.show_toc === 1,
        seo: safeJsonParse(r.seo_json),
      };
    }
    case "offering": {
      if (parsedDraft && typeof parsedDraft === "object" && !Array.isArray(parsedDraft)) {
        return parsedDraft;
      }
      const r = row as OfferingRow;
      const parsedDesc = safeJsonParse(r.description);
      return {
        offeringType: r.offering_type,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        description: parsedDesc ?? r.description,
        coverMediaId: r.cover_media_id,
        galleryMediaIds: safeJsonParse(r.gallery_media_ids_json) ?? [],
        videoMediaId: r.video_media_id,
        youtubeVideoId: r.youtube_video_id,
        priceMode: r.price_mode,
        price: r.price,
        priceMax: r.price_max,
        negotiable: r.negotiable === 1,
        originalAmount: r.original_amount,
        badge: r.badge,
        ctaMode: r.cta_mode,
        externalUrl: r.external_url,
        unitStatus: r.unit_status,
        attributesVersion: r.attributes_version,
        attributes: safeJsonParse(r.attributes_json) ?? {},
        seo: safeJsonParse(r.seo_json),
      };
    }
    case "site_settings": {
      if (parsedDraft && typeof parsedDraft === "object" && !Array.isArray(parsedDraft)) {
        return parsedDraft;
      }
      const r = row as SiteSettingsRow;
      return {
        siteTitle: r.site_title,
        tagline: r.tagline,
        timezone: r.timezone,
        locale: r.locale,
        activeThemeId: r.active_theme_id,
        faviconMediaId: r.favicon_media_id,
        ogImageMediaId: r.og_image_media_id,
        blogEnabled: r.blog_enabled === 1,
        catalogEnabled: r.catalog_enabled === 1,
        aiTrainingPolicy: r.ai_training_policy,
        analyticsConfig: safeJsonParse(r.analytics_config_json),
        siteVisibility: "public",
      };
    }
    case "business_profile": {
      if (parsedDraft && typeof parsedDraft === "object" && !Array.isArray(parsedDraft)) {
        return parsedDraft;
      }
      const r = row as BusinessProfileRow;
      return {
        businessName: r.business_name,
        businessCategory: r.business_category,
        description: r.description,
        address: r.address,
        city: r.city,
        province: r.province,
        postalCode: r.postal_code,
        latitude: r.latitude,
        longitude: r.longitude,
        mapsUrl: r.maps_url,
        weekdayHours: safeJsonParse(r.weekday_hours_json) ?? r.weekday_hours_json,
        holidayHours: safeJsonParse(r.holiday_hours_json) ?? r.holiday_hours_json,
        serviceAreas: safeJsonParse(r.service_areas_json) ?? [],
        whatsappE164: r.whatsapp_e164,
        phone: r.phone,
        email: r.email,
        socialLinks: safeJsonParse(r.social_links_json) ?? [],
      };
    }
    case "theme_config": {
      if (parsedDraft && typeof parsedDraft === "object" && !Array.isArray(parsedDraft)) {
        return parsedDraft;
      }
      const r = row as ThemeConfigRow;
      return {
        themeId: r.theme_id,
        tokens: safeJsonParse(r.tokens_json),
        variants: safeJsonParse(r.variants_json),
      };
    }
    case "menu": {
      if (parsedDraft && typeof parsedDraft === "object" && !Array.isArray(parsedDraft)) {
        return parsedDraft;
      }
      const r = row as MenuRow;
      return {
        location: r.location,
        items: Array.isArray(parsedDraft) ? parsedDraft : (safeJsonParse(r.items_json) ?? []),
      };
    }
  }
}

function buildPublishUpdateStatement<K extends PublishableResourceType>(
  tenantDb: D1Database,
  resourceType: K,
  resourceId: number | string,
  expectedVersion: number,
  envelope: PublishedSnapshotEnvelope<K>,
  publishedJson: string,
  nowMs: number,
): D1PreparedStatement {
  switch (resourceType) {
    case "page": {
      const data = envelope.data as PageSnapshot;
      return tenantDb
        .prepare(
          `UPDATE pages
           SET slug = ?,
               title = ?,
               is_homepage = ?,
               seo_json = ?,
               published_sections_json = ?,
               status = 'published',
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(
          data.slug,
          data.title,
          data.isHomepage ? 1 : 0,
          data.seo ? JSON.stringify(data.seo) : null,
          publishedJson,
          envelope.publishedAt,
          envelope.contentModifiedAt,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "post": {
      const data = envelope.data as PostSnapshot;
      return tenantDb
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
          data.slug,
          data.title,
          data.excerpt ?? null,
          data.primaryCategoryId ?? null,
          data.authorId ?? null,
          data.coverMediaId ?? null,
          data.readingTimeMinutes,
          data.showToc ? 1 : 0,
          data.seo ? JSON.stringify(data.seo) : null,
          publishedJson,
          envelope.publishedAt,
          envelope.contentModifiedAt,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "offering": {
      const data = envelope.data as OfferingSnapshot;
      const serializedDesc =
        data.description === undefined || data.description === null
          ? null
          : typeof data.description === "string"
            ? data.description
            : JSON.stringify(data.description);
      return tenantDb
        .prepare(
          `UPDATE offerings
           SET offering_type = ?,
               slug = ?,
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
               seo_json = ?,
               published_snapshot_json = ?,
               status = 'published',
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .bind(
          data.offeringType,
          data.slug,
          data.title,
          data.summary ?? null,
          serializedDesc,
          data.coverMediaId ?? null,
          JSON.stringify(data.galleryMediaIds),
          data.videoMediaId ?? null,
          data.youtubeVideoId ?? null,
          data.priceMode,
          data.price ?? null,
          data.priceMax ?? null,
          data.negotiable ? 1 : 0,
          data.originalAmount ?? null,
          data.badge ?? null,
          data.ctaMode,
          data.externalUrl ?? null,
          data.unitStatus ?? null,
          data.attributesVersion,
          JSON.stringify(data.attributes),
          data.seo ? JSON.stringify(data.seo) : null,
          publishedJson,
          envelope.publishedAt,
          envelope.contentModifiedAt,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "site_settings": {
      const data = envelope.data as SiteSettingsSnapshot;
      return tenantDb
        .prepare(
          `UPDATE site_settings
           SET site_title = ?,
               tagline = ?,
               timezone = ?,
               locale = ?,
               active_theme_id = ?,
               favicon_media_id = ?,
               og_image_media_id = ?,
               blog_enabled = ?,
               catalog_enabled = ?,
               ai_training_policy = ?,
               analytics_config_json = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          data.siteTitle,
          data.tagline ?? null,
          data.timezone,
          data.locale,
          data.activeThemeId,
          data.faviconMediaId ?? null,
          data.ogImageMediaId ?? null,
          data.blogEnabled ? 1 : 0,
          data.catalogEnabled ? 1 : 0,
          data.aiTrainingPolicy,
          data.analyticsConfig ? JSON.stringify(data.analyticsConfig) : null,
          publishedJson,
          envelope.publishedAt,
          envelope.contentModifiedAt,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "business_profile": {
      const data = envelope.data as BusinessProfileSnapshot;
      return tenantDb
        .prepare(
          `UPDATE business_profile
           SET business_name = ?,
               business_category = ?,
               description = ?,
               address = ?,
               city = ?,
               province = ?,
               postal_code = ?,
               latitude = ?,
               longitude = ?,
               maps_url = ?,
               weekday_hours_json = ?,
               holiday_hours_json = ?,
               service_areas_json = ?,
               whatsapp_e164 = ?,
               phone = ?,
               email = ?,
               social_links_json = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          data.businessName,
          data.businessCategory,
          data.description ?? null,
          data.address ?? null,
          data.city ?? null,
          data.province ?? null,
          data.postalCode ?? null,
          data.latitude ?? null,
          data.longitude ?? null,
          data.mapsUrl ?? null,
          data.weekdayHours ? JSON.stringify(data.weekdayHours) : null,
          data.holidayHours ? JSON.stringify(data.holidayHours) : null,
          JSON.stringify(data.serviceAreas),
          data.whatsappE164 ?? null,
          data.phone ?? null,
          data.email ?? null,
          JSON.stringify(data.socialLinks),
          publishedJson,
          envelope.publishedAt,
          envelope.contentModifiedAt,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "theme_config": {
      const data = envelope.data as ThemeConfigSnapshot;
      return tenantDb
        .prepare(
          `UPDATE theme_configs
           SET tokens_json = ?,
               variants_json = ?,
               published_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE theme_id = ? AND version = ?`,
        )
        .bind(
          JSON.stringify(data.tokens),
          JSON.stringify(data.variants),
          publishedJson,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
    case "menu": {
      const data = envelope.data as MenuSnapshot;
      return tenantDb
        .prepare(
          `UPDATE menus
           SET items_json = ?,
               published_items_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          JSON.stringify(data.items),
          publishedJson,
          nowMs,
          resourceId,
          expectedVersion,
        );
    }
  }
}

function buildRestoreStatement(
  tenantDb: D1Database,
  resourceType: PublishableResourceType,
  priorRow: AnyResourceRow,
  expectedCurrentVersion: number,
): D1PreparedStatement {
  switch (resourceType) {
    case "page": {
      const r = priorRow as PageRow;
      return tenantDb
        .prepare(
          `UPDATE pages
           SET slug = ?, title = ?, is_homepage = ?, seo_json = ?,
               published_sections_json = ?, status = ?,
               published_at = ?, content_modified_at = ?,
               version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          r.slug,
          r.title,
          r.is_homepage,
          r.seo_json,
          r.published_sections_json,
          r.status,
          r.published_at,
          r.content_modified_at,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
    case "post": {
      const r = priorRow as PostRow;
      return tenantDb
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
          r.slug,
          r.title,
          r.excerpt,
          r.primary_category_id,
          r.author_id,
          r.cover_media_id,
          r.reading_time_minutes,
          r.show_toc,
          r.seo_json,
          r.published_body_json,
          r.status,
          r.published_at,
          r.content_modified_at,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
    case "offering": {
      const r = priorRow as OfferingRow;
      return tenantDb
        .prepare(
          `UPDATE offerings
           SET offering_type = ?, slug = ?, title = ?, summary = ?, description = ?,
               cover_media_id = ?, gallery_media_ids_json = ?, video_media_id = ?,
               youtube_video_id = ?, price_mode = ?, price = ?, price_max = ?,
               negotiable = ?, original_amount = ?, badge = ?, cta_mode = ?,
               external_url = ?, unit_status = ?, attributes_version = ?,
               attributes_json = ?, seo_json = ?, published_snapshot_json = ?,
               status = ?, published_at = ?, content_modified_at = ?,
               version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          r.offering_type,
          r.slug,
          r.title,
          r.summary,
          r.description,
          r.cover_media_id,
          r.gallery_media_ids_json,
          r.video_media_id,
          r.youtube_video_id,
          r.price_mode,
          r.price,
          r.price_max,
          r.negotiable,
          r.original_amount,
          r.badge,
          r.cta_mode,
          r.external_url,
          r.unit_status,
          r.attributes_version,
          r.attributes_json,
          r.seo_json,
          r.published_snapshot_json,
          r.status,
          r.published_at,
          r.content_modified_at,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
    case "site_settings": {
      const r = priorRow as SiteSettingsRow;
      return tenantDb
        .prepare(
          `UPDATE site_settings
           SET site_title = ?, tagline = ?, timezone = ?, locale = ?,
               active_theme_id = ?, favicon_media_id = ?, og_image_media_id = ?,
               blog_enabled = ?, catalog_enabled = ?, ai_training_policy = ?,
               analytics_config_json = ?, published_json = ?,
               published_at = ?, content_modified_at = ?,
               version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          r.site_title,
          r.tagline,
          r.timezone,
          r.locale,
          r.active_theme_id,
          r.favicon_media_id,
          r.og_image_media_id,
          r.blog_enabled,
          r.catalog_enabled,
          r.ai_training_policy,
          r.analytics_config_json,
          r.published_json,
          r.published_at,
          r.content_modified_at,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
    case "business_profile": {
      const r = priorRow as BusinessProfileRow;
      return tenantDb
        .prepare(
          `UPDATE business_profile
           SET business_name = ?, business_category = ?, description = ?,
               address = ?, city = ?, province = ?, postal_code = ?,
               latitude = ?, longitude = ?, maps_url = ?,
               weekday_hours_json = ?, holiday_hours_json = ?,
               service_areas_json = ?, whatsapp_e164 = ?, phone = ?,
               email = ?, social_links_json = ?, published_json = ?,
               published_at = ?, content_modified_at = ?,
               version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          r.business_name,
          r.business_category,
          r.description,
          r.address,
          r.city,
          r.province,
          r.postal_code,
          r.latitude,
          r.longitude,
          r.maps_url,
          r.weekday_hours_json,
          r.holiday_hours_json,
          r.service_areas_json,
          r.whatsapp_e164,
          r.phone,
          r.email,
          r.social_links_json,
          r.published_json,
          r.published_at,
          r.content_modified_at,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
    case "theme_config": {
      const r = priorRow as ThemeConfigRow;
      return tenantDb
        .prepare(
          `UPDATE theme_configs
           SET tokens_json = ?, variants_json = ?, published_json = ?,
               version = ?, updated_at = ?
           WHERE theme_id = ? AND version = ?`,
        )
        .bind(
          r.tokens_json,
          r.variants_json,
          r.published_json,
          r.version,
          r.updated_at,
          r.theme_id,
          expectedCurrentVersion,
        );
    }
    case "menu": {
      const r = priorRow as MenuRow;
      return tenantDb
        .prepare(
          `UPDATE menus
           SET items_json = ?, published_items_json = ?,
               version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          r.items_json,
          r.published_items_json,
          r.version,
          r.updated_at,
          r.id,
          expectedCurrentVersion,
        );
    }
  }
}

/**
 * Atomically increments `PLATFORM_DB.tenants.cache_version` (and `version`, `updated_at`),
 * evicts the tenant from the in-isolate host resolution cache, and returns the new `cache_version`.
 */
export async function bumpTenantCacheVersion(
  platformDb: D1Database,
  tenantId: string,
  nowMs = Date.now(),
): Promise<number> {
  const cleanTenantId = tenantId.trim();
  if (!cleanTenantId) {
    throw new PublicationValidationError("tenantId is required to bump cache_version", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId must be non-empty" },
    ]);
  }

  const [updateRes, selectRes] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(nowMs, cleanTenantId),
    platformDb
      .prepare("SELECT cache_version FROM tenants WHERE id = ? LIMIT 1")
      .bind(cleanTenantId),
  ]);

  const changes = updateRes?.meta?.changes ?? 0;
  const row = (selectRes?.results?.[0] as { readonly cache_version?: number } | undefined) ?? null;

  if (changes !== 1 || !row || typeof row.cache_version !== "number") {
    throw new Error(`Tenant "${cleanTenantId}" not found while bumping cache_version`);
  }

  evictTenantFromCache(cleanTenantId);
  return row.cache_version;
}

/**
 * Saves validated draft edits with strict optimistic locking (`WHERE <pk> = ? AND version = ?`).
 *
 * Isolation guarantee: NEVER mutates `published_*` columns, `status`, `published_at`,
 * `content_modified_at`, `tokens_json`, `variants_json`, or `items_json`. Draft edits
 * NEVER leak to public readers or affect sitemap `lastmod`.
 */
export async function saveDraftResource<K extends PublishableResourceType>(
  tenantDb: D1Database,
  params: SaveDraftResourceParams<K>,
): Promise<SaveDraftResourceResult<K>> {
  assertValidExpectedVersion(params.expectedVersion);
  const nowMs = params.nowMs ?? Date.now();
  const cfg = TABLE_CONFIGS[params.resourceType];

  // Validate BEFORE touching SQLite (throws 422 PublicationValidationError on invalid data)
  const serialized = serializeDraftStoragePayload(params.resourceType, params.draft);

  const deletedPredicate = cfg.hasDeletedAt ? " AND deleted_at IS NULL" : "";
  const updateRes = await tenantDb
    .prepare(
      `UPDATE ${cfg.table}
       SET ${cfg.draftColumn} = ?,
           version = version + 1,
           updated_at = ?
       WHERE ${cfg.pkColumn} = ? AND version = ?${deletedPredicate}`,
    )
    .bind(serialized.json, nowMs, params.resourceId, params.expectedVersion)
    .run();

  if ((updateRes.meta?.changes ?? 0) === 0) {
    const existing = await fetchRowByPk(tenantDb, params.resourceType, params.resourceId);
    if (!existing || getRowDeletedAt(params.resourceType, existing) !== null) {
      throw new PublicationNotFoundError(params.resourceType, params.resourceId);
    }
    throw new StaleRevisionError({
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      expectedVersion: params.expectedVersion,
      actualVersion: existing.version,
    });
  }

  return {
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    version: params.expectedVersion + 1,
    updatedAt: nowMs,
    draft: serialized.data,
    draftMetadata: serialized.draftMetadata,
  };
}

/**
 * Atomically publishes a tenant resource and increments `PLATFORM_DB.tenants.cache_version`.
 *
 * 1. Verifies optimistic `expectedVersion` (409 `StaleRevisionError` on mismatch, zero mutations).
 * 2. Validates the complete snapshot for publication (422 `PublicationValidationError` on failure).
 * 3. Swaps the frozen published snapshot into `TenantStore` (`published_*`, `status = 'published'`,
 *    `published_at`, `content_modified_at`, `version = version + 1`) + records revision history
 *    (latest 20 retained for `page`/`post`/`offering`).
 * 4. Atomically bumps `PLATFORM_DB.tenants.cache_version = cache_version + 1` and evicts isolate cache.
 * 5. Fail-closed compensation: if `PLATFORM_DB` bump fails, restores `TenantStore` to its exact
 *    prior row state and removes the inserted revision row before throwing `PublicationAtomicError` (503).
 */
export async function publishResourceAtomically<K extends PublishableResourceType>(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: PublishResourceAtomicallyParams<K>,
): Promise<PublishResourceAtomicallyResult<K>> {
  assertValidExpectedVersion(params.expectedVersion);
  const cleanTenantId = params.tenantId.trim();
  if (!cleanTenantId) {
    throw new PublicationValidationError("tenantId is required to publish", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId must be non-empty" },
    ]);
  }

  const nowMs = params.nowMs ?? Date.now();
  const cfg = TABLE_CONFIGS[params.resourceType];

  // 1. Pre-read prior row for optimistic check + exact compensation snapshot
  const priorRow = await fetchRowByPk(tenantDb, params.resourceType, params.resourceId);
  if (!priorRow || getRowDeletedAt(params.resourceType, priorRow) !== null) {
    throw new PublicationNotFoundError(params.resourceType, params.resourceId);
  }
  if (priorRow.version !== params.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      expectedVersion: params.expectedVersion,
      actualVersion: priorRow.version,
    });
  }

  // 2. Resolve & strictly validate snapshot BEFORE any write
  const draftSource =
    params.draftOverride !== undefined
      ? params.draftOverride
      : resolveDraftSourceFromRow(params.resourceType, priorRow);

  const priorPublishedAt = cfg.hasPublishedTimestamps
    ? ((priorRow as { readonly published_at?: number | null }).published_at ?? null)
    : null;
  const publishedAt = priorPublishedAt ?? nowMs;
  const contentModifiedAt = nowMs;

  const envelope = buildPublishedSnapshot(params.resourceType, draftSource, {
    publishedAt,
    contentModifiedAt,
  });
  const publishedJson = JSON.stringify(envelope);

  // 3. Apply optimistic-locked publish swap in TenantStore
  const updateStmt = buildPublishUpdateStatement(
    tenantDb,
    params.resourceType,
    params.resourceId,
    params.expectedVersion,
    envelope,
    publishedJson,
    nowMs,
  );
  const updateRes = await updateStmt.run();
  if ((updateRes.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRowByPk(tenantDb, params.resourceType, params.resourceId);
    throw new StaleRevisionError({
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      expectedVersion: params.expectedVersion,
      actualVersion: latest?.version ?? null,
    });
  }

  // 4. Record content revision AND bump PLATFORM_DB.tenants.cache_version inside the
  //    compensated region so ANY post-swap failure rolls back TenantStore cleanly (no split-brain).
  const swappedVersion = params.expectedVersion + 1;
  let revisionNumber: number | null = null;
  let revisionInserted = false;
  try {
    if (cfg.tracksContentRevisions && typeof params.resourceId === "number") {
      const revRow = await tenantDb
        .prepare(
          `SELECT COALESCE(MAX(revision_number), 0) AS max_rev
           FROM content_revisions
           WHERE resource_type = ? AND resource_id = ?`,
        )
        .bind(params.resourceType, params.resourceId)
        .first<{ readonly max_rev: number }>();
      revisionNumber = (revRow?.max_rev ?? 0) + 1;

      await tenantDb.batch([
        tenantDb
          .prepare(
            `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            params.resourceType,
            params.resourceId,
            revisionNumber,
            publishedJson,
            params.actorUserId ?? null,
            nowMs,
          ),
        tenantDb
          .prepare(
            `DELETE FROM content_revisions
             WHERE resource_type = ? AND resource_id = ?
               AND revision_number NOT IN (
                 SELECT revision_number
                 FROM content_revisions
                 WHERE resource_type = ? AND resource_id = ?
                 ORDER BY revision_number DESC
                 LIMIT ?
               )`,
          )
          .bind(
            params.resourceType,
            params.resourceId,
            params.resourceType,
            params.resourceId,
            MAX_RETAINED_REVISIONS,
          ),
      ]);
      revisionInserted = true;
    }

    const cacheVersion = await bumpTenantCacheVersion(platformDb, cleanTenantId, nowMs);
    return {
      tenantId: cleanTenantId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      version: swappedVersion,
      cacheVersion,
      publishedAt,
      contentModifiedAt,
      revisionNumber,
      publishedSnapshot: envelope,
    };
  } catch (postSwapError) {
    let compensated = false;
    try {
      const rollbackStmts: D1PreparedStatement[] = [
        buildRestoreStatement(tenantDb, params.resourceType, priorRow, swappedVersion),
      ];
      if (revisionInserted && revisionNumber !== null && typeof params.resourceId === "number") {
        rollbackStmts.push(
          tenantDb
            .prepare(
              `DELETE FROM content_revisions
               WHERE resource_type = ? AND resource_id = ? AND revision_number = ?`,
            )
            .bind(params.resourceType, params.resourceId, revisionNumber),
        );
      }
      const restoreResults = await tenantDb.batch(rollbackStmts);
      compensated = (restoreResults[0]?.meta?.changes ?? 0) === 1;
    } catch {
      // Compensation failed; compensated remains false — caller must retry cache_version bump
    }

    throw new PublicationAtomicError(
      `Failed to complete atomic publication (revision/cache_version)${
        compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
      }`,
      { compensated, cause: postSwapError },
    );
  }
}

/**
 * Atomically unpublishes a resource (transitions lifecycle resources back to `draft`,
 * clears published snapshot so public loaders return `null`, preserves draft work)
 * AND bumps `PLATFORM_DB.tenants.cache_version` with fail-closed compensation.
 */
export async function unpublishResourceAtomically<K extends PublishableResourceType>(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: UnpublishResourceAtomicallyParams<K>,
): Promise<UnpublishResourceAtomicallyResult<K>> {
  assertValidExpectedVersion(params.expectedVersion);
  const cleanTenantId = params.tenantId.trim();
  if (!cleanTenantId) {
    throw new PublicationValidationError("tenantId is required to unpublish", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId must be non-empty" },
    ]);
  }

  const nowMs = params.nowMs ?? Date.now();
  const cfg = TABLE_CONFIGS[params.resourceType];

  const priorRow = await fetchRowByPk(tenantDb, params.resourceType, params.resourceId);
  if (!priorRow || getRowDeletedAt(params.resourceType, priorRow) !== null) {
    throw new PublicationNotFoundError(params.resourceType, params.resourceId);
  }
  if (priorRow.version !== params.expectedVersion) {
    throw new StaleRevisionError({
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      expectedVersion: params.expectedVersion,
      actualVersion: priorRow.version,
    });
  }

  const statusSet = cfg.hasStatus ? "status = 'draft', " : "";
  const deletedPredicate = cfg.hasDeletedAt ? " AND deleted_at IS NULL" : "";
  const updateRes = await tenantDb
    .prepare(
      `UPDATE ${cfg.table}
       SET ${statusSet}${cfg.publishedColumn} = NULL,
           version = version + 1,
           updated_at = ?
       WHERE ${cfg.pkColumn} = ? AND version = ?${deletedPredicate}`,
    )
    .bind(nowMs, params.resourceId, params.expectedVersion)
    .run();

  if ((updateRes.meta?.changes ?? 0) !== 1) {
    const latest = await fetchRowByPk(tenantDb, params.resourceType, params.resourceId);
    throw new StaleRevisionError({
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      expectedVersion: params.expectedVersion,
      actualVersion: latest?.version ?? null,
    });
  }

  const swappedVersion = params.expectedVersion + 1;
  try {
    const cacheVersion = await bumpTenantCacheVersion(platformDb, cleanTenantId, nowMs);
    return {
      tenantId: cleanTenantId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      version: swappedVersion,
      cacheVersion,
      unpublishedAt: nowMs,
    };
  } catch (platformError) {
    let compensated = false;
    try {
      const restoreResults = await tenantDb.batch([
        buildRestoreStatement(tenantDb, params.resourceType, priorRow, swappedVersion),
      ]);
      compensated = (restoreResults[0]?.meta?.changes ?? 0) === 1;
    } catch {
      // Compensation failed; compensated remains false — caller must retry cache_version bump
    }
    throw new PublicationAtomicError(
      `Failed to bump tenant cache_version in PLATFORM_DB during unpublish${
        compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation failed"
      }`,
      { compensated, cause: platformError },
    );
  }
}

async function queryResourceRow<K extends PublishableResourceType>(
  tenantDb: D1Database,
  params: GetResourceParams<K>,
  publishedOnly: boolean,
): Promise<AnyResourceRow | null> {
  const cfg = TABLE_CONFIGS[params.resourceType];
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (params.resourceId !== undefined) {
    conditions.push(`${cfg.pkColumn} = ?`);
    binds.push(params.resourceId);
  } else if (params.resourceType === "site_settings" || params.resourceType === "business_profile") {
    conditions.push("id = 1");
  } else if (params.resourceType === "menu" && params.location) {
    conditions.push("location = ?");
    binds.push(params.location);
  } else if (params.slug && (params.resourceType === "page" || params.resourceType === "post")) {
    conditions.push("slug = ?");
    binds.push(params.slug);
  } else if (params.resourceType === "offering" && params.slug) {
    conditions.push("slug = ?");
    binds.push(params.slug);
    if (params.offeringType) {
      conditions.push("offering_type = ?");
      binds.push(params.offeringType);
    }
  } else {
    throw new PublicationValidationError(
      `Missing lookup selector (resourceId/slug/location) for ${params.resourceType}`,
    );
  }

  if (publishedOnly) {
    if (cfg.hasStatus) {
      conditions.push("status = 'published'");
    }
    if (cfg.hasDeletedAt) {
      conditions.push("deleted_at IS NULL");
    }
    conditions.push(`${cfg.publishedColumn} IS NOT NULL`);
  } else if (cfg.hasDeletedAt && !params.includeTrashed) {
    conditions.push("deleted_at IS NULL");
  }

  const sql = `SELECT * FROM ${cfg.table} WHERE ${conditions.join(" AND ")} LIMIT 1`;
  return tenantDb.prepare(sql).bind(...binds).first<AnyResourceRow>();
}

/**
 * Public-safe loader returning ONLY the validated published snapshot of a resource.
 * Strictly returns `null` for draft, unpublished, trashed, or missing resources and
 * NEVER exposes draft edits or draft-only fields.
 */
export async function getPublishedResource<K extends PublishableResourceType>(
  tenantDb: D1Database,
  params: GetResourceParams<K>,
): Promise<PublishedResourceDto<K> | null> {
  const row = await queryResourceRow(tenantDb, params, true);
  if (!row) return null;
  const rawRecord = rowToRawPublishableRecord(params.resourceType, row);
  return extractPublishedSnapshot(params.resourceType, rawRecord);
}

/**
 * Admin / authorized-preview loader returning separated draft and published states.
 * MUST ONLY be called behind verified tenant-member authorization (never public routes).
 */
export async function getDraftResourceForAdmin<K extends PublishableResourceType>(
  tenantDb: D1Database,
  params: GetResourceParams<K>,
): Promise<AdminDraftResourceDto<K> | null> {
  const row = await queryResourceRow(tenantDb, params, false);
  if (!row) return null;
  const rawRecord = rowToRawPublishableRecord(params.resourceType, row);
  return extractDraftSnapshotForAdmin(params.resourceType, rawRecord);
}
