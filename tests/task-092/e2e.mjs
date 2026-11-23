/* global process, console, document, window, URL, Buffer */
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

const screenshotDir = process.env.TASK092_SCREENSHOT_DIR || "/tmp/task-092-screenshots";
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

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readBodyText(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Compiles REAL Astro views + React dashboard islands for TASK-092:
 * 1. Public `/blog/strategi-efisiensi-energi-gedung` (pure SSR HTML/CSS, ZERO client JS)
 *    using `Layout.astro`, `PublicSeoHead.astro`, `_PublicBreadcrumbs.astro`,
 *    `extractAndInjectServerToc`, `buildAuthorBylineAndSchemaParity`, and `synchronizeBlogSchemaGraphAuthorAndDates`.
 * 2. Dashboard `/dashboard/alpha-studio/posts/authors` (`AuthorsManagerClient.tsx` inside `DashboardLayout.astro`).
 * 3. Dashboard `/dashboard/alpha-studio/posts/edit` (`PostEditorClient.tsx` inside `DashboardLayout.astro`).
 */
async function buildRealTask092Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t092-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(path.join(pagesDir, "blog"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "dashboard/alpha-studio/posts"), { recursive: true });

  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const publicSeoHeadImport = path.join(webDir, "src/components/seo/PublicSeoHead.astro");
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const publicPagesCssImport = path.join(webDir, "src/pages/layanan/_public-pages.css");
  const breadcrumbsImport = path.join(webDir, "src/pages/layanan/_PublicBreadcrumbs.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const blogDetailHelpersImport = path.join(webDir, "src/pages/blog/_post-detail-helpers.ts");

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const postEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/posts/_PostEditorClient.tsx",
  );
  const authorsManagerImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/posts/authors/_AuthorsManagerClient.tsx",
  );

  // 1. Public Blog Detail Page (Zero-JS TOC + Visible Author Byline with Role + Article JSON-LD Parity)
  fs.writeFileSync(
    path.join(pagesDir, "blog/strategi-efisiensi-energi-gedung.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import {
  buildAuthorBylineAndSchemaParity,
  calculateLinearReadingTimeMinutes,
  extractAndInjectServerToc,
} from "@punyasitus/core/posts/index";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { formatAuthorSameAsLabel } from "@punyasitus/core/seo/local-entity";
import PublicSeoHead from ${JSON.stringify(publicSeoHeadImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { synchronizeBlogSchemaGraphAuthorAndDates } from ${JSON.stringify(blogDetailHelpersImport)};
import Layout from ${JSON.stringify(publicLayoutImport)};
import PublicBreadcrumbs from ${JSON.stringify(breadcrumbsImport)};

const PUBLISHED_ISO = "2026-11-10T08:00:00.000Z";
const MODIFIED_ISO = "2026-11-23T14:30:00.000Z";
const PRIMARY_ORIGIN = "https://www.nusantara-arsitek.id";

const rawArticleHtml = [
  "<h2>Audit Konsumsi Listrik Gedung</h2>",
  "<p>Audit energi perkantoran dimulai dari pemetaan profil beban puncak sistem tata udara, lift, dan pencahayaan harian secara menyeluruh selama dua pekan kerja agar data dasar akurat untuk pengambilan keputusan teknis.</p>",
  "<h3>Pencahayaan LED &amp; Sensor Hunian</h3>",
  "<p>Penggantian lampu konvensional ke LED efisiensi tinggi dipadukan sensor hunian di ruang rapat dan koridor mampu menekan konsumsi listrik pencahayaan hingga 35 persen tanpa mengurangi kenyamanan visual karyawan.</p>",
  "<h3>Optimalisasi Chiller &amp; HVAC</h3>",
  "<p>Penyetelan suhu operasional HVAC pada 24 derajat Celsius disertai pembersihan berkala koil pendingin menjaga performa sistem stabil sepanjang tahun dan mencegah lonjakan biaya perawatan mendadak.</p>",
  "<h2>Estimasi Pengembalian Investasi (ROI)</h2>",
  "<p>Sebagian besar perusahaan B2B di Jakarta mencapai titik impas investasi efisiensi energi dalam 14 hingga 18 bulan dengan dokumentasi penghematan tagihan listrik bulanan yang transparan.</p>",
  "<h3>Estimasi Pengembalian Investasi (ROI)</h3>",
  "<p>Evaluasi kuartalan memastikan target penghematan terus terjaga saat kapasitas hunian kantor bertambah.</p>",
].join("\\n");

const anchored = extractAndInjectServerToc(rawArticleHtml);
const readingTimeMinutes = calculateLinearReadingTimeMinutes(anchored.html);

const { byline: authorProfile } = buildAuthorBylineAndSchemaParity({
  id: 1,
  name: "Dr. Sari Wulandari",
  roleTitle: "Direktur Teknis & Konsultan Arsitektur",
  bio: "Berpengalaman lebih dari 15 tahun mendampingi proyek perkantoran dan sertifikasi bangunan hijau B2B di Indonesia.",
  avatar: {
    id: 21,
    url: "https://www.nusantara-arsitek.id/media/author-sari.svg",
    alt: "Foto profil Dr. Sari Wulandari",
    width: 128,
    height: 128,
  },
  sameAs: [
    "https://linkedin.com/in/sariwulandari",
    "https://instagram.com/sariwulandari",
  ],
});

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
    tagline: "Desain & Audit Gedung B2B",
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
    description: "Konsultan arsitektur dan audit gedung kantor B2B.",
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
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Blog", href: "/blog/strategi-efisiensi-energi-gedung", openInNewTab: false, children: [] },
    ],
    footer: [],
    mobile: [],
  },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: 1 },
};

const seoInput = {
  surface: "public_tenant" as const,
  routeKind: "post" as const,
  pathname: "/blog/strategi-efisiensi-energi-gedung",
  tenant: {
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
  },
  siteVisibility: "public" as const,
  resourceState: "published" as const,
};

const metadata = generateOpenGraphMetadata({
  seo: seoInput,
  tenantId: "01JT092E2E0000000000000001",
  siteName: shell.site.title,
  siteTagline: shell.site.tagline,
  locale: "id-ID",
  resourceTitle: "Strategi Efisiensi Energi Gedung Kantor 2026",
  resourceExcerpt: "Panduan terukur menurunkan konsumsi listrik kantor hingga 30%.",
  ogType: "article",
  article: {
    publishedTime: PUBLISHED_ISO,
    modifiedTime: MODIFIED_ISO,
    author: authorProfile?.name ?? null,
    section: "Panduan Renovasi",
    tags: ["Efisiensi Energi", "Audit MEP"],
  },
});

const breadcrumbs = [
  { label: "Beranda", href: "/" },
  { label: "Blog", href: "/blog/strategi-efisiensi-energi-gedung" },
  { label: "Panduan Renovasi", href: "/blog/strategi-efisiensi-energi-gedung" },
  { label: "Strategi Efisiensi Energi Gedung Kantor 2026", href: null },
];

const baseSchema = generateSchemaGraph({
  seo: seoInput,
  tenantId: "01JT092E2E0000000000000001",
  siteName: shell.site.title,
  siteTagline: shell.site.tagline,
  locale: "id-ID",
  timezone: "Asia/Jakarta",
  business: {
    businessName: shell.business.name,
    businessCategory: "contractor",
    description: shell.business.description,
  },
  pageTitle: "Strategi Efisiensi Energi Gedung Kantor 2026",
  pageDescription: metadata.description,
  breadcrumbs: breadcrumbs.map((b) => ({ label: b.label, ...(b.href ? { path: b.href } : {}) })),
  article: {
    schemaType: "BlogPosting",
    headline: "Strategi Efisiensi Energi Gedung Kantor 2026",
    description: "Panduan terukur menurunkan konsumsi listrik kantor hingga 30%.",
    datePublished: PUBLISHED_ISO,
    dateModified: MODIFIED_ISO,
    authorName: authorProfile?.name ?? null,
    section: "Panduan Renovasi",
    tags: ["Efisiensi Energi", "Audit MEP"],
    inLanguage: "id-ID",
  },
}).graph;

const schemaGraph = synchronizeBlogSchemaGraphAuthorAndDates(baseSchema, {
  authorByline: authorProfile,
  publishedAtIso: PUBLISHED_ISO,
  modifiedAtIso: MODIFIED_ISO,
});
---

<Layout
  shell={shell}
  pageTitle="Strategi Efisiensi Energi Gedung Kantor 2026"
  pageDescription={metadata.description}
  managedHead={true}
  currentPath="/blog/strategi-efisiensi-energi-gedung"
>
  <PublicSeoHead
    slot="head"
    metadata={metadata}
    schemaGraph={schemaGraph}
    seoAutopilotEnabled={true}
    publishedVerificationTokens={null}
    blogEnabled={true}
    siteName={shell.site.title}
    searchAppearance={null}
  />

  <article class="ps-article-shell" data-testid="blog-detail-article">
    <div class="ps-container">
      <header class="ps-article-header">
        <PublicBreadcrumbs items={breadcrumbs} />
        <div class="ps-offering-badges" data-testid="blog-category-links">
          <a href="/blog/strategi-efisiensi-energi-gedung" class="ps-badge ps-badge--link ps-t092-chip ps-t092-chip--primary" data-primary-category="true">
            Panduan Renovasi
          </a>
        </div>
        <h1 class="ps-route-title" data-testid="blog-detail-title">
          Strategi Efisiensi Energi Gedung Kantor 2026
        </h1>
        <p class="ps-route-lead">
          Panduan terukur menurunkan konsumsi listrik kantor hingga 30%.
        </p>
        <div class="ps-article-meta" data-testid="blog-detail-meta">
          {authorProfile && (
            <span class="ps-t092-byline-inline" data-testid="blog-detail-byline">
              Oleh <strong>{authorProfile.name}</strong>
              {authorProfile.roleTitle && (
                <span class="ps-t092-byline-role"> — {authorProfile.roleTitle}</span>
              )}
            </span>
          )}
          <time datetime={PUBLISHED_ISO} data-testid="blog-published-date">
            Diterbitkan 10 November 2026
          </time>
          <time datetime={MODIFIED_ISO} data-testid="blog-modified-date">
            Diperbarui 23 November 2026
          </time>
          <span data-testid="blog-reading-time">{readingTimeMinutes} menit baca</span>
        </div>
      </header>

      <div class="ps-article-layout ps-article-layout--with-toc">
        <div>
          <div class="ps-prose" data-testid="blog-detail-body" set:html={anchored.html} />

          {authorProfile && (
            <aside class="ps-author-box" aria-label="Tentang penulis" data-testid="blog-author-box">
              <div class="ps-author-box__row">
                <img
                  src="/media/author-sari.svg"
                  alt={authorProfile.avatar?.alt ?? "Foto profil"}
                  width={64}
                  height={64}
                  class="ps-author-avatar"
                />
                <div class="ps-author-box__body">
                  <p class="ps-author-name" data-testid="blog-author-name">{authorProfile.name}</p>
                  {authorProfile.roleTitle && (
                    <p class="ps-t092-author-role" data-testid="blog-author-role">{authorProfile.roleTitle}</p>
                  )}
                  <p class="ps-author-bio" data-testid="blog-author-bio">{authorProfile.bio}</p>
                  <ul class="ps-author-links" aria-label="Tautan profil penulis" data-testid="blog-author-links">
                    {authorProfile.sameAs.map((href) => (
                      <li>
                        <a href={href} target="_blank" rel="noopener noreferrer" class="ps-author-sameas-link ps-t092-touch-link">
                          {formatAuthorSameAsLabel(href)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </aside>
          )}
        </div>

        <nav class="ps-toc ps-t092-toc" aria-label="Daftar Isi" data-testid="blog-detail-toc">
          <h2 class="ps-toc-heading">Daftar Isi</h2>
          <ol class="ps-toc-list">
            {anchored.toc.map((entry) => (
              <li class={\`ps-toc-item--h\${entry.level}\`}>
                <a href={\`#\${entry.id}\`} class="ps-toc-link ps-t092-toc-link">
                  {entry.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  </article>
</Layout>

<style>
  .ps-t092-byline-role { color: var(--ps-muted, #4b5563); font-weight: 400; }
  .ps-t092-author-role { margin: 0.125rem 0 0.5rem; font-size: 0.875rem; font-weight: 500; color: var(--ps-primary, #176b51); }
  .ps-t092-chip--primary { border-color: var(--ps-primary, #176b51); font-weight: 600; }
  .ps-t092-toc-link { display: flex; align-items: center; min-height: 44px; padding-block: 0.375rem; line-height: 1.4; }
  .ps-t092-chip, .ps-t092-touch-link { display: inline-flex; align-items: center; min-height: 44px; padding-inline: 0.75rem; }
  @media (min-width: 768px) {
    .ps-t092-toc-link { min-height: 32px; padding-block: 0.25rem; }
    .ps-t092-chip, .ps-t092-touch-link { min-height: 32px; }
  }
</style>
`,
  );

  const ownerPermissions = `{
    role: "owner",
    roleLabel: "Pemilik Situs",
    tenantStatus: "active",
    isLocked: false,
    canWriteContent: true,
    canPublishContent: true,
    canManageMedia: true,
    canUploadMedia: true,
    canManageMenus: true,
    canManageSettings: true,
  }`;

  const dashLayoutProps = (title) => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId="articles"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus="active"
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 2. Dashboard Authors Manager
  fs.writeFileSync(
    path.join(pagesDir, "dashboard/alpha-studio/posts/authors.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { AuthorsManagerClient } from ${JSON.stringify(authorsManagerImport)};
---
<DashboardLayout ${dashLayoutProps("Profil Penulis — PT Nusantara Arsitek")}>
  <AuthorsManagerClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialAuthors={[
      {
        id: 1,
        name: "Dr. Sari Wulandari",
        slug: "dr-sari-wulandari",
        roleTitle: "Direktur Teknis & Konsultan Arsitektur",
        bio: "Berpengalaman lebih dari 15 tahun mendampingi proyek perkantoran B2B.",
        avatarMediaId: 21,
        avatar: {
          id: 21,
          url: "/media/author-sari.svg",
          alt: "Foto profil Dr. Sari Wulandari",
          width: 128,
          height: 128,
        },
        sameAs: ["https://linkedin.com/in/sariwulandari"],
        postCount: 2,
        publishedPostCount: 1,
        version: 1,
        updatedAt: "2026-11-23T10:00:00.000Z",
      },
    ]}
  />
</DashboardLayout>`,
  );

  // 3. Dashboard Post Editor with Author selector, TOC preview & reading time
  fs.writeFileSync(
    path.join(pagesDir, "dashboard/alpha-studio/posts/edit.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { PostEditorClient } from ${JSON.stringify(postEditorImport)};
---
<DashboardLayout ${dashLayoutProps("Edit Artikel — PT Nusantara Arsitek")}>
  <PostEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    siteName="PT Nusantara Arsitek"
    primaryHost="www.nusantara-arsitek.id"
    seoAutopilotEnabled={true}
    initialPost={{
      id: 12,
      title: "Strategi Efisiensi Energi Gedung Kantor 2026",
      slug: "strategi-efisiensi-energi-gedung",
      excerpt: "Panduan terukur menurunkan konsumsi listrik kantor hingga 30%.",
      body: {
        schemaVersion: 1,
        blocks: [
          { type: "heading", level: 2, text: "Audit Konsumsi Listrik Gedung" },
          { type: "paragraph", text: "Langkah awal audit energi perkantoran dimulai dari pemetaan profil beban puncak." },
          { type: "heading", level: 3, text: "Pencahayaan LED & Sensor Hunian" },
          { type: "paragraph", text: "Sensor hunian membantu mengurangi pemborosan listrik di ruang rapat." },
        ],
      },
      status: "published",
      featuredMediaId: null,
      authorId: 1,
      primaryCategoryId: 3,
      categoryIds: [1, 3],
      tagIds: [10],
      enableToc: true,
      seo: null,
      hasUnpublishedChanges: false,
      publishedAt: "2026-11-10T08:00:00.000Z",
      contentModifiedAt: "2026-11-23T14:30:00.000Z",
      version: 3,
    }}
    categories={[
      { id: 1, name: "Renovasi", slug: "renovasi", depth: 1, parentId: null },
      { id: 2, name: "Kantor B2B", slug: "kantor-b2b", depth: 2, parentId: 1 },
      { id: 3, name: "Audit MEP", slug: "audit-mep", depth: 3, parentId: 2 },
    ]}
    tags={[{ id: 10, name: "Efisiensi Energi", slug: "efisiensi-energi" }]}
    authors={[
      {
        id: 1,
        name: "Dr. Sari Wulandari",
        roleTitle: "Direktur Teknis & Konsultan Arsitektur",
        bio: "Berpengalaman lebih dari 15 tahun mendampingi proyek perkantoran B2B.",
      },
      {
        id: 2,
        name: "Ir. Hendra Wijaya",
        roleTitle: "Kepala Divisi Audit Struktur",
        bio: "Spesialis inspeksi struktur dan kelistrikan gedung.",
      },
    ]}
  />
</DashboardLayout>`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;

  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  // Add clean local SVG avatar asset
  fs.mkdirSync(path.join(outDir, "media"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "media/author-sari.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="64" fill="#176b51"/><text x="64" y="76" font-family="system-ui,sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle">SW</text></svg>`,
  );

  return {
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

async function startFixtureServer(outDir) {
  let nextAuthorId = 2;
  const lastPayloads = { authorCreate: null, postPatch: null };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/tenants/alpha-studio/posts/authors" && method === "POST") {
      const body = JSON.parse(await readBodyText(req));
      lastPayloads.authorCreate = body;
      const id = nextAuthorId++;
      return json(201, {
        id,
        name: body.name,
        slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        roleTitle: body.roleTitle ?? null,
        bio: body.bio ?? null,
        avatarMediaId: body.avatarMediaId ?? null,
        avatar: null,
        sameAs: body.sameAs ?? [],
        postCount: 0,
        publishedPostCount: 0,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/tenants/alpha-studio/posts/12" && method === "PATCH") {
      const body = JSON.parse(await readBodyText(req));
      lastPayloads.postPatch = body;
      return json(200, {
        id: 12,
        slug: body.slug || "strategi-efisiensi-energi-gedung",
        title: body.title,
        excerpt: body.excerpt ?? null,
        status: "published",
        body: body.body,
        featuredMediaId: body.featuredMediaId ?? null,
        authorId: body.authorId ?? null,
        primaryCategoryId: body.primaryCategoryId ?? null,
        categoryIds: body.categoryIds ?? [],
        tagIds: body.tagIds ?? [],
        enableToc: Boolean(body.enableToc),
        hasUnpublishedChanges: true,
        publishedAt: "2026-11-10T08:00:00.000Z",
        contentModifiedAt: "2026-11-23T14:30:00.000Z",
        version: (body.version ?? 3) + 1,
      });
    }

    let filePath = path.join(outDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "Content-Type": getContentType(filePath) });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    lastPayloads,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function run() {
  const { outDir, cleanup } = await buildRealTask092Fixtures();
  const srv = await startFixtureServer(outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // =========================================================================
    // 1. Public Blog Detail with JavaScript DISABLED (360px & 1440px)
    // =========================================================================
    for (const vp of [
      { name: "desktop-1440", width: 1440, height: 900 },
      { name: "mobile-360", width: 360, height: 800 },
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        javaScriptEnabled: false,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });

      const targetUrl = `${srv.baseUrl}/blog/strategi-efisiensi-energi-gedung`;
      const resp = await page.goto(targetUrl, { waitUntil: "load" });
      assert(resp && resp.status() === 200, `Expected 200 on public blog detail (${vp.name})`);

      // Verify ZERO TOC/article client scripts or hydrated islands on public blog detail
      // (the browser context also has `javaScriptEnabled: false` proving 100% zero-JS rendering & navigation!)
      const articleScriptAudit = await page.evaluate(() => {
        const articleScripts = document.querySelectorAll(
          '[data-testid="blog-detail-article"] script, [data-testid="blog-detail-toc"] script',
        ).length;
        const astroIslands = document.querySelectorAll("astro-island").length;
        const tocScriptRefs = Array.from(document.querySelectorAll("script[src]"))
          .map((s) => s.getAttribute("src") || "")
          .filter((src) => /toc|react|posteditor/i.test(src));
        return { articleScripts, astroIslands, tocScriptRefs };
      });
      assert(
        articleScriptAudit.articleScripts === 0 &&
          articleScriptAudit.astroIslands === 0 &&
          articleScriptAudit.tocScriptRefs.length === 0,
        `Public blog detail TOC/article must ship ZERO client JS / islands (got ${JSON.stringify(articleScriptAudit)})`,
      );

      // Verify visible byline, roleTitle, bio, reading time, published & updated dates
      const visibleFacts = await page.evaluate(() => {
        const byline = document.querySelector('[data-testid="blog-detail-byline"]')?.textContent?.trim() ?? "";
        const authorName = document.querySelector('[data-testid="blog-author-name"]')?.textContent?.trim() ?? "";
        const authorRole = document.querySelector('[data-testid="blog-author-role"]')?.textContent?.trim() ?? "";
        const authorBio = document.querySelector('[data-testid="blog-author-bio"]')?.textContent?.trim() ?? "";
        const readingTime = document.querySelector('[data-testid="blog-reading-time"]')?.textContent?.trim() ?? "";
        const modifiedEl = document.querySelector('[data-testid="blog-modified-date"]');
        const publishedEl = document.querySelector('[data-testid="blog-published-date"]');
        const tocLinks = Array.from(document.querySelectorAll('[data-testid="blog-detail-toc"] a')).map((a) => ({
          href: a.getAttribute("href"),
          text: a.textContent?.trim() ?? "",
          height: a.getBoundingClientRect().height,
        }));
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const ldBlocks = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]'),
        ).map((s) => JSON.parse(s.textContent || "{}"));

        return {
          byline,
          authorName,
          authorRole,
          authorBio,
          readingTime,
          publishedIso: publishedEl?.getAttribute("datetime"),
          modifiedIso: modifiedEl?.getAttribute("datetime"),
          modifiedText: modifiedEl?.textContent?.trim() ?? "",
          tocLinks,
          overflow,
          ldBlocks,
        };
      });

      assert(visibleFacts.byline.includes("Dr. Sari Wulandari"), `Visible byline missing name (${vp.name})`);
      assert(
        visibleFacts.authorRole === "Direktur Teknis & Konsultan Arsitektur",
        `Visible author role mismatch (${vp.name})`,
      );
      assert(visibleFacts.readingTime.includes("menit baca"), `Reading time missing (${vp.name})`);
      assert(visibleFacts.modifiedText.includes("Diperbarui"), `Modified date label missing (${vp.name})`);
      assert(visibleFacts.overflow <= 1, `Horizontal overflow on public blog (${vp.name}): ${visibleFacts.overflow}px`);

      // Verify JSON-LD Article.author & dateModified parity with visible DOM
      assert(visibleFacts.ldBlocks.length === 1, "Expected exactly 1 JSON-LD @graph block");
      const graph = visibleFacts.ldBlocks[0]["@graph"] || [];
      const articleNode = graph.find((n) => n["@type"] === "BlogPosting" || n["@type"] === "Article");
      assert(articleNode, "Missing BlogPosting/Article node in JSON-LD");
      assert(articleNode.author?.name === visibleFacts.authorName, "JSON-LD author.name !== visible authorName");
      assert(articleNode.author?.jobTitle === visibleFacts.authorRole, "JSON-LD author.jobTitle !== visible roleTitle");
      assert(articleNode.author?.description === visibleFacts.authorBio, "JSON-LD author.description !== visible bio");
      assert(articleNode.datePublished === visibleFacts.publishedIso, "JSON-LD datePublished mismatch");
      assert(articleNode.dateModified === visibleFacts.modifiedIso, "JSON-LD dateModified mismatch");

      // Verify zero-JS TOC anchor links match rendered H2/H3 IDs 1:1 & mobile touch target >= 44px
      assert(visibleFacts.tocLinks.length === 5, `Expected 5 TOC links, got ${visibleFacts.tocLinks.length}`);
      for (const link of visibleFacts.tocLinks) {
        assert(link.href && link.href.startsWith("#"), `Invalid TOC href: ${link.href}`);
        const targetId = link.href.slice(1);
        const targetExists = await page.evaluate((id) => Boolean(document.getElementById(id)), targetId);
        assert(targetExists, `TOC anchor target #${targetId} missing in rendered HTML!`);
        if (vp.width === 360) {
          assert(link.height >= 44, `Mobile TOC link "${link.text}" height ${link.height}px < 44px`);
        }
      }

      // Click a TOC anchor with JS DISABLED and verify native browser fragment navigation works!
      const targetAnchorHref = visibleFacts.tocLinks[3].href; // #estimasi-pengembalian-investasi-roi
      await page.click(`[data-testid="blog-detail-toc"] a[href="${targetAnchorHref}"]`);
      assert(
        page.url().endsWith(targetAnchorHref),
        `Expected zero-JS TOC click to navigate to ${targetAnchorHref}, got ${page.url()}`,
      );

      assert(errors.length === 0, `Errors on public blog (${vp.name}): ${errors.join("; ")}`);
      await page.screenshot({
        path: path.join(screenshotDir, `blog-detail-${vp.name}.png`),
        fullPage: true,
      });
      await ctx.close();
    }

    // =========================================================================
    // 2. Dashboard Author Profiles & Post Editor UI (360px & 1440px)
    // =========================================================================
    for (const vp of [
      { name: "desktop-1440", width: 1440, height: 900 },
      { name: "mobile-360", width: 360, height: 800 },
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });

      // 2a. Dashboard Authors Manager
      await page.goto(`${srv.baseUrl}/dashboard/alpha-studio/posts/authors`, {
        waitUntil: "networkidle",
      });
      await page.waitForSelector('[data-testid="authors-manager-screen"]');

      if (vp.width === 1440) {
        await page.fill('[data-testid="author-name-input"]', "Rina Kartika, S.Ars");
        await page.fill('[data-testid="author-role-input"]', "Lead MEP Auditor");
        await page.fill(
          '[data-testid="author-bio-input"]',
          "Konsultan efisiensi energi dan sistem kelistrikan gedung B2B.",
        );
        await page.click('[data-testid="author-save-btn"]');
        await page.waitForSelector('[data-testid="authors-feedback"]');
        assert(
          srv.lastPayloads.authorCreate?.roleTitle === "Lead MEP Auditor",
          "Expected POST /posts/authors payload to carry roleTitle",
        );
      }

      const authorsAudit = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const saveBtnHeight =
          document.querySelector('[data-testid="author-save-btn"]')?.getBoundingClientRect().height ?? 0;
        return { overflow, saveBtnHeight };
      });
      assert(authorsAudit.overflow <= 1, `Horizontal overflow on authors UI (${vp.name}): ${authorsAudit.overflow}px`);
      if (vp.width === 360) {
        assert(authorsAudit.saveBtnHeight >= 44, `Mobile author save button < 44px: ${authorsAudit.saveBtnHeight}px`);
      }

      await page.screenshot({
        path: path.join(screenshotDir, `dashboard-authors-${vp.name}.png`),
        fullPage: true,
      });

      // 2b. Dashboard Post Editor (Author selector, Reading time, Live Zero-JS TOC preview, Primary category)
      await page.goto(`${srv.baseUrl}/dashboard/alpha-studio/posts/edit`, {
        waitUntil: "networkidle",
      });
      await page.waitForSelector('[data-testid="post-editor-screen"]');
      await page.waitForSelector('[data-testid="post-author-select"]');
      await page.waitForSelector('[data-testid="post-toc-preview"]');

      if (vp.width === 1440) {
        await page.selectOption('[data-testid="post-author-select"]', "2");
        const previewText = await page.textContent('[data-testid="post-selected-author-preview"]');
        assert(
          previewText && previewText.includes("Ir. Hendra Wijaya"),
          "Post editor author preview did not update after selecting author #2",
        );

        await page.click('[data-testid="post-save-btn"]');
        await page.waitForSelector('[data-testid="post-editor-feedback"]');
        assert(
          srv.lastPayloads.postPatch?.authorId === 2,
          "Expected PATCH /posts/12 to persist selected authorId=2",
        );
      }

      const editorAudit = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const authorSelectHeight =
          document.querySelector('[data-testid="post-author-select"]')?.getBoundingClientRect().height ?? 0;
        const tocText = document.querySelector('[data-testid="post-toc-preview"]')?.textContent ?? "";
        const readingText = document.querySelector('[data-testid="post-reading-time-summary"]')?.textContent ?? "";
        return { overflow, authorSelectHeight, tocText, readingText };
      });

      assert(editorAudit.overflow <= 1, `Horizontal overflow on post editor (${vp.name}): ${editorAudit.overflow}px`);
      assert(editorAudit.tocText.includes("#audit-konsumsi-listrik-gedung"), "Live TOC preview missing heading anchor");
      assert(editorAudit.readingText.includes("menit baca"), "Reading time badge missing in post editor");
      if (vp.width === 360) {
        assert(
          editorAudit.authorSelectHeight >= 44,
          `Mobile author select < 44px: ${editorAudit.authorSelectHeight}px`,
        );
      }

      assert(errors.length === 0, `Errors on dashboard UI (${vp.name}): ${errors.join("; ")}`);
      await page.screenshot({
        path: path.join(screenshotDir, `dashboard-post-editor-${vp.name}.png`),
        fullPage: true,
      });
      await ctx.close();
    }

    console.log("TASK-092 E2E PASSED — screenshots saved to:", screenshotDir);
  } finally {
    await browser.close();
    await srv.close();
    cleanup();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
