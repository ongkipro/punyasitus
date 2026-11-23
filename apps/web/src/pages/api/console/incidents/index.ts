import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  declareIncident,
  listActiveBannerIncidents,
  listIncidents,
  PlatformIncidentError,
} from "@punyasitus/db/incidents/index";
import type { APIRoute } from "astro";

/**
 * `/api/console/incidents` — List & declare platform incidents (REQ-106; TASK-106).
 *
 * Security boundaries:
 * - Strictly `console.punyasitus.com` (404 on app/tenant/marketing hosts).
 * - Requires active platform operator + verified 2FA; `POST` additionally enforces
 *   CSRF/Origin and recent 2FA step-up (`requireStepUp: true`).
 * - `POST` activates the dashboard banner and records an immutable `platform_audit`
 *   entry inside ONE atomic D1 `batch()` transaction.
 */

export function mapIncidentErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof PlatformIncidentError) {
    return consoleErrorResponse(
      err.status,
      err.code,
      err.message,
      requestId,
      err.fields.length > 0 ? { fields: err.fields } : undefined,
    );
  }
  return mapPlatformErrorToResponse(err, requestId);
}

export async function handleConsoleIncidentsRequest(
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
      { action: "platform_incident.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const url = new URL(request.url);
    const includeResolved = url.searchParams.get("includeResolved") !== "false";
    const [incidents, activeBannerIncidents] = await Promise.all([
      listIncidents(authz.ctx.platformDb, { includeResolved, limit: 30 }),
      listActiveBannerIncidents(authz.ctx.platformDb),
    ]);

    return consoleJsonResponse(200, {
      success: true,
      incidents,
      activeBannerIncidents,
      activeBannerCount: activeBannerIncidents.length,
      requestId: authz.ctx.requestId,
    });
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "platform_incident.declare", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await declareIncident(authz.ctx.platformDb, {
        actorUserId: authz.ctx.actor.userId,
        payload: parsed.body,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, {
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
    "Metode HTTP ini tidak diizinkan untuk insiden platform. Gunakan GET atau POST.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, POST" },
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

export const ALL: APIRoute = ({ request }) =>
  handleConsoleIncidentsRequest(request, getRuntimeEnv());
