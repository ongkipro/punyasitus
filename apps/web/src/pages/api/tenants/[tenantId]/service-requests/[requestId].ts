import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  getTenantCustomThemeRequestById,
  getTenantSeatUsageForServiceRequest,
} from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  authorizeTenantServiceRequest,
  createServiceRequestId,
  formatTenantSeatsDto,
  formatTenantSetupRequestDto,
  mapTenantServiceRequestErrorToResponse,
  serviceRequestErrorResponse,
  serviceRequestJsonResponse,
  type TenantServiceRequestHandlerOptions,
  type TenantServiceRequestRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/service-requests/:requestId`
 *
 * Tenant-scoped read-only detail for a single Terima Beres setup service request.
 * Cross-tenant IDs return `404 NOT_FOUND` (REQ-070, REQ-034, TASK-069).
 */

export async function handleTenantServiceRequestDetail(
  tenantId: string,
  targetRequestId: string,
  request: Request,
  runtimeEnv: TenantServiceRequestRuntimeEnv,
  options: TenantServiceRequestHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createServiceRequestId();

  const auth = await authorizeTenantServiceRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
    requiredPermission: "theme:custom_request",
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return serviceRequestErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan untuk detail permintaan Layanan Terima Beres. Gunakan GET.",
      auth.ctx.requestId,
      { extraHeaders: { Allow: "GET" } },
    );
  }

  try {
    const item = await getTenantCustomThemeRequestById(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      requestId: targetRequestId,
    });
    if (!item || item.serviceKind !== "setup") {
      return serviceRequestErrorResponse(
        404,
        "NOT_FOUND",
        "Permintaan Layanan Terima Beres tidak ditemukan.",
        auth.ctx.requestId,
      );
    }

    const [settings, seats] = await Promise.all([
      getPlatformSettings(auth.ctx.platformDb),
      getTenantSeatUsageForServiceRequest(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        nowMs: auth.ctx.nowMs,
      }),
    ]);

    return serviceRequestJsonResponse(200, {
      success: true,
      request: formatTenantSetupRequestDto(item, settings.salesWhatsapp || null),
      seats: formatTenantSeatsDto(seats),
      requestId: auth.ctx.requestId,
    });
  } catch (err) {
    return mapTenantServiceRequestErrorToResponse(err, auth.ctx.requestId);
  }
}

function buildRuntimeEnv(): TenantServiceRequestRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantServiceRequestDetail(
    params.tenantId ?? "",
    params.requestId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
