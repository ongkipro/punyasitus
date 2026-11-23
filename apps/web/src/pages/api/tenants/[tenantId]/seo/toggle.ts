import { setSeoAutopilotEnabledForTenant } from "@punyasitus/db/seo/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantSeoRequest,
  buildSeoRuntimeEnv,
  createSeoRequestId,
  mapSeoDomainErrorToResponse,
  parseStrictSeoJsonBody,
  seoErrorResponse,
  seoJsonResponse,
  type TenantSeoHandlerOptions,
  type TenantSeoRuntimeEnv,
} from "./_shared.ts";

/**
 * Toggle `seo-ai-autopilot` Plugin Active State (`TASK-052`, `DEC-039`, `REQ-066`):
 * - `POST /api/tenants/:tenantId/seo/toggle` (`{ enabled: boolean }`)
 *
 * Owner/Admin only (`editor` -> 403; `locked` -> 403 SUBSCRIPTION_LOCKED).
 * Disabling preserves all saved SEO templates, verification tokens, and per-page overrides.
 */

const TOGGLE_ALLOWED_KEYS = new Set(["enabled"]);

export async function handleTenantSeoToggleRequest(
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
      "Gunakan metode POST untuk mengubah status plugin SEO & AI Autopilot.",
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

  for (const key of Object.keys(parsedBody.body)) {
    if (!TOGGLE_ALLOWED_KEYS.has(key)) {
      return seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${key}" tidak dikenali.`,
        requestId,
        [{ field: key, code: "UNRECOGNIZED_KEY", message: `Unknown field "${key}".` }],
      );
    }
  }

  if (typeof parsedBody.body.enabled !== "boolean") {
    return seoErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field enabled wajib berupa boolean.",
      requestId,
      [{ field: "enabled", code: "INVALID_TYPE", message: "enabled must be boolean." }],
    );
  }

  try {
    const result = await setSeoAutopilotEnabledForTenant(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      {
        tenantId: auth.ctx.member.tenantId,
        enabled: parsedBody.body.enabled,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        nowMs: options.nowMs,
      },
    );
    return seoJsonResponse(200, {
      pluginId: "seo-ai-autopilot",
      enabled: result.enabled,
      requestId,
    });
  } catch (err) {
    return mapSeoDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSeoToggleRequest(params.tenantId ?? "", request, buildSeoRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
