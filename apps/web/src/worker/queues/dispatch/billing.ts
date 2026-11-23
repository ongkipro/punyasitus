import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { DurableQueueEnv } from "../consumer.ts";

export const BILLING_LIFECYCLE_SWEEP_TOPIC = "billing.lifecycle.sweep" as const;

export interface BillingLifecycleSweepJobPayload {
  readonly scheduledAtMs: number;
  readonly appOrigin?: string;
}

export interface EnqueueBillingLifecycleSweepInput {
  readonly idempotencyKey: string;
  readonly scheduledAtMs?: number;
  readonly appOrigin?: string;
  readonly correlationId?: string | null;
  readonly nowMs?: number;
}

export type BillingSweepDispatchEnv = Pick<DurableQueueEnv, "PLATFORM_DB"> & {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
};

/**
 * Enqueues a deduplicated billing lifecycle & renewal reminder sweep job into
 * `PLATFORM_DB.job_ledger` and optionally `env.JOBS_QUEUE`.
 */
export async function enqueueBillingLifecycleSweep(
  env: BillingSweepDispatchEnv,
  input: EnqueueBillingLifecycleSweepInput,
): Promise<{ readonly enqueued: boolean; readonly idempotencyKey: string; readonly topic: typeof BILLING_LIFECYCLE_SWEEP_TOPIC }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const scheduledAtMs = Math.trunc(input.scheduledAtMs ?? nowMs);
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 256) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: billing sweep idempotencyKey is required");
  }

  const payload: BillingLifecycleSweepJobPayload = {
    scheduledAtMs,
    ...(input.appOrigin ? { appOrigin: input.appOrigin } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: BILLING_LIFECYCLE_SWEEP_TOPIC,
    tenantId: null,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey: key,
      topic: BILLING_LIFECYCLE_SWEEP_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: BILLING_LIFECYCLE_SWEEP_TOPIC,
      tenantId: null,
      payload: payload as unknown as Record<string, unknown>,
      correlationId: input.correlationId ?? key,
      enqueuedAt: nowMs,
    };
    try {
      await env.JOBS_QUEUE.send(envelope);
    } catch (err) {
      await releaseUnstartedQueuedJob(env.PLATFORM_DB, key);
      throw err;
    }
  }

  return {
    enqueued: true,
    idempotencyKey: key,
    topic: BILLING_LIFECYCLE_SWEEP_TOPIC,
  };
}
