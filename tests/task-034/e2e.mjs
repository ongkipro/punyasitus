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

const screenshotDir = process.env.TASK034_SCREENSHOT_DIR || "";

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

function renderFixturePreviewHtml(tokens, sections) {
  const primary = tokens?.primaryColor || "#176b51";
  const secondary = tokens?.secondaryColor || "#0f4c5c";
  const radius = typeof tokens?.borderRadiusPx === "number" ? tokens.borderRadiusPx : 8;
  const enabledSections = (Array.isArray(sections) ? sections : []).filter(
    (s) => s.enabled !== false,
  );

  const sectionHtml = enabledSections
    .map((sec, idx) => {
      const heading = sec.heading || sec.config?.heading || sec.type || sec.kind;
      const subheading = sec.subheading || sec.config?.subheading || "";
      const isHero = (sec.type || sec.kind) === "hero";
      return `<section data-section-id="${sec.id}" data-section-order="${idx}" style="padding: 1.75rem 1.25rem; border-bottom: 1px solid #d8e2dc; background: ${isHero ? "#f4f7f5" : "#ffffff"};">
        <div style="max-width: 72rem; margin: 0 auto;">
          ${isHero ? `<h1 style="margin:0 0 0.5rem;font-size:1.75rem;color:#111c19;">${heading}</h1>` : `<h2 style="margin:0 0 0.375rem;font-size:1.25rem;color:#111c19;">${heading}</h2>`}
          ${subheading ? `<p style="margin:0 0 0.75rem;color:#4b5c55;">${subheading}</p>` : ""}
          ${isHero ? `<a data-preview-inert="link" aria-disabled="true" style="display:inline-flex;align-items:center;min-height:44px;padding:0.5rem 1.125rem;border-radius:${radius}px;background:${primary};color:#ffffff;font-weight:600;text-decoration:none;">Hubungi Klinik</a>` : ""}
        </div>
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Pratinjau Draf — Klinik Gigi Nusantara</title>
    <style>:root { --ps-brand-primary: ${primary}; --ps-brand-secondary: ${secondary}; --ps-radius: ${radius}px; } body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #111c19; background: #ffffff; }</style>
  </head>
  <body>
    <div style="background:${secondary};color:#ffffff;padding:0.5rem 1rem;font-size:0.75rem;font-weight:600;">Mode Pratinjau Draf — Perubahan belum diterbitkan ke pengunjung publik.</div>
    <main>${sectionHtml}</main>
  </body>
</html>`;
}

async function buildRealCustomizerFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t034-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const customizerImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/appearance/_ThemeCustomizer.tsx",
  );
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const themeCoreImport = path.join(root, "packages/core/src/theme/index.ts");
  const themeSharedImport = path.join(
    webDir,
    "src/pages/api/tenants/[tenantId]/theme/_shared.ts",
  );

  const sharedSetup = `
import { PLATFORM_THEME_PRESETS } from ${JSON.stringify(publicDataImport)};
import {
  ensureAccessibleBrandColor,
  PLATFORM_THEME_IDS,
  validatePageSections,
} from ${JSON.stringify(themeCoreImport)};
import { THEME_FONT_OPTIONS } from ${JSON.stringify(themeSharedImport)};

const validatedSections = validatePageSections(
  [
    {
      id: "sec-hero",
      type: "hero",
      schemaVersion: 1,
      enabled: true,
      config: {
        heading: "Klinik Gigi Nusantara — Perawatan Profesional",
        subheading: "Layanan pemeriksaan dan perawatan gigi modern dengan dokter spesialis.",
        primaryCta: { label: "Buat Janji", href: "#kontak", variant: "primary" },
      },
    },
    {
      id: "sec-services",
      type: "services_grid",
      schemaVersion: 1,
      enabled: true,
      config: {
        heading: "Layanan Unggulan Klinik",
        subheading: "Scaling, ortodonti, dan perawatan saluran akar.",
        offeringType: "service",
        limit: 6,
        items: [],
      },
    },
    {
      id: "sec-about",
      type: "about",
      schemaVersion: 1,
      enabled: true,
      config: {
        heading: "Tentang Klinik Kami",
        subheading: "Berpengalaman melayani keluarga Indonesia sejak 2018.",
        bodyHtml: "<p>Standar sterilisasi medis terkini dan ruang perawatan nyaman.</p>",
      },
    },
    {
      id: "sec-testimonials",
      type: "testimonials",
      schemaVersion: 1,
      config: {
        heading: "Testimoni Pasien",
        subheading: "Dinonaktifkan secara default sesuai ketentuan Permenkes.",
        items: [],
      },
    },
    {
      id: "sec-contact",
      type: "contact_location",
      schemaVersion: 1,
      enabled: true,
      config: {
        heading: "Lokasi & Jam Praktik",
        subheading: "Jl. Kesehatan No. 18, Jakarta Selatan — Senin–Sabtu 09.00–20.00 WIB.",
      },
    },
  ],
  { businessCategory: "Klinik Gigi" },
);

const comproPreset = PLATFORM_THEME_PRESETS.compro;
const baseState = {
  themeId: "compro",
  homepageId: 1,
  homepageSlug: "beranda",
  homepageTitle: "Beranda Klinik Gigi Nusantara",
  draft: {
    themeId: "compro",
    tokens: comproPreset.tokens,
    variants: comproPreset.variants,
    sections: validatedSections.sections,
  },
  published: {
    themeId: "compro",
    tokens: comproPreset.tokens,
    variants: comproPreset.variants,
    sections: validatedSections.enabledSections,
  },
  contrast: {
    primary: ensureAccessibleBrandColor(comproPreset.tokens.primaryColor, "#ffffff"),
    secondary: ensureAccessibleBrandColor(comproPreset.tokens.secondaryColor, "#ffffff"),
  },
  version: 2,
  versions: { themeConfig: 1, homepage: 1 },
  hasUnpublishedChanges: false,
  isHealthCategory: true,
  businessCategory: "Klinik Gigi",
  permenkesWarnings: validatedSections.warnings,
  availableThemes: PLATFORM_THEME_IDS.map((id) => PLATFORM_THEME_PRESETS[id]),
  allowedFonts: THEME_FONT_OPTIONS,
  permissions: {
    canEdit: true,
    canPublish: true,
    isLocked: false,
    role: "owner",
    tenantStatus: "active",
  },
  updatedAt: "2026-11-23T01:00:00.000Z",
  publishedAt: "2026-11-23T01:00:00.000Z",
};
`;

  const initialPreviewHtmlLiteral = JSON.stringify(
    renderFixturePreviewHtml(
      { primaryColor: "#176b51", secondaryColor: "#0f4c5c", borderRadiusPx: 8 },
      [
        {
          id: "sec-hero",
          type: "hero",
          enabled: true,
          heading: "Klinik Gigi Nusantara — Perawatan Profesional",
          subheading: "Layanan pemeriksaan dan perawatan gigi modern dengan dokter spesialis.",
        },
        {
          id: "sec-services",
          type: "services_grid",
          enabled: true,
          heading: "Layanan Unggulan Klinik",
          subheading: "Scaling, ortodonti, dan perawatan saluran akar.",
        },
        {
          id: "sec-about",
          type: "about",
          enabled: true,
          heading: "Tentang Klinik Kami",
          subheading: "Berpengalaman melayani keluarga Indonesia sejak 2018.",
        },
        {
          id: "sec-contact",
          type: "contact_location",
          enabled: true,
          heading: "Lokasi & Jam Praktik",
          subheading: "Jl. Kesehatan No. 18, Jakarta Selatan — Senin–Sabtu 09.00–20.00 WIB.",
        },
      ],
    ),
  );

  // Page 1: Owner Active Customizer
  fs.writeFileSync(
    path.join(pagesDir, "appearance.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeCustomizer } from ${JSON.stringify(customizerImport)};
${sharedSetup}
const initialPreviewHtml = ${initialPreviewHtmlLiteral};
---
<DashboardLayout
  title="Sesuaikan Tema — Klinik Gigi Nusantara"
  surface="dashboard"
  workspaceName="Klinik Gigi Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="drg. Sari Wulandari"
  userRoleLabel="Pemilik Situs"
>
  <ThemeCustomizer
    client:load
    tenantHandle="klinik-nusantara"
    workspaceName="Klinik Gigi Nusantara"
    themeApiUrl="/api/tenants/klinik-nusantara/theme"
    publishApiUrl="/api/tenants/klinik-nusantara/theme/publish"
    previewApiUrl="/api/tenants/klinik-nusantara/preview"
    initialState={baseState}
    initialPreviewHtml={initialPreviewHtml}
  />
</DashboardLayout>
`,
  );

  // Page 2: Editor Read-Only (403) Notice fixture
  fs.writeFileSync(
    path.join(pagesDir, "appearance-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeCustomizer } from ${JSON.stringify(customizerImport)};
${sharedSetup}
const editorState = {
  ...baseState,
  permissions: {
    canEdit: false,
    canPublish: false,
    isLocked: false,
    role: "editor",
    tenantStatus: "active",
  },
};
const initialPreviewHtml = ${initialPreviewHtmlLiteral};
---
<DashboardLayout
  title="Sesuaikan Tema — Klinik Gigi Nusantara"
  surface="dashboard"
  workspaceName="Klinik Gigi Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="Budi Editor"
  userRoleLabel="Editor"
>
  <ThemeCustomizer
    client:load
    tenantHandle="klinik-nusantara"
    workspaceName="Klinik Gigi Nusantara"
    themeApiUrl="/api/tenants/klinik-nusantara/theme"
    publishApiUrl="/api/tenants/klinik-nusantara/theme/publish"
    previewApiUrl="/api/tenants/klinik-nusantara/preview"
    initialState={editorState}
    initialPreviewHtml={initialPreviewHtml}
  />
</DashboardLayout>
`,
  );

  // Page 3: Locked Tenant Read-Only Notice fixture
  fs.writeFileSync(
    path.join(pagesDir, "appearance-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { ThemeCustomizer } from ${JSON.stringify(customizerImport)};
${sharedSetup}
const lockedState = {
  ...baseState,
  permissions: {
    canEdit: false,
    canPublish: false,
    isLocked: true,
    role: "owner",
    tenantStatus: "locked",
  },
};
const initialPreviewHtml = ${initialPreviewHtmlLiteral};
---
<DashboardLayout
  title="Sesuaikan Tema — Klinik Gigi Nusantara"
  surface="dashboard"
  workspaceName="Klinik Gigi Nusantara"
  workspaceSubtitle="klinik-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/klinik-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="locked"
  publicSiteHref="https://klinik-nusantara.situsku.click"
  userDisplayName="drg. Sari Wulandari"
  userRoleLabel="Pemilik Situs"
>
  <ThemeCustomizer
    client:load
    tenantHandle="klinik-nusantara"
    workspaceName="Klinik Gigi Nusantara"
    themeApiUrl="/api/tenants/klinik-nusantara/theme"
    publishApiUrl="/api/tenants/klinik-nusantara/theme/publish"
    previewApiUrl="/api/tenants/klinik-nusantara/preview"
    initialState={lockedState}
    initialPreviewHtml={initialPreviewHtml}
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
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

async function startCustomizerServer(outDir) {
  let forceConflictOnce = false;
  let cacheVersion = 1;
  let serverState = {
    themeId: "compro",
    homepageId: 1,
    homepageSlug: "beranda",
    homepageTitle: "Beranda Klinik Gigi Nusantara",
    draft: {
      themeId: "compro",
      tokens: {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        accentColor: "#1d4ed8",
        surfaceColor: "#ffffff",
        textColor: "#111c19",
        fontFamily: "system",
        borderRadiusPx: 8,
        spacingScale: 1,
        containerMaxWidthPx: 1200,
        sectionPaddingYPx: 64,
        fastestSystemFont: false,
      },
      variants: {
        styleVariant: "default",
        headerVariant: "standard",
        footerVariant: "columns",
        heroVariant: "split",
        buttonStyle: "solid",
      },
      sections: [
        {
          id: "sec-hero",
          type: "hero",
          schemaVersion: 1,
          enabled: true,
          order: 0,
          config: {
            heading: "Klinik Gigi Nusantara — Perawatan Profesional",
            subheading: "Layanan pemeriksaan dan perawatan gigi modern dengan dokter spesialis.",
            highlights: [],
          },
        },
        {
          id: "sec-services",
          type: "services_grid",
          schemaVersion: 1,
          enabled: true,
          order: 1,
          config: {
            heading: "Layanan Unggulan Klinik",
            subheading: "Scaling, ortodonti, dan perawatan saluran akar.",
            limit: 6,
            itemSlugs: [],
            items: [],
          },
        },
        {
          id: "sec-about",
          type: "about",
          schemaVersion: 1,
          enabled: true,
          order: 2,
          config: {
            heading: "Tentang Klinik Kami",
            subheading: "Berpengalaman melayani keluarga Indonesia sejak 2018.",
            bodyHtml: "<p>Standar sterilisasi medis terkini.</p>",
            milestones: [],
          },
        },
        {
          id: "sec-testimonials",
          type: "testimonials",
          schemaVersion: 1,
          enabled: false,
          order: 3,
          config: {
            heading: "Testimoni Pasien",
            subheading: "Dinonaktifkan secara default sesuai ketentuan Permenkes.",
            items: [],
          },
        },
        {
          id: "sec-contact",
          type: "contact_location",
          schemaVersion: 1,
          enabled: true,
          order: 4,
          config: {
            heading: "Lokasi & Jam Praktik",
            subheading: "Jl. Kesehatan No. 18, Jakarta Selatan.",
            mapsLabel: "Buka di Google Maps",
            branches: [],
          },
        },
      ],
    },
    published: {
      themeId: "compro",
      tokens: {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        accentColor: "#1d4ed8",
        surfaceColor: "#ffffff",
        textColor: "#111c19",
        fontFamily: "system",
        borderRadiusPx: 8,
        spacingScale: 1,
        containerMaxWidthPx: 1200,
        sectionPaddingYPx: 64,
        fastestSystemFont: false,
      },
      variants: {
        styleVariant: "default",
        headerVariant: "standard",
        footerVariant: "columns",
        heroVariant: "split",
        buttonStyle: "solid",
      },
      sections: [
        { id: "sec-hero", type: "hero", schemaVersion: 1, enabled: true, order: 0, config: { heading: "Klinik Gigi Nusantara — Perawatan Profesional", highlights: [] } },
        { id: "sec-services", type: "services_grid", schemaVersion: 1, enabled: true, order: 1, config: { heading: "Layanan Unggulan Klinik", limit: 6, itemSlugs: [], items: [] } },
        { id: "sec-about", type: "about", schemaVersion: 1, enabled: true, order: 2, config: { heading: "Tentang Klinik Kami", bodyHtml: "", milestones: [] } },
        { id: "sec-contact", type: "contact_location", schemaVersion: 1, enabled: true, order: 3, config: { heading: "Lokasi & Jam Praktik", mapsLabel: "Buka di Google Maps", branches: [] } },
      ],
    },
    contrast: {
      primary: { color: "#176b51", originalColor: "#176b51", adjusted: false, contrastRatio: 6.22 },
      secondary: { color: "#0f4c5c", originalColor: "#0f4c5c", adjusted: false, contrastRatio: 9.15 },
    },
    version: 2,
    versions: { themeConfig: 1, homepage: 1 },
    hasUnpublishedChanges: false,
    isHealthCategory: true,
    businessCategory: "Klinik Gigi",
    permenkesWarnings: [],
    availableThemes: [],
    allowedFonts: [],
    permissions: {
      canEdit: true,
      canPublish: true,
      isLocked: false,
      role: "owner",
      tenantStatus: "active",
    },
    updatedAt: "2026-11-23T01:00:00.000Z",
    publishedAt: "2026-11-23T01:00:00.000Z",
  };

  let previewCalls = 0;
  let patchCalls = 0;
  let publishCalls = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/tenants/klinik-nusantara/preview" && req.method === "POST") {
      previewCalls += 1;
      const body = await readJsonBody(req);
      const tokens = body?.draftOverride?.themeConfig?.tokens || serverState.draft.tokens;
      const sections = body?.draftOverride?.page?.sections || serverState.draft.sections;
      const html = renderFixturePreviewHtml(tokens, sections);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(
        JSON.stringify({
          html,
          themeId: "compro",
          version: serverState.version,
          resourceKind: "home",
          resourceId: 1,
          layoutMode: "standard",
          isPreview: true,
          hasUnpublishedChanges: serverState.hasUnpublishedChanges,
          sandbox: "",
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/klinik-nusantara/theme" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(serverState));
      return;
    }

    if (url.pathname === "/api/tenants/klinik-nusantara/theme" && req.method === "PATCH") {
      patchCalls += 1;
      const body = await readJsonBody(req);
      if (forceConflictOnce || body.expectedVersion !== serverState.version) {
        forceConflictOnce = false;
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: `Versi tema sudah berubah (diharapkan ${body.expectedVersion}, saat ini ${serverState.version}).`,
            },
            requestId: "req_t034_conflict",
          }),
        );
        return;
      }

      const mergedTokens = body.tokens
        ? { ...serverState.draft.tokens, ...body.tokens }
        : { ...serverState.draft.tokens };
      if (mergedTokens.headingFontFamily === null) {
        delete mergedTokens.headingFontFamily;
      }

      serverState = {
        ...serverState,
        draft: {
          ...serverState.draft,
          tokens: mergedTokens,
          variants: body.variants
            ? { ...serverState.draft.variants, ...body.variants }
            : serverState.draft.variants,
          sections: Array.isArray(body.sections) ? body.sections : serverState.draft.sections,
        },
        version: serverState.version + 2,
        versions: {
          themeConfig: serverState.versions.themeConfig + 1,
          homepage: serverState.versions.homepage + 1,
        },
        hasUnpublishedChanges: true,
        updatedAt: new Date().toISOString(),
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(serverState));
      return;
    }

    if (url.pathname === "/api/tenants/klinik-nusantara/theme/publish" && req.method === "POST") {
      publishCalls += 1;
      const body = await readJsonBody(req);
      if (body.expectedVersion !== undefined && body.expectedVersion !== serverState.version) {
        res.writeHead(409, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: "Versi tema berubah sebelum publikasi.",
            },
            requestId: "req_t034_pub_conflict",
          }),
        );
        return;
      }

      cacheVersion += 1;
      serverState = {
        ...serverState,
        published: {
          themeId: serverState.draft.themeId,
          tokens: { ...serverState.draft.tokens },
          variants: { ...serverState.draft.variants },
          sections: serverState.draft.sections.filter((s) => s.enabled),
        },
        version: serverState.version + 2,
        versions: {
          themeConfig: serverState.versions.themeConfig + 1,
          homepage: serverState.versions.homepage + 1,
        },
        hasUnpublishedChanges: false,
        publishedAt: new Date().toISOString(),
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify({ ...serverState, cacheVersion }));
      return;
    }

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
    res.writeHead(200, {
      "Content-Type": getContentType(fullPath),
      "Cache-Control": "private, no-store",
    });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    triggerConflictOnce: () => {
      forceConflictOnce = true;
    },
    getStats: () => ({ previewCalls, patchCalls, publishCalls, cacheVersion }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealCustomizerFixtures();
  const server = await startCustomizerServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const consoleErrors = [];
    const pageErrors = [];
    const externalRequests = [];
    let expectingSynthetic409 = false;

    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();

    page.on("request", (req) => {
      const reqUrl = req.url();
      if (
        !reqUrl.startsWith(server.baseUrl) &&
        !reqUrl.startsWith("about:") &&
        !reqUrl.startsWith("data:")
      ) {
        externalRequests.push(reqUrl);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (expectingSynthetic409 && text.includes("409 (Conflict)")) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // -----------------------------------------------------------------------
    // 1. Desktop 1440px: Load Customizer, Check Permenkes Notice & Zero Overflow
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/appearance/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="theme-customizer-root"]');
    await page.waitForSelector('[data-testid="customizer-preview-iframe"]');

    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopOverflow, "Desktop 1440px customizer must have zero horizontal overflow");

    // Permenkes compliance notice visible on testimonials for health category + defaulted OFF
    const permenkesNotice = page.locator('[data-testid="permenkes-notice-sec-testimonials"]');
    await permenkesNotice.waitFor({ state: "visible" });
    const testimonialsChecked = await page
      .locator('[data-testid="section-toggle-sec-testimonials"]')
      .getAttribute("aria-checked");
    assert(
      testimonialsChecked === "false",
      "Health-category testimonials section must default to aria-checked='false'",
    );

    // -----------------------------------------------------------------------
    // 2. Edit Primary Color Token + Live WCAG AA Contrast Warning & Pass
    // -----------------------------------------------------------------------
    const primaryInput = page.locator('[data-testid="input-primary-color"]');
    await primaryInput.fill("#facc15");
    await page.locator('[data-testid="primary-contrast-warning"]').waitFor({ state: "visible" });
    const warnBadge = await page.locator('[data-testid="primary-contrast-badge"]').textContent();
    assert(
      warnBadge && warnBadge.includes("< 4.5:1"),
      `Expected WCAG AA low-contrast badge, got: ${warnBadge}`,
    );

    // Now set an accessible primary color (#0f4c81)
    await primaryInput.fill("#0f4c81");
    await page.waitForTimeout(350);
    const passBadge = await page.locator('[data-testid="primary-contrast-badge"]').textContent();
    assert(
      passBadge && passBadge.includes("WCAG AA"),
      `Expected passing WCAG AA badge for #0f4c81, got: ${passBadge}`,
    );

    // Verify live sandboxed preview iframe received updated primary color
    const iframeEl = page.locator('[data-testid="customizer-preview-iframe"]');
    assert((await iframeEl.getAttribute("sandbox")) === "", "Preview iframe MUST have sandbox=\"\"");
    const updatedSrcdoc = await iframeEl.getAttribute("srcdoc");
    assert(
      updatedSrcdoc && updatedSrcdoc.includes("--ps-brand-primary: #0f4c81"),
      "Live preview iframe must reflect updated draft primary color #0f4c81",
    );

    // -----------------------------------------------------------------------
    // 3. Keyboard Section Reorder (Tab + Enter on Naik/Turun) + Focus Ring >= 2px
    // -----------------------------------------------------------------------
    const moveDownServices = page.locator('[data-testid="section-move-down-sec-services"]');
    // Focus preceding toggle then press Tab into Naik -> Tab into Turun to prove real keyboard traversal!
    await page.locator('[data-testid="section-toggle-sec-services"]').focus();
    await page.keyboard.press("Tab"); // moves to section-move-up-sec-services
    await page.keyboard.press("Tab"); // moves to section-move-down-sec-services
    const activeTestId = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") || "",
    );
    assert(
      activeTestId === "section-move-down-sec-services",
      `Expected keyboard Tab focus on section-move-down-sec-services, got ${activeTestId}`,
    );

    // Verify visible focus ring >= 2px on focused button
    const outlineWidthPx = await moveDownServices.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return Number.parseFloat(style.outlineWidth || "0");
    });
    assert(
      outlineWidthPx >= 2,
      `Keyboard focus outline width must be >= 2px, got ${outlineWidthPx}px`,
    );

    // Press Enter to move `sec-services` DOWN (past `sec-about`)
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const orderAfterDown = await page
      .locator('[data-testid="section-order-list"] > li')
      .evaluateAll((items) => items.map((el) => el.getAttribute("data-section-id")));
    assert(
      orderAfterDown[1] === "sec-about" && orderAfterDown[2] === "sec-services",
      `Expected sec-services moved below sec-about via keyboard Enter, got ${JSON.stringify(orderAfterDown)}`,
    );

    const liveStatusText = await page.locator('[data-testid="customizer-live-status"]').textContent();
    assert(
      liveStatusText && liveStatusText.includes("dipindahkan ke posisi 3"),
      `Expected polite live announcement after keyboard move, got: ${liveStatusText}`,
    );

    // -----------------------------------------------------------------------
    // 4. Toggle Section Off & On + Verify Preview Reflects Toggle
    // -----------------------------------------------------------------------
    const aboutToggle = page.locator('[data-testid="section-toggle-sec-about"]');
    await aboutToggle.click();
    assert(
      (await aboutToggle.getAttribute("aria-checked")) === "false",
      "About toggle must become aria-checked='false'",
    );
    await page.waitForTimeout(350);
    const srcdocWithoutAbout = await iframeEl.getAttribute("srcdoc");
    assert(
      srcdocWithoutAbout && !srcdocWithoutAbout.includes('data-section-id="sec-about"'),
      "Preview iframe must hide sec-about when toggled OFF",
    );

    // Toggle about back ON so all core sections are visible for screenshot & publish
    await aboutToggle.click();
    assert(
      (await aboutToggle.getAttribute("aria-checked")) === "true",
      "About toggle must return to aria-checked='true'",
    );
    await page.waitForTimeout(350);

    // -----------------------------------------------------------------------
    // 5. Save Draft, Verify 409 Conflict Recovery, Then Atomic Publish
    // -----------------------------------------------------------------------
    await page.locator('[data-testid="customizer-save-draft-btn"]').click();
    await page.locator('[data-testid="customizer-success-banner"]').waitFor({ state: "visible" });
    const summaryBeforePublish = await page
      .locator('[data-testid="customizer-published-summary"]')
      .textContent();
    assert(
      summaryBeforePublish && summaryBeforePublish.includes("#176b51"),
      "Published summary must remain #176b51 after saving draft only",
    );

    // Trigger 409 conflict once -> verify conflict banner + reload button clears it cleanly
    expectingSynthetic409 = true;
    server.triggerConflictOnce();
    await page.locator('[data-testid="radius-preset-12"]').click();
    await page.locator('[data-testid="customizer-save-draft-btn"]').click();
    await page.locator('[data-testid="customizer-conflict-banner"]').waitFor({ state: "visible" });
    expectingSynthetic409 = false;
    await page.locator('[data-testid="customizer-conflict-reload-btn"]').click();
    await page.waitForTimeout(250);
    assert(
      (await page.locator('[data-testid="customizer-conflict-banner"]').count()) === 0,
      "Conflict banner must clear after reloading latest version",
    );

    // Publish atomically -> verify published summary updates to #0f4c81 + cache version badge!
    await page.locator('[data-testid="customizer-publish-btn"]').click();
    await page.locator('[data-testid="customizer-published-status-badge"]').waitFor({
      state: "visible",
    });
    await page.locator('[data-testid="customizer-cache-version-badge"]').waitFor({
      state: "visible",
    });
    const summaryAfterPublish = await page
      .locator('[data-testid="customizer-published-summary"]')
      .textContent();
    assert(
      summaryAfterPublish && summaryAfterPublish.includes("#0f4c81"),
      `Expected published summary to update to #0f4c81 after atomic publish, got: ${summaryAfterPublish}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "appearance-customizer-1440.png"),
        fullPage: false,
      });
    }

    // -----------------------------------------------------------------------
    // 6. Mobile 360px Viewport: Zero Overflow, >= 44px Tap Targets & Screenshot
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(200);

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobileOverflow, "Mobile 360px customizer must have zero horizontal overflow");

    const tapTargetIds = [
      "customizer-save-draft-btn",
      "customizer-publish-btn",
      "customizer-mobile-tab-edit",
      "customizer-mobile-tab-preview",
      "section-toggle-sec-hero",
      "section-move-down-sec-hero",
    ];
    for (const tid of tapTargetIds) {
      const box = await page.locator(`[data-testid="${tid}"]`).boundingBox();
      assert(
        box && box.height >= 44,
        `Mobile tap target [data-testid="${tid}"] must have height >= 44px, got ${box?.height}`,
      );
    }

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "appearance-customizer-360.png"),
        fullPage: false,
      });
    }

    // Switch to Pratinjau tab on mobile and confirm zero overflow + visible iframe
    await page.locator('[data-testid="customizer-mobile-tab-preview"]').click();
    await page.waitForTimeout(150);
    await iframeEl.waitFor({ state: "visible" });
    const mobilePreviewOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobilePreviewOverflow, "Mobile 360px preview tab must have zero horizontal overflow");

    // -----------------------------------------------------------------------
    // 7. Editor 403 Read-Only Notice & Locked Read-Only Notice
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/appearance-editor/`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="customizer-readonly-editor-banner"]').waitFor({
      state: "visible",
    });
    assert(
      await page.locator('[data-testid="customizer-save-draft-btn"]').isDisabled(),
      "Editor read-only mode must disable Simpan Draf",
    );
    assert(
      await page.locator('[data-testid="customizer-publish-btn"]').isDisabled(),
      "Editor read-only mode must disable Terbitkan Perubahan",
    );

    await page.goto(`${server.baseUrl}/appearance-locked/`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="customizer-readonly-locked-banner"]').waitFor({
      state: "visible",
    });
    assert(
      await page.locator('[data-testid="customizer-publish-btn"]').isDisabled(),
      "Locked tenant mode must disable Terbitkan Perubahan",
    );

    // -----------------------------------------------------------------------
    // 8. Zero Console Errors, Zero Page Errors, Zero External Tracking Requests
    // -----------------------------------------------------------------------
    assert(
      externalRequests.length === 0,
      `Expected zero external tracking requests, got: ${JSON.stringify(externalRequests)}`,
    );
    assert(
      consoleErrors.length === 0,
      `Expected zero console errors, got: ${JSON.stringify(consoleErrors)}`,
    );
    assert(
      pageErrors.length === 0,
      `Expected zero page errors, got: ${JSON.stringify(pageErrors)}`,
    );

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-034",
        viewportsTested: [360, 1440],
        stats: server.getStats(),
        consoleErrors: consoleErrors.length,
        pageErrors: pageErrors.length,
        externalRequests: externalRequests.length,
        screenshotDir: screenshotDir || null,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
