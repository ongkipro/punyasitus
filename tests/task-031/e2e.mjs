/* global process, console, document, window, getComputedStyle, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_POLICY_VERSION,
  parseConsentCookie,
  validateTenantSetCookieHeader,
} from "../../apps/web/src/core/privacy.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractConsentComponentAssets() {
  const consentAstroPath = path.join(webDir, "src/components/Consent.astro");
  const source = fs.readFileSync(consentAstroPath, "utf8");
  const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
  const scriptMatch = source.match(/<script\s+is:inline>([\s\S]*?)<\/script>/);
  assert(styleMatch && styleMatch[1].trim().length > 0, "Consent.astro must contain <style>");
  assert(
    scriptMatch && scriptMatch[1].trim().length > 0,
    "Consent.astro must contain <script is:inline>",
  );
  // Mirror Astro's scoped :global(...) unwrap when serving extracted CSS directly
  const css = styleMatch[1].replace(/:global\(([^)]+)\)/g, "$1");
  const script = scriptMatch[1];
  return { css, script };
}

function renderFixtureHtml({ baseUrl, cookieHeader, submittedLead, css, script }) {
  const initialState = parseConsentCookie(cookieHeader, {
    expectedVersion: CONSENT_POLICY_VERSION,
    cookieName: CONSENT_COOKIE_NAME,
  });
  const { hasDecision, preferences } = initialState;

  const activeLabels = [];
  if (preferences.analytics) activeLabels.push("Analitik");
  if (preferences.marketing) activeLabels.push("Pemasaran");
  if (preferences.maps) activeLabels.push("Peta");

  const initialSummaryText = hasDecision
    ? activeLabels.length > 0
      ? `Izin aktif: ${activeLabels.join(", ")}`
      : "Hanya fitur esensial (pelacak opsional ditolak)"
    : "Belum ada pilihan izin (pelacak opsional tidak dimuat)";

  const analyticsSrc = `${baseUrl}/mock-vendor/analytics.js`;
  const marketingSrc = `${baseUrl}/mock-vendor/marketing.js`;
  const mapEmbedUrl = `${baseUrl}/mock-maps/embed`;

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Klinik Gigi Sehat — Uji Privasi TASK-031</title>
  <style>
    body {
      margin: 0;
      padding: 1rem 1rem 9rem;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #f8faf9;
      color: #182522;
      line-height: 1.5;
    }
    main {
      max-width: 56rem;
      margin: 0 auto;
    }
    .demo-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }
    .demo-card {
      background: #ffffff;
      border: 1px solid #d9e2dd;
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
    }
    .demo-wa {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0.625rem 1rem;
      border-radius: 6px;
      background: #0b6b3a;
      color: #ffffff;
      font-weight: 600;
      text-decoration: none;
    }
    .demo-input {
      width: 100%;
      max-width: 28rem;
      min-height: 44px;
      padding: 0.5rem 0.75rem;
      border: 1px solid #d9e2dd;
      border-radius: 6px;
      font-size: 1rem;
      margin-top: 0.25rem;
      display: block;
    }
    .demo-submit {
      min-height: 44px;
      padding: 0.625rem 1rem;
      border-radius: 6px;
      border: 0;
      background: #176b51;
      color: #ffffff;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.75rem;
    }
    ${css}
  </style>
</head>
<body>
  <main>
    <nav class="demo-nav" aria-label="Navigasi utama">
      <a href="#kontak">Hubungi Kami</a>
      <a href="#lokasi">Lokasi Klinik</a>
      <a
        href="https://wa.me/6281200001234?text=Halo%20Klinik%20Gigi%20Sehat"
        target="_blank"
        rel="noopener noreferrer"
        class="demo-wa"
        data-testid="demo-wa-link"
      >
        Chat WhatsApp
      </a>
    </nav>

    <section id="kontak" class="demo-card">
      <h1>Klinik Gigi Sehat Jakarta</h1>
      <p>Formulir konsultasi dan tautan WhatsApp tetap berfungsi tanpa pelacak opsional.</p>
      ${
        submittedLead
          ? `<div role="status" data-testid="lead-form-success">Terima kasih, pesan Anda telah diterima.</div>`
          : ""
      }
      <form method="POST" action="/api/lead-demo" data-testid="demo-lead-form">
        <label for="lead-name">Nama Lengkap</label>
        <input id="lead-name" name="name" class="demo-input" required value="Siti Rahma" />
        <button type="submit" class="demo-submit" data-testid="demo-lead-submit">
          Kirim Pesan
        </button>
      </form>
    </section>

    <div id="lokasi">
      <div
        class="ps-privacy-root"
        data-ps-consent-root
        data-cookie-name="${CONSENT_COOKIE_NAME}"
        data-policy-version="${CONSENT_POLICY_VERSION}"
        data-max-age="${CONSENT_MAX_AGE_SECONDS}"
        data-initial-state="${escapeHtml(JSON.stringify(initialState))}"
      >
        <section class="ps-map-card" aria-labelledby="ps-map-heading" data-testid="consent-map-region">
          <div class="ps-map-header">
            <div>
              <h2 id="ps-map-heading" class="ps-map-title">Lokasi Klinik Gigi Sehat</h2>
              <p class="ps-map-address">Jl. Sudirman No. 10, Jakarta Selatan</p>
            </div>
            <a
              href="https://maps.google.com/?q=-6.2088,106.8456"
              target="_blank"
              rel="noopener noreferrer"
              class="ps-btn ps-btn-secondary"
              data-testid="consent-map-fallback-link"
            >
              Buka di Peta Eksternal
            </a>
          </div>

          <div class="ps-map-placeholder" data-testid="consent-map-placeholder" ${preferences.maps ? "hidden" : ""}>
            <p class="ps-map-notice">
              Peta interaktif belum dimuat untuk menjaga privasi Anda. Anda tetap dapat membuka lokasi
              melalui tautan di atas tanpa memuat skrip pihak ketiga, atau aktifkan izin Peta di bawah.
            </p>
            <button
              type="button"
              class="ps-btn ps-btn-primary"
              data-action="enable-maps"
              data-testid="consent-enable-maps"
            >
              Izinkan &amp; muat peta interaktif
            </button>
          </div>

          <div
            class="ps-map-embed-slot"
            data-testid="consent-map-embed-slot"
            data-map-embed-url="${escapeHtml(mapEmbedUrl)}"
            data-map-title="Lokasi Klinik Gigi Sehat"
            ${preferences.maps ? "" : "hidden"}
          ></div>
        </section>

        <template
          data-consent-slot="vendor"
          data-consent-category="analytics"
          data-vendor-id="ga4-demo"
          data-vendor-src="${escapeHtml(analyticsSrc)}"
          data-vendor-label="Analitik"
        ></template>
        <template
          data-consent-slot="vendor"
          data-consent-category="marketing"
          data-vendor-id="meta-demo"
          data-vendor-src="${escapeHtml(marketingSrc)}"
          data-vendor-label="Pemasaran"
        ></template>

        <aside
          class="ps-consent-dock-bar"
          aria-label="Kontrol privasi"
          data-testid="consent-manage-bar"
          ${hasDecision ? "" : "hidden"}
        >
          <span class="ps-consent-summary" data-testid="consent-status-summary" aria-live="polite">
            ${escapeHtml(initialSummaryText)}
          </span>
          <div class="ps-consent-bar-actions">
            <button
              type="button"
              class="ps-btn ps-btn-secondary"
              data-action="open-preferences"
              data-testid="consent-manage-trigger"
            >
              Ubah / cabut izin privasi
            </button>
            <button
              type="button"
              class="ps-btn ps-btn-danger"
              data-action="withdraw-consent"
              data-testid="consent-withdraw-quick"
              ${preferences.analytics || preferences.marketing || preferences.maps ? "" : "hidden"}
            >
              Cabut izin
            </button>
          </div>
        </aside>

        <section
          class="ps-consent-banner"
          role="region"
          aria-labelledby="ps-consent-banner-title"
          data-testid="consent-banner"
          ${hasDecision ? "hidden" : ""}
        >
          <div class="ps-consent-banner-body">
            <h2 id="ps-consent-banner-title" class="ps-consent-heading">
              Privasi &amp; Preferensi Cookie
            </h2>
            <p class="ps-consent-copy">
              Klinik Gigi Sehat menggunakan fitur esensial agar formulir, navigasi, dan tautan WhatsApp
              berjalan baik. Pelacak analitik, pemasaran, dan peta interaktif hanya dimuat jika Anda
              memberi izin.
              <a href="/kebijakan-privasi" class="ps-consent-link">Baca Kebijakan Privasi</a>
            </p>
            <noscript>
              <p class="ps-consent-noscript" data-testid="consent-noscript-note">
                JavaScript tidak aktif: hanya fitur esensial yang berjalan. Pelacak opsional dan peta
                interaktif tidak dimuat; formulir kontak, tautan peta eksternal, dan WhatsApp tetap dapat
                digunakan.
              </p>
            </noscript>
          </div>
          <div class="ps-consent-actions">
            <button type="button" class="ps-btn ps-btn-primary" data-action="accept-all" data-testid="consent-accept-all">
              Terima semua
            </button>
            <button type="button" class="ps-btn ps-btn-secondary" data-action="reject-optional" data-testid="consent-reject-optional">
              Tolak opsional
            </button>
            <button type="button" class="ps-btn ps-btn-ghost" data-action="open-preferences" data-testid="consent-customize">
              Atur preferensi
            </button>
          </div>
        </section>

        <div class="ps-consent-backdrop" data-testid="consent-preferences-backdrop" hidden>
          <div
            class="ps-consent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ps-consent-dialog-title"
            data-testid="consent-preferences-dialog"
            tabindex="-1"
          >
            <div class="ps-dialog-header">
              <h2 id="ps-consent-dialog-title" class="ps-consent-heading">Pengaturan Izin Privasi</h2>
              <button
                type="button"
                class="ps-btn ps-btn-ghost ps-dialog-close"
                data-action="close-preferences"
                data-testid="consent-dialog-close"
                aria-label="Tutup pengaturan privasi"
              >
                Tutup
              </button>
            </div>
            <p class="ps-consent-copy">
              Pilih kategori opsional yang Anda izinkan. Anda dapat mengubah atau mencabut izin kapan saja.
            </p>
            <form class="ps-consent-form" data-consent-form>
              <fieldset class="ps-consent-fieldset">
                <legend class="ps-sr-only">Kategori cookie dan layanan pihak ketiga</legend>
                <label class="ps-consent-option ps-consent-option-locked">
                  <input type="checkbox" checked disabled />
                  <span>
                    <strong>Esensial (selalu aktif)</strong>
                    <small>Diperlukan untuk formulir, navigasi, dan keamanan dasar situs.</small>
                  </span>
                </label>
                <label class="ps-consent-option">
                  <input type="checkbox" name="analytics" ${preferences.analytics ? "checked" : ""} data-testid="consent-toggle-analytics" />
                  <span>
                    <strong>Analitik pengunjung</strong>
                    <small>Memuat skrip analitik pihak ketiga.</small>
                  </span>
                </label>
                <label class="ps-consent-option">
                  <input type="checkbox" name="marketing" ${preferences.marketing ? "checked" : ""} data-testid="consent-toggle-marketing" />
                  <span>
                    <strong>Pemasaran &amp; piksel iklan</strong>
                    <small>Memuat piksel kampanye tanpa data formulir.</small>
                  </span>
                </label>
                <label class="ps-consent-option">
                  <input type="checkbox" name="maps" ${preferences.maps ? "checked" : ""} data-testid="consent-toggle-maps" />
                  <span>
                    <strong>Peta interaktif</strong>
                    <small>Memuat peta tertanam pihak ketiga.</small>
                  </span>
                </label>
              </fieldset>
              <div class="ps-dialog-footer">
                <button type="submit" class="ps-btn ps-btn-primary" data-testid="consent-save-preferences">
                  Simpan preferensi
                </button>
                <button type="button" class="ps-btn ps-btn-danger" data-action="withdraw-consent" data-testid="consent-withdraw">
                  Cabut semua izin opsional
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  </main>

  <script>${script}</script>
</body>
</html>`;
}

async function startFixtureServer(assets) {
  const serverHits = [];
  let leadSubmissions = 0;
  let baseUrl = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", baseUrl || "http://127.0.0.1");
    serverHits.push(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = renderFixtureHtml({
        baseUrl,
        cookieHeader: req.headers.cookie ?? null,
        submittedLead: url.searchParams.get("submitted") === "1",
        css: assets.css,
        script: assets.script,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/lead-demo") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        leadSubmissions += 1;
        res.writeHead(303, { Location: "/?submitted=1" });
        res.end(body ? "" : "");
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/mock-vendor/analytics.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end("window.__mockAnalyticsLoaded = (window.__mockAnalyticsLoaded || 0) + 1;");
      return;
    }

    if (req.method === "GET" && url.pathname === "/mock-vendor/marketing.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end("window.__mockMarketingLoaded = (window.__mockMarketingLoaded || 0) + 1;");
      return;
    }

    if (req.method === "GET" && url.pathname === "/mock-maps/embed") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><p id='mock-map-ready'>Peta Interaktif Aktif</p></body></html>");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    serverHits,
    getLeadSubmissions: () => leadSubmissions,
    clearHits: () => {
      serverHits.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const assets = extractConsentComponentAssets();
  const fixture = await startFixtureServer(assets);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // -----------------------------------------------------------------------
    // 1. No-JS progressive enhancement check (360px): zero trackers, forms + WA + map link work
    // -----------------------------------------------------------------------
    {
      const noJsContext = await browser.newContext({
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsContext.newPage();
      fixture.clearHits();
      await noJsPage.goto(fixture.baseUrl, { waitUntil: "load" });

      assert(
        await noJsPage.locator('[data-testid="consent-map-fallback-link"]').isVisible(),
        "No-JS: plain external map link must be visible",
      );
      assert(
        (await noJsPage.locator('iframe[data-testid="consent-map-iframe"]').count()) === 0,
        "No-JS: map iframe must not be mounted",
      );
      assert(
        await noJsPage.locator('[data-testid="demo-wa-link"]').isVisible(),
        "No-JS: WhatsApp link must remain visible",
      );
      assert(
        !fixture.serverHits.some((h) => h.includes("/mock-vendor/") || h.includes("/mock-maps/")),
        `No-JS: zero optional vendor/map requests allowed, got ${JSON.stringify(fixture.serverHits)}`,
      );

      // Submit lead form without JS (normal HTML POST -> 303 redirect)
      await noJsPage.locator('[data-testid="demo-lead-submit"]').click();
      await noJsPage.waitForURL(/submitted=1/);
      assert(
        await noJsPage.locator('[data-testid="lead-form-success"]').isVisible(),
        "No-JS: normal lead form POST must succeed",
      );
      await noJsContext.close();
    }

    // -----------------------------------------------------------------------
    // 2. Full JS browser journey across 360px & 1440px:
    //    Pre-consent -> Reject -> Reload -> Accept -> Withdraw + Keyboard operability
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];
    const observedOptionalRequests = [];

    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/mock-vendor/") || url.includes("/mock-maps/")) {
        observedOptionalRequests.push(url);
      }
    });

    // 2A. Before consent @ 360px and 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      fixture.clearHits();
      observedOptionalRequests.length = 0;
      await page.setViewportSize(vp);
      await page.goto(fixture.baseUrl, { waitUntil: "networkidle" });

      const metrics = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth > window.innerWidth;
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="consent-banner"] button'),
        ).map((el) => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent?.trim(), width: r.width, height: r.height };
        });
        return {
          overflow,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          buttons,
        };
      });

      assert(
        !metrics.overflow,
        `Pre-consent @ ${vp.width}px has horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
      );
      assert(metrics.buttons.length === 3, `Expected 3 banner buttons, got ${metrics.buttons.length}`);
      for (const btn of metrics.buttons) {
        assert(
          btn.height >= 44 && btn.width >= 44,
          `Banner button "${btn.text}" @ ${vp.width}px below 44px touch target (${btn.width}x${btn.height})`,
        );
      }

      assert(
        observedOptionalRequests.length === 0,
        `Before consent @ ${vp.width}px: ZERO optional vendor/map requests allowed, got ${JSON.stringify(observedOptionalRequests)}`,
      );
      assert(
        (await page.locator('iframe[data-testid="consent-map-iframe"]').count()) === 0,
        `Before consent @ ${vp.width}px: map iframe must not exist`,
      );
      assert(
        await page.locator('[data-testid="consent-map-fallback-link"]').isVisible(),
        `Before consent @ ${vp.width}px: plain map link must be visible`,
      );
      const waHref = await page.locator('[data-testid="demo-wa-link"]').getAttribute("href");
      assert(
        Boolean(waHref && waHref.startsWith("https://wa.me/")),
        `Before consent @ ${vp.width}px: WhatsApp link must stay functional`,
      );
    }

    // 2B. Reject optional (`Tolak opsional`)
    fixture.clearHits();
    observedOptionalRequests.length = 0;
    await page.locator('[data-testid="consent-reject-optional"]').click();

    assert(
      await page.locator('[data-testid="consent-banner"]').isHidden(),
      "After Reject: banner must hide",
    );
    assert(
      await page.locator('[data-testid="consent-manage-trigger"]').isVisible(),
      "After Reject: withdrawal/settings trigger must remain reachable",
    );
    assert(
      observedOptionalRequests.length === 0,
      `After Reject: ZERO optional requests allowed, got ${JSON.stringify(observedOptionalRequests)}`,
    );
    assert(
      (await page.locator('iframe[data-testid="consent-map-iframe"]').count()) === 0,
      "After Reject: map iframe must remain unmounted",
    );

    // Verify __Host-ps_consent cookie saved with no Domain=
    const rejectSetCookie = await page.evaluate(() => window.__punyasitusLastConsentSetCookie || "");
    const rejectValidation = validateTenantSetCookieHeader(rejectSetCookie);
    assert(
      rejectValidation.valid,
      `After Reject: Set-Cookie must pass __Host-/no-Domain validation, got ${JSON.stringify(rejectValidation)} (${rejectSetCookie})`,
    );
    const cookiesAfterReject = await context.cookies(fixture.baseUrl);
    const consentCookieReject = cookiesAfterReject.find((c) => c.name === CONSENT_COOKIE_NAME);
    assert(
      Boolean(consentCookieReject),
      `After Reject: Chromium must store ${CONSENT_COOKIE_NAME} cookie, got ${JSON.stringify(cookiesAfterReject)}`,
    );

    // Reload after Reject -> still zero vendor/map requests, lead form still works
    observedOptionalRequests.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    assert(
      observedOptionalRequests.length === 0,
      `After Reject + reload: ZERO optional requests allowed, got ${JSON.stringify(observedOptionalRequests)}`,
    );
    assert(
      await page.locator('[data-testid="consent-banner"]').isHidden(),
      "After Reject + reload: banner stays hidden",
    );
    const leadsBefore = fixture.getLeadSubmissions();
    await page.locator('[data-testid="demo-lead-submit"]').click();
    await page.waitForURL(/submitted=1/);
    assert(
      fixture.getLeadSubmissions() === leadsBefore + 1,
      "After Reject: core lead form must remain 100% functional",
    );

    // 2C. Keyboard operability: open preferences via Enter, check Escape focus restoration, then enable via Accept
    const manageTrigger = page.locator('[data-testid="consent-manage-trigger"]');
    await manageTrigger.focus();
    const focusRing = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { outlineStyle: "none", outlineWidth: "0px" };
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });
    assert(
      focusRing.outlineStyle !== "none" && parseFloat(focusRing.outlineWidth) >= 2,
      `Keyboard focus must show >=2px outline, got ${JSON.stringify(focusRing)}`,
    );

    await page.keyboard.press("Enter");
    const dialog = page.locator('[data-testid="consent-preferences-dialog"]');
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    const focusedAfterEsc = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    );
    assert(
      focusedAfterEsc === "consent-manage-trigger",
      `Focus must return to consent-manage-trigger after Escape, got "${focusedAfterEsc}"`,
    );

    // Open preferences via keyboard again and enable all three categories (analytics, marketing, maps)
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.locator('[data-testid="consent-toggle-analytics"]').check();
    await page.locator('[data-testid="consent-toggle-marketing"]').check();
    await page.locator('[data-testid="consent-toggle-maps"]').check();
    observedOptionalRequests.length = 0;
    await page.locator('[data-testid="consent-save-preferences"]').click();

    // Wait for vendor scripts & map iframe to load
    await page.locator('iframe[data-testid="consent-map-iframe"]').waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(
      () => window.__mockAnalyticsLoaded === 1 && window.__mockMarketingLoaded === 1,
      undefined,
      { timeout: 5000 },
    );

    assert(
      observedOptionalRequests.some((u) => u.includes("/mock-vendor/analytics.js")),
      "After Accept: analytics vendor script must load",
    );
    assert(
      observedOptionalRequests.some((u) => u.includes("/mock-vendor/marketing.js")),
      "After Accept: marketing vendor script must load",
    );
    assert(
      observedOptionalRequests.some((u) => u.includes("/mock-maps/embed")),
      "After Accept: map embed iframe must load",
    );

    const acceptSetCookie = await page.evaluate(() => window.__punyasitusLastConsentSetCookie || "");
    const acceptValidation = validateTenantSetCookieHeader(acceptSetCookie);
    assert(
      acceptValidation.valid && !acceptSetCookie.toLowerCase().includes("domain="),
      `After Accept: cookie must use __Host- with no Domain=, got "${acceptSetCookie}"`,
    );

    // 2D. Withdraw consent (`Cabut izin`) -> map iframe unmounts immediately, vendor scripts removed, preference resets cleanly
    const quickWithdraw = page.locator('[data-testid="consent-withdraw-quick"]');
    await quickWithdraw.focus();
    await page.keyboard.press("Enter");

    assert(
      (await page.locator('iframe[data-testid="consent-map-iframe"]').count()) === 0,
      "After Withdraw: map iframe must unmount immediately",
    );
    assert(
      (await page.locator('script[data-consent-loaded="true"]').count()) === 0,
      "After Withdraw: optional vendor script elements must be removed immediately",
    );
    assert(
      await page.locator('[data-testid="consent-map-placeholder"]').isVisible(),
      "After Withdraw: pre-consent map placeholder must return",
    );
    assert(
      await page.locator('[data-testid="consent-banner"]').isVisible(),
      "After Withdraw: consent banner must reappear cleanly",
    );
    const stateAfterWithdraw = await page.evaluate(() => window.__punyasitusConsent);
    assert(
      stateAfterWithdraw &&
        stateAfterWithdraw.analytics === false &&
        stateAfterWithdraw.marketing === false &&
        stateAfterWithdraw.maps === false &&
        stateAfterWithdraw.hasDecision === false,
      `After Withdraw: preference state must reset to all false, got ${JSON.stringify(stateAfterWithdraw)}`,
    );

    // Reload after Withdraw -> ZERO vendor/map requests fired and cookie is gone!
    observedOptionalRequests.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    assert(
      observedOptionalRequests.length === 0,
      `After Withdraw + reload: ZERO optional vendor/map requests allowed, got ${JSON.stringify(observedOptionalRequests)}`,
    );
    const cookiesAfterWithdraw = await context.cookies(fixture.baseUrl);
    assert(
      !cookiesAfterWithdraw.some((c) => c.name === CONSENT_COOKIE_NAME),
      `After Withdraw: ${CONSENT_COOKIE_NAME} must be cleared, got ${JSON.stringify(cookiesAfterWithdraw)}`,
    );

    // 2E. Also verify 1-click "Terima semua" button directly on 360px mobile viewport
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('[data-testid="consent-accept-all"]').click();
    await page.locator('iframe[data-testid="consent-map-iframe"]').waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(
      () => window.__mockAnalyticsLoaded === 1 && window.__mockMarketingLoaded === 1,
      undefined,
      { timeout: 5000 },
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-031 E2E PASS: No-JS fallback, 360px/1440px zero overflow & >=44px touch targets, pre-consent 0 optional requests, Reject 0 requests + core form/WA intact, __Host-ps_consent cookie with no Domain=, keyboard Escape focus return, Accept loads vendor scripts & map embed, Withdraw immediately unmounts map & clears preference, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-031 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

await main();
