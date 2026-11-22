import { createMessageBatch, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  NonRetryableJobError,
  UncertainProviderEffectError,
  type JobEnvelopeInput,
} from "@punyasitus/core/jobs/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  acquireJobLease,
  enqueueDurableJob,
  getJobLedgerRecord,
  listFailedJobs,
} from "@punyasitus/db/jobs/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_EXPRESSION,
  dispatchScheduledCron,
  type ScheduledCronJobDefinition,
} from "../../apps/web/src/worker/cron/index.ts";
import {
  processDurableQueueBatch,
  type DeadLetterRecord,
  type DurableJobRegistry,
} from "../../apps/web/src/worker/queues/index.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

interface TrackedMessageOutcome {
  readonly id: string;
  acked: boolean;
  retries: Array<{ delaySeconds?: number }>;
}

function buildTrackedBatch(
  messages: readonly { id: string; body: unknown; attempts?: number }[],
): {
  batch: MessageBatch<unknown>;
  outcomes: Map<string, TrackedMessageOutcome>;
} {
  const rawBatch = createMessageBatch(
    "punyasitus-jobs-test",
    messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      body: m.body,
      attempts: m.attempts ?? 1,
    })),
  );

  const outcomes = new Map<string, TrackedMessageOutcome>();
  const wrappedMessages = rawBatch.messages.map((msg) => {
    const tracker: TrackedMessageOutcome = {
      id: msg.id,
      acked: false,
      retries: [],
    };
    outcomes.set(msg.id, tracker);

    return {
      id: msg.id,
      timestamp: msg.timestamp,
      body: msg.body,
      attempts: msg.attempts,
      ack() {
        tracker.acked = true;
        msg.ack();
      },
      retry(opts?: QueueRetryOptions) {
        tracker.retries.push({ delaySeconds: opts?.delaySeconds });
        msg.retry(opts);
      },
    } as Message<unknown>;
  });

  const batch: MessageBatch<unknown> = {
    queue: rawBatch.queue,
    metadata: rawBatch.metadata,
    messages: wrappedMessages,
    ackAll: () => rawBatch.ackAll(),
    retryAll: (opts?: QueueRetryOptions) => rawBatch.retryAll(opts),
  };

  return { batch, outcomes };
}

describe("TASK-028 Durable Jobs on Cloudflare Queues & Cron (workerd)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("executes duplicate Queue deliveries exactly once through PLATFORM_DB.job_ledger", async () => {
    let sideEffectRuns = 0;
    const seenTenants: Array<string | null> = [];
    const logs: Record<string, unknown>[] = [];

    const registry: DurableJobRegistry = {
      "receipt.issue": {
        async execute(ctx) {
          sideEffectRuns += 1;
          seenTenants.push(ctx.tenantId);
        },
      },
    };

    const envelope: JobEnvelopeInput = {
      idempotencyKey: "dup-delivery-001",
      topic: "receipt.issue",
      tenantId: SYNTHETIC_TENANTS[0].id,
      payload: { settlementId: "stl_001" },
      correlationId: "corr-dup-001",
    };

    // Same batch carries two duplicate deliveries
    const first = buildTrackedBatch([
      { id: "m-dup-1", body: envelope, attempts: 1 },
      { id: "m-dup-2", body: envelope, attempts: 2 },
    ]);
    const res1 = await processDurableQueueBatch(first.batch, env, registry, {
      now: () => 1_763_820_000_000,
      logger: (entry) => logs.push(entry),
    });

    expect(res1.completed).toBe(1);
    expect(res1.deduplicated).toBe(1);
    expect(first.outcomes.get("m-dup-1")?.acked).toBe(true);
    expect(first.outcomes.get("m-dup-2")?.acked).toBe(true);

    // A later third delivery in a separate batch is also deduplicated
    const second = buildTrackedBatch([{ id: "m-dup-3", body: envelope, attempts: 3 }]);
    const res2 = await processDurableQueueBatch(second.batch, env, registry, {
      now: () => 1_763_820_010_000,
      logger: (entry) => logs.push(entry),
    });

    expect(res2.completed).toBe(0);
    expect(res2.deduplicated).toBe(1);
    expect(second.outcomes.get("m-dup-3")?.acked).toBe(true);

    expect(sideEffectRuns).toBe(1);
    expect(seenTenants).toEqual([SYNTHETIC_TENANTS[0].id]);

    const row = await getJobLedgerRecord(env.PLATFORM_DB, "dup-delivery-001");
    expect(row?.status).toBe("completed");
    expect(row?.attempts).toBe(1);
    expect(row?.leaseUntil).toBeNull();
    expect(row?.tenantId).toBe(SYNTHETIC_TENANTS[0].id);
  });

  it("blocks concurrent execution on an active unexpired lease and recovers cleanly after lease expiry", async () => {
    const key = "lease-recovery-001";
    const t0 = 1_763_821_000_000;
    const leaseDurationMs = 30_000;
    let executions = 0;
    const observedAttempts: number[] = [];

    // Worker A enqueues and acquires lease, then crashes mid-flight without completing or failing
    const enq = await enqueueDurableJob(env.PLATFORM_DB, {
      idempotencyKey: key,
      topic: "domain.verify",
      tenantId: SYNTHETIC_TENANTS[0].id,
      payload: { host: "alpha.example.id" },
      nowMs: t0,
    });
    expect(enq.enqueued).toBe(true);

    const claimed = await acquireJobLease(env.PLATFORM_DB, {
      idempotencyKey: key,
      nowMs: t0,
      leaseDurationMs,
      maxAttempts: 3,
    });
    expect(claimed.outcome).toBe("acquired");
    if (claimed.outcome === "acquired") {
      expect(claimed.attempts).toBe(1);
      expect(claimed.leaseUntil).toBe(t0 + leaseDurationMs);
    }

    const registry: DurableJobRegistry = {
      "domain.verify": {
        leaseDurationMs,
        async execute(ctx) {
          executions += 1;
          observedAttempts.push(ctx.attempt);
        },
      },
    };

    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: "domain.verify",
      tenantId: SYNTHETIC_TENANTS[0].id,
      payload: { host: "alpha.example.id" },
    };

    // 1. Concurrent delivery while lease is still active (t0 + 10s < t0 + 30s) must defer without executing
    const concurrent = buildTrackedBatch([{ id: "m-lease-active", body: envelope }]);
    const activeRes = await processDurableQueueBatch(concurrent.batch, env, registry, {
      now: () => t0 + 10_000,
      leaseActiveRetryDelaySeconds: 7,
      logger: () => {},
    });

    expect(activeRes.deferredLeaseActive).toBe(1);
    expect(activeRes.completed).toBe(0);
    expect(executions).toBe(0);
    expect(concurrent.outcomes.get("m-lease-active")?.acked).toBe(false);
    expect(concurrent.outcomes.get("m-lease-active")?.retries).toEqual([{ delaySeconds: 7 }]);

    // 2. Delivery after lease expiry (t0 + 35s > t0 + 30s) recovers the lease and completes
    const recovered = buildTrackedBatch([{ id: "m-lease-recovered", body: envelope }]);
    const recoveredRes = await processDurableQueueBatch(recovered.batch, env, registry, {
      now: () => t0 + 35_000,
      logger: () => {},
    });

    expect(recoveredRes.completed).toBe(1);
    expect(executions).toBe(1);
    expect(observedAttempts).toEqual([2]);
    expect(recovered.outcomes.get("m-lease-recovered")?.acked).toBe(true);

    const row = await getJobLedgerRecord(env.PLATFORM_DB, key);
    expect(row?.status).toBe("completed");
    expect(row?.attempts).toBe(2);
    expect(row?.leaseUntil).toBeNull();
  });

  it("caps retries at maxAttempts, transitions to dead_letter with preserved tenantId, and populates sanitized failed-job view", async () => {
    const key = "retry-cap-dlq-001";
    const tenantId = SYNTHETIC_TENANTS[1].id;
    const seenTenantIds: Array<string | null> = [];
    const seenAttempts: number[] = [];
    const deadLetters: DeadLetterRecord[] = [];
    const logs: Record<string, unknown>[] = [];

    const registry: DurableJobRegistry = {
      "billing.advice": {
        maxAttempts: 3,
        async execute(ctx) {
          seenTenantIds.push(ctx.tenantId);
          seenAttempts.push(ctx.attempt);
          const err = new Error(
            "Provider HTTP 503 for owner@beta.example +6281234567890 Bearer sk_live_leak999999",
          ) as Error & { code: string };
          err.code = "E_PROVIDER_503";
          throw err;
        },
      },
      "billing.non_retryable": {
        maxAttempts: 5,
        async execute() {
          throw new NonRetryableJobError(
            "Invalid target password=verysecret email=bad@example.com",
            "E_INVALID_OBLIGATION",
          );
        },
      },
    };

    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: "billing.advice",
      tenantId,
      payload: {
        obligationId: "obl_beta_1",
        apiKey: "sk_live_payload_secret_12345",
        email: "payer@beta.example",
        phone: "+6281299998888",
      },
      maxAttempts: 3,
      correlationId: "corr-retry-001",
    };

    let clock = 1_763_822_000_000;

    // Attempt 1 -> failed, retry with backoff 5s
    const b1 = buildTrackedBatch([{ id: "m-r1", body: envelope, attempts: 1 }]);
    const r1 = await processDurableQueueBatch(b1.batch, env, registry, {
      now: () => clock,
      baseBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      onDeadLetter: (rec) => {
        deadLetters.push(rec);
      },
      logger: (entry) => logs.push(entry),
    });
    expect(r1.retried).toBe(1);
    expect(r1.deadLettered).toBe(0);
    expect(b1.outcomes.get("m-r1")?.retries).toEqual([{ delaySeconds: 5 }]);

    // Attempt 2 -> failed, retry with backoff 10s
    clock += 10_000;
    const b2 = buildTrackedBatch([{ id: "m-r2", body: envelope, attempts: 2 }]);
    const r2 = await processDurableQueueBatch(b2.batch, env, registry, {
      now: () => clock,
      baseBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      onDeadLetter: (rec) => {
        deadLetters.push(rec);
      },
      logger: (entry) => logs.push(entry),
    });
    expect(r2.retried).toBe(1);
    expect(b2.outcomes.get("m-r2")?.retries).toEqual([{ delaySeconds: 10 }]);

    const failedViewMid = await listFailedJobs(env.PLATFORM_DB, {
      tenantId,
      statuses: ["failed"],
    });
    expect(failedViewMid.some((j) => j.idempotencyKey === key && j.status === "failed")).toBe(true);

    // Attempt 3 -> capped -> dead_letter, DLQ sink called, message acked
    clock += 20_000;
    const b3 = buildTrackedBatch([{ id: "m-r3", body: envelope, attempts: 3 }]);
    const r3 = await processDurableQueueBatch(b3.batch, env, registry, {
      now: () => clock,
      baseBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      onDeadLetter: (rec) => {
        deadLetters.push(rec);
      },
      logger: (entry) => logs.push(entry),
    });
    expect(r3.deadLettered).toBe(1);
    expect(r3.retried).toBe(0);
    expect(b3.outcomes.get("m-r3")?.acked).toBe(true);

    // Attempt 4 (stray redelivery) must NOT execute again
    clock += 30_000;
    const b4 = buildTrackedBatch([{ id: "m-r4", body: envelope, attempts: 4 }]);
    const r4 = await processDurableQueueBatch(b4.batch, env, registry, {
      now: () => clock,
      onDeadLetter: (rec) => {
        deadLetters.push(rec);
      },
      logger: (entry) => logs.push(entry),
    });
    expect(r4.deadLettered).toBe(1);
    expect(b4.outcomes.get("m-r4")?.acked).toBe(true);

    // Tenant context survived every retry and dead-letter transition
    expect(seenAttempts).toEqual([1, 2, 3]);
    expect(seenTenantIds).toEqual([tenantId, tenantId, tenantId]);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      idempotencyKey: key,
      topic: "billing.advice",
      tenantId,
      attempts: 3,
      maxAttempts: 3,
      errorCode: "E_PROVIDER_503",
      correlationId: "corr-retry-001",
    });

    // Non-retryable error jumps directly to dead_letter on attempt 1
    const nonRetryBatch = buildTrackedBatch([
      {
        id: "m-non-retry",
        body: {
          idempotencyKey: "non-retry-001",
          topic: "billing.non_retryable",
          tenantId,
          payload: { password: "secret-password-999" },
        },
      },
    ]);
    const nonRetryRes = await processDurableQueueBatch(nonRetryBatch.batch, env, registry, {
      now: () => clock + 1_000,
      onDeadLetter: (rec) => {
        deadLetters.push(rec);
      },
      logger: (entry) => logs.push(entry),
    });
    expect(nonRetryRes.deadLettered).toBe(1);
    expect(nonRetryBatch.outcomes.get("m-non-retry")?.acked).toBe(true);

    // Failed-job view exposes dead_letter rows with sanitized error codes and NO payload_json
    const dlqRows = await listFailedJobs(env.PLATFORM_DB, {
      tenantId,
      statuses: ["dead_letter"],
    });
    const cappedRow = dlqRows.find((r) => r.idempotencyKey === key);
    const nonRetryRow = dlqRows.find((r) => r.idempotencyKey === "non-retry-001");

    expect(cappedRow).toMatchObject({
      idempotencyKey: key,
      topic: "billing.advice",
      tenantId,
      status: "dead_letter",
      attempts: 3,
      lastErrorCode: "E_PROVIDER_503",
    });
    expect(nonRetryRow).toMatchObject({
      idempotencyKey: "non-retry-001",
      topic: "billing.non_retryable",
      tenantId,
      status: "dead_letter",
      attempts: 1,
      lastErrorCode: "E_INVALID_OBLIGATION",
    });
    expect("payloadJson" in (cappedRow ?? {})).toBe(false);
    expect("payload_json" in (cappedRow ?? {})).toBe(false);

    // Assert zero sensitive payload or leaked error strings anywhere in logs, DLQ records, or failed-job view
    const allSurfaces = JSON.stringify({ logs, deadLetters, dlqRows });
    for (const secret of [
      "owner@beta.example",
      "+6281234567890",
      "sk_live_leak999999",
      "sk_live_payload_secret_12345",
      "payer@beta.example",
      "+6281299998888",
      "verysecret",
      "bad@example.com",
      "secret-password-999",
    ]) {
      expect(allSurfaces).not.toContain(secret);
    }
  });

  it("reconciles uncertain provider effects on retry without duplicating the external side effect", async () => {
    const key = "reconcile-uncertain-001";
    const tenantId = SYNTHETIC_TENANTS[0].id;
    const remoteProviderEffects: string[] = [];
    let executeCalls = 0;
    let reconcileCalls = 0;

    const registry: DurableJobRegistry = {
      "payment.autolaris.create": {
        maxAttempts: 3,
        async execute(ctx) {
          executeCalls += 1;
          // External side effect actually succeeded remotely, then response timed out
          remoteProviderEffects.push(`${ctx.tenantId}:${ctx.idempotencyKey}`);
          throw new UncertainProviderEffectError(
            "Socket timeout after POST to provider for customer@example.id +6281111222333",
            {
              code: "E_AUTOLARIS_TIMEOUT",
              provider: "autolaris",
              retryAfterSeconds: 8,
            },
          );
        },
        async reconcile(ctx) {
          reconcileCalls += 1;
          const effectId = `${ctx.tenantId}:${ctx.idempotencyKey}`;
          if (remoteProviderEffects.includes(effectId)) {
            return { state: "completed", externalReference: "al_tx_9001" };
          }
          return { state: "not_applied" };
        },
      },
    };

    const envelope: JobEnvelopeInput = {
      idempotencyKey: key,
      topic: "payment.autolaris.create",
      tenantId,
      payload: { obligationId: "obl_recon_1" },
      maxAttempts: 3,
      correlationId: "corr-recon-1",
    };

    const logs: Record<string, unknown>[] = [];
    const t0 = 1_763_823_000_000;

    // Attempt 1: executes external call -> throws UncertainProviderEffectError -> scheduled for retry
    const attempt1 = buildTrackedBatch([{ id: "m-rec-1", body: envelope, attempts: 1 }]);
    const r1 = await processDurableQueueBatch(attempt1.batch, env, registry, {
      now: () => t0,
      logger: (entry) => logs.push(entry),
    });

    expect(r1.retried).toBe(1);
    expect(r1.completed).toBe(0);
    expect(attempt1.outcomes.get("m-rec-1")?.retries).toEqual([{ delaySeconds: 8 }]);
    expect(executeCalls).toBe(1);
    expect(reconcileCalls).toBe(0);
    expect(remoteProviderEffects).toHaveLength(1);

    const midRow = await getJobLedgerRecord(env.PLATFORM_DB, key);
    expect(midRow?.status).toBe("failed");
    expect(midRow?.lastErrorCode).toBe("E_AUTOLARIS_TIMEOUT");

    // Attempt 2: calls reconcile(ctx) BEFORE execute(ctx), confirms remote completion, avoids duplication
    const attempt2 = buildTrackedBatch([{ id: "m-rec-2", body: envelope, attempts: 2 }]);
    const r2 = await processDurableQueueBatch(attempt2.batch, env, registry, {
      now: () => t0 + 10_000,
      logger: (entry) => logs.push(entry),
    });

    expect(r2.completed).toBe(1);
    expect(r2.reconciled).toBe(1);
    expect(attempt2.outcomes.get("m-rec-2")?.acked).toBe(true);
    expect(reconcileCalls).toBe(1);
    expect(executeCalls).toBe(1); // NEVER duplicated!
    expect(remoteProviderEffects).toHaveLength(1);

    const finalRow = await getJobLedgerRecord(env.PLATFORM_DB, key);
    expect(finalRow?.status).toBe("completed");
    expect(finalRow?.attempts).toBe(2);
    expect(finalRow?.tenantId).toBe(tenantId);

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("customer@example.id");
    expect(serializedLogs).not.toContain("+6281111222333");
  });

  it("enqueues exactly one job per Cron period even when invoked repeatedly in the same period", async () => {
    const definitions: readonly ScheduledCronJobDefinition[] = [
      {
        name: "t028-hourly-sweep",
        cron: DEFAULT_CRON_EXPRESSION,
        topic: "cron.hourly_sweep",
        cadence: "hourly",
        tenantId: null,
      },
      {
        name: "t028-daily-backup",
        cron: DEFAULT_CRON_EXPRESSION,
        topic: "cron.daily_backup",
        cadence: "daily",
        tenantId: null,
      },
    ];

    const sentPayloads: unknown[] = [];
    const trackedQueue = {
      async send(body: unknown) {
        sentPayloads.push(body);
        await env.JOBS_QUEUE.send(body as Parameters<typeof env.JOBS_QUEUE.send>[0]);
      },
    } as unknown as typeof env.JOBS_QUEUE;

    const cronEnv = {
      PLATFORM_DB: env.PLATFORM_DB,
      JOBS_QUEUE: trackedQueue,
    };

    const logs: Record<string, unknown>[] = [];
    const hour16Start = Date.UTC(2026, 10, 22, 16, 7, 0, 0);
    const hour16Duplicate = Date.UTC(2026, 10, 22, 16, 7, 45, 0);
    const hour17 = Date.UTC(2026, 10, 22, 17, 7, 0, 0);
    const nextDay = Date.UTC(2026, 10, 23, 0, 7, 0, 0);

    // 1. First trigger in 2026-11-22T16 -> enqueues 1 hourly + 1 daily (2 total)
    const run1 = await dispatchScheduledCron(
      createScheduledController({ cron: DEFAULT_CRON_EXPRESSION, scheduledTime: hour16Start }),
      cronEnv,
      definitions,
      { now: () => hour16Start, logger: (e) => logs.push(e) },
    );
    expect(run1.enqueuedCount).toBe(2);
    expect(run1.deduplicatedCount).toBe(0);
    expect(sentPayloads).toHaveLength(2);

    // 2. Repeated trigger in the SAME hour (2026-11-22T16) -> 0 enqueued, 2 deduplicated
    const run2 = await dispatchScheduledCron(
      createScheduledController({ cron: DEFAULT_CRON_EXPRESSION, scheduledTime: hour16Duplicate }),
      cronEnv,
      definitions,
      { now: () => hour16Duplicate, logger: (e) => logs.push(e) },
    );
    expect(run2.enqueuedCount).toBe(0);
    expect(run2.deduplicatedCount).toBe(2);
    expect(sentPayloads).toHaveLength(2);

    // 3. Trigger in the NEXT hour (2026-11-22T17) -> 1 new hourly enqueued, daily still deduplicated!
    const run3 = await dispatchScheduledCron(
      createScheduledController({ cron: DEFAULT_CRON_EXPRESSION, scheduledTime: hour17 }),
      cronEnv,
      definitions,
      { now: () => hour17, logger: (e) => logs.push(e) },
    );
    expect(run3.enqueuedCount).toBe(1);
    expect(run3.deduplicatedCount).toBe(1);
    expect(sentPayloads).toHaveLength(3);

    // 4. Trigger on the NEXT UTC day (2026-11-23T00) -> 1 new hourly + 1 new daily enqueued
    const run4 = await dispatchScheduledCron(
      createScheduledController({ cron: DEFAULT_CRON_EXPRESSION, scheduledTime: nextDay }),
      cronEnv,
      definitions,
      { now: () => nextDay, logger: (e) => logs.push(e) },
    );
    expect(run4.enqueuedCount).toBe(2);
    expect(run4.deduplicatedCount).toBe(0);
    expect(sentPayloads).toHaveLength(5);

    const hourlyCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM job_ledger WHERE topic = 'cron.hourly_sweep'",
    ).first<{ cnt: number }>();
    const dailyCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM job_ledger WHERE topic = 'cron.daily_backup'",
    ).first<{ cnt: number }>();

    expect(hourlyCount?.cnt).toBe(3); // 16:00, 17:00, next-day 00:00
    expect(dailyCount?.cnt).toBe(2); // 2026-11-22, 2026-11-23
  });

  it("never leaks sensitive payload or error details from malformed or failing jobs in logs and ledger", async () => {
    const logs: Record<string, unknown>[] = [];
    const key = "sensitive-leak-guard-001";
    const secretJwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.super_secret_sig_999";

    const registry: DurableJobRegistry = {
      "email.notify": {
        maxAttempts: 1,
        async execute() {
          throw new Error(
            `SMTP fail Authorization: Bearer ${secretJwt} cookie=__Host-sid=xyz987654 email=victim@example.id phone=+6285712345678`,
          );
        },
      },
    };

    const batch = buildTrackedBatch([
      {
        id: "m-invalid",
        body: {
          notAnEnvelope: true,
          password: "RawInvalidPassword123!",
          email: "invalid-body@example.id",
        },
      },
      {
        id: "m-sensitive",
        body: {
          idempotencyKey: key,
          topic: "email.notify",
          tenantId: SYNTHETIC_TENANTS[0].id,
          payload: {
            password: "PayloadPassword456!",
            token: secretJwt,
            email: "victim@example.id",
            phone: "+6285712345678",
          },
        },
      },
    ]);

    const res = await processDurableQueueBatch(batch.batch, env, registry, {
      now: () => 1_763_824_000_000,
      logger: (entry) => logs.push(entry),
    });

    expect(res.rejectedInvalid).toBe(1);
    expect(res.deadLettered).toBe(1);

    const record = await getJobLedgerRecord(env.PLATFORM_DB, key);
    const failedRows = await listFailedJobs(env.PLATFORM_DB, {
      topic: "email.notify",
    });

    expect(record?.lastErrorCode).toBe("JOB_EXECUTION_ERROR");
    expect(failedRows[0]?.lastErrorCode).toBe("JOB_EXECUTION_ERROR");

    const combined = JSON.stringify({ logs, record, failedRows });
    for (const leaked of [
      secretJwt,
      "xyz987654",
      "victim@example.id",
      "+6285712345678",
      "RawInvalidPassword123!",
      "invalid-body@example.id",
      "PayloadPassword456!",
    ]) {
      expect(combined).not.toContain(leaked);
    }
  });
});
