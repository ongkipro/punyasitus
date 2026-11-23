import { purgeContentItem } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  extractPageExpectedVersion,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parsePageIdParam,
  parseStrictPageJsonBody,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST | DELETE /api/tenants/:tenantId/pages/:pageId/purge`
 * Permanently deletes a trashed page after explicit confirmation (`confirmPermanentDelete: true`).
 *
 * Security & R3 invariants (TASK-044, REQ-048, PLAN §11.5):
 * - Owner/Admin/Agency Admin ONLY (`editor` receives `403 FORBIDDEN`).
 * - Locked tenant receives `403 SUBSCRIPTION_LOCKED`.
 * - Non-member / cross-tenant receives neutral `404 NOT_FOUND`.
 * - Protected homepage / policy / navigation menu references block with `409 CONFLICT`
 *   (`PROTECTED_REFERENCE`) and structured `protectedReferences`.
 * - Atomically clears `resource_slugs` & `content_revisions` while preserving shared media.
 */

const PURGE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmPermanentDelete"]);
const PURGE_ALLOWED_ROLES = new Set(["owner", "admin", "agency_admin"]);

export async function handleTenantPagePurgeRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST" && method !== "DELETE") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST atau DELETE untuk menghapus permanen halaman dari sampah.",
      requestId,
      undefined,
      { Allow: "POST, DELETE" },
    );
  }

  // First enforces app host, CSRF, session, membership (404), and tenant lifecycle lock (403 SUBSCRIPTION_LOCKED)
  const auth = await authorizeTenantPageRequest(
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
    return pageErrorResponse(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs atau admin yang dapat menghapus halaman secara permanen.",
      requestId,
    );
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictPageJsonBody(request, PURGE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (parsedBody.body.confirmPermanentDelete !== true) {
    return pageErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Konfirmasi eksplisit (confirmPermanentDelete: true) wajib dikirim sebelum penghapusan permanen.",
      requestId,
      [
        {
          field: "confirmPermanentDelete",
          code: "CONFIRMATION_REQUIRED",
          message: "Explicit confirmPermanentDelete: true is required to permanently purge a page.",
        },
      ],
    );
  }

  try {
    const result = await purgeContentItem(tenantDb, {
      resourceType: "page",
      resourceId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      source: "manual_purge",
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return pageJsonResponse(200, result);
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagePurgeRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
