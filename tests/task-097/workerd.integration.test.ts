import { env } from "cloudflare:workers";
import { PluginSqlViolationError } from "@punyasitus/core/plugins/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  getLeadNotificationSettings,
  LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID,
  updateLeadNotificationSettings,
} from "@punyasitus/db/leads/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  createScopedPluginTenantDb,
  grantTenantPluginEntitlement,
  listInstalledPlugins,
  revokeTenantPluginEntitlement,
  runPluginMigrations,
  TENANT_PLUGIN_LEDGER_MIGRATION,
  upsertPluginCatalogEntry,
} from "@punyasitus/db/plugins/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../apps/web/src/core/plugin-registry.ts";
import {
  dispatchPluginPublicRoute,
  invokePluginMcpTool,
  listPluginMcpToolsForTenant,
  PluginRuntimeError,
  renderPluginPublicSection,
} from "../../apps/web/src/core/plugin-runtime.ts";
import { handlePluginInboundWebhook } from "../../apps/web/src/pages/api/plugins/[pluginId]/webhook.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/index.ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import { resolvePluginAdminServerContext } from "../../apps/web/src/pages/dashboard/[handle]/plugins/_server-context.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createPluginJobRegistry,
  enqueuePluginDomainEvent,
  runCoreWriteWithIsolatedPluginHooks,
} from "../../apps/web/src/worker/queues/plugins/index.ts";
import {
  createSyntheticProbePlugin,
  OVER_BUDGET_JS_BYTES,
  SYNTHETIC_WEBHOOK_SECRET,
} from "./synthetic-plugin.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 23, 5, 0, 0);
const TEST_GET_BOOKMARK = async () => `bm_real_pitr_${NOW_MS}`;

const TENANT_A = {
  id: "01JT097TENANTALPHA00000001",
  orgId: "org_t097_alpha",
  handle: "alpha-probe",
  name: "Alpha Probe Studio",
  ownerId: "user_t097_owner_a",
  editorId: "user_t097_editor_a",
};

const TENANT_B = {
  id: "01JT097TENANTBETA000000002",
  orgId: "org_t097_beta",
  handle: "beta-unentitled",
  name: "Beta Unentitled Co",
  ownerId: "user_t097_owner_b",
};

function getTenantStoreNs(): TenantStoreNamespaceLike {
  return env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
}

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: getTenantStoreNs(),
  };
}

function makeAppRequest(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly origin?: string | null;
    readonly headers?: Record<string, string>;
  } = {},
): Request {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (init.origin !== null) {
      headers.set("Origin", init.origin ?? APP_ORIGIN);
    }
    headers.set("Sec-Fetch-Site", "same-origin");
    if ((init.body !== undefined || init.rawBody !== undefined) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body:
      init.rawBody !== undefined
        ? init.rawBody
        : init.body !== undefined
          ? JSON.stringify(init.body)
          : undefined,
  });
}

async function seedTenantFixture(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerId: string;
  readonly editorId?: string;
  readonly status?: string;
  readonly operatorHold?: number;
  readonly paidThrough?: number | null;
}) {
  const db = env.PLATFORM_DB;
  const paidThrough = spec.paidThrough === undefined ? NOW_MS + 30 * 86_400_000 : spec.paidThrough;

  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    )
    .bind(`mem_${spec.ownerId}`, spec.orgId, spec.ownerId, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, NOW_MS, NOW_MS)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, ?, ?, 1, 1, 1, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.orgId,
      spec.handle,
      spec.name,
      spec.status ?? "active",
      spec.operatorHold ?? 0,
      paidThrough,
      NOW_MS,
      NOW_MS,
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
    )
    .bind(`${spec.handle}.situsku.click`, spec.id, NOW_MS, NOW_MS)
    .run();

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  const mig = await orchestrateTenantMigration(
    db,
    stub,
    spec.id,
    [...TENANT_MIGRATIONS, TENANT_PLUGIN_LEDGER_MIGRATION],
    { now: () => NOW_MS },
  );
  expect(mig.httpStatus).toBe(200);
}

describe("TASK-097 Frozen-Core Plugin Runtime, plg_* TenantStore Isolation & 5-Slot Integration", () => {
  const probePlugin = createSyntheticProbePlugin();
  const paidPlugin = createSyntheticProbePlugin({
    id: "paid-rotator",
    visibility: "public_paid",
    priceIdr: 149_000,
  });
  const privatePlugin = createSyntheticProbePlugin({
    id: "client-bespoke",
    visibility: "private_client",
    priceIdr: 0,
  });
  const registry = createPluginRegistry([probePlugin, paidPlugin, privatePlugin]);

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => NOW_MS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB, () => NOW_MS);
    await seedTenantFixture(TENANT_A);
    await seedTenantFixture(TENANT_B);
    await upsertPluginCatalogEntry(env.PLATFORM_DB, probePlugin.manifest, NOW_MS);
    await upsertPluginCatalogEntry(env.PLATFORM_DB, paidPlugin.manifest, NOW_MS);
    await upsertPluginCatalogEntry(env.PLATFORM_DB, privatePlugin.manifest, NOW_MS);
  });

  beforeEach(async () => {
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', operator_hold = 0, paid_through = ?, trial_ends_at = NULL WHERE id IN (?, ?)",
    )
      .bind(NOW_MS + 30 * 86_400_000, TENANT_A.id, TENANT_B.id)
      .run();
  });

  it("filters builtin:lead-email-notifications cleanly across list, detail, and [...subpath] routes", async () => {
    const tenantADb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));

    await updateLeadNotificationSettings(tenantADb, {
      emailEnabled: true,
      updatedBy: TENANT_A.ownerId,
      nowMs: NOW_MS,
    });

    const installed = await listInstalledPlugins(tenantADb);
    expect(installed.some((r) => r.pluginId === LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID)).toBe(false);

    const listRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { readonly items: readonly { readonly id: string }[] };
    expect(listBody.items.some((p) => p.id.startsWith("builtin:"))).toBe(false);

    // Reject builtin:* on detail PATCH
    const disableRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID,
      makeAppRequest(
        `/api/tenants/${TENANT_A.handle}/plugins/${encodeURIComponent(LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID)}`,
        { method: "PATCH", body: { enabled: false } },
      ),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(disableRes.status).toBe(404);

    // Reject builtin:* on [...subpath] API
    const subpathRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID,
      "/settings",
      makeAppRequest(
        `/api/tenants/${TENANT_A.handle}/plugins/${encodeURIComponent(LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID)}/settings`,
      ),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(subpathRes.status).toBe(404);

    const leadPref = await getLeadNotificationSettings(tenantADb);
    expect(leadPref.emailEnabled).toBe(true);
  });

  it("Slot 1: fails closed without PITR bookmark, installs with PITR bookmark, rejects non-plg_* DDL & SQL escapes in real SQLite, supports scopedDb.batch, and preserves plg_* on disable", async () => {
    const stubA = openTenantStoreStub(getTenantStoreNs(), TENANT_A.id);
    const tenantADb = createTenantDb(stubA);
    const stubB = openTenantStoreStub(getTenantStoreNs(), TENANT_B.id);
    const tenantBDb = createTenantDb(stubB);

    // Fail-closed PITR negative test: without getCurrentBookmark/getBookmark, ZERO DDL runs!
    await expect(
      runPluginMigrations(
        env.PLATFORM_DB,
        stubA,
        TENANT_A.id,
        "synthetic-probe",
        probePlugin.migrations!,
        { now: () => NOW_MS },
      ),
    ).rejects.toMatchObject({
      name: "PluginMigrationError",
      code: "PITR_BOOKMARK_UNAVAILABLE",
    });

    const tableBeforeInstall = await tenantADb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plg_%'")
      .all();
    expect(tableBeforeInstall.results.length).toBe(0);

    // Negative test: non-plg_* DDL rejected BEFORE bookmarking
    await expect(
      runPluginMigrations(
        env.PLATFORM_DB,
        stubA,
        TENANT_A.id,
        "synthetic-probe",
        [
          {
            version: 1,
            name: "0001_evil_ddl",
            sql: "CREATE TABLE /* smuggle */ leads_hijack (id INT); DROP TABLE leads;",
          },
        ],
        { getBookmark: TEST_GET_BOOKMARK, now: () => NOW_MS },
      ),
    ).rejects.toThrow(PluginSqlViolationError);

    // Paid plugin without entitlement -> 403; Private plugin without grant -> 404
    const unentitledPaidRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: "paid-rotator" },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(unentitledPaidRes.status).toBe(403);

    const unentitledPrivateRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: "client-bespoke" },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(unentitledPrivateRes.status).toBe(404);

    // Install public_free `synthetic-probe` on Tenant A with verified PITR bookmark
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: "synthetic-probe" },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);
    const installBody = (await installRes.json()) as {
      readonly plugin: { readonly id: string; readonly enabled: boolean; readonly schemaVersion: number };
      readonly migration: { readonly outcome: string; readonly bookmarkId: string | null };
    };
    expect(installBody.plugin.id).toBe("synthetic-probe");
    expect(installBody.plugin.enabled).toBe(true);
    expect(installBody.plugin.schemaVersion).toBe(1);
    expect(installBody.migration.outcome).toBe("migrated");
    expect(installBody.migration.bookmarkId).toBeTruthy();

    const bmRow = await env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id, target_migration, bookmark, status FROM migration_bookmarks WHERE id = ?",
    )
      .bind(installBody.migration.bookmarkId)
      .first<{
        readonly id: string;
        readonly tenant_id: string;
        readonly target_migration: string;
        readonly bookmark: string;
        readonly status: string;
      }>();
    expect(bmRow?.tenant_id).toBe(TENANT_A.id);
    expect(bmRow?.bookmark).toBe(`bm_real_pitr_${NOW_MS}`);
    expect(bmRow?.target_migration).toBe("plugin:synthetic-probe:0001_init_probe_tables");
    expect(bmRow?.status).toBe("applied");

    // Verify `plg_*` tables exist ONLY in Tenant A, NOT in Tenant B
    const tableA = await tenantADb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plg_synthetic_probe__items'")
      .first<{ readonly name: string }>();
    expect(tableA?.name).toBe("plg_synthetic_probe__items");

    const tableB = await tenantBDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plg_%'")
      .all();
    expect(tableB.results.length).toBe(0);

    // Real SQLite `workerd` verification of `scopedDb.batch([...])` + raw statement rejection
    const scopedDb = createScopedPluginTenantDb("synthetic-probe", tenantADb);
    const batchResults = await scopedDb.batch([
      scopedDb
        .prepare("INSERT INTO plg_synthetic_probe__items (label, created_at) VALUES (?, ?)")
        .bind("Batch Item 1", NOW_MS),
      scopedDb
        .prepare("INSERT INTO plg_synthetic_probe__items (label, created_at) VALUES (?, ?)")
        .bind("Batch Item 2", NOW_MS + 1),
    ]);
    expect(batchResults).toHaveLength(2);

    // Unscoped raw statement passed to scopedDb.batch MUST be rejected
    await expect(
      scopedDb.batch([tenantADb.prepare("SELECT * FROM leads")]),
    ).rejects.toThrow(/PLUGIN_SCOPED_DB_VIOLATION/);

    // Real SQLite `workerd` regression tests for ALL SQL sandbox escape payloads (incl. bare `IN <table>`)!
    const escapePayloads = [
      "WITH leads AS (SELECT 1) UPDATE leads SET name = 'hacked'",
      "WITH leads AS (SELECT 1) DELETE FROM leads",
      "SELECT * FROM (leads)",
      "SELECT * FROM ((leads))",
      "SELECT * FROM plg_synthetic_probe__items JOIN (leads) ON 1",
      "SELECT * FROM (leads JOIN plg_synthetic_probe__items ON 1)",
      "SELECT * FROM plg_synthetic_probe__items JOIN plg_synthetic_probe__events ON 1, leads",
      "SELECT * FROM plg_synthetic_probe__items NOT INDEXED, leads",
      "SELECT * FROM plg_synthetic_probe__items INDEXED BY plg_synthetic_probe__items_created_idx, leads",
      "SELECT id FROM plg_synthetic_probe__items WHERE id IN leads",
      "DELETE FROM plg_synthetic_probe__items WHERE id NOT IN leads",
      "SELECT id FROM plg_synthetic_probe__items WHERE 1 IN main.leads",
      "SELECT id FROM plg_synthetic_probe__items WHERE label IN pragma_table_info('leads')",
      "SELECT id FROM plg_synthetic_probe__items WHERE (id IN leads)",
    ];
    for (const payload of escapePayloads) {
      expect(() => scopedDb.prepare(payload), `Escape payload must fail: ${payload}`).toThrow(
        PluginSqlViolationError,
      );
    }

    // Valid parenthesized `IN (1, 2, 3)` and `IN (SELECT ... FROM plg_*)` execute cleanly in real SQLite!
    const inListRows = await scopedDb
      .prepare("SELECT id FROM plg_synthetic_probe__items WHERE id IN (1, 2, 3)")
      .all();
    expect(inListRows.results.length).toBeGreaterThanOrEqual(2);
    const inSubqueryRows = await scopedDb
      .prepare(
        "SELECT id FROM plg_synthetic_probe__items WHERE id IN (SELECT id FROM plg_synthetic_probe__items)",
      )
      .all();
    expect(inSubqueryRows.results.length).toBeGreaterThanOrEqual(2);

    // Write item via Slot 3 scoped API
    const addRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      "synthetic-probe",
      "/items",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe/items`, {
        method: "POST",
        body: { label: "Item Preserved Across Disable" },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(addRes.status).toBe(201);

    // Disable preserves `plg_*` rows intact
    const disableRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(disableRes.status).toBe(200);

    const preservedRow = await tenantADb
      .prepare("SELECT label FROM plg_synthetic_probe__items WHERE label = ?")
      .bind("Item Preserved Across Disable")
      .first<{ readonly label: string }>();
    expect(preservedRow?.label).toBe("Item Preserved Across Disable");

    // Re-enable restores access
    const reenableRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { enabled: true },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(reenableRes.status).toBe(200);
  });

  it("Slot 2: enforces <= 25 KiB real emitted JS budget, strict header allowlist, and 0 queries / 0 bytes for unentitled Tenant B", async () => {
    let tenantBStoreOpens = 0;
    let tenantBPluginQueries = 0;

    const sectionB = await renderPluginPublicSection(
      {
        platformDb: env.PLATFORM_DB,
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          tenantBStoreOpens += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
        },
        scopedDbOptions: {
          onQuery: () => {
            tenantBPluginQueries += 1;
          },
        },
      },
      {
        tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
        sectionId: "synthetic-probe-banner",
      },
    );
    expect(sectionB).toBeNull();

    const routeB = await dispatchPluginPublicRoute(
      {
        platformDb: env.PLATFORM_DB,
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          tenantBStoreOpens += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
        },
        scopedDbOptions: {
          onQuery: () => {
            tenantBPluginQueries += 1;
          },
        },
      },
      {
        tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
        request: new Request(`https://${TENANT_B.handle}.situsku.click/probe-widget`),
        pathname: "/probe-widget",
      },
    );
    expect(routeB).toBeNull();
    expect(tenantBStoreOpens).toBe(0);
    expect(tenantBPluginQueries).toBe(0);

    // Test strict response header allowlist: forbidden Location/Refresh/Set-Cookie/Link stripped!
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: {
          config: {
            bannerLabel: "Promo Aktif",
            emitForbiddenHeaders: true,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );

    const routeA = await dispatchPluginPublicRoute(
      {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS,
      },
      {
        tenant: { id: TENANT_A.id, handle: TENANT_A.handle, name: TENANT_A.name, status: "active" },
        request: new Request(`https://${TENANT_A.handle}.situsku.click/probe-widget`),
        pathname: "/probe-widget",
      },
    );
    expect(routeA).not.toBeNull();
    expect(routeA!.status).toBe(200);
    expect(routeA!.headers.get("Location")).toBeNull();
    expect(routeA!.headers.get("Refresh")).toBeNull();
    expect(routeA!.headers.get("Set-Cookie")).toBeNull();
    expect(routeA!.headers.get("Link")).toBeNull();
    expect(routeA!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(routeA!.headers.get("X-Plugin-Version")).toBe("1.0.0");

    // Negative test 1: Under-reported real emitted <script> > 25 KiB MUST be rejected!
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: {
          config: {
            bannerLabel: "Promo Aktif",
            emitSneakyOverBudgetScript: true,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );

    await expect(
      dispatchPluginPublicRoute(
        {
          platformDb: env.PLATFORM_DB,
          tenantStore: getTenantStoreNs(),
          registry,
          nowMs: NOW_MS,
        },
        {
          tenant: { id: TENANT_A.id, handle: TENANT_A.handle, name: TENANT_A.name, status: "active" },
          request: new Request(`https://${TENANT_A.handle}.situsku.click/probe-widget`),
          pathname: "/probe-widget",
        },
      ),
    ).rejects.toThrow(PluginRuntimeError);

    // Negative test 2: Self-reported > 25 KiB also rejected
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: {
          config: {
            bannerLabel: "Promo Aktif",
            publicJsBytesOverride: OVER_BUDGET_JS_BYTES,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );

    await expect(
      dispatchPluginPublicRoute(
        {
          platformDb: env.PLATFORM_DB,
          tenantStore: getTenantStoreNs(),
          registry,
          nowMs: NOW_MS,
        },
        {
          tenant: { id: TENANT_A.id, handle: TENANT_A.handle, name: TENANT_A.name, status: "active" },
          request: new Request(`https://${TENANT_A.handle}.situsku.click/probe-widget`),
          pathname: "/probe-widget",
        },
      ),
    ).rejects.toThrow(PluginRuntimeError);

    // Restore clean config
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { config: { bannerLabel: "Promo Aktif", publicJsBytesOverride: 512 } },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
  });

  it("Slot 3 + API Hardening: RBAC, CSRF/Origin, 413/malformed body, atomic PATCH order, trial subpath classification, locked/suspended gates", async () => {
    // 1. Origin/CSRF mismatch on mutation -> 403
    const badOriginRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        origin: "https://evil.example",
        body: { enabled: false },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(badOriginRes.status).toBe(403);

    // 2. Oversized 413 body
    const oversizedRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        rawBody: JSON.stringify({ config: { bannerLabel: "x".repeat(70_000) } }),
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(oversizedRes.status).toBe(413);

    // 3. Malformed JSON -> 400
    const malformedRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        rawBody: "{not valid json",
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(malformedRes.status).toBe(400);

    // 4. Atomic PATCH validation order: invalid config MUST return 422 AND leave `enabled` TRUE!
    const badAtomicPatch = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { enabled: false, config: { bannerLabel: "" } },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(badAtomicPatch.status).toBe(422);

    const afterBadPatch = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    const afterBadBody = (await afterBadPatch.json()) as {
      readonly plugin: { readonly enabled: boolean };
    };
    expect(afterBadBody.plugin.enabled).toBe(true);

    // 5. Config size cap (> 16 KiB) rejected with 422
    const bigConfigRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { config: { bannerLabel: "OK", extra: "a".repeat(17_000) } },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(bigConfigRes.status).toBe(422);

    // 6. Explicit `/plugins/**` classification: trial tenant calling `/plugins/synthetic-probe/domains`
    // MUST succeed 200 (never misclassified as TRIAL_DOMAIN_FORBIDDEN!)
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'trial', trial_ends_at = ?, paid_through = NULL WHERE id = ?",
    )
      .bind(NOW_MS + 5 * 86_400_000, TENANT_A.id)
      .run();

    const trialDomainsSubpath = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      "synthetic-probe",
      "/domains",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe/domains`, {
        method: "POST",
        body: {},
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(trialDomainsSubpath.status).toBe(200);

    // Restore active for RBAC & lifecycle checks
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', trial_ends_at = NULL, paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS + 30 * 86_400_000, TENANT_A.id)
      .run();

    // 7. Editor blocked on mutations (403)
    const editorPatchRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.editorId }, registry, nowMs: NOW_MS },
    );
    expect(editorPatchRes.status).toBe(403);

    // 8. Cross-tenant -> neutral 404
    const crossTenantRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_B.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(crossTenantRes.status).toBe(404);

    // 9. Unentitled Tenant B -> 403/404 with 0 TenantStore queries
    let tenantBQueries = 0;
    const unentitledApiRes = await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      "synthetic-probe",
      "/items",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/synthetic-probe/items`),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_B.ownerId },
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          tenantBQueries += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
        },
      },
    );
    expect([403, 404]).toContain(unentitledApiRes.status);
    expect(tenantBQueries).toBe(0);

    // 10. `locked`: GET allowed, mutations return 403 SUBSCRIPTION_LOCKED
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS - 5 * 86_400_000, TENANT_A.id)
      .run();

    const lockedGet = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPatch = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(lockedPatch.status).toBe(403);
    const lockedBody = (await lockedPatch.json()) as { readonly error: { readonly code: string } };
    expect(lockedBody.error.code).toBe("SUBSCRIPTION_LOCKED");

    // 11. `suspended`: API blocked 403, plg_* rows preserved!
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'suspended', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS - 10 * 86_400_000, TENANT_A.id)
      .run();

    const suspendedGet = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(suspendedGet.status).toBe(403);

    const tenantADb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const stillThere = await tenantADb
      .prepare("SELECT COUNT(*) AS cnt FROM plg_synthetic_probe__items")
      .first<{ readonly cnt: number }>();
    expect(Number(stillThere?.cnt ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("SSR Lifecycle Gate enforces purging/purged -> 404, suspended/recovery/operatorHold -> 302 with ZERO TenantStore reads, and exposes userId", async () => {
    const makeAstroMock = (tenantStatus: string) => ({
      params: { handle: TENANT_A.handle },
      response: { headers: new Headers() },
      locals: {
        surface: "app" as const,
        host: "app.punyasitus.com",
        isLocalLoopback: false,
        tenant: null,
        tenantDb: null,
        authUser: {
          id: TENANT_A.ownerId,
          name: "Owner Display Name",
          email: "owner@example.com",
          emailVerified: true,
        },
        authSession: {
          id: "sess_1",
          userId: TENANT_A.ownerId,
          activeOrganizationId: TENANT_A.orgId,
          createdAt: new Date(NOW_MS),
          expiresAt: new Date(NOW_MS + 3_600_000),
        },
        authorizedTenantMember: {
          tenantId: TENANT_A.id,
          organizationId: TENANT_A.orgId,
          handle: TENANT_A.handle,
          tenantName: TENANT_A.name,
          tenantStatus: tenantStatus as never,
          memberId: `mem_${TENANT_A.ownerId}`,
          userId: TENANT_A.ownerId,
          dbRole: "owner" as const,
          role: "owner" as const,
        },
        tenantEntitlement: null,
        platformOperator: null,
        twoFactorVerifiedAtMs: null,
      },
    });

    // Active tenant exposes real `userId` distinct from `userDisplayName`
    const activeCtx = await resolvePluginAdminServerContext(makeAstroMock("active"), {
      platformDb: env.PLATFORM_DB,
      tenantStore: getTenantStoreNs(),
      nowMs: NOW_MS,
    });
    expect(activeCtx.ok).toBe(true);
    if (activeCtx.ok) {
      expect(activeCtx.ctx.userId).toBe(TENANT_A.ownerId);
      expect(activeCtx.ctx.userDisplayName).toBe("Owner Display Name");
    }

    // `purging` / `purged` -> neutral 404 + ZERO TenantStore reads
    for (const status of ["purging", "purged"] as const) {
      let dbReads = 0;
      await env.PLATFORM_DB.prepare("UPDATE tenants SET status = ?, operator_hold = 0 WHERE id = ?")
        .bind(status, TENANT_A.id)
        .run();

      const res = await resolvePluginAdminServerContext(makeAstroMock(status), {
        platformDb: env.PLATFORM_DB,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          dbReads += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(404);
        expect(res.response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(res.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      }
      expect(dbReads).toBe(0);
    }

    // `suspended` / `recovery` / `operatorHold` -> 302 + ZERO TenantStore reads
    for (const tc of [
      { status: "suspended", hold: 0 },
      { status: "recovery", hold: 0 },
      { status: "active", hold: 1 },
    ]) {
      let dbReads = 0;
      await env.PLATFORM_DB.prepare("UPDATE tenants SET status = ?, operator_hold = ? WHERE id = ?")
        .bind(tc.status, tc.hold, TENANT_A.id)
        .run();

      const res = await resolvePluginAdminServerContext(makeAstroMock(tc.status), {
        platformDb: env.PLATFORM_DB,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          dbReads += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(302);
        expect(res.response.headers.get("Location")).toBe(
          `/dashboard/${TENANT_A.handle}/service-status`,
        );
      }
      expect(dbReads).toBe(0);
    }
  });

  it("Slot 4: fault-isolated Queue hook crash never rolls back core lead commit; hardened webhook enforces secret-first, 413, replay, locked, suspended & purging gates", async () => {
    const tenantADb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));

    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { config: { bannerLabel: "Promo Aktif", throwOnLeadHook: true } },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );

    const { coreResult, hookOutcomes } = await runCoreWriteWithIsolatedPluginHooks({
      tenantId: TENANT_A.id,
      event: "lead.created",
      eventId: (lead) => `lead_${lead.leadId}`,
      buildPayload: (lead) => ({ leadId: lead.leadId }),
      hookDeps: {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS,
      },
      coreWrite: async () => {
        await tenantADb
          .prepare(
            `INSERT INTO leads (id, name, phone_e164, message, source_category, status, version, created_at, updated_at)
             VALUES (7001, 'Calon Klien B2B', '6281234567890', 'Mohon penawaran', 'direct', 'new', 1, ?, ?)`,
          )
          .bind(NOW_MS, NOW_MS)
          .run();
        return { leadId: 7001 };
      },
    });
    expect(coreResult.leadId).toBe(7001);
    expect(hookOutcomes).toHaveLength(1);
    expect(hookOutcomes[0]!.outcome).toBe("failed");

    const committedLead = await tenantADb
      .prepare("SELECT id, name FROM leads WHERE id = 7001")
      .first<{ readonly id: number; readonly name: string }>();
    expect(committedLead?.id).toBe(7001);

    // Disable throw mode & verify Queue consumer using createPluginJobRegistry()
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      "synthetic-probe",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/synthetic-probe`, {
        method: "PATCH",
        body: { config: { bannerLabel: "Promo Aktif", throwOnLeadHook: false } },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );

    const queuedMessages: unknown[] = [];
    const enqueueRes = await enqueuePluginDomainEvent(
      {
        platformDb: env.PLATFORM_DB,
        queue: {
          send: async (msg) => {
            queuedMessages.push(msg);
          },
        },
        registry,
        nowMs: NOW_MS,
      },
      {
        tenantId: TENANT_A.id,
        event: "post.published",
        eventId: "post_99",
        payload: { slug: "panduan-frozen-core" },
      },
    );
    expect(enqueueRes.enqueued).toBe(1);

    const batch = {
      queue: "punyasitus-jobs",
      messages: queuedMessages.map((body, idx) => ({
        id: `msg_${idx}`,
        timestamp: new Date(NOW_MS),
        body,
        attempts: 1,
        ack: () => {},
        retry: () => {},
      })),
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;

    const batchRes = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB, TENANT_STORE: env.TENANT_STORE },
      createPluginJobRegistry({ registry }),
      { now: () => NOW_MS, logger: () => {} },
    );
    expect(batchRes.completed).toBe(1);

    // Webhook security matrix:
    // 1. Secret verified BEFORE reading body: wrong secret + huge body -> 401 (NOT 413!)
    const secretBeforeBody = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: {
          "X-Synthetic-Webhook-Secret": "wrong-secret",
          "Content-Length": "9999999",
        },
        body: "x".repeat(200_000),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS },
    );
    expect(secretBeforeBody.status).toBe(401);

    // 2. Valid secret + oversized body (> 128 KiB) -> 413 PAYLOAD_TOO_LARGE
    const oversizedWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: { "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET },
        body: JSON.stringify({ targetTenantId: TENANT_A.id, pad: "a".repeat(140_000) }),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS },
    );
    expect(oversizedWh.status).toBe(413);

    // 3. `locked` tenant -> 403 SUBSCRIPTION_LOCKED (ZERO TenantStore reads)
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS - 5 * 86_400_000, TENANT_A.id)
      .run();
    let lockedWhReads = 0;
    const lockedWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: { "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET },
        body: JSON.stringify({ targetTenantId: TENANT_A.id, token: "locked_tok" }),
      }),
      buildRuntimeEnv(),
      {
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          lockedWhReads += 1;
          return tenantADb;
        },
      },
    );
    expect(lockedWh.status).toBe(403);
    expect(((await lockedWh.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
    expect(lockedWhReads).toBe(0);

    // 4. `suspended` tenant -> 403 SUBSCRIPTION_LOCKED
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'suspended', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS - 10 * 86_400_000, TENANT_A.id)
      .run();
    const suspendedWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: { "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET },
        body: JSON.stringify({ targetTenantId: TENANT_A.id, token: "susp_tok" }),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS },
    );
    expect(suspendedWh.status).toBe(403);

    // 5. `purging` & `purged` tenant -> 404 NOT_FOUND
    for (const st of ["purging", "purged"] as const) {
      await env.PLATFORM_DB.prepare("UPDATE tenants SET status = ? WHERE id = ?")
        .bind(st, TENANT_A.id)
        .run();
      const purgeWh = await handlePluginInboundWebhook(
        "synthetic-probe",
        new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
          method: "POST",
          headers: { "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET },
          body: JSON.stringify({ targetTenantId: TENANT_A.id, token: `tok_${st}` }),
        }),
        buildRuntimeEnv(),
        { registry, nowMs: NOW_MS },
      );
      expect(purgeWh.status).toBe(404);
    }

    // Restore active Tenant A & verify first delivery = 200 and replay with same X-Plugin-Event-Id = 409!
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', paid_through = ? WHERE id = ?",
    )
      .bind(NOW_MS + 30 * 86_400_000, TENANT_A.id)
      .run();

    const okWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: {
          "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET,
          "X-Plugin-Event-Id": "evt_unique_001",
          "X-Plugin-Timestamp": String(NOW_MS),
        },
        body: JSON.stringify({ targetTenantId: TENANT_A.id, token: "tok_a_123" }),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS },
    );
    expect(okWh.status).toBe(200);

    const replayWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: {
          "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET,
          "X-Plugin-Event-Id": "evt_unique_001",
          "X-Plugin-Timestamp": String(NOW_MS),
        },
        body: JSON.stringify({ targetTenantId: TENANT_A.id, token: "tok_a_123" }),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS },
    );
    expect(replayWh.status).toBe(409);

    // Unentitled Tenant B -> 403/404 with 0 TenantStore queries
    let whTenantBQueries = 0;
    const unentitledWh = await handlePluginInboundWebhook(
      "synthetic-probe",
      new Request(`${APP_ORIGIN}/api/plugins/synthetic-probe/webhook`, {
        method: "POST",
        headers: { "X-Synthetic-Webhook-Secret": SYNTHETIC_WEBHOOK_SECRET },
        body: JSON.stringify({ targetTenantId: TENANT_B.id, token: "tok_b" }),
      }),
      buildRuntimeEnv(),
      {
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          whTenantBQueries += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
        },
      },
    );
    expect([403, 404]).toContain(unentitledWh.status);
    expect(whTenantBQueries).toBe(0);
  });

  it("Slot 5: conditional OAuth-scoped MCP tools + strict entitlement revocation (fail-closed, never fails open)", async () => {
    const tenantASnapshot = {
      id: TENANT_A.id,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active",
    };
    const tenantBSnapshot = {
      id: TENANT_B.id,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      status: "active",
    };

    let tenantBMcpQueries = 0;
    const toolsB = await listPluginMcpToolsForTenant(
      {
        platformDb: env.PLATFORM_DB,
        registry,
        nowMs: NOW_MS,
        resolveTenantDb: () => {
          tenantBMcpQueries += 1;
          return createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
        },
      },
      {
        tenant: tenantBSnapshot,
        grantedScopes: ["plugin:synthetic-probe:read", "plugin:synthetic-probe:write"],
      },
    );
    expect(toolsB).toEqual([]);
    expect(tenantBMcpQueries).toBe(0);

    const writeRes = await invokePluginMcpTool(
      {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS,
      },
      {
        tenant: tenantASnapshot,
        toolName: "plg_synthetic_probe_add_item",
        args: { label: "Created via MCP Tool" },
        grantedScopes: ["plugin:synthetic-probe:read", "plugin:synthetic-probe:write"],
        actorUserId: TENANT_A.ownerId,
      },
    );
    expect(writeRes).toEqual({ created: true, label: "Created via MCP Tool" });

    // `locked`: read allowed, write returns 403 SUBSCRIPTION_LOCKED
    await expect(
      invokePluginMcpTool(
        {
          platformDb: env.PLATFORM_DB,
          tenantStore: getTenantStoreNs(),
          registry,
          nowMs: NOW_MS,
        },
        {
          tenant: { ...tenantASnapshot, status: "locked" },
          toolName: "plg_synthetic_probe_add_item",
          args: { label: "Blocked While Locked" },
          grantedScopes: ["plugin:synthetic-probe:write"],
          actorUserId: TENANT_A.ownerId,
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: "SUBSCRIPTION_LOCKED" });

    // Grant & revoke private_client entitlement: revoked entitlement NEVER fails open
    await grantTenantPluginEntitlement(env.PLATFORM_DB, {
      tenantId: TENANT_A.id,
      pluginId: "client-bespoke",
      grantedBy: "operator_1",
      nowMs: NOW_MS,
    });
    const listGranted = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(
      ((await listGranted.json()) as { items: { id: string }[] }).items.some(
        (p) => p.id === "client-bespoke",
      ),
    ).toBe(true);

    await revokeTenantPluginEntitlement(env.PLATFORM_DB, {
      tenantId: TENANT_A.id,
      pluginId: "client-bespoke",
      nowMs: NOW_MS + 1000,
    });
    const listRevoked = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 1000 },
    );
    expect(
      ((await listRevoked.json()) as { items: { id: string }[] }).items.some(
        (p) => p.id === "client-bespoke",
      ),
    ).toBe(false);
  });
});
