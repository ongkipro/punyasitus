/* global process, console, document, window, getComputedStyle, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK012_SCREENSHOT_DIR || "";

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

/**
 * Compiles the REAL `apps/web/src/themes/default/Layout.astro`, `tokens.css`,
 * `base.css`, `Consent.astro`, and `public-data.ts` via Astro build inside an
 * isolated temporary fixture directory (leaving `apps/web/src/pages/**` untouched!).
 */
async function buildRealAstroLayoutFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t012-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const sharedDemoBody = `
  <section style="padding: clamp(2.5rem, 6vw, 4.5rem) 0; background: var(--ps-surface-muted); border-bottom: 1px solid var(--ps-border);">
    <div class="ps-container">
      <p style="margin: 0 0 0.5rem; font-size: 0.875rem; font-weight: 700; color: var(--ps-brand-primary); letter-spacing: 0.04em; text-transform: uppercase;">
        Solusi Bisnis Terpercaya
      </p>
      <h1 style="max-width: 24ch; margin-bottom: 1rem;">
        Bangun Kepercayaan Klien dengan Profil Perusahaan Profesional
      </h1>
      <p style="max-width: 58ch; color: var(--ps-ink-muted); margin: 0 0 1.5rem;">
        Tema dasar PunyaSitus menyajikan token warna merek tervalidasi sejak lukisan pertama tanpa kilatan gaya, navigasi responsif tanpa JavaScript, dan kontras WCAG AA.
      </p>
      <div style="display: flex; flex-wrap: wrap; gap: 0.75rem;">
        <a
          href="#layanan"
          style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;"
        >
          Lihat Layanan Kami
        </a>
        <a
          href="#kontak"
          style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-surface); color: var(--ps-ink); border: 1px solid var(--ps-border); font-weight: 600; text-decoration: none;"
        >
          Hubungi Tim
        </a>
      </div>
    </div>
  </section>
  <section id="layanan" style="padding: clamp(2rem, 5vw, 3.5rem) 0;">
    <div class="ps-container">
      <h2>Keunggulan Operasional</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1rem; margin-top: 1rem;">
        <article style="padding: 1.25rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface);">
          <h3>Arsitektur Ringan</h3>
          <p style="margin: 0; color: var(--ps-ink-muted);">Halaman publik HTML-first dengan ukuran aset terkendali untuk jaringan 4G Indonesia.</p>
        </article>
        <article style="padding: 1.25rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface);">
          <h3>Kontras Terjaga</h3>
          <p style="margin: 0; color: var(--ps-ink-muted);">Warna merek diverifikasi otomatis agar teks utama selalu mencapai rasio kontras minimal 4,5:1.</p>
        </article>
        <article style="padding: 1.25rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface);">
          <h3>Navigasi Aksesibel</h3>
          <p style="margin: 0; color: var(--ps-ink-muted);">Menu seluler berfungsi penuh tanpa JavaScript dan mendukung navigasi papan ketik.</p>
        </article>
      </div>
    </div>
  </section>
`;

  // Page 1: Standard tenant shell with published custom brand token (`#0f4c81`)
  fs.writeFileSync(
    path.join(pagesDir, "standard.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const themeStyle = buildSafeThemeStyleBlock(
  {
    primaryColor: "#0f4c81",
    secondaryColor: "#0f766e",
    borderRadiusPx: 10,
    containerMaxWidthPx: 1200,
    fontFamily: "system",
  },
  "compro",
);

const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "compro",
  baseThemeId: "compro",
  themeStyle,
  site: {
    title: "PT Nusantara Arsitek",
    tagline: "Konsultan & Konstruksi B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "PT Nusantara Arsitek",
    category: "LocalBusiness",
    description: "Mitra perancangan dan pembangunan ruang usaha sejak 2016.",
    address: "Jl. Jenderal Sudirman No. 45",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12190",
    mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu–Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@nusantara-arsitek.id",
    socialLinks: [
      { platform: "instagram", url: "https://instagram.com/nusantaraarsitek" },
      { platform: "linkedin", url: "https://linkedin.com/company/nusantaraarsitek" },
    ],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/standard/", openInNewTab: false, children: [] },
      {
        label: "Layanan",
        href: "#layanan",
        openInNewTab: false,
        children: [
          { label: "Desain Arsitektur", href: "#layanan", openInNewTab: false, children: [] },
          { label: "Renovasi Kantor", href: "#layanan", openInNewTab: false, children: [] },
        ],
      },
      { label: "Portofolio", href: "#layanan", openInNewTab: false, children: [] },
      { label: "Kontak", href: "#kontak", openInNewTab: false, children: [] },
    ],
    footer: [
      { label: "Tentang Perusahaan", href: "#layanan", openInNewTab: false, children: [] },
      { label: "Layanan", href: "#layanan", openInNewTab: false, children: [] },
    ],
    mobile: [],
  },
  page: {
    slug: "beranda",
    title: "Beranda",
    isHomepage: true,
    layoutMode: "standard",
    sections: [],
  },
  revisions: {
    siteSettingsVersion: 2,
    businessProfileVersion: 2,
    themeConfigVersion: 2,
    pageVersion: 2,
  },
};
---
<Layout
  shell={shell}
  currentPath="/standard/"
  headerCtaLabel="Konsultasi Gratis"
  headerCtaHref="#kontak"
>
  <meta slot="head" name="x-test-head-slot" content="ok" />
  ${sharedDemoBody}
  <a
    slot="floating"
    href="https://wa.me/6281234567890"
    target="_blank"
    rel="noopener noreferrer"
    data-testid="floating-slot-demo"
    style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1rem; border-radius: 999px; background: var(--ps-wa-bg); color: var(--ps-wa-fg); font-weight: 600; text-decoration: none;"
  >
    Chat WhatsApp
  </a>
</Layout>
`,
  );

  // Page 2: Malformed/hostile token injection fixture — must fall back safely & execute ZERO script!
  fs.writeFileSync(
    path.join(pagesDir, "malformed.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const themeStyle = buildSafeThemeStyleBlock(
  {
    primaryColor: "#112233}</style><script>window.__t012Injected=true</script>",
    secondaryColor: "url(https://evil.example/bg.png); expression(alert(1))",
  },
  "resto",
);

const shell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "resto",
  baseThemeId: "resto",
  themeStyle,
  site: {
    title: "Kedai Kopi Aman",
    tagline: "Uji Sanitasi Token",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: false,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Kedai Kopi Aman",
    category: "Restaurant",
    description: "Token rusak otomatis kembali ke warna aman tema resto.",
    address: null,
    city: "Yogyakarta",
    province: null,
    postalCode: null,
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    phone: null,
    whatsappE164: null,
    email: null,
    socialLinks: [],
  },
  menus: {
    header: [{ label: "Beranda", href: "/malformed/", openInNewTab: false, children: [] }],
    footer: [],
    mobile: [],
  },
  page: null,
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: null,
  },
};
---
<Layout shell={shell} currentPath="/malformed/" showConsent={false}>
  <section style="padding: 2.5rem 0;">
    <div class="ps-container">
      <h1>Uji Pertahanan Token CSS</h1>
      <p>Halaman ini menguji fallback otomatis saat token tema mengandung payload berbahaya.</p>
    </div>
  </section>
</Layout>
`,
  );

  // Page 3: Landing Page Focus Mode (`focused`) — hides header & footer nav chrome cleanly
  fs.writeFileSync(
    path.join(pagesDir, "focused.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const themeStyle = buildSafeThemeStyleBlock(null, "sales");
const shell = {
  isPreview: false,
  layoutMode: "focused",
  themeId: "sales",
  baseThemeId: "sales",
  themeStyle,
  site: {
    title: "Kampanye Fokus Sales",
    tagline: null,
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: false,
    catalogEnabled: false,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "Konsultan Properti Mandiri",
    category: "LocalBusiness",
    description: null,
    address: null,
    city: null,
    province: null,
    postalCode: null,
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    phone: null,
    whatsappE164: null,
    email: null,
    socialLinks: [],
  },
  menus: {
    header: [{ label: "Tidak Boleh Tampil", href: "/hidden", openInNewTab: false, children: [] }],
    footer: [{ label: "Footer Tersembunyi", href: "/hidden-footer", openInNewTab: false, children: [] }],
    mobile: [],
  },
  page: {
    slug: "promo-konsultasi",
    title: "Promo Konsultasi",
    isHomepage: false,
    layoutMode: "focused",
    sections: [],
  },
  revisions: {
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
---
<Layout shell={shell} showConsent={false}>
  <section style="padding: 3rem 0;">
    <div class="ps-container">
      <h1>Landing Page Mode Fokus</h1>
      <p>Navigasi atas dan footer disembunyikan untuk menjaga fokus konversi iklan.</p>
    </div>
  </section>
</Layout>
`,
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
    tmpRoot,
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function startStaticServer(outDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) {
      relPath = path.join(relPath, "index.html");
    }
    let fullPath = path.resolve(outDir, relPath);
    if (!fullPath.startsWith(path.resolve(outDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      const asIndex = path.join(fullPath, "index.html");
      if (fs.existsSync(asIndex)) {
        fullPath = asIndex;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": getContentType(fullPath) });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealAstroLayoutFixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    // -----------------------------------------------------------------------
    // 0. Static SSR HTML assertions (zero-FOUC ordering + zero injection)
    // -----------------------------------------------------------------------
    const standardHtml = fs.readFileSync(
      path.join(fixtures.outDir, "standard/index.html"),
      "utf8",
    );
    const bodyIdx = standardHtml.indexOf("<body");
    const tokenIdx = standardHtml.indexOf("--ps-brand-primary: #0f4c81");
    assert(tokenIdx > 0 && tokenIdx < bodyIdx, "SSR inline theme tokens MUST appear in <head> before <body> (zero FOUC)");
    assert(standardHtml.includes('name="x-test-head-slot"'), "Named <slot name='head'> must render inside <head>");
    assert(standardHtml.includes('data-testid="floating-slot-demo"'), "Named <slot name='floating'> must render");
    assert(standardHtml.includes("data-ps-consent-root"), "Consent banner must integrate cleanly inside Layout.astro");

    const malformedHtml = fs.readFileSync(
      path.join(fixtures.outDir, "malformed/index.html"),
      "utf8",
    );
    assert(
      !malformedHtml.includes("__t012Injected"),
      "Malformed token injection must never appear in SSR HTML",
    );
    assert(
      !malformedHtml.includes("evil.example"),
      "Malformed url() injection must never appear in SSR HTML",
    );
    assert(
      malformedHtml.includes("--ps-brand-primary: #9a3412"),
      "Malformed resto theme must fall back to resto safe primary token #9a3412",
    );

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // -----------------------------------------------------------------------
    // 1. No-JS Progressive Enhancement @ 360px (pure HTML/CSS <details> drawer)
    // -----------------------------------------------------------------------
    {
      const noJsCtx = await browser.newContext({
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsCtx.newPage();
      await noJsPage.goto(`${server.baseUrl}/standard/`, { waitUntil: "load" });

      const firstPaintPrimary = await noJsPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--ps-brand-primary").trim(),
      );
      assert(
        firstPaintPrimary === "#0f4c81",
        `No-JS @ 360px: expected --ps-brand-primary #0f4c81 on first paint, got "${firstPaintPrimary}"`,
      );

      const mobileDetails = noJsPage.locator('[data-testid="mobile-nav-details"]');
      const mobileToggle = noJsPage.locator('[data-testid="mobile-nav-toggle"]');
      const mobilePanel = noJsPage.locator('[data-testid="mobile-nav-panel"]');

      assert(await mobileToggle.isVisible(), "No-JS @ 360px: mobile menu toggle must be visible");
      assert(await mobilePanel.isHidden(), "No-JS @ 360px: mobile nav panel starts closed");

      // Open without JS
      await mobileToggle.click();
      assert(
        await mobileDetails.evaluate((el) => el.hasAttribute("open")),
        "No-JS @ 360px: <details> mobile nav must open without JavaScript",
      );
      assert(await mobilePanel.isVisible(), "No-JS @ 360px: mobile nav panel must be visible when open");

      // Close without JS
      await mobileToggle.click();
      assert(
        !(await mobileDetails.evaluate((el) => el.hasAttribute("open"))),
        "No-JS @ 360px: <details> mobile nav must close cleanly without JavaScript",
      );

      await noJsCtx.close();
    }

    // -----------------------------------------------------------------------
    // 2. Full JS Browser Checks @ 360px & 1440px
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 2A. Standard Shell @ 1440px (Desktop)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/standard/`, { waitUntil: "networkidle" });

    const desktopMetrics = await page.evaluate(() => {
      const rootCs = getComputedStyle(document.documentElement);
      const bodyCs = getComputedStyle(document.body);
      const ctaEl = document.querySelector('[data-testid="header-cta"]');
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        primaryToken: rootCs.getPropertyValue("--ps-brand-primary").trim(),
        bodyPrimaryToken: bodyCs.getPropertyValue("--ps-brand-primary").trim(),
        ctaBackgroundColor: ctaEl ? getComputedStyle(ctaEl).backgroundColor : "",
        secondaryToken: rootCs.getPropertyValue("--ps-brand-secondary").trim(),
        radiusToken: rootCs.getPropertyValue("--ps-radius").trim(),
        desktopNavVisible: getComputedStyle(document.querySelector('[data-testid="desktop-nav"]')).display !== "none",
        mobileNavVisible: getComputedStyle(document.querySelector('[data-testid="mobile-nav-details"]')).display !== "none",
      };
    });

    assert(
      !desktopMetrics.overflow,
      `Desktop 1440px horizontal overflow (${desktopMetrics.scrollWidth} > ${desktopMetrics.innerWidth})`,
    );
    assert(desktopMetrics.primaryToken === "#0f4c81", `Desktop --ps-brand-primary expected #0f4c81, got ${desktopMetrics.primaryToken}`);
    assert(
      desktopMetrics.bodyPrimaryToken === "#0f4c81",
      `Desktop body --ps-brand-primary must inherit #0f4c81 without shadowing, got ${desktopMetrics.bodyPrimaryToken}`,
    );
    assert(
      desktopMetrics.ctaBackgroundColor === "rgb(15, 76, 129)",
      `Desktop header CTA must paint published primary rgb(15, 76, 129), got ${desktopMetrics.ctaBackgroundColor}`,
    );
    assert(desktopMetrics.secondaryToken === "#0f766e", `Desktop --ps-brand-secondary expected #0f766e, got ${desktopMetrics.secondaryToken}`);
    assert(desktopMetrics.radiusToken === "10px", `Desktop --ps-radius expected 10px, got ${desktopMetrics.radiusToken}`);
    assert(desktopMetrics.desktopNavVisible, "Desktop 1440px must show desktop navigation");
    assert(!desktopMetrics.mobileNavVisible, "Desktop 1440px must hide mobile drawer toggle");

    // Keyboard Tab reaches skip link first, then nav brand link with >= 2px focus ring
    await page.keyboard.press("Tab");
    const firstTab = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = el ? getComputedStyle(el) : null;
      return {
        testId: el?.getAttribute("data-testid") ?? "",
        text: el?.textContent?.trim() ?? "",
        outlineStyle: cs?.outlineStyle ?? "none",
        outlineWidth: cs ? parseFloat(cs.outlineWidth) : 0,
      };
    });
    assert(
      firstTab.testId === "skip-to-content" && firstTab.text.includes("Lewati ke konten utama"),
      `First Tab must focus skip link, got ${JSON.stringify(firstTab)}`,
    );
    assert(
      firstTab.outlineStyle !== "none" && firstTab.outlineWidth >= 2,
      `Skip link focus ring must be >= 2px, got ${JSON.stringify(firstTab)}`,
    );

    await page.keyboard.press("Tab");
    const secondTab = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = el ? getComputedStyle(el) : null;
      return {
        testId: el?.getAttribute("data-testid") ?? "",
        outlineStyle: cs?.outlineStyle ?? "none",
        outlineWidth: cs ? parseFloat(cs.outlineWidth) : 0,
      };
    });
    assert(
      secondTab.testId === "site-brand-link",
      `Second Tab must focus site-brand-link, got ${JSON.stringify(secondTab)}`,
    );
    assert(
      secondTab.outlineStyle !== "none" && secondTab.outlineWidth >= 2,
      `Nav control focus ring must be >= 2px, got ${JSON.stringify(secondTab)}`,
    );

    // Dismiss consent banner cleanly before taking desktop screenshot, or capture default state
    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "shell-standard-1440.png"),
        fullPage: true,
      });
    }

    // 2B. Standard Shell @ 360px (Mobile) — touch targets >= 44px, zero overflow, Escape closes mobile nav
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/standard/`, { waitUntil: "networkidle" });

    const mobileToggle = page.locator('[data-testid="mobile-nav-toggle"]');
    await mobileToggle.click();
    await page.locator('[data-testid="mobile-nav-panel"]').waitFor({ state: "visible" });

    const mobileMetrics = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const targets = Array.from(
        document.querySelectorAll(
          '[data-testid="mobile-nav-toggle"], [data-testid="mobile-nav-panel"] a, [data-testid="site-brand-link"]',
        ),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent?.trim() ?? "", width: r.width, height: r.height };
      });
      return {
        overflow,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        targets,
      };
    });

    assert(
      !mobileMetrics.overflow,
      `Mobile 360px horizontal overflow (${mobileMetrics.scrollWidth} > ${mobileMetrics.innerWidth})`,
    );
    assert(mobileMetrics.targets.length >= 4, "Mobile 360px must render interactive touch targets");
    for (const t of mobileMetrics.targets) {
      assert(
        t.height >= 44 && t.width >= 44,
        `Mobile 360px target "${t.text}" below 44px (${t.width}x${t.height})`,
      );
    }

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "shell-mobile-open-360.png"),
        fullPage: true,
      });
    }

    // Progressive enhancement: Escape closes mobile <details> and returns focus to <summary>
    await page.keyboard.press("Escape");
    const afterEscape = await page.evaluate(() => ({
      isOpen: document.querySelector('[data-testid="mobile-nav-details"]')?.hasAttribute("open") ?? false,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    assert(!afterEscape.isOpen, "Escape must close open mobile <details> menu");
    assert(
      afterEscape.activeTestId === "mobile-nav-toggle",
      `Escape must restore focus to mobile-nav-toggle, got "${afterEscape.activeTestId}"`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "shell-standard-360.png"),
        fullPage: true,
      });
    }

    // 2C. Malformed Token Injection Page — zero XSS execution & safe resto fallback token applied
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/malformed/`, { waitUntil: "networkidle" });
    const malformedMetrics = await page.evaluate(() => ({
      injected: Boolean(window.__t012Injected),
      primary: getComputedStyle(document.documentElement)
        .getPropertyValue("--ps-brand-primary")
        .trim(),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    assert(!malformedMetrics.injected, "Malformed CSS token MUST NEVER execute injected <script>");
    assert(
      malformedMetrics.primary === "#9a3412",
      `Malformed resto theme must apply safe fallback #9a3412, got "${malformedMetrics.primary}"`,
    );
    assert(!malformedMetrics.overflow, "Malformed fallback page must have zero overflow");

    // 2D. Landing Page Focus Mode (`focused`) — hides header & footer nav cleanly
    await page.goto(`${server.baseUrl}/focused/`, { waitUntil: "networkidle" });
    const focusedMetrics = await page.evaluate(() => ({
      layoutMode: document.body.getAttribute("data-layout-mode"),
      headerCount: document.querySelectorAll('[data-testid="site-header"]').length,
      footerCount: document.querySelectorAll('[data-testid="site-footer"]').length,
      bodyText: document.body.innerText,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    assert(focusedMetrics.layoutMode === "focused", `Expected focused mode, got ${focusedMetrics.layoutMode}`);
    assert(focusedMetrics.headerCount === 0, "Focused mode must hide site header navigation");
    assert(focusedMetrics.footerCount === 0, "Focused mode must hide site footer navigation");
    assert(!focusedMetrics.bodyText.includes("Tidak Boleh Tampil"), "Focused mode must not render header links");
    assert(!focusedMetrics.overflow, "Focused mode must have zero horizontal overflow");

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-012 E2E PASS: Real Layout.astro SSR token injection before <body> (zero FOUC), malformed token fallback with 0 XSS, 360px/1440px zero overflow & >=44px touch targets, No-JS <details> mobile drawer + Escape focus return, >=2px keyboard focus ring, focused mode hiding header/footer, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-012 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

await main();
