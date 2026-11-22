import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PublicLeadSubmitRequestSchema } from "@punyasitus/core/schemas";
import {
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  DEFAULT_LEAD_DEDUP_TTL_MS,
  executeIdempotentLeadWrite,
  hashLeadPayload,
  pruneExpiredLeadDedup,
} from "@punyasitus/db/lead-dedup/index";
import {
  DEFAULT_EVENT_RATE_LIMIT_POLICY,
  DEFAULT_LEAD_RATE_LIMIT_POLICY,
  enforceEventRateLimit,
  enforceLeadRateLimit,
  pruneExpiredRateLimitBuckets,
} from "@punyasitus/db/rate-limits/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_POST_MAX_BYTES,
  validatePublicPostRequest,
} from "../../apps/web/src/core/public-input.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const TEST_SALT = "workerd-test-secret-salt-2026";

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

describe("TASK-029 workerd integration — Atomic rate limits, lead idempotency & public POST guard", () => {
  it("enforces atomic parallel 5/min network and 100/hr tenant lead rate limits without storing raw IPs", async () => {
    const tenantId = `${SYNTHETIC_TENANTS[0].id}-rl-lead`;
    const db = await openMigratedTenantDb(tenantId);
    const visitorIp = "203.0.113.77";
    const baseNow = 1_760_000_000_000;

    // 1. Fire 12 parallel concurrent lead requests from the SAME IP: strictly 5 succeed, 7 get 429 + Retry-After
    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        enforceLeadRateLimit(db, {
          tenantId,
          clientIp: visitorIp,
          salt: TEST_SALT,
          nowMs: baseNow,
        }),
      ),
    );

    const allowed = burst.filter((r) => r.ok && r.allowed);
    const rejected = burst.filter((r) => r.ok && !r.allowed);
    expect(allowed).toHaveLength(DEFAULT_LEAD_RATE_LIMIT_POLICY.perNetworkMinute.limit);
    expect(rejected).toHaveLength(7);

    for (const r of rejected) {
      if (r.ok && !r.allowed) {
        expect(r.status).toBe(429);
        expect(r.code).toBe("RATE_LIMITED");
        expect(r.violatedRule).toBe("lead_network_minute");
        expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    }

    // 2. Verify SQLite rate_limit_buckets NEVER stores raw visitor IP
    const storedBuckets = await db
      .prepare("SELECT bucket_key, count, window_start, expires_at FROM rate_limit_buckets")
      .all<{ bucket_key: string; count: number; window_start: number; expires_at: number }>();
    expect(storedBuckets.results.length).toBeGreaterThanOrEqual(2);
    for (const row of storedBuckets.results) {
      expect(row.bucket_key).not.toContain(visitorIp);
    }

    // Verify single abusive IP short-circuited before draining tenant hourly quota (tenant count == 5, not 12)
    const tenantHourRow = storedBuckets.results.find((r) => r.bucket_key.endsWith(":hour"));
    expect(tenantHourRow?.count).toBe(5);

    // 3. Window rollover after 60s resets the per-IP counter cleanly
    const afterMinute = await enforceLeadRateLimit(db, {
      tenantId,
      clientIp: visitorIp,
      salt: TEST_SALT,
      nowMs: baseNow + 60_000,
    });
    expect(afterMinute.ok && afterMinute.allowed).toBe(true);

    // 4. Exhaust remaining 94 tenant-hourly quota across distinct IPs (total = 6 + 94 = 100), then 5 more fail 429
    const distributed = await Promise.all(
      Array.from({ length: 99 }, (_, idx) =>
        enforceLeadRateLimit(db, {
          tenantId,
          clientIp: `198.51.100.${(idx % 200) + 1}`,
          salt: TEST_SALT,
          nowMs: baseNow + 60_000,
        }),
      ),
    );
    const distAllowed = distributed.filter((r) => r.ok && r.allowed);
    const distRejected = distributed.filter((r) => r.ok && !r.allowed);
    expect(distAllowed).toHaveLength(94);
    expect(distRejected).toHaveLength(5);
    for (const r of distRejected) {
      if (r.ok && !r.allowed) {
        expect(r.status).toBe(429);
        expect(r.violatedRule).toBe("lead_tenant_hour");
        expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }

    // 5. Isolation: Tenant B has its own TenantStore and is completely unaffected
    const tenantBId = `${SYNTHETIC_TENANTS[1].id}-rl-lead`;
    const dbB = await openMigratedTenantDb(tenantBId);
    const tenantBRes = await enforceLeadRateLimit(dbB, {
      tenantId: tenantBId,
      clientIp: visitorIp,
      salt: TEST_SALT,
      nowMs: baseNow + 60_000,
    });
    expect(tenantBRes.ok && tenantBRes.allowed).toBe(true);

    // 6. Expired buckets prune cleanly
    const pruned = await pruneExpiredRateLimitBuckets(db, baseNow + 3_700_000);
    expect(pruned.ok).toBe(true);
    if (pruned.ok) {
      expect(pruned.deleted).toBeGreaterThanOrEqual(2);
    }
  });

  it("enforces atomic event rate limits (60/min per network, 10,000/day per tenant) signaling drop: true (204)", async () => {
    const tenantId = `${SYNTHETIC_TENANTS[0].id}-rl-event`;
    const db = await openMigratedTenantDb(tenantId);
    const baseNow = 1_760_100_000_000;

    // 65 parallel events from the same network bucket -> strictly 60 allowed, 5 dropped (204)
    const burst = await Promise.all(
      Array.from({ length: 65 }, () =>
        enforceEventRateLimit(db, {
          tenantId,
          clientIp: "203.0.113.88",
          salt: TEST_SALT,
          nowMs: baseNow,
        }),
      ),
    );
    const allowed = burst.filter((r) => r.ok && r.allowed);
    const dropped = burst.filter((r) => r.ok && !r.allowed);
    expect(allowed).toHaveLength(DEFAULT_EVENT_RATE_LIMIT_POLICY.perNetworkMinute.limit);
    expect(dropped).toHaveLength(5);
    for (const r of dropped) {
      if (r.ok && !r.allowed) {
        expect(r.drop).toBe(true);
        expect(r.status).toBe(204);
        expect(r.violatedRule).toBe("event_network_minute");
      }
    }

    // Tenant daily cap enforcement (seed day counter near 10,000 to verify atomic boundary at 10,000)
    await db
      .prepare(
        `UPDATE rate_limit_buckets
         SET count = 9998
         WHERE bucket_key = ?`,
      )
      .bind(`event:t:${tenantId}:day`)
      .run();

    const dayBurst = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        enforceEventRateLimit(db, {
          tenantId,
          clientIp: `198.51.100.${idx + 10}`,
          salt: TEST_SALT,
          nowMs: baseNow,
        }),
      ),
    );
    const dayAllowed = dayBurst.filter((r) => r.ok && r.allowed);
    const dayDropped = dayBurst.filter((r) => r.ok && !r.allowed);
    expect(dayAllowed).toHaveLength(2);
    expect(dayDropped).toHaveLength(3);
    for (const r of dayDropped) {
      if (r.ok && !r.allowed) {
        expect(r.drop).toBe(true);
        expect(r.status).toBe(204);
        expect(r.violatedRule).toBe("event_tenant_day");
      }
    }
  });

  it("persists leads once on sequential & parallel retries, returns 409 on conflict, and prunes expired entries", async () => {
    const tenantId = `${SYNTHETIC_TENANTS[0].id}-dedup`;
    const db = await openMigratedTenantDb(tenantId);
    const baseNow = 1_760_200_000_000;
    const key1 = "33333333-3333-4333-8333-333333333333";

    const leadPayload = {
      name: "Andi Pratama",
      phoneE164: "6281234567890",
      email: "andi@example.test",
      message: "Mohon info jadwal kunjungan minggu depan.",
      pagePath: "/kontak",
    } as const;

    // 1. First submission creates lead #1
    const first = await executeIdempotentLeadWrite(db, {
      idempotencyKey: key1,
      lead: leadPayload,
      payload: { name: "Andi Pratama", phone: "6281234567890", message: leadPayload.message },
      nowMs: baseNow,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.kind !== "created") {
      throw new Error("Expected first submission to be created");
    }
    expect(first.status).toBe(201);
    expect(first.leadId).toBe(1);
    expect(first.expiresAt).toBe(baseNow + DEFAULT_LEAD_DEDUP_TTL_MS);

    // 2. Sequential matching retry (reordered JSON keys -> same canonical SHA-256 hash) replays without duplicate row
    const replay = await executeIdempotentLeadWrite(db, {
      idempotencyKey: key1.toUpperCase(),
      lead: leadPayload,
      payload: { message: leadPayload.message, phone: "6281234567890", name: "Andi Pratama" },
      nowMs: baseNow + 5_000,
    });
    expect(replay).toMatchObject({
      ok: true,
      kind: "replayed",
      status: 201,
      leadId: 1,
    });

    // 3. Conflicting payload with same active key returns 409 IDEMPOTENCY_CONFLICT
    const conflict = await executeIdempotentLeadWrite(db, {
      idempotencyKey: key1,
      lead: { ...leadPayload, message: "Pesan yang diubah" },
      payload: { name: "Andi Pratama", phone: "6281234567890", message: "Pesan yang diubah" },
      nowMs: baseNow + 10_000,
    });
    expect(conflict).toMatchObject({
      ok: true,
      kind: "conflict",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });

    const countAfterKey1 = await db
      .prepare("SELECT COUNT(*) AS total FROM leads")
      .first<{ total: number }>();
    expect(countAfterKey1?.total).toBe(1);

    // 4. Parallel concurrent identical retries on a fresh key persist EXACTLY ONE lead row
    const keyParallel = "44444444-4444-4444-8444-444444444444";
    const parallelPayload = {
      name: "Dewi Lestari",
      phoneE164: "6281987654321",
      message: "Tanya harga paket perusahaan",
    } as const;
    const parallelHash = await hashLeadPayload(parallelPayload);

    const parallelResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        executeIdempotentLeadWrite(db, {
          idempotencyKey: keyParallel,
          lead: parallelPayload,
          payloadHash: parallelHash,
          nowMs: baseNow + 20_000,
        }),
      ),
    );

    const createdList = parallelResults.filter((r) => r.ok && r.kind === "created");
    const replayedList = parallelResults.filter((r) => r.ok && r.kind === "replayed");
    expect(createdList).toHaveLength(1);
    expect(replayedList).toHaveLength(7);

    const expectedLeadId = createdList[0] && createdList[0].ok && createdList[0].kind === "created"
      ? createdList[0].leadId
      : -1;
    expect(expectedLeadId).toBe(2);
    for (const r of replayedList) {
      if (r.ok && r.kind === "replayed") {
        expect(r.leadId).toBe(expectedLeadId);
      }
    }

    const countAfterParallel = await db
      .prepare("SELECT COUNT(*) AS total FROM leads")
      .first<{ total: number }>();
    expect(countAfterParallel?.total).toBe(2);

    // 5. Expired key (24h later) is pruned and replaced cleanly
    const afterExpiry = await executeIdempotentLeadWrite(db, {
      idempotencyKey: key1,
      lead: { ...leadPayload, message: "Pengiriman baru setelah 24 jam" },
      nowMs: baseNow + DEFAULT_LEAD_DEDUP_TTL_MS,
    });
    expect(afterExpiry).toMatchObject({
      ok: true,
      kind: "created",
      status: 201,
      leadId: 3,
    });

    // Prune helper cleans up expired rows cleanly
    const pruned = await pruneExpiredLeadDedup(db, baseNow + DEFAULT_LEAD_DEDUP_TTL_MS * 3);
    expect(pruned).toEqual({ ok: true, deleted: 2 });
  });

  it("validates the complete Origin/Sec-Fetch-Site matrix, forged tenant, oversized streaming body, and datastore outage in workerd", async () => {
    const tenant = SYNTHETIC_TENANTS[0];
    const tenantOrigin = `https://${tenant.subdomainHost}`;
    const db = await openMigratedTenantDb(`${tenant.id}-guard`);

    const validLeadJson = JSON.stringify({
      name: "Rina Wijaya",
      phone: "6281234567890",
      message: "Ingin bertanya layanan",
      honeypot: "",
    });
    const validLeadForm =
      "name=Rina+Wijaya&phone=6281234567890&message=Ingin+bertanya+layanan&honeypot=";

    // Full Origin & Sec-Fetch-Site matrix in workerd
    const matrixCases: Array<{
      readonly label: string;
      readonly request: Request;
      readonly expectedOk: boolean;
      readonly expectedStatus?: number;
      readonly expectedCode?: string;
    }> = [
      {
        label: "same-origin JSON (accept)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: tenantOrigin },
          body: validLeadJson,
        }),
        expectedOk: true,
      },
      {
        label: "cross-origin JSON (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://attacker.example" },
          body: validLeadJson,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "ORIGIN_MISMATCH",
      },
      {
        label: "literal null Origin (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "null" },
          body: validLeadJson,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "NULL_ORIGIN",
      },
      {
        label: "missing-Origin JSON (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: validLeadJson,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "MISSING_ORIGIN",
      },
      {
        label: "missing-Origin form POST Sec-Fetch-Site: cross-site (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "cross-site",
          },
          body: validLeadForm,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "CROSS_SITE_FORM",
      },
      {
        label: "missing-Origin form POST Sec-Fetch-Site: same-site (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-site",
          },
          body: validLeadForm,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "CROSS_SITE_FORM",
      },
      {
        label: "missing-Origin form POST Sec-Fetch-Site: none (403)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "none",
          },
          body: validLeadForm,
        }),
        expectedOk: false,
        expectedStatus: 403,
        expectedCode: "CROSS_SITE_FORM",
      },
      {
        label: "missing-Origin form POST Sec-Fetch-Site: same-origin (accept)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
          },
          body: validLeadForm,
        }),
        expectedOk: true,
      },
      {
        label: "missing-Origin form POST absent Sec-Fetch-Site (accept)",
        request: new Request(`${tenantOrigin}/api/leads`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: validLeadForm,
        }),
        expectedOk: true,
      },
    ];

    for (const tc of matrixCases) {
      const res = await validatePublicPostRequest(tc.request, {
        tenantHost: tenant.subdomainHost,
        schema: PublicLeadSubmitRequestSchema,
      });
      expect(res.ok, tc.label).toBe(tc.expectedOk);
      if (!tc.expectedOk && !res.ok) {
        expect(res.status, tc.label).toBe(tc.expectedStatus);
        expect(res.code, tc.label).toBe(tc.expectedCode);
      }
    }

    // Forged tenantId rejected 422
    const forgedReq = new Request(`${tenantOrigin}/api/leads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: tenantOrigin,
        "x-tenant-id": SYNTHETIC_TENANTS[1].id,
      },
      body: JSON.stringify({
        tenantId: SYNTHETIC_TENANTS[1].id,
        name: "Rina",
        phone: "6281234567890",
        message: "Test",
      }),
    });
    const forgedRes = await validatePublicPostRequest(forgedReq, {
      tenantHost: tenant.subdomainHost,
      schema: PublicLeadSubmitRequestSchema,
    });
    expect(forgedRes).toMatchObject({ ok: false, status: 422, code: "FORGED_TENANT_FIELD" });

    // Oversized body (> 16 KiB) via Content-Length AND via chunked ReadableStream without Content-Length
    const hugeJson = JSON.stringify({
      name: "Rina",
      phone: "6281234567890",
      message: "z".repeat(DEFAULT_PUBLIC_POST_MAX_BYTES + 64),
    });
    const oversizedHeaderRes = await validatePublicPostRequest(
      new Request(`${tenantOrigin}/api/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: tenantOrigin,
          "content-length": String(hugeJson.length),
        },
        body: hugeJson,
      }),
      { tenantHost: tenant.subdomainHost },
    );
    expect(oversizedHeaderRes).toMatchObject({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE" });

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":"'));
        const block = new Uint8Array(4096).fill(0x7a);
        for (let i = 0; i < 5; i += 1) {
          controller.enqueue(block);
        }
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const oversizedStreamRes = await validatePublicPostRequest(
      new Request(`${tenantOrigin}/api/leads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: tenantOrigin,
        },
        body: oversizedStream,
      }),
      { tenantHost: tenant.subdomainHost },
    );
    expect(oversizedStreamRes).toMatchObject({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE" });

    // Zero lead rows persisted from all rejected attempts
    const countAfterRejects = await db
      .prepare("SELECT COUNT(*) AS total FROM leads")
      .first<{ total: number }>();
    expect(countAfterRejects?.total).toBe(0);

    // Datastore outage (broken DB stub AND unmigrated TenantStore missing tables) -> 503, zero false success
    const brokenDb = createBrokenDb();
    const brokenRl = await enforceLeadRateLimit(brokenDb, {
      tenantId: tenant.id,
      clientIp: "203.0.113.1",
      salt: TEST_SALT,
    });
    expect(brokenRl).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const brokenDedup = await executeIdempotentLeadWrite(brokenDb, {
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      lead: { name: "Rina", phoneE164: "6281234567890", message: "Outage check" },
    });
    expect(brokenDedup).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const unmigratedDb = createTenantDb(openTenantStoreStub(ns, "01JTESTUNMIGRATEDOUTAGE001"));
    const unmigratedRl = await enforceLeadRateLimit(unmigratedDb, {
      tenantId: "01JTESTUNMIGRATEDOUTAGE001",
      clientIp: "203.0.113.1",
      salt: TEST_SALT,
    });
    expect(unmigratedRl).toMatchObject({ ok: false, kind: "datastore_unavailable", status: 503 });

    const unmigratedDedup = await executeIdempotentLeadWrite(unmigratedDb, {
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      lead: { name: "Rina", phoneE164: "6281234567890", message: "Outage check" },
    });
    expect(unmigratedDedup).toMatchObject({
      ok: false,
      kind: "datastore_unavailable",
      status: 503,
    });
  });
});
