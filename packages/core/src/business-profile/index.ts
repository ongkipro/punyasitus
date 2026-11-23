import {
  assertTenantR2Key,
  MAX_OG_DERIVATIVE_BYTES,
  slugifyMediaFilename,
} from "../media/index.ts";
import { sanitizeExternalLink, ExternalLinkValidationError } from "../link-sanitizer.ts";
import { EmailSchema, NormalizedPhoneSchema } from "../schemas/common.ts";
import { normalizeIndonesianWhatsAppNumber, WhatsAppValidationError } from "../wa-dispatcher.ts";
import {
  BUSINESS_CATEGORY_CATALOG,
  CLOSED_BUSINESS_CATEGORY_KEYS,
  isDeprecatedProfessionalService,
  isPersonProfileCategory,
  lookupClosedBusinessCategory,
  mapBusinessCategoryToSchemaOrg,
  resolveBusinessCategoryDefinition,
  type BusinessCategoryDefinition,
  type BusinessCredentialGroup,
  type BusinessEntityProfileKind,
  type ClosedBusinessCategoryKey,
  type IndonesianCredentialKey,
} from "./categories.ts";
import {
  ALLOWED_CREDENTIAL_KEYS,
  CREDENTIAL_TRUTHFULNESS_NOTICE,
  formatTruthfulCredentialItems,
  getPromptedCredentialsForCategory,
  INDONESIAN_CREDENTIAL_DEFINITIONS,
  validateIndonesianCredentials,
  validateSingleCredential,
  type CredentialFieldDefinition,
  type CredentialValidationIssue,
  type IndonesianBusinessCredentials,
  type TruthfulCredentialItem,
} from "./credentials.ts";

export {
  ALLOWED_CREDENTIAL_KEYS,
  BUSINESS_CATEGORY_CATALOG,
  CLOSED_BUSINESS_CATEGORY_KEYS,
  CREDENTIAL_TRUTHFULNESS_NOTICE,
  formatTruthfulCredentialItems,
  getPromptedCredentialsForCategory,
  INDONESIAN_CREDENTIAL_DEFINITIONS,
  isDeprecatedProfessionalService,
  isPersonProfileCategory,
  lookupClosedBusinessCategory,
  mapBusinessCategoryToSchemaOrg,
  resolveBusinessCategoryDefinition,
  validateIndonesianCredentials,
  validateSingleCredential,
};

export type {
  BusinessCategoryDefinition,
  BusinessCredentialGroup,
  BusinessEntityProfileKind,
  ClosedBusinessCategoryKey,
  CredentialFieldDefinition,
  CredentialValidationIssue,
  IndonesianBusinessCredentials,
  IndonesianCredentialKey,
  TruthfulCredentialItem,
};

/**
 * Structured Business Profile Validators & Logo Auto-Derived Brand Asset Policy
 * (REQ-091, REQ-010, REQ-022, REQ-044, REQ-054; PLAN §5.2, §7.3, §19.5; TASK-091).
 */

export const ALLOWED_CLOSED_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type BusinessWeekdayKey = (typeof ALLOWED_CLOSED_DAYS)[number];

const CLOSED_DAY_SET: ReadonlySet<string> = new Set(ALLOWED_CLOSED_DAYS);

export const CLOSED_DAY_LABELS_ID: Readonly<Record<BusinessWeekdayKey, string>> = {
  monday: "Senin",
  tuesday: "Selasa",
  wednesday: "Rabu",
  thursday: "Kamis",
  friday: "Jumat",
  saturday: "Sabtu",
  sunday: "Minggu",
};

export const BRAND_ASSET_DERIVATION_SPECS = {
  favicon32: {
    width: 32,
    height: 32,
    maxBytes: 32_768, // 32 KiB ceiling
    mimeType: "image/webp" as const,
  },
  appleTouch180: {
    width: 180,
    height: 180,
    maxBytes: 65_536, // 64 KiB ceiling
    mimeType: "image/webp" as const,
  },
  og1200x630: {
    width: 1200,
    height: 630,
    maxBytes: MAX_OG_DERIVATIVE_BYTES, // 307_200 bytes (<= 300 KiB)
    mimeType: "image/webp" as const,
  },
} as const;

export interface DerivedBrandAssetEntry {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly mimeType: "image/webp";
  readonly sourceLogoMediaId: number;
  readonly derivedAt: string;
}

export type BrandAssetSourceKind =
  | "explicit_override"
  | "auto_derived_from_logo"
  | "unset";

export interface BrandAssetDerivationState {
  readonly sourceLogoMediaId: number | null;
  readonly faviconOverrideMediaId: number | null;
  readonly ogImageOverrideMediaId: number | null;
  readonly derivedFavicon32: DerivedBrandAssetEntry | null;
  readonly derivedAppleTouch180: DerivedBrandAssetEntry | null;
  readonly derivedOg1200x630: DerivedBrandAssetEntry | null;
}

export interface EffectiveBrandAssetsResolution {
  readonly faviconSource: BrandAssetSourceKind;
  readonly ogImageSource: BrandAssetSourceKind;
  readonly effectiveFaviconOverrideMediaId: number | null;
  readonly effectiveDerivedFavicon32: DerivedBrandAssetEntry | null;
  readonly effectiveDerivedAppleTouch180: DerivedBrandAssetEntry | null;
  readonly effectiveOgOverrideMediaId: number | null;
  readonly effectiveDerivedOg1200x630: DerivedBrandAssetEntry | null;
}

export interface BrandAssetDerivativeKeys {
  readonly favicon32: string;
  readonly appleTouch180: string;
  readonly og1200x630: string;
}

/**
 * Builds strictly tenant-scoped R2 object keys for auto-derived logo brand assets
 * (`32x32` favicon, `180x180` apple-touch-icon, `1200x630` default OG image).
 */
export function buildBrandAssetDerivativeKeys(
  tenantId: string,
  logoMediaId: number,
  originalFilenameOrSlug: string,
): BrandAssetDerivativeKeys {
  if (!Number.isInteger(logoMediaId) || logoMediaId < 1) {
    throw new Error("logoMediaId must be a positive sequential integer.");
  }
  const slug = slugifyMediaFilename(originalFilenameOrSlug);
  const base = `t/${tenantId.trim()}/media/${logoMediaId}/${slug}`;
  const keys: BrandAssetDerivativeKeys = {
    favicon32: `${base}-favicon-32.webp`,
    appleTouch180: `${base}-apple-touch-180.webp`,
    og1200x630: `${base}-brand-og-1200x630.webp`,
  };
  assertTenantR2Key(tenantId, keys.favicon32, ["media"]);
  assertTenantR2Key(tenantId, keys.appleTouch180, ["media"]);
  assertTenantR2Key(tenantId, keys.og1200x630, ["media"]);
  return keys;
}

/**
 * Pure policy check: auto-derivation MAY populate a brand asset slot ONLY when
 * no explicit tenant override media ID is set.
 */
export function shouldAutoDeriveBrandAssetSlot(
  explicitOverrideMediaId: number | null | undefined,
): boolean {
  return explicitOverrideMediaId === null || explicitOverrideMediaId === undefined;
}

/**
 * Resolves the effective favicon and default OG image without ever letting
 * auto-derived logo assets override explicit tenant uploads/selections.
 */
export function resolveEffectiveBrandAssets(
  state: BrandAssetDerivationState,
): EffectiveBrandAssetsResolution {
  const hasFaviconOverride = state.faviconOverrideMediaId !== null;
  const hasDerivedFavicon =
    state.derivedFavicon32 !== null && state.derivedAppleTouch180 !== null;

  const hasOgOverride = state.ogImageOverrideMediaId !== null;
  const hasDerivedOg = state.derivedOg1200x630 !== null;

  return {
    faviconSource: hasFaviconOverride
      ? "explicit_override"
      : hasDerivedFavicon
        ? "auto_derived_from_logo"
        : "unset",
    ogImageSource: hasOgOverride
      ? "explicit_override"
      : hasDerivedOg
        ? "auto_derived_from_logo"
        : "unset",
    effectiveFaviconOverrideMediaId: state.faviconOverrideMediaId,
    effectiveDerivedFavicon32: hasFaviconOverride ? null : state.derivedFavicon32,
    effectiveDerivedAppleTouch180: hasFaviconOverride ? null : state.derivedAppleTouch180,
    effectiveOgOverrideMediaId: state.ogImageOverrideMediaId,
    effectiveDerivedOg1200x630: hasOgOverride ? null : state.derivedOg1200x630,
  };
}

// ---------------------------------------------------------------------------
// Structured Extension Validators (`legalName`, `privacyContact`, `closedDays`, etc.)
// ---------------------------------------------------------------------------

export interface BusinessProfileStructuredExtension {
  readonly legalName: string | null;
  readonly privacyContact: string | null;
  readonly personRoleTitle: string | null;
  readonly affiliatedOrgName: string | null;
  readonly closedDays: readonly BusinessWeekdayKey[];
  readonly credentials: IndonesianBusinessCredentials;
}

export const STRUCTURED_BUSINESS_PROFILE_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  "legalName",
  "privacyContact",
  "personRoleTitle",
  "affiliatedOrgName",
  "closedDays",
  "credentials",
]);

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateClosedBusinessCategoryStrict(
  rawValue: unknown,
  field = "businessProfile.businessCategory",
):
  | { readonly ok: true; readonly definition: BusinessCategoryDefinition }
  | { readonly ok: false; readonly issue: CredentialValidationIssue } {
  if (typeof rawValue !== "string") {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_BUSINESS_CATEGORY",
        message: "Kategori bisnis wajib dipilih dari daftar yang tersedia.",
      },
    };
  }
  if (hasControlChars(rawValue)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_BUSINESS_CATEGORY",
        message: "Kategori bisnis tidak boleh mengandung karakter kontrol.",
      },
    };
  }
  const trimmed = rawValue.trim();
  if (isDeprecatedProfessionalService(trimmed)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_BUSINESS_CATEGORY",
        message:
          "ProfessionalService sudah tidak didukung di Schema.org. Pilih LocalBusiness atau subtipe yang valid.",
      },
    };
  }
  const matched = lookupClosedBusinessCategory(trimmed);
  if (!matched) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_BUSINESS_CATEGORY",
        message: `Kategori bisnis "${trimmed}" tidak termasuk dalam daftar kategori resmi.`,
      },
    };
  }
  return { ok: true, definition: matched };
}

export function validateOptionalBoundedLabel(
  rawValue: unknown,
  field: string,
  maxLength: number,
  errorCode: string,
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly issue: CredentialValidationIssue } {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawValue !== "string") {
    return {
      ok: false,
      issue: { field, code: errorCode, message: `${field} harus berupa teks.` },
    };
  }
  if (hasControlChars(rawValue)) {
    return {
      ok: false,
      issue: {
        field,
        code: errorCode,
        message: `${field} tidak boleh mengandung karakter kontrol.`,
      },
    };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      issue: {
        field,
        code: errorCode,
        message: `${field} maksimal ${maxLength} karakter.`,
      },
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates `privacyContact` (UU PDP & REQ-080 form publishing requirement).
 * Accepts a valid public email address, a valid Indonesian phone/WhatsApp number,
 * or a safe HTTPS privacy page URL (never `javascript:`, private IPs, or raw HTML).
 */
export function validatePrivacyContact(
  rawValue: unknown,
  field = "businessProfile.privacyContact",
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly issue: CredentialValidationIssue } {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawValue !== "string") {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_PRIVACY_CONTACT",
        message: "Kontak privasi harus berupa email, nomor telepon/WhatsApp, atau tautan HTTPS.",
      },
    };
  }
  if (hasControlChars(rawValue)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_PRIVACY_CONTACT",
        message: "Kontak privasi tidak boleh mengandung karakter kontrol.",
      },
    };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > 254) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_PRIVACY_CONTACT",
        message: "Kontak privasi maksimal 254 karakter.",
      },
    };
  }
  if (/[<>]/.test(trimmed)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_PRIVACY_CONTACT",
        message: "Kontak privasi tidak boleh mengandung tag HTML.",
      },
    };
  }

  // Case 1: Email address
  if (trimmed.includes("@") && !trimmed.includes("://")) {
    const emailParsed = EmailSchema.safeParse(trimmed.toLowerCase());
    if (!emailParsed.success) {
      return {
        ok: false,
        issue: {
          field,
          code: "INVALID_PRIVACY_CONTACT",
          message: "Format email kontak privasi tidak valid.",
        },
      };
    }
    return { ok: true, value: emailParsed.data };
  }

  // Case 2: URL (strictly public HTTPS via link-sanitizer)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      const safe = sanitizeExternalLink(trimmed).href;
      return { ok: true, value: safe };
    } catch (err) {
      return {
        ok: false,
        issue: {
          field,
          code: "INVALID_PRIVACY_CONTACT",
          message:
            err instanceof ExternalLinkValidationError
              ? err.message
              : "Tautan kontak privasi harus menggunakan HTTPS publik yang valid.",
        },
      };
    }
  }

  // Case 3: Indonesian WhatsApp or phone number
  if (/^[0-9+ ().-]+$/.test(trimmed)) {
    try {
      const wa = normalizeIndonesianWhatsAppNumber(trimmed);
      return { ok: true, value: wa };
    } catch (err) {
      if (!(err instanceof WhatsAppValidationError)) {
        // fall through to landline phone check
      }
      const compact = trimmed.replace(/[ ().-]/g, "");
      let digits = compact.startsWith("+") ? compact.slice(1) : compact;
      if (!compact.startsWith("+") && digits.startsWith("0")) {
        digits = `62${digits.slice(1)}`;
      }
      const parsed = NormalizedPhoneSchema.safeParse(digits);
      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }
    }
  }

  return {
    ok: false,
    issue: {
      field,
      code: "INVALID_PRIVACY_CONTACT",
      message:
        "Kontak privasi harus berupa alamat email (contoh: privasi@bisnis.id), nomor WhatsApp/telepon Indonesia, atau tautan HTTPS.",
    },
  };
}

export function validateClosedDays(
  rawValue: unknown,
  field = "businessProfile.closedDays",
):
  | { readonly ok: true; readonly value: readonly BusinessWeekdayKey[] }
  | { readonly ok: false; readonly issue: CredentialValidationIssue } {
  if (rawValue === undefined || rawValue === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(rawValue)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CLOSED_DAYS",
        message: "closedDays harus berupa daftar hari (array).",
      },
    };
  }
  if (rawValue.length > 7) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CLOSED_DAYS",
        message: "closedDays maksimal berisi 7 hari.",
      },
    };
  }

  const seen = new Set<BusinessWeekdayKey>();
  for (let i = 0; i < rawValue.length; i += 1) {
    const entry = rawValue[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        issue: {
          field: `${field}[${i}]`,
          code: "INVALID_CLOSED_DAYS",
          message: "Setiap hari tutup harus berupa nama hari yang valid (monday..sunday).",
        },
      };
    }
    const lower = entry.trim().toLowerCase();
    if (!CLOSED_DAY_SET.has(lower)) {
      return {
        ok: false,
        issue: {
          field: `${field}[${i}]`,
          code: "INVALID_CLOSED_DAYS",
          message: `Hari tutup "${entry}" tidak valid. Gunakan monday..sunday.`,
        },
      };
    }
    seen.add(lower as BusinessWeekdayKey);
  }

  // Canonical Mon..Sun ordering
  const ordered = ALLOWED_CLOSED_DAYS.filter((day) => seen.has(day));
  return { ok: true, value: ordered };
}

export function validateStructuredProfileExtension(
  rawInput: Record<string, unknown>,
  base?: BusinessProfileStructuredExtension | null,
):
  | { readonly ok: true; readonly value: BusinessProfileStructuredExtension }
  | { readonly ok: false; readonly issues: readonly CredentialValidationIssue[] } {
  const defaults: BusinessProfileStructuredExtension = base ?? {
    legalName: null,
    privacyContact: null,
    personRoleTitle: null,
    affiliatedOrgName: null,
    closedDays: [],
    credentials: {},
  };

  const issues: CredentialValidationIssue[] = [];

  const legalNameRes = Object.prototype.hasOwnProperty.call(rawInput, "legalName")
    ? validateOptionalBoundedLabel(
        rawInput.legalName,
        "businessProfile.legalName",
        160,
        "INVALID_LEGAL_NAME",
      )
    : { ok: true as const, value: defaults.legalName };
  if (!legalNameRes.ok) issues.push(legalNameRes.issue);

  const privacyRes = Object.prototype.hasOwnProperty.call(rawInput, "privacyContact")
    ? validatePrivacyContact(rawInput.privacyContact, "businessProfile.privacyContact")
    : { ok: true as const, value: defaults.privacyContact };
  if (!privacyRes.ok) issues.push(privacyRes.issue);

  const roleRes = Object.prototype.hasOwnProperty.call(rawInput, "personRoleTitle")
    ? validateOptionalBoundedLabel(
        rawInput.personRoleTitle,
        "businessProfile.personRoleTitle",
        120,
        "INVALID_ROLE_TITLE",
      )
    : { ok: true as const, value: defaults.personRoleTitle };
  if (!roleRes.ok) issues.push(roleRes.issue);

  const affRes = Object.prototype.hasOwnProperty.call(rawInput, "affiliatedOrgName")
    ? validateOptionalBoundedLabel(
        rawInput.affiliatedOrgName,
        "businessProfile.affiliatedOrgName",
        160,
        "INVALID_AFFILIATED_ORG",
      )
    : { ok: true as const, value: defaults.affiliatedOrgName };
  if (!affRes.ok) issues.push(affRes.issue);

  const closedRes = Object.prototype.hasOwnProperty.call(rawInput, "closedDays")
    ? validateClosedDays(rawInput.closedDays, "businessProfile.closedDays")
    : { ok: true as const, value: defaults.closedDays };
  if (!closedRes.ok) issues.push(closedRes.issue);

  const credRes = Object.prototype.hasOwnProperty.call(rawInput, "credentials")
    ? validateIndonesianCredentials(rawInput.credentials, "businessProfile.credentials")
    : { ok: true as const, value: defaults.credentials };
  if (!credRes.ok) issues.push(...credRes.issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      legalName: legalNameRes.ok ? legalNameRes.value : defaults.legalName,
      privacyContact: privacyRes.ok ? privacyRes.value : defaults.privacyContact,
      personRoleTitle: roleRes.ok ? roleRes.value : defaults.personRoleTitle,
      affiliatedOrgName: affRes.ok ? affRes.value : defaults.affiliatedOrgName,
      closedDays: closedRes.ok ? closedRes.value : defaults.closedDays,
      credentials: credRes.ok ? credRes.value : defaults.credentials,
    },
  };
}
