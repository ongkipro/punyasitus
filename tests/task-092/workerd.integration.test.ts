import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
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
  createBlogTaxonomy,
  createPost,
  createPostAuthor,
  publishPost,
  TENANT_MIGRATIONS_WITH_BLOG_AUTHOR_TOC_MODIFIED,
} from "@punyasitus/db/posts/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enrichPublicBlogDetailResult } from "../../apps/web/src/components/seo/public-seo-context.ts";
import {
  resolveBlogDetailRoute,
  type PublicRouteDeps,
} from "../../apps/web/src/core/public-routes.ts";
import { handleTenantPostItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId].ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import { handleTenantPostAuthorItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/authors/[authorId].ts";
import { handleTenantPostAuthorsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/authors/index.ts";
import { handleTenantPostsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/index.ts";
import { resolveBlogDetailPresentation } from "../../apps/web/src/pages/blog/_post-detail-helpers.ts";
import { handleSubSitemapRequest } from "../../apps/web/src/pages/sitemaps/_shared.ts";

const BASE_TIME = 1_865_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const APP_ORIGIN = "https://app.punyasitus.com";

const TENANT_ALPHA = {
  id: "01JT092ALPHA00000000000001",
  orgId: "org_t092_alpha",
  handle: "t092-alpha",
  name: "PT Nusantara Arsitek",
  subdomain: "t092-alpha.situsku.click",
  customDomain: "www.t092-alpha.id",
} as const;

const TENANT_BETA = {
  id: "01JT092BETA000000000000002",
  orgId: "org_t092_beta",
  handle: "t092-beta",
  name: "Beta Klinik Gigi",
  subdomain: "t092-beta.situsku.click",
} as const;

const USER_ALPHA_OWNER = "usr_t092_alpha_owner";
const USER_ALPHA_EDITOR = "usr_t092_alpha_editor";
const USER_BETA_OWNER = "usr_t092_beta_owner";

function buildApiEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: "task092-test-secret-0123456789abcdef",
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    MEDIA_PUBLIC_BASE_URL: "https://cdn.punyasitus.com",
  };
}

function buildPublicDeps(nowMs = BASE_TIME): PublicRouteDeps {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    mediaPublicBaseUrl: "https://cdn.punyasitus.com",
    nowMs,
    bypassHostCache: true,
  };
}

function makeAdminRequest(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly secFetchSite?: string | null;
    readonly hostOrigin?: string;
  } = {},
): Request {
  const hostOrigin = init.hostOrigin ?? APP_ORIGIN;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers();
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    if (init.origin !== null) {
      headers.set("Origin", init.origin ?? hostOrigin);
    }
    if (init.secFetchSite !== null) {
      headers.set("Sec-Fetch-Site", init.secFetchSite ?? "same-origin");
    }
  }
  return new Request(`${hostOrigin}${path}`, {
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
  readonly subdomain: string;
  readonly customDomain?: string;
}): Promise<D1Database> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({
      id: spec.orgId,
      name: spec.name,
      slug: spec.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: "active",
      paidThrough: new Date(BASE_TIME + 30 * DAY_MS),
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const hostRows = spec.customDomain
    ? [
        {
          tenantId: spec.id,
          host: spec.subdomain,
          kind: "subdomain" as const,
          isPrimary: false,
          status: "active" as const,
          sslStatus: "active" as const,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: spec.id,
          host: spec.customDomain,
          kind: "custom" as const,
          isPrimary: true,
          status: "active" as const,
          sslStatus: "active" as const,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [
        {
          tenantId: spec.id,
          host: spec.subdomain,
          kind: "subdomain" as const,
          isPrimary: true,
          status: "active" as const,
          sslStatus: "active" as const,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

  for (const h of hostRows) {
    await pDb.insert(tenantHosts).values(h).onConflictDoNothing();
  }

  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    spec.id,
  );
  await orchestrateTenantMigration(
    env.PLATFORM_DB,
    stub,
    spec.id,
    TENANT_MIGRATIONS_WITH_BLOG_AUTHOR_TOC_MODIFIED,
  );

  const tDb = createTenantDb(stub);

  // Seed published site_settings & business_profile
  await tDb
    .prepare(
      `INSERT OR REPLACE INTO site_settings (
         id, site_title, tagline, timezone, locale, active_theme_id,
         blog_enabled, catalog_enabled, published_json, published_at,
         content_modified_at, version, updated_at
       ) VALUES (1, ?, 'Solusi Profesional Indonesia', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, ?, ?, ?, 1, ?)`,
    )
    .bind(
      spec.name,
      JSON.stringify({
        snapshotVersion: 1,
        resourceType: "site_settings",
        publishedAt: BASE_TIME,
        contentModifiedAt: BASE_TIME,
        data: {
          siteTitle: spec.name,
          tagline: "Solusi Profesional Indonesia",
          timezone: "Asia/Jakarta",
          locale: "id-ID",
          activeThemeId: "compro",
          blogEnabled: true,
          catalogEnabled: true,
          siteVisibility: "public",
        },
      }),
      BASE_TIME,
      BASE_TIME,
      BASE_TIME,
    )
    .run();

  await tDb
    .prepare(
      `INSERT OR REPLACE INTO business_profile (
         id, business_name, business_category, description, published_json,
         published_at, content_modified_at, version, updated_at
       ) VALUES (1, ?, 'LocalBusiness', 'Deskripsi resmi perusahaan.', ?, ?, ?, 1, ?)`,
    )
    .bind(
      spec.name,
      JSON.stringify({
        snapshotVersion: 1,
        resourceType: "business_profile",
        publishedAt: BASE_TIME,
        contentModifiedAt: BASE_TIME,
        data: {
          businessName: spec.name,
          businessCategory: "LocalBusiness",
          description: "Deskripsi resmi perusahaan.",
        },
      }),
      BASE_TIME,
      BASE_TIME,
      BASE_TIME,
    )
    .run();

  // Enable seo-ai-autopilot so sitemap.xml & JSON-LD are active
  await tDb
    .prepare(
      `INSERT OR REPLACE INTO installed_plugins (plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at)
       VALUES ('seo-ai-autopilot', '1.0.0', 1, '{}', 1, ?, ?)`,
    )
    .bind(BASE_TIME, BASE_TIME)
    .run();

  return tDb;
}

async function seedUsersAndMembers() {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(users)
    .values([
      {
        id: USER_ALPHA_OWNER,
        email: "owner.alpha.t092@example.test",
        emailVerified: true,
        name: "Budi Owner",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: USER_ALPHA_EDITOR,
        email: "editor.alpha.t092@example.test",
        emailVerified: true,
        name: "Dina Editor",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: USER_BETA_OWNER,
        email: "owner.beta.t092@example.test",
        emailVerified: true,
        name: "Sari Beta",
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  await pDb
    .insert(members)
    .values([
      {
        id: "mem_t092_ao",
        organizationId: TENANT_ALPHA.orgId,
        userId: USER_ALPHA_OWNER,
        role: "owner",
        createdAt: now,
      },
      {
        id: "mem_t092_ae",
        organizationId: TENANT_ALPHA.orgId,
        userId: USER_ALPHA_EDITOR,
        role: "editor",
        createdAt: now,
      },
      {
        id: "mem_t092_bo",
        organizationId: TENANT_BETA.orgId,
        userId: USER_BETA_OWNER,
        role: "owner",
        createdAt: now,
      },
    ])
    .onConflictDoNothing();
}

async function seedMediaItem(
  tDb: D1Database,
  params: {
    readonly id: number;
    readonly tenantId: string;
    readonly status?: "ready" | "processing" | "failed";
    readonly altText?: string;
  },
) {
  const key = `t/${params.tenantId}/media/${params.id}/w640.webp`;
  await tDb
    .prepare(
      `INSERT OR REPLACE INTO media_items (
         id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text,
         variants_json, status, version, created_at, updated_at
       ) VALUES (?, 'image', ?, 'image/webp', 24576, ?, 640, 640, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      params.id,
      key,
      `sha256_media_${params.tenantId}_${params.id}`,
      params.altText ?? `Foto avatar #${params.id}`,
      JSON.stringify({
        w640: { key, width: 640, height: 640, bytes: 24576 },
      }),
      params.status ?? "ready",
      BASE_TIME,
      BASE_TIME,
    )
    .run();
}

describe("TASK-092 workerd integration — Author Profiles, content_modified_at Discipline & Server-Rendered TOC", () => {
  let alphaDb: D1Database;
  let betaDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    alphaDb = await seedTenant(TENANT_ALPHA);
    betaDb = await seedTenant(TENANT_BETA);
    await seedUsersAndMembers();
  });

  beforeEach(async () => {
    clearHostResolutionCache();
    // Reset tenant blog tables cleanly between tests
    for (const db of [alphaDb, betaDb]) {
      await db.batch([
        db.prepare(`DELETE FROM post_taxonomies`),
        db.prepare(`DELETE FROM posts`),
        db.prepare(`DELETE FROM authors`),
        db.prepare(`DELETE FROM taxonomies`),
        db.prepare(`DELETE FROM resource_slugs`),
        db.prepare(`DELETE FROM content_revisions`),
        db.prepare(`DELETE FROM media_items`),
        db.prepare(`DELETE FROM analytics_daily`),
        db.prepare(`DELETE FROM sequences`),
      ]);
    }
    await env.PLATFORM_DB.prepare(`UPDATE tenants SET status = 'active' WHERE id IN (?, ?)`)
      .bind(TENANT_ALPHA.id, TENANT_BETA.id)
      .run();
  });

  it("enforces Author Profiles CRUD, tenant isolation, CSRF/Origin, RBAC, avatar ownership & guarded delete", async () => {
    const apiEnv = buildApiEnv();
    await seedMediaItem(alphaDb, {
      id: 10,
      tenantId: TENANT_ALPHA.id,
      status: "ready",
      altText: "Foto profil Rina Kartika",
    });
    await seedMediaItem(alphaDb, {
      id: 11,
      tenantId: TENANT_ALPHA.id,
      status: "processing",
    });
    await seedMediaItem(betaDb, {
      id: 99,
      tenantId: TENANT_BETA.id,
      status: "ready",
    });

    // 1. Unauthenticated request -> 401
    const unauthRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`),
      apiEnv,
      { authenticatedUser: null },
    );
    expect(unauthRes.status).toBe(401);

    // 2. Wrong host surface (public tenant host) -> neutral 404
    const wrongHostRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`, {
        hostOrigin: `https://${TENANT_ALPHA.customDomain}`,
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER } },
    );
    expect(wrongHostRes.status).toBe(404);

    // 3. Cross-site CSRF forged Origin on POST -> 403
    const csrfRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`, {
        method: "POST",
        origin: "https://evil.example.com",
        secFetchSite: "cross-site",
        body: { name: "Attacker" },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER } },
    );
    expect(csrfRes.status).toBe(403);

    // 4. Cross-tenant access (Beta owner hitting Alpha) -> neutral 404
    const crossTenantRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`),
      apiEnv,
      { authenticatedUser: { id: USER_BETA_OWNER } },
    );
    expect(crossTenantRes.status).toBe(404);

    // 5. Rejects non-ready avatar (#11 processing) and cross-tenant avatar (#99 in Beta only) -> 422
    const procAvatarRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`, {
        method: "POST",
        body: { name: "Rina Kartika", avatarMediaId: 11 },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_EDITOR } },
    );
    expect(procAvatarRes.status).toBe(422);

    const foreignAvatarRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`, {
        method: "POST",
        body: { name: "Rina Kartika", avatarMediaId: 99 },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_EDITOR } },
    );
    expect(foreignAvatarRes.status).toBe(422);

    // 6. Editor creates valid author profile with roleTitle, bio, ready avatar & sameAs -> 201
    const createRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors`, {
        method: "POST",
        body: {
          name: "Rina Kartika, S.Ars",
          roleTitle: "Principal Architect & Lead Auditor",
          bio: "12 tahun pengalaman audit gedung kantor dan renovasi komersial di Indonesia.",
          avatarMediaId: 10,
          sameAs: ["https://linkedin.com/in/rinakartika"],
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_EDITOR }, nowMs: BASE_TIME },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created.id).toBe(1);
    expect(created.name).toBe("Rina Kartika, S.Ars");
    expect(created.roleTitle).toBe("Principal Architect & Lead Auditor");
    expect(created.avatarMediaId).toBe(10);
    expect((created.avatar as Record<string, unknown>).url).toBe(
      `https://cdn.punyasitus.com/t/${TENANT_ALPHA.id}/media/10/w640.webp`,
    );
    expect(created.version).toBe(1);

    // 7. Tenant Beta lists authors -> completely empty (strict isolation)
    const betaListRes = await handleTenantPostAuthorsCollectionRequest(
      TENANT_BETA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_BETA.handle}/posts/authors`),
      apiEnv,
      { authenticatedUser: { id: USER_BETA_OWNER } },
    );
    expect(betaListRes.status).toBe(200);
    const betaList = (await betaListRes.json()) as { items: unknown[] };
    expect(betaList.items).toHaveLength(0);

    // 8. Update with optimistic concurrency (valid v1 -> 200 v2 + bumps cache_version; stale v1 -> 409)
    const cacheBeforePatch = await env.PLATFORM_DB.prepare(
      `SELECT cache_version FROM tenants WHERE id = ?`,
    )
      .bind(TENANT_ALPHA.id)
      .first<{ readonly cache_version: number }>();

    const updateRes = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      "1",
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/1`, {
        method: "PATCH",
        body: {
          version: 1,
          roleTitle: "Senior Principal Architect",
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: BASE_TIME + 1000 },
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as Record<string, unknown>;
    expect(updated.version).toBe(2);
    expect(updated.roleTitle).toBe("Senior Principal Architect");
    expect(Number(updated.cacheVersion)).toBeGreaterThan(Number(cacheBeforePatch?.cache_version ?? 0));

    const staleRes = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      "1",
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/1`, {
        method: "PATCH",
        body: { version: 1, roleTitle: "Stale Write" },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_EDITOR } },
    );
    expect(staleRes.status).toBe(409);

    // 9. Assign author to a post -> DELETE missing version returns 422; DELETE without detach returns 409 AUTHOR_IN_USE
    await createPost(alphaDb, {
      title: "Artikel Dengan Penulis",
      bodyHtml: "<h2>Pembukaan</h2><p>Isi artikel singkat.</p>",
      authorProfileId: 1,
      tocEnabled: true,
      nowMs: BASE_TIME,
    });

    const missingVerDel = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      "1",
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/1`, {
        method: "DELETE",
        body: {},
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER } },
    );
    expect(missingVerDel.status).toBe(422);

    const blockedDel = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      "1",
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/1`, {
        method: "DELETE",
        body: { version: 2 },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER } },
    );
    expect(blockedDel.status).toBe(409);
    const blockedBody = (await blockedDel.json()) as { error: { reason: string; postCount: number } };
    expect(blockedBody.error.reason).toBe("AUTHOR_IN_USE");
    expect(blockedBody.error.postCount).toBe(1);

    // 10. Guarded DELETE with detach: true succeeds -> 204 and bumps tenant cache_version
    const cacheBeforeDel = await env.PLATFORM_DB.prepare(
      `SELECT cache_version FROM tenants WHERE id = ?`,
    )
      .bind(TENANT_ALPHA.id)
      .first<{ readonly cache_version: number }>();

    const detachDel = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      "1",
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/1`, {
        method: "DELETE",
        body: { version: 2, detach: true },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: BASE_TIME + 2000 },
    );
    expect(detachDel.status).toBe(204);

    const cacheAfterDel = await env.PLATFORM_DB.prepare(
      `SELECT cache_version FROM tenants WHERE id = ?`,
    )
      .bind(TENANT_ALPHA.id)
      .first<{ readonly cache_version: number }>();
    expect(Number(cacheAfterDel?.cache_version)).toBeGreaterThan(Number(cacheBeforeDel?.cache_version ?? 0));
  });

  it("enforces strict content_modified_at discipline across draft autosave, analytics ticks, settings updates, no-op republish, and substantive republish (including sitemap <lastmod>)", async () => {
    const apiEnv = buildApiEnv();
    const T1 = BASE_TIME + 1 * DAY_MS;
    const T2 = BASE_TIME + 2 * DAY_MS;
    const T3 = BASE_TIME + 3 * DAY_MS;
    const T4 = BASE_TIME + 4 * DAY_MS;

    // Verify category hierarchy <= 3 depth (1 -> 2 -> 3 allowed; depth 4 rejected)
    const catL1 = await createBlogTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Renovasi",
      nowMs: BASE_TIME,
    });
    const catL2 = await createBlogTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Kantor B2B",
      parentId: catL1.id,
      nowMs: BASE_TIME,
    });
    const catL3 = await createBlogTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Audit MEP",
      parentId: catL2.id,
      nowMs: BASE_TIME,
    });
    expect(catL3.depth).toBe(3);

    await expect(
      createBlogTaxonomy(alphaDb, {
        kind: "post_category",
        name: "Terlalu Dalam",
        parentId: catL3.id,
        nowMs: BASE_TIME,
      }),
    ).rejects.toThrow(/depth 3/i);

    const tag = await createBlogTaxonomy(alphaDb, {
      kind: "post_tag",
      name: "Standar K3",
      nowMs: BASE_TIME,
    });

    const author = await createPostAuthor(
      alphaDb,
      {
        name: "Ir. Hendra Wijaya",
        roleTitle: "Kepala Divisi Audit Struktur",
        bio: "Spesialis inspeksi struktur gedung bertingkat.",
        nowMs: BASE_TIME,
      },
      { tenantId: TENANT_ALPHA.id },
    );

    // Create post via API
    const createRes = await handleTenantPostsCollectionRequest(
      TENANT_ALPHA.handle,
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts`, {
        method: "POST",
        body: {
          title: "Checklist Audit Gedung 2026",
          slug: "checklist-audit-gedung-2026",
          excerpt: "Langkah inspeksi menyeluruh untuk pengelola gedung.",
          bodyHtml:
            "<h2>Inspeksi Struktur</h2><p>Periksa kolom dan balok utama secara berkala.</p><h3>Sistem Kelistrikan</h3><p>Pastikan panel distribusi sesuai standar PUIL.</p>",
          authorProfileId: author.id,
          primaryCategoryId: catL3.id,
          categoryIds: [catL3.id, catL1.id],
          tagIds: [tag.id],
          tocEnabled: true,
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T1 - 10_000 },
    );
    expect(createRes.status).toBe(201);
    const draftPost = (await createRes.json()) as Record<string, unknown>;
    expect(draftPost.contentModifiedAt).toBeNull();

    // First publish at T1 -> sets publishedAt = T1 and contentModifiedAt = T1
    const pub1Res = await handleTenantPostPublishRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}/publish`, {
        method: "POST",
        body: { version: draftPost.version },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T1 },
    );
    expect(pub1Res.status).toBe(200);
    const pub1 = (await pub1Res.json()) as Record<string, unknown>;
    expect(pub1.publishedAt).toBe(new Date(T1).toISOString());
    expect(pub1.contentModifiedAt).toBe(new Date(T1).toISOString());
    expect(pub1.substantiveChanged).toBe(true);

    const fetchPostsSitemapXml = async (nowMs: number) => {
      const req = new Request(`https://${TENANT_ALPHA.customDomain}/sitemaps/posts.xml`, {
        method: "GET",
      });
      const res = await handleSubSitemapRequest(req, "posts", {
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        platformDomain: "punyasitus.com",
        saasZone: "situsku.click",
        nowMs,
        bypassHostCache: true,
      });
      expect(res.status).toBe(200);
      return res.text();
    };

    const t1Iso = new Date(T1).toISOString();
    const xml1 = await fetchPostsSitemapXml(T1);
    expect(xml1).toContain(`<lastmod>${t1Iso}</lastmod>`);

    // 1. Draft autosave at T2 MUST NEVER advance content_modified_at or sitemap <lastmod>
    const autosaveRes = await handleTenantPostItemRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}`, {
        method: "PATCH",
        body: {
          version: pub1.version,
          title: "Checklist Audit Gedung 2026 (Draf Autosave)",
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_EDITOR }, nowMs: T2 },
    );
    expect(autosaveRes.status).toBe(200);
    const afterAutosave = (await autosaveRes.json()) as Record<string, unknown>;
    expect(afterAutosave.contentModifiedAt).toBe(t1Iso);

    // 2. Analytics tick + unrelated site_settings update at T2 MUST NEVER advance content_modified_at
    await alphaDb.batch([
      alphaDb
        .prepare(
          `INSERT INTO analytics_daily (day, path, pageviews, unique_visitors, updated_at)
           VALUES ('2026-11-24', '/blog/checklist-audit-gedung-2026', 42, 31, ?)`,
        )
        .bind(T2),
      alphaDb
        .prepare(`UPDATE site_settings SET tagline = 'Tagline Baru Tanpa Ubah Artikel', updated_at = ? WHERE id = 1`)
        .bind(T2),
    ]);

    const xmlAfterNoise = await fetchPostsSitemapXml(T2);
    expect(xmlAfterNoise).toContain(`<lastmod>${t1Iso}</lastmod>`);
    expect(xmlAfterNoise).not.toContain(new Date(T2).toISOString());

    // 3. Revert draft title back to original & perform NO-OP republish at T3 -> preserves T1!
    const revertDraftRes = await handleTenantPostItemRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}`, {
        method: "PATCH",
        body: {
          version: afterAutosave.version,
          title: "Checklist Audit Gedung 2026",
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T3 - 1000 },
    );
    const reverted = (await revertDraftRes.json()) as Record<string, unknown>;

    const noopPubRes = await handleTenantPostPublishRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}/publish`, {
        method: "POST",
        body: { version: reverted.version },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T3 },
    );
    expect(noopPubRes.status).toBe(200);
    const noopPub = (await noopPubRes.json()) as Record<string, unknown>;
    expect(noopPub.substantiveChanged).toBe(false);
    expect(noopPub.contentModifiedAt).toBe(t1Iso);

    // Verify revision snapshot_json ALSO retained the preserved T1 contentModifiedAt atomically!
    const latestRev = await alphaDb
      .prepare(
        `SELECT snapshot_json FROM content_revisions
         WHERE resource_type = 'post' AND resource_id = ?
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .bind(draftPost.id)
      .first<{ readonly snapshot_json: string }>();
    expect(latestRev).toBeTruthy();
    const parsedRev = JSON.parse(latestRev!.snapshot_json) as { contentModifiedAt: number };
    expect(parsedRev.contentModifiedAt).toBe(T1);

    const xmlAfterNoop = await fetchPostsSitemapXml(T3);
    expect(xmlAfterNoop).toContain(`<lastmod>${t1Iso}</lastmod>`);

    // 3b. Legacy published post (content_fingerprint IS NULL and un-anchored <h2> HTML) republished unchanged
    //     MUST NOT spuriously advance content_modified_at!
    const currentRow = await alphaDb
      .prepare(`SELECT published_body_json, version FROM posts WHERE id = ?`)
      .bind(draftPost.id)
      .first<{ readonly published_body_json: string; readonly version: number }>();
    const legacyPubJson = currentRow!.published_body_json
      .replace(/<h2 id="[^"]+">/g, "<h2>")
      .replace(/<h3 id="[^"]+">/g, "<h3>");
    await alphaDb
      .prepare(`UPDATE posts SET published_body_json = ?, content_fingerprint = NULL WHERE id = ?`)
      .bind(legacyPubJson, draftPost.id)
      .run();

    const legacyNoopRes = await handleTenantPostPublishRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}/publish`, {
        method: "POST",
        body: { version: currentRow!.version },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T3 + 60_000 },
    );
    expect(legacyNoopRes.status).toBe(200);
    const legacyNoop = (await legacyNoopRes.json()) as Record<string, unknown>;
    expect(legacyNoop.substantiveChanged).toBe(false);
    expect(legacyNoop.contentModifiedAt).toBe(t1Iso);

    // 4. Substantive edit + republish at T4 -> MUST advance content_modified_at AND sitemap <lastmod> to T4!
    const editRes = await handleTenantPostItemRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}`, {
        method: "PATCH",
        body: {
          version: legacyNoop.version,
          bodyHtml:
            "<h2>Inspeksi Struktur</h2><p>Periksa kolom, balok utama, dan fondasi sesuai SNI terbaru 2026.</p><h3>Sistem Kelistrikan</h3><p>Pastikan panel distribusi dan sistem proteksi petir sesuai standar PUIL.</p>",
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T4 - 5000 },
    );
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as Record<string, unknown>;

    const pub2Res = await handleTenantPostPublishRequest(
      TENANT_ALPHA.handle,
      String(draftPost.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${draftPost.id}/publish`, {
        method: "POST",
        body: { version: edited.version },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T4 },
    );
    expect(pub2Res.status).toBe(200);
    const pub2 = (await pub2Res.json()) as Record<string, unknown>;
    const t4Iso = new Date(T4).toISOString();
    expect(pub2.substantiveChanged).toBe(true);
    expect(pub2.publishedAt).toBe(t1Iso);
    expect(pub2.contentModifiedAt).toBe(t4Iso);

    const xmlAfterSubstantive = await fetchPostsSitemapXml(T4);
    expect(xmlAfterSubstantive).toContain(`<lastmod>${t4Iso}</lastmod>`);
  });

  it("renders 1:1 visible author byline (with role_title) <-> Article.author JSON-LD parity and zero-JS TOC anchors on public /blog/[slug]", async () => {
    const T1 = BASE_TIME;
    const T2 = BASE_TIME + 2 * DAY_MS;

    await seedMediaItem(alphaDb, {
      id: 21,
      tenantId: TENANT_ALPHA.id,
      status: "ready",
      altText: "Foto profil Dr. Sari Wulandari",
    });

    const cat = await createBlogTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Panduan Renovasi",
      nowMs: T1,
    });

    const author = await createPostAuthor(
      alphaDb,
      {
        name: "Dr. Sari Wulandari",
        roleTitle: "Direktur Teknis & Konsultan Arsitektur",
        bio: "Berpengalaman lebih dari 15 tahun mendampingi proyek perkantoran dan bangunan hijau.",
        avatarMediaId: 21,
        sameAs: ["https://linkedin.com/in/sariwulandari", "https://instagram.com/sariwulandari"],
        nowMs: T1,
      },
      { tenantId: TENANT_ALPHA.id, mediaBaseOrigin: "https://cdn.punyasitus.com" },
    );

    const created = await createPost(alphaDb, {
      title: "Strategi Efisiensi Energi Gedung Kantor",
      slug: "strategi-efisiensi-energi-gedung",
      excerpt: "Panduan praktis menurunkan konsumsi listrik hingga 28%.",
      bodyHtml: [
        "<h2>Audit Konsumsi Listrik</h2>",
        "<p>Langkah awal adalah memetakan beban puncak sistem tata udara dan pencahayaan gedung.</p>",
        "<h3>Pencahayaan LED Otomatis</h3>",
        "<p>Sensor gerak mengurangi pemborosan listrik di ruang rapat.</p>",
        "<h3>Pencahayaan LED Otomatis</h3>",
        "<p>Kalibrasi ulang jadwal operasional gedung setiap kuartal.</p>",
      ].join("\n"),
      authorProfileId: author.id,
      primaryCategoryId: cat.id,
      categoryIds: [cat.id],
      tocEnabled: true,
      nowMs: T1,
    });

    const pub1 = await publishPost(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      postId: created.id,
      expectedVersion: created.version,
      nowMs: T1,
    });

    // Perform substantive edit & republish at T2 so dateModified differs from datePublished
    const apiEnv = buildApiEnv();
    const editRes = await handleTenantPostItemRequest(
      TENANT_ALPHA.handle,
      String(created.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/${created.id}`, {
        method: "PATCH",
        body: {
          version: pub1.post.version,
          excerpt: "Panduan terukur menurunkan konsumsi listrik kantor hingga 30%.",
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T2 - 1000 },
    );
    const edited = (await editRes.json()) as { version: number };

    await publishPost(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      postId: created.id,
      expectedVersion: edited.version,
      nowMs: T2,
    });

    // Resolve public route + enrich + TASK-092 presentation
    const deps = buildPublicDeps(T2);
    const req = new Request(
      `https://${TENANT_ALPHA.customDomain}/blog/strategi-efisiensi-energi-gedung`,
      { method: "GET" },
    );
    const routeRes = await resolveBlogDetailRoute(req, deps, "strategi-efisiensi-energi-gedung", {
      url: new URL(req.url),
    });
    expect(routeRes.kind).toBe("blog_detail");
    if (routeRes.kind !== "blog_detail") return;

    const enriched = await enrichPublicBlogDetailResult(routeRes, deps);
    const presentation = await resolveBlogDetailPresentation(routeRes, enriched, deps);

    // 1. Server-rendered TOC anchors match HTML headings 1:1 with zero duplicates
    expect(presentation.showToc).toBe(true);
    expect(presentation.toc).toEqual([
      { id: "audit-konsumsi-listrik", text: "Audit Konsumsi Listrik", level: 2 },
      { id: "pencahayaan-led-otomatis", text: "Pencahayaan LED Otomatis", level: 3 },
      { id: "pencahayaan-led-otomatis-2", text: "Pencahayaan LED Otomatis", level: 3 },
    ]);
    for (const item of presentation.toc) {
      expect(presentation.sanitizedHtmlWithAnchors).toContain(`id="${item.id}"`);
    }

    // 2. Visible author byline matches Article.author JSON-LD 1:1 (including role_title -> jobTitle)
    expect(presentation.authorByline?.name).toBe("Dr. Sari Wulandari");
    expect(presentation.authorByline?.roleTitle).toBe("Direktur Teknis & Konsultan Arsitektur");
    expect(presentation.authorByline?.bio).toContain("15 tahun");
    expect(presentation.authorByline?.avatar?.url).toBe(
      `https://cdn.punyasitus.com/t/${TENANT_ALPHA.id}/media/21/w640.webp`,
    );

    const graphNodes = presentation.schemaGraph?.["@graph"] ?? [];
    const articleNode = graphNodes.find(
      (n) => n["@type"] === "BlogPosting" || n["@type"] === "Article",
    );
    expect(articleNode).toBeTruthy();
    expect(articleNode?.datePublished).toBe(new Date(T1).toISOString());
    expect(articleNode?.dateModified).toBe(new Date(T2).toISOString());

    const jsonLdAuthor = articleNode?.author as Record<string, unknown>;
    expect(jsonLdAuthor["@type"]).toBe("Person");
    expect(jsonLdAuthor.name).toBe(presentation.authorByline?.name);
    expect(jsonLdAuthor.jobTitle).toBe(presentation.authorByline?.roleTitle);
    expect(jsonLdAuthor.description).toBe(presentation.authorByline?.bio);
    expect((jsonLdAuthor.image as Record<string, unknown>).url).toBe(
      presentation.authorByline?.avatar?.url,
    );
    expect(jsonLdAuthor.sameAs).toEqual(presentation.authorByline?.sameAs);

    // 3. Updated date visibility + primary category in breadcrumbs
    expect(presentation.showUpdatedDate).toBe(true);
    expect(presentation.breadcrumbs.some((b) => b.label === "Panduan Renovasi")).toBe(true);

    // 4. Clearing bio, avatarMediaId & sameAs on the author row is authoritative (no stale fallback!)
    const clearAuthorRes = await handleTenantPostAuthorItemRequest(
      TENANT_ALPHA.handle,
      String(author.id),
      makeAdminRequest(`/api/tenants/${TENANT_ALPHA.handle}/posts/authors/${author.id}`, {
        method: "PATCH",
        body: {
          version: author.version,
          bio: null,
          avatarMediaId: null,
          sameAs: [],
        },
      }),
      apiEnv,
      { authenticatedUser: { id: USER_ALPHA_OWNER }, nowMs: T2 + 5_000 },
    );
    expect(clearAuthorRes.status).toBe(200);

    const routeResAfterClear = await resolveBlogDetailRoute(
      req,
      deps,
      "strategi-efisiensi-energi-gedung",
      { url: new URL(req.url) },
    );
    expect(routeResAfterClear.kind).toBe("blog_detail");
    if (routeResAfterClear.kind !== "blog_detail") return;
    const enrichedAfterClear = await enrichPublicBlogDetailResult(routeResAfterClear, deps);
    const presentationAfterClear = await resolveBlogDetailPresentation(
      routeResAfterClear,
      enrichedAfterClear,
      deps,
    );

    expect(presentationAfterClear.authorByline?.bio).toBeNull();
    expect(presentationAfterClear.authorByline?.avatar).toBeNull();
    expect(presentationAfterClear.authorByline?.sameAs).toEqual([]);
    const clearedArticle = (presentationAfterClear.schemaGraph?.["@graph"] ?? []).find(
      (n) => n["@type"] === "BlogPosting" || n["@type"] === "Article",
    );
    const clearedJsonLdAuthor = clearedArticle?.author as Record<string, unknown>;
    expect(clearedJsonLdAuthor.name).toBe("Dr. Sari Wulandari");
    expect(clearedJsonLdAuthor.description).toBeUndefined();
    expect(clearedJsonLdAuthor.image).toBeUndefined();
    expect(clearedJsonLdAuthor.sameAs).toBeUndefined();
  });
});
