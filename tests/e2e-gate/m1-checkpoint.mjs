#!/usr/bin/env node
/* global process, console, document, window, getComputedStyle, URL, URLSearchParams, HTMLElement, Buffer, setTimeout */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { inspectImageBinary } from "../../packages/core/src/media/index.ts";
import {
  assert,
  createSeededM1Topology,
  httpRequest,
  launchM1Chromium,
} from "./_m1-harness.mjs";

const VIEWPORTS = Object.freeze([
  { label: "360", width: 360, height: 800 },
  { label: "768", width: 768, height: 1024 },
  { label: "1440", width: 1440, height: 900 },
]);

function parseCliArgs(argv) {
  const args = {
    reportOut: null,
    screenshotDir: process.env.TASK063_SCREENSHOT_DIR || "/tmp/task-063-screenshots",
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--screenshot-dir" && argv[i + 1]) {
      args.screenshotDir = path.resolve(argv[++i]);
    } else if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node tests/e2e-gate/m1-checkpoint.mjs [--json] [--report-out <path>] [--screenshot-dir <dir>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

async function assertViewportIntegrity(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll(
        "header a[href], header button, header summary, main button, main a.ps-btn, main a.mk-btn, main input[type='submit'], main summary",
      ),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !el.classList.contains("ps-skip-link") &&
          !el.classList.contains("mk-skip-link")
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 32) || "",
          height: Math.round(rect.height),
        };
      });
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      controls,
    };
  });

  assert(
    !metrics.overflow,
    `[${label} @ ${width}px] Horizontal overflow (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize >= 14,
    `[${label} @ ${width}px] Root font size ${metrics.htmlFontSize}px < 14px`,
  );
  if (width <= 400) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
      );
    }
  }
}

export async function runM1CheckpointGate({ screenshotDir = "/tmp/task-063-screenshots" } = {}) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const topology = await createSeededM1Topology({ prefix: "m1-chk", withSecondTenant: true });
  let browser;
  const screenshots = [];
  const negativeCases = {};

  try {
    const { port, sqlitePath, tenantA, tenantB, seeded } = topology;
    const adminOrigin = `http://127.0.0.1:${port}`;
    const tenantABaseUrl = `http://${tenantA.host}:${port}`;
    const marketingBaseUrl = `http://127.0.0.1:${port}`;
    const adminHeaders = (cookie, origin = adminOrigin) => ({
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    });

    // =========================================================================
    // NEGATIVE CASE 1: Same-Tenant Success vs Strict Neutral 404 A -> B Denial
    // =========================================================================
    const sameTenantRead = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "GET",
      headers: { Cookie: tenantA.cookie },
    });
    assert(sameTenantRead.status === 200, `Tenant A read own pages expected 200, got ${sameTenantRead.status}`);

    const crossTenantRead = await httpRequest(port, `/api/tenants/${tenantB.handle}/pages`, {
      method: "GET",
      headers: { Cookie: tenantA.cookie },
    });
    assert(
      crossTenantRead.status === 404,
      `Tenant A -> Tenant B read MUST return strict neutral 404, got ${crossTenantRead.status}`,
    );
    assert(
      !crossTenantRead.body.includes("Beta Karya"),
      "Cross-tenant read denial leaked Tenant B data",
    );

    const crossTenantWrite = await httpRequest(port, `/api/tenants/${tenantB.handle}/pages`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({
        title: "Unauthorized Cross-Tenant Page",
        slug: "unauthorized-page",
        isHomepage: false,
        sections: [],
      }),
    });
    assert(
      crossTenantWrite.status === 404,
      `Tenant A -> Tenant B write MUST return strict neutral 404, got ${crossTenantWrite.status}`,
    );
    negativeCases.crossTenantIsolation = {
      ok: true,
      sameTenantReadStatus: sameTenantRead.status,
      crossTenantReadStatus: crossTenantRead.status,
      crossTenantWriteStatus: crossTenantWrite.status,
    };

    // =========================================================================
    // NEGATIVE CASE 2: Stale Revision 409 Conflict & CSRF / Origin Mismatch 403
    // =========================================================================
    const pageDetailRes = await httpRequest(
      port,
      `/api/tenants/${tenantA.handle}/pages/${seeded.homePageId}`,
      { method: "GET", headers: { Cookie: tenantA.cookie } },
    );
    assert(pageDetailRes.status === 200, `Fetch homepage detail failed: ${pageDetailRes.status}`);
    const pageDetailJson = JSON.parse(pageDetailRes.body);
    const currentVersion =
      pageDetailJson.page?.version ?? pageDetailJson.data?.version ?? pageDetailJson.version;
    assert(typeof currentVersion === "number", `Missing numeric version on homepage: ${pageDetailRes.body}`);

    const freshPatch = await httpRequest(
      port,
      `/api/tenants/${tenantA.handle}/pages/${seeded.homePageId}`,
      {
        method: "PATCH",
        headers: adminHeaders(tenantA.cookie),
        body: JSON.stringify({
          title: "Beranda PT Alpha Solusi Nusantara (Revisi)",
          expectedVersion: currentVersion,
        }),
      },
    );
    assert(freshPatch.status === 200, `Valid version PATCH failed: ${freshPatch.status} ${freshPatch.body}`);

    const stalePatch = await httpRequest(
      port,
      `/api/tenants/${tenantA.handle}/pages/${seeded.homePageId}`,
      {
        method: "PATCH",
        headers: adminHeaders(tenantA.cookie),
        body: JSON.stringify({
          title: "Stale Overwrite Attempt",
          expectedVersion: currentVersion, // stale!
        }),
      },
    );
    assert(stalePatch.status === 409, `Expected 409 Conflict on stale revision, got ${stalePatch.status}`);

    const csrfEvilOrigin = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie, "https://evil.example"),
      body: JSON.stringify({ title: "CSRF Evil", slug: "csrf-evil", sections: [] }),
    });
    assert(csrfEvilOrigin.status === 403, `Expected 403 on evil Origin, got ${csrfEvilOrigin.status}`);

    const csrfTenantOrigin = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie, `https://${tenantA.host}`),
      body: JSON.stringify({ title: "CSRF Tenant Origin", slug: "csrf-tenant", sections: [] }),
    });
    assert(
      csrfTenantOrigin.status === 403,
      `Expected 403 on tenant subdomain Origin to admin API, got ${csrfTenantOrigin.status}`,
    );
    negativeCases.staleRevisionAndCsrf = {
      ok: true,
      staleRevisionStatus: stalePatch.status,
      csrfEvilOriginStatus: csrfEvilOrigin.status,
      csrfTenantOriginStatus: csrfTenantOrigin.status,
    };

    // =========================================================================
    // NEGATIVE CASE 3: Unsafe URL (javascript:, private IP) & MIME Spoofing Rejection
    // =========================================================================
    const jsUrlRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({
        offeringType: "service",
        title: "Uji URL Berbahaya",
        slug: "uji-url-javascript",
        priceMode: "on_request",
        ctaMode: "external_link",
        externalUrl: "javascript:alert(1)",
      }),
    });
    assert(jsUrlRes.status === 422, `Expected 422 for javascript: externalUrl, got ${jsUrlRes.status}`);

    const privateIpRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({
        offeringType: "service",
        title: "Uji Private IP SSRF",
        slug: "uji-private-ip",
        priceMode: "on_request",
        ctaMode: "external_link",
        externalUrl: "http://169.254.169.254/latest/meta-data",
      }),
    });
    assert(
      privateIpRes.status === 422,
      `Expected 422 for private IP externalUrl, got ${privateIpRes.status}`,
    );

    // MIME & upload safety:
    // 1. Disallowed SVG MIME type rejected with 415 on upload-intent over real HTTP
    const spoofedBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      "utf8",
    );
    const spoofedSha256 = crypto.createHash("sha256").update(spoofedBytes).digest("hex");
    const svgIntentRes = await httpRequest(
      port,
      `/api/tenants/${tenantA.handle}/media/upload-intent`,
      {
        method: "POST",
        headers: adminHeaders(tenantA.cookie),
        body: JSON.stringify({
          kind: "image",
          filename: "malicious.svg",
          mimeType: "image/svg+xml",
          declaredBytes: spoofedBytes.byteLength,
          sha256: spoofedSha256,
          alt: "SVG uji keamanan",
        }),
      },
    );
    assert(
      svgIntentRes.status === 415,
      `Expected 415 rejecting SVG MIME on upload-intent, got ${svgIntentRes.status}`,
    );

    // 2. Unit-level magic-byte MIME spoofing detection (`image/png` header carrying SVG bytes -> 415)
    const magicInspect = inspectImageBinary(new Uint8Array(spoofedBytes), "image/png");
    assert(
      !magicInspect.ok && magicInspect.status === 415 && magicInspect.code === "UNSUPPORTED_FORMAT_SVG",
      `Expected inspectImageBinary to reject spoofed SVG-as-PNG with 415 UNSUPPORTED_FORMAT_SVG, got ${JSON.stringify(magicInspect)}`,
    );

    // 3. Probe live binary PUT through Worker and assert exact M1-FU-07 middleware response
    //    (live binary media upload through the Worker is NOT verified in M1 until M1-FU-07 is resolved)
    const pngIntentRes = await httpRequest(
      port,
      `/api/tenants/${tenantA.handle}/media/upload-intent`,
      {
        method: "POST",
        headers: adminHeaders(tenantA.cookie),
        body: JSON.stringify({
          kind: "image",
          filename: "spoofed-logo.png",
          mimeType: "image/png",
          declaredBytes: spoofedBytes.byteLength,
          sha256: spoofedSha256,
          alt: "Logo uji keamanan",
        }),
      },
    );
    assert(
      pngIntentRes.status === 201 || pngIntentRes.status === 200,
      `Expected upload-intent creation (200/201), got ${pngIntentRes.status}: ${pngIntentRes.body.slice(0, 300)}`,
    );
    const intentJson = JSON.parse(pngIntentRes.body);
    const uploadPath =
      intentJson.uploadPath ??
      intentJson.data?.uploadPath ??
      `/api/tenants/${tenantA.handle}/media/upload/${intentJson.intentId ?? intentJson.data?.intentId ?? intentJson.id}`;

    const spoofUploadRes = await httpRequest(port, uploadPath, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        Origin: adminOrigin,
        Cookie: tenantA.cookie,
      },
      body: spoofedBytes,
    });
    let livePutBody = null;
    try {
      livePutBody = JSON.parse(spoofUploadRes.body);
    } catch {
      // non-JSON body
    }
    const isExactM1Fu07Block =
      spoofUploadRes.status === 403 &&
      livePutBody?.code === "FORBIDDEN" &&
      typeof livePutBody?.message === "string" &&
      livePutBody.message.includes("Content-Type: application/json");
    const isDirectHandlerRejection =
      spoofUploadRes.status === 415 || spoofUploadRes.status === 422;
    assert(
      isExactM1Fu07Block || isDirectHandlerRejection,
      `Expected exact M1-FU-07 middleware 403 (Content-Type: application/json) or direct 415/422 handler rejection, got status=${spoofUploadRes.status} body=${spoofUploadRes.body.slice(0, 300)}`,
    );
    negativeCases.unsafeUrlAndMimeSpoofing = {
      ok: true,
      javascriptUrlStatus: jsUrlRes.status,
      privateIpUrlStatus: privateIpRes.status,
      svgIntentStatus: svgIntentRes.status,
      magicByteSpoofCode: magicInspect.ok ? null : magicInspect.code,
      magicByteSpoofStatus: magicInspect.ok ? null : magicInspect.status,
      liveBinaryUploadThroughWorkerVerified: isDirectHandlerRejection,
      livePutStatus: spoofUploadRes.status,
      livePutCode: livePutBody?.code ?? null,
      middlewareFollowUpRecorded: isExactM1Fu07Block
        ? "M1-FU-07: live binary upload NOT verified in M1 — apps/web/src/middleware/auth.ts:361-377 blocks non-JSON PUT before media/upload/[intentId].ts"
        : null,
    };

    // =========================================================================
    // BROWSER CHECKS: Multi-Viewport (360/768/1440), XSS, A11y, True 200% Zoom, Consent, No-JS
    // =========================================================================
    browser = await launchM1Chromium();
    const consoleErrors = [];
    const pageErrors = [];

    // A. Multi-viewport screenshots + XSS neutralization + Consent withdrawal + Keyboard/Focus
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const thirdPartyRequests = [];
    const failedResources = [];

    page.on("response", (res) => {
      if (res.status() >= 400) {
        const resUrl = res.url();
        let pathname;
        try {
          pathname = new URL(resUrl).pathname;
        } catch {
          pathname = "";
        }
        if (res.status() === 404 && pathname === "/favicon.ico") {
          return;
        }
        failedResources.push(`${res.status()} ${resUrl}`);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        const locUrl = msg.location()?.url || "";
        let locPath = "";
        if (locUrl) {
          try {
            locPath = new URL(locUrl).pathname;
          } catch {
            locPath = "";
          }
        }
        // Explicitly allowlist ONLY browser-initiated /favicon.ico 404 console errors (exact URL match)
        if (
          text.startsWith("Failed to load resource: the server responded with a status of 404") &&
          locPath === "/favicon.ico"
        ) {
          return;
        }
        consoleErrors.push(locUrl ? `${text} (${locUrl})` : text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("request", (req) => {
      const reqUrl = req.url();
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return;
      try {
        const host = new URL(reqUrl).hostname.toLowerCase();
        if (
          host !== tenantA.host &&
          host !== "punyasitus.com" &&
          host !== "127.0.0.1" &&
          host !== "localhost"
        ) {
          thirdPartyRequests.push(reqUrl);
        }
      } catch {
        // ignore
      }
    });

    const pagesToScreenshot = [
      { slug: "tenant-home", url: `${tenantABaseUrl}/` },
      { slug: "tenant-article", url: `${tenantABaseUrl}${seeded.articlePath}` },
      { slug: "tenant-offering", url: `${tenantABaseUrl}${seeded.offeringPath}` },
      { slug: "marketing-home", url: `${marketingBaseUrl}/marketing` },
    ];

    for (const target of pagesToScreenshot) {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const resp = await page.goto(target.url, { waitUntil: "load", timeout: 30_000 });
        assert(resp && resp.status() === 200, `Expected 200 on ${target.url}, got ${resp?.status()}`);
        await assertViewportIntegrity(page, target.slug, vp.width);

        const shotName = `${target.slug}-${vp.label}.png`;
        const shotPath = path.join(screenshotDir, shotName);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: shotPath, fullPage: true });
        screenshots.push(shotPath);
      }
    }

    // B. Malicious Rich Text / XSS Neutralization Proof in Real Chromium on Article Detail
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${tenantABaseUrl}${seeded.articlePath}`, { waitUntil: "load" });
    const xssCheck = await page.evaluate(() => {
      const bodyEl = document.querySelector('[data-testid="blog-detail-body"]');
      const html = bodyEl ? bodyEl.innerHTML : "";
      return {
        executed: window.__m1XssExecuted ?? null,
        hasScriptTag: /<script\b/i.test(html),
        hasInlineHandler: /\bon(?:error|click|load)\s*=/i.test(html),
        hasJavascriptHref: /javascript:/i.test(html),
        hasSafeText: html.includes("Pemetaan Beban Listrik Harian"),
      };
    });
    assert(xssCheck.executed === null, `XSS executed in Chromium: ${String(xssCheck.executed)}`);
    assert(!xssCheck.hasScriptTag, "Raw <script> tag leaked into rendered article HTML");
    assert(!xssCheck.hasInlineHandler, "Raw inline event handler leaked into rendered article HTML");
    assert(!xssCheck.hasJavascriptHref, "Raw javascript: URL leaked into rendered article HTML");
    assert(xssCheck.hasSafeText, "Expected legitimate article content to render cleanly");
    negativeCases.xssSanitization = { ok: true, ...xssCheck };

    // C. True 200% Browser Zoom Reflow (`720x450` @ DPR 2 = 1440px @ 200% zoom),
    //    WCAG 1.4.10 `320px` reflow, AND `200%` root text-scaling overflow check
    const zoomCtx = await browser.newContext({
      viewport: { width: 720, height: 450 },
      deviceScaleFactor: 2,
    });
    let zoom720Dpr2Overflow = true;
    let wcag320ReflowOverflow = true;
    try {
      const zoomPage = await zoomCtx.newPage();
      await zoomPage.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
      zoom720Dpr2Overflow = await zoomPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(
        !zoom720Dpr2Overflow,
        "200% browser zoom reflow (720px @ deviceScaleFactor=2) produced horizontal overflow",
      );

      await zoomPage.setViewportSize({ width: 320, height: 640 });
      wcag320ReflowOverflow = await zoomPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(
        !wcag320ReflowOverflow,
        "WCAG 1.4.10 320px reflow check produced horizontal overflow",
      );
    } finally {
      await zoomCtx.close();
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const textZoom200Overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(
      !textZoom200Overflow,
      "200% root text-scaling at 1440px produced horizontal overflow",
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    negativeCases.zoomReflow = {
      ok: true,
      zoom720Dpr2Overflow,
      wcag320ReflowOverflow,
      textZoom200Overflow,
    };

    // D. Multi-Control Keyboard Navigation, Exact-Trigger Focus Restoration, aria-live & Consent Withdrawal
    await page.goto(`${tenantABaseUrl}/`, { waitUntil: "load" });
    assert(
      thirdPartyRequests.length === 0,
      `Third-party requests fired before consent: ${thirdPartyRequests.join(", ")}`,
    );
    const bannerVisible = await page.locator('[data-testid="consent-banner"]').isVisible();
    assert(bannerVisible, "Expected consent banner to be visible on first visit before consent");

    // Tab across multiple focusable controls and confirm distinct interactive progression
    const keyboardFocusTrail = [];
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("Tab");
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement)) return null;
        return {
          tag: el.tagName,
          id: el.getAttribute("data-testid") || el.getAttribute("href") || el.textContent?.trim().slice(0, 24) || "",
        };
      });
      assert(
        active && ["A", "BUTTON", "INPUT", "SUMMARY", "TEXTAREA", "SELECT"].includes(active.tag),
        `Expected interactive element on Tab step ${step + 1}, got ${JSON.stringify(active)}`,
      );
      keyboardFocusTrail.push(`${active.tag}:${active.id}`);
    }
    const distinctFocusTargets = new Set(keyboardFocusTrail).size;
    assert(
      distinctFocusTargets >= 3,
      `Expected keyboard Tab to traverse >= 3 distinct interactive controls, got ${JSON.stringify(keyboardFocusTrail)}`,
    );

    // Focus exact trigger (`consent-customize`), save live DOM reference, open dialog via Enter,
    // close via Escape, and assert exact element identity restoration!
    await page.locator('[data-testid="consent-customize"]').focus();
    await page.evaluate(() => {
      window.__m1ConsentTriggerEl = document.activeElement;
    });
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="consent-preferences-dialog"]:not([hidden])');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    const focusRestoreCheck = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        exactTriggerRestored: el === window.__m1ConsentTriggerEl,
        activeTestId: el instanceof HTMLElement ? el.getAttribute("data-testid") : null,
      };
    });
    assert(
      focusRestoreCheck.exactTriggerRestored && focusRestoreCheck.activeTestId === "consent-customize",
      `Expected exact focus restoration to [data-testid="consent-customize"], got ${JSON.stringify(focusRestoreCheck)}`,
    );

    // Accept consent -> verify aria-live status updates -> withdraw consent -> reload with zero trackers
    await page.click('[data-testid="consent-accept-all"]');
    await page.waitForSelector('[data-testid="consent-manage-bar"]:not([hidden])');
    const summaryAfterAccept = (await page.textContent('[data-testid="consent-status-summary"]'))?.trim() ?? "";
    const ariaLiveAttr = await page.getAttribute('[data-testid="consent-status-summary"]', "aria-live");
    assert(ariaLiveAttr === "polite", `Expected aria-live="polite" on consent summary, got ${ariaLiveAttr}`);
    assert(
      summaryAfterAccept.includes("Izin aktif"),
      `Expected aria-live summary to announce active consent, got "${summaryAfterAccept}"`,
    );

    await page.click('[data-testid="consent-withdraw-quick"]');
    await page.waitForTimeout(100);
    const summaryAfterWithdraw = (await page.textContent('[data-testid="consent-status-summary"]'))?.trim() ?? "";
    assert(
      !summaryAfterWithdraw.includes("Izin aktif"),
      `Expected consent withdrawal to clear active consent announcement, got "${summaryAfterWithdraw}"`,
    );

    await page.reload({ waitUntil: "load" });
    assert(
      thirdPartyRequests.length === 0,
      `Third-party requests fired after consent withdrawal: ${thirdPartyRequests.join(", ")}`,
    );
    negativeCases.consentAndAccessibility = {
      ok: true,
      thirdPartyRequestsBeforeConsent: 0,
      thirdPartyRequestsAfterWithdraw: thirdPartyRequests.length,
      analyticsHeadMountFollowUp: "M1-FU-02",
      keyboardFocusTrail,
      distinctFocusTargets,
      exactTriggerRestored: focusRestoreCheck.exactTriggerRestored,
      focusRestoredTo: focusRestoreCheck.activeTestId,
      ariaLive: ariaLiveAttr,
    };

    assert(
      failedResources.length === 0,
      `Unexpected HTTP >=400 browser resources: ${failedResources.join(" | ")}`,
    );
    assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Uncaught page errors: ${pageErrors.join(" | ")}`);
    await ctx.close();

    // E. No-JS Public Browsing + API-Level No-JS `application/x-www-form-urlencoded` 303 PRG Fallback
    //    (Note: SectionContactForm mounting inside SectionRenderer.astro is tracked in M1-FU-02)
    const noJsCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();
    const noJsHome = await noJsPage.goto(`${tenantABaseUrl}/`, { waitUntil: "domcontentloaded" });
    assert(noJsHome && noJsHome.status() === 200, "No-JS homepage failed");
    const homeHeading = (await noJsPage.textContent("h1"))?.trim() ?? "";
    assert(
      homeHeading.includes("Fondasi Digital"),
      `Expected published hero heading in No-JS mode, got "${homeHeading}"`,
    );

    await noJsPage.click('a[href="/layanan/konsultasi-audit-digital"]');
    await noJsPage.waitForURL(/\/layanan\/konsultasi-audit-digital/);
    const offeringTitle = (await noJsPage.textContent("h1"))?.trim() ?? "";
    assert(
      offeringTitle.includes("Konsultasi Audit Digital"),
      `Expected offering detail heading in No-JS mode, got "${offeringTitle}"`,
    );

    const noJsBlog = await noJsPage.goto(`${tenantABaseUrl}${seeded.articlePath}`, {
      waitUntil: "domcontentloaded",
    });
    assert(noJsBlog && noJsBlog.status() === 200, "No-JS blog detail failed");
    const blogTitle = (await noJsPage.textContent("h1"))?.trim() ?? "";
    assert(
      blogTitle.includes("Audit Energi"),
      `Expected blog article heading in No-JS mode, got "${blogTitle}"`,
    );

    // API-level No-JS `application/x-www-form-urlencoded` POST /api/leads -> 303 PRG redirect -> durable lead
    const formBody = new URLSearchParams({
      name: "Budi Santoso",
      phone: "081234567890",
      email: "budi.nojs@example.com",
      message: "Mohon informasi jadwal konsultasi audit digital perusahaan.",
      privacyConsent: "on",
      sourcePath: "/",
      returnTo: "/",
    }).toString();
    const noJsFormPost = await httpRequest(port, "/api/leads", {
      method: "POST",
      headers: {
        Host: tenantA.host,
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "same-origin",
      },
      body: formBody,
    });
    assert(
      noJsFormPost.status === 303,
      `Expected 303 PRG redirect on API-level No-JS form POST /api/leads, got ${noJsFormPost.status}: ${noJsFormPost.body.slice(0, 300)}`,
    );
    const prgLocation = String(noJsFormPost.headers.location || "");
    assert(
      prgLocation.includes("leadStatus=accepted"),
      `Expected PRG Location to include leadStatus=accepted, got "${prgLocation}"`,
    );
    const afterPrg = await noJsPage.goto(`${tenantABaseUrl}${prgLocation}`, {
      waitUntil: "domcontentloaded",
    });
    assert(afterPrg && afterPrg.status() === 200, "Following No-JS PRG redirect failed");
    await noJsCtx.close();

    // Verify durable lead creation in Tenant A inbox
    const leadsRes = await httpRequest(port, `/api/tenants/${tenantA.handle}/leads`, {
      method: "GET",
      headers: { Cookie: tenantA.cookie },
    });
    assert(leadsRes.status === 200, `Expected 200 reading Tenant A leads, got ${leadsRes.status}`);
    assert(
      leadsRes.body.includes("Budi Santoso"),
      "Expected API-level No-JS submitted lead to be durably persisted in Tenant A inbox",
    );
    negativeCases.noJsBrowsingAndApiPrgFormFallback = {
      ok: true,
      mode: "api_urlencoded_prg_303",
      browserDomContactFormMounted: false,
      followUpId: "M1-FU-02",
      leadPersisted: true,
    };

    // =========================================================================
    // NEGATIVE CASE 4: Suspended Tenant Over Warm Cache -> Immediate 503 no-store noindex
    // =========================================================================
    const warmCheck = await httpRequest(port, "/", { headers: { Host: tenantA.host } });
    assert(
      warmCheck.status === 200 && warmCheck.body.includes("PT Alpha Solusi Nusantara"),
      `Expected warm 200 on Tenant A before suspension, got ${warmCheck.status}`,
    );

    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE tenants SET status = 'suspended', operator_hold = 1 WHERE id = ?").run(
        tenantA.tenantId,
      );
    } finally {
      db.close();
    }

    // Allow the Worker's <=5s active-host resolution cache TTL to expire so PLATFORM_DB authoritative check fires
    await new Promise((r) => setTimeout(r, 5_200));

    const suspendedRes = await httpRequest(port, "/", { headers: { Host: tenantA.host } });
    assert(
      suspendedRes.status === 503,
      `Expected 503 for suspended tenant over warm cache, got ${suspendedRes.status}`,
    );
    assert(
      suspendedRes.headers["cache-control"] === "no-store",
      `Expected Cache-Control: no-store on suspended 503, got ${suspendedRes.headers["cache-control"]}`,
    );
    assert(
      suspendedRes.headers["x-robots-tag"] === "noindex, nofollow",
      `Expected X-Robots-Tag: noindex, nofollow on suspended 503, got ${suspendedRes.headers["x-robots-tag"]}`,
    );
    assert(
      !suspendedRes.body.includes("PT Alpha Solusi Nusantara"),
      "Suspended tenant 503 response MUST NOT leak cached tenant content!",
    );
    negativeCases.warmCacheSuspension = {
      ok: true,
      suspendedStatus: suspendedRes.status,
      cacheControl: suspendedRes.headers["cache-control"],
      xRobotsTag: suspendedRes.headers["x-robots-tag"],
      zeroContentLeak: true,
    };

    return {
      ok: true,
      gate: "M1_E2E_CHECKPOINT_NEGATIVE_AND_VIEWPORTS",
      task: "TASK-063",
      notProductionRelease: true,
      verifiedAt: new Date().toISOString(),
      viewportsVerified: VIEWPORTS.map((v) => `${v.width}x${v.height}`),
      screenshotDir,
      screenshotsCount: screenshots.length,
      screenshots,
      negativeCases,
    };
  } finally {
    if (browser) await browser.close();
    await topology.cleanup();
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runM1CheckpointGate({ screenshotDir: args.screenshotDir });

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `PASS: M1 Multi-Viewport & Negative-Case Gate (${report.viewportsVerified.join(", ")}) — ${report.screenshotsCount} screenshots saved to ${report.screenshotDir}`,
    );
    console.log(
      JSON.stringify({
        ok: report.ok,
        screenshotsCount: report.screenshotsCount,
        negativeCases: report.negativeCases,
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("M1 CHECKPOINT E2E GATE FAILED:", err);
    process.exit(1);
  });
}
