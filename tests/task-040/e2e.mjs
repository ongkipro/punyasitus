/* global Buffer, process, console, document, setTimeout, structuredClone, URL */
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

const screenshotDir = process.env.TASK040_SCREENSHOT_DIR || "/tmp/punyasitus-t040-screenshots";
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
      tagline: "Perawatan Kesehatan Keluarga Terpercaya",
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
      businessCategory: "MedicalClinic",
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
      mapsUrl: "https://maps.google.com/?q=-6.24,106.80",
      weekdayHours: "Senin–Jumat 08.00–20.00 WIB",
      holidayHours: "Sabtu 09.00–15.00 WIB",
      serviceAreas: [],
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
      ga4MeasurementId: "G-T040ACTIVE1",
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
      { id: 3, slug: "tentang-kami", title: "Tentang Kami", status: "published", isHomepage: false, isPublished: true },
      { id: 4, slug: "promo-draf", title: "Promo Masih Draf", status: "draft", isHomepage: false, isPublished: false },
    ],
  };
}

async function buildRealSettingsFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t040-e2e-"));
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
  const initialStateLiteral = JSON.stringify(createInitialSettingsState());

  // Page 1: Owner Active Grouped Settings
  fs.writeFileSync(
    path.join(pagesDir, "settings.astro"),
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
  title="Pengaturan Situs — Klinik Sehat Nusantara"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="dr. Sari Wulandari"
  userRoleLabel="Pemilik Situs"
>
  <GroupedSettingsWorkspace
    client:load
    handle="klinik-nusantara"
    basePath="/dashboard/klinik-nusantara"
    publicSiteHref="https://klinik-nusantara.situsku.click"
    initialTab="general"
    permissions={ownerPermissions}
    initialState={initialState}
  />
</DashboardLayout>
`,
  );

  // Page 2: Locked Tenant Read-Only State
  fs.writeFileSync(
    path.join(pagesDir, "settings-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { GroupedSettingsWorkspace } from ${JSON.stringify(workspaceImport)};
const initialState = ${initialStateLiteral};
const lockedPermissions = {
  role: "owner",
  roleLabel: "Pemilik Situs",
  tenantStatus: "locked",
  isLocked: true,
  canReadSettings: true,
  canWriteSettings: false,
  canPublishSettings: false,
  canManageDomains: true,
  canManageMembers: true,
  canAccessBilling: true,
};
---
<DashboardLayout
  title="Pengaturan Situs (Terkunci) — Klinik Sehat Nusantara"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="locked"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="dr. Sari Wulandari"
  userRoleLabel="Pemilik Situs"
>
  <GroupedSettingsWorkspace
    client:load
    handle="klinik-nusantara"
    basePath="/dashboard/klinik-nusantara"
    publicSiteHref="https://klinik-nusantara.situsku.click"
    initialTab="general"
    permissions={lockedPermissions}
    initialState={initialState}
  />
</DashboardLayout>
`,
  );

  // Page 3: Read-only Role Permission Notice State
  fs.writeFileSync(
    path.join(pagesDir, "settings-readonly.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { GroupedSettingsWorkspace } from ${JSON.stringify(workspaceImport)};
const initialState = ${initialStateLiteral};
const readonlyPermissions = {
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
  title="Pengaturan Situs — Klinik Sehat Nusantara"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="Budi Editor"
  userRoleLabel="Editor"
>
  <GroupedSettingsWorkspace
    client:load
    handle="klinik-nusantara"
    basePath="/dashboard/klinik-nusantara"
    publicSiteHref="https://klinik-nusantara.situsku.click"
    initialTab="general"
    permissions={readonlyPermissions}
    initialState={initialState}
  />
</DashboardLayout>
`,
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

  return { tmpRoot, outDir };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function startStatefulServer(outDir) {
  let state = createInitialSettingsState();
  let forceConflictOnce = false;
  let forceDelayReloadMs = 0;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    // Test-control endpoints for deterministic conflict & loading simulation
    if (pathname === "/__test__/bump-version" && req.method === "POST") {
      state.version += 1;
      state.draftVersion = state.version;
      state.draft.general.tagline = "Diperbarui dari tab lain";
      state.hasUnpublishedChanges = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: state.version }));
      return;
    }
    if (pathname === "/__test__/delay-reload" && req.method === "POST") {
      const body = await readJsonBody(req);
      forceDelayReloadMs = Number(body.ms || 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Tenant Settings API simulation matching exact TASK-040 API contract
    if (pathname === "/api/tenants/klinik-nusantara/settings" && req.method === "GET") {
      if (forceDelayReloadMs > 0) {
        await new Promise((r) => setTimeout(r, forceDelayReloadMs));
        forceDelayReloadMs = 0;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(JSON.stringify(state));
      return;
    }

    const groupMatch = /^\/api\/tenants\/klinik-nusantara\/settings\/(general|business|reading|seo|privacy)$/.exec(
      pathname,
    );
    if (groupMatch && req.method === "PATCH") {
      const group = groupMatch[1];
      const body = await readJsonBody(req);

      if (forceConflictOnce || body.expectedVersion !== state.version) {
        forceConflictOnce = false;
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: `Konflik versi: versi Anda (${body.expectedVersion}) tertinggal dari versi terbaru (${state.version}).`,
              fields: [{ field: "expectedVersion", code: "STALE_VERSION", message: "Stale version" }],
            },
            requestId: "req_e2e_409",
          }),
        );
        return;
      }

      // 422 validation checks matching server rules
      if (group === "business" && body.whatsappE164 && !/^(628|08)[0-9-]{7,15}$/.test(body.whatsappE164)) {
        res.writeHead(422, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              message: "Nomor WhatsApp harus format Indonesia yang valid (628xxxxxxxxxx).",
              fields: [
                {
                  field: "whatsappE164",
                  code: "INVALID_WHATSAPP",
                  message: "Nomor WhatsApp Indonesia tidak valid (contoh: 6281234567890).",
                },
              ],
            },
            requestId: "req_e2e_422",
          }),
        );
        return;
      }

      if (group === "general") {
        state.draft.general = {
          ...state.draft.general,
          siteTitle: body.siteTitle ?? state.draft.general.siteTitle,
          tagline: body.tagline !== undefined ? body.tagline : state.draft.general.tagline,
          timezone: body.timezone ?? state.draft.general.timezone,
          publicEmail: body.publicEmail !== undefined ? body.publicEmail : state.draft.general.publicEmail,
        };
        if (body.publicEmail !== undefined) {
          state.draft.business.email = body.publicEmail;
        }
      } else if (group === "business") {
        state.draft.business = {
          ...state.draft.business,
          ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== "expectedVersion")),
        };
      } else if (group === "reading") {
        state.draft.reading = {
          ...state.draft.reading,
          homepageMode: body.homepageMode ?? state.draft.reading.homepageMode,
          homepagePageId: body.homepagePageId !== undefined ? body.homepagePageId : state.draft.reading.homepagePageId,
          blogEnabled: body.blogEnabled !== undefined ? body.blogEnabled : state.draft.reading.blogEnabled,
          catalogEnabled: body.catalogEnabled !== undefined ? body.catalogEnabled : state.draft.reading.catalogEnabled,
          enabledOfferingTypes: body.enabledOfferingTypes ?? state.draft.reading.enabledOfferingTypes,
          itemsPerPage: body.itemsPerPage ?? state.draft.reading.itemsPerPage,
        };
      } else if (group === "seo") {
        state.draft.seo = {
          ...state.draft.seo,
          defaultTitle: body.defaultTitle !== undefined ? body.defaultTitle : state.draft.seo.defaultTitle,
          defaultDescription: body.defaultDescription !== undefined ? body.defaultDescription : state.draft.seo.defaultDescription,
          siteVisibility: body.siteVisibility ?? state.draft.seo.siteVisibility,
          aiTrainingPolicy: body.aiTrainingPolicy ?? state.draft.seo.aiTrainingPolicy,
          googleSiteVerification:
            body.googleSiteVerification !== undefined
              ? body.googleSiteVerification
              : state.draft.seo.googleSiteVerification,
          bingSiteVerification:
            body.bingSiteVerification !== undefined
              ? body.bingSiteVerification
              : state.draft.seo.bingSiteVerification,
        };
      } else if (group === "privacy") {
        state.draft.privacy = {
          ...state.draft.privacy,
          privacyPageId: body.privacyPageId !== undefined ? body.privacyPageId : state.draft.privacy.privacyPageId,
          consentBannerText: body.consentBannerText !== undefined ? body.consentBannerText : state.draft.privacy.consentBannerText,
          consentPolicyVersion: body.consentPolicyVersion ?? state.draft.privacy.consentPolicyVersion,
        };
      }

      state.version += 1;
      state.draftVersion = state.version;
      state.hasUnpublishedChanges = JSON.stringify(state.draft) !== JSON.stringify(state.published);
      state.updatedAt = new Date().toISOString();

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(
        JSON.stringify({
          group,
          draftVersion: state.draftVersion,
          publishedVersion: state.publishedVersion,
          version: state.version,
          hasUnpublishedChanges: state.hasUnpublishedChanges,
          updatedAt: state.updatedAt,
          publishedAt: state.publishedAt,
          draft: state.draft,
          published: state.published,
          availablePages: state.availablePages,
        }),
      );
      return;
    }

    if (pathname === "/api/tenants/klinik-nusantara/settings/publish" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.expectedVersion !== state.version) {
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: "Konflik versi saat publikasi. Muat ulang versi terbaru terlebih dahulu.",
            },
            requestId: "req_e2e_pub_409",
          }),
        );
        return;
      }

      state.version += 1;
      state.draftVersion = state.version;
      state.publishedVersion = state.version;
      state.published = structuredClone(state.draft);
      state.hasUnpublishedChanges = false;
      state.publishedAt = new Date().toISOString();
      state.updatedAt = state.publishedAt;

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(
        JSON.stringify({
          group: body.group || "general",
          draftVersion: state.draftVersion,
          publishedVersion: state.publishedVersion,
          version: state.version,
          cacheVersion: state.version,
          hasUnpublishedChanges: false,
          publishedAt: state.publishedAt,
          updatedAt: state.updatedAt,
          published: state.published,
        }),
      );
      return;
    }

    // Serve built static pages (re-injecting latest server state on reload of /settings!)
    let relPath = pathname === "/" ? "/settings/index.html" : pathname;
    if (relPath === "/settings" || relPath === "/settings/") relPath = "/settings/index.html";
    if (relPath === "/settings-locked" || relPath === "/settings-locked/")
      relPath = "/settings-locked/index.html";
    if (relPath === "/settings-readonly" || relPath === "/settings-readonly/")
      relPath = "/settings-readonly/index.html";

    const filePath = path.join(outDir, relPath.replace(/^\/+/, ""));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    getState: () => state,
  };
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `Horizontal overflow on ${label}: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
  );
}

async function main() {
  const { tmpRoot, outDir } = await buildRealSettingsFixtures();
  const { server, baseUrl, getState } = await startStatefulServer(outDir);
  const screenshots = [];

  const browser = await chromium.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Ignore Chromium's network error log for our intentional 422/409 test cases
        if (/status of (422|409)\b/.test(text)) return;
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Desktop 1440x900 — Initial render & keyboard tab navigation
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.getByTestId("grouped-settings-workspace").waitFor({ state: "visible" });
    await assertNoHorizontalOverflow(page, "1440x900 General");

    // Verify timezone UTC vs date-only preview updates when switching Asia/Jakarta -> Asia/Jayapura
    const tzBefore = await page.getByTestId("timezone-preview-utc").textContent();
    const dateOnlyBefore = await page.getByTestId("timezone-preview-date-only").textContent();
    await page.getByTestId("select-timezone").selectOption("Asia/Jayapura");
    const tzAfter = await page.getByTestId("timezone-preview-utc").textContent();
    const dateOnlyAfter = await page.getByTestId("timezone-preview-date-only").textContent();
    assert(tzBefore !== tzAfter, "Expected UTC instant display to shift across timezones");
    assert(
      dateOnlyBefore === dateOnlyAfter && dateOnlyAfter?.includes("15 Desember 2026"),
      `Expected date-only value to remain immutable: got ${dateOnlyAfter}`,
    );

    // Edit General & Save Draft
    await page.getByTestId("input-site-title").fill("Klinik Sehat Nusantara Baru");
    await page.getByTestId("input-tagline").fill("Draf Tagline Terupdate");
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("settings-version-badge").textContent())?.includes("v3"),
      "Expected draft version v3 after General draft save",
    );
    assert(
      (await page.getByTestId("settings-live-version-badge").textContent())?.includes("Tayang v2"),
      "Live published version must remain v2 after draft save",
    );

    const shotDesktopGeneral = path.join(screenshotDir, "t040-desktop-1440-general-draft.png");
    await page.screenshot({ path: shotDesktopGeneral, fullPage: true });
    screenshots.push(shotDesktopGeneral);

    // Keyboard navigation across tabs (ArrowRight -> Business, End -> Privacy, Home -> General, ArrowRight -> Business)
    await page.getByTestId("settings-tab-general").focus();
    await page.keyboard.press("ArrowRight");
    assert(
      (await page.getByTestId("settings-tab-business").getAttribute("aria-selected")) === "true",
      "ArrowRight must activate Business tab",
    );
    await page.keyboard.press("End");
    assert(
      (await page.getByTestId("settings-tab-privacy").getAttribute("aria-selected")) === "true",
      "End key must activate Privacy tab",
    );
    await page.keyboard.press("Home");
    assert(
      (await page.getByTestId("settings-tab-general").getAttribute("aria-selected")) === "true",
      "Home key must activate General tab",
    );

    // 2. Business tab: verify empty states + 422 validation preserving input + valid draft save
    await page.getByTestId("settings-tab-business").click();
    await page.getByTestId("empty-service-areas").waitFor({ state: "visible" });
    await page.getByTestId("empty-social-links").waitFor({ state: "visible" });

    // Trigger 422 invalid WhatsApp -> verify entered input preserved + inline error shown!
    await page.getByTestId("input-whatsapp").fill("not-a-phone-number");
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("settings-banner-destructive").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("input-whatsapp").inputValue()) === "not-a-phone-number",
      "422 validation failure must preserve user input",
    );

    // Fix WhatsApp + add service area + add social link + save Business draft
    await page.getByTestId("input-whatsapp").fill("6281299998888");
    await page.getByTestId("input-new-service-area").fill("Jakarta Selatan");
    await page.getByTestId("add-service-area-btn").click();
    await page.getByTestId("add-social-link-btn").click();
    await page.getByTestId("input-social-url-0").fill("https://instagram.com/kliniknusantara");
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });

    // 3. Tablet 768x1024 — Reading & Homepage tab
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.getByTestId("settings-tab-reading").click();
    await assertNoHorizontalOverflow(page, "768x1024 Reading");

    await page.getByTestId("radio-homepage-page").check();
    await page.getByTestId("select-homepage-page").selectOption("3");
    await page.getByTestId("toggle-blog-enabled").uncheck();
    await page.getByTestId("items-per-page-24").click();
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });

    const shotTabletReading = path.join(screenshotDir, "t040-tablet-768-reading.png");
    await page.screenshot({ path: shotTabletReading, fullPage: true });
    screenshots.push(shotTabletReading);

    // 4. Mobile 360x800 — SEO tab with `noindex` warning callout & atomic Publish
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByTestId("settings-tab-seo").click();
    await assertNoHorizontalOverflow(page, "360x800 SEO");

    await page.getByTestId("radio-visibility-noindex").check();
    await page.getByTestId("noindex-warning-callout").waitFor({ state: "visible" });
    await page.getByTestId("input-seo-default-title").fill("Klinik Sehat Nusantara — SEO Default");
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });

    const shotMobileSeo = path.join(screenshotDir, "t040-mobile-360-seo-noindex.png");
    await page.screenshot({ path: shotMobileSeo, fullPage: true });
    screenshots.push(shotMobileSeo);

    // Verify Reload fetches persisted draft from server + loading skeleton appears briefly
    await page.request.post(`${baseUrl}/__test__/delay-reload`, { data: { ms: 250 } });
    await page.getByTestId("settings-reload-btn").click();
    await page.getByTestId("settings-loading-skeleton").waitFor({ state: "visible" });
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("input-seo-default-title").inputValue()) ===
        "Klinik Sehat Nusantara — SEO Default",
      "Draft SEO title must persist across reload",
    );

    // Atomic Publish!
    await page.getByTestId("settings-publish-btn").click();
    await page.getByTestId("settings-synced-badge").waitFor({ state: "visible" });
    const serverState = getState();
    assert(serverState.hasUnpublishedChanges === false, "Published state must be synced");
    assert(serverState.published.general.siteTitle === "Klinik Sehat Nusantara Baru", "Published siteTitle mismatch");
    assert(serverState.published.reading.blogEnabled === false, "Published blogEnabled mismatch");
    assert(serverState.published.seo.siteVisibility === "noindex", "Published siteVisibility mismatch");

    // 5. Simulate 409 Stale-Write Conflict & One-Click Reload Recovery
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("settings-tab-general").click();
    await page.request.post(`${baseUrl}/__test__/bump-version`);
    await page.getByTestId("input-tagline").fill("Edit yang akan kena 409");
    await page.getByTestId("settings-save-draft-btn").click();
    await page.getByTestId("stale-conflict-banner").waitFor({ state: "visible" });

    const shotConflict = path.join(screenshotDir, "t040-desktop-1440-conflict-409.png");
    await page.screenshot({ path: shotConflict, fullPage: true });
    screenshots.push(shotConflict);

    await page.getByTestId("stale-conflict-reload-btn").click();
    await page.getByTestId("settings-banner-success").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("input-tagline").inputValue()) === "Diperbarui dari tab lain",
      "409 conflict reload must restore latest server value",
    );

    // 6. Locked Tenant Read-Only State
    await page.goto(`${baseUrl}/settings-locked`, { waitUntil: "networkidle" });
    await page.getByTestId("cms-locked-banner").waitFor({ state: "visible" });
    assert(await page.getByTestId("input-site-title").isDisabled(), "Locked tenant inputs must be disabled");
    assert(await page.getByTestId("settings-save-draft-btn").isDisabled(), "Locked save button must be disabled");
    assert(await page.getByTestId("settings-publish-btn").isDisabled(), "Locked publish button must be disabled");
    await assertNoHorizontalOverflow(page, "1440x900 Locked");

    const shotLocked = path.join(screenshotDir, "t040-desktop-1440-locked.png");
    await page.screenshot({ path: shotLocked, fullPage: true });
    screenshots.push(shotLocked);

    // 7. Read-Only Permission Banner State
    await page.goto(`${baseUrl}/settings-readonly`, { waitUntil: "networkidle" });
    await page.getByTestId("settings-readonly-permission-banner").waitFor({ state: "visible" });
    assert(await page.getByTestId("input-site-title").isDisabled(), "Read-only role inputs must be disabled");
    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoHorizontalOverflow(page, "360x800 ReadOnly");

    assert(consoleErrors.length === 0, `Unexpected console errors: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);

    console.log("PASS: TASK-040 Chromium E2E verified grouped settings across 360/768/1440px, keyboard navigation, draft/publish, reload, 422, 409 conflict recovery, loading skeleton, empty states, and locked/permission states.");
    console.log("SCREENSHOTS:");
    for (const s of screenshots) {
      console.log(`  - ${s}`);
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
