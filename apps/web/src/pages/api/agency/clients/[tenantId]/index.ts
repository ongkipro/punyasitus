import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { getAgencyClientBySelector } from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatAgencyClientDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
} from "../../_shared.ts";

/**
 * `GET /api/agency/clients/[tenantId]` — Scoped client tenant detail.
 * Cross-agency or non-existent client selectors ALWAYS return neutral `404 NOT_FOUND`.
 */
export async function handleAgencyClientDetailRequest(
  tenantIdOrHandle: string,
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
      action: "agency.clients.read",
      requestedAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:read",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk melihat detail situs klien.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const agency = authz.ctx.actor.activeAgency!;
    const client = await getAgencyClientBySelector(
      authz.ctx.platformDb,
      agency.id,
      tenantIdOrHandle,
      authz.ctx.nowMs,
      runtimeEnv.SAAS_ZONE,
    );
    if (!client) {
      return agencyErrorResponse(404, "NOT_FOUND", "Situs klien tidak ditemukan.", authz.ctx.requestId);
    }

    return agencyJsonResponse(200, {
      success: true,
      client: formatAgencyClientDto(client),
      agencyClientContext: {
        agencyId: agency.id,
        agencyName: agency.name,
        clientTenantId: client.tenantId,
        clientName: client.name,
        clientHandle: client.handle,
        returnHref: "/agency/clients",
        dashboardUrl: `/dashboard/${encodeURIComponent(client.handle)}`,
      },
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyClientDetailRequest(
    params.tenantId ?? "",
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
