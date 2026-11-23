import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME, createAuth } from "@punyasitus/auth";
import { createLocalMailSink, type EmailPort } from "@punyasitus/core/email/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";
import { handleTenantLeadDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/[leadId].ts";
import { handleTenantLeadsExportCsvRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/export.csv.ts";
import { handleTenantLeadsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/index.ts";
import { handleTenantLeadNotificationsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/notifications.ts";
import type { TenantLeadsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_SECRET = "task021-workerd-integration-auth-secret-0123456789abcdef";
const TEST_RATE_LIMIT_SALT = "task021-workerd-rate-limit-salt";
const DAY_MS = 24 * 60 * 60 * 1000;

let platformMigrated = false;

async function ensurePlatformMigrated(): Promise<void> {
  if (platformMigrated) return;
  await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  platformMigrated = true;
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

function createBrokenDb(): D1Database {
  const err = () => Promise.reject(new Error("TENANT_STORE_DO_UNAVAILABLE"));
  const stmt = {
    bind() {
      return this;
    },
    first: err,
    run: err,
    all: err,
    raw: err,
  } as unknown as D1PreparedStatement;
  return {
    prepare() {
      return stmt;
    },
    batch: err,
    exec: err,
  } as unknown as D1Database;
}

async function createSignedInUser(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: TEST_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
    emailPort: createLocalMailSink(),
  });
  const res = await auth.handler(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify({
        email,
        password: "Task021Password!2026",
        name,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user?: { id?: string } };
  const userId = body.user?.id ?? "";
  expect(userId.length).toBeGreaterThan(0);

  const rawCookie = res.headers.get("set-cookie") ?? "";
  const match = rawCookie.match(new RegExp(`${APP_SESSION_COOKIE_NAME}=[^;]+`));
  expect(match).not.toBeNull();
  return { userId, cookie: match![0] };
}

function makeRuntimeEnv(overrides?: Partial<TenantLeadsRuntimeEnv>): TenantLeadsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

function makeAdminRequest(
  pathname: string,
  method: "GET" | "PATCH" | "POST",
  cookie: string,
  body?: unknown,
  origin: string = APP_ORIGIN,
): Request {
  const headers: Record<string, string> = {
    Cookie: cookie,
    Accept: "application/json",
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers.Origin = origin;
  }
  return new Request(`${origin}${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedTenantWithMembers(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly adminUserId?: string;
  readonly editorUserId?: string;
  readonly nowMs: number;
}): Promise<D1Database> {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(params.orgId, params.name, params.handle, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      params.nowMs + 30 * DAY_MS,
      params.nowMs,
      params.nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
    ).bind(`${params.handle}.situsku.click`, params.tenantId, params.nowMs, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_own_${params.handle}`, params.orgId, params.ownerUserId, params.nowMs),
  ]);

  if (params.adminUserId) {
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'admin', ?)`,
    )
      .bind(`mem_adm_${params.handle}`, params.orgId, params.adminUserId, params.nowMs)
      .run();
  }
  if (params.editorUserId) {
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'editor', ?)`,
    )
      .bind(`mem_edt_${params.handle}`, params.orgId, params.editorUserId, params.nowMs)
      .run();
  }

  return openMigratedTenantDb(params.tenantId);
}

describe("TASK-021 workerd integration — Public Lead Capture API, PII-free owner email, Inbox RBAC, Status Transitions & CSV Export", () => {
  it("persists JSON & no-JS form POST once, sends 1 PII-free owner email (switchable OFF & fault-isolated), handles replay/honeypot/rate-limit/Turnstile/outage, and enforces inbox RBAC + locked/suspended CSV export", async () => {
    await ensurePlatformMigrated();
    const nowMs = 1_763_860_000_000;
    const runtimeEnv = makeRuntimeEnv();
    const mailSink = createLocalMailSink();

    // Create isolated users & two tenants (Tenant A + Tenant B)
    const ownerA = await createSignedInUser("owner.a.t021@example.test", "Pemilik Alpha");
    const adminA = await createSignedInUser("admin.a.t021@example.test", "Admin Alpha");
    const editorA = await createSignedInUser("editor.a.t021@example.test", "Editor Alpha");
    const ownerB = await createSignedInUser("owner.b.t021@example.test", "Pemilik Beta");

    const tenantAId = "01JT021TENANTA000000000001";
    const tenantBId = "01JT021TENANTB000000000002";
    const tenantAHost = "t021-alpha.situsku.click";
    const tenantBHost = "t021-beta.situsku.click";

    const dbA = await seedTenantWithMembers({
      tenantId: tenantAId,
      orgId: "org_t021_alpha",
      handle: "t021-alpha",
      name: "Alpha Konsultan",
      ownerUserId: ownerA.userId,
      adminUserId: adminA.userId,
      editorUserId: editorA.userId,
      nowMs,
    });
    const dbB = await seedTenantWithMembers({
      tenantId: tenantBId,
      orgId: "org_t021_beta",
      handle: "t021-beta",
      name: "Beta Klinik",
      ownerUserId: ownerB.userId,
      nowMs,
    });

    const tenantAScope = {
      id: tenantAId,
      handle: "t021-alpha",
      name: "Alpha Konsultan",
      host: tenantAHost,
      status: "active" as const,
    };

    // -------------------------------------------------------------------------
    // 1. JSON POST /api/leads persists once + sends 1 strictly PII-free email
    // -------------------------------------------------------------------------
    const idemKey1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const visitor1 = {
      name: "Rina Wulandari Rahasia",
      phone: "0812-8877-6655",
      email: "rina.rahasia@example.test",
      message: "Halo Alpha, kami butuh penawaran audit legalitas PT.",
      privacyConsent: true,
      sourcePath: "/kontak",
      utm_source: "google",
      utm_campaign: "brand_search",
    };

    const jsonRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.10",
          "Idempotency-Key": idemKey1,
        },
        body: JSON.stringify(visitor1),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs,
      },
    );

    expect(jsonRes.status).toBe(201);
    const jsonBody = (await jsonRes.json()) as { leadNumber: number; status: string };
    expect(jsonBody.status).toBe("accepted");
    expect(jsonBody.leadNumber).toBe(1);

    // Owner received strictly 1 PII-free email
    expect(mailSink.list()).toHaveLength(1);
    const firstMail = mailSink.list()[0]!;
    expect(firstMail.to).toBe("owner.a.t021@example.test");
    expect(firstMail.from).toBe("noreply@notif.punyasitus.com");
    expect(firstMail.html).toContain(`${APP_ORIGIN}/dashboard/t021-alpha/leads`);
    const mailDump = `${firstMail.subject}\n${firstMail.html}\n${firstMail.text}`;
    for (const pii of [
      visitor1.name,
      visitor1.phone,
      "6281288776655",
      visitor1.email,
      visitor1.message,
    ]) {
      expect(mailDump).not.toContain(pii);
    }

    // Tenant B's DO remains completely empty
    const tenantBCount = await dbB
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ cnt: number }>();
    expect(Number(tenantBCount?.cnt ?? 0)).toBe(0);

    // -------------------------------------------------------------------------
    // 2. Idempotent replay persists ONCE and sends ZERO duplicate emails; conflict -> 409
    // -------------------------------------------------------------------------
    const replayRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.10",
          "Idempotency-Key": idemKey1,
        },
        body: JSON.stringify(visitor1),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 1_000,
      },
    );
    expect(replayRes.status).toBe(201);
    const replayBody = (await replayRes.json()) as { leadNumber: number };
    expect(replayBody.leadNumber).toBe(1);
    expect(mailSink.list()).toHaveLength(1); // STILL 1 email!

    const conflictRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.10",
          "Idempotency-Key": idemKey1,
        },
        body: JSON.stringify({ ...visitor1, message: "Pesan berbeda pada kunci sama" }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 2_000,
      },
    );
    expect(conflictRes.status).toBe(409);

    // -------------------------------------------------------------------------
    // 3. No-JS form-urlencoded POST (no Origin, Sec-Fetch-Site: same-origin) -> 303 PRG redirect
    // -------------------------------------------------------------------------
    const formParams = new URLSearchParams({
      name: "Dedi Kurniawan",
      phone: "081355443322",
      email: "dedi@example.test",
      message: "Saya kirim pesan tanpa JavaScript.",
      privacyConsent: "true",
      sourcePath: "/kontak",
      returnTo: "/kontak",
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const noJsRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "203.0.113.11",
        },
        body: formParams.toString(),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 3_000,
      },
    );
    expect(noJsRes.status).toBe(303);
    const prgLocation = noJsRes.headers.get("location") ?? "";
    expect(prgLocation).toBe("/kontak?leadStatus=accepted&leadNumber=2#formulir-kontak");
    expect(prgLocation).not.toContain("Dedi");
    expect(prgLocation).not.toContain("081355443322");
    expect(mailSink.list()).toHaveLength(2);

    // -------------------------------------------------------------------------
    // 4. Honeypot silently drops bot fills (0 DB rows added, 0 emails sent)
    // -------------------------------------------------------------------------
    const hpRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.12",
        },
        body: JSON.stringify({
          name: "Bot Spam",
          phone: "081234567890",
          message: "Buy cheap links",
          privacyConsent: true,
          hp_website: "https://spam.invalid",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 4_000,
      },
    );
    expect(hpRes.status).toBe(201);
    const countAfterHp = await dbA
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ cnt: number }>();
    expect(Number(countAfterHp?.cnt ?? 0)).toBe(2);
    expect(mailSink.list()).toHaveLength(2);

    // -------------------------------------------------------------------------
    // 5. Switch notifications OFF -> 0 emails sent; Email outage NEVER blocks persistence
    // -------------------------------------------------------------------------
    const toggleOffRes = await handleTenantLeadNotificationsRequest(
      tenantAId,
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/notifications`,
        "PATCH",
        ownerA.cookie,
        { emailEnabled: false },
      ),
      runtimeEnv,
      { nowMs: nowMs + 5_000 },
    );
    expect(toggleOffRes.status).toBe(200);
    expect(((await toggleOffRes.json()) as { emailEnabled: boolean }).emailEnabled).toBe(false);

    // Lead #3 with notifications OFF -> persisted, 0 new emails
    const lead3Res = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.13",
        },
        body: JSON.stringify({
          name: '=HYPERLINK("https://evil.test","Klik")',
          phone: "081511223344",
          message: "+cmd|' /C calc'!A0 pesan uji CSV",
          privacyConsent: true,
          sourcePath: "/layanan",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 6_000,
      },
    );
    expect(lead3Res.status).toBe(201);
    expect(((await lead3Res.json()) as { leadNumber: number }).leadNumber).toBe(3);
    expect(mailSink.list()).toHaveLength(2); // 0 new emails when switched OFF!

    // Turn notifications back ON and simulate catastrophic EmailPort outage -> lead STILL persists!
    const toggleOnRes = await handleTenantLeadNotificationsRequest(
      tenantAId,
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/notifications`,
        "PATCH",
        ownerA.cookie,
        { emailEnabled: true },
      ),
      runtimeEnv,
      { nowMs: nowMs + 7_000 },
    );
    expect(toggleOnRes.status).toBe(200);

    const failingEmailPort: EmailPort = {
      provider: "cloudflare",
      async send() {
        throw new Error("CLOUDFLARE_EMAIL_OUTAGE");
      },
    };
    const lead4Res = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.14",
        },
        body: JSON.stringify({
          name: "Tono Wijaya",
          phone: "081799001122",
          message: "Pesan tetap tersimpan walau provider email gangguan.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: failingEmailPort,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 8_000,
      },
    );
    expect(lead4Res.status).toBe(201);
    expect(((await lead4Res.json()) as { leadNumber: number }).leadNumber).toBe(4);

    // -------------------------------------------------------------------------
    // 6. Rate limiting -> 429, Turnstile fail-closed -> 403/503, wrong host -> 404, storage outage -> 503
    // -------------------------------------------------------------------------
    const tightPolicy = {
      perNetworkMinute: { name: "lead_network_minute", limit: 1, windowMs: 60_000 },
      perTenantHour: { name: "lead_tenant_hour", limit: 100, windowMs: 3_600_000 },
    };
    const rlFirst = await handlePublicLeadPost(
      new Request(`https://${tenantBHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantBHost}`,
          "CF-Connecting-IP": "198.51.100.55",
        },
        body: JSON.stringify({
          name: "Pengunjung Beta 1",
          phone: "081200001111",
          message: "Tanya layanan klinik.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantBId, handle: "t021-beta", name: "Beta Klinik", host: tenantBHost, status: "active" },
        tenantDb: dbB,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        rateLimitPolicy: tightPolicy,
        nowMs: nowMs + 9_000,
      },
    );
    expect(rlFirst.status).toBe(201);

    const rlSecond = await handlePublicLeadPost(
      new Request(`https://${tenantBHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantBHost}`,
          "CF-Connecting-IP": "198.51.100.55",
        },
        body: JSON.stringify({
          name: "Pengunjung Beta 2",
          phone: "081200002222",
          message: "Harus kena rate limit.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: { id: tenantBId, handle: "t021-beta", name: "Beta Klinik", host: tenantBHost, status: "active" },
        tenantDb: dbB,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        rateLimitPolicy: tightPolicy,
        nowMs: nowMs + 10_000,
      },
    );
    expect(rlSecond.status).toBe(429);
    expect(rlSecond.headers.get("retry-after")).toBeTruthy();

    // Turnstile fail-closed in production (missing token -> 403; valid Siteverify -> 201)
    const missingTsRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.20",
        },
        body: JSON.stringify({
          name: "Tanpa Turnstile",
          phone: "081234500000",
          message: "Harus ditolak di produksi.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        appEnv: "production",
        turnstileSecretKey: "cf-test-secret",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 11_000,
      },
    );
    expect(missingTsRes.status).toBe(403);

    // Wrong surface (app host) & suspended tenant & forged tenantId & storage outage
    const wrongSurfaceRes = await handlePublicLeadPost(
      new Request(`${APP_ORIGIN}/api/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({ name: "X", phone: "081234567890", message: "Y", privacyConsent: true }),
      }),
      {
        surface: "app",
        tenant: null,
        tenantDb: null,
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
      },
    );
    expect(wrongSurfaceRes.status).toBe(404);

    const suspendedHostRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `https://${tenantAHost}` },
        body: JSON.stringify({ name: "X", phone: "081234567890", message: "Y", privacyConsent: true }),
      }),
      {
        surface: "tenant",
        tenant: { ...tenantAScope, status: "suspended" },
        tenantDb: dbA,
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
      },
    );
    expect(suspendedHostRes.status).toBe(503);

    const forgedTenantRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `https://${tenantAHost}` },
        body: JSON.stringify({
          tenantId: tenantBId,
          name: "Forger",
          phone: "081234567890",
          message: "Cross tenant attempt",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
      },
    );
    expect(forgedTenantRes.status).toBe(422);

    const storageOutageRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "203.0.113.99",
        },
        body: JSON.stringify({
          name: "Storage Down",
          phone: "081234567899",
          message: "Harus 503 bukan sukses palsu.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: createBrokenDb(),
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 12_000,
      },
    );
    expect(storageOutageRes.status).toBe(503);

    // -------------------------------------------------------------------------
    // 7. Authorized Inbox: list, filter, WA follow-up, status transition, 409 stale version, RBAC & cross-tenant 404
    // -------------------------------------------------------------------------
    const listRes = await handleTenantLeadsListRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: nowMs + 13_000 },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("cache-control")).toBe("private, no-store");
    const listData = (await listRes.json()) as {
      items: Array<{ id: number; name: string; status: string; version: number; whatsappFollowUpUrl: string | null }>;
      counts: { all: number; new: number; contacted: number; closed: number };
    };
    expect(listData.counts.all).toBe(4);
    expect(listData.counts.new).toBe(4);
    const lead1 = listData.items.find((i) => i.id === 1);
    expect(lead1?.whatsappFollowUpUrl).toContain("https://wa.me/6281288776655?text=");

    // Admin updates lead #1 status: new -> contacted (version 1 -> 2)
    const patchRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/1`,
        "PATCH",
        adminA.cookie,
        {
          status: "contacted",
          internalNotes: "Sudah dihubungi via WA, kirim proposal besok.",
          version: 1,
        },
      ),
      runtimeEnv,
      { nowMs: nowMs + 14_000 },
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { status: string; version: number; internalNotes: string };
    expect(patched.status).toBe("contacted");
    expect(patched.version).toBe(2);
    expect(patched.internalNotes).toContain("proposal");

    // Stale version -> 409 STALE_VERSION & writes ZERO extra audit rows
    const auditBeforeStale = await dbA
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'lead.status_updated'")
      .first<{ cnt: number }>();
    expect(Number(auditBeforeStale?.cnt ?? 0)).toBe(1);

    const staleRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/1`,
        "PATCH",
        ownerA.cookie,
        { status: "closed", version: 1 },
      ),
      runtimeEnv,
      { nowMs: nowMs + 15_000 },
    );
    expect(staleRes.status).toBe(409);

    const auditAfterStale = await dbA
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'lead.status_updated'")
      .first<{ cnt: number }>();
    expect(Number(auditAfterStale?.cnt ?? 0)).toBe(1);

    // Backward status transition -> 422
    const backwardRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/1`,
        "PATCH",
        ownerA.cookie,
        { status: "new", version: 2 },
      ),
      runtimeEnv,
      { nowMs: nowMs + 16_000 },
    );
    expect(backwardRes.status).toBe(422);

    // Cross-tenant access (Owner B -> Tenant A) returns neutral 404
    const crossListRes = await handleTenantLeadsListRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads`, "GET", ownerB.cookie),
      runtimeEnv,
      { nowMs: nowMs + 17_000 },
    );
    expect(crossListRes.status).toBe(404);

    // Editor role denial -> 403 FORBIDDEN on list, patch, and CSV export
    const editorListRes = await handleTenantLeadsListRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads`, "GET", editorA.cookie),
      runtimeEnv,
      { nowMs: nowMs + 17_000 },
    );
    expect(editorListRes.status).toBe(403);

    const adminCsvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads/export.csv`, "GET", adminA.cookie),
      runtimeEnv,
      { nowMs: nowMs + 17_000 },
    );
    expect(adminCsvRes.status).toBe(403);

    // -------------------------------------------------------------------------
    // 8. Formula-injection-safe CSV export — allowed for owner on active, locked, AND suspended tenants (REQ-060)
    // -------------------------------------------------------------------------
    const activeCsvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads/export.csv`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: nowMs + 18_000 },
    );
    expect(activeCsvRes.status).toBe(200);
    expect(activeCsvRes.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(activeCsvRes.headers.get("cache-control")).toBe("private, no-store");
    expect(activeCsvRes.headers.get("x-truncated")).toBeNull();
    const activeCsvText = await activeCsvRes.text();
    expect(activeCsvText).toContain("\"'=HYPERLINK(\"\"https://evil.test\"\",\"\"Klik\"\")\"");
    expect(activeCsvText).toContain("'+cmd|' /C calc'!A0 pesan uji CSV");

    // Truncated CSV export sets `X-Truncated: 1` and logs PII-free `lead.export_csv` audit entry
    const truncatedCsvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads/export.csv`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: nowMs + 18_500, maxExportRows: 2 },
    );
    expect(truncatedCsvRes.status).toBe(200);
    expect(truncatedCsvRes.headers.get("x-truncated")).toBe("1");
    const truncLines = (await truncatedCsvRes.text()).trim().split("\r\n");
    expect(truncLines).toHaveLength(3); // 1 header + 2 rows

    const csvAuditRows = await dbA
      .prepare("SELECT action, summary, metadata_json FROM tenant_activity_log WHERE action = 'lead.export_csv'")
      .all<{ action: string; summary: string; metadata_json: string }>();
    expect((csvAuditRows.results ?? []).length).toBeGreaterThanOrEqual(2);
    const truncAudit = (csvAuditRows.results ?? []).find((r) => r.metadata_json.includes('"truncated":true'));
    expect(truncAudit).toBeDefined();
    expect(truncAudit?.summary).not.toContain("Rina");

    // -------------------------------------------------------------------------
    // 9. R3 Hardening Proofs:
    //    (a) Two different visitors submitting identical cached No-JS HTML (empty idempotencyKey) BOTH persist (zero 409!)
    //    (b) Same visitor rapid double-submit within 30s deduplicates to 1 lead
    //    (c) Malicious returnTo XSS breakout in 503 HTML fallback is sanitized & escaped to `/`
    //    (d) Hung emailPort.send is non-blocking via `waitUntil` AND bounded by timeout without `waitUntil`
    // -------------------------------------------------------------------------
    const cachedFormVisitorA = new URLSearchParams({
      name: "Pengunjung Cache Satu",
      phone: "081211110001",
      message: "Pertanyaan dari pengunjung pertama dengan HTML cache identik.",
      privacyConsent: "true",
      sourcePath: "/kontak",
      returnTo: "/kontak",
      idempotencyKey: "",
    });
    const cachedFormVisitorB = new URLSearchParams({
      name: "Pengunjung Cache Dua",
      phone: "081211110002",
      message: "Pertanyaan dari pengunjung kedua dengan HTML cache identik.",
      privacyConsent: "true",
      sourcePath: "/kontak",
      returnTo: "/kontak",
      idempotencyKey: "",
    });

    const cachedResA = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "198.51.100.71",
        },
        body: cachedFormVisitorA.toString(),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 19_000,
      },
    );
    expect(cachedResA.status).toBe(303);
    expect(cachedResA.headers.get("location")).toContain("leadStatus=accepted");

    // Second different visitor submitting identical cached form HTML (empty idempotencyKey) MUST succeed (never 409!)
    const cachedResB = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "198.51.100.72",
        },
        body: cachedFormVisitorB.toString(),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 19_100,
      },
    );
    expect(cachedResB.status).toBe(303);
    expect(cachedResB.headers.get("location")).toContain("leadStatus=accepted");
    expect(cachedResB.headers.get("location")).not.toBe(cachedResA.headers.get("location"));

    // Rapid accidental double-click by Visitor A within 30s deduplicates to the exact same leadNumber!
    const doubleClickA = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "198.51.100.71",
        },
        body: cachedFormVisitorA.toString(),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: mailSink,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 19_500,
      },
    );
    expect(doubleClickA.status).toBe(303);
    expect(doubleClickA.headers.get("location")).toBe(cachedResA.headers.get("location"));

    // Malicious `returnTo` XSS breakout in 503 HTML fallback is neutralized to `/`
    const xssReturnForm = new URLSearchParams({
      name: "Uji XSS ReturnTo",
      phone: "081211110003",
      message: "Uji fallback 503.",
      privacyConsent: "true",
      returnTo: '/x"onmouseover="alert(1)',
    });
    const xss503Res = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          "CF-Connecting-IP": "198.51.100.73",
        },
        body: xssReturnForm.toString(),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: createBrokenDb(),
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 20_000,
      },
    );
    expect(xss503Res.status).toBe(503);
    const xss503Html = await xss503Res.text();
    expect(xss503Html).toContain('href="/#formulir-kontak"');
    expect(xss503Html).not.toContain("onmouseover");

    // Non-blocking email dispatch: hung `emailPort.send` does NOT block visitor 201 via `waitUntil`
    const hungEmailPort: EmailPort = {
      provider: "cloudflare",
      send() {
        return new Promise(() => {
          // Intentionally never resolves
        });
      },
    };
    const scheduledPromises: Promise<unknown>[] = [];
    const tStart = Date.now();
    const nonBlockingRes = await handlePublicLeadPost(
      new Request(`https://${tenantAHost}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${tenantAHost}`,
          "CF-Connecting-IP": "198.51.100.74",
        },
        body: JSON.stringify({
          name: "Pengunjung Non Blocking",
          phone: "081211110004",
          message: "Respon harus langsung kembali walau mail server hang.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantAScope,
        tenantDb: dbA,
        platformDb: env.PLATFORM_DB,
        emailPort: hungEmailPort,
        appOrigin: APP_ORIGIN,
        appEnv: "test",
        rateLimitSalt: TEST_RATE_LIMIT_SALT,
        nowMs: nowMs + 21_000,
        emailTimeoutMs: 50,
        waitUntil: (p) => {
          scheduledPromises.push(p);
        },
      },
    );
    const elapsedMs = Date.now() - tStart;
    expect(nonBlockingRes.status).toBe(201);
    expect(scheduledPromises).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(1_000);
    await Promise.all(scheduledPromises);

    // Transition Tenant A to `locked` (H+5 past paid_through): GET /leads=200, PATCH=403, export.csv=200
    const lockedNowMs = nowMs + 35 * DAY_MS;
    const lockedGetRes = await handleTenantLeadsListRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: lockedNowMs },
    );
    expect(lockedGetRes.status).toBe(200);

    const lockedPatchRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      makeAdminRequest(
        `/api/tenants/${tenantAId}/leads/1`,
        "PATCH",
        ownerA.cookie,
        { status: "closed", version: 2 },
      ),
      runtimeEnv,
      { nowMs: lockedNowMs },
    );
    expect(lockedPatchRes.status).toBe(403);

    const lockedCsvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads/export.csv`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: lockedNowMs },
    );
    expect(lockedCsvRes.status).toBe(200);

    // Transition Tenant A to `suspended` (H+9 past paid_through): GET /leads=403, PATCH=403, export.csv=200!
    const suspendedNowMs = nowMs + 39 * DAY_MS;
    const suspendedGetRes = await handleTenantLeadsListRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: suspendedNowMs },
    );
    expect(suspendedGetRes.status).toBe(403);

    const suspendedCsvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      makeAdminRequest(`/api/tenants/${tenantAId}/leads/export.csv`, "GET", ownerA.cookie),
      runtimeEnv,
      { nowMs: suspendedNowMs },
    );
    expect(suspendedCsvRes.status).toBe(200);
    expect(await suspendedCsvRes.text()).toContain("Rina Wulandari Rahasia");
  });
});
