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

const screenshotDir = process.env.TASK014_SCREENSHOT_DIR || "";

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
 * Compiles REAL `Layout.astro` + `FloatingWhatsApp.astro` inside an isolated
 * temporary fixture directory (leaving `apps/web/src/pages/**` untouched).
 */
async function buildRealFloatingWhatsAppFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t014-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const widgetImport = path.join(webDir, "src/themes/default/components/FloatingWhatsApp.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const sharedShellSetup = `
const themeStyle = buildSafeThemeStyleBlock(
  {
    primaryColor: "#176b51",
    secondaryColor: "#0f4c5c",
    borderRadiusPx: 8,
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
    ],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/greeting/", openInNewTab: false, children: [] },
      { label: "Layanan", href: "#layanan", openInNewTab: false, children: [] },
      { label: "Kontak", href: "#kontak", openInNewTab: false, children: [] },
    ],
    footer: [
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
    siteSettingsVersion: 1,
    businessProfileVersion: 1,
    themeConfigVersion: 1,
    pageVersion: 1,
  },
};
`;

  const demoContent = `
  <section style="padding: clamp(2.5rem, 6vw, 4.5rem) 0; background: var(--ps-surface-muted); border-bottom: 1px solid var(--ps-border);">
    <div class="ps-container">
      <p style="margin: 0 0 0.5rem; font-size: 0.875rem; font-weight: 700; color: var(--ps-brand-primary); letter-spacing: 0.04em; text-transform: uppercase;">
        Konsultasi Proyek B2B
      </p>
      <h1 style="max-width: 22ch; margin-bottom: 1rem;">
        Rancang Ruang Kerja Efisien Bersama Tim Profesional
      </h1>
      <p style="max-width: 56ch; color: var(--ps-ink-muted); margin: 0 0 1.5rem;">
        Diskusikan kebutuhan desain arsitektur dan renovasi kantor langsung melalui WhatsApp atau formulir konsultasi kami.
      </p>
      <a
        href="#layanan"
        style="display: inline-flex; align-items: center; min-height: 44px; padding: 0.625rem 1.25rem; border-radius: var(--ps-radius); background: var(--ps-brand-primary); color: var(--ps-brand-on-primary); font-weight: 600; text-decoration: none;"
      >
        Lihat Layanan
      </a>
    </div>
  </section>
  <section id="layanan" style="padding: clamp(2rem, 5vw, 3.5rem) 0;">
    <div class="ps-container">
      <h2>Layanan Utama</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1rem; margin-top: 1rem;">
        <article style="padding: 1.25rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface);">
          <h3>Perencanaan Arsitektur</h3>
          <p style="margin: 0; color: var(--ps-ink-muted);">Gambar kerja, RAB terukur, dan pendampingan perizinan gedung usaha.</p>
        </article>
        <article style="padding: 1.25rem; border: 1px solid var(--ps-border); border-radius: var(--ps-radius); background: var(--ps-surface);">
          <h3>Interior &amp; Renovasi Kantor</h3>
          <p style="margin: 0; color: var(--ps-ink-muted);">Pengerjaan tepat waktu dengan jadwal operasional yang transparan.</p>
        </article>
      </div>
    </div>
  </section>
`;

  // Page 1: Full Greeting Popover + Honest Operating Hours + Consent Banner coordination
  fs.writeFileSync(
    path.join(pagesDir, "greeting.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import FloatingWhatsApp from ${JSON.stringify(widgetImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${sharedShellSetup}
---
<Layout shell={shell} currentPath="/greeting/" showConsent={true}>
  ${demoContent}
  <FloatingWhatsApp
    slot="floating"
    shell={shell}
    phone="0812-3456-7890"
    agentSubtitle="Layanan Pelanggan"
    greetingMessage="Halo! Silakan sampaikan kebutuhan proyek atau jadwal survei lokasi Anda."
    primaryOrigin="https://nusantara-arsitek.situsku.click"
    canonicalPath="/layanan/desain-kantor?utm_source=ads#top"
  />
</Layout>
`,
  );

  // Page 2: Direct-Link Mode (no greeting popover, pure <a> link, zero JS required)
  fs.writeFileSync(
    path.join(pagesDir, "direct.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import FloatingWhatsApp from ${JSON.stringify(widgetImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${sharedShellSetup}
---
<Layout shell={shell} currentPath="/direct/" showConsent={false}>
  ${demoContent}
  <FloatingWhatsApp
    slot="floating"
    shell={shell}
    phone="+62 812 3456 7890"
    primaryOrigin="https://nusantara-arsitek.situsku.click"
    canonicalPath="/direct"
  />
</Layout>
`,
  );

  // Page 3: Invalid / hostile phone -> fail-closed (renders NOTHING)
  fs.writeFileSync(
    path.join(pagesDir, "invalid.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import FloatingWhatsApp from ${JSON.stringify(widgetImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${sharedShellSetup}
---
<Layout shell={shell} currentPath="/invalid/" showConsent={false}>
  ${demoContent}
  <FloatingWhatsApp
    slot="floating"
    phone="javascript:alert(1)"
    businessName="Situs Uji"
    greetingMessage="Tidak boleh tampil"
  />
</Layout>
`,
  );

  // Page 4: Hostile greeting HTML + fake live-presence operatingHours -> safely escaped & rejected
  fs.writeFileSync(
    path.join(pagesDir, "xss-hours.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import FloatingWhatsApp from ${JSON.stringify(widgetImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${sharedShellSetup}
---
<Layout shell={shell} currentPath="/xss-hours/" showConsent={false}>
  ${demoContent}
  <FloatingWhatsApp
    slot="floating"
    phone="6281234567890"
    businessName="PT Aman <img src=x onerror=window.__t014Xss=true>"
    greetingMessage="<script>window.__t014Xss=true</script>Halo dari tim kami."
    operatingHours="Online sekarang — Balas dalam 1 menit"
    holidayHours="Sedang aktif"
  />
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
  const fixtures = await buildRealFloatingWhatsAppFixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    // -----------------------------------------------------------------------
    // 0. Static SSR HTML & Zero-Island Bundle Budget Assertions
    // -----------------------------------------------------------------------
    const greetingHtml = fs.readFileSync(
      path.join(fixtures.outDir, "greeting/index.html"),
      "utf8",
    );
    assert(
      greetingHtml.includes("https://wa.me/6281234567890?text="),
      "SSR HTML must emit canonical https://wa.me/6281234567890?text= link",
    );
    assert(
      !greetingHtml.includes("utm_source"),
      "SSR wa.me link must strip visitor query strings from canonical page_url",
    );
    assert(
      !greetingHtml.includes("astro-island"),
      "FloatingWhatsApp must emit ZERO React/Astro island hydration runtime",
    );

    // Verify no JS asset files were bundled for FloatingWhatsApp (only tiny inline progressive script)
    const astroAssetsDir = path.join(fixtures.outDir, "_astro");
    const bundledJsFiles = fs.existsSync(astroAssetsDir)
      ? fs.readdirSync(astroAssetsDir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
      : [];
    assert(
      bundledJsFiles.length === 0,
      `Expected 0 bundled client JS chunks for pure-HTML FloatingWhatsApp + Layout, found: ${bundledJsFiles.join(", ")}`,
    );

    const invalidHtml = fs.readFileSync(
      path.join(fixtures.outDir, "invalid/index.html"),
      "utf8",
    );
    assert(
      !invalidHtml.includes('data-testid="floating-wa-widget"'),
      "Invalid phone must render NOTHING (fail-closed)",
    );
    assert(
      !invalidHtml.includes("javascript:alert"),
      "Invalid phone payload must never leak into SSR HTML",
    );

    const xssHtml = fs.readFileSync(
      path.join(fixtures.outDir, "xss-hours/index.html"),
      "utf8",
    );
    assert(
      !xssHtml.includes("<script>window.__t014Xss"),
      "Greeting HTML tags must be escaped in SSR output",
    );
    assert(
      !xssHtml.includes("Online sekarang"),
      "Fake live-presence claim must never appear in SSR output",
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
    // 1. No-JS Mode (`javaScriptEnabled: false`) @ 360px
    // -----------------------------------------------------------------------
    {
      const noJsCtx = await browser.newContext({
        viewport: { width: 360, height: 800 },
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsCtx.newPage();

      // 1A. Direct mode without JS
      await noJsPage.goto(`${server.baseUrl}/direct/`, { waitUntil: "load" });
      const directLink = noJsPage.locator('[data-testid="floating-wa-chat-link"]');
      assert(await directLink.isVisible(), "No-JS direct mode: WhatsApp link must be visible");
      const directAttrs = await directLink.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          href: el.getAttribute("href") ?? "",
          target: el.getAttribute("target") ?? "",
          rel: el.getAttribute("rel") ?? "",
          width: r.width,
          height: r.height,
        };
      });
      assert(
        directAttrs.href.startsWith("https://wa.me/6281234567890?text="),
        `No-JS direct link invalid href: ${directAttrs.href}`,
      );
      assert(directAttrs.target === "_blank", "No-JS direct link must use target=_blank");
      assert(
        directAttrs.rel.includes("noopener") && directAttrs.rel.includes("noreferrer"),
        `No-JS direct link must include noopener noreferrer, got "${directAttrs.rel}"`,
      );
      assert(
        directAttrs.width >= 44 && directAttrs.height >= 44,
        `No-JS direct link below 44px touch target (${directAttrs.width}x${directAttrs.height})`,
      );

      // 1B. Greeting popover mode without JS (<details>/<summary> works natively!)
      await noJsPage.goto(`${server.baseUrl}/greeting/`, { waitUntil: "load" });
      const noJsDetails = noJsPage.locator('[data-testid="floating-wa-details"]');
      const noJsTrigger = noJsPage.locator('[data-testid="floating-wa-trigger"]');
      const noJsCard = noJsPage.locator('[data-testid="floating-wa-card"]');
      const noJsChatLink = noJsPage.locator('[data-testid="floating-wa-chat-link"]');

      assert(await noJsTrigger.isVisible(), "No-JS greeting mode: trigger must be visible");
      assert(await noJsCard.isHidden(), "No-JS greeting mode: card starts closed");

      // Real wa.me <a> exists in DOM even before opening
      const domHref = await noJsChatLink.getAttribute("href");
      assert(
        domHref?.startsWith("https://wa.me/6281234567890?text="),
        `No-JS greeting mode: real wa.me link must exist in DOM without JS, got ${domHref}`,
      );

      // Open greeting popover natively without JS
      await noJsTrigger.click();
      assert(
        await noJsDetails.evaluate((el) => el.hasAttribute("open")),
        "No-JS greeting mode: <details> must open on click without JavaScript",
      );
      assert(await noJsCard.isVisible(), "No-JS greeting mode: card must become visible");
      assert(await noJsChatLink.isVisible(), "No-JS greeting mode: wa.me CTA must become visible");

      // Close greeting popover natively without JS
      await noJsTrigger.click();
      assert(
        !(await noJsDetails.evaluate((el) => el.hasAttribute("open"))),
        "No-JS greeting mode: <details> must close cleanly without JavaScript",
      );

      await noJsCtx.close();
    }

    // -----------------------------------------------------------------------
    // 2. Full JS Mode @ 360px & 1440px (Keyboard, Focus Return, Touch Targets, Consent Coordination)
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 2A. Mobile 360px with Consent Banner visible -> zero collision!
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/greeting/`, { waitUntil: "networkidle" });

    const mobileClosedAudit = await page.evaluate(() => {
      const trigger = document.querySelector('[data-testid="floating-wa-trigger"]');
      const banner = document.querySelector('[data-testid="consent-banner"]');
      const tr = trigger?.getBoundingClientRect();
      const br = banner?.getBoundingClientRect();
      const collidesWithBanner =
        Boolean(tr && br && !banner?.hasAttribute("hidden")) &&
        tr.bottom > br.top &&
        tr.top < br.bottom &&
        tr.right > br.left &&
        tr.left < br.right;
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        triggerRect: tr ? { top: tr.top, bottom: tr.bottom, left: tr.left, right: tr.right, width: tr.width, height: tr.height } : null,
        bannerRect: br ? { top: br.top, bottom: br.bottom, left: br.left, right: br.right } : null,
        collidesWithBanner,
      };
    });

    assert(
      !mobileClosedAudit.overflow,
      `Mobile 360px closed horizontal overflow (${mobileClosedAudit.scrollWidth} > ${mobileClosedAudit.innerWidth})`,
    );
    assert(
      !mobileClosedAudit.collidesWithBanner,
      `Mobile 360px FloatingWhatsApp trigger must NOT collide with Consent banner (trigger=${JSON.stringify(mobileClosedAudit.triggerRect)}, banner=${JSON.stringify(mobileClosedAudit.bannerRect)})`,
    );
    assert(
      mobileClosedAudit.triggerRect &&
        mobileClosedAudit.triggerRect.width >= 44 &&
        mobileClosedAudit.triggerRect.height >= 44,
      `Mobile 360px trigger below 44px (${JSON.stringify(mobileClosedAudit.triggerRect)})`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "wa-360-closed.png"),
        fullPage: false,
      });
    }

    // Open greeting popover @ 360px
    const trigger = page.locator('[data-testid="floating-wa-trigger"]');
    await trigger.click();
    await page.locator('[data-testid="floating-wa-card"]').waitFor({ state: "visible" });

    const mobileOpenAudit = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="floating-wa-card"]');
      const closeBtn = document.querySelector('[data-testid="floating-wa-close"]');
      const cta = document.querySelector('[data-testid="floating-wa-chat-link"]');
      const hours = document.querySelector('[data-testid="floating-wa-hours"]');
      const banner = document.querySelector('[data-testid="consent-banner"]');
      const cr = card?.getBoundingClientRect();
      const xr = closeBtn?.getBoundingClientRect();
      const ar = cta?.getBoundingClientRect();
      const br = banner?.getBoundingClientRect();
      const cardText = card?.innerText ?? "";
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        cardRect: cr ? { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, width: cr.width, height: cr.height } : null,
        closeRect: xr ? { width: xr.width, height: xr.height, hidden: closeBtn?.hasAttribute("hidden") } : null,
        ctaRect: ar ? { width: ar.width, height: ar.height } : null,
        bannerTop: br?.top ?? null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        hoursText: hours?.innerText ?? "",
        cardText,
        ctaHref: cta?.getAttribute("href") ?? "",
        ctaTarget: cta?.getAttribute("target") ?? "",
        ctaRel: cta?.getAttribute("rel") ?? "",
        detailsOpen: document.querySelector('[data-testid="floating-wa-details"]')?.hasAttribute("open") ?? false,
      };
    });

    assert(!mobileOpenAudit.overflow, "Mobile 360px open greeting must have zero horizontal overflow");
    assert(mobileOpenAudit.detailsOpen, "Mobile 360px: <details> must have open attribute when expanded");
    assert(
      mobileOpenAudit.cardRect &&
        mobileOpenAudit.cardRect.left >= 0 &&
        mobileOpenAudit.cardRect.right <= mobileOpenAudit.innerWidth &&
        mobileOpenAudit.cardRect.top >= 0,
      `Mobile 360px greeting card must stay within viewport bounds: ${JSON.stringify(mobileOpenAudit.cardRect)}`,
    );
    assert(
      mobileOpenAudit.closeRect &&
        !mobileOpenAudit.closeRect.hidden &&
        mobileOpenAudit.closeRect.width >= 44 &&
        mobileOpenAudit.closeRect.height >= 44,
      `Mobile 360px close button must be visible and >= 44px: ${JSON.stringify(mobileOpenAudit.closeRect)}`,
    );
    assert(
      mobileOpenAudit.ctaRect && mobileOpenAudit.ctaRect.height >= 44 && mobileOpenAudit.ctaRect.width >= 44,
      `Mobile 360px WhatsApp CTA below 44px: ${JSON.stringify(mobileOpenAudit.ctaRect)}`,
    );
    assert(
      mobileOpenAudit.hoursText.includes("Senin–Jumat 08.30–17.00 WIB"),
      `Expected configured operating hours in card, got "${mobileOpenAudit.hoursText}"`,
    );
    assert(
      !/online\s+sekarang|sedang\s+aktif|balas\s+dalam\s+\d/i.test(mobileOpenAudit.cardText),
      `Greeting card must NEVER imply live online presence: "${mobileOpenAudit.cardText}"`,
    );
    assert(
      mobileOpenAudit.ctaHref.startsWith("https://wa.me/6281234567890?text=") &&
        mobileOpenAudit.ctaTarget === "_blank" &&
        mobileOpenAudit.ctaRel.includes("noopener") &&
        mobileOpenAudit.ctaRel.includes("noreferrer"),
      `Invalid CTA link attributes: ${JSON.stringify(mobileOpenAudit)}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "wa-360-open.png"),
        fullPage: false,
      });
    }

    // Escape closes popover and returns focus to trigger with >= 2px focus ring
    await page.keyboard.press("Escape");
    const afterEscape360 = await page.evaluate(() => {
      const details = document.querySelector('[data-testid="floating-wa-details"]');
      const active = document.activeElement;
      const cs = active ? getComputedStyle(active) : null;
      return {
        isOpen: details?.hasAttribute("open") ?? false,
        activeTestId: active?.getAttribute("data-testid") ?? "",
        outlineStyle: cs?.outlineStyle ?? "none",
        outlineWidth: cs ? parseFloat(cs.outlineWidth) : 0,
      };
    });
    assert(!afterEscape360.isOpen, "360px: Escape must close greeting popover");
    assert(
      afterEscape360.activeTestId === "floating-wa-trigger",
      `360px: Escape must return focus to floating-wa-trigger, got "${afterEscape360.activeTestId}"`,
    );
    assert(
      afterEscape360.outlineStyle !== "none" && afterEscape360.outlineWidth >= 2,
      `360px: trigger focus ring must be >= 2px, got ${JSON.stringify(afterEscape360)}`,
    );

    // Explicit close button closes popover & returns focus to trigger
    await trigger.click();
    await page.locator('[data-testid="floating-wa-close"]').click();
    const afterCloseBtn = await page.evaluate(() => ({
      isOpen: document.querySelector('[data-testid="floating-wa-details"]')?.hasAttribute("open") ?? false,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    assert(!afterCloseBtn.isOpen, "Close button must close greeting popover");
    assert(
      afterCloseBtn.activeTestId === "floating-wa-trigger",
      `Close button must return focus to trigger, got "${afterCloseBtn.activeTestId}"`,
    );

    // Dismissing consent banner smoothly restores widget dock offset to 0px
    await page.locator('[data-testid="consent-reject-optional"]').click();
    await page.waitForTimeout(50);
    const offsetAfterConsent = await page.evaluate(() =>
      document.querySelector('[data-ps-wa-root]')?.style.getPropertyValue("--ps-wa-offset").trim(),
    );
    assert(
      offsetAfterConsent === "0px",
      `After dismissing consent banner, --ps-wa-offset must reset to 0px, got "${offsetAfterConsent}"`,
    );

    // 2B. Desktop 1440px (with fresh page where consent banner is visible)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.context().clearCookies();
    await page.goto(`${server.baseUrl}/greeting/`, { waitUntil: "networkidle" });

    await page.locator('[data-testid="floating-wa-trigger"]').click();
    await page.locator('[data-testid="floating-wa-card"]').waitFor({ state: "visible" });

    const desktopOpenAudit = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="floating-wa-card"]');
      const triggerEl = document.querySelector('[data-testid="floating-wa-trigger"]');
      const banner = document.querySelector('[data-testid="consent-banner"]');
      const cr = card?.getBoundingClientRect();
      const tr = triggerEl?.getBoundingClientRect();
      const br = banner?.getBoundingClientRect();
      const cardCollidesBanner =
        Boolean(cr && br && !banner?.hasAttribute("hidden")) &&
        cr.bottom > br.top &&
        cr.top < br.bottom &&
        cr.right > br.left &&
        cr.left < br.right;
      const triggerCollidesBanner =
        Boolean(tr && br && !banner?.hasAttribute("hidden")) &&
        tr.bottom > br.top &&
        tr.top < br.bottom &&
        tr.right > br.left &&
        tr.left < br.right;
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        cardCollidesBanner,
        triggerCollidesBanner,
        cardRect: cr ? { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom } : null,
      };
    });

    assert(!desktopOpenAudit.overflow, "Desktop 1440px must have zero horizontal overflow");
    assert(
      !desktopOpenAudit.triggerCollidesBanner && !desktopOpenAudit.cardCollidesBanner,
      `Desktop 1440px widget must not collide with consent banner: ${JSON.stringify(desktopOpenAudit)}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "wa-1440-open.png"),
        fullPage: false,
      });
    }

    await page.keyboard.press("Escape");
    const afterEscape1440 = await page.evaluate(() => ({
      isOpen: document.querySelector('[data-testid="floating-wa-details"]')?.hasAttribute("open") ?? false,
      activeTestId: document.activeElement?.getAttribute("data-testid") ?? "",
    }));
    assert(!afterEscape1440.isOpen, "1440px: Escape must close greeting popover");
    assert(
      afterEscape1440.activeTestId === "floating-wa-trigger",
      `1440px: Escape must return focus to trigger, got "${afterEscape1440.activeTestId}"`,
    );

    // 2C. Invalid phone page -> renders nothing
    await page.goto(`${server.baseUrl}/invalid/`, { waitUntil: "networkidle" });
    const invalidCount = await page.locator('[data-testid="floating-wa-widget"]').count();
    assert(invalidCount === 0, `Invalid phone page must render 0 widgets, found ${invalidCount}`);

    // 2D. XSS & fake-presence guard page
    await page.goto(`${server.baseUrl}/xss-hours/`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="floating-wa-trigger"]').click();
    const xssAudit = await page.evaluate(() => ({
      xssExecuted: Boolean(window.__t014Xss),
      greetingText: document.querySelector('[data-testid="floating-wa-greeting"]')?.textContent ?? "",
      hoursExists: Boolean(document.querySelector('[data-testid="floating-wa-hours"]')),
    }));
    assert(!xssAudit.xssExecuted, "Hostile greeting/name must NEVER execute XSS");
    assert(
      xssAudit.greetingText.includes("<script>window.__t014Xss=true</script>"),
      `Greeting text must be safely escaped as literal text, got "${xssAudit.greetingText}"`,
    );
    assert(!xssAudit.hoursExists, "Fake live-presence operatingHours must be suppressed from DOM");

    // 2E. prefers-reduced-motion check
    const reducedCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      reducedMotion: "reduce",
    });
    const reducedPage = await reducedCtx.newPage();
    await reducedPage.goto(`${server.baseUrl}/greeting/`, { waitUntil: "networkidle" });
    const reducedTransition = await reducedPage.evaluate(() => {
      const el = document.querySelector('[data-testid="floating-wa-trigger"]');
      return el ? getComputedStyle(el).transitionDuration : "";
    });
    assert(
      reducedTransition === "0s",
      `prefers-reduced-motion must keep transitionDuration 0s, got "${reducedTransition}"`,
    );
    await reducedCtx.close();

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-014 E2E PASS: Real Layout.astro + FloatingWhatsApp.astro verified — No-JS wa.me chat & native <details> greeting, invalid phone fail-closed, XSS/fake-presence guards, 360px/1440px zero overflow & zero consent-banner collision, >=44px touch targets, Escape & close-button focus return with >=2px ring, reduced-motion, 0 bundled JS chunks, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-014 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

await main();
