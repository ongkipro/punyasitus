import { publishTenantSeoEditorSettings } from "@punyasitus/db/seo/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantSeoRequest,
  buildSeoRuntimeEnv,
  createSeoRequestId,
  extractRequiredExpectedVersion,
  mapSeoDomainErrorToResponse,
  parseStrictSeoJsonBody,
  seoErrorResponse,
  seoJsonResponse,
  type TenantSeoHandlerOptions,
  type TenantSeoRuntimeEnv,
} from "./_shared.ts";

/**
 * Publish Global SEO Editor Settings (`TASK-052`, `REQ-053`, `REQ-055`):
 * - `POST /api/tenants/:tenantId/seo/publish`: Atomically publishes draft search appearance
 *   templates and webmaster verification tokens, bumps `tenants.cache_version`, and logs audit.
 *   Owner/Admin only (`editor` -> 403; stale `version` -> 409).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantSeoPublishRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantSeoRuntimeEnv,
  options: TenantSeoHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createSeoRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantSeoRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return seoErrorResponse(405, "BAD_REQUEST", "Gunakan metode POST untuk menerbitkan pengaturan SEO.", requestId, undefined, {
      Allow: "POST",
    });
  }

  const auth = await authorizeTenantSeoRequest(tenantId, request, runtimeEnv, "settings:write", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await parseStrictSeoJsonBody(request, requestId);
  if (!parsedBody.ok) return parsedBody.response;

  for (const key of Object.keys(parsedBody.body)) {
    if (!PUBLISH_ALLOWED_KEYS.has(key)) {
      return seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${key}" tidak dikenali pada endpoint publikasi SEO.`,
        requestId,
        [{ field: key, code: "UNRECOGNIZED_KEY", message: `Unknown field "${key}".` }],
      );
    }
  }

  const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
  if (!versionCheck.ok) return versionCheck.response;

  try {
    const settings = await publishTenantSeoEditorSettings(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      {
        tenantId: auth.ctx.member.tenantId,
        expectedVersion: versionCheck.expectedVersion,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        saasZone: auth.ctx.saasZone,
        nowMs: options.nowMs,
      },
    );
    return seoJsonResponse(200, { settings, requestId });
  } catch (err) {
    return mapSeoDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSeoPublishRequest(params.tenantId ?? "", request, buildSeoRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
