import { OFFERING_WRITE_ALLOWED_KEYS } from "@punyasitus/core/catalog/index";
import {
  getCatalogOfferingById,
  updateCatalogOffering,
} from "@punyasitus/db/catalog/index";
import { trashContentItem } from "@punyasitus/db/trash/index";
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
 * Tenant-scoped single catalog offering endpoint:
 * - `GET    /api/tenants/:tenantId/catalog/:offeringId` -> read offering by sequential ID
 * - `PATCH  /api/tenants/:tenantId/catalog/:offeringId` -> save draft edits with OCC (`409` on stale)
 * - `DELETE /api/tenants/:tenantId/catalog/:offeringId` -> soft-delete offering to trash (`204`)
 *
 * Matches OpenAPI `tenantUpdateOffering` + CRUD contract (TASK-009).
 */

const DELETE_OFFERING_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantCatalogOfferingRequest(
  tenantId: string,
  rawOfferingId: string,
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
      "Metode HTTP tidak diizinkan untuk endpoint penawaran katalog.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
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

  const offeringId = parseSequentialPathId(rawOfferingId);
  if (offeringId === null) {
    return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const offering = await getCatalogOfferingById(tenantDb, offeringId);
      if (!offering) {
        return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
      }
      return catalogJsonResponse(200, offering);
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictCatalogJsonBody(
        request,
        OFFERING_WRITE_ALLOWED_KEYS,
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

      const updated = await updateCatalogOffering(tenantDb, offeringId, parsedBody.body, {
        expectedVersion: versionCheck.expectedVersion!,
        nowMs: options.nowMs,
      });
      return catalogJsonResponse(200, updated);
    }

    // DELETE /api/tenants/:tenantId/catalog/:offeringId
    const parsedBody = await parseStrictCatalogJsonBody(
      request,
      DELETE_OFFERING_ALLOWED_KEYS,
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

    if (expectedVersion === undefined) {
      return catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version atau expectedVersion wajib diisi saat menghapus penawaran.",
        requestId,
        [
          {
            field: "version",
            code: "INVALID_VERSION",
            message: "Optimistic concurrency version is required to delete an offering.",
          },
        ],
      );
    }

    await trashContentItem(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "offering",
      resourceId: offeringId,
      expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });
    return catalogNoContentResponse();
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogOfferingRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
