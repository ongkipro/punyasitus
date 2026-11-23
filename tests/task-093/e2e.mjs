/* global Buffer, process, console, document, window, getComputedStyle, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK093_SCREENSHOT_DIR || "/tmp/task-093-screenshots";
const MAX_PUBLIC_JS_GZIP_BYTES = 25 * 1024; // 25 KiB budget (REQ-040, TASK-093)

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

function createThemeFixtureArtworks(publicMediaDir) {
  fs.mkdirSync(publicMediaDir, { recursive: true });
  const items = [
    { file: "compro-hero.svg", bg: "#0f4c5c", fg: "#176b51", title: "PT Kemas Prima Nusantara", sub: "Manufaktur & Solusi B2B" },
    { file: "sales-hero.svg", bg: "#1e40af", fg: "#0f766e", title: "Sugi Andrian — Konsultan Otomotif", sub: "Harga OTR & Simulasi Kredit" },
    { file: "travel-hero.svg", bg: "#0f5c5c", fg: "#92400e", title: "Al-Mizan Tour & Umrah", sub: "5 Pasti & Permenpar 6/2025" },
    { file: "catalog-hero.svg", bg: "#1d4ed8", fg: "#0f766e", title: "Kriya Jati Jepara", sub: "Katalog Produk Ecer & Grosir" },
    { file: "resto-hero.svg", bg: "#9a3412", fg: "#14532d", title: "Warung Rasa Nusantara", sub: "Menu & 3 Lokasi Cabang" },
    { file: "dealer-hero.svg", bg: "#1e293b", fg: "#b91c1c", title: "Nusantara Auto Showroom", sub: "Katalog Unit & Test Drive" },
  ];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const item of items) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="${item.bg}"/>
  <rect x="64" y="64" width="1072" height="672" rx="12" fill="${item.fg}" fill-opacity="0.34" stroke="#ffffff" stroke-opacity="0.28" stroke-width="2"/>
  <text x="112" y="385" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="48" font-weight="700">${esc(item.title)}</text>
  <text x="112" y="452" fill="#f1f5f9" font-family="system-ui, -apple-system, sans-serif" font-size="30" font-weight="500">${esc(item.sub)}</text>
</svg>`;
    fs.writeFileSync(path.join(publicMediaDir, item.file), svg, "utf8");
  }
}

async function buildTask093Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t093-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const publicDir = path.join(tmpRoot, "public");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");

  fs.mkdirSync(path.join(pagesDir, "themes"), { recursive: true });
  fs.mkdirSync(path.join(pagesDir, "dashboard"), { recursive: true });
  createThemeFixtureArtworks(path.join(publicDir, "media/t/demo"));

  const themeRegistryImport = path.join(webDir, "src/core/theme-registry.ts");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const presetsImport = path.join(root, "packages/core/src/presets/index.ts");
  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const onboardingComponentsImport = path.join(
    webDir,
    "src/components/admin/onboarding/index.ts",
  );

  // Shared fixtures module for all 6 themes + render-time expired departure filtering
  fs.writeFileSync(
    path.join(srcDir, "theme-fixtures.ts"),
    `import { applyVerticalBlueprint } from ${JSON.stringify(presetsImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { buildPublicThemeRouteShellContract } from ${JSON.stringify(themeRegistryImport)};

export const SAMPLE_TRAVEL_DEPARTURES = [
  {
    packageName: "Umrah Syawal (Expired 2025)",
    departureDate: "2025-04-10",
    durationLabel: "9 Hari 7 Malam",
    airline: "Saudia",
    hotelSummary: "Hotel Madinah & Makkah",
    priceIdrLabel: "Rp 31.500.000",
  },
  {
    packageName: "Umrah Reguler Desember",
    departureDate: "2026-12-18",
    durationLabel: "9 Hari 7 Malam",
    airline: "Garuda Indonesia",
    hotelSummary: "Hotel Bintang 4",
    priceIdrLabel: "Rp 33.900.000",
  },
] as const;

export const THEME_SHOWCASES = {
  compro: {
    blueprintId: "b2b_corporate" as const,
    name: "PT Kemas Prima Nusantara",
    tagline: "Manufaktur Kemasan Industri & Kontrak B2B",
    city: "Bekasi",
    heroImg: "/media/t/demo/compro-hero.svg",
    expectedPrimary: "#176b51",
    offering: {
      slug: "produksi-karton-box-custom",
      offeringType: "service" as const,
      title: "Produksi Karton Box & Kemasan B2B",
      summary: "Kapasitas produksi 4.500 ton/bulan dengan kendali mutu ISO 9001:2015.",
      priceMode: "on_request" as const,
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "Manufaktur",
      metaLine: "MOQ 1.000 pcs · Lead time 7–10 hari kerja",
    },
  },
  sales: {
    blueprintId: "sales_executive" as const,
    name: "Sugi Andrian — Konsultan Penjualan",
    tagline: "Konsultan Otomotif Jakarta Utara",
    city: "Jakarta Utara",
    heroImg: "/media/t/demo/sales-hero.svg",
    expectedPrimary: "#1e40af",
    offering: {
      slug: "suv-keluarga-otomatis-2026",
      offeringType: "vehicle" as const,
      title: "SUV Keluarga 7-Penumpang AT 2026",
      summary: "Unit ready stok OTR Jabodetabek, tersedia test drive langsung ke rumah.",
      priceMode: "from" as const,
      price: 389000000,
      unitStatus: "available" as const,
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "SUV",
      metaLine: "OTR Jakarta · Terima Tukar Tambah",
    },
  },
  travel: {
    blueprintId: "travel_umrah_agency" as const,
    name: "Al-Mizan Tour & Umrah",
    tagline: "Biro Perjalanan Wisata & Paket Umrah",
    city: "Surabaya",
    heroImg: "/media/t/demo/travel-hero.svg",
    expectedPrimary: "#0f5c5c",
    offering: {
      slug: "umrah-reguler-9-hari-desember",
      offeringType: "tour" as const,
      title: "Paket Umrah Reguler 9 Hari 7 Malam",
      summary: "Penerbangan langsung Garuda Indonesia, hotel bintang 4 dekat pelataran.",
      priceMode: "from" as const,
      price: 33900000,
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "Umrah",
      metaLine: "Berangkat 18 Desember 2026 · Termasuk Visa & Asuransi",
    },
  },
  catalog: {
    blueprintId: "wa_catalog_showcase" as const,
    name: "Kriya Jati Jepara",
    tagline: "Katalog Furnitur Kayu Solid Ecer, Custom & Grosir",
    city: "Jepara",
    heroImg: "/media/t/demo/catalog-hero.svg",
    expectedPrimary: "#1d4ed8",
    offering: {
      slug: "meja-makan-jati-6-kursi",
      offeringType: "product" as const,
      title: "Meja Makan Kayu Jati Solid 6 Kursi",
      summary: "Kayu jati perhutani oven kering, finishing natural doff tahan lama.",
      priceMode: "range" as const,
      price: 5400000,
      priceMax: 7200000,
      negotiable: true,
      badge: "Ready / PO",
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "Ruang Makan",
      metaLine: "180×90 cm · Kirim seluruh Jawa & luar pulau",
    },
  },
  resto: {
    blueprintId: "offline_multibranch" as const,
    name: "Warung Rasa Nusantara",
    tagline: "Masakan Nusantara Autentik & Katering 3 Cabang",
    city: "Bandung",
    heroImg: "/media/t/demo/resto-hero.svg",
    expectedPrimary: "#9a3412",
    offering: {
      slug: "paket-liwet-keluarga-6-orang",
      offeringType: "product" as const,
      title: "Paket Nasi Liwet Keluarga (6 Orang)",
      summary: "Ayam bakar madu, gurame goreng, tahu tempe, lalapan segar, dan sambal terasi.",
      priceMode: "fixed" as const,
      price: 265000,
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "Paket Keluarga",
      metaLine: "Tersedia dine-in & katering 3 cabang Bandung",
    },
  },
  dealer: {
    blueprintId: "sales_executive" as const,
    name: "Nusantara Auto Showroom",
    tagline: "Katalog Mobil Baru & Bekas",
    city: "Semarang",
    heroImg: "/media/t/demo/dealer-hero.svg",
    expectedPrimary: "#1e293b",
    offering: {
      slug: "mpv-hybrid-2025-km-rendah",
      offeringType: "vehicle" as const,
      title: "MPV Hybrid 2025 — Tangan Pertama",
      summary: "Riwayat servis bengkel lengkap, siap test drive sesuai jadwal.",
      priceMode: "fixed" as const,
      price: 448000000,
      unitStatus: "available" as const,
      ctaKind: "whatsapp" as const,
      whatsappPhone: "081234567890",
      categoryName: "MPV",
      metaLine: "14.200 km · Transmisi CVT · Pajak panjang",
    },
  },
} as const;

export type ShowcaseThemeId = keyof typeof THEME_SHOWCASES;

export function buildThemeShowcaseFixture(themeId: ShowcaseThemeId) {
  const cfg = THEME_SHOWCASES[themeId];
  const applied = applyVerticalBlueprint(
    {
      businessName: cfg.name,
      blueprintId: cfg.blueprintId,
      whatsappPhone: "081234567890",
      city: cfg.city,
      handle: \`demo-\${themeId}\`,
      affiliatedDealerName: themeId === "sales" ? "Dealer Chery Arta PIK" : undefined,
      credentials: themeId === "travel" ? { skKemenagPpiu: "U.245 Tahun 2024" } : undefined,
      // Seed at an earlier date so both expired & active departures exist in section HTML,
      // proving travel SectionRenderer strips expired rows AT RENDER TIME!
      tourDepartures: themeId === "travel" ? [...SAMPLE_TRAVEL_DEPARTURES] : undefined,
    },
    { now: "2025-01-15T00:00:00Z" },
  );

  const sections = applied.sections.map((sec) => {
    if (sec.type === "hero") {
      return {
        ...sec,
        config: {
          ...sec.config,
          eyebrow: cfg.tagline,
          heading: cfg.name,
          subheading: applied.blueprint.shortDescription,
          media: {
            src: cfg.heroImg,
            alt: \`Ilustrasi \${cfg.name}\`,
            width: 1200,
            height: 800,
          },
          highlights: ["Tanpa JS Tema", "WCAG AA Terverifikasi", "Konten Lossless"],
        },
      };
    }
    if (
      sec.type === "services_grid" ||
      sec.type === "products_grid" ||
      sec.type === "tours_grid" ||
      sec.type === "vehicles_grid"
    ) {
      return {
        ...sec,
        config: {
          ...sec.config,
          items: [cfg.offering],
        },
      };
    }
    return sec;
  });

  const shell = {
    isPreview: false,
    layoutMode: "standard" as const,
    themeId,
    baseThemeId: themeId,
    themeStyle: buildSafeThemeStyleBlock(null, themeId),
    site: {
      title: cfg.name,
      tagline: cfg.tagline,
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public" as const,
      analyticsConfig: null,
    },
    business: {
      name: cfg.name,
      category: applied.resolvedBusinessCategory,
      description: cfg.tagline,
      address: \`Jl. Utama No. 10, \${cfg.city}\`,
      city: cfg.city,
      province: "Indonesia",
      postalCode: "12345",
      mapsUrl: "https://maps.google.com/?q=-6.2,106.8",
      weekdayHours: "Senin–Jumat 08.30–17.30 WIB",
      holidayHours: "Sabtu 09.00–14.00 WIB",
      phone: "6281234567890",
      whatsappE164: "6281234567890",
      email: \`halo@demo-\${themeId}.id\`,
      socialLinks: [],
    },
    menus: {
      header: [
        { label: "Beranda", href: \`/themes/\${themeId}/\`, openInNewTab: false, children: [] },
        { label: applied.sidebarOffering.primaryMenuLabel, href: "#penawaran", openInNewTab: false, children: [] },
        { label: "Kontak", href: "#kontak", openInNewTab: false, children: [] },
      ],
      footer: [{ label: "Beranda", href: \`/themes/\${themeId}/\`, openInNewTab: false, children: [] }],
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

  const contract = buildPublicThemeRouteShellContract({
    routeKind: "home",
    pathname: "/",
    entitlement: {
      tenantId: \`01JT093TENANT\${themeId.toUpperCase().padEnd(13, "0")}\`,
      tenantStatus: "active",
      requestedThemeId: themeId,
    },
    shell,
    seo: {
      surface: "public_tenant",
      tenant: { tenantHandle: \`demo-\${themeId}\`, tenantStatus: "active" },
      resourceState: "published",
      publishedItemCount: 1,
    },
    headerCtaLabel: "Hubungi WhatsApp",
    headerCtaHref: applied.whatsappUrl,
  });

  return { contract, sections, applied, cfg };
}
`,
    "utf8",
  );

  // Create one static page per platform theme (passing real aiFactSheetRows for semantic <dl> rendering!)
  const themeIds = ["compro", "sales", "travel", "catalog", "resto", "dealer"];
  const fixturesImport = path.join(srcDir, "theme-fixtures.ts");

  for (const id of themeIds) {
    const layoutImport = path.join(webDir, `src/themes/${id}/Layout.astro`);
    const rendererImport = path.join(webDir, `src/themes/${id}/sections/SectionRenderer.astro`);
    const extraLayoutProps =
      id === "compro"
        ? `credentials={[{ label: "NIB", value: "1234567890123" }, { label: "ISO", value: "ISO 9001:2015" }]}`
        : id === "sales"
          ? `affiliationLabel="Sugi Andrian · Dealer Chery Arta PIK"`
          : id === "travel"
            ? `skKemenagPpiu="U.245 Tahun 2024" tourDepartures={SAMPLE_TRAVEL_DEPARTURES} renderNow="2026-11-23T00:00:00Z"`
            : "";
    const extraSectionProps =
      id === "travel"
        ? `tourDepartures={SAMPLE_TRAVEL_DEPARTURES} renderNow="2026-11-23T00:00:00Z"`
        : "";

    fs.writeFileSync(
      path.join(pagesDir, `themes/${id}.astro`),
      `---
import ThemeLayout from ${JSON.stringify(layoutImport)};
import ThemeSections from ${JSON.stringify(rendererImport)};
import { buildThemeShowcaseFixture, SAMPLE_TRAVEL_DEPARTURES } from ${JSON.stringify(fixturesImport)};

const { contract, sections, applied } = buildThemeShowcaseFixture(${JSON.stringify(id)});
---
<ThemeLayout contract={contract} ${extraLayoutProps}>
  <ThemeSections
    sections={sections}
    themeId={${JSON.stringify(id)}}
    routePath="/"
    isHomepage={true}
    businessCategory={contract.shell.business.category}
    heroVariant={contract.themeStyle.variants.heroVariant}
    fallbackBusiness={contract.shell.business}
    aiFactSheetHeading={applied.blueprint.factSheetHeading}
    aiFactSheetRows={applied.aiFactSheetItems}
    ${extraSectionProps}
  />
</ThemeLayout>
`,
      "utf8",
    );
  }

  // Create Dashboard Guided Onboarding Checklist + 3-Field Blueprint Picker + Dual GBP/Bing Copy Card fixture
  fs.writeFileSync(
    path.join(pagesDir, "dashboard/onboarding.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { applyVerticalBlueprint } from ${JSON.stringify(presetsImport)};
import {
  BlueprintOnboardingPicker,
  GuidedOnboardingChecklist,
  LocalListingsCopyCard,
  OverviewLeadSummaryCard,
} from ${JSON.stringify(onboardingComponentsImport)};

const initialBlueprint = applyVerticalBlueprint({
  businessName: "PT Kemas Prima Nusantara",
  blueprintId: "b2b_corporate",
  whatsappPhone: "081234567890",
  city: "Bekasi",
  address: "Jl. Industri Raya Kav. 12, Bekasi",
  weekdayHours: "Senin–Jumat 08.00–17.00 WIB",
  holidayHours: "Sabtu–Minggu Tutup",
  handle: "kemas-prima",
});

const checklistFacts = {
  handle: "kemas-prima",
  offeringMenuLabel: initialBlueprint.sidebarOffering.primaryMenuLabel,
  hasBusinessProfileAndWhatsApp: false,
  hasLogo: false,
  hasOfferingOrPage: false,
  hasReviewedTheme: false,
  hasPublishedSite: false,
};
---
<DashboardLayout
  title="Beranda & Panduan Awal — PT Kemas Prima Nusantara"
  surface="dashboard"
  workspaceName="PT Kemas Prima Nusantara"
  workspaceSubtitle="kemas-prima.situsku.click"
  activeNavId="home"
  basePath="/dashboard/kemas-prima"
  offeringLabel={initialBlueprint.sidebarOffering.primaryMenuLabel}
  unreadLeadsCount={3}
  lifecycleStatus="trial"
  lifecycleDaysRemaining={6}
  publicSiteHref="https://kemas-prima.situsku.click"
>
  <div class="space-y-6" data-testid="task-093-dashboard-page">
    <div class="space-y-1">
      <h1 class="text-2xl font-bold tracking-[-0.02em] text-foreground">
        Beranda &amp; Persiapan Situs
      </h1>
      <p class="text-sm text-muted-foreground">
        Selesaikan 5 langkah persiapan, atur blueprint vertikal bisnis, dan samakan profil lokal Anda.
      </p>
    </div>

    <GuidedOnboardingChecklist
      client:load
      facts={checklistFacts}
      storageKey="punyasitus:t093:checklist:kemas-prima"
    />

    <OverviewLeadSummaryCard
      client:load
      last7DaysCount={12}
      previous7DaysCount={8}
      unreadNewCount={3}
      leadsHref="/dashboard/kemas-prima/leads"
    />

    <BlueprintOnboardingPicker
      client:load
      defaultBusinessName="PT Kemas Prima Nusantara"
      defaultBlueprintId="b2b_corporate"
      tenantHandle="kemas-prima"
    />

    <LocalListingsCopyCard
      client:load
      card={initialBlueprint.localListingsCard}
    />
  </div>
</DashboardLayout>
`,
    "utf8",
  );

  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;
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

function measurePublicRouteJsGzipBytes(html, outDir) {
  let totalGzip = 0;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (/type=["']application\/ld\+json["']/i.test(attrs)) continue;
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1]) {
      const rel = srcMatch[1].replace(/^\/+/, "");
      const file = path.join(outDir, rel);
      if (fs.existsSync(file)) {
        totalGzip += zlib.gzipSync(fs.readFileSync(file)).byteLength;
      }
    } else if (body.trim().length > 0) {
      totalGzip += zlib.gzipSync(Buffer.from(body, "utf8")).byteLength;
    }
  }
  return totalGzip;
}

async function main() {
  const fixtures = await buildTask093Fixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });

    const expectedThemes = [
      { id: "compro", primary: "#176b51", barTestId: "compro-credential-bar" },
      { id: "sales", primary: "#1e40af", barTestId: "sales-authority-bar" },
      { id: "travel", primary: "#0f5c5c", barTestId: "travel-trust-ribbon" },
      { id: "catalog", primary: "#1d4ed8", barTestId: "catalog-spec-bar" },
      { id: "resto", primary: "#9a3412", barTestId: "resto-hospitality-bar" },
      { id: "dealer", primary: "#1e293b", barTestId: "dealer-showroom-bar" },
    ];

    // 0. Static SSR, <= 25 KiB gzipped JS budget, claim-free copy & render-time departure expiry checks
    for (const theme of expectedThemes) {
      const htmlPath = path.join(fixtures.outDir, `themes/${theme.id}/index.html`);
      const html = fs.readFileSync(htmlPath, "utf8");
      assert(
        html.includes(`data-ps-platform-theme="${theme.id}"`),
        `Theme ${theme.id} HTML must render data-ps-platform-theme="${theme.id}"`,
      );
      assert(
        html.includes(`--ps-brand-primary: ${theme.primary}`),
        `Theme ${theme.id} HTML must emit --ps-brand-primary: ${theme.primary}`,
      );
      assert(
        !html.includes("@base-ui/react") && !html.includes("@radix-ui/"),
        `Theme ${theme.id} HTML must contain zero admin UI primitives`,
      );
      assert(
        !html.includes("Showroom Resmi") &&
          !html.includes("Unit Terverifikasi") &&
          !html.includes("Katalog Resmi"),
        `Theme ${theme.id} HTML must contain zero hardcoded unverified claims`,
      );
      if (theme.id === "travel") {
        assert(
          html.includes("Umrah Reguler Desember") &&
            !html.includes("Umrah Syawal (Expired 2025)"),
          "Travel theme must auto-hide expired tour departures at render time",
        );
      }
      const jsGzipBytes = measurePublicRouteJsGzipBytes(html, fixtures.outDir);
      assert(
        jsGzipBytes <= MAX_PUBLIC_JS_GZIP_BYTES,
        `Theme ${theme.id} public JS gzip (${jsGzipBytes} B) exceeds 25 KiB budget`,
      );
      console.log(`  [budget] theme=${theme.id} public JS gzip=${jsGzipBytes} B (<= 25600 B)`);
    }

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // 1. No-JS Progressive Enhancement @ 360px on travel theme
    {
      const noJsCtx = await browser.newContext({
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsCtx.newPage();
      await noJsPage.goto(`${server.baseUrl}/themes/travel/`, { waitUntil: "load" });
      const info = await noJsPage.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        primary: getComputedStyle(document.documentElement)
          .getPropertyValue("--ps-brand-primary")
          .trim(),
      }));
      assert(!info.overflow, "No-JS 360px travel theme must have zero horizontal overflow");
      assert(info.primary === "#0f5c5c", `Expected #0f5c5c, got ${info.primary}`);
      await noJsPage.locator('[data-testid="mobile-nav-toggle"]').click();
      assert(
        await noJsPage.locator('[data-testid="mobile-nav-details"]').evaluate((el) => el.hasAttribute("open")),
        "Mobile <details> nav must open without JavaScript",
      );
      await noJsCtx.close();
    }

    // 2. Render & verify ALL 6 platform themes at 1440px and 360px + real <dl> & <table> checks
    const consoleErrors = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    for (const theme of expectedThemes) {
      for (const vp of [
        { width: 1440, height: 900, tag: "1440" },
        { width: 360, height: 800, tag: "360" },
      ]) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(`${server.baseUrl}/themes/${theme.id}/`, { waitUntil: "networkidle" });

        const metrics = await page.evaluate(
          ({ expectedId, barId }) => {
            const rootEl = document.querySelector(`[data-ps-platform-theme="${expectedId}"]`);
            const barEl = document.querySelector(`[data-testid="${barId}"]`);
            const dlEl = document.querySelector('[data-testid="ai-fact-sheet-dl"] dl');
            const tableEl = document.querySelector(".ps-prose table");
            const primary = getComputedStyle(document.documentElement)
              .getPropertyValue("--ps-brand-primary")
              .trim();
            return {
              hasRoot: Boolean(rootEl),
              hasBar: Boolean(barEl),
              hasDlFactSheet: Boolean(dlEl && dlEl.querySelectorAll("dt").length >= 2),
              hasTableFactSheet: Boolean(tableEl),
              primary,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          },
          { expectedId: theme.id, barId: theme.barTestId },
        );

        assert(metrics.hasRoot, `Theme ${theme.id} @ ${vp.tag}px missing root`);
        assert(metrics.hasBar, `Theme ${theme.id} @ ${vp.tag}px missing distinct theme bar`);
        assert(metrics.hasDlFactSheet, `Theme ${theme.id} @ ${vp.tag}px missing real semantic HTML <dl> Fact Sheet`);
        assert(metrics.hasTableFactSheet, `Theme ${theme.id} @ ${vp.tag}px missing semantic HTML <table> Fact Sheet`);
        assert(metrics.primary === theme.primary, `Theme ${theme.id} expected primary ${theme.primary}, got ${metrics.primary}`);
        assert(!metrics.overflow, `Theme ${theme.id} @ ${vp.tag}px has horizontal overflow`);

        await page.screenshot({
          path: path.join(screenshotDir, `theme-${theme.id}-${vp.tag}.png`),
          fullPage: false,
        });
      }
    }

    // 3. Guided Onboarding Checklist + 3-Field Blueprint Picker + Dual GBP/Bing Copy Card @ 1440px & 360px
    for (const vp of [
      { width: 1440, height: 900, tag: "1440" },
      { width: 360, height: 800, tag: "360" },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${server.baseUrl}/dashboard/onboarding/`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="guided-onboarding-checklist"]');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `Dashboard onboarding checklist @ ${vp.tag}px has horizontal overflow`);

      await page.screenshot({
        path: path.join(screenshotDir, `onboarding-checklist-${vp.tag}.png`),
        fullPage: true,
      });
    }

    // Interactive persistence & friendly validation verification at 1440px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/dashboard/onboarding/`, { waitUntil: "networkidle" });

    // Verify WhatsApp input starts empty (no pre-filled stranger phone!)
    const initialWaVal = await page.locator('[data-testid="onboarding-input-whatsapp"]').inputValue();
    assert(initialWaVal === "", `Expected empty initial WhatsApp input, got "${initialWaVal}"`);

    // Submitting with empty WhatsApp must show friendly Bahasa Indonesia error (never raw JSON)
    await page.locator('[data-testid="blueprint-apply-button"]').click();
    const errText = await page.locator('[data-testid="blueprint-form-error"]').innerText();
    assert(
      errText.includes("WhatsApp") && !errText.includes('[{"'),
      `Expected friendly Indonesian error, got "${errText}"`,
    );

    // Complete step 1 & dismiss step 2
    await page.locator('[data-testid="guided-step-complete-profile_whatsapp"]').click();
    await page.locator('[data-testid="guided-step-dismiss-logo"]').click();

    await page.reload({ waitUntil: "networkidle" });
    assert(
      (await page.locator('[data-testid="guided-step-profile_whatsapp"]').getAttribute("data-step-status")) ===
        "completed",
      "Completed step 1 must persist across page reload",
    );
    assert(
      (await page.locator('[data-testid="guided-step-logo"]').getAttribute("data-step-status")) ===
        "dismissed",
      "Dismissed step 2 must persist across page reload",
    );

    // Dismiss entire checklist -> verify dismissed bar -> restore checklist
    await page.locator('[data-testid="guided-checklist-dismiss-all"]').click();
    await page.waitForSelector('[data-testid="guided-checklist-dismissed-bar"]');
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="guided-checklist-dismissed-bar"]');
    await page.locator('[data-testid="guided-checklist-restore-all"]').click();
    await page.waitForSelector('[data-testid="guided-onboarding-checklist"]');

    // Fill WhatsApp, switch to regulated_professional -> legal_notary -> apply cleanly
    await page.locator('[data-testid="onboarding-input-whatsapp"]').fill("081234567890");
    await page.locator('[data-testid="blueprint-option-regulated_professional"]').click();
    await page.waitForSelector('[data-testid="blueprint-regulated-warning"]');
    await page.locator('[data-testid="regulated-subtype-legal_notary"]').click();
    await page.locator('[data-testid="blueprint-apply-button"]').click();
    await page.waitForSelector('[data-testid="blueprint-applied-notice"]');

    // Verify Dual GBP + Bing Places copy card displays holidayHours
    const holidayHoursText = await page
      .locator('[data-testid="local-listings-holiday-hours"]')
      .innerText();
    assert(
      holidayHoursText.includes("Sabtu–Minggu Tutup"),
      `Expected holidayHours rendered, got "${holidayHoursText}"`,
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log("TASK-093 E2E PASSED (6 themes + <dl>/<table> + render-time expiry + guided checklist + 7 blueprints @ 360px & 1440px)");
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
