import { getPostById, updatePost } from "@punyasitus/db/posts/index";
import { trashContentItem } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  blogNoContentResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  formatPostRecordResponse,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped single Blog Post endpoint:
 * - `GET    /api/tenants/:tenantId/posts/:postId` -> read single post by sequential ID
 * - `PATCH  /api/tenants/:tenantId/posts/:postId` -> save draft edits with optimistic concurrency
 * - `DELETE /api/tenants/:tenantId/posts/:postId` -> soft-delete (trash) post (204)
 *
 * TASK-006 (`REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const UPDATE_POST_ALLOWED_KEYS = new Set([
  "title",
  "slug",
  "confirmSlugChange",
  "excerpt",
  "body",
  "bodyHtml",
  "featuredMediaId",
  "coverMediaId",
  "primaryCategoryId",
  "categoryIds",
  "tagIds",
  "authorId",
  "authorUserId",
  "authorName",
  "enableToc",
  "showToc",
  "seo",
  "version",
  "expectedVersion",
]);

const DELETE_POST_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantPostItemRequest(
  tenantId: string,
  rawPostId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint artikel blog.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "content:write";
  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const includeTrashed = url.searchParams.get("includeTrashed") === "true";
      const post = await getPostById(tenantDb, parsedId.id, { includeTrashed });
      if (!post) {
        return blogErrorResponse(
          404,
          "NOT_FOUND",
          `Artikel #${parsedId.id} tidak ditemukan.`,
          requestId,
        );
      }
      return blogJsonResponse(200, formatPostRecordResponse(post));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(
        request,
        UPDATE_POST_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) {
        return parsedBody.response;
      }

      const body = parsedBody.body;
      const versionCheck = extractBlogExpectedVersion(body, requestId, { required: true });
      if (!versionCheck.ok) {
        return versionCheck.response;
      }

      if (body.confirmSlugChange !== undefined && typeof body.confirmSlugChange !== "boolean") {
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

      const updated = await updatePost(
        tenantDb,
        {
          postId: parsedId.id,
          expectedVersion: versionCheck.expectedVersion!,
          ...(body.title !== undefined ? { title: body.title as string } : {}),
          ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
          ...(body.confirmSlugChange !== undefined
            ? { confirmSlugChange: body.confirmSlugChange as boolean }
            : {}),
          ...(body.excerpt !== undefined ? { excerpt: body.excerpt as string | null } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml as string } : {}),
          ...(body.featuredMediaId !== undefined
            ? { featuredMediaId: body.featuredMediaId as number | null }
            : {}),
          ...(body.coverMediaId !== undefined
            ? { coverMediaId: body.coverMediaId as number | null }
            : {}),
          ...(body.primaryCategoryId !== undefined
            ? { primaryCategoryId: body.primaryCategoryId as number | null }
            : {}),
          ...(body.categoryIds !== undefined
            ? { categoryIds: body.categoryIds as readonly number[] }
            : {}),
          ...(body.tagIds !== undefined ? { tagIds: body.tagIds as readonly number[] } : {}),
          ...(body.authorId !== undefined ? { authorId: body.authorId as number | null } : {}),
          ...(body.authorUserId !== undefined
            ? { authorUserId: body.authorUserId as string | null }
            : {}),
          ...(body.authorName !== undefined ? { authorName: body.authorName as string | null } : {}),
          ...(body.enableToc !== undefined ? { enableToc: body.enableToc as boolean } : {}),
          ...(body.showToc !== undefined ? { showToc: body.showToc as boolean } : {}),
          ...(body.seo !== undefined ? { seo: body.seo } : {}),
          nowMs: options.nowMs,
        },
        {
          platformDb,
          tenantId: member.tenantId,
          organizationId: member.organizationId,
          actorUserId: member.userId,
        },
      );

      return blogJsonResponse(200, formatPostRecordResponse(updated));
    }

    // DELETE /api/tenants/:tenantId/posts/:postId (soft-delete/trash -> 204 No Content)
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      DELETE_POST_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractBlogExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    let expectedVersion = versionCheck.expectedVersion;
    if (expectedVersion === undefined) {
      const url = new URL(request.url);
      const queryVersion = url.searchParams.get("version") ?? url.searchParams.get("expectedVersion");
      if (queryVersion !== null) {
        if (!/^\d+$/.test(queryVersion)) {
          return blogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter query version harus berupa bilangan bulat non-negatif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Invalid version query parameter." }],
          );
        }
        expectedVersion = Number(queryVersion);
      }
    }

    await trashContentItem(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "post",
      resourceId: parsedId.id,
      expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return blogNoContentResponse();
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostItemRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
