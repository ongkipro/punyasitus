import {
  buildCronPeriodKey,
  DEFAULT_MAX_JOB_ATTEMPTS,
  parseJobEnvelope,
  redactJobLogRecord,
  type CronCadence,
} from "@punyasitus/core/jobs/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { JobQueuePayload, PunyasitusEnv } from "../env.d.ts";

export const DEFAULT_CRON_EXPRESSION = "7 * * * *" as const;

export type ScheduledCronEnv = Pick<PunyasitusEnv, "PLATFORM_DB" | "JOBS_QUEUE">;

export interface ScheduledCronJobDefinition {
  readonly name: string;
  readonly cron: string;
  readonly topic: string;
  readonly cadence: CronCadence;
  readonly tenantId?: string | null;
  readonly maxAttempts?: number;
  readonly shouldRun?: (scheduledTimeMs: number) => boolean;
  readonly buildPayload?: (scheduledTimeMs: number) => Record<string, unknown>;
}

export const SEO_INDEXNOW_CRON_JOB_DEFINITION: ScheduledCronJobDefinition = {
  name: "hourly-seo-indexnow-flush",
  cron: DEFAULT_CRON_EXPRESSION,
  topic: "seo.indexnow_flush",
  cadence: "hourly",
  tenantId: null,
  maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
};

export const DEFAULT_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  {
    name: "hourly-housekeeping",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: "cron.hourly_housekeeping",
    cadence: "hourly",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
  },
  {
    name: "daily-platform-backup",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: "cron.daily_platform_backup",
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
  },
  SEO_INDEXNOW_CRON_JOB_DEFINITION,
];

export interface DispatchScheduledCronOptions {
  readonly now?: () => number;
  readonly logger?: (entry: Record<string, unknown>) => void;
}

export interface ScheduledCronJobDispatchOutcome {
  readonly name: string;
  readonly topic: string;
  readonly idempotencyKey: string;
  readonly enqueued: boolean;
}

export interface DispatchScheduledCronResult {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly matchedDefinitions: number;
  readonly enqueuedCount: number;
  readonly deduplicatedCount: number;
  readonly jobs: readonly ScheduledCronJobDispatchOutcome[];
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Dispatches periodic Cloudflare Cron triggers into `PLATFORM_DB.job_ledger` and `env.JOBS_QUEUE`.
 * Uses deterministic period idempotency keys and only sends to `JOBS_QUEUE` when `enqueued === true`,
 * guaranteeing repeated Cron invocations in the same period enqueue at most one durable job.
 */
export async function dispatchScheduledCron(
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: ScheduledCronEnv,
  definitions: readonly ScheduledCronJobDefinition[] = DEFAULT_CRON_JOB_DEFINITIONS,
  options?: DispatchScheduledCronOptions,
): Promise<DispatchScheduledCronResult> {
  const now = options?.now ?? (() => Date.now());
  const logger = options?.logger ?? defaultLogger;
  const scheduledTimeMs = controller.scheduledTime;

  const matched = definitions.filter(
    (def) => def.cron === controller.cron && (!def.shouldRun || def.shouldRun(scheduledTimeMs)),
  );

  const jobs: ScheduledCronJobDispatchOutcome[] = [];
  let enqueuedCount = 0;
  let deduplicatedCount = 0;

  for (const def of matched) {
    const nowMs = now();
    const idempotencyKey = buildCronPeriodKey(def.name, scheduledTimeMs, def.cadence);
    const tenantId = def.tenantId ?? null;
    const payload = def.buildPayload ? def.buildPayload(scheduledTimeMs) : {};

    const envelope = parseJobEnvelope(
      {
        idempotencyKey,
        topic: def.topic,
        tenantId,
        payload,
        maxAttempts: def.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
        correlationId: idempotencyKey,
        enqueuedAt: nowMs,
      },
      { nowMs },
    );

    const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
      idempotencyKey: envelope.idempotencyKey,
      topic: envelope.topic,
      tenantId: envelope.tenantId,
      payload: envelope.payload,
      nowMs,
    });

    if (ledgerRes.enqueued) {
      try {
        await env.JOBS_QUEUE.send(envelope as unknown as JobQueuePayload);
      } catch (err) {
        // Roll back the untouched queued row so a subsequent trigger in this period can recover
        await releaseUnstartedQueuedJob(env.PLATFORM_DB, envelope.idempotencyKey);
        throw err;
      }

      enqueuedCount += 1;
      logger(
        redactJobLogRecord({
          event: "cron.job_enqueued",
          cron: controller.cron,
          jobName: def.name,
          topic: def.topic,
          tenantId,
          idempotencyKey,
          scheduledTime: scheduledTimeMs,
          timestamp: nowMs,
        }),
      );
    } else {
      deduplicatedCount += 1;
      logger(
        redactJobLogRecord({
          event: "cron.job_deduplicated",
          cron: controller.cron,
          jobName: def.name,
          topic: def.topic,
          tenantId,
          idempotencyKey,
          scheduledTime: scheduledTimeMs,
          timestamp: nowMs,
        }),
      );
    }

    jobs.push({
      name: def.name,
      topic: def.topic,
      idempotencyKey,
      enqueued: ledgerRes.enqueued,
    });
  }

  return {
    cron: controller.cron,
    scheduledTime: scheduledTimeMs,
    matchedDefinitions: matched.length,
    enqueuedCount,
    deduplicatedCount,
    jobs,
  };
}
