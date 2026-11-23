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
import { selfRegisterAgency } from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatAgencySummaryDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/agency/enroll` — Self-registration for a verified, TOTP-2FA-enabled agency owner.
 * Always initializes `discount_percent = 0` and `unpaid_trial_cap = 3` (REQ-083, PLAN §19.4).
 */
const ENROLL_ALLOWED_KEYS = new Set([
  "agencyName",
  "billingEmail",
  "billingName",
  "acceptTerms",
  "termsVersion",
]);

export async function handleAgencyEnrollRequest(
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
      action: "agency.enroll",
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
      "Gunakan metode POST untuk mendaftar sebagai agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const parsed = await parseStrictAgencyJsonBody(
    request,
    authz.ctx.requestId,
    ENROLL_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  try {
    const result = await selfRegisterAgency(authz.ctx.platformDb, {
      userId: authz.ctx.actor.userId,
      agencyName: typeof parsed.body.agencyName === "string" ? parsed.body.agencyName : "",
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
  handleAgencyEnrollRequest(
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
