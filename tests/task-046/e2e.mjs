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
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const SCREENSHOT_DIR = process.env.TASK046_SCREENSHOT_DIR || "/tmp/punyasitus-t046-screenshots";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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
      document.querySelectorAll("main button, main a[href], main input, main select"),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 24) || "",
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
      if (ctrl.tag === "BUTTON" || ctrl.tag === "A" || ctrl.tag === "INPUT" || ctrl.tag === "SELECT") {
        assert(
          ctrl.height >= 44,
          `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
        );
      }
    }
  }
}

async function captureScreenshot(page, filename) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const targetPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: targetPath, fullPage: true });
  return targetPath;
}

async function run() {
  const persistDir = ensureLocalD1Migrated();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

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
  const savedScreenshots = [];

  try {
    await waitForServer(port);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const uniqueSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 9_000 + 1_000)}`;
    const nonOpEmail = `t046-nonop-${uniqueSuffix}@example.com`;
    const opEmail = `t046-op-${uniqueSuffix}@example.com`;
    const tenantHandle = `t046-biz-${uniqueSuffix}`.slice(0, 32);
    const tenantName = `PT Karya Uji ${uniqueSuffix.slice(-4)}`;
    const ownerEmail = `owner-${uniqueSuffix}@karya-uji.id`;
    const password = "ConsoleOpPassword!234";

    // =========================================================================
    // 1. Permission Denial: Non-operator / tenant user gets 403 on /console/tenants & API
    // =========================================================================
    const nonOpCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const nonOpPage = await nonOpCtx.newPage();
    await nonOpPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const nonOpSignUp = await nonOpPage.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Pemilik Tenant Non-Op" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: nonOpEmail, pwd: password },
    );
    assert(nonOpSignUp.ok, `Non-operator sign-up failed (${nonOpSignUp.status})`);

    const deniedPageResp = await nonOpPage.goto(`${baseUrl}/console/tenants`, {
      waitUntil: "domcontentloaded",
    });
    assert(
      deniedPageResp && deniedPageResp.status() === 403,
      `Expected 403 for non-operator on /console/tenants, got ${deniedPageResp?.status()}`,
    );

    const deniedApiStatus = await nonOpPage.evaluate(async () => {
      const res = await fetch("/api/console/tenants", { credentials: "same-origin" });
      return res.status;
    });
    assert(
      deniedApiStatus === 403,
      `Expected 403 for non-operator on /api/console/tenants, got ${deniedApiStatus}`,
    );
    await nonOpCtx.close();

    // =========================================================================
    // 2. Bootstrap operator via trusted CLI & enroll real 2FA via UI
    // =========================================================================
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await opCtx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    let allowExpectedHttpErrors = false;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          allowExpectedHttpErrors &&
          (text.includes("status of 409") || text.includes("status of 422"))
        ) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const opSignUp = await page.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Superadmin T046" }),
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
        "Automated TASK-046 Chromium E2E trusted operator bootstrap",
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

    // Real TOTP enrollment + verification
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(manualSecret.length >= 16, "Expected valid Base32 secret during operator 2FA setup");
    await page.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // =========================================================================
    // 3. Tenant Directory (/console/tenants) — Provision Modal, Search/Filter, Responsive Viewports
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/tenants`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-tenants-directory-panel"]');

    const bannerText = await page.textContent('[data-testid="console-context-banner"]');
    assert(
      bannerText &&
        bannerText.includes("Console Operasional Platform") &&
        bannerText.includes("bukan penyamaran akun tenant"),
      `Missing explicit platform context banner: ${bannerText}`,
    );

    // Keyboard focus check
    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    assert(
      focusedTag === "A" || focusedTag === "BUTTON",
      `Expected keyboard focus on interactive control, got ${focusedTag}`,
    );

    // Open Provision Modal + test Escape close + reopen
    await page.click('[data-testid="open-provision-modal-btn"]');
    await page.waitForSelector('[data-testid="provision-tenant-modal"]');
    savedScreenshots.push(await captureScreenshot(page, "tenants-provision-modal-1440.png"));

    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="provision-tenant-modal"]', { state: "hidden" });

    // Reopen & submit validation error first (short reason), then valid provision
    await page.click('[data-testid="open-provision-modal-btn"]');
    await page.waitForSelector('[data-testid="provision-tenant-modal"]');
    await page.fill("#modal-prov-name", tenantName);
    await page.fill("#modal-prov-handle", tenantHandle);
    await page.fill("#modal-prov-email", ownerEmail);
    await page.fill("#modal-prov-reason", "pendek");
    await page.click('[data-testid="provision-submit-btn"]');
    await page.waitForSelector('[data-testid="provision-field-error"]');

    await page.fill(
      "#modal-prov-reason",
      "Onboarding tenant uji otomatis TASK-046 sesuai tiket #OPS-460",
    );
    await page.click('[data-testid="provision-submit-btn"]');
    await page.waitForSelector('[data-testid="tenants-success-banner"]');

    // Search for the newly provisioned tenant
    await page.fill('[data-testid="tenants-search-input"]', tenantHandle);
    await page.click('[data-testid="tenants-search-submit"]');
    await page.waitForSelector(`[data-testid="tenant-row-${tenantHandle}"]`);

    await assertViewportLayoutAndTouchTargets(page, "console-tenants-dir", 1440);
    savedScreenshots.push(await captureScreenshot(page, "tenants-directory-1440.png"));

    // Filtered-empty state + reset filter
    await page.fill('[data-testid="tenants-search-input"]', "tidak-ada-tenant-xyz-999");
    await page.click('[data-testid="tenants-search-submit"]');
    await page.waitForSelector('[data-testid="tenants-empty-state"]');
    await page.click('[data-testid="tenants-empty-reset-btn"]');
    await page.waitForSelector(`[data-testid="tenant-row-${tenantHandle}"]`);

    // 768x1024 and 360x800 checks on directory
    await page.setViewportSize({ width: 768, height: 1024 });
    await assertViewportLayoutAndTouchTargets(page, "console-tenants-dir", 768);
    savedScreenshots.push(await captureScreenshot(page, "tenants-directory-768.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-tenants-dir", 360);
    savedScreenshots.push(await captureScreenshot(page, "tenants-directory-360.png"));

    // =========================================================================
    // 4. Tenant Detail (/console/tenants/{handle}) — State Transition, Theme Grant/Revoke, Stale Conflict
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/tenants/${encodeURIComponent(tenantHandle)}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="console-tenant-detail-panel"]');

    const tenantCtxBadge = await page.textContent('[data-testid="tenant-context-badge"]');
    assert(
      tenantCtxBadge && tenantCtxBadge.includes(tenantHandle),
      `Expected explicit Tenant Context badge with handle, got ${tenantCtxBadge}`,
    );

    // State Transition Modal: open, capture screenshot, test Escape close, reopen & apply suspend_hold
    await page.click('[data-testid="open-state-modal-btn"]');
    await page.waitForSelector('[data-testid="state-transition-modal"]');
    savedScreenshots.push(await captureScreenshot(page, "tenant-state-modal-1440.png"));
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="state-transition-modal"]', { state: "hidden" });

    await page.click('[data-testid="open-state-modal-btn"]');
    await page.waitForSelector('[data-testid="state-transition-modal"]');
    await page.fill(
      '[data-testid="state-modal-reason-input"]',
      "Penangguhan uji otomatis TASK-046 menunggu verifikasi tiket #OPS-461",
    );
    await page.click('[data-testid="state-modal-submit-btn"]');
    await page.waitForSelector('[data-testid="detail-success-alert"]');
    await page.waitForSelector('[data-testid="detail-hold-reason-alert"]');

    // Theme Grant Modal: grant registered custom theme `custom-sample-agency`
    await page.click('[data-testid="open-theme-grant-modal-btn"]');
    await page.waitForSelector('[data-testid="theme-grant-modal"]');
    savedScreenshots.push(await captureScreenshot(page, "tenant-theme-modal-1440.png"));
    await page.fill(
      '[data-testid="theme-grant-reason-input"]',
      "Aktivasi izin tema kustom agensi terdaftar untuk pengujian TASK-046",
    );
    await page.click('[data-testid="theme-grant-submit-btn"]');
    await page.waitForSelector('[data-testid="granted-theme-item-custom-sample-agency"]');

    await assertViewportLayoutAndTouchTargets(page, "console-tenant-detail", 1440);
    savedScreenshots.push(await captureScreenshot(page, "tenant-detail-1440.png"));

    // Theme Revoke Modal: revoke inactive `custom-sample-agency`
    await page.click('[data-testid="open-theme-revoke-btn-custom-sample-agency"]');
    await page.waitForSelector('[data-testid="theme-revoke-modal"]');
    await page.fill(
      '[data-testid="theme-revoke-reason-input"]',
      "Pencabutan izin tema kustom non-aktif selesai pengujian TASK-046",
    );
    await page.click('[data-testid="theme-revoke-submit-btn"]');
    await page.waitForSelector('[data-testid="detail-themes-empty"]');

    // 409 STALE_VERSION conflict recovery UX in State Transition modal
    allowExpectedHttpErrors = true;
    await page.click('[data-testid="open-state-modal-btn"]');
    await page.waitForSelector('[data-testid="state-transition-modal"]');

    // Simulate concurrent version increment directly in local D1
    const conflictDb = new DatabaseSync(sqlitePath);
    try {
      conflictDb
        .prepare("UPDATE tenants SET version = version + 1 WHERE handle = ?")
        .run(tenantHandle);
    } finally {
      conflictDb.close();
    }

    await page.fill(
      '[data-testid="state-modal-reason-input"]',
      "Mencoba melepas hold dengan versi usang untuk uji konflik 409",
    );
    await page.click('[data-testid="state-modal-submit-btn"]');
    await page.waitForSelector('[data-testid="state-stale-reload-btn"]');
    await page.click('[data-testid="state-stale-reload-btn"]');
    await page.waitForSelector('[data-testid="state-modal-error"]', { state: "hidden" });
    allowExpectedHttpErrors = false;

    // Now submit again with fresh version -> release_hold succeeds!
    await page.click('[data-testid="state-modal-submit-btn"]');
    await page.waitForSelector('[data-testid="detail-success-alert"]');
    await page.waitForSelector('[data-testid="detail-hold-reason-alert"]', { state: "hidden" });

    // 768x1024 and 360x800 checks on tenant detail
    await page.setViewportSize({ width: 768, height: 1024 });
    await assertViewportLayoutAndTouchTargets(page, "console-tenant-detail", 768);
    savedScreenshots.push(await captureScreenshot(page, "tenant-detail-768.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-tenant-detail", 360);
    savedScreenshots.push(await captureScreenshot(page, "tenant-detail-360.png"));

    assert(consoleErrors.length === 0, `Unexpected console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${pageErrors.join(" | ")}`);

    console.log("TASK-046 E2E PASSED:", {
      tenantHandle,
      screenshots: savedScreenshots.filter(Boolean),
    });

    await opCtx.close();
  } catch (err) {
    console.error("TASK-046 E2E FAILED:", err);
    if (serverLogs) {
      console.error("=== SERVER LOGS (tail) ===\n", serverLogs.slice(-4000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
}

await run();
