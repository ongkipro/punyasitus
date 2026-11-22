import { publishPage } from "@punyasitus/db/pages/index";
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
 * `POST /api/tenants/:tenantId/pages/:pageId/publish`
 * Atomically publishes a page draft snapshot and bumps `PLATFORM_DB.tenants.cache_version`.
 *
 * TASK-005 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion", "confirmSlugChange"]);

export async function handleTenantPagePublishRequest(
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
      "Gunakan POST untuk mempublikasikan halaman.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantPageRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const parsedBody = await parseStrictPageJsonBody(request, PUBLISH_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId, { required: true });
  if (!versionCheck.ok) {
    return versionCheck.response;
  }

  if (
    parsedBody.body.confirmSlugChange !== undefined &&
    typeof parsedBody.body.confirmSlugChange !== "boolean"
  ) {
    return pageErrorResponse(
      422,
      "VALIDATION_ERROR",
      "confirmSlugChange harus berupa boolean.",
      requestId,
      [
        {
          field: "confirmSlugChange",
          code: "INVALID_TYPE",
          message: "Expected a boolean for confirmSlugChange.",
        },
      ],
    );
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const result = await publishPage(platformDb, tenantDb, {
      tenantId: member.tenantId,
      pageId: parsedId.pageId,
      expectedVersion: versionCheck.expectedVersion!,
      confirmSlugChange: parsedBody.body.confirmSlugChange as boolean | undefined,
      actorUserId: member.userId,
      nowMs: options.nowMs,
    });

    return pageJsonResponse(200, {
      ...formatPageRecordResponse(result.page),
      cacheVersion: result.cacheVersion,
      revisionNumber: result.revisionNumber,
    });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagePublishRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
