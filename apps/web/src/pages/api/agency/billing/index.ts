import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { getAgencyBillingOverview } from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatAgencyClientDto,
  formatAgencyReceiptDto,
  formatAgencySummaryDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/agency/billing` — Consolidated 100% Agency-Payer billing overview:
 * live server-computed monthly/yearly prices with agency discount, linked client
 * subscription statuses, open obligations, and numbered PDF receipts.
 */
export async function handleAgencyBillingOverviewRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const requestedAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.billing.read",
      requestedAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:read",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk melihat ringkasan tagihan agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const activeAgency = authz.ctx.actor.activeAgency!;
    const overview = await getAgencyBillingOverview(authz.ctx.platformDb, activeAgency.id, {
      nowMs: authz.ctx.nowMs,
    });
    if (!overview) {
      return agencyErrorResponse(404, "NOT_FOUND", "Agensi tidak ditemukan.", authz.ctx.requestId);
    }

    return agencyJsonResponse(200, {
      success: true,
      payerScope: "agency_only",
      agency: formatAgencySummaryDto(overview.agency),
      pricing: overview.pricing,
      clients: overview.clients.map(formatAgencyClientDto),
      receipts: overview.receipts.map(formatAgencyReceiptDto),
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyBillingOverviewRequest(
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );
