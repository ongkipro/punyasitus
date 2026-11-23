/* global process, console, setTimeout, document, window, getComputedStyle, URL */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;
const astroReactEntryUrl = pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href;
const tailwindViteEntryUrl = pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href;

const SCREENSHOT_DIR = process.env.TASK104_SCREENSHOT_DIR || "/tmp/punyasitus-t104-screenshots";
const MAX_MARKETING_JS_GZIP_BYTES = 25 * 1024;
const TARGET_ARTICLE_SLUG = "menghubungkan-domain-kustom-dan-dns";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function cleanChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (
      key === "AI_AGENT" ||
      key === "CLAUDECODE" ||
      key === "CODEX_SANDBOX" ||
      key.startsWith("ANTIGRAVITY_")
    ) {
      delete env[key];
    }
  }
  return env;
}

function findSqliteFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSqliteFiles(full, out);
    } else if (entry.name.endsWith(".sqlite")) {
      out.push(full);
    }
  }
  return out;
}

function findPlatformSqlitePath(persistDir) {
  const candidates = findSqliteFiles(persistDir).sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  );
  for (const file of candidates) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marketing_funnel_events' LIMIT 1",
        )
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(`Could not locate migrated PLATFORM_DB sqlite file under ${persistDir}`);
}

function ensureLocalD1Migrated() {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistTo,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`Local D1 migrations failed:\n${res.stdout}\n${res.stderr}`);
  }
  return persistTo;
}

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/bantuan");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`astro dev did not become ready on port ${port}`);
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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function assertViewportLayout(page, label, width, checkMobileTapTargets = true) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const interactive = Array.from(
      document.querySelectorAll(
        "header a[href], header summary, main a[href], main button, main summary",
      ),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          !el.classList.contains("mk-skip-link") &&
          !el.classList.contains("sr-only")
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const isInlineTextLink =
          el.tagName === "A" &&
          !el.classList.contains("mk-btn") &&
          !el.classList.contains("mk-nav-link") &&
          !el.classList.contains("mk-brand") &&
          !el.classList.contains("bh-pill") &&
          !el.classList.contains("bh-read-link") &&
          el.closest("p, li, aside, td, nav.bh-breadcrumb, h3, h4") !== null;
        return {
          tag: el.tagName,
          id: el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 32) || "",
          height: Math.round(rect.height),
          isInlineTextLink,
        };
      });
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      interactive,
    };
  });

  assert(
    !metrics.overflow,
    `[${label} @ ${width}px] Horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize >= 14,
    `[${label} @ ${width}px] Root font size too small (${metrics.htmlFontSize}px)`,
  );

  if (checkMobileTapTargets && width <= 400) {
    for (const ctrl of metrics.interactive) {
      if (ctrl.isInlineTextLink) continue;
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile tap target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

async function captureScreenshot(page, filename) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fullPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  return fullPath;
}

/**
 * Builds an isolated static Astro fixture mounting the REAL `DashboardLayout.astro` +
 * REAL `DashboardHelpLink.tsx` (`base-nova` + Tailwind v4 admin CSS) without touching any
 * production files outside Allowed Paths.
 */
async function buildRealDashboardHelpFixture(liveHelpBaseUrl) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t104-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutPath = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const helpLinkPath = path.join(webDir, "src/components/admin/help/DashboardHelpLink.tsx");
  const helpAstroPath = path.join(webDir, "src/components/admin/help/DashboardHelpLink.astro");
  const cardPath = path.join(webDir, "src/components/ui/card.tsx");
  const badgePath = path.join(webDir, "src/components/ui/badge.tsx");

  const pageSource = `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutPath)};
import { DashboardHelpLink } from ${JSON.stringify(helpLinkPath)};
import DashboardHelpLinkStatic from ${JSON.stringify(helpAstroPath)};
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from ${JSON.stringify(cardPath)};
import { Badge } from ${JSON.stringify(badgePath)};

const helpBaseUrl = ${JSON.stringify(liveHelpBaseUrl)};
---
<DashboardLayout
  title="Domain Kustom & Bantuan"
  surface="dashboard"
  workspaceName="Kopi Nusantara"
  workspaceSubtitle="kopi-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/kopi-nusantara"
  offeringLabel="Produk"
  unreadLeadsCount={3}
  lifecycleStatus="active"
  publicSiteHref="https://kopi-nusantara.situsku.click"
>
  <div class="space-y-6" data-testid="dashboard-help-fixture-page">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Pengaturan Domain &amp; DNS
          </h1>
          <Badge variant="outline">Langganan Aktif</Badge>
        </div>
        <p class="text-sm text-muted-foreground">
          Hubungkan domain bisnis Anda (.id, .co.id, atau .com) dengan SSL otomatis.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <DashboardHelpLink
          client:load
          screen="settings_domains"
          variant="popover"
          helpBaseUrl={helpBaseUrl}
          openInNewTab={false}
          align="end"
        />
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div class="space-y-1">
            <CardTitle>Katalog Produk &amp; Penawaran</CardTitle>
            <CardDescription>Kelola daftar produk, harga Rupiah, dan tombol WhatsApp.</CardDescription>
          </div>
          <DashboardHelpLink
            client:load
            screen="offering"
            variant="icon"
            helpBaseUrl={helpBaseUrl}
            openInNewTab={false}
          />
        </CardHeader>
        <CardContent>
          <p class="text-sm text-muted-foreground">
            Tambahkan foto WebP dan harga pasti/mulai dari untuk mempermudah calon pembeli.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div class="space-y-1">
            <CardTitle>Tagihan &amp; Kuitansi PDF</CardTitle>
            <CardDescription>Bayar via QRIS/VA dan unduh kuitansi resmi bernomor.</CardDescription>
          </div>
          <DashboardHelpLinkStatic
            screen="receipts"
            helpBaseUrl={helpBaseUrl}
            openInNewTab={false}
          />
        </CardHeader>
        <CardContent>
          <p class="text-sm text-muted-foreground">
            Setiap pembayaran lunas otomatis menerbitkan Bukti Pembayaran Layanan PDF.
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</DashboardLayout>
`;

  fs.writeFileSync(path.join(pagesDir, "index.astro"), pageSource, "utf8");

  const { build } = await import(astroEntryUrl);
  const { default: react } = await import(astroReactEntryUrl);
  const { default: tailwindcss } = await import(tailwindViteEntryUrl);

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
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

function startStaticFixtureServer(outDir, port) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", `http://127.0.0.1:${port}`).pathname;
      const safeRel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
      const filePath = path.resolve(outDir, safeRel);
      if (!filePath.startsWith(path.resolve(outDir)) || !fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function run() {
  const persistDir = ensureLocalD1Migrated();
  const port = await getFreePort();
  const fixturePort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;

  const server = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(port), "--ignore-lock"],
    {
      cwd: webDir,
      env: cleanChildEnv({ PUNYASITUS_DISABLE_DEV_TOOLBAR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  server.stdout.on("data", (d) => (serverLogs += d.toString()));
  server.stderr.on("data", (d) => (serverLogs += d.toString()));

  let browser;
  let fixtureServer;
  let fixtureTmpRoot = "";
  const capturedScreenshots = [];

  try {
    await waitForServer(port);
    const sqlitePath = findPlatformSqlitePath(persistDir);

    // Clear prior help_article_open counter rows for deterministic open-count assertion
    const initDb = new DatabaseSync(sqlitePath);
    try {
      initDb
        .prepare("DELETE FROM marketing_funnel_events WHERE event_name = 'help_article_open'")
        .run();
    } finally {
      initDb.close();
    }

    // -------------------------------------------------------------------------
    // 1. Direct HTTP checks on real public `/bantuan` routes:
    //    - Host: punyasitus.com -> HTTP 200 (marketing apex rewrite)
    //    - Host: www.punyasitus.com -> 308 https://punyasitus.com/bantuan...
    //    - Host: alpha.situsku.click -> never renders marketing help center
    //    - Missing slug -> 404 with noindex & default-src 'none' CSP
    // -------------------------------------------------------------------------
    const apexIndexRes = await httpRequest(port, "/bantuan", {
      headers: { Host: "punyasitus.com" },
    });
    assert(
      apexIndexRes.status === 200,
      `Expected 200 for Host: punyasitus.com /bantuan, got ${apexIndexRes.status}`,
    );
    assert(
      apexIndexRes.headers["x-punyasitus-surface"] === "marketing",
      `Expected X-PunyaSitus-Surface: marketing on apex /bantuan, got ${apexIndexRes.headers["x-punyasitus-surface"]}`,
    );
    assert(
      apexIndexRes.body.includes("Pusat Bantuan PunyaSitus"),
      "Expected Help Center content on Host: punyasitus.com /bantuan",
    );

    const apexArticleRes = await httpRequest(
      port,
      `/bantuan/${TARGET_ARTICLE_SLUG}?from=dashboard`,
      { headers: { Host: "punyasitus.com" } },
    );
    assert(
      apexArticleRes.status === 200,
      `Expected 200 for Host: punyasitus.com /bantuan/${TARGET_ARTICLE_SLUG}, got ${apexArticleRes.status}`,
    );
    assert(
      apexArticleRes.body.includes("Cara Menghubungkan Domain Kustom"),
      "Expected live article content on Host: punyasitus.com /bantuan/<slug>",
    );

    const wwwRes = await httpRequest(port, `/bantuan/${TARGET_ARTICLE_SLUG}?from=dashboard`, {
      headers: { Host: "www.punyasitus.com" },
    });
    assert(
      wwwRes.status === 308 &&
        wwwRes.headers.location ===
          `https://punyasitus.com/bantuan/${TARGET_ARTICLE_SLUG}?from=dashboard`,
      `Expected 308 apex redirect for www.punyasitus.com/bantuan/..., got status=${wwwRes.status} location=${wwwRes.headers.location}`,
    );
    assert(!wwwRes.headers["set-cookie"], "www redirect must not set cookies");

    const tenantHostRes = await httpRequest(port, "/bantuan", {
      headers: { Host: "alpha.situsku.click" },
    });
    assert(
      tenantHostRes.status === 404 && !tenantHostRes.body.includes("Pusat Bantuan PunyaSitus"),
      `Expected tenant host /bantuan to never render marketing help center, got status=${tenantHostRes.status}`,
    );
    assert(
      tenantHostRes.headers["x-robots-tag"] === "noindex, nofollow",
      `Expected noindex on tenant 404, got ${tenantHostRes.headers["x-robots-tag"]}`,
    );
    assert(!tenantHostRes.headers["set-cookie"], "Tenant 404 must not set cookies");

    const missingSlugRes = await httpRequest(port, "/bantuan/slug-tidak-ada-xyz");
    assert(
      missingSlugRes.status === 404,
      `Expected 404 for missing help slug, got ${missingSlugRes.status}`,
    );
    assert(
      missingSlugRes.headers["x-robots-tag"] === "noindex, nofollow",
      "Missing help article must be noindex",
    );
    assert(
      missingSlugRes.headers["content-security-policy"] === "default-src 'none'",
      `Expected CSP default-src 'none' on missing help article 404, got ${missingSlugRes.headers["content-security-policy"]}`,
    );

    // Reset help_article_open rows after the Host: punyasitus.com probe so browser counts are clean
    const resetDb = new DatabaseSync(sqlitePath);
    try {
      resetDb
        .prepare("DELETE FROM marketing_funnel_events WHERE event_name = 'help_article_open'")
        .run();
    } finally {
      resetDb.close();
    }

    // Build real Dashboard Help Icon fixture pointing to live local public `/bantuan` URL
    const builtFixture = await buildRealDashboardHelpFixture(`${baseUrl}/bantuan`);
    fixtureTmpRoot = builtFixture.tmpRoot;
    fixtureServer = await startStaticFixtureServer(builtFixture.outDir, fixturePort);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // -------------------------------------------------------------------------
    // 2. Help Center Index & Article (with JS enabled: budget, zero cookies, zero 3p, 1440 & 360)
    // -------------------------------------------------------------------------
    const mkCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await mkCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const thirdPartyRequests = [];
    const loadedMarketingScripts = new Map();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      const host = new URL(url).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        thirdPartyRequests.push(url);
      }
    });
    page.on("response", async (res) => {
      try {
        const url = res.url();
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (
          (ct.includes("javascript") || url.endsWith(".js")) &&
          !url.includes("@vite/client") &&
          !url.includes("/@fs/") &&
          !url.includes("astro/dist/runtime")
        ) {
          const buf = await res.body();
          loadedMarketingScripts.set(url, zlib.gzipSync(buf).byteLength);
        }
      } catch {
        // ignore aborted bodies
      }
    });

    // 2a. Help Center Index @ 1440 & 360
    const idxResp = await page.goto(`${baseUrl}/bantuan`, { waitUntil: "load" });
    assert(idxResp && idxResp.status() === 200, `Expected 200 on /bantuan`);
    assert(
      idxResp.headers()["x-punyasitus-surface"] === "marketing",
      "Expected X-PunyaSitus-Surface: marketing on /bantuan",
    );
    const idxRobots = await page.getAttribute('meta[name="robots"]', "content");
    assert(idxRobots === "index, follow", `Expected index, follow on help index, got ${idxRobots}`);
    const idxCanonical = await page.getAttribute('link[rel="canonical"]', "href");
    assert(
      idxCanonical === "https://punyasitus.com/bantuan",
      `Expected canonical https://punyasitus.com/bantuan, got ${idxCanonical}`,
    );

    const cardCount = await page.locator('[data-testid^="help-card-"]').count();
    assert(cardCount >= 20, `Expected >= 20 help articles on index, found ${cardCount}`);

    await assertViewportLayout(page, "help-index", 1440);
    capturedScreenshots.push(await captureScreenshot(page, "help-index-1440.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayout(page, "help-index", 360);
    capturedScreenshots.push(await captureScreenshot(page, "help-index-360.png"));

    // Server-side search check
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.fill('[data-testid="help-search-input"]', "QRIS");
    await Promise.all([
      page.waitForURL(/\/bantuan\?q=QRIS/),
      page.click('[data-testid="help-search-submit"]'),
    ]);
    const qrisCards = await page.locator('[data-testid^="help-card-"]').count();
    assert(qrisCards >= 2, `Expected >= 2 articles matching QRIS, found ${qrisCards}`);

    // 2b. Help Article Page @ 1440 & 360
    const articleResp = await page.goto(
      `${baseUrl}/bantuan/${TARGET_ARTICLE_SLUG}?from=marketing`,
      { waitUntil: "load" },
    );
    assert(articleResp && articleResp.status() === 200, "Expected 200 on help article page");
    const artRobots = await page.getAttribute('meta[name="robots"]', "content");
    assert(artRobots === "index, follow", `Expected index, follow on article, got ${artRobots}`);
    const artCanonical = await page.getAttribute('link[rel="canonical"]', "href");
    assert(
      artCanonical === `https://punyasitus.com/bantuan/${TARGET_ARTICLE_SLUG}`,
      `Unexpected article canonical: ${artCanonical}`,
    );

    const jsonLdRaw = await page.locator('script[type="application/ld+json"]').allTextContents();
    const hasArticleSchema = jsonLdRaw.some(
      (txt) => txt.includes('"@type":"Article"') && txt.includes('"@type":"BreadcrumbList"'),
    );
    assert(hasArticleSchema, "Expected Article + BreadcrumbList JSON-LD on help article page");

    const tocCount = await page.locator('[data-testid="help-article-toc"] a').count();
    assert(tocCount >= 2, `Expected server-rendered TOC links, found ${tocCount}`);

    await assertViewportLayout(page, "help-article", 1440);
    capturedScreenshots.push(await captureScreenshot(page, "help-article-1440.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayout(page, "help-article", 360);
    capturedScreenshots.push(await captureScreenshot(page, "help-article-360.png"));

    // Verify ZERO cookies, ZERO 3p requests, <= 25 KiB gzipped JS
    const marketingCookies = await mkCtx.cookies();
    assert(
      marketingCookies.length === 0,
      `Expected ZERO cookies on Help Center, found ${JSON.stringify(marketingCookies)}`,
    );
    assert(
      thirdPartyRequests.length === 0,
      `Expected ZERO third-party requests on Help Center, found ${thirdPartyRequests.join(", ")}`,
    );
    const totalMarketingJsGzipBytes = Array.from(loadedMarketingScripts.values()).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    assert(
      totalMarketingJsGzipBytes <= MAX_MARKETING_JS_GZIP_BYTES,
      `Help Center gzipped JS ${totalMarketingJsGzipBytes} bytes exceeds 25 KiB budget`,
    );
    assert(consoleErrors.length === 0, `Help Center console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Help Center page errors: ${pageErrors.join(" | ")}`);
    await mkCtx.close();

    // -------------------------------------------------------------------------
    // 3. JavaScript DISABLED verification + Privacy-Preserving Open Counter check
    // -------------------------------------------------------------------------
    const noJsCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();

    const noJsIndexRes = await noJsPage.goto(`${baseUrl}/bantuan?kategori=pembayaran`, {
      waitUntil: "load",
    });
    assert(noJsIndexRes && noJsIndexRes.status() === 200, "Help index must work with JS disabled");
    const payCards = await noJsPage.locator('[data-testid^="help-card-"]').count();
    assert(payCards >= 3, `Expected >= 3 payment articles with JS disabled, found ${payCards}`);

    const noJsArticleRes = await noJsPage.goto(
      `${baseUrl}/bantuan/${TARGET_ARTICLE_SLUG}?from=dashboard`,
      { waitUntil: "load" },
    );
    assert(
      noJsArticleRes && noJsArticleRes.status() === 200,
      "Help article must render cleanly with JS disabled",
    );
    const noJsTitle = (await noJsPage.textContent('[data-testid="help-article-title"]'))?.trim();
    assert(
      noJsTitle && noJsTitle.includes("Domain"),
      `Expected full article title with JS disabled, got: ${noJsTitle}`,
    );
    const noJsCookies = await noJsCtx.cookies();
    assert(noJsCookies.length === 0, "Zero cookies allowed with JS disabled");
    await noJsCtx.close();

    // Verify server-side cookieless open count recorded in local SQLite without PII
    const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
    let openCounterRows;
    try {
      openCounterRows = verifyDb
        .prepare(
          `SELECT id, day, event_name, utm_source, utm_medium, utm_campaign, count
           FROM marketing_funnel_events
           WHERE event_name = 'help_article_open' AND utm_campaign = ?`,
        )
        .all(TARGET_ARTICLE_SLUG);
    } finally {
      verifyDb.close();
    }
    const dashboardRow = openCounterRows.find((r) => r.utm_source === "dashboard");
    const marketingRow = openCounterRows.find((r) => r.utm_source === "marketing");
    assert(
      dashboardRow && Number(dashboardRow.count) >= 1,
      `Expected dashboard open count >= 1 in marketing_funnel_events, rows=${JSON.stringify(openCounterRows)}`,
    );
    assert(
      marketingRow && Number(marketingRow.count) >= 1,
      `Expected marketing open count >= 1 in marketing_funnel_events, rows=${JSON.stringify(openCounterRows)}`,
    );

    // -------------------------------------------------------------------------
    // 4. Real Dashboard Help Icon Fixture (`DashboardLayout` + `DashboardHelpLink`) @ 1440 & 360
    // -------------------------------------------------------------------------
    const dashCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dashPage = await dashCtx.newPage();
    const dashConsoleErrors = [];
    const dashPageErrors = [];
    dashPage.on("console", (msg) => {
      if (msg.type() === "error") dashConsoleErrors.push(msg.text());
    });
    dashPage.on("pageerror", (err) => dashPageErrors.push(String(err)));

    const dashResp = await dashPage.goto(`${fixtureUrl}/`, { waitUntil: "load" });
    assert(dashResp && dashResp.status() === 200, "Expected 200 on Dashboard Help fixture");
    await dashPage.waitForSelector('[data-testid="dashboard-help-trigger-settings_domains"]');

    // Keyboard activation: focus trigger -> press Enter -> popover opens -> Escape closes & returns focus
    await dashPage.focus('[data-testid="dashboard-help-trigger-settings_domains"]');
    await dashPage.keyboard.press("Enter");
    await dashPage.waitForSelector('[data-testid="dashboard-help-popover-settings_domains"]');

    const popoverLinkHref = await dashPage.getAttribute(
      '[data-testid="dashboard-help-article-cta-settings_domains"]',
      "href",
    );
    assert(
      popoverLinkHref === `${baseUrl}/bantuan/${TARGET_ARTICLE_SLUG}?from=dashboard`,
      `Unexpected dashboard help popover href: ${popoverLinkHref}`,
    );

    const assertPopoverInViewport = async (vpLabel) => {
      const box = await dashPage
        .locator('[data-testid="dashboard-help-popover-settings_domains"]')
        .boundingBox();
      const vpWidth = await dashPage.evaluate(() => window.innerWidth);
      assert(box !== null, `[${vpLabel}] Expected visible popover bounding box`);
      assert(
        box.x >= 0 && box.x + box.width <= vpWidth,
        `[${vpLabel}] Help popover clipped outside viewport: x=${box.x}, width=${box.width}, viewport=${vpWidth}`,
      );
    };

    await assertViewportLayout(dashPage, "dashboard-help-icon", 1440, false);
    await assertPopoverInViewport("dashboard-help-icon-1440");
    capturedScreenshots.push(await captureScreenshot(dashPage, "dashboard-help-icon-1440.png"));

    // Escape closes popover and returns focus to trigger button
    await dashPage.keyboard.press("Escape");
    const popoverAfterEsc = await dashPage
      .locator('[data-testid="dashboard-help-popover-settings_domains"]')
      .count();
    assert(popoverAfterEsc === 0, "Expected Escape to close dashboard help popover");
    const focusedAfterEsc = await dashPage.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    );
    assert(
      focusedAfterEsc === "dashboard-help-trigger-settings_domains",
      `Expected focus return to help trigger after Escape, got ${focusedAfterEsc}`,
    );

    // 360px mobile viewport check with popover opened
    await dashPage.setViewportSize({ width: 360, height: 800 });
    await dashPage.click('[data-testid="dashboard-help-trigger-settings_domains"]');
    await dashPage.waitForSelector('[data-testid="dashboard-help-popover-settings_domains"]');
    await assertViewportLayout(dashPage, "dashboard-help-icon", 360, false);
    await assertPopoverInViewport("dashboard-help-icon-360");
    capturedScreenshots.push(await captureScreenshot(dashPage, "dashboard-help-icon-360.png"));

    // Clicking the live help CTA navigates to the real Help Center article (HTTP 200)!
    const [navResp] = await Promise.all([
      dashPage.waitForNavigation({ waitUntil: "load" }),
      dashPage.click('[data-testid="dashboard-help-article-cta-settings_domains"]'),
    ]);
    assert(navResp && navResp.status() === 200, "Dashboard help link must resolve to HTTP 200");
    const resolvedTitle = (await dashPage.textContent('[data-testid="help-article-title"]'))?.trim();
    assert(
      resolvedTitle && resolvedTitle.includes("Domain"),
      `Expected live domain help article after click, got ${resolvedTitle}`,
    );

    assert(
      dashConsoleErrors.length === 0,
      `Dashboard help fixture console errors: ${dashConsoleErrors.join(" | ")}`,
    );
    assert(
      dashPageErrors.length === 0,
      `Dashboard help fixture page errors: ${dashPageErrors.join(" | ")}`,
    );
    await dashCtx.close();

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-104",
        articleCount: cardCount,
        marketingJsGzipBytes: totalMarketingJsGzipBytes,
        maxMarketingJsGzipBytes: MAX_MARKETING_JS_GZIP_BYTES,
        marketingCookiesCount: marketingCookies.length,
        thirdPartyRequestsCount: thirdPartyRequests.length,
        openCounterRows,
        screenshots: capturedScreenshots,
      }),
    );
  } catch (err) {
    console.error("TASK-104 E2E FAILED:", err);
    if (serverLogs) {
      console.error("--- astro dev logs ---\n", serverLogs.slice(-3000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (fixtureServer) fixtureServer.close();
    server.kill("SIGTERM");
    if (fixtureTmpRoot && fs.existsSync(fixtureTmpRoot)) {
      fs.rmSync(fixtureTmpRoot, { recursive: true, force: true });
    }
  }
}

run();
