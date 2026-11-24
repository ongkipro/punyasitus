/**
 * Content Security Policy (CSP) Profile Builder & Nonce Helpers for Tenant Public Pages
 * (`packages/core/src/analytics/csp.ts`; TASK-076, REQ-027, DEC-027, PLAN §18.1).
 *
 * Security invariants:
 * - TWO explicit CSP profiles:
 *   1. `strict`: default for ALL tenants without GTM, GTM-enabled tenants BEFORE analytics consent,
 *      and every `app`, `console`, `marketing`, `preview`, `maintenance`, and error response.
 *      Contains ZERO third-party GTM/GA4/Meta/TikTok origins, while explicitly allowing
 *      Cloudflare Turnstile (`https://challenges.cloudflare.com`, REQ-090/TASK-090) and
 *      click-to-play privacy-enhanced YouTube (`https://www.youtube-nocookie.com`, REQ-089/TASK-089).
 *   2. `gtm-relaxed`: emitted ONLY on `200 text/html` public pages of GTM-enabled tenants
 *      AFTER affirmative analytics consent (`__Host-ps_consent` with `analytics: true`),
 *      never when operator kill switch is active, never on admin/console/preview/maintenance/error.
 *      Uses a fresh per-response cryptographic `'nonce-<nonce>'` (ZERO `'unsafe-inline'` in `script-src`)
 *      plus Cloudflare Turnstile, YouTube-nocookie, and the verified vendor origins required by
 *      the shipped GTM container template (Google Tag Manager, GA4, Meta Pixel, TikTok Pixel).
 */

export type PublicCspProfile = "strict" | "gtm-relaxed";

const NONCE_RE = /^[A-Za-z0-9+/=_-]{16,64}$/;

export const FIRST_PARTY_PLATFORM_ORIGINS = Object.freeze({
  turnstile: "https://challenges.cloudflare.com" as const,
  youtubeNoCookie: "https://www.youtube-nocookie.com" as const,
});

/**
 * Verified origins needed by the shipped PunyaSitus GTM container template
 * (Google Tag Manager + Tag Assistant, Google Analytics 4, Meta Pixel, TikTok Pixel).
 */
export const GTM_CSP_TEMPLATE_ORIGINS = Object.freeze({
  scriptSrc: [
    "https://www.googletagmanager.com",
    "https://tagmanager.google.com",
    "https://www.google-analytics.com",
    "https://ssl.google-analytics.com",
    "https://connect.facebook.net",
    "https://analytics.tiktok.com",
  ] as const,
  connectSrc: [
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://stats.g.doubleclick.net",
    "https://www.facebook.com",
    "https://connect.facebook.net",
    "https://analytics.tiktok.com",
    "https://*.tiktok.com",
    "https://*.tiktokw.us",
  ] as const,
  imgSrc: [
    "https://www.googletagmanager.com",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://www.facebook.com",
    "https://analytics.tiktok.com",
  ] as const,
  frameSrc: [
    "https://www.googletagmanager.com",
    "https://www.facebook.com",
    "https://www.google.com",
    "https://maps.google.com",
  ] as const,
  styleSrc: [
    "https://www.googletagmanager.com",
    "https://tagmanager.google.com",
    "https://fonts.googleapis.com",
  ] as const,
  fontSrc: ["https://fonts.gstatic.com"] as const,
});

/**
 * Generates a fresh cryptographically random 128-bit Base64 CSP nonce per HTTP response.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function isValidCspNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

/**
 * Strict CSP profile for non-GTM tenants, pre-consent public pages, and fallback HTML.
 * Deliberately excludes all GTM / GA4 / Meta / TikTok origins and NEVER emits `'unsafe-inline'`
 * in `script-src`, while preserving Cloudflare Turnstile (`challenges.cloudflare.com`),
 * privacy-enhanced YouTube embeds (`www.youtube-nocookie.com`), and per-response nonces.
 */
export function buildStrictPublicCspHeader(nonce?: string): string {
  if (nonce !== undefined && !isValidCspNonce(nonce)) {
    throw new Error("Invalid CSP nonce: must be 16-64 base64/url-safe characters.");
  }

  const scriptSources = nonce
    ? ["'self'", `'nonce-${nonce}'`, FIRST_PARTY_PLATFORM_ORIGINS.turnstile]
    : ["'self'", FIRST_PARTY_PLATFORM_ORIGINS.turnstile];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "media-src 'self' https:",
    `connect-src 'self' ${FIRST_PARTY_PLATFORM_ORIGINS.turnstile}`,
    "font-src 'self' data:",
    `frame-src 'self' ${FIRST_PARTY_PLATFORM_ORIGINS.turnstile} ${FIRST_PARTY_PLATFORM_ORIGINS.youtubeNoCookie} https://www.google.com https://maps.google.com`,
  ].join("; ");
}

/**
 * Strict per-response nonced CSP profile for platform HTML surfaces (`marketing`, `app`, `console`).
 * Enforces `frame-ancestors 'self'`, `base-uri 'self'`, `object-src 'none'`, and zero `'unsafe-inline'`
 * in `script-src`, while supporting Turnstile, React/Astro island hydration via nonce, local blob
 * image/video previews for admin media uploads, and HTTPS API connections.
 */
export function buildPlatformSurfaceCspHeader(nonce: string): string {
  if (!isValidCspNonce(nonce)) {
    throw new Error("Invalid CSP nonce: must be 16-64 base64/url-safe characters.");
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    `script-src 'self' 'nonce-${nonce}' ${FIRST_PARTY_PLATFORM_ORIGINS.turnstile}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https:",
    "font-src 'self' data:",
    `frame-src 'self' ${FIRST_PARTY_PLATFORM_ORIGINS.turnstile}`,
  ].join("; ");
}

/**
 * Relaxed CSP profile emitted ONLY on consented public tenant pages with active GTM.
 * Uses a fresh per-response cryptographic nonce in `script-src` (no `'unsafe-inline'`) so GTM
 * can propagate the nonce to tenant tags, alongside Turnstile, YouTube-nocookie, and verified
 * GA4/Meta/TikTok template origins.
 */
export function buildRelaxedGtmCspHeader(
  nonce: string,
  extraTestOrigins?: readonly string[],
): string {
  if (!isValidCspNonce(nonce)) {
    throw new Error("Invalid CSP nonce: must be 16-64 base64/url-safe characters.");
  }

  const safeExtraOrigins: string[] = [];
  if (extraTestOrigins) {
    for (const origin of extraTestOrigins) {
      if (
        typeof origin === "string" &&
        /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(origin.trim())
      ) {
        safeExtraOrigins.push(origin.trim());
      }
    }
  }

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    FIRST_PARTY_PLATFORM_ORIGINS.turnstile,
    ...GTM_CSP_TEMPLATE_ORIGINS.scriptSrc,
    ...safeExtraOrigins,
  ];
  const connectSources = [
    "'self'",
    FIRST_PARTY_PLATFORM_ORIGINS.turnstile,
    ...GTM_CSP_TEMPLATE_ORIGINS.connectSrc,
    ...safeExtraOrigins,
  ];
  const imgSources = [
    "'self'",
    "data:",
    "https:",
    ...GTM_CSP_TEMPLATE_ORIGINS.imgSrc,
    ...safeExtraOrigins,
  ];
  const frameSources = [
    "'self'",
    FIRST_PARTY_PLATFORM_ORIGINS.turnstile,
    FIRST_PARTY_PLATFORM_ORIGINS.youtubeNoCookie,
    ...GTM_CSP_TEMPLATE_ORIGINS.frameSrc,
    ...safeExtraOrigins,
  ];
  const styleSources = ["'self'", "'unsafe-inline'", ...GTM_CSP_TEMPLATE_ORIGINS.styleSrc];
  const fontSources = ["'self'", "data:", ...GTM_CSP_TEMPLATE_ORIGINS.fontSrc];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    `img-src ${imgSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `font-src ${fontSources.join(" ")}`,
    `frame-src ${frameSources.join(" ")}`,
  ].join("; ");
}

export interface SelectPublicCspProfileInput {
  readonly surface: "tenant" | "app" | "console" | "marketing" | "unknown";
  readonly isPreview?: boolean;
  readonly isMaintenanceOrError?: boolean;
  readonly statusCode?: number;
  readonly gtmActive: boolean;
  readonly hasAnalyticsConsent: boolean;
}

/**
 * Pure decision function for choosing between `strict` and `gtm-relaxed` CSP profiles.
 * Returns `"gtm-relaxed"` ONLY when EVERY gate passes:
 * - public tenant surface
 * - not preview, not maintenance/error, HTTP 200
 * - tenant has GTM active (valid ID + owner risk ack + not killed by operator)
 * - visitor has granted affirmative analytics consent
 */
export function selectPublicCspProfile(input: SelectPublicCspProfileInput): PublicCspProfile {
  if (input.surface !== "tenant") return "strict";
  if (input.isPreview === true) return "strict";
  if (input.isMaintenanceOrError === true) return "strict";
  if (typeof input.statusCode === "number" && input.statusCode !== 200) return "strict";
  if (!input.gtmActive) return "strict";
  if (!input.hasAnalyticsConsent) return "strict";
  return "gtm-relaxed";
}

const SCRIPT_OPEN_TAG_RE = /<script\b([^>]*)>/gi;

/**
 * Attaches `nonce="<nonce>"` to executable inline `<script>` tags in first-party SSR HTML
 * (skipping `<script src="...">`, inert `<script type="application/json">` / `application/ld+json`,
 * and tags that already carry a `nonce=` attribute, without confusing `data-src=`/`data-nonce=`).
 */
export function injectNonceIntoInlineHtmlScripts(html: string, nonce: string): string {
  if (!isValidCspNonce(nonce)) return html;
  return html.replace(SCRIPT_OPEN_TAG_RE, (fullMatch, attrs: string) => {
    if (/(?:^|\s)nonce\s*=/i.test(attrs)) return fullMatch;
    if (/(?:^|\s)src\s*=/i.test(attrs)) return fullMatch;
    if (
      /(?:^|\s)type\s*=\s*(?:"application\/(?:ld\+)?json"|'application\/(?:ld\+)?json'|application\/(?:ld\+)?json\b)/i.test(
        attrs,
      )
    ) {
      return fullMatch;
    }
    return `<script nonce="${nonce}"${attrs}>`;
  });
}

/**
 * Rotates an existing CSP `nonce="..."` attribute on `<script>` tags from `previousNonce`
 * to a fresh per-response cryptographic `freshNonce` (e.g., when serving warm edge-cached HTML).
 */
export function rotateCspNonceInHtmlScripts(
  html: string,
  previousNonce: string,
  freshNonce: string,
): string {
  if (!isValidCspNonce(previousNonce) || !isValidCspNonce(freshNonce)) return html;
  return html.replace(SCRIPT_OPEN_TAG_RE, (fullMatch, attrs: string) => {
    if (!/(?:^|\s)nonce\s*=/i.test(attrs)) return fullMatch;
    return fullMatch.replace(
      /((?:^|\s)nonce\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
      (attrMatch, prefix: string, dq?: string, sq?: string, bare?: string) => {
        const current = dq ?? sq ?? bare ?? "";
        if (current !== previousNonce) return attrMatch;
        return `${prefix}"${freshNonce}"`;
      },
    );
  });
}
