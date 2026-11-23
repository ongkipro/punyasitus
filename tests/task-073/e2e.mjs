/* global process, console, document, window, structuredClone, URL */
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

const screenshotDir = process.env.TASK073_SCREENSHOT_DIR || "/tmp/task-073-screenshots";
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

function createInitialSettingsState() {
  const baseSnapshot = {
    general: {
      siteTitle: "Klinik Sehat Nusantara",
      tagline: "Perawatan Keluarga Terpercaya",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      logoMediaId: null,
      logoLightMediaId: null,
      logoDarkMediaId: null,
      faviconMediaId: null,
      publicEmail: "halo@kliniknusantara.co.id",
    },
    business: {
      businessName: "PT Klinik Sehat Nusantara",
      businessCategory: "LocalBusiness",
      description: "Layanan kesehatan gigi dan umum untuk keluarga Indonesia.",
      phone: "62215551234",
      whatsappE164: "6281234567890",
      email: "halo@kliniknusantara.co.id",
      address: "Jl. Kesehatan No. 18",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12160",
      latitude: null,
      longitude: null,
      mapsUrl: "https://maps.google.com/maps?cid=1234567890",
      googleMapsReviewUrl: null,
      weekdayHours: "Senin–Jumat 08.00–20.00 WIB",
      holidayHours: "Sabtu 09.00–15.00 WIB",
      serviceAreas: ["Jakarta Selatan"],
      socialLinks: [],
    },
    reading: {
      homepageMode: "modular",
      homepagePageId: null,
      blogEnabled: true,
      catalogEnabled: true,
      enabledOfferingTypes: ["service", "product", "tour", "vehicle"],
      itemsPerPage: 12,
      fixedRoutes: {
        blog: "/blog",
        offerings: {
          service: "/layanan",
          product: "/produk",
          tour: "/tour",
          vehicle: "/kendaraan",
        },
      },
    },
    seo: {
      defaultTitle: "Klinik Sehat Nusantara — Jakarta",
      defaultDescription: "Klinik keluarga modern dengan dokter berpengalaman.",
      ogImageMediaId: null,
      siteVisibility: "public",
      aiTrainingPolicy: "allow",
      googleSiteVerification: null,
      bingSiteVerification: null,
    },
    privacy: {
      privacyPageId: 2,
      consentBannerText: "Kami hanya mengaktifkan cookie analitik setelah persetujuan Anda.",
      consentPolicyVersion: 1,
    },
    analytics: {
      ga4MeasurementId: null,
      metaPixelId: null,
      tiktokPixelId: null,
    },
  };

  return {
    draft: structuredClone(baseSnapshot),
    published: structuredClone(baseSnapshot),
    version: 2,
    draftVersion: 2,
    publishedVersion: 2,
    versions: { siteSettings: 2, businessProfile: 2, groupedSettings: 2 },
    hasUnpublishedChanges: false,
    publishedAt: "2026-11-23T01:00:00.000Z",
    contentModifiedAt: "2026-11-23T01:00:00.000Z",
    updatedAt: "2026-11-23T01:00:00.000Z",
    availablePages: [
      { id: 1, slug: "beranda", title: "Beranda Utama", status: "published", isHomepage: true, isPublished: true },
      { id: 2, slug: "kebijakan-privasi", title: "Kebijakan Privasi", status: "published", isHomepage: false, isPublished: true },
    ],
  };
}

async function buildTask073Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t073-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const workspaceImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/settings/_GroupedSettingsWorkspace.tsx",
  );
  const publicSectionsCssImport = path.join(webDir, "src/themes/default/sections/sections.css");
  const testimonialsImport = path.join(
    webDir,
    "src/themes/default/sections/SectionTestimonials.astro",
  );
  const contactFormImport = path.join(
    webDir,
    "src/themes/default/sections/SectionContactForm.astro",
  );
  const initialStateLiteral = JSON.stringify(createInitialSettingsState());

  // 1. Settings UI (Owner active, Bisnis tab)
  fs.writeFileSync(
    path.join(pagesDir, "settings-business.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { GroupedSettingsWorkspace } from ${JSON.stringify(workspaceImport)};
const initialState = ${initialStateLiteral};
const ownerPermissions = {
  role: "owner",
  roleLabel: "Pemilik Situs",
  tenantStatus: "active",
  isLocked: false,
  canReadSettings: true,
  canWriteSettings: true,
  canPublishSettings: true,
  canManageDomains: true,
  canManageMembers: true,
  canAccessBilling: true,
};
---
<DashboardLayout
  title="Pengaturan Bisnis & Ulasan Google — Klinik Sehat Nusantara"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-sehat.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/klinik-sehat"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-sehat.situsku.click"
  userDisplayName="Budi Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <GroupedSettingsWorkspace
    client:load
    handle="klinik-sehat"
    basePath="/dashboard/klinik-sehat"
    publicSiteHref="https://klinik-sehat.situsku.click"
    initialTab="business"
    permissions={ownerPermissions}
    initialState={initialState}
  />
</DashboardLayout>
`,
  );

  // 2. Settings UI (Editor read-only state)
  const editorState = createInitialSettingsState();
  editorState.draft.business.googleMapsReviewUrl = "https://g.page/r/Cf1234567890_EBM/review";
  editorState.published.business.googleMapsReviewUrl = "https://g.page/r/Cf1234567890_EBM/review";
  fs.writeFileSync(
    path.join(pagesDir, "settings-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { GroupedSettingsWorkspace } from ${JSON.stringify(workspaceImport)};
const initialState = ${JSON.stringify(editorState)};
const editorPermissions = {
  role: "editor",
  roleLabel: "Editor",
  tenantStatus: "active",
  isLocked: false,
  canReadSettings: false,
  canWriteSettings: false,
  canPublishSettings: false,
  canManageDomains: false,
  canManageMembers: false,
  canAccessBilling: false,
};
---
<DashboardLayout
  title="Pengaturan Bisnis (Editor Read-Only)"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-sehat.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/klinik-sehat"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-sehat.situsku.click"
  userDisplayName="Siti Editor"
  userRoleLabel="Editor"
>
  <GroupedSettingsWorkspace
    client:load
    handle="klinik-sehat"
    basePath="/dashboard/klinik-sehat"
    publicSiteHref="https://klinik-sehat.situsku.click"
    initialTab="business"
    permissions={editorPermissions}
    initialState={initialState}
  />
</DashboardLayout>
`,
  );

  // 3. Public Testimonials & Contact page WITH valid Google Maps review link + LocalBusiness JSON-LD (zero Review/AggregateRating)
  const sampleJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "LocalBusiness",
        "@id": "https://klinik-sehat.situsku.click/#business",
        name: "PT Klinik Sehat Nusantara",
        url: "https://klinik-sehat.situsku.click/",
        hasMap: "https://maps.google.com/maps?cid=1234567890",
      },
    ],
  });

  fs.writeFileSync(
    path.join(pagesDir, "public-with-review.astro"),
    `---
import ${JSON.stringify(publicSectionsCssImport)};
import SectionTestimonials from ${JSON.stringify(testimonialsImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};

const reviewUrl = "https://g.page/r/Cf1234567890_EBM/review";
const testimonialsConfig = {
  eyebrow: "Testimoni Pelanggan",
  heading: "Dipercaya Keluarga Indonesia",
  subheading: "Pengalaman langsung dari pasien dan mitra usaha kami.",
  items: [
    {
      quote: "Pelayanan ramah, jadwal konsultasi tepat waktu, dan informasi biaya sangat jelas.",
      authorName: "Rina Wijaya",
      authorRole: "Pasien",
      contextLabel: "Jakarta Selatan",
    },
    {
      quote: "Tempat bersih dan penjelasan dokter mudah dipahami untuk seluruh keluarga.",
      authorName: "Hendra Pratama",
      authorRole: "Klien Korporat",
      contextLabel: "Tangerang",
    },
  ],
};
const jsonLd = ${JSON.stringify(sampleJsonLd)};
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Klinik Sehat Nusantara — Testimoni & Kontak</title>
    <script type="application/ld+json" set:html={jsonLd} />
    <style>
      :root {
        --ps-surface: #ffffff;
        --ps-surface-muted: #f4f7f5;
        --ps-ink: #182522;
        --ps-ink-muted: #52635c;
        --ps-border: #d9e2dd;
        --ps-brand-primary: #176b51;
        --ps-brand-on-primary: #ffffff;
        --ps-radius: 8px;
        --ps-radius-sm: 6px;
        --ps-radius-lg: 12px;
        --ps-font-sans: system-ui, -apple-system, sans-serif;
      }
      body {
        margin: 0;
        font-family: var(--ps-font-sans);
        background: var(--ps-surface);
        color: var(--ps-ink);
      }
      .ps-container {
        width: min(100% - 2rem, 72rem);
        margin-inline: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <SectionTestimonials
        id="testimoni-utama"
        config={testimonialsConfig}
        googleMapsReviewUrl={reviewUrl}
        isFirstSection={true}
      />
      <SectionContactForm
        id="kontak-utama"
        businessName="PT Klinik Sehat Nusantara"
        googleMapsReviewUrl={reviewUrl}
        surfaceTone="muted"
      />
    </main>
  </body>
</html>
`,
  );

  // 4. Public Testimonials & Contact page WITH malicious open-redirect URL -> MUST fail closed (render ZERO links)
  fs.writeFileSync(
    path.join(pagesDir, "public-malicious-url.astro"),
    `---
import ${JSON.stringify(publicSectionsCssImport)};
import SectionTestimonials from ${JSON.stringify(testimonialsImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};

const badReviewUrl = "https://www.google.com/url?q=https://evil.example/phish";
const testimonialsConfig = {
  eyebrow: "Testimoni",
  heading: "Ulasan Pelanggan",
  items: [],
};
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fail-Closed Test</title>
  </head>
  <body>
    <main>
      <SectionTestimonials
        id="testimoni-fail-closed"
        config={testimonialsConfig}
        googleMapsReviewUrl={badReviewUrl}
        isFirstSection={true}
      />
      <SectionContactForm
        id="kontak-fail-closed"
        businessName="PT Uji Aman"
        googleMapsReviewUrl={badReviewUrl}
      />
    </main>
  </body>
</html>
`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    devToolbar: { enabled: false },
    logLevel: "error",
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
  });

  return { tmpRoot, outDir };
}

function startStaticFixtureServer(outDir) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const candidates = [
        path.join(outDir, reqPath === "/" ? "index.html" : reqPath),
        path.join(outDir, reqPath, "index.html"),
      ];
      const file = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!file) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function assertNoOverflowAndTouchTargets(page, label, checkTouchTargets) {
  const metrics = await page.evaluate((shouldCheckTouch) => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const wideEls = [];
    if (overflow > 1) {
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1) {
          wideEls.push({
            tag: el.tagName,
            id: el.id || "",
            testId: el.getAttribute("data-testid") || "",
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
          if (wideEls.length >= 6) break;
        }
      }
    }
    const smallTargets = [];
    if (shouldCheckTouch) {
      const els = document.querySelectorAll(
        'button:not([disabled]), a[href], input:not([type="hidden"]):not([disabled])',
      );
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (rect.height < 43.5) {
          smallTargets.push({
            tag: el.tagName,
            testId: el.getAttribute("data-testid") || el.id || el.textContent?.trim().slice(0, 30),
            height: Math.round(rect.height),
          });
        }
      }
    }
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      wideEls,
      smallTargets,
    };
  }, checkTouchTargets);

  assert(
    metrics.overflow <= 1,
    `${label}: horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}; wideEls=${JSON.stringify(metrics.wideEls)})`,
  );
  if (checkTouchTargets) {
    // Allow footer/inline links inside paragraph text (e.g., Kebijakan Privasi) while enforcing >=44px on primary controls & review CTAs
    const filtered = metrics.smallTargets.filter(
      (t) =>
        t.testId?.includes("google-maps-review") ||
        t.testId?.includes("gbp-") ||
        t.testId?.includes("settings-save") ||
        t.testId?.includes("settings-publish") ||
        t.testId?.includes("lead-form-submit"),
    );
    assert(
      filtered.length === 0,
      `${label}: mobile touch targets < 44px: ${JSON.stringify(filtered)}`,
    );
  }
}

async function run() {
  const { tmpRoot, outDir } = await buildTask073Fixtures();
  const { server, baseUrl } = await startStaticFixtureServer(outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // Mock Tenant Settings API for interactive Settings UI verification
    const serverState = createInitialSettingsState();
    await page.route("**/api/tenants/klinik-sehat/settings/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method().toUpperCase();

      if (url.pathname.endsWith("/settings/business") && method === "PATCH") {
        const body = JSON.parse(req.postData() || "{}");
        serverState.draft.business = {
          ...serverState.draft.business,
          googleMapsReviewUrl: body.googleMapsReviewUrl ?? null,
        };
        serverState.version += 1;
        serverState.draftVersion = serverState.version;
        serverState.hasUnpublishedChanges = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            group: "business",
            version: serverState.version,
            draftVersion: serverState.draftVersion,
            publishedVersion: serverState.publishedVersion,
            hasUnpublishedChanges: true,
            updatedAt: "2026-11-23T06:00:00.000Z",
            publishedAt: serverState.publishedAt,
            draft: serverState.draft,
            published: serverState.published,
            availablePages: serverState.availablePages,
          }),
        });
        return;
      }

      if (url.pathname.endsWith("/settings/publish") && method === "POST") {
        serverState.published = structuredClone(serverState.draft);
        serverState.version += 1;
        serverState.draftVersion = serverState.version;
        serverState.publishedVersion = serverState.version;
        serverState.hasUnpublishedChanges = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            group: "business",
            version: serverState.version,
            draftVersion: serverState.draftVersion,
            publishedVersion: serverState.publishedVersion,
            hasUnpublishedChanges: false,
            updatedAt: "2026-11-23T06:01:00.000Z",
            publishedAt: "2026-11-23T06:01:00.000Z",
            published: serverState.published,
          }),
        });
        return;
      }

      await route.continue();
    });

    // ------------------------------------------------------------------
    // 1. Settings UI (1440px & 360px): Validation, Save, Publish & GBP Card
    // ------------------------------------------------------------------
    await page.goto(`${baseUrl}/settings-business`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="input-google-maps-review-url"]');
    await page.waitForSelector('[data-testid="gbp-checklist-card"]');

    // Verify official Google Business Profile help links & PunyaSitus help link
    const officialHelpHref = await page
      .locator('[data-testid="gbp-official-help-link"]')
      .getAttribute("href");
    assert(
      officialHelpHref === "https://support.google.com/business/answer/3038177",
      `Unexpected GBP official help link: ${officialHelpHref}`,
    );
    const reviewHelpHref = await page
      .locator('[data-testid="gbp-review-help-link"]')
      .getAttribute("href");
    assert(
      reviewHelpHref === "https://support.google.com/business/answer/7035772",
      `Unexpected GBP review help link: ${reviewHelpHref}`,
    );
    const psHelpHref = await page
      .locator('[data-testid="gbp-punyasitus-help-link"]')
      .getAttribute("href");
    assert(
      psHelpHref?.includes("/bantuan/mengoptimalkan-seo-dan-visibilitas-ai"),
      `Unexpected PunyaSitus help link: ${psHelpHref}`,
    );

    // Reject open redirect in UI
    const input = page.locator('[data-testid="input-google-maps-review-url"]');
    await input.fill("https://www.google.com/url?q=https://evil.example");
    const statusTextBad = await page
      .locator('[data-testid="google-maps-review-url-status"]')
      .textContent();
    assert(
      statusTextBad?.includes("tidak diizinkan"),
      `Expected invalid status badge, got: ${statusTextBad}`,
    );

    // Enter valid g.page review URL, save draft, and publish
    const validReviewUrl = "https://g.page/r/Cf1234567890_EBM/review";
    await input.fill(validReviewUrl);
    const statusTextGood = await page
      .locator('[data-testid="google-maps-review-url-status"]')
      .textContent();
    assert(
      statusTextGood?.includes("valid"),
      `Expected valid status badge, got: ${statusTextGood}`,
    );

    await page.locator('[data-testid="settings-save-draft-btn"]').click();
    await page.waitForSelector('[data-testid="settings-unpublished-badge"]');
    await page.locator('[data-testid="settings-publish-btn"]').click();
    await page.waitForSelector('[data-testid="settings-synced-badge"]');

    const progressText = await page.locator('[data-testid="gbp-checklist-progress"]').textContent();
    assert(progressText?.includes("3/3"), `Expected 3/3 GBP checklist progress, got: ${progressText}`);

    await assertNoOverflowAndTouchTargets(page, "Settings 1440px", false);
    await page.screenshot({
      path: path.join(screenshotDir, "settings-business-1440.png"),
      fullPage: true,
    });

    // Mobile 360px
    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoOverflowAndTouchTargets(page, "Settings 360px", true);
    await page.screenshot({
      path: path.join(screenshotDir, "settings-business-360.png"),
      fullPage: true,
    });

    // ------------------------------------------------------------------
    // 2. Editor Read-Only Settings UI (1440px & 360px)
    // ------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/settings-editor`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="settings-readonly-permission-banner"]');
    assert(
      await page.locator('[data-testid="input-google-maps-review-url"]').isDisabled(),
      "Editor must see disabled googleMapsReviewUrl input",
    );
    assert(
      await page.locator('[data-testid="settings-save-draft-btn"]').isDisabled(),
      "Editor must see disabled Save button",
    );
    assert(
      await page.locator('[data-testid="settings-publish-btn"]').isDisabled(),
      "Editor must see disabled Publish button",
    );
    await assertNoOverflowAndTouchTargets(page, "Editor Settings 1440px", false);
    await page.screenshot({
      path: path.join(screenshotDir, "settings-editor-readonly-1440.png"),
      fullPage: true,
    });

    // ------------------------------------------------------------------
    // 3. Public SectionTestimonials & SectionContactForm (1440px & 360px)
    // ------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/public-with-review`, { waitUntil: "networkidle" });

    const testimonialsLink = page.locator('[data-testid="google-maps-review-link"]');
    const contactLink = page.locator('[data-testid="contact-google-maps-review-link"]');

    assert((await testimonialsLink.count()) === 1, "Testimonials Google review link must render");
    assert((await contactLink.count()) === 1, "Contact Google review link must render");

    for (const [name, loc] of [
      ["SectionTestimonials", testimonialsLink],
      ["SectionContactForm", contactLink],
    ]) {
      const href = await loc.getAttribute("href");
      const target = await loc.getAttribute("target");
      const rel = await loc.getAttribute("rel");
      assert(href === validReviewUrl, `${name}: expected href=${validReviewUrl}, got ${href}`);
      assert(target === "_blank", `${name}: expected target=_blank, got ${target}`);
      assert(
        rel?.includes("noopener") && rel?.includes("noreferrer") && rel?.includes("nofollow"),
        `${name}: expected safe rel attributes, got ${rel}`,
      );
    }

    // Verify ZERO third-party review widgets/scripts and ZERO Review / AggregateRating JSON-LD
    const publicAudit = await page.evaluate(() => {
      const jsonLdScripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
      ).map((s) => s.textContent || "");
      const externalScripts = Array.from(document.querySelectorAll("script[src]")).map((s) =>
        s.getAttribute("src"),
      );
      const iframes = document.querySelectorAll("iframe").length;
      return { jsonLdScripts, externalScripts, iframes };
    });
    assert(publicAudit.iframes === 0, "Public review link must render zero iframes");
    assert(publicAudit.externalScripts.length === 0, "Public review link must load zero external scripts");
    for (const raw of publicAudit.jsonLdScripts) {
      assert(!raw.includes("AggregateRating"), "JSON-LD must NOT contain AggregateRating");
      assert(!raw.includes('"Review"'), "JSON-LD must NOT contain Review schema");
    }

    await assertNoOverflowAndTouchTargets(page, "Public Testimonials & Contact 1440px", false);
    await page.screenshot({
      path: path.join(screenshotDir, "public-testimonials-contact-1440.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoOverflowAndTouchTargets(page, "Public Testimonials & Contact 360px", true);
    await page.screenshot({
      path: path.join(screenshotDir, "public-testimonials-contact-360.png"),
      fullPage: true,
    });

    // ------------------------------------------------------------------
    // 4. Fail-Closed Public Rendering for Malicious URL
    // ------------------------------------------------------------------
    await page.goto(`${baseUrl}/public-malicious-url`, { waitUntil: "networkidle" });
    assert(
      (await page.locator('[data-testid="google-maps-review-link"]').count()) === 0,
      "SectionTestimonials must fail closed on malicious URL",
    );
    assert(
      (await page.locator('[data-testid="contact-google-maps-review-link"]').count()) === 0,
      "SectionContactForm must fail closed on malicious URL",
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Uncaught page errors detected: ${JSON.stringify(pageErrors)}`);

    console.log(
      `PASS tests/task-073/e2e.mjs — verified Settings UI (1440px/360px + Editor read-only), GBP checklist links, Public SectionTestimonials & SectionContactForm (plain rel links, zero scripts/widgets/rating schema, fail-closed on malicious URL). Screenshots saved to ${screenshotDir}`,
    );
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
