import { env } from "cloudflare:workers";
import {
  AuthorizationError,
  canPerform,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
} from "@punyasitus/auth";
import { isActionAllowedForTenantStatus } from "@punyasitus/auth/permissions";
import type { EmailPort } from "@punyasitus/core/email/index";
import { getTenantInsightsSummary } from "@punyasitus/db/analytics/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { bindTenantDatabase } from "../../../../core/tenant.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";
import { HANDLE_RE, parseInsightsRangeDays } from "./_loader.ts";

/**
 * Authenticated First-Party Insights API (`GET /dashboard/[handle]/insights/api`; REQ-073, TASK-072).
 *
 * - Served ONLY on `app.punyasitus.com` (and explicit local loopback dev).
 * - Requires authenticated Better Auth session + live `PLATFORM_DB` membership
 *   (`analytics:read` or `content:read`: `owner`, `admin`, `editor`, `agency_admin`).
 * - Enforces tenant lifecycle gate (`isActionAllowedForTenantStatus(..., "analytics:read")`):
 *   `suspended` / `recovery` / `purging` return `403 SUBSCRIPTION_LOCKED`, `purged` returns `404`.
 * - Cross-tenant or unknown handle reads return neutral `404 NOT_FOUND`.
 * - Returns strictly daily per-tenant aggregates dynamically projected to `site_settings.timezone`.
 */

export interface InsightsApiRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface InsightsApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly tenantDb?: D1Database | null;
  readonly nowMs?: number;
}

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      Vary: "Cookie",
    },
  });
}

export async function handleInsightsApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: InsightsApiRuntimeEnv,
  options: InsightsApiHandlerOptions = {},
): Promise<Response> {
  const handle = rawHandle.trim().toLowerCase();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (
    !HANDLE_RE.test(handle) ||
    !hostCtx.allowed ||
    (!hostCtx.isLocalLoopback && hostCtx.surface !== "app")
  ) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (method !== "GET") {
    return jsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan wawasan pengunjung sementara tidak tersedia.",
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
  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: "app",
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

  const url = new URL(request.url);
  const lifetimeCheck = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "app",
    pathname: url.pathname,
    nowMs,
  });
  if (!lifetimeCheck.valid) {
    return jsonResponse(401, {
      success: false,
      code: "SESSION_EXPIRED",
      message: "Sesi Anda telah kedaluwarsa. Silakan masuk kembali.",
    });
  }

  try {
    const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId: sessionResult.user.id,
      handle,
      surface: "app",
      nowMs,
    });

    const lifecycleGate = isActionAllowedForTenantStatus(
      authorized.tenantStatus,
      "analytics:read",
    );
    if (!lifecycleGate.allowed) {
      return jsonResponse(lifecycleGate.status, {
        success: false,
        code: lifecycleGate.code,
        message:
          lifecycleGate.status === 404
            ? "Situs tidak ditemukan."
            : "Layanan situs sedang ditangguhkan sehingga wawasan pengunjung tidak dapat diakses.",
      });
    }

    // REQ-073: owner, admin, editor, and agency_admin can view first-party insights; other tenants get 404.
    const canReadInsights =
      canPerform(authorized.role, "analytics:read") ||
      canPerform(authorized.role, "content:read");
    if (!canReadInsights) {
      return jsonResponse(403, {
        success: false,
        code: "FORBIDDEN",
        message: "Peran Anda tidak memiliki izin untuk melihat wawasan pengunjung.",
      });
    }

    const activeTenantDb =
      options.tenantDb ??
      (runtimeEnv.TENANT_STORE
        ? bindTenantDatabase(runtimeEnv.TENANT_STORE, authorized.tenantId)
        : null);

    if (!activeTenantDb) {
      return jsonResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Penyimpanan data tenant sementara tidak tersedia.",
      });
    }

    const days = parseInsightsRangeDays(url.searchParams.get("range"));
    const insights = await getTenantInsightsSummary(activeTenantDb, {
      days,
      nowMs,
      popularItemsLimit: 15,
    });

    return jsonResponse(200, {
      success: true,
      role: authorized.role,
      insights,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return jsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Wawasan pengunjung sementara tidak dapat dimuat.",
    });
  }
}

export const GET: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as InsightsApiRuntimeEnv;
  return handleInsightsApiRequest(params.handle ?? "", request, runtimeEnv);
};

export const ALL: APIRoute = async () =>
  jsonResponse(405, {
    success: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Metode HTTP tidak diizinkan.",
  });
