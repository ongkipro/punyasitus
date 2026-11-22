import { publishPost } from "@punyasitus/db/posts/index";
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
 * `POST /api/tenants/:tenantId/posts/:postId/publish`
 * Atomically publishes a blog post draft snapshot and bumps `PLATFORM_DB.tenants.cache_version`.
 *
 * TASK-006 (`REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmSlugChange"]);

export async function handleTenantPostPublishRequest(
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
      "Gunakan POST untuk mempublikasikan artikel.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictBlogJsonBody(request, PUBLISH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractBlogExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (
    parsedBody.body.confirmSlugChange !== undefined &&
    typeof parsedBody.body.confirmSlugChange !== "boolean"
  ) {
    return blogErrorResponse(
      422,
      "VALIDATION_ERROR",
      "confirmSlugChange harus berupa boolean.",
      requestId,
      [
        {
          field: "confirmSlugChange",
          code: "INVALID_TYPE",
          message: "Expected a boolean for confirmSlugChange.",
        },
      ],
    );
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const result = await publishPost(platformDb, tenantDb, {
      tenantId: member.tenantId,
      organizationId: member.organizationId,
      postId: parsedId.id,
      expectedVersion: versionCheck.expectedVersion!,
      confirmSlugChange: parsedBody.body.confirmSlugChange as boolean | undefined,
      actorUserId: member.userId,
      nowMs: options.nowMs,
    });

    return blogJsonResponse(200, {
      ...formatPostRecordResponse(result.post),
      cacheVersion: result.cacheVersion,
      revisionNumber: result.revisionNumber,
    });
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostPublishRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
