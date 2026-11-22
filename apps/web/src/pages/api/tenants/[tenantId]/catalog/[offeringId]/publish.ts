import { publishCatalogOffering } from "@punyasitus/db/catalog/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantCatalogRequest,
  buildCatalogRuntimeEnv,
  catalogErrorResponse,
  catalogJsonResponse,
  createRequestId,
  extractCatalogExpectedVersion,
  mapCatalogDomainErrorToResponse,
  parseSequentialPathId,
  parseStrictCatalogJsonBody,
  type TenantCatalogHandlerOptions,
  type TenantCatalogRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped catalog offering publish endpoint:
 * - `POST /api/tenants/:tenantId/catalog/:offeringId/publish`
 *
 * Atomically validates & publishes the offering snapshot via `publishResourceAtomically`
 * and bumps `PLATFORM_DB.tenants.cache_version` (TASK-009, REQ-012, REQ-036).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmSlugChange"]);

export async function handleTenantCatalogOfferingPublishRequest(
  tenantId: string,
  rawOfferingId: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
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
      "Metode HTTP harus POST untuk mempublikasikan penawaran.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantCatalogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:publish",
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
    const parsedBody = await parseStrictCatalogJsonBody(request, PUBLISH_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    if (
      parsedBody.body.confirmSlugChange !== undefined &&
      typeof parsedBody.body.confirmSlugChange !== "boolean"
    ) {
      return catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "confirmSlugChange harus berupa boolean.",
        requestId,
        [{ field: "confirmSlugChange", code: "INVALID_PAYLOAD", message: "Expected a boolean." }],
      );
    }

    const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
      required: true,
    });
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const result = await publishCatalogOffering(platformDb, tenantDb, {
      tenantId: member.tenantId,
      offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      actorUserId: member.userId,
      nowMs: options.nowMs,
    });

    return catalogJsonResponse(200, {
      ...result.offering,
      cacheVersion: result.cacheVersion,
      revisionNumber: result.revisionNumber,
    });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogOfferingPublishRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
