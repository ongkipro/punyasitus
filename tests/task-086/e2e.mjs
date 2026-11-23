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

const SCREENSHOT_DIR = process.env.TASK086_SCREENSHOT_DIR || "/tmp/qa-task-086";
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
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'affiliate_commission_payout_batches' LIMIT 1",
        )
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(
    `Could not locate migrated PLATFORM_DB with affiliate_commission_payout_batches under ${persistDir}`,
  );
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
  await page.waitForTimeout(100);
  const targetPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: targetPath, fullPage: true });
  return targetPath;
}

async function gotoAndWaitForTestId(page, url, testId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await page.goto(url, { waitUntil: "networkidle" });
    try {
      await page.locator(`[data-testid="${testId}"]`).waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await page.waitForTimeout(1000);
    }
  }
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
  const savedScreenshots = [];
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
    const password = "AffiliateE2ePassword!2026";
    const affEmail = `t086-aff-${suffix}@example.com`;
    const tenantOnlyEmail = `t086-tenant-${suffix}@example.com`;
    const opEmail = `t086-op-${suffix}@example.com`;
    const secretOwnerEmail = `secret-owner-${suffix}@example.com`;

    const affCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const affPage = await affCtx.newPage();
    const tenantCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const tenantPage = await tenantCtx.newPage();
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [affPage, tenantPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          // Expected 403 / 422 when probing tenant-only API & unresolved REQ-095 compliance gate
          if (text.includes("status of 403") || text.includes("status of 422")) return;
          consoleErrors.push(text);
        }
      });
      p.on("pageerror", (err) => pageErrors.push(String(err)));
    }

    const affUserId = await signUpInBrowser(affPage, baseUrl, affEmail, password, "Dimas Afiliasi");
    const tenantOnlyUserId = await signUpInBrowser(
      tenantPage,
      baseUrl,
      tenantOnlyEmail,
      password,
      "Sari Pemilik Toko",
    );
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Superadmin Payout");

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const dayMs = 86_400_000;

    const affId = `aff_e2e_${suffix}`;
    const refCode = `DIMAS${suffix.slice(-4).toUpperCase()}`;
    const secretOrgId = `org_sec_${suffix}`;
    const secretTenantId = `ten_sec_${suffix}`;
    const secretHandle = `kopinusantara`;
    const secretTrialOrgId = `org_tr_${suffix}`;
    const secretTrialTenantId = `ten_tr_${suffix}`;
    const secretTrialHandle = `toko-01`;
    const batchPaidId = `bat_paid_${suffix}`;
    const batchPendingId = `bat_pend_${suffix}`;

    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE users SET email_verified = 1 WHERE id IN (?, ?, ?)").run(
        affUserId,
        tenantOnlyUserId,
        opUserId,
      );
      db.prepare(
        `INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, role)
         VALUES (?, ?, 'TASK-086 E2E console operator', ?, 'platform_superadmin')`,
      ).run(opUserId, opUserId, nowMs);

      // Ensure REQ-095 starts unresolved for this E2E run
      db.prepare("DELETE FROM platform_settings WHERE key = 'affiliate.payout_compliance'").run();

      // Seed active affiliate + enrollment profile + funnel visits + referred tenants + commissions + 2 payout batches
      db.prepare(
        `INSERT INTO affiliates (id, user_id, referral_code, status, payout_method, payout_account_name, payout_account_number, version, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 'BCA', 'Dimas Afiliasi', '******8899', 2, ?, ?)`,
      ).run(affId, affUserId, refCode, nowMs - 20 * dayMs, nowMs - 19 * dayMs);

      db.prepare(
        `INSERT INTO affiliate_enrollment_profiles (
           affiliate_id, user_id, email, normalized_email, email_hash,
           approved_referral_code, payout_bank_code, payout_account_holder,
           payout_account_masked, payout_account_number_hash, payout_identity_hash,
           terms_version, terms_accepted_at, approved_by_user_id, approved_at,
           status_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'BCA', 'Dimas Afiliasi', '******8899', ?, ?, '2026-11-v1', ?, ?, ?, 'Terverifikasi E2E', ?, ?)`,
      ).run(
        affId,
        affUserId,
        affEmail,
        affEmail,
        `eh_${suffix}`,
        refCode,
        `ah_${suffix}`,
        `ph_${suffix}`,
        nowMs - 20 * dayMs,
        opUserId,
        nowMs - 19 * dayMs,
        nowMs - 20 * dayMs,
        nowMs - 19 * dayMs,
      );

      db.prepare(
        `INSERT INTO affiliate_funnel_visits (affiliate_id, day_utc, visit_count, updated_at)
         VALUES (?, ?, 128, ?)`,
      ).run(affId, new Date(nowMs).toISOString().slice(0, 10), nowMs);

      // Seed referred paying tenant & trial tenant with unique handles if existing
      const uniquePaidHandle = `${secretHandle}-${suffix.slice(-3)}`.slice(0, 24);
      const uniqueTrialHandle = `${secretTrialHandle}-${suffix.slice(-3)}`.slice(0, 24);
      const maskedPaidHandle = `${uniquePaidHandle.slice(0, 2)}***${uniquePaidHandle.slice(-2)}`;
      const maskedTrialHandle = `${uniqueTrialHandle.slice(0, 2)}***${uniqueTrialHandle.slice(-2)}`;

      db.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, 'CV Kopi Nusantara Rahasia', ?, ?, ?)`,
      ).run(secretOrgId, uniquePaidHandle, nowMs - 18 * dayMs, nowMs);
      db.prepare(
        `INSERT INTO tenants (id, organization_id, referred_by_affiliate_id, handle, name, vertical, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'CV Kopi Nusantara Rahasia', 'compro', 'active', ?, ?)`,
      ).run(secretTenantId, secretOrgId, affId, uniquePaidHandle, nowMs - 18 * dayMs, nowMs);
      db.prepare(
        `INSERT INTO affiliate_referrals (tenant_id, affiliate_id, referral_code, attribution_source, attributed_at, locked, version, created_at, updated_at)
         VALUES (?, ?, ?, 'cookie', ?, 1, 1, ?, ?)`,
      ).run(secretTenantId, affId, refCode, nowMs - 18 * dayMs, nowMs - 18 * dayMs, nowMs - 18 * dayMs);

      db.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, 'Toko Rahasia Trial', ?, ?, ?)`,
      ).run(secretTrialOrgId, uniqueTrialHandle, nowMs - 2 * dayMs, nowMs);
      db.prepare(
        `INSERT INTO tenants (id, organization_id, referred_by_affiliate_id, handle, name, vertical, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Toko Rahasia Trial', 'catalog', 'trial', ?, ?)`,
      ).run(secretTrialTenantId, secretTrialOrgId, affId, uniqueTrialHandle, nowMs - 2 * dayMs, nowMs);
      db.prepare(
        `INSERT INTO affiliate_referrals (tenant_id, affiliate_id, referral_code, attribution_source, attributed_at, locked, version, created_at, updated_at)
         VALUES (?, ?, ?, 'cookie', ?, 1, 1, ?, ?)`,
      ).run(
        secretTrialTenantId,
        affId,
        refCode,
        nowMs - 2 * dayMs,
        nowMs - 2 * dayMs,
        nowMs - 2 * dayMs,
      );

      // Seed 1 paid batch + 1 pending_review batch + approved/pending commission entries
      db.prepare(
        `INSERT INTO affiliate_commission_payout_batches (
           id, affiliate_id, payout_period_key, total_amount_idr, entry_count, status,
           transfer_reference, paid_at, paid_by_user_id, status_reason, version, created_at, updated_at
         ) VALUES (?, ?, '2026-11-15', 107400, 1, 'paid', 'TRF-BCA-20261115-001', ?, ?, 'Transfer selesai', 2, ?, ?)`,
      ).run(batchPaidId, affId, nowMs - 10 * dayMs, opUserId, nowMs - 11 * dayMs, nowMs - 10 * dayMs);

      db.prepare(
        `INSERT INTO affiliate_commission_payout_batches (
           id, affiliate_id, payout_period_key, total_amount_idr, entry_count, status,
           version, created_at, updated_at
         ) VALUES (?, ?, '2026-11-30', 143200, 2, 'pending_review', 1, ?, ?)`,
      ).run(batchPendingId, affId, nowMs - dayMs, nowMs - dayMs);

      const snapshotJson = JSON.stringify({
        firstPaymentRateBps: 6000,
        renewalRateBps: 2000,
        holdDays: 14,
        minimumPayoutIdr: 100000,
        source: "default",
      });

      // Paid first payment
      db.prepare(
        `INSERT INTO affiliate_commission_entries (
           id, affiliate_id, tenant_id, entry_kind, gross_amount_idr, discount_amount_idr,
           ppn_amount_idr, channel_fee_idr, net_base_idr, rate_bps, commission_idr, status,
           confirmed_at, hold_until_at, approved_at, payout_batch_id, settings_snapshot_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, 'first_payment', 179000, 0, 0, 0, 179000, 6000, 107400, 'paid', ?, ?, ?, ?, ?, 3, ?, ?)`,
      ).run(
        `ce_paid_${suffix}`,
        affId,
        secretTenantId,
        nowMs - 28 * dayMs,
        nowMs - 14 * dayMs,
        nowMs - 14 * dayMs,
        batchPaidId,
        snapshotJson,
        nowMs - 28 * dayMs,
        nowMs - 10 * dayMs,
      );

      // Batched renewal in pending_review batch
      db.prepare(
        `INSERT INTO affiliate_commission_entries (
           id, affiliate_id, tenant_id, entry_kind, gross_amount_idr, discount_amount_idr,
           ppn_amount_idr, channel_fee_idr, net_base_idr, rate_bps, commission_idr, status,
           confirmed_at, hold_until_at, approved_at, payout_batch_id, settings_snapshot_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, 'renewal', 716000, 0, 0, 0, 716000, 2000, 143200, 'batched', ?, ?, ?, ?, ?, 2, ?, ?)`,
      ).run(
        `ce_bat_${suffix}`,
        affId,
        secretTenantId,
        nowMs - 16 * dayMs,
        nowMs - 2 * dayMs,
        nowMs - 2 * dayMs,
        batchPendingId,
        snapshotJson,
        nowMs - 16 * dayMs,
        nowMs - dayMs,
      );

      // Approved available renewal (75.000) + Pending hold renewal (35.800)
      db.prepare(
        `INSERT INTO affiliate_commission_entries (
           id, affiliate_id, tenant_id, entry_kind, gross_amount_idr, discount_amount_idr,
           ppn_amount_idr, channel_fee_idr, net_base_idr, rate_bps, commission_idr, status,
           confirmed_at, hold_until_at, approved_at, payout_batch_id, settings_snapshot_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, 'renewal', 375000, 0, 0, 0, 375000, 2000, 75000, 'approved', ?, ?, ?, NULL, ?, 2, ?, ?)`,
      ).run(
        `ce_app_${suffix}`,
        affId,
        secretTenantId,
        nowMs - 15 * dayMs,
        nowMs - dayMs,
        nowMs - dayMs,
        snapshotJson,
        nowMs - 15 * dayMs,
        nowMs - dayMs,
      );

      db.prepare(
        `INSERT INTO affiliate_commission_entries (
           id, affiliate_id, tenant_id, entry_kind, gross_amount_idr, discount_amount_idr,
           ppn_amount_idr, channel_fee_idr, net_base_idr, rate_bps, commission_idr, status,
           confirmed_at, hold_until_at, approved_at, payout_batch_id, settings_snapshot_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, 'renewal', 179000, 0, 0, 0, 179000, 2000, 35800, 'pending', ?, ?, NULL, NULL, ?, 1, ?, ?)`,
      ).run(
        `ce_pnd_${suffix}`,
        affId,
        secretTenantId,
        nowMs - dayMs,
        nowMs + 13 * dayMs,
        snapshotJson,
        nowMs - dayMs,
        nowMs - dayMs,
      );

      // Attach secret owner email to make sure it never leaks
      db.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES (?, 'Rahasia Pemilik Kopi', ?, 1, ?, ?)`,
      ).run(`usr_sec_${suffix}`, secretOwnerEmail, nowMs, nowMs);

      // Store expected masked handles for assertions
      globalThis.__t086Handles = {
        uniquePaidHandle,
        uniqueTrialHandle,
        maskedPaidHandle,
        maskedTrialHandle,
      };
    } finally {
      db.close();
    }

    // 1. Tenant-only user gets 403 AFFILIATE_ACCOUNT_REQUIRED on /api/affiliate/overview
    //    and clean enrollment CTA (zero affiliate data) on /affiliate!
    await gotoAndWaitForTestId(tenantPage, `${baseUrl}/affiliate`, "affiliate-enrollment-panel");
    const tenantApiStatus = await tenantPage.evaluate(async () => {
      const r = await fetch("/api/affiliate/overview", { credentials: "same-origin" });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, code: body.code };
    });
    assert(
      tenantApiStatus.status === 403 && tenantApiStatus.code === "AFFILIATE_ACCOUNT_REQUIRED",
      `Expected 403 AFFILIATE_ACCOUNT_REQUIRED for tenant-only user, got ${JSON.stringify(tenantApiStatus)}`,
    );
    const tenantHtml = await tenantPage.content();
    assert(!tenantHtml.includes(refCode), "Tenant-only page must not leak affiliate referral code");

    // 2. Affiliate user opens /affiliate at 1440px and 360px
    await gotoAndWaitForTestId(affPage, `${baseUrl}/affiliate`, "affiliate-dashboard-panel");
    await affPage.locator('[data-testid="affiliate-referral-link-card"]').waitFor({ state: "visible" });

    const affHtml = await affPage.content();
    const { uniquePaidHandle, uniqueTrialHandle, maskedPaidHandle, maskedTrialHandle } =
      globalThis.__t086Handles;
    assert(affHtml.includes(refCode), "Affiliate portal must render referral code");
    assert(affHtml.includes(maskedPaidHandle), `Affiliate portal must render masked handle ${maskedPaidHandle}`);
    assert(affHtml.includes(maskedTrialHandle), `Affiliate portal must render masked handle ${maskedTrialHandle}`);
    assert(affHtml.includes("TRF-BCA-20261115-001"), "Affiliate portal must render paid batch transfer reference");

    // ZERO TENANT PII LEAK CHECK ON RENDERED HTML!
    for (const forbidden of [
      uniquePaidHandle,
      uniqueTrialHandle,
      "CV Kopi Nusantara Rahasia",
      "Toko Rahasia Trial",
      secretOwnerEmail,
      "Rahasia Pemilik Kopi",
    ]) {
      assert(!affHtml.includes(forbidden), `Affiliate portal HTML leaked forbidden PII: ${forbidden}`);
    }

    await assertViewportLayoutAndTouchTargets(affPage, "affiliate-portal", 1440);
    savedScreenshots.push(await captureScreenshot(affPage, "affiliate-portal-1440.png"));

    await affPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(affPage, "affiliate-portal", 360);
    savedScreenshots.push(await captureScreenshot(affPage, "affiliate-portal-360.png"));

    // 3. Operator enrolls/verifies 2FA and opens /console/affiliates at 1440px and 360px
    await enrollAndVerify2FAInBrowser(opPage, sqlitePath, opUserId, password);
    await gotoAndWaitForTestId(opPage, `${baseUrl}/console/affiliates`, "console-affiliates-panel");
    await opPage.locator(`[data-testid="console-batch-row-${batchPendingId}"]`).waitFor({ state: "visible" });

    // Verify REQ-095 compliance gate blocks mark-paid before resolution (UI shows destructive alert)
    await opPage.fill("#mark-paid-transfer-ref", "TRF-BCA-20261130-009");
    await opPage.fill("#mark-paid-reason", "Transfer bank manual periode 30 November telah dikonfirmasi.");
    await opPage.click('[data-testid="console-mark-paid-submit"]');
    await opPage.locator('[data-testid="console-affiliates-error"]').waitFor({ state: "visible" });

    // Resolve REQ-095 compliance via Console UI
    await opPage.check("#req095-terms-published");
    await opPage.check("#req095-tax-review");
    await opPage.fill(
      "#req095-compliance-reason",
      "Ketentuan program afiliasi dan tinjauan PPh 21/23 selesai diverifikasi.",
    );
    await opPage.click('[data-testid="console-compliance-submit"]');
    await opPage.locator('[data-testid="console-affiliates-success"]').waitFor({ state: "visible" });

    // Capture Console Affiliates screenshots at 1440px and 360px (showing affiliates list + mark-paid form ready)
    await assertViewportLayoutAndTouchTargets(opPage, "console-affiliates", 1440);
    savedScreenshots.push(await captureScreenshot(opPage, "console-affiliates-1440.png"));

    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(opPage, "console-affiliates", 360);
    savedScreenshots.push(await captureScreenshot(opPage, "console-affiliates-360.png"));
    await opPage.setViewportSize({ width: 1440, height: 900 });

    // Now mark the pending batch paid!
    await opPage.click('[data-testid="console-mark-paid-submit"]');
    await opPage.locator('[data-testid="console-affiliates-success"]').waitFor({ state: "visible" });
    const paidBadgeVisible = await opPage.evaluate((ref) => document.body.innerText.includes(ref), "TRF-BCA-20261130-009");
    assert(paidBadgeVisible, "Marked-paid transfer reference should appear in Console table");

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Uncaught page errors detected:\n${pageErrors.join("\n")}`);

    console.log("TASK-086 E2E PASSED:");
    console.log("Screenshots:", savedScreenshots.join(", "));
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
