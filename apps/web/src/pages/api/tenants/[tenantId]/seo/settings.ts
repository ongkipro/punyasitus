import {
  getTenantSeoEditorSettings,
  saveTenantSeoEditorSettingsDraft,
} from "@punyasitus/db/seo/index";
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
 * Global Tenant SEO Editor Settings Endpoint (`TASK-052`, `REQ-053`, `REQ-055`):
 * - `GET   /api/tenants/:tenantId/seo/settings`: Reads draft & published search appearance templates,
 *   webmaster verification tokens, configured-vs-externally-verified status, and GBP/Bing copy data.
 * - `PATCH /api/tenants/:tenantId/seo/settings`: Saves draft template & verification token edits
 *   (Owner/Admin only; Editor -> 403; atomic OCC `version`/`expectedVersion` -> 409 on stale write).
 */

export async function handleTenantSeoSettingsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantSeoRuntimeEnv,
  options: TenantSeoHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createSeoRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantSeoRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return seoErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, undefined, {
      Allow: "GET, PATCH",
    });
  }

  const requiredPermission = method === "GET" ? "content:read" : "settings:write";
  const auth = await authorizeTenantSeoRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { member, platformDb, tenantDb, saasZone } = auth.ctx;

  try {
    if (method === "GET") {
      const settings = await getTenantSeoEditorSettings(platformDb, tenantDb, member.tenantId, {
        saasZone,
        nowMs: options.nowMs,
      });
      return seoJsonResponse(200, { settings, requestId });
    }

    const parsedBody = await parseStrictSeoJsonBody(request, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const settings = await saveTenantSeoEditorSettingsDraft(platformDb, tenantDb, {
      tenantId: member.tenantId,
      patch: parsedBody.body,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      saasZone,
      nowMs: options.nowMs,
    });

    return seoJsonResponse(200, { settings, requestId });
  } catch (err) {
    return mapSeoDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSeoSettingsRequest(params.tenantId ?? "", request, buildSeoRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
