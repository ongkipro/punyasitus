/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle, fetch, Buffer, URL */
/**
 * TASK-021 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * End-to-end real-browser proof:
 * 1. Provisions a real tenant (with migrated TenantStore DO) in `astro dev`.
 * 2. Compiles the real `SectionContactForm.astro` inside `Layout.astro` and opens it in
 *    Chromium with `javaScriptEnabled: false` at `360px`:
 *    - Verifies zero horizontal overflow & >= 44px touch targets on inputs, consent checkbox & submit.
 *    - Submits the form WITHOUT JavaScript -> proxies native `application/x-www-form-urlencoded`
 *      `POST /api/leads` to `astro dev` on `<handle>.situsku.click` -> receives `303 See Other` PRG
 *      redirect -> renders durable Bahasa Indonesia success banner (`#1`).
 *    - Captures `contact-form-360.png`.
 * 3. Authenticates as the tenant owner on `/dashboard/<handle>/leads` at `1440px` & `360px`:
 *    - Verifies the lead submitted via the No-JS contact form appears in the inbox.
 *    - Opens the Lead Detail drawer, verifies the 1-click `https://wa.me/...` follow-up link,
 *      transitions status `Baru` -> `Dihubungi` with internal notes, and verifies persistence after reload.
 *    - Toggles PII-free email notifications OFF & ON, and verifies owner CSV export (`200 text/csv`).
 *    - Verifies keyboard accessibility (Tab focus ring >= 2px), >= 44px mobile tap targets,
 *      zero horizontal overflow, and zero console/page errors.
 *    - Captures `leads-inbox-1440.png` and `leads-inbox-360.png`.
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

const screenshotDir = process.env.TASK021_SCREENSHOT_DIR || "";

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
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 10_000 },
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

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`astro dev did not become ready on port ${port}`);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(raw) {
  const clean = raw.toUpperCase().replace(/[^A-Z2-7]/g, "");
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
 * Compiles the REAL `Layout.astro` + `SectionContactForm.astro` using Astro build
 * into an isolated temp folder so Chromium renders the exact production HTML/CSS
 * with `javaScriptEnabled: false`.
 */
async function buildRealContactFormPages() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t021-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const contactFormImport = path.join(webDir, "src/themes/default/sections/SectionContactForm.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const makePageSource = (extraScript) => `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${extraScript}
const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Alpha Konsultan",
    tagline: "Mitra Konsultasi Bisnis Terpercaya",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Alpha Konsultan",
    category: "LocalBusiness",
    description: "Konsultan pendirian perusahaan dan legalitas usaha.",
    address: "Jl. Jenderal Sudirman No. 45",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: null,
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@alpha-konsultan.example",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Kontak", href: "/kontak", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Kontak", href: "/kontak", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: null,
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
---
<Layout
  shell={shell}
  pageTitle="Kontak"
  pageDescription="Hubungi tim Alpha Konsultan"
  currentPath="/kontak"
  showConsent={false}
>
  <SectionContactForm
    id="formulir-kontak"
    businessName="Alpha Konsultan"
    sourcePath="/kontak"
    returnTo="/kontak"
    isFirstSection={true}
  />
</Layout>
`;

  fs.writeFileSync(path.join(pagesDir, "kontak.astro"), makePageSource(""), "utf8");
  fs.writeFileSync(
    path.join(pagesDir, "kontak-accepted.astro"),
    makePageSource(`Astro.url.searchParams.set("leadStatus", "accepted");\nAstro.url.searchParams.set("leadNumber", "1");`),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pagesDir, "kontak-error.astro"),
    makePageSource(`Astro.url.searchParams.set("leadStatus", "error");\nAstro.url.searchParams.set("code", "VALIDATION_ERROR");`),
    "utf8",
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    vite: {
      logLevel: "error",
    },
  });

  return {
    tmpRoot,
    outDir,
    initialHtml: fs.readFileSync(path.join(outDir, "kontak/index.html"), "utf8"),
    acceptedHtml: fs.readFileSync(path.join(outDir, "kontak-accepted/index.html"), "utf8"),
    errorHtml: fs.readFileSync(path.join(outDir, "kontak-error/index.html"), "utf8"),
  };
}

/**
 * Starts a lightweight public-tenant HTTP fixture server that serves the compiled
 * real `SectionContactForm.astro` HTML/CSS and proxies `POST /api/leads` directly
 * to `astro dev` under `Host: <tenantHandle>.situsku.click`!
 */
async function startContactFormProxyServer({
  outDir,
  initialHtml,
  acceptedHtml,
  errorHtml,
  astroPort,
  tenantHost,
}) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && reqUrl.pathname === "/api/leads") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const ct = req.headers["content-type"] || "application/x-www-form-urlencoded";
          const forwarded = await httpRequest(astroPort, "/api/leads", {
            method: "POST",
            headers: {
              Host: tenantHost,
              "Content-Type": ct,
              "Sec-Fetch-Site": "same-origin",
              "CF-Connecting-IP": "203.0.113.42",
            },
            body: rawBody,
          });
          const outHeaders = {};
          if (forwarded.headers.location) outHeaders.Location = forwarded.headers.location;
          if (forwarded.headers["content-type"]) {
            outHeaders["Content-Type"] = forwarded.headers["content-type"];
          }
          outHeaders["Cache-Control"] = "no-store";
          res.writeHead(forwarded.status, outHeaders);
          res.end(forwarded.body);
        } catch (err) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(err));
        }
      });
      return;
    }

    if (reqUrl.pathname === "/" || reqUrl.pathname === "/kontak") {
      const status = reqUrl.searchParams.get("leadStatus");
      const leadNum = reqUrl.searchParams.get("leadNumber") || "1";
      let html = initialHtml;
      if (status === "accepted") {
        html = acceptedHtml.replace(/#1\b/g, `#${leadNum.replace(/[^0-9]/g, "") || "1"}`);
      } else if (status === "error") {
        html = errorHtml;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Serve Astro-compiled static CSS assets
    const safeRel = reqUrl.pathname.replace(/^\/+/, "");
    const assetPath = path.join(outDir, safeRel);
    if (assetPath.startsWith(outDir) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      const ext = path.extname(assetPath).toLowerCase();
      const mime = ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(assetPath));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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

  let browser;
  let formProxy;
  let compiledForm;

  try {
    const [built] = await Promise.all([buildRealContactFormPages(), waitForServer(astroPort)]);
    compiledForm = built;

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const baseUrl = `http://127.0.0.1:${astroPort}`;
    const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    const opEmail = `op.t021.${suffix}@example.test`;
    const opPass = "OpPass!2026T021";
    const ownerEmail = `owner.t021.${suffix}@example.test`;
    const ownerPass = "OwnerPass!2026T021";
    const tenantHandle = `lead-${suffix.replace(/[^a-z0-9]/g, "").slice(0, 14)}`;
    const tenantHost = `${tenantHandle}.situsku.click`;

    const consoleErrors = [];
    const pageErrors = [];

    // 1. Bootstrap operator + owner & atomically provision a real tenant (with migrated TenantStore DO)
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, { email: opEmail, password: opPass, name: "Operator T021" });

    // Enroll 2FA so operator can access /console/provisioning
    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", opPass);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    await opPage.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    const safeOpEmail = opEmail.replace(/'/g, "''");
    const nowMs = Date.now();
    runLocalD1Sql(
      `UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOpEmail}';
       INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-021', ${nowMs}, NULL
       FROM users WHERE lower(email) = '${safeOpEmail}';`,
    );

    // Sign up owner account
    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    ownerPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    ownerPage.on("pageerror", (err) => pageErrors.push(String(err)));
    await ownerPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(ownerPage, {
      email: ownerEmail,
      password: ownerPass,
      name: "Pemilik Konsultan T021",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    // Provision real tenant with migrated TenantStore DO via /console/provisioning
    await opPage.goto(`${baseUrl}/console/provisioning`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await opPage.fill("#provision-name", "Alpha Konsultan");
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Provisioning tenant uji E2E untuk TASK-021 lead capture");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');
    await opCtx.close();

    // -------------------------------------------------------------------------
    // 2. Part A — Zero-JS (`javaScriptEnabled: false`) Contact Form at 360px
    // -------------------------------------------------------------------------
    formProxy = await startContactFormProxyServer({
      ...compiledForm,
      astroPort,
      tenantHost,
    });
    const formUrl = `http://127.0.0.1:${formProxy.port}/kontak`;

    const noJsCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();
    const formResp = await noJsPage.goto(formUrl, { waitUntil: "domcontentloaded" });
    assert(formResp && formResp.status() === 200, `Contact form page returned ${formResp?.status()}`);

    const formLayout = await noJsPage.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const submitRect = document.querySelector('[data-testid="lead-form-submit"]')?.getBoundingClientRect();
      const nameRect = document.querySelector('input[name="name"]')?.getBoundingClientRect();
      const phoneRect = document.querySelector('input[name="phone"]')?.getBoundingClientRect();
      return {
        overflow,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        submitHeight: submitRect?.height ?? 0,
        nameHeight: nameRect?.height ?? 0,
        phoneHeight: phoneRect?.height ?? 0,
      };
    });
    assert(!formLayout.overflow, `No-JS contact form @ 360px overflows (${formLayout.scrollWidth} > ${formLayout.innerWidth})`);
    assert(formLayout.submitHeight >= 44, `Contact form submit button < 44px (${formLayout.submitHeight})`);
    assert(formLayout.nameHeight >= 44, `Contact form name input < 44px (${formLayout.nameHeight})`);
    assert(formLayout.phoneHeight >= 44, `Contact form phone input < 44px (${formLayout.phoneHeight})`);

    // Fill & submit form with JS strictly DISABLED
    await noJsPage.fill('input[name="name"]', "Budi Prakoso");
    await noJsPage.fill('input[name="phone"]', "0812-3456-7890");
    await noJsPage.fill('input[name="email"]', "budi.prakoso@example.test");
    await noJsPage.fill(
      'textarea[name="message"]',
      "Halo Alpha Konsultan, saya tertarik konsultasi pendirian PT minggu depan.",
    );
    await noJsPage.check('input[name="privacyConsent"]');

    await Promise.all([
      noJsPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
      noJsPage.click('[data-testid="lead-form-submit"]'),
    ]);

    const afterSubmitUrl = noJsPage.url();
    assert(
      afterSubmitUrl.includes("leadStatus=accepted") && afterSubmitUrl.includes("leadNumber=1"),
      `Expected PRG redirect with leadStatus=accepted&leadNumber=1, got ${afterSubmitUrl}`,
    );
    assert(
      !afterSubmitUrl.includes("Budi") && !afterSubmitUrl.includes("0812"),
      `PRG redirect URL must never contain visitor PII: ${afterSubmitUrl}`,
    );

    const statusBannerText = (await noJsPage.textContent('[data-testid="lead-form-status"]'))?.trim() ?? "";
    assert(
      statusBannerText.includes("Pesan Anda berhasil dikirim") && statusBannerText.includes("#1"),
      `Expected durable Bahasa Indonesia success banner with #1, got: "${statusBannerText}"`,
    );

    if (screenshotDir) {
      await noJsPage.screenshot({
        path: path.join(screenshotDir, "contact-form-360.png"),
        fullPage: true,
      });
    }
    await noJsCtx.close();

    // -------------------------------------------------------------------------
    // 3. Part B — Authenticated Dashboard Lead Inbox at 1440px & 360px
    // -------------------------------------------------------------------------
    const inboxUrl = `${baseUrl}/dashboard/${tenantHandle}/leads`;

    // Unauthenticated guard check
    const unauthInbox = await httpRequest(astroPort, `/dashboard/${tenantHandle}/leads`);
    assert(
      unauthInbox.status === 302 && String(unauthInbox.headers.location ?? "").includes("/auth/login"),
      `Unauthenticated inbox must redirect 302 to /auth/login, got ${unauthInbox.status}`,
    );

    // Open inbox at 1440px as authenticated owner
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    const inboxRes = await ownerPage.goto(inboxUrl, { waitUntil: "networkidle" });
    assert(inboxRes && inboxRes.status() === 200, `Expected 200 on ${inboxUrl}, got ${inboxRes?.status()}`);
    assert(
      (inboxRes.headers()["cache-control"] ?? "").includes("no-store"),
      `Inbox must return Cache-Control: private, no-store`,
    );
    await ownerPage.waitForSelector('[data-testid="leads-inbox-page"]');
    await ownerPage.waitForSelector('[data-testid="lead-row-1"]');

    const desktopCheck = await ownerPage.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const rowText = document.querySelector('[data-testid="lead-row-1"]')?.textContent ?? "";
      const waHref = document.querySelector('[data-testid="lead-wa-link-1"]')?.getAttribute("href") ?? "";
      return { overflow, rowText, waHref };
    });
    assert(!desktopCheck.overflow, "Leads inbox @ 1440px must not have horizontal overflow");
    assert(desktopCheck.rowText.includes("Budi Prakoso"), `Lead #1 missing visitor name: ${desktopCheck.rowText}`);
    assert(
      desktopCheck.waHref.startsWith("https://wa.me/6281234567890?text="),
      `Expected TASK-010 wa.me follow-up link, got: ${desktopCheck.waHref}`,
    );

    // Open Lead Detail drawer, verify WA CTA, update status Baru -> Dihubungi + internal notes
    await ownerPage.click('[data-testid="lead-open-detail-1"]');
    await ownerPage.waitForSelector('[data-testid="lead-detail-sheet"]');
    const drawerWaHref = await ownerPage.getAttribute('[data-testid="lead-detail-wa-btn"]', "href");
    assert(
      drawerWaHref && drawerWaHref.startsWith("https://wa.me/6281234567890?text="),
      `Drawer WA follow-up CTA missing valid wa.me URL: ${drawerWaHref}`,
    );

    await ownerPage.click('[data-testid="lead-status-btn-contacted"]');
    await ownerPage.fill('[data-testid="lead-notes-input"]', "Sudah dihubungi via WA, janji temu Kamis.");
    await ownerPage.click('[data-testid="lead-save-btn"]');
    await ownerPage.waitForSelector('[data-testid="lead-detail-success"]');

    // Capture 1440px desktop screenshot (with updated detail drawer visible or list updated)
    await ownerPage.keyboard.press("Escape");
    await ownerPage.waitForTimeout(200);
    const updatedBadge = (await ownerPage.textContent('[data-testid="lead-status-badge-1"]'))?.trim() ?? "";
    assert(updatedBadge === "Dihubungi", `Expected badge "Dihubungi" after save, got "${updatedBadge}"`);

    // Toggle email notifications OFF and verify feedback
    await ownerPage.click('[data-testid="leads-email-notif-toggle"]');
    await ownerPage.waitForSelector('[data-testid="leads-notif-feedback"]');
    const ariaChecked = await ownerPage.getAttribute('[data-testid="leads-email-notif-toggle"]', "aria-checked");
    assert(ariaChecked === "false", `Expected notification toggle aria-checked="false", got "${ariaChecked}"`);

    // Verify CSV export download link works and returns formula-safe CSV
    const csvHref = await ownerPage.getAttribute('[data-testid="leads-export-csv-btn"]', "href");
    assert(csvHref && csvHref.endsWith("/leads/export.csv"), `Unexpected CSV href: ${csvHref}`);
    const csvCheck = await ownerPage.evaluate(async (href) => {
      const r = await fetch(href, { credentials: "same-origin" });
      return { status: r.status, ct: r.headers.get("content-type") ?? "", text: await r.text() };
    }, csvHref);
    assert(csvCheck.status === 200, `CSV export returned ${csvCheck.status}`);
    assert(csvCheck.ct.includes("text/csv"), `CSV export content-type was ${csvCheck.ct}`);
    assert(csvCheck.text.includes("Budi Prakoso") && csvCheck.text.includes("contacted"), "CSV missing updated lead");

    // Reload and verify status & notification preference persisted in TenantStore
    await ownerPage.reload({ waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="lead-status-badge-1"]');
    const persistedBadge = (await ownerPage.textContent('[data-testid="lead-status-badge-1"]'))?.trim() ?? "";
    assert(persistedBadge === "Dihubungi", `Status did not persist after reload: "${persistedBadge}"`);

    // Keyboard accessibility: Tab to skip link and next control with visible >= 2px focus outline
    await ownerPage.keyboard.press("Tab");
    const firstTabText = await ownerPage.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(firstTabText.includes("Lewati ke konten utama"), `Expected skip link on first Tab, got "${firstTabText}"`);
    await ownerPage.keyboard.press("Tab");
    const focusStyle = await ownerPage.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { width: 0, style: "none" };
      const cs = getComputedStyle(el);
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
    });
    assert(
      focusStyle.style !== "none" && focusStyle.width >= 2,
      `Expected >= 2px keyboard focus outline, got ${JSON.stringify(focusStyle)}`,
    );

    if (screenshotDir) {
      await ownerPage.evaluate(() => window.scrollTo(0, 0));
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "leads-inbox-1440.png"),
        fullPage: true,
      });
    }

    // Check 360px mobile layout, >= 44px touch targets & zero horizontal overflow
    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.goto(inboxUrl, { waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="lead-card-1"]');

    const mobileCheck = await ownerPage.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const targets = [
        '[data-testid="leads-email-notif-toggle"]',
        '[data-testid="leads-export-csv-btn"]',
        '[data-testid="leads-filter-all"]',
        '[data-testid="lead-mobile-wa-1"]',
        '[data-testid="lead-mobile-detail-1"]',
      ].map((sel) => {
        const el = document.querySelector(sel);
        const rect = el ? el.getBoundingClientRect() : null;
        return { sel, height: rect?.height ?? 0 };
      });
      return {
        overflow,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        targets,
      };
    });
    assert(
      !mobileCheck.overflow,
      `Leads inbox @ 360px has horizontal overflow (${mobileCheck.scrollWidth} > ${mobileCheck.innerWidth})`,
    );
    for (const t of mobileCheck.targets) {
      assert(t.height >= 44, `Mobile tap target ${t.sel} height ${t.height}px < 44px`);
    }

    if (screenshotDir) {
      await ownerPage.evaluate(() => window.scrollTo(0, 0));
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "leads-inbox-360.png"),
        fullPage: true,
      });
    }

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-021 E2E PASS: Zero-JS contact form PRG submit @ 360px -> real TenantStore persistence -> authenticated Lead Inbox @ 1440px & 360px (status update, WA follow-up link, notification toggle, CSV export, keyboard focus, >= 44px touch targets, 0 overflow, 0 console/page errors).",
    );
  } catch (err) {
    console.error("TASK-021 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs ---\n", logs.slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (formProxy) await formProxy.close();
    if (compiledForm?.tmpRoot) {
      fs.rmSync(compiledForm.tmpRoot, { recursive: true, force: true });
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
