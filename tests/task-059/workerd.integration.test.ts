import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DAY_MS,
  GRACE_WINDOW_MS,
  LOCKED_WINDOW_MS,
  TRIAL_DURATION_MS,
} from "@punyasitus/core/billing/index";
import { createLocalMailSink, type EmailPort, type EmailSendRequest } from "@punyasitus/core/email/index";
import {
  applyBillingObligationsMigration,
  applyVerifiedEntitlementGrant,
  consumeRenewalPayLink,
  ensureRenewalPayLinksSchema,
  InvalidLifecycleStateError,
  issueRenewalPayLink,
  setOperatorManualHold,
  syncTenantStoredLifecycleState,
} from "@punyasitus/db/billing/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { applyEmailClaimsMigration } from "@punyasitus/db/email/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  type TenantStatus,
} from "@punyasitus/db/platform";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildTenantEdgeCacheKey,
  routeEdgeRequest,
  STATE_PAGE_MESSAGES,
  type TenantGateEnv,
} from "../../apps/web/src/core/tenant.ts";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleRenewalPayLinkRequest } from "../../apps/web/src/pages/pay/renew.ts";
import { runBillingLifecycleAndReminderSweep } from "../../apps/web/src/worker/queues/billing/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-t059-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-t059-console-auth-secret-fedcba9876543210fedcba9876543210";

function buildGateEnv(): TenantGateEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function buildAuthEnv(): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function createMiddlewareLocals(surface: "app" | "console" = "app"): AuthMiddlewareLocals {
  return {
    surface,
    host: surface === "app" ? "app.punyasitus.com" : "console.punyasitus.com",
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
    authUser: null,
    authSession: null,
    authorizedTenantMember: null,
    tenantEntitlement: null,
    platformOperator: null,
    twoFactorVerifiedAtMs: null,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookie(res: Response): string {
  const pair = getSetCookies(res.headers).find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!pair) throw new Error("Missing app session cookie");
  return (pair.split(";")[0] ?? "").trim();
}

async function signUpUser(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({ email, password: "StrongPassword!2026", name }),
  });
  const res = await handleBetterAuthRequest(req, buildAuthEnv());
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    cookie: extractSessionCookie(res),
  };
}

async function seedTenantWithMembers(opts: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly operatorHold?: boolean;
  readonly trialEndsAtMs?: number | null;
  readonly paidThroughMs?: number | null;
  readonly host: string;
  readonly ownerUserId: string;
  readonly editorUserId?: string;
}): Promise<void> {
  const now = new Date();
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await db
    .insert(organizations)
    .values({
      id: opts.orgId,
      name: opts.name,
      slug: opts.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(members)
    .values({
      id: `mem_owner_${opts.id}`,
      organizationId: opts.orgId,
      userId: opts.ownerUserId,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();

  if (opts.editorUserId) {
    await db
      .insert(members)
      .values({
        id: `mem_editor_${opts.id}`,
        organizationId: opts.orgId,
        userId: opts.editorUserId,
        role: "editor",
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  await db
    .insert(tenants)
    .values({
      id: opts.id,
      organizationId: opts.orgId,
      handle: opts.handle,
      name: opts.name,
      status: opts.status,
      operatorHold: opts.operatorHold ?? false,
      trialEndsAt: opts.trialEndsAtMs != null ? new Date(opts.trialEndsAtMs) : null,
      paidThrough: opts.paidThroughMs != null ? new Date(opts.paidThroughMs) : null,
      cacheVersion: 1,
      schemaVersion: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenantHosts)
    .values({
      host: opts.host,
      tenantId: opts.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function syncSessionForFrozenTime(userId: string, nowMs: number): Promise<void> {
  const createdAt = nowMs - 60_000;
  const expiresAt = Math.max(nowMs, Date.now()) + 7 * DAY_MS;
  await env.PLATFORM_DB
    .prepare(
      `UPDATE sessions
       SET created_at = ?, updated_at = ?, expires_at = ?
       WHERE user_id = ?`,
    )
    .bind(createdAt, createdAt, expiresAt, userId)
    .run();
}

async function seedSettlementRecord(opts: {
  readonly settlementId: string;
  readonly tenantId: string;
  readonly amountIdr?: number;
  readonly nowMs: number;
}): Promise<void> {
  const obligationId = `obl_${opts.settlementId}`;
  const attemptId = `att_${opts.settlementId}`;
  const amount = opts.amountIdr ?? 179_000;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB
      .prepare(
        `INSERT OR IGNORE INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           due_at, paid_at, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'paid', ?, 0, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(obligationId, opts.tenantId, amount, amount, opts.nowMs, opts.nowMs, opts.nowMs, opts.nowMs),
    env.PLATFORM_DB
      .prepare(
        `INSERT OR IGNORE INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, provider_transaction_id,
           amount_idr, state, lifecycle_state, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'QRIS', 'autolaris', ?, ?, 'settled', 'paid', 1, ?, ?)`,
      )
      .bind(
        attemptId,
        obligationId,
        opts.tenantId,
        `trx_${opts.settlementId}`,
        amount,
        opts.nowMs,
        opts.nowMs,
      ),
    env.PLATFORM_DB
      .prepare(
        `INSERT OR IGNORE INTO settlements (
           id, obligation_id, payment_attempt_id, tenant_id, amount_idr,
           settled_at, reconciled_via, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'advice', ?)`,
      )
      .bind(opts.settlementId, obligationId, attemptId, opts.tenantId, amount, opts.nowMs, opts.nowMs),
  ]);
}

function makeAdminRequest(
  path: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  cookie: string,
  body?: unknown,
): Request {
  const headers = new Headers({ Cookie: cookie });
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", APP_ORIGIN);
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("TASK-059: Timed Entitlement Gate, Reminders, Concurrency & Isolation (workerd)", () => {
  let owner: { userId: string; cookie: string };
  let editor: { userId: string; cookie: string };

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyEmailClaimsMigration(env.PLATFORM_DB);
    await applyBillingObligationsMigration(env.PLATFORM_DB);
    await ensureRenewalPayLinksSchema(env.PLATFORM_DB);

    owner = await signUpUser("owner-t059@example.com", "Pemilik T059");
    editor = await signUpUser("editor-t059@example.com", "Editor T059");
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("freezes time across trial -> unpaid expiry (503) and active -> grace -> locked -> suspended (503) with exact HTTP statuses, warm cache bypass, and zero data/draft loss", async () => {
    const t0 = Date.UTC(2027, 5, 1, 0, 0, 0);
    const trialEnds = t0 + TRIAL_DURATION_MS;
    const trialTenantId = "01JT059TRIALTENANT00000001";
    const trialHost = "t059-trial.situsku.click";

    await seedTenantWithMembers({
      id: trialTenantId,
      orgId: "org_t059_trial",
      handle: "t059-trial",
      name: "Toko Uji Coba",
      status: "trial",
      trialEndsAtMs: trialEnds,
      paidThroughMs: null,
      host: trialHost,
      ownerUserId: owner.userId,
      editorUserId: editor.userId,
    });

    const gateEnv = buildGateEnv();
    const authEnv = buildAuthEnv();
    const cache = await caches.open("task-059-trial-cache");

    // 1. Trial active (1ms before expiry): public 200 + X-Robots-Tag: noindex, nofollow
    const trialLiveRes = await routeEdgeRequest(new Request(`https://${trialHost}/`), gateEnv, {
      nowMs: trialEnds - 1,
      cache,
      render: () => new Response("<h1>Trial Public Site</h1>", { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    expect(trialLiveRes.status).toBe(200);
    expect(trialLiveRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    // Trial custom domain connect blocked with 403 TRIAL_DOMAIN_FORBIDDEN
    await syncSessionForFrozenTime(owner.userId, trialEnds - 1);
    const trialDomainRes = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${trialTenantId}/domains`, "POST", owner.cookie, { host: "www.toko.id" }),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      authEnv,
      { nowMs: trialEnds - 1 },
    );
    expect(trialDomainRes.status).toBe(403);
    expect(((await trialDomainRes.json()) as { code: string }).code).toBe("TRIAL_DOMAIN_FORBIDDEN");

    // 2. Trial unpaid expiry (exact trialEnds): IMMEDIATELY 503 "Situs dalam perbaikan" + no-store + noindex (bypassing warm cache!)
    const warmTrialKey = buildTenantEdgeCacheKey(trialTenantId, 1, trialHost, "/");
    await cache.put(
      new Request(warmTrialKey),
      new Response("<h1>STALE TRIAL CACHE</h1>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const trialExpiredRes = await routeEdgeRequest(new Request(`https://${trialHost}/`), gateEnv, {
      nowMs: trialEnds,
      cache,
      render: () => new Response("MUST NOT RENDER", { status: 200 }),
    });
    expect(trialExpiredRes.status).toBe(503);
    expect(trialExpiredRes.headers.get("Cache-Control")).toContain("no-store");
    expect(trialExpiredRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const trialExpiredHtml = await trialExpiredRes.text();
    expect(trialExpiredHtml).toContain(STATE_PAGE_MESSAGES.suspended);
    expect(trialExpiredHtml).not.toContain("STALE TRIAL CACHE");

    // 3. Paid lifecycle tenant with real TenantStore published + draft pages
    const paidTenantId = "01JT059PAIDTENANT000000002";
    const paidHost = "t059-paid.situsku.click";
    const paidThrough = Date.UTC(2027, 6, 1, 0, 0, 0);

    await seedTenantWithMembers({
      id: paidTenantId,
      orgId: "org_t059_paid",
      handle: "t059-paid",
      name: "Studio Berbayar",
      status: "active",
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      host: paidHost,
      ownerUserId: owner.userId,
      editorUserId: editor.userId,
    });

    // Seed real TenantStore pages: one published, one unpublished draft
    const tenantStub = openTenantStoreStub(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      paidTenantId,
    );
    await orchestrateTenantMigration(env.PLATFORM_DB, tenantStub, paidTenantId, TENANT_MIGRATIONS);
    const tenantDb = createTenantDb(tenantStub);
    await tenantDb
      .prepare(
        `INSERT INTO pages (id, slug, title, draft_sections_json, published_sections_json, status, version, published_at, created_at, updated_at)
         VALUES (1, 'tentang-kami', 'Tentang Kami', '[]', '[]', 'published', 1, ?, ?, ?),
                (2, 'promo-rahasia', 'Promo Rahasia', '[]', NULL, 'draft', 1, NULL, ?, ?)`,
      )
      .bind(t0, t0, t0, t0, t0)
      .run();

    // 3a. Active (paidThrough - 1ms): public 200 indexable + CMS write allowed
    const activePub = await routeEdgeRequest(new Request(`https://${paidHost}/`), gateEnv, {
      nowMs: paidThrough - 1,
      bypassHostCache: true,
      render: () => new Response("<h1>Active Paid Site</h1>", { status: 200 }),
    });
    expect(activePub.status).toBe(200);
    expect(activePub.headers.get("X-Robots-Tag")).toBeNull();

    // 3b. Grace (H+2): public 200 indexable + CMS write allowed
    const graceNow = paidThrough + 2 * DAY_MS;
    await syncSessionForFrozenTime(owner.userId, graceNow);
    await syncSessionForFrozenTime(editor.userId, graceNow);
    const gracePub = await routeEdgeRequest(new Request(`https://${paidHost}/`), gateEnv, {
      nowMs: graceNow,
      bypassHostCache: true,
      render: () => new Response("<h1>Grace Site</h1>", { status: 200 }),
    });
    expect(gracePub.status).toBe(200);
    expect(gracePub.headers.get("X-Robots-Tag")).toBeNull();

    const graceWrite = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/pages`, "POST", owner.cookie, { title: "Edit Grace" }),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      authEnv,
      { nowMs: graceNow },
    );
    expect(graceWrite.status).toBe(201);

    // 3c. Locked (H+5): public STILL 200 & indexable! CMS reads/billing/export succeed; CMS writes return 403 SUBSCRIPTION_LOCKED!
    const lockedNow = paidThrough + 5 * DAY_MS;
    await syncSessionForFrozenTime(owner.userId, lockedNow);
    await syncSessionForFrozenTime(editor.userId, lockedNow);
    const lockedPub = await routeEdgeRequest(new Request(`https://${paidHost}/`), gateEnv, {
      nowMs: lockedNow,
      bypassHostCache: true,
      render: () => new Response("<h1>Locked SEO Live Site</h1>", { status: 200 }),
    });
    expect(lockedPub.status).toBe(200);
    expect(lockedPub.headers.get("X-Robots-Tag")).toBeNull();

    const lockedWrite = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/pages`, "POST", owner.cookie, { title: "Blocked" }),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(lockedWrite.status).toBe(403);
    const lockedWriteBody = (await lockedWrite.json()) as { code: string; error: { code: string } };
    expect(lockedWriteBody.code).toBe("SUBSCRIPTION_LOCKED");
    expect(lockedWriteBody.error.code).toBe("SUBSCRIPTION_LOCKED");

    const lockedPublish = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/pages/2/publish`, "POST", editor.cookie, {}),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(lockedPublish.status).toBe(403);
    expect(((await lockedPublish.json()) as { code: string }).code).toBe("SUBSCRIPTION_LOCKED");

    const lockedRead = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/pages`, "GET", editor.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(lockedRead.status).toBe(200);

    const lockedExport = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/leads/export.csv`, "GET", owner.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response("name,phone\n", { status: 200 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(lockedExport.status).toBe(200);

    const lockedBilling = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/billing`, "GET", owner.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(lockedBilling.status).toBe(200);

    // Sign-out remains open in locked/suspended!
    const signOutCheck = await executeAuthMiddleware(
      {
        request: makeAdminRequest("/api/auth/sign-out", "POST", owner.cookie, {}),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ signedOut: true }), { status: 200 }),
      authEnv,
      { nowMs: lockedNow },
    );
    expect(signOutCheck.status).toBe(200);

    // 3d. Suspended (H+8): public 503 + no-store + noindex + "Situs dalam perbaikan", CMS read & write 403 SUBSCRIPTION_LOCKED, owner billing & leads export 200
    const suspendedNow = paidThrough + LOCKED_WINDOW_MS;
    await syncSessionForFrozenTime(owner.userId, suspendedNow);
    await syncSessionForFrozenTime(editor.userId, suspendedNow);
    const suspendedPub = await routeEdgeRequest(new Request(`https://${paidHost}/`), gateEnv, {
      nowMs: suspendedNow,
      bypassHostCache: true,
      render: () => new Response("MUST NOT RENDER", { status: 200 }),
    });
    expect(suspendedPub.status).toBe(503);
    expect(suspendedPub.headers.get("Cache-Control")).toContain("no-store");
    expect(suspendedPub.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await suspendedPub.text()).toContain(STATE_PAGE_MESSAGES.suspended);

    const suspendedCmsRead = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/pages`, "GET", owner.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      authEnv,
      { nowMs: suspendedNow },
    );
    expect(suspendedCmsRead.status).toBe(403);
    expect(((await suspendedCmsRead.json()) as { code: string }).code).toBe("SUBSCRIPTION_LOCKED");

    const suspendedExportOwner = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/leads/export.csv`, "GET", owner.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response("csv", { status: 200 }),
      authEnv,
      { nowMs: suspendedNow },
    );
    expect(suspendedExportOwner.status).toBe(200);

    const suspendedBillingMemberDenied = await executeAuthMiddleware(
      {
        request: makeAdminRequest(`/api/tenants/${paidTenantId}/billing`, "GET", editor.cookie),
        locals: createMiddlewareLocals("app"),
      },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      authEnv,
      { nowMs: suspendedNow },
    );
    expect(suspendedBillingMemberDenied.status).toBe(403);

    // 3e. Sync stored status to suspended -> verify ZERO data deleted & draft stays unpublished after payment recovery!
    const synced = await syncTenantStoredLifecycleState(env.PLATFORM_DB, {
      tenantId: paidTenantId,
      nowMs: suspendedNow,
    });
    expect(synced.transitioned).toBe(true);
    expect(synced.currentStatus).toBe("suspended");

    await seedSettlementRecord({
      settlementId: "stl_t059_recovery_01",
      tenantId: paidTenantId,
      nowMs: suspendedNow + 60_000,
    });
    const grant = await applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
      tenantId: paidTenantId,
      settlementId: "stl_t059_recovery_01",
      plan: "monthly",
      grantedBy: "system:advice",
      nowMs: suspendedNow + 60_000,
    });
    expect(grant.applied).toBe(true);
    expect(grant.nextStatus).toBe("active");

    // Verify TenantStore pages were NEVER deleted and draft was NEVER published!
    const pagesAfter = await tenantDb
      .prepare("SELECT id, slug, status, published_at FROM pages ORDER BY id ASC")
      .all<{ id: number; slug: string; status: string; published_at: number | null }>();
    expect(pagesAfter.results).toEqual([
      { id: 1, slug: "tentang-kami", status: "published", published_at: t0 },
      { id: 2, slug: "promo-rahasia", status: "draft", published_at: null },
    ]);
  });

  it("emits deduplicated H-3, H-1, H0 reminders with single-use grace-expiring pay links and isolates email failures from entitlement state", async () => {
    const paidThrough = Date.UTC(2026, 7, 15, 0, 0, 0);
    const tenantId = "01JT059REMINDERTENANT00001";
    const otherTenantId = "01JT059OTHERREMINDER000002";

    await seedTenantWithMembers({
      id: tenantId,
      orgId: "org_t059_rem",
      handle: "t059-rem",
      name: "Usaha Pengingat",
      status: "active",
      paidThroughMs: paidThrough,
      host: "t059-rem.situsku.click",
      ownerUserId: owner.userId,
    });

    await seedTenantWithMembers({
      id: otherTenantId,
      orgId: "org_t059_rem_other",
      handle: "t059-rem-other",
      name: "Usaha Lain",
      status: "active",
      paidThroughMs: paidThrough + 60 * DAY_MS,
      host: "t059-rem-other.situsku.click",
      ownerUserId: owner.userId,
    });

    const sink = createLocalMailSink();

    // H-3 sweep (run twice -> second run must deduplicate!)
    const hMinus3Now = paidThrough - 3 * DAY_MS + 1_000;
    const sweep1 = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: hMinus3Now, emailPort: sink },
    );
    const h3Attempt = sweep1.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h_minus_3",
    );
    expect(h3Attempt?.outcome).toBe("submitted");
    expect(h3Attempt?.payUrl).toContain("/pay/renew?token=");

    const sweep1Dup = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: hMinus3Now + 60_000, emailPort: sink },
    );
    const h3Dup = sweep1Dup.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h_minus_3",
    );
    expect(h3Dup?.outcome).toBe("duplicate");

    // Extract raw token from payUrl and verify plaintext token is NOT stored in D1!
    const rawH3Token = new URL(h3Attempt!.payUrl!).searchParams.get("token")!;
    expect(rawH3Token.length).toBeGreaterThanOrEqual(32);
    const leakedRow = await env.PLATFORM_DB
      .prepare("SELECT id FROM billing_renewal_pay_links WHERE token_hash = ?")
      .bind(rawH3Token)
      .first();
    expect(leakedRow).toBeNull();

    // Cross-tenant consumption fails without consuming the token!
    const wrongTenantConsume = await consumeRenewalPayLink(env.PLATFORM_DB, {
      rawToken: rawH3Token,
      expectedTenantId: otherTenantId,
      nowMs: hMinus3Now + 5_000,
    });
    expect(wrongTenantConsume).toEqual({ ok: false, reason: "tenant_mismatch" });

    // Concurrent single-use consumption -> AT MOST ONE succeeds, and NEVER activates service or grants session!
    const [c1, c2] = await Promise.all([
      consumeRenewalPayLink(env.PLATFORM_DB, {
        rawToken: rawH3Token,
        expectedTenantId: tenantId,
        nowMs: hMinus3Now + 10_000,
      }),
      consumeRenewalPayLink(env.PLATFORM_DB, {
        rawToken: rawH3Token,
        expectedTenantId: tenantId,
        nowMs: hMinus3Now + 10_000,
      }),
    ]);
    const successes = [c1, c2].filter((r) => r.ok);
    const failures = [c1, c2].filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    if (successes[0]?.ok) {
      expect(successes[0].link.tenantId).toBe(tenantId);
      expect(successes[0].link.grantsAdminSession).toBe(false);
      expect(successes[0].link.activatesService).toBe(false);
      expect(successes[0].link.expiresAtMs).toBe(paidThrough + GRACE_WINDOW_MS);
    }
    if (failures[0] && !failures[0].ok) {
      expect(failures[0].reason).toBe("already_used");
    }

    // H-1 sweep -> emits H-1 link; verify it expires at exact end of grace window (paidThrough + 72h)
    const hMinus1Now = paidThrough - 1 * DAY_MS + 1_000;
    const sweepH1 = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: hMinus1Now, emailPort: sink },
    );
    const h1Attempt = sweepH1.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h_minus_1",
    );
    expect(h1Attempt?.outcome).toBe("submitted");
    const rawH1Token = new URL(h1Attempt!.payUrl!).searchParams.get("token")!;

    const expiredAfterGrace = await consumeRenewalPayLink(env.PLATFORM_DB, {
      rawToken: rawH1Token,
      expectedTenantId: tenantId,
      nowMs: paidThrough + GRACE_WINDOW_MS, // exact end of grace
    });
    expect(expiredAfterGrace).toEqual({ ok: false, reason: "expired" });

    // H0 sweep with a FAILING EmailPort -> tenant STILL transitions active -> grace cleanly!
    const failingPort: EmailPort = {
      provider: "local-sink",
      async send(_req: EmailSendRequest) {
        throw new Error("SMTP_PROVIDER_OUTAGE");
      },
    };

    const h0Now = paidThrough + 1_000;
    const sweepH0 = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: h0Now, emailPort: failingPort },
    );
    const h0Attempt = sweepH0.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h0",
    );
    expect(h0Attempt?.outcome).toBe("failed");
    expect(sweepH0.emailFailuresIsolated).toBeGreaterThanOrEqual(1);

    // Tenant stored status MUST still have transitioned to `grace` despite email failure!
    const rowAfterFailure = await env.PLATFORM_DB
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(tenantId)
      .first<{ status: string }>();
    expect(rowAfterFailure?.status).toBe("grace");
  });

  it("serializes concurrent expiry, payment settlement, duplicate settlement, and manual hold (manual hold survives payment)", async () => {
    const paidThrough = Date.UTC(2026, 8, 1, 0, 0, 0);
    const raceTenantId = "01JT059RACETENANT000000001";
    await seedTenantWithMembers({
      id: raceTenantId,
      orgId: "org_t059_race",
      handle: "t059-race",
      name: "Studio Konkurensi",
      status: "locked",
      paidThroughMs: paidThrough,
      host: "t059-race.situsku.click",
      ownerUserId: owner.userId,
    });

    const settlementNow = paidThrough + LOCKED_WINDOW_MS + 1000; // H+8 boundary
    await seedSettlementRecord({
      settlementId: "stl_t059_race_dup_01",
      tenantId: raceTenantId,
      nowMs: settlementNow,
    });

    // Race expiry sync + TWO duplicate settlement grants concurrently!
    const [syncOut, grantA, grantB] = await Promise.all([
      syncTenantStoredLifecycleState(env.PLATFORM_DB, {
        tenantId: raceTenantId,
        nowMs: settlementNow,
      }),
      applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
        tenantId: raceTenantId,
        settlementId: "stl_t059_race_dup_01",
        plan: "monthly",
        grantedBy: "system:advice",
        nowMs: settlementNow,
      }),
      applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
        tenantId: raceTenantId,
        settlementId: "stl_t059_race_dup_01",
        plan: "monthly",
        grantedBy: "system:advice",
        nowMs: settlementNow,
      }),
    ]);

    // Exactly ONE grant applied, zero lost entitlement, final status is active!
    expect([grantA.applied, grantB.applied].filter(Boolean).length).toBe(1);
    expect([grantA.alreadyGranted, grantB.alreadyGranted].filter(Boolean).length).toBe(1);
    expect(syncOut.found).toBe(true);

    const grantsCount = await env.PLATFORM_DB
      .prepare("SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE settlement_id = ?")
      .bind("stl_t059_race_dup_01")
      .first<{ cnt: number }>();
    expect(grantsCount?.cnt).toBe(1);

    const afterRace = await env.PLATFORM_DB
      .prepare("SELECT status, paid_through FROM tenants WHERE id = ?")
      .bind(raceTenantId)
      .first<{ status: string; paid_through: number }>();
    expect(afterRace?.status).toBe("active");
    expect(afterRace?.paid_through).toBeGreaterThan(settlementNow);

    // Apply manual operator hold -> payment settlement MUST NOT clear operator hold OR overwrite deletion_due_at!
    const pausedDeletionDueAt = settlementNow + 20 * DAY_MS;
    await env.PLATFORM_DB
      .prepare("UPDATE tenants SET deletion_due_at = ? WHERE id = ?")
      .bind(pausedDeletionDueAt, raceTenantId)
      .run();

    const holdRes = await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId: raceTenantId,
      hold: true,
      reason: "Peninjauan kepatuhan manual",
      operatorUserId: "op_t059_01",
      nowMs: settlementNow + 10_000,
    });
    expect(holdRes.operatorHold).toBe(true);
    expect(holdRes.effectiveStatus).toBe("suspended");

    await seedSettlementRecord({
      settlementId: "stl_t059_while_held_02",
      tenantId: raceTenantId,
      nowMs: settlementNow + 20_000,
    });
    const paidWhileHeld = await applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
      tenantId: raceTenantId,
      settlementId: "stl_t059_while_held_02",
      plan: "monthly",
      grantedBy: "system:advice",
      nowMs: settlementNow + 20_000,
    });
    expect(paidWhileHeld.applied).toBe(true);
    expect(paidWhileHeld.operatorHoldPreserved).toBe(true);
    expect(paidWhileHeld.nextStatus).toBe("suspended");

    const heldRow = await env.PLATFORM_DB
      .prepare("SELECT status, operator_hold, deletion_due_at FROM tenants WHERE id = ?")
      .bind(raceTenantId)
      .first<{ status: string; operator_hold: number; deletion_due_at: number | null }>();
    expect(heldRow?.status).toBe("suspended");
    expect(heldRow?.operator_hold).toBe(1);
    expect(heldRow?.deletion_due_at).toBe(pausedDeletionDueAt);

    // Public site MUST STILL return 503 even after verified payment while hold is active!
    const heldPublicRes = await routeEdgeRequest(
      new Request("https://t059-race.situsku.click/"),
      buildGateEnv(),
      {
        nowMs: settlementNow + 30_000,
        bypassHostCache: true,
        render: () => new Response("MUST NOT RENDER", { status: 200 }),
      },
    );
    expect(heldPublicRes.status).toBe(503);

    // Lifting the hold restores `active` because the paid period was preserved!
    const unholdRes = await setOperatorManualHold(env.PLATFORM_DB, {
      tenantId: raceTenantId,
      hold: false,
      reason: null,
      operatorUserId: "op_t059_01",
      nowMs: settlementNow + 40_000,
    });
    expect(unholdRes.operatorHold).toBe(false);
    expect(unholdRes.effectiveStatus).toBe("active");
  });

  it("recalculates entitlement per tenant on cross-tenant switching with zero stale state leakage", async () => {
    const nowMs = Date.UTC(2027, 9, 10, 0, 0, 0);
    const activeId = "01JT059SWITCHACTIVE0000001";
    const lockedId = "01JT059SWITCHLOCKED0000002";
    const suspendedId = "01JT059SWITCHSUSPENDED0003";

    await seedTenantWithMembers({
      id: activeId,
      orgId: "org_t059_sw_a",
      handle: "t059-sw-active",
      name: "Switch Active",
      status: "active",
      paidThroughMs: nowMs + 15 * DAY_MS,
      host: "t059-sw-active.situsku.click",
      ownerUserId: owner.userId,
    });
    await seedTenantWithMembers({
      id: lockedId,
      orgId: "org_t059_sw_b",
      handle: "t059-sw-locked",
      name: "Switch Locked",
      status: "active",
      paidThroughMs: nowMs - 5 * DAY_MS, // locked H+5
      host: "t059-sw-locked.situsku.click",
      ownerUserId: owner.userId,
    });
    await seedTenantWithMembers({
      id: suspendedId,
      orgId: "org_t059_sw_c",
      handle: "t059-sw-suspended",
      name: "Switch Suspended",
      status: "active",
      paidThroughMs: nowMs - 10 * DAY_MS, // suspended H+10
      host: "t059-sw-suspended.situsku.click",
      ownerUserId: owner.userId,
    });

    const authEnv = buildAuthEnv();
    await syncSessionForFrozenTime(owner.userId, nowMs);

    // 1. Active tenant dashboard + write succeeds
    const localsA = createMiddlewareLocals("app");
    const resA = await executeAuthMiddleware(
      { request: makeAdminRequest(`/api/tenants/${activeId}/pages`, "POST", owner.cookie, { title: "OK" }), locals: localsA },
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      authEnv,
      { nowMs },
    );
    expect(resA.status).toBe(201);
    expect(localsA.tenantEntitlement?.evaluation.effectiveStatus).toBe("active");

    // 2. Switch immediately to Locked tenant -> write denied 403 SUBSCRIPTION_LOCKED, read 200
    const localsB = createMiddlewareLocals("app");
    const resBWrite = await executeAuthMiddleware(
      { request: makeAdminRequest(`/api/tenants/${lockedId}/pages`, "POST", owner.cookie, { title: "No" }), locals: localsB },
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      authEnv,
      { nowMs },
    );
    expect(resBWrite.status).toBe(403);
    expect(localsB.tenantEntitlement?.evaluation.effectiveStatus).toBe("locked");

    // 3. Switch to Suspended tenant -> CMS read denied 403 SUBSCRIPTION_LOCKED
    const localsC = createMiddlewareLocals("app");
    const resCRead = await executeAuthMiddleware(
      { request: makeAdminRequest(`/api/tenants/${suspendedId}/pages`, "GET", owner.cookie), locals: localsC },
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      authEnv,
      { nowMs },
    );
    expect(resCRead.status).toBe(403);
    expect(localsC.tenantEntitlement?.evaluation.effectiveStatus).toBe("suspended");

    // 4. Switch back to Active tenant -> write STILL succeeds (no locked/suspended bleed!)
    const localsA2 = createMiddlewareLocals("app");
    const resA2 = await executeAuthMiddleware(
      { request: makeAdminRequest(`/api/tenants/${activeId}/pages`, "POST", owner.cookie, { title: "Still OK" }), locals: localsA2 },
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      authEnv,
      { nowMs },
    );
    expect(resA2.status).toBe(201);
    expect(localsA2.tenantEntitlement?.evaluation.effectiveStatus).toBe("active");
  });

  it("never resurrects provisioning, purging, purged, or recovery tenants via applyVerifiedEntitlementGrant or setOperatorManualHold", async () => {
    const nowMs = Date.UTC(2027, 10, 1, 0, 0, 0);
    const terminalStates: readonly TenantStatus[] = [
      "provisioning",
      "purging",
      "purged",
      "recovery",
    ];

    for (const [idx, state] of terminalStates.entries()) {
      const tenantId = `01JT059TERM${String(idx).padStart(2, "0")}0000000000000`;
      const handle = `t059-term-${state}`;
      const originalPaidThrough = nowMs + 10 * DAY_MS;

      await seedTenantWithMembers({
        id: tenantId,
        orgId: `org_t059_term_${state}`,
        handle,
        name: `Terminal ${state}`,
        status: state,
        operatorHold: state === "purged",
        paidThroughMs: originalPaidThrough,
        host: `${handle}.situsku.click`,
        ownerUserId: owner.userId,
      });

      const settlementId = `stl_t059_term_${state}`;
      await seedSettlementRecord({
        settlementId,
        tenantId,
        nowMs,
      });

      // 1. Late settlement MUST defer to review without altering status, paid_through, or inserting grant
      const grantRes = await applyVerifiedEntitlementGrant(env.PLATFORM_DB, {
        tenantId,
        settlementId,
        plan: "monthly",
        grantedBy: "system:advice",
        nowMs,
      });
      expect(grantRes.applied).toBe(false);
      expect(grantRes.deferredTerminalState).toBe(true);
      expect(grantRes.reviewRequired).toBe(true);
      expect(grantRes.nextStatus).toBe(state);

      const grantCount = await env.PLATFORM_DB
        .prepare("SELECT COUNT(*) AS cnt FROM entitlement_grants WHERE tenant_id = ?")
        .bind(tenantId)
        .first<{ cnt: number }>();
      expect(grantCount?.cnt).toBe(0);

      // 2. setOperatorManualHold MUST reject both hold=true and hold=false with 409 INVALID_LIFECYCLE_STATE
      for (const holdFlag of [true, false]) {
        let caught: unknown = null;
        try {
          await setOperatorManualHold(env.PLATFORM_DB, {
            tenantId,
            hold: holdFlag,
            reason: holdFlag ? "Attempt hold on terminal state" : null,
            operatorUserId: "op_t059_01",
            nowMs,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvalidLifecycleStateError);
        const typedErr = caught as InvalidLifecycleStateError;
        expect(typedErr.status).toBe(409);
        expect(typedErr.code).toBe("INVALID_LIFECYCLE_STATE");
        expect(typedErr.storedStatus).toBe(state);
      }

      // Verify tenant row status and paid_through remained completely untouched
      const afterRow = await env.PLATFORM_DB
        .prepare("SELECT status, paid_through FROM tenants WHERE id = ?")
        .bind(tenantId)
        .first<{ status: string; paid_through: number | null }>();
      expect(afterRow?.status).toBe(state);
      expect(afterRow?.paid_through).toBe(originalPaidThrough);
    }
  });

  it("serves GET /pay/renew?token=... strictly on app host, enforces single-use & grace expiry without minting sessions or activating service, and retries after definite email failure", async () => {
    const paidThrough = Date.UTC(2027, 11, 10, 0, 0, 0);
    const tenantId = "01JT059PAYRENEWTENANT00001";
    const handle = "t059-pay-renew";

    await seedTenantWithMembers({
      id: tenantId,
      orgId: "org_t059_pay_renew",
      handle,
      name: "Toko Bayar Sekali Klik",
      status: "grace",
      paidThroughMs: paidThrough,
      host: `${handle}.situsku.click`,
      ownerUserId: owner.userId,
    });

    // Seed an open obligation so redirect includes `&obligation=...`
    const obligationId = "01JT059OPENOBLIGATION00001";
    await env.PLATFORM_DB
      .prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status,
           gross_amount_idr, discount_amount_idr, net_amount_idr,
           due_at, version, created_at, updated_at
         ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, ?, 1, ?, ?)`,
      )
      .bind(obligationId, tenantId, paidThrough, paidThrough - DAY_MS, paidThrough - DAY_MS)
      .run();

    const authEnv = buildAuthEnv();
    const h0Now = paidThrough + 2_000;

    // 1. Definite email failure releases unconsumed token so next sweep retries cleanly
    const failingPort: EmailPort = {
      provider: "local-sink",
      async send(_req: EmailSendRequest) {
        return {
          outcome: "failed",
          provider: "local-sink",
          errorCode: "E_RATE_LIMITED",
          retryable: true,
          suppressed: false,
        };
      },
    };
    const failedSweep = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: h0Now, emailPort: failingPort },
    );
    const failedH0 = failedSweep.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h0",
    );
    expect(failedH0?.outcome).toBe("failed");

    // Next sweep with working EmailPort re-issues & delivers the H0 pay link!
    const sink = createLocalMailSink();
    const retrySweep = await runBillingLifecycleAndReminderSweep(
      { PLATFORM_DB: env.PLATFORM_DB },
      { nowMs: h0Now + 60_000, emailPort: sink },
    );
    const okH0 = retrySweep.emailAttempts.find(
      (a) => a.tenantId === tenantId && a.kind === "paid_h0",
    );
    expect(okH0?.outcome).toBe("submitted");
    expect(okH0?.payUrl).toContain("https://app.punyasitus.com/pay/renew?token=");

    const payUrl = okH0!.payUrl!;

    // 2. Wrong hosts (`tenant` host & `console` host) MUST return neutral 404 without consuming token
    const rawToken = new URL(payUrl).searchParams.get("token")!;
    const tenantHostRes = await handleRenewalPayLinkRequest(
      new Request(`https://${handle}.situsku.click/pay/renew?token=${encodeURIComponent(rawToken)}`),
      authEnv,
      { nowMs: h0Now + 70_000 },
    );
    expect(tenantHostRes.status).toBe(404);

    const consoleHostRes = await handleRenewalPayLinkRequest(
      new Request(`https://console.punyasitus.com/pay/renew?token=${encodeURIComponent(rawToken)}`),
      authEnv,
      { nowMs: h0Now + 70_000 },
    );
    expect(consoleHostRes.status).toBe(404);

    // 3. Missing / malformed token -> 400; forged token -> 410 (no tenant leak)
    const missingTokenRes = await handleRenewalPayLinkRequest(
      new Request(`${APP_ORIGIN}/pay/renew`, { headers: { Accept: "application/json" } }),
      authEnv,
      { nowMs: h0Now + 70_000 },
    );
    expect(missingTokenRes.status).toBe(400);

    const forgedTokenRes = await handleRenewalPayLinkRequest(
      new Request(`${APP_ORIGIN}/pay/renew?token=${"a".repeat(64)}`, {
        headers: { Accept: "application/json" },
      }),
      authEnv,
      { nowMs: h0Now + 70_000 },
    );
    expect(forgedTokenRes.status).toBe(410);

    // 4. Valid first hit on `app.punyasitus.com` -> 302 to billing with zero Set-Cookie & zero service activation
    const firstHit = await handleRenewalPayLinkRequest(
      new Request(payUrl),
      authEnv,
      { nowMs: h0Now + 80_000 },
    );
    expect(firstHit.status).toBe(302);
    expect(firstHit.headers.get("Location")).toBe(
      `/dashboard/${handle}/billing?renew=1&obligation=${encodeURIComponent(obligationId)}`,
    );
    expect(firstHit.headers.get("Cache-Control")).toBe(
      "private, no-store, no-cache, must-revalidate",
    );
    expect(firstHit.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(firstHit.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(getSetCookies(firstHit.headers)).toEqual([]);

    // Verify service was NOT activated (`status` is still `grace`, zero entitlement grants added)
    const afterFirstHit = await env.PLATFORM_DB
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(tenantId)
      .first<{ status: string }>();
    expect(afterFirstHit?.status).toBe("grace");

    // 5. Immediate replay of the consumed token -> 410 Gone
    const replayHit = await handleRenewalPayLinkRequest(
      new Request(payUrl, { headers: { Accept: "text/html" } }),
      authEnv,
      { nowMs: h0Now + 81_000 },
    );
    expect(replayHit.status).toBe(410);
    expect(replayHit.headers.get("Cache-Control")).toBe(
      "private, no-store, no-cache, must-revalidate",
    );
    expect(replayHit.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(replayHit.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(getSetCookies(replayHit.headers)).toEqual([]);

    // 6. Token expired past grace window (`paidThrough + 72h`) -> 410 Gone
    const expiredLink = await issueRenewalPayLink(env.PLATFORM_DB, {
      tenantId,
      obligationId,
      payerUserId: owner.userId,
      reminderKind: "paid_h_minus_1",
      cycleAnchorMs: paidThrough,
      expiresAtMs: paidThrough + GRACE_WINDOW_MS,
      nowMs: paidThrough - DAY_MS,
    });
    expect(expiredLink.created).toBe(true);
    if (expiredLink.created) {
      const expiredHit = await handleRenewalPayLinkRequest(
        new Request(expiredLink.payUrl, { headers: { Accept: "application/json" } }),
        authEnv,
        { nowMs: paidThrough + GRACE_WINDOW_MS },
      );
      expect(expiredHit.status).toBe(410);
      expect(getSetCookies(expiredHit.headers)).toEqual([]);
    }
  });
});
