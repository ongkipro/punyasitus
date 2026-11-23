import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveExpectedAdminOrigin,
} from "@punyasitus/auth";
import { acceptMemberInvitation, InvitationError } from "@punyasitus/auth/invitations/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../../middleware/auth.ts";

/**
 * Dedicated invitation acceptance endpoint under
 * `POST /dashboard/[handle]/settings/members/accept/api` (TASK-026; REQ-035, REQ-034).
 *
 * Strictly handles identity-bound, expiring, single-use invitation acceptance ONLY —
 * keeping `/dashboard/[handle]/settings/members/api` 100% member-only.
 */

export interface AcceptInvitationApiOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
}

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
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

export async function handleAcceptInvitationApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: AcceptInvitationApiOptions = {},
): Promise<Response> {
  const handle = rawHandle.trim().toLowerCase();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || (!hostCtx.isLocalLoopback && hostCtx.surface !== "app")) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  if (request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  const expectedOrigin =
    resolveExpectedAdminOrigin(request, {
      surface: hostCtx.isLocalLoopback ? "app" : hostCtx.surface,
      platformDomain: runtimeEnv.PLATFORM_DOMAIN,
      isLocalLoopback: hostCtx.isLocalLoopback,
    }) ?? hostCtx.expectedOrigin;
  const csrf = assertAdminCsrfAndOrigin(request, expectedOrigin);
  if (!csrf.ok) {
    return jsonResponse(csrf.status, {
      success: false,
      code: csrf.code,
      message: csrf.reason,
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan keanggotaan sedang tidak tersedia.",
    });
  }

  const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
  if (!secret) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    });
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestId =
    request.headers.get("x-request-id")?.trim() ||
    `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: "app",
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
  });

  const sessionResult = await auth.api.getSession({ headers: request.headers });
  if (!sessionResult?.user || !sessionResult.session) {
    return jsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
    });
  }

  const lifetimeCheck = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "app",
    pathname: new URL(request.url).pathname,
    nowMs,
  });
  if (!lifetimeCheck.valid) {
    return jsonResponse(401, {
      success: false,
      code: "SESSION_EXPIRED",
      message: "Sesi Anda telah kedaluwarsa. Silakan masuk kembali.",
    });
  }

  const body = await parseJsonObject(request);
  if (!body || typeof body.token !== "string" || body.token.trim().length < 16) {
    return jsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Token undangan tidak valid.",
    });
  }

  if (body.action !== undefined && body.action !== "accept-invitation") {
    return jsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Aksi endpoint ini hanya mendukung accept-invitation.",
    });
  }

  try {
    const accepted = await acceptMemberInvitation(runtimeEnv.PLATFORM_DB, {
      token: body.token,
      acceptingUserId: sessionResult.user.id,
      expectedHandle: handle,
      requestId,
      nowMs,
    });
    return jsonResponse(200, {
      success: true,
      membership: {
        memberId: accepted.memberId,
        organizationId: accepted.organizationId,
        tenantId: accepted.tenantId,
        role: accepted.role,
        email: accepted.email,
      },
    });
  } catch (err) {
    if (err instanceof InvitationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses penerimaan undangan.",
    });
  }
}

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleAcceptInvitationApiRequest(params.handle ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};
