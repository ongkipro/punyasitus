import { listPageRevisions } from "@punyasitus/db/pages/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parsePageIdParam,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/tenants/:tenantId/pages/:pageId/revisions`
 * Lists up to the latest 20 published revisions for a page (OpenAPI `tenantListPageRevisions`).
 */

export async function handleTenantPageRevisionsRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan GET untuk membaca daftar revisi halaman.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantPageRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  try {
    const items = await listPageRevisions(auth.ctx.tenantDb, parsedId.pageId);
    return pageJsonResponse(200, { items });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPageRevisionsRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
