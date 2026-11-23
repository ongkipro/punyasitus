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
  process.env.TASK069_SCREENSHOT_DIR || "/tmp/task-069-screenshots";
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
    async ({ email: e, password: p, name: n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, userId: json?.user?.id ?? "" };
    },
    { email, password, name },
  );
  assert(res.status === 200 && res.userId, `Sign-up failed for ${email}: status=${res.status}`);
  return res.userId;
}

function makeCrockfordUlid() {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "01JT069E2E";
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i += 1) {
    out += chars[bytes[i] & 31];
  }
  return out;
}

async function run() {
  const persistTo = ensureLocalD1Migrated();
  const sqlitePath = findPlatformSqlitePath(persistTo);

  let activePort = await getFreePort();
  const server = spawn(
    "pnpm",
    ["--filter", "@punyasitus/web", "exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(activePort)],
    {
      cwd: root,
      env: cleanChildEnv({ APP_ENV: "local", PLATFORM_DOMAIN: "punyasitus.com" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  const parsePort = (chunk) => {
    const txt = chunk.toString();
    serverLogs += txt;
    const match = txt.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) activePort = Number.parseInt(match[1], 10);
  };
  server.stdout.on("data", parsePort);
  server.stderr.on("data", parsePort);

  let browser;
  try {
    const port = await waitForServer(() => activePort);
    const baseUrl = `http://127.0.0.1:${port}`;
    const suffix = crypto.randomBytes(3).toString("hex");
    const password = "StrongE2ePassword!2026";
    const ownerEmail = `owner-t069-${suffix}@example.test`;
    const editorEmail = `editor-t069-${suffix}@example.test`;
    const opEmail = `op-t069-${suffix}@punyasitus.com`;
    const staffEmail = `staff-t069-${suffix}@punyasitus.com`;

    const activeHandle = `t069-aktif-${suffix}`;
    const lockedHandle = `t069-kunci-${suffix}`;
    const activeTenantId = makeCrockfordUlid();
    const lockedTenantId = makeCrockfordUlid();
    const activeOrgId = makeCrockfordUlid();
    const lockedOrgId = makeCrockfordUlid();
    const quoteSlug = `t069-quote-${suffix}`;
    const pricedSlug = `t069-priced-${suffix}`;

    browser = await chromium.launch({
      headless: true,
      executablePath: findChromeExecutable(),
    });

    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const editorCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const ownerPage = await ownerCtx.newPage();
    const editorPage = await editorCtx.newPage();
    const opPage = await opCtx.newPage();
    const staffPage = await staffCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [ownerPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      p.on("pageerror", (err) => pageErrors.push(err.message));
    }

    const ownerUserId = await signUpInBrowser(ownerPage, baseUrl, ownerEmail, password, "Pemilik T069");
    const editorUserId = await signUpInBrowser(editorPage, baseUrl, editorEmail, password, "Editor T069");
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Operator T069");
    const staffUserId = await signUpInBrowser(staffPage, baseUrl, staffEmail, password, "Budi Tim Setup");

    // Seed active + locked tenants, platform settings, clean existing setup packages for empty-state proof
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE custom_theme_packages SET active = 0 WHERE service_kind = 'setup'").run();

      db.prepare("UPDATE users SET email_verified = 1 WHERE lower(email) IN (?, ?, ?, ?)").run(
        ownerEmail.toLowerCase(),
        editorEmail.toLowerCase(),
        opEmail.toLowerCase(),
        staffEmail.toLowerCase(),
      );

      db.prepare(
        `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
         VALUES ('platform.public_settings', ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(
        JSON.stringify({
          salesWhatsapp: "6281290006969",
          supportEmail: "halo@punyasitus.com",
          termsUrl: "https://punyasitus.com/syarat",
          privacyUrl: "https://punyasitus.com/privasi",
          supportHours: "Senin–Jumat, 09.00–17.00 WIB",
          supportResponseTarget: "Maksimal 1 hari kerja",
        }),
        opUserId,
        nowMs,
      );

      db.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(activeOrgId, "Klinik Nusantara", `org-${activeHandle}`, nowMs, nowMs);
      db.prepare(
        `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(lockedOrgId, "Toko Terkunci", `org-${lockedHandle}`, nowMs, nowMs);

      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, ?, ?)`,
      ).run(activeTenantId, activeOrgId, activeHandle, "Klinik Nusantara", nowMs + 30 * dayMs, nowMs, nowMs);

      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'locked', 0, ?, ?, ?)`,
      ).run(lockedTenantId, lockedOrgId, lockedHandle, "Toko Terkunci", nowMs - 5 * dayMs, nowMs, nowMs);

      db.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
      ).run(makeCrockfordUlid(), activeOrgId, ownerUserId, nowMs);
      db.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)`,
      ).run(makeCrockfordUlid(), activeOrgId, editorUserId, nowMs);
      db.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
      ).run(makeCrockfordUlid(), lockedOrgId, ownerUserId, nowMs);

      // Grant active platform_operators record to `staffUserId` (required for setup staff nomination)
      db.prepare(
        `INSERT OR IGNORE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
         VALUES (?, ?, 'Active setup specialist operator for TASK-069 E2E', ?, NULL)`,
      ).run(staffUserId, opUserId, nowMs);
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
        "Automated TASK-069 Chromium E2E operator bootstrap",
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
    // 1. Empty setup packages -> contact-only state + Editor 403 + Locked 302
    // =========================================================================
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/setup-service`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector('[data-testid="setup-packages-empty"]');
    const contactWaHref = await ownerPage.getAttribute('[data-testid="btn-setup-wa-contact-only"]', "href");
    assert(
      contactWaHref && contactWaHref.startsWith("https://wa.me/6281290006969?text="),
      `Expected contact-only setup WA CTA, got: ${contactWaHref}`,
    );
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-setup-empty", 1440);
    await captureScreenshot(ownerPage, "01-tenant-setup-empty-1440.png");

    // Editor cannot open setup-service (403)
    const editorResp = await editorPage.goto(
      `${baseUrl}/dashboard/${activeHandle}/setup-service`,
      { waitUntil: "domcontentloaded" },
    );
    assert(editorResp?.status() === 403, `Expected 403 for editor, got ${editorResp?.status()}`);

    // Locked tenant redirected to /service-status
    await ownerPage.goto(`${baseUrl}/dashboard/${lockedHandle}/setup-service`, {
      waitUntil: "networkidle",
    });
    assert(
      ownerPage.url().includes(`/dashboard/${lockedHandle}/service-status`),
      `Expected locked tenant redirect to /service-status, got ${ownerPage.url()}`,
    );

    // =========================================================================
    // 2. Console /console/custom-themes — Create 2 Terima Beres (`setup`) packages
    // =========================================================================
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/custom-themes`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-custom-themes-panel"]');

    await opPage.selectOption('[data-testid="select-pkg-service-kind"]', "setup");
    await opPage.fill('[data-testid="input-pkg-slug"]', pricedSlug);
    await opPage.fill('[data-testid="input-pkg-sort"]', "10");
    await opPage.fill('[data-testid="input-pkg-name"]', "Terima Beres UMKM Siap Jalan");
    await opPage.fill(
      '[data-testid="input-pkg-description"]',
      "Pengisian profil bisnis, 5 halaman inti, dan integrasi WhatsApp bisnis.",
    );
    await opPage.fill(
      '[data-testid="input-pkg-inclusions"]',
      "Setup profil bisnis & logo\nPengisian 5 halaman & layanan utama\nUji coba tombol WhatsApp & formulir",
    );
    await opPage.fill('[data-testid="input-pkg-price"]', "1250000");
    await opPage.fill('[data-testid="input-pkg-duration"]', "3–5 hari kerja");
    await opPage.fill(
      '[data-testid="input-pkg-reason"]',
      "Menambahkan paket Terima Beres UMKM Siap Jalan untuk E2E TASK-069",
    );
    await opPage.click('[data-testid="btn-create-package"]');
    await opPage.waitForSelector(`[data-testid="console-package-row-${pricedSlug}"]`);

    await opPage.selectOption('[data-testid="select-pkg-service-kind"]', "setup");
    await opPage.fill('[data-testid="input-pkg-slug"]', quoteSlug);
    await opPage.fill('[data-testid="input-pkg-sort"]', "20");
    await opPage.fill('[data-testid="input-pkg-name"]', "Terima Beres Korporat Multi-Cabang");
    await opPage.fill(
      '[data-testid="input-pkg-description"]',
      "Migrasi materi katalog lengkap dan penyiapan profil multi-cabang sesuai ruang lingkup.",
    );
    await opPage.fill(
      '[data-testid="input-pkg-inclusions"]',
      "Input katalog hingga 50 item\nPenyiapan cabang & jadwal operasional\nSesi serah terima & panduan admin",
    );
    await opPage.fill('[data-testid="input-pkg-price"]', "");
    await opPage.fill('[data-testid="input-pkg-duration"]', "7–10 hari kerja");
    await opPage.fill(
      '[data-testid="input-pkg-reason"]',
      "Menambahkan paket Terima Beres Korporat berbasis penawaran",
    );
    await opPage.click('[data-testid="btn-create-package"]');
    await opPage.waitForSelector(`[data-testid="console-package-row-${quoteSlug}"]`);

    await assertViewportLayoutAndTouchTargets(opPage, "console-setup-packages", 1440);
    await captureScreenshot(opPage, "02-console-setup-packages-1440.png");

    await opPage.setViewportSize({ width: 360, height: 800 });
    await opPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(opPage, "console-setup-packages", 360);
    await captureScreenshot(opPage, "03-console-setup-packages-360.png");

    // =========================================================================
    // 3. Tenant /dashboard/{handle}/setup-service — Select package, validate & submit TBR request
    // =========================================================================
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/setup-service`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector('[data-testid="setup-packages-grid"]');

    const pricePriced = await ownerPage.textContent(`[data-testid="setup-package-price-${pricedSlug}"]`);
    const priceQuote = await ownerPage.textContent(`[data-testid="setup-package-price-${quoteSlug}"]`);
    assert(pricePriced?.includes("Mulai dari Rp 1.250.000"), `Unexpected priced label: ${pricePriced}`);
    assert(priceQuote?.includes("Harga berdasarkan penawaran"), `Unexpected quote label: ${priceQuote}`);

    await ownerPage.focus(`[data-testid="btn-select-setup-package-${pricedSlug}"]`);
    await ownerPage.keyboard.press("Enter");

    await ownerPage.fill('[data-testid="input-setup-brand-name"]', "Klinik Nusantara Pratama");
    await ownerPage.fill(
      '[data-testid="textarea-setup-brief"]',
      "Mohon bantu isi halaman beranda, profil dokter, 5 layanan kesehatan utama, dan kontak WhatsApp.",
    );
    await ownerPage.fill('[data-testid="input-setup-reference-url-0"]', "http://tidak-aman.example.com");
    await ownerPage.click('[data-testid="btn-submit-setup-request"]');
    await ownerPage.waitForSelector('[data-testid="setup-request-form-error"]');
    const preservedBrief = await ownerPage.inputValue('[data-testid="textarea-setup-brief"]');
    assert(preservedBrief.includes("profil dokter"), "Brief must be preserved on error");

    await ownerPage.fill('[data-testid="input-setup-reference-url-0"]', "https://referensi-klinik.example.com");
    await ownerPage.fill('[data-testid="input-setup-budget-range"]', "Rp 1,5 jt");
    await ownerPage.click('[data-testid="btn-submit-setup-request"]');
    await ownerPage.waitForSelector('[data-testid="setup-request-submit-success"]');

    const afterWa = await ownerPage.getAttribute('[data-testid="btn-setup-wa-after-submit"]', "href");
    assert(afterWa && afterWa.startsWith("https://wa.me/6281290006969?text="), "Missing setup WA CTA");
    assert(!afterWa.includes("%2520"), `Double encoding detected: ${afterWa}`);
    const decodedWa = new URL(afterWa).searchParams.get("text") ?? "";
    assert(decodedWa.includes(activeHandle), "WA text missing handle");
    assert(decodedWa.includes("TBR-"), "WA text missing TBR code");

    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-setup-submitted", 1440);
    await captureScreenshot(ownerPage, "04-tenant-setup-submitted-1440.png");

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-setup-submitted", 360);
    await captureScreenshot(ownerPage, "05-tenant-setup-submitted-360.png");

    // =========================================================================
    // 4. Console transitions request to `in_progress` + nominates named staff
    // =========================================================================
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/custom-themes`, { waitUntil: "networkidle" });
    await opPage.click('[data-testid="tab-console-requests"]');
    await opPage.waitForSelector('[data-testid="console-requests-section"]');
    await opPage.selectOption('[data-testid="select-console-req-kind-filter"]', "setup");
    await opPage.fill('[data-testid="input-console-request-search"]', activeHandle);
    await opPage.waitForTimeout(150);

    const reqCardTestId = await opPage.evaluate(() => {
      const el = document.querySelector('[data-testid^="console-request-card-TBR-"]');
      return el?.getAttribute("data-testid") ?? "";
    });
    assert(reqCardTestId, "Expected submitted setup request TBR card in console");
    const reqCode = reqCardTestId.replace("console-request-card-", "");

    await opPage.click(`[data-testid="btn-open-transition-${reqCode}"]`);
    await opPage.selectOption(`[data-testid="select-next-status-${reqCode}"]`, "in_progress");
    await opPage.fill(`[data-testid="input-staff-email-${reqCode}"]`, staffEmail);
    await opPage.fill(
      `[data-testid="input-transition-reason-${reqCode}"]`,
      "Memulai pengerjaan Terima Beres dan menugaskan staf untuk persetujuan pemilik situs",
    );
    await opPage.click(`[data-testid="btn-confirm-transition-${reqCode}"]`);
    await opPage.waitForSelector('[data-testid="console-custom-themes-notice"]');

    // =========================================================================
    // 5. Fill 5/5 seats -> Owner approves -> Waiting state with explanation -> Free 1 seat -> Join!
    // =========================================================================
    const tempInvIds = [makeCrockfordUlid(), makeCrockfordUlid(), makeCrockfordUlid()];
    const dbSeats = new DatabaseSync(sqlitePath);
    try {
      // Currently 2 active members (owner + editor); add 3 unexpired pending invitations = 5/5 full!
      for (let i = 0; i < tempInvIds.length; i += 1) {
        dbSeats
          .prepare(
            `INSERT INTO invitations (id, organization_id, email, role, status, expires_at, inviter_id, created_at)
             VALUES (?, ?, ?, 'editor', 'pending', ?, ?, ?)`,
          )
          .run(tempInvIds[i], activeOrgId, `extra${i + 1}-${suffix}@example.test`, nowMs + 2 * dayMs, ownerUserId, nowMs);
      }
    } finally {
      dbSeats.close();
    }

    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/setup-service`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector(`[data-testid="btn-approve-staff-${reqCode}"]`);
    await ownerPage.click(`[data-testid="btn-approve-staff-${reqCode}"]`);
    await ownerPage.waitForSelector(`[data-testid="staff-waiting-seat-alert-${reqCode}"]`);
    const seatRatioFull = await ownerPage.textContent('[data-testid="setup-seats-ratio"]');
    assert(seatRatioFull?.includes("5/5"), `Expected 5/5 seat ratio, got ${seatRatioFull}`);

    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-setup-waiting-seat", 1440);
    await captureScreenshot(ownerPage, "06-tenant-setup-waiting-seat-1440.png");

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.waitForTimeout(150);
    await assertViewportLayoutAndTouchTargets(ownerPage, "tenant-setup-waiting-seat", 360);
    await captureScreenshot(ownerPage, "07-tenant-setup-waiting-seat-360.png");

    // Free 1 pending invitation (5/5 -> 4/5) and retry approval -> Staff joins as active Editor!
    const dbFree = new DatabaseSync(sqlitePath);
    try {
      dbFree.prepare("UPDATE invitations SET status = 'canceled' WHERE id = ?").run(tempInvIds[0]);
    } finally {
      dbFree.close();
    }

    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.click(`[data-testid="btn-approve-staff-${reqCode}"]`);
    await ownerPage.waitForSelector('[data-testid="setup-staff-action-notice"]');
    const activeBadge = await ownerPage.textContent(`[data-testid="staff-access-badge-${reqCode}"]`);
    assert(activeBadge?.includes("Tim Setup aktif"), `Expected active staff badge, got ${activeBadge}`);
    await captureScreenshot(ownerPage, "08-tenant-setup-staff-active-1440.png");

    // Verify staff row exists in `members` with role = 'setup_staff'
    const dbCheckActive = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const mRow = dbCheckActive
        .prepare("SELECT role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
        .get(activeOrgId, staffUserId);
      assert(mRow?.role === "setup_staff", `Expected setup_staff membership, got ${JSON.stringify(mRow)}`);
    } finally {
      dbCheckActive.close();
    }

    // =========================================================================
    // 6. Operator marks setup request `delivered` (WITHOUT any theme grant!) -> removes staff membership
    // =========================================================================
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/custom-themes`, { waitUntil: "networkidle" });
    await opPage.click('[data-testid="tab-console-requests"]');
    await opPage.selectOption('[data-testid="select-console-req-kind-filter"]', "setup");
    await opPage.fill('[data-testid="input-console-request-search"]', activeHandle);
    await opPage.waitForTimeout(150);

    await opPage.click(`[data-testid="btn-open-transition-${reqCode}"]`);
    await opPage.selectOption(`[data-testid="select-next-status-${reqCode}"]`, "delivered");
    await opPage.fill(
      `[data-testid="input-transition-reason-${reqCode}"]`,
      "Setup website Klinik Nusantara selesai diserahkan tanpa izin tema dan akses staf dicabut",
    );
    await opPage.click(`[data-testid="btn-confirm-transition-${reqCode}"]`);
    await opPage.waitForSelector('[data-testid="console-custom-themes-notice"]');
    await assertViewportLayoutAndTouchTargets(opPage, "console-setup-delivered", 1440);
    await captureScreenshot(opPage, "09-console-setup-delivered-1440.png");

    // Verify staff row was removed from `members`!
    const dbCheckRemoved = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const mRow = dbCheckRemoved
        .prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
        .get(activeOrgId, staffUserId);
      assert(!mRow, `Expected setup_staff member row removed on delivered, still found: ${JSON.stringify(mRow)}`);
    } finally {
      dbCheckRemoved.close();
    }

    // Tenant sees delivered banner & revoked staff access
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(`${baseUrl}/dashboard/${activeHandle}/setup-service`, {
      waitUntil: "networkidle",
    });
    await ownerPage.waitForSelector(`[data-testid="setup-request-delivered-banner-${reqCode}"]`);
    const revokedBadge = await ownerPage.textContent(`[data-testid="staff-access-badge-${reqCode}"]`);
    assert(revokedBadge?.includes("dicabut"), `Expected revoked staff badge, got ${revokedBadge}`);
    await captureScreenshot(ownerPage, "10-tenant-setup-delivered-1440.png");

    assert(consoleErrors.length === 0, `Unexpected browser console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${pageErrors.join(" | ")}`);

    console.log("TASK-069 E2E PASSED");
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
