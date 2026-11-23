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

const screenshotDir = process.env.TASK041_SCREENSHOT_DIR || "";

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

async function buildTask041Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t041-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const taxonomyClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/posts/categories/_TaxonomyManagerClient.tsx",
  );
  const blogArchiveViewImport = path.join(
    webDir,
    "src/pages/blog/category/_BlogTaxonomyArchiveView.astro",
  );
  const offeringArchiveViewImport = path.join(
    webDir,
    "src/pages/layanan/category/_OfferingCategoryArchiveView.astro",
  );
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const publicRoutesImport = path.join(webDir, "src/core/public-routes.ts");

  const editorPermissions = `{
    role: "editor" as const,
    roleLabel: "Editor",
    tenantStatus: "active" as const,
    isLocked: false,
    canWriteContent: true,
    canPublishContent: true,
    canManageMedia: true,
    canUploadMedia: true,
    canManageMenus: true,
    canManageSettings: false,
  }`;

  const lockedPermissions = `{
    role: "owner" as const,
    roleLabel: "Pemilik Situs",
    tenantStatus: "locked" as const,
    isLocked: true,
    canWriteContent: false,
    canPublishContent: false,
    canManageMedia: false,
    canUploadMedia: false,
    canManageMenus: false,
    canManageSettings: false,
  }`;

  const layoutProps = (title, activeNavId, lifecycleStatus = "active", roleLabel = "Editor") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId=${JSON.stringify(activeNavId)}
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Sari Editor"
    userRoleLabel=${JSON.stringify(roleLabel)}
  `;

  // 1. Admin Post Categories (Editor role)
  fs.writeFileSync(
    path.join(pagesDir, "post-categories.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { TaxonomyManagerClient } from ${JSON.stringify(taxonomyClientImport)};
---
<DashboardLayout ${layoutProps("Kategori Blog — PT Nusantara Arsitek", "articles")}>
  <TaxonomyManagerClient
    client:load
    mode="post_category"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    publicSiteHref="https://alpha-studio.situsku.click"
    permissions={${editorPermissions}}
    canManageTaxonomy={true}
    initialItems={[
      {
        id: 1,
        kind: "post_category",
        offeringType: null,
        name: "Panduan Bisnis",
        slug: "panduan-bisnis",
        publicPath: "/blog/category/panduan-bisnis",
        description: "Artikel panduan operasional dan strategi pertumbuhan untuk pemilik usaha.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 4,
        draftCount: 1,
        totalUsageCount: 5,
        childCount: 1,
        indexOptIn: true,
        hasUsefulIntro: true,
        indexable: true,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 2,
        kind: "post_category",
        offeringType: null,
        name: "Pemasaran Digital",
        slug: "pemasaran-digital",
        publicPath: "/blog/category/pemasaran-digital",
        description: "Strategi akuisisi pelanggan dan konversi WhatsApp bagi UMKM.",
        parentId: 1,
        depth: 2,
        sortOrder: 0,
        publishedCount: 2,
        draftCount: 1,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:05:00.000Z",
      },
      {
        id: 3,
        kind: "post_category",
        offeringType: null,
        name: "Arsip Umum",
        slug: "arsip-umum",
        publicPath: "/blog/category/arsip-umum",
        description: null,
        parentId: null,
        depth: 1,
        sortOrder: 1,
        publishedCount: 0,
        draftCount: 0,
        totalUsageCount: 0,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: false,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:10:00.000Z",
      },
    ]}
  />
</DashboardLayout>`,
  );

  // 2. Admin Post Categories (Locked tenant read-only)
  fs.writeFileSync(
    path.join(pagesDir, "post-categories-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { TaxonomyManagerClient } from ${JSON.stringify(taxonomyClientImport)};
---
<DashboardLayout ${layoutProps("Kategori Blog (Terkunci)", "articles", "locked", "Pemilik Situs")}>
  <TaxonomyManagerClient
    client:load
    mode="post_category"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    publicSiteHref="https://alpha-studio.situsku.click"
    permissions={${lockedPermissions}}
    canManageTaxonomy={false}
    initialItems={[
      {
        id: 1,
        kind: "post_category",
        offeringType: null,
        name: "Panduan Bisnis",
        slug: "panduan-bisnis",
        publicPath: "/blog/category/panduan-bisnis",
        description: "Kategori terkunci dalam mode baca saja.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 2,
        draftCount: 0,
        totalUsageCount: 2,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
    ]}
  />
</DashboardLayout>`,
  );

  // 3. Admin Post Tags (Flat)
  fs.writeFileSync(
    path.join(pagesDir, "post-tags.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { TaxonomyManagerClient } from ${JSON.stringify(taxonomyClientImport)};
---
<DashboardLayout ${layoutProps("Tag Blog — PT Nusantara Arsitek", "articles")}>
  <TaxonomyManagerClient
    client:load
    mode="post_tag"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    publicSiteHref="https://alpha-studio.situsku.click"
    permissions={${editorPermissions}}
    canManageTaxonomy={true}
    initialItems={[
      {
        id: 10,
        kind: "post_tag",
        offeringType: null,
        name: "SEO Lokal",
        slug: "seo-lokal",
        publicPath: "/blog/tag/seo-lokal",
        description: "Tips optimasi pencarian lokal bagi bisnis jasa di Indonesia.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 3,
        draftCount: 1,
        totalUsageCount: 4,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 11,
        kind: "post_tag",
        offeringType: null,
        name: "Promo UMKM",
        slug: "promo-umkm",
        publicPath: "/blog/tag/promo-umkm",
        description: null,
        parentId: null,
        depth: 1,
        sortOrder: 1,
        publishedCount: 0,
        draftCount: 0,
        totalUsageCount: 0,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: false,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:02:00.000Z",
      },
    ]}
  />
</DashboardLayout>`,
  );

  // 4. Admin Catalog Categories (Tabbed by offeringType)
  fs.writeFileSync(
    path.join(pagesDir, "catalog-categories.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { TaxonomyManagerClient } from ${JSON.stringify(taxonomyClientImport)};
---
<DashboardLayout ${layoutProps("Kategori Katalog — PT Nusantara Arsitek", "offering")}>
  <TaxonomyManagerClient
    client:load
    mode="offering_category"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    publicSiteHref="https://alpha-studio.situsku.click"
    permissions={${editorPermissions}}
    canManageTaxonomy={true}
    initialOfferingType="service"
    initialItems={[
      {
        id: 20,
        kind: "offering_category",
        offeringType: "service",
        name: "Renovasi Komersial",
        slug: "renovasi-komersial",
        publicPath: "/layanan/category/renovasi-komersial",
        description: "Layanan renovasi perkantoran, ruko, dan ruang usaha skala B2B.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 3,
        draftCount: 0,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: true,
        hasUsefulIntro: true,
        indexable: true,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 21,
        kind: "offering_category",
        offeringType: "vehicle",
        name: "SUV Operasional",
        slug: "suv-operasional",
        publicPath: "/kendaraan/category/suv-operasional",
        description: "Unit SUV siap pakai untuk mobilitas direksi dan lapangan.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 2,
        draftCount: 1,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:05:00.000Z",
      },
    ]}
  />
</DashboardLayout>`,
  );

  // 5. Public Zero-JS Blog Category Archive (Populated & Indexable)
  fs.writeFileSync(
    path.join(pagesDir, "public-blog-category.astro"),
    `---
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import BlogTaxonomyArchiveView from ${JSON.stringify(blogArchiveViewImport)};

const shell = {
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
    tagline: "Mitra Renovasi & Strategi Bisnis B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "PT Nusantara Arsitek",
    category: "LocalBusiness",
    description: "Kontraktor komersial dan konsultan ruang usaha di Indonesia.",
    address: "Jl. Jenderal Sudirman Kav. 45",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: null,
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@nusantara-arsitek.id",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
      { label: "Blog", href: "/blog", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Blog", href: "/blog", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

const seoTenant = {
  tenantHandle: "alpha-studio",
  tenantStatus: "active" as const,
  operatorHold: false,
  primaryHost: "alpha-studio.situsku.click",
  primaryHostKind: "subdomain" as const,
  primaryHostStatus: "active" as const,
  primaryHostSslStatus: "active" as const,
  primaryHostVerified: true,
  verifiedTenantHosts: ["alpha-studio.situsku.click"],
  servingHost: "alpha-studio.situsku.click",
};

const seoInput = {
  surface: "public_tenant" as const,
  routeKind: "category_archive" as const,
  pathname: "/blog/category/panduan-bisnis",
  tenant: seoTenant,
  siteVisibility: "public" as const,
  resourceState: "published" as const,
  archiveEnabled: true,
  publishedItemCount: 2,
  totalPages: 1,
  taxonomyIndexOptIn: true,
  taxonomyHasUsefulIntro: true,
};

const seoMetadata = generateOpenGraphMetadata({
  seo: seoInput,
  tenantId: "01JT41E2E00000000000000001",
  siteName: shell.site.title,
  siteTagline: shell.site.tagline,
  locale: shell.site.locale,
  resourceTitle: "Kategori: Panduan Bisnis",
  resourceExcerpt: "Artikel panduan operasional dan strategi pertumbuhan untuk pemilik usaha.",
});

const schemaRes = generateSchemaGraph({
  seo: seoInput,
  tenantId: "01JT41E2E00000000000000001",
  siteName: shell.site.title,
  siteTagline: shell.site.tagline,
  locale: shell.site.locale,
  timezone: shell.site.timezone,
  business: { businessName: shell.business.name, businessCategory: "LocalBusiness" },
  pageTitle: "Kategori: Panduan Bisnis",
  pageDescription: "Artikel panduan operasional dan strategi pertumbuhan untuk pemilik usaha.",
  breadcrumbs: [
    { label: "Beranda", path: "/" },
    { label: "Blog", path: "/blog" },
    { label: "Panduan Bisnis" },
  ],
});

const result = {
  kind: "blog_taxonomy_archive" as const,
  taxonomyKind: "post_category" as const,
  http: { status: 200 as const, headers: {} },
  tenant: {
    id: "01JT41E2E00000000000000001",
    organizationId: "org-1",
    handle: "alpha-studio",
    name: "PT Nusantara Arsitek",
    vertical: "compro" as const,
    status: "active" as const,
    storedStatus: "active" as const,
    operatorHold: false,
    cacheVersion: 1,
    schemaVersion: 1,
    host: "alpha-studio.situsku.click",
    hostKind: "subdomain" as const,
    isPrimary: true,
    primaryHost: "alpha-studio.situsku.click",
    primaryHostKind: "subdomain" as const,
  },
  shell,
  primaryOrigin: "https://alpha-studio.situsku.click",
  currentPath: "/blog/category/panduan-bisnis",
  pageTitle: "Kategori: Panduan Bisnis",
  taxonomy: {
    id: 1,
    kind: "post_category" as const,
    offeringType: null,
    parentId: null,
    depth: 1,
    slug: "panduan-bisnis",
    publicPath: "/blog/category/panduan-bisnis",
    name: "Panduan Bisnis",
    description: "Artikel panduan operasional dan strategi pertumbuhan untuk pemilik usaha.",
    sortOrder: 0,
    publishedCount: 2,
    draftCount: 0,
    totalUsageCount: 2,
    usageCount: 2,
    childCount: 1,
    indexOptIn: true,
    hasUsefulIntro: true,
    indexable: true,
    formerSlugs: [],
    version: 1,
    createdAt: "2026-11-23T04:00:00.000Z",
    updatedAt: "2026-11-23T04:00:00.000Z",
  },
  childCategories: [
    { slug: "pemasaran-digital", name: "Pemasaran Digital", href: "/blog/category/pemasaran-digital", publishedCount: 2 },
  ],
  items: [
    {
      slug: "checklist-renovasi-kantor-2026",
      href: "/blog/checklist-renovasi-kantor-2026",
      title: "Checklist Renovasi Kantor Tanpa Mengganggu Operasional",
      excerpt: "Langkah praktis merencanakan anggaran, jadwal kerja, dan serah terima proyek kantor.",
      authorName: "Budi Santoso",
      categoryName: "Panduan Bisnis",
      publishedAtIso: "2026-11-20T08:00:00.000Z",
      publishedDateLabel: "20 November 2026",
      readingTimeMinutes: 5,
      coverImage: null,
    },
    {
      slug: "memilih-vendor-interior-komersial",
      href: "/blog/memilih-vendor-interior-komersial",
      title: "Cara Memilih Kontraktor Interior Komersial yang Transparan",
      excerpt: "Kriteria evaluasi RAB, garansi pemeliharaan, dan transparansi material konstruksi.",
      authorName: "Sari Wijaya",
      categoryName: "Panduan Bisnis",
      publishedAtIso: "2026-11-18T08:00:00.000Z",
      publishedDateLabel: "18 November 2026",
      readingTimeMinutes: 4,
      coverImage: null,
    },
  ],
  pagination: {
    page: 1,
    pageSize: 9,
    totalItems: 2,
    totalPages: 1,
    offset: 0,
    prevHref: null,
    nextHref: null,
    pageLinks: [],
  },
  breadcrumbs: [
    { label: "Beranda", href: "/" },
    { label: "Blog", href: "/blog" },
    { label: "Panduan Bisnis", href: null },
  ],
  seoMetadata,
  schemaGraph: schemaRes.graph,
  floatingWa: {
    phone: "6281234567890",
    businessName: "PT Nusantara Arsitek",
    operatingHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: null,
    primaryOrigin: "https://alpha-studio.situsku.click",
    canonicalPath: "/blog/category/panduan-bisnis",
    itemTitle: "Kategori Panduan Bisnis",
    greetingMessage: "Halo PT Nusantara Arsitek, saya ingin berkonsultasi.",
  },
};
---
<BlogTaxonomyArchiveView result={result} />`,
  );

  // 6. Public Zero-JS Catalog Category Archive (Empty State with noindex)
  fs.writeFileSync(
    path.join(pagesDir, "public-offering-category-empty.astro"),
    `---
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { OFFERING_ROUTE_META } from ${JSON.stringify(publicRoutesImport)};
import OfferingCategoryArchiveView from ${JSON.stringify(offeringArchiveViewImport)};

const shell = {
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
    tagline: "Mitra Renovasi & Strategi Bisnis B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "PT Nusantara Arsitek",
    category: "LocalBusiness",
    description: "Kontraktor komersial dan konsultan ruang usaha di Indonesia.",
    address: null,
    city: null,
    province: null,
    postalCode: null,
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@nusantara-arsitek.id",
    socialLinks: [],
  },
  menus: { header: [], footer: [], mobile: [] },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

const seoMetadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "offering_category_archive",
    pathname: "/layanan/category/konsultasi-baru",
    tenant: {
      tenantHandle: "alpha-studio",
      tenantStatus: "active",
      operatorHold: false,
      primaryHost: "alpha-studio.situsku.click",
      primaryHostKind: "subdomain",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["alpha-studio.situsku.click"],
      servingHost: "alpha-studio.situsku.click",
    },
    siteVisibility: "public",
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: 0,
    totalPages: 1,
    taxonomyIndexOptIn: false,
    taxonomyHasUsefulIntro: false,
  },
  tenantId: "01JT41E2E00000000000000001",
  siteName: shell.site.title,
  siteTagline: shell.site.tagline,
  locale: shell.site.locale,
  resourceTitle: "Layanan: Konsultasi Baru",
  resourceExcerpt: "Kategori layanan baru.",
});

const result = {
  kind: "offering_category_archive" as const,
  http: { status: 200 as const, headers: {} },
  tenant: {
    id: "01JT41E2E00000000000000001",
    organizationId: "org-1",
    handle: "alpha-studio",
    name: "PT Nusantara Arsitek",
    vertical: "compro" as const,
    status: "active" as const,
    storedStatus: "active" as const,
    operatorHold: false,
    cacheVersion: 1,
    schemaVersion: 1,
    host: "alpha-studio.situsku.click",
    hostKind: "subdomain" as const,
    isPrimary: true,
    primaryHost: "alpha-studio.situsku.click",
    primaryHostKind: "subdomain" as const,
  },
  shell,
  primaryOrigin: "https://alpha-studio.situsku.click",
  currentPath: "/layanan/category/konsultasi-baru",
  descriptor: OFFERING_ROUTE_META.service,
  pageTitle: "Layanan: Konsultasi Baru",
  taxonomy: {
    id: 25,
    kind: "offering_category" as const,
    offeringType: "service" as const,
    parentId: null,
    depth: 1,
    slug: "konsultasi-baru",
    publicPath: "/layanan/category/konsultasi-baru",
    name: "Konsultasi Baru",
    description: null,
    sortOrder: 0,
    publishedCount: 0,
    draftCount: 0,
    totalUsageCount: 0,
    usageCount: 0,
    childCount: 0,
    indexOptIn: false,
    hasUsefulIntro: false,
    indexable: false,
    formerSlugs: [],
    version: 1,
    createdAt: "2026-11-23T04:00:00.000Z",
    updatedAt: "2026-11-23T04:00:00.000Z",
  },
  childCategories: [],
  items: [],
  pagination: {
    page: 1,
    pageSize: 9,
    totalItems: 0,
    totalPages: 1,
    offset: 0,
    prevHref: null,
    nextHref: null,
    pageLinks: [],
  },
  breadcrumbs: [
    { label: "Beranda", href: "/" },
    { label: "Layanan", href: "/layanan" },
    { label: "Konsultasi Baru", href: null },
  ],
  seoMetadata,
  schemaGraph: null,
  floatingWa: {
    phone: "6281234567890",
    businessName: "PT Nusantara Arsitek",
    operatingHours: null,
    holidayHours: null,
    primaryOrigin: "https://alpha-studio.situsku.click",
    canonicalPath: "/layanan/category/konsultasi-baru",
    itemTitle: "Layanan Konsultasi Baru",
    greetingMessage: "Halo PT Nusantara Arsitek.",
  },
};
---
<OfferingCategoryArchiveView result={result} />`,
  );

  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;
  const { build } = await import(astroEntryUrl);

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
  });

  return { tmpRoot, outDir };
}

function startStaticServer(outDir) {
  const mimeByExt = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json",
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    let filePath = path.join(outDir, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }
    if (!fs.existsSync(filePath) || !filePath.startsWith(outDir)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeByExt[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function assertNoOverflowAndTapTargets(page, label) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const controls = Array.from(
      document.querySelectorAll('main button:not([disabled]), main a[href], main input, main select'),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const smallControls = controls
      .filter((el) => {
        if (el.tagName === "INPUT" && el.getAttribute("type") === "checkbox") return false;
        if (el.tagName === "INPUT" && el.getAttribute("type") === "radio") return false;
        const rect = el.getBoundingClientRect();
        // Inline text links inside cards/breadcrumbs are allowed to be text-height; check buttons & form controls
        if (el.tagName === "A" && !el.className.includes("btn") && !el.className.includes("min-h-11")) {
          return false;
        }
        return rect.height < 43;
      })
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent || "").trim().slice(0, 40),
        h: Math.round(el.getBoundingClientRect().height),
      }));
    return { overflow, smallControls };
  });

  assert(
    metrics.overflow <= 1,
    `[${label}] Horizontal overflow detected: ${metrics.overflow}px`,
  );
  assert(
    metrics.smallControls.length === 0,
    `[${label}] Tap targets < 44px found: ${JSON.stringify(metrics.smallControls)}`,
  );
}

async function run() {
  const { tmpRoot, outDir } = await buildTask041Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);

  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let allowExpected409Log = false;
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (allowExpected409Log && text.includes("status of 409")) return;
        errors.push(`console.error: ${text}`);
      }
    });

    // Stateful in-memory API mock for interactive admin journeys
    let categories = [
      {
        id: 1,
        kind: "post_category",
        offeringType: null,
        name: "Panduan Bisnis",
        slug: "panduan-bisnis",
        publicPath: "/blog/category/panduan-bisnis",
        description: "Artikel panduan operasional dan strategi pertumbuhan untuk pemilik usaha.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 4,
        draftCount: 1,
        totalUsageCount: 5,
        childCount: 1,
        indexOptIn: true,
        hasUsefulIntro: true,
        indexable: true,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 2,
        kind: "post_category",
        offeringType: null,
        name: "Pemasaran Digital",
        slug: "pemasaran-digital",
        publicPath: "/blog/category/pemasaran-digital",
        description: "Strategi akuisisi pelanggan dan konversi WhatsApp bagi UMKM.",
        parentId: 1,
        depth: 2,
        sortOrder: 0,
        publishedCount: 2,
        draftCount: 1,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:05:00.000Z",
      },
      {
        id: 3,
        kind: "post_category",
        offeringType: null,
        name: "Arsip Umum",
        slug: "arsip-umum",
        publicPath: "/blog/category/arsip-umum",
        description: null,
        parentId: null,
        depth: 1,
        sortOrder: 1,
        publishedCount: 0,
        draftCount: 0,
        totalUsageCount: 0,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: false,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:10:00.000Z",
      },
    ];
    let catalogCategories = [
      {
        id: 20,
        kind: "offering_category",
        offeringType: "service",
        name: "Renovasi Komersial",
        slug: "renovasi-komersial",
        publicPath: "/layanan/category/renovasi-komersial",
        description: "Layanan renovasi perkantoran, ruko, dan ruang usaha skala B2B.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 3,
        draftCount: 0,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: true,
        hasUsefulIntro: true,
        indexable: true,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 21,
        kind: "offering_category",
        offeringType: "vehicle",
        name: "SUV Operasional",
        slug: "suv-operasional",
        publicPath: "/kendaraan/category/suv-operasional",
        description: "Unit SUV siap pakai untuk mobilitas direksi dan lapangan.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 2,
        draftCount: 1,
        totalUsageCount: 3,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:05:00.000Z",
      },
    ];
    let tags = [
      {
        id: 10,
        kind: "post_tag",
        offeringType: null,
        name: "SEO Lokal",
        slug: "seo-lokal",
        publicPath: "/blog/tag/seo-lokal",
        description: "Tips optimasi pencarian lokal bagi bisnis jasa di Indonesia.",
        parentId: null,
        depth: 1,
        sortOrder: 0,
        publishedCount: 3,
        draftCount: 1,
        totalUsageCount: 4,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: true,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:00:00.000Z",
      },
      {
        id: 11,
        kind: "post_tag",
        offeringType: null,
        name: "Promo UMKM",
        slug: "promo-umkm",
        publicPath: "/blog/tag/promo-umkm",
        description: null,
        parentId: null,
        depth: 1,
        sortOrder: 1,
        publishedCount: 0,
        draftCount: 0,
        totalUsageCount: 0,
        childCount: 0,
        indexOptIn: false,
        hasUsefulIntro: false,
        indexable: false,
        version: 1,
        updatedAt: "2026-11-23T04:02:00.000Z",
      },
    ];
    let nextId = 30;
    let triggerStaleOnce = false;

    await page.route("**/api/tenants/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const pathname = url.pathname;
      const isTags = pathname.includes("/tags");
      const kindParam = url.searchParams.get("kind");

      if (method === "GET") {
        const list = isTags
          ? tags
          : kindParam === "offering_category"
            ? catalogCategories
            : categories;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: list, page: { nextCursor: null, limit: 100, hasMore: false } }),
        });
        return;
      }

      if (method === "POST") {
        const body = req.postDataJSON();
        const id = nextId++;
        const slugVal = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const isCatCatalog = body.kind === "offering_category";
        const parent = body.parentId
          ? (isCatCatalog ? catalogCategories : categories).find((c) => c.id === body.parentId)
          : null;
        const created = {
          id,
          kind: isTags ? "post_tag" : body.kind || "post_category",
          offeringType: body.offeringType || null,
          name: body.name,
          slug: slugVal,
          publicPath: isTags
            ? `/blog/tag/${slugVal}`
            : isCatCatalog
              ? `/${body.offeringType === "vehicle" ? "kendaraan" : "layanan"}/category/${slugVal}`
              : `/blog/category/${slugVal}`,
          description: body.description || null,
          parentId: body.parentId || null,
          depth: parent ? parent.depth + 1 : 1,
          sortOrder: body.sortOrder || 0,
          publishedCount: 0,
          draftCount: 0,
          totalUsageCount: 0,
          childCount: 0,
          indexOptIn: Boolean(body.indexOptIn),
          hasUsefulIntro: Boolean(body.description && body.description.length >= 20),
          indexable: false,
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        if (isTags) tags.push(created);
        else if (isCatCatalog) catalogCategories.push(created);
        else categories.push(created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(created),
        });
        return;
      }

      if (method === "PATCH") {
        if (triggerStaleOnce) {
          triggerStaleOnce = false;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "STALE_VERSION",
                message: "Versi taksonomi telah diubah di sesi lain (expected 1, current 2).",
              },
              requestId: "req_stale_test",
            }),
          });
          return;
        }
        const id = Number(pathname.split("/").pop());
        const body = req.postDataJSON();
        const collection = isTags
          ? tags
          : catalogCategories.some((c) => c.id === id)
            ? catalogCategories
            : categories;
        const idx = collection.findIndex((c) => c.id === id);
        if (idx >= 0) {
          collection[idx] = {
            ...collection[idx],
            name: body.name ?? collection[idx].name,
            slug: body.slug ?? collection[idx].slug,
            description: body.description !== undefined ? body.description : collection[idx].description,
            version: collection[idx].version + 1,
          };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(collection[idx]),
          });
          return;
        }
      }

      if (method === "DELETE") {
        const id = Number(pathname.split("/").pop());
        const body = req.postDataJSON() || {};
        if (isTags) {
          tags = tags.filter((t) => t.id !== id);
        } else if (catalogCategories.some((c) => c.id === id)) {
          catalogCategories = catalogCategories.filter((c) => c.id !== id);
        } else {
          const target = categories.find((c) => c.id === id);
          if (target && body.reassignToId) {
            const dest = categories.find((c) => c.id === body.reassignToId);
            if (dest) {
              dest.publishedCount += target.publishedCount;
              dest.draftCount += target.draftCount;
              dest.totalUsageCount += target.totalUsageCount;
            }
          }
          categories = categories.filter((c) => c.id !== id);
          // Recompute childCount on parent
          for (const c of categories) {
            c.childCount = categories.filter((x) => x.parentId === c.id).length;
          }
        }
        await route.fulfill({ status: 204 });
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // === 1. Admin Blog Categories @ 1440px, 768px, 360px ===
    await page.goto(`${baseUrl}/post-categories`, { waitUntil: "networkidle" });
    await page.getByTestId("taxonomy-manager-post_category").waitFor();
    assert(
      (await page.getByTestId("taxonomy-role-badge").textContent())?.includes("Editor"),
      "Editor role badge should be visible",
    );
    await assertNoOverflowAndTapTargets(page, "post-categories@1440");

    // Create a depth-3 grandchild category
    await page.getByTestId("taxonomy-name-input").fill("Iklan Meta");
    await page.getByTestId("taxonomy-parent-select").selectOption("2");
    await page.getByTestId("taxonomy-submit-btn").click();
    await page.getByTestId("taxonomy-feedback-alert").waitFor();
    assert(
      (await page.getByTestId("taxonomy-list").textContent())?.includes("Iklan Meta"),
      "Newly created depth-3 category should appear in tree",
    );

    // Screenshot 1: Post Categories @ 1440px
    if (screenshotDir) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(screenshotDir, "post-categories-1440.png"), fullPage: true });
    }

    // Verify 409 Stale Write Recovery Banner
    triggerStaleOnce = true;
    allowExpected409Log = true;
    await page.getByTestId("edit-taxonomy-2").click();
    await page.getByTestId("taxonomy-name-input").fill("Pemasaran Konflik");
    await page.getByTestId("taxonomy-submit-btn").click();
    await page.getByTestId("stale-conflict-banner").waitFor();
    allowExpected409Log = false;
    await page.getByTestId("stale-conflict-reload-btn").click();
    await page.getByTestId("stale-conflict-banner").waitFor({ state: "detached" });

    // Verify Parent Category with Children blocks delete cleanly
    await page.getByTestId("delete-taxonomy-1").click();
    await page.getByTestId("delete-blocked-children").waitFor();
    // Keyboard Escape closes dialog
    await page.keyboard.press("Escape");
    await page.getByTestId("taxonomy-delete-dialog").waitFor({ state: "detached" });

    // Verify Referenced Category requires Reassign/Detach confirmation
    await page.getByTestId("delete-taxonomy-2").click();
    await page.getByTestId("delete-in-use-options").waitFor();
    await page.getByTestId("delete-reassign-select").selectOption("3");
    await page.getByTestId("taxonomy-delete-confirm").click();
    await page.getByTestId("taxonomy-delete-dialog").waitFor({ state: "detached" });
    assert(
      (await page.getByTestId("taxonomy-feedback-alert").textContent())?.includes("dipindahkan"),
      "Reassign confirmation feedback should be shown",
    );

    // Check 768px & 360px layouts
    await page.setViewportSize({ width: 768, height: 1024 });
    await assertNoOverflowAndTapTargets(page, "post-categories@768");
    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoOverflowAndTapTargets(page, "post-categories@360");

    // === 2. Locked Tenant Read-Only Verification ===
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/post-categories-locked`, { waitUntil: "networkidle" });
    await page.getByTestId("cms-locked-banner").waitFor();
    assert(
      await page.getByTestId("taxonomy-submit-btn").isDisabled(),
      "Submit button must be disabled when tenant is locked",
    );
    assert(
      await page.getByTestId("delete-taxonomy-1").isDisabled(),
      "Delete button must be disabled when tenant is locked",
    );

    // === 3. Admin Blog Tags @ 360px (Flat, no parent selector, detach confirm) ===
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${baseUrl}/post-tags`, { waitUntil: "networkidle" });
    await page.getByTestId("taxonomy-manager-post_tag").waitFor();
    assert(
      (await page.getByTestId("taxonomy-parent-select").count()) === 0,
      "Flat tags UI must NOT render a parent category selector",
    );
    await assertNoOverflowAndTapTargets(page, "post-tags@360");

    // Screenshot 2: Post Tags @ 360px
    if (screenshotDir) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(screenshotDir, "post-tags-360.png"), fullPage: true });
    }

    // Search filter + detach delete on tag
    await page.getByTestId("taxonomy-search-input").fill("SEO");
    assert(
      (await page.getByTestId("taxonomy-row-10").count()) === 1 &&
        (await page.getByTestId("taxonomy-row-11").count()) === 0,
      "Search filter should narrow tags",
    );
    await page.getByTestId("taxonomy-search-input").fill("");
    await page.getByTestId("delete-taxonomy-10").click();
    await page.getByTestId("delete-strategy-detach").check();
    await page.getByTestId("taxonomy-delete-confirm").click();
    await page.getByTestId("taxonomy-delete-dialog").waitFor({ state: "detached" });

    // === 4. Admin Catalog Categories @ 1440px & 360px (Tabbed by offeringType) ===
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/catalog-categories`, { waitUntil: "networkidle" });
    await page.getByTestId("catalog-offering-type-tabs").waitFor();
    await assertNoOverflowAndTapTargets(page, "catalog-categories@1440");

    // Switch tab to Kendaraan (vehicle)
    await page.getByTestId("offering-tab-vehicle").click();
    assert(
      (await page.getByTestId("taxonomy-list").textContent())?.includes("SUV Operasional"),
      "Kendaraan tab should show vehicle categories",
    );
    await page.getByTestId("taxonomy-name-input").fill("MPV Keluarga");
    await page.getByTestId("taxonomy-submit-btn").click();
    await page.getByTestId("taxonomy-feedback-alert").waitFor();

    // Screenshot 3: Catalog Categories @ 1440px
    if (screenshotDir) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: path.join(screenshotDir, "catalog-categories-1440.png"),
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoOverflowAndTapTargets(page, "catalog-categories@360");

    // === 5. Public Zero-JS Blog Category Archive @ 1440px & 360px ===
    const noJsCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();

    await noJsPage.goto(`${baseUrl}/public-blog-category`, { waitUntil: "domcontentloaded" });
    await noJsPage.getByTestId("blog-category-archive-hero").waitFor();
    const blogArchiveCheck = await noJsPage.evaluate(() => {
      const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") || "";
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
      const cards = document.querySelectorAll('[data-testid="blog-post-card"]').length;
      const crumbs = document.querySelectorAll('[data-testid="public-breadcrumbs"] li').length;
      const jsonLd = document.querySelector('script[type="application/ld+json"]')?.textContent || "";
      return { robots, canonical, cards, crumbs, hasBreadcrumbLd: jsonLd.includes("BreadcrumbList") };
    });
    assert(blogArchiveCheck.cards === 2, `Expected 2 published post cards, got ${blogArchiveCheck.cards}`);
    assert(blogArchiveCheck.crumbs === 3, `Expected 3 breadcrumbs, got ${blogArchiveCheck.crumbs}`);
    assert(blogArchiveCheck.robots.includes("index"), `Expected index robots meta, got: ${blogArchiveCheck.robots}`);
    assert(
      blogArchiveCheck.canonical === "https://alpha-studio.situsku.click/blog/category/panduan-bisnis",
      `Unexpected canonical: ${blogArchiveCheck.canonical}`,
    );
    assert(blogArchiveCheck.hasBreadcrumbLd, "Expected BreadcrumbList in JSON-LD");
    await assertNoOverflowAndTapTargets(noJsPage, "public-blog-category@1440");

    // Screenshot 4: Public Blog Category Archive @ 1440px
    if (screenshotDir) {
      await noJsPage.screenshot({
        path: path.join(screenshotDir, "public-blog-category-1440.png"),
        fullPage: true,
      });
    }

    await noJsPage.setViewportSize({ width: 360, height: 800 });
    await assertNoOverflowAndTapTargets(noJsPage, "public-blog-category@360");

    // === 6. Public Zero-JS Empty Catalog Category Archive (200 + noindex) ===
    await noJsPage.setViewportSize({ width: 1440, height: 900 });
    await noJsPage.goto(`${baseUrl}/public-offering-category-empty`, { waitUntil: "domcontentloaded" });
    await noJsPage.getByTestId("taxonomy-empty-state").waitFor();
    const emptyRobots = await noJsPage.evaluate(
      () => document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
    );
    assert(emptyRobots.includes("noindex"), `Empty archive must emit noindex, got: ${emptyRobots}`);
    await assertNoOverflowAndTapTargets(noJsPage, "public-offering-category-empty@1440");

    await noJsCtx.close();
    await context.close();

    assert(errors.length === 0, `Browser errors encountered:\n${errors.join("\n")}`);
    console.log("TASK-041 Playwright E2E PASSED (360px / 768px / 1440px, admin + zero-JS public archives)");
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
