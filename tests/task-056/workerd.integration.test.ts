import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  mergeCookieHeaders,
} from "@punyasitus/auth";
import {
  DAY_MS,
  DEFAULT_MONTHLY_PRICE_IDR,
  LOCKED_WINDOW_MS,
  TRIAL_DURATION_MS,
  createMockOnlyVerifiedSettlementPolicy,
} from "@punyasitus/core/billing/index";
import {
  beginDurablePaymentAttempt,
  completePaymentAttemptPending,
  ensureBillingReconciliationSchema,
  markPaymentAttemptUncertain,
  setOperatorManualHold,
  syncTenantStoredLifecycleState,
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
import {
  reconcilePaymentAttemptViaAdvice,
  runBillingAdviceReconciliationSweep,
} from "../../apps/web/src/worker/queues/billing/index.ts";
import {
  createAutoLarisClient,
  type AutoLarisBillingClient,
} from "../../packages/integrations/src/autolaris/index.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const TENANT_ORIGIN = "https://kopi-t056.situsku.click";
const RELAY_ORIGIN = "https://autolaris-relay.punyasitus.com";
const TEST_AUTOLARIS_KEY = "al_test_t056_secret_key_never_logged_9988776655";
const TEST_APP_SECRET = "task056-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task056-console-auth-secret-fedcba9876543210fedcba987654";
const BASE_NOW_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // 2026-01-31T10:00:00Z
const MOCK_POLICY = createMockOnlyVerifiedSettlementPolicy();
const SECRET_QRIS = "00020101021226680016ID.CO.QRIS.WWW01189360091431234567896304DEAD";
const SECRET_VA = "8779611150009999";

function buildConsoleEnv(extra?: Partial<ConsoleBillingRuntimeEnv>): ConsoleBillingRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    AUTOLARIS_RELAY_URL: RELAY_ORIGIN,
    AUTOLARIS_API_KEY: TEST_AUTOLARIS_KEY,
    AUTOLARIS_ACCOUNT_ID: "acct-t056",
    ...extra,
  };
}

function createConsoleAuth() {
  return createAuth(env.PLATFORM_DB, {
    baseURL: CONSOLE_ORIGIN,
    secret: TEST_CONSOLE_SECRET,
    surface: "console",
    trustedOrigins: [CONSOLE_ORIGIN],
  });
}

async function resetTables(): Promise<void> {
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

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

async function seedTenantWithPendingAttempt(options: {
  readonly status?: TenantStatus;
  readonly operatorHold?: boolean;
  readonly paidThroughMs?: number | null;
  readonly trialEndsAtMs?: number | null;
  readonly providerTransactionId?: string | null;
  readonly makeCreationUnknown?: boolean;
  readonly channelKind?: "QRIS" | "VA";
  readonly channelFeeIdr?: number;
  readonly nowMs?: number;
} = {}): Promise<{
  readonly tenantId: string;
  readonly handle: string;
  readonly obligationId: string;
  readonly attemptId: string;
  readonly reffId: string;
  readonly providerTransactionId: string | null;
  readonly totalPayableIdr: number;
}> {
  const n = nextSeq();
  const nowMs = options.nowMs ?? BASE_NOW_MS;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const orgId = `org_t056_${n}`;
  const tenantId = `ten_t056_${n}`;
  const handle = `toko-t056-${n}`;
  const ownerId = `usr_owner_t056_${n}`;
  const status = options.status ?? "trial";
  const trialEndsAt =
    options.trialEndsAtMs !== undefined
      ? options.trialEndsAtMs
      : status === "trial"
        ? nowMs + TRIAL_DURATION_MS
        : null;
  const paidThrough = options.paidThroughMs !== undefined ? options.paidThroughMs : null;

  await env.PLATFORM_DB.prepare(
    `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(ownerId, `Owner ${n}`, `owner${n}@example.com`, nowMs, nowMs)
    .run();

  await db.insert(organizations).values({
    id: orgId,
    name: `Toko T056 ${n}`,
    slug: handle,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  await db.insert(members).values({
    id: `mem_t056_${n}`,
    organizationId: orgId,
    userId: ownerId,
    role: "owner",
    createdAt: new Date(nowMs),
  });

  const deletionDueAtMs =
    paidThrough !== null
      ? paidThrough + 45 * DAY_MS
      : trialEndsAt !== null
        ? trialEndsAt + 30 * DAY_MS
        : null;

  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Toko T056 ${n}`,
    vertical: "compro",
    status,
    operatorHold: Boolean(options.operatorHold),
    operatorHoldReason: options.operatorHold ? "Compliance review hold" : null,
    trialEndsAt: trialEndsAt !== null ? new Date(trialEndsAt) : null,
    paidThrough: paidThrough !== null ? new Date(paidThrough) : null,
    deletionDueAt: deletionDueAtMs !== null ? new Date(deletionDueAtMs) : null,
    retentionPausedAt: options.operatorHold ? new Date(nowMs) : null,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  const channelKind = options.channelKind ?? "VA";
  const channelCode = channelKind === "QRIS" ? "QRIS" : "VAMANDIRI";
  const feeIdr = options.channelFeeIdr ?? (channelKind === "QRIS" ? 1_253 : 3_000);
  const totalPayableIdr = DEFAULT_MONTHLY_PRICE_IDR + feeIdr;

  const begun = await beginDurablePaymentAttempt(env.PLATFORM_DB, {
    tenantId,
    effectiveTenantStatus: status,
    payerType: "tenant",
    payerAgencyId: null,
    plan: "monthly",
    channelKind,
    channelCode,
    estimatedChannelFeeIdr: feeIdr,
    idempotencyKey: crypto.randomUUID(),
    requestHash: `hash_${n}`,
    providerAccountId: "acct-t056",
    nowMs,
  });

  if (options.makeCreationUnknown) {
    await markPaymentAttemptUncertain(env.PLATFORM_DB, {
      attemptId: begun.attempt.id,
      obligationId: begun.obligation.id,
      tenantId,
      actorUserId: ownerId,
      actorRole: "owner",
      requestId: `req_unc_${n}`,
      safeFailureCode: "PROVIDER_TIMEOUT",
      nowMs,
    });
    return {
      tenantId,
      handle,
      obligationId: begun.obligation.id,
      attemptId: begun.attempt.id,
      reffId: begun.attempt.reffId,
      providerTransactionId: null,
      totalPayableIdr,
    };
  }

  const providerTransactionId =
    options.providerTransactionId !== undefined
      ? options.providerTransactionId
      : `TRX_T056_${n}`;

  if (providerTransactionId === null) {
    return {
      tenantId,
      handle,
      obligationId: begun.obligation.id,
      attemptId: begun.attempt.id,
      reffId: begun.attempt.reffId,
      providerTransactionId: null,
      totalPayableIdr,
    };
  }

  await completePaymentAttemptPending(env.PLATFORM_DB, {
    attemptId: begun.attempt.id,
    obligationId: begun.obligation.id,
    tenantId,
    actorUserId: ownerId,
    actorRole: "owner",
    requestId: `req_pend_${n}`,
    providerTransactionId,
    channelFeeIdr: feeIdr,
    grossAdminFeeIdr: feeIdr,
    providerDiscountIdr: 0,
    totalPayableIdr,
    qrisPayload: channelKind === "QRIS" ? SECRET_QRIS : null,
    vaNumber: channelKind === "VA" ? SECRET_VA : null,
    bankName: channelKind === "VA" ? "Bank Mandiri" : null,
    paymentRedirectUrl: "https://pay.autolaris.com/secret-session-link",
    expiresAtMs: nowMs + 24 * 60 * 60 * 1000,
    nowMs,
  });

  return {
    tenantId,
    handle,
    obligationId: begun.obligation.id,
    attemptId: begun.attempt.id,
    reffId: begun.attempt.reffId,
    providerTransactionId,
    totalPayableIdr,
  };
}

function makeMockAdviceClient(
  handler: (transactionId: string, request: { url: string; method: string }) => Response | Promise<Response>,
): { readonly client: AutoLarisBillingClient; readonly seenTransactionIds: string[] } {
  const seenTransactionIds: string[] = [];
  const client = createAutoLarisClient({
    relayBaseUrl: RELAY_ORIGIN,
    apiKey: TEST_AUTOLARIS_KEY,
    providerAccountId: "acct-t056",
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { transaction_id?: string }) : {};
      const trxId = body.transaction_id ?? "";
      seenTransactionIds.push(trxId);
      return handler(trxId, { url, method: init?.method ?? "GET" });
    },
  });
  return { client, seenTransactionIds };
}

function jsonResp(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TASK-056 workerd integration — Advice Reconciliation, Exactly-Once Grants & Console Billing", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureBillingReconciliationSchema(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    // Ensure any audit failure trigger from a previous test is cleaned up
    await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS test_fail_platform_audit_insert").run();
    await resetTables();
  });

  it("blocks settlement grants under default UNVERIFIED production policy and routes to review", async () => {
    const seeded = await seedTenantWithPendingAttempt({ status: "trial" });
    const { client, seenTransactionIds } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Settlement confirmed",
        data: {
          transaction_id: trxId,
          reff_id: seeded.reffId,
          payment_status: "PAID_SETTLED",
          total: seeded.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    // No settlementPolicy passed -> defaults to DEFAULT_PRODUCTION_SETTLEMENT_POLICY (UNVERIFIED)
    const result = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: client,
      attemptId: seeded.attemptId,
      nowMs: BASE_NOW_MS + 60_000,
    });

    expect(seenTransactionIds).toEqual([seeded.providerTransactionId]);
    expect(result.outcome).toBe("review");
    expect(result.reasonCode).toBe("REAL_PROVIDER_SETTLEMENT_MAPPING_UNVERIFIED");
    expect(result.grantApplied).toBe(false);

    const settlementCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM settlements WHERE obligation_id = ?",
    )
      .bind(seeded.obligationId)
      .first<{ cnt: number }>();
    const grantCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE tenant_id = ?",
    )
      .bind(seeded.tenantId)
      .first<{ cnt: number }>();
    const tenantRow = await env.PLATFORM_DB.prepare("SELECT status, paid_through FROM tenants WHERE id = ?")
      .bind(seeded.tenantId)
      .first<{ status: string; paid_through: number | null }>();

    expect(settlementCount?.cnt).toBe(0);
    expect(grantCount?.cnt).toBe(0);
    expect(tenantRow?.status).toBe("trial");
    expect(tenantRow?.paid_through).toBeNull();
  });

  it("grants exactly once under mock_only_verified_policy and handles duplicate, late, out-of-order & expiry-sweep races", async () => {
    // 1. Confirmed settlement + concurrent duplicate Advice calls -> strictly 1 settlement & 1 grant
    const seeded = await seedTenantWithPendingAttempt({
      status: "active",
      paidThroughMs: BASE_NOW_MS,
      nowMs: BASE_NOW_MS - DAY_MS,
    });

    const { client, seenTransactionIds } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Confirmed",
        data: {
          transaction_id: trxId,
          reff_id: seeded.reffId,
          payment_status: "PAID_SETTLED",
          total: seeded.totalPayableIdr,
          currency: "IDR",
          settled_at: BASE_NOW_MS,
        },
      }),
    );

    const concurrent = await Promise.all([
      reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: client,
        attemptId: seeded.attemptId,
        settlementPolicy: MOCK_POLICY,
        nowMs: BASE_NOW_MS,
      }),
      reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: client,
        attemptId: seeded.attemptId,
        settlementPolicy: MOCK_POLICY,
        nowMs: BASE_NOW_MS,
      }),
      reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: client,
        attemptId: seeded.attemptId,
        settlementPolicy: MOCK_POLICY,
        nowMs: BASE_NOW_MS,
      }),
    ]);

    expect(seenTransactionIds.every((id) => id === seeded.providerTransactionId)).toBe(true);
    expect(concurrent.filter((r) => r.grantApplied)).toHaveLength(1);
    expect(concurrent.filter((r) => r.outcome === "already_settled")).toHaveLength(2);

    const grants = await env.PLATFORM_DB.prepare(
      "SELECT id, period_start, period_end FROM entitlement_grants WHERE tenant_id = ?",
    )
      .bind(seeded.tenantId)
      .all<{ id: string; period_start: number; period_end: number }>();
    expect(grants.results).toHaveLength(1);
    // Jan 31 + 1 calendar month = Feb 28 (month-end clamp!)
    expect(new Date(grants.results![0]!.period_end).toISOString()).toBe("2026-02-28T10:00:00.000Z");

    // 2. Out-of-order late PENDING / EXPIRED / FAILED after paid MUST NEVER downgrade!
    const { client: lateFailClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Expired",
        data: { transaction_id: trxId, payment_status: "EXPIRED" },
      }),
    );
    const lateRes = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: lateFailClient,
      attemptId: seeded.attemptId,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS + 10_000,
    });
    expect(lateRes.outcome).toBe("already_settled");
    expect(lateRes.providerCalled).toBe(false);

    const attemptAfterLate = await env.PLATFORM_DB.prepare(
      "SELECT lifecycle_state FROM payment_attempts WHERE id = ?",
    )
      .bind(seeded.attemptId)
      .first<{ lifecycle_state: string }>();
    expect(attemptAfterLate?.lifecycle_state).toBe("paid");

    // 3. Late settlement of an earlier expired attempt on an ALREADY-PAID obligation -> review, 0 second grants!
    const oldAttemptId = `pa_old_expired_${nextSeq()}`;
    await env.PLATFORM_DB.prepare(
      `INSERT INTO payment_attempts (
         id, obligation_id, tenant_id, channel, provider, provider_account_id,
         provider_transaction_id, reff_id, channel_code, amount_idr, state, lifecycle_state,
         base_amount_idr, discount_amount_idr, channel_fee_idr, total_payable_idr,
         version, created_at, updated_at
       ) VALUES (?, ?, ?, 'VA', 'autolaris', 'acct-t056', 'TRX_OLD_EXPIRED', 'PSOLDREF01', 'VAMANDIRI', ?, 'expired', 'expired', ?, 0, 3000, ?, 1, ?, ?)`,
    )
      .bind(
        oldAttemptId,
        seeded.obligationId,
        seeded.tenantId,
        seeded.totalPayableIdr,
        DEFAULT_MONTHLY_PRICE_IDR,
        seeded.totalPayableIdr,
        BASE_NOW_MS - 3600_000,
        BASE_NOW_MS - 1800_000,
      )
      .run();

    const { client: latePaidClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Paid late",
        data: {
          transaction_id: trxId,
          reff_id: "PSOLDREF01",
          payment_status: "PAID_SETTLED",
          total: seeded.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    const lateDup = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: latePaidClient,
      attemptId: oldAttemptId,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS + 20_000,
    });
    expect(lateDup.outcome).toBe("review");
    expect(lateDup.reasonCode).toBe("LATE_DUPLICATE_SETTLEMENT");
    expect(lateDup.grantApplied).toBe(false);

    const totalGrantsAfterLateDup = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE tenant_id = ?",
    )
      .bind(seeded.tenantId)
      .first<{ cnt: number }>();
    expect(totalGrantsAfterLateDup?.cnt).toBe(1);

    // 4. Concurrent expiry-sweep (`syncTenantStoredLifecycleState`) vs Advice settlement race -> 1 grant, tenant active!
    const raceSeed = await seedTenantWithPendingAttempt({
      status: "locked",
      paidThroughMs: BASE_NOW_MS - LOCKED_WINDOW_MS - 1_000, // just crossed H+8 -> sweep wants to suspend!
      nowMs: BASE_NOW_MS - 10_000,
    });
    const { client: raceClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Confirmed",
        data: {
          transaction_id: trxId,
          reff_id: raceSeed.reffId,
          payment_status: "PAID_SETTLED",
          total: raceSeed.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    const [, raceAdvice] = await Promise.all([
      syncTenantStoredLifecycleState(env.PLATFORM_DB, {
        tenantId: raceSeed.tenantId,
        nowMs: BASE_NOW_MS,
      }),
      reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: raceClient,
        attemptId: raceSeed.attemptId,
        settlementPolicy: MOCK_POLICY,
        nowMs: BASE_NOW_MS,
      }),
    ]);

    expect(raceAdvice.outcome).toBe("settled");
    expect(raceAdvice.grantApplied).toBe(true);
    const racedTenant = await env.PLATFORM_DB.prepare(
      "SELECT status, paid_through FROM tenants WHERE id = ?",
    )
      .bind(raceSeed.tenantId)
      .first<{ status: string; paid_through: number }>();
    expect(racedTenant?.status).toBe("active");
    expect(racedTenant?.paid_through).toBeGreaterThan(BASE_NOW_MS);
  });

  it("routes generic rc=00/SUCCESS/DELIVERED, unknown IDs, missing/mismatched amounts, network failures, and provider-ID-less creation_unknown to safe review with 0 grants", async () => {
    const scenarios: readonly {
      readonly name: string;
      readonly makeCreationUnknown?: boolean;
      readonly respond: (trxId: string, reffId: string, total: number) => Response | Promise<Response>;
      readonly expectedCalled: boolean;
      readonly expectedReasonCode: string;
    }[] = [
      {
        name: "generic rc=00 + SUCCESS",
        respond: (trxId, reffId, total) =>
          jsonResp({
            rc: "00",
            ket: "SUCCESS",
            data: { transaction_id: trxId, reff_id: reffId, status: "SUCCESS", total, currency: "IDR" },
          }),
        expectedCalled: true,
        expectedReasonCode: "GENERIC_STATUS_NOT_PAYMENT_PROOF",
      },
      {
        name: "shipping DELIVERED status",
        respond: (trxId, reffId, total) =>
          jsonResp({
            rc: "00",
            ket: "Success",
            data: { transaction_id: trxId, reff_id: reffId, stats: "DELIVERED", total, currency: "IDR" },
          }),
        expectedCalled: true,
        expectedReasonCode: "SHIPPING_STATUS_NOT_PAYMENT_PROOF",
      },
      {
        name: "unknown/mismatched provider transaction_id",
        respond: (_trxId, reffId, total) =>
          jsonResp({
            rc: "00",
            ket: "Confirmed",
            data: {
              transaction_id: "TRX_FOREIGN_999",
              reff_id: reffId,
              payment_status: "PAID_SETTLED",
              total,
              currency: "IDR",
            },
          }),
        expectedCalled: true,
        expectedReasonCode: "ADVICE_TRANSACTION_ID_MISMATCH",
      },
      {
        name: "missing amount evidence",
        respond: (trxId, reffId) =>
          jsonResp({
            rc: "00",
            ket: "Confirmed",
            data: {
              transaction_id: trxId,
              reff_id: reffId,
              payment_status: "PAID_SETTLED",
              currency: "IDR",
            },
          }),
        expectedCalled: true,
        expectedReasonCode: "ADVICE_AMOUNT_EVIDENCE_MISSING",
      },
      {
        name: "mismatched amount evidence",
        respond: (trxId, reffId, total) =>
          jsonResp({
            rc: "00",
            ket: "Confirmed",
            data: {
              transaction_id: trxId,
              reff_id: reffId,
              payment_status: "PAID_SETTLED",
              total: total - 1_000,
              currency: "IDR",
            },
          }),
        expectedCalled: true,
        expectedReasonCode: "ADVICE_AMOUNT_MISMATCH",
      },
      {
        name: "network failure",
        respond: () => Promise.reject(new TypeError("network socket hang up")),
        expectedCalled: true,
        expectedReasonCode: "PROVIDER_NETWORK_ERROR",
      },
      {
        name: "provider-ID-less creation_unknown (never calls Advice)",
        makeCreationUnknown: true,
        respond: () => jsonResp({ rc: "00" }),
        expectedCalled: false,
        expectedReasonCode: "MISSING_PROVIDER_TRANSACTION_ID",
      },
    ];

    for (const sc of scenarios) {
      const seeded = await seedTenantWithPendingAttempt({
        status: "trial",
        makeCreationUnknown: sc.makeCreationUnknown,
      });
      const { client, seenTransactionIds } = makeMockAdviceClient((trxId) =>
        sc.respond(trxId, seeded.reffId, seeded.totalPayableIdr),
      );

      const res = await reconcilePaymentAttemptViaAdvice({
        db: env.PLATFORM_DB,
        autolarisClient: client,
        attemptId: seeded.attemptId,
        settlementPolicy: MOCK_POLICY,
        nowMs: BASE_NOW_MS + 10_000,
      });

      expect(res.outcome, sc.name).toBe("review");
      expect(res.reasonCode, sc.name).toBe(sc.expectedReasonCode);
      expect(res.grantApplied, sc.name).toBe(false);
      expect(res.providerCalled, sc.name).toBe(sc.expectedCalled);
      expect(seenTransactionIds.length, sc.name).toBe(sc.expectedCalled ? 1 : 0);

      const grantCnt = await env.PLATFORM_DB.prepare(
        "SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE tenant_id = ?",
      )
        .bind(seeded.tenantId)
        .first<{ cnt: number }>();
      expect(grantCnt?.cnt, sc.name).toBe(0);

      const attemptRow = await env.PLATFORM_DB.prepare(
        "SELECT lifecycle_state FROM payment_attempts WHERE id = ?",
      )
        .bind(seeded.attemptId)
        .first<{ lifecycle_state: string }>();
      expect(attemptRow?.lifecycle_state, sc.name).toBe("review");
    }
  });

  it("preserves manual operator hold across confirmed payment and never resurrects terminal tenants", async () => {
    // 1. Operator hold survives confirmed payment
    const held = await seedTenantWithPendingAttempt({
      status: "suspended",
      operatorHold: false,
      paidThroughMs: BASE_NOW_MS - 10 * DAY_MS,
    });
    await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId: held.tenantId,
      hold: true,
      reason: "Abuse review manual suspension",
      operatorUserId: "op_user_1",
      nowMs: BASE_NOW_MS - 1_000,
    });

    const beforeHoldRow = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold, deletion_due_at FROM tenants WHERE id = ?",
    )
      .bind(held.tenantId)
      .first<{ status: string; operator_hold: number; deletion_due_at: number | null }>();
    expect(beforeHoldRow?.operator_hold).toBe(1);

    const { client: heldClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Confirmed",
        data: {
          transaction_id: trxId,
          reff_id: held.reffId,
          payment_status: "PAID_SETTLED",
          total: held.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    const heldRes = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: heldClient,
      attemptId: held.attemptId,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS,
    });

    expect(heldRes.outcome).toBe("settled");
    expect(heldRes.grantApplied).toBe(true);
    expect(heldRes.operatorHoldPreserved).toBe(true);

    const afterHoldRow = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold, paid_through, deletion_due_at FROM tenants WHERE id = ?",
    )
      .bind(held.tenantId)
      .first<{
        status: string;
        operator_hold: number;
        paid_through: number;
        deletion_due_at: number | null;
      }>();
    expect(afterHoldRow?.status).toBe("suspended");
    expect(afterHoldRow?.operator_hold).toBe(1);
    expect(afterHoldRow?.paid_through).toBeGreaterThan(BASE_NOW_MS);
    expect(afterHoldRow?.deletion_due_at).toBe(beforeHoldRow?.deletion_due_at);

    // 2. Terminal state (`purging` / `purged`) is NEVER resurrected
    const purging = await seedTenantWithPendingAttempt({ status: "purging" });
    const { client: purgingClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Confirmed",
        data: {
          transaction_id: trxId,
          reff_id: purging.reffId,
          payment_status: "PAID_SETTLED",
          total: purging.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    const purgingRes = await reconcilePaymentAttemptViaAdvice({
      db: env.PLATFORM_DB,
      autolarisClient: purgingClient,
      attemptId: purging.attemptId,
      settlementPolicy: MOCK_POLICY,
      nowMs: BASE_NOW_MS,
    });
    expect(purgingRes.outcome).toBe("review");
    expect(purgingRes.deferredTerminalState).toBe(true);
    expect(purgingRes.grantApplied).toBe(false);

    const purgingTenant = await env.PLATFORM_DB.prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(purging.tenantId)
      .first<{ status: string }>();
    expect(purgingTenant?.status).toBe("purging");
  });

  it("enforces bounded leases, batch caps, poll ceilings, per-attempt isolation, and log redaction", async () => {
    const a1 = await seedTenantWithPendingAttempt({ status: "trial", channelKind: "QRIS" });
    const a2 = await seedTenantWithPendingAttempt({ status: "trial", channelKind: "VA" });
    const a3 = await seedTenantWithPendingAttempt({ status: "trial", channelKind: "VA" });

    const capturedLogs: Record<string, unknown>[] = [];
    const callCounts = new Map<string, number>();

    const { client } = makeMockAdviceClient((trxId) => {
      callCounts.set(trxId, (callCounts.get(trxId) ?? 0) + 1);
      if (trxId === a1.providerTransactionId) {
        return Promise.reject(new Error(`Network error Authorization: Bearer ${TEST_AUTOLARIS_KEY}`));
      }
      if (trxId === a2.providerTransactionId) {
        return jsonResp({
          rc: "00",
          ket: "Confirmed",
          data: {
            transaction_id: trxId,
            reff_id: a2.reffId,
            payment_status: "PAID_SETTLED",
            total: a2.totalPayableIdr,
            currency: "IDR",
          },
        });
      }
      return jsonResp({ rc: "02", ket: "PENDING", data: { awb: "" } });
    });

    // Run TWO concurrent sweeps with batchLimit = 2 -> a1 (network fail -> review) and a2 (settled)
    // are claimed cleanly without double-processing, while a3 is left for the next tick (or claimed by worker 2)
    const [s1, s2] = await Promise.all([
      runBillingAdviceReconciliationSweep(
        { PLATFORM_DB: env.PLATFORM_DB },
        {
          autolarisClient: client,
          settlementPolicy: MOCK_POLICY,
          workerId: "worker-A",
          nowMs: BASE_NOW_MS,
          batchLimit: 2,
          leaseDurationMs: 60_000,
          maxPolls: 2,
          logger: (entry) => capturedLogs.push(entry),
        },
      ),
      runBillingAdviceReconciliationSweep(
        { PLATFORM_DB: env.PLATFORM_DB },
        {
          autolarisClient: client,
          settlementPolicy: MOCK_POLICY,
          workerId: "worker-B",
          nowMs: BASE_NOW_MS,
          batchLimit: 2,
          leaseDurationMs: 60_000,
          maxPolls: 2,
          logger: (entry) => capturedLogs.push(entry),
        },
      ),
    ]);

    // Every attempt was polled at most ONCE across concurrent sweeps!
    expect(s1.leasedCount + s2.leasedCount).toBe(3);
    expect(callCounts.get(a1.providerTransactionId!)).toBe(1);
    expect(callCounts.get(a2.providerTransactionId!)).toBe(1);
    expect(callCounts.get(a3.providerTransactionId!)).toBe(1);
    expect(s1.settledCount + s2.settledCount).toBe(1);
    expect(s1.reviewCount + s2.reviewCount).toBe(1);
    expect(s1.pendingCount + s2.pendingCount).toBe(1);

    // Leases are cleanly released after sweep finishes
    const activeLeases = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM billing_reconciliation_leases WHERE lease_expires_at IS NOT NULL",
    ).first<{ cnt: number }>();
    expect(activeLeases?.cnt).toBe(0);

    // Poll ceiling: advance past backoff for a3 -> poll #2 hits maxPolls=2 -> escalates to review!
    const s3 = await runBillingAdviceReconciliationSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      {
        autolarisClient: client,
        settlementPolicy: MOCK_POLICY,
        workerId: "worker-C",
        nowMs: BASE_NOW_MS + 120_000,
        batchLimit: 10,
        maxPolls: 2,
        logger: (entry) => capturedLogs.push(entry),
      },
    );
    expect(s3.leasedCount).toBe(1);
    expect(s3.reviewCount).toBe(1);
    expect(s3.outcomes[0]?.reasonCode).toBe("ADVICE_MAX_POLLS_EXHAUSTED");

    // Zero secrets, QRIS payloads, VA numbers, or emails in any structured log!
    const serializedLogs = JSON.stringify(capturedLogs);
    expect(serializedLogs).not.toContain(TEST_AUTOLARIS_KEY);
    expect(serializedLogs).not.toContain(SECRET_QRIS);
    expect(serializedLogs).not.toContain(SECRET_VA);
    expect(serializedLogs).not.toContain("@example.com");
  });

  it("enforces console operator auth, 2FA step-up, CSRF, redaction, zero paid toggle, and audit-failure rollback", async () => {
    const runtimeEnv = buildConsoleEnv();
    const auth = createConsoleAuth();
    const nowMs = BASE_NOW_MS;

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth,
      email: "billing-op@example.com",
      password: "OperatorPassword!234",
      name: "Billing Superadmin",
      nowMs,
    });

    // Non-operator user on console
    const nonOpSignUp = await auth.api.signUpEmail({
      body: { email: "regular@example.com", password: "RegularPassword!234", name: "Regular User" },
      asResponse: true,
    });
    const nonOpCookie = mergeCookieHeaders(null, nonOpSignUp.headers);

    const seeded = await seedTenantWithPendingAttempt({ status: "trial", channelKind: "QRIS", nowMs });
    const { client: mockClient } = makeMockAdviceClient((trxId) =>
      jsonResp({
        rc: "00",
        ket: "Confirmed",
        data: {
          transaction_id: trxId,
          reff_id: seeded.reffId,
          payment_status: "PAID_SETTLED",
          total: seeded.totalPayableIdr,
          currency: "IDR",
        },
      }),
    );

    // 1. Host isolation -> 404 on non-console hosts
    for (const wrongOrigin of [APP_ORIGIN, TENANT_ORIGIN]) {
      const res = await handleConsoleBillingListRequest(
        new Request(`${wrongOrigin}/api/console/billing`, { headers: { cookie: op.cookieHeader } }),
        runtimeEnv,
        { nowMs },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }

    // 2. Non-operator -> 403
    const nonOpRes = await handleConsoleBillingListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing`, { headers: { cookie: nonOpCookie } }),
      runtimeEnv,
      { nowMs },
    );
    expect(nonOpRes.status).toBe(403);

    // 3. GET /api/console/billing -> redacted metadata ONLY (no QRIS, VA, redirect URL, or API key!)
    const listRes = await handleConsoleBillingListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing`, { headers: { cookie: op.cookieHeader } }),
      runtimeEnv,
      { nowMs },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("Cache-Control")).toBe("private, no-store");
    const listText = await listRes.text();
    expect(listText).not.toContain(SECRET_QRIS);
    expect(listText).not.toContain(SECRET_VA);
    expect(listText).not.toContain(TEST_AUTOLARIS_KEY);
    expect(listText).not.toContain("secret-session-link");
    expect(listText).not.toContain("owner1@example.com");
    const listBody = JSON.parse(listText) as {
      settlementPolicy: { realProviderMappingStatus: string; liveSettlementEnabled: boolean };
      obligations: { obligationId: string; latestAttempt: { providerTransactionId: string } }[];
    };
    expect(listBody.settlementPolicy.realProviderMappingStatus).toBe("UNVERIFIED");
    expect(listBody.settlementPolicy.liveSettlementEnabled).toBe(false);
    expect(listBody.obligations).toHaveLength(1);
    expect(listBody.obligations[0]?.latestAttempt.providerTransactionId).toBe(
      seeded.providerTransactionId,
    );

    // 4. CSRF check on POST /recheck
    const csrfFail = await handleConsoleBillingRecheckRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          attemptId: seeded.attemptId,
          reason: "Operator manual advice recheck for ticket INC-100",
        }),
      }),
      runtimeEnv,
      { nowMs, autolarisClient: mockClient, settlementPolicy: MOCK_POLICY },
    );
    expect(csrfFail.status).toBe(403);

    // 5. Stale 2FA step-up (> 10 minutes) -> 403 REAUTH_REQUIRED
    const staleRes = await handleConsoleBillingRecheckRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          attemptId: seeded.attemptId,
          reason: "Operator manual advice recheck for ticket INC-101",
        }),
      }),
      runtimeEnv,
      {
        nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000,
        autolarisClient: mockClient,
        settlementPolicy: MOCK_POLICY,
      },
    );
    expect(staleRes.status).toBe(403);
    const staleJson = (await staleRes.json()) as { code: string };
    expect(staleJson.code).toBe("REAUTH_REQUIRED");

    // 6. Zero arbitrary "mark paid" toggle: unknown/forbidden fields rejected with 422 UNKNOWN_FIELD
    for (const badBody of [
      { attemptId: seeded.attemptId, markPaid: true, reason: "Attempt arbitrary mark paid override" },
      { attemptId: seeded.attemptId, status: "paid", reason: "Attempt direct status override" },
    ]) {
      const badRes = await handleConsoleBillingRecheckRequest(
        new Request(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, {
          method: "POST",
          headers: {
            cookie: op.cookieHeader,
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
          },
          body: JSON.stringify(badBody),
        }),
        runtimeEnv,
        { nowMs, autolarisClient: mockClient, settlementPolicy: MOCK_POLICY },
      );
      expect(badRes.status).toBe(422);
      const errBody = (await badRes.json()) as { code: string };
      expect(errBody.code).toBe("UNKNOWN_FIELD");
    }

    // 7. Audit-failure rollback (SQLite trigger): BOTH settlement recheck AND refund roll back completely!
    await env.PLATFORM_DB.prepare(
      `CREATE TRIGGER test_fail_platform_audit_insert
       BEFORE INSERT ON platform_audit
       BEGIN
         SELECT RAISE(ABORT, 'simulated platform_audit failure');
       END`,
    ).run();

    const auditFailRecheck = await handleConsoleBillingRecheckRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          attemptId: seeded.attemptId,
          reason: "Audited operator recheck that must roll back on audit failure",
        }),
      }),
      runtimeEnv,
      { nowMs, autolarisClient: mockClient, settlementPolicy: MOCK_POLICY },
    );
    expect(auditFailRecheck.status).toBe(500);
    expect(((await auditFailRecheck.json()) as { code: string }).code).toBe("AUDIT_PERSISTENCE_FAILED");

    // Verify ZERO mutation persisted after audit failure!
    const afterFailSettlement = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM settlements WHERE obligation_id = ?",
    )
      .bind(seeded.obligationId)
      .first<{ cnt: number }>();
    const afterFailGrant = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE tenant_id = ?",
    )
      .bind(seeded.tenantId)
      .first<{ cnt: number }>();
    const afterFailAttempt = await env.PLATFORM_DB.prepare(
      "SELECT lifecycle_state FROM payment_attempts WHERE id = ?",
    )
      .bind(seeded.attemptId)
      .first<{ lifecycle_state: string }>();
    expect(afterFailSettlement?.cnt).toBe(0);
    expect(afterFailGrant?.cnt).toBe(0);
    expect(afterFailAttempt?.lifecycle_state).toBe("pending");

    const auditFailRefund = await handleConsoleBillingRefundRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/refund`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          obligationId: seeded.obligationId,
          paymentAttemptId: seeded.attemptId,
          refundKind: "duplicate_payment",
          amountIdr: seeded.totalPayableIdr,
          reason: "Manual bank transfer refund that must roll back on audit failure",
        }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(auditFailRefund.status).toBe(500);
    const refundCntAfterFail = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM billing_refund_records WHERE obligation_id = ?",
    )
      .bind(seeded.obligationId)
      .first<{ cnt: number }>();
    expect(refundCntAfterFail?.cnt).toBe(0);

    // Drop failure trigger and verify clean audited recheck + audited refund succeed!
    await env.PLATFORM_DB.prepare("DROP TRIGGER test_fail_platform_audit_insert").run();

    const okRecheck = await handleConsoleBillingRecheckRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/recheck`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          attemptId: seeded.attemptId,
          reason: "Verified operator Advice recheck for ticket INC-2026-056",
        }),
      }),
      runtimeEnv,
      { nowMs, autolarisClient: mockClient, settlementPolicy: MOCK_POLICY },
    );
    expect(okRecheck.status).toBe(200);
    const okRecheckJson = (await okRecheck.json()) as {
      recheck: { outcome: string; grantApplied: boolean; settlementId: string; grantId: string };
      auditId: string;
    };
    expect(okRecheckJson.recheck.outcome).toBe("settled");
    expect(okRecheckJson.recheck.grantApplied).toBe(true);
    expect(okRecheckJson.auditId).toBeTruthy();

    const okRefund = await handleConsoleBillingRefundRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/refund`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          obligationId: seeded.obligationId,
          paymentAttemptId: seeded.attemptId,
          refundKind: "duplicate_payment",
          amountIdr: seeded.totalPayableIdr,
          externalReference: "TRF-BCA-20260131-001",
          reason: "Verified duplicate transfer refunded manually via BCA transfer",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 5_000 },
    );
    expect(okRefund.status).toBe(201);

    // Duplicate refund for same paymentAttemptId -> 409 CONFLICT
    const dupRefund = await handleConsoleBillingRefundRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/billing/refund`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
        },
        body: JSON.stringify({
          obligationId: seeded.obligationId,
          paymentAttemptId: seeded.attemptId,
          refundKind: "duplicate_payment",
          amountIdr: seeded.totalPayableIdr,
          reason: "Duplicate refund attempt must fail with conflict",
        }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 6_000 },
    );
    expect(dupRefund.status).toBe(409);

    // Audit trail contains both operator recheck settlement & refund record, fully redacted
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      tenantId: seeded.tenantId,
      limit: 20,
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("console.billing.advice_recheck_settled");
    expect(actions).toContain("console.billing.refund_recorded");
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain(TEST_AUTOLARIS_KEY);
    expect(serializedAudit).not.toContain(SECRET_QRIS);
    expect(serializedAudit).not.toContain(SECRET_VA);
  });
});
