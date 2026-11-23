import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import { applySessionTwoFactorMigration } from "@punyasitus/auth/platform/two-factor";
import {
  applyAffiliateMigrations,
  applyForAffiliateAccount,
  approveAffiliate,
  lockTenantAffiliateAttribution,
  recordAffiliateFunnelVisit,
} from "@punyasitus/db/affiliates/index";
import {
  applyAffiliateCommissionLedgerMigrations,
  buildBiMonthlyAffiliatePayoutBatches,
  promoteMaturedPendingCommissions,
  recordConfirmedPaymentCommission,
  reverseCommissionForRefund,
} from "@punyasitus/db/affiliates/ledger/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAffiliateBatchDetailRequest } from "../../apps/web/src/pages/api/affiliate/batches/[batchId].ts";
import { handleAffiliateOverviewRequest } from "../../apps/web/src/pages/api/affiliate/overview.ts";
import { handleConsoleAffiliateDetailRequest } from "../../apps/web/src/pages/api/console/affiliates/[affiliateId]/index.ts";
import { handleConsoleAffiliateStatusRequest } from "../../apps/web/src/pages/api/console/affiliates/[affiliateId]/status.ts";
import { handleConsoleMarkPayoutBatchPaidRequest } from "../../apps/web/src/pages/api/console/affiliates/batches/[batchId]/mark-paid.ts";
import { handleConsoleAffiliateComplianceRequest } from "../../apps/web/src/pages/api/console/affiliates/compliance.ts";
import { handleConsoleAffiliatesListRequest } from "../../apps/web/src/pages/api/console/affiliates/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const MARKETING_ORIGIN = "https://punyasitus.com";
const TENANT_ORIGIN = "https://kopi-secret.situsku.click";
const APP_SECRET = "task086-workerd-app-auth-secret-0123456789abcdef0123456789";
const CONSOLE_SECRET = "task086-workerd-console-secret-fedcba9876543210fedcba987654";

const DAY_MS = 24 * 60 * 60 * 1000;
// Deterministic base timestamp: 2026-12-01 03:00 UTC (10:00 WIB)
const BASE_NOW_MS = Date.UTC(2026, 11, 1, 3, 0, 0);
// Payout batch date: 2026-12-15 03:00 UTC (10:00 WIB)
const PAYOUT_DEC_15_MS = Date.UTC(2026, 11, 15, 3, 0, 0);
// Second payout batch date: 2026-12-30 03:00 UTC (10:00 WIB)
const PAYOUT_DEC_30_MS = Date.UTC(2026, 11, 30, 3, 0, 0);

function buildAppEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

function buildConsoleEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

async function resetTables(): Promise<void> {
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
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliates"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
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

async function createSurfaceSession(params: {
  readonly surface: "app" | "console";
  readonly email: string;
  readonly name: string;
  readonly nowMs?: number;
}): Promise<{
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly cookieHeader: string;
}> {
  const origin = params.surface === "console" ? CONSOLE_ORIGIN : APP_ORIGIN;
  const secret = params.surface === "console" ? CONSOLE_SECRET : APP_SECRET;
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: origin,
    secret,
    surface: params.surface,
    trustedOrigins: [origin],
  });

  const signUpRes = await auth.api.signUpEmail({
    body: {
      email: params.email,
      password: "SandiAman#2026!",
      name: params.name,
    },
    asResponse: true,
  });
  expect(signUpRes.status).toBe(200);
  const body = (await signUpRes.json()) as {
    readonly user: { readonly id: string; readonly email: string };
  };

  const setCookie = signUpRes.headers.get("set-cookie") ?? "";
  const cookiePair = setCookie.split(";")[0] ?? "";
  const nowMs = params.nowMs ?? BASE_NOW_MS;

  await env.PLATFORM_DB.prepare(
    "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?",
  )
    .bind(nowMs, body.user.id)
    .run();

  const sessRow = await env.PLATFORM_DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(body.user.id)
    .first<{ readonly id: string }>();
  expect(sessRow?.id).toBeTruthy();

  await env.PLATFORM_DB.prepare(
    "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?",
  )
    .bind(nowMs, nowMs, nowMs + 7 * DAY_MS, sessRow!.id)
    .run();

  return {
    userId: body.user.id,
    sessionId: sessRow!.id,
    email: body.user.email,
    cookieHeader: cookiePair,
  };
}

async function refreshSessionTimestamp(sessionId: string, nowMs: number): Promise<void> {
  await env.PLATFORM_DB.prepare(
    "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?",
  )
    .bind(nowMs, nowMs, nowMs + 7 * DAY_MS, sessionId)
    .run();
}

async function grantConsoleOperator(params: {
  readonly userId: string;
  readonly sessionId: string;
  readonly role?: "platform_superadmin" | "platform_support";
  readonly twoFactorEnabled?: boolean;
  readonly verifiedAtMs?: number | null;
  readonly nowMs?: number;
}): Promise<void> {
  const nowMs = params.nowMs ?? BASE_NOW_MS;
  const role = params.role ?? "platform_superadmin";
  await env.PLATFORM_DB.prepare(
    `INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at, role)
     VALUES (?, ?, 'Operator platform aktif untuk pengujian TASK-086.', ?, NULL, ?)`,
  )
    .bind(params.userId, params.userId, nowMs, role)
    .run();

  if (params.twoFactorEnabled !== false) {
    await env.PLATFORM_DB.prepare("UPDATE users SET two_factor_enabled = 1 WHERE id = ?")
      .bind(params.userId)
      .run();
  }

  if (params.verifiedAtMs !== null) {
    const vAt = params.verifiedAtMs ?? nowMs;
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO session_two_factor_verifications
       (session_id, user_id, verified_at, method, created_at, updated_at)
       VALUES (?, ?, ?, 'totp', ?, ?)`,
    )
      .bind(params.sessionId, params.userId, vAt, vAt, vAt)
      .run();
  }
}

async function createReferredTenant(params: {
  readonly id: string;
  readonly handle: string;
  readonly businessName: string;
  readonly ownerEmail: string;
  readonly ownerName: string;
  readonly status: "trial" | "active";
  readonly referralCode: string;
  readonly nowMs?: number;
}): Promise<{ readonly tenantId: string; readonly ownerUserId: string }> {
  const nowMs = params.nowMs ?? BASE_NOW_MS;
  const owner = await createSurfaceSession({
    surface: "app",
    email: params.ownerEmail,
    name: params.ownerName,
    nowMs,
  });
  const orgId = `org_${params.id}`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(orgId, params.businessName, params.handle, nowMs, nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_${params.id}`, orgId, owner.userId, nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'compro', ?, ?, ?)`,
    ).bind(params.id, orgId, params.handle, params.businessName, params.status, nowMs, nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at, updated_at)
       VALUES (?, ?, 'subdomain', 'active', 1, ?, ?)`,
    ).bind(`${params.handle}.situsku.click`, params.id, nowMs, nowMs),
  ]);

  const locked = await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
    tenantId: params.id,
    ownerUserId: owner.userId,
    referralCode: params.referralCode,
    attributionSource: "cookie",
    cookieIssuedAtMs: nowMs,
    nowMs,
  });
  expect(locked).toMatchObject({ attributed: true });

  return { tenantId: params.id, ownerUserId: owner.userId };
}

describe("TASK-086: Affiliate Self-Service Portal & Console Payout Management (workerd + D1)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyAffiliateMigrations(env.PLATFORM_DB);
    await applyAffiliateCommissionLedgerMigrations(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("enforces host isolation, 401 unauthenticated, 403 tenant-only, and 403/404 foreign-affiliate isolation", async () => {
    const op = await createSurfaceSession({
      surface: "console",
      email: "op-iso@example.com",
      name: "Operator Iso",
    });
    await grantConsoleOperator({ userId: op.userId, sessionId: op.sessionId });

    const affAUser = await createSurfaceSession({
      surface: "app",
      email: "aff-a@example.com",
      name: "Mitra A",
    });
    const affBUser = await createSurfaceSession({
      surface: "app",
      email: "aff-b@example.com",
      name: "Mitra B",
    });
    const tenantOnlyUser = await createSurfaceSession({
      surface: "app",
      email: "tenant-only@example.com",
      name: "Pemilik Tenant Biasa",
    });

    const appA = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: affAUser.userId,
      payload: {
        payoutBankCode: "BCA",
        payoutAccountNumber: "1122334455",
        payoutAccountHolder: "Mitra A",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });
    const approvedA = await approveAffiliate(env.PLATFORM_DB, {
      affiliateId: appA.affiliate.id,
      actorUserId: op.userId,
      reason: "Menyetujui mitra afiliasi A untuk uji isolasi.",
      referralCode: "MITRAA01",
      expectedVersion: appA.affiliate.version,
      nowMs: BASE_NOW_MS,
    });

    const appB = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: affBUser.userId,
      payload: {
        payoutBankCode: "MANDIRI",
        payoutAccountNumber: "9988776655",
        payoutAccountHolder: "Mitra B",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });
    const approvedB = await approveAffiliate(env.PLATFORM_DB, {
      affiliateId: appB.affiliate.id,
      actorUserId: op.userId,
      reason: "Menyetujui mitra afiliasi B untuk uji isolasi.",
      referralCode: "MITRAB02",
      expectedVersion: appB.affiliate.version,
      nowMs: BASE_NOW_MS,
    });

    // Seed a payout batch strictly owned by Affiliate B
    const tenantB = await createReferredTenant({
      id: "ten_b_iso",
      handle: "butik-melati",
      businessName: "Butik Melati Rahasia",
      ownerEmail: "owner-melati@example.com",
      ownerName: "Siti Melati",
      status: "active",
      referralCode: "MITRAB02",
      nowMs: BASE_NOW_MS,
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: tenantB.tenantId,
      receiptId: "rcpt_b_iso_1",
      grossAmountIdr: 179_000,
      isConfirmed: true,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: PAYOUT_DEC_15_MS });
    const batchResB = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, {
      nowMs: PAYOUT_DEC_15_MS,
    });
    expect(batchResB.createdBatchCount).toBe(1);
    const foreignBatchId = batchResB.batches[0]!.id;

    // Advance sessions to PAYOUT_DEC_15_MS after the 14-day simulated time jump
    await Promise.all([
      refreshSessionTimestamp(affAUser.sessionId, PAYOUT_DEC_15_MS),
      refreshSessionTimestamp(affBUser.sessionId, PAYOUT_DEC_15_MS),
      refreshSessionTimestamp(tenantOnlyUser.sessionId, PAYOUT_DEC_15_MS),
    ]);

    // 1. Wrong hosts -> neutral 404
    for (const wrongOrigin of [MARKETING_ORIGIN, CONSOLE_ORIGIN, TENANT_ORIGIN]) {
      const res = await handleAffiliateOverviewRequest(
        new Request(`${wrongOrigin}/api/affiliate/overview`, {
          headers: { Cookie: affAUser.cookieHeader },
        }),
        buildAppEnv(),
        { nowMs: PAYOUT_DEC_15_MS },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }

    // 2. Unauthenticated -> 401
    const unauthRes = await handleAffiliateOverviewRequest(
      new Request(`${APP_ORIGIN}/api/affiliate/overview`),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(unauthRes.status).toBe(401);

    // 3. Tenant-only user (no affiliate account) -> 403 AFFILIATE_ACCOUNT_REQUIRED
    const tenantOnlyRes = await handleAffiliateOverviewRequest(
      new Request(`${APP_ORIGIN}/api/affiliate/overview`, {
        headers: { Cookie: tenantOnlyUser.cookieHeader },
      }),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(tenantOnlyRes.status).toBe(403);
    const tenantOnlyBody = (await tenantOnlyRes.json()) as { readonly code: string };
    expect(tenantOnlyBody.code).toBe("AFFILIATE_ACCOUNT_REQUIRED");

    // 4. Affiliate A probing Affiliate B's affiliateId -> 403 FORBIDDEN
    const foreignAffProbe = await handleAffiliateOverviewRequest(
      new Request(
        `${APP_ORIGIN}/api/affiliate/overview?affiliateId=${encodeURIComponent(approvedB.affiliate.id)}`,
        { headers: { Cookie: affAUser.cookieHeader } },
      ),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(foreignAffProbe.status).toBe(403);

    // 5. Affiliate A probing Affiliate B's payout batch -> 404 NOT_FOUND
    const foreignBatchProbe1 = await handleAffiliateOverviewRequest(
      new Request(
        `${APP_ORIGIN}/api/affiliate/overview?batchId=${encodeURIComponent(foreignBatchId)}`,
        { headers: { Cookie: affAUser.cookieHeader } },
      ),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(foreignBatchProbe1.status).toBe(404);

    const foreignBatchProbe2 = await handleAffiliateBatchDetailRequest(
      foreignBatchId,
      new Request(`${APP_ORIGIN}/api/affiliate/batches/${encodeURIComponent(foreignBatchId)}`, {
        headers: { Cookie: affAUser.cookieHeader },
      }),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(foreignBatchProbe2.status).toBe(404);

    // 6. Affiliate B accessing their OWN batch succeeds with masked handle and zero PII
    const ownBatchRes = await handleAffiliateBatchDetailRequest(
      foreignBatchId,
      new Request(`${APP_ORIGIN}/api/affiliate/batches/${encodeURIComponent(foreignBatchId)}`, {
        headers: { Cookie: affBUser.cookieHeader },
      }),
      buildAppEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(ownBatchRes.status).toBe(200);
    const ownBatchText = await ownBatchRes.text();
    expect(ownBatchText).toContain("bu***ti");
    expect(ownBatchText).not.toContain("butik-melati");
    expect(ownBatchText).not.toContain("Butik Melati Rahasia");
    expect(ownBatchText).not.toContain("owner-melati@example.com");
    expect(ownBatchText).not.toContain("Siti Melati");
    expect(approvedA.affiliate.status).toBe("active");
  });

  it("returns exact ledger balances (pending, approved, batched, paid, negative reversal_offset) and ZERO tenant PII", async () => {
    const op = await createSurfaceSession({
      surface: "console",
      email: "op-ledger@example.com",
      name: "Operator Ledger",
    });
    await grantConsoleOperator({ userId: op.userId, sessionId: op.sessionId });

    const affUser = await createSurfaceSession({
      surface: "app",
      email: "mitra-utama@example.com",
      name: "Andi Mitra",
    });
    const applied = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: affUser.userId,
      payload: {
        payoutBankCode: "BCA",
        payoutAccountNumber: "5544332211",
        payoutAccountHolder: "Andi Mitra",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });
    await approveAffiliate(env.PLATFORM_DB, {
      affiliateId: applied.affiliate.id,
      actorUserId: op.userId,
      reason: "Menyetujui mitra utama untuk uji buku besar portal.",
      referralCode: "ANDI6020",
      expectedVersion: applied.affiliate.version,
      nowMs: BASE_NOW_MS,
    });

    // Record 17 visits
    for (let i = 0; i < 17; i += 1) {
      await recordAffiliateFunnelVisit(env.PLATFORM_DB, "ANDI6020", BASE_NOW_MS + i * 1000);
    }

    // Create 3 referred tenants with sensitive owner details that MUST NEVER leak
    const tenant1 = await createReferredTenant({
      id: "ten_paid_1",
      handle: "kopinusantara",
      businessName: "CV Kopi Nusantara Rahasia",
      ownerEmail: "rahasia-kopi@example.com",
      ownerName: "Bambang Pemilik Kopi",
      status: "active",
      referralCode: "ANDI6020",
      nowMs: BASE_NOW_MS,
    });
    const tenant2 = await createReferredTenant({
      id: "ten_trial_2",
      handle: "abc",
      businessName: "Klinik Rahasia ABC",
      ownerEmail: "rahasia-abc@example.com",
      ownerName: "Dokter Rahasia",
      status: "trial",
      referralCode: "ANDI6020",
      nowMs: BASE_NOW_MS + DAY_MS,
    });

    // 1) Tenant 1 first payment (net 179.000 -> 60% = 107.400) -> matures on Dec 15 -> batched -> marked paid!
    const c1 = await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: tenant1.tenantId,
      receiptId: "rcpt_t1_first",
      grossAmountIdr: 179_000,
      isConfirmed: true,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    expect(c1.status).toBe("created");
    if (c1.status !== "created") throw new Error("expected created");

    // 2) Tenant 1 renewal (net 179.000 -> 20% = 35.800) on Dec 2 -> matures Dec 16 (approved, unbatched on Dec 20)
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: tenant1.tenantId,
      receiptId: "rcpt_t1_ren1",
      grossAmountIdr: 179_000,
      isConfirmed: true,
      confirmedAtMs: BASE_NOW_MS + DAY_MS,
      nowMs: BASE_NOW_MS + DAY_MS,
    });

    // 3) Tenant 1 second renewal on Dec 18 -> still pending (within 14-day hold on Dec 20)
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: tenant1.tenantId,
      receiptId: "rcpt_t1_ren2",
      grossAmountIdr: 179_000,
      isConfirmed: true,
      confirmedAtMs: PAYOUT_DEC_15_MS + 3 * DAY_MS,
      nowMs: PAYOUT_DEC_15_MS + 3 * DAY_MS,
    });

    // Promote Dec 1 entry -> build Dec 15 batch -> resolve REQ-095 -> mark paid!
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: PAYOUT_DEC_15_MS });
    const batch1 = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, { nowMs: PAYOUT_DEC_15_MS });
    expect(batch1.createdBatchCount).toBe(1);
    const paidBatchId = batch1.batches[0]!.id;

    // Resolve REQ-095 compliance via console endpoint
    const compRes = await handleConsoleAffiliateComplianceRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/affiliates/compliance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: op.cookieHeader,
        },
        body: JSON.stringify({
          affiliateTermsPublished: true,
          affiliateTaxReviewCompleted: true,
          reason: "Konfirmasi REQ-095 ketentuan afiliasi dan review PPh selesai.",
        }),
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(compRes.status).toBe(200);

    // Mark batch 1 paid (with fresh 2FA at PAYOUT_DEC_15_MS)
    await grantConsoleOperator({
      userId: op.userId,
      sessionId: op.sessionId,
      verifiedAtMs: PAYOUT_DEC_15_MS,
      nowMs: PAYOUT_DEC_15_MS,
    });
    await refreshSessionTimestamp(op.sessionId, PAYOUT_DEC_15_MS);

    const markPaidRes = await handleConsoleMarkPayoutBatchPaidRequest(
      paidBatchId,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/batches/${encodeURIComponent(paidBatchId)}/mark-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: op.cookieHeader,
          },
          body: JSON.stringify({
            transferReference: "TRF-BCA-20261215-777",
            expectedVersion: 1,
            reason: "Transfer bank manual batch periode 15 Desember telah terkonfirmasi.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(markPaidRes.status).toBe(200);

    // Promote Dec 2 renewal (35.800) on Dec 20 AND create a post-payout refund offset (-107.400) for c1!
    const dec20Ms = PAYOUT_DEC_15_MS + 5 * DAY_MS;
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: dec20Ms });
    const revRes = await reverseCommissionForRefund(env.PLATFORM_DB, {
      commissionEntryId: c1.entry.id,
      refundReference: "REF-POST-001",
      reason: "Refund terkonfirmasi setelah batch pencairan dibayar.",
      actorUserId: op.userId,
      actorRole: "platform_operator",
      nowMs: dec20Ms,
    });
    expect(revRes.status).toBe("offset_created");

    // Refresh affiliate session timestamp for Dec 20
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(dec20Ms, dec20Ms, dec20Ms + 7 * DAY_MS, affUser.sessionId)
      .run();

    const overviewRes = await handleAffiliateOverviewRequest(
      new Request(`${APP_ORIGIN}/api/affiliate/overview`, {
        headers: { Cookie: affUser.cookieHeader },
      }),
      buildAppEnv(),
      { nowMs: dec20Ms },
    );
    expect(overviewRes.status).toBe(200);
    const rawJson = await overviewRes.text();
    const overview = JSON.parse(rawJson) as {
      readonly success: boolean;
      readonly affiliate: { readonly referralLink: string; readonly referralCode: string };
      readonly funnel: {
        readonly visitsCount: number;
        readonly registrationsCount: number;
        readonly trialsCount: number;
        readonly payingTenantsCount: number;
      };
      readonly balances: {
        readonly pendingIdr: number;
        readonly approvedAvailableIdr: number;
        readonly batchedIdr: number;
        readonly paidIdr: number;
        readonly unbatchedReversalOffsetIdr: number;
        readonly netAvailableForNextPayoutIdr: number;
      };
      readonly nextPayout: { readonly dateKey: string; readonly timezone: string };
      readonly referredTenants: readonly { readonly maskedHandle: string }[];
      readonly payoutBatches: readonly {
        readonly id: string;
        readonly status: string;
        readonly transferReference: string | null;
      }[];
    };

    expect(overview.success).toBe(true);
    expect(overview.affiliate.referralLink).toBe("https://punyasitus.com/?ref=ANDI6020");
    expect(overview.funnel.visitsCount).toBe(17);
    expect(overview.funnel.registrationsCount).toBe(2);
    expect(overview.funnel.trialsCount).toBe(1);
    expect(overview.funnel.payingTenantsCount).toBe(1);

    // Exact integer IDR ledger balances!
    expect(overview.balances.pendingIdr).toBe(35_800); // Dec 18 renewal in 14d hold
    expect(overview.balances.paidIdr).toBe(107_400); // Dec 15 paid batch
    expect(overview.balances.unbatchedReversalOffsetIdr).toBe(-107_400); // Post-payout clawback offset
    expect(overview.balances.approvedAvailableIdr).toBe(35_800 - 107_400); // -71.600 net available!
    expect(overview.balances.netAvailableForNextPayoutIdr).toBe(-71_600);
    expect(overview.nextPayout.dateKey).toBe("2026-12-30");
    expect(overview.nextPayout.timezone).toBe("Asia/Jakarta");

    // Masked handles ONLY!
    const maskedHandles = overview.referredTenants.map((t) => t.maskedHandle);
    expect(maskedHandles).toContain("ko***ra");
    expect(maskedHandles).toContain("a***c");

    // Payout batch history shows paid batch with transfer reference
    expect(overview.payoutBatches).toHaveLength(1);
    expect(overview.payoutBatches[0]?.status).toBe("paid");
    expect(overview.payoutBatches[0]?.transferReference).toBe("TRF-BCA-20261215-777");

    // CRITICAL ZERO TENANT PII LEAKAGE ASSERTIONS
    for (const forbidden of [
      "kopinusantara",
      "kopinusantara.situsku.click",
      "CV Kopi Nusantara Rahasia",
      "rahasia-kopi@example.com",
      "Bambang Pemilik Kopi",
      "abc.situsku.click",
      "Klinik Rahasia ABC",
      "rahasia-abc@example.com",
      "Dokter Rahasia",
      tenant1.tenantId,
      tenant2.tenantId,
      "5544332211", // raw payout bank account number must never appear!
    ]) {
      expect(rawJson, `Affiliate overview leaked forbidden PII/value: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("enforces console 2FA step-up, RBAC, CSRF, OCC, REQ-095 compliance gate (422), audit trail, and safe CSV export", async () => {
    const superOp = await createSurfaceSession({
      surface: "console",
      email: "super-op@example.com",
      name: "Super Operator",
      nowMs: BASE_NOW_MS,
    });
    await grantConsoleOperator({
      userId: superOp.userId,
      sessionId: superOp.sessionId,
      role: "platform_superadmin",
      verifiedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });

    const supportOp = await createSurfaceSession({
      surface: "console",
      email: "support-op@example.com",
      name: "Support Operator",
      nowMs: BASE_NOW_MS,
    });
    await grantConsoleOperator({
      userId: supportOp.userId,
      sessionId: supportOp.sessionId,
      role: "platform_support",
      verifiedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });

    // Pending affiliate with formula-injection attempt in account holder name (for CSV safety check!)
    const aff1User = await createSurfaceSession({
      surface: "app",
      email: "aff-csv@example.com",
      name: "Mitra CSV",
      nowMs: BASE_NOW_MS,
    });
    const app1 = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: aff1User.userId,
      payload: {
        payoutBankCode: "BCA",
        payoutAccountNumber: "1234567890",
        payoutAccountHolder: "=CMD|' /C calc'!A0",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });

    // 1. Non-console host -> 404
    const wrongHost = await handleConsoleAffiliatesListRequest(
      new Request(`${APP_ORIGIN}/api/console/affiliates`, {
        headers: { Cookie: superOp.cookieHeader },
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(wrongHost.status).toBe(404);

    // 2. Missing CSRF Origin on status mutation -> 403
    const noOrigin = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 1,
            reason: "Menyetujui mitra afiliasi tanpa origin header.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(noOrigin.status).toBe(403);

    // 3. Stale 2FA (> 10 minutes) -> 403 REAUTH_REQUIRED
    const stale2fa = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 1,
            reason: "Menyetujui mitra afiliasi dengan 2FA kedaluwarsa.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS + 11 * 60 * 1000 },
    );
    expect(stale2fa.status).toBe(403);
    const stale2faBody = (await stale2fa.json()) as { readonly code: string };
    expect(stale2faBody.code).toBe("REAUTH_REQUIRED");

    // 4. `platform_support` operator blocked on status mutation -> 403 FORBIDDEN
    const supportDenied = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: supportOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 1,
            reason: "Support mencoba menyetujui akun afiliasi tanpa izin.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(supportDenied.status).toBe(403);

    // 5. Short reason (< 10 chars) -> 422 VALIDATION_ERROR
    const shortReason = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 1,
            reason: "ok",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(shortReason.status).toBe(422);

    // 6. Stale OCC expectedVersion -> 409 STALE_VERSION
    const staleOcc = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 99,
            reason: "Menyetujui mitra afiliasi dengan expectedVersion usang.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(staleOcc.status).toBe(409);

    // 7. Valid approve via POST /status -> 200, issues referral code, bumps version to 2, writes platform_audit
    const approveRes = await handleConsoleAffiliateStatusRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "approve",
            expectedVersion: 1,
            referralCode: "CSVMITRA",
            reason: "Identitas dan rekening pencairan mitra telah diverifikasi.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(approveRes.status).toBe(200);
    const approvedData = (await approveRes.json()) as {
      readonly affiliate: { readonly status: string; readonly referralCode: string; readonly version: number };
      readonly auditId: string;
    };
    expect(approvedData.affiliate.status).toBe("active");
    expect(approvedData.affiliate.referralCode).toBe("CSVMITRA");
    expect(approvedData.affiliate.version).toBe(2);
    expect(approvedData.auditId).toBeTruthy();

    // Seed commission + payout batch for this affiliate
    const tenant = await createReferredTenant({
      id: "ten_comp_1",
      handle: "warung-soto",
      businessName: "Warung Soto Rahasia",
      ownerEmail: "soto@example.com",
      ownerName: "Pak Soto",
      status: "active",
      referralCode: "CSVMITRA",
      nowMs: BASE_NOW_MS,
    });
    await recordConfirmedPaymentCommission(env.PLATFORM_DB, {
      tenantId: tenant.tenantId,
      receiptId: "rcpt_comp_1",
      grossAmountIdr: 179_000,
      isConfirmed: true,
      confirmedAtMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS,
    });
    await promoteMaturedPendingCommissions(env.PLATFORM_DB, { nowMs: PAYOUT_DEC_15_MS });
    const built = await buildBiMonthlyAffiliatePayoutBatches(env.PLATFORM_DB, { nowMs: PAYOUT_DEC_15_MS });
    expect(built.createdBatchCount).toBe(1);
    const batchId = built.batches[0]!.id;

    // Refresh operator session + 2FA to PAYOUT_DEC_15_MS
    await grantConsoleOperator({
      userId: superOp.userId,
      sessionId: superOp.sessionId,
      verifiedAtMs: PAYOUT_DEC_15_MS,
      nowMs: PAYOUT_DEC_15_MS,
    });
    await refreshSessionTimestamp(superOp.sessionId, PAYOUT_DEC_15_MS);

    // 8. REQ-095 Gate UNRESOLVED -> mark-paid MUST FAIL with 422 AFFILIATE_COMPLIANCE_INCOMPLETE!
    const blockedCompliance = await handleConsoleMarkPayoutBatchPaidRequest(
      batchId,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/batches/${encodeURIComponent(batchId)}/mark-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            transferReference: "TRF-BLOCKED-001",
            expectedVersion: 1,
            reason: "Mencoba menandai batch dibayar sebelum REQ-095 diselesaikan.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(blockedCompliance.status).toBe(422);
    const blockedBody = (await blockedCompliance.json()) as {
      readonly code: string;
      readonly missing: readonly string[];
    };
    expect(blockedBody.code).toBe("AFFILIATE_COMPLIANCE_INCOMPLETE");
    expect(blockedBody.missing).toContain("platform_affiliate_terms_pending");
    expect(blockedBody.missing).toContain("platform_affiliate_tax_review_pending");

    // Verify batch stayed pending_review in DB
    const stillPending = await env.PLATFORM_DB.prepare(
      "SELECT status FROM affiliate_commission_payout_batches WHERE id = ?",
    )
      .bind(batchId)
      .first<{ readonly status: string }>();
    expect(stillPending?.status).toBe("pending_review");

    // 9. Resolve REQ-095 platform compliance via POST /api/console/affiliates/compliance
    const resolveComp = await handleConsoleAffiliateComplianceRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/affiliates/compliance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: superOp.cookieHeader,
        },
        body: JSON.stringify({
          affiliateTermsPublished: true,
          affiliateTaxReviewCompleted: true,
          reason: "Dokumen ketentuan afiliasi dan review pajak PPh 21/23 telah selesai.",
        }),
      }),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(resolveComp.status).toBe(200);

    // 10. Stale OCC version on mark-paid -> 409 STALE_VERSION
    const staleBatchOcc = await handleConsoleMarkPayoutBatchPaidRequest(
      batchId,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/batches/${encodeURIComponent(batchId)}/mark-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            transferReference: "TRF-BCA-20261215-999",
            expectedVersion: 5,
            reason: "Mencoba menandai batch dibayar dengan expectedVersion usang.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(staleBatchOcc.status).toBe(409);

    // 11. Now mark-paid succeeds with transferReference + atomic platform_audit!
    const paidRes = await handleConsoleMarkPayoutBatchPaidRequest(
      batchId,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/batches/${encodeURIComponent(batchId)}/mark-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            transferReference: "+TRF-BCA-20261215-999",
            expectedVersion: 1,
            reason: "Transfer bank manual periode 15 Desember telah terkonfirmasi lunas.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(paidRes.status).toBe(200);
    const paidJson = (await paidRes.json()) as {
      readonly batch: { readonly status: string; readonly transferReference: string };
      readonly paidEntryCount: number;
      readonly auditId: string;
    };
    expect(paidJson.batch.status).toBe("paid");
    expect(paidJson.batch.transferReference).toBe("+TRF-BCA-20261215-999");
    expect(paidJson.paidEntryCount).toBe(1);
    expect(paidJson.auditId).toBeTruthy();

    // 12. Suspend affiliate via PATCH /api/console/affiliates/[affiliateId]
    const suspendRes = await handleConsoleAffiliateDetailRequest(
      app1.affiliate.id,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/${encodeURIComponent(app1.affiliate.id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            action: "suspend",
            expectedVersion: 2,
            reason: "Menangguhkan sementara akun afiliasi untuk audit kepatuhan.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(suspendRes.status).toBe(200);

    // 13. Safe CSV exports escape formula-injection characters!
    const affCsvRes = await handleConsoleAffiliatesListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/affiliates?format=csv&export=affiliates`, {
        headers: { Cookie: superOp.cookieHeader },
      }),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(affCsvRes.status).toBe(200);
    expect(affCsvRes.headers.get("content-type")).toContain("text/csv");
    const affCsvText = await affCsvRes.text();
    expect(affCsvText).toContain("'=CMD|' /C calc'!A0");
    expect(affCsvText).not.toContain(",=CMD|");

    const batchCsvRes = await handleConsoleAffiliatesListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/affiliates?format=csv&export=batches`, {
        headers: { Cookie: superOp.cookieHeader },
      }),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(batchCsvRes.status).toBe(200);
    const batchCsvText = await batchCsvRes.text();
    expect(batchCsvText).toContain("'+TRF-BCA-20261215-999");
    expect(batchCsvText).toContain("'=CMD|' /C calc'!A0");

    // 14. Verify platform_audit recorded approve, compliance, paid, suspend, and csv exports
    const auditLogs = await listPlatformAuditEntries(env.PLATFORM_DB, { limit: 50 });
    const actions = auditLogs.map((a) => a.action);
    expect(actions).toContain("console.affiliate.approve");
    expect(actions).toContain("console.affiliate.compliance.update");
    expect(actions).toContain("affiliate.payout_batch.paid");
    expect(actions).toContain("console.affiliate.suspend");
    expect(actions).toContain("console.affiliates.export_csv");

    // 15. Even when platform REQ-095 is resolved, an affiliate missing `terms_accepted_at` is STILL blocked (422)
    const noTermsUser = await createSurfaceSession({
      surface: "app",
      email: "legacy-noterms@example.com",
      name: "Legacy Affiliate",
      nowMs: PAYOUT_DEC_15_MS,
    });
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO affiliates (id, user_id, referral_code, status, payout_method, payout_account_name, payout_account_number, version, created_at, updated_at)
         VALUES ('aff_noterms', ?, 'NOTERMS1', 'active', 'BCA', 'Legacy Affiliate', '******1111', 1, ?, ?)`,
      ).bind(noTermsUser.userId, PAYOUT_DEC_15_MS, PAYOUT_DEC_15_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO affiliate_commission_payout_batches (id, affiliate_id, payout_period_key, total_amount_idr, entry_count, status, version, created_at, updated_at)
         VALUES ('bat_noterms', 'aff_noterms', '2026-12-30', 120000, 1, 'pending_review', 1, ?, ?)`,
      ).bind(PAYOUT_DEC_30_MS, PAYOUT_DEC_30_MS),
    ]);

    const noTermsBlocked = await handleConsoleMarkPayoutBatchPaidRequest(
      "bat_noterms",
      new Request(
        `${CONSOLE_ORIGIN}/api/console/affiliates/batches/bat_noterms/mark-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: superOp.cookieHeader,
          },
          body: JSON.stringify({
            transferReference: "TRF-NOTERMS-001",
            expectedVersion: 1,
            reason: "Mencoba menandai batch afiliasi tanpa terms_accepted_at dibayar.",
          }),
        },
      ),
      buildConsoleEnv(),
      { nowMs: PAYOUT_DEC_15_MS },
    );
    expect(noTermsBlocked.status).toBe(422);
    const noTermsBody = (await noTermsBlocked.json()) as {
      readonly code: string;
      readonly missing: readonly string[];
    };
    expect(noTermsBody.code).toBe("AFFILIATE_COMPLIANCE_INCOMPLETE");
    expect(noTermsBody.missing).toContain("affiliate_terms_not_accepted");
  });
});
