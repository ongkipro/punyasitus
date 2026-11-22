import { restorePost } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  formatPostRecordResponse,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/posts/:postId/restore`
 * Restores a trashed blog post back to `draft` state ONLY (never auto-publishes).
 */

const RESTORE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "resolvedSlug"]);

export async function handleTenantPostRestoreRequest(
  tenantId: string,
  rawPostId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST untuk memulihkan artikel dari sampah.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:write",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictBlogJsonBody(request, RESTORE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractBlogExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  const { tenantDb } = auth.ctx;

  try {
    const restored = await restorePost(tenantDb, {
      postId: parsedId.id,
      expectedVersion: versionCheck.expectedVersion!,
      ...(parsedBody.body.resolvedSlug !== undefined
        ? { resolvedSlug: parsedBody.body.resolvedSlug as string }
        : {}),
      nowMs: options.nowMs,
    });

    return blogJsonResponse(200, formatPostRecordResponse(restored));
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostRestoreRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
