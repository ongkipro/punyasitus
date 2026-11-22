import {
  assertAdminCsrfAndOrigin,
  assertMcpBearerOnly,
  AuthorizationError,
  createAuth,
  hasHostSessionCookie,
  isMcpOrOAuthProtocolPath,
  resolveAuthorizedTenantMember,
  resolveExpectedAdminOrigin,
  type AuthSurface,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import { normalizeHost, PLATFORM_HOSTS, type SurfaceKind } from "@punyasitus/core";
import {
  createLocalMailSink,
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { createStatePageResponse, type TenantMiddlewareLocals } from "../core/tenant.ts";
import type { AuthLocalsSession, AuthLocalsUser } from "./locals.d.ts";

/**
 * Auth, CSRF/Origin, MCP bearer-only, and dashboard handle membership middleware (TASK-025, PLAN §4).
 *
 * Runs strictly AFTER `executeTenantMiddleware` has classified `locals.surface` and `locals.host`.
 */

const LOCAL_DEV_APP_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";
const LOCAL_DEV_CONSOLE_SECRET = "local-dev-console-punyasitus-auth-secret-fedcba9876543210";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_PROTECTED_API_PREFIXES = [
  "/api/tenants",
  "/api/account",
  "/api/auth",
  "/api/console",
] as const;

const DASHBOARD_HANDLE_RE = /^\/dashboard\/([^/]+)(?:\/|$)/;

export interface AuthRuntimeEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: CloudflareSendEmailBinding | null;
}

export interface AuthMiddlewareLocals extends TenantMiddlewareLocals {
  authUser: AuthLocalsUser | null;
  authSession: AuthLocalsSession | null;
  authorizedTenantMember: AuthorizedTenantMember | null;
}

export interface AuthMiddlewareContext {
  readonly request: Request;
  readonly locals: AuthMiddlewareLocals;
}

export interface AuthMiddlewareOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

/**
 * Determines whether a request targets a platform authentication host
 * (`app.punyasitus.com`, `console.punyasitus.com`, or local loopback in `APP_ENV === "local"`).
 */
export function resolvePlatformAuthHostContext(
  request: Request,
  env: AuthRuntimeEnv,
): {
  readonly allowed: true;
  readonly surface: AuthSurface;
  readonly baseURL: string;
  readonly expectedOrigin: string;
  readonly isLocalLoopback: boolean;
} | {
  readonly allowed: false;
} {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { allowed: false };
  }

  const isLocal = env.APP_ENV === "local";
  if (isLocal && isLoopbackHost(url.hostname)) {
    return {
      allowed: true,
      surface: "app",
      baseURL: url.origin,
      expectedOrigin: url.origin,
      isLocalLoopback: true,
    };
  }

  const normalizedHost = normalizeHost(url.hostname);
  if (!normalizedHost) return { allowed: false };

  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const appHost = `app.${platformDomain}`;
  const consoleHost = `console.${platformDomain}`;

  if (normalizedHost === appHost) {
    const origin = `https://${appHost}`;
    return {
      allowed: true,
      surface: "app",
      baseURL: origin,
      expectedOrigin: origin,
      isLocalLoopback: false,
    };
  }

  if (normalizedHost === consoleHost) {
    const origin = `https://${consoleHost}`;
    return {
      allowed: true,
      surface: "console",
      baseURL: origin,
      expectedOrigin: origin,
      isLocalLoopback: false,
    };
  }

  return { allowed: false };
}

/**
 * Resolves the surface-specific Better Auth signing secret.
 * Uses distinct local/test fallback secrets ONLY when `APP_ENV` is `"local"` or `"test"`;
 * fails closed (returns null) outside local/test if secret is missing.
 */
export function resolveSurfaceAuthSecret(
  surface: AuthSurface,
  env: AuthRuntimeEnv,
): string | null {
  const configured =
    surface === "console" ? env.CONSOLE_AUTH_SECRET?.trim() : env.AUTH_SECRET?.trim();
  if (configured && configured.length >= 32) {
    return configured;
  }
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    return surface === "console" ? LOCAL_DEV_CONSOLE_SECRET : LOCAL_DEV_APP_SECRET;
  }
  return null;
}

/**
 * Resolves the per-request `EmailPort` (uses Cloudflare Email binding in production,
 * or local mail sink in local/test environments).
 */
export function resolveAuthEmailPort(
  env: AuthRuntimeEnv,
  override?: EmailPort | null,
): EmailPort | null {
  if (override !== undefined) return override;
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    return createLocalMailSink();
  }
  return resolveEmailPort({
    cloudflareBinding: env.EMAIL ?? null,
  });
}

function jsonAuthError(status: 401 | 403 | 404 | 503, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * Extracts `{handle}` from `/dashboard/{handle}` or `/dashboard/{handle}/...`.
 */
export function extractDashboardHandle(pathname: string): string | null {
  const match = DASHBOARD_HANDLE_RE.exec(pathname);
  const raw = match?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return null;
  }
}

export async function executeAuthMiddleware(
  context: AuthMiddlewareContext,
  next: () => Promise<Response>,
  env: AuthRuntimeEnv,
  options: AuthMiddlewareOptions = {},
): Promise<Response> {
  context.locals.authUser = null;
  context.locals.authSession = null;
  context.locals.authorizedTenantMember = null;

  const surface: SurfaceKind = context.locals.surface;
  const isLocalLoopback = context.locals.isLocalLoopback;

  // Tenant and unknown surfaces never parse platform session cookies.
  if (!isLocalLoopback && surface !== "app" && surface !== "console") {
    return next();
  }

  let url: URL;
  try {
    url = new URL(context.request.url);
  } catch {
    return createStatePageResponse("not_found", { pathname: "/", surface });
  }

  const pathname = url.pathname;
  const method = context.request.method.toUpperCase();

  // 1. MCP / OAuth bearer-only boundary (PLAN §4):
  // Never accept `__Host-` session cookies on `/mcp`, `/oauth2/token`, `/oauth2/register`, `/.well-known/oauth-*`.
  const mcpCheck = assertMcpBearerOnly(context.request);
  if (!mcpCheck.ok) {
    return jsonAuthError(mcpCheck.status, mcpCheck.code, mcpCheck.reason);
  }
  if (isMcpOrOAuthProtocolPath(pathname)) {
    return next();
  }

  // 2. Admin CSRF & Origin enforcement for state-changing requests on protected API prefixes.
  const isCsrfProtectedApi = CSRF_PROTECTED_API_PREFIXES.some((prefix) =>
    matchesPrefix(pathname, prefix),
  );
  if (isCsrfProtectedApi && STATE_CHANGING_METHODS.has(method)) {
    const expectedAdminOrigin = resolveExpectedAdminOrigin(context.request, {
      surface,
      platformDomain: env.PLATFORM_DOMAIN,
      isLocalLoopback,
    });
    if (!expectedAdminOrigin) {
      return jsonAuthError(404, "NOT_FOUND", "Endpoint tidak ditemukan.");
    }
    const csrfResult = assertAdminCsrfAndOrigin(context.request, expectedAdminOrigin);
    if (!csrfResult.ok) {
      return jsonAuthError(csrfResult.status, csrfResult.code, csrfResult.reason);
    }
  }

  // 3. Populate `context.locals.authUser` & `context.locals.authSession` on `app` / `console` / local loopback
  // strictly when a `__Host-` session cookie is present (avoids unnecessary D1 lookups on anonymous requests).
  const authSurface: AuthSurface = surface === "console" ? "console" : "app";
  const cookieHeader = context.request.headers.get("cookie");
  if (env.PLATFORM_DB && hasHostSessionCookie(cookieHeader, authSurface)) {
    const secret = resolveSurfaceAuthSecret(authSurface, env);
    const expectedOrigin = resolveExpectedAdminOrigin(context.request, {
      surface,
      platformDomain: env.PLATFORM_DOMAIN,
      isLocalLoopback,
    });

    if (secret && expectedOrigin) {
      try {
        const auth = createAuth(env.PLATFORM_DB, {
          baseURL: expectedOrigin,
          secret,
          surface: authSurface,
          trustedOrigins: [expectedOrigin],
          emailPort: resolveAuthEmailPort(env, options.emailPort),
        });
        const sessionResult = await auth.api.getSession({
          headers: context.request.headers,
        });
        if (sessionResult?.user && sessionResult.session) {
          context.locals.authUser = {
            id: sessionResult.user.id,
            name: sessionResult.user.name,
            email: sessionResult.user.email,
            emailVerified: Boolean(sessionResult.user.emailVerified),
          };
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          context.locals.authSession = {
            id: rawSession.id,
            userId: rawSession.userId,
            activeOrganizationId: rawSession.activeOrganizationId ?? null,
            createdAt:
              rawSession.createdAt instanceof Date
                ? rawSession.createdAt
                : new Date(rawSession.createdAt),
            expiresAt:
              rawSession.expiresAt instanceof Date
                ? rawSession.expiresAt
                : new Date(rawSession.expiresAt),
          };
        }
      } catch {
        // Invalid or expired session cookie -> treat as unauthenticated without leaking details.
        context.locals.authUser = null;
        context.locals.authSession = null;
      }
    }
  }

  // 4. Dashboard handle membership enforcement (`/dashboard/{handle}/**`):
  // - Unauthenticated -> redirect to `/auth/login?next=...` (no handle existence leak)
  // - Authenticated non-member or unknown handle -> neutral `404` (PLAN §4, TASK-025)
  const dashboardHandle = extractDashboardHandle(pathname);
  if (dashboardHandle) {
    if (!context.locals.authUser) {
      const nextTarget = `${pathname}${url.search}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/auth/login?next=${encodeURIComponent(nextTarget)}`,
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }

    if (!env.PLATFORM_DB) {
      return createStatePageResponse("unavailable", { pathname, surface });
    }

    try {
      const member = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: context.locals.authUser.id,
        handle: dashboardHandle,
        surface: isLocalLoopback || surface === "unknown" ? "app" : surface,
        nowMs: options.nowMs,
      });
      context.locals.authorizedTenantMember = member;
    } catch (err) {
      if (err instanceof AuthorizationError && err.status === 404) {
        return createStatePageResponse("not_found", { pathname, surface });
      }
      if (err instanceof AuthorizationError && err.status === 403) {
        return new Response("Akses ditolak.", {
          status: 403,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      }
      return createStatePageResponse("unavailable", { pathname, surface });
    }
  }

  return next();
}
