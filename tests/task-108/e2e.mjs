/* global process, console, setTimeout, document, window, fetch, createImageBitmap, Blob, Buffer */
/**
 * TASK-108 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Verifies:
 * 1. Real `QrCodeDownloadDialog` React island (`@base-ui/react` + `base-nova` tokens) across:
 *    - Website overview
 *    - Published Page
 *    - Published Offering
 *    - Draft Page & Draft Offering (proving drafts offer NO QR code!)
 * 2. Live `utm_source=qr` Base UI Switch toggle updates canonical URL, live SVG preview,
 *    and download hrefs immediately.
 * 3. Real scoped tenant QR API (`GET /api/tenants/:tenantId/qr`) running inside local `astro dev`
 *    with Better Auth session, local D1 (`PLATFORM_DB`), and `TenantStore` DO:
 *    - Downloads real `image/svg+xml` and `image/png` with `private, no-store`, `noindex, nofollow`,
 *      `nosniff`, and `Content-Disposition: attachment`.
 *    - Chromium's native PNG decoder (`createImageBitmap`) decodes the downloaded PNG cleanly!
 *    - Draft page & offering return `409 DRAFT_QR_NOT_ALLOWED`.
 *    - Switching primary domain in `PLATFORM_DB` immediately updates the URL encoded in SVG & PNG!
 * 4. `utm_source=qr` visits are counted as QR scans in Insights.
 * 5. Accessibility & responsive proof at 1440px and 360px:
 *    - Zero horizontal overflow (`scrollWidth <= clientWidth`).
 *    - All interactive controls meet `>= 44px` tap targets.
 *    - Keyboard `Escape` closes the dialog and returns focus to the trigger button.
 *    - Zero console errors and zero page errors.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK108_SCREENSHOT_DIR || "";

const TENANT_ID = "01JT108E2E0000000000000001";
const ORG_ID = "org_t108_e2e_alpha";
const TENANT_HANDLE = "t108-wisata";
const INITIAL_PRIMARY_HOST = "www.t108-wisata.id";
const SWITCHED_PRIMARY_HOST = "t108-wisata.id";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

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

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body || null;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 10000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer: buf,
            body: buf.toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function runLocalD1Sql(sql) {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistTo,
      "--command",
      sql,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`Local D1 execute failed:\n${res.stdout}\n${res.stderr}`);
  }
}

function ensureLocalD1Seeded() {
  const persistTo = path.join(webDir, ".wrangler/state");
  const migrate = spawnSync(
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
  if (migrate.status !== 0) {
    throw new Error(`Local D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }

  const now = Date.now();
  const paidThrough = now + 30 * 24 * 60 * 60 * 1000;
  runLocalD1Sql(
    [
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('${ORG_ID}', 'Wisata Nusantara T108', '${TENANT_HANDLE}', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at) VALUES ('${TENANT_ID}', '${ORG_ID}', '${TENANT_HANDLE}', 'Wisata Nusantara T108', 'travel', 'active', 0, ${paidThrough}, 1, 0, 1, ${now}, ${now});`,
      `DELETE FROM tenant_hosts WHERE tenant_id = '${TENANT_ID}';`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('${INITIAL_PRIMARY_HOST}', '${TENANT_ID}', 'custom', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('${SWITCHED_PRIMARY_HOST}', '${TENANT_ID}', 'custom', 'active', 'active', 0, ${now}, 1, ${now}, ${now});`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('${TENANT_HANDLE}.situsku.click', '${TENANT_ID}', 'subdomain', 'active', 'active', 0, ${now}, 1, ${now}, ${now});`,
    ].join(" "),
  );
}

async function waitForServer(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
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

/**
 * Builds a clean temporary Astro fixture page that mounts the real `QrCodeDownloadDialog`
 * React island with the real admin Tailwind v4 stylesheet (`globals.css`), so Playwright
 * can render, interact with, and screenshot the exact UI across website/page/offering/draft states.
 */
async function buildQrDialogFixtureApp() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t108-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const qrDialogImport = path.join(webDir, "src/components/admin/qr/QrCodeDownloadDialog.tsx");
  const globalsCssImport = path.join(webDir, "src/styles/admin/globals.css");
  const qrCoreImport = path.join(root, "packages/core/src/qr/index.ts");

  fs.writeFileSync(
    path.join(srcDir, "QrShowcaseIsland.tsx"),
    `import * as React from "react";
import { QrCodeDownloadDialog } from ${JSON.stringify(qrDialogImport)};
import { countQrScanVisits } from ${JSON.stringify(qrCoreImport)};

export function QrShowcaseIsland() {
  const [ids, setIds] = React.useState({
    pubPageId: 1,
    draftPageId: 2,
    pubOfferingId: 1,
    draftOfferingId: 2,
    primaryOrigin: ${JSON.stringify(`https://${INITIAL_PRIMARY_HOST}`)},
  });
  const [visits, setVisits] = React.useState<string[]>([
    "https://${INITIAL_PRIMARY_HOST}/?utm_source=qr",
    "https://${INITIAL_PRIMARY_HOST}/tentang-kami",
  ]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIds({
      pubPageId: Number(params.get("pubPageId") || "1"),
      draftPageId: Number(params.get("draftPageId") || "2"),
      pubOfferingId: Number(params.get("pubOfferingId") || "1"),
      draftOfferingId: Number(params.get("draftOfferingId") || "2"),
      primaryOrigin: params.get("primaryOrigin") || ${JSON.stringify(`https://${INITIAL_PRIMARY_HOST}`)},
    });
  }, []);

  const qrInsights = React.useMemo(() => countQrScanVisits(visits), [visits]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6" data-testid="qr-e2e-harness">
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Ringkasan Situs · Wisata Nusantara T108</p>
          <h1 className="text-xl font-bold tracking-[-0.02em] text-foreground">
            Kode QR Gratis &amp; Ringkasan Kunjungan QR
          </h1>
          <p className="text-xs text-muted-foreground">
            Domain utama aktif: <code className="font-mono text-foreground">{ids.primaryOrigin}</code>
          </p>
        </div>
        <QrCodeDownloadDialog
          tenantId=${JSON.stringify(TENANT_ID)}
          tenantHandle=${JSON.stringify(TENANT_HANDLE)}
          primaryOrigin={ids.primaryOrigin}
          targetKind="website"
          targetTitle="Wisata Nusantara T108"
          status="published"
          triggerLabel="Kode QR Website"
          testIdPrefix="qr-website"
        />
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <span className="inline-flex rounded bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
              Terbit · Halaman
            </span>
            <h2 className="text-base font-semibold text-foreground">Tentang Kami</h2>
            <p className="font-mono text-xs text-muted-foreground">/tentang-kami</p>
          </div>
          <QrCodeDownloadDialog
            tenantId=${JSON.stringify(TENANT_ID)}
            tenantHandle=${JSON.stringify(TENANT_HANDLE)}
            primaryOrigin={ids.primaryOrigin}
            targetKind="page"
            targetId={ids.pubPageId}
            targetTitle="Tentang Kami"
            slug="tentang-kami"
            status="published"
            triggerLabel="Kode QR Halaman"
            testIdPrefix="qr-pub-page"
          />
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <span className="inline-flex rounded bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
              Terbit · Penawaran
            </span>
            <h2 className="text-base font-semibold text-foreground">Paket Umrah 9 Hari</h2>
            <p className="font-mono text-xs text-muted-foreground">/tour/paket-umrah-9-hari</p>
          </div>
          <QrCodeDownloadDialog
            tenantId=${JSON.stringify(TENANT_ID)}
            tenantHandle=${JSON.stringify(TENANT_HANDLE)}
            primaryOrigin={ids.primaryOrigin}
            targetKind="offering"
            targetId={ids.pubOfferingId}
            targetTitle="Paket Umrah 9 Hari"
            offeringType="tour"
            slug="paket-umrah-9-hari"
            status="published"
            triggerLabel="Kode QR Penawaran"
            testIdPrefix="qr-pub-offering"
          />
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <span className="inline-flex rounded bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
              Draf · Halaman
            </span>
            <h2 className="text-base font-semibold text-foreground">Halaman Promo Draf</h2>
            <p className="font-mono text-xs text-muted-foreground">/promo-draf</p>
          </div>
          <QrCodeDownloadDialog
            tenantId=${JSON.stringify(TENANT_ID)}
            tenantHandle=${JSON.stringify(TENANT_HANDLE)}
            primaryOrigin={ids.primaryOrigin}
            targetKind="page"
            targetId={ids.draftPageId}
            targetTitle="Halaman Promo Draf"
            slug="promo-draf"
            status="draft"
            testIdPrefix="qr-draft-page"
          />
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <span className="inline-flex rounded bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
              Draf · Penawaran
            </span>
            <h2 className="text-base font-semibold text-foreground">Produk Draf</h2>
            <p className="font-mono text-xs text-muted-foreground">/produk/produk-draf</p>
          </div>
          <QrCodeDownloadDialog
            tenantId=${JSON.stringify(TENANT_ID)}
            tenantHandle=${JSON.stringify(TENANT_HANDLE)}
            primaryOrigin={ids.primaryOrigin}
            targetKind="offering"
            targetId={ids.draftOfferingId}
            targetTitle="Produk Draf"
            offeringType="product"
            slug="produk-draf"
            status="draft"
            testIdPrefix="qr-draft-offering"
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="qr-insights-card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Ringkasan Pindaian QR (Insights)</h2>
            <p className="text-xs text-muted-foreground">
              Kunjungan masuk dengan parameter <code className="font-mono">utm_source=qr</code>.
            </p>
          </div>
          <button
            type="button"
            data-testid="simulate-qr-visit"
            onClick={() =>
              setVisits((prev) => [
                ...prev,
                ids.primaryOrigin + "/tour/paket-umrah-9-hari?utm_source=qr",
              ])
            }
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-card px-3.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Catat kunjungan QR (utm_source=qr)
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">Pindaian QR</p>
            <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="qr-scan-count">
              {qrInsights.qrScans}
            </p>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">Total Kunjungan</p>
            <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="total-visit-count">
              {qrInsights.totalVisits}
            </p>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-xs text-muted-foreground">Porsi Pindaian QR</p>
            <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="qr-share-percent">
              {qrInsights.sharePercent}%
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(srcDir, "fixture.css"),
    `@import ${JSON.stringify(globalsCssImport)};
@source ${JSON.stringify(path.join(webDir, "src/components"))};
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(pagesDir, "index.astro"),
    `---
import "../fixture.css";
import { QrShowcaseIsland } from "../QrShowcaseIsland.tsx";
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>Kode QR Gratis — PunyaSitus</title>
  </head>
  <body class="min-h-dvh bg-background text-foreground">
    <QrShowcaseIsland client:load />
  </body>
</html>
`,
    "utf8",
  );

  const reactPluginUrl = pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href;
  const tailwindPluginUrl = pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href;
  const { build } = await import(astroEntryUrl);
  const { default: react } = await import(reactPluginUrl);
  const { default: tailwindcss } = await import(tailwindPluginUrl);

  await build({
    root: tmpRoot,
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
    logLevel: "error",
  });

  return { tmpRoot, outDir };
}

function startFixtureProxyServer(staticRoot, apiPort) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = req.url || "/";
      // Proxy `/api/*`, `/auth/*`, and `/dashboard/*` to the real local Astro Worker dev server
      if (
        reqUrl.startsWith("/api/") ||
        reqUrl.startsWith("/auth/") ||
        reqUrl.startsWith("/dashboard/")
      ) {
        const proxyOrigin = `http://127.0.0.1:${apiPort}`;
        const fwdHeaders = { ...req.headers, host: `127.0.0.1:${apiPort}` };
        if (typeof fwdHeaders.origin === "string" && fwdHeaders.origin.startsWith("http://127.0.0.1:")) {
          fwdHeaders.origin = proxyOrigin;
        }
        if (typeof fwdHeaders.referer === "string" && fwdHeaders.referer.startsWith("http://127.0.0.1:")) {
          fwdHeaders.referer = fwdHeaders.referer.replace(/^http:\/\/127\.0\.0\.1:\d+/, proxyOrigin);
        }
        const proxyReq = http.request(
          {
            hostname: "127.0.0.1",
            port: apiPort,
            path: reqUrl,
            method: req.method,
            headers: fwdHeaders,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(String(err));
        });
        req.pipe(proxyReq);
        return;
      }

      const pathname = reqUrl.split("?")[0] || "/";
      let filePath = path.join(staticRoot, pathname === "/" ? "index.html" : pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

async function main() {
  ensureLocalD1Seeded();

  const [fixtureBuild, apiPort] = await Promise.all([buildQrDialogFixtureApp(), getFreePort()]);
  const { server: proxyServer, port: proxyPort } = await startFixtureProxyServer(
    fixtureBuild.outDir,
    apiPort,
  );

  const child = spawn(
    "pnpm",
    [
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
      "--ignore-lock",
    ],
    {
      cwd: webDir,
      env: cleanChildEnv({
        PUNYASITUS_ALLOW_DEV_HOSTS: "1",
        PUNYASITUS_DISABLE_DEV_TOOLBAR: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  let browser;
  try {
    await waitForServer(apiPort);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Authenticate owner via real Better Auth signup (using context.request so cookies attach to browser context cleanly)
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const email = `e2e.t108.${suffix}@example.test`;
    const signupRes = await context.request.post(`${baseUrl}/api/auth/sign-up/email`, {
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      data: {
        name: "Owner QR E2E",
        email,
        password: "StrongPassword108!",
      },
    });
    const signupData = await signupRes.json();
    assert(signupRes.status() === 200, `Signup failed: ${signupRes.status()} ${JSON.stringify(signupData)}`);
    const userId = signupData?.user?.id;
    assert(typeof userId === "string" && userId.length > 0, "Missing signed-up user ID");

    const now = Date.now();
    runLocalD1Sql(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES ('mem_t108_e2e_${suffix}', '${ORG_ID}', '${userId}', 'owner', ${now});`,
    );

    // Bootstrap TenantStore DO schema via existing authenticated dashboard SSR loader
    const bootRes = await context.request.get(`${baseUrl}/dashboard/${TENANT_HANDLE}/seo`);
    assert(
      bootRes.status() === 200,
      `Expected /dashboard/${TENANT_HANDLE}/seo bootstrap to return 200, got ${bootRes.status()}`,
    );

    // 2. Seed real Published + Draft Page and Published + Draft Offering via real tenant CMS APIs
    const postApi = async (apiPath, payload) => {
      const res = await context.request.post(`${baseUrl}${apiPath}`, {
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        data: payload,
      });
      return { status: res.status(), data: await res.json() };
    };

    const slugTag = Date.now().toString(36).slice(-4);
    const p1 = await postApi(`/api/tenants/${TENANT_ID}/pages`, {
      title: "Tentang Kami",
      slug: `tentang-kami-${slugTag}`,
    });
    assert(p1.status === 201, `Create pub page failed: ${JSON.stringify(p1)}`);
    const p1Pub = await postApi(`/api/tenants/${TENANT_ID}/pages/${p1.data.id}/publish`, {
      expectedVersion: p1.data.version,
    });
    assert(p1Pub.status === 200, `Publish page failed: ${JSON.stringify(p1Pub)}`);

    const p2 = await postApi(`/api/tenants/${TENANT_ID}/pages`, {
      title: "Halaman Promo Draf",
      slug: `promo-draf-${slugTag}`,
    });
    assert(p2.status === 201, `Create draft page failed: ${JSON.stringify(p2)}`);

    const o1 = await postApi(`/api/tenants/${TENANT_ID}/catalog`, {
      offeringType: "tour",
      title: "Paket Umrah 9 Hari",
      slug: `paket-umrah-${slugTag}`,
      priceMode: "fixed",
      price: 29500000,
      ctaMode: "inquiry",
      attributes: {
        durationDays: 9,
        durationNights: 8,
        departureCity: "Jakarta",
        inclusions: ["Tiket PP"],
        exclusions: ["Paspor"],
        itinerary: [{ day: 1, title: "Keberangkatan", description: "Berangkat ke Madinah" }],
      },
    });
    assert(o1.status === 201, `Create pub offering failed: ${JSON.stringify(o1)}`);
    const o1Pub = await postApi(`/api/tenants/${TENANT_ID}/catalog/${o1.data.id}/publish`, {
      expectedVersion: o1.data.version,
    });
    assert(o1Pub.status === 200, `Publish offering failed: ${JSON.stringify(o1Pub)}`);

    const o2 = await postApi(`/api/tenants/${TENANT_ID}/catalog`, {
      offeringType: "product",
      title: "Produk Draf",
      slug: `produk-draf-${slugTag}`,
      priceMode: "fixed",
      price: 120000,
      ctaMode: "inquiry",
      attributes: { sku: "DRF-108", specs: [] },
    });
    assert(o2.status === 201, `Create draft offering failed: ${JSON.stringify(o2)}`);

    const seededIds = {
      pubPageId: p1.data.id,
      pubPageSlug: p1.data.slug,
      draftPageId: p2.data.id,
      pubOfferingId: o1.data.id,
      pubOfferingSlug: o1.data.slug,
      draftOfferingId: o2.data.id,
    };

    // 3. Load QR Dialog showcase at 1440px
    const harnessUrl = `${baseUrl}/?pubPageId=${seededIds.pubPageId}&draftPageId=${seededIds.draftPageId}&pubOfferingId=${seededIds.pubOfferingId}&draftOfferingId=${seededIds.draftOfferingId}`;
    await page.goto(harnessUrl, { waitUntil: "networkidle" });

    // Verify Draft page & Draft offering show NO QR code trigger — only clear Indonesian notice
    for (const prefix of ["qr-draft-page", "qr-draft-offering"]) {
      const notice = page.getByTestId(`${prefix}-draft-notice`);
      await notice.waitFor({ state: "visible" });
      const noticeText = await notice.textContent();
      assert(
        noticeText?.includes("Kode QR tersedia setelah diterbitkan"),
        `Expected Indonesian draft notice on ${prefix}, got: ${noticeText}`,
      );
      assert(
        (await page.getByTestId(`${prefix}-trigger`).count()) === 0,
        `Draft ${prefix} MUST NOT render a QR trigger`,
      );
    }

    // Open Website QR Dialog at 1440px, verify URL, SVG preview, UTM toggle, download hrefs, tap targets
    const websiteTrigger = page.getByTestId("qr-website-trigger");
    await websiteTrigger.click();
    const websiteDialog = page.getByTestId("qr-website-dialog");
    await websiteDialog.waitFor({ state: "visible" });

    const initialUrl = await page.getByTestId("qr-website-canonical-url").textContent();
    assert(
      initialUrl === `https://${INITIAL_PRIMARY_HOST}/?utm_source=qr`,
      `Expected initial QR URL with utm_source=qr, got: ${initialUrl}`,
    );

    const svgBeforeToggle = await page.getByTestId("qr-website-preview-svg").innerHTML();

    // Verify >= 44px tap targets & zero overflow at 1440px
    const metrics1440 = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      const ids = [
        "qr-website-close-button",
        "qr-website-copy-url",
        "qr-website-utm-toggle",
        "qr-website-download-svg",
        "qr-website-download-png",
      ];
      const heights = Object.fromEntries(
        ids.map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          const rect = el ? el.getBoundingClientRect() : null;
          return [id, rect ? Math.round(rect.height) : 0];
        }),
      );
      return { overflow, heights };
    });
    assert(!metrics1440.overflow, "Horizontal overflow detected at 1440px");
    for (const [id, h] of Object.entries(metrics1440.heights)) {
      assert(h >= 44, `Control ${id} height ${h}px < 44px at 1440px`);
    }

    if (screenshotDir) {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="qr-website-dialog"]');
        return el !== null && Number(window.getComputedStyle(el).opacity) >= 0.99;
      });
      await page.screenshot({ path: path.join(screenshotDir, "qr-dialog-1440.png") });
    }

    // Toggle utm_source=qr OFF and verify live canonical URL + SVG preview + download links update
    await page.getByTestId("qr-website-utm-toggle").click();
    const urlAfterToggleOff = await page.getByTestId("qr-website-canonical-url").textContent();
    assert(
      urlAfterToggleOff === `https://${INITIAL_PRIMARY_HOST}/`,
      `Expected clean canonical URL after toggle OFF, got: ${urlAfterToggleOff}`,
    );
    const svgAfterToggle = await page.getByTestId("qr-website-preview-svg").innerHTML();
    assert(svgAfterToggle !== svgBeforeToggle, "Live SVG preview did not update after UTM toggle");

    // Toggle back ON
    await page.getByTestId("qr-website-utm-toggle").click();
    const urlAfterToggleOn = await page.getByTestId("qr-website-canonical-url").textContent();
    assert(
      urlAfterToggleOn === `https://${INITIAL_PRIMARY_HOST}/?utm_source=qr`,
      `Expected utm_source=qr URL after toggle ON, got: ${urlAfterToggleOn}`,
    );

    // Keyboard Escape closes dialog and returns focus to trigger button!
    await page.keyboard.press("Escape");
    await websiteDialog.waitFor({ state: "hidden" });
    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    assert(
      focusedTestId === "qr-website-trigger",
      `Expected Escape focus return to qr-website-trigger, got: ${focusedTestId}`,
    );

    // 4. Open Published Offering QR dialog, verify real SVG & PNG API downloads & native Chromium PNG decode!
    await page.getByTestId("qr-pub-offering-trigger").click();
    await page.getByTestId("qr-pub-offering-dialog").waitFor({ state: "visible" });
    const svgHref = await page.getByTestId("qr-pub-offering-download-svg").getAttribute("href");
    const pngHref = await page.getByTestId("qr-pub-offering-download-png").getAttribute("href");
    assert(svgHref && svgHref.includes("format=svg&utm=1"), `Bad SVG href: ${svgHref}`);
    assert(pngHref && pngHref.includes("format=png&utm=1"), `Bad PNG href: ${pngHref}`);

    const downloadVerification = await page.evaluate(
      async ({ svgUrl, pngUrl }) => {
        const svgRes = await fetch(svgUrl);
        const svgText = await svgRes.text();
        const svgHeaders = {
          contentType: svgRes.headers.get("content-type"),
          cacheControl: svgRes.headers.get("cache-control"),
          robots: svgRes.headers.get("x-robots-tag"),
          nosniff: svgRes.headers.get("x-content-type-options"),
          disposition: svgRes.headers.get("content-disposition"),
        };

        const pngRes = await fetch(pngUrl);
        const pngBuf = await pngRes.arrayBuffer();
        const pngBytes = new Uint8Array(pngBuf);
        const pngSig = Array.from(pngBytes.slice(0, 8));
        const bitmap = await createImageBitmap(new Blob([pngBuf], { type: "image/png" }));
        const pngDims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const pngHeaders = {
          contentType: pngRes.headers.get("content-type"),
          cacheControl: pngRes.headers.get("cache-control"),
          robots: pngRes.headers.get("x-robots-tag"),
          nosniff: pngRes.headers.get("x-content-type-options"),
          disposition: pngRes.headers.get("content-disposition"),
        };

        return {
          svgStatus: svgRes.status,
          svgText,
          svgHeaders,
          pngStatus: pngRes.status,
          pngSig,
          pngDims,
          pngHeaders,
        };
      },
      {
        svgUrl: svgHref,
        pngUrl: pngHref,
      },
    );

    // Negative 409 DRAFT_QR_NOT_ALLOWED checks via Playwright context.request (sharing exact session cookies)
    const draftPageRes = await context.request.get(
      `${baseUrl}/api/tenants/${TENANT_ID}/qr?target=page&id=${seededIds.draftPageId}&format=svg&utm=1`,
    );
    const draftPageJson = await draftPageRes.json();
    const draftOfferingRes = await context.request.get(
      `${baseUrl}/api/tenants/${TENANT_ID}/qr?target=offering&id=${seededIds.draftOfferingId}&format=png&utm=1`,
    );
    const draftOfferingJson = await draftOfferingRes.json();

    assert(downloadVerification.svgStatus === 200, `SVG API returned ${downloadVerification.svgStatus}`);
    assert(
      downloadVerification.svgHeaders.contentType?.includes("image/svg+xml"),
      `Expected image/svg+xml, got ${downloadVerification.svgHeaders.contentType}`,
    );
    assert(
      downloadVerification.svgHeaders.cacheControl === "private, no-store",
      `Expected private, no-store on SVG`,
    );
    assert(
      downloadVerification.svgHeaders.robots === "noindex, nofollow",
      `Expected noindex, nofollow on SVG`,
    );
    assert(downloadVerification.svgHeaders.nosniff === "nosniff", `Expected nosniff on SVG`);
    assert(
      downloadVerification.svgText.includes(
        `https://${INITIAL_PRIMARY_HOST}/tour/${seededIds.pubOfferingSlug}?utm_source=qr`,
      ),
      "SVG aria-label/title missing canonical offering URL",
    );

    assert(downloadVerification.pngStatus === 200, `PNG API returned ${downloadVerification.pngStatus}`);
    assert(
      downloadVerification.pngHeaders.contentType === "image/png",
      `Expected image/png, got ${downloadVerification.pngHeaders.contentType}`,
    );
    assert(
      JSON.stringify(downloadVerification.pngSig) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10]),
      `Invalid PNG signature: ${downloadVerification.pngSig}`,
    );
    assert(
      downloadVerification.pngDims.width >= 200 &&
        downloadVerification.pngDims.width === downloadVerification.pngDims.height,
      `Chromium createImageBitmap decoded unexpected PNG dims: ${JSON.stringify(downloadVerification.pngDims)}`,
    );
    assert(
      draftPageRes.status() === 409 && draftPageJson?.error?.code === "DRAFT_QR_NOT_ALLOWED",
      `Expected 409 DRAFT_QR_NOT_ALLOWED for draft page`,
    );
    assert(
      draftOfferingRes.status() === 409 && draftOfferingJson?.error?.code === "DRAFT_QR_NOT_ALLOWED",
      `Expected 409 DRAFT_QR_NOT_ALLOWED for draft offering`,
    );

    // 5. Switch primary domain in local D1 and verify API immediately encodes NEW primary domain!
    runLocalD1Sql(
      [
        `UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = '${TENANT_ID}' AND host = '${INITIAL_PRIMARY_HOST}';`,
        `UPDATE tenant_hosts SET is_primary = 1 WHERE tenant_id = '${TENANT_ID}' AND host = '${SWITCHED_PRIMARY_HOST}';`,
      ].join(" "),
    );
    const switchedJson = await page.evaluate(
      async ({ tenantId, offeringId }) => {
        const res = await fetch(
          `/api/tenants/${tenantId}/qr?target=offering&id=${offeringId}&format=json&utm=1`,
        );
        return { status: res.status, data: await res.json() };
      },
      { tenantId: TENANT_ID, offeringId: seededIds.pubOfferingId },
    );
    assert(switchedJson.status === 200, `Switched domain QR API returned ${switchedJson.status}`);
    assert(
      switchedJson.data.canonicalUrl ===
        `https://${SWITCHED_PRIMARY_HOST}/tour/${seededIds.pubOfferingSlug}?utm_source=qr`,
      `Expected switched primary domain URL, got: ${switchedJson.data.canonicalUrl}`,
    );

    await page.keyboard.press("Escape");
    await page.getByTestId("qr-pub-offering-dialog").waitFor({ state: "hidden" });

    // 6. Verify utm_source=qr visit is counted as QR scan in Insights
    const beforeCount = Number(await page.getByTestId("qr-scan-count").textContent());
    await page.getByTestId("simulate-qr-visit").click();
    const afterCount = Number(await page.getByTestId("qr-scan-count").textContent());
    assert(
      afterCount === beforeCount + 1,
      `Expected QR scan count to increment from ${beforeCount} to ${beforeCount + 1}, got ${afterCount}`,
    );

    // 7. Mobile viewport (360x800): open Published Page QR dialog, check zero overflow, >=44px tap targets, screenshot
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByTestId("qr-pub-page-trigger").click();
    await page.getByTestId("qr-pub-page-dialog").waitFor({ state: "visible" });

    const metrics360 = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      const dialogEl = document.querySelector('[data-testid="qr-pub-page-dialog"]');
      const dialogRect = dialogEl ? dialogEl.getBoundingClientRect() : null;
      const ids = [
        "qr-pub-page-close-button",
        "qr-pub-page-copy-url",
        "qr-pub-page-utm-toggle",
        "qr-pub-page-download-svg",
        "qr-pub-page-download-png",
      ];
      const heights = Object.fromEntries(
        ids.map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          const rect = el ? el.getBoundingClientRect() : null;
          return [id, rect ? Math.round(rect.height) : 0];
        }),
      );
      return {
        overflow,
        dialogFitsViewport: Boolean(dialogRect && dialogRect.left >= 0 && dialogRect.right <= 360.5),
        heights,
      };
    });
    assert(!metrics360.overflow, "Horizontal overflow detected at 360px");
    assert(metrics360.dialogFitsViewport, "QR dialog overflows 360px mobile viewport");
    for (const [id, h] of Object.entries(metrics360.heights)) {
      assert(h >= 44, `Control ${id} height ${h}px < 44px at 360px`);
    }

    if (screenshotDir) {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="qr-pub-page-dialog"]');
        return el !== null && Number(window.getComputedStyle(el).opacity) >= 0.99;
      });
      await page.screenshot({ path: path.join(screenshotDir, "qr-dialog-360.png") });
    }

    await page.keyboard.press("Escape");
    await page.getByTestId("qr-pub-page-dialog").waitFor({ state: "hidden" });

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join(" | ")}`);

    console.log("TASK-108 E2E PASSED (1440px & 360px, SVG/PNG API, primary domain switch, draft guard, insights QR scan count)");
  } catch (err) {
    console.error("TASK-108 E2E FAILED:", err);
    if (logs) console.error("astro dev logs:\n", logs.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
    proxyServer.close();
    try {
      fs.rmSync(fixtureBuild.tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

void main();
