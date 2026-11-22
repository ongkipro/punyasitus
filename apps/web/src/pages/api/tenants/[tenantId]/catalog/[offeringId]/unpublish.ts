import { unpublishCatalogOffering } from "@punyasitus/db/catalog/index";
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
 * Tenant-scoped catalog offering unpublish endpoint:
 * - `POST /api/tenants/:tenantId/catalog/:offeringId/unpublish`
 *
 * Atomically transitions the offering back to `draft` via `unpublishResourceAtomically`
 * and invalidates tenant caches by bumping `PLATFORM_DB.tenants.cache_version` (TASK-009).
 */

const UNPUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantCatalogOfferingUnpublishRequest(
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
      "Metode HTTP harus POST untuk membatalkan publikasi penawaran.",
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
    const parsedBody = await parseStrictCatalogJsonBody(request, UNPUBLISH_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
      required: true,
    });
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const result = await unpublishCatalogOffering(platformDb, tenantDb, {
      tenantId: member.tenantId,
      offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      nowMs: options.nowMs,
    });

    return catalogJsonResponse(200, {
      ...result.offering,
      cacheVersion: result.cacheVersion,
      unpublishedAt: new Date(result.unpublishedAt).toISOString(),
    });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogOfferingUnpublishRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
