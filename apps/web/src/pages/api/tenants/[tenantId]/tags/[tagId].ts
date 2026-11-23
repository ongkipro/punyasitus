import { deleteTaxonomy, getTaxonomyById, updateTaxonomy } from "@punyasitus/db/taxonomy/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  extractIndexOptInField,
  extractRequiredDeleteVersion,
  formatTaxonomyResponse,
  mapTaxonomyDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  taxonomyErrorResponse,
  taxonomyJsonResponse,
  taxonomyNoContentResponse,
  withPrivateNoStoreHeaders,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../categories/_shared.ts";

/**
 * Tenant-scoped single Flat Blog Tag item endpoint (`taxonomy_type = 'post_tag'`):
 * - `GET    /api/tenants/:tenantId/tags/:tagId`
 * - `PATCH  /api/tenants/:tenantId/tags/:tagId` (required version, rejects parentId, atomic audit)
 * - `DELETE /api/tenants/:tenantId/tags/:tagId` (required version, 409 TAXONOMY_IN_USE guard, atomic detach/reassign, 204)
 *
 * TASK-006 + TASK-041 (`REQ-045`, `REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const UPDATE_TAG_ALLOWED_KEYS = new Set([
  "name",
  "slug",
  "confirmSlugChange",
  "description",
  "parentId",
  "sortOrder",
  "indexOptIn",
  "indexable",
  "version",
  "expectedVersion",
]);

const DELETE_TAG_ALLOWED_KEYS = new Set([
  "version",
  "expectedVersion",
  "detach",
  "reassignToId",
]);

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
    if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);
    return taxonomyErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint tag blog.",
      requestId,
      undefined,
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
  if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);

  const parsedId = parseSequentialIdParam(rawTagId, "tagId", "tag", requestId);
  if (!parsedId.ok) return withPrivateNoStoreHeaders(parsedId.response);

  const { tenantDb, platformDb, member } = auth.ctx;

  try {
    if (method === "GET") {
      const tag = await getTaxonomyById(tenantDb, parsedId.id, "post_tag");
      if (!tag) {
        return taxonomyErrorResponse(404, "NOT_FOUND", `Tag #${parsedId.id} tidak ditemukan.`, requestId);
      }
      return taxonomyJsonResponse(200, formatTaxonomyResponse(tag));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(request, UPDATE_TAG_ALLOWED_KEYS, requestId);
      if (!parsedBody.ok) return withPrivateNoStoreHeaders(parsedBody.response);

      const body = parsedBody.body;
      const versionCheck = extractBlogExpectedVersion(body, requestId, { required: true });
      if (!versionCheck.ok) return withPrivateNoStoreHeaders(versionCheck.response);

      if (body.confirmSlugChange !== undefined && typeof body.confirmSlugChange !== "boolean") {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          "confirmSlugChange harus berupa boolean.",
          requestId,
          [{ field: "confirmSlugChange", code: "INVALID_TYPE", message: "Expected a boolean." }],
        );
      }

      const optInCheck = extractIndexOptInField(body, requestId);
      if (!optInCheck.ok) return optInCheck.response;

      const updated = await updateTaxonomy(
        tenantDb,
        {
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
          ...(optInCheck.value !== undefined ? { indexOptIn: optInCheck.value } : {}),
          nowMs: options.nowMs,
        },
        {
          actorUserId: member.userId,
          actorRole: member.role,
          platformDb,
          tenantId: member.tenantId,
        },
      );

      return taxonomyJsonResponse(200, formatTaxonomyResponse(updated));
    }

    // DELETE /api/tenants/:tenantId/tags/:tagId
    const parsedBody = await parseStrictBlogJsonBody(request, DELETE_TAG_ALLOWED_KEYS, requestId, {
      allowEmptyBody: true,
    });
    if (!parsedBody.ok) return withPrivateNoStoreHeaders(parsedBody.response);

    const body = parsedBody.body;
    const url = new URL(request.url);
    const versionCheck = extractRequiredDeleteVersion(body, url, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    if (body.detach !== undefined && typeof body.detach !== "boolean") {
      return taxonomyErrorResponse(422, "VALIDATION_ERROR", "detach harus berupa boolean.", requestId, [
        { field: "detach", code: "INVALID_TYPE", message: "Expected a boolean for detach." },
      ]);
    }
    const detach =
      body.detach !== undefined ? (body.detach as boolean) : url.searchParams.get("detach") === "true";

    let reassignToId: number | undefined;
    if (body.reassignToId !== undefined && body.reassignToId !== null) {
      if (typeof body.reassignToId !== "number" || !Number.isSafeInteger(body.reassignToId)) {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          "reassignToId harus berupa bilangan bulat positif.",
          requestId,
          [{ field: "reassignToId", code: "INVALID_TYPE", message: "Expected a positive integer." }],
        );
      }
      reassignToId = body.reassignToId;
    } else if (url.searchParams.get("reassignToId") !== null && url.searchParams.get("reassignToId")!.trim() !== "") {
      const parsedTarget = parseSequentialIdParam(
        url.searchParams.get("reassignToId") ?? "",
        "reassignToId",
        "tag pengganti",
        requestId,
      );
      if (!parsedTarget.ok) return withPrivateNoStoreHeaders(parsedTarget.response);
      reassignToId = parsedTarget.id;
    }

    await deleteTaxonomy(
      tenantDb,
      {
        kind: "post_tag",
        taxonomyId: parsedId.id,
        expectedVersion: versionCheck.expectedVersion,
        detach,
        reassignToId,
        nowMs: options.nowMs,
      },
      {
        actorUserId: member.userId,
        actorRole: member.role,
        platformDb,
        tenantId: member.tenantId,
      },
    );

    return taxonomyNoContentResponse();
  } catch (err) {
    return mapTaxonomyDomainErrorToResponse(err, requestId);
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
