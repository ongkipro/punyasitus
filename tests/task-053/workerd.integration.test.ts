import { env } from "cloudflare:workers";
import { INDEXABLE_ROBOTS_DIRECTIVES } from "@punyasitus/core/seo/index";
import {
  auditRenderedPublicPageSeo,
  composePublicSeoHead,
  sanitizeTenantLocalHref,
} from "@punyasitus/core/seo/local-entity";
import {
  AuthorValidationError,
  createPublicAuthor,
  getPublicAuthorById,
  updatePublicAuthor,
} from "@punyasitus/db/authors/index";
import { createBranch } from "@punyasitus/db/branches/index";
import { BRANCHES_MIGRATION } from "@punyasitus/db/branches/migrations";
import {
  publishStructuredBusinessProfile,
  saveStructuredBusinessProfileDraft,
} from "@punyasitus/db/business-profile/index";
import { BUSINESS_PROFILE_STRUCTURED_MIGRATION } from "@punyasitus/db/business-profile/migrations";
import {
  createCatalogCategory,
  createCatalogOffering,
  publishCatalogOffering,
} from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage, publishPage } from "@punyasitus/db/pages/index";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import { createPost, publishPost } from "@punyasitus/db/posts/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import {
  getPublishedPublicSeoContext,
  loadPublishedTenantInternalLinkTargets,
  publishTenantSeoEditorSettings,
  saveTenantSeoEditorSettingsDraft,
  setSeoAutopilotEnabledForTenant,
  TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION,
} from "@punyasitus/db/seo/index";
import { createTaxonomy } from "@punyasitus/db/taxonomy/index";
import { TAXONOMY_ARCHIVE_SETTINGS_MIGRATION } from "@punyasitus/db/taxonomy/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  enrichPublicBlogDetailResult,
  enrichPublicBlogTaxonomyArchiveResult,
  enrichPublicOfferingDetailResult,
  enrichPublicPageRouteResult,
} from "../../apps/web/src/components/seo/public-seo-context.ts";
import {
  resolveBlogDetailRoute,
  resolveOfferingDetailRoute,
  resolvePublicPageRoute,
  type PublicRouteDeps,
} from "../../apps/web/src/core/public-routes.ts";
import { resolveBlogCategoryArchiveRoute } from "../../apps/web/src/pages/blog/category/_archive-resolver.ts";

const BASE_TIME = 1_860_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_ALPHA = {
  id: "01JT053ALPHA00000000000001",
  orgId: "org_t053_alpha",
  handle: "t053-alpha",
  name: "PT Nusantara Arsitek",
  subdomain: "t053-alpha.situsku.click",
  customDomain: "www.t053-alpha.id",
} as const;

const TENANT_BETA = {
  id: "01JT053BETA000000000000002",
  orgId: "org_t053_beta",
  handle: "t053-beta",
  name: "Beta Servis Panggilan",
  subdomain: "t053-beta.situsku.click",
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
  const allMigrations = Array.from(
    new Map(
      [
        ...TENANT_MIGRATIONS,
        TAXONOMY_ARCHIVE_SETTINGS_MIGRATION,
        BUSINESS_PROFILE_STRUCTURED_MIGRATION,
        TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION,
        BRANCHES_MIGRATION,
      ].map((m) => [m.version, m]),
    ).values(),
  ).sort((a, b) => a.version - b.version);
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, allMigrations);

  return createTenantDb(stub);
}

async function seedReadyImageMedia(
  tenantDb: D1Database,
  tenantId: string,
  mediaId: number,
  filename: string,
  altText: string,
): Promise<void> {
  const key = `t/${tenantId}/media/${filename}`;
  const variants = JSON.stringify({
    master: { key, width: 1200, height: 800, bytes: 42_000, mimeType: "image/webp" },
    w640: { key, width: 640, height: 427, bytes: 20_000, mimeType: "image/webp" },
    og: { key, width: 1200, height: 630, bytes: 38_000, mimeType: "image/jpeg" },
  });
  await tenantDb
    .prepare(
      `INSERT OR REPLACE INTO media_items
         (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, version, created_at, updated_at)
       VALUES (?, 'image', ?, 'image/webp', 42000, ?, 1200, 800, ?, ?, 'ready', 1, ?, ?)`,
    )
    .bind(mediaId, key, `sha256_${mediaId}_${filename}`, altText, variants, BASE_TIME, BASE_TIME)
    .run();
}

describe("TASK-053 workerd integration — Local Entity Schema, Authors, Branches, TOC & Crawl Parity", () => {
  let alphaDb: D1Database;
  let betaDb: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    alphaDb = await seedTenant(TENANT_ALPHA);
    betaDb = await seedTenant(TENANT_BETA);

    // Seed ready media assets for Alpha
    await seedReadyImageMedia(alphaDb, TENANT_ALPHA.id, 101, "logo-alpha.webp", "Logo PT Nusantara Arsitek");
    await seedReadyImageMedia(alphaDb, TENANT_ALPHA.id, 102, "avatar-rina.webp", "Foto Rina Kartika");
    await seedReadyImageMedia(alphaDb, TENANT_ALPHA.id, 103, "cover-audit.webp", "Audit Bangunan Kantor");
    await seedReadyImageMedia(alphaDb, TENANT_ALPHA.id, 104, "produk-kursi.webp", "Kursi Kantor Ergonomis");

    // Configure & publish Alpha structured business profile (TASK-091)
    const draftProf = await saveStructuredBusinessProfileDraft(alphaDb, {
      siteSettings: {
        siteTitle: "PT Nusantara Arsitek",
        tagline: "Desain & Renovasi Kantor B2B",
        blogEnabled: true,
        catalogEnabled: true,
        logoMediaId: 101,
      },
      businessProfile: {
        businessName: "PT Nusantara Arsitek",
        legalName: "PT Nusantara Arsitek Indonesia",
        businessCategory: "contractor",
        description: "Konsultan arsitektur dan renovasi kantor korporat di Jabodetabek.",
        address: "Jl. Kemang Raya No. 18",
        city: "Jakarta Selatan",
        province: "DKI Jakarta",
        postalCode: "12730",
        phone: "021-7190011",
        whatsappE164: "6281234567890",
        email: "halo@t053-alpha.id",
        privacyContact: "privasi@t053-alpha.id",
        mapsUrl: "https://maps.google.com/?q=-6.2607,106.8132",
        weekdayHours: "Senin-Jumat 08:00-17:00 WIB",
        serviceAreas: ["Jakarta Selatan", "Tangerang Selatan", "Bandung"],
      },
      nowMs: BASE_TIME,
    });
    await publishStructuredBusinessProfile(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      expectedVersion: draftProf.version,
      nowMs: BASE_TIME + 1000,
    });

    // Save unpublished draft edit on Alpha business profile to prove ZERO draft leak
    await saveStructuredBusinessProfileDraft(alphaDb, {
      businessProfile: {
        legalName: "DRAFT LEAK UNPUBLISHED PT",
      },
      nowMs: BASE_TIME + 2000,
    });

    // Seed Alpha active + inactive branches (TASK-088)
    await createBranch(
      alphaDb,
      {
        name: "Cabang BSD City",
        address: "Ruko Golden Boulevard Blok C1",
        city: "Tangerang Selatan",
        province: "Banten",
        phone: "021-5319000",
        whatsappNumber: "081199887766",
        mapsUrl: "https://maps.google.com/?q=-6.3012,106.6524",
        weekdayHours: "Senin-Sabtu 09:00-17:00 WIB",
        isPrimary: true,
        active: true,
      },
      { nowMs: BASE_TIME + 3000 },
    );
    await createBranch(
      alphaDb,
      {
        name: "Cabang Bandung (WA Only)",
        address: "Jl. Braga No. 55",
        city: "Bandung",
        province: "Jawa Barat",
        phone: null,
        whatsappNumber: "081299001122",
        weekdayHours: "Senin-Jumat 09:00-17:00 WIB",
        active: true,
      },
      { nowMs: BASE_TIME + 3100 },
    );
    await createBranch(
      alphaDb,
      {
        name: "Cabang Nonaktif Tersembunyi",
        address: "Jl. Rahasia No. 99",
        active: false,
      },
      { nowMs: BASE_TIME + 3200 },
    );

    // Configure & publish Alpha SEO verification token + Search Appearance template, then save UNPUBLISHED draft token
    const seoDraft1 = await saveTenantSeoEditorSettingsDraft(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      actorUserId: "u_owner",
      actorRole: "owner",
      expectedVersion: 1,
      patch: {
        separator: "|",
        templates: {
          homepage: {
            titleTemplate: "{{site_name}} {{sep}} {{tagline}}",
            descriptionTemplate: "{{excerpt}}",
          },
        },
        verification: {
          google: "gscAlphaPublishedToken2026",
        },
      },
      nowMs: BASE_TIME + 4000,
    });
    const seoPub = await publishTenantSeoEditorSettings(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      actorUserId: "u_owner",
      actorRole: "owner",
      expectedVersion: seoDraft1.version,
      nowMs: BASE_TIME + 4100,
    });
    await saveTenantSeoEditorSettingsDraft(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      actorUserId: "u_owner",
      actorRole: "owner",
      expectedVersion: seoPub.version,
      patch: {
        verification: {
          bing: "DRAFTBINGTOKEN999999999",
        },
      },
      nowMs: BASE_TIME + 4200,
    });

    // Seed Alpha homepage + FAQ page + non-FAQ page with stored FAQPage override
    const home = await createPage(alphaDb, {
      title: "Beranda PT Nusantara Arsitek",
      slug: "beranda",
      isHomepage: true,
      layoutMode: "standard",
      sections: [
        {
          id: "hero-utama",
          kind: "hero",
          heading: "Mitra Desain & Renovasi Kantor Terpercaya",
          subheading: "Solusi ruang kerja B2B transparan.",
          bodyHtml: null,
          ctaLabel: "Lihat Layanan",
          ctaHref: "/layanan",
        },
      ],
      nowMs: BASE_TIME + 5000,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: home.id,
      expectedVersion: home.version,
      nowMs: BASE_TIME + 5100,
    });

    const faqPage = await createPage(alphaDb, {
      title: "Pertanyaan Umum",
      slug: "tanya-jawab",
      layoutMode: "standard",
      sections: [
        {
          id: "faq-1",
          kind: "faq",
          heading: "FAQ Renovasi",
          subheading: "Jawaban atas pertanyaan umum proyek renovasi kantor.",
          bodyHtml:
            "<h3>Apakah survei lokasi dikenakan biaya?</h3><p>Survei area Jakarta Selatan gratis untuk proyek kantor minimal 100m2.</p>",
        },
      ],
      seo: { schemaType: "FAQPage" },
      nowMs: BASE_TIME + 5200,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: faqPage.id,
      expectedVersion: faqPage.version,
      nowMs: BASE_TIME + 5300,
    });

    const emptyFaqPage = await createPage(alphaDb, {
      title: "Profil Perusahaan",
      slug: "tentang-kami",
      layoutMode: "standard",
      sections: [
        {
          id: "about-1",
          kind: "about",
          heading: "Tentang PT Nusantara Arsitek",
          subheading: null,
          bodyHtml: "<p>Berdiri sejak 2016 menangani proyek komersial.</p>",
        },
      ],
      seo: { schemaType: "FAQPage" }, // stored FAQPage WITHOUT visible FAQ -> MUST downgrade to WebPage!
      nowMs: BASE_TIME + 5400,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: emptyFaqPage.id,
      expectedVersion: emptyFaqPage.version,
      nowMs: BASE_TIME + 5500,
    });

    // Seed Alpha draft-only page (MUST NOT appear in published link targets)
    await createPage(alphaDb, {
      title: "Halaman Draf Rahasia",
      slug: "draf-rahasia",
      sections: [],
      nowMs: BASE_TIME + 5600,
    });

    // Seed Alpha author with avatar + bio + sameAs
    const author = await createPublicAuthor(
      alphaDb,
      {
        name: "Rina Kartika",
        slug: "rina-kartika",
        bio: "Arsitek senior spesialis tata ruang kantor komersial dan audit kelayakan gedung B2B.",
        avatarMediaId: 102,
        sameAs: [
          "https://www.linkedin.com/in/rina-kartika",
          "https://instagram.com/rinakartika.arsitek",
        ],
        nowMs: BASE_TIME + 6000,
      },
      { tenantId: TENANT_ALPHA.id },
    );

    // Seed Alpha blog category (opted-in with intro) + empty category + tag + published post with H2/H3 TOC & internal links
    const catPanduan = await createTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Panduan Renovasi",
      slug: "panduan-renovasi",
      description:
        "Panduan lengkap dan praktis untuk merencanakan renovasi ruang kerja dan audit bangunan kantor.",
      indexOptIn: true,
      nowMs: BASE_TIME + 6100,
    });
    await createTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Kategori Kosong",
      slug: "kategori-kosong",
      nowMs: BASE_TIME + 6120,
    });
    const tagB2b = await createTaxonomy(alphaDb, {
      kind: "post_tag",
      name: "B2B",
      slug: "b2b",
      nowMs: BASE_TIME + 6150,
    });

    const post = await createPost(alphaDb, {
      title: "Panduan Audit Kelayakan Gedung Kantor",
      slug: "panduan-audit-gedung",
      excerpt: "Langkah terstruktur melakukan audit struktur dan MEP sebelum renovasi kantor.",
      bodyHtml:
        '<p>Audit awal mencegah pembengkakan biaya. Cek <a href="/produk/kursi-ergonomis-pro?utm_source=ig&amp;fbclid=999">kursi kantor kami</a>, hindari <a href="/draf-rahasia">halaman draf rahasia</a> dan <a href="https://other-tenant.situsku.click/blog/bocor">tautan tenant lain</a>.</p><h2>Pemeriksaan Struktur</h2><p>Cek beban lantai.</p><h3>Daftar Cek MEP</h3><p>Pastikan kapasitas daya listrik.</p>',
      authorId: author.id,
      authorName: author.name,
      primaryCategoryId: catPanduan.id,
      categoryIds: [catPanduan.id],
      tagIds: [tagB2b.id],
      coverMediaId: 103,
      showToc: true,
      seo: { schemaType: "Article" },
      nowMs: BASE_TIME + 6200,
    });
    await publishPost(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      postId: post.id,
      expectedVersion: post.version,
      nowMs: BASE_TIME + 6300,
    });

    // Seed Alpha catalog category + product (fixed price) + product (on_request with stored Product override)
    const prodCat = await createCatalogCategory(
      alphaDb,
      {
        offeringType: "product",
        name: "Furnitur Kantor",
        slug: "furnitur-kantor",
      },
      { nowMs: BASE_TIME + 7000 },
    );
    const fixedProd = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "product",
        title: "Kursi Kerja Ergonomis Pro",
        slug: "kursi-ergonomis-pro",
        summary: "Kursi ergonomis bersertifikat untuk penggunaan kantor harian.",
        priceMode: "fixed",
        price: 2_850_000,
        ctaMode: "whatsapp",
        coverMediaId: 104,
        categoryIds: [prodCat.id],
        seo: { schemaType: "Product" },
      },
      { nowMs: BASE_TIME + 7100 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: fixedProd.id,
      expectedVersion: fixedProd.version,
      nowMs: BASE_TIME + 7200,
    });

    const onReqProd = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "product",
        title: "Partisi Akustik Kustom",
        slug: "partisi-akustik-kustom",
        summary: "Dibuat sesuai ukuran ruang rapat.",
        priceMode: "on_request",
        ctaMode: "whatsapp",
        categoryIds: [prodCat.id],
        seo: { schemaType: "Product" }, // MUST downgrade to Service because priceMode is on_request!
      },
      { nowMs: BASE_TIME + 7300 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      offeringId: onReqProd.id,
      expectedVersion: onReqProd.version,
      nowMs: BASE_TIME + 7400,
    });

    // Seed Beta: Service-Area Business (NO physical address), blogEnabled: false, seo-ai-autopilot DISABLED!
    const betaDraft = await saveStructuredBusinessProfileDraft(betaDb, {
      siteSettings: {
        siteTitle: "Beta Servis Panggilan",
        tagline: "Servis AC Panggilan Jabodetabek",
        blogEnabled: false,
        catalogEnabled: true,
      },
      businessProfile: {
        businessName: "Beta Servis Panggilan",
        businessCategory: "local_business",
        description: "Teknisi panggilan langsung ke rumah/kantor tanpa kantor cabang publik.",
        serviceAreas: ["Depok", "Bekasi", "Jakarta Timur"],
        whatsappE164: "6281300001111",
      },
      nowMs: BASE_TIME + 8000,
    });
    await publishStructuredBusinessProfile(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      expectedVersion: betaDraft.version,
      nowMs: BASE_TIME + 8100,
    });
    await setSeoAutopilotEnabledForTenant(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_BETA.id,
      enabled: false,
      actorUserId: "u_beta_owner",
      actorRole: "owner",
      nowMs: BASE_TIME + 8400,
    });
  });

  beforeEach(() => {
    clearHostResolutionCache();
  });

  it("enforces public author validation (bio <= 300, <= 5 HTTPS sameAs, ready avatar) and loads verified avatar", async () => {
    await expect(
      createPublicAuthor(alphaDb, {
        name: "Penulis Bio Panjang",
        bio: "B".repeat(301),
      }),
    ).rejects.toThrow(AuthorValidationError);

    await expect(
      createPublicAuthor(alphaDb, {
        name: "Penulis Banyak Link",
        sameAs: [
          "https://a.example.com",
          "https://b.example.com",
          "https://c.example.com",
          "https://d.example.com",
          "https://e.example.com",
          "https://f.example.com",
        ],
      }),
    ).rejects.toThrow(AuthorValidationError);

    await expect(
      createPublicAuthor(alphaDb, {
        name: "Penulis Avatar Palsu",
        avatarMediaId: 99999,
      }),
    ).rejects.toThrow(AuthorValidationError);

    const loaded = await getPublicAuthorById(alphaDb, 1, { tenantId: TENANT_ALPHA.id });
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("Rina Kartika");
    expect(loaded?.avatar?.url).toContain(`/t/${TENANT_ALPHA.id}/media/avatar-rina.webp`);
    expect(loaded?.sameAs).toEqual([
      "https://www.linkedin.com/in/rina-kartika",
      "https://instagram.com/rinakartika.arsitek",
    ]);

    const updated = await updatePublicAuthor(
      alphaDb,
      loaded!.id,
      { bio: "Arsitek senior spesialis tata ruang kantor modern dan audit gedung." },
      { tenantId: TENANT_ALPHA.id },
    );
    expect(updated?.bio).toContain("tata ruang kantor modern");
  });

  it("loads published-only public SEO context without leaking draft tokens, draft business edits, or inactive branches", async () => {
    const ctx = await getPublishedPublicSeoContext(alphaDb, { tenantId: TENANT_ALPHA.id });
    expect(ctx.seoAutopilotEnabled).toBe(true);
    expect(ctx.publishedSettings?.verificationTokens.google).toBe("gscAlphaPublishedToken2026");
    // Unpublished draft Bing token MUST NOT leak!
    expect(ctx.publishedSettings?.verificationTokens.bing).toBeNull();
    // Unpublished draft legalName MUST NOT leak!
    expect(ctx.structuredBusiness?.businessProfile.legalName).toBe("PT Nusantara Arsitek Indonesia");
    // Only 2 active branches returned (inactive branch excluded!)
    expect(ctx.activeBranches).toHaveLength(2);
    expect(ctx.activeBranches.map((b) => b.name)).toEqual([
      "Cabang BSD City",
      "Cabang Bandung (WA Only)",
    ]);
    expect(ctx.publishedLogo?.url).toContain("logo-alpha.webp");
  });

  it("enriches homepage with visible branches @graph parity, FAQPage gating on subpages, and SAB honesty on Beta", async () => {
    const deps = makeDeps();

    // 1. Alpha homepage -> standalone branches + matching subOrganization nodes + published verification + RSS
    const homeRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/`),
      deps,
      "",
    );
    expect(homeRes.kind).toBe("page");
    if (homeRes.kind !== "page") return;
    const enrichedHome = await enrichPublicPageRouteResult(homeRes, deps);

    expect(enrichedHome.shouldRenderStandaloneBranches).toBe(true);
    expect(enrichedHome.activeBranches).toHaveLength(2);
    const orgNode = enrichedHome.schemaGraph?.["@graph"].find(
      (n) => n["@id"] === `https://${TENANT_ALPHA.customDomain}/#organization`,
    );
    expect(orgNode?.legalName).toBe("PT Nusantara Arsitek Indonesia");
    expect(orgNode?.subOrganization).toHaveLength(2);
    const branchNodes =
      enrichedHome.schemaGraph?.["@graph"].filter(
        (n) =>
          typeof n["@id"] === "string" &&
          n["@id"].startsWith(`https://${TENANT_ALPHA.customDomain}/#branch-`),
      ) ?? [];
    expect(branchNodes).toHaveLength(2);
    // Cabang BSD has visible phone -> telephone emitted; Cabang Bandung has WA only -> NO telephone!
    expect(branchNodes.find((b) => b.name === "Cabang BSD City")?.telephone).toBe("+62215319000");
    expect(branchNodes.find((b) => b.name === "Cabang Bandung (WA Only)")?.telephone).toBeUndefined();

    const homeHead = composePublicSeoHead(enrichedHome.head);
    expect(homeHead.effectiveTitle).toBe("PT Nusantara Arsitek | Desain & Renovasi Kantor B2B");
    expect(homeHead.robots).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
    expect(homeHead.rssFeedUrl).toBe(`https://${TENANT_ALPHA.customDomain}/blog/feed.xml`);
    expect(homeHead.verificationMetaTags).toEqual([
      '<meta name="google-site-verification" content="gscAlphaPublishedToken2026" />',
    ]);
    expect(homeHead.html).not.toContain("DRAFTBINGTOKEN");
    expect(homeHead.html).not.toContain("DRAFT LEAK");
    const homeAudit = auditRenderedPublicPageSeo(
      `<!doctype html><html><head>${homeHead.html}</head><body><h1>${TENANT_ALPHA.name}</h1></body></html>`,
      { verifiedOrigin: `https://${TENANT_ALPHA.customDomain}` },
    );
    expect(homeAudit.titleCount).toBe(1);
    expect(homeAudit.robotsMetaCount).toBe(1);
    expect(homeAudit.canonicalCount).toBe(1);
    expect(homeAudit.jsonLdCount).toBe(1);

    // 1b. Tenant homepage `/` under siteVisibility === "noindex" -> single <meta name="robots"> (never duplicated!)
    const noindexHomeRes = {
      ...homeRes,
      shell: {
        ...homeRes.shell,
        site: { ...homeRes.shell.site, siteVisibility: "noindex" as const },
      },
      seoMetadata: {
        ...homeRes.seoMetadata,
        robots: "noindex, nofollow",
      },
    };
    const enrichedNoindexHome = await enrichPublicPageRouteResult(noindexHomeRes, deps);
    const noindexHomeHead = composePublicSeoHead(enrichedNoindexHome.head);
    const noindexAudit = auditRenderedPublicPageSeo(
      `<!doctype html><html><head>${noindexHomeHead.html}</head><body><h1>${TENANT_ALPHA.name}</h1></body></html>`,
      { verifiedOrigin: `https://${TENANT_ALPHA.customDomain}` },
    );
    expect(noindexAudit.robotsMetaCount).toBe(1);
    expect(noindexAudit.robotsContents).toEqual(["noindex, nofollow"]);

    // 1c. Fail-closed DB error on enrichPublicPageRouteResult -> seoAutopilotEnabled === false (never leaks autopilot tags)
    const throwingTenantDb = {
      prepare() {
        throw new Error("D1_ERROR: simulated tenant store outage");
      },
    } as unknown as D1Database;
    const failClosedHome = await enrichPublicPageRouteResult(homeRes, {
      ...deps,
      tenantDb: throwingTenantDb,
    });
    expect(failClosedHome.head.seoAutopilotEnabled).toBe(false);
    expect(failClosedHome.head.publishedVerificationTokens).toBeNull();
    const failClosedHead = composePublicSeoHead(failClosedHome.head);
    expect(failClosedHead.schemaEmitted).toBe(false);
    expect(failClosedHead.verificationMetaTags).toEqual([]);

    // 2. Alpha FAQ page with ONLY bodyHtml (no config.items) MUST NOT emit FAQPage (100% parity with SectionFaq.astro!)
    const faqRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/tanya-jawab`),
      deps,
      "tanya-jawab",
    );
    expect(faqRes.kind).toBe("page");
    if (faqRes.kind === "page") {
      const enrichedBodyOnlyFaq = await enrichPublicPageRouteResult(faqRes, deps);
      expect(
        enrichedBodyOnlyFaq.schemaGraph?.["@graph"].some((n) => n["@type"] === "FAQPage"),
      ).toBe(false);
      expect(
        enrichedBodyOnlyFaq.schemaGraph?.["@graph"].some((n) => n["@type"] === "WebPage"),
      ).toBe(true);

      // When structured config.items FAQ entries ARE present (rendered by SectionFaq.astro), FAQPage IS emitted
      const withStructuredFaq = await enrichPublicPageRouteResult(
        {
          ...faqRes,
          page: {
            ...faqRes.page!,
            sections: [
              {
                id: "faq-structured",
                type: "faq",
                enabled: true,
                config: {
                  heading: "FAQ Renovasi",
                  items: [
                    {
                      question: "Apakah survei lokasi dikenakan biaya?",
                      answer: "Survei area Jakarta Selatan gratis untuk proyek kantor minimal 100m2.",
                    },
                  ],
                },
              } as unknown as NonNullable<typeof faqRes.page>["sections"][number],
            ],
          },
        },
        deps,
      );
      expect(withStructuredFaq.schemaGraph?.["@graph"].some((n) => n["@type"] === "FAQPage")).toBe(
        true,
      );
      expect(
        withStructuredFaq.schemaGraph?.["@graph"].some((n) => n["@type"] === "BreadcrumbList"),
      ).toBe(true);
    }

    // 3. Alpha About page with stored FAQPage override but NO visible FAQ -> downgraded to WebPage
    const aboutRes = await resolvePublicPageRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/tentang-kami`),
      deps,
      "tentang-kami",
    );
    expect(aboutRes.kind).toBe("page");
    if (aboutRes.kind === "page") {
      const enrichedAbout = await enrichPublicPageRouteResult(aboutRes, deps);
      expect(enrichedAbout.schemaGraph?.["@graph"].some((n) => n["@type"] === "FAQPage")).toBe(
        false,
      );
      expect(enrichedAbout.schemaGraph?.["@graph"].some((n) => n["@type"] === "WebPage")).toBe(
        true,
      );
    }

    // 4. Beta Service-Area Business (blog disabled, seo-ai-autopilot disabled)
    const betaHome = await resolvePublicPageRoute(
      new Request(`https://${TENANT_BETA.subdomain}/`),
      deps,
      "",
    );
    expect(betaHome.kind).toBe("page");
    if (betaHome.kind === "page") {
      const enrichedBeta = await enrichPublicPageRouteResult(betaHome, deps);
      const betaOrg = enrichedBeta.schemaGraph?.["@graph"].find(
        (n) => n["@id"] === `https://${TENANT_BETA.subdomain}/#organization`,
      );
      expect(betaOrg?.address).toBeUndefined();
      expect(betaOrg?.areaServed).toEqual(["Depok", "Bekasi", "Jakarta Timur"]);
      expect(enrichedBeta.head.seoAutopilotEnabled).toBe(false);
      expect(enrichedBeta.head.blogEnabled).toBe(false);
      const betaHead = composePublicSeoHead(enrichedBeta.head);
      expect(betaHead.rssFeedUrl).toBeNull();
      expect(betaHead.schemaEmitted).toBe(false);
    }
  });

  it("enriches blog article with zero-JS TOC heading anchors, Author Person schema, clickable taxonomy links, and opt-in taxonomy archive", async () => {
    const deps = makeDeps();
    const postRes = await resolveBlogDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/panduan-audit-gedung`),
      deps,
      "panduan-audit-gedung",
    );
    expect(postRes.kind).toBe("blog_detail");
    if (postRes.kind !== "blog_detail") return;

    const enriched = await enrichPublicBlogDetailResult(postRes, deps);
    expect(enriched.showToc).toBe(true);
    expect(enriched.toc).toEqual([
      { id: "pemeriksaan-struktur", text: "Pemeriksaan Struktur", level: 2 },
      { id: "daftar-cek-mep", text: "Daftar Cek MEP", level: 3 },
    ]);
    expect(enriched.sanitizedHtmlWithAnchors).toContain('id="pemeriksaan-struktur"');
    expect(enriched.sanitizedHtmlWithAnchors).toContain('id="daftar-cek-mep"');
    // Internal-link hygiene on rendered post HTML:
    // - Valid published internal link has tracking params stripped
    expect(enriched.sanitizedHtmlWithAnchors).toContain('href="/produk/kursi-ergonomis-pro"');
    expect(enriched.sanitizedHtmlWithAnchors).not.toContain("utm_source");
    expect(enriched.sanitizedHtmlWithAnchors).not.toContain("fbclid");
    // - Draft & cross-tenant links are unwrapped to plain text (zero broken/leaked anchors!)
    expect(enriched.sanitizedHtmlWithAnchors).not.toContain('href="/draf-rahasia"');
    expect(enriched.sanitizedHtmlWithAnchors).toContain("halaman draf rahasia");
    expect(enriched.sanitizedHtmlWithAnchors).not.toContain("other-tenant.situsku.click");
    expect(enriched.sanitizedHtmlWithAnchors).toContain("tautan tenant lain");
    // - Catalog CTA resolves to published `/produk` (NOT empty `/layanan` which has 0 services!)
    expect(enriched.blogIndexHref).toBe("/blog");
    expect(enriched.catalogCta).toEqual({ href: "/produk", label: "Lihat Produk Kami" });

    expect(enriched.authorProfile?.name).toBe("Rina Kartika");
    expect(enriched.authorProfile?.sameAs).toHaveLength(2);
    expect(enriched.categoryLinks).toEqual([
      { name: "Panduan Renovasi", slug: "panduan-renovasi", href: "/blog/category/panduan-renovasi" },
    ]);
    expect(enriched.tagLinks).toEqual([{ name: "B2B", slug: "b2b", href: "/blog/tag/b2b" }]);

    // Regression: when blogEnabled is false, taxonomy chip links MUST NOT be emitted as clickable 404 links
    const disabledBlogEnriched = await enrichPublicBlogDetailResult(
      {
        ...postRes,
        shell: {
          ...postRes.shell,
          site: { ...postRes.shell.site, blogEnabled: false },
        },
      },
      deps,
    );
    expect(disabledBlogEnriched.categoryLinks).toEqual([]);
    expect(disabledBlogEnriched.tagLinks).toEqual([]);
    expect(disabledBlogEnriched.blogIndexHref).toBeNull();

    const articleNode = enriched.schemaGraph?.["@graph"].find((n) => n["@type"] === "Article");
    expect(articleNode).toBeDefined();
    const person = articleNode?.author as Record<string, unknown>;
    expect(person["@type"]).toBe("Person");
    expect(person.name).toBe("Rina Kartika");
    expect(person.description).toContain("Arsitek senior");
    expect(person.image).toMatchObject({ "@type": "ImageObject" });
    expect(person.sameAs).toEqual([
      "https://www.linkedin.com/in/rina-kartika",
      "https://instagram.com/rinakartika.arsitek",
    ]);

    // Opt-in blog category archive
    const catRes = await resolveBlogCategoryArchiveRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/blog/category/panduan-renovasi`),
      deps,
      "panduan-renovasi",
    );
    expect(catRes.kind).toBe("blog_taxonomy_archive");
    if (catRes.kind === "blog_taxonomy_archive") {
      const enrichedCat = await enrichPublicBlogTaxonomyArchiveResult(catRes, deps);
      expect(enrichedCat.head.metadata.robots).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
      expect(
        enrichedCat.schemaGraph?.["@graph"].some((n) => n["@type"] === "CollectionPage"),
      ).toBe(true);
      expect(
        enrichedCat.schemaGraph?.["@graph"].some((n) => n["@type"] === "BreadcrumbList"),
      ).toBe(true);
    }
  });

  it("enriches offerings with resolvePublishSafeSchemaType gating & published tenant-local internal link targets", async () => {
    const deps = makeDeps();

    // Fixed-price product -> honest Product + Offer + clickable category link
    const fixedRes = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/produk/kursi-ergonomis-pro`),
      deps,
      "product",
      "kursi-ergonomis-pro",
    );
    expect(fixedRes.kind).toBe("offering_detail");
    if (fixedRes.kind === "offering_detail") {
      const enrichedFixed = await enrichPublicOfferingDetailResult(fixedRes, deps);
      expect(enrichedFixed.categoryLinks).toEqual([
        { name: "Furnitur Kantor", slug: "furnitur-kantor", href: "/produk/category/furnitur-kantor" },
      ]);
      const prodNode = enrichedFixed.schemaGraph?.["@graph"].find((n) => n["@type"] === "Product");
      expect(prodNode?.offers).toMatchObject({
        "@type": "Offer",
        priceCurrency: "IDR",
        price: 2_850_000,
      });

      // Regression: when catalogEnabled is false, offering category chip links MUST NOT be emitted as clickable links
      const disabledCatalogEnriched = await enrichPublicOfferingDetailResult(
        {
          ...fixedRes,
          shell: {
            ...fixedRes.shell,
            site: { ...fixedRes.shell.site, catalogEnabled: false },
          },
        },
        deps,
      );
      expect(disabledCatalogEnriched.categoryLinks).toEqual([]);
    }

    // on_request product with stored Product schemaType -> downgraded to Service, zero fabricated Offer
    const onReqRes = await resolveOfferingDetailRoute(
      new Request(`https://${TENANT_ALPHA.customDomain}/produk/partisi-akustik-kustom`),
      deps,
      "product",
      "partisi-akustik-kustom",
    );
    expect(onReqRes.kind).toBe("offering_detail");
    if (onReqRes.kind === "offering_detail") {
      const enrichedOnReq = await enrichPublicOfferingDetailResult(onReqRes, deps);
      expect(enrichedOnReq.schemaGraph?.["@graph"].some((n) => n["@type"] === "Product")).toBe(
        false,
      );
      expect(enrichedOnReq.schemaGraph?.["@graph"].some((n) => n["@type"] === "Service")).toBe(
        true,
      );
    }

    // Tightened published link target inventory:
    // - excludes draft pages (`draf-rahasia`), unpublished `/kebijakan-privasi`, empty categories, and empty catalog types!
    const publishedPaths = await loadPublishedTenantInternalLinkTargets(alphaDb);
    expect(publishedPaths.has("/")).toBe(true);
    expect(publishedPaths.has("/tanya-jawab")).toBe(true);
    expect(publishedPaths.has("/kebijakan-privasi")).toBe(false);
    expect(publishedPaths.has("/blog")).toBe(true);
    expect(publishedPaths.has("/blog/panduan-audit-gedung")).toBe(true);
    expect(publishedPaths.has("/blog/category/panduan-renovasi")).toBe(true);
    expect(publishedPaths.has("/blog/category/kategori-kosong")).toBe(false);
    expect(publishedPaths.has("/produk")).toBe(true);
    expect(publishedPaths.has("/produk/kursi-ergonomis-pro")).toBe(true);
    expect(publishedPaths.has("/produk/category/furnitur-kantor")).toBe(true);
    expect(publishedPaths.has("/layanan")).toBe(false);
    expect(publishedPaths.has("/tour")).toBe(false);
    expect(publishedPaths.has("/kendaraan")).toBe(false);
    expect(publishedPaths.has("/draf-rahasia")).toBe(false);
    expect(sanitizeTenantLocalHref("/draf-rahasia", { publishedPaths }).ok).toBe(false);
    expect(sanitizeTenantLocalHref("/blog/panduan-audit-gedung", { publishedPaths }).ok).toBe(true);

    // Beta tenant has blogEnabled: false -> MUST NOT include `/blog`
    const betaPaths = await loadPublishedTenantInternalLinkTargets(betaDb);
    expect(betaPaths.has("/")).toBe(true);
    expect(betaPaths.has("/blog")).toBe(false);
    expect(betaPaths.has("/kebijakan-privasi")).toBe(false);

    // Once a `kebijakan-privasi` page IS published, `/kebijakan-privasi` appears in published link targets
    const privacyPage = await createPage(alphaDb, {
      title: "Kebijakan Privasi",
      slug: "kebijakan-privasi",
      layoutMode: "standard",
      sections: [],
      nowMs: BASE_TIME + 9000,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_ALPHA.id,
      pageId: privacyPage.id,
      expectedVersion: privacyPage.version,
      nowMs: BASE_TIME + 9100,
    });
    const publishedPathsWithPrivacy = await loadPublishedTenantInternalLinkTargets(alphaDb);
    expect(publishedPathsWithPrivacy.has("/kebijakan-privasi")).toBe(true);
  });
});
