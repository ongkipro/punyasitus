import {
  computeRetryBackoffSeconds,
  DEFAULT_BASE_BACKOFF_SECONDS,
  DEFAULT_JOB_LEASE_MS,
  DEFAULT_MAX_BACKOFF_SECONDS,
  DEFAULT_MAX_JOB_ATTEMPTS,
  JobEnvelopeSchema,
  MAX_QUEUE_DELAY_SECONDS,
  NonRetryableJobError,
  redactJobLogRecord,
  sanitizeErrorCode,
  UncertainProviderEffectError,
  type JobEnvelope,
} from "@punyasitus/core/jobs/index";
import {
  acquireJobLease,
  completeJob,
  enqueueDurableJob,
  failJob,
} from "@punyasitus/db/jobs/index";
import type { PunyasitusEnv } from "../env.d.ts";

export type DurableQueueEnv = Pick<PunyasitusEnv, "PLATFORM_DB"> &
  Partial<Omit<PunyasitusEnv, "PLATFORM_DB">>;

export interface JobExecutionContext<TPayload = Record<string, unknown>> {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly payload: TPayload;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
  readonly enqueuedAt: number;
  readonly env: DurableQueueEnv;
  readonly nowMs: number;
}

export type JobReconcileResult =
  | { readonly state: "completed"; readonly externalReference?: string }
  | { readonly state: "not_applied" }
  | { readonly state: "pending"; readonly retryAfterSeconds?: number };

export interface DurableJobHandler<TPayload = Record<string, unknown>> {
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly execute: (ctx: JobExecutionContext<TPayload>) => Promise<void>;
  readonly reconcile?: (ctx: JobExecutionContext<TPayload>) => Promise<JobReconcileResult>;
}

export type DurableJobRegistry = Readonly<Record<string, DurableJobHandler>>;

export interface DeadLetterRecord {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly errorCode: string;
  readonly correlationId: string | null;
  readonly deadLetteredAt: number;
}

export type StructuredJobLogger = (entry: Record<string, unknown>) => void;

export interface DurableQueueOptions {
  readonly now?: () => number;
  readonly defaultMaxAttempts?: number;
  readonly defaultLeaseDurationMs?: number;
  readonly leaseActiveRetryDelaySeconds?: number;
  readonly baseBackoffSeconds?: number;
  readonly maxBackoffSeconds?: number;
  readonly logger?: StructuredJobLogger;
  readonly onDeadLetter?: (record: DeadLetterRecord) => Promise<void> | void;
  readonly dlqQueue?: Pick<Queue<DeadLetterRecord>, "send">;
}

export interface DurableQueueBatchResult {
  readonly total: number;
  readonly completed: number;
  readonly reconciled: number;
  readonly deduplicated: number;
  readonly deferredLeaseActive: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly rejectedInvalid: number;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function emitRedactedLog(
  logger: StructuredJobLogger,
  entry: Record<string, unknown>,
): void {
  logger(redactJobLogRecord(entry));
}

function isNonRetryableError(err: unknown): boolean {
  if (err instanceof NonRetryableJobError) return true;
  if (typeof err === "object" && err !== null && "retryable" in err) {
    return (err as { retryable?: unknown }).retryable === false;
  }
  return false;
}

function clampDelaySeconds(seconds: number): number {
  return Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, Math.round(seconds)));
}

async function notifyDeadLetter(
  record: DeadLetterRecord,
  options?: DurableQueueOptions,
): Promise<void> {
  if (options?.dlqQueue) {
    await options.dlqQueue.send(record);
  }
  if (options?.onDeadLetter) {
    await options.onDeadLetter(record);
  }
}

/**
 * Processes a Cloudflare Queues batch with durable D1 `job_ledger` idempotency,
 * lease management, expired-lease recovery, provider reconciliation, bounded retries,
 * dead-letter handoff, tenant context preservation, and sensitive-field log redaction.
 */
export async function processDurableQueueBatch(
  batch: MessageBatch<unknown>,
  env: DurableQueueEnv,
  registry: DurableJobRegistry,
  options?: DurableQueueOptions,
): Promise<DurableQueueBatchResult> {
  const now = options?.now ?? (() => Date.now());
  const logger = options?.logger ?? defaultLogger;
  const defaultMaxAttempts = options?.defaultMaxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
  const defaultLeaseDurationMs = options?.defaultLeaseDurationMs ?? DEFAULT_JOB_LEASE_MS;
  const leaseActiveRetryDelaySeconds = clampDelaySeconds(
    options?.leaseActiveRetryDelaySeconds ?? 5,
  );
  const baseBackoffSeconds = options?.baseBackoffSeconds ?? DEFAULT_BASE_BACKOFF_SECONDS;
  const maxBackoffSeconds = options?.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS;

  let completed = 0;
  let reconciled = 0;
  let deduplicated = 0;
  let deferredLeaseActive = 0;
  let retried = 0;
  let deadLettered = 0;
  let rejectedInvalid = 0;

  for (const message of batch.messages) {
    const nowMs = now();
    const parsedResult = JobEnvelopeSchema.safeParse(message.body);
    if (!parsedResult.success) {
      emitRedactedLog(logger, {
        event: "job.invalid_envelope",
        queue: batch.queue,
        messageId: message.id,
        errorCode: "INVALID_JOB_ENVELOPE",
        timestamp: nowMs,
      });
      message.ack();
      rejectedInvalid += 1;
      continue;
    }

    const parsed = parsedResult.data;
    const handler = registry[parsed.topic];
    const effectiveMaxAttempts =
      parsed.maxAttempts ?? handler?.maxAttempts ?? defaultMaxAttempts;
    const leaseDurationMs = handler?.leaseDurationMs ?? defaultLeaseDurationMs;

    const envelope: JobEnvelope = {
      idempotencyKey: parsed.idempotencyKey,
      topic: parsed.topic,
      tenantId: parsed.tenantId,
      payload: parsed.payload,
      maxAttempts: effectiveMaxAttempts,
      correlationId: parsed.correlationId,
      enqueuedAt: parsed.enqueuedAt ?? nowMs,
    };

    // Ensure durable ledger entry exists before acquiring lease (idempotent)
    await enqueueDurableJob(env.PLATFORM_DB, {
      idempotencyKey: envelope.idempotencyKey,
      topic: envelope.topic,
      tenantId: envelope.tenantId,
      payload: envelope.payload,
      nowMs,
    });

    const lease = await acquireJobLease(env.PLATFORM_DB, {
      idempotencyKey: envelope.idempotencyKey,
      nowMs,
      leaseDurationMs,
      maxAttempts: effectiveMaxAttempts,
    });

    if (lease.outcome === "already_completed") {
      emitRedactedLog(logger, {
        event: "job.deduplicated",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: lease.record.tenantId,
        correlationId: envelope.correlationId,
        attempts: lease.record.attempts,
        timestamp: nowMs,
      });
      message.ack();
      deduplicated += 1;
      continue;
    }

    if (lease.outcome === "lease_active") {
      emitRedactedLog(logger, {
        event: "job.lease_active",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: lease.record.tenantId,
        correlationId: envelope.correlationId,
        leaseUntil: lease.leaseUntil,
        retryDelaySeconds: leaseActiveRetryDelaySeconds,
        timestamp: nowMs,
      });
      message.retry({ delaySeconds: leaseActiveRetryDelaySeconds });
      deferredLeaseActive += 1;
      continue;
    }

    if (lease.outcome === "dead_letter") {
      const errorCode = lease.record.lastErrorCode ?? "MAX_ATTEMPTS_EXCEEDED";
      if (lease.transitionedToDeadLetter) {
        await notifyDeadLetter(
          {
            idempotencyKey: envelope.idempotencyKey,
            topic: envelope.topic,
            tenantId: lease.record.tenantId,
            attempts: lease.record.attempts,
            maxAttempts: effectiveMaxAttempts,
            errorCode,
            correlationId: envelope.correlationId,
            deadLetteredAt: nowMs,
          },
          options,
        );
      }
      emitRedactedLog(logger, {
        event: "job.dead_letter_terminal",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: lease.record.tenantId,
        correlationId: envelope.correlationId,
        attempts: lease.record.attempts,
        errorCode,
        timestamp: nowMs,
      });
      message.ack();
      deadLettered += 1;
      continue;
    }

    if (lease.outcome === "not_found") {
      emitRedactedLog(logger, {
        event: "job.ledger_missing",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: envelope.tenantId,
        correlationId: envelope.correlationId,
        errorCode: "LEDGER_ROW_MISSING",
        timestamp: nowMs,
      });
      message.retry({ delaySeconds: leaseActiveRetryDelaySeconds });
      retried += 1;
      continue;
    }

    // Preserve authoritative tenantId stored in job_ledger across retries & dead-lettering
    const authoritativeTenantId = lease.tenantId;

    if (!handler) {
      const failed = await failJob(env.PLATFORM_DB, {
        idempotencyKey: envelope.idempotencyKey,
        errorCode: "UNKNOWN_JOB_TOPIC",
        maxAttempts: effectiveMaxAttempts,
        forceDeadLetter: true,
        nowMs,
      });
      await notifyDeadLetter(
        {
          idempotencyKey: envelope.idempotencyKey,
          topic: envelope.topic,
          tenantId: authoritativeTenantId,
          attempts: failed.attempts,
          maxAttempts: effectiveMaxAttempts,
          errorCode: failed.lastErrorCode,
          correlationId: envelope.correlationId,
          deadLetteredAt: nowMs,
        },
        options,
      );
      emitRedactedLog(logger, {
        event: "job.dead_lettered",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: authoritativeTenantId,
        correlationId: envelope.correlationId,
        attempts: failed.attempts,
        maxAttempts: effectiveMaxAttempts,
        errorCode: failed.lastErrorCode,
        timestamp: nowMs,
      });
      message.ack();
      deadLettered += 1;
      continue;
    }

    const ctx: JobExecutionContext = {
      idempotencyKey: envelope.idempotencyKey,
      topic: envelope.topic,
      tenantId: authoritativeTenantId,
      payload: envelope.payload,
      attempt: lease.attempts,
      maxAttempts: effectiveMaxAttempts,
      correlationId: envelope.correlationId,
      enqueuedAt: envelope.enqueuedAt,
      env,
      nowMs,
    };

    try {
      // On retry or recovered expired lease, reconcile provider state before re-running side effects
      if (lease.attempts > 1 && handler.reconcile) {
        const reconcileResult = await handler.reconcile(ctx);
        if (reconcileResult.state === "completed") {
          await completeJob(env.PLATFORM_DB, {
            idempotencyKey: envelope.idempotencyKey,
            nowMs: now(),
          });
          emitRedactedLog(logger, {
            event: "job.reconciled_completed",
            idempotencyKey: envelope.idempotencyKey,
            topic: envelope.topic,
            tenantId: authoritativeTenantId,
            correlationId: envelope.correlationId,
            attempt: lease.attempts,
            timestamp: now(),
          });
          message.ack();
          completed += 1;
          reconciled += 1;
          continue;
        }
        if (reconcileResult.state === "pending") {
          const pendingError = new UncertainProviderEffectError(
            "Provider effect still pending during reconciliation",
            {
              code: "PROVIDER_RECONCILE_PENDING",
              retryAfterSeconds: reconcileResult.retryAfterSeconds,
              reconcileImmediately: false,
            },
          );
          const failRes = await failJob(env.PLATFORM_DB, {
            idempotencyKey: envelope.idempotencyKey,
            errorCode: pendingError,
            maxAttempts: effectiveMaxAttempts,
            nowMs: now(),
          });
          if (failRes.status === "dead_letter") {
            await notifyDeadLetter(
              {
                idempotencyKey: envelope.idempotencyKey,
                topic: envelope.topic,
                tenantId: authoritativeTenantId,
                attempts: failRes.attempts,
                maxAttempts: effectiveMaxAttempts,
                errorCode: failRes.lastErrorCode,
                correlationId: envelope.correlationId,
                deadLetteredAt: now(),
              },
              options,
            );
            emitRedactedLog(logger, {
              event: "job.dead_lettered",
              idempotencyKey: envelope.idempotencyKey,
              topic: envelope.topic,
              tenantId: authoritativeTenantId,
              correlationId: envelope.correlationId,
              attempts: failRes.attempts,
              maxAttempts: effectiveMaxAttempts,
              errorCode: failRes.lastErrorCode,
              timestamp: now(),
            });
            message.ack();
            deadLettered += 1;
          } else {
            const delaySeconds =
              reconcileResult.retryAfterSeconds !== undefined
                ? clampDelaySeconds(reconcileResult.retryAfterSeconds)
                : computeRetryBackoffSeconds(failRes.attempts, {
                    baseSeconds: baseBackoffSeconds,
                    maxSeconds: maxBackoffSeconds,
                  });
            emitRedactedLog(logger, {
              event: "job.retry_scheduled",
              idempotencyKey: envelope.idempotencyKey,
              topic: envelope.topic,
              tenantId: authoritativeTenantId,
              correlationId: envelope.correlationId,
              attempt: failRes.attempts,
              maxAttempts: effectiveMaxAttempts,
              delaySeconds,
              errorCode: failRes.lastErrorCode,
              timestamp: now(),
            });
            message.retry({ delaySeconds });
            retried += 1;
          }
          continue;
        }
      }

      await handler.execute(ctx);

      await completeJob(env.PLATFORM_DB, {
        idempotencyKey: envelope.idempotencyKey,
        nowMs: now(),
      });
      emitRedactedLog(logger, {
        event: "job.completed",
        idempotencyKey: envelope.idempotencyKey,
        topic: envelope.topic,
        tenantId: authoritativeTenantId,
        correlationId: envelope.correlationId,
        attempt: lease.attempts,
        timestamp: now(),
      });
      message.ack();
      completed += 1;
    } catch (err) {
      // If an uncertain provider error occurs with immediate reconciliation requested
      // (or on the final attempt where no further retry would occur), attempt reconciliation now.
      if (
        err instanceof UncertainProviderEffectError &&
        handler.reconcile &&
        (err.reconcileImmediately || lease.attempts >= effectiveMaxAttempts)
      ) {
        try {
          const rec = await handler.reconcile(ctx);
          if (rec.state === "completed") {
            await completeJob(env.PLATFORM_DB, {
              idempotencyKey: envelope.idempotencyKey,
              nowMs: now(),
            });
            emitRedactedLog(logger, {
              event: "job.reconciled_completed",
              idempotencyKey: envelope.idempotencyKey,
              topic: envelope.topic,
              tenantId: authoritativeTenantId,
              correlationId: envelope.correlationId,
              attempt: lease.attempts,
              timestamp: now(),
            });
            message.ack();
            completed += 1;
            reconciled += 1;
            continue;
          }
        } catch {
          // Fall through to standard retry / dead-letter handling using original error code
        }
      }

      const forceDeadLetter = isNonRetryableError(err);
      const errorCode = sanitizeErrorCode(err);
      const failRes = await failJob(env.PLATFORM_DB, {
        idempotencyKey: envelope.idempotencyKey,
        errorCode,
        maxAttempts: effectiveMaxAttempts,
        forceDeadLetter,
        nowMs: now(),
      });

      if (failRes.status === "dead_letter") {
        await notifyDeadLetter(
          {
            idempotencyKey: envelope.idempotencyKey,
            topic: envelope.topic,
            tenantId: authoritativeTenantId,
            attempts: failRes.attempts,
            maxAttempts: effectiveMaxAttempts,
            errorCode: failRes.lastErrorCode,
            correlationId: envelope.correlationId,
            deadLetteredAt: now(),
          },
          options,
        );
        emitRedactedLog(logger, {
          event: "job.dead_lettered",
          idempotencyKey: envelope.idempotencyKey,
          topic: envelope.topic,
          tenantId: authoritativeTenantId,
          correlationId: envelope.correlationId,
          attempts: failRes.attempts,
          maxAttempts: effectiveMaxAttempts,
          errorCode: failRes.lastErrorCode,
          timestamp: now(),
        });
        message.ack();
        deadLettered += 1;
      } else {
        const delaySeconds =
          err instanceof UncertainProviderEffectError && err.retryAfterSeconds !== undefined
            ? clampDelaySeconds(err.retryAfterSeconds)
            : computeRetryBackoffSeconds(failRes.attempts, {
                baseSeconds: baseBackoffSeconds,
                maxSeconds: maxBackoffSeconds,
              });
        emitRedactedLog(logger, {
          event: "job.retry_scheduled",
          idempotencyKey: envelope.idempotencyKey,
          topic: envelope.topic,
          tenantId: authoritativeTenantId,
          correlationId: envelope.correlationId,
          attempt: failRes.attempts,
          maxAttempts: effectiveMaxAttempts,
          delaySeconds,
          errorCode: failRes.lastErrorCode,
          timestamp: now(),
        });
        message.retry({ delaySeconds });
        retried += 1;
      }
    }
  }

  return {
    total: batch.messages.length,
    completed,
    reconciled,
    deduplicated,
    deferredLeaseActive,
    retried,
    deadLettered,
    rejectedInvalid,
  };
}
