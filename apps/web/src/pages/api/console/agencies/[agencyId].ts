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
  getAgencyById,
  listAgencyClients,
  updateAgencyConfigurationFromConsole,
  type AgencyDiscountTier,
  type AgencyStatus,
} from "@punyasitus/db/agencies/index";
import type { APIRoute } from "astro";
import {
  formatConsoleAgencyDto,
  mapConsoleAgencyErrorToResponse,
  resolveConsoleAgenciesRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/agencies/[agencyId]` — Inspect agency detail (GET) and configure
 * discount percentage, volume discount tiers, unpaid trial cap, or status (PATCH).
 *
 * Security boundaries:
 * - Strictly `console.punyasitus.com` host (neutral `404` on app/tenant/marketing).
 * - PATCH requires active operator + recent 2FA step-up + CSRF/Origin + optimistic CAS
 *   (`expectedVersion`) + mandatory 10–500 char reason + atomic `platform_audit`.
 */

const UPDATE_AGENCY_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "discountPercent",
  "discountTiers",
  "unpaidTrialCap",
  "status",
  "reason",
]);

export async function handleConsoleAgencyDetailRequest(
  agencyId: string,
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
      { action: "console.agencies.read", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const agency = await getAgencyById(authz.ctx.platformDb, agencyId);
      if (!agency) {
        return consoleErrorResponse(404, "NOT_FOUND", "Agensi tidak ditemukan.", authz.ctx.requestId);
      }
      const clients = await listAgencyClients(authz.ctx.platformDb, agency.id, {
        nowMs: authz.ctx.nowMs,
        limit: 100,
      });

      return consoleJsonResponse(200, {
        success: true,
        agency: formatConsoleAgencyDto(agency),
        clients: clients.map((c) => ({
          tenantId: c.tenantId,
          handle: c.handle,
          name: c.name,
          effectiveStatus: c.effectiveStatus,
          isUnpaidTrial: c.isUnpaidTrial,
          hasSettledPayment: c.hasSettledPayment,
        })),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleAgencyErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.agencies.update", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      UPDATE_AGENCY_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const result = await updateAgencyConfigurationFromConsole(authz.ctx.platformDb, {
        agencyId,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        expectedVersion:
          typeof parsed.body.expectedVersion === "number" ? parsed.body.expectedVersion : -1,
        discountPercent:
          typeof parsed.body.discountPercent === "number"
            ? parsed.body.discountPercent
            : undefined,
        discountTiers: Array.isArray(parsed.body.discountTiers)
          ? (parsed.body.discountTiers as readonly AgencyDiscountTier[])
          : undefined,
        unpaidTrialCap:
          typeof parsed.body.unpaidTrialCap === "number" ? parsed.body.unpaidTrialCap : undefined,
        status:
          typeof parsed.body.status === "string"
            ? (parsed.body.status as AgencyStatus)
            : undefined,
        reason: typeof parsed.body.reason === "string" ? parsed.body.reason : "",
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(200, {
        success: true,
        agency: formatConsoleAgencyDto(result.agency),
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
    "Metode HTTP tidak diizinkan. Gunakan GET atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PATCH" },
  );
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleAgencyDetailRequest(
    params.agencyId ?? "",
    request,
    resolveConsoleAgenciesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
