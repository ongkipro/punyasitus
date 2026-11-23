import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import {
  BillingConflictError,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
} from "@punyasitus/core/billing/index";
import { computeAffiliateCommissionableBaseIdr } from "@punyasitus/core/billing/coupons";
import {
  applyBillingObligationsMigration,
  closeBillingObligationNonPaid,
  ensureBillingReconciliationSchema,
  markAttemptClosedFromAdvice,
  settleVerifiedPaymentAttempt,
} from "@punyasitus/db/billing/index";
import {
  applyBillingCouponsMigration,
  getCouponRedemptionByObligationId,
  getPromoCouponByCode,
  releaseCouponReservation,
  reserveCouponForCheckout,
} from "@punyasitus/db/billing/coupons/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleConsoleCouponDetailRequest } from "../../apps/web/src/pages/api/console/coupons/[couponId].ts";
import { handleConsoleCouponsRequest } from "../../apps/web/src/pages/api/console/coupons/index.ts";
import type { TenantBillingRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/_shared.ts";
import { handleTenantBillingCouponValidateRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/coupons/validate.ts";
import { handleTenantBillingObligationsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/obligations/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const RELAY_ORIGIN = "https://autolaris-relay.punyasitus.com";
const TEST_AUTOLARIS_KEY = "al_test_secret_key_t082_1234567890";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const NOW_MS = Date.UTC(2026, 5, 15, 10, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function buildRuntimeEnv(
  overrides: Partial<TenantBillingRuntimeEnv> = {},
): TenantBillingRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    AUTOLARIS_RELAY_URL: RELAY_ORIGIN,
    AUTOLARIS_API_KEY: TEST_AUTOLARIS_KEY,
    AUTOLARIS_ACCOUNT_ID: "acct-t082-01",
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractCookiePair(response: Response, name: string): string {
  const found = getSetCookies(response.headers).find((c) => c.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`Missing cookie ${name} in response`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeRequest(
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  options: {
    readonly origin?: string | null;
    readonly cookie?: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? new URL(url).origin);
    }
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function createMockAutoLarisFetch(capturedSubmits: Record<string, unknown>[] = []): typeof fetch {
  let trxSeq = 1;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/list_payment")) {
      return new Response(
        JSON.stringify({
          rc: "00",
          ket: "Sukses",
          data: [
            {
              channel_code: "QRIS",
              name: "QRIS Nasional",
              tipe_admin: "persen",
              admin: "0.7",
            },
            {
              channel_code: "VABCA",
              name: "BCA Virtual Account",
              tipe_admin: "fix",
              admin: "4000.0",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/submit")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedSubmits.push(body);
      const channelCode = String(body.channel_code ?? "QRIS");
      const grandTotal = Number(body.grand_total ?? 0);
      const isVa = channelCode.startsWith("VA");
      const fee = isVa ? 4_000 : Math.round((grandTotal * 7) / 1000);
      const trxId = `TRX_T082_${String(trxSeq++).padStart(4, "0")}`;
      return new Response(
        JSON.stringify({
          rc: "00",
          ket: "Success",
          data: {
            channel_code: channelCode,
            transaction_id: trxId,
            reff_id: body.reff_id,
            biaya_kirim: 0,
            biaya_cod: 0,
            biaya_asuransi: 0,
            biaya_admin: fee,
            diskon: 0,
            total: grandTotal + fee,
            payment_info: {
              expired: "2026-06-15 13:00:00",
              va: isVa ? "8800112233445566" : "",
              qr: isVa ? "" : "0002010102125910PUNYASITUS6007JAKARTA6304ABCD",
              url: "",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  };
}

let seqCounter = 1;
async function provisionTenant(
  tag: string,
  runtimeEnv: TenantBillingRuntimeEnv,
): Promise<{
  readonly tenantId: string;
  readonly handle: string;
  readonly owner: { readonly userId: string; readonly cookie: string };
  readonly editor: { readonly userId: string; readonly cookie: string };
}> {
  const seq = String(seqCounter++).padStart(4, "0");
  const tenantId = `01JT082TENANT000000000${seq}`;
  const orgId = `01JT082ORG000000000000${seq}`;
  const handle = `cpn-${tag}-${seq}`;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(NOW_MS);

  const signUp = async (email: string, name: string) => {
    const res = await handleBetterAuthRequest(
      makeRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
        origin: APP_ORIGIN,
        body: { email, password: "StrongPassword!2026", name },
      }),
      runtimeEnv,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { user?: { id: string } };
    return {
      userId: data.user?.id ?? "",
      cookie: extractCookiePair(res, APP_SESSION_COOKIE_NAME),
    };
  };

  const owner = await signUp(`owner-${tag}-${seq}@example.test`, `Owner ${tag}`);
  const editor = await signUp(`editor-${tag}-${seq}@example.test`, `Editor ${tag}`);

  await db.insert(organizations).values({
    id: orgId,
    name: `Org ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Bisnis ${tag} ${seq}`,
    vertical: "compro",
    status: "trial",
    trialEndsAt: new Date(NOW_MS + 5 * DAY_MS),
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(members).values([
    { id: `01JT082MO0000000000000${seq}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
    { id: `01JT082ME0000000000000${seq}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
  ]);

  return { tenantId, handle, owner, editor };
}

async function createConsoleOperator() {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: TEST_CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
  return createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
    auth,
    email: `coupon-op-${seqCounter++}@example.com`,
    password: "OperatorPassword!234",
    name: "Coupon Superadmin",
    nowMs: NOW_MS,
  });
}

async function cleanDb() {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM coupon_redemptions"),
    env.PLATFORM_DB.prepare("DELETE FROM promo_coupons"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_reconciliation_leases"),
    env.PLATFORM_DB.prepare("DELETE FROM billing_refund_records"),
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
    env.PLATFORM_DB.prepare("DELETE FROM users"),
  ]);
}

describe("TASK-082 workerd integration — Yearly Plans, Console Coupons & Atomic Concurrent Redemption Engine", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyBillingObligationsMigration(env.PLATFORM_DB);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB);
    await applyBillingCouponsMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("enforces console host/operator/2FA/step-up guards, optimistic locking, cap floors, and atomic platform_audit", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const tenant = await provisionTenant("authz", runtimeEnv);

    // 1. Non-console host (app.punyasitus.com) is denied with 404
    const wrongHostRes = await handleConsoleCouponsRequest(
      makeRequest(`${APP_ORIGIN}/api/console/coupons`, "GET", {
        cookie: op.cookieHeader,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(wrongHostRes.status).toBe(404);

    // 2. Non-operator tenant owner on console host is denied with 403/401
    const nonOpRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "GET", {
        cookie: tenant.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect([401, 403]).toContain(nonOpRes.status);

    // 3. Operator with stale step-up (> 10 minutes old) receives 403 REAUTH_REQUIRED on POST
    const staleCreateRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "STALE10",
          discountKind: "percent",
          discountValue: 10,
          eligiblePlans: ["monthly", "yearly"],
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 10 * DAY_MS,
          reason: "Membuat kupon promo dengan sesi step-up lama",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000 },
    );
    expect(staleCreateRes.status).toBe(403);
    const staleBody = (await staleCreateRes.json()) as { code?: string };
    expect(staleBody.code).toBe("REAUTH_REQUIRED");

    // 4. Active 2FA operator with fresh step-up creates coupon atomically with platform_audit
    const createRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "HEMAT20",
          discountKind: "percent",
          discountValue: 20,
          eligiblePlans: ["monthly", "yearly"],
          maxRedemptions: 5,
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 30 * DAY_MS,
          notes: "Kampanye promo tahunan",
          reason: "Aktivasi kupon promo resmi kuartal kedua",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      success: boolean;
      coupon: { id: string; code: string; version: number; active: boolean };
      auditId: string;
    };
    expect(created.success).toBe(true);
    expect(created.coupon.code).toBe("HEMAT20");
    expect(created.coupon.version).toBe(1);
    expect(created.auditId).toBeTruthy();

    const auditsAfterCreate = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "billing.coupon.created",
      targetId: created.coupon.id,
    });
    expect(auditsAfterCreate).toHaveLength(1);

    // 5. Duplicate code returns 409 COUPON_CODE_EXISTS
    const dupRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "hemat20",
          discountKind: "fixed_idr",
          discountValue: 25_000,
          eligiblePlans: ["monthly"],
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 10 * DAY_MS,
          reason: "Percobaan duplikasi kode kupon yang sudah ada",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(dupRes.status).toBe(409);
    expect(((await dupRes.json()) as { code?: string }).code).toBe("COUPON_CODE_EXISTS");

    // 6. PATCH with stale expectedVersion fails 409 STALE_VERSION with zero phantom audit rows
    const stalePatchRes = await handleConsoleCouponDetailRequest(
      created.coupon.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons/${created.coupon.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          expectedVersion: 99,
          active: false,
          reason: "Menonaktifkan kupon dengan versi yang sudah usang",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(stalePatchRes.status).toBe(409);
    expect(((await stalePatchRes.json()) as { code?: string }).code).toBe("STALE_VERSION");

    // Simulate 3 redemptions so we can test max_redemptions floor check
    await env.PLATFORM_DB.prepare("UPDATE promo_coupons SET redeemed_count = 3 WHERE id = ?")
      .bind(created.coupon.id)
      .run();

    // 7. Reducing maxRedemptions below redeemedCount (2 < 3) fails with 422 INVALID_MAX_REDEMPTIONS_CAP
    const badCapRes = await handleConsoleCouponDetailRequest(
      created.coupon.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons/${created.coupon.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          expectedVersion: 1,
          maxRedemptions: 2,
          reason: "Mencoba menurunkan batas penukaran di bawah jumlah terpakai",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(badCapRes.status).toBe(422);
    expect(((await badCapRes.json()) as { code?: string }).code).toBe(
      "INVALID_MAX_REDEMPTIONS_CAP",
    );

    // 8. Valid PATCH deactivating coupon bumps version and writes atomic platform_audit
    const patchRes = await handleConsoleCouponDetailRequest(
      created.coupon.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons/${created.coupon.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          expectedVersion: 1,
          active: false,
          maxRedemptions: 10,
          reason: "Menonaktifkan sementara kupon untuk evaluasi kuota promo",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      coupon: { active: boolean; version: number; maxRedemptions: number };
    };
    expect(patched.coupon.active).toBe(false);
    expect(patched.coupon.version).toBe(2);
    expect(patched.coupon.maxRedemptions).toBe(10);

    const auditsAfterPatch = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "billing.coupon.updated",
      targetId: created.coupon.id,
    });
    expect(auditsAfterPatch).toHaveLength(1);
  });

  it("rejects expired, exhausted, wrong-plan, inactive, stacked, below-floor, and unauthorized coupon previews", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const tenantA = await provisionTenant("val-a", runtimeEnv);
    const tenantB = await provisionTenant("val-b", runtimeEnv);
    const mockFetch = createMockAutoLarisFetch();

    const createCoupon = async (payload: Record<string, unknown>) => {
      const res = await handleConsoleCouponsRequest(
        makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
          origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
          body: {
            reason: "Membuat kupon uji skenario validasi checkout lengkap",
            ...payload,
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { coupon: { id: string; code: string } }).coupon;
    };

    await createCoupon({
      code: "VALIDYEAR20",
      discountKind: "percent",
      discountValue: 20,
      eligiblePlans: ["yearly"],
      startsAt: NOW_MS - DAY_MS,
      endsAt: NOW_MS + 10 * DAY_MS,
    });
    await createCoupon({
      code: "EXPIRED10",
      discountKind: "percent",
      discountValue: 10,
      eligiblePlans: ["monthly", "yearly"],
      startsAt: NOW_MS - 10 * DAY_MS,
      endsAt: NOW_MS - DAY_MS,
    });
    await createCoupon({
      code: "INACTIVE10",
      discountKind: "percent",
      discountValue: 10,
      eligiblePlans: ["monthly", "yearly"],
      startsAt: NOW_MS - DAY_MS,
      endsAt: NOW_MS + 10 * DAY_MS,
      active: false,
    });
    const exhausted = await createCoupon({
      code: "EXHAUST10",
      discountKind: "percent",
      discountValue: 10,
      eligiblePlans: ["monthly", "yearly"],
      maxRedemptions: 1,
      startsAt: NOW_MS - DAY_MS,
      endsAt: NOW_MS + 10 * DAY_MS,
    });
    await env.PLATFORM_DB.prepare("UPDATE promo_coupons SET redeemed_count = 1 WHERE id = ?")
      .bind(exhausted.id)
      .run();
    await createCoupon({
      code: "TOOBIG175K",
      discountKind: "fixed_idr",
      discountValue: 175_000, // 179_000 - 175_000 = 4_000 < 10_000 floor!
      eligiblePlans: ["monthly"],
      startsAt: NOW_MS - DAY_MS,
      endsAt: NOW_MS + 10 * DAY_MS,
    });

    // Non-owner (editor) -> 403; cross-tenant -> 404
    const editorRes = await handleTenantBillingCouponValidateRequest(
      tenantA.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/coupons/validate`, "POST", {
        cookie: tenantA.editor.cookie,
        body: { plan: "yearly", couponCode: "VALIDYEAR20" },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(editorRes.status).toBe(403);

    const crossTenantRes = await handleTenantBillingCouponValidateRequest(
      tenantB.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantB.tenantId}/billing/coupons/validate`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { plan: "yearly", couponCode: "VALIDYEAR20" },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(crossTenantRes.status).toBe(404);

    // Valid yearly coupon returns exact IDR breakdown + affiliate net base
    const validRes = await handleTenantBillingCouponValidateRequest(
      tenantA.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/coupons/validate`, "POST", {
        cookie: tenantA.owner.cookie,
        body: { plan: "yearly", couponCode: "validyear20", channelCode: "VABCA" },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(validRes.status).toBe(200);
    const validData = (await validRes.json()) as {
      valid: boolean;
      coupon: { code: string };
      pricing: {
        baseAmountIdr: number;
        discountAmountIdr: number;
        netBaseAmountIdr: number;
        affiliateCommissionableBaseIdr: number;
        estimatedChannelFeeIdr: number;
        estimatedTotalPayableIdr: number;
        yearlySavingsIdr: number;
      };
    };
    expect(validData.valid).toBe(true);
    expect(validData.coupon.code).toBe("VALIDYEAR20");
    expect(validData.pricing.baseAmountIdr).toBe(DEFAULT_YEARLY_PRICE_IDR);
    expect(validData.pricing.discountAmountIdr).toBe(358_000);
    expect(validData.pricing.netBaseAmountIdr).toBe(1_432_000);
    expect(validData.pricing.affiliateCommissionableBaseIdr).toBe(1_432_000);
    expect(validData.pricing.estimatedChannelFeeIdr).toBe(4_000);
    expect(validData.pricing.estimatedTotalPayableIdr).toBe(1_436_000);
    expect(validData.pricing.yearlySavingsIdr).toBe(358_000);

    // Negative cases
    const negativeCases: readonly {
      readonly plan: "monthly" | "yearly";
      readonly couponCode: unknown;
      readonly expectedReason: string;
    }[] = [
      { plan: "monthly", couponCode: "EXPIRED10", expectedReason: "COUPON_EXPIRED" },
      { plan: "monthly", couponCode: "INACTIVE10", expectedReason: "COUPON_INACTIVE" },
      { plan: "monthly", couponCode: "EXHAUST10", expectedReason: "COUPON_EXHAUSTED" },
      { plan: "monthly", couponCode: "VALIDYEAR20", expectedReason: "COUPON_PLAN_INELIGIBLE" },
      { plan: "monthly", couponCode: "TOOBIG175K", expectedReason: "COUPON_BELOW_MIN_PAYMENT_FLOOR" },
      { plan: "monthly", couponCode: "VALIDYEAR20,EXPIRED10", expectedReason: "COUPON_STACKING_FORBIDDEN" },
      { plan: "monthly", couponCode: ["VALIDYEAR20", "EXPIRED10"], expectedReason: "COUPON_STACKING_FORBIDDEN" },
      { plan: "monthly", couponCode: "TIDAKADA99", expectedReason: "COUPON_NOT_FOUND" },
    ];

    for (const tc of negativeCases) {
      const res = await handleTenantBillingCouponValidateRequest(
        tenantA.tenantId,
        makeRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.tenantId}/billing/coupons/validate`,
          "POST",
          {
            cookie: tenantA.owner.cookie,
            body: { plan: tc.plan, couponCode: tc.couponCode },
          },
        ),
        runtimeEnv,
        { nowMs: NOW_MS, autolarisFetch: mockFetch },
      );
      expect(res.status).toBe(422);
      const errBody = (await res.json()) as {
        error: { reasonCode?: string; fields?: { code?: string }[] };
      };
      expect(errBody.error.reasonCode ?? errBody.error.fields?.[0]?.code).toBe(tc.expectedReason);
    }
  });

  it("atomically enforces max_redemptions = 2 under 6 concurrent Promise.all checkouts and blocks repeat-tenant redemption", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const capturedSubmits: Record<string, unknown>[] = [];
    const mockFetch = createMockAutoLarisFetch(capturedSubmits);

    // Create a coupon capped at STRICTLY 2 redemptions
    const createRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "FLASH2ONLY",
          discountKind: "fixed_idr",
          discountValue: 50_000,
          eligiblePlans: ["monthly", "yearly"],
          maxRedemptions: 2,
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 10 * DAY_MS,
          reason: "Kupon kilat terbatas hanya untuk 2 situs pertama",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(createRes.status).toBe(201);

    // Provision 6 distinct tenants
    const sixTenants = await Promise.all(
      Array.from({ length: 6 }, (_, i) => provisionTenant(`race${i + 1}`, runtimeEnv)),
    );

    // Fire 6 concurrent checkouts against max_redemptions = 2!
    const responses = await Promise.all(
      sixTenants.map((t) =>
        handleTenantBillingObligationsRequest(
          t.tenantId,
          makeRequest(`${APP_ORIGIN}/api/tenants/${t.tenantId}/billing/obligations`, "POST", {
            cookie: t.owner.cookie,
            idempotencyKey: crypto.randomUUID(),
            body: {
              plan: "yearly",
              channelKind: "VA",
              channelCode: "VABCA",
              couponCode: "FLASH2ONLY",
            },
          }),
          runtimeEnv,
          { nowMs: NOW_MS, autolarisFetch: mockFetch },
        ),
      ),
    );

    const statuses = responses.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 201);
    const failed = statuses.filter((s) => s === 422 || s === 409);

    expect(succeeded).toHaveLength(2);
    expect(failed).toHaveLength(4);

    // Verify DB truth: redeemed_count === 2 and coupon_redemptions count === 2
    const couponRow = await getPromoCouponByCode(env.PLATFORM_DB, "FLASH2ONLY");
    expect(couponRow?.redeemedCount).toBe(2);

    const redemptionCountRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM coupon_redemptions WHERE coupon_id = ?",
    )
      .bind(couponRow!.id)
      .first<{ readonly cnt: number }>();
    expect(redemptionCountRow?.cnt).toBe(2);

    // Verify AutoLaris received exact discounted net base (1,790,000 - 50,000 = 1,740,000)
    expect(capturedSubmits).toHaveLength(2);
    for (const submit of capturedSubmits) {
      expect(Number(submit.grand_total)).toBe(DEFAULT_YEARLY_PRICE_IDR - 50_000);
    }

    // Verify stored obligation & affiliate commissionable net base contract
    const winningIndex = statuses.findIndex((s) => s === 201);
    const winnerTenant = sixTenants[winningIndex]!;
    const winnerBody = (await responses[winningIndex]!.json()) as {
      obligation: {
        obligationId: string;
        baseAmountIdr: number;
        discountAmountIdr: number;
        netAmountIdr: number;
        couponCode?: string;
      };
      attempt: {
        baseAmountIdr: number;
        discountAmountIdr: number;
        channelFeeIdr: number;
        totalPayableIdr: number;
      };
    };

    expect(winnerBody.obligation.baseAmountIdr).toBe(DEFAULT_YEARLY_PRICE_IDR);
    expect(winnerBody.obligation.discountAmountIdr).toBe(50_000);
    expect(winnerBody.obligation.netAmountIdr).toBe(1_740_000);
    expect(winnerBody.obligation.couponCode).toBe("FLASH2ONLY");
    expect(winnerBody.attempt.channelFeeIdr).toBe(4_000);
    expect(winnerBody.attempt.totalPayableIdr).toBe(1_744_000);

    // Affiliate net base MUST exclude channel fee and reflect post-coupon discount!
    const expectedAffiliateBase = computeAffiliateCommissionableBaseIdr({
      baseAmountIdr: winnerBody.obligation.baseAmountIdr,
      discountAmountIdr: winnerBody.obligation.discountAmountIdr,
    });
    expect(expectedAffiliateBase).toBe(1_740_000);

    const oblDbRow = await env.PLATFORM_DB.prepare(
      "SELECT net_amount_idr, coupon_snapshot_json FROM billing_obligations WHERE id = ?",
    )
      .bind(winnerBody.obligation.obligationId)
      .first<{ readonly net_amount_idr: number; readonly coupon_snapshot_json: string | null }>();
    expect(oblDbRow?.net_amount_idr).toBe(1_740_000);
    const snap = JSON.parse(oblDbRow?.coupon_snapshot_json ?? "{}") as {
      affiliateCommissionableBaseIdr?: number;
      netBaseAmountIdr?: number;
    };
    expect(snap.netBaseAmountIdr).toBe(1_740_000);
    expect(snap.affiliateCommissionableBaseIdr).toBe(1_740_000);

    // Now bump max_redemptions to 10 so quota is no longer exhausted, close winner's obligation,
    // and verify the SAME tenant STILL CANNOT redeem FLASH2ONLY a second time (1-per-tenant rule)!
    await env.PLATFORM_DB.prepare("UPDATE promo_coupons SET max_redemptions = 10 WHERE id = ?")
      .bind(couponRow!.id)
      .run();
    await env.PLATFORM_DB.prepare(
      "UPDATE billing_obligations SET status = 'paid' WHERE id = ?",
    )
      .bind(winnerBody.obligation.obligationId)
      .run();
    await env.PLATFORM_DB.prepare(
      "UPDATE payment_attempts SET state = 'settled', lifecycle_state = 'paid' WHERE obligation_id = ?",
    )
      .bind(winnerBody.obligation.obligationId)
      .run();

    // Validate preview rejects repeat tenant with 409 COUPON_ALREADY_REDEEMED
    const repeatPreviewRes = await handleTenantBillingCouponValidateRequest(
      winnerTenant.tenantId,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${winnerTenant.tenantId}/billing/coupons/validate`,
        "POST",
        {
          cookie: winnerTenant.owner.cookie,
          body: { plan: "monthly", couponCode: "FLASH2ONLY" },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(repeatPreviewRes.status).toBe(409);
    const repeatPreviewErr = (await repeatPreviewRes.json()) as {
      error: { reasonCode?: string };
    };
    expect(repeatPreviewErr.error.reasonCode).toBe("COUPON_ALREADY_REDEEMED");

    // Direct checkout attempt ALSO rejects repeat tenant with 409 COUPON_ALREADY_REDEEMED
    const repeatCheckoutRes = await handleTenantBillingObligationsRequest(
      winnerTenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${winnerTenant.tenantId}/billing/obligations`, "POST", {
        cookie: winnerTenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "monthly",
          channelKind: "VA",
          channelCode: "VABCA",
          couponCode: "FLASH2ONLY",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(repeatCheckoutRes.status).toBe(409);
    const afterRepeatCoupon = await getPromoCouponByCode(env.PLATFORM_DB, "FLASH2ONLY");
    expect(afterRepeatCoupon?.redeemedCount).toBe(2); // NEVER incremented!
  });

  it("proves standalone reserveCouponForCheckout enforces 1-per-tenant atomically and releaseCouponReservation decrements redeemed_count exactly once", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const tenant = await provisionTenant("rel", runtimeEnv);

    const createRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "RELEASE20",
          discountKind: "percent",
          discountValue: 20,
          eligiblePlans: ["monthly"],
          maxRedemptions: 3,
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 10 * DAY_MS,
          reason: "Kupon uji reservasi dan pelepasan atomik pada pembatalan tagihan",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(createRes.status).toBe(201);

    const obl1 = "01JT082OBLRELEASE000000001";
    const obl2 = "01JT082OBLRELEASE000000002";

    // Two concurrent reservations for the SAME tenant -> strictly 1 succeeds, 1 throws COUPON_ALREADY_REDEEMED!
    const settled = await Promise.allSettled([
      reserveCouponForCheckout(env.PLATFORM_DB, {
        couponCode: "RELEASE20",
        tenantId: tenant.tenantId,
        obligationId: obl1,
        plan: "monthly",
        baseAmountIdr: DEFAULT_MONTHLY_PRICE_IDR,
        nowMs: NOW_MS,
      }),
      reserveCouponForCheckout(env.PLATFORM_DB, {
        couponCode: "RELEASE20",
        tenantId: tenant.tenantId,
        obligationId: obl2,
        plan: "monthly",
        baseAmountIdr: DEFAULT_MONTHLY_PRICE_IDR,
        nowMs: NOW_MS,
      }),
    ]);

    const okResults = settled.filter((r) => r.status === "fulfilled");
    const errResults = settled.filter((r) => r.status === "rejected");
    expect(okResults).toHaveLength(1);
    expect(errResults).toHaveLength(1);
    const rejectionReason = (errResults[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(BillingConflictError);
    expect((rejectionReason as BillingConflictError).reasonCode).toBe("COUPON_ALREADY_REDEEMED");

    const winningObl = (
      okResults[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveCouponForCheckout>>>
    ).value.redemption.obligationId;

    const afterReserve = await getPromoCouponByCode(env.PLATFORM_DB, "RELEASE20");
    expect(afterReserve?.redeemedCount).toBe(1);

    // Concurrent duplicate releases decrement redeemed_count EXACTLY ONCE (1 -> 0, never negative!)
    const releaseResults = await Promise.all([
      releaseCouponReservation(env.PLATFORM_DB, { obligationId: winningObl, nowMs: NOW_MS + 1000 }),
      releaseCouponReservation(env.PLATFORM_DB, { obligationId: winningObl, nowMs: NOW_MS + 1000 }),
    ]);
    expect(releaseResults.filter((r) => r.released)).toHaveLength(1);

    const afterRelease = await getPromoCouponByCode(env.PLATFORM_DB, "RELEASE20");
    expect(afterRelease?.redeemedCount).toBe(0);
  });

  it("wires coupon release on non-paid obligation expiry (allowing same-tenant re-redemption) and marks coupon consumed atomically on verified settlement", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const tenant = await provisionTenant("lifecycle", runtimeEnv);
    const mockFetch = createMockAutoLarisFetch();

    // Create coupon LIFE20 (20% off yearly -> net 1,432,000)
    const createRes = await handleConsoleCouponsRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
        origin: CONSOLE_ORIGIN,
        cookie: op.cookieHeader,
        body: {
          code: "LIFE20",
          discountKind: "percent",
          discountValue: 20,
          eligiblePlans: ["yearly"],
          maxRedemptions: 2,
          startsAt: NOW_MS - DAY_MS,
          endsAt: NOW_MS + 30 * DAY_MS,
          reason: "Kupon uji siklus hidup reservasi, pelepasan, dan konsumsi settlement",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(createRes.status).toBe(201);

    // 1. First checkout reserves LIFE20 (redeemed_count = 1, status = 'reserved')
    const firstRes = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "VA",
          channelCode: "VABCA",
          couponCode: "LIFE20",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: mockFetch },
    );
    expect(firstRes.status).toBe(201);
    const firstBody = (await firstRes.json()) as {
      obligation: { obligationId: string; netAmountIdr: number };
      attempt: { attemptId: string };
    };
    expect(firstBody.obligation.netAmountIdr).toBe(1_432_000);

    const firstRedemption = await getCouponRedemptionByObligationId(
      env.PLATFORM_DB,
      firstBody.obligation.obligationId,
    );
    expect(firstRedemption?.status).toBe("reserved");
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "LIFE20"))?.redeemedCount).toBe(1);

    // 2. Advice marks attempt expired past obligation due_at -> closes obligation & releases coupon!
    const pastDueMs = NOW_MS + 25 * 60 * 60 * 1000;
    const closedRes = await markAttemptClosedFromAdvice(env.PLATFORM_DB, {
      attemptId: firstBody.attempt.attemptId,
      obligationId: firstBody.obligation.obligationId,
      tenantId: tenant.tenantId,
      targetState: "expired",
      safeFailureCode: "PROVIDER_EXPIRED",
      actorUserId: null,
      actorRole: "system",
      nowMs: pastDueMs,
    });
    expect(closedRes.updated).toBe(true);

    // Verify obligation is expired, redemption is released, and redeemed_count decremented back to 0!
    const oblAfterClose = await env.PLATFORM_DB.prepare(
      "SELECT status FROM billing_obligations WHERE id = ?",
    )
      .bind(firstBody.obligation.obligationId)
      .first<{ readonly status: string }>();
    expect(oblAfterClose?.status).toBe("expired");
    expect(
      (await getCouponRedemptionByObligationId(env.PLATFORM_DB, firstBody.obligation.obligationId))
        ?.status,
    ).toBe("released");
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "LIFE20"))?.redeemedCount).toBe(0);

    // Calling closeBillingObligationNonPaid again is idempotent (redeemed_count NEVER drops below 0)
    const dupClose = await closeBillingObligationNonPaid(env.PLATFORM_DB, {
      obligationId: firstBody.obligation.obligationId,
      tenantId: tenant.tenantId,
      targetStatus: "expired",
      nowMs: pastDueMs + 1000,
    });
    expect(dupClose.closed).toBe(false);
    expect(dupClose.couponReleased).toBe(false);
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "LIFE20"))?.redeemedCount).toBe(0);

    // 3. Same tenant CAN now re-redeem LIFE20 on a brand-new checkout!
    const secondRes = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "VA",
          channelCode: "VABCA",
          couponCode: "LIFE20",
        },
      }),
      runtimeEnv,
      { nowMs: pastDueMs + 2000, autolarisFetch: mockFetch },
    );
    expect(secondRes.status).toBe(201);
    const secondBody = (await secondRes.json()) as {
      obligation: { obligationId: string; netAmountIdr: number };
      attempt: { attemptId: string; totalPayableIdr: number };
    };
    expect(secondBody.obligation.obligationId).not.toBe(firstBody.obligation.obligationId);
    expect(secondBody.obligation.netAmountIdr).toBe(1_432_000);
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "LIFE20"))?.redeemedCount).toBe(1);

    // 4. Authoritative settlement transitions coupon_redemptions.status from 'reserved' -> 'consumed'!
    const settleRes = await settleVerifiedPaymentAttempt(env.PLATFORM_DB, {
      attemptId: secondBody.attempt.attemptId,
      obligationId: secondBody.obligation.obligationId,
      tenantId: tenant.tenantId,
      plan: "yearly",
      verifiedAmountIdr: secondBody.attempt.totalPayableIdr,
      providerTransactionId: "TRX_T082_0002",
      providerStatus: "PAID",
      policyProfile: "mock_only",
      policyVersion: "v1-test",
      settledAtMs: pastDueMs + 5000,
      reconciledVia: "advice",
      actorUserId: null,
      actorRole: "system",
      nowMs: pastDueMs + 5000,
    });
    expect(settleRes.outcome).toBe("settled");

    const consumedRedemption = await getCouponRedemptionByObligationId(
      env.PLATFORM_DB,
      secondBody.obligation.obligationId,
    );
    expect(consumedRedemption?.status).toBe("consumed");
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "LIFE20"))?.redeemedCount).toBe(1);

    // 5. After consumption, same tenant is permanently blocked from redeeming LIFE20 again!
    const thirdRes = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "VA",
          channelCode: "VABCA",
          couponCode: "LIFE20",
        },
      }),
      runtimeEnv,
      { nowMs: pastDueMs + 10_000, autolarisFetch: mockFetch },
    );
    expect(thirdRes.status).toBe(409);
    const thirdErr = (await thirdRes.json()) as { error: { reasonCode?: string } };
    expect(thirdErr.error.reasonCode).toBe("COUPON_ALREADY_REDEEMED");
  });

  it("handles open-obligation retries cleanly with same couponCode, without couponCode (preserving exact netAmountIdr), and rejects conflicting couponCode with 409", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const op = await createConsoleOperator();
    const tenant = await provisionTenant("retry", runtimeEnv);

    // Create RETRY20 (20% off yearly -> net 1,432,000) and OTHER10
    for (const cfg of [
      { code: "RETRY20", discountValue: 20 },
      { code: "OTHER10", discountValue: 10 },
    ]) {
      const r = await handleConsoleCouponsRequest(
        makeRequest(`${CONSOLE_ORIGIN}/api/console/coupons`, "POST", {
          origin: CONSOLE_ORIGIN,
          cookie: op.cookieHeader,
          body: {
            code: cfg.code,
            discountKind: "percent",
            discountValue: cfg.discountValue,
            eligiblePlans: ["yearly"],
            maxRedemptions: 5,
            startsAt: NOW_MS - DAY_MS,
            endsAt: NOW_MS + 10 * DAY_MS,
            reason: "Kupon uji pengulangan percobaan pembayaran pada tagihan terbuka",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(r.status).toBe(201);
    }

    let submitCallIndex = 0;
    const submittedGrandTotals: number[] = [];
    const retryMockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/list_payment")) {
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Sukses",
            data: [
              { channel_code: "QRIS", name: "QRIS Nasional", tipe_admin: "persen", admin: "0.7" },
              { channel_code: "VABCA", name: "BCA Virtual Account", tipe_admin: "fix", admin: "4000.0" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/submit")) {
        submitCallIndex += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const grandTotal = Number(body.grand_total ?? 0);
        submittedGrandTotals.push(grandTotal);

        // Call #1: definite refusal (rc: "01") -> leaves obligation OPEN, attempt FAILED!
        if (submitCallIndex === 1) {
          return new Response(
            JSON.stringify({ rc: "01", ket: "Channel sementara menolak permintaan" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const fee = Math.round((grandTotal * 7) / 1000);
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Success",
            data: {
              channel_code: String(body.channel_code ?? "QRIS"),
              transaction_id: `TRX_RETRY_${submitCallIndex}`,
              reff_id: body.reff_id,
              biaya_kirim: 0,
              biaya_cod: 0,
              biaya_asuransi: 0,
              biaya_admin: fee,
              diskon: 0,
              total: grandTotal + fee,
              payment_info: {
                expired: "2026-06-15 13:00:00",
                va: "",
                qr: "0002010102125910PUNYASITUS6007JAKARTA6304ABCD",
                url: "",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    // Attempt #1 with RETRY20 -> definite refusal (503), obligation stays open with net = 1,432,000
    const att1Res = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "QRIS",
          channelCode: "QRIS",
          couponCode: "RETRY20",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, autolarisFetch: retryMockFetch },
    );
    expect(att1Res.status).toBe(503);
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "RETRY20"))?.redeemedCount).toBe(1);

    // Retry with DIFFERENT coupon code -> 409 COUPON_CONFLICT_WITH_OPEN_OBLIGATION (no AutoLaris call!)
    const conflictRes = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "QRIS",
          channelCode: "QRIS",
          couponCode: "OTHER10",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS + 1000, autolarisFetch: retryMockFetch },
    );
    expect(conflictRes.status).toBe(409);
    const conflictBody = (await conflictRes.json()) as { error: { reasonCode?: string } };
    expect(conflictBody.error.reasonCode).toBe("COUPON_CONFLICT_WITH_OPEN_OBLIGATION");
    expect(submitCallIndex).toBe(1);

    // Attempt #2: Retry on the SAME open obligation WITH the SAME couponCode ("RETRY20") -> 201!
    const att2Res = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "QRIS",
          channelCode: "QRIS",
          couponCode: "RETRY20",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS + 2000, autolarisFetch: retryMockFetch },
    );
    expect(att2Res.status).toBe(201);
    const att2Body = (await att2Res.json()) as {
      obligation: { obligationId: string; netAmountIdr: number; discountAmountIdr: number };
      attempt: { attemptId: string; channelFeeIdr: number; totalPayableIdr: number };
    };
    expect(att2Body.obligation.netAmountIdr).toBe(1_432_000);
    expect(att2Body.obligation.discountAmountIdr).toBe(358_000);
    expect(att2Body.attempt.channelFeeIdr).toBe(10_024); // 0.7% of 1,432,000!
    expect(att2Body.attempt.totalPayableIdr).toBe(1_442_024);
    expect((await getPromoCouponByCode(env.PLATFORM_DB, "RETRY20"))?.redeemedCount).toBe(1);

    // Expire Attempt #2 while obligation is STILL within due_at (so obligation remains open)
    await markAttemptClosedFromAdvice(env.PLATFORM_DB, {
      attemptId: att2Body.attempt.attemptId,
      obligationId: att2Body.obligation.obligationId,
      tenantId: tenant.tenantId,
      targetState: "expired",
      safeFailureCode: "QR_TIMEOUT",
      actorUserId: null,
      actorRole: "system",
      nowMs: NOW_MS + 60_000,
    });

    // Attempt #3: Retry on the SAME open obligation WITHOUT couponCode -> MUST reuse exact netAmountIdr (1,432,000)!
    const att3Res = await handleTenantBillingObligationsRequest(
      tenant.tenantId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenant.tenantId}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: crypto.randomUUID(),
        body: {
          plan: "yearly",
          channelKind: "QRIS",
          channelCode: "QRIS",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS + 65_000, autolarisFetch: retryMockFetch },
    );
    expect(att3Res.status).toBe(201);
    const att3Body = (await att3Res.json()) as {
      obligation: { obligationId: string; netAmountIdr: number; discountAmountIdr: number };
      attempt: { channelFeeIdr: number; totalPayableIdr: number };
    };
    expect(att3Body.obligation.obligationId).toBe(att2Body.obligation.obligationId);
    expect(att3Body.obligation.netAmountIdr).toBe(1_432_000);
    expect(att3Body.obligation.discountAmountIdr).toBe(358_000);
    expect(att3Body.attempt.channelFeeIdr).toBe(10_024);
    expect(att3Body.attempt.totalPayableIdr).toBe(1_442_024);
    expect(submittedGrandTotals).toEqual([1_432_000, 1_432_000, 1_432_000]);
  });
});
