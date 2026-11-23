/* global process, console, document, URL */
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

const screenshotDir = process.env.TASK098_SCREENSHOT_DIR || "/tmp/qa-task-098";

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

async function buildTask098VisualFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t098-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const consoleLayoutImport = path.join(webDir, "src/layouts/ConsoleLayout.astro");
  const pluginStoreImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/plugins/_PluginStoreClient.tsx",
  );
  const consolePluginsImport = path.join(
    webDir,
    "src/pages/console/plugins/_ConsolePluginsPanel.tsx",
  );

  // 1. Toko Plugin fixture (4 tabs: Terpasang / Gratis / Berbayar / Khusus Klien + Custom Dev)
  fs.writeFileSync(
    path.join(pagesDir, "toko-plugin.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { PluginStoreClient } from ${JSON.stringify(pluginStoreImport)};
---
<DashboardLayout
  title="Toko Plugin — PT Nusantara Arsitek"
  surface="dashboard"
  workspaceName="PT Nusantara Arsitek"
  workspaceSubtitle="nusantara-arsitek.situsku.click"
  activeNavId="plugins"
  basePath="/dashboard/nusantara-arsitek"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://nusantara-arsitek.situsku.click"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <PluginStoreClient
    client:load
    handle="nusantara-arsitek"
    basePath="/dashboard/nusantara-arsitek"
    apiBaseUrl="/api/tenants/nusantara-arsitek/plugins"
    billingPayer="tenant"
    initialItems={[
      {
        slug: "seo-ai-autopilot",
        name: "SEO & AI Autopilot",
        tagline: "SEO & indeksasi AI otomatis tanpa setting",
        description: "Sitemap XML, robots.txt ramah mesin pencari & AI, meta/OG otomatis, Schema.org @graph, dan IndexNow.",
        visibilityTier: "public_free",
        billingModel: "free",
        priceIdr: 0,
        entitled: true,
        installed: true,
        enabled: true,
        entitlementStatus: "active",
        sourceKind: "public_free",
        expiresAtIso: null,
        canInstall: true,
        canTenantCheckout: false,
        agencyManagedBilling: false,
        checkoutBlockCode: null,
        activeGrantId: null,
        activeGrantScope: null,
      },
      {
        slug: "bio-links",
        name: "Bio Links (/link)",
        tagline: "Halaman tautan bio 0-JS di domain sendiri",
        description: "Halaman /link untuk profil, katalog, dan tautan sosial dengan penghitung klik pihak pertama.",
        visibilityTier: "public_free",
        billingModel: "free",
        priceIdr: 0,
        entitled: true,
        installed: false,
        enabled: false,
        entitlementStatus: null,
        sourceKind: null,
        expiresAtIso: null,
        canInstall: true,
        canTenantCheckout: false,
        agencyManagedBilling: false,
        checkoutBlockCode: null,
        activeGrantId: null,
        activeGrantScope: null,
      },
      {
        slug: "wa-cs-rotator",
        name: "WhatsApp CS Rotator",
        tagline: "Distribusi prospek WA otomatis ke tim sales",
        description: "Rotasi CTA WhatsApp ke banyak agen sales berdasarkan bobot, round-robin, dan jam aktif.",
        visibilityTier: "public_paid",
        billingModel: "paid_monthly",
        priceIdr: 49000,
        entitled: false,
        installed: false,
        enabled: false,
        entitlementStatus: null,
        sourceKind: null,
        expiresAtIso: null,
        canInstall: false,
        canTenantCheckout: true,
        agencyManagedBilling: false,
        checkoutBlockCode: null,
        activeGrantId: null,
        activeGrantScope: null,
      },
      {
        slug: "lead-notifier-pro",
        name: "Lead Notifier Webhook Pro",
        tagline: "Webhook HTTPS bertanda tangan ke CRM & Sheets",
        description: "Kirim notifikasi prospek masuk secara asinkron ke Google Sheets, CRM, atau gateway WhatsApp.",
        visibilityTier: "public_paid",
        billingModel: "paid_once",
        priceIdr: 299000,
        entitled: true,
        installed: true,
        enabled: true,
        entitlementStatus: "active",
        sourceKind: "paid_once",
        expiresAtIso: null,
        canInstall: true,
        canTenantCheckout: false,
        agencyManagedBilling: false,
        checkoutBlockCode: null,
        activeGrantId: null,
        activeGrantScope: null,
      },
      {
        slug: "rab-kontraktor-privat",
        name: "Kalkulator RAB Kontraktor",
        tagline: "Estimasi proyek eksklusif PT Nusantara Arsitek",
        description: "Plugin bespoke terisolasi untuk simulasi RAB renovasi dengan ekspor ringkasan WhatsApp.",
        visibilityTier: "private_client",
        billingModel: "free",
        priceIdr: 0,
        entitled: true,
        installed: true,
        enabled: true,
        entitlementStatus: "active",
        sourceKind: "private_grant",
        expiresAtIso: null,
        canInstall: true,
        canTenantCheckout: false,
        agencyManagedBilling: false,
        checkoutBlockCode: null,
        activeGrantId: "plggr_01T098DEMO",
        activeGrantScope: "tenant",
      },
    ]}
    initialOrders={[
      {
        id: "plgord_01T098DEMO",
        pluginSlug: "lead-notifier-pro",
        billingModel: "paid_once",
        channelCode: "QRIS",
        grossAmountIdr: 299000,
        discountAmountIdr: 0,
        channelFeeIdr: 2093,
        totalPayableIdr: 301093,
        status: "settled",
        paymentInstructions: null,
        createdAtIso: "2026-11-20T08:00:00.000Z",
      },
    ]}
    initialReceipts={[
      {
        id: "plgrec_01T098DEMO",
        receiptNumber: "INV-PLG-2026-000001",
        pluginSlug: "lead-notifier-pro",
        pluginNameSnapshot: "Lead Notifier Webhook Pro",
        totalAmountIdr: 301093,
        paymentChannel: "QRIS",
        issuedAtIso: "2026-11-20T08:01:00.000Z",
      },
    ]}
    initialCustomDevRequests={[
      {
        id: "plgreq_01T098DEMO",
        requestCode: "PLG-20261123-DEMO01",
        serviceKind: "custom_plugin",
        title: "Kalkulator RAB Kontraktor",
        requirementsSummary: "Kalkulator estimasi biaya renovasi per meter persegi dan cetak ringkasan.",
        contactWhatsapp: "6281234567890",
        budgetRange: "Rp 4.500.000",
        status: "fulfilled",
        quoteAmountIdr: 4500000,
        linkedPluginSlug: "rab-kontraktor-privat",
        createdAtIso: "2026-11-18T09:00:00.000Z",
      },
    ]}
    initialQuota={{
      used: 1,
      limit: 3,
      remaining: 2,
      dayBucket: "2026-11-23",
    }}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 2. Console Plugins Manager fixture (`console.punyasitus.com/plugins`)
  fs.writeFileSync(
    path.join(pagesDir, "console-plugins.astro"),
    `---
import ConsoleLayout from ${JSON.stringify(consoleLayoutImport)};
import { ConsolePluginsPanel } from ${JSON.stringify(consolePluginsImport)};
---
<ConsoleLayout
  title="Manajemen Toko Plugin & Izin Klien"
  workspaceSubtitle="console.punyasitus.com"
  activeNavId="settings"
  basePath="/console"
  userDisplayName="Admin Platform"
  userRoleLabel="Superadmin Platform"
>
  <div class="space-y-5" data-testid="console-plugins-page">
    <section
      data-testid="console-context-banner"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-xs text-warning md:text-sm"
    >
      <p class="font-medium">
        Console Operasional Platform — Akses istimewa — bukan penyamaran akun tenant
      </p>
      <span class="rounded border border-warning-border bg-card px-2 py-0.5 text-xs font-medium text-foreground">
        2FA Step-Up Aktif (&lt;10m)
      </span>
    </section>

    <header class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">
        Toko Plugin, Izin Khusus Klien &amp; Custom Dev
      </h1>
      <p class="text-sm text-muted-foreground">
        Promosikan plugin khusus klien ke toko publik via metadata, terbitkan izin tenant/agensi,
        dan penuhi permintaan <code>custom_plugin</code> dengan tautan izin aktif wajib.
      </p>
    </header>

    <ConsolePluginsPanel
      client:load
      stepUpFresh={true}
      initialCatalog={[
        {
          slug: "seo-ai-autopilot",
          name: "SEO & AI Autopilot",
          tagline: "SEO & indeksasi AI otomatis",
          description: "Sitemap XML, AI robots.txt, Schema @graph.",
          visibilityTier: "public_free",
          billingModel: "free",
          priceIdr: 0,
          active: true,
          version: 1,
        },
        {
          slug: "wa-cs-rotator",
          name: "WhatsApp CS Rotator",
          tagline: "Distribusi prospek WA otomatis",
          description: "Rotasi CTA WhatsApp multi-agen sales.",
          visibilityTier: "public_paid",
          billingModel: "paid_monthly",
          priceIdr: 49000,
          active: true,
          version: 2,
        },
        {
          slug: "rab-kontraktor-privat",
          name: "Kalkulator RAB Kontraktor",
          tagline: "Estimasi proyek eksklusif klien",
          description: "Plugin bespoke privat siap dipromosikan ke katalog publik.",
          visibilityTier: "private_client",
          billingModel: "free",
          priceIdr: 0,
          active: true,
          version: 1,
        },
      ]}
      initialGrants={[
        {
          id: "plggr_01T098DEMO",
          pluginSlug: "rab-kontraktor-privat",
          tenantId: "01JT098TENANTALPHA0000001",
          agencyId: null,
          status: "active",
          grantReason: "Penyerahan kontrak proyek plugin khusus PT Nusantara Arsitek.",
          createdAtIso: "2026-11-21T07:00:00.000Z",
        },
      ]}
      initialRequests={[
        {
          id: "plgreq_01T098QUEUE1",
          requestCode: "PLG-20261123-0042",
          tenantId: "01JT098TENANTALPHA0000001",
          tenantHandle: "nusantara-arsitek",
          title: "Integrasi Katalog ERP Gudang",
          requirementsSummary: "Sinkronisasi stok produk ke katalog website setiap 15 menit.",
          contactWhatsapp: "6281234567890",
          status: "quoted",
          quoteAmountIdr: 5500000,
          linkedGrantId: null,
          linkedPluginSlug: null,
          version: 2,
          createdAtIso: "2026-11-23T04:00:00.000Z",
        },
      ]}
    />
  </div>
</ConsoleLayout>`,
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
    integrations: [react()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
      logLevel: "error",
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return { tmpRoot, outDir };
}

function startStaticServer(rootDir) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const candidates = [
        path.join(rootDir, reqPath),
        path.join(rootDir, reqPath, "index.html"),
        path.join(rootDir, `${reqPath}.html`),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const ext = path.extname(candidate);
          res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
          fs.createReadStream(candidate).pipe(res);
          return;
        }
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildTask098VisualFixtures();
  const { server, port } = await startStaticServer(outDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const savedScreenshots = [];

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const width of [360, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 360 ? 800 : 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      // 1. Toko Plugin — 4 Tabs (`Terpasang`, `Gratis`, `Berbayar`, `Khusus Klien`)
      await page.goto(`${baseUrl}/toko-plugin/`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="plugin-store-shell"]');

      const overflowToko = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      assert(!overflowToko, `Horizontal overflow on Toko Plugin at ${width}px`);

      // Screenshot Terpasang tab
      const pTerpasang = path.join(screenshotDir, `toko-plugin-terpasang-${width}px.png`);
      await page.screenshot({ path: pTerpasang, fullPage: true });
      savedScreenshots.push(pTerpasang);

      // Click Gratis tab
      await page.click("#tab-gratis");
      await page.waitForSelector("#panel-gratis");
      const pGratis = path.join(screenshotDir, `toko-plugin-gratis-${width}px.png`);
      await page.screenshot({ path: pGratis, fullPage: true });
      savedScreenshots.push(pGratis);

      // Click Berbayar tab
      await page.click("#tab-berbayar");
      await page.waitForSelector("#panel-berbayar");
      const pBerbayar = path.join(screenshotDir, `toko-plugin-berbayar-${width}px.png`);
      await page.screenshot({ path: pBerbayar, fullPage: true });
      savedScreenshots.push(pBerbayar);

      // Click Khusus Klien tab (private_client + Custom Dev form)
      await page.click("#tab-khusus-klien");
      await page.waitForSelector('[data-testid="custom-plugin-dev-form-card"]');
      const pKhusus = path.join(screenshotDir, `toko-plugin-khusus-klien-${width}px.png`);
      await page.screenshot({ path: pKhusus, fullPage: true });
      savedScreenshots.push(pKhusus);

      // 2. Console Plugin Store & Grants Manager (`console.punyasitus.com/plugins`)
      await page.goto(`${baseUrl}/console-plugins/`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="console-plugins-panel"]');

      const overflowConsole = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      assert(!overflowConsole, `Horizontal overflow on Console Plugins at ${width}px`);

      const pConsoleCat = path.join(screenshotDir, `console-plugins-catalog-${width}px.png`);
      await page.screenshot({ path: pConsoleCat, fullPage: true });
      savedScreenshots.push(pConsoleCat);

      await page.click("#console-tab-grants");
      await page.waitForSelector('[data-testid="console-grants-tab"]');
      const pConsoleGrants = path.join(screenshotDir, `console-plugins-grants-${width}px.png`);
      await page.screenshot({ path: pConsoleGrants, fullPage: true });
      savedScreenshots.push(pConsoleGrants);

      await page.click("#console-tab-requests");
      await page.waitForSelector('[data-testid="console-requests-tab"]');
      const pConsoleReqs = path.join(screenshotDir, `console-plugins-requests-${width}px.png`);
      await page.screenshot({ path: pConsoleReqs, fullPage: true });
      savedScreenshots.push(pConsoleReqs);

      assert(errors.length === 0, `Console/page errors at ${width}px: ${errors.join("; ")}`);
      await context.close();
    }

    console.log("TASK-098 E2E PASSED. Screenshots saved:");
    for (const s of savedScreenshots) {
      console.log(`  - ${s}`);
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
