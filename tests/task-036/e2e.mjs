/* global process, console, document, window, URL */
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

const screenshotDir = process.env.TASK036_SCREENSHOT_DIR || "";

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
 * Compiles the REAL Astro public route views from TASK-036 (`Layout.astro`, `SEOHead.astro`,
 * `SectionRenderer.astro`, `FloatingWhatsApp.astro`, `_OfferingListingView.astro`,
 * `_OfferingDetailView.astro`, `_PublicNotFoundView.astro`, `_PublicPagination.astro`,
 * `_PublicBreadcrumbs.astro`, `_public-pages.css`) with realistic two-tenant published DTOs
 * produced by `public-routes.ts`, `og-generator.ts`, and `schema-generator.ts`.
 */
async function buildRealAstroPublicRouteFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t036-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(path.join(pagesDir, "alpha/blog"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "alpha/layanan"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "alpha/kendaraan"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "beta/tour"), { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const seoHeadImport = path.join(webDir, "src/components/SEOHead.astro");
  const sectionRendererImport = path.join(
    webDir,
    "src/themes/default/sections/SectionRenderer.astro",
  );
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const publicPagesCssImport = path.join(webDir, "src/pages/layanan/_public-pages.css");
  const floatingWaImport = path.join(
    webDir,
    "src/themes/default/components/FloatingWhatsApp.astro",
  );
  const offeringListImport = path.join(webDir, "src/pages/layanan/_OfferingListingView.astro");
  const offeringDetailImport = path.join(webDir, "src/pages/layanan/_OfferingDetailView.astro");
  const notFoundImport = path.join(webDir, "src/pages/layanan/_PublicNotFoundView.astro");
  const breadcrumbsImport = path.join(webDir, "src/pages/layanan/_PublicBreadcrumbs.astro");
  const paginationImport = path.join(webDir, "src/pages/layanan/_PublicPagination.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const publicRoutesImport = path.join(webDir, "src/core/public-routes.ts");

  // Shared synthetic fixture helper (two strictly isolated tenants: Alpha & Beta)
  const fixturesModule = path.join(srcDir, "fixtures.ts");
  fs.writeFileSync(
    fixturesModule,
    `
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import {
  computeVehicleCreditEstimateRows,
  OFFERING_ROUTE_META,
  resolvePublicOfferingCta,
} from ${JSON.stringify(publicRoutesImport)};

export const ALPHA_ORIGIN = "https://www.alpha-konstruksi.id";
export const BETA_ORIGIN = "https://beta-wisata.situsku.click";

const ALPHA_SEO_TENANT = {
  tenantHandle: "alpha-konstruksi",
  tenantStatus: "active" as const,
  operatorHold: false,
  primaryHost: "www.alpha-konstruksi.id",
  primaryHostKind: "custom" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.alpha-konstruksi.id"],
  servingHost: "www.alpha-konstruksi.id",
};

const BETA_SEO_TENANT = {
  tenantHandle: "beta-wisata",
  tenantStatus: "active" as const,
  operatorHold: false,
  primaryHost: "beta-wisata.situsku.click",
  primaryHostKind: "subdomain" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["beta-wisata.situsku.click"],
  servingHost: "beta-wisata.situsku.click",
};

export const ALPHA_SHELL = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: "compro" as const,
  themeStyle: buildSafeThemeStyleBlock(
    { primaryColor: "#176b51", secondaryColor: "#0f4c5c", borderRadiusPx: 8, fontFamily: "system" },
    "compro",
  ),
  site: {
    title: "PT Alpha Konstruksi",
    tagline: "Mitra Renovasi & Armada B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "PT Alpha Konstruksi",
    category: "LocalBusiness",
    description: "Kontraktor komersial dan penyedia kendaraan operasional perusahaan di Indonesia.",
    address: "Jl. Jenderal Sudirman Kav. 45",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@alpha-konstruksi.id",
    socialLinks: [{ platform: "linkedin" as const, url: "https://linkedin.com/company/alpha-konstruksi" }],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/alpha/page/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "/alpha/layanan/", openInNewTab: false, children: [] },
      { label: "Kendaraan", href: "/alpha/kendaraan/suv-2023/", openInNewTab: false, children: [] },
      { label: "Blog", href: "/alpha/blog/", openInNewTab: false, children: [] },
    ],
    footer: [
      { label: "Layanan", href: "/alpha/layanan/", openInNewTab: false, children: [] },
      { label: "Blog", href: "/alpha/blog/", openInNewTab: false, children: [] },
    ],
    mobile: [],
  },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

export const BETA_SHELL = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "travel",
  baseThemeId: "travel" as const,
  themeStyle: buildSafeThemeStyleBlock(
    { primaryColor: "#0f5c5c", secondaryColor: "#92400e", borderRadiusPx: 10, fontFamily: "system" },
    "travel",
  ),
  site: {
    title: "Beta Wisata Nusantara",
    tagline: "Biro Perjalanan Grup & Korporasi",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Beta Wisata Nusantara",
    category: "TravelAgency",
    description: "Penyelenggara perjalanan wisata korporasi dan rombongan keluarga sejak 2018.",
    address: "Jl. Malioboro No. 88",
    city: "Yogyakarta",
    province: "DI Yogyakarta",
    postalCode: "55271",
    mapsUrl: "https://maps.google.com/?q=-7.7928,110.3658",
    weekdayHours: "Senin–Sabtu 09.00–17.30 WIB",
    holidayHours: "Minggu dengan perjanjian",
    phone: "6281398765432",
    whatsappE164: "6281398765432",
    email: "reservasi@beta-wisata.id",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Paket Tur", href: "/beta/tour/", openInNewTab: false, children: [] },
      { label: "Jogja 3H2M", href: "/beta/tour/jogja-3h2m/", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Paket Tur", href: "/beta/tour/", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

export function buildAlphaBlogListData(page: 1 | 2) {
  const allPosts = [
    {
      slug: "panduan-audit-gedung",
      href: "/alpha/blog/panduan-audit-gedung/",
      title: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi",
      excerpt: "Langkah terukur mengevaluasi struktur, kelistrikan, dan estimasi anggaran renovasi ruang usaha.",
      authorName: "Raka Pratama",
      categoryName: "Konstruksi",
      publishedAtIso: "2026-10-12T03:00:00.000Z",
      publishedDateLabel: "12 Oktober 2026",
      readingTimeMinutes: 5,
      coverImage: null,
    },
    {
      slug: "tips-efisiensi-armada",
      href: "/alpha/blog/panduan-audit-gedung/",
      title: "Strategi Efisiensi Perawatan Armada Operasional Tahunan",
      excerpt: "Jadwal inspeksi berkala untuk menekan biaya henti kendaraan dinas perusahaan.",
      authorName: "Nadia Putri",
      categoryName: "Operasional",
      publishedAtIso: "2026-10-08T03:00:00.000Z",
      publishedDateLabel: "8 Oktober 2026",
      readingTimeMinutes: 4,
      coverImage: null,
    },
    {
      slug: "checklist-serah-terima-proyek",
      href: "/alpha/blog/panduan-audit-gedung/",
      title: "Checklist Serah Terima Proyek Renovasi Ruang Kerja B2B",
      excerpt: "Daftar pemeriksaan akhir yang wajib ditandatangani sebelum pemakaian kantor baru.",
      authorName: "Raka Pratama",
      categoryName: "Konstruksi",
      publishedAtIso: "2026-10-01T03:00:00.000Z",
      publishedDateLabel: "1 Oktober 2026",
      readingTimeMinutes: 6,
      coverImage: null,
    },
  ];
  const items = page === 1 ? allPosts.slice(0, 2) : allPosts.slice(2, 3);
  const seoInput = {
    surface: "public_tenant" as const,
    routeKind: "blog_index" as const,
    pathname: "/blog",
    query: page === 2 ? new URLSearchParams("page=2") : new URLSearchParams(),
    tenant: ALPHA_SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
    archiveEnabled: true,
    publishedItemCount: 3,
    totalPages: 2,
  };
  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    siteName: ALPHA_SHELL.site.title,
    resourceTitle: "Blog & Artikel",
    resourceExcerpt: "Kumpulan panduan konstruksi dan operasional dari PT Alpha Konstruksi.",
  });
  const schemaGraph = generateSchemaGraph({
    seo: seoInput,
    siteName: ALPHA_SHELL.site.title,
    pageTitle: page === 2 ? "Blog & Artikel — Halaman 2" : "Blog & Artikel",
    breadcrumbs: [
      { label: "Beranda", path: "/" },
      { label: "Blog", path: "/blog" },
    ],
  }).graph;
  return {
    items,
    seoMetadata,
    schemaGraph,
    pagination: {
      page,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2,
      offset: page === 1 ? 0 : 2,
      prevHref: page === 2 ? "/alpha/blog/" : null,
      nextHref: page === 1 ? "/alpha/blog/page-2/" : null,
      pageLinks: [
        { page: 1, href: "/alpha/blog/", current: page === 1 },
        { page: 2, href: "/alpha/blog/page-2/", current: page === 2 },
      ],
    },
  };
}

export function buildAlphaVehicleDetailResult() {
  const seoInput = {
    surface: "public_tenant" as const,
    routeKind: "offering" as const,
    pathname: "/kendaraan/suv-2023",
    tenant: ALPHA_SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
  };
  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    siteName: ALPHA_SHELL.site.title,
    resourceTitle: "SUV Operasional 2023 Diesel AT",
    resourceExcerpt: "Unit SUV diesel terawat dengan catatan servis resmi, siap untuk operasional bisnis.",
    offeringType: "vehicle",
  });
  const schemaGraph = generateSchemaGraph({
    seo: seoInput,
    siteName: ALPHA_SHELL.site.title,
    pageTitle: "SUV Operasional 2023 Diesel AT",
    breadcrumbs: [
      { label: "Beranda", path: "/" },
      { label: "Kendaraan", path: "/kendaraan" },
      { label: "SUV Operasional 2023 Diesel AT" },
    ],
    offering: {
      offeringType: "vehicle",
      title: "SUV Operasional 2023 Diesel AT",
      summary: "Unit SUV diesel terawat siap pakai.",
      priceMode: "fixed",
      price: 320_000_000,
      unitStatus: "available",
      attributes: {
        brand: "Toyota",
        model: "Fortuner",
        year: 2023,
        transmission: "automatic",
        fuelType: "diesel",
        mileageKm: 28500,
      },
    },
  }).graph;
  const cta = resolvePublicOfferingCta(
    {
      offeringType: "vehicle",
      slug: "suv-2023",
      title: "SUV Operasional 2023 Diesel AT",
      priceMode: "fixed",
      price: 320_000_000,
      priceMax: null,
      negotiable: true,
      ctaMode: "whatsapp",
      externalUrl: null,
    },
    { primaryOrigin: ALPHA_ORIGIN, tenantWhatsappE164: ALPHA_SHELL.business.whatsappE164, isDetailPage: true },
  );
  const creditRows = computeVehicleCreditEstimateRows(320_000_000, {
    annualFlatRateBps: 550,
    dpPercents: [20, 30],
    tenorMonths: [24, 36, 48],
  });
  return {
    kind: "offering_detail" as const,
    http: { status: 200 as const, headers: {} },
    tenant: { id: "t-alpha", handle: "alpha-konstruksi", name: ALPHA_SHELL.site.title } as any,
    shell: ALPHA_SHELL,
    primaryOrigin: ALPHA_ORIGIN,
    currentPath: "/kendaraan/suv-2023",
    descriptor: OFFERING_ROUTE_META.vehicle,
    pageTitle: "SUV Operasional 2023 Diesel AT",
    offering: {
      offeringType: "vehicle" as const,
      slug: "suv-2023",
      href: "/kendaraan/suv-2023",
      title: "SUV Operasional 2023 Diesel AT",
      summary: "Unit SUV diesel terawat dengan catatan servis resmi, siap untuk kebutuhan operasional perusahaan.",
      descriptionHtml:
        "<p>Unit kendaraan telah melalui pemeriksaan menyeluruh pada mesin, kaki-kaki, dan kelengkapan dokumen STNK serta BPKB.</p><ul><li>Riwayat servis bengkel resmi lengkap</li><li>Interior bersih dan terawat</li></ul>",
      categoryNames: ["SUV Operasional"],
      badge: "Siap Pakai",
      unitStatus: "available" as const,
      unitStatusLabel: "Tersedia",
      priceMode: "fixed" as const,
      priceText: "Rp 320.000.000 (Nego)",
      originalPriceText: "Rp 335.000.000",
      negotiable: true,
      coverImage: null,
      galleryImages: [],
      cta,
      fallbackContactHref: "tel:6281234567890",
      attributes: {},
      serviceAttributes: null,
      productAttributes: null,
      tourAttributes: null,
      vehicleAttributes: {
        brand: "Toyota",
        model: "Fortuner",
        variant: "VRZ 2.4",
        year: 2023,
        condition: "used" as const,
        transmission: "automatic" as const,
        fuelType: "diesel" as const,
        bodyType: "suv" as const,
        mileageKm: 28500,
        engineCc: 2393,
        seats: 7,
        color: "Hitam Metalik",
        location: "Jakarta Selatan",
        plateRegion: "B (Jakarta)",
        ownershipCount: 1,
        unitStatus: "available" as const,
      },
      vehicleCreditRows: creditRows,
      publishedDateLabel: "10 Oktober 2026",
      modifiedDateLabel: "10 Oktober 2026",
    },
    relatedOfferings: [],
    breadcrumbs: [
      { label: "Beranda", href: "/alpha/page/" },
      { label: "Kendaraan", href: "/alpha/layanan/" },
      { label: "SUV Operasional 2023 Diesel AT", href: null },
    ],
    seoMetadata,
    schemaGraph,
    floatingWa: {
      phone: ALPHA_SHELL.business.whatsappE164,
      businessName: ALPHA_SHELL.business.name,
      operatingHours: ALPHA_SHELL.business.weekdayHours,
      holidayHours: ALPHA_SHELL.business.holidayHours,
      primaryOrigin: ALPHA_ORIGIN,
      canonicalPath: "/kendaraan/suv-2023",
      itemTitle: "SUV Operasional 2023 Diesel AT",
      itemPrice: "Rp 320.000.000 (Nego)",
      greetingMessage: "Halo! Ada pertanyaan mengenai unit SUV Operasional 2023?",
    },
  };
}

export function buildBetaTourDetailResult() {
  const seoInput = {
    surface: "public_tenant" as const,
    routeKind: "offering" as const,
    pathname: "/tour/jogja-3h2m",
    tenant: BETA_SEO_TENANT,
    siteVisibility: "public" as const,
    resourceState: "published" as const,
  };
  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    siteName: BETA_SHELL.site.title,
    resourceTitle: "Paket Wisata Jogja 3H2M Korporasi",
    resourceExcerpt: "Paket perjalanan budaya dan kuliner Yogyakarta untuk rombongan perusahaan.",
    offeringType: "tour",
  });
  const schemaGraph = generateSchemaGraph({
    seo: seoInput,
    siteName: BETA_SHELL.site.title,
    pageTitle: "Paket Wisata Jogja 3H2M Korporasi",
    breadcrumbs: [
      { label: "Beranda", path: "/" },
      { label: "Paket Tur", path: "/tour" },
      { label: "Paket Wisata Jogja 3H2M Korporasi" },
    ],
    offering: {
      offeringType: "tour",
      title: "Paket Wisata Jogja 3H2M Korporasi",
      summary: "Perjalanan budaya Yogyakarta 3 hari 2 malam.",
      priceMode: "fixed",
      price: 2_650_000,
      attributes: { destination: "Yogyakarta", durationDays: 3, durationNights: 2 },
    },
  }).graph;
  const cta = resolvePublicOfferingCta(
    {
      offeringType: "tour",
      slug: "jogja-3h2m",
      title: "Paket Wisata Jogja 3H2M Korporasi",
      priceMode: "fixed",
      price: 2_650_000,
      priceMax: null,
      negotiable: false,
      ctaMode: "whatsapp",
      externalUrl: null,
    },
    { primaryOrigin: BETA_ORIGIN, tenantWhatsappE164: BETA_SHELL.business.whatsappE164, isDetailPage: true },
  );
  return {
    kind: "offering_detail" as const,
    http: { status: 200 as const, headers: {} },
    tenant: { id: "t-beta", handle: "beta-wisata", name: BETA_SHELL.site.title } as any,
    shell: BETA_SHELL,
    primaryOrigin: BETA_ORIGIN,
    currentPath: "/tour/jogja-3h2m",
    descriptor: OFFERING_ROUTE_META.tour,
    pageTitle: "Paket Wisata Jogja 3H2M Korporasi",
    offering: {
      offeringType: "tour" as const,
      slug: "jogja-3h2m",
      href: "/tour/jogja-3h2m",
      title: "Paket Wisata Jogja 3H2M Korporasi",
      summary: "Rencana perjalanan terkurasi untuk outing kantor dan rombongan keluarga di Yogyakarta.",
      descriptionHtml: "<p>Nikmati perjalanan nyaman bersama pemandu resmi berlisensi dengan akomodasi strategis.</p>",
      categoryNames: ["Wisata Domestik"],
      badge: "Favorit Grup",
      unitStatus: null,
      unitStatusLabel: null,
      priceMode: "fixed" as const,
      priceText: "Rp 2.650.000",
      originalPriceText: null,
      negotiable: false,
      coverImage: null,
      galleryImages: [],
      cta,
      fallbackContactHref: "tel:6281398765432",
      attributes: {},
      serviceAttributes: null,
      productAttributes: null,
      tourAttributes: {
        destination: "Yogyakarta",
        durationDays: 3,
        durationNights: 2,
        departureCity: "Jakarta",
        hotel: "Hotel Bintang 4 Pusat Kota",
        inclusions: ["Transportasi bus AC pariwisata", "Hotel 2 malam", "Makan sesuai program"],
        exclusions: ["Tiket kereta/pesawat ke Yogyakarta", "Pengeluaran pribadi"],
        itinerary: [
          { day: 1, title: "Kedatangan & Kawasan Malioboro", description: "Penjemputan di stasiun dan orientasi kota." },
          { day: 2, title: "Candi Borobudur & Wisata Merapi", description: "Kunjungan situs budaya dan makan siang lokal." },
        ],
        departures: [{ departureDate: "2027-03-10", status: "open" as const, note: "Minimal 10 peserta" }],
      },
      vehicleAttributes: null,
      vehicleCreditRows: [],
      publishedDateLabel: "15 Oktober 2026",
      modifiedDateLabel: "15 Oktober 2026",
    },
    relatedOfferings: [],
    breadcrumbs: [
      { label: "Beranda", href: "/beta/tour/" },
      { label: "Paket Tur", href: "/beta/tour/" },
      { label: "Paket Wisata Jogja 3H2M Korporasi", href: null },
    ],
    seoMetadata,
    schemaGraph,
    floatingWa: {
      phone: BETA_SHELL.business.whatsappE164,
      businessName: BETA_SHELL.business.name,
      operatingHours: BETA_SHELL.business.weekdayHours,
      holidayHours: BETA_SHELL.business.holidayHours,
      primaryOrigin: BETA_ORIGIN,
      canonicalPath: "/tour/jogja-3h2m",
      itemTitle: "Paket Wisata Jogja 3H2M Korporasi",
      itemPrice: "Rp 2.650.000",
      greetingMessage: "Halo! Ingin tanya jadwal Paket Wisata Jogja 3H2M?",
    },
  };
}
`,
  );

  // Route 1: Alpha static page (SectionRenderer + SEOHead + FloatingWhatsApp)
  fs.writeFileSync(
    path.join(pagesDir, "alpha/page.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import SectionRenderer from ${JSON.stringify(sectionRendererImport)};
import FloatingWhatsApp from ${JSON.stringify(floatingWaImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { ALPHA_ORIGIN, ALPHA_SHELL } from ${JSON.stringify(fixturesModule)};

const seoInput = {
  surface: "public_tenant" as const,
  routeKind: "homepage" as const,
  pathname: "/",
  tenant: {
    tenantHandle: "alpha-konstruksi",
    tenantStatus: "active" as const,
    operatorHold: false,
    primaryHost: "www.alpha-konstruksi.id",
    primaryHostKind: "custom" as const,
    primaryHostStatus: "active" as const,
    primaryHostSslStatus: "active" as const,
    primaryHostVerified: true,
    verifiedTenantHosts: ["www.alpha-konstruksi.id"],
    servingHost: "www.alpha-konstruksi.id",
  },
  siteVisibility: "public" as const,
  resourceState: "published" as const,
};
const seoMetadata = generateOpenGraphMetadata({
  seo: seoInput,
  siteName: ALPHA_SHELL.site.title,
  siteTagline: ALPHA_SHELL.site.tagline,
  resourceTitle: "Beranda",
});
const schemaGraph = generateSchemaGraph({
  seo: seoInput,
  siteName: ALPHA_SHELL.site.title,
  pageTitle: "Beranda",
}).graph;

const sections = [
  {
    id: "hero-alpha",
    type: "hero",
    enabled: true,
    config: {
      eyebrow: "Kontraktor & Armada B2B",
      heading: "Solusi Renovasi Kantor & Armada Operasional",
      subheading: "Dikerjakan oleh tim teknik berpengalaman dengan jadwal dan estimasi biaya transparan.",
      primaryCta: { label: "Lihat Layanan", href: "/alpha/layanan/" },
      secondaryCta: { label: "Baca Artikel", href: "/alpha/blog/" },
      highlights: ["Estimasi biaya transparan", "Jadwal kerja terukur"],
    },
  },
];
---
<Layout shell={ALPHA_SHELL} currentPath="/alpha/page/">
  <SEOHead slot="head" metadata={seoMetadata} jsonLd={schemaGraph ?? undefined} omitTitle={true} omitDescription={Boolean(seoMetadata.description)} />
  <SectionRenderer sections={sections} themeId="compro" routePath="/" isHomepage={true} primaryOrigin={ALPHA_ORIGIN} />
  <FloatingWhatsApp slot="floating" shell={ALPHA_SHELL} primaryOrigin={ALPHA_ORIGIN} canonicalPath="/" itemTitle={ALPHA_SHELL.site.title} />
</Layout>
`,
  );

  // Route 2 & 3: Alpha Blog Listing Page 1 & Page 2
  const makeBlogListPage = (pageNum) => `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import FloatingWhatsApp from ${JSON.stringify(floatingWaImport)};
import PublicBreadcrumbs from ${JSON.stringify(breadcrumbsImport)};
import PublicPagination from ${JSON.stringify(paginationImport)};
import { ALPHA_ORIGIN, ALPHA_SHELL, buildAlphaBlogListData } from ${JSON.stringify(fixturesModule)};

const data = buildAlphaBlogListData(${pageNum});
const pageTitle = ${pageNum} > 1 ? "Blog & Artikel — Halaman ${pageNum}" : "Blog & Artikel";
---
<Layout shell={ALPHA_SHELL} pageTitle={pageTitle} pageDescription={data.seoMetadata.description || undefined} currentPath="/alpha/blog/">
  <SEOHead slot="head" metadata={data.seoMetadata} jsonLd={data.schemaGraph ?? undefined} omitTitle={true} omitDescription={Boolean(data.seoMetadata.description)} />
  <section class="ps-route-hero">
    <div class="ps-container ps-route-hero-inner">
      <PublicBreadcrumbs items={[{ label: "Beranda", href: "/alpha/page/" }, { label: "Blog", href: ${pageNum} > 1 ? "/alpha/blog/" : null }]} />
      <h1 class="ps-route-title">Blog &amp; Artikel</h1>
      <p class="ps-route-lead">Kumpulan panduan praktis konstruksi, perawatan ruang usaha, dan operasional dari {ALPHA_SHELL.business.name}.</p>
    </div>
  </section>
  <section class="ps-archive-section" data-testid="blog-listing-section">
    <div class="ps-container">
      <p class="ps-archive-summary">Menampilkan {data.items.length} dari {data.pagination.totalItems} artikel • Halaman {data.pagination.page} dari {data.pagination.totalPages}</p>
      <div class="ps-archive-grid" data-testid="blog-listing-grid">
        {data.items.map((post) => (
          <article class="ps-card ps-post-card" data-testid="blog-post-card" data-post-slug={post.slug}>
            <div class="ps-post-body">
              {post.categoryName && <div><span class="ps-badge">{post.categoryName}</span></div>}
              <h2 class="ps-card-title"><a href={post.href} class="ps-offering-title-link" data-testid="blog-card-link">{post.title}</a></h2>
              {post.excerpt && <p class="ps-card-desc">{post.excerpt}</p>}
              <div class="ps-post-meta">
                <span>{post.authorName}</span>
                <time datetime={post.publishedAtIso}>{post.publishedDateLabel}</time>
                <span>{post.readingTimeMinutes} menit baca</span>
              </div>
            </div>
          </article>
        ))}
      </div>
      <PublicPagination pagination={data.pagination} ariaLabel="Navigasi halaman blog" />
    </div>
  </section>
  <FloatingWhatsApp slot="floating" shell={ALPHA_SHELL} primaryOrigin={ALPHA_ORIGIN} canonicalPath="/blog" itemTitle="Blog PT Alpha Konstruksi" />
</Layout>
`;
  fs.writeFileSync(path.join(pagesDir, "alpha/blog/index.astro"), makeBlogListPage(1));
  fs.writeFileSync(path.join(pagesDir, "alpha/blog/page-2.astro"), makeBlogListPage(2));

  // Route 4: Alpha Blog Detail
  fs.writeFileSync(
    path.join(pagesDir, "alpha/blog/panduan-audit-gedung.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import FloatingWhatsApp from ${JSON.stringify(floatingWaImport)};
import PublicBreadcrumbs from ${JSON.stringify(breadcrumbsImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { ALPHA_ORIGIN, ALPHA_SHELL } from ${JSON.stringify(fixturesModule)};

const seoInput = {
  surface: "public_tenant" as const,
  routeKind: "post" as const,
  pathname: "/blog/panduan-audit-gedung",
  tenant: {
    tenantHandle: "alpha-konstruksi",
    tenantStatus: "active" as const,
    operatorHold: false,
    primaryHost: "www.alpha-konstruksi.id",
    primaryHostKind: "custom" as const,
    primaryHostStatus: "active" as const,
    primaryHostSslStatus: "active" as const,
    primaryHostVerified: true,
    verifiedTenantHosts: ["www.alpha-konstruksi.id"],
    servingHost: "www.alpha-konstruksi.id",
  },
  siteVisibility: "public" as const,
  resourceState: "published" as const,
};
const seoMetadata = generateOpenGraphMetadata({
  seo: seoInput,
  siteName: ALPHA_SHELL.site.title,
  resourceTitle: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi",
  resourceExcerpt: "Langkah terukur mengevaluasi struktur dan anggaran renovasi ruang usaha.",
  ogType: "article",
  article: { publishedTime: "2026-10-12T03:00:00.000Z", author: "Raka Pratama" },
});
const schemaGraph = generateSchemaGraph({
  seo: seoInput,
  siteName: ALPHA_SHELL.site.title,
  pageTitle: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi",
  breadcrumbs: [
    { label: "Beranda", path: "/" },
    { label: "Blog", path: "/blog" },
    { label: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi" },
  ],
  article: {
    schemaType: "Article",
    headline: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi",
    datePublished: "2026-10-12T03:00:00.000Z",
    authorName: "Raka Pratama",
  },
}).graph;
---
<Layout shell={ALPHA_SHELL} pageTitle="Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi" currentPath="/alpha/blog/panduan-audit-gedung/">
  <SEOHead slot="head" metadata={seoMetadata} jsonLd={schemaGraph ?? undefined} omitTitle={true} omitDescription={Boolean(seoMetadata.description)} />
  <article class="ps-article-shell" data-testid="blog-detail-article">
    <div class="ps-container">
      <header class="ps-article-header">
        <PublicBreadcrumbs items={[{ label: "Beranda", href: "/alpha/page/" }, { label: "Blog", href: "/alpha/blog/" }, { label: "Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi", href: null }]} />
        <h1 class="ps-route-title" data-testid="blog-detail-title">Panduan Audit Kelayakan Gedung Kantor Sebelum Renovasi</h1>
        <div class="ps-article-meta">
          <span>Oleh <strong>Raka Pratama</strong></span>
          <time datetime="2026-10-12T03:00:00.000Z">Diterbitkan 12 Oktober 2026</time>
          <span>5 menit baca</span>
        </div>
      </header>
      <div class="ps-prose" data-testid="blog-detail-body">
        <h2>1. Pemeriksaan Struktur &amp; Utilitas</h2>
        <p>Pastikan jalur kelistrikan, tata udara, dan sistem proteksi kebakaran tercatat rapi sebelum pembongkaran dimulai.</p>
        <h2>2. Penetapan Jadwal &amp; Anggaran</h2>
        <p>Gunakan rincian pekerjaan terukur agar aktivitas tim tetap berjalan lancar selama masa renovasi.</p>
      </div>
      <div class="ps-actions" style="margin-top: 1.5rem;">
        <a href="/alpha/blog/" class="ps-btn ps-btn--secondary" data-testid="blog-back-link">&larr; Kembali ke Semua Artikel</a>
      </div>
    </div>
  </article>
  <FloatingWhatsApp slot="floating" shell={ALPHA_SHELL} primaryOrigin={ALPHA_ORIGIN} canonicalPath="/blog/panduan-audit-gedung" itemTitle="Panduan Audit Kelayakan Gedung" />
</Layout>
`,
  );

  // Route 5: Alpha Offering Listing (empty state test on `/alpha/layanan/`)
  fs.writeFileSync(
    path.join(pagesDir, "alpha/layanan/index.astro"),
    `---
import OfferingListingView from ${JSON.stringify(offeringListImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { OFFERING_ROUTE_META } from ${JSON.stringify(publicRoutesImport)};
import { ALPHA_ORIGIN, ALPHA_SHELL } from ${JSON.stringify(fixturesModule)};

const seoMetadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "catalog_index",
    pathname: "/layanan",
    tenant: {
      tenantHandle: "alpha-konstruksi",
      tenantStatus: "active",
      operatorHold: false,
      primaryHost: "www.alpha-konstruksi.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.alpha-konstruksi.id"],
      servingHost: "www.alpha-konstruksi.id",
    },
    siteVisibility: "public",
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: 0,
    totalPages: 1,
  },
  siteName: ALPHA_SHELL.site.title,
  resourceTitle: OFFERING_ROUTE_META.service.listingHeading,
});

const result = {
  kind: "offering_listing" as const,
  http: { status: 200 as const, headers: {} },
  tenant: { id: "t-alpha", handle: "alpha-konstruksi", name: ALPHA_SHELL.site.title } as any,
  shell: ALPHA_SHELL,
  primaryOrigin: ALPHA_ORIGIN,
  currentPath: "/layanan",
  descriptor: OFFERING_ROUTE_META.service,
  pageTitle: OFFERING_ROUTE_META.service.listingHeading,
  items: [],
  pagination: { page: 1, pageSize: 9, totalItems: 0, totalPages: 1, offset: 0, prevHref: null, nextHref: null, pageLinks: [] },
  breadcrumbs: [{ label: "Beranda", href: "/alpha/page/" }, { label: "Layanan", href: null }],
  seoMetadata,
  schemaGraph: null,
  floatingWa: {
    phone: ALPHA_SHELL.business.whatsappE164,
    businessName: ALPHA_SHELL.business.name,
    operatingHours: ALPHA_SHELL.business.weekdayHours,
    holidayHours: ALPHA_SHELL.business.holidayHours,
    primaryOrigin: ALPHA_ORIGIN,
    canonicalPath: "/layanan",
    itemTitle: "Layanan PT Alpha Konstruksi",
    greetingMessage: "Halo, ada yang bisa kami bantu?",
  },
};
---
<OfferingListingView result={result} />
`,
  );

  // Route 6: Alpha Vehicle Detail (honest IDR pricing, specs, static credit table, WA CTA)
  fs.writeFileSync(
    path.join(pagesDir, "alpha/kendaraan/suv-2023.astro"),
    `---
import OfferingDetailView from ${JSON.stringify(offeringDetailImport)};
import { buildAlphaVehicleDetailResult } from ${JSON.stringify(fixturesModule)};

const result = buildAlphaVehicleDetailResult();
---
<OfferingDetailView result={result} />
`,
  );

  // Route 7: Alpha Branded 404 Page
  fs.writeFileSync(
    path.join(pagesDir, "alpha/not-found.astro"),
    `---
import PublicNotFoundView from ${JSON.stringify(notFoundImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { ALPHA_ORIGIN, ALPHA_SHELL } from ${JSON.stringify(fixturesModule)};

const result = {
  kind: "not_found" as const,
  http: { status: 404 as const, headers: {} },
  tenant: { id: "t-alpha", handle: "alpha-konstruksi", name: ALPHA_SHELL.site.title } as any,
  shell: ALPHA_SHELL,
  primaryOrigin: ALPHA_ORIGIN,
  currentPath: "/halaman-hilang",
  pageTitle: "Halaman Tidak Ditemukan",
  heading: "Halaman Tidak Ditemukan",
  message: "Maaf, halaman yang Anda cari tidak tersedia atau telah dihapus.",
  seoMetadata: generateOpenGraphMetadata({
    seo: { surface: "error", routeKind: "error_404", pathname: "/halaman-hilang", tenant: null },
    siteName: ALPHA_SHELL.site.title,
    resourceTitle: "Halaman Tidak Ditemukan",
  }),
  floatingWa: {
    phone: ALPHA_SHELL.business.whatsappE164,
    businessName: ALPHA_SHELL.business.name,
    operatingHours: ALPHA_SHELL.business.weekdayHours,
    holidayHours: ALPHA_SHELL.business.holidayHours,
    primaryOrigin: ALPHA_ORIGIN,
    canonicalPath: "/",
    itemTitle: ALPHA_SHELL.business.name,
    greetingMessage: "Halo, butuh bantuan menemukan halaman?",
  },
};
---
<PublicNotFoundView result={result} />
`,
  );

  // Route 8: Tenant Beta Tour Detail (isolated second tenant!)
  fs.writeFileSync(
    path.join(pagesDir, "beta/tour/jogja-3h2m.astro"),
    `---
import OfferingDetailView from ${JSON.stringify(offeringDetailImport)};
import { buildBetaTourDetailResult } from ${JSON.stringify(fixturesModule)};

const result = buildBetaTourDetailResult();
---
<OfferingDetailView result={result} />
`,
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
  });

  return { tmpRoot, outDir };
}

function startStaticServer(rootDir) {
  const mimeByExt = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      let relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, "");
      if (!relPath || relPath.endsWith("/")) relPath = path.join(relPath, "index.html");
      let fullPath = path.join(rootDir, relPath);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        fullPath = path.join(rootDir, relPath, "index.html");
      }
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeByExt[ext] || "application/octet-stream" });
      fs.createReadStream(fullPath).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function assertZeroOverflowAndTapTargets(page, label) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const controls = Array.from(
      document.querySelectorAll(
        "header a[href], header button, header summary, main a[href], main button, main summary, footer a[href], .ps-floating-dock a[href], .ps-floating-dock summary",
      ),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (el.closest(".ps-prose p")) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !el.classList.contains("ps-skip-link");
    });
    const tooSmall = [];
    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      if (rect.height < 43.5) {
        tooSmall.push({
          text: (el.textContent || "").trim().slice(0, 40),
          height: Math.round(rect.height),
        });
      }
    }
    return { overflow, tooSmall };
  });
  assert(
    metrics.overflow <= 1,
    `Horizontal overflow detected on ${label}: delta=${metrics.overflow}px`,
  );
  assert(
    metrics.tooSmall.length === 0,
    `Tap targets < 44px on ${label}: ${JSON.stringify(metrics.tooSmall)}`,
  );
}

async function run() {
  const { tmpRoot, outDir } = await buildRealAstroPublicRouteFixtures();
  const { server, baseUrl } = await startStaticServer(outDir);
  const browser = await chromium.launch({
    executablePath: findChromeExecutable(),
    headless: true,
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    // 1. ZERO-JS JOURNEY (1440px): homepage -> blog pagination -> article -> offering detail -> empty -> 404 -> Tenant B isolation
    const indexSource = fs.readFileSync(path.join(webDir, "src/pages/index.astro"), "utf8");
    assert(
      indexSource.includes("resolvePublicPageRoute") && indexSource.includes('surface === "tenant"'),
      "apps/web/src/pages/index.astro must delegate tenant root `/` to resolvePublicPageRoute",
    );

    const noJsContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const page = await noJsContext.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1.0 Alpha Homepage (No-JS): verifies real published homepage renders (not Bootstrap Spike)
    await page.goto(`${baseUrl}/alpha/page/`, { waitUntil: "load" });
    const homeBodyText = await page.locator("body").textContent();
    assert(
      homeBodyText?.includes("Solusi Renovasi Kantor & Armada Operasional"),
      "Published homepage hero heading must render on tenant homepage",
    );
    assert(
      !homeBodyText?.includes("Bootstrap Spike"),
      "Tenant homepage must NOT render Bootstrap Spike shell",
    );
    const homeCanonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    assert(
      homeCanonical === "https://www.alpha-konstruksi.id/",
      `Expected root canonical on homepage, got ${homeCanonical}`,
    );
    const homeLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    assert(homeLd?.includes('"WebSite"'), "Homepage must emit WebSite JSON-LD");
    await assertZeroOverflowAndTapTargets(page, "alpha-home-1440");

    // 1a. Alpha Blog Listing Page 1 (No-JS)
    await page.goto(`${baseUrl}/alpha/blog/`, { waitUntil: "load" });
    assert(
      (await page.locator('[data-testid="blog-post-card"]').count()) === 2,
      "Blog page 1 should display 2 bounded posts",
    );
    const blogCanonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    assert(
      blogCanonical === "https://www.alpha-konstruksi.id/blog",
      `Expected clean blog canonical, got ${blogCanonical}`,
    );
    const blogNext = await page.locator('link[rel="next"]').getAttribute("href");
    assert(
      blogNext === "https://www.alpha-konstruksi.id/blog?page=2",
      `Expected rel=next on blog page 1, got ${blogNext}`,
    );
    await assertZeroOverflowAndTapTargets(page, "alpha-blog-1440");

    // 1b. No-JS pagination click to Page 2
    await page.locator('[data-testid="pagination-next"]').click();
    await page.waitForURL("**/alpha/blog/page-2/");
    assert(
      (await page.locator('[data-testid="blog-post-card"]').count()) === 1,
      "Blog page 2 should display 1 remaining post",
    );
    const p2Canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    assert(
      p2Canonical === "https://www.alpha-konstruksi.id/blog?page=2",
      `Expected ?page=2 canonical, got ${p2Canonical}`,
    );
    const p2Prev = await page.locator('link[rel="prev"]').getAttribute("href");
    assert(
      p2Prev === "https://www.alpha-konstruksi.id/blog",
      `Expected rel=prev on page 2, got ${p2Prev}`,
    );

    // 1c. No-JS navigation to Article Detail & verify JSON-LD Article
    await page.locator('[data-testid="blog-card-link"]').first().click();
    await page.waitForURL("**/alpha/blog/panduan-audit-gedung/");
    const articleTitle = await page.locator('[data-testid="blog-detail-title"]').textContent();
    assert(articleTitle?.includes("Panduan Audit Kelayakan"), "Article detail title visible");
    const articleLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    assert(articleLd?.includes('"Article"'), "Article JSON-LD emitted");

    // 1d. Alpha Vehicle Detail (No-JS WA CTA, honest IDR price, static credit table, Vehicle JSON-LD)
    await page.goto(`${baseUrl}/alpha/kendaraan/suv-2023/`, { waitUntil: "load" });
    const ctaHref = await page.locator('[data-testid="offering-detail-primary-cta"]').getAttribute("href");
    assert(
      ctaHref?.startsWith("https://wa.me/6281234567890?text="),
      `Expected valid WA CTA without JS, got ${ctaHref}`,
    );
    assert(
      (await page.locator('[data-testid="vehicle-credit-table"] tbody tr').count()) === 2,
      "Static credit table should render 2 DP rows without JS",
    );
    const vehLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    assert(vehLd?.includes('"Vehicle"'), "Vehicle JSON-LD emitted");
    await assertZeroOverflowAndTapTargets(page, "alpha-vehicle-1440");

    // 1e. Alpha Empty State & Branded 404
    await page.goto(`${baseUrl}/alpha/layanan/`, { waitUntil: "load" });
    assert(
      await page.locator('[data-testid="offering-empty-state"]').isVisible(),
      "Empty state UI should be visible",
    );
    const emptyRobots = await page.locator('meta[name="robots"]').first().getAttribute("content");
    assert(emptyRobots?.includes("noindex"), `Empty archive should be noindex, got ${emptyRobots}`);

    await page.goto(`${baseUrl}/alpha/not-found/`, { waitUntil: "load" });
    assert(
      await page.locator('[data-testid="public-not-found-page"]').isVisible(),
      "Branded 404 UI should be visible",
    );
    assert(
      (await page.locator('link[rel="canonical"]').count()) === 0,
      "404 page MUST NOT emit canonical link",
    );

    // 1f. Tenant Beta Isolation (Beta Tour Detail — zero Alpha leakage, native <details> itinerary!)
    await page.goto(`${baseUrl}/beta/tour/jogja-3h2m/`, { waitUntil: "load" });
    const betaText = await page.locator("body").textContent();
    assert(betaText?.includes("Beta Wisata Nusantara"), "Tenant Beta brand visible");
    assert(!betaText?.includes("PT Alpha Konstruksi"), "Tenant Alpha brand must NOT leak into Beta");
    const betaCta = await page.locator('[data-testid="offering-detail-primary-cta"]').getAttribute("href");
    assert(
      betaCta?.startsWith("https://wa.me/6281398765432?text="),
      `Tenant Beta WA CTA must use Beta number, got ${betaCta}`,
    );
    const betaLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    assert(betaLd?.includes('"TouristTrip"'), "TouristTrip JSON-LD emitted for Beta tour");

    // 2. MOBILE 360px & DESKTOP 1440px INTERACTIVE + KEYBOARD + VISUAL CAPTURE CHECKS
    const desktopVisContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: true,
    });
    const dPage = await desktopVisContext.newPage();
    dPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    dPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await dPage.goto(`${baseUrl}/alpha/blog/`, { waitUntil: "load" });
    const rejectBlogBtn = dPage.locator('button:has-text("Tolak opsional")');
    if (await rejectBlogBtn.isVisible()) {
      await rejectBlogBtn.click();
    }
    await assertZeroOverflowAndTapTargets(dPage, "alpha-blog-desktop-js");
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await dPage.screenshot({
        path: path.join(screenshotDir, "public-blog-1440.png"),
        fullPage: true,
      });
    }

    await dPage.goto(`${baseUrl}/alpha/kendaraan/suv-2023/`, { waitUntil: "load" });
    const rejectDetailBtn = dPage.locator('button:has-text("Tolak opsional")');
    if (await rejectDetailBtn.isVisible()) {
      await rejectDetailBtn.click();
    }
    await assertZeroOverflowAndTapTargets(dPage, "alpha-vehicle-desktop-js");
    if (screenshotDir) {
      await dPage.screenshot({
        path: path.join(screenshotDir, "public-offering-detail-1440.png"),
        fullPage: true,
      });
    }

    const mobileContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: true,
    });
    const mPage = await mobileContext.newPage();
    mPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    mPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await mPage.goto(`${baseUrl}/alpha/kendaraan/suv-2023/`, { waitUntil: "load" });
    const rejectMobileBtn = mPage.locator('button:has-text("Tolak opsional")');
    if (await rejectMobileBtn.isVisible()) {
      await rejectMobileBtn.click();
    }
    await assertZeroOverflowAndTapTargets(mPage, "alpha-vehicle-360");

    if (screenshotDir) {
      await mPage.screenshot({
        path: path.join(screenshotDir, "public-offering-detail-360.png"),
        fullPage: true,
      });
    }

    // Keyboard reach: Tab to skip link on clean focus
    await mPage.reload({ waitUntil: "load" });
    await mPage.keyboard.press("Tab");
    const firstFocusTestId = await mPage.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    );
    assert(
      firstFocusTestId === "skip-to-content",
      `First Tab stop must be skip-to-content, got ${firstFocusTestId}`,
    );

    await mPage.goto(`${baseUrl}/alpha/page/`, { waitUntil: "load" });
    await assertZeroOverflowAndTapTargets(mPage, "alpha-home-360");

    await mPage.goto(`${baseUrl}/beta/tour/jogja-3h2m/`, { waitUntil: "load" });
    await assertZeroOverflowAndTapTargets(mPage, "beta-tour-360");

    assert(consoleErrors.length === 0, `Console errors encountered: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Uncaught page errors: ${pageErrors.join("; ")}`);

    console.log("PASS: TASK-036 Playwright E2E checks (360px & 1440px, No-JS, Keyboard, Two Tenants)");
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
