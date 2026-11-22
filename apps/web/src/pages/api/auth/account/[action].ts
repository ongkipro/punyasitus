import { env } from "cloudflare:workers";
import {
  AccountOperationError,
  assertAdminCsrfAndOrigin,
  changeAccountEmail,
  changeAccountPassword,
  createAuth,
  listAccountSessions,
  revokeAccountSession,
  updateAccountProfile,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";

/**
 * Own-account JSON endpoints under `/api/auth/account/{action}` (PLAN §11.2; TASK-025).
 *
 * Actions:
 * - `GET  /api/auth/account/me`              -> profile + active sessions list (no raw tokens)
 * - `POST /api/auth/account/profile`         -> update display name
 * - `POST /api/auth/account/email`           -> change email (REQUIRES reauthentication)
 * - `POST /api/auth/account/password`        -> change password (REQUIRES current password)
 * - `POST /api/auth/account/revoke-session`  -> revoke active session (REQUIRES reauthentication)
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AccountApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleAccountApiRequest(
  action: string,
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: AccountApiHandlerOptions = {},
): Promise<Response> {
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return jsonResponse(csrf.status, {
        success: false,
        code: csrf.code,
        message: csrf.reason,
      });
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan akun sedang tidak tersedia.",
    });
  }

  const secret = resolveSurfaceAuthSecret(hostCtx.surface, runtimeEnv);
  if (!secret) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    });
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: hostCtx.surface,
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort,
  });

  const sessionResult = await auth.api.getSession({ headers: request.headers });
  if (!sessionResult?.user || !sessionResult.session) {
    return jsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
    });
  }

  const user = sessionResult.user;
  const session = sessionResult.session;
  const sessionCreatedAt =
    session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt);

  try {
    if (action === "me" && method === "GET") {
      const activeSessions = await listAccountSessions(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        currentSessionId: session.id,
        nowMs: options.nowMs,
      });
      return jsonResponse(200, {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: Boolean(user.emailVerified),
        },
        sessions: activeSessions,
      });
    }

    if (action === "profile" && method === "POST") {
      const body = await parseJsonObject(request);
      if (!body || typeof body.name !== "string") {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "Nama tampilan wajib diisi.",
        });
      }
      const updated = await updateAccountProfile(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        name: body.name,
      });
      return jsonResponse(200, { success: true, user: updated });
    }

    if (action === "email" && method === "POST") {
      const body = await parseJsonObject(request);
      if (!body || typeof body.newEmail !== "string") {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "Alamat email baru wajib diisi.",
        });
      }
      const updated = await changeAccountEmail(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        newEmail: body.newEmail,
        currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        sessionCreatedAt,
        nowMs: options.nowMs,
        emailPort,
        baseURL: hostCtx.baseURL,
      });
      return jsonResponse(200, { success: true, user: updated });
    }

    if (action === "password" && method === "POST") {
      const body = await parseJsonObject(request);
      if (!body || typeof body.newPassword !== "string") {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "Kata sandi baru wajib diisi.",
        });
      }
      const result = await changeAccountPassword(runtimeEnv.PLATFORM_DB, auth, {
        userId: user.id,
        headers: request.headers,
        currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        newPassword: body.newPassword,
        revokeOtherSessions: body.revokeOtherSessions !== false,
      });
      return jsonResponse(200, { success: true, ...result });
    }

    if (action === "revoke-session" && method === "POST") {
      const body = await parseJsonObject(request);
      if (!body || typeof body.sessionId !== "string") {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "ID sesi wajib diisi.",
        });
      }
      const result = await revokeAccountSession(runtimeEnv.PLATFORM_DB, {
        userId: user.id,
        currentSessionId: session.id,
        targetSessionId: body.sessionId,
        currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : undefined,
        sessionCreatedAt,
        nowMs: options.nowMs,
      });
      return jsonResponse(200, { success: true, ...result });
    }

    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  } catch (err) {
    if (err instanceof AccountOperationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses permintaan akun.",
    });
  }
}

export const ALL: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleAccountApiRequest(params.action ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};
