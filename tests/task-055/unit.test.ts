import fs from "node:fs";
import path from "node:path";
import {
  BillingProviderError,
  BillingValidationError,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
  addCalendarMonthsUtc,
  assertExactIdrInteger,
  buildImmutableObligationSnapshot,
  classifyAllowedChannel,
  computeBillingRequestHash,
  computeSubscriptionPeriodPreview,
  estimateChannelFeeIdr,
  filterAllowedAutoLarisChannels,
  generateAutoLarisReffId,
  generateBillingUlid,
  redactBillingLogRecord,
  validateProviderCosts,
} from "@punyasitus/core/billing/index";
import { BILLING_OBLIGATIONS_MIGRATION_SQL } from "@punyasitus/db/billing/index";
import { describe, expect, it } from "vitest";
import {
  createAutoLarisClient,
  validateApprovedPaymentRedirectUrl,
  validateAutoLarisRelayUrl,
} from "../../packages/integrations/src/autolaris/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-055 unit checks — migration parity, calendar-month clamp, IDR money, channels & AutoLaris relay", () => {
  it("keeps bundled 0004_billing_obligations SQL byte-for-byte identical to the migration file on disk", () => {
    const onDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0004_billing_obligations.sql"),
      "utf8",
    );
    expect(BILLING_OBLIGATIONS_MIGRATION_SQL).toBe(onDisk);
  });

  it("computes UTC calendar-month periods with exact month-end clamping across leap and non-leap years", () => {
    // Jan 31 + 1 month -> Feb 28 (non-leap year 2026)
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2026, 0, 31, 10, 30, 0), 1)).toISOString(),
    ).toBe("2026-02-28T10:30:00.000Z");

    // Jan 31 + 1 month -> Feb 29 (leap year 2028)
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2028, 0, 31, 10, 30, 0), 1)).toISOString(),
    ).toBe("2028-02-29T10:30:00.000Z");

    // Jan 31 + 12 months -> Jan 31 next year
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2026, 0, 31, 10, 30, 0), 12)).toISOString(),
    ).toBe("2027-01-31T10:30:00.000Z");

    // Leap-year Feb 29 + 12 months -> Feb 28 next year
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2028, 1, 29, 12, 0, 0), 12)).toISOString(),
    ).toBe("2029-02-28T12:00:00.000Z");

    // March 31 + 1 month -> April 30
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2026, 2, 31, 0, 0, 0), 1)).toISOString(),
    ).toBe("2026-04-30T00:00:00.000Z");

    // Dec 31 + 1 month -> Jan 31 next year
    expect(
      new Date(addCalendarMonthsUtc(Date.UTC(2026, 11, 31, 23, 59, 59), 1)).toISOString(),
    ).toBe("2027-01-31T23:59:59.000Z");
  });

  it("applies PLAN §17.1 renewal anchors for active, grace, locked, trial, and suspended tenants", () => {
    const paidThroughMs = Date.UTC(2026, 0, 31, 12, 0, 0);

    // Active early renewal anchors on current_period_end (Jan 31 -> Feb 28)
    const activePreview = computeSubscriptionPeriodPreview({
      plan: "monthly",
      tenantStatus: "active",
      paidThroughMs,
      trialEndsAtMs: null,
      nowMs: Date.UTC(2026, 0, 20, 12, 0, 0),
    });
    expect(activePreview.renewalAnchor).toBe("current_period_end");
    expect(activePreview.periodStartAtIso).toBe("2026-01-31T12:00:00.000Z");
    expect(activePreview.periodEndAtIso).toBe("2026-02-28T12:00:00.000Z");

    // Grace renewal (H+2) still anchors on current_period_end
    const gracePreview = computeSubscriptionPeriodPreview({
      plan: "yearly",
      tenantStatus: "grace",
      paidThroughMs,
      trialEndsAtMs: null,
      nowMs: paidThroughMs + 48 * 60 * 60 * 1000,
    });
    expect(gracePreview.renewalAnchor).toBe("current_period_end");
    expect(gracePreview.periodStartAtIso).toBe("2026-01-31T12:00:00.000Z");
    expect(gracePreview.periodEndAtIso).toBe("2027-01-31T12:00:00.000Z");

    // Active trial preserves remaining trial hours + purchased calendar period
    const trialEndsAtMs = Date.UTC(2026, 0, 31, 8, 0, 0);
    const trialNowMs = Date.UTC(2026, 0, 26, 8, 0, 0);
    const trialPreview = computeSubscriptionPeriodPreview({
      plan: "monthly",
      tenantStatus: "trial",
      paidThroughMs: null,
      trialEndsAtMs,
      nowMs: trialNowMs,
    });
    expect(trialPreview.renewalAnchor).toBe("trial_end_preserved");
    expect(trialPreview.periodStartAtIso).toBe("2026-01-26T08:00:00.000Z");
    expect(trialPreview.periodEndAtIso).toBe("2026-02-28T08:00:00.000Z");

    // Suspended (H+10 after expiry) starts fresh from settlement time
    const suspendedNowMs = paidThroughMs + 10 * 24 * 60 * 60 * 1000;
    const suspendedPreview = computeSubscriptionPeriodPreview({
      plan: "monthly",
      tenantStatus: "suspended",
      paidThroughMs,
      trialEndsAtMs: null,
      nowMs: suspendedNowMs,
    });
    expect(suspendedPreview.renewalAnchor).toBe("settlement_time");
    expect(suspendedPreview.periodStartAtMs).toBe(suspendedNowMs);
    expect(suspendedPreview.periodEndAtMs).toBe(addCalendarMonthsUtc(suspendedNowMs, 1));
  });

  it("enforces exact integer IDR arithmetic and validates provider fees/totals strictly", () => {
    expect(DEFAULT_MONTHLY_PRICE_IDR).toBe(179_000);
    expect(DEFAULT_YEARLY_PRICE_IDR).toBe(1_790_000);

    expect(assertExactIdrInteger(179_000, "amount")).toBe(179_000);
    expect(() => assertExactIdrInteger(179_000.5, "amount")).toThrow(BillingValidationError);
    expect(() => assertExactIdrInteger(-1, "amount")).toThrow(BillingValidationError);
    expect(() => assertExactIdrInteger(Number.NaN, "amount")).toThrow(BillingValidationError);
    expect(() => assertExactIdrInteger("179000", "amount")).toThrow(BillingValidationError);

    // Exact decimal fee estimation without floating-point drift
    expect(estimateChannelFeeIdr(10_000, { admin: "0.7", tipeAdmin: "persen" })).toBe(70);
    expect(estimateChannelFeeIdr(179_000, { admin: "0.7", tipeAdmin: "persen" })).toBe(1_253);
    expect(estimateChannelFeeIdr(1_790_000, { admin: "0.7", tipeAdmin: "persen" })).toBe(12_530);
    expect(estimateChannelFeeIdr(179_000, { admin: "3000.0", tipeAdmin: "fix" })).toBe(3_000);

    // Rejects negative, fractional fixed, and absurd fees
    expect(() => estimateChannelFeeIdr(179_000, { admin: "-100", tipeAdmin: "fix" })).toThrow(
      BillingValidationError,
    );
    expect(() => estimateChannelFeeIdr(179_000, { admin: "3000.5", tipeAdmin: "fix" })).toThrow(
      BillingValidationError,
    );
    expect(() => estimateChannelFeeIdr(179_000, { admin: "50.0", tipeAdmin: "persen" })).toThrow(
      BillingValidationError,
    );
    expect(() => estimateChannelFeeIdr(179_000, { admin: "100000", tipeAdmin: "fix" })).toThrow(
      BillingValidationError,
    );

    // Provider cost validation passes exact digital subscription costs
    expect(
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 0,
        biayaAsuransi: 0,
        biayaAdmin: 1_253,
        diskon: 0,
        total: 180_253,
      }),
    ).toEqual({
      channelFeeIdr: 1_253,
      grossAdminFeeIdr: 1_253,
      providerDiscountIdr: 0,
      totalPayableIdr: 180_253,
    });

    // Accepts provider admin fee discount offset (biaya_admin: 84, diskon: 84 -> net fee 0)
    expect(
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 0,
        biayaAsuransi: 0,
        biayaAdmin: 84,
        diskon: 84,
        total: 179_000,
      }),
    ).toEqual({
      channelFeeIdr: 0,
      grossAdminFeeIdr: 84,
      providerDiscountIdr: 84,
      totalPayableIdr: 179_000,
    });

    // Rejects non-zero shipping, COD, insurance, mismatched totals, and absurd admin fees
    expect(() =>
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 18_400,
        biayaCod: 0,
        biayaAsuransi: 0,
        biayaAdmin: 1_253,
        diskon: 0,
        total: 198_653,
      }),
    ).toThrow(/pengiriman/i);

    expect(() =>
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 5_000,
        biayaAsuransi: 0,
        biayaAdmin: 1_253,
        diskon: 0,
        total: 185_253,
      }),
    ).toThrow(/COD/i);

    expect(() =>
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 0,
        biayaAsuransi: 2_000,
        biayaAdmin: 1_253,
        diskon: 0,
        total: 182_253,
      }),
    ).toThrow(/asuransi/i);

    expect(() =>
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 0,
        biayaAsuransi: 0,
        biayaAdmin: 1_253,
        diskon: 0,
        total: 199_999,
      }),
    ).toThrow(/tidak sesuai/i);

    expect(() =>
      validateProviderCosts({
        expectedNetAmountIdr: 179_000,
        biayaKirim: 0,
        biayaCod: 0,
        biayaAsuransi: 0,
        biayaAdmin: 90_000,
        diskon: 0,
        total: 269_000,
      }),
    ).toThrow(/batas kebijakan/i);
  });

  it("enforces runtime QRIS and Bank Virtual Account ONLY channel validation", () => {
    for (const valid of [
      { code: "QRIS", kind: "QRIS" },
      { code: "QRIS_DYNAMIC", kind: "QRIS" },
      { code: "VABCA", kind: "VA" },
      { code: "VABNI", kind: "VA" },
      { code: "VABRI", kind: "VA" },
      { code: "VAMANDIRI", kind: "VA" },
      { code: "VAPERMATA", kind: "VA" },
      { code: "VABSI", kind: "VA" },
      { code: "VA_MANDIRI", kind: "VA" },
    ]) {
      const res = classifyAllowedChannel(valid.code);
      expect(res.ok, `Expected ${valid.code} to be allowed`).toBe(true);
      if (res.ok) {
        expect(res.kind).toBe(valid.kind);
      }
    }

    for (const forbidden of [
      "COD",
      "COD_REG",
      "ALFAMART",
      "ALFAMIDI",
      "INDOMARET",
      "OVO",
      "DANA",
      "SHOPEEPAY",
      "LINKAJA",
      "GOPAY",
      "ASTRAPAY",
      "CC",
      "PAYLATER",
      "UNKNOWN_METHOD",
      "",
    ]) {
      const res = classifyAllowedChannel(forbidden);
      expect(res.ok, `Expected ${forbidden} to be rejected`).toBe(false);
    }

    const filtered = filterAllowedAutoLarisChannels(
      [
        { channel_code: "COD", name: "COD", admin: "0.0", tipe_admin: "fix" },
        { channel_code: "QRIS", name: "QRIS", admin: "0.7", tipe_admin: "persen" },
        { channel_code: "VAMANDIRI", name: "Bank Mandiri", admin: "3000.0", tipe_admin: "fix" },
        { channel_code: "OVO", name: "OVO", admin: "3.0", tipe_admin: "persen" },
        { channel_code: "ALFAMART", name: "Alfamart", admin: "5000.0", tipe_admin: "fix" },
        { channel_code: "VABCA", name: "Bank BCA", admin: "-500", tipe_admin: "fix" },
      ],
      DEFAULT_MONTHLY_PRICE_IDR,
    );

    expect(filtered.map((c) => c.code)).toEqual(["QRIS", "VAMANDIRI"]);
    expect(filtered[0]?.estimatedFeeIdr).toBe(1_253);
    expect(filtered[1]?.estimatedFeeIdr).toBe(3_000);
  });

  it("validates static-IP relay URLs against SSRF, enforces redirect allowlists, and redacts secrets & payment data", async () => {
    expect(validateAutoLarisRelayUrl("https://autolaris-relay.punyasitus.com").origin).toBe(
      "https://autolaris-relay.punyasitus.com",
    );

    for (const badUrl of [
      "http://autolaris-relay.punyasitus.com",
      "https://user:pass@autolaris-relay.punyasitus.com",
      "https://localhost/api",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://169.254.169.254",
      "https://192.168.1.10",
      "https://autolaris-relay.punyasitus.com?foo=bar",
      "https://autolaris-relay.punyasitus.com/../etc",
    ]) {
      expect(() => validateAutoLarisRelayUrl(badUrl), `Expected SSRF block for ${badUrl}`).toThrow(
        BillingProviderError,
      );
    }

    expect(validateApprovedPaymentRedirectUrl("https://pay.autolaris.com/trx/123")).toBe(
      "https://pay.autolaris.com/trx/123",
    );
    expect(() => validateApprovedPaymentRedirectUrl("https://evil.example/phish")).toThrow(
      BillingValidationError,
    );
    expect(() => validateApprovedPaymentRedirectUrl("javascript:alert(1)")).toThrow(
      BillingValidationError,
    );

    // Ensure AutoLaris client sends courir_id: 1, cod_value: "0", never calls /create_payment, and never leaks API key
    const secretKey = "al_live_super_secret_token_99887766";
    const calledUrls: string[] = [];
    let capturedSubmitBody: Record<string, unknown> | null = null;

    const client = createAutoLarisClient({
      relayBaseUrl: "https://autolaris-relay.punyasitus.com",
      apiKey: secretKey,
      providerAccountId: "acct-main",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.endsWith("/api/h2h/submit")) {
          capturedSubmitBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              rc: "00",
              ket: "Success",
              data: {
                channel_code: "QRIS",
                transaction_id: "874546",
                reff_id: capturedSubmitBody.reff_id,
                biaya_kirim: 0,
                biaya_cod: 0,
                biaya_admin: 1253,
                biaya_asuransi: 0,
                diskon: 0,
                total: 180253,
                payment_info: {
                  expired: "2026-11-23 14:09:05",
                  va: "",
                  qr: "00020101021226600014ID.CO.QRIS.WWW6304ABCD",
                  url: "",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const reffId = generateAutoLarisReffId(Date.UTC(2026, 10, 22, 14, 0, 0));
    expect(reffId.length).toBeLessThanOrEqual(30);
    expect(generateBillingUlid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const submitted = await client.submitDigitalSubscriptionOrder({
      reffId,
      channelKind: "QRIS",
      channelCode: "QRIS",
      plan: "monthly",
      netAmountIdr: 179_000,
      tenantHandle: "alpha-studio",
      payerName: "Owner Alpha",
      payerEmail: "owner@example.com",
    });

    expect(calledUrls).toEqual(["https://autolaris-relay.punyasitus.com/api/h2h/submit"]);
    expect(calledUrls.some((u) => u.includes("create_payment") || u.includes("ongkir") || u.includes("order"))).toBe(false);
    expect(capturedSubmitBody?.["courir_id"]).toBe(1);
    expect(capturedSubmitBody?.["cod_value"]).toBe("0");
    expect(capturedSubmitBody?.["grand_total"]).toBe("179000");
    expect(submitted.providerTransactionId).toBe("874546");
    expect(submitted.totalPayableIdr).toBe(180_253);

    // Redaction strips Bearer tokens, API keys, QRIS payloads, VA numbers, emails, phones
    const redacted = redactBillingLogRecord({
      authorization: `Bearer ${secretKey}`,
      apiKey: secretKey,
      qrisPayload: "00020101021226600014ID.CO.QRIS.WWW6304ABCD",
      vaNumber: "8779611150001393",
      receiver_email: "owner@example.com",
      note: `Contact owner@example.com or 081234567890 with Bearer ${secretKey}`,
      obligationId: "01JTEST0000000000000000001",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("000201010212");
    expect(serialized).not.toContain("8779611150001393");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("081234567890");
    expect(redacted["obligationId"]).toBe("01JTEST0000000000000000001");

    // Immutable snapshot & deterministic request hash
    const period = computeSubscriptionPeriodPreview({
      plan: "monthly",
      tenantStatus: "active",
      paidThroughMs: Date.UTC(2026, 0, 31, 0, 0, 0),
      trialEndsAtMs: null,
      nowMs: Date.UTC(2026, 0, 25, 0, 0, 0),
    });
    const snapshot = buildImmutableObligationSnapshot({
      plan: "monthly",
      baseAmountIdr: 179_000,
      discountAmountIdr: 0,
      estimatedChannelFeeIdr: 1_253,
      pricingSource: "default",
      period,
      createdAtMs: Date.UTC(2026, 0, 25, 0, 0, 0),
    });
    expect(snapshot.taxNotice).toBe(NON_PKP_TAX_NOTICE);
    expect(snapshot.noRefundNotice).toBe(NO_REFUND_NOTICE);
    expect(snapshot.nonPkp).toBe(true);
    expect(snapshot.noRefundPolicy).toBe(true);

    const hashA = await computeBillingRequestHash({
      tenantId: "01JTESTTENANTALPHA00000001",
      plan: "monthly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      couponCode: null,
    });
    const hashB = await computeBillingRequestHash({
      tenantId: "01JTESTTENANTALPHA00000001",
      plan: "yearly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      couponCode: null,
    });
    expect(hashA).toHaveLength(64);
    expect(hashA).not.toBe(hashB);
  });
});
