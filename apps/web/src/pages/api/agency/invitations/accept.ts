import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  parseStrictAgencyJsonBody,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { acceptAgencyOnboardingInvitation } from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatAgencySummaryDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/agency/invitations/accept` — Accepts an operator-issued agency onboarding invitation.
 * Requires verified email matching the invite, mandatory TOTP 2FA, and explicit terms acceptance.
 */
const ACCEPT_INVITE_ALLOWED_KEYS = new Set([
  "token",
  "agencyName",
  "billingEmail",
  "billingName",
  "acceptTerms",
  "termsVersion",
]);

export async function handleAgencyInvitationAcceptRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.invitation.accept",
      requireAgencyMembership: false,
      enforceCsrf: method !== "GET",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "POST") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk menerima undangan agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const parsed = await parseStrictAgencyJsonBody(
    request,
    authz.ctx.requestId,
    ACCEPT_INVITE_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  try {
    const result = await acceptAgencyOnboardingInvitation(authz.ctx.platformDb, {
      userId: authz.ctx.actor.userId,
      rawToken: typeof parsed.body.token === "string" ? parsed.body.token : "",
      agencyName:
        typeof parsed.body.agencyName === "string" ? parsed.body.agencyName : undefined,
      billingEmail:
        typeof parsed.body.billingEmail === "string" ? parsed.body.billingEmail : undefined,
      billingName:
        typeof parsed.body.billingName === "string" ? parsed.body.billingName : undefined,
      acceptTerms: parsed.body.acceptTerms === true,
      termsVersion:
        typeof parsed.body.termsVersion === "string" ? parsed.body.termsVersion : undefined,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return agencyJsonResponse(201, {
      success: true,
      agency: formatAgencySummaryDto(result.agency),
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyInvitationAcceptRequest(
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
