import {
  AUTOLARIS_PROVIDER_ID,
  BILLING_CURRENCY,
  BillingConflictError,
  BillingValidationError,
  DEFAULT_OBLIGATION_TTL_MS,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
  assertExactIdrInteger,
  buildImmutableObligationSnapshot,
  computeSubscriptionPeriodPreview,
  generateAutoLarisReffId,
  generateBillingUlid,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import {
  buildCouponSnapshot,
  evaluateCouponEligibility,
  parseSingleCouponCodeInput,
  type CouponDiscountBreakdown,
  type CouponDiscountKind,
  type CouponEligibilityResult,
  type CouponPayerType,
  type CouponRedemptionRecord,
  type CouponRedemptionStatus,
  type CouponSnapshot,
  type PromoCouponRecord,
  type ValidatedCreatePromoCouponInput,
  type ValidatedUpdatePromoCouponInput,
} from "@punyasitus/core/billing/coupons";
import { buildPlatformAuditStatement, type PlatformAuditRecord } from "../../platform/audit.ts";
import {
  expireStaleOpenObligationsForTenant,
  getTenantObligationById,
  getTenantPaymentAttemptById,
  loadPlatformBillingPricing,
  loadTenantBillingContext,
  type BeginDurableAttemptInput,
  type BeginDurableAttemptResult,
  type BillingObligationRecord,
  type PaymentAttemptRecord,
} from "../repository.ts";

/**
 * Atomic D1 Promotional Coupon Engine & Audited Console Repository
 * (REQ-082, PLAN §16.1, §17.1, §19.3, TASK-082).
 *
 * ZERO runtime DDL: assumes `0010_billing_coupons.sql` is applied via platform migrations.
 */

export type CouponRepositoryErrorCode =
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "COUPON_CODE_EXISTS"
  | "INVALID_MAX_REDEMPTIONS_CAP"
  | "INVALID_VALIDITY_WINDOW"
  | "VALIDATION_ERROR";

export class CouponRepositoryError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: CouponRepositoryErrorCode;

  constructor(status: 404 | 409 | 422, code: CouponRepositoryErrorCode, message: string) {
    super(message);
    this.name = "CouponRepositoryError";
    this.status = status;
    this.code = code;
  }
}

interface PromoCouponSqlRow {
  readonly id: string;
  readonly code: string;
  readonly discount_kind: CouponDiscountKind;
  readonly discount_value: number;
  readonly eligible_plans_json: string;
  readonly eligible_payer_types_json: string | null;
  readonly max_redemptions: number | null;
  readonly redeemed_count: number;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly active: number;
  readonly notes: string | null;
  readonly created_by_user_id: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface CouponRedemptionSqlRow {
  readonly id: string;
  readonly coupon_id: string;
  readonly tenant_id: string;
  readonly obligation_id: string;
  readonly discount_amount_idr: number;
  readonly net_base_amount_idr: number;
  readonly status: CouponRedemptionStatus;
  readonly created_at: number;
  readonly updated_at: number;
}

const PROMO_COUPON_SELECT_COLUMNS = `
  id,
  code,
  discount_kind,
  discount_value,
  eligible_plans_json,
  eligible_payer_types_json,
  max_redemptions,
  redeemed_count,
  starts_at,
  ends_at,
  active,
  notes,
  created_by_user_id,
  version,
  created_at,
  updated_at
`.trim();

const COUPON_REDEMPTION_SELECT_COLUMNS = `
  id,
  coupon_id,
  tenant_id,
  obligation_id,
  discount_amount_idr,
  net_base_amount_idr,
  status,
  created_at,
  updated_at
`.trim();

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function parsePlansJson(raw: string): readonly BillingPlanInterval[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(
        (item): item is BillingPlanInterval => item === "monthly" || item === "yearly",
      );
      if (valid.length > 0) return valid;
    }
  } catch {
    // fallback below
  }
  return ["monthly", "yearly"];
}

function parsePayerTypesJson(raw: string | null): readonly CouponPayerType[] {
  if (!raw) return ["tenant", "agency"];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(
        (item): item is CouponPayerType => item === "tenant" || item === "agency",
      );
      if (valid.length > 0) return valid;
    }
  } catch {
    // fallback below
  }
  return ["tenant", "agency"];
}

function mapCouponRow(row: PromoCouponSqlRow): PromoCouponRecord {
  return {
    id: row.id,
    code: row.code,
    discountKind: row.discount_kind,
    discountValue: row.discount_value,
    eligiblePlans: parsePlansJson(row.eligible_plans_json),
    eligiblePayerTypes: parsePayerTypesJson(row.eligible_payer_types_json),
    maxRedemptions: row.max_redemptions,
    redeemedCount: row.redeemed_count,
    startsAtMs: row.starts_at,
    endsAtMs: row.ends_at,
    startsAtIso: new Date(row.starts_at).toISOString(),
    endsAtIso: new Date(row.ends_at).toISOString(),
    active: row.active === 1,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    version: row.version,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
    createdAtIso: new Date(row.created_at).toISOString(),
    updatedAtIso: new Date(row.updated_at).toISOString(),
  };
}

function mapRedemptionRow(row: CouponRedemptionSqlRow): CouponRedemptionRecord {
  return {
    id: row.id,
    couponId: row.coupon_id,
    tenantId: row.tenant_id,
    obligationId: row.obligation_id,
    discountAmountIdr: row.discount_amount_idr,
    netBaseAmountIdr: row.net_base_amount_idr,
    status: row.status,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
    createdAtIso: new Date(row.created_at).toISOString(),
    updatedAtIso: new Date(row.updated_at).toISOString(),
  };
}

export async function listPromoCoupons(
  db: D1Database,
  options: { readonly activeOnly?: boolean; readonly limit?: number } = {},
): Promise<readonly PromoCouponRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const whereSql = options.activeOnly ? "WHERE active = 1" : "";
  const rows = await db
    .prepare(
      `SELECT ${PROMO_COUPON_SELECT_COLUMNS}
       FROM promo_coupons
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<PromoCouponSqlRow>();

  return (rows.results ?? []).map(mapCouponRow);
}

export async function getPromoCouponById(
  db: D1Database,
  couponId: string,
): Promise<PromoCouponRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${PROMO_COUPON_SELECT_COLUMNS}
       FROM promo_coupons
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(couponId.trim())
    .first<PromoCouponSqlRow>();
  return row ? mapCouponRow(row) : null;
}

export async function getPromoCouponByCode(
  db: D1Database,
  rawCode: string,
): Promise<PromoCouponRecord | null> {
  const normalized = rawCode.trim().toUpperCase();
  if (!normalized) return null;
  const row = await db
    .prepare(
      `SELECT ${PROMO_COUPON_SELECT_COLUMNS}
       FROM promo_coupons
       WHERE code = ?
       LIMIT 1`,
    )
    .bind(normalized)
    .first<PromoCouponSqlRow>();
  return row ? mapCouponRow(row) : null;
}

export async function getCouponRedemptionByObligationId(
  db: D1Database,
  obligationId: string,
): Promise<CouponRedemptionRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${COUPON_REDEMPTION_SELECT_COLUMNS}
       FROM coupon_redemptions
       WHERE obligation_id = ?
       LIMIT 1`,
    )
    .bind(obligationId.trim())
    .first<CouponRedemptionSqlRow>();
  return row ? mapRedemptionRow(row) : null;
}

export async function hasCouponRedemptionsTable(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coupon_redemptions' LIMIT 1",
    )
    .first<{ readonly name: string }>();
  return Boolean(row);
}

export async function hasTenantRedeemedCoupon(
  db: D1Database,
  couponId: string,
  tenantId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
       FROM coupon_redemptions
       WHERE coupon_id = ?
         AND tenant_id = ?
         AND status IN ('reserved', 'consumed')
       LIMIT 1`,
    )
    .bind(couponId, tenantId)
    .first<{ readonly id: string }>();
  return Boolean(row);
}

/**
 * Console superadmin creation of a promotional coupon with atomic `platform_audit`
 * inside a single `D1Database.batch([...])` transaction.
 */
export async function createPromoCoupon(
  db: D1Database,
  params: {
    readonly input: ValidatedCreatePromoCouponInput;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly coupon: PromoCouponRecord; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(params.nowMs);
  const couponId = generateBillingUlid(nowMs);
  const { input } = params;

  const insertStmt = db
    .prepare(
      `INSERT INTO promo_coupons (
         id,
         code,
         discount_kind,
         discount_value,
         eligible_plans_json,
         eligible_payer_types_json,
         max_redemptions,
         redeemed_count,
         starts_at,
         ends_at,
         active,
         notes,
         created_by_user_id,
         version,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      couponId,
      input.code,
      input.discountKind,
      input.discountValue,
      JSON.stringify(input.eligiblePlans),
      JSON.stringify(input.eligiblePayerTypes),
      input.maxRedemptions,
      input.startsAtMs,
      input.endsAtMs,
      input.active ? 1 : 0,
      input.notes,
      params.actorUserId,
      nowMs,
      nowMs,
    );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "billing.coupon.created",
      targetType: "promo_coupon",
      targetId: couponId,
      reason: input.reason,
      requireReason: true,
      outcome: "success",
      requestId: params.requestId,
      metadata: {
        code: input.code,
        discountKind: input.discountKind,
        discountValue: input.discountValue,
        eligiblePlans: input.eligiblePlans,
        eligiblePayerTypes: input.eligiblePayerTypes,
        maxRedemptions: input.maxRedemptions,
        active: input.active,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  try {
    await db.batch([insertStmt, auditStmt]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new CouponRepositoryError(
        409,
        "COUPON_CODE_EXISTS",
        `Kode kupon "${input.code}" sudah terdaftar.`,
      );
    }
    throw err;
  }

  const created = await getPromoCouponById(db, couponId);
  if (!created) {
    throw new Error("COUPON_INSERT_READBACK_FAILED");
  }
  return { coupon: created, audit };
}

/**
 * Console superadmin update of a promotional coupon enforcing:
 * - Optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`)
 * - Never reducing `max_redemptions` below current `redeemed_count` (`422 INVALID_MAX_REDEMPTIONS_CAP`)
 * - Valid `ends_at > starts_at` window
 * - Atomic `platform_audit` insert guarded by `WHERE changes() = 1` inside single `batch()`.
 */
export async function updatePromoCoupon(
  db: D1Database,
  params: {
    readonly couponId: string;
    readonly input: ValidatedUpdatePromoCouponInput;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly coupon: PromoCouponRecord; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(params.nowMs);
  const existing = await getPromoCouponById(db, params.couponId);
  if (!existing) {
    throw new CouponRepositoryError(404, "NOT_FOUND", "Kupon promo tidak ditemukan.");
  }

  if (existing.version !== params.input.expectedVersion) {
    throw new CouponRepositoryError(
      409,
      "STALE_VERSION",
      `Versi kupon sudah berubah di server (diharapkan versi ${params.input.expectedVersion}, aktual versi ${existing.version}). Muat ulang sebelum menyimpan.`,
    );
  }

  const nextDiscountKind = params.input.discountKind ?? existing.discountKind;
  const nextDiscountValue = params.input.discountValue ?? existing.discountValue;
  const nextEligiblePlans = params.input.eligiblePlans ?? existing.eligiblePlans;
  const nextEligiblePayerTypes = params.input.eligiblePayerTypes ?? existing.eligiblePayerTypes;
  const nextMaxRedemptions =
    params.input.maxRedemptions !== undefined ? params.input.maxRedemptions : existing.maxRedemptions;
  const nextStartsAtMs = params.input.startsAtMs ?? existing.startsAtMs;
  const nextEndsAtMs = params.input.endsAtMs ?? existing.endsAtMs;
  const nextActive = params.input.active !== undefined ? params.input.active : existing.active;
  const nextNotes = params.input.notes !== undefined ? params.input.notes : existing.notes;

  if (nextEndsAtMs <= nextStartsAtMs) {
    throw new CouponRepositoryError(
      422,
      "INVALID_VALIDITY_WINDOW",
      "Tanggal berakhir kupon harus lebih besar dari tanggal mulai.",
    );
  }

  if (nextMaxRedemptions !== null && nextMaxRedemptions < existing.redeemedCount) {
    throw new CouponRepositoryError(
      422,
      "INVALID_MAX_REDEMPTIONS_CAP",
      `Batas penukaran (${nextMaxRedemptions}) tidak boleh lebih kecil dari jumlah yang sudah digunakan (${existing.redeemedCount}).`,
    );
  }

  const updateStmt = db
    .prepare(
      `UPDATE promo_coupons
       SET discount_kind = ?,
           discount_value = ?,
           eligible_plans_json = ?,
           eligible_payer_types_json = ?,
           max_redemptions = ?,
           starts_at = ?,
           ends_at = ?,
           active = ?,
           notes = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?
         AND (? IS NULL OR ? >= redeemed_count)`,
    )
    .bind(
      nextDiscountKind,
      nextDiscountValue,
      JSON.stringify(nextEligiblePlans),
      JSON.stringify(nextEligiblePayerTypes),
      nextMaxRedemptions,
      nextStartsAtMs,
      nextEndsAtMs,
      nextActive ? 1 : 0,
      nextNotes,
      nowMs,
      existing.id,
      params.input.expectedVersion,
      nextMaxRedemptions,
      nextMaxRedemptions,
    );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "billing.coupon.updated",
      targetType: "promo_coupon",
      targetId: existing.id,
      reason: params.input.reason,
      requireReason: true,
      outcome: "success",
      requestId: params.requestId,
      metadata: {
        code: existing.code,
        previousVersion: existing.version,
        nextVersion: existing.version + 1,
        active: nextActive,
        maxRedemptions: nextMaxRedemptions,
        discountKind: nextDiscountKind,
        discountValue: nextDiscountValue,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await db.batch([updateStmt, auditStmt]);
  const updatedChanges = results[0]?.meta?.changes ?? 0;

  if (updatedChanges !== 1) {
    const latest = await getPromoCouponById(db, existing.id);
    if (!latest) {
      throw new CouponRepositoryError(404, "NOT_FOUND", "Kupon promo tidak ditemukan.");
    }
    if (nextMaxRedemptions !== null && nextMaxRedemptions < latest.redeemedCount) {
      throw new CouponRepositoryError(
        422,
        "INVALID_MAX_REDEMPTIONS_CAP",
        `Batas penukaran (${nextMaxRedemptions}) tidak boleh lebih kecil dari jumlah yang sudah digunakan (${latest.redeemedCount}).`,
      );
    }
    throw new CouponRepositoryError(
      409,
      "STALE_VERSION",
      `Versi kupon berubah secara bersamaan di server (aktual versi ${latest.version}). Muat ulang sebelum menyimpan.`,
    );
  }

  const updated = await getPromoCouponById(db, existing.id);
  if (!updated) {
    throw new Error("COUPON_UPDATE_READBACK_FAILED");
  }
  return { coupon: updated, audit };
}

/**
 * Read-only owner/payer preview of a single coupon against a plan & tenant.
 */
export async function previewCouponForTenantCheckout(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly plan: BillingPlanInterval;
    readonly payerType?: CouponPayerType;
    readonly couponCode: string;
    readonly baseAmountIdr: number;
    readonly nowMs: number;
  },
): Promise<CouponEligibilityResult> {
  const normalizedCode = parseSingleCouponCodeInput(input.couponCode, { required: true })!;
  const coupon = await getPromoCouponByCode(db, normalizedCode);
  if (!coupon) {
    return evaluateCouponEligibility({
      coupon: null,
      plan: input.plan,
      payerType: input.payerType,
      baseAmountIdr: input.baseAmountIdr,
      nowMs: input.nowMs,
    });
  }

  const alreadyRedeemedByTenant = await hasTenantRedeemedCoupon(db, coupon.id, input.tenantId);
  return evaluateCouponEligibility({
    coupon,
    plan: input.plan,
    payerType: input.payerType,
    baseAmountIdr: input.baseAmountIdr,
    alreadyRedeemedByTenant,
    nowMs: input.nowMs,
  });
}

function throwEligibilityFailure(result: Extract<CouponEligibilityResult, { readonly ok: false }>): never {
  if (result.status === 409) {
    throw new BillingConflictError("CONFLICT", result.code, result.message);
  }
  throw new BillingValidationError(result.code, result.message, [
    { field: "couponCode", code: result.code, message: result.message },
  ]);
}

async function diagnoseAtomicReservationMiss(
  db: D1Database,
  couponId: string,
  plan: BillingPlanInterval,
  payerType: CouponPayerType,
  baseAmountIdr: number,
  nowMs: number,
): Promise<never> {
  const latest = await getPromoCouponById(db, couponId);
  const reeval = evaluateCouponEligibility({
    coupon: latest,
    plan,
    payerType,
    baseAmountIdr,
    nowMs,
  });
  if (!reeval.ok) {
    throwEligibilityFailure(reeval);
  }
  throw new BillingConflictError(
    "CONFLICT",
    "COUPON_EXHAUSTED",
    "Kuota penukaran kupon sudah habis atau status kupon berubah secara bersamaan.",
  );
}

/**
 * Atomic concurrent coupon reservation (`reserveCouponForCheckout`):
 * Single `platformDb.batch([...])` performing:
 * 1. Guarded increment:
 *    `UPDATE promo_coupons SET redeemed_count = redeemed_count + 1 ... WHERE id = ? AND active = 1 AND starts_at <= ? AND ends_at >= ? AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)`
 * 2. Immediately adjacent conditional insert:
 *    `INSERT INTO coupon_redemptions (...) SELECT ... WHERE changes() = 1`
 *
 * Guarantees under concurrent `Promise.all` checkouts:
 * - `redeemed_count` NEVER exceeds `max_redemptions`.
 * - A tenant can NEVER redeem the same coupon twice (`UNIQUE(coupon_id, tenant_id)` rolls back the entire batch!).
 */
export async function reserveCouponForCheckout(
  db: D1Database,
  input: {
    readonly couponCode: unknown;
    readonly tenantId: string;
    readonly obligationId: string;
    readonly plan: BillingPlanInterval;
    readonly payerType?: CouponPayerType;
    readonly baseAmountIdr: number;
    readonly nowMs: number;
  },
): Promise<{
  readonly coupon: PromoCouponRecord;
  readonly breakdown: CouponDiscountBreakdown;
  readonly redemption: CouponRedemptionRecord;
  readonly snapshot: CouponSnapshot;
}> {
  const nowMs = Math.trunc(input.nowMs);
  const payerType: CouponPayerType = input.payerType ?? "tenant";
  const normalizedCode = parseSingleCouponCodeInput(input.couponCode, { required: true })!;

  const coupon = await getPromoCouponByCode(db, normalizedCode);
  const precheck = evaluateCouponEligibility({
    coupon,
    plan: input.plan,
    payerType,
    baseAmountIdr: input.baseAmountIdr,
    nowMs,
  });
  if (!precheck.ok) {
    throwEligibilityFailure(precheck);
  }

  const redemptionId = generateBillingUlid(nowMs);
  const updateCouponStmt = db
    .prepare(
      `UPDATE promo_coupons
       SET redeemed_count = redeemed_count + 1,
           updated_at = ?
       WHERE id = ?
         AND active = 1
         AND starts_at <= ?
         AND ends_at >= ?
         AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)`,
    )
    .bind(nowMs, precheck.coupon.id, nowMs, nowMs);

  const insertRedemptionStmt = db
    .prepare(
      `INSERT INTO coupon_redemptions (
         id,
         coupon_id,
         tenant_id,
         obligation_id,
         discount_amount_idr,
         net_base_amount_idr,
         status,
         created_at,
         updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      redemptionId,
      precheck.coupon.id,
      input.tenantId,
      input.obligationId,
      precheck.breakdown.discountAmountIdr,
      precheck.breakdown.netBaseAmountIdr,
      nowMs,
      nowMs,
    );

  let results: D1Result[];
  try {
    results = await db.batch([updateCouponStmt, insertRedemptionStmt]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/obligation_id/i.test(msg)) {
        throw new BillingConflictError(
          "CONFLICT",
          "COUPON_OBLIGATION_ALREADY_RESERVED",
          "Tagihan ini sudah memiliki reservasi kupon.",
        );
      }
      throw new BillingConflictError(
        "CONFLICT",
        "COUPON_ALREADY_REDEEMED",
        `Kupon ${precheck.coupon.code} sudah pernah digunakan oleh situs ini (maksimal 1 kali per situs).`,
      );
    }
    throw err;
  }

  const incremented = results[0]?.meta?.changes ?? 0;
  const inserted = results[1]?.meta?.changes ?? 0;
  if (incremented !== 1 || inserted !== 1) {
    await diagnoseAtomicReservationMiss(
      db,
      precheck.coupon.id,
      input.plan,
      payerType,
      input.baseAmountIdr,
      nowMs,
    );
  }

  const [freshCoupon, redemption] = await Promise.all([
    getPromoCouponById(db, precheck.coupon.id),
    getCouponRedemptionByObligationId(db, input.obligationId),
  ]);
  if (!freshCoupon || !redemption) {
    throw new Error("COUPON_RESERVATION_READBACK_FAILED");
  }

  const snapshot = buildCouponSnapshot({
    coupon: freshCoupon,
    breakdown: precheck.breakdown,
    appliedAtMs: nowMs,
  });

  return {
    coupon: freshCoupon,
    breakdown: precheck.breakdown,
    redemption,
    snapshot,
  };
}

/**
 * Atomically releases a `'reserved'` coupon redemption (e.g. on obligation expiry/cancellation)
 * and decrements `promo_coupons.redeemed_count` guarded by `WHERE status = 'reserved'` + `changes() = 1`.
 * Safe and idempotent under concurrent calls.
 */
export async function releaseCouponReservation(
  db: D1Database,
  input: {
    readonly obligationId: string;
    readonly nowMs: number;
  },
): Promise<{
  readonly released: boolean;
  readonly couponId: string | null;
  readonly redemptionId: string | null;
}> {
  if (!(await hasCouponRedemptionsTable(db))) {
    return { released: false, couponId: null, redemptionId: null };
  }
  const nowMs = Math.trunc(input.nowMs);
  const existing = await getCouponRedemptionByObligationId(db, input.obligationId);
  if (!existing || existing.status !== "reserved") {
    return {
      released: false,
      couponId: existing?.couponId ?? null,
      redemptionId: existing?.id ?? null,
    };
  }

  const releaseStmt = db
    .prepare(
      `UPDATE coupon_redemptions
       SET status = 'released',
           updated_at = ?
       WHERE id = ?
         AND status = 'reserved'`,
    )
    .bind(nowMs, existing.id);

  const decrementStmt = db
    .prepare(
      `UPDATE promo_coupons
       SET redeemed_count = CASE WHEN redeemed_count > 0 THEN redeemed_count - 1 ELSE 0 END,
           updated_at = ?
       WHERE id = ?
         AND changes() = 1`,
    )
    .bind(nowMs, existing.couponId);

  const results = await db.batch([releaseStmt, decrementStmt]);
  const released = (results[0]?.meta?.changes ?? 0) === 1;

  return {
    released,
    couponId: existing.couponId,
    redemptionId: existing.id,
  };
}

/**
 * Marks a `'reserved'` coupon redemption as `'consumed'` upon authoritative settlement.
 * Tolerates pre-0010 test schemas where `coupon_redemptions` does not exist.
 */
export async function consumeCouponReservation(
  db: D1Database,
  input: {
    readonly obligationId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly consumed: boolean }> {
  if (!(await hasCouponRedemptionsTable(db))) {
    return { consumed: false };
  }
  const nowMs = Math.trunc(input.nowMs);
  const res = await db
    .prepare(
      `UPDATE coupon_redemptions
       SET status = 'consumed',
           updated_at = ?
       WHERE obligation_id = ?
         AND status = 'reserved'`,
    )
    .bind(nowMs, input.obligationId)
    .run();
  return { consumed: (res.meta?.changes ?? 0) === 1 };
}

export interface BeginDurableAttemptWithCouponInput extends BeginDurableAttemptInput {
  readonly couponCode: string;
}

function handleIdempotencyReplayOrConflict(
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
 * Atomic durable pre-call checkout with a single promotional coupon:
 * Combines `promo_coupons` cap increment + `coupon_redemptions` 1-per-tenant insert +
 * `billing_obligations` immutable discounted snapshot insert + `payment_attempts` (`creating`)
 * insert inside ONE atomic `D1Database.batch([...])` transaction before any AutoLaris HTTP call!
 */
export async function beginDurablePaymentAttemptWithCoupon(
  db: D1Database,
  input: BeginDurableAttemptWithCouponInput,
): Promise<BeginDurableAttemptResult & { readonly couponSnapshot: CouponSnapshot | null }> {
  const nowMs = Math.trunc(input.nowMs);
  const normalizedCode = parseSingleCouponCodeInput(input.couponCode, { required: true })!;

  // 1. Fast-path idempotency key lookup
  const existingKeyRow = await db
    .prepare(
      `SELECT id, obligation_id
       FROM payment_attempts
       WHERE tenant_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, input.idempotencyKey)
    .first<{ readonly id: string; readonly obligation_id: string }>();

  if (existingKeyRow) {
    const [existingAttempt, existingObl] = await Promise.all([
      getTenantPaymentAttemptById(db, input.tenantId, existingKeyRow.id),
      getTenantObligationById(db, input.tenantId, existingKeyRow.obligation_id),
    ]);
    if (!existingAttempt || !existingObl) {
      throw new BillingConflictError(
        "CONFLICT",
        "ORPHANED_PAYMENT_ATTEMPT",
        "Tagihan terkait Idempotency-Key tidak ditemukan.",
      );
    }
    const replay = handleIdempotencyReplayOrConflict(
      existingAttempt,
      existingObl.obligation,
      input.requestHash,
    );
    return { ...replay, couponSnapshot: null };
  }

  // 2. Load server pricing & tenant lifecycle context
  const [tenantCtx, pricing] = await Promise.all([
    loadTenantBillingContext(db, input.tenantId),
    loadPlatformBillingPricing(db),
  ]);
  if (!tenantCtx) {
    throw new BillingValidationError("TENANT_NOT_FOUND", "Tenant tidak ditemukan.");
  }

  if (
    tenantCtx.status === "purged" ||
    tenantCtx.offboardingStartedAtMs !== null ||
    input.effectiveTenantStatus === "purged"
  ) {
    throw new BillingConflictError(
      "CONFLICT",
      "TENANT_OFFBOARDING_IN_PROGRESS",
      "Situs sedang atau telah melalui proses penghapusan; percobaan pembayaran baru tidak diizinkan.",
    );
  }

  const baseAmountIdr = assertExactIdrInteger(
    input.plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr,
    "baseAmountIdr",
    { min: MIN_AUTOLARIS_CHARGE_IDR, max: MAX_IDR_AMOUNT },
  );
  const estimatedFeeIdr = assertExactIdrInteger(
    input.estimatedChannelFeeIdr,
    "estimatedChannelFeeIdr",
    { min: 0 },
  );

  // 3. Expire stale open obligations past due_at (atomically releasing reserved coupons),
  //    then check if tenant already has an active open subscription obligation
  await expireStaleOpenObligationsForTenant(db, input.tenantId, nowMs);
  const openOblRow = await db
    .prepare(
      `SELECT id, plan_interval, coupon_snapshot_json
       FROM billing_obligations
       WHERE tenant_id = ? AND status = 'open' AND plan_interval IN ('monthly', 'yearly')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<{
      readonly id: string;
      readonly plan_interval: string;
      readonly coupon_snapshot_json: string | null;
    }>();

  if (openOblRow) {
    const existingDetail = await getTenantObligationById(db, input.tenantId, openOblRow.id);
    if (!existingDetail) {
      throw new BillingConflictError("CONFLICT", "CONCURRENT_OBLIGATION_RACE", "Tagihan tidak ditemukan.");
    }
    const unresolved = await db
      .prepare(
        `SELECT id, lifecycle_state
         FROM payment_attempts
         WHERE tenant_id = ? AND obligation_id = ?
           AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
         LIMIT 1`,
      )
      .bind(input.tenantId, openOblRow.id)
      .first<{ readonly id: string; readonly lifecycle_state: string }>();

    if (unresolved) {
      const reasonCode =
        unresolved.lifecycle_state === "creation_unknown" || unresolved.lifecycle_state === "review"
          ? "RECONCILIATION_REQUIRED"
          : unresolved.lifecycle_state === "creating"
            ? "PAYMENT_CREATION_IN_PROGRESS"
            : "ACTIVE_ATTEMPT_EXISTS";
      throw new BillingConflictError(
        "CONFLICT",
        reasonCode,
        "Tagihan aktif sudah memiliki percobaan pembayaran yang belum selesai.",
      );
    }

    if (existingDetail.obligation.plan !== input.plan) {
      throw new BillingConflictError(
        "CONFLICT",
        "OPEN_OBLIGATION_PLAN_MISMATCH",
        `Tagihan terbuka saat ini memakai paket "${existingDetail.obligation.plan}"; selesaikan atau batalkan sebelum mengganti paket.`,
      );
    }

    let existingCouponSnap: CouponSnapshot | null = null;
    if (openOblRow.coupon_snapshot_json) {
      try {
        existingCouponSnap = JSON.parse(openOblRow.coupon_snapshot_json) as CouponSnapshot;
      } catch {
        existingCouponSnap = null;
      }
    }
    if (!existingCouponSnap || existingCouponSnap.code !== normalizedCode) {
      throw new BillingConflictError(
        "CONFLICT",
        "COUPON_CONFLICT_WITH_OPEN_OBLIGATION",
        "Tagihan terbuka sudah dikunci dengan ketentuan kupon berbeda; selesaikan atau batalkan tagihan terbuka terlebih dahulu.",
      );
    }

    // Retry on the SAME open obligation with the SAME already-reserved coupon
    // Guarded against concurrent retry UNIQUE collisions cleanly (returns replay or 409 CONFLICT, never 503).
    const retryAttemptId = generateBillingUlid(nowMs);
    const retryReffId = generateAutoLarisReffId(nowMs);
    const provisionalTotal = existingDetail.obligation.netAmountIdr + estimatedFeeIdr;
    try {
      const retryInsertRes = await db
        .prepare(
          `INSERT INTO payment_attempts (
             id, obligation_id, tenant_id, channel, provider, provider_account_id,
             provider_transaction_id, reff_id, channel_code, idempotency_key, request_hash,
             amount_idr, state, lifecycle_state, base_amount_idr, discount_amount_idr,
             channel_fee_idr, total_payable_idr, bank_name, safe_failure_code, expires_at,
             provider_payload_json, provider_submitted_at, version, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'initiated', 'creating', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM tenants
             WHERE id = ?
               AND status != 'purged'
               AND offboarding_started_at IS NULL
           )`,
        )
        .bind(
          retryAttemptId,
          existingDetail.obligation.id,
          input.tenantId,
          input.channelKind,
          AUTOLARIS_PROVIDER_ID,
          input.providerAccountId,
          retryReffId,
          input.channelCode,
          input.idempotencyKey,
          input.requestHash,
          provisionalTotal,
          existingDetail.obligation.baseAmountIdr,
          existingDetail.obligation.discountAmountIdr,
          estimatedFeeIdr,
          provisionalTotal,
          nowMs,
          nowMs,
          nowMs,
          input.tenantId,
        )
        .run();

      if ((retryInsertRes.meta?.changes ?? 0) === 0) {
        throw new BillingConflictError(
          "CONFLICT",
          "TENANT_OFFBOARDING_IN_PROGRESS",
          "Situs sedang atau telah melalui proses penghapusan; percobaan pembayaran baru tidak diizinkan.",
        );
      }
    } catch (err) {
      if (err instanceof BillingConflictError) throw err;
      if (!isUniqueConstraintError(err)) throw err;

      const racedByKey = await db
        .prepare(
          `SELECT id, obligation_id
           FROM payment_attempts
           WHERE tenant_id = ? AND idempotency_key = ?
           LIMIT 1`,
        )
        .bind(input.tenantId, input.idempotencyKey)
        .first<{ readonly id: string; readonly obligation_id: string }>();

      if (racedByKey) {
        const [att, obl] = await Promise.all([
          getTenantPaymentAttemptById(db, input.tenantId, racedByKey.id),
          getTenantObligationById(db, input.tenantId, racedByKey.obligation_id),
        ]);
        if (att && obl) {
          const replay = handleIdempotencyReplayOrConflict(att, obl.obligation, input.requestHash);
          return { ...replay, couponSnapshot: existingCouponSnap };
        }
      }

      const racedUnresolved = await db
        .prepare(
          `SELECT lifecycle_state
           FROM payment_attempts
           WHERE tenant_id = ? AND obligation_id = ?
             AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
           LIMIT 1`,
        )
        .bind(input.tenantId, existingDetail.obligation.id)
        .first<{ readonly lifecycle_state: string }>();

      const reasonCode =
        racedUnresolved?.lifecycle_state === "creation_unknown" ||
        racedUnresolved?.lifecycle_state === "review"
          ? "RECONCILIATION_REQUIRED"
          : racedUnresolved?.lifecycle_state === "creating"
            ? "PAYMENT_CREATION_IN_PROGRESS"
            : "ACTIVE_ATTEMPT_EXISTS";
      throw new BillingConflictError(
        "CONFLICT",
        reasonCode,
        "Tagihan sudah memiliki percobaan pembayaran aktif atau sedang diproses.",
      );
    }

    const createdAttempt = await getTenantPaymentAttemptById(db, input.tenantId, retryAttemptId);
    if (!createdAttempt) {
      throw new Error("ATTEMPT_INSERT_READBACK_FAILED");
    }
    return {
      mode: "created",
      obligation: existingDetail.obligation,
      attempt: createdAttempt,
      couponSnapshot: existingCouponSnap,
    };
  }

  // 4. Validate coupon eligibility & calculate exact integer IDR discount
  const coupon = await getPromoCouponByCode(db, normalizedCode);
  const precheck = evaluateCouponEligibility({
    coupon,
    plan: input.plan,
    payerType: input.payerType,
    baseAmountIdr,
    nowMs,
  });
  if (!precheck.ok) {
    throwEligibilityFailure(precheck);
  }

  const period = computeSubscriptionPeriodPreview({
    plan: input.plan,
    tenantStatus: input.effectiveTenantStatus,
    paidThroughMs: tenantCtx.paidThroughMs,
    trialEndsAtMs: tenantCtx.trialEndsAtMs,
    nowMs,
  });

  const baseSnapshot = buildImmutableObligationSnapshot({
    plan: input.plan,
    baseAmountIdr: precheck.breakdown.baseAmountIdr,
    discountAmountIdr: precheck.breakdown.discountAmountIdr,
    estimatedChannelFeeIdr: estimatedFeeIdr,
    pricingSource: pricing.source,
    period,
    createdAtMs: nowMs,
  });

  const couponSnapshot = buildCouponSnapshot({
    coupon: precheck.coupon,
    breakdown: precheck.breakdown,
    appliedAtMs: nowMs,
  });

  const extendedSnapshot = {
    ...baseSnapshot,
    coupon: couponSnapshot,
    affiliateCommissionableBaseIdr: precheck.breakdown.affiliateCommissionableBaseIdr,
  };

  const newObligationId = generateBillingUlid(nowMs);
  const redemptionId = generateBillingUlid(nowMs);
  const attemptId = generateBillingUlid(nowMs);
  const reffId = generateAutoLarisReffId(nowMs);
  const dueAtMs = nowMs + DEFAULT_OBLIGATION_TTL_MS;
  const provisionalTotalIdr = precheck.breakdown.netBaseAmountIdr + estimatedFeeIdr;

  // 5. SINGLE ATOMIC BATCH:
  //    (a) Increment promo_coupons.redeemed_count guarded by active + window + cap
  //    (b) Insert coupon_redemptions (UNIQUE(coupon_id, tenant_id)) WHERE changes() = 1
  //    (c) Insert billing_obligations WHERE changes() = 1
  //    (d) Insert payment_attempts ('creating') WHERE changes() = 1
  const stmtUpdateCoupon = db
    .prepare(
      `UPDATE promo_coupons
       SET redeemed_count = redeemed_count + 1,
           updated_at = ?
       WHERE id = ?
         AND active = 1
         AND starts_at <= ?
         AND ends_at >= ?
         AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
         AND EXISTS (
           SELECT 1 FROM tenants
           WHERE id = ?
             AND status != 'purged'
             AND offboarding_started_at IS NULL
         )`,
    )
    .bind(nowMs, precheck.coupon.id, nowMs, nowMs, input.tenantId);

  const stmtInsertRedemption = db
    .prepare(
      `INSERT INTO coupon_redemptions (
         id,
         coupon_id,
         tenant_id,
         obligation_id,
         discount_amount_idr,
         net_base_amount_idr,
         status,
         created_at,
         updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      redemptionId,
      precheck.coupon.id,
      input.tenantId,
      newObligationId,
      precheck.breakdown.discountAmountIdr,
      precheck.breakdown.netBaseAmountIdr,
      nowMs,
      nowMs,
    );

  const stmtInsertObligation = db
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
         coupon_id,
         coupon_snapshot_json,
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
       )
       SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      newObligationId,
      input.tenantId,
      input.payerType,
      input.payerAgencyId,
      input.plan,
      precheck.breakdown.baseAmountIdr,
      precheck.breakdown.discountAmountIdr,
      precheck.breakdown.netBaseAmountIdr,
      JSON.stringify(couponSnapshot),
      BILLING_CURRENCY,
      period.periodStartAtMs,
      period.periodEndAtMs,
      JSON.stringify(extendedSnapshot),
      input.idempotencyKey,
      input.requestHash,
      dueAtMs,
      nowMs,
      nowMs,
    );

  const stmtInsertAttempt = db
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
       )
       SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'initiated', 'creating', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      attemptId,
      newObligationId,
      input.tenantId,
      input.channelKind,
      AUTOLARIS_PROVIDER_ID,
      input.providerAccountId,
      reffId,
      input.channelCode,
      input.idempotencyKey,
      input.requestHash,
      provisionalTotalIdr,
      precheck.breakdown.baseAmountIdr,
      precheck.breakdown.discountAmountIdr,
      estimatedFeeIdr,
      provisionalTotalIdr,
      nowMs,
      nowMs,
      nowMs,
    );

  let results: D1Result[];
  try {
    results = await db.batch([
      stmtUpdateCoupon,
      stmtInsertRedemption,
      stmtInsertObligation,
      stmtInsertAttempt,
    ]);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    if (/coupon_redemptions/i.test(msg)) {
      throw new BillingConflictError(
        "CONFLICT",
        "COUPON_ALREADY_REDEEMED",
        `Kupon ${precheck.coupon.code} sudah pernah digunakan oleh situs ini (maksimal 1 kali per situs).`,
      );
    }

    // Re-check raced idempotency key or open obligation
    const racedKey = await db
      .prepare(
        `SELECT id, obligation_id
         FROM payment_attempts
         WHERE tenant_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .bind(input.tenantId, input.idempotencyKey)
      .first<{ readonly id: string; readonly obligation_id: string }>();

    if (racedKey) {
      const [att, obl] = await Promise.all([
        getTenantPaymentAttemptById(db, input.tenantId, racedKey.id),
        getTenantObligationById(db, input.tenantId, racedKey.obligation_id),
      ]);
      if (att && obl) {
        const replay = handleIdempotencyReplayOrConflict(att, obl.obligation, input.requestHash);
        return { ...replay, couponSnapshot: null };
      }
    }

    throw new BillingConflictError(
      "CONFLICT",
      "ACTIVE_ATTEMPT_EXISTS",
      "Tagihan aktif sudah memiliki percobaan pembayaran yang sedang diproses.",
    );
  }

  const couponChanges = results[0]?.meta?.changes ?? 0;
  const redemptionChanges = results[1]?.meta?.changes ?? 0;
  const obligationChanges = results[2]?.meta?.changes ?? 0;
  const attemptChanges = results[3]?.meta?.changes ?? 0;

  if (
    couponChanges !== 1 ||
    redemptionChanges !== 1 ||
    obligationChanges !== 1 ||
    attemptChanges !== 1
  ) {
    const latestTenant = await loadTenantBillingContext(db, input.tenantId);
    if (
      latestTenant &&
      (latestTenant.status === "purging" ||
        latestTenant.status === "purged" ||
        latestTenant.offboardingStartedAtMs !== null)
    ) {
      throw new BillingConflictError(
        "CONFLICT",
        "TENANT_OFFBOARDING_IN_PROGRESS",
        "Situs sedang atau telah melalui proses penghapusan; percobaan pembayaran baru tidak diizinkan.",
      );
    }
    await diagnoseAtomicReservationMiss(
      db,
      precheck.coupon.id,
      input.plan,
      input.payerType,
      baseAmountIdr,
      nowMs,
    );
  }

  const [createdObl, createdAttempt] = await Promise.all([
    getTenantObligationById(db, input.tenantId, newObligationId),
    getTenantPaymentAttemptById(db, input.tenantId, attemptId),
  ]);
  if (!createdObl || !createdAttempt) {
    throw new Error("COUPON_CHECKOUT_READBACK_FAILED");
  }

  return {
    mode: "created",
    obligation: createdObl.obligation,
    attempt: createdAttempt,
    couponSnapshot,
  };
}
