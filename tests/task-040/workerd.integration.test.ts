import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  publishSiteIdentity,
  saveSiteIdentityDraft,
} from "@punyasitus/db/identity/index";
import { publishResourceAtomically, saveDraftResource } from "@punyasitus/db/publication/index";
import {
  getGroupedSettingsForAdmin,
  getPublishedGroupedSettings,
  PublicationAtomicError,
  publishGroupedSettings,
  saveGroupedSettingsDraft,
  StaleRevisionError,
} from "@punyasitus/db/settings/index";
import { TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION } from "@punyasitus/db/settings/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPublishedTenantShellData } from "../../apps/web/src/core/public-data.ts";
import {
  resolveBlogListingRoute,
  resolveOfferingListingRoute,
  resolvePublicPageRoute,
} from "../../apps/web/src/core/public-routes.ts";
import {
  applyPublishedSettingsToShell,
  loadPublishedPublicSettingsDefaults,
} from "../../apps/web/src/core/settings.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantSettingsGroupRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/[group].ts";
import { handleTenantSettingsIndexRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/index.ts";
import { handleTenantSettingsPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/publish.ts";
import type { TenantSettingsRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/_shared.ts";
import {
  handleBlogFeedRequest,
  handleRobotsTxtRequest,
  handleSitemapIndexRequest,
  handleSubSitemapRequest,
} from "../../apps/web/src/pages/sitemaps/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 23, 2, 0, 0);

const TENANT_A = {
  id: "01JT040TENANTA000000000001",
  orgId: "org_t040_alpha",
  handle: "t040-alpha",
  name: "T040 Alpha Nusantara",
  host: "t040-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT040TENANTB000000000002",
  orgId: "org_t040_beta",
  handle: "t040-beta",
  name: "T040 Beta Mandiri",
  host: "t040-beta.situsku.click",
} as const;

const TENANT_LOCKED = {
  id: "01JT040TENANTC000000000003",
  orgId: "org_t040_locked",
  handle: "t040-locked",
  name: "T040 Locked Corp",
  host: "t040-locked.situsku.click",
} as const;

function buildRuntimeEnv(
  overrides: Partial<TenantSettingsRuntimeEnv> = {},
): TenantSettingsRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookie(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const found = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!found) {
    throw new Error(`Missing ${APP_SESSION_COOKIE_NAME} in ${JSON.stringify(cookies)}`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeApiRequest(
  url: string,
  method: "GET" | "PATCH" | "POST" = "GET",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly contentType?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin !== undefined) {
    if (options.origin !== null) headers.set("Origin", options.origin);
  } else if (method !== "GET") {
    headers.set("Origin", new URL(url).origin);
  }
  if (options.contentType !== undefined) {
    if (options.contentType !== null) headers.set("Content-Type", options.contentType);
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function signUpAppUser(email: string, name: string): Promise<{
  readonly userId: string;
  readonly cookie: string;
}> {
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({
      email,
      password: "PasswordKu123!@#",
      name,
    }),
  });
  const res = await handleBetterAuthRequest(req, buildRuntimeEnv());
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { user: { id: string } };
  return {
    userId: payload.user.id,
    cookie: extractSessionCookie(res),
  };
}

async function migrateTenant(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike & {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  };
  const stub = ns.get(ns.idFromName(tenantId));
  await runInDurableObject(stub, (_instance, state) => {
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION,
    ]);
  });
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function seedTenantContent(tenantId: string, tenantDb: D1Database, siteTitle: string) {
  const now = BASE_NOW_MS;
  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
           id, site_title, tagline, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy, analytics_config_json,
           version, updated_at
         ) VALUES (1, ?, 'Tagline Awal', 'Asia/Jakarta', 'id-ID', 'travel', 1, 1, 'allow', ?, 1, ?)`,
      )
      .bind(siteTitle, JSON.stringify({ ga4MeasurementId: "G-KEEP999888" }), now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (
           id, business_name, business_category, description, email, phone, whatsapp_e164,
           version, updated_at
         ) VALUES (1, ?, 'LocalBusiness', 'Deskripsi awal bisnis', 'awal@example.com', '62215550001', '6281200001111', 1, ?)`,
      )
      .bind(siteTitle, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO media_items (
           id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at
         ) VALUES (10, 'image', ?, 'image/webp', 12000, 'sha256-t040-10', 1200, 630, 'Logo & OG Resmi', 'ready', 1, ?, ?)`,
      )
      .bind(`t/${tenantId}/media/logo-10.webp`, now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages (
           id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at
         ) VALUES (1, 'beranda', 'Beranda Utama', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages (
           id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at
         ) VALUES (2, 'profil-perusahaan', 'Profil Perusahaan', 0, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages (
           id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at
         ) VALUES (3, 'halaman-draf', 'Halaman Masih Draf', 0, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO posts (
           id, slug, title, excerpt, draft_body_json, status, version, created_at, updated_at
         ) VALUES (1, 'artikel-pertama', 'Artikel Pertama Nusantara', 'Ringkasan artikel', '{}', 'draft', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO offerings (
           id, offering_type, slug, title, summary, price_mode, price, cta_mode, status, version, created_at, updated_at
         ) VALUES (1, 'service', 'konsultasi-konstruksi', 'Konsultasi Konstruksi', 'Pendampingan penuh', 'fixed', 2500000, 'whatsapp', 'draft', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO menus (
           id, location, items_json, version, created_at, updated_at
         ) VALUES (1, 'header', '[]', 1, ?, ?)`,
      )
      .bind(now, now),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO installed_plugins (
           plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
         ) VALUES ('seo-ai-autopilot', '1.0.0', 1, '{}', 1, ?, ?)`,
      )
      .bind(now, now),
  ]);

  // Publish initial site_settings, business_profile, page 1 (homepage), page 2 (published), post 1, offering 1, and header menu
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: now,
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "business_profile",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: now,
  });
  await saveDraftResource(tenantDb, {
    resourceType: "page",
    resourceId: 1,
    expectedVersion: 1,
    draft: { slug: "beranda", title: "Beranda Utama", isHomepage: true, layoutMode: "standard", sections: [] },
    nowMs: now,
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "page",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: now,
  });
  await saveDraftResource(tenantDb, {
    resourceType: "page",
    resourceId: 2,
    expectedVersion: 1,
    draft: { slug: "profil-perusahaan", title: "Profil Perusahaan", isHomepage: false, layoutMode: "standard", sections: [] },
    nowMs: now,
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "page",
    resourceId: 2,
    expectedVersion: 2,
    nowMs: now,
  });
  await saveDraftResource(tenantDb, {
    resourceType: "post",
    resourceId: 1,
    expectedVersion: 1,
    draft: {
      slug: "artikel-pertama",
      title: "Artikel Pertama Nusantara",
      excerpt: "Ringkasan artikel",
      body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Isi artikel publik pertama." }] },
      readingTimeMinutes: 2,
      showToc: false,
    },
    nowMs: Date.UTC(2026, 11, 15, 16, 30, 0),
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "post",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: Date.UTC(2026, 11, 15, 16, 30, 0),
  });
  await saveDraftResource(tenantDb, {
    resourceType: "offering",
    resourceId: 1,
    expectedVersion: 1,
    draft: {
      offeringType: "service",
      slug: "konsultasi-konstruksi",
      title: "Konsultasi Konstruksi",
      summary: "Pendampingan proyek komersial",
      priceMode: "fixed",
      price: 2_500_000,
      ctaMode: "whatsapp",
      galleryMediaIds: [],
      attributesVersion: 1,
      attributes: {},
    },
    nowMs: now,
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "offering",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: now,
  });
  await saveDraftResource(tenantDb, {
    resourceType: "menu",
    resourceId: 1,
    expectedVersion: 1,
    draft: {
      location: "header",
      items: [
        { label: "Beranda", href: "/", openInNewTab: false, children: [] },
        { label: "Blog", href: "/blog", openInNewTab: false, children: [] },
        { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
        { label: "Profil", href: "/profil-perusahaan", openInNewTab: false, children: [] },
      ],
    },
    nowMs: now,
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId,
    resourceType: "menu",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: now,
  });
}

describe("TASK-040 Workerd Integration: Grouped Admin Settings, Draft/Publish Separation, Public Defaults & Security", () => {
  let ownerACookie = "";
  let adminACookie = "";
  let editorACookie = "";
  let ownerBCookie = "";
  let ownerLockedCookie = "";
  let tenantADb!: D1Database;
  let tenantBDb!: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    for (const t of [
      { ...TENANT_A, status: "active" as const },
      { ...TENANT_B, status: "active" as const },
      { ...TENANT_LOCKED, status: "locked" as const },
    ]) {
      await db
        .insert(organizations)
        .values({ id: t.orgId, name: t.name, slug: t.handle, createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      await db
        .insert(tenants)
        .values({
          id: t.id,
          organizationId: t.orgId,
          handle: t.handle,
          name: t.name,
          vertical: "compro",
          status: t.status,
          cacheVersion: 1,
          schemaVersion: 3,
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
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    const ownerA = await signUpAppUser("owner-a@t040.test", "Owner Alpha");
    const adminA = await signUpAppUser("admin-a@t040.test", "Admin Alpha");
    const editorA = await signUpAppUser("editor-a@t040.test", "Editor Alpha");
    const ownerB = await signUpAppUser("owner-b@t040.test", "Owner Beta");
    const ownerLocked = await signUpAppUser("owner-locked@t040.test", "Owner Locked");

    ownerACookie = ownerA.cookie;
    adminACookie = adminA.cookie;
    editorACookie = editorA.cookie;
    ownerBCookie = ownerB.cookie;
    ownerLockedCookie = ownerLocked.cookie;

    await db
      .insert(members)
      .values([
        { id: "m_t040_oa", organizationId: TENANT_A.orgId, userId: ownerA.userId, role: "owner", createdAt: now },
        { id: "m_t040_aa", organizationId: TENANT_A.orgId, userId: adminA.userId, role: "admin", createdAt: now },
        { id: "m_t040_ea", organizationId: TENANT_A.orgId, userId: editorA.userId, role: "editor", createdAt: now },
        { id: "m_t040_ob", organizationId: TENANT_B.orgId, userId: ownerB.userId, role: "owner", createdAt: now },
        { id: "m_t040_ol", organizationId: TENANT_LOCKED.orgId, userId: ownerLocked.userId, role: "owner", createdAt: now },
      ])
      .onConflictDoNothing();

    tenantADb = await migrateTenant(TENANT_A.id);
    tenantBDb = await migrateTenant(TENANT_B.id);
    const tenantLockedDb = await migrateTenant(TENANT_LOCKED.id);

    await seedTenantContent(TENANT_A.id, tenantADb, TENANT_A.name);
    await seedTenantContent(TENANT_B.id, tenantBDb, TENANT_B.name);
    await seedTenantContent(TENANT_LOCKED.id, tenantLockedDb, TENANT_LOCKED.name);
  });

  it("enforces RBAC (editor denied 403), locked read-only (403 SUBSCRIPTION_LOCKED), CSRF, and cross-tenant isolation (404)", async () => {
    const rt = buildRuntimeEnv();

    // 1. Editor cannot read, patch, or publish settings -> 403
    const editorGet = await handleTenantSettingsIndexRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings`, "GET", {
        cookie: editorACookie,
      }),
      rt,
    );
    expect(editorGet.status).toBe(403);
    expect(editorGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(editorGet.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const editorPatch = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: editorACookie,
        body: { siteTitle: "Hacked by Editor", expectedVersion: 2 },
      }),
      rt,
    );
    expect(editorPatch.status).toBe(403);

    const editorPublish = await handleTenantSettingsPublishRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/publish`, "POST", {
        cookie: editorACookie,
        body: { expectedVersion: 2 },
      }),
      rt,
    );
    expect(editorPublish.status).toBe(403);

    // 2. Locked tenant: GET allowed read-only, PATCH & publish rejected with 403 SUBSCRIPTION_LOCKED
    const lockedGet = await handleTenantSettingsGroupRequest(
      TENANT_LOCKED.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/settings/general`, "GET", {
        cookie: ownerLockedCookie,
      }),
      rt,
    );
    expect(lockedGet.status).toBe(200);

    const lockedPatch = await handleTenantSettingsGroupRequest(
      TENANT_LOCKED.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/settings/general`, "PATCH", {
        cookie: ownerLockedCookie,
        body: { siteTitle: "Should Fail", expectedVersion: 2 },
      }),
      rt,
    );
    expect(lockedPatch.status).toBe(403);
    expect(((await lockedPatch.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    const lockedPub = await handleTenantSettingsPublishRequest(
      TENANT_LOCKED.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_LOCKED.handle}/settings/publish`, "POST", {
        cookie: ownerLockedCookie,
        body: { expectedVersion: 2 },
      }),
      rt,
    );
    expect(lockedPub.status).toBe(403);

    // 3. Cross-tenant isolation: Owner B trying to access/mutate Tenant A -> 404 NOT_FOUND
    const crossGet = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "GET", {
        cookie: ownerBCookie,
      }),
      rt,
    );
    expect(crossGet.status).toBe(404);

    const crossPatch = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerBCookie,
        body: { siteTitle: "Cross Tenant Attack", expectedVersion: 2 },
      }),
      rt,
    );
    expect(crossPatch.status).toBe(404);

    // 4. Wrong host & missing CSRF Origin rejected
    const wrongHost = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`https://${TENANT_A.host}/api/tenants/${TENANT_A.handle}/settings/general`, "GET", {
        cookie: ownerACookie,
      }),
      rt,
    );
    expect(wrongHost.status).toBe(404);

    const badOrigin = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerACookie,
        origin: "https://evil.example.com",
        body: { siteTitle: "CSRF", expectedVersion: 2 },
      }),
      rt,
    );
    expect(badOrigin.status).toBe(403);
  });

  it("saves drafts across General, Business, Reading, and SEO without altering live output, rejects 422 & 409, then publishes atomically preserving unrelated fields", async () => {
    const rt = buildRuntimeEnv();
    const publicDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      platformDomain: "punyasitus.com",
      saasZone: "situsku.click",
      bypassHostCache: true,
    };

    // Initial GET by Owner A
    const initRes = await handleTenantSettingsIndexRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings`, "GET", {
        cookie: ownerACookie,
      }),
      rt,
    );
    expect(initRes.status).toBe(200);
    const initData = (await initRes.json()) as {
      version: number;
      draft: { general: { siteTitle: string; timezone: string } };
      published: { general: { siteTitle: string } } | null;
    };
    expect(initData.version).toBe(2);
    expect(initData.draft.general.siteTitle).toBe(TENANT_A.name);

    // 422 validation errors: invalid timezone, unpublished homepage, foreign media ID, unknown field
    const badTz = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerACookie,
        body: { timezone: "Not/A_Zone", expectedVersion: initData.version },
      }),
      rt,
    );
    expect(badTz.status).toBe(422);

    const badMedia = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerACookie,
        body: { faviconMediaId: 99999, expectedVersion: initData.version },
      }),
      rt,
    );
    expect(badMedia.status).toBe(422);

    const draftHomepageErr = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "reading",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/reading`, "PATCH", {
        cookie: ownerACookie,
        body: { homepageMode: "page", homepagePageId: 3, expectedVersion: initData.version },
      }),
      rt,
    );
    expect(draftHomepageErr.status).toBe(422);
    expect(((await draftHomepageErr.json()) as { error: { fields?: { code: string }[] } }).error.fields?.[0]?.code).toBe(
      "HOMEPAGE_NOT_PUBLISHED",
    );

    // 409 stale version rejected without mutation
    const staleRes = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerACookie,
        body: { siteTitle: "Stale Update", expectedVersion: 999 },
      }),
      rt,
    );
    expect(staleRes.status).toBe(409);

    // 1. Owner saves General draft (siteTitle, timezone Asia/Jayapura, media #10, publicEmail)
    const genRes = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "general",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/general`, "PATCH", {
        cookie: ownerACookie,
        body: {
          siteTitle: "Nusantara Konstruksi Baru",
          tagline: "Draf Tagline Baru",
          timezone: "Asia/Jayapura",
          publicEmail: "kontak@nusantara-baru.co.id",
          logoMediaId: 10,
          faviconMediaId: 10,
          expectedVersion: initData.version,
        },
      }),
      rt,
    );
    expect(genRes.status).toBe(200);
    const genBody = (await genRes.json()) as { version: number; hasUnpublishedChanges: boolean };
    expect(genBody.version).toBe(3);
    expect(genBody.hasUnpublishedChanges).toBe(true);

    // 2. Admin saves Business draft
    const bizRes = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "business",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/business`, "PATCH", {
        cookie: adminACookie,
        body: {
          businessName: "PT Nusantara Konstruksi Baru",
          businessCategory: "HomeAndConstructionBusiness",
          whatsappE164: "0812-8888-9999",
          address: "Jl. Gatot Subroto No. 88",
          mapsUrl: "https://maps.google.com/?q=-6.23,106.82",
          socialLinks: [{ platform: "instagram", url: "https://instagram.com/nusantarakonstruksi" }],
          expectedVersion: genBody.version,
        },
      }),
      rt,
    );
    expect(bizRes.status).toBe(200);
    const bizBody = (await bizRes.json()) as { version: number };
    expect(bizBody.version).toBe(4);

    // 3. Owner saves Reading draft (disable blog + catalog, set published page #2 as homepage, itemsPerPage 24)
    const readRes = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "reading",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/reading`, "PATCH", {
        cookie: ownerACookie,
        body: {
          homepageMode: "page",
          homepagePageId: 2,
          blogEnabled: false,
          catalogEnabled: false,
          enabledOfferingTypes: [],
          itemsPerPage: 24,
          expectedVersion: bizBody.version,
        },
      }),
      rt,
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { version: number };
    expect(readBody.version).toBe(5);

    // 4. Owner saves SEO draft (defaultTitle, defaultDescription, ogImageMediaId #10, siteVisibility noindex)
    const seoRes = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "seo",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/seo`, "PATCH", {
        cookie: ownerACookie,
        body: {
          defaultTitle: "Nusantara Konstruksi — Default SEO",
          defaultDescription: "Deskripsi SEO default perusahaan.",
          ogImageMediaId: 10,
          siteVisibility: "noindex",
          expectedVersion: readBody.version,
        },
      }),
      rt,
    );
    expect(seoRes.status).toBe(200);
    const seoBody = (await seoRes.json()) as { version: number; hasUnpublishedChanges: boolean };
    expect(seoBody.version).toBe(6);
    expect(seoBody.hasUnpublishedChanges).toBe(true);

    // VERIFY DRAFT PERSISTS ACROSS RELOAD WITHOUT CHANGING LIVE PUBLIC OUTPUT!
    const reloadedRes = await handleTenantSettingsIndexRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings`, "GET", {
        cookie: ownerACookie,
      }),
      rt,
    );
    const reloaded = (await reloadedRes.json()) as {
      version: number;
      hasUnpublishedChanges: boolean;
      draft: {
        general: { siteTitle: string; timezone: string };
        reading: { blogEnabled: boolean; catalogEnabled: boolean; homepagePageId: number | null };
        seo: { siteVisibility: string };
      };
      published: {
        general: { siteTitle: string; timezone: string };
        reading: { blogEnabled: boolean; catalogEnabled: boolean };
        seo: { siteVisibility: string };
      };
    };
    expect(reloaded.version).toBe(6);
    expect(reloaded.hasUnpublishedChanges).toBe(true);
    expect(reloaded.draft.general.siteTitle).toBe("Nusantara Konstruksi Baru");
    expect(reloaded.draft.reading.blogEnabled).toBe(false);
    expect(reloaded.draft.seo.siteVisibility).toBe("noindex");
    // Published snapshot MUST still have the original live values!
    expect(reloaded.published.general.siteTitle).toBe(TENANT_A.name);
    expect(reloaded.published.reading.blogEnabled).toBe(true);
    expect(reloaded.published.seo.siteVisibility).toBe("public");

    // Live public routes BEFORE publish: blog 200, catalog 200, sitemap 200, homepage still original!
    const liveBlogBefore = await resolveBlogListingRoute(
      new Request(`https://${TENANT_A.host}/blog`),
      publicDeps,
    );
    expect(liveBlogBefore.kind).toBe("blog_listing");
    if (liveBlogBefore.kind === "blog_listing") {
      // Published timestamp 2026-12-15T16:30:00Z in Asia/Jakarta (UTC+7) = 15 Desember 2026
      expect(liveBlogBefore.items[0]?.publishedDateLabel).toBe("15 Desember 2026");
    }
    const liveCatalogBefore = await resolveOfferingListingRoute(
      new Request(`https://${TENANT_A.host}/layanan`),
      publicDeps,
      "service",
    );
    expect(liveCatalogBefore.kind).toBe("offering_listing");

    const liveSitemapBefore = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_A.host}/sitemap.xml`),
      publicDeps,
    );
    expect(liveSitemapBefore.status).toBe(200);
    const sitemapXmlBefore = await liveSitemapBefore.text();
    expect(sitemapXmlBefore).toContain("/sitemaps/posts.xml");
    expect(sitemapXmlBefore).toContain("/sitemaps/offerings.xml");

    // Stale publish -> 409
    const stalePub = await handleTenantSettingsPublishRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/publish`, "POST", {
        cookie: ownerACookie,
        body: { expectedVersion: 2 },
      }),
      rt,
    );
    expect(stalePub.status).toBe(409);

    // ATOMIC PUBLISH!
    const beforeCacheRow = await env.PLATFORM_DB.prepare(
      "SELECT cache_version FROM tenants WHERE id = ?",
    )
      .bind(TENANT_A.id)
      .first<{ cache_version: number }>();

    const pubRes = await handleTenantSettingsPublishRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/publish`, "POST", {
        cookie: ownerACookie,
        body: { expectedVersion: seoBody.version },
      }),
      rt,
    );
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as {
      version: number;
      publishedVersion: number;
      cacheVersion: number;
      hasUnpublishedChanges: boolean;
    };
    expect(pubBody.version).toBe(7);
    expect(pubBody.publishedVersion).toBe(7);
    expect(pubBody.hasUnpublishedChanges).toBe(false);
    expect(pubBody.cacheVersion).toBe((beforeCacheRow?.cache_version ?? 0) + 1);

    // Verify unrelated fields (`activeThemeId: "travel"`, `analyticsConfig.ga4MeasurementId: "G-KEEP999888"`) survived atomic publish!
    const rawSettingsAfter = await tenantADb
      .prepare("SELECT active_theme_id, analytics_config_json, timezone, blog_enabled, catalog_enabled FROM site_settings WHERE id = 1")
      .first<{
        active_theme_id: string;
        analytics_config_json: string | null;
        timezone: string;
        blog_enabled: number;
        catalog_enabled: number;
      }>();
    expect(rawSettingsAfter?.active_theme_id).toBe("travel");
    expect(rawSettingsAfter?.analytics_config_json).toContain("G-KEEP999888");
    expect(rawSettingsAfter?.timezone).toBe("Asia/Jayapura");
    expect(rawSettingsAfter?.blog_enabled).toBe(0);
    expect(rawSettingsAfter?.catalog_enabled).toBe(0);

    // Verify audit log entries were written atomically
    const auditLogs = await tenantADb
      .prepare("SELECT action, actor_role FROM tenant_activity_log WHERE resource_type = 'site_settings' ORDER BY id ASC")
      .all<{ action: string; actor_role: string }>();
    expect(auditLogs.results.some((r) => r.action === "settings.draft_saved")).toBe(true);
    expect(auditLogs.results.some((r) => r.action === "settings.published")).toBe(true);

    // VERIFY LIVE PUBLIC OUTPUT AFTER PUBLISH:
    // 1. Homepage is now page #2 ("Profil Perusahaan") and `/profil-perusahaan` 308-redirects to `/`!
    const liveHomeAfter = await resolvePublicPageRoute(
      new Request(`https://${TENANT_A.host}/`),
      publicDeps,
      "",
    );
    expect(liveHomeAfter.kind).toBe("page");
    if (liveHomeAfter.kind === "page") {
      expect(liveHomeAfter.pageTitle).toBe("Profil Perusahaan");
      expect(liveHomeAfter.shell.site.title).toBe("Nusantara Konstruksi Baru");
      expect(liveHomeAfter.shell.site.siteVisibility).toBe("noindex");
      expect(liveHomeAfter.http.headers["X-Robots-Tag"]).toContain("noindex");
    }
    const formerHomeSlugRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_A.host}/profil-perusahaan`),
      publicDeps,
      "profil-perusahaan",
    );
    expect(formerHomeSlugRes.kind).toBe("response");
    if (formerHomeSlugRes.kind === "response") {
      expect(formerHomeSlugRes.response.status).toBe(308);
      expect(formerHomeSlugRes.response.headers.get("Location")).toBe(`https://${TENANT_A.host}/`);
    }

    // 2. Disabled blog & catalog return 404 on public routes AND prune live `loadPublishedTenantShellData` navigation directly!
    const blogAfter = await resolveBlogListingRoute(
      new Request(`https://${TENANT_A.host}/blog`),
      publicDeps,
    );
    expect(blogAfter.kind).toBe("not_found");

    const catalogAfter = await resolveOfferingListingRoute(
      new Request(`https://${TENANT_A.host}/layanan`),
      publicDeps,
      "service",
    );
    expect(catalogAfter.kind).toBe("not_found");

    // Live `loadPublishedTenantShellData` itself filters disabled `/blog` & `/layanan` in published mode!
    const liveShellAfter = await loadPublishedTenantShellData(tenantADb);
    expect(liveShellAfter.menus.header.map((i) => i.href)).toEqual(["/", "/profil-perusahaan"]);

    // Draft preview mode without siteSettings override does NOT mutate preview menus
    const previewShellUnfiltered = await loadPublishedTenantShellData(tenantADb, {
      previewMode: true,
    });
    expect(previewShellUnfiltered.menus.header.map((i) => i.href)).toEqual([
      "/",
      "/blog",
      "/layanan",
      "/profil-perusahaan",
    ]);

    const pubDefaults = await loadPublishedPublicSettingsDefaults(tenantADb);
    const filteredShell = applyPublishedSettingsToShell(liveShellAfter, pubDefaults);
    expect(filteredShell.menus.header.map((i) => i.href)).toEqual(["/", "/profil-perusahaan"]);

    // 3. Site `noindex` removes sitemap (404) & sets robots.txt Disallow: / with no Sitemap:
    const sitemapNoindex = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_A.host}/sitemap.xml`),
      publicDeps,
    );
    expect(sitemapNoindex.status).toBe(404);
    const robotsNoindex = await handleRobotsTxtRequest(
      new Request(`https://${TENANT_A.host}/robots.txt`),
      publicDeps,
    );
    expect(robotsNoindex.status).toBe(200);
    const robotsText = await robotsNoindex.text();
    expect(robotsText).toContain("Disallow: /");
    expect(robotsText).not.toContain("Sitemap:");

    // 4. Switch siteVisibility back to "public" (keeping blog & catalog disabled), publish, and prove sitemap excludes posts & offerings while keeping pages!
    const seoPublicPatch = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "seo",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/seo`, "PATCH", {
        cookie: ownerACookie,
        body: { siteVisibility: "public", expectedVersion: pubBody.version },
      }),
      rt,
    );
    expect(seoPublicPatch.status).toBe(200);
    const v8 = ((await seoPublicPatch.json()) as { version: number }).version;
    const pub2 = await handleTenantSettingsPublishRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/publish`, "POST", {
        cookie: ownerACookie,
        body: { expectedVersion: v8 },
      }),
      rt,
    );
    expect(pub2.status).toBe(200);
    const v9 = ((await pub2.json()) as { version: number }).version;

    const sitemapDisabledModules = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_A.host}/sitemap.xml`),
      publicDeps,
    );
    expect(sitemapDisabledModules.status).toBe(200);
    const xmlDisabledModules = await sitemapDisabledModules.text();
    expect(xmlDisabledModules).toContain("/sitemaps/pages.xml");
    expect(xmlDisabledModules).not.toContain("/sitemaps/posts.xml");
    expect(xmlDisabledModules).not.toContain("/sitemaps/offerings.xml");

    const postsSubSitemap = await handleSubSitemapRequest(
      new Request(`https://${TENANT_A.host}/sitemaps/posts.xml`),
      "posts",
      publicDeps,
    );
    expect(postsSubSitemap.status).toBe(404);
    const offeringsSubSitemap = await handleSubSitemapRequest(
      new Request(`https://${TENANT_A.host}/sitemaps/offerings.xml`),
      "offerings",
      publicDeps,
    );
    expect(offeringsSubSitemap.status).toBe(404);
    const rssFeed = await handleBlogFeedRequest(
      new Request(`https://${TENANT_A.host}/blog/feed.xml`),
      publicDeps,
    );
    expect(rssFeed.status).toBe(404);

    // 5. Re-enable blog & prove stored post is preserved AND its display date now uses Asia/Jayapura (16 Desember 2026) while stored UTC published_at remained identical!
    const reenableBlog = await handleTenantSettingsGroupRequest(
      TENANT_A.handle,
      "reading",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/reading`, "PATCH", {
        cookie: ownerACookie,
        body: { blogEnabled: true, expectedVersion: v9 },
      }),
      rt,
    );
    expect(reenableBlog.status).toBe(200);
    const v10 = ((await reenableBlog.json()) as { version: number }).version;
    const pub3 = await handleTenantSettingsPublishRequest(
      TENANT_A.handle,
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/settings/publish`, "POST", {
        cookie: ownerACookie,
        body: { expectedVersion: v10 },
      }),
      rt,
    );
    expect(pub3.status).toBe(200);

    const blogReenabled = await resolveBlogListingRoute(
      new Request(`https://${TENANT_A.host}/blog`),
      publicDeps,
    );
    expect(blogReenabled.kind).toBe("blog_listing");
    if (blogReenabled.kind === "blog_listing") {
      expect(blogReenabled.items).toHaveLength(1);
      // Same stored UTC instant (2026-12-15T16:30:00Z), now displayed in Asia/Jayapura (UTC+9 -> 16 Dec 2026)!
      expect(blogReenabled.items[0]?.publishedAtIso).toBe("2026-12-15T16:30:00.000Z");
      expect(blogReenabled.items[0]?.publishedDateLabel).toBe("16 Desember 2026");
    }

    // 6. Verify Tenant B was completely untouched throughout!
    const tenantBSettings = await tenantBDb
      .prepare("SELECT site_title, timezone, blog_enabled, catalog_enabled FROM site_settings WHERE id = 1")
      .first<{ site_title: string; timezone: string; blog_enabled: number; catalog_enabled: number }>();
    expect(tenantBSettings?.site_title).toBe(TENANT_B.name);
    expect(tenantBSettings?.timezone).toBe("Asia/Jakarta");
    expect(tenantBSettings?.blog_enabled).toBe(1);
    expect(tenantBSettings?.catalog_enabled).toBe(1);
  });

  it("preserves durable site_settings_grouped across TASK-008/TASK-095 writes, preserves analytics_config_json, clears homepage on modular switch (+ bumps pages.version), and guards compensation on interleaved writers", async () => {
    const rt = buildRuntimeEnv();

    // 1. PATCH /settings/analytics is rejected (405) — TASK-022 owns analytics writes; GET remains read-only
    const analyticsPatch = await handleTenantSettingsGroupRequest(
      TENANT_B.handle,
      "analytics",
      makeApiRequest(`${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/settings/analytics`, "PATCH", {
        cookie: ownerBCookie,
        body: { ga4MeasurementId: "G-SHOULDFAIL", expectedVersion: 2 },
      }),
      rt,
    );
    expect(analyticsPatch.status).toBe(405);
    expect(analyticsPatch.headers.get("Allow")).toBe("GET");

    // 2. Save grouped-only settings (reading: page #2, itemsPerPage 24; seo: defaultTitle + googleSiteVerification; privacy: privacyPageId 2)
    let state = await getGroupedSettingsForAdmin(tenantBDb);
    state = await saveGroupedSettingsDraft(tenantBDb, {
      group: "reading",
      patch: {
        homepageMode: "page",
        homepagePageId: 2,
        blogEnabled: true,
        catalogEnabled: true,
        enabledOfferingTypes: ["service", "tour"],
        itemsPerPage: 24,
        expectedVersion: state.version,
      },
      expectedVersion: state.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 10_000,
    });
    state = await saveGroupedSettingsDraft(tenantBDb, {
      group: "seo",
      patch: {
        defaultTitle: "Beta Durable SEO Title",
        defaultDescription: "Beta Durable SEO Description",
        googleSiteVerification: "betaVerifyToken123456",
        expectedVersion: state.version,
      },
      expectedVersion: state.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 11_000,
    });
    state = await saveGroupedSettingsDraft(tenantBDb, {
      group: "privacy",
      patch: {
        privacyPageId: 2,
        consentBannerText: "Teks privasi durable Beta.",
        consentPolicyVersion: 3,
        expectedVersion: state.version,
      },
      expectedVersion: state.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 12_000,
    });

    // 3. Simulate TASK-022 writing analytics_config_json (with extra metadata) AFTER grouped draft was saved!
    const customAnalyticsJson = JSON.stringify({
      ga4MeasurementId: "G-TASK022LIVE99",
      metaPixelId: "123456789012345",
      gtmContainerId: "GTM-LIVE999",
      _ownerAckMeta: { acknowledgedAt: "2026-11-23T00:00:00.000Z" },
    });
    await tenantBDb
      .prepare("UPDATE site_settings SET analytics_config_json = ? WHERE id = 1")
      .bind(customAnalyticsJson)
      .run();

    // Record page versions before publish
    const page1Before = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 1")
      .first<{ version: number; is_homepage: number }>();
    const page2Before = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 2")
      .first<{ version: number; is_homepage: number }>();
    expect(page1Before?.is_homepage).toBe(1);
    expect(page2Before?.is_homepage).toBe(0);

    // Publish grouped settings -> promotes page #2, demotes page #1, bumps both page versions, and preserves analytics_config_json byte-for-byte!
    const pub1 = await publishGroupedSettings(env.PLATFORM_DB, tenantBDb, {
      tenantId: TENANT_B.id,
      expectedVersion: state.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 15_000,
    });
    expect(pub1.published.reading.homepageMode).toBe("page");
    expect(pub1.published.reading.homepagePageId).toBe(2);

    const analyticsAfterPub1 = await tenantBDb
      .prepare("SELECT analytics_config_json FROM site_settings WHERE id = 1")
      .first<{ analytics_config_json: string | null }>();
    expect(analyticsAfterPub1?.analytics_config_json).toBe(customAnalyticsJson);

    const page1AfterStatic = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 1")
      .first<{ version: number; is_homepage: number }>();
    const page2AfterStatic = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 2")
      .first<{ version: number; is_homepage: number }>();
    expect(page1AfterStatic?.is_homepage).toBe(0);
    expect(page1AfterStatic?.version).toBe((page1Before?.version ?? 0) + 1);
    expect(page2AfterStatic?.is_homepage).toBe(1);
    expect(page2AfterStatic?.version).toBe((page2Before?.version ?? 0) + 1);

    // 4. Simulate TASK-008 (`saveSiteIdentityDraft` + `publishSiteIdentity`) AND TASK-095 (`seo/_data.ts`) overwriting `site_settings.draft_json`/`published_json`!
    await saveSiteIdentityDraft(tenantBDb, {
      siteSettings: { siteTitle: "Beta Updated By TASK-008" },
      expectedVersion: pub1.version,
      nowMs: BASE_NOW_MS + 20_000,
    });
    await publishSiteIdentity(env.PLATFORM_DB, tenantBDb, {
      tenantId: TENANT_B.id,
      nowMs: BASE_NOW_MS + 21_000,
    });
    // Also simulate TASK-095 directly rewriting site_settings.published_json without `_groupedSettings`
    const siteRowAfter008 = await tenantBDb
      .prepare("SELECT published_json, version FROM site_settings WHERE id = 1")
      .first<{ published_json: string; version: number }>();
    const strippedObj = JSON.parse(siteRowAfter008!.published_json) as Record<string, unknown>;
    delete strippedObj._groupedSettings;
    await tenantBDb
      .prepare("UPDATE site_settings SET published_json = ?, draft_json = ? WHERE id = 1")
      .bind(JSON.stringify(strippedObj), JSON.stringify(strippedObj))
      .run();

    // Durable `site_settings_grouped` MUST retain every single grouped setting intact!
    const pubAfterOtherWriters = await getPublishedGroupedSettings(tenantBDb);
    expect(pubAfterOtherWriters).not.toBeNull();
    expect(pubAfterOtherWriters!.settings.general.siteTitle).toBe("Beta Updated By TASK-008");
    expect(pubAfterOtherWriters!.settings.reading.homepageMode).toBe("page");
    expect(pubAfterOtherWriters!.settings.reading.homepagePageId).toBe(2);
    expect(pubAfterOtherWriters!.settings.reading.itemsPerPage).toBe(24);
    expect(pubAfterOtherWriters!.settings.reading.enabledOfferingTypes).toEqual(["service", "tour"]);
    expect(pubAfterOtherWriters!.settings.seo.defaultTitle).toBe("Beta Durable SEO Title");
    expect(pubAfterOtherWriters!.settings.seo.googleSiteVerification).toBe("betaVerifyToken123456");
    expect(pubAfterOtherWriters!.settings.privacy.privacyPageId).toBe(2);
    expect(pubAfterOtherWriters!.settings.privacy.consentPolicyVersion).toBe(3);

    // 5. Switch homepage back to `modular` & publish -> clears live `pages.is_homepage = 0`, bumps `pages.version`, and `loadPublishedTenantShellData` returns `page === null`!
    const currentAfter008 = await getGroupedSettingsForAdmin(tenantBDb);
    const modularDraft = await saveGroupedSettingsDraft(tenantBDb, {
      group: "reading",
      patch: {
        homepageMode: "modular",
        homepagePageId: null,
        expectedVersion: currentAfter008.version,
      },
      expectedVersion: currentAfter008.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 30_000,
    });
    const pubModular = await publishGroupedSettings(env.PLATFORM_DB, tenantBDb, {
      tenantId: TENANT_B.id,
      expectedVersion: modularDraft.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 31_000,
    });
    expect(pubModular.published.reading.homepageMode).toBe("modular");

    const page2AfterModular = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 2")
      .first<{ version: number; is_homepage: number }>();
    expect(page2AfterModular?.is_homepage).toBe(0);
    expect(page2AfterModular?.version).toBe((page2AfterStatic?.version ?? 0) + 1);

    const anyLiveHomepage = await tenantBDb
      .prepare("SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL")
      .first<{ id: number }>();
    expect(anyLiveHomepage).toBeNull();

    const modularShell = await loadPublishedTenantShellData(tenantBDb);
    expect(modularShell.page).toBeNull();

    // 6. Chained `changes() = 1` Compensation Tests:
    // 6a. Clean cross-tier failure (no interleaved writer) -> `compensated === true`, full rollback including page & audit log!
    const preFailDraft = await saveGroupedSettingsDraft(tenantBDb, {
      group: "reading",
      patch: {
        homepageMode: "page",
        homepagePageId: 2,
        expectedVersion: pubModular.version,
      },
      expectedVersion: pubModular.version,
      actorUserId: "owner-b",
      actorRole: "owner",
      nowMs: BASE_NOW_MS + 40_000,
    });
    const failingPlatformDb = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("Simulated PLATFORM_DB outage");
              },
              async run() {
                throw new Error("Simulated PLATFORM_DB outage");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const auditCountBeforeFail = await tenantBDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'settings.published'")
      .first<{ cnt: number }>();

    let cleanRollbackErr: unknown = null;
    try {
      await publishGroupedSettings(failingPlatformDb, tenantBDb, {
        tenantId: TENANT_B.id,
        expectedVersion: preFailDraft.version,
        actorUserId: "owner-b",
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 41_000,
      });
    } catch (err) {
      cleanRollbackErr = err;
    }
    expect(cleanRollbackErr).toBeInstanceOf(PublicationAtomicError);
    expect((cleanRollbackErr as PublicationAtomicError).compensated).toBe(true);

    // Page #2 must be cleanly rolled back to is_homepage = 0 and original version, and audit log row removed!
    const page2AfterCleanRollback = await tenantBDb
      .prepare("SELECT version, is_homepage FROM pages WHERE id = 2")
      .first<{ version: number; is_homepage: number }>();
    expect(page2AfterCleanRollback?.is_homepage).toBe(0);
    expect(page2AfterCleanRollback?.version).toBe(page2AfterModular?.version);

    const auditCountAfterCleanRollback = await tenantBDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'settings.published'")
      .first<{ cnt: number }>();
    expect(auditCountAfterCleanRollback?.cnt).toBe(auditCountBeforeFail?.cnt);

    // 6b. Interleaved writer BEFORE compensation runs -> `compensated === false` AND ZERO half-reverted rows!
    let interleavedErr: unknown = null;
    try {
      await publishGroupedSettings(failingPlatformDb, tenantBDb, {
        tenantId: TENANT_B.id,
        expectedVersion: preFailDraft.version,
        actorUserId: "owner-b",
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 50_000,
        beforeCacheVersionBump: async () => {
          // Concurrent editor modifies page #2 after TenantStore commit and before compensation runs
          await tenantBDb
            .prepare("UPDATE pages SET title = 'Concurrent Edit', version = version + 1, updated_at = ? WHERE id = 2")
            .bind(BASE_NOW_MS + 50_500)
            .run();
        },
      });
    } catch (err) {
      interleavedErr = err;
    }
    expect(interleavedErr).toBeInstanceOf(PublicationAtomicError);
    expect((interleavedErr as PublicationAtomicError).compensated).toBe(false);

    // Assert ZERO half-reverted rows: site_settings, business_profile, site_settings_grouped, and page #2 stay consistent!
    const siteAfterInterleave = await tenantBDb
      .prepare("SELECT version FROM site_settings WHERE id = 1")
      .first<{ version: number }>();
    const bpAfterInterleave = await tenantBDb
      .prepare("SELECT version FROM business_profile WHERE id = 1")
      .first<{ version: number }>();
    const grAfterInterleave = await tenantBDb
      .prepare("SELECT version FROM site_settings_grouped WHERE id = 1")
      .first<{ version: number }>();
    const page2AfterInterleave = await tenantBDb
      .prepare("SELECT title, is_homepage, version FROM pages WHERE id = 2")
      .first<{ title: string; is_homepage: number; version: number }>();

    expect(siteAfterInterleave?.version).toBe(preFailDraft.version + 1);
    expect(bpAfterInterleave?.version).toBe(preFailDraft.version + 1);
    expect(grAfterInterleave?.version).toBe(preFailDraft.version + 1);
    expect(page2AfterInterleave?.title).toBe("Concurrent Edit");
    expect(page2AfterInterleave?.is_homepage).toBe(1);
    expect(page2AfterInterleave?.version).toBe((page2AfterModular?.version ?? 0) + 2);

    // 7. V -> V+1 Interleaving Race on `saveGroupedSettingsDraft`:
    // If another writer bumps `site_settings.version` from V to V+1 between pre-read and batch(),
    // chained `changes() = 1` MUST reject with 409 StaleRevisionError and write ZERO rows to
    // `business_profile`, `site_settings_grouped`, or `tenant_activity_log`!
    const beforeRaceState = await getGroupedSettingsForAdmin(tenantBDb);
    const bpBeforeRace = await tenantBDb
      .prepare("SELECT version, draft_json FROM business_profile WHERE id = 1")
      .first<{ version: number; draft_json: string | null }>();
    const grBeforeRace = await tenantBDb
      .prepare("SELECT version, draft_json FROM site_settings_grouped WHERE id = 1")
      .first<{ version: number; draft_json: string | null }>();
    const auditBeforeRace = await tenantBDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'settings.draft_saved'")
      .first<{ cnt: number }>();

    let draftRaceErr: unknown = null;
    try {
      await saveGroupedSettingsDraft(tenantBDb, {
        group: "business",
        patch: {
          businessName: "Should Never Half-Write",
          expectedVersion: beforeRaceState.version,
        },
        expectedVersion: beforeRaceState.version,
        actorUserId: "owner-b",
        actorRole: "owner",
        nowMs: BASE_NOW_MS + 60_000,
        beforeDraftBatch: async () => {
          // Concurrent writer (e.g. TASK-008/TASK-095) bumps ONLY `site_settings.version` from V -> V+1!
          await tenantBDb
            .prepare("UPDATE site_settings SET version = version + 1, updated_at = ? WHERE id = 1")
            .bind(BASE_NOW_MS + 59_500)
            .run();
        },
      });
    } catch (err) {
      draftRaceErr = err;
    }

    expect(draftRaceErr).toBeInstanceOf(StaleRevisionError);
    expect((draftRaceErr as StaleRevisionError).httpStatus).toBe(409);

    const bpAfterRace = await tenantBDb
      .prepare("SELECT version, draft_json FROM business_profile WHERE id = 1")
      .first<{ version: number; draft_json: string | null }>();
    const grAfterRace = await tenantBDb
      .prepare("SELECT version, draft_json FROM site_settings_grouped WHERE id = 1")
      .first<{ version: number; draft_json: string | null }>();
    const auditAfterRace = await tenantBDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_activity_log WHERE action = 'settings.draft_saved'")
      .first<{ cnt: number }>();

    expect(bpAfterRace?.version).toBe(bpBeforeRace?.version);
    expect(bpAfterRace?.draft_json).toBe(bpBeforeRace?.draft_json);
    expect(grAfterRace?.version).toBe(grBeforeRace?.version);
    expect(grAfterRace?.draft_json).toBe(grBeforeRace?.draft_json);
    expect(auditAfterRace?.cnt).toBe(auditBeforeRace?.cnt);
  });
});
