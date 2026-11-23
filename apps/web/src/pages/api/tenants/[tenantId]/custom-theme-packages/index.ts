import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantCustomThemeRequest,
  createCustomThemeRequestId,
  customThemeErrorResponse,
  customThemeJsonResponse,
  loadTenantCustomThemeServiceState,
  mapTenantCustomThemeErrorToResponse,
  type TenantCustomThemeHandlerOptions,
  type TenantCustomThemeRuntimeEnv,
} from "../custom-theme-requests/_shared.ts";

/**
 * `GET /api/tenants/:tenantId/custom-theme-packages`
 *
 * Returns active superadmin-managed custom theme packages in `sort_order`,
 * default + granted custom theme summaries, daily quota, and sales WhatsApp CTA
 * for authorized owner/admin members of non-locked tenants (REQ-063, TASK-061).
 */

export async function handleTenantCustomThemePackagesRequest(
  tenantId: string,
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
      "Metode HTTP tidak diizinkan untuk daftar paket tema kustom. Gunakan GET.",
      auth.ctx.requestId,
      { extraHeaders: { Allow: "GET" } },
    );
  }

  try {
    const state = await loadTenantCustomThemeServiceState(
      auth.ctx.platformDb,
      auth.ctx.member,
      auth.ctx.nowMs,
    );
    return customThemeJsonResponse(200, {
      success: true,
      packages: state.packages,
      defaultThemes: state.defaultThemes,
      grantedCustomThemes: state.grantedCustomThemes,
      dailyQuota: state.dailyQuota,
      salesWhatsappConfigured: state.salesWhatsappConfigured,
      contactWhatsappUrl: state.contactWhatsappUrl,
      supportEmail: state.supportEmail,
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
  handleTenantCustomThemePackagesRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
