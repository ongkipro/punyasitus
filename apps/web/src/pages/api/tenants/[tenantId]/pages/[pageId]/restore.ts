import { getPageById } from "@punyasitus/db/pages/index";
import { restoreContentItem } from "@punyasitus/db/trash/index";
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
 * `POST /api/tenants/:tenantId/pages/:pageId/restore`
 * Restores a trashed page back to `draft` state ONLY (never auto-publishes),
 * validates `expectedVersion` (`409 STALE_VERSION`), checks slug/redirect collisions
 * (`409 CONFLICT` with `suggestedSlug` and optional `resolvedSlug` rename), and
 * inspects media references cleanly without corrupting draft data.
 *
 * TASK-005 & TASK-044 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-048`, `REQ-061`).
 */

const RESTORE_ALLOWED_KEYS = new Set(["version", "expectedVersion", "resolvedSlug"]);

export async function handleTenantPageRestoreRequest(
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
      "Gunakan POST untuk memulihkan halaman dari sampah.",
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

  const parsedBody = await parseStrictPageJsonBody(request, RESTORE_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (
    parsedBody.body.resolvedSlug !== undefined &&
    typeof parsedBody.body.resolvedSlug !== "string"
  ) {
    return pageErrorResponse(
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
      resourceType: "page",
      resourceId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      ...(parsedBody.body.resolvedSlug !== undefined
        ? { resolvedSlug: parsedBody.body.resolvedSlug as string }
        : {}),
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const reloaded = await getPageById(tenantDb, parsedId.pageId);
    if (!reloaded) {
      return pageErrorResponse(404, "NOT_FOUND", `Halaman #${parsedId.pageId} tidak ditemukan.`, requestId);
    }

    return pageJsonResponse(200, {
      ...formatPageRecordResponse(reloaded),
      slugChanged: result.slugChanged,
      previousSlug: result.previousSlug,
      homepageDemoted: result.homepageDemoted,
      mediaReferences: result.mediaReferences,
    });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPageRestoreRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
