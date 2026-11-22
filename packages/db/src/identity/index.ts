import {
  assertNoForbiddenTenantSelectors,
  BusinessProfileSnapshotSchema,
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  SiteSettingsSnapshotSchema,
  StaleRevisionError,
  type BusinessProfileSnapshot,
  type PublicationValidationField,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "@punyasitus/core/link-sanitizer";
import {
  EmailSchema,
  NormalizedPhoneSchema,
  SequentialIdSchema,
  ThemeIdSchema,
} from "@punyasitus/core/schemas";
import {
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";
import {
  getDraftResourceForAdmin,
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
} from "../publication/index.ts";

/**
 * Per-Tenant Site Identity & Business Profile Repository (`packages/db/src/identity/index.ts`;
 * TASK-008, REQ-011, REQ-034, REQ-036, PLAN §5.2).
 *
 * Coordinates both singleton tables inside a tenant's physically isolated `TenantStore` DO:
 * - `site_settings` (`id = 1`) + brand logo media references (`logoMediaId`, `logoLightMediaId`, `logoDarkMediaId`)
 * - `business_profile` (`id = 1`)
 *
 * Guarantees:
 * - Strict validation of titles, business names, IANA timezone, locale, Schema.org category,
 *   Indonesian WhatsApp E.164 (`@punyasitus/core/wa-dispatcher`), business phone, email,
 *   and HTTPS-only Maps / social URLs (`@punyasitus/core/link-sanitizer`).
 * - Verifies every referenced media ID (`faviconMediaId`, `ogImageMediaId`, `logoMediaId`,
 *   `logoLightMediaId`, `logoDarkMediaId`) exists in THIS tenant's `TenantStore.media_items`
 *   with `kind = 'image'` and `status = 'ready'` (`422 MEDIA_NOT_FOUND` on missing/foreign/unready media).
 * - Enforces optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`) with zero side effects.
 * - Reuses `saveDraftResource` and `publishResourceAtomically` from `@punyasitus/db/publication/index`
 *   so draft edits NEVER leak to public readers and publishing atomically bumps both resource versions
 *   and `PLATFORM_DB.tenants.cache_version`.
 */

const SINGLETON_ID = 1 as const;
const MAX_SITE_TITLE_LEN = 120 as const;
const MAX_TAGLINE_LEN = 240 as const;
const MAX_BUSINESS_NAME_LEN = 160 as const;
const MAX_BUSINESS_CATEGORY_LEN = 80 as const;
const MAX_DESCRIPTION_LEN = 1000 as const;
const MAX_ADDRESS_LEN = 500 as const;
const MAX_CITY_PROVINCE_LEN = 120 as const;
const MAX_POSTAL_CODE_LEN = 20 as const;
const MAX_HOURS_LEN = 160 as const;
const MAX_SERVICE_AREAS = 20 as const;
const MAX_SERVICE_AREA_LEN = 80 as const;
const MAX_SOCIAL_LINKS = 10 as const;

export const ALLOWED_SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "linkedin",
  "x",
  "website",
] as const;
export type SocialPlatform = (typeof ALLOWED_SOCIAL_PLATFORMS)[number];

const SOCIAL_PLATFORM_SET: ReadonlySet<string> = new Set(ALLOWED_SOCIAL_PLATFORMS);

export const ALLOWED_AI_TRAINING_POLICIES = ["allow", "disallow"] as const;
export type AiTrainingPolicy = (typeof ALLOWED_AI_TRAINING_POLICIES)[number];

export const ALLOWED_SITE_VISIBILITIES = ["public", "noindex"] as const;
export type SiteVisibility = (typeof ALLOWED_SITE_VISIBILITIES)[number];

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

export const SITE_SETTINGS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "siteTitle",
  "tagline",
  "timezone",
  "locale",
  "activeThemeId",
  "faviconMediaId",
  "ogImageMediaId",
  "logoMediaId",
  "logoLightMediaId",
  "logoDarkMediaId",
  "blogEnabled",
  "catalogEnabled",
  "aiTrainingPolicy",
  "siteVisibility",
]);

export const BUSINESS_PROFILE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "businessName",
  "businessCategory",
  "description",
  "address",
  "city",
  "province",
  "postalCode",
  "latitude",
  "longitude",
  "mapsUrl",
  "weekdayHours",
  "holidayHours",
  "serviceAreas",
  "whatsappE164",
  "phone",
  "email",
  "socialLinks",
]);

export const IDENTITY_PATCH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "siteSettings",
  "businessProfile",
  "expectedVersion",
  "version",
  ...SITE_SETTINGS_ALLOWED_KEYS,
  ...BUSINESS_PROFILE_ALLOWED_KEYS,
]);

export class IdentityValidationError extends PublicationValidationError {
  constructor(message: string, fields: readonly PublicationValidationField[] = []) {
    super(message, fields);
    this.name = "IdentityValidationError";
  }
}

export interface BrandLogoAssets {
  readonly logoMediaId: number | null;
  readonly logoLightMediaId: number | null;
  readonly logoDarkMediaId: number | null;
}

export interface SiteSettingsIdentityData extends SiteSettingsSnapshot {
  readonly logoMediaId: number | null;
  readonly logoLightMediaId: number | null;
  readonly logoDarkMediaId: number | null;
}

export interface SiteIdentitySnapshot {
  readonly siteSettings: SiteSettingsIdentityData;
  readonly businessProfile: BusinessProfileSnapshot;
}

export interface SiteIdentityAdminDto {
  readonly siteSettings: SiteSettingsIdentityData | null;
  readonly businessProfile: BusinessProfileSnapshot | null;
  readonly draft: SiteIdentitySnapshot | null;
  readonly published: SiteIdentitySnapshot | null;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
  };
  readonly hasUnpublishedChanges: boolean;
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
  readonly updatedAt: string | null;
}

export interface PublishedSiteIdentityDto {
  readonly siteSettings: SiteSettingsIdentityData;
  readonly businessProfile: BusinessProfileSnapshot;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
  };
  readonly publishedAt: string | null;
  readonly contentModifiedAt: string | null;
}

export interface SaveSiteIdentityDraftInput {
  readonly siteSettings?: Record<string, unknown>;
  readonly businessProfile?: Record<string, unknown>;
  readonly expectedVersion?: number;
  readonly mode?: "put" | "patch";
  readonly nowMs?: number;
}

export interface PublishSiteIdentityInput {
  readonly tenantId: string;
  readonly expectedVersion?: number;
  readonly actorUserId?: string | null;
  readonly nowMs?: number;
}

export interface PublishSiteIdentityResult {
  readonly tenantId: string;
  readonly version: number;
  readonly versions: {
    readonly siteSettings: number;
    readonly businessProfile: number;
  };
  readonly cacheVersion: number;
  readonly publishedAt: string;
  readonly contentModifiedAt: string;
  readonly published: SiteIdentitySnapshot;
  readonly hasUnpublishedChanges: false;
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

// ---------------------------------------------------------------------------
// Pure Validation & Normalization Helpers (unit-testable without workerd)
// ---------------------------------------------------------------------------

function hasDisallowedControlChars(value: string, allowMultiline: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowMultiline && (code === 0x0a || code === 0x0d || code === 0x09)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function failValidation(
  message: string,
  field: string,
  code: string,
  detail?: string,
): never {
  throw new IdentityValidationError(message, [
    { field, code, message: detail ?? message },
  ]);
}

export function validateBoundedSingleLineText(
  value: unknown,
  field: string,
  options: {
    readonly required: boolean;
    readonly maxLength: number;
    readonly errorCode: string;
    readonly allowMultiline?: boolean;
  },
): string | null {
  if (value === null || value === undefined) {
    if (options.required) {
      failValidation(`${field} is required.`, field, options.errorCode);
    }
    return null;
  }
  if (typeof value !== "string") {
    failValidation(`${field} must be a string.`, field, options.errorCode);
  }
  if (hasDisallowedControlChars(value, options.allowMultiline ?? false)) {
    failValidation(
      `${field} must not contain control characters.`,
      field,
      options.errorCode,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (options.required) {
      failValidation(`${field} must not be empty.`, field, options.errorCode);
    }
    return null;
  }
  if (trimmed.length > options.maxLength) {
    failValidation(
      `${field} must be at most ${options.maxLength} characters.`,
      field,
      options.errorCode,
    );
  }
  return trimmed;
}

export function validateTimezone(value: unknown, field = "siteSettings.timezone"): string {
  const tz = validateBoundedSingleLineText(value, field, {
    required: true,
    maxLength: 64,
    errorCode: "INVALID_TIMEZONE",
  });
  if (!tz) {
    failValidation("timezone is required.", field, "INVALID_TIMEZONE");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    failValidation(`"${tz}" is not a valid IANA timezone.`, field, "INVALID_TIMEZONE");
  }
  return tz;
}

export function validateLocale(value: unknown, field = "siteSettings.locale"): string {
  const loc = validateBoundedSingleLineText(value, field, {
    required: true,
    maxLength: 16,
    errorCode: "INVALID_LOCALE",
  });
  if (!loc || !LOCALE_PATTERN.test(loc)) {
    failValidation(
      "locale must be a valid BCP-47 language tag (e.g. id-ID or en-US).",
      field,
      "INVALID_LOCALE",
    );
  }
  return loc;
}

export function validateNullableMediaId(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = SequentialIdSchema.safeParse(value);
  if (!parsed.success) {
    failValidation(
      `${field} must be a positive sequential integer media ID or null.`,
      field,
      "INVALID_MEDIA_ID",
    );
  }
  return parsed.data;
}

/**
 * Validates and normalizes an Indonesian WhatsApp number via `@punyasitus/core/wa-dispatcher`.
 */
export function validateIdentityWhatsApp(
  value: unknown,
  field = "businessProfile.whatsappE164",
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    failValidation("whatsappE164 must be a string or null.", field, "INVALID_WHATSAPP");
  }
  if (hasDisallowedControlChars(value, false)) {
    failValidation(
      "whatsappE164 must not contain control characters.",
      field,
      "INVALID_WHATSAPP",
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    return normalizeIndonesianWhatsAppNumber(trimmed);
  } catch (err) {
    const msg =
      err instanceof WhatsAppValidationError
        ? err.message
        : "Invalid Indonesian WhatsApp number.";
    failValidation(msg, field, "INVALID_WHATSAPP");
  }
}

/**
 * Validates and normalizes a general business phone number (Indonesian landline/mobile or E.164 digits).
 */
export function normalizeBusinessPhone(
  value: unknown,
  field = "businessProfile.phone",
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    failValidation("phone must be a string or null.", field, "INVALID_PHONE");
  }
  if (hasDisallowedControlChars(value, false)) {
    failValidation("phone must not contain control characters.", field, "INVALID_PHONE");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9+ ().-]+$/.test(trimmed)) {
    failValidation(
      "phone contains unsupported characters; only digits, leading +, and ordinary separators are allowed.",
      field,
      "INVALID_PHONE",
    );
  }

  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "(") depth += 1;
    else if (trimmed[i] === ")") {
      depth -= 1;
      if (depth < 0) failValidation("phone has unbalanced parentheses.", field, "INVALID_PHONE");
    }
  }
  if (depth !== 0) {
    failValidation("phone has unbalanced parentheses.", field, "INVALID_PHONE");
  }

  const plusCount = (trimmed.match(/\+/g) ?? []).length;
  if (plusCount > 1 || (plusCount === 1 && !/^\(?\+/.test(trimmed))) {
    failValidation("phone may only contain a single leading '+' sign.", field, "INVALID_PHONE");
  }

  const compact = trimmed.replace(/[ ().-]/g, "");
  let digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (!compact.startsWith("+") && digits.startsWith("0")) {
    digits = `62${digits.slice(1)}`;
  }

  const parsed = NormalizedPhoneSchema.safeParse(digits);
  if (!parsed.success) {
    failValidation(
      "phone must normalize to an 8-15 digit E.164/Indonesian phone number.",
      field,
      "INVALID_PHONE",
    );
  }
  return parsed.data;
}

/**
 * Validates and normalizes a brand contact email address.
 */
export function validateIdentityEmail(
  value: unknown,
  field = "businessProfile.email",
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    failValidation("email must be a string or null.", field, "INVALID_EMAIL");
  }
  if (hasDisallowedControlChars(value, false)) {
    failValidation("email must not contain control characters.", field, "INVALID_EMAIL");
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  const parsed = EmailSchema.safeParse(trimmed);
  if (!parsed.success) {
    failValidation("email must be a valid email address.", field, "INVALID_EMAIL");
  }
  return parsed.data;
}

/**
 * Validates and sanitizes an external HTTPS URL (`mapsUrl` or `socialLinks[].url`)
 * via `@punyasitus/core/link-sanitizer` (rejects `javascript:`, `http://`, private/local hosts, credentials).
 */
export function validateIdentityUrl(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    failValidation(`${field} must be a valid HTTPS URL string or null.`, field, "UNSAFE_URL");
  }
  if (hasDisallowedControlChars(value, false)) {
    failValidation(`${field} must not contain control characters.`, field, "UNSAFE_URL");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    return sanitizeExternalLink(trimmed).href;
  } catch (err) {
    const msg =
      err instanceof ExternalLinkValidationError
        ? err.message
        : `${field} must be a safe public HTTPS URL.`;
    failValidation(msg, field, "UNSAFE_URL");
  }
}

export function validateSocialLinks(
  value: unknown,
  field = "businessProfile.socialLinks",
): BusinessProfileSnapshot["socialLinks"] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    failValidation("socialLinks must be an array.", field, "INVALID_SOCIAL_LINKS");
  }
  if (value.length > MAX_SOCIAL_LINKS) {
    failValidation(
      `socialLinks cannot exceed ${MAX_SOCIAL_LINKS} items.`,
      field,
      "INVALID_SOCIAL_LINKS",
    );
  }

  const out: Array<{ platform: SocialPlatform; url: string }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const itemField = `${field}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failValidation("Each social link must be an object.", itemField, "INVALID_SOCIAL_LINKS");
    }
    const rec = entry as Record<string, unknown>;
    assertNoForbiddenSelectorsAsIdentityError(rec, itemField);

    for (const key of Object.keys(rec)) {
      if (key !== "platform" && key !== "url") {
        failValidation(
          `Unknown field "${key}" in social link.`,
          `${itemField}.${key}`,
          "UNKNOWN_FIELD",
        );
      }
    }

    const platform = typeof rec.platform === "string" ? rec.platform.trim().toLowerCase() : "";
    if (!SOCIAL_PLATFORM_SET.has(platform)) {
      failValidation(
        `Unsupported social platform "${String(rec.platform ?? "")}". Allowed: ${ALLOWED_SOCIAL_PLATFORMS.join(", ")}.`,
        `${itemField}.platform`,
        "INVALID_SOCIAL_PLATFORM",
      );
    }

    if (typeof rec.url !== "string" || rec.url.trim().length === 0) {
      failValidation(
        "Social link URL is required and must be a safe HTTPS URL.",
        `${itemField}.url`,
        "UNSAFE_URL",
      );
    }

    const safeUrl = validateIdentityUrl(rec.url, `${itemField}.url`);
    if (!safeUrl) {
      failValidation(
        "Social link URL is required and must be a safe HTTPS URL.",
        `${itemField}.url`,
        "UNSAFE_URL",
      );
    }

    out.push({ platform: platform as SocialPlatform, url: safeUrl });
  }

  return out;
}

function validateServiceAreas(
  value: unknown,
  field = "businessProfile.serviceAreas",
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    failValidation("serviceAreas must be an array of strings.", field, "INVALID_SERVICE_AREAS");
  }
  if (value.length > MAX_SERVICE_AREAS) {
    failValidation(
      `serviceAreas cannot exceed ${MAX_SERVICE_AREAS} entries.`,
      field,
      "INVALID_SERVICE_AREAS",
    );
  }
  const areas: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const cleaned = validateBoundedSingleLineText(value[i], `${field}[${i}]`, {
      required: true,
      maxLength: MAX_SERVICE_AREA_LEN,
      errorCode: "INVALID_SERVICE_AREAS",
    });
    if (cleaned) areas.push(cleaned);
  }
  return areas;
}

function validateCoordinatePair(
  latitude: unknown,
  longitude: unknown,
): { readonly latitude: number | null; readonly longitude: number | null } {
  const lat = latitude === undefined ? null : latitude;
  const lng = longitude === undefined ? null : longitude;

  if (lat !== null && (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90)) {
    failValidation(
      "latitude must be a finite number between -90 and 90.",
      "businessProfile.latitude",
      "INVALID_COORDINATES",
    );
  }
  if (lng !== null && (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180)) {
    failValidation(
      "longitude must be a finite number between -180 and 180.",
      "businessProfile.longitude",
      "INVALID_COORDINATES",
    );
  }
  if ((lat === null) !== (lng === null)) {
    failValidation(
      "latitude and longitude must either both be provided or both be null.",
      "businessProfile.latitude",
      "INVALID_COORDINATES",
    );
  }
  return {
    latitude: lat as number | null,
    longitude: lng as number | null,
  };
}

function assertNoForbiddenSelectorsAsIdentityError(value: unknown, pathPrefix = ""): void {
  try {
    assertNoForbiddenTenantSelectors(value, pathPrefix);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      throw new IdentityValidationError(err.message, err.fields);
    }
    throw err;
  }
}

function assertAllowedObjectKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
): void {
  assertNoForbiddenSelectorsAsIdentityError(obj, prefix);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      failValidation(
        `Unknown field "${key}" in ${prefix || "request body"}.`,
        prefix ? `${prefix}.${key}` : key,
        "UNKNOWN_FIELD",
      );
    }
  }
}

function resolveBrandLogoAssets(
  input: Record<string, unknown>,
  base: BrandLogoAssets,
): BrandLogoAssets {
  const hasLogo = Object.prototype.hasOwnProperty.call(input, "logoMediaId");
  const hasLight = Object.prototype.hasOwnProperty.call(input, "logoLightMediaId");
  const hasDark = Object.prototype.hasOwnProperty.call(input, "logoDarkMediaId");

  const nextLogo = hasLogo
    ? validateNullableMediaId(input.logoMediaId, "siteSettings.logoMediaId")
    : base.logoMediaId;
  const nextLight = hasLight
    ? validateNullableMediaId(input.logoLightMediaId, "siteSettings.logoLightMediaId")
    : base.logoLightMediaId;
  const nextDark = hasDark
    ? validateNullableMediaId(input.logoDarkMediaId, "siteSettings.logoDarkMediaId")
    : base.logoDarkMediaId;

  if (hasLogo && hasLight && nextLogo !== nextLight) {
    failValidation(
      "logoMediaId and logoLightMediaId must match when both are provided.",
      "siteSettings.logoMediaId",
      "CONFLICTING_LOGO_MEDIA_ID",
    );
  }

  let resolvedLogo = nextLogo;
  let resolvedLight = nextLight;
  if (hasLogo && !hasLight) {
    resolvedLight = nextLogo;
  } else if (!hasLogo && hasLight) {
    resolvedLogo = nextLight;
  }

  return {
    logoMediaId: resolvedLogo,
    logoLightMediaId: resolvedLight,
    logoDarkMediaId: nextDark,
  };
}

/**
 * Pure validator that merges & validates `siteSettings` input (including brand logo media IDs)
 * against a base state. Throws `IdentityValidationError` (422) on any violation.
 */
export function validateSiteSettingsInput(
  rawInput: Record<string, unknown>,
  base?: SiteSettingsIdentityData | null,
): {
  readonly snapshot: SiteSettingsSnapshot;
  readonly brandAssets: BrandLogoAssets;
  readonly full: SiteSettingsIdentityData;
} {
  assertAllowedObjectKeys(rawInput, SITE_SETTINGS_ALLOWED_KEYS, "siteSettings");

  const defaults: SiteSettingsIdentityData = base ?? {
    siteTitle: "",
    tagline: null,
    timezone: "Asia/Jakarta",
    locale: "id-ID",
    activeThemeId: "compro",
    faviconMediaId: null,
    ogImageMediaId: null,
    logoMediaId: null,
    logoLightMediaId: null,
    logoDarkMediaId: null,
    blogEnabled: true,
    catalogEnabled: true,
    aiTrainingPolicy: "allow",
    analyticsConfig: null,
    siteVisibility: "public",
  };

  const siteTitle = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "siteTitle")
      ? rawInput.siteTitle
      : defaults.siteTitle,
    "siteSettings.siteTitle",
    { required: true, maxLength: MAX_SITE_TITLE_LEN, errorCode: "INVALID_SITE_TITLE" },
  )!;

  const tagline = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "tagline")
      ? rawInput.tagline
      : defaults.tagline,
    "siteSettings.tagline",
    { required: false, maxLength: MAX_TAGLINE_LEN, errorCode: "INVALID_TAGLINE" },
  );

  const timezone = validateTimezone(
    Object.prototype.hasOwnProperty.call(rawInput, "timezone")
      ? rawInput.timezone
      : defaults.timezone,
    "siteSettings.timezone",
  );

  const locale = validateLocale(
    Object.prototype.hasOwnProperty.call(rawInput, "locale")
      ? rawInput.locale
      : defaults.locale,
    "siteSettings.locale",
  );

  const rawThemeId = Object.prototype.hasOwnProperty.call(rawInput, "activeThemeId")
    ? rawInput.activeThemeId
    : defaults.activeThemeId;
  const parsedThemeId = ThemeIdSchema.safeParse(rawThemeId);
  if (!parsedThemeId.success) {
    failValidation(
      "activeThemeId must be a valid registered theme ID.",
      "siteSettings.activeThemeId",
      "INVALID_THEME_ID",
    );
  }

  const faviconMediaId = Object.prototype.hasOwnProperty.call(rawInput, "faviconMediaId")
    ? validateNullableMediaId(rawInput.faviconMediaId, "siteSettings.faviconMediaId")
    : (defaults.faviconMediaId ?? null);

  const ogImageMediaId = Object.prototype.hasOwnProperty.call(rawInput, "ogImageMediaId")
    ? validateNullableMediaId(rawInput.ogImageMediaId, "siteSettings.ogImageMediaId")
    : (defaults.ogImageMediaId ?? null);

  const brandAssets = resolveBrandLogoAssets(rawInput, {
    logoMediaId: defaults.logoMediaId ?? null,
    logoLightMediaId: defaults.logoLightMediaId ?? defaults.logoMediaId ?? null,
    logoDarkMediaId: defaults.logoDarkMediaId ?? null,
  });

  const rawBlogEnabled = Object.prototype.hasOwnProperty.call(rawInput, "blogEnabled")
    ? rawInput.blogEnabled
    : defaults.blogEnabled;
  if (typeof rawBlogEnabled !== "boolean") {
    failValidation("blogEnabled must be a boolean.", "siteSettings.blogEnabled", "INVALID_BOOLEAN");
  }

  const rawCatalogEnabled = Object.prototype.hasOwnProperty.call(rawInput, "catalogEnabled")
    ? rawInput.catalogEnabled
    : defaults.catalogEnabled;
  if (typeof rawCatalogEnabled !== "boolean") {
    failValidation(
      "catalogEnabled must be a boolean.",
      "siteSettings.catalogEnabled",
      "INVALID_BOOLEAN",
    );
  }

  const rawAiPolicy = Object.prototype.hasOwnProperty.call(rawInput, "aiTrainingPolicy")
    ? rawInput.aiTrainingPolicy
    : defaults.aiTrainingPolicy;
  if (rawAiPolicy !== "allow" && rawAiPolicy !== "disallow") {
    failValidation(
      'aiTrainingPolicy must be "allow" or "disallow".',
      "siteSettings.aiTrainingPolicy",
      "INVALID_AI_TRAINING_POLICY",
    );
  }

  const rawVisibility = Object.prototype.hasOwnProperty.call(rawInput, "siteVisibility")
    ? rawInput.siteVisibility
    : defaults.siteVisibility;
  if (rawVisibility !== "public" && rawVisibility !== "noindex") {
    failValidation(
      'siteVisibility must be "public" or "noindex".',
      "siteSettings.siteVisibility",
      "INVALID_SITE_VISIBILITY",
    );
  }

  const snapshotInput: SiteSettingsSnapshot = {
    siteTitle,
    tagline,
    timezone,
    locale,
    activeThemeId: parsedThemeId.data,
    faviconMediaId,
    ogImageMediaId,
    blogEnabled: rawBlogEnabled,
    catalogEnabled: rawCatalogEnabled,
    aiTrainingPolicy: rawAiPolicy,
    analyticsConfig: defaults.analyticsConfig ?? null,
    siteVisibility: rawVisibility,
  };

  const validatedSnapshot = SiteSettingsSnapshotSchema.safeParse(snapshotInput);
  if (!validatedSnapshot.success) {
    throw new IdentityValidationError(
      "Invalid siteSettings payload.",
      validatedSnapshot.error.issues.map((issue) => ({
        field: `siteSettings.${issue.path.join(".")}`,
        code: issue.code.toUpperCase(),
        message: issue.message,
      })),
    );
  }

  return {
    snapshot: validatedSnapshot.data,
    brandAssets,
    full: {
      ...validatedSnapshot.data,
      ...brandAssets,
    },
  };
}

/**
 * Pure validator that merges & validates `businessProfile` input against a base state.
 * Throws `IdentityValidationError` (422) on any violation.
 */
export function validateBusinessProfileInput(
  rawInput: Record<string, unknown>,
  base?: BusinessProfileSnapshot | null,
): BusinessProfileSnapshot {
  assertAllowedObjectKeys(rawInput, BUSINESS_PROFILE_ALLOWED_KEYS, "businessProfile");

  const defaults: BusinessProfileSnapshot = base ?? {
    businessName: "",
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

  const businessName = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "businessName")
      ? rawInput.businessName
      : defaults.businessName,
    "businessProfile.businessName",
    { required: true, maxLength: MAX_BUSINESS_NAME_LEN, errorCode: "INVALID_BUSINESS_NAME" },
  )!;

  const businessCategory = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "businessCategory")
      ? rawInput.businessCategory
      : defaults.businessCategory,
    "businessProfile.businessCategory",
    {
      required: true,
      maxLength: MAX_BUSINESS_CATEGORY_LEN,
      errorCode: "INVALID_BUSINESS_CATEGORY",
    },
  )!;

  if (businessCategory === "ProfessionalService") {
    failValidation(
      "ProfessionalService is deprecated in Schema.org; use LocalBusiness or a valid subtype.",
      "businessProfile.businessCategory",
      "INVALID_BUSINESS_CATEGORY",
    );
  }

  const description = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "description")
      ? rawInput.description
      : defaults.description,
    "businessProfile.description",
    {
      required: false,
      maxLength: MAX_DESCRIPTION_LEN,
      errorCode: "INVALID_DESCRIPTION",
      allowMultiline: true,
    },
  );

  const address = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "address")
      ? rawInput.address
      : defaults.address,
    "businessProfile.address",
    {
      required: false,
      maxLength: MAX_ADDRESS_LEN,
      errorCode: "INVALID_ADDRESS",
      allowMultiline: true,
    },
  );

  const city = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "city") ? rawInput.city : defaults.city,
    "businessProfile.city",
    { required: false, maxLength: MAX_CITY_PROVINCE_LEN, errorCode: "INVALID_CITY" },
  );

  const province = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "province")
      ? rawInput.province
      : defaults.province,
    "businessProfile.province",
    { required: false, maxLength: MAX_CITY_PROVINCE_LEN, errorCode: "INVALID_PROVINCE" },
  );

  const postalCode = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "postalCode")
      ? rawInput.postalCode
      : defaults.postalCode,
    "businessProfile.postalCode",
    { required: false, maxLength: MAX_POSTAL_CODE_LEN, errorCode: "INVALID_POSTAL_CODE" },
  );

  const coords = validateCoordinatePair(
    Object.prototype.hasOwnProperty.call(rawInput, "latitude")
      ? rawInput.latitude
      : defaults.latitude,
    Object.prototype.hasOwnProperty.call(rawInput, "longitude")
      ? rawInput.longitude
      : defaults.longitude,
  );

  const mapsUrl = Object.prototype.hasOwnProperty.call(rawInput, "mapsUrl")
    ? validateIdentityUrl(rawInput.mapsUrl, "businessProfile.mapsUrl")
    : (defaults.mapsUrl ?? null);

  const weekdayHours = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "weekdayHours")
      ? rawInput.weekdayHours
      : defaults.weekdayHours,
    "businessProfile.weekdayHours",
    { required: false, maxLength: MAX_HOURS_LEN, errorCode: "INVALID_HOURS" },
  );

  const holidayHours = validateBoundedSingleLineText(
    Object.prototype.hasOwnProperty.call(rawInput, "holidayHours")
      ? rawInput.holidayHours
      : defaults.holidayHours,
    "businessProfile.holidayHours",
    { required: false, maxLength: MAX_HOURS_LEN, errorCode: "INVALID_HOURS" },
  );

  const serviceAreas = Object.prototype.hasOwnProperty.call(rawInput, "serviceAreas")
    ? validateServiceAreas(rawInput.serviceAreas, "businessProfile.serviceAreas")
    : [...defaults.serviceAreas];

  const whatsappE164 = Object.prototype.hasOwnProperty.call(rawInput, "whatsappE164")
    ? validateIdentityWhatsApp(rawInput.whatsappE164, "businessProfile.whatsappE164")
    : (defaults.whatsappE164 ?? null);

  const phone = Object.prototype.hasOwnProperty.call(rawInput, "phone")
    ? normalizeBusinessPhone(rawInput.phone, "businessProfile.phone")
    : (defaults.phone ?? null);

  const email = Object.prototype.hasOwnProperty.call(rawInput, "email")
    ? validateIdentityEmail(rawInput.email, "businessProfile.email")
    : (defaults.email ?? null);

  const socialLinks = Object.prototype.hasOwnProperty.call(rawInput, "socialLinks")
    ? validateSocialLinks(rawInput.socialLinks, "businessProfile.socialLinks")
    : [...defaults.socialLinks];

  const candidate: BusinessProfileSnapshot = {
    businessName,
    businessCategory,
    description,
    address,
    city,
    province,
    postalCode,
    latitude: coords.latitude,
    longitude: coords.longitude,
    mapsUrl,
    weekdayHours,
    holidayHours,
    serviceAreas,
    whatsappE164,
    phone,
    email,
    socialLinks,
  };

  const parsed = BusinessProfileSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new IdentityValidationError(
      "Invalid businessProfile payload.",
      parsed.error.issues.map((issue) => ({
        field: `businessProfile.${issue.path.join(".")}`,
        code: issue.code.toUpperCase(),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/**
 * Splits a top-level request body (either grouped `{ siteSettings, businessProfile }`
 * or flat identity fields) into normalized `siteSettings` and `businessProfile` patch objects.
 */
export function normalizeIdentityRequestPayload(body: Record<string, unknown>): {
  readonly siteSettingsPatch: Record<string, unknown>;
  readonly businessProfilePatch: Record<string, unknown>;
  readonly hasSiteSettingsFields: boolean;
  readonly hasBusinessProfileFields: boolean;
} {
  assertAllowedObjectKeys(body, IDENTITY_PATCH_ALLOWED_KEYS, "");

  const siteSettingsPatch: Record<string, unknown> = {};
  const businessProfilePatch: Record<string, unknown> = {};

  if (body.siteSettings !== undefined) {
    if (
      typeof body.siteSettings !== "object" ||
      body.siteSettings === null ||
      Array.isArray(body.siteSettings)
    ) {
      failValidation(
        "siteSettings must be a JSON object.",
        "siteSettings",
        "INVALID_IDENTITY_PAYLOAD",
      );
    }
    assertAllowedObjectKeys(
      body.siteSettings as Record<string, unknown>,
      SITE_SETTINGS_ALLOWED_KEYS,
      "siteSettings",
    );
    Object.assign(siteSettingsPatch, body.siteSettings);
  }

  if (body.businessProfile !== undefined) {
    if (
      typeof body.businessProfile !== "object" ||
      body.businessProfile === null ||
      Array.isArray(body.businessProfile)
    ) {
      failValidation(
        "businessProfile must be a JSON object.",
        "businessProfile",
        "INVALID_IDENTITY_PAYLOAD",
      );
    }
    assertAllowedObjectKeys(
      body.businessProfile as Record<string, unknown>,
      BUSINESS_PROFILE_ALLOWED_KEYS,
      "businessProfile",
    );
    Object.assign(businessProfilePatch, body.businessProfile);
  }

  // Also support flat top-level identity fields (cannot contradict grouped fields)
  for (const [key, value] of Object.entries(body)) {
    if (
      key === "siteSettings" ||
      key === "businessProfile" ||
      key === "expectedVersion" ||
      key === "version"
    ) {
      continue;
    }
    if (SITE_SETTINGS_ALLOWED_KEYS.has(key)) {
      if (Object.prototype.hasOwnProperty.call(siteSettingsPatch, key)) {
        failValidation(
          `Field "${key}" cannot be supplied both at top level and inside siteSettings.`,
          key,
          "DUPLICATE_FIELD",
        );
      }
      siteSettingsPatch[key] = value;
    } else if (BUSINESS_PROFILE_ALLOWED_KEYS.has(key)) {
      if (Object.prototype.hasOwnProperty.call(businessProfilePatch, key)) {
        failValidation(
          `Field "${key}" cannot be supplied both at top level and inside businessProfile.`,
          key,
          "DUPLICATE_FIELD",
        );
      }
      businessProfilePatch[key] = value;
    }
  }

  const hasSiteSettingsFields = Object.keys(siteSettingsPatch).length > 0;
  const hasBusinessProfileFields = Object.keys(businessProfilePatch).length > 0;

  if (!hasSiteSettingsFields && !hasBusinessProfileFields) {
    failValidation(
      "At least one siteSettings or businessProfile field must be provided.",
      "body",
      "EMPTY_IDENTITY_PATCH",
    );
  }

  return {
    siteSettingsPatch,
    businessProfilePatch,
    hasSiteSettingsFields,
    hasBusinessProfileFields,
  };
}

// ---------------------------------------------------------------------------
// Internal Envelope & TenantStore Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractBrandAssetsFromJson(rawJson: string | null | undefined): BrandLogoAssets {
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { logoMediaId: null, logoLightMediaId: null, logoDarkMediaId: null };
  }
  const envelope = parsed as Record<string, unknown>;
  const rawAssets = envelope._brandAssets;
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

function attachBrandAssetsToEnvelopeJson(
  rawJson: string | null,
  brandAssets: BrandLogoAssets,
): string | null {
  const parsed = safeJsonParse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawJson;
  }
  const next = {
    ...(parsed as Record<string, unknown>),
    _brandAssets: brandAssets,
  };
  return JSON.stringify(next);
}

function siteSettingsFromRawRow(row: RawSiteSettingsRow): SiteSettingsIdentityData {
  const parsedAnalytics = safeJsonParse(row.analytics_config_json);
  const analyticsConfig =
    parsedAnalytics && typeof parsedAnalytics === "object" && !Array.isArray(parsedAnalytics)
      ? (parsedAnalytics as SiteSettingsSnapshot["analyticsConfig"])
      : null;

  const baseSnapshot: SiteSettingsSnapshot = {
    siteTitle: row.site_title,
    tagline: row.tagline,
    timezone: row.timezone,
    locale: row.locale,
    activeThemeId: row.active_theme_id,
    faviconMediaId: row.favicon_media_id,
    ogImageMediaId: row.og_image_media_id,
    blogEnabled: Number(row.blog_enabled) === 1,
    catalogEnabled: Number(row.catalog_enabled) === 1,
    aiTrainingPolicy: row.ai_training_policy,
    analyticsConfig,
    siteVisibility: "public",
  };
  const brandAssets = extractBrandAssetsFromJson(row.draft_json ?? row.published_json);
  return {
    ...baseSnapshot,
    ...brandAssets,
  };
}

function businessProfileFromRawRow(row: RawBusinessProfileRow): BusinessProfileSnapshot {
  const parsedWeekday = safeJsonParse(row.weekday_hours_json);
  const parsedHoliday = safeJsonParse(row.holiday_hours_json);
  const parsedServiceAreas = safeJsonParse(row.service_areas_json);
  const parsedSocialLinks = safeJsonParse(row.social_links_json);

  return {
    businessName: row.business_name,
    businessCategory: row.business_category,
    description: row.description,
    address: row.address,
    city: row.city,
    province: row.province,
    postalCode: row.postal_code,
    latitude: row.latitude,
    longitude: row.longitude,
    mapsUrl: row.maps_url,
    weekdayHours:
      typeof parsedWeekday === "string" ? parsedWeekday : (row.weekday_hours_json ?? null),
    holidayHours:
      typeof parsedHoliday === "string" ? parsedHoliday : (row.holiday_hours_json ?? null),
    serviceAreas: Array.isArray(parsedServiceAreas) ? (parsedServiceAreas as string[]) : [],
    whatsappE164: row.whatsapp_e164,
    phone: row.phone,
    email: row.email,
    socialLinks: Array.isArray(parsedSocialLinks)
      ? (parsedSocialLinks as BusinessProfileSnapshot["socialLinks"])
      : [],
  };
}

async function fetchRawIdentityRows(tenantDb: D1Database): Promise<{
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

/**
 * Verifies every referenced brand media ID (`faviconMediaId`, `ogImageMediaId`, `logoMediaId`,
 * `logoLightMediaId`, `logoDarkMediaId`) exists inside THIS tenant's `TenantStore.media_items`
 * with `kind = 'image'` and `status = 'ready'`.
 *
 * Rejects missing, foreign (other tenant), failed, quarantined, or non-image media IDs with
 * `422 IdentityValidationError` carrying field code `MEDIA_NOT_FOUND`.
 */
export async function verifyOwnedBrandMediaIds(
  tenantDb: D1Database,
  refs: {
    readonly faviconMediaId?: number | null;
    readonly ogImageMediaId?: number | null;
    readonly logoMediaId?: number | null;
    readonly logoLightMediaId?: number | null;
    readonly logoDarkMediaId?: number | null;
  },
): Promise<void> {
  const checks: Array<{ readonly field: string; readonly mediaId: number }> = [];
  const entries: Array<readonly [string, number | null | undefined]> = [
    ["siteSettings.faviconMediaId", refs.faviconMediaId],
    ["siteSettings.ogImageMediaId", refs.ogImageMediaId],
    ["siteSettings.logoMediaId", refs.logoMediaId],
    ["siteSettings.logoLightMediaId", refs.logoLightMediaId],
    ["siteSettings.logoDarkMediaId", refs.logoDarkMediaId],
  ];

  const uniqueIds = new Set<number>();
  for (const [field, id] of entries) {
    if (id !== null && id !== undefined) {
      checks.push({ field, mediaId: id });
      uniqueIds.add(id);
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

  const validImageIds = new Set<number>();
  for (const row of res.results) {
    if (row.kind === "image" && row.status === "ready") {
      validImageIds.add(Number(row.id));
    }
  }

  const missingFields: PublicationValidationField[] = [];
  for (const check of checks) {
    if (!validImageIds.has(check.mediaId)) {
      missingFields.push({
        field: check.field,
        code: "MEDIA_NOT_FOUND",
        message: `Media #${check.mediaId} does not exist as a ready image in this tenant's media library.`,
      });
    }
  }

  if (missingFields.length > 0) {
    throw new IdentityValidationError(
      "One or more referenced brand media items were not found in this tenant.",
      missingFields,
    );
  }
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function computeUnifiedVersion(
  siteRow: RawSiteSettingsRow | null,
  profileRow: RawBusinessProfileRow | null,
): number {
  const ssVer = siteRow ? Number(siteRow.version) : 0;
  const bpVer = profileRow ? Number(profileRow.version) : 0;
  return Math.max(ssVer, bpVer);
}

// ---------------------------------------------------------------------------
// Public & Admin Repository Operations
// ---------------------------------------------------------------------------

/**
 * Public-safe loader returning ONLY the validated published site identity & business profile.
 * Strictly returns `null` when unpublished and NEVER reads `draft_json` or leaks draft edits.
 */
export async function getPublishedSiteIdentity(
  tenantDb: D1Database,
): Promise<PublishedSiteIdentityDto | null> {
  const [pubSite, pubProfile, siteMetaRow] = await Promise.all([
    getPublishedResource(tenantDb, { resourceType: "site_settings", resourceId: SINGLETON_ID }),
    getPublishedResource(tenantDb, { resourceType: "business_profile", resourceId: SINGLETON_ID }),
    tenantDb
      .prepare("SELECT published_json FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly published_json: string | null }>(),
  ]);

  if (!pubSite || !pubProfile) {
    return null;
  }

  const brandAssets = extractBrandAssetsFromJson(siteMetaRow?.published_json);
  const publishedAtMs = Math.max(pubSite.publishedAt ?? 0, pubProfile.publishedAt ?? 0);
  const contentModifiedAtMs = Math.max(
    pubSite.contentModifiedAt ?? 0,
    pubProfile.contentModifiedAt ?? 0,
  );

  return {
    siteSettings: {
      ...pubSite.data,
      ...brandAssets,
    },
    businessProfile: pubProfile.data,
    version: Math.max(pubSite.version, pubProfile.version),
    versions: {
      siteSettings: pubSite.version,
      businessProfile: pubProfile.version,
    },
    publishedAt: toIsoOrNull(publishedAtMs),
    contentModifiedAt: toIsoOrNull(contentModifiedAtMs),
  };
}

/**
 * Admin loader returning separated draft and published identity states for the scoped tenant.
 * MUST ONLY be called behind verified tenant-member authorization (never public routes).
 */
export async function getSiteIdentityForAdmin(
  tenantDb: D1Database,
): Promise<SiteIdentityAdminDto> {
  const [{ siteRow, profileRow }, adminSite, adminProfile] = await Promise.all([
    fetchRawIdentityRows(tenantDb),
    getDraftResourceForAdmin(tenantDb, { resourceType: "site_settings", resourceId: SINGLETON_ID }),
    getDraftResourceForAdmin(tenantDb, {
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
    }),
  ]);

  const ssVersion = siteRow ? Number(siteRow.version) : 0;
  const bpVersion = profileRow ? Number(profileRow.version) : 0;
  const version = Math.max(ssVersion, bpVersion);

  const draftBrandAssets = extractBrandAssetsFromJson(siteRow?.draft_json);
  const publishedBrandAssets = extractBrandAssetsFromJson(siteRow?.published_json);

  const draftSite: SiteSettingsIdentityData | null = adminSite?.draft
    ? { ...adminSite.draft, ...draftBrandAssets }
    : siteRow
      ? siteSettingsFromRawRow(siteRow)
      : null;

  const publishedSite: SiteSettingsIdentityData | null = adminSite?.published
    ? { ...adminSite.published, ...publishedBrandAssets }
    : null;

  const draftProfile: BusinessProfileSnapshot | null =
    adminProfile?.draft ?? (profileRow ? businessProfileFromRawRow(profileRow) : null);
  const publishedProfile: BusinessProfileSnapshot | null = adminProfile?.published ?? null;

  const draft: SiteIdentitySnapshot | null =
    draftSite && draftProfile
      ? { siteSettings: draftSite, businessProfile: draftProfile }
      : null;

  const published: SiteIdentitySnapshot | null =
    publishedSite && publishedProfile
      ? { siteSettings: publishedSite, businessProfile: publishedProfile }
      : null;

  const hasUnpublishedChanges =
    draft !== null &&
    (published === null || JSON.stringify(draft) !== JSON.stringify(published));

  const publishedAtMs = Math.max(
    adminSite?.publishedAt ?? 0,
    adminProfile?.publishedAt ?? 0,
  );
  const contentModifiedAtMs = Math.max(
    adminSite?.contentModifiedAt ?? 0,
    adminProfile?.contentModifiedAt ?? 0,
  );
  const updatedAtMs = Math.max(
    siteRow ? Number(siteRow.updated_at) : 0,
    profileRow ? Number(profileRow.updated_at) : 0,
  );

  return {
    siteSettings: draftSite,
    businessProfile: draftProfile,
    draft,
    published,
    version,
    versions: {
      siteSettings: ssVersion,
      businessProfile: bpVersion,
    },
    hasUnpublishedChanges,
    publishedAt: toIsoOrNull(publishedAtMs),
    contentModifiedAt: toIsoOrNull(contentModifiedAtMs),
    updatedAt: toIsoOrNull(updatedAtMs),
  };
}

/**
 * Validates and saves draft updates to `site_settings` and `business_profile` using
 * `saveDraftResource` from `@punyasitus/db/publication/index`.
 *
 * Isolation guarantee: NEVER mutates `published_json`, `published_at`, `content_modified_at`,
 * or `PLATFORM_DB.tenants.cache_version`. Draft edits remain strictly private until published.
 */
export async function saveSiteIdentityDraft(
  tenantDb: D1Database,
  input: SaveSiteIdentityDraftInput,
): Promise<SiteIdentityAdminDto> {
  const nowMs = input.nowMs ?? Date.now();
  const mode = input.mode ?? "patch";

  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      failValidation(
        "expectedVersion must be a non-negative integer.",
        "expectedVersion",
        "INVALID_VERSION",
      );
    }
  }

  const [{ siteRow, profileRow }, currentAdmin] = await Promise.all([
    fetchRawIdentityRows(tenantDb),
    getSiteIdentityForAdmin(tenantDb),
  ]);

  const currentVersion = computeUnifiedVersion(siteRow, profileRow);
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentVersion,
    });
  }

  const rawSiteInput: Record<string, unknown> = { ...(input.siteSettings ?? {}) };
  const rawProfileInput: Record<string, unknown> = { ...(input.businessProfile ?? {}) };

  const baseSite = mode === "put" && input.siteSettings ? null : currentAdmin.siteSettings;
  const baseProfile =
    mode === "put" && input.businessProfile ? null : currentAdmin.businessProfile;

  // Cross-seed initial title/businessName when initializing a brand-new tenant from one side only.
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

  // Preserve existing analyticsConfig on PUT so identity edits cannot wipe analytics setup
  const siteValidationBase =
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
          blogEnabled: true,
          catalogEnabled: true,
          aiTrainingPolicy: "allow" as const,
          analyticsConfig: currentAdmin.siteSettings.analyticsConfig ?? null,
          siteVisibility: "public" as const,
        }
      : null);

  // 1. Validate both payloads BEFORE any database mutation
  const validatedSite = validateSiteSettingsInput(rawSiteInput, siteValidationBase);
  const validatedProfile = validateBusinessProfileInput(rawProfileInput, baseProfile);

  // 2. Verify all referenced media IDs exist in THIS tenant's media_items (422 MEDIA_NOT_FOUND)
  await verifyOwnedBrandMediaIds(tenantDb, {
    faviconMediaId: validatedSite.snapshot.faviconMediaId,
    ogImageMediaId: validatedSite.snapshot.ogImageMediaId,
    logoMediaId: validatedSite.brandAssets.logoMediaId,
    logoLightMediaId: validatedSite.brandAssets.logoLightMediaId,
    logoDarkMediaId: validatedSite.brandAssets.logoDarkMediaId,
  });

  // 3. Ensure singleton rows exist at version=0 when uninitialized (strictly without touching published_json)
  let insertedSiteBaseline = false;
  let insertedProfileBaseline = false;
  const ssExpectedVersion = siteRow ? Number(siteRow.version) : 0;
  const bpExpectedVersion = profileRow ? Number(profileRow.version) : 0;

  if (!siteRow) {
    try {
      await tenantDb
        .prepare(
          `INSERT INTO site_settings (id, site_title, version, updated_at)
           VALUES (1, ?, 0, ?)`,
        )
        .bind(validatedSite.snapshot.siteTitle, nowMs)
        .run();
      insertedSiteBaseline = true;
    } catch {
      const latest = await fetchRawIdentityRows(tenantDb);
      throw new StaleRevisionError({
        resourceType: "site_settings",
        resourceId: SINGLETON_ID,
        expectedVersion: input.expectedVersion ?? 0,
        actualVersion: computeUnifiedVersion(latest.siteRow, latest.profileRow),
      });
    }
  }

  if (!profileRow) {
    try {
      await tenantDb
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
           VALUES (1, ?, ?, 0, ?)`,
        )
        .bind(validatedProfile.businessName, validatedProfile.businessCategory, nowMs)
        .run();
      insertedProfileBaseline = true;
    } catch {
      if (insertedSiteBaseline) {
        await tenantDb.prepare("DELETE FROM site_settings WHERE id = 1 AND version = 0").run();
      }
      const latest = await fetchRawIdentityRows(tenantDb);
      throw new StaleRevisionError({
        resourceType: "business_profile",
        resourceId: SINGLETON_ID,
        expectedVersion: input.expectedVersion ?? 0,
        actualVersion: computeUnifiedVersion(latest.siteRow, latest.profileRow),
      });
    }
  }

  // 4. Persist validated drafts via canonical `saveDraftResource` (with compensation on partial race)
  let siteSavedVersion: number | null = null;
  try {
    const ssSaved = await saveDraftResource(tenantDb, {
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: ssExpectedVersion,
      draft: validatedSite.snapshot,
      nowMs,
    });
    siteSavedVersion = ssSaved.version;

    // Persist brand logo media IDs onto the draft envelope without leaking to published_json
    const updatedSiteRow = await tenantDb
      .prepare("SELECT draft_json FROM site_settings WHERE id = 1 AND version = ? LIMIT 1")
      .bind(ssSaved.version)
      .first<{ readonly draft_json: string | null }>();
    const enrichedDraftJson = attachBrandAssetsToEnvelopeJson(
      updatedSiteRow?.draft_json ?? null,
      validatedSite.brandAssets,
    );
    if (enrichedDraftJson !== null) {
      await tenantDb
        .prepare("UPDATE site_settings SET draft_json = ? WHERE id = 1 AND version = ?")
        .bind(enrichedDraftJson, ssSaved.version)
        .run();
    }

    await saveDraftResource(tenantDb, {
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: bpExpectedVersion,
      draft: validatedProfile,
      nowMs,
    });
  } catch (err) {
    // Compensate site_settings if business_profile save raced or failed
    try {
      if (insertedSiteBaseline) {
        await tenantDb.prepare("DELETE FROM site_settings WHERE id = 1").run();
      } else if (siteRow && siteSavedVersion !== null) {
        await tenantDb
          .prepare(
            `UPDATE site_settings
             SET draft_json = ?, version = ?, updated_at = ?
             WHERE id = 1 AND version = ?`,
          )
          .bind(siteRow.draft_json, siteRow.version, siteRow.updated_at, siteSavedVersion)
          .run();
      }
      if (insertedProfileBaseline) {
        await tenantDb
          .prepare("DELETE FROM business_profile WHERE id = 1 AND version = 0")
          .run();
      }
    } catch {
      // Best-effort compensation; rethrow original error
    }
    throw err;
  }

  return getSiteIdentityForAdmin(tenantDb);
}

/**
 * Atomically publishes the tenant's current draft identity (`site_settings` + `business_profile`)
 * using `publishResourceAtomically` from `@punyasitus/db/publication/index`.
 *
 * Guarantees:
 * - Rejects stale `expectedVersion` with `409 STALE_VERSION` without mutating DB or `cache_version`.
 * - Re-verifies every referenced brand media ID in THIS tenant's `media_items` before publishing
 *   (`422 MEDIA_NOT_FOUND` on missing/foreign/deleted media).
 * - Atomically updates published snapshots, increments resource versions, AND bumps
 *   `PLATFORM_DB.tenants.cache_version` (with fail-closed compensation on cross-tier failure).
 */
export async function publishSiteIdentity(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: PublishSiteIdentityInput,
): Promise<PublishSiteIdentityResult> {
  const nowMs = input.nowMs ?? Date.now();
  const cleanTenantId = input.tenantId.trim();
  if (!cleanTenantId) {
    failValidation("tenantId is required to publish site identity.", "tenantId", "REQUIRED");
  }

  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      failValidation(
        "expectedVersion must be a non-negative integer.",
        "expectedVersion",
        "INVALID_VERSION",
      );
    }
  }

  const [{ siteRow, profileRow }, currentAdmin] = await Promise.all([
    fetchRawIdentityRows(tenantDb),
    getSiteIdentityForAdmin(tenantDb),
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

  const currentVersion = computeUnifiedVersion(siteRow, profileRow);
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: SINGLETON_ID,
      expectedVersion: input.expectedVersion,
      actualVersion: currentVersion,
    });
  }

  // Re-validate draft & media ownership BEFORE mutating either table or PLATFORM_DB
  const draftSite = currentAdmin.siteSettings;
  const draftProfile = currentAdmin.businessProfile;
  const brandAssets: BrandLogoAssets = {
    logoMediaId: draftSite.logoMediaId ?? null,
    logoLightMediaId: draftSite.logoLightMediaId ?? draftSite.logoMediaId ?? null,
    logoDarkMediaId: draftSite.logoDarkMediaId ?? null,
  };

  validateSiteSettingsInput(
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

  validateBusinessProfileInput(
    {
      businessName: draftProfile.businessName,
      businessCategory: draftProfile.businessCategory,
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
    faviconMediaId: draftSite.faviconMediaId,
    ogImageMediaId: draftSite.ogImageMediaId,
    logoMediaId: brandAssets.logoMediaId,
    logoLightMediaId: brandAssets.logoLightMediaId,
    logoDarkMediaId: brandAssets.logoDarkMediaId,
  });

  // Atomically publish site_settings and business_profile via publication engine
  const sitePub = await publishResourceAtomically(platformDb, tenantDb, {
    tenantId: cleanTenantId,
    resourceType: "site_settings",
    resourceId: SINGLETON_ID,
    expectedVersion: Number(siteRow.version),
    actorUserId: input.actorUserId ?? null,
    nowMs,
  });

  // Copy validated brand logo assets onto the newly published envelope
  const publishedSiteRow = await tenantDb
    .prepare("SELECT published_json FROM site_settings WHERE id = 1 AND version = ? LIMIT 1")
    .bind(sitePub.version)
    .first<{ readonly published_json: string | null }>();
  const enrichedPublishedJson = attachBrandAssetsToEnvelopeJson(
    publishedSiteRow?.published_json ?? null,
    brandAssets,
  );
  if (enrichedPublishedJson !== null) {
    await tenantDb
      .prepare("UPDATE site_settings SET published_json = ? WHERE id = 1 AND version = ?")
      .bind(enrichedPublishedJson, sitePub.version)
      .run();
  }

  let profilePub;
  try {
    profilePub = await publishResourceAtomically(platformDb, tenantDb, {
      tenantId: cleanTenantId,
      resourceType: "business_profile",
      resourceId: SINGLETON_ID,
      expectedVersion: Number(profileRow.version),
      actorUserId: input.actorUserId ?? null,
      nowMs,
    });
  } catch (err) {
    // Compensate site_settings back to prior row if business_profile publish failed
    try {
      await tenantDb
        .prepare(
          `UPDATE site_settings
           SET site_title = ?, tagline = ?, timezone = ?, locale = ?,
               active_theme_id = ?, favicon_media_id = ?, og_image_media_id = ?,
               blog_enabled = ?, catalog_enabled = ?, ai_training_policy = ?,
               analytics_config_json = ?, published_json = ?,
               published_at = ?, content_modified_at = ?,
               version = ?, updated_at = ?
           WHERE id = 1 AND version = ?`,
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
          sitePub.version,
        )
        .run();
    } catch {
      // Best-effort rollback
    }
    throw err;
  }

  return {
    tenantId: cleanTenantId,
    version: Math.max(sitePub.version, profilePub.version),
    versions: {
      siteSettings: sitePub.version,
      businessProfile: profilePub.version,
    },
    cacheVersion: profilePub.cacheVersion,
    publishedAt: new Date(Math.max(sitePub.publishedAt, profilePub.publishedAt)).toISOString(),
    contentModifiedAt: new Date(
      Math.max(sitePub.contentModifiedAt, profilePub.contentModifiedAt),
    ).toISOString(),
    published: {
      siteSettings: {
        ...sitePub.publishedSnapshot.data,
        ...brandAssets,
      },
      businessProfile: profilePub.publishedSnapshot.data,
    },
    hasUnpublishedChanges: false,
  };
}

export {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
};
