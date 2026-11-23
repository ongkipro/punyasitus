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

const screenshotDir = process.env.TASK097_SCREENSHOT_DIR || "/tmp/punyasitus-t097-screenshots";

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

async function buildPluginAdminFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t097-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const storefrontImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/plugins/_PluginStorefrontClient.tsx",
  );
  const detailImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/plugins/_PluginDetailClient.tsx",
  );

  const layoutProps = (title, lifecycleStatus = "active") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId="plugins"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 1. Empty state fixture (no plugins installed yet)
  fs.writeFileSync(
    path.join(pagesDir, "plugins-empty.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PluginStorefrontClient } from ${JSON.stringify(storefrontImport)};
---
<DashboardLayout ${layoutProps("Plugin — PT Nusantara Arsitek")}>
  <PluginStorefrontClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/plugins"
    initialItems={[]}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 2. Installed + 3-tier Storefront fixture (DESIGN.md §7)
  fs.writeFileSync(
    path.join(pagesDir, "plugins-installed.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PluginStorefrontClient } from ${JSON.stringify(storefrontImport)};
---
<DashboardLayout ${layoutProps("Plugin — PT Nusantara Arsitek")}>
  <PluginStorefrontClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/plugins"
    initialItems={[
      {
        id: "synthetic-probe",
        name: "Synthetic Probe Plugin",
        description: "Plugin uji terpadu untuk memverifikasi kelima slot isolasi Frozen-Core PunyaSitus.",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_synthetic_probe__",
        permissions: ["tenant_db:plg_tables", "public:route", "admin:api", "queue:lead.created"],
        maxPublicJsBytes: 1024,
        entitled: true,
        installed: true,
        enabled: true,
        schemaVersion: 1,
      },
      {
        id: "bio-links",
        name: "Bio Links (/link)",
        description: "Halaman tautan profil & katalog cepat tanpa JavaScript pada domain situs Anda sendiri.",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_bio_links__",
        permissions: ["tenant_db:plg_tables", "public:route", "admin:page"],
        maxPublicJsBytes: 0,
        entitled: false,
        installed: false,
        enabled: false,
        schemaVersion: 0,
      },
      {
        id: "wa-cs-rotator",
        name: "WhatsApp CS Rotator",
        description: "Distribusi prospek WhatsApp otomatis ke banyak agen sales dengan bobot & jam aktif.",
        version: "1.0.0",
        visibility: "public_paid",
        billingCycle: "paid_monthly",
        priceIdr: 49000,
        tablePrefix: "plg_wa_cs_rotator__",
        permissions: ["tenant_db:plg_tables", "public:section", "admin:api"],
        maxPublicJsBytes: 2048,
        entitled: false,
        installed: false,
        enabled: false,
        schemaVersion: 0,
      },
      {
        id: "client-bespoke",
        name: "Kalkulator RAB Kustom",
        description: "Plugin privat khusus untuk estimasi biaya renovasi klien PT Nusantara Arsitek.",
        version: "1.2.0",
        visibility: "private_client",
        billingCycle: "custom",
        priceIdr: 0,
        tablePrefix: "plg_client_bespoke__",
        permissions: ["tenant_db:plg_tables", "public:section", "admin:page"],
        maxPublicJsBytes: 4096,
        entitled: true,
        installed: true,
        enabled: true,
        schemaVersion: 2,
      },
    ]}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 3. Locked read-only state fixture
  fs.writeFileSync(
    path.join(pagesDir, "plugins-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PluginStorefrontClient } from ${JSON.stringify(storefrontImport)};
---
<DashboardLayout ${layoutProps("Plugin — PT Nusantara Arsitek", "locked")}>
  <PluginStorefrontClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/plugins"
    initialItems={[
      {
        id: "synthetic-probe",
        name: "Synthetic Probe Plugin",
        description: "Plugin uji terpadu untuk memverifikasi kelima slot isolasi Frozen-Core.",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_synthetic_probe__",
        permissions: ["tenant_db:plg_tables", "admin:api"],
        maxPublicJsBytes: 1024,
        entitled: true,
        installed: true,
        enabled: true,
        schemaVersion: 1,
      },
    ]}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      isLocked: true,
      canManagePlugins: false,
    }}
  />
</DashboardLayout>`,
  );

  // 4. Installed plugin detail settings screen (/dashboard/[handle]/plugins/[pluginId])
  fs.writeFileSync(
    path.join(pagesDir, "plugin-detail.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PluginDetailClient } from ${JSON.stringify(detailImport)};
---
<DashboardLayout ${layoutProps("Synthetic Probe Plugin — Plugin — PT Nusantara Arsitek")}>
  <PluginDetailClient
    client:load
    basePath="/dashboard/alpha-studio"
    apiUrl="/api/tenants/alpha-studio/plugins/synthetic-probe"
    plugin={{
      id: "synthetic-probe",
      name: "Synthetic Probe Plugin",
      description: "Plugin uji terpadu untuk memverifikasi kelima slot isolasi Frozen-Core PunyaSitus.",
      version: "1.0.0",
      visibility: "public_free",
      tablePrefix: "plg_synthetic_probe__",
      permissions: ["tenant_db:plg_tables", "public:route", "admin:api"],
      enabled: true,
      schemaVersion: 1,
      config: {
        bannerLabel: "Promo Konsultasi Gratis",
        throwOnLeadHook: false,
      },
    }}
    configFields={[
      {
        key: "bannerLabel",
        label: "Label Banner Publik",
        description: "Teks yang tampil pada blok dan rute /probe-widget.",
        kind: "text",
        placeholder: "Promo Aktif",
      },
      {
        key: "throwOnLeadHook",
        label: "Mode Diagnostik Hook Prospek",
        description: "Aktifkan hanya saat menguji isolasi kegagalan Queue hook.",
        kind: "boolean",
      },
    ]}
    adminState={{
      totalItems: 3,
      totalHookEvents: 12,
    }}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
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
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

    // Mock live plugin toggle/save API for interactive browser proof
    if (
      reqUrl.pathname.startsWith("/api/tenants/alpha-studio/plugins/") &&
      req.method === "PATCH"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          plugin: {
            id: "synthetic-probe",
            enabled: typeof body.enabled === "boolean" ? body.enabled : true,
            config: body.config ?? { bannerLabel: "Promo Konsultasi Gratis", throwOnLeadHook: false },
          },
          requestId: "req_e2e_mock",
        }),
      );
      return;
    }

    let target = path.join(outDir, reqUrl.pathname);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    } else if (!fs.existsSync(target) && fs.existsSync(`${target}.html`)) {
      target = `${target}.html`;
    } else if (!fs.existsSync(target) && fs.existsSync(path.join(target, "index.html"))) {
      target = path.join(target, "index.html");
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(target) });
    fs.createReadStream(target).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const built = await buildPluginAdminFixtures();
  const server = await startFixtureServer(built.outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const savedScreenshots = [];

  try {
    const viewports = [
      { name: "360x800", width: 360, height: 800 },
      { name: "1440x900", width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });

      // 1. Empty state fixture
      await page.goto(`${server.baseUrl}/plugins-empty`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="plugin-admin-shell"]');
      await page.waitForSelector('[data-testid="plugin-empty-state"]');

      const emptyOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!emptyOverflow, `Horizontal overflow detected on empty storefront at ${vp.name}`);

      // Verify zero Radix DOM attributes
      const radixCount = await page.evaluate(
        () => document.querySelectorAll("[data-radix-collection-item], [data-radix-popper-content-wrapper]").length,
      );
      assert(radixCount === 0, "Forbidden Radix DOM attributes found");

      const emptyShot = path.join(screenshotDir, `plugin-storefront-empty-${vp.name}.png`);
      await page.screenshot({ path: emptyShot, fullPage: true });
      savedScreenshots.push(emptyShot);

      // 2. Installed 3-tier storefront fixture + tab interaction + disable reassurance
      await page.goto(`${server.baseUrl}/plugins-installed`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="plugin-card-synthetic-probe"]');

      const installedOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!installedOverflow, `Horizontal overflow detected on installed storefront at ${vp.name}`);

      const installedShot = path.join(screenshotDir, `plugin-storefront-installed-${vp.name}.png`);
      await page.screenshot({ path: installedShot, fullPage: true });
      savedScreenshots.push(installedShot);

      // Verify tab switching across all 3 tiers (`Berbayar / Pro`, `Custom Dev`, back to `Terpasang & Gratis`)
      await page.click("#tab-berbayar");
      await page.waitForSelector('[data-testid="plugin-card-wa-cs-rotator"]');
      await page.click("#tab-custom-dev");
      await page.waitForSelector('[data-testid="plugin-card-client-bespoke"]');
      await page.waitForSelector('[data-testid="plugin-custom-dev-card"]');
      await page.click("#tab-terpasang-gratis");
      await page.waitForSelector('[data-testid="plugin-card-synthetic-probe"]');

      // Interactive disable click verifies data-preservation notice
      await page.locator('[data-testid="plugin-card-synthetic-probe"] button:has-text("Nonaktifkan")').click();
      await page.waitForSelector('[data-testid="plugin-status-notice"]');
      const noticeText = await page.locator('[data-testid="plugin-status-notice"]').textContent();
      assert(
        noticeText && noticeText.includes("tetap tersimpan aman"),
        "Disable notice must reassure that plugin settings data is preserved",
      );

      // 3. Locked state disables mutations
      await page.goto(`${server.baseUrl}/plugins-locked`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="plugin-locked-alert"]');
      const disableBtnDisabled = await page
        .locator('[data-testid="plugin-card-synthetic-probe"] button:has-text("Nonaktifkan")')
        .isDisabled();
      assert(disableBtnDisabled, `Disable button must be disabled in locked mode at ${vp.name}`);

      // 4. Plugin detail settings page (/dashboard/[handle]/plugins/[pluginId])
      await page.goto(`${server.baseUrl}/plugin-detail`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="plugin-detail-shell"]');
      const detailOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!detailOverflow, `Horizontal overflow detected on plugin detail at ${vp.name}`);

      const detailShot = path.join(screenshotDir, `plugin-detail-${vp.name}.png`);
      await page.screenshot({ path: detailShot, fullPage: true });
      savedScreenshots.push(detailShot);

      // Save config form interaction
      await page.fill("#plugin-cfg-bannerLabel", "Promo Akhir Tahun");
      await page.click('button:has-text("Simpan Pengaturan")');
      await page.waitForSelector('[data-testid="plugin-detail-notice"]');

      assert(errors.length === 0, `Browser runtime errors at ${vp.name}: ${errors.join("; ")}`);
      await context.close();
    }

    console.log(
      JSON.stringify(
        {
          task: "TASK-097",
          status: "PASS",
          viewports: ["360x800", "1440x900"],
          screenshots: savedScreenshots,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await server.close();
    built.cleanup();
  }
}

run().catch((err) => {
  console.error("TASK-097 E2E FAILED:", err);
  process.exit(1);
});
