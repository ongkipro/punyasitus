import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  getTenantDashboardMetrics,
  recordFirstPartyEvent,
} from "@punyasitus/db/analytics/index";
import {
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import { handlePublicEventPost } from "../../apps/web/src/pages/api/events.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const TEST_SALT = "workerd-task-030-rate-limit-salt";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 10, 0, 0); // 2026-11-22 17:00 WIB

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  const stub = openTenantStoreStub(ns, tenantId);
  return createTenantDb(stub);
}

async function seedTenantContent(db: D1Database, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, created_at, updated_at)
       VALUES
         (1, 'beranda', 'Beranda', 1, '[]', '[]', 'published', ?, ?, ?),
         (2, 'draf-rahasia', 'Draf Rahasia', 0, '[]', NULL, 'draft', NULL, ?, ?),
         (3, 'halaman-sampah', 'Halaman Sampah', 0, '[]', '[]', 'trashed', ?, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs, nowMs, nowMs, nowMs, nowMs, nowMs)
    .run();

  await db
    .prepare(
      `INSERT INTO posts (id, slug, title, draft_body_json, published_body_json, status, published_at, created_at, updated_at)
       VALUES
         (10, 'panduan-umkm', 'Panduan UMKM', '{}', '{}', 'published', ?, ?, ?),
         (11, 'artikel-draf', 'Artikel Draf', '{}', NULL, 'draft', NULL, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs, nowMs, nowMs)
    .run();

  await db
    .prepare(
      `INSERT INTO offerings (id, offering_type, slug, title, status, published_at, created_at, updated_at)
       VALUES
         (100, 'service', 'konsultasi-seo', 'Konsultasi SEO', 'published', ?, ?, ?),
         (101, 'service', 'layanan-draf', 'Layanan Draf', 'draft', NULL, ?, ?)`,
    )
    .bind(nowMs, nowMs, nowMs, nowMs, nowMs)
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
      "cf-connecting-ip": "203.0.113.42",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("TASK-030 workerd integration — First-party click counters, resource validation & rate limits", () => {
  it("increments wa_click, external_click, lead_submitted, and page_view separately and aggregates accurately", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t030-counters`;
    const db = await openMigratedTenantDb(tenantId);
    await seedTenantContent(db, BASE_NOW_MS);

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost, timeZone: "Asia/Jakarta" },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    // 3 wa_click on /layanan/konsultasi-seo (valid published offering #100)
    for (let i = 0; i < 3; i += 1) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventType: "wa_click",
          path: "/layanan/konsultasi-seo",
          resourceType: "offering",
          resourceId: 100,
        }),
        deps,
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    // 2 external_click on /layanan/konsultasi-seo (using canonical OpenAPI eventName + targetKind/targetSlug)
    for (let i = 0; i < 2; i += 1) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventId: `11111111-1111-4111-8111-11111111111${i}`,
          eventName: "external_click",
          path: "/layanan/konsultasi-seo",
          targetKind: "service",
          targetSlug: "konsultasi-seo",
        }),
        deps,
      );
      expect(res.status).toBe(204);
    }

    // 1 lead_submitted on / (valid published page #1)
    const leadRes = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventType: "lead_submitted",
        path: "/",
        resourceType: "page",
        resourceId: 1,
      }),
      deps,
    );
    expect(leadRes.status).toBe(204);

    // 4 page_view on /blog/panduan-umkm (valid published post #10)
    for (let i = 0; i < 4; i += 1) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventType: "page_view",
          path: "/blog/panduan-umkm",
          resourceType: "post",
          resourceId: 10,
        }),
        deps,
      );
      expect(res.status).toBe(204);
    }

    const metrics = await getTenantDashboardMetrics(db, {
      days: 7,
      nowMs: BASE_NOW_MS,
      timeZone: "Asia/Jakarta",
    });

    expect(metrics.hasAnyData).toBe(true);
    expect(metrics.totals).toEqual({
      waClicks: 3,
      externalClicks: 2,
      leadSubmits: 1,
      pageviews: 4,
      uniqueVisitors: 0,
      totalInterestSignals: 6,
    });
    expect(metrics.topPaths.map((p) => p.path)).toEqual([
      "/layanan/konsultasi-seo",
      "/",
      "/blog/panduan-umkm",
    ]);
    expect(metrics.topPaths[0]).toEqual({
      path: "/layanan/konsultasi-seo",
      pageviews: 0,
      waClicks: 3,
      externalClicks: 2,
      leadSubmits: 0,
      totalInterestSignals: 5,
    });

    // Physical tenant isolation: Tenant B's TenantStore remains completely empty
    const tenantBId = `${SYNTHETIC_TENANTS[1].id}-t030-counters`;
    const dbB = await openMigratedTenantDb(tenantBId);
    const metricsB = await getTenantDashboardMetrics(dbB, {
      days: 7,
      nowMs: BASE_NOW_MS,
    });
    expect(metricsB.hasAnyData).toBe(false);
    expect(metricsB.totals.totalInterestSignals).toBe(0);
  });

  it("rejects fabricated/unpublished resource IDs, PII fields, query strings, forged tenantId, and non-tenant hosts without mutating counters", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t030-rejects`;
    const db = await openMigratedTenantDb(tenantId);
    await seedTenantContent(db, BASE_NOW_MS);

    const deps = {
      surface: "tenant" as const,
      tenant: { id: tenantId, host: tenant.subdomainHost },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      nowMs: BASE_NOW_MS,
    };

    // 1. Fabricated offering ID (does not exist) -> 422 INVALID_RESOURCE_REFERENCE
    const fabricatedOffering = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventType: "wa_click",
        path: "/layanan/palsu",
        resourceType: "offering",
        resourceId: 999999,
      }),
      deps,
    );
    expect(fabricatedOffering.status).toBe(422);
    const fabricatedBody = (await fabricatedOffering.json()) as {
      error: { code: string; fields?: Array<{ code: string }> };
    };
    expect(fabricatedBody.error.fields?.[0]?.code).toBe("INVALID_RESOURCE_REFERENCE");

    // 2. Unpublished draft page (#2) and trashed page (#3) -> 422 INVALID_RESOURCE_REFERENCE
    for (const badPageId of [2, 3]) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventType: "wa_click",
          path: "/draf-rahasia",
          resourceType: "page",
          resourceId: badPageId,
        }),
        deps,
      );
      expect(res.status, `pageId=${badPageId}`).toBe(422);
    }

    // 3. Unpublished draft post (#11) and draft offering (#101) -> 422
    const draftPost = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventType: "external_click",
        path: "/blog/artikel-draf",
        resourceType: "post",
        resourceId: 11,
      }),
      deps,
    );
    expect(draftPost.status).toBe(422);

    const draftOffering = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventType: "wa_click",
        path: "/layanan/layanan-draf",
        resourceType: "offering",
        resourceId: 101,
      }),
      deps,
    );
    expect(draftOffering.status).toBe(422);

    // 4. Fabricated targetSlug for published targetKind -> 422
    const fakeSlug = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventName: "wa_click",
        path: "/layanan/tidak-ada",
        targetKind: "service",
        targetSlug: "tidak-ada",
      }),
      deps,
    );
    expect(fakeSlug.status).toBe(422);

    // 5. PII fields (`email`, `phone`, `name`, `message`) -> 422
    for (const piiField of [
      { email: "pelanggan@example.test" },
      { phone: "6281234567890" },
      { name: "Siti Aminah" },
      { message: "Mau pesan 5 paket" },
      { ip: "203.0.113.9" },
    ]) {
      const res = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventType: "wa_click",
          path: "/",
          ...piiField,
        }),
        deps,
      );
      expect(res.status, JSON.stringify(piiField)).toBe(422);
    }

    // 6. Query string in path -> 422
    const queryPath = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        eventType: "wa_click",
        path: "/layanan?email=test@example.test",
      }),
      deps,
    );
    expect(queryPath.status).toBe(422);

    // 7. Forged tenantId in body -> 422 FORGED_TENANT_FIELD
    const forgedTenant = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, {
        tenantId: SYNTHETIC_TENANTS[1].id,
        eventType: "wa_click",
        path: "/",
      }),
      deps,
    );
    expect(forgedTenant.status).toBe(422);

    // 8. Non-tenant surfaces (`marketing`, `app`, `console`) return 404
    for (const surface of ["marketing", "app", "console"] as const) {
      const nonTenantRes = await handlePublicEventPost(
        makeEventRequest(tenant.subdomainHost, {
          eventType: "wa_click",
          path: "/",
        }),
        { ...deps, surface },
      );
      expect(nonTenantRes.status, `surface=${surface}`).toBe(404);
    }

    // 9. Cross-origin rejected with 403
    const crossOrigin = await handlePublicEventPost(
      makeEventRequest(
        tenant.subdomainHost,
        { eventType: "wa_click", path: "/" },
        { origin: "https://evil.example" },
      ),
      deps,
    );
    expect(crossOrigin.status).toBe(403);

    // Confirm ZERO counter rows were written by any rejected attempt
    const metrics = await getTenantDashboardMetrics(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(metrics.hasAnyData).toBe(false);
    expect(metrics.totals.totalInterestSignals).toBe(0);
    expect(metrics.totals.pageviews).toBe(0);
  });

  it("drops over-limit events cleanly with 204 without incrementing counters once cap is reached", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantId = `${tenant.id}-t030-ratelimit`;
    const db = await openMigratedTenantDb(tenantId);

    const smallPolicy = {
      perNetworkMinute: {
        name: "event_network_minute",
        limit: 4,
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
      tenant: { id: tenantId, host: tenant.subdomainHost },
      tenantDb: db,
      rateLimitSalt: TEST_SALT,
      rateLimitPolicy: smallPolicy,
      nowMs: BASE_NOW_MS,
    };

    // Send 7 parallel wa_click events from the same IP: all return 204, ONLY 4 increment counter!
    const responses = await Promise.all(
      Array.from({ length: 7 }, () =>
        handlePublicEventPost(
          makeEventRequest(
            tenant.subdomainHost,
            { eventType: "wa_click", path: "/kontak" },
            { "cf-connecting-ip": "198.51.100.55" },
          ),
          deps,
        ),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(204);
    }

    const metrics = await getTenantDashboardMetrics(db, { days: 7, nowMs: BASE_NOW_MS });
    expect(metrics.totals.waClicks).toBe(4);
    expect(metrics.totals.externalClicks).toBe(0);
    expect(metrics.totals.leadSubmits).toBe(0);

    // Unmigrated DO / datastore outage fails closed with 503 (never silent 204)
    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const unmigratedDb = createTenantDb(openTenantStoreStub(ns, "01JTESTT030OUTAGE00000001"));
    const outageRes = await handlePublicEventPost(
      makeEventRequest(tenant.subdomainHost, { eventType: "wa_click", path: "/" }),
      { ...deps, tenantDb: unmigratedDb },
    );
    expect(outageRes.status).toBe(503);

    const directOutage = await recordFirstPartyEvent(unmigratedDb, {
      eventType: "wa_click",
      path: "/",
    });
    expect(directOutage).toMatchObject({ ok: false, status: 503, code: "SERVICE_UNAVAILABLE" });
  });
});
