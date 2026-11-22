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
 * Tenant-scoped single Blog Tag item endpoint (`taxonomy_type = 'post_tag'`):
 * - `GET    /api/tenants/:tenantId/tags/:tagId`
 * - `PATCH  /api/tenants/:tenantId/tags/:tagId` (optimistic version-guarded)
 * - `DELETE /api/tenants/:tenantId/tags/:tagId` (optimistic version-guarded, 204)
 */

const UPDATE_TAG_ALLOWED_KEYS = new Set([
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

const DELETE_TAG_ALLOWED_KEYS = new Set(["version", "expectedVersion", "detach"]);

export async function handleTenantTagItemRequest(
  tenantId: string,
  rawTagId: string,
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
      "Metode HTTP tidak diizinkan untuk endpoint tag blog.",
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

  const parsedId = parseSequentialIdParam(rawTagId, "tagId", "tag", requestId);
  if (!parsedId.ok) return parsedId.response;

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const tag = await getBlogTaxonomyById(tenantDb, "post_tag", parsedId.id);
      if (!tag) {
        return blogErrorResponse(404, "NOT_FOUND", `Tag #${parsedId.id} tidak ditemukan.`, requestId);
      }
      return blogJsonResponse(200, formatTaxonomyRecordResponse(tag));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(request, UPDATE_TAG_ALLOWED_KEYS, requestId);
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
        kind: "post_tag",
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

    // DELETE /api/tenants/:tenantId/tags/:tagId
    const parsedBody = await parseStrictBlogJsonBody(request, DELETE_TAG_ALLOWED_KEYS, requestId, {
      allowEmptyBody: true,
    });
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

    await deleteBlogTaxonomy(tenantDb, {
      kind: "post_tag",
      taxonomyId: parsedId.id,
      expectedVersion,
      detach,
      nowMs: options.nowMs,
    });

    return blogNoContentResponse();
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantTagItemRequest(
    params.tenantId ?? "",
    params.tagId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
