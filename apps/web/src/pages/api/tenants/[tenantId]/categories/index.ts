import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import { createTaxonomy, listTaxonomies } from "@punyasitus/db/taxonomy/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractIndexOptInField,
  formatTaxonomyResponse,
  mapTaxonomyDomainErrorToResponse,
  parseListPaginationParams,
  parseOfferingTypeQueryParam,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  taxonomyErrorResponse,
  taxonomyJsonResponse,
  withPrivateNoStoreHeaders,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Categories collection endpoint (`post_category` & `offering_category`):
 * - `GET  /api/tenants/:tenantId/categories?kind=post_category|offering_category&offeringType=...`
 * - `POST /api/tenants/:tenantId/categories` -> create category (201, max depth 3, atomic audit)
 *
 * TASK-006 + TASK-041 (`REQ-045`, `REQ-009`, `REQ-012`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const CREATE_CATEGORY_ALLOWED_KEYS = new Set([
  "kind",
  "offeringType",
  "name",
  "slug",
  "description",
  "parentId",
  "sortOrder",
  "indexOptIn",
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
    if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);
    return taxonomyErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk koleksi kategori.",
      requestId,
      undefined,
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
    return withPrivateNoStoreHeaders(auth.response);
  }

  const { tenantDb, platformDb, member } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawKind = url.searchParams.get("kind")?.trim() || "post_category";
      if (rawKind !== "post_category" && rawKind !== "offering_category") {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Endpoint kategori hanya mendukung kind "post_category" atau "offering_category".',
          requestId,
          [
            {
              field: "kind",
              code: "INVALID_KIND",
              message: 'Expected kind "post_category" or "offering_category".',
            },
          ],
        );
      }

      const offeringTypeCheck = parseOfferingTypeQueryParam(
        url.searchParams.get("offeringType"),
        requestId,
      );
      if (!offeringTypeCheck.ok) return offeringTypeCheck.response;
      if (rawKind !== "offering_category" && offeringTypeCheck.offeringType !== undefined) {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Parameter offeringType hanya berlaku untuk kind "offering_category".',
          requestId,
          [
            {
              field: "offeringType",
              code: "INVALID_OFFERING_TYPE",
              message: 'offeringType is only allowed when kind is "offering_category".',
            },
          ],
        );
      }

      const pagination = parseListPaginationParams(url, requestId);
      if (!pagination.ok) return withPrivateNoStoreHeaders(pagination.response);

      let parentId: number | null | undefined;
      const rawParentId = url.searchParams.get("parentId");
      if (rawParentId !== null) {
        if (rawParentId.trim() === "" || rawParentId.trim() === "null") {
          parentId = null;
        } else {
          const parsedParent = parseSequentialIdParam(
            rawParentId,
            "parentId",
            "kategori induk",
            requestId,
          );
          if (!parsedParent.ok) return withPrivateNoStoreHeaders(parsedParent.response);
          parentId = parsedParent.id;
        }
      }

      const list = await listTaxonomies(tenantDb, {
        kind: rawKind,
        offeringType: offeringTypeCheck.offeringType,
        parentId,
        search: url.searchParams.get("search") ?? undefined,
        cursor: pagination.cursor,
        limit: pagination.limit,
        sortOrder: pagination.sortOrder,
      });

      return taxonomyJsonResponse(200, {
        items: list.items.map(formatTaxonomyResponse),
        page: list.page,
      });
    }

    // POST /api/tenants/:tenantId/categories
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      CREATE_CATEGORY_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return withPrivateNoStoreHeaders(parsedBody.response);

    const body = parsedBody.body;
    const targetKind = body.kind === undefined ? "post_category" : body.kind;
    if (targetKind !== "post_category" && targetKind !== "offering_category") {
      return taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Field kind untuk kategori harus "post_category" atau "offering_category".',
        requestId,
        [
          {
            field: "kind",
            code: "INVALID_KIND",
            message: 'Expected kind "post_category" or "offering_category".',
          },
        ],
      );
    }

    const optInCheck = extractIndexOptInField(body, requestId);
    if (!optInCheck.ok) return optInCheck.response;

    const created = await createTaxonomy(
      tenantDb,
      {
        kind: targetKind,
        ...(body.offeringType !== undefined
          ? { offeringType: body.offeringType as CatalogOfferingType | null }
          : {}),
        name: body.name as string,
        ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
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

    return taxonomyJsonResponse(201, formatTaxonomyResponse(created));
  } catch (err) {
    return mapTaxonomyDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCategoriesCollectionRequest(params.tenantId ?? "", request, buildBlogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
