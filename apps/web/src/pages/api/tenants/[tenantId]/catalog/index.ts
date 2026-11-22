import {
  isCatalogOfferingType,
  OFFERING_WRITE_ALLOWED_KEYS,
  type CatalogOfferingType,
} from "@punyasitus/core/catalog/index";
import type { ResourceLifecycleStatus } from "@punyasitus/core/content/index";
import { createCatalogOffering, listCatalogOfferings } from "@punyasitus/db/catalog/index";
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
} from "./_shared.ts";

/**
 * Tenant-scoped catalog offerings collection endpoint:
 * - `GET  /api/tenants/:tenantId/catalog` -> list typed offerings (bounded pagination + filters)
 * - `POST /api/tenants/:tenantId/catalog` -> create a draft typed offering (`201`)
 *
 * Matches OpenAPI `tenantListCatalog` & `tenantCreateOffering` (TASK-009).
 */

const VALID_STATUSES = new Set<ResourceLifecycleStatus>(["draft", "published", "trashed"]);
const CREATE_OFFERING_ALLOWED_KEYS = new Set(
  [...OFFERING_WRITE_ALLOWED_KEYS].filter((k) => k !== "version" && k !== "expectedVersion"),
);

export async function handleTenantCatalogCollectionRequest(
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
      "Metode HTTP tidak diizinkan untuk endpoint koleksi katalog.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "content:write";
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

      const rawStatus = url.searchParams.get("status");
      let status: ResourceLifecycleStatus | undefined;
      if (rawStatus !== null && rawStatus !== "") {
        if (!VALID_STATUSES.has(rawStatus as ResourceLifecycleStatus)) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Filter status tidak valid.",
            requestId,
            [
              {
                field: "status",
                code: "INVALID_STATUS",
                message: "status must be draft, published, or trashed.",
              },
            ],
          );
        }
        status = rawStatus as ResourceLifecycleStatus;
      }

      const rawCategoryId = url.searchParams.get("categoryId");
      let categoryId: number | undefined;
      if (rawCategoryId !== null && rawCategoryId !== "") {
        if (!/^[1-9]\d{0,9}$/.test(rawCategoryId)) {
          return catalogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Filter categoryId harus berupa integer positif.",
            requestId,
            [
              {
                field: "categoryId",
                code: "INVALID_ID",
                message: "categoryId must be a positive integer.",
              },
            ],
          );
        }
        categoryId = Number(rawCategoryId);
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

      const includeTrashed = status === "trashed" || url.searchParams.get("includeTrashed") === "true";
      const result = await listCatalogOfferings(tenantDb, {
        offeringType,
        status,
        categoryId,
        includeTrashed,
        cursor,
        limit,
      });

      return catalogJsonResponse(200, result);
    }

    // POST /api/tenants/:tenantId/catalog
    const parsedBody = await parseStrictCatalogJsonBody(
      request,
      CREATE_OFFERING_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const created = await createCatalogOffering(tenantDb, parsedBody.body, {
      nowMs: options.nowMs,
    });
    return catalogJsonResponse(201, created);
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogCollectionRequest(params.tenantId ?? "", request, buildCatalogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
