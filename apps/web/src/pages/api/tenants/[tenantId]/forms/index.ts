import { listFormVerticalTemplates } from "@punyasitus/core/forms/index";
import { createTenantForm, listTenantForms } from "@punyasitus/db/forms/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantFormRequest,
  buildFormsRuntimeEnv,
  formErrorResponse,
  formJsonResponse,
  mapFormDomainErrorToResponse,
  parseStrictFormJsonBody,
  type TenantFormsHandlerOptions,
  type TenantFormsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant Custom Forms Collection API (`GET / POST /api/tenants/:tenantId/forms`;
 * REQ-080, PLAN §19.2, TASK-080).
 */

export async function handleTenantFormsCollectionRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantFormsRuntimeEnv,
  options: TenantFormsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === "GET") {
    const authRes = await authorizeTenantFormRequest(
      tenantSelector,
      request,
      runtimeEnv,
      "settings:read",
      options,
    );
    if (!authRes.ok) return authRes.response;

    try {
      const result = await listTenantForms(authRes.ctx.tenantDb);
      return formJsonResponse(200, {
        items: result.items,
        count: result.count,
        maxForms: result.maxForms,
        compliance: result.compliance,
        templates: listFormVerticalTemplates(),
      });
    } catch (err) {
      return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authRes = await authorizeTenantFormRequest(
      tenantSelector,
      request,
      runtimeEnv,
      "settings:write",
      options,
    );
    if (!authRes.ok) return authRes.response;

    const parsedBody = await parseStrictFormJsonBody(request, authRes.ctx.requestId);
    if (!parsedBody.ok) return parsedBody.response;

    try {
      const created = await createTenantForm(authRes.ctx.tenantDb, {
        payload: parsedBody.body,
        actorUserId: authRes.ctx.member.userId,
        actorRole: authRes.ctx.member.role,
        nowMs: options.nowMs,
      });
      return formJsonResponse(201, { form: created });
    } catch (err) {
      return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
    }
  }

  return formErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk endpoint formulir.",
    options.requestId ?? "req_method_not_allowed",
    undefined,
    { Allow: "GET, POST" },
  );
}

export const GET: APIRoute = async ({ params, request }) =>
  handleTenantFormsCollectionRequest(params.tenantId ?? "", request, buildFormsRuntimeEnv());

export const POST: APIRoute = async ({ params, request }) =>
  handleTenantFormsCollectionRequest(params.tenantId ?? "", request, buildFormsRuntimeEnv());

export const ALL: APIRoute = async ({ params, request }) =>
  handleTenantFormsCollectionRequest(params.tenantId ?? "", request, buildFormsRuntimeEnv());
