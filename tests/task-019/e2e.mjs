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

const screenshotDir = process.env.TASK019_SCREENSHOT_DIR || "/tmp/task-019-screenshots";

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

const SEED_OUTLETS = [
  {
    id: 1,
    name: "Gerai Jakarta Kemang",
    slug: "gerai-jakarta-kemang",
    address: "Jl. Kemang Raya No. 12",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    phone: "+62217191234",
    whatsappE164: "+6281234567891",
    mapsUrl: "https://evil.example/phish",
    directionsUrl: "https://evil.example/phish",
    mapEmbedUrl: "/same-origin-sandbox-escape",
    latitude: -6.2607,
    longitude: 106.8133,
    weeklyHours: [
      { day: "monday", open: "08:00", close: "21:00", closed: false },
      { day: "tuesday", open: "08:00", close: "21:00", closed: false },
      { day: "wednesday", open: "08:00", close: "21:00", closed: false },
      { day: "thursday", open: "08:00", close: "21:00", closed: false },
      { day: "friday", open: "08:00", close: "21:00", closed: false },
      { day: "saturday", open: "09:00", close: "22:00", closed: false },
      { day: "sunday", open: null, close: null, closed: true },
    ],
    holidayHours: [
      { date: "2026-08-17", label: "HUT RI", open: "10:00", close: "18:00", closed: false },
      { date: "2026-12-25", label: "Hari Natal", open: null, close: null, closed: true },
    ],
    weekdayHoursText: "Senin–Jumat 08:00–21:00; Sabtu 09:00–22:00; Minggu Tutup",
    holidayHoursText: "2026-08-17 HUT RI: 10:00–18:00; 2026-12-25 Hari Natal: Tutup",
    timezone: "Asia/Jakarta",
    sortOrder: 0,
    isPrimary: true,
    status: "published",
    active: true,
    version: 1,
    createdAt: "2026-11-23T08:00:00.000Z",
    updatedAt: "2026-11-23T08:00:00.000Z",
  },
  {
    id: 2,
    name: "Gerai Surabaya Darmo",
    slug: "gerai-surabaya-darmo",
    address: "Jl. Raya Darmo No. 45",
    city: "Surabaya",
    province: "Jawa Timur",
    postalCode: "60241",
    phone: null,
    whatsappE164: "+6281333445566",
    mapsUrl: null,
    directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=-7.2819,112.7381",
    mapEmbedUrl: "https://maps.google.com/maps?q=-7.2819,112.7381&z=15&output=embed",
    latitude: -7.2819,
    longitude: 112.7381,
    weeklyHours: [
      { day: "monday", open: "09:00", close: "21:00", closed: false },
      { day: "saturday", open: "10:00", close: "22:00", closed: false },
      { day: "sunday", open: "10:00", close: "20:00", closed: false },
    ],
    holidayHours: [],
    weekdayHoursText: "Senin 09:00–21:00; Sabtu 10:00–22:00; Minggu 10:00–20:00",
    holidayHoursText: null,
    timezone: "Asia/Jakarta",
    sortOrder: 1,
    isPrimary: false,
    status: "published",
    active: true,
    version: 1,
    createdAt: "2026-11-23T08:05:00.000Z",
    updatedAt: "2026-11-23T08:05:00.000Z",
  },
  {
    id: 3,
    name: "Gerai Rahasia Draf",
    slug: "gerai-rahasia-draf",
    address: "Jl. Senopati No. 99",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    phone: null,
    whatsappE164: null,
    mapsUrl: null,
    directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=-6.23,106.81",
    mapEmbedUrl: "https://maps.google.com/maps?q=-6.23,106.81&z=15&output=embed",
    latitude: -6.23,
    longitude: 106.81,
    weeklyHours: [],
    holidayHours: [],
    weekdayHoursText: null,
    holidayHoursText: null,
    timezone: "Asia/Jakarta",
    sortOrder: 2,
    isPrimary: false,
    status: "draft",
    active: true,
    version: 1,
    createdAt: "2026-11-23T08:10:00.000Z",
    updatedAt: "2026-11-23T08:10:00.000Z",
  },
];

async function buildTask019Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t019-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const outletsClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/outlets/_OutletsManagerClient.tsx",
  );
  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const sectionOutletsImport = path.join(
    webDir,
    "src/themes/default/sections/SectionOutlets.astro",
  );
  const sectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");

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

  const editorPermissions = `{
    role: "editor",
    roleLabel: "Editor",
    tenantStatus: "active",
    isLocked: false,
    canWriteContent: true,
    canPublishContent: true,
    canManageMedia: true,
    canUploadMedia: true,
    canManageMenus: true,
    canManageSettings: false,
  }`;

  const initialAdminData = JSON.stringify({
    items: SEED_OUTLETS.slice(0, 2),
    total: 2,
    maxOutlets: 10,
    remainingSlots: 8,
    primaryOutletId: 1,
  });

  const layoutProps = (title, roleLabel = "Pemilik Situs", lifecycleStatus = "active") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="Kopi Nusantara Roastery"
    workspaceSubtitle="kopi-nusantara.situsku.click"
    activeNavId="settings"
    basePath="/dashboard/kopi-nusantara"
    offeringLabel="Produk"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://kopi-nusantara.situsku.click"
    userDisplayName="Rina Kusuma"
    userRoleLabel=${JSON.stringify(roleLabel)}
  `;

  fs.writeFileSync(
    path.join(pagesDir, "outlets-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { OutletsManagerClient } from ${JSON.stringify(outletsClientImport)};
const initialData = ${initialAdminData};
---
<DashboardLayout ${layoutProps("Direktori Gerai — Kopi Nusantara Roastery")}>
  <OutletsManagerClient
    client:load
    handle="kopi-nusantara"
    basePath="/dashboard/kopi-nusantara"
    permissions={${ownerPermissions}}
    canManageOutlets={true}
    initialData={initialData}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "outlets-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { OutletsManagerClient } from ${JSON.stringify(outletsClientImport)};
const initialData = ${initialAdminData};
---
<DashboardLayout ${layoutProps("Direktori Gerai (Editor)", "Editor")}>
  <OutletsManagerClient
    client:load
    handle="kopi-nusantara"
    basePath="/dashboard/kopi-nusantara"
    permissions={${editorPermissions}}
    canManageOutlets={false}
    initialData={initialData}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "public-outlets.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import { mapOutletsToSchemaBranches } from "@punyasitus/db/outlets/index";
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionOutlets from ${JSON.stringify(sectionOutletsImport)};

const allOutlets = ${JSON.stringify(SEED_OUTLETS)};

const schemaResult = generateSchemaGraph({
  seo: {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    tenant: {
      tenantHandle: "kopi-nusantara",
      tenantStatus: "active",
      primaryHost: "kopinusantara.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["kopinusantara.id", "kopi-nusantara.situsku.click"],
    },
  },
  siteName: "Kopi Nusantara Roastery",
  siteTagline: "Kopi Spesialti & Gerai Nusantara",
  business: {
    businessName: "Kopi Nusantara Roastery",
    businessCategory: "LocalBusiness",
    address: "Jl. Jenderal Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    phone: "+62215550001",
    branches: mapOutletsToSchemaBranches(allOutlets),
  },
});

const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "resto",
  baseThemeId: "resto",
  themeStyle: {
    tokens: {},
    variants: {},
  },
  site: {
    title: "Kopi Nusantara Roastery",
    tagline: "Kopi Spesialti Indonesia",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Kopi Nusantara Roastery",
    category: "LocalBusiness",
    description: "Kedai kopi spesialti dan roastery nusantara.",
    address: "Jl. Jenderal Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    mapsUrl: "https://www.google.com/maps/dir/?api=1&destination=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 08:00–21:00 WIB",
    holidayHours: null,
    phone: "+62215550001",
    whatsappE164: "+628111000222",
    email: "halo@kopinusantara.id",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Direktori Gerai", href: "#outlets", openInNewTab: false, children: [] },
    ],
    footer: [],
    mobile: [],
  },
  page: { title: "Direktori Gerai" },
  outlets: allOutlets.filter((o) => o.active && o.status === "published"),
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
---
<PublicLayout shell={shell} pageTitle="Direktori Gerai" showConsent={true}>
  <Fragment slot="head">
    {schemaResult.jsonLd && (
      <script is:inline type="application/ld+json" set:html={schemaResult.jsonLd} />
    )}
  </Fragment>

  <SectionOutlets
    id="outlets"
    eyebrow="Direktori Gerai Resmi"
    heading="Temukan Gerai Kopi Nusantara"
    subheading="Alamat lengkap, jam buka mingguan, jadwal hari libur, serta petunjuk arah Google Maps."
    businessName="Kopi Nusantara Roastery"
    isFirstSection={true}
    outlets={allOutlets}
  />
</PublicLayout>`,
  );

  // Fixture WITHOUT Consent component to prove fail-closed behavior (zero synthetic consent!)
  fs.writeFileSync(
    path.join(pagesDir, "public-outlets-no-consent.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionOutlets from ${JSON.stringify(sectionOutletsImport)};

const allOutlets = ${JSON.stringify(SEED_OUTLETS)};
const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "resto",
  baseThemeId: "resto",
  themeStyle: { tokens: {}, variants: {} },
  site: {
    title: "Kopi Nusantara Roastery",
    tagline: "Kopi Spesialti Indonesia",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Kopi Nusantara Roastery",
    category: "LocalBusiness",
    description: null,
    address: "Jl. Jenderal Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    phone: "+62215550001",
    whatsappE164: null,
    email: null,
    socialLinks: [],
  },
  menus: { header: [], footer: [], mobile: [] },
  page: { title: "Direktori Gerai Tanpa Banner Izin" },
  outlets: allOutlets.filter((o) => o.active && o.status === "published"),
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
---
<PublicLayout shell={shell} pageTitle="Direktori Gerai (Tanpa Kontrol Izin)" showConsent={false}>
  <SectionOutlets
    id="outlets"
    heading="Temukan Gerai Kopi Nusantara"
    businessName="Kopi Nusantara Roastery"
    isFirstSection={true}
    outlets={allOutlets}
  />
</PublicLayout>`,
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

  return {
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
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startFixtureServer(outDir) {
  let nextId = 10;
  let outlets = SEED_OUTLETS.slice(0, 2).map((o) => ({ ...o }));
  let mapEmbedRequestCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();
    const json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/__test-map-embed") {
      mapEmbedRequestCount += 1;
      const slug = url.searchParams.get("outlet") || "outlet";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="id"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e8f3ee;color:#113a2d"><div>Peta Interaktif Dimuat (${slug})</div></body></html>`,
      );
      return;
    }

    if (url.pathname === "/api/tenants/kopi-nusantara/outlets" && method === "GET") {
      return json(200, {
        items: outlets,
        total: outlets.length,
        maxOutlets: 10,
        remainingSlots: Math.max(0, 10 - outlets.length),
        primaryOutletId: outlets.find((o) => o.isPrimary)?.id ?? null,
      });
    }

    if (url.pathname === "/api/tenants/kopi-nusantara/outlets" && method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      const lat = typeof body.latitude === "number" ? body.latitude : null;
      const lng = typeof body.longitude === "number" ? body.longitude : null;
      const created = {
        id: nextId++,
        name: body.name,
        slug: body.slug || "gerai-baru",
        address: body.address,
        city: body.city ?? null,
        province: body.province ?? null,
        postalCode: body.postalCode ?? null,
        phone: body.phone ?? null,
        whatsappE164: body.whatsappE164 ?? null,
        mapsUrl: body.mapsUrl ?? null,
        directionsUrl:
          lat !== null && lng !== null
            ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
            : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(body.address)}`,
        mapEmbedUrl:
          lat !== null && lng !== null
            ? `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`
            : null,
        latitude: lat,
        longitude: lng,
        weeklyHours: Array.isArray(body.weeklyHours) ? body.weeklyHours : [],
        holidayHours: Array.isArray(body.holidayHours) ? body.holidayHours : [],
        weekdayHoursText: "Senin–Sabtu 08:00–21:00; Minggu Tutup",
        holidayHoursText:
          Array.isArray(body.holidayHours) && body.holidayHours.length > 0
            ? body.holidayHours.map((h) => `${h.date} ${h.label}`).join("; ")
            : null,
        timezone: body.timezone || "Asia/Jakarta",
        sortOrder: body.sortOrder ?? outlets.length,
        isPrimary: Boolean(body.isPrimary),
        status: body.status === "draft" ? "draft" : "published",
        active: body.active !== false,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      outlets.push(created);
      return json(201, created);
    }

    const itemMatch = /^\/api\/tenants\/kopi-nusantara\/outlets\/(\d+)$/.exec(url.pathname);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      const existing = outlets.find((o) => o.id === id);
      if (!existing) {
        return json(404, { error: { code: "NOT_FOUND", message: "Gerai tidak ditemukan." } });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
        if (body.expectedVersion !== undefined && body.expectedVersion !== existing.version) {
          return json(409, {
            error: {
              code: "STALE_VERSION",
              message: "Data gerai telah diubah di sesi lain.",
            },
          });
        }
        const updated = {
          ...existing,
          ...body,
          version: existing.version + 1,
          updatedAt: new Date().toISOString(),
        };
        outlets = outlets.map((o) => (o.id === id ? updated : o));
        return json(200, updated);
      }
      if (method === "DELETE") {
        outlets = outlets.filter((o) => o.id !== id);
        return json(200, { deleted: true, id, totalRemaining: outlets.length });
      }
    }

    // Static files
    const reqPath = url.pathname === "/" ? "/public-outlets/index.html" : url.pathname;
    const candidates = [
      path.join(outDir, reqPath),
      path.join(outDir, reqPath, "index.html"),
      path.join(outDir, `${reqPath}.html`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        res.writeHead(200, { "Content-Type": getContentType(candidate) });
        fs.createReadStream(candidate).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    getMapEmbedRequestCount: () => mapEmbedRequestCount,
    resetMapEmbedRequestCount: () => {
      mapEmbedRequestCount = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${label}: horizontal overflow detected (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  );
}

async function assertMobileTouchTargets(page, label, selector) {
  const smallTargets = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    const bad = [];
    for (const el of els) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.height < 43.5) {
        bad.push({
          text: (el.textContent || "").trim().slice(0, 40),
          height: Math.round(rect.height),
        });
      }
    }
    return bad;
  }, selector);
  assert(
    smallTargets.length === 0,
    `${label}: touch targets < 44px found: ${JSON.stringify(smallTargets)}`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const built = await buildTask019Fixtures();
  const server = await startFixtureServer(built.outDir);

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Public SectionOutlets: Consent-Gated Map Embeds, Directions & JSON-LD
    // -----------------------------------------------------------------------
    for (const vp of [
      { name: "1440", width: 1440, height: 900 },
      { name: "360", width: 360, height: 780 },
    ]) {
      server.resetMapEmbedRequestCount();
      let googleMapsEmbedRequests = 0;
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      await page.route("https://maps.google.com/maps*", async (route) => {
        googleMapsEmbedRequests += 1;
        const reqUrl = new URL(route.request().url());
        const q = reqUrl.searchParams.get("q") || "outlet";
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html lang="id"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#e8f3ee;color:#113a2d"><div>Peta Google Maps Dimuat (${q})</div></body></html>`,
        });
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(`[public-${vp.name}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => pageErrors.push(`[public-${vp.name}] ${err.message}`));

      await page.goto(`${server.baseUrl}/public-outlets`, { waitUntil: "networkidle" });
      await assertNoOverflow(page, `public-${vp.name}-pre-consent`);

      // Only 2 published active outlets rendered (draft omitted!)
      const cards = await page.locator('[data-testid^="outlet-card-"]').count();
      assert(cards === 2, `Expected 2 published outlet cards at ${vp.name}, got ${cards}`);
      const draftCard = await page.locator('[data-testid="outlet-card-gerai-rahasia-draf"]').count();
      assert(draftCard === 0, "Draft outlet must NEVER render on public directory");

      // Hostile non-Google mapsUrl was rejected -> fell back to safe Google Maps directions URL
      const dirHref = await page
        .locator('[data-testid="outlet-directions-gerai-jakarta-kemang"]')
        .getAttribute("href");
      const dirRel = await page
        .locator('[data-testid="outlet-directions-gerai-jakarta-kemang"]')
        .getAttribute("rel");
      assert(
        dirHref === "https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133",
        `Unexpected directions href: ${dirHref}`,
      );
      assert(dirRel && dirRel.includes("noopener") && dirRel.includes("noreferrer"), "Directions link must have noopener noreferrer");

      // Hostile root-relative mapEmbedUrl was rejected -> fell back to strict Google Maps embed URL
      const kemangEmbedAttr = await page
        .locator('[data-testid="outlet-map-slot-gerai-jakarta-kemang"]')
        .getAttribute("data-map-embed-url");
      assert(
        kemangEmbedAttr === "https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed",
        `Expected strict Google Maps embed URL, got: ${kemangEmbedAttr}`,
      );

      // BEFORE consent: ZERO map iframes in DOM and ZERO map embed requests!
      const preIframes = await page.locator("iframe").count();
      assert(preIframes === 0, `Expected 0 iframes before consent, got ${preIframes}`);
      assert(
        googleMapsEmbedRequests === 0 && server.getMapEmbedRequestCount() === 0,
        `Expected 0 map embed requests before consent, got ${googleMapsEmbedRequests}`,
      );

      // Verify LocalBusiness JSON-LD matches visible published facts (REQ-054)
      const jsonLdText = await page.locator('script[type="application/ld+json"]').first().textContent();
      const parsed = JSON.parse(jsonLdText || "{}");
      const branchNodes = (parsed["@graph"] || []).filter(
        (n) => typeof n["@id"] === "string" && n["@id"].includes("#branch-"),
      );
      assert(branchNodes.length === 2, `Expected 2 JSON-LD branch nodes, got ${branchNodes.length}`);
      const kemangLd = branchNodes.find((n) => n.name === "Gerai Jakarta Kemang");
      assert(Boolean(kemangLd), "Missing Kemang LocalBusiness JSON-LD node");
      assert(kemangLd.telephone === "+62217191234", "JSON-LD telephone must match visible Kemang phone");
      assert(kemangLd.geo?.latitude === -6.2607 && kemangLd.geo?.longitude === 106.8133, "JSON-LD geo mismatch");
      assert(Array.isArray(kemangLd.openingHoursSpecification) && kemangLd.openingHoursSpecification.length === 6, "JSON-LD openingHoursSpecification mismatch");
      assert(kemangLd.openingHours === undefined, "JSON-LD must omit non-ISO openingHours string when openingHoursSpecification is present");
      assert(Array.isArray(kemangLd.specialOpeningHoursSpecification) && kemangLd.specialOpeningHoursSpecification.length === 2, "JSON-LD specialOpeningHoursSpecification mismatch");
      assert(!kemangLd.aggregateRating && !kemangLd.review, "JSON-LD must never fabricate ratings/reviews");
      const surabayaLd = branchNodes.find((n) => n.name === "Gerai Surabaya Darmo");
      assert(surabayaLd && surabayaLd.telephone === undefined, "WhatsApp-only outlet must not fabricate telephone");

      if (vp.name === "360") {
        await assertMobileTouchTargets(
          page,
          "public-360",
          '[data-ps-outlets-root] a.ps-btn, [data-ps-outlets-root] button',
        );
      }

      await page.screenshot({
        path: path.join(screenshotDir, `public-pre-consent-${vp.name}.png`),
        fullPage: true,
      });

      // GRANT maps consent via outlet consent button -> sandboxed iframes mount!
      await page.locator('[data-testid="outlet-enable-maps-gerai-jakarta-kemang"]').click();
      await page.waitForSelector('iframe[data-testid="outlet-map-iframe-gerai-jakarta-kemang"]');
      const postIframes = await page.locator("iframe[data-outlet-map-iframe]").count();
      assert(postIframes === 2, `Expected 2 sandboxed map iframes after consent, got ${postIframes}`);
      const kemangIframe = page.locator('iframe[data-testid="outlet-map-iframe-gerai-jakarta-kemang"]');
      const sandboxAttr = await kemangIframe.getAttribute("sandbox");
      const referrerPolicyAttr = await kemangIframe.getAttribute("referrerpolicy");
      const iframeSrc = await kemangIframe.getAttribute("src");
      assert(Boolean(sandboxAttr && sandboxAttr.includes("allow-scripts")), "Map iframe must be sandboxed");
      assert(referrerPolicyAttr === "no-referrer", `Expected referrerpolicy="no-referrer", got ${referrerPolicyAttr}`);
      assert(
        iframeSrc === "https://maps.google.com/maps?q=-6.2607,106.8133&z=15&output=embed",
        `Unexpected iframe src: ${iframeSrc}`,
      );
      assert(
        googleMapsEmbedRequests >= 1,
        "Strict Google Maps embed URL must be requested after maps consent",
      );

      await assertNoOverflow(page, `public-${vp.name}-post-consent`);
      await page.screenshot({
        path: path.join(screenshotDir, `public-post-consent-${vp.name}.png`),
        fullPage: true,
      });

      // WITHDRAW consent -> iframes immediately unmount!
      const withdrawBtn = page.locator('[data-testid="consent-withdraw-quick"]');
      if (await withdrawBtn.isVisible()) {
        await withdrawBtn.click();
        const afterWithdrawIframes = await page.locator("iframe[data-outlet-map-iframe]").count();
        assert(
          afterWithdrawIframes === 0,
          `Expected 0 iframes after consent withdrawal, got ${afterWithdrawIframes}`,
        );
      }

      await context.close();
    }

    // -----------------------------------------------------------------------
    // 1b. Fail-closed check: page WITHOUT Consent component must NEVER synthesize consent!
    // -----------------------------------------------------------------------
    {
      let noConsentMapRequests = 0;
      const ncCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const ncPage = await ncCtx.newPage();
      await ncPage.route("https://maps.google.com/maps*", async (route) => {
        noConsentMapRequests += 1;
        await route.abort();
      });
      ncPage.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(`[public-no-consent] ${msg.text()}`);
      });
      ncPage.on("pageerror", (err) => pageErrors.push(`[public-no-consent] ${err.message}`));

      await ncPage.goto(`${server.baseUrl}/public-outlets-no-consent`, { waitUntil: "networkidle" });
      await ncPage.locator('[data-testid="outlet-enable-maps-gerai-jakarta-kemang"]').click();
      const ncIframes = await ncPage.locator("iframe").count();
      assert(ncIframes === 0, `Expected 0 iframes when no consent control exists, got ${ncIframes}`);
      assert(noConsentMapRequests === 0, "Expected 0 map requests when no consent control exists");
      const synthConsent = await ncPage.evaluate(() => window.__punyasitusConsent?.maps === true);
      assert(!synthConsent, "Must NEVER synthesize window.__punyasitusConsent.maps = true");
      const statusText = await ncPage
        .locator('[data-testid="outlet-map-placeholder-gerai-jakarta-kemang"] [data-outlet-map-status]')
        .textContent();
      assert(
        statusText && statusText.includes("Petunjuk Arah"),
        `Expected helpful fail-closed status notice, got: ${statusText}`,
      );
      await ncCtx.close();
    }

    // -----------------------------------------------------------------------
    // 2. Dashboard Outlets CRUD (Owner 1440px & 360px) + Editor Read-Only
    // -----------------------------------------------------------------------
    const dashCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dashPage = await dashCtx.newPage();
    dashPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[dash-owner-1440] ${msg.text()}`);
    });
    dashPage.on("pageerror", (err) => pageErrors.push(`[dash-owner-1440] ${err.message}`));

    await dashPage.goto(`${server.baseUrl}/outlets-owner`, { waitUntil: "networkidle" });
    await dashPage.waitForSelector('[data-testid="outlets-manager-root"]');
    await assertNoOverflow(dashPage, "dash-owner-1440-initial");

    // Create new outlet with weekly hours, holiday hours & coordinates
    await dashPage.locator('[data-testid="outlets-add-btn"]').click();
    await dashPage.waitForSelector('[data-testid="outlet-editor-form"]');
    await dashPage.locator('[data-testid="outlet-input-name"]').fill("Gerai Bandung Braga");
    await dashPage.locator('[data-testid="outlet-input-address"]').fill("Jl. Braga No. 77");
    await dashPage.locator('[data-testid="outlet-input-city"]').fill("Bandung");
    await dashPage.locator('[data-testid="outlet-input-province"]').fill("Jawa Barat");
    await dashPage.locator('[data-testid="outlet-input-postalCode"]').fill("40111");
    await dashPage.locator('[data-testid="outlet-input-phone"]').fill("+62224201234");
    await dashPage.locator('[data-testid="outlet-input-whatsapp"]').fill("+6281555666777");
    await dashPage.locator('[data-testid="outlet-input-latitude"]').fill("-6.9175");
    await dashPage.locator('[data-testid="outlet-input-longitude"]').fill("107.6095");

    // Directions preview updates live!
    const previewText = await dashPage.locator('[data-testid="outlet-directions-preview"]').textContent();
    assert(
      previewText && previewText.includes("https://www.google.com/maps/dir/?api=1&destination=-6.9175,107.6095"),
      `Directions preview missing coordinates URL: ${previewText}`,
    );

    // Add holiday entry
    await dashPage.locator('[data-testid="outlet-add-holiday-btn"]').click();
    await dashPage.locator('[data-testid="holiday-date-0"]').fill("2026-12-25");
    await dashPage.locator('[data-testid="holiday-label-0"]').fill("Hari Natal");

    await dashPage.screenshot({
      path: path.join(screenshotDir, "dashboard-owner-form-1440.png"),
      fullPage: true,
    });

    await dashPage.locator('[data-testid="outlet-save-btn"]').click();
    await dashPage.waitForSelector('[data-testid="outlets-success-banner"]');
    const countAfterCreate = await dashPage.locator('[data-testid^="outlet-admin-card-"]').count();
    assert(countAfterCreate === 3, `Expected 3 outlet cards after create, got ${countAfterCreate}`);

    // Edit newly created outlet
    await dashPage.locator('[data-testid="outlet-edit-btn-10"]').click();
    await dashPage.locator('[data-testid="outlet-input-name"]').fill("Gerai Bandung Braga Utama");
    await dashPage.locator('[data-testid="outlet-save-btn"]').click();
    await dashPage.waitForSelector('[data-testid="outlets-success-banner"]');
    const editedCardText = await dashPage.locator('[data-testid="outlet-admin-card-10"]').textContent();
    assert(
      editedCardText && editedCardText.includes("Gerai Bandung Braga Utama"),
      "Edited outlet name did not update in list",
    );

    // Delete outlet with confirmation dialog
    await dashPage.locator('[data-testid="outlet-delete-btn-10"]').click();
    await dashPage.getByRole("button", { name: "Ya, Hapus Gerai" }).click();
    await dashPage.waitForSelector('[data-testid="outlets-success-banner"]');
    const countAfterDelete = await dashPage.locator('[data-testid^="outlet-admin-card-"]').count();
    assert(countAfterDelete === 2, `Expected 2 outlet cards after delete, got ${countAfterDelete}`);

    await dashPage.screenshot({
      path: path.join(screenshotDir, "dashboard-owner-list-1440.png"),
      fullPage: true,
    });

    // Check mobile 360px dashboard responsiveness & >=44px touch targets
    await dashPage.setViewportSize({ width: 360, height: 780 });
    await assertNoOverflow(dashPage, "dash-owner-360");
    await assertMobileTouchTargets(
      dashPage,
      "dash-owner-360",
      '[data-testid="outlets-manager-root"] button, [data-testid="outlets-manager-root"] a',
    );
    await dashPage.screenshot({
      path: path.join(screenshotDir, "dashboard-owner-list-360.png"),
      fullPage: true,
    });

    // Check Editor read-only view
    await dashPage.setViewportSize({ width: 1440, height: 900 });
    await dashPage.goto(`${server.baseUrl}/outlets-editor`, { waitUntil: "networkidle" });
    await dashPage.waitForSelector('[data-testid="outlets-readonly-banner"]');
    const editorAddCount = await dashPage.locator('[data-testid="outlets-add-btn"]').count();
    assert(editorAddCount === 0, "Read-only editor must not see Add Outlet button");
    await assertNoOverflow(dashPage, "dash-editor-1440");
    await dashPage.screenshot({
      path: path.join(screenshotDir, "dashboard-editor-readonly-1440.png"),
      fullPage: true,
    });

    await dashCtx.close();

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join(" | ")}`);

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-019",
        screenshotsDir: screenshotDir,
        screenshots: fs.readdirSync(screenshotDir).sort(),
      }),
    );
  } finally {
    await browser.close();
    await server.close();
    built.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
