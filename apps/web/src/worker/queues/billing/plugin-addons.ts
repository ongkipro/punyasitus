import {
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  type AdviceSettlementPolicy,
  type RawAutoLarisAdviceObservation,
} from "@punyasitus/core/billing/advice";
import { redactBillingLogRecord } from "@punyasitus/core/billing/index";
import {
  recordConfirmedPaymentCommission,
  type RecordConfirmedPaymentCommissionResult,
} from "@punyasitus/db/affiliates/ledger/index";
import {
  expireLapsedPluginAddons,
  settlePluginAddonOrder,
  type ExpireLapsedPluginAddonsResult,
  type SettlePluginAddonOrderResult,
} from "@punyasitus/db/plugins/store/index";
import type { DurableJobHandler, JobExecutionContext, StructuredJobLogger } from "../consumer.ts";

/**
 * Plugin Add-on AutoLaris Advice Settlement, Affiliate Commission Attribution &
 * Lapsed Add-on Expiry Sweep Worker (`apps/web/src/worker/queues/billing/plugin-addons.ts`;
 * REQ-098, REQ-085, ADR-0010, TASK-098).
 *
 * Financial & Data-Preservation Invariants:
 * 1. Confirmed plugin add-on settlements call `settlePluginAddonOrder` atomically (marking
 *    order `settled`, activating/extending entitlement, issuing gap-free numbered PDF receipt)
 *    and then credit affiliate commission via TASK-085 `recordConfirmedPaymentCommission`
 *    when the tenant is eligible (100% idempotent on `receiptId`; agency-billed orders earn 0).
 * 2. Duplicate Advice deliveries NEVER bump receipt counters, NEVER double-extend expiry,
 *    and NEVER duplicate affiliate commission entries.
 * 3. `runPluginAddonExpirySweep` marks lapsed `paid_monthly`/`paid_yearly` add-on entitlements
 *    `status = 'expired', enabled = 0` WITHOUT deleting any `plg_*` rows in `TenantStore`.
 */

export const BILLING_PLUGIN_ADDON_SETTLE_TOPIC = "billing.plugin_addon.settle" as const;
export const BILLING_PLUGIN_ADDON_EXPIRY_TOPIC = "billing.plugin_addon.expiry_sweep" as const;

export interface PluginAddonAffiliateCommissionOutcome {
  readonly status: "created" | "duplicate" | "ineligible" | "skipped_pre_0032";
  readonly commissionEntryId: string | null;
  readonly entryKind: "first_payment" | "renewal" | null;
  readonly commissionIdr: number | null;
  readonly reason?: string;
}

export interface ProcessPluginAddonSettlementParams {
  readonly db: D1Database;
  readonly orderId: string;
  readonly tenantId?: string;
  readonly payerAgencyId?: string | null;
  readonly observation: RawAutoLarisAdviceObservation;
  readonly policy?: AdviceSettlementPolicy;
  readonly mediaBucket?: R2Bucket | null;
  readonly tenantDb?: D1Database | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
  readonly logger?: StructuredJobLogger;
}

export interface ProcessPluginAddonSettlementResult extends SettlePluginAddonOrderResult {
  readonly affiliateCommission: PluginAddonAffiliateCommissionOutcome | null;
}

function isPre0032MissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table:\s*(?:affiliate_commission_entries|affiliate_referrals|affiliates)\b/i.test(
    msg,
  );
}

/**
 * Credits affiliate commission (TASK-085) for a settled commercial plugin add-on receipt.
 * Uses `receiptId` as the canonical idempotency anchor and passes `grossAmountIdr = gross + fee`
 * so `recordConfirmedPaymentCommission` computes exact net commissionable base (`gross - discount`).
 */
export async function creditAffiliateCommissionForPluginAddonReceipt(params: {
  readonly db: D1Database;
  readonly settlement: SettlePluginAddonOrderResult;
  readonly requestId?: string | null;
  readonly nowMs: number;
  readonly logger?: StructuredJobLogger;
}): Promise<PluginAddonAffiliateCommissionOutcome | null> {
  if (!params.settlement.settled || !params.settlement.receipt) {
    return null;
  }

  const { order, receipt } = params.settlement;

  // Agency-billed client purchases are never eligible for affiliate commission (REQ-084/085)
  if (order.payerKind === "agency" || order.payerAgencyId !== null) {
    return {
      status: "ineligible",
      commissionEntryId: null,
      entryKind: null,
      commissionIdr: null,
      reason: "agency_managed_tenant",
    };
  }

  try {
    const res: RecordConfirmedPaymentCommissionResult = await recordConfirmedPaymentCommission(
      params.db,
      {
        tenantId: order.tenantId,
        receiptId: receipt.id,
        settlementId: null,
        paymentAttemptId: null,
        obligationId: null,
        isConfirmed: true,
        grossAmountIdr: order.grossAmountIdr + order.channelFeeIdr,
        discountAmountIdr: order.discountAmountIdr,
        ppnAmountIdr: 0,
        channelFeeIdr: order.channelFeeIdr,
        confirmedAtMs: order.settledAtMs ?? params.nowMs,
        requestId: params.requestId ?? null,
        nowMs: params.nowMs,
      },
    );

    if (res.status === "created" || res.status === "duplicate") {
      params.logger?.(
        redactBillingLogRecord({
          event: `billing.plugin_addon.affiliate_commission.${res.status}`,
          tenantId: order.tenantId,
          orderId: order.id,
          receiptId: receipt.id,
          commissionEntryId: res.entry.id,
          entryKind: res.entry.entryKind,
          commissionIdr: res.entry.commissionIdr,
          timestamp: params.nowMs,
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
    throw err;
  }
}

/**
 * End-to-end plugin add-on AutoLaris Advice settlement pipeline:
 * 1. Atomically settles order, activates/extends entitlement, issues numbered PDF receipt
 * 2. Idempotently credits affiliate commission when tenant is referred & eligible
 */
export async function processPluginAddonAdviceSettlement(
  params: ProcessPluginAddonSettlementParams,
): Promise<ProcessPluginAddonSettlementResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const settlement = await settlePluginAddonOrder(params.db, {
    orderId: params.orderId,
    tenantId: params.tenantId,
    payerAgencyId: params.payerAgencyId,
    observation: params.observation,
    policy: params.policy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
    mediaBucket: params.mediaBucket ?? null,
    tenantDb: params.tenantDb ?? null,
    requestId: params.requestId ?? null,
    nowMs,
  });

  let affiliateCommission: PluginAddonAffiliateCommissionOutcome | null = null;
  if (settlement.settled && settlement.receipt) {
    affiliateCommission = await creditAffiliateCommissionForPluginAddonReceipt({
      db: params.db,
      settlement,
      requestId: params.requestId ?? null,
      nowMs,
      logger: params.logger,
    });
  }

  params.logger?.(
    redactBillingLogRecord({
      event: "billing.plugin_addon.advice_processed",
      orderId: params.orderId,
      tenantId: settlement.order.tenantId,
      pluginSlug: settlement.order.pluginSlug,
      settled: settlement.settled,
      idempotentReplay: settlement.idempotentReplay,
      decisionKind: settlement.decisionKind,
      receiptNumber: settlement.receipt?.receiptNumber ?? null,
      affiliateStatus: affiliateCommission?.status ?? null,
      timestamp: nowMs,
    }),
  );

  return {
    ...settlement,
    affiliateCommission,
  };
}

export async function runPluginAddonExpirySweep(
  db: D1Database,
  options: {
    readonly nowMs?: number;
    readonly limit?: number;
    readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
    readonly requestId?: string | null;
    readonly logger?: StructuredJobLogger;
  } = {},
): Promise<ExpireLapsedPluginAddonsResult> {
  const result = await expireLapsedPluginAddons(db, {
    nowMs: options.nowMs,
    limit: options.limit,
    resolveTenantDb: options.resolveTenantDb,
    requestId: options.requestId,
  });

  options.logger?.(
    redactBillingLogRecord({
      event: "billing.plugin_addon.expiry_sweep_completed",
      evaluatedAtMs: result.evaluatedAtMs,
      expiredCount: result.expiredCount,
      plgDataPreserved: true,
    }),
  );

  return result;
}

export function createPluginAddonExpirySweepHandler(options?: {
  readonly now?: () => number;
  readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
  readonly logger?: StructuredJobLogger;
}): DurableJobHandler {
  return {
    maxAttempts: 3,
    async execute(ctx: JobExecutionContext): Promise<void> {
      await runPluginAddonExpirySweep(ctx.env.PLATFORM_DB, {
        nowMs: options?.now ? options.now() : ctx.nowMs,
        resolveTenantDb: options?.resolveTenantDb,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        logger: options?.logger,
      });
    },
  };
}
