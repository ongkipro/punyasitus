import {
  isDcvPassThroughPath,
  normalizeHost,
  PLATFORM_HOSTS,
  RESERVED_HANDLES,
  type SurfaceKind,
} from "@punyasitus/core";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  resolveTenantByHost,
  type ResolvedTenantRecord,
  type TenantHostKind,
} from "@punyasitus/db/routing/index";

/**
 * Neutral state-page copy and codes (PLAN §3.3).
 * Zero tenant data, zero platform links, restrictive CSP (`default-src 'none'`).
 */
export const STATE_PAGE_MESSAGES = {
  notFound: "Halaman tidak ditemukan",
  suspended: "Situs dalam perbaikan",
  suspendedBody: "Situs ini sementara tidak dapat diakses. Silakan kembali lagi nanti.",
  recovery: "Sedang dalam pemeliharaan",
  unavailable: "Layanan sedang tidak tersedia",
} as const;

export const TENANT_CONSENT_COOKIE_NAME = "__Host-ps_consent";
export const MAX_TENANT_EDGE_CACHE_TTL_SECONDS = 60;

export type StatePageKind = "not_found" | "suspended" | "recovery" | "unavailable";

export interface TenantGateEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantContext {
  readonly id: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: ResolvedTenantRecord["vertical"];
  readonly status: ResolvedTenantRecord["effectiveStatus"];
  readonly storedStatus: ResolvedTenantRecord["storedStatus"];
  readonly operatorHold: boolean;
  readonly cacheVersion: number;
  readonly schemaVersion: number;
  readonly host: string;
  readonly hostKind: TenantHostKind;
  readonly isPrimary: boolean;
  readonly primaryHost: string | null;
  readonly primaryHostKind: TenantHostKind | null;
}

export interface RequestGateOptions {
  readonly nowMs?: number;
  readonly cacheTtlMs?: number;
  readonly bypassHostCache?: boolean;
}

export type RequestGateDecision =
  | {
      readonly action: "dcv_passthrough";
      readonly pathname: string;
    }
  | {
      readonly action: "respond";
      readonly surface: SurfaceKind;
      readonly host: string;
      readonly response: Response;
    }
  | {
      readonly action: "serve";
      readonly surface: Exclude<SurfaceKind, "unknown">;
      readonly host: string;
      readonly isLocalLoopback: boolean;
      readonly tenant: TenantContext | null;
      readonly noindex: boolean;
    };

export interface EdgeRouteOptions extends RequestGateOptions {
  readonly cache?: Cache;
  readonly ctx?: Pick<ExecutionContext, "waitUntil">;
  readonly edgeCacheTtlSeconds?: number;
  readonly dcvPassThrough?: (request: Request) => Promise<Response> | Response;
  readonly render: (context: {
    readonly request: Request;
    readonly surface: Exclude<SurfaceKind, "unknown">;
    readonly host: string;
    readonly isLocalLoopback: boolean;
    readonly tenant: TenantContext | null;
    readonly tenantDb: D1Database | null;
  }) => Promise<Response> | Response;
}

export interface TenantMiddlewareLocals {
  surface: SurfaceKind;
  host: string;
  isLocalLoopback: boolean;
  tenant: TenantContext | null;
  tenantDb: D1Database | null;
}

export interface TenantMiddlewareContext {
  readonly request: Request;
  readonly locals: TenantMiddlewareLocals;
}

const MARKETING_PATHS = [
  "/bantuan",
  "/harga",
  "/pricing",
  "/fitur",
  "/features",
  "/tema",
  "/templates",
  "/demo",
  "/tentang",
  "/about",
  "/kontak",
  "/contact",
  "/kebijakan-privasi",
  "/syarat-ketentuan",
  "/legal",
  "/blog",
] as const;

const MARKETING_DISALLOWED_PREFIXES = [
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/.well-known/oauth-",
  "/api/console",
  "/api/auth",
  "/api/leads",
  "/api/abuse-report",
] as const;

const APP_ALLOWED_PREFIXES = [
  "/app",
  "/dashboard",
  "/agency",
  "/affiliate",
  "/auth",
  "/account",
  "/onboarding",
  "/billing",
  "/pay",
  "/mcp",
  "/oauth2",
  "/.well-known/oauth-",
  "/api",
  "/_astro",
] as const;

const CONSOLE_ALLOWED_PREFIXES = [
  "/console",
  "/api/console",
  "/api/health",
  "/_astro",
] as const;

const TENANT_BLOCKED_PLATFORM_PREFIXES = [
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/.well-known/oauth-",
  "/api/console",
  "/api/auth",
] as const;

const STATIC_PLATFORM_ROOT_FILES = new Set(["/", "/robots.txt", "/sitemap.xml", "/favicon.ico"]);

const DOMAIN_COOKIE_ATTR_RE = /(?:^|;\s*)domain\s*=/i;

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("-") || prefix.endsWith("/")) {
    return pathname.startsWith(prefix);
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isGetOrHead(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

function isMarketingPath(pathname: string): boolean {
  return MARKETING_PATHS.some((prefix) => matchesPathPrefix(pathname, prefix));
}

function isNoPrimaryRedirectPath(pathname: string): boolean {
  return isApiPath(pathname) || pathname.startsWith("/.well-known/");
}

function isLocalLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function renderNeutralStateHtml(message: string, body?: string): string {
  const bodyMarkup = body ? `<p>${body}</p>` : "";
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>${message}</title></head><body><main><h1>${message}</h1>${bodyMarkup}</main></body></html>`;
}

const STATE_PAGE_SPECS: Record<
  StatePageKind,
  { readonly status: 404 | 503; readonly code: string; readonly message: string; readonly body?: string }
> = {
  not_found: {
    status: 404,
    code: "NOT_FOUND",
    message: STATE_PAGE_MESSAGES.notFound,
  },
  suspended: {
    status: 503,
    code: "SITE_SUSPENDED",
    message: STATE_PAGE_MESSAGES.suspended,
    body: STATE_PAGE_MESSAGES.suspendedBody,
  },
  recovery: {
    status: 503,
    code: "SITE_RECOVERY",
    message: STATE_PAGE_MESSAGES.recovery,
  },
  unavailable: {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    message: STATE_PAGE_MESSAGES.unavailable,
  },
};

/**
 * Builds a neutral HTML or JSON (`/api/*`) state page per PLAN §3.3.
 * Every 404 HTML/JSON body is byte-for-byte identical regardless of why a host failed resolution.
 */
export function createStatePageResponse(
  kind: StatePageKind,
  options: { readonly pathname: string; readonly surface: SurfaceKind },
): Response {
  const spec = STATE_PAGE_SPECS[kind];
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-PunyaSitus-Surface": options.surface,
  });

  if (spec.status === 503) {
    headers.set("Retry-After", "60");
  }

  if (isApiPath(options.pathname)) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ success: false, code: spec.code }), {
      status: spec.status,
      headers,
    });
  }

  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(renderNeutralStateHtml(spec.message, spec.body), {
    status: spec.status,
    headers,
  });
}

function createRedirectResponse(
  location: string,
  status: 301 | 308,
  surface: SurfaceKind,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "X-PunyaSitus-Surface": surface,
    ...extraHeaders,
  });
  return new Response(null, { status, headers });
}

/**
 * Canonical synthetic Worker Cache API key for anonymous tenant GET/HEAD responses (PLAN §3).
 * Format: `https://cache.punyasitus.com/t/<tenantId>/v<cacheVersion>/<host><path>`
 */
export function buildTenantEdgeCacheKey(
  tenantId: string,
  cacheVersion: number,
  host: string,
  pathname: string,
): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `https://cache.punyasitus.com/t/${encodeURIComponent(tenantId)}/v${cacheVersion}/${host}${normalizedPath}`;
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
 * Enforces PLAN §3.2 PSL-free cookie isolation on tenant hosts:
 * drops any `Set-Cookie` header containing a `Domain=` attribute and applies
 * surface/indexing headers without mutating immutable responses in place.
 */
export function sanitizeTenantResponseHeaders(
  response: Response,
  options: {
    readonly surface: SurfaceKind;
    readonly noindex?: boolean;
  },
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-PunyaSitus-Surface", options.surface);

  if (options.noindex) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  if (options.surface === "tenant") {
    const cookies = getSetCookieHeaders(response.headers);
    if (cookies.length > 0) {
      headers.delete("set-cookie");
      for (const cookie of cookies) {
        if (!DOMAIN_COOKIE_ATTR_RE.test(cookie)) {
          headers.append("set-cookie", cookie);
        }
      }
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasPersonalizationCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader || !cookieHeader.trim()) return false;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    const name = eqIndex === -1 ? trimmed : trimmed.slice(0, eqIndex).trim();
    if (name && name !== TENANT_CONSENT_COOKIE_NAME) {
      return true;
    }
  }
  return false;
}

function isEdgeCacheableRequest(request: Request, url: URL): boolean {
  if (!isGetOrHead(request.method)) return false;
  if (isNoPrimaryRedirectPath(url.pathname)) return false;
  if (url.search.length > 0) return false;
  if (request.headers.has("authorization")) return false;
  if (hasPersonalizationCookie(request.headers.get("cookie"))) return false;
  return true;
}

function isEdgeCacheableResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  if (getSetCookieHeaders(response.headers).length > 0) return false;
  const cc = (response.headers.get("cache-control") ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) return false;
  return true;
}

function getDefaultEdgeCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { readonly default?: Cache }).default;
}

/**
 * Reads/writes `caches.default` under the tenant-scoped synthetic cache key ONLY after
 * Step 6 & Step 8 have already confirmed that the tenant is in a serving state.
 */
export async function serveWithTenantEdgeCache(params: {
  readonly request: Request;
  readonly tenant: TenantContext;
  readonly host: string;
  readonly render: () => Promise<Response> | Response;
  readonly cache?: Cache;
  readonly ctx?: Pick<ExecutionContext, "waitUntil">;
  readonly ttlSeconds?: number;
}): Promise<{ readonly response: Response; readonly cacheStatus: "HIT" | "MISS" | "BYPASS" }> {
  const url = new URL(params.request.url);
  const cache = params.cache ?? getDefaultEdgeCache();

  if (!cache || !isEdgeCacheableRequest(params.request, url)) {
    const rendered = await params.render();
    return { response: rendered, cacheStatus: "BYPASS" };
  }

  const keyUrl = buildTenantEdgeCacheKey(
    params.tenant.id,
    params.tenant.cacheVersion,
    params.host,
    url.pathname,
  );
  const cacheKey = new Request(keyUrl, { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) {
    const hitHeaders = new Headers(hit.headers);
    hitHeaders.set("X-PunyaSitus-Cache", "HIT");
    return {
      response: new Response(params.request.method.toUpperCase() === "HEAD" ? null : hit.body, {
        status: hit.status,
        statusText: hit.statusText,
        headers: hitHeaders,
      }),
      cacheStatus: "HIT",
    };
  }

  const rendered = await params.render();
  const ttlSeconds = Math.min(
    Math.max(1, Math.floor(params.ttlSeconds ?? MAX_TENANT_EDGE_CACHE_TTL_SECONDS)),
    MAX_TENANT_EDGE_CACHE_TTL_SECONDS,
  );

  if (isEdgeCacheableResponse(rendered)) {
    const toStoreHeaders = new Headers(rendered.headers);
    toStoreHeaders.set("Cache-Control", `public, max-age=${ttlSeconds}`);
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
  }

  const missHeaders = new Headers(rendered.headers);
  missHeaders.set("X-PunyaSitus-Cache", "MISS");
  return {
    response: new Response(rendered.body, {
      status: rendered.status,
      statusText: rendered.statusText,
      headers: missHeaders,
    }),
    cacheStatus: "MISS",
  };
}

/**
 * Evaluates the exact 8-step request routing gate specified in PLAN §3.3.
 * Never reads `X-Forwarded-Host` or `X-Tenant-ID`; normalizes `Host` strictly from `request.url`.
 */
export async function evaluateRequestGate(
  request: Request,
  env: TenantGateEnv,
  options: RequestGateOptions = {},
): Promise<RequestGateDecision> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      action: "respond",
      surface: "unknown",
      host: "",
      response: createStatePageResponse("not_found", { pathname: "/", surface: "unknown" }),
    };
  }

  const pathname = url.pathname;

  // Step 0 / PLAN §3.3 #1: Certificate DCV paths pass through untouched before any host/tenant work.
  // `/.well-known/cf-custom-hostname-challenge/*` is deliberately NOT passed through.
  if (isDcvPassThroughPath(pathname)) {
    return { action: "dcv_passthrough", pathname };
  }

  // Step 2 / PLAN §3.3 #2: Normalize Host strictly from `request.url` ONLY.
  // Local loopback (`127.0.0.1` / `localhost` / `[::1]`) is allowed ONLY when `APP_ENV === "local"`.
  const isLocal = env.APP_ENV === "local";
  if (isLocal && isLocalLoopbackHostname(url.hostname)) {
    return {
      action: "serve",
      surface: "marketing",
      host: url.hostname.toLowerCase(),
      isLocalLoopback: true,
      tenant: null,
      noindex: pathname.startsWith("/_dev/") || isApiPath(pathname),
    };
  }

  const normalizedHost = normalizeHost(url.hostname);
  if (!normalizedHost) {
    return {
      action: "respond",
      surface: "unknown",
      host: "",
      response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
    };
  }

  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const platformWww = `www.${platformDomain}`;
  const appHost = `app.${platformDomain}`;
  const consoleHost = `console.${platformDomain}`;
  const saasZone = normalizeHost(env.SAAS_ZONE) ?? PLATFORM_HOSTS.saasZone;
  const saasZoneWww = `www.${saasZone}`;

  // Step 3 / PLAN §3.3 #3: Exact platform allowlist & strict surface route isolation.
  if (normalizedHost === platformWww) {
    return {
      action: "respond",
      surface: "marketing",
      host: normalizedHost,
      response: createRedirectResponse(
        `https://${platformDomain}${pathname}${url.search}`,
        308,
        "marketing",
      ),
    };
  }

  if (normalizedHost === platformDomain) {
    const blockedOnMarketing = MARKETING_DISALLOWED_PREFIXES.some((prefix) =>
      matchesPathPrefix(pathname, prefix),
    );
    if (blockedOnMarketing) {
      return {
        action: "respond",
        surface: "marketing",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "marketing" }),
      };
    }
    return {
      action: "serve",
      surface: "marketing",
      host: normalizedHost,
      isLocalLoopback: false,
      tenant: null,
      noindex: isApiPath(pathname),
    };
  }

  if (normalizedHost === appHost) {
    if (isMarketingPath(pathname)) {
      if (isGetOrHead(request.method)) {
        return {
          action: "respond",
          surface: "app",
          host: normalizedHost,
          response: createRedirectResponse(
            `https://${platformDomain}${pathname}${url.search}`,
            301,
            "app",
            { "X-Robots-Tag": "noindex, nofollow" },
          ),
        };
      }
      return {
        action: "respond",
        surface: "app",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "app" }),
      };
    }

    const blockedConsoleOnApp =
      matchesPathPrefix(pathname, "/console") || matchesPathPrefix(pathname, "/api/console");
    const allowedOnApp =
      STATIC_PLATFORM_ROOT_FILES.has(pathname) ||
      APP_ALLOWED_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));

    if (blockedConsoleOnApp || !allowedOnApp) {
      return {
        action: "respond",
        surface: "app",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "app" }),
      };
    }

    return {
      action: "serve",
      surface: "app",
      host: normalizedHost,
      isLocalLoopback: false,
      tenant: null,
      noindex: true,
    };
  }

  if (normalizedHost === consoleHost) {
    if (isMarketingPath(pathname)) {
      if (isGetOrHead(request.method)) {
        return {
          action: "respond",
          surface: "console",
          host: normalizedHost,
          response: createRedirectResponse(
            `https://${platformDomain}${pathname}${url.search}`,
            301,
            "console",
            { "X-Robots-Tag": "noindex, nofollow" },
          ),
        };
      }
      return {
        action: "respond",
        surface: "console",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "console" }),
      };
    }

    const allowedOnConsole =
      STATIC_PLATFORM_ROOT_FILES.has(pathname) ||
      CONSOLE_ALLOWED_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));

    if (!allowedOnConsole) {
      return {
        action: "respond",
        surface: "console",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "console" }),
      };
    }

    return {
      action: "serve",
      surface: "console",
      host: normalizedHost,
      isLocalLoopback: false,
      tenant: null,
      noindex: true,
    };
  }

  // Step 4 / PLAN §3.3 #4: SaaS zone apex and `www` redirect 301 to platform apex; reserved labels 404.
  if (normalizedHost === saasZone || normalizedHost === saasZoneWww) {
    return {
      action: "respond",
      surface: "marketing",
      host: normalizedHost,
      response: createRedirectResponse(`https://${platformDomain}/`, 301, "marketing"),
    };
  }

  const saasSuffix = `.${saasZone}`;
  if (normalizedHost.endsWith(saasSuffix)) {
    const label = normalizedHost.slice(0, -saasSuffix.length);
    if (!label || label.includes(".") || RESERVED_HANDLES.has(label)) {
      return {
        action: "respond",
        surface: "unknown",
        host: normalizedHost,
        response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
      };
    }
  }

  // Step 5 / PLAN §3.3 #5: Platform-only prefixes on tenant hosts return neutral 404.
  if (TENANT_BLOCKED_PLATFORM_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix))) {
    return {
      action: "respond",
      surface: "unknown",
      host: normalizedHost,
      response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
    };
  }

  // Step 6 / PLAN §3.3 #6: Authoritative tenant resolution from `PLATFORM_DB`.
  const resolution = await resolveTenantByHost(env.PLATFORM_DB, normalizedHost, {
    nowMs: options.nowMs,
    cacheTtlMs: options.cacheTtlMs,
    bypassCache: options.bypassHostCache,
  });

  if (resolution.kind === "db_unavailable") {
    return {
      action: "respond",
      surface: "unknown",
      host: normalizedHost,
      response: createStatePageResponse("unavailable", { pathname, surface: "unknown" }),
    };
  }

  if (resolution.kind !== "resolved") {
    return {
      action: "respond",
      surface: "unknown",
      host: normalizedHost,
      response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
    };
  }

  // Step 8a / PLAN §3.3 #6 & #8: Non-serving lifecycle gate runs BEFORE any primary redirect or cache read.
  const effectiveStatus = resolution.tenant.effectiveStatus;
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return {
      action: "respond",
      surface: "unknown",
      host: normalizedHost,
      response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
    };
  }

  if (effectiveStatus === "suspended") {
    return {
      action: "respond",
      surface: "tenant",
      host: normalizedHost,
      response: createStatePageResponse("suspended", { pathname, surface: "tenant" }),
    };
  }

  if (effectiveStatus === "recovery") {
    return {
      action: "respond",
      surface: "tenant",
      host: normalizedHost,
      response: createStatePageResponse("recovery", { pathname, surface: "tenant" }),
    };
  }

  // Step 7 / PLAN §3.3 #7: Primary-host 301 redirect for GET/HEAD when an active custom primary exists.
  // Never redirect `/api/*` or `/.well-known/*`.
  if (
    !resolution.hostRecord.isPrimary &&
    resolution.primaryHost &&
    resolution.primaryHost !== normalizedHost &&
    resolution.primaryHostKind === "custom" &&
    isGetOrHead(request.method) &&
    !isNoPrimaryRedirectPath(pathname)
  ) {
    return {
      action: "respond",
      surface: "tenant",
      host: normalizedHost,
      response: createRedirectResponse(
        `https://${resolution.primaryHost}${pathname}${url.search}`,
        301,
        "tenant",
      ),
    };
  }

  // Step 8b / PLAN §3.3 #8: Serving tenant (`trial`, `active`, `grace`, `locked`).
  const tenantContext: TenantContext = {
    id: resolution.tenant.id,
    organizationId: resolution.tenant.organizationId,
    handle: resolution.tenant.handle,
    name: resolution.tenant.name,
    vertical: resolution.tenant.vertical,
    status: effectiveStatus,
    storedStatus: resolution.tenant.storedStatus,
    operatorHold: resolution.tenant.operatorHold,
    cacheVersion: resolution.tenant.cacheVersion,
    schemaVersion: resolution.tenant.schemaVersion,
    host: resolution.hostRecord.host,
    hostKind: resolution.hostRecord.kind,
    isPrimary: resolution.hostRecord.isPrimary,
    primaryHost: resolution.primaryHost,
    primaryHostKind: resolution.primaryHostKind,
  };

  return {
    action: "serve",
    surface: "tenant",
    host: normalizedHost,
    isLocalLoopback: false,
    tenant: tenantContext,
    noindex: effectiveStatus === "trial" || isApiPath(pathname),
  };
}

/**
 * Binds a `D1Database`-compatible RPC adapter for a resolved tenant's `TenantStore` DO
 * with `locationHint: "apac-se"`. Returns `null` if the binding is unavailable.
 */
export function bindTenantDatabase(
  namespace: TenantStoreNamespaceLike | null | undefined,
  tenantId: string,
): D1Database | null {
  if (!namespace) return null;
  try {
    const stub = openTenantStoreStub(namespace, tenantId);
    return createTenantDb(stub);
  } catch {
    return null;
  }
}

/**
 * Full edge request pipeline combining the 8-step gate, tenant DO DB binding,
 * post-gate `caches.default` lookup/store, and tenant response header sanitization.
 */
export async function routeEdgeRequest(
  request: Request,
  env: TenantGateEnv,
  options: EdgeRouteOptions,
): Promise<Response> {
  const decision = await evaluateRequestGate(request, env, options);

  if (decision.action === "dcv_passthrough") {
    if (options.dcvPassThrough) {
      return options.dcvPassThrough(request);
    }
    return new Response("dcv-pass-through", {
      status: 200,
      headers: { "X-DCV-Pass-Through": "1" },
    });
  }

  if (decision.action === "respond") {
    return decision.response;
  }

  let tenantDb: D1Database | null = null;
  if (decision.surface === "tenant" && decision.tenant) {
    tenantDb = bindTenantDatabase(env.TENANT_STORE, decision.tenant.id);
    if (!tenantDb) {
      const url = new URL(request.url);
      return createStatePageResponse("unavailable", {
        pathname: url.pathname,
        surface: "tenant",
      });
    }

    const { response } = await serveWithTenantEdgeCache({
      request,
      tenant: decision.tenant,
      host: decision.host,
      cache: options.cache,
      ctx: options.ctx,
      ttlSeconds: options.edgeCacheTtlSeconds,
      render: () =>
        options.render({
          request,
          surface: decision.surface,
          host: decision.host,
          isLocalLoopback: decision.isLocalLoopback,
          tenant: decision.tenant,
          tenantDb,
        }),
    });

    return sanitizeTenantResponseHeaders(response, {
      surface: "tenant",
      noindex: decision.noindex,
    });
  }

  const response = await options.render({
    request,
    surface: decision.surface,
    host: decision.host,
    isLocalLoopback: decision.isLocalLoopback,
    tenant: null,
    tenantDb: null,
  });

  return sanitizeTenantResponseHeaders(response, {
    surface: decision.surface,
    noindex: decision.noindex,
  });
}

/**
 * Framework-agnostic Astro middleware runner used by `apps/web/src/middleware/index.ts`.
 * Binds `context.locals.{surface, host, isLocalLoopback, tenant, tenantDb}`, sets
 * `X-PunyaSitus-Surface`, enforces `X-Robots-Tag`, and strips any `Domain=` cookie on tenant hosts.
 */
export async function executeTenantMiddleware(
  context: TenantMiddlewareContext,
  next: () => Promise<Response>,
  env: TenantGateEnv,
  options: RequestGateOptions & { readonly cache?: Cache } = {},
): Promise<Response> {
  const decision = await evaluateRequestGate(context.request, env, options);

  if (decision.action === "dcv_passthrough") {
    context.locals.surface = "unknown";
    context.locals.host = "";
    context.locals.isLocalLoopback = false;
    context.locals.tenant = null;
    context.locals.tenantDb = null;
    return next();
  }

  if (decision.action === "respond") {
    context.locals.surface = decision.surface;
    context.locals.host = decision.host;
    context.locals.isLocalLoopback = false;
    context.locals.tenant = null;
    context.locals.tenantDb = null;
    return decision.response;
  }

  context.locals.surface = decision.surface;
  context.locals.host = decision.host;
  context.locals.isLocalLoopback = decision.isLocalLoopback;
  context.locals.tenant = decision.tenant;
  context.locals.tenantDb = null;

  if (decision.surface === "tenant" && decision.tenant) {
    const tenantDb = bindTenantDatabase(env.TENANT_STORE, decision.tenant.id);
    if (!tenantDb) {
      const url = new URL(context.request.url);
      return createStatePageResponse("unavailable", {
        pathname: url.pathname,
        surface: "tenant",
      });
    }
    context.locals.tenantDb = tenantDb;

    const { response } = await serveWithTenantEdgeCache({
      request: context.request,
      tenant: decision.tenant,
      host: decision.host,
      cache: options.cache,
      render: () => next(),
    });

    return sanitizeTenantResponseHeaders(response, {
      surface: "tenant",
      noindex: decision.noindex,
    });
  }

  const response = await next();
  return sanitizeTenantResponseHeaders(response, {
    surface: decision.surface,
    noindex: decision.noindex,
  });
}
