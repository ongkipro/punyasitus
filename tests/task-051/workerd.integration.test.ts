import { env } from "cloudflare:workers";
import {
  SeoPolicyError,
  buildRobotsTxtPolicy,
  resolvePublishedResourceSeoDecision,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
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
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
  unpublishResourceAtomically,
} from "@punyasitus/db/publication/index";
import {
  clearHostResolutionCache,
  resolveTenantByHost,
  type HostResolutionResult,
} from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const BASE_TIME = 1_820_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_A = {
  id: "01JT051TENANTA000000000001",
  orgId: "org_t051_alpha",
  handle: "t051-alpha",
  name: "T051 Alpha Showroom",
  subdomain: "t051-alpha.situsku.click",
  customDomain: "www.t051-alpha.id",
} as const;

const TENANT_B = {
  id: "01JT051TENANTB000000000002",
  orgId: "org_t051_beta",
  handle: "t051-beta",
  name: "T051 Beta Trial Klinik",
  subdomain: "t051-beta.situsku.click",
} as const;

function toSeoTenantInput(
  resolved: Extract<HostResolutionResult, { readonly kind: "resolved" }>,
  verifiedTenantHosts?: readonly string[],
): VerifiedTenantHostInput {
  return {
    tenantHandle: resolved.tenant.handle,
    tenantStatus: resolved.tenant.effectiveStatus,
    operatorHold: resolved.tenant.operatorHold,
    primaryHost: resolved.primaryHost,
    primaryHostKind: resolved.primaryHostKind,
    primaryHostStatus: "active",
    primaryHostSslStatus: "active",
    primaryHostVerified: true,
    servingHost: resolved.host,
    verifiedTenantHosts,
  };
}

async function seedTenantsAndMigrateDos(): Promise<{
  readonly tenantDbA: D1Database;
  readonly tenantDbB: D1Database;
}> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  // Tenant A: Active paid tenant with verified custom primary domain + subdomain alias
  await pDb
    .insert(organizations)
    .values({
      id: TENANT_A.orgId,
      name: TENANT_A.name,
      slug: TENANT_A.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: TENANT_A.id,
      organizationId: TENANT_A.orgId,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active",
      paidThrough: new Date(BASE_TIME + 10 * DAY_MS),
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenantHosts)
    .values([
      {
        host: TENANT_A.customDomain,
        tenantId: TENANT_A.id,
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        host: TENANT_A.subdomain,
        tenantId: TENANT_A.id,
        kind: "subdomain",
        status: "active",
        sslStatus: "active",
        isPrimary: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  // Tenant B: Trial tenant on *.situsku.click only
  await pDb
    .insert(organizations)
    .values({
      id: TENANT_B.orgId,
      name: TENANT_B.name,
      slug: TENANT_B.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: TENANT_B.id,
      organizationId: TENANT_B.orgId,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      status: "trial",
      trialEndsAt: new Date(BASE_TIME + 7 * DAY_MS),
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
      host: TENANT_B.subdomain,
      tenantId: TENANT_B.id,
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
  const stubA = openTenantStoreStub(ns, TENANT_A.id);
  const stubB = openTenantStoreStub(ns, TENANT_B.id);

  const [migA, migB] = await Promise.all([
    orchestrateTenantMigration(env.PLATFORM_DB, stubA, TENANT_A.id, TENANT_MIGRATIONS),
    orchestrateTenantMigration(env.PLATFORM_DB, stubB, TENANT_B.id, TENANT_MIGRATIONS),
  ]);
  expect(migA.httpStatus).toBe(200);
  expect(migB.httpStatus).toBe(200);

  return {
    tenantDbA: createTenantDb(stubA),
    tenantDbB: createTenantDb(stubB),
  };
}

describe("TASK-051: Two-Tenant Published SEO Policy Integration on workerd", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const seeded = await seedTenantsAndMigrateDos();
    tenantDbA = seeded.tenantDbA;
    tenantDbB = seeded.tenantDbB;
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("enforces published-only SEO policy with @punyasitus/db/publication/index and prevents draft leakage", async () => {
    // Seed draft resources in Tenant A (pages, posts, vehicle offering, site_settings)
    await tenantDbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Alpha', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME)
      .run();

    await tenantDbA
      .prepare(
        `INSERT INTO posts (id, slug, title, excerpt, draft_body_json, status, version, created_at, updated_at)
         VALUES (1, 'panduan-mobil-bekas', 'Panduan Mobil Bekas', 'Tips beli mobil bekas.', '{"schemaVersion":1,"blocks":[]}', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME)
      .run();

    await tenantDbA
      .prepare(
        `INSERT INTO offerings (id, offering_type, slug, title, price_mode, price, cta_mode, status, version, created_at, updated_at)
         VALUES (1, 'vehicle', 'avanza-g-2024', 'Toyota Avanza G 2024', 'fixed', 245000000, 'whatsapp', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME)
      .run();

    await tenantDbA
      .prepare(
        `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
         VALUES (1, 'Alpha Showroom', 'Dealer Mobil Terpercaya', 'dealer', 1, 1, 'allow', 1, ?)`,
      )
      .bind(BASE_TIME)
      .run();

    const resolvedA = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.customDomain, {
      nowMs: BASE_TIME,
      bypassCache: true,
    });
    expect(resolvedA.kind).toBe("resolved");
    if (resolvedA.kind !== "resolved") return;
    const tenantInputA = toSeoTenantInput(resolvedA, [TENANT_A.customDomain, TENANT_A.subdomain]);

    // 1. Before publish: getPublishedResource returns null -> 404, noindex, nofollow, canonical=null
    const unpublishedPage = await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 });
    expect(unpublishedPage).toBeNull();
    const draftPageDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      resource: unpublishedPage,
      requestPathname: "/",
    });
    expect(draftPageDecision.httpStatus).toBe(404);
    expect(draftPageDecision.robotsMeta).toBe("noindex, nofollow");
    expect(draftPageDecision.canonical).toBeNull();
    expect(draftPageDecision.sitemapEligible).toBe(false);

    // 2. Publish homepage, post, vehicle offering, and site_settings (with aiTrainingPolicy="disallow")
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 1_000,
      draft: {
        slug: "beranda",
        title: "Beranda Alpha Showroom",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
        seo: { titleOverride: "Alpha Showroom Resmi" },
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      nowMs: BASE_TIME + 2_000,
    });

    await saveDraftResource(tenantDbA, {
      resourceType: "post",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 1_000,
      draft: {
        slug: "panduan-mobil-bekas",
        title: "Panduan Mobil Bekas",
        excerpt: "Tips lengkap cek unit mobil bekas.",
        body: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Periksa riwayat servis resmi kendaraan." }],
        },
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "post",
      resourceId: 1,
      expectedVersion: 2,
      nowMs: BASE_TIME + 2_000,
    });

    await saveDraftResource(tenantDbA, {
      resourceType: "offering",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 1_000,
      draft: {
        offeringType: "vehicle",
        slug: "avanza-g-2024",
        title: "Toyota Avanza G 2024",
        priceMode: "fixed",
        price: 245_000_000,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: {
          vehicleYear: 2024,
          transmission: "cvt",
          fuelType: "bensin",
        },
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "offering",
      resourceId: 1,
      expectedVersion: 2,
      nowMs: BASE_TIME + 2_000,
    });

    await saveDraftResource(tenantDbA, {
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 1_000,
      draft: {
        siteTitle: "Alpha Showroom",
        tagline: "Dealer Mobil Terpercaya",
        activeThemeId: "dealer",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "disallow",
        siteVisibility: "public",
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 2,
      nowMs: BASE_TIME + 2_000,
    });

    const [pubPage, pubPost, pubVehicle, pubSettings] = await Promise.all([
      getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 }),
      getPublishedResource(tenantDbA, { resourceType: "post", resourceId: 1 }),
      getPublishedResource(tenantDbA, { resourceType: "offering", resourceId: 1 }),
      getPublishedResource(tenantDbA, { resourceType: "site_settings", resourceId: 1 }),
    ]);

    expect(pubPage).not.toBeNull();
    expect(pubPost).not.toBeNull();
    expect(pubVehicle).not.toBeNull();
    expect(pubSettings).not.toBeNull();

    // Homepage canonical uses verified custom primary domain
    const homeDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: pubPage,
    });
    expect(homeDecision.httpStatus).toBe(200);
    expect(homeDecision.indexable).toBe(true);
    expect(homeDecision.canonical).toBe("https://www.t051-alpha.id/");
    expect(homeDecision.sitemapEligible).toBe(true);

    // Accessing homepage via /{slug} returns 308 -> /
    const homeSlugDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: pubPage,
      requestPathname: "/beranda",
    });
    expect(homeSlugDecision.httpStatus).toBe(308);
    expect(homeSlugDecision.redirectTarget).toBe("https://www.t051-alpha.id/");
    expect(homeSlugDecision.sitemapEligible).toBe(false);

    // Post with tracking query strips tracking params and keeps canonical clean
    const postDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: pubPost,
      query: "utm_source=chatgpt.com&fbclid=fb999",
    });
    expect(postDecision.httpStatus).toBe(200);
    expect(postDecision.indexable).toBe(true);
    expect(postDecision.canonical).toBe("https://www.t051-alpha.id/blog/panduan-mobil-bekas");
    expect(postDecision.sitemapEligible).toBe(true);

    // Vehicle detail canonical
    const vehicleDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: pubVehicle,
    });
    expect(vehicleDecision.canonical).toBe("https://www.t051-alpha.id/kendaraan/avanza-g-2024");
    expect(vehicleDecision.sitemapEligible).toBe(true);

    // Draft edit (setting noindex: true in draft ONLY) MUST NOT affect published SEO decision!
    await saveDraftResource(tenantDbA, {
      resourceType: "post",
      resourceId: 1,
      expectedVersion: 3,
      nowMs: BASE_TIME + 3_000,
      draft: {
        slug: "panduan-mobil-bekas",
        title: "UNPUBLISHED DRAFT TITLE",
        excerpt: "Draft note",
        body: {
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Draft edit." }],
        },
        seo: { noindex: true },
        draftNotes: "Do not leak",
      },
    });
    const stillPublishedPost = await getPublishedResource(tenantDbA, {
      resourceType: "post",
      resourceId: 1,
    });
    const stillIndexable = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: stillPublishedPost,
    });
    expect(stillIndexable.indexable).toBe(true);
    expect(stillIndexable.noindex).toBe(false);

    // Alias host request (t051-alpha.situsku.click) points canonical to custom primary and emits 301
    const resolvedAlias = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.subdomain, {
      nowMs: BASE_TIME + 4_000,
      bypassCache: true,
    });
    expect(resolvedAlias.kind).toBe("resolved");
    if (resolvedAlias.kind === "resolved") {
      const aliasDecision = resolvePublishedResourceSeoDecision({
        tenant: toSeoTenantInput(resolvedAlias, [TENANT_A.customDomain, TENANT_A.subdomain]),
        siteSettings: pubSettings?.data ?? null,
        resource: pubVehicle,
      });
      expect(aliasDecision.httpStatus).toBe(301);
      expect(aliasDecision.indexable).toBe(false);
      expect(aliasDecision.noindex).toBe(true);
      expect(aliasDecision.robotsMeta).toBe("noindex, follow");
      expect(aliasDecision.redirectTarget).toBe("https://www.t051-alpha.id/kendaraan/avanza-g-2024");
      expect(aliasDecision.canonical).toBe("https://www.t051-alpha.id/kendaraan/avanza-g-2024");
      expect(aliasDecision.sitemapEligible).toBe(false);
    }

    // Fail-closed custom domain: omitting verifiedTenantHosts or verification metadata falls back to *.situsku.click
    const omittedAllowlistDecision = resolvePublishedResourceSeoDecision({
      tenant: toSeoTenantInput(resolvedA, undefined),
      siteSettings: pubSettings?.data ?? null,
      resource: pubPage,
    });
    expect(omittedAllowlistDecision.canonical).toBe("https://t051-alpha.situsku.click/");

    const omittedVerifiedMetaDecision = resolvePublishedResourceSeoDecision({
      tenant: {
        ...tenantInputA,
        primaryHostStatus: undefined,
        primaryHostSslStatus: undefined,
        primaryHostVerified: undefined,
      },
      siteSettings: pubSettings?.data ?? null,
      resource: pubPage,
    });
    expect(omittedVerifiedMetaDecision.canonical).toBe("https://t051-alpha.situsku.click/");

    // Managed robots.txt respects published site_settings.aiTrainingPolicy = "disallow"
    const robotsA = buildRobotsTxtPolicy({
      tenant: tenantInputA,
      aiTrainingPolicy: pubSettings?.data.aiTrainingPolicy,
      siteVisibility: pubSettings?.data.siteVisibility,
    });
    expect(robotsA.httpStatus).toBe(200);
    expect(robotsA.sitemapUrl).toBe("https://www.t051-alpha.id/sitemap.xml");
    expect(robotsA.body).toContain("User-agent: OAI-SearchBot");
    expect(robotsA.body).toContain(
      "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: Applebot-Extended\nDisallow: /",
    );

    // Unpublish vehicle offering -> immediately 404, noindex, nofollow, canonical=null
    await unpublishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "offering",
      resourceId: 1,
      expectedVersion: 3,
      nowMs: BASE_TIME + 5_000,
    });
    const afterUnpub = await getPublishedResource(tenantDbA, { resourceType: "offering", resourceId: 1 });
    expect(afterUnpub).toBeNull();
    const unpubDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputA,
      siteSettings: pubSettings?.data ?? null,
      resource: afterUnpub,
      requestPathname: "/kendaraan/avanza-g-2024",
    });
    expect(unpubDecision.httpStatus).toBe(404);
    expect(unpubDecision.canonical).toBeNull();
    expect(unpubDecision.robotsMeta).toBe("noindex, nofollow");
    expect(unpubDecision.sitemapEligible).toBe(false);
  });

  it("enforces Tenant B trial noindex policy and blocks all cross-tenant canonical leakage", async () => {
    await tenantDbB
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Klinik Beta Trial', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_TIME, BASE_TIME)
      .run();

    await saveDraftResource(tenantDbB, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_TIME + 1_000,
      draft: {
        slug: "beranda",
        title: "Klinik Beta Trial",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
      tenantId: TENANT_B.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      nowMs: BASE_TIME + 2_000,
    });

    const pubPageB = await getPublishedResource(tenantDbB, { resourceType: "page", resourceId: 1 });
    expect(pubPageB).not.toBeNull();

    const resolvedB = await resolveTenantByHost(env.PLATFORM_DB, TENANT_B.subdomain, {
      nowMs: BASE_TIME + 2_500,
      bypassCache: true,
    });
    expect(resolvedB.kind).toBe("resolved");
    if (resolvedB.kind !== "resolved") return;
    expect(resolvedB.tenant.effectiveStatus).toBe("trial");

    const tenantInputB = toSeoTenantInput(resolvedB, [TENANT_B.subdomain]);

    // Trial tenant published homepage -> ALWAYS noindex, nofollow & sitemapEligible: false
    const trialDecision = resolvePublishedResourceSeoDecision({
      tenant: tenantInputB,
      resource: pubPageB,
    });
    expect(trialDecision.httpStatus).toBe(200);
    expect(trialDecision.indexable).toBe(false);
    expect(trialDecision.robotsMeta).toBe("noindex, nofollow");
    expect(trialDecision.xRobotsTag).toBe("noindex, nofollow");
    expect(trialDecision.canonical).toBe("https://t051-beta.situsku.click/");
    expect(trialDecision.sitemapEligible).toBe(false);

    // Trial robots.txt -> Disallow: / and NO Sitemap
    const robotsB = buildRobotsTxtPolicy({ tenant: tenantInputB });
    expect(robotsB.httpStatus).toBe(200);
    expect(robotsB.body).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsB.sitemapUrl).toBeNull();

    // Cross-tenant canonicalOverride pointing to Tenant A's custom domain MUST fail closed
    expect(() =>
      resolvePublishedResourceSeoDecision({
        tenant: tenantInputB,
        resource: pubPageB,
        canonicalOverride: `https://${TENANT_A.customDomain}/`,
      }),
    ).toThrowError(SeoPolicyError);

    // Passing Tenant A's subdomain or custom domain as Tenant B's primary host MUST fail closed
    expect(() =>
      resolveVerifiedCanonicalOrigin({
        ...tenantInputB,
        primaryHost: TENANT_A.subdomain,
      }),
    ).toThrowError(SeoPolicyError);

    expect(() =>
      resolveVerifiedCanonicalOrigin({
        ...tenantInputB,
        primaryHost: TENANT_A.customDomain,
      }),
    ).toThrowError(SeoPolicyError);
  });

  it("evaluates grace (H+1..H+3), locked (H+4..H+7), suspended (H+8+), and operatorHold transitions from authoritative PLATFORM_DB", async () => {
    const paidThroughMs = BASE_TIME + 10 * DAY_MS;
    const pubPageA = await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 });
    expect(pubPageA).not.toBeNull();

    const verifiedHostsA = [TENANT_A.customDomain, TENANT_A.subdomain] as const;

    // 1. Grace window (H+2 after paidThrough): live & indexable
    const resolvedGrace = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.customDomain, {
      nowMs: paidThroughMs + 2 * DAY_MS,
      bypassCache: true,
    });
    expect(resolvedGrace.kind).toBe("resolved");
    if (resolvedGrace.kind !== "resolved") return;
    expect(resolvedGrace.tenant.effectiveStatus).toBe("grace");

    const graceDecision = resolvePublishedResourceSeoDecision({
      tenant: toSeoTenantInput(resolvedGrace, verifiedHostsA),
      resource: pubPageA,
    });
    expect(graceDecision.httpStatus).toBe(200);
    expect(graceDecision.indexable).toBe(true);
    expect(graceDecision.canonical).toBe("https://www.t051-alpha.id/");
    expect(graceDecision.sitemapEligible).toBe(true);

    // 2. Locked window (H+5 after paidThrough): STILL live & indexable to protect client SEO!
    const resolvedLocked = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.customDomain, {
      nowMs: paidThroughMs + 5 * DAY_MS,
      bypassCache: true,
    });
    expect(resolvedLocked.kind).toBe("resolved");
    if (resolvedLocked.kind !== "resolved") return;
    expect(resolvedLocked.tenant.effectiveStatus).toBe("locked");

    const lockedDecision = resolvePublishedResourceSeoDecision({
      tenant: toSeoTenantInput(resolvedLocked, verifiedHostsA),
      resource: pubPageA,
    });
    expect(lockedDecision.httpStatus).toBe(200);
    expect(lockedDecision.indexable).toBe(true);
    expect(lockedDecision.canonical).toBe("https://www.t051-alpha.id/");
    expect(lockedDecision.sitemapEligible).toBe(true);

    const lockedRobots = buildRobotsTxtPolicy({
      tenant: toSeoTenantInput(resolvedLocked, verifiedHostsA),
    });
    expect(lockedRobots.httpStatus).toBe(200);
    expect(lockedRobots.sitemapUrl).toBe("https://www.t051-alpha.id/sitemap.xml");

    // 3. Suspended window (H+8 after paidThrough): 503, noindex, nofollow, canonical=null
    const resolvedSuspended = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.customDomain, {
      nowMs: paidThroughMs + 8 * DAY_MS,
      bypassCache: true,
    });
    expect(resolvedSuspended.kind).toBe("resolved");
    if (resolvedSuspended.kind !== "resolved") return;
    expect(resolvedSuspended.tenant.effectiveStatus).toBe("suspended");

    const suspendedDecision = resolvePublishedResourceSeoDecision({
      tenant: toSeoTenantInput(resolvedSuspended, verifiedHostsA),
      resource: pubPageA,
    });
    expect(suspendedDecision.httpStatus).toBe(503);
    expect(suspendedDecision.indexable).toBe(false);
    expect(suspendedDecision.robotsMeta).toBe("noindex, nofollow");
    expect(suspendedDecision.canonical).toBeNull();
    expect(suspendedDecision.sitemapEligible).toBe(false);

    const suspendedRobots = buildRobotsTxtPolicy({
      tenant: toSeoTenantInput(resolvedSuspended, verifiedHostsA),
    });
    expect(suspendedRobots.httpStatus).toBe(503);
    expect(suspendedRobots.sitemapUrl).toBeNull();
    expect(suspendedRobots.body).toBe("User-agent: *\nDisallow: /\n");

    // 4. Operator hold during active paid period forces suspended (503, canonical=null)
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb
      .update(tenants)
      .set({ operatorHold: true, updatedAt: new Date(BASE_TIME + 6_000) })
      .where(eq(tenants.id, TENANT_A.id));

    const resolvedHold = await resolveTenantByHost(env.PLATFORM_DB, TENANT_A.customDomain, {
      nowMs: BASE_TIME + 7_000, // well within active paidThrough!
      bypassCache: true,
    });
    expect(resolvedHold.kind).toBe("resolved");
    if (resolvedHold.kind === "resolved") {
      expect(resolvedHold.tenant.effectiveStatus).toBe("suspended");
      const holdDecision = resolvePublishedSeoDecision({
        routeKind: "homepage",
        pathname: "/",
        tenant: toSeoTenantInput(resolvedHold, verifiedHostsA),
      });
      expect(holdDecision.httpStatus).toBe(503);
      expect(holdDecision.canonical).toBeNull();
      expect(holdDecision.sitemapEligible).toBe(false);
    }

    // Restore operatorHold = false cleanly
    await pDb
      .update(tenants)
      .set({ operatorHold: false, updatedAt: new Date(BASE_TIME + 8_000) })
      .where(eq(tenants.id, TENANT_A.id));
  });
});
