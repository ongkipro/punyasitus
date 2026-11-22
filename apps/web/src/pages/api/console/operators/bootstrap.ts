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
 * `/api/console/operators/bootstrap` — Explicitly refuses anonymous & HTTP bootstrap.
 *
 * Initial platform operator bootstrap MUST occur strictly from a trusted operator terminal
 * via `node scripts/platform-operator.mjs --mode bootstrap ...` (PLAN §13, TASK-049/048).
 */

export async function handleConsoleOperatorBootstrapGuard(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createConsoleRequestId();

  // Fail closed: wrong host -> 404, anonymous -> 401, non-operator -> 403
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "platform_operator.http_bootstrap_attempt", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  // Even authenticated operators cannot invoke initial bootstrap over HTTP
  return consoleErrorResponse(
    403,
    "BOOTSTRAP_CLI_ONLY",
    "Bootstrap operator awal hanya diizinkan melalui prosedur CLI teraudit (scripts/platform-operator.mjs), bukan melalui HTTP.",
    authz.ctx.requestId,
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
  handleConsoleOperatorBootstrapGuard(request, getRuntimeEnv());
