import { CATEGORY_WRITE_ALLOWED_KEYS } from "@punyasitus/core/catalog/index";
import {
  deleteCatalogCategory,
  getCatalogCategoryById,
  updateCatalogCategory,
} from "@punyasitus/db/catalog/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantCatalogRequest,
  buildCatalogRuntimeEnv,
  catalogErrorResponse,
  catalogJsonResponse,
  catalogNoContentResponse,
  createRequestId,
  extractCatalogExpectedVersion,
  mapCatalogDomainErrorToResponse,
  parseSequentialPathId,
  parseStrictCatalogJsonBody,
  type TenantCatalogHandlerOptions,
  type TenantCatalogRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped single catalog category endpoint:
 * - `GET    /api/tenants/:tenantId/catalog/categories/:categoryId` -> read single category
 * - `PATCH  /api/tenants/:tenantId/catalog/categories/:categoryId` -> update category with OCC (`409`)
 * - `DELETE /api/tenants/:tenantId/catalog/categories/:categoryId` -> guarded category delete (`204`)
 *
 * TASK-009 (`REQ-012`, `REQ-034`, `REQ-061`).
 */

const DELETE_CATEGORY_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantCatalogCategoryRequest(
  tenantId: string,
  rawCategoryId: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    const auth = await authorizeTenantCatalogRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return catalogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint kategori katalog.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "taxonomy:manage";
  const auth = await authorizeTenantCatalogRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const categoryId = parseSequentialPathId(rawCategoryId);
  if (categoryId === null) {
    return catalogErrorResponse(404, "NOT_FOUND", "Kategori katalog tidak ditemukan.", requestId);
  }

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const category = await getCatalogCategoryById(tenantDb, categoryId);
      if (!category) {
        return catalogErrorResponse(404, "NOT_FOUND", "Kategori katalog tidak ditemukan.", requestId);
      }
      return catalogJsonResponse(200, category);
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictCatalogJsonBody(
        request,
        CATEGORY_WRITE_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) {
        return parsedBody.response;
      }

      const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
        required: true,
      });
      if (!versionCheck.ok) {
        return versionCheck.response;
      }

      const updated = await updateCatalogCategory(tenantDb, categoryId, parsedBody.body, {
        expectedVersion: versionCheck.expectedVersion!,
        nowMs: options.nowMs,
      });
      return catalogJsonResponse(200, updated);
    }

    // DELETE /api/tenants/:tenantId/catalog/categories/:categoryId
    const parsedBody = await parseStrictCatalogJsonBody(
      request,
      DELETE_CATEGORY_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
      required: false,
    });
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    let expectedVersion = versionCheck.expectedVersion;
    if (expectedVersion === undefined) {
      const url = new URL(request.url);
      const qv = url.searchParams.get("expectedVersion") ?? url.searchParams.get("version");
      if (qv !== null) {
        if (!/^[1-9]\d{0,9}$/.test(qv)) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter version harus berupa integer positif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Invalid version query parameter." }],
          );
        }
        expectedVersion = Number(qv);
      }
    }

    await deleteCatalogCategory(tenantDb, categoryId, { expectedVersion });
    return catalogNoContentResponse();
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogCategoryRequest(
    params.tenantId ?? "",
    params.categoryId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
