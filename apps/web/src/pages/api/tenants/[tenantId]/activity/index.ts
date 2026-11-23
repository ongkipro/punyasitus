import {
  ActivityLogError,
  listTenantActivityLog,
} from "@punyasitus/db/activity-log/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantLeadRequest,
  buildLeadsRuntimeEnv,
  createRequestId,
  leadErrorResponse,
  leadJsonResponse,
  type TenantLeadsHandlerOptions,
  type TenantLeadsRuntimeEnv,
} from "../leads/_shared.ts";

/**
 * Tenant-scoped Read-Only Activity Log API:
 * - `GET /api/tenants/:tenantId/activity` -> paginated, redacted read-only tenant activity log
 *
 * Security & RBAC invariants (REQ-094, REQ-039; PLAN §4, §5.2, §17.1; TASK-094):
 * - Served ONLY on `app.punyasitus.com` (`404` on tenant/marketing/console hosts).
 * - Requires `"settings:read"` permission (`owner`, `admin`, `agency_admin` allowed;
 *   `editor` gets `403 FORBIDDEN`; foreign tenant / non-member gets `404 NOT_FOUND`).
 * - Allowed in read-only `locked` state; blocked in `suspended` (`403 SUBSCRIPTION_LOCKED`).
 * - Strictly read-only (`POST`/`PATCH`/`PUT`/`DELETE` -> `405` with `Allow: GET`).
 * - Defense-in-depth read-side redaction ensures zero raw visitor PII, tokens, or secrets leak.
 */

export async function handleTenantActivityLogRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantLeadRequest(tenantId, request, runtimeEnv, "settings:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return leadErrorResponse(
      405,
      "BAD_REQUEST",
      "Log aktivitas tenant bersifat hanya baca. Gunakan metode GET.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? undefined;
  const resourceType = url.searchParams.get("resourceType") ?? undefined;
  const actorRole = url.searchParams.get("actorRole") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : undefined;

  try {
    const result = await listTenantActivityLog(auth.ctx.tenantDb, {
      action,
      resourceType,
      actorRole,
      cursor,
      limit,
    });

    return leadJsonResponse(200, {
      items: result.items,
      totalCount: result.totalCount,
      page: result.page,
      requestId,
    });
  } catch (err) {
    if (err instanceof ActivityLogError) {
      return leadErrorResponse(
        err.status,
        err.code,
        err.message,
        requestId,
        err.fields,
        err.status === 503 ? { "Retry-After": "60" } : undefined,
      );
    }
    return leadErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat log aktivitas situs.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantActivityLogRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
