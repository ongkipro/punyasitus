import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { publishStarterPresetSectionsAtomically } from "@punyasitus/db/presets/index";
import {
  authorizeTenantPresetsRequest,
  createPresetsRequestId,
  mapPresetsDomainErrorToResponse,
  parseStrictPresetsJsonBody,
  PRESETS_PUBLISH_ALLOWED_KEYS,
  presetsJsonResponse,
  toPresetMemberScope,
  type TenantPresetsHandlerOptions,
  type TenantPresetsRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/tenants/:tenantId/presets/publish`
 *
 * Atomically publishes ONLY validated, non-sample selected sections from the starter
 * preset into the tenant's homepage snapshot, blocking sample claims and invalid
 * sections while allowing missing optional modules (REQ-047, REQ-034, REQ-036; TASK-043).
 */
export async function handleTenantPresetsPublishRequest(
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
    PRESETS_PUBLISH_ALLOWED_KEYS,
    requestId,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  try {
    const result = await publishStarterPresetSectionsAtomically(
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
  return handleTenantPresetsPublishRequest(params.tenantId ?? "", request, runtimeEnv);
};
