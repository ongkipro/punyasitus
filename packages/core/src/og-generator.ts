import { PLATFORM_HOSTS } from "./index.ts";
import {
  assertTenantR2Key,
  MAX_OG_DERIVATIVE_BYTES,
  type MediaVariantsManifest,
} from "./media/index.ts";
import type { OfferingType } from "./schemas/common.ts";
import {
  escapeHtmlAttribute,
  escapeHtmlText,
  resolveEffectiveSeoText,
  resolvePublishedResourcePathname,
  resolvePublishedResourceSeoDecision,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  safeJsonLdStringify,
  sanitizeSeoDescription,
  sanitizeSeoText,
  validateCanonicalHostname,
  validateCanonicalOrigin,
  type PublishedContentDto,
  type PublishedResourceSeoInput,
  type PublishedSeoDecision,
  type PublishedSeoDecisionInput,
  type SeoRouteKind,
} from "./seo/index.ts";

/**
 * Typed Open Graph, Twitter Card & Social Share Metadata Generator
 * (REQ-023, REQ-026, PLAN §7.3 & §15, TASK-016).
 *
 * Reuses TASK-051 (`packages/core/src/seo/index.ts`) for authoritative canonical origin,
 * robots/indexability, pagination, and safe escaping, and TASK-007 (`packages/core/src/media/index.ts`)
 * for tenant-scoped R2 keys and the 300 KiB (`307_200` bytes) OG image budget.
 *
 * Invariants:
 * - NEVER trusts raw `Host` / `X-Forwarded-Host` or unverified domains; all canonical/OG URLs
 *   come strictly from `resolvePublishedSeoDecision` & `resolveVerifiedCanonicalOrigin`.
 * - NEVER invents a canonical or `og:url` for draft, preview, private, admin, auth, API,
 *   error, suspended, recovery, purged, or unknown_host routes (`canonical: null`, `og.url: null`).
 * - Draft, preview, trial, private, error, suspended, and unknown_host routes ALWAYS emit
 *   `noindex, nofollow`.
 * - Only emits a tenant OG image when `status === "ready"`, tenant-owned, exact `1200x630`,
 *   `byteSize <= 307_200` (300 KiB), allowed raster MIME (`image/webp`, `image/jpeg`, `image/png`),
 *   and HTTPS URL on a verified tenant origin or allowed media CDN origin.
 * - Falls back cleanly: resource OG image -> tenant default OG image -> platform fallback -> omit
 *   `og:image` and downgrade `twitter:card` to `"summary"`.
 */

export const OG_IMAGE_WIDTH = 1200 as const;
export const OG_IMAGE_HEIGHT = 630 as const;
export const OG_IMAGE_MAX_BYTES = MAX_OG_DERIVATIVE_BYTES; // 307_200 bytes (300 KiB)
export const DEFAULT_OG_LOCALE = "id_ID" as const;
export const DEFAULT_MEDIA_CDN_ORIGIN = `https://media.${PLATFORM_HOSTS.marketing}` as const;

export const MAX_OG_TITLE_LENGTH = 100 as const;
export const MAX_OG_DESCRIPTION_LENGTH = 200 as const;
export const MAX_OG_ALT_LENGTH = 200 as const;
export const MAX_OG_SITE_NAME_LENGTH = 120 as const;
export const MAX_OG_URL_LENGTH = 2048 as const;

export const ALLOWED_OG_IMAGE_MIMES = [
  "image/webp",
  "image/jpeg",
  "image/png",
] as const;

export type AllowedOgImageMime = (typeof ALLOWED_OG_IMAGE_MIMES)[number];

export type OgType = "website" | "article" | "product";
export type TwitterCardType = "summary_large_image" | "summary";

export type OgImageCandidateSlot = "resource" | "tenant_default" | "platform_fallback";

export type OgImageRejectionReason =
  | "missing"
  | "not_ready"
  | "trashed"
  | "cross_tenant"
  | "invalid_r2_key"
  | "invalid_dimensions"
  | "oversized"
  | "invalid_byte_size"
  | "invalid_mime"
  | "unsafe_url"
  | "untrusted_origin"
  | "non_public_route";

export interface OgImageRejection {
  readonly slot: OgImageCandidateSlot;
  readonly reason: OgImageRejectionReason;
  readonly detail: string;
}

export interface OgImageCandidate {
  /** Authoritative owning tenant ID; MUST match `input.tenantId` unless `isPlatformFallback === true`. */
  readonly tenantId?: string | null;
  /** Media status from `media_items`; MUST be `"ready"` for tenant media. */
  readonly status?: string | null;
  /** Optional underlying DB status; when present, MUST be `"ready"`. */
  readonly dbStatus?: string | null;
  /** Optional soft-delete timestamp; when non-null, candidate is trashed and rejected. */
  readonly deletedAt?: number | null;
  /** Optional R2 key; when present for tenant media, MUST pass `assertTenantR2Key(tenantId, r2Key, ["media"])`. */
  readonly r2Key?: string | null;
  /** Absolute HTTPS URL to the `1200x630` OG image derivative. */
  readonly url: string;
  /** Pixel width of the derivative (MUST equal `1200`). */
  readonly width: number;
  /** Pixel height of the derivative (MUST equal `630`). */
  readonly height: number;
  /** Stored byte size of the derivative (MUST be `1..307_200`). */
  readonly byteSize: number;
  /** MIME type (`image/webp`, `image/jpeg`, or `image/png`). */
  readonly mimeType?: string | null;
  /** Accessible alternative text for `og:image:alt` and `twitter:image:alt`. */
  readonly alt?: string | null;
  /** Marks a safe platform-level fallback asset (exempt from tenant ownership match, still strictly validated). */
  readonly isPlatformFallback?: boolean;
}

export interface OgArticleInput {
  readonly publishedTime?: string | number | Date | null;
  readonly modifiedTime?: string | number | Date | null;
  readonly author?: string | null;
  readonly section?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface GenerateOpenGraphInput {
  /** Typed SEO policy input evaluated via TASK-051 `resolvePublishedSeoDecision`. */
  readonly seo: PublishedSeoDecisionInput;
  /** Authoritative tenant ID for tenant-media ownership & R2 prefix verification. */
  readonly tenantId?: string | null;
  /** Public site name (`og:site_name` and title suffix). */
  readonly siteName: string;
  /** Optional site tagline fallback for homepage title/description. */
  readonly siteTagline?: string | null;
  /** BCP-47 or OG locale (e.g. `"id-ID"` -> `"id_ID"`). Defaults to `"id_ID"`. */
  readonly locale?: string | null;
  /** Resource title (page/post/offering/archive heading). */
  readonly resourceTitle?: string | null;
  /** Resource plain-text excerpt/summary fallback. */
  readonly resourceExcerpt?: string | null;
  /** Optional explicit title override (takes precedence over `seo.resourceSeo.titleOverride`). */
  readonly titleOverride?: string | null;
  /** Optional explicit description override. */
  readonly descriptionOverride?: string | null;
  /** Optional explicit OG title override (falls back to `seo.resourceSeo.ogTitleOverride` then resolved title). */
  readonly ogTitleOverride?: string | null;
  /** Optional explicit OG description override (falls back to `seo.resourceSeo.ogDescriptionOverride` then resolved description). */
  readonly ogDescriptionOverride?: string | null;
  /** Title separator (default `"|"`). */
  readonly separator?: string;
  /** Explicit Open Graph type override; auto-derived from `seo.routeKind` / `offeringType` when omitted. */
  readonly ogType?: OgType;
  /** Optional offering type (`product` -> `og:type="product"`; `service`/`tour`/`vehicle` -> `website`). */
  readonly offeringType?: OfferingType | null;
  /** Optional article timestamps and metadata (emitted ONLY when `og:type === "article"`). */
  readonly article?: OgArticleInput | null;
  /** Priority 1: Resource-specific OG image candidate (must be tenant-owned, ready, 1200x630, <= 300 KiB). */
  readonly resourceOgImage?: OgImageCandidate | null;
  /** Priority 2: Tenant default OG image candidate (must be tenant-owned, ready, 1200x630, <= 300 KiB). */
  readonly tenantDefaultOgImage?: OgImageCandidate | null;
  /** Priority 3: Safe platform/verified fallback OG image (must still be HTTPS, trusted origin, 1200x630, <= 300 KiB). */
  readonly platformFallbackOgImage?: OgImageCandidate | null;
  /** Optional additional trusted HTTPS media CDN origins (e.g. from `env.MEDIA_PUBLIC_BASE_URL`). */
  readonly allowedMediaOrigins?: readonly string[];
}

export interface ResolvedOgImage {
  readonly url: string;
  readonly width: typeof OG_IMAGE_WIDTH;
  readonly height: typeof OG_IMAGE_HEIGHT;
  readonly alt: string;
  readonly type: AllowedOgImageMime;
  readonly byteSize: number;
  readonly source: OgImageCandidateSlot;
}

export interface OpenGraphArticleMeta {
  readonly publishedTime: string | null;
  readonly modifiedTime: string | null;
  readonly author: string | null;
  readonly section: string | null;
  readonly tags: readonly string[];
}

export interface OpenGraphTagsDto {
  readonly type: OgType;
  readonly siteName: string;
  readonly title: string;
  readonly description: string;
  readonly url: string | null;
  readonly locale: string;
  readonly image: ResolvedOgImage | null;
  readonly article: OpenGraphArticleMeta | null;
}

export interface TwitterCardTagsDto {
  readonly card: TwitterCardType;
  readonly title: string;
  readonly description: string;
  readonly image: string | null;
  readonly imageAlt: string | null;
}

export interface SocialMetadataDto {
  readonly title: string;
  readonly description: string;
  readonly canonical: string | null;
  readonly robots: string;
  readonly prevUrl: string | null;
  readonly nextUrl: string | null;
  readonly og: OpenGraphTagsDto;
  readonly twitter: TwitterCardTagsDto;
  readonly seoDecision: PublishedSeoDecision;
  readonly verifiedOrigin: string | null;
  readonly imageRejections: readonly OgImageRejection[];
}

// ---------------------------------------------------------------------------
// Internal Validation & Normalization Helpers
// ---------------------------------------------------------------------------

const ALLOWED_OG_IMAGE_MIME_SET = new Set<string>(ALLOWED_OG_IMAGE_MIMES);

const NON_DISCLOSURE_DECISION_REASONS = new Set<PublishedSeoDecision["reason"]>([
  "unknown_or_unverified_host",
  "error_route",
  "tenant_not_found_or_destroyed",
  "tenant_suspended",
  "tenant_recovery",
  "resource_not_published",
  "invalid_pagination",
  "out_of_range_pagination",
]);

function hasAsciiControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes a BCP-47 (`id-ID`) or OG (`id_ID`) locale tag to `ll_CC` format.
 * Defaults safely to `id_ID`.
 */
export function normalizeOgLocale(raw?: string | null): string {
  if (typeof raw !== "string") {
    return DEFAULT_OG_LOCALE;
  }
  const cleaned = sanitizeSeoText(raw, { maxLength: 16 });
  if (!cleaned) {
    return DEFAULT_OG_LOCALE;
  }
  const parts = cleaned.split(/[-_]/);
  const lang = parts[0]?.toLowerCase() ?? "";
  const region = parts[1]?.toUpperCase() ?? "";
  if (/^[a-z]{2}$/.test(lang) && /^[A-Z]{2}$/.test(region)) {
    return `${lang}_${region}`;
  }
  if (lang === "id") {
    return DEFAULT_OG_LOCALE;
  }
  return DEFAULT_OG_LOCALE;
}

/**
 * Formats an optional timestamp into a strict ISO-8601 UTC string, or `null` when invalid.
 */
function normalizeIsoTimestamp(value: string | number | Date | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    if (hasAsciiControlChars(value)) return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Validates a trusted media origin (e.g. `https://media.punyasitus.com`).
 * Allows subdomains of `PLATFORM_HOSTS.marketing` (such as `media.punyasitus.com`)
 * as well as verified public HTTPS domains, while rejecting `http://`, IP literals,
 * `localhost`/internal hosts, credentials, ports, and path/query smuggling.
 */
export function validateTrustedMediaOrigin(rawOrigin: string): string | null {
  if (typeof rawOrigin !== "string" || hasAsciiControlChars(rawOrigin)) {
    return null;
  }
  const trimmed = rawOrigin.trim().replace(/\/+$/, "");
  if (!trimmed || !/^https:\/\//i.test(trimmed)) {
    return null;
  }
  const afterScheme = trimmed.slice(8);
  if (
    !afterScheme ||
    afterScheme.includes("@") ||
    /[/?#\\<>"'\s]/.test(afterScheme) ||
    afterScheme.includes(":")
  ) {
    return null;
  }
  const host = afterScheme.toLowerCase().replace(/\.$/, "");
  // Allow platform media host (`media.punyasitus.com` or `cdn.punyasitus.com`) explicitly
  const platformMediaSuffix = `.${PLATFORM_HOSTS.marketing}`;
  if (host.endsWith(platformMediaSuffix)) {
    const label = host.slice(0, -platformMediaSuffix.length);
    if (label && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return `https://${host}`;
    }
    return null;
  }
  try {
    const validatedHost = validateCanonicalHostname(host);
    return `https://${validatedHost}`;
  } catch {
    return null;
  }
}

function buildAllowedImageOrigins(
  verifiedOrigin: string | null,
  extraMediaOrigins?: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set<string>([DEFAULT_MEDIA_CDN_ORIGIN]);
  if (verifiedOrigin) {
    try {
      allowed.add(validateCanonicalOrigin(verifiedOrigin));
    } catch {
      // Ignore invalid origin
    }
  }
  if (extraMediaOrigins) {
    for (const raw of extraMediaOrigins) {
      const valid = validateTrustedMediaOrigin(raw);
      if (valid) {
        allowed.add(valid);
      }
    }
  }
  return allowed;
}

function resolveCandidateMimeType(
  declaredMime: string | null | undefined,
  pathname: string,
): AllowedOgImageMime | null {
  if (declaredMime !== undefined && declaredMime !== null && declaredMime.trim() !== "") {
    const norm = (declaredMime.split(";")[0] ?? "").trim().toLowerCase();
    return ALLOWED_OG_IMAGE_MIME_SET.has(norm) ? (norm as AllowedOgImageMime) : null;
  }
  const lowerPath = pathname.toLowerCase();
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".png")) return "image/png";
  return null;
}

function validateAndSanitizeImageUrl(
  rawUrl: string,
  allowedOrigins: ReadonlySet<string>,
  tenantId: string | null,
  isPlatformFallback: boolean,
):
  | { readonly ok: true; readonly url: string; readonly pathname: string }
  | { readonly ok: false; readonly reason: OgImageRejectionReason; readonly detail: string } {
  if (typeof rawUrl !== "string" || hasAsciiControlChars(rawUrl)) {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must be a string without ASCII control characters.",
    };
  }
  const trimmed = rawUrl.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_OG_URL_LENGTH ||
    !/^https:\/\//i.test(trimmed) ||
    /[\\<>"'\s]/.test(trimmed)
  ) {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must be a valid bounded https:// URL without unsafe characters.",
    };
  }

  // Inspect raw authority before WHATWG URL normalization can mask credentials/ports/traversal
  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rawRest = authorityEnd === -1 ? "/" : afterScheme.slice(authorityEnd);
  if (!rawAuthority || rawAuthority.includes("@") || rawAuthority.includes(":")) {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must not contain credentials or explicit ports.",
    };
  }
  if (rawRest.includes("..") || /%(?:2e|2f|5c|00)/i.test(rawRest)) {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must not contain path traversal segments.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL could not be parsed.",
    };
  }

  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must strictly use https:// with no credentials or port.",
    };
  }

  const normalizedOrigin = validateTrustedMediaOrigin(`https://${parsed.hostname}`);
  if (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin)) {
    return {
      ok: false,
      reason: "untrusted_origin",
      detail: `OG image origin '${parsed.origin}' is not in the verified origin or media CDN allowlist.`,
    };
  }

  const pathname = parsed.pathname;
  if (!pathname || pathname === "/") {
    return {
      ok: false,
      reason: "unsafe_url",
      detail: "OG image URL must include an asset path.",
    };
  }

  const lowerPath = pathname.toLowerCase();
  if (lowerPath.includes("/quarantine/") || lowerPath.includes("/trash/")) {
    return {
      ok: false,
      reason: "invalid_r2_key",
      detail: "OG image URL must never reference quarantine or trash storage paths.",
    };
  }

  // Enforce tenant namespace isolation when URL uses the standard `/t/<tenantId>/...` path prefix
  const tenantPathMatch = /^\/t\/([^/]+)\//i.exec(pathname);
  if (tenantPathMatch) {
    const urlTenantId = tenantPathMatch[1] ?? "";
    if (!isPlatformFallback && (!tenantId || urlTenantId !== tenantId)) {
      return {
        ok: false,
        reason: "cross_tenant",
        detail: `OG image URL tenant namespace '${urlTenantId}' does not match authorized tenant.`,
      };
    }
  }

  // Strip fragments cleanly; never allow raw query smuggling on R2 derivative URLs
  const cleanUrl = `${normalizedOrigin}${pathname}`;
  return { ok: true, url: cleanUrl, pathname };
}

export interface ValidateOgImageContext {
  readonly tenantId: string | null;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly defaultAlt: string;
  readonly slot: OgImageCandidateSlot;
}

/**
 * Strictly validates a single OG image candidate against REQ-023 / PLAN §7.3 invariants:
 * - Tenant ownership (`tenantId` match + optional `r2Key` boundary via `assertTenantR2Key`)
 * - Media lifecycle `status === "ready"` and non-trashed (`deletedAt == null`)
 * - Exact `1200x630` dimensions
 * - Exact byte budget `1 <= byteSize <= 307_200` (300 KiB)
 * - Allowed raster MIME (`image/webp`, `image/jpeg`, `image/png`)
 * - Safe HTTPS URL on verified canonical origin or trusted media CDN
 */
export function validateOgImageCandidate(
  candidate: OgImageCandidate | null | undefined,
  ctx: ValidateOgImageContext,
):
  | { readonly ok: true; readonly image: ResolvedOgImage }
  | { readonly ok: false; readonly rejection: OgImageRejection } {
  if (!candidate) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "missing",
        detail: "No OG image candidate provided.",
      },
    };
  }

  const isPlatformFallback = ctx.slot === "platform_fallback" && candidate.isPlatformFallback === true;

  if (!isPlatformFallback) {
    if (!ctx.tenantId || !candidate.tenantId || candidate.tenantId.trim() !== ctx.tenantId.trim()) {
      return {
        ok: false,
        rejection: {
          slot: ctx.slot,
          reason: "cross_tenant",
          detail: "Tenant OG image candidate is missing matching tenant ownership.",
        },
      };
    }

    if (candidate.deletedAt !== undefined && candidate.deletedAt !== null) {
      return {
        ok: false,
        rejection: {
          slot: ctx.slot,
          reason: "trashed",
          detail: "Trashed media item is ineligible for Open Graph output.",
        },
      };
    }

    if (candidate.status !== "ready") {
      return {
        ok: false,
        rejection: {
          slot: ctx.slot,
          reason: candidate.status === "trashed" ? "trashed" : "not_ready",
          detail: `Media status '${String(candidate.status)}' is not ready for Open Graph output.`,
        },
      };
    }

    if (
      candidate.dbStatus !== undefined &&
      candidate.dbStatus !== null &&
      candidate.dbStatus !== "ready"
    ) {
      return {
        ok: false,
        rejection: {
          slot: ctx.slot,
          reason: "not_ready",
          detail: `Media DB status '${candidate.dbStatus}' is not ready for Open Graph output.`,
        },
      };
    }

    if (candidate.r2Key !== undefined && candidate.r2Key !== null) {
      try {
        assertTenantR2Key(ctx.tenantId, candidate.r2Key, ["media"]);
      } catch {
        return {
          ok: false,
          rejection: {
            slot: ctx.slot,
            reason: "invalid_r2_key",
            detail: "OG image R2 key failed strict tenant media namespace validation.",
          },
        };
      }
    }
  } else if (candidate.deletedAt !== undefined && candidate.deletedAt !== null) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "trashed",
        detail: "Fallback OG image is marked deleted.",
      },
    };
  }

  if (
    !Number.isInteger(candidate.width) ||
    !Number.isInteger(candidate.height) ||
    candidate.width !== OG_IMAGE_WIDTH ||
    candidate.height !== OG_IMAGE_HEIGHT
  ) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "invalid_dimensions",
        detail: `OG image dimensions (${String(candidate.width)}x${String(candidate.height)}) must be ${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT}.`,
      },
    };
  }

  if (!Number.isInteger(candidate.byteSize) || candidate.byteSize <= 0) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "invalid_byte_size",
        detail: `OG image byteSize (${String(candidate.byteSize)}) must be a positive integer.`,
      },
    };
  }

  if (candidate.byteSize > OG_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "oversized",
        detail: `OG image byteSize (${candidate.byteSize}) exceeds the ${OG_IMAGE_MAX_BYTES}-byte (300 KiB) budget.`,
      },
    };
  }

  const checkedUrl = validateAndSanitizeImageUrl(
    candidate.url,
    ctx.allowedOrigins,
    ctx.tenantId,
    isPlatformFallback,
  );
  if (!checkedUrl.ok) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: checkedUrl.reason,
        detail: checkedUrl.detail,
      },
    };
  }

  const mimeType = resolveCandidateMimeType(candidate.mimeType, checkedUrl.pathname);
  if (!mimeType) {
    return {
      ok: false,
      rejection: {
        slot: ctx.slot,
        reason: "invalid_mime",
        detail: `Unsupported OG image MIME type '${String(candidate.mimeType ?? "")}'.`,
      },
    };
  }

  const alt =
    sanitizeSeoText(candidate.alt ?? "", { maxLength: MAX_OG_ALT_LENGTH }) ||
    sanitizeSeoText(ctx.defaultAlt, { maxLength: MAX_OG_ALT_LENGTH });

  return {
    ok: true,
    image: {
      url: checkedUrl.url,
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      alt,
      type: mimeType,
      byteSize: candidate.byteSize,
      source: ctx.slot,
    },
  };
}

function resolveOgType(
  routeKind: SeoRouteKind,
  explicitOgType?: OgType,
  offeringType?: OfferingType | null,
): OgType {
  if (explicitOgType === "website" || explicitOgType === "article" || explicitOgType === "product") {
    return explicitOgType;
  }
  if (routeKind === "post") {
    return "article";
  }
  if (routeKind === "offering" && offeringType === "product") {
    return "product";
  }
  return "website";
}

function buildArticleMeta(
  ogType: OgType,
  input: OgArticleInput | null | undefined,
): OpenGraphArticleMeta | null {
  if (ogType !== "article") {
    return null;
  }
  const publishedTime = normalizeIsoTimestamp(input?.publishedTime);
  const modifiedTime = normalizeIsoTimestamp(input?.modifiedTime);
  const author = sanitizeSeoText(input?.author ?? "", { maxLength: 120 }) || null;
  const section = sanitizeSeoText(input?.section ?? "", { maxLength: 80 }) || null;
  const tags: string[] = [];
  if (Array.isArray(input?.tags)) {
    const seen = new Set<string>();
    for (const rawTag of input.tags) {
      if (tags.length >= 10) break;
      const cleanTag = sanitizeSeoText(rawTag, { maxLength: 60 });
      if (!cleanTag) continue;
      const key = cleanTag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(cleanTag);
    }
  }
  return {
    publishedTime,
    modifiedTime,
    author,
    section,
    tags,
  };
}

// ---------------------------------------------------------------------------
// Public API: Generate Open Graph & Social Share Metadata
// ---------------------------------------------------------------------------

/**
 * Generates bounded, sanitized, tenant-isolated Open Graph, Twitter Card,
 * canonical, pagination, and robots metadata consuming TASK-051's
 * `resolvePublishedSeoDecision`.
 */
export function generateOpenGraphMetadata(input: GenerateOpenGraphInput): SocialMetadataDto {
  // 1. Evaluate authoritative SEO decision (throws SeoPolicyError on malicious host/origin!)
  const seoDecision = resolvePublishedSeoDecision(input.seo);

  let verifiedOrigin: string | null = null;
  if (input.seo.tenant && !NON_DISCLOSURE_DECISION_REASONS.has(seoDecision.reason)) {
    try {
      verifiedOrigin = resolveVerifiedCanonicalOrigin(input.seo.tenant).origin;
    } catch {
      verifiedOrigin = null;
    }
  } else if (seoDecision.canonical) {
    try {
      verifiedOrigin = new URL(seoDecision.canonical).origin;
    } catch {
      verifiedOrigin = null;
    }
  }

  // 2. Resolve bounded, sanitized text fields (PLAN §15.3 precedence)
  const siteName =
    sanitizeSeoText(input.siteName, { maxLength: MAX_OG_SITE_NAME_LENGTH }) || "PunyaSitus";
  const isNonDisclosure = NON_DISCLOSURE_DECISION_REASONS.has(seoDecision.reason);

  const effectiveText = resolveEffectiveSeoText({
    isHomepage: input.seo.routeKind === "homepage",
    resourceTitle: isNonDisclosure ? null : input.resourceTitle,
    resourceTitleOverride: isNonDisclosure
      ? null
      : (input.titleOverride ?? input.seo.resourceSeo?.titleOverride ?? null),
    resourceDescriptionOverride: isNonDisclosure
      ? null
      : (input.descriptionOverride ?? input.seo.resourceSeo?.descriptionOverride ?? null),
    resourceExcerpt: isNonDisclosure ? null : input.resourceExcerpt,
    siteTitle: siteName,
    siteTagline: isNonDisclosure ? null : input.siteTagline,
    separator: input.separator,
    pageNumber: seoDecision.pageNumber,
  });

  const ogTitleRaw = isNonDisclosure
    ? effectiveText.title
    : sanitizeSeoText(
        input.ogTitleOverride ?? input.seo.resourceSeo?.ogTitleOverride ?? effectiveText.title,
        { maxLength: MAX_OG_TITLE_LENGTH },
      ) || effectiveText.title;

  const ogDescriptionRaw = isNonDisclosure
    ? effectiveText.description
    : sanitizeSeoText(
        input.ogDescriptionOverride ??
          input.seo.resourceSeo?.ogDescriptionOverride ??
          effectiveText.description,
        { maxLength: MAX_OG_DESCRIPTION_LENGTH },
      ) || effectiveText.description;

  const ogType: OgType = isNonDisclosure
    ? "website"
    : resolveOgType(input.seo.routeKind, input.ogType, input.offeringType);

  const locale = normalizeOgLocale(input.locale);

  // 3. Strict canonical & og:url propagation (NEVER invent canonical/og:url when decision.canonical is null!)
  const canonical = seoDecision.canonical;
  const ogUrl = canonical !== null ? (seoDecision.socialUrl ?? canonical) : null;

  // 4. Strict OG image selection & safe fallback chain (resource -> tenant default -> platform fallback -> none)
  const allowedOrigins = buildAllowedImageOrigins(verifiedOrigin, input.allowedMediaOrigins);
  const tenantId = input.tenantId?.trim() || null;
  const imageRejections: OgImageRejection[] = [];
  let resolvedImage: ResolvedOgImage | null = null;

  const slots: readonly {
    readonly slot: OgImageCandidateSlot;
    readonly candidate: OgImageCandidate | null | undefined;
  }[] = isNonDisclosure
    ? [
        // Never leak unpublished/draft/suspended resource media on non-disclosure routes
        ...(input.resourceOgImage
          ? [
              {
                slot: "resource" as const,
                candidate: null,
              },
            ]
          : []),
        {
          slot: "platform_fallback" as const,
          candidate: input.platformFallbackOgImage
            ? { ...input.platformFallbackOgImage, isPlatformFallback: true }
            : null,
        },
      ]
    : [
        { slot: "resource" as const, candidate: input.resourceOgImage },
        { slot: "tenant_default" as const, candidate: input.tenantDefaultOgImage },
        {
          slot: "platform_fallback" as const,
          candidate: input.platformFallbackOgImage
            ? { ...input.platformFallbackOgImage, isPlatformFallback: true }
            : null,
        },
      ];

  if (isNonDisclosure && input.resourceOgImage) {
    imageRejections.push({
      slot: "resource",
      reason: "non_public_route",
      detail: `Resource OG image suppressed for non-public SEO decision '${seoDecision.reason}'.`,
    });
  }

  for (const entry of slots) {
    if (isNonDisclosure && entry.slot === "resource") {
      continue;
    }
    if (!entry.candidate) {
      continue;
    }
    const checked = validateOgImageCandidate(entry.candidate, {
      tenantId,
      allowedOrigins,
      defaultAlt: ogTitleRaw,
      slot: entry.slot,
    });
    if (checked.ok) {
      resolvedImage = checked.image;
      break;
    }
    imageRejections.push(checked.rejection);
  }

  // 5. Article metadata & Twitter Card assembly
  const articleMeta = isNonDisclosure ? null : buildArticleMeta(ogType, input.article);
  const twitterCard: TwitterCardType = resolvedImage !== null ? "summary_large_image" : "summary";

  return {
    title: effectiveText.title,
    description: effectiveText.description,
    canonical,
    robots: seoDecision.robotsMeta,
    prevUrl: seoDecision.prevUrl,
    nextUrl: seoDecision.nextUrl,
    og: {
      type: ogType,
      siteName,
      title: ogTitleRaw,
      description: ogDescriptionRaw,
      url: ogUrl,
      locale,
      image: resolvedImage,
      article: articleMeta,
    },
    twitter: {
      card: twitterCard,
      title: ogTitleRaw,
      description: sanitizeSeoDescription(ogDescriptionRaw),
      image: resolvedImage?.url ?? null,
      imageAlt: resolvedImage?.alt ?? null,
    },
    seoDecision,
    verifiedOrigin,
    imageRejections,
  };
}

// ---------------------------------------------------------------------------
// Published Resource Adapter & Media Record Mapper
// ---------------------------------------------------------------------------

export interface MediaRecordLikeForOg {
  readonly id: number;
  readonly kind?: "image" | "video";
  readonly status: string;
  readonly dbStatus?: string;
  readonly deletedAt?: number | null;
  readonly r2Key: string;
  readonly altText?: string | null;
  readonly variants: MediaVariantsManifest | null;
}

/**
 * Converts a tenant `media_items` record (from `@punyasitus/db/media/index`) into an
 * `OgImageCandidate` using ONLY its `variants.og` derivative metadata (never raw original).
 * Returns `null` if the record has no `og` derivative manifest.
 */
export function buildOgImageCandidateFromMediaRecord(params: {
  readonly tenantId: string;
  readonly media: MediaRecordLikeForOg | null | undefined;
  readonly mediaPublicBaseUrl?: string | null;
  readonly platformDomain?: string | null;
  readonly fallbackAlt?: string | null;
}): OgImageCandidate | null {
  const { media } = params;
  if (!media || (media.kind && media.kind !== "image")) {
    return null;
  }
  const ogVariant = media.variants?.og;
  if (!ogVariant) {
    return null;
  }
  const baseOrigin =
    validateTrustedMediaOrigin(params.mediaPublicBaseUrl ?? "") ??
    validateTrustedMediaOrigin(
      `https://media.${(params.platformDomain ?? PLATFORM_HOSTS.marketing).trim().toLowerCase()}`,
    ) ??
    DEFAULT_MEDIA_CDN_ORIGIN;

  const cleanKey = ogVariant.key.replace(/^\/+/, "");
  return {
    tenantId: params.tenantId,
    status: media.status,
    dbStatus: media.dbStatus ?? media.status,
    deletedAt: media.deletedAt ?? null,
    r2Key: ogVariant.key,
    url: `${baseOrigin}/${cleanKey}`,
    width: ogVariant.width,
    height: ogVariant.height,
    byteSize: ogVariant.bytes,
    mimeType: ogVariant.mimeType,
    alt: media.altText?.trim() || params.fallbackAlt?.trim() || "",
  };
}

export interface GeneratePublishedResourceOgInput extends PublishedResourceSeoInput {
  readonly tenantId: string;
  readonly fallbackSiteTitle?: string;
  readonly articleAuthor?: string | null;
  readonly articleSection?: string | null;
  readonly articleTags?: readonly string[] | null;
  readonly resourceOgImage?: OgImageCandidate | null;
  readonly tenantDefaultOgImage?: OgImageCandidate | null;
  readonly platformFallbackOgImage?: OgImageCandidate | null;
  readonly allowedMediaOrigins?: readonly string[];
}

/**
 * High-level convenience helper binding directly to `@punyasitus/db/publication/index`
 * (`getPublishedResource`) DTOs and `resolvePublishedResourceSeoDecision`.
 */
export function generatePublishedResourceOpenGraph(
  input: GeneratePublishedResourceOgInput,
): SocialMetadataDto {
  const decision = resolvePublishedResourceSeoDecision(input);
  const siteName = input.siteSettings?.siteTitle ?? input.fallbackSiteTitle ?? "PunyaSitus";
  const siteTagline = input.siteSettings?.tagline ?? null;
  const locale = input.siteSettings?.locale ?? "id-ID";

  const resource: PublishedContentDto | null = input.resource;
  if (!resource) {
    return generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: input.requestPathname ?? "/",
        query: input.query,
        tenant: input.tenant,
        siteVisibility: input.siteSettings?.siteVisibility ?? "public",
        resourceState: "missing",
      },
      tenantId: input.tenantId,
      siteName,
      siteTagline,
      locale,
      platformFallbackOgImage: input.platformFallbackOgImage,
      allowedMediaOrigins: input.allowedMediaOrigins,
    });
  }

  let routeKind: SeoRouteKind;
  let resourceTitle: string;
  let resourceExcerpt: string | null = null;
  let offeringType: OfferingType | null = null;
  let article: OgArticleInput | null = null;

  if (resource.resourceType === "page") {
    routeKind = resource.data.isHomepage ? "homepage" : "page";
    resourceTitle = resource.data.title;
  } else if (resource.resourceType === "post") {
    routeKind = "post";
    resourceTitle = resource.data.title;
    resourceExcerpt = resource.data.excerpt ?? null;
    article = {
      publishedTime: resource.publishedAt,
      modifiedTime: resource.contentModifiedAt,
      author: input.articleAuthor ?? null,
      section: input.articleSection ?? null,
      tags: input.articleTags ?? null,
    };
  } else {
    routeKind = "offering";
    resourceTitle = resource.data.title;
    resourceExcerpt = resource.data.summary ?? null;
    offeringType = resource.data.offeringType;
  }

  const canonicalPath = resolvePublishedResourcePathname(resource);
  const effectiveRouteKind: SeoRouteKind =
    decision.reason === "homepage_slug_redirect" ? "homepage_slug_alias" : routeKind;

  const seoResult = generateOpenGraphMetadata({
    seo: {
      surface: "public_tenant",
      routeKind: effectiveRouteKind,
      pathname: input.requestPathname ?? canonicalPath,
      query: input.query,
      tenant: input.tenant,
      siteVisibility: input.siteSettings?.siteVisibility ?? "public",
      resourceState: decision.reason === "resource_not_published" ? "disabled" : "published",
      resourceSeo: resource.data.seo ?? null,
      canonicalOverride: input.canonicalOverride,
      redirectTargetPath: decision.reason === "homepage_slug_redirect" ? "/" : undefined,
    },
    tenantId: input.tenantId,
    siteName,
    siteTagline,
    locale,
    resourceTitle,
    resourceExcerpt,
    offeringType,
    article,
    resourceOgImage: input.resourceOgImage,
    tenantDefaultOgImage: input.tenantDefaultOgImage,
    platformFallbackOgImage: input.platformFallbackOgImage,
    allowedMediaOrigins: input.allowedMediaOrigins,
  });

  return seoResult;
}

// ---------------------------------------------------------------------------
// Pure-TS Safe Head HTML Renderer (Shared Contract with SEOHead.astro)
// ---------------------------------------------------------------------------

export interface RenderSeoHeadHtmlOptions {
  /** Optional single JSON-LD object or array of JSON-LD objects (safely escaped via `safeJsonLdStringify`). */
  readonly jsonLd?: unknown | readonly unknown[];
  /** Emit `<title>` tag (default `true`). */
  readonly includeTitle?: boolean;
  /** Emit `<meta name="description">` tag (default `true`). */
  readonly includeDescription?: boolean;
}

/**
 * Normalizes optional `jsonLd` input into an array of safely escaped JSON-LD strings
 * via TASK-051's `safeJsonLdStringify`.
 */
export function serializeJsonLdBlocks(
  jsonLd: unknown | readonly unknown[] | undefined,
): readonly string[] {
  if (jsonLd === undefined || jsonLd === null) {
    return [];
  }
  const items = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  const out: string[] = [];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    if (typeof item === "object") {
      out.push(safeJsonLdStringify(item));
    }
  }
  return out;
}

/**
 * Renders the complete escaped `<head>` metadata tags for a `SocialMetadataDto`
 * using TASK-051's `escapeHtmlText`, `escapeHtmlAttribute`, and `safeJsonLdStringify`.
 */
export function renderSeoHeadHtml(
  metadata: SocialMetadataDto,
  options: RenderSeoHeadHtmlOptions = {},
): string {
  const includeTitle = options.includeTitle ?? true;
  const includeDescription = options.includeDescription ?? true;
  const lines: string[] = [];

  if (includeTitle) {
    lines.push(`<title>${escapeHtmlText(metadata.title)}</title>`);
  }
  if (includeDescription && metadata.description) {
    lines.push(`<meta name="description" content="${escapeHtmlAttribute(metadata.description)}" />`);
  }
  lines.push(`<meta name="robots" content="${escapeHtmlAttribute(metadata.robots)}" />`);

  if (metadata.canonical) {
    lines.push(`<link rel="canonical" href="${escapeHtmlAttribute(metadata.canonical)}" />`);
  }
  if (metadata.prevUrl) {
    lines.push(`<link rel="prev" href="${escapeHtmlAttribute(metadata.prevUrl)}" />`);
  }
  if (metadata.nextUrl) {
    lines.push(`<link rel="next" href="${escapeHtmlAttribute(metadata.nextUrl)}" />`);
  }

  // Open Graph tags
  lines.push(`<meta property="og:type" content="${escapeHtmlAttribute(metadata.og.type)}" />`);
  lines.push(
    `<meta property="og:site_name" content="${escapeHtmlAttribute(metadata.og.siteName)}" />`,
  );
  lines.push(`<meta property="og:title" content="${escapeHtmlAttribute(metadata.og.title)}" />`);
  if (metadata.og.description) {
    lines.push(
      `<meta property="og:description" content="${escapeHtmlAttribute(metadata.og.description)}" />`,
    );
  }
  if (metadata.og.url) {
    lines.push(`<meta property="og:url" content="${escapeHtmlAttribute(metadata.og.url)}" />`);
  }
  lines.push(`<meta property="og:locale" content="${escapeHtmlAttribute(metadata.og.locale)}" />`);

  if (metadata.og.image) {
    lines.push(
      `<meta property="og:image" content="${escapeHtmlAttribute(metadata.og.image.url)}" />`,
    );
    lines.push(
      `<meta property="og:image:width" content="${escapeHtmlAttribute(String(metadata.og.image.width))}" />`,
    );
    lines.push(
      `<meta property="og:image:height" content="${escapeHtmlAttribute(String(metadata.og.image.height))}" />`,
    );
    if (metadata.og.image.alt) {
      lines.push(
        `<meta property="og:image:alt" content="${escapeHtmlAttribute(metadata.og.image.alt)}" />`,
      );
    }
    lines.push(
      `<meta property="og:image:type" content="${escapeHtmlAttribute(metadata.og.image.type)}" />`,
    );
  }

  // Article tags when og:type === "article"
  if (metadata.og.type === "article" && metadata.og.article) {
    if (metadata.og.article.publishedTime) {
      lines.push(
        `<meta property="article:published_time" content="${escapeHtmlAttribute(metadata.og.article.publishedTime)}" />`,
      );
    }
    if (metadata.og.article.modifiedTime) {
      lines.push(
        `<meta property="article:modified_time" content="${escapeHtmlAttribute(metadata.og.article.modifiedTime)}" />`,
      );
    }
    if (metadata.og.article.author) {
      lines.push(
        `<meta property="article:author" content="${escapeHtmlAttribute(metadata.og.article.author)}" />`,
      );
    }
    if (metadata.og.article.section) {
      lines.push(
        `<meta property="article:section" content="${escapeHtmlAttribute(metadata.og.article.section)}" />`,
      );
    }
    for (const tag of metadata.og.article.tags) {
      lines.push(`<meta property="article:tag" content="${escapeHtmlAttribute(tag)}" />`);
    }
  }

  // Twitter Card tags
  lines.push(`<meta name="twitter:card" content="${escapeHtmlAttribute(metadata.twitter.card)}" />`);
  lines.push(
    `<meta name="twitter:title" content="${escapeHtmlAttribute(metadata.twitter.title)}" />`,
  );
  if (metadata.twitter.description) {
    lines.push(
      `<meta name="twitter:description" content="${escapeHtmlAttribute(metadata.twitter.description)}" />`,
    );
  }
  if (metadata.twitter.image) {
    lines.push(
      `<meta name="twitter:image" content="${escapeHtmlAttribute(metadata.twitter.image)}" />`,
    );
    if (metadata.twitter.imageAlt) {
      lines.push(
        `<meta name="twitter:image:alt" content="${escapeHtmlAttribute(metadata.twitter.imageAlt)}" />`,
      );
    }
  }

  // Optional escaped JSON-LD blocks
  for (const jsonStr of serializeJsonLdBlocks(options.jsonLd)) {
    lines.push(`<script type="application/ld+json">${jsonStr}</script>`);
  }

  return lines.join("\n");
}
