import {
  GTM_TEMPLATE_FILENAME,
  serializeGtmContainerTemplateJson,
} from "@punyasitus/core/analytics/gtm-template";
import type { APIRoute } from "astro";
import {
  analyticsErrorResponse,
  authorizeTenantAnalyticsRequest,
  buildAnalyticsRuntimeEnv,
  createRequestId,
  type TenantAnalyticsHandlerOptions,
  type TenantAnalyticsRuntimeEnv,
} from "../_shared.ts";

/**
 * Downloadable Ready-to-Import Google Tag Manager Container Template JSON endpoint
 * (`GET /api/tenants/:tenantId/analytics/gtm/template`; TASK-076, REQ-027, PLAN §18.1).
 */
export async function handleTenantGtmTemplateDownloadRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAnalyticsRuntimeEnv,
  options: TenantAnalyticsHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();
  const method = request.method.toUpperCase();

  const auth = await authorizeTenantAnalyticsRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:read",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return analyticsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk unduhan template GTM.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const jsonBody = serializeGtmContainerTemplateJson();
  return new Response(jsonBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${GTM_TEMPLATE_FILENAME}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      Vary: "Cookie",
    },
  });
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantGtmTemplateDownloadRequest(params.tenantId ?? "", request, buildAnalyticsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
