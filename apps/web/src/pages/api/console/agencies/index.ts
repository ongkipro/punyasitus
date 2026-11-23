import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  createOperatorAgencyInvitation,
  listConsoleAgencies,
  listPendingAgencyOnboardingInvitations,
  type AgencyStatus,
} from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatConsoleAgencyDto,
  formatConsoleAgencyInvitationDto,
  mapConsoleAgencyErrorToResponse,
  resolveConsoleAgenciesRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/agencies` — List agencies & pending invitations (GET) and create
 * audited operator agency onboarding invitations (POST).
 *
 * Security boundaries:
 * - Strictly `console.punyasitus.com` host (neutral `404` on app/tenant/marketing).
 * - POST requires active platform operator + recent 2FA step-up (`403 RECENT_SECOND_FACTOR_REQUIRED`),
 *   CSRF/Origin validation, mandatory 10–500 char reason, and atomic `platform_audit`.
 */

const INVITE_AGENCY_ALLOWED_KEYS = new Set([
  "email",
  "agencyName",
  "reason",
  "expiresInHours",
]);

export async function handleConsoleAgenciesRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.agencies.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const url = new URL(request.url);
      const rawStatus = url.searchParams.get("status")?.trim().toLowerCase();
      const status: AgencyStatus | undefined =
        rawStatus === "active" || rawStatus === "pending" || rawStatus === "suspended"
          ? rawStatus
          : undefined;
      const [agencies, invitations] = await Promise.all([
        listConsoleAgencies(authz.ctx.platformDb, { status, limit: 100 }),
        listPendingAgencyOnboardingInvitations(authz.ctx.platformDb, { limit: 50 }),
      ]);

      return consoleJsonResponse(200, {
        success: true,
        agencies: agencies.map(formatConsoleAgencyDto),
        invitations: invitations.map(formatConsoleAgencyInvitationDto),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleAgencyErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.agencies.invite", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      INVITE_AGENCY_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const result = await createOperatorAgencyInvitation(authz.ctx.platformDb, {
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        email: typeof parsed.body.email === "string" ? parsed.body.email : "",
        agencyName: typeof parsed.body.agencyName === "string" ? parsed.body.agencyName : "",
        reason: typeof parsed.body.reason === "string" ? parsed.body.reason : "",
        expiresInHours:
          typeof parsed.body.expiresInHours === "number"
            ? parsed.body.expiresInHours
            : undefined,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, {
        success: true,
        invitation: formatConsoleAgencyInvitationDto(result.invitation),
        inviteToken: result.rawToken,
        acceptPath: result.acceptPath,
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleAgencyErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.agencies.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk endpoint agensi console. Gunakan GET atau POST.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleAgenciesRequest(
    request,
    resolveConsoleAgenciesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
