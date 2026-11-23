import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { getTenantCustomThemeRequestById } from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  authorizeTenantCustomThemeRequest,
  createCustomThemeRequestId,
  customThemeErrorResponse,
  customThemeJsonResponse,
  formatTenantCustomThemeRequestDto,
  mapTenantCustomThemeErrorToResponse,
  type TenantCustomThemeHandlerOptions,
  type TenantCustomThemeRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/custom-theme-requests/:requestId`
 *
 * Tenant-scoped read-only detail for a single custom theme request.
 * Cross-tenant IDs return `404 NOT_FOUND` (REQ-063, REQ-034, TASK-061).
 */

export async function handleTenantCustomThemeRequestDetail(
  tenantId: string,
  targetRequestId: string,
  request: Request,
  runtimeEnv: TenantCustomThemeRuntimeEnv,
  options: TenantCustomThemeHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createCustomThemeRequestId();

  const auth = await authorizeTenantCustomThemeRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return customThemeErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan untuk detail permintaan tema kustom. Gunakan GET.",
      auth.ctx.requestId,
      { extraHeaders: { Allow: "GET" } },
    );
  }

  try {
    const item = await getTenantCustomThemeRequestById(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      requestId: targetRequestId,
    });
    if (!item) {
      return customThemeErrorResponse(
        404,
        "NOT_FOUND",
        "Permintaan tema kustom tidak ditemukan.",
        auth.ctx.requestId,
      );
    }

    const settings = await getPlatformSettings(auth.ctx.platformDb);
    return customThemeJsonResponse(200, {
      success: true,
      request: formatTenantCustomThemeRequestDto(item, settings.salesWhatsapp || null),
      requestId: auth.ctx.requestId,
    });
  } catch (err) {
    return mapTenantCustomThemeErrorToResponse(err, auth.ctx.requestId);
  }
}

function buildRuntimeEnv(): TenantCustomThemeRuntimeEnv {
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
  handleTenantCustomThemeRequestDetail(
    params.tenantId ?? "",
    params.requestId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
