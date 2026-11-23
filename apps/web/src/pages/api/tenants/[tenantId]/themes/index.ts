import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemesRequest,
  createThemesRequestId,
  loadTenantThemeLibraryState,
  mapThemesDomainErrorToResponse,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Theme Library listing endpoint:
 * - `GET /api/tenants/:tenantId/themes`
 *
 * Lists ONLY the 6 built-in platform themes + active operator-granted custom themes
 * for THIS tenant, along with compatibility evaluation, active indicator, saved config
 * recoverability metadata, and optimistic version (`REQ-046`, `REQ-021`, `REQ-034`; TASK-042).
 */

export async function handleTenantThemesListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: TenantThemesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantThemesRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk daftar tema.",
      requestId,
      { extraHeaders: { Allow: "GET" } },
    );
  }

  const auth = await authorizeTenantThemesRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const state = await loadTenantThemeLibraryState(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      auth.ctx.member,
      { extraRegisteredThemes: options.extraRegisteredThemes },
    );
    return themesJsonResponse(200, state);
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildThemesRuntimeEnv(): TenantThemesRuntimeEnv {
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
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantThemesListRequest(params.tenantId ?? "", request, buildThemesRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
