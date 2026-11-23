import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  resolveExpectedAdminOrigin,
} from "@punyasitus/auth";
import { UpdateTenantNotificationPreferencesSchema } from "@punyasitus/core/reports/index";
import type { APIRoute } from "astro";
import {
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";
import {
  getTenantNotificationPreferences,
  listRecentMonthlyReportDeliveries,
  setTenantNotificationPreferences,
} from "../../../../../worker/queues/reports/preferences.ts";

/**
 * Owner-Only Notification Settings API under `/dashboard/[handle]/settings/notifications/api`
 * (`REQ-110`, `PLAN.md` §20.5, `TASK-110`).
 *
 * Security invariants:
 * - Strictly `app` surface (or local loopback in local env); foreign surfaces receive `404`.
 * - Enforces `assertAdminCsrfAndOrigin` on `POST` and `PATCH`.
 * - Enforces authenticated session + session lifetime ceiling (`401`).
 * - Resolves tenant membership (`404` for foreign/non-members, `404` for `purging`/`purged`).
 * - Strictly **Owner ONLY** (`role === "owner"` AND `dbRole === "owner"` -> `403` for admin/editor/agency_staff/setup_staff).
 * - Persists `monthlyPerformanceReportEnabled` atomically in `PLATFORM_DB.platform_settings` + `platform_audit`.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const STATE_CHANGING_METHODS = new Set(["POST", "PATCH"]);

export interface NotificationSettingsApiOptions {
  readonly nowMs?: number;
}

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleNotificationSettingsApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: NotificationSettingsApiOptions = {},
): Promise<Response> {
  const handle = rawHandle.trim().toLowerCase();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!HANDLE_RE.test(handle) || !hostCtx.allowed || (!hostCtx.isLocalLoopback && hostCtx.surface !== "app")) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "PATCH") {
    return jsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  if (STATE_CHANGING_METHODS.has(method)) {
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
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pengaturan notifikasi sedang tidak tersedia.",
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
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
    });
  }

  let authorized: Awaited<ReturnType<typeof resolveAuthorizedTenantMember>>;
  try {
    authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId: sessionResult.user.id,
      handle,
      surface: "app",
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    throw err;
  }

  if (authorized.tenantStatus === "purging" || authorized.tenantStatus === "purged") {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  // Strictly Owner ONLY (denies admin, editor, agency_staff, setup_staff)
  if (authorized.role !== "owner" || authorized.dbRole !== "owner") {
    return jsonResponse(403, {
      success: false,
      code: "OWNER_ONLY",
      message: "Hanya Pemilik Situs (Owner) yang dapat mengubah preferensi laporan performa bulanan.",
    });
  }

  if (method === "GET") {
    const [preferences, recentDeliveries] = await Promise.all([
      getTenantNotificationPreferences(runtimeEnv.PLATFORM_DB, authorized.tenantId),
      listRecentMonthlyReportDeliveries(runtimeEnv.PLATFORM_DB, authorized.tenantId, 6),
    ]);
    return jsonResponse(200, {
      success: true,
      tenantId: authorized.tenantId,
      handle: authorized.handle,
      preferences,
      recentDeliveries,
    });
  }

  const rawBody = await parseJsonBody(request);
  const parsed = UpdateTenantNotificationPreferencesSchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: 'Body JSON wajib berisi `{ "monthlyPerformanceReportEnabled": true | false }`.',
    });
  }

  const updated = await setTenantNotificationPreferences(runtimeEnv.PLATFORM_DB, {
    tenantId: authorized.tenantId,
    actorUserId: sessionResult.user.id,
    monthlyPerformanceReportEnabled: parsed.data.monthlyPerformanceReportEnabled,
    requestId,
    nowMs,
  });

  return jsonResponse(200, {
    success: true,
    tenantId: authorized.tenantId,
    handle: authorized.handle,
    preferences: updated,
    message: updated.monthlyPerformanceReportEnabled
      ? "Email laporan performa bulanan diaktifkan."
      : "Email laporan performa bulanan dinonaktifkan.",
  });
}

function toRuntimeEnv(): AuthRuntimeEnv {
  return env as unknown as AuthRuntimeEnv;
}

export const GET: APIRoute = async ({ params, request }) =>
  handleNotificationSettingsApiRequest(params.handle ?? "", request, toRuntimeEnv());

export const POST: APIRoute = async ({ params, request }) =>
  handleNotificationSettingsApiRequest(params.handle ?? "", request, toRuntimeEnv());

export const PATCH: APIRoute = async ({ params, request }) =>
  handleNotificationSettingsApiRequest(params.handle ?? "", request, toRuntimeEnv());
