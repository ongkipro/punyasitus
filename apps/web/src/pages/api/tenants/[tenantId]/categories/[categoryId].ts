import {
  deleteBlogTaxonomy,
  getBlogTaxonomyById,
  updateBlogTaxonomy,
} from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  blogNoContentResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  formatTaxonomyRecordResponse,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../posts/_shared.ts";

/**
 * Tenant-scoped single Blog Category item endpoint (`taxonomy_type = 'post_category'`):
 * - `GET    /api/tenants/:tenantId/categories/:categoryId`
 * - `PATCH  /api/tenants/:tenantId/categories/:categoryId` (optimistic version-guarded)
 * - `DELETE /api/tenants/:tenantId/categories/:categoryId` (optimistic version-guarded, 204)
 */

const UPDATE_CATEGORY_ALLOWED_KEYS = new Set([
  "name",
  "slug",
  "confirmSlugChange",
  "description",
  "parentId",
  "sortOrder",
  "indexable",
  "version",
  "expectedVersion",
]);

const DELETE_CATEGORY_ALLOWED_KEYS = new Set([
  "version",
  "expectedVersion",
  "detach",
  "reassignToCategoryId",
]);

export async function handleTenantCategoryItemRequest(
  tenantId: string,
  rawCategoryId: string,
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
      "Metode HTTP tidak diizinkan untuk endpoint kategori blog.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
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
  if (!auth.ok) return auth.response;

  const parsedId = parseSequentialIdParam(rawCategoryId, "categoryId", "kategori", requestId);
  if (!parsedId.ok) return parsedId.response;

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const cat = await getBlogTaxonomyById(tenantDb, "post_category", parsedId.id);
      if (!cat) {
        return blogErrorResponse(
          404,
          "NOT_FOUND",
          `Kategori #${parsedId.id} tidak ditemukan.`,
          requestId,
        );
      }
      return blogJsonResponse(200, formatTaxonomyRecordResponse(cat));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(
        request,
        UPDATE_CATEGORY_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) return parsedBody.response;

      const body = parsedBody.body;
      const versionCheck = extractBlogExpectedVersion(body, requestId, { required: true });
      if (!versionCheck.ok) return versionCheck.response;

      if (body.confirmSlugChange !== undefined && typeof body.confirmSlugChange !== "boolean") {
        return blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "confirmSlugChange harus berupa boolean.",
          requestId,
          [{ field: "confirmSlugChange", code: "INVALID_TYPE", message: "Expected a boolean." }],
        );
      }

      const updated = await updateBlogTaxonomy(tenantDb, {
        kind: "post_category",
        taxonomyId: parsedId.id,
        expectedVersion: versionCheck.expectedVersion!,
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
        ...(body.confirmSlugChange !== undefined
          ? { confirmSlugChange: body.confirmSlugChange as boolean }
          : {}),
        ...(body.description !== undefined ? { description: body.description as string | null } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId as number | null } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder as number } : {}),
        nowMs: options.nowMs,
      });

      return blogJsonResponse(200, formatTaxonomyRecordResponse(updated));
    }

    // DELETE /api/tenants/:tenantId/categories/:categoryId
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      DELETE_CATEGORY_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body;
    const versionCheck = extractBlogExpectedVersion(body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const url = new URL(request.url);
    let expectedVersion = versionCheck.expectedVersion;
    if (expectedVersion === undefined) {
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

    if (body.detach !== undefined && typeof body.detach !== "boolean") {
      return blogErrorResponse(422, "VALIDATION_ERROR", "detach harus berupa boolean.", requestId, [
        { field: "detach", code: "INVALID_TYPE", message: "Expected a boolean for detach." },
      ]);
    }
    const detach =
      body.detach !== undefined ? (body.detach as boolean) : url.searchParams.get("detach") === "true";

    let reassignToCategoryId: number | undefined;
    if (body.reassignToCategoryId !== undefined) {
      if (typeof body.reassignToCategoryId !== "number") {
        return blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "reassignToCategoryId harus berupa bilangan bulat positif.",
          requestId,
          [{ field: "reassignToCategoryId", code: "INVALID_TYPE", message: "Expected a positive integer." }],
        );
      }
      reassignToCategoryId = body.reassignToCategoryId;
    } else if (url.searchParams.get("reassignToCategoryId") !== null) {
      const parsedTarget = parseSequentialIdParam(
        url.searchParams.get("reassignToCategoryId") ?? "",
        "reassignToCategoryId",
        "kategori pengganti",
        requestId,
      );
      if (!parsedTarget.ok) return parsedTarget.response;
      reassignToCategoryId = parsedTarget.id;
    }

    await deleteBlogTaxonomy(tenantDb, {
      kind: "post_category",
      taxonomyId: parsedId.id,
      expectedVersion,
      detach,
      reassignToCategoryId,
      nowMs: options.nowMs,
    });

    return blogNoContentResponse();
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCategoryItemRequest(
    params.tenantId ?? "",
    params.categoryId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
