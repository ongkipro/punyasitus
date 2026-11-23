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

const SCREENSHOT_DIR = process.env.TASK082_SCREENSHOT_DIR || "";
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'promo_coupons' LIMIT 1")
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(`Could not locate migrated PLATFORM_DB with promo_coupons under ${persistDir}`);
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

async function waitForServer(getPort, timeoutMs = 30_000) {
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

async function maybeCaptureScreenshot(page, filename) {
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function makeCrockfordUlid() {
  const bytes = crypto.randomBytes(26);
  let out = "01J";
  for (let i = 3; i < 26; i += 1) {
    out += CROCKFORD[bytes[i] % CROCKFORD.length];
  }
  return out;
}

function makeUlidLike(prefix) {
  const rand = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `${prefix}_${Date.now().toString(36).toUpperCase()}${rand}`.slice(0, 26);
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
    const password = "CouponE2ePassword!2026";
    const ownerEmail = `t082-owner-${suffix}@example.com`;
    const opEmail = `t082-op-${suffix}@example.com`;
    const handle = `kopi-t082-${suffix}`.slice(0, 32);
    const liveCouponCode = `HEMAT20_${suffix.slice(-4).toUpperCase()}`;
    const expiredCouponCode = `EXPIRED_${suffix.slice(-4).toUpperCase()}`;

    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [ownerPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          // Intentional 422 response from the expired-coupon validation check logs a browser network notice
          if (text.includes("status of 422")) return;
          consoleErrors.push(text);
        }
      });
      p.on("pageerror", (err) => pageErrors.push(String(err)));
    }

    const ownerUserId = await signUpInBrowser(ownerPage, baseUrl, ownerEmail, password, "Budi Pemilik");
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Superadmin Kupon");

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const orgId = makeUlidLike("ORG");
    const tenantId = makeCrockfordUlid();

    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE users SET email_verified = 1 WHERE lower(email) IN (?, ?)").run(
        ownerEmail.toLowerCase(),
        opEmail.toLowerCase(),
      );
      db.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(orgId, "Kopi Nusantara T082", handle, nowMs, nowMs);
      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'trial', 0, ?, NULL, ?, ?)`,
      ).run(tenantId, orgId, handle, "Kopi Nusantara T082", nowMs + 5 * dayMs, nowMs, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).run(makeUlidLike("MEM"), orgId, ownerUserId, nowMs);
      // Seed one expired coupon for inline error verification
      db.prepare(
        `INSERT INTO promo_coupons (
           id, code, discount_kind, discount_value, eligible_plans_json, eligible_payer_types_json,
           max_redemptions, redeemed_count, starts_at, ends_at, active, notes, created_by_user_id,
           version, created_at, updated_at
         ) VALUES (?, ?, 'percent', 15, '["monthly","yearly"]', '["tenant","agency"]', 10, 0, ?, ?, 1, 'Expired E2E coupon', ?, 1, ?, ?)`,
      ).run(
        makeCrockfordUlid(),
        expiredCouponCode,
        nowMs - 20 * dayMs,
        nowMs - 2 * dayMs,
        opUserId,
        nowMs,
        nowMs,
      );
    } finally {
      db.close();
    }

    // Bootstrap Platform Operator & enroll real 2FA
    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-082 Chromium E2E operator bootstrap",
        "--db-file",
        sqlitePath,
        "--local",
      ],
      { cwd: root, env: cleanChildEnv(), encoding: "utf8" },
    );
    assert(cliRes.status === 0, `platform-operator CLI failed: ${cliRes.stderr}`);

    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", password);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const opSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    await opPage.fill("#twofa-confirm-code", generateTotpCode(opSecret));
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    // =========================================================================
    // SCENARIO 1: /console/coupons — Create & Toggle Live Promo Coupon
    // =========================================================================
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/coupons`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-coupons-panel"]');

    const bannerText = await opPage.textContent('[data-testid="console-context-banner"]');
    assert(
      bannerText && bannerText.includes("Console Operasional Platform"),
      "Missing privileged console banner on /console/coupons",
    );

    await opPage.fill('[data-testid="coupon-code-input"]', liveCouponCode);
    await opPage.selectOption('[data-testid="coupon-discount-kind-select"]', "percent");
    await opPage.fill('[data-testid="coupon-discount-value-input"]', "20");
    await opPage.fill('[data-testid="coupon-max-redemptions-input"]', "5");
    await opPage.fill('[data-testid="coupon-notes-input"]', "Promo diskon 20% tahunan dan bulanan");
    await opPage.fill(
      '[data-testid="coupon-reason-input"]',
      "Aktivasi kupon promo diskon 20 persen untuk pengujian E2E",
    );
    await opPage.click('[data-testid="coupon-create-submit-btn"]');
    await opPage.waitForSelector('[data-testid="coupons-success-alert"]');
    await opPage.waitForSelector(`[data-testid="console-coupon-row-${liveCouponCode}"]`);

    await assertViewportLayoutAndTouchTargets(opPage, "console-coupons", 1440);
    await maybeCaptureScreenshot(opPage, "console-coupons-1440.png");

    // Toggle inactive and then back active cleanly
    await opPage.click(`[data-testid="console-coupon-toggle-${liveCouponCode}"]`);
    await opPage.waitForFunction(
      (code) =>
        document
          .querySelector(`[data-testid="console-coupon-status-${code}"]`)
          ?.textContent?.includes("Nonaktif"),
      liveCouponCode,
    );
    await opPage.click(`[data-testid="console-coupon-toggle-${liveCouponCode}"]`);
    await opPage.waitForFunction(
      (code) =>
        document
          .querySelector(`[data-testid="console-coupon-status-${code}"]`)
          ?.textContent?.includes("Aktif"),
      liveCouponCode,
    );

    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(opPage, "console-coupons", 360);

    // =========================================================================
    // SCENARIO 2: Owner Billing Checkout — Yearly Savings + Real Coupon Apply/Error/Remove
    // =========================================================================
    // Provide live QRIS & VA channels in overview response while leaving /coupons/validate REAL against local D1!
    await ownerPage.route("**/api/tenants/*/billing", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.channels = [
        { code: "QRIS", label: "QRIS Nasional", kind: "QRIS", estimatedFeeIdr: 1_253, enabled: true },
        { code: "VABCA", label: "BCA Virtual Account", kind: "VA", estimatedFeeIdr: 4_000, enabled: true },
      ];
      json.providerOutage = false;
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    });

    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${handle}/billing`, { waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="owner-billing-panel"]');
    await ownerPage.click('[data-testid="billing-refresh-status-btn"]');
    await ownerPage.waitForSelector('[data-testid="billing-channel-VABCA"]');

    // Select Yearly plan + VABCA channel -> verify live savings Rp 358.000
    const savingsText = await ownerPage.textContent('[data-testid="billing-yearly-savings-badge"]');
    assert(savingsText && savingsText.includes("Rp 358.000"), `Expected Hemat Rp 358.000, got ${savingsText}`);

    await ownerPage.click('[data-testid="billing-plan-yearly"]');
    await ownerPage.click('[data-testid="billing-channel-VABCA"]');
    const preDiscountTotal = await ownerPage.textContent('[data-testid="billing-summary-total"]');
    assert(preDiscountTotal && preDiscountTotal.includes("Rp 1.794.000"), `Expected Rp 1.794.000 before coupon, got ${preDiscountTotal}`);

    // 1. Expired coupon -> inline error message with explicit code
    await ownerPage.fill('[data-testid="billing-coupon-input"]', expiredCouponCode);
    await ownerPage.click('[data-testid="billing-coupon-apply-btn"]');
    await ownerPage.waitForSelector('[data-testid="billing-coupon-error"]');
    const errText = await ownerPage.textContent('[data-testid="billing-coupon-error"]');
    assert(
      errText && errText.includes("COUPON_EXPIRED"),
      `Expected COUPON_EXPIRED inline error, got: ${errText}`,
    );

    // 2. Valid coupon created via /console/coupons -> real server validation + itemized discount line!
    await ownerPage.fill('[data-testid="billing-coupon-input"]', liveCouponCode);
    await ownerPage.click('[data-testid="billing-coupon-apply-btn"]');
    await ownerPage.waitForSelector('[data-testid="billing-summary-coupon-discount"]');

    const discountRowText = await ownerPage.textContent('[data-testid="billing-summary-coupon-discount"]');
    const netBaseRowText = await ownerPage.textContent('[data-testid="billing-summary-net-base"]');
    const postDiscountTotal = await ownerPage.textContent('[data-testid="billing-summary-total"]');

    assert(
      discountRowText && discountRowText.includes(liveCouponCode) && discountRowText.includes("-Rp 358.000"),
      `Expected itemized coupon discount line, got: ${discountRowText}`,
    );
    assert(
      netBaseRowText && netBaseRowText.includes("Rp 1.432.000"),
      `Expected net subtotal Rp 1.432.000, got: ${netBaseRowText}`,
    );
    assert(
      postDiscountTotal && postDiscountTotal.includes("Rp 1.436.000"),
      `Expected final total Rp 1.436.000, got: ${postDiscountTotal}`,
    );

    await assertViewportLayoutAndTouchTargets(ownerPage, "billing-coupon-checkout", 1440);
    await maybeCaptureScreenshot(ownerPage, "billing-coupon-checkout-1440.png");

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(ownerPage, "billing-coupon-checkout", 360);
    await maybeCaptureScreenshot(ownerPage, "billing-coupon-checkout-360.png");

    // 3. Remove coupon -> discount line removed & total restored cleanly
    await ownerPage.click('[data-testid="billing-coupon-remove-btn"]');
    await ownerPage.waitForFunction(
      () => !document.querySelector('[data-testid="billing-summary-coupon-discount"]'),
    );
    const restoredTotal = await ownerPage.textContent('[data-testid="billing-summary-total"]');
    assert(
      restoredTotal && restoredTotal.includes("Rp 1.794.000"),
      `Expected restored total Rp 1.794.000 after remove, got: ${restoredTotal}`,
    );

    assert(
      consoleErrors.length === 0,
      `Console errors detected during TASK-082 E2E:\n${consoleErrors.join("\n")}`,
    );
    assert(
      pageErrors.length === 0,
      `Uncaught page errors detected during TASK-082 E2E:\n${pageErrors.join("\n")}`,
    );

    console.log("TASK-082 Playwright Chromium E2E passed (console coupons + owner checkout coupons at 360px & 1440px).");
  } catch (err) {
    console.error("TASK-082 E2E failed. Recent server logs:\n", serverLogs.slice(-3000));
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
