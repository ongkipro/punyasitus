import {
  getLeadNotificationSettings,
  listLeads,
  type LeadStatus,
} from "@punyasitus/db/leads/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantLeadRequest,
  buildLeadsRuntimeEnv,
  createRequestId,
  formatLeadRecordResponse,
  leadErrorResponse,
  leadJsonResponse,
  mapLeadDomainErrorToResponse,
  type TenantLeadsHandlerOptions,
  type TenantLeadsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Lead Inbox collection endpoint:
 * - `GET /api/tenants/:tenantId/leads` -> filter by `status`, search by `q`/`search`, cursor pagination.
 *
 * TASK-021 (`REQ-031`, `REQ-032`, `REQ-038`, `REQ-039`).
 */

const ALLOWED_STATUS_FILTERS = new Set(["all", "new", "contacted", "closed"]);

export async function handleTenantLeadsListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantLeadRequest(tenantId, request, runtimeEnv, "lead:read", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return leadErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk daftar pesan masuk.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const { tenantDb, primaryOrigin } = auth.ctx;

  try {
    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status")?.trim().toLowerCase() || "all";
    if (!ALLOWED_STATUS_FILTERS.has(rawStatus)) {
      return leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Parameter status harus salah satu dari "all", "new", "contacted", atau "closed".',
        requestId,
        [{ field: "status", code: "INVALID_STATUS_FILTER", message: "Unsupported status filter." }],
      );
    }

    const rawLimit = url.searchParams.get("limit");
    let limit = 20;
    if (rawLimit !== null && rawLimit.trim() !== "") {
      if (!/^\d+$/.test(rawLimit.trim())) {
        return leadErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Parameter limit harus berupa bilangan bulat antara 1 hingga 100.",
          requestId,
          [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100." }],
        );
      }
      const parsedLimit = Number(rawLimit.trim());
      if (parsedLimit < 1 || parsedLimit > 100) {
        return leadErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Parameter limit harus antara 1 hingga 100.",
          requestId,
          [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be between 1 and 100." }],
        );
      }
      limit = parsedLimit;
    }

    const search =
      url.searchParams.get("q")?.trim() ??
      url.searchParams.get("search")?.trim() ??
      undefined;
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;

    const [list, notificationSettings] = await Promise.all([
      listLeads(tenantDb, {
        status: rawStatus as LeadStatus | "all",
        search,
        limit,
        cursor,
      }),
      getLeadNotificationSettings(tenantDb),
    ]);

    return leadJsonResponse(200, {
      items: list.items.map((lead) => formatLeadRecordResponse(lead, primaryOrigin)),
      counts: list.counts,
      notifications: {
        emailEnabled: notificationSettings.emailEnabled,
      },
      page: list.page,
    });
  } catch (err) {
    return mapLeadDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadsListRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
