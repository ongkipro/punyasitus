import { parseRevisionId, restoreContentRevision } from "@punyasitus/db/revisions/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantRevisionRequest,
  buildRevisionsRuntimeEnv,
  createRevisionRequestId,
  extractRevisionExpectedVersion,
  mapRevisionDomainErrorToResponse,
  parseStrictRevisionJsonBody,
  revisionErrorResponse,
  revisionJsonResponse,
  type TenantRevisionsHandlerOptions,
  type TenantRevisionsRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/revisions/:revisionId/restore`
 *
 * Restores a historical revision strictly into DRAFT state ONLY:
 * - ZERO public change until explicit Publish (`published_*_json` & `cache_version` untouched).
 * - Enforces CSRF/Origin (`403`), tenant isolation (cross-tenant `404`), RBAC (`content:write` -> `403`),
 *   lifecycle lock (`locked`/`suspended` -> `403 SUBSCRIPTION_LOCKED`), optimistic concurrency
 *   (`expectedVersion` -> `409 STALE_VERSION`), and snapshot schema/reference validation (`422`).
 *
 * TASK-064 (`REQ-048`, `REQ-034`, `REQ-036`).
 */

const RESTORE_REVISION_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "version",
  "detachMissingReferences",
]);

export async function handleTenantRevisionRestoreRequest(
  tenantId: string,
  rawRevisionId: string,
  request: Request,
  runtimeEnv: TenantRevisionsRuntimeEnv,
  options: TenantRevisionsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRevisionRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantRevisionRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return revisionErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan POST untuk memulihkan revisi konten sebagai draf.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantRevisionRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:write",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseRevisionId(rawRevisionId);
  if (!parsedId) {
    return revisionErrorResponse(404, "NOT_FOUND", "Revisi konten tidak ditemukan.", requestId);
  }

  const parsedBody = await parseStrictRevisionJsonBody(
    request,
    RESTORE_REVISION_ALLOWED_KEYS,
    requestId,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractRevisionExpectedVersion(parsedBody.body, requestId);
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  const rawDetach = parsedBody.body.detachMissingReferences;
  if (rawDetach !== undefined && typeof rawDetach !== "boolean") {
    return revisionErrorResponse(
      422,
      "VALIDATION_ERROR",
      "detachMissingReferences harus berupa boolean.",
      requestId,
      [
        {
          field: "detachMissingReferences",
          code: "INVALID_TYPE",
          message: "Expected a boolean for detachMissingReferences.",
        },
      ],
    );
  }

  try {
    const result = await restoreContentRevision(auth.ctx.tenantDb, {
      resourceType: parsedId.resourceType,
      resourceId: parsedId.resourceId,
      revisionNumber: parsedId.revisionNumber,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
      detachMissingReferences: rawDetach ?? true,
      nowMs: options.nowMs,
    });

    return revisionJsonResponse(200, result);
  } catch (err) {
    return mapRevisionDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantRevisionRestoreRequest(
    params.tenantId ?? "",
    params.revisionId ?? "",
    request,
    buildRevisionsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
