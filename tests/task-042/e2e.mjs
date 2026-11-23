/* global Buffer, process, console, document, fetch, URL */
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

const screenshotDir = process.env.TASK042_SCREENSHOT_DIR || "";

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

function renderFixtureThemePreviewHtml(theme) {
  const tokens = theme.savedTokens || theme.defaultTokens;
  const primary = tokens.primaryColor;
  const secondary = tokens.secondaryColor;
  const surface = tokens.surfaceColor || theme.palette.surface;
  const ink = tokens.textColor || theme.palette.ink;
  const radius = tokens.borderRadiusPx ?? 8;

  return `<!doctype html>
<html lang="id" data-ps-theme="${theme.id}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Pratinjau ${theme.name} — Arsitek Nusantara</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: ${surface}; color: ${ink}; }
      .bar { background: ${secondary}; color: #ffffff; padding: 10px 16px; font-size: 12px; font-weight: 600; }
      .header { border-bottom: 1px solid ${theme.palette.border}; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
      .hero { background: ${theme.palette.surfaceMuted}; padding: 36px 20px; border-bottom: 1px solid ${theme.palette.border}; }
      .wrap { max-width: 960px; margin: 0 auto; }
      .cta { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: ${radius}px; background: ${primary}; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding: 28px 20px; }
      .card { border: 1px solid ${theme.palette.border}; border-radius: ${radius}px; padding: 16px; background: ${surface}; }
    </style>
  </head>
  <body data-preview="true" data-theme-id="${theme.id}">
    <div class="bar">Mode Pratinjau Kompatibilitas — Tema ${theme.name} (Tanpa mengubah situs publik)</div>
    <header class="header">
      <strong>Arsitek Nusantara</strong>
      <span>Beranda · Layanan · Artikel · Kontak</span>
    </header>
    <main>
      <section class="hero">
        <div class="wrap">
          <p style="margin:0 0 8px;color:${primary};font-weight:700;font-size:13px;">TEMA: ${theme.name.toUpperCase()}</p>
          <h1 style="margin:0 0 10px;font-size:28px;">Solusi Desain Arsitektur &amp; Bangun Profesional</h1>
          <p style="margin:0 0 18px;color:${theme.palette.inkMuted};max-width:58ch;">
            Seluruh konten publik nyata milik Arsitek Nusantara tetap utuh saat berpindah ke tema ${theme.name}.
          </p>
          <a data-preview-inert="link" aria-disabled="true" class="cta">Konsultasi Proyek Sekarang</a>
        </div>
      </section>
      <section class="wrap">
        <div class="grid">
          <article class="card">
            <h2 style="margin:0 0 6px;font-size:16px;">Desain Rumah Tinggal</h2>
            <p style="margin:0;font-size:14px;color:${theme.palette.inkMuted};">Perencanaan ruang tropis hemat energi dan dokumentasi IMB/PBG.</p>
          </article>
          <article class="card">
            <h2 style="margin:0 0 6px;font-size:16px;">Renovasi Komersial</h2>
            <p style="margin:0;font-size:14px;color:${theme.palette.inkMuted};">Pembangunan kantor dan ruang usaha tepat waktu dengan RAB transparan.</p>
          </article>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

async function buildRealThemeLibraryFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t042-e2e-"));
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

  const sharedSetup = `
import {
  buildThemeCompatibilityCandidate,
  listGrantedThemesForTenant,
} from ${JSON.stringify(themeRegistryImport)};
import { evaluateThemeCompatibility } from ${JSON.stringify(themeCoreImport)};

const grantedEntries = listGrantedThemesForTenant({
  tenantId: "01JT042E2ETENANT0000000001",
  tenantStatus: "active",
  tenantGrants: [
    {
      tenantId: "01JT042E2ETENANT0000000001",
      themeId: "custom-sample-agency",
      active: true,
      grantedBy: "op_1",
    },
  ],
});

const tenantSections = [
  { id: "sec-hero", type: "hero", schemaVersion: 1, enabled: true },
  { id: "sec-offerings", type: "offerings_grid", schemaVersion: 1, enabled: true },
  { id: "sec-faq", type: "faq", schemaVersion: 1, enabled: true },
  { id: "sec-contact", type: "contact_location", schemaVersion: 1, enabled: true },
];

const contentSummary = { pages: 4, posts: 6, offerings: 8, menus: 2, media: 14 };

const savedComproTokens = {
  primaryColor: "#14532d",
  secondaryColor: "#0f4c5c",
  accentColor: "#1d4ed8",
  surfaceColor: "#ffffff",
  textColor: "#111c19",
  fontFamily: "plus-jakarta-sans",
  borderRadiusPx: 14,
  spacingScale: 1,
  containerMaxWidthPx: 1200,
  sectionPaddingYPx: 64,
  fastestSystemFont: false,
};

const baseThemes = grantedEntries.map((entry) => {
  const compatibility = evaluateThemeCompatibility(buildThemeCompatibilityCandidate(entry), {
    vertical: "compro",
    blogEnabled: true,
    catalogEnabled: true,
    sections: tenantSections,
    contentCounts: { ...contentSummary, offeringTypes: ["service"] },
  });
  return {
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    schemaVersion: entry.schemaVersion,
    tier: entry.tier,
    isCustom: entry.isCustom,
    isActive: entry.id === "compro",
    isRecommended: !entry.isCustom && entry.id === "compro",
    grantSource: entry.isCustom ? "tenant_grant" : "platform_included",
    grantedAt: entry.isCustom ? "2026-11-22T09:00:00.000Z" : null,
    hasSavedConfig: entry.id === "compro",
    savedConfigUpdatedAt: entry.id === "compro" ? "2026-11-23T01:00:00.000Z" : null,
    savedTokens: entry.id === "compro" ? savedComproTokens : null,
    defaultTokens: entry.defaultTokens,
    palette: entry.palette,
    recommendedOfferingTypes: entry.recommendedOfferingTypes,
    supportedRoutes: entry.supportedRoutes,
    supportedSectionTypes: entry.supportedSectionTypes,
    compatibility,
  };
});

// Add one explicitly incompatible granted theme card to verify blocking UI in Chromium!
const incompatibleTheme = {
  ...baseThemes[0],
  id: "custom-legacy-locked",
  slug: "legacy-locked",
  name: "Legacy Print Studio (Skema v2)",
  description: "Contoh tema kustom yang tidak kompatibel dengan struktur bagian FAQ saat ini.",
  tier: "custom",
  isCustom: true,
  isActive: false,
  isRecommended: false,
  grantSource: "tenant_grant",
  hasSavedConfig: false,
  savedConfigUpdatedAt: null,
  savedTokens: null,
  supportedSectionTypes: ["hero", "about"],
  compatibility: evaluateThemeCompatibility(
    {
      id: "custom-legacy-locked",
      name: "Legacy Print Studio (Skema v2)",
      schemaVersion: 2,
      tier: "custom",
      supportedSectionTypes: ["hero", "about"],
    },
    {
      vertical: "compro",
      currentSchemaVersion: 1,
      sections: tenantSections,
    },
  ),
};

const baseState = {
  tenantId: "01JT042E2ETENANT0000000001",
  handle: "arsitek-nusantara",
  vertical: "compro",
  activeThemeId: "compro",
  version: 3,
  cacheVersion: 5,
  themes: [...baseThemes, incompatibleTheme],
  contentSummary,
  permissions: {
    canPreview: true,
    canActivate: true,
    isLocked: false,
    role: "owner",
    tenantStatus: "active",
  },
  updatedAt: "2026-11-23T01:30:00.000Z",
};
`;

  // Page 1: Owner Active Theme Library
  fs.writeFileSync(
    path.join(pagesDir, "themes-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeLibrary } from ${JSON.stringify(themeLibraryImport)};
${sharedSetup}
---
<DashboardLayout
  title="Perpustakaan Tema — Arsitek Nusantara"
  surface="dashboard"
  workspaceName="Arsitek Nusantara"
  workspaceSubtitle="arsitek-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/arsitek-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <ThemeLibrary
    client:load
    tenantHandle="arsitek-nusantara"
    workspaceName="Arsitek Nusantara"
    themesApiUrl="/api/tenants/arsitek-nusantara/themes"
    previewApiUrl="/api/tenants/arsitek-nusantara/themes/preview"
    activateApiUrl="/api/tenants/arsitek-nusantara/themes/activate"
    customizerHref="/dashboard/arsitek-nusantara/appearance"
    initialState={baseState}
  />
</DashboardLayout>
`,
  );

  // Page 2: Editor Read-Only Theme Library
  fs.writeFileSync(
    path.join(pagesDir, "themes-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeLibrary } from ${JSON.stringify(themeLibraryImport)};
${sharedSetup}
const editorState = {
  ...baseState,
  permissions: {
    canPreview: false,
    canActivate: false,
    isLocked: false,
    role: "editor",
    tenantStatus: "active",
  },
};
---
<DashboardLayout
  title="Perpustakaan Tema (Editor) — Arsitek Nusantara"
  surface="dashboard"
  workspaceName="Arsitek Nusantara"
  workspaceSubtitle="arsitek-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/arsitek-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  userDisplayName="Siti Editor"
  userRoleLabel="Editor"
>
  <ThemeLibrary
    client:load
    tenantHandle="arsitek-nusantara"
    workspaceName="Arsitek Nusantara"
    themesApiUrl="/api/tenants/arsitek-nusantara/themes"
    previewApiUrl="/api/tenants/arsitek-nusantara/themes/preview"
    activateApiUrl="/api/tenants/arsitek-nusantara/themes/activate"
    customizerHref="/dashboard/arsitek-nusantara/appearance"
    initialState={editorState}
  />
</DashboardLayout>
`,
  );

  // Page 3: Locked Tenant Read-Only Theme Library
  fs.writeFileSync(
    path.join(pagesDir, "themes-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeLibrary } from ${JSON.stringify(themeLibraryImport)};
${sharedSetup}
const lockedState = {
  ...baseState,
  permissions: {
    canPreview: true,
    canActivate: false,
    isLocked: true,
    role: "owner",
    tenantStatus: "locked",
  },
};
---
<DashboardLayout
  title="Perpustakaan Tema (Terkunci) — Arsitek Nusantara"
  surface="dashboard"
  workspaceName="Arsitek Nusantara"
  workspaceSubtitle="arsitek-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/arsitek-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="locked"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <ThemeLibrary
    client:load
    tenantHandle="arsitek-nusantara"
    workspaceName="Arsitek Nusantara"
    themesApiUrl="/api/tenants/arsitek-nusantara/themes"
    previewApiUrl="/api/tenants/arsitek-nusantara/themes/preview"
    activateApiUrl="/api/tenants/arsitek-nusantara/themes/activate"
    customizerHref="/dashboard/arsitek-nusantara/appearance"
    initialState={lockedState}
  />
</DashboardLayout>
`,
  );

  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;
  const { build } = await import(astroEntryUrl);

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    devToolbar: { enabled: false },
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

function createStaticAndMockApiServer(outDir) {
  let activeThemeId = "compro";
  let version = 3;
  let cacheVersion = 5;
  let forceNextConflict = false;
  const savedThemeIds = new Set(["compro"]);
  let previewCalls = 0;

  const paletteMap = {
    compro: {
      name: "Corporate / B2B Compro",
      defaultTokens: { primaryColor: "#176b51", secondaryColor: "#0f4c5c", surfaceColor: "#ffffff", textColor: "#111c19", borderRadiusPx: 8 },
      savedTokens: { primaryColor: "#14532d", secondaryColor: "#0f4c5c", surfaceColor: "#ffffff", textColor: "#111c19", borderRadiusPx: 14 },
      palette: { surface: "#ffffff", surfaceMuted: "#f4f7f5", ink: "#111c19", inkMuted: "#4b5c55", border: "#d8e2dc" },
    },
    sales: {
      name: "Sales Compro & Personal Branding",
      defaultTokens: { primaryColor: "#1e40af", secondaryColor: "#0f766e", surfaceColor: "#ffffff", textColor: "#0f172a", borderRadiusPx: 8 },
      palette: { surface: "#ffffff", surfaceMuted: "#f5f7fb", ink: "#0f172a", inkMuted: "#475569", border: "#dbe3ee" },
    },
    travel: {
      name: "Travel & Umrah Agency",
      defaultTokens: { primaryColor: "#0f5c5c", secondaryColor: "#92400e", surfaceColor: "#ffffff", textColor: "#132221", borderRadiusPx: 10 },
      palette: { surface: "#ffffff", surfaceMuted: "#f5f8f7", ink: "#132221", inkMuted: "#485c5a", border: "#d7e3e0" },
    },
    catalog: {
      name: "Product Showcase Catalog",
      defaultTokens: { primaryColor: "#1d4ed8", secondaryColor: "#0f766e", surfaceColor: "#ffffff", textColor: "#111827", borderRadiusPx: 6 },
      palette: { surface: "#ffffff", surfaceMuted: "#f7f8fa", ink: "#111827", inkMuted: "#4b5563", border: "#dde2e8" },
    },
    resto: {
      name: "F&B & Multi-Branch Outlets",
      defaultTokens: { primaryColor: "#9a3412", secondaryColor: "#14532d", surfaceColor: "#fffdf9", textColor: "#1f1712", borderRadiusPx: 10 },
      palette: { surface: "#fffdf9", surfaceMuted: "#f7f2ea", ink: "#1f1712", inkMuted: "#5c4d42", border: "#e5dacb" },
    },
    dealer: {
      name: "Automotive & Vehicle Showroom",
      defaultTokens: { primaryColor: "#1e293b", secondaryColor: "#b91c1c", surfaceColor: "#ffffff", textColor: "#0f172a", borderRadiusPx: 4 },
      palette: { surface: "#ffffff", surfaceMuted: "#f4f6f8", ink: "#0f172a", inkMuted: "#475569", border: "#d6dce4" },
    },
    "custom-sample-agency": {
      name: "Editorial Studio Agency (Sample)",
      isCustom: true,
      defaultTokens: { primaryColor: "#1c2d4a", secondaryColor: "#9c3d1a", surfaceColor: "#fbf9f5", textColor: "#171a1f", borderRadiusPx: 2 },
      palette: { surface: "#fbf9f5", surfaceMuted: "#f2ede4", ink: "#171a1f", inkMuted: "#4a515d", border: "#dcd4c6" },
    },
  };

  function buildCurrentState() {
    const themes = Object.entries(paletteMap).map(([id, meta]) => ({
      id,
      slug: id.replace(/^custom-/, ""),
      name: meta.name,
      description: meta.isCustom
        ? "Tema kustom berizin untuk Arsitek Nusantara dengan kompatibilitas penuh."
        : `Tema bawaan platform PunyaSitus (${meta.name}).`,
      version: "1.0.0",
      schemaVersion: 1,
      tier: meta.isCustom ? "custom" : "included",
      isCustom: Boolean(meta.isCustom),
      isActive: activeThemeId === id,
      isRecommended: id === "compro",
      grantSource: meta.isCustom ? "tenant_grant" : "platform_included",
      grantedAt: meta.isCustom ? "2026-11-22T09:00:00.000Z" : null,
      hasSavedConfig: savedThemeIds.has(id),
      savedConfigUpdatedAt: savedThemeIds.has(id) ? "2026-11-23T01:00:00.000Z" : null,
      savedTokens: savedThemeIds.has(id) ? meta.savedTokens || meta.defaultTokens : null,
      defaultTokens: meta.defaultTokens,
      palette: meta.palette,
      recommendedOfferingTypes: ["service"],
      supportedRoutes: ["home", "page", "blog_index", "blog_post", "catalog_index", "catalog_detail", "not_found"],
      supportedSectionTypes: ["hero", "features", "about", "offerings_grid", "faq", "contact_location"],
      compatibility: {
        compatible: true,
        supportedSections: ["hero", "offerings_grid", "faq", "contact_location"],
        unsupportedSections: [],
        blockingReasons: [],
        warnings: [],
        fallbackNotes: ["Konfigurasi warna dan tipografi tema sebelumnya tetap tersimpan terpisah."],
        schemaVersion: 1,
        expectedSchemaVersion: 1,
      },
    }));

    themes.push({
      id: "custom-legacy-locked",
      slug: "legacy-locked",
      name: "Legacy Print Studio (Skema v2)",
      description: "Contoh tema kustom yang tidak kompatibel dengan struktur bagian FAQ saat ini.",
      version: "1.0.0",
      schemaVersion: 2,
      tier: "custom",
      isCustom: true,
      isActive: false,
      isRecommended: false,
      grantSource: "tenant_grant",
      grantedAt: "2026-11-22T09:00:00.000Z",
      hasSavedConfig: false,
      savedConfigUpdatedAt: null,
      savedTokens: null,
      defaultTokens: paletteMap.compro.defaultTokens,
      palette: paletteMap.compro.palette,
      recommendedOfferingTypes: ["service"],
      supportedRoutes: ["home", "page", "blog_index", "blog_post", "catalog_index", "catalog_detail", "not_found"],
      supportedSectionTypes: ["hero", "about"],
      compatibility: {
        compatible: false,
        supportedSections: ["hero"],
        unsupportedSections: ["offerings_grid", "faq", "contact_location"],
        blockingReasons: [
          {
            code: "SCHEMA_VERSION_MISMATCH",
            field: "schemaVersion",
            message: "Versi skema tema (2) tidak cocok dengan versi skema situs saat ini (v1).",
          },
          {
            code: "UNSUPPORTED_SECTION",
            field: "sections",
            message: 'Tema "Legacy Print Studio (Skema v2)" tidak mendukung tipe bagian: offerings_grid, faq, contact_location.',
          },
        ],
        warnings: [],
        fallbackNotes: [],
        schemaVersion: 2,
        expectedSchemaVersion: 1,
      },
    });

    return {
      tenantId: "01JT042E2ETENANT0000000001",
      handle: "arsitek-nusantara",
      vertical: "compro",
      activeThemeId,
      version,
      cacheVersion,
      themes,
      contentSummary: { pages: 4, posts: 6, offerings: 8, menus: 2, media: 14 },
      permissions: {
        canPreview: true,
        canActivate: true,
        isLocked: false,
        role: "owner",
        tenantStatus: "active",
      },
      updatedAt: new Date().toISOString(),
    };
  }

  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/test/force-conflict" && req.method === "POST") {
      forceNextConflict = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/tenants/arsitek-nusantara/themes" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(JSON.stringify(buildCurrentState()));
      return;
    }

    if (url.pathname === "/api/tenants/arsitek-nusantara/themes/preview" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        previewCalls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const state = buildCurrentState();
        const theme = state.themes.find((t) => t.id === body.themeId);
        if (!theme) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "THEME_NOT_FOUND", message: "Tema tidak ditemukan." }, requestId: "req_preview_404" }));
          return;
        }
        if (!theme.compatibility.compatible) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "THEME_INCOMPATIBLE", message: "Tema tidak kompatibel." }, requestId: "req_preview_422" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy": "default-src 'none'; script-src 'none'; frame-ancestors 'self'",
        });
        res.end(
          JSON.stringify({
            html: renderFixtureThemePreviewHtml(theme),
            themeId: theme.id,
            themeName: theme.name,
            isCustom: theme.isCustom,
            sandbox: "",
            compatibility: theme.compatibility,
            hasSavedConfig: theme.hasSavedConfig,
            isPreview: true,
            version,
          }),
        );
      });
      return;
    }

    if (url.pathname === "/api/tenants/arsitek-nusantara/themes/activate" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (forceNextConflict || body.expectedVersion !== version) {
          forceNextConflict = false;
          version += 1;
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              error: {
                code: "STALE_VERSION",
                message: "Versi tema telah berubah di sesi lain. Muat ulang status terbaru sebelum mengaktifkan tema.",
              },
              requestId: "req_conflict_409",
            }),
          );
          return;
        }

        const previousThemeId = activeThemeId;
        const recoveredExistingConfig = savedThemeIds.has(body.themeId);
        activeThemeId = body.themeId;
        savedThemeIds.add(activeThemeId);
        version += 1;
        cacheVersion += 1;

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        });
        res.end(
          JSON.stringify({
            ...buildCurrentState(),
            activatedThemeId: activeThemeId,
            previousThemeId,
            recoveredExistingConfig,
            activatedAt: new Date().toISOString(),
          }),
        );
      });
      return;
    }

    // Serve static Astro output
    let filePath = path.join(outDir, url.pathname === "/" ? "themes-owner/index.html" : url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return {
    server,
    getStats: () => ({ activeThemeId, version, cacheVersion, previewCalls }),
  };
}

async function checkViewportLayout(page, label) {
  const metrics = await page.evaluate(() => {
    const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const buttons = Array.from(document.querySelectorAll('[data-testid="theme-library-root"] button, [data-testid="theme-library-root"] a'));
    const tooSmall = [];
    for (const el of buttons) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height < 44) {
        tooSmall.push({
          text: (el.textContent || "").trim().slice(0, 40),
          height: Math.round(rect.height),
        });
      }
    }
    return { overflowX, tooSmall };
  });

  assert(
    metrics.overflowX <= 1,
    `${label}: horizontal overflow detected (${metrics.overflowX}px)`,
  );
  assert(
    metrics.tooSmall.length === 0,
    `${label}: tap targets < 44px found: ${JSON.stringify(metrics.tooSmall)}`,
  );
}

async function main() {
  const { tmpRoot, outDir } = await buildRealThemeLibraryFixtures();
  const { server, getStats } = createStaticAndMockApiServer(outDir);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Ignore Chromium's automatic network log for our intentional 409 conflict test
        if (text.includes("status of 409")) return;
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Desktop 1440px: Owner Theme Library initial render
    await page.goto(`${baseUrl}/themes-owner`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="theme-library-root"]');

    assert(
      (await page.locator('[data-testid="active-theme-id"]').textContent()).includes("compro"),
      "Initial active theme should be compro",
    );
    assert(
      await page.locator('[data-testid="theme-card-custom-sample-agency"]').isVisible(),
      "Granted custom theme must be visible",
    );
    assert(
      (await page.locator('[data-testid="theme-card-custom-foreign-secret"]').count()) === 0,
      "Foreign ungranted custom theme must never render",
    );
    assert(
      await page.locator('[data-testid="incompatibility-reasons-custom-legacy-locked"]').isVisible(),
      "Incompatible theme must display blocking reasons",
    );
    assert(
      await page.locator('[data-testid="btn-activate-custom-legacy-locked"]').isDisabled(),
      "Incompatible theme activate button must be disabled",
    );

    await checkViewportLayout(page, "1440px owner");

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, "themes-library-1440.png"),
        fullPage: true,
      });
    }

    // 2. Open Sandboxed Compatibility Preview (`sandbox=""`) & toggle 360px / 1440px
    const statsBeforePreview = getStats();
    await page.click('[data-testid="btn-preview-travel"]');
    await page.waitForSelector('[data-testid="theme-compatibility-iframe"]');

    const iframeSandbox = await page
      .locator('[data-testid="theme-compatibility-iframe"]')
      .getAttribute("sandbox");
    assert(iframeSandbox === "", `Expected empty sandbox="", got ${JSON.stringify(iframeSandbox)}`);

    const iframeSrcDoc = await page
      .locator('[data-testid="theme-compatibility-iframe"]')
      .getAttribute("srcdoc");
    assert(
      iframeSrcDoc && iframeSrcDoc.includes("Solusi Desain Arsitektur"),
      "Preview iframe srcdoc must include real tenant public content",
    );
    assert(
      getStats().activeThemeId === statsBeforePreview.activeThemeId &&
        getStats().cacheVersion === statsBeforePreview.cacheVersion,
      "Preview must NOT mutate live activeThemeId or cacheVersion",
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "themes-preview-1440.png"),
      });
    }

    // Toggle mobile 360px preview viewport inside dialog
    await page.click('[data-testid="preview-viewport-mobile"]');
    assert(
      (await page.locator('[data-testid="preview-viewport-frame"]').getAttribute("data-viewport")) ===
        "mobile",
      "Preview frame should switch to mobile viewport",
    );
    await page.click('[data-testid="preview-viewport-desktop"]');
    assert(
      (await page.locator('[data-testid="preview-viewport-frame"]').getAttribute("data-viewport")) ===
        "desktop",
      "Preview frame should switch back to desktop viewport",
    );

    // Close preview with Escape key (WCAG keyboard accessibility)
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="compatibility-preview-dialog"]', {
      state: "detached",
    });

    // 3. Activate `travel` with explicit confirmation dialog & verify persistence across reload
    await page.click('[data-testid="btn-activate-travel"]');
    await page.waitForSelector('[data-testid="activate-confirm-dialog"]');
    const dialogText = await page.locator('[data-testid="activate-confirm-dialog"]').textContent();
    assert(
      dialogText.includes("Konten situs tetap 100% utuh") &&
        dialogText.includes("Konfigurasi tema sebelumnya tetap tersimpan"),
      "Confirmation dialog must explicitly explain content & prior config preservation",
    );

    await page.click('[data-testid="btn-confirm-activate"]');
    await page.waitForSelector('[data-testid="theme-success-banner"]');
    assert(
      (await page.locator('[data-testid="active-theme-id"]').textContent()).includes("travel"),
      "Active theme must update to travel after activation",
    );
    assert(
      await page.locator('[data-testid="saved-config-note-compro"]').isVisible(),
      "Previous theme compro must retain saved config indicator",
    );

    // Reload and sync with live GET endpoint to confirm persistence
    await page.reload({ waitUntil: "networkidle" });
    await page.click('[data-testid="btn-refresh-themes"]');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="active-theme-id"]')?.textContent?.includes("travel"),
    );

    // 4. Switch back `travel` -> `compro` and confirm saved config recovery banner
    await page.click('[data-testid="btn-activate-compro"]');
    await page.waitForSelector('[data-testid="confirm-recovery-notice"]');
    await page.click('[data-testid="btn-confirm-activate"]');
    await page.waitForSelector('[data-testid="theme-success-banner"]');
    const recoveryText = await page.locator('[data-testid="theme-success-banner"]').textContent();
    assert(
      recoveryText.includes("berhasil dipulihkan otomatis"),
      `Expected recovery banner text, got: ${recoveryText}`,
    );

    // 5. Simulate 409 STALE_VERSION conflict & verify recovery flow
    await page.evaluate(() => fetch("/api/test/force-conflict", { method: "POST" }));
    await page.click('[data-testid="btn-activate-catalog"]');
    await page.waitForSelector('[data-testid="btn-confirm-activate"]');
    await page.click('[data-testid="btn-confirm-activate"]');
    await page.waitForSelector('[data-testid="stale-conflict-banner"]');
    await page.click('[data-testid="btn-recover-conflict"]');
    await page.waitForSelector('[data-testid="stale-conflict-banner"]', { state: "detached" });

    // 6. Tablet 768px check
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(150);
    await checkViewportLayout(page, "768px owner");

    // 7. Mobile 360px check + screenshot
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);
    await checkViewportLayout(page, "360px owner");

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "themes-library-360.png"),
        fullPage: true,
      });
    }

    // 8. Editor Read-Only screen
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/themes-editor`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="editor-readonly-banner"]');
    assert(
      await page.locator('[data-testid="btn-activate-travel"]').isDisabled(),
      "Editor must have activate button disabled",
    );
    assert(
      await page.locator('[data-testid="btn-preview-travel"]').isDisabled(),
      "Editor must have preview button disabled",
    );

    // 9. Locked Read-Only screen
    await page.goto(`${baseUrl}/themes-locked`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="locked-readonly-banner"]');
    assert(
      await page.locator('[data-testid="btn-activate-travel"]').isDisabled(),
      "Locked tenant must have activate button disabled",
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Page errors detected: ${JSON.stringify(pageErrors)}`);

    console.log("TASK-042 E2E PASSED:", {
      viewports: ["1440x900", "768x1024", "360x800"],
      screenshots: screenshotDir || "(disabled)",
      stats: getStats(),
    });
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
