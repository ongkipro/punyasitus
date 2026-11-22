import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  executeAuditedPlatformRevoke,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";

/**
 * `POST /api/console/operators/[userId]/revoke` — Atomic operator revocation with:
 * - Console host isolation + CSRF/Origin
 * - Recent 2FA step-up (`requireRecentSecondFactor` -> `403 REAUTH_REQUIRED`)
 * - Mandatory 10-500 char reason + atomic `platform_audit`
 * - Concurrent final-operator protection (`409 LAST_OPERATOR_PROTECTED`)
 * - Immediate enforcement on the revoked operator's subsequent requests
 */

const ALLOWED_REVOKE_KEYS: ReadonlySet<string> = new Set([
  "reason",
  "expectedVersion",
  "idempotencyKey",
]);

export async function handleConsoleOperatorRevokeRequest(
  targetUserId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "platform_operator.revoke.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan POST untuk mencabut akses operator platform.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_operator.revoke", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const cleanTargetUserId = targetUserId.trim();
  if (!cleanTargetUserId) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Parameter userId target wajib diisi.",
      authz.ctx.requestId,
    );
  }

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    ALLOWED_REVOKE_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  const reason = typeof parsed.body.reason === "string" ? parsed.body.reason : "";

  try {
    const result = await executeAuditedPlatformRevoke(authz.ctx.platformDb, {
      session: authz.ctx.session,
      user: authz.ctx.user,
      targetUserId: cleanTargetUserId,
      reason,
      requestId: authz.ctx.requestId,
      requireRecentSecondFactor: true,
      reauthWindowMs: options.reauthWindowMs,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      operator: result.operator,
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapPlatformErrorToResponse(err, authz.ctx.requestId);
  }
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

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleOperatorRevokeRequest(params.userId ?? "", request, getRuntimeEnv());
