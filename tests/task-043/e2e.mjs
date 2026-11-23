/* global process, console, document, fetch, URL */
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

const screenshotDir = process.env.TASK043_SCREENSHOT_DIR || "/tmp/task-043-screenshots";

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

async function buildRealPresetFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t043-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const wizardImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/onboarding/_StarterPresetWizard.tsx",
  );
  const presetsCoreImport = path.join(root, "packages/core/src/presets/index.ts");

  const sharedSetup = `
import {
  buildCompanyProfileStarterComposition,
  evaluatePresetChecklist,
  STARTER_PRESET_CATALOG,
} from ${JSON.stringify(presetsCoreImport)};

const initialChecklist = evaluatePresetChecklist({
  handle: "prima-nusantara",
  siteTitle: "PT Prima Nusantara",
  businessName: "PT Prima Nusantara",
  hasCustomizedDraftSection: false,
  nonTrashedPagesCount: 2,
  nonTrashedOfferingsCount: 3,
  whatsappE164: "+6281234567890",
  phone: "021-5550101",
  email: "halo@prima-nusantara.id",
  hasPrivacyPage: false,
  hasPreviewedPreset: false,
  activeCustomHostname: null,
  fallbackHost: "prima-nusantara.situsku.click",
});

const emptyOwnerState = {
  tenantId: "01JT043E2ETENANT0000000001",
  handle: "prima-nusantara",
  tenantName: "PT Prima Nusantara",
  vertical: "compro",
  businessCategory: "LocalBusiness",
  isHealthCategory: false,
  activeThemeId: "compro",
  cacheVersion: 4,
  catalog: STARTER_PRESET_CATALOG,
  setup: null,
  checklist: initialChecklist,
  contentSummary: {
    pages: 2,
    publishedPages: 1,
    posts: 3,
    offerings: 3,
    menus: 1,
    media: 5,
    hasExistingHomepage: true,
    homepageIsPublished: true,
    isPopulatedTenant: true,
  },
  permissions: {
    canRead: true,
    canPreview: true,
    canMutate: true,
    isLocked: false,
    role: "owner",
    tenantStatus: "active",
  },
};

const builtSample = buildCompanyProfileStarterComposition({
  businessName: "PT Prima Nusantara",
  businessCategory: "LocalBusiness",
  address: "Jl. Gatot Subroto Kav. 21, Jakarta",
  phone: "021-5550101",
  email: "halo@prima-nusantara.id",
});

const lockedState = {
  ...emptyOwnerState,
  setup: {
    presetId: "company_profile",
    applyMode: "staged_draft",
    status: "draft",
    version: 1,
    lastOperationKey: "op-locked-init",
    previewedAt: null,
    publishedAt: null,
    createdAt: "2026-11-23T06:00:00.000Z",
    updatedAt: "2026-11-23T06:00:00.000Z",
    sections: builtSample.sections.map((section) => ({
      id: section.id,
      type: section.type,
      order: section.order,
      enabled: section.enabled,
      optional: builtSample.optionalSectionIds.includes(section.id),
      selectedForPublish: builtSample.defaultSelectedPublishSectionIds.includes(section.id),
      isPublished: false,
      containsSampleCopy: builtSample.sampleSectionIds.includes(section.id),
      sampleFindings: [],
      section,
    })),
    sampleSectionIds: builtSample.sampleSectionIds,
    selectedPublishSectionIds: builtSample.defaultSelectedPublishSectionIds,
    publishedSectionIds: [],
    warnings: [],
  },
  permissions: {
    canRead: true,
    canPreview: true,
    canMutate: false,
    isLocked: true,
    role: "owner",
    tenantStatus: "locked",
  },
};
`;

  // Page 1: /onboarding (Owner Active, Populated Tenant)
  fs.writeFileSync(
    path.join(pagesDir, "onboarding-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { StarterPresetWizard } from ${JSON.stringify(wizardImport)};
${sharedSetup}
---
<DashboardLayout
  title="Onboarding Preset Pemula — PT Prima Nusantara"
  surface="dashboard"
  workspaceName="PT Prima Nusantara"
  workspaceSubtitle="prima-nusantara.situsku.click"
  activeNavId="home"
  basePath="/dashboard/prima-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <StarterPresetWizard
    client:load
    tenantHandle="prima-nusantara"
    workspaceName="PT Prima Nusantara"
    surfaceMode="onboarding"
    presetsApiUrl="/api/tenants/prima-nusantara/presets"
    applyApiUrl="/api/tenants/prima-nusantara/presets/apply"
    draftApiUrl="/api/tenants/prima-nusantara/presets/draft"
    previewApiUrl="/api/tenants/prima-nusantara/presets/preview"
    publishApiUrl="/api/tenants/prima-nusantara/presets/publish"
    customizerHref="/dashboard/prima-nusantara/appearance"
    pagesHref="/dashboard/prima-nusantara/pages"
    initialState={emptyOwnerState}
  />
</DashboardLayout>
`,
  );

  // Page 2: /appearance/presets (Locked Tenant Read-Only)
  fs.writeFileSync(
    path.join(pagesDir, "presets-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { StarterPresetWizard } from ${JSON.stringify(wizardImport)};
${sharedSetup}
---
<DashboardLayout
  title="Preset Pemula (Terkunci) — PT Prima Nusantara"
  surface="dashboard"
  workspaceName="PT Prima Nusantara"
  workspaceSubtitle="prima-nusantara.situsku.click"
  activeNavId="theme"
  basePath="/dashboard/prima-nusantara"
  offeringLabel="Layanan"
  lifecycleStatus="locked"
  userDisplayName="Budi Santoso"
  userRoleLabel="Pemilik Situs"
>
  <StarterPresetWizard
    client:load
    tenantHandle="prima-nusantara"
    workspaceName="PT Prima Nusantara"
    surfaceMode="appearance_presets"
    presetsApiUrl="/api/tenants/prima-nusantara/presets"
    applyApiUrl="/api/tenants/prima-nusantara/presets/apply"
    draftApiUrl="/api/tenants/prima-nusantara/presets/draft"
    previewApiUrl="/api/tenants/prima-nusantara/presets/preview"
    publishApiUrl="/api/tenants/prima-nusantara/presets/publish"
    customizerHref="/dashboard/prima-nusantara/appearance"
    pagesHref="/dashboard/prima-nusantara/pages"
    initialState={lockedState}
  />
</DashboardLayout>
`,
  );

  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;
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

async function createPresetApiServer(outDir) {
  const presetsCore = await import(pathToFileURL(path.join(root, "packages/core/src/presets/index.ts")).href);
  const {
    buildCompanyProfileStarterComposition,
    computeSampleSectionIds,
    detectSampleClaimsInSection,
    evaluatePresetChecklist,
    isOptionalCompanyProfileSection,
    STARTER_PRESET_CATALOG,
    validatePresetSelectivePublish,
    PresetDomainError,
  } = presetsCore;

  let setup = null;
  let version = 0;
  let cacheVersion = 4;
  let previewedAt = null;
  let publishedAt = null;
  let forceConflictOnce = false;
  const seenOperationKeys = new Map();

  function buildCurrentState() {
    const sections = setup ? setup.sections : [];
    const selectedSet = new Set(setup ? setup.selectedPublishSectionIds : []);
    const publishedSet = new Set(setup ? setup.publishedSectionIds : []);

    const sectionDtos = sections.map((section, idx) => {
      const findings = detectSampleClaimsInSection(section);
      return {
        id: section.id,
        type: section.type,
        order: idx,
        enabled: section.enabled,
        optional: isOptionalCompanyProfileSection(section.id),
        selectedForPublish: selectedSet.has(section.id),
        isPublished: publishedSet.has(section.id),
        containsSampleCopy: findings.length > 0,
        sampleFindings: findings,
        section,
      };
    });

    const hasCustomized = sectionDtos.some(
      (s) => !s.containsSampleCopy && (s.type === "hero" || s.type === "about"),
    );

    return {
      tenantId: "01JT043E2ETENANT0000000001",
      handle: "prima-nusantara",
      tenantName: "PT Prima Nusantara",
      vertical: "compro",
      businessCategory: "LocalBusiness",
      isHealthCategory: false,
      activeThemeId: "compro",
      cacheVersion,
      catalog: STARTER_PRESET_CATALOG,
      setup: setup
        ? {
            presetId: "company_profile",
            applyMode: setup.applyMode,
            status: setup.status,
            version,
            lastOperationKey: setup.lastOperationKey,
            previewedAt,
            publishedAt,
            createdAt: setup.createdAt,
            updatedAt: new Date().toISOString(),
            sections: sectionDtos,
            sampleSectionIds: sectionDtos.filter((s) => s.containsSampleCopy).map((s) => s.id),
            selectedPublishSectionIds: sectionDtos
              .filter((s) => s.selectedForPublish)
              .map((s) => s.id),
            publishedSectionIds: sectionDtos.filter((s) => s.isPublished).map((s) => s.id),
            warnings: [],
          }
        : null,
      checklist: evaluatePresetChecklist({
        handle: "prima-nusantara",
        siteTitle: "PT Prima Nusantara",
        businessName: "PT Prima Nusantara",
        hasCustomizedDraftSection: hasCustomized,
        nonTrashedPagesCount: 2,
        nonTrashedOfferingsCount: 3,
        whatsappE164: "+6281234567890",
        phone: "021-5550101",
        email: "halo@prima-nusantara.id",
        hasPrivacyPage: false,
        hasPreviewedPreset: Boolean(previewedAt),
        activeCustomHostname: null,
        fallbackHost: "prima-nusantara.situsku.click",
      }),
      contentSummary: {
        pages: 2,
        publishedPages: 1,
        posts: 3,
        offerings: 3,
        menus: 1,
        media: 5,
        hasExistingHomepage: true,
        homepageIsPublished: true,
        isPopulatedTenant: true,
      },
      permissions: {
        canRead: true,
        canPreview: true,
        canMutate: true,
        isLocked: false,
        role: "owner",
        tenantStatus: "active",
      },
    };
  }

  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
  };

  function readJson(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/test/force-conflict" && req.method === "POST") {
      forceConflictOnce = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/tenants/prima-nusantara/presets" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(buildCurrentState()));
      return;
    }

    if (url.pathname === "/api/tenants/prima-nusantara/presets/apply" && req.method === "POST") {
      const body = await readJson(req);
      if (seenOperationKeys.has(body.operationKey)) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            state: buildCurrentState(),
            operationKey: body.operationKey,
            applyMode: "staged_draft",
            idempotentReplay: true,
            createdHomepageDraft: false,
            createdHeaderMenuDraft: false,
            preservedExistingContent: true,
          }),
        );
        return;
      }

      const built = buildCompanyProfileStarterComposition({
        businessName: "PT Prima Nusantara",
        businessCategory: "LocalBusiness",
        address: "Jl. Gatot Subroto Kav. 21, Jakarta",
        phone: "021-5550101",
        email: "halo@prima-nusantara.id",
      });
      version += 1;
      setup = {
        applyMode: body.applyMode === "merge_draft" ? "merged_draft" : "staged_draft",
        status: "draft",
        lastOperationKey: body.operationKey,
        createdAt: new Date().toISOString(),
        sections: built.sections,
        selectedPublishSectionIds: built.defaultSelectedPublishSectionIds,
        publishedSectionIds: [],
      };
      seenOperationKeys.set(body.operationKey, true);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          state: buildCurrentState(),
          operationKey: body.operationKey,
          applyMode: setup.applyMode,
          idempotentReplay: false,
          createdHomepageDraft: false,
          createdHeaderMenuDraft: false,
          preservedExistingContent: true,
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/prima-nusantara/presets/draft" && req.method === "PATCH") {
      const body = await readJson(req);
      if (forceConflictOnce || body.expectedVersion !== version) {
        forceConflictOnce = false;
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message: "Versi draf preset telah berubah di sesi lain. Muat ulang data terbaru.",
            },
            requestId: "req_t043_409",
          }),
        );
        return;
      }
      version += 1;
      setup = {
        ...setup,
        sections: body.sections,
        selectedPublishSectionIds: body.selectedPublishSectionIds ?? setup.selectedPublishSectionIds,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(buildCurrentState()));
      return;
    }

    if (url.pathname === "/api/tenants/prima-nusantara/presets/preview" && req.method === "POST") {
      const body = await readJson(req);
      previewedAt = new Date().toISOString();
      const current = buildCurrentState();
      const rendered = (current.setup?.sections ?? []).filter((s) =>
        body.selectedSectionIds ? body.selectedSectionIds.includes(s.id) : s.enabled,
      );
      const sampleIds = rendered.filter((s) => s.containsSampleCopy).map((s) => s.id);
      const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="robots" content="noindex, nofollow"/><title>Pratinjau Preset</title><style>body{margin:0;font-family:system-ui,sans-serif;color:#182522;background:#fff}header{background:#176b51;color:#fff;padding:12px 18px;font-size:13px;font-weight:600}section{padding:24px 18px;border-bottom:1px solid #d9e2dd}</style></head><body data-preview="true"><header>Pratinjau Draf Preset Profil Perusahaan — PT Prima Nusantara</header><main>${rendered
        .map(
          (s) =>
            `<section><h2>${String(s.section.config.heading || s.type)}</h2><p>${String(s.section.config.subheading || "")}</p></section>`,
        )
        .join("")}</main></body></html>`;

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'none'",
      });
      res.end(
        JSON.stringify({
          html,
          presetId: "company_profile",
          sandbox: "",
          isPreview: true,
          renderedSectionIds: rendered.map((s) => s.id),
          sampleSectionIds: sampleIds,
          hasSampleContent: sampleIds.length > 0,
          version,
        }),
      );
      return;
    }

    if (url.pathname === "/api/tenants/prima-nusantara/presets/publish" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const selective = validatePresetSelectivePublish({
          presetId: body.presetId,
          draftSections: setup.sections,
          selectedSectionIds: body.selectedSectionIds,
          businessCategory: "LocalBusiness",
        });
        version += 1;
        cacheVersion += 1;
        publishedAt = new Date().toISOString();
        setup = {
          ...setup,
          status: "published",
          publishedSectionIds: selective.selectedSections.map((s) => s.id),
          selectedPublishSectionIds: selective.selectedSections.map((s) => s.id),
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            state: buildCurrentState(),
            publishedSectionIds: setup.publishedSectionIds,
            unpublishedDraftSectionIds: selective.unpublishedDraftSectionIds,
            cacheVersion,
            publishedAt,
            revisionNumber: 1,
          }),
        );
      } catch (err) {
        const status = err instanceof PresetDomainError ? err.httpStatus : 422;
        const code = err instanceof PresetDomainError ? err.code : "VALIDATION_ERROR";
        const fields = err instanceof PresetDomainError ? err.fields : [];
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code,
              message: err instanceof Error ? err.message : "Validation failed",
              fields,
            },
            requestId: "req_t043_pub_err",
          }),
        );
      }
      return;
    }

    // Serve static Astro files
    let filePath = path.join(
      outDir,
      url.pathname === "/" ? "onboarding-owner/index.html" : url.pathname,
    );
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
    getStats: () => ({
      version,
      cacheVersion,
      status: setup?.status ?? "none",
      publishedCount: setup?.publishedSectionIds.length ?? 0,
      sampleCount: setup ? computeSampleSectionIds(setup.sections).length : 0,
    }),
  };
}

async function checkViewportNoOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return { overflowX };
  });
  assert(
    metrics.overflowX <= 1,
    `${label}: horizontal overflow detected (${metrics.overflowX}px)`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildRealPresetFixtures();
  const { server, getStats } = await createPresetApiServer(outDir);

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
        // Ignore expected HTTP 409 / 422 test-flow logs
        if (text.includes("status of 409") || text.includes("status of 422")) return;
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Desktop 1440px: Initial onboarding page on populated tenant
    await page.goto(`${baseUrl}/onboarding-owner`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="starter-preset-wizard-root"]');
    assert(
      await page.locator('[data-testid="preset-populated-notice"]').isVisible(),
      "Populated-tenant safety notice must be visible",
    );
    assert(
      await page.locator('[data-testid="preset-empty-state"]').isVisible(),
      "Empty draft state must appear before applying preset",
    );
    await checkViewportNoOverflow(page, "1440px initial onboarding");

    // 2. Apply Company-Profile starter preset as draft
    await page.click('[data-testid="apply-preset-company_profile"]');
    await page.waitForSelector('[data-testid="preset-sections-list"]');
    assert(
      await page.locator('[data-testid="sample-badge-preset-hero"]').isVisible(),
      "Sample badge must clearly mark unedited hero section",
    );
    assert(
      await page.locator('[data-testid="checklist-item-identity"]').isVisible(),
      "Checklist identity item must render",
    );
    await checkViewportNoOverflow(page, "1440px applied draft");

    const shot1 = path.join(screenshotDir, "01-onboarding-desktop-1440.png");
    await page.screenshot({ path: shot1, fullPage: true });

    // 3. Attempting to publish while sample hero/about are selected -> server blocks with SAMPLE_CONTENT_BLOCKED!
    await page.click('[data-testid="preset-open-publish-btn"]');
    await page.waitForSelector('[data-testid="publish-sample-warning"]');
    await page.click('[data-testid="preset-confirm-publish-btn"]');
    await page.waitForSelector('[data-testid="preset-error-alert"]');
    const errText = await page.locator('[data-testid="preset-error-alert"]').textContent();
    assert(
      errText && errText.includes("Teks Contoh Belum Dapat Diterbitkan"),
      `Expected sample-content block alert, got: ${errText}`,
    );

    // 4. Customize Hero and About inline to remove sample markers, reorder with keyboard button, save draft
    await page.click('[data-testid="edit-section-preset-hero"]');
    await page.waitForSelector('[data-testid="editor-panel-preset-hero"]');
    await page.fill('[data-testid="input-eyebrow-preset-hero"]', "Profil Perusahaan");
    await page.fill(
      '[data-testid="input-heading-preset-hero"]',
      "PT Prima Nusantara — Mitra Konstruksi Komersial",
    );
    await page.fill(
      '[data-testid="input-subheading-preset-hero"]',
      "Layanan desain arsitektur dan bangun gedung usaha dengan standar mutu terukur.",
    );
    await page.click('[data-testid="apply-edit-preset-hero"]');

    await page.click('[data-testid="edit-section-preset-about"]');
    await page.waitForSelector('[data-testid="editor-panel-preset-about"]');
    await page.fill('[data-testid="input-heading-preset-about"]', "Tentang PT Prima Nusantara");
    await page.fill(
      '[data-testid="input-subheading-preset-about"]',
      "Pengalaman mendampingi klien korporasi di wilayah Jabodetabek dan sekitarnya.",
    );
    await page.fill(
      '[data-testid="input-body-preset-about"]',
      "PT Prima Nusantara menyediakan jasa perencanaan dan pelaksanaan konstruksi komersial secara transparan.",
    );
    await page.click('[data-testid="apply-edit-preset-about"]');

    // Test keyboard ordering button (move Services down once)
    await page.click('[data-testid="move-down-preset-services"]');

    // Simulate 409 STALE_VERSION conflict first to verify conflict recovery banner
    await page.evaluate(() => fetch("/api/test/force-conflict", { method: "POST" }));
    await page.click('[data-testid="preset-save-draft-btn"]');
    await page.waitForSelector('[data-testid="preset-error-alert"]');
    const conflictText = await page.locator('[data-testid="preset-error-alert"]').textContent();
    assert(
      conflictText && conflictText.includes("409"),
      `Expected 409 conflict notice, got: ${conflictText}`,
    );

    // Retry save draft cleanly (inputs preserved!)
    await page.click('[data-testid="preset-save-draft-btn"]');
    await page.waitForSelector('[data-testid="ready-badge-preset-hero"]');
    assert(
      await page.locator('[data-testid="ready-badge-preset-about"]').isVisible(),
      "About section must turn Siap Terbit after removing sample copy",
    );

    // 5. Open Responsive Draft Preview Dialog (sandbox="", desktop + mobile toggle)
    await page.click('[data-testid="preset-preview-btn"]');
    await page.waitForSelector('[data-testid="preset-preview-iframe"]');
    const sandboxAttr = await page
      .locator('[data-testid="preset-preview-iframe"]')
      .getAttribute("sandbox");
    assert(sandboxAttr === "", `Preview iframe must have empty sandbox="", got ${sandboxAttr}`);

    const shot3 = path.join(screenshotDir, "03-presets-preview-desktop-1440.png");
    await page.screenshot({ path: shot3 });

    await page.click('[data-testid="preview-viewport-mobile"]');
    await page.click('[data-testid="preview-viewport-desktop"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="preset-preview-dialog"]', { state: "detached" });

    // 6. Publish ONLY the validated selected sections (hero, about, services, contact)
    await page.click('[data-testid="preset-open-publish-btn"]');
    await page.waitForSelector('[data-testid="preset-publish-dialog"]');
    await page.click('[data-testid="preset-confirm-publish-btn"]');
    await page.waitForSelector('[data-testid="preset-success-alert"]');
    const pubSuccess = await page.locator('[data-testid="preset-success-alert"]').textContent();
    assert(
      pubSuccess && pubSuccess.includes("berhasil diterbitkan secara atomik"),
      `Expected atomic publish success banner, got: ${pubSuccess}`,
    );
    assert(getStats().status === "published", "Server state must be published");
    assert(getStats().publishedCount >= 3, "At least 3 validated sections must be published");

    const shot4 = path.join(screenshotDir, "04-presets-published-desktop-1440.png");
    await page.screenshot({ path: shot4, fullPage: true });

    // 7. Mobile 360px viewport check + screenshot on active onboarding screen
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);
    await checkViewportNoOverflow(page, "360px onboarding published");

    const shot2 = path.join(screenshotDir, "02-onboarding-mobile-360.png");
    await page.screenshot({ path: shot2, fullPage: true });

    // 8. Locked Read-Only screen on Appearance > Presets at 360px + 1440px
    await page.goto(`${baseUrl}/presets-locked`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="preset-locked-banner"]');
    assert(
      await page.locator('[data-testid="apply-preset-company_profile"]').isDisabled(),
      "Locked tenant must disable apply button",
    );
    assert(
      await page.locator('[data-testid="preset-open-publish-btn"]').isDisabled(),
      "Locked tenant must disable publish button",
    );
    await checkViewportNoOverflow(page, "360px locked presets");

    const shot5 = path.join(screenshotDir, "05-presets-locked-mobile-360.png");
    await page.screenshot({ path: shot5, fullPage: true });

    assert(consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Page errors detected: ${JSON.stringify(pageErrors)}`);

    console.log("TASK-043 E2E PASSED:", {
      viewports: ["1440x900", "360x800"],
      screenshots: [shot1, shot2, shot3, shot4, shot5],
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
