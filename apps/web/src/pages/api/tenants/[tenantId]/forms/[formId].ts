import {
  deleteTenantForm,
  getTenantFormById,
  updateTenantForm,
} from "@punyasitus/db/forms/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantFormRequest,
  buildFormsRuntimeEnv,
  formErrorResponse,
  formJsonResponse,
  mapFormDomainErrorToResponse,
  parseFormIdParam,
  parseStrictFormJsonBody,
  type TenantFormsHandlerOptions,
  type TenantFormsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant Custom Form Detail API (`GET / PUT / PATCH / DELETE /api/tenants/:tenantId/forms/:formId`;
 * REQ-080, PLAN §19.2, TASK-080).
 */

export async function handleTenantFormDetailRequest(
  tenantSelector: string,
  rawFormId: string,
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

    const idRes = parseFormIdParam(rawFormId, authRes.ctx.requestId);
    if (!idRes.ok) return idRes.response;

    try {
      const detail = await getTenantFormById(authRes.ctx.tenantDb, idRes.formId);
      return formJsonResponse(200, detail);
    } catch (err) {
      return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
    }
  }

  if (method === "PUT" || method === "PATCH") {
    const authRes = await authorizeTenantFormRequest(
      tenantSelector,
      request,
      runtimeEnv,
      "settings:write",
      options,
    );
    if (!authRes.ok) return authRes.response;

    const idRes = parseFormIdParam(rawFormId, authRes.ctx.requestId);
    if (!idRes.ok) return idRes.response;

    const parsedBody = await parseStrictFormJsonBody(request, authRes.ctx.requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const { expectedVersion, ...rest } = parsedBody.body;
    const versionNum = typeof expectedVersion === "number" ? expectedVersion : Number.NaN;

    try {
      const updated = await updateTenantForm(authRes.ctx.tenantDb, {
        formId: idRes.formId,
        expectedVersion: versionNum,
        payload: rest,
        actorUserId: authRes.ctx.member.userId,
        actorRole: authRes.ctx.member.role,
        nowMs: options.nowMs,
      });
      return formJsonResponse(200, { form: updated });
    } catch (err) {
      return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
    }
  }

  if (method === "DELETE") {
    const authRes = await authorizeTenantFormRequest(
      tenantSelector,
      request,
      runtimeEnv,
      "settings:write",
      options,
    );
    if (!authRes.ok) return authRes.response;

    const idRes = parseFormIdParam(rawFormId, authRes.ctx.requestId);
    if (!idRes.ok) return idRes.response;

    const url = new URL(request.url);
    const queryVersion = url.searchParams.get("expectedVersion");
    let expectedVersion = queryVersion && /^\d+$/.test(queryVersion) ? Number(queryVersion) : Number.NaN;

    if (!Number.isInteger(expectedVersion)) {
      const parsedBody = await parseStrictFormJsonBody(request, authRes.ctx.requestId);
      if (!parsedBody.ok) return parsedBody.response;
      expectedVersion =
        typeof parsedBody.body.expectedVersion === "number"
          ? parsedBody.body.expectedVersion
          : Number.NaN;
    }

    try {
      const deleted = await deleteTenantForm(authRes.ctx.tenantDb, {
        formId: idRes.formId,
        expectedVersion,
        actorUserId: authRes.ctx.member.userId,
        actorRole: authRes.ctx.member.role,
        nowMs: options.nowMs,
      });
      return formJsonResponse(200, deleted);
    } catch (err) {
      return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
    }
  }

  return formErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk detail formulir.",
    options.requestId ?? "req_method_not_allowed",
    undefined,
    { Allow: "GET, PUT, PATCH, DELETE" },
  );
}

export const GET: APIRoute = async ({ params, request }) =>
  handleTenantFormDetailRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );

export const PUT: APIRoute = async ({ params, request }) =>
  handleTenantFormDetailRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );

export const PATCH: APIRoute = async ({ params, request }) =>
  handleTenantFormDetailRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );

export const DELETE: APIRoute = async ({ params, request }) =>
  handleTenantFormDetailRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );

export const ALL: APIRoute = async ({ params, request }) =>
  handleTenantFormDetailRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );
