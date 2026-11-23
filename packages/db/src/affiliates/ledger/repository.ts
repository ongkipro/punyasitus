import {
  AFFILIATE_COMMISSION_SETTINGS_KEY,
  AFFILIATE_PAYOUT_MINIMUM_IDR,
  calculateCommissionIdrFromNetBase,
  calculateNetCommissionableBaseIdr,
  computeCommissionHoldUntilMs,
  getWibCalendarDate,
  parseAffiliateCommissionRatesSnapshot,
  resolveAffiliatePayoutPeriodKey,
  type AffiliateCommissionEntryKind,
  type AffiliateCommissionRatesSnapshot,
  type AffiliateCommissionStatus,
  type AffiliatePayoutBatchStatus,
} from "@punyasitus/core/affiliates/commission";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  redactAuditText,
  validateOperatorReason,
} from "../../platform/audit.ts";
import {
  AffiliateLedgerError,
  type AffiliateCommissionBalanceSummary,
  type AffiliateCommissionEntryRecord,
  type AffiliatePayoutBatchRecord,
  type BuildBiMonthlyPayoutBatchesInput,
  type BuildBiMonthlyPayoutBatchesResult,
  type CommissionIneligibilityReason,
  type MarkAffiliatePayoutBatchPaidInput,
  type MarkAffiliatePayoutBatchPaidResult,
  type PromoteMaturedPendingCommissionsInput,
  type PromoteMaturedPendingCommissionsResult,
  type RecordConfirmedPaymentCommissionInput,
  type RecordConfirmedPaymentCommissionResult,
  type ReverseCommissionForRefundInput,
  type ReverseCommissionForRefundResult,
  type SkippedAffiliatePayoutCandidate,
} from "./types.ts";

/**
 * Affiliate Commission Ledger (`60%`/`20%`), 14-Day Hold Promotion, Pre/Post-Payout
 * Refund Reversal/Offset & Bi-Monthly Asia/Jakarta Payout Batch Engine
 * (`packages/db/src/affiliates/ledger/repository.ts`; REQ-085, REQ-086, DEC-038, DEC-045, TASK-085).
 *
 * Financial & Concurrency Invariants:
 * - Zero runtime DDL on hot paths (migrations live in `0032_affiliate_commission_ledger.sql`).
 * - Exact integer IDR math via `@punyasitus/core/affiliates/commission` (zero floating-point drift).
 * - Atomic `first_payment` vs `renewal` determination inside SQL (`NOT EXISTS (...)`) backed by
 *   partial `UNIQUE` index so concurrent invoices for the same tenant can NEVER both earn `60%`.
 * - Idempotent on `(payment_attempt_id)`, `(settlement_id)`, `(receipt_id, entry_kind)`,
 *   `(source_commission_id)`, and `(affiliate_id, payout_period_key)`.
 * - Every ledger mutation commits its PII-free `platform_audit` row inside the SAME atomic
 *   `D1Database.batch([...])` transaction gated on `changes() = 1`.
 */

const DEFAULT_PROMOTION_LIMIT = 200;
const MAX_PROMOTION_LIMIT = 500;
const PROMOTION_BATCH_CHUNK_SIZE = 25;

interface CommissionEntrySqlRow {
  readonly id: string;
  readonly affiliate_id: string;
  readonly tenant_id: string;
  readonly settlement_id: string | null;
  readonly payment_attempt_id: string | null;
  readonly obligation_id: string | null;
  readonly receipt_id: string | null;
  readonly entry_kind: AffiliateCommissionEntryKind;
  readonly gross_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly ppn_amount_idr: number;
  readonly channel_fee_idr: number;
  readonly net_base_idr: number;
  readonly rate_bps: number;
  readonly commission_idr: number;
  readonly status: AffiliateCommissionStatus;
  readonly confirmed_at: number;
  readonly hold_until_at: number;
  readonly approved_at: number | null;
  readonly reversed_at: number | null;
  readonly reversal_reason: string | null;
  readonly refund_reference: string | null;
  readonly payout_batch_id: string | null;
  readonly source_commission_id: string | null;
  readonly settings_snapshot_json: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface PayoutBatchSqlRow {
  readonly id: string;
  readonly affiliate_id: string;
  readonly payout_period_key: string;
  readonly total_amount_idr: number;
  readonly entry_count: number;
  readonly status: AffiliatePayoutBatchStatus;
  readonly transfer_reference: string | null;
  readonly paid_at: number | null;
  readonly paid_by_user_id: string | null;
  readonly canceled_at: number | null;
  readonly canceled_by_user_id: string | null;
  readonly status_reason: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface TenantForCommissionRow {
  readonly id: string;
  readonly organization_id: string;
  readonly agency_id: string | null;
  readonly referred_by_affiliate_id: string | null;
  readonly status: string;
  readonly org_metadata: string | null;
}

interface PaymentContextRow {
  readonly settlement_id: string | null;
  readonly payment_attempt_id: string | null;
  readonly obligation_id: string | null;
  readonly settled_at: number | null;
  readonly payer_type: string | null;
  readonly payer_agency_id: string | null;
  readonly obligation_status: string | null;
  readonly gross_amount_idr: number | null;
  readonly discount_amount_idr: number | null;
  readonly net_amount_idr: number | null;
  readonly base_amount_idr: number | null;
  readonly attempt_discount_amount_idr: number | null;
  readonly channel_fee_idr: number | null;
  readonly review_required: number | null;
  readonly lifecycle_state: string | null;
  readonly attempt_raw_state: string | null;
}

function mapCommissionEntryRow(row: CommissionEntrySqlRow): AffiliateCommissionEntryRecord {
  return {
    id: row.id,
    affiliateId: row.affiliate_id,
    tenantId: row.tenant_id,
    settlementId: row.settlement_id,
    paymentAttemptId: row.payment_attempt_id,
    obligationId: row.obligation_id,
    receiptId: row.receipt_id,
    entryKind: row.entry_kind,
    grossAmountIdr: row.gross_amount_idr,
    discountAmountIdr: row.discount_amount_idr,
    ppnAmountIdr: row.ppn_amount_idr,
    channelFeeIdr: row.channel_fee_idr,
    netBaseIdr: row.net_base_idr,
    rateBps: row.rate_bps,
    commissionIdr: row.commission_idr,
    status: row.status,
    confirmedAt: row.confirmed_at,
    holdUntilAt: row.hold_until_at,
    approvedAt: row.approved_at,
    reversedAt: row.reversed_at,
    reversalReason: row.reversal_reason,
    refundReference: row.refund_reference,
    payoutBatchId: row.payout_batch_id,
    sourceCommissionId: row.source_commission_id,
    settingsSnapshotJson: row.settings_snapshot_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPayoutBatchRow(row: PayoutBatchSqlRow): AffiliatePayoutBatchRecord {
  return {
    id: row.id,
    affiliateId: row.affiliate_id,
    payoutPeriodKey: row.payout_period_key,
    totalAmountIdr: row.total_amount_idr,
    entryCount: row.entry_count,
    status: row.status,
    transferReference: row.transfer_reference,
    paidAt: row.paid_at,
    paidByUserId: row.paid_by_user_id,
    canceledAt: row.canceled_at,
    canceledByUserId: row.canceled_by_user_id,
    statusReason: row.status_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isNoSuchTableOrColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table|no such column/i.test(msg);
}

function wrapAuditOrThrow(err: unknown): never {
  if (err instanceof AffiliateLedgerError) throw err;
  if (err instanceof PlatformAuditError) {
    throw new AffiliateLedgerError(500, "AUDIT_PERSISTENCE_FAILED", err.message, { cause: err });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/platform_audit|audit/i.test(msg)) {
    throw new AffiliateLedgerError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan log audit platform; mutasi ledger komisi dibatalkan.",
      { cause: err },
    );
  }
  throw err;
}

function parseOrgMetadataIneligibility(
  rawMetadata: string | null,
): CommissionIneligibilityReason | null {
  if (rawMetadata === null || rawMetadata.trim() === "") return null;
  let parsed: Record<string, unknown>;
  try {
    const val: unknown = JSON.parse(rawMetadata);
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      return "ineligible_invalid_metadata";
    }
    parsed = val as Record<string, unknown>;
  } catch {
    return "ineligible_invalid_metadata";
  }

  const kind =
    typeof parsed.tenantKind === "string"
      ? parsed.tenantKind.trim().toLowerCase()
      : typeof parsed.kind === "string"
        ? parsed.kind.trim().toLowerCase()
        : "";

  if (
    parsed.agencyId ||
    parsed.isAgencyManaged === true ||
    kind === "agency" ||
    kind === "agency_managed"
  ) {
    return "agency_managed_tenant";
  }
  if (parsed.isDemo === true || parsed.demo === true || kind === "demo") {
    return "ineligible_demo";
  }
  if (
    parsed.isComplimentary === true ||
    parsed.complimentary === true ||
    kind === "complimentary"
  ) {
    return "ineligible_complimentary";
  }
  if (parsed.isPlatform === true || parsed.platform === true || kind === "platform") {
    return "ineligible_platform";
  }
  const provisionedBy =
    typeof parsed.provisionedBy === "string" ? parsed.provisionedBy.trim().toLowerCase() : "";
  if (
    parsed.isSuperadminCreated === true ||
    parsed.superadminCreated === true ||
    kind === "superadmin" ||
    kind === "superadmin_created" ||
    provisionedBy === "operator" ||
    provisionedBy === "superadmin" ||
    provisionedBy === "platform_operator"
  ) {
    return "ineligible_superadmin_created";
  }
  return null;
}

function mapExclusionKind(kind: string): CommissionIneligibilityReason {
  switch (kind) {
    case "agency_managed":
      return "agency_managed_tenant";
    case "demo":
      return "ineligible_demo";
    case "complimentary":
      return "ineligible_complimentary";
    case "platform":
      return "ineligible_platform";
    default:
      return "ineligible_superadmin_created";
  }
}

/**
 * Loads the live affiliate commission rate & payout threshold settings snapshot
 * from `PLATFORM_DB.platform_settings` (`affiliate.commission_rates`), falling back
 * to canonical defaults (`60%` / `20%`, `14` days, `Rp 100.000`).
 */
export async function loadAffiliateCommissionRatesSnapshot(
  platformDb: D1Database,
): Promise<AffiliateCommissionRatesSnapshot> {
  const row = await platformDb
    .prepare("SELECT value_json FROM platform_settings WHERE key = ? LIMIT 1")
    .bind(AFFILIATE_COMMISSION_SETTINGS_KEY)
    .first<{ readonly value_json: string }>();

  return parseAffiliateCommissionRatesSnapshot(row?.value_json ?? null);
}

async function findExistingPositiveCommissionEntry(
  platformDb: D1Database,
  keys: {
    readonly paymentAttemptId: string | null;
    readonly settlementId: string | null;
    readonly receiptId: string | null;
  },
): Promise<AffiliateCommissionEntryRecord | null> {
  if (keys.paymentAttemptId) {
    const byAttempt = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE payment_attempt_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(keys.paymentAttemptId)
      .first<CommissionEntrySqlRow>();
    if (byAttempt) return mapCommissionEntryRow(byAttempt);
  }

  if (keys.settlementId) {
    const bySettlement = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE settlement_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(keys.settlementId)
      .first<CommissionEntrySqlRow>();
    if (bySettlement) return mapCommissionEntryRow(bySettlement);
  }

  if (keys.receiptId) {
    const byReceipt = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE receipt_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(keys.receiptId)
      .first<CommissionEntrySqlRow>();
    if (byReceipt) return mapCommissionEntryRow(byReceipt);
  }

  return null;
}

async function loadAuthoritativePaymentContext(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly settlementId: string | null;
    readonly paymentAttemptId: string | null;
  },
): Promise<PaymentContextRow | null> {
  const bySettlement = Boolean(params.settlementId);
  const byAttempt = !bySettlement && Boolean(params.paymentAttemptId);
  if (!bySettlement && !byAttempt) return null;

  const whereClause = bySettlement
    ? "WHERE s.id = ? AND s.tenant_id = ?"
    : "WHERE pa.id = ? AND pa.tenant_id = ?";
  const bindKey = bySettlement ? params.settlementId! : params.paymentAttemptId!;

  // Extended query reading 0004 columns (`base_amount_idr`, `channel_fee_idr`, `review_required`, `lifecycle_state`)
  try {
    const extendedSql = bySettlement
      ? `SELECT
           s.id AS settlement_id,
           s.payment_attempt_id,
           s.obligation_id,
           s.settled_at,
           bo.payer_type,
           bo.payer_agency_id,
           bo.status AS obligation_status,
           bo.gross_amount_idr,
           bo.discount_amount_idr,
           bo.net_amount_idr,
           pa.base_amount_idr,
           pa.discount_amount_idr AS attempt_discount_amount_idr,
           pa.channel_fee_idr,
           bo.review_required,
           pa.lifecycle_state,
           pa.state AS attempt_raw_state
         FROM settlements s
         INNER JOIN billing_obligations bo ON bo.id = s.obligation_id
         LEFT JOIN payment_attempts pa ON pa.id = s.payment_attempt_id
         ${whereClause}
         LIMIT 1`
      : `SELECT
           s.id AS settlement_id,
           pa.id AS payment_attempt_id,
           pa.obligation_id,
           s.settled_at,
           bo.payer_type,
           bo.payer_agency_id,
           bo.status AS obligation_status,
           bo.gross_amount_idr,
           bo.discount_amount_idr,
           bo.net_amount_idr,
           pa.base_amount_idr,
           pa.discount_amount_idr AS attempt_discount_amount_idr,
           pa.channel_fee_idr,
           bo.review_required,
           pa.lifecycle_state,
           pa.state AS attempt_raw_state
         FROM payment_attempts pa
         INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
         LEFT JOIN settlements s ON s.payment_attempt_id = pa.id
         ${whereClause}
         LIMIT 1`;

    return await platformDb
      .prepare(extendedSql)
      .bind(bindKey, params.tenantId)
      .first<PaymentContextRow>();
  } catch (err) {
    if (!isNoSuchTableOrColumnError(err)) throw err;
  }

  // Fallback for schemas with only `0001_initial_platform.sql` (without `0004` columns)
  const baseSql = bySettlement
    ? `SELECT
         s.id AS settlement_id,
         s.payment_attempt_id,
         s.obligation_id,
         s.settled_at,
         bo.payer_type,
         bo.payer_agency_id,
         bo.status AS obligation_status,
         bo.gross_amount_idr,
         bo.discount_amount_idr,
         bo.net_amount_idr,
         NULL AS base_amount_idr,
         NULL AS attempt_discount_amount_idr,
         0 AS channel_fee_idr,
         0 AS review_required,
         NULL AS lifecycle_state,
         pa.state AS attempt_raw_state
       FROM settlements s
       INNER JOIN billing_obligations bo ON bo.id = s.obligation_id
       LEFT JOIN payment_attempts pa ON pa.id = s.payment_attempt_id
       ${whereClause}
       LIMIT 1`
    : `SELECT
         s.id AS settlement_id,
         pa.id AS payment_attempt_id,
         pa.obligation_id,
         s.settled_at,
         bo.payer_type,
         bo.payer_agency_id,
         bo.status AS obligation_status,
         bo.gross_amount_idr,
         bo.discount_amount_idr,
         bo.net_amount_idr,
         NULL AS base_amount_idr,
         NULL AS attempt_discount_amount_idr,
         0 AS channel_fee_idr,
         0 AS review_required,
         NULL AS lifecycle_state,
         pa.state AS attempt_raw_state
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       LEFT JOIN settlements s ON s.payment_attempt_id = pa.id
       ${whereClause}
       LIMIT 1`;

  return platformDb.prepare(baseSql).bind(bindKey, params.tenantId).first<PaymentContextRow>();
}

async function evaluateTenantCommissionEligibility(
  platformDb: D1Database,
  tenant: TenantForCommissionRow,
): Promise<CommissionIneligibilityReason | null> {
  if (tenant.agency_id !== null && tenant.agency_id.trim() !== "") {
    return "agency_managed_tenant";
  }

  const metaExclusion = parseOrgMetadataIneligibility(tenant.org_metadata);
  if (metaExclusion) {
    return metaExclusion;
  }

  // Check `tenant_attribution_exclusions` (from 0031_affiliates; swallow only missing table)
  try {
    const excl = await platformDb
      .prepare("SELECT exclusion_kind FROM tenant_attribution_exclusions WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.id)
      .first<{ readonly exclusion_kind: string }>();
    if (excl) {
      return mapExclusionKind(excl.exclusion_kind);
    }
  } catch (err) {
    if (!isNoSuchTableOrColumnError(err)) throw err;
  }

  // Check `agency_client_links` (from 0028_agency_portal; swallow only missing table)
  try {
    const agencyLink = await platformDb
      .prepare("SELECT agency_id FROM agency_client_links WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.id)
      .first<{ readonly agency_id: string }>();
    if (agencyLink) {
      return "agency_managed_tenant";
    }
  } catch (err) {
    if (!isNoSuchTableOrColumnError(err)) throw err;
  }

  // Complimentary entitlement grants (non-settlement grants)
  const complimentaryGrant = await platformDb
    .prepare("SELECT id FROM entitlement_grants WHERE tenant_id = ? AND settlement_id IS NULL LIMIT 1")
    .bind(tenant.id)
    .first<{ readonly id: string }>();
  if (complimentaryGrant) {
    return "ineligible_complimentary";
  }

  // Superadmin-provisioned tenants
  const superadminAudit = await platformDb
    .prepare(
      `SELECT id FROM platform_audit
       WHERE tenant_id = ?
         AND actor_role = 'platform_operator'
         AND action IN ('console.tenant.provision', 'tenant.provision')
         AND outcome = 'success'
       LIMIT 1`,
    )
    .bind(tenant.id)
    .first<{ readonly id: string }>();
  if (superadminAudit) {
    return "ineligible_superadmin_created";
  }

  return null;
}

async function resolveLockedTenantAffiliateId(
  platformDb: D1Database,
  tenant: TenantForCommissionRow,
): Promise<string | null> {
  // Prefer `affiliate_referrals` (canonical locked attribution table from 0031_affiliates)
  try {
    const ref = await platformDb
      .prepare("SELECT affiliate_id FROM affiliate_referrals WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.id)
      .first<{ readonly affiliate_id: string | null }>();
    if (ref) {
      return ref.affiliate_id && ref.affiliate_id.trim() !== "" ? ref.affiliate_id.trim() : null;
    }
  } catch (err) {
    if (!isNoSuchTableOrColumnError(err)) throw err;
  }

  return tenant.referred_by_affiliate_id && tenant.referred_by_affiliate_id.trim() !== ""
    ? tenant.referred_by_affiliate_id.trim()
    : null;
}

/**
 * Records strictly ONE idempotent `pending` affiliate commission entry for a confirmed
 * tenant payment (`60%` on first confirmed paid invoice, `20%` on renewals, 14-day hold).
 *
 * Ineligible payments (trial, complimentary, anomaly/unconfirmed, agency-managed, demo,
 * platform, unreferred tenant, suspended/inactive affiliate, or zero net base) earn ZERO
 * commission and insert zero rows.
 */
export async function recordConfirmedPaymentCommission(
  platformDb: D1Database,
  input: RecordConfirmedPaymentCommissionInput,
): Promise<RecordConfirmedPaymentCommissionResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenantId = input.tenantId.trim();
  const initialSettlementId = input.settlementId?.trim() || null;
  const initialPaymentAttemptId = input.paymentAttemptId?.trim() || null;
  const initialObligationId = input.obligationId?.trim() || null;
  const receiptId = input.receiptId?.trim() || null;

  if (!tenantId) {
    throw new AffiliateLedgerError(422, "VALIDATION_ERROR", "tenantId wajib diisi.", {
      field: "tenantId",
    });
  }
  if (!initialPaymentAttemptId && !initialSettlementId && !receiptId) {
    throw new AffiliateLedgerError(
      422,
      "VALIDATION_ERROR",
      "Minimal salah satu dari paymentAttemptId, settlementId, atau receiptId wajib diisi untuk idempotensi komisi.",
      { field: "paymentAttemptId" },
    );
  }

  // 1. Fast-path idempotency check
  const fastExisting = await findExistingPositiveCommissionEntry(platformDb, {
    paymentAttemptId: initialPaymentAttemptId,
    settlementId: initialSettlementId,
    receiptId,
  });
  if (fastExisting) {
    return { status: "duplicate", entry: fastExisting };
  }

  // 2. Explicit ineligibility guards (unconfirmed, trial, complimentary, anomaly)
  if (input.isConfirmed === false) {
    return { status: "ineligible", reason: "unconfirmed_payment" };
  }
  if (input.paymentKind === "trial") {
    return { status: "ineligible", reason: "trial_payment" };
  }
  if (input.paymentKind === "complimentary") {
    return { status: "ineligible", reason: "complimentary_payment" };
  }
  if (input.paymentKind === "anomaly") {
    return { status: "ineligible", reason: "anomaly_payment" };
  }

  // 3. Load authoritative DB payment context if settlementId / paymentAttemptId is provided
  let settlementId = initialSettlementId;
  let paymentAttemptId = initialPaymentAttemptId;
  let obligationId = initialObligationId;
  let confirmedAtMs = input.confirmedAtMs ?? nowMs;
  let grossAmountIdr = input.grossAmountIdr;
  let discountAmountIdr = input.discountAmountIdr ?? 0;
  const ppnAmountIdr = input.ppnAmountIdr ?? 0;
  let channelFeeIdr = input.channelFeeIdr ?? 0;

  if (settlementId || paymentAttemptId) {
    const paymentCtx = await loadAuthoritativePaymentContext(platformDb, {
      tenantId,
      settlementId,
      paymentAttemptId,
    });

    if (settlementId && !paymentCtx) {
      return { status: "ineligible", reason: "unconfirmed_payment" };
    }

    if (paymentCtx) {
      if (paymentCtx.payer_type === "agency" || paymentCtx.payer_agency_id !== null) {
        return { status: "ineligible", reason: "agency_managed_tenant" };
      }
      if (
        paymentCtx.review_required === 1 ||
        paymentCtx.lifecycle_state === "review" ||
        paymentCtx.lifecycle_state === "creation_unknown"
      ) {
        return { status: "ineligible", reason: "anomaly_payment" };
      }
      if (
        paymentCtx.obligation_status === "refunded" ||
        paymentCtx.obligation_status === "canceled" ||
        paymentCtx.obligation_status === "expired"
      ) {
        return { status: "ineligible", reason: "unconfirmed_payment" };
      }
      if (
        !paymentCtx.settlement_id &&
        paymentCtx.lifecycle_state !== "paid" &&
        paymentCtx.attempt_raw_state !== "settled" &&
        input.isConfirmed !== true
      ) {
        return { status: "ineligible", reason: "unconfirmed_payment" };
      }

      settlementId = paymentCtx.settlement_id ?? settlementId;
      paymentAttemptId = paymentCtx.payment_attempt_id ?? paymentAttemptId;
      obligationId = paymentCtx.obligation_id ?? obligationId;
      if (input.confirmedAtMs === undefined && paymentCtx.settled_at !== null) {
        confirmedAtMs = paymentCtx.settled_at;
      }

      // Check idempotency again with resolved settlement/attempt IDs
      const resolvedExisting = await findExistingPositiveCommissionEntry(platformDb, {
        paymentAttemptId,
        settlementId,
        receiptId,
      });
      if (resolvedExisting) {
        return { status: "duplicate", entry: resolvedExisting };
      }

      // Check if already refunded in `billing_refund_records` (swallow only missing table)
      try {
        const refundRow = await platformDb
          .prepare(
            `SELECT id FROM billing_refund_records
             WHERE (payment_attempt_id IS NOT NULL AND payment_attempt_id = ?)
                OR (settlement_id IS NOT NULL AND settlement_id = ?)
             LIMIT 1`,
          )
          .bind(paymentAttemptId ?? "__none__", settlementId ?? "__none__")
          .first<{ readonly id: string }>();
        if (refundRow) {
          return { status: "ineligible", reason: "unconfirmed_payment" };
        }
      } catch (err) {
        if (!isNoSuchTableOrColumnError(err)) throw err;
      }

      if (grossAmountIdr === undefined) {
        const baseAmount =
          paymentCtx.base_amount_idr !== null && paymentCtx.base_amount_idr > 0
            ? paymentCtx.base_amount_idr
            : (paymentCtx.gross_amount_idr ?? 0);
        const resolvedDiscount =
          input.discountAmountIdr !== undefined
            ? input.discountAmountIdr
            : paymentCtx.attempt_discount_amount_idr !== null &&
                paymentCtx.attempt_discount_amount_idr > 0
              ? paymentCtx.attempt_discount_amount_idr
              : (paymentCtx.discount_amount_idr ?? 0);
        const resolvedChannelFee =
          input.channelFeeIdr !== undefined
            ? input.channelFeeIdr
            : (paymentCtx.channel_fee_idr ?? 0);

        // `billing_obligations.gross_amount_idr` / `base_amount_idr` excludes channel fee,
        // while `total_payable_idr = base - discount + channel_fee`.
        // Store `gross_amount_idr = base + channel_fee` so `gross - discount - ppn - channel_fee`
        // equals the exact net subscription base (`base - discount - ppn`) without double-deducting fee!
        grossAmountIdr = baseAmount + resolvedChannelFee;
        discountAmountIdr = resolvedDiscount;
        channelFeeIdr = resolvedChannelFee;
      }
    }
  }

  if (grossAmountIdr === undefined) {
    throw new AffiliateLedgerError(
      422,
      "VALIDATION_ERROR",
      "grossAmountIdr wajib diisi ketika tidak ada data settlement/payment_attempt di database.",
      { field: "grossAmountIdr" },
    );
  }

  // 4. Load tenant & verify commercial eligibility
  const tenant = await platformDb
    .prepare(
      `SELECT
         t.id,
         t.organization_id,
         t.agency_id,
         t.referred_by_affiliate_id,
         t.status,
         o.metadata AS org_metadata
       FROM tenants t
       LEFT JOIN organizations o ON o.id = t.organization_id
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantForCommissionRow>();

  if (!tenant) {
    return { status: "ineligible", reason: "tenant_not_found" };
  }

  const tenantIneligibleReason = await evaluateTenantCommissionEligibility(platformDb, tenant);
  if (tenantIneligibleReason) {
    return { status: "ineligible", reason: tenantIneligibleReason };
  }

  // 5. Look up locked affiliate attribution & live `affiliates.status === 'active'`
  const affiliateId = await resolveLockedTenantAffiliateId(platformDb, tenant);
  if (!affiliateId) {
    return { status: "ineligible", reason: "unreferred_tenant" };
  }

  const affiliateRow = await platformDb
    .prepare("SELECT id, status FROM affiliates WHERE id = ? LIMIT 1")
    .bind(affiliateId)
    .first<{ readonly id: string; readonly status: string }>();

  if (!affiliateRow) {
    return { status: "ineligible", reason: "affiliate_not_found" };
  }
  if (affiliateRow.status !== "active") {
    return { status: "ineligible", reason: "affiliate_not_active" };
  }

  // 6. Compute exact integer IDR net commissionable base & candidate commissions
  const netBaseIdr = calculateNetCommissionableBaseIdr({
    grossAmountIdr,
    discountAmountIdr,
    ppnAmountIdr,
    channelFeeIdr,
  });
  if (netBaseIdr <= 0) {
    return { status: "ineligible", reason: "zero_net_base" };
  }

  const ratesSnapshot =
    input.ratesOverride ?? (await loadAffiliateCommissionRatesSnapshot(platformDb));
  const firstPaymentCommissionIdr = calculateCommissionIdrFromNetBase(
    netBaseIdr,
    ratesSnapshot.firstPaymentRateBps,
  );
  const renewalCommissionIdr = calculateCommissionIdrFromNetBase(
    netBaseIdr,
    ratesSnapshot.renewalRateBps,
  );

  const validConfirmedAtMs = Math.trunc(confirmedAtMs);
  const holdUntilAtMs = computeCommissionHoldUntilMs(validConfirmedAtMs, ratesSnapshot.holdDays);
  const entryId = `afce_${generatePlatformAuditId(nowMs)}`;
  const settingsSnapshotJson = JSON.stringify({
    firstPaymentRateBps: ratesSnapshot.firstPaymentRateBps,
    renewalRateBps: ratesSnapshot.renewalRateBps,
    holdDays: ratesSnapshot.holdDays,
    minimumPayoutIdr: ratesSnapshot.minimumPayoutIdr,
    source: ratesSnapshot.source,
  });

  // 7. Atomic single-batch insert (`first_payment` vs `renewal` decided inside SQL!) + conditional `platform_audit`
  const insertStmt = platformDb
    .prepare(
      `INSERT OR IGNORE INTO affiliate_commission_entries (
         id,
         affiliate_id,
         tenant_id,
         settlement_id,
         payment_attempt_id,
         obligation_id,
         receipt_id,
         entry_kind,
         gross_amount_idr,
         discount_amount_idr,
         ppn_amount_idr,
         channel_fee_idr,
         net_base_idr,
         rate_bps,
         commission_idr,
         status,
         confirmed_at,
         hold_until_at,
         approved_at,
         reversed_at,
         reversal_reason,
         refund_reference,
         payout_batch_id,
         source_commission_id,
         settings_snapshot_json,
         version,
         created_at,
         updated_at
       )
       SELECT
         ?, ?, ?, ?, ?, ?, ?,
         CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM affiliate_commission_entries
             WHERE tenant_id = ?
               AND entry_kind IN ('first_payment', 'renewal')
               AND status != 'reversed'
           ) THEN 'first_payment'
           ELSE 'renewal'
         END,
         ?, ?, ?, ?,
         ?,
         CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM affiliate_commission_entries
             WHERE tenant_id = ?
               AND entry_kind IN ('first_payment', 'renewal')
               AND status != 'reversed'
           ) THEN ?
           ELSE ?
         END,
         CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM affiliate_commission_entries
             WHERE tenant_id = ?
               AND entry_kind IN ('first_payment', 'renewal')
               AND status != 'reversed'
           ) THEN ?
           ELSE ?
         END,
         'pending',
         ?, ?,
         NULL, NULL, NULL, NULL,
         NULL, NULL,
         ?,
         1, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM affiliates WHERE id = ? AND status = 'active'
       )
       AND (
         CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM affiliate_commission_entries
             WHERE tenant_id = ?
               AND entry_kind IN ('first_payment', 'renewal')
               AND status != 'reversed'
           ) THEN ?
           ELSE ?
         END
       ) > 0`,
    )
    .bind(
      entryId,
      affiliateRow.id,
      tenant.id,
      settlementId,
      paymentAttemptId,
      obligationId,
      receiptId,
      tenant.id,
      grossAmountIdr,
      discountAmountIdr,
      ppnAmountIdr,
      channelFeeIdr,
      netBaseIdr,
      tenant.id,
      ratesSnapshot.firstPaymentRateBps,
      ratesSnapshot.renewalRateBps,
      tenant.id,
      firstPaymentCommissionIdr,
      renewalCommissionIdr,
      validConfirmedAtMs,
      holdUntilAtMs,
      settingsSnapshotJson,
      nowMs,
      nowMs,
      affiliateRow.id,
      tenant.id,
      firstPaymentCommissionIdr,
      renewalCommissionIdr,
    );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: null,
      actorRole: "system",
      action: "affiliate.commission.recorded",
      targetType: "affiliate_commission",
      targetId: entryId,
      tenantId: tenant.id,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        affiliateId: affiliateRow.id,
        settlementId,
        paymentAttemptId,
        obligationId,
        receiptId,
        netBaseIdr,
        holdUntilAtMs,
        ratesSource: ratesSnapshot.source,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  let batchResults: D1Result[];
  try {
    batchResults = await platformDb.batch([insertStmt, auditStmt]);
  } catch (err) {
    wrapAuditOrThrow(err);
  }

  const insertedChanges = batchResults[0]?.meta?.changes ?? 0;
  if (insertedChanges === 1) {
    const saved = await platformDb
      .prepare("SELECT * FROM affiliate_commission_entries WHERE id = ? LIMIT 1")
      .bind(entryId)
      .first<CommissionEntrySqlRow>();
    if (!saved) {
      throw new AffiliateLedgerError(
        500,
        "NOT_FOUND",
        "Entri komisi tidak ditemukan setelah penyimpanan berhasil.",
      );
    }
    return {
      status: "created",
      entry: mapCommissionEntryRow(saved),
      audit,
    };
  }

  // Re-check for idempotent duplicate (e.g., concurrent duplicate delivery won the race)
  const raceExisting = await findExistingPositiveCommissionEntry(platformDb, {
    paymentAttemptId,
    settlementId,
    receiptId,
  });
  if (raceExisting) {
    return { status: "duplicate", entry: raceExisting };
  }

  // Verify whether affiliate became inactive concurrently
  const liveAff = await platformDb
    .prepare("SELECT status FROM affiliates WHERE id = ? LIMIT 1")
    .bind(affiliateRow.id)
    .first<{ readonly status: string }>();
  if (!liveAff || liveAff.status !== "active") {
    return { status: "ineligible", reason: "affiliate_not_active" };
  }

  // Only return `zero_commission_amount` if the applicable branch genuinely rounds to 0 IDR!
  const hasPriorNonReversed = await platformDb
    .prepare(
      `SELECT 1 AS found FROM affiliate_commission_entries
       WHERE tenant_id = ?
         AND entry_kind IN ('first_payment', 'renewal')
         AND status != 'reversed'
       LIMIT 1`,
    )
    .bind(tenant.id)
    .first<{ readonly found: number }>();
  const applicableCommissionIdr = hasPriorNonReversed
    ? renewalCommissionIdr
    : firstPaymentCommissionIdr;
  if (applicableCommissionIdr <= 0) {
    return { status: "ineligible", reason: "zero_commission_amount" };
  }

  // Never allow `INSERT OR IGNORE` to silently mask a real write/constraint failure!
  throw new AffiliateLedgerError(
    500,
    "LEDGER_WRITE_FAILED",
    "Gagal mencatat entri komisi afiliasi secara atomik; tidak ditemukan duplikat atau alasan ketidaklayakan yang valid.",
  );
}

/**
 * Atomically promotes matured `pending` commissions (`hold_until_at <= nowMs`) to `approved`
 * for active affiliates only (`affiliates.status = 'active'`), leaving suspended affiliates'
 * commissions untouched and persisting one PII-free `platform_audit` row per promoted entry.
 */
export async function promoteMaturedPendingCommissions(
  platformDb: D1Database,
  input: PromoteMaturedPendingCommissionsInput = {},
): Promise<PromoteMaturedPendingCommissionsResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const limit = Math.max(
    1,
    Math.min(MAX_PROMOTION_LIMIT, Math.trunc(input.limit ?? DEFAULT_PROMOTION_LIMIT)),
  );

  const suspendedCountRow = await platformDb
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM affiliate_commission_entries e
       INNER JOIN affiliates a ON a.id = e.affiliate_id
       WHERE e.status = 'pending'
         AND e.hold_until_at <= ?
         AND a.status != 'active'`,
    )
    .bind(nowMs)
    .first<{ readonly cnt: number }>();
  const skippedSuspendedCount = Number(suspendedCountRow?.cnt ?? 0);

  const candidatesRes = await platformDb
    .prepare(
      `SELECT e.*
       FROM affiliate_commission_entries e
       INNER JOIN affiliates a ON a.id = e.affiliate_id
       WHERE e.status = 'pending'
         AND e.hold_until_at <= ?
         AND a.status = 'active'
       ORDER BY e.hold_until_at ASC, e.id ASC
       LIMIT ?`,
    )
    .bind(nowMs, limit)
    .all<CommissionEntrySqlRow>();

  const candidates = candidatesRes.results ?? [];
  if (candidates.length === 0) {
    return {
      evaluatedAtMs: nowMs,
      promotedCount: 0,
      skippedSuspendedCount,
      promotedIds: [],
      entries: [],
    };
  }

  const promotedIds: string[] = [];

  for (let i = 0; i < candidates.length; i += PROMOTION_BATCH_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + PROMOTION_BATCH_CHUNK_SIZE);
    const statements: D1PreparedStatement[] = [];

    for (const row of chunk) {
      const updateStmt = platformDb
        .prepare(
          `UPDATE affiliate_commission_entries
           SET status = 'approved',
               approved_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND status = 'pending'
             AND hold_until_at <= ?
             AND EXISTS (
               SELECT 1 FROM affiliates
               WHERE id = affiliate_commission_entries.affiliate_id
                 AND status = 'active'
             )`,
        )
        .bind(nowMs, nowMs, row.id, nowMs);

      const { statement: auditStmt } = buildPlatformAuditStatement(
        platformDb,
        {
          actorUserId: null,
          actorRole: "system",
          action: "affiliate.commission.approved",
          targetType: "affiliate_commission",
          targetId: row.id,
          tenantId: row.tenant_id,
          outcome: "success",
          requestId: input.requestId ?? null,
          createdAtMs: nowMs,
          metadata: {
            affiliateId: row.affiliate_id,
            entryKind: row.entry_kind,
            commissionIdr: row.commission_idr,
            holdUntilAtMs: row.hold_until_at,
            approvedAtMs: nowMs,
          },
        },
        { onlyIfPreviousChanged: true },
      );

      statements.push(updateStmt, auditStmt);
    }

    let results: D1Result[];
    try {
      results = await platformDb.batch(statements);
    } catch (err) {
      wrapAuditOrThrow(err);
    }

    for (let j = 0; j < chunk.length; j += 1) {
      const updateChanges = results[j * 2]?.meta?.changes ?? 0;
      if (updateChanges === 1) {
        promotedIds.push(chunk[j]!.id);
      }
    }
  }

  const entries: AffiliateCommissionEntryRecord[] = [];
  if (promotedIds.length > 0) {
    const placeholders = promotedIds.map(() => "?").join(", ");
    const updatedRows = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE id IN (${placeholders})
         ORDER BY hold_until_at ASC, id ASC`,
      )
      .bind(...promotedIds)
      .all<CommissionEntrySqlRow>();
    for (const r of updatedRows.results ?? []) {
      entries.push(mapCommissionEntryRow(r));
    }
  }

  return {
    evaluatedAtMs: nowMs,
    promotedCount: promotedIds.length,
    skippedSuspendedCount,
    promotedIds,
    entries,
  };
}

async function findOriginalPositiveCommissionForRefund(
  platformDb: D1Database,
  input: Pick<
    ReverseCommissionForRefundInput,
    "commissionEntryId" | "paymentAttemptId" | "settlementId" | "receiptId" | "obligationId"
  >,
): Promise<AffiliateCommissionEntryRecord | null> {
  if (input.commissionEntryId?.trim()) {
    const row = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(input.commissionEntryId.trim())
      .first<CommissionEntrySqlRow>();
    if (row) return mapCommissionEntryRow(row);
  }
  if (input.paymentAttemptId?.trim()) {
    const row = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE payment_attempt_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(input.paymentAttemptId.trim())
      .first<CommissionEntrySqlRow>();
    if (row) return mapCommissionEntryRow(row);
  }
  if (input.settlementId?.trim()) {
    const row = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE settlement_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(input.settlementId.trim())
      .first<CommissionEntrySqlRow>();
    if (row) return mapCommissionEntryRow(row);
  }
  if (input.receiptId?.trim()) {
    const row = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE receipt_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(input.receiptId.trim())
      .first<CommissionEntrySqlRow>();
    if (row) return mapCommissionEntryRow(row);
  }
  if (input.obligationId?.trim()) {
    const row = await platformDb
      .prepare(
        `SELECT * FROM affiliate_commission_entries
         WHERE obligation_id = ?
           AND entry_kind IN ('first_payment', 'renewal')
         LIMIT 1`,
      )
      .bind(input.obligationId.trim())
      .first<CommissionEntrySqlRow>();
    if (row) return mapCommissionEntryRow(row);
  }
  return null;
}

async function findReversalOffsetBySourceId(
  platformDb: D1Database,
  sourceCommissionId: string,
): Promise<AffiliateCommissionEntryRecord | null> {
  const row = await platformDb
    .prepare(
      `SELECT * FROM affiliate_commission_entries
       WHERE source_commission_id = ?
       LIMIT 1`,
    )
    .bind(sourceCommissionId)
    .first<CommissionEntrySqlRow>();
  return row ? mapCommissionEntryRow(row) : null;
}

/**
 * Reverses a commission entry on invoice refund/chargeback with strict idempotency:
 * - **Pre-payout (`pending` or `approved`):** atomically marks the original entry `status = 'reversed'`
 *   so it will never be paid.
 * - **Post-payout (`batched` or `paid`):** keeps the historical entry strictly immutable and
 *   atomically inserts ONE negative `reversal_offset` entry (`commission_idr = -original.commission_idr`,
 *   `status = 'approved'`, `source_commission_id = original.id`) that automatically offsets future
 *   approved balances before the affiliate reaches the `Rp 100.000` payout minimum.
 */
export async function reverseCommissionForRefund(
  platformDb: D1Database,
  input: ReverseCommissionForRefundInput,
): Promise<ReverseCommissionForRefundResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const actorRole = input.actorRole ?? "system";
  const actorUserId = input.actorUserId?.trim() || null;

  const hasLookupKey = Boolean(
    input.commissionEntryId?.trim() ||
      input.paymentAttemptId?.trim() ||
      input.settlementId?.trim() ||
      input.receiptId?.trim() ||
      input.obligationId?.trim(),
  );
  if (!hasLookupKey) {
    throw new AffiliateLedgerError(
      422,
      "VALIDATION_ERROR",
      "Minimal satu pengenal pembayaran (commissionEntryId, paymentAttemptId, settlementId, receiptId, atau obligationId) wajib diisi.",
    );
  }

  const safeRefundRef = redactAuditText(input.refundReference ?? "").slice(0, 120);
  if (!safeRefundRef) {
    throw new AffiliateLedgerError(422, "VALIDATION_ERROR", "refundReference wajib diisi.", {
      field: "refundReference",
    });
  }

  const safeReason = redactAuditText(input.reason ?? "").slice(0, 500);
  if (!safeReason) {
    throw new AffiliateLedgerError(422, "VALIDATION_ERROR", "reason wajib diisi.", {
      field: "reason",
    });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const original = await findOriginalPositiveCommissionForRefund(platformDb, input);
    if (!original) {
      return { status: "not_found" };
    }

    if (original.status === "reversed") {
      return {
        status: "already_reversed",
        mode: "pre_payout_reversed",
        originalEntry: original,
        offsetEntry: null,
      };
    }

    const existingOffset = await findReversalOffsetBySourceId(platformDb, original.id);
    if (existingOffset) {
      return {
        status: "already_reversed",
        mode: "post_payout_offset",
        originalEntry: original,
        offsetEntry: existingOffset,
      };
    }

    // Pre-payout path (`pending` or `approved`): mark original entry `reversed`
    if (original.status === "pending" || original.status === "approved") {
      const updateStmt = platformDb
        .prepare(
          `UPDATE affiliate_commission_entries
           SET status = 'reversed',
               reversed_at = ?,
               reversal_reason = ?,
               refund_reference = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND status IN ('pending', 'approved')
             AND payout_batch_id IS NULL`,
        )
        .bind(nowMs, safeReason, safeRefundRef, nowMs, original.id);

      const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
        platformDb,
        {
          actorUserId,
          actorRole,
          action: "affiliate.commission.reversed",
          targetType: "affiliate_commission",
          targetId: original.id,
          tenantId: original.tenantId,
          reason: safeReason,
          outcome: "success",
          requestId: input.requestId ?? null,
          createdAtMs: nowMs,
          metadata: {
            affiliateId: original.affiliateId,
            previousStatus: original.status,
            commissionIdr: original.commissionIdr,
            refundReference: safeRefundRef,
            mode: "pre_payout_reversed",
          },
        },
        { onlyIfPreviousChanged: true },
      );

      let results: D1Result[];
      try {
        results = await platformDb.batch([updateStmt, auditStmt]);
      } catch (err) {
        wrapAuditOrThrow(err);
      }

      if ((results[0]?.meta?.changes ?? 0) === 1) {
        const updatedRow = await platformDb
          .prepare("SELECT * FROM affiliate_commission_entries WHERE id = ? LIMIT 1")
          .bind(original.id)
          .first<CommissionEntrySqlRow>();
        return {
          status: "reversed",
          mode: "pre_payout_reversed",
          originalEntry: updatedRow ? mapCommissionEntryRow(updatedRow) : original,
          offsetEntry: null,
          audit,
        };
      }
      // Concurrent state transition (e.g., batched/paid/reversed) — retry once against live state
      continue;
    }

    // Post-payout path (`batched` or `paid`): keep historical entry immutable & insert ONE negative `reversal_offset`
    const offsetId = `afco_${generatePlatformAuditId(nowMs)}`;
    const negativeCommissionIdr = -Math.abs(original.commissionIdr);

    const insertOffsetStmt = platformDb
      .prepare(
        `INSERT OR IGNORE INTO affiliate_commission_entries (
           id,
           affiliate_id,
           tenant_id,
           settlement_id,
           payment_attempt_id,
           obligation_id,
           receipt_id,
           entry_kind,
           gross_amount_idr,
           discount_amount_idr,
           ppn_amount_idr,
           channel_fee_idr,
           net_base_idr,
           rate_bps,
           commission_idr,
           status,
           confirmed_at,
           hold_until_at,
           approved_at,
           reversed_at,
           reversal_reason,
           refund_reference,
           payout_batch_id,
           source_commission_id,
           settings_snapshot_json,
           version,
           created_at,
           updated_at
         )
         SELECT
           ?, ?, ?, ?, ?, ?, ?,
           'reversal_offset',
           ?, ?, ?, ?, ?, ?, ?,
           'approved',
           ?, ?, ?, ?, ?, ?,
           NULL, ?, ?,
           1, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM affiliate_commission_entries
           WHERE id = ?
             AND status IN ('batched', 'paid')
         )
         AND NOT EXISTS (
           SELECT 1 FROM affiliate_commission_entries
           WHERE source_commission_id = ?
         )`,
      )
      .bind(
        offsetId,
        original.affiliateId,
        original.tenantId,
        original.settlementId,
        original.paymentAttemptId,
        original.obligationId,
        original.receiptId,
        original.grossAmountIdr,
        original.discountAmountIdr,
        original.ppnAmountIdr,
        original.channelFeeIdr,
        original.netBaseIdr,
        original.rateBps,
        negativeCommissionIdr,
        nowMs,
        nowMs,
        nowMs,
        nowMs,
        safeReason,
        safeRefundRef,
        original.id,
        original.settingsSnapshotJson,
        nowMs,
        nowMs,
        original.id,
        original.id,
      );

    const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
      platformDb,
      {
        actorUserId,
        actorRole,
        action: "affiliate.commission.reversal_offset_created",
        targetType: "affiliate_commission",
        targetId: offsetId,
        tenantId: original.tenantId,
        reason: safeReason,
        outcome: "success",
        requestId: input.requestId ?? null,
        createdAtMs: nowMs,
        metadata: {
          affiliateId: original.affiliateId,
          sourceCommissionId: original.id,
          sourceStatus: original.status,
          offsetCommissionIdr: negativeCommissionIdr,
          refundReference: safeRefundRef,
          mode: "post_payout_offset",
        },
      },
      { onlyIfPreviousChanged: true },
    );

    let results: D1Result[];
    try {
      results = await platformDb.batch([insertOffsetStmt, auditStmt]);
    } catch (err) {
      wrapAuditOrThrow(err);
    }

    if ((results[0]?.meta?.changes ?? 0) === 1) {
      const savedOffset = await platformDb
        .prepare("SELECT * FROM affiliate_commission_entries WHERE id = ? LIMIT 1")
        .bind(offsetId)
        .first<CommissionEntrySqlRow>();
      if (!savedOffset) {
        throw new AffiliateLedgerError(
          500,
          "NOT_FOUND",
          "Entri offset reversal tidak ditemukan setelah penyimpanan berhasil.",
        );
      }
      return {
        status: "offset_created",
        mode: "post_payout_offset",
        originalEntry: original,
        offsetEntry: mapCommissionEntryRow(savedOffset),
        audit,
      };
    }

    const raceOffset = await findReversalOffsetBySourceId(platformDb, original.id);
    if (raceOffset) {
      return {
        status: "already_reversed",
        mode: "post_payout_offset",
        originalEntry: original,
        offsetEntry: raceOffset,
      };
    }
  }

  const finalOriginal = await findOriginalPositiveCommissionForRefund(platformDb, input);
  if (!finalOriginal) {
    return { status: "not_found" };
  }
  if (finalOriginal.status === "reversed") {
    return {
      status: "already_reversed",
      mode: "pre_payout_reversed",
      originalEntry: finalOriginal,
      offsetEntry: null,
    };
  }
  const finalOffset = await findReversalOffsetBySourceId(platformDb, finalOriginal.id);
  if (finalOffset) {
    return {
      status: "already_reversed",
      mode: "post_payout_offset",
      originalEntry: finalOriginal,
      offsetEntry: finalOffset,
    };
  }

  // Never allow `INSERT OR IGNORE` / retry exhaustion to falsely claim `already_reversed`!
  throw new AffiliateLedgerError(
    500,
    "LEDGER_WRITE_FAILED",
    `Gagal membalikkan atau membuat reversal_offset untuk entri komisi "${finalOriginal.id}" berstatus "${finalOriginal.status}".`,
  );
}

/**
 * Builds bi-monthly `Asia/Jakarta` affiliate payout batches on the **15th** and **30th**
 * (and **28th/29th** on the last day of February) for active affiliates whose net available
 * `approved` balance (including any negative `reversal_offset` entries!) is `>= Rp 100.000`.
 *
 * Guarantees:
 * - Affiliates below `minimumPayoutIdr` are skipped cleanly and their entries remain `approved`
 *   to roll over into the next payout cycle.
 * - Each eligible affiliate gets strictly ONE `pending_review` batch per `(affiliate_id, payout_period_key)`
 *   committed atomically with `platform_audit` and entry linking inside ONE `D1Database.batch([...])`.
 * - Re-running on the same `Asia/Jakarta` payout date is 100% idempotent (zero duplicate batches,
 *   zero double-counted entries).
 */
export async function buildBiMonthlyAffiliatePayoutBatches(
  platformDb: D1Database,
  input: BuildBiMonthlyPayoutBatchesInput = {},
): Promise<BuildBiMonthlyPayoutBatchesResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const rates = await loadAffiliateCommissionRatesSnapshot(platformDb);
  const minimumPayoutIdr =
    input.minimumPayoutIdr !== undefined
      ? Math.max(1, Math.trunc(input.minimumPayoutIdr))
      : (rates.minimumPayoutIdr ?? AFFILIATE_PAYOUT_MINIMUM_IDR);

  const scheduledPeriodKey = resolveAffiliatePayoutPeriodKey(nowMs);
  if (!input.forceRun && !scheduledPeriodKey) {
    return {
      ran: false,
      skipReason: "not_payout_date",
      payoutPeriodKey: null,
      evaluatedAtMs: nowMs,
      minimumPayoutIdr,
      createdBatchCount: 0,
      skippedBelowThresholdCount: 0,
      alreadyBatchedCount: 0,
      batches: [],
      skippedAffiliates: [],
    };
  }

  const payoutPeriodKey =
    input.overridePayoutPeriodKey?.trim() ||
    scheduledPeriodKey ||
    getWibCalendarDate(nowMs).dateKey;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(payoutPeriodKey)) {
    throw new AffiliateLedgerError(
      422,
      "VALIDATION_ERROR",
      `payoutPeriodKey "${payoutPeriodKey}" harus berformat YYYY-MM-DD.`,
      { field: "overridePayoutPeriodKey" },
    );
  }

  const candidatesRes = await platformDb
    .prepare(
      `SELECT
         e.affiliate_id,
         SUM(e.commission_idr) AS net_available_idr,
         COUNT(*) AS entry_count
       FROM affiliate_commission_entries e
       INNER JOIN affiliates a ON a.id = e.affiliate_id
       WHERE e.status = 'approved'
         AND e.payout_batch_id IS NULL
         AND a.status = 'active'
       GROUP BY e.affiliate_id
       ORDER BY e.affiliate_id ASC`,
    )
    .all<{
      readonly affiliate_id: string;
      readonly net_available_idr: number;
      readonly entry_count: number;
    }>();

  const batches: AffiliatePayoutBatchRecord[] = [];
  const skippedAffiliates: SkippedAffiliatePayoutCandidate[] = [];
  let skippedBelowThresholdCount = 0;
  let alreadyBatchedCount = 0;

  for (const candidate of candidatesRes.results ?? []) {
    const netAvailableIdr = Number(candidate.net_available_idr ?? 0);
    const entryCount = Number(candidate.entry_count ?? 0);

    if (netAvailableIdr < minimumPayoutIdr) {
      skippedBelowThresholdCount += 1;
      skippedAffiliates.push({
        affiliateId: candidate.affiliate_id,
        netAvailableIdr,
        entryCount,
        reason: "below_minimum_threshold",
      });
      continue;
    }

    const existingPeriodBatch = await platformDb
      .prepare(
        `SELECT id FROM affiliate_commission_payout_batches
         WHERE affiliate_id = ? AND payout_period_key = ?
         LIMIT 1`,
      )
      .bind(candidate.affiliate_id, payoutPeriodKey)
      .first<{ readonly id: string }>();

    if (existingPeriodBatch) {
      alreadyBatchedCount += 1;
      skippedAffiliates.push({
        affiliateId: candidate.affiliate_id,
        netAvailableIdr,
        entryCount,
        reason: "already_batched_for_period",
      });
      continue;
    }

    const batchId = `afpb_${generatePlatformAuditId(nowMs)}`;

    // Statement 0: Atomically insert payout batch directly from live SQL aggregate (`HAVING SUM >= minimumPayoutIdr`)
    const insertBatchStmt = platformDb
      .prepare(
        `INSERT OR IGNORE INTO affiliate_commission_payout_batches (
           id,
           affiliate_id,
           payout_period_key,
           total_amount_idr,
           entry_count,
           status,
           transfer_reference,
           paid_at,
           paid_by_user_id,
           canceled_at,
           canceled_by_user_id,
           status_reason,
           version,
           created_at,
           updated_at
         )
         SELECT
           ?,
           e.affiliate_id,
           ?,
           SUM(e.commission_idr),
           COUNT(*),
           'pending_review',
           NULL, NULL, NULL,
           NULL, NULL, NULL,
           1, ?, ?
         FROM affiliate_commission_entries e
         INNER JOIN affiliates a ON a.id = e.affiliate_id
         WHERE e.affiliate_id = ?
           AND e.status = 'approved'
           AND e.payout_batch_id IS NULL
           AND a.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM affiliate_commission_payout_batches b
             WHERE b.affiliate_id = ? AND b.payout_period_key = ?
           )
         GROUP BY e.affiliate_id
         HAVING SUM(e.commission_idr) >= ?`,
      )
      .bind(
        batchId,
        payoutPeriodKey,
        nowMs,
        nowMs,
        candidate.affiliate_id,
        candidate.affiliate_id,
        payoutPeriodKey,
        minimumPayoutIdr,
      );

    // Statement 1: Conditional PII-free `platform_audit` reading LIVE inserted `total_amount_idr` & `entry_count`
    // directly from `affiliate_commission_payout_batches` (`changes() = 1` iff Statement 0 created the batch!)
    const auditId = generatePlatformAuditId(nowMs);
    const safeRequestId =
      input.requestId && /^[A-Za-z0-9._:/-]{1,128}$/.test(input.requestId.trim())
        ? input.requestId.trim()
        : null;
    const auditStmt = platformDb
      .prepare(
        `INSERT INTO platform_audit (
           id,
           actor_user_id,
           actor_role,
           action,
           target_type,
           target_id,
           tenant_id,
           reason,
           outcome,
           request_id,
           metadata_json,
           created_at
         )
         SELECT
           ?,
           NULL,
           'system',
           'affiliate.payout_batch.created',
           'affiliate_payout_batch',
           b.id,
           NULL,
           NULL,
           'success',
           ?,
           json_object(
             'affiliateId', b.affiliate_id,
             'payoutPeriodKey', b.payout_period_key,
             'totalAmountIdr', b.total_amount_idr,
             'entryCount', b.entry_count,
             'minimumPayoutIdr', ?
           ),
           ?
         FROM affiliate_commission_payout_batches b
         WHERE b.id = ?
           AND changes() = 1`,
      )
      .bind(auditId, safeRequestId, minimumPayoutIdr, nowMs, batchId);

    // Statement 2: Link ALL eligible `approved` entries (positive AND negative offsets!) iff the batch was created
    const linkEntriesStmt = platformDb
      .prepare(
        `UPDATE affiliate_commission_entries
         SET status = 'batched',
             payout_batch_id = ?,
             version = version + 1,
             updated_at = ?
         WHERE affiliate_id = ?
           AND status = 'approved'
           AND payout_batch_id IS NULL
           AND EXISTS (
             SELECT 1 FROM affiliate_commission_payout_batches
             WHERE id = ?
               AND affiliate_id = ?
               AND payout_period_key = ?
           )`,
      )
      .bind(batchId, nowMs, candidate.affiliate_id, batchId, candidate.affiliate_id, payoutPeriodKey);

    let results: D1Result[];
    try {
      results = await platformDb.batch([insertBatchStmt, auditStmt, linkEntriesStmt]);
    } catch (err) {
      wrapAuditOrThrow(err);
    }

    if ((results[0]?.meta?.changes ?? 0) === 1) {
      const savedBatch = await platformDb
        .prepare("SELECT * FROM affiliate_commission_payout_batches WHERE id = ? LIMIT 1")
        .bind(batchId)
        .first<PayoutBatchSqlRow>();
      if (savedBatch) {
        batches.push(mapPayoutBatchRow(savedBatch));
      }
    } else {
      // Distinguish concurrent duplicate period batch vs concurrent balance drop below threshold
      const concurrentBatch = await platformDb
        .prepare(
          `SELECT id FROM affiliate_commission_payout_batches
           WHERE affiliate_id = ? AND payout_period_key = ?
           LIMIT 1`,
        )
        .bind(candidate.affiliate_id, payoutPeriodKey)
        .first<{ readonly id: string }>();

      if (concurrentBatch) {
        alreadyBatchedCount += 1;
        skippedAffiliates.push({
          affiliateId: candidate.affiliate_id,
          netAvailableIdr,
          entryCount,
          reason: "already_batched_for_period",
        });
      } else {
        const liveAgg = await platformDb
          .prepare(
            `SELECT COALESCE(SUM(commission_idr), 0) AS net_idr, COUNT(*) AS cnt
             FROM affiliate_commission_entries
             WHERE affiliate_id = ? AND status = 'approved' AND payout_batch_id IS NULL`,
          )
          .bind(candidate.affiliate_id)
          .first<{ readonly net_idr: number; readonly cnt: number }>();
        skippedBelowThresholdCount += 1;
        skippedAffiliates.push({
          affiliateId: candidate.affiliate_id,
          netAvailableIdr: Number(liveAgg?.net_idr ?? 0),
          entryCount: Number(liveAgg?.cnt ?? 0),
          reason: "below_minimum_threshold",
        });
      }
    }
  }

  return {
    ran: true,
    skipReason: null,
    payoutPeriodKey,
    evaluatedAtMs: nowMs,
    minimumPayoutIdr,
    createdBatchCount: batches.length,
    skippedBelowThresholdCount,
    alreadyBatchedCount,
    batches,
    skippedAffiliates,
  };
}

/**
 * Audited operator action marking a `pending_review` payout batch `paid` with a manual bank
 * transfer reference, atomically transitioning all linked `batched` entries to immutable `paid`
 * status + persisting `platform_audit` inside ONE `D1Database.batch([...])`.
 */
export async function markAffiliatePayoutBatchPaid(
  platformDb: D1Database,
  input: MarkAffiliatePayoutBatchPaidInput,
): Promise<MarkAffiliatePayoutBatchPaidResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const actorUserId = input.actorUserId.trim();
  const batchId = input.batchId.trim();

  if (!actorUserId) {
    throw new AffiliateLedgerError(
      403,
      "FORBIDDEN",
      "Hanya operator platform aktif yang dapat menandai batch payout sebagai dibayar.",
    );
  }

  const operatorGrant = await platformDb
    .prepare(
      `SELECT user_id FROM platform_operators
       WHERE user_id = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(actorUserId)
    .first<{ readonly user_id: string }>();
  if (!operatorGrant) {
    throw new AffiliateLedgerError(
      403,
      "FORBIDDEN",
      "Hanya operator platform aktif yang dapat menandai batch payout sebagai dibayar.",
    );
  }

  let validatedReason: string;
  try {
    validatedReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new AffiliateLedgerError(422, "VALIDATION_ERROR", err.message, {
        field: "reason",
        cause: err,
      });
    }
    throw err;
  }

  const safeTransferRef = redactAuditText(input.transferReference ?? "").slice(0, 120);
  if (safeTransferRef.length < 3) {
    throw new AffiliateLedgerError(
      422,
      "VALIDATION_ERROR",
      "Referensi transfer bank minimal 3 karakter.",
      { field: "transferReference" },
    );
  }

  const existing = await platformDb
    .prepare("SELECT * FROM affiliate_commission_payout_batches WHERE id = ? LIMIT 1")
    .bind(batchId)
    .first<PayoutBatchSqlRow>();

  if (!existing) {
    throw new AffiliateLedgerError(404, "NOT_FOUND", "Batch payout afiliasi tidak ditemukan.");
  }
  if (existing.status !== "pending_review") {
    throw new AffiliateLedgerError(
      409,
      "INVALID_STATE_TRANSITION",
      `Batch payout berstatus "${existing.status}" dan tidak dapat ditandai dibayar lagi.`,
    );
  }
  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new AffiliateLedgerError(
      409,
      "STALE_VERSION",
      "Versi batch payout sudah berubah. Muat ulang sebelum melanjutkan.",
    );
  }

  const updateBatchStmt = platformDb
    .prepare(
      `UPDATE affiliate_commission_payout_batches
       SET status = 'paid',
           transfer_reference = ?,
           paid_at = ?,
           paid_by_user_id = ?,
           status_reason = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND status = 'pending_review'
         AND version = ?
         AND EXISTS (
           SELECT 1 FROM platform_operators
           WHERE user_id = ?
             AND revoked_at IS NULL
         )`,
    )
    .bind(
      safeTransferRef,
      nowMs,
      actorUserId,
      validatedReason,
      nowMs,
      existing.id,
      existing.version,
      actorUserId,
    );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "affiliate.payout_batch.paid",
      targetType: "affiliate_payout_batch",
      targetId: existing.id,
      tenantId: null,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
      metadata: {
        affiliateId: existing.affiliate_id,
        payoutPeriodKey: existing.payout_period_key,
        totalAmountIdr: existing.total_amount_idr,
        entryCount: existing.entry_count,
        transferReference: safeTransferRef,
      },
    },
    { onlyIfPreviousChanged: true },
  );

  const updateEntriesStmt = platformDb
    .prepare(
      `UPDATE affiliate_commission_entries
       SET status = 'paid',
           version = version + 1,
           updated_at = ?
       WHERE payout_batch_id = ?
         AND status = 'batched'
         AND EXISTS (
           SELECT 1 FROM affiliate_commission_payout_batches
           WHERE id = ?
             AND status = 'paid'
         )`,
    )
    .bind(nowMs, existing.id, existing.id);

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateBatchStmt, auditStmt, updateEntriesStmt]);
  } catch (err) {
    wrapAuditOrThrow(err);
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const liveOp = await platformDb
      .prepare(
        `SELECT user_id FROM platform_operators
         WHERE user_id = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(actorUserId)
      .first<{ readonly user_id: string }>();
    if (!liveOp) {
      throw new AffiliateLedgerError(
        403,
        "FORBIDDEN",
        "Hak operator platform telah dicabut sebelum pembayaran dapat dicatat.",
      );
    }
    throw new AffiliateLedgerError(
      409,
      "STALE_VERSION",
      "Batch payout berubah secara bersamaan sebelum pembayaran dapat dicatat.",
    );
  }

  const updatedBatch = await platformDb
    .prepare("SELECT * FROM affiliate_commission_payout_batches WHERE id = ? LIMIT 1")
    .bind(existing.id)
    .first<PayoutBatchSqlRow>();

  return {
    batch: updatedBatch ? mapPayoutBatchRow(updatedBatch) : mapPayoutBatchRow(existing),
    paidEntryCount: results[2]?.meta?.changes ?? 0,
    audit,
  };
}

/**
 * Computes exact integer IDR balance buckets for an affiliate across all commission states.
 */
export async function getAffiliateCommissionBalanceSummary(
  platformDb: D1Database,
  affiliateId: string,
): Promise<AffiliateCommissionBalanceSummary> {
  const row = await platformDb
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_idr ELSE 0 END), 0) AS pending_idr,
         COALESCE(SUM(CASE WHEN status = 'approved' AND payout_batch_id IS NULL THEN commission_idr ELSE 0 END), 0) AS approved_available_idr,
         COALESCE(SUM(CASE WHEN status = 'batched' THEN commission_idr ELSE 0 END), 0) AS batched_idr,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_idr ELSE 0 END), 0) AS paid_idr,
         COALESCE(SUM(CASE WHEN status = 'reversed' THEN commission_idr ELSE 0 END), 0) AS reversed_idr
       FROM affiliate_commission_entries
       WHERE affiliate_id = ?`,
    )
    .bind(affiliateId.trim())
    .first<{
      readonly pending_idr: number;
      readonly approved_available_idr: number;
      readonly batched_idr: number;
      readonly paid_idr: number;
      readonly reversed_idr: number;
    }>();

  return {
    affiliateId: affiliateId.trim(),
    pendingIdr: Number(row?.pending_idr ?? 0),
    approvedAvailableIdr: Number(row?.approved_available_idr ?? 0),
    batchedIdr: Number(row?.batched_idr ?? 0),
    paidIdr: Number(row?.paid_idr ?? 0),
    reversedIdr: Number(row?.reversed_idr ?? 0),
  };
}

/**
 * Lists commission entries filtered by affiliate, tenant, status, or payout batch.
 */
export async function listAffiliateCommissionEntries(
  platformDb: D1Database,
  filter: {
    readonly affiliateId?: string;
    readonly tenantId?: string;
    readonly status?: AffiliateCommissionStatus;
    readonly payoutBatchId?: string;
    readonly limit?: number;
  } = {},
): Promise<readonly AffiliateCommissionEntryRecord[]> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (filter.affiliateId?.trim()) {
    clauses.push("affiliate_id = ?");
    bindings.push(filter.affiliateId.trim());
  }
  if (filter.tenantId?.trim()) {
    clauses.push("tenant_id = ?");
    bindings.push(filter.tenantId.trim());
  }
  if (filter.status) {
    clauses.push("status = ?");
    bindings.push(filter.status);
  }
  if (filter.payoutBatchId?.trim()) {
    clauses.push("payout_batch_id = ?");
    bindings.push(filter.payoutBatchId.trim());
  }

  const limit = Math.max(1, Math.min(200, Math.trunc(filter.limit ?? 50)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await platformDb
    .prepare(
      `SELECT * FROM affiliate_commission_entries
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<CommissionEntrySqlRow>();

  return (rows.results ?? []).map(mapCommissionEntryRow);
}

/**
 * Lists affiliate payout batches filtered by affiliate, period key, or status.
 */
export async function listAffiliatePayoutBatches(
  platformDb: D1Database,
  filter: {
    readonly affiliateId?: string;
    readonly payoutPeriodKey?: string;
    readonly status?: AffiliatePayoutBatchStatus;
    readonly limit?: number;
  } = {},
): Promise<readonly AffiliatePayoutBatchRecord[]> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (filter.affiliateId?.trim()) {
    clauses.push("affiliate_id = ?");
    bindings.push(filter.affiliateId.trim());
  }
  if (filter.payoutPeriodKey?.trim()) {
    clauses.push("payout_period_key = ?");
    bindings.push(filter.payoutPeriodKey.trim());
  }
  if (filter.status) {
    clauses.push("status = ?");
    bindings.push(filter.status);
  }

  const limit = Math.max(1, Math.min(200, Math.trunc(filter.limit ?? 50)));
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await platformDb
    .prepare(
      `SELECT * FROM affiliate_commission_payout_batches
       ${whereSql}
       ORDER BY payout_period_key DESC, created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<PayoutBatchSqlRow>();

  return (rows.results ?? []).map(mapPayoutBatchRow);
}
