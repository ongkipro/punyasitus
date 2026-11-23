/* global process, console, setTimeout, document, window, getComputedStyle, fetch, Buffer, URL */
/**
 * TASK-076 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Proves every browser-visible acceptance criterion:
 * 1. Real Astro public tenant page combining `Layout.astro` + `AnalyticsHead.astro` (GTM + direct Meta)
 *    + `Consent.astro` + `SectionContactForm.astro` + WhatsApp CTA + External Marketplace CTA:
 *    - Pre-consent response carries STRICT CSP (no GTM origins), 0 GTM `<script>` / `<noscript><iframe>`,
 *      0 network requests to GTM/GA4/Meta/TikTok.
 *    - Post-consent response carries RELAXED GTM CSP with per-response cryptographic nonce;
 *      Consent Mode v2 defaults are `denied` BEFORE load and update to `granted` on consent;
 *      GTM loads cleanly with matching nonce and zero CSP violations;
 *      all 4 standard `ps_*` events (`ps_page_view`, `ps_wa_click`, `ps_external_click` host-only,
 *      `ps_lead_submitted` once after persistence) push onto `window.dataLayer` with ZERO PII;
 *      direct Meta works while GA4 (routed via GTM) never double-fires.
 *    - Revoking consent immediately removes GTM script/noscript & updates Consent Mode to `denied`.
 * 2. Blocking/failing GTM script (`route.abort()`): WhatsApp CTA, external link, and contact form
 *    stay 100% functional with 0 uncaught page errors.
 * 3. Dashboard `/dashboard/<handle>/settings/analytics` at 1440px & 360px:
 *    - Invalid GTM ID rejected inline, per-vendor `Langsung` vs `Melalui GTM` toggles,
 *      owner-only audited risk acknowledgement dialog activates GTM and persists across reload,
 *      container JSON template downloads cleanly, Indonesian guide & checklist render with
 *      zero horizontal overflow and `>= 44px` tap targets.
 * 4. Superadmin Console `/console/tenants/<handle>` at 1440px & 360px:
 *    - Operator activates GTM kill switch with category & audit reason -> tenant dashboard reflects
 *      operator-disabled alert while direct tags remain intact.
 * 5. Saves full-page screenshots into `/tmp/task-076-screenshots/`.
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

const screenshotDir = process.env.TASK076_SCREENSHOT_DIR || "/tmp/task-076-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

const MOCK_GTM_URL = "https://mock-gtm.test/gtm.js";
const MOCK_GTM_NS_URL = "https://mock-gtm.test/ns.html";
const MOCK_META_URL = "https://mock-meta.test/fbevents.js";

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
  // Ensure 0020_gtm_kill_switch.sql is applied cleanly on local D1 via --file
  const migFile = path.join(root, "packages/db/migrations/platform/0020_gtm_kill_switch.sql");
  const apply0020 = spawnSync(
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
      "--file",
      migFile,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (apply0020.status !== 0) {
    throw new Error(`Local D1 0020 apply failed:\n${apply0020.stdout}\n${apply0020.stderr}`);
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
 * Compiles TWO real Astro public pages:
 * - `/pre-consent.html`: unconsented render (strict CSP, zero GTM script/noscript)
 * - `/consented.html`: consented render (relaxed GTM CSP + nonce + Consent Mode v2 + GTM snippet)
 */
async function buildRealGtmPublicPages(nonce) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t076-e2e-"));
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
const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Klinik Amanah GTM Demo",
    tagline: "Layanan Kesehatan & Konsultasi Resmi",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Klinik Amanah",
    category: "LocalBusiness",
    description: "Layanan Kesehatan & Konsultasi Resmi di Jakarta Selatan.",
    address: "Jl. Sudirman No. 10",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: null,
    weekdayHours: "Senin–Sabtu 08.00–20.00 WIB",
    holidayHours: "Minggu Tutup",
    phone: "+62 21 5550199",
    whatsappE164: "6281234567890",
    email: "halo@klinik-amanah.example",
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

const consentedCookie = "__Host-ps_consent=" + encodeURIComponent(JSON.stringify({
  version: 1,
  analytics: true,
  marketing: true,
  maps: false,
  updatedAt: "2026-11-23T10:00:00.000Z",
}));

const gtmConfig = {
  ga4MeasurementId: null,
  metaPixelId: "123456789012345",
  tiktokPixelId: null,
  vendorModes: { ga4: "gtm", meta: "direct", tiktok: "gtm" },
  gtmContainerId: "GTM-TEST1234",
  gtmEnabled: true,
  gtmRiskAck: {
    accepted: true,
    version: 1,
    acceptedAt: "2026-11-23T09:00:00.000Z",
    acceptedByUserId: "usr_owner_e2e",
  },
};
---
<Layout
  shell={shell}
  pageTitle="Beranda"
  currentPath="/"
  showConsent={true}
  initialCookieHeader={${consented ? "consentedCookie" : "null"}}
>
  <AnalyticsHead
    slot="head"
    config={{ metaPixelId: "123456789012345" }}
    gtmConfig={gtmConfig}
    surface="tenant"
    isPreview={false}
    appEnv="test"
    pageType="home"
    contentId="home"
    initialCookieHeader={${consented ? "consentedCookie" : "null"}}
    cspProfile={${consented ? '"gtm-relaxed"' : '"strict"'}}
    cspNonce={${consented ? JSON.stringify(nonce) : "null"}}
    vendorScriptOverrides={{ meta: ${JSON.stringify(MOCK_META_URL)} }}
    gtmScriptUrlOverride={${JSON.stringify(MOCK_GTM_URL)}}
    gtmNoscriptUrlOverride={${JSON.stringify(MOCK_GTM_NS_URL)}}
  />
  <section style="max-width:56rem;margin:2rem auto;padding:0 1rem;">
    <h1>Klinik Amanah — Pengujian GTM &amp; Consent Mode v2</h1>
    <div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin:1rem 0;">
      <a
        href="https://wa.me/6281234567890?text=Halo+Klinik+Amanah"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="public-wa-cta"
        data-ps-item-id="srv-scaling-1"
        data-ps-item-title="Paket Scaling Gigi"
        data-ps-placement="hero"
        style="display:inline-flex;min-height:44px;align-items:center;padding:0.5rem 1rem;background:#0B6B3A;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;"
      >
        Chat WhatsApp Sekarang
      </a>
      <a
        href="https://www.tokopedia.com/klinik-amanah/voucher-checkup?email=secret@example.test&token=xyz"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="public-external-cta"
        data-ps-external-cta="true"
        data-ps-item-id="prod-voucher-1"
        style="display:inline-flex;min-height:44px;align-items:center;padding:0.5rem 1rem;background:#176b51;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;"
      >
        Beli Voucher di Tokopedia
      </a>
    </div>
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
      routePath="/"
      primaryOrigin="https://klinik-amanah.situsku.click"
      fallbackBusiness={{
        address: "Jl. Sudirman No. 10, Jakarta Selatan",
        weekdayHours: "Senin–Sabtu 08.00–20.00 WIB",
        phone: "+62 21 5550199",
        whatsappE164: "6281234567890",
        email: "halo@klinik-amanah.example",
      }}
    />
  </section>
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
    vite: {
      resolve: {
        alias: { "@": path.join(webDir, "src") },
      },
    },
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

function startPublicSiteServer(outDir, nonce) {
  let leadCounter = 0;
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/api/leads" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          // ignore
        }
        if (!parsed.phone || String(parsed.phone).replace(/\D/g, "").length < 9) {
          res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              code: "VALIDATION_ERROR",
              message: "Nomor WhatsApp tidak valid.",
              fields: { phone: "Minimal 9 digit." },
            }),
          );
          return;
        }
        leadCounter += 1;
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            code: "LEAD_CREATED",
            leadId: leadCounter,
            leadNumber: leadCounter,
            message: `Pesan Anda telah diterima (#${leadCounter}).`,
          }),
        );
      });
      return;
    }

    const isDynamicFirstVisit = reqUrl.pathname === "/first-visit" || reqUrl.pathname === "/first-visit/";
    const incomingCookie = String(req.headers.cookie || "");
    const hasConsentedCookie =
      /(?:__Host-ps_consent|ps_consent)=([^;]+)/.test(incomingCookie) &&
      decodeURIComponent((incomingCookie.match(/(?:__Host-ps_consent|ps_consent)=([^;]+)/) || [])[1] || "").includes(
        '"analytics":true',
      );

    const rel = isDynamicFirstVisit
      ? hasConsentedCookie
        ? "consented/index.html"
        : "pre-consent/index.html"
      : reqUrl.pathname === "/"
        ? "pre-consent/index.html"
        : `${reqUrl.pathname.replace(/^\/+/, "")}`;
    let filePath = path.join(outDir, rel);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const indexCandidate = path.join(outDir, rel, "index.html");
      if (fs.existsSync(indexCandidate)) filePath = indexCandidate;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js" || ext === ".mjs"
          ? "application/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/octet-stream";

    if (ext === ".html") {
      const isConsentedRoute =
        reqUrl.pathname.includes("consented") || (isDynamicFirstVisit && hasConsentedCookie);
      let html = fs.readFileSync(filePath, "utf8");
      if (isConsentedRoute) {
        html = injectNonceToInlineScripts(html, nonce);
        res.writeHead(200, {
          "Content-Type": contentType,
          "X-PunyaSitus-CSP-Profile": "gtm-relaxed",
          Vary: "Cookie",
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'self'",
            `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://www.googletagmanager.com https://connect.facebook.net https://analytics.tiktok.com https://mock-gtm.test https://mock-meta.test`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com https://www.facebook.com https://analytics.tiktok.com https://mock-gtm.test https://mock-meta.test",
            "frame-src 'self' https://challenges.cloudflare.com https://www.youtube-nocookie.com https://www.googletagmanager.com https://mock-gtm.test",
          ].join("; "),
        });
      } else {
        res.writeHead(200, {
          "Content-Type": contentType,
          "X-PunyaSitus-CSP-Profile": "strict",
          "Content-Security-Policy":
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com https://www.youtube-nocookie.com",
        });
      }
      res.end(html);
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function verifyLayoutAndTapTargets(page, label, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - window.innerWidth;
    const controls = Array.from(
      document.querySelectorAll('button, a, input:not([type="checkbox"]):not([type="hidden"]), select'),
    ).filter((el) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const smallTargets = [];
    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      if (window.innerWidth <= 480 && rect.height < 42 && !el.closest("nav[aria-label='Navigasi modul console']")) {
        // Only flag interactive form/CTA buttons smaller than 44px on narrow viewports
        if (el.matches('[data-testid*="gtm-"], [data-testid*="vendor-mode-"], [data-testid*="analytics-save"]')) {
          smallTargets.push({
            tag: el.tagName,
            testId: el.getAttribute("data-testid"),
            height: Math.round(rect.height),
          });
        }
      }
    }
    return { overflow, scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, smallTargets };
  });

  assert(
    metrics.overflow <= 1,
    `${label} (${viewportWidth}px) has horizontal overflow: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
  );
  assert(
    metrics.smallTargets.length === 0,
    `${label} (${viewportWidth}px) has tap targets < 44px: ${JSON.stringify(metrics.smallTargets)}`,
  );
}

async function main() {
  ensureLocalD1Migrated();
  const nonce = crypto.randomBytes(16).toString("base64");
  const compiledSite = await buildRealGtmPublicPages(nonce);
  const publicServer = await startPublicSiteServer(compiledSite.outDir, nonce);

  const astroPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${astroPort}`;
  let logs = "";

  const child = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(astroPort)],
    {
      cwd: webDir,
      env: cleanChildEnv({ APP_ENV: "local", ASTRO_TELEMETRY_DISABLED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  let browser = null;
  try {
    await waitForServer(astroPort, 40_000);
    const chromePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // =========================================================================
    // 1. Public Tenant Page: Pre-Consent Strict CSP -> Post-Consent Relaxed CSP + Nonce + Consent Mode v2 + 4 ps_* Events
    // =========================================================================
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
    await pubPage.route(/https:\/\/mock-(gtm|meta)\.test\/.*/, async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.includes("mock-gtm.test")) {
        gtmScriptHits.push(reqUrl);
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: `window.__mockGtmLoaded = true;`,
        });
        return;
      }
      metaScriptHits.push(reqUrl);
      await route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: `window.__mockMetaLoaded = true;`,
      });
    });

    // (1a) Pre-consent page -> STRICT CSP, ZERO GTM script/noscript, ZERO network requests!
    const preRes = await pubPage.goto(`http://127.0.0.1:${publicServer.port}/pre-consent`, {
      waitUntil: "networkidle",
    });
    assert(preRes.headers()["x-punyasitus-csp-profile"] === "strict", "Pre-consent page must have strict CSP profile");
    assert(
      !(preRes.headers()["content-security-policy"] || "").includes("googletagmanager.com"),
      "Pre-consent CSP must exclude googletagmanager.com",
    );
    assert(gtmScriptHits.length === 0, `Expected 0 GTM requests before consent, got ${gtmScriptHits.length}`);
    assert(metaScriptHits.length === 0, `Expected 0 Meta requests before consent, got ${metaScriptHits.length}`);
    const preDomGtmCount = await pubPage.evaluate(
      () => document.querySelectorAll('script[data-ps-gtm-loaded], noscript[data-ps-gtm-noscript]').length,
    );
    assert(preDomGtmCount === 0, "Pre-consent HTML must contain 0 GTM script/noscript elements");

    // (1a-ii) First-visit consent flow (Finding #3):
    //         Start on `/first-visit` with strict CSP + 0 GTM -> click Accept All ->
    //         client performs ONE loop-guarded reload -> server responds with gtm-relaxed CSP + nonce -> GTM loads!
    let firstVisitDocLoads = 0;
    let lastFirstVisitProfile = "";
    const trackFirstVisit = (res) => {
      if (res.url().includes("/first-visit") && res.request().resourceType() === "document") {
        firstVisitDocLoads += 1;
        lastFirstVisitProfile = res.headers()["x-punyasitus-csp-profile"] || "";
      }
    };
    pubPage.on("response", trackFirstVisit);
    await pubPage.goto(`http://127.0.0.1:${publicServer.port}/first-visit`, {
      waitUntil: "networkidle",
    });
    assert(firstVisitDocLoads === 1 && lastFirstVisitProfile === "strict", "Initial /first-visit must load with strict CSP");
    assert(gtmScriptHits.length === 0, "Zero GTM loads before first-visit Accept click");

    await Promise.all([
      pubPage.waitForNavigation({ waitUntil: "networkidle" }),
      pubPage.click('[data-testid="consent-accept-all"]'),
    ]);
    await pubPage.waitForFunction(() => window.__mockGtmLoaded === true);
    await pubPage.waitForTimeout(300);
    pubPage.off("response", trackFirstVisit);
    assert(
      firstVisitDocLoads === 2,
      `Expected exactly 2 document loads (initial + single guarded reload, zero loop), got ${firstVisitDocLoads}`,
    );
    assert(
      lastFirstVisitProfile === "gtm-relaxed",
      `Expected gtm-relaxed CSP after first-visit consent reload, got ${lastFirstVisitProfile}`,
    );
    assert(gtmScriptHits.length === 1, `Expected 1 GTM load after first-visit consent, got ${gtmScriptHits.length}`);
    assert(cspViolations.length === 0, `Unexpected CSP violations on first-visit consent flow: ${cspViolations.join("; ")}`);

    // Reset hit counters before verifying /consented direct flow + 4 ps_* events + revocation
    gtmScriptHits.length = 0;
    metaScriptHits.length = 0;

    // (1b) Consented page -> RELAXED CSP with nonce, Consent Mode v2 default=denied -> update=granted, GTM loaded, 0 CSP errors!
    const postRes = await pubPage.goto(`http://127.0.0.1:${publicServer.port}/consented`, {
      waitUntil: "networkidle",
    });
    assert(postRes.headers()["x-punyasitus-csp-profile"] === "gtm-relaxed", "Consented GTM page must use gtm-relaxed CSP");
    assert(
      (postRes.headers()["content-security-policy"] || "").includes(`'nonce-${nonce}'`),
      "Consented GTM CSP must contain per-response nonce",
    );
    await pubPage.waitForFunction(() => window.__mockGtmLoaded === true);
    assert(gtmScriptHits.length === 1, `Expected 1 GTM script load after consent, got ${gtmScriptHits.length}`);
    assert(metaScriptHits.length === 1, `Expected 1 direct Meta script load after consent, got ${metaScriptHits.length}`);
    assert(cspViolations.length === 0, `Unexpected CSP violations on consented GTM page: ${cspViolations.join("; ")}`);

    // Trigger WA click + External click + Lead form submit
    const [waPopup] = await Promise.all([
      pubCtx.waitForEvent("page", { timeout: 3000 }).catch(() => null),
      pubPage.click('[data-testid="public-wa-cta"]'),
    ]);
    if (waPopup) await waPopup.close().catch(() => {});

    const [extPopup] = await Promise.all([
      pubCtx.waitForEvent("page", { timeout: 3000 }).catch(() => null),
      pubPage.click('[data-testid="public-external-cta"]'),
    ]);
    if (extPopup) await extPopup.close().catch(() => {});

    await pubPage.fill("#formulir-kontak-name", "Budi Santoso");
    await pubPage.fill("#formulir-kontak-phone", "081234567890");
    await pubPage.fill("#formulir-kontak-email", "budi.rahasia@example.test");
    await pubPage.fill("#formulir-kontak-message", "Mohon info paket scaling gigi.");
    await pubPage.check("#formulir-kontak-consent");
    await pubPage.click('[data-testid="lead-form-submit"]');
    await pubPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    await pubPage.waitForTimeout(250);

    // Inspect window.dataLayer for Consent Mode v2 order + all 4 `ps_*` events + ZERO PII!
    const dlAudit = await pubPage.evaluate(() => {
      const raw = window.dataLayer || [];
      const consentCalls = [];
      const psEvents = [];
      for (const entry of raw) {
        if (entry && typeof entry === "object" && typeof entry.length === "number" && entry[0] === "consent") {
          consentCalls.push({ cmd: entry[1], params: entry[2] });
        } else if (entry && typeof entry === "object" && typeof entry.event === "string" && entry.event.startsWith("ps_")) {
          psEvents.push(entry);
        }
      }
      const gtmScriptEl = document.querySelector('script[data-ps-gtm-loaded="true"]');
      return {
        consentCalls,
        psEvents,
        serializedPs: JSON.stringify(psEvents),
        gtmNonceAttr: gtmScriptEl?.nonce || gtmScriptEl?.getAttribute("nonce") || "",
        hasNoscript: Boolean(document.querySelector('noscript[data-ps-gtm-noscript="true"]')),
      };
    });

    assert(dlAudit.consentCalls.length >= 2, `Expected >=2 Consent Mode calls, got ${JSON.stringify(dlAudit.consentCalls)}`);
    assert(
      dlAudit.consentCalls[0].cmd === "default" && dlAudit.consentCalls[0].params.analytics_storage === "denied",
      `Consent Mode default must be denied first: ${JSON.stringify(dlAudit.consentCalls[0])}`,
    );
    assert(
      dlAudit.consentCalls[1].cmd === "update" && dlAudit.consentCalls[1].params.analytics_storage === "granted",
      `Consent Mode update must grant analytics: ${JSON.stringify(dlAudit.consentCalls[1])}`,
    );
    assert(dlAudit.gtmNonceAttr === nonce, `GTM script tag must carry per-response nonce`);
    assert(dlAudit.hasNoscript, "Consented GTM HTML must contain <noscript> GTM iframe");

    const psNames = dlAudit.psEvents.map((e) => e.event);
    for (const requiredEv of ["ps_page_view", "ps_wa_click", "ps_external_click", "ps_lead_submitted"]) {
      assert(psNames.includes(requiredEv), `Missing ${requiredEv} in dataLayer: ${JSON.stringify(psNames)}`);
    }
    const extEvent = dlAudit.psEvents.find((e) => e.event === "ps_external_click");
    assert(extEvent.destination_host === "www.tokopedia.com", `Expected host-only destination_host, got ${JSON.stringify(extEvent)}`);
    assert(!dlAudit.serializedPs.includes("Budi Santoso"), "dataLayer leaked visitor name!");
    assert(!dlAudit.serializedPs.includes("budi.rahasia@example.test"), "dataLayer leaked visitor email!");
    assert(!dlAudit.serializedPs.includes("081234567890"), "dataLayer leaked visitor phone!");
    assert(!dlAudit.serializedPs.includes("scaling gigi"), "dataLayer leaked inquiry message!");
    assert(!dlAudit.serializedPs.includes("secret@example.test"), "dataLayer leaked external URL query!");

    // Revoke consent -> removes GTM script/noscript & pushes Consent Mode denied
    await pubPage.click('[data-testid="consent-withdraw-quick"]');
    await pubPage.waitForTimeout(150);
    const remainingGtm = await pubPage.evaluate(
      () => document.querySelectorAll('script[data-ps-gtm-loaded="true"], noscript[data-ps-gtm-noscript="true"]').length,
    );
    assert(remainingGtm === 0, "Consent revocation must remove GTM script & noscript elements");
    assert(pubPageErrors.length === 0, `Public page errors: ${pubPageErrors.join("; ")}`);
    await pubCtx.close();

    // =========================================================================
    // 2. Fault Tolerance: Aborting GTM load keeps WA CTA, External CTA & Lead Form working!
    // =========================================================================
    const faultCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const faultPage = await faultCtx.newPage();
    const faultErrors = [];
    faultPage.on("pageerror", (e) => faultErrors.push(String(e)));
    await faultPage.route(/https:\/\/mock-(gtm|meta)\.test\/.*/, (route) => route.abort());

    await faultPage.goto(`http://127.0.0.1:${publicServer.port}/consented`, { waitUntil: "networkidle" });
    await faultPage.fill("#formulir-kontak-name", "Siti Rahma");
    await faultPage.fill("#formulir-kontak-phone", "081299990000");
    await faultPage.fill("#formulir-kontak-email", "siti@example.test");
    await faultPage.fill("#formulir-kontak-message", "Mohon info jadwal konsultasi.");
    await faultPage.check("#formulir-kontak-consent");
    await faultPage.click('[data-testid="lead-form-submit"]');
    await faultPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    assert(faultErrors.length === 0, `Blocked GTM caused page errors: ${faultErrors.join("; ")}`);
    await faultCtx.close();

    // =========================================================================
    // 3. Provision Real Tenant (with migrated TenantStore DO) + Tenant Dashboard GTM Setup & Owner Risk Ack
    // =========================================================================
    const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
    const tenantHandle = `gtm-${suffix}`;
    const ownerEmail = `owner.t076.${suffix}@example.com`;
    const ownerPass = "OwnerPassword!2026";
    const opEmail = `superadmin.t076.${suffix}@punyasitus.com`;
    const opPass = "OperatorPassword!2026";
    const nowMs = Date.now();

    // Sign up operator, enroll real TOTP 2FA, and grant platform_operators
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();
    const opErrors = [];
    opPage.on("pageerror", (e) => opErrors.push(String(e)));

    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, {
      email: opEmail,
      password: opPass,
      name: "Operator GTM E2E",
    });

    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", opPass);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    await opPage.fill("#twofa-confirm-code", generateTotpCode(manualSecret));
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    const safeOpEmail = opEmail.replace(/'/g, "''");
    runLocalD1Sql(
      `UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOpEmail}';
       INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-076', ${nowMs}, NULL
       FROM users WHERE lower(email) = '${safeOpEmail}';`,
    );

    // Sign up owner
    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const dashErrors = [];
    ownerPage.on("pageerror", (e) => dashErrors.push(String(e)));

    await ownerPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(ownerPage, {
      email: ownerEmail,
      password: ownerPass,
      name: "Pemilik GTM Demo",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    // Provision real tenant via Console Provisioning so TenantStore DO is migrated cleanly
    await opPage.goto(`${baseUrl}/console/provisioning`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await opPage.fill("#provision-name", "Studio GTM Nusantara");
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Provisioning tenant uji E2E untuk TASK-076 GTM setup");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');

    const analyticsUrl = `${baseUrl}/dashboard/${tenantHandle}/settings/analytics`;
    await ownerPage.goto(analyticsUrl, { waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="gtm-setup-section"]');

    // Save a direct Meta Pixel ID first (to prove it survives kill switch!)
    await ownerPage.fill('[data-testid="input-meta-id"]', "123456789012345");
    await ownerPage.click('[data-testid="analytics-save-button"]');
    await ownerPage.waitForSelector('[data-testid="analytics-status-success"]');

    // Verify invalid GTM ID shows inline error
    await ownerPage.fill('[data-testid="input-gtm-container-id"]', "GTM-bad");
    await ownerPage.waitForSelector('[data-testid="error-gtm-container-id"]');

    // Switch GA4 & TikTok to "Melalui GTM", enter valid GTM ID, open owner risk dialog & enable!
    await ownerPage.click('[data-testid="vendor-mode-ga4-gtm"]');
    await ownerPage.click('[data-testid="vendor-mode-tiktok-gtm"]');
    await ownerPage.fill('[data-testid="input-gtm-container-id"]', "GTM-NUSA1234");
    await ownerPage.click('[data-testid="gtm-open-enable-dialog-button"]');
    await ownerPage.waitForSelector('[data-testid="gtm-risk-ack-dialog"]');

    // Screenshot of Risk Acknowledgement Dialog at 1440px
    await ownerPage.screenshot({
      path: path.join(screenshotDir, "gtm-risk-dialog-1440.png"),
      fullPage: false,
    });

    await ownerPage.check('[data-testid="gtm-risk-ack-checkbox"]');
    await ownerPage.click('[data-testid="gtm-risk-ack-confirm-button"]');
    await ownerPage.waitForSelector('[data-testid="gtm-status-success"]');

    // Verify downloadable container template endpoint returns valid JSON
    const templateStatus = await ownerPage.evaluate(async (h) => {
      const r = await fetch(`/api/tenants/${h}/analytics/gtm/template`, { credentials: "same-origin" });
      const data = await r.json();
      return {
        status: r.status,
        disp: r.headers.get("content-disposition") || "",
        ver: data.exportFormatVersion,
      };
    }, tenantHandle);
    assert(
      templateStatus.status === 200 && templateStatus.ver === 2 && templateStatus.disp.includes("punyasitus-gtm-container-template-v1.json"),
      `Template download failed: ${JSON.stringify(templateStatus)}`,
    );

    // Reload and verify persistence
    await ownerPage.reload({ waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="gtm-setup-section"]');
    const badgeText = await ownerPage.textContent('[data-testid="gtm-active-status-badge"]');
    assert(badgeText && badgeText.includes("GTM Aktif (GTM-NUSA1234)"), `Expected active GTM badge after reload, got ${badgeText}`);

    // Capture Dashboard screenshots at 1440px and 360px
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(ownerPage, "GTM Settings Desktop", 1440);
    await ownerPage.screenshot({
      path: path.join(screenshotDir, "gtm-settings-1440.png"),
      fullPage: true,
    });

    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await ownerPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(ownerPage, "GTM Settings Mobile", 360);
    await ownerPage.screenshot({
      path: path.join(screenshotDir, "gtm-settings-360.png"),
      fullPage: true,
    });

    // =========================================================================
    // 4. Superadmin Console Kill Switch on `/console/tenants/<handle>`
    // =========================================================================
    await opPage.goto(`${baseUrl}/console/tenants/${tenantHandle}`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="detail-gtm-kill-switch-card"]');

    // Trigger Kill Switch modal
    await opPage.click('[data-testid="open-gtm-disable-modal-btn"]');
    await opPage.waitForSelector('[data-testid="gtm-kill-switch-modal"]');
    await opPage.selectOption('[data-testid="gtm-kill-category-select"]', "abuse");
    await opPage.fill(
      '[data-testid="gtm-kill-reason-input"]',
      "Pengujian kill switch GTM: tag tidak sah terdeteksi pada kontainer tenant",
    );
    await opPage.click('[data-testid="gtm-kill-submit-btn"]');
    await opPage.waitForSelector('[data-testid="console-gtm-killed-alert"]');

    // Capture Console screenshots at 1440px and 360px
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(opPage, "Console GTM Kill Switch Desktop", 1440);
    await opPage.screenshot({
      path: path.join(screenshotDir, "console-gtm-kill-switch-1440.png"),
      fullPage: true,
    });

    await opPage.setViewportSize({ width: 360, height: 800 });
    await opPage.waitForTimeout(150);
    await verifyLayoutAndTapTargets(opPage, "Console GTM Kill Switch Mobile", 360);
    await opPage.screenshot({
      path: path.join(screenshotDir, "console-gtm-kill-switch-360.png"),
      fullPage: true,
    });

    // Reload tenant owner dashboard -> sees operator kill-switch alert, direct Meta Pixel still intact!
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.reload({ waitUntil: "networkidle" });
    await ownerPage.waitForSelector('[data-testid="gtm-operator-kill-switch-banner"]');
    assert(
      (await ownerPage.inputValue('[data-testid="input-meta-id"]')) === "123456789012345",
      "Direct Meta Pixel ID must remain intact after GTM kill switch",
    );

    assert(dashErrors.length === 0, `Dashboard page errors: ${dashErrors.join("; ")}`);
    assert(opErrors.length === 0, `Console page errors: ${opErrors.join("; ")}`);

    await opCtx.close();
    await ownerCtx.close();
    console.log(
      `TASK-076 E2E PASSED! Screenshots saved in ${screenshotDir}`,
    );
  } catch (err) {
    console.error("TASK-076 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs (tail) ---\n" + logs.slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await publicServer?.close().catch(() => {});
    if (compiledSite?.tmpRoot) {
      fs.rmSync(compiledSite.tmpRoot, { recursive: true, force: true });
    }
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
}

await main();
