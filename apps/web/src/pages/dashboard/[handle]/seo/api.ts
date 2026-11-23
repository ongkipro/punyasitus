import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  resolveExpectedAdminOrigin,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";
import {
  ensureIndexNowKeyForVerifiedTenant,
  loadSeoVisibilitySnapshot,
  updateAiTrainingPolicyForTenant,
} from "./_data.ts";

/**
 * Authenticated SEO & AI Visibility Controls API (`/dashboard/[handle]/seo/api`, REQ-095).
 *
 * - `GET`: Returns AI crawler policy, live `/robots.txt` preview, IndexNow custom-domain
 *   status, and first-party Insights channel breakdown (including `AI Assistant`).
 * - `POST` `{ action: "update-ai-training-policy", aiTrainingPolicy: "allow" | "disallow" }`:
 *   Requires `settings:write` (owner/admin/agency_admin; denied for editors & locked tenants).
 * - `POST` `{ action: "ensure-indexnow-key" }`:
 *   Ensures cryptographic 32-hex IndexNow key for verified custom-domain paid tenants only.
 */

export interface SeoApiRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface SeoApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly tenantDb?: D1Database | null;
  readonly nowMs?: number;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

export async function handleSeoVisibilityApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: SeoApiRuntimeEnv,
  options: SeoApiHandlerOptions = {},
): Promise<Response> {
  const handle = rawHandle.trim().toLowerCase();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || (!hostCtx.isLocalLoopback && hostCtx.surface !== "app")) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
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
      message: "Layanan pengaturan SEO sedang tidak tersedia.",
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

  try {
    if (method === "GET") {
      const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
        userId: sessionResult.user.id,
        handle,
        surface: "app",
        nowMs,
      });
      const snapshot = await loadSeoVisibilitySnapshot({
        platformDb: runtimeEnv.PLATFORM_DB,
        tenantStore: runtimeEnv.TENANT_STORE,
        tenantDb: options.tenantDb,
        tenantId: authorized.tenantId,
        saasZone: runtimeEnv.SAAS_ZONE,
        nowMs,
      });
      if (!snapshot) {
        return jsonResponse(404, { success: false, code: "NOT_FOUND" });
      }
      return jsonResponse(200, {
        success: true,
        canEditPolicy:
          authorized.role === "owner" ||
          authorized.role === "admin" ||
          authorized.role === "agency_admin",
        snapshot,
      });
    }

    const body = await parseJsonObject(request);
    if (!body || typeof body.action !== "string") {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Field action wajib diisi.",
      });
    }

    const authorized = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId: sessionResult.user.id,
      handle,
      requiredPermission: "settings:write",
      surface: "app",
      nowMs,
    });

    if (body.action === "update-ai-training-policy") {
      if (body.aiTrainingPolicy !== "allow" && body.aiTrainingPolicy !== "disallow") {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: 'Kebijakan pelatihan AI harus bernilai "allow" atau "disallow".',
        });
      }

      const snapshot = await updateAiTrainingPolicyForTenant({
        platformDb: runtimeEnv.PLATFORM_DB,
        tenantStore: runtimeEnv.TENANT_STORE,
        tenantDb: options.tenantDb,
        tenantId: authorized.tenantId,
        tenantName: authorized.tenantName,
        aiTrainingPolicy: body.aiTrainingPolicy,
        saasZone: runtimeEnv.SAAS_ZONE,
        nowMs,
      });

      return jsonResponse(200, {
        success: true,
        message:
          body.aiTrainingPolicy === "disallow"
            ? "Crawler pelatihan AI diblokir. Bot pencarian & kutipan tetap diizinkan."
            : "Crawler pelatihan AI diizinkan bersama bot pencarian & kutipan.",
        snapshot,
      });
    }

    if (body.action === "ensure-indexnow-key") {
      const ensured = await ensureIndexNowKeyForVerifiedTenant({
        platformDb: runtimeEnv.PLATFORM_DB,
        tenantStore: runtimeEnv.TENANT_STORE,
        tenantDb: options.tenantDb,
        tenantId: authorized.tenantId,
        saasZone: runtimeEnv.SAAS_ZONE,
        nowMs,
      });
      if (!ensured.ok) {
        return jsonResponse(422, {
          success: false,
          code: "INDEXNOW_NOT_ELIGIBLE",
          reason: ensured.reason,
          message: ensured.message,
        });
      }
      return jsonResponse(200, {
        success: true,
        keyLocation: ensured.keyLocation,
        snapshot: ensured.snapshot,
      });
    }

    return jsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Aksi SEO tidak dikenali.",
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
      message: "Gagal memproses perubahan pengaturan SEO. Silakan coba lagi.",
    });
  }
}

function readAstroSeoRuntimeEnv(): SeoApiRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export const GET: APIRoute = async ({ params, request }) => {
  return handleSeoVisibilityApiRequest(
    params.handle ?? "",
    request,
    readAstroSeoRuntimeEnv(),
  );
};

export const POST: APIRoute = async ({ params, request }) => {
  return handleSeoVisibilityApiRequest(
    params.handle ?? "",
    request,
    readAstroSeoRuntimeEnv(),
  );
};

export const ALL: APIRoute = async () => {
  return jsonResponse(405, {
    success: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Metode HTTP tidak diizinkan.",
  });
};
