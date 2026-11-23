/* global process, console, document, window, URL, Buffer */
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

const screenshotDir = process.env.TASK091_SCREENSHOT_DIR || "/tmp/punyasitus-t091-screenshots";

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

async function buildTask091Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t091-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const identityImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/settings/identity/_IdentitySettingsClient.tsx",
  );

  const ownerPermissions = `{
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
  }`;

  const lockedPermissions = `{
    role: "owner",
    roleLabel: "Pemilik Situs",
    tenantStatus: "locked",
    isLocked: true,
    canWriteContent: false,
    canPublishContent: false,
    canManageMedia: false,
    canUploadMedia: false,
    canManageMenus: false,
    canManageSettings: false,
  }`;

  const layoutProps = (title, lifecycleStatus = "active") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="Travel Rahmatan Nusantara"
    workspaceSubtitle="rahmatan-travel.situsku.click"
    activeNavId="settings"
    basePath="/dashboard/rahmatan-travel"
    offeringLabel="Paket Tur"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://rahmatan-travel.situsku.click"
    userDisplayName="Hendra Wijaya"
    userRoleLabel="Pemilik Situs"
  `;

  const baseInitialIdentity = `{
    siteTitle: "Travel Rahmatan Nusantara",
    tagline: "Biro Wisata & Umrah Amanah Berizin Resmi",
    timezone: "Asia/Jakarta",
    locale: "id-ID",
    logoMediaId: 101,
    faviconMediaId: null,
    ogImageMediaId: null,
    businessName: "Travel Rahmatan Nusantara",
    legalName: "PT Rahmatan Wisata Mandiri",
    businessCategory: "travel_umrah_agency",
    personRoleTitle: "",
    affiliatedOrgName: "",
    description: "Penyelenggara perjalanan wisata domestik, internasional, dan Umrah berizin resmi.",
    email: "halo@rahmatan-travel.id",
    privacyContact: "privasi@rahmatan-travel.id",
    phone: "62215550199",
    whatsappE164: "6281234567890",
    address: "Jl. KH. Mas Mansyur No. 88",
    city: "Jakarta Pusat",
    province: "DKI Jakarta",
    postalCode: "10220",
    mapsUrl: "https://maps.google.com/?q=-6.2019,106.8147",
    weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
    holidayHours: "Sabtu 09.00–13.00 WIB",
    closedDays: ["sunday"],
    serviceAreas: ["Jabodetabek", "Bandung"],
    socialLinks: [{ platform: "instagram", url: "https://instagram.com/rahmatantravel" }],
    credentials: {
      nib: "1234567890123",
      skKemenagPpiu: "U.123 Tahun 2024",
    },
    brandAssets: {
      faviconSource: "auto_derived_from_logo",
      ogImageSource: "auto_derived_from_logo",
      derivedFavicon32Bytes: 1420,
      derivedAppleTouch180Bytes: 5120,
      derivedOgBytes: 128000,
    },
    hasUnpublishedChanges: false,
    version: 1,
  }`;

  fs.writeFileSync(
    path.join(pagesDir, "identity-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { IdentitySettingsClient } from ${JSON.stringify(identityImport)};
---
<DashboardLayout ${layoutProps("Identitas & Profil Bisnis — Travel Rahmatan Nusantara")}>
  <IdentitySettingsClient
    client:load
    handle="rahmatan-travel"
    basePath="/dashboard/rahmatan-travel"
    permissions={${ownerPermissions}}
    initialIdentity={${baseInitialIdentity}}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "identity-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { IdentitySettingsClient } from ${JSON.stringify(identityImport)};
---
<DashboardLayout ${layoutProps("Identitas & Profil Bisnis (Terkunci)", "locked")}>
  <IdentitySettingsClient
    client:load
    handle="rahmatan-travel"
    basePath="/dashboard/rahmatan-travel"
    permissions={${lockedPermissions}}
    initialIdentity={${baseInitialIdentity}}
    defaultTab="profil"
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
  const state = {
    version: 1,
    lastPatchPayload: null,
    published: false,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();
    const json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/tenants/rahmatan-travel/identity" && method === "PATCH") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.lastPatchPayload = body;
      state.version += 1;
      return json(200, {
        siteSettings: body.siteSettings,
        businessProfile: {
          ...body.businessProfile,
          businessCategoryKey: body.businessProfile?.businessCategory ?? "local_business",
        },
        brandAssets: {
          effective: {
            faviconSource: body.siteSettings?.faviconMediaId ? "explicit_override" : "auto_derived_from_logo",
            ogImageSource: body.siteSettings?.ogImageMediaId ? "explicit_override" : "auto_derived_from_logo",
          },
          derivedFavicon32: { bytes: 1420 },
          derivedAppleTouch180: { bytes: 5120 },
          derivedOg1200x630: { bytes: 128000 },
        },
        version: state.version,
        hasUnpublishedChanges: true,
      });
    }

    if (url.pathname === "/api/tenants/rahmatan-travel/identity/publish" && method === "POST") {
      state.version += 1;
      state.published = true;
      return json(200, {
        version: state.version,
        hasUnpublishedChanges: false,
      });
    }

    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) relPath = path.join(relPath, "index.html");
    let fullPath = path.resolve(outDir, relPath);
    if (!fullPath.startsWith(path.resolve(outDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      const asIndex = path.join(fullPath, "index.html");
      if (fs.existsSync(asIndex)) fullPath = asIndex;
      else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": getContentType(fullPath), "Cache-Control": "no-store" });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function checkNoHorizontalOverflow(page, label) {
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    m.scrollWidth <= m.innerWidth,
    `${label} has horizontal overflow (${m.scrollWidth} > ${m.innerWidth})`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const fixtures = await buildTask091Fixtures();
  const server = await startFixtureServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const consoleErrors = [];
    const pageErrors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // =========================================================================
    // 1. Desktop 1440x900 — Identitas tab + auto-derived brand assets badges
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/identity-owner/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="identity-settings-screen"]');
    await checkNoHorizontalOverflow(page, "identitas @ 1440px");

    const favBadge = await page.locator('[data-testid="identity-favicon-source-badge"]').textContent();
    const ogBadge = await page.locator('[data-testid="identity-og-source-badge"]').textContent();
    assert(favBadge?.includes("Otomatis dari Logo"), `Expected auto-derived favicon badge, got "${favBadge}"`);
    assert(ogBadge?.includes("Otomatis dari Logo"), `Expected auto-derived OG badge, got "${ogBadge}"`);

    const identitas1440Path = path.join(screenshotDir, "identitas-1440.png");
    await page.screenshot({ path: identitas1440Path, fullPage: true });

    // =========================================================================
    // 2. Keyboard tab switch (ArrowRight: Identitas -> Profil) + closed category & credentials
    // =========================================================================
    await page.locator('[data-testid="tab-identitas"]').focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector('[data-testid="panel-profil"]:not([hidden])');
    await checkNoHorizontalOverflow(page, "profil @ 1440px");

    // Verify closed category select has ZERO ProfessionalService options
    const optionTexts = await page
      .locator('[data-testid="identity-business-category"] option')
      .allTextContents();
    assert(optionTexts.length >= 20, `Expected >= 20 closed categories, got ${optionTexts.length}`);
    assert(
      !optionTexts.some((t) => /ProfessionalService/i.test(t)),
      "Closed category dropdown MUST NEVER contain ProfessionalService",
    );

    // Verify live Schema.org subtype badge and Travel contextual credentials
    const travelSchema = await page.locator('[data-testid="identity-schema-preview"]').textContent();
    assert(travelSchema?.includes("TravelAgency"), `Expected TravelAgency preview, got "${travelSchema}"`);
    assert(
      await page.locator('[data-testid="identity-cred-skKemenagPpiu"]').isVisible(),
      "Travel category must surface SK Kemenag PPIU/PIHK field",
    );

    // Switch to sales_executive -> verify ProfilePage + Person & affiliated dealer fields appear
    await page.locator('[data-testid="identity-business-category"]').selectOption("sales_executive");
    const salesSchema = await page.locator('[data-testid="identity-schema-preview"]').textContent();
    assert(
      salesSchema?.includes("ProfilePage + Person"),
      `Expected ProfilePage + Person preview, got "${salesSchema}"`,
    );
    assert(
      await page.locator('[data-testid="identity-affiliated-org"]').isVisible(),
      "Sales executive category must surface affiliated dealer field",
    );

    // Switch back to travel_umrah_agency, edit credentials + privacy contact + add service area, save & publish
    await page.locator('[data-testid="identity-business-category"]').selectOption("travel_umrah_agency");
    await page.locator('[data-testid="identity-cred-skKemenagPpiu"]').fill("U.456 Tahun 2025");
    await page.locator('[data-testid="identity-privacy-contact"]').fill("dpo@rahmatan-travel.id");
    await page.locator('[data-testid="identity-service-area-input"]').fill("Surabaya");
    await page.locator('[data-testid="identity-add-service-area"]').click();

    await page.locator('[data-testid="identity-save-btn"]').click();
    await page.waitForSelector('[data-testid="identity-feedback"]');
    assert(
      server.state.lastPatchPayload?.businessProfile?.businessCategory === "travel_umrah_agency",
      "Expected closed travel_umrah_agency saved",
    );
    assert(
      server.state.lastPatchPayload?.businessProfile?.credentials?.skKemenagPpiu === "U.456 Tahun 2025",
      "Expected SK Kemenag credential saved",
    );
    assert(
      server.state.lastPatchPayload?.businessProfile?.privacyContact === "dpo@rahmatan-travel.id",
      "Expected privacyContact saved",
    );
    assert(
      !JSON.stringify(server.state.lastPatchPayload).includes("ProfessionalService"),
      "Saved payload MUST NEVER contain ProfessionalService",
    );

    await page.locator('[data-testid="identity-publish-btn"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="identity-version-badge"]')?.textContent?.includes("v3"),
    );

    const profil1440Path = path.join(screenshotDir, "profil-1440.png");
    await page.screenshot({ path: profil1440Path, fullPage: true });

    // =========================================================================
    // 3. Mobile 360x800 — Profil & Identitas tabs, zero overflow, >= 44px touch targets
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await checkNoHorizontalOverflow(page, "profil @ 360px");

    const saveBtnBox = await page.locator('[data-testid="identity-save-btn"]').boundingBox();
    assert(
      saveBtnBox && saveBtnBox.height >= 44,
      `Primary Save button at 360px must be >= 44px tall, got ${saveBtnBox?.height}`,
    );

    const profil360Path = path.join(screenshotDir, "profil-360.png");
    await page.screenshot({ path: profil360Path, fullPage: true });

    await page.locator('[data-testid="tab-identitas"]').click();
    await page.waitForSelector('[data-testid="panel-identitas"]:not([hidden])');
    await checkNoHorizontalOverflow(page, "identitas @ 360px");

    const identitas360Path = path.join(screenshotDir, "identitas-360.png");
    await page.screenshot({ path: identitas360Path, fullPage: true });

    // =========================================================================
    // 4. Locked tenant read-only state
    // =========================================================================
    await page.goto(`${server.baseUrl}/identity-locked/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="identity-settings-screen"]');
    assert(
      await page.locator('[data-testid="identity-save-btn"]').isDisabled(),
      "Locked tenant must have Save button disabled",
    );
    assert(
      await page.locator('[data-testid="identity-publish-btn"]').isDisabled(),
      "Locked tenant must have Publish button disabled",
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-091",
        screenshots: [identitas1440Path, profil1440Path, identitas360Path, profil360Path],
        viewportsTested: [360, 1440],
        consoleErrors: 0,
        pageErrors: 0,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

main().catch((err) => {
  console.error("TASK-091 E2E FAILED:", err);
  process.exit(1);
});
