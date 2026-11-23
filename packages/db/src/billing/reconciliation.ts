import {
  AUTOLARIS_DEFAULT_ACCOUNT_ID,
  BILLING_CURRENCY,
  BillingConflictError,
  BillingNotFoundError,
  BillingValidationError,
  DEFAULT_EXPIRED_GRACE_POLL_WINDOW_MS,
  assertExactIdrInteger,
  clampAdviceBatchLimit,
  clampAdviceLeaseMs,
  clampAdviceMaxPolls,
  generateBillingUlid,
  type AllowedPaymentChannelKind,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import {
  PlatformAuditError,
  buildPlatformAuditStatement,
  redactAuditText,
  validateOperatorReason,
} from "../platform/audit.ts";
import { applyVerifiedEntitlementGrant } from "./entitlements.ts";
import { ensureBillingObligationsSchema } from "./migrations.ts";
import {
  closeBillingObligationNonPaid,
  type BillingObligationApiState,
  type PaymentAttemptLifecycleState,
} from "./repository.ts";

/**
 * Atomic D1 Advice reconciliation persistence, bounded polling leases,
 * exactly-once settlement + entitlement grants, operator review/refund recording,
 * and strictly redacted console queries (REQ-057, PLAN §16.3, §16.4; TASK-056).
 *
 * Hard invariants:
 * - At most ONE settlement and ONE entitlement grant per `obligation_id`, enforced
 *   both by conditional SQL and SQLite unique indexes.
 * - Confirmed settlement composes `settlements`, `payment_attempts`, `billing_obligations`,
 *   `entitlement_grants`, `tenants`, and `platform_audit` inside ONE atomic `db.batch([...])`
 *   via `applyVerifiedEntitlementGrant` so an audit failure rolls back EVERY mutation.
 * - Manual operator holds (`operator_hold = 1`) survive payment settlement.
 * - Terminal/non-commercial states (`provisioning`, `purging`, `purged`, `recovery`) are
 *   never resurrected.
 * - Paid attempts are NEVER downgraded by late/out-of-order pending, expired, or failed statuses.
 * - Console query projections NEVER select or expose QRIS payloads, VA numbers, payment
 *   redirect URLs, raw provider payloads, API keys, or customer PII.
 */

const BILLING_RECONCILIATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS billing_reconciliation_leases (
    payment_attempt_id TEXT PRIMARY KEY REFERENCES payment_attempts(id),
    obligation_id TEXT NOT NULL REFERENCES billing_obligations(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
    max_polls INTEGER NOT NULL DEFAULT 24 CHECK (max_polls >= 1),
    next_poll_after INTEGER NOT NULL DEFAULT 0,
    last_polled_at INTEGER,
    last_provider_rc TEXT,
    last_provider_status TEXT,
    last_outcome TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS billing_reconciliation_leases_schedule_idx
    ON billing_reconciliation_leases(lease_expires_at, next_poll_after)`,
  `CREATE TABLE IF NOT EXISTS billing_refund_records (
    id TEXT PRIMARY KEY,
    obligation_id TEXT NOT NULL REFERENCES billing_obligations(id),
    payment_attempt_id TEXT REFERENCES payment_attempts(id),
    settlement_id TEXT REFERENCES settlements(id),
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    refund_kind TEXT NOT NULL CHECK (refund_kind IN ('duplicate_payment', 'mistaken_payment', 'late_post_purge')),
    amount_idr INTEGER NOT NULL CHECK (amount_idr > 0 AND amount_idr <= 999999999999),
    external_reference TEXT,
    reason TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS billing_refund_records_attempt_uidx
    ON billing_refund_records(payment_attempt_id)
    WHERE payment_attempt_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS billing_refund_records_tenant_idx
    ON billing_refund_records(tenant_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS settlements_one_per_obligation_uidx
    ON settlements(obligation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS entitlement_grants_settlement_uidx
    ON entitlement_grants(settlement_id)
    WHERE settlement_id IS NOT NULL`,
] as const;

export async function ensureBillingReconciliationSchema(
  db: D1Database,
  now: () => number = Date.now,
): Promise<void> {
  await ensureBillingObligationsSchema(db, now);
  for (const sql of BILLING_RECONCILIATION_SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
}

function wrapAuditOrThrow(err: unknown): never {
  if (err instanceof PlatformAuditError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/platform_audit|audit/i.test(msg)) {
    throw new PlatformAuditError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan log audit platform; seluruh perubahan billing dibatalkan.",
      err,
    );
  }
  throw err;
}

async function hasCouponRedemptionsTableSafe(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coupon_redemptions' LIMIT 1",
    )
    .first<{ readonly name: string }>();
  return Boolean(row);
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

export interface ReconcilableAttemptRecord {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly plan: BillingPlanInterval;
  readonly obligationDbStatus: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly obligationReviewRequired: boolean;
  readonly providerAccountId: string;
  readonly providerTransactionId: string | null;
  readonly reffId: string;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly lifecycleState: PaymentAttemptLifecycleState;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly safeFailureCode: string | null;
  readonly expiresAtMs: number | null;
  readonly createdAtMs: number;
  readonly pollCount: number;
  readonly maxPolls: number;
  readonly lastPolledAtMs: number | null;
  readonly lastProviderRc: string | null;
  readonly lastProviderStatus: string | null;
  readonly lastOutcome: string | null;
}

interface ReconcilableAttemptSqlRow {
  readonly attempt_id: string;
  readonly obligation_id: string;
  readonly tenant_id: string;
  readonly tenant_handle: string;
  readonly tenant_status: TenantStatus;
  readonly operator_hold: number;
  readonly plan_interval: "monthly" | "yearly" | "one_time";
  readonly obligation_status: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly review_required: number | null;
  readonly provider_account_id: string | null;
  readonly provider_transaction_id: string | null;
  readonly reff_id: string | null;
  readonly channel: "QRIS" | "VA";
  readonly channel_code: string | null;
  readonly lifecycle_state: PaymentAttemptLifecycleState | null;
  readonly raw_state: string;
  readonly base_amount_idr: number | null;
  readonly discount_amount_idr: number | null;
  readonly channel_fee_idr: number | null;
  readonly total_payable_idr: number | null;
  readonly amount_idr: number;
  readonly safe_failure_code: string | null;
  readonly expires_at: number | null;
  readonly created_at: number;
  readonly poll_count: number | null;
  readonly max_polls: number | null;
  readonly last_polled_at: number | null;
  readonly last_provider_rc: string | null;
  readonly last_provider_status: string | null;
  readonly last_outcome: string | null;
}

const RECONCILABLE_ATTEMPT_SELECT_SQL = `
  SELECT
    pa.id AS attempt_id,
    pa.obligation_id,
    pa.tenant_id,
    t.handle AS tenant_handle,
    t.status AS tenant_status,
    t.operator_hold,
    bo.plan_interval,
    bo.status AS obligation_status,
    bo.review_required,
    pa.provider_account_id,
    pa.provider_transaction_id,
    pa.reff_id,
    pa.channel,
    pa.channel_code,
    pa.lifecycle_state,
    pa.state AS raw_state,
    pa.base_amount_idr,
    pa.discount_amount_idr,
    pa.channel_fee_idr,
    pa.total_payable_idr,
    pa.amount_idr,
    pa.safe_failure_code,
    pa.expires_at,
    pa.created_at,
    brl.poll_count,
    brl.max_polls,
    brl.last_polled_at,
    brl.last_provider_rc,
    brl.last_provider_status,
    brl.last_outcome
  FROM payment_attempts pa
  INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id AND bo.tenant_id = pa.tenant_id
  INNER JOIN tenants t ON t.id = pa.tenant_id
  LEFT JOIN billing_reconciliation_leases brl ON brl.payment_attempt_id = pa.id
`;

function mapReconcilableAttemptRow(row: ReconcilableAttemptSqlRow): ReconcilableAttemptRecord {
  const lifecycleState: PaymentAttemptLifecycleState =
    row.lifecycle_state ??
    (row.raw_state === "settled"
      ? "paid"
      : row.raw_state === "pending"
        ? "pending"
        : row.raw_state === "expired"
          ? "expired"
          : row.raw_state === "failed"
            ? "failed"
            : "creating");
  const totalPayableIdr =
    row.total_payable_idr && row.total_payable_idr > 0 ? row.total_payable_idr : row.amount_idr;

  return {
    attemptId: row.attempt_id,
    obligationId: row.obligation_id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantStatus: row.tenant_status,
    operatorHold: row.operator_hold === 1,
    plan: row.plan_interval === "yearly" ? "yearly" : "monthly",
    obligationDbStatus: row.obligation_status,
    obligationReviewRequired: row.review_required === 1,
    providerAccountId: row.provider_account_id ?? AUTOLARIS_DEFAULT_ACCOUNT_ID,
    providerTransactionId: row.provider_transaction_id,
    reffId: row.reff_id ?? row.attempt_id,
    channelKind: row.channel,
    channelCode: row.channel_code ?? row.channel,
    lifecycleState,
    baseAmountIdr: row.base_amount_idr ?? row.amount_idr,
    discountAmountIdr: row.discount_amount_idr ?? 0,
    channelFeeIdr: row.channel_fee_idr ?? 0,
    totalPayableIdr,
    safeFailureCode: row.safe_failure_code,
    expiresAtMs: row.expires_at,
    createdAtMs: row.created_at,
    pollCount: row.poll_count ?? 0,
    maxPolls: row.max_polls ?? 24,
    lastPolledAtMs: row.last_polled_at,
    lastProviderRc: row.last_provider_rc,
    lastProviderStatus: row.last_provider_status,
    lastOutcome: row.last_outcome,
  };
}

export async function getReconcilableAttemptById(
  db: D1Database,
  attemptId: string,
  options?: { readonly tenantId?: string },
): Promise<ReconcilableAttemptRecord | null> {
  await ensureBillingReconciliationSchema(db);
  const row = options?.tenantId
    ? await db
        .prepare(`${RECONCILABLE_ATTEMPT_SELECT_SQL} WHERE pa.id = ? AND pa.tenant_id = ? LIMIT 1`)
        .bind(attemptId, options.tenantId)
        .first<ReconcilableAttemptSqlRow>()
    : await db
        .prepare(`${RECONCILABLE_ATTEMPT_SELECT_SQL} WHERE pa.id = ? LIMIT 1`)
        .bind(attemptId)
        .first<ReconcilableAttemptSqlRow>();
  return row ? mapReconcilableAttemptRow(row) : null;
}

export async function getLatestReconcilableAttemptForObligation(
  db: D1Database,
  obligationId: string,
  options?: { readonly tenantId?: string },
): Promise<ReconcilableAttemptRecord | null> {
  await ensureBillingReconciliationSchema(db);
  const row = options?.tenantId
    ? await db
        .prepare(
          `${RECONCILABLE_ATTEMPT_SELECT_SQL}
           WHERE pa.obligation_id = ? AND pa.tenant_id = ?
           ORDER BY pa.created_at DESC
           LIMIT 1`,
        )
        .bind(obligationId, options.tenantId)
        .first<ReconcilableAttemptSqlRow>()
    : await db
        .prepare(
          `${RECONCILABLE_ATTEMPT_SELECT_SQL}
           WHERE pa.obligation_id = ?
           ORDER BY pa.created_at DESC
           LIMIT 1`,
        )
        .bind(obligationId)
        .first<ReconcilableAttemptSqlRow>();
  return row ? mapReconcilableAttemptRow(row) : null;
}

export interface AcquireAdviceBatchInput {
  readonly workerId: string;
  readonly nowMs: number;
  readonly batchLimit?: number;
  readonly leaseDurationMs?: number;
  readonly maxPolls?: number;
  readonly expiredGraceWindowMs?: number;
  readonly providerAccountId?: string;
}

/**
 * Atomically acquires bounded leases (`lease_expires_at`) on up to `batchLimit`
 * reconcilable payment attempts (`pending`, `creation_unknown`, or recently-expired
 * open attempts) respecting `next_poll_after` and `maxPolls` ceilings.
 *
 * Concurrency safety: Two concurrent sweeps calling this function simultaneously
 * race on conditional SQLite `UPDATE ... WHERE lease_expires_at IS NULL OR lease_expires_at <= ?`,
 * so each attempt is leased to AT MOST ONE worker at a time.
 */
export async function acquireAdviceReconciliationBatch(
  db: D1Database,
  input: AcquireAdviceBatchInput,
): Promise<readonly ReconcilableAttemptRecord[]> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);

  const nowMs = Math.trunc(input.nowMs);
  const workerId = input.workerId.trim().slice(0, 80) || `worker_${generateBillingUlid(nowMs)}`;
  const batchLimit = clampAdviceBatchLimit(input.batchLimit);
  const leaseDurationMs = clampAdviceLeaseMs(input.leaseDurationMs);
  const maxPolls = clampAdviceMaxPolls(input.maxPolls);
  const expiredCutoffMs = nowMs - Math.max(0, Math.trunc(input.expiredGraceWindowMs ?? DEFAULT_EXPIRED_GRACE_POLL_WINDOW_MS));
  const leaseExpiresAt = nowMs + leaseDurationMs;

  const accountClause = input.providerAccountId ? "AND pa.provider_account_id = ?" : "";
  const scanLimit = Math.min(100, batchLimit * 2);

  const bindings: (string | number)[] = [
    expiredCutoffMs,
    nowMs,
    nowMs,
    maxPolls,
  ];
  if (input.providerAccountId) {
    bindings.push(input.providerAccountId);
  }
  bindings.push(scanLimit);

  const candidatesRes = await db
    .prepare(
      `${RECONCILABLE_ATTEMPT_SELECT_SQL}
       WHERE (
         pa.lifecycle_state IN ('pending', 'creation_unknown')
         OR (
           pa.lifecycle_state = 'expired'
           AND bo.status = 'open'
           AND (pa.expires_at IS NULL OR pa.expires_at >= ?)
         )
       )
       AND (brl.lease_expires_at IS NULL OR brl.lease_expires_at <= ?)
       AND COALESCE(brl.next_poll_after, 0) <= ?
       AND COALESCE(brl.poll_count, 0) < ?
       ${accountClause}
       ORDER BY COALESCE(brl.last_polled_at, 0) ASC, pa.created_at ASC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<ReconcilableAttemptSqlRow>();

  const claimed: ReconcilableAttemptRecord[] = [];
  for (const candidate of candidatesRes.results ?? []) {
    if (claimed.length >= batchLimit) break;

    // Atomic two-statement lease claim: ensure row exists, then CAS-claim only if unleased/expired
    const [, claimRes] = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO billing_reconciliation_leases (
             payment_attempt_id, obligation_id, tenant_id,
             lease_owner, lease_expires_at, poll_count, max_polls,
             next_poll_after, last_polled_at, last_provider_rc,
             last_provider_status, last_outcome, updated_at
           ) VALUES (?, ?, ?, NULL, NULL, 0, ?, 0, NULL, NULL, NULL, NULL, ?)`,
        )
        .bind(candidate.attempt_id, candidate.obligation_id, candidate.tenant_id, maxPolls, nowMs),
      db
        .prepare(
          `UPDATE billing_reconciliation_leases
           SET lease_owner = ?,
               lease_expires_at = ?,
               max_polls = ?,
               updated_at = ?
           WHERE payment_attempt_id = ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             AND next_poll_after <= ?
             AND poll_count < ?`,
        )
        .bind(
          workerId,
          leaseExpiresAt,
          maxPolls,
          nowMs,
          candidate.attempt_id,
          nowMs,
          nowMs,
          maxPolls,
        ),
    ]);

    if ((claimRes?.meta?.changes ?? 0) === 1) {
      claimed.push(mapReconcilableAttemptRow({ ...candidate, max_polls: maxPolls }));
    }
  }

  return claimed;
}

export async function releaseAdviceLeaseAndRecordPoll(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly workerId: string | null;
    readonly nowMs: number;
    readonly nextPollAfterMs: number;
    readonly providerRc: string | null;
    readonly providerStatus: string | null;
    readonly outcome: string;
    readonly incrementPollCount?: boolean;
    readonly maxPolls?: number;
  },
): Promise<void> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);

  const nowMs = Math.trunc(input.nowMs);
  const nextPollAfter = Math.max(0, Math.trunc(input.nextPollAfterMs));
  const maxPolls = clampAdviceMaxPolls(input.maxPolls);
  const delta = input.incrementPollCount === false ? 0 : 1;
  const safeRc = input.providerRc ? redactAuditText(input.providerRc).slice(0, 32) : null;
  const safeStatus = input.providerStatus ? redactAuditText(input.providerStatus).slice(0, 64) : null;
  const safeOutcome = redactAuditText(input.outcome).slice(0, 64);

  const insertIgnoreStmt = db
    .prepare(
      `INSERT OR IGNORE INTO billing_reconciliation_leases (
         payment_attempt_id, obligation_id, tenant_id,
         lease_owner, lease_expires_at, poll_count, max_polls,
         next_poll_after, last_polled_at, last_provider_rc,
         last_provider_status, last_outcome, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 0, ?, 0, NULL, NULL, NULL, NULL, ?)`,
    )
    .bind(input.attemptId, input.obligationId, input.tenantId, maxPolls, nowMs);

  const updateStmt = input.workerId
    ? db
        .prepare(
          `UPDATE billing_reconciliation_leases
           SET lease_owner = NULL,
               lease_expires_at = NULL,
               poll_count = poll_count + ?,
               next_poll_after = ?,
               last_polled_at = ?,
               last_provider_rc = ?,
               last_provider_status = ?,
               last_outcome = ?,
               updated_at = ?
           WHERE payment_attempt_id = ?
             AND (lease_owner = ? OR lease_owner IS NULL)`,
        )
        .bind(
          delta,
          nextPollAfter,
          nowMs,
          safeRc,
          safeStatus,
          safeOutcome,
          nowMs,
          input.attemptId,
          input.workerId,
        )
    : db
        .prepare(
          `UPDATE billing_reconciliation_leases
           SET lease_owner = NULL,
               lease_expires_at = NULL,
               poll_count = poll_count + ?,
               next_poll_after = ?,
               last_polled_at = ?,
               last_provider_rc = ?,
               last_provider_status = ?,
               last_outcome = ?,
               updated_at = ?
           WHERE payment_attempt_id = ?`,
        )
        .bind(
          delta,
          nextPollAfter,
          nowMs,
          safeRc,
          safeStatus,
          safeOutcome,
          nowMs,
          input.attemptId,
        );

  await db.batch([insertIgnoreStmt, updateStmt]);
}

export interface SettleVerifiedPaymentAttemptInput {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly plan: BillingPlanInterval;
  readonly verifiedAmountIdr: number;
  readonly providerTransactionId: string;
  readonly providerStatus: string;
  readonly policyProfile: string;
  readonly policyVersion: string;
  readonly settledAtMs: number;
  readonly reconciledVia: "advice";
  readonly actorUserId: string | null;
  readonly actorRole: "system" | "platform_operator";
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly nowMs: number;
}

export type SettleVerifiedPaymentAttemptResult =
  | {
      readonly outcome: "settled";
      readonly grantApplied: true;
      readonly alreadyGranted: false;
      readonly settlementId: string;
      readonly grantId: string;
      readonly auditId: string | null;
      readonly nextTenantStatus: TenantStatus;
      readonly operatorHoldPreserved: boolean;
      readonly periodStartAtMs: number;
      readonly periodEndAtMs: number;
      readonly paidThroughMs: number;
    }
  | {
      readonly outcome: "already_settled";
      readonly grantApplied: false;
      readonly alreadyGranted: true;
      readonly settlementId: string;
      readonly grantId: string | null;
      readonly auditId: string | null;
    }
  | {
      readonly outcome: "review";
      readonly grantApplied: false;
      readonly alreadyGranted: false;
      readonly reasonCode: string;
      readonly deferredTerminalState?: boolean;
      readonly auditId: string | null;
    };

async function findSettlementForObligation(
  db: D1Database,
  obligationId: string,
): Promise<{
  readonly id: string;
  readonly payment_attempt_id: string;
  readonly grant_id: string | null;
} | null> {
  return db
    .prepare(
      `SELECT s.id, s.payment_attempt_id, eg.id AS grant_id
       FROM settlements s
       LEFT JOIN entitlement_grants eg ON eg.settlement_id = s.id
       WHERE s.obligation_id = ?
       LIMIT 1`,
    )
    .bind(obligationId)
    .first<{
      readonly id: string;
      readonly payment_attempt_id: string;
      readonly grant_id: string | null;
    }>();
}

/**
 * Atomically transitions a verified payment attempt + obligation to `paid`,
 * inserts the `settlements` row, applies the exactly-once entitlement grant via
 * `applyVerifiedEntitlementGrant`, and appends a redacted `platform_audit` row
 * inside ONE single D1 transaction (`db.batch`).
 *
 * Guarantees:
 * - At most 1 settlement and 1 entitlement grant per obligation (even under
 *   concurrent duplicate Advice calls, expiry-sweep races, or multi-attempt races).
 * - Late settlement after an obligation was already paid or replaced routes to
 *   `review` with 0 additional grants.
 * - Manual operator holds (`operator_hold = 1`) survive payment settlement.
 * - Terminal/non-commercial states (`provisioning`, `purging`, `purged`, `recovery`)
 *   are never resurrected (attempt routes to `review`, 0 grants).
 * - Any `platform_audit` write failure rolls back the entire transaction!
 */
export async function settleVerifiedPaymentAttempt(
  db: D1Database,
  input: SettleVerifiedPaymentAttemptInput,
): Promise<SettleVerifiedPaymentAttemptResult> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);

  const nowMs = Math.trunc(input.nowMs);
  const verifiedAmountIdr = assertExactIdrInteger(input.verifiedAmountIdr, "verifiedAmountIdr", {
    min: 1,
  });

  // 1. Check existing settlement for this obligation first (fast path for duplicate/late notifications)
  const existingSettlement = await findSettlementForObligation(db, input.obligationId);
  if (existingSettlement) {
    if (existingSettlement.payment_attempt_id === input.attemptId) {
      let auditId: string | null = null;
      if (input.actorRole === "platform_operator") {
        const { statement, entry } = buildPlatformAuditStatement(db, {
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          action: "console.billing.advice_recheck",
          targetType: "payment_attempt",
          targetId: input.attemptId,
          tenantId: input.tenantId,
          reason: input.reason ?? null,
          requireReason: true,
          outcome: "success",
          requestId: input.requestId ?? null,
          metadata: {
            obligationId: input.obligationId,
            settlementId: existingSettlement.id,
            grantId: existingSettlement.grant_id,
            idempotentAlreadySettled: true,
          },
          createdAtMs: nowMs,
        });
        try {
          await statement.run();
        } catch (err) {
          wrapAuditOrThrow(err);
        }
        auditId = entry.id;
      }
      return {
        outcome: "already_settled",
        grantApplied: false,
        alreadyGranted: true,
        settlementId: existingSettlement.id,
        grantId: existingSettlement.grant_id,
        auditId,
      };
    }

    // Late settlement on a DIFFERENT attempt of an already-paid obligation -> safe review, 0 second grants!
    const reviewRes = await markAttemptReviewFromAdvice(db, {
      attemptId: input.attemptId,
      obligationId: input.obligationId,
      tenantId: input.tenantId,
      safeFailureCode: "LATE_DUPLICATE_SETTLEMENT",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      reason: input.reason ?? null,
      requireReason: input.actorRole === "platform_operator",
      requestId: input.requestId ?? null,
      nowMs,
      metadata: {
        existingSettlementId: existingSettlement.id,
        existingPaymentAttemptId: existingSettlement.payment_attempt_id,
        providerTransactionId: input.providerTransactionId,
        providerStatus: input.providerStatus,
        verifiedAmountIdr,
      },
    });
    return {
      outcome: "review",
      grantApplied: false,
      alreadyGranted: false,
      reasonCode: "LATE_DUPLICATE_SETTLEMENT",
      auditId: reviewRes.auditId,
    };
  }

  // 2. Guard against late settlement of an expired attempt when a newer replacement attempt is active
  const replacementAttempt = await db
    .prepare(
      `SELECT id, lifecycle_state
       FROM payment_attempts
       WHERE obligation_id = ?
         AND tenant_id = ?
         AND id != ?
         AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review', 'paid')
       LIMIT 1`,
    )
    .bind(input.obligationId, input.tenantId, input.attemptId)
    .first<{ readonly id: string; readonly lifecycle_state: string }>();

  if (replacementAttempt) {
    const reviewRes = await markAttemptReviewFromAdvice(db, {
      attemptId: input.attemptId,
      obligationId: input.obligationId,
      tenantId: input.tenantId,
      safeFailureCode: "LATE_SETTLEMENT_AFTER_REPLACEMENT",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      reason: input.reason ?? null,
      requireReason: input.actorRole === "platform_operator",
      requestId: input.requestId ?? null,
      nowMs,
      metadata: {
        replacementAttemptId: replacementAttempt.id,
        replacementState: replacementAttempt.lifecycle_state,
        providerTransactionId: input.providerTransactionId,
        verifiedAmountIdr,
      },
    });
    return {
      outcome: "review",
      grantApplied: false,
      alreadyGranted: false,
      reasonCode: "LATE_SETTLEMENT_AFTER_REPLACEMENT",
      auditId: reviewRes.auditId,
    };
  }

  // 3. Atomic single-batch settlement + entitlement grant + coupon consume + tenant update + audit
  //    via TASK-059's `applyVerifiedEntitlementGrant`!
  const settlementId = `stl_${generateBillingUlid(nowMs)}`;
  const grantedBy = input.actorUserId ?? "system:advice_reconciler";
  const hasCouponTable = await hasCouponRedemptionsTableSafe(db);

  let grantResult;
  try {
    grantResult = await applyVerifiedEntitlementGrant(db, {
      tenantId: input.tenantId,
      settlementId,
      plan: input.plan,
      grantedBy,
      nowMs,
      maxCasRetries: 5,
      requireSettlementRow: true,
      conditionalAuditOnTenantUpdate: true,
      auditAction:
        input.actorRole === "platform_operator"
          ? "console.billing.advice_recheck_settled"
          : "billing.advice.settlement_applied",
      auditActorRole: input.actorRole,
      auditRequestId: input.requestId ?? null,
      auditReason: input.reason ?? null,
      auditMetadata: {
        obligationId: input.obligationId,
        attemptId: input.attemptId,
        providerTransactionId: input.providerTransactionId,
        providerStatus: input.providerStatus,
        policyProfile: input.policyProfile,
        policyVersion: input.policyVersion,
        verifiedAmountIdr,
        reconciledVia: input.reconciledVia,
      },
      preGrantStatements: ({ tenantRow }) => [
        // 3a. Insert settlement ONLY if obligation has no settlement yet, is open, and tenant version matches
        db
          .prepare(
            `INSERT INTO settlements (
               id, obligation_id, payment_attempt_id, tenant_id,
               amount_idr, settled_at, reconciled_via, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM settlements WHERE obligation_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM settlements WHERE payment_attempt_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM billing_obligations
               WHERE id = ? AND tenant_id = ? AND status = 'open'
             )
             AND EXISTS (
               SELECT 1 FROM payment_attempts
               WHERE id = ? AND obligation_id = ? AND tenant_id = ?
                 AND lifecycle_state IN ('pending', 'expired', 'creation_unknown', 'review')
             )
             AND EXISTS (
               SELECT 1 FROM tenants
               WHERE id = ? AND version = ?
                 AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
                 AND offboarding_started_at IS NULL
             )`,
          )
          .bind(
            settlementId,
            input.obligationId,
            input.attemptId,
            input.tenantId,
            verifiedAmountIdr,
            Math.trunc(input.settledAtMs),
            input.reconciledVia,
            nowMs,
            input.obligationId,
            input.attemptId,
            input.obligationId,
            input.tenantId,
            input.attemptId,
            input.obligationId,
            input.tenantId,
            tenantRow.id,
            tenantRow.version,
          ),
        // 3b. Mark payment_attempt paid ONLY if our settlement row was inserted above
        db
          .prepare(
            `UPDATE payment_attempts
             SET state = 'settled',
                 lifecycle_state = 'paid',
                 safe_failure_code = NULL,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND obligation_id = ?
               AND tenant_id = ?
               AND EXISTS (
                 SELECT 1 FROM settlements WHERE id = ? AND payment_attempt_id = ?
               )`,
          )
          .bind(
            nowMs,
            input.attemptId,
            input.obligationId,
            input.tenantId,
            settlementId,
            input.attemptId,
          ),
        // 3c. Mark billing_obligation paid ONLY if our settlement row was inserted above
        db
          .prepare(
            `UPDATE billing_obligations
             SET status = 'paid',
                 paid_at = ?,
                 review_required = 0,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND tenant_id = ?
               AND status = 'open'
               AND EXISTS (
                 SELECT 1 FROM settlements WHERE id = ? AND obligation_id = ?
               )`,
          )
          .bind(
            Math.trunc(input.settledAtMs),
            nowMs,
            input.obligationId,
            input.tenantId,
            settlementId,
            input.obligationId,
          ),
        // 3d. Transition any reserved promotional coupon redemption to 'consumed' atomically
        //     inside the same settlement batch (tolerates pre-0010 harnesses cleanly).
        ...(hasCouponTable
          ? [
              db
                .prepare(
                  `UPDATE coupon_redemptions
                   SET status = 'consumed',
                       updated_at = ?
                   WHERE obligation_id = ?
                     AND status = 'reserved'
                     AND EXISTS (
                       SELECT 1 FROM settlements WHERE id = ? AND obligation_id = ?
                     )`,
                )
                .bind(nowMs, input.obligationId, settlementId, input.obligationId),
            ]
          : []),
      ],
      onDeferredTerminalStateStatements: () => [
        db
          .prepare(
            `UPDATE payment_attempts
             SET lifecycle_state = 'review',
                 safe_failure_code = 'TERMINAL_TENANT_LATE_SETTLEMENT',
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND obligation_id = ? AND tenant_id = ? AND lifecycle_state != 'paid'`,
          )
          .bind(nowMs, input.attemptId, input.obligationId, input.tenantId),
        db
          .prepare(
            `UPDATE billing_obligations
             SET review_required = 1,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
          )
          .bind(nowMs, input.obligationId, input.tenantId),
      ],
    });
  } catch (err) {
    // Check if another concurrent settlement beat us to this obligation during the CAS loop
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENTITLEMENT_CAS_CONFLICT")) {
      const raced = await findSettlementForObligation(db, input.obligationId);
      if (raced) {
        if (raced.payment_attempt_id === input.attemptId) {
          return {
            outcome: "already_settled",
            grantApplied: false,
            alreadyGranted: true,
            settlementId: raced.id,
            grantId: raced.grant_id,
            auditId: null,
          };
        }
        const reviewRes = await markAttemptReviewFromAdvice(db, {
          attemptId: input.attemptId,
          obligationId: input.obligationId,
          tenantId: input.tenantId,
          safeFailureCode: "LATE_DUPLICATE_SETTLEMENT",
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          reason: input.reason ?? null,
          requireReason: input.actorRole === "platform_operator",
          requestId: input.requestId ?? null,
          nowMs,
          metadata: {
            existingSettlementId: raced.id,
            existingPaymentAttemptId: raced.payment_attempt_id,
            providerTransactionId: input.providerTransactionId,
          },
        });
        return {
          outcome: "review",
          grantApplied: false,
          alreadyGranted: false,
          reasonCode: "LATE_DUPLICATE_SETTLEMENT",
          auditId: reviewRes.auditId,
        };
      }
    }
    wrapAuditOrThrow(err);
  }

  if (grantResult.deferredTerminalState) {
    return {
      outcome: "review",
      grantApplied: false,
      alreadyGranted: false,
      reasonCode: "TERMINAL_TENANT_LATE_SETTLEMENT",
      deferredTerminalState: true,
      auditId: grantResult.auditId ?? null,
    };
  }

  if (grantResult.alreadyGranted) {
    return {
      outcome: "already_settled",
      grantApplied: false,
      alreadyGranted: true,
      settlementId: grantResult.settlementId,
      grantId: grantResult.grantId,
      auditId: grantResult.auditId ?? null,
    };
  }

  return {
    outcome: "settled",
    grantApplied: true,
    alreadyGranted: false,
    settlementId: grantResult.settlementId,
    grantId: grantResult.grantId!,
    auditId: grantResult.auditId ?? null,
    nextTenantStatus: grantResult.nextStatus,
    operatorHoldPreserved: grantResult.operatorHoldPreserved,
    periodStartAtMs: grantResult.periodStartAtMs,
    periodEndAtMs: grantResult.periodEndAtMs,
    paidThroughMs: grantResult.paidThroughMs,
  };
}

/**
 * Atomically transitions a non-paid attempt to `review`, flags `billing_obligations.review_required = 1`,
 * and appends a redacted `platform_audit` row. NEVER downgrades an already-`paid` attempt; rolls back
 * completely if audit persistence fails.
 */
export async function markAttemptReviewFromAdvice(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly safeFailureCode: string;
    readonly actorUserId: string | null;
    readonly actorRole: "system" | "platform_operator";
    readonly reason?: string | null;
    readonly requireReason?: boolean;
    readonly requestId?: string | null;
    readonly nowMs: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<{ readonly updated: boolean; readonly auditId: string }> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);
  const nowMs = Math.trunc(input.nowMs);
  const safeCode = redactAuditText(input.safeFailureCode).slice(0, 64) || "ADVICE_REVIEW_REQUIRED";

  const updateAttemptStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET lifecycle_state = 'review',
           safe_failure_code = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state != 'paid'`,
    )
    .bind(safeCode, nowMs, input.attemptId, input.obligationId, input.tenantId);

  const updateObligationStmt = db
    .prepare(
      `UPDATE billing_obligations
       SET review_required = 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .bind(nowMs, input.obligationId, input.tenantId);

  const { statement: auditStmt, entry } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action:
      input.actorRole === "platform_operator"
        ? "console.billing.advice_recheck_review"
        : "billing.advice.review_flagged",
    targetType: "payment_attempt",
    targetId: input.attemptId,
    tenantId: input.tenantId,
    reason: input.reason ?? null,
    requireReason: input.requireReason ?? false,
    outcome: "error",
    requestId: input.requestId ?? null,
    metadata: {
      ...input.metadata,
      obligationId: input.obligationId,
      safeFailureCode: safeCode,
    },
    createdAtMs: nowMs,
  });

  try {
    const [attemptRes] = await db.batch([updateAttemptStmt, updateObligationStmt, auditStmt]);
    return {
      updated: (attemptRes?.meta?.changes ?? 0) === 1,
      auditId: entry.id,
    };
  } catch (err) {
    wrapAuditOrThrow(err);
  }
}

/**
 * Atomically transitions a non-paid/non-review attempt to `expired` or `failed` based on
 * Advice status. NEVER downgrades `paid` or `review` attempts; rolls back if audit fails.
 */
export async function markAttemptClosedFromAdvice(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly targetState: "expired" | "failed";
    readonly safeFailureCode: string;
    readonly actorUserId: string | null;
    readonly actorRole: "system" | "platform_operator";
    readonly reason?: string | null;
    readonly requireReason?: boolean;
    readonly requestId?: string | null;
    readonly nowMs: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<{ readonly updated: boolean; readonly auditId: string | null }> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);
  const nowMs = Math.trunc(input.nowMs);
  const safeCode = redactAuditText(input.safeFailureCode).slice(0, 64);

  const updateAttemptStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET state = ?,
           lifecycle_state = ?,
           safe_failure_code = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state NOT IN ('paid', 'review')`,
    )
    .bind(
      input.targetState,
      input.targetState,
      safeCode,
      nowMs,
      input.attemptId,
      input.obligationId,
      input.tenantId,
    );

  const { statement: auditStmt, entry } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action:
        input.actorRole === "platform_operator"
          ? `console.billing.advice_recheck_${input.targetState}`
          : `billing.advice.attempt_${input.targetState}`,
      targetType: "payment_attempt",
      targetId: input.attemptId,
      tenantId: input.tenantId,
      reason: input.reason ?? null,
      requireReason: input.requireReason ?? false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        ...input.metadata,
        obligationId: input.obligationId,
        targetState: input.targetState,
        safeFailureCode: safeCode,
      },
      createdAtMs: nowMs,
    },
    input.actorRole === "platform_operator" ? undefined : { onlyIfPreviousChanged: true },
  );

  try {
    const [attemptRes, auditRes] = await db.batch([updateAttemptStmt, auditStmt]);
    const updated = (attemptRes?.meta?.changes ?? 0) === 1;
    // If the parent obligation has passed its due_at TTL and has no other active attempts,
    // close the obligation terminally to 'expired' and atomically release any reserved coupon.
    if (updated) {
      const oblDue = await db
        .prepare(
          `SELECT due_at
           FROM billing_obligations
           WHERE id = ? AND tenant_id = ? AND status = 'open' AND review_required = 0
           LIMIT 1`,
        )
        .bind(input.obligationId, input.tenantId)
        .first<{ readonly due_at: number }>();
      if (oblDue && oblDue.due_at <= nowMs) {
        await closeBillingObligationNonPaid(db, {
          obligationId: input.obligationId,
          tenantId: input.tenantId,
          targetStatus: "expired",
          nowMs,
        });
      }
    }
    return {
      updated,
      auditId: (auditRes?.meta?.changes ?? 0) === 1 ? entry.id : null,
    };
  } catch (err) {
    wrapAuditOrThrow(err);
  }
}

// ---------------------------------------------------------------------------
// Console Operator Redacted Billing Queries & Audited Refund Recording
// ---------------------------------------------------------------------------

export interface ConsoleRedactedAttemptSummary {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly reffId: string;
  readonly providerTransactionId: string | null;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly state: PaymentAttemptLifecycleState;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly safeFailureCode: string | null;
  readonly pollCount: number;
  readonly maxPolls: number;
  readonly lastPolledAt: string | null;
  readonly lastProviderRc: string | null;
  readonly lastOutcome: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface ConsoleRedactedObligationSummary {
  readonly obligationId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly payerType: "tenant" | "agency";
  readonly plan: BillingPlanInterval;
  readonly state: BillingObligationApiState;
  readonly dbStatus: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly reviewRequired: boolean;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly settlementId: string | null;
  readonly grantCount: number;
  readonly latestAttempt: ConsoleRedactedAttemptSummary | null;
}

export type BillingRefundKind = "duplicate_payment" | "mistaken_payment" | "late_post_purge";

export interface BillingRefundRecord {
  readonly id: string;
  readonly obligationId: string;
  readonly paymentAttemptId: string | null;
  readonly settlementId: string | null;
  readonly tenantId: string;
  readonly refundKind: BillingRefundKind;
  readonly amountIdr: number;
  readonly externalReference: string | null;
  readonly reason: string;
  readonly recordedBy: string;
  readonly createdAt: string;
}

interface ConsoleObligationSqlRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly tenant_handle: string;
  readonly tenant_status: TenantStatus;
  readonly operator_hold: number;
  readonly payer_type: "tenant" | "agency";
  readonly plan_interval: "monthly" | "yearly" | "one_time";
  readonly status: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly review_required: number | null;
  readonly gross_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly net_amount_idr: number;
  readonly paid_at: number | null;
  readonly created_at: number;
  readonly settlement_id: string | null;
  readonly grant_count: number;
}

interface BillingRefundSqlRow {
  readonly id: string;
  readonly obligation_id: string;
  readonly payment_attempt_id: string | null;
  readonly settlement_id: string | null;
  readonly tenant_id: string;
  readonly refund_kind: BillingRefundKind;
  readonly amount_idr: number;
  readonly external_reference: string | null;
  readonly reason: string;
  readonly recorded_by: string;
  readonly created_at: number;
}

function mapRefundRow(row: BillingRefundSqlRow): BillingRefundRecord {
  return {
    id: row.id,
    obligationId: row.obligation_id,
    paymentAttemptId: row.payment_attempt_id,
    settlementId: row.settlement_id,
    tenantId: row.tenant_id,
    refundKind: row.refund_kind,
    amountIdr: row.amount_idr,
    externalReference: row.external_reference,
    reason: redactAuditText(row.reason),
    recordedBy: row.recorded_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Lists strictly redacted billing obligation, attempt, reconciliation, and refund metadata
 * for `console.punyasitus.com/api/console/billing`.
 * NEVER reads or emits QRIS payloads, VA numbers, redirect URLs, raw provider payloads,
 * API keys, or customer PII.
 */
export async function listConsoleBillingRecords(
  db: D1Database,
  filter: {
    readonly tenantId?: string;
    readonly reviewOnly?: boolean;
    readonly state?: BillingObligationApiState;
    readonly limit?: number;
  } = {},
): Promise<{
  readonly obligations: readonly ConsoleRedactedObligationSummary[];
  readonly refunds: readonly BillingRefundRecord[];
}> {
  await ensureBillingReconciliationSchema(db);

  const clauses: string[] = ["bo.plan_interval IN ('monthly', 'yearly')"];
  const bindings: (string | number)[] = [];

  if (filter.tenantId?.trim()) {
    clauses.push("bo.tenant_id = ?");
    bindings.push(filter.tenantId.trim());
  }
  if (filter.reviewOnly) {
    clauses.push("(bo.review_required = 1 OR EXISTS (SELECT 1 FROM payment_attempts pa2 WHERE pa2.obligation_id = bo.id AND pa2.lifecycle_state IN ('review', 'creation_unknown')))");
  }
  if (filter.state) {
    if (filter.state === "review") {
      clauses.push("bo.review_required = 1");
    } else if (filter.state === "cancelled") {
      clauses.push("bo.status IN ('canceled', 'refunded')");
    } else {
      clauses.push("bo.status = ?");
      bindings.push(filter.state);
    }
  }

  const safeLimit = Math.max(1, Math.min(50, Math.trunc(filter.limit ?? 20)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const oblRows = await db
    .prepare(
      `SELECT
         bo.id,
         bo.tenant_id,
         t.handle AS tenant_handle,
         t.status AS tenant_status,
         t.operator_hold,
         bo.payer_type,
         bo.plan_interval,
         bo.status,
         bo.review_required,
         bo.gross_amount_idr,
         bo.discount_amount_idr,
         bo.net_amount_idr,
         bo.paid_at,
         bo.created_at,
         (SELECT s.id FROM settlements s WHERE s.obligation_id = bo.id LIMIT 1) AS settlement_id,
         (
           SELECT COUNT(*)
           FROM entitlement_grants eg
           INNER JOIN settlements s2 ON s2.id = eg.settlement_id
           WHERE s2.obligation_id = bo.id
         ) AS grant_count
       FROM billing_obligations bo
       INNER JOIN tenants t ON t.id = bo.tenant_id
       ${whereSql}
       ORDER BY bo.created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings, safeLimit)
    .all<ConsoleObligationSqlRow>();

  const obligations: ConsoleRedactedObligationSummary[] = [];
  for (const row of oblRows.results ?? []) {
    const latest = await getLatestReconcilableAttemptForObligation(db, row.id, {
      tenantId: row.tenant_id,
    });
    const reviewRequired = row.review_required === 1;
    const apiState: BillingObligationApiState =
      reviewRequired && row.status === "open"
        ? "review"
        : row.status === "canceled" || row.status === "refunded"
          ? "cancelled"
          : row.status;

    obligations.push({
      obligationId: row.id,
      tenantId: row.tenant_id,
      tenantHandle: row.tenant_handle,
      tenantStatus: row.tenant_status,
      operatorHold: row.operator_hold === 1,
      payerType: row.payer_type,
      plan: row.plan_interval === "yearly" ? "yearly" : "monthly",
      state: apiState,
      dbStatus: row.status,
      reviewRequired,
      baseAmountIdr: row.gross_amount_idr,
      discountAmountIdr: row.discount_amount_idr,
      netAmountIdr: row.net_amount_idr,
      currency: BILLING_CURRENCY,
      paidAt: row.paid_at !== null ? new Date(row.paid_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      settlementId: row.settlement_id,
      grantCount: Number(row.grant_count ?? 0),
      latestAttempt: latest
        ? {
            attemptId: latest.attemptId,
            obligationId: latest.obligationId,
            tenantId: latest.tenantId,
            providerAccountId: latest.providerAccountId,
            reffId: latest.reffId,
            providerTransactionId: latest.providerTransactionId,
            channelKind: latest.channelKind,
            channelCode: latest.channelCode,
            state: latest.lifecycleState,
            channelFeeIdr: latest.channelFeeIdr,
            totalPayableIdr: latest.totalPayableIdr,
            safeFailureCode: latest.safeFailureCode,
            pollCount: latest.pollCount,
            maxPolls: latest.maxPolls,
            lastPolledAt:
              latest.lastPolledAtMs !== null ? new Date(latest.lastPolledAtMs).toISOString() : null,
            lastProviderRc: latest.lastProviderRc,
            lastOutcome: latest.lastOutcome,
            expiresAt:
              latest.expiresAtMs !== null ? new Date(latest.expiresAtMs).toISOString() : null,
            createdAt: new Date(latest.createdAtMs).toISOString(),
          }
        : null,
    });
  }

  const refundClauses = filter.tenantId?.trim() ? "WHERE tenant_id = ?" : "";
  const refundBindings: (string | number)[] = filter.tenantId?.trim()
    ? [filter.tenantId.trim(), safeLimit]
    : [safeLimit];

  const refundRows = await db
    .prepare(
      `SELECT id, obligation_id, payment_attempt_id, settlement_id, tenant_id,
              refund_kind, amount_idr, external_reference, reason, recorded_by, created_at
       FROM billing_refund_records
       ${refundClauses}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...refundBindings)
    .all<BillingRefundSqlRow>();

  return {
    obligations,
    refunds: (refundRows.results ?? []).map(mapRefundRow),
  };
}

const ALLOWED_REFUND_KINDS: ReadonlySet<string> = new Set([
  "duplicate_payment",
  "mistaken_payment",
  "late_post_purge",
]);

/**
 * Records an audited manual duplicate/mistaken/post-purge refund entry in
 * `billing_refund_records` + `platform_audit` inside ONE atomic `db.batch([...])`.
 *
 * Hard invariants:
 * - NEVER grants entitlement or arbitrarily toggles paid status.
 * - Mandatory 10-500 char scrubbed audit reason (`validateOperatorReason`).
 * - Prevents duplicate refund recording for the same `payment_attempt_id`.
 * - If `platform_audit` insert fails, the refund record rolls back completely!
 */
export async function recordAuditedBillingRefund(
  db: D1Database,
  input: {
    readonly obligationId: string;
    readonly paymentAttemptId?: string | null;
    readonly tenantId?: string | null;
    readonly refundKind: string;
    readonly amountIdr: number;
    readonly externalReference?: string | null;
    readonly reason: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly refund: BillingRefundRecord; readonly auditId: string }> {
  await ensureBillingReconciliationSchema(db, () => input.nowMs);

  const nowMs = Math.trunc(input.nowMs);
  const obligationId = input.obligationId.trim();
  if (!obligationId) {
    throw new BillingValidationError("INVALID_OBLIGATION_ID", "obligationId wajib diisi.");
  }
  if (!ALLOWED_REFUND_KINDS.has(input.refundKind)) {
    throw new BillingValidationError(
      "INVALID_REFUND_KIND",
      'refundKind harus salah satu dari "duplicate_payment", "mistaken_payment", atau "late_post_purge".',
    );
  }
  const refundKind = input.refundKind as BillingRefundKind;
  const amountIdr = assertExactIdrInteger(input.amountIdr, "amountIdr", { min: 1 });
  const validatedReason = validateOperatorReason(input.reason);
  const externalReference =
    typeof input.externalReference === "string" && input.externalReference.trim().length > 0
      ? redactAuditText(input.externalReference).slice(0, 80)
      : null;

  const obl = await db
    .prepare(
      `SELECT id, tenant_id, net_amount_idr
       FROM billing_obligations
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(obligationId)
    .first<{ readonly id: string; readonly tenant_id: string; readonly net_amount_idr: number }>();

  if (!obl || (input.tenantId && obl.tenant_id !== input.tenantId.trim())) {
    throw new BillingNotFoundError("Tagihan yang diminta tidak ditemukan.");
  }

  let verifiedAttemptId: string | null = null;
  let maxRefundCeilingIdr = obl.net_amount_idr + Math.max(25_000, Math.floor(obl.net_amount_idr * 0.1));

  if (input.paymentAttemptId && input.paymentAttemptId.trim().length > 0) {
    const attempt = await db
      .prepare(
        `SELECT id, obligation_id, tenant_id, total_payable_idr, amount_idr
         FROM payment_attempts
         WHERE id = ? AND obligation_id = ? AND tenant_id = ?
         LIMIT 1`,
      )
      .bind(input.paymentAttemptId.trim(), obl.id, obl.tenant_id)
      .first<{
        readonly id: string;
        readonly obligation_id: string;
        readonly tenant_id: string;
        readonly total_payable_idr: number | null;
        readonly amount_idr: number;
      }>();
    if (!attempt) {
      throw new BillingNotFoundError("Percobaan pembayaran terkait tagihan tidak ditemukan.");
    }
    verifiedAttemptId = attempt.id;
    const attemptTotal =
      attempt.total_payable_idr && attempt.total_payable_idr > 0
        ? attempt.total_payable_idr
        : attempt.amount_idr;
    maxRefundCeilingIdr = Math.max(maxRefundCeilingIdr, attemptTotal);
  }

  if (amountIdr > maxRefundCeilingIdr) {
    throw new BillingValidationError(
      "REFUND_AMOUNT_EXCEEDS_CHARGE",
      `Nominal refund (${amountIdr} IDR) melebihi batas tagihan (${maxRefundCeilingIdr} IDR).`,
    );
  }

  const settlement = await findSettlementForObligation(db, obl.id);
  const refundId = `rfd_${generateBillingUlid(nowMs)}`;

  const insertRefundStmt = db
    .prepare(
      `INSERT INTO billing_refund_records (
         id, obligation_id, payment_attempt_id, settlement_id, tenant_id,
         refund_kind, amount_idr, external_reference, reason, recorded_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      refundId,
      obl.id,
      verifiedAttemptId,
      settlement?.id ?? null,
      obl.tenant_id,
      refundKind,
      amountIdr,
      externalReference,
      validatedReason,
      input.actorUserId,
      nowMs,
    );

  const { statement: auditStmt, entry } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: "platform_operator",
    action: "console.billing.refund_recorded",
    targetType: "billing_obligation",
    targetId: obl.id,
    tenantId: obl.tenant_id,
    reason: validatedReason,
    requireReason: true,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      refundId,
      obligationId: obl.id,
      paymentAttemptId: verifiedAttemptId,
      settlementId: settlement?.id ?? null,
      refundKind,
      amountIdr,
      externalReference,
    },
    createdAtMs: nowMs,
  });

  try {
    await db.batch([insertRefundStmt, auditStmt]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new BillingConflictError(
        "CONFLICT",
        "REFUND_ALREADY_RECORDED",
        "Pengembalian dana untuk percobaan pembayaran ini sudah pernah dicatat.",
      );
    }
    wrapAuditOrThrow(err);
  }

  return {
    refund: {
      id: refundId,
      obligationId: obl.id,
      paymentAttemptId: verifiedAttemptId,
      settlementId: settlement?.id ?? null,
      tenantId: obl.tenant_id,
      refundKind,
      amountIdr,
      externalReference,
      reason: validatedReason,
      recordedBy: input.actorUserId,
      createdAt: new Date(nowMs).toISOString(),
    },
    auditId: entry.id,
  };
}
