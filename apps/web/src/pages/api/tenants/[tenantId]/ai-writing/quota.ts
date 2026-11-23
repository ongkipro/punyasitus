import { getAiWritingQuotaStatus, loadTenantVertical } from "@punyasitus/db/ai-usage/index";
import type { APIRoute } from "astro";
import {
  aiWritingErrorResponse,
  aiWritingJsonResponse,
  authorizeTenantAiWritingRequest,
  buildAiWritingRuntimeEnv,
  createAiWritingRequestId,
  type TenantAiWritingHandlerOptions,
  type TenantAiWritingRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/ai-writing/quota`
 * Returns the tenant's active trailing 30-day AI writing quota usage (DEC-028, REQ-075, TASK-074).
 */

export async function handleAiWritingQuotaRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAiWritingRuntimeEnv,
  options: TenantAiWritingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAiWritingRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantAiWritingRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return aiWritingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantAiWritingRequest(tenantId, request, runtimeEnv, "content:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const { member, platformDb, effectiveStatus } = auth.ctx;

  try {
    const [quota, vertical] = await Promise.all([
      getAiWritingQuotaStatus(platformDb, member.tenantId, {
        nowMs: options.nowMs,
        limit: options.quotaLimit,
      }),
      loadTenantVertical(platformDb, member.tenantId),
    ]);

    return aiWritingJsonResponse(200, {
      quota,
      vertical: vertical ?? "compro",
      canGenerate: effectiveStatus !== "locked" && quota.remaining > 0,
      providerLabel: "Cloudflare Workers AI",
      requestId,
    });
  } catch {
    return aiWritingErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat status kuota bantuan tulis AI.",
      requestId,
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAiWritingQuotaRequest(params.tenantId ?? "", request, buildAiWritingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
