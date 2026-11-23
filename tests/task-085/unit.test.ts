import fs from "node:fs";
import path from "node:path";
import {
  AFFILIATE_COMMISSION_DAY_MS,
  AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS,
  AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS,
  AFFILIATE_COMMISSION_HOLD_DAYS,
  AFFILIATE_COMMISSION_HOLD_MS,
  AFFILIATE_PAYOUT_MINIMUM_IDR,
  AffiliateCommissionMathError,
  calculateAffiliateCommission,
  calculateCommissionIdrFromNetBase,
  calculateNetCommissionableBaseIdr,
  computeCommissionHoldUntilMs,
  getDaysInCalendarMonth,
  getWibCalendarDate,
  isAffiliatePayoutBatchDate,
  isBalanceEligibleForPayout,
  isCommissionHoldMatured,
  parseAffiliateCommissionRatesSnapshot,
  resolveAffiliatePayoutPeriodKey,
} from "@punyasitus/core/affiliates/commission";
import {
  AFFILIATE_COMMISSION_LEDGER_MIGRATION,
  AFFILIATE_COMMISSION_LEDGER_MIGRATION_SQL,
} from "@punyasitus/db/affiliates/ledger/migrations";
import { splitMigrationStatements } from "@punyasitus/db/connections";
import { describe, expect, it } from "vitest";
import {
  AFFILIATE_CRON_JOB_DEFINITIONS,
  AFFILIATE_HOLD_PROMOTION_CRON_JOB_DEFINITION,
  AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION,
} from "../../apps/web/src/worker/cron/affiliate-payouts.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATION_SQL_PATH = path.join(
  ROOT,
  "packages/db/migrations/platform/0032_affiliate_commission_ledger.sql",
);

describe("TASK-085 migration parity (0032_affiliate_commission_ledger.sql)", () => {
  it("matches packages/db/migrations/platform/0032_affiliate_commission_ledger.sql byte-for-byte", () => {
    expect(fs.existsSync(MIGRATION_SQL_PATH)).toBe(true);
    const diskSql = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
    expect(AFFILIATE_COMMISSION_LEDGER_MIGRATION_SQL).toBe(diskSql);
    expect(AFFILIATE_COMMISSION_LEDGER_MIGRATION.version).toBe(32);
    expect(AFFILIATE_COMMISSION_LEDGER_MIGRATION.name).toBe("0032_affiliate_commission_ledger");
    expect(AFFILIATE_COMMISSION_LEDGER_MIGRATION.sql).toBe(diskSql);

    const statements = splitMigrationStatements(diskSql);
    expect(statements.length).toBeGreaterThanOrEqual(13);
    expect(
      statements.some((s) =>
        s.startsWith("CREATE TRIGGER IF NOT EXISTS affiliate_commission_entries_paid_immutable"),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        s.startsWith("CREATE TRIGGER IF NOT EXISTS affiliate_commission_entries_paid_no_delete"),
      ),
    ).toBe(true);
  });
});

describe("TASK-085 exact integer IDR commission math", () => {
  it("computes net commissionable base excluding discounts, PPN, and AutoLaris channel fee", () => {
    expect(
      calculateNetCommissionableBaseIdr({
        grossAmountIdr: 183_000,
        discountAmountIdr: 20_000,
        ppnAmountIdr: 0,
        channelFeeIdr: 4_000,
      }),
    ).toBe(159_000);

    expect(
      calculateNetCommissionableBaseIdr({
        grossAmountIdr: 202_690,
        discountAmountIdr: 10_000,
        ppnAmountIdr: 18_590,
        channelFeeIdr: 4_100,
      }),
    ).toBe(170_000);

    // Clamps strictly to >= 0 when deductions exceed gross
    expect(
      calculateNetCommissionableBaseIdr({
        grossAmountIdr: 50_000,
        discountAmountIdr: 60_000,
        ppnAmountIdr: 5_000,
        channelFeeIdr: 4_000,
      }),
    ).toBe(0);

    // Rejects non-integers / negative / NaN
    expect(() =>
      calculateNetCommissionableBaseIdr({ grossAmountIdr: 179_000.5 }),
    ).toThrowError(AffiliateCommissionMathError);
    expect(() =>
      calculateNetCommissionableBaseIdr({ grossAmountIdr: -1 }),
    ).toThrowError(AffiliateCommissionMathError);
    expect(() =>
      calculateNetCommissionableBaseIdr({ grossAmountIdr: Number.NaN }),
    ).toThrowError(AffiliateCommissionMathError);
  });

  it("computes exact 60% first-payment and 20% renewal commissions rounded DOWN to whole rupiah", () => {
    // Standard Rp 179.000 monthly plan
    const firstStd = calculateAffiliateCommission({
      grossAmountIdr: 183_000,
      discountAmountIdr: 0,
      ppnAmountIdr: 0,
      channelFeeIdr: 4_000,
      isFirstPayment: true,
    });
    expect(firstStd).toEqual({
      entryKind: "first_payment",
      grossAmountIdr: 183_000,
      discountAmountIdr: 0,
      ppnAmountIdr: 0,
      channelFeeIdr: 4_000,
      netBaseIdr: 179_000,
      rateBps: AFFILIATE_COMMISSION_DEFAULT_FIRST_PAYMENT_RATE_BPS,
      commissionIdr: 107_400,
    });

    const renewalStd = calculateAffiliateCommission({
      grossAmountIdr: 183_000,
      discountAmountIdr: 0,
      ppnAmountIdr: 0,
      channelFeeIdr: 4_000,
      isFirstPayment: false,
    });
    expect(renewalStd.entryKind).toBe("renewal");
    expect(renewalStd.rateBps).toBe(AFFILIATE_COMMISSION_DEFAULT_RENEWAL_RATE_BPS);
    expect(renewalStd.commissionIdr).toBe(35_800);

    // Odd rupiah values MUST round DOWN (floor) with zero float drift
    // 179_001 * 6000 / 10_000 = 107_400.6 -> 107_400
    expect(calculateCommissionIdrFromNetBase(179_001, 6000)).toBe(107_400);
    // 179_001 * 2000 / 10_000 = 35_800.2 -> 35_800
    expect(calculateCommissionIdrFromNetBase(179_001, 2000)).toBe(35_800);
    // 179_009 * 6000 / 10_000 = 107_405.4 -> 107_405
    expect(calculateCommissionIdrFromNetBase(179_009, 6000)).toBe(107_405);
    // 3 * 6000 / 10_000 = 1.8 -> 1
    expect(calculateCommissionIdrFromNetBase(3, 6000)).toBe(1);
    // 4 * 2000 / 10_000 = 0.8 -> 0
    expect(calculateCommissionIdrFromNetBase(4, 2000)).toBe(0);

    // Large IDR value near max ceiling (999_999_999_999 * 6000 exceeds MAX_SAFE_INTEGER if not using BigInt!)
    expect(calculateCommissionIdrFromNetBase(999_999_999_999, 6000)).toBe(599_999_999_999);
    expect(calculateCommissionIdrFromNetBase(999_999_999_999, 2000)).toBe(199_999_999_999);

    // Discounted yearly plan with coupon + PPN + channel fee
    const discounted = calculateAffiliateCommission({
      grossAmountIdr: 1_800_000,
      discountAmountIdr: 250_000,
      ppnAmountIdr: 150_000,
      channelFeeIdr: 5_000,
      isFirstPayment: true,
    });
    expect(discounted.netBaseIdr).toBe(1_395_000);
    expect(discounted.commissionIdr).toBe(837_000);
  });

  it("parses snapshotted platform_settings rates safely with canonical defaults", () => {
    expect(parseAffiliateCommissionRatesSnapshot(null)).toEqual({
      firstPaymentRateBps: 6000,
      renewalRateBps: 2000,
      holdDays: 14,
      minimumPayoutIdr: 100_000,
      source: "default",
    });

    expect(
      parseAffiliateCommissionRatesSnapshot(
        JSON.stringify({
          firstPaymentRateBps: 5000,
          renewalRateBps: 1500,
          holdDays: 21,
          minimumPayoutIdr: 150_000,
        }),
      ),
    ).toEqual({
      firstPaymentRateBps: 5000,
      renewalRateBps: 1500,
      holdDays: 21,
      minimumPayoutIdr: 150_000,
      source: "platform_settings",
    });

    // Supports integer percent aliases
    expect(
      parseAffiliateCommissionRatesSnapshot({
        firstPaymentRatePercent: 55,
        renewalRatePercent: 25,
      }),
    ).toMatchObject({
      firstPaymentRateBps: 5500,
      renewalRateBps: 2500,
      source: "platform_settings",
    });

    // Corrupted JSON falls back cleanly
    expect(parseAffiliateCommissionRatesSnapshot("{not-json")).toMatchObject({
      firstPaymentRateBps: 6000,
      renewalRateBps: 2000,
      source: "default",
    });
  });
});

describe("TASK-085 14-day hold & bi-monthly Asia/Jakarta (WIB) payout schedule", () => {
  it("enforces exact 14-day hold boundary down to the millisecond", () => {
    const confirmedAt = Date.UTC(2026, 10, 1, 10, 0, 0);
    const holdUntil = computeCommissionHoldUntilMs(confirmedAt);

    expect(AFFILIATE_COMMISSION_HOLD_DAYS).toBe(14);
    expect(holdUntil - confirmedAt).toBe(AFFILIATE_COMMISSION_HOLD_MS);
    expect(holdUntil - confirmedAt).toBe(14 * AFFILIATE_COMMISSION_DAY_MS);

    // 13d 23h 59m 00s -> NOT matured
    expect(isCommissionHoldMatured(holdUntil, confirmedAt + 14 * AFFILIATE_COMMISSION_DAY_MS - 60_000)).toBe(false);
    // 13d 23h 59m 59.999s -> NOT matured
    expect(isCommissionHoldMatured(holdUntil, holdUntil - 1)).toBe(false);
    // 14d 00h 00m 00.000s -> MATURED
    expect(isCommissionHoldMatured(holdUntil, holdUntil)).toBe(true);
    expect(isCommissionHoldMatured(holdUntil, holdUntil + 1)).toBe(true);
  });

  it("evaluates 15th, 30th, and February 28/29 strictly in Asia/Jakarta (UTC+7)", () => {
    // 2026-11-14T16:59:59.999Z === 2026-11-14T23:59:59.999+07:00 -> NOT payout date
    const justBeforeWib15 = Date.UTC(2026, 10, 14, 16, 59, 59, 999);
    expect(getWibCalendarDate(justBeforeWib15).dateKey).toBe("2026-11-14");
    expect(resolveAffiliatePayoutPeriodKey(justBeforeWib15)).toBeNull();
    expect(isAffiliatePayoutBatchDate(justBeforeWib15)).toBe(false);

    // 2026-11-14T17:00:00.000Z === 2026-11-15T00:00:00.000+07:00 -> 15th WIB!
    const exactWib15Start = Date.UTC(2026, 10, 14, 17, 0, 0, 0);
    expect(getWibCalendarDate(exactWib15Start).dateKey).toBe("2026-11-15");
    expect(resolveAffiliatePayoutPeriodKey(exactWib15Start)).toBe("2026-11-15");
    expect(isAffiliatePayoutBatchDate(exactWib15Start)).toBe(true);

    // 2026-11-15T16:59:59.999Z === 2026-11-15T23:59:59.999+07:00 -> still 15th WIB
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2026, 10, 15, 16, 59, 59, 999))).toBe(
      "2026-11-15",
    );
    // 2026-11-15T17:00:00.000Z === 2026-11-16T00:00:00.000+07:00 -> 16th WIB (NOT payout date)
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2026, 10, 15, 17, 0, 0, 0))).toBeNull();

    // 30th of November & December (31st is NOT a payout date)
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2026, 10, 30, 1, 0, 0))).toBe("2026-11-30");
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2026, 11, 30, 1, 0, 0))).toBe("2026-12-30");
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2026, 11, 31, 1, 0, 0))).toBeNull();

    // Non-leap year February 2027 -> 15th and 28th
    expect(getDaysInCalendarMonth(2027, 2)).toBe(28);
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2027, 1, 15, 2, 0, 0))).toBe("2027-02-15");
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2027, 1, 27, 2, 0, 0))).toBeNull();
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2027, 1, 27, 17, 0, 0))).toBe("2027-02-28");

    // Leap year February 2028 -> 15th and 29th (NOT 28th!)
    expect(getDaysInCalendarMonth(2028, 2)).toBe(29);
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2028, 1, 28, 2, 0, 0))).toBeNull();
    expect(resolveAffiliatePayoutPeriodKey(Date.UTC(2028, 1, 28, 17, 0, 0))).toBe("2028-02-29");

    // Cron definitions match WIB payout schedule
    expect(AFFILIATE_CRON_JOB_DEFINITIONS).toEqual([
      AFFILIATE_HOLD_PROMOTION_CRON_JOB_DEFINITION,
      AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION,
    ]);
    expect(AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION.shouldRun?.(justBeforeWib15)).toBe(false);
    expect(AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION.shouldRun?.(exactWib15Start)).toBe(true);
    expect(AFFILIATE_PAYOUT_BATCH_CRON_JOB_DEFINITION.buildPayload?.(exactWib15Start)).toEqual({
      scheduledTimeMs: exactWib15Start,
      payoutPeriodKey: "2026-11-15",
    });
  });

  it("enforces Rp 100.000 minimum payable balance threshold", () => {
    expect(AFFILIATE_PAYOUT_MINIMUM_IDR).toBe(100_000);
    expect(isBalanceEligibleForPayout(-50_000)).toBe(false);
    expect(isBalanceEligibleForPayout(0)).toBe(false);
    expect(isBalanceEligibleForPayout(99_999)).toBe(false);
    expect(isBalanceEligibleForPayout(100_000)).toBe(true);
    expect(isBalanceEligibleForPayout(250_000)).toBe(true);
  });
});
