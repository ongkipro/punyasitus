/* global process, console, document, URL, Buffer */
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

const screenshotDir = process.env.TASK088_SCREENSHOT_DIR || "/tmp/task-088-screenshots";

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

const SEED_BRANCHES = [
  {
    id: 1,
    name: "Cabang Jakarta Kemang",
    address: "Jl. Kemang Raya No. 12",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    phone: "62217191234",
    whatsappE164: "6281234567891",
    whatsappNumber: "6281234567891",
    mapsUrl: "https://maps.google.com/?q=-6.2607,106.8133",
    latitude: -6.2607,
    longitude: 106.8133,
    weekdayHours: "Senin–Jumat 08.00–21.00 WIB",
    holidayHours: "Sabtu–Minggu 09.00–22.00 WIB",
    openingHours: {
      weekday: "Senin–Jumat 08.00–21.00 WIB",
      holiday: "Sabtu–Minggu 09.00–22.00 WIB",
    },
    timezone: "Asia/Jakarta",
    sortOrder: 0,
    isPrimary: true,
    active: true,
    version: 1,
    createdAt: "2026-11-20T08:00:00.000Z",
    updatedAt: "2026-11-20T08:00:00.000Z",
  },
  {
    id: 2,
    name: "Cabang Surabaya Darmo",
    address: "Jl. Raya Darmo No. 45",
    city: "Surabaya",
    province: "Jawa Timur",
    postalCode: "60241",
    phone: "62315551234",
    whatsappE164: "6281333445566",
    whatsappNumber: "6281333445566",
    mapsUrl: "https://maps.google.com/?q=-7.2819,112.7381",
    latitude: -7.2819,
    longitude: 112.7381,
    weekdayHours: "Senin–Jumat 09.00–21.00 WIB",
    holidayHours: "Sabtu–Minggu 10.00–22.00 WIB",
    openingHours: {
      weekday: "Senin–Jumat 09.00–21.00 WIB",
      holiday: "Sabtu–Minggu 10.00–22.00 WIB",
    },
    timezone: "Asia/Jakarta",
    sortOrder: 1,
    isPrimary: false,
    active: true,
    version: 1,
    createdAt: "2026-11-20T08:05:00.000Z",
    updatedAt: "2026-11-20T08:05:00.000Z",
  },
  {
    id: 3,
    name: "Cabang Bali Denpasar",
    address: "Jl. Sunset Road No. 88",
    city: "Denpasar",
    province: "Bali",
    postalCode: "80361",
    phone: null,
    whatsappE164: "6281999887766",
    whatsappNumber: "6281999887766",
    mapsUrl: null,
    latitude: -8.6905,
    longitude: 115.1749,
    weekdayHours: "Senin–Minggu 08.00–22.00 WITA",
    holidayHours: null,
    openingHours: {
      weekday: "Senin–Minggu 08.00–22.00 WITA",
      holiday: null,
    },
    timezone: "Asia/Makassar",
    sortOrder: 2,
    isPrimary: false,
    active: true,
    version: 1,
    createdAt: "2026-11-20T08:10:00.000Z",
    updatedAt: "2026-11-20T08:10:00.000Z",
  },
];

async function buildTask088Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t088-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const branchesClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/settings/branches/_BranchesSettingsClient.tsx",
  );
  const publicLayoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const sectionBranchesImport = path.join(
    webDir,
    "src/themes/default/sections/SectionBranches.astro",
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

  const lockedPermissions = `{
    role: "owner",
    roleLabel: "Pemilik Situs",
    tenantStatus: "locked",
    isLocked: true,
    canWriteContent: false,
    canPublishContent: false,
    canManageMedia: false,
    canUploadMedia: false,
    canManageMenus: false,
    canManageSettings: false,
  }`;

  const initialAdminData = JSON.stringify({
    items: SEED_BRANCHES,
    total: SEED_BRANCHES.length,
    maxBranches: 10,
    remainingSlots: 7,
    primaryBranchId: 1,
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
    path.join(pagesDir, "branches-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { BranchesSettingsClient } from ${JSON.stringify(branchesClientImport)};
const initialData = ${initialAdminData};
---
<DashboardLayout ${layoutProps("Lokasi & Cabang — Kopi Nusantara Roastery")}>
  <BranchesSettingsClient
    client:load
    handle="kopi-nusantara"
    basePath="/dashboard/kopi-nusantara"
    permissions={${ownerPermissions}}
    canManageBranches={true}
    initialData={initialData}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "branches-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { BranchesSettingsClient } from ${JSON.stringify(branchesClientImport)};
const initialData = ${initialAdminData};
---
<DashboardLayout ${layoutProps("Lokasi & Cabang (Editor)", "Editor")}>
  <BranchesSettingsClient
    client:load
    handle="kopi-nusantara"
    basePath="/dashboard/kopi-nusantara"
    permissions={${editorPermissions}}
    canManageBranches={false}
    initialData={initialData}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "branches-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { BranchesSettingsClient } from ${JSON.stringify(branchesClientImport)};
const initialData = ${initialAdminData};
---
<DashboardLayout ${layoutProps("Lokasi & Cabang (Terkunci)", "Pemilik Situs", "locked")}>
  <BranchesSettingsClient
    client:load
    handle="kopi-nusantara"
    basePath="/dashboard/kopi-nusantara"
    permissions={${lockedPermissions}}
    canManageBranches={false}
    initialData={initialData}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "public-branches.astro"),
    `---
import ${JSON.stringify(sectionsCssImport)};
import { mapBranchesToSchemaInput } from "@punyasitus/core/branches/index";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import PublicLayout from ${JSON.stringify(publicLayoutImport)};
import SectionBranches from ${JSON.stringify(sectionBranchesImport)};

const branches = ${JSON.stringify(SEED_BRANCHES)};

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
  siteTagline: "Kopi Spesialti Indonesia di Jakarta, Surabaya & Bali",
  business: {
    businessName: "Kopi Nusantara Roastery",
    businessCategory: "cafe",
    address: "Jl. Jenderal Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    phone: "62215550001",
    whatsappE164: "628111000222",
    mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 07.30–20.00 WIB",
    holidayHours: "Sabtu 08.30–17.00 WIB",
    branches: mapBranchesToSchemaInput(branches),
  },
});

const shell = {
  tenantId: "01JT088E2E0000000000000001",
  handle: "kopi-nusantara",
  primaryOrigin: "https://kopinusantara.id",
  themeId: "resto",
  layoutMode: "standard",
  themeStyle: {
    tokens: {},
    variants: {},
  },
  site: {
    title: "Kopi Nusantara Roastery",
    tagline: "Kopi Spesialti Indonesia",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
  },
  business: {
    name: "Kopi Nusantara Roastery",
    category: "cafe",
    description: "Kedai kopi spesialti dan roastery nusantara.",
    address: "Jl. Jenderal Sudirman No. 1",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    phone: "62215550001",
    whatsappE164: "628111000222",
    email: "halo@kopinusantara.id",
    mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 07.30–20.00 WIB",
    holidayHours: "Sabtu 08.30–17.00 WIB",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Lokasi & Cabang", href: "#branches", openInNewTab: false, children: [] },
    ],
    footer: [],
    mobile: [],
  },
  page: {
    title: "Lokasi & Cabang",
  },
  branding: {
    showPlatformBadge: false,
    affiliateRefCode: null,
  },
};
---
<PublicLayout shell={shell} pageTitle="Lokasi & Cabang" showConsent={false}>
  <Fragment slot="head">
    {schemaResult.jsonLd && (
      <script is:inline type="application/ld+json" set:html={schemaResult.jsonLd} />
    )}
  </Fragment>

  <SectionBranches
    id="branches"
    eyebrow="Jaringan Outlet Resmi"
    heading="Lokasi & Cabang Kopi Nusantara"
    subheading="Kunjungi kantor pusat atau outlet terdekat kami. Semua tautan peta dan WhatsApp cabang siap digunakan tanpa skrip pihak ketiga."
    businessName="Kopi Nusantara Roastery"
    isFirstSection={true}
    headOffice={{
      name: "Kantor Pusat & Roastery Sudirman",
      address: "Jl. Jenderal Sudirman No. 1",
      city: "Jakarta Pusat",
      province: "DKI Jakarta",
      postalCode: "10220",
      phone: "62215550001",
      whatsappE164: "628111000222",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      weekdayHours: "Senin–Jumat 07.30–20.00 WIB",
      holidayHours: "Sabtu 08.30–17.00 WIB",
      timezone: "Asia/Jakarta",
    }}
    branches={branches}
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
  let nextId = 4;
  let branches = SEED_BRANCHES.map((b) => ({ ...b }));

  const sortList = (list) =>
    [...list].sort((a, b) => {
      const p = Number(b.isPrimary) - Number(a.isPrimary);
      if (p !== 0) return p;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.id - b.id;
    });

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

    if (url.pathname === "/api/tenants/kopi-nusantara/branches" && method === "GET") {
      const sorted = sortList(branches);
      return json(200, {
        items: sorted,
        total: sorted.length,
        maxBranches: 10,
        remainingSlots: Math.max(0, 10 - sorted.length),
        primaryBranchId: sorted.find((b) => b.isPrimary)?.id ?? null,
      });
    }

    if (url.pathname === "/api/tenants/kopi-nusantara/branches" && method === "POST") {
      if (branches.length >= 10) {
        return json(422, {
          error: {
            code: "VALIDATION_ERROR",
            message: "Maksimal 10 cabang per situs telah tercapai.",
            fields: [{ field: "branches", code: "BRANCH_LIMIT_REACHED", message: "Maksimal 10 cabang." }],
          },
          requestId: "req_limit",
        });
      }
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      if (body.isPrimary) {
        branches = branches.map((b) => ({ ...b, isPrimary: false }));
      }
      const normalizedWa = body.whatsappNumber
        ? String(body.whatsappNumber).replace(/[\s()-]/g, "").replace(/^08/, "628").replace(/^\+/, "")
        : null;
      const created = {
        id: nextId++,
        name: body.name,
        address: body.address,
        city: body.city ?? null,
        province: body.province ?? null,
        postalCode: body.postalCode ?? null,
        phone: body.phone ? String(body.phone).replace(/[\s()-]/g, "").replace(/^0/, "62").replace(/^\+/, "") : null,
        whatsappE164: normalizedWa,
        whatsappNumber: normalizedWa,
        mapsUrl: body.mapsUrl ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        weekdayHours: body.weekdayHours ?? null,
        holidayHours: body.holidayHours ?? null,
        openingHours:
          body.weekdayHours || body.holidayHours
            ? { weekday: body.weekdayHours ?? null, holiday: body.holidayHours ?? null }
            : null,
        timezone: body.timezone || "Asia/Jakarta",
        sortOrder: branches.length,
        isPrimary: Boolean(body.isPrimary),
        active: body.active !== false,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      branches.push(created);
      return json(201, created);
    }

    if (url.pathname === "/api/tenants/kopi-nusantara/branches/reorder" && method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      const orderMap = new Map(body.branchIds.map((id, idx) => [id, idx]));
      branches = branches.map((b) => ({
        ...b,
        sortOrder: orderMap.get(b.id) ?? b.sortOrder,
        version: b.version + 1,
      }));
      const sorted = sortList(branches);
      return json(200, {
        items: sorted,
        total: sorted.length,
        maxBranches: 10,
        remainingSlots: Math.max(0, 10 - sorted.length),
        primaryBranchId: sorted.find((b) => b.isPrimary)?.id ?? null,
      });
    }

    const itemMatch = /^\/api\/tenants\/kopi-nusantara\/branches\/(\d+)$/.exec(url.pathname);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      const existing = branches.find((b) => b.id === id);
      if (!existing) {
        return json(404, { error: { code: "NOT_FOUND", message: "Cabang tidak ditemukan." }, requestId: "req_404" });
      }
      if (method === "PATCH" || method === "PUT") {
        const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
        if (body.expectedVersion !== undefined && body.expectedVersion !== existing.version) {
          return json(409, {
            error: {
              code: "STALE_VERSION",
              message: "Data cabang telah diubah di sesi lain.",
            },
            requestId: "req_409",
          });
        }
        if (body.isPrimary) {
          branches = branches.map((b) =>
            b.id !== id && b.isPrimary ? { ...b, isPrimary: false, version: b.version + 1 } : b,
          );
        }
        const updated = {
          ...existing,
          ...body,
          version: existing.version + 1,
          updatedAt: new Date().toISOString(),
        };
        branches = branches.map((b) => (b.id === id ? updated : b));
        return json(200, updated);
      }
      if (method === "DELETE") {
        branches = branches.filter((b) => b.id !== id);
        return json(200, { deleted: true, id, totalRemaining: branches.length });
      }
    }

    // Serve static built Astro fixtures
    let relPath = url.pathname === "/" ? "/branches-owner/index.html" : url.pathname;
    if (!path.extname(relPath)) {
      relPath = path.join(relPath, "index.html");
    }
    const candidate = path.join(outDir, relPath);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      res.writeHead(200, { "Content-Type": getContentType(candidate) });
      fs.createReadStream(candidate).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertZeroHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth,
    `${label}: horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth})`,
  );
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const fixtures = await buildTask088Fixtures();
  const server = await startFixtureServer(fixtures.outDir);

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Public `SectionBranches.astro` & Schema.org `@graph` with ZERO JS!
    // -----------------------------------------------------------------------
    const noJsContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const externalRequests = [];
    noJsContext.on("request", (req) => {
      if (!req.url().startsWith(server.baseUrl)) {
        externalRequests.push(req.url());
      }
    });

    const publicPage = await noJsContext.newPage();
    await publicPage.goto(`${server.baseUrl}/public-branches`, { waitUntil: "networkidle" });

    // Zero third-party network requests & zero map iframes before consent!
    assert(
      externalRequests.length === 0,
      `Expected zero third-party requests without consent, got: ${externalRequests.join(", ")}`,
    );
    const iframeCount = await publicPage.locator("iframe").count();
    assert(iframeCount === 0, `Expected 0 map iframes on public branch page, got ${iframeCount}`);

    // Verify branch cards, tel:, wa.me, and static Google Maps links render WITHOUT JS!
    const headOfficeVisible = await publicPage.getByTestId("branch-head-office-card").isVisible();
    assert(headOfficeVisible, "Head office card must be visible");

    const card1 = publicPage.getByTestId("branch-card-1");
    assert(await card1.isVisible(), "Branch #1 card must be visible");
    assert(
      (await card1.locator('[data-branch-action="whatsapp"]').getAttribute("href"))?.startsWith(
        "https://wa.me/6281234567891?text=",
      ),
      "Branch #1 WhatsApp link must point to branch WA number",
    );
    assert(
      (await card1.locator('[data-branch-action="call"]').getAttribute("href")) ===
        "tel:+62217191234",
      "Branch #1 call link must use tel:+62...",
    );
    assert(
      (await card1.locator('[data-branch-action="maps"]').getAttribute("href")) ===
        "https://maps.google.com/?q=-6.2607,106.8133",
      "Branch #1 maps link must be static HTTPS URL",
    );
    assert(
      (await card1.locator('[data-branch-action="maps"]').getAttribute("rel")) ===
        "noopener noreferrer",
      "Branch #1 maps link must carry rel=noopener noreferrer",
    );

    // Branch #3 has coordinates only -> falls back to static Google Maps search URL without JS!
    const card3MapsHref = await publicPage
      .getByTestId("branch-card-3")
      .locator('[data-branch-action="maps"]')
      .getAttribute("href");
    assert(
      card3MapsHref === "https://www.google.com/maps/search/?api=1&query=-8.6905%2C115.1749",
      `Branch #3 coordinate fallback maps link mismatch: ${card3MapsHref}`,
    );

    // Parse Schema.org `@graph` directly from rendered HTML DOM and verify 1:1 visible-fact parity!
    const jsonLdRaw = await publicPage
      .locator('script[type="application/ld+json"]')
      .first()
      .textContent();
    assert(Boolean(jsonLdRaw), "Public page must emit JSON-LD script tag");
    const graphDoc = JSON.parse(jsonLdRaw);
    assert(graphDoc["@context"] === "https://schema.org", "Schema context must be https://schema.org");

    const orgNode = graphDoc["@graph"].find(
      (n) => n["@id"] === "https://kopinusantara.id/#organization",
    );
    assert(orgNode?.["@type"] === "CafeOrCoffeeShop", "Parent org must be CafeOrCoffeeShop");
    assert(orgNode?.subOrganization?.length === 3, "Parent org must link all 3 active branches");

    const branch1Node = graphDoc["@graph"].find(
      (n) => n["@id"] === "https://kopinusantara.id/#branch-1",
    );
    assert(branch1Node?.["@type"] === "CafeOrCoffeeShop", "Branch node must match parent subtype");
    assert(branch1Node?.name === "Cabang Jakarta Kemang", "Branch #1 schema name must match visible card");
    assert(
      branch1Node?.address?.streetAddress === "Jl. Kemang Raya No. 12",
      "Branch #1 streetAddress must match visible card",
    );
    assert(
      branch1Node?.openingHours?.[0] === "Senin–Jumat 08.00–21.00 WIB",
      "Branch #1 weekday hours must match visible card",
    );
    assert(branch1Node?.aggregateRating === undefined, "Zero fabricated aggregateRating");
    assert(branch1Node?.review === undefined, "Zero fabricated review");

    await assertZeroHorizontalOverflow(publicPage, "public-branches 1440px");
    await publicPage.screenshot({
      path: path.join(screenshotDir, "public-branches-1440.png"),
      fullPage: true,
    });

    await publicPage.setViewportSize({ width: 360, height: 800 });
    await assertZeroHorizontalOverflow(publicPage, "public-branches 360px");
    await publicPage.screenshot({
      path: path.join(screenshotDir, "public-branches-360.png"),
      fullPage: true,
    });
    await noJsContext.close();

    // -----------------------------------------------------------------------
    // 2. Admin Branches Settings (Owner CRUD, Primary Switch, Reorder, Delete)
    // -----------------------------------------------------------------------
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    adminPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    adminPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await adminPage.goto(`${server.baseUrl}/branches-owner`, { waitUntil: "networkidle" });
    await adminPage.getByTestId("branches-quota-badge").waitFor({ state: "visible" });
    assert(
      (await adminPage.getByTestId("branches-quota-badge").textContent())?.includes("3 / 10 Cabang"),
      "Initial quota badge should read 3 / 10 Cabang",
    );

    // Create a 4th branch via UI
    await adminPage.getByTestId("add-branch-button").click();
    await adminPage.getByTestId("branch-input-name").fill("Cabang Bandung Braga");
    await adminPage.getByTestId("branch-input-address").fill("Jl. Braga No. 18");
    await adminPage.getByTestId("branch-input-city").fill("Bandung");
    await adminPage.getByTestId("branch-input-province").fill("Jawa Barat");
    await adminPage.getByTestId("branch-input-postal").fill("40111");
    await adminPage.getByTestId("branch-input-phone").fill("022-4201234");
    await adminPage.getByTestId("branch-input-whatsapp").fill("0812-2233-4455");
    await adminPage.getByTestId("branch-input-maps-url").fill("https://maps.google.com/?q=-6.9175,107.6091");
    await adminPage.getByTestId("branch-input-weekday-hours").fill("Senin–Jumat 08.00–21.00 WIB");
    await adminPage.getByTestId("branch-submit-button").click();

    await adminPage.getByTestId("admin-branch-card-4").waitFor({ state: "visible" });
    assert(
      (await adminPage.getByTestId("branches-quota-badge").textContent())?.includes("4 / 10 Cabang"),
      "Quota badge should update to 4 / 10 Cabang after create",
    );

    // Promote branch #2 to primary via UI
    await adminPage.getByTestId("branch-set-primary-2").click();
    await adminPage.getByTestId("branch-primary-badge-2").waitFor({ state: "visible" });
    assert(
      (await adminPage.getByTestId("branch-primary-badge-1").count()) === 0,
      "Previous primary badge on #1 must disappear after promoting #2",
    );

    await assertZeroHorizontalOverflow(adminPage, "admin-branches-owner 1440px");
    await adminPage.screenshot({
      path: path.join(screenshotDir, "admin-branches-owner-1440.png"),
      fullPage: true,
    });

    // Narrow 360px check + screenshot
    await adminPage.setViewportSize({ width: 360, height: 800 });
    await assertZeroHorizontalOverflow(adminPage, "admin-branches-owner 360px");
    await adminPage.screenshot({
      path: path.join(screenshotDir, "admin-branches-owner-360.png"),
      fullPage: true,
    });

    // Delete branch #4 via Base UI ConfirmDestructiveDialog
    await adminPage.setViewportSize({ width: 1440, height: 900 });
    await adminPage.getByTestId("branch-delete-4").click();
    await adminPage.getByRole("button", { name: "Ya, Hapus Cabang" }).click();
    await adminPage.getByTestId("admin-branch-card-4").waitFor({ state: "detached" });
    assert(
      (await adminPage.getByTestId("branches-quota-badge").textContent())?.includes("3 / 10 Cabang"),
      "Quota badge should return to 3 / 10 Cabang after delete",
    );

    // -----------------------------------------------------------------------
    // 3. Editor Read-Only & Locked Tenant Views
    // -----------------------------------------------------------------------
    await adminPage.goto(`${server.baseUrl}/branches-editor`, { waitUntil: "networkidle" });
    await adminPage.getByTestId("branches-editor-readonly-banner").waitFor({ state: "visible" });
    assert(
      (await adminPage.getByTestId("add-branch-button").count()) === 0,
      "Editor must not see Add Branch button",
    );
    assert(
      (await adminPage.getByTestId("branch-delete-1").count()) === 0,
      "Editor must not see Delete Branch button",
    );
    await assertZeroHorizontalOverflow(adminPage, "admin-branches-editor 1440px");
    await adminPage.screenshot({
      path: path.join(screenshotDir, "admin-branches-editor-readonly-1440.png"),
      fullPage: true,
    });

    await adminPage.goto(`${server.baseUrl}/branches-locked`, { waitUntil: "networkidle" });
    assert(
      (await adminPage.getByTestId("add-branch-button").count()) === 0,
      "Locked tenant must not see Add Branch button",
    );
    await assertZeroHorizontalOverflow(adminPage, "admin-branches-locked 1440px");

    await adminContext.close();

    assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Page errors: ${pageErrors.join(" | ")}`);

    console.log("TASK-088 E2E PASSED — Screenshots saved to:", screenshotDir);
  } finally {
    await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
