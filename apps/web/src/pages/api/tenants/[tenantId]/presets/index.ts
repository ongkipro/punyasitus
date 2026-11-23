import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadTenantPresetState } from "@punyasitus/db/presets/index";
import {
  authorizeTenantPresetsRequest,
  createPresetsRequestId,
  mapPresetsDomainErrorToResponse,
  presetsJsonResponse,
  toPresetMemberScope,
  type TenantPresetsHandlerOptions,
  type TenantPresetsRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/presets`
 *
 * Returns starter preset catalog (`company_profile` available in M1; M2 vertical presets
 * clearly marked), current tenant draft setup state, sample-claim indicators, live
 * 6-item readiness checklist, content summary, and RBAC/lifecycle permissions
 * (REQ-047, REQ-034; PLAN §11.4; TASK-043).
 */
export async function handleTenantPresetsGetRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantPresetsRuntimeEnv,
  options: TenantPresetsHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createPresetsRequestId();

  const authz = await authorizeTenantPresetsRequest(
    tenantSelector,
    request,
    runtimeEnv,
    "settings:read",
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  try {
    const state = await loadTenantPresetState(
      authz.ctx.platformDb,
      authz.ctx.tenantDb,
      toPresetMemberScope(authz.ctx.member),
    );
    return presetsJsonResponse(200, state);
  } catch (err) {
    return mapPresetsDomainErrorToResponse(err, requestId);
  }
}

export const GET: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as TenantPresetsRuntimeEnv;
  return handleTenantPresetsGetRequest(params.tenantId ?? "", request, runtimeEnv);
};
