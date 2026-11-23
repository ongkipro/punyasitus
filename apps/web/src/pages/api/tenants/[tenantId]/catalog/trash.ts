import { isCatalogOfferingType, type CatalogOfferingType } from "@punyasitus/core/catalog/index";
import { listTrashedContentByType } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantCatalogRequest,
  buildCatalogRuntimeEnv,
  catalogErrorResponse,
  catalogJsonResponse,
  createRequestId,
  mapCatalogDomainErrorToResponse,
  type TenantCatalogHandlerOptions,
  type TenantCatalogRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/catalog/trash`
 * Lists trashed catalog offerings enriched with 30-day retention countdown,
 * protected references, and media reference inspection reports (TASK-044, REQ-048).
 */

export async function handleTenantCatalogTrashListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET") {
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
      "Gunakan GET untuk melihat daftar sampah katalog.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantCatalogRequest(tenantId, request, runtimeEnv, "content:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

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

  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^[1-9]\d{0,2}$/.test(rawLimit.trim()) || Number(rawLimit.trim()) > 100) {
      return catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter limit harus antara 1 hingga 100.",
        requestId,
        [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100." }],
      );
    }
    limit = Number(rawLimit.trim());
  }

  try {
    const items = await listTrashedContentByType(auth.ctx.tenantDb, "offering", {
      offeringType,
      limit,
      nowMs: options.nowMs,
    });
    return catalogJsonResponse(200, { items });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogTrashListRequest(params.tenantId ?? "", request, buildCatalogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
