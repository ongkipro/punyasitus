import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applyTenantAnalyticsDedupMigrations,
  buildAnalyticsEventDedupKey,
  DEFAULT_EVENT_DEDUP_TTL_MS,
  getTenantDashboardMetrics,
  pruneExpiredAnalyticsEventDedup,
  recordFirstPartyEvent,
} from "@punyasitus/db/analytics/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { describe, expect, it } from "vitest";
import { handlePublicEventPost } from "../../apps/web/src/pages/api/events.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const TEST_SALT = "workerd-task-065-event-dedup-salt";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0); // 2026-11-23 15:00 WIB

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, async (_instance, state) => {
    const first = await applyTenantAnalyticsDedupMigrations(state.storage as unknown as StorageLike);
    // Re-run idempotently to prove 0018 migration descriptor skips safely
    const second = await applyTenantAnalyticsDedupMigrations(state.storage as unknown as StorageLike);
    if (second.applied.length !== 0) {
      throw new Error(`Expected idempotent 0018 re-run, got applied=${second.applied.join(",")}`);
    }
    return first;
  });
  const stub = openTenantStoreStub(ns, tenantId);
  return createTenantDb(stub);
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
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": "203.0.113.65",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("TASK-065 workerd integration — Atomic SQLite event dedup, concurrency race, 24h TTL pruning & security", () => {
  it("deduplicates sequential and cross-type replays across all 4 event types inside one atomic TenantStore batch", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t065-seq`;
    const db = await openMigratedTenantDb(tenantId);

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    const events = [
      { eventId: "10000000-0000-4000-8000-000000000001", eventName: "wa_click", path: "/layanan/seo" },
      {
        eventId: "10000000-0000-4000-8000-000000000002",
        eventName: "external_click",
        path: "/produk/kopi",
      },
      {
        eventId: "10000000-0000-4000-8000-000000000003",
        eventName: "lead_submitted",
        path: "/kontak",
      },
      {
        eventId: "10000000-0000-4000-8000-000000000004",
        eventName: "page_view",
        path: "/blog/tips",
      },
    ] as const;

    // First send + 2 sequential replays of every event -> ALL return 204, count stays 1 each!
    for (const ev of events) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await handlePublicEventPost(
          makeEventRequest(tenant.subdomainHost, {
            eventId: attempt === 1 ? ev.eventId.toUpperCase() : ev.eventId,
            eventName: ev.eventName,
            path: ev.path,
          }),
          deps,
        );
        expect(res.status).toBe(204);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }

    // Replaying the wa_click UUID with a DIFFERENT eventName (external_click) is ALSO deduplicated!
    const crossTypeReplay = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventId: events[0].eventId,
        eventName: "external_click",
        path: "/produk/kopi",
      }),
      deps,
    );
    expect(crossTypeReplay.status).toBe(204);

    const metrics = await getTenantDashboardMetrics(db, {
      days: 7,
      nowMs: BASE_NOW_MS,
      timeZone: "Asia/Jakarta",
    });
    expect(metrics.totals).toEqual({
      waClicks: 1,
      externalClicks: 1,
      leadSubmits: 1,
      pageviews: 1,
      uniqueVisitors: 0,
      totalInterestSignals: 3,
    });

    // Verify dedup rows store ONLY opaque `evt:<uuid>` keys with exact 24h expiry and ZERO PII
    const dedupRows = await db
      .prepare("SELECT dedup_key, expires_at, created_at FROM analytics_event_dedup ORDER BY dedup_key ASC")
      .all<{ dedup_key: string; expires_at: number; created_at: number }>();
    expect(dedupRows.results).toHaveLength(4);
    for (const row of dedupRows.results) {
      expect(row.dedup_key).toMatch(/^evt:[0-9a-f-]{36}$/);
      expect(row.expires_at - row.created_at).toBe(DEFAULT_EVENT_DEDUP_TTL_MS);
    }
  });

  it("guarantees exactly-once counting under 12x concurrent duplicate eventId race", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t065-race`;
    const db = await openMigratedTenantDb(tenantId);

    const raceUuid = "20000000-0000-4000-8000-000000000099";
    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        handlePublicEventPost(
          makeEventRequest(
            tenant.subdomainHost,
            {
              eventId: raceUuid,
              eventName: "wa_click",
              path: "/layanan/konsultasi",
            },
            { "cf-connecting-ip": `198.51.100.${10 + idx}` },
          ),
          deps,
        ),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(204);
    }

    const metrics = await getTenantDashboardMetrics(db, {
      days: 7,
      nowMs: BASE_NOW_MS,
      timeZone: "Asia/Jakarta",
    });
    expect(metrics.totals.waClicks).toBe(1);
    expect(metrics.totals.totalInterestSignals).toBe(1);
  });

  it("enforces exact 24h TTL boundary and physical per-tenant dedup isolation", async () => {
    const tenantA = SYNTHETIC_TENANTS[0];
    const tenantB = SYNTHETIC_TENANTS[1];
    const dbA = await openMigratedTenantDb(`${tenantA.id}-t065-ttl`);
    const dbB = await openMigratedTenantDb(`${tenantB.id}-t065-ttl`);

    const sharedUuid = "30000000-0000-4000-8000-000000000042";

    // Tenant A records at T=0
    const firstA = await recordFirstPartyEvent(
      dbA,
      { eventId: sharedUuid, eventName: "wa_click", path: "/" },
      { nowMs: BASE_NOW_MS },
    );
    expect(firstA).toMatchObject({ ok: true, recorded: true, deduplicated: false });

    // Tenant B records the EXACT SAME UUID at T=0 -> succeeds independently!
    const firstB = await recordFirstPartyEvent(
      dbB,
      { eventId: sharedUuid, eventName: "wa_click", path: "/" },
      { nowMs: BASE_NOW_MS },
    );
    expect(firstB).toMatchObject({ ok: true, recorded: true, deduplicated: false });

    // Tenant A 1ms BEFORE 24h expiry -> still deduplicated (count stays 1)
    const beforeExpiry = await recordFirstPartyEvent(
      dbA,
      { eventId: sharedUuid, eventName: "wa_click", path: "/" },
      { nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS - 1 },
    );
    expect(beforeExpiry).toMatchObject({ ok: true, recorded: false, deduplicated: true });

    // Tenant A AT exact 24h expiry -> expired entry pruned & re-claimed (count becomes 2)
    const atExpiry = await recordFirstPartyEvent(
      dbA,
      { eventId: sharedUuid, eventName: "wa_click", path: "/" },
      { nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS },
    );
    expect(atExpiry).toMatchObject({ ok: true, recorded: true, deduplicated: false });

    const metricsA = await getTenantDashboardMetrics(dbA, {
      days: 7,
      nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS,
    });
    const metricsB = await getTenantDashboardMetrics(dbB, {
      days: 7,
      nowMs: BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS,
    });
    expect(metricsA.totals.waClicks).toBe(2);
    expect(metricsB.totals.waClicks).toBe(1);
  });

  it("opportunistically prunes expired dedup rows in bounded batches without touching active rows", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const db = await openMigratedTenantDb(`${tenant.id}-t065-prune`);

    // Seed 95 expired rows and 5 active rows directly into analytics_event_dedup
    const seedStatements: D1PreparedStatement[] = [];
    for (let i = 0; i < 95; i += 1) {
      const hex = i.toString(16).padStart(12, "0");
      const key = buildAnalyticsEventDedupKey(`40000000-0000-4000-8000-${hex}`);
      seedStatements.push(
        db
          .prepare("INSERT INTO analytics_event_dedup (dedup_key, expires_at, created_at) VALUES (?, ?, ?)")
          .bind(key, BASE_NOW_MS - 10_000 + i, BASE_NOW_MS - DEFAULT_EVENT_DEDUP_TTL_MS - 10_000 + i),
      );
    }
    for (let i = 0; i < 5; i += 1) {
      const hex = (1000 + i).toString(16).padStart(12, "0");
      const key = buildAnalyticsEventDedupKey(`40000000-0000-4000-8000-${hex}`);
      seedStatements.push(
        db
          .prepare("INSERT INTO analytics_event_dedup (dedup_key, expires_at, created_at) VALUES (?, ?, ?)")
          .bind(key, BASE_NOW_MS + DEFAULT_EVENT_DEDUP_TTL_MS, BASE_NOW_MS),
      );
    }
    await db.batch(seedStatements);

    // Trigger 1 new event with bounded pruneBatchSize=40 -> exactly 40 oldest expired rows pruned
    const res = await recordFirstPartyEvent(
      db,
      {
        eventId: "50000000-0000-4000-8000-000000000001",
        eventName: "page_view",
        path: "/",
      },
      { nowMs: BASE_NOW_MS, pruneBatchSize: 40 },
    );
    expect(res).toMatchObject({
      ok: true,
      recorded: true,
      deduplicated: false,
      prunedExpiredCount: 40,
    });

    const afterBounded = await db
      .prepare("SELECT COUNT(*) AS cnt FROM analytics_event_dedup")
      .first<{ cnt: number }>();
    // 95 - 40 expired remaining (55) + 5 active + 1 newly inserted = 61
    expect(Number(afterBounded?.cnt)).toBe(61);

    // Explicit prune clears the remaining 55 expired rows while preserving all 6 active rows
    const explicitPrune = await pruneExpiredAnalyticsEventDedup(db, { nowMs: BASE_NOW_MS });
    expect(explicitPrune).toEqual({ ok: true, deleted: 55 });

    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM analytics_event_dedup")
      .first<{ cnt: number }>();
    expect(Number(remaining?.cnt)).toBe(6);
  });

  it("enforces strict PII rejection, Origin/16 KiB guards, and rate-limit 204 quiet drop alongside dedup", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t065-sec`;
    const db = await openMigratedTenantDb(tenantId);

    const smallPolicy = {
      perNetworkMinute: {
        name: "event_network_minute",
        limit: 2,
        windowMs: 60_000,
      },
      perTenantDay: {
        name: "event_tenant_day",
        limit: 100,
        windowMs: 86_400_000,
      },
    } as const;

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      rateLimitPolicy: smallPolicy,
      nowMs: BASE_NOW_MS,
    };

    // 1. PII / query / XSS inside eventId -> 422 INVALID_EVENT_ID (does not consume rate limit!)
    for (const hostileId of [
      "pelanggan@example.test",
      "081234567890",
      "evt?email=a@b.com",
      "Budi Santoso",
      "<script>alert(1)</script>",
    ]) {
      const badRes = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventId: hostileId,
          eventName: "wa_click",
          path: "/",
        }),
        deps,
      );
      expect(badRes.status, `hostileId=${hostileId}`).toBe(422);
    }

    // 2. Cross-origin and literal null origin -> 403
    const crossOrigin = await handlePublicEventPost(
      makeEventRequest(
        tenant.subdomainHost,
        { eventId: "60000000-0000-4000-8000-000000000001", eventName: "wa_click", path: "/" },
        { origin: "https://attacker.example" },
      ),
      deps,
    );
    expect(crossOrigin.status).toBe(403);

    const nullOrigin = await handlePublicEventPost(
      makeEventRequest(
        tenant.subdomainHost,
        { eventId: "60000000-0000-4000-8000-000000000001", eventName: "wa_click", path: "/" },
        { origin: "null" },
      ),
      deps,
    );
    expect(nullOrigin.status).toBe(403);

    // 3. Oversized > 16 KiB payload -> 413
    const hugeRes = await handlePublicEventPost(
      new Request(`https://${tenant.subdomainHost}/api/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `https://${tenant.subdomainHost}`,
          "cf-connecting-ip": "203.0.113.65",
        },
        body: JSON.stringify({
          eventId: "60000000-0000-4000-8000-000000000001",
          eventName: "wa_click",
          path: `/${"a".repeat(17_000)}`,
        }),
      }),
      deps,
    );
    expect(hugeRes.status).toBe(413);

    // 4. Rate limit (cap = 2/min): send 4 distinct valid UUIDs -> ALL return 204, ONLY 2 recorded!
    for (let i = 1; i <= 4; i += 1) {
      const res = await handlePublicEventPost(
        makeEventRequest(
          tenant.subdomainHost,
          {
            eventId: `70000000-0000-4000-8000-00000000000${i}`,
            eventName: "wa_click",
            path: "/kontak",
          },
          { "cf-connecting-ip": "198.51.100.77" },
        ),
        deps,
      );
      expect(res.status).toBe(204);
    }

    const metrics = await getTenantDashboardMetrics(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(metrics.totals.waClicks).toBe(2);
    const dedupCount = await db
      .prepare("SELECT COUNT(*) AS cnt FROM analytics_event_dedup")
      .first<{ cnt: number }>();
    expect(Number(dedupCount?.cnt)).toBe(2);
  });
});
