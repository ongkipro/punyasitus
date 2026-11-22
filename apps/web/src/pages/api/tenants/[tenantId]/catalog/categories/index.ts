import {
  CATEGORY_WRITE_ALLOWED_KEYS,
  isCatalogOfferingType,
  type CatalogOfferingType,
} from "@punyasitus/core/catalog/index";
import { createCatalogCategory, listCatalogCategories } from "@punyasitus/db/catalog/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantCatalogRequest,
  buildCatalogRuntimeEnv,
  catalogErrorResponse,
  catalogJsonResponse,
  createRequestId,
  mapCatalogDomainErrorToResponse,
  parseStrictCatalogJsonBody,
  type TenantCatalogHandlerOptions,
  type TenantCatalogRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped catalog categories collection endpoint:
 * - `GET  /api/tenants/:tenantId/catalog/categories` -> list offering categories
 * - `POST /api/tenants/:tenantId/catalog/categories` -> create offering category (`201`)
 *
 * TASK-009 (`REQ-012`, `REQ-034`, `REQ-061`).
 */

const CREATE_CATEGORY_ALLOWED_KEYS = new Set(
  [...CATEGORY_WRITE_ALLOWED_KEYS].filter((k) => k !== "version" && k !== "expectedVersion"),
);

export async function handleTenantCatalogCategoriesRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "POST") {
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
      { Allow: "GET, POST" },
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

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawType = url.searchParams.get("offeringType");
      let offeringType: CatalogOfferingType | undefined;
      if (rawType !== null && rawType !== "") {
        if (!isCatalogOfferingType(rawType)) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Filter offeringType tidak valid.",
            requestId,
            [
              {
                field: "offeringType",
                code: "INVALID_OFFERING_TYPE",
                message: "offeringType must be service, product, tour, or vehicle.",
              },
            ],
          );
        }
        offeringType = rawType;
      }

      const rawCursor = url.searchParams.get("cursor");
      let cursor: number | undefined;
      if (rawCursor !== null && rawCursor !== "") {
        if (!/^[1-9]\d{0,9}$/.test(rawCursor)) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter cursor tidak valid.",
            requestId,
            [{ field: "cursor", code: "INVALID_CURSOR", message: "cursor must be a positive integer." }],
          );
        }
        cursor = Number(rawCursor);
      }

      const rawLimit = url.searchParams.get("limit");
      let limit: number | undefined;
      if (rawLimit !== null && rawLimit !== "") {
        if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter limit harus antara 1 dan 100.",
            requestId,
            [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100." }],
          );
        }
        limit = Number(rawLimit);
      }

      const result = await listCatalogCategories(tenantDb, {
        offeringType,
        cursor,
        limit,
      });
      return catalogJsonResponse(200, result);
    }

    // POST /api/tenants/:tenantId/catalog/categories
    const parsedBody = await parseStrictCatalogJsonBody(
      request,
      CREATE_CATEGORY_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const created = await createCatalogCategory(tenantDb, parsedBody.body, {
      nowMs: options.nowMs,
    });
    return catalogJsonResponse(201, created);
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogCategoriesRequest(params.tenantId ?? "", request, buildCatalogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
