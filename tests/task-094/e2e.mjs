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

const SCREENSHOT_DIR = process.env.TASK094_SCREENSHOT_DIR || "/tmp/task-094-screenshots";
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'abuse_reports' LIMIT 1")
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

async function waitForServer(port, timeoutMs = 40_000) {
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

async function assertViewportLayout(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
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
}

async function captureScreenshot(page, filename) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  const outPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: outPath, fullPage: true });
  return outPath;
}

async function run() {
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

  const capturedPaths = [];
  let browser;
  try {
    await waitForServer(webPort);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const opEmail = `t094-op-${uniqueSuffix}@example.com`;
    const password = "ModerationPassword!234";

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Sign up & bootstrap operator + owned tenant in local PLATFORM_DB
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signUp = await page.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Operator Moderasi" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(signUp.ok, `Sign-up failed (${signUp.status})`);

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const tenantHandle = `t094-toko-${Date.now().toString(36).slice(-5)}`;
    const orgId = `org_${Date.now().toString(36)}`;
    const memberId = `mem_${Date.now().toString(36)}`;
    const tenantId = `01J094E2E${Date.now().toString(36).toUpperCase().padStart(17, "0").slice(0, 17)}`;
    const nowMs = Date.now();

    const localDb = new DatabaseSync(sqlitePath);
    try {
      const userRow = localDb
        .prepare("SELECT id FROM users WHERE lower(email) = ? LIMIT 1")
        .get(opEmail.toLowerCase());
      assert(userRow && userRow.id, `Expected user row for ${opEmail}`);
      const opUserId = String(userRow.id);

      localDb.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(opUserId);

      // Verify migration 0021_abuse_moderation.sql applied cleanly (sync local dev table if pre-existing from earlier run)
      const hasBuckets = localDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'abuse_rate_limit_buckets' LIMIT 1")
        .get();
      assert(Boolean(hasBuckets), "Expected abuse_rate_limit_buckets from migration 0021");
      const modCols = localDb.prepare("PRAGMA table_info(abuse_moderation_actions)").all();
      const hasIdempCol = modCols.some((c) => c.name === "idempotency_key");
      const trigRow = localDb
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'abuse_moderation_actions_no_update'")
        .get();
      const hasScopedUpdateTrigger = Boolean(trigRow && String(trigRow.sql).includes("OLD.notification_status != 'queued'"));
      if (!hasIdempCol || !hasScopedUpdateTrigger) {
        localDb.exec("DROP TRIGGER IF EXISTS abuse_moderation_actions_no_update");
        localDb.exec("DROP TRIGGER IF EXISTS abuse_moderation_actions_no_delete");
        if (!hasIdempCol) {
          localDb.exec("DROP TABLE IF EXISTS abuse_moderation_actions");
        }
        const sql0021 = fs.readFileSync(
          path.join(root, "packages/db/migrations/platform/0021_abuse_moderation.sql"),
          "utf8",
        );
        localDb.exec(sql0021);
      }

      localDb
        .prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(orgId, "Toko Uji Moderasi", tenantHandle, nowMs, nowMs);
      localDb
        .prepare("INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
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
          "Toko Uji Moderasi",
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
        "Automated TASK-094 Chromium E2E trusted operator bootstrap",
        "--db-file",
        sqlitePath,
        "--local",
      ],
      { cwd: root, env: cleanChildEnv(), encoding: "utf8" },
    );
    assert(cliRes.status === 0, `platform-operator.mjs failed:\n${cliRes.stdout}\n${cliRes.stderr}`);

    // 2. Enroll & verify TOTP 2FA so operator has fresh step-up
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await page.fill("#twofa-enroll-password", password);
    await page.click('[data-testid="twofa-enroll-start-button"]');
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(manualSecret.length >= 16, "Expected Base32 TOTP secret");
    await page.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // 3. Public Abuse Report Form @ 1440px & 360px + Real Submission
    const abuseFormUrl = `${baseUrl}/api/abuse-report?handle=${encodeURIComponent(tenantHandle)}&path=/promo-uji`;
    const abuseRes = await page.goto(abuseFormUrl, { waitUntil: "networkidle" });
    assert(abuseRes && abuseRes.status() === 200, `Expected 200 on ${abuseFormUrl}, got ${abuseRes?.status()}`);
    await page.waitForSelector('[data-testid="public-abuse-report-form"]');
    await assertViewportLayout(page, "public-abuse-form", 1440);
    capturedPaths.push(await captureScreenshot(page, "public-abuse-report-1440.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayout(page, "public-abuse-form", 360);
    capturedPaths.push(await captureScreenshot(page, "public-abuse-report-360.png"));

    // Submit real abuse report via form POST (PRG 303 -> confirmation banner)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.selectOption('[data-testid="abuse-category"]', "scam");
    await page.fill(
      '[data-testid="abuse-description"]',
      "Laporan uji E2E untuk memverifikasi alur moderasi penyalahgunaan di console.",
    );
    await page.fill('[data-testid="abuse-reporter-email"]', "pelapor-e2e@example.com");
    await Promise.all([
      page.waitForURL(/status=received/),
      page.click('[data-testid="abuse-submit-btn"]'),
    ]);
    await page.waitForSelector('[data-testid="abuse-report-success"]');

    // Extract reportId from DB
    const checkDb = new DatabaseSync(sqlitePath, { readOnly: true });
    let reportId = "";
    try {
      const row = checkDb
        .prepare("SELECT id FROM abuse_reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(tenantId);
      assert(row && row.id, "Expected persisted abuse_reports row from form submission");
      reportId = String(row.id);
    } finally {
      checkDb.close();
    }

    // 4. Console Moderation Queue @ 1440px & 360px + Execute Audited Moderation Action
    const consoleAbuseRes = await page.goto(`${baseUrl}/console/abuse`, { waitUntil: "networkidle" });
    assert(
      consoleAbuseRes && consoleAbuseRes.status() === 200,
      `Expected 200 on /console/abuse, got ${consoleAbuseRes?.status()}`,
    );
    await page.waitForSelector('[data-testid="console-abuse-page"]');
    await page.waitForSelector(`[data-testid="abuse-row-${reportId}"]`);
    await assertViewportLayout(page, "console-abuse-queue", 1440);
    capturedPaths.push(await captureScreenshot(page, "console-abuse-queue-1440.png"));

    // Open moderation drawer and dismiss report with audited reason (keep tenant active for next step!)
    await page.click(`[data-testid="abuse-open-btn-${reportId}"]`);
    await page.waitForSelector('[data-testid="abuse-moderation-sheet"]');
    await page.click('[data-testid="abuse-action-dismiss"]');
    await page.fill(
      '[data-testid="abuse-reason-input"]',
      "Tinjauan E2E menyatakan halaman uji valid sehingga laporan ditutup secara teraudit.",
    );
    await page.click('[data-testid="abuse-moderate-submit"]');
    await page.waitForSelector('[data-testid="abuse-moderation-success"]');

    // Close sheet & capture 360px console moderation queue
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayout(page, "console-abuse-queue", 360);
    capturedPaths.push(await captureScreenshot(page, "console-abuse-queue-360.png"));

    // 5. Tenant Activity Log @ 1440px & 360px + Leads Inbox Page
    await page.setViewportSize({ width: 1440, height: 900 });
    const activityUrl = `${baseUrl}/dashboard/${tenantHandle}/settings/activity`;
    const actRes = await page.goto(activityUrl, { waitUntil: "networkidle" });
    assert(actRes && actRes.status() === 200, `Expected 200 on ${activityUrl}, got ${actRes?.status()}`);
    await page.waitForSelector('[data-testid="tenant-activity-log-page"]');
    await assertViewportLayout(page, "tenant-activity-log", 1440);
    capturedPaths.push(await captureScreenshot(page, "tenant-activity-log-1440.png"));

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayout(page, "tenant-activity-log", 360);
    capturedPaths.push(await captureScreenshot(page, "tenant-activity-log-360.png"));

    assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Uncaught page errors: ${pageErrors.join("; ")}`);

    console.log("TASK-094 E2E PASS");
    for (const p of capturedPaths) {
      console.log(`SCREENSHOT: ${p}`);
    }
    await ctx.close();
  } catch (err) {
    console.error("--- astro dev server logs (tail) ---\n", serverLogs.slice(-4000));
    throw err;
  } finally {
    if (browser) await browser.close();
    webServer.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
