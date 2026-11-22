import { listPostRevisions } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/tenants/:tenantId/posts/:postId/revisions`
 * Lists up to the latest 20 published revisions for a blog post.
 */

export async function handleTenantPostRevisionsRequest(
  tenantId: string,
  rawPostId: string,
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
      "Gunakan GET untuk membaca daftar revisi artikel.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  try {
    const items = await listPostRevisions(auth.ctx.tenantDb, parsedId.id);
    return blogJsonResponse(200, { items });
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostRevisionsRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
