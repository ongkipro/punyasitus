import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  assertAdminCsrfAndOrigin,
  createAuth,
  mapGoogleOAuthCallbackError,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  isHoneypotTriggered,
  isTurnstileProtectedAuthPath,
  resolveTurnstileActionForAuthPath,
  stripTurnstileAndHoneypotFields,
  verifyTurnstileGuard,
} from "@punyasitus/core/security/turnstile";
import { getActivePlatformOperator } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  normalizeMiddlewarePathname,
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../middleware/auth.ts";

/**
 * Per-request Better Auth HTTP handler (`apps/web/src/pages/api/auth/[...all].ts`).
 *
 * Security invariants (PLAN §4, §6, §17.2; TASK-025, TASK-067, TASK-090):
 * - Mounted ONLY on platform auth hosts (`app.punyasitus.com`, `console.punyasitus.com`,
 *   or local loopback in `APP_ENV === "local"`). Returns neutral `404` on tenant hosts!
 * - Instantiates `createAuth(env.PLATFORM_DB, ...)` per request (never module-cached).
 * - Enforces `assertAdminCsrfAndOrigin` on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * - Enforces honeypot (`400 HONEYPOT_TRIGGERED`) and Cloudflare Turnstile verification
 *   (`403 TURNSTILE_REQUIRED` / `403 TURNSTILE_INVALID` / `503 TURNSTILE_NOT_CONFIGURED`)
 *   BEFORE forwarding password sign-up/sign-in/reset requests to Better Auth.
 * - Converts Google OAuth policy denials on `/api/auth/callback/google` into explicit `403`
 *   responses (`CONSOLE_GOOGLE_NOT_ALLOWED`, `PLATFORM_OPERATOR_REQUIRED`,
 *   `UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED`, `GOOGLE_EMAIL_UNVERIFIED`) with ZERO session cookies.
 * - Always sets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly turnstileFetch?: typeof fetch;
  readonly enforceTurnstileWhenUnconfigured?: boolean;
}

function buildJsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function withNoStoreHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Framework-agnostic handler exported for direct `workerd` integration tests.
 */
export async function handleBetterAuthRequest(
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: AuthApiHandlerOptions = {},
): Promise<Response> {
  // 1. Strict platform host gate — tenant hosts and marketing host MUST receive neutral 404.
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed) {
    return buildJsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();

  // 2. Enforce JSON + exact admin Origin CSRF check on state-changing auth calls.
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return buildJsonResponse(csrf.status, {
        success: false,
        code: csrf.code,
        message: csrf.reason,
      });
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return buildJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan autentikasi sedang tidak tersedia.",
    });
  }

  const secret = resolveSurfaceAuthSecret(hostCtx.surface, runtimeEnv);
  if (!secret) {
    return buildJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    });
  }

  const rawPathname = new URL(request.url).pathname;
  const normalizedPathname = normalizeMiddlewarePathname(rawPathname);
  if (!normalizedPathname) {
    return buildJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Path permintaan autentikasi tidak valid.",
    });
  }
  const normalizedPathnameLower = normalizedPathname.toLowerCase();

  // 3. Enforce honeypot + Cloudflare Turnstile BEFORE invoking Better Auth on password endpoints.
  let forwardedRequest = request;
  if (method === "POST" && isTurnstileProtectedAuthPath(normalizedPathnameLower)) {
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return buildJsonResponse(400, {
        success: false,
        code: "BAD_REQUEST",
        message: "Format isi permintaan JSON tidak valid.",
      });
    }
    if (!isPlainObject(parsedBody)) {
      return buildJsonResponse(400, {
        success: false,
        code: "BAD_REQUEST",
        message: "Format isi permintaan JSON harus berupa objek.",
      });
    }

    if (isHoneypotTriggered(parsedBody)) {
      return buildJsonResponse(400, {
        success: false,
        code: "HONEYPOT_TRIGGERED",
        message: "Permintaan ditolak oleh perlindungan anti-spam.",
      });
    }

    const expectedHostname = new URL(hostCtx.expectedOrigin).hostname;
    const expectedAction = resolveTurnstileActionForAuthPath(normalizedPathnameLower) ?? undefined;
    const turnstileResult = await verifyTurnstileGuard({
      appEnv: runtimeEnv.APP_ENV,
      secretKey: runtimeEnv.TURNSTILE_SECRET_KEY,
      request,
      body: parsedBody,
      expectedAction,
      expectedHostname,
      enforceWhenUnconfigured: options.enforceTurnstileWhenUnconfigured,
      fetchFn: options.turnstileFetch,
    });
    if (!turnstileResult.ok) {
      return buildJsonResponse(
        turnstileResult.status,
        {
          success: false,
          code: turnstileResult.code,
          message: turnstileResult.reason,
        },
        { "X-PunyaSitus-Auth-Error": turnstileResult.code },
      );
    }

    const cleanedBody = stripTurnstileAndHoneypotFields(parsedBody);
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete("content-length");
    forwardedRequest = new Request(request.url, {
      method: request.method,
      headers: forwardedHeaders,
      body: JSON.stringify(cleanedBody),
    });
  }

  const googleClientId = runtimeEnv.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleClientSecret = runtimeEnv.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const googleConfig =
    googleClientId.length > 0 && googleClientSecret.length > 0
      ? { clientId: googleClientId, clientSecret: googleClientSecret }
      : null;

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: hostCtx.surface,
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
    google: googleConfig,
    consoleGoogleAllowlist: runtimeEnv.CONSOLE_GOOGLE_ALLOWLIST,
  });

  if (normalizedPathnameLower.startsWith("/api/auth/two-factor")) {
    if (runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test") {
      await applySessionTwoFactorMigration(runtimeEnv.PLATFORM_DB);
    }
    if (normalizedPathnameLower === "/api/auth/two-factor/disable") {
      let activeSession: Awaited<ReturnType<typeof auth.api.getSession>>;
      try {
        activeSession = await auth.api.getSession({ headers: request.headers });
      } catch {
        return buildJsonResponse(503, {
          success: false,
          code: "SERVICE_UNAVAILABLE",
          message: "Gagal memverifikasi status sesi operator platform.",
        });
      }
      if (activeSession?.user) {
        let operatorGrant: Awaited<ReturnType<typeof getActivePlatformOperator>>;
        try {
          operatorGrant = await getActivePlatformOperator(
            runtimeEnv.PLATFORM_DB,
            activeSession.user.id,
          );
        } catch {
          return buildJsonResponse(503, {
            success: false,
            code: "SERVICE_UNAVAILABLE",
            message: "Gagal memverifikasi status operator platform.",
          });
        }
        if (operatorGrant) {
          return buildJsonResponse(403, {
            success: false,
            code: "OPERATOR_2FA_MANDATORY",
            message:
              "Operator platform wajib mengaktifkan 2FA dan tidak dapat menonaktifkannya sendiri.",
          });
        }
      }
    }
  }

  const response = await auth.handler(forwardedRequest);

  // 4. Convert Google OAuth callback policy denials from redirect into explicit 403
  //    with ZERO session cookies.
  if (
    normalizedPathnameLower === "/api/auth/callback/google" &&
    response.status >= 300 &&
    response.status < 400
  ) {
    const location = response.headers.get("location");
    if (location) {
      try {
        const redirectUrl = new URL(location, hostCtx.expectedOrigin);
        const mapped = mapGoogleOAuthCallbackError(redirectUrl.searchParams.get("error"));
        if (mapped) {
          return buildJsonResponse(
            403,
            {
              success: false,
              code: mapped.code,
              message: mapped.message,
            },
            { "X-PunyaSitus-Auth-Error": mapped.code },
          );
        }
      } catch {
        // Leave non-URL locations untouched
      }
    }
  }

  return withNoStoreHeaders(response);
}

export const ALL: APIRoute = ({ request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly GOOGLE_CLIENT_ID?: string;
    readonly GOOGLE_CLIENT_SECRET?: string;
    readonly CONSOLE_GOOGLE_ALLOWLIST?: string;
    readonly TURNSTILE_SITE_KEY?: string;
    readonly TURNSTILE_SECRET_KEY?: string;
  };
  return handleBetterAuthRequest(request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    GOOGLE_CLIENT_ID: runtimeEnv.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: runtimeEnv.GOOGLE_CLIENT_SECRET,
    CONSOLE_GOOGLE_ALLOWLIST: runtimeEnv.CONSOLE_GOOGLE_ALLOWLIST,
    TURNSTILE_SITE_KEY: runtimeEnv.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: runtimeEnv.TURNSTILE_SECRET_KEY,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};
