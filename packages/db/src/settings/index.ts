import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  extractPublishedSnapshot,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  serializeDraftStoragePayload,
  StaleRevisionError,
  type BusinessProfileSnapshot,
  type PageSnapshot,
  type PublicationValidationField,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import {
  ALL_OFFERING_TYPES,
  attachGroupedSettingsExtension,
  createDefaultGroupedSettingsExtension,
  extractGroupedSettingsExtension,
  FIXED_PUBLIC_ROUTES,
  SettingsValidationError,
  validateGroupedSettingsPatch,
  type AnalyticsSettingsSummaryData,
  type BusinessSettingsGroupData,
  type GeneralSettingsGroupData,
  type GroupedSettingsExtension,
  type GroupedSettingsSnapshot,
  type PrivacySettingsGroupData,
  type ReadingSettingsGroupData,
  type SeoSettingsGroupData,
  type SettingsGroup,
} from "@punyasitus/core/settings/index";
import { bumpTenantCacheVersion } from "../publication/index.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Per-Tenant Grouped Settings & Public Defaults Repository (`packages/db/src/settings/index.ts`;
 * TASK-040, REQ-044, REQ-011, REQ-026, REQ-034, REQ-036, REQ-039; PLAN §5.2, §11.2, §12).
 *
 * R3 Security & Data Integrity Invariants:
 * - ZERO runtime DDL. Uses existing `site_settings`, `business_profile`, `pages`, `media_items`,
 *   `tenant_activity_log` from `0001_initial_tenant.sql` plus dedicated `site_settings_grouped`
 *   from additive migration `0005_site_settings_grouped.sql` (with read-only `sqlite_master`
 *   fallback to defaults in pre-0005 legacy harnesses).
 * - Durable storage isolation: grouped-only settings (`homepageMode`, `homepagePageId`,
 *   `enabledOfferingTypes`, `itemsPerPage`, SEO defaults/verification tokens, privacy settings)
 *   live in dedicated `site_settings_grouped` so TASK-008/TASK-095 writes to `site_settings`
 *   NEVER wipe grouped settings.
 * - Analytics ownership isolation: NEVER writes `site_settings.analytics_config_json` (100% owned
 *   by TASK-022 `/settings/analytics`) and always reads live `analytics_config_json` on publish.
 * - Draft saves mutate ONLY draft columns (`site_settings.draft_json`, `business_profile.draft_json`,
 *   `site_settings_grouped.draft_json`) + `version` + `updated_at` inside ONE atomic `tenantDb.batch()`,
 *   NEVER modifying live `published_json`, live columns, `pages.is_homepage`, or `cache_version`.
 * - Atomic publish promotes `site_settings`, `business_profile`, `site_settings_grouped`, and
 *   `pages.is_homepage` (both static page promotion AND clearing `is_homepage = 0` when switching
 *   back to `modular`, bumping `pages.version = version + 1`) in ONE `tenantDb.batch()` +
 *   `tenant_activity_log`, followed by `PLATFORM_DB.tenants.cache_version` bump with chained
 *   `changes() = 1` guarded compensation on cross-tier failure.
 */

const SINGLETON_ID = 1 as const;
const DEFAULT_SITE_TITLE = "Situs Bisnis";

interface RawSiteSettingsRow {
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

interface RawBusinessProfileRow {
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

interface RawGroupedSettingsRow {
  readonly id: number;
  readonly draft_json: string;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly published_at: number | null;
}

interface RawPageOptionRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published" | "trashed";
  readonly is_homepage: number;
  readonly published_sections_json: string | null;
  readonly draft_sections_json: string;
  readonly version: number;
  readonly updated_at: number;
}

interface BrandLogoAssets {
  readonly logoMediaId: number | null;
  readonly logoLightMediaId: number | null;
  readonly logoDarkMediaId: number | null;
}

export interface SettingsPageOption {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published";
  readonly isHomepage: boolean;
  readonly isPublished: boolean;
}

export interface GroupedSettingsAdminDto {
  readonly draft: GroupedSettingsSnapshot;
  readonly published: GroupedSettingsSnapshot | null;
  readonly version: number;
  readonly draftVersion: number;
  readonly publishedVersion: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
    readonly groupedSettings: number;
  };
  readonly hasUnpublishedChanges: boolean;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly updatedAt: string | null;
  readonly availablePages: readonly SettingsPageOption[];
}

export interface PublishedGroupedSettingsDto {
  readonly settings: GroupedSettingsSnapshot;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
    readonly groupedSettings: number;
  };
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
}

export interface SaveGroupedSettingsDraftInput {
  readonly group: SettingsGroup;
  readonly patch: Record<string, unknown>;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
  /** Test-only hook invoked after pre-read validation and immediately before `tenantDb.batch()`. */
  readonly beforeDraftBatch?: () => Promise<void> | void;
}

export interface PublishGroupedSettingsInput {
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
  /** Test-only hook invoked after TenantStore commit and before PLATFORM_DB cache bump. */
  readonly beforeCacheVersionBump?: () => Promise<void> | void;
}

export interface PublishGroupedSettingsResult {
  readonly tenantId: string;
  readonly version: number;
  readonly draftVersion: number;
  readonly publishedVersion: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
    readonly groupedSettings: number;
  };
  readonly cacheVersion: number;
  readonly publishedAt: string;
  readonly contentModifiedAt: string;
  readonly updatedAt: string;
  readonly published: GroupedSettingsSnapshot;
  readonly hasUnpublishedChanges: false;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function extractBrandAssetsFromJson(rawJson: string | null | undefined): BrandLogoAssets {
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { logoMediaId: null, logoLightMediaId: null, logoDarkMediaId: null };
  }
  const rawAssets = (parsed as Record<string, unknown>)._brandAssets;
  if (!rawAssets || typeof rawAssets !== "object" || Array.isArray(rawAssets)) {
    return { logoMediaId: null, logoLightMediaId: null, logoDarkMediaId: null };
  }
  const assets = rawAssets as Record<string, unknown>;
  const logoMediaId =
    typeof assets.logoMediaId === "number" && Number.isSafeInteger(assets.logoMediaId)
      ? assets.logoMediaId
      : null;
  const logoLightMediaId =
    typeof assets.logoLightMediaId === "number" && Number.isSafeInteger(assets.logoLightMediaId)
      ? assets.logoLightMediaId
      : logoMediaId;
  const logoDarkMediaId =
    typeof assets.logoDarkMediaId === "number" && Number.isSafeInteger(assets.logoDarkMediaId)
      ? assets.logoDarkMediaId
      : null;
  return {
    logoMediaId: logoMediaId ?? logoLightMediaId,
    logoLightMediaId,
    logoDarkMediaId,
  };
}

function parseAnalyticsConfigFromColumn(
  raw: string | null | undefined,
): SiteSettingsSnapshot["analyticsConfig"] {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  if (typeof rec.ga4MeasurementId === "string" || rec.ga4MeasurementId === null) {
    out.ga4MeasurementId = rec.ga4MeasurementId;
  }
  if (typeof rec.gtmContainerId === "string" || rec.gtmContainerId === null) {
    out.gtmContainerId = rec.gtmContainerId;
  }
  if (typeof rec.metaPixelId === "string" || rec.metaPixelId === null) {
    out.metaPixelId = rec.metaPixelId;
  }
  if (typeof rec.tiktokPixelId === "string" || rec.tiktokPixelId === null) {
    out.tiktokPixelId = rec.tiktokPixelId;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function defaultSiteSettingsSnapshot(siteTitle = DEFAULT_SITE_TITLE): SiteSettingsSnapshot {
  return {
    siteTitle,
    tagline: null,
    timezone: "Asia/Jakarta",
    locale: "id-ID",
    activeThemeId: "compro",
    faviconMediaId: null,
    ogImageMediaId: null,
    blogEnabled: true,
    catalogEnabled: true,
    aiTrainingPolicy: "allow",
    analyticsConfig: null,
    siteVisibility: "public",
  };
}

function defaultBusinessProfileSnapshot(businessName = DEFAULT_SITE_TITLE): BusinessProfileSnapshot {
  return {
    businessName,
    businessCategory: "LocalBusiness",
    description: null,
    address: null,
    city: null,
    province: null,
    postalCode: null,
    latitude: null,
    longitude: null,
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    serviceAreas: [],
    whatsappE164: null,
    phone: null,
    email: null,
    socialLinks: [],
  };
}

function siteSettingsFromRawRow(row: RawSiteSettingsRow): SiteSettingsSnapshot {
  return {
    siteTitle: row.site_title || DEFAULT_SITE_TITLE,
    tagline: row.tagline ?? null,
    timezone: row.timezone || "Asia/Jakarta",
    locale: row.locale || "id-ID",
    activeThemeId: row.active_theme_id || "compro",
    faviconMediaId: row.favicon_media_id ?? null,
    ogImageMediaId: row.og_image_media_id ?? null,
    blogEnabled: Number(row.blog_enabled) === 1,
    catalogEnabled: Number(row.catalog_enabled) === 1,
    aiTrainingPolicy: row.ai_training_policy === "disallow" ? "disallow" : "allow",
    analyticsConfig: parseAnalyticsConfigFromColumn(row.analytics_config_json),
    siteVisibility: "public",
  };
}

function businessProfileFromRawRow(row: RawBusinessProfileRow): BusinessProfileSnapshot {
  const parsedWeekday = safeJsonParse(row.weekday_hours_json);
  const parsedHoliday = safeJsonParse(row.holiday_hours_json);
  const parsedServiceAreas = safeJsonParse(row.service_areas_json);
  const parsedSocialLinks = safeJsonParse(row.social_links_json);

  return {
    businessName: row.business_name || DEFAULT_SITE_TITLE,
    businessCategory: row.business_category || "LocalBusiness",
    description: row.description ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    province: row.province ?? null,
    postalCode: row.postal_code ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    mapsUrl: row.maps_url ?? null,
    weekdayHours:
      typeof parsedWeekday === "string" ? parsedWeekday : (row.weekday_hours_json ?? null),
    holidayHours:
      typeof parsedHoliday === "string" ? parsedHoliday : (row.holiday_hours_json ?? null),
    serviceAreas: Array.isArray(parsedServiceAreas)
      ? parsedServiceAreas.filter((item): item is string => typeof item === "string")
      : [],
    whatsappE164: row.whatsapp_e164 ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    socialLinks: Array.isArray(parsedSocialLinks)
      ? (parsedSocialLinks as BusinessProfileSnapshot["socialLinks"])
      : [],
  };
}

function serializeGroupedTableJson(extension: GroupedSettingsExtension): string {
  return JSON.stringify({ _groupedSettings: extension });
}

function parseGroupedTableExtension(
  rawJson: string | null | undefined,
  fallbackSiteEnvelopeJson?: string | null,
): GroupedSettingsExtension {
  if (rawJson && rawJson.trim()) {
    const parsed = safeJsonParse(rawJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec._groupedSettings) {
        return extractGroupedSettingsExtension(rawJson);
      }
      return extractGroupedSettingsExtension(JSON.stringify({ _groupedSettings: rec }));
    }
  }
  if (fallbackSiteEnvelopeJson) {
    return extractGroupedSettingsExtension(fallbackSiteEnvelopeJson);
  }
  return createDefaultGroupedSettingsExtension();
}

function buildGroupedSettingsSnapshot(params: {
  readonly site: SiteSettingsSnapshot;
  readonly profile: BusinessProfileSnapshot;
  readonly brandAssets: BrandLogoAssets;
  readonly extension: GroupedSettingsExtension;
  readonly liveAnalytics: SiteSettingsSnapshot["analyticsConfig"];
  readonly liveHomepagePageId?: number | null;
}): GroupedSettingsSnapshot {
  const { site, profile, brandAssets, extension, liveAnalytics } = params;
  const effectiveHomepagePageId =
    extension.reading.homepageMode === "page"
      ? extension.reading.homepagePageId
      : (params.liveHomepagePageId ?? null);
  const effectiveHomepageMode =
    extension.reading.homepageMode === "page" && effectiveHomepagePageId !== null
      ? "page"
      : "modular";

  const general: GeneralSettingsGroupData = {
    siteTitle: site.siteTitle,
    tagline: site.tagline ?? null,
    timezone: site.timezone,
    locale: site.locale,
    logoMediaId: brandAssets.logoMediaId,
    logoLightMediaId: brandAssets.logoLightMediaId,
    logoDarkMediaId: brandAssets.logoDarkMediaId,
    faviconMediaId: site.faviconMediaId ?? null,
    publicEmail: profile.email ?? null,
  };

  const business: BusinessSettingsGroupData = {
    businessName: profile.businessName,
    businessCategory: profile.businessCategory,
    description: profile.description ?? null,
    phone: profile.phone ?? null,
    whatsappE164: profile.whatsappE164 ?? null,
    email: profile.email ?? null,
    address: profile.address ?? null,
    city: profile.city ?? null,
    province: profile.province ?? null,
    postalCode: profile.postalCode ?? null,
    latitude: profile.latitude ?? null,
    longitude: profile.longitude ?? null,
    mapsUrl: profile.mapsUrl ?? null,
    googleMapsReviewUrl: extension.business.googleMapsReviewUrl,
    weekdayHours: profile.weekdayHours ?? null,
    holidayHours: profile.holidayHours ?? null,
    serviceAreas: [...profile.serviceAreas],
    socialLinks: [...profile.socialLinks],
  };

  const reading: ReadingSettingsGroupData = {
    homepageMode: effectiveHomepageMode,
    homepagePageId: effectiveHomepageMode === "page" ? effectiveHomepagePageId : null,
    blogEnabled: site.blogEnabled,
    catalogEnabled: site.catalogEnabled,
    enabledOfferingTypes: site.catalogEnabled
      ? extension.reading.enabledOfferingTypes
      : [],
    itemsPerPage: extension.reading.itemsPerPage,
    fixedRoutes: FIXED_PUBLIC_ROUTES,
  };

  const seo: SeoSettingsGroupData = {
    defaultTitle: extension.seo.defaultTitle,
    defaultDescription: extension.seo.defaultDescription,
    ogImageMediaId: site.ogImageMediaId ?? null,
    siteVisibility: site.siteVisibility,
    aiTrainingPolicy: site.aiTrainingPolicy,
    googleSiteVerification: extension.seo.googleSiteVerification,
    bingSiteVerification: extension.seo.bingSiteVerification,
  };

  const privacy: PrivacySettingsGroupData = {
    privacyPageId: extension.privacy.privacyPageId,
    consentBannerText: extension.privacy.consentBannerText,
    consentPolicyVersion: extension.privacy.consentPolicyVersion,
  };

  const analytics: AnalyticsSettingsSummaryData = {
    ga4MeasurementId: liveAnalytics?.ga4MeasurementId ?? null,
    metaPixelId: liveAnalytics?.metaPixelId ?? null,
    tiktokPixelId: liveAnalytics?.tiktokPixelId ?? null,
  };

  return {
    general,
    business,
    reading,
    seo,
    privacy,
    analytics,
  };
}

/**
 * Read-only schema presence check for additive migration `0005_site_settings_grouped.sql`.
 * Never executes DDL; gracefully falls back to defaults in pre-0005 legacy harnesses.
 */
async function hasGroupedSettingsTable(tenantDb: D1Database): Promise<boolean> {
  const row = await tenantDb
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'site_settings_grouped'
       LIMIT 1`,
    )
    .first<{ readonly name: string }>();
  return Boolean(row?.name === "site_settings_grouped");
}

async function fetchRawSettingsRows(tenantDb: D1Database): Promise<{
  readonly siteRow: RawSiteSettingsRow | null;
  readonly profileRow: RawBusinessProfileRow | null;
  readonly hasGroupedTable: boolean;
  readonly groupedRow: RawGroupedSettingsRow | null;
}> {
  const [siteRow, profileRow, hasGroupedTable] = await Promise.all([
    tenantDb
      .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
      .first<RawSiteSettingsRow>(),
    tenantDb
      .prepare("SELECT * FROM business_profile WHERE id = 1 LIMIT 1")
      .first<RawBusinessProfileRow>(),
    hasGroupedSettingsTable(tenantDb),
  ]);

  const groupedRow = hasGroupedTable
    ? ((await tenantDb
        .prepare("SELECT * FROM site_settings_grouped WHERE id = 1 LIMIT 1")
        .first<RawGroupedSettingsRow>()) ?? null)
    : null;

  return {
    siteRow: siteRow ?? null,
    profileRow: profileRow ?? null,
    hasGroupedTable,
    groupedRow,
  };
}

async function listAvailablePages(tenantDb: D1Database): Promise<SettingsPageOption[]> {
  const res = await tenantDb
    .prepare(
      `SELECT id, slug, title, status, is_homepage, published_sections_json
       FROM pages
       WHERE deleted_at IS NULL
         AND status != 'trashed'
       ORDER BY is_homepage DESC, id ASC
       LIMIT 100`,
    )
    .all<{
      readonly id: number;
      readonly slug: string;
      readonly title: string;
      readonly status: "draft" | "published";
      readonly is_homepage: number;
      readonly published_sections_json: string | null;
    }>();

  return res.results.map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    status: row.status,
    isHomepage: Number(row.is_homepage) === 1,
    isPublished: row.status === "published" && row.published_sections_json !== null,
  }));
}

async function verifyOwnedReadyImageMediaIds(
  tenantDb: D1Database,
  refs: readonly { readonly field: string; readonly mediaId: number | null | undefined }[],
): Promise<void> {
  const checks: Array<{ readonly field: string; readonly mediaId: number }> = [];
  const uniqueIds = new Set<number>();
  for (const ref of refs) {
    if (ref.mediaId !== null && ref.mediaId !== undefined) {
      checks.push({ field: ref.field, mediaId: ref.mediaId });
      uniqueIds.add(ref.mediaId);
    }
  }
  if (uniqueIds.size === 0) return;

  const ids = [...uniqueIds];
  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(
      `SELECT id, kind, status
       FROM media_items
       WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ readonly id: number; readonly kind: string; readonly status: string }>();

  const valid = new Set<number>();
  for (const row of res.results) {
    if (row.kind === "image" && row.status === "ready") {
      valid.add(Number(row.id));
    }
  }

  const missing: PublicationValidationField[] = [];
  for (const check of checks) {
    if (!valid.has(check.mediaId)) {
      missing.push({
        field: check.field,
        code: "MEDIA_NOT_FOUND",
        message: `Media #${check.mediaId} tidak ditemukan sebagai gambar siap pakai pada situs ini.`,
      });
    }
  }
  if (missing.length > 0) {
    throw new SettingsValidationError(
      "Referensi media tidak ditemukan atau belum siap pakai pada situs ini.",
      missing,
    );
  }
}

async function verifyOwnedPageReference(
  tenantDb: D1Database,
  pageId: number,
  options: { readonly field: string; readonly requirePublished: boolean },
): Promise<RawPageOptionRow> {
  const row = await tenantDb
    .prepare(
      `SELECT id, slug, title, status, is_homepage, published_sections_json,
              draft_sections_json, version, updated_at
       FROM pages
       WHERE id = ? AND deleted_at IS NULL AND status != 'trashed'
       LIMIT 1`,
    )
    .bind(pageId)
    .first<RawPageOptionRow>();

  if (!row) {
    throw new SettingsValidationError(
      `Halaman #${pageId} tidak ditemukan pada situs ini.`,
      [
        {
          field: options.field,
          code: "PAGE_NOT_FOUND",
          message: `Page #${pageId} does not exist in this tenant.`,
        },
      ],
    );
  }

  if (options.requirePublished && (row.status !== "published" || !row.published_sections_json)) {
    throw new SettingsValidationError(
      `Halaman "${row.title}" harus diterbitkan terlebih dahulu sebelum dijadikan beranda.`,
      [
        {
          field: options.field,
          code: "HOMEPAGE_NOT_PUBLISHED",
          message: "Chosen homepage page must already be published.",
        },
      ],
    );
  }

  return row;
}

function patchPageEnvelopeIsHomepage(rawJson: string | null, isHomepage: boolean): string | null {
  if (!rawJson) return null;
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawJson;
  const rec = parsed as Record<string, unknown>;
  if (rec.snapshotVersion === 1 && rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)) {
    const data = rec.data as PageSnapshot;
    return JSON.stringify({
      ...rec,
      data: {
        ...data,
        isHomepage,
      },
    });
  }
  return rawJson;
}

function computeUnifiedVersion(
  siteRow: RawSiteSettingsRow | null,
  profileRow: RawBusinessProfileRow | null,
  groupedRow: RawGroupedSettingsRow | null,
): number {
  return Math.max(
    siteRow ? Number(siteRow.version) : 0,
    profileRow ? Number(profileRow.version) : 0,
    groupedRow ? Number(groupedRow.version) : 0,
  );
}

function extractPublishedVersion(
  siteRow: RawSiteSettingsRow | null,
  profileRow: RawBusinessProfileRow | null,
  groupedRow: RawGroupedSettingsRow | null,
): number {
  const hasPublished = Boolean(siteRow?.published_json && profileRow?.published_json);
  if (!hasPublished) return 0;
  const parsedSite = safeJsonParse(siteRow?.published_json);
  if (parsedSite && typeof parsedSite === "object" && !Array.isArray(parsedSite)) {
    const metaVer = (parsedSite as Record<string, unknown>)._publishedVersion;
    if (typeof metaVer === "number" && Number.isSafeInteger(metaVer) && metaVer >= 1) {
      return metaVer;
    }
  }
  return computeUnifiedVersion(siteRow, profileRow, groupedRow);
}

function resolveEffectiveDraftSnapshots(
  siteRow: RawSiteSettingsRow | null,
  profileRow: RawBusinessProfileRow | null,
  groupedRow: RawGroupedSettingsRow | null,
): {
  readonly site: SiteSettingsSnapshot;
  readonly profile: BusinessProfileSnapshot;
  readonly brandAssets: BrandLogoAssets;
  readonly extension: GroupedSettingsExtension;
  readonly liveAnalytics: SiteSettingsSnapshot["analyticsConfig"];
  readonly publishedSite: SiteSettingsSnapshot | null;
  readonly publishedProfile: BusinessProfileSnapshot | null;
  readonly publishedBrandAssets: BrandLogoAssets;
  readonly publishedExtension: GroupedSettingsExtension;
  readonly publishedAtMs: number;
  readonly contentModifiedAtMs: number;
} {
  const adminSite = siteRow
    ? extractDraftSnapshotForAdmin("site_settings", {
        resourceId: SINGLETON_ID,
        draftJson: siteRow.draft_json,
        publishedJson: siteRow.published_json,
        publishedAt: siteRow.published_at,
        contentModifiedAt: siteRow.content_modified_at,
        version: Number(siteRow.version),
        updatedAt: Number(siteRow.updated_at),
      })
    : null;

  const adminProfile = profileRow
    ? extractDraftSnapshotForAdmin("business_profile", {
        resourceId: SINGLETON_ID,
        draftJson: profileRow.draft_json,
        publishedJson: profileRow.published_json,
        publishedAt: profileRow.published_at,
        contentModifiedAt: profileRow.content_modified_at,
        version: Number(profileRow.version),
        updatedAt: Number(profileRow.updated_at),
      })
    : null;

  // Always source analyticsConfig exclusively from live `site_settings.analytics_config_json` (TASK-022 owns it).
  const liveAnalytics = siteRow ? parseAnalyticsConfigFromColumn(siteRow.analytics_config_json) : null;

  const baseSite = adminSite?.draft ?? (siteRow ? siteSettingsFromRawRow(siteRow) : defaultSiteSettingsSnapshot());
  const site: SiteSettingsSnapshot = {
    ...baseSite,
    activeThemeId: baseSite.activeThemeId || siteRow?.active_theme_id || "compro",
    analyticsConfig: liveAnalytics,
  };

  const profile =
    adminProfile?.draft ??
    (profileRow ? businessProfileFromRawRow(profileRow) : defaultBusinessProfileSnapshot(site.siteTitle));

  const draftRawJson = siteRow?.draft_json ?? siteRow?.published_json ?? null;
  const publishedRawJson = siteRow?.published_json ?? null;

  const brandAssets = extractBrandAssetsFromJson(draftRawJson);
  const publishedBrandAssets = extractBrandAssetsFromJson(publishedRawJson);

  // Prefer dedicated `site_settings_grouped` table so TASK-008/TASK-095 writes to `site_settings`
  // can NEVER wipe grouped-only settings.
  const extension = parseGroupedTableExtension(groupedRow?.draft_json, draftRawJson);
  const publishedExtension = parseGroupedTableExtension(groupedRow?.published_json, publishedRawJson);

  const publishedSite = adminSite?.published
    ? { ...adminSite.published, analyticsConfig: liveAnalytics }
    : null;
  const publishedProfile = adminProfile?.published ?? null;

  return {
    site,
    profile,
    brandAssets,
    extension,
    liveAnalytics,
    publishedSite,
    publishedProfile,
    publishedBrandAssets,
    publishedExtension,
    publishedAtMs: Math.max(
      adminSite?.publishedAt ?? 0,
      adminProfile?.publishedAt ?? 0,
      groupedRow?.published_at ?? 0,
    ),
    contentModifiedAtMs: Math.max(
      adminSite?.contentModifiedAt ?? 0,
      adminProfile?.contentModifiedAt ?? 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// Public & Admin Repository Operations
// ---------------------------------------------------------------------------

/**
 * Public-safe loader reading ONLY frozen published `site_settings`, `business_profile`,
 * and `site_settings_grouped` snapshots. NEVER reads `draft_json` or leaks draft edits.
 */
export async function getPublishedGroupedSettings(
  tenantDb: D1Database,
): Promise<PublishedGroupedSettingsDto | null> {
  const { siteRow, profileRow, groupedRow } = await fetchRawSettingsRows(tenantDb);
  if (!siteRow || !profileRow) return null;

  const pubSite = extractPublishedSnapshot("site_settings", {
    resourceId: SINGLETON_ID,
    publishedJson: siteRow.published_json,
    publishedAt: siteRow.published_at,
    contentModifiedAt: siteRow.content_modified_at,
    version: Number(siteRow.version),
    updatedAt: Number(siteRow.updated_at),
  });
  const pubProfile = extractPublishedSnapshot("business_profile", {
    resourceId: SINGLETON_ID,
    publishedJson: profileRow.published_json,
    publishedAt: profileRow.published_at,
    contentModifiedAt: profileRow.content_modified_at,
    version: Number(profileRow.version),
    updatedAt: Number(profileRow.updated_at),
  });

  if (!pubSite || !pubProfile) {
    return null;
  }

  const brandAssets = extractBrandAssetsFromJson(siteRow.published_json);
  const extension = parseGroupedTableExtension(groupedRow?.published_json, siteRow.published_json);
  const liveAnalytics = parseAnalyticsConfigFromColumn(siteRow.analytics_config_json);
  const settings = buildGroupedSettingsSnapshot({
    site: { ...pubSite.data, analyticsConfig: liveAnalytics },
    profile: pubProfile.data,
    brandAssets,
    extension,
    liveAnalytics,
  });

  const publishedAtMs = Math.max(
    pubSite.publishedAt ?? 0,
    pubProfile.publishedAt ?? 0,
    groupedRow?.published_at ?? 0,
  );
  const contentModifiedAtMs = Math.max(
    pubSite.contentModifiedAt ?? 0,
    pubProfile.contentModifiedAt ?? 0,
  );

  return {
    settings,
    version: Math.max(pubSite.version, pubProfile.version, groupedRow ? Number(groupedRow.version) : 0),
    versions: {
      siteSettings: pubSite.version,
      businessProfile: pubProfile.version,
      groupedSettings: groupedRow ? Number(groupedRow.version) : 0,
    },
    publishedAt: toIsoOrNull(publishedAtMs),
    contentModifiedAt: toIsoOrNull(contentModifiedAtMs),
  };
}

/**
 * Public-safe helper returning ONLY the published, validated Google Maps review URL
 * (REQ-074, TASK-073). NEVER reads `draft_json` so unpublished draft edits never leak publicly.
 */
export async function getPublishedGoogleMapsReviewUrl(
  tenantDb: D1Database,
): Promise<string | null> {
  const published = await getPublishedGroupedSettings(tenantDb);
  return published?.settings.business.googleMapsReviewUrl ?? null;
}

/**
 * Admin loader returning separated draft and published grouped settings for the scoped tenant,
 * plus available non-trashed pages for the Reading homepage & Privacy policy selectors.
 * MUST ONLY be invoked behind verified `settings:read` authorization.
 */
export async function getGroupedSettingsForAdmin(
  tenantDb: D1Database,
): Promise<GroupedSettingsAdminDto> {
  const [{ siteRow, profileRow, groupedRow }, availablePages] = await Promise.all([
    fetchRawSettingsRows(tenantDb),
    listAvailablePages(tenantDb),
  ]);

  const resolved = resolveEffectiveDraftSnapshots(siteRow, profileRow, groupedRow);
  const draft = buildGroupedSettingsSnapshot({
    site: resolved.site,
    profile: resolved.profile,
    brandAssets: resolved.brandAssets,
    extension: resolved.extension,
    liveAnalytics: resolved.liveAnalytics,
  });

  const published =
    resolved.publishedSite && resolved.publishedProfile
      ? buildGroupedSettingsSnapshot({
          site: resolved.publishedSite,
          profile: resolved.publishedProfile,
          brandAssets: resolved.publishedBrandAssets,
          extension: resolved.publishedExtension,
          liveAnalytics: resolved.liveAnalytics,
        })
      : null;

  const ssVersion = siteRow ? Number(siteRow.version) : 0;
  const bpVersion = profileRow ? Number(profileRow.version) : 0;
  const grVersion = groupedRow ? Number(groupedRow.version) : 0;
  const version = Math.max(ssVersion, bpVersion, grVersion);
  const publishedVersion = extractPublishedVersion(siteRow, profileRow, groupedRow);

  const hasUnpublishedChanges =
    siteRow !== null &&
    (published === null || JSON.stringify(draft) !== JSON.stringify(published));

  const updatedAtMs = Math.max(
    siteRow ? Number(siteRow.updated_at) : 0,
    profileRow ? Number(profileRow.updated_at) : 0,
    groupedRow ? Number(groupedRow.updated_at) : 0,
  );

  return {
    draft,
    published,
    version,
    draftVersion: version,
    publishedVersion,
    versions: {
      siteSettings: ssVersion,
      businessProfile: bpVersion,
      groupedSettings: grVersion,
    },
    hasUnpublishedChanges,
    publishedAt: toIsoOrNull(resolved.publishedAtMs),
    contentModifiedAt: toIsoOrNull(resolved.contentModifiedAtMs),
    updatedAt: toIsoOrNull(updatedAtMs),
    availablePages,
  };
}

/**
 * Validates and atomically saves draft edits for a single settings group.
 *
 * Guarantees:
 * - Analytics group mutations are rejected here (100% owned by TASK-022 `/settings/analytics`).
 * - Required `expectedVersion` optimistic concurrency check (`409 STALE_VERSION`).
 * - Strict group field allowlist + media/page ownership checks BEFORE any DB mutation.
 * - Persists grouped-only settings to dedicated `site_settings_grouped` inside the SAME
 *   atomic `tenantDb.batch()` as `site_settings` and `business_profile` + PII-free
 *   `tenant_activity_log` (`WHERE changes() = 1`).
 * - NEVER modifies live `published_json`, real live columns, `analytics_config_json`,
 *   `pages.is_homepage`, or `PLATFORM_DB.tenants.cache_version`.
 */
export async function saveGroupedSettingsDraft(
  tenantDb: D1Database,
  input: SaveGroupedSettingsDraftInput,
): Promise<GroupedSettingsAdminDto> {
  if (input.group === "analytics") {
    throw new SettingsValidationError(
      "Pengaturan analitik dikelola secara khusus melalui endpoint /settings/analytics (TASK-022).",
      [
        {
          field: "group",
          code: "READ_ONLY_GROUP",
          message: "Use /api/tenants/:tenantId/analytics to update direct analytics settings.",
        },
      ],
    );
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > 2_147_483_647
  ) {
    throw new SettingsValidationError("expectedVersion wajib berupa bilangan bulat non-negatif.", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "expectedVersion must be a non-negative integer.",
      },
    ]);
  }

  // 1. Validate group payload strictly before touching DB
  const validatedPatch = validateGroupedSettingsPatch(input.group, input.patch);

  // 2. Read current state & enforce OCC version check
  const { siteRow, profileRow, hasGroupedTable, groupedRow } = await fetchRawSettingsRows(tenantDb);
  const currentVersion = computeUnifiedVersion(siteRow, profileRow, groupedRow);
  if (input.expectedVersion !== currentVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentVersion,
    });
  }

  const resolved = resolveEffectiveDraftSnapshots(siteRow, profileRow, groupedRow);

  // 3. Merge validated patch onto current draft state while preserving ALL unrelated fields
  //    (analyticsConfig is NEVER mutated here — live `analytics_config_json` remains authoritative)
  const nextSite: SiteSettingsSnapshot = {
    ...resolved.site,
    ...(validatedPatch.siteSettingsPatch ?? {}),
    analyticsConfig: resolved.liveAnalytics,
  };

  const nextBrandAssets: BrandLogoAssets = {
    logoMediaId:
      validatedPatch.brandAssetsPatch && "logoMediaId" in validatedPatch.brandAssetsPatch
        ? (validatedPatch.brandAssetsPatch.logoMediaId ?? null)
        : resolved.brandAssets.logoMediaId,
    logoLightMediaId:
      validatedPatch.brandAssetsPatch && "logoLightMediaId" in validatedPatch.brandAssetsPatch
        ? (validatedPatch.brandAssetsPatch.logoLightMediaId ?? null)
        : resolved.brandAssets.logoLightMediaId,
    logoDarkMediaId:
      validatedPatch.brandAssetsPatch && "logoDarkMediaId" in validatedPatch.brandAssetsPatch
        ? (validatedPatch.brandAssetsPatch.logoDarkMediaId ?? null)
        : resolved.brandAssets.logoDarkMediaId,
  };

  const nextProfile: BusinessProfileSnapshot = {
    ...resolved.profile,
    ...(validatedPatch.businessProfilePatch ?? {}),
  };

  if (
    (nextProfile.latitude !== null && nextProfile.latitude !== undefined) !==
    (nextProfile.longitude !== null && nextProfile.longitude !== undefined)
  ) {
    throw new SettingsValidationError(
      "Latitude dan longitude harus diisi bersamaan atau dikosongkan keduanya.",
      [
        {
          field: "latitude",
          code: "INCOMPLETE_COORDINATES",
          message: "Both latitude and longitude must be provided together.",
        },
      ],
    );
  }

  let resolvedCatalogEnabled = nextSite.catalogEnabled;
  let resolvedReadingExt = {
    ...resolved.extension.reading,
    ...(validatedPatch.extensionPatch?.reading ?? {}),
  };

  if (
    validatedPatch.group === "reading" &&
    resolvedCatalogEnabled &&
    resolvedReadingExt.enabledOfferingTypes.length === 0
  ) {
    if (validatedPatch.extensionPatch?.reading?.enabledOfferingTypes === undefined) {
      resolvedReadingExt = {
        ...resolvedReadingExt,
        enabledOfferingTypes: [...ALL_OFFERING_TYPES],
      };
    } else {
      resolvedCatalogEnabled = false;
    }
  }

  const finalSite: SiteSettingsSnapshot = {
    ...nextSite,
    catalogEnabled: resolvedCatalogEnabled,
  };

  const nextExtension: GroupedSettingsExtension = {
    business: {
      ...resolved.extension.business,
      ...(validatedPatch.extensionPatch?.business ?? {}),
    },
    reading: resolvedReadingExt,
    seo: {
      ...resolved.extension.seo,
      ...(validatedPatch.extensionPatch?.seo ?? {}),
    },
    privacy: {
      ...resolved.extension.privacy,
      ...(validatedPatch.extensionPatch?.privacy ?? {}),
    },
  };

  if (nextExtension.reading.homepageMode === "page" && nextExtension.reading.homepagePageId === null) {
    throw new SettingsValidationError(
      "Pilih halaman yang sudah diterbitkan ketika mode beranda adalah halaman statis.",
      [
        {
          field: "homepagePageId",
          code: "HOMEPAGE_PAGE_REQUIRED",
          message: "homepagePageId is required when homepageMode is 'page'.",
        },
      ],
    );
  }

  // 4. Verify referenced media & page ownership in THIS tenant before writing anything
  await verifyOwnedReadyImageMediaIds(tenantDb, [
    { field: "faviconMediaId", mediaId: finalSite.faviconMediaId },
    { field: "ogImageMediaId", mediaId: finalSite.ogImageMediaId },
    { field: "logoMediaId", mediaId: nextBrandAssets.logoMediaId },
    { field: "logoLightMediaId", mediaId: nextBrandAssets.logoLightMediaId },
    { field: "logoDarkMediaId", mediaId: nextBrandAssets.logoDarkMediaId },
  ]);

  if (nextExtension.reading.homepageMode === "page" && nextExtension.reading.homepagePageId !== null) {
    await verifyOwnedPageReference(tenantDb, nextExtension.reading.homepagePageId, {
      field: "homepagePageId",
      requirePublished: true,
    });
  }

  if (nextExtension.privacy.privacyPageId !== null) {
    await verifyOwnedPageReference(tenantDb, nextExtension.privacy.privacyPageId, {
      field: "privacyPageId",
      requirePublished: false,
    });
  }

  // 5. Serialize strict snapshot envelopes + dedicated `site_settings_grouped` draft JSON
  const serializedSite = serializeDraftStoragePayload("site_settings", finalSite);
  const enrichedSiteDraftJson = attachGroupedSettingsExtension(
    serializedSite.json,
    nextExtension,
    nextBrandAssets,
  );
  const serializedProfile = serializeDraftStoragePayload("business_profile", nextProfile);
  const groupedDraftJson = serializeGroupedTableJson(nextExtension);

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const nextUnifiedVersion = currentVersion + 1;
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "admin";
  const auditSummary = `Draf pengaturan grup "${input.group}" disimpan (v${nextUnifiedVersion})`;
  const auditMetadata = JSON.stringify({
    group: input.group,
    draftVersion: nextUnifiedVersion,
    changedFields: Object.keys(input.patch).filter((k) => k !== "expectedVersion" && k !== "version"),
  });

  // 6. Execute single atomic batch in TenantStore (ctx.storage.transactionSync)
  // Every follow-up statement chains strictly on `changes() = 1` (and `updated_at = nowMs`)
  // from Statement 0 so an interleaved `V -> V+1` bump on `site_settings` causes ZERO mutations
  // across `business_profile`, `site_settings_grouped`, and `tenant_activity_log`.
  if (input.beforeDraftBatch) {
    await input.beforeDraftBatch();
  }

  const ssCurrentVersion = siteRow ? Number(siteRow.version) : 0;
  const bpCurrentVersion = profileRow ? Number(profileRow.version) : 0;
  const grCurrentVersion = groupedRow ? Number(groupedRow.version) : 0;

  const statements: D1PreparedStatement[] = [];

  if (!siteRow) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT OR IGNORE INTO site_settings (
             id, site_title, draft_json, version, updated_at
           )
           VALUES (1, ?, ?, ?, ?)`,
        )
        .bind(finalSite.siteTitle, enrichedSiteDraftJson, nextUnifiedVersion, nowMs),
    );
  } else {
    const groupedGuardSql = hasGroupedTable
      ? groupedRow
        ? "AND EXISTS (SELECT 1 FROM site_settings_grouped WHERE id = 1 AND version = ?)"
        : "AND NOT EXISTS (SELECT 1 FROM site_settings_grouped WHERE id = 1)"
      : "";
    const siteBindings: unknown[] = [
      enrichedSiteDraftJson,
      nextUnifiedVersion,
      nowMs,
      ssCurrentVersion,
      bpCurrentVersion,
      ...(hasGroupedTable && groupedRow ? [grCurrentVersion] : []),
    ];
    statements.push(
      tenantDb
        .prepare(
          `UPDATE site_settings
           SET draft_json = ?,
               version = ?,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND (
               NOT EXISTS (SELECT 1 FROM business_profile WHERE id = 1)
               OR EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?)
             )
             ${groupedGuardSql}`,
        )
        .bind(...siteBindings),
    );
  }

  if (!profileRow) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT OR IGNORE INTO business_profile (
             id, business_name, business_category, draft_json, version, updated_at
           )
           SELECT 1, ?, ?, ?, ?, ?
           WHERE changes() = 1
             AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND updated_at = ?)`,
        )
        .bind(
          nextProfile.businessName,
          nextProfile.businessCategory,
          serializedProfile.json,
          nextUnifiedVersion,
          nowMs,
          nextUnifiedVersion,
          nowMs,
        ),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE business_profile
           SET draft_json = ?,
               version = ?,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND changes() = 1
             AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND updated_at = ?)`,
        )
        .bind(
          serializedProfile.json,
          nextUnifiedVersion,
          nowMs,
          bpCurrentVersion,
          nextUnifiedVersion,
          nowMs,
        ),
    );
  }

  let groupedStmtIdx: number | null = null;
  if (hasGroupedTable) {
    groupedStmtIdx = statements.length;
    if (!groupedRow) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO site_settings_grouped (
               id, draft_json, published_json, version, updated_at, published_at
             )
             SELECT 1, ?, NULL, ?, ?, NULL
             WHERE changes() = 1
               AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND updated_at = ?)`,
          )
          .bind(
            groupedDraftJson,
            nextUnifiedVersion,
            nowMs,
            nextUnifiedVersion,
            nowMs,
          ),
      );
    } else {
      statements.push(
        tenantDb
          .prepare(
            `UPDATE site_settings_grouped
             SET draft_json = ?,
                 version = ?,
                 updated_at = ?
             WHERE id = 1
               AND version = ?
               AND changes() = 1
               AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND updated_at = ?)`,
          )
          .bind(
            groupedDraftJson,
            nextUnifiedVersion,
            nowMs,
            grCurrentVersion,
            nextUnifiedVersion,
            nowMs,
          ),
      );
    }
  }

  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id,
           summary, metadata_json, created_at
         )
         SELECT ?, ?, 'settings.draft_saved', 'site_settings', '1', ?, ?, ?
         WHERE changes() = 1
           AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND updated_at = ?)`,
      )
      .bind(
        actorUserId,
        actorRole,
        auditSummary,
        auditMetadata,
        nowMs,
        nextUnifiedVersion,
        nowMs,
      ),
  );

  const batchResults = await tenantDb.batch(statements);
  const siteChanges = batchResults[0]?.meta.changes ?? 0;
  const profileChanges = batchResults[1]?.meta.changes ?? 0;
  const groupedChanges =
    groupedStmtIdx !== null ? (batchResults[groupedStmtIdx]?.meta.changes ?? 0) : 1;

  if (siteChanges !== 1 || profileChanges !== 1 || groupedChanges !== 1) {
    const latest = await fetchRawSettingsRows(tenantDb);
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: computeUnifiedVersion(latest.siteRow, latest.profileRow, latest.groupedRow),
    });
  }

  return getGroupedSettingsForAdmin(tenantDb);
}

/**
 * Atomically publishes the tenant's grouped settings draft (`site_settings`, `business_profile`,
 * `site_settings_grouped`, and `pages.is_homepage` — including clearing `is_homepage = 0` when
 * switching back to `modular` + bumping `pages.version`) in ONE `tenantDb.batch()` guarded by
 * version & `changes() = 1` checks, preserves live `analytics_config_json` untouched, records a
 * PII-free `tenant_activity_log` entry, and bumps `PLATFORM_DB.tenants.cache_version` (with
 * chained `changes() = 1` safe compensation on cross-tier failure).
 */
export async function publishGroupedSettings(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: PublishGroupedSettingsInput,
): Promise<PublishGroupedSettingsResult> {
  const cleanTenantId = input.tenantId.trim();
  if (!cleanTenantId) {
    throw new SettingsValidationError("tenantId wajib diisi untuk publikasi pengaturan.", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId is required." },
    ]);
  }
  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > 2_147_483_647
  ) {
    throw new SettingsValidationError("expectedVersion wajib berupa bilangan bulat non-negatif.", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "expectedVersion must be a non-negative integer.",
      },
    ]);
  }

  const { siteRow, profileRow, hasGroupedTable, groupedRow } = await fetchRawSettingsRows(tenantDb);
  if (!siteRow || !profileRow) {
    throw new SettingsValidationError(
      "Simpan draf pengaturan terlebih dahulu sebelum menerbitkan.",
      [
        {
          field: "settings",
          code: "SETTINGS_NOT_INITIALIZED",
          message: "Settings must be saved before publishing.",
        },
      ],
    );
  }

  const currentVersion = computeUnifiedVersion(siteRow, profileRow, groupedRow);
  if (input.expectedVersion !== currentVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentVersion,
    });
  }

  const resolved = resolveEffectiveDraftSnapshots(siteRow, profileRow, groupedRow);
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const nextUnifiedVersion = currentVersion + 1;

  // Always read live `analytics_config_json` (owned exclusively by TASK-022) and NEVER write to the column.
  const liveAnalytics = parseAnalyticsConfigFromColumn(siteRow.analytics_config_json);
  const publishSiteData: SiteSettingsSnapshot = {
    ...resolved.site,
    activeThemeId: resolved.site.activeThemeId || siteRow.active_theme_id || "compro",
    analyticsConfig: liveAnalytics,
  };
  const publishProfileData: BusinessProfileSnapshot = resolved.profile;

  // Re-verify owned ready media IDs BEFORE mutating DB
  await verifyOwnedReadyImageMediaIds(tenantDb, [
    { field: "faviconMediaId", mediaId: publishSiteData.faviconMediaId },
    { field: "ogImageMediaId", mediaId: publishSiteData.ogImageMediaId },
    { field: "logoMediaId", mediaId: resolved.brandAssets.logoMediaId },
    { field: "logoLightMediaId", mediaId: resolved.brandAssets.logoLightMediaId },
    { field: "logoDarkMediaId", mediaId: resolved.brandAssets.logoDarkMediaId },
  ]);

  // Always inspect any existing live `is_homepage = 1` page for BOTH `page` AND `modular` modes!
  const existingHomepageRow =
    (await tenantDb
      .prepare(
        `SELECT id, slug, title, status, is_homepage, published_sections_json,
                draft_sections_json, version, updated_at
         FROM pages
         WHERE is_homepage = 1 AND deleted_at IS NULL
         LIMIT 1`,
      )
      .first<RawPageOptionRow>()) ?? null;

  let pageToDemote: RawPageOptionRow | null = null;
  let pageToPromote: RawPageOptionRow | null = null;

  if (resolved.extension.reading.homepageMode === "page") {
    if (resolved.extension.reading.homepagePageId === null) {
      throw new SettingsValidationError(
        "Pilih halaman yang sudah diterbitkan untuk mode beranda halaman statis.",
        [
          {
            field: "homepagePageId",
            code: "HOMEPAGE_PAGE_REQUIRED",
            message: "homepagePageId is required when homepageMode is 'page'.",
          },
        ],
      );
    }
    const targetRow = await verifyOwnedPageReference(
      tenantDb,
      resolved.extension.reading.homepagePageId,
      { field: "homepagePageId", requirePublished: true },
    );
    if (existingHomepageRow && Number(existingHomepageRow.id) !== Number(targetRow.id)) {
      pageToDemote = existingHomepageRow;
    }
    if (Number(targetRow.is_homepage) !== 1) {
      pageToPromote = targetRow;
    }
  } else {
    // Switching back to `modular` MUST clear any live `is_homepage = 1` page atomically!
    if (existingHomepageRow) {
      pageToDemote = existingHomepageRow;
    }
  }

  if (resolved.extension.privacy.privacyPageId !== null) {
    await verifyOwnedPageReference(tenantDb, resolved.extension.privacy.privacyPageId, {
      field: "privacyPageId",
      requirePublished: false,
    });
  }

  const siteEnvelope = buildPublishedSnapshot("site_settings", publishSiteData, {
    publishedAt: siteRow.published_at ?? nowMs,
    contentModifiedAt: nowMs,
  });
  const enrichedPublishedSiteJson = JSON.stringify({
    ...siteEnvelope,
    _brandAssets: resolved.brandAssets,
    _groupedSettings: resolved.extension,
    _publishedVersion: nextUnifiedVersion,
  });

  const profileEnvelope = buildPublishedSnapshot("business_profile", publishProfileData, {
    publishedAt: profileRow.published_at ?? nowMs,
    contentModifiedAt: nowMs,
  });
  const serializedPublishedProfileJson = JSON.stringify(profileEnvelope);
  const groupedJson = serializeGroupedTableJson(resolved.extension);

  const ssCurrentVersion = Number(siteRow.version);
  const bpCurrentVersion = Number(profileRow.version);
  const grCurrentVersion = groupedRow ? Number(groupedRow.version) : 0;
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "admin";

  const auditSummary = `Pengaturan situs diterbitkan ke publik (v${nextUnifiedVersion})`;
  const auditMetadata = JSON.stringify({
    publishedVersion: nextUnifiedVersion,
    blogEnabled: publishSiteData.blogEnabled,
    catalogEnabled: publishSiteData.catalogEnabled,
    siteVisibility: publishSiteData.siteVisibility,
    timezone: publishSiteData.timezone,
    homepageMode: resolved.extension.reading.homepageMode,
    homepagePageId: resolved.extension.reading.homepagePageId,
    hasGoogleMapsReviewUrl: Boolean(resolved.extension.business.googleMapsReviewUrl),
  });

  // Guard Statement 0 (`site_settings`) on exact versions of every participating table/page so
  // concurrent writers on ANY involved row cause 0 changes across the entire batch.
  const siteGuardClauses: string[] = [
    "id = 1",
    "version = ?",
    "EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?)",
  ];
  const siteGuardBindings: unknown[] = [ssCurrentVersion, bpCurrentVersion];

  if (hasGroupedTable) {
    if (groupedRow) {
      siteGuardClauses.push("EXISTS (SELECT 1 FROM site_settings_grouped WHERE id = 1 AND version = ?)");
      siteGuardBindings.push(grCurrentVersion);
    } else {
      siteGuardClauses.push("NOT EXISTS (SELECT 1 FROM site_settings_grouped WHERE id = 1)");
    }
  }
  if (pageToDemote) {
    siteGuardClauses.push(
      "EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND is_homepage = 1 AND deleted_at IS NULL)",
    );
    siteGuardBindings.push(pageToDemote.id, Number(pageToDemote.version));
  }
  if (pageToPromote) {
    siteGuardClauses.push(
      "EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND status = 'published' AND deleted_at IS NULL AND published_sections_json IS NOT NULL)",
    );
    siteGuardBindings.push(pageToPromote.id, Number(pageToPromote.version));
  }

  const statements: D1PreparedStatement[] = [
    // Statement 0: site_settings publish — deliberately OMITS `analytics_config_json` (TASK-022 owns it!)
    tenantDb
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
             published_json = ?,
             published_at = COALESCE(published_at, ?),
             content_modified_at = ?,
             version = ?,
             updated_at = ?
         WHERE ${siteGuardClauses.join(" AND ")}`,
      )
      .bind(
        publishSiteData.siteTitle,
        publishSiteData.tagline ?? null,
        publishSiteData.timezone,
        publishSiteData.locale,
        publishSiteData.activeThemeId,
        publishSiteData.faviconMediaId ?? null,
        publishSiteData.ogImageMediaId ?? null,
        publishSiteData.blogEnabled ? 1 : 0,
        publishSiteData.catalogEnabled ? 1 : 0,
        publishSiteData.aiTrainingPolicy,
        enrichedPublishedSiteJson,
        nowMs,
        nowMs,
        nextUnifiedVersion,
        nowMs,
        ...siteGuardBindings,
      ),
    // Statement 1: business_profile publish (chained on changes() = 1)
    tenantDb
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
             version = ?,
             updated_at = ?
         WHERE id = 1
           AND version = ?
           AND changes() = 1`,
      )
      .bind(
        publishProfileData.businessName,
        publishProfileData.businessCategory,
        publishProfileData.description ?? null,
        publishProfileData.address ?? null,
        publishProfileData.city ?? null,
        publishProfileData.province ?? null,
        publishProfileData.postalCode ?? null,
        publishProfileData.latitude ?? null,
        publishProfileData.longitude ?? null,
        publishProfileData.mapsUrl ?? null,
        publishProfileData.weekdayHours ? JSON.stringify(publishProfileData.weekdayHours) : null,
        publishProfileData.holidayHours ? JSON.stringify(publishProfileData.holidayHours) : null,
        JSON.stringify(publishProfileData.serviceAreas),
        publishProfileData.whatsappE164 ?? null,
        publishProfileData.phone ?? null,
        publishProfileData.email ?? null,
        JSON.stringify(publishProfileData.socialLinks),
        serializedPublishedProfileJson,
        nowMs,
        nowMs,
        nextUnifiedVersion,
        nowMs,
        bpCurrentVersion,
      ),
  ];

  // Statement 2 (optional): dedicated `site_settings_grouped` publish
  let groupedStmtIdx: number | null = null;
  if (hasGroupedTable) {
    groupedStmtIdx = statements.length;
    if (!groupedRow) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO site_settings_grouped (
               id, draft_json, published_json, version, updated_at, published_at
             )
             SELECT 1, ?, ?, ?, ?, ?
             WHERE changes() = 1`,
          )
          .bind(groupedJson, groupedJson, nextUnifiedVersion, nowMs, nowMs),
      );
    } else {
      statements.push(
        tenantDb
          .prepare(
            `UPDATE site_settings_grouped
             SET draft_json = ?,
                 published_json = ?,
                 published_at = COALESCE(published_at, ?),
                 version = ?,
                 updated_at = ?
             WHERE id = 1
               AND version = ?
               AND changes() = 1`,
          )
          .bind(
            groupedJson,
            groupedJson,
            nowMs,
            nextUnifiedVersion,
            nowMs,
            grCurrentVersion,
          ),
      );
    }
  }

  // Demote previous homepage (for BOTH switching to another static page AND switching back to `modular`)
  // Bumps `pages.version = version + 1` so stale page editors fail with 409!
  let demoteStmtIdx: number | null = null;
  if (pageToDemote) {
    demoteStmtIdx = statements.length;
    statements.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET is_homepage = 0,
               published_sections_json = ?,
               draft_sections_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND deleted_at IS NULL
             AND changes() = 1`,
        )
        .bind(
          patchPageEnvelopeIsHomepage(pageToDemote.published_sections_json, false),
          patchPageEnvelopeIsHomepage(pageToDemote.draft_sections_json, false) ??
            pageToDemote.draft_sections_json,
          nowMs,
          pageToDemote.id,
          Number(pageToDemote.version),
        ),
    );
  }

  // Promote target published page to homepage & bump `pages.version = version + 1`
  let promoteStmtIdx: number | null = null;
  if (pageToPromote) {
    promoteStmtIdx = statements.length;
    statements.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET is_homepage = 1,
               published_sections_json = ?,
               draft_sections_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status = 'published'
             AND deleted_at IS NULL
             AND published_sections_json IS NOT NULL
             AND changes() = 1`,
        )
        .bind(
          patchPageEnvelopeIsHomepage(pageToPromote.published_sections_json, true),
          patchPageEnvelopeIsHomepage(pageToPromote.draft_sections_json, true) ??
            pageToPromote.draft_sections_json,
          nowMs,
          pageToPromote.id,
          Number(pageToPromote.version),
        ),
    );
  }

  // Conditional PII-free audit entry (chained on changes() = 1)
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id,
           summary, metadata_json, created_at
         )
         SELECT ?, ?, 'settings.published', 'site_settings', '1', ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(actorUserId, actorRole, auditSummary, auditMetadata, nowMs),
  );

  const batchResults = await tenantDb.batch(statements);
  const siteChanges = batchResults[0]?.meta.changes ?? 0;
  const profileChanges = batchResults[1]?.meta.changes ?? 0;
  const groupedChanges =
    groupedStmtIdx !== null ? (batchResults[groupedStmtIdx]?.meta.changes ?? 0) : 1;
  const demoteChanges =
    demoteStmtIdx !== null ? (batchResults[demoteStmtIdx]?.meta.changes ?? 0) : 1;
  const promoteChanges =
    promoteStmtIdx !== null ? (batchResults[promoteStmtIdx]?.meta.changes ?? 0) : 1;

  if (
    siteChanges !== 1 ||
    profileChanges !== 1 ||
    groupedChanges !== 1 ||
    demoteChanges !== 1 ||
    promoteChanges !== 1
  ) {
    const latest = await fetchRawSettingsRows(tenantDb);
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: computeUnifiedVersion(latest.siteRow, latest.profileRow, latest.groupedRow),
    });
  }

  // Optional test hook before cross-tier cache bump (allows deterministic interleaved-writer rollback tests)
  if (input.beforeCacheVersionBump) {
    await input.beforeCacheVersionBump();
  }

  // Bump PLATFORM_DB.tenants.cache_version + evict isolate cache; compensate fail-closed on error
  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(platformDb, cleanTenantId, nowMs);
    evictTenantFromCache(cleanTenantId);
  } catch (err) {
    let compensated: boolean;
    try {
      compensated = await compensatePublishedSettings({
        tenantDb,
        siteRow,
        profileRow,
        hasGroupedTable,
        groupedRow,
        pageToDemote,
        pageToPromote,
        committedVersion: nextUnifiedVersion,
        committedAtMs: nowMs,
      });
    } catch {
      compensated = false;
    }
    throw new PublicationAtomicError(
      "Gagal memperbarui versi cache platform setelah publikasi pengaturan; perubahan dibatalkan.",
      { compensated, cause: err },
    );
  }

  const published = buildGroupedSettingsSnapshot({
    site: publishSiteData,
    profile: publishProfileData,
    brandAssets: resolved.brandAssets,
    extension: resolved.extension,
    liveAnalytics,
  });

  const publishedAtIso = new Date(siteRow.published_at ?? nowMs).toISOString();
  const modifiedIso = new Date(nowMs).toISOString();

  return {
    tenantId: cleanTenantId,
    version: nextUnifiedVersion,
    draftVersion: nextUnifiedVersion,
    publishedVersion: nextUnifiedVersion,
    versions: {
      siteSettings: nextUnifiedVersion,
      businessProfile: nextUnifiedVersion,
      groupedSettings: hasGroupedTable ? nextUnifiedVersion : 0,
    },
    cacheVersion,
    publishedAt: publishedAtIso,
    contentModifiedAt: modifiedIso,
    updatedAt: modifiedIso,
    published,
    hasUnpublishedChanges: false,
  };
}

/**
 * Chained `changes() = 1` guarded compensation for failed cross-tier publish.
 *
 * Statement 0 verifies exact `(version, updated_at)` on `site_settings`, `business_profile`,
 * `site_settings_grouped` (when present), AND every modified `pages` row BEFORE reverting
 * anything. Every subsequent restore/delete statement requires `changes() = 1`.
 *
 * If an interleaved writer modified ANY participating row before compensation ran, Statement 0
 * affects 0 rows -> ALL subsequent statements affect 0 rows -> returns `false` with ZERO
 * half-reverted state!
 */
async function compensatePublishedSettings(params: {
  readonly tenantDb: D1Database;
  readonly siteRow: RawSiteSettingsRow;
  readonly profileRow: RawBusinessProfileRow;
  readonly hasGroupedTable: boolean;
  readonly groupedRow: RawGroupedSettingsRow | null;
  readonly pageToDemote: RawPageOptionRow | null;
  readonly pageToPromote: RawPageOptionRow | null;
  readonly committedVersion: number;
  readonly committedAtMs: number;
}): Promise<boolean> {
  const {
    tenantDb,
    siteRow,
    profileRow,
    hasGroupedTable,
    groupedRow,
    pageToDemote,
    pageToPromote,
    committedVersion,
    committedAtMs,
  } = params;

  const siteGuardClauses: string[] = [
    "id = 1",
    "version = ?",
    "updated_at = ?",
    "EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ? AND updated_at = ?)",
  ];
  const siteGuardBindings: unknown[] = [
    committedVersion,
    committedAtMs,
    committedVersion,
    committedAtMs,
  ];

  if (hasGroupedTable) {
    siteGuardClauses.push(
      "EXISTS (SELECT 1 FROM site_settings_grouped WHERE id = 1 AND version = ? AND updated_at = ?)",
    );
    siteGuardBindings.push(committedVersion, committedAtMs);
  }
  if (pageToDemote) {
    siteGuardClauses.push(
      "EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND updated_at = ?)",
    );
    siteGuardBindings.push(pageToDemote.id, Number(pageToDemote.version) + 1, committedAtMs);
  }
  if (pageToPromote) {
    siteGuardClauses.push(
      "EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND updated_at = ?)",
    );
    siteGuardBindings.push(pageToPromote.id, Number(pageToPromote.version) + 1, committedAtMs);
  }

  const restoreStmts: D1PreparedStatement[] = [
    // Statement 0: site_settings restore (deliberately omits `analytics_config_json`!)
    tenantDb
      .prepare(
        `UPDATE site_settings
         SET site_title = ?, tagline = ?, timezone = ?, locale = ?,
             active_theme_id = ?, favicon_media_id = ?, og_image_media_id = ?,
             blog_enabled = ?, catalog_enabled = ?, ai_training_policy = ?,
             published_json = ?, published_at = ?, content_modified_at = ?,
             version = ?, updated_at = ?
         WHERE ${siteGuardClauses.join(" AND ")}`,
      )
      .bind(
        siteRow.site_title,
        siteRow.tagline,
        siteRow.timezone,
        siteRow.locale,
        siteRow.active_theme_id,
        siteRow.favicon_media_id,
        siteRow.og_image_media_id,
        siteRow.blog_enabled,
        siteRow.catalog_enabled,
        siteRow.ai_training_policy,
        siteRow.published_json,
        siteRow.published_at,
        siteRow.content_modified_at,
        siteRow.version,
        siteRow.updated_at,
        ...siteGuardBindings,
      ),
    // Statement 1: business_profile restore (chained on changes() = 1)
    tenantDb
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
         WHERE id = 1
           AND version = ?
           AND updated_at = ?
           AND changes() = 1`,
      )
      .bind(
        profileRow.business_name,
        profileRow.business_category,
        profileRow.description,
        profileRow.address,
        profileRow.city,
        profileRow.province,
        profileRow.postal_code,
        profileRow.latitude,
        profileRow.longitude,
        profileRow.maps_url,
        profileRow.weekday_hours_json,
        profileRow.holiday_hours_json,
        profileRow.service_areas_json,
        profileRow.whatsapp_e164,
        profileRow.phone,
        profileRow.email,
        profileRow.social_links_json,
        profileRow.published_json,
        profileRow.published_at,
        profileRow.content_modified_at,
        profileRow.version,
        profileRow.updated_at,
        committedVersion,
        committedAtMs,
      ),
  ];

  // Statement 2 (optional): site_settings_grouped restore or delete if newly inserted
  if (hasGroupedTable) {
    if (groupedRow) {
      restoreStmts.push(
        tenantDb
          .prepare(
            `UPDATE site_settings_grouped
             SET draft_json = ?, published_json = ?, version = ?, updated_at = ?, published_at = ?
             WHERE id = 1
               AND version = ?
               AND updated_at = ?
               AND changes() = 1`,
          )
          .bind(
            groupedRow.draft_json,
            groupedRow.published_json,
            groupedRow.version,
            groupedRow.updated_at,
            groupedRow.published_at,
            committedVersion,
            committedAtMs,
          ),
      );
    } else {
      restoreStmts.push(
        tenantDb
          .prepare(
            `DELETE FROM site_settings_grouped
             WHERE id = 1
               AND version = ?
               AND updated_at = ?
               AND changes() = 1`,
          )
          .bind(committedVersion, committedAtMs),
      );
    }
  }

  // Restore promoted page first (demoting it back to 0 so unique partial index on is_homepage = 1 never collides)
  if (pageToPromote) {
    restoreStmts.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET is_homepage = ?, published_sections_json = ?, draft_sections_json = ?,
               version = ?, updated_at = ?
           WHERE id = ?
             AND version = ?
             AND updated_at = ?
             AND changes() = 1`,
        )
        .bind(
          pageToPromote.is_homepage,
          pageToPromote.published_sections_json,
          pageToPromote.draft_sections_json,
          Number(pageToPromote.version),
          pageToPromote.updated_at,
          pageToPromote.id,
          Number(pageToPromote.version) + 1,
          committedAtMs,
        ),
    );
  }

  // Restore demoted page (re-promoting it back to is_homepage = 1)
  if (pageToDemote) {
    restoreStmts.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET is_homepage = ?, published_sections_json = ?, draft_sections_json = ?,
               version = ?, updated_at = ?
           WHERE id = ?
             AND version = ?
             AND updated_at = ?
             AND changes() = 1`,
        )
        .bind(
          pageToDemote.is_homepage,
          pageToDemote.published_sections_json,
          pageToDemote.draft_sections_json,
          Number(pageToDemote.version),
          pageToDemote.updated_at,
          pageToDemote.id,
          Number(pageToDemote.version) + 1,
          committedAtMs,
        ),
    );
  }

  // Remove the uncommitted `settings.published` activity log row (chained on changes() = 1)
  restoreStmts.push(
    tenantDb
      .prepare(
        `DELETE FROM tenant_activity_log
         WHERE id = (
           SELECT MAX(id)
           FROM tenant_activity_log
           WHERE action = 'settings.published'
             AND resource_type = 'site_settings'
             AND created_at = ?
         )
         AND changes() = 1`,
      )
      .bind(committedAtMs),
  );

  const restoreResults = await tenantDb.batch(restoreStmts);
  const siteChanges = restoreResults[0]?.meta.changes ?? 0;
  return siteChanges === 1;
}

export {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  SettingsValidationError,
  StaleRevisionError,
};
