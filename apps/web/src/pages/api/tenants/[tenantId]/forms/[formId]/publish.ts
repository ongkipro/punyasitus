import { publishTenantForm } from "@punyasitus/db/forms/index";
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
} from "../_shared.ts";

/**
 * Tenant Custom Form Publish / Unpublish API (`POST /api/tenants/:tenantId/forms/:formId/publish`;
 * REQ-080, PLAN §19.2, TASK-080).
 *
 * Enforces:
 * - `settings:publish` RBAC + active/trial/grace lifecycle gate.
 * - Non-empty `business_profile.privacy_contact` before publishing (`422 PRIVACY_CONTACT_REQUIRED`).
 * - Atomic optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`).
 */

const ALLOWED_PUBLISH_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "action"]);

function parsePublishBody(body: Readonly<Record<string, unknown>>):
  | { readonly ok: true; readonly expectedVersion: number; readonly action: "publish" | "unpublish" }
  | {
      readonly ok: false;
      readonly fields: readonly { readonly field: string; readonly code: string; readonly message: string }[];
    } {
  const fields: { field: string; code: string; message: string }[] = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_PUBLISH_KEYS.has(key)) {
      fields.push({
        field: key,
        code: "UNRECOGNIZED_KEY",
        message: `Field "${key}" tidak diizinkan.`,
      });
    }
  }

  const expectedVersion = body.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    fields.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion harus berupa bilangan bulat positif.",
    });
  }

  const rawAction = body.action;
  let action: "publish" | "unpublish" = "publish";
  if (rawAction !== undefined) {
    if (rawAction === "publish" || rawAction === "unpublish") {
      action = rawAction;
    } else {
      fields.push({
        field: "action",
        code: "INVALID_ACTION",
        message: 'action harus "publish" atau "unpublish".',
      });
    }
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return { ok: true, expectedVersion: expectedVersion as number, action };
}

export async function handleTenantFormPublishRequest(
  tenantSelector: string,
  rawFormId: string,
  request: Request,
  runtimeEnv: TenantFormsRuntimeEnv,
  options: TenantFormsHandlerOptions = {},
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return formErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP harus POST untuk menerbitkan formulir.",
      options.requestId ?? "req_method_not_allowed",
      undefined,
      { Allow: "POST" },
    );
  }

  const authRes = await authorizeTenantFormRequest(
    tenantSelector,
    request,
    runtimeEnv,
    "settings:publish",
    options,
  );
  if (!authRes.ok) return authRes.response;

  const idRes = parseFormIdParam(rawFormId, authRes.ctx.requestId);
  if (!idRes.ok) return idRes.response;

  const parsedBody = await parseStrictFormJsonBody(request, authRes.ctx.requestId);
  if (!parsedBody.ok) return parsedBody.response;

  const checked = parsePublishBody(parsedBody.body);
  if (!checked.ok) {
    return formErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Payload penerbitan formulir tidak valid.",
      authRes.ctx.requestId,
      checked.fields,
    );
  }

  try {
    const result = await publishTenantForm(authRes.ctx.tenantDb, {
      formId: idRes.formId,
      expectedVersion: checked.expectedVersion,
      action: checked.action,
      actorUserId: authRes.ctx.member.userId,
      actorRole: authRes.ctx.member.role,
      nowMs: options.nowMs,
    });
    return formJsonResponse(200, result);
  } catch (err) {
    return mapFormDomainErrorToResponse(err, authRes.ctx.requestId);
  }
}

export const POST: APIRoute = async ({ params, request }) =>
  handleTenantFormPublishRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );

export const ALL: APIRoute = async ({ params, request }) =>
  handleTenantFormPublishRequest(
    params.tenantId ?? "",
    params.formId ?? "",
    request,
    buildFormsRuntimeEnv(),
  );
