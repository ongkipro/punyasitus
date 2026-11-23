/* global process, console, Buffer, setTimeout, clearTimeout, document, window, getComputedStyle, fetch, URL */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;
const astroReactEntryUrl = pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href;
const tailwindViteEntryUrl = pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href;

const SCREENSHOT_DIR = process.env.TASK105_SCREENSHOT_DIR || "/tmp/qa-task-105";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const UPDATED_SUPPORT_WA_INPUT = "0812-9876-5432";
const UPDATED_SUPPORT_WA_NORMALIZED = "6281298765432";
const UPDATED_SUPPORT_HOURS = "Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB";
const UPDATED_RESPONSE_TARGET = "< 2 jam kerja";

function decodeBase32(base32Input) {
  const clean = base32Input.trim().toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  const out = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) throw new Error(`Invalid base32 char: ${clean[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function generateTotpCode(base32Secret, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const hmac = crypto.createHmac("sha1", decodeBase32(base32Secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_settings' LIMIT 1")
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

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method: "GET", timeout: 10_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, "/auth/two-factor");
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

async function captureScreenshot(page, filename) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fullPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  return fullPath;
}

async function assertViewportLayout(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll("main button, main a[href], main input, main select"),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 28) || "",
          height: Math.round(rect.height),
        };
      });
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
    `[${label} @ ${width}px] Horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize >= 14,
    `[${label} @ ${width}px] Root font size too small (${metrics.htmlFontSize}px)`,
  );

  if (width <= 400) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

/**
 * Builds a real Astro static fixture mounting `DashboardLayout.astro` +
 * `DashboardSupportButton` + `DashboardSupportCard` + `DashboardHelpLink`
 * fed with the exact `platform_settings` saved from `/console/settings` in D1.
 */
async function buildDashboardSupportFixtures(savedPlatformSettings) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t105-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutPath = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const supportPanelPath = path.join(webDir, "src/components/admin/help/DashboardSupportPanel.tsx");
  const helpLinkPath = path.join(webDir, "src/components/admin/help/DashboardHelpLink.tsx");
  const cardPath = path.join(webDir, "src/components/ui/card.tsx");
  const badgePath = path.join(webDir, "src/components/ui/badge.tsx");
  const supportCorePath = path.join(root, "packages/core/src/support/index.ts");

  const platformPageSource = `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutPath)};
import { DashboardSupportButton, DashboardSupportCard } from ${JSON.stringify(supportPanelPath)};
import { DashboardHelpLink } from ${JSON.stringify(helpLinkPath)};
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from ${JSON.stringify(cardPath)};
import { Badge } from ${JSON.stringify(badgePath)};
import { resolveDashboardSupportModel } from ${JSON.stringify(supportCorePath)};

const platformSettings = ${JSON.stringify(savedPlatformSettings)};
const support = resolveDashboardSupportModel({
  handle: "kopi-nusantara",
  screen: "settings_domains",
  platformSettings,
});
const noisySupport = resolveDashboardSupportModel({
  handle: "kopi-nusantara",
  screen: "Domain Kustom password=TopSecret999 csrf_token=tok_secret_12345 visitor@example.com +6281399990000",
  platformSettings,
});
---
<DashboardLayout
  title="Domain Kustom & Dukungan"
  surface="dashboard"
  workspaceName="Kopi Nusantara"
  workspaceSubtitle="kopi-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/kopi-nusantara"
  offeringLabel="Produk"
  unreadLeadsCount={2}
  lifecycleStatus="active"
  publicSiteHref="https://kopi-nusantara.situsku.click"
>
  <div class="space-y-6" data-testid="dashboard-support-platform-page">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Domain Kustom &amp; DNS
          </h1>
          <Badge variant="outline">Langganan Aktif</Badge>
        </div>
        <p class="text-sm text-muted-foreground">
          Hubungkan domain resmi bisnis Anda dengan SSL otomatis.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <DashboardHelpLink
          client:load
          screen="settings_domains"
          variant="popover"
          support={support}
          align="end"
        />
        <DashboardSupportButton
          client:load
          support={support}
          label="Bantuan WA"
          align="end"
        />
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Status Domain Situs</CardTitle>
          <CardDescription>Domain utama aktif dengan sertifikat SSL otomatis.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Domain utama: <strong class="text-foreground">kopinusantara.id</strong></p>
          <p>Handle situs: <code class="font-mono text-foreground">kopi-nusantara</code></p>
          <p class="text-xs" data-testid="sanitized-noisy-preview">{noisySupport.prefilledMessage}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catatan DNS Terverifikasi</CardTitle>
          <CardDescription>CNAME dan TXT diverifikasi otomatis oleh Cloudflare.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Status SSL: <strong class="text-foreground">Aktif (TLS 1.3)</strong></p>
          <p>Pengalihan www: <strong class="text-foreground">308 ke domain utama</strong></p>
        </CardContent>
      </Card>
    </div>
  </div>
</DashboardLayout>
`;

  const agencyPageSource = `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutPath)};
import { DashboardSupportButton, DashboardSupportCard } from ${JSON.stringify(supportPanelPath)};
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from ${JSON.stringify(cardPath)};
import { Badge } from ${JSON.stringify(badgePath)};
import { resolveDashboardSupportModel } from ${JSON.stringify(supportCorePath)};

const platformSettings = ${JSON.stringify(savedPlatformSettings)};
const agencySupport = resolveDashboardSupportModel({
  handle: "klinik-harapan",
  screen: "offering",
  platformSettings,
  agencyContact: {
    agencyId: "agn_nusantara_01",
    agencyName: "Agensi Digital Nusantara",
    whatsappNumber: "0813-5555-1234",
    email: "bantuan@agensinusantara.id",
    supportHours: "Senin–Sabtu, 08:30–18:00 WIB",
    responseTarget: "Maksimal 1 jam kerja",
  },
});
---
<DashboardLayout
  title="Katalog Penawaran — Klien Agensi"
  surface="dashboard"
  workspaceName="Klinik Harapan"
  workspaceSubtitle="klinik-harapan.situsku.click"
  activeNavId="offerings"
  basePath="/dashboard/klinik-harapan"
  offeringLabel="Layanan"
  unreadLeadsCount={1}
  lifecycleStatus="active"
  publicSiteHref="https://klinik-harapan.situsku.click"
>
  <div class="space-y-6" data-testid="dashboard-support-agency-page">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Katalog Penawaran
          </h1>
          <Badge variant="info">Situs Klien Agensi</Badge>
        </div>
        <p class="text-sm text-muted-foreground">
          Kelola layanan klinik dan hubungi agensi pengelola bila membutuhkan bantuan.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <DashboardSupportButton
          client:load
          support={agencySupport}
          label="Bantuan Agensi"
          align="end"
        />
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Daftar Layanan Klinik</CardTitle>
          <CardDescription>Layanan konsultasi dan pemeriksaan rutin.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Pengelola situs: <strong class="text-foreground">Agensi Digital Nusantara</strong></p>
          <p>Handle situs: <code class="font-mono text-foreground">klinik-harapan</code></p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ringkasan Katalog Aktif</CardTitle>
          <CardDescription>12 layanan aktif dengan tombol konsultasi WhatsApp.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Kategori utama: <strong class="text-foreground">Pemeriksaan Umum &amp; Gigi</strong></p>
          <p>Status publikasi: <strong class="text-foreground">Terbit</strong></p>
        </CardContent>
      </Card>
    </div>
  </div>
</DashboardLayout>
`;

  fs.writeFileSync(path.join(pagesDir, "platform.astro"), platformPageSource, "utf8");
  fs.writeFileSync(path.join(pagesDir, "agency.astro"), agencyPageSource, "utf8");

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
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", `http://127.0.0.1:${port}`).pathname;
      const cleanRel = reqPath.replace(/^\/+|\/+$/g, "");
      const candidates = cleanRel
        ? [path.resolve(outDir, cleanRel), path.resolve(outDir, cleanRel, "index.html")]
        : [path.resolve(outDir, "platform", "index.html")];

      let filePath = null;
      for (const candidate of candidates) {
        if (
          candidate.startsWith(path.resolve(outDir)) &&
          fs.existsSync(candidate) &&
          fs.statSync(candidate).isFile()
        ) {
          filePath = candidate;
          break;
        }
      }

      if (!filePath) {
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
  const fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`;
  const capturedScreenshots = [];

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
  let fixtureTmpRoot;

  try {
    await waitForServer(port);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const opEmail = `t105-op-${uniqueSuffix}@example.com`;
    const password = "SupportOpPassword!234";

    // =========================================================================
    // 1. Live Console Settings: sign up operator, enroll 2FA, edit support WA/hours/target
    // =========================================================================
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await opCtx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const opSignUp = await page.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Operator Dukungan" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(opSignUp.ok, `Operator sign-up failed (${opSignUp.status})`);

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const localDb = new DatabaseSync(sqlitePath);
    try {
      localDb
        .prepare("UPDATE users SET email_verified = 1 WHERE lower(email) = ?")
        .run(opEmail.toLowerCase());
    } finally {
      localDb.close();
    }

    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-105 Chromium E2E trusted operator bootstrap",
        "--db-file",
        sqlitePath,
        "--local",
      ],
      { cwd: root, env: cleanChildEnv(), encoding: "utf8" },
    );
    assert(
      cliRes.status === 0,
      `scripts/platform-operator.mjs failed:\n${cliRes.stdout}\n${cliRes.stderr}`,
    );

    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    const totpCode = generateTotpCode(manualSecret);
    await page.fill("#twofa-confirm-code", totpCode);
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // Edit support settings on /console/settings (with 1 retry if Vite SSR triggers cold dep reload)
    await page.setViewportSize({ width: 1440, height: 900 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(`${baseUrl}/console/settings`, { waitUntil: "networkidle" });
      const found = await page.locator('[data-testid="platform-settings-form"]').count();
      if (found > 0) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForSelector('[data-testid="platform-settings-form"]');
    await page.waitForSelector('[data-testid="console-support-preview-card"]');

    await page.fill("#settings-sales-whatsapp", UPDATED_SUPPORT_WA_INPUT);
    await page.fill("#settings-support-email", "dukungan@punyasitus.com");
    await page.fill("#settings-terms-url", "https://punyasitus.com/syarat-ketentuan");
    await page.fill("#settings-privacy-url", "https://punyasitus.com/kebijakan-privasi");
    await page.fill("#settings-support-hours", UPDATED_SUPPORT_HOURS);
    await page.fill("#settings-response-target", UPDATED_RESPONSE_TARGET);
    await page.fill(
      "#settings-audit-reason",
      "Memperbarui nomor WA dukungan, jam layanan, dan target respons untuk TASK-105",
    );

    // Live preview updates before save
    const previewHours = (await page.textContent('[data-testid="console-support-preview-hours"]')) ?? "";
    const previewTarget = (await page.textContent('[data-testid="console-support-preview-target"]')) ?? "";
    const previewLinkHref = await page.getAttribute('[data-testid="console-support-preview-link"]', "href");
    assert(previewHours.includes(UPDATED_SUPPORT_HOURS), `Preview hours mismatch: ${previewHours}`);
    assert(previewTarget.includes(UPDATED_RESPONSE_TARGET), `Preview target mismatch: ${previewTarget}`);
    assert(
      previewLinkHref?.startsWith(`https://wa.me/${UPDATED_SUPPORT_WA_NORMALIZED}?text=`),
      `Unexpected preview WA link: ${previewLinkHref}`,
    );

    await page.click('[data-testid="settings-save-button"]');
    await page.waitForSelector('[data-testid="settings-success-alert"]');

    const normalizedWaVal = await page.inputValue("#settings-sales-whatsapp");
    assert(
      normalizedWaVal === UPDATED_SUPPORT_WA_NORMALIZED,
      `Expected normalized ${UPDATED_SUPPORT_WA_NORMALIZED}, got ${normalizedWaVal}`,
    );

    await assertViewportLayout(page, "console-support-settings", 1440);
    capturedScreenshots.push(await captureScreenshot(page, "console-support-settings-1440.png"));

    // Verify D1 persistence + platform_audit row
    const verifyDb = new DatabaseSync(sqlitePath, { readOnly: true });
    let savedPlatformSettings;
    try {
      const settingsRow = verifyDb
        .prepare("SELECT value_json FROM platform_settings WHERE key = 'platform.public_settings' LIMIT 1")
        .get();
      assert(settingsRow && typeof settingsRow.value_json === "string", "Expected saved platform_settings row");
      savedPlatformSettings = { ...JSON.parse(settingsRow.value_json), configured: true };
      assert(
        savedPlatformSettings.salesWhatsapp === UPDATED_SUPPORT_WA_NORMALIZED &&
          savedPlatformSettings.supportHours === UPDATED_SUPPORT_HOURS &&
          savedPlatformSettings.supportResponseTarget === UPDATED_RESPONSE_TARGET,
        `Persisted platform_settings mismatch: ${JSON.stringify(savedPlatformSettings)}`,
      );

      const auditRow = verifyDb
        .prepare(
          "SELECT action, reason FROM platform_audit WHERE action = 'platform_settings.update' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      assert(
        auditRow && String(auditRow.reason).includes("TASK-105"),
        `Expected platform_audit row for TASK-105 settings update, got ${JSON.stringify(auditRow)}`,
      );
    } finally {
      verifyDb.close();
    }

    assert(consoleErrors.length === 0, `Console settings console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Console settings page errors: ${pageErrors.join(" | ")}`);
    await opCtx.close();

    // =========================================================================
    // 2. Build & serve real Dashboard Support Fixtures (Platform & Agency-First)
    // =========================================================================
    const fixture = await buildDashboardSupportFixtures(savedPlatformSettings);
    fixtureTmpRoot = fixture.tmpRoot;
    fixtureServer = await startStaticFixtureServer(fixture.outDir, fixturePort);

    // 2a. Platform support dashboard (1440px & 360px)
    const dashCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dashPage = await dashCtx.newPage();
    const dashConsoleErrors = [];
    const dashPageErrors = [];
    dashPage.on("console", (msg) => {
      if (msg.type() === "error") dashConsoleErrors.push(msg.text());
    });
    dashPage.on("pageerror", (err) => dashPageErrors.push(String(err)));

    await dashPage.goto(`${fixtureBaseUrl}/platform`, { waitUntil: "load" });
    await dashPage.waitForSelector('[data-testid="dashboard-support-platform-page"]');
    await dashPage.waitForSelector('[data-testid="dashboard-support-trigger"]');

    // Keyboard open + Escape close + focus return
    await dashPage.focus('[data-testid="dashboard-support-trigger"]');
    await dashPage.keyboard.press("Enter");
    await dashPage.waitForSelector('[data-testid="dashboard-support-panel"]');

    const platformWaHref = await dashPage
      .locator('[data-testid="dashboard-support-panel"] [data-testid="support-whatsapp-cta"]')
      .getAttribute("href");
    assert(platformWaHref, "Expected platform WhatsApp CTA href inside support panel");
    const parsedPlatformWa = new URL(platformWaHref);
    assert(
      parsedPlatformWa.origin === "https://wa.me" &&
        parsedPlatformWa.pathname === `/${UPDATED_SUPPORT_WA_NORMALIZED}`,
      `Unexpected platform WA URL: ${platformWaHref}`,
    );
    const platformWaText = parsedPlatformWa.searchParams.get("text") ?? "";
    assert(
      platformWaText ===
        "Halo, saya butuh bantuan untuk situs kopi-nusantara, halaman Domain Kustom & DNS.",
      `Unexpected platform WA text: ${platformWaText}`,
    );

    // Check published hours and response target rendered from console-saved settings
    const renderedHours =
      (await dashPage
        .locator('[data-testid="dashboard-support-panel"] [data-testid="support-hours-value"]')
        .textContent()) ?? "";
    const renderedTarget =
      (await dashPage
        .locator('[data-testid="dashboard-support-panel"] [data-testid="support-response-target-value"]')
        .textContent()) ?? "";
    assert(renderedHours.includes(UPDATED_SUPPORT_HOURS), `Rendered hours mismatch: ${renderedHours}`);
    assert(renderedTarget.includes(UPDATED_RESPONSE_TARGET), `Rendered target mismatch: ${renderedTarget}`);

    // Verify noisy hostile screen string leaked zero secrets/PII
    const noisySanitized =
      (await dashPage.textContent('[data-testid="sanitized-noisy-preview"]')) ?? "";
    for (const forbidden of ["TopSecret999", "tok_secret_12345", "visitor@example.com", "6281399990000"]) {
      assert(!noisySanitized.includes(forbidden), `Leaked secret/PII "${forbidden}" in ${noisySanitized}`);
    }

    await assertViewportLayout(dashPage, "dashboard-support-platform", 1440);
    capturedScreenshots.push(
      await captureScreenshot(dashPage, "dashboard-support-platform-1440.png"),
    );

    // Escape closes and returns focus
    await dashPage.keyboard.press("Escape");
    assert(
      (await dashPage.locator('[data-testid="dashboard-support-panel"]').count()) === 0,
      "Expected Escape to close dashboard support panel",
    );
    const activeAfterEsc = await dashPage.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    );
    assert(
      activeAfterEsc === "dashboard-support-trigger",
      `Expected focus return to dashboard-support-trigger, got ${activeAfterEsc}`,
    );

    // 360px mobile viewport with panel open
    await dashPage.setViewportSize({ width: 360, height: 800 });
    await dashPage.click('[data-testid="dashboard-support-trigger"]');
    await dashPage.waitForSelector('[data-testid="dashboard-support-panel"]');
    const mobilePanelBox = await dashPage
      .locator('[data-testid="dashboard-support-panel"]')
      .boundingBox();
    assert(
      mobilePanelBox && mobilePanelBox.x >= 0 && mobilePanelBox.x + mobilePanelBox.width <= 360,
      `Support panel clipped at 360px: ${JSON.stringify(mobilePanelBox)}`,
    );
    await assertViewportLayout(dashPage, "dashboard-support-platform", 360);
    capturedScreenshots.push(
      await captureScreenshot(dashPage, "dashboard-support-platform-360.png"),
    );

    // 2b. Agency-managed client website (1440px & 360px)
    await dashPage.setViewportSize({ width: 1440, height: 900 });
    await dashPage.goto(`${fixtureBaseUrl}/agency`, { waitUntil: "load" });
    await dashPage.waitForSelector('[data-testid="dashboard-support-agency-page"]');
    await dashPage.click('[data-testid="dashboard-support-trigger"]');
    await dashPage.waitForSelector('[data-testid="dashboard-support-panel"]');

    const agencyPanel = dashPage.locator('[data-testid="dashboard-support-panel"]');
    const agencyNameText =
      (await agencyPanel.locator('[data-testid="support-agency-name"]').textContent()) ?? "";
    assert(
      agencyNameText.includes("Agensi Digital Nusantara"),
      `Expected agency name first, got ${agencyNameText}`,
    );

    const agencyWaHref = await agencyPanel
      .locator('[data-testid="support-agency-whatsapp-cta"]')
      .getAttribute("href");
    assert(agencyWaHref, "Expected agency WhatsApp CTA href");
    const parsedAgencyWa = new URL(agencyWaHref);
    assert(
      parsedAgencyWa.origin === "https://wa.me" && parsedAgencyWa.pathname === "/6281355551234",
      `Unexpected agency WA URL: ${agencyWaHref}`,
    );
    assert(
      parsedAgencyWa.searchParams.get("text") ===
        "Halo, saya butuh bantuan untuk situs klinik-harapan, halaman Katalog Penawaran.",
      `Unexpected agency WA prefilled text: ${parsedAgencyWa.searchParams.get("text")}`,
    );

    // Verify agency primary section is visually ABOVE platform fallback section
    const agencySectionBox = await agencyPanel
      .locator('[data-testid="support-agency-primary-section"]')
      .boundingBox();
    const fallbackSectionBox = await agencyPanel
      .locator('[data-testid="support-platform-fallback-section"]')
      .boundingBox();
    assert(
      agencySectionBox &&
        fallbackSectionBox &&
        agencySectionBox.y < fallbackSectionBox.y,
      `Expected agency contact visually above platform fallback: agency=${JSON.stringify(agencySectionBox)}, fallback=${JSON.stringify(fallbackSectionBox)}`,
    );

    await assertViewportLayout(dashPage, "dashboard-support-agency", 1440);
    capturedScreenshots.push(
      await captureScreenshot(dashPage, "dashboard-support-agency-1440.png"),
    );

    // 360px mobile viewport for agency-managed site
    await dashPage.setViewportSize({ width: 360, height: 800 });
    const mobileAgencyBox = await agencyPanel.boundingBox();
    assert(
      mobileAgencyBox && mobileAgencyBox.x >= 0 && mobileAgencyBox.x + mobileAgencyBox.width <= 360,
      `Agency support panel clipped at 360px: ${JSON.stringify(mobileAgencyBox)}`,
    );
    await assertViewportLayout(dashPage, "dashboard-support-agency", 360);
    capturedScreenshots.push(
      await captureScreenshot(dashPage, "dashboard-support-agency-360.png"),
    );

    assert(dashConsoleErrors.length === 0, `Dashboard console errors: ${dashConsoleErrors.join(" | ")}`);
    assert(dashPageErrors.length === 0, `Dashboard page errors: ${dashPageErrors.join(" | ")}`);
    await dashCtx.close();

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-105",
        platformWhatsapp: UPDATED_SUPPORT_WA_NORMALIZED,
        supportHours: UPDATED_SUPPORT_HOURS,
        responseTarget: UPDATED_RESPONSE_TARGET,
        screenshots: capturedScreenshots,
      }),
    );
  } catch (err) {
    console.error("TASK-105 E2E FAILED:", err);
    if (serverLogs) {
      console.error("--- astro dev logs ---\n", serverLogs.slice(-3000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixtureServer) fixtureServer.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 4000);
      server.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (fixtureTmpRoot && fs.existsSync(fixtureTmpRoot)) {
      fs.rmSync(fixtureTmpRoot, { recursive: true, force: true });
    }
  }
}

await run();
