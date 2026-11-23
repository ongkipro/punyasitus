import { listTrashedContentByType } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/pages/trash`
 * Lists trashed pages enriched with 30-day retention countdown, protected references,
 * and media reference inspection reports (TASK-044, REQ-048).
 */

export async function handleTenantPagesTrashListRequest(
  tenantId: string,
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
      "Gunakan GET untuk melihat daftar sampah halaman.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^[1-9]\d{0,2}$/.test(rawLimit.trim()) || Number(rawLimit.trim()) > 100) {
      return pageErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter limit harus antara 1 hingga 100.",
        requestId,
        [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100." }],
      );
    }
    limit = Number(rawLimit.trim());
  }

  try {
    const items = await listTrashedContentByType(auth.ctx.tenantDb, "page", {
      limit,
      nowMs: options.nowMs,
    });
    return pageJsonResponse(200, { items });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagesTrashListRequest(params.tenantId ?? "", request, buildPagesRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
