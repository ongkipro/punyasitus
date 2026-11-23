import { getCatalogOfferingById } from "@punyasitus/db/catalog/index";
import { trashContentItem } from "@punyasitus/db/trash/index";
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
 * `POST /api/tenants/:tenantId/catalog/:offeringId/trash`
 * Moves a catalog offering to 30-day trash, unpublishes atomically, records audit (`WHERE changes() = 1`),
 * and bumps `tenants.cache_version` (TASK-044; REQ-012, REQ-034, REQ-036, REQ-048).
 */

const TRASH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantCatalogTrashRequest(
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
      "Gunakan POST untuk memindahkan penawaran katalog ke sampah.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantCatalogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:write",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const offeringId = parseSequentialPathId(rawOfferingId);
  if (offeringId === null) {
    return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
  }

  const parsedBody = await parseStrictCatalogJsonBody(request, TRASH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
    required: true,
  });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const result = await trashContentItem(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "offering",
      resourceId: offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getCatalogOfferingById(tenantDb, offeringId, { includeTrashed: true });
    if (!reloaded) {
      return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
    }

    return catalogJsonResponse(200, {
      ...reloaded,
      ...(result.cacheVersion !== null ? { cacheVersion: result.cacheVersion } : {}),
      trashMeta: {
        deletedAt: result.deletedAt,
        purgeEligibleAt: result.purgeEligibleAt,
        daysRemaining: result.daysRemaining,
      },
    });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogTrashRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
