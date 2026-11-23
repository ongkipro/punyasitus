/* global Buffer, process, console, document, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * TASK-102 Playwright Chromium E2E Visual & Functional Verification (`360px` & `1440px`):
 * - (a) Base Page editor with `seo-ai-autopilot` DISABLED (ZERO SEO form fields!) vs
 *       ENABLED (single collapsed optional override drawer until clicked).
 * - (b) Plugin storefront 1-click `Pasang (Gratis)` / `Nonaktifkan` for `seo-ai-autopilot`.
 * - (c) `/dashboard/[handle]/plugins/seo-ai-autopilot` settings screen (1-click toggle,
 *       zero-config summary, GBP + Bing Places copy card) + AI Crawler split view.
 * - Verifies zero console/page errors, zero horizontal overflow, >= 44px mobile touch targets,
 *   and saves screenshots to `/tmp/task-102-screenshots/`.
 */

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK102_SCREENSHOT_DIR || "/tmp/task-102-screenshots";
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

const DEFAULT_TEMPLATES = {
  homepage: {
    titleTemplate: "{{site_name}} {{sep}} {{tagline}}",
    descriptionTemplate: "{{excerpt}}",
  },
  page: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_item: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post_category: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post_tag: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_category: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  blog_index: {
    titleTemplate: "Blog {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_index: {
    titleTemplate: "Katalog {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
};

function buildSeoSettingsFixture() {
  return {
    tenantId: "01JT102E2ETENANT0000000001",
    handle: "nusantara-arsitek",
    siteName: "PT Nusantara Arsitek",
    tagline: "Desain & Renovasi Kantor Modern",
    primaryHost: "www.nusantara-arsitek.id",
    primaryOrigin: "https://www.nusantara-arsitek.id",
    tenantStatus: "active",
    siteVisibility: "public",
    aiTrainingPolicy: "disallow",
    seoAutopilotEnabled: true,
    draft: {
      searchAppearance: {
        separator: "|",
        templates: DEFAULT_TEMPLATES,
      },
      verificationTokens: {
        google: null,
        bing: null,
        yandex: null,
      },
    },
    hasUnpublishedChanges: false,
    version: 1,
    publishedAt: "2026-11-23T08:00:00.000Z",
    verificationStatuses: [
      {
        provider: "google",
        label: "Google Search Console",
        metaName: "google-site-verification",
        token: null,
        publishedToken: null,
        metaTagPreview: null,
        status: "not_configured",
        statusLabel: "Belum dikonfigurasi",
        helperText: "Opsional: masukkan token polos dari Google Search Console.",
        externalVerification: null,
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: false,
      },
      {
        provider: "bing",
        label: "Bing Webmaster Tools",
        metaName: "msvalidate.01",
        token: null,
        publishedToken: null,
        metaTagPreview: null,
        status: "not_configured",
        statusLabel: "Belum dikonfigurasi",
        helperText: "Opsional: masukkan token polos dari Bing Webmaster Tools.",
        externalVerification: null,
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: false,
      },
      {
        provider: "yandex",
        label: "Yandex Webmaster (Opsional)",
        metaName: "yandex-verification",
        token: null,
        publishedToken: null,
        metaTagPreview: null,
        status: "not_configured",
        statusLabel: "Belum dikonfigurasi",
        helperText: "Opsional untuk target pasar tertentu.",
        externalVerification: null,
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: false,
      },
    ],
    sitemapUrl: "https://www.nusantara-arsitek.id/sitemap.xml",
    directoryListingCopyText: [
      "Nama Bisnis: PT Nusantara Arsitek",
      "Situs Web: https://www.nusantara-arsitek.id",
      "Kategori: HomeAndConstructionBusiness",
      "Alamat Publik: Jl. Kemang Raya No. 18, Jakarta Selatan, DKI Jakarta",
      "WhatsApp: +6281234567890",
      "Jam Operasional: Senin–Jumat 08.00–17.00 WIB",
    ].join("\n"),
  };
}

function buildAiVisibilityFixture() {
  return {
    tenantId: "01JT102E2ETENANT0000000001",
    handle: "nusantara-arsitek",
    tenantName: "PT Nusantara Arsitek",
    vertical: "compro",
    tenantStatus: "active",
    primaryHost: "www.nusantara-arsitek.id",
    primaryHostKind: "custom",
    saasZone: "situsku.click",
    siteVisibility: "public",
    aiTrainingPolicy: "allow",
    robotsIndexable: true,
    robotsTxt: [
      "User-agent: Googlebot",
      "Allow: /",
      "",
      "User-agent: OAI-SearchBot",
      "Allow: /",
      "",
      "User-agent: GPTBot",
      "Allow: /",
      "",
      "Sitemap: https://www.nusantara-arsitek.id/sitemap.xml",
    ].join("\n"),
    indexnowEligible: true,
    indexnowStatusBadge: "Aktif Otomatis",
    indexnowKeyLocation: "https://www.nusantara-arsitek.id/a1b2c3d4e5f60718293a4b5c6d7e8f90.txt",
    indexnowLastPingAtMs: null,
    indexnowLastUrlCount: 0,
    channels: [
      { channel: "organic_search", label: "Pencarian Organik", visits: 120, waClicks: 18, leads: 5, totalSignals: 143, sharePercent: 58.6 },
      { channel: "ai_assistant", label: "AI Assistant", visits: 42, waClicks: 9, leads: 3, totalSignals: 54, sharePercent: 22.1 },
      { channel: "direct", label: "Langsung / Lainnya", visits: 41, waClicks: 5, leads: 1, totalSignals: 47, sharePercent: 19.3 },
    ],
  };
}

async function buildTask102Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t102-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const pageEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/pages/_PageEditorClient.tsx",
  );
  const pluginStorefrontImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/plugins/_PluginStorefrontClient.tsx",
  );
  const seoSettingsImport = path.join(
    webDir,
    "src/components/admin/seo/SeoAutopilotSettingsClient.tsx",
  );
  const seoVisibilityImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/seo/_SeoVisibilityManager.tsx",
  );

  const layoutProps = (title, activeNavId = "plugins") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="www.nusantara-arsitek.id"
    activeNavId=${JSON.stringify(activeNavId)}
    basePath="/dashboard/nusantara-arsitek"
    offeringLabel="Layanan"
    lifecycleStatus="active"
    publicSiteHref="https://www.nusantara-arsitek.id"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  const editorProps = (seoEnabled) => `
    client:only="react"
    handle="nusantara-arsitek"
    basePath="/dashboard/nusantara-arsitek"
    siteName="PT Nusantara Arsitek"
    primaryHost="www.nusantara-arsitek.id"
    siteVisibility="public"
    seoAutopilotEnabled={${seoEnabled ? "true" : "false"}}
    permissions={{
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
    }}
    initialPage={{
      id: 7,
      title: "Layanan Renovasi Kantor",
      slug: "layanan-renovasi-kantor",
      status: "published",
      isHomepage: false,
      layoutMode: "standard",
      sections: [
        {
          id: "sec_1",
          kind: "hero",
          heading: "Layanan Renovasi Kantor Modern",
          subheading: "Tim arsitek profesional menangani desain dan konstruksi ruang kerja.",
        },
      ],
      seo: {},
      version: 2,
      updatedAt: "2026-11-23T06:00:00.000Z",
      publishedAt: "2026-11-23T06:00:00.000Z",
    }}
  `;

  // 1. Base Page Editor with seo-ai-autopilot DISABLED (ZERO SEO form fields!)
  fs.writeFileSync(
    path.join(pagesDir, "editor-disabled.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
---
<DashboardLayout ${layoutProps("Editor Tanpa Plugin SEO — PT Nusantara Arsitek", "pages")}>
  <PageEditorClient ${editorProps(false)} />
</DashboardLayout>`,
  );

  // 2. Page Editor with seo-ai-autopilot ENABLED (single collapsed optional override drawer)
  fs.writeFileSync(
    path.join(pagesDir, "editor-enabled.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
---
<DashboardLayout ${layoutProps("Editor Dengan SEO Autopilot — PT Nusantara Arsitek", "pages")}>
  <PageEditorClient ${editorProps(true)} />
</DashboardLayout>`,
  );

  // 3. Plugin Storefront showing official free `seo-ai-autopilot` 1-click `Pasang (Gratis)` -> `Nonaktifkan`
  fs.writeFileSync(
    path.join(pagesDir, "plugins-storefront.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PluginStorefrontClient } from ${JSON.stringify(pluginStorefrontImport)};
const initialItems = [
  {
    id: "seo-ai-autopilot",
    name: "SEO & AI Autopilot",
    description:
      "SEO & AI otomatis tanpa setting rumit: sitemap XML + gambar, robots.txt ramah AI, judul/meta otomatis dari Blueprint, OG WhatsApp < 300 KiB, Schema.org @graph, IndexNow, dan kartu salin GBP & Bing Places.",
    version: "1.0.0",
    visibility: "public_free",
    billingCycle: "free",
    priceIdr: 0,
    tablePrefix: "plg_seo_ai_autopilot__",
    permissions: ["tenant_db:plg_tables", "public:head", "admin:page", "admin:api"],
    maxPublicJsBytes: 0,
    entitled: false,
    installed: false,
    enabled: false,
    schemaVersion: 0,
  },
];
---
<DashboardLayout ${layoutProps("Plugin — PT Nusantara Arsitek", "plugins")}>
  <PluginStorefrontClient
    client:only="react"
    handle="nusantara-arsitek"
    basePath="/dashboard/nusantara-arsitek"
    apiBaseUrl="/api/tenants/nusantara-arsitek/plugins"
    initialItems={initialItems}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 4. `/dashboard/[handle]/plugins/seo-ai-autopilot` settings screen
  fs.writeFileSync(
    path.join(pagesDir, "plugin-seo-autopilot.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { SeoAutopilotSettingsClient } from ${JSON.stringify(seoSettingsImport)};
const initialSettings = ${JSON.stringify(buildSeoSettingsFixture())};
---
<DashboardLayout ${layoutProps("SEO & AI Autopilot — Plugin — PT Nusantara Arsitek", "plugins")}>
  <SeoAutopilotSettingsClient
    client:only="react"
    basePath="/dashboard/nusantara-arsitek"
    apiBaseUrl="/api/tenants/nusantara-arsitek/seo"
    initialSettings={initialSettings}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManageSettings: true,
    }}
  />
</DashboardLayout>`,
  );

  // 5. AI Crawler Split & IndexNow screen
  fs.writeFileSync(
    path.join(pagesDir, "ai-crawler-split.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { SeoVisibilityManager } from ${JSON.stringify(seoVisibilityImport)};
const initialSnapshot = ${JSON.stringify(buildAiVisibilityFixture())};
---
<DashboardLayout ${layoutProps("Visibilitas AI & Pencarian — PT Nusantara Arsitek", "plugins")}>
  <SeoVisibilityManager
    client:only="react"
    initialSnapshot={initialSnapshot}
    canEditPolicy={true}
  />
</DashboardLayout>`,
  );

  const { build } = await import(astroEntryUrl);
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href))
    .default;
  const react = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href))
    .default;

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    devToolbar: { enabled: false },
    logLevel: "silent",
    integrations: [react()],
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

function startStaticAndMockApiServer(outDir) {
  let pluginInstalled = false;
  let pluginEnabled = false;
  let seoToggleEnabled = true;
  let aiPolicy = "allow";

  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    // Mock 1-click plugin install (`POST /api/tenants/nusantara-arsitek/plugins`)
    if (url.pathname === "/api/tenants/nusantara-arsitek/plugins" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        pluginInstalled = true;
        pluginEnabled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            plugin: {
              id: "seo-ai-autopilot",
              name: "SEO & AI Autopilot",
              entitled: true,
              installed: pluginInstalled,
              enabled: pluginEnabled,
              schemaVersion: 1,
            },
            requestId: "req_t102_install",
          }),
        );
      });
      return;
    }

    // Mock 1-click plugin toggle (`PATCH /api/tenants/nusantara-arsitek/plugins/seo-ai-autopilot`)
    if (
      url.pathname === "/api/tenants/nusantara-arsitek/plugins/seo-ai-autopilot" &&
      req.method === "PATCH"
    ) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        pluginEnabled = Boolean(body.enabled);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            plugin: {
              id: "seo-ai-autopilot",
              name: "SEO & AI Autopilot",
              entitled: true,
              installed: true,
              enabled: pluginEnabled,
              schemaVersion: 1,
            },
            requestId: "req_t102_patch",
          }),
        );
      });
      return;
    }

    // Mock SEO settings 1-click toggle (`POST /api/tenants/nusantara-arsitek/seo/toggle`)
    if (url.pathname === "/api/tenants/nusantara-arsitek/seo/toggle" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        seoToggleEnabled = Boolean(body.enabled);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: seoToggleEnabled, requestId: "req_t102_toggle" }));
      });
      return;
    }

    // Mock AI crawler policy toggle (`POST /dashboard/nusantara-arsitek/seo/api`)
    if (url.pathname === "/dashboard/nusantara-arsitek/seo/api" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (body.aiTrainingPolicy === "disallow" || body.aiTrainingPolicy === "allow") {
          aiPolicy = body.aiTrainingPolicy;
        }
        const snap = buildAiVisibilityFixture();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            snapshot: {
              ...snap,
              aiTrainingPolicy: aiPolicy,
              robotsTxt: snap.robotsTxt.replace(
                "User-agent: GPTBot\nAllow: /",
                `User-agent: GPTBot\n${aiPolicy === "disallow" ? "Disallow: /" : "Allow: /"}`,
              ),
            },
          }),
        );
      });
      return;
    }

    let filePath = path.join(outDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    dims.scrollWidth <= dims.clientWidth + 1,
    `Horizontal overflow on ${label}: scrollWidth=${dims.scrollWidth} > clientWidth=${dims.clientWidth}`,
  );
}

async function assertMobileTouchTargets(page, selectors, label) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) continue;
    const box = await el.boundingBox();
    assert(box && box.height >= 44, `Touch target ${sel} on ${label} has height=${box?.height} (< 44px)`);
  }
}

async function run() {
  const { tmpRoot, outDir } = await buildTask102Fixtures();
  const srv = await startStaticAndMockApiServer(outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const savedScreenshots = [];

  try {
    const viewports = [
      { name: "360", width: 360, height: 800, isMobile: true },
      { name: "1440", width: 1440, height: 900, isMobile: false },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });

      // (a1) Base editor with seo-ai-autopilot DISABLED -> ZERO SEO form clutter!
      await page.goto(`${srv.baseUrl}/editor-disabled`, { waitUntil: "networkidle" });
      await page.waitForSelector('input[value="Layanan Renovasi Kantor"]');
      const disabledDrawerCount = await page.locator('[data-testid="seo-override-drawer"]').count();
      assert(
        disabledDrawerCount === 0,
        `SEO override drawer MUST NOT render when disabled (vp=${vp.name})`,
      );
      await assertNoHorizontalOverflow(page, `editor-disabled-${vp.name}`);
      const shotDisabled = path.join(screenshotDir, `editor-disabled-${vp.name}.png`);
      await page.screenshot({ path: shotDisabled, fullPage: true });
      savedScreenshots.push(shotDisabled);

      // (a2) Editor with seo-ai-autopilot ENABLED -> collapsed by default until clicked!
      await page.goto(`${srv.baseUrl}/editor-enabled`, { waitUntil: "networkidle" });
      const drawer = page.locator('[data-testid="seo-override-drawer"]');
      await drawer.waitFor({ state: "visible" });
      assert(
        (await drawer.getAttribute("data-seo-expanded")) === "false",
        `SEO drawer MUST start collapsed by default (vp=${vp.name})`,
      );
      assert(
        (await page.locator('[data-testid="seo-drawer-panel"]').count()) === 0,
        `SEO fields MUST stay hidden until clicked (vp=${vp.name})`,
      );
      if (vp.isMobile) {
        await assertMobileTouchTargets(
          page,
          ['[data-testid="seo-drawer-toggle"]'],
          `editor-enabled-collapsed-${vp.name}`,
        );
      }
      await assertNoHorizontalOverflow(page, `editor-enabled-collapsed-${vp.name}`);
      const shotCollapsed = path.join(screenshotDir, `editor-enabled-collapsed-${vp.name}.png`);
      await page.screenshot({ path: shotCollapsed, fullPage: true });
      savedScreenshots.push(shotCollapsed);

      // Click to expand drawer and verify tabs + preview
      await page.locator('[data-testid="seo-drawer-toggle"]').click();
      await page.locator('[data-testid="seo-drawer-panel"]').waitFor({ state: "visible" });
      assert(
        (await drawer.getAttribute("data-seo-expanded")) === "true",
        `SEO drawer must expand on click (vp=${vp.name})`,
      );
      if (vp.isMobile) {
        await assertMobileTouchTargets(
          page,
          [
            '[data-testid="seo-tab-general"]',
            '[data-testid="seo-tab-social"]',
            '[data-testid="seo-tab-schema"]',
            '[data-testid="seo-tab-advanced"]',
          ],
          `editor-enabled-expanded-${vp.name}`,
        );
      }
      await assertNoHorizontalOverflow(page, `editor-enabled-expanded-${vp.name}`);

      // (b) Plugin Storefront: 1-click `Pasang (Gratis)` -> `Aktif` + `Nonaktifkan`
      await page.goto(`${srv.baseUrl}/plugins-storefront`, { waitUntil: "networkidle" });
      const seoCard = page.locator('[data-testid="plugin-card-seo-ai-autopilot"]');
      await seoCard.waitFor({ state: "visible" });
      const installBtn = seoCard.getByRole("button", { name: /Pasang \(Gratis\)/i });
      await installBtn.waitFor({ state: "visible" });
      if (vp.isMobile) {
        const box = await installBtn.boundingBox();
        assert(box && box.height >= 44, `Pasang (Gratis) button < 44px on mobile`);
      }
      await installBtn.click();
      await seoCard.getByRole("button", { name: /Nonaktifkan/i }).waitFor({ state: "visible" });
      await assertNoHorizontalOverflow(page, `plugins-storefront-${vp.name}`);
      const shotStore = path.join(screenshotDir, `plugins-storefront-${vp.name}.png`);
      await page.screenshot({ path: shotStore, fullPage: true });
      savedScreenshots.push(shotStore);

      // (c1) `/dashboard/[handle]/plugins/seo-ai-autopilot` screen: 1-click toggle + GBP/Bing copy card
      await page.goto(`${srv.baseUrl}/plugin-seo-autopilot`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="seo-autopilot-settings-page"]');
      if (vp.isMobile) {
        await assertMobileTouchTargets(
          page,
          [
            '[data-testid="seo-plugin-toggle-btn"]',
            '[data-testid="seo-settings-tab-appearance"]',
            '[data-testid="seo-settings-tab-verification"]',
            '[data-testid="seo-settings-tab-directory"]',
          ],
          `plugin-seo-autopilot-${vp.name}`,
        );
      }
      // Toggle off & back on in 1 click
      await page.locator('[data-testid="seo-plugin-toggle-btn"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="seo-autopilot-settings-page"]')
            ?.getAttribute("data-plugin-enabled") === "false",
      );
      await page.locator('[data-testid="seo-plugin-toggle-btn"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="seo-autopilot-settings-page"]')
            ?.getAttribute("data-plugin-enabled") === "true",
      );

      // Switch to GBP & Bing Places copy card tab
      await page.locator('[data-testid="seo-settings-tab-directory"]').click();
      await page.locator('[data-testid="seo-gbp-copy-card"]').waitFor({ state: "visible" });
      const gbpText = await page.locator('[data-testid="seo-gbp-copy-preview"]').textContent();
      assert(gbpText?.includes("PT Nusantara Arsitek"), "GBP copy card must show factual business name");
      if (vp.isMobile) {
        await assertMobileTouchTargets(
          page,
          ['[data-testid="seo-gbp-copy-btn"]'],
          `plugin-seo-gbp-${vp.name}`,
        );
      }
      await assertNoHorizontalOverflow(page, `plugin-seo-autopilot-${vp.name}`);
      const shotSettings = path.join(screenshotDir, `plugin-seo-autopilot-gbp-${vp.name}.png`);
      await page.screenshot({ path: shotSettings, fullPage: true });
      savedScreenshots.push(shotSettings);

      // (c2) AI Crawler Split & IndexNow screen
      await page.goto(`${srv.baseUrl}/ai-crawler-split`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="ai-crawler-controls-card"]');
      await page.locator('[data-testid="ai-training-toggle"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="seo-visibility-page"]')
            ?.getAttribute("data-ai-training-policy") === "disallow",
      );
      if (vp.isMobile) {
        await assertMobileTouchTargets(
          page,
          ['[data-testid="ai-training-toggle"]', '[data-testid="copy-robots-btn"]'],
          `ai-crawler-split-${vp.name}`,
        );
      }
      await assertNoHorizontalOverflow(page, `ai-crawler-split-${vp.name}`);
      const shotAi = path.join(screenshotDir, `ai-crawler-split-${vp.name}.png`);
      await page.screenshot({ path: shotAi, fullPage: true });
      savedScreenshots.push(shotAi);

      assert(errors.length === 0, `Browser errors on vp=${vp.name}:\n${errors.join("\n")}`);
      await context.close();
    }

    console.log(
      `TASK-102 E2E PASSED (360px & 1440px, 0 errors, 0 overflow, >=44px mobile targets). Screenshots:\n${savedScreenshots.join("\n")}`,
    );
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
