import { normalizeHost } from "@punyasitus/core";

/**
 * Revisioned Edge Cache & Strict Preview Bypass Engine (REQ-036, REQ-001, PLAN §3 & §14, TASK-027).
 *
 * - Builds tenant-isolated, revision-versioned synthetic cache keys incorporating
 *   normalized `host`, `tenantId`, `cacheVersion` (`v=<cacheVersion>`), `pathname`,
 *   and allowlisted normalized query parameters.
 * - Immediately busts stale edge cache whenever `PLATFORM_DB.tenants.cache_version` increments.
 * - Strictly bypasses cache (both reads and writes) for preview requests, authenticated/cookie
 *   requests, non-GET/HEAD requests, unknown query parameters, and non-200 / `no-store` responses.
 */

export const MAX_EDGE_CACHE_TTL_SECONDS = 60;
export const DEFAULT_EDGE_CACHE_TTL_SECONDS = 60;

export const PREVIEW_HEADER_NAME = "X-PunyaSitus-Preview";
export const CACHE_STATUS_HEADER_NAME = "X-PunyaSitus-Cache";
export const CACHE_VERSION_HEADER_NAME = "X-PunyaSitus-Cache-Version";

export const PREVIEW_CACHE_CONTROL = "private, no-store, max-age=0";
export const PREVIEW_ROBOTS_TAG = "noindex, nofollow";

export const TENANT_CONSENT_COOKIE_NAME = "__Host-ps_consent";
export const SESSION_COOKIE_PREFIX = "__Host-ps_session";

/**
 * Default allowlist of public query parameter keys eligible for revisioned edge caching
 * (PLAN §3 & §15.2). Unknown query parameters automatically bypass edge cache.
 */
export const SUPPORTED_PUBLIC_QUERY_KEYS: ReadonlySet<string> = new Set([
  "page",
  "category",
  "tag",
  "type",
]);

export type EdgeCacheStatus = "HIT" | "MISS" | "BYPASS";

export type EdgeCacheBypassReason =
  | "preview_request"
  | "method_not_cacheable"
  | "non_public_path"
  | "authorization_header"
  | "personalized_cookie"
  | "unsupported_query_param"
  | "invalid_scope"
  | "cache_unavailable"
  | "response_not_cacheable";

export interface BuildRevisionedCacheKeyInput {
  readonly host: string;
  readonly tenantId: string;
  readonly cacheVersion: number;
  readonly pathname: string;
  readonly searchParams?: URLSearchParams | string;
  readonly themeVersion?: string | number;
  readonly allowedQueryKeys?: ReadonlySet<string>;
}

export type SafeQueryNormalizationResult =
  | { readonly ok: true; readonly query: string }
  | { readonly ok: false; readonly unsupportedKey: string };

export type CacheBypassEvaluation =
  | {
      readonly cacheable: true;
      readonly isPreview: false;
      readonly cacheKeyUrl: string;
    }
  | {
      readonly cacheable: false;
      readonly isPreview: boolean;
      readonly reason: EdgeCacheBypassReason;
      readonly cacheKeyUrl: null;
    };

export interface ServeWithRevisionedCacheParams {
  readonly request: Request;
  readonly tenantId: string;
  readonly host: string;
  readonly cacheVersion: number;
  readonly themeVersion?: string | number;
  readonly isPreview?: boolean;
  readonly allowedQueryKeys?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
  readonly cache?: Cache;
  readonly ctx?: Pick<ExecutionContext, "waitUntil">;
  readonly render: () => Promise<Response> | Response;
}

export interface ServeWithRevisionedCacheResult {
  readonly response: Response;
  readonly cacheStatus: EdgeCacheStatus;
  readonly cacheKey: string | null;
  readonly bypassReason: EdgeCacheBypassReason | null;
}

const DASHBOARD_PREVIEW_PATH_RE = /^\/dashboard\/[^/]+\/preview(?:\/|$)/i;
const SAFE_QUERY_VALUE_RE = /^[a-zA-Z0-9._-]{1,80}$/;

function isGetOrHead(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

function isNonPublicPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/console" ||
    pathname.startsWith("/console/")
  );
}

function normalizeCachePathname(pathname: string): string {
  const withLeading = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const collapsed = withLeading.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

/**
 * Normalizes query parameters deterministically for public cache keys.
 * - Rejects any unknown/unsupported query parameter (triggers cache bypass per PLAN §3).
 * - Rejects unsafe or oversized parameter values.
 * - Normalizes `page=1` away (canonical archive URL) and sorts keys alphabetically.
 */
export function normalizeSafeQueryParams(
  search: string | URLSearchParams | undefined,
  allowedKeys: ReadonlySet<string> = SUPPORTED_PUBLIC_QUERY_KEYS,
): SafeQueryNormalizationResult {
  if (!search) {
    return { ok: true, query: "" };
  }
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const entries: Array<readonly [string, string]> = [];

  for (const [rawKey, rawValue] of params.entries()) {
    const key = rawKey.trim().toLowerCase();
    if (!allowedKeys.has(key)) {
      return { ok: false, unsupportedKey: rawKey };
    }
    const value = rawValue.trim();
    if (!SAFE_QUERY_VALUE_RE.test(value)) {
      return { ok: false, unsupportedKey: rawKey };
    }
    if (key === "page" && value === "1") {
      continue;
    }
    entries.push([key, value]);
  }

  if (entries.length === 0) {
    return { ok: true, query: "" };
  }

  entries.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });

  const normalized = new URLSearchParams();
  for (const [k, v] of entries) {
    normalized.append(k, v);
  }
  return { ok: true, query: `?${normalized.toString()}` };
}

/**
 * Builds the canonical tenant-isolated, revisioned synthetic cache key URL:
 * `https://cache.punyasitus.com/t/<tenantId>/v=<cacheVersion>/<host><pathname><safeQuery>`
 * (or includes `/tv=<themeVersion>` when `themeVersion` is specified).
 *
 * Returns `null` if host/tenantId/cacheVersion is invalid or if query contains
 * unsupported parameters.
 */
export function buildRevisionedCacheKey(input: BuildRevisionedCacheKeyInput): string | null {
  const normalizedHost = normalizeHost(input.host);
  if (!normalizedHost) return null;

  const tenantId = input.tenantId.trim();
  if (!tenantId) return null;

  if (!Number.isInteger(input.cacheVersion) || input.cacheVersion < 0) {
    return null;
  }

  const normalizedPath = normalizeCachePathname(input.pathname);
  const queryRes = normalizeSafeQueryParams(input.searchParams, input.allowedQueryKeys);
  if (!queryRes.ok) {
    return null;
  }

  const themeSegment =
    input.themeVersion !== undefined && String(input.themeVersion).trim() !== ""
      ? `/tv=${encodeURIComponent(String(input.themeVersion).trim())}`
      : "";

  return `https://cache.punyasitus.com/t/${encodeURIComponent(tenantId)}/v=${input.cacheVersion}${themeSegment}/${normalizedHost}${normalizedPath}${queryRes.query}`;
}

/**
 * Detects whether a request is a draft preview request by explicit flag,
 * `/dashboard/<handle>/preview` route, `X-PunyaSitus-Preview` header, or `preview` query param.
 */
export function isPreviewRequest(
  request: Request,
  options?: { readonly isPreview?: boolean },
): boolean {
  if (options?.isPreview === true) return true;

  if (request.headers.has(PREVIEW_HEADER_NAME)) {
    return true;
  }

  try {
    const url = new URL(request.url);
    if (DASHBOARD_PREVIEW_PATH_RE.test(url.pathname)) {
      return true;
    }
    if (url.searchParams.has("preview")) {
      const val = (url.searchParams.get("preview") ?? "").trim().toLowerCase();
      if (val !== "0" && val !== "false") {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Returns `true` if the `Cookie` header contains `__Host-ps_session` or ANY cookie
 * other than the anonymous consent cookie (`__Host-ps_consent`).
 */
export function hasCacheBypassingCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader || !cookieHeader.trim()) return false;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
    if (!name) continue;
    if (name.startsWith(SESSION_COOKIE_PREFIX) || name !== TENANT_CONSENT_COOKIE_NAME) {
      return true;
    }
  }
  return false;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Evaluates whether an incoming request may read/write the revisioned edge cache.
 */
export function evaluateCacheBypass(
  request: Request,
  scope: {
    readonly tenantId: string;
    readonly host: string;
    readonly cacheVersion: number;
    readonly themeVersion?: string | number;
    readonly isPreview?: boolean;
    readonly allowedQueryKeys?: ReadonlySet<string>;
  },
): CacheBypassEvaluation {
  if (isPreviewRequest(request, { isPreview: scope.isPreview })) {
    return {
      cacheable: false,
      isPreview: true,
      reason: "preview_request",
      cacheKeyUrl: null,
    };
  }

  if (!isGetOrHead(request.method)) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "method_not_cacheable",
      cacheKeyUrl: null,
    };
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      cacheable: false,
      isPreview: false,
      reason: "invalid_scope",
      cacheKeyUrl: null,
    };
  }

  if (isNonPublicPath(url.pathname)) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "non_public_path",
      cacheKeyUrl: null,
    };
  }

  if (request.headers.has("authorization")) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "authorization_header",
      cacheKeyUrl: null,
    };
  }

  if (hasCacheBypassingCookie(request.headers.get("cookie"))) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "personalized_cookie",
      cacheKeyUrl: null,
    };
  }

  const queryCheck = normalizeSafeQueryParams(url.searchParams, scope.allowedQueryKeys);
  if (!queryCheck.ok) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "unsupported_query_param",
      cacheKeyUrl: null,
    };
  }

  const cacheKeyUrl = buildRevisionedCacheKey({
    host: scope.host,
    tenantId: scope.tenantId,
    cacheVersion: scope.cacheVersion,
    pathname: url.pathname,
    searchParams: url.searchParams,
    themeVersion: scope.themeVersion,
    allowedQueryKeys: scope.allowedQueryKeys,
  });

  if (!cacheKeyUrl) {
    return {
      cacheable: false,
      isPreview: false,
      reason: "invalid_scope",
      cacheKeyUrl: null,
    };
  }

  return {
    cacheable: true,
    isPreview: false,
    cacheKeyUrl,
  };
}

/**
 * Checks whether a rendered response is eligible to be stored in the public edge cache.
 */
export function isCacheablePublicResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  if (getSetCookieHeaders(response.headers).length > 0) return false;
  if (response.headers.has(PREVIEW_HEADER_NAME)) return false;
  const cc = (response.headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private") || cc.includes("no-cache")) {
    return false;
  }
  return true;
}

function mergeVaryHeader(existing: string | null, requiredTokens: readonly string[]): string {
  const seen = new Map<string, string>();
  if (existing) {
    for (const token of existing.split(",")) {
      const trimmed = token.trim();
      if (trimmed) {
        seen.set(trimmed.toLowerCase(), trimmed);
      }
    }
  }
  for (const token of requiredTokens) {
    if (!seen.has(token.toLowerCase())) {
      seen.set(token.toLowerCase(), token);
    }
  }
  return Array.from(seen.values()).join(", ");
}

/**
 * Enforces mandatory uncacheable preview headers (PLAN §14):
 * `Cache-Control: private, no-store, max-age=0` and `X-Robots-Tag: noindex, nofollow`.
 */
export function applyPreviewResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", PREVIEW_CACHE_CONTROL);
  headers.set("X-Robots-Tag", PREVIEW_ROBOTS_TAG);
  headers.set(PREVIEW_HEADER_NAME, "1");
  headers.set(CACHE_STATUS_HEADER_NAME, "BYPASS");
  headers.set("Vary", mergeVaryHeader(headers.get("Vary"), ["Cookie", "Authorization", "Accept-Encoding"]));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function clampEdgeCacheTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_EDGE_CACHE_TTL_SECONDS;
  }
  return Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_EDGE_CACHE_TTL_SECONDS);
}

/**
 * Applies bounded public `Cache-Control`, `Vary`, `X-PunyaSitus-Cache-Version`, and
 * `X-PunyaSitus-Cache` headers to a published tenant response.
 */
export function applyPublicCacheResponseHeaders(
  response: Response,
  options: {
    readonly cacheVersion: number;
    readonly ttlSeconds?: number;
    readonly cacheStatus: EdgeCacheStatus;
    readonly isHead?: boolean;
  },
): Response {
  const headers = new Headers(response.headers);
  const ttl = clampEdgeCacheTtl(options.ttlSeconds);
  headers.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
  headers.set("Vary", mergeVaryHeader(headers.get("Vary"), ["Accept-Encoding"]));
  headers.set(CACHE_VERSION_HEADER_NAME, String(options.cacheVersion));
  headers.set(CACHE_STATUS_HEADER_NAME, options.cacheStatus);

  return new Response(options.isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getDefaultEdgeCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { readonly default?: Cache }).default;
}

/**
 * Serves a tenant response through `caches.default` (or an injectable `Cache`) using
 * tenant-isolated, revisioned synthetic cache keys (`v=<cacheVersion>`).
 *
 * - Preview requests strictly bypass cache (zero `cache.match` / `cache.put` calls)
 *   and always emit `Cache-Control: private, no-store, max-age=0` + `X-Robots-Tag: noindex, nofollow`.
 * - Authenticated, cookie-carrying, non-GET/HEAD, and unknown-query requests bypass cache.
 * - Non-200 / `no-store` / `Set-Cookie` responses are never stored in cache.
 */
export async function serveWithRevisionedEdgeCache(
  params: ServeWithRevisionedCacheParams,
): Promise<ServeWithRevisionedCacheResult> {
  const evalResult = evaluateCacheBypass(params.request, {
    tenantId: params.tenantId,
    host: params.host,
    cacheVersion: params.cacheVersion,
    themeVersion: params.themeVersion,
    isPreview: params.isPreview,
    allowedQueryKeys: params.allowedQueryKeys,
  });

  if (evalResult.isPreview) {
    const rendered = await params.render();
    return {
      response: applyPreviewResponseHeaders(rendered),
      cacheStatus: "BYPASS",
      cacheKey: null,
      bypassReason: "preview_request",
    };
  }

  const cache = params.cache ?? getDefaultEdgeCache();
  if (!evalResult.cacheable || !cache) {
    const rendered = await params.render();
    if (rendered.headers.has(PREVIEW_HEADER_NAME)) {
      return {
        response: applyPreviewResponseHeaders(rendered),
        cacheStatus: "BYPASS",
        cacheKey: null,
        bypassReason: "preview_request",
      };
    }
    const headers = new Headers(rendered.headers);
    headers.set(CACHE_STATUS_HEADER_NAME, "BYPASS");
    headers.set(CACHE_VERSION_HEADER_NAME, String(params.cacheVersion));
    return {
      response: new Response(rendered.body, {
        status: rendered.status,
        statusText: rendered.statusText,
        headers,
      }),
      cacheStatus: "BYPASS",
      cacheKey: null,
      bypassReason: evalResult.cacheable ? "cache_unavailable" : evalResult.reason,
    };
  }

  const isHead = params.request.method.toUpperCase() === "HEAD";
  const cacheKey = new Request(evalResult.cacheKeyUrl, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return {
      response: applyPublicCacheResponseHeaders(cached, {
        cacheVersion: params.cacheVersion,
        ttlSeconds: params.ttlSeconds,
        cacheStatus: "HIT",
        isHead,
      }),
      cacheStatus: "HIT",
      cacheKey: evalResult.cacheKeyUrl,
      bypassReason: null,
    };
  }

  const rendered = await params.render();

  if (rendered.headers.has(PREVIEW_HEADER_NAME)) {
    return {
      response: applyPreviewResponseHeaders(rendered),
      cacheStatus: "BYPASS",
      cacheKey: evalResult.cacheKeyUrl,
      bypassReason: "preview_request",
    };
  }

  if (!isCacheablePublicResponse(rendered)) {
    const headers = new Headers(rendered.headers);
    headers.set(CACHE_STATUS_HEADER_NAME, "BYPASS");
    headers.set(CACHE_VERSION_HEADER_NAME, String(params.cacheVersion));
    return {
      response: new Response(isHead ? null : rendered.body, {
        status: rendered.status,
        statusText: rendered.statusText,
        headers,
      }),
      cacheStatus: "BYPASS",
      cacheKey: evalResult.cacheKeyUrl,
      bypassReason: "response_not_cacheable",
    };
  }

  const ttl = clampEdgeCacheTtl(params.ttlSeconds);
  const toStoreHeaders = new Headers(rendered.headers);
  toStoreHeaders.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
  toStoreHeaders.set("Vary", mergeVaryHeader(toStoreHeaders.get("Vary"), ["Accept-Encoding"]));
  toStoreHeaders.set(CACHE_VERSION_HEADER_NAME, String(params.cacheVersion));

  const toStore = new Response(rendered.clone().body, {
    status: rendered.status,
    statusText: rendered.statusText,
    headers: toStoreHeaders,
  });

  const putPromise = cache.put(cacheKey, toStore);
  if (params.ctx) {
    params.ctx.waitUntil(putPromise);
  } else {
    await putPromise;
  }

  return {
    response: applyPublicCacheResponseHeaders(rendered, {
      cacheVersion: params.cacheVersion,
      ttlSeconds: ttl,
      cacheStatus: "MISS",
      isHead,
    }),
    cacheStatus: "MISS",
    cacheKey: evalResult.cacheKeyUrl,
    bypassReason: null,
  };
}
