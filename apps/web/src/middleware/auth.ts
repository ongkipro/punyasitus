import {
  assertAdminCsrfAndOrigin,
  assertMcpBearerOnly,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  hasHostSessionCookie,
  isMcpOrOAuthProtocolPath,
  PlatformGuardError,
  requireActivePlatformOperator,
  resolveAuthorizedTenantMember,
  resolveExpectedAdminOrigin,
  type AuthSurface,
  type AuthorizedTenantMember,
  type VerifiedPlatformOperatorContext,
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

const DASHBOARD_HANDLE_RE = /^\/dashboard\/([^/]+)(?:\/|$)/i;
const ENCODED_SLASH_OR_BACKSLASH_RE = /%(?:2f|5c|00)/i;

/**
 * Decodes and canonicalizes a URL pathname to the exact path representation Astro routes on,
 * eliminating percent-encoding (`/api/%63onsole`), double-slash (`/api//console`), case, and
 * trailing-slash bypasses across every central middleware security gate.
 *
 * Returns `null` when the pathname contains malformed percent-encoding, encoded path separators,
 * backslashes, null bytes, or dot-segment traversal.
 */
export function normalizeMiddlewarePathname(rawPathname: string): string | null {
  if (
    !rawPathname.startsWith("/") ||
    rawPathname.includes("\\") ||
    rawPathname.includes("\0") ||
    ENCODED_SLASH_OR_BACKSLASH_RE.test(rawPathname)
  ) {
    return null;
  }

  const rawSegments = rawPathname.split("/");
  const decodedSegments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded === "." ||
      decoded === ".."
    ) {
      return null;
    }
    decodedSegments.push(decoded);
  }

  return decodedSegments.length === 0 ? "/" : `/${decodedSegments.join("/")}`;
}

export interface AuthRuntimeEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly CONSOLE_GOOGLE_ALLOWLIST?: string;
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly EMAIL?: CloudflareSendEmailBinding | null;
}

export interface AuthMiddlewareLocals extends TenantMiddlewareLocals {
  authUser: AuthLocalsUser | null;
  authSession: AuthLocalsSession | null;
  authorizedTenantMember: AuthorizedTenantMember | null;
  platformOperator?: VerifiedPlatformOperatorContext | null;
  twoFactorVerifiedAtMs?: number | null;
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

function jsonAuthError(
  status: 400 | 401 | 403 | 404 | 503,
  code: string,
  message: string,
  extra?: Readonly<Record<string, unknown>>,
): Response {
  return new Response(JSON.stringify({ success: false, code, message, ...extra }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-PunyaSitus-Auth-Error": code,
    },
  });
}

function consoleGatePageErrorResponse(
  status: 401 | 403,
  code: string,
  message: string,
): Response {
  const actionLink =
    code === "TOTP_ENROLLMENT_REQUIRED"
      ? `<p><a href="/auth/two-factor?mode=enroll">Aktifkan autentikasi dua faktor (2FA)</a></p>`
      : code === "TOTP_REQUIRED"
        ? `<p><a href="/auth/two-factor?mode=verify">Verifikasi kode autentikasi dua faktor (2FA)</a></p>`
        : "";
  const safeMessage = message.replace(/[<>&"]/g, "");
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Console Operasional Dibatasi</title></head><body><main><h1>Akses Console Operasional Dibatasi</h1><p>${safeMessage}</p>${actionLink}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-PunyaSitus-Auth-Error": code,
    },
  });
}

function isConsoleTwoFactorExemptPath(pathname: string): boolean {
  return (
    matchesPrefix(pathname, "/auth/two-factor") ||
    matchesPrefix(pathname, "/auth/login") ||
    matchesPrefix(pathname, "/auth/reset-password") ||
    matchesPrefix(pathname, "/api/auth") ||
    matchesPrefix(pathname, "/api/health") ||
    matchesPrefix(pathname, "/_astro")
  );
}

/**
 * Extracts `{handle}` from a normalized `/dashboard/{handle}` or `/dashboard/{handle}/...` path.
 * Note: `normalizeMiddlewarePathname` already percent-decoded each segment once, so we MUST NOT
 * call `decodeURIComponent` a second time (which would throw on literal `%` such as `/dashboard/100%`
 * decoded from `/dashboard/100%25` and fail open to `null`).
 */
export function extractDashboardHandle(pathname: string): string | null {
  const match = DASHBOARD_HANDLE_RE.exec(pathname);
  const raw = match?.[1]?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw : null;
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
  context.locals.platformOperator = null;
  context.locals.twoFactorVerifiedAtMs = null;

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

  const normalizedPathname = normalizeMiddlewarePathname(url.pathname);
  if (!normalizedPathname) {
    return jsonAuthError(400, "BAD_REQUEST", "Path permintaan tidak valid.");
  }
  const pathname = normalizedPathname;
  const pathnameLower = normalizedPathname.toLowerCase();
  const method = context.request.method.toUpperCase();

  // 1. MCP / OAuth bearer-only boundary (PLAN §4):
  // Never accept `__Host-` session cookies on `/mcp`, `/oauth2/token`, `/oauth2/register`, `/.well-known/oauth-*`.
  const mcpCheck = assertMcpBearerOnly(
    new Request(`${url.origin}${pathnameLower}${url.search}`, {
      method: context.request.method,
      headers: context.request.headers,
    }),
  );
  if (!mcpCheck.ok) {
    return jsonAuthError(mcpCheck.status, mcpCheck.code, mcpCheck.reason);
  }
  if (isMcpOrOAuthProtocolPath(pathnameLower)) {
    return next();
  }

  // 2. Admin CSRF & Origin enforcement for state-changing requests on protected API prefixes.
  const isCsrfProtectedApi = CSRF_PROTECTED_API_PREFIXES.some((prefix) =>
    matchesPrefix(pathnameLower, prefix),
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
          const lifetimeCheck = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
            sessionId: sessionResult.session.id,
            userId: sessionResult.user.id,
            surface: authSurface,
            pathname: pathnameLower,
            nowMs: options.nowMs,
          });
          if (lifetimeCheck.valid) {
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
        }
      } catch {
        // Invalid or expired session cookie -> treat as unauthenticated without leaking details.
        context.locals.authUser = null;
        context.locals.authSession = null;
      }
    }
  }

  // 4. Central Platform Operator Mandatory 2FA Gate (DEC-021, REQ-068, TASK-067):
  // Enforced centrally on EVERY `console.punyasitus.com` page and EVERY `/api/console/**` endpoint
  // (plus local loopback `/console/**` & `/api/console/**`), independent of sign-in method.
  // - Never forces 2FA on tenant users (`/dashboard/*`, `/account`, `/api/tenants/*`).
  // - Exempts `/auth/two-factor` and `/api/auth/**` so unenrolled operators can reach enrollment.
  // - Anonymous `GET https://console.punyasitus.com/` (no session cookie) continues to pass through
  //   the bootstrap surface probe without breaking `probe-dev-servers.mjs` or `TASK-002`/`TASK-045`.
  const isConsoleApiPath = matchesPrefix(pathnameLower, "/api/console");
  const isConsolePagePath =
    (surface === "console" && !isConsoleTwoFactorExemptPath(pathnameLower)) ||
    (isLocalLoopback && matchesPrefix(pathnameLower, "/console"));

  if (isConsoleApiPath || isConsolePagePath) {
    const hasAuthenticatedSession = Boolean(
      context.locals.authUser && context.locals.authSession,
    );

    if (isConsoleApiPath && !hasAuthenticatedSession) {
      return jsonAuthError(
        401,
        "UNAUTHENTICATED",
        "Sesi operator platform yang terautentikasi wajib digunakan.",
      );
    }

    if (isConsolePagePath && !hasAuthenticatedSession && pathname !== "/") {
      return consoleGatePageErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Masuk sebagai operator platform untuk mengakses Console Operasional.",
      );
    }

    if (hasAuthenticatedSession) {
      if (!env.PLATFORM_DB) {
        if (isConsoleApiPath) {
          return jsonAuthError(
            503,
            "SERVICE_UNAVAILABLE",
            "Layanan otorisasi platform sedang tidak tersedia.",
          );
        }
        return createStatePageResponse("unavailable", { pathname, surface });
      }

      try {
        const actor = await requireActivePlatformOperator(env.PLATFORM_DB, {
          session: context.locals.authSession,
          user: context.locals.authUser,
          requireTwoFactor: true,
          action: isConsoleApiPath ? "console.api.access" : "console.page.access",
          nowMs: options.nowMs,
        });
        context.locals.platformOperator = actor;
        context.locals.twoFactorVerifiedAtMs = actor.twoFactorVerifiedAtMs;
      } catch (err) {
        if (err instanceof PlatformGuardError) {
          const extra =
            err.code === "TOTP_ENROLLMENT_REQUIRED"
              ? { enrollmentPath: "/auth/two-factor?mode=enroll" }
              : err.code === "TOTP_REQUIRED"
                ? { verifyPath: "/auth/two-factor?mode=verify" }
                : undefined;

          const accept = (context.request.headers.get("accept") ?? "").toLowerCase();
          const wantsJson =
            isConsoleApiPath ||
            (accept.includes("application/json") && !accept.includes("text/html"));

          if (wantsJson) {
            return jsonAuthError(err.status, err.code, err.message, extra);
          }
          return consoleGatePageErrorResponse(err.status, err.code, err.message);
        }
        if (isConsoleApiPath) {
          return jsonAuthError(
            503,
            "SERVICE_UNAVAILABLE",
            "Gagal memverifikasi status otorisasi operator platform.",
          );
        }
        return createStatePageResponse("unavailable", { pathname, surface });
      }
    }
  }

  // 5. Dashboard handle membership enforcement (`/dashboard/{handle}/**`):
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
