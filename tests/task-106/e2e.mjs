/* global process, console, Buffer, setTimeout, document, window, getComputedStyle, fetch */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const statusDir = path.join(root, "apps/status");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const SCREENSHOT_DIR = process.env.TASK106_SCREENSHOT_DIR || "";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_operators' LIMIT 1")
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
      { hostname: "127.0.0.1", port, path: pathname, method: "GET", timeout: 4000 },
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

async function waitForServer(port, timeoutMs = 30_000) {
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

function startStaticStatusServer(distDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
      const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
      const resolved = path.resolve(distDir, `.${cleanPath}`);
      if (!resolved.startsWith(distDir) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(resolved);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
      fs.createReadStream(resolved).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
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

async function assertViewportLayoutAndTouchTargets(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll("header button, header a[href], main button, main a[href], main input, main select, footer a[href]"),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
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

async function maybeCaptureScreenshot(page, filename) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
}

async function run() {
  // =========================================================================
  // 1. Build & serve standalone static status page (zero apps/web dependency)
  // =========================================================================
  const statusBuild = spawnSync("node", ["scripts/build.mjs"], {
    cwd: statusDir,
    env: cleanChildEnv(),
    encoding: "utf8",
  });
  assert(
    statusBuild.status === 0,
    `apps/status build failed:\n${statusBuild.stdout}\n${statusBuild.stderr}`,
  );
  const statusDistDir = path.join(statusDir, "dist");
  const { server: statusServer, url: statusUrl } = await startStaticStatusServer(statusDistDir);

  const persistDir = ensureLocalD1Migrated();
  const webPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${webPort}`;

  const webServer = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--ignore-lock"],
    {
      cwd: webDir,
      env: cleanChildEnv({ PUNYASITUS_DISABLE_DEV_TOOLBAR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  webServer.stdout.on("data", (d) => (serverLogs += d.toString()));
  webServer.stderr.on("data", (d) => (serverLogs += d.toString()));

  let browser;
  try {
    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // =========================================================================
    // 2. Verify standalone status page (zero-JS + JS enabled @ 1440px & 360px)
    // =========================================================================
    const noJsCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();
    const noJsRes = await noJsPage.goto(`${statusUrl}/`, { waitUntil: "domcontentloaded" });
    assert(noJsRes && noJsRes.status() === 200, `Status page returned ${noJsRes?.status()}`);
    const noJsText = (await noJsPage.textContent("body")) ?? "";
    for (const label of [
      "Semua Sistem Beroperasi Normal",
      "Situs Publik",
      "Dashboard & CMS",
      "Domain & SSL",
      "Pembayaran & Perpanjangan",
      "Notifikasi Email",
      "Riwayat Insiden Terbaru",
    ]) {
      assert(noJsText.includes(label), `Zero-JS status page missing "${label}"`);
    }
    await noJsCtx.close();

    const statusCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const statusPage = await statusCtx.newPage();
    const statusConsoleErrors = [];
    const statusPageErrors = [];
    statusPage.on("console", (msg) => {
      if (msg.type() === "error") statusConsoleErrors.push(msg.text());
    });
    statusPage.on("pageerror", (err) => statusPageErrors.push(String(err)));

    await statusPage.goto(`${statusUrl}/`, { waitUntil: "networkidle" });
    await statusPage.waitForSelector('[data-testid="status-overall-banner"]');
    await statusPage.click("[data-refresh-status]");
    await statusPage.waitForFunction(() => {
      const el = document.querySelector("[data-last-checked]");
      return Boolean(el && el.textContent && el.textContent.includes("Diperiksa pada"));
    });
    await assertViewportLayoutAndTouchTargets(statusPage, "status-page", 1440);
    await maybeCaptureScreenshot(statusPage, "status-page-1440.png");

    await statusPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(statusPage, "status-page", 360);
    await maybeCaptureScreenshot(statusPage, "status-page-360.png");

    assert(statusConsoleErrors.length === 0, `Status page console errors: ${statusConsoleErrors.join("; ")}`);
    assert(statusPageErrors.length === 0, `Status page uncaught errors: ${statusPageErrors.join("; ")}`);
    await statusCtx.close();

    // =========================================================================
    // 3. Wait for apps/web & sign in as 2FA-verified platform operator
    // =========================================================================
    await waitForServer(webPort);

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const opEmail = `t106-op-${uniqueSuffix}@example.com`;
    const password = "IncidentOpPassword!234";

    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await opCtx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signUp = await page.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Operator Insiden" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(signUp.ok, `Operator sign-up failed (${signUp.status})`);

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const tenantHandle = `t106-toko-${Date.now().toString(36).slice(-6)}`;
    const orgId = `org_${Date.now().toString(36)}`;
    const memberId = `mem_${Date.now().toString(36)}`;
    const tenantId = `ten_${Date.now().toString(36)}`;
    const nowMs = Date.now();

    const localDb = new DatabaseSync(sqlitePath);
    try {
      const userRow = localDb
        .prepare("SELECT id FROM users WHERE lower(email) = ? LIMIT 1")
        .get(opEmail.toLowerCase());
      assert(userRow && userRow.id, `Expected signed-up user row for ${opEmail}`);
      const opUserId = String(userRow.id);

      localDb
        .prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
        .run(opUserId);

      // Verify migration 0007_platform_incidents.sql was applied via wrangler d1 migrations apply
      const hasIncidentsTable = localDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_incidents'")
        .get();
      assert(
        Boolean(hasIncidentsTable),
        "Expected platform_incidents table from migration 0007_platform_incidents.sql",
      );
      // Ensure clean active incident state for deterministic banner assertion
      localDb
        .prepare("UPDATE platform_incidents SET status = 'resolved', banner_visible = 0 WHERE status != 'resolved'")
        .run();

      // Seed a real active tenant owned by the signed-in user so we test the REAL `/dashboard/[handle]` route
      localDb
        .prepare(
          "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(orgId, "Toko Uji Insiden", tenantHandle, nowMs, nowMs);
      localDb
        .prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
        )
        .run(memberId, orgId, opUserId, nowMs);
      localDb
        .prepare(
          `INSERT INTO tenants (
            id, organization_id, handle, name, vertical, status, operator_hold,
            paid_through, cache_version, schema_version, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 0, 1, ?, ?)`,
        )
        .run(
          tenantId,
          orgId,
          tenantHandle,
          "Toko Uji Insiden",
          nowMs + 30 * 24 * 60 * 60 * 1000,
          nowMs,
          nowMs,
        );
      localDb
        .prepare(
          `INSERT INTO tenant_hosts (
            host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
          ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
        )
        .run(`${tenantHandle}.situsku.click`, tenantId, nowMs, nowMs);
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
        "Automated TASK-106 Chromium E2E trusted operator bootstrap",
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

    // Enroll & verify TOTP 2FA via UI
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(manualSecret.length >= 16, "Expected valid Base32 secret during 2FA enrollment");
    await page.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // =========================================================================
    // 4. Before declaring: REAL /dashboard/[handle] banner must NOT appear
    // =========================================================================
    const dashboardUrl = `${baseUrl}/dashboard/${tenantHandle}`;
    const dashBeforeRes = await page.goto(dashboardUrl, { waitUntil: "networkidle" });
    if (!dashBeforeRes || dashBeforeRes.status() !== 200) {
      const bodyPreview = await dashBeforeRes?.text().catch(() => "") ?? "";
      console.error(`--- Non-200 dashboard response (${dashBeforeRes?.status()}) ---\n${bodyPreview.slice(0, 1500)}`);
      console.error(`--- astro dev logs ---\n${serverLogs.slice(-3000)}`);
    }
    assert(
      dashBeforeRes && dashBeforeRes.status() === 200,
      `Expected 200 on real dashboard ${dashboardUrl}, got ${dashBeforeRes?.status()}`,
    );
    const bannerBeforeCount = await page.locator('[data-testid="dashboard-incident-banner"]').count();
    assert(
      bannerBeforeCount === 0,
      `Expected 0 active banners on ${dashboardUrl} before declaring, found ${bannerBeforeCount}`,
    );

    // =========================================================================
    // 5. Console Incidents UI: Declare incident -> banner appears
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/incidents`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-incidents-page"]');
    const ctxBanner = (await page.textContent('[data-testid="console-context-banner"]')) ?? "";
    assert(
      ctxBanner.includes("Console Operasional Platform") &&
        ctxBanner.includes("bukan penyamaran akun tenant"),
      `Missing privileged console context banner: ${ctxBanner}`,
    );

    const incidentTitle = "Keterlambatan konfirmasi pembayaran QRIS sementara";
    const incidentSummary =
      "Sebagian transaksi QRIS membutuhkan waktu verifikasi hingga 10 menit. Situs publik pelanggan tetap berjalan normal sementara tim memulihkan jalur rekonsiliasi.";

    await page.fill("#incident-title", incidentTitle);
    await page.selectOption("#incident-severity", "major");
    await page.click('[data-testid="component-toggle-billing_payments"]');
    await page.fill("#incident-summary", incidentSummary);
    await page.click('[data-testid="declare-incident-submit"]');
    await page.waitForSelector('[data-testid="incidents-success-banner"]');
    await page.waitForSelector('[data-testid="active-incidents-list"]');

    const activeListText = (await page.textContent('[data-testid="active-incidents-list"]')) ?? "";
    assert(activeListText.includes(incidentTitle), "Declared incident missing from active list");
    await assertViewportLayoutAndTouchTargets(page, "console-incidents", 1440);
    await maybeCaptureScreenshot(page, "console-incidents-1440.png");

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-incidents", 360);

    // =========================================================================
    // 6. REAL /dashboard/[handle] at 360px & 1440px -> banner visible!
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(dashboardUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="dashboard-incident-banner"]');
    const bannerText = (await page.textContent('[data-testid="dashboard-incident-banner"]')) ?? "";
    assert(bannerText.includes(incidentTitle), "Dashboard banner missing incident title");
    assert(bannerText.includes(incidentSummary), "Dashboard banner missing incident summary");
    const statusHref = await page.getAttribute('[data-testid="dashboard-incident-status-link"]', "href");
    assert(statusHref === "https://status.punyasitus.com", `Unexpected status link href: ${statusHref}`);
    await assertViewportLayoutAndTouchTargets(page, "dashboard-incident-banner", 360);
    await maybeCaptureScreenshot(page, "dashboard-incident-banner-360.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    await assertViewportLayoutAndTouchTargets(page, "dashboard-incident-banner", 1440);

    // =========================================================================
    // 7. Resolve incident -> REAL /dashboard/[handle] banner disappears completely!
    // =========================================================================
    await page.goto(`${baseUrl}/console/incidents`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="active-incidents-list"]');
    await page.locator('[data-testid^="resolve-incident-btn-"]').first().click();
    await page.locator('[data-testid^="confirm-resolve-btn-"]').first().click();
    await page.waitForSelector('[data-testid="active-incidents-empty"]');
    await page.waitForSelector('[data-testid="no-active-banner-state"]');

    await page.goto(dashboardUrl, { waitUntil: "networkidle" });
    const bannerAfterCount = await page.locator('[data-testid="dashboard-incident-banner"]').count();
    assert(
      bannerAfterCount === 0,
      `Expected 0 active banners on ${dashboardUrl} after resolving, found ${bannerAfterCount}`,
    );

    assert(consoleErrors.length === 0, `Console errors during E2E: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Uncaught page errors during E2E: ${pageErrors.join("; ")}`);

    console.log("PASS: TASK-106 Chromium E2E (standalone status page + console incidents + dashboard banner lifecycle)");
  } finally {
    if (browser) await browser.close();
    statusServer.close();
    webServer.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!webServer.killed) webServer.kill("SIGKILL");
    if (process.exitCode && process.exitCode !== 0 && serverLogs) {
      console.error("--- astro dev logs ---\n" + serverLogs);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
