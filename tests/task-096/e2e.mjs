/* global Buffer, process, console, document, structuredClone, URL */
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

const screenshotDir = process.env.TASK096_SCREENSHOT_DIR || "/tmp/task-096-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

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

function renderPreviewHtml({ themeId, themeName, styleVariantId, entitled, primary, surface, ink }) {
  return `<!doctype html>
<html lang="id" data-ps-theme="${themeId}" data-ps-style-variant="${styleVariantId}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Pratinjau ${themeName} — Karya Nusantara</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: ${surface}; color: ${ink}; }
      .bar { background: ${primary}; color: ${surface === "#0f172a" || surface === "#10131a" ? "#050505" : "#ffffff"}; padding: 10px 16px; font-size: 12px; font-weight: 700; }
      .wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px; }
      .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; margin-top: 16px; }
    </style>
  </head>
  <body data-preview="true" data-theme-id="${themeId}" data-entitled="${entitled ? "true" : "false"}">
    <div class="bar">Pratinjau Draf (no-store, noindex) — ${themeName} (${styleVariantId})</div>
    <main class="wrap">
      <h1>Karya Nusantara Arsitektur &amp; Konstruksi</h1>
      <p>Seluruh halaman, artikel, dan penawaran tetap 100% utuh saat mengganti varian gaya atau tema.</p>
      <div class="card">
        <h2>Desain Bangunan Komersial</h2>
        <p>Konsultasi langsung melalui WhatsApp tanpa keranjang belanja.</p>
      </div>
    </main>
  </body>
</html>`;
}

async function buildThemeStoreFixture() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t096-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const themeLibraryImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/appearance/themes/_ThemeLibrary.tsx",
  );
  const themeRegistryImport = path.join(webDir, "src/core/theme-registry.ts");
  const themeCoreImport = path.join(root, "packages/core/src/theme/index.ts");
  const variantsCoreImport = path.join(root, "packages/core/src/theme/variants.ts");
  const premiumCatalogImport = path.join(webDir, "src/themes/premium/catalog.ts");

  fs.writeFileSync(
    path.join(pagesDir, "themes.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeLibrary } from ${JSON.stringify(themeLibraryImport)};
import {
  buildThemeCompatibilityCandidate,
  listGrantedThemesForTenant,
} from ${JSON.stringify(themeRegistryImport)};
import { evaluateThemeCompatibility } from ${JSON.stringify(themeCoreImport)};
import {
  getStyleVariantsForTheme,
  verifyStyleVariantContrast,
} from ${JSON.stringify(variantsCoreImport)};
import { CURATED_PREMIUM_THEMES } from ${JSON.stringify(premiumCatalogImport)};

const grantedEntries = listGrantedThemesForTenant({
  tenantId: "01JT096E2ETENANT0000000001",
  tenantStatus: "active",
  tenantGrants: [],
});

const tenantSections = [
  { id: "sec-hero", type: "hero", schemaVersion: 1, enabled: true },
  { id: "sec-offerings", type: "offerings_grid", schemaVersion: 1, enabled: true },
  { id: "sec-faq", type: "faq", schemaVersion: 1, enabled: true },
];

function mapVariant(v) {
  const report = verifyStyleVariantContrast(v);
  return {
    id: v.id,
    styleVariantKey: v.styleVariantKey,
    themeId: v.themeId,
    name: v.name,
    tagline: v.tagline,
    density: v.density,
    mood: v.mood,
    isDefault: v.isDefault,
    fontLabel: v.fontLabel,
    swatches: v.swatches,
    wcagAaPassed: report.passed,
    minContrastRatio: report.minRatio,
    customFontCount: report.customFontCount,
  };
}

const themes = grantedEntries.map((entry) => ({
  id: entry.id,
  slug: entry.slug,
  name: entry.name,
  description: entry.description,
  version: entry.version,
  schemaVersion: entry.schemaVersion,
  tier: entry.tier,
  isCustom: entry.isCustom,
  isActive: entry.id === "compro",
  isRecommended: entry.id === "compro",
  grantSource: "platform_included",
  grantedAt: null,
  hasSavedConfig: false,
  savedConfigUpdatedAt: null,
  savedTokens: null,
  defaultTokens: entry.defaultTokens,
  palette: entry.palette,
  recommendedOfferingTypes: entry.recommendedOfferingTypes,
  supportedRoutes: entry.supportedRoutes,
  supportedSectionTypes: entry.supportedSectionTypes,
  compatibility: evaluateThemeCompatibility(buildThemeCompatibilityCandidate(entry), {
    vertical: "compro",
    blogEnabled: true,
    catalogEnabled: true,
    sections: tenantSections,
  }),
  styleVariants: getStyleVariantsForTheme(entry.id).map(mapVariant),
  activeStyleVariantId: getStyleVariantsForTheme(entry.id)[0]?.styleVariantKey ?? "default",
}));

const premiumThemes = CURATED_PREMIUM_THEMES.map((p) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  tagline: p.tagline,
  description: p.description,
  version: p.version,
  schemaVersion: p.schemaVersion,
  tier: "paid_once",
  priceIdr: p.priceIdr,
  basePlatformThemeId: p.basePlatformThemeId,
  entitled: false,
  entitledAt: null,
  isActive: false,
  palette: p.palette,
  defaultTokens: p.defaultTokens,
  styleVariants: p.styleVariants.map(mapVariant),
  activeStyleVariantId: p.styleVariants[0]?.styleVariantKey ?? "default",
  recommendedOfferingTypes: p.recommendedOfferingTypes,
  supportedRoutes: p.supportedRoutes,
  supportedSectionTypes: p.supportedSectionTypes,
  compatibility: evaluateThemeCompatibility(
    {
      id: p.id,
      name: p.name,
      schemaVersion: 1,
      tier: "paid_once",
      basePlatformThemeId: p.basePlatformThemeId,
      supportedSectionTypes: p.supportedSectionTypes,
      supportedRoutes: p.supportedRoutes,
      recommendedOfferingTypes: p.recommendedOfferingTypes,
    },
    { vertical: "compro", blogEnabled: true, catalogEnabled: true, sections: tenantSections },
  ),
  latestOrder: null,
  receipt: null,
}));

const initialState = {
  tenantId: "01JT096E2ETENANT0000000001",
  handle: "karya-nusantara",
  vertical: "compro",
  activeThemeId: "compro",
  activeStyleVariantId: "clean-modern",
  version: 1,
  cacheVersion: 1,
  themes,
  premiumThemes,
  receipts: [],
  contentSummary: { pages: 4, posts: 6, offerings: 8, menus: 2, media: 14 },
  permissions: {
    canPreview: true,
    canActivate: true,
    isLocked: false,
    role: "owner",
    tenantStatus: "active",
  },
  updatedAt: "2026-11-23T06:00:00.000Z",
};
---
<DashboardLayout
  title="Tema & Varian Gaya — Karya Nusantara"
  surface="dashboard"
  workspaceName="Karya Nusantara"
  workspaceSubtitle="karya-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/karya-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://karya-nusantara.situsku.click"
  userDisplayName="Budi Owner"
  userRoleLabel="Pemilik Situs"
>
  <ThemeLibrary
    client:load
    tenantHandle="karya-nusantara"
    workspaceName="Karya Nusantara"
    themesApiUrl="/api/tenants/karya-nusantara/themes"
    previewApiUrl="/api/tenants/karya-nusantara/themes/preview"
    activateApiUrl="/api/tenants/karya-nusantara/themes/activate"
    variantsApiUrl="/api/tenants/karya-nusantara/themes/variants"
    checkoutApiUrl="/api/tenants/karya-nusantara/themes/checkout"
    receiptsBaseUrl="/api/tenants/karya-nusantara/themes/receipts"
    customThemeServiceHref="/dashboard/karya-nusantara/appearance/themes/custom"
    customizerHref="/dashboard/karya-nusantara/appearance"
    initialState={initialState}
  />
</DashboardLayout>
`,
  );

  const [{ build }, reactPlugin, tailwindcssPlugin] = await Promise.all([
    import(astroEntryUrl),
    import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href),
    import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href),
  ]);

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    devToolbar: { enabled: false },
    integrations: [reactPlugin.default()],
    vite: {
      plugins: [tailwindcssPlugin.default()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
  });

  return { tmpRoot, outDir };
}

function startStaticAndApiServer(outDir) {
  let stateVersion = 1;
  let cacheVersion = 1;
  let activeThemeId = "compro";
  let activeStyleVariantId = "clean-modern";
  let atelierEntitled = false;
  let atelierReceipt = null;

  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };

  let initialStateSnapshot = null;

  function buildCurrentState() {
    const base = structuredClone(initialStateSnapshot);
    base.version = stateVersion;
    base.cacheVersion = cacheVersion;
    base.activeThemeId = activeThemeId;
    base.activeStyleVariantId = activeStyleVariantId;
    for (const t of base.themes) {
      t.isActive = t.id === activeThemeId;
      if (t.id === activeThemeId) t.activeStyleVariantId = activeStyleVariantId;
    }
    for (const p of base.premiumThemes) {
      if (p.id === "premium-atelier-editorial") {
        p.entitled = atelierEntitled;
        p.entitledAt = atelierEntitled ? "2026-11-23T06:10:00.000Z" : null;
        p.isActive = activeThemeId === p.id;
        p.receipt = atelierReceipt;
      }
    }
    base.receipts = atelierReceipt ? [atelierReceipt] : [];
    return base;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/tenants/karya-nusantara/themes" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(JSON.stringify(buildCurrentState()));
      return;
    }

    if (url.pathname === "/api/tenants/karya-nusantara/themes/preview" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const isPrem = body.themeId === "premium-atelier-editorial";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(
        JSON.stringify({
          html: renderPreviewHtml({
            themeId: body.themeId,
            themeName: isPrem ? "Atelier Editorial Pro" : "Corporate / B2B Compro",
            styleVariantId: body.styleVariantId || (isPrem ? "ivory-obsidian" : "clean-modern"),
            entitled: isPrem ? atelierEntitled : true,
            primary: isPrem ? "#1c2434" : "#176b51",
            surface: body.styleVariantId === "dark-executive" ? "#0f172a" : "#ffffff",
            ink: body.styleVariantId === "dark-executive" ? "#f8fafc" : "#111c19",
          }),
          themeId: body.themeId,
          themeName: isPrem ? "Atelier Editorial Pro" : "Corporate / B2B Compro",
          styleVariantId: body.styleVariantId || "default",
          tier: isPrem ? "paid_once" : "included",
          entitled: isPrem ? atelierEntitled : true,
          isCustom: false,
          sandbox: "",
          compatibility: {
            compatible: true,
            supportedSections: ["hero", "offerings_grid", "faq"],
            unsupportedSections: [],
            blockingReasons: [],
            warnings: [],
            fallbackNotes: [],
            schemaVersion: 1,
            expectedSchemaVersion: 1,
          },
          hasSavedConfig: false,
          isPreview: true,
          version: stateVersion,
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/karya-nusantara/themes/variants" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      activeThemeId = body.themeId || activeThemeId;
      activeStyleVariantId = body.styleVariantId;
      stateVersion += 1;
      cacheVersion += 1;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ...buildCurrentState(),
          activatedThemeId: activeThemeId,
          previousThemeId: activeThemeId,
          recoveredExistingConfig: false,
          activatedAt: "2026-11-23T06:05:00.000Z",
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/karya-nusantara/themes/checkout" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const hasCoupon = (body.couponCode || "").toUpperCase() === "HEMAT20";
      const discount = hasCoupon ? 99800 : 0;
      const net = 499000 - discount;
      // Simulate immediate post-settlement unlock when reloading after checkout
      atelierEntitled = true;
      atelierReceipt = {
        id: "rcpt_t096_e2e_1",
        receiptNumber: "INV-THM-2026-000001",
        tenantId: "01JT096E2ETENANT0000000001",
        themeId: "premium-atelier-editorial",
        orderId: "ord_t096_e2e_1",
        entitlementId: "ent_t096_e2e_1",
        payerUserId: "usr_owner",
        currency: "IDR",
        baseAmountIdr: 499000,
        discountAmountIdr: discount,
        channelFeeIdr: 0,
        totalAmountIdr: net,
        couponCode: hasCoupon ? "HEMAT20" : null,
        paymentChannel: body.channelCode || "QRIS",
        providerReference: "AL-THM-E2E-001",
        r2ObjectKey: "platform/theme-receipts/2026/INV-THM-2026-000001.pdf",
        pdfSha256: "e2esha256",
        pdfByteLength: 2048,
        nonPkpNotice: "Harga belum termasuk PPN (non-PKP).",
        issuedAtMs: Date.UTC(2026, 10, 23, 6, 10, 0),
        issuedAtIso: "2026-11-23T06:10:00.000Z",
        createdAtMs: Date.UTC(2026, 10, 23, 6, 10, 0),
        createdAtIso: "2026-11-23T06:10:00.000Z",
      };
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          order: {
            id: "ord_t096_e2e_1",
            themeId: body.themeId,
            status: "pending",
            basePriceIdr: 499000,
            discountAmountIdr: discount,
            netBaseAmountIdr: net,
            channelCode: body.channelCode || "QRIS",
            channelFeeIdr: 0,
            totalPayableIdr: net,
            couponCode: hasCoupon ? "HEMAT20" : null,
            providerReffId: "PSTHM2026E2E001",
            providerTransactionId: "AL-THM-E2E-001",
            paymentInstructions: { method: "QRIS" },
          },
          idempotentReplay: false,
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/karya-nusantara/themes/activate" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prev = activeThemeId;
      activeThemeId = body.themeId;
      activeStyleVariantId = body.styleVariantId || "ivory-obsidian";
      stateVersion += 1;
      cacheVersion += 1;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ...buildCurrentState(),
          activatedThemeId: activeThemeId,
          previousThemeId: prev,
          recoveredExistingConfig: false,
          activatedAt: "2026-11-23T06:12:00.000Z",
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/api/tenants/karya-nusantara/themes/receipts/")) {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(Buffer.from("%PDF-1.4\n%PunyaSitus Receipt\n%%EOF\n"));
      return;
    }

    // Serve static Astro output
    let filePath = path.join(outDir, url.pathname === "/" ? "themes/index.html" : url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(filePath));
  });

  return {
    server,
    setInitialSnapshot(snap) {
      initialStateSnapshot = snap;
    },
  };
}

async function run() {
  const { tmpRoot, outDir } = await buildThemeStoreFixture();
  const { server, setInitialSnapshot } = startStaticAndApiServer(outDir);

  // Extract serialized initialState from the ThemeLibrary astro-island props
  const html = fs.readFileSync(path.join(outDir, "themes/index.html"), "utf8");
  const allProps = [...html.matchAll(/props="([^"]+)"/g)].map((m) => m[1]);
  const themePropsRaw = allProps.find((p) => p.includes("initialState"));
  assert(themePropsRaw, "Expected ThemeLibrary astro-island props with initialState");
  const decodedProps = themePropsRaw
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Unwrap Astro serialized prop tuples [0, val] / [1, arr]
  function unwrapAstro(node) {
    if (!Array.isArray(node)) return node;
    const [kind, val] = node;
    if (kind === 0) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = unwrapAstro(v);
        return out;
      }
      return val;
    }
    if (kind === 1 && Array.isArray(val)) {
      return val.map(unwrapAstro);
    }
    return val;
  }
  const parsedIslandProps = JSON.parse(decodedProps);
  setInitialSnapshot(unwrapAstro(parsedIslandProps.initialState));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/themes/`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    // 1. Desktop 1440px journey
    const ctx1440 = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await ctx1440.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator('[data-testid="theme-library-root"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="style-variant-picker"]').waitFor({ state: "visible" });

    // Verify zero horizontal overflow at 1440px
    const overflow1440 = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      const sw = document.documentElement.scrollWidth;
      if (sw <= cw) return null;
      const culprits = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.right > cw + 1) {
          culprits.push({
            tag: el.tagName,
            testid: el.getAttribute("data-testid"),
            cls: String(el.className).slice(0, 80),
            right: Math.round(r.right),
            cw,
          });
        }
      }
      return { sw, cw, culprits: culprits.slice(0, 8) };
    });
    assert(
      !overflow1440,
      `1440px viewport must have zero horizontal overflow: ${JSON.stringify(overflow1440)}`,
    );

    await page.screenshot({
      path: path.join(screenshotDir, "01-desktop-1440-theme-store-and-variants.png"),
      fullPage: true,
    });

    // Apply Style Variant ("dark-executive") via swatch picker
    await page.locator('[data-testid="btn-apply-variant-dark-executive"]').click();
    await page.locator('[data-testid="theme-success-banner"]').waitFor({ state: "visible" });
    const selectedAttr = await page
      .locator('[data-testid="style-variant-card-dark-executive"]')
      .getAttribute("data-variant-selected");
    assert(selectedAttr === "true", "dark-executive style variant should become selected");

    // Switch to Premium tab & open unpurchased draft preview
    await page.locator('[data-testid="filter-tab-premium"]').click();
    await page.locator('[data-testid="premium-theme-store-section"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="btn-preview-premium-premium-atelier-editorial"]').click();
    await page.locator('[data-testid="compatibility-preview-dialog"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="preview-unpurchased-badge"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="theme-compatibility-iframe"]').waitFor({ state: "visible" });

    const iframeSrcDoc = await page
      .locator('[data-testid="theme-compatibility-iframe"]')
      .getAttribute("srcdoc");
    assert(
      iframeSrcDoc && iframeSrcDoc.includes('name="robots" content="noindex, nofollow"'),
      "Unpurchased premium preview HTML must include noindex, nofollow meta tag",
    );

    await page.screenshot({
      path: path.join(screenshotDir, "02-desktop-1440-unpurchased-premium-preview.png"),
      fullPage: false,
    });

    // Click Beli Sekali from preview -> enter coupon HEMAT20 -> create checkout -> reload -> unlocked + receipt!
    await page.locator('[data-testid="btn-buy-from-preview"]').click();
    await page.locator('[data-testid="theme-checkout-dialog"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="input-theme-coupon"]').fill("HEMAT20");
    await page.locator('[data-testid="btn-submit-checkout"]').click();
    await page.locator('[data-testid="checkout-order-summary"]').waitFor({ state: "visible" });

    await page.screenshot({
      path: path.join(screenshotDir, "03-desktop-1440-checkout-with-coupon.png"),
      fullPage: false,
    });

    await page.locator('[data-testid="btn-close-checkout-order"]').click();
    await page
      .locator('[data-testid="badge-entitled-premium-atelier-editorial"]')
      .waitFor({ state: "visible" });
    await page
      .locator('[data-testid="premium-receipt-bar-premium-atelier-editorial"]')
      .waitFor({ state: "visible" });

    // Activate unlocked premium theme
    await page.locator('[data-testid="btn-activate-premium-premium-atelier-editorial"]').click();
    await page.locator('[data-testid="btn-confirm-activate"]').click();
    await page.locator('[data-testid="theme-success-banner"]').waitFor({ state: "visible" });

    await page.screenshot({
      path: path.join(screenshotDir, "04-desktop-1440-post-settlement-unlocked-receipt.png"),
      fullPage: true,
    });

    // Check Kustom tab shows Custom Dev CTA
    await page.locator('[data-testid="filter-tab-custom"]').click();
    await page.locator('[data-testid="custom-dev-cta-card"]').waitFor({ state: "visible" });

    await ctx1440.close();

    // 2. Mobile 360px journey (zero overflow + >=44px touch targets)
    const ctx360 = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const mobilePage = await ctx360.newPage();
    mobilePage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    mobilePage.on("pageerror", (err) => pageErrors.push(String(err)));

    await mobilePage.goto(baseUrl, { waitUntil: "networkidle" });
    await mobilePage.locator('[data-testid="theme-library-root"]').waitFor({ state: "visible" });
    await mobilePage.locator('[data-testid="style-variant-picker"]').waitFor({ state: "visible" });

    const overflow360 = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert(!overflow360, "360px mobile viewport must have zero horizontal overflow");

    // Verify >= 44px touch targets on primary interactive controls in Theme Store & Style Variant picker
    const touchTargetViolations = await mobilePage.evaluate(() => {
      const selectors = [
        '[data-testid^="filter-tab-"]',
        '[data-testid^="btn-apply-variant-"]',
        '[data-testid^="btn-preview-variant-"]',
        '[data-testid="btn-refresh-themes"]',
        '[data-testid="link-theme-customizer"]',
      ];
      const bad = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.height < 43.5) {
            bad.push({ testid: el.getAttribute("data-testid"), height: Math.round(rect.height) });
          }
        }
      }
      return bad;
    });
    assert(
      touchTargetViolations.length === 0,
      `Mobile touch targets < 44px found: ${JSON.stringify(touchTargetViolations)}`,
    );

    await mobilePage.screenshot({
      path: path.join(screenshotDir, "05-mobile-360-theme-store-and-variants.png"),
      fullPage: true,
    });

    await ctx360.close();

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log("TASK-096 Playwright E2E passed (360px & 1440px, zero overflow, >=44px targets, zero errors).");
    console.log(`Screenshots saved to: ${screenshotDir}`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
