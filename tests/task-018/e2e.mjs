/* global process, console, document, window, getComputedStyle, URL */
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

const screenshotDir = process.env.TASK018_SCREENSHOT_DIR || "";

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

function createFixtureArtwork(publicMediaDir) {
  fs.mkdirSync(publicMediaDir, { recursive: true });
  const svgs = [
    {
      name: "studio-hero.svg",
      bg: "#1c2d4a",
      accent: "#9c3d1a",
      title: "Studio Arsitektur Nusantara",
      subtitle: "Desain & Konsultasi Korporat B2B",
    },
    {
      name: "fallback-hero.svg",
      bg: "#176b51",
      accent: "#0f4c5c",
      title: "CV Karya Mandiri",
      subtitle: "Layanan Teknik & Operasional",
    },
  ];
  const escapeXml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const item of svgs) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="${item.bg}"/>
  <rect x="64" y="64" width="1072" height="672" rx="8" fill="${item.accent}" fill-opacity="0.28" stroke="#ffffff" stroke-opacity="0.25" stroke-width="2"/>
  <text x="112" y="385" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="700">${escapeXml(item.title)}</text>
  <text x="112" y="452" fill="#e2e8f0" font-family="system-ui, -apple-system, sans-serif" font-size="30" font-weight="500">${escapeXml(item.subtitle)}</text>
</svg>`;
    fs.writeFileSync(path.join(publicMediaDir, item.name), svg, "utf8");
  }
}

/**
 * Compiles the REAL `theme-registry.ts`, `sample-agency/**`, `default/Layout.astro`,
 * `SEOHead.astro`, `Consent.astro`, and `SectionRenderer.astro` via Astro build
 * inside an isolated temporary directory under `apps/web/.astro/`.
 */
async function buildRealCustomThemeFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t018-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const publicDir = path.join(tmpRoot, "public");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");

  fs.mkdirSync(path.join(pagesDir, "tenant-a/blog"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "tenant-a/layanan"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "tenant-b"), { recursive: true });
  createFixtureArtwork(path.join(publicDir, "media/t/demo"));

  const themeRegistryImport = path.join(webDir, "src/core/theme-registry.ts");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const dispatcherImport = path.join(
    webDir,
    "src/themes/custom/sample-agency/RouteDispatcher.astro",
  );
  const sampleThemeImport = path.join(webDir, "src/themes/custom/sample-agency/theme.ts");

  fs.writeFileSync(
    path.join(srcDir, "fixtures.ts"),
    `import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { buildPublicThemeRouteShellContract } from ${JSON.stringify(themeRegistryImport)};
import { SAMPLE_AGENCY_THEME_ID } from ${JSON.stringify(sampleThemeImport)};

export const TENANT_A_ID = "01JTESTTENANTALPHA00000001";
export const TENANT_B_ID = "01JTESTTENANTBETA000000002";

export const TENANT_A_GRANT = [
  { tenantId: TENANT_A_ID, themeId: SAMPLE_AGENCY_THEME_ID, active: true, grantedBy: "op-1" },
];

export const TENANT_A_SHELL = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: SAMPLE_AGENCY_THEME_ID,
  baseThemeId: "compro" as const,
  themeStyle: buildSafeThemeStyleBlock(null, "compro"),
  site: {
    title: "Studio Arsitektur Nusantara",
    tagline: "Konsultan Perancangan & Sistem Ruang B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Studio Arsitektur Nusantara",
    category: "Organization",
    description: "Mitra perancangan ruang kerja, audit teknis, dan pengawasan proyek sejak 2018.",
    address: "Jl. Kemang Raya No. 18",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    mapsUrl: "https://maps.google.com/?q=-6.2607,106.8132",
    weekdayHours: "Senin–Jumat 09.00–17.30 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@studio-arsitektur.id",
    socialLinks: [{ platform: "linkedin" as const, url: "https://linkedin.com/company/studioarsitektur" }],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/tenant-a/", openInNewTab: false, children: [] },
      { label: "Tentang", href: "/tenant-a/tentang-kami/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "/tenant-a/layanan/", openInNewTab: false, children: [] },
      { label: "Blog", href: "/tenant-a/blog/", openInNewTab: false, children: [] },
    ],
    footer: [
      { label: "Tentang Kami", href: "/tenant-a/tentang-kami/", openInNewTab: false, children: [] },
      { label: "Daftar Layanan", href: "/tenant-a/layanan/", openInNewTab: false, children: [] },
    ],
    mobile: [],
  },
  page: null,
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};

export const TENANT_B_SHELL = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: "compro" as const,
  themeStyle: buildSafeThemeStyleBlock(null, "compro"),
  site: {
    title: "CV Karya Mandiri Teknik",
    tagline: "Pemeliharaan Mesin & Utilitas Industri",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "CV Karya Mandiri Teknik",
    category: "LocalBusiness",
    description: "Jasa perawatan berkala dan inspeksi instalasi industri Jawa Barat.",
    address: "Jl. Soekarno Hatta No. 112",
    city: "Bandung",
    province: "Jawa Barat",
    postalCode: "40223",
    mapsUrl: "https://maps.google.com/?q=-6.9425,107.6061",
    weekdayHours: "Senin–Sabtu 08.00–16.30 WIB",
    holidayHours: "Minggu Tutup",
    phone: "6281299988877",
    whatsappE164: "6281299988877",
    email: "kontak@karyamandiri-teknik.id",
    socialLinks: [{ platform: "instagram" as const, url: "https://instagram.com/karyamandiriteknik" }],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/tenant-b/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "#penawaran-b", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Beranda", href: "/tenant-b/", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: null,
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};

export const TENANT_A_HOME_SECTIONS = [
  {
    id: "hero-agency",
    type: "hero",
    enabled: true,
    config: {
      eyebrow: "Tema Khusus Agensi",
      heading: "Arsitektur Ruang Usaha yang Presisi, Fungsional & Terukur",
      subheading:
        "Kami mendampingi perusahaan merancang ruang kerja komersial dengan dokumentasi terstruktur, jadwal transparan, dan komunikasi langsung via WhatsApp.",
      primaryCta: {
        label: "Konsultasi WhatsApp",
        href: "https://wa.me/6281234567890",
        variant: "whatsapp",
        openInNewTab: true,
      },
      secondaryCta: {
        label: "Lihat Layanan",
        href: "/tenant-a/layanan/",
        variant: "secondary",
      },
      media: {
        src: "/media/t/demo/studio-hero.svg",
        alt: "Ilustrasi proyek Studio Arsitektur Nusantara",
        width: 1200,
        height: 800,
      },
      highlights: ["Kontras WCAG 2.2 AA", "0 KiB JS Tema Kustom", "Shared Shell SEO & Consent"],
    },
  },
  {
    id: "keunggulan-agency",
    type: "features",
    enabled: true,
    config: {
      eyebrow: "Metodologi Kerja",
      heading: "Tiga Pilar Pendampingan Proyek B2B",
      columns: 3,
      items: [
        {
          title: "Audit Kebutuhan Ruang",
          description: "Pemetaan kapasitas tim, alur kerja harian, dan standar keselamatan bangunan.",
          badge: "Tahap 1",
        },
        {
          title: "Gambar Kerja Terukur",
          description: "Spesifikasi material terbuka dengan estimasi biaya yang dapat diaudit.",
          badge: "Tahap 2",
        },
        {
          title: "Pengawasan Berkala",
          description: "Laporan progres mingguan hingga serah terima operasional selesai.",
          badge: "Tahap 3",
        },
      ],
    },
  },
];

export const TENANT_B_HOME_SECTIONS = [
  {
    id: "hero-b",
    type: "hero",
    enabled: true,
    config: {
      eyebrow: "Layanan Teknik Industri",
      heading: "Pemeliharaan Mesin & Utilitas Pabrik Terjadwal",
      subheading:
        "Tenant B tidak memiliki hak akses tema kustom agensi sehingga sistem otomatis kembali ke tema platform standar compro dengan aman.",
      primaryCta: {
        label: "Hubungi Tim Teknik",
        href: "https://wa.me/6281299988877",
        variant: "whatsapp",
        openInNewTab: true,
      },
      media: {
        src: "/media/t/demo/fallback-hero.svg",
        alt: "Ilustrasi layanan CV Karya Mandiri Teknik",
        width: 1200,
        height: 800,
      },
    },
  },
];

export function buildTenantAContract(
  routeKind: "home" | "page" | "blog_index" | "blog_post" | "catalog_index" | "catalog_detail" | "not_found",
  pathname: string,
  pageTitle?: string,
) {
  return buildPublicThemeRouteShellContract({
    routeKind,
    pathname,
    entitlement: {
      tenantId: TENANT_A_ID,
      tenantStatus: "active",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: TENANT_A_GRANT,
    },
    shell: TENANT_A_SHELL,
    seo: {
      surface: routeKind === "not_found" ? "error" : "public_tenant",
      tenant: {
        tenantHandle: "studio-arsitektur",
        tenantStatus: "active",
      },
      resourceState: routeKind === "not_found" ? "missing" : "published",
      publishedItemCount: 3,
    },
    pageTitle: pageTitle ?? null,
    headerCtaLabel: "Jadwalkan Konsultasi",
    headerCtaHref: "https://wa.me/6281234567890",
  });
}

export function buildTenantBFallbackContract(requestedThemeId: string, pathname: string) {
  return buildPublicThemeRouteShellContract({
    routeKind: "home",
    pathname,
    entitlement: {
      tenantId: TENANT_B_ID,
      tenantStatus: "active",
      requestedThemeId,
      // Deliberately pass Tenant A's grant record to prove cross-tenant isolation in SSR too!
      tenantGrants: TENANT_A_GRANT,
    },
    shell: TENANT_B_SHELL,
    seo: {
      surface: "public_tenant",
      tenant: {
        tenantHandle: "karya-mandiri",
        tenantStatus: "active",
      },
      resourceState: "published",
    },
    headerCtaLabel: "Hubungi Kami",
    headerCtaHref: "https://wa.me/6281299988877",
  });
}
`,
    "utf8",
  );

  const fixturesImport = path.join(srcDir, "fixtures.ts");

  // Tenant A — All 7 public routes
  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/index.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract, TENANT_A_HOME_SECTIONS } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("home", "/");
---
<RouteDispatcher
  contract={contract}
  routeData={{ kind: "home", sections: TENANT_A_HOME_SECTIONS, primaryOrigin: "https://studio-arsitektur.situsku.click" }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/tentang-kami.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("page", "/tentang-kami", "Tentang Kami");
const sections = [
  {
    id: "about-page-text",
    type: "about",
    enabled: true,
    config: {
      eyebrow: "Profil Studio",
      heading: "Pengalaman Mendampingi Perusahaan Indonesia",
      bodyHtml: "<p>Kami mengutamakan kejelasan spesifikasi teknis dan keterbukaan biaya.</p><script>window.__t018Xss=true</script>",
      milestones: [
        { value: "8+", label: "Tahun Praktik" },
        { value: "120+", label: "Proyek Selesai" },
      ],
    },
  },
];
---
<RouteDispatcher
  contract={contract}
  pageTitle="Tentang Kami"
  routeData={{ kind: "page", slug: "tentang-kami", title: "Tentang Kami", sections }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/blog/index.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("blog_index", "/blog", "Blog & Panduan");
---
<RouteDispatcher
  contract={contract}
  pageTitle="Blog & Panduan"
  routeData={{
    kind: "blog_index",
    heading: "Artikel & Catatan Studio",
    posts: [
      {
        slug: "panduan-arsitektur-web",
        title: "Menyiapkan Brief Desain Kantor yang Efektif",
        excerpt: "Langkah awal menyusun kebutuhan ruang kerja, anggaran, dan jadwal implementasi.",
        categoryName: "Panduan",
        authorName: "Tim Editorial",
        publishedAt: "2026-11-10T08:00:00Z",
        readingTimeMinutes: 4,
      },
    ],
    pagination: { currentPage: 1, totalPages: 2, nextHref: "/tenant-a/blog/" },
  }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/blog/panduan-arsitektur-web.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("blog_post", "/blog/panduan-arsitektur-web", "Menyiapkan Brief Desain Kantor yang Efektif");
---
<RouteDispatcher
  contract={contract}
  pageTitle="Menyiapkan Brief Desain Kantor yang Efektif"
  routeData={{
    kind: "blog_post",
    post: {
      slug: "panduan-arsitektur-web",
      title: "Menyiapkan Brief Desain Kantor yang Efektif",
      categoryName: "Panduan",
      authorName: "Rama Pratama",
      authorRoleTitle: "Arsitek Utama",
      publishedAt: "2026-11-10T08:00:00Z",
      readingTimeMinutes: 4,
      bodyHtml: "<p>Dokumen brief yang rapi menghindarkan revisi berulang saat tahap konstruksi berjalan.</p><p>Pastikan kapasitas tim, kebutuhan ruang rapat, serta standar ventilasi dicatat sejak awal.</p><script>window.__t018PostXss=true</script>",
      tags: ["arsitektur", "kantor"],
    },
  }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/layanan/index.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("catalog_index", "/layanan", "Daftar Layanan");
---
<RouteDispatcher
  contract={contract}
  pageTitle="Daftar Layanan"
  routeData={{
    kind: "catalog_index",
    offeringType: "service",
    heading: "Layanan Perancangan & Audit",
    items: [
      {
        slug: "audit-sistem-digital",
        offeringType: "service",
        title: "Audit Tata Ruang & Efisiensi Kantor",
        summary: "Evaluasi menyeluruh tata letak, pencahayaan, akustik, dan rekomendasi renovasi.",
        priceMode: "from",
        price: 7500000,
        negotiable: true,
        categoryName: "Konsultasi",
        ctaKind: "whatsapp",
        whatsappPhone: "081234567890",
      },
    ],
  }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/layanan/audit-sistem-digital.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("catalog_detail", "/layanan/audit-sistem-digital", "Audit Tata Ruang & Efisiensi Kantor");
---
<RouteDispatcher
  contract={contract}
  pageTitle="Audit Tata Ruang & Efisiensi Kantor"
  routeData={{
    kind: "catalog_detail",
    item: {
      slug: "audit-sistem-digital",
      offeringType: "service",
      title: "Audit Tata Ruang & Efisiensi Kantor",
      summary: "Evaluasi menyeluruh tata letak, pencahayaan, akustik, dan rekomendasi renovasi.",
      priceMode: "from",
      price: 7500000,
      negotiable: true,
      categoryName: "Konsultasi",
      ctaKind: "whatsapp",
      whatsappPhone: "081234567890",
      descriptionHtml: "<p>Layanan mencakup survei lokasi, pengukuran teknis, dan laporan rekomendasi tertulis.</p>",
      highlights: ["Survei lokasi langsung", "Laporan rekomendasi 2 minggu kerja"],
      facts: [
        { label: "Durasi", value: "14 hari kerja" },
        { label: "Cakupan", value: "Jabodetabek & Bandung" },
      ],
    },
  }}
/>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "tenant-a/tidak-ditemukan.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantAContract } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantAContract("not_found", "/tidak-ditemukan", "Halaman Tidak Ditemukan");
---
<RouteDispatcher
  contract={contract}
  pageTitle="Halaman Tidak Ditemukan"
  routeData={{ kind: "not_found", requestedPath: "/tidak-ditemukan" }}
/>
`,
  );

  // Tenant B — Ungranted custom theme (safe fallback to compro!)
  fs.writeFileSync(
    path.join(pagesDir, "tenant-b/index.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantBFallbackContract, TENANT_B_HOME_SECTIONS } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantBFallbackContract("custom-sample-agency", "/");
---
<RouteDispatcher
  contract={contract}
  routeData={{ kind: "home", sections: TENANT_B_HOME_SECTIONS, primaryOrigin: "https://karya-mandiri.situsku.click" }}
/>
`,
  );

  // Tenant B — Unknown custom theme ID (safe fallback to compro!)
  fs.writeFileSync(
    path.join(pagesDir, "tenant-b/unknown.astro"),
    `---
import RouteDispatcher from ${JSON.stringify(dispatcherImport)};
import { buildTenantBFallbackContract, TENANT_B_HOME_SECTIONS } from ${JSON.stringify(fixturesImport)};
const contract = buildTenantBFallbackContract("custom-does-not-exist", "/");
---
<RouteDispatcher
  contract={contract}
  routeData={{ kind: "home", sections: TENANT_B_HOME_SECTIONS, primaryOrigin: "https://karya-mandiri.situsku.click" }}
/>
`,
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    publicDir,
    outDir,
    cacheDir,
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
    tmpRoot,
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function startStaticServer(outDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) {
      relPath = path.join(relPath, "index.html");
    }
    let fullPath = path.resolve(outDir, relPath);
    if (!fullPath.startsWith(path.resolve(outDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      const asIndex = path.join(fullPath, "index.html");
      if (fs.existsSync(asIndex)) {
        fullPath = asIndex;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": getContentType(fullPath) });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealCustomThemeFixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // -----------------------------------------------------------------------
    // 0. Static SSR HTML assertions (zero-FOUC tokens, SEOHead, JSON-LD, Consent, XSS strip)
    // -----------------------------------------------------------------------
    const tenantAHomeHtml = fs.readFileSync(
      path.join(fixtures.outDir, "tenant-a/index.html"),
      "utf8",
    );
    const bodyIdxA = tenantAHomeHtml.indexOf("<body");
    const tokenIdxA = tenantAHomeHtml.indexOf("--ps-brand-primary: #1c2d4a");
    assert(
      tokenIdxA > 0 && tokenIdxA < bodyIdxA,
      "Tenant A custom theme primary token #1c2d4a must be emitted in <head> before <body>",
    );
    assert(
      tenantAHomeHtml.includes('data-ps-custom-theme="custom-sample-agency"'),
      "Tenant A must render custom-sample-agency theme frame",
    );
    assert(
      tenantAHomeHtml.includes('rel="canonical" href="https://studio-arsitektur.situsku.click/"'),
      "Tenant A homepage must emit verified canonical URL via <SEOHead>",
    );
    assert(
      tenantAHomeHtml.includes('type="application/ld+json"'),
      "Tenant A homepage must emit Schema.org JSON-LD via <SEOHead>",
    );
    assert(
      tenantAHomeHtml.includes("data-ps-consent-root"),
      "Tenant A homepage must mount shared <Consent> inside shell",
    );

    const tenantAPostHtml = fs.readFileSync(
      path.join(fixtures.outDir, "tenant-a/blog/panduan-arsitektur-web/index.html"),
      "utf8",
    );
    assert(!tenantAPostHtml.includes("__t018PostXss"), "Blog post rich-text <script> must be stripped");

    const tenantANotFoundHtml = fs.readFileSync(
      path.join(fixtures.outDir, "tenant-a/tidak-ditemukan/index.html"),
      "utf8",
    );
    assert(
      tenantANotFoundHtml.includes('name="robots" content="noindex, nofollow"'),
      "not_found route MUST emit noindex, nofollow",
    );
    assert(
      !tenantANotFoundHtml.includes('rel="canonical"'),
      "not_found route MUST NOT emit canonical link",
    );
    assert(
      !tenantANotFoundHtml.includes('type="application/ld+json"'),
      "not_found route MUST NOT emit JSON-LD",
    );

    const tenantBHomeHtml = fs.readFileSync(
      path.join(fixtures.outDir, "tenant-b/index.html"),
      "utf8",
    );
    assert(
      !tenantBHomeHtml.includes("data-ps-custom-theme"),
      "Tenant B (ungranted) MUST NOT render custom-sample-agency theme frame",
    );
    assert(
      tenantBHomeHtml.includes('data-ps-fallback-theme="compro"'),
      "Tenant B (ungranted) must render safe compro fallback frame",
    );
    assert(
      tenantBHomeHtml.includes("--ps-brand-primary: #176b51"),
      "Tenant B fallback must apply default compro primary #176b51",
    );
    assert(
      !tenantBHomeHtml.includes("Studio Arsitektur Nusantara") &&
        !tenantBHomeHtml.includes("studio-arsitektur.situsku.click"),
      "Tenant B HTML MUST NEVER leak Tenant A brand or origin",
    );

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // -----------------------------------------------------------------------
    // 1. No-JS Progressive Enhancement @ 360px on custom-sample-agency
    // -----------------------------------------------------------------------
    {
      const noJsCtx = await browser.newContext({
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsCtx.newPage();
      await noJsPage.goto(`${server.baseUrl}/tenant-a/`, { waitUntil: "load" });
      const noJsInfo = await noJsPage.evaluate(() => ({
        primary: getComputedStyle(document.documentElement)
          .getPropertyValue("--ps-brand-primary")
          .trim(),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      assert(noJsInfo.primary === "#1c2d4a", `No-JS custom theme expected #1c2d4a, got ${noJsInfo.primary}`);
      assert(!noJsInfo.overflow, "No-JS 360px custom theme must have zero horizontal overflow");

      const mobileToggle = noJsPage.locator('[data-testid="mobile-nav-toggle"]');
      const mobileDetails = noJsPage.locator('[data-testid="mobile-nav-details"]');
      await mobileToggle.click();
      assert(
        await mobileDetails.evaluate((el) => el.hasAttribute("open")),
        "No-JS 360px mobile <details> navigation must open without JS",
      );
      await noJsCtx.close();
    }

    // -----------------------------------------------------------------------
    // 2. Full JS Chromium Checks @ 1440px & 360px across ALL 7 Tenant A routes + Tenant B fallback
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const tenantARoutes = [
      { url: "/tenant-a/", testId: "route-home", canonical: "https://studio-arsitektur.situsku.click/", expectSchema: true },
      { url: "/tenant-a/tentang-kami/", testId: "route-page", canonical: "https://studio-arsitektur.situsku.click/tentang-kami", expectSchema: true },
      { url: "/tenant-a/blog/", testId: "route-blog-index", canonical: "https://studio-arsitektur.situsku.click/blog", expectSchema: true },
      { url: "/tenant-a/blog/panduan-arsitektur-web/", testId: "route-blog-post", canonical: "https://studio-arsitektur.situsku.click/blog/panduan-arsitektur-web", expectSchema: true },
      { url: "/tenant-a/layanan/", testId: "route-catalog-index", canonical: "https://studio-arsitektur.situsku.click/layanan", expectSchema: true },
      { url: "/tenant-a/layanan/audit-sistem-digital/", testId: "route-catalog-detail", canonical: "https://studio-arsitektur.situsku.click/layanan/audit-sistem-digital", expectSchema: true },
      { url: "/tenant-a/tidak-ditemukan/", testId: "route-not-found", canonical: null, expectSchema: false },
    ];

    for (const vp of [
      { width: 1440, height: 900, label: "1440px" },
      { width: 360, height: 800, label: "360px" },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const route of tenantARoutes) {
        await page.goto(`${server.baseUrl}${route.url}`, { waitUntil: "networkidle" });
        const metrics = await page.evaluate((expectedTestId) => {
          const rootCs = getComputedStyle(document.documentElement);
          const canonicalEl = document.querySelector('link[rel="canonical"]');
          const robotsEl = document.querySelector('meta[name="robots"]');
          const ldScripts = Array.from(
            document.querySelectorAll('script[type="application/ld+json"]'),
          ).map((s) => s.textContent || "");
          const consentRoot = document.querySelector("[data-ps-consent-root]");
          const customFrame = document.querySelector('[data-ps-custom-theme="custom-sample-agency"]');
          const routeNode = document.querySelector(`[data-testid="${expectedTestId}"]`);

          const tapTargets = Array.from(
            document.querySelectorAll(
              '[data-testid="mobile-nav-toggle"], [data-testid="site-brand-link"], .sa-btn, .sa-breadcrumb-link',
            ),
          )
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { text: el.textContent?.trim() ?? "", width: r.width, height: r.height };
            });

          return {
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            primary: rootCs.getPropertyValue("--ps-brand-primary").trim(),
            surface: rootCs.getPropertyValue("--ps-surface").trim(),
            radius: rootCs.getPropertyValue("--ps-radius").trim(),
            hasCustomFrame: Boolean(customFrame),
            hasRouteNode: Boolean(routeNode),
            hasConsent: Boolean(consentRoot),
            canonicalHref: canonicalEl ? canonicalEl.getAttribute("href") : null,
            robotsContent: robotsEl ? robotsEl.getAttribute("content") : null,
            ldCount: ldScripts.length,
            ldValidJson: ldScripts.every((raw) => {
              try {
                const parsed = JSON.parse(raw);
                return parsed && parsed["@context"] === "https://schema.org";
              } catch {
                return false;
              }
            }),
            tapTargets,
            xssTriggered: Boolean(window.__t018Xss || window.__t018PostXss),
          };
        }, route.testId);

        assert(!metrics.xssTriggered, `${route.url} (${vp.label}): XSS payload must never execute`);
        assert(!metrics.overflow, `${route.url} (${vp.label}): horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`);
        assert(metrics.hasCustomFrame, `${route.url} (${vp.label}): missing custom-sample-agency frame`);
        assert(metrics.hasRouteNode, `${route.url} (${vp.label}): missing route marker ${route.testId}`);
        assert(metrics.hasConsent, `${route.url} (${vp.label}): missing shared <Consent> root`);
        assert(metrics.primary === "#1c2d4a", `${route.url}: expected #1c2d4a, got ${metrics.primary}`);
        assert(metrics.surface === "#fbf9f5", `${route.url}: expected #fbf9f5, got ${metrics.surface}`);
        assert(metrics.radius === "2px", `${route.url}: expected 2px radius, got ${metrics.radius}`);
        assert(
          metrics.canonicalHref === route.canonical,
          `${route.url}: canonical mismatch (expected ${route.canonical}, got ${metrics.canonicalHref})`,
        );

        if (route.expectSchema) {
          assert(metrics.ldCount >= 1 && metrics.ldValidJson, `${route.url}: expected valid Schema.org JSON-LD`);
        } else {
          assert(metrics.ldCount === 0, `${route.url}: expected zero JSON-LD on not_found`);
          assert(
            metrics.robotsContent?.includes("noindex"),
            `${route.url}: expected noindex robots meta on not_found`,
          );
        }

        if (vp.width === 360) {
          for (const target of metrics.tapTargets) {
            assert(
              target.height >= 44 && target.width >= 44,
              `${route.url} (360px): tap target "${target.text}" below 44px (${target.width}x${target.height})`,
            );
          }
        }

        // Capture homepage screenshots for Tenant A at 1440px and 360px
        if (screenshotDir && route.url === "/tenant-a/") {
          await page.screenshot({
            path: path.join(screenshotDir, `custom-theme-${vp.width}.png`),
            fullPage: true,
          });
        }
      }
    }

    // Keyboard accessibility check on Tenant A homepage @ 1440px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/tenant-a/`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const firstTab = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = el ? getComputedStyle(el) : null;
      return {
        testId: el?.getAttribute("data-testid") ?? "",
        outlineStyle: cs?.outlineStyle ?? "none",
        outlineWidth: cs ? parseFloat(cs.outlineWidth) : 0,
      };
    });
    assert(firstTab.testId === "skip-to-content", `First Tab must hit skip-to-content, got ${JSON.stringify(firstTab)}`);
    assert(firstTab.outlineStyle !== "none" && firstTab.outlineWidth >= 2, "Skip link must have >= 2px focus ring");

    // Keyboard Escape closes mobile drawer on Tenant A @ 360px
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/tenant-a/`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="mobile-nav-toggle"]').click();
    await page.keyboard.press("Escape");
    const afterEscape = await page.evaluate(() => ({
      isOpen: document.querySelector('[data-testid="mobile-nav-details"]')?.hasAttribute("open") ?? false,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    assert(!afterEscape.isOpen, "Escape must close open mobile navigation on custom theme");
    assert(afterEscape.activeTestId === "mobile-nav-toggle", "Escape must restore focus to mobile-nav-toggle");

    // -----------------------------------------------------------------------
    // 3. Tenant B (Ungranted & Unknown Custom Theme) -> Safe Default Fallback @ 1440px & 360px
    // -----------------------------------------------------------------------
    for (const fallbackRoute of ["/tenant-b/", "/tenant-b/unknown/"]) {
      for (const vp of [
        { width: 1440, height: 900 },
        { width: 360, height: 800 },
      ]) {
        await page.setViewportSize(vp);
        await page.goto(`${server.baseUrl}${fallbackRoute}`, { waitUntil: "networkidle" });
        const fb = await page.evaluate(() => {
          const rootCs = getComputedStyle(document.documentElement);
          return {
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            primary: rootCs.getPropertyValue("--ps-brand-primary").trim(),
            surface: rootCs.getPropertyValue("--ps-surface").trim(),
            radius: rootCs.getPropertyValue("--ps-radius").trim(),
            hasCustomFrame: Boolean(document.querySelector("[data-ps-custom-theme]")),
            fallbackTheme: document.querySelector("[data-ps-fallback-theme]")?.getAttribute("data-ps-fallback-theme") ?? null,
            hasConsent: Boolean(document.querySelector("[data-ps-consent-root]")),
            canonicalHref: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
            ldCount: document.querySelectorAll('script[type="application/ld+json"]').length,
            bodyText: document.body.innerText,
          };
        });

        assert(!fb.overflow, `${fallbackRoute} (${vp.width}px): horizontal overflow detected`);
        assert(!fb.hasCustomFrame, `${fallbackRoute}: ungranted tenant MUST NOT render custom theme frame`);
        assert(fb.fallbackTheme === "compro", `${fallbackRoute}: expected compro fallback, got ${fb.fallbackTheme}`);
        assert(fb.primary === "#176b51", `${fallbackRoute}: expected compro primary #176b51, got ${fb.primary}`);
        assert(fb.surface === "#ffffff", `${fallbackRoute}: expected compro surface #ffffff, got ${fb.surface}`);
        assert(fb.radius === "8px", `${fallbackRoute}: expected compro radius 8px, got ${fb.radius}`);
        assert(fb.hasConsent, `${fallbackRoute}: fallback route must still mount shared <Consent>`);
        assert(
          fb.canonicalHref === "https://karya-mandiri.situsku.click/",
          `${fallbackRoute}: fallback canonical must belong to Tenant B, got ${fb.canonicalHref}`,
        );
        assert(fb.ldCount >= 1, `${fallbackRoute}: fallback route must emit Tenant B Schema.org JSON-LD`);
        assert(
          !fb.bodyText.includes("Studio Arsitektur Nusantara"),
          `${fallbackRoute}: Tenant B must never leak Tenant A content`,
        );

        if (screenshotDir && fallbackRoute === "/tenant-b/" && vp.width === 1440) {
          await page.screenshot({
            path: path.join(screenshotDir, "fallback-theme-1440.png"),
            fullPage: true,
          });
        }
      }
    }

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-018 E2E PASS: Explicit custom-sample-agency renders all 7 public routes inside shared SEO/Schema/Consent shell for entitled Tenant A, ungranted/unknown Tenant B falls back safely to compro with zero tenant leakage, 360px/1440px zero overflow, >=44px tap targets, No-JS & keyboard checks pass, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-018 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

await main();
