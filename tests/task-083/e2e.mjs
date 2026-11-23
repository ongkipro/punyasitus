/* global process, console, Buffer, URL, setTimeout, document, window, getComputedStyle, fetch */
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

const SCREENSHOT_DIR = process.env.TASK083_SCREENSHOT_DIR || "/tmp/task-083-screenshots";
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agency_client_links' LIMIT 1")
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(`Could not locate migrated PLATFORM_DB with agency_client_links under ${persistDir}`);
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

async function waitForServer(getPort, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(getPort(), "/auth/login");
      if (res.status === 200) return getPort();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`astro dev did not become ready on port ${getPort()}`);
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
      if (ctrl.tag === "A" && ctrl.height < 44 && ctrl.id === "") continue;
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

async function captureScreenshot(page, filename) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
}

async function signUpInBrowser(page, baseUrl, email, password, name) {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
  const res = await page.evaluate(
    async ({ e, p, n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, userId: json?.user?.id ?? "" };
    },
    { e: email, p: password, n: name },
  );
  assert(res.ok && res.userId, `Sign-up failed for ${email}: ${res.status}`);
  return res.userId;
}

async function enrollAndVerify2FAInBrowser(page, sqlitePath, userId, password) {
  const enableRes = await page.evaluate(async (pw) => {
    const r = await fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: pw, issuer: "PunyaSitus" }),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, totpURI: json?.totpURI ?? "" };
  }, password);
  assert(enableRes.ok && enableRes.totpURI, `enableTwoFactor failed: ${enableRes.status}`);

  const secret = new URL(enableRes.totpURI).searchParams.get("secret") || "";
  assert(secret.length >= 16, "Missing base32 secret in totpURI");
  const code = generateTotpCode(secret);

  const verifyRes = await page.evaluate(async (c) => {
    const r = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code: c }),
    });
    return { ok: r.ok, status: r.status };
  }, code);
  assert(verifyRes.ok, `verifyTOTP failed: ${verifyRes.status}`);

  // Record session_two_factor_verifications for the user's active session
  const db = new DatabaseSync(sqlitePath);
  try {
    const sess = db
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId);
    assert(sess && sess.id, `Session not found for user ${userId}`);
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO session_two_factor_verifications
       (session_id, user_id, verified_at, method, created_at, updated_at)
       VALUES (?, ?, ?, 'totp', ?, ?)`,
    ).run(sess.id, userId, now, now, now);
  } finally {
    db.close();
  }
}

async function run() {
  const persistDir = ensureLocalD1Migrated();
  let activePort = await getFreePort();

  const server = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(activePort), "--ignore-lock"],
    {
      cwd: webDir,
      env: cleanChildEnv({ PUNYASITUS_DISABLE_DEV_TOOLBAR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  const parseBoundPort = (chunk) => {
    const text = chunk.toString();
    serverLogs += text;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
    if (match?.[1]) {
      activePort = Number.parseInt(match[1], 10);
    }
  };
  server.stdout.on("data", parseBoundPort);
  server.stderr.on("data", parseBoundPort);

  let browser;
  try {
    const resolvedPort = await waitForServer(() => activePort);
    const baseUrl = `http://127.0.0.1:${resolvedPort}`;

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
    const password = "AgencyE2ePassword!2026";
    const agencyEmail = `t083-agency-${suffix}@example.com`;
    const clientOwnerEmail = `t083-client-owner-${suffix}@example.com`;
    const opEmail = `t083-op-${suffix}@example.com`;
    const clientHandle = `klien-e2e-${suffix}`.slice(0, 32);

    const agencyCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const agencyPage = await agencyCtx.newPage();
    const clientCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const clientPage = await clientCtx.newPage();
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [agencyPage, clientPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          // Expected 403 when intentionally probing unenrolled 2FA gate on /agency
          if (text.includes("status of 403")) return;
          consoleErrors.push(text);
        }
      });
      p.on("pageerror", (err) => pageErrors.push(String(err)));
    }

    const agencyUserId = await signUpInBrowser(agencyPage, baseUrl, agencyEmail, password, "Rina Agensi");
    const clientOwnerUserId = await signUpInBrowser(clientPage, baseUrl, clientOwnerEmail, password, "Doni Klien");
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Superadmin Agensi");

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE users SET email_verified = 1 WHERE id IN (?, ?, ?)").run(
        agencyUserId,
        clientOwnerUserId,
        opUserId,
      );
      db.prepare(
        `INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, role)
         VALUES (?, ?, 'TASK-083 E2E console operator', ?, 'platform_superadmin')`,
      ).run(opUserId, opUserId, nowMs);
    } finally {
      db.close();
    }

    // 1. Un-enrolled 2FA user visiting /agency MUST be blocked with 403 TOTP_ENROLLMENT_REQUIRED
    const blockedRes = await agencyPage.goto(`${baseUrl}/agency`, { waitUntil: "networkidle" });
    assert(blockedRes?.status() === 403, `Expected 403 for unenrolled 2FA user, got ${blockedRes?.status()}`);
    assert(
      blockedRes?.headers()["x-punyasitus-auth-error"] === "TOTP_ENROLLMENT_REQUIRED",
      `Expected TOTP_ENROLLMENT_REQUIRED header, got ${blockedRes?.headers()["x-punyasitus-auth-error"]}`,
    );
    await agencyPage.locator('[data-testid="agency-2fa-enroll-link"]').waitFor({ state: "visible" });

    // 2. Enroll & verify 2FA for agency user and operator
    await enrollAndVerify2FAInBrowser(agencyPage, sqlitePath, agencyUserId, password);
    await enrollAndVerify2FAInBrowser(opPage, sqlitePath, opUserId, password);

    // 3. Self-register agency via /agency onboarding UI
    await agencyPage.goto(`${baseUrl}/agency`, { waitUntil: "networkidle" });
    await agencyPage.locator('[data-testid="agency-enrollment-panel"]').waitFor({ state: "visible" });
    await agencyPage.fill("#agency-name-input", "Garuda Digital Agency");
    await agencyPage.check('[data-testid="agency-accept-terms"]');
    await Promise.all([
      agencyPage.waitForNavigation({ waitUntil: "networkidle" }),
      agencyPage.click('[data-testid="agency-enroll-submit"]'),
    ]);

    // 4. Verify /agency overview at 1440px and 360px
    await agencyPage.locator('[data-testid="agency-overview-page"]').waitFor({ state: "visible" });
    await agencyPage.locator('[data-testid="agency-discount-badge"]').waitFor({ state: "visible" });
    await agencyPage.locator('[data-testid="agency-trial-cap-meter"]').waitFor({ state: "visible" });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-overview", 1440);
    await captureScreenshot(agencyPage, "01-agency-overview-1440.png");

    await agencyPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-overview", 360);
    await captureScreenshot(agencyPage, "02-agency-overview-360.png");
    await agencyPage.setViewportSize({ width: 1440, height: 900 });

    // 5. Visit /agency/clients, create a linked client website, and switch into client context
    await agencyPage.goto(`${baseUrl}/agency/clients`, { waitUntil: "networkidle" });
    await agencyPage.locator('[data-testid="agency-clients-panel"]').waitFor({ state: "visible" });
    await agencyPage.fill("#client-name", "Klinik Sehat Sentosa");
    await agencyPage.fill("#client-handle", clientHandle);
    await agencyPage.fill("#client-owner-email", clientOwnerEmail);
    await agencyPage.click('[data-testid="agency-create-client-submit"]');
    await agencyPage.locator('[data-testid="agency-clients-success"]').waitFor({ state: "visible" });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-clients", 1440);
    await captureScreenshot(agencyPage, "03-agency-clients-1440.png");

    await agencyPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-clients", 360);
    await captureScreenshot(agencyPage, "04-agency-clients-360.png");
    await agencyPage.setViewportSize({ width: 1440, height: 900 });

    // Click "Kelola Situs" -> audited switch -> client context banner rendered!
    await Promise.all([
      agencyPage.waitForNavigation({ waitUntil: "networkidle" }),
      agencyPage.click(`[data-testid="agency-switch-btn-${clientHandle}"]`),
    ]);
    await agencyPage.locator('[data-testid="agency-client-context-bar"]').waitFor({ state: "visible" });
    const bannerText = await agencyPage.locator('[data-testid="agency-client-context-bar"]').textContent();
    assert(
      bannerText?.includes("Klinik Sehat Sentosa") && bannerText?.includes(clientHandle),
      `Agency client context banner missing client info: ${bannerText}`,
    );
    await captureScreenshot(agencyPage, "05-agency-client-context-1440.png");

    // 6. Visit /agency/billing at 1440px and 360px
    await agencyPage.goto(`${baseUrl}/agency/billing`, { waitUntil: "networkidle" });
    await agencyPage.locator('[data-testid="agency-billing-panel"]').waitFor({ state: "visible" });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-billing", 1440);
    await captureScreenshot(agencyPage, "06-agency-billing-1440.png");

    await agencyPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(agencyPage, "agency-billing", 360);
    await captureScreenshot(agencyPage, "07-agency-billing-360.png");

    // 7. Client owner accepts invite (explicit membership) and visits /dashboard/{handle}/billing:
    // MUST see agency-managed notice (zero checkout form!)
    const dbAccept = new DatabaseSync(sqlitePath);
    try {
      const tRow = dbAccept
        .prepare("SELECT organization_id FROM tenants WHERE handle = ? LIMIT 1")
        .get(clientHandle);
      assert(tRow && tRow.organization_id, `Client tenant ${clientHandle} not found in SQLite`);
      dbAccept
        .prepare(
          `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
           VALUES (?, ?, ?, 'owner', ?)`,
        )
        .run(`mem_e2e_owner_${suffix}`, tRow.organization_id, clientOwnerUserId, Date.now());
    } finally {
      dbAccept.close();
    }
    await clientPage.goto(`${baseUrl}/dashboard/${clientHandle}/billing`, { waitUntil: "networkidle" });
    const noticeVisible = await clientPage.locator('[data-agency-managed="true"]').isVisible();
    assert(noticeVisible, "Client owner on agency-managed tenant must see agency-managed billing notice");
    const checkoutButtons = await clientPage.locator('[data-testid="owner-billing-panel"]').count();
    assert(checkoutButtons === 0, "Client owner on agency-managed tenant must NOT see OwnerBillingPanel");

    // 8. Operator visits /console/agencies at 1440px and 360px
    await opPage.goto(`${baseUrl}/console/agencies`, { waitUntil: "networkidle" });
    await opPage.locator('[data-testid="console-agencies-panel"]').waitFor({ state: "visible" });
    await assertViewportLayoutAndTouchTargets(opPage, "console-agencies", 1440);
    await captureScreenshot(opPage, "08-console-agencies-1440.png");

    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(opPage, "console-agencies", 360);
    await captureScreenshot(opPage, "09-console-agencies-360.png");

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Uncaught page errors detected:\n${pageErrors.join("\n")}`);

    console.log("TASK-083 E2E PASSED: 2FA gate, enrollment, client provisioning, context banner, billing isolation, console agencies & 360/1440 layout verified.");
  } catch (err) {
    console.error("Server logs:\n", serverLogs);
    throw err;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
