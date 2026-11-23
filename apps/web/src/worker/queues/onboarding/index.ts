import { NonRetryableJobError } from "@punyasitus/core/jobs/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  ONBOARDING_RETRY_STORE_INIT_TOPIC,
  resumeOnboardingTenantStoreInit,
} from "@punyasitus/db/provisioning/self-service";
import type { DurableJobHandler } from "../consumer.ts";

/**
 * Durable Cloudflare Queue handler for partial-provisioning `TenantStore` recovery
 * (`apps/web/src/worker/queues/onboarding/index.ts`; REQ-059, TASK-058).
 *
 * When `PLATFORM_DB` commits a new self-service tenant atomically but `TenantStore`
 * default seeding fails transiently, this job completes `TenantStore` initialization
 * idempotently without duplicating the tenant or resetting trial deadlines.
 */

export { ONBOARDING_RETRY_STORE_INIT_TOPIC };

export interface OnboardingRetryStoreInitPayload {
  readonly tenantId?: string;
  readonly handle?: string;
  readonly name?: string;
  readonly vertical?: string;
  readonly onboardingIdempotencyKey?: string;
}

export function createOnboardingRetryJobHandler(options?: {
  readonly tenantStoreOverride?: TenantStoreNamespaceLike | null;
}): DurableJobHandler<OnboardingRetryStoreInitPayload> {
  return {
    maxAttempts: 5,
    leaseDurationMs: 60_000,

    async reconcile(ctx) {
      const tenantId = (ctx.payload?.tenantId ?? ctx.tenantId ?? "").trim();
      if (!tenantId) {
        return { state: "not_applied" };
      }

      const row = await ctx.env.PLATFORM_DB.prepare(
        "SELECT schema_version FROM tenants WHERE id = ? LIMIT 1",
      )
        .bind(tenantId)
        .first<{ readonly schema_version: number }>();

      if (row && row.schema_version > 0) {
        if (ctx.payload?.onboardingIdempotencyKey) {
          await ctx.env.PLATFORM_DB.prepare(
            `UPDATE onboarding_attempts
             SET provisioning_state = 'completed', last_error_code = NULL, updated_at = ?
             WHERE idempotency_key = ?`,
          )
            .bind(ctx.nowMs, ctx.payload.onboardingIdempotencyKey)
            .run();
        }
        return { state: "completed" };
      }

      return { state: "not_applied" };
    },

    async execute(ctx) {
      const tenantId = (ctx.payload?.tenantId ?? ctx.tenantId ?? "").trim();
      if (!tenantId) {
        throw new NonRetryableJobError(
          "MISSING_TENANT_ID",
          "Onboarding recovery job payload is missing tenantId",
        );
      }

      const tenantStore =
        options?.tenantStoreOverride ??
        (ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined);

      if (!tenantStore) {
        throw new Error("TENANT_STORE_BINDING_UNAVAILABLE");
      }

      await resumeOnboardingTenantStoreInit(ctx.env.PLATFORM_DB, tenantStore, {
        tenantId,
        nowMs: ctx.nowMs,
      });
    },
  };
}
