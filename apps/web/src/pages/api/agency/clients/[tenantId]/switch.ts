import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { switchAgencyIntoClientContext } from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatAgencyClientDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
} from "../../_shared.ts";

/**
 * `POST /api/agency/clients/[tenantId]/switch` — Scoped audited switch into a linked client's
 * `/dashboard/{handle}` context.
 *
 * Security invariants:
 * - Cross-agency or non-existent tenant -> neutral `404 NOT_FOUND` (zero tenant existence leak).
 * - Mandatory TOTP 2FA + CSRF/Origin verification.
 * - Logs the ACTUAL agency user ID & agency ID in append-only `platform_audit` (never impersonates).
 * - Returns `agencyClientContext` payload for persistent client-context banner rendering.
 */
export async function handleAgencyClientSwitchRequest(
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
      action: "agency.clients.switch",
      requestedAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:clients:switch",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "POST") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk beralih ke konteks pengelolaan situs klien.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  try {
    const agency = authz.ctx.actor.activeAgency!;
    const result = await switchAgencyIntoClientContext(authz.ctx.platformDb, {
      agencyId: agency.id,
      actorUserId: authz.ctx.actor.userId,
      actorAgencyRole: authz.ctx.actor.agencyRole ?? "agency_staff",
      sessionId: authz.ctx.actor.sessionId,
      tenantIdOrHandle,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return agencyJsonResponse(200, {
      success: true,
      client: formatAgencyClientDto(result.client),
      agencyClientContext: result.agencyClientContext,
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyClientSwitchRequest(
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
