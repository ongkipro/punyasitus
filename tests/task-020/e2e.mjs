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

const screenshotDir = process.env.TASK020_SCREENSHOT_DIR || "/tmp/qa-task-020";

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

const GENERAL_TOUR_FIXTURE = {
  packageKind: "general_tour",
  destination: "Bali & Nusa Penida",
  durationDays: 4,
  durationNights: 3,
  departureCity: "Jakarta (CGK)",
  airline: "Garuda Indonesia",
  transport: "Bus Pariwisata AC Eksekutif",
  hotels: [
    {
      name: "Grand Kuta Heritage",
      city: "Badung, Bali",
      starClass: 4,
      distanceNote: "5 menit dari Pantai Kuta",
    },
    {
      name: "Ubud Valley Resort",
      city: "Gianyar, Bali",
      starClass: 4,
      distanceNote: "10 menit dari pusat Ubud",
    },
  ],
  inclusions: [
    "Tiket pesawat pulang pergi kelas ekonomi",
    "Hotel bintang 4 sekamar berdua (3 malam)",
    "Transportasi darat ber-AC dan pemandu resmi",
    "Fast boat pulang pergi Sanur – Nusa Penida",
  ],
  exclusions: [
    "Pengeluaran pribadi di luar program",
    "Tipping pemandu & pengemudi lokal",
  ],
  travelInsurance: "Asuransi perjalanan domestik standar Permenpar 6/2025",
  itinerary: [
    {
      dayNumber: 1,
      title: "Kedatangan Denpasar & Sunset Uluwatu",
      summary:
        "Penjemputan di Bandara Ngurah Rai, check-in hotel, dilanjutkan kunjungan sore ke Pura Uluwatu dan makan malam seafood Jimbaran.",
      city: "Badung",
      meals: "Makan Malam",
    },
    {
      dayNumber: 2,
      title: "Eksplorasi Nusa Penida Barat",
      summary:
        "Menyeberang dari Pelabuhan Sanur menggunakan fast boat menuju Kelingking Beach, Broken Beach, Angel's Billabong, dan Crystal Bay.",
      city: "Nusa Penida",
      meals: "Sarapan, Makan Siang, Makan Malam",
    },
    {
      dayNumber: 3,
      title: "Desa Penglipuran & Danau Bedugul",
      summary:
        "Mengunjungi Desa Adat Penglipuran, Pura Ulun Danu Beratan di Bedugul, serta wisata belanja oleh-oleh khas Bali.",
      city: "Ubud",
      meals: "Sarapan, Makan Siang",
    },
    {
      dayNumber: 4,
      title: "Waktu Bebas & Kepulangan",
      summary: "Sarapan di hotel, waktu bebas, check-out, dan pengantaran menuju Bandara Ngurah Rai.",
      city: "Denpasar",
      meals: "Sarapan",
    },
  ],
  departures: [
    {
      departureDate: "2026-12-15",
      returnDate: "2026-12-18",
      departureCity: "Jakarta (CGK)",
      label: "Keberangkatan Libur Akhir Tahun",
    },
    {
      departureDate: "2027-01-22",
      returnDate: "2027-01-25",
      departureCity: "Surabaya (SUB)",
      label: "Keberangkatan Grup Reguler",
    },
  ],
};

const DASHBOARD_PACKAGES = [
  {
    id: 11,
    slug: "paket-wisata-bali-nusa-penida-4h3m",
    publicPath: "/tour/paket-wisata-bali-nusa-penida-4h3m",
    title: "Paket Wisata Bali & Nusa Penida 4H3M",
    summary: "Liburan terkurasi 4 hari 3 malam bersama pemandu resmi dan asuransi perjalanan.",
    priceMode: "from",
    price: 4850000,
    priceMax: null,
    status: "published",
    version: 3,
    attributes: GENERAL_TOUR_FIXTURE,
  },
  {
    id: 12,
    slug: "paket-umrah-reguler-9-hari",
    publicPath: "/tour/paket-umrah-reguler-9-hari",
    title: "Paket Umrah Reguler 9 Hari Direct Madinah",
    summary: "Program ibadah Umrah 9 hari mengutamakan prinsip 5 Pasti Umrah Kemenag.",
    priceMode: "from",
    price: 29500000,
    priceMax: null,
    status: "draft",
    version: 1,
    attributes: {
      packageKind: "umrah",
      destination: "Makkah & Madinah",
      durationDays: 9,
      durationNights: 8,
      departureCity: "Jakarta (CGK)",
      airline: "Saudia Airlines (Direct CGK–MED)",
      transport: "Bus AC Eksekutif + Kereta Cepat Haramain",
      hotels: [
        {
          name: "Pullman Zamzam Makkah",
          city: "Makkah",
          starClass: 5,
          distanceNote: "±100 m dari Masjidil Haram",
        },
        {
          name: "Anwar Al Madinah Movenpick",
          city: "Madinah",
          starClass: 5,
          distanceNote: "±50 m dari Masjid Nabawi",
        },
      ],
      inclusions: [
        "Tiket pesawat pulang pergi direct",
        "Hotel bintang 5 Makkah & Madinah",
        "Makan 3x sehari menu Nusantara",
      ],
      exclusions: ["Pembuatan paspor dan vaksin meningitis"],
      travelInsurance: "Asuransi perjalanan & kesehatan jamaah sesuai ketentuan PPIU",
      officialVisa: "Visa Umrah resmi Kemenag & Siskopatuh",
      skPpiuNumber: "U.128 Tahun 2024",
      operatorVerified: false,
      umrahCounselApproved: false,
      itinerary: [
        {
          dayNumber: 1,
          title: "Keberangkatan Jakarta – Madinah",
          summary: "Berkumpul di Terminal 3 Bandara Soekarno-Hatta dan terbang menuju Madinah.",
          city: "Madinah",
          meals: "Makan di Pesawat, Makan Malam",
        },
        {
          dayNumber: 2,
          title: "Ibadah Masjid Nabawi & Ziarah Raudhah",
          summary: "Pendampingan ziarah Raudhah sesuai jadwal Tasreh resmi.",
          city: "Madinah",
          meals: "Sarapan, Makan Siang, Makan Malam",
        },
      ],
      departures: [
        {
          departureDate: "2026-12-15",
          returnDate: "2026-12-23",
          departureCity: "Jakarta (CGK)",
          label: "Grup Desember",
        },
      ],
    },
  },
];

async function buildTask020Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t020-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const travelClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/catalog/travel/_TravelCatalogManagerClient.tsx",
  );
  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const sectionTravelImport = path.join(
    webDir,
    "src/themes/default/sections/SectionTravelItinerary.astro",
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

  // 1. Public `/tour/paket-wisata-bali-nusa-penida-4h3m` fixture
  fs.writeFileSync(
    path.join(pagesDir, "public-tour.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { buildTravelInquiryWhatsAppHref } from "@punyasitus/core/catalog/travel";
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionTravelItinerary from ${JSON.stringify(sectionTravelImport)};

const travel = ${JSON.stringify(GENERAL_TOUR_FIXTURE)};
const pageTitle = "Paket Wisata Bali & Nusa Penida 4H3M";
const waHref = buildTravelInquiryWhatsAppHref({
  phone: "+6281234567890",
  packageTitle: pageTitle,
  departureDate: "2026-12-15",
  canonicalUrl: "https://wisatanusantara.id/tour/paket-wisata-bali-nusa-penida-4h3m",
});

const schemaResult = generateSchemaGraph({
  seo: {
    surface: "public_tenant",
    routeKind: "offering",
    pathname: "/tour/paket-wisata-bali-nusa-penida-4h3m",
    tenant: {
      tenantHandle: "wisata-nusantara",
      tenantStatus: "active",
      primaryHost: "wisatanusantara.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["wisatanusantara.id", "wisata-nusantara.situsku.click"],
    },
    siteVisibility: "public",
    resourceState: "published",
  },
  siteName: "Wisata Nusantara Tour",
  siteTagline: "Biro Perjalanan Wisata Terpercaya",
  business: {
    businessName: "Wisata Nusantara Tour",
    businessCategory: "TravelAgency",
    address: "Jl. Raya Kemang No. 88",
    city: "Jakarta Selatan",
    phone: "+62217198888",
  },
  pageTitle,
  pageDescription: "Paket wisata 4 hari 3 malam ke Bali & Nusa Penida termasuk hotel bintang 4, fast boat, dan asuransi perjalanan.",
  offering: {
    offeringType: "tour",
    title: pageTitle,
    summary: "Paket wisata 4 hari 3 malam ke Bali & Nusa Penida termasuk hotel bintang 4, fast boat, dan asuransi perjalanan.",
    priceMode: "from",
    price: 4850000,
    ctaMode: "whatsapp",
    attributes: travel,
  },
  now: "2026-11-24",
  timezone: "Asia/Jakarta",
});

const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "travel",
  baseThemeId: "travel",
  themeStyle: { tokens: {}, variants: {} },
  site: {
    title: "Wisata Nusantara Tour",
    tagline: "Biro Perjalanan Wisata Terpercaya",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Wisata Nusantara Tour",
    category: "TravelAgency",
    description: "Biro perjalanan wisata Nusantara & mancanegara.",
    address: "Jl. Raya Kemang No. 88",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    mapsUrl: null,
    weekdayHours: "Senin–Sabtu 08:30–17:30 WIB",
    holidayHours: null,
    phone: "+62217198888",
    whatsappE164: "+6281234567890",
    email: "halo@wisatanusantara.id",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Paket Tur", href: "/tour", openInNewTab: false, children: [] },
    ],
    footer: [],
    mobile: [],
  },
  page: { title: pageTitle },
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
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
        <span class="ps-badge">Paket Tur</span>
        <span class="ps-badge ps-badge--brand">4 Hari / 3 Malam</span>
      </div>
      <h1 class="ps-route-title">{pageTitle}</h1>
      <p class="ps-route-lead">
        Liburan terkurasi 4 hari 3 malam bersama pemandu resmi, hotel bintang 4, fast boat Nusa Penida, dan asuransi perjalanan.
      </p>
    </div>
  </section>

  <article class="ps-detail-shell" data-testid="offering-detail-tour">
    <div class="ps-container ps-detail-grid">
      <div class="ps-detail-main">
        <SectionTravelItinerary
          id="tour-itinerary"
          travel={travel}
          heading="Rincian Paket & Jadwal Perjalanan"
          whatsappHref={waHref}
          whatsappLabel="Tanya Jadwal via WhatsApp"
          inquiryHref="tel:+62217198888"
          inquiryLabel="Telepon Kantor"
          embedded={true}
        />
      </div>

      <aside class="ps-detail-sidebar" aria-label="Ringkasan penawaran">
        <div>
          <p class="ps-eyebrow">Paket Tur</p>
          <p class="ps-detail-price">Mulai Rp 4.850.000</p>
          <p class="ps-detail-note">Per peserta (sekamar berdua) • Konfirmasi langsung via WhatsApp</p>
        </div>
        <div class="ps-detail-cta-stack">
          <a
            href={waHref}
            class="ps-btn ps-btn--whatsapp"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="sidebar-whatsapp-cta"
          >
            Tanya Jadwal via WhatsApp
          </a>
        </div>
      </aside>
    </div>
  </article>
</PublicLayout>
`,
  );

  // 1b. Public tour with non-WhatsApp external CTA (M1 & M2 verification)
  fs.writeFileSync(
    path.join(pagesDir, "public-tour-non-wa.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import ${JSON.stringify(publicPagesCssImport)};
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionTravelItinerary from ${JSON.stringify(sectionTravelImport)};

const travel = ${JSON.stringify(GENERAL_TOUR_FIXTURE)};
const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "travel",
  baseThemeId: "travel",
  themeStyle: { tokens: {}, variants: {} },
  site: {
    title: "Wisata Nusantara Tour",
    tagline: "Biro Perjalanan Wisata Terpercaya",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Wisata Nusantara Tour",
    category: "TravelAgency",
    description: "Biro perjalanan wisata Nusantara.",
    address: "Jl. Raya Kemang No. 88",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    mapsUrl: null,
    weekdayHours: "Senin–Sabtu 08:30–17:30 WIB",
    holidayHours: null,
    phone: "+62217198888",
    whatsappE164: null,
    email: "halo@wisatanusantara.id",
    socialLinks: [],
  },
  menus: { header: [], footer: [], mobile: [] },
  page: { title: "Tur Non-WA" },
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
---
<PublicLayout shell={shell} pageTitle="Tur Non-WA" showConsent={false}>
  <SectionTravelItinerary
    id="tour-non-wa"
    travel={travel}
    heading="Rincian Paket & Jadwal Perjalanan"
    whatsappHref="https://wisatanusantara.id/formulir-pertanyaan"
    inquiryLabel="Isi Formulir Pertanyaan"
    embedded={false}
  />
</PublicLayout>
`,
  );

  // 2. Dashboard Travel & Umrah Manager fixture
  fs.writeFileSync(
    path.join(pagesDir, "dashboard-travel.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { TravelCatalogManagerClient } from ${JSON.stringify(travelClientImport)};
const initialPackages = ${JSON.stringify(DASHBOARD_PACKAGES)};
---
<DashboardLayout
  title="Pengelola Paket Tur & Umrah — Wisata Nusantara Tour"
  surface="dashboard"
  workspaceName="Wisata Nusantara Tour"
  workspaceSubtitle="wisatanusantara.id"
  activeNavId="offering"
  basePath="/dashboard/wisata-nusantara"
  offeringLabel="Paket Tur"
  lifecycleStatus="active"
  publicSiteHref="https://wisatanusantara.id"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <TravelCatalogManagerClient
    client:load
    tenantId="01JTESTTRAVELTENANT0000001"
    handle="wisata-nusantara"
    basePath="/dashboard/wisata-nusantara"
    permissions={${ownerPermissions}}
    canWriteTravel={true}
    canPublishTravel={true}
    initialPackages={initialPackages}
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
  const { tmpRoot, outDir } = await buildTask020Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    // ------------------------------------------------------------------
    // 1. Public Tour Detail (NO-JS verified + 360px & 1440px + TZ parity)
    // ------------------------------------------------------------------
    for (const tz of ["Asia/Jakarta", "America/Los_Angeles"]) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        timezoneId: tz,
        javaScriptEnabled: false,
      });
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/public-tour/`, { waitUntil: "networkidle" });

      const bodyText = await page.locator("body").innerText();
      assert(bodyText.includes("4 Hari / 3 Malam"), `[${tz}] Missing duration label`);
      assert(bodyText.includes("Garuda Indonesia"), `[${tz}] Missing airline`);
      assert(bodyText.includes("Grand Kuta Heritage"), `[${tz}] Missing hotel`);
      assert(bodyText.includes("Permenpar 6/2025"), `[${tz}] Missing insurance line`);
      assert(bodyText.includes("15 Desember 2026"), `[${tz}] Date-only shifted in ${tz}!`);
      assert(bodyText.includes("18 Desember 2026"), `[${tz}] Return date shifted in ${tz}!`);
      assert(!/sisa\s+\d+\s+kursi/i.test(bodyText), `[${tz}] Forbidden seat counter detected!`);

      // Native <details> itinerary accordion works with ZERO JS
      const day1Open = await page.locator('[data-testid="travel-itinerary-day-1"]').evaluate((el) => el.open);
      const day2OpenBefore = await page.locator('[data-testid="travel-itinerary-day-2"]').evaluate((el) => el.open);
      assert(day1Open === true, "Day 1 should be open by default");
      assert(day2OpenBefore === false, "Day 2 should start collapsed");
      await page.locator('[data-testid="travel-itinerary-day-2"] summary').click();
      const day2OpenAfter = await page.locator('[data-testid="travel-itinerary-day-2"]').evaluate((el) => el.open);
      assert(day2OpenAfter === true, "Day 2 accordion failed to open without JS");

      // Direct no-JS WhatsApp CTA check & literal `&` heading check (M2)
      const headingText = await page.locator("#tour-itinerary-facts-heading").innerText();
      assert(headingText === "Rincian Paket & Jadwal Perjalanan", `Double-escaped or wrong heading: ${headingText}`);
      const waHref = await page.locator('[data-testid="travel-whatsapp-cta"]').getAttribute("href");
      assert(waHref && waHref.startsWith("https://wa.me/6281234567890?text="), `Invalid WA CTA: ${waHref}`);

      // JSON-LD matches visible facts with ZERO invented Offer / availability / AggregateRating
      const jsonLdRaw = await page.locator('script[type="application/ld+json"]').first().textContent();
      assert(jsonLdRaw, "Missing JSON-LD script tag");
      const parsedLd = JSON.parse(jsonLdRaw);
      const trip = parsedLd["@graph"].find((n) => n["@type"] === "TouristTrip");
      assert(trip, "Missing TouristTrip node in JSON-LD");
      assert(trip.duration === "P4D", `Unexpected TouristTrip duration: ${trip.duration}`);
      assert(trip.itinerary?.["@type"] === "ItemList" && trip.itinerary.numberOfItems === 4, "Itinerary ItemList mismatch");
      assert(JSON.stringify(trip.departureTime) === JSON.stringify(["2026-12-15", "2027-01-22"]), "Departure dates mismatch");
      assert(!("offers" in trip) && !("availability" in trip) && !("aggregateRating" in trip), "Invented Offer/availability/rating in TouristTrip!");

      if (tz === "Asia/Jakarta") {
        // Check zero horizontal overflow at 1440px and capture screenshot
        const overflow1440 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert(!overflow1440, "Public tour detail overflows horizontally at 1440px");
        await page.screenshot({
          path: path.join(screenshotDir, "public-tour-detail-1440.png"),
          fullPage: true,
        });

        await page.setViewportSize({ width: 360, height: 800 });
        const overflow360 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert(!overflow360, "Public tour detail overflows horizontally at 360px");
        await page.screenshot({
          path: path.join(screenshotDir, "public-tour-detail-360.png"),
          fullPage: true,
        });
      }

      await ctx.close();
    }

    // ------------------------------------------------------------------
    // 1b. Non-WhatsApp CTA check (M1: zero wa_click / WA class / WA label)
    // ------------------------------------------------------------------
    {
      const nonWaCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        javaScriptEnabled: false,
      });
      const nonWaPage = await nonWaCtx.newPage();
      await nonWaPage.goto(`${baseUrl}/public-tour-non-wa/`, { waitUntil: "networkidle" });
      const waBtnCount = await nonWaPage.locator('[data-testid="travel-whatsapp-cta"]').count();
      const waEventCount = await nonWaPage.locator('[data-wa-event="wa_click"]').count();
      const secondaryHref = await nonWaPage
        .locator('[data-testid="travel-secondary-inquiry-cta"]')
        .getAttribute("href");
      const headingText = await nonWaPage.locator("#tour-non-wa-facts-heading").innerText();
      assert(waBtnCount === 0, "Non-WA URL must NOT render WhatsApp CTA button");
      assert(waEventCount === 0, "Non-WA URL must NOT emit data-wa-event='wa_click'");
      assert(
        secondaryHref === "https://wisatanusantara.id/formulir-pertanyaan",
        `Expected neutral inquiry href, got: ${secondaryHref}`,
      );
      assert(
        headingText === "Rincian Paket & Jadwal Perjalanan",
        `Expected literal '&' in heading, got: ${headingText}`,
      );
      await nonWaCtx.close();
    }

    // ------------------------------------------------------------------
    // 2. Dashboard Travel Editor: General Tour + Umrah SK PPIU Gate
    // ------------------------------------------------------------------
    const adminCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      timezoneId: "Asia/Jakarta",
    });
    const adminPage = await adminCtx.newPage();
    const consoleErrors = [];
    adminPage.on("pageerror", (err) => consoleErrors.push(err.message));

    await adminPage.goto(`${baseUrl}/dashboard-travel/`, { waitUntil: "networkidle" });
    await adminPage.locator('[data-testid="travel-manager-root"]').waitFor({ state: "visible" });

    // General tour state: ready to publish
    await adminPage.locator('[data-testid="travel-general-tour-ready"]').waitFor({ state: "visible" });
    const generalPublishDisabled = await adminPage.locator('[data-testid="travel-publish-btn"]').isDisabled();
    assert(generalPublishDisabled === false, "General tour publish button should be enabled");

    const dashOverflow1440 = await adminPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!dashOverflow1440, "Dashboard general tour overflows horizontally at 1440px");
    await adminPage.screenshot({
      path: path.join(screenshotDir, "dashboard-travel-general-1440.png"),
      fullPage: true,
    });

    await adminPage.setViewportSize({ width: 360, height: 800 });
    const dashOverflow360 = await adminPage.evaluate(() => {
      const offenders = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1) {
          offenders.push(`${el.tagName}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`);
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        offenders: offenders.slice(0, 8),
      };
    });
    assert(
      dashOverflow360.scrollWidth <= dashOverflow360.innerWidth,
      `Dashboard general tour overflows horizontally at 360px: ${JSON.stringify(dashOverflow360)}`,
    );
    await adminPage.screenshot({
      path: path.join(screenshotDir, "dashboard-travel-general-360.png"),
      fullPage: true,
    });

    // Switch to Umrah package -> DEC-042 gate blocks publish cleanly!
    await adminPage.setViewportSize({ width: 1440, height: 900 });
    await adminPage.locator('[data-testid="travel-package-pill-12"]').click();
    await adminPage.locator('[data-testid="travel-umrah-gate-alert"]').waitFor({ state: "visible" });

    const umrahPublishDisabled = await adminPage.locator('[data-testid="travel-publish-btn"]').isDisabled();
    assert(umrahPublishDisabled === true, "Umrah publish button MUST be disabled when DEC-042 gate fails!");

    const saveDraftDisabled = await adminPage.locator('[data-testid="travel-save-draft-btn"]').isDisabled();
    assert(saveDraftDisabled === false, "Umrah Save Draft button must remain enabled");

    const gateText = await adminPage.locator('[data-testid="travel-umrah-gate-alert"]').innerText();
    assert(gateText.includes("DEC-042"), "Umrah gate notice must cite DEC-042");

    await adminPage.screenshot({
      path: path.join(screenshotDir, "dashboard-travel-umrah-gate-1440.png"),
      fullPage: true,
    });

    await adminPage.setViewportSize({ width: 360, height: 800 });
    const umrahOverflow360 = await adminPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!umrahOverflow360, "Dashboard Umrah gate view overflows horizontally at 360px");
    await adminPage.screenshot({
      path: path.join(screenshotDir, "dashboard-travel-umrah-gate-360.png"),
      fullPage: true,
    });

    assert(consoleErrors.length === 0, `Unexpected dashboard page errors: ${consoleErrors.join("; ")}`);
    await adminCtx.close();

    console.log("TASK-020 E2E PASS: public tour (no-JS + TZ parity + JSON-LD) & dashboard travel/Umrah DEC-042 gate verified at 360px & 1440px.");
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
