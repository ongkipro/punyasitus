/* global process, console, setTimeout, document, window, getComputedStyle, fetch, Buffer, URL */
/**
 * TASK-022 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Real-browser proof covering every acceptance criterion:
 * 1. Compiles a REAL Astro public tenant page combining `Layout.astro` + `AnalyticsHead.astro`
 *    + `Consent.astro` + `SectionContactForm.astro` + WhatsApp CTA link (direct GA4 / Meta / TikTok only).
 * 2. Intercepts mock vendor network endpoints (`https://mock-ga4.test/**`, `https://mock-meta.test/**`,
 *    `https://mock-tiktok.test/**`) in Chromium:
 *    - Before consent: **0** network requests to mock GA4 / Meta / TikTok endpoints.
 *    - Declining consent ("Tolak opsional"): still **0** vendor requests.
 *    - Granting consent ("Terima semua"): configured GA4 / Meta / TikTok tags load and fire `page_view` / `PageView`.
 *    - Failed/invalid lead submission -> **0** lead conversion signals.
 *    - Persisted lead submission (`POST /api/leads` -> `201`) -> fires `generate_lead` (GA4), `Lead` (Meta),
 *      `SubmitForm` (TikTok) **EXACTLY ONCE** with **0** visitor PII in beacons; repeated trigger for same
 *      `leadId` fires **0** duplicate signals.
 *    - Revoking consent ("Cabut izin"): immediately removes vendor `<script>` tags and stops future signals.
 * 3. Blocking/failing ALL vendor endpoints (`route.abort()`): WhatsApp CTA link & contact form submit
 *    remain 100% functional with **0** uncaught page errors.
 * 4. Dashboard `/dashboard/[handle]/settings/analytics`:
 *    - Owner saves valid GA4 / Meta / TikTok IDs, reloads page to verify persistence, sees GTM rejection error.
 *    - Verified at `1440px` & `360px` with zero horizontal overflow, `>= 44px` tap targets, and zero console/page errors.
 *    - Saves `analytics-settings-1440.png` and `analytics-settings-360.png` when `TASK022_SCREENSHOT_DIR` is set.
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

const screenshotDir = process.env.TASK022_SCREENSHOT_DIR || "";

const MOCK_GA4_URL = "https://mock-ga4.test/gtag/js";
const MOCK_META_URL = "https://mock-meta.test/fbevents.js";
const MOCK_TIKTOK_URL = "https://mock-tiktok.test/events.js";

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
 * Compiles a REAL Astro public tenant page with `Layout.astro`, `AnalyticsHead.astro`,
 * `Consent.astro` (inside Layout), `SectionContactForm.astro`, and a WhatsApp CTA link.
 */
async function buildRealAnalyticsPublicSite() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t022-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const analyticsHeadImport = path.join(webDir, "src/components/AnalyticsHead.astro");
  const contactFormImport = path.join(webDir, "src/themes/default/sections/SectionContactForm.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const pageSource = `---
import Layout from ${JSON.stringify(layoutImport)};
import AnalyticsHead from ${JSON.stringify(analyticsHeadImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Klinik Gigi Sehat",
    tagline: "Perawatan Gigi Keluarga Terpercaya",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: {
      ga4MeasurementId: "G-TEST123456",
      metaPixelId: "123456789012345",
      tiktokPixelId: "C1234567890ABCDEF",
    },
  },
  business: {
    name: "Klinik Gigi Sehat",
    category: "LocalBusiness",
    description: "Klinik perawatan gigi profesional di Jakarta Selatan.",
    address: "Jl. Sudirman No. 10",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: null,
    weekdayHours: "Senin–Sabtu 09.00–20.00 WIB",
    holidayHours: "Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@klinik-gigi.example",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Kontak", href: "#formulir-kontak", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Kontak", href: "#formulir-kontak", openInNewTab: false, children: [] }],
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
  pageTitle="Beranda"
  pageDescription="Konsultasi gigi dengan dokter berpengalaman"
  currentPath="/"
  showConsent={true}
>
  <AnalyticsHead
    slot="head"
    surface="tenant"
    appEnv="test"
    config={shell.site.analyticsConfig}
    vendorScriptOverrides={{
      ga4: ${JSON.stringify(MOCK_GA4_URL)},
      meta: ${JSON.stringify(MOCK_META_URL)},
      tiktok: ${JSON.stringify(MOCK_TIKTOK_URL)},
    }}
  />
  <section class="ps-section" style="padding: 2rem 1rem;">
    <div class="ps-container">
      <h1>Klinik Gigi Sehat Jakarta</h1>
      <p>Hubungi kami melalui WhatsApp atau formulir kontak di bawah ini.</p>
      <a
        href="https://wa.me/6281234567890?text=Halo%20Klinik%20Gigi"
        target="_blank"
        rel="noopener noreferrer"
        class="ps-btn ps-btn--primary"
        data-testid="public-wa-cta"
        style="display:inline-flex;align-items:center;min-height:44px;padding:0.625rem 1rem;margin-top:0.75rem;"
      >
        Chat WhatsApp Sekarang
      </a>
    </div>
  </section>
  <SectionContactForm
    id="formulir-kontak"
    businessName="Klinik Gigi Sehat"
    sourcePath="/"
    returnTo="/"
  />
</Layout>
`;

  fs.writeFileSync(path.join(pagesDir, "index.astro"), pageSource, "utf8");

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

/**
 * Serves the compiled public tenant site and proxies `POST /api/leads` to `astro dev`
 * under `Host: <tenantHandle>.situsku.click`.
 */
async function startPublicSiteProxyServer({ outDir, astroPort, tenantHost }) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && reqUrl.pathname === "/api/leads") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const ct = req.headers["content-type"] || "application/json";
          const idem = req.headers["idempotency-key"];
          const forwarded = await httpRequest(astroPort, "/api/leads", {
            method: "POST",
            headers: {
              Host: tenantHost,
              Origin: `https://${tenantHost}`,
              "Content-Type": ct,
              "Sec-Fetch-Site": "same-origin",
              "CF-Connecting-IP": "203.0.113.55",
              ...(idem ? { "Idempotency-Key": String(idem) } : {}),
            },
            body: rawBody,
          });
          res.writeHead(forwarded.status, {
            "Content-Type": forwarded.headers["content-type"] || "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(forwarded.body);
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "BAD_GATEWAY", message: String(err) } }));
        }
      });
      return;
    }

    const relPath = reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname.replace(/^\/+/, "");
    const filePath = path.join(outDir, relPath);
    if (filePath.startsWith(outDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".html"
          ? "text/html; charset=utf-8"
          : ext === ".js" || ext === ".mjs"
            ? "application/javascript; charset=utf-8"
            : ext === ".css"
              ? "text/css; charset=utf-8"
              : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      res.end(fs.readFileSync(filePath));
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

function buildMockVendorScript(provider) {
  if (provider === "ga4") {
    return `
      (function () {
        var existing = Array.isArray(window.dataLayer) ? window.dataLayer.slice() : [];
        function send(entry) {
          // Enforce real gtag.js invariant: queued dataLayer entries MUST be genuine IArguments objects!
          if (Object.prototype.toString.call(entry) !== "[object Arguments]") return;
          if (entry[0] === "event") {
            fetch("https://mock-ga4.test/collect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: "ga4", event: entry[1], params: entry[2] || {} })
            }).catch(function () {});
          }
        }
        for (var i = 0; i < existing.length; i++) send(existing[i]);
        window.gtag = function () {
          window.dataLayer.push(arguments);
          send(arguments);
        };
      })();
    `;
  }
  if (provider === "meta") {
    return `
      (function () {
        var q = window.fbq && Array.isArray(window.fbq.queue) ? window.fbq.queue.slice() : [];
        function send(args) {
          if (args[0] === "track") {
            fetch("https://mock-meta.test/tr", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: "meta", event: args[1], params: args[2] || {}, opts: args[3] || {} })
            }).catch(function () {});
          }
        }
        if (window.fbq) {
          window.fbq.callMethod = function () {
            send(arguments);
          };
        }
        for (var i = 0; i < q.length; i++) send(q[i]);
      })();
    `;
  }
  return `
    (function () {
      var q = Array.isArray(window.ttq) ? window.ttq.slice() : [];
      function send(args) {
        if (args[0] === "page") {
          fetch("https://mock-tiktok.test/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "tiktok", event: "PageView", params: args[1] || {} })
          }).catch(function () {});
        } else if (args[0] === "track") {
          fetch("https://mock-tiktok.test/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "tiktok", event: args[1], params: args[2] || {}, opts: args[3] || {} })
          }).catch(function () {});
        }
      }
      if (window.ttq) {
        window.ttq.page = function (props) { send(["page", props || {}]); };
        window.ttq.track = function (ev, props, opts) { send(["track", ev, props || {}, opts || {}]); };
      }
      for (var i = 0; i < q.length; i++) send(q[i]);
    })();
  `;
}

async function verifyLayoutAndTapTargets(page, label, expectedWidth) {
  const metrics = await page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const interactive = Array.from(
      document.querySelectorAll(
        '[data-testid="analytics-settings-page"] button, [data-testid="analytics-settings-page"] input',
      ),
    );
    const smallTargets = [];
    for (const el of interactive) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.height < 43.5) {
        smallTargets.push({
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim(),
          height: Math.round(rect.height * 10) / 10,
        });
      }
    }
    return {
      docOverflow,
      clientWidth: document.documentElement.clientWidth,
      smallTargets,
    };
  });

  assert(
    metrics.docOverflow <= 1,
    `${label} (${expectedWidth}px): horizontal overflow detected (${metrics.docOverflow}px)`,
  );
  assert(
    metrics.smallTargets.length === 0,
    `${label} (${expectedWidth}px): tap targets < 44px found: ${JSON.stringify(metrics.smallTargets)}`,
  );
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
  let publicSiteServer;
  let compiledSite;

  try {
    const [built] = await Promise.all([buildRealAnalyticsPublicSite(), waitForServer(astroPort)]);
    compiledSite = built;

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
    const opEmail = `op.t022.${suffix}@example.test`;
    const opPass = "OpPass!2026T022";
    const ownerEmail = `owner.t022.${suffix}@example.test`;
    const ownerPass = "OwnerPass!2026T022";
    const tenantHandle = `anl-${suffix.replace(/[^a-z0-9]/g, "").slice(0, 14)}`;
    const tenantHost = `${tenantHandle}.situsku.click`;

    // -------------------------------------------------------------------------
    // 1. Provision real tenant with migrated TenantStore DO
    // -------------------------------------------------------------------------
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, { email: opEmail, password: opPass, name: "Operator T022" });

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
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-022', ${nowMs}, NULL
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
      name: "Pemilik Klinik T022",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    await opPage.goto(`${baseUrl}/console/provisioning`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await opPage.fill("#provision-name", "Klinik Gigi Sehat");
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Provisioning tenant uji E2E untuk TASK-022 analytics");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');
    await opCtx.close();

    // -------------------------------------------------------------------------
    // 2. Public Site — Zero-Tags-Before-Consent, Grant, Lead Once, Revoke
    // -------------------------------------------------------------------------
    publicSiteServer = await startPublicSiteProxyServer({
      outDir: compiledSite.outDir,
      astroPort,
      tenantHost,
    });
    const publicUrl = `http://127.0.0.1:${publicSiteServer.port}/`;

    const pubCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pubPage = await pubCtx.newPage();
    const pubPageErrors = [];
    pubPage.on("pageerror", (err) => pubPageErrors.push(String(err)));

    const vendorScriptHits = [];
    const vendorBeaconHits = [];

    await pubPage.route(/https:\/\/mock-(ga4|meta|tiktok)\.test\/.*/, async (route) => {
      const req = route.request();
      const url = req.url();
      const host = new URL(url).hostname;
      const provider = host.includes("ga4") ? "ga4" : host.includes("meta") ? "meta" : "tiktok";

      if (req.method() === "GET") {
        vendorScriptHits.push({ provider, url });
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: buildMockVendorScript(provider),
        });
        return;
      }

      const raw = req.postData() || "{}";
      vendorBeaconHits.push({ provider, url, body: JSON.parse(raw), raw });
      await route.fulfill({ status: 204, body: "" });
    });

    await pubPage.goto(publicUrl, { waitUntil: "networkidle" });

    // (2a) Before consent: ZERO vendor script loads & ZERO beacons!
    assert(
      vendorScriptHits.length === 0 && vendorBeaconHits.length === 0,
      `Expected 0 vendor requests before consent, got scripts=${vendorScriptHits.length}, beacons=${vendorBeaconHits.length}`,
    );

    // (2b) Decline consent ("Tolak opsional") -> still ZERO vendor requests!
    await pubPage.click('[data-testid="consent-reject-optional"]');
    await pubPage.waitForTimeout(150);
    assert(
      vendorScriptHits.length === 0 && vendorBeaconHits.length === 0,
      `Expected 0 vendor requests after decline, got scripts=${vendorScriptHits.length}, beacons=${vendorBeaconHits.length}`,
    );

    // (2c) Grant consent ("Ubah / cabut izin privasi" -> check analytics & marketing -> save)
    await pubPage.click('[data-testid="consent-manage-trigger"]');
    await pubPage.waitForSelector('[data-testid="consent-preferences-dialog"]:not([hidden])');
    await pubPage.check('[data-testid="consent-toggle-analytics"]');
    await pubPage.check('[data-testid="consent-toggle-marketing"]');
    await pubPage.click('[data-testid="consent-save-preferences"]');

    // Wait for all 3 vendor scripts + initial page_view beacons
    await pubPage.waitForFunction(() => {
      return (
        document.querySelectorAll('script[data-ps-analytics-loaded="true"]').length === 3
      );
    });
    await pubPage.waitForTimeout(250);

    assert(
      vendorScriptHits.map((h) => h.provider).sort().join(",") === "ga4,meta,tiktok",
      `Expected GA4, Meta, TikTok scripts loaded after consent, got ${JSON.stringify(vendorScriptHits)}`,
    );
    const pageViewEvents = vendorBeaconHits.map((b) => `${b.provider}:${b.body.event}`).sort();
    assert(
      pageViewEvents.join(",") === "ga4:page_view,meta:PageView,tiktok:PageView",
      `Expected page_view/PageView beacons after consent, got ${JSON.stringify(pageViewEvents)}`,
    );

    // (2d) Failed lead submission (invalid phone) -> ZERO lead conversion signals!
    const beaconsBeforeInvalidLead = vendorBeaconHits.length;
    await pubPage.fill("#formulir-kontak-name", "Budi Santoso");
    await pubPage.fill("#formulir-kontak-phone", "123"); // invalid phone -> 422
    await pubPage.fill("#formulir-kontak-email", "budi.rahasia@example.test");
    await pubPage.fill("#formulir-kontak-message", "Mohon info jadwal tambal gigi minggu depan.");
    await pubPage.check("#formulir-kontak-consent");
    await pubPage.click('[data-testid="lead-form-submit"]');
    await pubPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="error"]');
    await pubPage.waitForTimeout(200);
    assert(
      vendorBeaconHits.length === beaconsBeforeInvalidLead,
      `Invalid lead submit must NOT fire conversion beacons (got ${vendorBeaconHits.length - beaconsBeforeInvalidLead} new beacons)`,
    );

    // (2e) Valid persisted lead submission -> fires EXACTLY ONCE across GA4/Meta/TikTok with ZERO PII!
    await pubPage.fill("#formulir-kontak-phone", "081234567890");
    await pubPage.click('[data-testid="lead-form-submit"]');
    await pubPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    await pubPage.waitForTimeout(300);

    const leadBeacons = vendorBeaconHits.filter((b) =>
      ["generate_lead", "Lead", "SubmitForm"].includes(b.body.event),
    );
    assert(
      leadBeacons.length === 3,
      `Expected exactly 3 persisted lead beacons (GA4/Meta/TikTok), got ${leadBeacons.length}: ${JSON.stringify(leadBeacons)}`,
    );
    assert(
      leadBeacons.map((b) => `${b.provider}:${b.body.event}`).sort().join(",") ===
        "ga4:generate_lead,meta:Lead,tiktok:SubmitForm",
      `Unexpected lead beacon mapping: ${JSON.stringify(leadBeacons)}`,
    );
    for (const beacon of leadBeacons) {
      assert(!beacon.raw.includes("Budi Santoso"), "Lead beacon leaked visitor name!");
      assert(!beacon.raw.includes("budi.rahasia@example.test"), "Lead beacon leaked visitor email!");
      assert(!beacon.raw.includes("081234567890"), "Lead beacon leaked visitor phone!");
      assert(!beacon.raw.includes("tambal gigi"), "Lead beacon leaked visitor message!");
    }

    // Re-triggering lead_submitted for same persisted leadId #1 MUST NOT fire duplicate signals
    const dupResult = await pubPage.evaluate(() => {
      return window.__punyasitusAnalytics?.trackLeadSubmitted({ leadId: 1, persisted: true });
    });
    assert(
      dupResult && dupResult.ok === false && dupResult.reason === "DUPLICATE_LEAD_ID",
      `Expected duplicate leadId deduplication, got ${JSON.stringify(dupResult)}`,
    );
    await pubPage.waitForTimeout(150);
    const leadBeaconsAfterDup = vendorBeaconHits.filter((b) =>
      ["generate_lead", "Lead", "SubmitForm"].includes(b.body.event),
    );
    assert(leadBeaconsAfterDup.length === 3, "Duplicate leadId must produce zero extra beacons");

    // (2f) Revoke consent ("Cabut izin") -> removes vendor scripts & stops future signals
    await pubPage.click('[data-testid="consent-withdraw-quick"]');
    await pubPage.waitForTimeout(150);
    const remainingVendorScripts = await pubPage.evaluate(
      () => document.querySelectorAll('script[data-ps-analytics-loaded="true"]').length,
    );
    assert(remainingVendorScripts === 0, "Vendor script tags must be removed on consent revocation");

    const beaconsBeforeRevokedClick = vendorBeaconHits.length;
    await pubPage.evaluate(() => {
      window.__punyasitusAnalytics?.trackEvent("whatsapp_click", { cta_mode: "whatsapp" });
    });
    await pubPage.waitForTimeout(150);
    assert(
      vendorBeaconHits.length === beaconsBeforeRevokedClick,
      "Post-revocation events must emit 0 vendor beacons",
    );
    assert(pubPageErrors.length === 0, `Public page errors: ${pubPageErrors.join("; ")}`);
    await pubCtx.close();

    // -------------------------------------------------------------------------
    // 3. Fault Tolerance — Blocking ALL vendor endpoints leaves WA CTA & Lead Form 100% functional
    // -------------------------------------------------------------------------
    const blockedCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const blockedPage = await blockedCtx.newPage();
    const blockedPageErrors = [];
    blockedPage.on("pageerror", (err) => blockedPageErrors.push(String(err)));

    await blockedPage.route(/https:\/\/mock-(ga4|meta|tiktok)\.test\/.*/, (route) => route.abort());
    await blockedPage.goto(publicUrl, { waitUntil: "networkidle" });
    await blockedPage.click('[data-testid="consent-accept-all"]');
    await blockedPage.waitForTimeout(200);

    // Clicking WhatsApp CTA keeps valid href/popup without uncaught exception
    const waHref = await blockedPage.getAttribute('[data-testid="public-wa-cta"]', "href");
    assert(waHref && waHref.startsWith("https://wa.me/6281234567890"), `Invalid WA href: ${waHref}`);
    const [popup] = await Promise.all([
      blockedCtx.waitForEvent("page", { timeout: 5_000 }).catch(() => null),
      blockedPage.click('[data-testid="public-wa-cta"]'),
    ]);
    if (popup) await popup.close().catch(() => {});

    // Contact form still persists cleanly while all vendor scripts are aborted
    await blockedPage.fill("#formulir-kontak-name", "Siti Amanah");
    await blockedPage.fill("#formulir-kontak-phone", "081299998888");
    await blockedPage.fill("#formulir-kontak-email", "siti@example.test");
    await blockedPage.fill("#formulir-kontak-message", "Cek jadwal scaling gigi akhir pekan.");
    await blockedPage.check("#formulir-kontak-consent");
    await blockedPage.click('[data-testid="lead-form-submit"]');
    await blockedPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    assert(
      blockedPageErrors.length === 0,
      `Blocked-vendor page had uncaught errors: ${blockedPageErrors.join("; ")}`,
    );
    await blockedCtx.close();

    // -------------------------------------------------------------------------
    // 4. Dashboard `/dashboard/<handle>/settings/analytics` at 1440px & 360px
    // -------------------------------------------------------------------------
    const analyticsUrl = `${baseUrl}/dashboard/${tenantHandle}/settings/analytics`;
    await ownerPage.goto(analyticsUrl, { waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="analytics-settings-page"]');

    // Verify GTM rejection inline feedback
    await ownerPage.fill('[data-testid="input-ga4-id"]', "GTM-REJECT99");
    await ownerPage.waitForSelector('[data-testid="error-ga4-id"]');

    // Save valid direct GA4 / Meta / TikTok IDs
    await ownerPage.fill('[data-testid="input-ga4-id"]', "G-AB12CD34EF");
    await ownerPage.fill('[data-testid="input-meta-id"]', "123456789012345");
    await ownerPage.fill('[data-testid="input-tiktok-id"]', "C1234567890ABCDEF");
    await ownerPage.click('[data-testid="analytics-save-button"]');
    await ownerPage.waitForSelector('[data-testid="analytics-status-success"]');

    // Reload page and confirm persistence
    await ownerPage.reload({ waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="analytics-settings-page"]');
    assert(
      (await ownerPage.inputValue('[data-testid="input-ga4-id"]')) === "G-AB12CD34EF",
      "GA4 ID did not persist after reload",
    );
    assert(
      (await ownerPage.inputValue('[data-testid="input-meta-id"]')) === "123456789012345",
      "Meta Pixel ID did not persist after reload",
    );
    assert(
      (await ownerPage.inputValue('[data-testid="input-tiktok-id"]')) === "C1234567890ABCDEF",
      "TikTok Pixel ID did not persist after reload",
    );

    // 1440px layout, tap targets & screenshot
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(ownerPage, "Analytics Settings Desktop", 1440);
    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "analytics-settings-1440.png"),
        fullPage: true,
      });
    }

    // 360px layout, tap targets & screenshot
    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(ownerPage, "Analytics Settings Mobile", 360);
    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "analytics-settings-360.png"),
        fullPage: true,
      });
    }

    assert(
      dashConsoleErrors.length === 0,
      `Dashboard console errors: ${dashConsoleErrors.join("; ")}`,
    );
    assert(
      dashPageErrors.length === 0,
      `Dashboard page errors: ${dashPageErrors.join("; ")}`,
    );

    await ownerCtx.close();
    console.log("TASK-022 E2E PASSED (zero-tags-before-consent, grant, lead-once PII-free, revoke, blocked-vendor resilience, dashboard 360px & 1440px).");
  } catch (err) {
    console.error("TASK-022 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs (tail) ---\n" + logs.slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await publicSiteServer?.close().catch(() => {});
    if (compiledSite?.tmpRoot) {
      fs.rmSync(compiledSite.tmpRoot, { recursive: true, force: true });
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

await main();
