/* global process, console, document, window, URL */
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

const screenshotDir = process.env.TASK100_SCREENSHOT_DIR || "/tmp/qa-task-100";

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

async function buildWpImporterFixture() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t100-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const adminGlobalsCss = path.join(webDir, "src/styles/admin/globals.css");
  const wizardImport = path.join(
    root,
    "packages/plugins/wp-importer/src/admin/WpImporterWizard.tsx",
  );
  const wizardAdminDir = path.join(root, "packages/plugins/wp-importer/src/admin");
  const fixtureCssPath = path.join(srcDir, "fixture.css");
  const relGlobalsCss = path.relative(srcDir, adminGlobalsCss).split(path.sep).join("/");
  const relWizardDir = path.relative(srcDir, wizardAdminDir).split(path.sep).join("/");
  fs.writeFileSync(
    fixtureCssPath,
    `@import ${JSON.stringify(relGlobalsCss)};\n@source ${JSON.stringify(relWizardDir)};\n`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "wp-importer.astro"),
    `---
import ${JSON.stringify(fixtureCssPath)};
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { WpImporterWizard } from ${JSON.stringify(wizardImport)};
---
<DashboardLayout
  title="WordPress Importer — Plugin — PT Nusantara Arsitek"
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
  <WpImporterWizard
    client:load
    basePath="/dashboard/nusantara-arsitek"
    apiBaseUrl="/api/tenants/nusantara-arsitek/plugins/wp-importer"
    pluginStatus={{ enabled: true, visibility: "public_free" }}
    storageQuota={{ usedBytes: 18_400_000, quotaBytes: 100_000_000 }}
    initialJobs={[
      {
        id: "wpimp_01JT100SEED000000000000001",
        mode: "dry_run",
        sourceKind: "wxr",
        sourceLabel: "WXR (https://lama.nusantara.co.id)",
        status: "completed",
        actorUserId: "user_owner",
        postsFound: 4,
        postsImported: 0,
        postsSkipped: 1,
        categoriesImported: 0,
        tagsImported: 0,
        imagesImported: 0,
        imagesSkipped: 0,
        bytesImported: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-11-22T09:15:00.000Z",
        completedAt: "2026-11-22T09:15:02.000Z",
      },
    ]}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  const astroConfig = path.join(webDir, "astro.config.mjs");
  const { build } = await import(astroEntryUrl);
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href))
    .default;
  const react = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;

  assert(fs.existsSync(astroConfig), "apps/web/astro.config.mjs must exist");

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
      server: {
        fs: {
          allow: [root],
        },
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return { tmpRoot, outDir };
}

function startStaticServer(rootDir) {
  const mimeByExt = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".json": "application/json",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      let filePath = path.join(rootDir, reqPath === "/" ? "wp-importer/index.html" : reqPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeByExt[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function createMockReport(mode) {
  return {
    jobId: mode === "dry_run" ? "wpimp_01JT100DRYRUN0000000001" : "wpimp_01JT100IMPORT0000000002",
    mode,
    sourceKind: "wp_json",
    sourceLabel: "https://blog.nusantara-arsitek.co.id",
    status: "completed_with_warnings",
    draftOnlyEnforced: true,
    counts: {
      postsFound: 2,
      postsImported: mode === "import" ? 2 : 0,
      postsSkipped: 0,
      categoriesFound: 2,
      categoriesImported: mode === "import" ? 2 : 0,
      tagsFound: 3,
      tagsImported: mode === "import" ? 3 : 0,
      imagesFound: 3,
      imagesImported: mode === "import" ? 2 : 0,
      imagesSkipped: 0,
      imagesBlocked: 1,
      bytesImported: mode === "import" ? 245_760 : 0,
    },
    quota: {
      quotaBytes: 100_000_000,
      usedBytesBefore: 18_400_000,
      usedBytesAfter: mode === "import" ? 18_645_760 : 18_400_000,
      remainingBytesAfter: mode === "import" ? 81_354_240 : 81_600_000,
      exceeded: false,
    },
    posts: [
      {
        sourceId: "101",
        title: "Desain Rumah Tropis Hemat Energi",
        sourceStatus: "publish",
        importedStatus: "draft",
        publishedAt: null,
        sourceSlug: "desain-rumah-tropis-hemat-energi",
        targetSlug: "desain-rumah-tropis-hemat-energi",
        targetPostId: mode === "import" ? 11 : null,
        categories: ["Arsitektur Tropis"],
        tags: ["Ventilasi", "Hemat Energi"],
        imageCount: 2,
        importedImageCount: mode === "import" ? 2 : 0,
        hasSeoMeta: true,
        sanitizedBody: { schemaVersion: 1, blocks: [] },
        sanitizedSeo: { titleOverride: "Desain Rumah Tropis Hemat Energi" },
      },
      {
        sourceId: "102",
        title: "Checklist Renovasi Kantor Modern",
        sourceStatus: "publish",
        importedStatus: "draft",
        publishedAt: null,
        sourceSlug: "checklist-renovasi-kantor-modern",
        targetSlug: "checklist-renovasi-kantor-modern",
        targetPostId: mode === "import" ? 12 : null,
        categories: ["Interior Kantor"],
        tags: ["Renovasi"],
        imageCount: 1,
        importedImageCount: 0,
        hasSeoMeta: true,
        sanitizedBody: { schemaVersion: 1, blocks: [] },
        sanitizedSeo: { titleOverride: "Checklist Renovasi Kantor Modern" },
      },
    ],
    media: [
      {
        sourceUrl: "https://cdn.nusantara-arsitek.co.id/fasad.jpg",
        status: mode === "import" ? "imported" : "dry_run_valid",
        mimeType: "image/webp",
        bytes: 122_880,
      },
      {
        sourceUrl: "https://cdn.nusantara-arsitek.co.id/denah.png",
        status: mode === "import" ? "imported" : "dry_run_valid",
        mimeType: "image/webp",
        bytes: 122_880,
      },
      {
        sourceUrl: "https://cdn.nusantara-arsitek.co.id/icon-script.svg",
        status: "rejected",
        reasonCode: "MEDIA_REJECTED",
        message: "Payload SVG diblokir demi keamanan.",
      },
    ],
    formerUrls: [
      {
        sourceUrl: "https://blog.nusantara-arsitek.co.id/2026/04/desain-rumah-tropis-hemat-energi/",
        sourcePath: "/2026/04/desain-rumah-tropis-hemat-energi/",
        sourceSlug: "desain-rumah-tropis-hemat-energi",
        targetSlug: "desain-rumah-tropis-hemat-energi",
        targetPath: "/blog/desain-rumah-tropis-hemat-energi",
        targetPostId: mode === "import" ? 11 : null,
        sourceStatus: "publish",
        importedStatus: "draft",
      },
      {
        sourceUrl: "https://blog.nusantara-arsitek.co.id/2026/05/checklist-renovasi-kantor-modern/",
        sourcePath: "/2026/05/checklist-renovasi-kantor-modern/",
        sourceSlug: "checklist-renovasi-kantor-modern",
        targetSlug: "checklist-renovasi-kantor-modern",
        targetPath: "/blog/checklist-renovasi-kantor-modern",
        targetPostId: mode === "import" ? 12 : null,
        sourceStatus: "publish",
        importedStatus: "draft",
      },
    ],
    warnings: [
      {
        code: "MEDIA_REJECTED",
        message: "Gambar icon-script.svg diblokir karena format SVG tidak diizinkan.",
        sourceUrl: "https://cdn.nusantara-arsitek.co.id/icon-script.svg",
      },
    ],
    createdAt: "2026-11-24T02:00:00.000Z",
    completedAt: "2026-11-24T02:00:02.000Z",
  };
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildWpImporterFixture();
  const { server, port } = await startStaticServer(outDir);
  const baseUrl = `http://127.0.0.1:${port}/wp-importer/`;

  const browser = await chromium.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.route("**/api/tenants/nusantara-arsitek/plugins/wp-importer/dry-run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ report: createMockReport("dry_run") }),
      });
    });

    await page.route("**/api/tenants/nusantara-arsitek/plugins/wp-importer/import", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ report: createMockReport("import") }),
      });
    });

    // 1. Desktop 1440px — Initial Wizard
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="wp-importer-wizard"]');

    const bannerText = await page.textContent('[data-testid="wp-importer-draft-only-banner"]');
    assert(
      bannerText && bannerText.includes("Semua konten diimpor sebagai Draf — tidak pernah tayang otomatis"),
      "Draft-only notice banner must be visible",
    );

    // Verify explicit htmlFor/id pairing on site URL input, base-nova ui slots, and zero Radix DOM attributes
    const labelFor = await page.getAttribute('label[for="wp-site-url"]', "for");
    assert(labelFor === "wp-site-url", "Explicit label htmlFor=wp-site-url required");

    const statusBadgeText = await page.textContent('[data-testid="wp-importer-status-badge"]');
    assert(
      statusBadgeText && statusBadgeText.includes("Gratis · Aktif"),
      "Dynamic plugin status badge must reflect pluginStatus prop",
    );

    const uiSlotCheck = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-slot="card"]').length,
      buttons: document.querySelectorAll('[data-slot="button"]').length,
      badges: document.querySelectorAll('[data-slot="badge"]').length,
      alerts: document.querySelectorAll('[data-slot="alert"]').length,
      radix: document.querySelectorAll("[data-radix-collection-item], [data-radix-popper-content-wrapper]").length,
    }));
    assert(uiSlotCheck.cards >= 3, "Expected base-nova Card primitives");
    assert(uiSlotCheck.buttons >= 3, "Expected base-nova Button primitives");
    assert(uiSlotCheck.badges >= 2, "Expected base-nova Badge primitives");
    assert(uiSlotCheck.alerts >= 1, "Expected base-nova Alert primitives");
    assert(uiSlotCheck.radix === 0, "Zero Radix DOM attributes allowed");

    const desktopOverflowInitial = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopOverflowInitial, "Desktop 1440px initial state must have zero horizontal overflow");

    await page.screenshot({
      path: path.join(screenshotDir, "wizard-initial-1440.png"),
      fullPage: true,
    });

    // 2. Desktop 1440px — Dry-Run Report
    await page.fill("#wp-site-url", "https://blog.nusantara-arsitek.co.id");
    await page.click('[data-testid="wp-importer-dry-run-btn"]');
    await page.waitForSelector('[data-testid="wp-importer-report"]');

    const reportText = await page.textContent('[data-testid="wp-importer-report"]');
    assert(reportText && reportText.includes("Laporan Pratinjau (Dry-Run)"), "Dry-run report heading missing");
    assert(reportText.includes("Draf (Belum Tayang)"), "Draft badge missing in post preview table");
    assert(reportText.includes("Inventaris URL Lama"), "Former-URL inventory section missing");
    assert(reportText.includes("/2026/04/desain-rumah-tropis-hemat-energi/"), "Old WP path missing");
    assert(reportText.includes("/blog/desain-rumah-tropis-hemat-energi"), "Target PunyaSitus path missing");
    assert(reportText.includes("MEDIA_REJECTED"), "Blocked SVG warning missing");

    const desktopOverflowReport = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopOverflowReport, "Desktop 1440px dry-run report must have zero horizontal overflow");

    await page.screenshot({
      path: path.join(screenshotDir, "wizard-dry-run-report-1440.png"),
      fullPage: true,
    });

    // 3. Desktop 1440px — Confirm Import as Drafts
    await page.click('[data-testid="wp-importer-execute-btn"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="wp-importer-notice"]');
      return Boolean(el && el.textContent && el.textContent.includes("berhasil diimpor sebagai Draf"));
    });

    await page.screenshot({
      path: path.join(screenshotDir, "wizard-import-complete-1440.png"),
      fullPage: true,
    });

    // 4. Mobile 360px — Dry-Run Report & WXR Upload Tab
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);

    const mobileOverflowInfo = await page.evaluate(() => {
      const offenders = [];
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1) {
          offenders.push({
            tag: el.tagName,
            id: el.id,
            testId: el.getAttribute("data-testid"),
            cls: String(el.className || "").slice(0, 80),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        offenders: offenders.slice(0, 8),
      };
    });
    assert(
      mobileOverflowInfo.scrollWidth <= mobileOverflowInfo.innerWidth,
      `Mobile 360px report view must have zero horizontal overflow (${JSON.stringify(mobileOverflowInfo)})`,
    );

    await page.screenshot({
      path: path.join(screenshotDir, "wizard-dry-run-report-360.png"),
      fullPage: true,
    });

    await page.click("#wp-tab-wxr");
    await page.waitForSelector("#wp-wxr-file");
    await page.waitForSelector("#wp-wxr-paste");

    const mobileOverflowWxr = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobileOverflowWxr, "Mobile 360px WXR tab must have zero horizontal overflow");

    await page.screenshot({
      path: path.join(screenshotDir, "wizard-wxr-tab-360.png"),
      fullPage: true,
    });

    assert(consoleErrors.length === 0, `Console errors found: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors found: ${pageErrors.join("; ")}`);

    console.log(
      `PASS tests/task-100/e2e.mjs — 360px & 1440px verified, 0 console/page errors, 0 horizontal overflow, screenshots saved to ${screenshotDir}`,
    );
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
