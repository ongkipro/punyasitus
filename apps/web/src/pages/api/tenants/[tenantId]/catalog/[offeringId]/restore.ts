import { getCatalogOfferingById } from "@punyasitus/db/catalog/index";
import { restoreContentItem } from "@punyasitus/db/trash/index";
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
 * `POST /api/tenants/:tenantId/catalog/:offeringId/restore`
 * Restores a trashed catalog offering back to `draft` state ONLY (never auto-publishes),
 * validates `expectedVersion` (`409 STALE_VERSION`), checks slug/redirect collisions
 * (`409 CONFLICT` with `suggestedSlug` and optional `resolvedSlug` rename), and
 * inspects media references cleanly without corrupting draft data.
 *
 * TASK-044 (`REQ-012`, `REQ-034`, `REQ-036`, `REQ-048`, `REQ-061`).
 */

const RESTORE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "resolvedSlug"]);

export async function handleTenantCatalogRestoreRequest(
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
      "Gunakan POST untuk memulihkan penawaran katalog dari sampah.",
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

  const parsedBody = await parseStrictCatalogJsonBody(request, RESTORE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
    required: true,
  });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (
    parsedBody.body.resolvedSlug !== undefined &&
    typeof parsedBody.body.resolvedSlug !== "string"
  ) {
    return catalogErrorResponse(
      422,
      "VALIDATION_ERROR",
      "resolvedSlug harus berupa teks slug yang valid.",
      requestId,
      [{ field: "resolvedSlug", code: "INVALID_TYPE", message: "Expected a string for resolvedSlug." }],
    );
  }

  const { member, tenantDb } = auth.ctx;

  try {
    const result = await restoreContentItem(tenantDb, {
      resourceType: "offering",
      resourceId: offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      ...(parsedBody.body.resolvedSlug !== undefined
        ? { resolvedSlug: parsedBody.body.resolvedSlug as string }
        : {}),
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getCatalogOfferingById(tenantDb, offeringId);
    if (!reloaded) {
      return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
    }

    return catalogJsonResponse(200, {
      ...reloaded,
      slugChanged: result.slugChanged,
      previousSlug: result.previousSlug,
      mediaReferences: result.mediaReferences,
    });
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogRestoreRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
