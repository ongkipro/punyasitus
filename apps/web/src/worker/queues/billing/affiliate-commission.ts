import { redactBillingLogRecord } from "@punyasitus/core/billing/index";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import {
  recordConfirmedPaymentCommission,
  type RecordConfirmedPaymentCommissionResult,
} from "@punyasitus/db/affiliates/ledger/index";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import type { DurableJobHandler, JobExecutionContext, StructuredJobLogger } from "../consumer.ts";

/**
 * Confirmed-Settlement Affiliate Commission Hook & Queue Handler
 * (`apps/web/src/worker/queues/billing/affiliate-commission.ts`; REQ-085, TASK-085).
 *
 * Hard invariants:
 * - Strictly idempotent per confirmed payment (`paymentAttemptId` / `settlementId` / `receiptId`).
 * - ONLY exact missing-table errors (`no such table: affiliate_commission_entries` or
 *   `no such table: affiliate_referrals`) are treated as a pre-0032 schema skip (`skipped_pre_0032`).
 * - Any real runtime/D1/audit error on a migrated DB is NEVER silently swallowed:
 *   when a durable `jobsQueue` producer is available, it enqueues a deduplicated
 *   `billing.affiliate.commission` retry job (`maxAttempts: 3`) and emits a redacted error log;
 *   if no queue producer is available (or enqueue itself fails), the error is rethrown!
 * - All structured log events are PII-free and redacted.
 */

export const BILLING_AFFILIATE_COMMISSION_TOPIC = "billing.affiliate.commission" as const;

export interface AffiliateCommissionQueueBinding {
  send(message: unknown): Promise<unknown>;
}

export interface RecordSettlementAffiliateCommissionParams {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly settlementId: string;
  readonly paymentAttemptId?: string | null;
  readonly obligationId?: string | null;
  readonly receiptId?: string | null;
  readonly confirmedAtMs?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
  readonly jobsQueue?: AffiliateCommissionQueueBinding | null;
  readonly logger?: StructuredJobLogger;
}

export interface SettlementAffiliateCommissionHookResult {
  readonly status: "created" | "duplicate" | "ineligible" | "skipped_pre_0032" | "enqueued_retry";
  readonly commissionEntryId: string | null;
  readonly entryKind: "first_payment" | "renewal" | null;
  readonly commissionIdr: number | null;
  readonly reason?: string;
}

/**
 * Matches ONLY exact pre-0032 missing-table errors so real D1/audit failures are never masked.
 */
function isPre0032MissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table:\s*(?:affiliate_commission_entries|affiliate_referrals)\b/i.test(msg);
}

/**
 * Enqueues a deduplicated durable `billing.affiliate.commission` retry job (`maxAttempts: 3`)
 * into `PLATFORM_DB.job_ledger` and `JOBS_QUEUE`.
 */
export async function enqueueBillingAffiliateCommission(
  env: {
    readonly PLATFORM_DB: D1Database;
    readonly JOBS_QUEUE: AffiliateCommissionQueueBinding;
  },
  input: {
    readonly tenantId: string;
    readonly settlementId: string;
    readonly paymentAttemptId?: string | null;
    readonly obligationId?: string | null;
    readonly receiptId?: string | null;
    readonly confirmedAtMs?: number;
    readonly correlationId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
  readonly topic: typeof BILLING_AFFILIATE_COMMISSION_TOPIC;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const idempotencyKey = `billing-affiliate-commission:settlement:${input.settlementId.trim()}`;
  const payload: Record<string, unknown> = {
    tenantId: input.tenantId.trim(),
    settlementId: input.settlementId.trim(),
    ...(input.paymentAttemptId ? { paymentAttemptId: input.paymentAttemptId } : {}),
    ...(input.obligationId ? { obligationId: input.obligationId } : {}),
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
    ...(typeof input.confirmedAtMs === "number" ? { confirmedAtMs: input.confirmedAtMs } : {}),
  };

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey,
    topic: BILLING_AFFILIATE_COMMISSION_TOPIC,
    tenantId: input.tenantId.trim(),
    payload,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      idempotencyKey,
      topic: BILLING_AFFILIATE_COMMISSION_TOPIC,
    };
  }

  const envelope: JobEnvelopeInput = {
    idempotencyKey,
    topic: BILLING_AFFILIATE_COMMISSION_TOPIC,
    tenantId: input.tenantId.trim(),
    payload,
    maxAttempts: 3,
    correlationId: input.correlationId ?? idempotencyKey,
    enqueuedAt: nowMs,
  };

  try {
    await env.JOBS_QUEUE.send(envelope);
  } catch (err) {
    await releaseUnstartedQueuedJob(env.PLATFORM_DB, idempotencyKey);
    throw err;
  }

  return {
    enqueued: true,
    idempotencyKey,
    topic: BILLING_AFFILIATE_COMMISSION_TOPIC,
  };
}

/**
 * Records (or idempotently deduplicates) the affiliate commission entry for an
 * authoritatively confirmed settlement.
 *
 * - Pre-0032 schemas without `affiliate_commission_entries`/`affiliate_referrals` return `skipped_pre_0032`.
 * - Any real runtime/D1/audit error either enqueues a durable `billing.affiliate.commission`
 *   retry job (when `jobsQueue` is provided) or rethrows so commissions are NEVER silently lost!
 */
export async function recordAffiliateCommissionForSettledPayment(
  params: RecordSettlementAffiliateCommissionParams,
): Promise<SettlementAffiliateCommissionHookResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  try {
    const res: RecordConfirmedPaymentCommissionResult = await recordConfirmedPaymentCommission(
      params.db,
      {
        tenantId: params.tenantId,
        settlementId: params.settlementId,
        paymentAttemptId: params.paymentAttemptId ?? null,
        obligationId: params.obligationId ?? null,
        receiptId: params.receiptId ?? null,
        confirmedAtMs: params.confirmedAtMs,
        requestId: params.requestId ?? null,
        nowMs,
      },
    );

    if (res.status === "created" || res.status === "duplicate") {
      params.logger?.(
        redactBillingLogRecord({
          event: `billing.affiliate.commission.${res.status}`,
          tenantId: params.tenantId,
          settlementId: params.settlementId,
          paymentAttemptId: params.paymentAttemptId ?? null,
          commissionEntryId: res.entry.id,
          affiliateId: res.entry.affiliateId,
          entryKind: res.entry.entryKind,
          commissionIdr: res.entry.commissionIdr,
          timestamp: nowMs,
        }),
      );
      return {
        status: res.status,
        commissionEntryId: res.entry.id,
        entryKind:
          res.entry.entryKind === "first_payment" || res.entry.entryKind === "renewal"
            ? res.entry.entryKind
            : null,
        commissionIdr: res.entry.commissionIdr,
      };
    }

    return {
      status: "ineligible",
      commissionEntryId: null,
      entryKind: null,
      commissionIdr: null,
      reason: res.reason,
    };
  } catch (err) {
    if (isPre0032MissingTableError(err)) {
      return {
        status: "skipped_pre_0032",
        commissionEntryId: null,
        entryKind: null,
        commissionIdr: null,
        reason: "pre_0032_schema",
      };
    }

    const errorCode = err instanceof Error ? err.name : "UNKNOWN_ERROR";
    params.logger?.(
      redactBillingLogRecord({
        event: "billing.affiliate.commission.error",
        tenantId: params.tenantId,
        settlementId: params.settlementId,
        paymentAttemptId: params.paymentAttemptId ?? null,
        errorCode,
        hasRetryQueue: Boolean(params.jobsQueue),
        timestamp: nowMs,
      }),
    );

    if (params.jobsQueue) {
      await enqueueBillingAffiliateCommission(
        { PLATFORM_DB: params.db, JOBS_QUEUE: params.jobsQueue },
        {
          tenantId: params.tenantId,
          settlementId: params.settlementId,
          paymentAttemptId: params.paymentAttemptId ?? null,
          obligationId: params.obligationId ?? null,
          receiptId: params.receiptId ?? null,
          confirmedAtMs: params.confirmedAtMs,
          correlationId: params.requestId ?? params.settlementId,
          nowMs,
        },
      );
      return {
        status: "enqueued_retry",
        commissionEntryId: null,
        entryKind: null,
        commissionIdr: null,
        reason: "enqueued_durable_retry",
      };
    }

    throw err;
  }
}

/**
 * Durable queue handler for `billing.affiliate.commission` jobs (durable retry / backfill).
 */
export function createBillingAffiliateCommissionHandler(options?: {
  readonly now?: () => number;
  readonly logger?: StructuredJobLogger;
}): DurableJobHandler {
  return {
    maxAttempts: 3,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const tenantId =
        typeof ctx.payload.tenantId === "string" && ctx.payload.tenantId.trim()
          ? ctx.payload.tenantId.trim()
          : (ctx.tenantId ?? "");
      const settlementId =
        typeof ctx.payload.settlementId === "string" && ctx.payload.settlementId.trim()
          ? ctx.payload.settlementId.trim()
          : "";
      const paymentAttemptId =
        typeof ctx.payload.paymentAttemptId === "string" && ctx.payload.paymentAttemptId.trim()
          ? ctx.payload.paymentAttemptId.trim()
          : null;
      const obligationId =
        typeof ctx.payload.obligationId === "string" && ctx.payload.obligationId.trim()
          ? ctx.payload.obligationId.trim()
          : null;
      const receiptId =
        typeof ctx.payload.receiptId === "string" && ctx.payload.receiptId.trim()
          ? ctx.payload.receiptId.trim()
          : null;
      const confirmedAtMs =
        typeof ctx.payload.confirmedAtMs === "number" && Number.isFinite(ctx.payload.confirmedAtMs)
          ? ctx.payload.confirmedAtMs
          : undefined;

      if (!tenantId || !settlementId) {
        return;
      }

      await recordConfirmedPaymentCommission(ctx.env.PLATFORM_DB, {
        tenantId,
        settlementId,
        paymentAttemptId,
        obligationId,
        receiptId,
        confirmedAtMs,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        nowMs: options?.now ? options.now() : ctx.nowMs,
      });

      options?.logger?.(
        redactBillingLogRecord({
          event: "billing.affiliate.commission.job_completed",
          tenantId,
          settlementId,
          timestamp: options?.now ? options.now() : ctx.nowMs,
        }),
      );
    },
  };
}
