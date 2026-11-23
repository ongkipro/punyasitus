import { getPostById } from "@punyasitus/db/posts/index";
import { trashContentItem } from "@punyasitus/db/trash/index";
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
 * `POST /api/tenants/:tenantId/posts/:postId/trash`
 * Moves a blog post to 30-day trash, unpublishes atomically, records audit (`WHERE changes() = 1`),
 * and bumps `tenants.cache_version` (TASK-006 & TASK-044; REQ-009, REQ-034, REQ-036, REQ-048).
 */

const TRASH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantPostTrashRequest(
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
      "Gunakan POST untuk memindahkan artikel ke sampah.",
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

  const parsedBody = await parseStrictBlogJsonBody(request, TRASH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractBlogExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const result = await trashContentItem(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "post",
      resourceId: parsedId.id,
      expectedVersion: versionCheck.expectedVersion!,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getPostById(tenantDb, parsedId.id, { includeTrashed: true });
    if (!reloaded) {
      return blogErrorResponse(404, "NOT_FOUND", `Artikel #${parsedId.id} tidak ditemukan.`, requestId);
    }

    return blogJsonResponse(200, {
      ...formatPostRecordResponse(reloaded),
      ...(result.cacheVersion !== null ? { cacheVersion: result.cacheVersion } : {}),
      trashMeta: {
        deletedAt: result.deletedAt,
        purgeEligibleAt: result.purgeEligibleAt,
        daysRemaining: result.daysRemaining,
      },
    });
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostTrashRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
