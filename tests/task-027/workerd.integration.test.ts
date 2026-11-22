import { env } from "cloudflare:workers";
import {
  PublicationAtomicError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
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
  getDraftResourceForAdmin,
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
  unpublishResourceAtomically,
} from "@punyasitus/db/publication/index";
import { clearHostResolutionCache, resolveTenantByHost } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PREVIEW_CACHE_CONTROL,
  PREVIEW_ROBOTS_TAG,
  serveWithRevisionedEdgeCache,
} from "../../apps/web/src/core/cache.ts";

const TENANT_A = {
  id: "01JT027TENANTA000000000001",
  orgId: "org_t027_alpha",
  handle: "t027-alpha",
  name: "T027 Alpha Studio",
  host: "t027-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT027TENANTB000000000002",
  orgId: "org_t027_beta",
  handle: "t027-beta",
  name: "T027 Beta Klinik",
  host: "t027-beta.situsku.click",
} as const;

function getDefaultCache(): Cache {
  return (caches as unknown as { readonly default: Cache }).default;
}

async function seedTenantInPlatformAndMigrateDo(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly host: string;
}): Promise<D1Database> {
  const now = new Date();
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
      host: spec.host,
      tenantId: spec.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(ns, spec.id);
  const mig = await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  expect(mig.httpStatus).toBe(200);
  return createTenantDb(stub);
}

async function getTenantCacheVersion(tenantId: string): Promise<number> {
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const [row] = await pDb
    .select({ cacheVersion: tenants.cacheVersion })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new Error(`Tenant ${tenantId} missing`);
  return row.cacheVersion;
}

describe("TASK-027 Draft/Publish Snapshots & Revisioned Cache on workerd", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    [tenantDbA, tenantDbB] = await Promise.all([
      seedTenantInPlatformAndMigrateDo(TENANT_A),
      seedTenantInPlatformAndMigrateDo(TENANT_B),
    ]);
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("isolates drafts from published public reads, rejects stale 409 writes, publishes atomically with cache_version bump, and busts edge cache", async () => {
    const cache = getDefaultCache();
    const t0 = 1_800_000_000_000;

    // Seed initial draft page #1 in Tenant A
    await tenantDbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Awal', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(t0, t0)
      .run();

    // 1. Draft page NEVER leaks through getPublishedResource
    expect(await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 })).toBeNull();
    expect(await getPublishedResource(tenantDbA, { resourceType: "page", slug: "beranda" })).toBeNull();

    // Save draft v1 -> v2 with draft-only notes
    const savedV2 = await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: t0 + 1_000,
      draft: {
        slug: "beranda",
        title: "Beranda Alpha v1",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "hero-1",
            kind: "hero",
            heading: "Selamat Datang Alpha",
            subheading: "Solusi UMKM",
            bodyHtml: "<p>Konten resmi</p>",
          },
        ],
        draftNotes: "Confidential editor note",
      },
    });
    expect(savedV2.version).toBe(2);
    expect(savedV2.draftMetadata).toEqual({ draftNotes: "Confidential editor note" });

    // Still unpublished -> public loader MUST return null, cache_version unchanged
    expect(await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 })).toBeNull();
    const cacheVerBeforePublish = await getTenantCacheVersion(TENANT_A.id);

    // Warm host resolution cache before publish so we can prove publish evicts it
    const resolvedBefore = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.host, {
      nowMs: t0 + 2_000,
    });
    expect(resolvedBefore.kind).toBe("resolved");
    if (resolvedBefore.kind === "resolved") {
      expect(resolvedBefore.tenant.cacheVersion).toBe(cacheVerBeforePublish);
    }

    // 2. Stale expectedVersion returns 409 StaleRevisionError without mutating DB or cache_version
    await expect(
      saveDraftResource(tenantDbA, {
        resourceType: "page",
        resourceId: 1,
        expectedVersion: 1, // stale! current is 2
        draft: {
          slug: "beranda",
          title: "Stale Overwrite",
          isHomepage: true,
          sections: [],
        },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(StaleRevisionError);
      const e = err as StaleRevisionError;
      expect(e.httpStatus).toBe(409);
      expect(e.code).toBe("STALE_VERSION");
      expect(e.actualVersion).toBe(2);
      return true;
    });

    await expect(
      publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
        tenantId: TENANT_A.id,
        resourceType: "page",
        resourceId: 1,
        expectedVersion: 1, // stale!
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheVerBeforePublish);

    // 3. Publish atomically (v2 -> v3, cache_version bumps by 1)
    const pub1 = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      actorUserId: "usr_alpha_owner",
      nowMs: t0 + 3_000,
    });
    expect(pub1.version).toBe(3);
    expect(pub1.cacheVersion).toBe(cacheVerBeforePublish + 1);
    expect(pub1.publishedAt).toBe(t0 + 3_000);
    expect(pub1.contentModifiedAt).toBe(t0 + 3_000);
    expect(pub1.revisionNumber).toBe(1);

    // Host resolution cache was evicted so next lookup immediately sees new cache_version
    const resolvedAfterPub1 = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.host, {
      nowMs: t0 + 3_100,
    });
    expect(resolvedAfterPub1.kind).toBe("resolved");
    if (resolvedAfterPub1.kind === "resolved") {
      expect(resolvedAfterPub1.fromCache).toBe(false);
      expect(resolvedAfterPub1.tenant.cacheVersion).toBe(pub1.cacheVersion);
    }

    // Public loader returns clean published snapshot WITHOUT draftNotes
    const publicV1 = await getPublishedResource(tenantDbA, { resourceType: "page", slug: "beranda" });
    expect(publicV1).not.toBeNull();
    expect(publicV1?.data.title).toBe("Beranda Alpha v1");
    expect(JSON.stringify(publicV1)).not.toContain("Confidential editor note");

    // Warm revisioned edge cache at pub1.cacheVersion
    let renderCount = 0;
    const renderPublicHome = async () => {
      renderCount += 1;
      const pub = await getPublishedResource(tenantDbA, { resourceType: "page", slug: "beranda" });
      if (!pub) return new Response("Not Found", { status: 404 });
      return new Response(`<h1>${pub.data.title}</h1>`, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    };

    const reqHome = new Request(`https://${TENANT_A.host}/`);
    const miss1 = await serveWithRevisionedEdgeCache({
      request: reqHome,
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pub1.cacheVersion,
      cache,
      render: renderPublicHome,
    });
    expect(miss1.cacheStatus).toBe("MISS");
    expect(await miss1.response.text()).toBe("<h1>Beranda Alpha v1</h1>");
    expect(miss1.response.headers.get("X-PunyaSitus-Cache-Version")).toBe(String(pub1.cacheVersion));

    const hit1 = await serveWithRevisionedEdgeCache({
      request: reqHome,
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pub1.cacheVersion,
      cache,
      render: renderPublicHome,
    });
    expect(hit1.cacheStatus).toBe("HIT");
    expect(await hit1.response.text()).toBe("<h1>Beranda Alpha v1</h1>");
    expect(renderCount).toBe(1);

    // 4. Subsequent draft edit (v3 -> v4) MUST NEVER leak to public loader, cache, or content_modified_at!
    const draftV4 = await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 3,
      nowMs: t0 + 10_000,
      draft: {
        slug: "beranda",
        title: "UNPUBLISHED SECRET DRAFT v2",
        isHomepage: true,
        layoutMode: "focused",
        sections: [
          {
            id: "hero-2",
            kind: "hero",
            heading: "Draft Headline Only",
            subheading: null,
            bodyHtml: "<p>Draft body</p>",
          },
        ],
        draftNotes: "Wait until Monday",
      },
    });
    expect(draftV4.version).toBe(4);
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(pub1.cacheVersion);

    // Public loader STILL returns v1 published snapshot & unchanged contentModifiedAt
    const publicDuringDraft = await getPublishedResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(publicDuringDraft?.data.title).toBe("Beranda Alpha v1");
    expect(publicDuringDraft?.contentModifiedAt).toBe(t0 + 3_000);
    expect(publicDuringDraft?.publishedAt).toBe(t0 + 3_000);

    // Admin draft loader sees BOTH draft and published with hasUnpublishedChanges = true
    const adminView = await getDraftResourceForAdmin(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(adminView?.draft?.title).toBe("UNPUBLISHED SECRET DRAFT v2");
    expect(adminView?.published?.title).toBe("Beranda Alpha v1");
    expect(adminView?.hasUnpublishedChanges).toBe(true);

    // 5. Preview request bypasses cache completely (read & write) and emits private/no-store + noindex
    const previewRes = await serveWithRevisionedEdgeCache({
      request: new Request(`https://${TENANT_A.host}/?preview=1`),
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pub1.cacheVersion,
      isPreview: true,
      cache,
      render: async () => {
        const draft = await getDraftResourceForAdmin(tenantDbA, {
          resourceType: "page",
          resourceId: 1,
        });
        return new Response(`<h1>${draft?.draft?.title ?? ""}</h1>`, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });
    expect(previewRes.cacheStatus).toBe("BYPASS");
    expect(previewRes.bypassReason).toBe("preview_request");
    expect(previewRes.response.headers.get("Cache-Control")).toBe(PREVIEW_CACHE_CONTROL);
    expect(previewRes.response.headers.get("X-Robots-Tag")).toBe(PREVIEW_ROBOTS_TAG);
    expect(await previewRes.response.text()).toBe("<h1>UNPUBLISHED SECRET DRAFT v2</h1>");

    // Public cache STILL serves v1 published content (preview never polluted cache!)
    const stillHitV1 = await serveWithRevisionedEdgeCache({
      request: reqHome,
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pub1.cacheVersion,
      cache,
      render: renderPublicHome,
    });
    expect(stillHitV1.cacheStatus).toBe("HIT");
    expect(await stillHitV1.response.text()).toBe("<h1>Beranda Alpha v1</h1>");
    expect(renderCount).toBe(1);

    // 6. Publish v4 -> v5 bumps cache_version again -> busts edge cache immediately!
    const pub2 = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 4,
      actorUserId: "usr_alpha_owner",
      nowMs: t0 + 20_000,
    });
    expect(pub2.version).toBe(5);
    expect(pub2.cacheVersion).toBe(pub1.cacheVersion + 1);
    expect(pub2.publishedAt).toBe(t0 + 3_000); // first publication timestamp preserved!
    expect(pub2.contentModifiedAt).toBe(t0 + 20_000); // lastmod updated on publish!
    expect(pub2.revisionNumber).toBe(2);

    const miss2 = await serveWithRevisionedEdgeCache({
      request: reqHome,
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pub2.cacheVersion,
      cache,
      render: renderPublicHome,
    });
    expect(miss2.cacheStatus).toBe("MISS");
    expect(await miss2.response.text()).toBe("<h1>UNPUBLISHED SECRET DRAFT v2</h1>");
    expect(miss2.response.headers.get("X-PunyaSitus-Cache-Version")).toBe(String(pub2.cacheVersion));
    expect(renderCount).toBe(2);

    // 7. Unpublish atomically removes public visibility, preserves draft, and bumps cache_version!
    const unpub = await unpublishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 5,
      nowMs: t0 + 30_000,
    });
    expect(unpub.version).toBe(6);
    expect(unpub.cacheVersion).toBe(pub2.cacheVersion + 1);

    expect(await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 })).toBeNull();
    const afterUnpubAdmin = await getDraftResourceForAdmin(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
    });
    expect(afterUnpubAdmin?.status).toBe("draft");
    expect(afterUnpubAdmin?.draft?.title).toBe("UNPUBLISHED SECRET DRAFT v2");
    expect(afterUnpubAdmin?.published).toBeNull();

    // New cache version renders 404 and does NOT cache the 404
    const afterUnpubPublic = await serveWithRevisionedEdgeCache({
      request: reqHome,
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: unpub.cacheVersion,
      cache,
      render: renderPublicHome,
    });
    expect(afterUnpubPublic.response.status).toBe(404);
    expect(afterUnpubPublic.cacheStatus).toBe("BYPASS");
  });

  it("compensates TenantStore cleanly when PLATFORM_DB cache_version bump fails", async () => {
    const t0 = 1_800_001_000_000;
    await tenantDbA
      .prepare(
        `INSERT INTO posts (id, slug, title, draft_body_json, status, version, created_at, updated_at)
         VALUES (10, 'artikel-kompensasi', 'Artikel Draft', ?, 'draft', 1, ?, ?)`,
      )
      .bind(
        JSON.stringify({
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Isi artikel valid" }],
        }),
        t0,
        t0,
      )
      .run();

    // Simulate PLATFORM_DB failure by passing a non-existent tenantId (or broken D1 batch)
    const brokenPlatformDb = {
      prepare: () => {
        throw new Error("Simulated PLATFORM_DB outage");
      },
      batch: async () => {
        throw new Error("Simulated PLATFORM_DB outage");
      },
    } as unknown as D1Database;

    await expect(
      publishResourceAtomically(brokenPlatformDb, tenantDbA, {
        tenantId: TENANT_A.id,
        resourceType: "post",
        resourceId: 10,
        expectedVersion: 1,
        nowMs: t0 + 1_000,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PublicationAtomicError);
      expect((err as PublicationAtomicError).httpStatus).toBe(503);
      expect((err as PublicationAtomicError).compensated).toBe(true);
      return true;
    });

    // Verify TenantStore rolled back post #10 to draft version 1 and removed revision #1
    expect(await getPublishedResource(tenantDbA, { resourceType: "post", resourceId: 10 })).toBeNull();
    const postRow = await tenantDbA
      .prepare("SELECT status, version, published_body_json FROM posts WHERE id = 10")
      .first<{ status: string; version: number; published_body_json: string | null }>();
    expect(postRow).toEqual({ status: "draft", version: 1, published_body_json: null });

    const revCount = await tenantDbA
      .prepare(
        "SELECT COUNT(*) AS cnt FROM content_revisions WHERE resource_type = 'post' AND resource_id = 10",
      )
      .first<{ cnt: number }>();
    expect(revCount?.cnt).toBe(0);

    // Also inject a failing content_revisions batch -> MUST compensate TenantStore cleanly & NOT bump cache_version!
    const cacheVersionBefore = await getTenantCacheVersion(TENANT_A.id);
    let failNextBatch = true;
    const failingRevisionTenantDb = {
      prepare: (sql: string) => tenantDbA.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error("Simulated content_revisions UNIQUE / RPC failure");
        }
        return tenantDbA.batch(stmts);
      },
    } as unknown as D1Database;

    await expect(
      publishResourceAtomically(env.PLATFORM_DB, failingRevisionTenantDb, {
        tenantId: TENANT_A.id,
        resourceType: "post",
        resourceId: 10,
        expectedVersion: 1,
        nowMs: t0 + 2_000,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PublicationAtomicError);
      expect((err as PublicationAtomicError).httpStatus).toBe(503);
      expect((err as PublicationAtomicError).compensated).toBe(true);
      return true;
    });

    expect(await getPublishedResource(tenantDbA, { resourceType: "post", resourceId: 10 })).toBeNull();
    expect(await getTenantCacheVersion(TENANT_A.id)).toBe(cacheVersionBefore);
  });

  it("supports theme_config, site_settings, business_profile, offering, and menu snapshots while rejecting CSS injection", async () => {
    const t0 = 1_800_002_000_000;

    // Seed theme_configs, site_settings, business_profile, offerings, menus in Tenant A
    await tenantDbA.batch([
      tenantDbA
        .prepare(
          `INSERT INTO theme_configs (theme_id, tokens_json, variants_json, version, updated_at)
           VALUES ('compro', ?, ?, 1, ?)`,
        )
        .bind(
          JSON.stringify({ primaryColor: "#1e40af", secondaryColor: "#0f766e" }),
          JSON.stringify({ styleVariant: "default" }),
          t0,
        ),
      tenantDbA
        .prepare(
          `INSERT INTO site_settings (id, site_title, version, updated_at)
           VALUES (1, 'Alpha Initial', 1, ?)`,
        )
        .bind(t0),
      tenantDbA
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, version, updated_at)
           VALUES (1, 'Alpha Corp', 'LocalBusiness', 1, ?)`,
        )
        .bind(t0),
      tenantDbA
        .prepare(
          `INSERT INTO menus (id, location, items_json, version, created_at, updated_at)
           VALUES (1, 'header', '[]', 1, ?, ?)`,
        )
        .bind(t0, t0),
      tenantDbA
        .prepare(
          `INSERT INTO offerings (id, offering_type, slug, title, price_mode, price, cta_mode, status, version, created_at, updated_at)
           VALUES (1, 'service', 'jasa-web', 'Jasa Web', 'fixed', 2500000, 'whatsapp', 'draft', 1, ?, ?)`,
        )
        .bind(t0, t0),
    ]);

    // CSS injection in theme_config draft is rejected with 422 before mutating DB
    await expect(
      saveDraftResource(tenantDbA, {
        resourceType: "theme_config",
        resourceId: "compro",
        expectedVersion: 1,
        draft: {
          themeId: "compro",
          tokens: {
            primaryColor: "#112233; background-image: url(https://evil.example/a.png)",
            secondaryColor: "#0f766e",
          },
          variants: { styleVariant: "default" },
        },
      }),
    ).rejects.toBeInstanceOf(PublicationValidationError);

    // Valid theme draft -> unpublished until published
    const themeDraft = await saveDraftResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
      expectedVersion: 1,
      draft: {
        themeId: "compro",
        tokens: {
          primaryColor: "#0369a1",
          secondaryColor: "#0f766e",
          fontFamily: "plus-jakarta-sans",
          borderRadiusPx: 10,
        },
        variants: {
          styleVariant: "modern",
          headerVariant: "sticky-cta",
        },
      },
    });
    expect(themeDraft.version).toBe(2);
    expect(
      await getPublishedResource(tenantDbA, {
        resourceType: "theme_config",
        resourceId: "compro",
      }),
    ).toBeNull();

    const themePub = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "theme_config",
      resourceId: "compro",
      expectedVersion: 2,
    });
    expect(themePub.publishedSnapshot.data.tokens.primaryColor).toBe("#0369a1");

    const pubTheme = await getPublishedResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "compro",
    });
    expect(pubTheme?.data.variants.headerVariant).toBe("sticky-cta");

    // Publish site_settings, business_profile, menu, and offering
    const settingsPub = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
    });
    expect(settingsPub.publishedSnapshot.data.siteTitle).toBe("Alpha Initial");

    const profilePub = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "business_profile",
      resourceId: 1,
      expectedVersion: 1,
    });
    expect(profilePub.publishedSnapshot.data.businessName).toBe("Alpha Corp");

    await saveDraftResource(tenantDbA, {
      resourceType: "menu",
      resourceId: 1,
      expectedVersion: 1,
      draft: {
        location: "header",
        items: [{ label: "Beranda", href: "/", openInNewTab: false, children: [] }],
      },
    });
    const menuPub = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "menu",
      resourceId: 1,
      expectedVersion: 2,
    });
    expect(menuPub.publishedSnapshot.data.items[0]?.label).toBe("Beranda");

    const offPub = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "offering",
      resourceId: 1,
      expectedVersion: 1,
    });
    expect(offPub.publishedSnapshot.data.slug).toBe("jasa-web");
  });

  it("maintains strict pooled two-tenant isolation across TenantStore DOs, PLATFORM_DB cache_version, and edge cache", async () => {
    const cache = getDefaultCache();
    const t0 = 1_800_003_000_000;

    // Seed identical page #2 (slug 'layanan-utama') in BOTH Tenant A and Tenant B
    await Promise.all([
      tenantDbA
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (2, 'layanan-utama', 'Layanan Alpha', 0, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(t0, t0)
        .run(),
      tenantDbB
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (2, 'layanan-utama', 'Layanan Beta', 0, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(t0, t0)
        .run(),
    ]);

    const cacheVerBStart = await getTenantCacheVersion(TENANT_B.id);

    // Publish both independently
    const [pubA, pubB] = await Promise.all([
      publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
        tenantId: TENANT_A.id,
        resourceType: "page",
        resourceId: 2,
        expectedVersion: 1,
        nowMs: t0 + 1_000,
      }),
      publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
        tenantId: TENANT_B.id,
        resourceType: "page",
        resourceId: 2,
        expectedVersion: 1,
        nowMs: t0 + 1_000,
      }),
    ]);

    expect(pubB.cacheVersion).toBe(cacheVerBStart + 1);

    // Cache Tenant A and Tenant B under the exact same pathname '/layanan-utama'
    const resA1 = await serveWithRevisionedEdgeCache({
      request: new Request(`https://${TENANT_A.host}/layanan-utama`),
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: pubA.cacheVersion,
      cache,
      render: async () => {
        const p = await getPublishedResource(tenantDbA, { resourceType: "page", slug: "layanan-utama" });
        return new Response(`<h1>${p?.data.title}</h1>`, { status: 200 });
      },
    });
    const resB1 = await serveWithRevisionedEdgeCache({
      request: new Request(`https://${TENANT_B.host}/layanan-utama`),
      tenantId: TENANT_B.id,
      host: TENANT_B.host,
      cacheVersion: pubB.cacheVersion,
      cache,
      render: async () => {
        const p = await getPublishedResource(tenantDbB, { resourceType: "page", slug: "layanan-utama" });
        return new Response(`<h1>${p?.data.title}</h1>`, { status: 200 });
      },
    });
    expect(await resA1.response.text()).toBe("<h1>Layanan Alpha</h1>");
    expect(await resB1.response.text()).toBe("<h1>Layanan Beta</h1>");

    // Mutate & republish Tenant A (and unpublish!) -> MUST NOT affect Tenant B's DB, cache_version, or warm cache!
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 2,
      expectedVersion: 2,
      draft: {
        slug: "layanan-utama",
        title: "Layanan Alpha REVISED",
        isHomepage: false,
        sections: [],
      },
    });
    const pubA2 = await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 2,
      expectedVersion: 3,
    });
    expect(pubA2.cacheVersion).toBe(pubA.cacheVersion + 1);

    // Tenant B cache_version is UNTOUCHED and its cache is STILL a HIT with 'Layanan Beta'
    expect(await getTenantCacheVersion(TENANT_B.id)).toBe(pubB.cacheVersion);

    let bRenderCalls = 0;
    const resBHit = await serveWithRevisionedEdgeCache({
      request: new Request(`https://${TENANT_B.host}/layanan-utama`),
      tenantId: TENANT_B.id,
      host: TENANT_B.host,
      cacheVersion: pubB.cacheVersion,
      cache,
      render: () => {
        bRenderCalls += 1;
        return new Response("SHOULD NOT RENDER", { status: 200 });
      },
    });
    expect(resBHit.cacheStatus).toBe("HIT");
    expect(await resBHit.response.text()).toBe("<h1>Layanan Beta</h1>");
    expect(bRenderCalls).toBe(0);

    // Tenant B DB still holds strictly Tenant B's page
    const pubBFromDb = await getPublishedResource(tenantDbB, {
      resourceType: "page",
      slug: "layanan-utama",
    });
    expect(pubBFromDb?.data.title).toBe("Layanan Beta");
  });
});
