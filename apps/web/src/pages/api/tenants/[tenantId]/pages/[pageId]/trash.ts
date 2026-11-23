import { getPageById } from "@punyasitus/db/pages/index";
import { trashContentItem } from "@punyasitus/db/trash/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  extractPageExpectedVersion,
  formatPageRecordResponse,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parsePageIdParam,
  parseStrictPageJsonBody,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/pages/:pageId/trash`
 * Moves a page to 30-day trash, unpublishes atomically, records audit (`WHERE changes() = 1`),
 * and bumps `tenants.cache_version` (TASK-005 & TASK-044; REQ-008, REQ-034, REQ-036, REQ-048).
 */

const TRASH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantPageTrashRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST untuk memindahkan halaman ke sampah.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

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

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictPageJsonBody(request, TRASH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const result = await trashContentItem(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "page",
      resourceId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getPageById(tenantDb, parsedId.pageId, { includeTrashed: true });
    if (!reloaded) {
      return pageErrorResponse(404, "NOT_FOUND", `Halaman #${parsedId.pageId} tidak ditemukan.`, requestId);
    }

    return pageJsonResponse(200, {
      ...formatPageRecordResponse(reloaded),
      ...(result.cacheVersion !== null ? { cacheVersion: result.cacheVersion } : {}),
      trashMeta: {
        deletedAt: result.deletedAt,
        purgeEligibleAt: result.purgeEligibleAt,
        daysRemaining: result.daysRemaining,
      },
    });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPageTrashRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
