import {
  buildPlatformSurfaceCspHeader,
  buildRelaxedGtmCspHeader,
  buildStrictPublicCspHeader,
  generateCspNonce,
  injectNonceIntoInlineHtmlScripts,
  parseStoredAnalyticsSettings,
  resolveEffectivePublicAnalyticsConfig,
  rotateCspNonceInHtmlScripts,
  selectPublicCspProfile,
  type PublicCspProfile,
} from "@punyasitus/core/analytics/config";
import { getTenantGtmKillSwitchStatus } from "@punyasitus/db/analytics-settings/index";
import { CONSENT_COOKIE_NAME, CONSENT_POLICY_VERSION, parseConsentCookie } from "../core/privacy.ts";
import {
  executeTenantMiddleware,
  type RequestGateOptions,
  type TenantGateEnv,
} from "../core/tenant.ts";
import type { AuthMiddlewareContext } from "./auth.ts";

/**
 * Public-Page CSP Profile, Warm-Cache Consent Bypass, & Per-Response Nonce Middleware
 * (`apps/web/src/middleware/csp.ts`; TASK-076, REQ-027, DEC-027, PLAN §18.1).
 *
 * Security invariants:
 * - Warm edge-cache isolation: any incoming request carrying an affirmative `__Host-ps_consent`
 *   cookie (`analytics: true`) bypasses the shared anonymous edge cache so a consented visitor
 *   on a GTM-enabled tenant NEVER receives a cached pre-consent strict-CSP HTML response, and
 *   per-response nonces are never cached or shared across visitors.
 * - Emits the relaxed GTM CSP profile with a fresh per-response cryptographic nonce ONLY when:
 *   1. `surface === "tenant"` with a serving tenant (`trial | active | grace | locked`)
 *   2. Non-admin, non-console, non-preview, non-API HTML `200` response
 *   3. Visitor request carries an affirmative `__Host-ps_consent` cookie (`analytics: true`)
 *   4. Tenant has GTM enabled with a valid `GTM-*` ID + owner risk acknowledgement AND
 *      authoritative operator kill switch is NOT active
 * - Preserves downstream strict CSP headers untouched (e.g., `default-src 'none'` on 404/503
 *   maintenance/error pages, or `PREVIEW_HTML_CSP_HEADER` on draft previews).
 * - Preserves Cloudflare Turnstile (`challenges.cloudflare.com`) and click-to-play
 *   YouTube (`www.youtube-nocookie.com`) on both strict and relaxed public CSP profiles.
 */

export interface CspMiddlewareRuntimeEnv {
  readonly PLATFORM_DB?: D1Database | null;
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
}

export interface CspMiddlewareOptions {
  readonly extraTestOrigins?: readonly string[];
}

const EXCLUDED_GTM_PATH_PREFIXES = [
  "/api",
  "/dashboard",
  "/console",
  "/preview",
  "/auth",
  "/account",
  "/_astro",
] as const;

const SERVING_TENANT_STATUSES = new Set(["trial", "active", "grace", "locked"]);

function isExcludedGtmPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return EXCLUDED_GTM_PATH_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`),
  );
}

/**
 * Returns `true` when the request's `Cookie` header contains a valid current-version
 * `__Host-ps_consent` cookie with `analytics: true`.
 */
export function hasAffirmativeAnalyticsConsentCookie(
  cookieHeader: string | null | undefined,
  expectedVersion: number = CONSENT_POLICY_VERSION,
  cookieName: string = CONSENT_COOKIE_NAME,
): boolean {
  const consent = parseConsentCookie(cookieHeader, {
    expectedVersion,
    cookieName,
  });
  return consent.hasDecision === true && consent.preferences.analytics === true;
}

/**
 * No-op `Cache` adapter used to bypass the anonymous edge cache for requests carrying
 * affirmative analytics consent, ensuring fresh per-response nonces and live GTM/kill-switch
 * evaluation without ever serving or overwriting the anonymous cached strict HTML.
 */
export function createConsentedEdgeCacheBypass(): Cache {
  const bypass = {
    async match(): Promise<Response | undefined> {
      return undefined;
    },
    async put(): Promise<void> {
      // Never write consented or nonced HTML into shared anonymous edge cache
    },
    async delete(): Promise<boolean> {
      return false;
    },
  };
  return bypass as unknown as Cache;
}

/**
 * Resolves the effective edge-cache option to pass to `executeTenantMiddleware`:
 * - Requests with affirmative analytics consent (`__Host-ps_consent` `analytics: true`) receive
 *   the bypass cache so a warm anonymous cache hit cannot shadow GTM + relaxed CSP + fresh nonce.
 * - Unconsented / anonymous requests keep the normal edge cache (`configuredCache` or `caches.default`).
 */
export function resolveConsentAwareEdgeCache(
  request: Request,
  configuredCache?: Cache,
): Cache | undefined {
  if (hasAffirmativeAnalyticsConsentCookie(request.headers.get("cookie"))) {
    return createConsentedEdgeCacheBypass();
  }
  return configuredCache;
}

async function isTenantGtmActiveForRequest(
  context: AuthMiddlewareContext,
  runtimeEnv: CspMiddlewareRuntimeEnv,
): Promise<boolean> {
  const tenant = context.locals.tenant;
  const tenantDb = context.locals.tenantDb;
  if (!tenant || !tenantDb) return false;
  if (!SERVING_TENANT_STATUSES.has(tenant.status)) return false;

  try {
    const [killSwitch, siteRow] = await Promise.all([
      getTenantGtmKillSwitchStatus(runtimeEnv.PLATFORM_DB, tenant.id),
      tenantDb
        .prepare(`SELECT analytics_config_json FROM site_settings WHERE id = 1 LIMIT 1`)
        .first<{ readonly analytics_config_json: string | null }>(),
    ]);
    if (killSwitch.disabled) return false;
    if (!siteRow?.analytics_config_json) return false;

    let parsedRaw: unknown = null;
    try {
      parsedRaw = JSON.parse(siteRow.analytics_config_json);
    } catch {
      return false;
    }
    const stored = parseStoredAnalyticsSettings(parsedRaw);
    const effective = resolveEffectivePublicAnalyticsConfig(stored, killSwitch.disabled);
    return effective.gtm.enabled && Boolean(effective.gtm.containerId);
  } catch {
    // Fail closed: keep strict CSP whenever GTM policy cannot be verified
    return false;
  }
}

const BASELINE_REFERRER_POLICY = "strict-origin-when-cross-origin";
const BASELINE_X_FRAME_OPTIONS = "SAMEORIGIN";
const BASELINE_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";
const CSP_NONCE_TOKEN_RE = /'nonce-([A-Za-z0-9+/=_-]{16,64})'/;

function isWebSocketUpgradeResponse(response: Response): boolean {
  return (
    response.status === 101 ||
    Boolean((response as Response & { readonly webSocket?: unknown }).webSocket)
  );
}

function setBaselineSecurityHeadersOn(headers: Headers, isHtml: boolean): void {
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (isHtml) {
    if (!headers.has("Referrer-Policy")) {
      headers.set("Referrer-Policy", BASELINE_REFERRER_POLICY);
    }
    if (!headers.has("X-Frame-Options")) {
      headers.set("X-Frame-Options", BASELINE_X_FRAME_OPTIONS);
    }
    if (!headers.has("Permissions-Policy")) {
      headers.set("Permissions-Policy", BASELINE_PERMISSIONS_POLICY);
    }
  }
}

function buildRewrittenHtmlResponse(
  response: Response,
  headers: Headers,
  rewrittenHtml: string | null,
  isHeadRequest: boolean,
): Response {
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(isHeadRequest ? null : rewrittenHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Ensures baseline HTTP security headers are present on every response (HTML, JSON API,
 * redirects, and error/state pages) without overriding stricter downstream headers or
 * breaking WebSocket 101 upgrade responses.
 */
export function applyBaselineSecurityHeaders(response: Response): Response {
  if (isWebSocketUpgradeResponse(response)) {
    return response;
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html");
  const needsNoSniff = !response.headers.has("X-Content-Type-Options");
  const needsReferrer = isHtml && !response.headers.has("Referrer-Policy");
  const needsFrameOptions = isHtml && !response.headers.has("X-Frame-Options");
  const needsPermissionsPolicy = isHtml && !response.headers.has("Permissions-Policy");

  if (!needsNoSniff && !needsReferrer && !needsFrameOptions && !needsPermissionsPolicy) {
    return response;
  }

  const headers = new Headers(response.headers);
  setBaselineSecurityHeadersOn(headers, isHtml);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function executePublicCspMiddleware(
  context: AuthMiddlewareContext & {
    readonly locals: AuthMiddlewareContext["locals"] & {
      cspNonce?: string | null;
      cspProfile?: PublicCspProfile;
    };
  },
  next: () => Promise<Response>,
  runtimeEnv: CspMiddlewareRuntimeEnv,
  options: CspMiddlewareOptions = {},
): Promise<Response> {
  context.locals.cspNonce = null;
  context.locals.cspProfile = "strict";

  let pathname: string;
  try {
    pathname = new URL(context.request.url).pathname;
  } catch {
    pathname = "/";
  }

  const surface = context.locals.surface;
  const isHeadRequest = context.request.method.toUpperCase() === "HEAD";
  const isTenantPublicCandidate =
    surface === "tenant" &&
    context.locals.tenant !== null &&
    !isExcludedGtmPath(pathname);

  let eligibleForRelaxedGtm = false;
  let generatedNonce: string | null = null;

  if (isTenantPublicCandidate) {
    if (hasAffirmativeAnalyticsConsentCookie(context.request.headers.get("cookie"))) {
      const gtmActive = await isTenantGtmActiveForRequest(context, runtimeEnv);
      if (gtmActive) {
        eligibleForRelaxedGtm = true;
        generatedNonce = generateCspNonce();
        context.locals.cspNonce = generatedNonce;
        context.locals.cspProfile = "gtm-relaxed";
      }
    }
  }

  const response = await next();
  if (isWebSocketUpgradeResponse(response)) {
    return response;
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html");

  // Preserve any explicitly set downstream CSP (e.g., 404/503 `default-src 'none'`, preview frame CSP)
  const existingCsp = response.headers.get("content-security-policy");
  if (existingCsp) {
    const headers = new Headers(response.headers);
    setBaselineSecurityHeadersOn(headers, isHtml);
    if (!headers.has("X-PunyaSitus-CSP-Profile")) {
      headers.set("X-PunyaSitus-CSP-Profile", "strict");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (!isHtml) {
    return applyBaselineSecurityHeaders(response);
  }

  // Non-tenant HTML surfaces (`marketing`, `app`, `console`, `unknown`):
  // emit strict nonced platform CSP (never `gtm-relaxed`, zero `'unsafe-inline'` in `script-src`)
  // and inject per-response nonce into inline `<script>` tags for clean Astro/React hydration.
  if (surface !== "tenant") {
    const platformNonce = generateCspNonce();
    context.locals.cspNonce = platformNonce;
    const headers = new Headers(response.headers);
    setBaselineSecurityHeadersOn(headers, true);
    headers.set(
      "Content-Security-Policy",
      buildPlatformSurfaceCspHeader(platformNonce, {
        allowInlineStyles: surface === "marketing",
        platformDomain: runtimeEnv.PLATFORM_DOMAIN,
      }),
    );
    headers.set("X-PunyaSitus-CSP-Profile", "strict");

    if (isHeadRequest) {
      return buildRewrittenHtmlResponse(response, headers, null, true);
    }

    const rawHtml = await response.text();
    const noncedHtml = injectNonceIntoInlineHtmlScripts(rawHtml, platformNonce);
    return buildRewrittenHtmlResponse(response, headers, noncedHtml, false);
  }

  const finalProfile = selectPublicCspProfile({
    surface,
    isPreview: false,
    isMaintenanceOrError: response.status >= 400,
    statusCode: response.status,
    gtmActive: eligibleForRelaxedGtm,
    hasAnalyticsConsent: eligibleForRelaxedGtm,
  });

  const headers = new Headers(response.headers);
  setBaselineSecurityHeadersOn(headers, true);

  if (finalProfile === "gtm-relaxed" && generatedNonce) {
    const allowExtraTestOrigins =
      runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test";
    headers.set(
      "Content-Security-Policy",
      buildRelaxedGtmCspHeader(
        generatedNonce,
        allowExtraTestOrigins ? options.extraTestOrigins : undefined,
      ),
    );
    headers.set("X-PunyaSitus-CSP-Profile", "gtm-relaxed");
    headers.set("Vary", "Cookie");
    headers.set("Cache-Control", "private, no-store");

    if (isHeadRequest) {
      return buildRewrittenHtmlResponse(response, headers, null, true);
    }

    const rawHtml = await response.text();
    const noncedHtml = injectNonceIntoInlineHtmlScripts(rawHtml, generatedNonce);
    return buildRewrittenHtmlResponse(response, headers, noncedHtml, false);
  }

  const strictNonce = generateCspNonce();
  context.locals.cspNonce = strictNonce;
  headers.set("Content-Security-Policy", buildStrictPublicCspHeader(strictNonce));
  headers.set("X-PunyaSitus-CSP-Profile", "strict");

  if (isHeadRequest) {
    return buildRewrittenHtmlResponse(response, headers, null, true);
  }

  const rawHtml = await response.text();
  const noncedHtml = injectNonceIntoInlineHtmlScripts(rawHtml, strictNonce);
  return buildRewrittenHtmlResponse(response, headers, noncedHtml, false);
}

/**
 * Full composed tenant + consent-aware edge-cache bypass + public CSP middleware runner.
 * Used both by `apps/web/src/middleware/index.ts` and `workerd` warm-cache integration tests.
 *
 * Ensures warm edge-cache HITs of strict tenant HTML rotate the cached CSP nonce to a fresh
 * per-response cryptographic nonce in both the `Content-Security-Policy` header and inline
 * `<script>` tags so no nonce is ever reused across HTTP responses.
 */
export async function executeTenantWithConsentAwareCspMiddleware(
  context: AuthMiddlewareContext & {
    readonly locals: AuthMiddlewareContext["locals"] & {
      cspNonce?: string | null;
      cspProfile?: PublicCspProfile;
    };
  },
  innerNext: () => Promise<Response>,
  tenantEnv: TenantGateEnv,
  options: RequestGateOptions & CspMiddlewareOptions & { readonly cache?: Cache } = {},
): Promise<Response> {
  const effectiveCache = resolveConsentAwareEdgeCache(context.request, options.cache);
  const response = await executeTenantMiddleware(
    context,
    () =>
      executePublicCspMiddleware(
        context,
        innerNext,
        {
          PLATFORM_DB: tenantEnv.PLATFORM_DB,
          APP_ENV: tenantEnv.APP_ENV,
          PLATFORM_DOMAIN: tenantEnv.PLATFORM_DOMAIN,
        },
        { extraTestOrigins: options.extraTestOrigins },
      ),
    tenantEnv,
    {
      ...options,
      ...(effectiveCache ? { cache: effectiveCache } : {}),
    },
  );

  if (isWebSocketUpgradeResponse(response)) {
    return response;
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = contentType.includes("text/html");
  const isWarmCacheHit = response.headers.get("X-PunyaSitus-Cache") === "HIT";
  const existingCsp = response.headers.get("Content-Security-Policy");

  if (isWarmCacheHit && isHtml && existingCsp) {
    const nonceMatch = CSP_NONCE_TOKEN_RE.exec(existingCsp);
    const cachedNonce = nonceMatch?.[1];
    if (cachedNonce) {
      const freshNonce = generateCspNonce();
      context.locals.cspNonce = freshNonce;
      const headers = new Headers(response.headers);
      setBaselineSecurityHeadersOn(headers, true);
      headers.set(
        "Content-Security-Policy",
        existingCsp.replace(`'nonce-${cachedNonce}'`, `'nonce-${freshNonce}'`),
      );

      const isHeadRequest = context.request.method.toUpperCase() === "HEAD";
      if (isHeadRequest) {
        return buildRewrittenHtmlResponse(response, headers, null, true);
      }

      const cachedHtml = await response.text();
      const rotatedHtml = rotateCspNonceInHtmlScripts(cachedHtml, cachedNonce, freshNonce);
      return buildRewrittenHtmlResponse(response, headers, rotatedHtml, false);
    }
  }

  return applyBaselineSecurityHeaders(response);
}
