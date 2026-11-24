import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  createScopedPluginTenantDb,
  grantTenantPluginEntitlement,
  TENANT_PLUGIN_LEDGER_MIGRATION,
  upsertPluginCatalogEntry,
} from "@punyasitus/db/plugins/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_REGISTRY } from "../../apps/web/src/core/plugin-registry.ts";
import {
  dispatchPluginPublicRoute,
  renderPluginPublicSection,
  resolveActivePluginForTenant,
} from "../../apps/web/src/core/plugin-runtime.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/index.ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import {
  BIO_LINKS_PLUGIN_ID,
  handleBioLinkClickRedirect,
} from "../../packages/plugins/bio-links/index.ts";
import {
  handleWaRotatorPublicRedirect,
  resolveWhatsAppCtaWithRotator,
  selectAndRecordWaRotation,
  WA_CS_ROTATOR_MANIFEST,
  WA_CS_ROTATOR_PLUGIN,
  WA_CS_ROTATOR_PLUGIN_ID,
} from "../../packages/plugins/wa-cs-rotator/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
// Monday 2026-11-23 10:00 WIB (03:00 UTC)
const MON_10_00_WIB = Date.UTC(2026, 10, 23, 3, 0, 0);
// Tuesday 2026-11-24 03:00 WIB (Monday 20:00 UTC) -> outside daytime & evening shifts
const TUE_03_00_WIB = Date.UTC(2026, 10, 23, 20, 0, 0);
const TEST_GET_BOOKMARK = async () => `bm_t099_pitr_${MON_10_00_WIB}`;

const TENANT_A = {
  id: "01JT099TENANTALPHA00000001",
  orgId: "org_t099_alpha",
  handle: "alpha-seed",
  name: "Alpha Properti Jakarta",
  ownerId: "user_t099_owner_a",
  editorId: "user_t099_editor_a",
};

const TENANT_B = {
  id: "01JT099TENANTBETA000000002",
  orgId: "org_t099_beta",
  handle: "beta-seed",
  name: "Beta Otomotif Surabaya",
  ownerId: "user_t099_owner_b",
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
    readonly origin?: string | null;
  } = {},
): Request {
  const method = init.method ?? "GET";
  const headers = new Headers();
  if (method !== "GET" && method !== "HEAD") {
    if (init.origin !== null) {
      headers.set("Origin", init.origin ?? APP_ORIGIN);
    }
    headers.set("Sec-Fetch-Site", "same-origin");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerId: string;
  readonly editorId?: string;
  readonly status?: string;
}) {
  const db = env.PLATFORM_DB;
  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, MON_10_00_WIB, MON_10_00_WIB)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, MON_10_00_WIB, MON_10_00_WIB)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    )
    .bind(`mem_${spec.ownerId}`, spec.orgId, spec.ownerId, MON_10_00_WIB)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, MON_10_00_WIB, MON_10_00_WIB)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, MON_10_00_WIB)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'sales', ?, 0, ?, 1, 1, 1, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.orgId,
      spec.handle,
      spec.name,
      spec.status ?? "active",
      MON_10_00_WIB + 30 * 86_400_000,
      MON_10_00_WIB,
      MON_10_00_WIB,
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
    )
    .bind(`${spec.handle}.situsku.click`, spec.id, MON_10_00_WIB, MON_10_00_WIB)
    .run();

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  await orchestrateTenantMigration(
    env.PLATFORM_DB,
    stub,
    spec.id,
    [...TENANT_MIGRATIONS, TENANT_PLUGIN_LEDGER_MIGRATION],
    { getBookmark: TEST_GET_BOOKMARK, now: () => MON_10_00_WIB },
  );
}

async function resetTenantPlugins(tenantId: string) {
  await env.PLATFORM_DB.prepare("DELETE FROM tenant_plugin_entitlements WHERE tenant_id = ?")
    .bind(tenantId)
    .run();
  const db = createTenantDb(openTenantStoreStub(getTenantStoreNs(), tenantId));
  await db.prepare("DELETE FROM installed_plugins").run();
  await db.prepare("DELETE FROM _plugin_migrations").run();
  const existingTables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plg_%'")
    .all<{ readonly name: string }>();
  const existingSet = new Set((existingTables.results ?? []).map((r) => r.name));
  for (const tbl of [
    "plg_bio_links__clicks_daily",
    "plg_bio_links__items",
    "plg_bio_links__config",
    "plg_wa_cs_rotator__clicks_daily",
    "plg_wa_cs_rotator__clicks",
    "plg_wa_cs_rotator__state",
    "plg_wa_cs_rotator__agents",
  ]) {
    if (existingSet.has(tbl)) {
      await db.prepare(`DELETE FROM ${tbl}`).run();
    }
  }
}

describe("TASK-099 Official Launch Seed Plugins — Real workerd + D1 + TenantStore Integration", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB);
    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
  });

  beforeEach(async () => {
    await resetTenantPlugins(TENANT_A.id);
    await resetTenantPlugins(TENANT_B.id);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'active' WHERE id IN (?, ?)")
      .bind(TENANT_A.id, TENANT_B.id)
      .run();
  });

  it("installs bio-links (public_free), serves 0-JS /link, tracks first-party clicks, rejects open redirects, and isolates tenants", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Install `bio-links` via 1-click free plugin collection API on Tenant A
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: BIO_LINKS_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        nowMs: MON_10_00_WIB,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);
    const installBody = (await installRes.json()) as {
      plugin: { id: string; enabled: boolean; schemaVersion: number };
      migration: { outcome: string; schemaVersion: number };
    };
    expect(installBody.plugin.id).toBe(BIO_LINKS_PLUGIN_ID);
    expect(installBody.plugin.enabled).toBe(true);
    expect(installBody.plugin.schemaVersion).toBe(1);
    expect(installBody.migration.outcome).toBe("migrated");

    // 2. Editor role is blocked from mutating bio-links (403 FORBIDDEN)
    const editorRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "links",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/links`, {
        method: "POST",
        body: { label: "Editor Attempt", url: "https://contoh.id" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: MON_10_00_WIB },
    );
    expect(editorRes.status).toBe(403);

    // 3. Owner updates profile and creates bio links; unsafe javascript: URL is rejected (422)
    const profRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "profile",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/profile`, {
        method: "PUT",
        body: {
          displayName: "Budi Santoso",
          headline: "Konsultan Properti Jakarta",
          bioText: "Konsultasi KPR & unit siap huni.",
          avatarUrl: "https://alphaproperti.id/avatar.webp",
          themeAccent: "#0F766E",
          whatsappPhone: "0812-3456-7890",
          whatsappLabel: "Tanya Unit via WhatsApp",
          whatsappMessage: "Halo Budi, saya dari halaman /link",
          showWhatsappButton: true,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(profRes.status).toBe(200);

    // Partial profile save omitting avatarUrl & whatsappMessage MUST preserve both stored fields!
    const partialProfRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "profile",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/profile`, {
        method: "PUT",
        body: {
          displayName: "Budi Santoso",
          headline: "Konsultan Properti Senior Jakarta",
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB + 1000 },
    );
    expect(partialProfRes.status).toBe(200);
    const partialProfBody = (await partialProfRes.json()) as {
      profile: { avatarUrl: string; whatsappMessage: string; headline: string };
    };
    expect(partialProfBody.profile.headline).toBe("Konsultan Properti Senior Jakarta");
    expect(partialProfBody.profile.avatarUrl).toBe("https://alphaproperti.id/avatar.webp");
    expect(partialProfBody.profile.whatsappMessage).toBe("Halo Budi, saya dari halaman /link");

    // Admin GET /click MUST be rejected with 405 Method Not Allowed (POST only)
    const adminGetClickRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "click",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/click`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(adminGetClickRes.status).toBe(405);
    expect(adminGetClickRes.headers.get("Allow")).toBe("POST");

    const xssLinkRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "links",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/links`, {
        method: "POST",
        body: { label: "XSS", url: "javascript:alert(1)" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(xssLinkRes.status).toBe(422);

    const addLinkRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "links",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/links`, {
        method: "POST",
        body: {
          label: "Katalog Properti 2026",
          url: "https://alphaproperti.id/katalog",
          subtitle: "Harga & denah terbaru",
          badge: "Baru",
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(addLinkRes.status).toBe(201);
    const createdLink = ((await addLinkRes.json()) as { link: { id: string; url: string } }).link;

    // 4. Public /link render via Frozen Core dispatcher -> 200 OK, strictly 0 bytes client JS!
    const runtimeDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: getTenantStoreNs(),
      registry: DEFAULT_PLUGIN_REGISTRY,
      nowMs: MON_10_00_WIB,
    };
    const tenantASnapshot = {
      id: TENANT_A.id,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active",
      primaryHost: "alpha-seed.situsku.click",
    };
    const publicRes = await dispatchPluginPublicRoute(runtimeDeps, {
      tenant: tenantASnapshot,
      request: new Request("https://alpha-seed.situsku.click/link"),
      pathname: "/link",
    });
    expect(publicRes).not.toBeNull();
    expect(publicRes!.status).toBe(200);
    expect(publicRes!.headers.get("X-PunyaSitus-Plugin")).toBe("bio-links");
    expect(publicRes!.headers.get("X-PunyaSitus-Plugin-JS-Bytes")).toBe("0");
    const html = await publicRes!.text();
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).toContain("Budi Santoso");
    expect(html).toContain(`/link/go?id=${createdLink.id}`);
    expect(html).toContain("https://wa.me/6281234567890");

    // 5. Unentitled Tenant B gets null (404) with ZERO TenantStore queries!
    let tenantBDbOpened = false;
    const tenantBRes = await dispatchPluginPublicRoute(
      {
        platformDb: env.PLATFORM_DB,
        resolveTenantDb() {
          tenantBDbOpened = true;
          throw new Error("Unentitled tenant must never open TenantStore!");
        },
        nowMs: MON_10_00_WIB,
      },
      {
        tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
        request: new Request("https://beta-seed.situsku.click/link"),
        pathname: "/link",
      },
    );
    expect(tenantBRes).toBeNull();
    expect(tenantBDbOpened).toBe(false);

    // 6. First-party click tracking via /link/go AND 302 redirect handler + open-redirect rejection
    const goRes = await dispatchPluginPublicRoute(runtimeDeps, {
      tenant: tenantASnapshot,
      request: new Request(`https://alpha-seed.situsku.click/link/go?id=${createdLink.id}`),
      pathname: "/link/go",
    });
    expect(goRes?.status).toBe(200);

    const tenantAScopedDb = createScopedPluginTenantDb(
      BIO_LINKS_PLUGIN_ID,
      createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id)),
    );
    const redirectRes = await handleBioLinkClickRedirect({
      db: tenantAScopedDb,
      request: new Request(
        `https://alpha-seed.situsku.click/api/plugins/bio-links/click?id=${createdLink.id}`,
      ),
      nowMs: MON_10_00_WIB,
    });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("Location")).toBe("https://alphaproperti.id/katalog");
    expect(redirectRes.headers.get("Referrer-Policy")).toBe("no-referrer");

    // Second click on the same Jakarta day bucket proves daily upsert increment
    const redirectRes2 = await handleBioLinkClickRedirect({
      db: tenantAScopedDb,
      request: new Request(
        `https://alpha-seed.situsku.click/api/plugins/bio-links/click?id=${createdLink.id}`,
      ),
      nowMs: MON_10_00_WIB + 5_000,
    });
    expect(redirectRes2.status).toBe(302);

    // Prefetch & HEAD requests on /link/go & click redirect MUST NOT increment click counts!
    const prefetchRes = await handleBioLinkClickRedirect({
      db: tenantAScopedDb,
      request: new Request(
        `https://alpha-seed.situsku.click/api/plugins/bio-links/click?id=${createdLink.id}`,
        { headers: { "Sec-Purpose": "prefetch" } },
      ),
      nowMs: MON_10_00_WIB + 6_000,
    });
    expect(prefetchRes.status).toBe(302);

    // Open redirect smuggling MUST be rejected with 400
    const openRedirectRes = await handleBioLinkClickRedirect({
      db: tenantAScopedDb,
      request: new Request(
        `https://alpha-seed.situsku.click/api/plugins/bio-links/click?id=${createdLink.id}&url=https://evil.example/phish`,
      ),
      nowMs: MON_10_00_WIB,
    });
    expect(openRedirectRes.status).toBe(400);

    // Verify still exactly 3 clicks recorded in `plg_bio_links__*` (prefetch was NOT counted!)
    const statsRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      BIO_LINKS_PLUGIN_ID,
      "stats",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${BIO_LINKS_PLUGIN_ID}/stats`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      stats: {
        totalClicks: number;
        activeLinks: number;
        dailyClicks: { dayBucket: string; clickCount: number }[];
      };
    };
    expect(statsBody.stats.totalClicks).toBe(3);
    expect(
      statsBody.stats.dailyClicks.find((d) => d.dayBucket === "2026-11-23")?.clickCount,
    ).toBe(2);
    expect(
      statsBody.stats.dailyClicks.reduce((sum, d) => sum + d.clickCount, 0),
    ).toBe(3);

    // 7. Cross-tenant click isolation: Tenant B installs bio-links and CANNOT click Tenant A's link ID
    await handleTenantPluginsCollectionRequest(
      TENANT_B.handle,
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins`, {
        method: "POST",
        body: { pluginId: BIO_LINKS_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_B.ownerId },
        nowMs: MON_10_00_WIB,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    const tenantBScopedDb = createScopedPluginTenantDb(
      BIO_LINKS_PLUGIN_ID,
      createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id)),
    );
    const crossTenantClick = await handleBioLinkClickRedirect({
      db: tenantBScopedDb,
      request: new Request(
        `https://beta-seed.situsku.click/api/plugins/bio-links/click?id=${createdLink.id}`,
      ),
      nowMs: MON_10_00_WIB,
    });
    expect(crossTenantClick.status).toBe(404);
  });

  it("enforces wa-cs-rotator paid entitlement, rotates by weight & schedule, falls back off-shift, logs clicks, isolates tenants, and reverts immediately when disabled", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const primaryWa = "6281100001111";

    // 1. Unentitled install of `wa-cs-rotator` (public_paid) is blocked with 403 FORBIDDEN
    const unentitledInstall = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: WA_CS_ROTATOR_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        nowMs: MON_10_00_WIB,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(unentitledInstall.status).toBe(403);

    // 2. Grant entitlement for Tenant A & install -> runs plg_wa_cs_rotator__* migrations
    await upsertPluginCatalogEntry(env.PLATFORM_DB, WA_CS_ROTATOR_MANIFEST, MON_10_00_WIB);
    await grantTenantPluginEntitlement(env.PLATFORM_DB, {
      tenantId: TENANT_A.id,
      pluginId: WA_CS_ROTATOR_PLUGIN_ID,
      grantedBy: "superadmin_t099",
      nowMs: MON_10_00_WIB,
    });

    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: {
          pluginId: WA_CS_ROTATOR_PLUGIN_ID,
          config: {
            strategy: "weighted",
            fallbackWhatsappPhone: primaryWa,
            timezone: "Asia/Jakarta",
            defaultMessage: "Halo tim sales Alpha Properti",
            ctaLabel: "Chat Tim Sales",
          },
        },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        nowMs: MON_10_00_WIB,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);

    // 3. Add 3 agents: Agent A (weight 3, 08:00-17:00), Agent B (weight 1, 08:00-17:00), Agent C (weight 2, 18:00-23:00 off-shift at 10:00 WIB)
    const addAgent = async (payload: Record<string, unknown>) =>
      handleTenantPluginSubpathApiRequest(
        TENANT_A.handle,
        WA_CS_ROTATOR_PLUGIN_ID,
        "agents",
        makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/agents`, {
          method: "POST",
          body: payload,
        }),
        runtimeEnv,
        { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
      );

    // Reject invalid phone number (422)
    expect(
      (await addAgent({ name: "Invalid", phone: "+14155550100", weight: 1 })).status,
    ).toBe(422);

    const agtARes = await addAgent({
      name: "Rina Senior",
      roleLabel: "Senior Sales",
      phone: "0812-1111-1111",
      weight: 3,
      scheduleDays: [1, 2, 3, 4, 5],
      startTime: "08:00",
      endTime: "17:00",
      sortOrder: 0,
    });
    expect(agtARes.status).toBe(201);
    const agtA = ((await agtARes.json()) as { agent: { id: string; phoneE164: string } }).agent;

    const agtBRes = await addAgent({
      name: "Budi Junior",
      roleLabel: "Sales CS",
      phone: "0812-2222-2222",
      weight: 1,
      scheduleDays: [1, 2, 3, 4, 5],
      startTime: "08:00",
      endTime: "17:00",
      sortOrder: 1,
    });
    expect(agtBRes.status).toBe(201);
    const agtB = ((await agtBRes.json()) as { agent: { id: string; phoneE164: string } }).agent;

    const agtCRes = await addAgent({
      name: "Citra Malam",
      roleLabel: "Shift Malam",
      phone: "0812-3333-3333",
      weight: 2,
      scheduleDays: [1, 2, 3, 4, 5],
      startTime: "18:00",
      endTime: "23:00",
      sortOrder: 2,
    });
    expect(agtCRes.status).toBe(201);
    const agtC = ((await agtCRes.json()) as { agent: { id: string; phoneE164: string } }).agent;

    // Seed base REQ-014 business_profile.whatsapp_e164 in TenantStore for fallback verification
    const tenantARawDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    await tenantARawDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (id, business_name, business_category, whatsapp_e164, version, updated_at)
         VALUES (1, ?, 'LocalBusiness', ?, 1, ?)`,
      )
      .bind(TENANT_A.name, primaryWa, MON_10_00_WIB)
      .run();

    // Set strategy, fallbackWhatsappPhone, and timezone via PUT /settings and verify persistence round-trip
    const setStratRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "settings",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/settings`, {
        method: "PUT",
        body: {
          strategy: "weighted",
          fallbackWhatsappPhone: "0811-0000-1111",
          timezone: "Asia/Makassar",
          resetCursor: true,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(setStratRes.status).toBe(200);
    const savedState = (
      (await setStratRes.json()) as {
        state: { strategy: string; fallbackWhatsappPhone: string; timezone: string; stateVersion: number };
      }
    ).state;
    expect(savedState.strategy).toBe("weighted");
    expect(savedState.fallbackWhatsappPhone).toBe("6281100001111");
    expect(savedState.timezone).toBe("Asia/Makassar");
    expect(savedState.stateVersion).toBeGreaterThanOrEqual(1);

    // Verify GET /overview reflects persisted fallbackWhatsappPhone & timezone, then restore Asia/Jakarta
    const ovRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "overview",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/overview`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(ovRes.status).toBe(200);
    const ovBody = (await ovRes.json()) as {
      state: { fallbackWhatsappPhone: string; timezone: string };
    };
    expect(ovBody.state.fallbackWhatsappPhone).toBe("6281100001111");
    expect(ovBody.state.timezone).toBe("Asia/Makassar");

    await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "settings",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/settings`, {
        method: "PUT",
        body: { strategy: "weighted", timezone: "Asia/Jakarta" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );

    // 4. Run 4 rotations at Monday 10:00 WIB -> must skip Citra (off-shift) and distribute 3:1 [A, A, B, A]
    //    Also pass a sourcePath with PII query string to verify query stripping in plg_wa_cs_rotator__clicks!
    const tenantAScopedDb = createScopedPluginTenantDb(
      WA_CS_ROTATOR_PLUGIN_ID,
      createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id)),
    );
    const pickedIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const rot = await selectAndRecordWaRotation({
        db: tenantAScopedDb,
        tenantDb: tenantARawDb,
        primaryWhatsappPhone: primaryWa,
        itemTitle: "Rumah Type 60",
        sourcePath: "/produk/rumah-60?email=secret@buyer.id&token=xyz#top",
        nowMs: MON_10_00_WIB + i * 1000,
      });
      expect(rot.mode).toBe("rotator");
      expect(rot.usedFallback).toBe(false);
      pickedIds.push(rot.agent!.id);
    }
    expect(pickedIds).toEqual([agtA.id, agtA.id, agtB.id, agtA.id]);
    expect(pickedIds).not.toContain(agtC.id);

    // Verify stored source_path has ZERO query string / PII
    const storedClick = await tenantARawDb
      .prepare("SELECT source_path FROM plg_wa_cs_rotator__clicks LIMIT 1")
      .first<{ source_path: string }>();
    expect(storedClick?.source_path).toBe("/produk/rumah-60");

    // 5. Run rotation at 03:00 WIB (ALL agents off-shift) WITHOUT passing primaryWhatsappPhone
    //    and with state fallback cleared -> resolves base REQ-014 business_profile.whatsapp_e164!
    await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "settings",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/settings`, {
        method: "PUT",
        body: { fallbackWhatsappPhone: "" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB + 5000 },
    );
    const fallbackRot = await selectAndRecordWaRotation({
      db: tenantAScopedDb,
      tenantDb: tenantARawDb,
      itemTitle: "Rumah Type 60",
      nowMs: TUE_03_00_WIB,
    });
    expect(fallbackRot.mode).toBe("rotator_fallback");
    expect(fallbackRot.usedFallback).toBe(true);
    expect(fallbackRot.agent).toBeNull();
    expect(fallbackRot.targetPhoneE164).toBe(primaryWa);

    // Prefetch on public redirect MUST NOT increment clicks or advance cursor
    const prefetchWa = await handleWaRotatorPublicRedirect({
      pluginActive: true,
      db: tenantAScopedDb,
      tenantDb: tenantARawDb,
      tenant: {
        id: TENANT_A.id,
        handle: TENANT_A.handle,
        name: TENANT_A.name,
        status: "active",
      },
      request: new Request("https://alpha-seed.situsku.click/wa-rotator?item=Rumah", {
        headers: { Purpose: "prefetch" },
      }),
      nowMs: TUE_03_00_WIB,
    });
    expect(prefetchWa.status).toBe(302);

    // Verify per-agent click attribution stats in `plg_wa_cs_rotator__*`
    const statsRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "stats",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/stats`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      stats: {
        totalClicks: number;
        fallbackClicks: number;
        agents: { agentId: string; totalClicks: number }[];
      };
    };
    expect(statsBody.stats.totalClicks).toBe(5);
    expect(statsBody.stats.fallbackClicks).toBe(1);
    expect(statsBody.stats.agents.find((a) => a.agentId === agtA.id)?.totalClicks).toBe(3);
    expect(statsBody.stats.agents.find((a) => a.agentId === agtB.id)?.totalClicks).toBe(1);
    expect(statsBody.stats.agents.find((a) => a.agentId === agtC.id)?.totalClicks).toBe(0);

    // Public section emits 0 bytes JS
    const runtimeDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: getTenantStoreNs(),
      registry: DEFAULT_PLUGIN_REGISTRY,
      nowMs: MON_10_00_WIB,
    };
    const tenantASnapshot = {
      id: TENANT_A.id,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active",
      primaryHost: "alpha-seed.situsku.click",
    };
    const pubSection = await renderPluginPublicSection(runtimeDeps, {
      tenant: tenantASnapshot,
      sectionId: "wa-cs-rotator-cta",
      props: { nowMs: MON_10_00_WIB },
    });
    expect(pubSection).not.toBeNull();
    expect(pubSection!.jsBytes).toBe(0);

    // 6. Cross-tenant isolation: Tenant B installs `wa-cs-rotator` with its own agent -> cannot see or patch Tenant A's agent
    await grantTenantPluginEntitlement(env.PLATFORM_DB, {
      tenantId: TENANT_B.id,
      pluginId: WA_CS_ROTATOR_PLUGIN_ID,
      grantedBy: "superadmin_t099",
      nowMs: MON_10_00_WIB,
    });
    await handleTenantPluginsCollectionRequest(
      TENANT_B.handle,
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins`, {
        method: "POST",
        body: { pluginId: WA_CS_ROTATOR_PLUGIN_ID },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_B.ownerId },
        nowMs: MON_10_00_WIB,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    // Tenant B has zero agents and zero fallback configured -> /wa-rotator MUST render safe 200 card instead of crashing!
    const unconfiguredWaRes = await dispatchPluginPublicRoute(runtimeDeps, {
      tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
      request: new Request("https://beta-seed.situsku.click/wa-rotator"),
      pathname: "/wa-rotator",
    });
    expect(unconfiguredWaRes).not.toBeNull();
    expect(unconfiguredWaRes!.status).toBe(200);
    expect(unconfiguredWaRes!.headers.get("X-PunyaSitus-Plugin-JS-Bytes")).toBe("0");
    const unconfiguredHtml = await unconfiguredWaRes!.text();
    expect(unconfiguredHtml).toContain("wa-rotator-unavailable");
    expect(unconfiguredHtml).toContain('href="/"');

    // Direct invocation of WA_CS_ROTATOR_PLUGIN.publicSlots.routes["/wa-rotator"] with ALL agents off-shift:
    // (a) persisted fallback via PUT /settings (empty config) -> renders wa.me handoff + increments fallback click
    const routeFn = WA_CS_ROTATOR_PLUGIN.publicSlots!.routes!["/wa-rotator"]!;
    const tenantBRawDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));
    const tenantBScopedDb = createScopedPluginTenantDb(WA_CS_ROTATOR_PLUGIN_ID, tenantBRawDb);
    await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "settings",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/settings`, {
        method: "PUT",
        body: { fallbackWhatsappPhone: "0813-5555-6666" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: MON_10_00_WIB },
    );
    const directPersistedRes = await routeFn({
      tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
      request: new Request("https://beta-seed.situsku.click/wa-rotator"),
      pathname: "/wa-rotator",
      config: {},
      db: tenantBScopedDb,
      nowMs: TUE_03_00_WIB,
    } as Parameters<typeof routeFn>[0]);
    expect(directPersistedRes.status).toBe(200);
    expect(directPersistedRes.jsBytes).toBe(0);
    expect(directPersistedRes.html).toContain("https://wa.me/6281355556666");

    // Verify Tenant B fallbackClicks incremented to exact 1 via GET /stats
    const tenantBStatsRes = await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "stats",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/stats`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: TUE_03_00_WIB },
    );
    expect(tenantBStatsRes.status).toBe(200);
    const tenantBStats = (await tenantBStatsRes.json()) as {
      stats: { fallbackClicks: number };
    };
    expect(tenantBStats.stats.fallbackClicks).toBe(1);

    // (b) clear persisted fallback, supply tenant.whatsappE164 on extended snapshot -> renders wa.me handoff to tenant primary WA
    await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      "settings",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/settings`, {
        method: "PUT",
        body: { fallbackWhatsappPhone: "" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: MON_10_00_WIB + 1000 },
    );
    const directTenantWaRes = await routeFn({
      tenant: {
        id: TENANT_B.id,
        handle: TENANT_B.handle,
        name: TENANT_B.name,
        status: "active",
        whatsappE164: "628177778888",
      } as Parameters<typeof routeFn>[0]["tenant"],
      request: new Request("https://beta-seed.situsku.click/wa-rotator"),
      pathname: "/wa-rotator",
      config: {},
      db: tenantBScopedDb,
      nowMs: TUE_03_00_WIB + 1000,
    } as Parameters<typeof routeFn>[0]);
    expect(directTenantWaRes.status).toBe(200);
    expect(directTenantWaRes.jsBytes).toBe(0);
    expect(directTenantWaRes.html).toContain("https://wa.me/628177778888");

    // (c) direct routeFn with NO fallback configured anywhere -> HTTP 200 safe off-hours card (0 JS bytes)
    const directUnconfiguredRes = await routeFn({
      tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
      request: new Request("https://beta-seed.situsku.click/wa-rotator"),
      pathname: "/wa-rotator",
      config: {},
      db: tenantBScopedDb,
      nowMs: TUE_03_00_WIB + 2000,
    } as Parameters<typeof routeFn>[0]);
    expect(directUnconfiguredRes.status).toBe(200);
    expect(directUnconfiguredRes.jsBytes).toBe(0);
    expect(directUnconfiguredRes.html).toContain("wa-rotator-unavailable");
    expect(directUnconfiguredRes.html).toContain('href="/"');

    // (d) direct routeFn with ctx.tenantDb -> resolves step 5 base REQ-014 business_profile.whatsapp_e164!
    await tenantBRawDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (id, business_name, business_category, whatsapp_e164, version, updated_at)
         VALUES (1, ?, 'LocalBusiness', '628144445555', 1, ?)`,
      )
      .bind(TENANT_B.name, MON_10_00_WIB)
      .run();
    const directTenantDbFallbackRes = await routeFn({
      tenant: { id: TENANT_B.id, handle: TENANT_B.handle, name: TENANT_B.name, status: "active" },
      request: new Request("https://beta-seed.situsku.click/wa-rotator"),
      pathname: "/wa-rotator",
      config: {},
      db: tenantBScopedDb,
      tenantDb: tenantBRawDb,
      nowMs: TUE_03_00_WIB + 3000,
    } as Parameters<typeof routeFn>[0]);
    expect(directTenantDbFallbackRes.status).toBe(200);
    expect(directTenantDbFallbackRes.jsBytes).toBe(0);
    expect(directTenantDbFallbackRes.html).toContain("https://wa.me/628144445555");

    const crossPatch = await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      `agents/${agtA.id}`,
      makeAppRequest(
        `/api/tenants/${TENANT_B.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}/agents/${agtA.id}`,
        { method: "PATCH", body: { name: "Hijacked" } },
      ),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(crossPatch.status).toBe(404);

    // 7. Disable `wa-cs-rotator` on Tenant A -> preserves `plg_wa_cs_rotator__agents` AND reverts IMMEDIATELY to single-number WA!
    const disableRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      WA_CS_ROTATOR_PLUGIN_ID,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${WA_CS_ROTATOR_PLUGIN_ID}`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: MON_10_00_WIB },
    );
    expect(disableRes.status).toBe(200);

    const activeCheck = await resolveActivePluginForTenant(
      runtimeDeps,
      tenantASnapshot,
      WA_CS_ROTATOR_PLUGIN_ID,
    );
    expect(activeCheck.active).toBe(false);

    // Public route & section unmount immediately when disabled
    expect(
      await dispatchPluginPublicRoute(runtimeDeps, {
        tenant: tenantASnapshot,
        request: new Request("https://alpha-seed.situsku.click/wa-rotator"),
        pathname: "/wa-rotator",
      }),
    ).toBeNull();

    // Instant revert to single-number base WhatsApp (REQ-014)
    const revertedCta = await resolveWhatsAppCtaWithRotator({
      pluginActive: activeCheck.active,
      db: activeCheck.active ? activeCheck.scopedDb : null,
      primaryWhatsappPhone: primaryWa,
      itemTitle: "Rumah Type 60",
    });
    expect(revertedCta.mode).toBe("base_single_number");
    expect(revertedCta.targetPhoneE164).toBe(primaryWa);

    const revertedRedirect = await handleWaRotatorPublicRedirect({
      pluginActive: activeCheck.active,
      db: null,
      tenant: tenantASnapshot,
      primaryWhatsappPhone: primaryWa,
      request: new Request("https://alpha-seed.situsku.click/wa-rotator?item=Rumah"),
    });
    expect(revertedRedirect.status).toBe(302);
    expect(revertedRedirect.headers.get("Location")).toContain(`https://wa.me/${primaryWa}`);
    expect(revertedRedirect.headers.get("X-WA-Rotator-Mode")).toBe("base_single_number");

    // Verify `plg_wa_cs_rotator__agents` rows 100% preserved after disable!
    const preservedAgents = await createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id))
      .prepare("SELECT COUNT(*) AS cnt FROM plg_wa_cs_rotator__agents")
      .first<{ cnt: number }>();
    expect(Number(preservedAgents?.cnt)).toBe(3);
  });
});
