import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import {
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_TTL_SECONDS,
  createSignedAffiliateCookieValue,
} from "@punyasitus/core/affiliates/index";
import { applyAgencyPortalMigration } from "@punyasitus/db/agencies/migrations";
import {
  AffiliateError,
  applyAffiliateMigrations,
  applyForAffiliateAccount,
  approveAffiliate,
  correctTenantAffiliateAttribution,
  getAffiliateByUserId,
  getAffiliateFunnelVisitsTotal,
  getTenantAffiliateAttribution,
  getTenantPoweredByBadgeForTenant,
  lockTenantAffiliateAttribution,
  markTenantAttributionExcluded,
  recordUserPayoutIdentityHash,
  rejectAffiliate,
  suspendAffiliate,
  updateTenantPoweredBySettings,
} from "@punyasitus/db/affiliates/index";
import {
  applyPlatformMigrations,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { listPlatformAuditEntries, PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { applyOnboardingTrialClaimsMigration } from "@punyasitus/db/provisioning/onboarding-migrations";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAffiliateReferralMiddleware } from "../../apps/web/src/middleware/affiliate-referral.ts";
import type { AuthMiddlewareContext } from "../../apps/web/src/middleware/auth.ts";
import { handleAffiliateApplyRequest } from "../../apps/web/src/pages/api/affiliates/apply.ts";
import { handleOnboardingProvisionRequest } from "../../apps/web/src/pages/api/onboarding/provision.ts";

const MARKETING_ORIGIN = "https://punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TENANT_ORIGIN = "https://toko-t084.situsku.click";
const APP_SECRET = "task084-workerd-app-auth-secret-0123456789abcdef0123456789";
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_NOW_MS = Date.now();

function buildAppEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    JOBS_QUEUE: null,
    AUTH_SECRET: APP_SECRET,
  };
}

async function resetMutableTables(): Promise<void> {
  clearHostResolutionCache();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_funnel_visits"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_powered_by_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_attribution_exclusions"),
    env.PLATFORM_DB.prepare("DELETE FROM user_payout_identities"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_enrollment_profiles"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_commissions"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_payout_batches"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_client_links"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_members"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_enrollment_records"),
    env.PLATFORM_DB.prepare("DELETE FROM onboarding_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM owner_trial_claims"),
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM invitations"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM migration_bookmarks"),
    env.PLATFORM_DB.prepare("DELETE FROM deletion_tombstones"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliates"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

async function grantActivePlatformOperator(userId: string, nowMs: number = BASE_NOW_MS): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
     VALUES (?, ?, 'Operator platform aktif untuk pengujian TASK-084.', ?, NULL)`,
  )
    .bind(userId, userId, nowMs)
    .run();
}

async function createAppUserSession(params: {
  readonly email: string;
  readonly password?: string;
  readonly name: string;
  readonly emailVerified?: boolean;
  readonly nowMs?: number;
}): Promise<{
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly cookieHeader: string;
}> {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: APP_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
  });

  const signUpRes = await auth.api.signUpEmail({
    body: {
      email: params.email,
      password: params.password ?? "SandiAman#2026!",
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
  expect(cookiePair).toContain("__Host-ps_session=");

  const nowMs = params.nowMs ?? BASE_NOW_MS;
  if (params.emailVerified !== false) {
    await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?")
      .bind(nowMs, body.user.id)
      .run();
  }

  const sessionRow = await env.PLATFORM_DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(body.user.id)
    .first<{ readonly id: string }>();

  expect(sessionRow?.id).toBeTruthy();

  await env.PLATFORM_DB.prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowMs, nowMs, sessionRow!.id)
    .run();

  return {
    userId: body.user.id,
    sessionId: sessionRow!.id,
    email: body.user.email,
    cookieHeader: cookiePair,
  };
}

async function createApprovedAffiliate(params: {
  readonly email: string;
  readonly name: string;
  readonly bankCode?: string;
  readonly accountNumber?: string;
  readonly referralCode?: string;
  readonly operatorUserId: string;
  readonly nowMs?: number;
}) {
  const nowMs = params.nowMs ?? BASE_NOW_MS;
  const user = await createAppUserSession({
    email: params.email,
    name: params.name,
    emailVerified: true,
    nowMs,
  });
  const applied = await applyForAffiliateAccount(env.PLATFORM_DB, {
    userId: user.userId,
    payload: {
      payoutBankCode: params.bankCode ?? "BCA",
      payoutAccountNumber: params.accountNumber ?? "7788-9900-11",
      payoutAccountHolder: params.name,
      termsAccepted: true,
      termsVersion: "2026-11-v1",
    },
    nowMs,
  });
  const approved = await approveAffiliate(env.PLATFORM_DB, {
    affiliateId: applied.affiliate.id,
    actorUserId: params.operatorUserId,
    reason: "Verifikasi identitas dan rekening afiliasi selesai disetujui.",
    referralCode: params.referralCode,
    nowMs: nowMs + 1000,
  });
  return { user, affiliate: approved.affiliate };
}

function makeMarketingContext(request: Request, surface: "marketing" | "tenant" | "app" = "marketing"): AuthMiddlewareContext {
  const url = new URL(request.url);
  return {
    request,
    locals: {
      surface,
      host: url.hostname,
      isLocalLoopback: false,
      tenant: surface === "tenant" ? ({ id: "t_dummy" } as never) : null,
      tenantDb: null,
      authUser: null,
      authSession: null,
      authorizedTenantMember: null,
    },
  };
}

beforeAll(async () => {
  await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => BASE_NOW_MS);
  await applyOnboardingTrialClaimsMigration(env.PLATFORM_DB, () => BASE_NOW_MS);
  await applyAgencyPortalMigration(env.PLATFORM_DB, () => BASE_NOW_MS);
  await applyAffiliateMigrations(env.PLATFORM_DB, () => BASE_NOW_MS);
});

beforeEach(async () => {
  await resetMutableTables();
});

describe("TASK-084 POST /api/affiliates/apply security gates & PII-free audit", () => {
  it("enforces app host isolation, CSRF/Origin, auth + session ceiling, verified email, validation, duplicate 409, and zero raw bank number in audit", async () => {
    const runtimeEnv = buildAppEnv();
    const rawAccountNumber = "889911223344";
    const validPayload = {
      payoutBankCode: "BCA",
      payoutAccountNumber: rawAccountNumber,
      payoutAccountHolder: "Rina Kartika",
      termsAccepted: true,
      termsVersion: "2026-11-v1",
    };

    // 1. Host isolation -> 404 on marketing, console, tenant hosts
    for (const wrongOrigin of [MARKETING_ORIGIN, CONSOLE_ORIGIN, TENANT_ORIGIN]) {
      const res = await handleAffiliateApplyRequest(
        new Request(`${wrongOrigin}/api/affiliates/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: wrongOrigin },
          body: JSON.stringify(validPayload),
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS },
      );
      expect(res.status).toBe(404);
    }

    // 2. Method gate -> 405
    const getRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, { method: "GET" }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(getRes.status).toBe(405);

    // 3. CSRF / Origin gate -> 403
    const badOriginRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify(validPayload),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 4. Unauthenticated -> 401
    const unauthRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify(validPayload),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unauthRes.status).toBe(401);

    // 5. Unverified email -> 403 EMAIL_NOT_VERIFIED (takes precedence over 422 payload errors)
    const unverified = await createAppUserSession({
      email: "unverified-aff@example.test",
      name: "Belum Verifikasi",
      emailVerified: false,
      nowMs: BASE_NOW_MS,
    });
    const unverifiedRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: unverified.cookieHeader,
        },
        body: JSON.stringify({ ...validPayload, termsAccepted: false }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(unverifiedRes.status).toBe(403);
    expect(((await unverifiedRes.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");

    // 6. Verified user with expired session (> 12h affiliate/app ceiling) -> 401
    const verified = await createAppUserSession({
      email: "rina-aff@example.test",
      name: "Rina Kartika",
      emailVerified: true,
      nowMs: BASE_NOW_MS,
    });
    const expiredSessionRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: verified.cookieHeader,
        },
        body: JSON.stringify(validPayload),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 13 * 60 * 60 * 1000 },
    );
    expect(expiredSessionRes.status).toBe(401);

    // 7. Re-create active verified session; reject termsAccepted: false and forged status
    const activeVerified = await createAppUserSession({
      email: "rina-valid@example.test",
      name: "Rina Kartika",
      emailVerified: true,
      nowMs: BASE_NOW_MS,
    });

    const noTermsRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: activeVerified.cookieHeader,
        },
        body: JSON.stringify({ ...validPayload, termsAccepted: false }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(noTermsRes.status).toBe(422);
    expect(((await noTermsRes.json()) as { code: string }).code).toBe("TERMS_NOT_ACCEPTED");

    const forgedStatusRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: activeVerified.cookieHeader,
        },
        body: JSON.stringify({ ...validPayload, status: "active" }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(forgedStatusRes.status).toBe(422);
    expect(((await forgedStatusRes.json()) as { code: string }).code).toBe("FORBIDDEN_CLIENT_FIELD");

    // 8. Successful application -> 201 pending, masked payout, PII-free audit
    const okRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: activeVerified.cookieHeader,
        },
        body: JSON.stringify(validPayload),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(okRes.status).toBe(201);
    expect(okRes.headers.get("cache-control")).toBe("private, no-store");
    expect(okRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const okText = await okRes.text();
    expect(okText).not.toContain(rawAccountNumber);
    const okBody = JSON.parse(okText) as {
      readonly success: boolean;
      readonly affiliate: {
        readonly id: string;
        readonly status: string;
        readonly referralCode: string | null;
        readonly referralLink: string | null;
        readonly payoutAccountMasked: string;
      };
      readonly auditId: string;
    };
    expect(okBody.success).toBe(true);
    expect(okBody.affiliate.status).toBe("pending");
    expect(okBody.affiliate.referralCode).toBeNull();
    expect(okBody.affiliate.referralLink).toBeNull();
    expect(okBody.affiliate.payoutAccountMasked).toBe("********3344");

    // Verify platform_audit exists and contains ZERO raw bank account number or raw email
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "affiliate.apply",
      targetId: okBody.affiliate.id,
    });
    expect(audits).toHaveLength(1);
    const auditMetadata = audits[0]?.metadataJson ?? "";
    expect(auditMetadata).not.toContain(rawAccountNumber);
    expect(auditMetadata).not.toContain("rina-valid@example.test");
    expect(auditMetadata).toContain("********3344");

    // 9. Duplicate application by same user -> 409 AFFILIATE_ALREADY_EXISTS
    const dupRes = await handleAffiliateApplyRequest(
      new Request(`${APP_ORIGIN}/api/affiliates/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: activeVerified.cookieHeader,
        },
        body: JSON.stringify(validPayload),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1000 },
    );
    expect(dupRes.status).toBe(409);
    expect(((await dupRes.json()) as { code: string }).code).toBe("AFFILIATE_ALREADY_EXISTS");
  });
});

describe("TASK-084 first-party ?ref= cookie, onboarding attribution lock & immutability", () => {
  it("sets first-party ps_ref cookie on punyasitus.com, attributes signup once, and prevents overwrite", async () => {
    const runtimeEnv = buildAppEnv();
    const operator = await createAppUserSession({
      email: "op-t084@example.test",
      name: "Operator Platform",
      nowMs: BASE_NOW_MS,
    });

    const affA = await createApprovedAffiliate({
      email: "mitra-a@example.test",
      name: "Mitra A",
      accountNumber: "111122223333",
      referralCode: "MITRA_ALPHA",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    const affB = await createApprovedAffiliate({
      email: "mitra-b@example.test",
      name: "Mitra B",
      accountNumber: "444455556666",
      referralCode: "MITRA_BETA",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });

    // 1. Visitor lands on punyasitus.com/?ref=MITRA_ALPHA 10 days ago -> sets signed ps_ref cookie + cookieless funnel visit via waitUntil
    const visitNowMs = BASE_NOW_MS - 10 * DAY_MS;
    const backgroundTasks: Promise<unknown>[] = [];
    const marketingReq = new Request(`${MARKETING_ORIGIN}/?ref=mitra_alpha`, { method: "GET" });
    const marketingRes = await executeAffiliateReferralMiddleware(
      makeMarketingContext(marketingReq, "marketing"),
      async () => new Response("<html>marketing</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      runtimeEnv,
      {
        nowMs: visitNowMs,
        waitUntil: (p) => {
          backgroundTasks.push(p);
        },
      },
    );
    await Promise.all(backgroundTasks);

    const setCookieHeader = marketingRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${AFFILIATE_COOKIE_NAME}=v1.MITRA_ALPHA.`);
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("SameSite=Lax");
    expect(setCookieHeader).toContain("Domain=punyasitus.com");
    expect(setCookieHeader).toContain(`Max-Age=${AFFILIATE_COOKIE_TTL_SECONDS}`);
    expect(marketingRes.headers.get("cache-control")).toBe("private, no-store");
    expect(await getAffiliateFunnelVisitsTotal(env.PLATFORM_DB, affA.affiliate.id)).toBe(1);

    // Repeat GET with existing valid ps_ref cookie MUST NOT reset cookie or inflate visit count
    const refCookiePair = setCookieHeader.split(";")[0] ?? "";
    const repeatRes = await executeAffiliateReferralMiddleware(
      makeMarketingContext(
        new Request(`${MARKETING_ORIGIN}/?ref=mitra_alpha`, {
          method: "GET",
          headers: { Cookie: refCookiePair },
        }),
        "marketing",
      ),
      async () => new Response("<html>marketing</html>", { status: 200 }),
      runtimeEnv,
      { nowMs: visitNowMs + 60_000 },
    );
    expect(repeatRes.headers.get("set-cookie")).toBeNull();
    expect(await getAffiliateFunnelVisitsTotal(env.PLATFORM_DB, affA.affiliate.id)).toBe(1);

    // Tenant host MUST NEVER set ps_ref cookie
    const tenantRes = await executeAffiliateReferralMiddleware(
      makeMarketingContext(new Request(`${TENANT_ORIGIN}/?ref=MITRA_ALPHA`), "tenant"),
      async () => new Response("<html>tenant</html>", { status: 200 }),
      runtimeEnv,
      { nowMs: visitNowMs },
    );
    expect(tenantRes.headers.get("set-cookie")).toBeNull();

    // 2. Owner signs up 10 days later (within 30-day window) with the first-party cookie
    const signupNowMs = BASE_NOW_MS;
    const owner = await createAppUserSession({
      email: "pemilik-baru@example.test",
      name: "Pemilik Baru",
      nowMs: signupNowMs,
    });

    const provisionRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: `${owner.cookieHeader}; ${refCookiePair}`,
          "Idempotency-Key": "idem-t084-cookie-0001",
        },
        body: JSON.stringify({
          handle: "warung-refer-a",
          name: "Warung Refer Alpha",
          vertical: "resto",
        }),
      }),
      runtimeEnv,
      { nowMs: signupNowMs },
    );
    expect(provisionRes.status).toBe(201);
    const provisionBody = (await provisionRes.json()) as {
      readonly tenant: { readonly id: string };
      readonly affiliateAttribution: {
        readonly attributed: boolean;
        readonly affiliateId: string | null;
        readonly referralCode: string | null;
        readonly source: string | null;
        readonly locked: boolean;
      };
    };

    expect(provisionBody.affiliateAttribution).toEqual({
      attributed: true,
      affiliateId: affA.affiliate.id,
      referralCode: "MITRA_ALPHA",
      source: "cookie",
      locked: true,
    });

    const tenantRow = await env.PLATFORM_DB.prepare(
      "SELECT referred_by_affiliate_id FROM tenants WHERE id = ?",
    )
      .bind(provisionBody.tenant.id)
      .first<{ readonly referred_by_affiliate_id: string | null }>();
    expect(tenantRow?.referred_by_affiliate_id).toBe(affA.affiliate.id);

    // 3. Immutability: replay with DIFFERENT manual code or second lock call CANNOT overwrite!
    const replayRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: owner.cookieHeader,
          "Idempotency-Key": "idem-t084-cookie-0001",
        },
        body: JSON.stringify({
          handle: "warung-refer-a",
          name: "Warung Refer Alpha",
          vertical: "resto",
          referralCode: "MITRA_BETA",
        }),
      }),
      runtimeEnv,
      { nowMs: signupNowMs + 5000 },
    );
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      readonly affiliateAttribution: { readonly affiliateId: string | null };
    };
    expect(replayBody.affiliateAttribution.affiliateId).toBe(affA.affiliate.id);

    const overwriteAttempt = await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
      tenantId: provisionBody.tenant.id,
      ownerUserId: owner.userId,
      referralCode: "MITRA_BETA",
      attributionSource: "manual_code",
      nowMs: signupNowMs + 6000,
    });
    expect(overwriteAttempt).toEqual({
      attributed: false,
      reason: "already_locked",
      existingAffiliateId: affA.affiliate.id,
    });

    // 4. Raw SQLite triggers block non-superadmin UPDATE and DELETE while tenant exists
    await expect(
      env.PLATFORM_DB.prepare(
        `UPDATE affiliate_referrals
         SET affiliate_id = ?, referral_code = 'MITRA_BETA', attribution_source = 'manual_code'
         WHERE tenant_id = ?`,
      )
        .bind(affB.affiliate.id, provisionBody.tenant.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_ATTRIBUTION_LOCKED/);

    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals WHERE tenant_id = ?")
        .bind(provisionBody.tenant.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_REFERRAL_DELETE_FORBIDDEN/);
  });

  it("supports explicit manual referralCode at signup (with precedence over cookie) and blocks expired (>30d) cookies and non-active affiliates", async () => {
    const runtimeEnv = buildAppEnv();
    const operator = await createAppUserSession({
      email: "op-t084-2@example.test",
      name: "Operator Platform",
      nowMs: BASE_NOW_MS,
    });

    const affActive = await createApprovedAffiliate({
      email: "aff-active@example.test",
      name: "Mitra Aktif",
      accountNumber: "100020003000",
      referralCode: "AKTIF_01",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });

    const affSuspended = await createApprovedAffiliate({
      email: "aff-susp@example.test",
      name: "Mitra Suspended",
      accountNumber: "200030004000",
      referralCode: "SUSP_01",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    await suspendAffiliate(env.PLATFORM_DB, {
      affiliateId: affSuspended.affiliate.id,
      actorUserId: operator.userId,
      reason: "Pelanggaran kebijakan promosi iklan berbayar.",
      nowMs: BASE_NOW_MS + 2000,
    });

    // Pending affiliate (not approved)
    const pendingUser = await createAppUserSession({
      email: "aff-pending@example.test",
      name: "Mitra Pending",
      nowMs: BASE_NOW_MS,
    });
    const pendingAff = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: pendingUser.userId,
      payload: {
        payoutBankCode: "BRI",
        payoutAccountNumber: "300040005000",
        payoutAccountHolder: "Mitra Pending",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });

    // Rejected affiliate
    const rejectedUser = await createAppUserSession({
      email: "aff-rejected@example.test",
      name: "Mitra Rejected",
      nowMs: BASE_NOW_MS,
    });
    const rejectedAff = await applyForAffiliateAccount(env.PLATFORM_DB, {
      userId: rejectedUser.userId,
      payload: {
        payoutBankCode: "BNI",
        payoutAccountNumber: "400050006000",
        payoutAccountHolder: "Mitra Rejected",
        termsAccepted: true,
        termsVersion: "2026-11-v1",
      },
      nowMs: BASE_NOW_MS,
    });
    await rejectAffiliate(env.PLATFORM_DB, {
      affiliateId: rejectedAff.affiliate.id,
      actorUserId: operator.userId,
      reason: "Data identitas pencairan tidak sesuai ketentuan.",
      nowMs: BASE_NOW_MS + 2000,
    });

    // A. Valid manual code at signup succeeds
    const owner1 = await createAppUserSession({
      email: "manual-owner@example.test",
      name: "Owner Manual",
      nowMs: BASE_NOW_MS + 5000,
    });
    const manualRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: owner1.cookieHeader,
          "Idempotency-Key": "idem-t084-manual-0001",
        },
        body: JSON.stringify({
          handle: "toko-manual-01",
          name: "Toko Manual Satu",
          vertical: "catalog",
          referralCode: "aktif_01",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(manualRes.status).toBe(201);
    const manualBody = (await manualRes.json()) as {
      readonly affiliateAttribution: { readonly attributed: boolean; readonly affiliateId: string | null; readonly source: string | null };
    };
    expect(manualBody.affiliateAttribution.attributed).toBe(true);
    expect(manualBody.affiliateAttribution.affiliateId).toBe(affActive.affiliate.id);
    expect(manualBody.affiliateAttribution.source).toBe("manual_code");

    // B. Expired cookie (> 30 days) produces ZERO attribution
    const oldCookieVal = await createSignedAffiliateCookieValue({
      referralCode: "AKTIF_01",
      secret: APP_SECRET,
      nowMs: BASE_NOW_MS - 31 * DAY_MS,
    });
    const after31DaysMs = BASE_NOW_MS;
    const ownerExpired = await createAppUserSession({
      email: "expired-cookie-owner@example.test",
      name: "Owner Expired",
      nowMs: after31DaysMs,
    });
    const expiredRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: `${ownerExpired.cookieHeader}; ${AFFILIATE_COOKIE_NAME}=${oldCookieVal}`,
          "Idempotency-Key": "idem-t084-expired-0001",
        },
        body: JSON.stringify({
          handle: "toko-expired-01",
          name: "Toko Cookie Expired",
          vertical: "compro",
        }),
      }),
      runtimeEnv,
      { nowMs: after31DaysMs },
    );
    expect(expiredRes.status).toBe(201);
    const expiredBody = (await expiredRes.json()) as {
      readonly tenant: { readonly id: string };
      readonly affiliateAttribution: { readonly attributed: boolean; readonly affiliateId: string | null };
    };
    expect(expiredBody.affiliateAttribution.attributed).toBe(false);
    expect(expiredBody.affiliateAttribution.affiliateId).toBeNull();
    expect(await getTenantAffiliateAttribution(env.PLATFORM_DB, expiredBody.tenant.id)).toBeNull();

    // C. Suspended affiliate produces ZERO attribution
    const ownerSusp = await createAppUserSession({
      email: "susp-ref-owner@example.test",
      name: "Owner Suspended Ref",
      nowMs: BASE_NOW_MS + 10_000,
    });
    const suspRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerSusp.cookieHeader,
          "Idempotency-Key": "idem-t084-susp-0001",
        },
        body: JSON.stringify({
          handle: "toko-susp-01",
          name: "Toko Suspended Ref",
          vertical: "compro",
          referralCode: "SUSP_01",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );
    expect(suspRes.status).toBe(201);
    const suspBody = (await suspRes.json()) as {
      readonly affiliateAttribution: { readonly attributed: boolean };
    };
    expect(suspBody.affiliateAttribution.attributed).toBe(false);

    // D. Pending and rejected affiliates have no valid public code & produce ZERO attribution
    expect((await getAffiliateByUserId(env.PLATFORM_DB, pendingUser.userId))?.referralCode).toBeNull();
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: expiredBody.tenant.id,
        ownerUserId: ownerExpired.userId,
        referralCode: `__pending_${pendingAff.affiliate.id}`,
        attributionSource: "manual_code",
        nowMs: after31DaysMs,
      }),
    ).toEqual({ attributed: false, reason: "invalid_code" });
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: expiredBody.tenant.id,
        ownerUserId: ownerExpired.userId,
        referralCode: "UNKNOWN_CODE_99",
        attributionSource: "manual_code",
        nowMs: after31DaysMs,
      }),
    ).toEqual({ attributed: false, reason: "affiliate_not_found" });
  });
});

describe("TASK-084 anti-abuse self-referral & ineligible tenant locks + superadmin correction", () => {
  it("blocks self-referral by user_id, normalized email (Gmail dots/plus), and matching payout_identity_hash", async () => {
    const runtimeEnv = buildAppEnv();
    const operator = await createAppUserSession({
      email: "op-selfref@example.test",
      name: "Operator SelfRef",
      nowMs: BASE_NOW_MS,
    });

    const aff = await createApprovedAffiliate({
      email: "budi.santoso@gmail.com",
      name: "Budi Santoso",
      bankCode: "MANDIRI",
      accountNumber: "9001-2233-4455",
      referralCode: "BUDI_PRO",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });

    // 1. Self-referral: matching user_id
    const selfUserRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: aff.user.cookieHeader,
          "Idempotency-Key": "idem-t084-self-uid-01",
        },
        body: JSON.stringify({
          handle: "toko-self-uid",
          name: "Toko Self User",
          vertical: "compro",
          referralCode: "BUDI_PRO",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    expect(selfUserRes.status).toBe(201);
    const selfUserBody = (await selfUserRes.json()) as {
      readonly tenant: { readonly id: string };
      readonly affiliateAttribution: { readonly attributed: boolean };
    };
    expect(selfUserBody.affiliateAttribution.attributed).toBe(false);
    expect(await getTenantAffiliateAttribution(env.PLATFORM_DB, selfUserBody.tenant.id)).toBeNull();

    // 2. Self-referral: different user_id with canonicalized Gmail alias (`budisantoso+promo@googlemail.com`)
    const aliasUser = await createAppUserSession({
      email: "budisantoso+promo@googlemail.com",
      name: "Budi Alias",
      nowMs: BASE_NOW_MS + 6000,
    });
    const selfEmailRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: aliasUser.cookieHeader,
          "Idempotency-Key": "idem-t084-self-email-01",
        },
        body: JSON.stringify({
          handle: "toko-self-email",
          name: "Toko Self Email",
          vertical: "compro",
          referralCode: "BUDI_PRO",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );
    expect(selfEmailRes.status).toBe(201);
    const selfEmailBody = (await selfEmailRes.json()) as {
      readonly tenant: { readonly id: string };
      readonly affiliateAttribution: { readonly attributed: boolean };
    };
    expect(selfEmailBody.affiliateAttribution.attributed).toBe(false);
    expect(await getTenantAffiliateAttribution(env.PLATFORM_DB, selfEmailBody.tenant.id)).toBeNull();

    // 3. Self-referral: different user_id + different email, SAME payout_identity_hash!
    const sameBankUser = await createAppUserSession({
      email: "akun-kedua@domainlain.test",
      name: "Akun Kedua",
      nowMs: BASE_NOW_MS + 7000,
    });
    await recordUserPayoutIdentityHash(env.PLATFORM_DB, {
      userId: sameBankUser.userId,
      payoutBankCode: "mandiri",
      payoutAccountNumber: "9001 2233 4455",
      nowMs: BASE_NOW_MS + 7000,
    });

    const selfPayoutRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: sameBankUser.cookieHeader,
          "Idempotency-Key": "idem-t084-self-payout-01",
        },
        body: JSON.stringify({
          handle: "toko-self-payout",
          name: "Toko Self Payout",
          vertical: "compro",
          referralCode: "BUDI_PRO",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7000 },
    );
    expect(selfPayoutRes.status).toBe(201);
    const selfPayoutBody = (await selfPayoutRes.json()) as {
      readonly tenant: { readonly id: string };
      readonly affiliateAttribution: { readonly attributed: boolean };
    };
    expect(selfPayoutBody.affiliateAttribution.attributed).toBe(false);
    expect(await getTenantAffiliateAttribution(env.PLATFORM_DB, selfPayoutBody.tenant.id)).toBeNull();
  });

  it("blocks agency-managed, demo, complimentary, superadmin-created, and platform tenants from attribution", async () => {
    const operator = await createAppUserSession({
      email: "op-ineligible@example.test",
      name: "Operator Ineligible",
      nowMs: BASE_NOW_MS,
    });
    const aff = await createApprovedAffiliate({
      email: "aff-elig@example.test",
      name: "Mitra Valid",
      accountNumber: "556677889900",
      referralCode: "VALID_REF",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    const owner = await createAppUserSession({
      email: "owner-ineligible@example.test",
      name: "Owner Klien",
      nowMs: BASE_NOW_MS,
    });

    // Helper to seed a minimal org + tenant row
    async function seedTenant(params: {
      readonly id: string;
      readonly handle: string;
      readonly agencyId?: string | null;
      readonly orgMetadata?: Record<string, unknown>;
    }) {
      const orgId = `org_${params.id}`;
      await env.PLATFORM_DB.batch([
        env.PLATFORM_DB.prepare(
          "INSERT INTO organizations (id, name, slug, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(
          orgId,
          params.handle,
          params.handle,
          params.orgMetadata ? JSON.stringify(params.orgMetadata) : null,
          BASE_NOW_MS,
          BASE_NOW_MS,
        ),
        env.PLATFORM_DB.prepare(
          `INSERT INTO tenants (
            id, organization_id, agency_id, handle, name, vertical, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'compro', 'trial', ?, ?)`,
        ).bind(
          params.id,
          orgId,
          params.agencyId ?? null,
          params.handle,
          params.handle,
          BASE_NOW_MS,
          BASE_NOW_MS,
        ),
        env.PLATFORM_DB.prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
        ).bind(`mem_${params.id}`, orgId, owner.userId, BASE_NOW_MS),
      ]);
    }

    // 1. Agency-managed tenant
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_ag1', 'Agensi Satu', 'agensi-satu', ?, ?)",
      ).bind(BASE_NOW_MS, BASE_NOW_MS),
      env.PLATFORM_DB.prepare(
        "INSERT INTO agencies (id, organization_id, owner_user_id, name, status, created_at, updated_at) VALUES ('ag_1', 'org_ag1', ?, 'Agensi Satu', 'active', ?, ?)",
      ).bind(operator.userId, BASE_NOW_MS, BASE_NOW_MS),
    ]);
    await seedTenant({ id: "t_agency", handle: "klien-agensi-01", agencyId: "ag_1" });
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_agency",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "cookie",
        cookieIssuedAtMs: BASE_NOW_MS,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_agency_managed" });

    // 2. Demo tenant
    await seedTenant({
      id: "t_demo",
      handle: "demo-compro-01",
      orgMetadata: { isDemo: true },
    });
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_demo",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "cookie",
        cookieIssuedAtMs: BASE_NOW_MS,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_demo" });

    // 3. Complimentary tenant (non-settlement entitlement grant)
    await seedTenant({ id: "t_comp", handle: "klien-komplimen-01" });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO entitlement_grants (id, tenant_id, settlement_id, period_start, period_end, granted_by, created_at)
       VALUES ('eg_comp_1', 't_comp', NULL, ?, ?, ?, ?)`,
    )
      .bind(BASE_NOW_MS, BASE_NOW_MS + 30 * 86_400_000, operator.userId, BASE_NOW_MS)
      .run();
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_comp",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "manual_code",
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_complimentary" });

    // 4. Superadmin-created tenant (recorded in platform_audit)
    await seedTenant({ id: "t_superadmin", handle: "klien-console-01" });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO platform_audit (
        id, actor_user_id, actor_role, action, target_type, target_id, tenant_id, outcome, created_at
      ) VALUES ('aud_sa_prov_1', ?, 'platform_operator', 'console.tenant.provision', 'tenant', 't_superadmin', 't_superadmin', 'success', ?)`,
    )
      .bind(operator.userId, BASE_NOW_MS)
      .run();
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_superadmin",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "cookie",
        cookieIssuedAtMs: BASE_NOW_MS,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_superadmin_created" });

    // 5. Platform tenant (explicit exclusion marker)
    await seedTenant({ id: "t_platform", handle: "situs-internal-01" });
    await markTenantAttributionExcluded(env.PLATFORM_DB, {
      tenantId: "t_platform",
      exclusionKind: "platform",
      reason: "Situs resmi internal platform PunyaSitus.",
      markedByUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_platform",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "cookie",
        cookieIssuedAtMs: BASE_NOW_MS,
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_platform" });

    // 6. Malformed organization metadata JSON fails closed (N3)
    await seedTenant({ id: "t_badmeta", handle: "situs-badmeta-01" });
    await env.PLATFORM_DB.prepare("UPDATE organizations SET metadata = '{corrupted' WHERE id = 'org_t_badmeta'").run();
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_badmeta",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "manual_code",
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "ineligible_invalid_metadata" });

    // 7. Cookie/footer_badge source without cookieIssuedAtMs fails closed (N8)
    await seedTenant({ id: "t_nots", handle: "situs-nots-01" });
    expect(
      await lockTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: "t_nots",
        ownerUserId: owner.userId,
        referralCode: aff.affiliate.referralCode,
        attributionSource: "cookie",
        nowMs: BASE_NOW_MS,
      }),
    ).toEqual({ attributed: false, reason: "cookie_expired" });

    // 8. Concurrent race test (B2): if tenants.agency_id is set concurrently right before batch(),
    //    ZERO row is inserted into affiliate_referrals (zero store divergence!)
    await seedTenant({ id: "t_race_ag", handle: "situs-race-ag-01" });
    let injectedRace = false;
    const racingDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!injectedRace) {
              injectedRace = true;
              await target
                .prepare("UPDATE tenants SET agency_id = 'ag_1' WHERE id = 't_race_ag'")
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const raceRes = await lockTenantAffiliateAttribution(racingDb, {
      tenantId: "t_race_ag",
      ownerUserId: owner.userId,
      referralCode: aff.affiliate.referralCode,
      attributionSource: "manual_code",
      nowMs: BASE_NOW_MS,
    });
    expect(raceRes.attributed).toBe(false);
    expect(await getTenantAffiliateAttribution(env.PLATFORM_DB, "t_race_ag")).toBeNull();
    const raceTenant = await env.PLATFORM_DB.prepare(
      "SELECT referred_by_affiliate_id FROM tenants WHERE id = 't_race_ag'",
    ).first<{ readonly referred_by_affiliate_id: string | null }>();
    expect(raceTenant?.referred_by_affiliate_id).toBeNull();
  });

  it("permits ONLY active platform_operators audited attribution correction, enforces OCC, and keeps post-correction updates locked", async () => {
    const runtimeEnv = buildAppEnv();
    const operator = await createAppUserSession({
      email: "op-correct@example.test",
      name: "Operator Koreksi",
      nowMs: BASE_NOW_MS,
    });
    await grantActivePlatformOperator(operator.userId, BASE_NOW_MS);

    const nonOperator = await createAppUserSession({
      email: "non-op-correct@example.test",
      name: "Bukan Operator",
      nowMs: BASE_NOW_MS,
    });

    const aff1 = await createApprovedAffiliate({
      email: "aff-one@example.test",
      name: "Mitra Satu",
      accountNumber: "112233445566",
      referralCode: "MITRA_ONE",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    const aff2 = await createApprovedAffiliate({
      email: "aff-two@example.test",
      name: "Mitra Dua",
      accountNumber: "665544332211",
      referralCode: "MITRA_TWO",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });
    const owner = await createAppUserSession({
      email: "owner-corr@example.test",
      name: "Owner Koreksi",
      nowMs: BASE_NOW_MS + 5000,
    });

    const provRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: owner.cookieHeader,
          "Idempotency-Key": "idem-t084-corr-0001",
        },
        body: JSON.stringify({
          handle: "toko-koreksi-01",
          name: "Toko Koreksi Satu",
          vertical: "compro",
          referralCode: "MITRA_ONE",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    const { tenant } = (await provRes.json()) as { readonly tenant: { readonly id: string } };

    // Non-operator actor rejected with 403 FORBIDDEN (B3)
    try {
      await correctTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: tenant.id,
        newAffiliateId: aff2.affiliate.id,
        actorUserId: nonOperator.userId,
        reason: "Percobaan koreksi tanpa hak operator platform aktif.",
        expectedVersion: 1,
        nowMs: BASE_NOW_MS + 9000,
      });
      throw new Error("Expected AffiliateError 403");
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliateError);
      expect((err as AffiliateError).status).toBe(403);
      expect((err as AffiliateError).code).toBe("FORBIDDEN");
    }

    // Stale expectedVersion rejected with 409 STALE_VERSION (B3)
    try {
      await correctTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: tenant.id,
        newAffiliateId: aff2.affiliate.id,
        actorUserId: operator.userId,
        reason: "Koreksi atribusi dengan versi lama yang tidak cocok.",
        expectedVersion: 99,
        nowMs: BASE_NOW_MS + 9500,
      });
      throw new Error("Expected AffiliateError 409");
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliateError);
      expect((err as AffiliateError).status).toBe(409);
      expect((err as AffiliateError).code).toBe("STALE_VERSION");
    }

    // Short reason rejected
    await expect(
      correctTenantAffiliateAttribution(env.PLATFORM_DB, {
        tenantId: tenant.id,
        newAffiliateId: aff2.affiliate.id,
        actorUserId: operator.userId,
        reason: "pendek",
        expectedVersion: 1,
        nowMs: BASE_NOW_MS + 10_000,
      }),
    ).rejects.toThrow(AffiliateError);

    // Valid superadmin correction updates both affiliate_referrals and tenants + records platform_audit
    const corrected = await correctTenantAffiliateAttribution(env.PLATFORM_DB, {
      tenantId: tenant.id,
      newAffiliateId: aff2.affiliate.id,
      actorUserId: operator.userId,
      reason: "Koreksi atribusi tiket dukungan #8402 setelah verifikasi bukti referral.",
      expectedVersion: 1,
      nowMs: BASE_NOW_MS + 10_000,
    });

    expect(corrected.previousAffiliateId).toBe(aff1.affiliate.id);
    expect(corrected.attribution.affiliateId).toBe(aff2.affiliate.id);
    expect(corrected.attribution.referralCode).toBe("MITRA_TWO");
    expect(corrected.attribution.attributionSource).toBe("superadmin_correction");
    expect(corrected.attribution.correctedByUserId).toBe(operator.userId);
    expect(corrected.attribution.version).toBe(2);

    // B1 regression check: a plain UPDATE AFTER a prior superadmin correction is STILL aborted by trigger!
    await expect(
      env.PLATFORM_DB.prepare(
        `UPDATE affiliate_referrals
         SET affiliate_id = ?, referral_code = 'MITRA_ONE'
         WHERE tenant_id = ?`,
      )
        .bind(aff1.affiliate.id, tenant.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_ATTRIBUTION_LOCKED/);

    // B1 regression check: DELETE while tenant still exists is STILL aborted by BEFORE DELETE trigger!
    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals WHERE tenant_id = ?")
        .bind(tenant.id)
        .run(),
    ).rejects.toThrow(/AFFILIATE_REFERRAL_DELETE_FORBIDDEN/);

    const updatedTenant = await env.PLATFORM_DB.prepare(
      "SELECT referred_by_affiliate_id FROM tenants WHERE id = ?",
    )
      .bind(tenant.id)
      .first<{ readonly referred_by_affiliate_id: string | null }>();
    expect(updatedTenant?.referred_by_affiliate_id).toBe(aff2.affiliate.id);

    const auditRows = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.affiliate.attribution.correct",
      tenantId: tenant.id,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.reason).toContain("#8402");

    // B3 concurrent-correction race test: Operator A wins on version=2 right before Operator B's
    // batch() runs -> Operator B MUST throw 409 STALE_VERSION, leave tenants.referred_by_affiliate_id
    // equal to Operator A's winner (aff1), and write ZERO audit rows for Operator B!
    const operatorB = await createAppUserSession({
      email: "op-correct-b@example.test",
      name: "Operator B",
      nowMs: BASE_NOW_MS + 11_000,
    });
    await grantActivePlatformOperator(operatorB.userId, BASE_NOW_MS + 11_000);

    let winnerCommitted = false;
    const racingCorrectionDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!winnerCommitted) {
              winnerCommitted = true;
              // Operator A commits version 2 -> 3 setting affiliate back to aff1 right before B's batch runs
              await correctTenantAffiliateAttribution(target, {
                tenantId: tenant.id,
                newAffiliateId: aff1.affiliate.id,
                actorUserId: operator.userId,
                reason: "Operator A memenangkan koreksi atribusi secara bersamaan #8403.",
                expectedVersion: 2,
                nowMs: BASE_NOW_MS + 12_000,
              });
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    try {
      await correctTenantAffiliateAttribution(racingCorrectionDb, {
        tenantId: tenant.id,
        newAffiliateId: null,
        actorUserId: operatorB.userId,
        reason: "Operator B mencoba mengosongkan atribusi pada versi lama #8404.",
        expectedVersion: 2,
        nowMs: BASE_NOW_MS + 12_500,
      });
      throw new Error("Expected AffiliateError 409 STALE_VERSION");
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliateError);
      expect((err as AffiliateError).status).toBe(409);
      expect((err as AffiliateError).code).toBe("STALE_VERSION");
    }

    // Verify ZERO divergence: both tables match Operator A's winner (aff1, version 3)
    const afterRaceReferral = await getTenantAffiliateAttribution(env.PLATFORM_DB, tenant.id);
    expect(afterRaceReferral?.affiliateId).toBe(aff1.affiliate.id);
    expect(afterRaceReferral?.version).toBe(3);

    const afterRaceTenant = await env.PLATFORM_DB.prepare(
      "SELECT referred_by_affiliate_id FROM tenants WHERE id = ?",
    )
      .bind(tenant.id)
      .first<{ readonly referred_by_affiliate_id: string | null }>();
    expect(afterRaceTenant?.referred_by_affiliate_id).toBe(aff1.affiliate.id);

    // Operator B wrote ZERO platform_audit rows
    const opBAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.affiliate.attribution.correct",
      actorUserId: operatorB.userId,
      tenantId: tenant.id,
    });
    expect(opBAudits).toHaveLength(0);
  });
});

describe("TASK-084 tenant 'Dibuat dengan PunyaSitus' footer badge DB persistence", () => {
  it("locks badge visible on trial, allows 1-click hide or approved owner ?ref= on paid, and falls back when affiliate is suspended", async () => {
    const runtimeEnv = buildAppEnv();
    const operator = await createAppUserSession({
      email: "op-badge@example.test",
      name: "Operator Badge",
      nowMs: BASE_NOW_MS,
    });

    const ownerAff = await createApprovedAffiliate({
      email: "owner-aff-badge@example.test",
      name: "Pemilik Afiliasi",
      accountNumber: "998877665544",
      referralCode: "BADGE_PRO",
      operatorUserId: operator.userId,
      nowMs: BASE_NOW_MS,
    });

    const provRes = await handleOnboardingProvisionRequest(
      new Request(`${APP_ORIGIN}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: ownerAff.user.cookieHeader,
          "Idempotency-Key": "idem-t084-badge-0001",
        },
        body: JSON.stringify({
          handle: "toko-badge-01",
          name: "Toko Badge Satu",
          vertical: "sales",
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );
    const { tenant } = (await provRes.json()) as { readonly tenant: { readonly id: string } };

    // 1. Trial tenant ALWAYS shows plain badge and rejects hiding
    const trialBadge = await getTenantPoweredByBadgeForTenant(env.PLATFORM_DB, tenant.id);
    expect(trialBadge?.visible).toBe(true);
    expect(trialBadge?.text).toBe("Dibuat dengan PunyaSitus");
    expect(trialBadge?.href).toBe("https://punyasitus.com");
    expect(trialBadge?.canHide).toBe(false);

    await expect(
      updateTenantPoweredBySettings(env.PLATFORM_DB, {
        tenantId: tenant.id,
        actorUserId: ownerAff.user.userId,
        hidePoweredByBadge: true,
        nowMs: BASE_NOW_MS + 6000,
      }),
    ).rejects.toThrowError(/tidak dapat disembunyikan/);

    // 2. Upgrade tenant to paid (`active`) -> non-owner rejected (403 FORBIDDEN), owner 1-click hide succeeds
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ?")
      .bind(BASE_NOW_MS + 7000, tenant.id)
      .run();

    const stranger = await createAppUserSession({
      email: "stranger-badge@example.test",
      name: "Bukan Pemilik",
      nowMs: BASE_NOW_MS + 7500,
    });
    try {
      await updateTenantPoweredBySettings(env.PLATFORM_DB, {
        tenantId: tenant.id,
        actorUserId: stranger.userId,
        hidePoweredByBadge: true,
        nowMs: BASE_NOW_MS + 7600,
      });
      throw new Error("Expected AffiliateError 403");
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliateError);
      expect((err as AffiliateError).status).toBe(403);
      expect((err as AffiliateError).code).toBe("FORBIDDEN");
    }

    const hiddenRes = await updateTenantPoweredBySettings(env.PLATFORM_DB, {
      tenantId: tenant.id,
      actorUserId: ownerAff.user.userId,
      hidePoweredByBadge: true,
      nowMs: BASE_NOW_MS + 8000,
    });
    expect(hiddenRes.badge.visible).toBe(false);

    // 3. Paid owner keeps badge visible linked to their own approved affiliate `?ref=BADGE_PRO`
    const linkedRes = await updateTenantPoweredBySettings(env.PLATFORM_DB, {
      tenantId: tenant.id,
      actorUserId: ownerAff.user.userId,
      hidePoweredByBadge: false,
      attachOwnAffiliateRef: true,
      nowMs: BASE_NOW_MS + 9000,
    });
    expect(linkedRes.badge.visible).toBe(true);
    expect(linkedRes.badge.isAffiliateLinked).toBe(true);
    expect(linkedRes.badge.href).toBe("https://punyasitus.com/?ref=BADGE_PRO");

    const liveLinked = await getTenantPoweredByBadgeForTenant(env.PLATFORM_DB, tenant.id);
    expect(liveLinked?.href).toBe("https://punyasitus.com/?ref=BADGE_PRO");

    // 4. If owner's affiliate is suspended, live badge immediately falls back to plain punyasitus.com
    await suspendAffiliate(env.PLATFORM_DB, {
      affiliateId: ownerAff.affiliate.id,
      actorUserId: operator.userId,
      reason: "Penangguhan sementara untuk pemeriksaan kepatuhan afiliasi.",
      nowMs: BASE_NOW_MS + 10_000,
    });
    const afterSuspend = await getTenantPoweredByBadgeForTenant(env.PLATFORM_DB, tenant.id);
    expect(afterSuspend?.visible).toBe(true);
    expect(afterSuspend?.href).toBe("https://punyasitus.com");
    expect(afterSuspend?.isAffiliateLinked).toBe(false);
  });
});
