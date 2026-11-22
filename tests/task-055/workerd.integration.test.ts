import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
} from "@punyasitus/core/billing/index";
import { applyBillingObligationsMigration } from "@punyasitus/db/billing/index";
import { applyPlatformMigrations, createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantBillingRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/_shared.ts";
import { handleTenantBillingAttemptDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/attempts/[attemptId].ts";
import { handleTenantBillingAttemptsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/attempts/index.ts";
import { handleTenantBillingChannelsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/channels.ts";
import { handleTenantBillingOverviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/index.ts";
import { handleTenantBillingObligationDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/obligations/[obligationId].ts";
import { handleTenantBillingObligationsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/obligations/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const RELAY_ORIGIN = "https://autolaris-relay.punyasitus.com";
const TEST_AUTOLARIS_KEY = "al_test_secret_key_never_logged_1234567890";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // Jan 31, 2026 -> exercises month-end clamp!

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
    AUTOLARIS_ACCOUNT_ID: "acct-test-01",
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const sessionHeader = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error(
      `Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`,
    );
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makeBillingRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly contentType?: string | null;
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (method !== "GET") {
    if (options.contentType !== null) {
      headers.set("Content-Type", options.contentType ?? "application/json");
    }
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? APP_ORIGIN);
    }
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantBillingRuntimeEnv,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeBillingRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    runtimeEnv,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    cookie: extractSessionCookiePair(res),
  };
}

interface ProvisionedTenantFixture {
  readonly tenantId: string;
  readonly handle: string;
  readonly orgId: string;
  readonly owner: { readonly userId: string; readonly cookie: string };
  readonly admin: { readonly userId: string; readonly cookie: string };
  readonly editor: { readonly userId: string; readonly cookie: string };
}

let tenantSeq = 1;

async function provisionTenantFixture(
  tag: string,
  runtimeEnv: TenantBillingRuntimeEnv,
  options: {
    readonly status?: "trial" | "active" | "grace" | "locked" | "suspended";
    readonly paidThroughMs?: number | null;
    readonly trialEndsAtMs?: number | null;
  } = {},
): Promise<ProvisionedTenantFixture> {
  const seq = String(tenantSeq++).padStart(4, "0");
  const tenantId = `01JTESTBILLING00000000${seq}`;
  const orgId = `01JTESTBILLORG00000000${seq}`;
  const handle = `bill-${tag}-${seq}`;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);

  const owner = await signUpUser(`owner-${tag}-${seq}@example.test`, `Owner ${tag}`, runtimeEnv);
  const admin = await signUpUser(`admin-${tag}-${seq}@example.test`, `Admin ${tag}`, runtimeEnv);
  const editor = await signUpUser(`editor-${tag}-${seq}@example.test`, `Editor ${tag}`, runtimeEnv);

  await db.insert(organizations).values({
    id: orgId,
    name: `Org ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(members).values([
    { id: `mem_owner_${seq}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
    { id: `mem_admin_${seq}`, organizationId: orgId, userId: admin.userId, role: "admin", createdAt: now },
    { id: `mem_editor_${seq}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
  ]);

  const paidThroughMs =
    options.paidThroughMs !== undefined
      ? options.paidThroughMs
      : options.status === "trial"
        ? null
        : BASE_NOW_MS + 10 * 24 * 60 * 60 * 1000;

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Tenant ${tag} ${seq}`,
    vertical: "compro",
    status: options.status ?? "active",
    paidThrough: paidThroughMs !== null ? new Date(paidThroughMs) : null,
    trialEndsAt: options.trialEndsAtMs ? new Date(options.trialEndsAtMs) : null,
    createdAt: now,
    updatedAt: now,
  });

  return { tenantId, handle, orgId, owner, admin, editor };
}

interface MockAutoLarisController {
  readonly fetchImpl: typeof fetch;
  readonly calls: { readonly method: string; readonly path: string; readonly body: unknown }[];
  submitCount: number;
  listCount: number;
}

function createSyntheticAutoLarisMock(
  handlers: {
    readonly onSubmit?: (
      body: Record<string, unknown>,
      callIndex: number,
    ) => Promise<Response> | Response;
    readonly channels?: readonly Record<string, unknown>[];
  } = {},
): MockAutoLarisController {
  const controller: MockAutoLarisController = {
    calls: [],
    submitCount: 0,
    listCount: 0,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const parsedBody =
        typeof init?.body === "string" && init.body.length > 0
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;

      expect(init?.headers).toBeDefined();
      const authHeader = new Headers(init?.headers).get("authorization");
      expect(authHeader).toBe(`Bearer ${TEST_AUTOLARIS_KEY}`);

      controller.calls.push({ method, path: url.pathname, body: parsedBody });

      if (url.pathname === "/api/h2h/list_payment" && method === "GET") {
        controller.listCount += 1;
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Sukses",
            data: handlers.channels ?? [
              { channel_code: "COD", name: "COD", admin: "0.0", tipe_admin: "fix" },
              { channel_code: "QRIS", name: "QRIS", admin: "0.7", tipe_admin: "persen" },
              { channel_code: "VAMANDIRI", name: "Bank Mandiri", admin: "3000.0", tipe_admin: "fix" },
              { channel_code: "VABCA", name: "Bank BCA", admin: "3500.0", tipe_admin: "fix" },
              { channel_code: "OVO", name: "OVO", admin: "3.0", tipe_admin: "persen" },
              { channel_code: "ALFAMART", name: "Alfamart", admin: "5000.0", tipe_admin: "fix" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/api/h2h/submit" && method === "POST") {
        controller.submitCount += 1;
        const idx = controller.submitCount;
        const body = parsedBody ?? {};

        if (handlers.onSubmit) {
          return handlers.onSubmit(body, idx);
        }

        const channelCode = String(body.channel_code ?? "QRIS");
        const grandTotal = Number(body.grand_total ?? 0);
        const isQris = channelCode.startsWith("QRIS");
        const adminFee = isQris ? Math.round((grandTotal * 7) / 1000) : 3000;
        const total = grandTotal + adminFee;

        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Success",
            data: {
              channel_code: channelCode,
              transaction_id: `ALTRX-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
              reff_id: body.reff_id,
              biaya_kirim: 0,
              biaya_cod: 0,
              biaya_admin: adminFee,
              biaya_asuransi: 0,
              diskon: 0,
              total,
              payment_info: {
                expired: "2026-02-01 10:00:00",
                va: isQris ? "" : "8870812345678901",
                qr: isQris ? "00020101021226600014ID.CO.QRIS.WWW6304EFGH" : "",
                url: "",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected AutoLaris endpoint called: ${method} ${url.pathname}`);
    },
  };

  return controller;
}

describe("TASK-055 workerd integration — subscription obligations & durable AutoLaris instructions", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyBillingObligationsMigration(env.PLATFORM_DB);
  });

  it("creates monthly QRIS & yearly VA obligations with immutable snapshots, exact IDR money, and redacted audit", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenantA = await provisionTenantFixture("happy-m", runtimeEnv, {
      status: "active",
      paidThroughMs: BASE_NOW_MS, // Jan 31, 2026 -> +1 month clamps to Feb 28, 2026!
    });
    const tenantB = await provisionTenantFixture("happy-y", runtimeEnv, {
      status: "active",
      paidThroughMs: BASE_NOW_MS, // Jan 31, 2026 -> +12 months -> Jan 31, 2027!
    });
    const mock = createSyntheticAutoLarisMock();

    // 1. GET /billing overview returns filtered QRIS/VA channels, pricing, and mandatory disclosures
    const overviewRes = await handleTenantBillingOverviewRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.headers.get("cache-control")).toBe("private, no-store");
    const overview = (await overviewRes.json()) as Record<string, unknown>;
    expect(overview.taxNotice).toBe(NON_PKP_TAX_NOTICE);
    expect(overview.noRefundNotice).toBe(NO_REFUND_NOTICE);
    const channels = overview.channels as { code: string; kind: string }[];
    expect(channels.map((c) => c.code)).toEqual(["QRIS", "VAMANDIRI", "VABCA"]);
    expect(channels.some((c) => c.code === "COD" || c.code === "OVO" || c.code === "ALFAMART")).toBe(false);

    // 1b. GET /billing/channels works independently
    const channelsRes = await handleTenantBillingChannelsRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/channels`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(channelsRes.status).toBe(200);

    // 2. POST /billing/obligations — Monthly QRIS (Rp 179.000 + Rp 1.253 fee = Rp 180.253)
    const keyMonthly = "550e8400-e29b-41d4-a716-446655440001";
    const createMonthlyRes = await handleTenantBillingObligationsRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: keyMonthly,
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(createMonthlyRes.status).toBe(201);
    expect(createMonthlyRes.headers.get("cache-control")).toBe("private, no-store");
    const monthlyData = (await createMonthlyRes.json()) as {
      obligation: Record<string, unknown>;
      snapshot: Record<string, unknown>;
      attempt: Record<string, unknown>;
      replayed: boolean;
    };
    expect(monthlyData.replayed).toBe(false);
    expect(monthlyData.obligation.plan).toBe("monthly");
    expect(monthlyData.obligation.baseAmountIdr).toBe(DEFAULT_MONTHLY_PRICE_IDR);
    expect(monthlyData.obligation.netAmountIdr).toBe(179_000);
    expect(monthlyData.obligation.periodStartAt).toBe("2026-01-31T10:00:00.000Z");
    expect(monthlyData.obligation.periodEndAt).toBe("2026-02-28T10:00:00.000Z"); // month-end clamp!
    expect(monthlyData.snapshot.nonPkp).toBe(true);
    expect(monthlyData.snapshot.noRefundPolicy).toBe(true);
    expect(monthlyData.attempt.channelKind).toBe("QRIS");
    expect(monthlyData.attempt.channelCode).toBe("QRIS");
    expect(monthlyData.attempt.channelFeeIdr).toBe(1_253);
    expect(monthlyData.attempt.totalPayableIdr).toBe(180_253);
    expect(monthlyData.attempt.state).toBe("pending");
    expect(monthlyData.attempt.qrisPayload).toBe("00020101021226600014ID.CO.QRIS.WWW6304EFGH");
    expect(monthlyData.attempt.vaNumber).toBeNull();
    expect(String(monthlyData.attempt.reffId).length).toBeLessThanOrEqual(30);

    // Verify AutoLaris submit payload invariants: courir_id: 1, cod_value: "0", no create_payment/shipping
    const submitCalls = mock.calls.filter((c) => c.path === "/api/h2h/submit");
    expect(submitCalls).toHaveLength(1);
    expect((submitCalls[0]?.body as Record<string, unknown>).courir_id).toBe(1);
    expect((submitCalls[0]?.body as Record<string, unknown>).cod_value).toBe("0");
    expect((submitCalls[0]?.body as Record<string, unknown>).grand_total).toBe("179000");
    expect(mock.calls.some((c) => c.path.includes("create_payment") || c.path.includes("ongkir") || c.path.includes("order"))).toBe(false);

    // Verify GET /obligations/:obligationId and GET /attempts/:attemptId return exact persisted records
    const obligationIdA = String(monthlyData.obligation.obligationId);
    const attemptIdA = String(monthlyData.attempt.attemptId);

    const detailRes = await handleTenantBillingObligationDetailRequest(
      tenantA.handle,
      obligationIdA,
      makeBillingRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations/${obligationIdA}`,
        "GET",
        { cookie: tenantA.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { obligation: Record<string, unknown>; attempt: Record<string, unknown> };
    expect(detailBody.obligation.obligationId).toBe(obligationIdA);
    expect(detailBody.attempt.attemptId).toBe(attemptIdA);

    const attemptDetailRes = await handleTenantBillingAttemptDetailRequest(
      tenantA.handle,
      attemptIdA,
      makeBillingRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/attempts/${attemptIdA}`,
        "GET",
        { cookie: tenantA.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(attemptDetailRes.status).toBe(200);

    // Verify platform_audit recorded creation WITHOUT leaking QRIS payload, VA number, or API key
    const auditRow = await env.PLATFORM_DB.prepare(
      "SELECT action, metadata_json FROM platform_audit WHERE target_id = ? LIMIT 1",
    )
      .bind(attemptIdA)
      .first<{ action: string; metadata_json: string | null }>();
    expect(auditRow?.action).toBe("billing.attempt.created");
    expect(auditRow?.metadata_json ?? "").not.toContain("000201010212");
    expect(auditRow?.metadata_json ?? "").not.toContain(TEST_AUTOLARIS_KEY);

    // 3. POST /billing/attempts — Yearly Bank VA (Rp 1.790.000 + Rp 3.000 = Rp 1.793.000)
    const keyYearly = "550e8400-e29b-41d4-a716-446655440002";
    const createYearlyRes = await handleTenantBillingAttemptsRequest(
      tenantB.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/billing/attempts`, "POST", {
        cookie: tenantB.owner.cookie,
        idempotencyKey: keyYearly,
        body: {
          plan: "yearly",
          channelKind: "VA",
          channelCode: "VAMANDIRI",
          idempotencyKey: keyYearly,
        },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(createYearlyRes.status).toBe(201);
    const yearlyAttempt = (await createYearlyRes.json()) as Record<string, unknown>;
    expect(yearlyAttempt.plan).toBe("yearly");
    expect(yearlyAttempt.baseAmountIdr).toBe(DEFAULT_YEARLY_PRICE_IDR);
    expect(yearlyAttempt.channelKind).toBe("VA");
    expect(yearlyAttempt.channelCode).toBe("VAMANDIRI");
    expect(yearlyAttempt.channelFeeIdr).toBe(3_000);
    expect(yearlyAttempt.totalPayableIdr).toBe(1_793_000);
    expect(yearlyAttempt.vaNumber).toBe("8870812345678901");
    expect(yearlyAttempt.bankName).toBe("Bank Mandiri");
  });

  it("replays identical Idempotency-Key safely, rejects mismatched payload with 409, and prevents duplicate charges under concurrency", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenant = await provisionTenantFixture("conc", runtimeEnv, { status: "active" });

    // Slow submit mock so concurrent requests genuinely overlap while first request is in-flight
    const mock = createSyntheticAutoLarisMock({
      onSubmit: async (body, idx) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Success",
            data: {
              channel_code: body.channel_code,
              transaction_id: `CONC-TRX-${idx}`,
              reff_id: body.reff_id,
              biaya_kirim: 0,
              biaya_cod: 0,
              biaya_admin: 1253,
              biaya_asuransi: 0,
              diskon: 0,
              total: 180253,
              payment_info: {
                expired: "2026-02-01 10:00:00",
                va: "",
                qr: "000201010212CONCURRENTQRIS63041111",
                url: "",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const key1 = "550e8400-e29b-41d4-a716-446655440010";
    const key2 = "550e8400-e29b-41d4-a716-446655440011";

    // Fire 3 concurrent creation requests (2 with same key1, 1 with distinct key2)
    const [r1, r2, r3] = await Promise.all([
      handleTenantBillingObligationsRequest(
        tenant.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/billing/obligations`, "POST", {
          cookie: tenant.owner.cookie,
          idempotencyKey: key1,
          body: { plan: "monthly", channelCode: "QRIS" },
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      ),
      handleTenantBillingObligationsRequest(
        tenant.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/billing/obligations`, "POST", {
          cookie: tenant.owner.cookie,
          idempotencyKey: key1,
          body: { plan: "monthly", channelCode: "QRIS" },
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      ),
      handleTenantBillingObligationsRequest(
        tenant.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/billing/obligations`, "POST", {
          cookie: tenant.owner.cookie,
          idempotencyKey: key2,
          body: { plan: "monthly", channelCode: "VAMANDIRI" },
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      ),
    ]);

    const statuses = [r1.status, r2.status, r3.status].sort();
    expect(statuses).toEqual([201, 409, 409]);
    // Hard invariant: AT MOST ONE provider `/submit` call occurred!
    expect(mock.submitCount).toBe(1);

    const attemptRows = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(tenant.tenantId)
      .first<{ cnt: number }>();
    expect(attemptRows?.cnt).toBe(1);

    // Find which key succeeded so we can test replay & mismatch on that exact key
    const winnerRes = [r1, r2, r3].find((r) => r.status === 201)!;
    const winnerBody = (await winnerRes.json()) as {
      obligation: { obligationId: string };
      attempt: { attemptId: string; reffId: string; channelCode: string };
    };
    const winningKey = winnerBody.attempt.channelCode === "QRIS" ? key1 : key2;
    const winningChannel = winnerBody.attempt.channelCode;

    // Replay same Idempotency-Key + same payload -> 200 with identical instruction, ZERO new submit calls
    const replayRes = await handleTenantBillingObligationsRequest(
      tenant.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: winningKey,
        body: { plan: "monthly", channelCode: winningChannel },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      replayed: boolean;
      attempt: { attemptId: string; reffId: string };
    };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.attempt.attemptId).toBe(winnerBody.attempt.attemptId);
    expect(replayBody.attempt.reffId).toBe(winnerBody.attempt.reffId);
    expect(mock.submitCount).toBe(1);

    // Same Idempotency-Key with DIFFERENT payload -> 409 IDEMPOTENCY_CONFLICT, ZERO side effects
    const mismatchRes = await handleTenantBillingObligationsRequest(
      tenant.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenant.handle}/billing/obligations`, "POST", {
        cookie: tenant.owner.cookie,
        idempotencyKey: winningKey,
        body: { plan: "yearly", channelCode: winningChannel },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(mismatchRes.status).toBe(409);
    const mismatchErr = (await mismatchRes.json()) as { error: { code: string } };
    expect(mismatchErr.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(mock.submitCount).toBe(1);
  });

  it("enters safe creation_unknown reconciliation state on timeout/crash before provider_transaction_id persistence and refuses blind duplicate creation", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Case A: Network timeout / AbortError during AutoLaris `/submit`
    const tenantTimeout = await provisionTenantFixture("timeout", runtimeEnv, { status: "active" });
    const timeoutMock = createSyntheticAutoLarisMock({
      onSubmit: () => {
        const abortErr = new Error("Request aborted due to timeout");
        abortErr.name = "AbortError";
        throw abortErr;
      },
    });

    const timeoutKey1 = "550e8400-e29b-41d4-a716-446655440020";
    const timeoutRes = await handleTenantBillingObligationsRequest(
      tenantTimeout.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantTimeout.handle}/billing/obligations`, "POST", {
        cookie: tenantTimeout.owner.cookie,
        idempotencyKey: timeoutKey1,
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: timeoutMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(timeoutRes.status).toBe(503);
    expect(timeoutMock.submitCount).toBe(1);

    const persistedTimeoutRow = await env.PLATFORM_DB.prepare(
      "SELECT lifecycle_state, provider_transaction_id, reff_id, safe_failure_code FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(tenantTimeout.tenantId)
      .first<{
        lifecycle_state: string;
        provider_transaction_id: string | null;
        reff_id: string;
        safe_failure_code: string | null;
      }>();
    expect(persistedTimeoutRow?.lifecycle_state).toBe("creation_unknown");
    expect(persistedTimeoutRow?.provider_transaction_id).toBeNull();
    expect(persistedTimeoutRow?.reff_id).toBeTruthy();
    expect(persistedTimeoutRow?.safe_failure_code).toBe("PROVIDER_TIMEOUT");

    // Blind retry with SAME key OR NEW key MUST be blocked (409) with ZERO second submit call!
    const retrySameKey = await handleTenantBillingObligationsRequest(
      tenantTimeout.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantTimeout.handle}/billing/obligations`, "POST", {
        cookie: tenantTimeout.owner.cookie,
        idempotencyKey: timeoutKey1,
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: timeoutMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(retrySameKey.status).toBe(409);
    expect(timeoutMock.submitCount).toBe(1);

    const retryNewKey = await handleTenantBillingObligationsRequest(
      tenantTimeout.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantTimeout.handle}/billing/obligations`, "POST", {
        cookie: tenantTimeout.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440021",
        body: { plan: "monthly", channelCode: "VAMANDIRI" },
      }),
      runtimeEnv,
      { autolarisFetch: timeoutMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(retryNewKey.status).toBe(409);
    expect(timeoutMock.submitCount).toBe(1);

    // Case B: Crash AFTER provider returned rc=00 BEFORE provider_transaction_id persistence
    const tenantCrash = await provisionTenantFixture("crash", runtimeEnv, { status: "active" });
    const crashMock = createSyntheticAutoLarisMock();
    const crashKey = "550e8400-e29b-41d4-a716-446655440022";

    const crashRes = await handleTenantBillingObligationsRequest(
      tenantCrash.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantCrash.handle}/billing/obligations`, "POST", {
        cookie: tenantCrash.owner.cookie,
        idempotencyKey: crashKey,
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      {
        autolarisFetch: crashMock.fetchImpl,
        nowMs: BASE_NOW_MS,
        onBeforePersistProviderResult: () => {
          throw new Error("Simulated worker crash before D1 transaction commit");
        },
      },
    );
    expect(crashRes.status).toBe(503);
    expect(crashMock.submitCount).toBe(1);

    const crashedRow = await env.PLATFORM_DB.prepare(
      "SELECT lifecycle_state, provider_transaction_id FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(tenantCrash.tenantId)
      .first<{ lifecycle_state: string; provider_transaction_id: string | null }>();
    expect(crashedRow?.lifecycle_state).toBe("creation_unknown");
    expect(crashedRow?.provider_transaction_id).toBeNull();

    // Retry after crash MUST refuse blind duplicate creation
    const retryAfterCrash = await handleTenantBillingObligationsRequest(
      tenantCrash.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantCrash.handle}/billing/obligations`, "POST", {
        cookie: tenantCrash.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440023",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: crashMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(retryAfterCrash.status).toBe(409);
    expect(crashMock.submitCount).toBe(1);
  });

  it("flags invalid provider fees/shipping costs to review without marking paid, and allows fresh retry after definite rc=07 refusal", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Case A: Provider returns rc="00" with unexpected shipping fee (biaya_kirim: 18400)
    const tenantBadFee = await provisionTenantFixture("badfee", runtimeEnv, { status: "active" });
    const badFeeMock = createSyntheticAutoLarisMock({
      onSubmit: (body) =>
        new Response(
          JSON.stringify({
            rc: "00",
            ket: "Success",
            data: {
              channel_code: body.channel_code,
              transaction_id: "BADFEE-TRX-9001",
              reff_id: body.reff_id,
              biaya_kirim: 18400, // Forbidden shipping fee!
              biaya_cod: 0,
              biaya_admin: 1253,
              biaya_asuransi: 0,
              diskon: 0,
              total: 198653,
              payment_info: {
                expired: "2026-02-01 10:00:00",
                va: "",
                qr: "000201010212BADFEE6304AAAA",
                url: "",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const badFeeRes = await handleTenantBillingObligationsRequest(
      tenantBadFee.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantBadFee.handle}/billing/obligations`, "POST", {
        cookie: tenantBadFee.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440030",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: badFeeMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(badFeeRes.status).toBe(503);

    const reviewAttempt = await env.PLATFORM_DB.prepare(
      "SELECT lifecycle_state, provider_transaction_id, safe_failure_code FROM payment_attempts WHERE tenant_id = ?",
    )
      .bind(tenantBadFee.tenantId)
      .first<{
        lifecycle_state: string;
        provider_transaction_id: string | null;
        safe_failure_code: string | null;
      }>();
    expect(reviewAttempt?.lifecycle_state).toBe("review");
    expect(reviewAttempt?.provider_transaction_id).toBe("BADFEE-TRX-9001");
    expect(reviewAttempt?.safe_failure_code).toBe("UNEXPECTED_SHIPPING_FEE");

    const settlementCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM settlements WHERE tenant_id = ?",
    )
      .bind(tenantBadFee.tenantId)
      .first<{ cnt: number }>();
    expect(settlementCount?.cnt).toBe(0);

    // Case B: Definite refusal (rc: "07") releases lock so owner can pick another active channel with a fresh key
    const tenantRefused = await provisionTenantFixture("refused", runtimeEnv, { status: "active" });
    let refuseFirst = true;
    const refusalMock = createSyntheticAutoLarisMock({
      onSubmit: (body) => {
        if (refuseFirst) {
          refuseFirst = false;
          return new Response(
            JSON.stringify({ rc: "07", ket: "Channel tidak aktif", data: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            rc: "00",
            ket: "Success",
            data: {
              channel_code: body.channel_code,
              transaction_id: "RECOVERED-TRX-777",
              reff_id: body.reff_id,
              biaya_kirim: 0,
              biaya_cod: 0,
              biaya_admin: 3000,
              biaya_asuransi: 0,
              diskon: 0,
              total: 182000,
              payment_info: {
                expired: "2026-02-01 10:00:00",
                va: "8870899999999999",
                qr: "",
                url: "",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const refusedRes = await handleTenantBillingObligationsRequest(
      tenantRefused.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantRefused.handle}/billing/obligations`, "POST", {
        cookie: tenantRefused.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440031",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: refusalMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(refusedRes.status).toBe(503);

    // Now retry with a fresh Idempotency-Key on VAMANDIRI -> succeeds!
    const recoveredRes = await handleTenantBillingObligationsRequest(
      tenantRefused.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantRefused.handle}/billing/obligations`, "POST", {
        cookie: tenantRefused.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440032",
        body: { plan: "monthly", channelCode: "VAMANDIRI" },
      }),
      runtimeEnv,
      { autolarisFetch: refusalMock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(recoveredRes.status).toBe(201);
  });

  it("enforces owner-only RBAC, cross-tenant 404 isolation, host/CSRF/forged-field guards, and locked/suspended owner recovery", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const tenantA = await provisionTenantFixture("sec-a", runtimeEnv, { status: "active" });
    const tenantB = await provisionTenantFixture("sec-b", runtimeEnv, { status: "active" });
    const mock = createSyntheticAutoLarisMock();

    // 1. Unauthenticated -> 401
    const unauthRes = await handleTenantBillingOverviewRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing`, "GET"),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(unauthRes.status).toBe(401);

    // 2. Wrong host (tenant subdomain & console host) -> neutral 404
    const wrongHostTenant = await handleTenantBillingOverviewRequest(
      tenantA.handle,
      makeBillingRequest(`https://${tenantA.handle}.situsku.click/api/tenants/${tenantA.handle}/billing`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(wrongHostTenant.status).toBe(404);

    const wrongHostConsole = await handleTenantBillingOverviewRequest(
      tenantA.handle,
      makeBillingRequest(`${CONSOLE_ORIGIN}/api/tenants/${tenantA.handle}/billing`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(wrongHostConsole.status).toBe(404);

    // 3. CSRF / Origin check on POST
    const badOriginRes = await handleTenantBillingObligationsRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
        cookie: tenantA.owner.cookie,
        origin: `https://${tenantA.handle}.situsku.click`,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440040",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 4. Non-owner members (admin & editor) -> 403 FORBIDDEN on both GET and POST
    for (const member of [tenantA.admin, tenantA.editor]) {
      const getDenied = await handleTenantBillingOverviewRequest(
        tenantA.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing`, "GET", {
          cookie: member.cookie,
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      );
      expect(getDenied.status).toBe(403);

      const postDenied = await handleTenantBillingObligationsRequest(
        tenantA.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
          cookie: member.cookie,
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440041",
          body: { plan: "monthly", channelCode: "QRIS" },
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      );
      expect(postDenied.status).toBe(403);
    }

    // 5. Cross-tenant access (Owner B -> Tenant A) -> neutral 404
    const crossGet = await handleTenantBillingOverviewRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(crossGet.status).toBe(404);

    const crossPost = await handleTenantBillingObligationsRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
        cookie: tenantB.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440042",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(crossPost.status).toBe(404);

    // 6. Disallowed channels (COD, OVO, ALFAMART) & forged fields (amount, price, tenantId, status, paid) -> 422, ZERO side effects
    for (const badBody of [
      { plan: "monthly", channelCode: "COD" },
      { plan: "monthly", channelCode: "OVO" },
      { plan: "monthly", channelCode: "ALFAMART" },
      { plan: "monthly", channelCode: "QRIS", amount: 1 },
      { plan: "monthly", channelCode: "QRIS", price: 100 },
      { plan: "monthly", channelCode: "QRIS", tenantId: tenantB.tenantId },
      { plan: "monthly", channelCode: "QRIS", status: "paid" },
      { plan: "monthly", channelCode: "QRIS", paid: true },
      { plan: "monthly", channelCode: "QRIS", unexpectedField: "nope" },
    ]) {
      const badRes = await handleTenantBillingObligationsRequest(
        tenantA.handle,
        makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440043",
          body: badBody,
        }),
        runtimeEnv,
        { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
      );
      expect(badRes.status, `Expected 422 for ${JSON.stringify(badBody)}`).toBe(422);
    }

    // Zero provider calls and zero obligations created across ALL denied/invalid requests above!
    expect(mock.submitCount).toBe(0);
    const tenantAOblCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM billing_obligations WHERE tenant_id = ?",
    )
      .bind(tenantA.tenantId)
      .first<{ cnt: number }>();
    expect(tenantAOblCount?.cnt).toBe(0);

    // Create one obligation on Tenant A, then verify Owner B cannot read it even via Tenant B's path
    const createdA = await handleTenantBillingObligationsRequest(
      tenantA.handle,
      makeBillingRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/billing/obligations`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440044",
        body: { plan: "monthly", channelCode: "QRIS" },
      }),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(createdA.status).toBe(201);
    const oblIdA = ((await createdA.json()) as { obligation: { obligationId: string } }).obligation
      .obligationId;

    const crossOblRead = await handleTenantBillingObligationDetailRequest(
      tenantB.handle,
      oblIdA,
      makeBillingRequest(
        `${APP_ORIGIN}/api/tenants/${tenantB.handle}/billing/obligations/${oblIdA}`,
        "GET",
        { cookie: tenantB.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(crossOblRead.status).toBe(404);

    // 7. Locked (H+5) and Suspended (H+10) owners MUST still be able to pay to unlock service!
    const lockedTenant = await provisionTenantFixture("locked", runtimeEnv, {
      status: "locked",
      paidThroughMs: BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000, // H+5 -> effective status `locked`
    });
    const suspendedTenant = await provisionTenantFixture("suspended", runtimeEnv, {
      status: "suspended",
      paidThroughMs: BASE_NOW_MS - 10 * 24 * 60 * 60 * 1000, // H+10 -> effective status `suspended`
    });

    const lockedPayRes = await handleTenantBillingObligationsRequest(
      lockedTenant.handle,
      makeBillingRequest(
        `${APP_ORIGIN}/api/tenants/${lockedTenant.handle}/billing/obligations`,
        "POST",
        {
          cookie: lockedTenant.owner.cookie,
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440045",
          body: { plan: "monthly", channelCode: "QRIS" },
        },
      ),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(lockedPayRes.status).toBe(201);

    const suspendedPayRes = await handleTenantBillingObligationsRequest(
      suspendedTenant.handle,
      makeBillingRequest(
        `${APP_ORIGIN}/api/tenants/${suspendedTenant.handle}/billing/obligations`,
        "POST",
        {
          cookie: suspendedTenant.owner.cookie,
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440046",
          body: { plan: "monthly", channelCode: "VAMANDIRI" },
        },
      ),
      runtimeEnv,
      { autolarisFetch: mock.fetchImpl, nowMs: BASE_NOW_MS },
    );
    expect(suspendedPayRes.status).toBe(201);
    const suspendedBody = (await suspendedPayRes.json()) as {
      snapshot: { renewalAnchor: string; periodStartAt: string };
    };
    // Suspended tenant starts fresh from settlement time
    expect(suspendedBody.snapshot.renewalAnchor).toBe("settlement_time");
    expect(suspendedBody.snapshot.periodStartAt).toBe(new Date(BASE_NOW_MS).toISOString());
  });
});
