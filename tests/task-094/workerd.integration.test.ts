import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { ensureAbuseModerationSchema } from "@punyasitus/db/abuse/index";
import { ensureTenantActivityLogSchema } from "@punyasitus/db/activity-log/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { applyEmailClaimsMigration } from "@punyasitus/db/email/index";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import {
  handlePublicAbuseReportGet,
  handlePublicAbuseReportPost,
} from "../../apps/web/src/pages/api/abuse-report.ts";
import {
  handleConsoleAbuseDetailRequest,
  handleConsoleAbuseListRequest,
  handleConsoleAbuseModerateRequest,
  type ConsoleAbuseRuntimeEnv,
} from "../../apps/web/src/pages/api/console/abuse/_shared.ts";
import { handleTenantActivityLogRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/activity/index.ts";
import { handleTenantLeadDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/[leadId].ts";
import { handleTenantLeadsExportCsvRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/export.csv.ts";
import type { TenantLeadsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/_shared.ts";
import { createEmailQueueHandler } from "../../apps/web/src/worker/queues/email/handler.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_SECRET = "task094-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task094-console-auth-secret-fedcba9876543210fedcba987654";
const RATE_LIMIT_SALT = "task094-abuse-rate-limit-salt-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  const db = createTenantDb(openTenantStoreStub(ns, tenantId));
  await ensureTenantActivityLogSchema(db);
  return db;
}

function buildConsoleEnv(extra?: Partial<ConsoleAbuseRuntimeEnv>): ConsoleAbuseRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    ...extra,
  };
}

function buildAppEnv(extra?: Partial<TenantLeadsRuntimeEnv>): TenantLeadsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    ...extra,
  };
}

async function createAppUser(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const auth = createAuth(env.PLATFORM_DB, {
    baseURL: APP_ORIGIN,
    secret: APP_SECRET,
    surface: "app",
    trustedOrigins: [APP_ORIGIN],
    emailPort: createLocalMailSink(),
  });
  const res = await auth.handler(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
      body: JSON.stringify({ email, password: "Task094Password!2026", name }),
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

async function seedTenant(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status?: string;
  readonly ownerUserId: string;
  readonly adminUserId?: string;
  readonly editorUserId?: string;
  readonly nowMs: number;
}): Promise<D1Database> {
  const status = params.status ?? "active";
  const statements: D1PreparedStatement[] = [
    env.PLATFORM_DB.prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(params.orgId, params.name, params.handle, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      status,
      params.nowMs + 30 * DAY_MS,
      params.nowMs,
      params.nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
    ).bind(`${params.handle}.situsku.click`, params.tenantId, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      "INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(`mem_own_${params.tenantId}`, params.orgId, params.ownerUserId, params.nowMs),
  ];
  if (params.adminUserId) {
    statements.push(
      env.PLATFORM_DB.prepare(
        "INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      ).bind(`mem_adm_${params.tenantId}`, params.orgId, params.adminUserId, params.nowMs),
    );
  }
  if (params.editorUserId) {
    statements.push(
      env.PLATFORM_DB.prepare(
        "INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)",
      ).bind(`mem_edt_${params.tenantId}`, params.orgId, params.editorUserId, params.nowMs),
    );
  }
  await env.PLATFORM_DB.batch(statements);
  return openMigratedTenantDb(params.tenantId);
}

describe("TASK-094 workerd integration — Abuse Reporting, Console Moderation & Single-Lead Delete / Activity Log", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await applyEmailClaimsMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureAbuseModerationSchema(env.PLATFORM_DB);
  });

  it("enforces host isolation, Origin matrix, body cap, honeypot, Turnstile fail-closed, and fail-closed rate limiting on POST /api/abuse-report", async () => {
    const nowMs = Date.now();
    const owner = await createAppUser(`t094-pub-owner-${nowMs}@example.com`, "Pemilik Publik");
    const tenantId = `01J094PUB00000000000000001`;
    const handle = `t094-pub-${nowMs.toString(36).slice(-5)}`;
    const host = `${handle}.situsku.click`;
    const origin = `https://${host}`;

    await seedTenant({
      tenantId,
      orgId: `org_${tenantId}`,
      handle,
      name: "Toko Uji Publik",
      ownerUserId: owner.userId,
      nowMs,
    });

    const tenantScope = { id: tenantId, handle, name: "Toko Uji Publik", host, status: "active" as const };

    // 1. Non-tenant hosts receive neutral 404
    for (const surface of ["marketing", "app", "console", "unknown"] as const) {
      const nonTenantRes = await handlePublicAbuseReportPost(
        new Request(`${origin}/api/abuse-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            category: "spam",
            reportedPath: "/",
            description: "Percobaan laporan di host non-tenant.",
          }),
        }),
        {
          surface,
          tenant: null,
          platformDb: env.PLATFORM_DB,
          appEnv: "test",
          rateLimitSalt: RATE_LIMIT_SALT,
          nowMs,
        },
      );
      expect(nonTenantRes.status).toBe(404);
    }

    // 2. GET HTML renders accessible public form; GET JSON returns 405
    const getHtmlRes = handlePublicAbuseReportGet(
      new Request(`${origin}/api/abuse-report?path=/promo`, {
        method: "GET",
        headers: { Accept: "text/html" },
      }),
      { surface: "tenant", tenant: tenantScope, appEnv: "test" },
    );
    expect(getHtmlRes.status).toBe(200);
    const formHtml = await getHtmlRes.text();
    expect(formHtml).toContain("Laporkan Penyalahgunaan Situs");
    expect(formHtml).toContain('value="/promo"');

    const getJsonRes = handlePublicAbuseReportGet(
      new Request(`${origin}/api/abuse-report`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
      { surface: "tenant", tenant: tenantScope, appEnv: "test" },
    );
    expect(getJsonRes.status).toBe(405);

    // 3. Cross-origin, null origin, missing origin on JSON, forged tenantId, oversized body rejected
    const crossOriginRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({
          category: "scam",
          reportedPath: "/",
          description: "Cross origin report attempt.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(crossOriginRes.status).toBe(403);

    const forgedTenantRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          tenantId: "01JFORGED00000000000000000",
          category: "scam",
          reportedPath: "/",
          description: "Percobaan menyisipkan tenantId palsu.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(forgedTenantRes.status).toBe(422);

    const oversizedRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          category: "spam",
          reportedPath: "/",
          description: "x".repeat(20_000),
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(oversizedRes.status).toBe(413);

    // 4. Honeypot triggered -> silent 201 with ZERO DB write
    const hpRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          category: "spam",
          reportedPath: "/",
          description: "Bot mengisi kolom honeypot tersembunyi.",
          hp_website: "https://bot-spam.example",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(hpRes.status).toBe(201);
    const afterHpCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM abuse_reports WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .first<{ cnt: number }>();
    expect(Number(afterHpCount?.cnt ?? 0)).toBe(0);

    // 5. Turnstile fail-closed in production when secret missing (503) or token invalid (403)
    const missingSecretProd = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          category: "phishing",
          reportedPath: "/login-palsu",
          description: "Halaman phishing meniru portal perbankan.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "production",
        turnstileSecretKey: "",
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(missingSecretProd.status).toBe(503);

    const invalidTurnstile = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          category: "phishing",
          reportedPath: "/login-palsu",
          description: "Halaman phishing meniru portal perbankan.",
          turnstileToken: "bad-token",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "production",
        turnstileSecretKey: "test-secret",
        turnstileFetchFn: async () =>
          Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
      },
    );
    expect(invalidTurnstile.status).toBe(403);

    // 6. Fail-closed rate limit when salt missing -> 503
    const noSaltRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          category: "phishing",
          reportedPath: "/login-palsu",
          description: "Halaman phishing meniru portal perbankan.",
          turnstileToken: "good-token",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "production",
        turnstileSecretKey: "test-secret",
        turnstileFetchFn: async () =>
          Response.json({ success: true, action: "abuse_report", hostname: host }),
        rateLimitSalt: undefined,
        nowMs,
      },
    );
    expect(noSaltRes.status).toBe(503);

    // 7. Valid Turnstile-verified submission succeeds with zero enumeration/PII leakage
    const okRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": "203.0.113.44",
        },
        body: JSON.stringify({
          category: "phishing",
          reportedPath: "/login-palsu",
          description: "Halaman phishing meniru portal perbankan resmi.",
          reporterEmail: "pelapor@contoh.id",
          turnstileToken: "valid-token",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "production",
        turnstileSecretKey: "test-secret",
        turnstileFetchFn: async () =>
          Response.json({ success: true, action: "abuse_report", hostname: host }),
        rateLimitSalt: RATE_LIMIT_SALT,
        nowMs,
        rateLimitPolicy: {
          perNetworkMinute: { name: "abuse_network_minute", limit: 2, windowMs: 60_000 },
          perTenantHour: { name: "abuse_tenant_hour", limit: 10, windowMs: 3_600_000 },
        },
      },
    );
    expect(okRes.status).toBe(201);
    const okJson = (await okRes.json()) as Record<string, unknown>;
    expect(Object.keys(okJson).sort()).toEqual(["reportId", "status"]);
    expect(okJson.status).toBe("received");
    expect(JSON.stringify(okJson)).not.toContain("pelapor@contoh.id");
    expect(JSON.stringify(okJson)).not.toContain(tenantId);

    // 8. Rate limit exhaustion returns 429 + Retry-After
    const policy = {
      perNetworkMinute: { name: "abuse_network_minute", limit: 2, windowMs: 60_000 },
      perTenantHour: { name: "abuse_tenant_hour", limit: 10, windowMs: 3_600_000 },
    };
    const secondRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": "203.0.113.44",
        },
        body: JSON.stringify({
          category: "scam",
          reportedPath: "/promo-2",
          description: "Laporan kedua dari IP yang sama masih diizinkan.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        rateLimitPolicy: policy,
        nowMs,
      },
    );
    expect(secondRes.status).toBe(201);

    const thirdRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": "203.0.113.44",
        },
        body: JSON.stringify({
          category: "scam",
          reportedPath: "/promo-3",
          description: "Laporan ketiga dari IP yang sama harus dibatasi 429.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        rateLimitPolicy: policy,
        nowMs,
      },
    );
    expect(thirdRes.status).toBe(429);
    expect(Number(thirdRes.headers.get("Retry-After") ?? "0")).toBeGreaterThanOrEqual(1);

    // 9. Finding 7: Opportunistic pruning removes expired abuse_rate_limit_buckets rows
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO abuse_rate_limit_buckets (bucket_key, window_start, count, expires_at)
       VALUES ('abuse:expired-bucket-test', ?, 3, ?)`,
    )
      .bind(nowMs - 120_000, nowMs - 60_000)
      .run();

    const pruneTriggerRes = await handlePublicAbuseReportPost(
      new Request(`${origin}/api/abuse-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "CF-Connecting-IP": "198.51.100.77",
        },
        body: JSON.stringify({
          category: "spam",
          reportedPath: "/promo-prune",
          description: "Laporan valid dari IP lain yang memicu pembersihan bucket kedaluwarsa.",
        }),
      }),
      {
        surface: "tenant",
        tenant: tenantScope,
        platformDb: env.PLATFORM_DB,
        appEnv: "test",
        rateLimitSalt: RATE_LIMIT_SALT,
        rateLimitPolicy: policy,
        nowMs: nowMs + 1000,
      },
    );
    expect(pruneTriggerRes.status).toBe(201);
    const expiredRow = await env.PLATFORM_DB.prepare(
      "SELECT bucket_key FROM abuse_rate_limit_buckets WHERE bucket_key = 'abuse:expired-bucket-test'",
    ).first();
    expect(expiredRow).toBeNull();
  });

  it("enforces console host boundary, 2FA step-up, optimistic concurrency, atomic audit, immediate unpublish/suspend & owner email notice", async () => {
    const nowMs = Date.now();
    const consoleEnv = buildConsoleEnv();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: `t094-mod-op-${nowMs}@example.com`,
      password: "ModOperatorPassword!234",
      name: "Moderator Platform",
      nowMs,
    });

    const ownerEmail = `t094-mod-owner-${nowMs}@example.com`;
    const owner = await createAppUser(ownerEmail, "Pemilik Situs Moderasi");
    const tenantId = `01J094MOD00000000000000001`;
    const handle = `t094-mod-${nowMs.toString(36).slice(-5)}`;
    const host = `${handle}.situsku.click`;
    const origin = `https://${host}`;

    const tenantDb = await seedTenant({
      tenantId,
      orgId: `org_${tenantId}`,
      handle,
      name: "Toko Moderasi Uji",
      ownerUserId: owner.userId,
      nowMs,
    });

    // Seed a published page at `/promo-berbahaya` inside TenantStore
    await tenantDb
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, version, created_at, updated_at)
         VALUES (1, 'promo-berbahaya', 'Promo Berbahaya', 0, '[]', '[{"type":"hero"}]', 'published', ?, 1, ?, ?)`,
      )
      .bind(nowMs, nowMs, nowMs)
      .run();

    // Non-console host gets bare neutral 404
    const nonConsoleRes = await handleConsoleAbuseListRequest(
      new Request(`${APP_ORIGIN}/api/console/abuse`, {
        method: "GET",
        headers: { cookie: op.cookieHeader },
      }),
      consoleEnv,
    );
    expect(nonConsoleRes.status).toBe(404);
    expect(await nonConsoleRes.text()).toBe("Not Found");

    // Submit 3 abuse reports
    const reportIds: string[] = [];
    for (const [idx, pathVal] of ["/promo-berbahaya", "/halaman-2", "/halaman-3"].entries()) {
      const res = await handlePublicAbuseReportPost(
        new Request(`${origin}/api/abuse-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            category: idx === 0 ? "scam" : idx === 1 ? "spam" : "phishing",
            reportedPath: pathVal,
            description: `Laporan penyalahgunaan ke-${idx + 1} pada halaman ${pathVal}.`,
            reporterEmail: "pelapor-rahasia@example.com",
          }),
        }),
        {
          surface: "tenant",
          tenant: { id: tenantId, handle, name: "Toko Moderasi Uji", host, status: "active" },
          platformDb: env.PLATFORM_DB,
          appEnv: "test",
          rateLimitSalt: RATE_LIMIT_SALT,
          nowMs: nowMs + idx * 1000,
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { reportId: string };
      reportIds.push(body.reportId);
    }

    const [unpublishReportId, dismissReportId, suspendReportId] = reportIds as [string, string, string];

    // List queue as verified console operator
    const listRes = await handleConsoleAbuseListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse?status=open`, {
        method: "GET",
        headers: { cookie: op.cookieHeader },
      }),
      consoleEnv,
      { nowMs: nowMs + 5000 },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      items: Array<{ id: string; reporterContactMasked: string | null }>;
      counts: { open: number };
    };
    expect(listBody.counts.open).toBeGreaterThanOrEqual(3);
    const listedTarget = listBody.items.find((it) => it.id === unpublishReportId);
    expect(listedTarget).toBeDefined();
    expect(listedTarget?.reporterContactMasked).toBe("pe***@example.com");
    expect(JSON.stringify(listBody)).not.toContain("pelapor-rahasia@example.com");

    // Stale 2FA step-up (> 10 minutes) is rejected with 403 REAUTH_REQUIRED
    const stale2faRes = await handleConsoleAbuseModerateRequest(
      unpublishReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${unpublishReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Halaman melanggar kebijakan penipuan yang terverifikasi.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000 },
    );
    expect(stale2faRes.status).toBe(403);
    const stale2faJson = (await stale2faRes.json()) as { error: { code: string } };
    expect(stale2faJson.error.code).toBe("REAUTH_REQUIRED");

    // Stale expectedVersion returns 409 STALE_VERSION with ZERO audit rows
    const staleVerRes = await handleConsoleAbuseModerateRequest(
      unpublishReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${unpublishReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Versi lama tidak boleh memproses tindakan moderasi.",
          expectedVersion: 99,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 6000 },
    );
    expect(staleVerRes.status).toBe(409);

    // 1. UNPUBLISH action -> unpublishes `/promo-berbahaya` in TenantStore, bumps cache_version, audits & emails owner
    const mailSink = createLocalMailSink();
    const unpublishRes = await handleConsoleAbuseModerateRequest(
      unpublishReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${unpublishReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": `idem-unpub-${nowMs}`,
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Konten halaman promo terbukti mengandung klaim penipuan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      {
        nowMs: nowMs + 7000,
        emailPort: mailSink,
        resolveTenantDb: () => tenantDb,
      },
    );
    expect(unpublishRes.status).toBe(200);
    const unpublishJson = (await unpublishRes.json()) as {
      report: { status: string; version: number };
      unpublishTarget: { matched: boolean; resourceType: string };
      notificationSent: boolean;
      auditId: string;
    };
    expect(unpublishJson.report.status).toBe("resolved");
    expect(unpublishJson.report.version).toBe(2);
    expect(unpublishJson.unpublishTarget.matched).toBe(true);
    expect(unpublishJson.unpublishTarget.resourceType).toBe("page");
    expect(unpublishJson.notificationSent).toBe(true);

    // Verify page in TenantStore is now draft & published_sections_json cleared
    const pageRow = await tenantDb
      .prepare("SELECT status, published_sections_json FROM pages WHERE id = 1")
      .first<{ status: string; published_sections_json: string | null }>();
    expect(pageRow?.status).toBe("draft");
    expect(pageRow?.published_sections_json).toBeNull();

    // Verify owner email sent without reporter PII
    expect(mailSink.list()).toHaveLength(1);
    expect(mailSink.list()[0]?.to).toBe(ownerEmail);
    expect(mailSink.list()[0]?.text).not.toContain("pelapor-rahasia@example.com");

    // Idempotent replay does NOT emit duplicate audit or email
    const replayRes = await handleConsoleAbuseModerateRequest(
      unpublishReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${unpublishReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": `idem-unpub-${nowMs}`,
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Konten halaman promo terbukti mengandung klaim penipuan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 8000, emailPort: mailSink, resolveTenantDb: () => tenantDb },
    );
    expect(replayRes.status).toBe(200);
    const replayJson = (await replayRes.json()) as { replayed: boolean };
    expect(replayJson.replayed).toBe(true);
    expect(mailSink.list()).toHaveLength(1);

    // 2. DISMISS action -> report becomes dismissed, tenant stays active
    const dismissRes = await handleConsoleAbuseModerateRequest(
      dismissReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${dismissReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Hasil pemeriksaan menyatakan konten tidak melanggar ketentuan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 9000, emailPort: mailSink },
    );
    expect(dismissRes.status).toBe(200);
    const dismissJson = (await dismissRes.json()) as { report: { status: string } };
    expect(dismissJson.report.status).toBe("dismissed");

    // 3. SUSPEND action -> tenant immediately becomes suspended + operator_hold = 1 + cache_version bumped + audited
    const suspendRes = await handleConsoleAbuseModerateRequest(
      suspendReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${suspendReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "suspend",
          reason: "Situs terbukti melakukan phishing berulang dan wajib ditangguhkan segera.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 10_000, emailPort: mailSink, resolveTenantDb: () => tenantDb },
    );
    expect(suspendRes.status).toBe(200);
    const suspendJson = (await suspendRes.json()) as {
      tenantSuspended: boolean;
      report: { status: string; tenantStatus: string };
    };
    expect(suspendJson.tenantSuspended).toBe(true);
    expect(suspendJson.report.status).toBe("resolved");
    expect(suspendJson.report.tenantStatus).toBe("suspended");

    const tenantRow = await env.PLATFORM_DB.prepare(
      "SELECT status, operator_hold, cache_version FROM tenants WHERE id = ?",
    )
      .bind(tenantId)
      .first<{ status: string; operator_hold: number; cache_version: number }>();
    expect(tenantRow?.status).toBe("suspended");
    expect(tenantRow?.operator_hold).toBe(1);
    expect(Number(tenantRow?.cache_version ?? 0)).toBeGreaterThanOrEqual(3);

    // Verify immutable platform_audit captured all 3 moderation actions
    const auditEntries = await listPlatformAuditEntries(env.PLATFORM_DB, { tenantId, limit: 20 });
    const actions = auditEntries.map((a) => a.action);
    expect(actions).toContain("abuse_report.unpublish");
    expect(actions).toContain("abuse_report.dismiss");
    expect(actions).toContain("abuse_report.suspend");

    // Verify detail endpoint exposes action history & append-only trigger blocks DELETE
    const detailRes = await handleConsoleAbuseDetailRequest(
      suspendReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${suspendReportId}`, {
        method: "GET",
        headers: { cookie: op.cookieHeader },
      }),
      consoleEnv,
      { nowMs: nowMs + 11_000 },
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      report: { actions: Array<{ action: string; tenantNotified: boolean; notificationStatus: string }> };
    };
    expect(detailJson.report.actions).toHaveLength(1);
    expect(detailJson.report.actions[0]?.action).toBe("suspend");
    expect(detailJson.report.actions[0]?.tenantNotified).toBe(true);
    expect(detailJson.report.actions[0]?.notificationStatus).toBe("sent");

    // Verify suspend recorded authoritative deletion_due_at & retention_paused_at (Finding 2)
    const suspClock = await env.PLATFORM_DB.prepare(
      "SELECT deletion_due_at, retention_paused_at FROM tenants WHERE id = ?",
    )
      .bind(tenantId)
      .first<{ deletion_due_at: number | null; retention_paused_at: number | null }>();
    expect(suspClock?.deletion_due_at).not.toBeNull();
    expect(suspClock?.retention_paused_at).not.toBeNull();

    // Verify TenantStore moderation activity log rows NEVER expose internal platform operator userId (Finding 5)
    const modLogs = await tenantDb
      .prepare("SELECT actor_user_id, actor_role, action FROM tenant_activity_log WHERE actor_role = 'platform_operator'")
      .all<{ actor_user_id: string | null; actor_role: string; action: string }>();
    expect((modLogs.results ?? []).length).toBeGreaterThanOrEqual(2);
    for (const row of modLogs.results ?? []) {
      expect(row.actor_user_id).toBeNull();
    }

    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM abuse_moderation_actions WHERE report_id = ?")
        .bind(suspendReportId)
        .run(),
    ).rejects.toThrow(/append-only/i);
  });

  it("enforces R3 review invariants: unpublish fail-closed on missing/broken TenantStore or unmatched target, percent-encoded slug match, suspend lifecycle/offboarding guards, durable queue notice, and idempotency race resolution", async () => {
    const nowMs = Date.now();
    const consoleEnv = buildConsoleEnv();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });

    const op = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: `t094-r3-op-${nowMs}@example.com`,
      password: "R3ModOperatorPassword!234",
      name: "R3 Moderator",
      nowMs,
    });

    const ownerEmail = `t094-r3-owner-${nowMs}@example.com`;
    const owner = await createAppUser(ownerEmail, "Owner R3");
    const tenantId = `01J094R3T00000000000000001`;
    const handle = `t094-r3-${nowMs.toString(36).slice(-5)}`;
    const host = `${handle}.situsku.click`;
    const origin = `https://${host}`;

    const tenantDb = await seedTenant({
      tenantId,
      orgId: `org_${tenantId}`,
      handle,
      name: "Toko R3",
      ownerUserId: owner.userId,
      nowMs,
    });

    // Seed published blog post with slug `artikel-uji`
    await tenantDb
      .prepare(
        `INSERT INTO posts (id, slug, title, draft_body_json, published_body_json, status, published_at, version, created_at, updated_at)
         VALUES (1, 'artikel-uji', 'Artikel Uji', '{}', '{"type":"doc"}', 'published', ?, 1, ?, ?)`,
      )
      .bind(nowMs, nowMs, nowMs)
      .run();

    // Submit report for percent-encoded path `/blog/artikel%2Duji` and unmatched path `/tidak-ada`
    const makeReport = async (reportedPath: string): Promise<string> => {
      const res = await handlePublicAbuseReportPost(
        new Request(`${origin}/api/abuse-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            category: "scam",
            reportedPath,
            description: `Laporan pengujian R3 untuk jalur ${reportedPath}.`,
          }),
        }),
        {
          surface: "tenant",
          tenant: { id: tenantId, handle, name: "Toko R3", host, status: "active" },
          platformDb: env.PLATFORM_DB,
          appEnv: "test",
          rateLimitSalt: RATE_LIMIT_SALT,
          nowMs,
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { reportId: string }).reportId;
    };

    const encodedReportId = await makeReport("/blog/artikel%2Duji");
    const missingTargetReportId = await makeReport("/halaman-tidak-terbit");
    const offboardSuspendReportId = await makeReport("/");

    // Finding 1a: Missing TenantStore fails closed 503 TENANT_STORE_UNAVAILABLE (report stays open!)
    const noStoreRes = await handleConsoleAbuseModerateRequest(
      encodedReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${encodedReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Percobaan unpublish saat TenantStore tidak tersedia.",
          expectedVersion: 1,
        }),
      }),
      buildConsoleEnv({ TENANT_STORE: null }),
      { nowMs: nowMs + 1000, resolveTenantDb: () => null },
    );
    expect(noStoreRes.status).toBe(503);
    expect(((await noStoreRes.json()) as { error: { code: string } }).error.code).toBe(
      "TENANT_STORE_UNAVAILABLE",
    );

    // Finding 1b: Broken TenantStore error is NEVER swallowed -> 503 TENANT_STORE_UNAVAILABLE, report stays open
    const brokenTenantDb = {
      prepare: () => ({
        bind: () => ({
          first: () => Promise.reject(new Error("DO_UNAVAILABLE")),
          all: () => Promise.reject(new Error("DO_UNAVAILABLE")),
          run: () => Promise.reject(new Error("DO_UNAVAILABLE")),
        }),
      }),
      batch: () => Promise.reject(new Error("DO_UNAVAILABLE")),
    } as unknown as D1Database;

    const brokenStoreRes = await handleConsoleAbuseModerateRequest(
      encodedReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${encodedReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Percobaan unpublish saat TenantStore mengalami kegagalan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 1500, resolveTenantDb: () => brokenTenantDb },
    );
    expect(brokenStoreRes.status).toBe(503);

    // Finding 3a: Unmatched target path returns 422 TARGET_CONTENT_NOT_FOUND without resolving report
    const unmatchedRes = await handleConsoleAbuseModerateRequest(
      missingTargetReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${missingTargetReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Jalur target tidak memiliki konten terbit untuk dinonaktifkan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 2000, resolveTenantDb: () => tenantDb },
    );
    expect(unmatchedRes.status).toBe(422);
    expect(((await unmatchedRes.json()) as { error: { code: string } }).error.code).toBe(
      "TARGET_CONTENT_NOT_FOUND",
    );
    const stillOpen = await env.PLATFORM_DB.prepare("SELECT status FROM abuse_reports WHERE id = ?")
      .bind(missingTargetReportId)
      .first<{ status: string }>();
    expect(stillOpen?.status).toBe("open");

    // Finding 3b & 4 & 6: Percent-encoded `/blog/artikel%2Duji` unpublishes cleanly + queues durable job via JOBS_QUEUE + idempotent replay & conflict
    const queuedMessages: unknown[] = [];
    const idemKey = `r3-idem-${nowMs}`;
    const okUnpubRes = await handleConsoleAbuseModerateRequest(
      encodedReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${encodedReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Artikel mengandung klaim penipuan sehingga wajib dinonaktifkan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      {
        nowMs: nowMs + 3000,
        resolveTenantDb: () => tenantDb,
        jobsQueue: {
          send: async (msg) => {
            queuedMessages.push(msg);
          },
        },
      },
    );
    expect(okUnpubRes.status).toBe(200);
    const okUnpubJson = (await okUnpubRes.json()) as {
      unpublishTarget: { matched: boolean; resourceType: string; slug: string };
      notificationStatus: string;
      notificationJobKey: string | null;
      notificationSent: boolean;
    };
    expect(okUnpubJson.unpublishTarget.matched).toBe(true);
    expect(okUnpubJson.unpublishTarget.resourceType).toBe("post");
    expect(okUnpubJson.unpublishTarget.slug).toBe("artikel-uji");
    expect(okUnpubJson.notificationStatus).toBe("queued");
    expect(okUnpubJson.notificationSent).toBe(true);
    expect(okUnpubJson.notificationJobKey).toBe(`abuse-moderation:${encodedReportId}:unpublish`);
    expect(queuedMessages).toHaveLength(1);

    // Durable job_ledger row exists for the notification AND is 100% consumable by REAL `createEmailQueueHandler`!
    const ledgerRow = await env.PLATFORM_DB.prepare(
      "SELECT topic, status, payload_json FROM job_ledger WHERE idempotency_key = ?",
    )
      .bind(`abuse-moderation:${encodedReportId}:unpublish`)
      .first<{ topic: string; status: string; payload_json: string | null }>();
    expect(ledgerRow?.topic).toBe("email.transactional.send");
    expect(ledgerRow?.status).toBe("queued");
    expect(ledgerRow?.payload_json).toBeTruthy();

    const parsedQueued = JSON.parse(ledgerRow!.payload_json!) as Record<string, unknown>;
    expect(parsedQueued.template).toBe("abuse-moderation-notice");
    expect(parsedQueued.templateData).toBeTruthy();

    // Feed the exact queued message directly into REAL `createEmailQueueHandler` (zero E_INVALID_EMAIL_JOB_PAYLOAD!)
    const queueMailSink = createLocalMailSink();
    const emailQueueHandler = createEmailQueueHandler({
      emailPort: queueMailSink,
      now: () => nowMs + 3100,
    });
    const queuedEnvelope = queuedMessages[0] as {
      idempotencyKey: string;
      topic: string;
      tenantId: string | null;
      payload: Record<string, unknown>;
    };
    await emailQueueHandler.execute({
      idempotencyKey: queuedEnvelope.idempotencyKey,
      topic: queuedEnvelope.topic,
      tenantId: queuedEnvelope.tenantId,
      payload: queuedEnvelope.payload,
      attempt: 1,
      maxAttempts: 3,
      enqueuedAt: nowMs + 3000,
      nowMs: nowMs + 3100,
      correlationId: "req-r3-queue-test",
      env: { PLATFORM_DB: env.PLATFORM_DB },
    });
    expect(queueMailSink.list()).toHaveLength(1);
    expect(queueMailSink.list()[0]?.to).toBe(ownerEmail);
    expect(queueMailSink.list()[0]?.template).toBe("abuse-moderation-notice");
    expect(queueMailSink.list()[0]?.subject).toContain("dinonaktifkan oleh moderasi");
    expect(queueMailSink.list()[0]?.text).toContain(encodedReportId);

    // Finding 4b: When `jobsQueue.send` fails -> falls back to EmailPort (sent); if fallback also unavailable -> `failed` in API, job_ledger, abuse_moderation_actions & idempotent replay!
    const queueFallbackReportId = await makeReport("/queue-fallback-test");
    const fallbackIdemKey = `fallback-idem-${nowMs}`;
    const fallbackSink = createLocalMailSink();
    const fallbackRes = await handleConsoleAbuseModerateRequest(
      queueFallbackReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${queueFallbackReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": fallbackIdemKey,
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Pengujian fallback EmailPort saat pengiriman ke JOBS_QUEUE gagal.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      {
        nowMs: nowMs + 3200,
        jobsQueue: {
          send: () => Promise.reject(new Error("QUEUE_SEND_TRANSIENT_ERROR")),
        },
        emailPort: fallbackSink,
      },
    );
    expect(fallbackRes.status).toBe(200);
    const fallbackJson = (await fallbackRes.json()) as {
      notificationStatus: string;
      notificationSent: boolean;
      report: { actions: Array<{ notificationStatus: string; tenantNotified: boolean }> };
    };
    expect(fallbackJson.notificationStatus).toBe("sent");
    expect(fallbackJson.notificationSent).toBe(true);
    expect(fallbackJson.report.actions[0]?.notificationStatus).toBe("sent");
    expect(fallbackJson.report.actions[0]?.tenantNotified).toBe(true);
    expect(fallbackSink.list()).toHaveLength(1);

    // Idempotent replay of fallback-sent returns truthful `'sent'` / `true`
    const fallbackReplayRes = await handleConsoleAbuseModerateRequest(
      queueFallbackReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${queueFallbackReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": fallbackIdemKey,
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Pengujian fallback EmailPort saat pengiriman ke JOBS_QUEUE gagal.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 3250 },
    );
    expect(fallbackReplayRes.status).toBe(200);
    const fallbackReplayJson = (await fallbackReplayRes.json()) as {
      replayed: boolean;
      notificationStatus: string;
      notificationSent: boolean;
    };
    expect(fallbackReplayJson.replayed).toBe(true);
    expect(fallbackReplayJson.notificationStatus).toBe("sent");
    expect(fallbackReplayJson.notificationSent).toBe(true);

    const queueFailReportId = await makeReport("/queue-hard-fail-test");
    const failIdemKey = `hard-fail-idem-${nowMs}`;
    const queueFailRes = await handleConsoleAbuseModerateRequest(
      queueFailReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${queueFailReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": failIdemKey,
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Pengujian kegagalan total pengiriman notifikasi agar tercatat failed.",
          expectedVersion: 1,
        }),
      }),
      buildConsoleEnv({ APP_ENV: "production", EMAIL: undefined }),
      {
        nowMs: nowMs + 3300,
        jobsQueue: {
          send: () => Promise.reject(new Error("QUEUE_DOWN")),
        },
        emailPort: null,
      },
    );
    expect(queueFailRes.status).toBe(200);
    const queueFailJson = (await queueFailRes.json()) as {
      notificationStatus: string;
      notificationSent: boolean;
      notificationJobKey: string;
      report: { actions: Array<{ notificationStatus: string; tenantNotified: boolean }> };
    };
    expect(queueFailJson.notificationStatus).toBe("failed");
    expect(queueFailJson.notificationSent).toBe(false);
    expect(queueFailJson.report.actions[0]?.notificationStatus).toBe("failed");
    expect(queueFailJson.report.actions[0]?.tenantNotified).toBe(false);

    const failedJobRow = await env.PLATFORM_DB.prepare(
      "SELECT status, last_error_code FROM job_ledger WHERE idempotency_key = ?",
    )
      .bind(queueFailJson.notificationJobKey)
      .first<{ status: string; last_error_code: string | null }>();
    expect(failedJobRow?.status).toBe("failed");
    expect(failedJobRow?.last_error_code).toBe("E_QUEUE_SEND_FAILED");

    // Idempotent replay of hard-fail returns truthful `'failed'` / `false` (never `'queued'`!)
    const failReplayRes = await handleConsoleAbuseModerateRequest(
      queueFailReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${queueFailReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": failIdemKey,
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Pengujian kegagalan total pengiriman notifikasi agar tercatat failed.",
          expectedVersion: 1,
        }),
      }),
      buildConsoleEnv({ APP_ENV: "production", EMAIL: undefined }),
      { nowMs: nowMs + 3350 },
    );
    expect(failReplayRes.status).toBe(200);
    const failReplayJson = (await failReplayRes.json()) as {
      replayed: boolean;
      notificationStatus: string;
      notificationSent: boolean;
    };
    expect(failReplayJson.replayed).toBe(true);
    expect(failReplayJson.notificationStatus).toBe("failed");
    expect(failReplayJson.notificationSent).toBe(false);

    // Immutability trigger still blocks modifying reason/action/audit_id OR re-updating finalized notification_status
    await expect(
      env.PLATFORM_DB.prepare("UPDATE abuse_moderation_actions SET reason = 'tampered' WHERE report_id = ?")
        .bind(queueFailReportId)
        .run(),
    ).rejects.toThrow(/append-only/i);
    await expect(
      env.PLATFORM_DB.prepare(
        "UPDATE abuse_moderation_actions SET notification_status = 'sent', tenant_notified = 1 WHERE report_id = ?",
      )
        .bind(queueFailReportId)
        .run(),
    ).rejects.toThrow(/append-only/i);

    // Finding 6a: Replay with same Idempotency-Key & stale expectedVersion returns 200 replay (NOT 409 STALE_VERSION)
    const raceReplayRes = await handleConsoleAbuseModerateRequest(
      encodedReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${encodedReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify({
          action: "unpublish",
          reason: "Artikel mengandung klaim penipuan sehingga wajib dinonaktifkan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 3500, resolveTenantDb: () => tenantDb },
    );
    expect(raceReplayRes.status).toBe(200);
    expect(((await raceReplayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Finding 6b: Same Idempotency-Key with mismatched payload returns 409 IDEMPOTENCY_CONFLICT
    const conflictRes = await handleConsoleAbuseModerateRequest(
      encodedReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${encodedReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify({
          action: "dismiss",
          reason: "Parameter tindakan berbeda dengan kunci idempotensi yang sama.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 3600 },
    );
    expect(conflictRes.status).toBe(409);
    expect(((await conflictRes.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    // Finding 2: Suspend blocked with 409 TENANT_NOT_ELIGIBLE when tenant is offboarding/purging (report stays open, 0 audit rows!)
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'purging', offboarding_started_at = ? WHERE id = ?",
    )
      .bind(nowMs, tenantId)
      .run();

    const ineligibleRes = await handleConsoleAbuseModerateRequest(
      offboardSuspendReportId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/${offboardSuspendReportId}/moderate`, {
        method: "POST",
        headers: {
          cookie: op.cookieHeader,
          origin: CONSOLE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "suspend",
          reason: "Situs sedang dalam proses offboarding sehingga tidak boleh ditangguhkan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + 4000 },
    );
    expect(ineligibleRes.status).toBe(409);
    expect(((await ineligibleRes.json()) as { error: { code: string } }).error.code).toBe(
      "TENANT_NOT_ELIGIBLE",
    );
    const reportAfterIneligible = await env.PLATFORM_DB.prepare(
      "SELECT status FROM abuse_reports WHERE id = ?",
    )
      .bind(offboardSuspendReportId)
      .first<{ status: string }>();
    expect(reportAfterIneligible?.status).toBe("open");
  });

  it("enforces RBAC, isolation, lifecycle locks, PII-free atomic audit, and CSV removal on tenant single-lead delete & read-only activity log", async () => {
    const nowMs = Date.now();
    const appEnv = buildAppEnv();

    const ownerA = await createAppUser(`t094-own-a-${nowMs}@example.com`, "Owner A");
    const adminA = await createAppUser(`t094-adm-a-${nowMs}@example.com`, "Admin A");
    const editorA = await createAppUser(`t094-edt-a-${nowMs}@example.com`, "Editor A");
    const ownerB = await createAppUser(`t094-own-b-${nowMs}@example.com`, "Owner B");

    const tenantAId = `01J094TENA0000000000000001`;
    const tenantBId = `01J094TENB0000000000000002`;
    const handleA = `t094-a-${nowMs.toString(36).slice(-5)}`;
    const handleB = `t094-b-${nowMs.toString(36).slice(-5)}`;

    const tenantADb = await seedTenant({
      tenantId: tenantAId,
      orgId: `org_${tenantAId}`,
      handle: handleA,
      name: "Tenant A",
      ownerUserId: ownerA.userId,
      adminUserId: adminA.userId,
      editorUserId: editorA.userId,
      nowMs,
    });
    const tenantBDb = await seedTenant({
      tenantId: tenantBId,
      orgId: `org_${tenantBId}`,
      handle: handleB,
      name: "Tenant B",
      ownerUserId: ownerB.userId,
      nowMs,
    });

    // Seed 2 leads + lead_dedup in Tenant A
    await tenantADb.batch([
      tenantADb
        .prepare(
          `INSERT INTO leads (id, name, phone_e164, email, message, source_category, page_path, status, version, created_at, updated_at)
           VALUES (1, 'Budi Rahasia', '+6281234567890', 'budi.rahasia@example.com', 'Pesan pribadi sangat sensitif untuk dihapus', 'direct', '/kontak', 'new', 1, ?, ?)`,
        )
        .bind(nowMs, nowMs),
      tenantADb
        .prepare(
          `INSERT INTO lead_dedup (idempotency_key, payload_hash, lead_id, expires_at, created_at)
           VALUES ('idem-lead-1', 'hash-1', 1, ?, ?)`,
        )
        .bind(nowMs + DAY_MS, nowMs),
      tenantADb
        .prepare(
          `INSERT INTO leads (id, name, phone_e164, email, message, source_category, page_path, status, version, created_at, updated_at)
           VALUES (2, 'Siti Tetap Ada', '+6281999888777', 'siti@example.com', 'Pesan kedua tetap dipertahankan', 'direct', '/kontak', 'contacted', 1, ?, ?)`,
        )
        .bind(nowMs + 1000, nowMs + 1000),
    ]);

    const resolveDb = (id: string) => (id === tenantAId ? tenantADb : tenantBDb);

    // 1. Editor gets 403 FORBIDDEN on DELETE lead & GET activity log
    const editorDelRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/1`, {
        method: "DELETE",
        headers: {
          Cookie: editorA.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs },
    );
    expect(editorDelRes.status).toBe(403);

    const editorActRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity`, {
        method: "GET",
        headers: { Cookie: editorA.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs },
    );
    expect(editorActRes.status).toBe(403);

    // 2. Foreign tenant (Owner B) gets 404 NOT_FOUND on Tenant A DELETE & GET activity
    const foreignDelRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/1`, {
        method: "DELETE",
        headers: {
          Cookie: ownerB.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs },
    );
    expect(foreignDelRes.status).toBe(404);

    const foreignActRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity`, {
        method: "GET",
        headers: { Cookie: ownerB.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs },
    );
    expect(foreignActRes.status).toBe(404);

    // 3. Stale version on DELETE returns 409 STALE_VERSION without deleting
    const staleDelRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/1`, {
        method: "DELETE",
        headers: {
          Cookie: adminA.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 9 }),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs },
    );
    expect(staleDelRes.status).toBe(409);

    // 4. Admin permanently deletes Lead #1 -> 204 No Content
    const delRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "1",
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/1`, {
        method: "DELETE",
        headers: {
          Cookie: adminA.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 2000 },
    );
    expect(delRes.status).toBe(204);

    // Verify Lead #1 AND its lead_dedup row are completely gone
    const lead1 = await tenantADb.prepare("SELECT id FROM leads WHERE id = 1").first();
    const dedup1 = await tenantADb.prepare("SELECT lead_id FROM lead_dedup WHERE lead_id = 1").first();
    expect(lead1).toBeNull();
    expect(dedup1).toBeNull();

    // Verify CSV export no longer contains deleted Lead #1 PII, while Lead #2 remains
    const csvRes = await handleTenantLeadsExportCsvRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/export.csv`, {
        method: "GET",
        headers: { Cookie: ownerA.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 3000 },
    );
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).not.toContain("Budi Rahasia");
    expect(csvText).not.toContain("budi.rahasia@example.com");
    expect(csvText).toContain("Siti Tetap Ada");

    // 5. Read-only activity log shows `lead.deleted` with ZERO raw deleted PII
    const actRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity?resourceType=lead`, {
        method: "GET",
        headers: { Cookie: ownerA.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 4000 },
    );
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as {
      items: Array<{ action: string; resourceId: string | null; actorRole: string; summary: string }>;
    };
    const deletedLog = actBody.items.find((it) => it.action === "lead.deleted");
    expect(deletedLog).toBeDefined();
    expect(deletedLog?.resourceId).toBe("1");
    expect(deletedLog?.actorRole).toBe("admin");
    expect(JSON.stringify(actBody)).not.toContain("Budi Rahasia");
    expect(JSON.stringify(actBody)).not.toContain("+6281234567890");
    expect(JSON.stringify(actBody)).not.toContain("budi.rahasia@example.com");
    expect(JSON.stringify(actBody)).not.toContain("sangat sensitif");

    // 6. Activity log is strictly read-only (POST -> 405; UPDATE blocked by trigger)
    const postActRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity`, {
        method: "POST",
        headers: { Cookie: ownerA.cookie, Origin: APP_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 4500 },
    );
    expect(postActRes.status).toBe(405);

    await expect(
      tenantADb
        .prepare("UPDATE tenant_activity_log SET summary = 'tampered' WHERE action = 'lead.deleted'")
        .run(),
    ).rejects.toThrow(/immutable/i);

    // 7. Locked tenant (H+5 overdue) blocks DELETE lead (403 SUBSCRIPTION_LOCKED) while allowing read-only GET activity
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(nowMs - 5 * DAY_MS, tenantAId)
      .run();

    const lockedDelRes = await handleTenantLeadDetailRequest(
      tenantAId,
      "2",
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/leads/2`, {
        method: "DELETE",
        headers: {
          Cookie: ownerA.cookie,
          Origin: APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 1 }),
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 5000 },
    );
    expect(lockedDelRes.status).toBe(403);
    const lockedDelJson = (await lockedDelRes.json()) as { error: { code: string } };
    expect(lockedDelJson.error.code).toBe("SUBSCRIPTION_LOCKED");

    const lockedActRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity`, {
        method: "GET",
        headers: { Cookie: ownerA.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 5100 },
    );
    expect(lockedActRes.status).toBe(200);

    // 8. Suspended tenant (H+10 overdue / operator hold) blocks both DELETE lead and GET activity (403 SUBSCRIPTION_LOCKED)
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'suspended', paid_through = ?, operator_hold = 1 WHERE id = ?",
    )
      .bind(nowMs - 10 * DAY_MS, tenantAId)
      .run();

    const suspActRes = await handleTenantActivityLogRequest(
      tenantAId,
      new Request(`${APP_ORIGIN}/api/tenants/${tenantAId}/activity`, {
        method: "GET",
        headers: { Cookie: ownerA.cookie },
      }),
      appEnv,
      { resolveTenantDb: resolveDb, nowMs: nowMs + 5200 },
    );
    expect(suspActRes.status).toBe(403);
  });
});
