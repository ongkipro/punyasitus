import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_ALLOWED_ACTIONS,
  CONSOLE_FORBIDDEN_SENSITIVE_FIELDS,
  OWNER_NON_PKP_DISCLOSURE,
  OWNER_NO_REFUND_DISCLOSURE,
  buildBillingIdempotencyScopeKey,
  buildSafeConsoleAuthHref,
  clearAllTenantBillingIdempotencyKeys,
  clearIdempotencyKey,
  computeCheckoutBreakdown,
  computeYearlySavingsIdr,
  filterOwnerAllowedChannels,
  findSensitiveBillingKeys,
  formatCountdownRemaining,
  formatIdr,
  formatWibDate,
  getOrCreateIdempotencyKey,
  getSafeAutoLarisRedirectHref,
  inspectPaymentReturnQueryParams,
  isConsoleObligationRefundEligible,
  isSafeAutoLarisRedirectUrl,
  parseQrisReadableSummary,
  renderQrisSvgSafely,
  resolveOwnerBillingVisualState,
  validateConsoleAuditReason,
  type ConsoleBillingObligationDto,
  type OwnerBillingAttemptDto,
  type OwnerBillingChannelDto,
  type OwnerBillingObligationDto,
  type StorageLike,
} from "../../apps/web/src/components/admin/billing/helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
  };
}

describe("TASK-057 unit: owner disclosures, pricing, channels, idempotency, QRIS/VA & safety guards", () => {
  it("exposes mandatory pre-creation no-refund and non-PKP disclosures", () => {
    expect(OWNER_NO_REFUND_DISCLOSURE).toContain("tidak dapat dikembalikan");
    expect(OWNER_NO_REFUND_DISCLOSURE).toContain("superadmin");
    expect(OWNER_NO_REFUND_DISCLOSURE).toContain("pembayaran ganda");
    expect(OWNER_NO_REFUND_DISCLOSURE).toContain("salah bayar");

    expect(OWNER_NON_PKP_DISCLOSURE.toLowerCase()).toContain("belum termasuk ppn");
    expect(OWNER_NON_PKP_DISCLOSURE.toLowerCase()).toContain("pkp");
  });

  it("computes exact IDR pricing, yearly savings (12 * monthly - yearly), and WIB coverage period with month-end clamp", () => {
    expect(computeYearlySavingsIdr(179_000, 1_790_000)).toBe(358_000);
    expect(formatIdr(179_000)).toBe("Rp 179.000");
    expect(formatIdr(1_790_000)).toBe("Rp 1.790.000");

    const qris: OwnerBillingChannelDto = {
      code: "QRIS",
      label: "QRIS Nasional",
      kind: "QRIS",
      estimatedFeeIdr: 1_253,
      enabled: true,
    };

    const jan31Utc = Date.UTC(2026, 0, 31, 10, 0, 0);
    const monthly = computeCheckoutBreakdown({
      plan: "monthly",
      pricingPlans: [
        { plan: "monthly", months: 1, baseAmountIdr: 179_000, currency: "IDR", savingsIdr: 0 },
        { plan: "yearly", months: 12, baseAmountIdr: 1_790_000, currency: "IDR", savingsIdr: 358_000 },
      ],
      selectedChannel: qris,
      tenantStatus: "suspended",
      paidThroughIso: null,
      trialEndsAtIso: null,
      nowMs: jan31Utc,
    });

    expect(monthly.baseAmountIdr).toBe(179_000);
    expect(monthly.channelFeeIdr).toBe(1_253);
    expect(monthly.totalPayableIdr).toBe(180_253);
    // Jan 31 + 1 calendar month clamps to Feb 28
    expect(monthly.periodEndAtIso).toBe("2026-02-28T10:00:00.000Z");
    expect(monthly.periodRangeWibLabel).toContain("WIB");
    expect(formatWibDate(monthly.periodEndAtIso)).toContain("2026");

    const yearly = computeCheckoutBreakdown({
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
      tenantStatus: "active",
      paidThroughIso: "2026-01-31T10:00:00.000Z",
      trialEndsAtIso: null,
      nowMs: Date.UTC(2026, 0, 15, 10, 0, 0),
    });

    expect(yearly.baseAmountIdr).toBe(1_790_000);
    expect(yearly.channelFeeIdr).toBe(4_000);
    expect(yearly.totalPayableIdr).toBe(1_794_000);
    expect(yearly.yearlySavingsIdr).toBe(358_000);
    expect(yearly.periodStartAtIso).toBe("2026-01-31T10:00:00.000Z");
    expect(yearly.periodEndAtIso).toBe("2027-01-31T10:00:00.000Z");
  });

  it("filters owner payment channels strictly to enabled QRIS and Bank VA only", () => {
    const raw: OwnerBillingChannelDto[] = [
      { code: "QRIS", label: "QRIS", kind: "QRIS", estimatedFeeIdr: 1_253, enabled: true },
      { code: "VABCA", label: "BCA Virtual Account", kind: "VA", estimatedFeeIdr: 4_000, enabled: true },
      { code: "VAMANDIRI", label: "Mandiri VA", kind: "VA", estimatedFeeIdr: 4_000, enabled: false },
      // Forbidden channel families injected defensively
      { code: "COD", label: "Bayar di Tempat", kind: "VA", estimatedFeeIdr: 0, enabled: true },
      { code: "ALFAMART", label: "Alfamart Retail", kind: "VA", estimatedFeeIdr: 5_000, enabled: true },
      { code: "OVO", label: "OVO E-Wallet", kind: "QRIS", estimatedFeeIdr: 3_000, enabled: true },
      { code: "QRIS", label: "Duplicate QRIS", kind: "QRIS", estimatedFeeIdr: 1_253, enabled: true },
    ];

    const filtered = filterOwnerAllowedChannels(raw);
    expect(filtered.map((c) => c.code)).toEqual(["QRIS", "VABCA"]);
  });

  it("persists deterministic per-obligation Idempotency-Key across refresh/back and mints fresh keys after expiry/settlement", () => {
    const storage = createMemoryStorage();
    const scope = buildBillingIdempotencyScopeKey({
      tenantId: "ten_01JABCDEF1234567890ABCDEF",
      obligationId: "obl_01JABCDEF1234567890ABCDEF",
      plan: "monthly",
      channelCode: "qris",
    });

    const first = getOrCreateIdempotencyKey(scope, storage);
    const second = getOrCreateIdempotencyKey(scope, storage);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);

    clearIdempotencyKey(scope, storage);
    const rotated = getOrCreateIdempotencyKey(scope, storage);
    expect(rotated).not.toBe(first);
    expect(rotated).toMatch(/^[0-9a-f-]{36}$/i);

    // After an obligation expires or settles (activeObligation = null), new cycle gets a distinct scope key -> brand-new UUID!
    const cycle1Scope = buildBillingIdempotencyScopeKey({
      tenantId: "ten_01JABCDEF1234567890ABCDEF",
      obligationId: null,
      latestObligationId: "obl_expired_01",
      paidThroughIso: "2026-01-31T10:00:00.000Z",
      plan: "monthly",
      channelCode: "QRIS",
    });
    const cycle1Key = getOrCreateIdempotencyKey(cycle1Scope, storage);

    const cycle2Scope = buildBillingIdempotencyScopeKey({
      tenantId: "ten_01JABCDEF1234567890ABCDEF",
      obligationId: null,
      latestObligationId: "obl_paid_02",
      paidThroughIso: "2026-02-28T10:00:00.000Z",
      plan: "monthly",
      channelCode: "QRIS",
    });
    const cycle2Key = getOrCreateIdempotencyKey(cycle2Scope, storage);
    expect(cycle2Scope).not.toBe(cycle1Scope);
    expect(cycle2Key).not.toBe(cycle1Key);

    // Clearing all tenant billing keys wipes stored keys cleanly without touching other tenants
    const otherTenantScope = buildBillingIdempotencyScopeKey({
      tenantId: "ten_OTHER_TENANT",
      obligationId: null,
      plan: "monthly",
      channelCode: "QRIS",
    });
    const otherKey = getOrCreateIdempotencyKey(otherTenantScope, storage);
    clearAllTenantBillingIdempotencyKeys("ten_01JABCDEF1234567890ABCDEF", storage);
    expect(storage.getItem(cycle1Scope)).toBeNull();
    expect(storage.getItem(cycle2Scope)).toBeNull();
    expect(storage.getItem(otherTenantScope)).toBe(otherKey);
  });

  it("detects payment-return query params without ever activating service or overriding server state", () => {
    expect(inspectPaymentReturnQueryParams("")).toEqual({
      hasPaymentReturnClaim: false,
      matchedParams: [],
    });

    const claimed = inspectPaymentReturnQueryParams("?status=paid&paid=1&return=success");
    expect(claimed.hasPaymentReturnClaim).toBe(true);
    expect(claimed.matchedParams).toContain("status");
    expect(claimed.matchedParams).toContain("paid");
    expect(claimed.matchedParams).toContain("return");

    // Even with payment-return params in URL, visual state comes strictly from server DB facts
    const state = resolveOwnerBillingVisualState({
      activeObligation: null,
      activeAttempt: null,
      obligations: [],
      providerOutage: false,
      channelsCount: 2,
    });
    expect(state).toBe("ready");
  });

  it("resolves all 6 explicit visual billing states accurately", () => {
    const baseObl: OwnerBillingObligationDto = {
      obligationId: "obl_1",
      plan: "monthly",
      payerKind: "tenant",
      state: "open",
      baseAmountIdr: 179_000,
      discountAmountIdr: 0,
      netAmountIdr: 179_000,
      currency: "IDR",
      periodStartAt: "2026-01-31T10:00:00.000Z",
      periodEndAt: "2026-02-28T10:00:00.000Z",
      version: 1,
      createdAt: "2026-01-31T10:00:00.000Z",
    };
    const makeAttempt = (state: OwnerBillingAttemptDto["state"]): OwnerBillingAttemptDto => ({
      attemptId: "att_1",
      obligationId: "obl_1",
      reffId: "PS260131ABCDEF",
      plan: "monthly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      state,
      baseAmountIdr: 179_000,
      discountAmountIdr: 0,
      channelFeeIdr: 1_253,
      totalPayableIdr: 180_253,
      currency: "IDR",
      taxNotice: OWNER_NON_PKP_DISCLOSURE,
      qrisPayload: "0002010102125910PUNYASITUS6007JAKARTA54061802536304ABCD",
      vaNumber: null,
      bankName: null,
      paymentRedirectUrl: null,
      expiresAt: "2026-02-01T10:00:00.000Z",
      createdAt: "2026-01-31T10:00:00.000Z",
    });

    expect(
      resolveOwnerBillingVisualState({
        activeObligation: baseObl,
        activeAttempt: makeAttempt("pending"),
        obligations: [baseObl],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("pending");

    expect(
      resolveOwnerBillingVisualState({
        activeObligation: baseObl,
        activeAttempt: makeAttempt("creation_unknown"),
        obligations: [baseObl],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("creation_unknown");

    expect(
      resolveOwnerBillingVisualState({
        activeObligation: baseObl,
        activeAttempt: makeAttempt("expired"),
        obligations: [baseObl],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("expired");

    expect(
      resolveOwnerBillingVisualState({
        tenantStatus: "active",
        operatorHold: false,
        paidThroughIso: "2026-02-28T10:00:00.000Z",
        nowMs: Date.UTC(2026, 1, 1, 10, 0, 0),
        activeObligation: { ...baseObl, state: "paid" },
        activeAttempt: makeAttempt("paid"),
        obligations: [{ ...baseObl, state: "paid" }],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("paid");

    // R3 regression guard: historical paid obligation MUST NEVER show "paid" banner when tenant is now grace/locked/suspended/recovery/held!
    for (const nonActiveStatus of ["grace", "locked", "suspended", "recovery", "trial"] as const) {
      expect(
        resolveOwnerBillingVisualState({
          tenantStatus: nonActiveStatus,
          operatorHold: false,
          paidThroughIso: "2026-01-20T10:00:00.000Z",
          nowMs: Date.UTC(2026, 1, 1, 10, 0, 0),
          activeObligation: null,
          activeAttempt: null,
          obligations: [{ ...baseObl, state: "paid" }],
          providerOutage: false,
          channelsCount: 2,
        }),
        `Status ${nonActiveStatus} with prior paid obligation must NOT show paid banner`,
      ).toBe("ready");
    }
    expect(
      resolveOwnerBillingVisualState({
        tenantStatus: "active",
        operatorHold: true,
        paidThroughIso: "2026-02-28T10:00:00.000Z",
        nowMs: Date.UTC(2026, 1, 1, 10, 0, 0),
        activeObligation: null,
        activeAttempt: null,
        obligations: [{ ...baseObl, state: "paid" }],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("ready");

    expect(
      resolveOwnerBillingVisualState({
        activeObligation: { ...baseObl, state: "review" },
        activeAttempt: makeAttempt("review"),
        obligations: [{ ...baseObl, state: "review" }],
        providerOutage: false,
        channelsCount: 2,
      }),
    ).toBe("review");

    expect(
      resolveOwnerBillingVisualState({
        activeObligation: null,
        activeAttempt: null,
        obligations: [],
        providerOutage: true,
        channelsCount: 0,
      }),
    ).toBe("provider_outage");
  });

  it("renders crisp deterministic QRIS SVG, parses EMVCo readable summary, validates redirect URLs, and formats countdown", () => {
    const qrisPayload = "0002010102125910PUNYASITUS6007JAKARTA54061802536304ABCD";
    const rendered = renderQrisSvgSafely(qrisPayload);
    expect(rendered.svg).toContain("<svg");
    expect(rendered.svg).toContain('role="img"');
    expect(rendered.svg).toContain("Kode QRIS pembayaran langganan PunyaSitus");
    expect(rendered.summary).toEqual({
      merchantName: "PUNYASITUS",
      merchantCity: "JAKARTA",
      amountHint: "180253",
      crc: "ABCD",
    });

    // Oversized payload gracefully falls back without throwing
    const huge = renderQrisSvgSafely("0".repeat(400));
    expect(huge.svg).toBeNull();
    expect(huge.payload.length).toBe(400);
    expect(parseQrisReadableSummary(qrisPayload).merchantName).toBe("PUNYASITUS");

    // Approved AutoLaris HTTPS redirect URLs only (via shared validateApprovedPaymentRedirectUrl)
    expect(isSafeAutoLarisRedirectUrl("https://pay.autolaris.com/trx/123")).toBe(true);
    expect(getSafeAutoLarisRedirectHref("  https://autolaris.com/pay/123  ")).toBe(
      "https://autolaris.com/pay/123",
    );
    expect(isSafeAutoLarisRedirectUrl("https://user:pass@pay.autolaris.com/trx/123")).toBe(false);
    expect(isSafeAutoLarisRedirectUrl("http://pay.autolaris.com/trx/123")).toBe(false);
    expect(isSafeAutoLarisRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAutoLarisRedirectUrl("https://evil-autolaris.com/phish")).toBe(false);

    // Console refund eligibility & safe step-up auth URL helper
    const baseConsoleObl: ConsoleBillingObligationDto = {
      obligationId: "obl_c1",
      tenantId: "ten_1",
      tenantHandle: "toko-1",
      tenantStatus: "active",
      operatorHold: false,
      payerType: "tenant",
      plan: "monthly",
      state: "open",
      dbStatus: "open",
      reviewRequired: false,
      baseAmountIdr: 179_000,
      discountAmountIdr: 0,
      netAmountIdr: 179_000,
      currency: "IDR",
      paidAt: null,
      createdAt: "2026-01-31T10:00:00.000Z",
      settlementId: null,
      grantCount: 0,
      latestAttempt: null,
    };
    expect(isConsoleObligationRefundEligible(baseConsoleObl)).toBe(false);
    expect(isConsoleObligationRefundEligible({ ...baseConsoleObl, state: "expired", dbStatus: "expired" })).toBe(false);
    expect(isConsoleObligationRefundEligible({ ...baseConsoleObl, state: "paid", dbStatus: "paid", settlementId: "stl_1" })).toBe(true);
    expect(isConsoleObligationRefundEligible({ ...baseConsoleObl, state: "review", reviewRequired: true })).toBe(true);

    expect(buildSafeConsoleAuthHref("/auth/two-factor?mode=verify", "/console/billing")).toBe(
      "/auth/two-factor?mode=verify&next=%2Fconsole%2Fbilling",
    );
    expect(buildSafeConsoleAuthHref("/auth/two-factor", "/console/billing")).toBe(
      "/auth/two-factor?next=%2Fconsole%2Fbilling",
    );
    expect(buildSafeConsoleAuthHref("https://evil.example/auth/two-factor", "/console/billing")).toBeNull();
    expect(buildSafeConsoleAuthHref("//evil.example/auth/two-factor", "/console/billing")).toBeNull();
    expect(buildSafeConsoleAuthHref("/console/operators", "/console/billing")).toBeNull();

    // Expiry countdown formatting
    const baseMs = Date.UTC(2026, 0, 31, 10, 0, 0);
    expect(formatCountdownRemaining(new Date(baseMs + 3661_000).toISOString(), baseMs)).toBe(
      "01:01:01",
    );
    expect(formatCountdownRemaining(new Date(baseMs - 1000).toISOString(), baseMs)).toBe(
      "Batas waktu berakhir",
    );
  });

  it("enforces console audit reason rules, redacted field guard, and zero arbitrary paid actions", () => {
    expect(validateConsoleAuditReason("pendek").ok).toBe(false);
    expect(validateConsoleAuditReason("Verifikasi manual pembayaran ganda QRIS #102").ok).toBe(true);
    expect(validateConsoleAuditReason("x".repeat(501)).ok).toBe(false);

    expect(CONSOLE_ALLOWED_ACTIONS).toEqual(["advice_recheck", "record_refund"]);
    expect(CONSOLE_FORBIDDEN_SENSITIVE_FIELDS).toContain("qrisPayload");
    expect(CONSOLE_FORBIDDEN_SENSITIVE_FIELDS).toContain("vaNumber");

    expect(
      findSensitiveBillingKeys({
        obligationId: "obl_1",
        latestAttempt: { reffId: "PS123", state: "pending" },
      }),
    ).toEqual([]);
    expect(
      findSensitiveBillingKeys({
        obligationId: "obl_1",
        latestAttempt: { qrisPayload: "000201...", vaNumber: "88001234" },
      }),
    ).toEqual(["latestAttempt.qrisPayload", "latestAttempt.vaNumber"]);
  });

  it("enforces zero @radix-ui/*, zero asChild, zero arbitrary paid toggle, and member isolation across TASK-057 UI files", () => {
    const taskFiles = [
      "apps/web/src/components/admin/billing/helpers.ts",
      "apps/web/src/components/admin/billing/OwnerBillingPanel.tsx",
      "apps/web/src/components/admin/billing/MemberBillingNotice.tsx",
      "apps/web/src/components/admin/billing/index.ts",
      "apps/web/src/pages/dashboard/[handle]/billing/index.astro",
      "apps/web/src/pages/dashboard/[handle]/service-status/index.astro",
      "apps/web/src/pages/console/billing/index.astro",
      "apps/web/src/pages/console/billing/_ConsoleBillingPanel.tsx",
    ];

    for (const rel of taskFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, `${rel} must not import @radix-ui/*`).not.toMatch(/@radix-ui\//);
      expect(src, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
    }

    const consolePanelSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/pages/console/billing/_ConsoleBillingPanel.tsx"),
      "utf8",
    );
    expect(consolePanelSrc).not.toMatch(/\bmarkPaid\b|\bforcePaid\b|Tandai Lunas/i);

    const consolePageSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/pages/console/billing/index.astro"),
      "utf8",
    );
    expect(consolePageSrc).toContain(
      "Console Operasional Platform — Akses istimewa — bukan penyamaran akun tenant",
    );

    const memberNoticeSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/components/admin/billing/MemberBillingNotice.tsx"),
      "utf8",
    );
    expect(memberNoticeSrc).toContain("Hubungi pemilik situs");
    expect(memberNoticeSrc).not.toContain("/billing/obligations");
    expect(memberNoticeSrc).not.toContain("Buat Instruksi");
  });
});
