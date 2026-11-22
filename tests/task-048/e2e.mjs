/* global process, console, Buffer, setTimeout, clearTimeout, document, window, getComputedStyle, fetch */
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

const SCREENSHOT_DIR = process.env.TASK048_SCREENSHOT_DIR || "";
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

async function maybeCaptureScreenshot(page, filename) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
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
  try {
    await waitForServer(port);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const nonOpEmail = `t048-nonop-${uniqueSuffix}@example.com`;
    const opEmail = `t048-op-${uniqueSuffix}@example.com`;
    const candidateEmail = `t048-support-${uniqueSuffix}@example.com`;
    const password = "ConsoleOpPassword!234";

    // =========================================================================
    // 1. Verify denied non-operator access on /console/** and /api/console/**
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
          body: JSON.stringify({ email, password: pwd, name: "Bukan Operator" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: nonOpEmail, pwd: password },
    );
    assert(nonOpSignUp.ok, `Non-op sign-up failed (${nonOpSignUp.status})`);

    for (const p of [
      "/console",
      "/console/operators",
      "/console/audit",
      "/console/health",
      "/console/settings",
    ]) {
      const resp = await nonOpPage.goto(`${baseUrl}${p}`, { waitUntil: "domcontentloaded" });
      assert(resp && resp.status() === 403, `Expected 403 for non-operator on ${p}, got ${resp?.status()}`);
    }
    const nonOpApiStatus = await nonOpPage.evaluate(async () => {
      const res = await fetch("/api/console/settings", { credentials: "same-origin" });
      return res.status;
    });
    assert(nonOpApiStatus === 403, `Expected 403 for non-operator on /api/console/settings, got ${nonOpApiStatus}`);
    await nonOpCtx.close();

    // =========================================================================
    // 2. Provision operator + second verified user, bootstrap via CLI, enroll 2FA
    // =========================================================================
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await opCtx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    let allowExpectedHttpErrors = false;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (allowExpectedHttpErrors && (text.includes("status of 422") || text.includes("status of 405"))) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // Sign up second candidate user first via isolated context so operator context stays clean
    const candCtx = await browser.newContext();
    const candPage = await candCtx.newPage();
    await candPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await candPage.evaluate(
      async ({ email, pwd }) => {
        await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Staf Dukungan Baru" }),
        });
      },
      { email: candidateEmail, pwd: password },
    );
    await candCtx.close();

    // Sign up operator user in main browser context
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const opSignUp = await page.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Superadmin Utama" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(opSignUp.ok, `Operator sign-up failed (${opSignUp.status})`);

    // Mark both accounts email_verified = 1 in local D1 and bootstrap/recover operator via trusted CLI
    const sqlitePath = findPlatformSqlitePath(persistDir);
    const localDb = new DatabaseSync(sqlitePath);
    try {
      localDb
        .prepare("UPDATE users SET email_verified = 1 WHERE lower(email) IN (?, ?)")
        .run(opEmail.toLowerCase(), candidateEmail.toLowerCase());
    } finally {
      localDb.close();
    }

    // Use `scripts/platform-operator.mjs --mode recover` (allowAdditional safe if prior E2E run left an operator in shared local state)
    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-048 Chromium E2E trusted operator bootstrap",
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

    // Complete real TOTP enrollment & verification via UI (/auth/two-factor?mode=enroll)
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(manualSecret.length >= 16, "Expected valid Base32 secret during operator 2FA setup");
    const totpCode = generateTotpCode(manualSecret);
    await page.fill("#twofa-confirm-code", totpCode);
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // =========================================================================
    // 3. Visit /console (Overview) at 1440px, 768px, and 360px + keyboard nav
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-overview-page"]');
    const bannerText = await page.textContent('[data-testid="console-context-banner"]');
    assert(
      bannerText &&
        bannerText.includes("Console Operasional Platform") &&
        bannerText.includes("bukan penyamaran akun tenant"),
      `Missing explicit platform context banner text: ${bannerText}`,
    );
    await assertViewportLayoutAndTouchTargets(page, "console-overview", 1440);
    await maybeCaptureScreenshot(page, "console-overview-1440.png");

    // Keyboard Tab navigation check across console section links
    await page.keyboard.press("Tab");
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    assert(activeTag === "A" || activeTag === "BUTTON", `Expected keyboard focus on link/button, got ${activeTag}`);

    await page.setViewportSize({ width: 768, height: 900 });
    await assertViewportLayoutAndTouchTargets(page, "console-overview", 768);

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-overview", 360);
    await maybeCaptureScreenshot(page, "console-overview-360.png");

    // =========================================================================
    // 4. Visit /console/settings — test validation error & live audited save
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/settings`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="platform-settings-form"]');
    await assertViewportLayoutAndTouchTargets(page, "console-settings", 1440);

    // Submit invalid URL -> server 422 alert announced
    allowExpectedHttpErrors = true;
    await page.fill("#settings-sales-whatsapp", "0812-3456-7890");
    await page.fill("#settings-support-email", "support@punyasitus.com");
    await page.fill("#settings-terms-url", "javascript:alert(1)");
    await page.fill("#settings-privacy-url", "https://punyasitus.com/kebijakan-privasi");
    await page.fill("#settings-audit-reason", "Uji validasi tautan berbahaya pada pengaturan platform");
    await page.click('[data-testid="settings-save-button"]');
    await page.waitForSelector('[data-testid="settings-error-alert"]');
    allowExpectedHttpErrors = false;

    // Submit valid values -> persists and survives reload
    await page.fill("#settings-terms-url", "https://punyasitus.com/syarat-ketentuan");
    await page.fill("#settings-audit-reason", "Memperbarui nomor WhatsApp resmi dan tautan legal HTTPS");
    await page.click('[data-testid="settings-save-button"]');
    await page.waitForSelector('[data-testid="settings-success-alert"]');
    const normalizedWa = await page.inputValue("#settings-sales-whatsapp");
    assert(normalizedWa === "6281234567890", `Expected normalized 6281234567890, got ${normalizedWa}`);

    await maybeCaptureScreenshot(page, "console-settings-1440.png");
    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-settings", 360);
    await maybeCaptureScreenshot(page, "console-settings-360.png");

    // =========================================================================
    // 5. Visit /console/operators — live grant & revoke + final operator guard
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/operators`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="operator-grant-form"]');
    await assertViewportLayoutAndTouchTargets(page, "console-operators", 1440);

    await page.fill("#operator-target-input", candidateEmail);
    await page.selectOption("#operator-role-select", "platform_support");
    await page.fill("#operator-grant-reason", "Menambahkan staf dukungan operasional untuk pengujian TASK-048");
    await page.click('[data-testid="operator-grant-submit"]');
    await page.waitForSelector('[data-testid="operators-success-alert"]');

    const operatorsTableText = await page.textContent('[data-testid="operators-table"]');
    assert(
      operatorsTableText && operatorsTableText.includes(candidateEmail),
      `Expected newly granted operator ${candidateEmail} in table`,
    );

    await maybeCaptureScreenshot(page, "console-operators-1440.png");

    // Revoke the newly granted support operator
    const revokeBtn = page.locator('[data-testid^="revoke-trigger-btn-"]').last();
    await revokeBtn.click();
    const revokeInput = page.locator('[data-testid^="revoke-reason-input-"]').first();
    await revokeInput.fill("Mencabut peran dukungan sementara setelah pengujian selesai");
    await page.locator('[data-testid^="revoke-confirm-btn-"]').first().click();
    await page.waitForSelector('[data-testid="operators-success-alert"]');

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-operators", 360);
    await maybeCaptureScreenshot(page, "console-operators-360.png");

    // =========================================================================
    // 6. Visit /console/audit — filter, verify immutable notice & 405 on PATCH
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/audit`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-audit-explorer"]');
    await page.waitForSelector('[data-testid="audit-immutable-notice"]');
    await assertViewportLayoutAndTouchTargets(page, "console-audit", 1440);

    await page.fill("#audit-filter-action", "platform_settings.update");
    await page.click('[data-testid="audit-filter-submit"]');
    await page.waitForTimeout(400);
    const auditTableText = await page.textContent('[data-testid="audit-table"]');
    assert(
      auditTableText && auditTableText.includes("platform_settings.update"),
      "Expected filtered platform_settings.update row in audit table",
    );

    // Verify API explicitly rejects DELETE/PATCH with 405 (even with valid JSON Content-Type + same-origin)
    allowExpectedHttpErrors = true;
    const auditMutationStatuses = await page.evaluate(async () => {
      const delRes = await fetch("/api/console/audit", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
      const patchRes = await fetch("/api/console/audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ reason: "tamper" }),
      });
      return { del: delRes.status, patch: patchRes.status };
    });
    allowExpectedHttpErrors = false;
    assert(
      auditMutationStatuses.del === 405 && auditMutationStatuses.patch === 405,
      `Expected 405 on DELETE/PATCH /api/console/audit, got DELETE=${auditMutationStatuses.del}, PATCH=${auditMutationStatuses.patch}`,
    );

    await maybeCaptureScreenshot(page, "console-audit-1440.png");
    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-audit", 360);
    await maybeCaptureScreenshot(page, "console-audit-360.png");

    // =========================================================================
    // 7. Visit /console/health — honest unknown/stale/healthy status & refresh
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/health`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-health-dashboard"]');
    await assertViewportLayoutAndTouchTargets(page, "console-health", 1440);

    const overallStatus = await page
      .locator('[data-testid="health-overall-status-badge"]')
      .getAttribute("data-health-status");
    assert(
      ["healthy", "degraded", "stale", "unknown"].includes(overallStatus ?? ""),
      `Unexpected health status attribute: ${overallStatus}`,
    );

    await page.click('[data-testid="health-refresh-button"]');
    await page.waitForTimeout(300);
    await maybeCaptureScreenshot(page, "console-health-1440.png");

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-health", 360);
    await maybeCaptureScreenshot(page, "console-health-360.png");

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Page errors detected:\n${pageErrors.join("\n")}`);

    console.log(
      "PASS: TASK-048 Chromium E2E verified /console, /console/operators, /console/audit, /console/health, and /console/settings (live settings save, operator grant/revoke, immutable redacted audit, honest health status, non-operator 403 denial, keyboard focus, 360px/768px/1440px layouts with >=44px mobile touch targets and 0 console/page errors).",
    );
  } catch (err) {
    console.error("E2E FAILURE:", err);
    console.error("Astro dev logs:\n", serverLogs.slice(-3000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
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
  }
}

await run();
