import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { APIRoute } from "astro";

/**
 * `/api/console/audit/[auditId]` — Explicitly rejects any attempt to edit or delete
 * an individual audit row (`405 METHOD_NOT_ALLOWED`; append-only invariant).
 */

export async function handleConsoleAuditItemRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_audit.item_immutable_reject", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Baris log audit bersifat permanen (append-only) dan tidak dapat diubah atau dihapus.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET" },
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
  handleConsoleAuditItemRequest(request, getRuntimeEnv());
