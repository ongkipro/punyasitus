import { purgeContentItem } from "@punyasitus/db/trash/index";
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
 * `POST | DELETE /api/tenants/:tenantId/catalog/:offeringId/purge`
 * Permanently deletes a trashed catalog offering after explicit confirmation (`confirmPermanentDelete: true`).
 *
 * Security & R3 invariants (TASK-044, REQ-048, PLAN §11.5):
 * - Owner/Admin/Agency Admin ONLY (`editor` receives `403 FORBIDDEN`).
 * - Locked tenant receives `403 SUBSCRIPTION_LOCKED`.
 * - Non-member / cross-tenant receives neutral `404 NOT_FOUND`.
 * - Protected navigation menu references block with `409 CONFLICT` (`PROTECTED_REFERENCE`).
 * - Atomically clears `offering_taxonomies`, `resource_slugs`, & `content_revisions` while preserving shared media.
 */

const PURGE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmPermanentDelete"]);
const PURGE_ALLOWED_ROLES = new Set(["owner", "admin", "agency_admin"]);

export async function handleTenantCatalogPurgeRequest(
  tenantId: string,
  rawOfferingId: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  options: TenantCatalogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST" && method !== "DELETE") {
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
      "Gunakan POST atau DELETE untuk menghapus permanen penawaran katalog dari sampah.",
      requestId,
      undefined,
      { Allow: "POST, DELETE" },
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

  const { member, tenantDb } = auth.ctx;
  if (!PURGE_ALLOWED_ROLES.has(member.role)) {
    return catalogErrorResponse(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs atau admin yang dapat menghapus penawaran katalog secara permanen.",
      requestId,
    );
  }

  const offeringId = parseSequentialPathId(rawOfferingId);
  if (offeringId === null) {
    return catalogErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
  }

  const parsedBody = await parseStrictCatalogJsonBody(request, PURGE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractCatalogExpectedVersion(parsedBody.body, requestId, {
    required: true,
  });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (parsedBody.body.confirmPermanentDelete !== true) {
    return catalogErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Konfirmasi eksplisit (confirmPermanentDelete: true) wajib dikirim sebelum penghapusan permanen.",
      requestId,
      [
        {
          field: "confirmPermanentDelete",
          code: "CONFIRMATION_REQUIRED",
          message: "Explicit confirmPermanentDelete: true is required to permanently purge an offering.",
        },
      ],
    );
  }

  try {
    const result = await purgeContentItem(tenantDb, {
      resourceType: "offering",
      resourceId: offeringId,
      expectedVersion: versionCheck.expectedVersion!,
      source: "manual_purge",
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return catalogJsonResponse(200, result);
  } catch (err) {
    return mapCatalogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantCatalogPurgeRequest(
    params.tenantId ?? "",
    params.offeringId ?? "",
    request,
    buildCatalogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
