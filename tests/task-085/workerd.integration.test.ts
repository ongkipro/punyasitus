import { env } from "cloudflare:workers";
import {
  AFFILIATE_COMMISSION_DAY_MS,
  AFFILIATE_COMMISSION_SETTINGS_KEY,
  AFFILIATE_PAYOUT_MINIMUM_IDR,
} from "@punyasitus/core/affiliates/commission";
import { createMockOnlyVerifiedSettlementPolicy } from "@punyasitus/core/billing/index";
import {
  applyAffiliateMigrations,
  markTenantAttributionExcluded,
} from "@punyasitus/db/affiliates/index";
import {
  AffiliateLedgerError,
  applyAffiliateCommissionLedgerMigrations,
  buildBiMonthlyAffiliatePayoutBatches,
  getAffiliateCommissionBalanceSummary,
  listAffiliateCommissionEntries,
  listAffiliatePayoutBatches,
  markAffiliatePayoutBatchPaid,
  promoteMaturedPendingCommissions,
  recordConfirmedPaymentCommission,
  reverseCommissionForRefund,
} from "@punyasitus/db/affiliates/ledger/index";
import {
  beginDurablePaymentAttempt,
  completePaymentAttemptPending,
  ensureBillingReconciliationSchema,
} from "@punyasitus/db/billing/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import { listPlatformAuditEntries, PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AFFILIATE_HOLD_PROMOTION_CRON_TOPIC,
  AFFILIATE_PAYOUT_BATCH_CRON_TOPIC,
  createAffiliatePayoutCronJobRegistry,
  runAffiliateHoldPromotionSweep,
  runBiMonthlyAffiliatePayoutBatchSweep,
} from "../../apps/web/src/worker/cron/affiliate-payouts.ts";
import {
  BILLING_AFFILIATE_COMMISSION_TOPIC,
  reconcilePaymentAttemptViaAdvice,
  recordAffiliateCommissionForSettledPayment,
} from "../../apps/web/src/worker/queues/billing/index.ts";
import { createAutoLarisClient } from "../../packages/integrations/src/autolaris/index.ts";

const BASE_NOW_MS = Date.UTC(2026, 9, 25, 10, 0, 0); // 2026-10-25T10:00:00Z (17:00 WIB)
const MOCK_POLICY = createMockOnlyVerifiedSettlementPolicy();

async function resetTables(): Promise<void> {
  await env.PLATFORM_DB.prepare(
    "DROP TRIGGER IF EXISTS test_fail_platform_audit_insert_t085",
  ).run();
  await env.PLATFORM_DB.prepare(
    "DROP TRIGGER IF EXISTS affiliate_commission_entries_paid_no_delete",
  ).run();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_commission_entries"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_commission_payout_batches"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_funnel_visits"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_powered_by_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_attribution_exclusions"),
    env.PLATFORM_DB.prepare("DELETE FROM user_payout_identities"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_enrollment_profiles"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_commissions"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_payout_batches"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_refund_records"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_reconciliation_leases"),
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliates"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
  await env.PLATFORM_DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS affiliate_commission_entries_paid_no_delete
     BEFORE DELETE ON affiliate_commission_entries
     WHEN OLD.status IN ('paid', 'batched')
     BEGIN
       SELECT RAISE(ABORT, 'AFFILIATE_COMMISSION_DELETE_FORBIDDEN');
     END`,
  ).run();
}

async function seedUser(id: string, email: string, name: string): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, ?, ?)`,
  )
    .bind(id, name, email, BASE_NOW_MS, BASE_NOW_MS)
    .run();
}

async function seedOperator(userId: string): Promise<void> {
  await seedUser(userId, `${userId}@punyasitus.com`, "Operator Finance");
  await env.PLATFORM_DB.prepare(
    `INSERT INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
     VALUES (?, ?, 'Operator keuangan aktif untuk TASK-085.', ?, NULL)`,
  )
    .bind(userId, userId, BASE_NOW_MS)
    .run();
}

async function seedAffiliate(params: {
  readonly id: string;
  readonly userId: string;
  readonly code: string;
  readonly status?: "pending" | "active" | "suspended" | "rejected";
}): Promise<void> {
  await seedUser(params.userId, `${params.userId}@example.com`, `Affiliate ${params.code}`);
  await env.PLATFORM_DB.prepare(
    `INSERT INTO affiliates (id, user_id, referral_code, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(params.id, params.userId, params.code, params.status ?? "active", BASE_NOW_MS, BASE_NOW_MS)
    .run();
}

async function seedTenant(params: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly status?: "trial" | "active";
  readonly affiliateId?: string | null;
  readonly referralCode?: string | null;
  readonly agencyId?: string | null;
  readonly orgMetadata?: Record<string, unknown> | null;
}): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO organizations (id, name, slug, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      params.orgId,
      `Org ${params.handle}`,
      params.handle,
      params.orgMetadata ? JSON.stringify(params.orgMetadata) : null,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();

  await env.PLATFORM_DB.prepare(
    `INSERT INTO tenants (
       id, organization_id, agency_id, referred_by_affiliate_id,
       handle, name, vertical, status, trial_ends_at,
       cache_version, schema_version, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'compro', ?, ?, 1, 1, 1, ?, ?)`,
  )
    .bind(
      params.id,
      params.orgId,
      params.agencyId ?? null,
      params.affiliateId ?? null,
      params.handle,
      `Site ${params.handle}`,
      params.status ?? "active",
      BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();

  if (params.affiliateId) {
    await env.PLATFORM_DB.prepare(
      `INSERT INTO affiliate_referrals (
         tenant_id, affiliate_id, referral_code, attribution_source,
         attributed_at, locked, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'cookie', ?, 1, 1, ?, ?)`,
    )
      .bind(
        params.id,
        params.affiliateId,
        params.referralCode ?? "REF_CODE",
        BASE_NOW_MS,
        BASE_NOW_MS,
        BASE_NOW_MS,
      )
      .run();
  }
}

async function seedConfirmedSettlement(params: {
  readonly tenantId: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly settlementId: string;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr?: number;
  readonly channelFeeIdr?: number;
  readonly payerType?: "tenant" | "agency";
  readonly payerAgencyId?: string | null;
  readonly settledAtMs?: number;
}): Promise<void> {
  const discount = params.discountAmountIdr ?? 0;
  const channelFee = params.channelFeeIdr ?? 0;
  const net = Math.max(0, params.baseAmountIdr - discount);
  const totalPayable = net + channelFee;
  const settledAt = params.settledAtMs ?? BASE_NOW_MS;

  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO billing_obligations (
         id, tenant_id, payer_type, payer_agency_id, plan_interval, status,
         gross_amount_idr, discount_amount_idr, net_amount_idr,
         due_at, paid_at, review_required, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'monthly', 'paid', ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).bind(
      params.obligationId,
      params.tenantId,
      params.payerType ?? "tenant",
      params.payerAgencyId ?? null,
      params.baseAmountIdr,
      discount,
      net,
      settledAt,
      settledAt,
      settledAt,
      settledAt,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO payment_attempts (
         id, obligation_id, tenant_id, channel, provider, provider_transaction_id,
         amount_idr, state, lifecycle_state, base_amount_idr, discount_amount_idr,
         channel_fee_idr, total_payable_idr, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'QRIS', 'autolaris', ?, ?, 'settled', 'paid', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      params.attemptId,
      params.obligationId,
      params.tenantId,
      `trx_${params.attemptId}`,
      totalPayable,
      params.baseAmountIdr,
      discount,
      channelFee,
      totalPayable,
      settledAt,
      settledAt,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT INTO settlements (
         id, obligation_id, payment_attempt_id, tenant_id,
         amount_idr, settled_at, reconciled_via, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'advice', ?)`,
    ).bind(
      params.settlementId,
      params.obligationId,
      params.attemptId,
      params.tenantId,
      totalPayable,
      settledAt,
      settledAt,
    ),
  ]);
}

describe("TASK-085 workerd + D1 affiliate commission ledger & payout batches", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => BASE_NOW_MS);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB, () => BASE_NOW_MS);
    await applyAffiliateMigrations(env.PLATFORM_DB, () => BASE_NOW_MS);
    await applyAffiliateCommissionLedgerMigrations(env.PLATFORM_DB, () => BASE_NOW_MS);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("records exact integer IDR 60% first payment and 20% renewals on net discounted base (excluding coupons, PPN, channel fee), with floor rounding and platform_settings snapshot", async () => {
    await seedAffiliate({ id: "aff_1", userId: "usr_aff_1", code: "MITRA01" });
    await seedTenant({
      id: "ten_1",
      orgId: "org_1",
      handle: "toko-satu",
      affiliateId: "aff_1",
      referralCode: "MITRA01",
    });

    // 1st payment: base Rp 179.001, coupon Rp 20.000, channel fee Rp 4.000 -> net base Rp 159.001
    // 60% floor(159_001 * 6000 / 10_000) = floor(95_400.6) = 95_400 IDR!
    await seedConfirmedSettlement({
      tenantId: "ten_1",
      obligationId: "obl_1",
      attemptId: "att_1",
      settlementId: "stl_1",
      baseAmountIdr: 179_001,
      discountAmountIdr: 20_000,
      channelFeeIdr: 4_000,
      settledAtMs: BASE_NOW_MS,
    });

    const firstRes = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_1",
      settlementId: "stl_1",
      paymentAttemptId: "att_1",
      obligationId: "obl_1",
      nowMs: BASE_NOW_MS,
    });
    expect(firstRes.status).toBe("created");
    if (firstRes.status !== "created") throw new Error("expected created");

    expect(firstRes.entry.entryKind).toBe("first_payment");
    expect(firstRes.entry.netBaseIdr).toBe(159_001);
    expect(firstRes.entry.channelFeeIdr).toBe(4_000);
    expect(firstRes.entry.discountAmountIdr).toBe(20_000);
    expect(firstRes.entry.rateBps).toBe(6000);
    expect(firstRes.entry.commissionIdr).toBe(95_400);
    expect(firstRes.entry.status).toBe("pending");
    expect(firstRes.entry.holdUntilAt).toBe(BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS);

    // 2nd payment (renewal): base Rp 179.001, no coupon, PPN Rp 10.000, channel fee Rp 4.000
    // Explicit gross = 179_001 + 10_000 + 4_000 = 193_001 -> net base = 179_001
    // 20% floor(179_001 * 2000 / 10_000) = floor(35_800.2) = 35_800 IDR!
    const renewalAt = BASE_NOW_MS + 30 * AFFILIATE_COMMISSION_DAY_MS;
    await seedConfirmedSettlement({
      tenantId: "ten_1",
      obligationId: "obl_2",
      attemptId: "att_2",
      settlementId: "stl_2",
      baseAmountIdr: 179_001,
      channelFeeIdr: 4_000,
      settledAtMs: renewalAt,
    });

    const secondRes = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_1",
      settlementId: "stl_2",
      paymentAttemptId: "att_2",
      obligationId: "obl_2",
      grossAmountIdr: 193_001,
      discountAmountIdr: 0,
      ppnAmountIdr: 10_000,
      channelFeeIdr: 4_000,
      confirmedAtMs: renewalAt,
      nowMs: renewalAt,
    });
    expect(secondRes.status).toBe("created");
    if (secondRes.status !== "created") throw new Error("expected created");

    expect(secondRes.entry.entryKind).toBe("renewal");
    expect(secondRes.entry.netBaseIdr).toBe(179_001);
    expect(secondRes.entry.ppnAmountIdr).toBe(10_000);
    expect(secondRes.entry.rateBps).toBe(2000);
    expect(secondRes.entry.commissionIdr).toBe(35_800);

    // 3rd payment with custom snapshotted platform_settings rates (e.g. renewal changed to 25% = 2500 bps)
    await env.PLATFORM_DB.prepare(
      `INSERT INTO platform_settings (key, value_json, version, updated_at)
       VALUES (?, ?, 1, ?)`,
    )
      .bind(
        AFFILIATE_COMMISSION_SETTINGS_KEY,
        JSON.stringify({ firstPaymentRateBps: 5000, renewalRateBps: 2500 }),
        renewalAt + 1000,
      )
      .run();

    const thirdRes = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_1",
      receiptId: "rcp_3",
      grossAmountIdr: 179_000,
      confirmedAtMs: renewalAt + 2000,
      nowMs: renewalAt + 2000,
    });
    expect(thirdRes.status).toBe("created");
    if (thirdRes.status !== "created") throw new Error("expected created");

    expect(thirdRes.entry.entryKind).toBe("renewal");
    expect(thirdRes.entry.rateBps).toBe(2500);
    expect(thirdRes.entry.commissionIdr).toBe(44_750); // 179_000 * 25%
    expect(JSON.parse(thirdRes.entry.settingsSnapshotJson)).toMatchObject({
      firstPaymentRateBps: 5000,
      renewalRateBps: 2500,
      source: "platform_settings",
    });

    // Earlier entries keep their snapshotted rates untouched
    const entries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      affiliateId: "aff_1",
    });
    expect(entries).toHaveLength(3);
  });

  it("enforces strict duplicate delivery idempotency and prevents concurrent invoices from both earning 60%", async () => {
    await seedAffiliate({ id: "aff_dup", userId: "usr_aff_dup", code: "DUP01" });
    await seedTenant({
      id: "ten_dup",
      orgId: "org_dup",
      handle: "toko-dup",
      affiliateId: "aff_dup",
      referralCode: "DUP01",
    });

    await seedConfirmedSettlement({
      tenantId: "ten_dup",
      obligationId: "obl_d1",
      attemptId: "att_d1",
      settlementId: "stl_d1",
      baseAmountIdr: 179_000,
      channelFeeIdr: 4_000,
    });

    // Fire 4 concurrent duplicate settlement deliveries for the exact same invoice
    const dupResults = await Promise.all([
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_dup",
        settlementId: "stl_d1",
        paymentAttemptId: "att_d1",
        nowMs: BASE_NOW_MS,
      }),
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_dup",
        settlementId: "stl_d1",
        paymentAttemptId: "att_d1",
        nowMs: BASE_NOW_MS,
      }),
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_dup",
        settlementId: "stl_d1",
        paymentAttemptId: "att_d1",
        nowMs: BASE_NOW_MS,
      }),
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_dup",
        settlementId: "stl_d1",
        paymentAttemptId: "att_d1",
        nowMs: BASE_NOW_MS,
      }),
    ]);

    const createdCount = dupResults.filter((r) => r.status === "created").length;
    const duplicateCount = dupResults.filter((r) => r.status === "duplicate").length;
    expect(createdCount).toBe(1);
    expect(duplicateCount).toBe(3);

    const rows = await listAffiliateCommissionEntries(env.PLATFORM_DB, { tenantId: "ten_dup" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commissionIdr).toBe(107_400);

    // Exactly ONE platform_audit entry for the single created commission
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "affiliate.commission.recorded",
      tenantId: "ten_dup",
    });
    expect(audits).toHaveLength(1);

    // Now test concurrent race between two DIFFERENT invoices for a brand-new referred tenant
    await seedTenant({
      id: "ten_race",
      orgId: "org_race",
      handle: "toko-race",
      affiliateId: "aff_dup",
      referralCode: "DUP01",
    });
    const raceResults = await Promise.all([
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_race",
        receiptId: "rcp_race_1",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_race",
        receiptId: "rcp_race_2",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS + 1,
      }),
    ]);
    expect(raceResults.every((r) => r.status === "created")).toBe(true);
    const raceEntries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      tenantId: "ten_race",
    });
    expect(raceEntries).toHaveLength(2);
    expect(raceEntries.filter((e) => e.entryKind === "first_payment")).toHaveLength(1);
    expect(raceEntries.filter((e) => e.entryKind === "renewal")).toHaveLength(1);
  });

  it("records ZERO commission for ineligible payments (trial, complimentary, zero net base, agency, demo, platform, unconfirmed, unreferred, suspended affiliate)", async () => {
    await seedAffiliate({ id: "aff_act", userId: "usr_aff_act", code: "ACTIVE01", status: "active" });
    await seedAffiliate({
      id: "aff_susp",
      userId: "usr_aff_susp",
      code: "SUSP01",
      status: "suspended",
    });

    // Normal referred tenant
    await seedTenant({
      id: "ten_ok",
      orgId: "org_ok",
      handle: "toko-ok",
      affiliateId: "aff_act",
      referralCode: "ACTIVE01",
    });
    // Unreferred tenant
    await seedTenant({ id: "ten_unref", orgId: "org_unref", handle: "toko-unref" });
    // Suspended affiliate tenant
    await seedTenant({
      id: "ten_susp",
      orgId: "org_susp",
      handle: "toko-susp",
      affiliateId: "aff_susp",
      referralCode: "SUSP01",
    });
    // Agency-managed tenant
    await seedUser("usr_ag", "ag@example.com", "Agency Owner");
    await env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_ag', 'Agency Org', 'ag-org', ?, ?)`,
    )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO agencies (id, organization_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ('ag_1', 'org_ag', 'usr_ag', 'Agensi Satu', 'active', ?, ?)`,
    )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await seedTenant({
      id: "ten_ag",
      orgId: "org_ten_ag",
      handle: "toko-ag",
      agencyId: "ag_1",
      affiliateId: "aff_act",
    });
    // Demo tenant
    await seedTenant({
      id: "ten_demo",
      orgId: "org_demo",
      handle: "toko-demo",
      affiliateId: "aff_act",
      orgMetadata: { isDemo: true },
    });
    // Platform-excluded tenant
    await seedTenant({
      id: "ten_plat",
      orgId: "org_plat",
      handle: "toko-plat",
      affiliateId: "aff_act",
    });
    await markTenantAttributionExcluded(env.PLATFORM_DB, {
      tenantId: "ten_plat",
      exclusionKind: "platform",
      nowMs: BASE_NOW_MS,
    });

    const cases = [
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ok",
        receiptId: "rcp_trial",
        grossAmountIdr: 179_000,
        paymentKind: "trial",
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ok",
        receiptId: "rcp_comp",
        grossAmountIdr: 179_000,
        paymentKind: "complimentary",
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ok",
        receiptId: "rcp_anom",
        grossAmountIdr: 179_000,
        paymentKind: "anomaly",
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ok",
        receiptId: "rcp_unconf",
        grossAmountIdr: 179_000,
        isConfirmed: false,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ok",
        receiptId: "rcp_zero",
        grossAmountIdr: 179_000,
        discountAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_unref",
        receiptId: "rcp_unref",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_susp",
        receiptId: "rcp_susp",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_ag",
        receiptId: "rcp_ag",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_demo",
        receiptId: "rcp_demo",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
      await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
        tenantId: "ten_plat",
        receiptId: "rcp_plat",
        grossAmountIdr: 179_000,
        nowMs: BASE_NOW_MS,
      }),
    ];

    expect(cases.every((c) => c.status === "ineligible")).toBe(true);
    expect(cases.map((c) => (c.status === "ineligible" ? c.reason : ""))).toEqual([
      "trial_payment",
      "complimentary_payment",
      "anomaly_payment",
      "unconfirmed_payment",
      "zero_net_base",
      "unreferred_tenant",
      "affiliate_not_active",
      "agency_managed_tenant",
      "ineligible_demo",
      "ineligible_platform",
    ]);

    const allEntries = await listAffiliateCommissionEntries(env.PLATFORM_DB);
    expect(allEntries).toHaveLength(0);
  });

  it("enforces frozen-time 14-day hold promotion and skips suspended affiliates", async () => {
    await seedAffiliate({ id: "aff_h1", userId: "usr_h1", code: "HOLD01", status: "active" });
    await seedAffiliate({ id: "aff_h2", userId: "usr_h2", code: "HOLD02", status: "active" });
    await seedTenant({
      id: "ten_h1",
      orgId: "org_h1",
      handle: "toko-h1",
      affiliateId: "aff_h1",
      referralCode: "HOLD01",
    });
    await seedTenant({
      id: "ten_h2",
      orgId: "org_h2",
      handle: "toko-h2",
      affiliateId: "aff_h2",
      referralCode: "HOLD02",
    });

    const c1 = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_h1",
      receiptId: "rcp_h1",
      grossAmountIdr: 179_000,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    const c2 = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_h2",
      receiptId: "rcp_h2",
      grossAmountIdr: 179_000,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    expect(c1.status).toBe("created");
    expect(c2.status).toBe("created");

    // Suspend affiliate 2 during the 14-day hold window
    await env.PLATFORM_DB.prepare("UPDATE affiliates SET status = 'suspended' WHERE id = 'aff_h2'")
      .run();

    // At 13d 23h 59m -> MUST stay `pending`
    const beforeMatureMs = BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS - 60_000;
    const sweepEarly = await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
      nowMs: beforeMatureMs,
    });
    expect(sweepEarly.promotedCount).toBe(0);
    expect(sweepEarly.skippedSuspendedCount).toBe(0);

    // At exact 14d 00h 00m -> active affiliate promotes to `approved`; suspended affiliate stays `pending`
    const exactMatureMs = BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS;
    const sweepMature = await runAffiliateHoldPromotionSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: exactMatureMs, logger: () => {} },
    );
    expect(sweepMature.promotedCount).toBe(1);
    expect(sweepMature.skippedSuspendedCount).toBe(1);
    expect(sweepMature.entries[0]?.status).toBe("approved");
    expect(sweepMature.entries[0]?.approvedAt).toBe(exactMatureMs);

    // Suspended affiliate entry remains pending
    const suspEntries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      affiliateId: "aff_h2",
    });
    expect(suspEntries[0]?.status).toBe("pending");

    // Re-running promotion sweep is strictly idempotent
    const sweepRepeat = await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
      nowMs: exactMatureMs + 5000,
    });
    expect(sweepRepeat.promotedCount).toBe(0);
    expect(sweepRepeat.skippedSuspendedCount).toBe(1);
  });

  it("handles pre-payout refund reversals idempotently AND post-payout refunds via immutable paid entry + negative reversal_offset", async () => {
    await seedOperator("op_fin_1");
    await seedAffiliate({ id: "aff_ref", userId: "usr_aff_ref", code: "REFUND01" });
    await seedTenant({
      id: "ten_r1",
      orgId: "org_r1",
      handle: "toko-r1",
      affiliateId: "aff_ref",
      referralCode: "REFUND01",
    });
    await seedTenant({
      id: "ten_r2",
      orgId: "org_r2",
      handle: "toko-r2",
      affiliateId: "aff_ref",
      referralCode: "REFUND01",
    });
    await seedTenant({
      id: "ten_r3",
      orgId: "org_r3",
      handle: "toko-r3",
      affiliateId: "aff_ref",
      referralCode: "REFUND01",
    });

    // --- PART A: Pre-payout refund (`pending` -> `reversed`) ---
    const pendingComm = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r1",
      receiptId: "rcp_pre_1",
      grossAmountIdr: 179_000,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    expect(pendingComm.status).toBe("created");

    const preRev1 = await reverseCommissionForRefund(env.PLATFORM_DB, {
      receiptId: "rcp_pre_1",
      refundReference: "rfd_pre_001",
      reason: "Refund pembayaran ganda sebelum payout diproses",
      nowMs: BASE_NOW_MS + 1000,
    });
    expect(preRev1.status).toBe("reversed");
    if (preRev1.status !== "reversed") throw new Error("expected reversed");
    expect(preRev1.mode).toBe("pre_payout_reversed");
    expect(preRev1.originalEntry.status).toBe("reversed");

    // Duplicate pre-payout refund is 100% idempotent
    const preRevDup = await reverseCommissionForRefund(env.PLATFORM_DB, {
      receiptId: "rcp_pre_1",
      refundReference: "rfd_pre_001",
      reason: "Refund pembayaran ganda sebelum payout diproses",
      nowMs: BASE_NOW_MS + 2000,
    });
    expect(preRevDup.status).toBe("already_reversed");
    if (preRevDup.status !== "already_reversed") throw new Error("expected already_reversed");
    expect(preRevDup.mode).toBe("pre_payout_reversed");

    // --- PART B: Post-payout refund (`paid` stays immutable + ONE negative `reversal_offset`) ---
    const paidComm = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r2",
      receiptId: "rcp_post_1",
      grossAmountIdr: 179_000, // 60% = 107_400 >= Rp 100.000
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    expect(paidComm.status).toBe("created");
    if (paidComm.status !== "created") throw new Error("expected created");

    // Mature after 14 days
    const matureAt = BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS;
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: matureAt });

    // Batch on 2026-11-15 WIB (`2026-11-14T17:00:00Z`)
    const nov15Wib = Date.UTC(2026, 10, 14, 17, 0, 0);
    const batchRes1 = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: nov15Wib,
    });
    expect(batchRes1.createdBatchCount).toBe(1);
    const batch1 = batchRes1.batches[0]!;
    expect(batch1.totalAmountIdr).toBe(107_400);

    // Operator marks batch paid -> entry becomes immutable `paid`
    const paidBatchRes = await markAffiliatePayoutBatchPaid(env.PLATFORM_DB, {
      batchId: batch1.id,
      actorUserId: "op_fin_1",
      transferReference: "BCA-TRF-20261115-001",
      reason: "Transfer manual payout afiliasi periode 15 November 2026",
      expectedVersion: 1,
      nowMs: nov15Wib + 3_600_000,
    });
    expect(paidBatchRes.batch.status).toBe("paid");
    expect(paidBatchRes.paidEntryCount).toBe(1);

    // Confirm DB trigger prevents mutating a `paid` commission entry
    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE affiliate_commission_entries SET status = 'reversed' WHERE id = ?",
      )
        .bind(paidComm.entry.id)
        .run(),
    ).rejects.toThrow(/PAID_COMMISSION_ENTRY_IMMUTABLE/);

    // Post-payout refund creates strictly ONE negative `reversal_offset` (-107_400, status = 'approved')
    const postRev = await reverseCommissionForRefund(env.PLATFORM_DB, {
      receiptId: "rcp_post_1",
      refundReference: "rfd_post_001",
      reason: "Chargeback pasca pencairan komisi periode November",
      nowMs: nov15Wib + 7_200_000,
    });
    expect(postRev.status).toBe("offset_created");
    if (postRev.status !== "offset_created") throw new Error("expected offset_created");
    expect(postRev.mode).toBe("post_payout_offset");
    expect(postRev.originalEntry.status).toBe("paid");
    expect(postRev.offsetEntry.entryKind).toBe("reversal_offset");
    expect(postRev.offsetEntry.commissionIdr).toBe(-107_400);
    expect(postRev.offsetEntry.status).toBe("approved");
    expect(postRev.offsetEntry.sourceCommissionId).toBe(paidComm.entry.id);

    // Duplicate post-payout refund is 100% idempotent (zero second offset row)
    const postRevDup = await reverseCommissionForRefund(env.PLATFORM_DB, {
      receiptId: "rcp_post_1",
      refundReference: "rfd_post_001",
      reason: "Chargeback pasca pencairan komisi periode November",
      nowMs: nov15Wib + 7_300_000,
    });
    expect(postRevDup.status).toBe("already_reversed");
    if (postRevDup.status !== "already_reversed") throw new Error("expected already_reversed");
    expect(postRevDup.mode).toBe("post_payout_offset");
    expect(postRevDup.offsetEntry?.id).toBe(postRev.offsetEntry.id);

    // Future earnings: +107_400 (first payment on ten_r3) + +35_800 (renewal on ten_r3)
    // Net available = -107_400 + 107_400 + 35_800 = +35_800 (< Rp 100.000) -> MUST BE SKIPPED!
    const nov16 = Date.UTC(2026, 10, 16, 0, 0, 0);
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r3",
      receiptId: "rcp_r3_1",
      grossAmountIdr: 179_000,
      confirmedAtMs: nov16,
      nowMs: nov16,
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r3",
      receiptId: "rcp_r3_2",
      grossAmountIdr: 179_000,
      confirmedAtMs: nov16,
      nowMs: nov16,
    });

    const nov30Wib = Date.UTC(2026, 10, 30, 1, 0, 0); // 2026-11-30 08:00 WIB (>= nov16 + 14d)
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: nov30Wib });

    const balanceBefore = await getAffiliateCommissionBalanceSummary(env.PLATFORM_DB, "aff_ref");
    expect(balanceBefore.approvedAvailableIdr).toBe(35_800);
    expect(balanceBefore.paidIdr).toBe(107_400);

    const skippedRun = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: nov30Wib,
    });
    expect(skippedRun.ran).toBe(true);
    expect(skippedRun.payoutPeriodKey).toBe("2026-11-30");
    expect(skippedRun.createdBatchCount).toBe(0);
    expect(skippedRun.skippedBelowThresholdCount).toBe(1);
    expect(skippedRun.skippedAffiliates[0]).toEqual({
      affiliateId: "aff_ref",
      netAvailableIdr: 35_800,
      entryCount: 3,
      reason: "below_minimum_threshold",
    });

    // Next cycle: affiliate earns another +107_400 (e.g., new tenant ten_r4) -> net = 35_800 + 107_400 = 143_200 >= 100_000!
    await seedTenant({
      id: "ten_r4",
      orgId: "org_r4",
      handle: "toko-r4",
      affiliateId: "aff_ref",
      referralCode: "REFUND01",
    });
    const dec1 = Date.UTC(2026, 11, 1, 0, 0, 0);
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r4",
      receiptId: "rcp_r4_1",
      grossAmountIdr: 179_000,
      confirmedAtMs: dec1,
      nowMs: dec1,
    });

    const dec15Wib = Date.UTC(2026, 11, 15, 1, 0, 0); // 2026-12-15 08:00 WIB (>= dec1 + 14d)
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: dec15Wib });

    const dec15Run = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: dec15Wib,
    });
    expect(dec15Run.ran).toBe(true);
    expect(dec15Run.payoutPeriodKey).toBe("2026-12-15");
    expect(dec15Run.createdBatchCount).toBe(1);
    expect(dec15Run.batches[0]!.totalAmountIdr).toBe(143_200);
    expect(dec15Run.batches[0]!.entryCount).toBe(4); // 1 negative offset + 3 positive entries!

    // All 4 entries (including the negative reversal_offset) are linked to the batch
    const batchedEntries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      payoutBatchId: dec15Run.batches[0]!.id,
    });
    expect(batchedEntries).toHaveLength(4);
    expect(batchedEntries.reduce((sum, e) => sum + e.commissionIdr, 0)).toBe(143_200);
  });

  it("builds bi-monthly Asia/Jakarta batches on 15th, 30th, Feb 28 (non-leap) & Feb 29 (leap), skips < Rp 100.000, and is 100% idempotent on rerun", async () => {
    await seedAffiliate({ id: "aff_big", userId: "usr_big", code: "BIG001" });
    await seedAffiliate({ id: "aff_small", userId: "usr_small", code: "SMALL01" });

    await seedTenant({
      id: "ten_b1",
      orgId: "org_b1",
      handle: "toko-b1",
      affiliateId: "aff_big",
      referralCode: "BIG001",
    });
    await seedTenant({
      id: "ten_s1",
      orgId: "org_s1",
      handle: "toko-s1",
      affiliateId: "aff_small",
      referralCode: "SMALL01",
    });

    // aff_big earns 107_400 (>= 100_000); aff_small earns 60_000 (< 100_000)
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_b1",
      receiptId: "rcp_b1",
      grossAmountIdr: 179_000,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_s1",
      receiptId: "rcp_s1",
      grossAmountIdr: 100_000, // 60% = 60_000 < 100_000
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
      nowMs: BASE_NOW_MS + 14 * AFFILIATE_COMMISSION_DAY_MS,
    });

    // 1. Non-batch date (2026-11-14T16:59:59Z = 2026-11-14 23:59:59 WIB) -> skipped
    const nonBatchRes = await runBiMonthlyAffiliatePayoutBatchSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: Date.UTC(2026, 10, 14, 16, 59, 59), logger: () => {} },
    );
    expect(nonBatchRes.ran).toBe(false);
    expect(nonBatchRes.skipReason).toBe("not_payout_date");

    // 2. Exact WIB timezone boundary: 2026-11-14T17:00:00Z = 2026-11-15T00:00:00+07:00
    const nov15WibStart = Date.UTC(2026, 10, 14, 17, 0, 0);
    const firstBatchRun = await runBiMonthlyAffiliatePayoutBatchSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: nov15WibStart, logger: () => {} },
    );
    expect(firstBatchRun.ran).toBe(true);
    expect(firstBatchRun.payoutPeriodKey).toBe("2026-11-15");
    expect(firstBatchRun.minimumPayoutIdr).toBe(AFFILIATE_PAYOUT_MINIMUM_IDR);
    expect(firstBatchRun.createdBatchCount).toBe(1);
    expect(firstBatchRun.skippedBelowThresholdCount).toBe(1);
    expect(firstBatchRun.batches[0]!.affiliateId).toBe("aff_big");
    expect(firstBatchRun.batches[0]!.totalAmountIdr).toBe(107_400);
    expect(firstBatchRun.batches[0]!.status).toBe("pending_review");

    // Re-running later on the same WIB day (`2026-11-15T12:00:00Z` = 19:00 WIB) -> ZERO duplicate batches!
    const rerunNov15 = await runBiMonthlyAffiliatePayoutBatchSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: Date.UTC(2026, 10, 15, 12, 0, 0), logger: () => {} },
    );
    expect(rerunNov15.ran).toBe(true);
    expect(rerunNov15.createdBatchCount).toBe(0);

    // aff_small's 60_000 rolled over; add another 60_000 -> total 120_000 -> batched on Feb 28, 2027 (non-leap)!
    const feb10_2027 = Date.UTC(2027, 1, 10, 0, 0, 0);
    await seedTenant({
      id: "ten_s2",
      orgId: "org_s2",
      handle: "toko-s2",
      affiliateId: "aff_small",
      referralCode: "SMALL01",
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_s2",
      receiptId: "rcp_s2",
      grossAmountIdr: 100_000, // 60_000 -> combined 120_000
      confirmedAtMs: feb10_2027,
      nowMs: feb10_2027,
    });
    const feb28_2027Wib = Date.UTC(2027, 1, 27, 17, 0, 0); // 2027-02-28 00:00 WIB
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: feb28_2027Wib });

    const feb28Run = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: feb28_2027Wib,
    });
    expect(feb28Run.ran).toBe(true);
    expect(feb28Run.payoutPeriodKey).toBe("2027-02-28");
    expect(feb28Run.createdBatchCount).toBe(1);
    expect(feb28Run.batches[0]!.affiliateId).toBe("aff_small");
    expect(feb28Run.batches[0]!.totalAmountIdr).toBe(120_000);
    expect(feb28Run.batches[0]!.entryCount).toBe(2);

    // Verify leap-year Feb 29, 2028 (Feb 28, 2028 MUST skip; Feb 29, 2028 MUST run!)
    const feb10_2028 = Date.UTC(2028, 1, 10, 0, 0, 0);
    await seedTenant({
      id: "ten_b2",
      orgId: "org_b2",
      handle: "toko-b2",
      affiliateId: "aff_big",
      referralCode: "BIG001",
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_b2",
      receiptId: "rcp_b2",
      grossAmountIdr: 179_000,
      confirmedAtMs: feb10_2028,
      nowMs: feb10_2028,
    });
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, {
      nowMs: Date.UTC(2028, 1, 28, 0, 0, 0),
    });

    const feb28_2028Skip = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: Date.UTC(2028, 1, 28, 1, 0, 0), // 2028-02-28 08:00 WIB (leap year -> NOT last day!)
    });
    expect(feb28_2028Skip.ran).toBe(false);

    const feb29_2028Run = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: Date.UTC(2028, 1, 28, 17, 0, 0), // 2028-02-29 00:00 WIB
    });
    expect(feb29_2028Run.ran).toBe(true);
    expect(feb29_2028Run.payoutPeriodKey).toBe("2028-02-29");
    expect(feb29_2028Run.createdBatchCount).toBe(1);
    expect(feb29_2028Run.batches[0]!.totalAmountIdr).toBe(107_400);

    // Verify platform_audit rows exist for EVERY created payout batch in this test
    const allBatches = await listAffiliatePayoutBatches(env.PLATFORM_DB);
    expect(allBatches).toHaveLength(3);
    const createdBatchIds = new Set(allBatches.map((b) => b.id));
    const batchAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "affiliate.payout_batch.created",
      limit: 50,
    });
    expect(batchAudits.filter((a) => createdBatchIds.has(a.targetId))).toHaveLength(3);
  });

  it("hooks confirmed AutoLaris Advice settlements and durable cron job handlers end-to-end", async () => {
    await seedAffiliate({ id: "aff_e2e", userId: "usr_e2e", code: "E2E001" });
    await seedTenant({
      id: "ten_e2e",
      orgId: "org_e2e",
      handle: "toko-e2e",
      status: "trial",
      affiliateId: "aff_e2e",
      referralCode: "E2E001",
    });

    await seedUser("usr_owner_e2e", "owner-e2e@example.com", "Owner E2E");
    const begun = await beginDurablePaymentAttempt(env.PLATFORM_DB, {
      tenantId: "ten_e2e",
      effectiveTenantStatus: "trial",
      payerType: "tenant",
      payerAgencyId: null,
      plan: "monthly",
      channelKind: "QRIS",
      channelCode: "QRIS",
      estimatedChannelFeeIdr: 4_000,
      providerAccountId: "acct-t085",
      idempotencyKey: "idem-t085-e2e-1",
      requestHash: "hash-t085-e2e-1",
      nowMs: BASE_NOW_MS,
    });

    // Apply a Rp 20.000 discount snapshot directly on the open obligation/attempt to verify net-base exclusion
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `UPDATE billing_obligations
         SET discount_amount_idr = 20000, net_amount_idr = 159000
         WHERE id = ?`,
      ).bind(begun.obligation.id),
      env.PLATFORM_DB.prepare(
        `UPDATE payment_attempts
         SET discount_amount_idr = 20000
         WHERE id = ?`,
      ).bind(begun.attempt.id),
    ]);

    await completePaymentAttemptPending(env.PLATFORM_DB, {
      attemptId: begun.attempt.id,
      obligationId: begun.obligation.id,
      tenantId: "ten_e2e",
      actorUserId: "usr_owner_e2e",
      actorRole: "owner",
      requestId: "req-t085-e2e-1",
      providerTransactionId: "AL-TRX-T085-001",
      channelFeeIdr: 4_000,
      grossAdminFeeIdr: 4_000,
      providerDiscountIdr: 0,
      totalPayableIdr: 163_000, // 179_000 - 20_000 + 4_000
      qrisPayload: "00020101021226680016ID.CO.QRIS.TEST",
      vaNumber: null,
      bankName: null,
      paymentRedirectUrl: null,
      expiresAtMs: BASE_NOW_MS + 3_600_000,
      nowMs: BASE_NOW_MS + 1000,
    });

    const mockClient = createAutoLarisClient({
      relayBaseUrl: "https://autolaris-relay.punyasitus.com",
      apiKey: "al_test_t085_key_never_logged",
      providerAccountId: "acct-t085",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            rc: "00",
            ket: "Settlement confirmed",
            data: {
              transaction_id: "AL-TRX-T085-001",
              reff_id: begun.attempt.reffId,
              payment_status: "PAID_SETTLED",
              total: 163_000,
              currency: "IDR",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const settledOutcome = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: mockClient,
      attemptId: begun.attempt.id,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS + 2000,
    });

    expect(settledOutcome.outcome).toBe("settled");
    expect(settledOutcome.commissionStatus).toBe("created");
    expect(settledOutcome.commissionEntryId).toBeTruthy();

    // Re-running reconciliation on already-paid attempt is 100% idempotent
    const replayOutcome = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: mockClient,
      attemptId: begun.attempt.id,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS + 3000,
    });
    expect(replayOutcome.outcome).toBe("already_settled");
    expect(replayOutcome.commissionStatus).toBe("duplicate");
    expect(replayOutcome.commissionEntryId).toBe(settledOutcome.commissionEntryId);

    const entries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      affiliateId: "aff_e2e",
    });
    expect(entries).toHaveLength(1);
    // Net base = 179_000 - 20_000 = 159_000 (excluding 4_000 channel fee!); 60% = 95_400
    expect(entries[0]!.netBaseIdr).toBe(159_000);
    expect(entries[0]!.channelFeeIdr).toBe(4_000);
    expect(entries[0]!.commissionIdr).toBe(95_400);

    // Execute durable cron job registry handlers cleanly
    const cronRegistry = createAffiliatePayoutCronJobRegistry({ logger: () => {} });
    const holdHandler = cronRegistry[AFFILIATE_HOLD_PROMOTION_CRON_TOPIC]!;
    const batchHandler = cronRegistry[AFFILIATE_PAYOUT_BATCH_CRON_TOPIC]!;
    expect(holdHandler).toBeDefined();
    expect(batchHandler).toBeDefined();

    const matureAt = BASE_NOW_MS + 2000 + 14 * AFFILIATE_COMMISSION_DAY_MS;
    await holdHandler.execute({
      env: { PLATFORM_DB: env.PLATFORM_DB } as never,
      idempotencyKey: "cron-hold-1",
      topic: AFFILIATE_HOLD_PROMOTION_CRON_TOPIC,
      tenantId: null,
      payload: { scheduledTimeMs: matureAt },
      attempt: 1,
      maxAttempts: 3,
      correlationId: "corr-hold-1",
      enqueuedAt: matureAt,
      nowMs: matureAt,
    });

    const afterHold = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      affiliateId: "aff_e2e",
    });
    expect(afterHold[0]!.status).toBe("approved");

    // 95_400 < 100_000 -> batch cron runs cleanly without creating a batch
    const nov15Wib = Date.UTC(2026, 10, 14, 17, 0, 0);
    await batchHandler.execute({
      env: { PLATFORM_DB: env.PLATFORM_DB } as never,
      idempotencyKey: "cron-batch-1",
      topic: AFFILIATE_PAYOUT_BATCH_CRON_TOPIC,
      tenantId: null,
      payload: { scheduledTimeMs: nov15Wib, payoutPeriodKey: "2026-11-15" },
      attempt: 1,
      maxAttempts: 3,
      correlationId: "corr-batch-1",
      enqueuedAt: nov15Wib,
      nowMs: nov15Wib,
    });
    expect(await listAffiliatePayoutBatches(env.PLATFORM_DB, { affiliateId: "aff_e2e" })).toHaveLength(
      0,
    );
  });

  it("enforces BEFORE DELETE immutability on batched & paid entries, rejects revoked operator / stale version / bad period key, drains hold promotions in bi-monthly cron, and never silently swallows real commission hook errors", async () => {
    await seedOperator("op_active");
    await seedUser("op_revoked", "op-revoked@punyasitus.com", "Revoked Op");
    await env.PLATFORM_DB.prepare(
      `INSERT INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
       VALUES ('op_revoked', 'op_active', 'Operator dicabut untuk uji R3.', ?, ?)`,
    )
      .bind(BASE_NOW_MS, BASE_NOW_MS + 1000)
      .run();

    await seedAffiliate({ id: "aff_r3", userId: "usr_aff_r3", code: "R3TEST01" });
    await seedTenant({
      id: "ten_r3_a",
      orgId: "org_r3_a",
      handle: "toko-r3-a",
      affiliateId: "aff_r3",
      referralCode: "R3TEST01",
    });

    // 1. Validate payoutPeriodKey format (must be YYYY-MM-DD)
    await expect(
      buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
        nowMs: Date.UTC(2026, 10, 14, 17, 0, 0),
        forceRun: true,
        overridePayoutPeriodKey: "2026/11/15",
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    // 2. Commission maturing ON the 15th WIB is drained & batched in the SAME bi-monthly sweep!
    // Confirmed 2026-10-31T17:00:00Z (= 2026-11-01 00:00 WIB) -> matures 2026-11-14T17:00:00Z (= 2026-11-15 00:00 WIB)
    const nov1WibStart = Date.UTC(2026, 9, 31, 17, 0, 0);
    const nov15WibStart = Date.UTC(2026, 10, 14, 17, 0, 0);
    const comm = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: "ten_r3_a",
      receiptId: "rcp_r3_drain",
      grossAmountIdr: 179_000, // 60% = 107_400
      confirmedAtMs: nov1WibStart,
      nowMs: nov1WibStart,
    });
    expect(comm.status).toBe("created");
    if (comm.status !== "created") throw new Error("expected created");
    expect(comm.entry.status).toBe("pending");

    // Do NOT call promoteMaturedPendingCommissions manually — runBiMonthlyAffiliatePayoutBatchSweep must drain it first!
    const sweepRes = await runBiMonthlyAffiliatePayoutBatchSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: nov15WibStart, logger: () => {} },
    );
    expect(sweepRes.ran).toBe(true);
    expect(sweepRes.promotedBeforeBatchCount).toBe(1);
    expect(sweepRes.createdBatchCount).toBe(1);
    const batch = sweepRes.batches[0]!;
    expect(batch.totalAmountIdr).toBe(107_400);
    expect(batch.entryCount).toBe(1);

    // Verify live audit metadata on `affiliate.payout_batch.created` matches the inserted batch row
    const createdAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "affiliate.payout_batch.created",
      targetId: batch.id,
    });
    expect(createdAudits).toHaveLength(1);
    expect(JSON.parse(createdAudits[0]!.metadataJson ?? "{}")).toMatchObject({
      affiliateId: "aff_r3",
      payoutPeriodKey: "2026-11-15",
      totalAmountIdr: 107_400,
      entryCount: 1,
    });

    // 3. BEFORE DELETE trigger blocks deleting a `batched` entry
    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM affiliate_commission_entries WHERE id = ?")
        .bind(comm.entry.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_COMMISSION_DELETE_FORBIDDEN/);

    // 4. markAffiliatePayoutBatchPaid rejects revoked operator (403) and stale expectedVersion (409)
    await expect(
      markAffiliatePayoutBatchPaid(env.PLATFORM_DB, {
        batchId: batch.id,
        actorUserId: "op_revoked",
        transferReference: "BCA-TRF-REVOKED-001",
        reason: "Mencoba menandai batch dibayar oleh operator dicabut",
        expectedVersion: 1,
        nowMs: nov15WibStart + 1000,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    await expect(
      markAffiliatePayoutBatchPaid(env.PLATFORM_DB, {
        batchId: batch.id,
        actorUserId: "op_active",
        transferReference: "BCA-TRF-STALE-001",
        reason: "Mencoba menandai batch dibayar dengan versi lama",
        expectedVersion: 99,
        nowMs: nov15WibStart + 2000,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_VERSION" });

    // Valid operator marks batch paid -> BEFORE DELETE trigger ALSO blocks deleting `paid` entry
    const paidRes = await markAffiliatePayoutBatchPaid(env.PLATFORM_DB, {
      batchId: batch.id,
      actorUserId: "op_active",
      transferReference: "BCA-TRF-VALID-001",
      reason: "Transfer manual batch payout afiliasi periode 15 Nov 2026",
      expectedVersion: 1,
      nowMs: nov15WibStart + 3000,
    });
    expect(paidRes.batch.status).toBe("paid");

    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM affiliate_commission_entries WHERE id = ?")
        .bind(comm.entry.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_COMMISSION_DELETE_FORBIDDEN/);

    // 5. B1 regression: pre-0032 missing table skips cleanly (`skipped_pre_0032`),
    //    while real errors on a migrated DB either enqueue durable retry or RETHROW!
    const fakePre0032Db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("D1_ERROR: no such table: affiliate_commission_entries");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const pre0032Res = await recordAffiliateCommissionForSettledPayment({
      db: fakePre0032Db,
      tenantId: "ten_r3_a",
      settlementId: "stl_pre0032",
      paymentAttemptId: "att_pre0032",
      nowMs: nov15WibStart,
    });
    expect(pre0032Res.status).toBe("skipped_pre_0032");

    // Seed a real confirmed settlement and inject a `platform_audit` failure trigger to simulate a real write error!
    await seedConfirmedSettlement({
      tenantId: "ten_r3_a",
      obligationId: "obl_r3_err",
      attemptId: "att_r3_err",
      settlementId: "stl_r3_err",
      baseAmountIdr: 179_000,
      settledAtMs: nov15WibStart + 5000,
    });

    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER test_fail_platform_audit_insert_t085
       BEFORE INSERT ON platform_audit
       WHEN NEW.action = 'affiliate.commission.recorded'
       BEGIN
         SELECT RAISE(ABORT, 'SIMULATED_AUDIT_FAILURE');
       END`,
    ).run();

    // 5a. Without jobsQueue -> MUST RETHROW (never silently swallow!)
    await expect(
      recordAffiliateCommissionForSettledPayment({
        db: env.PLATFORM_DB,
        tenantId: "ten_r3_a",
        settlementId: "stl_r3_err",
        paymentAttemptId: "att_r3_err",
        obligationId: "obl_r3_err",
        nowMs: nov15WibStart + 5000,
        logger: () => {},
      }),
    ).rejects.toBeInstanceOf(AffiliateLedgerError);

    // 5b. With jobsQueue -> enqueues durable `billing.affiliate.commission` retry job & logs sanitized error!
    const queuedMessages: unknown[] = [];
    const loggedEvents: Record<string, unknown>[] = [];
    const retryRes = await recordAffiliateCommissionForSettledPayment({
      db: env.PLATFORM_DB,
      tenantId: "ten_r3_a",
      settlementId: "stl_r3_err",
      paymentAttemptId: "att_r3_err",
      obligationId: "obl_r3_err",
      nowMs: nov15WibStart + 6000,
      jobsQueue: {
        async send(msg) {
          queuedMessages.push(msg);
        },
      },
      logger: (entry) => loggedEvents.push(entry),
    });

    expect(retryRes.status).toBe("enqueued_retry");
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      topic: BILLING_AFFILIATE_COMMISSION_TOPIC,
      tenantId: "ten_r3_a",
      maxAttempts: 3,
      payload: {
        tenantId: "ten_r3_a",
        settlementId: "stl_r3_err",
        paymentAttemptId: "att_r3_err",
      },
    });
    expect(loggedEvents.some((e) => e.event === "billing.affiliate.commission.error")).toBe(true);

    // Clean up failure trigger
    await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_fail_platform_audit_insert_t085").run();
  });
});
