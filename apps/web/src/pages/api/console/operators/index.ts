import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  executeAuditedPlatformGrant,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  isValidPlatformOperatorRole,
  listPlatformOperators,
  type PlatformOperatorRole,
} from "@punyasitus/db/platform";
import type { APIRoute } from "astro";

/**
 * `/api/console/operators` — List active/revoked operators & grant new operator roles.
 *
 * Security boundaries (TASK-048, REQ-051, PLAN §13):
 * - Served strictly on `console.punyasitus.com` (404 on app/tenant/marketing hosts).
 * - Live DB lookup on every request (revoked operators fail immediately).
 * - Granting requires recent 2FA step-up (`requireRecentSecondFactor` -> `403 REAUTH_REQUIRED`),
 *   mandatory 10-500 char reason, verified target account, and atomic `platform_audit`.
 */

const ALLOWED_GRANT_KEYS: ReadonlySet<string> = new Set([
  "targetUserId",
  "targetEmail",
  "role",
  "reason",
  "expectedVersion",
  "idempotencyKey",
]);

export async function handleConsoleOperatorsRequest(
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
      { action: "platform_operator.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const url = new URL(request.url);
    const includeRevoked = url.searchParams.get("includeRevoked") !== "false";
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;

    const operators = await listPlatformOperators(authz.ctx.platformDb, {
      includeRevoked,
      limit,
    });
    const activeCount = operators.filter((o) => o.isActive).length;
    const superadminCount = operators.filter(
      (o) => o.isActive && o.role === "platform_superadmin",
    ).length;

    return consoleJsonResponse(200, {
      success: true,
      items: operators,
      summary: {
        activeCount,
        superadminCount,
        revokedCount: operators.length - activeCount,
        totalCount: operators.length,
      },
      actorUserId: authz.ctx.actor.userId,
      requestId: authz.ctx.requestId,
    });
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "platform_operator.grant", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      ALLOWED_GRANT_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    const body = parsed.body;
    const targetUserId =
      typeof body.targetUserId === "string" && body.targetUserId.trim().length > 0
        ? body.targetUserId.trim()
        : undefined;
    const targetEmail =
      typeof body.targetEmail === "string" && body.targetEmail.trim().length > 0
        ? body.targetEmail.trim().toLowerCase()
        : undefined;

    if (!targetUserId && !targetEmail) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Wajib mengisi targetUserId atau targetEmail pengguna yang sudah terverifikasi.",
        authz.ctx.requestId,
        {
          fields: [
            {
              field: "targetEmail",
              code: "REQUIRED",
              message: "Either targetUserId or targetEmail is required.",
            },
          ],
        },
      );
    }

    let role: PlatformOperatorRole = "platform_superadmin";
    if (body.role !== undefined) {
      if (!isValidPlatformOperatorRole(body.role)) {
        return consoleErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Peran operator tidak valid. Pilih platform_superadmin atau platform_support.",
          authz.ctx.requestId,
          {
            fields: [
              {
                field: "role",
                code: "INVALID_ROLE",
                message: "Allowed roles: platform_superadmin, platform_support.",
              },
            ],
          },
        );
      }
      role = body.role;
    }

    const reason = typeof body.reason === "string" ? body.reason : "";

    try {
      const result = await executeAuditedPlatformGrant(authz.ctx.platformDb, {
        session: authz.ctx.session,
        user: authz.ctx.user,
        targetUserId,
        targetEmail,
        role,
        reason,
        requestId: authz.ctx.requestId,
        requireRecentSecondFactor: true,
        reauthWindowMs: options.reauthWindowMs,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, {
        success: true,
        operator: result.operator,
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapPlatformErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_operator.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP ini tidak diizinkan untuk manajemen operator. Gunakan GET atau POST.",
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
  handleConsoleOperatorsRequest(request, getRuntimeEnv());
