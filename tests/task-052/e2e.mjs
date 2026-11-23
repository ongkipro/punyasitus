/* global Buffer, process, console, document, window, URL */
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

const screenshotDir = process.env.TASK052_SCREENSHOT_DIR || "/tmp/task-052-screenshots";
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

const DEFAULT_TEMPLATES = {
  homepage: {
    titleTemplate: "{{site_name}} {{sep}} {{tagline}}",
    descriptionTemplate: "{{excerpt}}",
  },
  page: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_item: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post_category: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  post_tag: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_category: {
    titleTemplate: "{{title}} {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  blog_index: {
    titleTemplate: "Blog {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
  catalog_index: {
    titleTemplate: "Katalog {{sep}} {{site_name}}",
    descriptionTemplate: "{{excerpt}}",
  },
};

function buildInitialSeoSettings() {
  return {
    tenantId: "01JT052E2ETENANT0000000001",
    handle: "alpha-studio",
    siteName: "PT Nusantara Arsitek",
    tagline: "Desain & Renovasi Kantor Modern",
    primaryHost: "www.nusantara-arsitek.id",
    primaryOrigin: "https://www.nusantara-arsitek.id",
    tenantStatus: "active",
    siteVisibility: "public",
    aiTrainingPolicy: "allow",
    seoAutopilotEnabled: true,
    draft: {
      searchAppearance: {
        separator: "|",
        templates: DEFAULT_TEMPLATES,
      },
      verificationTokens: {
        google: "gscAlphaToken_2026_Ready",
        bing: null,
        yandex: null,
      },
    },
    hasUnpublishedChanges: false,
    version: 3,
    publishedAt: "2026-11-23T06:00:00.000Z",
    verificationStatuses: [
      {
        provider: "google",
        label: "Google Search Console",
        metaName: "google-site-verification",
        token: "gscAlphaToken_2026_Ready",
        publishedToken: "gscAlphaToken_2026_Ready",
        metaTagPreview:
          '<meta name="google-site-verification" content="gscAlphaToken_2026_Ready" />',
        status: "configured",
        statusLabel: "Terkonfigurasi (Belum terverifikasi eksternal)",
        helperText:
          "Tag meta aktif pada www.nusantara-arsitek.id. Selesaikan verifikasi manual di Google Search Console, lalu catat hasilnya di sini.",
        externalVerification: null,
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: false,
      },
      {
        provider: "bing",
        label: "Bing Webmaster Tools",
        metaName: "msvalidate.01",
        token: "0123456789ABCDEF2026",
        publishedToken: "0123456789ABCDEF2026",
        metaTagPreview: '<meta name="msvalidate.01" content="0123456789ABCDEF2026" />',
        status: "recheck_required",
        statusLabel: "Perlu verifikasi ulang (Domain berubah)",
        helperText:
          "Verifikasi eksternal sebelumnya tercatat pada alpha-studio.situsku.click, sedangkan domain utama saat ini adalah www.nusantara-arsitek.id.",
        externalVerification: {
          verifiedHost: "alpha-studio.situsku.click",
          verifiedAt: "2026-11-20T04:00:00.000Z",
          verifiedByUserId: "user_owner",
          note: "Verifikasi awal di subdomain",
        },
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: true,
      },
      {
        provider: "yandex",
        label: "Yandex Webmaster (Opsional)",
        metaName: "yandex-verification",
        token: null,
        publishedToken: null,
        metaTagPreview: null,
        status: "not_configured",
        statusLabel: "Belum dikonfigurasi",
        helperText:
          "Masukkan nilai token polos dari dashboard webmaster (hanya isi atribut content, bukan seluruh tag HTML).",
        externalVerification: null,
        currentPrimaryHost: "www.nusantara-arsitek.id",
        domainChangedSinceVerification: false,
      },
    ],
    sitemapUrl: "https://www.nusantara-arsitek.id/sitemap.xml",
    directoryListingCopyText: [
      "Nama Bisnis: PT Nusantara Arsitek",
      "Situs Web: https://www.nusantara-arsitek.id",
      "Kategori: HomeAndConstructionBusiness",
      "Alamat Publik: Jl. Kemang Raya No. 18, Jakarta Selatan, DKI Jakarta",
      "WhatsApp: +6281234567890",
      "Jam Operasional: Senin–Jumat 08.00–17.00 WIB",
    ].join("\n"),
  };
}

async function buildTask052Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t052-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const seoSettingsImport = path.join(
    webDir,
    "src/components/admin/seo/SeoAutopilotSettingsClient.tsx",
  );
  const pageEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/pages/_PageEditorClient.tsx",
  );

  const layoutProps = (title, activeNavId = "pages") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="www.nusantara-arsitek.id"
    activeNavId=${JSON.stringify(activeNavId)}
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus="active"
    publicSiteHref="https://www.nusantara-arsitek.id"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 1. Page editor with seo-ai-autopilot ENABLED (collapsed-by-default drawer)
  fs.writeFileSync(
    path.join(pagesDir, "editor-seo-enabled.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
---
<DashboardLayout ${layoutProps("Edit Halaman — PT Nusantara Arsitek", "pages")}>
  <PageEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    siteName="PT Nusantara Arsitek"
    primaryHost="www.nusantara-arsitek.id"
    siteVisibility="public"
    seoAutopilotEnabled={true}
    publishedPeers={[
      {
        resourceKind: "post",
        resourceId: 42,
        title: "Panduan Renovasi Kantor",
        effectiveTitle: "Panduan Renovasi Kantor | PT Nusantara Arsitek",
        effectiveDescription: "Artikel panduan renovasi kantor.",
        focusKeyphrase: "jasa renovasi kantor",
        pathname: "/blog/panduan-renovasi-kantor",
      },
    ]}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      tenantStatus: "active",
      isLocked: false,
      canWriteContent: true,
      canPublishContent: true,
      canManageMedia: true,
      canUploadMedia: true,
      canManageMenus: true,
      canManageSettings: true,
    }}
    initialPage={{
      id: 7,
      title: "Layanan Renovasi Kantor",
      slug: "layanan-renovasi-kantor",
      status: "published",
      isHomepage: false,
      layoutMode: "standard",
      sections: [
        {
          id: "sec_1",
          kind: "hero",
          heading: "Layanan Renovasi Kantor Modern",
          subheading: "Tim arsitek kami menangani jasa renovasi kantor di Jakarta secara transparan.",
          bodyHtml: null,
          ctaLabel: "Hubungi Kami",
          ctaHref: "/kontak",
        },
        {
          id: "sec_2",
          kind: "faq",
          heading: "Pertanyaan Umum Renovasi",
          subheading: null,
          bodyHtml: "<p>Berapa lama pengerjaan renovasi kantor?</p>",
          ctaLabel: null,
          ctaHref: null,
        },
      ],
      seo: {
        focusKeyphrase: "jasa renovasi kantor",
      },
      hasUnpublishedChanges: false,
      version: 2,
    }}
  />
</DashboardLayout>`,
  );

  // 2. Page editor with seo-ai-autopilot DISABLED (drawer MUST be completely hidden!)
  fs.writeFileSync(
    path.join(pagesDir, "editor-seo-disabled.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
---
<DashboardLayout ${layoutProps("Edit Halaman (SEO Nonaktif) — PT Nusantara Arsitek", "pages")}>
  <PageEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    siteName="PT Nusantara Arsitek"
    primaryHost="www.nusantara-arsitek.id"
    seoAutopilotEnabled={false}
    permissions={{
      role: "owner",
      roleLabel: "Pemilik Situs",
      tenantStatus: "active",
      isLocked: false,
      canWriteContent: true,
      canPublishContent: true,
      canManageMedia: true,
      canUploadMedia: true,
      canManageMenus: true,
      canManageSettings: true,
    }}
    initialPage={{
      id: 8,
      title: "Halaman Bersih Tanpa SEO",
      slug: "halaman-bersih",
      status: "draft",
      isHomepage: false,
      layoutMode: "standard",
      sections: [],
      seo: null,
      hasUnpublishedChanges: true,
      version: 1,
    }}
  />
</DashboardLayout>`,
  );

  // 3. /dashboard/[handle]/plugins/seo-ai-autopilot settings screen
  const initialSettingsJson = JSON.stringify(buildInitialSeoSettings());
  fs.writeFileSync(
    path.join(pagesDir, "plugin-seo-autopilot.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { SeoAutopilotSettingsClient } from ${JSON.stringify(seoSettingsImport)};
const initialSettings = ${initialSettingsJson};
---
<DashboardLayout ${layoutProps("SEO & AI Autopilot — Plugin — PT Nusantara Arsitek", "plugins")}>
  <SeoAutopilotSettingsClient
    client:load
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/seo"
    initialSettings={initialSettings}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManageSettings: true,
    }}
  />
</DashboardLayout>`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;

  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
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
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startFixtureServer(outDir) {
  let settingsState = buildInitialSeoSettings();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

    // Stateful mock API for /api/tenants/alpha-studio/seo/*
    if (reqUrl.pathname === "/api/tenants/alpha-studio/seo/settings" && req.method === "PATCH") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      settingsState = {
        ...settingsState,
        version: settingsState.version + 1,
        hasUnpublishedChanges: true,
        draft: {
          searchAppearance: {
            separator: body.separator ?? settingsState.draft.searchAppearance.separator,
            templates: {
              ...settingsState.draft.searchAppearance.templates,
              ...(body.templates ?? {}),
            },
          },
          verificationTokens: {
            ...settingsState.draft.verificationTokens,
            ...(body.verification ?? {}),
          },
        },
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ settings: settingsState, requestId: "req_e2e_save" }));
      return;
    }

    if (reqUrl.pathname === "/api/tenants/alpha-studio/seo/publish" && req.method === "POST") {
      settingsState = {
        ...settingsState,
        version: settingsState.version + 1,
        hasUnpublishedChanges: false,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ settings: settingsState, requestId: "req_e2e_pub" }));
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/seo/verification-check" &&
      req.method === "POST"
    ) {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      settingsState = {
        ...settingsState,
        version: settingsState.version + 1,
        verificationStatuses: settingsState.verificationStatuses.map((item) =>
          item.provider === body.provider
            ? {
                ...item,
                status: "externally_verified",
                statusLabel: `Terverifikasi eksternal (${settingsState.primaryHost})`,
                domainChangedSinceVerification: false,
                externalVerification: {
                  verifiedHost: settingsState.primaryHost,
                  verifiedAt: "2026-11-23T12:00:00.000Z",
                  verifiedByUserId: "user_owner",
                  note: body.note ?? null,
                },
              }
            : item,
        ),
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ settings: settingsState, requestId: "req_e2e_ver" }));
      return;
    }

    if (reqUrl.pathname === "/api/tenants/alpha-studio/seo/toggle" && req.method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      settingsState = { ...settingsState, seoAutopilotEnabled: Boolean(body.enabled) };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          pluginId: "seo-ai-autopilot",
          enabled: settingsState.seoAutopilotEnabled,
          requestId: "req_e2e_toggle",
        }),
      );
      return;
    }

    // Stateful mock API for Page Editor save & SEO resource PATCH
    if (reqUrl.pathname === "/api/tenants/alpha-studio/pages/7" && req.method === "PATCH") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          id: 7,
          title: body.title ?? "Layanan Renovasi Kantor",
          slug: body.slug ?? "layanan-renovasi-kantor",
          status: "published",
          isHomepage: false,
          layoutMode: body.layoutMode ?? "standard",
          sections: body.sections ?? [],
          hasUnpublishedChanges: true,
          version: (body.version ?? 2) + 1,
        }),
      );
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/seo/resources/page/7" &&
      req.method === "PATCH"
    ) {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          seo: { version: (body.version ?? 3) + 1 },
          requestId: "req_e2e_res_seo",
        }),
      );
      return;
    }

    let target = path.join(outDir, reqUrl.pathname);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    } else if (!fs.existsSync(target) && fs.existsSync(`${target}.html`)) {
      target = `${target}.html`;
    } else if (!fs.existsSync(target) && fs.existsSync(path.join(target, "index.html"))) {
      target = path.join(target, "index.html");
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(target) });
    fs.createReadStream(target).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertZeroHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${label}: horizontal overflow detected (${metrics.scrollWidth}px > ${metrics.innerWidth}px)`,
  );
}

async function run() {
  const { outDir, cleanup } = await buildTask052Fixtures();
  const { baseUrl, close } = await startFixtureServer(outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const pageErrors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // ------------------------------------------------------------------
    // 1. Page Editor with seo-ai-autopilot ENABLED — Collapsed by default
    // ------------------------------------------------------------------
    await page.goto(`${baseUrl}/editor-seo-enabled`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="seo-override-drawer"]');

    const toggle = page.locator('[data-testid="seo-drawer-toggle"]');
    assert((await toggle.getAttribute("aria-expanded")) === "false", "Drawer must be collapsed by default");
    assert(
      (await page.locator('[data-testid="seo-drawer-panel"]').count()) === 0,
      "Drawer panel must not render while collapsed",
    );

    const pillText = (await page.locator('[data-testid="seo-drawer-checklist-pill"]').textContent()) || "";
    assert(/\d+ dari \d+ saran terpenuhi/.test(pillText), `Expected checklist pill, got: ${pillText}`);
    assert(!/skor|score|\d+\s*\/\s*100/i.test(pillText), "Must never show a numeric SEO score");

    await assertZeroHorizontalOverflow(page, "editor-collapsed-1440");

    // Expand drawer and verify tabs + keyboard navigation + checklist + unknown token inline error
    await toggle.click();
    await page.waitForSelector('[data-testid="seo-drawer-panel"]');
    assert((await toggle.getAttribute("aria-expanded")) === "true", "Drawer must expand on click");

    // Unknown token inline error blocks save cleanly
    await page.fill('[data-testid="seo-title-override-input"]', "Judul {{sep}} {{unknown_var}}");
    await page.waitForSelector('[data-testid="seo-title-error"]');

    // Fix title override to valid token template
    await page.fill(
      '[data-testid="seo-title-override-input"]',
      "{{title}} {{sep}} {{site_name}}",
    );
    assert((await page.locator('[data-testid="seo-title-error"]').count()) === 0, "Error clears on valid template");

    // Cannibalization advisory notice shown without blocking
    const checklistText =
      (await page.locator('[data-testid="seo-advisory-checklist"]').textContent()) || "";
    assert(
      checklistText.includes("kanibalisasi") && checklistText.includes("Panduan Renovasi Kantor"),
      "Cannibalization warning should appear in advisory checklist",
    );

    // Screenshot: Expanded SEO Drawer (Umum + Checklist) at 1440px
    await page.screenshot({
      path: path.join(screenshotDir, "editor-seo-drawer-1440.png"),
      fullPage: true,
    });

    // Keyboard arrow navigation across tabs -> Sosial -> Skema & Fakta AI -> Lanjutan
    await page.focus('[data-testid="seo-tab-general"]');
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('[data-testid="seo-social-preview"]');

    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('[data-testid="seo-schema-type-select"]');
    // FAQPage option is enabled because page has a visible FAQ section
    await page.selectOption('[data-testid="seo-schema-type-select"]', "FAQPage");

    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('[data-testid="seo-canonical-readonly"]');
    const canonicalVal = await page.inputValue('[data-testid="seo-canonical-readonly"]');
    assert(
      canonicalVal.includes("https://www.nusantara-arsitek.id/layanan-renovasi-kantor"),
      `Expected read-only canonical URL, got: ${canonicalVal}`,
    );

    // Toggle noindex & verify "noindex bukan privasi" warning appears
    await page.check('[data-testid="seo-noindex-checkbox"]');
    await page.waitForSelector('[data-testid="seo-noindex-warning"]');
    await page.check('[data-testid="seo-nofollow-checkbox"]');

    await assertZeroHorizontalOverflow(page, "editor-expanded-1440");

    // Mobile 360px check & screenshot for expanded drawer
    await page.setViewportSize({ width: 360, height: 800 });
    await assertZeroHorizontalOverflow(page, "editor-expanded-360");
    await page.screenshot({
      path: path.join(screenshotDir, "editor-seo-drawer-360.png"),
      fullPage: true,
    });

    // ------------------------------------------------------------------
    // 2. Page Editor with seo-ai-autopilot DISABLED — Zero SEO UI
    // ------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/editor-seo-disabled`, { waitUntil: "networkidle" });
    await page.waitForSelector("form");
    assert(
      (await page.locator('[data-testid="seo-override-drawer"]').count()) === 0,
      "SEO drawer MUST be completely hidden when seo-ai-autopilot is disabled",
    );

    // ------------------------------------------------------------------
    // 3. /dashboard/[handle]/plugins/seo-ai-autopilot Settings Page
    // ------------------------------------------------------------------
    await page.goto(`${baseUrl}/plugin-seo-autopilot`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="seo-autopilot-settings-page"]');
    await assertZeroHorizontalOverflow(page, "plugin-seo-appearance-1440");

    // Unknown token validation in template editor
    await page.fill('[data-testid="tpl-title-page"]', "{{title}} {{sep}} {{bad_token}}");
    await page.waitForSelector('[data-testid="tpl-title-error-page"]');
    await page.fill('[data-testid="tpl-title-page"]', "{{title}} {{sep}} {{site_name}}");
    assert((await page.locator('[data-testid="tpl-title-error-page"]').count()) === 0);

    // Screenshot: Search Appearance Templates at 1440px
    await page.screenshot({
      path: path.join(screenshotDir, "plugin-seo-appearance-1440.png"),
      fullPage: true,
    });

    // Switch to Verification tab
    await page.click('[data-testid="seo-settings-tab-verification"]');
    await page.waitForSelector('[data-testid="verification-card-google"]');

    // Configured vs Recheck Required badges
    const googleStatus =
      (await page.locator('[data-testid="verification-status-google"]').textContent()) || "";
    assert(
      googleStatus.includes("Terkonfigurasi"),
      `Google should show configured status, got: ${googleStatus}`,
    );
    const bingStatus =
      (await page.locator('[data-testid="verification-status-bing"]').textContent()) || "";
    assert(
      bingStatus.includes("Perlu verifikasi ulang"),
      `Bing should show recheck_required after domain change, got: ${bingStatus}`,
    );

    // Malicious <meta> tag rejected live
    await page.fill(
      '[data-testid="verify-token-input-yandex"]',
      '<meta name="yandex-verification" content="abc123456" />',
    );
    await page.waitForSelector('[data-testid="verify-token-error-yandex"]');
    await page.fill('[data-testid="verify-token-input-yandex"]', "");

    // Record manual external verification for Google -> transitions to externally_verified
    await page.click('[data-testid="record-external-verify-google"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="verification-status-google"]');
      return el && el.textContent && el.textContent.includes("Terverifikasi eksternal");
    });

    await assertZeroHorizontalOverflow(page, "plugin-seo-verification-1440");
    await page.screenshot({
      path: path.join(screenshotDir, "plugin-seo-verification-1440.png"),
      fullPage: true,
    });

    // Mobile 360px check & screenshot on Verification tab
    await page.setViewportSize({ width: 360, height: 800 });
    await assertZeroHorizontalOverflow(page, "plugin-seo-verification-360");
    await page.screenshot({
      path: path.join(screenshotDir, "plugin-seo-verification-360.png"),
      fullPage: true,
    });

    // Switch to GBP & Bing Directory tab
    await page.click('[data-testid="seo-settings-tab-directory"]');
    await page.waitForSelector('[data-testid="seo-gbp-copy-card"]');
    const gbpText = (await page.locator('[data-testid="seo-gbp-copy-preview"]').textContent()) || "";
    assert(gbpText.includes("PT Nusantara Arsitek"), "GBP copy card must show business facts");
    await assertZeroHorizontalOverflow(page, "plugin-seo-directory-360");

    assert(pageErrors.length === 0, `Uncaught page errors: ${pageErrors.join("; ")}`);
    console.log("TASK-052 E2E PASSED — screenshots saved to:", screenshotDir);
  } finally {
    await browser.close();
    await close();
    cleanup();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
