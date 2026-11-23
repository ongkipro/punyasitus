import { recordExternalVerificationCheck } from "@punyasitus/db/seo/index";
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
 * Record Manual External Webmaster Verification Check (`TASK-052`, `REQ-055`, `PLAN §15.5`):
 * - `POST /api/tenants/:tenantId/seo/verification-check`
 *
 * Explicitly separates local token configuration (`configured`) from human-confirmed
 * external webmaster verification (`externally_verified`), bound to the tenant's current
 * verified primary hostname so primary-domain switches invalidate prior host verification.
 */

export async function handleTenantSeoVerificationCheckRequest(
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
    return seoErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST untuk mencatat hasil verifikasi eksternal.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantSeoRequest(tenantId, request, runtimeEnv, "settings:write", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const parsedBody = await parseStrictSeoJsonBody(request, requestId);
  if (!parsedBody.ok) return parsedBody.response;

  const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
  if (!versionCheck.ok) return versionCheck.response;

  try {
    const settings = await recordExternalVerificationCheck(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      {
        tenantId: auth.ctx.member.tenantId,
        payload: parsedBody.body,
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
  handleTenantSeoVerificationCheckRequest(params.tenantId ?? "", request, buildSeoRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
