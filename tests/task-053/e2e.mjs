/* global process, console, document, window */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK053_SCREENSHOT_DIR || "/tmp/task-053-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Compiles REAL Astro SSR components from TASK-053 (`Layout.astro` with `managedHead={true}`,
 * `PublicSeoHead.astro`, `SectionRenderer.astro`, `SectionBranches.astro`, `FloatingWhatsApp.astro`,
 * `_OfferingDetailView.astro`, `_BlogTaxonomyArchiveView.astro`, `_PublicBreadcrumbs.astro`,
 * `_public-pages.css`) and crawls them in Playwright Chromium with `javaScriptEnabled: false`
 * at 360px and 1440px.
 */
async function buildRealAstroTask053Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t053-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(path.join(pagesDir, "blog/category"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "produk"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "layanan"), { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const publicSeoHeadImport = path.join(webDir, "src/components/seo/PublicSeoHead.astro");
  const sectionRendererImport = path.join(webDir, "src/themes/default/sections/SectionRenderer.astro");
  const sectionBranchesImport = path.join(webDir, "src/themes/default/sections/SectionBranches.astro");
  const floatingWaImport = path.join(webDir, "src/themes/default/components/FloatingWhatsApp.astro");
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const publicPagesCssImport = path.join(webDir, "src/pages/layanan/_public-pages.css");
  const breadcrumbsImport = path.join(webDir, "src/pages/layanan/_PublicBreadcrumbs.astro");
  const offeringDetailImport = path.join(webDir, "src/pages/layanan/_OfferingDetailView.astro");
  const blogTaxArchiveImport = path.join(
    webDir,
    "src/pages/blog/category/_BlogTaxonomyArchiveView.astro",
  );
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const publicRoutesImport = path.join(webDir, "src/core/public-routes.ts");

  fs.writeFileSync(
    path.join(srcDir, "fixtures.ts"),
    `
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { mapBranchesToSchemaInput } from "@punyasitus/core/branches/index";
import { injectTocHeadingAnchors } from "@punyasitus/core/seo/local-entity";
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { OFFERING_ROUTE_META, resolvePublicOfferingCta } from ${JSON.stringify(publicRoutesImport)};

export const PRIMARY_ORIGIN = "https://www.nusantara-arsitek.id";

export const SEO_TENANT = {
  tenantHandle: "nusantara-arsitek",
  tenantStatus: "active" as const,
  operatorHold: false,
  primaryHost: "www.nusantara-arsitek.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.nusantara-arsitek.id"],
  servingHost: "www.nusantara-arsitek.id",
};

export const SHELL = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: "compro" as const,
  themeStyle: buildSafeThemeStyleBlock(
    { primaryColor: "#176b51", secondaryColor: "#0f4c5c", borderRadiusPx: 8, fontFamily: "system" },
    "compro",
  ),
  site: {
    title: "PT Nusantara Arsitek",
    tagline: "Desain & Renovasi Kantor B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "PT Nusantara Arsitek",
    category: "contractor",
    description: "Konsultan arsitektur dan renovasi kantor korporat transparan di Indonesia.",
    address: "Jl. Kemang Raya No. 18",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    mapsUrl: "https://maps.google.com/?q=-6.2607,106.8132",
    weekdayHours: "Senin-Jumat 08:00-17:00 WIB",
    holidayHours: "Sabtu 09:00-13:00 WIB",
    phone: "021-7190011",
    whatsappE164: "6281234567890",
    email: "halo@nusantara-arsitek.id",
    socialLinks: [{ platform: "instagram" as const, url: "https://instagram.com/nusantaraarsitek" }],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "/layanan/audit-gedung", openInNewTab: false, children: [] },
      { label: "Produk", href: "/produk/kursi-ergonomis", openInNewTab: false, children: [] },
      { label: "Blog", href: "/blog/panduan-audit-gedung", openInNewTab: false, children: [] },
    ],
    footer: [
      { label: "Panduan Renovasi", href: "/blog/category/panduan-renovasi", openInNewTab: false, children: [] },
      { label: "Audit Gedung", href: "/layanan/audit-gedung", openInNewTab: false, children: [] },
    ],
    mobile: [],
  },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

export const ACTIVE_BRANCHES = [
  {
    id: 1,
    name: "Cabang BSD City",
    address: "Ruko Golden Boulevard Blok C1",
    city: "Tangerang Selatan",
    province: "Banten",
    postalCode: "15322",
    phone: "021-5319000",
    whatsappE164: "6281199887766",
    mapsUrl: "https://maps.google.com/?q=-6.3012,106.6524",
    weekdayHours: "Senin-Sabtu 09:00-17:00 WIB",
    holidayHours: "Minggu Tutup",
    timezone: "Asia/Jakarta",
    sortOrder: 0,
    isPrimary: true,
    active: true,
  },
  {
    id: 2,
    name: "Cabang Bandung",
    address: "Jl. Braga No. 55",
    city: "Bandung",
    province: "Jawa Barat",
    postalCode: "40111",
    phone: null,
    whatsappE164: "6281299001122",
    mapsUrl: "https://maps.google.com/?q=-6.9175,107.6098",
    weekdayHours: "Senin-Jumat 08:30-17:00 WIB",
    holidayHours: null,
    timezone: "Asia/Jakarta",
    sortOrder: 1,
    isPrimary: false,
    active: true,
  },
];

export const VERIFICATION_TOKENS = {
  google: "gscAlphaToken_2026_Valid",
  bing: "0123456789ABCDEF2026",
  yandex: null,
};

export const HERO_IMG_SRC = "/media/hero-kantor.svg";

export function buildHomeFixture() {
  const seo = {
    surface: "public_tenant" as const,
    routeKind: "homepage" as const,
    pathname: "/",
    tenant: SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
  };
  const faqItems = [
    {
      question: "Berapa lama survei lokasi kantor?",
      answer: "Survei dijadwalkan dalam 2 hari kerja dengan laporan teknis tertulis.",
    },
    {
      question: "Apakah tersedia estimasi RAB transparan?",
      answer: "Ya, setiap item pekerjaan dan material dirinci terbuka sebelum kontrak.",
    },
  ];
  const metadata = generateOpenGraphMetadata({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    locale: SHELL.site.locale,
    resourceTitle: "Beranda",
    resourceExcerpt: SHELL.business.description,
  });
  const schema = generateSchemaGraph({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    business: {
      businessName: SHELL.business.name,
      legalName: "PT Nusantara Arsitek Indonesia",
      businessCategory: SHELL.business.category,
      description: SHELL.business.description,
      address: SHELL.business.address,
      city: SHELL.business.city,
      province: SHELL.business.province,
      postalCode: SHELL.business.postalCode,
      phone: SHELL.business.phone,
      whatsappE164: SHELL.business.whatsappE164,
      publicEmail: SHELL.business.email,
      privacyContact: "privasi@nusantara-arsitek.id",
      mapsUrl: SHELL.business.mapsUrl,
      weekdayHours: SHELL.business.weekdayHours,
      holidayHours: SHELL.business.holidayHours,
      serviceAreas: ["Jakarta Selatan", "Tangerang Selatan", "Bandung"],
      socialLinks: SHELL.business.socialLinks,
      branches: mapBranchesToSchemaInput(ACTIVE_BRANCHES),
    },
    faqItems,
  });
  const sections = [
    {
      id: "hero-utama",
      type: "hero",
      enabled: true,
      config: {
        eyebrow: "Arsitektur & Renovasi B2B",
        heading: "Ruang Kantor Modern dengan Biaya Transparan",
        subheading: "Perencanaan teknis, pelaksanaan rapi, dan laporan progres terukur.",
        primaryCta: { label: "Konsultasi Layanan", href: "/layanan/audit-gedung", variant: "primary" },
        secondaryCta: { label: "Baca Panduan", href: "/blog/panduan-audit-gedung", variant: "secondary" },
        media: { src: HERO_IMG_SRC, alt: "Kantor modern hasil renovasi PT Nusantara Arsitek", width: 1200, height: 630 },
        highlights: ["Survei Terjadwal", "RAB Transparan", "Garansi Pengerjaan"],
      },
    },
    {
      id: "faq-utama",
      type: "faq",
      enabled: true,
      config: {
        eyebrow: "Tanya Jawab",
        heading: "Pertanyaan Umum Proyek Kantor",
        items: faqItems.map((f, idx) => ({ ...f, defaultOpen: idx === 0 })),
      },
    },
    {
      id: "lokasi-cabang",
      type: "branches",
      enabled: true,
      config: {
        eyebrow: "Jaringan Kantor",
        heading: "Kantor Pusat & Cabang",
        subheading: "Hubungi tim cabang terdekat untuk jadwal survei lokasi.",
        mapsLabel: "Buka Google Maps",
        branches: [],
      },
    },
  ];
  return { metadata, schemaGraph: schema.graph, sections };
}

export function buildArticleFixture() {
  const seo = {
    surface: "public_tenant" as const,
    routeKind: "post" as const,
    pathname: "/blog/panduan-audit-gedung",
    tenant: SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
  };
  const rawHtml = [
    "<p>Audit kelayakan gedung sebelum renovasi melindungi anggaran dan jadwal perusahaan Anda.</p>",
    "<h2>Pemeriksaan Struktur &amp; Beban</h2>",
    "<p>Periksa kondisi pelat lantai, kolom, serta jalur akses logistik material.</p>",
    "<h3>Evaluasi Kelistrikan &amp; HVAC</h3>",
    "<p>Pastikan kapasitas panel listrik dan sirkulasi udara memenuhi kebutuhan tim.</p>",
    "<h2>Penyusunan RAB &amp; Jadwal Kerja</h2>",
    "<p>Susun rincian biaya kerja secara terbuka bersama konsultan Anda. Lihat juga <a href='/layanan/audit-gedung'>layanan audit gedung resmi kami</a>.</p>",
  ].join("\\n");
  const anchored = injectTocHeadingAnchors(rawHtml);
  const author = {
    name: "Rina Kartika",
    bio: "Arsitek senior spesialis tata ruang kantor komersial dan audit kelayakan gedung B2B di Jabodetabek.",
    sameAs: [
      "https://www.linkedin.com/in/rina-kartika",
      "https://instagram.com/rinakartika.arsitek",
    ],
  };
  const breadcrumbs = [
    { label: "Beranda", href: "/" },
    { label: "Panduan Renovasi", href: "/blog/category/panduan-renovasi" },
    { label: "Panduan Audit Kelayakan Gedung Kantor", href: null },
  ];
  const metadata = generateOpenGraphMetadata({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    locale: SHELL.site.locale,
    resourceTitle: "Panduan Audit Kelayakan Gedung Kantor",
    resourceExcerpt: "Langkah teknis memeriksa struktur, MEP, dan RAB sebelum renovasi kantor.",
    ogType: "article",
    article: {
      publishedTime: "2026-10-15T08:00:00.000Z",
      modifiedTime: "2026-11-01T09:00:00.000Z",
      author: author.name,
      section: "Panduan Renovasi",
      tags: ["Audit Gedung", "B2B"],
    },
  });
  const schema = generateSchemaGraph({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    business: {
      businessName: SHELL.business.name,
      legalName: "PT Nusantara Arsitek Indonesia",
      businessCategory: SHELL.business.category,
    },
    pageTitle: "Panduan Audit Kelayakan Gedung Kantor",
    pageDescription: metadata.description,
    breadcrumbs: breadcrumbs.map((b) => ({ label: b.label, ...(b.href ? { path: b.href } : {}) })),
    article: {
      schemaType: "BlogPosting",
      headline: "Panduan Audit Kelayakan Gedung Kantor",
      description: metadata.description,
      datePublished: "2026-10-15T08:00:00.000Z",
      dateModified: "2026-11-01T09:00:00.000Z",
      authorName: author.name,
      authorBio: author.bio,
      authorSameAs: author.sameAs,
      section: "Panduan Renovasi",
      tags: ["Audit Gedung", "B2B"],
    },
  });
  return { metadata, schemaGraph: schema.graph, anchored, author, breadcrumbs };
}

export function buildTaxonomyArchiveFixture() {
  const seo = {
    surface: "public_tenant" as const,
    routeKind: "category_archive" as const,
    pathname: "/blog/category/panduan-renovasi",
    tenant: SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
    archiveEnabled: true,
    publishedItemCount: 12,
    totalPages: 2,
    taxonomyIndexOptIn: true,
    taxonomyHasUsefulIntro: true,
  };
  const breadcrumbs = [
    { label: "Beranda", href: "/" },
    { label: "Panduan Renovasi", href: null },
  ];
  const metadata = generateOpenGraphMetadata({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    locale: SHELL.site.locale,
    resourceTitle: "Kategori: Panduan Renovasi",
    resourceExcerpt: "Kumpulan panduan teknis renovasi kantor, audit bangunan, dan efisiensi ruang kerja.",
  });
  const schema = generateSchemaGraph({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    business: { businessName: SHELL.business.name, businessCategory: SHELL.business.category },
    pageTitle: "Kategori: Panduan Renovasi",
    pageDescription: metadata.description,
    breadcrumbs: breadcrumbs.map((b) => ({ label: b.label, ...(b.href ? { path: b.href } : {}) })),
  });
  return {
    kind: "blog_taxonomy_archive" as const,
    taxonomyKind: "post_category" as const,
    http: { status: 200 as const, headers: {} },
    tenant: { id: "t_alpha", handle: "nusantara-arsitek", name: SHELL.site.title } as any,
    shell: SHELL,
    primaryOrigin: PRIMARY_ORIGIN,
    currentPath: "/blog/category/panduan-renovasi",
    pageTitle: "Kategori: Panduan Renovasi",
    taxonomy: {
      id: 1,
      kind: "post_category" as const,
      offeringType: null,
      parentId: null,
      depth: 0,
      slug: "panduan-renovasi",
      name: "Panduan Renovasi",
      description: "Kumpulan panduan teknis renovasi kantor, audit bangunan, dan efisiensi ruang kerja.",
      sortOrder: 0,
      indexOptIn: true,
      hasUsefulIntro: true,
      publishedCount: 12,
      version: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    childCategories: [],
    items: [
      {
        slug: "panduan-audit-gedung",
        href: "/blog/panduan-audit-gedung",
        title: "Panduan Audit Kelayakan Gedung Kantor",
        excerpt: "Langkah teknis memeriksa struktur, MEP, dan RAB sebelum renovasi kantor.",
        authorName: "Rina Kartika",
        categoryName: "Panduan Renovasi",
        publishedAtIso: "2026-10-15T08:00:00.000Z",
        publishedDateLabel: "15 Oktober 2026",
        readingTimeMinutes: 4,
        coverImage: null,
      },
    ],
    pagination: {
      page: 1,
      pageSize: 9,
      totalItems: 12,
      totalPages: 2,
      offset: 0,
      prevHref: null,
      nextHref: "/blog/category/panduan-renovasi?page=2",
      pageLinks: [
        { page: 1, href: "/blog/category/panduan-renovasi", current: true },
        { page: 2, href: "/blog/category/panduan-renovasi?page=2", current: false },
      ],
    },
    breadcrumbs,
    seoMetadata: metadata,
    schemaGraph: schema.graph,
    floatingWa: {
      phone: SHELL.business.whatsappE164,
      businessName: SHELL.business.name,
      operatingHours: SHELL.business.weekdayHours,
      holidayHours: SHELL.business.holidayHours,
      primaryOrigin: PRIMARY_ORIGIN,
      canonicalPath: "/blog/category/panduan-renovasi",
      itemTitle: "Panduan Renovasi",
      greetingMessage: "Halo PT Nusantara Arsitek",
    },
  };
}

export function buildProductDetailFixture() {
  const seo = {
    surface: "public_tenant" as const,
    routeKind: "offering" as const,
    pathname: "/produk/kursi-ergonomis",
    tenant: SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
    resourceSeo: { schemaType: "Product" as const },
  };
  const breadcrumbs = [
    { label: "Beranda", href: "/" },
    { label: "Produk", href: "/produk/kursi-ergonomis" },
    { label: "Kursi Kerja Ergonomis Pro", href: null },
  ];
  const metadata = generateOpenGraphMetadata({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    locale: SHELL.site.locale,
    resourceTitle: "Kursi Kerja Ergonomis Pro",
    resourceExcerpt: "Kursi ergonomis bersertifikat untuk kenyamanan tim kantor.",
    offeringType: "product",
  });
  const schema = generateSchemaGraph({
    seo,
    tenantId: "t_alpha",
    siteName: SHELL.site.title,
    siteTagline: SHELL.site.tagline,
    business: { businessName: SHELL.business.name, businessCategory: SHELL.business.category },
    pageTitle: "Kursi Kerja Ergonomis Pro",
    pageDescription: metadata.description,
    breadcrumbs: breadcrumbs.map((b) => ({ label: b.label, ...(b.href ? { path: b.href } : {}) })),
    offering: {
      offeringType: "product",
      title: "Kursi Kerja Ergonomis Pro",
      summary: "Kursi ergonomis bersertifikat untuk kenyamanan tim kantor.",
      priceMode: "fixed",
      price: 2_850_000,
      ctaMode: "whatsapp",
    },
  });
  return {
    kind: "offering_detail" as const,
    http: { status: 200 as const, headers: {} },
    tenant: { id: "t_alpha", handle: "nusantara-arsitek", name: SHELL.site.title } as any,
    shell: SHELL,
    primaryOrigin: PRIMARY_ORIGIN,
    currentPath: "/produk/kursi-ergonomis",
    descriptor: OFFERING_ROUTE_META.product,
    pageTitle: "Kursi Kerja Ergonomis Pro",
    offering: {
      offeringType: "product" as const,
      slug: "kursi-ergonomis",
      href: "/produk/kursi-ergonomis",
      title: "Kursi Kerja Ergonomis Pro",
      summary: "Kursi ergonomis bersertifikat untuk kenyamanan tim kantor.",
      descriptionHtml: "<p>Dilengkapi lumbar support dan garansi komponen 3 tahun.</p>",
      categoryNames: ["Furnitur Kantor"],
      badge: "Garansi 3 Tahun",
      unitStatus: null,
      unitStatusLabel: null,
      priceMode: "fixed" as const,
      priceText: "Rp 2.850.000",
      originalPriceText: null,
      negotiable: false,
      coverImage: null,
      galleryImages: [],
      cta: resolvePublicOfferingCta(
        {
          offeringType: "product",
          slug: "kursi-ergonomis",
          title: "Kursi Kerja Ergonomis Pro",
          priceMode: "fixed",
          price: 2_850_000,
          negotiable: false,
          ctaMode: "whatsapp",
        },
        { primaryOrigin: PRIMARY_ORIGIN, tenantWhatsappE164: SHELL.business.whatsappE164, isDetailPage: true },
      ),
      fallbackContactHref: "tel:+62217190011",
      attributes: {},
      serviceAttributes: null,
      productAttributes: { brand: "Nusantara Office", sku: "NS-ERG-01", stockStatus: "ready" },
      tourAttributes: null,
      vehicleAttributes: null,
      vehicleCreditRows: [],
      publishedDateLabel: "15 Oktober 2026",
      modifiedDateLabel: "15 Oktober 2026",
    },
    relatedOfferings: [],
    breadcrumbs,
    seoMetadata: metadata,
    schemaGraph: schema.graph,
    floatingWa: {
      phone: SHELL.business.whatsappE164,
      businessName: SHELL.business.name,
      operatingHours: SHELL.business.weekdayHours,
      holidayHours: SHELL.business.holidayHours,
      primaryOrigin: PRIMARY_ORIGIN,
      canonicalPath: "/produk/kursi-ergonomis",
      itemTitle: "Kursi Kerja Ergonomis Pro",
      itemPrice: "Rp 2.850.000",
      greetingMessage: "Halo PT Nusantara Arsitek",
    },
  };
}
`,
  );

  // Page 1: `/` Homepage (Hero non-lazy + FAQ + Multi-Branch SectionBranches + PublicSeoHead + Layout managedHead)
  fs.writeFileSync(
    path.join(pagesDir, "index.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import Layout from ${JSON.stringify(layoutImport)};
import PublicSeoHead from ${JSON.stringify(publicSeoHeadImport)};
import SectionRenderer from ${JSON.stringify(sectionRendererImport)};
import FloatingWhatsApp from ${JSON.stringify(floatingWaImport)};
import { ACTIVE_BRANCHES, buildHomeFixture, PRIMARY_ORIGIN, SHELL, VERIFICATION_TOKENS } from "../fixtures.ts";

const data = buildHomeFixture();
---
<Layout shell={SHELL} managedHead={true} currentPath="/">
  <PublicSeoHead
    slot="head"
    metadata={data.metadata}
    schemaGraph={data.schemaGraph}
    seoAutopilotEnabled={true}
    publishedVerificationTokens={VERIFICATION_TOKENS}
    blogEnabled={true}
    siteName={SHELL.site.title}
  />
  <SectionRenderer
    sections={data.sections}
    themeId={SHELL.themeId}
    routePath="/"
    isHomepage={true}
    mode="published"
    businessCategory={SHELL.business.category}
    primaryOrigin={PRIMARY_ORIGIN}
    fallbackBranches={ACTIVE_BRANCHES}
    businessName={SHELL.business.name}
    fallbackBusiness={SHELL.business}
  />
  <FloatingWhatsApp
    slot="floating"
    shell={SHELL}
    phone={SHELL.business.whatsappE164}
    businessName={SHELL.business.name}
    greetingMessage="Halo PT Nusantara Arsitek"
    operatingHours={SHELL.business.weekdayHours}
    holidayHours={SHELL.business.holidayHours}
    primaryOrigin={PRIMARY_ORIGIN}
    canonicalPath="/"
    itemTitle={SHELL.site.title}
  />
</Layout>
`,
  );

  // Page 2: `/blog/panduan-audit-gedung` (Article + TOC Anchors + Rich Author Box + Breadcrumbs + PublicSeoHead)
  fs.writeFileSync(
    path.join(pagesDir, "blog/panduan-audit-gedung.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import { formatAuthorSameAsLabel } from "@punyasitus/core/seo/local-entity";
import Layout from ${JSON.stringify(layoutImport)};
import PublicSeoHead from ${JSON.stringify(publicSeoHeadImport)};
import PublicBreadcrumbs from ${JSON.stringify(breadcrumbsImport)};
import FloatingWhatsApp from ${JSON.stringify(floatingWaImport)};
import { buildArticleFixture, PRIMARY_ORIGIN, SHELL, VERIFICATION_TOKENS } from "../../fixtures.ts";

const data = buildArticleFixture();
---
<Layout shell={SHELL} managedHead={true} currentPath="/blog/panduan-audit-gedung">
  <PublicSeoHead
    slot="head"
    metadata={data.metadata}
    schemaGraph={data.schemaGraph}
    seoAutopilotEnabled={true}
    publishedVerificationTokens={VERIFICATION_TOKENS}
    blogEnabled={true}
    siteName={SHELL.site.title}
  />
  <article class="ps-article-shell" data-testid="blog-detail-article">
    <div class="ps-container">
      <header class="ps-article-header">
        <PublicBreadcrumbs items={data.breadcrumbs} />
        <div class="ps-offering-badges" data-testid="blog-category-links">
          <a href="/blog/category/panduan-renovasi" class="ps-badge ps-badge--link">Panduan Renovasi</a>
        </div>
        <h1 class="ps-route-title" data-testid="blog-detail-title">Panduan Audit Kelayakan Gedung Kantor</h1>
        <p class="ps-route-lead">Langkah teknis memeriksa struktur, MEP, dan RAB sebelum renovasi kantor.</p>
        <div class="ps-article-meta">
          <span>Oleh <strong>{data.author.name}</strong></span>
          <time datetime="2026-10-15T08:00:00.000Z">Diterbitkan 15 Oktober 2026</time>
          <span>4 menit baca</span>
        </div>
      </header>
      <div class="ps-article-layout ps-article-layout--with-toc">
        <div>
          <div class="ps-prose" data-testid="blog-detail-body" set:html={data.anchored.html} />
          <aside class="ps-author-box" aria-label="Tentang penulis" data-testid="blog-author-box">
            <div class="ps-author-box__row">
              <span class="ps-author-avatar-fallback" aria-hidden="true">RK</span>
              <div class="ps-author-box__body">
                <p class="ps-author-name" data-testid="blog-author-name">{data.author.name}</p>
                <p class="ps-author-bio" data-testid="blog-author-bio">{data.author.bio}</p>
                <ul class="ps-author-links" data-testid="blog-author-links">
                  {data.author.sameAs.map((href) => (
                    <li>
                      <a href={href} target="_blank" rel="noopener noreferrer" class="ps-author-sameas-link">
                        {formatAuthorSameAsLabel(href)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>
        </div>
        <nav class="ps-toc" aria-label="Daftar isi" data-testid="blog-detail-toc">
          <h2 class="ps-toc-heading">Daftar Isi</h2>
          <ol class="ps-toc-list">
            {data.anchored.toc.map((entry) => (
              <li class={\`ps-toc-item--h\${entry.level}\`}>
                <a href={\`#\${entry.id}\`} class="ps-toc-link">{entry.text}</a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  </article>
  <FloatingWhatsApp
    slot="floating"
    shell={SHELL}
    phone={SHELL.business.whatsappE164}
    businessName={SHELL.business.name}
    greetingMessage="Halo PT Nusantara Arsitek"
    operatingHours={SHELL.business.weekdayHours}
    holidayHours={SHELL.business.holidayHours}
    primaryOrigin={PRIMARY_ORIGIN}
    canonicalPath="/blog/panduan-audit-gedung"
    itemTitle="Panduan Audit Kelayakan Gedung Kantor"
  />
</Layout>
`,
  );

  // Page 3: `/blog/category/panduan-renovasi` (Real _BlogTaxonomyArchiveView.astro)
  fs.writeFileSync(
    path.join(pagesDir, "blog/category/panduan-renovasi.astro"),
    `---
import BlogTaxonomyArchiveView from ${JSON.stringify(blogTaxArchiveImport)};
import { buildTaxonomyArchiveFixture, SHELL, VERIFICATION_TOKENS } from "../../../fixtures.ts";

const result = buildTaxonomyArchiveFixture();
---
<BlogTaxonomyArchiveView
  result={result}
  headProps={{
    metadata: result.seoMetadata,
    schemaGraph: result.schemaGraph,
    seoAutopilotEnabled: true,
    publishedVerificationTokens: VERIFICATION_TOKENS,
    blogEnabled: true,
    siteName: SHELL.site.title,
    searchAppearance: null,
  }}
/>
`,
  );

  // Page 4: `/produk/kursi-ergonomis` (Real _OfferingDetailView.astro)
  fs.writeFileSync(
    path.join(pagesDir, "produk/kursi-ergonomis.astro"),
    `---
import OfferingDetailView from ${JSON.stringify(offeringDetailImport)};
import { buildProductDetailFixture, SHELL, VERIFICATION_TOKENS } from "../../fixtures.ts";

const result = buildProductDetailFixture();
---
<OfferingDetailView
  result={result}
  headProps={{
    metadata: result.seoMetadata,
    schemaGraph: result.schemaGraph,
    seoAutopilotEnabled: true,
    publishedVerificationTokens: VERIFICATION_TOKENS,
    blogEnabled: true,
    siteName: SHELL.site.title,
    searchAppearance: null,
  }}
  categoryLinks={[{ name: "Furnitur Kantor", slug: "furnitur-kantor", href: "/blog/category/panduan-renovasi" }]}
/>
`,
  );

  // Page 5: `/noindex-home` (Real Layout managedHead={true} + PublicSeoHead under siteVisibility === "noindex")
  fs.writeFileSync(
    path.join(pagesDir, "noindex-home.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import Layout from ${JSON.stringify(layoutImport)};
import PublicSeoHead from ${JSON.stringify(publicSeoHeadImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { SEO_TENANT, SHELL } from "../fixtures.ts";

const noindexShell = {
  ...SHELL,
  site: { ...SHELL.site, siteVisibility: "noindex" as const },
};
const noindexMeta = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    tenant: SEO_TENANT,
    siteVisibility: "noindex",
    resourceState: "published",
  },
  tenantId: "t_alpha",
  siteName: noindexShell.site.title,
  siteTagline: noindexShell.site.tagline,
  locale: noindexShell.site.locale,
});
---
<Layout shell={noindexShell} managedHead={true} currentPath="/">
  <PublicSeoHead
    slot="head"
    metadata={noindexMeta}
    schemaGraph={null}
    seoAutopilotEnabled={true}
    publishedVerificationTokens={null}
    blogEnabled={false}
    siteName={noindexShell.site.title}
  />
  <section class="ps-archive-section">
    <div class="ps-container">
      <h1>{noindexShell.site.title} (Noindex)</h1>
    </div>
  </section>
</Layout>
`,
  );

  // Assert real apps/web/src/pages/index.astro is wired through TASK-053 single-authority head & branches
  const realIndexSrc = fs.readFileSync(path.join(webDir, "src/pages/index.astro"), "utf8");
  assert(
    realIndexSrc.includes("enrichPublicPageRouteResult") &&
      realIndexSrc.includes("PublicSeoHead") &&
      realIndexSrc.includes("managedHead={true}") &&
      realIndexSrc.includes("SectionBranches") &&
      !realIndexSrc.includes("<SEOHead"),
    "apps/web/src/pages/index.astro must use enrichPublicPageRouteResult + PublicSeoHead + managedHead={true} + SectionBranches",
  );

  // Unused import check prevention: ensure SectionBranches is exercised cleanly via SectionRenderer
  assert(fs.existsSync(sectionBranchesImport), "SectionBranches.astro must exist");

  const { build } = await import(astroEntryUrl);
  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "silent",
    vite: { logLevel: "silent" },
  });

  return { tmpRoot, outDir };
}

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || "/").split("?")[0];
      if (reqPath === "/media/hero-kantor.svg") {
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#176b51"/><rect x="48" y="48" width="1104" height="534" rx="20" fill="#0f4c5c" opacity="0.55"/><text x="90" y="290" fill="#ffffff" font-size="48" font-weight="700" font-family="system-ui, sans-serif">PT Nusantara Arsitek</text><text x="90" y="360" fill="#e2f5ee" font-size="28" font-family="system-ui, sans-serif">Desain &amp; Renovasi Kantor Modern B2B</text></svg>`,
        );
        return;
      }
      const candidates = [
        path.join(rootDir, reqPath === "/" ? "index.html" : reqPath),
        path.join(rootDir, reqPath, "index.html"),
        path.join(rootDir, `${reqPath}.html`),
      ];
      let filePath = null;
      for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          filePath = c;
          break;
        }
      }
      if (!filePath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".js"
              ? "application/javascript; charset=utf-8"
              : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function inspectHeadAndLayout(page, routeLabel) {
  return page.evaluate((label) => {
    const titles = document.querySelectorAll("head title");
    const robotsMetas = Array.from(document.querySelectorAll('head meta[name="robots"]')).map(
      (el) => el.getAttribute("content") || "",
    );
    const canonicals = Array.from(document.querySelectorAll('head link[rel="canonical"]')).map(
      (el) => el.getAttribute("href") || "",
    );
    const rssLinks = Array.from(
      document.querySelectorAll('head link[type="application/rss+xml"]'),
    ).map((el) => el.getAttribute("href") || "");
    const gscMeta =
      document.querySelector('head meta[name="google-site-verification"]')?.getAttribute("content") ||
      null;
    const jsonLdScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).map((el) => el.textContent || "");
    const h1Count = document.querySelectorAll("h1").length;
    const mapIframes = document.querySelectorAll(
      'iframe[src*="maps"], iframe[src*="openstreetmap"]',
    ).length;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;

    return {
      label,
      titleCount: titles.length,
      titleText: titles[0]?.textContent || "",
      robotsCount: robotsMetas.length,
      robots: robotsMetas[0] || "",
      canonicalCount: canonicals.length,
      canonical: canonicals[0] || "",
      rssHref: rssLinks[0] || null,
      gscMeta,
      jsonLdCount: jsonLdScripts.length,
      jsonLdRaw: jsonLdScripts[0] || "",
      h1Count,
      mapIframes,
      overflow,
      bodyText: document.body.innerText,
    };
  }, routeLabel);
}

async function main() {
  const { tmpRoot, outDir } = await buildRealAstroTask053Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // STRICT NO-JS CRAWL CONTEXT (javaScriptEnabled: false)
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    const routes = [
      {
        name: "home",
        path: "/",
        expectedCanonical: "https://www.nusantara-arsitek.id/",
        expectedNodeTypes: ["WebSite", "HomeAndConstructionBusiness", "WebPage", "FAQPage"],
        shotPrefix: "home",
      },
      {
        name: "article",
        path: "/blog/panduan-audit-gedung",
        expectedCanonical: "https://www.nusantara-arsitek.id/blog/panduan-audit-gedung",
        expectedNodeTypes: ["WebSite", "WebPage", "BreadcrumbList", "BlogPosting"],
        shotPrefix: "article-toc-author",
      },
      {
        name: "taxonomy",
        path: "/blog/category/panduan-renovasi",
        expectedCanonical: "https://www.nusantara-arsitek.id/blog/category/panduan-renovasi",
        expectedNodeTypes: ["WebSite", "CollectionPage", "BreadcrumbList"],
        shotPrefix: "taxonomy-archive",
      },
      {
        name: "product",
        path: "/produk/kursi-ergonomis",
        expectedCanonical: "https://www.nusantara-arsitek.id/produk/kursi-ergonomis",
        expectedNodeTypes: ["WebSite", "WebPage", "BreadcrumbList", "Product"],
        shotPrefix: "offering-detail",
      },
    ];

    for (const route of routes) {
      // 1440px Desktop Check & Screenshot
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: "load" });
      const info = await inspectHeadAndLayout(page, route.name);

      assert(info.titleCount === 1, `${route.name}: expected 1 <title>, got ${info.titleCount}`);
      assert(
        info.robotsCount === 1,
        `${route.name}: expected 1 <meta name="robots">, got ${info.robotsCount}`,
      );
      assert(
        info.robots.includes("max-image-preview:large") && info.robots.includes("index, follow"),
        `${route.name}: expected default indexable robots directives, got "${info.robots}"`,
      );
      assert(
        info.canonicalCount === 1 && info.canonical === route.expectedCanonical,
        `${route.name}: canonical mismatch (${info.canonical})`,
      );
      assert(
        info.rssHref === "https://www.nusantara-arsitek.id/blog/feed.xml",
        `${route.name}: expected RSS alternate link, got ${info.rssHref}`,
      );
      assert(
        info.gscMeta === "gscAlphaToken_2026_Valid",
        `${route.name}: expected published Google verification meta`,
      );
      assert(
        info.jsonLdCount === 1,
        `${route.name}: expected exactly 1 JSON-LD script (no second schema authority), got ${info.jsonLdCount}`,
      );
      assert(info.h1Count === 1, `${route.name}: expected exactly 1 <h1>, got ${info.h1Count}`);
      assert(info.mapIframes === 0, `${route.name}: zero third-party map iframes before consent`);
      assert(info.overflow <= 1, `${route.name} @1440px: horizontal overflow ${info.overflow}px`);

      const parsedGraph = JSON.parse(info.jsonLdRaw);
      assert(parsedGraph["@context"] === "https://schema.org", `${route.name}: bad @context`);
      const types = new Set(parsedGraph["@graph"].map((n) => n["@type"]));
      for (const expectedType of route.expectedNodeTypes) {
        assert(types.has(expectedType), `${route.name}: missing @type ${expectedType}`);
      }
      assert(
        !info.jsonLdRaw.includes("AggregateRating") &&
          !info.jsonLdRaw.includes("ProfessionalService") &&
          !info.jsonLdRaw.includes("shippingDetails"),
        `${route.name}: forbidden fabricated/deprecated schema property found`,
      );

      // Route-specific No-JS visible parity assertions
      if (route.name === "home") {
        const heroCheck = await page.evaluate(() => {
          const img = document.querySelector(".ps-hero-media img");
          const branchCards = document.querySelectorAll('[data-testid^="branch-card-"]');
          const bsdCardText =
            document.querySelector('[data-testid="branch-card-1"]')?.textContent || "";
          const telLinks = document.querySelectorAll('a[href^="tel:"]').length;
          const waLinks = document.querySelectorAll('a[href^="https://wa.me/"]').length;
          const mapsLinks = document.querySelectorAll('a[href*="maps.google.com"]').length;
          return {
            heroLoading: img?.getAttribute("loading"),
            heroWidth: img?.getAttribute("width"),
            heroHeight: img?.getAttribute("height"),
            branchCount: branchCards.length,
            bsdCardText,
            telLinks,
            waLinks,
            mapsLinks,
          };
        });
        assert(heroCheck.heroLoading === "eager", `Hero image must be non-lazy, got ${heroCheck.heroLoading}`);
        assert(heroCheck.heroWidth === "1200" && heroCheck.heroHeight === "630", "Hero dimensions required");
        assert(heroCheck.branchCount === 2, `Expected 2 visible branches, got ${heroCheck.branchCount}`);
        assert(heroCheck.bsdCardText.includes("Ruko Golden Boulevard"), "Branch address must be visible");
        assert(heroCheck.telLinks >= 1 && heroCheck.waLinks >= 1 && heroCheck.mapsLinks >= 1, "Contact & static map links required without JS");

        const branchNodes = parsedGraph["@graph"].filter(
          (n) => typeof n["@id"] === "string" && n["@id"].includes("#branch-"),
        );
        assert(branchNodes.length === 2, "Expected 2 branch nodes in @graph");
        assert(branchNodes.find((b) => b.name === "Cabang BSD City")?.telephone === "+62215319000", "BSD telephone parity");
        assert(branchNodes.find((b) => b.name === "Cabang Bandung")?.telephone === undefined, "WA-only branch must not fabricate telephone");
      }

      if (route.name === "article") {
        const articleCheck = await page.evaluate(() => {
          const tocLinks = Array.from(document.querySelectorAll('[data-testid="blog-detail-toc"] a')).map(
            (a) => a.getAttribute("href") || "",
          );
          const allTargetsExist = tocLinks.every((href) => {
            if (!href.startsWith("#")) return false;
            return Boolean(document.getElementById(href.slice(1)));
          });
          const authorName =
            document.querySelector('[data-testid="blog-author-name"]')?.textContent?.trim() || "";
          const authorBio =
            document.querySelector('[data-testid="blog-author-bio"]')?.textContent?.trim() || "";
          const sameAsHrefs = Array.from(
            document.querySelectorAll('[data-testid="blog-author-links"] a'),
          ).map((a) => a.getAttribute("href") || "");
          return { tocLinks, allTargetsExist, authorName, authorBio, sameAsHrefs };
        });
        assert(articleCheck.tocLinks.length === 3, `Expected 3 TOC links, got ${articleCheck.tocLinks.length}`);
        assert(articleCheck.allTargetsExist, "Every TOC #anchor link must match a server-rendered heading id");
        assert(articleCheck.authorName === "Rina Kartika", "Author name mismatch");
        assert(articleCheck.sameAsHrefs.length === 2, "Expected 2 author sameAs links");

        const postNode = parsedGraph["@graph"].find((n) => n["@type"] === "BlogPosting");
        assert(postNode?.author?.name === articleCheck.authorName, "JSON-LD Person name must match visible author");
        assert(postNode?.author?.sameAs?.length === 2, "JSON-LD Person sameAs parity");
      }

      if (route.name === "taxonomy") {
        const taxCheck = await page.evaluate(() => ({
          hasPaginationNext: Boolean(document.querySelector('a[rel="next"]')),
          hasCardLink: Boolean(document.querySelector('[data-testid="blog-card-link"]')),
          hasBreadcrumbs: Boolean(document.querySelector('[data-testid="public-breadcrumbs"]')),
        }));
        assert(
          taxCheck.hasPaginationNext && taxCheck.hasCardLink && taxCheck.hasBreadcrumbs,
          "Taxonomy archive must render breadcrumbs, real card anchors, and crawlable pagination without JS",
        );
      }

      if (route.name === "product") {
        const prodNode = parsedGraph["@graph"].find((n) => n["@type"] === "Product");
        assert(prodNode?.offers?.price === 2850000, "Product Offer price parity");
        assert(info.bodyText.includes("Rp 2.850.000"), "Visible IDR price parity");
      }

      await page.screenshot({
        path: path.join(screenshotDir, `${route.shotPrefix}-1440.png`),
        fullPage: true,
      });

      // 360px Mobile Check & Screenshot
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: "load" });
      const mobileInfo = await inspectHeadAndLayout(page, `${route.name}-360`);
      assert(
        mobileInfo.overflow <= 1,
        `${route.name} @360px: horizontal overflow ${mobileInfo.overflow}px`,
      );
      await page.screenshot({
        path: path.join(screenshotDir, `${route.shotPrefix}-360.png`),
        fullPage: true,
      });
    }

    // Verify noindex homepage renders EXACTLY ONE <meta name="robots" content="noindex, nofollow"> (zero duplicates!)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/noindex-home`, { waitUntil: "load" });
    const noindexInfo = await inspectHeadAndLayout(page, "noindex-home");
    assert(noindexInfo.titleCount === 1, `noindex-home: expected 1 <title>, got ${noindexInfo.titleCount}`);
    assert(
      noindexInfo.robotsCount === 1,
      `noindex-home: expected EXACTLY 1 <meta name="robots">, got ${noindexInfo.robotsCount}`,
    );
    assert(
      noindexInfo.robots === "noindex, follow",
      `noindex-home: expected canonical siteVisibility noindex directive "noindex, follow", got "${noindexInfo.robots}"`,
    );
    assert(noindexInfo.jsonLdCount === 0, `noindex-home: expected 0 JSON-LD scripts, got ${noindexInfo.jsonLdCount}`);

    await context.close();
    console.log(
      `TASK-053 E2E PASS: Zero-JS crawlable SSR HTML & single-authority Schema.org @graph verified across homepage (multi-branch + FAQ + non-lazy hero), article (server-rendered TOC anchors + Author Box/Person), taxonomy archive (breadcrumbs + pagination), and product detail at 360px & 1440px. Screenshots saved to ${screenshotDir}`,
    );
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
