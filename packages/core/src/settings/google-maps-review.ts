import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "../link-sanitizer.ts";

/**
 * Strict Google Maps Review Link Validator & Safe Plain-Link Builder
 * (`packages/core/src/settings/google-maps-review.ts`; TASK-073, REQ-074, PLAN §18.4).
 *
 * Security & Product Invariants:
 * - Plain external link ONLY: zero widgets, zero third-party scripts, zero copied review text,
 *   and zero `Review` / `AggregateRating` JSON-LD schema.
 * - Strict host + path allowlist (PLAN §18.4):
 *   1. `https://maps.app.goo.gl/<slug>`
 *   2. `https://g.page/r/<id>/review` (and `https://g.page/<slug>` / `https://g.page/<slug>/review`)
 *   3. `https://www.google.com/maps...`, `https://google.com/maps...`,
 *      `https://www.google.co.id/maps...`, `https://maps.google.com/maps...`
 *   4. `https://search.google.com/local/writereview?placeid=<id>`
 * - Explicitly REJECTS open redirects such as `https://www.google.com/url?...`,
 *   non-HTTPS schemes (`http://`, `javascript:`, `data:`), embedded credentials,
 *   non-default ports, private/loopback IPs, path traversal, and non-Google domains.
 */

export const GOOGLE_MAPS_REVIEW_TARGET = "_blank" as const;
export const GOOGLE_MAPS_REVIEW_REL = "noopener noreferrer nofollow" as const;
export const GOOGLE_MAPS_REVIEW_DEFAULT_LABEL = "Lihat ulasan kami di Google" as const;
export const GOOGLE_MAPS_WRITE_REVIEW_DEFAULT_LABEL = "Tulis Ulasan di Google" as const;

export const GOOGLE_BUSINESS_PROFILE_HELP_URL =
  "https://support.google.com/business/answer/3038177" as const;
export const GOOGLE_BUSINESS_PROFILE_REVIEW_HELP_URL =
  "https://support.google.com/business/answer/7035772" as const;
export const PUNYASITUS_GBP_HELP_ARTICLE_PATH =
  "/bantuan/mengoptimalkan-seo-dan-visibilitas-ai" as const;

export const GOOGLE_MAPS_REVIEW_ALLOWED_HOSTS = [
  "maps.app.goo.gl",
  "g.page",
  "www.google.com",
  "google.com",
  "www.google.co.id",
  "maps.google.com",
  "search.google.com",
] as const;

export type GoogleMapsReviewAllowedHost = (typeof GOOGLE_MAPS_REVIEW_ALLOWED_HOSTS)[number];

const GOOGLE_MAPS_PATH_HOSTS: ReadonlySet<string> = new Set([
  "www.google.com",
  "google.com",
  "www.google.co.id",
  "maps.google.com",
]);

export type GoogleMapsReviewLinkKind = "write_review" | "maps_profile" | "short_link";

export type GoogleMapsReviewUrlErrorCode =
  | "EMPTY_URL"
  | "INVALID_TYPE"
  | "URL_TOO_LONG"
  | "CONTROL_CHARACTER"
  | "MALFORMED_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "EMBEDDED_CREDENTIALS"
  | "FORBIDDEN_HOST"
  | "DISALLOWED_PORT"
  | "DISALLOWED_HOST"
  | "DISALLOWED_PATH"
  | "MISSING_PLACE_ID";

export interface ValidatedGoogleMapsReviewUrl {
  readonly ok: true;
  readonly href: string;
  readonly hostname: GoogleMapsReviewAllowedHost;
  readonly kind: GoogleMapsReviewLinkKind;
  readonly target: typeof GOOGLE_MAPS_REVIEW_TARGET;
  readonly rel: typeof GOOGLE_MAPS_REVIEW_REL;
}

export interface InvalidGoogleMapsReviewUrl {
  readonly ok: false;
  readonly code: GoogleMapsReviewUrlErrorCode;
  readonly message: string;
}

export type GoogleMapsReviewUrlValidationResult =
  | ValidatedGoogleMapsReviewUrl
  | InvalidGoogleMapsReviewUrl;

export interface SafeGoogleMapsReviewLink {
  readonly href: string;
  readonly label: string;
  readonly target: typeof GOOGLE_MAPS_REVIEW_TARGET;
  readonly rel: typeof GOOGLE_MAPS_REVIEW_REL;
  readonly kind: GoogleMapsReviewLinkKind;
  readonly hostname: GoogleMapsReviewAllowedHost;
}

const MAPS_APP_SLUG_RE = /^\/[A-Za-z0-9_-]{3,128}\/?$/;
const G_PAGE_REVIEW_ID_RE = /^\/r\/[A-Za-z0-9_-]{3,128}\/review\/?$/i;
const G_PAGE_PROFILE_ID_RE = /^\/r\/[A-Za-z0-9_-]{3,128}\/?$/i;
const G_PAGE_SLUG_REVIEW_RE = /^\/(?!url(?:\/|$)|r(?:\/|$))[A-Za-z0-9._-]{2,128}\/review\/?$/i;
const G_PAGE_SLUG_PROFILE_RE = /^\/(?!url(?:\/|$)|r(?:\/|$))[A-Za-z0-9._-]{2,128}\/?$/i;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function hasUnsafePathSequence(rawUrl: string, pathname: string): boolean {
  const lowerRaw = rawUrl.toLowerCase();
  if (
    pathname.includes("..") ||
    pathname.includes("\\") ||
    lowerRaw.includes("%2e%2e") ||
    lowerRaw.includes("%5c")
  ) {
    return true;
  }
  return false;
}

/**
 * Validates a Google Maps / Google Business Profile review URL strictly against the
 * PLAN §18.4 host + path allowlist. Never throws; returns a discriminated union result.
 */
export function validateGoogleMapsReviewUrl(rawUrl: unknown): GoogleMapsReviewUrlValidationResult {
  if (typeof rawUrl !== "string") {
    return {
      ok: false,
      code: "INVALID_TYPE",
      message: "Tautan ulasan Google Maps harus berupa teks URL HTTPS.",
    };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "EMPTY_URL",
      message: "Tautan ulasan Google Maps tidak boleh kosong.",
    };
  }

  let sanitized;
  try {
    sanitized = sanitizeExternalLink(trimmed, { nofollow: true });
  } catch (err) {
    if (err instanceof ExternalLinkValidationError) {
      switch (err.code) {
        case "UNSUPPORTED_PROTOCOL":
          return {
            ok: false,
            code: "UNSUPPORTED_PROTOCOL",
            message: "Tautan ulasan Google Maps wajib menggunakan protokol https://.",
          };
        case "EMBEDDED_CREDENTIALS":
          return {
            ok: false,
            code: "EMBEDDED_CREDENTIALS",
            message: "Tautan ulasan Google Maps tidak boleh mengandung kredensial (user@host).",
          };
        case "FORBIDDEN_HOST":
          return {
            ok: false,
            code: "FORBIDDEN_HOST",
            message: "Tautan ulasan Google Maps tidak boleh mengarah ke localhost atau IP privat.",
          };
        case "CONTROL_CHARACTER":
          return {
            ok: false,
            code: "CONTROL_CHARACTER",
            message: "Tautan ulasan Google Maps mengandung karakter kontrol tidak valid.",
          };
        case "URL_TOO_LONG":
          return {
            ok: false,
            code: "URL_TOO_LONG",
            message: "Tautan ulasan Google Maps melebihi batas panjang maksimum.",
          };
        default:
          return {
            ok: false,
            code: "MALFORMED_URL",
            message: "Format tautan ulasan Google Maps tidak valid.",
          };
      }
    }
    return {
      ok: false,
      code: "MALFORMED_URL",
      message: "Format tautan ulasan Google Maps tidak valid.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(sanitized.href);
  } catch {
    return {
      ok: false,
      code: "MALFORMED_URL",
      message: "Format tautan ulasan Google Maps tidak valid.",
    };
  }

  // Reject explicit custom ports and trailing dots in authority
  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = (authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd)).toLowerCase();
  if (parsed.port !== "" || rawAuthority.includes(":")) {
    return {
      ok: false,
      code: "DISALLOWED_PORT",
      message: "Tautan ulasan Google Maps tidak boleh menentukan port khusus.",
    };
  }
  if (rawAuthority.endsWith(".")) {
    return {
      ok: false,
      code: "DISALLOWED_HOST",
      message: "Host tautan ulasan Google Maps tidak valid.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  if (hasUnsafePathSequence(trimmed, pathname)) {
    return {
      ok: false,
      code: "DISALLOWED_PATH",
      message: "Path tautan ulasan Google Maps tidak diizinkan.",
    };
  }

  // 1. Short link: https://maps.app.goo.gl/<slug>
  if (host === "maps.app.goo.gl") {
    const slugSegment = pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!MAPS_APP_SLUG_RE.test(pathname) || slugSegment === "url") {
      return {
        ok: false,
        code: "DISALLOWED_PATH",
        message: "Tautan maps.app.goo.gl harus menyertakan kode tautan pendek yang valid.",
      };
    }
    return {
      ok: true,
      href: parsed.href,
      hostname: "maps.app.goo.gl",
      kind: "short_link",
      target: GOOGLE_MAPS_REVIEW_TARGET,
      rel: GOOGLE_MAPS_REVIEW_REL,
    };
  }

  // 2. Google Business Profile short link: https://g.page/r/<id>/review (or g.page/<slug>)
  if (host === "g.page") {
    if (G_PAGE_REVIEW_ID_RE.test(pathname) || G_PAGE_SLUG_REVIEW_RE.test(pathname)) {
      return {
        ok: true,
        href: parsed.href,
        hostname: "g.page",
        kind: "write_review",
        target: GOOGLE_MAPS_REVIEW_TARGET,
        rel: GOOGLE_MAPS_REVIEW_REL,
      };
    }
    if (G_PAGE_PROFILE_ID_RE.test(pathname) || G_PAGE_SLUG_PROFILE_RE.test(pathname)) {
      return {
        ok: true,
        href: parsed.href,
        hostname: "g.page",
        kind: "maps_profile",
        target: GOOGLE_MAPS_REVIEW_TARGET,
        rel: GOOGLE_MAPS_REVIEW_REL,
      };
    }
    return {
      ok: false,
      code: "DISALLOWED_PATH",
      message: "Tautan g.page harus berupa profil atau tautan ulasan resmi (contoh: https://g.page/r/.../review).",
    };
  }

  // 3. Google Maps hosts: www.google.com, google.com, www.google.co.id, maps.google.com
  //    Path MUST start with `/maps` (strictly `/maps` or `/maps/...`), rejecting `/url` open redirects.
  if (GOOGLE_MAPS_PATH_HOSTS.has(host)) {
    const isExactMaps = pathname === "/maps" || pathname === "/maps/";
    const isMapsSubpath = pathname.startsWith("/maps/") && pathname.length > "/maps/".length;

    if (!isExactMaps && !isMapsSubpath) {
      return {
        ok: false,
        code: "DISALLOWED_PATH",
        message:
          "Tautan Google harus menggunakan path /maps (tautan pengalihan seperti /url tidak diizinkan).",
      };
    }

    // Require either a meaningful sub-path under /maps/ or query parameters (e.g. ?cid=... or ?q=...)
    if (isExactMaps && parsed.search.length <= 1) {
      return {
        ok: false,
        code: "DISALLOWED_PATH",
        message:
          "Sertakan alamat profil Google Maps bisnis Anda (contoh: https://www.google.com/maps/place/... atau ?cid=...).",
      };
    }

    // Reject redirect-like subpaths directly under /maps/url
    if (pathname.toLowerCase() === "/maps/url" || pathname.toLowerCase().startsWith("/maps/url/")) {
      return {
        ok: false,
        code: "DISALLOWED_PATH",
        message: "Path pengalihan Google (/url) tidak diizinkan.",
      };
    }

    return {
      ok: true,
      href: parsed.href,
      hostname: host as GoogleMapsReviewAllowedHost,
      kind: "maps_profile",
      target: GOOGLE_MAPS_REVIEW_TARGET,
      rel: GOOGLE_MAPS_REVIEW_REL,
    };
  }

  // 4. Direct Google review link: https://search.google.com/local/writereview?placeid=<id>
  if (host === "search.google.com") {
    if (pathname !== "/local/writereview" && pathname !== "/local/writereview/") {
      return {
        ok: false,
        code: "DISALLOWED_PATH",
        message:
          "Tautan search.google.com hanya diizinkan pada path /local/writereview?placeid=....",
      };
    }
    const placeId = parsed.searchParams.get("placeid")?.trim() ?? "";
    if (!PLACE_ID_RE.test(placeId)) {
      return {
        ok: false,
        code: "MISSING_PLACE_ID",
        message:
          "Tautan search.google.com/local/writereview wajib menyertakan parameter placeid yang valid.",
      };
    }
    return {
      ok: true,
      href: parsed.href,
      hostname: "search.google.com",
      kind: "write_review",
      target: GOOGLE_MAPS_REVIEW_TARGET,
      rel: GOOGLE_MAPS_REVIEW_REL,
    };
  }

  return {
    ok: false,
    code: "DISALLOWED_HOST",
    message:
      "Hanya tautan resmi Google Maps / Google Business Profile yang diizinkan (g.page, maps.app.goo.gl, google.com/maps, maps.google.com/maps, atau search.google.com/local/writereview).",
  };
}

/**
 * Fail-closed helper for rendering a plain external Google Maps review link on public sections.
 * Returns `null` when unset or invalid so tampered/legacy values can never emit an unsafe link.
 */
export function buildSafeGoogleMapsReviewLink(
  rawUrl: string | null | undefined,
  options?: { readonly label?: string },
): SafeGoogleMapsReviewLink | null {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return null;
  }
  const validated = validateGoogleMapsReviewUrl(rawUrl);
  if (!validated.ok) {
    return null;
  }
  const customLabel = options?.label?.trim();
  const label =
    customLabel && customLabel.length > 0
      ? customLabel
      : validated.kind === "write_review"
        ? GOOGLE_MAPS_WRITE_REVIEW_DEFAULT_LABEL
        : GOOGLE_MAPS_REVIEW_DEFAULT_LABEL;

  return {
    href: validated.href,
    label,
    target: validated.target,
    rel: validated.rel,
    kind: validated.kind,
    hostname: validated.hostname,
  };
}
