/* global process, console, document, window, URL */
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

const screenshotDir =
  process.env.TASK070_SCREENSHOT_DIR || "/tmp/punyasitus-t070-screenshots";

const OFFICIAL_PROVIDER_HOSTS = new Set([
  "developers.cloudflare.com",
  "pandi.id",
  "www.namecheap.com",
  "kb.porkbun.com",
  "support.google.com",
  "learn.microsoft.com",
  "www.zoho.com",
]);

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

async function buildGuideFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t070-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(
    srcDir,
    "pages/dashboard/batik-nusantara/settings/domains",
  );
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const dashboardLayoutImport = path.join(
    webDir,
    "src/layouts/DashboardLayout.astro",
  );
  const managerImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/settings/domains/_DomainsManager.tsx",
  );
  const guideImport = path.join(
    webDir,
    "src/components/admin/domain-guide/index.ts",
  );

  // Page 1: Settings > Domains (owner) with link to guide
  fs.writeFileSync(
    path.join(pagesDir, "index.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainsManager } from ${JSON.stringify(managerImport)};

const fallbackItem = {
  id: 1,
  hostname: "batik-nusantara.situsku.click",
  kind: "subdomain",
  mode: null,
  sslMethod: null,
  cfCustomHostnameId: null,
  status: "active",
  hostStatus: "active",
  sslStatus: "active",
  ownershipStatus: "active",
  tlsStatus: "active",
  providerStatus: null,
  providerSslStatus: null,
  certificateAuthority: null,
  dnsTargetObserved: null,
  httpsProbePassed: true,
  isPrimary: true,
  isLocked: false,
  failureCode: null,
  lastCheckedAt: "2026-11-23T02:00:00.000Z",
  tokenIssuedAt: null,
  tokenExpiresAt: null,
  tokenAge: null,
  validationRecords: [],
  cloudflareNameserverHint: false,
  postActivationCleanup: null,
  instructions: null,
  remedies: [],
  version: 1,
};

const supportContact = {
  salesWhatsappHref: "https://wa.me/628111222333?text=Halo%20Admin%20PunyaSitus",
  salesWhatsappDisplay: "+62 811-1222-333",
  supportEmail: "support@punyasitus.com",
};
---
<DashboardLayout
  title="Domain Kustom — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Rina Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <DomainsManager
    client:load
    tenantId="01JT070E2E0000000000000001"
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="owner"
    canReadDomains={true}
    canManageDomains={true}
    cnameTarget="cname.situsku.click"
    saasZone="situsku.click"
    apiBaseUrl="/api/tenants/01JT070E2E0000000000000001/domains"
    billingHref="/dashboard/batik-nusantara/billing"
    guideHref="/dashboard/batik-nusantara/settings/domains/guide"
    supportContact={supportContact}
    initialItems={[fallbackItem]}
    initialCustomDomainLocked={false}
    maxCustomHostnames={2}
  />
</DashboardLayout>
`,
  );

  // Page 2: Guide (owner, 200)
  fs.writeFileSync(
    path.join(pagesDir, "guide.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainEmailGuide } from ${JSON.stringify(guideImport)};
---
<DashboardLayout
  title="Panduan Domain & Email Bisnis — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Rina Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <DomainEmailGuide
    client:load
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="owner"
    canReadDomains={true}
    cnameTarget="cname.situsku.click"
    domainsHref="/dashboard/batik-nusantara/settings/domains"
    billingHref="/dashboard/batik-nusantara/billing"
  />
</DashboardLayout>
`,
  );

  // Page 3: Guide (admin, 200)
  fs.writeFileSync(
    path.join(pagesDir, "guide-admin.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainEmailGuide } from ${JSON.stringify(guideImport)};
---
<DashboardLayout
  title="Panduan Domain & Email Bisnis — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Sari Admin"
  userRoleLabel="Admin"
>
  <DomainEmailGuide
    client:load
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="admin"
    canReadDomains={true}
    cnameTarget="cname.situsku.click"
    domainsHref="/dashboard/batik-nusantara/settings/domains"
    billingHref="/dashboard/batik-nusantara/billing"
  />
</DashboardLayout>
`,
  );

  // Page 4: Guide (editor, 403 denied)
  fs.writeFileSync(
    path.join(pagesDir, "guide-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { DomainEmailGuide } from ${JSON.stringify(guideImport)};
---
<DashboardLayout
  title="Panduan Domain & Email Bisnis — Batik Nusantara"
  surface="dashboard"
  workspaceName="Batik Nusantara"
  workspaceSubtitle="batik-nusantara.situsku.click"
  activeNavId="settings"
  basePath="/dashboard/batik-nusantara"
  offeringLabel="Produk"
  lifecycleStatus="active"
  publicSiteHref="https://batik-nusantara.situsku.click"
  userDisplayName="Budi Editor"
  userRoleLabel="Editor"
>
  <DomainEmailGuide
    client:load
    handle="batik-nusantara"
    tenantName="Batik Nusantara"
    tenantStatus="active"
    currentRole="editor"
    canReadDomains={false}
    cnameTarget="cname.situsku.click"
    domainsHref="/dashboard/batik-nusantara/settings/domains"
    billingHref="/dashboard/batik-nusantara/billing"
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

async function startFixtureServer(outDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    let filePath = path.join(outDir, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end("Not Found");
      return;
    }

    const isEditorDenied = pathname.endsWith("/guide-editor") || pathname.endsWith("/guide-editor/");
    const statusCode = isEditorDenied ? 403 : 200;

    res.writeHead(statusCode, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function assertNoHorizontalOverflow(page, label) {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    dims.scrollWidth <= dims.clientWidth + 1,
    `${label}: horizontal overflow detected (${dims.scrollWidth} > ${dims.clientWidth})`,
  );
}

async function main() {
  const fixture = await buildGuideFixtures();
  const server = await startFixtureServer(fixture.outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const consoleErrors = [];
  const pageErrors = [];
  const savedScreenshots = [];

  try {
    fs.mkdirSync(screenshotDir, { recursive: true });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let expecting403 = false;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (expecting403 && text.includes("status of 403")) return;
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Settings > Domains links cleanly to the Domain & Business Email Guide (1440x900)
    const domainsUrl = `${server.baseUrl}/dashboard/batik-nusantara/settings/domains`;
    const domainsRes = await page.goto(domainsUrl, { waitUntil: "networkidle" });
    assert(domainsRes && domainsRes.status() === 200, "Settings > Domains must load 200");
    await page.waitForSelector('[data-testid="open-domain-guide-link"]');
    await assertNoHorizontalOverflow(page, "domains-with-guide-link-1440");

    const guideLinkHref = await page
      .locator('[data-testid="open-domain-guide-link"]')
      .getAttribute("href");
    assert(
      guideLinkHref === "/dashboard/batik-nusantara/settings/domains/guide",
      `Settings > Domains guide link href mismatch: ${guideLinkHref}`,
    );

    const domainsShot = path.join(screenshotDir, "domains-with-guide-link-1440.png");
    await page.screenshot({ path: domainsShot, fullPage: true });
    savedScreenshots.push(domainsShot);

    // Click guide link from Settings > Domains -> navigates to guide
    await Promise.all([
      page.waitForURL("**/settings/domains/guide"),
      page.click('[data-testid="open-domain-guide-link"]'),
    ]);
    await page.waitForSelector('[data-testid="domain-email-guide"]');
    await assertNoHorizontalOverflow(page, "domain-guide-owner-1440");

    // 2. Verify all 3 DNS paths are rendered & visible
    for (const pathId of ["cloudflare_dns", "registrar_forwarding", "paid_mailbox"]) {
      const card = page.locator(`[data-testid="dns-path-${pathId}"]`);
      assert(await card.isVisible(), `DNS path card ${pathId} must be visible`);
    }

    // 3. Verify Cloudflare DNS requirement for Cloudflare Email Routing
    const cfReq = page.locator('[data-testid="cloudflare-dns-requirement"]');
    assert(await cfReq.isVisible(), "Cloudflare DNS requirement callout must be visible");
    const cfReqText = await cfReq.innerText();
    assert(
      cfReqText.includes("Cloudflare Email Routing") && cfReqText.includes("Cloudflare DNS"),
      "Cloudflare DNS requirement callout must explicitly state Cloudflare Email Routing requires Cloudflare DNS",
    );

    // 4. Verify informational boundary (no mailboxes provided, no credentials requested)
    const boundaryText = await page
      .locator('[data-testid="informational-boundary-notice"]')
      .innerText();
    assert(
      boundaryText.includes("tidak menyediakan kotak surat") &&
        boundaryText.includes("tidak pernah meminta kata sandi"),
      "Informational boundary notice must clearly state no mailboxes and no credentials",
    );

    // 5. Verify DNS coexistence safety reminder (MX / SPF / DKIM / DMARC)
    const coexistenceText = await page
      .locator('[data-testid="dns-coexistence-reminder"]')
      .innerText();
    for (const token of ["MX", "SPF", "DKIM", "DMARC", "CNAME"]) {
      assert(
        coexistenceText.includes(token),
        `DNS coexistence reminder must mention ${token}`,
      );
    }

    // 6. Verify ZERO credential/form inputs inside <main>
    const inputCount = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      return main.querySelectorAll("input, textarea, select, form, [type='password']").length;
    });
    assert(inputCount === 0, `Guide must contain ZERO form/credential inputs, found ${inputCount}`);

    // 7. Verify ALL external links inside the guide are official HTTPS provider pages with rel="noopener noreferrer"
    const externalLinks = await page.evaluate(() => {
      const guide = document.querySelector('[data-testid="domain-email-guide"]');
      if (!guide) return [];
      return Array.from(guide.querySelectorAll('a[href^="http"]')).map((a) => ({
        href: a.getAttribute("href") || "",
        rel: a.getAttribute("rel") || "",
        target: a.getAttribute("target") || "",
      }));
    });
    assert(
      externalLinks.length >= 8,
      `Expected at least 8 official provider links, found ${externalLinks.length}`,
    );
    for (const link of externalLinks) {
      const parsed = new URL(link.href);
      assert(parsed.protocol === "https:", `External link must use https: ${link.href}`);
      assert(
        OFFICIAL_PROVIDER_HOSTS.has(parsed.hostname.toLowerCase()),
        `Non-official external link found in guide: ${link.href}`,
      );
      assert(parsed.search === "", `Official link must not carry query/affiliate params: ${link.href}`);
      assert(
        link.rel.includes("noopener") && link.rel.includes("noreferrer"),
        `External link must have rel="noopener noreferrer": ${link.href} (got "${link.rel}")`,
      );
    }

    const ownerDesktopShot = path.join(screenshotDir, "domain-guide-owner-1440.png");
    await page.screenshot({ path: ownerDesktopShot, fullPage: true });
    savedScreenshots.push(ownerDesktopShot);

    // 8. Keyboard accessibility: arrow-key navigation + Enter/Space on DNS path branching filter
    const allFilterBtn = page.locator('[data-path-filter="all"]');
    await allFilterBtn.focus();
    const outlineStyle = await allFilterBtn.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert(
      outlineStyle.outlineStyle !== "none" ||
        (await allFilterBtn.getAttribute("class"))?.includes("focus-visible:outline-ring"),
      "Filter buttons must expose visible focus styling",
    );

    // ArrowRight moves to Jalur A (Cloudflare DNS) and filters to 1 card
    await page.keyboard.press("ArrowRight");
    assert(
      (await page.locator('[data-path-filter="cloudflare_dns"]').getAttribute("aria-pressed")) ===
        "true",
      "ArrowRight must activate cloudflare_dns path filter",
    );
    assert(
      (await page.locator('[data-testid="dns-path-cloudflare_dns"]').isVisible()) &&
        (await page.locator('[data-testid="dns-path-registrar_forwarding"]').count()) === 0 &&
        (await page.locator('[data-testid="dns-path-paid_mailbox"]').count()) === 0,
      "Filtering to cloudflare_dns must show only Jalur A",
    );

    // ArrowRight moves to Jalur B (Registrar Forwarding)
    await page.keyboard.press("ArrowRight");
    assert(
      (await page.locator('[data-path-filter="registrar_forwarding"]').getAttribute("aria-pressed")) ===
        "true",
      "Second ArrowRight must activate registrar_forwarding path filter",
    );
    assert(
      await page.locator('[data-testid="dns-path-registrar_forwarding"]').isVisible(),
      "Jalur B must be visible when selected via keyboard",
    );

    // Reset via button back to all 3 paths
    await page.locator('[data-testid="reset-path-filter-btn"]').focus();
    await page.keyboard.press("Enter");
    assert(
      (await page.locator('[data-testid="dns-path-cloudflare_dns"]').isVisible()) &&
        (await page.locator('[data-testid="dns-path-registrar_forwarding"]').isVisible()) &&
        (await page.locator('[data-testid="dns-path-paid_mailbox"]').isVisible()),
      "Reset button via Enter key must restore all 3 DNS paths",
    );

    // 9. Connect-domain link navigates cleanly back to Settings > Domains
    const connectHref = await page
      .locator('[data-testid="connect-domain-link"]')
      .getAttribute("href");
    assert(
      connectHref === "/dashboard/batik-nusantara/settings/domains",
      `Connect-domain link mismatch: ${connectHref}`,
    );
    await Promise.all([
      page.waitForURL("**/settings/domains"),
      page.click('[data-testid="connect-domain-link"]'),
    ]);
    await page.waitForSelector('[data-testid="connect-mode-picker"]');

    // 10. Mobile 360x800 layout check (zero horizontal overflow & >= 44px tap targets)
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/dashboard/batik-nusantara/settings/domains/guide`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="domain-email-guide"]');
    await assertNoHorizontalOverflow(page, "domain-guide-owner-360");

    for (const testId of ["back-to-domains-link", "connect-domain-link"]) {
      const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
      assert(box && box.height >= 44, `${testId} must meet >= 44px touch target on mobile`);
    }

    const ownerMobileShot = path.join(screenshotDir, "domain-guide-owner-360.png");
    await page.screenshot({ path: ownerMobileShot, fullPage: true });
    savedScreenshots.push(ownerMobileShot);

    // Also verify Settings > Domains with the new guide link has zero overflow at 360px
    await page.goto(domainsUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="open-domain-guide-link"]');
    await assertNoHorizontalOverflow(page, "domains-with-guide-link-360");

    // 11. Admin role can open the guide (200)
    await page.setViewportSize({ width: 1440, height: 900 });
    const adminRes = await page.goto(
      `${server.baseUrl}/dashboard/batik-nusantara/settings/domains/guide-admin`,
      { waitUntil: "networkidle" },
    );
    assert(adminRes && adminRes.status() === 200, "Admin must receive 200 on domain guide");
    await page.waitForSelector('[data-testid="domain-email-guide"]');
    assert(
      (await page.locator('[data-testid="dns-path-cloudflare_dns"]').isVisible()) &&
        (await page.locator('[data-testid="dns-path-registrar_forwarding"]').isVisible()) &&
        (await page.locator('[data-testid="dns-path-paid_mailbox"]').isVisible()),
      "Admin view must render all 3 DNS paths",
    );
    await assertNoHorizontalOverflow(page, "domain-guide-admin-1440");

    const adminShot = path.join(screenshotDir, "domain-guide-admin-1440.png");
    await page.screenshot({ path: adminShot, fullPage: true });
    savedScreenshots.push(adminShot);

    // 12. Editor role gets 403 permission denied (matching Settings > Domains)
    expecting403 = true;
    const editorRes = await page.goto(
      `${server.baseUrl}/dashboard/batik-nusantara/settings/domains/guide-editor`,
      { waitUntil: "networkidle" },
    );
    expecting403 = false;
    assert(editorRes && editorRes.status() === 403, "Editor must receive HTTP 403 on domain guide");
    await page.waitForSelector('[data-testid="domain-guide-permission-denied"]');
    assert(
      (await page.locator('[data-testid="domain-email-guide"]').count()) === 0,
      "Editor 403 view must NOT render guide content",
    );
    await assertNoHorizontalOverflow(page, "domain-guide-editor-403-1440");

    const editorShot = path.join(screenshotDir, "domain-guide-editor-403-1440.png");
    await page.screenshot({ path: editorShot, fullPage: true });
    savedScreenshots.push(editorShot);

    assert(
      consoleErrors.length === 0,
      `Unexpected browser console errors: ${consoleErrors.join(" | ")}`,
    );
    assert(
      pageErrors.length === 0,
      `Unexpected page errors: ${pageErrors.join(" | ")}`,
    );

    console.log("TASK-070 E2E PASSED:", {
      screenshots: savedScreenshots,
      officialExternalLinksChecked: externalLinks.length,
    });
  } finally {
    await browser.close();
    await server.close();
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
