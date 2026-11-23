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
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { resolveIncident } from "@punyasitus/db/incidents/index";
import type { APIRoute } from "astro";
import { mapIncidentErrorToResponse } from "../index.ts";

/**
 * `/api/console/incidents/[incidentId]/resolve` — One-action audited resolution
 * of an active platform incident (immediately hides dashboard banner, writes
 * append-only timeline update + `platform_audit` atomically).
 */

export async function handleConsoleIncidentResolveRequest(
  request: Request,
  incidentId: string,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "platform_incident.resolve", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await resolveIncident(authz.ctx.platformDb, {
        actorUserId: authz.ctx.actor.userId,
        incidentId,
        payload: parsed.body,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(200, {
        success: true,
        incident: result.incident,
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapIncidentErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_incident.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP ini tidak diizinkan. Gunakan POST untuk menyelesaikan insiden.",
    authz.ctx.requestId,
    undefined,
    { Allow: "POST" },
  );
}

function getRuntimeEnv(): ConsoleRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export const ALL: APIRoute = ({ request, params }) =>
  handleConsoleIncidentResolveRequest(request, params.incidentId ?? "", getRuntimeEnv());
