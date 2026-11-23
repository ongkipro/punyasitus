import { listTrashedContentByType } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  mapBlogDomainErrorToResponse,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/posts/trash`
 * Lists trashed blog posts enriched with 30-day retention countdown, protected references,
 * and media reference inspection reports (TASK-044, REQ-048).
 */

export async function handleTenantPostsTrashListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan GET untuk melihat daftar sampah artikel.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^[1-9]\d{0,2}$/.test(rawLimit.trim()) || Number(rawLimit.trim()) > 100) {
      return blogErrorResponse(
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
    const items = await listTrashedContentByType(auth.ctx.tenantDb, "post", {
      limit,
      nowMs: options.nowMs,
    });
    return blogJsonResponse(200, { items });
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostsTrashListRequest(params.tenantId ?? "", request, buildBlogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
