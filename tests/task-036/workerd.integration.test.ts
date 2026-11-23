import { env } from "cloudflare:workers";
import {
  createCatalogCategory,
  createCatalogOffering,
  publishCatalogOffering,
  softDeleteCatalogOffering,
  unpublishCatalogOffering,
  updateCatalogOffering,
} from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  createPage,
  publishPage,
  trashPage,
  unpublishPage,
  updatePage,
} from "@punyasitus/db/pages/index";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  createPost,
  publishPost,
  trashPost,
  updatePost,
} from "@punyasitus/db/posts/index";
import { publishResourceAtomically, saveDraftResource } from "@punyasitus/db/publication/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  containsNumericIdPathSegment,
  resolveBlogDetailRoute,
  resolveBlogListingRoute,
  resolveOfferingDetailRoute,
  resolveOfferingListingRoute,
  resolvePublicPageRoute,
  type PublicRouteDeps,
} from "../../apps/web/src/core/public-routes.ts";

const BASE_TIME = 1_850_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_ALPHA = {
  id: "01JT036ALPHA00000000000001",
  orgId: "org_t036_alpha",
  handle: "t036-alpha",
  name: "PT Alpha Konstruksi & Armada",
  subdomain: "t036-alpha.situsku.click",
  customDomain: "www.t036-alpha.id",
} as const;

const TENANT_BETA = {
  id: "01JT036BETA000000000000002",
  orgId: "org_t036_beta",
  handle: "t036-beta",
  name: "Beta Wisata Nusantara",
  subdomain: "t036-beta.situsku.click",
} as const;

const TENANT_SUSPENDED = {
  id: "01JT036SUSP000000000000003",
  orgId: "org_t036_suspended",
  handle: "t036-suspended",
  name: "Suspended Biz",
  subdomain: "t036-suspended.situsku.click",
} as const;

const TENANT_TRIAL = {
  id: "01JT036TRIAL00000000000004",
  orgId: "org_t036_trial",
  handle: "t036-trial",
  name: "Trial Biz",
  subdomain: "t036-trial.situsku.click",
} as const;

function makeDeps(): PublicRouteDeps {
  return {
    platformDb: env.PLATFORM_DB,
    tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    platformDomain: "punyasitus.com",
    saasZone: "situsku.click",
    nowMs: BASE_TIME,
    bypassHostCache: true,
  };
}

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "active" | "trial" | "suspended";
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
      status: spec.status,
      paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
      trialEndsAt: spec.status === "trial" ? new Date(BASE_TIME + 7 * DAY_MS) : null,
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
          host: spec.customDomain,
          tenantId: spec.id,
          kind: "custom" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: false,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [
        {
          host: spec.subdomain,
          tenantId: spec.id,
          kind: "subdomain" as const,
          status: "active" as const,
          sslStatus: "active" as const,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

  for (const hr of hostRows) {
    await pDb.insert(tenantHosts).values(hr).onConflictDoNothing();
  }

  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(ns, spec.id);
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  const tenantDb = createTenantDb(stub);

  await tenantDb
    .prepare(
      `INSERT OR IGNORE INTO site_settings (
         id, site_title, tagline, timezone, locale, active_theme_id,
         blog_enabled, catalog_enabled, ai_training_policy, version, updated_at
       ) VALUES (1, ?, ?, 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', 1, ?)`,
    )
    .bind(spec.name, `Solusi Resmi ${spec.name}`, BASE_TIME)
    .run();

  await tenantDb
    .prepare(
      `INSERT OR IGNORE INTO business_profile (
         id, business_name, business_category, description,
         address, city, province, whatsapp_e164, phone, email,
         weekday_hours_json, version, updated_at
       ) VALUES (1, ?, 'LocalBusiness', ?, 'Jl. Sudirman No. 10', 'Jakarta Selatan', 'DKI Jakarta', '6281234567890', '6281234567890', ?, 'Senin–Jumat 08.00–17.00 WIB', 1, ?)`,
    )
    .bind(spec.name, `Profil resmi ${spec.name}`, `halo@${spec.handle}.id`, BASE_TIME)
    .run();

  await saveDraftResource(tenantDb, {
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: BASE_TIME,
    draft: {
      siteTitle: spec.name,
      tagline: `Solusi Resmi ${spec.name}`,
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      activeThemeId: "compro",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public",
      aiTrainingPolicy: "allow",
    },
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId: spec.id,
    resourceType: "site_settings",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: BASE_TIME + 1,
  });

  await saveDraftResource(tenantDb, {
    resourceType: "business_profile",
    resourceId: 1,
    expectedVersion: 1,
    nowMs: BASE_TIME,
    draft: {
      businessName: spec.name,
      businessCategory: "LocalBusiness",
      description: `Profil resmi ${spec.name}`,
      address: "Jl. Sudirman No. 10",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      whatsappE164: "6281234567890",
      phone: "6281234567890",
      email: `halo@${spec.handle}.id`,
      weekdayHours: "Senin–Jumat 08.00–17.00 WIB",
      socialLinks: [],
    },
  });
  await publishResourceAtomically(env.PLATFORM_DB, tenantDb, {
    tenantId: spec.id,
    resourceType: "business_profile",
    resourceId: 1,
    expectedVersion: 2,
    nowMs: BASE_TIME + 2,
  });

  return tenantDb;
}

describe("TASK-036 workerd integration — two-tenant public routes, 308 former-slugs, pagination & isolation", () => {
  let alphaDb: D1Database;
  let betaDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    alphaDb = await seedTenant({ ...TENANT_ALPHA, status: "active" });
    betaDb = await seedTenant({ ...TENANT_BETA, status: "active" });
    await seedTenant({ ...TENANT_SUSPENDED, status: "suspended" });
    await seedTenant({ ...TENANT_TRIAL, status: "trial" });

    // --- Seed TENANT ALPHA ---
    // 1. Homepage (slug: "beranda-utama")
    const alphaHome = await createPage(alphaDb, {
      title: "Beranda Alpha",
      slug: "beranda-utama",
      isHomepage: true,
      layoutMode: "standard",
      sections: [
        {
          id: "hero-home",
          kind: "hero",
          heading: "Konstruksi & Armada Profesional Alpha",
          subheading: "Layanan terpercaya untuk kebutuhan bisnis di Indonesia.",
          bodyHtml: null,
          ctaLabel: "Lihat Layanan",
          ctaHref: "/layanan",
        },
        {
          id: "services-home",
          kind: "services_grid",
          heading: "Layanan Unggulan",
          subheading: "Solusi terukur untuk operasional perusahaan.",
          bodyHtml: null,
          ctaLabel: "Semua Layanan",
          ctaHref: "/layanan",
        },
      ],
      nowMs: BASE_TIME + 10,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaHome.id,
      expectedVersion: alphaHome.version,
      nowMs: BASE_TIME + 11,
    });

    // 2. Published static page in `focused` mode + slug rename chain (a -> b -> c)
    const alphaPromo = await createPage(alphaDb, {
      title: "Penawaran Khusus Konstruksi",
      slug: "promo-lama-a",
      layoutMode: "focused",
      sections: [
        {
          id: "hero-promo",
          kind: "hero",
          heading: "Konsultasi Proyek Tanpa Ribet",
          subheading: "Halaman fokus tanpa menu header/footer.",
          bodyHtml: null,
        },
      ],
      nowMs: BASE_TIME + 12,
    });
    const pubPromo = await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaPromo.id,
      expectedVersion: alphaPromo.version,
      nowMs: BASE_TIME + 13,
    });
    const renamedB = await updatePage(
      alphaDb,
      {
        pageId: alphaPromo.id,
        expectedVersion: pubPromo.page.version,
        slug: "promo-tengah-b",
        confirmSlugChange: true,
        nowMs: BASE_TIME + 14,
      },
      { platformDb: env.PLATFORM_DB, tenantId: TENANT_ALPHA.id },
    );
    const pubB = await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaPromo.id,
      expectedVersion: renamedB.version,
      nowMs: BASE_TIME + 15,
    });
    const renamedC = await updatePage(
      alphaDb,
      {
        pageId: alphaPromo.id,
        expectedVersion: pubB.page.version,
        slug: "konsultasi-proyek",
        confirmSlugChange: true,
        nowMs: BASE_TIME + 16,
      },
      { platformDb: env.PLATFORM_DB, tenantId: TENANT_ALPHA.id },
    );
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: alphaPromo.id,
      expectedVersion: renamedC.version,
      nowMs: BASE_TIME + 17,
    });

    // 3. Draft-only page (must NEVER be publicly visible)
    await createPage(alphaDb, {
      title: "Halaman Rahasia Draf",
      slug: "draf-rahasia",
      nowMs: BASE_TIME + 18,
    });

    // 4. Published blog posts (4 posts for pagination testing with pageSize=2 + 1 draft)
    for (let i = 1; i <= 4; i += 1) {
      const p = await createPost(alphaDb, {
        title: `Panduan Bisnis Alpha Bagian ${i}`,
        slug: `panduan-bisnis-${i}`,
        excerpt: `Ringkasan praktis panduan bisnis bagian ${i} untuk pemilik usaha.`,
        bodyHtml: `<h2>Langkah Utama ${i}</h2><p>Penjelasan terstruktur untuk artikel ke-${i} pada PT Alpha.</p>`,
        authorName: "Raka Pratama",
        showToc: true,
        nowMs: BASE_TIME + 20 + i * 2,
      });
      await publishPost(env.PLATFORM_DB, alphaDb, {
        tenantId: TENANT_ALPHA.id,
        postId: p.id,
        expectedVersion: p.version,
        nowMs: BASE_TIME + 21 + i * 2,
      });
    }
    await createPost(alphaDb, {
      title: "Artikel Draf Belum Terbit",
      slug: "artikel-draf-rahasia",
      bodyHtml: "<p>Draf internal</p>",
      nowMs: BASE_TIME + 35,
    });

    // 5. All 4 offering types on Alpha
    const svc = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "service",
        title: "Audit Operasional B2B",
        slug: "audit-operasional",
        summary: "Evaluasi alur kerja dan efisiensi operasional perusahaan.",
        description: "Layanan audit menyeluruh dengan laporan rekomendasi terukur.",
        priceMode: "from",
        price: 7_500_000,
        ctaMode: "whatsapp",
        attributes: {
          duration: "14 hari kerja",
          serviceMode: "hybrid",
          serviceArea: "Jabodetabek & Nasional",
          deliverables: ["Laporan temuan", "Peta perbaikan SOP"],
          serviceSteps: ["Diskusi awal", "Observasi lapangan", "Presentasi hasil"],
          tiers: [{ name: "Paket Dasar", summary: "1 divisi", price: 7_500_000 }],
        },
      },
      { nowMs: BASE_TIME + 40 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: svc.id,
      expectedVersion: svc.version,
      nowMs: BASE_TIME + 41,
    });

    const prod = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "product",
        title: "Paket Peralatan Kantor",
        slug: "paket-kantor",
        summary: "Set perlengkapan kerja ergonomis untuk tim operasional.",
        priceMode: "fixed",
        price: 3_250_000,
        originalAmount: 3_750_000,
        badge: "Promo",
        ctaMode: "external_link",
        externalUrl: "https://tokopedia.com/alpha/paket-kantor",
        attributes: {
          brand: "AlphaOffice",
          sku: "AO-PK-01",
          stockStatus: "ready",
          specs: [{ label: "Garansi", value: "1 tahun resmi" }],
        },
      },
      { nowMs: BASE_TIME + 42 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: prod.id,
      expectedVersion: prod.version,
      nowMs: BASE_TIME + 43,
    });

    const veh = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "vehicle",
        title: "SUV Operasional 2023",
        slug: "suv-2023",
        summary: "Unit SUV terawat siap pakai untuk kebutuhan dinas.",
        priceMode: "fixed",
        price: 320_000_000,
        negotiable: true,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: {
          brand: "Toyota",
          model: "Fortuner",
          year: 2023,
          condition: "used",
          transmission: "automatic",
          fuelType: "diesel",
          bodyType: "suv",
          mileageKm: 28_500,
          location: "Jakarta Selatan",
          unitStatus: "available",
          creditEstimateEnabled: true,
          creditEstimateConfig: {
            annualFlatRateBps: 550,
            dpPercents: [20, 30],
            tenorMonths: [36, 48],
          },
        },
      },
      { nowMs: BASE_TIME + 44 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: veh.id,
      expectedVersion: veh.version,
      nowMs: BASE_TIME + 45,
    });

    // Draft offering (never visible publicly)
    await createCatalogOffering(
      alphaDb,
      {
        offeringType: "service",
        title: "Layanan Draf Internal",
        slug: "layanan-draf-rahasia",
        priceMode: "on_request",
        ctaMode: "whatsapp",
      },
      { nowMs: BASE_TIME + 46 },
    );

    // --- Seed TENANT BETA (Tour agency, completely isolated DO) ---
    const betaTour = await createCatalogOffering(
      betaDb,
      {
        offeringType: "tour",
        title: "Paket Wisata Jogja 3H2M",
        slug: "jogja-3h2m",
        summary: "Rencana perjalanan budaya dan kuliner Yogyakarta bersama pemandu berlisensi.",
        priceMode: "fixed",
        price: 2_650_000,
        ctaMode: "book",
        attributes: {
          destination: "Yogyakarta",
          durationDays: 3,
          durationNights: 2,
          departureCity: "Jakarta",
          hotel: "Hotel Bintang 4 Pusat Kota",
          inclusions: ["Transportasi AC", "Hotel 2 malam", "Tiket masuk wisata"],
          exclusions: ["Pengeluaran pribadi"],
          itinerary: [
            { day: 1, title: "Kedatangan & Malioboro", description: "Penjemputan di stasiun dan wisata malam." },
            { day: 2, title: "Candi Borobudur & Merapi", description: "Kunjungan warisan budaya dan lava tour." },
          ],
          departures: [{ departureDate: "2027-02-14", status: "open", note: "Keberangkatan grup" }],
        },
      },
      { nowMs: BASE_TIME + 50 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      offeringId: betaTour.id,
      expectedVersion: betaTour.version,
      nowMs: BASE_TIME + 51,
    });

    const betaPost = await createPost(betaDb, {
      title: "Tips Persiapan Perjalanan Grup Beta",
      slug: "tips-perjalanan-beta",
      excerpt: "Checklist praktis sebelum berangkat rombongan.",
      bodyHtml: "<p>Siapkan dokumen perjalanan dan jadwal keberangkatan sejak jauh hari.</p>",
      authorName: "Dina Kartika",
      nowMs: BASE_TIME + 52,
    });
    await publishPost(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      postId: betaPost.id,
      expectedVersion: betaPost.version,
      nowMs: BASE_TIME + 53,
    });
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("renders published homepage, focused page, 308 homepage-slug, and single-hop 308 former-slugs", async () => {
    const deps = makeDeps();

    // Homepage on primary custom domain
    const homeRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/`),
      deps,
      "",
    );
    expect(homeRes.kind).toBe("page");
    if (homeRes.kind !== "page") return;
    expect(homeRes.http.status).toBe(200);
    expect(homeRes.isHomepage).toBe(true);
    expect(homeRes.seoMetadata.canonical).toBe(`https://${TENANT_ALPHA.customDomain}/`);
    expect(homeRes.schemaGraph?.["@graph"].some((n) => n["@type"] === "WebSite")).toBe(true);
    expect(
      homeRes.schemaGraph?.["@graph"].some(
        (n) => n["@type"] === "LocalBusiness" || n["@type"] === "Organization",
      ),
    ).toBe(true);
    expect(homeRes.fallbackOfferings.length).toBeGreaterThanOrEqual(3);
    expect(homeRes.fallbackPosts.length).toBe(4);

    // Homepage slug `/beranda-utama` -> ONE 308 directly to `/`
    const homeSlugRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/beranda-utama`),
      deps,
      "beranda-utama",
    );
    expect(homeSlugRes.kind).toBe("response");
    if (homeSlugRes.kind === "response") {
      expect(homeSlugRes.response.status).toBe(308);
      expect(homeSlugRes.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/`,
      );
    }

    // Former slug chain A -> B -> C resolves in ONE single 308 hop straight to C!
    for (const former of ["promo-lama-a", "promo-tengah-b"]) {
      const r = await resolvePublicPageRoute(
        new Request(`https://${TENANT_ALPHA.customDomain}/${former}`),
        deps,
        former,
      );
      expect(r.kind).toBe("response");
      if (r.kind === "response") {
        expect(r.response.status).toBe(308);
        expect(r.response.headers.get("Location")).toBe(
          `https://${TENANT_ALPHA.customDomain}/konsultasi-proyek`,
        );
      }
    }

    // Current slug renders 200 in `focused` mode
    const currentRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/konsultasi-proyek`),
      deps,
      "konsultasi-proyek",
    );
    expect(currentRes.kind).toBe("page");
    if (currentRes.kind === "page") {
      expect(currentRes.layoutMode).toBe("focused");
      expect(currentRes.seoMetadata.canonical).toBe(
        `https://${TENANT_ALPHA.customDomain}/konsultasi-proyek`,
      );
    }

    // Draft page returns branded 404 with noindex and NO canonical
    const draftRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/draf-rahasia`),
      deps,
      "draf-rahasia",
    );
    expect(draftRes.kind).toBe("not_found");
    if (draftRes.kind === "not_found") {
      expect(draftRes.http.status).toBe(404);
      expect(draftRes.seoMetadata.canonical).toBeNull();
      expect(draftRes.seoMetadata.robots).toBe("noindex, nofollow");
    }

    // Alias subdomain redirects 301 to custom primary domain
    const aliasRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.subdomain}/konsultasi-proyek`),
      deps,
      "konsultasi-proyek",
    );
    expect(aliasRes.kind).toBe("response");
    if (aliasRes.kind === "response") {
      expect(aliasRes.response.status).toBe(301);
      expect(aliasRes.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/konsultasi-proyek`,
      );
    }
  });

  it("handles blog pagination (?page=1 -> 301, ?page=2 -> 200 with prev/next, out-of-range -> 404), article detail, and disabled blog 404", async () => {
    const deps = makeDeps();

    // ?page=1 -> 301 to /blog
    const p1Redirect = await resolveBlogListingRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog?page=1`),
      deps,
      { pageSize: 2 },
    );
    expect(p1Redirect.kind).toBe("response");
    if (p1Redirect.kind === "response") {
      expect(p1Redirect.response.status).toBe(301);
      expect(p1Redirect.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/blog`,
      );
    }

    // Page 2 -> 200 with bounded 2 items, canonical ?page=2, prevUrl = /blog, nextUrl = null
    const p2Res = await resolveBlogListingRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog?page=2`),
      deps,
      { pageSize: 2 },
    );
    expect(p2Res.kind).toBe("blog_listing");
    if (p2Res.kind !== "blog_listing") return;
    expect(p2Res.items).toHaveLength(2);
    expect(p2Res.pagination.totalItems).toBe(4);
    expect(p2Res.pagination.totalPages).toBe(2);
    expect(p2Res.seoMetadata.canonical).toBe(`https://${TENANT_ALPHA.customDomain}/blog?page=2`);
    expect(p2Res.seoMetadata.prevUrl).toBe(`https://${TENANT_ALPHA.customDomain}/blog`);
    expect(p2Res.seoMetadata.nextUrl).toBeNull();
    for (const item of p2Res.items) {
      expect(containsNumericIdPathSegment(item.href)).toBe(false);
    }

    // Out-of-range ?page=3 -> 404
    const p3Res = await resolveBlogListingRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog?page=3`),
      deps,
      { pageSize: 2 },
    );
    expect(p3Res.kind).toBe("not_found");

    // Article detail renders sanitized HTML, TOC, reading time, author, Article JSON-LD
    const detailRes = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/panduan-bisnis-1`),
      deps,
      "panduan-bisnis-1",
    );
    expect(detailRes.kind).toBe("blog_detail");
    if (detailRes.kind === "blog_detail") {
      expect(detailRes.post.authorName).toBe("Raka Pratama");
      expect(detailRes.post.readingTimeMinutes).toBeGreaterThanOrEqual(1);
      expect(detailRes.post.showToc).toBe(true);
      expect(detailRes.post.toc.length).toBeGreaterThanOrEqual(1);
      expect(detailRes.seoMetadata.og.type).toBe("article");
      expect(detailRes.seoMetadata.canonical).toBe(
        `https://${TENANT_ALPHA.customDomain}/blog/panduan-bisnis-1`,
      );
      expect(
        detailRes.schemaGraph?.["@graph"].some(
          (n) => n["@type"] === "Article" || n["@type"] === "BlogPosting",
        ),
      ).toBe(true);
    }

    // Draft article -> 404
    const draftPostRes = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/artikel-draf-rahasia`),
      deps,
      "artikel-draf-rahasia",
    );
    expect(draftPostRes.kind).toBe("not_found");
  });

  it("renders all 4 typed offerings with zero numeric IDs, credit table, and strict two-tenant isolation", async () => {
    const deps = makeDeps();

    // Alpha: service, product, vehicle listings & details
    const svcDetail = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/layanan/audit-operasional`),
      deps,
      "service",
      "audit-operasional",
    );
    expect(svcDetail.kind).toBe("offering_detail");
    if (svcDetail.kind === "offering_detail") {
      expect(svcDetail.offering.priceText).toBe("Mulai Rp 7.500.000");
      expect(svcDetail.offering.cta.isWhatsApp).toBe(true);
      expect(containsNumericIdPathSegment(svcDetail.offering.href)).toBe(false);
      expect(svcDetail.schemaGraph?.["@graph"].some((n) => n["@type"] === "Service")).toBe(true);
    }

    const prodDetail = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/produk/paket-kantor`),
      deps,
      "product",
      "paket-kantor",
    );
    expect(prodDetail.kind).toBe("offering_detail");
    if (prodDetail.kind === "offering_detail") {
      expect(prodDetail.offering.cta.href).toBe("https://tokopedia.com/alpha/paket-kantor");
      expect(prodDetail.schemaGraph?.["@graph"].some((n) => n["@type"] === "Product")).toBe(true);
    }

    const vehDetail = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/kendaraan/suv-2023`),
      deps,
      "vehicle",
      "suv-2023",
    );
    expect(vehDetail.kind).toBe("offering_detail");
    if (vehDetail.kind === "offering_detail") {
      expect(vehDetail.offering.vehicleCreditRows).toHaveLength(2);
      expect(vehDetail.offering.unitStatusLabel).toBe("Tersedia");
      expect(
        vehDetail.schemaGraph?.["@graph"].some(
          (n) => n["@type"] === "Vehicle" || n["@type"] === "Car",
        ),
      ).toBe(true);
    }

    // Alpha has 0 tours -> clean empty state (200, noindex)
    const alphaTourEmpty = await resolveOfferingListingRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/tour`),
      deps,
      "tour",
    );
    expect(alphaTourEmpty.kind).toBe("offering_listing");
    if (alphaTourEmpty.kind === "offering_listing") {
      expect(alphaTourEmpty.http.status).toBe(200);
      expect(alphaTourEmpty.items).toHaveLength(0);
      expect(alphaTourEmpty.seoMetadata.robots).toContain("noindex");
    }

    // Beta: tour detail works on Beta host
    const betaTourRes = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/tour/jogja-3h2m`),
      deps,
      "tour",
      "jogja-3h2m",
    );
    expect(betaTourRes.kind).toBe("offering_detail");
    if (betaTourRes.kind === "offering_detail") {
      expect(betaTourRes.offering.tourAttributes?.destination).toBe("Yogyakarta");
      expect(betaTourRes.schemaGraph?.["@graph"].some((n) => n["@type"] === "TouristTrip")).toBe(
        true,
      );
    }

    // Cross-tenant isolation: Alpha slugs MUST 404 on Beta, and Beta slugs MUST 404 on Alpha!
    const leak1 = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/layanan/audit-operasional`),
      deps,
      "service",
      "audit-operasional",
    );
    expect(leak1.kind).toBe("not_found");

    const leak2 = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/tour/jogja-3h2m`),
      deps,
      "tour",
      "jogja-3h2m",
    );
    expect(leak2.kind).toBe("not_found");

    const leak3 = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/tips-perjalanan-beta`),
      deps,
      "tips-perjalanan-beta",
    );
    expect(leak3.kind).toBe("not_found");

    // Suspended tenant -> 503; Trial tenant -> 200 with noindex, nofollow
    const suspRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_SUSPENDED.subdomain}/`),
      deps,
      "",
    );
    expect(suspRes.kind).toBe("response");
    if (suspRes.kind === "response") {
      expect(suspRes.response.status).toBe(503);
    }

    const trialRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_TRIAL.subdomain}/`),
      deps,
      "",
    );
    expect(trialRes.kind).toBe("page");
    if (trialRes.kind === "page") {
      expect(trialRes.seoMetadata.robots).toBe("noindex, nofollow");
      expect(trialRes.http.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
    }
  });

  it("returns 404 (NEVER 308) for former slugs after unpublish or trash across pages, posts, and offerings, and respects blogEnabled=false", async () => {
    const deps = makeDeps();

    // 1. Page former slug -> 308 while published, 404 after unpublish
    const p = await createPage(betaDb, {
      title: "Profil Sementara",
      slug: "profil-v1",
      sections: [
        {
          id: "rt-1",
          kind: "rich_text",
          heading: "Profil",
          subheading: null,
          bodyHtml: "<p>Isi profil.</p>",
        },
      ],
      nowMs: BASE_TIME + 100,
    });
    const pubP = await publishPage(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      pageId: p.id,
      expectedVersion: p.version,
      nowMs: BASE_TIME + 101,
    });
    const updP = await updatePage(
      betaDb,
      {
        pageId: p.id,
        expectedVersion: pubP.page.version,
        slug: "profil-v2",
        confirmSlugChange: true,
        nowMs: BASE_TIME + 102,
      },
      { platformDb: env.PLATFORM_DB, tenantId: TENANT_BETA.id },
    );
    const pubP2 = await publishPage(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      pageId: p.id,
      expectedVersion: updP.version,
      nowMs: BASE_TIME + 103,
    });

    const beforeUnpub = await resolvePublicPageRoute(
      new Request(`https://${TENANT_BETA.subdomain}/profil-v1`),
      deps,
      "profil-v1",
    );
    expect(beforeUnpub.kind).toBe("response");
    if (beforeUnpub.kind === "response") {
      expect(beforeUnpub.response.status).toBe(308);
      expect(beforeUnpub.response.headers.get("Location")).toBe(
        `https://${TENANT_BETA.subdomain}/profil-v2`,
      );
    }

    const unpubP = await unpublishPage(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      pageId: p.id,
      expectedVersion: pubP2.page.version,
      nowMs: BASE_TIME + 104,
    });

    const afterUnpubFormer = await resolvePublicPageRoute(
      new Request(`https://${TENANT_BETA.subdomain}/profil-v1`),
      deps,
      "profil-v1",
    );
    expect(afterUnpubFormer.kind).toBe("not_found");

    // 2. Post former slug -> 308 while published, 404 after trash
    const post = await createPost(betaDb, {
      title: "Panduan Wisata Lama",
      slug: "wisata-v1",
      bodyHtml: "<p>Isi panduan wisata.</p>",
      nowMs: BASE_TIME + 110,
    });
    const pubPost1 = await publishPost(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      postId: post.id,
      expectedVersion: post.version,
      nowMs: BASE_TIME + 111,
    });
    const updPost = await updatePost(
      betaDb,
      {
        postId: post.id,
        expectedVersion: pubPost1.post.version,
        slug: "wisata-v2",
        confirmSlugChange: true,
        nowMs: BASE_TIME + 112,
      },
      { platformDb: env.PLATFORM_DB, tenantId: TENANT_BETA.id },
    );
    const pubPost2 = await publishPost(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      postId: post.id,
      expectedVersion: updPost.version,
      nowMs: BASE_TIME + 113,
    });

    const postFormerBefore = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/blog/wisata-v1`),
      deps,
      "wisata-v1",
    );
    expect(postFormerBefore.kind).toBe("response");
    if (postFormerBefore.kind === "response") {
      expect(postFormerBefore.response.status).toBe(308);
      expect(postFormerBefore.response.headers.get("Location")).toBe(
        `https://${TENANT_BETA.subdomain}/blog/wisata-v2`,
      );
    }

    await trashPost(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      postId: post.id,
      expectedVersion: pubPost2.post.version,
      nowMs: BASE_TIME + 114,
    });
    const postFormerAfterTrash = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/blog/wisata-v1`),
      deps,
      "wisata-v1",
    );
    expect(postFormerAfterTrash.kind).toBe("not_found");

    // 3. Offering former slug -> 308 while published, 404 after unpublish/trash
    const off = await createCatalogOffering(
      betaDb,
      {
        offeringType: "service",
        title: "Jasa Visa Wisata",
        slug: "visa-v1",
        priceMode: "fixed",
        price: 1_250_000,
        ctaMode: "whatsapp",
      },
      { nowMs: BASE_TIME + 120 },
    );
    const pubOff1 = await publishCatalogOffering(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      offeringId: off.id,
      expectedVersion: off.version,
      nowMs: BASE_TIME + 121,
    });
    const updOff = await updateCatalogOffering(
      betaDb,
      off.id,
      { slug: "visa-v2" },
      { expectedVersion: pubOff1.offering.version, nowMs: BASE_TIME + 122 },
    );
    const pubOff2 = await publishCatalogOffering(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      offeringId: off.id,
      expectedVersion: updOff.version,
      nowMs: BASE_TIME + 123,
    });

    const offFormerBefore = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/layanan/visa-v1`),
      deps,
      "service",
      "visa-v1",
    );
    expect(offFormerBefore.kind).toBe("response");
    if (offFormerBefore.kind === "response") {
      expect(offFormerBefore.response.status).toBe(308);
      expect(offFormerBefore.response.headers.get("Location")).toBe(
        `https://${TENANT_BETA.subdomain}/layanan/visa-v2`,
      );
    }

    const unpubOff = await unpublishCatalogOffering(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      offeringId: off.id,
      expectedVersion: pubOff2.offering.version,
      nowMs: BASE_TIME + 124,
    });
    const offFormerAfterUnpub = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/layanan/visa-v1`),
      deps,
      "service",
      "visa-v1",
    );
    expect(offFormerAfterUnpub.kind).toBe("not_found");

    // Cleanly trash too
    await softDeleteCatalogOffering(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      offeringId: off.id,
      expectedVersion: unpubOff.offering.version,
      nowMs: BASE_TIME + 125,
    });
    await trashPage(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      pageId: p.id,
      expectedVersion: unpubP.page.version,
      nowMs: BASE_TIME + 126,
    });

    // 4. Disabled blog (`blogEnabled: false`) returns 404 on `/blog` and `/blog/[slug]`
    const settingsRow = await betaDb
      .prepare(`SELECT version FROM site_settings WHERE id = 1 LIMIT 1`)
      .first<{ readonly version: number }>();
    const nextVer = Number(settingsRow?.version ?? 2);
    await saveDraftResource(betaDb, {
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: nextVer,
      nowMs: BASE_TIME + 130,
      draft: {
        siteTitle: TENANT_BETA.name,
        tagline: "Wisata Nusantara",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "travel",
        blogEnabled: false,
        catalogEnabled: true,
        siteVisibility: "public",
        aiTrainingPolicy: "allow",
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: nextVer + 1,
      nowMs: BASE_TIME + 131,
    });

    const disabledBlogList = await resolveBlogListingRoute(
      new Request(`https://${TENANT_BETA.subdomain}/blog`),
      deps,
    );
    expect(disabledBlogList.kind).toBe("not_found");

    const disabledBlogDetail = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_BETA.subdomain}/blog/tips-perjalanan-beta`),
      deps,
      "tips-perjalanan-beta",
    );
    expect(disabledBlogDetail.kind).toBe("not_found");
  });

  it("isolates public offering detail, listing, credit table & JSON-LD from unpublished draft attribute and category mutations", async () => {
    const deps = makeDeps();

    // 1. Create Category A (published) and Category B (draft-only reassignment target)
    const catA = await createCatalogCategory(
      alphaDb,
      {
        offeringType: "vehicle",
        name: "SUV Operasional",
        slug: "suv-operasional",
      },
      { nowMs: BASE_TIME + 200 },
    );
    const catB = await createCatalogCategory(
      alphaDb,
      {
        offeringType: "vehicle",
        name: "Kategori Draf Baru",
        slug: "kategori-draf-baru",
      },
      { nowMs: BASE_TIME + 201 },
    );

    // 2. Create & publish a vehicle offering with Category A, creditEstimateEnabled=true, unitStatus=available
    const isoVeh = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "vehicle",
        title: "MPV Niaga 2024",
        slug: "mpv-niaga-2024",
        summary: "Unit MPV operasional kondisi prima.",
        priceMode: "fixed",
        price: 280_000_000,
        ctaMode: "whatsapp",
        ctaLabel: "Tanya Unit Resmi",
        unitStatus: "available",
        categoryIds: [catA.id],
        attributes: {
          brand: "Toyota",
          model: "Innova Zenix",
          year: 2024,
          condition: "used",
          transmission: "automatic",
          fuelType: "hybrid",
          bodyType: "mpv",
          mileageKm: 15_000,
          location: "Jakarta Pusat",
          unitStatus: "available",
          creditEstimateEnabled: true,
          creditEstimateConfig: {
            annualFlatRateBps: 500,
            dpPercents: [20, 30],
            tenorMonths: [36, 48],
          },
        },
      },
      { nowMs: BASE_TIME + 202 },
    );
    const pubIsoVeh = await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: isoVeh.id,
      expectedVersion: isoVeh.version,
      nowMs: BASE_TIME + 203,
    });

    // 3. Save a DRAFT update modifying vertical attributes, credit estimate config, unitStatus, ctaLabel, AND categoryIds -> [catB.id] WITHOUT republishing!
    await updateCatalogOffering(
      alphaDb,
      isoVeh.id,
      {
        title: "MPV Draf Rahasia",
        ctaLabel: "CTA Draf Bocor",
        unitStatus: "sold",
        categoryIds: [catB.id],
        attributes: {
          brand: "DraftBrand",
          model: "DraftModel",
          year: 2025,
          condition: "used",
          transmission: "manual",
          fuelType: "listrik",
          bodyType: "sedan",
          mileageKm: 99_999,
          location: "Kota Draf",
          unitStatus: "sold",
          creditEstimateEnabled: false,
          creditEstimateConfig: {
            annualFlatRateBps: 990,
            dpPercents: [50],
            tenorMonths: [12],
          },
        },
      },
      { expectedVersion: pubIsoVeh.offering.version, nowMs: BASE_TIME + 204 },
    );

    // 4. Assert public offering detail reads EXCLUSIVELY from frozen published snapshot (ZERO draft leaks!)
    const detail = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/kendaraan/mpv-niaga-2024`),
      deps,
      "vehicle",
      "mpv-niaga-2024",
    );
    expect(detail.kind).toBe("offering_detail");
    if (detail.kind !== "offering_detail") return;

    expect(detail.offering.title).toBe("MPV Niaga 2024");
    expect(detail.offering.unitStatus).toBe("available");
    expect(detail.offering.unitStatusLabel).toBe("Tersedia");
    expect(detail.offering.cta.label).toBe("Tanya Unit Resmi");
    expect(detail.offering.vehicleAttributes?.brand).toBe("Toyota");
    expect(detail.offering.vehicleAttributes?.model).toBe("Innova Zenix");
    expect(detail.offering.vehicleAttributes?.mileageKm).toBe(15_000);
    expect(detail.offering.vehicleAttributes?.unitStatus).toBe("available");
    expect(detail.offering.vehicleCreditRows).toHaveLength(2);
    expect(detail.offering.vehicleCreditRows.map((r) => r.dpPercent)).toEqual([20, 30]);
    expect(detail.offering.categoryNames).toEqual(["SUV Operasional"]);
    expect(detail.offering.categoryNames).not.toContain("Kategori Draf Baru");

    const jsonLdRaw = JSON.stringify(detail.schemaGraph ?? {});
    expect(jsonLdRaw).toContain("Toyota");
    expect(jsonLdRaw).not.toContain("DraftBrand");
    expect(jsonLdRaw).not.toContain("Kategori Draf Baru");
    expect(jsonLdRaw).not.toContain("99999");

    // 5. Assert public offering listing ALSO reflects ONLY frozen Category A and published metadata
    const listing = await resolveOfferingListingRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/kendaraan`),
      deps,
      "vehicle",
    );
    expect(listing.kind).toBe("offering_listing");
    if (listing.kind !== "offering_listing") return;
    const card = listing.items.find((item) => item.slug === "mpv-niaga-2024");
    expect(card).toBeDefined();
    expect(card?.title).toBe("MPV Niaga 2024");
    expect(card?.categoryName).toBe("SUV Operasional");
    expect(card?.categoryName).not.toBe("Kategori Draf Baru");
    expect(card?.unitStatus).toBe("available");
    expect(card?.metaLine).toContain("2024");
    expect(card?.metaLine).toContain("15.000 km");
    expect(card?.metaLine).not.toContain("99.999");
    expect(card?.metaLine).not.toContain("listrik");
  });

  it("canonicalizes mixed-case slugs via single-hop 308, preserves safe query strings on 308s, and completes /{homeSlug} -> 308 -> /", async () => {
    const deps = makeDeps();

    // 1. Homepage slug with query string -> single-hop 308 to /?utm_source=ads, then following to / renders published homepage!
    const homeSlugWithQuery = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/Beranda-Utama?utm_source=ads&ref=hero`),
      deps,
      "Beranda-Utama",
    );
    expect(homeSlugWithQuery.kind).toBe("response");
    if (homeSlugWithQuery.kind !== "response") return;
    expect(homeSlugWithQuery.response.status).toBe(308);
    const homeTarget = homeSlugWithQuery.response.headers.get("Location");
    expect(homeTarget).toBe(`https://${TENANT_ALPHA.customDomain}/?utm_source=ads&ref=hero`);

    const followedHome = await resolvePublicPageRoute(new Request(homeTarget!), deps, "");
    expect(followedHome.kind).toBe("page");
    if (followedHome.kind === "page") {
      expect(followedHome.http.status).toBe(200);
      expect(followedHome.isHomepage).toBe(true);
      expect(followedHome.seoMetadata.canonical).toBe(`https://${TENANT_ALPHA.customDomain}/`);
      expect(followedHome.pageTitle).toBe("Beranda Alpha");
    }

    // 2. Mixed-case current page slug -> single-hop 308 to lowercase preserving safe query
    const mixedPage = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/Konsultasi-Proyek?utm_source=ig`),
      deps,
      "Konsultasi-Proyek",
    );
    expect(mixedPage.kind).toBe("response");
    if (mixedPage.kind === "response") {
      expect(mixedPage.response.status).toBe(308);
      expect(mixedPage.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/konsultasi-proyek?utm_source=ig`,
      );
    }

    // 3. Mixed-case former page slug -> single-hop 308 directly to final current lowercase slug with query preserved
    const mixedFormerPage = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/Promo-Lama-A?ref=nav`),
      deps,
      "Promo-Lama-A",
    );
    expect(mixedFormerPage.kind).toBe("response");
    if (mixedFormerPage.kind === "response") {
      expect(mixedFormerPage.response.status).toBe(308);
      expect(mixedFormerPage.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/konsultasi-proyek?ref=nav`,
      );
    }

    // 4. Mixed-case blog & offering slugs -> single-hop 308 to lowercase preserving query
    const mixedBlog = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/Panduan-Bisnis-1?utm_medium=social`),
      deps,
      "Panduan-Bisnis-1",
    );
    expect(mixedBlog.kind).toBe("response");
    if (mixedBlog.kind === "response") {
      expect(mixedBlog.response.status).toBe(308);
      expect(mixedBlog.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/blog/panduan-bisnis-1?utm_medium=social`,
      );
    }

    const mixedOffering = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/layanan/Audit-Operasional?utm_campaign=q4`),
      deps,
      "service",
      "Audit-Operasional",
    );
    expect(mixedOffering.kind).toBe("response");
    if (mixedOffering.kind === "response") {
      expect(mixedOffering.response.status).toBe(308);
      expect(mixedOffering.response.headers.get("Location")).toBe(
        `https://${TENANT_ALPHA.customDomain}/layanan/audit-operasional?utm_campaign=q4`,
      );
    }

    // 5. Mixed-case draft or missing slugs MUST return 404 (NEVER 308!)
    const mixedDraft = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/Draf-Rahasia`),
      deps,
      "Draf-Rahasia",
    );
    expect(mixedDraft.kind).toBe("not_found");

    const mixedMissingBlog = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/Artikel-Tidak-Ada`),
      deps,
      "Artikel-Tidak-Ada",
    );
    expect(mixedMissingBlog.kind).toBe("not_found");
  });
});
