import { createMessageBatch } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  recordDeletionTombstone,
  replayDeletionTombstones,
  runTenantRetentionSweep,
} from "@punyasitus/db/privacy/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/index.ts";
import {
  createRetentionJobRegistry,
  HOURLY_HOUSEKEEPING_TOPIC,
  RETENTION_SWEEP_TOPIC,
  type RetentionQueueSummary,
} from "../../apps/web/src/worker/queues/retention/index.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function seedTenantInPlatform(opts: {
  tenantId: string;
  orgId: string;
  handle: string;
  name: string;
  host: string;
  status?: "active" | "trial" | "purged";
}) {
  const now = new Date();
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  await pDb
    .insert(organizations)
    .values({
      id: opts.orgId,
      name: opts.name,
      slug: opts.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: opts.tenantId,
      organizationId: opts.orgId,
      handle: opts.handle,
      name: opts.name,
      status: opts.status ?? "active",
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenantHosts)
    .values({
      host: opts.host,
      tenantId: opts.tenantId,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

function buildBatch(messages: readonly { id: string; body: unknown }[]) {
  const rawBatch = createMessageBatch(
    "punyasitus-jobs-test",
    messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      body: m.body,
      attempts: 1,
    })),
  );
  const acked = new Set<string>();
  const wrapped = rawBatch.messages.map((msg) => ({
    id: msg.id,
    timestamp: msg.timestamp,
    body: msg.body,
    attempts: msg.attempts,
    ack() {
      acked.add(msg.id);
      msg.ack();
    },
    retry(opts?: QueueRetryOptions) {
      msg.retry(opts);
    },
  })) as Message<unknown>[];

  const batch: MessageBatch<unknown> = {
    queue: rawBatch.queue,
    metadata: rawBatch.metadata,
    messages: wrapped,
    ackAll: () => rawBatch.ackAll(),
    retryAll: (opts?: QueueRetryOptions) => rawBatch.retryAll(opts),
  };
  return { batch, acked };
}

describe("TASK-031 Retention Sweep, R2 Expiry & Tombstone Replay (workerd)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("deletes expired leads (>180d), dedup (>24h), analytics (>13mo), activity (>90d), trashed content/media (>30d) & quarantine R2 (>24h) while preserving fresh records", async () => {
    const tenantA = "01JTESTT031RETENTA00000001";
    const tenantB = "01JTESTT031RETENTB00000002";

    await seedTenantInPlatform({
      tenantId: tenantA,
      orgId: "org_t031_a",
      handle: "t031-alpha",
      name: "T031 Alpha",
      host: "t031-alpha.situsku.click",
    });
    await seedTenantInPlatform({
      tenantId: tenantB,
      orgId: "org_t031_b",
      handle: "t031-beta",
      name: "T031 Beta",
      host: "t031-beta.situsku.click",
    });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stubA = openTenantStoreStub(ns, tenantA);
    const migA = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stubA,
      tenantA,
      TENANT_MIGRATIONS,
    );
    expect(migA.httpStatus).toBe(200);

    const dbA = createTenantDb(stubA);
    // Use a future sweep clock (real now + 35 days) so R2 objects put right now can test real `obj.uploaded` too
    const realNowMs = Date.now();
    const nowMs = realNowMs + 35 * DAY_MS;

    // 1. Seed expired (>180d) and fresh (10d) leads
    await dbA
      .prepare(
        `INSERT INTO leads (id, name, phone_e164, email, message, status, created_at, updated_at)
         VALUES
           (1, 'Expired Lead', '+6281200001111', 'old@example.id', 'Pesan lama', 'closed', ?, ?),
           (2, 'Fresh Lead', '+6281200002222', 'fresh@example.id', 'Pesan baru', 'new', ?, ?)`,
      )
      .bind(nowMs - 181 * DAY_MS, nowMs - 181 * DAY_MS, nowMs - 10 * DAY_MS, nowMs - 10 * DAY_MS)
      .run();

    // 2. Seed expired (>24h) and fresh lead_dedup + analytics_event_dedup
    await dbA
      .prepare(
        `INSERT INTO lead_dedup (idempotency_key, payload_hash, lead_id, expires_at, created_at)
         VALUES
           ('dedup_old', 'hash_old', 2, ?, ?),
           ('dedup_fresh', 'hash_fresh', 2, ?, ?)`,
      )
      .bind(nowMs - 2 * HOUR_MS, nowMs - 26 * HOUR_MS, nowMs + 12 * HOUR_MS, nowMs - 2 * HOUR_MS)
      .run();

    await dbA
      .prepare(
        `INSERT INTO analytics_event_dedup (dedup_key, expires_at, created_at)
         VALUES
           ('evt_old', ?, ?),
           ('evt_fresh', ?, ?)`,
      )
      .bind(nowMs - 1 * HOUR_MS, nowMs - 25 * HOUR_MS, nowMs + 10 * HOUR_MS, nowMs - 1 * HOUR_MS)
      .run();

    // 3. Seed expired (>395d / 13 months) and fresh analytics_daily + analytics_hourly_sources
    const oldDay = new Date(nowMs - 400 * DAY_MS).toISOString().slice(0, 10);
    const freshDay = new Date(nowMs - 30 * DAY_MS).toISOString().slice(0, 10);

    await dbA
      .prepare(
        `INSERT INTO analytics_daily (day, path, pageviews, wa_clicks, updated_at)
         VALUES
           (?, '/', 120, 5, ?),
           (?, '/', 45, 3, ?)`,
      )
      .bind(oldDay, nowMs - 400 * DAY_MS, freshDay, nowMs - 30 * DAY_MS)
      .run();

    await dbA
      .prepare(
        `INSERT INTO analytics_hourly_sources (hour_bucket, source_bucket, utm_source, visits, updated_at)
         VALUES
           (?, 'organic_search', '', 12, ?),
           (?, 'ai_assistant', '', 7, ?)`,
      )
      .bind(`${oldDay}T10`, nowMs - 400 * DAY_MS, `${freshDay}T14`, nowMs - 30 * DAY_MS)
      .run();

    // 4. Seed expired (>90d) and fresh tenant_activity_log
    await dbA
      .prepare(
        `INSERT INTO tenant_activity_log (actor_role, action, resource_type, resource_id, summary, created_at)
         VALUES
           ('owner', 'page.publish', 'page', '1', 'Old edit', ?),
           ('owner', 'page.publish', 'page', '2', 'Recent edit', ?)`,
      )
      .bind(nowMs - 91 * DAY_MS, nowMs - 5 * DAY_MS)
      .run();

    // 5. Seed expired (>30d) and fresh trashed page/post/offering
    await dbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, status, deleted_at, created_at, updated_at)
         VALUES
           (1, 'old-trash-page', 'Old Trashed Page', 0, 'trashed', ?, ?, ?),
           (2, 'fresh-trash-page', 'Fresh Trashed Page', 0, 'trashed', ?, ?, ?)`,
      )
      .bind(
        nowMs - 31 * DAY_MS,
        nowMs - 40 * DAY_MS,
        nowMs - 31 * DAY_MS,
        nowMs - 5 * DAY_MS,
        nowMs - 10 * DAY_MS,
        nowMs - 5 * DAY_MS,
      )
      .run();

    // 6. Seed media_items + storage_usage + R2 objects (expired quarantine >24h, expired trash >30d, fresh ready media, and tenantB object)
    const expiredQuarantineKey = `t/${tenantA}/quarantine/abandoned-upload.bin`;
    const orphanQuarantineKey = `t/${tenantA}/quarantine/orphan-stale.bin`;
    const freshQuarantineKey = `t/${tenantA}/quarantine/in-progress.bin`;
    const expiredTrashMediaKey = `t/${tenantA}/trash/old-photo.webp`;
    const expiredTrashVariantKey = `t/${tenantA}/trash/old-photo-400.webp`;
    const freshReadyMediaKey = `t/${tenantA}/media/live-hero.webp`;
    const tenantBQuarantineKey = `t/${tenantB}/quarantine/other-tenant.bin`;

    await Promise.all([
      env.MEDIA_BUCKET.put(expiredQuarantineKey, "quarantine-bytes"),
      env.MEDIA_BUCKET.put(orphanQuarantineKey, "orphan-bytes"),
      env.MEDIA_BUCKET.put(freshQuarantineKey, "fresh-quarantine", {
        customMetadata: { uploadedAtMs: String(nowMs - 2 * HOUR_MS) },
      }),
      env.MEDIA_BUCKET.put(expiredTrashMediaKey, "trashed-master"),
      env.MEDIA_BUCKET.put(expiredTrashVariantKey, "trashed-variant"),
      env.MEDIA_BUCKET.put(freshReadyMediaKey, "live-hero-bytes"),
      env.MEDIA_BUCKET.put(tenantBQuarantineKey, "tenant-b-bytes"),
    ]);

    await dbA
      .prepare(
        `INSERT INTO storage_usage (id, used_bytes, quota_bytes, updated_at)
         VALUES (1, 100000, 104857600, ?)`,
      )
      .bind(nowMs)
      .run();

    await dbA
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, variants_json, status, created_at, updated_at)
         VALUES
           (1, 'image', ?, 'image/jpeg', 15000, 'sha_q', NULL, 'quarantined', ?, ?),
           (2, 'image', ?, 'image/webp', 25000, 'sha_t', ?, 'ready', ?, ?),
           (3, 'image', ?, 'image/webp', 60000, 'sha_live', NULL, 'ready', ?, ?)`,
      )
      .bind(
        expiredQuarantineKey,
        nowMs - 30 * HOUR_MS,
        nowMs - 30 * HOUR_MS,
        expiredTrashMediaKey,
        JSON.stringify({ w400: expiredTrashVariantKey }),
        nowMs - 35 * DAY_MS,
        nowMs - 31 * DAY_MS,
        freshReadyMediaKey,
        nowMs - 10 * DAY_MS,
        nowMs - 10 * DAY_MS,
      )
      .run();

    // Execute sweep
    const result = await runTenantRetentionSweep({
      tenantDb: dbA,
      tenantId: tenantA,
      mediaBucket: env.MEDIA_BUCKET,
      nowMs,
    });

    expect(result.deleted).toEqual({
      leads: 1,
      leadDedup: 1,
      analyticsEventDedup: 1,
      analyticsDaily: 1,
      analyticsHourlySources: 1,
      tenantActivityLog: 1,
      trashedPages: 1,
      trashedPosts: 0,
      trashedOfferings: 0,
      expiredMediaItems: 2,
      r2QuarantineObjects: 2, // expiredQuarantineKey + orphanQuarantineKey
      r2TrashedObjects: 2, // expiredTrashMediaKey + expiredTrashVariantKey
    });
    expect(result.freedStorageBytes).toBe(40_000);

    // Verify surviving fresh records in TenantStore
    const remainingLeads = await dbA.prepare("SELECT id, name FROM leads").all<{ id: number; name: string }>();
    expect(remainingLeads.results).toEqual([{ id: 2, name: "Fresh Lead" }]);

    const remainingLeadDedup = await dbA
      .prepare("SELECT idempotency_key FROM lead_dedup")
      .all<{ idempotency_key: string }>();
    expect(remainingLeadDedup.results).toEqual([{ idempotency_key: "dedup_fresh" }]);

    const remainingEventDedup = await dbA
      .prepare("SELECT dedup_key FROM analytics_event_dedup")
      .all<{ dedup_key: string }>();
    expect(remainingEventDedup.results).toEqual([{ dedup_key: "evt_fresh" }]);

    const remainingDaily = await dbA
      .prepare("SELECT day FROM analytics_daily")
      .all<{ day: string }>();
    expect(remainingDaily.results).toEqual([{ day: freshDay }]);

    const remainingHourly = await dbA
      .prepare("SELECT hour_bucket FROM analytics_hourly_sources")
      .all<{ hour_bucket: string }>();
    expect(remainingHourly.results).toEqual([{ hour_bucket: `${freshDay}T14` }]);

    const remainingActivity = await dbA
      .prepare("SELECT summary FROM tenant_activity_log")
      .all<{ summary: string }>();
    expect(remainingActivity.results).toEqual([{ summary: "Recent edit" }]);

    const remainingPages = await dbA
      .prepare("SELECT slug FROM pages")
      .all<{ slug: string }>();
    expect(remainingPages.results).toEqual([{ slug: "fresh-trash-page" }]);

    const remainingMedia = await dbA
      .prepare("SELECT id, r2_key FROM media_items")
      .all<{ id: number; r2_key: string }>();
    expect(remainingMedia.results).toEqual([{ id: 3, r2_key: freshReadyMediaKey }]);

    const storageAfter = await dbA
      .prepare("SELECT used_bytes FROM storage_usage WHERE id = 1")
      .first<{ used_bytes: number }>();
    expect(storageAfter?.used_bytes).toBe(60_000);

    // Verify R2 deletions & isolation
    expect(await env.MEDIA_BUCKET.head(expiredQuarantineKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(orphanQuarantineKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(expiredTrashMediaKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(expiredTrashVariantKey)).toBeNull();

    // Fresh tenantA objects and ALL tenantB objects MUST survive untouched
    expect(await env.MEDIA_BUCKET.head(freshQuarantineKey)).not.toBeNull();
    expect(await env.MEDIA_BUCKET.head(freshReadyMediaKey)).not.toBeNull();
    expect(await env.MEDIA_BUCKET.head(tenantBQuarantineKey)).not.toBeNull();
  });

  it("replays PLATFORM_DB.deletion_tombstones to re-purge restored tenants, hosts, and R2 objects without affecting live tenants", async () => {
    const purgedTenantId = "01JTESTT031PURGED000000003";
    const liveTenantId = "01JTESTT031LIVE00000000004";
    const nowMs = Date.now();

    // Simulate backup restore resurrecting a previously purged tenant as `active` alongside a healthy live tenant
    await seedTenantInPlatform({
      tenantId: purgedTenantId,
      orgId: "org_t031_purged",
      handle: "t031-purged",
      name: "Restored Purged Tenant",
      host: "t031-purged.situsku.click",
      status: "active",
    });
    await seedTenantInPlatform({
      tenantId: liveTenantId,
      orgId: "org_t031_live",
      handle: "t031-live",
      name: "Healthy Live Tenant",
      host: "t031-live.situsku.click",
      status: "active",
    });

    // Record the authoritative tombstone from before the restore
    await recordDeletionTombstone(env.PLATFORM_DB, {
      id: "tmb_t031_001",
      tenantId: purgedTenantId,
      handle: "t031-purged",
      reason: "DEC-022 unpaid H+45 offboarding",
      deletedBy: "system:offboarding",
      deletedAtMs: nowMs - 2 * DAY_MS,
      quarantineUntilMs: nowMs + 28 * DAY_MS,
    });

    // Simulate restored R2 objects for both tenants
    const resurrectedMedia = `t/${purgedTenantId}/media/hero.webp`;
    const resurrectedQuarantine = `t/${purgedTenantId}/quarantine/temp.jpg`;
    const liveMedia = `t/${liveTenantId}/media/hero.webp`;

    await Promise.all([
      env.MEDIA_BUCKET.put(resurrectedMedia, "resurrected-media"),
      env.MEDIA_BUCKET.put(resurrectedQuarantine, "resurrected-quarantine"),
      env.MEDIA_BUCKET.put(liveMedia, "live-media"),
    ]);

    const replay1 = await replayDeletionTombstones({
      platformDb: env.PLATFORM_DB,
      mediaBucket: env.MEDIA_BUCKET,
      nowMs,
    });

    expect(replay1.tombstonesScanned).toBeGreaterThanOrEqual(1);
    expect(replay1.tenantsRePurged).toBe(1);
    expect(replay1.hostsNeutralized).toBe(1);
    expect(replay1.r2ObjectsDeleted).toBe(2);
    expect(replay1.tenantIdsProcessed).toContain(purgedTenantId);

    const purgedRow = await env.PLATFORM_DB.prepare(
      "SELECT status, cache_version FROM tenants WHERE id = ?",
    )
      .bind(purgedTenantId)
      .first<{ status: string; cache_version: number }>();
    expect(purgedRow).toEqual({ status: "purged", cache_version: 2 });

    const purgedHost = await env.PLATFORM_DB.prepare(
      "SELECT status, is_primary FROM tenant_hosts WHERE tenant_id = ?",
    )
      .bind(purgedTenantId)
      .first<{ status: string; is_primary: number }>();
    expect(purgedHost).toEqual({ status: "deleting", is_primary: 0 });

    // Resurrected R2 objects are gone; live tenant and its R2 objects remain untouched
    expect(await env.MEDIA_BUCKET.head(resurrectedMedia)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(resurrectedQuarantine)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(liveMedia)).not.toBeNull();

    const liveRow = await env.PLATFORM_DB.prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(liveTenantId)
      .first<{ status: string }>();
    expect(liveRow?.status).toBe("active");

    // Replay is idempotent
    const replay2 = await replayDeletionTombstones({
      platformDb: env.PLATFORM_DB,
      mediaBucket: env.MEDIA_BUCKET,
      nowMs: nowMs + 1000,
    });
    expect(replay2.tenantsRePurged).toBe(0);
    expect(replay2.hostsNeutralized).toBe(0);
    expect(replay2.r2ObjectsDeleted).toBe(0);
  });

  it("executes privacy.retention_sweep and cron.hourly_housekeeping idempotently through TASK-028 Durable Queue without logging PII", async () => {
    const queueTenantId = "01JTESTT031QUEUE0000000005";
    await seedTenantInPlatform({
      tenantId: queueTenantId,
      orgId: "org_t031_q",
      handle: "t031-queue",
      name: "T031 Queue Tenant",
      host: "t031-queue.situsku.click",
      status: "active",
    });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stub = openTenantStoreStub(ns, queueTenantId);
    await orchestrateTenantMigration(env.PLATFORM_DB, stub, queueTenantId, TENANT_MIGRATIONS);

    const dbQ = createTenantDb(stub);
    const nowMs = Date.now() + 2 * DAY_MS;

    // Seed one expired lead containing sensitive PII to verify zero PII leakage in queue logs
    await dbQ
      .prepare(
        `INSERT INTO leads (id, name, phone_e164, email, message, status, created_at, updated_at)
         VALUES (1, 'Rahasia Pelanggan', '+6285799991111', 'rahasia@contoh.id', 'Isi pesan sensitif sekali', 'closed', ?, ?)`,
      )
      .bind(nowMs - 200 * DAY_MS, nowMs - 200 * DAY_MS)
      .run();

    const logs: Record<string, unknown>[] = [];
    const summaries: RetentionQueueSummary[] = [];
    const registry = createRetentionJobRegistry({
      logger: (entry) => logs.push(entry),
      onSweepCompleted: (summary) => {
        summaries.push(summary);
      },
    });

    const envelope: JobEnvelopeInput = {
      idempotencyKey: "t031-retention-sweep-001",
      topic: RETENTION_SWEEP_TOPIC,
      tenantId: queueTenantId,
      payload: { nowMs },
      correlationId: "corr-t031-q1",
    };

    // Deliver duplicate messages in the same batch -> executes once, deduplicates second
    const { batch, acked } = buildBatch([
      { id: "m-ret-1", body: envelope },
      { id: "m-ret-2", body: envelope },
    ]);

    const res = await processDurableQueueBatch(batch, env, registry, {
      now: () => nowMs,
      logger: (entry) => logs.push(entry),
    });

    expect(res.completed).toBe(1);
    expect(res.deduplicated).toBe(1);
    expect(acked.has("m-ret-1")).toBe(true);
    expect(acked.has("m-ret-2")).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.tenantResults[0]?.deleted.leads).toBe(1);

    const leadCount = await dbQ
      .prepare("SELECT COUNT(*) AS cnt FROM leads")
      .first<{ cnt: number }>();
    expect(leadCount?.cnt).toBe(0);

    // Also verify platform-wide cron.hourly_housekeeping topic compatibility across >1 keyset page
    const extraTenantIds = ["tnt_t031_page_02", "tnt_t031_page_03"];
    const nowBase = Date.now();
    for (let i = 0; i < extraTenantIds.length; i += 1) {
      const tid = extraTenantIds[i]!;
      await seedTenantInPlatform({
        tenantId: tid,
        orgId: `org_t031_page_${i + 2}`,
        handle: `page-tenant-${i + 2}`,
        name: `Page Tenant ${i + 2}`,
        host: `page-tenant-${i + 2}.situsku.click`,
        status: "active",
      });
      const extraStub = openTenantStoreStub(ns, tid);
      await orchestrateTenantMigration(env.PLATFORM_DB, extraStub, tid, TENANT_MIGRATIONS);
      const extraDb = createTenantDb(extraStub);
      await extraDb
        .prepare(
          `INSERT INTO leads (id, name, phone_e164, message, status, created_at, updated_at)
           VALUES (1, 'Expired Page Lead', '+628123450000', 'Old lead', 'closed', ?, ?)`,
        )
        .bind(nowBase - 200 * DAY_MS, nowBase - 200 * DAY_MS)
        .run();
    }

    const cronBatch = buildBatch([
      {
        id: "m-cron-housekeeping",
        body: {
          idempotencyKey: "t031-hourly-housekeeping-001",
          topic: HOURLY_HOUSEKEEPING_TOPIC,
          tenantId: null,
          // pageSize: 2 across >= 3 tenants proves keyset pagination sweeps beyond page 1
          payload: { nowMs, pageSize: 2 },
        },
      },
    ]);
    const cronRes = await processDurableQueueBatch(cronBatch.batch, env, registry, {
      now: () => nowMs,
      logger: (entry) => logs.push(entry),
    });
    expect(cronRes.completed).toBe(1);
    expect(cronBatch.acked.has("m-cron-housekeeping")).toBe(true);
    const cronSummary = summaries[summaries.length - 1];
    expect(cronSummary?.tenantsSwept).toBeGreaterThanOrEqual(3);
    for (const tid of extraTenantIds) {
      const swept = cronSummary?.tenantResults.find((r) => r.tenantId === tid);
      expect(swept?.deleted.leads).toBe(1);
    }

    // Assert zero PII leaked into structured logs
    const serializedLogs = JSON.stringify(logs);
    for (const pii of [
      "Rahasia Pelanggan",
      "+6285799991111",
      "rahasia@contoh.id",
      "Isi pesan sensitif sekali",
    ]) {
      expect(serializedLogs).not.toContain(pii);
    }
  });
});
