import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { applyStarterPresetAtomically } from "@punyasitus/db/presets/index";
import {
  authorizeTenantPresetsRequest,
  createPresetsRequestId,
  mapPresetsDomainErrorToResponse,
  parseStrictPresetsJsonBody,
  PRESETS_APPLY_ALLOWED_KEYS,
  presetsJsonResponse,
  toPresetMemberScope,
  type TenantPresetsHandlerOptions,
  type TenantPresetsRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/tenants/:tenantId/presets/apply`
 *
 * Idempotently applies the M1 `company_profile` starter preset as DRAFT-ONLY
 * composition & checklist without ever deleting or unpublishing existing tenant content
 * (REQ-047, REQ-034, REQ-036; PLAN §11.4; TASK-043).
 */
export async function handleTenantPresetsApplyRequest(
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
    "settings:write",
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const parsedBody = await parseStrictPresetsJsonBody(
    request,
    PRESETS_APPLY_ALLOWED_KEYS,
    requestId,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  try {
    const result = await applyStarterPresetAtomically(
      authz.ctx.platformDb,
      authz.ctx.tenantDb,
      toPresetMemberScope(authz.ctx.member),
      parsedBody.body,
      { nowMs: options.nowMs },
    );
    return presetsJsonResponse(200, result);
  } catch (err) {
    return mapPresetsDomainErrorToResponse(err, requestId);
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as TenantPresetsRuntimeEnv;
  return handleTenantPresetsApplyRequest(params.tenantId ?? "", request, runtimeEnv);
};
