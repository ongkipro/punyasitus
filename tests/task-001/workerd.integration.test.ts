import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  TenantMigrationRecoveryError,
  type MigrationDescriptor,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  abuseReports,
  billingObligations,
  CrossTenantAccessError,
  createTenantScopedPlatformRepo,
  organizations,
  paymentAttempts,
  PLATFORM_MIGRATIONS,
  platformAudit,
  platformSchema,
  receipts,
  resolveHostRecord,
  servicePackages,
  serviceRequests,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import {
  leads,
  offerings,
  pages,
  TENANT_MIGRATIONS,
  tenantActivityLog,
  tenantSchema,
} from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const EXPECTED_PLATFORM_TABLES = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "organizations",
  "members",
  "invitations",
  "platform_operators",
  "tenants",
  "tenant_hosts",
  "migration_bookmarks",
  "deletion_tombstones",
  "billing_obligations",
  "payment_attempts",
  "settlements",
  "receipts",
  "coupons",
  "agencies",
  "affiliates",
  "affiliate_commissions",
  "affiliate_payout_batches",
  "service_packages",
  "service_requests",
  "marketing_funnel_events",
  "abuse_reports",
  "platform_settings",
  "platform_audit",
  "email_suppressions",
  "job_ledger",
] as const;

const EXPECTED_TENANT_TABLES = [
  "site_settings",
  "business_profile",
  "branches",
  "menus",
  "pages",
  "posts",
  "offerings",
  "taxonomies",
  "resource_slugs",
  "content_revisions",
  "media_items",
  "storage_usage",
  "tenant_forms",
  "leads",
  "analytics_daily",
  "analytics_hourly_sources",
  "analytics_event_dedup",
  "ai_writing_usage",
  "tenant_activity_log",
  "installed_plugins",
] as const;

async function listSqliteTables(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return res.results.map((r) => r.name);
}

async function seedSyntheticTenantInPlatformDb(
  db: D1Database,
  opts: {
    tenantId: string;
    orgId: string;
    handle: string;
    name: string;
    host: string;
    status?: "provisioning" | "trial" | "active";
  },
) {
  const now = new Date();
  const drizzleDb = createSqliteDrizzle(db, platformSchema);
  await drizzleDb
    .insert(organizations)
    .values({
      id: opts.orgId,
      name: opts.name,
      slug: opts.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await drizzleDb
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

  await drizzleDb
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

describe("TASK-001 Multi-Tenant Database Schema & Drizzle Migrations on workerd", () => {
  it("applies fresh and idempotent upgrade migrations to PLATFORM_DB (D1) and enforces constraints", async () => {
    const first = await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    expect(first.applied).toEqual(["0001_initial_platform"]);
    expect(first.skipped).toEqual([]);
    expect(first.currentVersion).toBe(1);

    const tables = await listSqliteTables(env.PLATFORM_DB);
    for (const table of EXPECTED_PLATFORM_TABLES) {
      expect(tables).toContain(table);
    }

    // Re-running is idempotent
    const second = await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001_initial_platform"]);
    expect(second.currentVersion).toBe(1);

    // Seed synthetic tenant and test tenant_hosts invariants
    const t0 = SYNTHETIC_TENANTS[0];
    const t1 = SYNTHETIC_TENANTS[1];
    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: t0.id,
      orgId: "org_alpha",
      handle: t0.handle,
      name: t0.siteTitle,
      host: t0.subdomainHost,
    });
    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: t1.id,
      orgId: "org_beta",
      handle: t1.handle,
      name: t1.siteTitle,
      host: t1.subdomainHost,
    });

    const now = new Date();
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    // Partial unique index: a second primary domain for the same tenant must fail
    await expect(
      pDb.insert(tenantHosts).values({
        host: "www.alpha-example.id",
        tenantId: t0.id,
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // Non-primary custom domain for the same tenant succeeds
    await pDb.insert(tenantHosts).values({
      host: "www.alpha-example.id",
      tenantId: t0.id,
      kind: "custom",
      status: "pending",
      sslStatus: "pending",
      isPrimary: false,
      createdAt: now,
      updatedAt: now,
    });

    // Global hostname uniqueness: another tenant cannot claim the same hostname
    await expect(
      pDb.insert(tenantHosts).values({
        host: "www.alpha-example.id",
        tenantId: t1.id,
        kind: "custom",
        status: "pending",
        sslStatus: "pending",
        isPrimary: false,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // Append-only trigger on platform_audit (proves trigger-safe SQL migration execution on D1)
    await pDb.insert(platformAudit).values({
      id: "aud_001",
      actorRole: "system",
      action: "tenant.provision",
      targetType: "tenant",
      targetId: t0.id,
      tenantId: t0.id,
      outcome: "success",
      createdAt: now,
    });
    await expect(
      env.PLATFORM_DB.prepare("UPDATE platform_audit SET action = 'tampered' WHERE id = ?")
        .bind("aud_001")
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.PLATFORM_DB.prepare("DELETE FROM platform_audit WHERE id = ?")
        .bind("aud_001")
        .run(),
    ).rejects.toThrow(/append-only/);

    // Additive upgrade migration on PLATFORM_DB preserves existing rows
    const upgradeMigrations: readonly MigrationDescriptor[] = [
      ...PLATFORM_MIGRATIONS,
      {
        version: 2,
        name: "0002_test_platform_additive_upgrade",
        sql: "ALTER TABLE platform_settings ADD COLUMN description TEXT;",
      },
    ];
    const upgraded = await applyPlatformMigrations(env.PLATFORM_DB, upgradeMigrations);
    expect(upgraded.applied).toEqual(["0002_test_platform_additive_upgrade"]);
    expect(upgraded.skipped).toEqual(["0001_initial_platform"]);
    expect(upgraded.currentVersion).toBe(2);

    const alphaRow = await pDb.select().from(tenants).where(eq(tenants.id, t0.id));
    expect(alphaRow[0]?.handle).toBe(t0.handle);
  });

  it("migrates TenantStore DOs with PITR bookmarks, upgrades idempotently, and preserves adapter semantics", async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const migTenantId = "01JTESTTENANTMIGR000000004";
    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: migTenantId,
      orgId: "org_mig",
      handle: "delta-mig",
      name: "Delta Migration Fixture",
      host: "delta-mig.situsku.click",
    });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stub = openTenantStoreStub(ns, migTenantId);
    const doId = env.TENANT_STORE.idFromName(migTenantId);
    const rawDoStub = env.TENANT_STORE.get(doId);

    // Obtain a real SQLite DO PITR bookmark from workerd before migrating
    const migrated = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stub,
      migTenantId,
      TENANT_MIGRATIONS,
      {
        getBookmark: () =>
          runInDurableObject(rawDoStub, (_instance, state) => state.storage.getCurrentBookmark()),
      },
    );
    expect(migrated.outcome).toBe("migrated");
    expect(migrated.httpStatus).toBe(200);
    expect(migrated.applied).toEqual(["0001_initial_tenant"]);
    expect(migrated.bookmarkId).toBeTruthy();
    expect(migrated.bookmark).toBeTruthy();
    expect(migrated.schemaVersion).toBe(1);

    // Verify bookmark row in PLATFORM_DB.migration_bookmarks is marked applied
    const bmRow = await env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id, target_version, target_migration, bookmark, status FROM migration_bookmarks WHERE id = ?",
    )
      .bind(migrated.bookmarkId)
      .first<{
        id: string;
        tenant_id: string;
        target_version: number;
        target_migration: string;
        bookmark: string;
        status: string;
      }>();
    expect(bmRow).toEqual({
      id: migrated.bookmarkId,
      tenant_id: migTenantId,
      target_version: 1,
      target_migration: "0001_initial_tenant",
      bookmark: migrated.bookmark,
      status: "applied",
    });

    // Verify all v1 TenantStore core tables exist
    const dbA = createTenantDb(stub);
    const tenantTables = await listSqliteTables(dbA);
    for (const table of EXPECTED_TENANT_TABLES) {
      expect(tenantTables).toContain(table);
    }

    // Re-running orchestration is an idempotent no-op
    const rerun = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stub,
      migTenantId,
      TENANT_MIGRATIONS,
    );
    expect(rerun.outcome).toBe("up_to_date");
    expect(rerun.applied).toEqual([]);
    expect(rerun.bookmarkId).toBeNull();

    // Verify D1Database-compatible RPC adapter semantics: changes, last_row_id, raw({ columnNames: true })
    const nowMs = Date.now();
    const insertRes = await dbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, status, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Delta', 1, 'published', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();
    expect(insertRes.success).toBe(true);
    expect(insertRes.meta.changes).toBe(1);
    expect(insertRes.meta.last_row_id).toBe(1);

    const updateRes = await dbA
      .prepare("UPDATE pages SET title = ?, version = version + 1 WHERE id = ?")
      .bind("Beranda Delta Updated", 1)
      .run();
    expect(updateRes.meta.changes).toBe(1);

    const rawWithCols = await dbA
      .prepare("SELECT id, slug, title FROM pages WHERE id = ?")
      .bind(1)
      .raw({ columnNames: true });
    expect(rawWithCols[0]).toEqual(["id", "slug", "title"]);
    expect(rawWithCols[1]).toEqual([1, "beranda", "Beranda Delta Updated"]);

    // Verify atomic transactionSync rollback on batch error
    await expect(
      dbA.batch([
        dbA
          .prepare(
            "INSERT INTO sequences (kind, next) VALUES ('pages', 2) ON CONFLICT (kind) DO UPDATE SET next = next + 1",
          ),
        dbA
          .prepare(
            `INSERT INTO pages (id, slug, title, is_homepage, status, created_at, updated_at)
             VALUES (2, 'tentang', 'Tentang', 0, 'draft', ?, ?)`,
          )
          .bind(nowMs, nowMs),
        // Duplicate slug forces UNIQUE constraint failure and rolls back BOTH prior statements
        dbA
          .prepare(
            `INSERT INTO pages (id, slug, title, is_homepage, status, created_at, updated_at)
             VALUES (3, 'beranda', 'Duplicate', 0, 'draft', ?, ?)`,
          )
          .bind(nowMs, nowMs),
      ]),
    ).rejects.toThrow();

    const seqAfterRollback = await dbA
      .prepare("SELECT next FROM sequences WHERE kind = 'pages'")
      .first<{ next: number }>();
    expect(seqAfterRollback).toBeNull();
    const pagesCount = await dbA
      .prepare("SELECT COUNT(*) AS cnt FROM pages")
      .first<{ cnt: number }>();
    expect(pagesCount?.cnt).toBe(1);

    // Additive upgrade migration on TenantStore preserves existing rows
    const tenantUpgrade: readonly MigrationDescriptor[] = [
      ...TENANT_MIGRATIONS,
      {
        version: 2,
        name: "0002_test_tenant_additive_upgrade",
        sql: "ALTER TABLE site_settings ADD COLUMN custom_note TEXT;",
      },
    ];
    const upgraded = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stub,
      migTenantId,
      tenantUpgrade,
      {
        getBookmark: () =>
          runInDurableObject(rawDoStub, (_instance, state) => state.storage.getCurrentBookmark()),
      },
    );
    expect(upgraded.outcome).toBe("migrated");
    expect(upgraded.applied).toEqual(["0002_test_tenant_additive_upgrade"]);
    expect(upgraded.schemaVersion).toBe(2);

    const existingPage = await dbA
      .prepare("SELECT slug, title FROM pages WHERE id = 1")
      .first<{ slug: string; title: string }>();
    expect(existingPage).toEqual({ slug: "beranda", title: "Beranda Delta Updated" });
  });

  it("records PITR bookmark before failing migration, rolls back DO, and marks tenant recovery (503)", async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    const failingTenantId = "01JTESTTENANTFAIL000000003";
    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: failingTenantId,
      orgId: "org_fail",
      handle: "gamma-fail",
      name: "Gamma Failure Fixture",
      host: "gamma-fail.situsku.click",
      status: "active",
    });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stub = openTenantStoreStub(ns, failingTenantId);
    const doId = env.TENANT_STORE.idFromName(failingTenantId);
    const rawDoStub = env.TENANT_STORE.get(doId);

    // Apply valid v1 first
    const v1 = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stub,
      failingTenantId,
      TENANT_MIGRATIONS,
      {
        getBookmark: () =>
          runInDurableObject(rawDoStub, (_instance, state) => state.storage.getCurrentBookmark()),
      },
    );
    expect(v1.outcome).toBe("migrated");

    // Attempt broken v2 migration (valid DDL followed by invalid SQL)
    const brokenMigrations: readonly MigrationDescriptor[] = [
      ...TENANT_MIGRATIONS,
      {
        version: 2,
        name: "0002_broken_migration",
        sql: `
          CREATE TABLE _should_be_rolled_back (id INTEGER PRIMARY KEY);
          ALTER TABLE does_not_exist ADD COLUMN broken TEXT;
        `,
      },
    ];

    const failure = await orchestrateTenantMigration(
      env.PLATFORM_DB,
      stub,
      failingTenantId,
      brokenMigrations,
      {
        getBookmark: () =>
          runInDurableObject(rawDoStub, (_instance, state) => state.storage.getCurrentBookmark()),
      },
    );

    expect(failure.outcome).toBe("recovery");
    expect(failure.httpStatus).toBe(503);
    expect(failure.bookmarkId).toBeTruthy();
    expect(failure.bookmark).toBeTruthy();
    expect(failure.error).toBeTruthy();

    // 1. Pre-migration PITR bookmark was recorded and marked failed with error details
    const failedBm = await env.PLATFORM_DB.prepare(
      "SELECT status, bookmark, error_message FROM migration_bookmarks WHERE id = ?",
    )
      .bind(failure.bookmarkId)
      .first<{ status: string; bookmark: string; error_message: string | null }>();
    expect(failedBm?.status).toBe("failed");
    expect(failedBm?.bookmark).toBe(failure.bookmark);
    expect(failedBm?.error_message).toBeTruthy();

    // 2. Tenant status flipped to 'recovery' and cache_version bumped
    const tenantRow = await env.PLATFORM_DB.prepare(
      "SELECT status, cache_version, schema_version FROM tenants WHERE id = ?",
    )
      .bind(failingTenantId)
      .first<{ status: string; cache_version: number; schema_version: number }>();
    expect(tenantRow).toEqual({
      status: "recovery",
      cache_version: 2,
      schema_version: 1,
    });

    // 3. Partial DDL inside TenantStore was atomically rolled back
    const dbFail = createTenantDb(stub);
    const leaked = await dbFail
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_should_be_rolled_back'")
      .first<{ name: string }>();
    expect(leaked).toBeNull();

    const ledgerRows = await dbFail
      .prepare("SELECT name FROM _tenant_migrations ORDER BY id ASC")
      .all<{ name: string }>();
    expect(ledgerRows.results.map((r) => r.name)).toEqual(["0001_initial_tenant"]);

    // 4. Subsequent migration calls refuse auto-migration and serve 503 recovery
    await expect(
      orchestrateTenantMigration(env.PLATFORM_DB, stub, failingTenantId, TENANT_MIGRATIONS, {
        throwOnFailure: true,
      }),
    ).rejects.toBeInstanceOf(TenantMigrationRecoveryError);
  });

  it("physically isolates two concurrent tenants in TenantStore DOs and rejects cross-tenant PLATFORM_DB queries", async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);

    const alpha = SYNTHETIC_TENANTS[0];
    const beta = SYNTHETIC_TENANTS[1];

    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: alpha.id,
      orgId: "org_alpha",
      handle: alpha.handle,
      name: alpha.siteTitle,
      host: alpha.subdomainHost,
    });
    await seedSyntheticTenantInPlatformDb(env.PLATFORM_DB, {
      tenantId: beta.id,
      orgId: "org_beta",
      handle: beta.handle,
      name: beta.siteTitle,
      host: beta.subdomainHost,
    });

    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stubA = openTenantStoreStub(ns, alpha.id);
    const stubB = openTenantStoreStub(ns, beta.id);

    // Migrate both tenants concurrently
    const [migA, migB] = await Promise.all([
      orchestrateTenantMigration(env.PLATFORM_DB, stubA, alpha.id, TENANT_MIGRATIONS),
      orchestrateTenantMigration(env.PLATFORM_DB, stubB, beta.id, TENANT_MIGRATIONS),
    ]);
    expect(migA.httpStatus).toBe(200);
    expect(migB.httpStatus).toBe(200);

    const drizzleA = createSqliteDrizzle(createTenantDb(stubA), tenantSchema);
    const drizzleB = createSqliteDrizzle(createTenantDb(stubB), tenantSchema);
    const now = new Date();

    // Concurrent writes with identical sequential IDs & slugs into two separate DOs
    await Promise.all([
      (async () => {
        await drizzleA.insert(pages).values({
          id: 1,
          slug: "beranda",
          title: "Alpha Home",
          isHomepage: true,
          status: "published",
          createdAt: now,
          updatedAt: now,
        });
        await drizzleA.insert(offerings).values({
          id: 1,
          offeringType: "service",
          slug: "desain-web",
          title: "Jasa Desain Alpha",
          priceMode: "fixed",
          price: 2_500_000,
          ctaMode: "whatsapp",
          status: "published",
          createdAt: now,
          updatedAt: now,
        });
        await drizzleA.insert(leads).values({
          id: 1,
          name: "Budi Alpha",
          phoneE164: "+6281200000001",
          message: "Tanya layanan Alpha",
          status: "new",
          createdAt: now,
          updatedAt: now,
        });
        await drizzleA.insert(tenantActivityLog).values({
          actorRole: "owner",
          action: "page.publish",
          resourceType: "page",
          resourceId: "1",
          summary: "Published Alpha Home",
          createdAt: now,
        });
      })(),
      (async () => {
        await drizzleB.insert(pages).values({
          id: 1,
          slug: "beranda",
          title: "Beta Klinik Home",
          isHomepage: true,
          status: "published",
          createdAt: now,
          updatedAt: now,
        });
        await drizzleB.insert(offerings).values({
          id: 1,
          offeringType: "service",
          slug: "konsultasi-gigi",
          title: "Konsultasi Beta",
          priceMode: "from",
          price: 150_000,
          ctaMode: "book",
          status: "published",
          createdAt: now,
          updatedAt: now,
        });
        await drizzleB.insert(leads).values({
          id: 1,
          name: "Siti Beta",
          phoneE164: "+6281200000002",
          message: "Booking klinik Beta",
          status: "new",
          createdAt: now,
          updatedAt: now,
        });
      })(),
    ]);

    const [pagesA, pagesB, leadsA, leadsB, offeringsA, offeringsB] = await Promise.all([
      drizzleA.select().from(pages),
      drizzleB.select().from(pages),
      drizzleA.select().from(leads),
      drizzleB.select().from(leads),
      drizzleA.select().from(offerings),
      drizzleB.select().from(offerings),
    ]);

    expect(pagesA.map((p) => p.title)).toEqual(["Alpha Home"]);
    expect(pagesB.map((p) => p.title)).toEqual(["Beta Klinik Home"]);
    expect(leadsA.map((l) => l.name)).toEqual(["Budi Alpha"]);
    expect(leadsB.map((l) => l.name)).toEqual(["Siti Beta"]);
    expect(offeringsA.map((o) => o.slug)).toEqual(["desain-web"]);
    expect(offeringsB.map((o) => o.slug)).toEqual(["konsultasi-gigi"]);

    // Seed cross-tenant PLATFORM_DB records for both Alpha and Beta
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb
      .insert(users)
      .values([
        {
          id: "usr_alpha",
          name: "Owner Alpha",
          email: "owner@alpha.example",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "usr_beta",
          name: "Owner Beta",
          email: "owner@beta.example",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();

    await pDb
      .insert(servicePackages)
      .values({
        id: "pkg_setup",
        kind: "setup",
        slug: "setup-basic",
        name: "Setup Basic",
        description: "Initial setup service",
        priceIdr: 500_000,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await pDb.insert(billingObligations).values([
      {
        id: "obl_alpha",
        tenantId: alpha.id,
        payerType: "tenant",
        planInterval: "monthly",
        grossAmountIdr: 179_000,
        netAmountIdr: 179_000,
        dueAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "obl_beta",
        tenantId: beta.id,
        payerType: "tenant",
        planInterval: "yearly",
        grossAmountIdr: 1_790_000,
        netAmountIdr: 1_790_000,
        dueAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await pDb.insert(paymentAttempts).values([
      {
        id: "pay_alpha",
        obligationId: "obl_alpha",
        tenantId: alpha.id,
        channel: "QRIS",
        amountIdr: 179_000,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pay_beta",
        obligationId: "obl_beta",
        tenantId: beta.id,
        channel: "VA",
        amountIdr: 1_790_000,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await pDb.insert(receipts).values([
      {
        id: "rcp_alpha",
        tenantId: alpha.id,
        receiptNumber: "PS-2026-00001",
        amountIdr: 179_000,
        r2PdfKey: `t/${alpha.id}/receipts/PS-2026-00001.pdf`,
        issuedAt: now,
        createdAt: now,
      },
      {
        id: "rcp_beta",
        tenantId: beta.id,
        receiptNumber: "PS-2026-00002",
        amountIdr: 1_790_000,
        r2PdfKey: `t/${beta.id}/receipts/PS-2026-00002.pdf`,
        issuedAt: now,
        createdAt: now,
      },
    ]);

    await pDb.insert(serviceRequests).values({
      id: "sreq_beta",
      tenantId: beta.id,
      packageId: "pkg_setup",
      requestedByUserId: "usr_beta",
      briefJson: "{}",
      createdAt: now,
      updatedAt: now,
    });

    await pDb.insert(abuseReports).values({
      id: "abr_beta",
      tenantId: beta.id,
      reportedHost: beta.subdomainHost,
      reportedPath: "/spam",
      category: "spam",
      details: "Synthetic abuse report fixture",
      createdAt: now,
      updatedAt: now,
    });

    // Verify tenant-scoped PLATFORM_DB repositories reject cross-tenant queries
    const repoA = createTenantScopedPlatformRepo(env.PLATFORM_DB, { tenantId: alpha.id });
    const repoB = createTenantScopedPlatformRepo(env.PLATFORM_DB, { tenantId: beta.id });

    // Alpha reads its own resources
    expect((await repoA.getTenant())?.id).toBe(alpha.id);
    expect((await repoA.getHost(alpha.subdomainHost))?.tenantId).toBe(alpha.id);
    expect((await repoA.getBillingObligationById("obl_alpha"))?.tenantId).toBe(alpha.id);
    expect((await repoA.getPaymentAttemptById("pay_alpha"))?.tenantId).toBe(alpha.id);
    expect((await repoA.getReceiptById("rcp_alpha"))?.tenantId).toBe(alpha.id);

    // Alpha CANNOT read Beta's resources (returns null)
    expect(await repoA.getHost(beta.subdomainHost)).toBeNull();
    expect(await repoA.getBillingObligationById("obl_beta")).toBeNull();
    expect(await repoA.getPaymentAttemptById("pay_beta")).toBeNull();
    expect(await repoA.getReceiptById("rcp_beta")).toBeNull();
    expect(await repoA.getServiceRequestById("sreq_beta")).toBeNull();
    expect(await repoA.getAbuseReportById("abr_beta")).toBeNull();
    if (migB.bookmarkId) {
      expect(await repoA.getMigrationBookmarkById(migB.bookmarkId)).toBeNull();
    }

    // Beta reads its own resources and CANNOT read Alpha's
    expect((await repoB.getServiceRequestById("sreq_beta"))?.tenantId).toBe(beta.id);
    expect((await repoB.getAbuseReportById("abr_beta"))?.tenantId).toBe(beta.id);
    expect(await repoB.getBillingObligationById("obl_alpha")).toBeNull();

    // Explicit ownership guard throws CrossTenantAccessError (404, non-leaking per PLAN §4)
    expect(() => repoA.assertTenantOwnership(alpha.id)).not.toThrow();
    expect(() => repoA.assertTenantOwnership(beta.id)).toThrow(CrossTenantAccessError);
    try {
      repoA.assertTenantOwnership(beta.id);
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantAccessError);
      expect((err as CrossTenantAccessError).status).toBe(404);
      expect((err as CrossTenantAccessError).code).toBe("NOT_FOUND");
    }

    // Authoritative host resolution maps each host strictly to its owning tenant
    const resolvedAlpha = await resolveHostRecord(env.PLATFORM_DB, alpha.subdomainHost.toUpperCase());
    const resolvedBeta = await resolveHostRecord(env.PLATFORM_DB, beta.subdomainHost);
    expect(resolvedAlpha?.tenantId).toBe(alpha.id);
    expect(resolvedBeta?.tenantId).toBe(beta.id);
    expect(await resolveHostRecord(env.PLATFORM_DB, "unknown-host.situsku.click")).toBeNull();
  });
});
