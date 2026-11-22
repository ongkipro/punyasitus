/**
 * Privacy, consent preference cookie (`__Host-ps_consent`), vendor/map gating,
 * and ad-provider PII/query redaction primitives (TASK-031, REQ-039, PLAN §3.2 & §7.3, DEC-041).
 */

export const CONSENT_COOKIE_NAME = "__Host-ps_consent" as const;
export const CONSENT_POLICY_VERSION = 1 as const;
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days

export const OPTIONAL_CONSENT_CATEGORIES = ["analytics", "marketing", "maps"] as const;
export type OptionalConsentCategory = (typeof OPTIONAL_CONSENT_CATEGORIES)[number];
export type VendorTrackerCategory = "analytics" | "marketing";

export interface ConsentPreferences {
  readonly version: number;
  readonly analytics: boolean;
  readonly marketing: boolean;
  readonly maps: boolean;
  readonly updatedAt: string;
}

export interface ParsedConsentState {
  readonly hasDecision: boolean;
  readonly needsReconsent: boolean;
  readonly preferences: ConsentPreferences;
}

export interface ParseConsentCookieOptions {
  readonly expectedVersion?: number;
  readonly cookieName?: string;
}

export interface SerializeConsentCookieOptions {
  readonly cookieName?: string;
  readonly maxAgeSeconds?: number;
  readonly sameSite?: "Lax" | "Strict";
}

export interface WithdrawConsentResult {
  readonly preferences: ConsentPreferences;
  readonly setCookie: string;
}

export interface SetCookieValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_PATTERN = /(?:\+62|62|08)[0-9\s().-]{7,18}/g;

const FORBIDDEN_VENDOR_FIELD_NAMES = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "phone",
  "phonee164",
  "phonenumber",
  "mobile",
  "whatsapp",
  "wa",
  "tel",
  "telephone",
  "email",
  "emailaddress",
  "message",
  "pesan",
  "body",
  "comment",
  "notes",
  "internalnotes",
  "address",
  "alamat",
  "query",
  "querystring",
  "search",
  "searchparams",
  "rawurl",
  "cookie",
  "cookies",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "ip",
  "ipaddress",
  "useragent",
  "lead",
  "leads",
  "leadfields",
  "formdata",
  "fields",
  "submission",
  "customer",
  "contact",
  "preferreddate",
  "preferredtime",
  "branch",
  "utm",
  "utmsource",
  "utmmedium",
  "utmcampaign",
  "utmterm",
  "utmcontent",
  "gclid",
  "fbclid",
  "ttclid",
]);

const ALLOWED_VENDOR_EVENT_KEYS = new Set([
  "event_name",
  "event_id",
  "page_path",
  "page_url",
  "offering_type",
  "cta_mode",
  "source_category",
  "content_category",
  "currency",
  "value",
]);

const URL_VALUE_KEYS = new Set(["page_url", "page_path"]);

export function createDefaultConsentPreferences(
  version: number = CONSENT_POLICY_VERSION,
): ConsentPreferences {
  return {
    version,
    analytics: false,
    marketing: false,
    maps: false,
    updatedAt: "",
  };
}

function assertValidHostCookieName(cookieName: string): void {
  if (!cookieName.startsWith("__Host-")) {
    throw new Error(
      `Consent cookie name "${cookieName}" must use the "__Host-" prefix (PLAN §3.2, DEC-041).`,
    );
  }
  if (/[\s;,=]/.test(cookieName)) {
    throw new Error(`Consent cookie name "${cookieName}" contains invalid characters.`);
  }
}

function extractNamedCookieValue(cookieHeaderOrValue: string, cookieName: string): string | null {
  const trimmed = cookieHeaderOrValue.trim();
  if (!trimmed) return null;

  // Accept either a Cookie header (`a=1; __Host-ps_consent=...`) or raw encoded value (`%7B...` / `{...}`)
  if (trimmed.startsWith("{") || trimmed.startsWith("%7B") || trimmed.startsWith("%7b")) {
    return trimmed;
  }

  const pairs = trimmed.split(";");
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = pair.slice(0, eqIndex).trim();
    if (name === cookieName) {
      return pair.slice(eqIndex + 1).trim();
    }
  }

  return null;
}

/**
 * Parses `__Host-ps_consent` from a request `Cookie` header or raw cookie value.
 * Defaults strictly to all-false (opt-in required) whenever absent, malformed,
 * or saved against an outdated policy version.
 */
export function parseConsentCookie(
  cookieHeaderOrValue: string | null | undefined,
  options?: ParseConsentCookieOptions,
): ParsedConsentState {
  const expectedVersion = options?.expectedVersion ?? CONSENT_POLICY_VERSION;
  const cookieName = options?.cookieName ?? CONSENT_COOKIE_NAME;
  const defaultPreferences = createDefaultConsentPreferences(expectedVersion);

  if (!cookieHeaderOrValue || !cookieHeaderOrValue.trim()) {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  const rawValue = extractNamedCookieValue(cookieHeaderOrValue, cookieName);
  if (!rawValue) {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
    Object.prototype.hasOwnProperty.call(obj, "constructor") ||
    Object.prototype.hasOwnProperty.call(obj, "prototype")
  ) {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  const { version, analytics, marketing, maps, updatedAt } = obj;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof analytics !== "boolean" ||
    typeof marketing !== "boolean" ||
    typeof maps !== "boolean" ||
    typeof updatedAt !== "string" ||
    !ISO_DATE_RE.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return {
      hasDecision: false,
      needsReconsent: false,
      preferences: defaultPreferences,
    };
  }

  // Policy version mismatch never retroactively carries over prior opt-ins (PLAN §11.2).
  if (version !== expectedVersion) {
    return {
      hasDecision: false,
      needsReconsent: true,
      preferences: defaultPreferences,
    };
  }

  return {
    hasDecision: true,
    needsReconsent: false,
    preferences: {
      version,
      analytics,
      marketing,
      maps,
      updatedAt,
    },
  };
}

/**
 * Serializes a host-only `__Host-ps_consent` cookie string.
 * Enforces `__Host-` prefix, `Path=/`, `Secure`, `SameSite=Lax|Strict`, and NEVER allows `Domain=`.
 */
export function serializeConsentCookie(
  preferences: ConsentPreferences,
  options?: SerializeConsentCookieOptions,
): string {
  const cookieName = options?.cookieName ?? CONSENT_COOKIE_NAME;
  assertValidHostCookieName(cookieName);

  // Runtime defense against callers passing an untyped `domain` field
  if (
    options !== undefined &&
    "domain" in (options as Record<string, unknown>) &&
    (options as Record<string, unknown>).domain !== undefined
  ) {
    throw new Error("Tenant consent cookies must never set a Domain attribute (PLAN §3.2, DEC-041).");
  }

  if (!Number.isInteger(preferences.version) || preferences.version < 1) {
    throw new Error("Consent preference version must be a positive integer.");
  }

  const updatedAt =
    preferences.updatedAt && ISO_DATE_RE.test(preferences.updatedAt)
      ? preferences.updatedAt
      : new Date().toISOString();

  const maxAgeSeconds = options?.maxAgeSeconds ?? CONSENT_MAX_AGE_SECONDS;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new Error("Consent cookie maxAgeSeconds must be a non-negative integer.");
  }

  const sameSite = options?.sameSite ?? "Lax";
  const payload: ConsentPreferences = {
    version: preferences.version,
    analytics: Boolean(preferences.analytics),
    marketing: Boolean(preferences.marketing),
    maps: Boolean(preferences.maps),
    updatedAt,
  };

  const serialized = `${cookieName}=${encodeURIComponent(JSON.stringify(payload))}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=${sameSite}; Secure`;

  const check = validateTenantSetCookieHeader(serialized);
  if (!check.valid) {
    throw new Error(`Invalid consent Set-Cookie output: ${check.violations.join(", ")}`);
  }

  return serialized;
}

/**
 * Produces a clean consent withdrawal state (all optional categories `false`)
 * and an expiring host-only `__Host-ps_consent` `Set-Cookie` header (`Max-Age=0`, no `Domain=`).
 */
export function withdrawConsent(options?: {
  readonly version?: number;
  readonly cookieName?: string;
  readonly now?: Date;
}): WithdrawConsentResult {
  const version = options?.version ?? CONSENT_POLICY_VERSION;
  const updatedAt = (options?.now ?? new Date()).toISOString();
  const preferences: ConsentPreferences = {
    version,
    analytics: false,
    marketing: false,
    maps: false,
    updatedAt,
  };
  const setCookie = serializeConsentCookie(preferences, {
    cookieName: options?.cookieName ?? CONSENT_COOKIE_NAME,
    maxAgeSeconds: 0,
    sameSite: "Lax",
  });
  return { preferences, setCookie };
}

/**
 * Returns true ONLY when the visitor affirmatively opted into the requested optional vendor category
 * under the current policy version.
 */
export function canLoadVendorTracker(
  preferences: ConsentPreferences | null | undefined,
  category: VendorTrackerCategory,
  expectedVersion: number = CONSENT_POLICY_VERSION,
): boolean {
  if (!preferences) return false;
  if (preferences.version !== expectedVersion) return false;
  return preferences[category] === true;
}

/**
 * Returns true ONLY when the visitor affirmatively opted into interactive map embeds
 * under the current policy version.
 */
export function canLoadMapEmbed(
  preferences: ConsentPreferences | null | undefined,
  expectedVersion: number = CONSENT_POLICY_VERSION,
): boolean {
  if (!preferences) return false;
  if (preferences.version !== expectedVersion) return false;
  return preferences.maps === true;
}

/**
 * Audits any `Set-Cookie` header emitted for a tenant host against PLAN §3.2 / DEC-041:
 * - Never sets `Domain=`
 * - Consent cookies MUST use the `__Host-` prefix
 * - `__Host-` cookies MUST carry `Path=/` and `Secure`
 */
export function validateTenantSetCookieHeader(setCookieHeader: string): SetCookieValidationResult {
  const violations: string[] = [];
  const segments = setCookieHeader
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const firstSegment = segments[0] ?? "";
  const eqIndex = firstSegment.indexOf("=");
  const cookieName = eqIndex > 0 ? firstSegment.slice(0, eqIndex).trim() : "";

  if (!cookieName) {
    violations.push("MISSING_COOKIE_NAME");
  }

  let hasSecure = false;
  let hasRootPath = false;

  for (const attr of segments.slice(1)) {
    const lower = attr.toLowerCase();
    if (lower === "domain" || lower.startsWith("domain=")) {
      violations.push("FORBIDDEN_DOMAIN_ATTRIBUTE");
    } else if (lower === "secure") {
      hasSecure = true;
    } else if (lower === "path=/") {
      hasRootPath = true;
    } else if (lower.startsWith("path=")) {
      violations.push("NON_ROOT_PATH_FOR_HOST_COOKIE");
    }
  }

  if (cookieName && cookieName.toLowerCase().includes("consent") && !cookieName.startsWith("__Host-")) {
    violations.push("MISSING_HOST_PREFIX");
  }

  if (cookieName.startsWith("__Host-")) {
    if (!hasSecure) violations.push("MISSING_SECURE_ATTRIBUTE");
    if (!hasRootPath) violations.push("MISSING_ROOT_PATH");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeUrlWithoutQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) {
    return null;
  }

  if (trimmed.startsWith("/")) {
    const cleanPath = trimmed.split(/[?#]/, 1)[0] ?? "/";
    return cleanPath.startsWith("//") ? null : cleanPath;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    // Strip credentials, query string, and fragment completely
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function containsPiiPattern(value: string): boolean {
  EMAIL_PATTERN.lastIndex = 0;
  PHONE_PATTERN.lastIndex = 0;
  return EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

/**
 * Sanitizes an analytics/ad-provider event payload so lead fields, message text,
 * PII patterns, and URL query strings are NEVER forwarded to third-party ad providers (PLAN §7.3).
 */
export function sanitizeVendorEventPayload(
  input: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const normalizedKey = normalizeFieldKey(rawKey);
    if (FORBIDDEN_VENDOR_FIELD_NAMES.has(normalizedKey)) {
      continue;
    }
    if (!ALLOWED_VENDOR_EVENT_KEYS.has(rawKey)) {
      continue;
    }

    if (typeof rawValue === "boolean") {
      output[rawKey] = rawValue;
      continue;
    }

    if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue) && rawValue >= 0) {
        output[rawKey] = rawValue;
      }
      continue;
    }

    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (!trimmed) continue;

      if (URL_VALUE_KEYS.has(rawKey)) {
        const strippedUrl = sanitizeUrlWithoutQuery(trimmed);
        if (strippedUrl && !containsPiiPattern(strippedUrl)) {
          output[rawKey] = strippedUrl;
        }
        continue;
      }

      // Drop any value that looks like a query-bearing URL or embedded PII
      if (trimmed.includes("?") && (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/"))) {
        const stripped = sanitizeUrlWithoutQuery(trimmed);
        if (stripped && !containsPiiPattern(stripped)) {
          output[rawKey] = stripped;
        }
        continue;
      }

      if (containsPiiPattern(trimmed)) {
        continue;
      }

      output[rawKey] = trimmed.slice(0, 128);
    }
  }

  return output;
}
