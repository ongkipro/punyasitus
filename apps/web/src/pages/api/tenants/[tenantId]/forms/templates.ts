import { listFormVerticalTemplates } from "@punyasitus/core/forms/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantFormRequest,
  buildFormsRuntimeEnv,
  formErrorResponse,
  formJsonResponse,
  type TenantFormsHandlerOptions,
  type TenantFormsRuntimeEnv,
} from "./_shared.ts";

/**
 * Vertical Custom Form Templates API (`GET /api/tenants/:tenantId/forms/templates`;
 * REQ-080, PLAN §19.2, TASK-080).
 */

export async function handleTenantFormTemplatesRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantFormsRuntimeEnv,
  options: TenantFormsHandlerOptions = {},
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return formErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP harus GET untuk daftar template formulir.",
      options.requestId ?? "req_method_not_allowed",
      undefined,
      { Allow: "GET" },
    );
  }

  const authRes = await authorizeTenantFormRequest(
    tenantSelector,
    request,
    runtimeEnv,
    "settings:read",
    options,
  );
  if (!authRes.ok) return authRes.response;

  return formJsonResponse(200, {
    templates: listFormVerticalTemplates(),
  });
}

export const GET: APIRoute = async ({ params, request }) =>
  handleTenantFormTemplatesRequest(params.tenantId ?? "", request, buildFormsRuntimeEnv());

export const ALL: APIRoute = async ({ params, request }) =>
  handleTenantFormTemplatesRequest(params.tenantId ?? "", request, buildFormsRuntimeEnv());
