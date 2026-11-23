import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { DurableQueueEnv } from "../consumer.ts";

export const TENANT_OFFBOARDING_SWEEP_TOPIC = "offboarding.sweep" as const;
export const TENANT_OFFBOARDING_PURGE_TOPIC = "offboarding.purge_tenant" as const;

export interface TenantOffboardingSweepJobPayload {
  readonly scheduledAtMs: number;
  readonly appOrigin?: string;
  readonly limit?: number;
}

export interface TenantOffboardingPurgeJobPayload {
  readonly tenantId: string;
  readonly scheduledAtMs?: number;
  readonly reason?: string;
}

export type OffboardingDispatchEnv = Pick<DurableQueueEnv, "PLATFORM_DB"> & {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
};

/**
 * Enqueues a deduplicated locked-tenant retention warning & offboarding sweep job
 * into `PLATFORM_DB.job_ledger` and optionally `env.JOBS_QUEUE` (REQ-069, DEC-022).
 */
export async function enqueueTenantOffboardingSweep(
  env: OffboardingDispatchEnv,
  input: {
    readonly idempotencyKey: string;
    readonly scheduledAtMs?: number;
    readonly appOrigin?: string;
    readonly limit?: number;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof TENANT_OFFBOARDING_SWEEP_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const scheduledAtMs = Math.trunc(input.scheduledAtMs ?? nowMs);
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 256) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: offboarding sweep idempotencyKey is required");
  }

  const payload: TenantOffboardingSweepJobPayload = {
    scheduledAtMs,
    ...(input.appOrigin ? { appOrigin: input.appOrigin } : {}),
    ...(typeof input.limit === "number" ? { limit: Math.trunc(input.limit) } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: TENANT_OFFBOARDING_SWEEP_TOPIC,
    tenantId: null,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey: key,
      topic: TENANT_OFFBOARDING_SWEEP_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: TENANT_OFFBOARDING_SWEEP_TOPIC,
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
    topic: TENANT_OFFBOARDING_SWEEP_TOPIC,
  };
}

/**
 * Enqueues a single-tenant offboarding purge job (idempotent & resumable via `job_ledger`
 * and `tenant_offboarding_runs`).
 */
export async function enqueueTenantOffboardingPurge(
  env: OffboardingDispatchEnv,
  input: {
    readonly idempotencyKey: string;
    readonly tenantId: string;
    readonly scheduledAtMs?: number;
    readonly reason?: string;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof TENANT_OFFBOARDING_PURGE_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const key = input.idempotencyKey.trim();
  const tenantId = input.tenantId.trim();
  if (!key || key.length > 256) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: offboarding purge idempotencyKey is required");
  }
  if (!tenantId) {
    throw new RangeError("INVALID_TENANT_ID: tenantId is required");
  }

  const payload: TenantOffboardingPurgeJobPayload = {
    tenantId,
    ...(typeof input.scheduledAtMs === "number"
      ? { scheduledAtMs: Math.trunc(input.scheduledAtMs) }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: TENANT_OFFBOARDING_PURGE_TOPIC,
    tenantId,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey: key,
      topic: TENANT_OFFBOARDING_PURGE_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: TENANT_OFFBOARDING_PURGE_TOPIC,
      tenantId,
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
    topic: TENANT_OFFBOARDING_PURGE_TOPIC,
  };
}
