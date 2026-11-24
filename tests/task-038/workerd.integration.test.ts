import { env } from "cloudflare:workers";
import { AuthorizationError } from "@punyasitus/auth/permissions";
import { resolveAuthorizedTenantMember } from "@punyasitus/auth/session-guard";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage, publishPage } from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import {
  PLATFORM_PLUGIN_RUNTIME_MIGRATION,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/migrations";
import {
  listDeletionTombstones,
  recordDeletionTombstone,
  replayDeletionTombstones,
} from "@punyasitus/db/privacy/index";
import { clearHostResolutionCache, evictHostFromCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS,
  DEFAULT_PLUGIN_REGISTRY,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  buildTenantEdgeCacheKey,
  routeEdgeRequest,
  STATE_PAGE_MESSAGES,
  type TenantGateEnv,
} from "../../apps/web/src/core/tenant.ts";
import {
  exportPlatformDbLogicalSql,
  runDailyPlatformBackup,
  runIsolatedRestoreDrill,
} from "../../scripts/backup-restore/index.ts";

const ACTIVE_TENANT = {
  id: "01JT038ACTIVE0000000000001",
  orgId: "org_t038_active",
  handle: "t038-active",
  name: "PT Release Aktif Nusantara",
  host: "t038-active.situsku.click",
  userId: "usr_t038_active_owner",
  email: "active@t038.example",
  mediaKey: "t/01JT038ACTIVE0000000000001/media/cover.webp",
} as const;

const PURGED_TENANT = {
  id: "01JT038PURGED0000000000002",
  orgId: "org_t038_purged",
  handle: "t038-purged",
  name: "CV Release Terhapus",
  host: "t038-purged.situsku.click",
  userId: "usr_t038_purged_owner",
  email: "purged@t038.example",
  mediaKey: "t/01JT038PURGED0000000000002/media/legacy.webp",
} as const;

function buildGateEnv(): TenantGateEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function getDefaultCache(): Cache {
  return (caches as unknown as { readonly default: Cache }).default;
}

async function seedTenant(
  t: typeof ACTIVE_TENANT | typeof PURGED_TENANT,
): Promise<{ readonly tenantDb: D1Database; readonly bookmark: string | null }> {
  const now = new Date();
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await db
    .insert(users)
    .values({
      id: t.userId,
      email: t.email,
      name: t.name,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(organizations)
    .values({
      id: t.orgId,
      name: t.name,
      slug: t.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(members)
    .values({
      id: `mem_${t.handle}`,
      organizationId: t.orgId,
      userId: t.userId,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenants)
    .values({
      id: t.id,
      organizationId: t.orgId,
      handle: t.handle,
      name: t.name,
      vertical: "compro",
      status: "active",
      operatorHold: false,
      paidThrough: new Date(Date.now() + 30 * 86_400_000),
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(tenantHosts)
    .values({
      host: t.host,
      tenantId: t.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      verifiedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    t.id,
  );
  const mig = await orchestrateTenantMigration(env.PLATFORM_DB, stub, t.id, [
    ...TENANT_MIGRATIONS,
    TENANT_PLUGIN_LEDGER_MIGRATION,
  ]);
  return { tenantDb: createTenantDb(stub), bookmark: mig.bookmark ?? null };
}

describe("TASK-038 Full Production Release Gate (M1 + M2) — Workerd Integration", () => {
  let activeTenantDb: D1Database;
  let activeBookmark: string | null = null;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, [
      ...PLATFORM_MIGRATIONS,
      PLATFORM_PLUGIN_RUNTIME_MIGRATION,
    ]);
    const seededActive = await seedTenant(ACTIVE_TENANT);
    activeTenantDb = seededActive.tenantDb;
    activeBookmark = seededActive.bookmark;
    await seedTenant(PURGED_TENANT);

    const nowMs = Date.now();
    await activeTenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, ?, 'Release Gate Aktif', 'compro', 1, 1, 'disallow', 1, ?)`,
      )
      .bind(ACTIVE_TENANT.name, nowMs)
      .run();

    const home = await createPage(activeTenantDb, {
      title: "Beranda Release Aktif",
      slug: "beranda",
      isHomepage: true,
      sections: [],
    });
    await publishPage(env.PLATFORM_DB, activeTenantDb, {
      tenantId: ACTIVE_TENANT.id,
      pageId: home.id,
      expectedVersion: home.version,
      actorUserId: ACTIVE_TENANT.userId,
    });

    await activeTenantDb
      .prepare(
        `INSERT OR REPLACE INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, alt_text, status, version, created_at, updated_at)
         VALUES (1, 'image', ?, 'image/webp', 128, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'Cover aktif', 'ready', 1, ?, ?)`,
      )
      .bind(ACTIVE_TENANT.mediaKey, nowMs, nowMs)
      .run();
  });

  it("1. Registers all 5 official Frozen-Core plugins cleanly with ONLY seo-ai-autopilot default-active (DEC-042)", () => {
    const plugins = DEFAULT_PLUGIN_REGISTRY.list();
    const ids = plugins.map((p) => p.manifest.id).sort();
    expect(ids).toEqual([
      "bio-links",
      "lead-notifier",
      "seo-ai-autopilot",
      "wa-cs-rotator",
      "wp-importer",
    ]);
    expect([...DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS]).toEqual(["seo-ai-autopilot"]);
  });

  it("2. Executes real workerd platform-backup.ts export, isolated restore drill & direct product-code replayDeletionTombstones (DEC-022)", async () => {
    await env.MEDIA_BUCKET.put(ACTIVE_TENANT.mediaKey, "active-webp-payload");
    await env.MEDIA_BUCKET.put(PURGED_TENANT.mediaKey, "purged-webp-payload-must-be-deleted");

    const backupTimeMs = Date.now();
    // 2a. Verify real product-code deterministic logical SQL export (`platform-backup.ts`)
    const logicalExport = await exportPlatformDbLogicalSql(env.PLATFORM_DB);
    expect(logicalExport.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(logicalExport.tableCount).toBeGreaterThan(10);

    const backup = await runDailyPlatformBackup({
      platformDb: env.PLATFORM_DB,
      backupBucket: env.BACKUP_BUCKET,
      nowMs: backupTimeMs,
      requestId: "t038-workerd-backup-001",
      telemetrySink: () => {},
    });
    expect(backup.manifest.sha256).toBe(logicalExport.sha256);

    // 2b. Isolate target D1 database via separate TenantStore DO SQLite DB and run isolated restore drill
    const isolatedTargetStub = openTenantStoreStub(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      "01JT038RESTORETARGET000001",
    );
    const isolatedTargetDb = createTenantDb(isolatedTargetStub);

    const drill = await runIsolatedRestoreDrill({
      backupBucket: env.BACKUP_BUCKET,
      snapshotKey: backup.snapshotKey,
      targetPlatformDb: isolatedTargetDb,
      tenantStoreNamespace: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      mediaBucket: env.MEDIA_BUCKET,
      tenantSnapshots: [
        {
          tenantId: ACTIVE_TENANT.id,
          expectedBookmark: activeBookmark ?? undefined,
          expectedMinRecords: 2,
          expectedMediaKeys: [ACTIVE_TENANT.mediaKey],
          verifyBookmarkRestore: (bm) => bm.length > 0,
        },
      ],
      authoritativeTombstones: [
        {
          id: "tomb_t038_workerd_001",
          tenantId: PURGED_TENANT.id,
          handle: PURGED_TENANT.handle,
          reason: "offboarding_completed_after_backup_dec_022",
          deletedBy: PURGED_TENANT.userId,
          deletedAtMs: backupTimeMs + 30_000,
        },
      ],
      nowMs: backupTimeMs + 60_000,
      requestId: "t038-workerd-drill-001",
      telemetrySink: () => {},
    });

    expect(drill.ok).toBe(true);
    expect(drill.checksumVerified).toBe(true);
    expect(drill.platformDb.rowCountsMatched).toBe(true);
    expect(drill.postReplayVerified).toBe(true);
    expect(drill.tombstoneReplay.tenantsRePurged).toBe(1);
    expect(drill.tombstoneReplay.r2ObjectsDeleted).toBe(1);
    expect(drill.mediaCheck.missingKeys).toEqual([]);
    expect(drill.mediaCheck.verifiedCount).toBeGreaterThanOrEqual(1);

    // 2c. Direct idempotency & resurrection-prevention verification against product code `replayDeletionTombstones`
    const tombstones = await listDeletionTombstones(isolatedTargetDb);
    expect(tombstones.some((t) => t.tenantId === PURGED_TENANT.id)).toBe(true);

    // Simulate a resurrected R2 leak for the tombstoned tenant & re-run real product-code `replayDeletionTombstones`
    const leakKey = `t/${PURGED_TENANT.id}/media/resurrected-object.webp`;
    await env.MEDIA_BUCKET.put(leakKey, "must-be-purged-by-product-replay");
    await recordDeletionTombstone(isolatedTargetDb, {
      id: "tomb_t038_workerd_001",
      tenantId: PURGED_TENANT.id,
      handle: PURGED_TENANT.handle,
      reason: "offboarding_completed_after_backup_dec_022",
      deletedBy: PURGED_TENANT.userId,
      deletedAtMs: backupTimeMs + 30_000,
    });
    const directReplay = await replayDeletionTombstones({
      platformDb: isolatedTargetDb,
      mediaBucket: env.MEDIA_BUCKET,
      nowMs: backupTimeMs + 90_000,
    });
    expect(directReplay.tombstonesScanned).toBeGreaterThanOrEqual(1);
    expect(directReplay.r2ObjectsDeleted).toBe(1);
    expect(await env.MEDIA_BUCKET.head(leakKey)).toBeNull();

    // Confirm active tenant stayed intact & purged tenant stayed purged in isolated restored DB
    const activeAfter = await isolatedTargetDb
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(ACTIVE_TENANT.id)
      .first<{ status: string }>();
    const purgedAfter = await isolatedTargetDb
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(PURGED_TENANT.id)
      .first<{ status: string }>();
    expect(activeAfter?.status).toBe("active");
    expect(purgedAfter?.status).toBe("purged");
    expect(await env.MEDIA_BUCKET.head(ACTIVE_TENANT.mediaKey)).not.toBeNull();
    expect(await env.MEDIA_BUCKET.head(PURGED_TENANT.mediaKey)).toBeNull();
  });

  it("3. Enforces cross-tenant neutral 404 isolation and warm-cache suspension 503 no-store noindex", async () => {
    clearHostResolutionCache();

    // Cross-tenant A -> B membership MUST throw 404 AuthorizationError
    let err: unknown = null;
    try {
      await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: ACTIVE_TENANT.userId,
        handle: PURGED_TENANT.handle,
        requiredPermission: "content:read",
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).status).toBe(404);

    // Warm edge cache for ACTIVE_TENANT, suspend it, and prove immediate 503 no-store noindex
    const cache = getDefaultCache();
    const warmKey = buildTenantEdgeCacheKey(ACTIVE_TENANT.id, 1, ACTIVE_TENANT.host, "/");
    await cache.put(
      warmKey,
      new Response("<h1>Cached Release Gate HTML</h1>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db
      .update(tenants)
      .set({ status: "suspended", operatorHold: true })
      .where(eq(tenants.id, ACTIVE_TENANT.id));
    evictHostFromCache(ACTIVE_TENANT.host);

    const res = await routeEdgeRequest(
      new Request(`https://${ACTIVE_TENANT.host}/`),
      buildGateEnv(),
      {
        cache,
        render: () => new Response("must-not-serve", { status: 200 }),
      },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const html = await res.text();
    expect(html).toContain(STATE_PAGE_MESSAGES.suspended);
    expect(html).not.toContain("Cached Release Gate HTML");
  });
});
