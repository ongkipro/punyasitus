import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import { INSIGHTS_ESTIMATE_LABEL_ID } from "@punyasitus/core/analytics/insights";
import {
  applyTenantInsightsMigrations,
  DEFAULT_EVENT_DEDUP_TTL_MS,
  getTenantInsightsSummary,
  OVERFLOW_CONTENT_PATH,
  OVERFLOW_UTM_SOURCE,
  recordFirstPartyEvent,
} from "@punyasitus/db/analytics/index";
import {
  createTenantDb,
  openTenantStoreStub,
  splitMigrationStatements,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { handlePublicEventPost } from "../../apps/web/src/pages/api/events.ts";
import { handleInsightsApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/insights/api.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const TEST_SALT = "workerd-task-072-insights-salt";
const TEST_AUTH_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 2, 15, 0); // 2026-11-23 02:15 UTC = 09:15 WIB = 10:15 WITA = 11:15 WIT
const MIDNIGHT_WRAP_MS = Date.UTC(2026, 10, 22, 17, 30, 0); // 2026-11-22 17:30 UTC = 2026-11-23 00:30 WIB / 01:30 WITA / 02:30 WIT
const HUMAN_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function migratePlatformDb(): Promise<void> {
  const statements = splitMigrationStatements(PLATFORM_MIGRATIONS[0]!.sql);
  for (const stmt of statements) {
    await env.PLATFORM_DB.prepare(stmt).run();
  }
}

async function openInsightsTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, async (_instance, state) => {
    const first = await applyTenantInsightsMigrations(state.storage as unknown as StorageLike);
    // Re-run idempotently to verify 0022 skips cleanly on second pass
    const second = await applyTenantInsightsMigrations(state.storage as unknown as StorageLike);
    if (second.applied.length !== 0) {
      throw new Error(`Expected idempotent 0022 re-run, got applied=${second.applied.join(",")}`);
    }
    return first;
  });
  const stub = openTenantStoreStub(ns, tenantId);
  return createTenantDb(stub);
}

async function seedTenantSiteAndContent(db: D1Database, nowMs: number, timeZone = "Asia/Jakarta"): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO site_settings (id, site_title, timezone, locale, active_theme_id, updated_at)
       VALUES (1, 'Alpha Studio', ?, 'id-ID', 'compro', ?)`,
    )
    .bind(timeZone, nowMs)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO pages (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, created_at, updated_at)
       VALUES (1, 'beranda', 'Beranda Utama', 1, '[]', '[]', 'published', ?, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO posts (id, slug, title, draft_body_json, published_body_json, status, published_at, created_at, updated_at)
       VALUES (10, 'panduan-seo-umkm', 'Panduan SEO UMKM', '{}', '{}', 'published', ?, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO offerings (id, offering_type, slug, title, status, published_at, created_at, updated_at)
       VALUES (100, 'service', 'konsultasi-seo', 'Konsultasi SEO', 'published', ?, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs)
    .run();
}

function makeEventRequest(
  host: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const origin = `https://${host}`;
  return new Request(`${origin}/api/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "user-agent": HUMAN_CHROME_UA,
      "cf-connecting-ip": "203.0.113.72",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("TASK-072 workerd integration — First-Party Insights aggregates, timezone re-projection, bot drop & tenant isolation", () => {
  beforeAll(async () => {
    await migratePlatformDb();
  });

  it("classifies search/social/UTM/referral/direct, preserves same-site arrival source, aggregates per-content & hourly, and stores zero PII", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t072-full`;
    const db = await openInsightsTenantDb(tenantId);
    await seedTenantSiteAndContent(db, BASE_NOW_MS, "Asia/Jakarta");

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    const events: Array<{ body: Record<string, unknown>; nowMs?: number }> = [
      // 1. Search arrival on homepage (UTC 02:15 -> 09:15 WIB)
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000001",
          eventName: "page_view",
          path: "/",
          resourceType: "page",
          resourceId: 1,
          referrerHost: "www.google.co.id",
        },
      },
      // 2. Same-site follow-up click to offering preserving arrival source (`sourceCategory: "search"`, same-site referrerHost stripped)
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000002",
          eventName: "page_view",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
          sourceCategory: "search",
          referrerHost: tenant.subdomainHost,
        },
      },
      // 3. WhatsApp click on offering from same search visit
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000003",
          eventName: "wa_click",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
          sourceCategory: "search",
        },
      },
      // 4. Social arrival on blog post
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000004",
          eventName: "page_view",
          path: "/blog/panduan-seo-umkm",
          resourceType: "post",
          resourceId: 10,
          referrerHost: "l.instagram.com",
        },
      },
      // 5. UTM campaign arrival + external click on offering
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000005",
          eventName: "page_view",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
          utmSource: "promo_ramadan",
          utmMedium: "cpc",
        },
      },
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000006",
          eventName: "external_click",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
          utmSource: "promo_ramadan",
          utmMedium: "cpc",
        },
      },
      // 6. Direct visit at UTC 17:30 (2026-11-23 00:30 WIB / 01:30 WITA / 02:30 WIT)
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000007",
          eventName: "lead_submitted",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
        },
        nowMs: MIDNIGHT_WRAP_MS,
      },
      // 7. External referral on blog post
      {
        body: {
          eventId: "72000000-0000-4000-8000-000000000008",
          eventName: "page_view",
          path: "/blog/panduan-seo-umkm",
          resourceType: "post",
          resourceId: 10,
          referrerHost: "portal-umkm.id",
        },
      },
    ];

    for (const ev of events) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, ev.body),
        { ...deps, nowMs: ev.nowMs ?? BASE_NOW_MS },
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toBeNull();
    }

    // Read insights in Asia/Jakarta (WIB, UTC+7)
    const wibInsights = await getTenantInsightsSummary(db, {
      days: 7,
      nowMs: BASE_NOW_MS,
    });

    expect(wibInsights.hasAnyData).toBe(true);
    expect(wibInsights.timeZone).toBe("Asia/Jakarta");
    expect(wibInsights.estimateLabel).toBe(INSIGHTS_ESTIMATE_LABEL_ID);

    // Popular items ranked: offering (5 events) > post (2 events) > page (1 event)
    expect(wibInsights.popularItems.map((i) => ({ path: i.path, title: i.title, kind: i.contentKind, total: i.totalActivity }))).toEqual([
      { path: "/layanan/konsultasi-seo", title: "Konsultasi SEO", kind: "offering", total: 5 },
      { path: "/blog/panduan-seo-umkm", title: "Panduan SEO UMKM", kind: "post", total: 2 },
      { path: "/", title: "Beranda Utama", kind: "page", total: 1 },
    ]);

    // Source breakdown matches exact counts across search, social, campaign, referral, direct
    const bySource = Object.fromEntries(wibInsights.sources.map((s) => [s.bucket, s.totalActivity]));
    expect(bySource.search).toBe(3); // landing + same-site follow-up + WA click
    expect(bySource.social).toBe(1);
    expect(bySource.campaign).toBe(2);
    expect(bySource.referral).toBe(1);
    expect(bySource.direct).toBe(1);
    expect(wibInsights.utmCampaigns).toEqual([
      {
        utmSource: "promo_ramadan",
        pageViews: 1,
        waClicks: 0,
        externalClicks: 1,
        leadSubmits: 0,
        totalActivity: 2,
      },
    ]);

    // Peak hours in WIB (UTC+7): 7 events at UTC 02 -> 09:00 WIB; 1 event at UTC 17 -> 00:00 WIB
    expect(wibInsights.peakHours.peakHour?.hour).toBe(9);
    expect(wibInsights.peakHours.peakHour?.totalActivity).toBe(7);
    expect(wibInsights.peakHours.hours[0]?.totalActivity).toBe(1);

    // Capture raw stored UTC rows BEFORE timezone change
    const rawHourlyBefore = await db
      .prepare("SELECT day_utc, utc_hour, page_views, wa_clicks, external_clicks, lead_submits FROM analytics_hourly_utc ORDER BY day_utc ASC, utc_hour ASC")
      .all();

    // Change tenant timezone to Asia/Makassar (WITA, UTC+8) -> re-projects immediately WITHOUT rewriting rows!
    await db.prepare("UPDATE site_settings SET timezone = 'Asia/Makassar' WHERE id = 1").run();
    const witaInsights = await getTenantInsightsSummary(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(witaInsights.timeZone).toBe("Asia/Makassar");
    expect(witaInsights.peakHours.peakHour?.hour).toBe(10);
    expect(witaInsights.peakHours.peakHour?.label).toBe("10:00");
    expect(witaInsights.peakHours.hours[1]?.totalActivity).toBe(1);

    // Change tenant timezone to Asia/Jayapura (WIT, UTC+9) -> re-projects immediately WITHOUT rewriting rows!
    await db.prepare("UPDATE site_settings SET timezone = 'Asia/Jayapura' WHERE id = 1").run();
    const witInsights = await getTenantInsightsSummary(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(witInsights.timeZone).toBe("Asia/Jayapura");
    expect(witInsights.peakHours.peakHour?.hour).toBe(11);
    expect(witInsights.peakHours.peakHour?.label).toBe("11:00");
    expect(witInsights.peakHours.hours[2]?.totalActivity).toBe(1);

    // Prove stored UTC hourly rows were NEVER mutated
    const rawHourlyAfter = await db
      .prepare("SELECT day_utc, utc_hour, page_views, wa_clicks, external_clicks, lead_submits FROM analytics_hourly_utc ORDER BY day_utc ASC, utc_hour ASC")
      .all();
    expect(rawHourlyAfter.results).toEqual(rawHourlyBefore.results);

    // Prove ZERO PII / request identifiers exist in any stored analytics row
    for (const table of [
      "analytics_daily",
      "analytics_content_daily",
      "analytics_hourly_utc",
      "analytics_sources_daily",
      "analytics_hourly_sources",
      "analytics_event_dedup",
    ]) {
      const cols = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const colNames = (cols.results ?? []).map((c) => c.name.toLowerCase());
      for (const forbidden of [
        "ip",
        "ip_address",
        "user_agent",
        "cookie",
        "visitor_id",
        "session_id",
        "email",
        "phone",
        "referrer_url",
      ]) {
        expect(colNames, `${table} must not have column ${forbidden}`).not.toContain(forbidden);
      }
      const rows = await db.prepare(`SELECT * FROM ${table}`).all();
      const serialized = JSON.stringify(rows.results ?? []);
      expect(serialized, `${table} must never store client IP`).not.toContain("203.0.113.72");
      expect(serialized, `${table} must never store User-Agent`).not.toContain("Chrome/131");
    }
  });

  it("quietly drops bot User-Agents with 204 and enforces exact 24-hour dedup expiry across all insights tables", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t072-bot-dedup`;
    const db = await openInsightsTenantDb(tenantId);
    await seedTenantSiteAndContent(db, BASE_NOW_MS);

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    // Bot UAs -> ALL return 204 quietly and write ZERO rows!
    for (const botUa of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "curl/8.5.0",
      "Mozilla/5.0 HeadlessChrome/131.0.0.0",
      "GPTBot/1.0",
    ]) {
      const res = await handlePublicEventPost(
        makeEventRequest(
          tenant.subdomainHost,
          {
            eventId: crypto.randomUUID(),
            eventName: "page_view",
            path: "/layanan/konsultasi-seo",
            referrerHost: "www.google.com",
          },
          { "user-agent": botUa },
        ),
        deps,
      );
      expect(res.status, `bot=${botUa}`).toBe(204);
    }

    const afterBots = await getTenantInsightsSummary(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(afterBots.hasAnyData).toBe(false);
    expect(afterBots.totals.totalActivity).toBe(0);

    // Dedup 24h TTL across all insights tables:
    const sharedEventId = "72000000-0000-4000-8000-0000000000aa";
    const first = await recordFirstPartyEvent(
      db,
      {
        eventId: sharedEventId,
        eventName: "page_view",
        path: "/layanan/konsultasi-seo",
        resourceType: "offering",
        resourceId: 100,
        referrerHost: "www.google.com",
      },
      { nowMs: BASE_NOW_MS, siteHost: tenant.subdomainHost },
    );
    expect(first).toMatchObject({ ok: true, recorded: true, deduplicated: false });

    // Duplicate 1ms before 24h expiry -> deduplicated across ALL insights tables (count stays 1)
    const beforeExpiry = await recordFirstPartyEvent(
      db,
      {
        eventId: sharedEventId,
        eventName: "page_view",
        path: "/layanan/konsultasi-seo",
        resourceType: "offering",
        resourceId: 100,
        referrerHost: "www.google.com",
      },
      { nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS - 1, siteHost: tenant.subdomainHost },
    );
    expect(beforeExpiry).toMatchObject({ ok: true, recorded: false, deduplicated: true });

    const beforeExpirySummary = await getTenantInsightsSummary(db, {
      days: 7,
      nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS - 1,
    });
    expect(beforeExpirySummary.totals.pageViews).toBe(1);
    expect(beforeExpirySummary.peakHours.peakHour?.totalActivity).toBe(1);

    // Replay AT exact 24h expiry -> expired dedup key removed & counted once more (count becomes 2)
    const atExpiry = await recordFirstPartyEvent(
      db,
      {
        eventId: sharedEventId,
        eventName: "page_view",
        path: "/layanan/konsultasi-seo",
        resourceType: "offering",
        resourceId: 100,
        referrerHost: "www.google.com",
      },
      { nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS, siteHost: tenant.subdomainHost },
    );
    expect(atExpiry).toMatchObject({ ok: true, recorded: true, deduplicated: false });

    const afterExpirySummary = await getTenantInsightsSummary(db, {
      days: 7,
      nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS,
    });
    expect(afterExpirySummary.totals.pageViews).toBe(2);
    expect(afterExpirySummary.peakHours.peakHour?.totalActivity).toBe(2);
  });

  it("enforces strict tenant isolation on /dashboard/[handle]/insights/api (allows editor/owner, denies cross-tenant & unauthenticated)", async () => {
    const nowMs = Date.now();
    const tenantA = SYNTHETIC_TENANTS[0];
    const tenantB = SYNTHETIC_TENANTS[1];
    const dbA = await openInsightsTenantDb(tenantA.id);
    const dbB = await openInsightsTenantDb(tenantB.id);
    await seedTenantSiteAndContent(dbA, nowMs, "Asia/Jakarta");
    await seedTenantSiteAndContent(dbB, nowMs, "Asia/Makassar");

    await recordFirstPartyEvent(
      dbA,
      {
        eventId: "72000000-0000-4000-8000-0000000000bb",
        eventName: "page_view",
        path: "/layanan/konsultasi-seo",
        referrerHost: "www.google.com",
      },
      { nowMs, siteHost: tenantA.subdomainHost },
    );

    // Seed orgs + tenants in PLATFORM_DB
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind("org_t072_a", "Alpha Studio", tenantA.handle, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind("org_t072_b", "Beta Klinik", tenantB.handle, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, 1, 1, 1, ?, ?)`,
      ).bind(tenantA.id, "org_t072_a", tenantA.handle, "Alpha Studio", nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'sales', 'active', 0, 1, 1, 1, ?, ?)`,
      ).bind(tenantB.id, "org_t072_b", tenantB.handle, "Beta Klinik", nowMs, nowMs),
    ]);

    // Sign up an editor user of Tenant A via Better Auth
    const appOrigin = "https://app.punyasitus.com";
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: appOrigin,
      secret: TEST_AUTH_SECRET,
      surface: "app",
      trustedOrigins: [appOrigin],
    });
    const editorEmail = `editor.t072.${nowMs}@example.test`;
    const signUpRes = await auth.handler(
      new Request(`${appOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: appOrigin,
        },
        body: JSON.stringify({
          email: editorEmail,
          password: "EditorPassword!123",
          name: "Editor Alpha T072",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const setCookie = signUpRes.headers.get("set-cookie") ?? "";
    const cookieHeader = setCookie.split(";")[0] ?? "";
    const signUpBody = (await signUpRes.json()) as { user?: { id?: string } };
    const editorUserId = signUpBody.user?.id ?? "";
    expect(editorUserId.length).toBeGreaterThan(0);

    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, 'org_t072_a', ?, 'editor', ?)`,
    )
      .bind(`mem_t072_${nowMs}`, editorUserId, nowMs)
      .run();

    const runtimeEnv = {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      APP_AUTH_SECRET: TEST_AUTH_SECRET,
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    };

    // 1. Unauthenticated -> 401
    const unauthRes = await handleInsightsApiRequest(
      tenantA.handle,
      new Request(`${appOrigin}/dashboard/${tenantA.handle}/insights/api`, { method: "GET" }),
      runtimeEnv,
      { tenantDb: dbA, nowMs },
    );
    expect(unauthRes.status).toBe(401);

    // 2. Editor of Tenant A reading Tenant A -> 200 OK with insights data
    const okRes = await handleInsightsApiRequest(
      tenantA.handle,
      new Request(`${appOrigin}/dashboard/${tenantA.handle}/insights/api?range=7`, {
        method: "GET",
        headers: { cookie: cookieHeader },
      }),
      runtimeEnv,
      { tenantDb: dbA, nowMs },
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      success: boolean;
      role: string;
      insights: { totals: { pageViews: number }; estimateLabel: string };
    };
    expect(okBody.success).toBe(true);
    expect(okBody.role).toBe("editor");
    expect(okBody.insights.totals.pageViews).toBe(1);
    expect(okBody.insights.estimateLabel).toBe(INSIGHTS_ESTIMATE_LABEL_ID);

    // 3. Editor of Tenant A attempting cross-tenant read of Tenant B -> 404 NOT_FOUND
    const crossTenantRes = await handleInsightsApiRequest(
      tenantB.handle,
      new Request(`${appOrigin}/dashboard/${tenantB.handle}/insights/api?range=7`, {
        method: "GET",
        headers: { cookie: cookieHeader },
      }),
      runtimeEnv,
      { tenantDb: dbB, nowMs },
    );
    expect(crossTenantRes.status).toBe(404);

    // 4. Tenant host attempting to access insights API -> 404
    const wrongSurfaceRes = await handleInsightsApiRequest(
      tenantA.handle,
      new Request(`https://${tenantA.subdomainHost}/dashboard/${tenantA.handle}/insights/api`, {
        method: "GET",
        headers: { cookie: cookieHeader },
      }),
      runtimeEnv,
      { tenantDb: dbA, nowMs },
    );
    expect(wrongSurfaceRes.status).toBe(404);

    // 5. Suspended tenant lifecycle gate -> 403 SUBSCRIPTION_LOCKED on /dashboard/[handle]/insights/api
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?")
      .bind(tenantA.id)
      .run();
    const suspendedRes = await handleInsightsApiRequest(
      tenantA.handle,
      new Request(`${appOrigin}/dashboard/${tenantA.handle}/insights/api?range=7`, {
        method: "GET",
        headers: { cookie: cookieHeader },
      }),
      runtimeEnv,
      { tenantDb: dbA, nowMs },
    );
    expect(suspendedRes.status).toBe(403);
    const suspendedBody = (await suspendedRes.json()) as { code?: string };
    expect(suspendedBody.code).toBe("SUBSCRIPTION_LOCKED");
    // Restore active status cleanly
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'active' WHERE id = ?")
      .bind(tenantA.id)
      .run();
  });

  it("caps daily path & utm_source cardinality into overflow buckets and prunes >90-day rows in bounded batches", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t072-cardinality`;
    const db = await openInsightsTenantDb(tenantId);
    await seedTenantSiteAndContent(db, BASE_NOW_MS, "Asia/Jakarta");

    // 1. Seed stale rows (>90 days old: 2026-06-01) in all 3 insights aggregate tables
    await db.batch([
      db
        .prepare(
          `INSERT INTO analytics_content_daily (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-06-01', 'page', 0, '/arsip-lama', 12, 0, 0, 0, ?)`,
        )
        .bind(BASE_NOW_MS - 120 * 86_400_000),
      db
        .prepare(
          `INSERT INTO analytics_hourly_utc (day_utc, utc_hour, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-06-01', 4, 12, 0, 0, 0, ?)`,
        )
        .bind(BASE_NOW_MS - 120 * 86_400_000),
      db
        .prepare(
          `INSERT INTO analytics_sources_daily (day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-06-01', 'search', '', 12, 0, 0, 0, ?)`,
        )
        .bind(BASE_NOW_MS - 120 * 86_400_000),
    ]);

    // 2. Cap distinct daily paths at 3 and distinct daily utm_sources at 2; send 5 distinct paths & 4 distinct UTM campaigns
    const paths = ["/p-1", "/p-2", "/p-3", "/p-4-overflow", "/p-5-overflow"];
    const utms = ["camp_alpha", "camp_beta", "camp_gamma_ovf", "camp_delta_ovf"];
    for (let i = 0; i < paths.length; i += 1) {
      const utm = utms[i % utms.length];
      const rec = await recordFirstPartyEvent(
        db,
        {
          eventId: `72000000-0000-4000-8000-00000000c00${i + 1}`,
          eventName: "page_view",
          path: paths[i]!,
          utmSource: utm,
        },
        {
          nowMs: BASE_NOW_MS,
          siteHost: tenant.subdomainHost,
          maxDailyContentPaths: 3,
          maxDailyUtmSources: 2,
          insightsRetentionDays: 90,
          insightsPruneBatchSize: 100,
        },
      );
      expect(rec).toMatchObject({ ok: true, recorded: true });
    }

    // Verify path cardinality capped: 3 normal paths + 1 `/_other` overflow bucket holding count = 2
    const contentRows = await db
      .prepare("SELECT path, content_kind, content_id, page_views FROM analytics_content_daily ORDER BY path ASC")
      .all<{ path: string; content_kind: string; content_id: number; page_views: number }>();
    expect(contentRows.results).toHaveLength(4);
    const overflowPathRow = contentRows.results.find((r) => r.path === OVERFLOW_CONTENT_PATH);
    expect(overflowPathRow).toEqual({
      path: "/_other",
      content_kind: "other",
      content_id: 0,
      page_views: 2,
    });

    // Verify utm_source cardinality capped: 2 normal UTMs + 1 `_other` overflow bucket holding count = 2
    const sourceRows = await db
      .prepare("SELECT utm_source, page_views FROM analytics_sources_daily ORDER BY utm_source ASC")
      .all<{ utm_source: string; page_views: number }>();
    expect(sourceRows.results).toHaveLength(3);
    const overflowUtmRow = sourceRows.results.find((r) => r.utm_source === OVERFLOW_UTM_SOURCE);
    expect(overflowUtmRow).toEqual({
      utm_source: "_other",
      page_views: 2,
    });

    // Verify >90-day rows (`2026-06-01`) were pruned across all 3 aggregate tables while today's rows remain!
    for (const table of ["analytics_content_daily", "analytics_hourly_utc", "analytics_sources_daily"]) {
      const stale = await db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE day_utc = '2026-06-01'`)
        .first<{ cnt: number }>();
      expect(Number(stale?.cnt ?? 0), `${table} stale rows must be pruned`).toBe(0);
    }

    // Verify personalized visitor-ID utm_source is stripped to "" while keeping coarse campaign bucket
    const strippedIdRec = await recordFirstPartyEvent(
      db,
      {
        eventId: "72000000-0000-4000-8000-00000000c099",
        eventName: "page_view",
        path: "/p-1",
        utmSource: "u8f3a9c12b4e",
      },
      { nowMs: BASE_NOW_MS, siteHost: tenant.subdomainHost },
    );
    expect(strippedIdRec).toMatchObject({ ok: true, recorded: true });
    const allSourcesSerialized = JSON.stringify(
      (await db.prepare("SELECT * FROM analytics_sources_daily").all()).results ?? [],
    );
    expect(allSourcesSerialized).not.toContain("u8f3a9c12b4e");
    const blankCampaign = await db
      .prepare("SELECT page_views FROM analytics_sources_daily WHERE source_bucket = 'campaign' AND utm_source = ''")
      .first<{ page_views: number }>();
    expect(Number(blankCampaign?.page_views ?? 0)).toBe(1);
  });
});
