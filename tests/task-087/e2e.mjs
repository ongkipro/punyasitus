/* global process, console, Buffer, setTimeout, document, window, getComputedStyle, fetch, URL, HTMLElement */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const SCREENSHOT_DIR = process.env.TASK087_SCREENSHOT_DIR || "";
const MAX_MARKETING_JS_GZIP_BYTES = 25 * 1024;
const DEMO_SLUGS = ["compro", "sales", "travel", "catalog", "resto", "dealer"];
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_settings' LIMIT 1")
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

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        timeout: 6000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/marketing");
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

async function assertViewportLayoutAndTapTargets(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const interactive = Array.from(
      document.querySelectorAll("header a[href], header summary, main a[href], main button, main summary"),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          !el.classList.contains("mk-skip-link")
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const isInlineTextLink =
          el.tagName === "A" &&
          !el.classList.contains("mk-btn") &&
          !el.classList.contains("mk-nav-link") &&
          !el.classList.contains("mk-brand") &&
          !el.classList.contains("mk-demo-btn-light") &&
          !el.classList.contains("mk-demo-btn-dark") &&
          el.closest("p, li, aside, td") !== null;
        return {
          tag: el.tagName,
          id: el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 28) || "",
          height: Math.round(rect.height),
          isInlineTextLink,
        };
      });
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      interactive,
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
    for (const ctrl of metrics.interactive) {
      if (ctrl.isInlineTextLink) continue;
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile tap target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
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

    // Verify `0008_marketing_funnel.sql` was applied by Wrangler D1 migrations (zero runtime DDL)
    // and ensure clean baseline pricing in local D1 before starting assertions
    const sqlitePath = findPlatformSqlitePath(persistDir);
    const seedDb = new DatabaseSync(sqlitePath);
    try {
      const funnelTable = seedDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marketing_funnel_daily' LIMIT 1")
        .get();
      assert(
        funnelTable && funnelTable.name === "marketing_funnel_daily",
        "Expected 0008_marketing_funnel.sql to create marketing_funnel_daily via wrangler d1 migrations apply",
      );
      seedDb
        .prepare(
          "DELETE FROM platform_settings WHERE key IN ('platform.public_settings', 'billing.pricing', 'billing.monthly_price_idr', 'billing.yearly_price_idr')",
        )
        .run();
    } finally {
      seedDb.close();
    }

    // -------------------------------------------------------------------------
    // 1. Direct HTTP checks: demo mutations 403 DEMO_READ_ONLY, www -> 308 apex
    // -------------------------------------------------------------------------
    const wwwRes = await httpRequest(port, "/marketing/harga?plan=yearly", {
      headers: { Host: "www.punyasitus.com" },
    });
    assert(
      wwwRes.status === 308 && wwwRes.headers.location === "https://punyasitus.com/marketing/harga?plan=yearly",
      `Expected 308 apex redirect for www.punyasitus.com, got status=${wwwRes.status} location=${wwwRes.headers.location}`,
    );
    assert(!wwwRes.headers["set-cookie"], "www redirect must not set cookies");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const mutRes = await httpRequest(port, "/marketing/demo/compro", { method });
      assert(
        mutRes.status === 403,
        `Expected 403 DEMO_READ_ONLY for ${method} /marketing/demo/compro, got ${mutRes.status}`,
      );
      assert(
        mutRes.headers["x-robots-tag"] === "noindex, nofollow",
        `Expected X-Robots-Tag noindex, nofollow on demo ${method}`,
      );
      const parsed = JSON.parse(mutRes.body);
      assert(parsed.code === "DEMO_READ_ONLY", `Expected code DEMO_READ_ONLY, got ${parsed.code}`);
    }

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // -------------------------------------------------------------------------
    // 2. Marketing surface checks: zero cookies, zero 3p trackers, <=25KiB JS,
    //    live pricing zero-deploy update, 6 demos, 4 legal pages, 360 & 1440px
    // -------------------------------------------------------------------------
    const mkCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await mkCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const thirdPartyRequests = [];
    const loadedMarketingScripts = new Map();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      const host = new URL(url).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") {
        thirdPartyRequests.push(url);
      }
    });
    page.on("response", async (res) => {
      try {
        const url = res.url();
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        // Exclude Vite dev HMR client (`@vite/client`) from production marketing JS budget check
        if (
          (ct.includes("javascript") || url.endsWith(".js")) &&
          !url.includes("@vite/client") &&
          !url.includes("/@fs/") &&
          !url.includes("astro/dist/runtime")
        ) {
          const buf = await res.body();
          loadedMarketingScripts.set(url, zlib.gzipSync(buf).byteLength);
        }
      } catch {
        // ignore body read issues on redirects/aborts
      }
    });

    // 2a. Marketing Home @ 1440px & 360px
    const homeFunnelPromise = page.waitForResponse(
      (res) => res.url().includes("/marketing/api/funnel") && res.request().method() === "POST",
      { timeout: 10_000 },
    );
    const homeResp = await page.goto(`${baseUrl}/marketing`, { waitUntil: "load" });
    assert(homeResp && homeResp.status() === 200, `Expected 200 on /marketing`);
    const homeFunnelRes = await homeFunnelPromise;
    assert(homeFunnelRes.status() === 202, `Expected 202 from /marketing/api/funnel, got ${homeFunnelRes.status()}`);
    assert(!homeFunnelRes.headers()["set-cookie"], "Funnel API response must not include Set-Cookie");
    await page.waitForSelector('[data-testid="marketing-hero"]');
    const defaultMonthly = (await page.textContent('[data-testid="pricing-monthly-amount"]'))?.trim();
    assert(defaultMonthly === "Rp 179.000", `Expected default monthly Rp 179.000, got ${defaultMonthly}`);
    await assertViewportLayoutAndTapTargets(page, "marketing-home", 1440);
    await maybeCaptureScreenshot(page, "marketing-home-1440.png");

    // Keyboard reachability check
    await page.keyboard.press("Tab");
    const firstFocusedTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
    assert(firstFocusedTag === "A", `Expected keyboard focus on link, got ${firstFocusedTag}`);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTapTargets(page, "marketing-home", 360);
    await maybeCaptureScreenshot(page, "marketing-home-360.png");

    // 2b. Live Pricing zero-deploy update proof!
    const priceDb = new DatabaseSync(sqlitePath);
    try {
      priceDb
        .prepare(
          `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
           VALUES ('billing.pricing', ?, 1, NULL, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify({ monthlyPriceIdr: 215_000, yearlyPriceIdr: 2_150_000 }), Date.now());
    } finally {
      priceDb.close();
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    const pricingFunnelPromise = page.waitForResponse(
      (res) => res.url().includes("/marketing/api/funnel") && res.request().method() === "POST",
      { timeout: 10_000 },
    );
    const pricingResp = await page.goto(`${baseUrl}/marketing/harga`, { waitUntil: "load" });
    assert(pricingResp && pricingResp.status() === 200, "Expected 200 on /marketing/harga");
    await pricingFunnelPromise;
    const liveMonthly = (await page.textContent('[data-testid="pricing-monthly-amount"]'))?.trim();
    const liveYearly = (await page.textContent('[data-testid="pricing-yearly-amount"]'))?.trim();
    const liveSavings = (await page.textContent('[data-testid="pricing-yearly-savings"]'))?.trim();
    assert(liveMonthly === "Rp 215.000", `Expected live updated monthly Rp 215.000, got ${liveMonthly}`);
    assert(liveYearly === "Rp 2.150.000", `Expected live updated yearly Rp 2.150.000, got ${liveYearly}`);
    assert(liveSavings && liveSavings.includes("Rp 430.000"), `Expected yearly savings Rp 430.000, got ${liveSavings}`);
    await assertViewportLayoutAndTapTargets(page, "marketing-pricing", 1440);
    await maybeCaptureScreenshot(page, "marketing-pricing-1440.png");

    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTapTargets(page, "marketing-pricing", 360);

    // 2c. Demo gallery & all 6 synthetic demos (`noindex, nofollow` + banner)
    await page.setViewportSize({ width: 1440, height: 900 });
    const demoGalleryResp = await page.goto(`${baseUrl}/marketing/demo`, { waitUntil: "load" });
    assert(demoGalleryResp && demoGalleryResp.status() === 200, "Expected 200 on /marketing/demo");
    await assertViewportLayoutAndTapTargets(page, "marketing-demo-gallery", 1440);

    for (const slug of DEMO_SLUGS) {
      const demoFunnelPromise = page.waitForResponse(
        (res) => res.url().includes("/marketing/api/funnel") && res.request().method() === "POST",
        { timeout: 10_000 },
      );
      const resp = await page.goto(`${baseUrl}/marketing/demo/${slug}`, { waitUntil: "load" });
      assert(resp && resp.status() === 200, `Expected 200 on /marketing/demo/${slug}`);
      const demoFunnelRes = await demoFunnelPromise;
      assert(demoFunnelRes.status() === 202, `Expected 202 funnel on demo ${slug}`);
      assert(
        resp.headers()["x-robots-tag"] === "noindex, nofollow",
        `Expected X-Robots-Tag: noindex, nofollow on /marketing/demo/${slug}`,
      );
      const robotsMeta = await page.getAttribute('meta[name="robots"]', "content");
      assert(
        robotsMeta === "noindex, nofollow",
        `Expected meta robots noindex, nofollow on /marketing/demo/${slug}, got ${robotsMeta}`,
      );
      const bannerText = await page.textContent('[data-testid="demo-readonly-banner"]');
      assert(
        bannerText && bannerText.includes("Situs Demo PunyaSitus — Contoh Tampilan"),
        `Missing read-only demo banner on ${slug}`,
      );
      if (slug === "compro") {
        await assertViewportLayoutAndTapTargets(page, "marketing-demo-compro", 1440);
        await maybeCaptureScreenshot(page, "marketing-demo-compro-1440.png");
        await page.setViewportSize({ width: 360, height: 800 });
        await assertViewportLayoutAndTapTargets(page, "marketing-demo-compro", 360);
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      if (slug === "dealer") {
        const creditTable = await page.locator('[data-testid="demo-dealer-credit-table"]').count();
        assert(creditTable === 1, "Expected static credit table on dealer demo");
      }
    }

    // 2d. All 4 legal pages
    for (const legalPath of [
      "/marketing/syarat-ketentuan",
      "/marketing/privasi",
      "/marketing/penggunaan-wajar",
      "/marketing/pengembalian-dana",
    ]) {
      const resp = await page.goto(`${baseUrl}${legalPath}`, { waitUntil: "load" });
      assert(resp && resp.status() === 200, `Expected 200 on ${legalPath}`);
      await assertViewportLayoutAndTapTargets(page, `legal-${legalPath}`, 1440);
    }

    // 2e. Verify ZERO cookies set on marketing visits, ZERO 3p requests, and <= 25 KiB gzipped JS
    const marketingCookies = await mkCtx.cookies();
    assert(
      marketingCookies.length === 0,
      `Expected ZERO cookies on marketing surface, found: ${JSON.stringify(marketingCookies)}`,
    );
    assert(
      thirdPartyRequests.length === 0,
      `Expected ZERO third-party requests on marketing surface, found: ${thirdPartyRequests.join(", ")}`,
    );
    const totalMarketingJsGzipBytes = Array.from(loadedMarketingScripts.values()).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    assert(
      totalMarketingJsGzipBytes <= MAX_MARKETING_JS_GZIP_BYTES,
      `Marketing gzipped JS ${totalMarketingJsGzipBytes} bytes exceeds 25 KiB budget`,
    );
    assert(consoleErrors.length === 0, `Marketing console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Marketing page errors: ${pageErrors.join(" | ")}`);

    await mkCtx.close();

    // -------------------------------------------------------------------------
    // 3. Console Funnel Analytics (`/console/funnel`) with real 2FA operator
    // -------------------------------------------------------------------------
    // Record an extra signup_start & first_payment event via cookieless API to verify full funnel display
    for (const payload of [
      { stage: "signup_start", sourceChannel: "google", themeSlug: "compro" },
      { stage: "email_verified", sourceChannel: "google", themeSlug: "compro" },
      { stage: "trial_created", sourceChannel: "google", themeSlug: "compro" },
      { stage: "first_payment", sourceChannel: "google", themeSlug: "compro" },
    ]) {
      const fRes = await httpRequest(port, "/marketing/api/funnel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
        },
        body: JSON.stringify(payload),
      });
      assert(fRes.status === 202, `Expected 202 on funnel POST ${payload.stage}, got ${fRes.status}`);
      assert(!fRes.headers["set-cookie"], "Funnel API must never set cookies");
    }

    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    const opConsoleErrors = [];
    const opPageErrors = [];
    opPage.on("console", (msg) => {
      if (msg.type() === "error") opConsoleErrors.push(msg.text());
    });
    opPage.on("pageerror", (err) => opPageErrors.push(String(err)));

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const opEmail = `t087-op-${uniqueSuffix}@example.com`;
    const password = "ConsoleOpPassword!234";

    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "load" });
    const opSignUp = await opPage.evaluate(
      async ({ email, pwd }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password: pwd, name: "Operator Funnel" }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: opEmail, pwd: password },
    );
    assert(opSignUp.ok, `Operator sign-up failed (${opSignUp.status})`);

    const authDb = new DatabaseSync(sqlitePath);
    try {
      authDb
        .prepare("UPDATE users SET email_verified = 1 WHERE lower(email) = ?")
        .run(opEmail.toLowerCase());
    } finally {
      authDb.close();
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
        "Automated TASK-087 Chromium E2E operator bootstrap for console funnel",
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

    // Enroll 2FA via UI
    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "load" });
    await opPage.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await opPage.fill("#twofa-enroll-password", password);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    const totpCode = generateTotpCode(manualSecret);
    await opPage.fill("#twofa-confirm-code", totpCode);
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    // Open /console/funnel @ 1440px & 360px
    const funnelResp = await opPage.goto(`${baseUrl}/console/funnel`, { waitUntil: "load" });
    assert(funnelResp && funnelResp.status() === 200, `Expected 200 on /console/funnel, got ${funnelResp?.status()}`);
    assert(
      funnelResp.headers()["cache-control"] === "private, no-store",
      "Expected Cache-Control: private, no-store on /console/funnel",
    );
    assert(
      funnelResp.headers()["x-robots-tag"] === "noindex, nofollow",
      "Expected X-Robots-Tag: noindex, nofollow on /console/funnel",
    );
    await opPage.waitForSelector('[data-testid="console-funnel-page"]');

    const ctxBanner = await opPage.textContent('[data-testid="console-context-banner"]');
    assert(
      ctxBanner && ctxBanner.includes("bukan penyamaran akun tenant"),
      `Missing privileged non-impersonation banner on /console/funnel: ${ctxBanner}`,
    );

    const visitCount = Number((await opPage.textContent('[data-testid="funnel-stage-count-visit"]'))?.trim() || "0");
    const demoCount = Number((await opPage.textContent('[data-testid="funnel-stage-count-demo_view"]'))?.trim() || "0");
    const paidCount = Number((await opPage.textContent('[data-testid="funnel-stage-count-first_payment"]'))?.trim() || "0");
    assert(visitCount >= 2, `Expected visit count >= 2 in /console/funnel, got ${visitCount}`);
    assert(demoCount >= 6, `Expected demo_view count >= 6 in /console/funnel, got ${demoCount}`);
    assert(paidCount >= 1, `Expected first_payment count >= 1 in /console/funnel, got ${paidCount}`);

    await assertViewportLayoutAndTapTargets(opPage, "console-funnel", 1440);
    await maybeCaptureScreenshot(opPage, "console-funnel-1440.png");

    // Range switch 7d -> 90d
    await opPage.click('[data-testid="funnel-range-7d"]');
    await opPage.waitForURL(/range=7/);
    await opPage.waitForSelector('[data-testid="console-funnel-page"]');

    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTapTargets(opPage, "console-funnel", 360);

    assert(opConsoleErrors.length === 0, `Console funnel errors: ${opConsoleErrors.join(" | ")}`);
    assert(opPageErrors.length === 0, `Console funnel page errors: ${opPageErrors.join(" | ")}`);

    // Restore baseline pricing row so subsequent E2E tests in shared state see defaults
    const restoreDb = new DatabaseSync(sqlitePath);
    try {
      restoreDb
        .prepare("DELETE FROM platform_settings WHERE key = 'billing.pricing'")
        .run();
    } finally {
      restoreDb.close();
    }

    await opCtx.close();

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-087",
        marketingJsGzipBytes: totalMarketingJsGzipBytes,
        maxMarketingJsGzipBytes: MAX_MARKETING_JS_GZIP_BYTES,
        marketingCookiesCount: marketingCookies.length,
        thirdPartyRequestsCount: thirdPartyRequests.length,
        consoleFunnelCounts: { visitCount, demoCount, paidCount },
        screenshotsDir: SCREENSHOT_DIR || null,
      }),
    );
  } catch (err) {
    console.error("TASK-087 E2E FAILED:", err);
    if (serverLogs) {
      console.error("--- astro dev logs ---\n", serverLogs.slice(-3000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
}

run();
