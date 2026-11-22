import { createBlogTaxonomy, listBlogTaxonomies } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  formatTaxonomyRecordResponse,
  mapBlogDomainErrorToResponse,
  parseListPaginationParams,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../posts/_shared.ts";

/**
 * Tenant-scoped Blog Categories collection endpoint (`taxonomy_type = 'post_category'`):
 * - `GET  /api/tenants/:tenantId/categories` -> paginated list
 * - `POST /api/tenants/:tenantId/categories` -> create a blog category (201, max depth 3)
 *
 * TASK-006 (`REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const CREATE_CATEGORY_ALLOWED_KEYS = new Set([
  "kind",
  "name",
  "slug",
  "description",
  "parentId",
  "sortOrder",
  "indexable",
]);

export async function handleTenantCategoriesCollectionRequest(
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
      "Metode HTTP tidak diizinkan untuk koleksi kategori blog.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "taxonomy:manage";
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

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawKind = url.searchParams.get("kind")?.trim();
      if (rawKind && rawKind !== "post_category") {
        return blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Endpoint kategori blog hanya mendukung kind "post_category".',
          requestId,
          [{ field: "kind", code: "INVALID_KIND", message: 'Expected kind "post_category".' }],
        );
      }

      const pagination = parseListPaginationParams(url, requestId);
      if (!pagination.ok) return pagination.response;

      let parentId: number | null | undefined;
      const rawParentId = url.searchParams.get("parentId");
      if (rawParentId !== null) {
        if (rawParentId.trim() === "" || rawParentId.trim() === "null") {
          parentId = null;
        } else {
          const parsedParent = parseSequentialIdParam(rawParentId, "parentId", "kategori induk", requestId);
          if (!parsedParent.ok) return parsedParent.response;
          parentId = parsedParent.id;
        }
      }

      const list = await listBlogTaxonomies(tenantDb, {
        kind: "post_category",
        parentId,
        search: url.searchParams.get("search") ?? undefined,
        cursor: pagination.cursor,
        limit: pagination.limit,
        sortOrder: pagination.sortOrder,
      });

      return blogJsonResponse(200, {
        items: list.items.map(formatTaxonomyRecordResponse),
        page: list.page,
      });
    }

    // POST /api/tenants/:tenantId/categories
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      CREATE_CATEGORY_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body;
    if (body.kind !== undefined && body.kind !== "post_category") {
      return blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Field kind untuk kategori blog harus "post_category".',
        requestId,
        [{ field: "kind", code: "INVALID_KIND", message: 'Expected kind "post_category".' }],
      );
    }

    const created = await createBlogTaxonomy(tenantDb, {
      kind: "post_category",
      name: body.name as string,
      ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
      ...(body.description !== undefined ? { description: body.description as string | null } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId as number | null } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder as number } : {}),
      nowMs: options.nowMs,
    });

    return blogJsonResponse(201, formatTaxonomyRecordResponse(created));
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCategoriesCollectionRequest(params.tenantId ?? "", request, buildBlogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
