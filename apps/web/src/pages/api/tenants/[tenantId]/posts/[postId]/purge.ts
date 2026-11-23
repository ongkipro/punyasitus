import { purgeContentItem } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST | DELETE /api/tenants/:tenantId/posts/:postId/purge`
 * Permanently deletes a trashed blog post after explicit confirmation (`confirmPermanentDelete: true`).
 *
 * Security & R3 invariants (TASK-044, REQ-048, PLAN §11.5):
 * - Owner/Admin/Agency Admin ONLY (`editor` receives `403 FORBIDDEN`).
 * - Locked tenant receives `403 SUBSCRIPTION_LOCKED`.
 * - Non-member / cross-tenant receives neutral `404 NOT_FOUND`.
 * - Protected navigation menu references block with `409 CONFLICT` (`PROTECTED_REFERENCE`).
 * - Atomically clears `post_taxonomies`, `resource_slugs`, & `content_revisions` while preserving shared media.
 */

const PURGE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmPermanentDelete"]);
const PURGE_ALLOWED_ROLES = new Set(["owner", "admin", "agency_admin"]);

export async function handleTenantPostPurgeRequest(
  tenantId: string,
  rawPostId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "POST" && method !== "DELETE") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST atau DELETE untuk menghapus permanen artikel dari sampah.",
      requestId,
      undefined,
      { Allow: "POST, DELETE" },
    );
  }

  const auth = await authorizeTenantBlogRequest(
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
    return blogErrorResponse(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs atau admin yang dapat menghapus artikel secara permanen.",
      requestId,
    );
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictBlogJsonBody(request, PURGE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractBlogExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (parsedBody.body.confirmPermanentDelete !== true) {
    return blogErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Konfirmasi eksplisit (confirmPermanentDelete: true) wajib dikirim sebelum penghapusan permanen.",
      requestId,
      [
        {
          field: "confirmPermanentDelete",
          code: "CONFIRMATION_REQUIRED",
          message: "Explicit confirmPermanentDelete: true is required to permanently purge a post.",
        },
      ],
    );
  }

  try {
    const result = await purgeContentItem(tenantDb, {
      resourceType: "post",
      resourceId: parsedId.id,
      expectedVersion: versionCheck.expectedVersion!,
      source: "manual_purge",
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return blogJsonResponse(200, result);
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostPurgeRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
