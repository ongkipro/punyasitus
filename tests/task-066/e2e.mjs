/* global process, console, document, URL */
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

const screenshotDir = process.env.TASK066_SCREENSHOT_DIR || "/tmp/qa-task-066";

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

async function buildRealOnboardingFixture() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t066-e2e-"));
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

  fs.writeFileSync(
    path.join(pagesDir, "onboarding-m2.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { StarterPresetWizard } from ${JSON.stringify(wizardImport)};
import {
  evaluatePresetChecklist,
  evaluateVerticalLaunchChecklist,
  STARTER_PRESET_CATALOG,
  VERTICAL_STARTER_PRESET_CATALOG,
} from ${JSON.stringify(presetsCoreImport)};

const baseFacts = {
  handle: "berkah-mandiri",
  siteTitle: "PT Berkah Mandiri Nusantara",
  businessName: "PT Berkah Mandiri Nusantara",
  hasCustomizedDraftSection: false,
  nonTrashedPagesCount: 0,
  nonTrashedOfferingsCount: 0,
  serviceOfferingsCount: 0,
  publishedServiceOfferingsCount: 0,
  tourOfferingsCount: 0,
  publishedTourOfferingsCount: 0,
  hasUmrahSkPpiuVerified: false,
  outletsCount: 0,
  publishedOutletsCount: 0,
  whatsappE164: "+6281234567890",
  phone: "021-5550199",
  email: "halo@berkah-mandiri.id",
  hasPrivacyPage: false,
  hasPreviewedPreset: false,
  activeCustomHostname: null,
  fallbackHost: "berkah-mandiri.situsku.click",
  googleMapsReviewUrl: null,
  hasPublishedGoogleMapsReviewUrl: false,
};

const checklistByPreset = {
  company_profile: evaluateVerticalLaunchChecklist({ ...baseFacts, presetId: "company_profile" }),
  professional_services: evaluateVerticalLaunchChecklist({ ...baseFacts, presetId: "professional_services" }),
  travel_umrah: evaluateVerticalLaunchChecklist({ ...baseFacts, presetId: "travel_umrah" }),
  multi_outlet: evaluateVerticalLaunchChecklist({ ...baseFacts, presetId: "multi_outlet" }),
};

const initialM1State = {
  tenantId: "01JT066E2ETENANT0000000001",
  handle: "berkah-mandiri",
  tenantName: "PT Berkah Mandiri Nusantara",
  vertical: "sales",
  businessCategory: "LocalBusiness",
  isHealthCategory: false,
  activeThemeId: "sales",
  cacheVersion: 1,
  catalog: STARTER_PRESET_CATALOG,
  setup: null,
  checklist: evaluatePresetChecklist(baseFacts),
  contentSummary: {
    pages: 0,
    publishedPages: 0,
    posts: 0,
    offerings: 0,
    menus: 0,
    media: 0,
    hasExistingHomepage: false,
    homepageIsPublished: false,
    isPopulatedTenant: false,
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

const initialVerticalState = {
  tenantId: "01JT066E2ETENANT0000000001",
  handle: "berkah-mandiri",
  tenantName: "PT Berkah Mandiri Nusantara",
  vertical: "sales",
  businessCategory: "LocalBusiness",
  isHealthCategory: false,
  activeThemeId: "sales",
  cacheVersion: 1,
  recommendedPresetId: "professional_services",
  catalog: VERTICAL_STARTER_PRESET_CATALOG,
  setup: null,
  checklist: checklistByPreset.professional_services,
  checklistByPreset,
  contentSummary: {
    pages: 0,
    publishedPages: 0,
    posts: 0,
    offerings: 0,
    serviceOfferings: 0,
    publishedServiceOfferings: 0,
    tourOfferings: 0,
    publishedTourOfferings: 0,
    outlets: 0,
    publishedOutlets: 0,
    menus: 0,
    media: 0,
    hasExistingHomepage: false,
    homepageIsPublished: false,
    isPopulatedTenant: false,
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
---
<DashboardLayout
  title="Onboarding Preset Pemula — PT Berkah Mandiri Nusantara"
  surface="dashboard"
  workspaceName="PT Berkah Mandiri Nusantara"
  workspaceSubtitle="berkah-mandiri.situsku.click"
  activeNavId="home"
  basePath="/dashboard/berkah-mandiri"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  userDisplayName="Rina Wijaya"
  userRoleLabel="Pemilik Situs"
>
  <StarterPresetWizard
    client:load
    tenantHandle="berkah-mandiri"
    workspaceName="PT Berkah Mandiri Nusantara"
    surfaceMode="onboarding"
    presetsApiUrl="/api/tenants/berkah-mandiri/presets"
    applyApiUrl="/api/tenants/berkah-mandiri/presets/apply"
    draftApiUrl="/api/tenants/berkah-mandiri/presets/draft"
    previewApiUrl="/api/tenants/berkah-mandiri/presets/preview"
    publishApiUrl="/api/tenants/berkah-mandiri/presets/publish"
    verticalPresetsApiUrl="/dashboard/berkah-mandiri/onboarding/api"
    customizerHref="/dashboard/berkah-mandiri/appearance"
    pagesHref="/dashboard/berkah-mandiri/pages"
    initialState={initialM1State}
    initialVerticalState={initialVerticalState}
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

async function createOnboardingTestServer(outDir) {
  const presetsCore = await import(
    pathToFileURL(path.join(root, "packages/core/src/presets/index.ts")).href
  );
  const {
    buildVerticalStarterComposition,
    detectSampleClaimsInSection,
    evaluateVerticalLaunchChecklist,
    isOptionalVerticalSection,
    toStorageStarterPresetId,
    VERTICAL_STARTER_PRESET_CATALOG,
  } = presetsCore;

  let activeSetup = null;
  let version = 0;
  let previewedAt = null;
  const seenKeys = new Map();
  let createdPagesCount = 0;
  let createdServicesCount = 0;
  let createdToursCount = 0;
  let createdOutletsCount = 0;

  function buildState() {
    const facts = {
      handle: "berkah-mandiri",
      siteTitle: "PT Berkah Mandiri Nusantara",
      businessName: "PT Berkah Mandiri Nusantara",
      hasCustomizedDraftSection: false,
      nonTrashedPagesCount: createdPagesCount,
      nonTrashedOfferingsCount: createdServicesCount + createdToursCount,
      serviceOfferingsCount: createdServicesCount,
      publishedServiceOfferingsCount: 0,
      tourOfferingsCount: createdToursCount,
      publishedTourOfferingsCount: 0,
      hasUmrahSkPpiuVerified: false,
      outletsCount: createdOutletsCount,
      publishedOutletsCount: 0,
      whatsappE164: "+6281234567890",
      phone: "021-5550199",
      email: "halo@berkah-mandiri.id",
      hasPrivacyPage: false,
      hasPreviewedPreset: Boolean(previewedAt),
      activeCustomHostname: null,
      fallbackHost: "berkah-mandiri.situsku.click",
      googleMapsReviewUrl: null,
      hasPublishedGoogleMapsReviewUrl: false,
    };

    const checklistByPreset = {
      company_profile: evaluateVerticalLaunchChecklist({ ...facts, presetId: "company_profile" }),
      professional_services: evaluateVerticalLaunchChecklist({
        ...facts,
        presetId: "professional_services",
      }),
      travel_umrah: evaluateVerticalLaunchChecklist({ ...facts, presetId: "travel_umrah" }),
      multi_outlet: evaluateVerticalLaunchChecklist({ ...facts, presetId: "multi_outlet" }),
    };

    const setupDto = activeSetup
      ? {
          presetId: activeSetup.presetId,
          storagePresetId: toStorageStarterPresetId(activeSetup.presetId),
          applyMode: "initialized_draft",
          status: "draft",
          version,
          lastOperationKey: activeSetup.setupKey,
          previewedAt,
          publishedAt: null,
          createdAt: activeSetup.createdAt,
          updatedAt: new Date().toISOString(),
          sections: activeSetup.sections.map((section, idx) => {
            const findings = detectSampleClaimsInSection(section);
            return {
              id: section.id,
              type: section.type,
              order: idx,
              enabled: section.enabled,
              optional: isOptionalVerticalSection(activeSetup.presetId, section.id),
              selectedForPublish: section.enabled,
              isPublished: false,
              containsSampleCopy: findings.length > 0,
              sampleFindings: findings,
              section,
            };
          }),
          sampleSectionIds: activeSetup.sampleSectionIds,
          selectedPublishSectionIds: activeSetup.defaultSelectedPublishSectionIds,
          publishedSectionIds: [],
          warnings: [],
        }
      : null;

    return {
      tenantId: "01JT066E2ETENANT0000000001",
      handle: "berkah-mandiri",
      tenantName: "PT Berkah Mandiri Nusantara",
      vertical: "sales",
      businessCategory: "LocalBusiness",
      isHealthCategory: false,
      activeThemeId: "sales",
      cacheVersion: 1,
      recommendedPresetId: activeSetup?.presetId ?? "professional_services",
      catalog: VERTICAL_STARTER_PRESET_CATALOG,
      setup: setupDto,
      checklist: checklistByPreset[activeSetup?.presetId ?? "professional_services"],
      checklistByPreset,
      contentSummary: {
        pages: createdPagesCount,
        publishedPages: 0,
        posts: 0,
        offerings: createdServicesCount + createdToursCount,
        serviceOfferings: createdServicesCount,
        publishedServiceOfferings: 0,
        tourOfferings: createdToursCount,
        publishedTourOfferings: 0,
        outlets: createdOutletsCount,
        publishedOutlets: 0,
        menus: activeSetup ? 1 : 0,
        media: 0,
        hasExistingHomepage: createdPagesCount > 0,
        homepageIsPublished: false,
        isPopulatedTenant: createdPagesCount > 0,
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

    if (url.pathname === "/dashboard/berkah-mandiri/onboarding/api" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(buildState()));
      return;
    }

    if (url.pathname === "/dashboard/berkah-mandiri/onboarding/api" && req.method === "POST") {
      const body = await readJson(req);
      if (body.action === "apply") {
        if (seenKeys.has(body.setupKey)) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ...seenKeys.get(body.setupKey),
              alreadyApplied: true,
              idempotentReplay: true,
              state: buildState(),
            }),
          );
          return;
        }
        const built = buildVerticalStarterComposition(body.presetId, {
          businessName: "PT Berkah Mandiri Nusantara",
          businessCategory: "LocalBusiness",
        });
        version += 1;
        createdPagesCount = Math.max(createdPagesCount, 1 + built.secondaryPages.length);
        if (built.starterServiceOffering) createdServicesCount = Math.max(createdServicesCount, 1);
        if (built.starterTravelOffering) createdToursCount = Math.max(createdToursCount, 1);
        if (built.starterOutletTemplate) createdOutletsCount = Math.max(createdOutletsCount, 1);
        activeSetup = {
          presetId: built.presetId,
          setupKey: body.setupKey,
          createdAt: new Date().toISOString(),
          sections: built.sections,
          sampleSectionIds: built.sampleSectionIds,
          defaultSelectedPublishSectionIds: built.defaultSelectedPublishSectionIds,
        };
        const resultMeta = {
          presetId: built.presetId,
          setupKey: body.setupKey,
          operationKey: body.setupKey,
          applyMode: "initialized_draft",
          alreadyApplied: false,
          idempotentReplay: false,
          createdHomepageDraft: true,
          createdPageSlugs: ["beranda", ...built.secondaryPages.map((p) => p.slug)],
          createdOfferingSlugs: built.starterServiceOffering
            ? [built.starterServiceOffering.slug]
            : built.starterTravelOffering
              ? [built.starterTravelOffering.slug]
              : [],
          createdOutletSlugs: built.starterOutletTemplate ? [built.starterOutletTemplate.slug] : [],
          createdHeaderMenuDraft: true,
          preservedExistingContent: false,
        };
        seenKeys.set(body.setupKey, resultMeta);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...resultMeta, state: buildState() }));
        return;
      }

      if (body.action === "preview") {
        previewedAt = new Date().toISOString();
        const built = buildVerticalStarterComposition(body.presetId || "professional_services", {
          businessName: "PT Berkah Mandiri Nusantara",
        });
        const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="robots" content="noindex, nofollow"/><title>Pratinjau ${built.presetId}</title><style>body{margin:0;font-family:system-ui,sans-serif;color:#182522;background:#fff}header{background:#176b51;color:#fff;padding:12px 18px;font-size:13px;font-weight:600}section{padding:20px 18px;border-bottom:1px solid #d9e2dd}</style></head><body data-preview="true"><header>PRATINJAU DRAF (${built.presetId}) — Belum tayang</header><main>${built.sections
          .map(
            (s) =>
              `<section><h2>${String(s.config.heading || s.type)}</h2><p>${String(s.config.subheading || "")}</p></section>`,
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
            presetId: built.presetId,
            sandbox: "",
            isPreview: true,
            renderedSectionIds: built.sections.map((s) => s.id),
            sampleSectionIds: built.sampleSectionIds,
            hasSampleContent: built.sampleSectionIds.length > 0,
            version,
          }),
        );
        return;
      }
    }

    let filePath = path.join(
      outDir,
      url.pathname === "/" ? "onboarding-m2/index.html" : url.pathname,
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

  return { server };
}

async function checkViewportNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert(
    metrics.overflowX <= 1,
    `${label}: horizontal overflow detected (${metrics.overflowX}px)`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildRealOnboardingFixture();
  const { server } = await createOnboardingTestServer(outDir);

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
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Desktop 1440px: Verify all 4 vertical preset cards + anti-fabrication notice + checklist
    await page.goto(`${baseUrl}/onboarding-m2`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="vertical-onboarding-root"]');
    assert(
      await page.locator('[data-testid="vertical-anti-fabrication-notice"]').isVisible(),
      "Anti-fabrication draft-only notice must be visible",
    );
    for (const id of ["company_profile", "professional_services", "travel_umrah", "multi_outlet"]) {
      assert(
        await page.locator(`[data-testid="vertical-preset-card-${id}"]`).isVisible(),
        `Preset card ${id} must be visible`,
      );
    }
    assert(
      await page.locator('[data-testid="checklist-item-services_pricing_tiers"]').isVisible(),
      "Services checklist item must appear for default selected professional_services",
    );
    await checkViewportNoOverflow(page, "1440px initial 4-vertical onboarding");

    const shot1 = path.join(screenshotDir, "01-onboarding-4-verticals-desktop-1440.png");
    await page.screenshot({ path: shot1, fullPage: true });

    // 2. Switch to Travel & Wisata -> verify DEC-042 SK PPIU compliance notice & travel checklist
    await page.click('[data-testid="select-vertical-travel_umrah"]');
    await page.waitForSelector('[data-testid="compliance-notice-travel_umrah"]');
    const travelNotice = await page
      .locator('[data-testid="compliance-notice-travel_umrah"]')
      .textContent();
    assert(
      travelNotice && travelNotice.includes("SK PPIU"),
      `Expected DEC-042 SK PPIU notice, got: ${travelNotice}`,
    );
    assert(
      await page.locator('[data-testid="checklist-item-travel_umrah_ppiu_gate"]').isVisible(),
      "Travel checklist must include SK PPIU gate item",
    );

    // Apply Travel & Wisata preset -> creates draft sections (all CONTOH, draft only)
    await page.click('[data-testid="apply-selected-vertical-btn"]');
    await page.waitForSelector('[data-testid="preset-success-alert"]');
    await page.waitForSelector('[data-testid="preset-sections-list"]');
    assert(
      await page.locator('[data-testid="sample-badge-trv-hero"]').isVisible(),
      "Travel hero section must display CONTOH draft badge",
    );
    await checkViewportNoOverflow(page, "1440px travel applied draft");

    const shot2 = path.join(screenshotDir, "02-onboarding-travel-applied-desktop-1440.png");
    await page.screenshot({ path: shot2, fullPage: true });

    // Open inert preview dialog & verify sandbox="" + Escape close
    await page.click('[data-testid="preview-selected-vertical-btn"]');
    await page.waitForSelector('[data-testid="preset-preview-iframe"]');
    const sandboxAttr = await page
      .locator('[data-testid="preset-preview-iframe"]')
      .getAttribute("sandbox");
    assert(sandboxAttr === "", `Preview iframe sandbox must be "", got ${sandboxAttr}`);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="preset-preview-dialog"]', { state: "detached" });

    // 3. Switch to Multi-Gerai Offline -> verify GBP checklist & interactive filter/checkbox
    await page.click('[data-testid="select-vertical-multi_outlet"]');
    await page.waitForSelector('[data-testid="checklist-item-outlets_directory_hours"]');
    await page.waitForSelector('[data-testid="checklist-item-google_business_profile"]');
    await page.click('[data-testid="checklist-filter-vertical"]');
    await page.click('[data-testid="checklist-checkbox-outlets_directory_hours"]');
    await page.click('[data-testid="checklist-filter-all"]');

    // 4. Mobile 360px checks + screenshots
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(150);
    await checkViewportNoOverflow(page, "360px onboarding multi-outlet");

    const shot3 = path.join(screenshotDir, "03-onboarding-4-verticals-mobile-360.png");
    await page.screenshot({ path: shot3, fullPage: true });

    assert(consoleErrors.length === 0, `Console errors: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Page errors: ${JSON.stringify(pageErrors)}`);

    console.log("TASK-066 E2E PASSED:", {
      screenshots: [shot1, shot2, shot3],
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TASK-066 E2E FAILED:", err);
  process.exit(1);
});
