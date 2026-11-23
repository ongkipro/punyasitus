import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  type BusinessProfileSnapshot,
  type MenuSnapshot,
  type PublicationValidationField,
  type SiteSettingsSnapshot,
} from "../content/index.ts";
import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "../link-sanitizer.ts";
import {
  EmailSchema,
  OfferingTypeSchema,
  SequentialIdSchema,
  type OfferingType,
} from "../schemas/common.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "../wa-dispatcher.ts";
import { validateGoogleMapsReviewUrl } from "./google-maps-review.ts";

/**
 * Grouped Tenant Settings & Public Defaults Core Contract (`packages/core/src/settings/index.ts`;
 * TASK-040, REQ-044, REQ-011, REQ-026, REQ-034, REQ-036, REQ-039; PLAN §11.2 & §15).
 *
 * Runtime-neutral validation, group field allowlists, timezone/date-only formatting helpers,
 * public navigation/route filtering helpers, and envelope metadata serialization.
 * Zero DB bindings, secrets, or provider clients.
 */

export const SETTINGS_GROUPS = [
  "general",
  "business",
  "reading",
  "seo",
  "privacy",
  "analytics",
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const EDITABLE_GROUPED_SETTINGS_TABS = [
  "general",
  "business",
  "reading",
  "seo",
  "privacy",
] as const;
export type EditableSettingsTab = (typeof EDITABLE_GROUPED_SETTINGS_TABS)[number];

const SETTINGS_GROUP_SET: ReadonlySet<string> = new Set(SETTINGS_GROUPS);

export function isSettingsGroup(value: string): value is SettingsGroup {
  return SETTINGS_GROUP_SET.has(value);
}

export const ALLOWED_ITEMS_PER_PAGE = [6, 12, 24] as const;
export type ItemsPerPageOption = (typeof ALLOWED_ITEMS_PER_PAGE)[number];

export const ALL_OFFERING_TYPES: readonly OfferingType[] = [
  "service",
  "product",
  "tour",
  "vehicle",
] as const;

export const FIXED_PUBLIC_ROUTES = {
  blog: "/blog",
  offerings: {
    service: "/layanan",
    product: "/produk",
    tour: "/tour",
    vehicle: "/kendaraan",
  },
} as const satisfies {
  readonly blog: string;
  readonly offerings: Readonly<Record<OfferingType, string>>;
};

export const RESERVED_PUBLIC_ROOT_SLUGS: ReadonlySet<string> = new Set([
  "blog",
  "layanan",
  "produk",
  "tour",
  "kendaraan",
  "api",
  "sitemaps",
  "sitemap.xml",
  "robots.txt",
  "dashboard",
  "console",
  "agency",
  "affiliate",
  "auth",
  "account",
  "pay",
  "mcp",
  "oauth2",
]);

/**
 * Closed Schema.org business category allowlist (PLAN §5.2 & §11.2).
 * Explicitly excludes deprecated `ProfessionalService`.
 */
export const ALLOWED_BUSINESS_CATEGORIES = [
  "LocalBusiness",
  "Organization",
  "TravelAgency",
  "Restaurant",
  "AutoDealer",
  "MedicalClinic",
  "LegalService",
  "AccountingService",
  "EducationalOrganization",
  "HomeAndConstructionBusiness",
  "Store",
  "RealEstateAgent",
  "FinancialService",
  "SportsActivityLocation",
  "HealthAndBeautyBusiness",
  "LodgingBusiness",
] as const;
export type AllowedBusinessCategory = (typeof ALLOWED_BUSINESS_CATEGORIES)[number];

const BUSINESS_CATEGORY_SET: ReadonlySet<string> = new Set(ALLOWED_BUSINESS_CATEGORIES);

export const ALLOWED_SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "linkedin",
  "x",
  "website",
] as const;
export type SettingsSocialPlatform = (typeof ALLOWED_SOCIAL_PLATFORMS)[number];
const SOCIAL_PLATFORM_SET: ReadonlySet<string> = new Set(ALLOWED_SOCIAL_PLATFORMS);

export const RECOMMENDED_INDONESIAN_TIMEZONES = [
  { value: "Asia/Jakarta", label: "WIB — Asia/Jakarta (UTC+7)" },
  { value: "Asia/Makassar", label: "WITA — Asia/Makassar (UTC+8)" },
  { value: "Asia/Jayapura", label: "WIT — Asia/Jayapura (UTC+9)" },
  { value: "Asia/Singapore", label: "SGT — Asia/Singapore (UTC+8)" },
  { value: "UTC", label: "UTC — Coordinated Universal Time" },
] as const;

/**
 * Secret/infrastructure field names that are explicitly rejected anywhere in tenant settings
 * payloads (PLAN §11.2: never store/expose secret tokens, Cloudflare tokens, SMTP, Coolify).
 */
export const FORBIDDEN_SETTINGS_SECRET_KEYS: ReadonlySet<string> = new Set([
  "cloudflareToken",
  "cloudflareApiToken",
  "cfApiToken",
  "smtpHost",
  "smtpPassword",
  "smtpUser",
  "smtpPass",
  "coolifyToken",
  "coolifyUrl",
  "authSecret",
  "apiSecret",
  "privateKey",
  "secretKey",
  "accessToken",
  "refreshToken",
  "password",
  "databaseUrl",
]);

export const GENERAL_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "siteTitle",
  "siteName",
  "tagline",
  "timezone",
  "locale",
  "logoMediaId",
  "logoLightMediaId",
  "logoDarkMediaId",
  "faviconMediaId",
  "publicEmail",
  "expectedVersion",
  "version",
]);

export const BUSINESS_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "businessName",
  "businessCategory",
  "description",
  "phone",
  "whatsappE164",
  "whatsappNumber",
  "email",
  "publicEmail",
  "address",
  "city",
  "province",
  "postalCode",
  "latitude",
  "longitude",
  "mapsUrl",
  "googleMapsReviewUrl",
  "weekdayHours",
  "holidayHours",
  "openingHours",
  "serviceAreas",
  "socialLinks",
  "expectedVersion",
  "version",
]);

export const READING_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "homepageMode",
  "homepagePageId",
  "blogEnabled",
  "catalogEnabled",
  "enabledOfferingTypes",
  "itemsPerPage",
  "expectedVersion",
  "version",
]);

export const SEO_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "defaultTitle",
  "defaultDescription",
  "ogImageMediaId",
  "defaultOgMediaId",
  "siteVisibility",
  "aiTrainingPolicy",
  "aiCrawlerTrainingOptOut",
  "googleSiteVerification",
  "bingSiteVerification",
  "expectedVersion",
  "version",
]);

export const PRIVACY_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "privacyPageId",
  "consentBannerText",
  "consentPolicyVersion",
  "expectedVersion",
  "version",
]);

export const ANALYTICS_GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ga4MeasurementId",
  "metaPixelId",
  "tiktokPixelId",
  "expectedVersion",
  "version",
]);

export const ALLOWED_KEYS_BY_GROUP: Readonly<Record<SettingsGroup, ReadonlySet<string>>> = {
  general: GENERAL_GROUP_ALLOWED_KEYS,
  business: BUSINESS_GROUP_ALLOWED_KEYS,
  reading: READING_GROUP_ALLOWED_KEYS,
  seo: SEO_GROUP_ALLOWED_KEYS,
  privacy: PRIVACY_GROUP_ALLOWED_KEYS,
  analytics: ANALYTICS_GROUP_ALLOWED_KEYS,
};

// ---------------------------------------------------------------------------
// Structured Settings Extension & Grouped DTO Types
// ---------------------------------------------------------------------------

export type HomepageMode = "modular" | "page";

export interface BusinessSettingsExtension {
  readonly googleMapsReviewUrl: string | null;
}

export interface ReadingSettingsExtension {
  readonly homepageMode: HomepageMode;
  readonly homepagePageId: number | null;
  readonly enabledOfferingTypes: readonly OfferingType[];
  readonly itemsPerPage: ItemsPerPageOption;
}

export interface SeoSettingsExtension {
  readonly defaultTitle: string | null;
  readonly defaultDescription: string | null;
  readonly googleSiteVerification: string | null;
  readonly bingSiteVerification: string | null;
}

export interface PrivacySettingsExtension {
  readonly privacyPageId: number | null;
  readonly consentBannerText: string | null;
  readonly consentPolicyVersion: number;
}

export interface GroupedSettingsExtension {
  readonly business: BusinessSettingsExtension;
  readonly reading: ReadingSettingsExtension;
  readonly seo: SeoSettingsExtension;
  readonly privacy: PrivacySettingsExtension;
}

export interface GeneralSettingsGroupData {
  readonly siteTitle: string;
  readonly tagline: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly logoMediaId: number | null;
  readonly logoLightMediaId: number | null;
  readonly logoDarkMediaId: number | null;
  readonly faviconMediaId: number | null;
  readonly publicEmail: string | null;
}

export interface BusinessSettingsGroupData {
  readonly businessName: string;
  readonly businessCategory: string;
  readonly description: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly mapsUrl: string | null;
  readonly googleMapsReviewUrl: string | null;
  readonly weekdayHours: string | null;
  readonly holidayHours: string | null;
  readonly serviceAreas: readonly string[];
  readonly socialLinks: readonly { readonly platform: SettingsSocialPlatform; readonly url: string }[];
}

export interface ReadingSettingsGroupData {
  readonly homepageMode: HomepageMode;
  readonly homepagePageId: number | null;
  readonly blogEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly enabledOfferingTypes: readonly OfferingType[];
  readonly itemsPerPage: ItemsPerPageOption;
  readonly fixedRoutes: typeof FIXED_PUBLIC_ROUTES;
}

export interface SeoSettingsGroupData {
  readonly defaultTitle: string | null;
  readonly defaultDescription: string | null;
  readonly ogImageMediaId: number | null;
  readonly siteVisibility: "public" | "noindex";
  readonly aiTrainingPolicy: "allow" | "disallow";
  readonly googleSiteVerification: string | null;
  readonly bingSiteVerification: string | null;
}

export interface PrivacySettingsGroupData {
  readonly privacyPageId: number | null;
  readonly consentBannerText: string | null;
  readonly consentPolicyVersion: number;
}

export interface AnalyticsSettingsSummaryData {
  readonly ga4MeasurementId: string | null;
  readonly metaPixelId: string | null;
  readonly tiktokPixelId: string | null;
}

export interface GroupedSettingsSnapshot {
  readonly general: GeneralSettingsGroupData;
  readonly business: BusinessSettingsGroupData;
  readonly reading: ReadingSettingsGroupData;
  readonly seo: SeoSettingsGroupData;
  readonly privacy: PrivacySettingsGroupData;
  readonly analytics: AnalyticsSettingsSummaryData;
}

export interface PublicReadingDefaults {
  readonly homepageMode: HomepageMode;
  readonly homepagePageId: number | null;
  readonly blogEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly enabledOfferingTypes: readonly OfferingType[];
  readonly itemsPerPage: ItemsPerPageOption;
}

export class SettingsValidationError extends PublicationValidationError {
  constructor(message: string, fields: readonly PublicationValidationField[] = []) {
    super(message, fields);
    this.name = "SettingsValidationError";
  }
}

// ---------------------------------------------------------------------------
// Default Builders & Envelope Serialization
// ---------------------------------------------------------------------------

export function createDefaultGroupedSettingsExtension(): GroupedSettingsExtension {
  return {
    business: {
      googleMapsReviewUrl: null,
    },
    reading: {
      homepageMode: "modular",
      homepagePageId: null,
      enabledOfferingTypes: [...ALL_OFFERING_TYPES],
      itemsPerPage: 12,
    },
    seo: {
      defaultTitle: null,
      defaultDescription: null,
      googleSiteVerification: null,
      bingSiteVerification: null,
    },
    privacy: {
      privacyPageId: null,
      consentBannerText: null,
      consentPolicyVersion: 1,
    },
  };
}

function safeParseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeStoredOfferingTypes(value: unknown): OfferingType[] {
  if (!Array.isArray(value)) return [...ALL_OFFERING_TYPES];
  const seen = new Set<OfferingType>();
  for (const item of value) {
    const parsed = OfferingTypeSchema.safeParse(item);
    if (parsed.success) {
      seen.add(parsed.data);
    }
  }
  return ALL_OFFERING_TYPES.filter((t) => seen.has(t));
}

function normalizeStoredItemsPerPage(value: unknown): ItemsPerPageOption {
  if (value === 6 || value === 12 || value === 24) {
    return value;
  }
  return 12;
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  return null;
}

function normalizeNullableString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

/**
 * Extracts `_groupedSettings` extension metadata from a stored `site_settings`
 * envelope JSON (`draft_json` or `published_json`), preserving full backward compatibility
 * with rows created before TASK-040.
 */
export function extractGroupedSettingsExtension(
  rawEnvelopeJson: string | null | undefined,
): GroupedSettingsExtension {
  const defaults = createDefaultGroupedSettingsExtension();
  const parsed = safeParseJsonObject(rawEnvelopeJson);
  const rawExt = parsed?._groupedSettings;
  if (!rawExt || typeof rawExt !== "object" || Array.isArray(rawExt)) {
    return defaults;
  }
  const ext = rawExt as Record<string, unknown>;
  const rawBusiness =
    ext.business && typeof ext.business === "object" && !Array.isArray(ext.business)
      ? (ext.business as Record<string, unknown>)
      : {};
  const rawReading =
    ext.reading && typeof ext.reading === "object" && !Array.isArray(ext.reading)
      ? (ext.reading as Record<string, unknown>)
      : {};
  const rawSeo =
    ext.seo && typeof ext.seo === "object" && !Array.isArray(ext.seo)
      ? (ext.seo as Record<string, unknown>)
      : {};
  const rawPrivacy =
    ext.privacy && typeof ext.privacy === "object" && !Array.isArray(ext.privacy)
      ? (ext.privacy as Record<string, unknown>)
      : {};

  const rawReviewUrl = normalizeNullableString(rawBusiness.googleMapsReviewUrl, 2048);
  const validatedReview = rawReviewUrl ? validateGoogleMapsReviewUrl(rawReviewUrl) : null;
  const googleMapsReviewUrl = validatedReview?.ok ? validatedReview.href : null;

  const homepagePageId = normalizeNullablePositiveInt(rawReading.homepagePageId);
  const homepageMode: HomepageMode =
    rawReading.homepageMode === "page" && homepagePageId !== null ? "page" : "modular";

  const rawPolicyVersion = rawPrivacy.consentPolicyVersion;
  const consentPolicyVersion =
    typeof rawPolicyVersion === "number" &&
    Number.isSafeInteger(rawPolicyVersion) &&
    rawPolicyVersion >= 1 &&
    rawPolicyVersion <= 100
      ? rawPolicyVersion
      : 1;

  return {
    business: {
      googleMapsReviewUrl,
    },
    reading: {
      homepageMode,
      homepagePageId: homepageMode === "page" ? homepagePageId : null,
      enabledOfferingTypes:
        rawReading.enabledOfferingTypes !== undefined
          ? normalizeStoredOfferingTypes(rawReading.enabledOfferingTypes)
          : defaults.reading.enabledOfferingTypes,
      itemsPerPage: normalizeStoredItemsPerPage(rawReading.itemsPerPage),
    },
    seo: {
      defaultTitle: normalizeNullableString(rawSeo.defaultTitle, 200),
      defaultDescription: normalizeNullableString(rawSeo.defaultDescription, 500),
      googleSiteVerification: normalizeNullableString(rawSeo.googleSiteVerification, 128),
      bingSiteVerification: normalizeNullableString(rawSeo.bingSiteVerification, 64),
    },
    privacy: {
      privacyPageId: normalizeNullablePositiveInt(rawPrivacy.privacyPageId),
      consentBannerText: normalizeNullableString(rawPrivacy.consentBannerText, 500),
      consentPolicyVersion,
    },
  };
}

/**
 * Attaches `_groupedSettings` (and optional `_brandAssets`) onto a `snapshotVersion: 1`
 * `site_settings` JSON envelope without altering `data` (so `SiteSettingsSnapshotSchema.strict()`
 * continues to pass seamlessly across public routes, sitemaps, and identity loaders).
 */
export function attachGroupedSettingsExtension(
  rawEnvelopeJson: string | null | undefined,
  extension: GroupedSettingsExtension,
  brandAssets?: {
    readonly logoMediaId: number | null;
    readonly logoLightMediaId: number | null;
    readonly logoDarkMediaId: number | null;
  },
): string | null {
  const parsed = safeParseJsonObject(rawEnvelopeJson);
  if (!parsed) return rawEnvelopeJson ?? null;
  return JSON.stringify({
    ...parsed,
    ...(brandAssets ? { _brandAssets: brandAssets } : {}),
    _groupedSettings: extension,
  });
}

// ---------------------------------------------------------------------------
// Strict Pure Field Validators
// ---------------------------------------------------------------------------

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const GOOGLE_VERIFY_RE = /^[A-Za-z0-9._-]{10,128}$/;
const BING_VERIFY_RE = /^[A-Za-z0-9]{16,64}$/;
const DANGEROUS_HTML_RE = /<\s*\/?\s*(?:script|iframe|style|object|embed|meta|link)\b/i;

function hasControlChars(value: string, allowMultiline: boolean): boolean {
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

function failSettingsValidation(
  message: string,
  field: string,
  code: string,
  detail?: string,
): never {
  throw new SettingsValidationError(message, [{ field, code, message: detail ?? message }]);
}

export function assertNoForbiddenSecretFields(value: unknown, pathPrefix = ""): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenSecretFields(value[i], `${pathPrefix}[${i}]`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_SETTINGS_SECRET_KEYS.has(key)) {
      failSettingsValidation(
        `Field rahasia "${key}" tidak diizinkan dalam pengaturan tenant.`,
        nextPath,
        "FORBIDDEN_SECRET_FIELD",
      );
    }
    assertNoForbiddenSecretFields(nested, nextPath);
  }
}

function validateText(
  value: unknown,
  field: string,
  options: {
    readonly required: boolean;
    readonly maxLength: number;
    readonly errorCode: string;
    readonly allowMultiline?: boolean;
    readonly rejectHtmlTags?: boolean;
  },
): string | null {
  if (value === null || value === undefined) {
    if (options.required) {
      failSettingsValidation(`${field} wajib diisi.`, field, options.errorCode);
    }
    return null;
  }
  if (typeof value !== "string") {
    failSettingsValidation(`${field} harus berupa teks.`, field, options.errorCode);
  }
  if (hasControlChars(value, options.allowMultiline ?? false)) {
    failSettingsValidation(
      `${field} tidak boleh mengandung karakter kontrol.`,
      field,
      options.errorCode,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (options.required) {
      failSettingsValidation(`${field} tidak boleh kosong.`, field, options.errorCode);
    }
    return null;
  }
  if (trimmed.length > options.maxLength) {
    failSettingsValidation(
      `${field} maksimal ${options.maxLength} karakter.`,
      field,
      options.errorCode,
    );
  }
  if (options.rejectHtmlTags && DANGEROUS_HTML_RE.test(trimmed)) {
    failSettingsValidation(
      `${field} tidak boleh mengandung tag HTML eksekusi.`,
      field,
      "UNSAFE_HTML",
    );
  }
  return trimmed;
}

export function validateIanaTimezone(value: unknown, field = "timezone"): string {
  const tz = validateText(value, field, {
    required: true,
    maxLength: 64,
    errorCode: "INVALID_TIMEZONE",
  });
  if (!tz) {
    failSettingsValidation("Zona waktu wajib diisi.", field, "INVALID_TIMEZONE");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    failSettingsValidation(`Zona waktu IANA "${tz}" tidak valid.`, field, "INVALID_TIMEZONE");
  }
  return tz;
}

function validateLocaleTag(value: unknown, field = "locale"): string {
  const loc = validateText(value, field, {
    required: true,
    maxLength: 16,
    errorCode: "INVALID_LOCALE",
  });
  if (!loc || !LOCALE_PATTERN.test(loc)) {
    failSettingsValidation(
      "Format locale harus BCP-47 yang valid (contoh: id-ID).",
      field,
      "INVALID_LOCALE",
    );
  }
  return loc;
}

function validateNullablePositiveId(value: unknown, field: string, errorCode: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = SequentialIdSchema.safeParse(value);
  if (!parsed.success) {
    failSettingsValidation(`${field} harus berupa ID bilangan bulat positif atau null.`, field, errorCode);
  }
  return parsed.data;
}

function validateNullableEmail(value: unknown, field: string): string | null {
  const text = validateText(value, field, {
    required: false,
    maxLength: 254,
    errorCode: "INVALID_EMAIL",
  });
  if (!text) return null;
  const parsed = EmailSchema.safeParse(text);
  if (!parsed.success) {
    failSettingsValidation("Format alamat email publik tidak valid.", field, "INVALID_EMAIL");
  }
  return parsed.data;
}

function validateNullableWhatsApp(value: unknown, field: string): string | null {
  const text = validateText(value, field, {
    required: false,
    maxLength: 32,
    errorCode: "INVALID_WHATSAPP",
  });
  if (!text) return null;
  try {
    return normalizeIndonesianWhatsAppNumber(text);
  } catch (err) {
    const msg =
      err instanceof WhatsAppValidationError
        ? err.message
        : "Nomor WhatsApp Indonesia tidak valid (contoh: 6281234567890).";
    failSettingsValidation(msg, field, "INVALID_WHATSAPP");
  }
}

function validateNullablePhone(value: unknown, field: string): string | null {
  const text = validateText(value, field, {
    required: false,
    maxLength: 32,
    errorCode: "INVALID_PHONE",
  });
  if (!text) return null;
  if (!/^[0-9+ ().-]+$/.test(text)) {
    failSettingsValidation("Format nomor telepon mengandung karakter tidak didukung.", field, "INVALID_PHONE");
  }
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    failSettingsValidation("Nomor telepon harus terdiri dari 7 hingga 15 digit.", field, "INVALID_PHONE");
  }
  if (digits.startsWith("0")) {
    return `62${digits.slice(1)}`;
  }
  return digits;
}

function validateNullableHttpsUrl(value: unknown, field: string): string | null {
  const text = validateText(value, field, {
    required: false,
    maxLength: 2048,
    errorCode: "UNSAFE_URL",
  });
  if (!text) return null;
  try {
    return sanitizeExternalLink(text).href;
  } catch (err) {
    const msg =
      err instanceof ExternalLinkValidationError
        ? err.message
        : "Tautan harus berupa URL HTTPS publik yang aman.";
    failSettingsValidation(msg, field, "UNSAFE_URL");
  }
}

function validateNullableGoogleMapsReviewUrl(value: unknown, field: string): string | null {
  const text = validateText(value, field, {
    required: false,
    maxLength: 2048,
    errorCode: "INVALID_GOOGLE_MAPS_REVIEW_URL",
  });
  if (!text) return null;
  const res = validateGoogleMapsReviewUrl(text);
  if (!res.ok) {
    failSettingsValidation(res.message, field, "INVALID_GOOGLE_MAPS_REVIEW_URL");
  }
  return res.href;
}

export interface ValidatedGroupPatch {
  readonly group: SettingsGroup;
  readonly siteSettingsPatch?: Partial<SiteSettingsSnapshot>;
  readonly brandAssetsPatch?: Partial<{
    readonly logoMediaId: number | null;
    readonly logoLightMediaId: number | null;
    readonly logoDarkMediaId: number | null;
  }>;
  readonly businessProfilePatch?: Partial<BusinessProfileSnapshot>;
  readonly extensionPatch?: {
    readonly business?: Partial<BusinessSettingsExtension>;
    readonly reading?: Partial<ReadingSettingsExtension>;
    readonly seo?: Partial<SeoSettingsExtension>;
    readonly privacy?: Partial<PrivacySettingsExtension>;
  };
  readonly analyticsPatch?: {
    readonly ga4MeasurementId?: string | null;
    readonly metaPixelId?: string | null;
    readonly tiktokPixelId?: string | null;
  };
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Strictly validates a settings group PATCH payload against that group's allowlist,
 * rejecting unknown fields, cross-group fields, forbidden tenant selectors, and secret keys.
 */
export function validateGroupedSettingsPatch(
  group: SettingsGroup,
  rawBody: unknown,
): ValidatedGroupPatch {
  assertNoForbiddenTenantSelectors(rawBody);
  assertNoForbiddenSecretFields(rawBody);

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    failSettingsValidation("Payload pengaturan harus berupa objek JSON.", "body", "INVALID_PAYLOAD");
  }

  const body = rawBody as Record<string, unknown>;
  const allowed = ALLOWED_KEYS_BY_GROUP[group];
  const unknownKeys = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknownKeys.length > 0) {
    const first = unknownKeys[0] ?? "unknown";
    throw new SettingsValidationError(
      `Field "${first}" tidak diizinkan pada grup pengaturan "${group}".`,
      unknownKeys.map((k) => ({
        field: k,
        code: "UNKNOWN_FIELD",
        message: `Field "${k}" is not allowed in settings group "${group}".`,
      })),
    );
  }

  switch (group) {
    case "general": {
      const siteSettingsPatch: Record<string, unknown> = {};
      const brandAssetsPatch: Record<string, number | null> = {};
      const businessProfilePatch: Record<string, unknown> = {};

      if (hasKey(body, "siteTitle") && hasKey(body, "siteName") && body.siteTitle !== body.siteName) {
        failSettingsValidation(
          "siteTitle dan siteName harus sama jika keduanya dikirim.",
          "siteTitle",
          "CONFLICTING_FIELDS",
        );
      }
      if (hasKey(body, "siteTitle") || hasKey(body, "siteName")) {
        const rawTitle = hasKey(body, "siteTitle") ? body.siteTitle : body.siteName;
        const siteTitle = validateText(rawTitle, hasKey(body, "siteTitle") ? "siteTitle" : "siteName", {
          required: true,
          maxLength: 120,
          errorCode: "INVALID_SITE_TITLE",
          rejectHtmlTags: true,
        });
        if (siteTitle) siteSettingsPatch.siteTitle = siteTitle;
      }
      if (hasKey(body, "tagline")) {
        siteSettingsPatch.tagline = validateText(body.tagline, "tagline", {
          required: false,
          maxLength: 240,
          errorCode: "INVALID_TAGLINE",
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "timezone")) {
        siteSettingsPatch.timezone = validateIanaTimezone(body.timezone, "timezone");
      }
      if (hasKey(body, "locale")) {
        siteSettingsPatch.locale = validateLocaleTag(body.locale, "locale");
      }
      if (hasKey(body, "faviconMediaId")) {
        siteSettingsPatch.faviconMediaId = validateNullablePositiveId(
          body.faviconMediaId,
          "faviconMediaId",
          "INVALID_MEDIA_ID",
        );
      }
      if (hasKey(body, "logoMediaId")) {
        brandAssetsPatch.logoMediaId = validateNullablePositiveId(
          body.logoMediaId,
          "logoMediaId",
          "INVALID_MEDIA_ID",
        );
      }
      if (hasKey(body, "logoLightMediaId")) {
        brandAssetsPatch.logoLightMediaId = validateNullablePositiveId(
          body.logoLightMediaId,
          "logoLightMediaId",
          "INVALID_MEDIA_ID",
        );
      }
      if (hasKey(body, "logoDarkMediaId")) {
        brandAssetsPatch.logoDarkMediaId = validateNullablePositiveId(
          body.logoDarkMediaId,
          "logoDarkMediaId",
          "INVALID_MEDIA_ID",
        );
      }
      if (hasKey(body, "publicEmail")) {
        businessProfilePatch.email = validateNullableEmail(body.publicEmail, "publicEmail");
      }

      return {
        group,
        ...(Object.keys(siteSettingsPatch).length > 0
          ? { siteSettingsPatch: siteSettingsPatch as Partial<SiteSettingsSnapshot> }
          : {}),
        ...(Object.keys(brandAssetsPatch).length > 0 ? { brandAssetsPatch } : {}),
        ...(Object.keys(businessProfilePatch).length > 0
          ? { businessProfilePatch: businessProfilePatch as Partial<BusinessProfileSnapshot> }
          : {}),
      };
    }

    case "business": {
      const bp: Record<string, unknown> = {};
      const businessExt: Record<string, unknown> = {};

      if (hasKey(body, "businessName")) {
        bp.businessName = validateText(body.businessName, "businessName", {
          required: true,
          maxLength: 160,
          errorCode: "INVALID_BUSINESS_NAME",
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "businessCategory")) {
        const category = validateText(body.businessCategory, "businessCategory", {
          required: true,
          maxLength: 80,
          errorCode: "INVALID_BUSINESS_CATEGORY",
        });
        if (!category || category === "ProfessionalService" || !BUSINESS_CATEGORY_SET.has(category)) {
          failSettingsValidation(
            `Kategori bisnis "${String(body.businessCategory)}" tidak didukung oleh Schema.org PunyaSitus.`,
            "businessCategory",
            "INVALID_BUSINESS_CATEGORY",
          );
        }
        bp.businessCategory = category;
      }
      if (hasKey(body, "description")) {
        bp.description = validateText(body.description, "description", {
          required: false,
          maxLength: 1000,
          errorCode: "INVALID_DESCRIPTION",
          allowMultiline: true,
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "phone")) {
        bp.phone = validateNullablePhone(body.phone, "phone");
      }
      if (hasKey(body, "whatsappE164") || hasKey(body, "whatsappNumber")) {
        const rawWa = hasKey(body, "whatsappE164") ? body.whatsappE164 : body.whatsappNumber;
        bp.whatsappE164 = validateNullableWhatsApp(
          rawWa,
          hasKey(body, "whatsappE164") ? "whatsappE164" : "whatsappNumber",
        );
      }
      if (hasKey(body, "email") || hasKey(body, "publicEmail")) {
        const rawEmail = hasKey(body, "email") ? body.email : body.publicEmail;
        bp.email = validateNullableEmail(rawEmail, hasKey(body, "email") ? "email" : "publicEmail");
      }
      if (hasKey(body, "address")) {
        bp.address = validateText(body.address, "address", {
          required: false,
          maxLength: 500,
          errorCode: "INVALID_ADDRESS",
          allowMultiline: true,
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "city")) {
        bp.city = validateText(body.city, "city", {
          required: false,
          maxLength: 120,
          errorCode: "INVALID_CITY",
        });
      }
      if (hasKey(body, "province")) {
        bp.province = validateText(body.province, "province", {
          required: false,
          maxLength: 120,
          errorCode: "INVALID_PROVINCE",
        });
      }
      if (hasKey(body, "postalCode")) {
        bp.postalCode = validateText(body.postalCode, "postalCode", {
          required: false,
          maxLength: 20,
          errorCode: "INVALID_POSTAL_CODE",
        });
      }
      if (hasKey(body, "latitude")) {
        const lat = body.latitude;
        if (lat === null) {
          bp.latitude = null;
        } else if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
          failSettingsValidation("Latitude harus berada di antara -90 dan 90.", "latitude", "INVALID_COORDINATES");
        } else {
          bp.latitude = lat;
        }
      }
      if (hasKey(body, "longitude")) {
        const lng = body.longitude;
        if (lng === null) {
          bp.longitude = null;
        } else if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
          failSettingsValidation("Longitude harus berada di antara -180 dan 180.", "longitude", "INVALID_COORDINATES");
        } else {
          bp.longitude = lng;
        }
      }
      if (hasKey(body, "mapsUrl")) {
        bp.mapsUrl = validateNullableHttpsUrl(body.mapsUrl, "mapsUrl");
      }
      if (hasKey(body, "googleMapsReviewUrl")) {
        businessExt.googleMapsReviewUrl = validateNullableGoogleMapsReviewUrl(
          body.googleMapsReviewUrl,
          "googleMapsReviewUrl",
        );
      }
      if (hasKey(body, "openingHours")) {
        const oh = body.openingHours;
        if (oh === null) {
          bp.weekdayHours = null;
          bp.holidayHours = null;
        } else if (typeof oh === "object" && !Array.isArray(oh)) {
          const rec = oh as Record<string, unknown>;
          if (hasKey(rec, "weekday")) {
            bp.weekdayHours = validateText(rec.weekday, "openingHours.weekday", {
              required: false,
              maxLength: 160,
              errorCode: "INVALID_HOURS",
            });
          }
          if (hasKey(rec, "holiday")) {
            bp.holidayHours = validateText(rec.holiday, "openingHours.holiday", {
              required: false,
              maxLength: 160,
              errorCode: "INVALID_HOURS",
            });
          }
        } else {
          failSettingsValidation("openingHours harus berupa objek atau null.", "openingHours", "INVALID_HOURS");
        }
      }
      if (hasKey(body, "weekdayHours")) {
        bp.weekdayHours = validateText(body.weekdayHours, "weekdayHours", {
          required: false,
          maxLength: 160,
          errorCode: "INVALID_HOURS",
        });
      }
      if (hasKey(body, "holidayHours")) {
        bp.holidayHours = validateText(body.holidayHours, "holidayHours", {
          required: false,
          maxLength: 160,
          errorCode: "INVALID_HOURS",
        });
      }
      if (hasKey(body, "serviceAreas")) {
        if (!Array.isArray(body.serviceAreas)) {
          failSettingsValidation("serviceAreas harus berupa daftar teks.", "serviceAreas", "INVALID_SERVICE_AREAS");
        }
        if (body.serviceAreas.length > 20) {
          failSettingsValidation("Maksimal 20 area layanan.", "serviceAreas", "INVALID_SERVICE_AREAS");
        }
        const areas: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < body.serviceAreas.length; i += 1) {
          const area = validateText(body.serviceAreas[i], `serviceAreas[${i}]`, {
            required: true,
            maxLength: 80,
            errorCode: "INVALID_SERVICE_AREAS",
          });
          if (area && !seen.has(area.toLowerCase())) {
            seen.add(area.toLowerCase());
            areas.push(area);
          }
        }
        bp.serviceAreas = areas;
      }
      if (hasKey(body, "socialLinks")) {
        if (!Array.isArray(body.socialLinks)) {
          failSettingsValidation("socialLinks harus berupa daftar tautan.", "socialLinks", "INVALID_SOCIAL_LINKS");
        }
        if (body.socialLinks.length > 10) {
          failSettingsValidation("Maksimal 10 tautan media sosial.", "socialLinks", "INVALID_SOCIAL_LINKS");
        }
        const links: Array<{ readonly platform: SettingsSocialPlatform; readonly url: string }> = [];
        for (let i = 0; i < body.socialLinks.length; i += 1) {
          const item = body.socialLinks[i];
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            failSettingsValidation("Item tautan sosial tidak valid.", `socialLinks[${i}]`, "INVALID_SOCIAL_LINKS");
          }
          const rec = item as Record<string, unknown>;
          const platform = typeof rec.platform === "string" ? rec.platform.trim().toLowerCase() : "";
          if (!SOCIAL_PLATFORM_SET.has(platform)) {
            failSettingsValidation(
              `Platform sosial "${platform}" tidak didukung.`,
              `socialLinks[${i}].platform`,
              "INVALID_SOCIAL_PLATFORM",
            );
          }
          const url = validateNullableHttpsUrl(rec.url, `socialLinks[${i}].url`);
          if (!url) {
            failSettingsValidation(
              "URL media sosial wajib diisi dengan tautan HTTPS.",
              `socialLinks[${i}].url`,
              "UNSAFE_URL",
            );
          }
          links.push({ platform: platform as SettingsSocialPlatform, url });
        }
        bp.socialLinks = links;
      }

      return {
        group,
        ...(Object.keys(bp).length > 0
          ? { businessProfilePatch: bp as Partial<BusinessProfileSnapshot> }
          : {}),
        ...(Object.keys(businessExt).length > 0
          ? { extensionPatch: { business: businessExt as Partial<BusinessSettingsExtension> } }
          : {}),
      };
    }

    case "reading": {
      const siteSettingsPatch: Record<string, unknown> = {};
      const readingExt: Record<string, unknown> = {};

      if (hasKey(body, "homepageMode")) {
        if (body.homepageMode !== "modular" && body.homepageMode !== "page") {
          failSettingsValidation(
            'homepageMode harus "modular" atau "page".',
            "homepageMode",
            "INVALID_HOMEPAGE_MODE",
          );
        }
        readingExt.homepageMode = body.homepageMode;
      }
      if (hasKey(body, "homepagePageId")) {
        const pageId = validateNullablePositiveId(
          body.homepagePageId,
          "homepagePageId",
          "INVALID_PAGE_ID",
        );
        readingExt.homepagePageId = pageId;
        if (!hasKey(body, "homepageMode")) {
          readingExt.homepageMode = pageId !== null ? "page" : "modular";
        }
      }
      if (readingExt.homepageMode === "page" && hasKey(body, "homepagePageId") && readingExt.homepagePageId === null) {
        failSettingsValidation(
          "Pilih halaman yang sudah diterbitkan ketika mode beranda adalah halaman statis.",
          "homepagePageId",
          "HOMEPAGE_PAGE_REQUIRED",
        );
      }
      if (readingExt.homepageMode === "modular") {
        readingExt.homepagePageId = null;
      }

      if (hasKey(body, "blogEnabled")) {
        if (typeof body.blogEnabled !== "boolean") {
          failSettingsValidation("blogEnabled harus berupa boolean.", "blogEnabled", "INVALID_BOOLEAN");
        }
        siteSettingsPatch.blogEnabled = body.blogEnabled;
      }

      if (hasKey(body, "enabledOfferingTypes")) {
        if (!Array.isArray(body.enabledOfferingTypes)) {
          failSettingsValidation(
            "enabledOfferingTypes harus berupa daftar jenis penawaran.",
            "enabledOfferingTypes",
            "INVALID_OFFERING_TYPES",
          );
        }
        if (body.enabledOfferingTypes.length > 4) {
          failSettingsValidation(
            "enabledOfferingTypes maksimal 4 jenis penawaran.",
            "enabledOfferingTypes",
            "INVALID_OFFERING_TYPES",
          );
        }
        const seen = new Set<OfferingType>();
        for (let i = 0; i < body.enabledOfferingTypes.length; i += 1) {
          const parsed = OfferingTypeSchema.safeParse(body.enabledOfferingTypes[i]);
          if (!parsed.success) {
            failSettingsValidation(
              `Jenis penawaran "${String(body.enabledOfferingTypes[i])}" tidak valid.`,
              `enabledOfferingTypes[${i}]`,
              "INVALID_OFFERING_TYPE",
            );
          }
          seen.add(parsed.data);
        }
        const normalized = ALL_OFFERING_TYPES.filter((t) => seen.has(t));
        readingExt.enabledOfferingTypes = normalized;
        if (!hasKey(body, "catalogEnabled")) {
          siteSettingsPatch.catalogEnabled = normalized.length > 0;
        }
      }

      if (hasKey(body, "catalogEnabled")) {
        if (typeof body.catalogEnabled !== "boolean") {
          failSettingsValidation("catalogEnabled harus berupa boolean.", "catalogEnabled", "INVALID_BOOLEAN");
        }
        siteSettingsPatch.catalogEnabled = body.catalogEnabled;
      }

      if (hasKey(body, "itemsPerPage")) {
        if (body.itemsPerPage !== 6 && body.itemsPerPage !== 12 && body.itemsPerPage !== 24) {
          failSettingsValidation(
            "itemsPerPage hanya boleh bernilai 6, 12, atau 24.",
            "itemsPerPage",
            "INVALID_ITEMS_PER_PAGE",
          );
        }
        readingExt.itemsPerPage = body.itemsPerPage;
      }

      return {
        group,
        ...(Object.keys(siteSettingsPatch).length > 0
          ? { siteSettingsPatch: siteSettingsPatch as Partial<SiteSettingsSnapshot> }
          : {}),
        ...(Object.keys(readingExt).length > 0
          ? { extensionPatch: { reading: readingExt as Partial<ReadingSettingsExtension> } }
          : {}),
      };
    }

    case "seo": {
      const siteSettingsPatch: Record<string, unknown> = {};
      const seoExt: Record<string, unknown> = {};

      if (hasKey(body, "defaultTitle")) {
        seoExt.defaultTitle = validateText(body.defaultTitle, "defaultTitle", {
          required: false,
          maxLength: 200,
          errorCode: "INVALID_SEO_TITLE",
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "defaultDescription")) {
        seoExt.defaultDescription = validateText(body.defaultDescription, "defaultDescription", {
          required: false,
          maxLength: 500,
          errorCode: "INVALID_SEO_DESCRIPTION",
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "ogImageMediaId") || hasKey(body, "defaultOgMediaId")) {
        const rawOg = hasKey(body, "ogImageMediaId") ? body.ogImageMediaId : body.defaultOgMediaId;
        siteSettingsPatch.ogImageMediaId = validateNullablePositiveId(
          rawOg,
          hasKey(body, "ogImageMediaId") ? "ogImageMediaId" : "defaultOgMediaId",
          "INVALID_MEDIA_ID",
        );
      }
      if (hasKey(body, "siteVisibility")) {
        if (body.siteVisibility !== "public" && body.siteVisibility !== "noindex") {
          failSettingsValidation(
            'siteVisibility harus "public" atau "noindex".',
            "siteVisibility",
            "INVALID_SITE_VISIBILITY",
          );
        }
        siteSettingsPatch.siteVisibility = body.siteVisibility;
      }
      if (hasKey(body, "aiTrainingPolicy")) {
        if (body.aiTrainingPolicy !== "allow" && body.aiTrainingPolicy !== "disallow") {
          failSettingsValidation(
            'aiTrainingPolicy harus "allow" atau "disallow".',
            "aiTrainingPolicy",
            "INVALID_AI_TRAINING_POLICY",
          );
        }
        siteSettingsPatch.aiTrainingPolicy = body.aiTrainingPolicy;
      } else if (hasKey(body, "aiCrawlerTrainingOptOut")) {
        if (typeof body.aiCrawlerTrainingOptOut !== "boolean") {
          failSettingsValidation(
            "aiCrawlerTrainingOptOut harus berupa boolean.",
            "aiCrawlerTrainingOptOut",
            "INVALID_BOOLEAN",
          );
        }
        siteSettingsPatch.aiTrainingPolicy = body.aiCrawlerTrainingOptOut ? "disallow" : "allow";
      }
      if (hasKey(body, "googleSiteVerification")) {
        const token = validateText(body.googleSiteVerification, "googleSiteVerification", {
          required: false,
          maxLength: 128,
          errorCode: "INVALID_VERIFICATION_TOKEN",
          rejectHtmlTags: true,
        });
        if (token && !GOOGLE_VERIFY_RE.test(token)) {
          failSettingsValidation(
            "Token verifikasi Google Search Console hanya boleh berisi token polos (10-128 karakter alfanumerik/._-).",
            "googleSiteVerification",
            "INVALID_VERIFICATION_TOKEN",
          );
        }
        seoExt.googleSiteVerification = token;
      }
      if (hasKey(body, "bingSiteVerification")) {
        const token = validateText(body.bingSiteVerification, "bingSiteVerification", {
          required: false,
          maxLength: 64,
          errorCode: "INVALID_VERIFICATION_TOKEN",
          rejectHtmlTags: true,
        });
        if (token && !BING_VERIFY_RE.test(token)) {
          failSettingsValidation(
            "Token verifikasi Bing Webmaster hanya boleh berisi 16-64 karakter alfanumerik polos.",
            "bingSiteVerification",
            "INVALID_VERIFICATION_TOKEN",
          );
        }
        seoExt.bingSiteVerification = token;
      }

      return {
        group,
        ...(Object.keys(siteSettingsPatch).length > 0
          ? { siteSettingsPatch: siteSettingsPatch as Partial<SiteSettingsSnapshot> }
          : {}),
        ...(Object.keys(seoExt).length > 0
          ? { extensionPatch: { seo: seoExt as Partial<SeoSettingsExtension> } }
          : {}),
      };
    }

    case "privacy": {
      const privacyExt: Record<string, unknown> = {};

      if (hasKey(body, "privacyPageId")) {
        privacyExt.privacyPageId = validateNullablePositiveId(
          body.privacyPageId,
          "privacyPageId",
          "INVALID_PAGE_ID",
        );
      }
      if (hasKey(body, "consentBannerText")) {
        privacyExt.consentBannerText = validateText(body.consentBannerText, "consentBannerText", {
          required: false,
          maxLength: 500,
          errorCode: "INVALID_CONSENT_TEXT",
          allowMultiline: true,
          rejectHtmlTags: true,
        });
      }
      if (hasKey(body, "consentPolicyVersion")) {
        const ver = body.consentPolicyVersion;
        if (typeof ver !== "number" || !Number.isSafeInteger(ver) || ver < 1 || ver > 100) {
          failSettingsValidation(
            "consentPolicyVersion harus berupa bilangan bulat 1 hingga 100.",
            "consentPolicyVersion",
            "INVALID_CONSENT_VERSION",
          );
        }
        privacyExt.consentPolicyVersion = ver;
      }

      return {
        group,
        extensionPatch: { privacy: privacyExt as Partial<PrivacySettingsExtension> },
      };
    }

    case "analytics": {
      const analyticsPatch: Record<string, string | null> = {};
      const ga4Re = /^G-[A-Z0-9]{6,20}$/;
      const metaRe = /^[0-9]{8,20}$/;
      const tiktokRe = /^[A-Z0-9]{8,32}$/;

      if (hasKey(body, "ga4MeasurementId")) {
        const val = validateText(body.ga4MeasurementId, "ga4MeasurementId", {
          required: false,
          maxLength: 32,
          errorCode: "INVALID_GA4_ID",
        });
        if (val && !ga4Re.test(val)) {
          failSettingsValidation("Format GA4 Measurement ID tidak valid (contoh: G-XXXXXXXXXX).", "ga4MeasurementId", "INVALID_GA4_ID");
        }
        analyticsPatch.ga4MeasurementId = val;
      }
      if (hasKey(body, "metaPixelId")) {
        const val = validateText(body.metaPixelId, "metaPixelId", {
          required: false,
          maxLength: 32,
          errorCode: "INVALID_META_PIXEL_ID",
        });
        if (val && !metaRe.test(val)) {
          failSettingsValidation("Meta Pixel ID harus terdiri dari 8-20 digit angka.", "metaPixelId", "INVALID_META_PIXEL_ID");
        }
        analyticsPatch.metaPixelId = val;
      }
      if (hasKey(body, "tiktokPixelId")) {
        const val = validateText(body.tiktokPixelId, "tiktokPixelId", {
          required: false,
          maxLength: 32,
          errorCode: "INVALID_TIKTOK_PIXEL_ID",
        });
        if (val && !tiktokRe.test(val)) {
          failSettingsValidation("TikTok Pixel ID harus terdiri dari 8-32 karakter huruf kapital/angka.", "tiktokPixelId", "INVALID_TIKTOK_PIXEL_ID");
        }
        analyticsPatch.tiktokPixelId = val;
      }

      return {
        group,
        analyticsPatch,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public Navigation Filtering, Route Availability & Timezone Semantics
// ---------------------------------------------------------------------------

function extractRootSegmentFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/")) return null;
  const cleanPath = trimmed.split(/[?#]/, 1)[0] ?? "";
  const normalized = cleanPath.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!normalized) return null;
  return normalized.split("/", 1)[0] ?? null;
}

const SEGMENT_TO_OFFERING_TYPE: Readonly<Record<string, OfferingType>> = {
  layanan: "service",
  produk: "product",
  tour: "tour",
  kendaraan: "vehicle",
};

/**
 * Checks whether a public pathname is enabled under the tenant's published Reading defaults.
 * Disabled `/blog` or disabled catalog / offering routes return `false` (404 on public sites,
 * pruned from navigation and sitemaps) while preserving underlying content in the database.
 */
export function isPublicRouteEnabledBySettings(
  pathname: string,
  reading: Pick<PublicReadingDefaults, "blogEnabled" | "catalogEnabled" | "enabledOfferingTypes">,
): boolean {
  const rootSegment = extractRootSegmentFromHref(pathname);
  if (!rootSegment) return true;

  if (rootSegment === "blog") {
    return reading.blogEnabled;
  }

  const offeringType = SEGMENT_TO_OFFERING_TYPE[rootSegment];
  if (offeringType) {
    if (!reading.catalogEnabled) return false;
    return reading.enabledOfferingTypes.includes(offeringType);
  }

  return true;
}

export type PublicNavItem = MenuSnapshot["items"][number];

/**
 * Filters public navigation trees (up to 3 levels) against the tenant's published Reading settings
 * so disabled `/blog` or disabled catalog/offering references are automatically hidden from public
 * menus without mutating or deleting the stored menu records (PLAN §11.2).
 */
export function filterPublicNavigationForSettings(
  items: readonly PublicNavItem[],
  reading: Pick<PublicReadingDefaults, "blogEnabled" | "catalogEnabled" | "enabledOfferingTypes">,
): PublicNavItem[] {
  const out: PublicNavItem[] = [];
  for (const l1 of items) {
    if (!isPublicRouteEnabledBySettings(l1.href, reading)) {
      continue;
    }
    const filteredL2: PublicNavItem["children"] = [];
    for (const l2 of l1.children) {
      if (!isPublicRouteEnabledBySettings(l2.href, reading)) {
        continue;
      }
      const filteredL3 = l2.children.filter((l3) =>
        isPublicRouteEnabledBySettings(l3.href, reading),
      );
      filteredL2.push({
        ...l2,
        children: filteredL3,
      });
    }
    out.push({
      ...l1,
      children: filteredL2,
    });
  }
  return out;
}

/**
 * Formats a stored UTC instant (`epoch ms` or ISO-8601 UTC string) for display in the tenant's
 * configured IANA timezone WITHOUT altering the underlying UTC instant (PLAN §5 & §11.1).
 */
export function formatTimestampInTenantTimezone(
  utcMsOrIso: number | string | null | undefined,
  timezone = "Asia/Jakarta",
  locale = "id-ID",
): string | null {
  if (utcMsOrIso === null || utcMsOrIso === undefined) return null;
  const date = typeof utcMsOrIso === "number" ? new Date(utcMsOrIso) : new Date(utcMsOrIso);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null;
  const safeTz = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      return timezone;
    } catch {
      return "Asia/Jakarta";
    }
  })();

  return new Intl.DateTimeFormat(locale || "id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: safeTz,
    timeZoneName: "short",
  }).format(date);
}

/**
 * Formats a calendar date-only value (`YYYY-MM-DD`, such as travel departure dates) strictly in UTC
 * so tenant timezone changes NEVER shift the calendar day (PLAN §5 & §11.1).
 */
export function formatDateOnlyPreservingSemantics(
  isoDateOnly: string,
  locale = "id-ID",
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDateOnly.trim());
  if (!match) return isoDateOnly;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(utcDate.getTime()) ||
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return isoDateOnly;
  }
  return new Intl.DateTimeFormat(locale || "id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcDate);
}

export * from "./google-maps-review.ts";
