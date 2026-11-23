/* global process, console, Buffer, setTimeout, document, window, getComputedStyle, fetch, URL */
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

const SCREENSHOT_DIR =
  process.env.TASK061_SCREENSHOT_DIR || "/tmp/punyasitus-t061-screenshots";
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
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_theme_packages' LIMIT 1",
        )
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(
    `Could not locate migrated PLATFORM_DB with custom_theme_packages under ${persistDir}`,
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
      if (ctrl.tag === "A" && !ctrl.id.startsWith("btn-") && !ctrl.id.startsWith("link-")) continue;
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

const capturedScreenshots = [];
async function captureScreenshot(page, filename) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  const fullPath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  capturedScreenshots.push(fullPath);
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
    const password = "CustomThemeE2e!2026";
    const ownerEmail = `t061-owner-${suffix}@example.com`;
    const editorEmail = `t061-editor-${suffix}@example.com`;
    const opEmail = `t061-op-${suffix}@example.com`;
    const activeHandle = `t061-situs-${suffix}`.slice(0, 32);
    const lockedHandle = `t061-lock-${suffix}`.slice(0, 32);
    const pricedSlug = `brand-pro-${suffix.slice(-5)}`;
    const quoteSlug = `korporat-${suffix.slice(-5)}`;

    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const editorCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const editorPage = await editorCtx.newPage();
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [ownerPage, editorPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (text.includes("status of 422") || text.includes("status of 403")) return;
          consoleErrors.push(text);
        }
      });
      p.on("pageerror", (err) => pageErrors.push(String(err)));
    }

    const ownerUserId = await signUpInBrowser(ownerPage, baseUrl, ownerEmail, password, "Sari Pemilik");
    const editorUserId = await signUpInBrowser(editorPage, baseUrl, editorEmail, password, "Dian Editor");
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Superadmin Tema");

    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const activeOrgId = makeUlidLike("ORG");
    const activeTenantId = makeCrockfordUlid();
    const lockedOrgId = makeUlidLike("ORGL");
    const lockedTenantId = makeCrockfordUlid();

    const db = new DatabaseSync(sqlitePath);
    try {
      // Ensure clean active packages before testing empty contact-only state
      db.prepare("UPDATE custom_theme_packages SET active = 0 WHERE service_kind = 'custom_theme'").run();

      db.prepare("UPDATE users SET email_verified = 1 WHERE lower(email) IN (?, ?, ?)").run(
        ownerEmail.toLowerCase(),
        editorEmail.toLowerCase(),
        opEmail.toLowerCase(),
      );

      // Platform sales WhatsApp setting
      db.prepare(
        `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
         VALUES ('platform.public_settings', ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(
        JSON.stringify({
          salesWhatsapp: "6281290006161",
          supportEmail: "halo@punyasitus.com",
          termsUrl: "https://punyasitus.com/syarat",
          privacyUrl: "https://punyasitus.com/privasi",
          supportHours: "Senin–Jumat, 09.00–17.00 WIB",
          supportResponseTarget: "Maksimal 1 hari kerja",
        }),
        opUserId,
        nowMs,
      );

      // Active tenant (owner + editor)
      db.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(activeOrgId, "Kopi Nusantara Studio", activeHandle, nowMs, nowMs);
      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, NULL, ?, ?, ?)`,
      ).run(activeTenantId, activeOrgId, activeHandle, "Kopi Nusantara Studio", nowMs + 25 * dayMs, nowMs, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).run(makeUlidLike("MEMO"), activeOrgId, ownerUserId, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)",
      ).run(makeUlidLike("MEME"), activeOrgId, editorUserId, nowMs);

      // Locked tenant (owner)
      db.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(lockedOrgId, "Situs Terkunci T061", lockedHandle, nowMs, nowMs);
      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'locked', 0, NULL, ?, ?, ?)`,
      ).run(lockedTenantId, lockedOrgId, lockedHandle, "Situs Terkunci T061", nowMs - 5 * dayMs, nowMs, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).run(makeUlidLike("MEML"), lockedOrgId, ownerUserId, nowMs);
    } finally {
      db.close();
    }

    // Bootstrap operator & enroll 2FA
    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-061 Chromium E2E operator bootstrap",
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
    // 1. Empty package list -> clean contact-only state on tenant service page
    // =========================================================================
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/appearance/themes/custom`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector('[data-testid="custom-theme-packages-empty"]');
    const contactWaHref = await ownerPage.getAttribute('[data-testid="btn-wa-contact-only"]', "href");
    assert(
      contactWaHref && contactWaHref.startsWith("https://wa.me/6281290006161?text="),
      `Expected contact-only WA CTA, got: ${contactWaHref}`,
    );
    await captureScreenshot(ownerPage, "01-tenant-empty-contact-only-1440.png");

    // Editor cannot open the page (403)
    const editorResp = await editorPage.goto(
      `${baseUrl}/dashboard/${activeHandle}/appearance/themes/custom`,
      { waitUntil: "domcontentloaded" },
    );
    assert(editorResp?.status() === 403, `Expected 403 for editor, got ${editorResp?.status()}`);

    // Locked tenant CANNOT open the page -> redirected to /service-status
    await ownerPage.goto(`${baseUrl}/dashboard/${lockedHandle}/appearance/themes/custom`, {
      waitUntil: "networkidle",
    });
    assert(
      ownerPage.url().includes(`/dashboard/${lockedHandle}/service-status`),
      `Expected locked tenant redirect to /service-status, got ${ownerPage.url()}`,
    );

    // =========================================================================
    // 2. Console /console/custom-themes — Create 2 packages (quote-only + priced)
    // =========================================================================
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/custom-themes`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-custom-themes-panel"]');

    // Package 1: Quote-only (sortOrder 10)
    await opPage.fill('[data-testid="input-pkg-slug"]', quoteSlug);
    await opPage.fill('[data-testid="input-pkg-sort"]', "10");
    await opPage.fill('[data-testid="input-pkg-name"]', "Paket Korporat Penawaran");
    await opPage.fill(
      '[data-testid="input-pkg-description"]',
      "Desain identitas visual kustom berskala korporat sesuai ruang lingkup bisnis.",
    );
    await opPage.fill(
      '[data-testid="input-pkg-inclusions"]',
      "Workshop brand & struktur halaman\nKomponen kustom khusus korporat\nOptimasi SEO & Core Web Vitals",
    );
    await opPage.fill('[data-testid="input-pkg-price"]', "");
    await opPage.fill('[data-testid="input-pkg-duration"]', "2–3 minggu");
    await opPage.fill(
      '[data-testid="input-pkg-reason"]',
      "Menambahkan paket tema kustom berbasis penawaran untuk E2E TASK-061",
    );
    await opPage.click('[data-testid="btn-create-package"]');
    await opPage.waitForSelector(`[data-testid="console-package-row-${quoteSlug}"]`);

    // Package 2: Priced (sortOrder 20)
    await opPage.fill('[data-testid="input-pkg-slug"]', pricedSlug);
    await opPage.fill('[data-testid="input-pkg-sort"]', "20");
    await opPage.fill('[data-testid="input-pkg-name"]', "Paket Brand Pro");
    await opPage.fill(
      '[data-testid="input-pkg-description"]',
      "Tema kustom siap pakai untuk bisnis berkembang dengan 5 halaman prioritas.",
    );
    await opPage.fill(
      '[data-testid="input-pkg-inclusions"]',
      "Desain khusus 5 halaman inti\n2 putaran revisi desain\nIntegrasi WhatsApp & formulir prospek",
    );
    await opPage.fill('[data-testid="input-pkg-price"]', "4500000");
    await opPage.fill('[data-testid="input-pkg-duration"]', "10–14 hari kerja");
    await opPage.fill(
      '[data-testid="input-pkg-reason"]',
      "Menambahkan paket tema kustom Brand Pro harga mulai IDR 4.500.000",
    );
    await opPage.click('[data-testid="btn-create-package"]');
    await opPage.waitForSelector(`[data-testid="console-package-row-${pricedSlug}"]`);

    await assertViewportLayoutAndTouchTargets(opPage, "console-packages", 1440);
    await captureScreenshot(opPage, "02-console-packages-1440.png");

    await opPage.setViewportSize({ width: 360, height: 800 });
    await opPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(opPage, "console-packages", 360);
    await captureScreenshot(opPage, "03-console-packages-360.png");

    // =========================================================================
    // 3. Tenant /dashboard/{handle}/appearance/themes/custom — Packages, Form Errors, Submit & WA CTA
    // =========================================================================
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/appearance/themes/custom`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector('[data-testid="custom-theme-packages-grid"]');

    // Verify sort order & pricing labels
    const priceQuote = await ownerPage.textContent(`[data-testid="package-price-${quoteSlug}"]`);
    const pricePriced = await ownerPage.textContent(`[data-testid="package-price-${pricedSlug}"]`);
    assert(priceQuote?.includes("Harga berdasarkan penawaran"), `Unexpected quote label: ${priceQuote}`);
    assert(pricePriced?.includes("Mulai dari Rp 4.500.000"), `Unexpected priced label: ${pricePriced}`);

    // Select Brand Pro package via keyboard focus & click
    await ownerPage.focus(`[data-testid="btn-select-package-${pricedSlug}"]`);
    await ownerPage.keyboard.press("Enter");

    // Trigger inline validation error (http:// URL) and verify user input is preserved!
    await ownerPage.fill('[data-testid="input-brand-name"]', "Kopi Nusantara Roastery");
    await ownerPage.fill(
      '[data-testid="textarea-brief"]',
      "Kami menginginkan tema kustom bergaya editorial hangat dengan katalog biji kopi dan cerita petani.",
    );
    await ownerPage.fill('[data-testid="input-reference-url-0"]', "http://tidak-aman.example.com");
    await ownerPage.click('[data-testid="btn-submit-custom-theme-request"]');
    await ownerPage.waitForSelector('[data-testid="request-form-error"]');
    const preservedBrief = await ownerPage.inputValue('[data-testid="textarea-brief"]');
    assert(preservedBrief.includes("editorial hangat"), "Brief must be preserved on validation error");
    await captureScreenshot(ownerPage, "04-tenant-form-error-1440.png");

    // Fix URL to HTTPS and submit successfully
    await ownerPage.fill('[data-testid="input-reference-url-0"]', "https://referensi-kopi.example.com");
    await ownerPage.fill('[data-testid="input-budget-range"]', "Rp 5 jt – Rp 8 jt");
    await ownerPage.click('[data-testid="btn-submit-custom-theme-request"]');
    await ownerPage.waitForSelector('[data-testid="request-submit-success"]');

    // Verify single-encoded WA CTA
    const afterSubmitWa = await ownerPage.getAttribute('[data-testid="btn-wa-after-submit"]', "href");
    assert(afterSubmitWa && afterSubmitWa.startsWith("https://wa.me/6281290006161?text="), "WA CTA missing");
    assert(!afterSubmitWa.includes("%2520"), `Double encoding detected in WA URL: ${afterSubmitWa}`);
    const decodedWa = new URL(afterSubmitWa).searchParams.get("text") ?? "";
    assert(decodedWa.includes(activeHandle), "WA text missing tenant handle");
    assert(decodedWa.includes("CTR-"), "WA text missing request code");
    assert(decodedWa.includes("Paket Brand Pro"), "WA text missing package name");

    // Capture tenant page across 1440 / 768 / 360px
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-service", 1440);
    await captureScreenshot(ownerPage, "05-tenant-service-1440.png");

    await ownerPage.setViewportSize({ width: 768, height: 1024 });
    await ownerPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-service", 768);
    await captureScreenshot(ownerPage, "06-tenant-service-768.png");

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-service", 360);
    await captureScreenshot(ownerPage, "07-tenant-service-360.png");

    // =========================================================================
    // 4. Console Requests Queue — Grant Custom Theme & Mark Request Delivered
    // =========================================================================
    const db2 = new DatabaseSync(sqlitePath);
    try {
      db2
        .prepare(
          `INSERT OR IGNORE INTO theme_catalog (id, slug, name, tier, price_idr, active, version, created_at, updated_at)
           VALUES ('custom-sample-agency', 'custom-sample-agency', 'Sample Agency Bespoke', 'custom', 0, 1, 1, ?, ?)`,
        )
        .run(nowMs, nowMs);
      db2
        .prepare(
          `INSERT OR IGNORE INTO tenant_theme_entitlements (id, tenant_id, theme_id, granted_by, settlement_id, granted_at)
           VALUES (?, ?, 'custom-sample-agency', ?, NULL, ?)`,
        )
        .run(makeCrockfordUlid(), activeTenantId, opUserId, nowMs);
    } finally {
      db2.close();
    }

    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/custom-themes`, { waitUntil: "networkidle" });
    await opPage.click('[data-testid="tab-console-requests"]');
    await opPage.waitForSelector('[data-testid="console-requests-section"]');
    await opPage.fill('[data-testid="input-console-request-search"]', activeHandle);
    await opPage.waitForTimeout(150);

    const reqCardTestId = await opPage.evaluate(() => {
      const el = document.querySelector('[data-testid^="console-request-card-CTR-"]');
      return el?.getAttribute("data-testid") ?? "";
    });
    assert(reqCardTestId, "Expected submitted request card in console queue");
    const reqCode = reqCardTestId.replace("console-request-card-", "");

    await opPage.click(`[data-testid="btn-open-transition-${reqCode}"]`);
    await opPage.selectOption(`[data-testid="select-next-status-${reqCode}"]`, "delivered");
    await opPage.selectOption(
      `[data-testid="select-delivered-theme-${reqCode}"]`,
      "custom-sample-agency",
    );
    await opPage.fill(
      `[data-testid="input-transition-reason-${reqCode}"]`,
      "Tema kustom custom-sample-agency selesai dikerjakan dan izin aktif telah ditautkan",
    );
    await opPage.click(`[data-testid="btn-confirm-transition-${reqCode}"]`);
    await opPage.waitForSelector('[data-testid="console-custom-themes-notice"]');

    await assertViewportLayoutAndTouchTargets(opPage, "console-requests", 1440);
    await captureScreenshot(opPage, "08-console-requests-delivered-1440.png");

    await opPage.setViewportSize({ width: 768, height: 1024 });
    await opPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(opPage, "console-requests", 768);
    await captureScreenshot(opPage, "09-console-requests-delivered-768.png");

    // Tenant sees delivered theme summary & delivered request status
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/appearance/themes/custom`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector(`[data-testid="request-delivered-banner-${reqCode}"]`);
    await ownerPage.waitForSelector('[data-testid="granted-custom-themes-summary"]');
    await captureScreenshot(ownerPage, "10-tenant-delivered-1440.png");

    assert(consoleErrors.length === 0, `Unexpected browser console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${pageErrors.join(" | ")}`);

    console.log("TASK-061 E2E PASSED");
    for (const file of capturedScreenshots) {
      console.log(`SCREENSHOT: ${file}`);
    }
  } catch (err) {
    if (serverLogs) {
      console.error("Server logs:\n", serverLogs.slice(-2000));
    }
    throw err;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (server.exitCode === null) server.kill("SIGKILL");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
