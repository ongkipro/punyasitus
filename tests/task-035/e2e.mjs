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

const screenshotDir = process.env.TASK035_SCREENSHOT_DIR || "/tmp/qa-task-035";

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

const FROM_SERVICE_FIXTURE = {
  pricingMode: "from",
  basePriceIdr: 2500000,
  serviceArea: "Jabodetabek & Seluruh Indonesia",
  turnaround: "7–14 hari kerja",
  serviceMode: "hybrid",
  pricingTiers: [
    {
      name: "Paket Pendampingan UMKM",
      pricingMode: "from",
      priceIdr: 2500000,
      billingUnit: "per proyek",
      turnaroundLabel: "7 hari kerja",
      summary: "Review laporan keuangan dan penyusunan SPT Tahunan Badan.",
      deliverables: [
        "Review laporan keuangan 12 bulan",
        "Penyusunan rekonsiliasi fiskal",
        "Pendampingan pelaporan SPT Tahunan",
      ],
    },
    {
      name: "Paket Audit Menengah",
      pricingMode: "fixed",
      priceIdr: 5000000,
      billingUnit: "per proyek",
      turnaroundLabel: "14 hari kerja",
      summary: "Audit menyeluruh PPh & PPN beserta mitigasi risiko kepatuhan.",
      highlighted: true,
      deliverables: [
        "Audit kepatuhan PPh & PPN menyeluruh",
        "Laporan manajemen & rekomendasi efisiensi",
        "Sesi presentasi bersama direksi",
      ],
    },
    {
      name: "Paket Korporasi Kustom",
      pricingMode: "inquiry",
      billingUnit: "sesuai ruang lingkup",
      summary: "Pendampingan grup usaha multi-entitas dan restrukturisasi pajak.",
      deliverables: [
        "Tim konsultan pajak dedikasi",
        "Pendampingan pemeriksaan pajak resmi",
      ],
    },
  ],
  processSteps: [
    {
      stepNumber: 1,
      title: "Konsultasi Awal & Pemetaan Dokumen",
      summary: "Diskusi profil usaha, kendala perpajakan, dan ruang lingkup laporan.",
      estimatedDuration: "1 hari kerja",
    },
    {
      stepNumber: 2,
      title: "Proposal & Transparansi Biaya",
      summary: "Pengiriman rincian biaya tertulis, daftar deliverables, dan jadwal kerja.",
      estimatedDuration: "1–2 hari kerja",
    },
    {
      stepNumber: 3,
      title: "Eksekusi Audit & Review Berkala",
      summary: "Pemeriksaan data keuangan serta koordinasi temuan secara rutin.",
      estimatedDuration: "5–10 hari kerja",
    },
    {
      stepNumber: 4,
      title: "Serah Terima Laporan & Presentasi",
      summary: "Penyerahan laporan final lengkap disertai rekomendasi tindak lanjut.",
      estimatedDuration: "1 hari kerja",
    },
  ],
  specialistCta: {
    specialistName: "Rina Kartika, BKP",
    specialistRole: "Konsultan Pajak Senior",
    whatsappNumber: "6281298765432",
    ctaLabel: "Konsultasi dengan Bu Rina via WhatsApp",
    prefilledMessage: "Halo Bu Rina, saya ingin menjadwalkan konsultasi audit pajak perusahaan.",
  },
};

const INQUIRY_SERVICE_FIXTURE = {
  pricingMode: "inquiry",
  serviceArea: "Seluruh Indonesia",
  serviceMode: "remote",
  pricingTiers: [
    {
      name: "Retainer Hukum Korporasi",
      pricingMode: "inquiry",
      billingUnit: "sesuai ruang lingkup",
      summary: "Pendampingan hukum strategis bulanan untuk transaksi dan tata kelola perusahaan.",
      deliverables: [
        "Review & penyusunan kontrak bisnis",
        "Opini hukum tertulis bagi manajemen",
        "Pendampingan rapat pemegang saham",
      ],
    },
  ],
  processSteps: [
    {
      stepNumber: 1,
      title: "Penjajakan Kebutuhan & NDA",
      summary: "Penandatanganan perjanjian kerahasiaan dan diskusi awal ruang lingkup hukum.",
      estimatedDuration: "1 hari kerja",
    },
    {
      stepNumber: 2,
      title: "Penawaran Khusus Tertulis",
      summary: "Penyampaian ruang lingkup pendampingan dan skema kerja sama yang transparan.",
      estimatedDuration: "2 hari kerja",
    },
    {
      stepNumber: 3,
      title: "Pelaksanaan Pendampingan",
      summary: "Eksekusi review kontrak dan konsultasi rutin bersama konsultan hukum.",
      estimatedDuration: "Berkelanjutan",
    },
  ],
};

const DASHBOARD_SERVICES = [
  {
    id: 21,
    slug: "jasa-audit-pendampingan-pajak",
    publicPath: "/layanan/jasa-audit-pendampingan-pajak",
    title: "Jasa Audit & Pendampingan Pajak Perusahaan",
    summary: "Audit kepatuhan pajak transparan untuk UMKM hingga perusahaan menengah.",
    priceMode: "from",
    price: 2500000,
    priceMax: null,
    status: "published",
    version: 2,
    attributes: FROM_SERVICE_FIXTURE,
  },
  {
    id: 22,
    slug: "retainer-hukum-korporasi",
    publicPath: "/layanan/retainer-hukum-korporasi",
    title: "Retainer Hukum Korporasi",
    summary: "Pendampingan hukum strategis tanpa harga numerik di halaman publik.",
    priceMode: "on_request",
    price: null,
    priceMax: null,
    status: "draft",
    version: 1,
    attributes: INQUIRY_SERVICE_FIXTURE,
  },
];

async function buildTask035Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t035-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const serviceClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/catalog/services/_ServiceCatalogManagerClient.tsx",
  );
  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const sectionServiceImport = path.join(
    webDir,
    "src/themes/default/sections/SectionServiceProcess.astro",
  );
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const publicPagesCssImport = path.join(webDir, "src/pages/layanan/_public-pages.css");

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

  const sharedShell = (pageTitle) => `{
    isPreview: false,
    layoutMode: "standard",
    themeId: "corporate",
    baseThemeId: "corporate",
    themeStyle: { tokens: {}, variants: {} },
    site: {
      title: "Kantor Konsultan Sejahtera",
      tagline: "Mitra Konsultasi Pajak & Hukum Terpercaya",
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public",
      analyticsConfig: null,
    },
    business: {
      name: "Kantor Konsultan Sejahtera",
      category: "AccountingService",
      description: "Konsultasi pajak, audit, dan tata kelola perusahaan.",
      address: "Jl. Jenderal Sudirman Kav. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12930",
      mapsUrl: null,
      weekdayHours: "Senin–Jumat 08:30–17:30 WIB",
      holidayHours: null,
      phone: "+62215551234",
      whatsappE164: "+6281122334455",
      email: "halo@konsultansejahtera.id",
      socialLinks: [],
    },
    menus: {
      header: [
        { label: "Beranda", href: "/", openInNewTab: false, children: [] },
        { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
      ],
      footer: [],
      mobile: [],
    },
    page: { title: ${JSON.stringify(pageTitle)} },
    revisions: {
      siteSettingsVersion: 1,
      businessProfileVersion: 1,
      themeConfigVersion: 1,
      pageVersion: 1,
    },
  }`;

  // 1. Public `/layanan/jasa-audit-pendampingan-pajak` (from + fixed + inquiry tiers + specialist WA)
  fs.writeFileSync(
    path.join(pagesDir, "public-service.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { resolveServiceHeadlinePricing } from "@punyasitus/core/catalog/service";
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionServiceProcess from ${JSON.stringify(sectionServiceImport)};

const service = ${JSON.stringify(FROM_SERVICE_FIXTURE)};
const pageTitle = "Jasa Audit & Pendampingan Pajak Perusahaan";
const canonicalUrl = "https://konsultansejahtera.id/layanan/jasa-audit-pendampingan-pajak";
const headline = resolveServiceHeadlinePricing(service);

const schemaResult = generateSchemaGraph({
  seo: {
    surface: "public_tenant",
    routeKind: "offering",
    pathname: "/layanan/jasa-audit-pendampingan-pajak",
    tenant: {
      tenantHandle: "konsultan-sejahtera",
      tenantStatus: "active",
      primaryHost: "konsultansejahtera.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["konsultansejahtera.id", "konsultan-sejahtera.situsku.click"],
    },
    siteVisibility: "public",
    resourceState: "published",
  },
  siteName: "Kantor Konsultan Sejahtera",
  business: {
    businessName: "Kantor Konsultan Sejahtera",
    businessCategory: "AccountingService",
    address: "Jl. Jenderal Sudirman Kav. 45",
    city: "Jakarta Selatan",
    phone: "+62215551234",
  },
  pageTitle,
  pageDescription: "Audit kepatuhan pajak transparan dengan pilihan paket mulai dari Rp 2.500.000.",
  offering: {
    offeringType: "service",
    title: pageTitle,
    summary: "Audit kepatuhan pajak transparan dengan pilihan paket mulai dari Rp 2.500.000.",
    priceMode: headline.catalogPriceMode,
    price: headline.priceIdr,
    ctaMode: "whatsapp",
    categoryName: "Konsultasi Pajak",
    attributes: service,
  },
});

const shell = ${sharedShell("Jasa Audit & Pendampingan Pajak Perusahaan")};
---
<PublicLayout shell={shell} pageTitle={pageTitle} showConsent={false}>
  <Fragment slot="head">
    {schemaResult.jsonLd && (
      <script type="application/ld+json" set:html={schemaResult.jsonLd} />
    )}
  </Fragment>

  <section class="ps-route-hero">
    <div class="ps-container ps-route-hero-inner">
      <div class="ps-offering-badges">
        <span class="ps-badge">Layanan Profesional</span>
        <span class="ps-badge ps-badge--brand">Konsultasi Pajak</span>
      </div>
      <h1 class="ps-route-title">{pageTitle}</h1>
      <p class="ps-route-lead">
        Transparansi biaya tanpa biaya tersembunyi, alur kerja terstruktur 4 tahap, dan konsultasi
        langsung bersama konsultan pajak bersertifikat.
      </p>
    </div>
  </section>

  <article class="ps-detail-shell" data-testid="offering-detail-service">
    <div class="ps-container ps-detail-grid">
      <div class="ps-detail-main">
        <SectionServiceProcess
          id="service-consultation"
          service={service}
          serviceTitle={pageTitle}
          fallbackPriceMode="from"
          fallbackPrice={2500000}
          fallbackWhatsAppPhone="+6281122334455"
          canonicalUrl={canonicalUrl}
          embedded={true}
        />
      </div>

      <aside class="ps-detail-sidebar" aria-label="Ringkasan layanan">
        <div>
          <p class="ps-eyebrow">Layanan Profesional</p>
          <p class="ps-detail-price" data-testid="offering-detail-price">{headline.formattedLabel}</p>
          <p class="ps-detail-note">Spesialis: {service.specialistCta.specialistName} ({service.specialistCta.specialistRole})</p>
        </div>
        <div class="ps-detail-cta-stack">
          <a
            href="#service-consultation-specialist-cta"
            class="ps-btn ps-btn--primary"
            data-testid="sidebar-specialist-jump-cta"
          >
            Lihat Kontak Spesialis
          </a>
        </div>
      </aside>
    </div>
  </article>
</PublicLayout>
`,
  );

  // 2. Public inquiry-only `/layanan/retainer-hukum-korporasi` (ZERO price, ZERO Offer JSON-LD)
  fs.writeFileSync(
    path.join(pagesDir, "public-service-inquiry.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { buildSpecialistWhatsAppHref, resolveServiceHeadlinePricing } from "@punyasitus/core/catalog/service";
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionServiceProcess from ${JSON.stringify(sectionServiceImport)};

const service = ${JSON.stringify(INQUIRY_SERVICE_FIXTURE)};
const pageTitle = "Retainer Hukum Korporasi";
const canonicalUrl = "https://konsultansejahtera.id/layanan/retainer-hukum-korporasi";
const headline = resolveServiceHeadlinePricing(service);
const fallbackHref = buildSpecialistWhatsAppHref({
  fallbackPhone: "+6281122334455",
  serviceTitle: pageTitle,
  canonicalUrl,
});

const schemaResult = generateSchemaGraph({
  seo: {
    surface: "public_tenant",
    routeKind: "offering",
    pathname: "/layanan/retainer-hukum-korporasi",
    tenant: {
      tenantHandle: "konsultan-sejahtera",
      tenantStatus: "active",
      primaryHost: "konsultansejahtera.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["konsultansejahtera.id", "konsultan-sejahtera.situsku.click"],
    },
    siteVisibility: "public",
    resourceState: "published",
  },
  siteName: "Kantor Konsultan Sejahtera",
  business: {
    businessName: "Kantor Konsultan Sejahtera",
    businessCategory: "LegalService",
    address: "Jl. Jenderal Sudirman Kav. 45",
    city: "Jakarta Selatan",
    phone: "+62215551234",
  },
  pageTitle,
  pageDescription: "Pendampingan hukum strategis bulanan sesuai ruang lingkup perusahaan.",
  offering: {
    offeringType: "service",
    title: pageTitle,
    summary: "Pendampingan hukum strategis bulanan sesuai ruang lingkup perusahaan.",
    priceMode: headline.catalogPriceMode,
    price: headline.priceIdr,
    ctaMode: "whatsapp",
    categoryName: "Konsultasi Hukum",
    attributes: service,
  },
});

const shell = ${sharedShell("Retainer Hukum Korporasi")};
---
<PublicLayout shell={shell} pageTitle={pageTitle} showConsent={false}>
  <Fragment slot="head">
    {schemaResult.jsonLd && (
      <script type="application/ld+json" set:html={schemaResult.jsonLd} />
    )}
  </Fragment>

  <section class="ps-route-hero">
    <div class="ps-container ps-route-hero-inner">
      <div class="ps-offering-badges">
        <span class="ps-badge">Layanan Profesional</span>
        <span class="ps-badge ps-badge--brand">Konsultasi / Penawaran Khusus</span>
      </div>
      <h1 class="ps-route-title">{pageTitle}</h1>
      <p class="ps-route-lead">
        Pendampingan hukum korporasi yang disesuaikan dengan kebutuhan dan kompleksitas transaksi
        perusahaan Anda.
      </p>
    </div>
  </section>

  <article class="ps-detail-shell" data-testid="offering-detail-service-inquiry">
    <div class="ps-container ps-detail-grid">
      <div class="ps-detail-main">
        <SectionServiceProcess
          id="service-inquiry"
          service={service}
          serviceTitle={pageTitle}
          fallbackPriceMode="on_request"
          fallbackPrice={null}
          fallbackWhatsAppPhone="+6281122334455"
          canonicalUrl={canonicalUrl}
          embedded={true}
        />
      </div>

      <aside class="ps-detail-sidebar" aria-label="Ringkasan layanan">
        <div>
          <p class="ps-eyebrow">Layanan Profesional</p>
          <p class="ps-detail-price" data-testid="offering-detail-price">{headline.formattedLabel}</p>
          <p class="ps-detail-note">Penawaran disusun setelah diskusi ruang lingkup awal.</p>
        </div>
        <div class="ps-detail-cta-stack">
          <a
            href={fallbackHref}
            class="ps-btn ps-btn--whatsapp"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="sidebar-fallback-wa-cta"
          >
            Konsultasi via WhatsApp
          </a>
        </div>
      </aside>
    </div>
  </article>
</PublicLayout>
`,
  );

  // 3. Dashboard Services Editor fixture
  fs.writeFileSync(
    path.join(pagesDir, "dashboard-services.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ServiceCatalogManagerClient } from ${JSON.stringify(serviceClientImport)};
const initialServices = ${JSON.stringify(DASHBOARD_SERVICES)};
---
<DashboardLayout
  title="Layanan Profesional & Konsultasi — Kantor Konsultan Sejahtera"
  surface="dashboard"
  workspaceName="Kantor Konsultan Sejahtera"
  workspaceSubtitle="konsultansejahtera.id"
  activeNavId="offering"
  basePath="/dashboard/konsultan-sejahtera"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://konsultansejahtera.id"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <ServiceCatalogManagerClient
    client:load
    tenantId="01JTESTSVCTENANT00000001"
    handle="konsultan-sejahtera"
    basePath="/dashboard/konsultan-sejahtera"
    permissions={${ownerPermissions}}
    canWriteServices={true}
    canPublishServices={true}
    fallbackTenantWhatsApp="+6281122334455"
    initialServices={initialServices}
  />
</DashboardLayout>
`,
  );

  const astroMod = await import(astroEntryUrl);
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;
  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;

  await astroMod.build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
      ssr: {
        noExternal: ["@base-ui/react", "lucide-react"],
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return { tmpRoot, outDir };
}

function startStaticServer(distDir) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
  };
  const server = http.createServer((req, res) => {
    const rawPath = (req.url || "/").split("?")[0];
    let filePath = path.join(distDir, rawPath === "/" ? "index.html" : rawPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      const htmlPath = `${filePath}.html`;
      if (fs.existsSync(htmlPath)) filePath = htmlPath;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildTask035Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    // ------------------------------------------------------------------
    // 1. Public Service Detail (NO-JS verified + 360px & 1440px + JSON-LD)
    // ------------------------------------------------------------------
    {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        timezoneId: "Asia/Jakarta",
        javaScriptEnabled: false,
      });
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/public-service/`, { waitUntil: "networkidle" });

      const bodyText = await page.locator("body").innerText();
      assert(bodyText.includes("Mulai dari Rp 2.500.000"), "Missing 'Mulai dari Rp 2.500.000' pricing");
      assert(bodyText.includes("Rp 5.000.000"), "Missing fixed tier 'Rp 5.000.000'");
      assert(bodyText.includes("Hubungi untuk Penawaran"), "Missing inquiry tier label");
      assert(bodyText.includes("Cara Kerja"), "Missing 'Cara Kerja' heading");
      assert(bodyText.includes("Rina Kartika, BKP"), "Missing specialist name");
      assert(bodyText.includes("Konsultan Pajak Senior"), "Missing specialist role");
      assert(!/keranjang|add to cart|checkout/i.test(bodyText), "Forbidden cart/checkout copy detected!");

      const stepCount = await page.locator('[data-testid="service-process-steps"] > li').count();
      assert(stepCount === 4, `Expected 4 ordered Cara Kerja steps, got ${stepCount}`);

      const specialistCtaCount = await page.locator('[data-testid="service-specialist-whatsapp-cta"]').count();
      assert(specialistCtaCount === 1, `Expected exactly ONE specialist WA CTA in section, got ${specialistCtaCount}`);
      const totalSpecialistWaLinks = await page.locator('a[href^="https://wa.me/6281298765432"]').count();
      assert(totalSpecialistWaLinks === 1, `Expected exactly ONE specialist WA link across entire page, got ${totalSpecialistWaLinks}`);
      const waHref = await page.locator('[data-testid="service-specialist-whatsapp-cta"]').getAttribute("href");
      assert(waHref && waHref.startsWith("https://wa.me/6281298765432?text="), `Invalid specialist WA CTA: ${waHref}`);

      // Verify JSON-LD matches visible facts
      const jsonLdRaw = await page.locator('script[type="application/ld+json"]').first().textContent();
      assert(jsonLdRaw, "Missing JSON-LD script tag");
      const parsedLd = JSON.parse(jsonLdRaw);
      const serviceNode = parsedLd["@graph"].find((n) => n["@type"] === "Service");
      assert(serviceNode, "Missing Service node in JSON-LD");
      assert(serviceNode.offers?.["@type"] === "AggregateOffer", "Expected AggregateOffer for 'from' service");
      assert(serviceNode.offers?.priceCurrency === "IDR", "Expected IDR currency");
      assert(serviceNode.offers?.lowPrice === 2500000, `Expected lowPrice 2500000, got ${serviceNode.offers?.lowPrice}`);
      assert(!("availability" in serviceNode.offers), "Invented availability on Service offer!");
      assert(!("aggregateRating" in serviceNode) && !("review" in serviceNode), "Invented rating/review!");

      const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!overflow1440, "Public service detail overflows horizontally at 1440px");
      await page.screenshot({
        path: path.join(screenshotDir, "public-service-detail-1440.png"),
        fullPage: true,
      });

      await page.setViewportSize({ width: 360, height: 800 });
      const overflow360 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!overflow360, "Public service detail overflows horizontally at 360px");
      await page.screenshot({
        path: path.join(screenshotDir, "public-service-detail-360.png"),
        fullPage: true,
      });

      await ctx.close();
    }

    // ------------------------------------------------------------------
    // 2. Public Inquiry-Only Service Detail (ZERO price, ZERO Offer JSON-LD)
    // ------------------------------------------------------------------
    {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        timezoneId: "Asia/Jakarta",
        javaScriptEnabled: false,
      });
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/public-service-inquiry/`, { waitUntil: "networkidle" });

      const bodyText = await page.locator("body").innerText();
      assert(bodyText.includes("Konsultasi / Penawaran Khusus"), "Missing inquiry mode badge");
      assert(bodyText.includes("Hubungi untuk Penawaran"), "Missing inquiry price label");
      assert(!/Rp\s*\d/.test(bodyText), "Inquiry-only service MUST NOT render numeric Rp price!");
      assert(!/keranjang|add to cart|checkout/i.test(bodyText), "Forbidden cart UI on inquiry service!");

      const fallbackCtaHref = await page
        .locator('[data-testid="service-fallback-whatsapp-cta"]')
        .getAttribute("href");
      assert(
        fallbackCtaHref && fallbackCtaHref.startsWith("https://wa.me/6281122334455?text="),
        `Expected fallback tenant WA CTA, got ${fallbackCtaHref}`,
      );

      const jsonLdRaw = await page.locator('script[type="application/ld+json"]').first().textContent();
      assert(jsonLdRaw, "Missing JSON-LD on inquiry service");
      const parsedLd = JSON.parse(jsonLdRaw);
      const serviceNode = parsedLd["@graph"].find((n) => n["@type"] === "Service");
      assert(serviceNode, "Missing Service node on inquiry page");
      assert(!("offers" in serviceNode), "Inquiry-only service MUST NOT emit offers!");
      assert(!jsonLdRaw.includes('"Offer"') && !jsonLdRaw.includes('"AggregateOffer"'), "Invented Offer in inquiry JSON-LD!");

      const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!overflow1440, "Public inquiry service overflows horizontally at 1440px");
      await page.screenshot({
        path: path.join(screenshotDir, "public-service-inquiry-1440.png"),
        fullPage: true,
      });

      await ctx.close();
    }

    // ------------------------------------------------------------------
    // 3. Dashboard Services Editor (1440px & 360px + interactive switching)
    // ------------------------------------------------------------------
    {
      const adminCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        timezoneId: "Asia/Jakarta",
      });
      const adminPage = await adminCtx.newPage();
      const pageErrors = [];
      adminPage.on("pageerror", (err) => pageErrors.push(err.message));

      await adminPage.goto(`${baseUrl}/dashboard-services/`, { waitUntil: "networkidle" });
      await adminPage.locator('[data-testid="services-manager-root"]').waitFor({ state: "visible" });

      const previewPrice = await adminPage
        .locator('[data-testid="service-preview-headline-price"]')
        .innerText();
      assert(previewPrice === "Mulai dari Rp 2.500.000", `Unexpected dashboard preview price: ${previewPrice}`);

      const dashOverflow1440 = await adminPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!dashOverflow1440, "Dashboard services editor overflows horizontally at 1440px");
      await adminPage.screenshot({
        path: path.join(screenshotDir, "dashboard-services-1440.png"),
        fullPage: true,
      });

      // Switch to inquiry service pill -> verify inquiry notice & zero price
      await adminPage.locator('[data-testid="service-item-pill-22"]').click();
      await adminPage.locator('[data-testid="service-inquiry-mode-notice"]').waitFor({ state: "visible" });
      const inquiryPreview = await adminPage
        .locator('[data-testid="service-preview-headline-price"]')
        .innerText();
      assert(inquiryPreview === "Hubungi untuk Penawaran", `Unexpected inquiry preview: ${inquiryPreview}`);

      // Switch back to main service & capture 360px mobile screenshot
      await adminPage.locator('[data-testid="service-item-pill-21"]').click();
      await adminPage.setViewportSize({ width: 360, height: 800 });
      const dashOverflow360 = await adminPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert(!dashOverflow360, "Dashboard services editor overflows horizontally at 360px");
      await adminPage.screenshot({
        path: path.join(screenshotDir, "dashboard-services-360.png"),
        fullPage: true,
      });

      assert(pageErrors.length === 0, `Unexpected dashboard page errors: ${pageErrors.join("; ")}`);
      await adminCtx.close();
    }

    console.log("TASK-035 E2E PASS: public service (pricing tiers + Cara Kerja + specialist WA + JSON-LD), inquiry-only (zero price/Offer), & dashboard services editor verified at 360px & 1440px.");
    console.log(`Screenshots saved to ${screenshotDir}`);
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
