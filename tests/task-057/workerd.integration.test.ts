import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
} from "@punyasitus/auth";
import {
  DAY_MS,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
  createMockOnlyVerifiedSettlementPolicy,
} from "@punyasitus/core/billing/index";
import {
  ensureBillingReconciliationSchema,
  setOperatorManualHold,
} from "@punyasitus/db/billing/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
  type TenantStatus,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConsoleBillingRuntimeEnv } from "../../apps/web/src/pages/api/console/billing/_shared.ts";
import { handleConsoleBillingListRequest } from "../../apps/web/src/pages/api/console/billing/index.ts";
import { handleConsoleBillingRecheckRequest } from "../../apps/web/src/pages/api/console/billing/recheck.ts";
import { handleConsoleBillingRefundRequest } from "../../apps/web/src/pages/api/console/billing/refund.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantBillingRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/_shared.ts";
import { handleTenantBillingChannelsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/channels.ts";
import { handleTenantBillingOverviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/index.ts";
import { handleTenantBillingObligationsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/obligations/index.ts";
import {
  findSensitiveBillingKeys,
  inspectPaymentReturnQueryParams,
} from "../../apps/web/src/components/admin/billing/helpers.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TENANT_ORIGIN = "https://toko-t057.situsku.click";
const RELAY_ORIGIN = "https://autolaris-relay.punyasitus.com";
const TEST_AUTOLARIS_KEY = "al_test_t057_secret_key_never_logged_8877665544";
const TEST_APP_SECRET = "task057-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task057-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 0, 31, 10, 0, 0);
const SECRET_QRIS = "0002010102125910PUNYASITUS6007JAKARTA54061802536304ABCD";
const SECRET_VA = "8800776655443322";

function buildTenantEnv(extra?: Partial<TenantBillingRuntimeEnv>): TenantBillingRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    AUTOLARIS_RELAY_URL: RELAY_ORIGIN,
    AUTOLARIS_API_KEY: TEST_AUTOLARIS_KEY,
    AUTOLARIS_ACCOUNT_ID: "acct-t057",
    ...extra,
  };
}

function buildConsoleEnv(extra?: Partial<ConsoleBillingRuntimeEnv>): ConsoleBillingRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    AUTOLARIS_RELAY_URL: RELAY_ORIGIN,
    AUTOLARIS_API_KEY: TEST_AUTOLARIS_KEY,
    AUTOLARIS_ACCOUNT_ID: "acct-t057",
    ...extra,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractAppCookie(res: Response): string {
  const found = getSetCookies(res.headers).find((c) =>
    c.startsWith(`${APP_SESSION_COOKIE_NAME}=`),
  );
  if (!found) throw new Error("Missing app session cookie");
  return (found.split(";")[0] ?? "").trim();
}

function makeReq(
  url: string,
  method: "GET" | "POST",
  opts: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string;
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", opts.origin ?? APP_ORIGIN);
  }
  return new Request(url, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function signUpAppUser(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeReq(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    buildTenantEnv(),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    cookie: extractAppCookie(res),
  };
}

async function resetDb(): Promise<void> {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM billing_refund_records"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_reconciliation_leases"),
    env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM settlements"),
    env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM two_factors"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_settings"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

function createMockAutoLarisFetch(options?: {
  readonly adviceMode?: "pending" | "paid";
  readonly onSubmit?: () => void;
}) {
  let submitCalls = 0;
  let adviceCalls = 0;
  let lastReffId = "";
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/h2h/list_payment") {
      return new Response(
        JSON.stringify({
          rc: "00",
          message: "Success",
          data: [
            { channel_code: "QRIS", name: "QRIS Nasional", admin: "0.7", tipe_admin: "persen" },
            { channel_code: "VABCA", name: "BCA Virtual Account", admin: "4000.0", tipe_admin: "fix" },
            { channel_code: "COD", name: "Cash On Delivery", admin: "0", tipe_admin: "fix" },
            { channel_code: "ALFAMART", name: "Alfamart", admin: "5000", tipe_admin: "fix" },
            { channel_code: "OVO", name: "OVO E-Wallet", admin: "2.0", tipe_admin: "persen" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/api/h2h/submit") {
      submitCalls += 1;
      options?.onSubmit?.();
      const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
        readonly reff_id?: string;
        readonly channel_code?: string;
        readonly grand_total?: number;
      };
      const channelCode = String(reqBody.channel_code ?? "QRIS");
      const isVa = channelCode.startsWith("VA");
      const fee = isVa ? 4_000 : 1_253;
      const net = Number(reqBody.grand_total ?? DEFAULT_MONTHLY_PRICE_IDR);
      lastReffId = String(reqBody.reff_id ?? "");
      return new Response(
        JSON.stringify({
          rc: "00",
          ket: "Success",
          data: {
            channel_code: channelCode,
            transaction_id: `ALX-T057-${submitCalls}`,
            reff_id: reqBody.reff_id,
            biaya_kirim: 0,
            biaya_cod: 0,
            biaya_asuransi: 0,
            biaya_admin: fee,
            diskon: 0,
            total: net + fee,
            payment_info: {
              expired: "2026-02-01 17:00:00",
              va: isVa ? SECRET_VA : "",
              qr: isVa ? "" : SECRET_QRIS,
              url: isVa
                ? "https://pay.autolaris.com/va/ALX-T057"
                : "https://pay.autolaris.com/qris/ALX-T057",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/api/h2h/advice") {
      adviceCalls += 1;
      const reqBody = JSON.parse(String(init?.body ?? "{}")) as { readonly transaction_id?: string };
      if (options?.adviceMode === "paid") {
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Confirmed",
            data: {
              transaction_id: reqBody.transaction_id,
              reff_id: lastReffId,
              payment_status: "PAID_SETTLED",
              total: DEFAULT_MONTHLY_PRICE_IDR + 1_253,
              currency: "IDR",
              settled_at: BASE_NOW_MS + 1000,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          rc: "02",
          ket: "Pending",
          data: {
            transaction_id: reqBody.transaction_id,
            reff_id: lastReffId,
            payment_status: "PENDING",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    fetch: mockFetch,
    getSubmitCalls: () => submitCalls,
    getAdviceCalls: () => adviceCalls,
  };
}

async function seedTenantWithUsers(opts: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly status: TenantStatus;
  readonly ownerUserId: string;
  readonly editorUserId?: string;
  readonly paidThroughMs?: number | null;
  readonly operatorHold?: boolean;
}) {
  const drizzle = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  await drizzle.insert(organizations).values({
    id: opts.orgId,
    name: `Org ${opts.handle}`,
    slug: opts.handle,
    createdAt: new Date(BASE_NOW_MS),
    updatedAt: new Date(BASE_NOW_MS),
  });
  await drizzle.insert(tenants).values({
    id: opts.tenantId,
    organizationId: opts.orgId,
    handle: opts.handle,
    name: `Bisnis ${opts.handle}`,
    vertical: "compro",
    status: opts.status,
    operatorHold: Boolean(opts.operatorHold),
    paidThrough: opts.paidThroughMs !== null && opts.paidThroughMs !== undefined ? new Date(opts.paidThroughMs) : null,
    trialEndsAt: opts.status === "trial" ? new Date(BASE_NOW_MS + 5 * DAY_MS) : null,
    createdAt: new Date(BASE_NOW_MS),
    updatedAt: new Date(BASE_NOW_MS),
  });
  await drizzle.insert(members).values({
    id: `mem_owner_${opts.tenantId}`,
    organizationId: opts.orgId,
    userId: opts.ownerUserId,
    role: "owner",
    createdAt: new Date(BASE_NOW_MS),
  });
  if (opts.editorUserId) {
    await drizzle.insert(members).values({
      id: `mem_editor_${opts.tenantId}`,
      organizationId: opts.orgId,
      userId: opts.editorUserId,
      role: "editor",
      createdAt: new Date(BASE_NOW_MS),
    });
  }
}

describe("TASK-057 workerd integration: owner payment recovery & scoped console operator billing", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB, () => BASE_NOW_MS);
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("enforces owner-only QRIS/VA channels, pre-creation disclosures, double-submit/refresh idempotency, locked-owner recovery, member 403, cross-tenant 404, and payment-return non-activation", async () => {
    const ownerA = await signUpAppUser("owner-a-t057@example.com", "Owner A");
    const editorA = await signUpAppUser("editor-a-t057@example.com", "Editor A");
    const ownerB = await signUpAppUser("owner-b-t057@example.com", "Owner B");

    const tenantAId = "01JABCDEF1234567890ABCDEA1";
    const tenantBId = "01JABCDEF1234567890ABCDEB2";

    await seedTenantWithUsers({
      tenantId: tenantAId,
      orgId: "org_t057_a",
      handle: "toko-t057-a",
      status: "locked",
      ownerUserId: ownerA.userId,
      editorUserId: editorA.userId,
      paidThroughMs: BASE_NOW_MS - 5 * DAY_MS, // H+5 -> locked
    });
    await seedTenantWithUsers({
      tenantId: tenantBId,
      orgId: "org_t057_b",
      handle: "toko-t057-b",
      status: "active",
      ownerUserId: ownerB.userId,
      paidThroughMs: BASE_NOW_MS + 20 * DAY_MS,
    });

    const mockAl = createMockAutoLarisFetch();

    // 1. Locked owner reads overview with mandatory disclosures & strictly filtered QRIS/VA channels
    const overviewRes = await handleTenantBillingOverviewRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing?status=paid&paid=1&return=success`, "GET", {
        cookie: ownerA.cookie,
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(overviewRes.status).toBe(200);
    const overviewData = (await overviewRes.json()) as {
      tenantStatus: string;
      taxNotice: string;
      noRefundNotice: string;
      pricingPlans: { plan: string; baseAmountIdr: number; savingsIdr: number }[];
      channels: { code: string; kind: string }[];
    };
    // Payment-return query params NEVER activate locked tenant!
    expect(inspectPaymentReturnQueryParams("?status=paid&paid=1&return=success").hasPaymentReturnClaim).toBe(true);
    expect(overviewData.tenantStatus).toBe("locked");
    expect(overviewData.taxNotice).toBe(NON_PKP_TAX_NOTICE);
    expect(overviewData.noRefundNotice).toBe(NO_REFUND_NOTICE);
    expect(overviewData.pricingPlans.find((p) => p.plan === "monthly")?.baseAmountIdr).toBe(
      DEFAULT_MONTHLY_PRICE_IDR,
    );
    expect(overviewData.pricingPlans.find((p) => p.plan === "yearly")?.savingsIdr).toBe(
      DEFAULT_MONTHLY_PRICE_IDR * 12 - DEFAULT_YEARLY_PRICE_IDR,
    );
    expect(overviewData.channels.map((c) => c.code)).toEqual(["QRIS", "VABCA"]);

    // 2. Non-owner member (editor) denied 403 on channels & obligation creation
    const memberChanRes = await handleTenantBillingChannelsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/channels`, "GET", {
        cookie: editorA.cookie,
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(memberChanRes.status).toBe(403);

    const memberCreateRes = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: editorA.cookie,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(memberCreateRes.status).toBe(403);

    // 3. Cross-tenant Owner B accessing Tenant A receives neutral 404
    const crossTenantRes = await handleTenantBillingOverviewRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing`, "GET", {
        cookie: ownerB.cookie,
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(crossTenantRes.status).toBe(404);

    // 4. Locked owner creates QRIS instruction + double-submit / reload replay with SAME Idempotency-Key -> ONLY 1 provider call!
    const idemKey = "22222222-2222-4222-8222-222222222222";
    const create1 = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: ownerA.cookie,
        idempotencyKey: idemKey,
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(create1.status).toBe(201);
    const created1Body = (await create1.json()) as {
      replayed: boolean;
      attempt: { attemptId: string; qrisPayload: string; totalPayableIdr: number };
    };
    expect(created1Body.replayed).toBe(false);
    expect(created1Body.attempt.qrisPayload).toBe(SECRET_QRIS);
    expect(created1Body.attempt.totalPayableIdr).toBe(DEFAULT_MONTHLY_PRICE_IDR + 1_253);

    // Replay with same Idempotency-Key (simulating refresh/back/retry) returns 200 replayed, zero second submit!
    const create2 = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: ownerA.cookie,
        idempotencyKey: idemKey,
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(create2.status).toBe(200);
    const created2Body = (await create2.json()) as {
      replayed: boolean;
      attempt: { attemptId: string };
    };
    expect(created2Body.replayed).toBe(true);
    expect(created2Body.attempt.attemptId).toBe(created1Body.attempt.attemptId);
    expect(mockAl.getSubmitCalls()).toBe(1);

    // Attempt with a DIFFERENT key while existing instruction is pending -> blocked 409 CONFLICT!
    const dupRes = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: ownerA.cookie,
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        body: { plan: "monthly", channelKind: "VA", channelCode: "VABCA" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(dupRes.status).toBe(409);
    expect(mockAl.getSubmitCalls()).toBe(1);

    // 5. After obligation & attempt expire (`activeObligation` becomes null):
    //    - Reusing the old exhausted key fails cleanly with 409 IDEMPOTENCY_CONFLICT (no duplicate charge)
    //    - Minting a fresh key succeeds cleanly with 201!
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "UPDATE payment_attempts SET state = 'expired', lifecycle_state = 'expired' WHERE tenant_id = ?",
      ).bind(tenantAId),
      env.PLATFORM_DB.prepare(
        "UPDATE billing_obligations SET status = 'expired' WHERE tenant_id = ?",
      ).bind(tenantAId),
    ]);

    const exhaustedRes = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: ownerA.cookie,
        idempotencyKey: idemKey,
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS + DAY_MS, autolarisFetch: mockAl.fetch },
    );
    expect(exhaustedRes.status).toBe(409);
    const exhaustedBody = (await exhaustedRes.json()) as { error?: { code?: string } };
    expect(exhaustedBody.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(mockAl.getSubmitCalls()).toBe(1);

    const renewedRes = await handleTenantBillingObligationsRequest(
      tenantAId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantAId}/billing/obligations`, "POST", {
        cookie: ownerA.cookie,
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS + DAY_MS, autolarisFetch: mockAl.fetch },
    );
    expect(renewedRes.status).toBe(201);
    expect(mockAl.getSubmitCalls()).toBe(2);
  });

  it("enforces console host isolation, redacted metadata, audited Advice recheck, audited duplicate refund, and zero arbitrary paid toggle", async () => {
    const owner = await signUpAppUser("owner-console-t057@example.com", "Owner Console Test");
    const tenantId = "01JABCDEF1234567890ABCDEC3";
    await seedTenantWithUsers({
      tenantId,
      orgId: "org_t057_c",
      handle: "toko-t057-c",
      status: "suspended",
      ownerUserId: owner.userId,
      paidThroughMs: BASE_NOW_MS - 10 * DAY_MS,
      operatorHold: true,
    });
    await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId,
      hold: true,
      reason: "Peninjauan kepatuhan sementara",
      operatorUserId: "usr_ops_hold_t057",
      nowMs: BASE_NOW_MS,
    });

    const mockAl = createMockAutoLarisFetch({ adviceMode: "paid" });

    // Owner creates QRIS payment instruction containing SECRET_QRIS
    const createRes = await handleTenantBillingObligationsRequest(
      tenantId,
      makeReq(`${APP_ORIGIN}/api/tenants/${tenantId}/billing/obligations`, "POST", {
        cookie: owner.cookie,
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        body: { plan: "monthly", channelKind: "QRIS", channelCode: "QRIS" },
      }),
      buildTenantEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      obligation: { obligationId: string };
      attempt: { attemptId: string };
    };

    // Provision verified 2FA platform operator on console surface
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    const opFixture = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "ops-t057@punyasitus.com",
      password: "OperatorPassword!2026",
      name: "Superadmin T057",
      nowMs: BASE_NOW_MS,
    });
    const opCookie = opFixture.cookieHeader;

    // 1. Host isolation: console billing on app or tenant host returns 404
    const wrongHostRes = await handleConsoleBillingListRequest(
      makeReq(`${TENANT_ORIGIN}/api/console/billing`, "GET", { cookie: opCookie }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(wrongHostRes.status).toBe(404);

    // 2. Console operator lists strictly redacted billing metadata (ZERO QRIS/VA/secrets!)
    const listRes = await handleConsoleBillingListRequest(
      makeReq(`${CONSOLE_ORIGIN}/api/console/billing?tenantId=${tenantId}`, "GET", {
        cookie: opCookie,
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS },
    );
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain(SECRET_QRIS);
    expect(listText).not.toContain(TEST_AUTOLARIS_KEY);
    const listJson = JSON.parse(listText) as {
      obligations: readonly Record<string, unknown>[];
      refunds: readonly Record<string, unknown>[];
    };
    expect(findSensitiveBillingKeys(listJson)).toEqual([]);
    expect(listJson.obligations.length).toBe(1);

    // 3. Rejects arbitrary "markPaid" field on recheck endpoint (422)
    const bogusPaidRes = await handleConsoleBillingRecheckRequest(
      makeReq(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, "POST", {
        cookie: opCookie,
        origin: CONSOLE_ORIGIN,
        body: {
          attemptId: created.attempt.attemptId,
          tenantId,
          markPaid: true,
          reason: "Mencoba bypass tombol lunas sembarangan pada billing console",
        },
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS, autolarisFetch: mockAl.fetch },
    );
    expect(bogusPaidRes.status).toBe(422);

    // 4. Audited Advice Recheck grants settlement once & preserves operator hold!
    const recheckRes = await handleConsoleBillingRecheckRequest(
      makeReq(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, "POST", {
        cookie: opCookie,
        origin: CONSOLE_ORIGIN,
        body: {
          attemptId: created.attempt.attemptId,
          tenantId,
          reason: "Verifikasi Advice manual sesuai tiket dukungan #5701",
        },
      }),
      buildConsoleEnv(),
      {
        nowMs: BASE_NOW_MS + 1000,
        autolarisFetch: mockAl.fetch,
        settlementPolicy: createMockOnlyVerifiedSettlementPolicy(),
      },
    );
    expect(recheckRes.status).toBe(200);
    const recheckData = (await recheckRes.json()) as {
      recheck: { grantApplied: boolean; operatorHoldPreserved: boolean };
      auditId: string;
    };
    expect(recheckData.recheck.grantApplied).toBe(true);
    expect(recheckData.recheck.operatorHoldPreserved).toBe(true);
    expect(recheckData.auditId).toBeTruthy();

    // 5. Audited Duplicate Payment Refund Recording writes refund + platform_audit atomically
    const refundRes = await handleConsoleBillingRefundRequest(
      makeReq(`${CONSOLE_ORIGIN}/api/console/billing/refund`, "POST", {
        cookie: opCookie,
        origin: CONSOLE_ORIGIN,
        body: {
          obligationId: created.obligation.obligationId,
          paymentAttemptId: created.attempt.attemptId,
          tenantId,
          refundKind: "duplicate_payment",
          amountIdr: DEFAULT_MONTHLY_PRICE_IDR + 1_253,
          externalReference: "BTF-2026-T057-01",
          reason: "Pengembalian manual pembayaran ganda QRIS setelah verifikasi mutasi",
        },
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS + 2000 },
    );
    expect(refundRes.status).toBe(201);
    const refundData = (await refundRes.json()) as {
      refund: { id: string; refundKind: string; amountIdr: number };
      auditId: string;
    };
    expect(refundData.refund.refundKind).toBe("duplicate_payment");
    expect(refundData.refund.amountIdr).toBe(DEFAULT_MONTHLY_PRICE_IDR + 1_253);
    expect(refundData.auditId).toBeTruthy();

    // Duplicate refund for the same attempt fails safely with 409
    const dupRefundRes = await handleConsoleBillingRefundRequest(
      makeReq(`${CONSOLE_ORIGIN}/api/console/billing/refund`, "POST", {
        cookie: opCookie,
        origin: CONSOLE_ORIGIN,
        body: {
          obligationId: created.obligation.obligationId,
          paymentAttemptId: created.attempt.attemptId,
          tenantId,
          refundKind: "duplicate_payment",
          amountIdr: DEFAULT_MONTHLY_PRICE_IDR + 1_253,
          reason: "Mencoba mencatat refund ganda untuk percobaan pembayaran yang sama",
        },
      }),
      buildConsoleEnv(),
      { nowMs: BASE_NOW_MS + 3000 },
    );
    expect(dupRefundRes.status).toBe(409);

    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, { limit: 20 });
    expect(audits.some((a) => a.action === "console.billing.refund_recorded")).toBe(true);
  });
});
