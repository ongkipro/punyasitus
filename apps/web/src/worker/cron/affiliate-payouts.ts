import {
  isAffiliatePayoutBatchDate,
  resolveAffiliatePayoutPeriodKey,
} from "@punyasitus/core/affiliates/commission";
import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  buildBiMonthlyAffiliatePayoutBatches,
  promoteMaturedPendingCommissions,
  type BuildBiMonthlyPayoutBatchesResult,
  type PromoteMaturedPendingCommissionsResult,
} from "@punyasitus/db/affiliates/ledger/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  StructuredJobLogger,
} from "../queues/consumer.ts";
import { DEFAULT_CRON_EXPRESSION, type ScheduledCronJobDefinition } from "./scheduler.ts";

/**
 * Affiliate Commission Hold-Promotion & Bi-Monthly Asia/Jakarta Payout Batch Crons
 * (`apps/web/src/worker/cron/affiliate-payouts.ts`; REQ-085, REQ-086, DEC-045, TASK-085).
 *
 * Invariants:
 * - Daily hold-promotion sweep promotes `pending -> approved` strictly when
 *   `hold_until_at <= nowMs` (14 days) AND `affiliates.status = 'active'`.
 * - Bi-monthly payout batch cron runs on the **15th** and **30th** of each month in
 *   `Asia/Jakarta` (and **28th/29th** on the last day of February), building strictly ONE
 *   `pending_review` batch per active affiliate with net available balance `>= Rp 100.000`.
 * - Both sweeps are 100% idempotent on repeat runs and emit strictly PII-free logs.
 */

export const AFFILIATE_HOLD_PROMOTION_CRON_NAME = "daily-affiliate-hold-promotion" as const;
export const AFFILIATE_HOLD_PROMOTION_CRON_TOPIC = "cron.affiliate_hold_promotion" as const;

export const AFFILIATE_PAYOUT_BATCH_CRON_NAME = "bimonthly-affiliate-payout-batch" as const;
export const AFFILIATE_PAYOUT_BATCH_CRON_TOPIC = "cron.affiliate_payout_batch" as const;

export const AFFILIATE_HOLD_PROMOTION_CRON_JOB_DEFINITION: ScheduledCronJobDefinition = {
  name: AFFILIATE_HOLD_PROMOTION_CRON_NAME,
  cron: DEFAULT_CRON_EXPRESSION,
  topic: AFFILIATE_HOLD_PROMOTION_CRON_TOPIC,
  cadence: "daily",
  tenantId: null,
  maxAttempts: 3,
  buildPayload: (scheduledTimeMs: number) => ({
    scheduledTimeMs,
  }),
};

export const AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION: ScheduledCronJobDefinition = {
  name: AFFILIATE_PAYOUT_BATCH_CRON_NAME,
  cron: DEFAULT_CRON_EXPRESSION,
  topic: AFFILIATE_PAYOUT_BATCH_CRON_TOPIC,
  cadence: "daily",
  tenantId: null,
  maxAttempts: 3,
  shouldRun: (scheduledTimeMs: number) => isAffiliatePayoutBatchDate(scheduledTimeMs),
  buildPayload: (scheduledTimeMs: number) => ({
    scheduledTimeMs,
    payoutPeriodKey: resolveAffiliatePayoutPeriodKey(scheduledTimeMs),
  }),
};

export const AFFILIATE_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  AFFILIATE_HOLD_PROMOTION_CRON_JOB_DEFINITION,
  AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION,
];

export interface AffiliateCronEnv {
  readonly PLATFORM_DB: D1Database;
}

export interface RunAffiliateHoldPromotionSweepOptions {
  readonly nowMs?: number;
  readonly limit?: number;
  readonly requestId?: string | null;
  readonly logger?: StructuredJobLogger;
}

export interface RunBiMonthlyAffiliatePayoutBatchSweepOptions {
  readonly nowMs?: number;
  readonly forceRun?: boolean;
  readonly overridePayoutPeriodKey?: string;
  readonly minimumPayoutIdr?: number;
  readonly requestId?: string | null;
  readonly logger?: StructuredJobLogger;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Executes the daily affiliate 14-day hold promotion sweep (`pending -> approved`).
 */
export async function runAffiliateHoldPromotionSweep(
  env: AffiliateCronEnv,
  options: RunAffiliateHoldPromotionSweepOptions = {},
): Promise<PromoteMaturedPendingCommissionsResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const logger = options.logger ?? defaultLogger;

  const result = await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
    nowMs,
    limit: options.limit,
    requestId: options.requestId ?? null,
  });

  logger(
    redactJobLogRecord({
      event: "affiliate.cron.hold_promotion.completed",
      evaluatedAtMs: result.evaluatedAtMs,
      promotedCount: result.promotedCount,
      skippedSuspendedCount: result.skippedSuspendedCount,
      timestamp: nowMs,
    }),
  );

  return result;
}

const MAX_HOLD_PROMOTION_DRAIN_ITERATIONS = 10 as const;
const MAX_HOLD_PROMOTION_DRAIN_LIMIT = 500 as const;

export interface BiMonthlyAffiliatePayoutBatchSweepResult
  extends BuildBiMonthlyPayoutBatchesResult {
  readonly promotedBeforeBatchCount: number;
}

/**
 * Executes the bi-monthly `Asia/Jakarta` (`15th` / `30th` / Feb `28`/`29`) payout batch builder.
 * Drains matured 14-day hold promotions first (bounded loop) so commissions maturing on the
 * 15th/30th/Feb end never miss that payout cycle!
 */
export async function runBiMonthlyAffiliatePayoutBatchSweep(
  env: AffiliateCronEnv,
  options: RunBiMonthlyAffiliatePayoutBatchSweepOptions = {},
): Promise<BiMonthlyAffiliatePayoutBatchSweepResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const logger = options.logger ?? defaultLogger;

  let promotedBeforeBatchCount = 0;
  if (options.forceRun || isAffiliatePayoutBatchDate(nowMs)) {
    for (let i = 0; i < MAX_HOLD_PROMOTION_DRAIN_ITERATIONS; i += 1) {
      const promo = await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
        nowMs,
        limit: MAX_HOLD_PROMOTION_DRAIN_LIMIT,
        requestId: options.requestId ?? null,
      });
      promotedBeforeBatchCount += promo.promotedCount;
      if (promo.promotedCount < MAX_HOLD_PROMOTION_DRAIN_LIMIT) {
        break;
      }
    }
  }

  const result = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
    nowMs,
    forceRun: options.forceRun,
    overridePayoutPeriodKey: options.overridePayoutPeriodKey,
    minimumPayoutIdr: options.minimumPayoutIdr,
    requestId: options.requestId ?? null,
  });

  logger(
    redactJobLogRecord({
      event: "affiliate.cron.payout_batch.completed",
      ran: result.ran,
      skipReason: result.skipReason,
      payoutPeriodKey: result.payoutPeriodKey,
      promotedBeforeBatchCount,
      createdBatchCount: result.createdBatchCount,
      skippedBelowThresholdCount: result.skippedBelowThresholdCount,
      alreadyBatchedCount: result.alreadyBatchedCount,
      timestamp: nowMs,
    }),
  );

  return {
    ...result,
    promotedBeforeBatchCount,
  };
}

/**
 * Registers both durable affiliate cron handlers (`cron.affiliate_hold_promotion` and
 * `cron.affiliate_payout_batch`) for Worker queue execution.
 */
export function createAffiliatePayoutCronJobRegistry(options?: {
  readonly now?: () => number;
  readonly logger?: StructuredJobLogger;
}): DurableJobRegistry {
  const holdPromotionHandler: DurableJobHandler = {
    maxAttempts: 3,
    async execute(ctx): Promise<void> {
      const scheduledAt =
        typeof ctx.payload.scheduledTimeMs === "number" &&
        Number.isFinite(ctx.payload.scheduledTimeMs)
          ? ctx.payload.scheduledTimeMs
          : options?.now
            ? options.now()
            : ctx.nowMs;

      await runAffiliateHoldPromotionSweep(ctx.env as AffiliateCronEnv, {
        nowMs: scheduledAt,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        logger: options?.logger,
      });
    },
  };

  const payoutBatchHandler: DurableJobHandler = {
    maxAttempts: 3,
    async execute(ctx): Promise<void> {
      const scheduledAt =
        typeof ctx.payload.scheduledTimeMs === "number" &&
        Number.isFinite(ctx.payload.scheduledTimeMs)
          ? ctx.payload.scheduledTimeMs
          : options?.now
            ? options.now()
            : ctx.nowMs;
      const overridePayoutPeriodKey =
        typeof ctx.payload.payoutPeriodKey === "string" && ctx.payload.payoutPeriodKey.trim()
          ? ctx.payload.payoutPeriodKey.trim()
          : undefined;

      await runBiMonthlyAffiliatePayoutBatchSweep(ctx.env as AffiliateCronEnv, {
        nowMs: scheduledAt,
        overridePayoutPeriodKey,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        logger: options?.logger,
      });
    },
  };

  return {
    [AFFILIATE_HOLD_PROMOTION_CRON_TOPIC]: holdPromotionHandler,
    [AFFILIATE_PAYOUT_BATCH_CRON_TOPIC]: payoutBatchHandler,
  };
}
