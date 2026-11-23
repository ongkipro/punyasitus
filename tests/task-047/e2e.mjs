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

const SCREENSHOT_DIR = process.env.TASK047_SCREENSHOT_DIR || "/tmp/task-047-screenshots";
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
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_operators' LIMIT 1",
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
        if (el.getAttribute("type") === "checkbox") return false;
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
    const nonOpEmail = `t047-nonop-${uniqueSuffix}@example.com`;
    const opEmail = `t047-op-${uniqueSuffix}@example.com`;
    const password = "ConsoleOpPassword!234";

    // =========================================================================
    // 1. Non-operator denied 403 on /console/domains, /console/jobs & APIs
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
          body: JSON.stringify({ email, password: pwd, name: "Tenant User Non-Op" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: nonOpEmail, pwd: password },
    );
    assert(nonOpSignUp.ok, `Non-operator sign-up failed (${nonOpSignUp.status})`);

    for (const p of ["/console/domains", "/console/jobs"]) {
      const resp = await nonOpPage.goto(`${baseUrl}${p}`, { waitUntil: "domcontentloaded" });
      assert(resp && resp.status() === 403, `Expected 403 for non-operator on ${p}, got ${resp?.status()}`);
    }
    for (const apiPath of ["/api/console/domains", "/api/console/jobs"]) {
      const status = await nonOpPage.evaluate(async (url) => {
        const r = await fetch(url, { credentials: "same-origin" });
        return r.status;
      }, apiPath);
      assert(status === 403, `Expected 403 for non-operator on ${apiPath}, got ${status}`);
    }
    await nonOpCtx.close();

    // =========================================================================
    // 2. Enroll verified 2FA platform operator & seed domain/job recovery fixtures
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
          body: JSON.stringify({ email, password: pwd, name: "Superadmin T047" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(opSignUp.ok, `Operator sign-up failed (${opSignUp.status})`);

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const tenantId = `01ARZ3NDEKTSV4RRFF${Math.floor(Math.random() * 89999999 + 10000000)}`;
    const orgId = `org-t047-${uniqueSuffix}`;
    const handle = `t047-${uniqueSuffix.slice(-8)}`.toLowerCase();
    const oldHost = `www.lama-${uniqueSuffix.slice(-6)}.id`;
    const newHost = `www.baru-${uniqueSuffix.slice(-6)}.id`;
    const failedHost = `www.gagal-${uniqueSuffix.slice(-6)}.id`;
    const failedJobKey = `t047-failed-${uniqueSuffix}`;
    const liveJobKey = `t047-live-${uniqueSuffix}`;
    const doneJobKey = `t047-done-${uniqueSuffix}`;

    const localDb = new DatabaseSync(sqlitePath);
    try {
      const opRow = localDb.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").get(opEmail);
      assert(opRow?.id, "Could not locate created operator user in local SQLite");

      localDb.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(opRow.id);

      // Seed tenant + locked active domain + failed domain + jobs with sensitive payloads
      localDb
        .prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(orgId, "CV Nusantara Logistik", handle, nowMs, nowMs);
      localDb
        .prepare(
          `INSERT INTO tenants (
             id, organization_id, handle, name, vertical, status, operator_hold,
             paid_through, cache_version, schema_version, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 1, 1, ?, ?)`,
        )
        .run(tenantId, orgId, handle, "CV Nusantara Logistik", nowMs + 30 * 86400_000, nowMs, nowMs);
      localDb
        .prepare(
          `INSERT INTO tenant_hosts (
             host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary,
             verified_at, last_checked_at, version, created_at, updated_at
           ) VALUES
             (?, ?, 'subdomain', NULL, 'active', 'active', 0, ?, ?, 1, ?, ?),
             (?, ?, 'custom', NULL, 'active', 'active', 1, ?, ?, 1, ?, ?),
             (?, ?, 'custom', NULL, 'failed', 'validation_timed_out', 0, NULL, ?, 1, ?, ?)`,
        )
        .run(
          `${handle}.situsku.click`,
          tenantId,
          nowMs,
          nowMs,
          nowMs,
          nowMs,
          oldHost,
          tenantId,
          nowMs,
          nowMs,
          nowMs,
          nowMs,
          failedHost,
          tenantId,
          nowMs - 8 * 3600_000,
          nowMs - 10 * 3600_000,
          nowMs - 3600_000,
        );

      const secretJobPayload = JSON.stringify({
        hostname: oldHost,
        apiToken: "cf_topsecret_e2e_token_99887766",
        customerEmail: "rahasia.pelanggan@example.id",
        leadBody: "Isi pesan pelanggan sangat rahasia",
      });

      localDb
        .prepare(
          `INSERT INTO job_ledger (
             idempotency_key, topic, tenant_id, status, attempts, lease_until,
             last_error_code, payload_json, created_at, updated_at
           ) VALUES
             (?, 'email.send', ?, 'failed', 2, NULL, 'SMTP_PROVIDER_TIMEOUT', ?, ?, ?),
             (?, 'billing.advice', ?, 'running', 1, ?, NULL, '{}', ?, ?),
             (?, 'seo.indexnow', ?, 'completed', 1, NULL, NULL, '{}', ?, ?)`,
        )
        .run(
          failedJobKey,
          tenantId,
          secretJobPayload,
          nowMs - 120_000,
          nowMs - 30_000,
          liveJobKey,
          tenantId,
          nowMs + 300_000,
          nowMs - 60_000,
          nowMs - 10_000,
          doneJobKey,
          tenantId,
          nowMs - 240_000,
          nowMs - 180_000,
        );
    } finally {
      localDb.close();
    }

    // Bootstrap operator via trusted CLI
    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-047 Chromium E2E trusted operator bootstrap",
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

    // Complete real TOTP enrollment via UI so session has fresh <10m step-up 2FA
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const rawSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(rawSecret.length >= 16, `Expected valid TOTP secret, got "${rawSecret}"`);

    const totpCode = generateTotpCode(rawSecret);
    await page.fill("#twofa-confirm-code", totpCode);
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]', { timeout: 10_000 });

    // =========================================================================
    // 3. /console/domains — 1440px, 768px, 360px + Operator Domain Change flow
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/domains`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-domains-page"]');

    const domPageText = await page.locator("body").textContent();
    assert(domPageText?.includes("Console Operasional Platform"), "Missing platform context banner");
    assert(domPageText?.includes(oldHost), `Expected locked domain ${oldHost} in queue`);
    assert(domPageText?.includes(failedHost), `Expected failed domain ${failedHost} in queue`);

    await assertViewportLayoutAndTouchTargets(page, "console-domains", 1440);
    savedScreenshots.push(await captureScreenshot(page, "console-domains-1440.png"));

    // Keyboard Escape test on Recheck Dialog
    await page.click(`[data-testid="recheck-btn-${failedHost}"]`);
    await page.waitForSelector('[data-testid="domain-recheck-dialog"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="domain-recheck-dialog"]', { state: "hidden" });

    // Execute Operator Domain Change (remove locked domain & connect new domain)
    await page.click(`[data-testid="change-btn-${oldHost}"]`);
    await page.waitForSelector('[data-testid="domain-change-dialog"]');
    await page.fill('[data-testid="change-confirm-hostname-input"]', oldHost);
    await page.fill('[data-testid="change-new-hostname-input"]', newHost);
    await page.fill(
      '[data-testid="change-reason-input"]',
      "Rebranding domain resmi berdasarkan tiket dukungan #4701",
    );
    await page.check('[data-testid="change-confirm-checkbox"]');
    await page.click('[data-testid="change-submit-btn"]');
    await page.waitForSelector('[data-testid="domains-success-banner"]', { timeout: 10_000 });

    const afterChangeText = await page.locator("body").textContent();
    assert(afterChangeText?.includes(newHost), `Expected new pending domain ${newHost} after change`);

    // 768px tablet check
    await page.setViewportSize({ width: 768, height: 900 });
    await assertViewportLayoutAndTouchTargets(page, "console-domains", 768);

    // 360px mobile check + screenshot
    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-domains", 360);
    savedScreenshots.push(await captureScreenshot(page, "console-domains-360.png"));

    // =========================================================================
    // 4. /console/jobs — Redaction verification + Retry Failed Job + 1440/768/360px
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/console/jobs?status=all`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="console-jobs-page"]');

    const jobsDomText = await page.locator("body").textContent();
    assert(jobsDomText?.includes(failedJobKey), `Expected failed job ${failedJobKey} in DOM`);
    assert(jobsDomText?.includes(liveJobKey), `Expected live-lease job ${liveJobKey} in DOM`);
    assert(jobsDomText?.includes(doneJobKey), `Expected completed job ${doneJobKey} in DOM`);

    // ZERO secret/PII/lead body leakage in rendered DOM!
    assert(!jobsDomText?.includes("cf_topsecret_e2e_token_99887766"), "LEAKED apiToken in jobs DOM!");
    assert(!jobsDomText?.includes("rahasia.pelanggan@example.id"), "LEAKED customerEmail in jobs DOM!");
    assert(!jobsDomText?.includes("Isi pesan pelanggan sangat rahasia"), "LEAKED leadBody in jobs DOM!");
    assert(jobsDomText?.includes("[REDACTED]"), "Expected [REDACTED] marker in job summary");

    // Live-lease and completed jobs must have disabled retry buttons
    const liveRetryDisabled = await page
      .locator(`[data-testid="retry-btn-${liveJobKey}"]`)
      .isDisabled();
    const doneRetryDisabled = await page
      .locator(`[data-testid="retry-btn-${doneJobKey}"]`)
      .isDisabled();
    assert(liveRetryDisabled, "Live lease job retry button must be disabled");
    assert(doneRetryDisabled, "Completed job retry button must be disabled");

    await assertViewportLayoutAndTouchTargets(page, "console-jobs", 1440);
    savedScreenshots.push(await captureScreenshot(page, "console-jobs-1440.png"));

    // Retry failed job with mandatory reason
    await page.click(`[data-testid="retry-btn-${failedJobKey}"]`);
    await page.waitForSelector('[data-testid="job-action-dialog"]');
    await page.fill(
      '[data-testid="job-action-reason-input"]',
      "Gangguan sementara SMTP telah selesai; menjadwalkan ulang job gagal",
    );
    await page.click('[data-testid="job-action-submit-btn"]');
    await page.waitForSelector('[data-testid="jobs-success-banner"]', { timeout: 10_000 });

    // 768px & 360px checks + screenshot
    await page.setViewportSize({ width: 768, height: 900 });
    await assertViewportLayoutAndTouchTargets(page, "console-jobs", 768);

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "console-jobs", 360);
    savedScreenshots.push(await captureScreenshot(page, "console-jobs-360.png"));

    assert(consoleErrors.length === 0, `Unexpected browser console errors: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${pageErrors.join("; ")}`);

    console.log("TASK-047 E2E PASSED");
    console.log("Screenshots saved:");
    for (const s of savedScreenshots) {
      console.log(` - ${s}`);
    }
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!server.killed) server.kill("SIGKILL");
    if (process.exitCode && serverLogs) {
      console.error("--- astro dev logs ---\n" + serverLogs);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
