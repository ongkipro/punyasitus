import { getContentRevision, parseRevisionId } from "@punyasitus/db/revisions/index";
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
 * `GET /api/tenants/:tenantId/revisions/:revisionId`
 *
 * Reads one historical revision snapshot plus its live single-tenant media/taxonomy/author
 * reference health report (TASK-064; REQ-048, REQ-034).
 */

export async function handleTenantRevisionDetailRequest(
  tenantId: string,
  rawRevisionId: string,
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
      "Gunakan GET untuk membaca detail revisi konten.",
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

  const parsedId = parseRevisionId(rawRevisionId);
  if (!parsedId) {
    return revisionErrorResponse(404, "NOT_FOUND", "Revisi konten tidak ditemukan.", requestId);
  }

  try {
    const detail = await getContentRevision(auth.ctx.tenantDb, {
      resourceType: parsedId.resourceType,
      resourceId: parsedId.resourceId,
      revisionNumber: parsedId.revisionNumber,
    });
    return revisionJsonResponse(200, detail);
  } catch (err) {
    return mapRevisionDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantRevisionDetailRequest(
    params.tenantId ?? "",
    params.revisionId ?? "",
    request,
    buildRevisionsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
