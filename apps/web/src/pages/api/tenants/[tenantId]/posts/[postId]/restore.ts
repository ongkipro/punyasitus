import { getPostById } from "@punyasitus/db/posts/index";
import { restoreContentItem } from "@punyasitus/db/trash/index";
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
 * Restores a trashed blog post back to `draft` state ONLY (never auto-publishes),
 * validates `expectedVersion` (`409 STALE_VERSION`), checks slug/redirect collisions
 * (`409 CONFLICT` with `suggestedSlug` and optional `resolvedSlug` rename), and
 * inspects media references cleanly without corrupting draft data.
 *
 * TASK-006 & TASK-044 (`REQ-009`, `REQ-034`, `REQ-036`, `REQ-048`, `REQ-061`).
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

  if (
    parsedBody.body.resolvedSlug !== undefined &&
    typeof parsedBody.body.resolvedSlug !== "string"
  ) {
    return blogErrorResponse(
      422,
      "VALIDATION_ERROR",
      "resolvedSlug harus berupa teks slug yang valid.",
      requestId,
      [{ field: "resolvedSlug", code: "INVALID_TYPE", message: "Expected a string for resolvedSlug." }],
    );
  }

  const { member, tenantDb } = auth.ctx;

  try {
    const result = await restoreContentItem(tenantDb, {
      resourceType: "post",
      resourceId: parsedId.id,
      expectedVersion: versionCheck.expectedVersion!,
      ...(parsedBody.body.resolvedSlug !== undefined
        ? { resolvedSlug: parsedBody.body.resolvedSlug as string }
        : {}),
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getPostById(tenantDb, parsedId.id);
    if (!reloaded) {
      return blogErrorResponse(404, "NOT_FOUND", `Artikel #${parsedId.id} tidak ditemukan.`, requestId);
    }

    return blogJsonResponse(200, {
      ...formatPostRecordResponse(reloaded),
      slugChanged: result.slugChanged,
      previousSlug: result.previousSlug,
      mediaReferences: result.mediaReferences,
    });
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
