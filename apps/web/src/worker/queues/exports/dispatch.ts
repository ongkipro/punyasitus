import {
  TENANT_EXPORT_CLEANUP_TOPIC,
  TENANT_EXPORT_GENERATE_TOPIC,
  TENANT_SELF_DELETION_SWEEP_TOPIC,
} from "@punyasitus/core/exports/index";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { DurableQueueEnv } from "../consumer.ts";

export interface TenantExportGenerateJobPayload {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedByUserId: string;
  readonly requestDay: string;
  readonly scheduledAtMs?: number;
}

export interface TenantExportCleanupJobPayload {
  readonly scheduledAtMs: number;
  readonly limit?: number;
}

export interface TenantSelfDeletionSweepJobPayload {
  readonly scheduledAtMs: number;
  readonly tenantId?: string;
  readonly limit?: number;
}

export type ExportDispatchEnv = Pick<DurableQueueEnv, "PLATFORM_DB"> & {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
};

/**
 * Enqueues an idempotent full-website export archive generation job into `PLATFORM_DB.job_ledger`
 * and optionally `env.JOBS_QUEUE` (REQ-107, PLAN §20.4, TASK-107).
 */
export async function enqueueTenantExportArchiveJob(
  env: ExportDispatchEnv,
  input: {
    readonly idempotencyKey: string;
    readonly exportId: string;
    readonly tenantId: string;
    readonly requestedByUserId: string;
    readonly requestDay: string;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof TENANT_EXPORT_GENERATE_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const key = input.idempotencyKey.trim();
  const tenantId = input.tenantId.trim();
  const exportId = input.exportId.trim();
  if (!key || key.length > 256) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: export job idempotencyKey is required");
  }
  if (!tenantId || !exportId) {
    throw new RangeError("INVALID_EXPORT_JOB_TARGET: tenantId and exportId are required");
  }

  const payload: TenantExportGenerateJobPayload = {
    exportId,
    tenantId,
    requestedByUserId: input.requestedByUserId.trim(),
    requestDay: input.requestDay.trim(),
    scheduledAtMs: nowMs,
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: TENANT_EXPORT_GENERATE_TOPIC,
    tenantId,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey: key,
      topic: TENANT_EXPORT_GENERATE_TOPIC,
    };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: TENANT_EXPORT_GENERATE_TOPIC,
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
    topic: TENANT_EXPORT_GENERATE_TOPIC,
  };
}

export async function enqueueExpiredExportsCleanupJob(
  env: ExportDispatchEnv,
  input: {
    readonly idempotencyKey: string;
    readonly scheduledAtMs?: number;
    readonly limit?: number;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof TENANT_EXPORT_CLEANUP_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const scheduledAtMs = Math.trunc(input.scheduledAtMs ?? nowMs);
  const key = input.idempotencyKey.trim();
  const payload: TenantExportCleanupJobPayload = {
    scheduledAtMs,
    ...(typeof input.limit === "number" ? { limit: Math.trunc(input.limit) } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: TENANT_EXPORT_CLEANUP_TOPIC,
    tenantId: null,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return { enqueued: false, idempotencyKey: key, topic: TENANT_EXPORT_CLEANUP_TOPIC };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: TENANT_EXPORT_CLEANUP_TOPIC,
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

  return { enqueued: true, idempotencyKey: key, topic: TENANT_EXPORT_CLEANUP_TOPIC };
}

export async function enqueueSelfServiceDeletionSweepJob(
  env: ExportDispatchEnv,
  input: {
    readonly idempotencyKey: string;
    readonly scheduledAtMs?: number;
    readonly tenantId?: string;
    readonly limit?: number;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof TENANT_SELF_DELETION_SWEEP_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const scheduledAtMs = Math.trunc(input.scheduledAtMs ?? nowMs);
  const key = input.idempotencyKey.trim();
  const payload: TenantSelfDeletionSweepJobPayload = {
    scheduledAtMs,
    ...(input.tenantId ? { tenantId: input.tenantId.trim() } : {}),
    ...(typeof input.limit === "number" ? { limit: Math.trunc(input.limit) } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: key,
    topic: TENANT_SELF_DELETION_SWEEP_TOPIC,
    tenantId: input.tenantId ?? null,
    payload: payload as unknown as Record<string, unknown>,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return { enqueued: false, idempotencyKey: key, topic: TENANT_SELF_DELETION_SWEEP_TOPIC };
  }

  if (env.JOBS_QUEUE) {
    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: TENANT_SELF_DELETION_SWEEP_TOPIC,
      tenantId: input.tenantId ?? null,
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

  return { enqueued: true, idempotencyKey: key, topic: TENANT_SELF_DELETION_SWEEP_TOPIC };
}
