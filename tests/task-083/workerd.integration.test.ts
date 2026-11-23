import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import {
  AgencyGuardError,
  assertClientBillingAccessForTenant,
  createAgencyUserFixture,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import {
  buildServiceAccessViewModel,
  loadLiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import type { ConsoleRuntimeEnv } from "@punyasitus/auth/platform/index";
import {
  DAY_MS,
  DEFAULT_MONTHLY_PRICE_IDR,
  createMockOnlyVerifiedSettlementPolicy,
} from "@punyasitus/core/billing/index";
import { inspectReceiptPdf } from "@punyasitus/core/billing/receipt-pdf";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import {
  addAgencyMember,
  applyAgencyPortalMigration,
  getAgencyById,
  revokeAgencyMember,
} from "@punyasitus/db/agencies/index";
import {
  ensureBillingObligationsSchema,
  ensureBillingReconciliationSchema,
} from "@punyasitus/db/billing/index";
import { applyBillingReceiptsMigration } from "@punyasitus/db/billing/receipts/index";
import { applyPlatformMigrations } from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAgencyBillingCheckoutRequest } from "../../apps/web/src/pages/api/agency/billing/checkout.ts";
import { handleAgencyBillingOverviewRequest } from "../../apps/web/src/pages/api/agency/billing/index.ts";
import { handleAgencyBillingReceiptPdfRequest } from "../../apps/web/src/pages/api/agency/billing/receipts/[receiptId]/pdf.ts";
import { handleAgencyBillingReconcileRequest } from "../../apps/web/src/pages/api/agency/billing/reconcile.ts";
import { handleAgencyClientDetailRequest } from "../../apps/web/src/pages/api/agency/clients/[tenantId]/index.ts";
import { handleAgencyClientSwitchRequest } from "../../apps/web/src/pages/api/agency/clients/[tenantId]/switch.ts";
import { handleAgencyClientsRequest } from "../../apps/web/src/pages/api/agency/clients/index.ts";
import { handleAgencyEnrollRequest } from "../../apps/web/src/pages/api/agency/enroll.ts";
import { handleAgencyOverviewRequest } from "../../apps/web/src/pages/api/agency/index.ts";
import { handleAgencyInvitationAcceptRequest } from "../../apps/web/src/pages/api/agency/invitations/accept.ts";
import { handleAgencyReceiptPdfRequest } from "../../apps/web/src/pages/api/agency/receipts/[receiptId]/pdf.ts";
import { handleAgencyReceiptsListRequest } from "../../apps/web/src/pages/api/agency/receipts/index.ts";
import { handleConsoleAgencyDetailRequest } from "../../apps/web/src/pages/api/console/agencies/[agencyId].ts";
import { handleConsoleAgenciesRequest } from "../../apps/web/src/pages/api/console/agencies/index.ts";
import { handleTenantBillingOverviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/index.ts";
import { handleTenantBillingReceiptsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/index.ts";
import { runBillingLifecycleAndReminderSweep } from "../../apps/web/src/worker/queues/billing/lifecycle-sweep.ts";
import type { AutoLarisBillingClient } from "../../packages/integrations/src/autolaris/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TENANT_ORIGIN = "https://klien-t083.situsku.click";
const TEST_APP_SECRET = "task083-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task083-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 2, 10, 10, 0, 0); // 2026-03-10T17:00:00+07:00
const MOCK_POLICY = createMockOnlyVerifiedSettlementPolicy();

function buildAppEnv(): AgencyRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function buildConsoleEnv(): ConsoleRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function createAppAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: TEST_APP_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
  });
}

function createConsoleAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: TEST_CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
}

function createFakeAutoLarisClient(options: { readonly paid?: boolean } = {}): AutoLarisBillingClient {
  let seq = 1;
  const submitted = new Map<string, { readonly reffId: string; readonly totalPayableIdr: number }>();

  return {
    providerAccountId: "mock_agency_acct",
    relayOrigin: "https://relay.example.test",
    listPaymentChannels: async () => [
      {
        code: "QRIS",
        kind: "QRIS",
        label: "QRIS",
        feeType: "fix",
        rawFeeValue: "1500",
        estimatedFeeIdr: 1_500,
        enabled: true,
      },
      {
        code: "VA_BCA",
        kind: "VA",
        label: "BCA Virtual Account",
        feeType: "fix",
        rawFeeValue: "4000",
        estimatedFeeIdr: 4_000,
        enabled: true,
      },
    ],
    submitDigitalSubscriptionOrder: async (params) => {
      const trxId = `TRX-AG-${seq++}-${params.reffId}`;
      const fee = params.channelKind === "QRIS" ? 1_500 : 4_000;
      const totalPayableIdr = params.netAmountIdr + fee;
      const expiresAtMs = BASE_NOW_MS + 3_600_000;
      submitted.set(trxId, { reffId: params.reffId, totalPayableIdr });
      return {
        providerAccountId: "mock_agency_acct",
        providerTransactionId: trxId,
        reffId: params.reffId,
        channelKind: params.channelKind,
        channelCode: params.channelCode,
        channelFeeIdr: fee,
        grossAdminFeeIdr: fee,
        providerDiscountIdr: 0,
        totalPayableIdr,
        qrisPayload: params.channelKind === "QRIS" ? "00020101021226300014ID.TEST.QRIS5802ID6304ABCD" : null,
        vaNumber: params.channelKind === "VA" ? "8801234567890" : null,
        bankName: params.channelKind === "VA" ? "BCA" : null,
        paymentRedirectUrl: null,
        expiresAtMs,
        expiresAtIso: new Date(expiresAtMs).toISOString(),
      };
    },
    checkTransactionAdvice: async ({ providerTransactionId }) => {
      const meta = submitted.get(providerTransactionId);
      const isPaid = options.paid !== false;
      return {
        rc: isPaid ? "00" : "02",
        ket: isPaid ? "SETTLEMENT_CONFIRMED" : "PENDING",
        providerTransactionId,
        reffId: meta?.reffId ?? null,
        paymentStatus: isPaid ? "PAID_SETTLED" : "PENDING",
        shippingStatus: null,
        paidAmountIdr: isPaid ? (meta?.totalPayableIdr ?? null) : null,
        currency: "IDR",
        settledAtMs: isPaid ? BASE_NOW_MS + 60_000 : null,
      };
    },
  };
}

async function resetTables(): Promise<void> {
  // Note: `payment_receipts`, `receipt_yearly_counters`, and `platform_audit` are append-only / monotonic;
  // never reset `receipt_yearly_counters` out of sync with immutable `payment_receipts` & R2 objects.
  const tables = [
    "billing_renewal_pay_links",
    "billing_refund_records",
    "billing_reconciliation_leases",
    "entitlement_grants",
    "settlements",
    "payment_attempts",
    "billing_obligations",
    "agency_client_links",
    "agency_invitations",
    "agency_members",
    "agency_enrollment_records",
    "tenant_hosts",
    "tenants",
    "agencies",
    "invitations",
    "members",
    "organizations",
    "platform_operators",
    "session_two_factor_verifications",
    "two_factors",
    "sessions",
    "accounts",
    "users",
    "email_delivery_claims",
  ];
  await env.PLATFORM_DB.prepare("PRAGMA foreign_keys = OFF").run();
  for (const t of tables) {
    try {
      await env.PLATFORM_DB.prepare(`DELETE FROM ${t}`).run();
    } catch {
      // Ignore optional tables not created yet
    }
  }
  await env.PLATFORM_DB.prepare("PRAGMA foreign_keys = ON").run();
}

describe("TASK-083: Agency Portal, Client Provisioning & Agency-Payer Billing (workerd)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureBillingObligationsSchema(env.PLATFORM_DB);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB);
    await applyBillingReceiptsMigration(env.PLATFORM_DB);
    await applyAgencyPortalMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await resetTables();
  });

  it("blocks un-enrolled and unverified 2FA agency users on every /api/agency/** route and enforces CSRF/Origin", async () => {
    const appAuth = createAppAuth();
    const appEnv = buildAppEnv();

    // 1. User WITHOUT TOTP enrolled -> 403 TOTP_ENROLLMENT_REQUIRED on EVERY /api/agency/** route
    const no2fa = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "no2fa-agency@example.com",
      password: "AgencyPassword!2026",
      name: "Tanpa 2FA",
      enrollTwoFactor: false,
      nowMs: BASE_NOW_MS,
    });

    const unverifiedSession = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "unverified-session@example.com",
      password: "AgencyPassword!2026",
      name: "Belum Verif Sesi",
      enrollTwoFactor: true,
      verifySessionTwoFactor: false,
      nowMs: BASE_NOW_MS,
    });

    const allAgencyEndpointCalls = (cookie: string) => [
      handleAgencyOverviewRequest(
        new Request(`${APP_ORIGIN}/api/agency`, { headers: { cookie } }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyEnrollRequest(
        new Request(`${APP_ORIGIN}/api/agency/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie },
          body: JSON.stringify({ agencyName: "Studio Tanpa 2FA", acceptTerms: true }),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyInvitationAcceptRequest(
        new Request(`${APP_ORIGIN}/api/agency/invitations/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie },
          body: JSON.stringify({ token: "0".repeat(32), acceptTerms: true }),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyClientsRequest(
        new Request(`${APP_ORIGIN}/api/agency/clients`, { headers: { cookie } }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyClientDetailRequest(
        "01JTESTCLIENT0000000000001",
        new Request(`${APP_ORIGIN}/api/agency/clients/01JTESTCLIENT0000000000001`, {
          headers: { cookie },
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyClientSwitchRequest(
        "01JTESTCLIENT0000000000001",
        new Request(`${APP_ORIGIN}/api/agency/clients/01JTESTCLIENT0000000000001/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie },
          body: JSON.stringify({}),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyBillingOverviewRequest(
        new Request(`${APP_ORIGIN}/api/agency/billing`, { headers: { cookie } }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyBillingCheckoutRequest(
        new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: APP_ORIGIN,
            "Idempotency-Key": crypto.randomUUID(),
            cookie,
          },
          body: JSON.stringify({ tenantId: "t1", plan: "monthly", channelCode: "QRIS" }),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyBillingReconcileRequest(
        new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie },
          body: JSON.stringify({ tenantId: "t1", attemptId: "a1" }),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyBillingReceiptPdfRequest(
        "rcpt_1",
        new Request(`${APP_ORIGIN}/api/agency/billing/receipts/rcpt_1/pdf`, {
          headers: { cookie },
        }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyReceiptsListRequest(
        new Request(`${APP_ORIGIN}/api/agency/receipts`, { headers: { cookie } }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
      handleAgencyReceiptPdfRequest(
        "rcpt_1",
        new Request(`${APP_ORIGIN}/api/agency/receipts/rcpt_1/pdf`, { headers: { cookie } }),
        appEnv,
        { nowMs: BASE_NOW_MS },
      ),
    ];

    for (const res of await Promise.all(allAgencyEndpointCalls(no2fa.cookieHeader))) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("TOTP_ENROLLMENT_REQUIRED");
    }

    for (const res of await Promise.all(allAgencyEndpointCalls(unverifiedSession.cookieHeader))) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("TOTP_REQUIRED");
    }

    // Unverified email even WITH 2FA enabled -> 403 EMAIL_NOT_VERIFIED
    const unverifiedEmailUser = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "unverified-email-2fa@example.com",
      password: "AgencyPassword!2026",
      emailVerified: false,
      enrollTwoFactor: true,
      verifySessionTwoFactor: true,
      nowMs: BASE_NOW_MS,
    });
    const unverifiedEmailRes = await handleAgencyOverviewRequest(
      new Request(`${APP_ORIGIN}/api/agency`, {
        headers: { cookie: unverifiedEmailUser.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unverifiedEmailRes.status).toBe(403);
    expect(((await unverifiedEmailRes.json()) as { error: { code: string } }).error.code).toBe(
      "EMAIL_NOT_VERIFIED",
    );

    // 3. CSRF / Origin enforcement on POST /api/agency/enroll (bad tenant origin -> 403)
    const enrolled = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "csrf-agency@example.com",
      password: "AgencyPassword!2026",
      name: "Agensi CSRF",
      enrollTwoFactor: true,
      verifySessionTwoFactor: true,
      nowMs: BASE_NOW_MS,
    });

    const badOriginRes = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: TENANT_ORIGIN,
          cookie: enrolled.cookieHeader,
        },
        body: JSON.stringify({ agencyName: "Studio CSRF", acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 4. Tenant host isolation -> neutral 404
    const wrongHostRes = await handleAgencyOverviewRequest(
      new Request(`${TENANT_ORIGIN}/api/agency`, {
        headers: { cookie: enrolled.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(wrongHostRes.status).toBe(404);
  });

  it("supports self-registration (0% initial discount), operator invite with 2FA step-up + audit, and console volume discount tiers", async () => {
    const appAuth = createAppAuth();
    const consoleAuth = createConsoleAuth();
    const appEnv = buildAppEnv();
    const consoleEnv = buildConsoleEnv();

    // 1. Self-registration requires acceptTerms=true and starts at 0% discount + cap 3
    const selfUser = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "self-agency@example.com",
      password: "AgencyPassword!2026",
      name: "Budi Agensi",
      nowMs: BASE_NOW_MS,
    });

    const missingTerms = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: selfUser.cookieHeader,
        },
        body: JSON.stringify({ agencyName: "Nusantara Web", acceptTerms: false }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(missingTerms.status).toBe(422);

    const selfRegRes = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: selfUser.cookieHeader,
        },
        body: JSON.stringify({
          agencyName: "Nusantara Web Studio",
          billingEmail: "billing@nusantaraweb.id",
          acceptTerms: true,
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(selfRegRes.status).toBe(201);
    const selfRegBody = (await selfRegRes.json()) as {
      agency: { id: string; baseDiscountPercent: number; effectiveDiscountPercent: number; unpaidTrialCap: number; version: number };
    };
    expect(selfRegBody.agency.baseDiscountPercent).toBe(0);
    expect(selfRegBody.agency.effectiveDiscountPercent).toBe(0);
    expect(selfRegBody.agency.unpaidTrialCap).toBe(3);

    // 2. Operator invites another agency via /api/console/agencies (requires fresh 2FA step-up!)
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-agencies@punyasitus.com",
      password: "ConsoleOpPassword!2026",
      name: "Superadmin Agensi",
      nowMs: BASE_NOW_MS,
    });

    // Stale 2FA (> 10 minutes) MUST fail with 403 RECENT_SECOND_FACTOR_REQUIRED
    const staleRes = await handleConsoleAgenciesRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          email: "invited-partner@example.com",
          agencyName: "Mitra Digital Invited",
          reason: "Undangan mitra agensi resmi Q4",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 5_000 },
    );
    expect(staleRes.status).toBe(403);

    // Valid fresh 2FA step-up + CSRF -> 201 + hashed token + platform_audit
    const inviteRes = await handleConsoleAgenciesRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          email: "invited-partner@example.com",
          agencyName: "Mitra Digital Invited",
          reason: "Undangan mitra agensi resmi Q4",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(inviteRes.status).toBe(201);
    const inviteBody = (await inviteRes.json()) as {
      inviteToken: string;
      invitation: { id: string; email: string };
      auditId: string;
    };
    expect(inviteBody.inviteToken.length).toBeGreaterThanOrEqual(32);

    // Raw token MUST NEVER be stored in agency_invitations
    const rawRow = await env.PLATFORM_DB.prepare(
      "SELECT token_hash FROM agency_invitations WHERE id = ?",
    )
      .bind(inviteBody.invitation.id)
      .first<{ token_hash: string }>();
    expect(rawRow?.token_hash).toBeTruthy();
    expect(rawRow?.token_hash).not.toBe(inviteBody.inviteToken);

    // Wrong email trying to accept -> 403 INVITATION_EMAIL_MISMATCH
    const wrongInvitee = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "intruder@example.com",
      password: "AgencyPassword!2026",
      nowMs: BASE_NOW_MS,
    });
    const wrongAccept = await handleAgencyInvitationAcceptRequest(
      new Request(`${APP_ORIGIN}/api/agency/invitations/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: wrongInvitee.cookieHeader,
        },
        body: JSON.stringify({ token: inviteBody.inviteToken, acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(wrongAccept.status).toBe(403);

    // Matching verified 2FA invitee accepts -> 201 with 0% initial discount
    const rightInvitee = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "invited-partner@example.com",
      password: "AgencyPassword!2026",
      name: "Mitra Invited",
      nowMs: BASE_NOW_MS,
    });
    const rightAccept = await handleAgencyInvitationAcceptRequest(
      new Request(`${APP_ORIGIN}/api/agency/invitations/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: rightInvitee.cookieHeader,
        },
        body: JSON.stringify({ token: inviteBody.inviteToken, acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(rightAccept.status).toBe(201);
    const rightAcceptBody = (await rightAccept.json()) as {
      agency: { baseDiscountPercent: number; enrollmentSource: string };
    };
    expect(rightAcceptBody.agency.baseDiscountPercent).toBe(0);
    expect(rightAcceptBody.agency.enrollmentSource).toBe("operator_invited");

    // 3. Operator configures discount % and volume discount tiers on self-registered agency
    const patchRes = await handleConsoleAgencyDetailRequest(
      selfRegBody.agency.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies/${selfRegBody.agency.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          expectedVersion: selfRegBody.agency.version,
          discountPercent: 10,
          discountTiers: [
            { minPaidClients: 1, discountPercent: 15 },
            { minPaidClients: 5, discountPercent: 25 },
          ],
          reason: "Aktivasi tier diskon volume resmi mitra agensi",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      agency: { baseDiscountPercent: number; effectiveDiscountPercent: number; version: number; discountTiers: unknown[] };
    };
    expect(patchBody.agency.baseDiscountPercent).toBe(10);
    expect(patchBody.agency.effectiveDiscountPercent).toBe(10); // 0 paid clients so base 10% applies
    expect(patchBody.agency.discountTiers).toHaveLength(2);
    expect(patchBody.agency.version).toBe(2);

    // Stale expectedVersion -> 409 STALE_VERSION
    const stalePatch = await handleConsoleAgencyDetailRequest(
      selfRegBody.agency.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies/${selfRegBody.agency.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          expectedVersion: 1,
          discountPercent: 20,
          reason: "Percobaan tulis dengan versi kedaluwarsa",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(stalePatch.status).toBe(409);
  });

  it("enforces atomic max 3 unpaid trials until 1st paid client, cross-agency 404 isolation, audited switch, and 100% agency-payer billing isolation (reminders + PDF receipts)", async () => {
    const appAuth = createAppAuth();
    const consoleAuth = createConsoleAuth();
    const appEnv = buildAppEnv();
    const consoleEnv = buildConsoleEnv();
    const mailSink = createLocalMailSink();
    const fakeAutoLaris = createFakeAutoLarisClient({ paid: true });

    // Setup Agency 1 & Agency 2 (both 2FA verified)
    const ag1User = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "agency1@example.com",
      password: "AgencyPassword!2026",
      name: "Admin Agensi Satu",
      nowMs: BASE_NOW_MS,
    });
    const ag2User = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "agency2@example.com",
      password: "AgencyPassword!2026",
      name: "Admin Agensi Dua",
      nowMs: BASE_NOW_MS,
    });

    const ag1Enroll = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ag1User.cookieHeader },
        body: JSON.stringify({
          agencyName: "Agensi Satu Digital",
          billingEmail: "agency1@example.com",
          acceptTerms: true,
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(ag1Enroll.status).toBe(201);
    const ag1 = ((await ag1Enroll.json()) as { agency: { id: string; version: number } }).agency;

    const ag2Enroll = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ag2User.cookieHeader },
        body: JSON.stringify({
          agencyName: "Agensi Dua Kreatif",
          billingEmail: "agency2@example.com",
          acceptTerms: true,
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(ag2Enroll.status).toBe(201);

    // Operator grants Agency 1 a 10% base discount + 15% volume tier at >= 1 paid client
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-t083-full@punyasitus.com",
      password: "ConsoleOpPassword!2026",
      nowMs: BASE_NOW_MS,
    });
    const discountPatch = await handleConsoleAgencyDetailRequest(
      ag1.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies/${ag1.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN, cookie: operator.cookieHeader },
        body: JSON.stringify({
          expectedVersion: ag1.version,
          discountPercent: 10,
          discountTiers: [{ minPaidClients: 1, discountPercent: 15 }],
          reason: "Atur diskon agensi satu untuk uji billing",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(discountPatch.status).toBe(200);

    // Provision 3 unpaid trial clients for Agency 1 -> all 201
    const provisionedClients: Array<{ tenantId: string; organizationId: string; handle: string }> = [];
    for (let i = 1; i <= 3; i += 1) {
      const res = await handleAgencyClientsRequest(
        new Request(`${APP_ORIGIN}/api/agency/clients`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: APP_ORIGIN,
            "Idempotency-Key": crypto.randomUUID(),
            cookie: ag1User.cookieHeader,
          },
          body: JSON.stringify({
            name: `Klien Uji Coba ${i}`,
            handle: `klien-t083-${i}`,
            vertical: "compro",
          }),
        }),
        appEnv,
        { nowMs: BASE_NOW_MS + i * 1_000 },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        client: { tenantId: string; organizationId: string; handle: string };
      };
      provisionedClients.push(body.client);
    }

    // 4th unpaid trial BEFORE first paid client -> MUST reject with 409 AGENCY_TRIAL_LIMIT_REACHED!
    const fourthBlocked = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ag1User.cookieHeader,
        },
        body: JSON.stringify({
          name: "Klien Uji Coba 4 Diblokir",
          handle: "klien-t083-4",
          vertical: "compro",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(fourthBlocked.status).toBe(409);
    const fourthBody = (await fourthBlocked.json()) as { error: { code: string } };
    expect(fourthBody.error.code).toBe("AGENCY_TRIAL_LIMIT_REACHED");

    // Verify atomic SQLite trigger ALSO blocks direct 4th unpaid trial insert at DB level!
    const client1 = provisionedClients[0]!;
    await env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES ('org_sql_trig_test', 'Trigger Test', 'trig-test', ?, ?)`,
    )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, organization_id, agency_id, handle, name, vertical, status, created_at, updated_at)
       VALUES ('t_sql_trig_test', 'org_sql_trig_test', ?, 'trig-test-4', 'Trigger Test', 'compro', 'trial', ?, ?)`,
    )
      .bind(ag1.id, BASE_NOW_MS, BASE_NOW_MS)
      .run();
    await expect(
      env.PLATFORM_DB.prepare(
        `INSERT INTO agency_client_links (tenant_id, agency_id, billing_payer, provisioned_by_user_id, is_unpaid_trial, created_at, updated_at)
         VALUES ('t_sql_trig_test', ?, 'agency', ?, 1, ?, ?)`,
      )
        .bind(ag1.id, ag1User.user.id, BASE_NOW_MS, BASE_NOW_MS)
        .run(),
    ).rejects.toThrow(/AGENCY_TRIAL_LIMIT_REACHED/);
    // Cleanup trigger test scratch rows
    await env.PLATFORM_DB.prepare("DELETE FROM tenants WHERE id = 't_sql_trig_test'").run();
    await env.PLATFORM_DB.prepare("DELETE FROM organizations WHERE id = 'org_sql_trig_test'").run();

    // --- Cross-Agency 404 Isolation ---
    const crossDetail = await handleAgencyClientDetailRequest(
      client1.tenantId,
      new Request(`${APP_ORIGIN}/api/agency/clients/${client1.tenantId}`, {
        headers: { cookie: ag2User.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossDetail.status).toBe(404);

    const crossSwitch = await handleAgencyClientSwitchRequest(
      client1.tenantId,
      new Request(`${APP_ORIGIN}/api/agency/clients/${client1.tenantId}/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ag2User.cookieHeader },
        body: JSON.stringify({}),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossSwitch.status).toBe(404);

    const crossCheckout = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ag2User.cookieHeader,
        },
        body: JSON.stringify({ tenantId: client1.tenantId, plan: "monthly", channelCode: "QRIS" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS, autolarisClient: fakeAutoLaris },
    );
    expect(crossCheckout.status).toBe(404);

    // --- Audited Switch into Client Context + Banner Payload ---
    const switchRes = await handleAgencyClientSwitchRequest(
      client1.tenantId,
      new Request(`${APP_ORIGIN}/api/agency/clients/${client1.tenantId}/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ag1User.cookieHeader },
        body: JSON.stringify({}),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(switchRes.status).toBe(200);
    const switchBody = (await switchRes.json()) as {
      agencyClientContext: { agencyName: string; clientName: string; clientHandle: string; returnHref: string; dashboardUrl: string };
      auditId: string;
    };
    expect(switchBody.agencyClientContext.agencyName).toBe("Agensi Satu Digital");
    expect(switchBody.agencyClientContext.clientHandle).toBe("klien-t083-1");
    expect(switchBody.agencyClientContext.dashboardUrl).toBe("/dashboard/klien-t083-1");

    const switchAuditRow = await env.PLATFORM_DB.prepare(
      "SELECT actor_user_id, actor_role, action, tenant_id, metadata_json FROM platform_audit WHERE id = ?",
    )
      .bind(switchBody.auditId)
      .first<{ actor_user_id: string; actor_role: string; action: string; tenant_id: string; metadata_json: string }>();
    expect(switchAuditRow?.actor_user_id).toBe(ag1User.user.id);
    expect(switchAuditRow?.actor_role).toBe("agency_owner");
    expect(switchAuditRow?.action).toBe("agency.client.switch");
    expect(switchAuditRow?.tenant_id).toBe(client1.tenantId);
    expect(switchAuditRow?.metadata_json).toContain(ag1.id);

    // --- Agency-Payer Checkout (rejects client price/paid proof, applies 10% agency discount) ---
    const forgedPriceRes = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ag1User.cookieHeader,
        },
        body: JSON.stringify({
          tenantId: client1.tenantId,
          plan: "monthly",
          channelCode: "QRIS",
          amount: 100,
          paid: true,
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS, autolarisClient: fakeAutoLaris },
    );
    expect(forgedPriceRes.status).toBe(422);

    const checkoutRes = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ag1User.cookieHeader,
        },
        body: JSON.stringify({
          tenantId: client1.tenantId,
          plan: "monthly",
          channelCode: "QRIS",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS, autolarisClient: fakeAutoLaris },
    );
    expect(checkoutRes.status).toBe(201);
    const checkoutBody = (await checkoutRes.json()) as {
      payerType: string;
      agencyDiscountPercent: number;
      obligation: { obligationId: string; payerType: string; payerAgencyId: string; baseAmountIdr: number; discountAmountIdr: number; netAmountIdr: number };
      attempt: { attemptId: string; state: string };
    };
    expect(checkoutBody.payerType).toBe("agency");
    expect(checkoutBody.agencyDiscountPercent).toBe(10);
    expect(checkoutBody.obligation.payerType).toBe("agency");
    expect(checkoutBody.obligation.payerAgencyId).toBe(ag1.id);
    expect(checkoutBody.obligation.baseAmountIdr).toBe(DEFAULT_MONTHLY_PRICE_IDR);
    expect(checkoutBody.obligation.discountAmountIdr).toBe(Math.floor(DEFAULT_MONTHLY_PRICE_IDR * 0.1));
    expect(checkoutBody.obligation.netAmountIdr).toBe(
      DEFAULT_MONTHLY_PRICE_IDR - Math.floor(DEFAULT_MONTHLY_PRICE_IDR * 0.1),
    );
    expect(checkoutBody.attempt.state).toBe("pending");

    // --- Server-Verified AutoLaris Advice Reconciliation + PDF Receipt + Trial Cap Unlock ---
    const reconcileRes = await handleAgencyBillingReconcileRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ag1User.cookieHeader },
        body: JSON.stringify({
          tenantId: client1.tenantId,
          attemptId: checkoutBody.attempt.attemptId,
        }),
      }),
      appEnv,
      {
        nowMs: BASE_NOW_MS + 60_000,
        autolarisClient: fakeAutoLaris,
        settlementPolicy: MOCK_POLICY,
        emailPort: mailSink,
      },
    );
    expect(reconcileRes.status).toBe(200);
    const reconcileBody = (await reconcileRes.json()) as {
      reconciliation: {
        outcome: string;
        grantApplied: boolean;
        receiptId: string;
        receiptNumber: string;
      };
    };
    expect(reconcileBody.reconciliation.outcome).toBe("settled");
    expect(reconcileBody.reconciliation.grantApplied).toBe(true);
    expect(reconcileBody.reconciliation.receiptNumber).toMatch(/^PS-2026-\d{6}$/);

    // Verify Agency 1 can download the PDF receipt & Agency 2 gets neutral 404!
    const pdfRes = await handleAgencyBillingReceiptPdfRequest(
      reconcileBody.reconciliation.receiptId,
      new Request(
        `${APP_ORIGIN}/api/agency/billing/receipts/${reconcileBody.reconciliation.receiptId}/pdf`,
        { headers: { cookie: ag1User.cookieHeader } },
      ),
      appEnv,
      { nowMs: BASE_NOW_MS + 60_000 },
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    const inspected = await inspectReceiptPdf(pdfBytes);
    expect(inspected.pageCount).toBeGreaterThanOrEqual(1);

    const crossPdfRes = await handleAgencyBillingReceiptPdfRequest(
      reconcileBody.reconciliation.receiptId,
      new Request(
        `${APP_ORIGIN}/api/agency/billing/receipts/${reconcileBody.reconciliation.receiptId}/pdf`,
        { headers: { cookie: ag2User.cookieHeader } },
      ),
      appEnv,
      { nowMs: BASE_NOW_MS + 60_000 },
    );
    expect(crossPdfRes.status).toBe(404);

    // Receipt email went strictly to Agency 1's email!
    expect(mailSink.findByRecipient("agency1@example.com").length).toBeGreaterThanOrEqual(1);

    // Volume discount tier (minPaidClients: 1 -> 15%) is now active AND 4th trial client succeeds!
    const refreshedAg1 = await getAgencyById(env.PLATFORM_DB, ag1.id);
    expect(refreshedAg1?.trialQuota.paidClientCount).toBe(1);
    expect(refreshedAg1?.trialQuota.unlockedByPaidClient).toBe(true);
    expect(refreshedAg1?.effectiveDiscountPercent).toBe(15);

    const fourthUnlocked = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ag1User.cookieHeader,
        },
        body: JSON.stringify({
          name: "Klien Uji Coba 4 Terbuka",
          handle: "klien-t083-4",
          vertical: "sales",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 120_000 },
    );
    expect(fourthUnlocked.status).toBe(201);

    // --- 100% Agency-Payer Billing Isolation: Client Owner / Admin / Editor MUST get 403 ---
    const clientRoles = [
      { role: "owner" as const, email: "client-owner@example.com" },
      { role: "admin" as const, email: "client-admin@example.com" },
      { role: "editor" as const, email: "client-editor@example.com" },
    ];
    for (const cr of clientRoles) {
      const fixture = await createAgencyUserFixture(env.PLATFORM_DB, {
        auth: appAuth,
        email: cr.email,
        password: "ClientPassword!2026",
        name: `Client ${cr.role}`,
        enrollTwoFactor: false,
        nowMs: BASE_NOW_MS,
      });
      await env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(`mem_${cr.role}_${client1.tenantId.slice(-8)}`, client1.organizationId, fixture.user.id, cr.role, BASE_NOW_MS)
        .run();

      // 1) Guard helper throws 403 FORBIDDEN
      await expect(
        assertClientBillingAccessForTenant(env.PLATFORM_DB, {
          tenantId: client1.tenantId,
          userId: fixture.user.id,
          memberDbRole: cr.role,
        }),
      ).rejects.toThrow(AgencyGuardError);

      // 2) Tenant billing overview API returns 403
      const billingRes = await handleTenantBillingOverviewRequest(
        client1.tenantId,
        new Request(`${APP_ORIGIN}/api/tenants/${client1.tenantId}/billing`),
        appEnv,
        { authenticatedUser: { id: fixture.user.id }, nowMs: BASE_NOW_MS + 120_000 },
      );
      expect(billingRes.status).toBe(403);

      // 3) Tenant billing receipts API returns 403
      const receiptsRes = await handleTenantBillingReceiptsListRequest(
        client1.tenantId,
        new Request(`${APP_ORIGIN}/api/tenants/${client1.tenantId}/billing/receipts`),
        appEnv,
        { authenticatedUser: { id: fixture.user.id }, nowMs: BASE_NOW_MS + 120_000 },
      );
      expect(receiptsRes.status).toBe(403);

      // 4) UI ServiceAccessViewModel marks agencyManaged=true and isPayer=false
      const liveEnt = await loadLiveTenantEntitlement(
        env.PLATFORM_DB,
        { tenantId: client1.tenantId },
        { nowMs: BASE_NOW_MS + 120_000 },
      );
      const vm = buildServiceAccessViewModel({
        entitlement: liveEnt!,
        role: cr.role,
      });
      expect(vm.agencyManaged).toBe(true);
      expect(vm.isPayer).toBe(false);
    }

    // --- Renewal Reminder Routing: goes STRICTLY to agency email, NEVER to client owner/admin/editor ---
    const reminderSink = createLocalMailSink();
    const client2 = provisionedClients[1]!;
    // Advance clock to H-3 before client2's 7-day trial end (`trial_ends_at - 2.5 days`)
    const client2Row = await env.PLATFORM_DB.prepare(
      "SELECT trial_ends_at FROM tenants WHERE id = ?",
    )
      .bind(client2.tenantId)
      .first<{ trial_ends_at: number }>();
    const reminderNowMs = (client2Row?.trial_ends_at ?? BASE_NOW_MS + 7 * DAY_MS) - 2.5 * DAY_MS;

    await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: reminderNowMs, emailPort: reminderSink, appOrigin: APP_ORIGIN },
    );

    const client2Reminders = reminderSink.list().filter((m) => m.tenantId === client2.tenantId);
    expect(client2Reminders.length).toBeGreaterThanOrEqual(1);
    for (const msg of client2Reminders) {
      expect(msg.to).toBe("agency1@example.com");
      expect(msg.to).not.toBe("client-owner@example.com");
      expect(msg.to).not.toBe("client-admin@example.com");
      expect(msg.to).not.toBe("client-editor@example.com");
    }
  });

  it("enforces agency member RBAC matrix, atomic member revocation, single-batch atomic CAS/invite replay protection, reconcile 15s cooldown & non-exhausting polling, and pending clientOwnerEmail invite hygiene", async () => {
    const appAuth = createAppAuth();
    const consoleAuth = createConsoleAuth();
    const appEnv = buildAppEnv();
    const consoleEnv = buildConsoleEnv();

    // 1. Setup agency owner + staff member + billing member + unconsented bystander user
    const owner = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "rbac-owner@example.com",
      password: "AgencyPassword!2026",
      name: "Owner Agensi",
      nowMs: BASE_NOW_MS,
    });
    const staff = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "rbac-staff@example.com",
      password: "AgencyPassword!2026",
      name: "Staff Agensi",
      nowMs: BASE_NOW_MS,
    });
    const billing = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "rbac-billing@example.com",
      password: "AgencyPassword!2026",
      name: "Billing Agensi",
      nowMs: BASE_NOW_MS,
    });
    const bystander = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "unconsented-client@example.com",
      password: "ClientPassword!2026",
      name: "Bystander Client",
      enrollTwoFactor: false,
      nowMs: BASE_NOW_MS,
    });

    const enrollRes = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: owner.cookieHeader },
        body: JSON.stringify({ agencyName: "RBAC Studio", acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(enrollRes.status).toBe(201);
    const agency = ((await enrollRes.json()) as { agency: { id: string; version: number } }).agency;

    // Duplicate self-registration by same owner -> 409 AGENCY_ALREADY_EXISTS
    const dupSelfReg = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: owner.cookieHeader },
        body: JSON.stringify({ agencyName: "Duplicate Studio", acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(dupSelfReg.status).toBe(409);

    await addAgencyMember(env.PLATFORM_DB, {
      agencyId: agency.id,
      actorUserId: owner.user.id,
      targetUserId: staff.user.id,
      role: "agency_staff",
      nowMs: BASE_NOW_MS,
    });
    await addAgencyMember(env.PLATFORM_DB, {
      agencyId: agency.id,
      actorUserId: owner.user.id,
      targetUserId: billing.user.id,
      role: "agency_billing",
      nowMs: BASE_NOW_MS,
    });

    // Provision a client with `clientOwnerEmail` matching bystander -> MUST create pending invitation,
    // NOT silently insert bystander into `members`!
    const provRes = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: owner.cookieHeader,
        },
        body: JSON.stringify({
          name: "Klien RBAC Satu",
          handle: "klien-rbac-1",
          vertical: "compro",
          clientOwnerEmail: "unconsented-client@example.com",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(provRes.status).toBe(201);
    const client = ((await provRes.json()) as { client: { tenantId: string; organizationId: string } }).client;

    const bystanderMember = await env.PLATFORM_DB.prepare(
      "SELECT id FROM members WHERE organization_id = ? AND user_id = ?",
    )
      .bind(client.organizationId, bystander.user.id)
      .first();
    expect(bystanderMember).toBeNull();

    const pendingInvite = await env.PLATFORM_DB.prepare(
      "SELECT status, role FROM invitations WHERE organization_id = ? AND email = ?",
    )
      .bind(client.organizationId, "unconsented-client@example.com")
      .first<{ status: string; role: string }>();
    expect(pendingInvite).toEqual({ status: "pending", role: "owner" });

    // --- RBAC: `agency_staff` can read + switch, DENIED 403 on provision & ALL billing/receipts ---
    expect(
      (
        await handleAgencyClientsRequest(
          new Request(`${APP_ORIGIN}/api/agency/clients`, { headers: { cookie: staff.cookieHeader } }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await handleAgencyClientSwitchRequest(
          client.tenantId,
          new Request(`${APP_ORIGIN}/api/agency/clients/${client.tenantId}/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: staff.cookieHeader },
            body: JSON.stringify({}),
          }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await handleAgencyClientsRequest(
          new Request(`${APP_ORIGIN}/api/agency/clients`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: APP_ORIGIN,
              "Idempotency-Key": crypto.randomUUID(),
              cookie: staff.cookieHeader,
            },
            body: JSON.stringify({ name: "Staff Blocked", handle: "staff-blocked", vertical: "compro" }),
          }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await handleAgencyBillingOverviewRequest(
          new Request(`${APP_ORIGIN}/api/agency/billing`, { headers: { cookie: staff.cookieHeader } }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await handleAgencyReceiptsListRequest(
          new Request(`${APP_ORIGIN}/api/agency/receipts`, { headers: { cookie: staff.cookieHeader } }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(403);

    // --- RBAC: `agency_billing` can read billing & checkout/reconcile/receipts, DENIED 403 on provision & switch ---
    expect(
      (
        await handleAgencyClientsRequest(
          new Request(`${APP_ORIGIN}/api/agency/clients`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: APP_ORIGIN,
              "Idempotency-Key": crypto.randomUUID(),
              cookie: billing.cookieHeader,
            },
            body: JSON.stringify({ name: "Billing Blocked", handle: "billing-blocked", vertical: "compro" }),
          }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await handleAgencyClientSwitchRequest(
          client.tenantId,
          new Request(`${APP_ORIGIN}/api/agency/clients/${client.tenantId}/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: billing.cookieHeader },
            body: JSON.stringify({}),
          }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await handleAgencyBillingOverviewRequest(
          new Request(`${APP_ORIGIN}/api/agency/billing`, { headers: { cookie: billing.cookieHeader } }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await handleAgencyReceiptsListRequest(
          new Request(`${APP_ORIGIN}/api/agency/receipts`, { headers: { cookie: billing.cookieHeader } }),
          appEnv,
          { nowMs: BASE_NOW_MS },
        )
      ).status,
    ).toBe(200);

    // --- Reconcile Hardening: 15s cooldown -> 429, non-exhausting poll_count, actual actor_role in audit ---
    const pendingAutoLaris = createFakeAutoLarisClient({ paid: false });
    const checkoutRes = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: billing.cookieHeader,
        },
        body: JSON.stringify({ tenantId: client.tenantId, plan: "monthly", channelCode: "QRIS" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS, autolarisClient: pendingAutoLaris },
    );
    expect(checkoutRes.status).toBe(201);
    const attemptId = ((await checkoutRes.json()) as { attempt: { attemptId: string } }).attempt.attemptId;

    // First poll at T+20s -> 200 pending, poll_count preserved (0), audited with actor_role = 'agency_billing'
    const poll1 = await handleAgencyBillingReconcileRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: billing.cookieHeader },
        body: JSON.stringify({ tenantId: client.tenantId, attemptId }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 20_000, autolarisClient: pendingAutoLaris, settlementPolicy: MOCK_POLICY },
    );
    expect(poll1.status).toBe(200);
    const attemptAfterPoll1 = await env.PLATFORM_DB.prepare(
      `SELECT l.poll_count, l.last_polled_at, pa.lifecycle_state
       FROM payment_attempts pa
       JOIN billing_reconciliation_leases l ON l.payment_attempt_id = pa.id
       WHERE pa.id = ?`,
    )
      .bind(attemptId)
      .first<{ poll_count: number; last_polled_at: number | null; lifecycle_state: string }>();
    expect(attemptAfterPoll1?.poll_count).toBe(0);
    expect(attemptAfterPoll1?.last_polled_at).toBe(BASE_NOW_MS + 20_000);
    expect(attemptAfterPoll1?.lifecycle_state).toBe("pending");

    const reconcileAudit = await env.PLATFORM_DB.prepare(
      `SELECT actor_user_id, actor_role FROM platform_audit
       WHERE action = 'agency.billing.reconcile' AND target_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(attemptId)
      .first<{ actor_user_id: string; actor_role: string }>();
    expect(reconcileAudit).toEqual({
      actor_user_id: billing.user.id,
      actor_role: "agency_billing",
    });

    // Immediate second poll within 15s cooldown -> 429 RATE_LIMITED with Retry-After header!
    const poll2TooFast = await handleAgencyBillingReconcileRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: billing.cookieHeader },
        body: JSON.stringify({ tenantId: client.tenantId, attemptId }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 25_000, autolarisClient: pendingAutoLaris, settlementPolicy: MOCK_POLICY },
    );
    expect(poll2TooFast.status).toBe(429);
    expect(Number(poll2TooFast.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // --- Atomic Member Revocation: immediately revokes agency access AND clears client org `members` ---
    // Verify staff currently has `agency_staff` row on client org (from earlier switch)
    const staffClientMemBefore = await env.PLATFORM_DB.prepare(
      "SELECT id FROM members WHERE organization_id = ? AND user_id = ? AND role = 'agency_staff'",
    )
      .bind(client.organizationId, staff.user.id)
      .first();
    expect(staffClientMemBefore).not.toBeNull();

    await revokeAgencyMember(env.PLATFORM_DB, {
      agencyId: agency.id,
      targetUserId: staff.user.id,
      actorUserId: owner.user.id,
      nowMs: BASE_NOW_MS + 30_000,
    });

    // Revoked staff immediately loses agency portal access (403 AGENCY_MEMBERSHIP_REQUIRED)
    const revokedAccessRes = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, { headers: { cookie: staff.cookieHeader } }),
      appEnv,
      { nowMs: BASE_NOW_MS + 31_000 },
    );
    expect(revokedAccessRes.status).toBe(403);
    expect(((await revokedAccessRes.json()) as { error: { code: string } }).error.code).toBe(
      "AGENCY_MEMBERSHIP_REQUIRED",
    );

    // AND client org `members` row for revoked staff was atomically deleted!
    const staffClientMemAfter = await env.PLATFORM_DB.prepare(
      "SELECT id FROM members WHERE organization_id = ? AND user_id = ?",
    )
      .bind(client.organizationId, staff.user.id)
      .first();
    expect(staffClientMemAfter).toBeNull();

    // --- Single-batch atomic Console CAS + Invite replay protection ---
    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-atomic-t083@punyasitus.com",
      password: "ConsoleOpPassword!2026",
      nowMs: BASE_NOW_MS,
    });

    const auditCountBeforeStale = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM platform_audit WHERE action = 'console.agency.update' AND target_id = ?",
    )
      .bind(agency.id)
      .first<{ cnt: number }>();

    const staleCasRes = await handleConsoleAgencyDetailRequest(
      agency.id,
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies/${agency.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN, cookie: operator.cookieHeader },
        body: JSON.stringify({
          expectedVersion: 99,
          discountPercent: 20,
          reason: "Stale CAS check must write zero phantom audit rows",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(staleCasRes.status).toBe(409);

    const auditCountAfterStale = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM platform_audit WHERE action = 'console.agency.update' AND target_id = ?",
    )
      .bind(agency.id)
      .first<{ cnt: number }>();
    expect(auditCountAfterStale?.cnt).toBe(auditCountBeforeStale?.cnt);

    // Operator invite replay -> 409 INVALID_INVITATION with zero orphan agencies
    const invitee = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "replay-invitee@example.com",
      password: "AgencyPassword!2026",
      nowMs: BASE_NOW_MS,
    });
    const invCreate = await handleConsoleAgenciesRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/agencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN, cookie: operator.cookieHeader },
        body: JSON.stringify({
          email: "replay-invitee@example.com",
          agencyName: "Single Use Invite Agency",
          reason: "Testing single-use atomic invitation replay guard",
        }),
      }),
      consoleEnv,
      { nowMs: BASE_NOW_MS },
    );
    const invToken = ((await invCreate.json()) as { inviteToken: string }).inviteToken;

    const accept1 = await handleAgencyInvitationAcceptRequest(
      new Request(`${APP_ORIGIN}/api/agency/invitations/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: invitee.cookieHeader },
        body: JSON.stringify({ token: invToken, acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(accept1.status).toBe(201);

    const agenciesBeforeReplay = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM agencies",
    ).first<{ cnt: number }>();
    const accept2Replay = await handleAgencyInvitationAcceptRequest(
      new Request(`${APP_ORIGIN}/api/agency/invitations/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: invitee.cookieHeader },
        body: JSON.stringify({ token: invToken, acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(accept2Replay.status).toBe(409);
    const agenciesAfterReplay = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM agencies",
    ).first<{ cnt: number }>();
    expect(agenciesAfterReplay?.cnt).toBe(agenciesBeforeReplay?.cnt);
  });

  it("blocks cross-agency RBAC escalation when body agencyId targets an agency where actor is only agency_staff", async () => {
    const appEnv = buildAppEnv();
    const appAuth = createAppAuth();
    const mailSink = createLocalMailSink();

    // 1. dualUser owns Agency A (created FIRST -> becomes actor.activeAgency when no ?agencyId query)
    const dualUser = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "dual-owner-a-staff-b@example.com",
      password: "AgencyPassword!2026",
      nowMs: BASE_NOW_MS,
    });
    const enrollARes = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: dualUser.cookieHeader },
        body: JSON.stringify({ agencyName: "Agency Alpha Owned", acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(enrollARes.status).toBe(201);
    const agencyA = ((await enrollARes.json()) as { agency: { id: string } }).agency;

    // 2. ownerB owns Agency B, provisions 2 clients, settles clientB1 (producing receiptOfB) & creates pending attempt on clientB2
    const ownerB = await createAgencyUserFixture(env.PLATFORM_DB, {
      auth: appAuth,
      email: "owner-agency-b@example.com",
      password: "AgencyPassword!2026",
      nowMs: BASE_NOW_MS + 1_000,
    });
    const enrollBRes = await handleAgencyEnrollRequest(
      new Request(`${APP_ORIGIN}/api/agency/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ownerB.cookieHeader },
        body: JSON.stringify({ agencyName: "Agency Beta Victim", acceptTerms: true }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(enrollBRes.status).toBe(201);
    const agencyB = ((await enrollBRes.json()) as { agency: { id: string } }).agency;

    const createB1 = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ownerB.cookieHeader,
        },
        body: JSON.stringify({ handle: "beta-paid-client", name: "Beta Paid Client" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(createB1.status).toBe(201);
    const clientB1 = ((await createB1.json()) as { client: { tenantId: string } }).client;

    const paidAutoLaris = createFakeAutoLarisClient({ paid: true });
    const checkoutB1 = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ownerB.cookieHeader,
        },
        body: JSON.stringify({ tenantId: clientB1.tenantId, plan: "monthly", channelCode: "QRIS" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 3_000, autolarisClient: paidAutoLaris },
    );
    expect(checkoutB1.status).toBe(201);
    const attemptB1 = ((await checkoutB1.json()) as { attempt: { attemptId: string } }).attempt.attemptId;

    const settleB1 = await handleAgencyBillingReconcileRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, cookie: ownerB.cookieHeader },
        body: JSON.stringify({ tenantId: clientB1.tenantId, attemptId: attemptB1 }),
      }),
      appEnv,
      {
        nowMs: BASE_NOW_MS + 60_000,
        autolarisClient: paidAutoLaris,
        settlementPolicy: MOCK_POLICY,
        emailPort: mailSink,
      },
    );
    expect(settleB1.status).toBe(200);
    const settleB1Body = (await settleB1.json()) as {
      reconciliation: { outcome: string; receiptId: string };
    };
    expect(settleB1Body.reconciliation.outcome).toBe("settled");
    const receiptOfB = settleB1Body.reconciliation.receiptId;
    expect(receiptOfB).toBeTruthy();

    const createB2 = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ownerB.cookieHeader,
        },
        body: JSON.stringify({ handle: "beta-pending-client", name: "Beta Pending Client" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 61_000 },
    );
    expect(createB2.status).toBe(201);
    const clientB2 = ((await createB2.json()) as { client: { tenantId: string } }).client;

    const checkoutB2 = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: ownerB.cookieHeader,
        },
        body: JSON.stringify({ tenantId: clientB2.tenantId, plan: "monthly", channelCode: "QRIS" }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 62_000, autolarisClient: paidAutoLaris },
    );
    expect(checkoutB2.status).toBe(201);
    const pendingAttemptB2 = ((await checkoutB2.json()) as { attempt: { attemptId: string } }).attempt
      .attemptId;

    // 3. Add dualUser as `agency_staff` on Agency B (no client provisioning, no billing read/write)
    await addAgencyMember(env.PLATFORM_DB, {
      agencyId: agencyB.id,
      actorUserId: ownerB.user.id,
      targetUserId: dualUser.user.id,
      role: "agency_staff",
      nowMs: BASE_NOW_MS + 63_000,
    });

    // Snapshot Agency B state before attack attempts
    const clientsBCountBefore = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM agency_client_links WHERE agency_id = ?",
    )
      .bind(agencyB.id)
      .first<{ cnt: number }>();
    const attemptsB2CountBefore = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(clientB2.tenantId)
      .first<{ cnt: number }>();
    const settlementsB2CountBefore = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM settlements WHERE tenant_id = ?",
    )
      .bind(clientB2.tenantId)
      .first<{ cnt: number }>();

    // 4a. POST /api/agency/clients with body agencyId = B (no ?agencyId query) -> 403 FORBIDDEN
    const crossProvisionRes = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: dualUser.cookieHeader,
        },
        body: JSON.stringify({
          agencyId: agencyB.id,
          handle: "hijack-beta-site",
          name: "Hijack Beta Site",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 30_000 },
    );
    expect(crossProvisionRes.status).toBe(403);

    // 4b. POST /api/agency/billing/checkout with body agencyId = B (no ?agencyId query) -> 403 FORBIDDEN
    const crossCheckoutRes = await handleAgencyBillingCheckoutRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: dualUser.cookieHeader,
        },
        body: JSON.stringify({
          agencyId: agencyB.id,
          tenantId: clientB2.tenantId,
          plan: "yearly",
          channelCode: "VA_BCA",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 31_000, autolarisClient: paidAutoLaris },
    );
    expect(crossCheckoutRes.status).toBe(403);

    // 4c. POST /api/agency/billing/reconcile with body agencyId = B (no ?agencyId query) -> 403 FORBIDDEN
    const crossReconcileRes = await handleAgencyBillingReconcileRequest(
      new Request(`${APP_ORIGIN}/api/agency/billing/reconcile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          cookie: dualUser.cookieHeader,
        },
        body: JSON.stringify({
          agencyId: agencyB.id,
          tenantId: clientB2.tenantId,
          attemptId: pendingAttemptB2,
        }),
      }),
      appEnv,
      {
        nowMs: BASE_NOW_MS + 50_000,
        autolarisClient: paidAutoLaris,
        settlementPolicy: MOCK_POLICY,
      },
    );
    expect(crossReconcileRes.status).toBe(403);

    // 4d. GET /api/agency/billing/receipts/<receiptOfB>/pdf -> 404 NOT_FOUND (not 200!)
    const crossBillingPdfRes = await handleAgencyBillingReceiptPdfRequest(
      receiptOfB,
      new Request(`${APP_ORIGIN}/api/agency/billing/receipts/${receiptOfB}/pdf`, {
        headers: { cookie: dualUser.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 51_000 },
    );
    expect(crossBillingPdfRes.status).toBe(404);

    // 4e. GET /api/agency/receipts/<receiptOfB>/pdf -> 404 NOT_FOUND (legacy alias also blocks!)
    const crossLegacyPdfRes = await handleAgencyReceiptPdfRequest(
      receiptOfB,
      new Request(`${APP_ORIGIN}/api/agency/receipts/${receiptOfB}/pdf`, {
        headers: { cookie: dualUser.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 52_000 },
    );
    expect(crossLegacyPdfRes.status).toBe(404);

    // 4f. GET /api/agency/receipts must NOT include Agency B's receipt
    const crossReceiptsListRes = await handleAgencyReceiptsListRequest(
      new Request(`${APP_ORIGIN}/api/agency/receipts`, {
        headers: { cookie: dualUser.cookieHeader },
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 53_000 },
    );
    expect(crossReceiptsListRes.status).toBe(200);
    const crossReceiptsBody = (await crossReceiptsListRes.json()) as {
      receipts: Array<{ id: string }>;
    };
    expect(crossReceiptsBody.receipts.map((r) => r.id)).not.toContain(receiptOfB);

    // 5. Prove ZERO state mutations occurred in Agency B
    const clientsBCountAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM agency_client_links WHERE agency_id = ?",
    )
      .bind(agencyB.id)
      .first<{ cnt: number }>();
    const attemptsB2CountAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(clientB2.tenantId)
      .first<{ cnt: number }>();
    const settlementsB2CountAfter = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM settlements WHERE tenant_id = ?",
    )
      .bind(clientB2.tenantId)
      .first<{ cnt: number }>();

    expect(clientsBCountAfter?.cnt).toBe(clientsBCountBefore?.cnt);
    expect(attemptsB2CountAfter?.cnt).toBe(attemptsB2CountBefore?.cnt);
    expect(settlementsB2CountAfter?.cnt).toBe(settlementsB2CountBefore?.cnt);

    // Sanity: dualUser can still legitimately provision on Agency A where they are agency_owner
    const ownAgencyProvision = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          "Idempotency-Key": crypto.randomUUID(),
          cookie: dualUser.cookieHeader,
        },
        body: JSON.stringify({
          agencyId: agencyA.id,
          handle: "alpha-legit-client",
          name: "Alpha Legit Client",
        }),
      }),
      appEnv,
      { nowMs: BASE_NOW_MS + 54_000 },
    );
    expect(ownAgencyProvision.status).toBe(201);
  });
});
