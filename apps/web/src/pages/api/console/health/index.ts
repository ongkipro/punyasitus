import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  readPlatformHealthSnapshot,
  type ReadPlatformHealthOptions,
} from "@punyasitus/db/platform";
import type { APIRoute } from "astro";

/**
 * `/api/console/health` — Read-only real-time platform dependency, job/cron, backup,
 * restore-drill, and custom-domain health snapshot.
 *
 * Security & operational invariants (TASK-048, REQ-051, REQ-042, PLAN §13):
 * - Strictly `console.punyasitus.com` host + active platform operator with verified 2FA.
 * - Explicitly distinguishes `healthy`, `degraded`, `stale`, and `unknown` — NEVER
 *   fabricates `healthy` when heartbeats or backup/restore evidence are missing or stale.
 * - Strictly read-only (`POST`/`PUT`/`PATCH`/`DELETE` -> `405 METHOD_NOT_ALLOWED`);
 *   no deploy, restart, or SQL execution controls.
 */

export async function handleConsoleHealthRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions & Omit<ReadPlatformHealthOptions, "nowMs"> = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: method === "GET" ? "platform_health.read" : "platform_health.method_reject",
      requireStepUp: false,
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Endpoint kesehatan platform hanya bersifat baca (GET).",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const snapshot = await readPlatformHealthSnapshot(authz.ctx.platformDb, {
    backupBucket: options.backupBucket ?? runtimeEnv.BACKUP_BUCKET ?? null,
    nowMs: authz.ctx.nowMs,
    maxJobAgeSeconds: options.maxJobAgeSeconds,
    maxBackupAgeSeconds: options.maxBackupAgeSeconds,
    maxRestoreDrillAgeSeconds: options.maxRestoreDrillAgeSeconds,
    maxDomainCheckAgeSeconds: options.maxDomainCheckAgeSeconds,
  });

  return consoleJsonResponse(200, {
    success: true,
    ...snapshot,
    requestId: authz.ctx.requestId,
  });
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
    BACKUP_BUCKET: runtimeEnv.BACKUP_BUCKET,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleHealthRequest(request, getRuntimeEnv());
