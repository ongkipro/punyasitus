/**
 * Pure integer IDR Affiliate Commission Math, 14-Day Hold & Bi-Monthly Asia/Jakarta
 * Payout Schedule Engine (`packages/core/src/affiliates/commission.ts`;
 * REQ-085, REQ-086, DEC-038, DEC-045, PLAN §19.4, TASK-085).
 *
 * Financial & Determinism Invariants:
 * - ZERO floating-point drift: all IDR and basis-point calculations use strict safe
 *   integers and exact `BigInt` floor division (`(netBase * rateBps) / 10_000n`).
 * - Net commissionable base strictly excludes coupons/discounts, PPN, and AutoLaris
 *   payment channel fees (`max(0, gross - discount - ppn - channelFee)`).
 * - Default rates (`6000` bps = `60%` first payment, `2000` bps = `20%` renewals),
 *   hold period (`14` days, DEC-045), and minimum payout threshold (`Rp 100.000`, DEC-045)
 *   are read/snapshotted from `platform_settings` with strict bounds validation.
 * - Bi-monthly payout dates evaluate strictly in `Asia/Jakarta` (WIB, fixed UTC+7, no DST):
 *   15th and 30th of each month, and the last day of February (28th non-leap, 29th leap).
 */

export const AFFILIATE_COMMISSION_SETTINGS_KEY = "affiliate.commission_rates" as const;

export const AFFILIATE_COMMISSION_BPS_DENOMINATOR = 10_000 as const;
export const AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS = 6000 as const; // 60%
export const AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS = 2000 as const; // 20%
export const AFFILIATE_COMMISSION_HOLD_DAYS = 14 as const; // DEC-045
export const AFFILIATE_COMMISSION_DAY_MS = 86_400_000 as const;
export const AFFILIATE_COMMISSION_HOLD_MS =
  AFFILIATE_COMMISSION_HOLD_DAYS * AFFILIATE_COMMISSION_DAY_MS; // 1,209,600,000 ms
export const AFFILIATE_PAYOUT_MINIMUM_IDR = 100_000 as const; // Rp 100.000 (DEC-045)
export const AFFILIATE_PAYOUT_TIMEZONE = "Asia/Jakarta" as const;
export const AFFILIATE_WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Fixed UTC+7 (Indonesia has no DST)
export const AFFILIATE_MAX_IDR_AMOUNT = 999_999_999_999 as const;

export const AFFILIATE_COMMISSION_ENTRY_KINDS = [
  "first_payment",
  "renewal",
  "reversal_offset",
] as const;
export type AffiliateCommissionEntryKind = (typeof AFFILIATE_COMMISSION_ENTRY_KINDS)[number];

export const AFFILIATE_COMMISSION_STATUSES = [
  "pending",
  "approved",
  "batched",
  "paid",
  "reversed",
] as const;
export type AffiliateCommissionStatus = (typeof AFFILIATE_COMMISSION_STATUSES)[number];

export const AFFILIATE_PAYOUT_BATCH_STATUSES = [
  "pending_review",
  "paid",
  "canceled",
] as const;
export type AffiliatePayoutBatchStatus = (typeof AFFILIATE_PAYOUT_BATCH_STATUSES)[number];

export class AffiliateCommissionMathError extends RangeError {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "AffiliateCommissionMathError";
    this.code = code;
    this.field = field;
  }
}

export interface AffiliateCommissionRatesSnapshot {
  readonly firstPaymentRateBps: number;
  readonly renewalRateBps: number;
  readonly holdDays: number;
  readonly minimumPayoutIdr: number;
  readonly source: "platform_settings" | "default";
}

export const DEFAULT_AFFILIATE_COMMISSION_RATES_SNAPSHOT: AffiliateCommissionRatesSnapshot = {
  firstPaymentRateBps: AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS,
  renewalRateBps: AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS,
  holdDays: AFFILIATE_COMMISSION_HOLD_DAYS,
  minimumPayoutIdr: AFFILIATE_PAYOUT_MINIMUM_IDR,
  source: "default",
} as const;

export interface CommissionableBaseInput {
  readonly grossAmountIdr: number;
  readonly discountAmountIdr?: number;
  readonly ppnAmountIdr?: number;
  readonly channelFeeIdr?: number;
}

export interface CalculateCommissionInput extends CommissionableBaseInput {
  readonly isFirstPayment: boolean;
  readonly rates?: Pick<
    AffiliateCommissionRatesSnapshot,
    "firstPaymentRateBps" | "renewalRateBps"
  >;
}

export interface CalculatedCommissionBreakdown {
  readonly entryKind: "first_payment" | "renewal";
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly ppnAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly netBaseIdr: number;
  readonly rateBps: number;
  readonly commissionIdr: number;
}

export interface WibCalendarDate {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly dateKey: string; // YYYY-MM-DD
}

/**
 * Validates that a numeric value is a finite safe integer within `[min, max]`.
 */
export function assertExactCommissionInteger(
  value: unknown,
  field: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): number {
  const min = bounds.min ?? 0;
  const max = bounds.max ?? AFFILIATE_MAX_IDR_AMOUNT;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AffiliateCommissionMathError(
      "INVALID_INTEGER",
      `${field} harus berupa bilangan bulat aman (integer IDR/bps).`,
      field,
    );
  }
  if (value < min || value > max) {
    throw new AffiliateCommissionMathError(
      "INTEGER_OUT_OF_RANGE",
      `${field} harus berada di antara ${min} dan ${max}.`,
      field,
    );
  }
  return value;
}

/**
 * Computes exact integer net commissionable IDR base excluding coupons/discounts,
 * PPN, and AutoLaris payment channel fees, clamped to `>= 0`.
 */
export function calculateNetCommissionableBaseIdr(input: CommissionableBaseInput): number {
  const gross = assertExactCommissionInteger(input.grossAmountIdr, "grossAmountIdr", {
    min: 0,
    max: AFFILIATE_MAX_IDR_AMOUNT,
  });
  const discount = assertExactCommissionInteger(
    input.discountAmountIdr ?? 0,
    "discountAmountIdr",
    { min: 0, max: AFFILIATE_MAX_IDR_AMOUNT },
  );
  const ppn = assertExactCommissionInteger(input.ppnAmountIdr ?? 0, "ppnAmountIdr", {
    min: 0,
    max: AFFILIATE_MAX_IDR_AMOUNT,
  });
  const channelFee = assertExactCommissionInteger(input.channelFeeIdr ?? 0, "channelFeeIdr", {
    min: 0,
    max: AFFILIATE_MAX_IDR_AMOUNT,
  });

  const netBig = BigInt(gross) - BigInt(discount) - BigInt(ppn) - BigInt(channelFee);
  if (netBig <= 0n) {
    return 0;
  }
  return Number(netBig);
}

/**
 * Computes exact whole-rupiah affiliate commission using `BigInt` integer floor division:
 * `floor((netBaseIdr * rateBps) / 10_000)`.
 *
 * Uses `BigInt` internally to prevent 53-bit overflow on large IDR amounts while
 * guaranteeing zero floating-point drift.
 */
export function calculateCommissionIdrFromNetBase(netBaseIdr: number, rateBps: number): number {
  const validNetBase = assertExactCommissionInteger(netBaseIdr, "netBaseIdr", {
    min: 0,
    max: AFFILIATE_MAX_IDR_AMOUNT,
  });
  const validRateBps = assertExactCommissionInteger(rateBps, "rateBps", {
    min: 0,
    max: AFFILIATE_COMMISSION_BPS_DENOMINATOR,
  });

  if (validNetBase === 0 || validRateBps === 0) {
    return 0;
  }

  const exactCommission =
    (BigInt(validNetBase) * BigInt(validRateBps)) / BigInt(AFFILIATE_COMMISSION_BPS_DENOMINATOR);
  return Number(exactCommission);
}

/**
 * Computes the complete integer IDR commission breakdown for a confirmed payment.
 */
export function calculateAffiliateCommission(
  input: CalculateCommissionInput,
): CalculatedCommissionBreakdown {
  const grossAmountIdr = assertExactCommissionInteger(input.grossAmountIdr, "grossAmountIdr");
  const discountAmountIdr = assertExactCommissionInteger(
    input.discountAmountIdr ?? 0,
    "discountAmountIdr",
  );
  const ppnAmountIdr = assertExactCommissionInteger(input.ppnAmountIdr ?? 0, "ppnAmountIdr");
  const channelFeeIdr = assertExactCommissionInteger(input.channelFeeIdr ?? 0, "channelFeeIdr");

  const netBaseIdr = calculateNetCommissionableBaseIdr({
    grossAmountIdr,
    discountAmountIdr,
    ppnAmountIdr,
    channelFeeIdr,
  });

  const firstRateBps = assertExactCommissionInteger(
    input.rates?.firstPaymentRateBps ?? AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS,
    "firstPaymentRateBps",
    { min: 0, max: AFFILIATE_COMMISSION_BPS_DENOMINATOR },
  );
  const renewalRateBps = assertExactCommissionInteger(
    input.rates?.renewalRateBps ?? AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS,
    "renewalRateBps",
    { min: 0, max: AFFILIATE_COMMISSION_BPS_DENOMINATOR },
  );

  const entryKind: "first_payment" | "renewal" = input.isFirstPayment
    ? "first_payment"
    : "renewal";
  const rateBps = input.isFirstPayment ? firstRateBps : renewalRateBps;
  const commissionIdr = calculateCommissionIdrFromNetBase(netBaseIdr, rateBps);

  return {
    entryKind,
    grossAmountIdr,
    discountAmountIdr,
    ppnAmountIdr,
    channelFeeIdr,
    netBaseIdr,
    rateBps,
    commissionIdr,
  };
}

/**
 * Computes the exact `hold_until_at` epoch ms (`confirmedAtMs + holdDays * 86_400_000`).
 */
export function computeCommissionHoldUntilMs(
  confirmedAtMs: number,
  holdDays: number = AFFILIATE_COMMISSION_HOLD_DAYS,
): number {
  const validConfirmed = assertExactCommissionInteger(confirmedAtMs, "confirmedAtMs", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const validHoldDays = assertExactCommissionInteger(holdDays, "holdDays", {
    min: 0,
    max: 365,
  });
  return validConfirmed + validHoldDays * AFFILIATE_COMMISSION_DAY_MS;
}

/**
 * Returns `true` strictly when `nowMs >= holdUntilAtMs` (14d 00h 00m boundary).
 */
export function isCommissionHoldMatured(holdUntilAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(holdUntilAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return Math.trunc(nowMs) >= Math.trunc(holdUntilAtMs);
}

/**
 * Returns the number of calendar days in a given Gregorian `year` and 1-indexed `month`.
 */
export function getDaysInCalendarMonth(year: number, month: number): number {
  const validYear = assertExactCommissionInteger(year, "year", { min: 1970, max: 9999 });
  const validMonth = assertExactCommissionInteger(month, "month", { min: 1, max: 12 });
  return new Date(Date.UTC(validYear, validMonth, 0)).getUTCDate();
}

/**
 * Converts a UTC epoch ms timestamp into its exact `Asia/Jakarta` (WIB, UTC+7) calendar date.
 */
export function getWibCalendarDate(epochMs: number): WibCalendarDate {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    throw new AffiliateCommissionMathError(
      "INVALID_TIMESTAMP",
      "Timestamp harus berupa angka epoch milidetik yang valid.",
      "epochMs",
    );
  }
  const wib = new Date(Math.trunc(epochMs) + AFFILIATE_WIB_OFFSET_MS);
  const year = wib.getUTCFullYear();
  const month = wib.getUTCMonth() + 1;
  const day = wib.getUTCDate();
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    year,
    month,
    day,
    dateKey: `${year}-${mm}-${dd}`,
  };
}

/**
 * Returns the bi-monthly `Asia/Jakarta` payout period key (`YYYY-MM-DD`) when `nowMs`
 * falls on a scheduled payout batch date:
 * - **15th** of every month in `Asia/Jakarta`, OR
 * - **30th** of every 30/31-day month in `Asia/Jakarta`, OR
 * - **Last day of February** (`28th` in non-leap years, `29th` in leap years) in `Asia/Jakarta`.
 *
 * Returns `null` on all other WIB calendar dates.
 */
export function resolveAffiliatePayoutPeriodKey(nowMs: number): string | null {
  const wib = getWibCalendarDate(nowMs);
  const daysInMonth = getDaysInCalendarMonth(wib.year, wib.month);
  const secondPayoutDay = Math.min(30, daysInMonth);
  if (wib.day === 15 || wib.day === secondPayoutDay) {
    return wib.dateKey;
  }
  return null;
}

/**
 * Returns `true` iff `nowMs` falls on a bi-monthly `Asia/Jakarta` payout batch date.
 */
export function isAffiliatePayoutBatchDate(nowMs: number): boolean {
  return resolveAffiliatePayoutPeriodKey(nowMs) !== null;
}

/**
 * Evaluates whether an affiliate's net available approved balance (after netting negative
 * `reversal_offset` entries) meets the payout minimum threshold (`Rp 100.000` by default).
 */
export function isBalanceEligibleForPayout(
  netAvailableApprovedIdr: number,
  minimumPayoutIdr: number = AFFILIATE_PAYOUT_MINIMUM_IDR,
): boolean {
  if (
    typeof netAvailableApprovedIdr !== "number" ||
    !Number.isSafeInteger(netAvailableApprovedIdr)
  ) {
    return false;
  }
  const validMin = assertExactCommissionInteger(minimumPayoutIdr, "minimumPayoutIdr", {
    min: 1,
    max: AFFILIATE_MAX_IDR_AMOUNT,
  });
  return netAvailableApprovedIdr >= validMin;
}

function parseOptionalRateBps(
  rawBps: unknown,
  rawPercent: unknown,
  fallbackBps: number,
): { readonly value: number; readonly configured: boolean } {
  if (typeof rawBps === "number" && Number.isSafeInteger(rawBps)) {
    if (rawBps >= 0 && rawBps <= AFFILIATE_COMMISSION_BPS_DENOMINATOR) {
      return { value: rawBps, configured: true };
    }
  }
  if (typeof rawPercent === "number" && Number.isSafeInteger(rawPercent)) {
    const converted = rawPercent * 100;
    if (converted >= 0 && converted <= AFFILIATE_COMMISSION_BPS_DENOMINATOR) {
      return { value: converted, configured: true };
    }
  }
  return { value: fallbackBps, configured: false };
}

/**
 * Parses and validates an affiliate commission settings snapshot from `platform_settings.value_json`
 * (or a parsed object), falling back cleanly to canonical defaults (`60%` / `20%`, `14` days, `Rp 100.000`).
 */
export function parseAffiliateCommissionRatesSnapshot(
  raw: unknown,
): AffiliateCommissionRatesSnapshot {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return DEFAULT_AFFILIATE_COMMISSION_RATES_SNAPSHOT;
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }

  if (!obj) {
    return DEFAULT_AFFILIATE_COMMISSION_RATES_SNAPSHOT;
  }

  const first = parseOptionalRateBps(
    obj.firstPaymentRateBps ?? obj.first_payment_rate_bps,
    obj.firstPaymentRatePercent ?? obj.first_payment_rate_percent,
    AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS,
  );
  const renewal = parseOptionalRateBps(
    obj.renewalRateBps ?? obj.renewal_rate_bps,
    obj.renewalRatePercent ?? obj.renewal_rate_percent,
    AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS,
  );

  const rawHoldDays = obj.holdDays ?? obj.hold_days;
  const hasHoldDays =
    typeof rawHoldDays === "number" &&
    Number.isSafeInteger(rawHoldDays) &&
    rawHoldDays >= 0 &&
    rawHoldDays <= 365;
  const holdDays = hasHoldDays ? rawHoldDays : AFFILIATE_COMMISSION_HOLD_DAYS;

  const rawMinPayout = obj.minimumPayoutIdr ?? obj.minimum_payout_idr;
  const hasMinPayout =
    typeof rawMinPayout === "number" &&
    Number.isSafeInteger(rawMinPayout) &&
    rawMinPayout >= 1 &&
    rawMinPayout <= AFFILIATE_MAX_IDR_AMOUNT;
  const minimumPayoutIdr = hasMinPayout ? rawMinPayout : AFFILIATE_PAYOUT_MINIMUM_IDR;

  const configured = first.configured || renewal.configured || hasHoldDays || hasMinPayout;

  return {
    firstPaymentRateBps: first.value,
    renewalRateBps: renewal.value,
    holdDays,
    minimumPayoutIdr,
    source: configured ? "platform_settings" : "default",
  };
}
