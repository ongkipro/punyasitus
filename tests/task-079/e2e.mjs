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

const screenshotDir = process.env.TASK079_SCREENSHOT_DIR || "/tmp/qa-task-079";

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

const AVAILABLE_USED_CAR = {
  vehicleCategory: "car",
  brand: "Toyota",
  model: "Kijang Innova Zenix",
  variant: "Q Hybrid Modellista",
  year: 2024,
  condition: "used",
  mileageKm: 18500,
  transmission: "cvt",
  fuel: "hybrid",
  bodyType: "mpv",
  color: "Putih Mutiara",
  seats: 7,
  engineCc: 1987,
  location: "Jakarta Selatan",
  plateRegion: "B (Jakarta)",
  stnkTaxExpiryDate: "2027-08-15",
  ownershipCount: 1,
  priceModel: "fixed",
  priceIdr: 250000000,
  negotiable: true,
  unitStatus: "available",
  hideSoldInGrids: false,
  otrPriceNote: "Harga OTR Jakarta, bebas tabrak & banjir, buku servis lengkap.",
  salesWhatsappOverride: "6281234567890",
  creditEstimate: {
    enabled: true,
    flatAnnualRateBps: 650,
    dpPercents: [20, 30, 40],
    tenorMonths: [12, 24, 36, 48],
  },
};

const BOOKED_NEW_MOTO = {
  vehicleCategory: "motorcycle",
  brand: "Yamaha",
  model: "NMAX Turbo",
  variant: "Tech MAX Ultimate",
  year: 2026,
  condition: "new",
  transmission: "cvt",
  fuel: "bensin",
  bodyType: "matic",
  color: "Magma Black",
  engineCc: 155,
  location: "Bandung",
  priceModel: "fixed",
  priceIdr: 45250000,
  negotiable: false,
  unitStatus: "booked",
  hideSoldInGrids: false,
  otrPriceNote: "Unit baru 2026 OTR Bandung.",
  creditEstimate: {
    enabled: true,
    flatAnnualRateBps: 800,
    dpPercents: [20, 30],
    tenorMonths: [12, 24, 36],
  },
};

const SOLD_USED_SUV = {
  vehicleCategory: "car",
  brand: "Honda",
  model: "CR-V",
  variant: "1.5 Turbo Prestige",
  year: 2023,
  condition: "used",
  mileageKm: 24300,
  transmission: "cvt",
  fuel: "bensin",
  bodyType: "suv",
  color: "Hitam Metalik",
  seats: 7,
  engineCc: 1498,
  location: "Jakarta Selatan",
  plateRegion: "B (Jakarta)",
  stnkTaxExpiryDate: "2026-11-20",
  ownershipCount: 1,
  priceModel: "fixed",
  priceIdr: 495000000,
  negotiable: false,
  unitStatus: "sold",
  hideSoldInGrids: false,
  creditEstimate: {
    enabled: true,
    flatAnnualRateBps: 650,
    dpPercents: [20, 30],
    tenorMonths: [24, 36],
  },
};

const DASHBOARD_VEHICLES = [
  {
    id: 11,
    slug: "toyota-innova-zenix-q-hybrid-2024",
    publicPath: "/kendaraan/toyota-innova-zenix-q-hybrid-2024",
    title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
    summary: "Unit tangan pertama, inspeksi 160 titik, servis rutin bengkel resmi.",
    priceMode: "fixed",
    price: 250000000,
    priceMax: null,
    negotiable: true,
    unitStatus: "available",
    status: "published",
    version: 2,
    attributes: AVAILABLE_USED_CAR,
  },
  {
    id: 12,
    slug: "yamaha-nmax-turbo-tech-max-2026",
    publicPath: "/kendaraan/yamaha-nmax-turbo-tech-max-2026",
    title: "Yamaha NMAX Turbo Tech MAX 2026",
    summary: "Skutik baru 2026 kondisi gress showroom.",
    priceMode: "fixed",
    price: 45250000,
    priceMax: null,
    negotiable: false,
    unitStatus: "booked",
    status: "published",
    version: 1,
    attributes: BOOKED_NEW_MOTO,
  },
  {
    id: 13,
    slug: "honda-cr-v-prestige-2023",
    publicPath: "/kendaraan/honda-cr-v-prestige-2023",
    title: "Honda CR-V 1.5 Turbo Prestige 2023",
    summary: "SUV keluarga terawat, unit sudah terjual.",
    priceMode: "fixed",
    price: 495000000,
    priceMax: null,
    negotiable: false,
    unitStatus: "sold",
    status: "published",
    version: 3,
    attributes: SOLD_USED_SUV,
  },
];

async function buildTask079Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t079-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const vehicleClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/catalog/vehicles/_VehicleShowroomManagerClient.tsx",
  );
  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const sectionVehiclesImport = path.join(
    webDir,
    "src/themes/default/sections/SectionVehiclesGrid.astro",
  );
  const detailViewImport = path.join(
    webDir,
    "src/pages/kendaraan/_VehicleShowroomDetailView.astro",
  );
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const publicPagesCssImport = path.join(webDir, "src/pages/layanan/_public-pages.css");

  const sharedShell = (pageTitle) => `{
    isPreview: false,
    layoutMode: "standard",
    themeId: "dealer",
    baseThemeId: "dealer",
    themeStyle: { tokens: {}, variants: {} },
    site: {
      title: "Bintang Motor Showroom",
      tagline: "Showroom Mobil & Motor Terpercaya Jakarta Selatan",
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public",
      analyticsConfig: null,
    },
    business: {
      name: "Bintang Motor Showroom",
      category: "AutoDealer",
      description: "Showroom mobil dan motor resmi dengan inspeksi menyeluruh dan harga transparan.",
      address: "Jl. Fatmawati Raya No. 88",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12410",
      mapsUrl: null,
      weekdayHours: "Senin–Minggu 09:00–18:00 WIB",
      holidayHours: null,
      phone: "+62215559900",
      whatsappE164: "+6281234567890",
      email: "halo@bintangmotor.id",
      socialLinks: [],
    },
    menus: {
      header: [
        { label: "Beranda", href: "/", openInNewTab: false, children: [] },
        { label: "Kendaraan", href: "/showroom", openInNewTab: false, children: [] },
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

  const baseTenant = `{
    id: "01JT079E2ETENANT0000000001",
    handle: "bintang-motor",
    host: "www.bintangmotor.id",
    primaryHost: "www.bintangmotor.id",
    primaryHostKind: "custom",
    status: "active",
    operatorHold: false,
    cacheVersion: 1,
  }`;

  const vehicleDescriptor = `{
    offeringType: "vehicle",
    prefix: "/kendaraan",
    namespace: "kendaraan",
    singularLabel: "Kendaraan",
    pluralLabel: "Kendaraan",
    listingHeading: "Daftar Unit Kendaraan",
    listingDescription: "Pilihan unit mobil dan motor showroom.",
    emptyHeading: "Belum ada kendaraan",
    emptyBody: "Belum ada unit.",
    backLabel: "Semua Kendaraan",
    detailCtaDefaultLabel: "Hubungi Sales via WhatsApp",
  }`;

  // 1. Showroom Grid Page (`/showroom`) — renders all 3 units + a `hideSoldInGrids` section
  fs.writeFileSync(
    path.join(pagesDir, "showroom.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionVehiclesGrid from ${JSON.stringify(sectionVehiclesImport)};

const shell = ${sharedShell("Showroom Kendaraan — Bintang Motor")};
const items = [
  {
    slug: "toyota-innova-zenix-q-hybrid-2024",
    href: "/detail-available",
    title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
    summary: "Unit tangan pertama, inspeksi 160 titik, servis rutin bengkel resmi.",
    vehicle: ${JSON.stringify(AVAILABLE_USED_CAR)},
  },
  {
    slug: "yamaha-nmax-turbo-tech-max-2026",
    href: "/detail-booked-moto",
    title: "Yamaha NMAX Turbo Tech MAX 2026",
    summary: "Skutik baru 2026 kondisi gress showroom.",
    vehicle: ${JSON.stringify(BOOKED_NEW_MOTO)},
  },
  {
    slug: "honda-cr-v-prestige-2023",
    href: "/detail-sold",
    title: "Honda CR-V 1.5 Turbo Prestige 2023",
    summary: "SUV keluarga terawat, unit sudah terjual.",
    vehicle: ${JSON.stringify(SOLD_USED_SUV)},
  },
];
---
<PublicLayout shell={shell} pageTitle="Showroom Kendaraan" showConsent={false}>
  <SectionVehiclesGrid
    id="showroom-all"
    eyebrow="Showroom Resmi"
    heading="Daftar Unit Mobil & Motor"
    subheading="Unit terinspeksi lengkap dengan status ketersediaan transparan dan konsultasi langsung via WhatsApp."
    items={items}
    hideSoldInGrids={false}
    fallbackWhatsappPhone="+6281234567890"
    primaryOrigin="https://www.bintangmotor.id"
    isFirstSection={true}
  />

  <SectionVehiclesGrid
    id="showroom-hide-sold"
    eyebrow="Unit Aktif"
    heading="Unit Siap Pesan (Terjual Disembunyikan)"
    items={items}
    hideSoldInGrids={true}
    fallbackWhatsappPhone="+6281234567890"
    primaryOrigin="https://www.bintangmotor.id"
    surfaceTone="muted"
  />
</PublicLayout>
`,
  );

  function writeDetailFixture(fileName, opts) {
    fs.writeFileSync(
      path.join(pagesDir, fileName),
      `---
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import VehicleShowroomDetailView from ${JSON.stringify(detailViewImport)};

const vehicle = ${JSON.stringify(opts.vehicle)};
const shell = ${sharedShell(opts.title)};
const tenant = ${baseTenant};
const canonical = ${JSON.stringify(`https://www.bintangmotor.id/kendaraan/${opts.slug}`)};
const seoInput = {
  surface: "public_tenant",
  routeKind: "offering",
  pathname: ${JSON.stringify(`/kendaraan/${opts.slug}`)},
  tenant: {
    tenantHandle: "bintang-motor",
    tenantStatus: "active",
    primaryHost: "www.bintangmotor.id",
    primaryHostKind: "custom",
    primaryHostStatus: "active",
    primaryHostSslStatus: "active",
    primaryHostVerified: true,
    verifiedTenantHosts: ["www.bintangmotor.id", "bintang-motor.situsku.click"],
  },
  siteVisibility: "public",
  resourceState: "published",
};

const seoMetadata = generateOpenGraphMetadata({
  seo: seoInput,
  siteName: "Bintang Motor Showroom",
  title: ${JSON.stringify(opts.title)},
  description: ${JSON.stringify(opts.summary)},
  locale: "id-ID",
});

const schemaResult = generateSchemaGraph({
  seo: seoInput,
  siteName: "Bintang Motor Showroom",
  business: {
    businessName: "Bintang Motor Showroom",
    businessCategory: "AutoDealer",
    address: "Jl. Fatmawati Raya No. 88",
    city: "Jakarta Selatan",
    phone: "+62215559900",
  },
  pageTitle: ${JSON.stringify(opts.title)},
  offering: {
    offeringType: "vehicle",
    title: ${JSON.stringify(opts.title)},
    summary: ${JSON.stringify(opts.summary)},
    priceMode: vehicle.priceModel,
    price: vehicle.priceIdr ?? null,
    priceMax: null,
    negotiable: vehicle.negotiable,
    ctaMode: "whatsapp",
    unitStatus: vehicle.unitStatus,
    attributes: vehicle,
  },
});

const result = {
  kind: "offering_detail",
  http: { status: 200, headers: {} },
  tenant,
  shell,
  primaryOrigin: "https://www.bintangmotor.id",
  currentPath: ${JSON.stringify(`/kendaraan/${opts.slug}`)},
  descriptor: ${vehicleDescriptor},
  pageTitle: ${JSON.stringify(`${opts.title} — Bintang Motor Showroom`)},
  offering: {
    offeringType: "vehicle",
    slug: ${JSON.stringify(opts.slug)},
    title: ${JSON.stringify(opts.title)},
    summary: ${JSON.stringify(opts.summary)},
    descriptionHtml: "<p>Unit telah melewati inspeksi menyeluruh meliputi mesin, transmisi, kaki-kaki, serta kelengkapan dokumen STNK dan BPKB.</p>",
    categoryNames: [${JSON.stringify(opts.categoryName)}],
    badge: null,
    unitStatus: vehicle.unitStatus,
    unitStatusLabel: ${JSON.stringify(opts.statusLabel)},
    priceMode: vehicle.priceModel,
    priceText: ${JSON.stringify(opts.priceText)},
    originalPriceText: null,
    negotiable: vehicle.negotiable,
    coverImage: null,
    galleryImages: [],
    youtubeVideoId: null,
    serviceAttributes: null,
    productAttributes: null,
    tourAttributes: null,
    vehicleAttributes: null,
    vehicleCreditRows: [],
    cta: {
      mode: "whatsapp",
      label: "Hubungi Sales via WhatsApp",
      href: "https://wa.me/6281234567890?text=Halo",
      isExternal: true,
      isWhatsApp: true,
      helperNote: null,
    },
    fallbackContactHref: null,
  },
  relatedOfferings: [],
  breadcrumbs: [
    { label: "Beranda", href: "/" },
    { label: "Kendaraan", href: "/showroom" },
    { label: ${JSON.stringify(opts.title)}, href: null },
  ],
  seoMetadata,
  schemaGraph: schemaResult.graph,
  floatingWa: {
    phone: null,
    businessName: "Bintang Motor Showroom",
    operatingHours: null,
    holidayHours: null,
    primaryOrigin: "https://www.bintangmotor.id",
    canonicalPath: ${JSON.stringify(`/kendaraan/${opts.slug}`)},
    itemTitle: ${JSON.stringify(opts.title)},
    greetingMessage: "Halo",
  },
};
---
<VehicleShowroomDetailView result={result} vehicleShowroom={vehicle} />
`,
    );
  }

  // 2. Detail Available + Fixed + Static Credit-Estimate Table
  writeDetailFixture("detail-available.astro", {
    slug: "toyota-innova-zenix-q-hybrid-2024",
    title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
    summary: "Unit tangan pertama, inspeksi 160 titik, servis rutin bengkel resmi.",
    categoryName: "MPV Keluarga",
    statusLabel: "Tersedia",
    priceText: "Rp 250.000.000 (Nego)",
    vehicle: AVAILABLE_USED_CAR,
  });

  // 3. Detail Sold (Indexable 200 OK, TERJUAL badge, credit table HIDDEN, SoldOut JSON-LD)
  writeDetailFixture("detail-sold.astro", {
    slug: "honda-cr-v-prestige-2023",
    title: "Honda CR-V 1.5 Turbo Prestige 2023",
    summary: "SUV keluarga terawat, unit sudah terjual.",
    categoryName: "SUV",
    statusLabel: "Terjual",
    priceText: "Rp 495.000.000",
    vehicle: SOLD_USED_SUV,
  });

  // 4. Detail Booked New Motorcycle (No mileage, BOOKED badge, credit table HIDDEN, omitted availability)
  writeDetailFixture("detail-booked-moto.astro", {
    slug: "yamaha-nmax-turbo-tech-max-2026",
    title: "Yamaha NMAX Turbo Tech MAX 2026",
    summary: "Skutik baru 2026 kondisi gress showroom.",
    categoryName: "Skutik Premium",
    statusLabel: "Dipesan",
    priceText: "Rp 45.250.000",
    vehicle: BOOKED_NEW_MOTO,
  });

  // 5. Dashboard Vehicles Manager Page (`/dashboard-vehicles`)
  fs.writeFileSync(
    path.join(pagesDir, "dashboard-vehicles.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { VehicleShowroomManagerClient } from ${JSON.stringify(vehicleClientImport)};

const permissions = {
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
};
---
<DashboardLayout
  title="Showroom Kendaraan — Bintang Motor Showroom"
  surface="dashboard"
  workspaceName="Bintang Motor Showroom"
  workspaceSubtitle="bintang-motor.situsku.click"
  activeNavId="offering"
  basePath="/dashboard/bintang-motor"
  offeringLabel="Kendaraan"
  lifecycleStatus="active"
  publicSiteHref="/showroom"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <VehicleShowroomManagerClient
    client:load
    tenantId="01JT079E2ETENANT0000000001"
    handle="bintang-motor"
    basePath="/dashboard/bintang-motor"
    permissions={permissions}
    canWriteVehicles={true}
    canPublishVehicles={true}
    initialVehicles={${JSON.stringify(DASHBOARD_VEHICLES)}}
  />
</DashboardLayout>
`,
  );

  const astroMod = await import(astroEntryUrl);
  const reactMod = await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href);
  const tailwindcssMod = await import(
    pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href
  );

  await astroMod.build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    integrations: [reactMod.default()],
    vite: {
      plugins: [tailwindcssMod.default()],
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

function startStaticServer(outDir) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      if (urlPath === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      let filePath = path.join(outDir, urlPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
        filePath = `${filePath}.html`;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function assertZeroOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${label}: horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildTask079Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);
  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const consoleErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
    });

    // 1. Showroom Grid at 1440px & 360px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/showroom/`, { waitUntil: "networkidle" });
    await assertZeroOverflow(page, "showroom-1440");

    const allCardsCount = await page.locator('#showroom-all [data-testid="vehicle-grid-card"]').count();
    const hideSoldCount = await page.locator('#showroom-hide-sold [data-testid="vehicle-grid-card"]').count();
    assert(allCardsCount === 3, `Expected 3 cards in #showroom-all, got ${allCardsCount}`);
    assert(hideSoldCount === 2, `Expected 2 cards in #showroom-hide-sold, got ${hideSoldCount}`);

    // Verify new motorcycle card has NO mileage item while used car card HAS mileage
    const motoMileageCount = await page
      .locator('#showroom-all [data-vehicle-slug="yamaha-nmax-turbo-tech-max-2026"] [data-testid="vehicle-card-mileage"]')
      .count();
    const carMileageText = await page
      .locator('#showroom-all [data-vehicle-slug="toyota-innova-zenix-q-hybrid-2024"] [data-testid="vehicle-card-mileage"]')
      .innerText();
    assert(motoMileageCount === 0, "New motorcycle card must NOT display mileage");
    assert(carMileageText.includes("18.500 km"), `Expected 18.500 km on used car card, got ${carMileageText}`);

    // Zero <script> tags or Astro client islands inside showroom grid sections
    const showroomScriptAudit = await page.evaluate(() => ({
      sectionScripts: document.querySelectorAll('[data-testid="section-vehicles-grid"] script').length,
      astroIslands: document.querySelectorAll("astro-island").length,
      moduleScripts: document.querySelectorAll('script[type="module"]').length,
    }));
    assert(showroomScriptAudit.sectionScripts === 0, `Showroom grid must have 0 <script> tags, got ${showroomScriptAudit.sectionScripts}`);
    assert(showroomScriptAudit.astroIslands === 0, `Showroom grid must have 0 astro-island elements, got ${showroomScriptAudit.astroIslands}`);
    assert(showroomScriptAudit.moduleScripts === 0, `Showroom grid must have 0 module scripts, got ${showroomScriptAudit.moduleScripts}`);

    await page.screenshot({ path: path.join(screenshotDir, "showroom-grid-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertZeroOverflow(page, "showroom-360");
    await page.screenshot({ path: path.join(screenshotDir, "showroom-grid-360.png"), fullPage: true });

    // 2. Available Used Car Detail + Static Credit Table (1440px & 360px)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/detail-available/`, { waitUntil: "networkidle" });
    const rejectConsentBtn = page.getByRole("button", { name: "Tolak opsional" });
    if ((await rejectConsentBtn.count()) > 0 && (await rejectConsentBtn.isVisible())) {
      await rejectConsentBtn.click();
    }
    await assertZeroOverflow(page, "detail-available-1440");

    const creditSection = page.locator('[data-testid="vehicle-credit-table"]');
    assert((await creditSection.count()) === 1, "Available fixed-price car must render static credit table");
    assert((await creditSection.locator("tbody tr").count()) === 3, "Expected 3 DP rows (20%, 30%, 40%)");

    // Verify exact BigInt round_half_up cell: 250M, DP 20% = 50M, 6.5% flat, 36 bln -> Rp 6.638.889 / bln
    const cell36 = await creditSection
      .locator('tr[data-dp-percent="20"] td[data-tenor-months="36"]')
      .innerText();
    assert(
      cell36.includes("Rp 6.638.889 / bln"),
      `Expected exact round_half_up cell 'Rp 6.638.889 / bln', got '${cell36}'`,
    );

    const disclaimerText = await page.locator('[data-testid="vehicle-credit-disclaimer"]').innerText();
    assert(
      disclaimerText.includes("bukan penawaran pembiayaan atau persetujuan kredit leasing resmi"),
      "Mandatory Indonesian non-financing disclaimer missing",
    );

    const stnkText = await page.locator('[data-testid="vehicle-spec-stnk"]').innerText();
    assert(stnkText.includes("15 Agustus 2027"), `Expected timezone-invariant STNK date, got '${stnkText}'`);

    // Verify ZERO client JS scripts, zero astro-islands, and zero interactive calculator inputs on credit table
    const detailScriptAudit = await page.evaluate(() => ({
      detailScripts: document.querySelectorAll('[data-testid="offering-detail-vehicle"] script').length,
      creditScripts: document.querySelectorAll('[data-testid="vehicle-credit-table"] script').length,
      creditInputs: document.querySelectorAll('[data-testid="vehicle-credit-table"] input, [data-testid="vehicle-credit-table"] select, [data-testid="vehicle-credit-table"] button').length,
      astroIslands: document.querySelectorAll("astro-island").length,
      moduleScripts: document.querySelectorAll('script[type="module"]').length,
    }));
    assert(detailScriptAudit.detailScripts === 0, `Vehicle detail must have 0 <script> tags, got ${detailScriptAudit.detailScripts}`);
    assert(detailScriptAudit.creditScripts === 0, `Credit table must have 0 <script> tags, got ${detailScriptAudit.creditScripts}`);
    assert(detailScriptAudit.creditInputs === 0, `Credit table must have 0 interactive inputs/controls, got ${detailScriptAudit.creditInputs}`);
    assert(detailScriptAudit.astroIslands === 0, `Vehicle detail must have 0 astro-island elements, got ${detailScriptAudit.astroIslands}`);
    assert(detailScriptAudit.moduleScripts === 0, `Vehicle detail must have 0 module scripts, got ${detailScriptAudit.moduleScripts}`);

    // Verify rendered JSON-LD for Car + InStock + zero LoanOrCredit
    const availJsonLdRaw = await page.locator('script[type="application/ld+json"]').first().innerText();
    const availJsonLd = JSON.parse(availJsonLdRaw);
    const carNode = availJsonLd["@graph"].find((n) => n["@type"] === "Car");
    assert(Boolean(carNode), "Available car JSON-LD must emit @type Car");
    assert(carNode.offers?.availability === "https://schema.org/InStock", "Available car must emit InStock");
    assert(!availJsonLdRaw.includes("LoanOrCredit"), "JSON-LD must never emit LoanOrCredit");

    await page.screenshot({ path: path.join(screenshotDir, "detail-available-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertZeroOverflow(page, "detail-available-360");
    await page.screenshot({ path: path.join(screenshotDir, "detail-available-360.png"), fullPage: true });

    // 3. Sold Car Detail -> 200 OK, indexable, TERJUAL badge, credit table HIDDEN, SoldOut JSON-LD
    await page.setViewportSize({ width: 1440, height: 900 });
    const soldRes = await page.goto(`${baseUrl}/detail-sold/`, { waitUntil: "networkidle" });
    assert(soldRes.status() === 200, "Sold vehicle detail must return 200 OK");
    await assertZeroOverflow(page, "detail-sold-1440");

    const soldRobots = await page.locator('meta[name="robots"]').getAttribute("content");
    assert(
      !soldRobots || !soldRobots.toLowerCase().includes("noindex"),
      `Sold vehicle detail must stay indexable, got robots='${soldRobots}'`,
    );
    const soldBadge = await page.locator('[data-testid="vehicle-unit-status"]').innerText();
    assert(soldBadge.trim() === "TERJUAL", `Expected TERJUAL badge, got '${soldBadge}'`);
    assert(
      (await page.locator('[data-testid="vehicle-credit-table"]').count()) === 0,
      "Sold vehicle detail MUST HIDE credit-estimate table",
    );

    const soldJsonLdRaw = await page.locator('script[type="application/ld+json"]').first().innerText();
    const soldJsonLd = JSON.parse(soldJsonLdRaw);
    const soldCarNode = soldJsonLd["@graph"].find((n) => n["@type"] === "Car");
    assert(
      soldCarNode?.offers?.availability === "https://schema.org/SoldOut",
      "Sold vehicle JSON-LD must emit SoldOut",
    );

    await page.screenshot({ path: path.join(screenshotDir, "detail-sold-1440.png"), fullPage: true });

    // 4. Booked New Motorcycle Detail -> NO mileage, BOOKED badge, credit table HIDDEN, Motorcycle JSON-LD with omitted availability
    await page.goto(`${baseUrl}/detail-booked-moto/`, { waitUntil: "networkidle" });
    assert(
      (await page.locator('[data-testid="vehicle-spec-mileage"]').count()) === 0,
      "New motorcycle detail must NOT render mileage",
    );
    assert(
      (await page.locator('[data-testid="vehicle-credit-table"]').count()) === 0,
      "Booked vehicle detail MUST HIDE credit-estimate table",
    );
    const bookedJsonLdRaw = await page.locator('script[type="application/ld+json"]').first().innerText();
    assert(!bookedJsonLdRaw.includes("Reserved"), "Booked JSON-LD must NEVER emit Reserved");
    const bookedGraph = JSON.parse(bookedJsonLdRaw);
    const motoNode = bookedGraph["@graph"].find((n) => n["@type"] === "Motorcycle");
    assert(Boolean(motoNode), "Booked motorcycle JSON-LD must emit @type Motorcycle");
    assert(motoNode.offers?.availability === undefined, "Booked vehicle JSON-LD must omit availability");

    // 5. Dashboard Vehicles Editor at 1440px & 360px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/dashboard-vehicles/`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="vehicle-showroom-manager"]').waitFor({ state: "visible" });
    await assertZeroOverflow(page, "dashboard-vehicles-1440");

    // Verify live preview table renders exact round_half_up value in dashboard
    const previewText = await page.locator('[data-testid="vehicle-credit-preview"]').innerText();
    assert(previewText.includes("Rp 6.638.889 / bln"), "Dashboard credit preview must match server round_half_up");

    await page.screenshot({ path: path.join(screenshotDir, "dashboard-vehicles-1440.png"), fullPage: true });

    // Switch to booked motorcycle unit -> verify credit-hidden notice displays & mileage input is disabled
    await page.locator('[data-testid="vehicle-list-item-12"]').click();
    await page.locator('[data-testid="vehicle-credit-hidden-notice"]').waitFor({ state: "visible" });
    const mileageDisabled = await page.locator("#vh-mileage").isDisabled();
    assert(mileageDisabled === true, "Mileage input must be disabled when condition === 'new'");

    // Switch back to unit 11 for clean mobile screenshot
    await page.locator('[data-testid="vehicle-list-item-11"]').click();
    await page.setViewportSize({ width: 360, height: 800 });
    await assertZeroOverflow(page, "dashboard-vehicles-360");
    await page.screenshot({ path: path.join(screenshotDir, "dashboard-vehicles-360.png"), fullPage: true });

    assert(consoleErrors.length === 0, `Browser errors detected: ${consoleErrors.join("; ")}`);

    console.log("TASK-079 E2E PASSED — all assertions green!");
    console.log("Screenshots saved to:", screenshotDir);
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
