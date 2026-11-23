import {
  consoleErrorResponse,
  mapPlatformErrorToResponse,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { PluginBillingValidationError } from "@punyasitus/core/plugins/billing";
import { PluginStoreError } from "@punyasitus/db/plugins/store/index";

/**
 * Shared runtime env resolution and error mapping for `/api/console/plugins/**`
 * (REQ-098, REQ-051, REQ-068, TASK-098).
 */

export function resolveConsolePluginsRuntimeEnv(
  rawEnv: Readonly<Record<string, unknown>>,
): ConsoleRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? undefined,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: rawEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export function mapConsolePluginStoreErrorToResponse(
  err: unknown,
  requestId: string,
): Response {
  if (err instanceof PluginBillingValidationError) {
    return consoleErrorResponse(422, err.code, err.message, requestId, {
      reasonCode: err.code,
      fields: err.fields,
    });
  }
  if (err instanceof PluginStoreError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
      fields: err.fields,
    });
  }
  return mapPlatformErrorToResponse(err, requestId);
}
