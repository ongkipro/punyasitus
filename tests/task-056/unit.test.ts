import {
  ADVICE_MAX_BACKOFF_MS,
  BillingProviderError,
  BillingValidationError,
  DAY_MS,
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  GRACE_WINDOW_MS,
  LOCKED_WINDOW_MS,
  MAX_ADVICE_BATCH_LIMIT,
  MAX_ADVICE_LEASE_MS,
  MAX_ADVICE_POLLS_CEILING,
  MIN_ADVICE_LEASE_MS,
  clampAdviceBatchLimit,
  clampAdviceLeaseMs,
  clampAdviceMaxPolls,
  computeAdviceNextPollDelayMs,
  computeSettlementEntitlementTransition,
  createMockOnlyVerifiedSettlementPolicy,
  evaluateAdviceSettlement,
  redactBillingLogRecord,
} from "@punyasitus/core/billing/index";
import { describe, expect, it } from "vitest";
import { createAutoLarisClient } from "../../packages/integrations/src/autolaris/index.ts";

const RELAY_ORIGIN = "https://autolaris-relay.punyasitus.com";
const SECRET_API_KEY = "al_live_super_secret_key_never_logged_9876543210";
const NOW_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // 2026-01-31T10:00:00Z

describe("TASK-056 unit — Advice settlement policy, renewal anchors, backoff & redaction", () => {
  it("keeps default production settlement policy UNVERIFIED and blocks settlement grants", () => {
    expect(DEFAULT_PRODUCTION_SETTLEMENT_POLICY.profile).toBe("production_unverified");
    expect(DEFAULT_PRODUCTION_SETTLEMENT_POLICY.realProviderMappingStatus).toBe("UNVERIFIED");
    expect(DEFAULT_PRODUCTION_SETTLEMENT_POLICY.allowSettlementGrant).toBe(false);

    // Even a fully populated mock PAID_SETTLED response MUST fail safely to `review` under default policy!
    const decision = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      observation: {
        rc: "00",
        ket: "Success",
        providerTransactionId: "986770",
        reffId: "PS20260131ABC123",
        paymentStatus: "PAID_SETTLED",
        shippingStatus: null,
        paidAmountIdr: 182_000,
        currency: "IDR",
        settledAtMs: NOW_MS,
      },
      nowMs: NOW_MS,
    });

    expect(decision.kind).toBe("review");
    expect(decision.safeReasonCode).toBe("REAL_PROVIDER_SETTLEMENT_MAPPING_UNVERIFIED");

    // Observed AutoLaris 02/PENDING stays safely pending without erroring or granting
    const pendingDecision = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      observation: {
        rc: "02",
        ket: "PENDING",
        providerTransactionId: null,
        reffId: null,
        paymentStatus: null,
        shippingStatus: null,
        paidAmountIdr: null,
        currency: null,
        settledAtMs: null,
      },
      nowMs: NOW_MS,
    });

    expect(pendingDecision.kind).toBe("pending");
    expect(pendingDecision.safeReasonCode).toBe("PROVIDER_PENDING");
  });

  it("refuses generic rc=00, SUCCESS, BERHASIL, and shipping DELIVERED under mock-only policy", () => {
    // Policy builder itself rejects forbidden generic/shipping statuses
    for (const forbidden of ["00", "OK", "SUCCESS", "SUKSES", "BERHASIL", "DELIVERED", "SHIPPED"]) {
      expect(() =>
        createMockOnlyVerifiedSettlementPolicy({ confirmedPaymentStatuses: [forbidden] }),
      ).toThrow(BillingValidationError);
    }

    const mockPolicy = createMockOnlyVerifiedSettlementPolicy();

    // Generic rc === "00" with empty paymentStatus or generic ket === "Success"
    for (const badObs of [
      { paymentStatus: null, shippingStatus: null, ket: "Success" },
      { paymentStatus: "SUCCESS", shippingStatus: null, ket: "Success" },
      { paymentStatus: "BERHASIL", shippingStatus: null, ket: "Berhasil" },
      { paymentStatus: "00", shippingStatus: null, ket: "OK" },
      { paymentStatus: "DELIVERED", shippingStatus: null, ket: "Delivered" },
      { paymentStatus: null, shippingStatus: "DELIVERED", ket: "Success" },
    ]) {
      const decision = evaluateAdviceSettlement({
        expectedProviderTransactionId: "986770",
        expectedReffId: "PS20260131ABC123",
        expectedTotalPayableIdr: 182_000,
        policy: mockPolicy,
        observation: {
          rc: "00",
          ket: badObs.ket,
          providerTransactionId: "986770",
          reffId: "PS20260131ABC123",
          paymentStatus: badObs.paymentStatus,
          shippingStatus: badObs.shippingStatus,
          paidAmountIdr: 182_000,
          currency: "IDR",
          settledAtMs: NOW_MS,
        },
        nowMs: NOW_MS,
      });

      expect(decision.kind).toBe("review");
      expect(["GENERIC_STATUS_NOT_PAYMENT_PROOF", "SHIPPING_STATUS_NOT_PAYMENT_PROOF"]).toContain(
        decision.safeReasonCode,
      );
    }
  });

  it("confirms settlement ONLY on exact status + transaction_id + reff_id + amount + IDR currency", () => {
    const mockPolicy = createMockOnlyVerifiedSettlementPolicy();
    const baseObservation = {
      rc: "00",
      ket: "Settlement confirmed",
      providerTransactionId: "986770",
      reffId: "PS20260131ABC123",
      paymentStatus: "PAID_SETTLED",
      shippingStatus: null,
      paidAmountIdr: 182_000,
      currency: "IDR",
      settledAtMs: NOW_MS,
    };

    const ok = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: baseObservation,
      nowMs: NOW_MS,
    });
    expect(ok.kind).toBe("confirmed_paid");
    if (ok.kind === "confirmed_paid") {
      expect(ok.verifiedAmountIdr).toBe(182_000);
      expect(ok.verifiedCurrency).toBe("IDR");
      expect(ok.providerTransactionId).toBe("986770");
    }

    // Missing amount -> review
    const noAmount = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, paidAmountIdr: null },
      nowMs: NOW_MS,
    });
    expect(noAmount.kind).toBe("review");
    expect(noAmount.safeReasonCode).toBe("ADVICE_AMOUNT_EVIDENCE_MISSING");

    // Mismatched amount -> review
    const wrongAmount = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, paidAmountIdr: 179_000 },
      nowMs: NOW_MS,
    });
    expect(wrongAmount.kind).toBe("review");
    expect(wrongAmount.safeReasonCode).toBe("ADVICE_AMOUNT_MISMATCH");

    // Missing or mismatched currency -> review
    const missingCurrency = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, currency: null },
      nowMs: NOW_MS,
    });
    expect(missingCurrency.kind).toBe("review");
    expect(missingCurrency.safeReasonCode).toBe("ADVICE_CURRENCY_EVIDENCE_MISSING");

    const usdCurrency = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, currency: "USD" },
      nowMs: NOW_MS,
    });
    expect(usdCurrency.kind).toBe("review");
    expect(usdCurrency.safeReasonCode).toBe("ADVICE_CURRENCY_MISMATCH");

    // Mismatched transaction_id -> review
    const wrongTrx = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, providerTransactionId: "999999" },
      nowMs: NOW_MS,
    });
    expect(wrongTrx.kind).toBe("review");
    expect(wrongTrx.safeReasonCode).toBe("ADVICE_TRANSACTION_ID_MISMATCH");

    // Mismatched reff_id -> review
    const wrongReff = evaluateAdviceSettlement({
      expectedProviderTransactionId: "986770",
      expectedReffId: "PS20260131ABC123",
      expectedTotalPayableIdr: 182_000,
      policy: mockPolicy,
      observation: { ...baseObservation, reffId: "PS-OTHER-REF" },
      nowMs: NOW_MS,
    });
    expect(wrongReff.kind).toBe("review");
    expect(wrongReff.safeReasonCode).toBe("ADVICE_REFF_ID_MISMATCH");
  });

  it("applies PLAN §17.1/§17.2 renewal anchor vectors and preserves manual operator holds", () => {
    // 1. Early renewal on Jan 31 -> Feb 28 (non-leap month-end clamp)
    const jan31 = Date.UTC(2026, 0, 31, 10, 0, 0);
    const activeRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "active",
      operatorHold: false,
      paidThroughMs: jan31,
      trialEndsAtMs: null,
      nowMs: jan31 - 2 * DAY_MS,
    });
    expect(activeRenewal.renewalAnchor).toBe("current_period_end");
    expect(activeRenewal.nextStatus).toBe("active");
    expect(new Date(activeRenewal.nextPaidThroughMs).toISOString()).toBe("2026-02-28T10:00:00.000Z");

    // 2. Leap year Jan 31, 2028 -> Feb 29, 2028
    const jan31Leap = Date.UTC(2028, 0, 31, 10, 0, 0);
    const leapRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "active",
      operatorHold: false,
      paidThroughMs: jan31Leap,
      trialEndsAtMs: null,
      nowMs: jan31Leap - DAY_MS,
    });
    expect(new Date(leapRenewal.nextPaidThroughMs).toISOString()).toBe("2028-02-29T10:00:00.000Z");

    // 3. First payment during active trial preserves remaining trial hours + 1 calendar month
    const trialEnd = Date.UTC(2026, 2, 10, 12, 0, 0);
    const trialUpgrade = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "trial",
      operatorHold: false,
      paidThroughMs: null,
      trialEndsAtMs: trialEnd,
      nowMs: trialEnd - 3 * DAY_MS,
    });
    expect(trialUpgrade.renewalAnchor).toBe("trial_end_preserved");
    expect(new Date(trialUpgrade.nextPaidThroughMs).toISOString()).toBe("2026-04-10T12:00:00.000Z");

    // 4. Grace (H+2) and locked (H+5) extend continuously from paid_through
    const graceRenewal = computeSettlementEntitlementTransition({
      plan: "yearly",
      storedStatus: "grace",
      operatorHold: false,
      paidThroughMs: jan31,
      trialEndsAtMs: null,
      nowMs: jan31 + GRACE_WINDOW_MS - DAY_MS,
    });
    expect(graceRenewal.renewalAnchor).toBe("current_period_end");
    expect(new Date(graceRenewal.nextPaidThroughMs).toISOString()).toBe("2027-01-31T10:00:00.000Z");

    const lockedRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "locked",
      operatorHold: false,
      paidThroughMs: jan31,
      trialEndsAtMs: null,
      nowMs: jan31 + LOCKED_WINDOW_MS - DAY_MS,
    });
    expect(lockedRenewal.renewalAnchor).toBe("current_period_end");
    expect(new Date(lockedRenewal.nextPaidThroughMs).toISOString()).toBe("2026-02-28T10:00:00.000Z");

    // 5. Suspended (H+10) starts fresh from settlement verification time (`nowMs`)
    const suspendedNow = Date.UTC(2026, 2, 15, 8, 0, 0);
    const suspendedRecovery = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: jan31,
      trialEndsAtMs: null,
      nowMs: suspendedNow,
    });
    expect(suspendedRecovery.renewalAnchor).toBe("settlement_time");
    expect(suspendedRecovery.nextStatus).toBe("active");
    expect(new Date(suspendedRecovery.nextPaidThroughMs).toISOString()).toBe("2026-04-15T08:00:00.000Z");

    // 6. Manual operator hold survives confirmed payment (status stays suspended, paidThrough extends)
    const heldRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "suspended",
      operatorHold: true,
      paidThroughMs: jan31,
      trialEndsAtMs: null,
      nowMs: suspendedNow,
    });
    expect(heldRenewal.nextStatus).toBe("suspended");
    expect(heldRenewal.operatorHoldPreserved).toBe(true);
    expect(new Date(heldRenewal.nextPaidThroughMs).toISOString()).toBe("2026-04-15T08:00:00.000Z");
  });

  it("enforces bounded leases, batch caps, poll ceilings, backoff, and log redaction", () => {
    expect(clampAdviceLeaseMs(100)).toBe(MIN_ADVICE_LEASE_MS);
    expect(clampAdviceLeaseMs(999_999)).toBe(MAX_ADVICE_LEASE_MS);
    expect(clampAdviceBatchLimit(0)).toBe(1);
    expect(clampAdviceBatchLimit(999)).toBe(MAX_ADVICE_BATCH_LIMIT);
    expect(clampAdviceMaxPolls(0)).toBe(1);
    expect(clampAdviceMaxPolls(999)).toBe(MAX_ADVICE_POLLS_CEILING);

    expect(computeAdviceNextPollDelayMs(1)).toBe(30_000);
    expect(computeAdviceNextPollDelayMs(2)).toBe(60_000);
    expect(computeAdviceNextPollDelayMs(3)).toBe(120_000);
    expect(computeAdviceNextPollDelayMs(20)).toBe(ADVICE_MAX_BACKOFF_MS);

    const redacted = redactBillingLogRecord({
      event: "billing.advice.test",
      authorization: `Bearer ${SECRET_API_KEY}`,
      autolaris_key: SECRET_API_KEY,
      qrisPayload: "00020101021226680016ID.CO.QRIS.WWW6304ABCD",
      vaNumber: "8779611150001393",
      customer_email: "owner@example.com",
      receiver_phone: "081234567890",
      providerTransactionId: "986770",
      totalPayableIdr: 182_000,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(SECRET_API_KEY);
    expect(serialized).not.toContain("0002010102122668");
    expect(serialized).not.toContain("8779611150001393");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("081234567890");
    expect(redacted.providerTransactionId).toBe("986770");
    expect(redacted.totalPayableIdr).toBe(182_000);
  });

  it("AutoLaris Advice client sends POST /api/h2h/advice with strictly transaction_id and parses errors safely", async () => {
    const calls: { url: string; method: string; body: string; auth: string | null }[] = [];
    const client = createAutoLarisClient({
      relayBaseUrl: RELAY_ORIGIN,
      apiKey: SECRET_API_KEY,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : "",
          auth: headers.get("Authorization"),
        });
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Settlement confirmed",
            data: {
              transaction_id: "986770",
              reff_id: "PSREF001",
              payment_status: "PAID_SETTLED",
              total: "182000",
              currency: "IDR",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    // Rejects empty transaction_id without making any HTTP call
    await expect(client.checkTransactionAdvice({ providerTransactionId: "   " })).rejects.toThrow(
      BillingValidationError,
    );
    expect(calls).toHaveLength(0);

    const obs = await client.checkTransactionAdvice({ providerTransactionId: "986770" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${RELAY_ORIGIN}/api/h2h/advice`);
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({ transaction_id: "986770" });
    expect(obs.rc).toBe("00");
    expect(obs.providerTransactionId).toBe("986770");
    expect(obs.reffId).toBe("PSREF001");
    expect(obs.paymentStatus).toBe("PAID_SETTLED");
    expect(obs.paidAmountIdr).toBe(182_000);
    expect(obs.currency).toBe("IDR");

    // Malformed JSON -> BillingProviderError("invalid_provider_payload") without leaking API key
    const badJsonClient = createAutoLarisClient({
      relayBaseUrl: RELAY_ORIGIN,
      apiKey: SECRET_API_KEY,
      fetchImpl: async () => new Response("<html>502</html>", { status: 200 }),
    });
    await expect(
      badJsonClient.checkTransactionAdvice({ providerTransactionId: "986770" }),
    ).rejects.toMatchObject({
      name: "BillingProviderError",
      kind: "invalid_provider_payload",
      safeFailureCode: "ADVICE_MALFORMED_JSON",
    } satisfies Partial<BillingProviderError>);
  });
});
