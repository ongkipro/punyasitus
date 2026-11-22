import { createMessageBatch } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { JobEnvelopeInput } from "@punyasitus/core/jobs/index";
import type { StructuredTelemetryEvent } from "@punyasitus/core/telemetry/index";
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
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import {
  handleBackupHealthProbe,
  handleDbHealthProbe,
  handleJobsHealthProbe,
  handleLivenessProbe,
} from "../../apps/web/src/pages/api/health/probe-helpers.ts";
import {
  processDurableQueueBatch,
  type DurableJobRegistry,
} from "../../apps/web/src/worker/queues/index.ts";
import {
  DAILY_PLATFORM_BACKUP_TOPIC,
  PLATFORM_BACKUP_LATEST_KEY,
  computeSha256Hex,
  createDailyBackupQueueHandler,
  runDailyPlatformBackup,
  runIsolatedRestoreDrill,
  type PlatformBackupManifest,
  type RunDailyPlatformBackupResult,
} from "../../scripts/backup-restore/index.ts";

const HOUR_MS = 60 * 60 * 1000;

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

function buildQueueBatch(messages: readonly { id: string; body: unknown }[]) {
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
  const retried = new Set<string>();

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
      retried.add(msg.id);
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
  return { batch, acked, retried };
}

describe("TASK-037 Telemetry, Daily Backups, Isolated Restore Drill & Health Endpoints (workerd)", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("exports coherent PLATFORM_DB logical SQL + SHA-256 manifest via cron.daily_platform_backup and executes an isolated restore drill with TenantStore PITR bookmark, R2 media & tombstone replay", async () => {
    const liveTenantId = "01JTESTT037LIVE0000000001";
    const purgedTenantId = "01JTESTT037PURGED00000002";
    const backupNowMs = Date.UTC(2026, 10, 22, 7, 7, 0);

    // 1. Seed two tenants (both active at snapshot time T0 — purgedTenant will be offboarded after snapshot!)
    await seedTenantInPlatform({
      tenantId: liveTenantId,
      orgId: "org_t037_live",
      handle: "t037-live-shop",
      name: "Toko Live T037",
      host: "t037-live-shop.situsku.click",
      status: "active",
    });
    await seedTenantInPlatform({
      tenantId: purgedTenantId,
      orgId: "org_t037_purged",
      handle: "t037-purged-shop",
      name: "Toko Purged T037",
      host: "t037-purged-shop.situsku.click",
      status: "active",
    });

    // Seed an append-only platform_audit row to prove trigger creation does not block SQL restore
    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO platform_audit (
         id, actor_user_id, actor_role, action, target_type, target_id,
         tenant_id, reason, outcome, request_id, metadata_json, created_at
       ) VALUES (?, NULL, 'operator', 'tenant.provision', 'tenant', ?, ?, 'Initial seed for drill', 'success', 'req_t037_seed', '{}', ?)`,
    )
      .bind("aud_t037_1", liveTenantId, liveTenantId, backupNowMs - 60_000)
      .run();

    // 2. Migrate live TenantStore DO (captures PITR bookmark into PLATFORM_DB.migration_bookmarks)
    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const liveStub = openTenantStoreStub(ns, liveTenantId);
    const liveMig = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      liveStub,
      liveTenantId,
      TENANT_MIGRATIONS,
      { now: () => backupNowMs - 30_000 },
    );
    expect(liveMig.httpStatus).toBe(200);
    expect(liveMig.bookmark).toBeTruthy();

    const liveTenantDb = createTenantDb(liveStub);
    const liveHeroKey = `t/${liveTenantId}/media/hero-v1.webp`;
    const purgedLeakKey = `t/${purgedTenantId}/media/leaked-photo.webp`;

    await liveTenantDb
      .prepare(
        `INSERT OR IGNORE INTO pages (id, slug, title, is_homepage, status, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Toko Live', 1, 'published', ?, ?)`,
      )
      .bind(backupNowMs - 20_000, backupNowMs - 20_000)
      .run();

    await liveTenantDb
      .prepare(
        `INSERT OR IGNORE INTO media_items (
           id, kind, status, r2_key, mime_type, bytes, sha256, alt_text, created_at, updated_at
         ) VALUES (1, 'image', 'ready', ?, 'image/webp', 1024, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'Hero Banner', ?, ?)`,
      )
      .bind(liveHeroKey, backupNowMs - 15_000, backupNowMs - 15_000)
      .run();

    // Seed R2 media objects for both tenants (purgedTenant's object represents a pre-offboarding media restore)
    await env.MEDIA_BUCKET.put(liveHeroKey, "webp-live-bytes", {
      httpMetadata: { contentType: "image/webp" },
    });
    await env.MEDIA_BUCKET.put(purgedLeakKey, "webp-should-stay-purged", {
      httpMetadata: { contentType: "image/webp" },
    });

    // 3. Execute daily backup via Durable Queue consumer (`cron.daily_platform_backup`)
    const telemetryEvents: StructuredTelemetryEvent[] = [];
    let backupResult: RunDailyPlatformBackupResult | undefined;

    const registry: DurableJobRegistry = {
      [DAILY_PLATFORM_BACKUP_TOPIC]: createDailyBackupQueueHandler({
        telemetrySink: (e) => telemetryEvents.push(e),
        onBackupCompleted: (res) => {
          backupResult = res;
        },
      }),
    };

    const backupEnvelope: JobEnvelopeInput = {
      idempotencyKey: "cron:daily-platform-backup:2026-11-22",
      topic: DAILY_PLATFORM_BACKUP_TOPIC,
      tenantId: null,
      payload: {},
      correlationId: "corr_t037_backup_20261122",
      enqueuedAt: backupNowMs,
    };

    const { batch, acked } = buildQueueBatch([{ id: "msg_backup_1", body: backupEnvelope }]);
    const queueRes = await processDurableQueueBatch(batch, env, registry, {
      now: () => backupNowMs,
    });

    expect(queueRes.completed).toBe(1);
    expect(queueRes.deadLettered).toBe(0);
    expect(acked.has("msg_backup_1")).toBe(true);
    expect(backupResult).toBeDefined();
    expect(backupResult!.snapshotKey).toBe("platform-db/2026-11-22/snapshot.sql");
    expect(backupResult!.manifestKey).toBe("platform-db/2026-11-22/manifest.json");
    expect(backupResult!.latestKey).toBe(PLATFORM_BACKUP_LATEST_KEY);

    // Verify objects exist in BACKUP_BUCKET with matching SHA-256
    const snapshotObj = await env.BACKUP_BUCKET.get(backupResult!.snapshotKey);
    const manifestObj = await env.BACKUP_BUCKET.get(backupResult!.manifestKey);
    const latestObj = await env.BACKUP_BUCKET.get(PLATFORM_BACKUP_LATEST_KEY);
    expect(snapshotObj).not.toBeNull();
    expect(manifestObj).not.toBeNull();
    expect(latestObj).not.toBeNull();

    const snapshotSql = await snapshotObj!.text();
    const manifest = JSON.parse(await manifestObj!.text()) as PlatformBackupManifest;
    expect(await computeSha256Hex(snapshotSql)).toBe(manifest.sha256);
    expect(manifest.tableCount).toBeGreaterThanOrEqual(20);
    expect(manifest.tableRowCounts.tenants).toBeGreaterThanOrEqual(2);
    expect(manifest.tableRowCounts.migration_bookmarks).toBeGreaterThanOrEqual(1);

    // Duplicate delivery deduplicates cleanly without re-executing
    const dup = buildQueueBatch([{ id: "msg_backup_dup", body: backupEnvelope }]);
    const dupRes = await processDurableQueueBatch(dup.batch, env, registry, {
      now: () => backupNowMs + 1000,
    });
    expect(dupRes.deduplicated).toBe(1);
    expect(dupRes.completed).toBe(0);

    // 4. Execute isolated restore drill into a fresh isolated SQLite target DB (separate DO instance)
    const isolatedTargetStub = openTenantStoreStub(ns, "isolated-restore-drill-target-t037");
    const targetPlatformDb = createTenantDb(isolatedTargetStub);
    const verifiedBookmarks: string[] = [];

    const drillNowMs = backupNowMs + 2 * HOUR_MS;
    const drillResult = await runIsolatedRestoreDrill({
      backupBucket: env.BACKUP_BUCKET,
      snapshotKey: backupResult!.snapshotKey,
      targetPlatformDb,
      tenantStoreNamespace: ns,
      mediaBucket: env.MEDIA_BUCKET,
      tenantSnapshots: [
        {
          tenantId: liveTenantId,
          expectedBookmark: liveMig.bookmark ?? undefined,
          expectedMinRecords: 2,
          expectedMediaKeys: [liveHeroKey],
          verifyBookmarkRestore(bm) {
            verifiedBookmarks.push(bm);
            return bm.length > 0;
          },
        },
      ],
      // Simulate purgedTenantId having been offboarded AFTER the snapshot was taken (DEC-022)
      authoritativeTombstones: [
        {
          id: "tomb_t037_purged",
          tenantId: purgedTenantId,
          handle: "t037-purged-shop",
          reason: "H+45 offboarding purge (DEC-022)",
          deletedBy: "op_t037",
          deletedAtMs: backupNowMs + HOUR_MS,
        },
      ],
      nowMs: drillNowMs,
      requestId: "drill_t037_001",
      telemetrySink: (e) => telemetryEvents.push(e),
    });

    expect(drillResult.ok).toBe(true);
    expect(drillResult.checksumVerified).toBe(true);
    expect(drillResult.platformDb.rowCountsMatched).toBe(true);
    expect(drillResult.platformDb.statementsExecuted).toBeGreaterThan(20);
    expect(drillResult.postReplayVerified).toBe(true);

    // Active tenant recovered cleanly with PITR bookmark + live TenantStore records + R2 media
    const liveCheck = drillResult.tenantChecks.find((c) => c.tenantId === liveTenantId);
    expect(liveCheck).toBeDefined();
    expect(liveCheck?.coherent).toBe(true);
    expect(liveCheck?.bookmarkMatched).toBe(true);
    expect(liveCheck?.liveRecordCount).toBeGreaterThanOrEqual(2);
    expect(verifiedBookmarks).toEqual([liveMig.bookmark!]);
    expect(drillResult.mediaCheck.missingKeys).toEqual([]);
    expect(drillResult.mediaCheck.checkedKeys).toContain(liveHeroKey);

    // Tombstoned tenant stayed purged after restore (DB status + neutralized host + deleted R2 object)
    expect(drillResult.tombstoneReplay.tombstonesScanned).toBeGreaterThanOrEqual(1);
    expect(drillResult.tombstoneReplay.tenantsRePurged).toBeGreaterThanOrEqual(1);
    expect(drillResult.tombstoneReplay.hostsNeutralized).toBeGreaterThanOrEqual(1);
    expect(drillResult.tombstoneReplay.r2ObjectsDeleted).toBe(1);

    const restoredPurgedTenant = await targetPlatformDb
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(purgedTenantId)
      .first<{ status: string }>();
    expect(restoredPurgedTenant?.status).toBe("purged");

    const restoredPurgedHost = await targetPlatformDb
      .prepare("SELECT status, is_primary FROM tenant_hosts WHERE tenant_id = ?")
      .bind(purgedTenantId)
      .first<{ status: string; is_primary: number }>();
    expect(restoredPurgedHost?.status).toBe("deleting");
    expect(restoredPurgedHost?.is_primary).toBe(0);

    // Purged media object was deleted while active tenant's media object remains intact
    expect(await env.MEDIA_BUCKET.head(purgedLeakKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(liveHeroKey)).not.toBeNull();

    // Restored platform_audit append-only trigger is active on the restored target DB
    await expect(
      targetPlatformDb
        .prepare("DELETE FROM platform_audit WHERE id = ?")
        .bind("aud_t037_1")
        .run(),
    ).rejects.toThrow(/append-only/i);

    // Telemetry events emitted for both backup and restore drill without sensitive data
    expect(telemetryEvents.some((e) => e.operation === "backup.daily_platform_db")).toBe(true);
    expect(telemetryEvents.some((e) => e.operation === "backup.isolated_restore_drill")).toBe(true);
  });

  it("serves safe non-config health/readiness endpoints (200 healthy, degraded on stale/dead-letter, 503 on DB outage)", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 10, 0, 0);

    // 1. /api/health (liveness)
    const liveRes = handleLivenessProbe({ nowMs });
    expect(liveRes.status).toBe(200);
    expect(liveRes.headers.get("cache-control")).toBe("no-store");
    expect(liveRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await liveRes.json()).toEqual({
      status: "ok",
      service: "punyasitus-web",
      timestamp: new Date(nowMs).toISOString(),
    });

    // 2. /api/health/db (healthy real D1 + 503 outage)
    const dbOkRes = await handleDbHealthProbe({ platformDb: env.PLATFORM_DB, nowMs });
    expect(dbOkRes.status).toBe(200);
    expect(await dbOkRes.json()).toMatchObject({
      status: "ok",
      service: "punyasitus-web",
    });

    const brokenDb = {
      prepare() {
        throw new Error("SECRET_BINDING_PLATFORM_DB_STACK_TRACE");
      },
    } as unknown as D1Database;
    const dbFailRes = await handleDbHealthProbe({ platformDb: brokenDb, nowMs });
    expect(dbFailRes.status).toBe(503);
    const dbFailBody = await dbFailRes.text();
    expect(JSON.parse(dbFailBody)).toMatchObject({
      status: "degraded",
      service: "punyasitus-web",
    });
    expect(dbFailBody).not.toContain("SECRET_BINDING");
    expect(dbFailBody).not.toContain("STACK_TRACE");

    // 3. /api/health/backup against real BACKUP_BUCKET (fresh after daily backup -> 200 ok; +27h -> degraded stale)
    const backupAtMs = Date.UTC(2026, 10, 22, 7, 7, 0);
    await runDailyPlatformBackup({
      platformDb: env.PLATFORM_DB,
      backupBucket: env.BACKUP_BUCKET,
      nowMs: backupAtMs,
      telemetrySink: () => {},
    });

    const backupFreshRes = await handleBackupHealthProbe({
      backupBucket: env.BACKUP_BUCKET,
      nowMs: backupAtMs + HOUR_MS, // +1h after 07:07 UTC backup
    });
    expect(backupFreshRes.status).toBe(200);
    const backupFreshText = await backupFreshRes.text();
    expect(JSON.parse(backupFreshText)).toMatchObject({
      status: "ok",
      service: "punyasitus-web",
      freshness: "ok",
      ageSeconds: 3600,
    });
    expect(backupFreshText).not.toContain("punyasitus-backup");
    expect(backupFreshText).not.toContain("platform-db/");

    const backupStaleRes = await handleBackupHealthProbe({
      backupBucket: env.BACKUP_BUCKET,
      nowMs: Date.UTC(2026, 10, 23, 10, 7, 0), // +27h after 07:07 UTC backup (> 26h)
    });
    expect(backupStaleRes.status).toBe(200);
    expect(await backupStaleRes.json()).toMatchObject({
      status: "degraded",
      service: "punyasitus-web",
      freshness: "stale",
    });

    // 4. /api/health/jobs against real PLATFORM_DB (fresh Advice job -> ok; dead-letter job -> degraded without payload leak)
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO job_ledger (
         idempotency_key, topic, tenant_id, status, attempts, lease_until,
         last_error_code, payload_json, created_at, updated_at
       ) VALUES (?, 'cron.billing_advice_sweep', NULL, 'completed', 1, NULL, NULL, '{"secret":"never_leak_payload"}', ?, ?)`,
    )
      .bind("t037_advice_ok", nowMs - 600_000, nowMs - 300_000)
      .run();

    const jobsOkRes = await handleJobsHealthProbe({ platformDb: env.PLATFORM_DB, nowMs });
    expect(jobsOkRes.status).toBe(200);
    const jobsOkText = await jobsOkRes.text();
    expect(JSON.parse(jobsOkText)).toMatchObject({
      status: "ok",
      service: "punyasitus-web",
      deadLetterCount: 0,
      staleRunningCount: 0,
      advice: {
        status: "ok",
        ageSeconds: 300,
      },
    });
    expect(jobsOkText).not.toContain("never_leak_payload");

    // Seed a dead-letter job with sensitive payload and verify degraded status with zero payload leak
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO job_ledger (
         idempotency_key, topic, tenant_id, status, attempts, lease_until,
         last_error_code, payload_json, created_at, updated_at
       ) VALUES (?, 'media.transform', '01JTESTT037LIVE0000000001', 'dead_letter', 3, NULL, 'UPSTREAM_TIMEOUT', '{"apiKey":"sk_live_secret_job_payload"}', ?, ?)`,
    )
      .bind("t037_dlq_1", nowMs - 1000, nowMs - 500)
      .run();

    const jobsDegradedRes = await handleJobsHealthProbe({ platformDb: env.PLATFORM_DB, nowMs });
    expect(jobsDegradedRes.status).toBe(200);
    const jobsDegradedText = await jobsDegradedRes.text();
    expect(JSON.parse(jobsDegradedText)).toMatchObject({
      status: "degraded",
      deadLetterCount: 1,
    });
    expect(jobsDegradedText).not.toContain("sk_live_secret_job_payload");

    // Clean up our synthetic dead_letter row so PLATFORM_DB remains clean
    await env.PLATFORM_DB.prepare("DELETE FROM job_ledger WHERE idempotency_key IN (?, ?)")
      .bind("t037_dlq_1", "t037_advice_ok")
      .run();

    // DB outage returns 503 with zero leaked details
    const jobsOutageRes = await handleJobsHealthProbe({ platformDb: brokenDb, nowMs });
    expect(jobsOutageRes.status).toBe(503);
    const jobsOutageText = await jobsOutageRes.text();
    expect(jobsOutageText).not.toContain("SECRET_BINDING");
  });
});
