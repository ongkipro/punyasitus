import { getGroupedSettingsForAdmin } from "@punyasitus/db/settings/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantSettingsRequest,
  buildSettingsRuntimeEnv,
  createRequestId,
  mapSettingsDomainErrorToResponse,
  settingsErrorResponse,
  settingsJsonResponse,
  type TenantSettingsHandlerOptions,
  type TenantSettingsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Grouped Settings overview endpoint (`TASK-040`; `REQ-044`, `REQ-034`, `REQ-036`):
 * - `GET /api/tenants/:tenantId/settings` -> reads full grouped settings admin DTO (Owner/Admin/AgencyAdmin only; Editor -> 403).
 */

export async function handleTenantSettingsIndexRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantSettingsRuntimeEnv,
  options: TenantSettingsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantSettingsRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:read",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return settingsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk daftar pengaturan situs.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const state = await getGroupedSettingsForAdmin(auth.ctx.tenantDb);
    return settingsJsonResponse(200, state);
  } catch (err) {
    return mapSettingsDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSettingsIndexRequest(params.tenantId ?? "", request, buildSettingsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
