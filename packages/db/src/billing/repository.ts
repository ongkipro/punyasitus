import {
  AUTOLARIS_DEFAULT_ACCOUNT_ID,
  AUTOLARIS_PROVIDER_ID,
  BILLING_CURRENCY,
  BillingConflictError,
  BillingValidationError,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_OBLIGATION_TTL_MS,
  DEFAULT_YEARLY_PRICE_IDR,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
  PLATFORM_BILLING_SETTING_KEYS,
  assertExactIdrInteger,
  buildImmutableObligationSnapshot,
  computeLifecycleDeadlines,
  computeSubscriptionPeriodPreview,
  generateAutoLarisReffId,
  generateBillingUlid,
  type AllowedPaymentChannelKind,
  type BillingObligationSnapshot,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import { buildPlatformAuditStatement } from "../platform/audit.ts";
import { ensureBillingObligationsSchema } from "./migrations.ts";

/**
 * Tenant-scoped D1 billing repository for subscription obligations and durable
 * AutoLaris payment attempts (REQ-056, PLAN §16.2, §16.3, TASK-055).
 */

export type PaymentAttemptLifecycleState =
  | "creating"
  | "creation_unknown"
  | "pending"
  | "expired"
  | "failed"
  | "paid"
  | "review";

export type BillingObligationApiState = "open" | "paid" | "cancelled" | "expired" | "review";

export interface PlatformBillingPricing {
  readonly monthlyPriceIdr: number;
  readonly yearlyPriceIdr: number;
  readonly yearlySavingsIdr: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly source: "platform_settings" | "default";
}

export interface TenantBillingContextRow {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly agencyId: string | null;
  readonly operatorHold: boolean;
  readonly trialEndsAtMs: number | null;
  readonly paidThroughMs: number | null;
  readonly deletionDueAtMs: number | null;
}

export interface StoredPaymentInstructionPayload {
  readonly qrisPayload: string | null;
  readonly vaNumber: string | null;
  readonly paymentRedirectUrl: string | null;
  readonly grossAdminFeeIdr?: number;
  readonly providerDiscountIdr?: number;
}

export interface BillingObligationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly payerType: "tenant" | "agency";
  readonly payerAgencyId: string | null;
  readonly plan: BillingPlanInterval;
  readonly dbStatus: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly state: BillingObligationApiState;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly periodStartAtMs: number | null;
  readonly periodEndAtMs: number | null;
  readonly periodStartAtIso: string | null;
  readonly periodEndAtIso: string | null;
  readonly dueAtMs: number;
  readonly paidAtMs: number | null;
  readonly reviewRequired: boolean;
  readonly snapshot: BillingObligationSnapshot;
  readonly version: number;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
}

export interface PaymentAttemptRecord {
  readonly id: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly reffId: string;
  readonly plan: BillingPlanInterval;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly providerTransactionId: string | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string | null;
  readonly state: PaymentAttemptLifecycleState;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly taxNotice: string;
  readonly qrisPayload: string | null;
  readonly vaNumber: string | null;
  readonly bankName: string | null;
  readonly paymentRedirectUrl: string | null;
  readonly safeFailureCode: string | null;
  readonly expiresAtMs: number | null;
  readonly expiresAtIso: string | null;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
}

interface BillingObligationSqlRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly payer_type: "tenant" | "agency";
  readonly payer_agency_id: string | null;
  readonly plan_interval: "monthly" | "yearly" | "one_time";
  readonly status: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly gross_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly net_amount_idr: number;
  readonly currency: string | null;
  readonly period_start_at: number | null;
  readonly period_end_at: number | null;
  readonly snapshot_json: string | null;
  readonly due_at: number;
  readonly paid_at: number | null;
  readonly review_required: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface PaymentAttemptSqlRow {
  readonly id: string;
  readonly obligation_id: string;
  readonly tenant_id: string;
  readonly channel: "QRIS" | "VA";
  readonly provider: string;
  readonly provider_account_id: string | null;
  readonly provider_transaction_id: string | null;
  readonly reff_id: string | null;
  readonly channel_code: string | null;
  readonly idempotency_key: string | null;
  readonly request_hash: string | null;
  readonly amount_idr: number;
  readonly state: string;
  readonly lifecycle_state: PaymentAttemptLifecycleState | null;
  readonly base_amount_idr: number | null;
  readonly discount_amount_idr: number | null;
  readonly channel_fee_idr: number | null;
  readonly total_payable_idr: number | null;
  readonly bank_name: string | null;
  readonly safe_failure_code: string | null;
  readonly expires_at: number | null;
  readonly provider_payload_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly obligation_plan_interval?: string | null;
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function mapObligationState(
  dbStatus: BillingObligationSqlRow["status"],
  reviewRequired: boolean,
): BillingObligationApiState {
  if (reviewRequired && dbStatus === "open") return "review";
  if (dbStatus === "canceled" || dbStatus === "refunded") return "cancelled";
  return dbStatus;
}

function parseSnapshotOrFallback(row: BillingObligationSqlRow): BillingObligationSnapshot {
  const plan: BillingPlanInterval = row.plan_interval === "yearly" ? "yearly" : "monthly";
  if (row.snapshot_json) {
    try {
      const parsed = JSON.parse(row.snapshot_json) as BillingObligationSnapshot;
      if (parsed && typeof parsed === "object" && parsed.currency === "IDR") {
        return parsed;
      }
    } catch {
      // Fallback below
    }
  }
  const startIso =
    row.period_start_at !== null
      ? new Date(row.period_start_at).toISOString()
      : new Date(row.created_at).toISOString();
  const endIso =
    row.period_end_at !== null
      ? new Date(row.period_end_at).toISOString()
      : new Date(row.due_at).toISOString();

  return {
    schemaVersion: 1,
    plan,
    months: plan === "yearly" ? 12 : 1,
    currency: BILLING_CURRENCY,
    baseAmountIdr: row.gross_amount_idr,
    discountAmountIdr: row.discount_amount_idr,
    netAmountIdr: row.net_amount_idr,
    estimatedChannelFeeIdr: 0,
    pricingSource: "default",
    periodStartAt: startIso,
    periodEndAt: endIso,
    renewalAnchor: "settlement_time",
    nonPkp: true,
    taxNotice: NON_PKP_TAX_NOTICE,
    noRefundPolicy: true,
    noRefundNotice: NO_REFUND_NOTICE,
    snapshotCreatedAt: new Date(row.created_at).toISOString(),
  };
}

function mapObligationRow(row: BillingObligationSqlRow): BillingObligationRecord {
  const reviewRequired = row.review_required === 1;
  const plan: BillingPlanInterval = row.plan_interval === "yearly" ? "yearly" : "monthly";
  const snapshot = parseSnapshotOrFallback(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    payerType: row.payer_type,
    payerAgencyId: row.payer_agency_id,
    plan,
    dbStatus: row.status,
    state: mapObligationState(row.status, reviewRequired),
    baseAmountIdr: row.gross_amount_idr,
    discountAmountIdr: row.discount_amount_idr,
    netAmountIdr: row.net_amount_idr,
    currency: BILLING_CURRENCY,
    periodStartAtMs: row.period_start_at,
    periodEndAtMs: row.period_end_at,
    periodStartAtIso:
      row.period_start_at !== null ? new Date(row.period_start_at).toISOString() : null,
    periodEndAtIso:
      row.period_end_at !== null ? new Date(row.period_end_at).toISOString() : null,
    dueAtMs: row.due_at,
    paidAtMs: row.paid_at,
    reviewRequired,
    snapshot,
    version: row.version,
    createdAtMs: row.created_at,
    createdAtIso: new Date(row.created_at).toISOString(),
  };
}

function mapAttemptRow(
  row: PaymentAttemptSqlRow,
  planOverride?: BillingPlanInterval,
): PaymentAttemptRecord {
  let payload: StoredPaymentInstructionPayload = {
    qrisPayload: null,
    vaNumber: null,
    paymentRedirectUrl: null,
  };
  if (row.provider_payload_json) {
    try {
      const parsed = JSON.parse(row.provider_payload_json) as Partial<StoredPaymentInstructionPayload>;
      payload = {
        qrisPayload: typeof parsed.qrisPayload === "string" ? parsed.qrisPayload : null,
        vaNumber: typeof parsed.vaNumber === "string" ? parsed.vaNumber : null,
        paymentRedirectUrl:
          typeof parsed.paymentRedirectUrl === "string" ? parsed.paymentRedirectUrl : null,
      };
    } catch {
      // Ignore unparseable legacy payload
    }
  }

  const plan: BillingPlanInterval =
    planOverride ?? (row.obligation_plan_interval === "yearly" ? "yearly" : "monthly");
  const lifecycleState: PaymentAttemptLifecycleState =
    row.lifecycle_state ??
    (row.state === "settled"
      ? "paid"
      : row.state === "pending"
        ? "pending"
        : row.state === "expired"
          ? "expired"
          : row.state === "failed"
            ? "failed"
            : "creating");

  const baseAmountIdr = row.base_amount_idr ?? row.amount_idr;
  const discountAmountIdr = row.discount_amount_idr ?? 0;
  const channelFeeIdr = row.channel_fee_idr ?? 0;
  const totalPayableIdr =
    row.total_payable_idr && row.total_payable_idr > 0 ? row.total_payable_idr : row.amount_idr;

  return {
    id: row.id,
    obligationId: row.obligation_id,
    tenantId: row.tenant_id,
    providerAccountId: row.provider_account_id ?? AUTOLARIS_DEFAULT_ACCOUNT_ID,
    reffId: row.reff_id ?? row.id,
    plan,
    channelKind: row.channel,
    channelCode: row.channel_code ?? row.channel,
    providerTransactionId: row.provider_transaction_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    state: lifecycleState,
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalPayableIdr,
    currency: BILLING_CURRENCY,
    taxNotice: NON_PKP_TAX_NOTICE,
    qrisPayload: payload.qrisPayload,
    vaNumber: payload.vaNumber,
    bankName: row.bank_name,
    paymentRedirectUrl: payload.paymentRedirectUrl,
    safeFailureCode: row.safe_failure_code,
    expiresAtMs: row.expires_at,
    expiresAtIso: row.expires_at !== null ? new Date(row.expires_at).toISOString() : null,
    createdAtMs: row.created_at,
    createdAtIso: new Date(row.created_at).toISOString(),
  };
}

function tryParseValidPrice(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return null;
  if (raw < MIN_AUTOLARIS_CHARGE_IDR || raw > MAX_IDR_AMOUNT) return null;
  return raw;
}

/**
 * Loads server-owned monthly & yearly IDR pricing from `PLATFORM_DB.platform_settings`,
 * falling back to canonical defaults (`Rp 179.000` monthly / `Rp 1.790.000` yearly).
 */
export async function loadPlatformBillingPricing(db: D1Database): Promise<PlatformBillingPricing> {
  const rows = await db
    .prepare(
      `SELECT key, value_json
       FROM platform_settings
       WHERE key IN (?, ?, ?)`,
    )
    .bind(
      PLATFORM_BILLING_SETTING_KEYS.pricing,
      PLATFORM_BILLING_SETTING_KEYS.monthlyPriceIdr,
      PLATFORM_BILLING_SETTING_KEYS.yearlyPriceIdr,
    )
    .all<{ readonly key: string; readonly value_json: string }>();

  let monthlyPriceIdr: number | null = null;
  let yearlyPriceIdr: number | null = null;

  for (const row of rows.results ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      continue;
    }

    if (row.key === PLATFORM_BILLING_SETTING_KEYS.pricing && parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      monthlyPriceIdr = tryParseValidPrice(obj.monthlyPriceIdr) ?? monthlyPriceIdr;
      yearlyPriceIdr = tryParseValidPrice(obj.yearlyPriceIdr) ?? yearlyPriceIdr;
    } else if (row.key === PLATFORM_BILLING_SETTING_KEYS.monthlyPriceIdr) {
      monthlyPriceIdr = tryParseValidPrice(parsed) ?? monthlyPriceIdr;
    } else if (row.key === PLATFORM_BILLING_SETTING_KEYS.yearlyPriceIdr) {
      yearlyPriceIdr = tryParseValidPrice(parsed) ?? yearlyPriceIdr;
    }
  }

  const resolvedMonthly = monthlyPriceIdr ?? DEFAULT_MONTHLY_PRICE_IDR;
  const resolvedYearly = yearlyPriceIdr ?? DEFAULT_YEARLY_PRICE_IDR;
  const source: "platform_settings" | "default" =
    monthlyPriceIdr !== null || yearlyPriceIdr !== null ? "platform_settings" : "default";

  return {
    monthlyPriceIdr: resolvedMonthly,
    yearlyPriceIdr: resolvedYearly,
    yearlySavingsIdr: Math.max(0, resolvedMonthly * 12 - resolvedYearly),
    currency: BILLING_CURRENCY,
    source,
  };
}

export async function loadTenantBillingContext(
  db: D1Database,
  tenantId: string,
): Promise<TenantBillingContextRow | null> {
  const row = await db
    .prepare(
      `SELECT id, handle, name, status, agency_id, operator_hold, trial_ends_at, paid_through, deletion_due_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly name: string;
      readonly status: TenantStatus;
      readonly agency_id: string | null;
      readonly operator_hold: number;
      readonly trial_ends_at: number | null;
      readonly paid_through: number | null;
      readonly deletion_due_at: number | null;
    }>();

  if (!row) return null;
  return {
    tenantId: row.id,
    handle: row.handle,
    name: row.name,
    status: row.status,
    agencyId: row.agency_id,
    operatorHold: row.operator_hold === 1,
    trialEndsAtMs: row.trial_ends_at,
    paidThroughMs: row.paid_through,
    deletionDueAtMs: row.deletion_due_at,
  };
}

export async function loadUserContactForBilling(
  db: D1Database,
  userId: string,
): Promise<{ readonly name: string; readonly email: string }> {
  const row = await db
    .prepare("SELECT name, email FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ readonly name: string; readonly email: string }>();
  return {
    name: row?.name ?? "Pemilik Situs",
    email: row?.email ?? "owner@punyasitus.com",
  };
}

const OBLIGATION_SELECT_COLUMNS = `
  id,
  tenant_id,
  payer_type,
  payer_agency_id,
  plan_interval,
  status,
  gross_amount_idr,
  discount_amount_idr,
  net_amount_idr,
  currency,
  period_start_at,
  period_end_at,
  snapshot_json,
  due_at,
  paid_at,
  review_required,
  version,
  created_at,
  updated_at
`.trim();

const ATTEMPT_SELECT_COLUMNS = `
  pa.id,
  pa.obligation_id,
  pa.tenant_id,
  pa.channel,
  pa.provider,
  pa.provider_account_id,
  pa.provider_transaction_id,
  pa.reff_id,
  pa.channel_code,
  pa.idempotency_key,
  pa.request_hash,
  pa.amount_idr,
  pa.state,
  pa.lifecycle_state,
  pa.base_amount_idr,
  pa.discount_amount_idr,
  pa.channel_fee_idr,
  pa.total_payable_idr,
  pa.bank_name,
  pa.safe_failure_code,
  pa.expires_at,
  pa.provider_payload_json,
  pa.created_at,
  pa.updated_at,
  bo.plan_interval AS obligation_plan_interval
`.trim();

export async function getTenantObligationById(
  db: D1Database,
  tenantId: string,
  obligationId: string,
): Promise<{
  readonly obligation: BillingObligationRecord;
  readonly latestAttempt: PaymentAttemptRecord | null;
} | null> {
  await ensureBillingObligationsSchema(db);

  const row = await db
    .prepare(
      `SELECT ${OBLIGATION_SELECT_COLUMNS}
       FROM billing_obligations
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(obligationId, tenantId)
    .first<BillingObligationSqlRow>();

  if (!row) return null;
  const obligation = mapObligationRow(row);

  const attemptRow = await db
    .prepare(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       WHERE pa.obligation_id = ? AND pa.tenant_id = ?
       ORDER BY pa.created_at DESC
       LIMIT 1`,
    )
    .bind(obligation.id, tenantId)
    .first<PaymentAttemptSqlRow>();

  return {
    obligation,
    latestAttempt: attemptRow ? mapAttemptRow(attemptRow, obligation.plan) : null,
  };
}

export async function getTenantPaymentAttemptById(
  db: D1Database,
  tenantId: string,
  attemptId: string,
): Promise<PaymentAttemptRecord | null> {
  await ensureBillingObligationsSchema(db);

  const row = await db
    .prepare(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       WHERE pa.id = ? AND pa.tenant_id = ?
       LIMIT 1`,
    )
    .bind(attemptId, tenantId)
    .first<PaymentAttemptSqlRow>();

  return row ? mapAttemptRow(row) : null;
}

export async function listTenantObligations(
  db: D1Database,
  tenantId: string,
  limit = 20,
): Promise<readonly BillingObligationRecord[]> {
  await ensureBillingObligationsSchema(db);
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));

  const rows = await db
    .prepare(
      `SELECT ${OBLIGATION_SELECT_COLUMNS}
       FROM billing_obligations
       WHERE tenant_id = ? AND plan_interval IN ('monthly', 'yearly')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(tenantId, safeLimit)
    .all<BillingObligationSqlRow>();

  return (rows.results ?? []).map(mapObligationRow);
}

export async function getTenantBillingOverviewData(
  db: D1Database,
  tenantId: string,
  effectiveStatus: TenantStatus,
): Promise<{
  readonly tenantStatus: TenantStatus;
  readonly deadlines: ReturnType<typeof computeLifecycleDeadlines>;
  readonly pricing: PlatformBillingPricing;
  readonly activeObligation: BillingObligationRecord | null;
  readonly activeAttempt: PaymentAttemptRecord | null;
  readonly obligations: readonly BillingObligationRecord[];
  readonly taxNotice: string;
  readonly noRefundNotice: string;
}> {
  await ensureBillingObligationsSchema(db);

  const [tenantCtx, pricing, obligations] = await Promise.all([
    loadTenantBillingContext(db, tenantId),
    loadPlatformBillingPricing(db),
    listTenantObligations(db, tenantId, 20),
  ]);

  const deadlines = computeLifecycleDeadlines({
    paidThroughMs: tenantCtx?.paidThroughMs ?? null,
    trialEndsAtMs: tenantCtx?.trialEndsAtMs ?? null,
    deletionDueAtMs: tenantCtx?.deletionDueAtMs ?? null,
  });

  const activeObligation =
    obligations.find((o) => o.dbStatus === "open") ?? null;

  let activeAttempt: PaymentAttemptRecord | null = null;
  if (activeObligation) {
    const attemptRow = await db
      .prepare(
        `SELECT ${ATTEMPT_SELECT_COLUMNS}
         FROM payment_attempts pa
         INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
         WHERE pa.obligation_id = ? AND pa.tenant_id = ?
         ORDER BY pa.created_at DESC
         LIMIT 1`,
      )
      .bind(activeObligation.id, tenantId)
      .first<PaymentAttemptSqlRow>();
    activeAttempt = attemptRow ? mapAttemptRow(attemptRow, activeObligation.plan) : null;
  }

  return {
    tenantStatus: effectiveStatus,
    deadlines,
    pricing,
    activeObligation,
    activeAttempt,
    obligations,
    taxNotice: NON_PKP_TAX_NOTICE,
    noRefundNotice: NO_REFUND_NOTICE,
  };
}

export interface BeginDurableAttemptInput {
  readonly tenantId: string;
  readonly effectiveTenantStatus: TenantStatus;
  readonly payerType: "tenant" | "agency";
  readonly payerAgencyId: string | null;
  readonly plan: BillingPlanInterval;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly estimatedChannelFeeIdr: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly providerAccountId: string;
  readonly nowMs: number;
}

export type BeginDurableAttemptResult =
  | {
      readonly mode: "replay";
      readonly obligation: BillingObligationRecord;
      readonly attempt: PaymentAttemptRecord;
    }
  | {
      readonly mode: "created";
      readonly obligation: BillingObligationRecord;
      readonly attempt: PaymentAttemptRecord;
    };

async function findAttemptByIdempotencyKey(
  db: D1Database,
  tenantId: string,
  idempotencyKey: string,
): Promise<PaymentAttemptRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       WHERE pa.tenant_id = ? AND pa.idempotency_key = ?
       LIMIT 1`,
    )
    .bind(tenantId, idempotencyKey)
    .first<PaymentAttemptSqlRow>();
  return row ? mapAttemptRow(row) : null;
}

async function hasCouponRedemptionsTableSafe(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coupon_redemptions' LIMIT 1",
    )
    .first<{ readonly name: string }>();
  return Boolean(row);
}

export async function findOpenSubscriptionObligation(
  db: D1Database,
  tenantId: string,
): Promise<BillingObligationRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${OBLIGATION_SELECT_COLUMNS}
       FROM billing_obligations
       WHERE tenant_id = ? AND status = 'open' AND plan_interval IN ('monthly', 'yearly')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<BillingObligationSqlRow>();
  return row ? mapObligationRow(row) : null;
}

export function extractLockedCouponCodeFromObligation(
  obligation: BillingObligationRecord,
): string | null {
  const snap = obligation.snapshot as typeof obligation.snapshot & {
    readonly coupon?: { readonly code?: string } | null;
  };
  return typeof snap.coupon?.code === "string" && snap.coupon.code.trim().length > 0
    ? snap.coupon.code.trim().toUpperCase()
    : null;
}

/**
 * Atomically transitions an `'open'` obligation without unresolved/paid attempts to a terminal
 * non-paid state (`'expired'` or `'canceled'`) and — when `0010_billing_coupons` is present —
 * releases its `'reserved'` coupon redemption and decrements `promo_coupons.redeemed_count`
 * by 1 (guarded by `changes() = 1` so it can NEVER decrement twice!).
 */
export async function closeBillingObligationNonPaid(
  db: D1Database,
  input: {
    readonly obligationId: string;
    readonly tenantId: string;
    readonly targetStatus: "expired" | "canceled";
    readonly nowMs: number;
  },
): Promise<{ readonly closed: boolean; readonly couponReleased: boolean }> {
  const nowMs = Math.trunc(input.nowMs);
  const hasCouponTable = await hasCouponRedemptionsTableSafe(db);

  const closeOblStmt = db
    .prepare(
      `UPDATE billing_obligations
       SET status = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND status = 'open'
         AND review_required = 0
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts
           WHERE obligation_id = ?
             AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review', 'paid')
         )`,
    )
    .bind(input.targetStatus, nowMs, input.obligationId, input.tenantId, input.obligationId);

  if (!hasCouponTable) {
    const res = await closeOblStmt.run();
    return { closed: (res.meta?.changes ?? 0) === 1, couponReleased: false };
  }

  const releaseRedemptionStmt = db
    .prepare(
      `UPDATE coupon_redemptions
       SET status = 'released',
           updated_at = ?
       WHERE obligation_id = ?
         AND status = 'reserved'
         AND changes() = 1`,
    )
    .bind(nowMs, input.obligationId);

  const decrementCouponStmt = db
    .prepare(
      `UPDATE promo_coupons
       SET redeemed_count = CASE WHEN redeemed_count > 0 THEN redeemed_count - 1 ELSE 0 END,
           updated_at = ?
       WHERE id = (
         SELECT coupon_id FROM coupon_redemptions WHERE obligation_id = ? LIMIT 1
       )
         AND changes() = 1`,
    )
    .bind(nowMs, input.obligationId);

  const results = await db.batch([closeOblStmt, releaseRedemptionStmt, decrementCouponStmt]);
  return {
    closed: (results[0]?.meta?.changes ?? 0) === 1,
    couponReleased: (results[1]?.meta?.changes ?? 0) === 1,
  };
}

/**
 * Expires stale `'open'` subscription obligations (`due_at <= nowMs`) for a tenant that have
 * no unresolved/paid attempts, releasing any reserved promotional coupon atomically.
 */
export async function expireStaleOpenObligationsForTenant(
  db: D1Database,
  tenantId: string,
  nowMs: number,
): Promise<number> {
  const safeNow = Math.trunc(nowMs);
  const staleRows = await db
    .prepare(
      `SELECT id
       FROM billing_obligations bo
       WHERE bo.tenant_id = ?
         AND bo.status = 'open'
         AND bo.plan_interval IN ('monthly', 'yearly')
         AND bo.review_required = 0
         AND bo.due_at <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts pa
           WHERE pa.obligation_id = bo.id
             AND pa.lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review', 'paid')
         )`,
    )
    .bind(tenantId, safeNow)
    .all<{ readonly id: string }>();

  let closedCount = 0;
  for (const row of staleRows.results ?? []) {
    const res = await closeBillingObligationNonPaid(db, {
      obligationId: row.id,
      tenantId,
      targetStatus: "expired",
      nowMs: safeNow,
    });
    if (res.closed) closedCount += 1;
  }
  return closedCount;
}

async function findUnresolvedAttemptForObligation(
  db: D1Database,
  tenantId: string,
  obligationId: string,
): Promise<PaymentAttemptRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${ATTEMPT_SELECT_COLUMNS}
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       WHERE pa.tenant_id = ?
         AND pa.obligation_id = ?
         AND pa.lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       LIMIT 1`,
    )
    .bind(tenantId, obligationId)
    .first<PaymentAttemptSqlRow>();
  return row ? mapAttemptRow(row) : null;
}

function handleExistingIdempotencyMatch(
  existingAttempt: PaymentAttemptRecord,
  existingObligation: BillingObligationRecord,
  requestHash: string,
): BeginDurableAttemptResult {
  if (existingAttempt.requestHash !== requestHash) {
    throw new BillingConflictError(
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "Idempotency-Key sudah digunakan untuk permintaan pembayaran dengan payload berbeda.",
    );
  }

  if (existingAttempt.state === "pending" || existingAttempt.state === "paid") {
    return {
      mode: "replay",
      obligation: existingObligation,
      attempt: existingAttempt,
    };
  }

  if (existingAttempt.state === "creation_unknown" || existingAttempt.state === "review") {
    throw new BillingConflictError(
      "CONFLICT",
      "RECONCILIATION_REQUIRED",
      "Percobaan pembayaran sebelumnya berada dalam status rekonsiliasi; pembuatan tagihan ganda diblokir.",
    );
  }

  if (existingAttempt.state === "creating") {
    throw new BillingConflictError(
      "CONFLICT",
      "PAYMENT_CREATION_IN_PROGRESS",
      "Pembuatan instruksi pembayaran sedang diproses; silakan tunggu sebelum mengulang.",
    );
  }

  throw new BillingConflictError(
    "IDEMPOTENCY_CONFLICT",
    "IDEMPOTENCY_KEY_EXHAUSTED",
    "Percobaan pembayaran sebelumnya sudah ditutup; gunakan Idempotency-Key baru untuk mencoba lagi.",
  );
}

/**
 * Durable pre-call persistence step (PLAN §16.2, §16.3):
 * Persists the immutable `billing_obligations` snapshot AND the `payment_attempts` row
 * (`lifecycle_state = 'creating'`, `reff_id`, `idempotency_key`, `request_hash`) BEFORE
 * any outbound AutoLaris HTTP call. No DB transaction is held open across the network request.
 *
 * Concurrency & crash-safety guarantees enforced via SQLite partial unique indexes:
 * - Concurrent requests for the same tenant/obligation CANNOT trigger 2 AutoLaris calls.
 * - Same `Idempotency-Key` + same payload replays existing `pending`/`paid` instruction cleanly.
 * - Same `Idempotency-Key` + mismatched payload returns `409 IDEMPOTENCY_CONFLICT` with zero side effects.
 * - Existing `creating` / `creation_unknown` / `review` / `pending` attempt blocks blind retry or channel switch (`409 CONFLICT`).
 */
export async function beginDurablePaymentAttempt(
  db: D1Database,
  input: BeginDurableAttemptInput,
): Promise<BeginDurableAttemptResult> {
  await ensureBillingObligationsSchema(db, () => input.nowMs);

  // 1. Check idempotency key first (fast path + mismatch detection)
  const existingByKey = await findAttemptByIdempotencyKey(db, input.tenantId, input.idempotencyKey);
  if (existingByKey) {
    const obl = await getTenantObligationById(db, input.tenantId, existingByKey.obligationId);
    if (!obl) {
      throw new BillingConflictError(
        "CONFLICT",
        "ORPHANED_PAYMENT_ATTEMPT",
        "Tagihan terkait Idempotency-Key tidak ditemukan.",
      );
    }
    return handleExistingIdempotencyMatch(existingByKey, obl.obligation, input.requestHash);
  }

  // 2. Load authoritative server pricing & tenant lifecycle context
  const [tenantCtx, pricing] = await Promise.all([
    loadTenantBillingContext(db, input.tenantId),
    loadPlatformBillingPricing(db),
  ]);
  if (!tenantCtx) {
    throw new BillingValidationError("TENANT_NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const baseAmountIdr = assertExactIdrInteger(
    input.plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr,
    "baseAmountIdr",
    { min: MIN_AUTOLARIS_CHARGE_IDR, max: MAX_IDR_AMOUNT },
  );
  const discountAmountIdr = 0; // Single-coupon engine arrives in TASK-082; server always owns discount
  const netAmountIdr = baseAmountIdr - discountAmountIdr;
  const estimatedFeeIdr = assertExactIdrInteger(
    input.estimatedChannelFeeIdr,
    "estimatedChannelFeeIdr",
    { min: 0 },
  );

  // 3. Expire any stale open obligations past due_at (releasing reserved coupons atomically),
  //    then reuse or create the single open subscription obligation for this tenant
  await expireStaleOpenObligationsForTenant(db, input.tenantId, input.nowMs);
  let obligation = await findOpenSubscriptionObligation(db, input.tenantId);

  if (obligation) {
    const unresolved = await findUnresolvedAttemptForObligation(db, input.tenantId, obligation.id);
    if (unresolved) {
      if (unresolved.idempotencyKey === input.idempotencyKey) {
        return handleExistingIdempotencyMatch(unresolved, obligation, input.requestHash);
      }
      const reasonCode =
        unresolved.state === "creation_unknown" || unresolved.state === "review"
          ? "RECONCILIATION_REQUIRED"
          : unresolved.state === "creating"
            ? "PAYMENT_CREATION_IN_PROGRESS"
            : "ACTIVE_ATTEMPT_EXISTS";
      throw new BillingConflictError(
        "CONFLICT",
        reasonCode,
        reasonCode === "RECONCILIATION_REQUIRED"
          ? "Tagihan ini memiliki transaksi yang menunggu rekonsiliasi; pembuatan percobaan baru diblokir."
          : "Tagihan aktif sudah memiliki instruksi pembayaran yang belum selesai.",
      );
    }

    if (obligation.plan !== input.plan) {
      throw new BillingConflictError(
        "CONFLICT",
        "OPEN_OBLIGATION_PLAN_MISMATCH",
        `Tagihan terbuka saat ini memakai paket "${obligation.plan}"; selesaikan atau batalkan sebelum mengganti paket.`,
      );
    }
  } else {
    const period = computeSubscriptionPeriodPreview({
      plan: input.plan,
      tenantStatus: input.effectiveTenantStatus,
      paidThroughMs: tenantCtx.paidThroughMs,
      trialEndsAtMs: tenantCtx.trialEndsAtMs,
      nowMs: input.nowMs,
    });

    const snapshot = buildImmutableObligationSnapshot({
      plan: input.plan,
      baseAmountIdr,
      discountAmountIdr,
      estimatedChannelFeeIdr: estimatedFeeIdr,
      pricingSource: pricing.source,
      period,
      createdAtMs: input.nowMs,
    });

    const newObligationId = generateBillingUlid(input.nowMs);
    const dueAtMs = input.nowMs + DEFAULT_OBLIGATION_TTL_MS;

    try {
      await db
        .prepare(
          `INSERT INTO billing_obligations (
             id,
             tenant_id,
             payer_type,
             payer_agency_id,
             plan_interval,
             status,
             gross_amount_idr,
             discount_amount_idr,
             net_amount_idr,
             currency,
             period_start_at,
             period_end_at,
             snapshot_json,
             idempotency_key,
             request_hash,
             due_at,
             review_required,
             version,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .bind(
          newObligationId,
          input.tenantId,
          input.payerType,
          input.payerAgencyId,
          input.plan,
          baseAmountIdr,
          discountAmountIdr,
          netAmountIdr,
          BILLING_CURRENCY,
          period.periodStartAtMs,
          period.periodEndAtMs,
          JSON.stringify(snapshot),
          input.idempotencyKey,
          input.requestHash,
          dueAtMs,
          input.nowMs,
          input.nowMs,
        )
        .run();

      const inserted = await getTenantObligationById(db, input.tenantId, newObligationId);
      if (!inserted) {
        throw new Error("OBLIGATION_INSERT_READBACK_FAILED");
      }
      obligation = inserted.obligation;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Another concurrent request created the open obligation first — re-read cleanly.
      const racedKey = await findAttemptByIdempotencyKey(db, input.tenantId, input.idempotencyKey);
      if (racedKey) {
        const racedObl = await getTenantObligationById(db, input.tenantId, racedKey.obligationId);
        if (racedObl) {
          return handleExistingIdempotencyMatch(racedKey, racedObl.obligation, input.requestHash);
        }
      }
      const racedObligation = await findOpenSubscriptionObligation(db, input.tenantId);
      if (!racedObligation) {
        throw new BillingConflictError(
          "CONFLICT",
          "CONCURRENT_OBLIGATION_RACE",
          "Permintaan pembayaran lain sedang berlangsung; silakan coba lagi.",
        );
      }
      if (racedObligation.plan !== input.plan) {
        throw new BillingConflictError(
          "CONFLICT",
          "OPEN_OBLIGATION_PLAN_MISMATCH",
          `Tagihan terbuka saat ini memakai paket "${racedObligation.plan}"; selesaikan atau batalkan sebelum mengganti paket.`,
        );
      }
      obligation = racedObligation;
    }
  }

  // 4. Persist durable `payment_attempts` row in `creating` state BEFORE calling AutoLaris
  const attemptId = generateBillingUlid(input.nowMs);
  const reffId = generateAutoLarisReffId(input.nowMs);
  const provisionalTotalIdr = obligation.netAmountIdr + estimatedFeeIdr;

  try {
    await db
      .prepare(
        `INSERT INTO payment_attempts (
           id,
           obligation_id,
           tenant_id,
           channel,
           provider,
           provider_account_id,
           provider_transaction_id,
           reff_id,
           channel_code,
           idempotency_key,
           request_hash,
           amount_idr,
           state,
           lifecycle_state,
           base_amount_idr,
           discount_amount_idr,
           channel_fee_idr,
           total_payable_idr,
           bank_name,
           safe_failure_code,
           expires_at,
           provider_payload_json,
           provider_submitted_at,
           version,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'initiated', 'creating', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
      )
      .bind(
        attemptId,
        obligation.id,
        input.tenantId,
        input.channelKind,
        AUTOLARIS_PROVIDER_ID,
        input.providerAccountId,
        reffId,
        input.channelCode,
        input.idempotencyKey,
        input.requestHash,
        provisionalTotalIdr,
        obligation.baseAmountIdr,
        obligation.discountAmountIdr,
        estimatedFeeIdr,
        provisionalTotalIdr,
        input.nowMs,
        input.nowMs,
        input.nowMs,
      )
      .run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    // Concurrent race caught atomically by SQLite unique partial indexes!
    const racedByKey = await findAttemptByIdempotencyKey(db, input.tenantId, input.idempotencyKey);
    if (racedByKey) {
      const obl = await getTenantObligationById(db, input.tenantId, racedByKey.obligationId);
      if (obl) {
        return handleExistingIdempotencyMatch(racedByKey, obl.obligation, input.requestHash);
      }
    }

    const unresolved = await findUnresolvedAttemptForObligation(db, input.tenantId, obligation.id);
    const reasonCode =
      unresolved?.state === "creation_unknown" || unresolved?.state === "review"
        ? "RECONCILIATION_REQUIRED"
        : unresolved?.state === "creating"
          ? "PAYMENT_CREATION_IN_PROGRESS"
          : "ACTIVE_ATTEMPT_EXISTS";
    throw new BillingConflictError(
      "CONFLICT",
      reasonCode,
      "Tagihan sudah memiliki percobaan pembayaran aktif atau sedang diproses.",
    );
  }

  const createdAttempt = await getTenantPaymentAttemptById(db, input.tenantId, attemptId);
  if (!createdAttempt) {
    throw new Error("ATTEMPT_INSERT_READBACK_FAILED");
  }

  return {
    mode: "created",
    obligation,
    attempt: createdAttempt,
  };
}

/**
 * Atomically persists AutoLaris `transaction_id`, payment instructions, and confirmed costs
 * with a redacted `platform_audit` entry.
 */
export async function completePaymentAttemptPending(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly providerTransactionId: string;
    readonly channelFeeIdr: number;
    readonly grossAdminFeeIdr: number;
    readonly providerDiscountIdr: number;
    readonly totalPayableIdr: number;
    readonly qrisPayload: string | null;
    readonly vaNumber: string | null;
    readonly bankName: string | null;
    readonly paymentRedirectUrl: string | null;
    readonly expiresAtMs: number | null;
    readonly nowMs: number;
  },
): Promise<PaymentAttemptRecord> {
  const payloadJson = JSON.stringify({
    qrisPayload: input.qrisPayload,
    vaNumber: input.vaNumber,
    paymentRedirectUrl: input.paymentRedirectUrl,
    grossAdminFeeIdr: input.grossAdminFeeIdr,
    providerDiscountIdr: input.providerDiscountIdr,
  } satisfies StoredPaymentInstructionPayload);

  const updateStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET state = 'pending',
           lifecycle_state = 'pending',
           provider_transaction_id = ?,
           amount_idr = ?,
           channel_fee_idr = ?,
           total_payable_idr = ?,
           bank_name = ?,
           expires_at = ?,
           provider_payload_json = ?,
           safe_failure_code = NULL,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state = 'creating'`,
    )
    .bind(
      input.providerTransactionId,
      input.totalPayableIdr,
      input.channelFeeIdr,
      input.totalPayableIdr,
      input.bankName,
      input.expiresAtMs,
      payloadJson,
      input.nowMs,
      input.attemptId,
      input.obligationId,
      input.tenantId,
    );

  // Never log QRIS payload, VA number, or secrets into platform_audit!
  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing.attempt.created",
    targetType: "payment_attempt",
    targetId: input.attemptId,
    tenantId: input.tenantId,
    outcome: "success",
    requestId: input.requestId,
    metadata: {
      obligationId: input.obligationId,
      providerTransactionId: input.providerTransactionId,
      channelFeeIdr: input.channelFeeIdr,
      totalPayableIdr: input.totalPayableIdr,
    },
    createdAtMs: input.nowMs,
  });

  await db.batch([updateStmt, auditStmt]);

  const updated = await getTenantPaymentAttemptById(db, input.tenantId, input.attemptId);
  if (!updated) {
    throw new Error("ATTEMPT_COMPLETE_READBACK_FAILED");
  }
  return updated;
}

/**
 * Transitions a `creating` attempt into `creation_unknown` on timeout/network/5xx/crash
 * before `provider_transaction_id` persistence. Blocks blind duplicate creation!
 */
export async function markPaymentAttemptUncertain(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly safeFailureCode: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const updateStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET state = 'initiated',
           lifecycle_state = 'creation_unknown',
           safe_failure_code = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state = 'creating'`,
    )
    .bind(input.safeFailureCode, input.nowMs, input.attemptId, input.obligationId, input.tenantId);

  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing.attempt.creation_unknown",
    targetType: "payment_attempt",
    targetId: input.attemptId,
    tenantId: input.tenantId,
    outcome: "error",
    requestId: input.requestId,
    metadata: {
      obligationId: input.obligationId,
      safeFailureCode: input.safeFailureCode,
    },
    createdAtMs: input.nowMs,
  });

  await db.batch([updateStmt, auditStmt]);
}

/**
 * Transitions a `creating` attempt into `review` when AutoLaris returned `rc === "00"`
 * with invalid fees, unexpected shipping/COD cost, mismatched total, or missing/unsafe instructions.
 * Persists `provider_transaction_id` if present, NEVER marks paid, and blocks duplicate creation.
 */
export async function markPaymentAttemptReview(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly providerTransactionId: string | null;
    readonly safeFailureCode: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const updateAttemptStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET state = 'failed',
           lifecycle_state = 'review',
           provider_transaction_id = COALESCE(?, provider_transaction_id),
           safe_failure_code = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state = 'creating'`,
    )
    .bind(
      input.providerTransactionId,
      input.safeFailureCode,
      input.nowMs,
      input.attemptId,
      input.obligationId,
      input.tenantId,
    );

  const updateObligationStmt = db
    .prepare(
      `UPDATE billing_obligations
       SET review_required = 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .bind(input.nowMs, input.obligationId, input.tenantId);

  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing.attempt.review_flagged",
    targetType: "payment_attempt",
    targetId: input.attemptId,
    tenantId: input.tenantId,
    outcome: "error",
    requestId: input.requestId,
    metadata: {
      obligationId: input.obligationId,
      providerTransactionId: input.providerTransactionId,
      safeFailureCode: input.safeFailureCode,
    },
    createdAtMs: input.nowMs,
  });

  await db.batch([updateAttemptStmt, updateObligationStmt, auditStmt]);
}

/**
 * Transitions a `creating` attempt into `failed` ONLY on a definite provider refusal
 * (e.g. `rc: "01"`, `rc: "07"`, HTTP 400/401/403), releasing the unresolved lock so the
 * owner can retry with a fresh `Idempotency-Key`.
 */
export async function markPaymentAttemptDefiniteFailure(
  db: D1Database,
  input: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly safeFailureCode: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const updateStmt = db
    .prepare(
      `UPDATE payment_attempts
       SET state = 'failed',
           lifecycle_state = 'failed',
           safe_failure_code = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND obligation_id = ?
         AND tenant_id = ?
         AND lifecycle_state = 'creating'`,
    )
    .bind(input.safeFailureCode, input.nowMs, input.attemptId, input.obligationId, input.tenantId);

  const { statement: auditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "billing.attempt.refused",
    targetType: "payment_attempt",
    targetId: input.attemptId,
    tenantId: input.tenantId,
    outcome: "error",
    requestId: input.requestId,
    metadata: {
      obligationId: input.obligationId,
      safeFailureCode: input.safeFailureCode,
    },
    createdAtMs: input.nowMs,
  });

  await db.batch([updateStmt, auditStmt]);
}
