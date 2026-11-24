#!/usr/bin/env node
/* global process, console, document, window, getComputedStyle, URL, HTMLElement, setTimeout */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  assert,
  createSeededM1Topology,
  findChromeExecutable,
  getFreePort,
  httpRequest,
  WEB_DIR,
} from "./_m1-harness.mjs";

const requireFromWeb = createRequire(path.join(WEB_DIR, "package.json"));
const playwrightCore = requireFromWeb("playwright-core");

const VIEWPORTS = Object.freeze([
  { label: "360", width: 360, height: 800 },
  { label: "768", width: 768, height: 1024 },
  { label: "1440", width: 1440, height: 900 },
]);

const ALL_ENGINE_NAMES = Object.freeze(["chromium", "firefox", "webkit"]);
const SKIPPED_LOCAL_STATUS =
  "SKIPPED_LOCAL_BROWSER_NOT_INSTALLED (enforced in CI release-gate.yml across chromium/firefox/webkit)";

function parseCliArgs(argv) {
  const args = {
    browsers: "auto",
    reportOut: null,
    screenshotDir: process.env.TASK038_SCREENSHOT_DIR || "/tmp/qa-task-038",
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--browsers" && argv[i + 1]) {
      args.browsers = argv[++i];
    } else if (token.startsWith("--browsers=")) {
      args.browsers = token.slice("--browsers=".length);
    } else if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--screenshot-dir" && argv[i + 1]) {
      args.screenshotDir = path.resolve(argv[++i]);
    } else if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node tests/e2e-gate/release-gate.mjs [--browsers=auto|chromium,firefox,webkit] [--report-out <path>] [--screenshot-dir <dir>] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

/**
 * Local loopback HTTP forward proxy so Firefox and WebKit (which lack Chromium's
 * --host-resolver-rules) can resolve *.situsku.click & *.punyasitus.com cleanly
 * against the local built Wrangler worker without modifying /etc/hosts.
 */
async function startLocalHostProxy(workerPort) {
  const proxyPort = await getFreePort();
  const server = http.createServer((req, res) => {
    let targetPath = req.url || "/";
    let targetHost = req.headers.host || `127.0.0.1:${workerPort}`;
    if (/^https?:\/\//i.test(targetPath)) {
      try {
        const parsed = new URL(targetPath);
        targetPath = `${parsed.pathname}${parsed.search}`;
        targetHost = parsed.host;
      } catch {
        // fallback to raw path
      }
    }
    const headers = { ...req.headers, host: targetHost };
    delete headers["proxy-connection"];

    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: workerPort,
        method: req.method,
        path: targetPath,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`Proxy error: ${err.message}`);
    });
    req.pipe(upstream);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", resolve);
  });

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function isEngineInstalled(engineName) {
  const browserType = playwrightCore[engineName];
  if (!browserType) return false;
  if (engineName === "chromium") {
    const sysChrome = findChromeExecutable();
    if (sysChrome && fs.existsSync(sysChrome)) return true;
  }
  try {
    const exePath = browserType.executablePath();
    return Boolean(exePath && fs.existsSync(exePath));
  } catch {
    return false;
  }
}

async function launchBrowserEngine(engineName, proxyUrl) {
  const browserType = playwrightCore[engineName];
  if (engineName === "chromium") {
    const executablePath = findChromeExecutable();
    return browserType.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--host-resolver-rules=MAP *.situsku.click 127.0.0.1, MAP punyasitus.com 127.0.0.1, MAP *.punyasitus.com 127.0.0.1",
      ],
    });
  }
  return browserType.launch({
    headless: true,
    proxy: { server: proxyUrl },
  });
}

async function seedM2VerticalContent(topology) {
  const { port, tenantA } = topology;
  const headers = {
    "Content-Type": "application/json",
    Origin: `http://127.0.0.1:${port}`,
    Cookie: tenantA.cookie,
  };

  // 1. Product offering (/produk/paket-audit-template-umkm)
  const prodCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offeringType: "product",
      title: "Kit Template SOP & Audit UMKM Digital",
      slug: "paket-audit-template-umkm",
      summary: "Paket dokumen operasional dan daftar periksa siap pakai untuk UMKM Indonesia.",
      description: "<p>Berisi 12 templat audit dan panduan tata kelola usaha harian.</p>",
      priceMode: "fixed",
      price: 350000,
      ctaMode: "whatsapp",
      attributes: {
        sku: "PS-SOP-001",
        brand: "Alpha Solusi",
        stockStatus: "ready",
        unit: "paket",
      },
    }),
  });
  assert(
    prodCreate.status === 201,
    `Failed creating product offering: ${prodCreate.status} ${prodCreate.body.slice(0, 300)}`,
  );
  const pJson = JSON.parse(prodCreate.body);
  const pId = pJson.offering?.id ?? pJson.data?.id ?? pJson.id;
  const pVer = pJson.offering?.version ?? pJson.data?.version ?? pJson.version ?? 1;
  const prodPub = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog/${pId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: pVer }),
  });
  assert(prodPub.status === 200, `Failed publishing product: ${prodPub.status}`);

  // 2. Tour offering (/tour/paket-umrah-reguler-9-hari)
  const tourCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offeringType: "tour",
      title: "Paket Umrah Reguler 9 Hari Hotel Dekat Masjid",
      slug: "paket-umrah-reguler-9-hari",
      summary: "Program umrah berizin resmi dengan pembimbing ibadah dan jadwal pasti.",
      description: "<p>Fasilitas lengkap mulai dari bimbingan manasik hingga kepulangan.</p>",
      priceMode: "from",
      price: 29500000,
      ctaMode: "whatsapp",
      attributes: {
        durationDays: 9,
        durationNights: 7,
        destination: "Makkah & Madinah",
        departureCity: "Jakarta (CGK)",
        airline: "Garuda Indonesia",
        hotel: "Setaraf Bintang 4",
        ppiuNumber: "U.123/2025",
        minPax: 2,
        departures: [
          { departureDate: "2027-02-15", seatsAvailable: 18, status: "open" },
        ],
      },
    }),
  });
  assert(
    tourCreate.status === 201,
    `Failed creating tour offering: ${tourCreate.status} ${tourCreate.body.slice(0, 300)}`,
  );
  const tJson = JSON.parse(tourCreate.body);
  const tId = tJson.offering?.id ?? tJson.data?.id ?? tJson.id;
  const tVer = tJson.offering?.version ?? tJson.data?.version ?? tJson.version ?? 1;
  const tourPub = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog/${tId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: tVer }),
  });
  assert(tourPub.status === 200, `Failed publishing tour: ${tourPub.status}`);

  // 3. Vehicle Showroom offering (/kendaraan/toyota-innova-zenix-hybrid-2024)
  const vehicleCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offeringType: "vehicle",
      title: "Toyota Kijang Innova Zenix Q Hybrid 2024",
      slug: "toyota-innova-zenix-hybrid-2024",
      summary: "MPV hybrid terawat, pajak panjang, buku servis resmi lengkap.",
      description: "<p>Unit pilihan siap pakai dengan tabel estimasi kredit statis non-mengikat.</p>",
      priceMode: "fixed",
      price: 485000000,
      negotiable: true,
      ctaMode: "whatsapp",
      unitStatus: "available",
      attributes: {
        brand: "Toyota",
        model: "Kijang Innova Zenix",
        variant: "Q Hybrid Modellista",
        year: 2024,
        condition: "used",
        transmission: "cvt",
        fuelType: "hybrid",
        bodyType: "mpv",
        mileageKm: 18500,
        color: "Putih Mutiara",
        seats: 7,
        engineCc: 1987,
        location: "Jakarta Selatan",
        plateRegion: "B (Jakarta)",
        ownershipCount: 1,
        unitStatus: "available",
        creditEstimateEnabled: true,
        creditEstimateConfig: {
          annualFlatRateBps: 650,
          dpPercents: [20, 30, 40],
          tenorMonths: [12, 24, 36, 48],
        },
      },
    }),
  });
  assert(
    vehicleCreate.status === 201,
    `Failed creating vehicle offering: ${vehicleCreate.status} ${vehicleCreate.body.slice(0, 300)}`,
  );
  const vJson = JSON.parse(vehicleCreate.body);
  const vId = vJson.offering?.id ?? vJson.data?.id ?? vJson.id;
  const vVer = vJson.offering?.version ?? vJson.data?.version ?? vJson.version ?? 1;
  const vehiclePub = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog/${vId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: vVer }),
  });
  assert(vehiclePub.status === 200, `Failed publishing vehicle: ${vehiclePub.status}`);

  // 4. Published Outlet + /gerai page (M2 TASK-019)
  const outletCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/outlets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Gerai Alpha Jakarta Kemang",
      slug: "gerai-alpha-kemang",
      address: "Jl. Kemang Raya No. 18",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12730",
      phone: "+62217191234",
      whatsappE164: "+6281234567890",
      latitude: -6.2607,
      longitude: 106.8133,
      weeklyHours: [
        { day: "monday", open: "08:00", close: "20:00", closed: false },
        { day: "saturday", open: "09:00", close: "17:00", closed: false },
        { day: "sunday", open: null, close: null, closed: true },
      ],
      status: "published",
      active: true,
      isPrimary: true,
    }),
  });
  assert(
    outletCreate.status === 201,
    `Failed creating outlet: ${outletCreate.status} ${outletCreate.body.slice(0, 300)}`,
  );

  const geraiPageCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Lokasi Gerai & Jam Operasional",
      slug: "gerai",
      isHomepage: false,
      layoutMode: "standard",
      sections: [
        {
          id: "hero-gerai",
          kind: "hero",
          heading: "Lokasi Gerai PT Alpha Solusi Nusantara",
          subheading: "Kunjungi gerai resmi kami atau hubungi tim melalui WhatsApp.",
          bodyHtml: null,
        },
        {
          id: "branches-gerai",
          kind: "branches",
          heading: "Daftar Gerai & Cabang Aktif",
          subheading: "Alamat lengkap, jam buka, dan petunjuk arah Google Maps.",
          bodyHtml: null,
        },
      ],
    }),
  });
  assert(
    geraiPageCreate.status === 201,
    `Failed creating /gerai page: ${geraiPageCreate.status} ${geraiPageCreate.body.slice(0, 300)}`,
  );
  const gJson = JSON.parse(geraiPageCreate.body);
  const gId = gJson.page?.id ?? gJson.data?.id ?? gJson.id;
  const gVer = gJson.page?.version ?? gJson.data?.version ?? gJson.version ?? 1;
  const geraiPub = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages/${gId}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: gVer }),
  });
  assert(geraiPub.status === 200, `Failed publishing /gerai page: ${geraiPub.status}`);

  return {
    productPath: "/produk/paket-audit-template-umkm",
    tourPath: "/tour/paket-umrah-reguler-9-hari",
    vehiclePath: "/kendaraan/toyota-innova-zenix-hybrid-2024",
    geraiPath: "/gerai",
  };
}

async function assertViewportIntegrity(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll(
        "header a[href], header button, header summary, main button, main a.ps-btn, main a.mk-btn, main input[type='submit'], main summary",
      ),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !el.classList.contains("ps-skip-link") &&
          !el.classList.contains("mk-skip-link")
        );
      })
      .map((el) => ({
        tag: el.tagName,
        id: el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 32) || "",
        height: Math.round(el.getBoundingClientRect().height),
      }));
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      controls,
    };
  });

  assert(
    !metrics.overflow,
    `[${label} @ ${width}px] Horizontal overflow (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
  assert(metrics.htmlFontSize >= 14, `[${label} @ ${width}px] Root font size ${metrics.htmlFontSize}px < 14px`);
  if (width <= 400) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

function validateJsonLdSchemaInvariants(jsonLdStrings, routeLabel, requiredTypeGroups = []) {
  assert(
    jsonLdStrings.length >= 1,
    `[no-js:${routeLabel}] Expected at least 1 <script type="application/ld+json"> block`,
  );
  const parsedTypes = [];
  for (const raw of jsonLdStrings) {
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[no-js:${routeLabel}] Invalid JSON-LD syntax: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const serialized = JSON.stringify(doc);
    // Strict no-fabricated-ratings and no-fabricated-financing schema invariants (TASK-053, TASK-079, DEC-042)
    assert(
      !serialized.includes('"aggregateRating"') && !serialized.includes('"review"'),
      `[no-js:${routeLabel}] Forbidden fabricated aggregateRating/review detected in JSON-LD`,
    );
    assert(
      !serialized.includes('"LoanOrCredit"') &&
        !serialized.includes('"FinancialProduct"') &&
        !serialized.includes('"CreditCard"'),
      `[no-js:${routeLabel}] Forbidden financing schema detected in JSON-LD`,
    );
    const nodes = Array.isArray(doc["@graph"]) ? doc["@graph"] : [doc];
    for (const node of nodes) {
      if (node && typeof node["@type"] === "string") {
        parsedTypes.push(node["@type"]);
      } else if (node && Array.isArray(node["@type"])) {
        for (const t of node["@type"]) {
          if (typeof t === "string") parsedTypes.push(t);
        }
      }
    }
  }
  const typeSet = new Set(parsedTypes);
  for (const anyOf of requiredTypeGroups) {
    const matched = anyOf.some((expected) => typeSet.has(expected));
    assert(
      matched,
      `[no-js:${routeLabel}] Expected JSON-LD @type matching one of [${anyOf.join(", ")}], observed [${[...typeSet].join(", ")}]`,
    );
  }
  return [...typeSet].sort();
}

async function runEngineChecks({
  engineName,
  proxyUrl,
  tenantABaseUrl,
  tenantAHost,
  marketingBaseUrl,
  seeded,
  m2Seeded,
  screenshotDir,
  captureScreenshots,
}) {
  const browser = await launchBrowserEngine(engineName, proxyUrl);
  const browserVersion = browser.version();
  const screenshots = [];

  try {
    // 1. Multi-viewport (360/768/1440) + zero errors + XSS neutralization + WCAG 1.4.10 + Keyboard focus
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedResources = [];

    page.on("response", (res) => {
      if (res.status() >= 400) {
        let pathname = "";
        try {
          pathname = new URL(res.url()).pathname;
        } catch {
          // ignore
        }
        if (res.status() === 404 && pathname === "/favicon.ico") return;
        failedResources.push(`${res.status()} ${res.url()}`);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        const locUrl = msg.location()?.url || "";
        let locPath = "";
        if (locUrl) {
          try {
            locPath = new URL(locUrl).pathname;
          } catch {
            // ignore
          }
        }
        if (
          text.startsWith("Failed to load resource: the server responded with a status of 404") &&
          locPath === "/favicon.ico"
        ) {
          return;
        }
        consoleErrors.push(locUrl ? `${text} (${locUrl})` : text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const viewportTargets = [
      { slug: "tenant-home", url: `${tenantABaseUrl}/` },
      { slug: "tenant-blog", url: `${tenantABaseUrl}${seeded.articlePath}` },
      { slug: "tenant-vehicle", url: `${tenantABaseUrl}${m2Seeded.vehiclePath}` },
      { slug: "tenant-tour", url: `${tenantABaseUrl}${m2Seeded.tourPath}` },
      { slug: "tenant-gerai", url: `${tenantABaseUrl}${m2Seeded.geraiPath}` },
      { slug: "marketing-home", url: `${marketingBaseUrl}/marketing` },
    ];

    for (const target of viewportTargets) {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const resp = await page.goto(target.url, { waitUntil: "load", timeout: 30_000 });
        assert(
          resp && resp.status() === 200,
          `[${engineName}:${target.slug}] Expected 200 on ${target.url}, got ${resp?.status()}`,
        );
        await assertViewportIntegrity(page, `${engineName}:${target.slug}`, vp.width);
        if (captureScreenshots) {
          const shotPath = path.join(screenshotDir, `${engineName}-${target.slug}-${vp.label}.png`);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: shotPath, fullPage: true });
          screenshots.push(shotPath);
        }
      }
    }

    // XSS neutralization proof on blog article
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${tenantABaseUrl}${seeded.articlePath}`, { waitUntil: "load" });
    const xssCheck = await page.evaluate(() => {
      const bodyEl = document.querySelector('[data-testid="blog-detail-body"]');
      const html = bodyEl ? bodyEl.innerHTML : "";
      return {
        executed: window.__m1XssExecuted ?? null,
        hasScriptTag: /<script\b/i.test(html),
        hasInlineHandler: /\bon(?:error|click|load)\s*=/i.test(html),
        hasJavascriptHref: /javascript:/i.test(html),
      };
    });
    assert(xssCheck.executed === null, `[${engineName}] XSS executed!`);
    assert(!xssCheck.hasScriptTag && !xssCheck.hasInlineHandler && !xssCheck.hasJavascriptHref, `[${engineName}] Unsanitized HTML leaked`);

    // WCAG 1.4.10 200% zoom reflow (720x450 @ DPR 2 + 320px + 200% root text scaling)
    const zoomCtx = await browser.newContext({
      viewport: { width: 720, height: 450 },
      deviceScaleFactor: 2,
    });
    try {
      const zoomPage = await zoomCtx.newPage();
      await zoomPage.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
      const overflow720 = await zoomPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow720, `[${engineName}] 200% browser zoom reflow overflowed at 720px @ DPR 2`);
      await zoomPage.setViewportSize({ width: 320, height: 640 });
      const overflow320 = await zoomPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow320, `[${engineName}] WCAG 1.4.10 320px reflow overflowed`);
    } finally {
      await zoomCtx.close();
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const textZoomOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!textZoomOverflow, `[${engineName}] 200% root font scaling produced overflow`);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });

    // Keyboard focus restoration on consent customize dialog
    await page.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
    await page.locator('[data-testid="consent-customize"]').focus();
    await page.evaluate(() => {
      window.__releaseConsentTrigger = document.activeElement;
    });
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="consent-preferences-dialog"]:not([hidden])');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const focusRestored = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        el === window.__releaseConsentTrigger &&
        el instanceof HTMLElement &&
        el.getAttribute("data-testid") === "consent-customize"
      );
    });
    assert(focusRestored, `[${engineName}] Expected Escape focus restoration to consent-customize trigger`);

    assert(failedResources.length === 0, `[${engineName}] Failed resources: ${failedResources.join(" | ")}`);
    assert(consoleErrors.length === 0, `[${engineName}] Console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `[${engineName}] Page errors: ${pageErrors.join(" | ")}`);
    await ctx.close();

    // 2. No-JS Public Journeys + Extended TASK-053 Schema/Crawl Suite across M1 + M2 vertical routes
    const noJsCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: false,
    });
    const noJsRoutesVerified = [];
    try {
      const noJsPage = await noJsCtx.newPage();
      const htmlRoutes = [
        {
          path: "/",
          label: "home",
          requiredTypes: [["WebSite"], ["LocalBusiness", "Organization"], ["WebPage"]],
        },
        {
          path: "/blog",
          label: "blog-index",
          requiredTypes: [["WebSite"], ["CollectionPage", "Blog", "WebPage"]],
        },
        {
          path: seeded.articlePath,
          label: "blog-detail",
          requiredTypes: [["Article", "BlogPosting"]],
        },
        {
          path: "/layanan",
          label: "layanan-index",
          requiredTypes: [["WebSite"], ["CollectionPage", "WebPage"]],
        },
        {
          path: seeded.offeringPath,
          label: "layanan-detail",
          requiredTypes: [["Service"]],
        },
        {
          path: "/produk",
          label: "produk-index",
          requiredTypes: [["WebSite"], ["CollectionPage", "WebPage"]],
        },
        {
          path: m2Seeded.productPath,
          label: "produk-detail",
          requiredTypes: [["Product"]],
        },
        {
          path: "/tour",
          label: "tour-index",
          requiredTypes: [["WebSite"], ["CollectionPage", "WebPage"]],
        },
        {
          path: m2Seeded.tourPath,
          label: "tour-detail",
          requiredTypes: [["TouristTrip"]],
        },
        {
          path: "/kendaraan",
          label: "kendaraan-index",
          requiredTypes: [["WebSite"], ["CollectionPage", "WebPage"]],
        },
        {
          path: m2Seeded.vehiclePath,
          label: "kendaraan-detail",
          requiredTypes: [["Car", "Motorcycle", "Vehicle"]],
        },
        {
          path: m2Seeded.geraiPath,
          label: "gerai",
          requiredTypes: [["LocalBusiness", "Organization"], ["WebPage"]],
        },
      ];

      for (const route of htmlRoutes) {
        const res = await noJsPage.goto(`${tenantABaseUrl}${route.path}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        assert(
          res && res.status() === 200,
          `[${engineName}:no-js:${route.label}] Expected 200 on ${route.path}, got ${res?.status()}`,
        );

        const inspection = await noJsPage.evaluate(() => {
          const h1 = document.querySelector("h1")?.textContent?.trim() || "";
          const canonicals = Array.from(document.querySelectorAll('link[rel="canonical"]')).map((l) =>
            l.getAttribute("href"),
          );
          const jsonLd = Array.from(
            document.querySelectorAll('script[type="application/ld+json"]'),
          ).map((s) => s.textContent || "");
          const hasMain = Boolean(document.querySelector("main"));
          return { h1, canonicals, jsonLd, hasMain };
        });

        assert(inspection.h1.length > 0, `[${engineName}:no-js:${route.label}] Missing visible <h1>`);
        assert(inspection.hasMain, `[${engineName}:no-js:${route.label}] Missing semantic <main>`);
        assert(
          inspection.canonicals.length === 1,
          `[${engineName}:no-js:${route.label}] Expected exactly 1 canonical link, got ${inspection.canonicals.length}`,
        );
        const schemaTypes = validateJsonLdSchemaInvariants(
          inspection.jsonLd,
          `${engineName}:${route.label}`,
          route.requiredTypes,
        );
        noJsRoutesVerified.push({
          path: route.path,
          status: res.status(),
          h1: inspection.h1.slice(0, 80),
          schemaTypesCount: schemaTypes.length,
          schemaTypes,
        });
      }
    } finally {
      await noJsCtx.close();
    }

    // Also verify /sitemap.xml & /robots.txt for Tenant A
    const sitemapRes = await httpRequest(Number(new URL(tenantABaseUrl).port), "/sitemap.xml", {
      headers: { Host: tenantAHost },
    });
    assert(
      sitemapRes.status === 200 && sitemapRes.body.includes("<sitemapindex") && sitemapRes.body.includes(tenantAHost),
      `[${engineName}] Invalid /sitemap.xml response: ${sitemapRes.status}`,
    );
    const robotsRes = await httpRequest(Number(new URL(tenantABaseUrl).port), "/robots.txt", {
      headers: { Host: tenantAHost },
    });
    assert(
      robotsRes.status === 200 && robotsRes.body.includes(`Sitemap: https://${tenantAHost}/sitemap.xml`),
      `[${engineName}] Invalid /robots.txt response: ${robotsRes.status}`,
    );

    return {
      engine: engineName,
      status: "PASSED",
      version: browserVersion,
      viewportsVerified: VIEWPORTS.map((v) => `${v.width}x${v.height}`),
      wcag200ZoomAnd320Reflow: true,
      keyboardFocusRestored: true,
      xssNeutralized: true,
      noJsRoutesCount: noJsRoutesVerified.length,
      noJsRoutesVerified,
      sitemapAndRobotsOk: true,
      screenshotsCount: screenshots.length,
      screenshots,
    };
  } finally {
    await browser.close();
  }
}

export async function runReleaseE2eGate({
  browsersArg = "auto",
  screenshotDir = "/tmp/qa-task-038",
} = {}) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const topology = await createSeededM1Topology({ prefix: "rel-gate", withSecondTenant: true });
  const proxy = await startLocalHostProxy(topology.port);

  try {
    const m2Seeded = await seedM2VerticalContent(topology);
    const { port, sqlitePath, tenantA, tenantB, seeded } = topology;
    const adminOrigin = `http://127.0.0.1:${port}`;
    const tenantABaseUrl = `http://${tenantA.host}:${port}`;
    const marketingBaseUrl = `http://127.0.0.1:${port}`;
    const adminHeaders = (cookie, origin = adminOrigin) => ({
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    });

    // -------------------------------------------------------------------------
    // NEGATIVE CASES: Cross-tenant 404, CSRF/Origin 403, Unsafe URL 422
    // -------------------------------------------------------------------------
    const crossTenantRead = await httpRequest(port, `/api/tenants/${tenantB.handle}/pages`, {
      method: "GET",
      headers: { Cookie: tenantA.cookie },
    });
    assert(
      crossTenantRead.status === 404 && !crossTenantRead.body.includes("Beta Karya"),
      `Cross-tenant A->B read expected strict 404, got ${crossTenantRead.status}`,
    );
    const crossTenantWrite = await httpRequest(port, `/api/tenants/${tenantB.handle}/outlets`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({ name: "Unauthorized Outlet", address: "Jl. Evil" }),
    });
    assert(
      crossTenantWrite.status === 404,
      `Cross-tenant A->B M2 outlet write expected strict 404, got ${crossTenantWrite.status}`,
    );

    const csrfEvilOrigin = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie, "https://evil.example"),
      body: JSON.stringify({ title: "CSRF Evil", slug: "csrf-evil-038", sections: [] }),
    });
    assert(csrfEvilOrigin.status === 403, `Expected 403 for evil Origin, got ${csrfEvilOrigin.status}`);

    const csrfTenantOrigin = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie, `https://${tenantA.host}`),
      body: JSON.stringify({ title: "CSRF Tenant", slug: "csrf-tenant-038", sections: [] }),
    });
    assert(
      csrfTenantOrigin.status === 403,
      `Expected 403 for tenant host Origin to admin API, got ${csrfTenantOrigin.status}`,
    );

    const jsUrlRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({
        offeringType: "service",
        title: "Uji URL Berbahaya",
        slug: "uji-url-js-038",
        priceMode: "on_request",
        ctaMode: "external_link",
        externalUrl: "javascript:alert(1)",
      }),
    });
    assert(jsUrlRes.status === 422, `Expected 422 for javascript: URL, got ${jsUrlRes.status}`);

    const privateIpRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({
        offeringType: "service",
        title: "Uji Private IP",
        slug: "uji-ssrf-038",
        priceMode: "on_request",
        ctaMode: "external_link",
        externalUrl: "http://169.254.169.254/latest/meta-data",
      }),
    });
    assert(privateIpRes.status === 422, `Expected 422 for private IP URL, got ${privateIpRes.status}`);

    // -------------------------------------------------------------------------
    // MULTI-BROWSER MATRIX EXECUTION
    // -------------------------------------------------------------------------
    const isAuto = browsersArg.trim().toLowerCase() === "auto";
    const isCi = process.env.CI === "true";
    const allowMissingEngines = isAuto && !isCi;
    const requestedEngines = isAuto
      ? [...ALL_ENGINE_NAMES]
      : browsersArg
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

    for (const eng of requestedEngines) {
      assert(
        ALL_ENGINE_NAMES.includes(eng),
        `Unsupported browser engine "${eng}" (expected one of: ${ALL_ENGINE_NAMES.join(", ")})`,
      );
    }

    const browserMatrix = {};
    const allScreenshots = [];
    let executedEnginesCount = 0;

    for (const engineName of requestedEngines) {
      const installed = isEngineInstalled(engineName);
      if (!installed) {
        if (!allowMissingEngines) {
          throw new Error(
            `Required browser engine "${engineName}" is not installed (CI=${String(isCi)}, mode=${browsersArg})! Install via: pnpm --filter @punyasitus/web exec playwright-core install --with-deps ${engineName}`,
          );
        }
        browserMatrix[engineName] = {
          engine: engineName,
          status: SKIPPED_LOCAL_STATUS,
          installed: false,
        };
        continue;
      }

      const engineReport = await runEngineChecks({
        engineName,
        proxyUrl: proxy.proxyUrl,
        tenantABaseUrl,
        tenantAHost: tenantA.host,
        marketingBaseUrl,
        seeded,
        m2Seeded,
        screenshotDir,
        captureScreenshots: engineName === "chromium" || !isAuto,
      });
      browserMatrix[engineName] = { installed: true, ...engineReport };
      allScreenshots.push(...engineReport.screenshots);
      executedEnginesCount += 1;
    }

    assert(
      executedEnginesCount >= 1,
      "At least one Playwright browser engine must execute locally (chromium)",
    );

    // -------------------------------------------------------------------------
    // NEGATIVE CASE: Warm-Cache Suspension -> Immediate 503 no-store noindex
    // -------------------------------------------------------------------------
    const warmRes = await httpRequest(port, "/", { headers: { Host: tenantA.host } });
    assert(
      warmRes.status === 200 && warmRes.body.includes("PT Alpha Solusi Nusantara"),
      `Expected warm 200 on Tenant A before suspension, got ${warmRes.status}`,
    );

    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE tenants SET status = 'suspended', operator_hold = 1 WHERE id = ?").run(
        tenantA.tenantId,
      );
    } finally {
      db.close();
    }

    await new Promise((r) => setTimeout(r, 5_200));

    const suspendedRes = await httpRequest(port, "/", { headers: { Host: tenantA.host } });
    assert(suspendedRes.status === 503, `Expected 503 on suspended tenant, got ${suspendedRes.status}`);
    assert(
      suspendedRes.headers["cache-control"] === "no-store",
      `Expected Cache-Control: no-store, got ${suspendedRes.headers["cache-control"]}`,
    );
    assert(
      suspendedRes.headers["x-robots-tag"] === "noindex, nofollow",
      `Expected X-Robots-Tag: noindex, nofollow, got ${suspendedRes.headers["x-robots-tag"]}`,
    );
    assert(
      !suspendedRes.body.includes("PT Alpha Solusi Nusantara"),
      "Suspended tenant 503 leaked cached HTML!",
    );

    return {
      ok: true,
      gate: "FULL_RELEASE_MULTI_BROWSER_AND_NEGATIVE_GATE",
      task: "TASK-038",
      requirement: "REQ-041",
      verifiedAt: new Date().toISOString(),
      browsersMode: browsersArg,
      executedEnginesCount,
      browserMatrix,
      viewportsVerified: VIEWPORTS.map((v) => `${v.width}x${v.height}`),
      screenshotDir,
      screenshotsCount: allScreenshots.length,
      screenshots: allScreenshots,
      negativeCases: {
        crossTenantIsolation: {
          ok: true,
          crossTenantReadStatus: crossTenantRead.status,
          crossTenantM2OutletWriteStatus: crossTenantWrite.status,
        },
        csrfOriginEnforcement: {
          ok: true,
          evilOriginStatus: csrfEvilOrigin.status,
          tenantHostOriginStatus: csrfTenantOrigin.status,
        },
        unsafeUrlValidation: {
          ok: true,
          javascriptUrlStatus: jsUrlRes.status,
          privateIpStatus: privateIpRes.status,
        },
        warmCacheSuspension: {
          ok: true,
          suspendedStatus: suspendedRes.status,
          cacheControl: suspendedRes.headers["cache-control"],
          xRobotsTag: suspendedRes.headers["x-robots-tag"],
          zeroContentLeak: true,
        },
      },
    };
  } finally {
    await proxy.stop();
    await topology.cleanup();
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runReleaseE2eGate({
    browsersArg: args.browsers,
    screenshotDir: args.screenshotDir,
  });

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const engineSummary = Object.entries(report.browserMatrix)
      .map(([name, info]) => `${name}=${info.status}`)
      .join(", ");
    console.log(
      `PASS: M1 + M2 Release Multi-Browser & Negative-Case Gate [${engineSummary}] — ${report.screenshotsCount} screenshots saved to ${report.screenshotDir}`,
    );
    console.log(
      JSON.stringify({
        ok: report.ok,
        executedEnginesCount: report.executedEnginesCount,
        screenshotsCount: report.screenshotsCount,
        negativeCases: report.negativeCases,
        reportOut: args.reportOut,
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("RELEASE E2E GATE FAILED:", err);
    process.exit(1);
  });
}
