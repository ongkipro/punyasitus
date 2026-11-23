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
  applyTenantSeoEditorMigration,
  isSeoAutopilotEnabledForTenant,
} from "@punyasitus/db/seo/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleTenantSeoPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/publish.ts";
import { handleTenantResourceSeoRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/resources/[kind]/[resourceId].ts";
import { handleTenantSeoSettingsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/settings.ts";
import { handleTenantSeoToggleRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/toggle.ts";
import { handleTenantSeoVerificationCheckRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/verification-check.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);

const TENANT_A = {
  id: "01JT052TENANTALPHA00000001",
  orgId: "org_t052_alpha",
  handle: "t052-alpha",
  name: "T052 Alpha Studio",
  ownerId: "user_t052_owner_a",
  editorId: "user_t052_editor_a",
  primaryDomain: "www.t052-alpha.id",
  newPrimaryDomain: "www.t052-alpha-baru.id",
};

const TENANT_B = {
  id: "01JT052TENANTBETA000000002",
  orgId: "org_t052_beta",
  handle: "t052-beta",
  name: "T052 Beta Clinic",
  ownerId: "user_t052_owner_b",
  primaryDomain: "t052-beta.situsku.click",
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

function makeAppRequest(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly host?: string;
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
  const base = init.host ? `https://${init.host}` : APP_ORIGIN;
  return new Request(`${base}${path}`, {
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
  readonly operatorHold?: number;
  readonly primaryHost: string;
  readonly primaryKind: "custom" | "subdomain";
}) {
  const db = env.PLATFORM_DB;
  const paidThrough = NOW_MS + 30 * 86_400_000;

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
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, ?, ?, 1, 0, 1, ?, ?)`,
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
  await db
    .prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'active', 1, 1, ?, ?)`,
    )
    .bind(spec.primaryHost, spec.id, spec.primaryKind, NOW_MS, NOW_MS)
    .run();

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  await orchestrateTenantMigration(db, stub, spec.id, TENANT_MIGRATIONS);
  const tenantDb = createTenantDb(stub);
  await applyTenantSeoEditorMigration(tenantDb);

  await tenantDb
    .prepare(
      `INSERT OR REPLACE INTO site_settings (
         id, site_title, tagline, timezone, locale, active_theme_id,
         blog_enabled, catalog_enabled, ai_training_policy,
         draft_json, published_json, published_at, content_modified_at, version, updated_at
       ) VALUES (1, ?, 'Solusi Profesional', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      spec.name,
      JSON.stringify({
        snapshotVersion: 1,
        resourceType: "site_settings",
        publishedAt: NOW_MS,
        contentModifiedAt: NOW_MS,
        data: {
          siteTitle: spec.name,
          tagline: "Solusi Profesional",
          siteVisibility: "public",
          aiTrainingPolicy: "allow",
        },
      }),
      JSON.stringify({
        snapshotVersion: 1,
        resourceType: "site_settings",
        publishedAt: NOW_MS,
        contentModifiedAt: NOW_MS,
        data: {
          siteTitle: spec.name,
          tagline: "Solusi Profesional",
          siteVisibility: "public",
          aiTrainingPolicy: "allow",
        },
      }),
      NOW_MS,
      NOW_MS,
      NOW_MS,
    )
    .run();

  return tenantDb;
}

describe("TASK-052 workerd integration: SEO editor controls, templates, verification & isolation", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  beforeEach(async () => {
    tenantDbA = await seedTenant({
      id: TENANT_A.id,
      orgId: TENANT_A.orgId,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      ownerId: TENANT_A.ownerId,
      editorId: TENANT_A.editorId,
      primaryHost: TENANT_A.primaryDomain,
      primaryKind: "custom",
    });
    tenantDbB = await seedTenant({
      id: TENANT_B.id,
      orgId: TENANT_B.orgId,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      ownerId: TENANT_B.ownerId,
      primaryHost: TENANT_B.primaryDomain,
      primaryKind: "subdomain",
    });

    // Clean per-tenant test tables between tests
    await tenantDbA.batch([
      tenantDbA.prepare("DELETE FROM plg_seo_ai_autopilot__settings"),
      tenantDbA.prepare("DELETE FROM installed_plugins"),
      tenantDbA.prepare("DELETE FROM tenant_activity_log"),
      tenantDbA.prepare("DELETE FROM post_taxonomies"),
      tenantDbA.prepare("DELETE FROM offering_taxonomies"),
      tenantDbA.prepare("DELETE FROM pages"),
      tenantDbA.prepare("DELETE FROM posts"),
      tenantDbA.prepare("DELETE FROM offerings"),
      tenantDbA.prepare("DELETE FROM taxonomies"),
      tenantDbA.prepare("DELETE FROM media_items"),
    ]);
    await tenantDbA.prepare("DROP TABLE IF EXISTS site_settings_grouped").run();
    await tenantDbB.batch([
      tenantDbB.prepare("DELETE FROM plg_seo_ai_autopilot__settings"),
      tenantDbB.prepare("DELETE FROM media_items"),
    ]);
  });

  it("enforces search appearance template validation, draft isolation, publish cache bump, and OCC 409", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Read default settings
    const getRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("cache-control")).toBe("private, no-store");
    const initial = (await getRes.json()) as { settings: { version: number; draft: { searchAppearance: { separator: string } } } };
    expect(initial.settings.version).toBe(1);

    // 2. Reject unknown template token -> 422
    const badTplRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: {
          separator: "·",
          templates: {
            page: {
              titleTemplate: "{{title}} {{sep}} {{secret_env}}",
              descriptionTemplate: "{{excerpt}}",
            },
          },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(badTplRes.status).toBe(422);

    // 3. Save valid draft template + Google/Bing tokens -> published remains unchanged (draft privacy!)
    const saveRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: {
          separator: "·",
          templates: {
            post: {
              titleTemplate: "{{title}} {{sep}} {{category}} {{sep}} {{site_name}}",
              descriptionTemplate: "{{excerpt}}",
            },
          },
          verification: {
            google: "gscValidToken_Alpha_2026",
            bing: "0123456789ABCDEF2026",
          },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as {
      settings: {
        version: number;
        hasUnpublishedChanges: boolean;
        draft: { verificationTokens: { google: string | null } };
        published: { verificationTokens: { google: string | null } } | null;
        verificationStatuses: Array<{ provider: string; status: string }>;
      };
    };
    expect(saved.settings.version).toBe(2);
    expect(saved.settings.hasUnpublishedChanges).toBe(true);
    expect(saved.settings.draft.verificationTokens.google).toBe("gscValidToken_Alpha_2026");
    expect(saved.settings.published?.verificationTokens.google).toBeNull();
    // Configured locally ONLY — never verified!
    expect(
      saved.settings.verificationStatuses.find((v) => v.provider === "google")?.status,
    ).toBe("configured");

    // 4. Stale version write -> 409 VERSION_CONFLICT
    const staleRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { separator: "-", version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(staleRes.status).toBe(409);

    // 5. Publish bumps PLATFORM_DB.tenants.cache_version and activates verification meta tags
    const beforeCache = await env.PLATFORM_DB.prepare(
      "SELECT cache_version FROM tenants WHERE id = ?",
    )
      .bind(TENANT_A.id)
      .first<{ cache_version: number }>();

    const pubRes = await handleTenantSeoPublishRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/publish`, {
        method: "POST",
        body: { version: 2 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(pubRes.status).toBe(200);
    const pubJson = (await pubRes.json()) as {
      settings: {
        version: number;
        hasUnpublishedChanges: boolean;
        publishedVerificationMetaTags: string[];
        verificationStatuses: Array<{ provider: string; status: string }>;
      };
    };
    expect(pubJson.settings.version).toBe(3);
    expect(pubJson.settings.hasUnpublishedChanges).toBe(false);
    expect(pubJson.settings.publishedVerificationMetaTags).toContain(
      '<meta name="google-site-verification" content="gscValidToken_Alpha_2026" />',
    );
    // Still "configured", NOT "externally_verified" until human records manual check!
    expect(
      pubJson.settings.verificationStatuses.find((v) => v.provider === "google")?.status,
    ).toBe("configured");

    const afterCache = await env.PLATFORM_DB.prepare(
      "SELECT cache_version FROM tenants WHERE id = ?",
    )
      .bind(TENANT_A.id)
      .first<{ cache_version: number }>();
    expect(Number(afterCache?.cache_version)).toBeGreaterThan(Number(beforeCache?.cache_version));
  });

  it("rejects malicious verification tokens, records external verification, and invalidates on primary-domain change", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Inject raw HTML <meta> tag -> 422
    const injectRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: {
          verification: {
            google: '<meta name="google-site-verification" content="abc123456789" />',
          },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(injectRes.status).toBe(422);

    // Save + publish valid Google token
    const saveRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { verification: { google: "googleVerifiedToken_9988" }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(saveRes.status).toBe(200);

    const pubRes = await handleTenantSeoPublishRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/publish`, {
        method: "POST",
        body: { version: 2 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(pubRes.status).toBe(200);

    // Forged hostname in verification-check -> 422 HOST_MISMATCH
    const forgedHostRes = await handleTenantSeoVerificationCheckRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/verification-check`, {
        method: "POST",
        body: {
          provider: "google",
          verifiedHost: "evil.example.com",
          version: 3,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(forgedHostRes.status).toBe(422);

    // Valid external verification recorded on current primary host -> externally_verified
    const okCheckRes = await handleTenantSeoVerificationCheckRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/verification-check`, {
        method: "POST",
        body: {
          provider: "google",
          verifiedHost: TENANT_A.primaryDomain,
          note: "Verified manually in GSC",
          version: 3,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(okCheckRes.status).toBe(200);
    const verifiedJson = (await okCheckRes.json()) as {
      settings: {
        verificationStatuses: Array<{
          provider: string;
          status: string;
          domainChangedSinceVerification: boolean;
        }>;
      };
    };
    expect(
      verifiedJson.settings.verificationStatuses.find((v) => v.provider === "google")?.status,
    ).toBe("externally_verified");

    // Simulate primary domain switch in PLATFORM_DB.tenant_hosts -> status MUST degrade to recheck_required!
    await env.PLATFORM_DB.prepare(`DELETE FROM tenant_hosts WHERE tenant_id = ?`)
      .bind(TENANT_A.id)
      .run();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'custom', 'active', 'active', 1, 2, ?, ?)`,
    )
      .bind(TENANT_A.newPrimaryDomain, TENANT_A.id, NOW_MS, NOW_MS)
      .run();

    const afterSwitchRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(afterSwitchRes.status).toBe(200);
    const switchedJson = (await afterSwitchRes.json()) as {
      settings: {
        primaryHost: string;
        verificationStatuses: Array<{
          provider: string;
          status: string;
          domainChangedSinceVerification: boolean;
        }>;
      };
    };
    expect(switchedJson.settings.primaryHost).toBe(TENANT_A.newPrimaryDomain);
    const googleAfter = switchedJson.settings.verificationStatuses.find(
      (v) => v.provider === "google",
    );
    expect(googleAfter?.status).toBe("recheck_required");
    expect(googleAfter?.domainChangedSinceVerification).toBe(true);
  });

  it("enforces RBAC (editor denied global settings 403, allowed per-resource SEO), cross-tenant 404, and locked/suspended gates", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Editor cannot modify global SEO settings -> 403 FORBIDDEN
    const editorPatchRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { separator: "-", version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(editorPatchRes.status).toBe(403);

    // Editor cannot toggle seo-ai-autopilot -> 403 FORBIDDEN
    const editorToggleRes = await handleTenantSeoToggleRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/toggle`, {
        method: "POST",
        body: { enabled: false },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(editorToggleRes.status).toBe(403);

    // Cross-tenant Owner B cannot read Tenant A -> neutral 404
    const crossTenantRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_B.ownerId }, nowMs: NOW_MS },
    );
    expect(crossTenantRes.status).toBe(404);

    // Tenant host cannot call app API -> neutral 404
    const wrongSurfaceRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        host: TENANT_A.primaryDomain,
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(wrongSurfaceRes.status).toBe(404);

    // Locked tenant: GET allowed, PATCH -> 403 SUBSCRIPTION_LOCKED
    await env.PLATFORM_DB.prepare(
      `UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?`,
    )
      .bind(NOW_MS - 5 * 86_400_000, TENANT_A.id)
      .run();

    const lockedGetRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(lockedGetRes.status).toBe(200);

    const lockedPatchRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { separator: "-", version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(lockedPatchRes.status).toBe(403);
  });

  it("enforces per-resource draft isolation, schema guards, media ownership, taxonomy opt-in, and keyphrase cannibalization warnings", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Seed owned ready image in Tenant A (id=10) and another image in Tenant B (id=99)
    await tenantDbA
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, status, version, created_at, updated_at)
         VALUES (10, 'image', 't/a/og.webp', 'image/webp', 12000, 'sha_a', 'ready', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS)
      .run();

    await tenantDbB
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, status, version, created_at, updated_at)
         VALUES (99, 'image', 't/b/og.webp', 'image/webp', 12000, 'sha_b', 'ready', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS)
      .run();

    // Seed a published page (id=1) with live published SEO and no FAQ block
    const publishedPageEnvelope = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "page",
      data: {
        slug: "profil-kami",
        title: "Profil Perusahaan",
        isHomepage: false,
        sections: [{ id: "sec_1", kind: "about", heading: "Tentang Alpha", bodyHtml: "<p>Profil singkat perusahaan.</p>" }],
        seo: { titleOverride: "Judul Terbit Live", focusKeyphrase: "arsitek jakarta" },
      },
    });
    await tenantDbA
      .prepare(
        `INSERT INTO pages (
           id, slug, title, is_homepage, draft_sections_json, published_sections_json,
           seo_json, status, published_at, version, created_at, updated_at
         ) VALUES (1, 'profil-kami', 'Profil Perusahaan', 0, ?, ?, ?, 'published', ?, 1, ?, ?)`,
      )
      .bind(
        publishedPageEnvelope,
        publishedPageEnvelope,
        JSON.stringify({ titleOverride: "Judul Terbit Live", focusKeyphrase: "arsitek jakarta" }),
        NOW_MS,
        NOW_MS,
        NOW_MS,
      )
      .run();

    // Seed a second draft page (id=2) to test keyphrase cannibalization against published page #1
    const draftPageEnvelope = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "page",
      data: {
        slug: "layanan-arsitek",
        title: "Layanan Arsitek",
        isHomepage: false,
        sections: [{ id: "sec_2", kind: "hero", heading: "Arsitek Jakarta" }],
        seo: {},
      },
    });
    await tenantDbA
      .prepare(
        `INSERT INTO pages (
           id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at
         ) VALUES (2, 'layanan-arsitek', 'Layanan Arsitek', 0, ?, 'draft', 1, ?, ?)`,
      )
      .bind(draftPageEnvelope, NOW_MS, NOW_MS)
      .run();

    // 1. FAQPage rejected on page #1 because it has NO visible FAQ section -> 422
    const badFaqRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "1",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/1`, {
        method: "PATCH",
        body: {
          seo: { schemaType: "FAQPage" },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(badFaqRes.status).toBe(422);

    // 2. Foreign Tenant B media ID (99) rejected on Tenant A -> 422
    const foreignMediaRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "1",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/1`, {
        method: "PATCH",
        body: {
          seo: { ogImageMediaId: 99 },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(foreignMediaRes.status).toBe(422);

    // 3. Editor updates published page #1 draft SEO with owned media #10 -> draft updates, published snapshot STAYS UNTOUCHED!
    const draftEditRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "1",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/1`, {
        method: "PATCH",
        body: {
          seo: {
            titleOverride: "Draf Judul Rahasia Baru",
            ogImageMediaId: 10,
            schemaType: "AboutPage",
            noindex: true,
            nofollow: true,
          },
          version: 1,
        },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(draftEditRes.status).toBe(200);
    const editJson = (await draftEditRes.json()) as {
      seo: {
        version: number;
        draftSeo: { titleOverride?: string; noindex?: boolean; nofollow?: boolean };
        publishedSeo: { titleOverride?: string } | null;
      };
    };
    expect(editJson.seo.version).toBe(2);
    expect(editJson.seo.draftSeo.titleOverride).toBe("Draf Judul Rahasia Baru");
    expect(editJson.seo.draftSeo.noindex).toBe(true);
    expect(editJson.seo.draftSeo.nofollow).toBe(true);
    // Draft privacy proof: publishedSeo still has the live title, NOT the draft title!
    expect(editJson.seo.publishedSeo?.titleOverride).toBe("Judul Terbit Live");

    // 4. Stale version on page #1 -> 409 VERSION_CONFLICT
    const stalePageRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "1",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/1`, {
        method: "PATCH",
        body: { seo: { titleOverride: "Stale" }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(stalePageRes.status).toBe(409);

    // 5. Keyphrase cannibalization warning on page #2 when matching published page #1's focusKeyphrase
    const cannibalRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "2",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/2`, {
        method: "PATCH",
        body: { seo: { focusKeyphrase: "arsitek jakarta" }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(cannibalRes.status).toBe(200);
    const cannibalJson = (await cannibalRes.json()) as {
      seo: {
        checklist: {
          blocking: boolean;
          items: Array<{ id: string; status: string; detail: string }>;
        };
      };
    };
    expect(cannibalJson.seo.checklist.blocking).toBe(false);
    const cannibalItem = cannibalJson.seo.checklist.items.find(
      (i) => i.id === "keyphrase_cannibalization",
    );
    expect(cannibalItem?.status).toBe("advisory");
    expect(cannibalItem?.detail).toContain("Profil Perusahaan");

    // 6. Empty taxonomy opt-in remains effectively noindex (`empty_taxonomy_noindex`)
    await tenantDbA
      .prepare(
        `INSERT INTO taxonomies (id, taxonomy_type, depth, slug, name, description, version, created_at, updated_at)
         VALUES (5, 'post_category', 0, 'tips-kosong', 'Tips Kosong', 'Kategori belum ada artikel', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS)
      .run();

    const taxOptInRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "taxonomy",
      "5",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/taxonomy/5`, {
        method: "PATCH",
        body: { indexOptIn: true, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(taxOptInRes.status).toBe(200);
    const taxJson = (await taxOptInRes.json()) as {
      seo: {
        indexOptIn: boolean;
        publishedCount: number;
        preview: { effectiveIndexable: boolean; decision: { reason: string } };
      };
    };
    expect(taxJson.seo.indexOptIn).toBe(true);
    expect(taxJson.seo.publishedCount).toBe(0);
    expect(taxJson.seo.preview.effectiveIndexable).toBe(false);
    expect(taxJson.seo.preview.decision.reason).toBe("empty_taxonomy_noindex");

    // 7. Toggle seo-ai-autopilot off -> SEO mutations return 409 PLUGIN_DISABLED; toggle back on restores access!
    const offRes = await handleTenantSeoToggleRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/toggle`, {
        method: "POST",
        body: { enabled: false },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(offRes.status).toBe(200);
    expect(await isSeoAutopilotEnabledForTenant(tenantDbA)).toBe(false);

    const disabledSettingsPatch = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { separator: "-", version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(disabledSettingsPatch.status).toBe(409);
    const disabledBody = (await disabledSettingsPatch.json()) as { error: { code: string } };
    expect(disabledBody.error.code).toBe("PLUGIN_DISABLED");

    const disabledResourcePatch = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "page",
      "1",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/page/1`, {
        method: "PATCH",
        body: { seo: { titleOverride: "Blocked" }, version: 2 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(disabledResourcePatch.status).toBe(409);

    const onRes = await handleTenantSeoToggleRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/toggle`, {
        method: "POST",
        body: { enabled: true },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(onRes.status).toBe(200);
    expect(await isSeoAutopilotEnabledForTenant(tenantDbA)).toBe(true);

    // 8. Verify atomic tenant_activity_log recorded actions
    const logCount = await tenantDbA
      .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log`)
      .first<{ cnt: number }>();
    expect(Number(logCount?.cnt ?? 0)).toBeGreaterThanOrEqual(4);
  });

  it("never leaks site_settings_grouped draft_json on seed or publish, rejects soft-deleted OG media, and wraps raw post draft_body_json", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Seed site_settings_grouped with UNPUBLISHED draft token & NULL published_json
    await tenantDbA
      .prepare(
        `CREATE TABLE IF NOT EXISTS site_settings_grouped (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           draft_json TEXT NOT NULL,
           published_json TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL,
           published_at INTEGER
         )`,
      )
      .run();

    const secretDraftGrouped = JSON.stringify({
      general: { siteTitle: "Secret Draft Title" },
      seo: { googleSiteVerification: "draftOnlyToken_999999" },
    });
    await tenantDbA
      .prepare(
        `INSERT INTO site_settings_grouped (id, draft_json, published_json, version, updated_at, published_at)
         VALUES (1, ?, NULL, 1, ?, NULL)`,
      )
      .bind(secretDraftGrouped, NOW_MS)
      .run();

    // Reading settings must NOT expose draftOnlyToken_999999 as published!
    const getRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      settings: {
        draft: { verificationTokens: { google: string | null } };
        published: { verificationTokens: { google: string | null } } | null;
        publishedVerificationMetaTags: string[];
      };
    };
    expect(getJson.settings.draft.verificationTokens.google).toBe("draftOnlyToken_999999");
    expect(getJson.settings.published?.verificationTokens.google).toBeNull();
    expect(getJson.settings.publishedVerificationMetaTags).toEqual([]);

    // Publishing SEO settings when site_settings_grouped.published_json IS NULL must NOT promote grouped draft_json!
    const saveRes = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { verification: { google: "publishedGoogleToken_123" }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(saveRes.status).toBe(200);

    const pubRes = await handleTenantSeoPublishRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/publish`, {
        method: "POST",
        body: { version: 2 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(pubRes.status).toBe(200);

    const groupedAfterNullPub = await tenantDbA
      .prepare(`SELECT draft_json, published_json, version FROM site_settings_grouped WHERE id = 1`)
      .first<{ draft_json: string; published_json: string | null; version: number }>();
    expect(groupedAfterNullPub?.published_json).toBeNull();
    expect(groupedAfterNullPub?.draft_json).toBe(secretDraftGrouped);
    expect(Number(groupedAfterNullPub?.version)).toBe(1);

    // Now publish site_settings_grouped (non-null published_json) -> next SEO publish updates ONLY published_json tokens & bumps grouped version, leaving draft_json untouched!
    await tenantDbA
      .prepare(
        `UPDATE site_settings_grouped SET published_json = ?, version = 2, published_at = ? WHERE id = 1`,
      )
      .bind(JSON.stringify({ general: { siteTitle: "Live Site" }, seo: {} }), NOW_MS)
      .run();

    const saveRes2 = await handleTenantSeoSettingsRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/settings`, {
        method: "PATCH",
        body: { verification: { bing: "0123456789ABCDEF9999" }, version: 3 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(saveRes2.status).toBe(200);

    const pubRes2 = await handleTenantSeoPublishRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/publish`, {
        method: "POST",
        body: { version: 4 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.ownerId }, nowMs: NOW_MS },
    );
    expect(pubRes2.status).toBe(200);

    const groupedAfterLivePub = await tenantDbA
      .prepare(`SELECT draft_json, published_json, version FROM site_settings_grouped WHERE id = 1`)
      .first<{ draft_json: string; published_json: string | null; version: number }>();
    expect(groupedAfterLivePub?.draft_json).toBe(secretDraftGrouped);
    expect(Number(groupedAfterLivePub?.version)).toBe(3);
    const parsedGroupedPub = JSON.parse(groupedAfterLivePub?.published_json ?? "{}") as {
      general?: { siteTitle?: string };
      seo?: { googleSiteVerification?: string; bingSiteVerification?: string };
    };
    expect(parsedGroupedPub.general?.siteTitle).toBe("Live Site");
    expect(parsedGroupedPub.seo?.googleSiteVerification).toBe("publishedGoogleToken_123");
    expect(parsedGroupedPub.seo?.bingSiteVerification).toBe("0123456789ABCDEF9999");

    // 2. Soft-deleted media_items row (deleted_at IS NOT NULL) is rejected as ogImageMediaId!
    try {
      await tenantDbA.prepare(`ALTER TABLE media_items ADD COLUMN deleted_at INTEGER`).run();
    } catch {
      // column may already exist
    }
    await tenantDbA
      .prepare(
        `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, status, deleted_at, version, created_at, updated_at)
         VALUES (77, 'image', 't/a/trashed.webp', 'image/webp', 5000, 'sha_tr', 'ready', ?, 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS, NOW_MS)
      .run();

    // 3. Raw seeded post `draft_body_json` (RestrictedRichTextDoc without envelope) wraps cleanly
    const rawRichDoc = JSON.stringify({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Paragraf artikel mentah." }],
    });
    await tenantDbA
      .prepare(
        `INSERT INTO posts (id, slug, title, excerpt, draft_body_json, status, version, created_at, updated_at)
         VALUES (15, 'artikel-mentah', 'Artikel Mentah', 'Ringkasan', ?, 'draft', 1, ?, ?)`,
      )
      .bind(rawRichDoc, NOW_MS, NOW_MS)
      .run();

    const trashedMediaRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "post",
      "15",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/post/15`, {
        method: "PATCH",
        body: { seo: { ogImageMediaId: 77 }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(trashedMediaRes.status).toBe(422);

    const wrapRawPostRes = await handleTenantResourceSeoRequest(
      TENANT_A.handle,
      "post",
      "15",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/seo/resources/post/15`, {
        method: "PATCH",
        body: { seo: { titleOverride: "Judul Artikel Rapi", schemaType: "Article" }, version: 1 },
      }),
      runtimeEnv,
      { authenticatedUser: { id: TENANT_A.editorId }, nowMs: NOW_MS },
    );
    expect(wrapRawPostRes.status).toBe(200);

    const storedPost = await tenantDbA
      .prepare(`SELECT draft_body_json FROM posts WHERE id = 15`)
      .first<{ draft_body_json: string }>();
    const wrapped = JSON.parse(storedPost?.draft_body_json ?? "{}") as {
      snapshotVersion?: number;
      resourceType?: string;
      data?: { body?: { blocks?: unknown[] }; seo?: { titleOverride?: string } };
    };
    expect(wrapped.snapshotVersion).toBe(1);
    expect(wrapped.resourceType).toBe("post");
    expect(Array.isArray(wrapped.data?.body?.blocks)).toBe(true);
    expect(wrapped.data?.seo?.titleOverride).toBe("Judul Artikel Rapi");
  });
});
