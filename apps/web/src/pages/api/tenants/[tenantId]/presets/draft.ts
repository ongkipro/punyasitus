import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { updateStarterPresetDraftAtomically } from "@punyasitus/db/presets/index";
import {
  authorizeTenantPresetsRequest,
  createPresetsRequestId,
  mapPresetsDomainErrorToResponse,
  parseStrictPresetsJsonBody,
  PRESETS_DRAFT_ALLOWED_KEYS,
  presetsJsonResponse,
  toPresetMemberScope,
  type TenantPresetsHandlerOptions,
  type TenantPresetsRuntimeEnv,
} from "./_shared.ts";

/**
 * `PATCH /api/tenants/:tenantId/presets/draft`
 *
 * Updates the starter preset's draft sections, keyboard ordering, and publish selection
 * with strict closed-registry validation and optimistic concurrency (`409 STALE_VERSION`).
 * Never alters live published content (REQ-047, REQ-019, REQ-034, REQ-036; TASK-043).
 */
export async function handleTenantPresetsDraftRequest(
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
    PRESETS_DRAFT_ALLOWED_KEYS,
    requestId,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  try {
    const state = await updateStarterPresetDraftAtomically(
      authz.ctx.platformDb,
      authz.ctx.tenantDb,
      toPresetMemberScope(authz.ctx.member),
      parsedBody.body,
      { nowMs: options.nowMs },
    );
    return presetsJsonResponse(200, state);
  } catch (err) {
    return mapPresetsDomainErrorToResponse(err, requestId);
  }
}

export const PATCH: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as TenantPresetsRuntimeEnv;
  return handleTenantPresetsDraftRequest(params.tenantId ?? "", request, runtimeEnv);
};
