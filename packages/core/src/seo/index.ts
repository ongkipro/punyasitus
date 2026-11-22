import { PLATFORM_HOSTS, RESERVED_HANDLES } from "../index.ts";
import type {
  OfferingSnapshot,
  PageSnapshot,
  PostSnapshot,
  PublishedResourceDto,
  SiteSettingsSnapshot,
} from "../content/index.ts";
import {
  TenantHandleSchema,
  type OfferingType,
  type TenantStatus,
} from "../schemas/common.ts";
import type { ResourceSeoInputSchema } from "../schemas/cms.ts";
import type { z } from "zod";

/**
 * Shared Published SEO Policy Engine (REQ-052, PLAN §15, REQ-095, DESIGN §9, TASK-051).
 *
 * Pure, strict-TypeScript canonical, robots/indexability, pagination, query-normalization,
 * host-origin, safe escaping, and managed robots.txt policy module consumed by:
 * - TASK-015 (Schema.org structured data)
 * - TASK-016 (Open Graph & social share metadata)
 * - TASK-017 (Tenant-scoped sitemap & robots endpoints)
 * - Public Astro route shells
 *
 * Invariants:
 * - Derives public status, indexability, canonical, social URL, and sitemap eligibility
 *   from typed published inputs ONLY — never trusting raw request Host, X-Forwarded-Host,
 *   draft content, or unvalidated overrides.
 * - Never invents a canonical URL for private, admin, auth, API, preview, draft,
 *   unpublished, trashed, error, suspended, recovery, or destroyed routes (`canonical: null`).
 * - `trial` tenants (`*.situsku.click` only) are ALWAYS `noindex, nofollow` and never sitemap-eligible.
 * - `active`, `grace` (`H+1..H+3`), and `locked` (`H+4..H+7`) tenants remain live and indexable
 *   to protect client SEO (PLAN §15, DEC-035, DESIGN §9).
 */

export type ResourceSeoOverrides = z.infer<typeof ResourceSeoInputSchema>;

/**
 * Tenant lifecycle status accepted by the SEO policy engine.
 * Includes `"destroyed"` as an explicit alias for `"purged"` (DESIGN §9).
 */
export type SeoTenantStatus = TenantStatus | "destroyed";

export type SeoHostKind = "subdomain" | "custom";
export type SeoHostStatus = "pending" | "active" | "failed" | "moved" | "deleting";
export type AiTrainingPolicy = "allow" | "disallow";
export type SiteVisibility = "public" | "noindex";

export type SeoRouteKind =
  | "homepage"
  | "page"
  | "post"
  | "offering"
  | "blog_index"
  | "catalog_index"
  | "category_archive"
  | "tag_archive"
  | "offering_category_archive"
  | "search_or_filter"
  | "former_slug"
  | "homepage_slug_alias"
  | "preview"
  | "admin"
  | "auth"
  | "api"
  | "private"
  | "error_404"
  | "error_500"
  | "error_503"
  | "unknown_host";

export type SeoSurface =
  | "public_tenant"
  | "marketing"
  | "app"
  | "console"
  | "preview"
  | "api"
  | "error";

export type SeoResourcePublicationState =
  | "published"
  | "draft"
  | "unpublished"
  | "trashed"
  | "missing"
  | "disabled";

export type SeoDecisionReason =
  | "indexable_published"
  | "private_or_preview_route"
  | "unknown_or_unverified_host"
  | "error_route"
  | "tenant_not_found_or_destroyed"
  | "tenant_suspended"
  | "tenant_recovery"
  | "trial_tenant_noindex"
  | "resource_not_published"
  | "invalid_pagination"
  | "out_of_range_pagination"
  | "faceted_filter_noindex"
  | "search_or_filter_noindex"
  | "empty_archive_noindex"
  | "empty_taxonomy_noindex"
  | "taxonomy_default_noindex"
  | "site_wide_noindex"
  | "resource_noindex"
  | "former_slug_redirect"
  | "homepage_slug_redirect"
  | "alias_host_redirect";

export type SeoPolicyErrorCode =
  | "INVALID_TENANT_HANDLE"
  | "INVALID_ORIGIN"
  | "UNSUPPORTED_SCHEME"
  | "MALICIOUS_HOST"
  | "EMBEDDED_CREDENTIALS"
  | "FORBIDDEN_PORT"
  | "CONTROL_CHARACTER"
  | "PATH_OR_QUERY_SMUGGLING"
  | "CROSS_ORIGIN_CANONICAL"
  | "INVALID_CANONICAL_OVERRIDE"
  | "INVALID_PATH";

export class SeoPolicyError extends Error {
  readonly code: SeoPolicyErrorCode;

  constructor(code: SeoPolicyErrorCode, message: string) {
    super(message);
    this.name = "SeoPolicyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Policy Constants (PLAN §15, REQ-095)
// ---------------------------------------------------------------------------

export const MAX_SEO_TITLE_LENGTH = 70 as const;
export const MAX_SEO_DESCRIPTION_LENGTH = 160 as const;
export const MAX_CANONICAL_URL_LENGTH = 2048 as const;
export const MAX_PAGINATION_PAGE = 100_000 as const;

export const INDEXABLE_ROBOTS_DIRECTIVES =
  "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" as const;

export const INDEXABLE_NOFOLLOW_ROBOTS_DIRECTIVES =
  "index, nofollow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" as const;

/**
 * Search and user-triggered AI fetchers explicitly allowed for indexable paid sites (REQ-095).
 */
export const ALLOWED_SEARCH_AND_AI_FETCHERS = [
  "Googlebot",
  "Bingbot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot",
] as const;

/**
 * Training-only AI crawlers governed by the owner's `aiTrainingPolicy` toggle (REQ-095).
 */
export const AI_TRAINING_ONLY_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "Applebot-Extended",
] as const;

/**
 * Non-public / administrative prefixes disallowed in managed robots.txt.
 */
export const MANAGED_PRIVATE_DISALLOW_PATHS = [
  "/api/",
  "/dashboard/",
  "/preview",
] as const;

/**
 * Multi-parameter faceted filter patterns disallowed in robots.txt (REQ-095, SRC-98).
 * Blocks `/kendaraan?a=1&b=2` and `/produk?a=1&b=2` without blocking `/kendaraan?page=2`.
 */
export const FACETED_FILTER_DISALLOW_PATTERNS = [
  "/kendaraan?*&*",
  "/produk?*&*",
] as const;

/**
 * Base paths where multi-parameter faceted filters trigger `noindex, follow` +
 * base archive canonical (REQ-095, SRC-98).
 */
export const FACETED_ARCHIVE_PATHS = new Set<string>(["/kendaraan", "/produk"]);

/**
 * Private / platform / auth path prefixes that MUST NEVER receive a public canonical
 * or be marked indexable on any host.
 */
const PRIVATE_ROUTE_PREFIXES = [
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/api",
  "/preview",
  "/admin",
  "/_astro",
] as const;

/**
 * Tracking query keys stripped from canonical, OG, and internal URLs (PLAN §15.2).
 * Any `utm_*` key is also stripped dynamically.
 */
const TRACKING_QUERY_KEYS = new Set<string>([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "yclid",
  "dclid",
  "ref",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "si",
]);

/**
 * Recognized search / filter / sort query keys for archive filtering and faceted URLs.
 */
const FILTER_AND_SEARCH_QUERY_KEYS = new Set<string>([
  "q",
  "search",
  "sort",
  "order",
  "orderby",
  "dir",
  "filter",
  "brand",
  "merek",
  "merk",
  "model",
  "variant",
  "varian",
  "year",
  "tahun",
  "condition",
  "kondisi",
  "transmission",
  "transmisi",
  "fuel",
  "bahan_bakar",
  "body_type",
  "tipe_bodi",
  "color",
  "warna",
  "seats",
  "kursi",
  "location",
  "lokasi",
  "category",
  "kategori",
  "tag",
  "status",
  "unit_status",
  "price",
  "harga",
  "min_price",
  "max_price",
  "price_min",
  "price_max",
  "type",
  "tipe",
  "badge",
  "negotiable",
  "nego",
]);

const FORBIDDEN_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "localdomain",
  "home.arpa",
] as const;

const ARCHIVE_ROUTE_KINDS = new Set<SeoRouteKind>([
  "blog_index",
  "catalog_index",
  "category_archive",
  "tag_archive",
  "offering_category_archive",
]);

const TAXONOMY_ARCHIVE_ROUTE_KINDS = new Set<SeoRouteKind>([
  "category_archive",
  "tag_archive",
  "offering_category_archive",
]);

const OFFERING_BASE_PATH_BY_TYPE: Readonly<Record<OfferingType, string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

// ---------------------------------------------------------------------------
// Internal Validation Helpers
// ---------------------------------------------------------------------------

function hasAsciiControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function stripAsciiControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      out += " ";
    } else {
      out += value[i] ?? "";
    }
  }
  return out;
}

function isIpv4Literal(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 1 || labels.length > 4) {
    return false;
  }
  // Reject dotted-decimal (127.0.0.1), shorthand (127.1, 10.1, 1.1),
  // octal (0177.1, 0177.0.0.1), hex (0x7f.1, 0x7f.0.0.1), and integer IPv4 encodings.
  return labels.every((label) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(label));
}

function isIpv6Literal(host: string): boolean {
  return host.includes(":") || host.startsWith("[") || host.endsWith("]");
}

function isPlatformOrForbiddenHost(hostname: string): boolean {
  if (
    hostname === PLATFORM_HOSTS.marketing ||
    hostname.endsWith(`.${PLATFORM_HOSTS.marketing}`) ||
    hostname === PLATFORM_HOSTS.saasZone
  ) {
    return true;
  }
  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  return false;
}

function isPrivateRoutePath(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  for (const prefix of PRIVATE_ROUTE_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function isTrackingQueryKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase();
  return key.startsWith("utm_") || TRACKING_QUERY_KEYS.has(key);
}

function isFilterOrSearchQueryKey(rawKey: string): boolean {
  return FILTER_AND_SEARCH_QUERY_KEYS.has(rawKey.toLowerCase());
}

function normalizeTenantStatus(status: SeoTenantStatus, operatorHold?: boolean): TenantStatus {
  const mapped: TenantStatus = status === "destroyed" ? "purged" : status;
  if (
    mapped === "provisioning" ||
    mapped === "purging" ||
    mapped === "purged"
  ) {
    return mapped;
  }
  if (operatorHold) {
    return "suspended";
  }
  return mapped;
}

export function isIndexableTenantStatus(status: SeoTenantStatus, operatorHold?: boolean): boolean {
  const effective = normalizeTenantStatus(status, operatorHold);
  return effective === "active" || effective === "grace" || effective === "locked";
}

export function isServingTenantStatus(status: SeoTenantStatus, operatorHold?: boolean): boolean {
  const effective = normalizeTenantStatus(status, operatorHold);
  return (
    effective === "trial" ||
    effective === "active" ||
    effective === "grace" ||
    effective === "locked"
  );
}

// ---------------------------------------------------------------------------
// 1. Verified Primary Origin Resolution
// ---------------------------------------------------------------------------

/**
 * Strictly validates a bare canonical hostname (no scheme, port, userinfo, path,
 * query, fragment, IP literal, localhost/internal domain, or platform host).
 * Returns normalized lowercase FQDN.
 */
export function validateCanonicalHostname(rawHost: string): string {
  if (typeof rawHost !== "string") {
    throw new SeoPolicyError("INVALID_ORIGIN", "Canonical hostname must be a string.");
  }
  if (hasAsciiControlChars(rawHost)) {
    throw new SeoPolicyError(
      "CONTROL_CHARACTER",
      "Canonical hostname must not contain ASCII control characters or CRLF.",
    );
  }
  const trimmed = rawHost.trim();
  if (trimmed.length === 0) {
    throw new SeoPolicyError("INVALID_ORIGIN", "Canonical hostname cannot be empty.");
  }

  if (/\s/.test(trimmed)) {
    throw new SeoPolicyError("PATH_OR_QUERY_SMUGGLING", "Canonical hostname must not contain whitespace.");
  }

  // Reject explicit URI schemes (javascript:, http://, https://, data:, vbscript:, etc.)
  if (
    /^(?:https?|javascript|data|vbscript|file|ftp):/i.test(trimmed) ||
    trimmed.includes("://")
  ) {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    const scheme = schemeMatch?.[1]?.toLowerCase() ?? "unknown";
    throw new SeoPolicyError(
      "UNSUPPORTED_SCHEME",
      `Canonical hostname must not include a scheme ('${scheme}:').`,
    );
  }

  if (trimmed.includes("@")) {
    throw new SeoPolicyError(
      "EMBEDDED_CREDENTIALS",
      "Canonical hostname must not contain embedded userinfo credentials.",
    );
  }
  if (/[/?#\\<>"]/.test(trimmed)) {
    throw new SeoPolicyError(
      "PATH_OR_QUERY_SMUGGLING",
      "Canonical hostname must not contain path, query, fragment, or backslash characters.",
    );
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/:\d+$/.test(trimmed)) {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    const scheme = schemeMatch?.[1]?.toLowerCase() ?? "unknown";
    throw new SeoPolicyError(
      "UNSUPPORTED_SCHEME",
      `Canonical hostname must not include a scheme ('${scheme}:').`,
    );
  }
  if (trimmed.includes("*")) {
    throw new SeoPolicyError("MALICIOUS_HOST", "Wildcard hostnames are forbidden.");
  }
  if (isIpv6Literal(trimmed)) {
    // Could be hostname:port or IPv6 literal
    if (/^[a-z0-9.-]+:\d+$/i.test(trimmed)) {
      throw new SeoPolicyError(
        "FORBIDDEN_PORT",
        "Canonical hostname must not include an explicit port.",
      );
    }
    throw new SeoPolicyError("MALICIOUS_HOST", "IPv6 literals and colons are forbidden in canonical hostnames.");
  }

  const normalized = trimmed.toLowerCase().replace(/\.$/, "");
  if (normalized.length === 0 || normalized.length > 253) {
    throw new SeoPolicyError("INVALID_ORIGIN", "Canonical hostname length is out of bounds.");
  }
  if (isIpv4Literal(normalized)) {
    throw new SeoPolicyError("MALICIOUS_HOST", "IPv4 literals are forbidden in canonical hostnames.");
  }
  if (!normalized.includes(".")) {
    throw new SeoPolicyError("MALICIOUS_HOST", "Single-label/dotless hostnames are forbidden.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new SeoPolicyError("MALICIOUS_HOST", `Malformed canonical hostname '${normalized}'.`);
  }
  const labels = normalized.split(".");
  const tld = labels[labels.length - 1] ?? "";
  const isValidTld =
    /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/.test(tld);
  if (!isValidTld) {
    throw new SeoPolicyError(
      "MALICIOUS_HOST",
      `Canonical hostname '${normalized}' must end with a valid RFC TLD label.`,
    );
  }
  if (isPlatformOrForbiddenHost(normalized)) {
    throw new SeoPolicyError(
      "MALICIOUS_HOST",
      `Host '${normalized}' is a platform, local, or forbidden hostname.`,
    );
  }

  const saasSuffix = `.${PLATFORM_HOSTS.saasZone}`;
  if (normalized.endsWith(saasSuffix)) {
    const label = normalized.slice(0, -saasSuffix.length);
    if (!label || label.includes(".") || RESERVED_HANDLES.has(label)) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Reserved or nested SaaS subdomain '${normalized}' is forbidden.`,
      );
    }
  }

  return normalized;
}

/**
 * Strictly validates an `https://<hostname>` origin string.
 * Rejects `http://`, `javascript:`, ports, userinfo, CRLF, path/query/fragment smuggling,
 * IP literals, private/platform hosts, and (when `expectedOrigin` is provided) foreign hosts.
 */
export function validateCanonicalOrigin(rawOrigin: string, expectedOrigin?: string): string {
  if (typeof rawOrigin !== "string") {
    throw new SeoPolicyError("INVALID_ORIGIN", "Origin must be a string.");
  }
  if (hasAsciiControlChars(rawOrigin)) {
    throw new SeoPolicyError(
      "CONTROL_CHARACTER",
      "Origin must not contain ASCII control characters or CRLF.",
    );
  }
  const trimmed = rawOrigin.trim();
  if (trimmed.length === 0) {
    throw new SeoPolicyError("INVALID_ORIGIN", "Origin cannot be empty.");
  }
  if (!/^https:\/\//i.test(trimmed)) {
    throw new SeoPolicyError(
      "UNSUPPORTED_SCHEME",
      "Canonical origin must use strictly https://.",
    );
  }

  const afterScheme = trimmed.slice(8);
  if (afterScheme.length === 0) {
    throw new SeoPolicyError("INVALID_ORIGIN", "Origin is missing a hostname.");
  }
  if (afterScheme.includes("@")) {
    throw new SeoPolicyError(
      "EMBEDDED_CREDENTIALS",
      "Canonical origin must not contain embedded userinfo credentials.",
    );
  }
  if (/[/?#\\<>"]/.test(afterScheme) || /\s/.test(afterScheme)) {
    throw new SeoPolicyError(
      "PATH_OR_QUERY_SMUGGLING",
      "Canonical origin must not contain path, query, fragment, whitespace, or backslash characters.",
    );
  }

  const hostname = validateCanonicalHostname(afterScheme);
  const origin = `https://${hostname}`;

  if (expectedOrigin !== undefined) {
    const normalizedExpected = expectedOrigin.toLowerCase();
    if (origin !== normalizedExpected) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Foreign origin '${origin}' does not match verified primary origin '${normalizedExpected}'.`,
      );
    }
  }

  return origin;
}

export interface VerifiedTenantHostInput {
  readonly tenantHandle: string;
  readonly tenantStatus: SeoTenantStatus;
  readonly operatorHold?: boolean;
  /**
   * Authoritative active primary host from `PLATFORM_DB` (`tenant_hosts`).
   * NEVER pass raw request `Host` or `X-Forwarded-Host` here.
   */
  readonly primaryHost?: string | null;
  readonly primaryHostKind?: SeoHostKind | null;
  readonly primaryHostStatus?: SeoHostStatus | null;
  readonly primaryHostSslStatus?: string | null;
  readonly primaryHostVerified?: boolean;
  /**
   * Optional allowlist of verified active hostnames owned by this tenant
   * (e.g. from `PLATFORM_DB.tenant_hosts`). When provided, any `primaryHost`
   * not present in this set is rejected as a foreign host.
   */
  readonly verifiedTenantHosts?: ReadonlySet<string> | readonly string[];
  /**
   * Optional verified hostname currently serving this request (from authoritative
   * `tenant_hosts` resolution) so alias requests can emit canonical -> primary
   * and 301 redirect signals without duplicating sitemap entries.
   */
  readonly servingHost?: string | null;
}

export interface VerifiedCanonicalOrigin {
  readonly origin: string;
  readonly hostname: string;
  readonly hostKind: SeoHostKind;
  readonly fallbackSubdomain: string;
  readonly isAliasRequest: boolean;
  readonly aliasRedirectStatus: 301 | null;
}

/**
 * Resolves the authoritative `https://` primary canonical origin for a tenant from
 * typed `PLATFORM_DB` host state ONLY.
 *
 * - Uses verified active custom domain when paid (`active`/`grace`/`locked`) and active/SSL-verified.
 * - Falls back to `https://<handle>.situsku.click` for `trial` tenants or when no custom domain is active/verified.
 * - Rejects malicious host strings (`javascript:`, `http://`, IP literals, ports, userinfo,
 *   CRLF, path/query smuggling, platform hosts, and foreign tenant subdomains) with `SeoPolicyError`.
 */
export function resolveVerifiedCanonicalOrigin(
  input: VerifiedTenantHostInput,
): VerifiedCanonicalOrigin {
  const handleResult = TenantHandleSchema.safeParse(input.tenantHandle);
  if (!handleResult.success) {
    throw new SeoPolicyError(
      "INVALID_TENANT_HANDLE",
      `Invalid tenant handle '${String(input.tenantHandle)}'.`,
    );
  }
  const handle = handleResult.data;
  const fallbackSubdomain = `${handle}.${PLATFORM_HOSTS.saasZone}`;
  const effectiveStatus = normalizeTenantStatus(input.tenantStatus, input.operatorHold);

  const allowedSet =
    input.verifiedTenantHosts !== undefined
      ? new Set(Array.from(input.verifiedTenantHosts, (h) => h.trim().toLowerCase()))
      : null;

  let resolvedHostname = fallbackSubdomain;
  let resolvedKind: SeoHostKind = "subdomain";

  if (input.primaryHost !== undefined && input.primaryHost !== null && input.primaryHost !== "") {
    const validatedHost = validateCanonicalHostname(input.primaryHost);

    // Reject another tenant's *.situsku.click subdomain unconditionally!
    const saasSuffix = `.${PLATFORM_HOSTS.saasZone}`;
    if (validatedHost.endsWith(saasSuffix) && validatedHost !== fallbackSubdomain) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Foreign tenant subdomain '${validatedHost}' cannot be primary for handle '${handle}'.`,
      );
    }

    // If caller supplied verifiedTenantHosts allowlist, reject foreign hosts!
    if (allowedSet !== null && !allowedSet.has(validatedHost) && validatedHost !== fallbackSubdomain) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Foreign host '${validatedHost}' is not in verified hosts for tenant '${handle}'.`,
      );
    }

    const isCustom = validatedHost !== fallbackSubdomain;
    const isPaidServingStatus =
      effectiveStatus === "active" ||
      effectiveStatus === "grace" ||
      effectiveStatus === "locked";
    const statusActive = input.primaryHostStatus === "active";
    const sslActive = input.primaryHostSslStatus === "active";
    const explicitlyVerified = input.primaryHostVerified === true;
    const kindEligible = input.primaryHostKind !== "subdomain";
    const inVerifiedTenantHosts = allowedSet !== null && allowedSet.has(validatedHost);
    const isVerifiedAndActive =
      isPaidServingStatus &&
      statusActive &&
      sslActive &&
      explicitlyVerified &&
      kindEligible &&
      inVerifiedTenantHosts;

    if (isCustom) {
      // Fail closed: custom domains require active paid status, active host & SSL,
      // explicit verification, non-subdomain kind, and membership in verifiedTenantHosts.
      if (isVerifiedAndActive) {
        resolvedHostname = validatedHost;
        resolvedKind = "custom";
      }
    } else {
      resolvedHostname = fallbackSubdomain;
      resolvedKind = "subdomain";
    }
  }

  let isAliasRequest = false;
  if (input.servingHost !== undefined && input.servingHost !== null && input.servingHost !== "") {
    const validatedServing = validateCanonicalHostname(input.servingHost);
    // Reject another tenant's subdomain as serving host
    const saasSuffix = `.${PLATFORM_HOSTS.saasZone}`;
    if (validatedServing.endsWith(saasSuffix) && validatedServing !== fallbackSubdomain) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Foreign tenant subdomain '${validatedServing}' cannot serve tenant '${handle}'.`,
      );
    }
    if (allowedSet !== null && !allowedSet.has(validatedServing) && validatedServing !== fallbackSubdomain) {
      throw new SeoPolicyError(
        "MALICIOUS_HOST",
        `Foreign serving host '${validatedServing}' is not verified for tenant '${handle}'.`,
      );
    }
    if (validatedServing !== resolvedHostname) {
      isAliasRequest = true;
    }
  }

  return {
    origin: `https://${resolvedHostname}`,
    hostname: resolvedHostname,
    hostKind: resolvedKind,
    fallbackSubdomain,
    isAliasRequest,
    aliasRedirectStatus: isAliasRequest ? 301 : null,
  };
}

// ---------------------------------------------------------------------------
// 2. Path, Pagination, Query & Canonical Override Normalization
// ---------------------------------------------------------------------------

export function normalizePublicPath(rawPathname: string): {
  readonly normalizedPath: string;
  readonly changed: boolean;
} {
  if (typeof rawPathname !== "string") {
    throw new SeoPolicyError("INVALID_PATH", "Pathname must be a string.");
  }
  if (hasAsciiControlChars(rawPathname)) {
    throw new SeoPolicyError(
      "CONTROL_CHARACTER",
      "Pathname must not contain ASCII control characters.",
    );
  }
  if (/[\\<>"]/.test(rawPathname) || /\s/.test(rawPathname)) {
    throw new SeoPolicyError(
      "PATH_OR_QUERY_SMUGGLING",
      "Pathname contains forbidden characters.",
    );
  }
  if (rawPathname.includes("?") || rawPathname.includes("#")) {
    throw new SeoPolicyError(
      "PATH_OR_QUERY_SMUGGLING",
      "Pathname must not include raw query or fragment delimiters; pass query separately.",
    );
  }

  const trimmed = rawPathname.trim();
  const withLeadingSlash = trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

  // Reject dot-segment traversal (/../ or /./)
  const rawSegments = withLeadingSlash.split("/");
  for (const seg of rawSegments) {
    if (seg === ".." || seg === ".") {
      throw new SeoPolicyError(
        "PATH_OR_QUERY_SMUGGLING",
        "Path traversal dot segments are forbidden.",
      );
    }
  }

  // Collapse repeated slashes, lowercase ASCII, strip trailing slash except root
  let collapsed = withLeadingSlash.replace(/\/{2,}/g, "/").toLowerCase();
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    collapsed = collapsed.slice(0, -1);
  }

  const changed = collapsed !== withLeadingSlash;
  return { normalizedPath: collapsed, changed };
}

/**
 * Validates an optional owner `canonicalOverride`.
 * MUST resolve to `https://` on the tenant's verified primary origin with a safe
 * normalized public path. Rejects cross-origin, non-HTTPS, script/data URIs,
 * private/admin paths, credentials, ports, and control characters.
 */
export function validateCanonicalOverride(
  rawOverride: string,
  verifiedPrimaryOrigin: string,
): string {
  const verifiedOrigin = validateCanonicalOrigin(verifiedPrimaryOrigin);

  if (typeof rawOverride !== "string") {
    throw new SeoPolicyError("INVALID_CANONICAL_OVERRIDE", "canonicalOverride must be a string.");
  }
  if (hasAsciiControlChars(rawOverride)) {
    throw new SeoPolicyError(
      "CONTROL_CHARACTER",
      "canonicalOverride must not contain ASCII control characters.",
    );
  }
  const trimmed = rawOverride.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CANONICAL_URL_LENGTH) {
    throw new SeoPolicyError(
      "INVALID_CANONICAL_OVERRIDE",
      "canonicalOverride must be 1..2048 characters.",
    );
  }
  if (trimmed.startsWith("//") || /[\\<>"]/.test(trimmed) || /\s/.test(trimmed)) {
    throw new SeoPolicyError(
      "INVALID_CANONICAL_OVERRIDE",
      "canonicalOverride contains unsafe characters or protocol-relative prefix.",
    );
  }

  let parsed: URL;
  let rawPathPart: string;
  if (trimmed.startsWith("/")) {
    const qOrHash = trimmed.search(/[?#]/);
    rawPathPart = qOrHash === -1 ? trimmed : trimmed.slice(0, qOrHash);
    try {
      parsed = new URL(trimmed, verifiedOrigin);
    } catch {
      throw new SeoPolicyError("INVALID_CANONICAL_OVERRIDE", "Malformed relative canonicalOverride.");
    }
  } else {
    if (!/^https:\/\//i.test(trimmed)) {
      throw new SeoPolicyError(
        "UNSUPPORTED_SCHEME",
        "canonicalOverride must use https:// on the verified primary origin.",
      );
    }
    // Check raw authority for embedded credentials or explicit port before URL normalization
    const afterScheme = trimmed.slice(8);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
    const restAfterAuthority = authorityEnd === -1 ? "/" : afterScheme.slice(authorityEnd);
    const qOrHash = restAfterAuthority.search(/[?#]/);
    rawPathPart = qOrHash === -1 ? restAfterAuthority : restAfterAuthority.slice(0, qOrHash);
    if (rawAuthority.includes("@")) {
      throw new SeoPolicyError(
        "EMBEDDED_CREDENTIALS",
        "canonicalOverride must not contain embedded credentials.",
      );
    }
    if (rawAuthority.includes(":")) {
      throw new SeoPolicyError(
        "FORBIDDEN_PORT",
        "canonicalOverride must not specify an explicit port.",
      );
    }
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new SeoPolicyError("INVALID_CANONICAL_OVERRIDE", "Malformed canonicalOverride URL.");
    }
  }

  // Reject dot-segment traversal before WHATWG URL normalization hides it
  for (const seg of rawPathPart.split("/")) {
    if (seg === ".." || seg === ".") {
      throw new SeoPolicyError(
        "PATH_OR_QUERY_SMUGGLING",
        "canonicalOverride must not contain path traversal dot segments.",
      );
    }
  }

  if (parsed.protocol !== "https:") {
    throw new SeoPolicyError("UNSUPPORTED_SCHEME", "canonicalOverride must use https://.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SeoPolicyError("EMBEDDED_CREDENTIALS", "canonicalOverride must not contain credentials.");
  }
  if (parsed.port !== "") {
    throw new SeoPolicyError("FORBIDDEN_PORT", "canonicalOverride must not contain a port.");
  }

  const parsedOrigin = validateCanonicalOrigin(`https://${parsed.hostname}`);
  if (parsedOrigin !== verifiedOrigin) {
    throw new SeoPolicyError(
      "CROSS_ORIGIN_CANONICAL",
      `Cross-origin canonicalOverride '${parsedOrigin}' rejected (expected '${verifiedOrigin}').`,
    );
  }

  const { normalizedPath } = normalizePublicPath(parsed.pathname);
  if (isPrivateRoutePath(normalizedPath)) {
    throw new SeoPolicyError(
      "INVALID_CANONICAL_OVERRIDE",
      `canonicalOverride cannot point to a private/admin/API route '${normalizedPath}'.`,
    );
  }

  // Strip fragments and tracking params; retain validated page >= 2 only if present
  const pageValues = parsed.searchParams.getAll("page");
  let querySuffix = "";
  if (pageValues.length > 1) {
    throw new SeoPolicyError(
      "INVALID_CANONICAL_OVERRIDE",
      "canonicalOverride cannot contain duplicate page parameters.",
    );
  }
  if (pageValues.length === 1) {
    const rawPage = pageValues[0] ?? "";
    if (!/^[1-9]\d*$/.test(rawPage)) {
      throw new SeoPolicyError(
        "INVALID_CANONICAL_OVERRIDE",
        "canonicalOverride has invalid page parameter.",
      );
    }
    const pageNum = Number(rawPage);
    if (!Number.isSafeInteger(pageNum) || pageNum > MAX_PAGINATION_PAGE) {
      throw new SeoPolicyError(
        "INVALID_CANONICAL_OVERRIDE",
        "canonicalOverride page parameter is out of bounds.",
      );
    }
    if (pageNum >= 2) {
      querySuffix = `?page=${pageNum}`;
    }
  }

  return `${verifiedOrigin}${normalizedPath}${querySuffix}`;
}

export type QueryInput =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | null
  | undefined;

function parseQueryEntries(query: QueryInput): readonly (readonly [string, string])[] {
  if (query === undefined || query === null || query === "") {
    return [];
  }
  if (typeof query === "string") {
    if (hasAsciiControlChars(query)) {
      throw new SeoPolicyError(
        "CONTROL_CHARACTER",
        "Query string must not contain ASCII control characters.",
      );
    }
    const cleaned = query.startsWith("?") ? query.slice(1) : query;
    const params = new URLSearchParams(cleaned);
    const out: [string, string][] = [];
    for (const [k, v] of params.entries()) {
      out.push([k, v]);
    }
    return out;
  }
  if (query instanceof URLSearchParams) {
    const out: [string, string][] = [];
    for (const [k, v] of query.entries()) {
      if (hasAsciiControlChars(k) || hasAsciiControlChars(v)) {
        throw new SeoPolicyError(
          "CONTROL_CHARACTER",
          "Query parameter must not contain ASCII control characters.",
        );
      }
      out.push([k, v]);
    }
    return out;
  }
  const out: [string, string][] = [];
  for (const [key, rawVal] of Object.entries(query)) {
    if (rawVal === undefined) continue;
    if (Array.isArray(rawVal)) {
      for (const item of rawVal) {
        if (hasAsciiControlChars(key) || hasAsciiControlChars(item)) {
          throw new SeoPolicyError(
            "CONTROL_CHARACTER",
            "Query parameter must not contain ASCII control characters.",
          );
        }
        out.push([key, item]);
      }
    } else if (typeof rawVal === "string") {
      if (hasAsciiControlChars(key) || hasAsciiControlChars(rawVal)) {
        throw new SeoPolicyError(
          "CONTROL_CHARACTER",
          "Query parameter must not contain ASCII control characters.",
        );
      }
      out.push([key, rawVal]);
    }
  }
  return out;
}

export interface NormalizeCanonicalUrlInput {
  readonly verifiedOrigin: string;
  readonly pathname: string;
  readonly query?: QueryInput;
  readonly supportsPagination?: boolean;
  readonly totalPages?: number;
  readonly canonicalOverride?: string | null;
}

export type PaginationStatus = "none" | "first" | "paginated" | "invalid" | "out_of_range";

export interface NormalizedCanonicalUrlResult {
  readonly origin: string;
  readonly normalizedPath: string;
  readonly baseUrl: string;
  readonly canonicalUrl: string | null;
  readonly paginationStatus: PaginationStatus;
  readonly pageNumber: number;
  readonly prevUrl: string | null;
  readonly nextUrl: string | null;
  readonly strippedTrackingParams: readonly string[];
  readonly filterParamKeys: readonly string[];
  readonly isMultiParamFacetedFilter: boolean;
  readonly isAlteredResultSet: boolean;
  readonly needsPathOrPageOneRedirect: boolean;
  readonly redirectTarget: string | null;
  readonly usedCanonicalOverride: boolean;
}

/**
 * Normalizes path, pagination (`page=1` dropped, `page=N>=2` retained), tracking query
 * parameters (`utm_*`, `fbclid`, `gclid`, `ttclid`, `ref`, etc.), faceted filter URLs on
 * `/kendaraan` & `/produk` (`REQ-095` `SRC-98`), and optional validated `canonicalOverride`.
 */
export function normalizeCanonicalUrl(
  input: NormalizeCanonicalUrlInput,
): NormalizedCanonicalUrlResult {
  const origin = validateCanonicalOrigin(input.verifiedOrigin);
  const { normalizedPath, changed: pathChanged } = normalizePublicPath(input.pathname);
  const baseUrl = `${origin}${normalizedPath}`;
  const entries = parseQueryEntries(input.query);

  const strippedTrackingParams: string[] = [];
  const pageValues: string[] = [];
  const distinctFilterKeys = new Set<string>();
  const filterEntries: [string, string][] = [];

  for (const [rawKey, rawVal] of entries) {
    const keyLower = rawKey.toLowerCase();
    if (isTrackingQueryKey(keyLower)) {
      strippedTrackingParams.push(rawKey);
      continue;
    }
    if (keyLower === "page") {
      pageValues.push(rawVal);
      continue;
    }
    if (isFilterOrSearchQueryKey(keyLower)) {
      distinctFilterKeys.add(keyLower);
      filterEntries.push([keyLower, rawVal]);
    }
    // Unknown nonfunctional query keys are ignored and never create canonical variants (PLAN §15.2).
  }

  const isFacetedArchivePath = FACETED_ARCHIVE_PATHS.has(normalizedPath);
  const isMultiParamFacetedFilter =
    isFacetedArchivePath && (distinctFilterKeys.size >= 2 || filterEntries.length >= 2);
  const isAlteredResultSet = distinctFilterKeys.size >= 1;

  // Pagination parsing (only recognized when supportsPagination is enabled)
  let paginationStatus: PaginationStatus = "none";
  let pageNumber = 1;
  let hadRedundantPageOne = false;

  if (input.supportsPagination && pageValues.length > 0) {
    if (pageValues.length > 1) {
      paginationStatus = "invalid";
    } else {
      const rawPage = pageValues[0] ?? "";
      if (!/^[1-9]\d*$/.test(rawPage)) {
        paginationStatus = "invalid";
      } else {
        const parsedPage = Number(rawPage);
        if (!Number.isSafeInteger(parsedPage) || parsedPage > MAX_PAGINATION_PAGE) {
          paginationStatus = "invalid";
        } else if (parsedPage === 1) {
          paginationStatus = "first";
          pageNumber = 1;
          hadRedundantPageOne = true;
        } else if (
          input.totalPages !== undefined &&
          parsedPage > Math.max(1, input.totalPages)
        ) {
          paginationStatus = "out_of_range";
          pageNumber = parsedPage;
        } else {
          paginationStatus = "paginated";
          pageNumber = parsedPage;
        }
      }
    }
  }

  // Invalid or out-of-range pagination produces no canonical URL
  if (paginationStatus === "invalid" || paginationStatus === "out_of_range") {
    return {
      origin,
      normalizedPath,
      baseUrl,
      canonicalUrl: null,
      paginationStatus,
      pageNumber,
      prevUrl: null,
      nextUrl: null,
      strippedTrackingParams,
      filterParamKeys: Array.from(distinctFilterKeys),
      isMultiParamFacetedFilter,
      isAlteredResultSet,
      needsPathOrPageOneRedirect: false,
      redirectTarget: null,
      usedCanonicalOverride: false,
    };
  }

  // Validate optional canonicalOverride eagerly (fail closed on malicious/cross-origin override!)
  let validatedOverride: string | null = null;
  if (input.canonicalOverride !== undefined && input.canonicalOverride !== null && input.canonicalOverride !== "") {
    validatedOverride = validateCanonicalOverride(input.canonicalOverride, origin);
  }

  // Multi-parameter faceted filter on /kendaraan or /produk:
  // canonical points to clean base archive (REQ-095 SRC-98)
  if (isMultiParamFacetedFilter) {
    return {
      origin,
      normalizedPath,
      baseUrl,
      canonicalUrl: baseUrl,
      paginationStatus: "none",
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      strippedTrackingParams,
      filterParamKeys: Array.from(distinctFilterKeys),
      isMultiParamFacetedFilter: true,
      isAlteredResultSet: true,
      needsPathOrPageOneRedirect: false,
      redirectTarget: null,
      usedCanonicalOverride: false,
    };
  }

  // Altered result set (search/sort/filter query) omits canonical per PLAN §15.2
  if (isAlteredResultSet) {
    return {
      origin,
      normalizedPath,
      baseUrl,
      canonicalUrl: null,
      paginationStatus: "none",
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      strippedTrackingParams,
      filterParamKeys: Array.from(distinctFilterKeys),
      isMultiParamFacetedFilter: false,
      isAlteredResultSet: true,
      needsPathOrPageOneRedirect: false,
      redirectTarget: null,
      usedCanonicalOverride: false,
    };
  }

  const computedCanonical =
    paginationStatus === "paginated" ? `${baseUrl}?page=${pageNumber}` : baseUrl;

  const finalCanonical = validatedOverride ?? computedCanonical;

  let prevUrl: string | null = null;
  let nextUrl: string | null = null;
  if (input.supportsPagination) {
    if (pageNumber === 2) {
      prevUrl = baseUrl;
    } else if (pageNumber > 2) {
      prevUrl = `${baseUrl}?page=${pageNumber - 1}`;
    }
    if (input.totalPages !== undefined && pageNumber < input.totalPages) {
      nextUrl = `${baseUrl}?page=${pageNumber + 1}`;
    }
  }

  const needsPathOrPageOneRedirect = pathChanged || hadRedundantPageOne;

  return {
    origin,
    normalizedPath,
    baseUrl,
    canonicalUrl: finalCanonical,
    paginationStatus,
    pageNumber,
    prevUrl,
    nextUrl,
    strippedTrackingParams,
    filterParamKeys: [],
    isMultiParamFacetedFilter: false,
    isAlteredResultSet: false,
    needsPathOrPageOneRedirect,
    redirectTarget: needsPathOrPageOneRedirect ? computedCanonical : null,
    usedCanonicalOverride: validatedOverride !== null,
  };
}

// ---------------------------------------------------------------------------
// 3. Tenant Lifecycle & Surface Indexability Decision Matrix
// ---------------------------------------------------------------------------

export interface PublishedSeoDecisionInput {
  readonly surface?: SeoSurface;
  readonly routeKind: SeoRouteKind;
  readonly pathname: string;
  readonly query?: QueryInput;
  /** Tenant context (required for public tenant routes; omitted on unknown_host/error/platform routes). */
  readonly tenant?: VerifiedTenantHostInput | null;
  readonly siteVisibility?: SiteVisibility;
  readonly resourceState?: SeoResourcePublicationState;
  readonly resourceSeo?: ResourceSeoOverrides | null;
  readonly canonicalOverride?: string | null;
  /** Archive metadata (blog/catalog/taxonomy index routes). */
  readonly archiveEnabled?: boolean;
  readonly publishedItemCount?: number;
  readonly totalPages?: number;
  /** Category/tag archive opt-in & intro check (PLAN §15.2). */
  readonly taxonomyIndexOptIn?: boolean;
  readonly taxonomyHasUsefulIntro?: boolean;
  /** Target path for `former_slug` or `homepage_slug_alias` 308 redirect. */
  readonly redirectTargetPath?: string | null;
}

export interface PublishedSeoDecision {
  readonly httpStatus: 200 | 301 | 308 | 400 | 404 | 500 | 503;
  readonly indexable: boolean;
  readonly noindex: boolean;
  readonly nofollow: boolean;
  readonly robotsMeta: string;
  readonly xRobotsTag: string | null;
  readonly cacheControl: string | null;
  readonly retryAfterSeconds: number | null;
  readonly canonical: string | null;
  readonly socialUrl: string | null;
  readonly sitemapEligible: boolean;
  readonly redirectStatus: 301 | 308 | null;
  readonly redirectTarget: string | null;
  readonly pageNumber: number;
  readonly prevUrl: string | null;
  readonly nextUrl: string | null;
  readonly isFacetedFilter: boolean;
  readonly reason: SeoDecisionReason;
}

function makeNonIndexableNoCanonicalDecision(params: {
  readonly httpStatus: 200 | 400 | 404 | 500 | 503;
  readonly reason: SeoDecisionReason;
  readonly retryAfterSeconds?: number | null;
}): PublishedSeoDecision {
  return {
    httpStatus: params.httpStatus,
    indexable: false,
    noindex: true,
    nofollow: true,
    robotsMeta: "noindex, nofollow",
    xRobotsTag: "noindex, nofollow",
    cacheControl: "no-store",
    retryAfterSeconds: params.retryAfterSeconds ?? null,
    canonical: null,
    socialUrl: null,
    sitemapEligible: false,
    redirectStatus: null,
    redirectTarget: null,
    pageNumber: 1,
    prevUrl: null,
    nextUrl: null,
    isFacetedFilter: false,
    reason: params.reason,
  };
}

/**
 * Evaluates the complete PLAN §15 route, tenant lifecycle, pagination, faceted-filter,
 * alias-host, and visibility matrix from typed published inputs ONLY.
 */
export function resolvePublishedSeoDecision(
  input: PublishedSeoDecisionInput,
): PublishedSeoDecision {
  // 1. Private, admin, auth, API, preview, or non-indexable platform surfaces -> ALWAYS noindex, nofollow, canonical: null
  const isPrivateRouteKind =
    input.routeKind === "preview" ||
    input.routeKind === "admin" ||
    input.routeKind === "auth" ||
    input.routeKind === "api" ||
    input.routeKind === "private";
  const isPrivateSurface =
    input.surface === "app" ||
    input.surface === "console" ||
    input.surface === "preview" ||
    input.surface === "api";

  let normalizedPathForCheck: string | null;
  try {
    normalizedPathForCheck = normalizePublicPath(input.pathname).normalizedPath;
  } catch {
    normalizedPathForCheck = null;
  }

  if (
    isPrivateRouteKind ||
    isPrivateSurface ||
    (normalizedPathForCheck !== null && isPrivateRoutePath(normalizedPathForCheck))
  ) {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 200,
      reason: "private_or_preview_route",
    });
  }

  // 2. Error routes -> ALWAYS noindex, nofollow, canonical: null
  if (input.routeKind === "error_404" || input.surface === "error") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "error_route",
    });
  }
  if (input.routeKind === "error_500") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 500,
      reason: "error_route",
    });
  }
  if (input.routeKind === "error_503") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 503,
      reason: "error_route",
      retryAfterSeconds: 60,
    });
  }

  // 3. Unknown / unverified host -> 404, noindex, nofollow, canonical: null
  if (input.routeKind === "unknown_host" || !input.tenant) {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "unknown_or_unverified_host",
    });
  }

  // 4. Validate & resolve authoritative primary origin (throws SeoPolicyError on malicious host/origin!)
  const verifiedOrigin = resolveVerifiedCanonicalOrigin(input.tenant);
  const effectiveStatus = normalizeTenantStatus(
    input.tenant.tenantStatus,
    input.tenant.operatorHold,
  );

  // 5. Non-serving tenant lifecycle gates (PLAN §3.3, §15.2, §17.1, DESIGN §9)
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "tenant_not_found_or_destroyed",
    });
  }

  if (effectiveStatus === "suspended") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 503,
      reason: "tenant_suspended",
      retryAfterSeconds: 3600,
    });
  }

  if (effectiveStatus === "recovery") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 503,
      reason: "tenant_recovery",
      retryAfterSeconds: 60,
    });
  }

  // 6. Resource publication gate (draft/unpublished/trashed/missing/disabled -> 404, canonical: null, no draft leak)
  if (input.archiveEnabled === false) {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "resource_not_published",
    });
  }

  const resourceState = input.resourceState ?? "published";
  if (resourceState !== "published") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "resource_not_published",
    });
  }

  // 7. Former slug / homepage slug alias -> 308 to current canonical URL; never canonical or sitemap-eligible
  if (input.routeKind === "former_slug" || input.routeKind === "homepage_slug_alias") {
    const targetPath =
      input.routeKind === "homepage_slug_alias"
        ? "/"
        : normalizePublicPath(input.redirectTargetPath ?? "/").normalizedPath;
    if (isPrivateRoutePath(targetPath)) {
      throw new SeoPolicyError(
        "INVALID_PATH",
        `Redirect target path '${targetPath}' cannot point to a private or internal route.`,
      );
    }
    const targetUrl = `${verifiedOrigin.origin}${targetPath}`;
    return {
      httpStatus: 308,
      indexable: false,
      noindex: true,
      nofollow: false,
      robotsMeta: "noindex, follow",
      xRobotsTag: effectiveStatus === "trial" ? "noindex, nofollow" : null,
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: targetUrl,
      socialUrl: targetUrl,
      sitemapEligible: false,
      redirectStatus: 308,
      redirectTarget: targetUrl,
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      isFacetedFilter: false,
      reason:
        input.routeKind === "homepage_slug_alias"
          ? "homepage_slug_redirect"
          : "former_slug_redirect",
    };
  }

  // 8. Explicit search_or_filter route kind (PLAN §15.2: 200 noindex, follow, omit canonical)
  if (input.routeKind === "search_or_filter") {
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: effectiveStatus === "trial",
      robotsMeta: effectiveStatus === "trial" ? "noindex, nofollow" : "noindex, follow",
      xRobotsTag: effectiveStatus === "trial" ? "noindex, nofollow" : "noindex, follow",
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: null,
      socialUrl: null,
      sitemapEligible: false,
      redirectStatus: null,
      redirectTarget: null,
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      isFacetedFilter: false,
      reason:
        effectiveStatus === "trial" ? "trial_tenant_noindex" : "search_or_filter_noindex",
    };
  }

  // 9. Path, pagination, query & canonicalOverride normalization
  const supportsPagination = ARCHIVE_ROUTE_KINDS.has(input.routeKind);
  const normalized = normalizeCanonicalUrl({
    verifiedOrigin: verifiedOrigin.origin,
    pathname: input.pathname,
    query: input.query,
    supportsPagination,
    totalPages: input.totalPages,
    canonicalOverride: input.canonicalOverride,
  });

  if (normalized.paginationStatus === "invalid") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 400,
      reason: "invalid_pagination",
    });
  }

  if (normalized.paginationStatus === "out_of_range") {
    return makeNonIndexableNoCanonicalDecision({
      httpStatus: 404,
      reason: "out_of_range_pagination",
    });
  }

  // 10. Verified alias hostname serving while primary custom domain is active
  if (verifiedOrigin.isAliasRequest) {
    const primaryTarget = normalized.canonicalUrl ?? normalized.baseUrl;
    const isTrial = effectiveStatus === "trial";
    return {
      httpStatus: 301,
      indexable: false,
      noindex: true,
      nofollow: isTrial,
      robotsMeta: isTrial ? "noindex, nofollow" : "noindex, follow",
      xRobotsTag: isTrial ? "noindex, nofollow" : "noindex, follow",
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: primaryTarget,
      socialUrl: primaryTarget,
      sitemapEligible: false,
      redirectStatus: 301,
      redirectTarget: primaryTarget,
      pageNumber: normalized.pageNumber,
      prevUrl: normalized.prevUrl,
      nextUrl: normalized.nextUrl,
      isFacetedFilter: normalized.isMultiParamFacetedFilter,
      reason: "alias_host_redirect",
    };
  }

  // 11. Trial tenant (`*.situsku.click` only) -> ALWAYS `noindex, nofollow`, `sitemapEligible: false`
  if (effectiveStatus === "trial") {
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: true,
      robotsMeta: "noindex, nofollow",
      xRobotsTag: "noindex, nofollow",
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: normalized.canonicalUrl,
      socialUrl: normalized.canonicalUrl,
      sitemapEligible: false,
      redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
      redirectTarget: normalized.redirectTarget,
      pageNumber: normalized.pageNumber,
      prevUrl: normalized.prevUrl,
      nextUrl: normalized.nextUrl,
      isFacetedFilter: normalized.isMultiParamFacetedFilter,
      reason: "trial_tenant_noindex",
    };
  }

  // 12. Multi-parameter faceted filter on /kendaraan or /produk (REQ-095 SRC-98)
  if (normalized.isMultiParamFacetedFilter) {
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: false,
      robotsMeta: "noindex, follow",
      xRobotsTag: "noindex, follow",
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: normalized.canonicalUrl, // Clean base archive URL (/kendaraan or /produk)
      socialUrl: normalized.canonicalUrl,
      sitemapEligible: false,
      redirectStatus: null,
      redirectTarget: null,
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      isFacetedFilter: true,
      reason: "faceted_filter_noindex",
    };
  }

  // 13. Altered result set (search/sort/single filter query) -> 200 noindex, follow, canonical: null
  if (normalized.isAlteredResultSet) {
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: false,
      robotsMeta: "noindex, follow",
      xRobotsTag: "noindex, follow",
      cacheControl: null,
      retryAfterSeconds: null,
      canonical: null,
      socialUrl: null,
      sitemapEligible: false,
      redirectStatus: null,
      redirectTarget: null,
      pageNumber: 1,
      prevUrl: null,
      nextUrl: null,
      isFacetedFilter: false,
      reason: "search_or_filter_noindex",
    };
  }

  const canonical = normalized.canonicalUrl;
  const selfUrl =
    normalized.paginationStatus === "paginated"
      ? `${normalized.baseUrl}?page=${normalized.pageNumber}`
      : normalized.baseUrl;
  const isSelfCanonical = canonical === selfUrl;

  // 14. Site-wide noindex dominates per-resource settings (PLAN §15.2)
  const resourceNofollow = Boolean(input.resourceSeo?.nofollow);
  if (input.siteVisibility === "noindex") {
    const robots = resourceNofollow ? "noindex, nofollow" : "noindex, follow";
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: resourceNofollow,
      robotsMeta: robots,
      xRobotsTag: robots,
      cacheControl: null,
      retryAfterSeconds: null,
      canonical,
      socialUrl: canonical,
      sitemapEligible: false,
      redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
      redirectTarget: normalized.redirectTarget,
      pageNumber: normalized.pageNumber,
      prevUrl: normalized.prevUrl,
      nextUrl: normalized.nextUrl,
      isFacetedFilter: false,
      reason: "site_wide_noindex",
    };
  }

  // 15. Per-resource explicit noindex override
  if (input.resourceSeo?.noindex === true) {
    const robots = resourceNofollow ? "noindex, nofollow" : "noindex, follow";
    return {
      httpStatus: 200,
      indexable: false,
      noindex: true,
      nofollow: resourceNofollow,
      robotsMeta: robots,
      xRobotsTag: robots,
      cacheControl: null,
      retryAfterSeconds: null,
      canonical,
      socialUrl: canonical,
      sitemapEligible: false,
      redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
      redirectTarget: normalized.redirectTarget,
      pageNumber: normalized.pageNumber,
      prevUrl: normalized.prevUrl,
      nextUrl: normalized.nextUrl,
      isFacetedFilter: false,
      reason: "resource_noindex",
    };
  }

  // 16. Archive & taxonomy empty / opt-in rules (PLAN §15.2)
  if (supportsPagination) {
    const itemCount = input.publishedItemCount ?? 0;
    if (TAXONOMY_ARCHIVE_ROUTE_KINDS.has(input.routeKind)) {
      if (itemCount <= 0) {
        return {
          httpStatus: 200,
          indexable: false,
          noindex: true,
          nofollow: false,
          robotsMeta: "noindex, follow",
          xRobotsTag: "noindex, follow",
          cacheControl: null,
          retryAfterSeconds: null,
          canonical,
          socialUrl: canonical,
          sitemapEligible: false,
          redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
          redirectTarget: normalized.redirectTarget,
          pageNumber: normalized.pageNumber,
          prevUrl: normalized.prevUrl,
          nextUrl: normalized.nextUrl,
          isFacetedFilter: false,
          reason: "empty_taxonomy_noindex",
        };
      }
      if (input.taxonomyIndexOptIn !== true || input.taxonomyHasUsefulIntro === false) {
        return {
          httpStatus: 200,
          indexable: false,
          noindex: true,
          nofollow: false,
          robotsMeta: "noindex, follow",
          xRobotsTag: "noindex, follow",
          cacheControl: null,
          retryAfterSeconds: null,
          canonical,
          socialUrl: canonical,
          sitemapEligible: false,
          redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
          redirectTarget: normalized.redirectTarget,
          pageNumber: normalized.pageNumber,
          prevUrl: normalized.prevUrl,
          nextUrl: normalized.nextUrl,
          isFacetedFilter: false,
          reason: "taxonomy_default_noindex",
        };
      }
    } else if (itemCount <= 0) {
      return {
        httpStatus: 200,
        indexable: false,
        noindex: true,
        nofollow: false,
        robotsMeta: "noindex, follow",
        xRobotsTag: "noindex, follow",
        cacheControl: null,
        retryAfterSeconds: null,
        canonical,
        socialUrl: canonical,
        sitemapEligible: false,
        redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
        redirectTarget: normalized.redirectTarget,
        pageNumber: normalized.pageNumber,
        prevUrl: normalized.prevUrl,
        nextUrl: normalized.nextUrl,
        isFacetedFilter: false,
        reason: "empty_archive_noindex",
      };
    }
  }

  // 17. Indexable published content (`active`, `grace`, `locked`)
  const sitemapEligible =
    canonical !== null &&
    isSelfCanonical &&
    normalized.pageNumber === 1 &&
    !normalized.needsPathOrPageOneRedirect;

  return {
    httpStatus: 200,
    indexable: true,
    noindex: false,
    nofollow: resourceNofollow,
    robotsMeta: resourceNofollow
      ? INDEXABLE_NOFOLLOW_ROBOTS_DIRECTIVES
      : INDEXABLE_ROBOTS_DIRECTIVES,
    xRobotsTag: null,
    cacheControl: null,
    retryAfterSeconds: null,
    canonical,
    socialUrl: canonical,
    sitemapEligible,
    redirectStatus: normalized.needsPathOrPageOneRedirect ? 308 : null,
    redirectTarget: normalized.redirectTarget,
    pageNumber: normalized.pageNumber,
    prevUrl: normalized.prevUrl,
    nextUrl: normalized.nextUrl,
    isFacetedFilter: false,
    reason: "indexable_published",
  };
}

// ---------------------------------------------------------------------------
// 3b. Published Resource Adapter (Clean Integration with Publication Engine)
// ---------------------------------------------------------------------------

export type PublishedContentDto =
  | PublishedResourceDto<"page">
  | PublishedResourceDto<"post">
  | PublishedResourceDto<"offering">;

export interface PublishedResourceSeoInput {
  readonly tenant: VerifiedTenantHostInput;
  readonly siteSettings?: SiteSettingsSnapshot | null;
  readonly resource: PublishedContentDto | null;
  readonly requestPathname?: string;
  readonly query?: QueryInput;
  readonly canonicalOverride?: string | null;
}

/**
 * Derives the canonical public pathname for a published page, post, or offering DTO.
 */
export function resolvePublishedResourcePathname(resource: PublishedContentDto): string {
  switch (resource.resourceType) {
    case "page": {
      const page: PageSnapshot = resource.data;
      return page.isHomepage ? "/" : `/${page.slug}`;
    }
    case "post": {
      const post: PostSnapshot = resource.data;
      return `/blog/${post.slug}`;
    }
    case "offering": {
      const offering: OfferingSnapshot = resource.data;
      return `${OFFERING_BASE_PATH_BY_TYPE[offering.offeringType]}/${offering.slug}`;
    }
  }
}

/**
 * High-level SEO policy evaluator bound directly to `@punyasitus/core/content` and
 * `@punyasitus/db/publication/index` (`getPublishedResource`) outputs.
 *
 * When `resource` is `null` (draft, unpublished, trashed, or missing), returns `404`
 * with `noindex, nofollow`, `canonical: null`, and `sitemapEligible: false`.
 */
export function resolvePublishedResourceSeoDecision(
  input: PublishedResourceSeoInput,
): PublishedSeoDecision {
  const siteVisibility: SiteVisibility = input.siteSettings?.siteVisibility ?? "public";

  if (input.resource === null) {
    return resolvePublishedSeoDecision({
      surface: "public_tenant",
      routeKind: "page",
      pathname: input.requestPathname ?? "/",
      query: input.query,
      tenant: input.tenant,
      siteVisibility,
      resourceState: "missing",
    });
  }

  // Respect blog/catalog feature toggles from published site settings
  if (input.resource.resourceType === "post" && input.siteSettings?.blogEnabled === false) {
    return resolvePublishedSeoDecision({
      surface: "public_tenant",
      routeKind: "post",
      pathname: input.requestPathname ?? resolvePublishedResourcePathname(input.resource),
      query: input.query,
      tenant: input.tenant,
      siteVisibility,
      resourceState: "disabled",
    });
  }

  if (input.resource.resourceType === "offering" && input.siteSettings?.catalogEnabled === false) {
    return resolvePublishedSeoDecision({
      surface: "public_tenant",
      routeKind: "offering",
      pathname: input.requestPathname ?? resolvePublishedResourcePathname(input.resource),
      query: input.query,
      tenant: input.tenant,
      siteVisibility,
      resourceState: "disabled",
    });
  }

  const canonicalPath = resolvePublishedResourcePathname(input.resource);
  const requestPath = input.requestPathname ?? canonicalPath;
  const normalizedRequestPath = normalizePublicPath(requestPath).normalizedPath;

  // Detect /{slug} of the page chosen as homepage -> 308 to /
  if (
    input.resource.resourceType === "page" &&
    input.resource.data.isHomepage &&
    normalizedRequestPath === `/${input.resource.data.slug}`
  ) {
    return resolvePublishedSeoDecision({
      surface: "public_tenant",
      routeKind: "homepage_slug_alias",
      pathname: requestPath,
      query: input.query,
      tenant: input.tenant,
      siteVisibility,
      resourceState: "published",
      redirectTargetPath: "/",
    });
  }

  const routeKind: SeoRouteKind =
    input.resource.resourceType === "page"
      ? input.resource.data.isHomepage
        ? "homepage"
        : "page"
      : input.resource.resourceType;

  return resolvePublishedSeoDecision({
    surface: "public_tenant",
    routeKind,
    pathname: requestPath,
    query: input.query,
    tenant: input.tenant,
    siteVisibility,
    resourceState: "published",
    resourceSeo: input.resource.data.seo ?? null,
    canonicalOverride: input.canonicalOverride,
  });
}

// ---------------------------------------------------------------------------
// 4. Safe Meta Text Sanitization, HTML/XML Escaping & JSON-LD Serialization
// ---------------------------------------------------------------------------

export interface SanitizeSeoTextOptions {
  readonly maxLength?: number;
}

/**
 * Strips ASCII control characters, collapses whitespace, trims, and optionally
 * caps text length cleanly for HTML meta tags and social snippets.
 */
export function sanitizeSeoText(raw: string, options?: SanitizeSeoTextOptions): string {
  if (typeof raw !== "string") {
    return "";
  }
  const collapsed = stripAsciiControlChars(raw).replace(/\s+/g, " ").trim();
  const maxLen = options?.maxLength;
  if (maxLen === undefined || maxLen <= 0 || collapsed.length <= maxLen) {
    return collapsed;
  }
  // Slice safely without splitting a surrogate pair
  let end = maxLen;
  const lastCode = collapsed.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return collapsed.slice(0, end).trimEnd();
}

/**
 * Sanitizes and caps an SEO title (`<= 70` characters).
 */
export function sanitizeSeoTitle(raw: string): string {
  return sanitizeSeoText(raw, { maxLength: MAX_SEO_TITLE_LENGTH });
}

/**
 * Sanitizes and caps an SEO meta description (`<= 160` characters).
 */
export function sanitizeSeoDescription(raw: string): string {
  return sanitizeSeoText(raw, { maxLength: MAX_SEO_DESCRIPTION_LENGTH });
}

/**
 * Escapes HTML special characters for safe double-quoted HTML attributes (`<meta content="...">`).
 * Neutralizes `<`, `>`, `&`, `"`, `'`, `</script>`, `<!--`, and `-->`.
 */
export function escapeHtmlAttribute(raw: string): string {
  const cleaned = sanitizeSeoText(raw);
  return cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes HTML special characters for safe text nodes (`<title>...</title>`).
 */
export function escapeHtmlText(raw: string): string {
  return escapeHtmlAttribute(raw);
}

function stripXmlInvalidChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0xfffe || code === 0xffff) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.slice(i, i + 2);
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    out += value[i] ?? "";
  }
  return out;
}

/**
 * Escapes XML 1.0 special characters for sitemaps and RSS feeds (`<loc>...</loc>`).
 * Also strips ASCII control characters, U+FFFE, U+FFFF, and lone UTF-16 surrogates.
 */
export function escapeXmlText(raw: string): string {
  const cleaned = stripXmlInvalidChars(sanitizeSeoText(raw));
  return cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serializes a JSON-LD object safely for embedding inside `<script type="application/ld+json">`.
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 using JSON Unicode escapes so `</script>`,
 * `<!--`, and `-->` can NEVER break out of the script tag while preserving 100% valid JSON.
 */
export function safeJsonLdStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "null";
  }
  return serialized
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface EffectiveSeoTextInput {
  readonly isHomepage?: boolean;
  readonly resourceTitle?: string | null;
  readonly resourceTitleOverride?: string | null;
  readonly resourceDescriptionOverride?: string | null;
  readonly resourceExcerpt?: string | null;
  readonly siteTitle: string;
  readonly siteTagline?: string | null;
  readonly separator?: string;
  readonly pageNumber?: number;
}

export interface EffectiveSeoTextResult {
  readonly title: string;
  readonly description: string;
  readonly escapedTitle: string;
  readonly escapedDescription: string;
}

/**
 * Resolves effective SEO title & description following PLAN §15.3 precedence,
 * adding a `Halaman N` qualifier for paginated routes (`N >= 2`), and capping
 * to safe lengths (`<= 70` title, `<= 160` description).
 */
export function resolveEffectiveSeoText(input: EffectiveSeoTextInput): EffectiveSeoTextResult {
  const sep = sanitizeSeoText(input.separator ?? "|") || "|";
  const siteTitle = sanitizeSeoText(input.siteTitle);
  const tagline = sanitizeSeoText(input.siteTagline ?? "");
  const pageNum = input.pageNumber && input.pageNumber >= 2 ? input.pageNumber : 1;
  const pageSuffix = pageNum >= 2 ? ` ${sep} Halaman ${pageNum}` : "";

  let rawTitle: string;
  const overrideTitle = sanitizeSeoText(input.resourceTitleOverride ?? "");
  const resourceTitle = sanitizeSeoText(input.resourceTitle ?? "");

  if (overrideTitle) {
    rawTitle = `${overrideTitle}${pageSuffix}`;
  } else if (input.isHomepage) {
    rawTitle = tagline ? `${siteTitle} ${sep} ${tagline}${pageSuffix}` : `${siteTitle}${pageSuffix}`;
  } else if (resourceTitle) {
    rawTitle = siteTitle
      ? `${resourceTitle} ${pageNum >= 2 ? `${sep} Halaman ${pageNum} ` : ""}${sep} ${siteTitle}`
      : `${resourceTitle}${pageSuffix}`;
  } else {
    rawTitle = `${siteTitle}${pageSuffix}`;
  }

  const overrideDesc = sanitizeSeoText(input.resourceDescriptionOverride ?? "");
  const excerpt = sanitizeSeoText(input.resourceExcerpt ?? "");
  const rawDescription = overrideDesc || excerpt || tagline || siteTitle;

  const title = sanitizeSeoTitle(rawTitle);
  const description = sanitizeSeoDescription(rawDescription);

  return {
    title,
    description,
    escapedTitle: escapeHtmlText(title),
    escapedDescription: escapeHtmlAttribute(description),
  };
}

// ---------------------------------------------------------------------------
// 5. Managed `robots.txt` & AI Crawler Policy (REQ-025, REQ-095, PLAN §15.5)
// ---------------------------------------------------------------------------

export interface RobotsTxtPolicyInput {
  readonly tenant: VerifiedTenantHostInput;
  readonly aiTrainingPolicy?: AiTrainingPolicy;
  readonly siteVisibility?: SiteVisibility;
}

export interface RobotsTxtPolicyResult {
  readonly httpStatus: 200 | 404 | 503;
  readonly contentType: "text/plain; charset=utf-8";
  readonly cacheControl: string;
  readonly xRobotsTag: string | null;
  readonly retryAfterSeconds: number | null;
  readonly indexable: boolean;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly sitemapUrl: string | null;
  readonly body: string;
}

/**
 * Generates the tenant-scoped managed `/robots.txt` policy (REQ-025, REQ-095, PLAN §15.5).
 *
 * - Indexable paid tenants (`active`, `grace`, `locked` with `siteVisibility !== "noindex"`):
 *   - Explicitly allows documented search & user-triggered AI fetchers (`Googlebot`, `Bingbot`,
 *     `OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`,
 *     `Perplexity-User`, `Applebot`).
 *   - Honors `aiTrainingPolicy` (`"allow"` vs `"disallow"`) for training-only crawlers
 *     (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`).
 *   - Disallows `/api/`, `/dashboard/`, `/preview`, `/kendaraan?*&*`, and `/produk?*&*`.
 *   - Emits `Sitemap: https://<primaryHost>/sitemap.xml`.
 * - `trial` tenants: emits `User-agent: *\nDisallow: /\n` with NO `Sitemap:` line.
 * - `suspended` / `recovery` tenants: HTTP `503`, `no-store`, `Disallow: /\n`, NO `Sitemap:` line.
 * - `provisioning` / `purging` / `purged` / `destroyed`: HTTP `404`, `no-store`, empty body.
 * - Paid tenant with `siteVisibility === "noindex"`: emits `Disallow: /` and omits `Sitemap:`
 *   unless `siteVisibility` is restored to `"public"`.
 */
export function buildRobotsTxtPolicy(input: RobotsTxtPolicyInput): RobotsTxtPolicyResult {
  const aiTrainingPolicy: AiTrainingPolicy = input.aiTrainingPolicy ?? "allow";
  const verifiedOrigin = resolveVerifiedCanonicalOrigin(input.tenant);
  const effectiveStatus = normalizeTenantStatus(
    input.tenant.tenantStatus,
    input.tenant.operatorHold,
  );

  // Destroyed / purged / provisioning -> 404 neutral
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return {
      httpStatus: 404,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "no-store",
      xRobotsTag: "noindex, nofollow",
      retryAfterSeconds: null,
      indexable: false,
      aiTrainingPolicy,
      sitemapUrl: null,
      body: "",
    };
  }

  // Suspended / recovery -> 503 with Disallow: / and no sitemap
  if (effectiveStatus === "suspended" || effectiveStatus === "recovery") {
    return {
      httpStatus: 503,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "no-store",
      xRobotsTag: "noindex, nofollow",
      retryAfterSeconds: effectiveStatus === "recovery" ? 60 : 3600,
      indexable: false,
      aiTrainingPolicy,
      sitemapUrl: null,
      body: "User-agent: *\nDisallow: /\n",
    };
  }

  // Trial or site-wide non-indexable tenants -> Disallow: /, no sitemap
  if (effectiveStatus === "trial" || input.siteVisibility === "noindex") {
    return {
      httpStatus: 200,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "no-store",
      xRobotsTag: "noindex, nofollow",
      retryAfterSeconds: null,
      indexable: false,
      aiTrainingPolicy,
      sitemapUrl: null,
      body: "User-agent: *\nDisallow: /\n",
    };
  }

  // Indexable paid tenant (`active`, `grace`, `locked`)
  const disallowLines = [
    ...MANAGED_PRIVATE_DISALLOW_PATHS.map((p) => `Disallow: ${p}`),
    ...FACETED_FILTER_DISALLOW_PATTERNS.map((p) => `Disallow: ${p}`),
  ];

  const blocks: string[] = [];

  // Default wildcard rule
  blocks.push(["User-agent: *", "Allow: /", ...disallowLines].join("\n"));

  // Explicit allow group for documented search & user-triggered AI fetchers (REQ-095)
  blocks.push(
    [
      ...ALLOWED_SEARCH_AND_AI_FETCHERS.map((bot) => `User-agent: ${bot}`),
      "Allow: /",
      ...disallowLines,
    ].join("\n"),
  );

  // Training-only AI crawlers governed by owner aiTrainingPolicy toggle (REQ-095)
  if (aiTrainingPolicy === "disallow") {
    blocks.push(
      [
        ...AI_TRAINING_ONLY_CRAWLERS.map((bot) => `User-agent: ${bot}`),
        "Disallow: /",
      ].join("\n"),
    );
  } else {
    blocks.push(
      [
        ...AI_TRAINING_ONLY_CRAWLERS.map((bot) => `User-agent: ${bot}`),
        "Allow: /",
        ...disallowLines,
      ].join("\n"),
    );
  }

  const sitemapUrl = `${verifiedOrigin.origin}/sitemap.xml`;
  blocks.push(`Sitemap: ${sitemapUrl}`);

  return {
    httpStatus: 200,
    contentType: "text/plain; charset=utf-8",
    cacheControl: "public, max-age=60",
    xRobotsTag: null,
    retryAfterSeconds: null,
    indexable: true,
    aiTrainingPolicy,
    sitemapUrl,
    body: `${blocks.join("\n\n")}\n`,
  };
}
