import { env } from "cloudflare:workers";
import { createCatalogOffering, publishCatalogOffering } from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage, publishPage } from "@punyasitus/db/pages/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/index";
import { createPost, publishPost } from "@punyasitus/db/posts/index";
import { provisionTenantAtomically } from "@punyasitus/db/provisioning/index";
import {
  bumpTenantCacheVersion,
  publishResourceAtomically,
} from "@punyasitus/db/publication/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import {
  applyTenantSeoEditorMigration,
  getPublishedPublicSeoContext,
  getTenantSeoEditorSettings,
  isSeoAutopilotEnabledForTenant,
} from "@punyasitus/db/seo/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleIndexNowKeyRequest } from "../../apps/web/src/pages/[indexnowKey].txt.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/index.ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import { handleTenantSeoPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/publish.ts";
import { handleTenantSeoSettingsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/settings.ts";
import { handleTenantSeoToggleRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/toggle.ts";
import { handleBlogFeedRequest } from "../../apps/web/src/pages/blog/feed.xml.ts";
import { handleRobotsTxtRequest } from "../../apps/web/src/pages/robots.txt.ts";
import { handleSitemapIndexRequest } from "../../apps/web/src/pages/sitemap.xml.ts";
import { handleSubSitemapRequest } from "../../apps/web/src/pages/sitemaps/_shared.ts";
import {
  deriveDeterministicTenantIndexNowKey,
  renderAutopilotSeoHead,
  resolveAutopilotSchemaGraph,
} from "../../packages/plugins/seo-ai-autopilot/index.ts";
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 23, 10, 0, 0);

const TENANT_ALPHA = {
  id: "01JT102TENANTALPHA00000001",
  orgId: "org_t102_alpha",
  handle: "t102-alpha",
  name: "PT Nusantara Arsitek",
  ownerId: "user_t102_owner_a",
  editorId: "user_t102_editor_a",
  customDomain: "www.t102-alpha.id",
  subdomain: "t102-alpha.situsku.click",
};

const TENANT_BETA = {
  id: "01JT102TENANTBETA000000002",
  orgId: "org_t102_beta",
  handle: "t102-beta",
  name: "CV Beta Logistik",
  ownerId: "user_t102_owner_b",
  customDomain: "www.t102-beta.id",
  subdomain: "t102-beta.situsku.click",
};

const TENANT_TRIAL = {
  id: "01JT102TENANTTRIAL00000003",
  orgId: "org_t102_trial",
  handle: "t102-trial",
  name: "Uji Coba Studio",
  ownerId: "user_t102_owner_trial",
  subdomain: "t102-trial.situsku.click",
};

const TENANT_SUSPENDED = {
  id: "01JT102TENANTSUSP000000004",
  orgId: "org_t102_susp",
  handle: "t102-susp",
  name: "Situs Ditangguhkan",
  ownerId: "user_t102_owner_susp",
  customDomain: "www.t102-susp.id",
  subdomain: "t102-susp.situsku.click",
};

function getTenantStoreNs(): TenantStoreNamespaceLike {
  return env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
}

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: getTenantStoreNs(),
  };
}

function makeDiscoveryDeps(nowMs = NOW_MS) {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: getTenantStoreNs(),
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    nowMs,
    bypassHostCache: true,
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

async function seedTenantWithPublishedContent(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerId: string;
  readonly editorId?: string;
  readonly status: "active" | "trial" | "suspended";
  readonly customDomain?: string;
  readonly subdomain: string;
}): Promise<D1Database> {
  const db = env.PLATFORM_DB;
  const paidThrough = spec.status === "active" ? NOW_MS + 30 * 86_400_000 : null;
  const trialEndsAt = spec.status === "trial" ? NOW_MS + 7 * 86_400_000 : null;

  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, NOW_MS, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, NOW_MS, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         trial_ends_at, paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, ?, 1, 0, 1, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.orgId,
      spec.handle,
      spec.name,
      spec.status,
      trialEndsAt,
      paidThrough,
      NOW_MS,
      NOW_MS,
    )
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
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, NOW_MS)
      .run();
  }

  await db.prepare(`DELETE FROM tenant_hosts WHERE tenant_id = ?`).bind(spec.id).run();
  if (spec.customDomain) {
    await db
      .prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, 'custom', 'active', 'active', 1, ?, 1, ?, ?)`,
      )
      .bind(spec.customDomain, spec.id, NOW_MS, NOW_MS, NOW_MS)
      .run();
    await db
      .prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, 'subdomain', 'active', 'active', 0, ?, 1, ?, ?)`,
      )
      .bind(spec.subdomain, spec.id, NOW_MS, NOW_MS, NOW_MS)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO tenant_hosts (
           host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
      )
      .bind(spec.subdomain, spec.id, NOW_MS, NOW_MS, NOW_MS)
      .run();
  }

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  await orchestrateTenantMigration(db, stub, spec.id, [
    ...TENANT_MIGRATIONS,
    TENANT_PLUGIN_LEDGER_MIGRATION,
  ]);
  const tenantDb = createTenantDb(stub);
  await applyTenantSeoEditorMigration(tenantDb);

  const mediaVariants = JSON.stringify({
    slug: "kantor-modern",
    master: {
      key: `t/${spec.id}/media/101/master.webp`,
      width: 1920,
      height: 1080,
      bytes: 280_000,
      mimeType: "image/webp",
    },
    w1280: {
      key: `t/${spec.id}/media/101/w1280.webp`,
      width: 1280,
      height: 720,
      bytes: 120_000,
      mimeType: "image/webp",
    },
    w640: {
      key: `t/${spec.id}/media/101/w640.webp`,
      width: 640,
      height: 360,
      bytes: 60_000,
      mimeType: "image/webp",
    },
    thumb: {
      key: `t/${spec.id}/media/101/thumb.webp`,
      width: 320,
      height: 180,
      bytes: 22_000,
      mimeType: "image/webp",
    },
    og: {
      key: `t/${spec.id}/media/101/og.webp`,
      width: 1200,
      height: 630,
      bytes: 180_000,
      mimeType: "image/webp",
    },
  });

  await tenantDb.batch([
    tenantDb.prepare(`DELETE FROM resource_slugs`),
    tenantDb.prepare(`DELETE FROM pages`),
    tenantDb.prepare(`DELETE FROM offerings`),
    tenantDb.prepare(`DELETE FROM posts`),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
           id, site_title, tagline, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy, version, updated_at
         ) VALUES (1, ?, 'Solusi B2B Modern & Terpercaya', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'disallow', 1, ?)`,
      )
      .bind(spec.name, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (
           id, business_name, business_category, description, city, whatsapp_e164, version, updated_at
         ) VALUES (1, ?, 'b2b_corporate', 'Mitra renovasi kantor terpercaya', 'Jakarta Selatan', '6281234567890', 1, ?)`,
      )
      .bind(spec.name, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO media_items (
           id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text,
           variants_json, status, created_at, updated_at
         ) VALUES (101, 'image', ?, 'image/webp', 120000, 'sha256_t102_kantor_webp_0001', 1280, 720, 'Interior kantor modern', ?, 'ready', ?, ?)`,
      )
      .bind(`t/${spec.id}/media/101/w1280.webp`, mediaVariants, NOW_MS, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO installed_plugins (
           plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
         ) VALUES ('seo-ai-autopilot', '1.0.0', 1, '{}', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS),
  ]);

  // Publish site settings, homepage, offering, and blog post through real atomic publishers
  await publishResourceAtomically(db, tenantDb, {
    tenantId: spec.id,
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 1,
    draftOverride: {
      siteTitle: spec.name,
      tagline: "Solusi B2B Modern & Terpercaya",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      activeThemeId: "compro",
      blogEnabled: true,
      catalogEnabled: true,
      aiTrainingPolicy: "disallow",
      siteVisibility: "public",
    },
    nowMs: NOW_MS,
  });

  const homePage = await createPage(tenantDb, {
    title: "Beranda",
    slug: "beranda",
    isHomepage: true,
    sections: [
      {
        id: "hero-1",
        kind: "hero",
        heading: spec.name,
        subheading: "Solusi B2B Modern & Terpercaya",
        bodyHtml: "<p>Solusi profesional untuk kebutuhan bisnis Anda.</p>",
      },
    ],
    nowMs: NOW_MS,
  });
  await publishPage(db, tenantDb, {
    tenantId: spec.id,
    pageId: homePage.id,
    expectedVersion: homePage.version,
    nowMs: NOW_MS,
  });

  const offering = await createCatalogOffering(
    tenantDb,
    {
      offeringType: "service",
      title: "Jasa Renovasi Kantor",
      slug: "jasa-renovasi-kantor",
      summary: "Layanan renovasi kantor profesional untuk perusahaan di Jakarta.",
      description: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Pengerjaan cepat dan transparan." }],
      },
      coverMediaId: 101,
      priceMode: "from",
      price: 25_000_000,
      ctaKind: "whatsapp",
    },
    { nowMs: NOW_MS },
  );
  await publishCatalogOffering(db, tenantDb, {
    tenantId: spec.id,
    offeringId: offering.id,
    expectedVersion: offering.version,
    nowMs: NOW_MS,
  });

  const post = await createPost(tenantDb, {
    title: "Panduan Renovasi Kantor 2026",
    slug: "panduan-renovasi-kantor-2026",
    excerpt: "Tips menyusun anggaran dan jadwal renovasi kantor tanpa mengganggu operasional.",
    body: {
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Langkah penting sebelum renovasi ruang kerja." }],
    },
    coverMediaId: 101,
    nowMs: NOW_MS,
  });
  await publishPost(db, tenantDb, {
    tenantId: spec.id,
    postId: post.id,
    expectedVersion: post.version,
    nowMs: NOW_MS,
  });

  return tenantDb;
}

describe("TASK-102: Official Free Zero-Config Plugin seo-ai-autopilot Integration (workerd D1/DO)", () => {
  let tenantDbAlpha: D1Database;
  let tenantDbBeta: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    clearHostResolutionCache();
    await env.PLATFORM_DB.prepare(
      `DELETE FROM tenant_plugin_entitlements WHERE tenant_id IN (?, ?, ?, ?)`,
    )
      .bind(TENANT_ALPHA.id, TENANT_BETA.id, TENANT_TRIAL.id, TENANT_SUSPENDED.id)
      .run();
    tenantDbAlpha = await seedTenantWithPublishedContent({
      ...TENANT_ALPHA,
      status: "active",
    });
    tenantDbBeta = await seedTenantWithPublishedContent({
      ...TENANT_BETA,
      status: "active",
    });
    await seedTenantWithPublishedContent({
      ...TENANT_TRIAL,
      status: "trial",
    });
    await seedTenantWithPublishedContent({
      ...TENANT_SUSPENDED,
      status: "suspended",
    });
  });

  it("provisions new websites with seo-ai-autopilot active by default with zero owner action (DEC-042)", async () => {
    const prov = await provisionTenantAtomically(env.PLATFORM_DB, {
      idempotencyKey: "prov-t102-default-active-001",
      actorUserId: TENANT_ALPHA.ownerId,
      name: "Toko Baru Autopilot",
      handle: "toko-baru-t102",
      ownerEmail: `${TENANT_ALPHA.ownerId}@example.com`,
      vertical: "compro",
      reason: "TASK-102 provisioning default-active verification",
      tenantStore: getTenantStoreNs(),
      nowMs: NOW_MS,
    });

    const freshDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), prov.tenant.id));
    expect(await isSeoAutopilotEnabledForTenant(freshDb)).toBe(true);
    const row = await freshDb
      .prepare("SELECT plugin_id, enabled FROM installed_plugins WHERE plugin_id = 'seo-ai-autopilot'")
      .first<{ readonly plugin_id: string; readonly enabled: number }>();
    expect(row).toEqual({ plugin_id: "seo-ai-autopilot", enabled: 1 });
  });

  it("enforces full disable -> 404/minimal head/data preserved -> 1-click re-install -> immediate zero-config activation lifecycle", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const alphaDerivedKey = await deriveDeterministicTenantIndexNowKey(TENANT_ALPHA.id);

    // 1. Default-active zero-config state: sitemap, image sitemap, AI-split robots, deterministic IndexNow key, blog RSS ALL work!
    const sitemapActive = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      makeDiscoveryDeps(),
    );
    expect(sitemapActive.status).toBe(200);
    const sitemapActiveXml = await sitemapActive.text();
    expect(sitemapActiveXml).toContain(`https://${TENANT_ALPHA.customDomain}/sitemaps/pages.xml`);
    expect(sitemapActiveXml).toContain(`https://${TENANT_ALPHA.customDomain}/sitemaps/offerings.xml`);

    const offeringsSitemap = await handleSubSitemapRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/offerings.xml`),
      "offerings",
      makeDiscoveryDeps(),
    );
    expect(offeringsSitemap.status).toBe(200);
    const offeringsXml = await offeringsSitemap.text();
    expect(offeringsXml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(offeringsXml).toContain("<image:loc>");

    const robotsActive = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(robotsActive.status).toBe(200);
    const robotsActiveBody = await robotsActive.text();
    expect(robotsActiveBody).toContain("User-agent: OAI-SearchBot");
    expect(robotsActiveBody).toContain("User-agent: GPTBot");
    expect(robotsActiveBody).toContain(`Sitemap: https://${TENANT_ALPHA.customDomain}/sitemap.xml`);

    // Zero-config deterministic IndexNow key file serves 200 with Cache-Control: no-store immediately!
    const indexnowActive = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaDerivedKey}.txt`),
      alphaDerivedKey,
      { ...makeDiscoveryDeps(), indexnowKeySecret: null },
    );
    expect(indexnowActive.status).toBe(200);
    expect(indexnowActive.headers.get("Cache-Control")).toBe("no-store");
    expect(await indexnowActive.text()).toBe(alphaDerivedKey);

    // Keyed HMAC-SHA-256 secret derivation works consistently and rejects unkeyed SHA-256 key!
    const testSecret = "workerd-indexnow-hmac-secret-2026";
    const alphaHmacKey = await deriveDeterministicTenantIndexNowKey(TENANT_ALPHA.id, {
      secret: testSecret,
    });
    expect(alphaHmacKey).not.toBe(alphaDerivedKey);
    const indexnowHmacOk = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaHmacKey}.txt`),
      alphaHmacKey,
      { ...makeDiscoveryDeps(), indexnowKeySecret: testSecret },
    );
    expect(indexnowHmacOk.status).toBe(200);
    expect(indexnowHmacOk.headers.get("Cache-Control")).toBe("no-store");
    expect(await indexnowHmacOk.text()).toBe(alphaHmacKey);

    const indexnowUnkeyedRejected = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaDerivedKey}.txt`),
      alphaDerivedKey,
      { ...makeDiscoveryDeps(), indexnowKeySecret: testSecret },
    );
    expect(indexnowUnkeyedRejected.status).toBe(404);

    const feedActive = await handleBlogFeedRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
      makeDiscoveryDeps(),
    );
    expect(feedActive.status).toBe(200);
    expect(await feedActive.text()).toContain("Panduan Renovasi Kantor 2026");

    // 2. Save custom SEO override & verification token BEFORE disabling (must be preserved across disable!)
    const initialSettings = await getTenantSeoEditorSettings(
      env.PLATFORM_DB,
      tenantDbAlpha,
      TENANT_ALPHA.id,
    );
    const patchRes = await handleTenantSeoSettingsRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/seo/settings`, {
        method: "PATCH",
        body: {
          separator: "·",
          verification: { google: "gscT102PreservedToken_2026" },
          version: initialSettings.version,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.ownerId } },
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { readonly settings: { readonly version: number } };

    const pubRes = await handleTenantSeoPublishRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/seo/publish`, {
        method: "POST",
        body: { version: patched.settings.version },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.ownerId } },
    );
    expect(pubRes.status).toBe(200);

    // 3. Disable `seo-ai-autopilot` via 1-click toggle
    const disableRes = await handleTenantSeoToggleRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/seo/toggle`, {
        method: "POST",
        body: { enabled: false },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.ownerId } },
    );
    expect(disableRes.status).toBe(200);
    expect(await isSeoAutopilotEnabledForTenant(tenantDbAlpha)).toBe(false);
    clearHostResolutionCache();

    // 4. Verify ALL disabled invariants:
    // - `/sitemap.xml` -> 404 (no-store, noindex)
    const sitemapDisabled = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      makeDiscoveryDeps(NOW_MS + 1000),
    );
    expect(sitemapDisabled.status).toBe(404);
    expect(sitemapDisabled.headers.get("Cache-Control")).toContain("no-store");

    // - `/[indexnowKey].txt` -> 404
    const indexnowDisabled = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaDerivedKey}.txt`),
      alphaDerivedKey,
      makeDiscoveryDeps(NOW_MS + 1000),
    );
    expect(indexnowDisabled.status).toBe(404);
    expect(indexnowDisabled.headers.get("Cache-Control")).toContain("no-store");

    // - `/blog/feed.xml` -> 404
    const feedDisabled = await handleBlogFeedRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
      makeDiscoveryDeps(NOW_MS + 1000),
    );
    expect(feedDisabled.status).toBe(404);

    // - `/robots.txt` -> 200 clean minimal fallback with fresh explicit headers (no stale ETag, Vary: Host)
    const robotsDisabled = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
      makeDiscoveryDeps(NOW_MS + 1000),
    );
    expect(robotsDisabled.status).toBe(200);
    expect(robotsDisabled.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(robotsDisabled.headers.get("Vary")).toContain("Host");
    expect(robotsDisabled.headers.get("ETag")).toBeNull();
    const robotsDisabledBody = await robotsDisabled.text();
    expect(robotsDisabledBody).toContain("Disallow: /api/");
    expect(robotsDisabledBody).not.toContain("Sitemap:");
    expect(robotsDisabledBody).not.toContain("OAI-SearchBot");
    expect(robotsDisabledBody).not.toContain("GPTBot");

    // - Alias 301 canonical redirect remains 100% intact even when plugin is disabled!
    const aliasRobots = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_ALPHA.subdomain}/robots.txt`),
      makeDiscoveryDeps(NOW_MS + 1000),
    );
    expect(aliasRobots.status).toBe(301);
    expect(aliasRobots.headers.get("Location")).toBe(
      `https://${TENANT_ALPHA.customDomain}/robots.txt`,
    );

    // - Public SEO context reports `seoAutopilotEnabled: false` -> minimal `<head>` with ZERO JSON-LD & ZERO OG
    const pubSeoDisabled = await getPublishedPublicSeoContext(tenantDbAlpha, {
      tenantId: TENANT_ALPHA.id,
    });
    expect(pubSeoDisabled.seoAutopilotEnabled).toBe(false);
    const schemaDisabled = resolveAutopilotSchemaGraph(
      {
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: {
            tenantHandle: TENANT_ALPHA.handle,
            tenantStatus: "active",
            primaryHost: TENANT_ALPHA.customDomain,
            primaryHostKind: "custom",
            primaryHostStatus: "active",
            primaryHostSslStatus: "active",
            primaryHostVerified: true,
            verifiedTenantHosts: [TENANT_ALPHA.customDomain],
            servingHost: TENANT_ALPHA.customDomain,
          },
        },
        tenantId: TENANT_ALPHA.id,
        siteName: TENANT_ALPHA.name,
        business: { businessName: TENANT_ALPHA.name },
        pageTitle: "Beranda",
      },
      { seoAutopilotActive: pubSeoDisabled.seoAutopilotEnabled },
    );
    expect(schemaDisabled.emitted).toBe(false);
    const minimalHead = renderAutopilotSeoHead({
      metadata: generateOpenGraphMetadata({
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: {
            tenantHandle: TENANT_ALPHA.handle,
            tenantStatus: "active",
            primaryHost: TENANT_ALPHA.customDomain,
            primaryHostKind: "custom",
            primaryHostStatus: "active",
            primaryHostSslStatus: "active",
            primaryHostVerified: true,
            verifiedTenantHosts: [TENANT_ALPHA.customDomain],
            servingHost: TENANT_ALPHA.customDomain,
          },
        },
        siteName: TENANT_ALPHA.name,
      }),
      seoAutopilotActive: pubSeoDisabled.seoAutopilotEnabled,
    });
    expect(minimalHead.html).toContain("<title>");
    expect(minimalHead.html).not.toContain('type="application/ld+json"');
    expect(minimalHead.html).not.toContain('property="og:title"');

    // - Saved overrides remain intact in `plg_seo_ai_autopilot__settings`!
    const preservedWhileDisabled = await getTenantSeoEditorSettings(
      env.PLATFORM_DB,
      tenantDbAlpha,
      TENANT_ALPHA.id,
    );
    expect(preservedWhileDisabled.seoAutopilotEnabled).toBe(false);
    expect(preservedWhileDisabled.draft.searchAppearance.separator).toBe("·");
    expect(preservedWhileDisabled.published?.verificationTokens.google).toBe(
      "gscT102PreservedToken_2026",
    );

    // 5. 1-click re-install via Plugin Runtime `POST /api/tenants/:tenantId/plugins` (`Pasang (Gratis)`)
    const reinstallRes = await handleTenantPluginsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins`, {
        method: "POST",
        body: { pluginId: "seo-ai-autopilot" },
      }),
      runtimeEnv,
      {
        authenticatedUser: { id: TENANT_ALPHA.ownerId },
        getBookmark: async () => `bm_t102_${NOW_MS}`,
      },
    );
    expect(reinstallRes.status).toBe(200);
    const reinstalledJson = (await reinstallRes.json()) as {
      readonly plugin: { readonly id: string; readonly enabled: boolean; readonly visibility: string };
    };
    expect(reinstalledJson.plugin.id).toBe("seo-ai-autopilot");
    expect(reinstalledJson.plugin.enabled).toBe(true);
    expect(reinstalledJson.plugin.visibility).toBe("public_free");

    await bumpTenantCacheVersion(env.PLATFORM_DB, TENANT_ALPHA.id, NOW_MS + 2000);
    clearHostResolutionCache();

    // Immediately serves valid `/sitemap.xml`, AI-split `/robots.txt`, `/[indexnowKey].txt`, `/blog/feed.xml`, AND preserves saved overrides!
    const sitemapReinstalled = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      makeDiscoveryDeps(NOW_MS + 3000),
    );
    expect(sitemapReinstalled.status).toBe(200);

    const robotsReinstalled = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
      makeDiscoveryDeps(NOW_MS + 3000),
    );
    expect(robotsReinstalled.status).toBe(200);
    const robotsReinstalledBody = await robotsReinstalled.text();
    expect(robotsReinstalledBody).toContain("User-agent: OAI-SearchBot");
    expect(robotsReinstalledBody).toContain(
      `Sitemap: https://${TENANT_ALPHA.customDomain}/sitemap.xml`,
    );

    const indexnowReinstalled = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaDerivedKey}.txt`),
      alphaDerivedKey,
      { ...makeDiscoveryDeps(NOW_MS + 3000), indexnowKeySecret: null },
    );
    expect(indexnowReinstalled.status).toBe(200);
    expect(indexnowReinstalled.headers.get("Cache-Control")).toBe("no-store");
    expect(await indexnowReinstalled.text()).toBe(alphaDerivedKey);

    const feedReinstalled = await handleBlogFeedRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
      makeDiscoveryDeps(NOW_MS + 3000),
    );
    expect(feedReinstalled.status).toBe(200);

    // Slot-3 scoped status API confirms preserved saved overrides & zero-config readiness
    const statusApiRes = await handleTenantPluginSubpathApiRequest(
      TENANT_ALPHA.handle,
      "seo-ai-autopilot",
      "status",
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins/seo-ai-autopilot/status`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.ownerId } },
    );
    expect(statusApiRes.status).toBe(200);
    const statusData = (await statusApiRes.json()) as {
      readonly pluginId: string;
      readonly defaultActiveOnProvision: boolean;
      readonly hasSavedOverrides: boolean;
      readonly preservesOverridesOnDisable: boolean;
    };
    expect(statusData.pluginId).toBe("seo-ai-autopilot");
    expect(statusData.defaultActiveOnProvision).toBe(true);
    expect(statusData.hasSavedOverrides).toBe(true);
    expect(statusData.preservesOverridesOnDisable).toBe(true);

    const restoredSettings = await getTenantSeoEditorSettings(
      env.PLATFORM_DB,
      tenantDbAlpha,
      TENANT_ALPHA.id,
    );
    expect(restoredSettings.draft.searchAppearance.separator).toBe("·");
    expect(restoredSettings.published?.verificationTokens.google).toBe(
      "gscT102PreservedToken_2026",
    );
  });

  it("preserves trial and suspended noindex/503 safety when disabled, and enforces tenant isolation, RBAC & CSRF", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Disable plugin on Trial and Suspended tenants -> safety rules MUST hold!
    const trialDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_TRIAL.id));
    await trialDb
      .prepare("UPDATE installed_plugins SET enabled = 0 WHERE plugin_id = 'seo-ai-autopilot'")
      .run();
    const suspDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_SUSPENDED.id));
    await suspDb
      .prepare("UPDATE installed_plugins SET enabled = 0 WHERE plugin_id = 'seo-ai-autopilot'")
      .run();

    const trialRobots = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_TRIAL.subdomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(trialRobots.status).toBe(200);
    expect(trialRobots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await trialRobots.text()).toBe("User-agent: *\nDisallow: /\n");

    const suspRobots = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_SUSPENDED.customDomain}/robots.txt`),
      makeDiscoveryDeps(),
    );
    expect(suspRobots.status).toBe(503);
    expect(suspRobots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const suspSitemap = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_SUSPENDED.customDomain}/sitemap.xml`),
      makeDiscoveryDeps(),
    );
    expect(suspSitemap.status).toBe(503);

    // 2. Tenant isolation: Alpha's IndexNow key returns 404 on Beta's custom domain!
    const alphaKey = await deriveDeterministicTenantIndexNowKey(TENANT_ALPHA.id);
    const betaKey = await deriveDeterministicTenantIndexNowKey(TENANT_BETA.id);
    expect(alphaKey).not.toBe(betaKey);

    const crossKeyRes = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_BETA.customDomain}/${alphaKey}.txt`),
      alphaKey,
      makeDiscoveryDeps(),
    );
    expect(crossKeyRes.status).toBe(404);

    // Beta owner cannot touch Alpha's plugin endpoints (neutral 404)
    const crossTenantList = await handleTenantPluginsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_BETA.ownerId } },
    );
    expect(crossTenantList.status).toBe(404);

    // 3. RBAC: Editor cannot install/disable seo-ai-autopilot -> 403 FORBIDDEN
    const editorInstall = await handleTenantPluginsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins`, {
        method: "POST",
        body: { pluginId: "seo-ai-autopilot" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.editorId } },
    );
    expect(editorInstall.status).toBe(403);

    const editorToggle = await handleTenantPluginDetailRequest(
      TENANT_ALPHA.handle,
      "seo-ai-autopilot",
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins/seo-ai-autopilot`, {
        method: "PATCH",
        body: { enabled: false },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.editorId } },
    );
    expect(editorToggle.status).toBe(403);

    // 4. CSRF: cross-origin POST/PATCH rejected with 403
    const csrfInstall = await handleTenantPluginsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAppRequest(`/api/tenants/${TENANT_ALPHA.handle}/plugins`, {
        method: "POST",
        origin: "https://evil.example.com",
        body: { pluginId: "seo-ai-autopilot" },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_ALPHA.ownerId } },
    );
    expect(csrfInstall.status).toBe(403);

    // Tenant B remains unaffected by Alpha's mutations
    expect(await isSeoAutopilotEnabledForTenant(tenantDbBeta)).toBe(true);

    // 5. Fail-CLOSED on throwing TenantStore DB across ALL 4 discovery routes!
    const throwingTenantDb = {
      prepare() {
        throw new Error("SIMULATED_TENANT_DB_OUTAGE");
      },
    } as unknown as D1Database;

    const brokenDeps = {
      ...makeDiscoveryDeps(),
      tenantDb: throwingTenantDb,
    };

    const brokenSitemap = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/sitemap.xml`),
      brokenDeps,
    );
    expect(brokenSitemap.status).toBe(503);
    expect(brokenSitemap.headers.get("Cache-Control")).toBe("no-store");
    expect(brokenSitemap.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const brokenRobots = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/robots.txt`),
      brokenDeps,
    );
    expect(brokenRobots.status).toBe(503);
    expect(brokenRobots.headers.get("Cache-Control")).toBe("no-store");
    expect(brokenRobots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await brokenRobots.text()).toBe("User-agent: *\nDisallow: /\n");

    const brokenFeed = await handleBlogFeedRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`),
      brokenDeps,
    );
    expect(brokenFeed.status).toBe(503);
    expect(brokenFeed.headers.get("Cache-Control")).toBe("no-store");
    expect(brokenFeed.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const brokenIndexNow = await handleIndexNowKeyRequest(
      new Request(`https://${TENANT_ALPHA.customDomain}/${alphaKey}.txt`),
      alphaKey,
      { ...brokenDeps, indexnowKeySecret: null },
    );
    expect(brokenIndexNow.status).toBe(404);
    expect(brokenIndexNow.headers.get("Cache-Control")).toBe("no-store");
    expect(brokenIndexNow.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});
