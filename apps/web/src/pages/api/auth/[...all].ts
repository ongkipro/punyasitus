import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  assertAdminCsrfAndOrigin,
  createAuth,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
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
 * Security invariants (PLAN §4; TASK-025):
 * - Mounted ONLY on platform auth hosts (`app.punyasitus.com`, `console.punyasitus.com`,
 *   or local loopback in `APP_ENV === "local"`). Returns neutral `404` on tenant hosts!
 * - Instantiates `createAuth(env.PLATFORM_DB, ...)` per request (never module-cached).
 * - Enforces `assertAdminCsrfAndOrigin` on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * - Always sets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
}

function buildJsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
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

  // 2. Enforce JSON + exact admin Origin CSRF check on state-changing auth calls.
  if (STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
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

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: hostCtx.surface,
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
  });

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

  const response = await auth.handler(request);
  return withNoStoreHeaders(response);
}

export const ALL: APIRoute = ({ request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleBetterAuthRequest(request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};
