import {
  getTenantAnalyticsSettings,
  updateTenantAnalyticsSettings,
} from "@punyasitus/db/analytics-settings/index";
import type { APIRoute } from "astro";
import {
  analyticsErrorResponse,
  analyticsJsonResponse,
  authorizeTenantAnalyticsRequest,
  buildAnalyticsRuntimeEnv,
  createRequestId,
  extractRequiredExpectedVersion,
  mapAnalyticsDomainErrorToResponse,
  parseStrictAnalyticsJsonBody,
  type TenantAnalyticsHandlerOptions,
  type TenantAnalyticsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Direct Analytics Settings endpoint (`TASK-022`, `REQ-027`, `REQ-039`):
 * - `GET   /api/tenants/:tenantId/analytics` -> read current GA4/Meta/TikTok IDs + version (Owner/Admin/Editor)
 * - `PATCH /api/tenants/:tenantId/analytics` -> update direct GA4/Meta/TikTok IDs with OCC `expectedVersion` (Owner/Admin only)
 */

const PATCH_ANALYTICS_ALLOWED_KEYS = new Set([
  "ga4MeasurementId",
  "metaPixelId",
  "tiktokPixelId",
  "expectedVersion",
]);

export async function handleTenantAnalyticsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAnalyticsRuntimeEnv,
  options: TenantAnalyticsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantAnalyticsRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return analyticsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk pengaturan analitik.",
      requestId,
      undefined,
      { Allow: "GET, PATCH" },
    );
  }

  // Owner & Admin may mutate (`settings:write`); Editor denied with `403 FORBIDDEN`.
  // Locked/suspended tenants denied with `403 SUBSCRIPTION_LOCKED` on PATCH.
  const requiredPermission = method === "GET" ? "content:read" : "settings:write";
  const auth = await authorizeTenantAnalyticsRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { tenantDb, member } = auth.ctx;

  try {
    if (method === "GET") {
      const settings = await getTenantAnalyticsSettings(tenantDb);
      return analyticsJsonResponse(200, {
        ga4MeasurementId: settings.ga4MeasurementId,
        metaPixelId: settings.metaPixelId,
        tiktokPixelId: settings.tiktokPixelId,
        version: settings.version,
        updatedAt: settings.updatedAt,
      });
    }

    const parsedBody = await parseStrictAnalyticsJsonBody(
      request,
      PATCH_ANALYTICS_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const patch: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(parsedBody.body, "ga4MeasurementId")) {
      patch.ga4MeasurementId = parsedBody.body.ga4MeasurementId;
    }
    if (Object.prototype.hasOwnProperty.call(parsedBody.body, "metaPixelId")) {
      patch.metaPixelId = parsedBody.body.metaPixelId;
    }
    if (Object.prototype.hasOwnProperty.call(parsedBody.body, "tiktokPixelId")) {
      patch.tiktokPixelId = parsedBody.body.tiktokPixelId;
    }

    const updated = await updateTenantAnalyticsSettings(tenantDb, {
      patch,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return analyticsJsonResponse(200, {
      ga4MeasurementId: updated.ga4MeasurementId,
      metaPixelId: updated.metaPixelId,
      tiktokPixelId: updated.tiktokPixelId,
      version: updated.version,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    return mapAnalyticsDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantAnalyticsRequest(params.tenantId ?? "", request, buildAnalyticsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
