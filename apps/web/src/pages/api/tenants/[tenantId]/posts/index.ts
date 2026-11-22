import type { ResourceLifecycleStatus } from "@punyasitus/core/content/index";
import { createPost, listPosts } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  formatPostRecordResponse,
  mapBlogDomainErrorToResponse,
  parseListPaginationParams,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Blog Posts collection endpoint:
 * - `GET  /api/tenants/:tenantId/posts` -> paginated list with status/category/tag/search filters
 * - `POST /api/tenants/:tenantId/posts` -> create a draft blog post (201)
 *
 * TASK-006 (`REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const CREATE_POST_ALLOWED_KEYS = new Set([
  "title",
  "slug",
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
]);

const ALLOWED_STATUS_FILTERS = new Set(["draft", "published", "trashed", "all"]);

export async function handleTenantPostsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk koleksi artikel blog.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
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

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawStatus = url.searchParams.get("status")?.trim() ?? "all";
      if (!ALLOWED_STATUS_FILTERS.has(rawStatus)) {
        return blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Parameter status harus salah satu dari "draft", "published", "trashed", atau "all".',
          requestId,
          [{ field: "status", code: "INVALID_STATUS_FILTER", message: "Unsupported status filter value." }],
        );
      }

      const pagination = parseListPaginationParams(url, requestId);
      if (!pagination.ok) {
        return pagination.response;
      }

      let categoryId: number | undefined;
      const rawCategoryId = url.searchParams.get("categoryId");
      if (rawCategoryId !== null && rawCategoryId.trim() !== "") {
        const parsedCat = parseSequentialIdParam(rawCategoryId, "categoryId", "kategori", requestId);
        if (!parsedCat.ok) return parsedCat.response;
        categoryId = parsedCat.id;
      }

      let tagId: number | undefined;
      const rawTagId = url.searchParams.get("tagId");
      if (rawTagId !== null && rawTagId.trim() !== "") {
        const parsedTag = parseSequentialIdParam(rawTagId, "tagId", "tag", requestId);
        if (!parsedTag.ok) return parsedTag.response;
        tagId = parsedTag.id;
      }

      const includeTrashed = url.searchParams.get("includeTrashed") === "true";
      const search = url.searchParams.get("search") ?? undefined;

      const list = await listPosts(tenantDb, {
        status: rawStatus as ResourceLifecycleStatus | "all",
        includeTrashed,
        categoryId,
        tagId,
        search,
        cursor: pagination.cursor,
        limit: pagination.limit,
        sortOrder: pagination.sortOrder,
      });

      return blogJsonResponse(200, {
        items: list.items.map(formatPostRecordResponse),
        page: list.page,
      });
    }

    // POST /api/tenants/:tenantId/posts
    const parsedBody = await parseStrictBlogJsonBody(request, CREATE_POST_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const body = parsedBody.body;
    const created = await createPost(
      tenantDb,
      {
        title: body.title as string,
        ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
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
        organizationId: member.organizationId,
        actorUserId: member.userId,
      },
    );

    return blogJsonResponse(201, formatPostRecordResponse(created));
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostsCollectionRequest(params.tenantId ?? "", request, buildBlogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
