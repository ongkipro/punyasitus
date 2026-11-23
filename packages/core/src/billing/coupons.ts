import {
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
} from "./constants.ts";
import { BillingValidationError, type BillingErrorField } from "./errors.ts";
import { assertExactIdrInteger } from "./money.ts";
import {
  addCalendarMonthsUtc,
  getPlanMonths,
  type BillingPlanInterval,
} from "./period.ts";

/**
 * Pure domain math, validation, yearly savings, AutoLaris minimum payment floor,
 * anti-stacking, and affiliate net-base rules for Yearly Subscription Plans &
 * Promotional Coupons (REQ-082, PLAN §16.1, §17.1, §19.3, TASK-082).
 *
 * Invariants:
 * - Exact BigInt / safe-integer IDR arithmetic only (ZERO floating-point drift).
 * - Yearly plan grants exact 12 calendar months in UTC with month-end clamping
 *   (e.g. Jan 31 -> Jan 31 next year; leap-year Feb 29 -> Feb 28 non-leap).
 * - Yearly savings = max(0, 12 * monthlyBaseIdr - yearlyBaseIdr) (`Rp 358.000` at defaults).
 * - At most ONE coupon per checkout; array or delimiter-separated stacking is rejected
 *   with `422 COUPON_STACKING_FORBIDDEN`.
 * - Net base amount (`baseIdr - discountIdr`) MUST stay `>= AUTOLARIS_MIN_PAYMENT_IDR`
 *   (`Rp 10.000`); discounts driving net base below the gateway floor fail with
 *   `422 COUPON_BELOW_MIN_PAYMENT_FLOOR`.
 * - Affiliate commissionable base is strictly `netBaseAmountIdr = max(0, base - discount)`,
 *   explicitly AFTER coupon discount and EXCLUDING channel fee and PPN.
 */

export const AUTOLARIS_MIN_PAYMENT_IDR = MIN_AUTOLARIS_CHARGE_IDR; // 10_000 IDR
export const COUPON_DISCOUNT_KINDS = ["percent", "fixed_idr"] as const;
export type CouponDiscountKind = (typeof COUPON_DISCOUNT_KINDS)[number];

export const COUPON_ELIGIBLE_PLANS = ["monthly", "yearly"] as const;
export const COUPON_PAYER_TYPES = ["tenant", "agency"] as const;
export type CouponPayerType = (typeof COUPON_PAYER_TYPES)[number];

export const COUPON_REDEMPTION_STATUSES = ["reserved", "consumed", "released"] as const;
export type CouponRedemptionStatus = (typeof COUPON_REDEMPTION_STATUSES)[number];

export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
export const MAX_COUPON_NOTES_LENGTH = 500 as const;

const STACKING_DELIMITERS_RE = /[,;+|/\s]/;

export type CouponErrorReasonCode =
  | "INVALID_COUPON_CODE"
  | "COUPON_STACKING_FORBIDDEN"
  | "COUPON_NOT_FOUND"
  | "COUPON_INACTIVE"
  | "COUPON_NOT_STARTED"
  | "COUPON_EXPIRED"
  | "COUPON_EXHAUSTED"
  | "COUPON_PLAN_INELIGIBLE"
  | "COUPON_PAYER_INELIGIBLE"
  | "COUPON_ALREADY_REDEEMED"
  | "COUPON_BELOW_MIN_PAYMENT_FLOOR";

export interface PromoCouponRecord {
  readonly id: string;
  readonly code: string;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly eligiblePlans: readonly BillingPlanInterval[];
  readonly eligiblePayerTypes: readonly CouponPayerType[];
  readonly maxRedemptions: number | null;
  readonly redeemedCount: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
  readonly active: boolean;
  readonly notes: string | null;
  readonly createdByUserId: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface CouponRedemptionRecord {
  readonly id: string;
  readonly couponId: string;
  readonly tenantId: string;
  readonly obligationId: string;
  readonly discountAmountIdr: number;
  readonly netBaseAmountIdr: number;
  readonly status: CouponRedemptionStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface CouponDiscountBreakdown {
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netBaseAmountIdr: number;
  readonly affiliateCommissionableBaseIdr: number;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly minPaymentFloorIdr: number;
}

export interface CouponSnapshot {
  readonly couponId: string;
  readonly code: string;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netBaseAmountIdr: number;
  readonly affiliateCommissionableBaseIdr: number;
  readonly appliedAt: string;
}

export type CouponEligibilityResult =
  | {
      readonly ok: true;
      readonly coupon: PromoCouponRecord;
      readonly breakdown: CouponDiscountBreakdown;
    }
  | {
      readonly ok: false;
      readonly status: 409 | 422;
      readonly code: CouponErrorReasonCode;
      readonly message: string;
    };

export interface ValidatedCreatePromoCouponInput {
  readonly code: string;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly eligiblePlans: readonly BillingPlanInterval[];
  readonly eligiblePayerTypes: readonly CouponPayerType[];
  readonly maxRedemptions: number | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly active: boolean;
  readonly notes: string | null;
  readonly reason: string;
}

export interface ValidatedUpdatePromoCouponInput {
  readonly expectedVersion: number;
  readonly discountKind?: CouponDiscountKind;
  readonly discountValue?: number;
  readonly eligiblePlans?: readonly BillingPlanInterval[];
  readonly eligiblePayerTypes?: readonly CouponPayerType[];
  readonly maxRedemptions?: number | null;
  readonly startsAtMs?: number;
  readonly endsAtMs?: number;
  readonly active?: boolean;
  readonly notes?: string | null;
  readonly reason: string;
}

/**
 * Exact integer IDR yearly savings calculation: `max(0, 12 * monthlyBaseIdr - yearlyBaseIdr)`.
 * At canonical defaults (`Rp 179.000` monthly / `Rp 1.790.000` yearly) returns `358_000`.
 */
export function computeYearlySavingsIdr(
  monthlyBaseIdr: number = DEFAULT_MONTHLY_PRICE_IDR,
  yearlyBaseIdr: number = DEFAULT_YEARLY_PRICE_IDR,
): number {
  const safeMonthly = assertExactIdrInteger(monthlyBaseIdr, "monthlyBaseIdr", { min: 0 });
  const safeYearly = assertExactIdrInteger(yearlyBaseIdr, "yearlyBaseIdr", { min: 0 });
  const diff = BigInt(safeMonthly) * 12n - BigInt(safeYearly);
  return diff > 0n ? Number(diff) : 0;
}

/**
 * Computes exact UTC subscription period end with calendar-month clamping
 * (1 month for `monthly`, 12 calendar months for `yearly`).
 */
export function computePlanPeriodEndUtcMs(
  plan: BillingPlanInterval,
  anchorMs: number,
): {
  readonly plan: BillingPlanInterval;
  readonly months: 1 | 12;
  readonly periodStartAtMs: number;
  readonly periodEndAtMs: number;
  readonly periodStartAtIso: string;
  readonly periodEndAtIso: string;
} {
  const startMs = Math.trunc(anchorMs);
  const months = getPlanMonths(plan);
  const endMs = addCalendarMonthsUtc(startMs, months);
  return {
    plan,
    months,
    periodStartAtMs: startMs,
    periodEndAtMs: endMs,
    periodStartAtIso: new Date(startMs).toISOString(),
    periodEndAtIso: new Date(endMs).toISOString(),
  };
}

/**
 * Computes the affiliate commissionable net base in integer IDR (REQ-082, REQ-085):
 * strictly `max(0, baseAmountIdr - discountAmountIdr)` AFTER coupon discount and
 * explicitly EXCLUDING AutoLaris channel fees and PPN.
 */
export function computeAffiliateCommissionableBaseIdr(input: {
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
}): number {
  const base = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr", { min: 0 });
  const discount = assertExactIdrInteger(input.discountAmountIdr, "discountAmountIdr", { min: 0 });
  const net = BigInt(base) - BigInt(discount);
  return net > 0n ? Number(net) : 0;
}

/**
 * Computes rounded-down whole-rupiah affiliate commission from net base (REQ-085:
 * 60% first confirmed payment, 20% renewal, on net base after coupon discount).
 */
export function computeAffiliateCommissionIdr(input: {
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly ratePercent: number;
}): number {
  const netBase = computeAffiliateCommissionableBaseIdr({
    baseAmountIdr: input.baseAmountIdr,
    discountAmountIdr: input.discountAmountIdr,
  });
  const rate = assertExactIdrInteger(input.ratePercent, "ratePercent", { min: 0, max: 100 });
  return Number((BigInt(netBase) * BigInt(rate)) / 100n);
}

/**
 * Strictly validates and normalizes a single optional checkout coupon input.
 * Rejects arrays and delimiter-separated multi-code stacking with `422 COUPON_STACKING_FORBIDDEN`.
 */
export function parseSingleCouponCodeInput(
  raw: unknown,
  options: { readonly required?: boolean } = {},
): string | null {
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new BillingValidationError(
        "INVALID_COUPON_CODE",
        "Kode kupon wajib diisi.",
        [{ field: "couponCode", code: "INVALID_COUPON_CODE", message: "Coupon code is required." }],
      );
    }
    return null;
  }

  if (Array.isArray(raw)) {
    throw new BillingValidationError(
      "COUPON_STACKING_FORBIDDEN",
      "Hanya satu kode kupon yang dapat digunakan per transaksi; penumpukan kupon tidak diizinkan.",
      [
        {
          field: "couponCode",
          code: "COUPON_STACKING_FORBIDDEN",
          message: "Coupon stacking is forbidden; supply at most one coupon code string.",
        },
      ],
    );
  }

  if (typeof raw !== "string") {
    throw new BillingValidationError(
      "INVALID_COUPON_CODE",
      "Kode kupon harus berupa teks.",
      [{ field: "couponCode", code: "INVALID_COUPON_CODE", message: "Expected a string coupon code." }],
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (options.required) {
      throw new BillingValidationError(
        "INVALID_COUPON_CODE",
        "Kode kupon tidak boleh kosong.",
        [{ field: "couponCode", code: "INVALID_COUPON_CODE", message: "Coupon code cannot be empty." }],
      );
    }
    return null;
  }

  // Detect any attempt to stack multiple codes via commas, spaces, semicolons, pipes, or pluses
  if (STACKING_DELIMITERS_RE.test(trimmed)) {
    throw new BillingValidationError(
      "COUPON_STACKING_FORBIDDEN",
      "Hanya satu kode kupon yang dapat digunakan per transaksi; penumpukan beberapa kode kupon tidak diizinkan.",
      [
        {
          field: "couponCode",
          code: "COUPON_STACKING_FORBIDDEN",
          message: "Multiple or delimiter-separated coupon codes are not allowed.",
        },
      ],
    );
  }

  const normalized = trimmed.toUpperCase();
  if (!COUPON_CODE_PATTERN.test(normalized)) {
    throw new BillingValidationError(
      "INVALID_COUPON_CODE",
      "Format kode kupon tidak valid (gunakan 2–40 karakter huruf kapital, angka, '-' atau '_').",
      [
        {
          field: "couponCode",
          code: "INVALID_COUPON_CODE",
          message: "Coupon code must match /^[A-Z0-9][A-Z0-9_-]{1,39}$/.",
        },
      ],
    );
  }

  return normalized;
}

/**
 * Exact integer IDR discount calculation enforcing the AutoLaris minimum payment floor.
 * - `percent`: integer 1..100, exact BigInt floor `floor(base * value / 100)`.
 * - `fixed_idr`: positive integer IDR.
 * - Rejects with `422 COUPON_BELOW_MIN_PAYMENT_FLOOR` if `base - discount < minPaymentFloorIdr`.
 */
export function calculateCouponDiscount(input: {
  readonly baseAmountIdr: number;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly minPaymentFloorIdr?: number;
}): CouponDiscountBreakdown {
  const minFloor = assertExactIdrInteger(
    input.minPaymentFloorIdr ?? AUTOLARIS_MIN_PAYMENT_IDR,
    "minPaymentFloorIdr",
    { min: 1 },
  );
  const base = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr", { min: minFloor });

  let discountBig: bigint;
  if (input.discountKind === "percent") {
    const pct = assertExactIdrInteger(input.discountValue, "discountValue", { min: 1, max: 100 });
    discountBig = (BigInt(base) * BigInt(pct)) / 100n;
  } else if (input.discountKind === "fixed_idr") {
    const fixed = assertExactIdrInteger(input.discountValue, "discountValue", {
      min: 1,
      max: MAX_IDR_AMOUNT,
    });
    discountBig = BigInt(fixed);
  } else {
    throw new BillingValidationError(
      "INVALID_DISCOUNT_KIND",
      `Jenis diskon "${String(input.discountKind)}" tidak didukung.`,
      [{ field: "discountKind", code: "INVALID_DISCOUNT_KIND", message: 'Expected "percent" or "fixed_idr".' }],
    );
  }

  const netBig = BigInt(base) - discountBig;
  if (netBig < BigInt(minFloor)) {
    throw new BillingValidationError(
      "COUPON_BELOW_MIN_PAYMENT_FLOOR",
      `Diskon kupon menyebabkan subtotal tagihan di bawah batas minimum pembayaran AutoLaris (Rp ${String(minFloor).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}).`,
      [
        {
          field: "couponCode",
          code: "COUPON_BELOW_MIN_PAYMENT_FLOOR",
          message: `Net base amount after discount must be at least ${minFloor} IDR.`,
        },
      ],
    );
  }

  const discountAmountIdr = Number(discountBig);
  const netBaseAmountIdr = Number(netBig);
  const affiliateCommissionableBaseIdr = computeAffiliateCommissionableBaseIdr({
    baseAmountIdr: base,
    discountAmountIdr,
  });

  return {
    baseAmountIdr: base,
    discountAmountIdr,
    netBaseAmountIdr,
    affiliateCommissionableBaseIdr,
    discountKind: input.discountKind,
    discountValue: input.discountValue,
    minPaymentFloorIdr: minFloor,
  };
}

/**
 * Pure coupon eligibility evaluator enforcing active flag, validity window,
 * redemption cap, plan restriction, payer restriction, 1-per-tenant rule, and
 * AutoLaris minimum payment floor.
 */
export function evaluateCouponEligibility(input: {
  readonly coupon: PromoCouponRecord | null;
  readonly plan: BillingPlanInterval;
  readonly payerType?: CouponPayerType;
  readonly baseAmountIdr: number;
  readonly alreadyRedeemedByTenant?: boolean;
  readonly nowMs: number;
  readonly minPaymentFloorIdr?: number;
}): CouponEligibilityResult {
  const { coupon, plan, payerType = "tenant", baseAmountIdr, nowMs } = input;

  if (!coupon) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_NOT_FOUND",
      message: "Kode kupon tidak ditemukan.",
    };
  }

  if (!coupon.active) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_INACTIVE",
      message: `Kupon ${coupon.code} sedang tidak aktif.`,
    };
  }

  const now = Math.trunc(nowMs);
  if (now < coupon.startsAtMs) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_NOT_STARTED",
      message: `Kupon ${coupon.code} belum memasuki masa berlaku.`,
    };
  }

  if (now > coupon.endsAtMs) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_EXPIRED",
      message: `Masa berlaku kupon ${coupon.code} telah berakhir.`,
    };
  }

  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_EXHAUSTED",
      message: `Kuota penukaran kupon ${coupon.code} sudah habis.`,
    };
  }

  if (!coupon.eligiblePlans.includes(plan)) {
    const planLabel = plan === "yearly" ? "Tahunan" : "Bulanan";
    return {
      ok: false,
      status: 422,
      code: "COUPON_PLAN_INELIGIBLE",
      message: `Kupon ${coupon.code} tidak berlaku untuk paket ${planLabel}.`,
    };
  }

  if (!coupon.eligiblePayerTypes.includes(payerType)) {
    return {
      ok: false,
      status: 422,
      code: "COUPON_PAYER_INELIGIBLE",
      message: `Kupon ${coupon.code} tidak berlaku untuk jenis pembayar ini.`,
    };
  }

  if (input.alreadyRedeemedByTenant) {
    return {
      ok: false,
      status: 409,
      code: "COUPON_ALREADY_REDEEMED",
      message: `Kupon ${coupon.code} sudah pernah digunakan oleh situs ini (maksimal 1 kali per situs).`,
    };
  }

  try {
    const breakdown = calculateCouponDiscount({
      baseAmountIdr,
      discountKind: coupon.discountKind,
      discountValue: coupon.discountValue,
      minPaymentFloorIdr: input.minPaymentFloorIdr,
    });
    return { ok: true, coupon, breakdown };
  } catch (err) {
    if (err instanceof BillingValidationError && err.reasonCode === "COUPON_BELOW_MIN_PAYMENT_FLOOR") {
      return {
        ok: false,
        status: 422,
        code: "COUPON_BELOW_MIN_PAYMENT_FLOOR",
        message: err.message,
      };
    }
    throw err;
  }
}

export function buildCouponSnapshot(input: {
  readonly coupon: PromoCouponRecord;
  readonly breakdown: CouponDiscountBreakdown;
  readonly appliedAtMs: number;
}): CouponSnapshot {
  return {
    couponId: input.coupon.id,
    code: input.coupon.code,
    discountKind: input.coupon.discountKind,
    discountValue: input.coupon.discountValue,
    baseAmountIdr: input.breakdown.baseAmountIdr,
    discountAmountIdr: input.breakdown.discountAmountIdr,
    netBaseAmountIdr: input.breakdown.netBaseAmountIdr,
    affiliateCommissionableBaseIdr: input.breakdown.affiliateCommissionableBaseIdr,
    appliedAt: new Date(Math.trunc(input.appliedAtMs)).toISOString(),
  };
}

function parseTimestampField(raw: unknown, fieldName: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  throw new BillingValidationError(
    "INVALID_TIMESTAMP",
    `Field "${fieldName}" harus berupa timestamp epoch ms atau tanggal ISO-8601 yang valid.`,
    [{ field: fieldName, code: "INVALID_TIMESTAMP", message: "Expected valid epoch ms or ISO-8601 timestamp." }],
  );
}

function parseEligiblePlans(raw: unknown): readonly BillingPlanInterval[] {
  if (raw === undefined) {
    return ["monthly", "yearly"];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BillingValidationError(
      "INVALID_ELIGIBLE_PLANS",
      'Field "eligiblePlans" harus berisi minimal satu paket ("monthly" atau "yearly").',
      [{ field: "eligiblePlans", code: "INVALID_ELIGIBLE_PLANS", message: "Expected non-empty plan list." }],
    );
  }
  const unique = new Set<BillingPlanInterval>();
  for (const entry of raw) {
    if (entry !== "monthly" && entry !== "yearly") {
      throw new BillingValidationError(
        "INVALID_ELIGIBLE_PLANS",
        `Paket "${String(entry)}" tidak valid pada eligiblePlans.`,
        [{ field: "eligiblePlans", code: "INVALID_ELIGIBLE_PLANS", message: 'Allowed values: "monthly", "yearly".' }],
      );
    }
    unique.add(entry);
  }
  return Array.from(unique);
}

function parseEligiblePayerTypes(raw: unknown): readonly CouponPayerType[] {
  if (raw === undefined) {
    return ["tenant", "agency"];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BillingValidationError(
      "INVALID_ELIGIBLE_PAYER_TYPES",
      'Field "eligiblePayerTypes" harus berisi minimal satu jenis pembayar ("tenant" atau "agency").',
      [
        {
          field: "eligiblePayerTypes",
          code: "INVALID_ELIGIBLE_PAYER_TYPES",
          message: "Expected non-empty payer type list.",
        },
      ],
    );
  }
  const unique = new Set<CouponPayerType>();
  for (const entry of raw) {
    if (entry !== "tenant" && entry !== "agency") {
      throw new BillingValidationError(
        "INVALID_ELIGIBLE_PAYER_TYPES",
        `Jenis pembayar "${String(entry)}" tidak valid.`,
        [
          {
            field: "eligiblePayerTypes",
            code: "INVALID_ELIGIBLE_PAYER_TYPES",
            message: 'Allowed values: "tenant", "agency".',
          },
        ],
      );
    }
    unique.add(entry);
  }
  return Array.from(unique);
}

function parseDiscountKindAndValue(
  discountKind: unknown,
  discountValue: unknown,
): { readonly discountKind: CouponDiscountKind; readonly discountValue: number } {
  if (discountKind !== "percent" && discountKind !== "fixed_idr") {
    throw new BillingValidationError(
      "INVALID_DISCOUNT_KIND",
      'Field "discountKind" harus "percent" atau "fixed_idr".',
      [{ field: "discountKind", code: "INVALID_DISCOUNT_KIND", message: 'Expected "percent" or "fixed_idr".' }],
    );
  }
  const maxVal = discountKind === "percent" ? 100 : MAX_IDR_AMOUNT;
  const safeVal = assertExactIdrInteger(discountValue, "discountValue", { min: 1, max: maxVal });
  return { discountKind, discountValue: safeVal };
}

function parseMaxRedemptions(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 1_000_000) {
    throw new BillingValidationError(
      "INVALID_MAX_REDEMPTIONS",
      'Field "maxRedemptions" harus berupa bilangan bulat positif atau null (tanpa batas).',
      [
        {
          field: "maxRedemptions",
          code: "INVALID_MAX_REDEMPTIONS",
          message: "Expected null or positive integer (1..1000000).",
        },
      ],
    );
  }
  return raw;
}

function parseOptionalNotes(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new BillingValidationError(
      "INVALID_NOTES",
      'Field "notes" harus berupa teks.',
      [{ field: "notes", code: "INVALID_NOTES", message: "Expected string or null." }],
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_COUPON_NOTES_LENGTH) {
    throw new BillingValidationError(
      "NOTES_TOO_LONG",
      `Catatan kupon maksimal ${MAX_COUPON_NOTES_LENGTH} karakter.`,
      [{ field: "notes", code: "NOTES_TOO_LONG", message: `Max length is ${MAX_COUPON_NOTES_LENGTH}.` }],
    );
  }
  return trimmed;
}

function parseAuditReasonField(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length < 10 || raw.trim().length > 500) {
    throw new BillingValidationError(
      "INVALID_AUDIT_REASON",
      "Alasan audit operator wajib diisi (10–500 karakter).",
      [
        {
          field: "reason",
          code: "INVALID_AUDIT_REASON",
          message: "Audit reason must be 10-500 characters.",
        },
      ],
    );
  }
  return raw.trim();
}

export function validateCreatePromoCouponInput(
  body: Readonly<Record<string, unknown>>,
): ValidatedCreatePromoCouponInput {
  const code = parseSingleCouponCodeInput(body.code, { required: true })!;
  const { discountKind, discountValue } = parseDiscountKindAndValue(
    body.discountKind,
    body.discountValue,
  );
  const eligiblePlans = parseEligiblePlans(body.eligiblePlans);
  const eligiblePayerTypes = parseEligiblePayerTypes(body.eligiblePayerTypes);
  const maxRedemptions = parseMaxRedemptions(body.maxRedemptions);
  const startsAtMs = parseTimestampField(body.startsAt, "startsAt");
  const endsAtMs = parseTimestampField(body.endsAt, "endsAt");

  if (endsAtMs <= startsAtMs) {
    const fields: BillingErrorField[] = [
      {
        field: "endsAt",
        code: "INVALID_VALIDITY_WINDOW",
        message: "endsAt must be strictly greater than startsAt.",
      },
    ];
    throw new BillingValidationError(
      "INVALID_VALIDITY_WINDOW",
      "Tanggal berakhir kupon harus lebih besar dari tanggal mulai.",
      fields,
    );
  }

  const active = body.active === undefined ? true : Boolean(body.active);
  if (body.active !== undefined && typeof body.active !== "boolean") {
    throw new BillingValidationError(
      "INVALID_ACTIVE_FLAG",
      'Field "active" harus berupa boolean.',
      [{ field: "active", code: "INVALID_ACTIVE_FLAG", message: "Expected boolean." }],
    );
  }

  const notes = parseOptionalNotes(body.notes);
  const reason = parseAuditReasonField(body.reason);

  return {
    code,
    discountKind,
    discountValue,
    eligiblePlans,
    eligiblePayerTypes,
    maxRedemptions,
    startsAtMs,
    endsAtMs,
    active,
    notes,
    reason,
  };
}

export function validateUpdatePromoCouponInput(
  body: Readonly<Record<string, unknown>>,
): ValidatedUpdatePromoCouponInput {
  const expectedVersion = body.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw new BillingValidationError(
      "INVALID_EXPECTED_VERSION",
      'Field "expectedVersion" wajib berupa bilangan bulat positif.',
      [
        {
          field: "expectedVersion",
          code: "INVALID_EXPECTED_VERSION",
          message: "expectedVersion must be a positive integer for optimistic concurrency.",
        },
      ],
    );
  }

  const reason = parseAuditReasonField(body.reason);
  const result: {
    expectedVersion: number;
    discountKind?: CouponDiscountKind;
    discountValue?: number;
    eligiblePlans?: readonly BillingPlanInterval[];
    eligiblePayerTypes?: readonly CouponPayerType[];
    maxRedemptions?: number | null;
    startsAtMs?: number;
    endsAtMs?: number;
    active?: boolean;
    notes?: string | null;
    reason: string;
  } = { expectedVersion, reason };

  if (body.discountKind !== undefined || body.discountValue !== undefined) {
    if (body.discountKind === undefined || body.discountValue === undefined) {
      throw new BillingValidationError(
        "INCOMPLETE_DISCOUNT_UPDATE",
        "Perubahan diskon harus menyertakan discountKind dan discountValue secara bersamaan.",
        [
          {
            field: "discountValue",
            code: "INCOMPLETE_DISCOUNT_UPDATE",
            message: "Both discountKind and discountValue are required when changing discount.",
          },
        ],
      );
    }
    const parsed = parseDiscountKindAndValue(body.discountKind, body.discountValue);
    result.discountKind = parsed.discountKind;
    result.discountValue = parsed.discountValue;
  }

  if (body.eligiblePlans !== undefined) {
    result.eligiblePlans = parseEligiblePlans(body.eligiblePlans);
  }
  if (body.eligiblePayerTypes !== undefined) {
    result.eligiblePayerTypes = parseEligiblePayerTypes(body.eligiblePayerTypes);
  }
  if (body.maxRedemptions !== undefined) {
    result.maxRedemptions = parseMaxRedemptions(body.maxRedemptions);
  }
  if (body.startsAt !== undefined) {
    result.startsAtMs = parseTimestampField(body.startsAt, "startsAt");
  }
  if (body.endsAt !== undefined) {
    result.endsAtMs = parseTimestampField(body.endsAt, "endsAt");
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      throw new BillingValidationError(
        "INVALID_ACTIVE_FLAG",
        'Field "active" harus berupa boolean.',
        [{ field: "active", code: "INVALID_ACTIVE_FLAG", message: "Expected boolean." }],
      );
    }
    result.active = body.active;
  }
  if (body.notes !== undefined) {
    result.notes = parseOptionalNotes(body.notes);
  }

  const hasMutation =
    result.discountKind !== undefined ||
    result.eligiblePlans !== undefined ||
    result.eligiblePayerTypes !== undefined ||
    result.maxRedemptions !== undefined ||
    result.startsAtMs !== undefined ||
    result.endsAtMs !== undefined ||
    result.active !== undefined ||
    result.notes !== undefined;

  if (!hasMutation) {
    throw new BillingValidationError(
      "EMPTY_COUPON_UPDATE",
      "Minimal satu field kupon harus diubah.",
      [{ field: "body", code: "EMPTY_COUPON_UPDATE", message: "No mutable coupon fields provided." }],
    );
  }

  if (
    result.startsAtMs !== undefined &&
    result.endsAtMs !== undefined &&
    result.endsAtMs <= result.startsAtMs
  ) {
    throw new BillingValidationError(
      "INVALID_VALIDITY_WINDOW",
      "Tanggal berakhir kupon harus lebih besar dari tanggal mulai.",
      [
        {
          field: "endsAt",
          code: "INVALID_VALIDITY_WINDOW",
          message: "endsAt must be strictly greater than startsAt.",
        },
      ],
    );
  }

  return result;
}
