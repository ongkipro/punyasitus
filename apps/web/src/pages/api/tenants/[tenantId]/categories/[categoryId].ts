import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
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
} from "./_shared.ts";

/**
 * Tenant-scoped single Category item endpoint (`post_category` or `offering_category`):
 * - `GET    /api/tenants/:tenantId/categories/:categoryId`
 * - `PATCH  /api/tenants/:tenantId/categories/:categoryId` (required version, cycle/depth<=3, atomic audit)
 * - `DELETE /api/tenants/:tenantId/categories/:categoryId` (required version, 409 children/in-use guard, atomic reassign/detach, 204)
 *
 * TASK-006 + TASK-041 (`REQ-045`, `REQ-009`, `REQ-012`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const UPDATE_CATEGORY_ALLOWED_KEYS = new Set([
  "name",
  "slug",
  "confirmSlugChange",
  "description",
  "parentId",
  "offeringType",
  "sortOrder",
  "indexOptIn",
  "indexable",
  "version",
  "expectedVersion",
]);

const DELETE_CATEGORY_ALLOWED_KEYS = new Set([
  "version",
  "expectedVersion",
  "detach",
  "reassignToId",
  "reassignToCategoryId",
]);

function parseOptionalCategoryKindQuery(
  url: URL,
  requestId: string,
):
  | { readonly ok: true; readonly kind: "post_category" | "offering_category" | undefined }
  | { readonly ok: false; readonly response: Response } {
  const raw = url.searchParams.get("kind")?.trim();
  if (!raw) return { ok: true, kind: undefined };
  if (raw !== "post_category" && raw !== "offering_category") {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Parameter kind harus "post_category" atau "offering_category".',
        requestId,
        [
          {
            field: "kind",
            code: "INVALID_KIND",
            message: 'Expected kind "post_category" or "offering_category".',
          },
        ],
      ),
    };
  }
  return { ok: true, kind: raw };
}

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
    if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);
    return taxonomyErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint kategori.",
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

  const parsedId = parseSequentialIdParam(rawCategoryId, "categoryId", "kategori", requestId);
  if (!parsedId.ok) return withPrivateNoStoreHeaders(parsedId.response);

  const url = new URL(request.url);
  const kindCheck = parseOptionalCategoryKindQuery(url, requestId);
  if (!kindCheck.ok) return kindCheck.response;

  const { tenantDb, platformDb, member } = auth.ctx;

  try {
    // Verify record exists and is a category (never expose post_tag on /categories/:id)
    const existing = await getTaxonomyById(tenantDb, parsedId.id, kindCheck.kind);
    if (!existing || existing.kind === "post_tag") {
      return taxonomyErrorResponse(
        404,
        "NOT_FOUND",
        `Kategori #${parsedId.id} tidak ditemukan.`,
        requestId,
      );
    }

    if (method === "GET") {
      return taxonomyJsonResponse(200, formatTaxonomyResponse(existing));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(
        request,
        UPDATE_CATEGORY_ALLOWED_KEYS,
        requestId,
      );
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
          kind: existing.kind,
          taxonomyId: parsedId.id,
          expectedVersion: versionCheck.expectedVersion!,
          ...(body.name !== undefined ? { name: body.name as string } : {}),
          ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
          ...(body.confirmSlugChange !== undefined
            ? { confirmSlugChange: body.confirmSlugChange as boolean }
            : {}),
          ...(body.description !== undefined ? { description: body.description as string | null } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId as number | null } : {}),
          ...(body.offeringType !== undefined
            ? { offeringType: body.offeringType as CatalogOfferingType | null }
            : {}),
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

    // DELETE /api/tenants/:tenantId/categories/:categoryId
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      DELETE_CATEGORY_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) return withPrivateNoStoreHeaders(parsedBody.response);

    const body = parsedBody.body;
    const versionCheck = extractRequiredDeleteVersion(body, url, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    if (body.detach !== undefined && typeof body.detach !== "boolean") {
      return taxonomyErrorResponse(422, "VALIDATION_ERROR", "detach harus berupa boolean.", requestId, [
        { field: "detach", code: "INVALID_TYPE", message: "Expected a boolean for detach." },
      ]);
    }
    const detach =
      body.detach !== undefined ? (body.detach as boolean) : url.searchParams.get("detach") === "true";

    if (
      body.reassignToId !== undefined &&
      body.reassignToCategoryId !== undefined &&
      body.reassignToId !== body.reassignToCategoryId
    ) {
      return taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "reassignToId dan reassignToCategoryId harus sama jika keduanya dikirim.",
        requestId,
        [
          {
            field: "reassignToId",
            code: "CONFLICTING_FIELDS",
            message: "Conflicting reassignToId and reassignToCategoryId values.",
          },
        ],
      );
    }

    let reassignToId: number | undefined;
    const rawReassignBody =
      body.reassignToId !== undefined ? body.reassignToId : body.reassignToCategoryId;
    if (rawReassignBody !== undefined && rawReassignBody !== null) {
      if (typeof rawReassignBody !== "number" || !Number.isSafeInteger(rawReassignBody)) {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          "reassignToId harus berupa bilangan bulat positif.",
          requestId,
          [{ field: "reassignToId", code: "INVALID_TYPE", message: "Expected a positive integer." }],
        );
      }
      reassignToId = rawReassignBody;
    } else {
      const qTarget =
        url.searchParams.get("reassignToId") ?? url.searchParams.get("reassignToCategoryId");
      if (qTarget !== null && qTarget.trim() !== "") {
        const parsedTarget = parseSequentialIdParam(
          qTarget,
          "reassignToId",
          "kategori pengganti",
          requestId,
        );
        if (!parsedTarget.ok) return withPrivateNoStoreHeaders(parsedTarget.response);
        reassignToId = parsedTarget.id;
      }
    }

    await deleteTaxonomy(
      tenantDb,
      {
        kind: existing.kind,
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
