import {
  formatTruthfulCredentialItems,
  resolveBusinessCategoryDefinition,
  resolveEffectiveBrandAssets,
  STRUCTURED_BUSINESS_PROFILE_EXTENSION_KEYS,
  validateClosedBusinessCategoryStrict,
  validateStructuredProfileExtension,
  type BrandAssetDerivationState,
  type BusinessEntityProfileKind,
  type BusinessProfileStructuredExtension,
  type BusinessWeekdayKey,
  type ClosedBusinessCategoryKey,
  type DerivedBrandAssetEntry,
  type EffectiveBrandAssetsResolution,
  type IndonesianBusinessCredentials,
  type TruthfulCredentialItem,
} from "@punyasitus/core/business-profile/index";
import {
  buildPublishedSnapshot,
  serializeDraftStoragePayload,
  type BusinessProfileSnapshot,
  type PublicationValidationField,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import type { AllowedBusinessSchemaType } from "@punyasitus/core/schema-generator";
import {
  BUSINESS_PROFILE_ALLOWED_KEYS,
  getPublishedSiteIdentity,
  getSiteIdentityForAdmin,
  IdentityValidationError,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  SITE_SETTINGS_ALLOWED_KEYS,
  StaleRevisionError,
  validateBusinessProfileInput,
  validateSiteSettingsInput,
  verifyOwnedBrandMediaIds,
  type BrandLogoAssets,
  type SiteSettingsIdentityData,
} from "../identity/index.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Structured Business Profile & Auto-Derived Brand Assets Repository
 * (`packages/db/src/business-profile/index.ts`; REQ-091, REQ-044, REQ-054, PLAN §5.2, §7.3, §19.5; TASK-091).
 *
 * Hard Invariants:
 * - ZERO request-time DDL (never executes schema creation statements at runtime).
 *   Tables `business_profile_structured` and `brand_asset_derivations` are provisioned strictly
 *   via `0011_business_profile_structured.sql` (`packages/db/src/business-profile/migrations.ts`).
 * - Single atomic `tenantDb.batch()` for draft save and single atomic `tenantDb.batch()` for publish,
 *   chained on `changes() = 1` with strictly monotonic unified version (`Math.max(base, ext) + 1`).
 * - Chained `changes() = 1` cross-tier compensation guarded on exact `(committedVersion, nowMs)`
 *   if `PLATFORM_DB.tenants.cache_version` bump fails during publish.
 * - Preserves ALL unrelated `site_settings` columns (`activeThemeId`, `analytics_config_json`,
 *   `analytics_risk_ack_at`, `blog_enabled`, `catalog_enabled`, `ai_training_policy`).
 * - Closed `business_category` validation mapped to valid Schema.org subtypes (default `LocalBusiness`,
 *   ZERO `ProfessionalService` anywhere).
 * - Race-safe `applyAutoDerivedBrandAssets`: guarded in SQL on active logo match + `IS NULL` explicit
 *   override checks so stale logo jobs never overwrite newer logos or explicit tenant overrides.
 */

const SINGLETON_ID = 1 as const;

export const STRUCTURED_BUSINESS_PROFILE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...BUSINESS_PROFILE_ALLOWED_KEYS,
  ...STRUCTURED_BUSINESS_PROFILE_EXTENSION_KEYS,
]);

export const STRUCTURED_IDENTITY_PATCH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "siteSettings",
  "businessProfile",
  "expectedVersion",
  "version",
  ...SITE_SETTINGS_ALLOWED_KEYS,
  ...STRUCTURED_BUSINESS_PROFILE_ALLOWED_KEYS,
]);

export interface StructuredBusinessProfileData extends BusinessProfileSnapshot {
  readonly businessCategoryKey: ClosedBusinessCategoryKey;
  readonly resolvedSchemaType: AllowedBusinessSchemaType;
  readonly entityProfileKind: BusinessEntityProfileKind;
  readonly legalName: string | null;
  readonly privacyContact: string | null;
  readonly personRoleTitle: string | null;
  readonly affiliatedOrgName: string | null;
  readonly closedDays: readonly BusinessWeekdayKey[];
  readonly credentials: IndonesianBusinessCredentials;
  readonly truthfulCredentials: readonly TruthfulCredentialItem[];
}

export interface BrandAssetsAdminDto {
  readonly sourceLogoMediaId: number | null;
  readonly faviconOverrideMediaId: number | null;
  readonly ogImageOverrideMediaId: number | null;
  readonly derivedFavicon32: DerivedBrandAssetEntry | null;
  readonly derivedAppleTouch180: DerivedBrandAssetEntry | null;
  readonly derivedOg1200x630: DerivedBrandAssetEntry | null;
  readonly effective: EffectiveBrandAssetsResolution;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface StructuredBusinessProfileSnapshot {
  readonly siteSettings: SiteSettingsIdentityData;
  readonly businessProfile: StructuredBusinessProfileData;
  readonly brandAssets: BrandAssetsAdminDto;
}

export interface StructuredBusinessProfileAdminDto {
  readonly siteSettings: SiteSettingsIdentityData | null;
  readonly businessProfile: StructuredBusinessProfileData | null;
  readonly brandAssets: BrandAssetsAdminDto;
  readonly draft: StructuredBusinessProfileSnapshot | null;
  readonly published: StructuredBusinessProfileSnapshot | null;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
    readonly structuredExtension: number;
  };
  readonly hasUnpublishedChanges: boolean;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly updatedAt: string | null;
}

export interface PublishedStructuredBusinessProfileDto {
  readonly siteSettings: SiteSettingsIdentityData;
  readonly businessProfile: StructuredBusinessProfileData;
  readonly brandAssets: BrandAssetsAdminDto;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
}

export interface SaveStructuredBusinessProfileInput {
  readonly siteSettings?: Record<string, unknown>;
  readonly businessProfile?: Record<string, unknown>;
  readonly expectedVersion?: number;
  readonly mode?: "put" | "patch";
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly nowMs?: number;
}

export interface PublishStructuredBusinessProfileInput {
  readonly tenantId: string;
  readonly expectedVersion?: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly nowMs?: number;
}

export interface PublishStructuredBusinessProfileResult {
  readonly tenantId: string;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
    readonly structuredExtension: number;
  };
  readonly cacheVersion: number;
  readonly publishedAt: string;
  readonly contentModifiedAt: string;
  readonly published: StructuredBusinessProfileSnapshot;
  readonly hasUnpublishedChanges: false;
}

export interface ApplyAutoDerivedBrandAssetsInput {
  readonly sourceLogoMediaId: number;
  readonly favicon32?: DerivedBrandAssetEntry | null;
  readonly appleTouch180?: DerivedBrandAssetEntry | null;
  readonly og1200x630?: DerivedBrandAssetEntry | null;
  readonly nowMs?: number;
}

export interface ApplyAutoDerivedBrandAssetsResult {
  readonly appliedFavicon: boolean;
  readonly appliedOgImage: boolean;
  readonly preservedFaviconOverride: boolean;
  readonly preservedOgOverride: boolean;
  readonly staleLogoSkipped: boolean;
  readonly brandAssets: BrandAssetsAdminDto;
}

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

interface RawStructuredRow {
  readonly id: number;
  readonly legal_name: string | null;
  readonly privacy_contact: string | null;
  readonly person_role_title: string | null;
  readonly affiliated_org_name: string | null;
  readonly closed_days_json: string;
  readonly credentials_json: string;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawBrandDerivationRow {
  readonly id: number;
  readonly source_logo_media_id: number | null;
  readonly favicon_override_media_id: number | null;
  readonly og_image_override_media_id: number | null;
  readonly derived_favicon_32_json: string | null;
  readonly derived_apple_touch_180_json: string | null;
  readonly derived_og_1200x630_json: string | null;
  readonly version: number;
  readonly updated_at: number;
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
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no such table/i.test(msg);
}

function emptyExtension(): BusinessProfileStructuredExtension {
  return {
    legalName: null,
    privacyContact: null,
    personRoleTitle: null,
    affiliatedOrgName: null,
    closedDays: [],
    credentials: {},
  };
}

function attachBrandAssetsToEnvelopeJson(rawJson: string, brandAssets: BrandLogoAssets): string {
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawJson;
  }
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    _brandAssets: brandAssets,
  });
}

function parseExtensionJson(
  raw: string | null | undefined,
): BusinessProfileStructuredExtension | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const validated = validateStructuredProfileExtension(parsed as Record<string, unknown>, null);
  return validated.ok ? validated.value : null;
}

function extensionFromRow(
  row: RawStructuredRow | null,
  mode: "draft" | "published",
): BusinessProfileStructuredExtension {
  if (!row) return emptyExtension();
  if (mode === "published") {
    return parseExtensionJson(row.published_json) ?? emptyExtension();
  }
  const fromDraft = parseExtensionJson(row.draft_json);
  if (fromDraft) return fromDraft;
  const closedParsed = safeJsonParse(row.closed_days_json);
  const credsParsed = safeJsonParse(row.credentials_json);
  const validated = validateStructuredProfileExtension(
    {
      legalName: row.legal_name,
      privacyContact: row.privacy_contact,
      personRoleTitle: row.person_role_title,
      affiliatedOrgName: row.affiliated_org_name,
      closedDays: Array.isArray(closedParsed) ? closedParsed : [],
      credentials:
        credsParsed && typeof credsParsed === "object" && !Array.isArray(credsParsed)
          ? credsParsed
          : {},
    },
    null,
  );
  return validated.ok ? validated.value : emptyExtension();
}

function parseDerivedAssetEntry(raw: string | null | undefined): DerivedBrandAssetEntry | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.key !== "string" ||
    typeof rec.width !== "number" ||
    typeof rec.height !== "number" ||
    typeof rec.bytes !== "number" ||
    rec.mimeType !== "image/webp" ||
    typeof rec.sourceLogoMediaId !== "number" ||
    typeof rec.derivedAt !== "string"
  ) {
    return null;
  }
  return {
    key: rec.key,
    width: rec.width,
    height: rec.height,
    bytes: rec.bytes,
    mimeType: "image/webp",
    sourceLogoMediaId: rec.sourceLogoMediaId,
    derivedAt: rec.derivedAt,
  };
}

function buildBrandAssetsDto(
  row: RawBrandDerivationRow | null,
  siteSettings: SiteSettingsIdentityData | null,
): BrandAssetsAdminDto {
  const explicitFavicon =
    siteSettings?.faviconMediaId ?? row?.favicon_override_media_id ?? null;
  const explicitOg =
    siteSettings?.ogImageMediaId ?? row?.og_image_override_media_id ?? null;
  const sourceLogo = siteSettings?.logoMediaId ?? row?.source_logo_media_id ?? null;
  const derivedFavicon32 = parseDerivedAssetEntry(row?.derived_favicon_32_json);
  const derivedAppleTouch180 = parseDerivedAssetEntry(row?.derived_apple_touch_180_json);
  const derivedOg1200x630 = parseDerivedAssetEntry(row?.derived_og_1200x630_json);

  const state: BrandAssetDerivationState = {
    sourceLogoMediaId: sourceLogo,
    faviconOverrideMediaId: explicitFavicon,
    ogImageOverrideMediaId: explicitOg,
    derivedFavicon32,
    derivedAppleTouch180,
    derivedOg1200x630,
  };

  return {
    sourceLogoMediaId: sourceLogo,
    faviconOverrideMediaId: explicitFavicon,
    ogImageOverrideMediaId: explicitOg,
    derivedFavicon32,
    derivedAppleTouch180,
    derivedOg1200x630,
    effective: resolveEffectiveBrandAssets(state),
    version: row ? Number(row.version) : 0,
    updatedAt: toIsoOrNull(row?.updated_at),
  };
}

function enrichBusinessProfile(
  base: BusinessProfileSnapshot,
  ext: BusinessProfileStructuredExtension,
): StructuredBusinessProfileData {
  const categoryDef = resolveBusinessCategoryDefinition(base.businessCategory);
  return {
    ...base,
    businessCategoryKey: categoryDef.key,
    resolvedSchemaType: categoryDef.schemaType,
    entityProfileKind: categoryDef.entityProfileKind,
    legalName: ext.legalName,
    privacyContact: ext.privacyContact,
    personRoleTitle: ext.personRoleTitle,
    affiliatedOrgName: ext.affiliatedOrgName,
    closedDays: ext.closedDays,
    credentials: ext.credentials,
    truthfulCredentials: formatTruthfulCredentialItems(ext.credentials, categoryDef.key),
  };
}

async function fetchBaseIdentityRows(tenantDb: D1Database): Promise<{
  readonly siteRow: RawSiteSettingsRow | null;
  readonly profileRow: RawBusinessProfileRow | null;
}> {
  const [siteRow, profileRow] = await Promise.all([
    tenantDb
      .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
      .first<RawSiteSettingsRow>(),
    tenantDb
      .prepare("SELECT * FROM business_profile WHERE id = 1 LIMIT 1")
      .first<RawBusinessProfileRow>(),
  ]);
  return { siteRow: siteRow ?? null, profileRow: profileRow ?? null };
}

async function fetchStructuredTablesSafe(tenantDb: D1Database): Promise<{
  readonly tablesPresent: boolean;
  readonly structuredRow: RawStructuredRow | null;
  readonly brandRow: RawBrandDerivationRow | null;
}> {
  try {
    const [structuredRow, brandRow] = await Promise.all([
      tenantDb
        .prepare("SELECT * FROM business_profile_structured WHERE id = 1 LIMIT 1")
        .first<RawStructuredRow>(),
      tenantDb
        .prepare("SELECT * FROM brand_asset_derivations WHERE id = 1 LIMIT 1")
        .first<RawBrandDerivationRow>(),
    ]);
    return {
      tablesPresent: true,
      structuredRow: structuredRow ?? null,
      brandRow: brandRow ?? null,
    };
  } catch (err) {
    if (isMissingTableError(err)) {
      return { tablesPresent: false, structuredRow: null, brandRow: null };
    }
    throw err;
  }
}

function getStatementChanges(result: D1Result | undefined): number {
  const meta = result?.meta as { readonly changes?: number } | undefined;
  return Number(meta?.changes ?? 0);
}

/**
 * Reads current brand-asset override & auto-derivation state from `TenantStore`.
 * Never executes runtime DDL.
 */
export async function getBrandAssetDerivationState(
  tenantDb: D1Database,
): Promise<BrandAssetsAdminDto> {
  const [adminIdentity, extra] = await Promise.all([
    getSiteIdentityForAdmin(tenantDb),
    fetchStructuredTablesSafe(tenantDb),
  ]);
  return buildBrandAssetsDto(extra.brandRow, adminIdentity.siteSettings);
}

/**
 * Admin loader returning separated draft & published structured business profile,
 * resolved Schema.org subtype, truthful credentials, and brand-asset derivation status.
 */
export async function getStructuredBusinessProfileForAdmin(
  tenantDb: D1Database,
): Promise<StructuredBusinessProfileAdminDto> {
  const [baseAdmin, extra] = await Promise.all([
    getSiteIdentityForAdmin(tenantDb),
    fetchStructuredTablesSafe(tenantDb),
  ]);

  const draftExt = extensionFromRow(extra.structuredRow, "draft");
  const publishedExt = extensionFromRow(extra.structuredRow, "published");
  const brandAssets = buildBrandAssetsDto(extra.brandRow, baseAdmin.siteSettings);

  const draftProfile = baseAdmin.businessProfile
    ? enrichBusinessProfile(baseAdmin.businessProfile, draftExt)
    : null;
  const publishedProfile = baseAdmin.published?.businessProfile
    ? enrichBusinessProfile(baseAdmin.published.businessProfile, publishedExt)
    : null;

  const draft: StructuredBusinessProfileSnapshot | null =
    baseAdmin.siteSettings && draftProfile
      ? {
          siteSettings: baseAdmin.siteSettings,
          businessProfile: draftProfile,
          brandAssets,
        }
      : null;

  const published: StructuredBusinessProfileSnapshot | null =
    baseAdmin.published?.siteSettings && publishedProfile
      ? {
          siteSettings: baseAdmin.published.siteSettings,
          businessProfile: publishedProfile,
          brandAssets,
        }
      : null;

  const extVersion = extra.structuredRow ? Number(extra.structuredRow.version) : 0;
  const version = Math.max(baseAdmin.version, extVersion);

  const hasUnpublishedExtensionChanges =
    extra.structuredRow !== null &&
    (extra.structuredRow.published_json === null ||
      JSON.stringify(draftExt) !== JSON.stringify(publishedExt));

  return {
    siteSettings: baseAdmin.siteSettings,
    businessProfile: draftProfile,
    brandAssets,
    draft,
    published,
    version,
    versions: {
      siteSettings: baseAdmin.versions.siteSettings,
      businessProfile: baseAdmin.versions.businessProfile,
      structuredExtension: extVersion,
    },
    hasUnpublishedChanges: baseAdmin.hasUnpublishedChanges || hasUnpublishedExtensionChanges,
    publishedAt: baseAdmin.publishedAt,
    contentModifiedAt: baseAdmin.contentModifiedAt,
    updatedAt: baseAdmin.updatedAt ?? toIsoOrNull(extra.structuredRow?.updated_at),
  };
}

/**
 * Public-safe loader returning ONLY published structured business profile & brand assets.
 * NEVER reads `draft_json` or leaks draft edits!
 */
export async function getPublishedStructuredBusinessProfile(
  tenantDb: D1Database,
): Promise<PublishedStructuredBusinessProfileDto | null> {
  const [basePublished, extra] = await Promise.all([
    getPublishedSiteIdentity(tenantDb),
    fetchStructuredTablesSafe(tenantDb),
  ]);
  if (!basePublished) return null;

  const publishedExt = extensionFromRow(extra.structuredRow, "published");
  const brandAssets = buildBrandAssetsDto(extra.brandRow, basePublished.siteSettings);

  return {
    siteSettings: basePublished.siteSettings,
    businessProfile: enrichBusinessProfile(basePublished.businessProfile, publishedExt),
    brandAssets,
    version: Math.max(
      basePublished.version,
      extra.structuredRow ? Number(extra.structuredRow.version) : 0,
    ),
    publishedAt: basePublished.publishedAt,
    contentModifiedAt: basePublished.contentModifiedAt,
  };
}

/**
 * Splits a businessProfile patch into base TASK-008 columns vs TASK-091 structured extension fields.
 * Strictly validates the closed `businessCategory` allowlist (rejects `ProfessionalService` and
 * unknown junk values with `422 INVALID_BUSINESS_CATEGORY`).
 */
export function partitionBusinessProfilePatch(
  rawProfilePatch: Record<string, unknown> | undefined,
): {
  readonly baseProfilePatch: Record<string, unknown>;
  readonly extensionPatch: Record<string, unknown>;
  readonly hasBaseFields: boolean;
  readonly hasExtensionFields: boolean;
} {
  const baseProfilePatch: Record<string, unknown> = {};
  const extensionPatch: Record<string, unknown> = {};

  if (!rawProfilePatch) {
    return {
      baseProfilePatch,
      extensionPatch,
      hasBaseFields: false,
      hasExtensionFields: false,
    };
  }

  for (const [key, value] of Object.entries(rawProfilePatch)) {
    if (STRUCTURED_BUSINESS_PROFILE_EXTENSION_KEYS.has(key)) {
      extensionPatch[key] = value;
    } else if (BUSINESS_PROFILE_ALLOWED_KEYS.has(key)) {
      if (key === "businessCategory") {
        const checked = validateClosedBusinessCategoryStrict(
          value,
          "businessProfile.businessCategory",
        );
        if (!checked.ok) {
          throw new IdentityValidationError(checked.issue.message, [checked.issue]);
        }
        baseProfilePatch[key] = checked.definition.key;
      } else {
        baseProfilePatch[key] = value;
      }
    } else {
      throw new IdentityValidationError(`Unknown field "${key}" in businessProfile.`, [
        {
          field: `businessProfile.${key}`,
          code: "UNKNOWN_FIELD",
          message: `Unknown field "${key}" in businessProfile.`,
        },
      ]);
    }
  }

  return {
    baseProfilePatch,
    extensionPatch,
    hasBaseFields: Object.keys(baseProfilePatch).length > 0,
    hasExtensionFields: Object.keys(extensionPatch).length > 0,
  };
}

/**
 * Validates and saves structured business profile + site identity draft inside ONE single
 * atomic `tenantDb.batch()` chained strictly on `changes() = 1` with:
 * - Strictly monotonic unified version (`nextVersion = Math.max(ss, bp, ext) + 1`) written to ALL tables
 * - Closed `business_category` validation (zero `ProfessionalService`)
 * - Optional Indonesian credential format validation
 * - Optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`, zero partial writes, zero audit row)
 * - Atomic `INSERT ... ON CONFLICT(id) DO UPDATE` for `brand_asset_derivations` (zero 500 PK races)
 * - Atomic `WHERE changes() = 1` audit entry in `tenant_activity_log`
 * - Preservation of all unrelated `site_settings` columns (`activeThemeId`, `analytics_config_json`, etc.)
 */
export async function saveStructuredBusinessProfileDraft(
  tenantDb: D1Database,
  input: SaveStructuredBusinessProfileInput,
): Promise<StructuredBusinessProfileAdminDto> {
  const nowMs = input.nowMs ?? Date.now();
  const mode = input.mode ?? "patch";

  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new IdentityValidationError("expectedVersion must be a non-negative integer.", [
        {
          field: "expectedVersion",
          code: "INVALID_VERSION",
          message: "expectedVersion must be a non-negative integer.",
        },
      ]);
    }
  }

  const [{ siteRow, profileRow }, currentAdmin, extra] = await Promise.all([
    fetchBaseIdentityRows(tenantDb),
    getSiteIdentityForAdmin(tenantDb),
    fetchStructuredTablesSafe(tenantDb),
  ]);

  const ssVersion = siteRow ? Number(siteRow.version) : 0;
  const bpVersion = profileRow ? Number(profileRow.version) : 0;
  const extVersion = extra.structuredRow ? Number(extra.structuredRow.version) : 0;
  const currentUnifiedVersion = Math.max(ssVersion, bpVersion, extVersion);

  if (input.expectedVersion !== undefined && input.expectedVersion !== currentUnifiedVersion) {
    throw new StaleRevisionError({
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentUnifiedVersion,
    });
  }

  // Strictly monotonic unified version across base & structured tables
  const nextVersion = currentUnifiedVersion + 1;

  const { baseProfilePatch, extensionPatch, hasExtensionFields } =
    partitionBusinessProfilePatch(input.businessProfile);

  // Build merged inputs preserving unrelated site_settings fields (activeThemeId, analyticsConfig, etc.)
  const rawSiteInput: Record<string, unknown> = { ...(input.siteSettings ?? {}) };
  const rawProfileInput: Record<string, unknown> = { ...baseProfilePatch };

  const baseSite = mode === "put" && input.siteSettings ? null : currentAdmin.siteSettings;
  const baseProfile =
    mode === "put" && input.businessProfile ? null : currentAdmin.businessProfile;

  if (!baseSite && !Object.prototype.hasOwnProperty.call(rawSiteInput, "siteTitle")) {
    const inferredTitle =
      typeof rawProfileInput.businessName === "string"
        ? rawProfileInput.businessName
        : currentAdmin.siteSettings?.siteTitle;
    if (inferredTitle) {
      rawSiteInput.siteTitle = inferredTitle;
    }
  }
  if (!baseProfile && !Object.prototype.hasOwnProperty.call(rawProfileInput, "businessName")) {
    const inferredName =
      typeof rawSiteInput.siteTitle === "string"
        ? rawSiteInput.siteTitle
        : currentAdmin.businessProfile?.businessName;
    if (inferredName) {
      rawProfileInput.businessName = inferredName;
    }
  }

  const siteValidationBase: SiteSettingsIdentityData | null =
    baseSite ??
    (currentAdmin.siteSettings
      ? {
          siteTitle: "",
          tagline: null,
          timezone: "Asia/Jakarta",
          locale: "id-ID",
          activeThemeId: currentAdmin.siteSettings.activeThemeId,
          faviconMediaId: null,
          ogImageMediaId: null,
          logoMediaId: null,
          logoLightMediaId: null,
          logoDarkMediaId: null,
          blogEnabled: currentAdmin.siteSettings.blogEnabled,
          catalogEnabled: currentAdmin.siteSettings.catalogEnabled,
          aiTrainingPolicy: currentAdmin.siteSettings.aiTrainingPolicy,
          analyticsConfig: currentAdmin.siteSettings.analyticsConfig ?? null,
          siteVisibility: currentAdmin.siteSettings.siteVisibility,
        }
      : null);

  // 1. Validate ALL payloads BEFORE opening any DB write
  const validatedSite = validateSiteSettingsInput(rawSiteInput, siteValidationBase);
  const validatedProfile = validateBusinessProfileInput(rawProfileInput, baseProfile);

  // Enforce strict closed business category on merged profile as well (never ProfessionalService)
  const mergedCatCheck = validateClosedBusinessCategoryStrict(
    validatedProfile.businessCategory,
    "businessProfile.businessCategory",
  );
  if (!mergedCatCheck.ok) {
    throw new IdentityValidationError(mergedCatCheck.issue.message, [mergedCatCheck.issue]);
  }
  const canonicalProfile: BusinessProfileSnapshot = {
    ...validatedProfile,
    businessCategory: mergedCatCheck.definition.key,
  };

  const currentDraftExt = extensionFromRow(extra.structuredRow, "draft");
  const validatedExtRes = validateStructuredProfileExtension(
    extensionPatch,
    mode === "put" && input.businessProfile ? null : currentDraftExt,
  );
  if (!validatedExtRes.ok) {
    throw new IdentityValidationError(
      validatedExtRes.issues[0]?.message ?? "Data profil bisnis terstruktur tidak valid.",
      validatedExtRes.issues as readonly PublicationValidationField[],
    );
  }
  const nextExt = validatedExtRes.value;

  // 2. Verify every referenced brand media ID belongs to THIS tenant and is a ready image
  await verifyOwnedBrandMediaIds(tenantDb, {
    faviconMediaId: validatedSite.snapshot.faviconMediaId,
    ogImageMediaId: validatedSite.snapshot.ogImageMediaId,
    logoMediaId: validatedSite.brandAssets.logoMediaId,
    logoLightMediaId: validatedSite.brandAssets.logoLightMediaId,
    logoDarkMediaId: validatedSite.brandAssets.logoDarkMediaId,
  });

  // 3. Serialize canonical draft envelopes matching `packages/db/src/publication/index.ts`
  const serializedSiteDraft = serializeDraftStoragePayload("site_settings", validatedSite.snapshot);
  const enrichedSiteDraftJson = attachBrandAssetsToEnvelopeJson(
    serializedSiteDraft.json,
    validatedSite.brandAssets,
  );
  const serializedProfileDraft = serializeDraftStoragePayload(
    "business_profile",
    canonicalProfile,
  );

  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "owner";
  const auditMetadata = JSON.stringify({
    version: nextVersion,
    businessCategory: canonicalProfile.businessCategory,
    hasExtensionFields,
  });

  // 4. Execute ALL draft writes inside ONE single atomic `tenantDb.batch()`!
  // Statement 0 verifies ALL tables' exact expected versions BEFORE mutating a single row.
  // Every subsequent statement chains strictly on `changes() = 1`.
  const statements: D1PreparedStatement[] = [];

  if (extra.tablesPresent) {
    const extExistsFlag = extra.structuredRow ? 1 : 0;
    const bpExistsFlag = profileRow ? 1 : 0;

    if (!siteRow) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO site_settings (id, site_title, draft_json, version, updated_at)
             SELECT 1, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE id = 1)
               AND (
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?))
               )
               AND (
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1 AND version = ?))
               )`,
          )
          .bind(
            validatedSite.snapshot.siteTitle,
            enrichedSiteDraftJson,
            nextVersion,
            nowMs,
            bpExistsFlag,
            bpExistsFlag,
            bpVersion,
            extExistsFlag,
            extExistsFlag,
            extVersion,
          ),
      );
    } else {
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
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?))
               )
               AND (
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1 AND version = ?))
               )`,
          )
          .bind(
            enrichedSiteDraftJson,
            nextVersion,
            nowMs,
            ssVersion,
            bpExistsFlag,
            bpExistsFlag,
            bpVersion,
            extExistsFlag,
            extExistsFlag,
            extVersion,
          ),
      );
    }

    // Stmt 1: business_profile upsert chained on `changes() = 1`
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, draft_json, version, updated_at)
           SELECT 1, ?, ?, ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             draft_json = excluded.draft_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          canonicalProfile.businessName,
          canonicalProfile.businessCategory,
          serializedProfileDraft.json,
          nextVersion,
          nowMs,
        ),
    );

    // Stmt 2: business_profile_structured upsert chained on `changes() = 1`
    const extDraftJson = JSON.stringify(nextExt);
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO business_profile_structured (
             id, legal_name, privacy_contact, person_role_title, affiliated_org_name,
             closed_days_json, credentials_json, draft_json, published_json, version, updated_at
           )
           SELECT 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             legal_name = excluded.legal_name,
             privacy_contact = excluded.privacy_contact,
             person_role_title = excluded.person_role_title,
             affiliated_org_name = excluded.affiliated_org_name,
             closed_days_json = excluded.closed_days_json,
             credentials_json = excluded.credentials_json,
             draft_json = excluded.draft_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          nextExt.legalName,
          nextExt.privacyContact,
          nextExt.personRoleTitle,
          nextExt.affiliatedOrgName,
          JSON.stringify(nextExt.closedDays),
          JSON.stringify(nextExt.credentials),
          extDraftJson,
          nextVersion,
          nowMs,
        ),
    );

    // Stmt 3: brand_asset_derivations atomic upsert chained on `changes() = 1` (zero PK races!)
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO brand_asset_derivations (
             id, source_logo_media_id, favicon_override_media_id, og_image_override_media_id,
             derived_favicon_32_json, derived_apple_touch_180_json, derived_og_1200x630_json,
             version, updated_at
           )
           SELECT 1, ?, ?, ?, NULL, NULL, NULL, 1, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             source_logo_media_id = excluded.source_logo_media_id,
             favicon_override_media_id = excluded.favicon_override_media_id,
             og_image_override_media_id = excluded.og_image_override_media_id,
             version = brand_asset_derivations.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(
          validatedSite.brandAssets.logoMediaId,
          validatedSite.snapshot.faviconMediaId ?? null,
          validatedSite.snapshot.ogImageMediaId ?? null,
          nowMs,
        ),
    );

    // Stmt 4: atomic audit entry chained on `changes() = 1`
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'business_profile.draft_saved', 'business_profile', '1',
                  'Menyimpan draf profil bisnis terstruktur', ?, ?
           WHERE changes() = 1`,
        )
        .bind(actorUserId, actorRole, auditMetadata, nowMs),
    );
  } else {
    // Fallback when 0011 tables are not yet applied (legacy 0001 DB): still single atomic batch
    const bpExistsFlag = profileRow ? 1 : 0;
    if (!siteRow) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO site_settings (id, site_title, draft_json, version, updated_at)
             SELECT 1, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE id = 1)
               AND (
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?))
               )`,
          )
          .bind(
            validatedSite.snapshot.siteTitle,
            enrichedSiteDraftJson,
            nextVersion,
            nowMs,
            bpExistsFlag,
            bpExistsFlag,
            bpVersion,
          ),
      );
    } else {
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
                 (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile WHERE id = 1))
                 OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?))
               )`,
          )
          .bind(
            enrichedSiteDraftJson,
            nextVersion,
            nowMs,
            ssVersion,
            bpExistsFlag,
            bpExistsFlag,
            bpVersion,
          ),
      );
    }

    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, draft_json, version, updated_at)
           SELECT 1, ?, ?, ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             draft_json = excluded.draft_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          canonicalProfile.businessName,
          canonicalProfile.businessCategory,
          serializedProfileDraft.json,
          nextVersion,
          nowMs,
        ),
    );

    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'business_profile.draft_saved', 'business_profile', '1',
                  'Menyimpan draf identitas & profil bisnis', ?, ?
           WHERE changes() = 1`,
        )
        .bind(actorUserId, actorRole, auditMetadata, nowMs),
    );
  }

  const batchResults = await tenantDb.batch(statements);
  if (getStatementChanges(batchResults[0]) !== 1) {
    const latest = await getStructuredBusinessProfileForAdmin(tenantDb);
    throw new StaleRevisionError({
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion ?? currentUnifiedVersion,
      actualVersion: latest.version,
    });
  }

  return getStructuredBusinessProfileForAdmin(tenantDb);
}

/**
 * Atomically publishes ALL identity & structured profile tables (`site_settings`, `business_profile`,
 * `business_profile_structured`, `brand_asset_derivations`, `tenant_activity_log`) in ONE single
 * `tenantDb.batch()` BEFORE bumping `PLATFORM_DB.tenants.cache_version`.
 *
 * Cross-tier failure recovery: if `PLATFORM_DB.tenants.cache_version` bump fails, executes a single
 * chained `changes() = 1` compensation batch guarded on exact `(committedVersion, nowMs)` across ALL
 * touched tables so an interleaved writer is never half-reverted.
 */
export async function publishStructuredBusinessProfile(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: PublishStructuredBusinessProfileInput,
): Promise<PublishStructuredBusinessProfileResult> {
  const nowMs = input.nowMs ?? Date.now();
  const cleanTenantId = input.tenantId.trim();
  if (!cleanTenantId) {
    throw new IdentityValidationError("tenantId is required to publish business profile.", [
      { field: "tenantId", code: "REQUIRED", message: "tenantId is required." },
    ]);
  }

  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new IdentityValidationError("expectedVersion must be a non-negative integer.", [
        {
          field: "expectedVersion",
          code: "INVALID_VERSION",
          message: "expectedVersion must be a non-negative integer.",
        },
      ]);
    }
  }

  const [{ siteRow, profileRow }, currentAdmin, extra] = await Promise.all([
    fetchBaseIdentityRows(tenantDb),
    getSiteIdentityForAdmin(tenantDb),
    fetchStructuredTablesSafe(tenantDb),
  ]);

  if (!siteRow || !profileRow || !currentAdmin.siteSettings || !currentAdmin.businessProfile) {
    throw new IdentityValidationError(
      "Site identity must be saved before it can be published.",
      [
        {
          field: "identity",
          code: "IDENTITY_NOT_INITIALIZED",
          message: "Save site identity draft before publishing.",
        },
      ],
    );
  }

  const ssVersion = Number(siteRow.version);
  const bpVersion = Number(profileRow.version);
  const extVersion = extra.structuredRow ? Number(extra.structuredRow.version) : 0;
  const currentUnifiedVersion = Math.max(ssVersion, bpVersion, extVersion);

  if (input.expectedVersion !== undefined && input.expectedVersion !== currentUnifiedVersion) {
    throw new StaleRevisionError({
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentUnifiedVersion,
    });
  }

  const nextVersion = currentUnifiedVersion + 1;

  // 1. Re-validate drafts, closed category, credentials & media ownership BEFORE any DB write
  const draftSite = currentAdmin.siteSettings;
  const draftProfile = currentAdmin.businessProfile;
  const draftExt = extensionFromRow(extra.structuredRow, "draft");
  const brandAssets: BrandLogoAssets = {
    logoMediaId: draftSite.logoMediaId ?? null,
    logoLightMediaId: draftSite.logoLightMediaId ?? draftSite.logoMediaId ?? null,
    logoDarkMediaId: draftSite.logoDarkMediaId ?? null,
  };

  const validatedSite = validateSiteSettingsInput(
    {
      siteTitle: draftSite.siteTitle,
      tagline: draftSite.tagline ?? null,
      timezone: draftSite.timezone,
      locale: draftSite.locale,
      activeThemeId: draftSite.activeThemeId,
      faviconMediaId: draftSite.faviconMediaId ?? null,
      ogImageMediaId: draftSite.ogImageMediaId ?? null,
      logoMediaId: brandAssets.logoMediaId,
      logoLightMediaId: brandAssets.logoLightMediaId,
      logoDarkMediaId: brandAssets.logoDarkMediaId,
      blogEnabled: draftSite.blogEnabled,
      catalogEnabled: draftSite.catalogEnabled,
      aiTrainingPolicy: draftSite.aiTrainingPolicy,
      siteVisibility: draftSite.siteVisibility,
    },
    draftSite,
  );

  const catCheck = validateClosedBusinessCategoryStrict(
    draftProfile.businessCategory,
    "businessProfile.businessCategory",
  );
  if (!catCheck.ok) {
    throw new IdentityValidationError(catCheck.issue.message, [catCheck.issue]);
  }

  const validatedProfile = validateBusinessProfileInput(
    {
      businessName: draftProfile.businessName,
      businessCategory: catCheck.definition.key,
      description: draftProfile.description ?? null,
      address: draftProfile.address ?? null,
      city: draftProfile.city ?? null,
      province: draftProfile.province ?? null,
      postalCode: draftProfile.postalCode ?? null,
      latitude: draftProfile.latitude ?? null,
      longitude: draftProfile.longitude ?? null,
      mapsUrl: draftProfile.mapsUrl ?? null,
      weekdayHours: draftProfile.weekdayHours ?? null,
      holidayHours: draftProfile.holidayHours ?? null,
      serviceAreas: [...draftProfile.serviceAreas],
      whatsappE164: draftProfile.whatsappE164 ?? null,
      phone: draftProfile.phone ?? null,
      email: draftProfile.email ?? null,
      socialLinks: [...draftProfile.socialLinks],
    },
    draftProfile,
  );

  await verifyOwnedBrandMediaIds(tenantDb, {
    faviconMediaId: validatedSite.snapshot.faviconMediaId,
    ogImageMediaId: validatedSite.snapshot.ogImageMediaId,
    logoMediaId: brandAssets.logoMediaId,
    logoLightMediaId: brandAssets.logoLightMediaId,
    logoDarkMediaId: brandAssets.logoDarkMediaId,
  });

  // 2. Build canonical published snapshot envelopes (preserving existing published_at if set)
  const sitePublishedAt = siteRow.published_at ?? nowMs;
  const profilePublishedAt = profileRow.published_at ?? nowMs;

  const siteEnvelope = buildPublishedSnapshot("site_settings", validatedSite.snapshot, {
    publishedAt: sitePublishedAt,
    contentModifiedAt: nowMs,
  });
  const enrichedSitePublishedJson = attachBrandAssetsToEnvelopeJson(
    JSON.stringify(siteEnvelope),
    brandAssets,
  );

  const profileEnvelope = buildPublishedSnapshot("business_profile", validatedProfile, {
    publishedAt: profilePublishedAt,
    contentModifiedAt: nowMs,
  });
  const profilePublishedJson = JSON.stringify(profileEnvelope);

  const siteData: SiteSettingsSnapshot = siteEnvelope.data;
  const profileData: BusinessProfileSnapshot = profileEnvelope.data;
  const serializedExt = JSON.stringify(draftExt);
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "owner";
  const auditMeta = JSON.stringify({
    version: nextVersion,
    businessCategory: profileData.businessCategory,
  });

  // 3. Single atomic `tenantDb.batch()` promoting ALL tables BEFORE bumping PLATFORM_DB
  const extExistsFlag = extra.structuredRow ? 1 : 0;
  const publishStatements: D1PreparedStatement[] = [];

  if (extra.tablesPresent) {
    publishStatements.push(
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
               analytics_config_json = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = ?,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?)
             AND (
               (? = 0 AND NOT EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1))
               OR (? = 1 AND EXISTS (SELECT 1 FROM business_profile_structured WHERE id = 1 AND version = ?))
             )`,
        )
        .bind(
          siteData.siteTitle,
          siteData.tagline ?? null,
          siteData.timezone,
          siteData.locale,
          siteData.activeThemeId,
          siteData.faviconMediaId ?? null,
          siteData.ogImageMediaId ?? null,
          siteData.blogEnabled ? 1 : 0,
          siteData.catalogEnabled ? 1 : 0,
          siteData.aiTrainingPolicy,
          siteData.analyticsConfig ? JSON.stringify(siteData.analyticsConfig) : null,
          enrichedSitePublishedJson,
          sitePublishedAt,
          nowMs,
          nextVersion,
          nowMs,
          ssVersion,
          bpVersion,
          extExistsFlag,
          extExistsFlag,
          extVersion,
        ),
    );
  } else {
    publishStatements.push(
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
               analytics_config_json = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = ?,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND EXISTS (SELECT 1 FROM business_profile WHERE id = 1 AND version = ?)`,
        )
        .bind(
          siteData.siteTitle,
          siteData.tagline ?? null,
          siteData.timezone,
          siteData.locale,
          siteData.activeThemeId,
          siteData.faviconMediaId ?? null,
          siteData.ogImageMediaId ?? null,
          siteData.blogEnabled ? 1 : 0,
          siteData.catalogEnabled ? 1 : 0,
          siteData.aiTrainingPolicy,
          siteData.analyticsConfig ? JSON.stringify(siteData.analyticsConfig) : null,
          enrichedSitePublishedJson,
          sitePublishedAt,
          nowMs,
          nextVersion,
          nowMs,
          ssVersion,
          bpVersion,
        ),
    );
  }

  // Stmt 1: business_profile publish chained on `changes() = 1`
  publishStatements.push(
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
        profileData.businessName,
        profileData.businessCategory,
        profileData.description ?? null,
        profileData.address ?? null,
        profileData.city ?? null,
        profileData.province ?? null,
        profileData.postalCode ?? null,
        profileData.latitude ?? null,
        profileData.longitude ?? null,
        profileData.mapsUrl ?? null,
        profileData.weekdayHours ? JSON.stringify(profileData.weekdayHours) : null,
        profileData.holidayHours ? JSON.stringify(profileData.holidayHours) : null,
        JSON.stringify(profileData.serviceAreas),
        profileData.whatsappE164 ?? null,
        profileData.phone ?? null,
        profileData.email ?? null,
        JSON.stringify(profileData.socialLinks),
        profilePublishedJson,
        profilePublishedAt,
        nowMs,
        nextVersion,
        nowMs,
        bpVersion,
      ),
  );

  if (extra.tablesPresent) {
    // Stmt 2: business_profile_structured publish chained on `changes() = 1`
    publishStatements.push(
      tenantDb
        .prepare(
          `INSERT INTO business_profile_structured (
             id, legal_name, privacy_contact, person_role_title, affiliated_org_name,
             closed_days_json, credentials_json, draft_json, published_json, version, updated_at
           )
           SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             legal_name = excluded.legal_name,
             privacy_contact = excluded.privacy_contact,
             person_role_title = excluded.person_role_title,
             affiliated_org_name = excluded.affiliated_org_name,
             closed_days_json = excluded.closed_days_json,
             credentials_json = excluded.credentials_json,
             draft_json = excluded.draft_json,
             published_json = excluded.published_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .bind(
          draftExt.legalName,
          draftExt.privacyContact,
          draftExt.personRoleTitle,
          draftExt.affiliatedOrgName,
          JSON.stringify(draftExt.closedDays),
          JSON.stringify(draftExt.credentials),
          serializedExt,
          serializedExt,
          nextVersion,
          nowMs,
        ),
    );

    // Stmt 3: brand_asset_derivations override sync chained on `changes() = 1`
    publishStatements.push(
      tenantDb
        .prepare(
          `INSERT INTO brand_asset_derivations (
             id, source_logo_media_id, favicon_override_media_id, og_image_override_media_id,
             derived_favicon_32_json, derived_apple_touch_180_json, derived_og_1200x630_json,
             version, updated_at
           )
           SELECT 1, ?, ?, ?, NULL, NULL, NULL, 1, ?
           WHERE changes() = 1
           ON CONFLICT(id) DO UPDATE SET
             source_logo_media_id = excluded.source_logo_media_id,
             favicon_override_media_id = excluded.favicon_override_media_id,
             og_image_override_media_id = excluded.og_image_override_media_id,
             version = brand_asset_derivations.version + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(
          brandAssets.logoMediaId,
          siteData.faviconMediaId ?? null,
          siteData.ogImageMediaId ?? null,
          nowMs,
        ),
    );
  }

  // Final Stmt: atomic audit log chained on `changes() = 1`
  publishStatements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'business_profile.published', 'business_profile', '1',
                'Menerbitkan profil bisnis terstruktur', ?, ?
         WHERE changes() = 1`,
      )
      .bind(actorUserId, actorRole, auditMeta, nowMs),
  );

  const pubBatchRes = await tenantDb.batch(publishStatements);
  if (getStatementChanges(pubBatchRes[0]) !== 1) {
    const latest = await getStructuredBusinessProfileForAdmin(tenantDb);
    throw new StaleRevisionError({
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion ?? currentUnifiedVersion,
      actualVersion: latest.version,
    });
  }

  // 4. Bump PLATFORM_DB.tenants.cache_version; on ANY failure run chained `changes() = 1` compensation!
  let nextCacheVersion: number;
  try {
    const bumpRes = await platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(nowMs, cleanTenantId)
      .run();

    if (getStatementChanges(bumpRes) !== 1) {
      throw new Error(`Tenant "${cleanTenantId}" not found while bumping cache_version`);
    }

    const row = await platformDb
      .prepare("SELECT cache_version FROM tenants WHERE id = ? LIMIT 1")
      .bind(cleanTenantId)
      .first<{ readonly cache_version: number }>();
    if (!row || typeof row.cache_version !== "number") {
      throw new Error(`Failed to read updated cache_version for tenant "${cleanTenantId}"`);
    }
    nextCacheVersion = Number(row.cache_version);
    evictTenantFromCache(cleanTenantId);
  } catch (err) {
    let compensated: boolean;
    try {
      const compStatements: D1PreparedStatement[] = [
        // Stmt 0: guard on exact `(nextVersion, nowMs)` so an interleaved writer is NEVER half-reverted!
        tenantDb
          .prepare(
            `UPDATE site_settings
             SET site_title = ?, tagline = ?, timezone = ?, locale = ?,
                 active_theme_id = ?, favicon_media_id = ?, og_image_media_id = ?,
                 blog_enabled = ?, catalog_enabled = ?, ai_training_policy = ?,
                 analytics_config_json = ?, published_json = ?,
                 published_at = ?, content_modified_at = ?,
                 version = ?, updated_at = ?
             WHERE id = 1 AND version = ? AND updated_at = ?`,
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
            siteRow.analytics_config_json,
            siteRow.published_json,
            siteRow.published_at,
            siteRow.content_modified_at,
            siteRow.version,
            siteRow.updated_at,
            nextVersion,
            nowMs,
          ),
        // Stmt 1: restore business_profile chained on `changes() = 1` + exact `(nextVersion, nowMs)`
        tenantDb
          .prepare(
            `UPDATE business_profile
             SET business_name = ?, business_category = ?, description = ?,
                 address = ?, city = ?, province = ?, postal_code = ?,
                 latitude = ?, longitude = ?, maps_url = ?,
                 weekday_hours_json = ?, holiday_hours_json = ?, service_areas_json = ?,
                 whatsapp_e164 = ?, phone = ?, email = ?, social_links_json = ?,
                 published_json = ?, published_at = ?, content_modified_at = ?,
                 version = ?, updated_at = ?
             WHERE id = 1 AND version = ? AND updated_at = ? AND changes() = 1`,
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
            nextVersion,
            nowMs,
          ),
      ];

      if (extra.tablesPresent) {
        if (extra.structuredRow) {
          compStatements.push(
            tenantDb
              .prepare(
                `UPDATE business_profile_structured
                 SET legal_name = ?, privacy_contact = ?, person_role_title = ?,
                     affiliated_org_name = ?, closed_days_json = ?, credentials_json = ?,
                     draft_json = ?, published_json = ?, version = ?, updated_at = ?
                 WHERE id = 1 AND version = ? AND updated_at = ? AND changes() = 1`,
              )
              .bind(
                extra.structuredRow.legal_name,
                extra.structuredRow.privacy_contact,
                extra.structuredRow.person_role_title,
                extra.structuredRow.affiliated_org_name,
                extra.structuredRow.closed_days_json,
                extra.structuredRow.credentials_json,
                extra.structuredRow.draft_json,
                extra.structuredRow.published_json,
                extra.structuredRow.version,
                extra.structuredRow.updated_at,
                nextVersion,
                nowMs,
              ),
          );
        } else {
          compStatements.push(
            tenantDb
              .prepare(
                `DELETE FROM business_profile_structured
                 WHERE id = 1 AND version = ? AND updated_at = ? AND changes() = 1`,
              )
              .bind(nextVersion, nowMs),
          );
        }

        if (extra.brandRow) {
          compStatements.push(
            tenantDb
              .prepare(
                `UPDATE brand_asset_derivations
                 SET source_logo_media_id = ?, favicon_override_media_id = ?,
                     og_image_override_media_id = ?, version = ?, updated_at = ?
                 WHERE id = 1 AND updated_at = ? AND changes() = 1`,
              )
              .bind(
                extra.brandRow.source_logo_media_id,
                extra.brandRow.favicon_override_media_id,
                extra.brandRow.og_image_override_media_id,
                extra.brandRow.version,
                extra.brandRow.updated_at,
                nowMs,
              ),
          );
        } else {
          compStatements.push(
            tenantDb
              .prepare(
                `DELETE FROM brand_asset_derivations
                 WHERE id = 1 AND updated_at = ? AND changes() = 1`,
              )
              .bind(nowMs),
          );
        }
      }

      // Remove rolled-back publish audit entry chained on `changes() = 1`
      compStatements.push(
        tenantDb
          .prepare(
            `DELETE FROM tenant_activity_log
             WHERE action = 'business_profile.published'
               AND resource_type = 'business_profile'
               AND resource_id = '1'
               AND created_at = ?
               AND changes() = 1`,
          )
          .bind(nowMs),
      );

      const compRes = await tenantDb.batch(compStatements);
      compensated = getStatementChanges(compRes[0]) === 1;
    } catch {
      compensated = false;
    }

    throw new PublicationAtomicError(
      "Failed to bump PLATFORM_DB cache_version during structured business profile publish.",
      { compensated, cause: err },
    );
  }

  const freshBrand = await getBrandAssetDerivationState(tenantDb);
  const publishedAtIso = new Date(Math.max(sitePublishedAt, profilePublishedAt)).toISOString();

  return {
    tenantId: cleanTenantId,
    version: nextVersion,
    versions: {
      siteSettings: nextVersion,
      businessProfile: nextVersion,
      structuredExtension: extra.tablesPresent ? nextVersion : 0,
    },
    cacheVersion: nextCacheVersion,
    publishedAt: publishedAtIso,
    contentModifiedAt: new Date(nowMs).toISOString(),
    published: {
      siteSettings: {
        ...siteData,
        ...brandAssets,
      },
      businessProfile: enrichBusinessProfile(profileData, draftExt),
      brandAssets: freshBrand,
    },
    hasUnpublishedChanges: false,
  };
}

/**
 * Authoritative active logo resolution with strict draft-shadows-published precedence:
 * 1. `site_settings.draft_json` primary `logoMediaId` (unpublished draft strictly shadows published!)
 * 2. `site_settings.published_json` primary `logoMediaId` ONLY when draft has no logo
 * 3. `brand_asset_derivations.source_logo_media_id` ONLY when `site_settings` has no logo yet
 *
 * NEVER uses `OR` between draft and published so a stale published logo A can never overwrite
 * an unpublished draft logo B!
 */
const ACTIVE_LOGO_COALESCE_EXPR = `COALESCE(
  (SELECT COALESCE(
    json_extract(draft_json, '$._brandAssets.logoMediaId'),
    json_extract(draft_json, '$.data.logoMediaId'),
    json_extract(published_json, '$._brandAssets.logoMediaId'),
    json_extract(published_json, '$.data.logoMediaId')
  ) FROM site_settings WHERE id = 1),
  (SELECT source_logo_media_id FROM brand_asset_derivations WHERE id = 1)
)`;

/**
 * Race-safe persistence of auto-derived logo brand assets (`32x32` favicon, `180x180`
 * apple-touch-icon, `1200x630 <= 300 KiB` default OG image) in ONE atomic `tenantDb.batch()`.
 *
 * CRITICAL INVARIANTS:
 * 1. Guarded in SQL on `source_logo_media_id = ?` AND strict `COALESCE(draft, published)` active logo
 *    precedence so a stale job for published logo A finishing after switching draft to logo B is a 0-row no-op!
 * 2. Guarded in SQL on `favicon_override_media_id IS NULL` & `site_settings.favicon_media_id IS NULL`
 *    (and same for OG) so explicit tenant overrides are NEVER overwritten!
 * 3. `appliedFavicon` and `appliedOgImage` are computed STRICTLY from SQL `changes()` results.
 */
export async function applyAutoDerivedBrandAssets(
  tenantDb: D1Database,
  input: ApplyAutoDerivedBrandAssetsInput,
): Promise<ApplyAutoDerivedBrandAssetsResult> {
  const nowMs = input.nowMs ?? Date.now();
  const extra = await fetchStructuredTablesSafe(tenantDb);

  if (!extra.tablesPresent) {
    const adminIdentity = await getSiteIdentityForAdmin(tenantDb);
    const favOv = adminIdentity.siteSettings?.faviconMediaId ?? null;
    const ogOv = adminIdentity.siteSettings?.ogImageMediaId ?? null;
    return {
      appliedFavicon: false,
      appliedOgImage: false,
      preservedFaviconOverride: favOv !== null,
      preservedOgOverride: ogOv !== null,
      staleLogoSkipped: false,
      brandAssets: buildBrandAssetsDto(null, adminIdentity.siteSettings),
    };
  }

  const hasFaviconPayload = Boolean(input.favicon32) && Boolean(input.appleTouch180);
  const hasOgPayload = Boolean(input.og1200x630);

  const statements: D1PreparedStatement[] = [
    // Stmt 0: Insert singleton row ONLY when absent AND strict COALESCE active logo is NULL or matches
    tenantDb
      .prepare(
        `INSERT INTO brand_asset_derivations (
           id, source_logo_media_id, favicon_override_media_id, og_image_override_media_id,
           derived_favicon_32_json, derived_apple_touch_180_json, derived_og_1200x630_json,
           version, updated_at
         )
         SELECT 1, ?,
                (SELECT favicon_media_id FROM site_settings WHERE id = 1),
                (SELECT og_image_media_id FROM site_settings WHERE id = 1),
                NULL, NULL, NULL, 0, ?
         WHERE NOT EXISTS (SELECT 1 FROM brand_asset_derivations WHERE id = 1)
           AND (${ACTIVE_LOGO_COALESCE_EXPR} IS NULL OR ${ACTIVE_LOGO_COALESCE_EXPR} = ?)`,
      )
      .bind(input.sourceLogoMediaId, nowMs, input.sourceLogoMediaId),
  ];

  // Stmt 1: Guarded favicon derivation write (`source_logo_media_id = ?` + strict COALESCE + IS NULL override)
  let favStmtIdx = -1;
  if (hasFaviconPayload) {
    favStmtIdx = statements.length;
    statements.push(
      tenantDb
        .prepare(
          `UPDATE brand_asset_derivations
           SET source_logo_media_id = ?,
               derived_favicon_32_json = ?,
               derived_apple_touch_180_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1
             AND (source_logo_media_id = ? OR source_logo_media_id IS NULL)
             AND (${ACTIVE_LOGO_COALESCE_EXPR} IS NULL OR ${ACTIVE_LOGO_COALESCE_EXPR} = ?)
             AND favicon_override_media_id IS NULL
             AND COALESCE((SELECT favicon_media_id FROM site_settings WHERE id = 1), 0) = 0
             AND COALESCE(
               (SELECT json_extract(draft_json, '$.data.faviconMediaId') FROM site_settings WHERE id = 1),
               0
             ) = 0`,
        )
        .bind(
          input.sourceLogoMediaId,
          JSON.stringify(input.favicon32),
          JSON.stringify(input.appleTouch180),
          nowMs,
          input.sourceLogoMediaId,
          input.sourceLogoMediaId,
        ),
    );
  }

  // Stmt 2: Guarded OG derivation write (`source_logo_media_id = ?` + strict COALESCE + IS NULL override)
  let ogStmtIdx = -1;
  if (hasOgPayload) {
    ogStmtIdx = statements.length;
    statements.push(
      tenantDb
        .prepare(
          `UPDATE brand_asset_derivations
           SET source_logo_media_id = ?,
               derived_og_1200x630_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1
             AND (source_logo_media_id = ? OR source_logo_media_id IS NULL)
             AND (${ACTIVE_LOGO_COALESCE_EXPR} IS NULL OR ${ACTIVE_LOGO_COALESCE_EXPR} = ?)
             AND og_image_override_media_id IS NULL
             AND COALESCE((SELECT og_image_media_id FROM site_settings WHERE id = 1), 0) = 0
             AND COALESCE(
               (SELECT json_extract(draft_json, '$.data.ogImageMediaId') FROM site_settings WHERE id = 1),
               0
             ) = 0`,
        )
        .bind(
          input.sourceLogoMediaId,
          JSON.stringify(input.og1200x630),
          nowMs,
          input.sourceLogoMediaId,
          input.sourceLogoMediaId,
        ),
    );
  }

  const batchResults = await tenantDb.batch(statements);
  const appliedFavicon = favStmtIdx >= 0 && getStatementChanges(batchResults[favStmtIdx]) === 1;
  const appliedOgImage = ogStmtIdx >= 0 && getStatementChanges(batchResults[ogStmtIdx]) === 1;

  const refreshed = await getBrandAssetDerivationState(tenantDb);
  const preservedFaviconOverride = refreshed.faviconOverrideMediaId !== null;
  const preservedOgOverride = refreshed.ogImageOverrideMediaId !== null;

  const attemptedUnoverriddenFav = hasFaviconPayload && !preservedFaviconOverride;
  const attemptedUnoverriddenOg = hasOgPayload && !preservedOgOverride;
  const staleLogoSkipped =
    (attemptedUnoverriddenFav && !appliedFavicon) || (attemptedUnoverriddenOg && !appliedOgImage);

  return {
    appliedFavicon,
    appliedOgImage,
    preservedFaviconOverride,
    preservedOgOverride,
    staleLogoSkipped,
    brandAssets: refreshed,
  };
}

export {
  IdentityValidationError,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
};
