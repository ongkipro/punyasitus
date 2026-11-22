import { restorePage } from "@punyasitus/db/pages/index";
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
 * Restores a trashed page back to `draft` state only (OpenAPI `tenantRestorePage`).
 *
 * TASK-005 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-061`).
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

  const { tenantDb } = auth.ctx;

  try {
    const restored = await restorePage(tenantDb, {
      pageId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      ...(parsedBody.body.resolvedSlug !== undefined
        ? { resolvedSlug: parsedBody.body.resolvedSlug as string }
        : {}),
      nowMs: options.nowMs,
    });

    return pageJsonResponse(200, formatPageRecordResponse(restored));
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
