import {
  consoleErrorResponse,
  mapPlatformErrorToResponse,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  BillingConflictError,
  BillingNotFoundError,
  BillingProviderError,
  BillingValidationError,
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  type AdviceSettlementPolicy,
} from "@punyasitus/core/billing/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  createAutoLarisClient,
  type AutoLarisBillingClient,
} from "../../../../../../../packages/integrations/src/autolaris/index.ts";
import type { StructuredJobLogger } from "../../../../worker/queues/consumer.ts";
import type { ReceiptDeliveryQueueBinding } from "../../../../worker/queues/billing/receipt-delivery.ts";

/**
 * Shared runtime env, AutoLaris Advice client resolution, and domain-to-HTTP error mapping
 * for scoped console operator billing routes `/api/console/billing/**`
 * (REQ-051, REQ-057, REQ-058, REQ-081; PLAN §16.3, §16.4, §19.3; TASK-056, TASK-081).
 */

export interface ConsoleBillingRuntimeEnv extends ConsoleRuntimeEnv {
  readonly MEDIA_BUCKET?: R2Bucket | null;
  readonly JOBS_QUEUE?: ReceiptDeliveryQueueBinding | null;
  readonly AUTOLARIS_RELAY_URL?: string;
  readonly AUTOLARIS_API_KEY?: string;
  readonly AUTOLARIS_ACCOUNT_ID?: string;
}

export interface ConsoleBillingHandlerOptions extends ConsoleHandlerOptions {
  /** Optional synthetic/mocked AutoLaris client for tests. */
  readonly autolarisClient?: AutoLarisBillingClient | null;
  /** Optional injectable `fetch` transport for AutoLaris relay client in tests. */
  readonly autolarisFetch?: typeof fetch;
  /** Optional injectable `EmailPort` for credit-note email delivery in tests. */
  readonly emailPort?: EmailPort | null;
  /**
   * Explicit settlement policy. Defaults to `DEFAULT_PRODUCTION_SETTLEMENT_POLICY`
   * (`realProviderMappingStatus: "UNVERIFIED"`, `allowSettlementGrant: false`) so
   * production operator rechecks NEVER grant access on unverified mappings!
   */
  readonly settlementPolicy?: AdviceSettlementPolicy;
  readonly logger?: StructuredJobLogger;
}

export function resolveConsoleBillingRuntimeEnv(rawEnv: Record<string, unknown>): ConsoleBillingRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN: typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? null,
    MEDIA_BUCKET: (rawEnv.MEDIA_BUCKET as R2Bucket | undefined) ?? null,
    JOBS_QUEUE: (rawEnv.JOBS_QUEUE as ReceiptDeliveryQueueBinding | undefined) ?? null,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: rawEnv.EMAIL as CloudflareSendEmailBinding | undefined,
    AUTOLARIS_RELAY_URL:
      typeof rawEnv.AUTOLARIS_RELAY_URL === "string" ? rawEnv.AUTOLARIS_RELAY_URL : undefined,
    AUTOLARIS_API_KEY:
      typeof rawEnv.AUTOLARIS_API_KEY === "string" ? rawEnv.AUTOLARIS_API_KEY : undefined,
    AUTOLARIS_ACCOUNT_ID:
      typeof rawEnv.AUTOLARIS_ACCOUNT_ID === "string" ? rawEnv.AUTOLARIS_ACCOUNT_ID : undefined,
  };
}

export function resolveConsoleAutoLarisClient(
  runtimeEnv: ConsoleBillingRuntimeEnv,
  options: ConsoleBillingHandlerOptions = {},
): AutoLarisBillingClient {
  if (options.autolarisClient) {
    return options.autolarisClient;
  }
  const relayBaseUrl = runtimeEnv.AUTOLARIS_RELAY_URL?.trim() ?? "";
  const apiKey = runtimeEnv.AUTOLARIS_API_KEY?.trim() ?? "";
  if (!relayBaseUrl || !apiKey) {
    throw new BillingProviderError(
      "relay_config_error",
      "AUTOLARIS_NOT_CONFIGURED",
      "Integrasi AutoLaris belum dikonfigurasi pada server ini.",
    );
  }
  return createAutoLarisClient({
    relayBaseUrl,
    apiKey,
    providerAccountId: runtimeEnv.AUTOLARIS_ACCOUNT_ID,
    fetchImpl: options.autolarisFetch,
  });
}

export function getConsoleSettlementPolicySummary(
  policy: AdviceSettlementPolicy = DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
): Readonly<Record<string, unknown>> {
  return {
    profile: policy.profile,
    realProviderMappingStatus: policy.realProviderMappingStatus,
    policyVersion: policy.policyVersion,
    liveSettlementEnabled:
      policy.allowSettlementGrant && policy.realProviderMappingStatus !== "UNVERIFIED",
  };
}

export function mapConsoleBillingErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof BillingValidationError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
      ...(err.fields.length > 0 ? { fields: err.fields } : {}),
    });
  }
  if (err instanceof BillingConflictError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
    });
  }
  if (err instanceof BillingNotFoundError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof BillingProviderError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.safeFailureCode,
    });
  }
  return mapPlatformErrorToResponse(err, requestId);
}
