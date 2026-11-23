import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BillingValidationError,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  computeSubscriptionPeriodPreview,
} from "@punyasitus/core/billing/index";
import {
  AUTOLARIS_MIN_PAYMENT_IDR,
  calculateCouponDiscount,
  computeAffiliateCommissionIdr,
  computeAffiliateCommissionableBaseIdr,
  computePlanPeriodEndUtcMs,
  computeYearlySavingsIdr,
  evaluateCouponEligibility,
  parseSingleCouponCodeInput,
  validateCreatePromoCouponInput,
  validateUpdatePromoCouponInput,
  type PromoCouponRecord,
} from "@punyasitus/core/billing/coupons";
import { BILLING_COUPONS_MIGRATION_SQL } from "@punyasitus/db/billing/coupons/index";
import {
  buildBillingIdempotencyScopeKey,
  computeCheckoutBreakdown,
} from "../../apps/web/src/components/admin/billing/helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function makeSampleCoupon(overrides: Partial<PromoCouponRecord> = {}): PromoCouponRecord {
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const end = Date.UTC(2026, 11, 31, 23, 59, 59);
  return {
    id: "01JTESTCOUPON0000000000001",
    code: "HEMAT20",
    discountKind: "percent",
    discountValue: 20,
    eligiblePlans: ["monthly", "yearly"],
    eligiblePayerTypes: ["tenant", "agency"],
    maxRedemptions: 100,
    redeemedCount: 0,
    startsAtMs: start,
    endsAtMs: end,
    startsAtIso: new Date(start).toISOString(),
    endsAtIso: new Date(end).toISOString(),
    active: true,
    notes: "Promo launching",
    createdByUserId: "usr_op_1",
    version: 1,
    createdAtMs: start,
    updatedAtMs: start,
    createdAtIso: new Date(start).toISOString(),
    updatedAtIso: new Date(start).toISOString(),
    ...overrides,
  };
}

describe("TASK-082 unit: Yearly plans, coupon math, floor enforcement, anti-stacking & affiliate net base", () => {
  it("keeps bundled BILLING_COUPONS_MIGRATION_SQL byte-for-byte identical to 0010_billing_coupons.sql", () => {
    const diskSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0010_billing_coupons.sql"),
      "utf8",
    );
    expect(BILLING_COUPONS_MIGRATION_SQL).toBe(diskSql);
  });

  it("computes exact 12-calendar-month UTC periods with month-end clamping (including leap-year Feb 29)", () => {
    // Jan 31, 2026 + 12 months -> Jan 31, 2027
    const jan31 = computePlanPeriodEndUtcMs("yearly", Date.UTC(2026, 0, 31, 10, 0, 0));
    expect(jan31.months).toBe(12);
    expect(jan31.periodEndAtIso).toBe("2027-01-31T10:00:00.000Z");

    // Leap-year Feb 29, 2028 + 12 months -> clamps to Feb 28, 2029!
    const feb29Leap = computePlanPeriodEndUtcMs("yearly", Date.UTC(2028, 1, 29, 8, 30, 0));
    expect(feb29Leap.months).toBe(12);
    expect(feb29Leap.periodEndAtIso).toBe("2029-02-28T08:30:00.000Z");

    // Early renewal on active tenant preserves current paidThrough and appends 12 calendar months
    const earlyRenew = computeSubscriptionPeriodPreview({
      plan: "yearly",
      tenantStatus: "active",
      paidThroughMs: Date.UTC(2028, 1, 29, 12, 0, 0),
      trialEndsAtMs: null,
      nowMs: Date.UTC(2028, 1, 20, 12, 0, 0),
    });
    expect(earlyRenew.renewalAnchor).toBe("current_period_end");
    expect(earlyRenew.periodStartAtIso).toBe("2028-02-29T12:00:00.000Z");
    expect(earlyRenew.periodEndAtIso).toBe("2029-02-28T12:00:00.000Z");
  });

  it("computes exact integer IDR yearly savings (12 * monthly - yearly)", () => {
    expect(computeYearlySavingsIdr(DEFAULT_MONTHLY_PRICE_IDR, DEFAULT_YEARLY_PRICE_IDR)).toBe(
      358_000,
    );
    expect(computeYearlySavingsIdr(200_000, 1_990_000)).toBe(410_000);
    // Clamps cleanly to 0 if yearly >= 12 * monthly
    expect(computeYearlySavingsIdr(100_000, 1_500_000)).toBe(0);
  });

  it("calculates exact integer percent & fixed_idr discounts with zero floating-point drift", () => {
    // 20% of 1,790,000 = 358,000 -> net 1,432,000
    const yearlyPct = calculateCouponDiscount({
      baseAmountIdr: 1_790_000,
      discountKind: "percent",
      discountValue: 20,
    });
    expect(yearlyPct.discountAmountIdr).toBe(358_000);
    expect(yearlyPct.netBaseAmountIdr).toBe(1_432_000);
    expect(yearlyPct.affiliateCommissionableBaseIdr).toBe(1_432_000);

    // 7% of 179,000 = 12,530 -> net 166,470
    const monthlyPct = calculateCouponDiscount({
      baseAmountIdr: 179_000,
      discountKind: "percent",
      discountValue: 7,
    });
    expect(monthlyPct.discountAmountIdr).toBe(12_530);
    expect(monthlyPct.netBaseAmountIdr).toBe(166_470);

    // Non-divisible percent uses exact BigInt floor (no float rounding drift):
    // 33% of 179,001 = floor(59070.33) = 59,070
    const oddPct = calculateCouponDiscount({
      baseAmountIdr: 179_001,
      discountKind: "percent",
      discountValue: 33,
    });
    expect(oddPct.discountAmountIdr).toBe(59_070);
    expect(oddPct.netBaseAmountIdr).toBe(119_931);

    // Fixed IDR discount
    const fixed = calculateCouponDiscount({
      baseAmountIdr: 179_000,
      discountKind: "fixed_idr",
      discountValue: 50_000,
    });
    expect(fixed.discountAmountIdr).toBe(50_000);
    expect(fixed.netBaseAmountIdr).toBe(129_000);
  });

  it("strictly enforces the AutoLaris minimum payment floor (Rp 10.000)", () => {
    expect(AUTOLARIS_MIN_PAYMENT_IDR).toBe(10_000);

    // Exact boundary net === 10_000 succeeds
    const atFloor = calculateCouponDiscount({
      baseAmountIdr: 179_000,
      discountKind: "fixed_idr",
      discountValue: 169_000,
    });
    expect(atFloor.netBaseAmountIdr).toBe(10_000);

    // Net === 9_999 fails with COUPON_BELOW_MIN_PAYMENT_FLOOR
    expect(() =>
      calculateCouponDiscount({
        baseAmountIdr: 179_000,
        discountKind: "fixed_idr",
        discountValue: 169_001,
      }),
    ).toThrow(BillingValidationError);

    try {
      calculateCouponDiscount({
        baseAmountIdr: 179_000,
        discountKind: "percent",
        discountValue: 95, // 5% of 179,000 = 8,950 < 10,000
      });
      expect.unreachable("Should have thrown COUPON_BELOW_MIN_PAYMENT_FLOOR");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingValidationError);
      expect((err as BillingValidationError).status).toBe(422);
      expect((err as BillingValidationError).reasonCode).toBe("COUPON_BELOW_MIN_PAYMENT_FLOOR");
    }
  });

  it("rejects coupon stacking (arrays and delimiter-separated multi-codes) with 422 COUPON_STACKING_FORBIDDEN", () => {
    const stackingPayloads: unknown[] = [
      ["HEMAT10", "PROMO20"],
      ["HEMAT10"],
      "HEMAT10,PROMO20",
      "HEMAT10, PROMO20",
      "HEMAT10;PROMO20",
      "HEMAT10+PROMO20",
      "HEMAT10|PROMO20",
      "HEMAT10 PROMO20",
    ];

    for (const payload of stackingPayloads) {
      try {
        parseSingleCouponCodeInput(payload);
        expect.unreachable(`Expected stacking rejection for ${JSON.stringify(payload)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BillingValidationError);
        expect((err as BillingValidationError).status).toBe(422);
        expect((err as BillingValidationError).reasonCode).toBe("COUPON_STACKING_FORBIDDEN");
      }
    }

    // Valid single code normalizes to uppercase
    expect(parseSingleCouponCodeInput("  hemat_20-id  ")).toBe("HEMAT_20-ID");
    expect(parseSingleCouponCodeInput(undefined)).toBeNull();
    expect(parseSingleCouponCodeInput("")).toBeNull();
  });

  it("computes affiliate commissionable net base AFTER coupon discount and EXCLUDING channel fees", () => {
    // Base Rp 1.790.000 - Diskon Rp 358.000 = Net Rp 1.432.000 (channel fee Rp 4.000 excluded!)
    const netBase = computeAffiliateCommissionableBaseIdr({
      baseAmountIdr: 1_790_000,
      discountAmountIdr: 358_000,
    });
    expect(netBase).toBe(1_432_000);

    // REQ-085: 60% first payment & 20% renewal rounded down to whole rupiah
    expect(
      computeAffiliateCommissionIdr({
        baseAmountIdr: 1_790_000,
        discountAmountIdr: 358_000,
        ratePercent: 60,
      }),
    ).toBe(859_200);
    expect(
      computeAffiliateCommissionIdr({
        baseAmountIdr: 179_000,
        discountAmountIdr: 29_001, // net 149_999 -> 60% = 89_999.4 -> floor 89_999
        ratePercent: 60,
      }),
    ).toBe(89_999);
    expect(
      computeAffiliateCommissionIdr({
        baseAmountIdr: 1_790_000,
        discountAmountIdr: 358_000,
        ratePercent: 20,
      }),
    ).toBe(286_400);
  });

  it("evaluates every coupon rejection condition with explicit domain error codes", () => {
    const midYear = Date.UTC(2026, 5, 15, 12, 0, 0);

    expect(
      evaluateCouponEligibility({
        coupon: null,
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_NOT_FOUND" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ active: false }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_INACTIVE" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ startsAtMs: midYear + 1000 }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_NOT_STARTED" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ endsAtMs: midYear - 1000 }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_EXPIRED" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ maxRedemptions: 2, redeemedCount: 2 }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_EXHAUSTED" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ eligiblePlans: ["yearly"] }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_PLAN_INELIGIBLE" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ eligiblePayerTypes: ["agency"] }),
        plan: "yearly",
        payerType: "tenant",
        baseAmountIdr: 1_790_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_PAYER_INELIGIBLE" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon(),
        plan: "yearly",
        baseAmountIdr: 1_790_000,
        alreadyRedeemedByTenant: true,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 409, code: "COUPON_ALREADY_REDEEMED" });

    expect(
      evaluateCouponEligibility({
        coupon: makeSampleCoupon({ discountKind: "fixed_idr", discountValue: 175_000 }),
        plan: "monthly",
        baseAmountIdr: 179_000,
        nowMs: midYear,
      }),
    ).toMatchObject({ ok: false, status: 422, code: "COUPON_BELOW_MIN_PAYMENT_FLOOR" });
  });

  it("validates console coupon create/update payloads and checkout UI helpers cleanly", () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 11, 31);
    const created = validateCreatePromoCouponInput({
      code: "tahun20",
      discountKind: "percent",
      discountValue: 20,
      eligiblePlans: ["yearly"],
      maxRedemptions: 50,
      startsAt: start,
      endsAt: end,
      reason: "Kampanye promo tahunan resmi kuartal pertama",
    });
    expect(created.code).toBe("TAHUN20");
    expect(created.active).toBe(true);

    const updated = validateUpdatePromoCouponInput({
      expectedVersion: 1,
      active: false,
      reason: "Menonaktifkan kupon setelah kampanye berakhir",
    });
    expect(updated.expectedVersion).toBe(1);
    expect(updated.active).toBe(false);

    // Checkout breakdown reflects applied coupon & idempotency scope key includes coupon cleanly
    const breakdown = computeCheckoutBreakdown({
      plan: "yearly",
      pricingPlans: [
        { plan: "monthly", months: 1, baseAmountIdr: 179_000, currency: "IDR", savingsIdr: 0 },
        { plan: "yearly", months: 12, baseAmountIdr: 1_790_000, currency: "IDR", savingsIdr: 358_000 },
      ],
      selectedChannel: {
        code: "VABCA",
        label: "BCA Virtual Account",
        kind: "VA",
        estimatedFeeIdr: 4_000,
        enabled: true,
      },
      appliedCoupon: {
        code: "TAHUN20",
        discountKind: "percent",
        discountValue: 20,
        plan: "yearly",
        baseAmountIdr: 1_790_000,
        discountAmountIdr: 358_000,
        netBaseAmountIdr: 1_432_000,
        affiliateCommissionableBaseIdr: 1_432_000,
        estimatedChannelFeeIdr: 4_000,
      },
      tenantStatus: "trial",
      paidThroughIso: null,
      trialEndsAtIso: null,
      nowMs: Date.UTC(2026, 0, 31, 10, 0, 0),
    });
    expect(breakdown.couponCode).toBe("TAHUN20");
    expect(breakdown.discountAmountIdr).toBe(358_000);
    expect(breakdown.netAmountIdr).toBe(1_432_000);
    expect(breakdown.totalPayableIdr).toBe(1_436_000);

    const scopeWithoutCoupon = buildBillingIdempotencyScopeKey({
      tenantId: "ten_1",
      obligationId: null,
      plan: "yearly",
      channelCode: "VABCA",
    });
    const scopeWithCoupon = buildBillingIdempotencyScopeKey({
      tenantId: "ten_1",
      obligationId: null,
      plan: "yearly",
      channelCode: "VABCA",
      couponCode: "TAHUN20",
    });
    expect(scopeWithCoupon).toBe(`${scopeWithoutCoupon}:cpn:TAHUN20`);
  });

  it("enforces zero @radix-ui/* imports, zero asChild, and zero runtime DDL in TASK-082 UI/API files", () => {
    const uiFiles = [
      "apps/web/src/pages/console/coupons/index.astro",
      "apps/web/src/pages/console/coupons/_ConsoleCouponsPanel.tsx",
      "apps/web/src/components/admin/billing/OwnerBillingPanel.tsx",
      "apps/web/src/components/admin/billing/helpers.ts",
    ];
    for (const rel of uiFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/@radix-ui\//);
      expect(src).not.toMatch(/\basChild\b/);
    }

    const runtimeHandlerFiles = [
      "apps/web/src/pages/console/coupons/index.astro",
      "apps/web/src/pages/api/console/coupons/index.ts",
      "apps/web/src/pages/api/console/coupons/[couponId].ts",
      "apps/web/src/pages/api/console/coupons/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/billing/coupons/validate.ts",
    ];
    for (const rel of runtimeHandlerFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/CREATE\s+TABLE/i);
      expect(src).not.toMatch(/ALTER\s+TABLE/i);
      expect(src).not.toMatch(/applyBillingCouponsMigration/);
      expect(src).not.toMatch(/applyPlatformMigrations/);
    }

    // Non-console host 404 returns bare neutral "Not Found" without disclosing console access text
    const consolePageSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/pages/console/coupons/index.astro"),
      "utf8",
    );
    expect(consolePageSrc).toContain('if (authz.response.status === 404)');
    expect(consolePageSrc).toContain('new Response("Not Found"');
  });
});
