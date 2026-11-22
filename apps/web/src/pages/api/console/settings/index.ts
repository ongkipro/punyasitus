import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  executeAuditedPlatformSettingsUpdate,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";

/**
 * `/api/console/settings` — Read & audited update of `PLATFORM_DB.platform_settings`
 * (`salesWhatsapp`, `supportEmail`, `termsUrl`, `privacyUrl`, optional pricing/contact metadata).
 *
 * Security boundaries (TASK-048, REQ-051, PLAN §13):
 * - Served strictly on `console.punyasitus.com` (404 on app/tenant/marketing hosts).
 * - Requires active platform operator + verified 2FA; mutations additionally require
 *   recent 2FA step-up (`requireRecentSecondFactor` -> `403 REAUTH_REQUIRED`), CSRF/Origin,
 *   mandatory 10-500 char audit reason, and optimistic `expectedVersion`.
 * - Rejects unknown & forbidden fields; rolls back settings if `platform_audit` insert fails.
 */

export async function handleConsoleSettingsRequest(
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
      { action: "platform_settings.read", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const settings = await getPlatformSettings(authz.ctx.platformDb);
    return consoleJsonResponse(200, {
      success: true,
      settings,
      requestId: authz.ctx.requestId,
    });
  }

  if (method === "PUT" || method === "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "platform_settings.update", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await executeAuditedPlatformSettingsUpdate(authz.ctx.platformDb, {
        session: authz.ctx.session,
        user: authz.ctx.user,
        payload: parsed.body,
        requestId: authz.ctx.requestId,
        reauthWindowMs: options.reauthWindowMs,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(200, {
        success: true,
        settings: result.settings,
        changedFields: result.changedFields,
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapPlatformErrorToResponse(err, authz.ctx.requestId);
    }
  }

  // Enforce console host + operator auth before reporting 405
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_settings.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP ini tidak diizinkan untuk pengaturan platform. Gunakan GET, PUT, atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PUT, PATCH" },
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
  handleConsoleSettingsRequest(request, getRuntimeEnv());
