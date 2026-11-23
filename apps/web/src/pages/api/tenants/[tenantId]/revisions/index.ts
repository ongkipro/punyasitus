import {
  isRevisionResourceType,
  listContentRevisions,
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
} from "@punyasitus/db/revisions/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantRevisionRequest,
  buildRevisionsRuntimeEnv,
  createRevisionRequestId,
  mapRevisionDomainErrorToResponse,
  revisionErrorResponse,
  revisionJsonResponse,
  type TenantRevisionsHandlerOptions,
  type TenantRevisionsRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/revisions?resourceType=page|post|offering&resourceId=<id>&limit=<1..20>`
 *
 * Lists up to the latest 20 revisions for a page, blog post, or catalog offering within
 * the authenticated tenant's physically isolated `TenantStore` (TASK-064; REQ-048, REQ-034).
 */

export async function handleTenantRevisionsListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantRevisionsRuntimeEnv,
  options: TenantRevisionsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRevisionRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantRevisionRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return revisionErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan GET untuk membaca daftar riwayat revisi.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantRevisionRequest(tenantId, request, runtimeEnv, "content:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const rawResourceType = (url.searchParams.get("resourceType") ?? "").trim();
  const rawResourceId = (url.searchParams.get("resourceId") ?? "").trim();
  const rawLimit = url.searchParams.get("limit");

  if (!isRevisionResourceType(rawResourceType)) {
    return revisionErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Parameter resourceType wajib bernilai page, post, atau offering.",
      requestId,
      [
        {
          field: "resourceType",
          code: "INVALID_RESOURCE_TYPE",
          message: "Expected resourceType to be one of: page, post, offering.",
        },
      ],
    );
  }

  if (!/^[1-9]\d{0,9}$/.test(rawResourceId)) {
    return revisionErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Parameter resourceId harus berupa bilangan bulat positif.",
      requestId,
      [
        {
          field: "resourceId",
          code: "INVALID_RESOURCE_ID",
          message: "Expected resourceId to be a positive sequential integer.",
        },
      ],
    );
  }

  const resourceId = Number(rawResourceId);
  let limit: number = MAX_CONTENT_REVISIONS_PER_RESOURCE;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^[1-9]\d{0,2}$/.test(rawLimit.trim())) {
      return revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Parameter limit harus berupa bilangan bulat antara 1 hingga ${MAX_CONTENT_REVISIONS_PER_RESOURCE}.`,
        requestId,
        [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..20." }],
      );
    }
    const parsedLimit = Number(rawLimit.trim());
    if (parsedLimit < 1 || parsedLimit > MAX_CONTENT_REVISIONS_PER_RESOURCE) {
      return revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Parameter limit maksimal ${MAX_CONTENT_REVISIONS_PER_RESOURCE}.`,
        requestId,
        [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be between 1 and 20." }],
      );
    }
    limit = parsedLimit;
  }

  try {
    const result = await listContentRevisions(auth.ctx.tenantDb, {
      resourceType: rawResourceType,
      resourceId,
      limit,
    });
    return revisionJsonResponse(200, result);
  } catch (err) {
    return mapRevisionDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantRevisionsListRequest(
    params.tenantId ?? "",
    request,
    buildRevisionsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
