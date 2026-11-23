import { parseJobEnvelope, redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  DEFAULT_MONTHLY_REPORT_TIMEZONE,
  buildMonthlyReportCronKey,
  buildMonthlyReportMessageKey,
  isFirstDayOfMonth,
  parseReportMonthPeriod,
  resolvePreviousCalendarMonthPeriod,
  type MonthlyReportPeriod,
} from "@punyasitus/core/reports/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { JobQueuePayload } from "../env.d.ts";
import type { DurableJobHandler, StructuredJobLogger } from "../queues/consumer.ts";
import {
  MONTHLY_REPORT_EMAIL_TEMPLATE,
  MONTHLY_REPORT_SEND_TOPIC,
} from "../queues/reports/handler.ts";
import {
  getTenantNotificationPreferences,
  recordMonthlyReportPreClaimSkipIfUnclaimed,
} from "../queues/reports/preferences.ts";
import { DEFAULT_CRON_EXPRESSION, type ScheduledCronJobDefinition } from "./scheduler.ts";

/**
 * Monthly Owner Performance Report Cron Scheduler & Fan-Out Dispatcher
 * (`REQ-110`, `PLAN.md` §20.5, `DEC-041`, `DEC-043`, `TASK-110`).
 *
 * Invariants:
 * - Triggers on the 1st calendar day of each month (UTC / `Asia/Jakarta` WIB aware).
 * - Enqueues AT MOST ONE job per eligible active website per `reportMonth` using deterministic
 *   `idempotencyKey = monthly-report:<tenantId>:<YYYY-MM>` and `maxAttempts = 1` (no blind retry).
 * - Targets ONLY active websites with their own `owner` member (never trial/locked/suspended/purging,
 *   never agencies about other agencies' clients).
 * - Skips opted-out websites before enqueueing and stores ZERO email addresses or visitor PII in `job_ledger`.
 */

export const MONTHLY_REPORT_CRON_JOB_NAME = "monthly-owner-report" as const;
export const MONTHLY_REPORT_CRON_TOPIC = "cron.monthly_owner_report" as const;
export const MAX_MONTHLY_REPORT_TENANTS_PER_SWEEP = 500 as const;

export const MONTHLY_REPORT_CRON_JOB_DEFINITION: ScheduledCronJobDefinition = {
  name: MONTHLY_REPORT_CRON_JOB_NAME,
  cron: DEFAULT_CRON_EXPRESSION,
  topic: MONTHLY_REPORT_CRON_TOPIC,
  cadence: "monthly",
  tenantId: null,
  maxAttempts: 1,
  shouldRun: (scheduledTimeMs: number) =>
    isFirstDayOfMonth(scheduledTimeMs, DEFAULT_MONTHLY_REPORT_TIMEZONE),
  buildPayload: (scheduledTimeMs: number) => {
    const period = resolvePreviousCalendarMonthPeriod(
      scheduledTimeMs,
      DEFAULT_MONTHLY_REPORT_TIMEZONE,
    );
    return {
      reportMonth: period.reportMonth,
      comparisonMonth: period.comparisonMonth,
      timeZone: period.timeZone,
      scheduledTimeMs,
    };
  },
};

export interface MonthlyReportCronEnv {
  readonly PLATFORM_DB: D1Database;
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
}

export interface EnqueueMonthlyReportsOptions {
  readonly nowMs?: number;
  readonly timeZone?: string;
  /** Optional explicit `YYYY-MM` period override (for targeted runs/tests). */
  readonly reportMonth?: string;
  /** When `true`, skips the 1st-of-month calendar guard (for backfill/test invocation). */
  readonly forceRun?: boolean;
  readonly limit?: number;
  readonly logger?: StructuredJobLogger;
}

export interface EnqueueMonthlyReportsResult {
  readonly ran: boolean;
  readonly skipReason: "not_first_day_of_month" | null;
  readonly period: MonthlyReportPeriod;
  readonly cronKey: string;
  readonly scannedActiveTenants: number;
  readonly enqueuedCount: number;
  readonly deduplicatedCount: number;
  readonly skippedOptedOutCount: number;
  readonly enqueuedTenantIds: readonly string[];
  readonly skippedOptedOutTenantIds: readonly string[];
}

interface EligibleActiveTenantRow {
  readonly tenant_id: string;
  readonly handle: string;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Lists active websites that have an own `owner` member (`members.role = 'owner'`),
 * are not under operator hold or scheduled for deletion/offboarding, and have NOT yet
 * been enqueued or claimed for `reportMonth` so sweeps cleanly paginate past the batch cap.
 */
async function listActiveOwnedTenants(
  platformDb: D1Database,
  reportMonth: string,
  limit: number,
): Promise<readonly EligibleActiveTenantRow[]> {
  const safeLimit = Math.max(1, Math.min(MAX_MONTHLY_REPORT_TENANTS_PER_SWEEP, Math.floor(limit)));
  const res = await platformDb
    .prepare(
      `SELECT DISTINCT t.id AS tenant_id, t.handle
       FROM tenants t
       INNER JOIN members m
         ON m.organization_id = t.organization_id
        AND m.role = 'owner'
       INNER JOIN users u
         ON u.id = m.user_id
       WHERE t.status = 'active'
         AND t.operator_hold = 0
         AND t.deletion_due_at IS NULL
         AND t.offboarding_started_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM job_ledger jl
           WHERE jl.idempotency_key = 'monthly-report:' || t.id || ':' || ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM email_delivery_claims edc
           WHERE edc.message_key = 'monthly-report:' || t.id || ':' || ?
         )
       ORDER BY t.created_at ASC, t.id ASC
       LIMIT ?`,
    )
    .bind(reportMonth, reportMonth, safeLimit)
    .all<EligibleActiveTenantRow>();

  return res.results ?? [];
}

/**
 * Fans out one idempotent `reports.monthly_owner.send` job per eligible active website
 * for the previous calendar month (or explicit `options.reportMonth`).
 */
export async function enqueueMonthlyPerformanceReportJobs(
  env: MonthlyReportCronEnv,
  options?: EnqueueMonthlyReportsOptions,
): Promise<EnqueueMonthlyReportsResult> {
  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const timeZone = options?.timeZone ?? DEFAULT_MONTHLY_REPORT_TIMEZONE;
  const logger = options?.logger ?? defaultLogger;

  const period = options?.reportMonth
    ? parseReportMonthPeriod(options.reportMonth, timeZone)
    : resolvePreviousCalendarMonthPeriod(nowMs, timeZone);
  const cronKey = buildMonthlyReportCronKey(period.reportMonth);

  if (!options?.forceRun && !isFirstDayOfMonth(nowMs, period.timeZone)) {
    return {
      ran: false,
      skipReason: "not_first_day_of_month",
      period,
      cronKey,
      scannedActiveTenants: 0,
      enqueuedCount: 0,
      deduplicatedCount: 0,
      skippedOptedOutCount: 0,
      enqueuedTenantIds: [],
      skippedOptedOutTenantIds: [],
    };
  }

  const activeTenants = await listActiveOwnedTenants(
    env.PLATFORM_DB,
    period.reportMonth,
    options?.limit ?? MAX_MONTHLY_REPORT_TENANTS_PER_SWEEP,
  );

  let enqueuedCount = 0;
  let deduplicatedCount = 0;
  let skippedOptedOutCount = 0;
  const enqueuedTenantIds: string[] = [];
  const skippedOptedOutTenantIds: string[] = [];

  for (const tenant of activeTenants) {
    const messageKey = buildMonthlyReportMessageKey(tenant.tenant_id, period.reportMonth);

    // Check owner opt-out before enqueueing (INSERT OR IGNORE never overwrites an existing terminal claim)
    const prefs = await getTenantNotificationPreferences(env.PLATFORM_DB, tenant.tenant_id);
    if (!prefs.monthlyPerformanceReportEnabled) {
      await recordMonthlyReportPreClaimSkipIfUnclaimed(env.PLATFORM_DB, {
        messageKey,
        template: MONTHLY_REPORT_EMAIL_TEMPLATE,
        errorCode: "E_REPORT_OPTED_OUT",
        nowMs,
      });
      skippedOptedOutCount += 1;
      skippedOptedOutTenantIds.push(tenant.tenant_id);
      continue;
    }

    // Store ZERO email PII in job_ledger payload (owner email is looked up live during send)
    const payload = {
      tenantId: tenant.tenant_id,
      reportMonth: period.reportMonth,
      timeZone: period.timeZone,
    };

    const envelope = parseJobEnvelope(
      {
        idempotencyKey: messageKey,
        topic: MONTHLY_REPORT_SEND_TOPIC,
        tenantId: tenant.tenant_id,
        payload,
        maxAttempts: 1,
        correlationId: cronKey,
        enqueuedAt: nowMs,
      },
      { defaultMaxAttempts: 1, nowMs },
    );

    const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
      idempotencyKey: envelope.idempotencyKey,
      topic: envelope.topic,
      tenantId: envelope.tenantId,
      payload: envelope.payload,
      nowMs,
    });

    if (ledgerRes.enqueued) {
      if (env.JOBS_QUEUE) {
        try {
          await env.JOBS_QUEUE.send(envelope as unknown as JobQueuePayload);
        } catch (err) {
          await releaseUnstartedQueuedJob(env.PLATFORM_DB, envelope.idempotencyKey);
          throw err;
        }
      }
      enqueuedCount += 1;
      enqueuedTenantIds.push(tenant.tenant_id);
      logger(
        redactJobLogRecord({
          event: "monthly_report.job_enqueued",
          tenantId: tenant.tenant_id,
          reportMonth: period.reportMonth,
          idempotencyKey: envelope.idempotencyKey,
          timestamp: nowMs,
        }),
      );
    } else {
      deduplicatedCount += 1;
    }
  }

  return {
    ran: true,
    skipReason: null,
    period,
    cronKey,
    scannedActiveTenants: activeTenants.length,
    enqueuedCount,
    deduplicatedCount,
    skippedOptedOutCount,
    enqueuedTenantIds,
    skippedOptedOutTenantIds,
  };
}

/**
 * Creates the `DurableJobHandler` for `cron.monthly_owner_report`, which fans out
 * one idempotent `reports.monthly_owner.send` job per eligible active website.
 */
export function createMonthlyReportCronDispatchHandler(options?: {
  readonly timeZone?: string;
  readonly logger?: StructuredJobLogger;
}): DurableJobHandler {
  return {
    maxAttempts: 1,
    async execute(ctx): Promise<void> {
      const reportMonth =
        typeof ctx.payload.reportMonth === "string" && ctx.payload.reportMonth.trim()
          ? ctx.payload.reportMonth.trim()
          : undefined;
      const timeZone =
        typeof ctx.payload.timeZone === "string" && ctx.payload.timeZone.trim()
          ? ctx.payload.timeZone.trim()
          : options?.timeZone;

      await enqueueMonthlyPerformanceReportJobs(ctx.env as MonthlyReportCronEnv, {
        nowMs: ctx.nowMs,
        reportMonth,
        timeZone,
        forceRun: Boolean(reportMonth),
        logger: options?.logger,
      });
    },
  };
}
