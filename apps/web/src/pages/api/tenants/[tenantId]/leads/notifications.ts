import {
  getLeadNotificationSettings,
  updateLeadNotificationSettings,
} from "@punyasitus/db/leads/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantLeadRequest,
  buildLeadsRuntimeEnv,
  createRequestId,
  leadErrorResponse,
  leadJsonResponse,
  mapLeadDomainErrorToResponse,
  parseStrictLeadJsonBody,
  type TenantLeadsHandlerOptions,
  type TenantLeadsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Lead Email Notification Preference endpoint (`REQ-031`):
 * - `GET   /api/tenants/:tenantId/leads/notifications` -> read `{ emailEnabled }`
 * - `PATCH /api/tenants/:tenantId/leads/notifications` -> toggle `{ emailEnabled: boolean }`
 *   (owner/admin only; blocked on `locked`/`suspended`).
 */

const UPDATE_NOTIFICATION_ALLOWED_KEYS = new Set(["emailEnabled"]);

export async function handleTenantLeadNotificationsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantLeadRequest(tenantId, request, runtimeEnv, "lead:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return leadErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk pengaturan notifikasi pesan masuk.",
      requestId,
      undefined,
      { Allow: "GET, PATCH" },
    );
  }

  const requiredPermission = method === "GET" ? "lead:read" : "lead:update";
  const auth = await authorizeTenantLeadRequest(
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
      const settings = await getLeadNotificationSettings(tenantDb);
      return leadJsonResponse(200, {
        emailEnabled: settings.emailEnabled,
        updatedAt: settings.updatedAtMs ? new Date(settings.updatedAtMs).toISOString() : null,
      });
    }

    const parsed = await parseStrictLeadJsonBody(
      request,
      UPDATE_NOTIFICATION_ALLOWED_KEYS,
      requestId,
    );
    if (!parsed.ok) return parsed.response;

    if (typeof parsed.body.emailEnabled !== "boolean") {
      return leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field emailEnabled wajib berupa nilai boolean (true/false).",
        requestId,
        [{ field: "emailEnabled", code: "INVALID_BOOLEAN", message: "emailEnabled must be a boolean." }],
      );
    }

    const updated = await updateLeadNotificationSettings(tenantDb, {
      emailEnabled: parsed.body.emailEnabled,
      updatedBy: member.userId,
      nowMs: options.nowMs,
    });

    return leadJsonResponse(200, {
      emailEnabled: updated.emailEnabled,
      updatedAt: updated.updatedAtMs ? new Date(updated.updatedAtMs).toISOString() : null,
    });
  } catch (err) {
    return mapLeadDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadNotificationsRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
