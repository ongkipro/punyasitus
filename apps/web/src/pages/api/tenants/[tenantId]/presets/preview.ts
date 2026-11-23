import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  authorizeTenantPresetsRequest,
  createPresetsRequestId,
  mapPresetsDomainErrorToResponse,
  parseStrictPresetsJsonBody,
  PRESETS_PREVIEW_ALLOWED_KEYS,
  renderPresetDraftPreviewResponse,
  type TenantPresetsHandlerOptions,
  type TenantPresetsRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/tenants/:tenantId/presets/preview`
 *
 * Renders an inert, script-free, private/no-store draft preview HTML document for the
 * tenant's starter preset composition without modifying any live published output
 * (REQ-047, REQ-034, REQ-036; PLAN §11.4 & §14; TASK-043).
 */
export async function handleTenantPresetsPreviewRequest(
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

  const parsedBody = await parseStrictPresetsJsonBody(
    request,
    PRESETS_PREVIEW_ALLOWED_KEYS,
    requestId,
    { allowEmptyBody: true },
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  try {
    return await renderPresetDraftPreviewResponse(
      authz.ctx,
      parsedBody.body,
      options.nowMs,
    );
  } catch (err) {
    return mapPresetsDomainErrorToResponse(err, requestId);
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as TenantPresetsRuntimeEnv;
  return handleTenantPresetsPreviewRequest(params.tenantId ?? "", request, runtimeEnv);
};
