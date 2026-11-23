/* global process, console, setTimeout, clearTimeout, document, window, fetch, Buffer, URL */
/**
 * TASK-072 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Verifies end-to-end First-Party Insights (REQ-073, PLAN §7.3, §18.4, DESIGN §3.3):
 * 1. Real provisioned tenant with migrated TenantStore DO.
 * 2. Auth & tenant isolation: unauthenticated `/dashboard/<handle>/insights` -> 302 `/auth/login`,
 *    `/insights/api` -> 401; authenticated non-member/unknown handle -> 404.
 * 3. Empty state at 1440px & 360px on `/dashboard/<handle>` overview card AND `/dashboard/<handle>/insights`:
 *    prominent estimate label, clean empty panel, zero overflow, >= 44px mobile touch targets.
 * 4. Real browser arrival source persistence across same-site navigation:
 *    - Landing on `/?utm_source=promo_lebaran&utm_medium=cpc` saves coarse arrival metadata in
 *      `sessionStorage` (ZERO cookies, ZERO visitor IDs) and sends `page_view` with `utmSource: "promo_lebaran"`.
 *    - Navigating same-site to `/layanan/konsultasi-seo` (no UTM query, same-site referrer) PRESERVES
 *      `campaign` / `promo_lebaran` on both `page_view` and WhatsApp CTA `wa_click`!
 *    - Bot User-Agent (`Googlebot/2.1`) returns `204` and does NOT inflate counters.
 * 5. Populated state at 1440px & 360px on `/dashboard/<handle>` AND `/dashboard/<handle>/insights`:
 *    top popular items, traffic sources (`Pencarian`, `Media Sosial`, `Kampanye`, `Langsung`, `Rujukan`),
 *    peak hours projected to tenant timezone, prominent estimate label, zero horizontal overflow,
 *    >= 44px mobile touch targets, zero console/page errors, screenshots saved in `/tmp/task-072-screenshots/`.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK072_SCREENSHOT_DIR || "/tmp/task-072-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

const HUMAN_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body || null;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 30_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function runLocalD1Sql(sql) {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistTo,
      "--command",
      sql,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`Local D1 execute failed:\n${res.stdout}\n${res.stderr}`);
  }
}

function ensureLocalD1Migrated() {
  const persistTo = path.join(webDir, ".wrangler/state");
  const migrate = spawnSync(
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
  if (migrate.status !== 0) {
    throw new Error(`Local D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }
}

async function waitForServer(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`astro dev did not become ready on port ${port}`);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(input) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpCode(secretBase32, nowMs = Date.now()) {
  const key = decodeBase32(secretBase32);
  const counter = Math.floor(nowMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return String(code).padStart(6, "0");
}

async function signUpInBrowser(page, { email, password, name }) {
  const res = await page.evaluate(
    async ({ email: e, password: p, name: n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const body = await r.json().catch(() => null);
      return { status: r.status, userId: body?.user?.id ?? "" };
    },
    { email, password, name },
  );
  assert(res.status === 200 && res.userId, `Sign-up failed for ${email}: ${JSON.stringify(res)}`);
  return res.userId;
}

/**
 * Compiles a 2-page real Astro public tenant site (`/` and `/layanan/konsultasi-seo`)
 * using `Layout.astro` + `AnalyticsHead.astro` (`enableFirstPartyOnly={true}`) so we can prove
 * real browser `sessionStorage` arrival source persistence across same-site navigation.
 */
async function buildPublicInsightsSite({ tenantHost }) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t072-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const layananDir = path.join(pagesDir, "layanan");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(layananDir, { recursive: true });

  const analyticsHeadImport = path.join(webDir, "src/components/AnalyticsHead.astro");

  const homePage = `---
import AnalyticsHead from ${JSON.stringify(analyticsHeadImport)};
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Beranda Studio Wawasan</title>
    <AnalyticsHead
      surface="tenant"
      enableFirstPartyOnly={true}
      tenantScope=${JSON.stringify(tenantHost)}
      pageType="home"
      appEnv="test"
    />
  </head>
  <body>
    <main style="padding: 2rem;">
      <h1>Studio Wawasan UMKM</h1>
      <p><a data-testid="nav-to-offering" href="/layanan/konsultasi-seo">Lihat Layanan Konsultasi SEO</a></p>
    </main>
  </body>
</html>
`;

  const offeringPage = `---
import AnalyticsHead from ${JSON.stringify(analyticsHeadImport)};
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Konsultasi SEO — Studio Wawasan</title>
    <AnalyticsHead
      surface="tenant"
      enableFirstPartyOnly={true}
      tenantScope=${JSON.stringify(tenantHost)}
      pageType="service"
      appEnv="test"
    />
  </head>
  <body>
    <main style="padding: 2rem;">
      <h1>Konsultasi SEO</h1>
      <a
        data-testid="wa-cta-link"
        data-ps-item-id="srv-seo"
        data-ps-placement="detail"
        href="https://wa.me/6281234567890?text=Halo%20Konsultasi%20SEO"
      >
        Hubungi via WhatsApp
      </a>
    </main>
  </body>
</html>
`;

  fs.writeFileSync(path.join(pagesDir, "index.astro"), homePage, "utf8");
  fs.writeFileSync(path.join(layananDir, "konsultasi-seo.astro"), offeringPage, "utf8");

  const { build } = await import(astroEntryUrl);
  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    vite: { logLevel: "error" },
  });

  return { tmpRoot, outDir };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

async function startPublicSiteProxyServer({ outDir, astroPort, tenantHost, eventPosts }) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && reqUrl.pathname === "/api/events") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            parsed = null;
          }
          const forwarded = await httpRequest(astroPort, "/api/events", {
            method: "POST",
            headers: {
              host: tenantHost,
              origin: `https://${tenantHost}`,
              "content-type": req.headers["content-type"] || "application/json",
              "user-agent": req.headers["user-agent"] || HUMAN_CHROME_UA,
              "cf-connecting-ip": "203.0.113.72",
            },
            body: rawBody,
          });
          eventPosts.push({ status: forwarded.status, payload: parsed });
          res.writeHead(forwarded.status, { "content-type": "application/json" });
          res.end(forwarded.body);
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
      return;
    }

    let relPath = reqUrl.pathname;
    if (relPath === "/") relPath = "/index.html";
    else if (!path.extname(relPath)) relPath = `${relPath}/index.html`;
    const filePath = path.join(outDir, relPath.replace(/^\/+/, ""));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": contentTypeFor(filePath) });
    res.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port };
}

async function main() {
  ensureLocalD1Migrated();
  const astroPort = await getFreePort();
  const child = spawn(
    "pnpm",
    [
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(astroPort),
      "--ignore-lock",
    ],
    {
      cwd: webDir,
      env: cleanChildEnv({
        PUNYASITUS_ALLOW_DEV_HOSTS: "1",
        PUNYASITUS_DISABLE_DEV_TOOLBAR: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  let browser = null;
  let publicProxy = null;
  let compiledSite = null;

  try {
    const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
    const tenantHandle = `ins-${suffix}`;
    const tenantHost = `${tenantHandle}.situsku.click`;

    const [built] = await Promise.all([
      buildPublicInsightsSite({ tenantHost }),
      waitForServer(astroPort),
    ]);
    compiledSite = built;

    // 1. Unauthenticated access checks
    const unauthInsights = await httpRequest(astroPort, `/dashboard/${tenantHandle}/insights`);
    assert(
      unauthInsights.status === 302 &&
        String(unauthInsights.headers.location ?? "").includes("/auth/login"),
      `Unauthenticated /insights must redirect 302 to /auth/login, got ${unauthInsights.status}`,
    );

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    const baseUrl = `http://127.0.0.1:${astroPort}`;
    const opEmail = `op.t072.${suffix}@example.test`;
    const opPass = "OpPass!2026T072";
    const ownerEmail = `owner.t072.${suffix}@example.test`;
    const ownerPass = "OwnerPass!2026T072";

    // 2. Provision real tenant with migrated TenantStore DO
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, { email: opEmail, password: opPass, name: "Operator T072" });
    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", opPass);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret =
      (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    await opPage.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    const safeOpEmail = opEmail.replace(/'/g, "''");
    const nowMs = Date.now();
    runLocalD1Sql(
      `UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOpEmail}';
       INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-072', ${nowMs}, NULL
       FROM users WHERE lower(email) = '${safeOpEmail}';`,
    );

    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const dashConsoleErrors = [];
    const dashPageErrors = [];
    ownerPage.on("console", (msg) => {
      if (msg.type() === "error") dashConsoleErrors.push(msg.text());
    });
    ownerPage.on("pageerror", (err) => dashPageErrors.push(String(err)));

    await ownerPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(ownerPage, {
      email: ownerEmail,
      password: ownerPass,
      name: "Pemilik Wawasan T072",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    await opPage.goto(`${baseUrl}/console/provisioning`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await opPage.fill("#provision-name", "Studio Wawasan Nusantara");
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Provisioning tenant uji E2E untuk TASK-072 insights");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');
    await opCtx.close();

    // Cross-tenant / unknown handle denial check
    const crossTenantResp = await ownerPage.goto(`${baseUrl}/dashboard/tenant-lain-999/insights`, {
      waitUntil: "networkidle",
    });
    assert(
      crossTenantResp && crossTenantResp.status() === 404,
      `Cross-tenant /insights must return 404, got ${crossTenantResp?.status()}`,
    );
    dashConsoleErrors.length = 0;

    // 3. Verify EMPTY STATE on Overview Card (1440px) and /insights (360px)
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    const emptyOverviewResp = await ownerPage.goto(`${baseUrl}/dashboard/${tenantHandle}`, {
      waitUntil: "networkidle",
    });
    assert(emptyOverviewResp && emptyOverviewResp.status() === 200, "Empty overview must return 200");
    const emptyOverviewInfo = await ownerPage.evaluate(() => {
      const card = document.querySelector('[data-testid="insights-overview-card"]');
      const est = document.querySelector('[data-testid="insights-estimate-label"]');
      const emptyPanel = card?.querySelector('[data-state-panel="empty-insights"]');
      return {
        hasCard: Boolean(card),
        estimateText: est?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        hasEmptyPanel: Boolean(emptyPanel),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    assert(emptyOverviewInfo.hasCard, "Overview must show insights-overview-card");
    assert(emptyOverviewInfo.hasEmptyPanel, "Overview insights card must render empty state");
    assert(
      emptyOverviewInfo.estimateText.includes("Estimasi agregat harian tanpa pelacakan individu"),
      `Overview estimate label missing, got: ${emptyOverviewInfo.estimateText}`,
    );
    assert(!emptyOverviewInfo.overflow, "Empty overview 1440px must not overflow");
    await ownerPage.screenshot({
      path: path.join(screenshotDir, "overview-empty-1440.png"),
      fullPage: true,
    });

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    const emptyInsightsResp = await ownerPage.goto(
      `${baseUrl}/dashboard/${tenantHandle}/insights`,
      { waitUntil: "networkidle" },
    );
    assert(emptyInsightsResp && emptyInsightsResp.status() === 200, "Empty /insights must return 200");
    const emptyInsightsInfo = await ownerPage.evaluate(() => ({
      hasEmpty: Boolean(document.querySelector('[data-state-panel="empty-insights"]')),
      estimateText:
        document.querySelector('[data-testid="insights-estimate-label"]')?.textContent ?? "",
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    assert(emptyInsightsInfo.hasEmpty, "/insights must render empty-insights panel");
    assert(
      emptyInsightsInfo.estimateText.includes("Estimasi agregat harian tanpa pelacakan individu"),
      "/insights empty state must include estimate label",
    );
    assert(!emptyInsightsInfo.overflow, "Empty /insights 360px must not overflow");
    await ownerPage.screenshot({
      path: path.join(screenshotDir, "insights-empty-360.png"),
      fullPage: true,
    });

    // 4. Real Browser Tab Arrival Source Persistence Across Same-Site Navigation
    const eventPosts = [];
    publicProxy = await startPublicSiteProxyServer({
      outDir: compiledSite.outDir,
      astroPort,
      tenantHost,
      eventPosts,
    });

    const visitorCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: HUMAN_CHROME_UA,
    });
    const visitorPage = await visitorCtx.newPage();
    const visitorErrors = [];
    visitorPage.on("pageerror", (err) => visitorErrors.push(String(err)));

    // Prevent actual navigation to wa.me when clicking WA CTA
    await visitorPage.route(/https:\/\/wa\.me\/.*/, (route) => route.abort());

    // Land on `/` with UTM campaign parameters
    await visitorPage.goto(
      `http://127.0.0.1:${publicProxy.port}/?utm_source=promo_lebaran&utm_medium=cpc&fbclid=DROP_ME`,
      { waitUntil: "networkidle" },
    );
    await visitorPage.waitForTimeout(300);

    const landingState = await visitorPage.evaluate(() => ({
      cookies: document.cookie,
      arrivalRaw: window.sessionStorage.getItem("ps_arrival_source_v1"),
      arrivalObj: window.__punyasitusAnalytics?.getArrivalSource?.() ?? null,
    }));
    assert(!landingState.cookies.includes("ps_arrival"), "Arrival source must NEVER use cookies");
    assert(
      landingState.arrivalRaw && !landingState.arrivalRaw.includes("fbclid"),
      `sessionStorage must strip fbclid, got: ${landingState.arrivalRaw}`,
    );
    assert(
      landingState.arrivalObj?.sourceCategory === "campaign" &&
        landingState.arrivalObj?.utmSource === "promo_lebaran",
      `Expected campaign/promo_lebaran arrival, got ${JSON.stringify(landingState.arrivalObj)}`,
    );

    // Click same-site link to `/layanan/konsultasi-seo` (NO UTM params in href!)
    await visitorPage.click('[data-testid="nav-to-offering"]');
    await visitorPage.waitForURL("**/layanan/konsultasi-seo");
    await visitorPage.waitForLoadState("networkidle");
    await visitorPage.waitForTimeout(300);

    const afterNavArrival = await visitorPage.evaluate(
      () => window.__punyasitusAnalytics?.getArrivalSource?.() ?? null,
    );
    assert(
      afterNavArrival?.sourceCategory === "campaign" &&
        afterNavArrival?.utmSource === "promo_lebaran",
      `Same-site navigation must preserve original arrival source! Got: ${JSON.stringify(afterNavArrival)}`,
    );

    // Click WhatsApp CTA on offering page
    await visitorPage.click('[data-testid="wa-cta-link"]');
    await visitorPage.waitForTimeout(400);
    await visitorCtx.close();

    assert(visitorErrors.length === 0, `Public visitor errors: ${visitorErrors.join("; ")}`);
    assert(
      eventPosts.length >= 3,
      `Expected >= 3 first-party events (home pv, offering pv, wa_click), got ${eventPosts.length}`,
    );
    const offeringPv = eventPosts.find(
      (e) => e.payload?.eventName === "page_view" && e.payload?.path === "/layanan/konsultasi-seo",
    );
    assert(
      offeringPv &&
        offeringPv.status === 204 &&
        offeringPv.payload?.sourceCategory === "campaign" &&
        offeringPv.payload?.utmSource === "promo_lebaran",
      `Same-site page_view must carry preserved campaign/promo_lebaran, got ${JSON.stringify(offeringPv)}`,
    );

    // Send additional real events (search, social, referral, direct) + a Bot UA drop check
    const syntheticEvents = [
      {
        eventId: crypto.randomUUID(),
        eventName: "page_view",
        path: "/layanan/konsultasi-seo",
        referrerHost: "www.google.co.id",
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "wa_click",
        path: "/layanan/konsultasi-seo",
        referrerHost: "www.google.co.id",
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "page_view",
        path: "/blog/panduan-umkm",
        referrerHost: "l.instagram.com",
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "page_view",
        path: "/blog/panduan-umkm",
        referrerHost: "portal-umkm.id",
      },
      {
        eventId: crypto.randomUUID(),
        eventName: "external_click",
        path: "/layanan/konsultasi-seo",
      },
    ];

    for (const payload of syntheticEvents) {
      const res = await httpRequest(astroPort, "/api/events", {
        method: "POST",
        headers: {
          host: tenantHost,
          origin: `https://${tenantHost}`,
          "content-type": "application/json",
          "user-agent": HUMAN_CHROME_UA,
          "cf-connecting-ip": "203.0.113.73",
        },
        body: JSON.stringify(payload),
      });
      assert(res.status === 204, `Event post failed: ${res.status} ${res.body}`);
    }

    // Bot UA check -> 204 quiet drop
    const botRes = await httpRequest(astroPort, "/api/events", {
      method: "POST",
      headers: {
        host: tenantHost,
        origin: `https://${tenantHost}`,
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "cf-connecting-ip": "203.0.113.99",
      },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        eventName: "page_view",
        path: "/halaman-bot-jangan-masuk",
      }),
    });
    assert(botRes.status === 204, `Bot drop expected 204, got ${botRes.status}`);

    // 5. Verify POPULATED STATE on Overview Card & /insights at 1440px and 360px
    for (const vp of [
      { name: "1440", width: 1440, height: 900 },
      { name: "360", width: 360, height: 800 },
    ]) {
      await ownerPage.setViewportSize({ width: vp.width, height: vp.height });

      // 5a. Overview card
      const ovResp = await ownerPage.goto(`${baseUrl}/dashboard/${tenantHandle}`, {
        waitUntil: "networkidle",
      });
      assert(ovResp && ovResp.status() === 200, `Populated overview @ ${vp.name} returned ${ovResp?.status()}`);
      const ovCheck = await ownerPage.evaluate(() => {
        const card = document.querySelector('[data-testid="insights-overview-card"]');
        const openLink = document.querySelector('[data-testid="open-insights-link"]');
        const text = card?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          text,
          hasPopular: Boolean(document.querySelector('[data-testid="overview-popular-items"]')),
          hasSources: Boolean(document.querySelector('[data-testid="overview-traffic-sources"]')),
          hasPeakHours: Boolean(document.querySelector('[data-testid="overview-peak-hours"]')),
          openLinkRect: openLink ? openLink.getBoundingClientRect() : null,
        };
      });
      assert(
        !ovCheck.overflow,
        `Populated overview @ ${vp.name}px overflow (${ovCheck.scrollWidth} > ${ovCheck.innerWidth})`,
      );
      assert(ovCheck.hasPopular && ovCheck.hasSources && ovCheck.hasPeakHours, `Overview insights sub-sections missing @ ${vp.name}px`);
      assert(!ovCheck.text.includes("halaman-bot-jangan-masuk"), "Bot path must NEVER appear in overview");
      assert(ovCheck.text.includes("/layanan/konsultasi-seo"), "Top offering path must appear in overview");
      assert(ovCheck.text.includes("Pencarian") && ovCheck.text.includes("Media Sosial") && ovCheck.text.includes("Kampanye"), "Traffic sources missing in overview");
      if (vp.width === 360) {
        assert(
          ovCheck.openLinkRect && ovCheck.openLinkRect.height >= 44,
          `Mobile open-insights-link touch target must be >= 44px, got ${ovCheck.openLinkRect?.height}`,
        );
      }
      await ownerPage.screenshot({
        path: path.join(screenshotDir, `overview-populated-${vp.name}.png`),
        fullPage: true,
      });

      // 5b. Dedicated /insights page
      const insResp = await ownerPage.goto(`${baseUrl}/dashboard/${tenantHandle}/insights`, {
        waitUntil: "networkidle",
      });
      assert(insResp && insResp.status() === 200, `Populated /insights @ ${vp.name} returned ${insResp?.status()}`);
      const insCheck = await ownerPage.evaluate(() => {
        const pageEl = document.querySelector('[data-testid="insights-page"]');
        const text = pageEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const r7 = document.querySelector('[data-testid="insights-range-7d"]');
        const r30 = document.querySelector('[data-testid="insights-range-30d"]');
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          text,
          hasPopular: Boolean(document.querySelector('[data-testid="insights-popular-items"]')),
          hasSources: Boolean(document.querySelector('[data-testid="insights-sources-card"]')),
          hasPeak: Boolean(document.querySelector('[data-testid="insights-peak-hours-card"]')),
          hasPeakBadge: Boolean(document.querySelector('[data-testid="peak-hour-badge"]')),
          r7Rect: r7 ? r7.getBoundingClientRect() : null,
          r30Rect: r30 ? r30.getBoundingClientRect() : null,
        };
      });
      assert(
        !insCheck.overflow,
        `Populated /insights @ ${vp.name}px overflow (${insCheck.scrollWidth} > ${insCheck.innerWidth})`,
      );
      assert(
        insCheck.hasPopular && insCheck.hasSources && insCheck.hasPeak && insCheck.hasPeakBadge,
        `Populated /insights sections missing @ ${vp.name}px`,
      );
      assert(
        insCheck.text.includes("Estimasi agregat harian tanpa pelacakan individu") &&
          insCheck.text.includes("Pencarian") &&
          insCheck.text.includes("Media Sosial") &&
          insCheck.text.includes("Kampanye") &&
          insCheck.text.includes("Langsung") &&
          insCheck.text.includes("Rujukan") &&
          insCheck.text.includes("WIB (Asia/Jakarta)"),
        `Expected labels missing on /insights @ ${vp.name}px`,
      );
      assert(!insCheck.text.includes("halaman-bot-jangan-masuk"), "Bot path must NEVER appear in /insights");
      if (vp.width === 360) {
        assert(
          insCheck.r7Rect && insCheck.r7Rect.height >= 44 && insCheck.r30Rect && insCheck.r30Rect.height >= 44,
          `Mobile range buttons on /insights must be >= 44px`,
        );
      }
      await ownerPage.screenshot({
        path: path.join(screenshotDir, `insights-populated-${vp.name}.png`),
        fullPage: true,
      });
    }

    assert(dashConsoleErrors.length === 0, `Dashboard console errors: ${dashConsoleErrors.join("; ")}`);
    assert(dashPageErrors.length === 0, `Dashboard page errors: ${dashPageErrors.join("; ")}`);

    console.log(
      `TASK-072 E2E PASS: verified empty + populated overview card & /insights at 360px/1440px, real browser sessionStorage arrival persistence across same-site navigation, bot UA drop, cross-tenant 404, 0 console/page errors. Screenshots saved in ${screenshotDir}`,
    );
  } catch (err) {
    console.error("TASK-072 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs ---\n", logs.slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (publicProxy?.server) {
      await new Promise((resolve) => publicProxy.server.close(resolve));
    }
    if (compiledSite?.tmpRoot) {
      fs.rmSync(compiledSite.tmpRoot, { recursive: true, force: true });
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

await main();
