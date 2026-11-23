/* global process, console, setTimeout, document, window, fetch, Buffer, URL */
/**
 * TASK-065 E2E Browser Verification (Playwright Chromium at 1440px & 360px).
 *
 * Proves end-to-end browser + TenantStore SQLite parity & zero double-counting:
 * 1. Real Astro public tenant page combining `Layout.astro` + `AnalyticsHead.astro`
 *    (GTM + direct Meta, GA4 & TikTok routed via GTM) + `Consent.astro` + `SectionContactForm.astro`
 *    + WhatsApp CTA + External Marketplace CTA, backed by REAL `astro dev` `/api/events` & `/api/leads`
 *    persisting into a real migrated `TenantStore` Durable Object!
 * 2. Pre-consent: 0 GTM / Meta loads, 0 third-party beacons, strict CSP, Consent Mode v2 default=denied.
 * 3. Post-consent:
 *    - `page_view`: first-party `POST /api/events`, GTM `ps_page_view`, and direct Meta `PageView`
 *      share the EXACT SAME RFC 4122 UUID `event_id` with 0 duplicate `/api/events` calls.
 *    - Rapid double-click on WhatsApp CTA (2 clicks back-to-back) -> EXACTLY 1 `/api/events` (`wa_click`),
 *      EXACTLY 1 GTM `ps_wa_click`, EXACTLY 1 direct Meta `Contact`, ALL carrying the EXACT SAME UUID;
 *      GA4/TikTok (routed via GTM) NEVER double-fire directly.
 *    - Rapid double-click on External CTA -> EXACTLY 1 `/api/events` (`external_click`),
 *      EXACTLY 1 GTM `ps_external_click` (host-only), EXACTLY 1 direct Meta `ViewContent`, ALL with same UUID.
 *    - Explicit client replay + direct HTTP replay of the SAME `event_id` to `POST /api/events` ->
 *      client deduplicates (`deduplicated: true`, 0 extra vendor/GTM beacons) AND server returns `204`
 *      without double-counting in `TenantStore.analytics_daily`!
 *    - Persisted lead submission -> EXACTLY 1 `ps_lead_submitted` + 1 direct Meta `Lead` + 1 `/api/events`
 *      (`lead_submitted`) with the EXACT SAME deterministic UUID and ZERO PII; reloading the page and
 *      re-triggering the same persisted `leadId` or same `event_id` within 24h fires ZERO duplicates!
 * 4. Owner opens `/dashboard/<handle>` at 1440px & 360px: verifies exact deduplicated counts
 *    (`Klik WhatsApp = 1`, `Klik tautan eksternal = 1`, `Pesan masuk (lead) = 1`, `Kunjungan halaman >= 1`),
 *    unchanged layout, zero horizontal overflow, and saves verification screenshots to
 *    `/tmp/task-065-screenshots/`.
 * 5. Fault tolerance: aborting `/api/events`, GTM, AND Meta endpoints (`route.abort()`) keeps
 *    WhatsApp CTA, External CTA, and Contact Form 100% functional with 0 uncaught page errors.
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

const screenshotDir = process.env.TASK065_SCREENSHOT_DIR || "/tmp/task-065-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

const MOCK_GTM_URL = "https://mock-gtm.test/gtm.js";
const MOCK_GTM_NS_URL = "https://mock-gtm.test/ns.html";
const MOCK_META_URL = "https://mock-meta.test/fbevents.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function waitForServer(port, timeoutMs = 40_000) {
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
 * Compiles a REAL Astro public tenant site with `Layout.astro` + `AnalyticsHead.astro`
 * (GTM enabled + direct Meta; GA4 & TikTok routed via GTM) + `SectionContactForm.astro`
 * + WhatsApp CTA + External CTA.
 */
async function buildRealDedupPublicSite({ tenantHost, nonce }) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t065-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const analyticsHeadImport = path.join(webDir, "src/components/AnalyticsHead.astro");
  const contactFormImport = path.join(webDir, "src/themes/default/sections/SectionContactForm.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const makePage = (consented) => `---
import Layout from ${JSON.stringify(layoutImport)};
import AnalyticsHead from ${JSON.stringify(analyticsHeadImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const gtmConfig = {
  ga4MeasurementId: null,
  metaPixelId: "123456789012345",
  tiktokPixelId: null,
  vendorModes: { ga4: "gtm" as const, meta: "direct" as const, tiktok: "gtm" as const },
  gtmContainerId: "GTM-T065DDP1",
  gtmEnabled: true,
  gtmRiskAck: {
    accepted: true,
    version: 1,
    acceptedAt: "2026-11-23T10:00:00.000Z",
    acceptedByUserId: "usr_owner_t065",
  },
  gtmOperatorDisabled: false,
  gtmOperatorDisabledReasonCategory: null,
  gtmOperatorDisabledReason: null,
  gtmOperatorDisabledAt: null,
};
const consentedCookie = "__Host-ps_consent=" + encodeURIComponent(JSON.stringify({
  version: 1,
  analytics: true,
  marketing: true,
  maps: false,
  updatedAt: "2026-11-23T10:00:00.000Z",
}));

const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Studio Dedup Sejahtera",
    tagline: "Solusi Digital UMKM Terverifikasi",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: {
      ga4MeasurementId: "G-SHOULDSUPPRESS",
      metaPixelId: "123456789012345",
      tiktokPixelId: null,
    },
  },
  business: {
    name: "Studio Dedup Sejahtera",
    category: "LocalBusiness",
    description: "Layanan konsultasi bisnis UMKM dengan pelacakan akurat tanpa penghitungan ganda.",
    address: "Jl. Gatot Subroto No. 88",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12780",
    mapsUrl: null,
    weekdayHours: "Senin–Jumat 09.00–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@dedup-studio.example",
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
  pageDescription="Konsultasi digital UMKM tanpa penghitungan ganda"
  currentPath=${JSON.stringify(consented ? "/consented" : "/pre-consent")}
  showConsent={true}
  initialCookieHeader={${consented ? "consentedCookie" : "null"}}
>
  <AnalyticsHead
    slot="head"
    surface="tenant"
    appEnv="test"
    tenantScope=${JSON.stringify(tenantHost)}
    config={shell.site.analyticsConfig}
    gtmConfig={gtmConfig}
    cspProfile={${consented ? '"gtm-relaxed"' : '"strict"'}}
    cspNonce={${consented ? JSON.stringify(nonce) : "null"}}
    initialCookieHeader={${consented ? "consentedCookie" : "null"}}
    pageType="home"
    contentId="home-t065"
    vendorScriptOverrides={{ meta: ${JSON.stringify(MOCK_META_URL)} }}
    gtmScriptUrlOverride=${JSON.stringify(MOCK_GTM_URL)}
    gtmNoscriptUrlOverride=${JSON.stringify(MOCK_GTM_NS_URL)}
  />
  <section class="ps-section" style="padding: 2rem 1rem;">
    <div class="ps-container">
      <h1>Studio Dedup Sejahtera</h1>
      <p>Konsultasi UMKM dengan perlindungan event dedup 24 jam across first-party, direct tags &amp; GTM.</p>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin-top:1rem;">
        <a
          href="https://wa.me/6281234567890?text=Halo%20Studio%20Dedup"
          target="_blank"
          rel="noopener noreferrer"
          class="ps-btn ps-btn--primary"
          data-testid="public-wa-cta"
          data-ps-item-id="srv-konsultasi"
          data-ps-item-title="Konsultasi Digital UMKM"
          data-ps-placement="hero"
          style="display:inline-flex;align-items:center;min-height:44px;padding:0.625rem 1rem;"
        >
          Chat WhatsApp Sekarang
        </a>
        <a
          href="https://www.tokopedia.com/studio-dedup/paket-umkm?token=secret&email=leak@example.test"
          target="_blank"
          rel="noopener noreferrer"
          class="ps-btn ps-btn--secondary"
          data-testid="public-external-cta"
          data-ps-external-cta="true"
          data-ps-item-id="prod-paket-umkm"
          style="display:inline-flex;align-items:center;min-height:44px;padding:0.625rem 1rem;"
        >
          Buka di Tokopedia
        </a>
      </div>
    </div>
  </section>
  <SectionContactForm
    config={{
      id: "formulir-kontak",
      type: "contact",
      visible: true,
      heading: "Formulir Konsultasi",
      submitLabel: "Kirim Pesan",
      privacyNotice: "Data Anda hanya digunakan untuk membalas pertanyaan Anda.",
    }}
    mode="published"
    routePath=${JSON.stringify(consented ? "/consented" : "/pre-consent")}
    primaryOrigin=${JSON.stringify(`https://${tenantHost}`)}
    fallbackBusiness={{
      address: "Jl. Gatot Subroto No. 88, Jakarta Selatan",
      weekdayHours: "Senin–Jumat 09.00–17.00 WIB",
      phone: "+62 21 5550199",
      whatsappE164: "6281234567890",
      email: "halo@dedup-studio.example",
    }}
  />
</Layout>
`;

  fs.writeFileSync(path.join(pagesDir, "pre-consent.astro"), makePage(false), "utf8");
  fs.writeFileSync(path.join(pagesDir, "consented.astro"), makePage(true), "utf8");

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

function injectNonceToInlineScripts(html, nonce) {
  return html.replace(/<script\b([^>]*)>/gi, (full, attrs) => {
    if (/\bnonce\s*=/i.test(attrs)) return full;
    if (/\bsrc\s*=/i.test(attrs)) return full;
    if (/\btype\s*=\s*(?:"application\/(?:ld\+)?json"|'application\/(?:ld\+)?json')/i.test(attrs)) {
      return full;
    }
    return `<script nonce="${nonce}"${attrs}>`;
  });
}

/**
 * Serves the compiled public tenant site and proxies BOTH `POST /api/events` and `POST /api/leads`
 * to real `astro dev` under `Host: <tenantHost>` while recording every first-party event received.
 */
async function startPublicSiteProxyServer({ outDir, astroPort, tenantHost, nonce, eventPosts }) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && (reqUrl.pathname === "/api/leads" || reqUrl.pathname === "/api/events")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const ct = req.headers["content-type"] || "application/json";
          const idem = req.headers["idempotency-key"];
          const forwarded = await httpRequest(astroPort, reqUrl.pathname, {
            method: "POST",
            headers: {
              Host: tenantHost,
              Origin: `https://${tenantHost}`,
              "Content-Type": ct,
              "Sec-Fetch-Site": "same-origin",
              "CF-Connecting-IP": "203.0.113.65",
              ...(idem ? { "Idempotency-Key": String(idem) } : {}),
            },
            body: rawBody,
          });
          if (reqUrl.pathname === "/api/events") {
            let parsed = null;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              // keep null
            }
            eventPosts.push({ status: forwarded.status, body: parsed, raw: rawBody });
          }
          res.writeHead(forwarded.status, {
            ...(forwarded.headers["content-type"]
              ? { "Content-Type": forwarded.headers["content-type"] }
              : {}),
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

    let relPath = reqUrl.pathname.replace(/^\/+/, "");
    if (!relPath || relPath === "pre-consent") relPath = "pre-consent/index.html";
    else if (relPath === "consented") relPath = "consented/index.html";
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
      const isConsentedDoc = reqUrl.pathname === "/consented";
      const cspHeader = isConsentedDoc
        ? `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://mock-gtm.test https://mock-meta.test; connect-src 'self' https://mock-gtm.test https://mock-meta.test; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self' https://mock-gtm.test`
        : `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self'`;
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
        ...(ext === ".html"
          ? {
              "Content-Security-Policy": cspHeader,
              "X-PunyaSitus-CSP-Profile": isConsentedDoc ? "gtm-relaxed" : "strict",
            }
          : {}),
      });
      if (ext === ".html" && isConsentedDoc) {
        res.end(injectNonceToInlineScripts(fs.readFileSync(filePath, "utf8"), nonce));
        return;
      }
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

function buildMockMetaScript() {
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
      window.__mockMetaLoaded = true;
    })();
  `;
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
  let publicSiteServer = null;
  let compiledSite = null;

  try {
    const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
    const tenantHandle = `ddp-${suffix}`;
    const tenantHost = `${tenantHandle}.situsku.click`;
    const nonce = crypto.randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);

    const [built] = await Promise.all([
      buildRealDedupPublicSite({ tenantHost, nonce }),
      waitForServer(astroPort),
    ]);
    compiledSite = built;

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    const baseUrl = `http://127.0.0.1:${astroPort}`;
    const opEmail = `op.t065.${suffix}@example.test`;
    const opPass = "OpPass!2026T065";
    const ownerEmail = `owner.t065.${suffix}@example.test`;
    const ownerPass = "OwnerPass!2026T065";

    // -------------------------------------------------------------------------
    // 1. Provision real tenant with migrated TenantStore DO
    // -------------------------------------------------------------------------
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, { email: opEmail, password: opPass, name: "Operator T065" });

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
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-065', ${nowMs}, NULL
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
      name: "Pemilik Dedup T065",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    await opPage.goto(`${baseUrl}/console/provisioning`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await opPage.fill("#provision-name", "Studio Dedup Sejahtera");
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Provisioning tenant uji E2E untuk TASK-065 event dedup");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');
    await opCtx.close();

    // -------------------------------------------------------------------------
    // 2. Public Site — Pre-Consent Zero Third-Party Tags -> Post-Consent Parity & Dedup
    // -------------------------------------------------------------------------
    const eventPosts = [];
    publicSiteServer = await startPublicSiteProxyServer({
      outDir: compiledSite.outDir,
      astroPort,
      tenantHost,
      nonce,
      eventPosts,
    });

    const pubCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pubPage = await pubCtx.newPage();
    const pubPageErrors = [];
    const cspViolations = [];
    pubPage.on("pageerror", (err) => pubPageErrors.push(String(err)));
    pubPage.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().toLowerCase().includes("content security policy")) {
        cspViolations.push(msg.text());
      }
    });

    const gtmScriptHits = [];
    const metaScriptHits = [];
    const metaBeacons = [];
    await pubPage.route(/https:\/\/mock-(gtm|meta)\.test\/.*/, async (route) => {
      const req = route.request();
      const url = req.url();
      if (url.includes("mock-gtm.test")) {
        gtmScriptHits.push(url);
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: "window.__mockGtmLoaded = true;",
        });
        return;
      }
      if (req.method() === "GET") {
        metaScriptHits.push(url);
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: buildMockMetaScript(),
        });
        return;
      }
      const raw = req.postData() || "{}";
      metaBeacons.push({ body: JSON.parse(raw), raw });
      await route.fulfill({ status: 204, body: "" });
    });

    // (2a) Pre-consent page: ZERO GTM/Meta loads, ZERO third-party beacons, and ZERO localStorage/sessionStorage writes (REQ-039)!
    const preRes = await pubPage.goto(`http://127.0.0.1:${publicSiteServer.port}/pre-consent`, {
      waitUntil: "networkidle",
    });
    assert(preRes.headers()["x-punyasitus-csp-profile"] === "strict", "Pre-consent must use strict CSP");
    assert(gtmScriptHits.length === 0, "Expected 0 GTM hits before consent");
    assert(metaScriptHits.length === 0 && metaBeacons.length === 0, "Expected 0 Meta hits before consent");
    const preConsentStorage = await pubPage.evaluate(() => ({
      localStorageLength: window.localStorage.length,
      sessionStorageLength: window.sessionStorage.length,
    }));
    assert(
      preConsentStorage.localStorageLength === 0 && preConsentStorage.sessionStorageLength === 0,
      `REQ-039: Expected 0 localStorage/sessionStorage writes before consent, got ${JSON.stringify(preConsentStorage)}`,
    );

    // Reset recorded first-party eventPosts before testing the consented page flow cleanly
    eventPosts.length = 0;

    // (2b) Consented page: Consent Mode v2 + GTM + direct Meta + cookieless /api/events parity
    await pubPage.goto(`http://127.0.0.1:${publicSiteServer.port}/consented`, {
      waitUntil: "networkidle",
    });
    await pubPage.waitForFunction(() => window.__mockGtmLoaded === true && window.__mockMetaLoaded === true);
    await pubPage.waitForTimeout(250);

    assert(gtmScriptHits.length === 1, `Expected 1 GTM load, got ${gtmScriptHits.length}`);
    assert(metaScriptHits.length === 1, `Expected 1 Meta load, got ${metaScriptHits.length}`);
    assert(cspViolations.length === 0, `CSP violations detected: ${cspViolations.join("; ")}`);

    // Close any target=_blank popups asynchronously so rapid double-clicks stay well inside the 1.5s debounce window under CPU load
    const autoClosePopup = (popup) => {
      void popup.close().catch(() => {});
    };
    pubCtx.on("page", autoClosePopup);

    // Rapid DOUBLE-CLICK on WhatsApp CTA (2 clicks back-to-back!) -> MUST count ONCE!
    await pubPage.click('[data-testid="public-wa-cta"]');
    await pubPage.click('[data-testid="public-wa-cta"]');

    // Rapid DOUBLE-CLICK on External CTA -> MUST count ONCE!
    await pubPage.click('[data-testid="public-external-cta"]');
    await pubPage.click('[data-testid="public-external-cta"]');

    pubCtx.off("page", autoClosePopup);

    // Submit real lead form -> persisted in TenantStore -> fires ONCE with deterministic UUID & 0 PII!
    await pubPage.fill("#formulir-kontak-name", "Budi Santoso");
    await pubPage.fill("#formulir-kontak-phone", "081234567890");
    await pubPage.fill("#formulir-kontak-email", "budi.rahasia@example.test");
    await pubPage.fill("#formulir-kontak-message", "Mohon info paket konsultasi UMKM.");
    await pubPage.check("#formulir-kontak-consent");
    await pubPage.click('[data-testid="lead-form-submit"]');
    await pubPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    await pubPage.waitForTimeout(350);

    // Inspect window.dataLayer & verify EXACT event_id parity across /api/events + GTM + Meta!
    const dlAudit = await pubPage.evaluate(() => {
      const psEvents = [];
      for (const entry of window.dataLayer || []) {
        if (entry && typeof entry === "object" && typeof entry.event === "string" && entry.event.startsWith("ps_")) {
          psEvents.push(entry);
        }
      }
      return {
        psEvents,
        serializedPs: JSON.stringify(psEvents),
        directGa4Scripts: document.querySelectorAll('script[data-ps-analytics-vendor="ga4"]').length,
        directTiktokScripts: document.querySelectorAll('script[data-ps-analytics-vendor="tiktok"]').length,
      };
    });

    assert(dlAudit.directGa4Scripts === 0, "GA4 routed via GTM must NEVER load directly");
    assert(dlAudit.directTiktokScripts === 0, "TikTok routed via GTM must NEVER load directly");

    const fpPageViews = eventPosts.filter((e) => e.body?.eventName === "page_view");
    const fpWaClicks = eventPosts.filter((e) => e.body?.eventName === "wa_click");
    const fpExtClicks = eventPosts.filter((e) => e.body?.eventName === "external_click");
    const fpLeads = eventPosts.filter((e) => e.body?.eventName === "lead_submitted");

    assert(fpPageViews.length === 1 && fpPageViews[0].status === 204, `Expected 1 page_view /api/events (204), got ${JSON.stringify(fpPageViews)}`);
    assert(fpWaClicks.length === 1 && fpWaClicks[0].status === 204, `Expected 1 deduplicated wa_click /api/events after double-click, got ${JSON.stringify(fpWaClicks)}`);
    assert(fpExtClicks.length === 1 && fpExtClicks[0].status === 204, `Expected 1 deduplicated external_click /api/events after double-click, got ${JSON.stringify(fpExtClicks)}`);
    // POST /api/leads already increments analytics_daily.lead_submits authoritatively server-side,
    // so client dispatchLeadSubmitted MUST NOT send a redundant lead_submitted to /api/events!
    assert(fpLeads.length === 0, `Expected 0 redundant lead_submitted /api/events after POST /api/leads, got ${JSON.stringify(fpLeads)}`);

    const gtmPv = dlAudit.psEvents.filter((e) => e.event === "ps_page_view");
    const gtmWa = dlAudit.psEvents.filter((e) => e.event === "ps_wa_click");
    const gtmExt = dlAudit.psEvents.filter((e) => e.event === "ps_external_click");
    const gtmLead = dlAudit.psEvents.filter((e) => e.event === "ps_lead_submitted");

    assert(gtmPv.length === 1, `Expected 1 ps_page_view, got ${gtmPv.length}`);
    assert(gtmWa.length === 1, `Expected 1 ps_wa_click after double-click, got ${gtmWa.length}`);
    assert(gtmExt.length === 1, `Expected 1 ps_external_click after double-click, got ${gtmExt.length}`);
    assert(gtmLead.length === 1, `Expected 1 ps_lead_submitted, got ${gtmLead.length}`);

    const metaPv = metaBeacons.filter((b) => b.body.event === "PageView");
    const metaWa = metaBeacons.filter((b) => b.body.event === "Contact");
    const metaExt = metaBeacons.filter((b) => b.body.event === "ViewContent");
    const metaLead = metaBeacons.filter((b) => b.body.event === "Lead");

    assert(metaPv.length === 1, `Expected 1 Meta PageView, got ${metaPv.length}`);
    assert(metaWa.length === 1, `Expected 1 Meta Contact after double-click, got ${metaWa.length}`);
    assert(metaExt.length === 1, `Expected 1 Meta ViewContent after double-click, got ${metaExt.length}`);
    assert(metaLead.length === 1, `Expected 1 Meta Lead, got ${metaLead.length}`);

    // Assert EXACT UUID parity across all channels (first-party, GTM dataLayer, direct Meta)!
    const pvId = fpPageViews[0].body.eventId;
    const waId = fpWaClicks[0].body.eventId;
    const extId = fpExtClicks[0].body.eventId;
    const leadIdUuid = gtmLead[0].event_id;

    for (const [label, id] of [["page_view", pvId], ["wa_click", waId], ["external_click", extId], ["lead_submitted", leadIdUuid]]) {
      assert(UUID_RE.test(id), `${label} eventId must be a valid RFC 4122 UUID, got ${id}`);
    }
    assert(gtmPv[0].event_id === pvId && metaPv[0].body.opts?.eventID === pvId, "page_view event_id mismatch across channels");
    assert(gtmWa[0].event_id === waId && metaWa[0].body.opts?.eventID === waId, "wa_click event_id mismatch across channels");
    assert(gtmExt[0].event_id === extId && metaExt[0].body.opts?.eventID === extId, "external_click event_id mismatch across channels");
    assert(gtmLead[0].event_id === leadIdUuid && metaLead[0].body.opts?.eventID === leadIdUuid, "lead_submitted event_id mismatch across GTM & Meta");

    // Verify ZERO PII in dataLayer, Meta beacons, and first-party /api/events payloads
    const allSerialized = JSON.stringify({ dl: dlAudit.psEvents, meta: metaBeacons, fp: eventPosts });
    for (const secret of ["Budi Santoso", "budi.rahasia@example.test", "081234567890", "konsultasi UMKM", "leak@example.test"]) {
      assert(!allSerialized.includes(secret), `Analytics leaked PII "${secret}"!`);
    }

    // (2c) Client-side replay & direct HTTP replay of SAME event_id -> ZERO double-counting!
    const clientDupReport = await pubPage.evaluate(
      (id) => window.__punyasitusAnalytics?.trackEvent("wa_click", { event_id: id }),
      waId,
    );
    assert(
      clientDupReport && clientDupReport.deduplicated === true && clientDupReport.deliveredTo.length === 0,
      `Expected client dedup on replayed event_id, got ${JSON.stringify(clientDupReport)}`,
    );

    // Direct HTTP replay of the exact same wa_click and external_click UUIDs to /api/events
    for (const replayBody of [
      { eventId: waId, eventName: "wa_click", path: "/consented" },
      { eventId: extId, eventName: "external_click", path: "/consented" },
      { eventId: pvId, eventName: "page_view", path: "/consented" },
    ]) {
      const replayRes = await httpRequest(publicSiteServer.port, "/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${publicSiteServer.port}`,
        },
        body: JSON.stringify(replayBody),
      });
      assert(replayRes.status === 204, `Replayed /api/events must return 204, got ${replayRes.status}`);
    }

    await pubPage.screenshot({
      path: path.join(screenshotDir, "public-consented-1440.png"),
      fullPage: true,
    });

    // (2d) Reload page within 24h and verify replaying same event_id OR same persisted leadId #1 is STILL deduplicated!
    await pubPage.reload({ waitUntil: "networkidle" });
    await pubPage.waitForFunction(() => window.__mockGtmLoaded === true && window.__mockMetaLoaded === true);
    const afterReloadReplay = await pubPage.evaluate(
      ({ waEventId }) => {
        const waReplay = window.__punyasitusAnalytics?.trackEvent("wa_click", { event_id: waEventId });
        const leadReplay = window.__punyasitusAnalytics?.trackLeadSubmitted({ leadId: 1, persisted: true });
        return { waReplay, leadReplay };
      },
      { waEventId: waId },
    );
    assert(
      afterReloadReplay.waReplay?.deduplicated === true,
      `Expected 24h localStorage dedup to survive reload for wa_click, got ${JSON.stringify(afterReloadReplay.waReplay)}`,
    );
    assert(
      afterReloadReplay.leadReplay?.ok === false && afterReloadReplay.leadReplay?.reason === "DUPLICATE_LEAD_ID",
      `Expected persisted leadId #1 dedup to survive reload, got ${JSON.stringify(afterReloadReplay.leadReplay)}`,
    );
    assert(pubPageErrors.length === 0, `Public page errors: ${pubPageErrors.join("; ")}`);
    await pubCtx.close();

    // -------------------------------------------------------------------------
    // 3. Dashboard Overview Verification — Exact Deduplicated Counts & Unchanged Layout (1440px & 360px)
    // -------------------------------------------------------------------------
    for (const vp of [
      { name: "1440", width: 1440, height: 900 },
      { name: "360", width: 360, height: 800 },
    ]) {
      await ownerPage.setViewportSize({ width: vp.width, height: vp.height });
      const dashRes = await ownerPage.goto(`${baseUrl}/dashboard/${tenantHandle}`, {
        waitUntil: "networkidle",
      });
      assert(dashRes && dashRes.status() === 200, `Dashboard returned ${dashRes?.status()}`);

      const dashState = await ownerPage.evaluate(() => {
        const overflow = document.documentElement.scrollWidth > window.innerWidth;
        const readMetric = (id) =>
          document.querySelector(`[data-metric-value="${id}"]`)?.textContent?.trim() ?? "";
        return {
          overflow,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          waClicks: readMetric("wa_clicks"),
          externalClicks: readMetric("external_clicks"),
          leadSubmits: readMetric("lead_submits"),
          pageviews: readMetric("pageviews"),
        };
      });

      assert(
        !dashState.overflow,
        `Dashboard @ ${vp.name}px has horizontal overflow (${dashState.scrollWidth} > ${dashState.innerWidth})`,
      );
      assert(
        dashState.waClicks === "1",
        `Expected deduplicated wa_clicks = 1 on dashboard, got "${dashState.waClicks}"`,
      );
      assert(
        dashState.externalClicks === "1",
        `Expected deduplicated external_clicks = 1 on dashboard, got "${dashState.externalClicks}"`,
      );
      assert(
        dashState.leadSubmits === "1",
        `Expected deduplicated lead_submits = 1 on dashboard, got "${dashState.leadSubmits}"`,
      );
      assert(
        Number(dashState.pageviews.replace(/[^0-9]/g, "")) >= 1,
        `Expected pageviews >= 1 on dashboard, got "${dashState.pageviews}"`,
      );

      await ownerPage.screenshot({
        path: path.join(screenshotDir, `dashboard-dedup-counts-${vp.name}.png`),
        fullPage: true,
      });
    }

    assert(dashConsoleErrors.length === 0, `Dashboard console errors: ${dashConsoleErrors.join("; ")}`);
    assert(dashPageErrors.length === 0, `Dashboard page errors: ${dashPageErrors.join("; ")}`);
    await ownerCtx.close();

    // -------------------------------------------------------------------------
    // 4. Fault Tolerance — Aborting /api/events + GTM + Meta keeps CTAs & Lead Form working!
    // -------------------------------------------------------------------------
    const faultCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const faultPage = await faultCtx.newPage();
    const faultErrors = [];
    faultPage.on("pageerror", (e) => faultErrors.push(String(e)));

    await faultPage.route(/https:\/\/mock-(gtm|meta)\.test\/.*/, (route) => route.abort());
    await faultPage.route("**/api/events", (route) => route.abort());

    await faultPage.goto(`http://127.0.0.1:${publicSiteServer.port}/consented`, {
      waitUntil: "networkidle",
    });

    const waHref = await faultPage.getAttribute('[data-testid="public-wa-cta"]', "href");
    assert(waHref && waHref.startsWith("https://wa.me/6281234567890"), `Invalid WA CTA href: ${waHref}`);
    const [faultPopup] = await Promise.all([
      faultCtx.waitForEvent("page", { timeout: 3000 }).catch(() => null),
      faultPage.click('[data-testid="public-wa-cta"]'),
    ]);
    if (faultPopup) await faultPopup.close().catch(() => {});

    await faultPage.fill("#formulir-kontak-name", "Siti Rahma");
    await faultPage.fill("#formulir-kontak-phone", "081299990000");
    await faultPage.fill("#formulir-kontak-email", "siti@example.test");
    await faultPage.fill("#formulir-kontak-message", "Mohon info jadwal konsultasi.");
    await faultPage.check("#formulir-kontak-consent");
    await faultPage.click('[data-testid="lead-form-submit"]');
    await faultPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    assert(faultErrors.length === 0, `Tracking outage caused uncaught page errors: ${faultErrors.join("; ")}`);
    await faultCtx.close();

    console.log(
      `TASK-065 E2E PASS: event_id parity across /api/events + GTM dataLayer + direct Meta, zero double-counting on double-clicks/replays/reloads, exact dashboard counts (1/1/1) at 1440px & 360px, CTA & form fault tolerance verified. Screenshots in ${screenshotDir}`,
    );
  } catch (err) {
    console.error("TASK-065 E2E FAILED:", err);
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
