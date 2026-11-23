/* global process, console, document, window, getComputedStyle, URL */
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

const screenshotDir = process.env.TASK109_SCREENSHOT_DIR || "/tmp/qa-task-109";
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

async function buildTask109Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t109-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const globalsCssImport = path.join(webDir, "src/styles/admin/globals.css");
  const webSrcDir = path.join(webDir, "src");
  const wizardImport = path.join(webDir, "src/pages/auth/onboarding/_OnboardingWizard.tsx");
  const stepImport = path.join(webDir, "src/pages/auth/onboarding/_OnboardingAiDraftStep.tsx");

  const e2eCssPath = path.join(srcDir, "e2e.css");
  fs.writeFileSync(
    e2eCssPath,
    `@import ${JSON.stringify(globalsCssImport)};
@source ${JSON.stringify(webSrcDir)};
@source ${JSON.stringify(srcDir)};
`,
    "utf8",
  );

  const harnessPath = path.join(srcDir, "OnboardingAiDraftHarness.tsx");
  fs.writeFileSync(
    harnessPath,
    `import * as React from "react";
import { CheckCircle2Icon, ArrowRightIcon, CalendarCheckIcon } from "lucide-react";
import { OnboardingWizard } from ${JSON.stringify(wizardImport)};
import { OnboardingAiDraftStep } from ${JSON.stringify(stepImport)};
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ConfiguredOnboardingHarness({
  aiProviderConfigured = true,
}: {
  aiProviderConfigured?: boolean;
}) {
  return (
    <OnboardingWizard
      saasZone="situsku.click"
      aiProviderConfigured={aiProviderConfigured}
      initialStatus={{
        user: {
          id: "usr_e2e_109",
          name: "Nadia Pratama",
          email: "nadia@contoh.id",
          emailVerified: true,
        },
        emailVerified: true,
        trialEligible: true,
        trialConsumedReason: "none",
        trialDurationSeconds: 604800,
        saasZone: "situsku.click",
        ownedSites: [],
        pendingRecoveries: [],
      }}
    />
  );
}

export function DirectAiStepHarness({
  mode,
}: {
  mode: "ready" | "fallback";
}) {
  return (
    <Card className="w-full max-w-2xl shadow-none" data-testid="onboarding-success">
      <CardHeader className="gap-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-primary">
            <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Website Siap Digunakan
            </span>
          </div>
          <Badge variant="success" data-testid="onboarding-result-badge">
            Uji Coba Gratis 7 Hari
          </Badge>
        </div>
        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            PT Karya Kemas Nusantara berhasil dibuat
          </h1>
        </CardTitle>
        <CardDescription>
          Subdomain situs Anda:{" "}
          <span className="font-mono font-semibold text-foreground">
            karya-kemas.situsku.click
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="success">
          <CalendarCheckIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Uji coba gratis 7 hari (168 jam) aktif</AlertTitle>
          <AlertDescription>
            Situs Anda aktif di <strong>karya-kemas.situsku.click</strong> selama 7 hari penuh.
          </AlertDescription>
        </Alert>

        <OnboardingAiDraftStep
          tenantId="01JT109TENANTA000000000001"
          businessName="PT Karya Kemas Nusantara"
          vertical="compro"
          initialShortDescription="Manufaktur kemasan karton custom untuk klien industri dan logistik."
          initialQuota={
            mode === "fallback"
              ? { used: 100, limit: 100, remaining: 0, windowDays: 30, nextResetAt: "2026-12-24T00:00:00.000Z" }
              : { used: 0, limit: 100, remaining: 100, windowDays: 30, nextResetAt: null }
          }
          initialState={mode === "fallback" ? "fallback" : "ready"}
          initialFallbackReason={mode === "fallback" ? "AI_QUOTA_EXCEEDED" : null}
          initialFallbackMessage={
            mode === "fallback"
              ? "Kuota bantuan tulis AI (100/100 saran dalam 30 hari terakhir) telah habis untuk situs ini. Lanjutkan dengan blueprint standar Anda tanpa hambatan."
              : null
          }
        />

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <Button
            render={<a href="#dashboard" />}
            nativeButton={false}
            className="min-h-11 flex-1 gap-2 text-sm font-semibold"
            data-testid="onboarding-open-dashboard"
          >
            <span>Buka Dashboard Website</span>
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
`,
    "utf8",
  );

  const pageShell = (title, bodyAstro) => `---
import "../e2e.css";
import { ConfiguredOnboardingHarness, DirectAiStepHarness } from "../OnboardingAiDraftHarness";
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body class="min-h-screen bg-background text-foreground">
    <header class="border-b border-border bg-card">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
        <span class="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
          <span class="inline-flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">PS</span>
          <span>PunyaSitus</span>
        </span>
        <span class="text-xs text-muted-foreground">Nadia Pratama</span>
      </div>
    </header>
    <main id="main-content" class="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-5xl items-start justify-center px-4 py-8 md:py-10">
      ${bodyAstro}
    </main>
  </body>
</html>
`;

  fs.writeFileSync(
    path.join(pagesDir, "configured.astro"),
    pageShell("Onboarding AI Draft — Configured", "<ConfiguredOnboardingHarness client:load aiProviderConfigured={true} />"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pagesDir, "unconfigured.astro"),
    pageShell("Onboarding AI Draft — Unconfigured", "<ConfiguredOnboardingHarness client:load aiProviderConfigured={false} />"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pagesDir, "ai-step.astro"),
    pageShell("Onboarding AI Draft Step", '<DirectAiStepHarness client:load mode="ready" />'),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pagesDir, "fallback.astro"),
    pageShell("Onboarding AI Draft Fallback", '<DirectAiStepHarness client:load mode="fallback" />'),
    "utf8",
  );

  const [{ build }, reactModule, tailwindModule] = await Promise.all([
    import(astroEntryUrl),
    import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href),
    import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href),
  ]);

  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    integrations: [reactModule.default()],
    vite: {
      plugins: [tailwindModule.default()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
  });

  return { tmpRoot, outDir };
}

function startStaticServer(outDir) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
  };

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    let pathname = decodeURIComponent(reqUrl.pathname);
    if (pathname === "/") pathname = "/ai-step/index.html";
    let filePath = path.join(outDir, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function assertLayoutAndTouchTargets(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll('main button, main a[href], main select, main textarea, main input:not([type="radio"])'),
    )
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 28) || "",
          height: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      })
      .filter((c) => c.visible);
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
    `[${label} @ ${width}px] Horizontal overflow detected (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  );
  assert(metrics.htmlFontSize === 16, `[${label} @ ${width}px] Root font-size expected 16px, got ${metrics.htmlFontSize}`);
  if (width === 360) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `[${label} @ 360px] Control ${ctrl.tag}#${ctrl.id} height ${ctrl.height}px < 44px touch target`,
      );
    }
  }
}

async function main() {
  const { tmpRoot, outDir } = await buildTask109Fixtures();
  const { server, port } = await startStaticServer(outDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;

  try {
    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    let mockMode = "generate";
    await page.route("**/api/onboarding/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/check-handle")) {
        const h = url.searchParams.get("handle") || "karya-kemas";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            normalizedHandle: h,
            primaryHost: `${h}.situsku.click`,
            code: "AVAILABLE",
            message: `Tersedia: https://${h}.situsku.click`,
          }),
        });
        return;
      }

      if (url.pathname.endsWith("/provision")) {
        const payload = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            grantedTrial: true,
            awaitingFirstPayment: false,
            nextPath: `/dashboard/${payload.handle || "karya-kemas"}`,
            tenant: {
              id: "01JT109TENANTA000000000001",
              handle: payload.handle || "karya-kemas",
              name: payload.name || "PT Karya Kemas Nusantara",
              vertical: payload.vertical || "compro",
              primaryHost: `${payload.handle || "karya-kemas"}.situsku.click`,
              trialEndsAt: Date.now() + 604800000,
            },
          }),
        });
        return;
      }

      if (url.pathname.endsWith("/status")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            user: {
              id: "usr_e2e_109",
              name: "Nadia Pratama",
              email: "nadia@contoh.id",
              emailVerified: true,
            },
            emailVerified: true,
            trialEligible: true,
            trialConsumedReason: "none",
            trialDurationSeconds: 604800,
            saasZone: "situsku.click",
            ownedSites: [],
            pendingRecoveries: [],
          }),
        });
        return;
      }

      if (url.pathname.endsWith("/ai-draft")) {
        const payload = JSON.parse(route.request().postData() || "{}");
        if (payload.action === "skip") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              status: "skipped",
              skipped: true,
              fallback: false,
              fallbackReason: null,
              message: "Langkah draf AI dilewati. Blueprint standar Anda siap digunakan tanpa perubahan.",
              applied: false,
              published: false,
              autoPublished: false,
              draftMarker: "CONTOH",
              factCheckReminder: "Fakta usaha tidak pernah dikarang AI.",
              strippedFactKeys: [],
              quota: { used: 0, limit: 100, remaining: 100, windowDays: 30, nextResetAt: null },
              blueprint: {
                blueprintId: payload.blueprintId || "b2b_corporate",
                blueprintName: "Perusahaan B2B, Manufaktur & Kontraktor",
                vertical: "compro",
                recommendedThemeId: "compro",
                primaryMenuLabel: "Layanan",
                source: "plain_blueprint",
                status: "draft",
                published: false,
                autoPublished: false,
                draftMarker: "CONTOH",
                facts: { price: "", licenceNumber: "", reviews: [], phone: "", whatsapp: "", address: "" },
                sections: [],
                sampleSectionIds: [],
              },
              draft: null,
              persistedAsDraft: false,
              requestId: "req_e2e_skip",
            }),
          });
          return;
        }

        if (mockMode === "fallback") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              status: "fallback",
              skipped: false,
              fallback: true,
              fallbackReason: "AI_QUOTA_EXCEEDED",
              message:
                "Kuota bantuan tulis AI (100/100 saran dalam 30 hari terakhir) telah habis untuk situs ini. Lanjutkan dengan blueprint standar Anda tanpa hambatan.",
              applied: false,
              published: false,
              autoPublished: false,
              draftMarker: "CONTOH",
              factCheckReminder: "Fakta usaha tidak pernah dikarang AI.",
              strippedFactKeys: [],
              quota: { used: 100, limit: 100, remaining: 0, windowDays: 30, nextResetAt: "2026-12-24T00:00:00.000Z" },
              blueprint: {
                blueprintId: payload.blueprintId || "b2b_corporate",
                blueprintName: "Perusahaan B2B, Manufaktur & Kontraktor",
                vertical: "compro",
                recommendedThemeId: "compro",
                primaryMenuLabel: "Layanan",
                source: "plain_blueprint",
                status: "draft",
                published: false,
                autoPublished: false,
                draftMarker: "CONTOH",
                facts: { price: "", licenceNumber: "", reviews: [], phone: "", whatsapp: "", address: "" },
                sections: [],
                sampleSectionIds: [],
              },
              draft: null,
              persistedAsDraft: false,
              requestId: "req_e2e_fallback",
            }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            status: "generated",
            skipped: false,
            fallback: false,
            fallbackReason: null,
            message: "Draf teks CONTOH berhasil disiapkan.",
            applied: true,
            published: false,
            autoPublished: false,
            draftMarker: "CONTOH",
            factCheckReminder: "Fakta usaha tidak pernah dikarang AI.",
            strippedFactKeys: ["price", "licenceNumber", "reviews", "phone", "address"],
            quota: { used: 1, limit: 100, remaining: 99, windowDays: 30, nextResetAt: "2026-12-24T00:00:00.000Z" },
            blueprint: {
              blueprintId: payload.blueprintId || "b2b_corporate",
              blueprintName: "Perusahaan B2B, Manufaktur & Kontraktor",
              vertical: "compro",
              recommendedThemeId: "compro",
              primaryMenuLabel: "Layanan",
              source: "ai_draft",
              status: "draft",
              published: false,
              autoPublished: false,
              draftMarker: "CONTOH",
              facts: { price: "", licenceNumber: "", reviews: [], phone: "", whatsapp: "", address: "" },
              sections: [],
              sampleSectionIds: ["onb-b2b-corporate-hero", "onb-b2b-corporate-about"],
            },
            draft: {
              heroEyebrow: "CONTOH — Solusi Kemasan Industri B2B",
              heroHeadline: "CONTOH — PT Karya Kemas Nusantara untuk Kebutuhan Kemasan Bisnis",
              heroSubheadline:
                "CONTOH — Mendukung produksi karton box custom dan pengadaan kemasan rutin dengan kendali mutu konsisten bagi perusahaan di Indonesia.",
              heroCtaLabel: "CONTOH — Konsultasi Layanan",
              aboutHeading: "CONTOH — Profil PT Karya Kemas Nusantara",
              aboutSummary:
                "CONTOH — Mitra manufaktur kemasan yang berfokus pada ketepatan spesifikasi teknis, kesiapan jadwal pengiriman, dan komunikasi pengadaan yang jelas.",
              serviceSummaries: [
                {
                  title: "CONTOH — Kemasan Karton Custom",
                  description: "CONTOH — Desain dimensi dan ketebalan sesuai kebutuhan produk industri Anda.",
                },
                {
                  title: "CONTOH — Pasokan Kontrak B2B",
                  description: "CONTOH — Penjadwalan produksi berkala untuk menjaga kelancaran operasional gudang.",
                },
                {
                  title: "CONTOH — Pengujian Mutu Kemasan",
                  description: "CONTOH — Pemeriksaan standar kekuatan kemasan sebelum pengiriman ke lokasi klien.",
                },
              ],
            },
            persistedAsDraft: true,
            requestId: "req_e2e_gen",
          }),
        });
        return;
      }

      await route.continue();
    });

    // 1. Verify UNCONFIGURED provider hides AI draft step seamlessly after signup/provision
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/unconfigured`, { waitUntil: "networkidle" });
    await page.locator("#onboarding-name").fill("Studio Tanpa AI");
    await page.locator("#onboarding-handle").fill("studio-tanpa-ai");
    await page.locator('[data-testid="handle-available-preview"]').waitFor({ state: "visible", timeout: 5000 });
    await page.locator('[data-testid="onboarding-submit"]').click();
    await page.locator('[data-testid="onboarding-success"]').waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await page.locator('[data-testid="onboarding-ai-draft-step"]').count()) === 0,
      "AI draft step must NOT render when AI provider is unconfigured",
    );

    // 2. Verify CONFIGURED provider renders optional AI Draft step with skip option at 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto(`${baseUrl}/ai-step`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="onboarding-ai-draft-step"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="onboarding-ai-draft-skip"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="onboarding-ai-draft-generate"]').waitFor({ state: "visible" });
      await assertLayoutAndTouchTargets(page, "ai-draft-ready", vp.width);
      await page.screenshot({
        path: path.join(screenshotDir, `ai-draft-ready-${vp.width}.png`),
        fullPage: true,
      });
    }

    // 3. Test SKIP flow leaves blueprint unchanged & quota 100/100, then re-open and GENERATE CONTOH preview
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/ai-step`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="onboarding-ai-draft-skip"]').click();
    await page.locator('[data-testid="onboarding-ai-draft-skipped"]').waitFor({ state: "visible" });
    assert(
      (await page.locator('[data-testid="onboarding-ai-quota-badge"]').innerText()).includes("100/100"),
      "Skipping AI draft must not consume DEC-028 quota",
    );

    // Re-open and generate CONTOH preview -> capture 1440px & 360px screenshots
    await page.locator('[data-testid="onboarding-ai-draft-reopen"]').click();
    await page.locator('[data-testid="onboarding-ai-draft-generate"]').click();
    await page.locator('[data-testid="onboarding-ai-draft-preview"]').waitFor({ state: "visible" });

    const heroHeadline = await page.locator('[data-testid="draft-hero-headline"]').innerText();
    const aboutSummary = await page.locator('[data-testid="draft-about-summary"]').innerText();
    const statusBadge = await page.locator('[data-testid="onboarding-ai-draft-status-badge"]').innerText();
    const quotaAfter = await page.locator('[data-testid="onboarding-ai-quota-badge"]').innerText();

    assert(heroHeadline.includes("CONTOH — "), `Hero headline must contain CONTOH marker, got: ${heroHeadline}`);
    assert(aboutSummary.includes("CONTOH — "), `About summary must contain CONTOH marker, got: ${aboutSummary}`);
    assert(statusBadge.includes("CONTOH") && statusBadge.includes("Belum Diterbitkan"), `Status badge must show CONTOH draft, got: ${statusBadge}`);
    assert(quotaAfter.includes("99/100"), `Quota must decrement to 99/100, got: ${quotaAfter}`);
    await page.locator('[data-testid="onboarding-ai-draft-facts-empty"]').waitFor({ state: "visible" });

    await assertLayoutAndTouchTargets(page, "ai-draft-generated", 1440);
    await page.screenshot({
      path: path.join(screenshotDir, "ai-draft-generated-1440.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertLayoutAndTouchTargets(page, "ai-draft-generated", 360);
    await page.screenshot({
      path: path.join(screenshotDir, "ai-draft-generated-360.png"),
      fullPage: true,
    });

    // 4. Verify FALLBACK state (quota exhaustion / provider failure) at 360px & 1440px without blocking dashboard handoff
    mockMode = "fallback";
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto(`${baseUrl}/ai-step`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="onboarding-ai-draft-generate"]').click();
      await page.locator('[data-testid="onboarding-ai-draft-fallback"]').waitFor({ state: "visible" });
      const dashBtn = page.locator('[data-testid="onboarding-open-dashboard"]');
      await dashBtn.waitFor({ state: "visible" });
      await assertLayoutAndTouchTargets(page, "ai-draft-fallback", vp.width);
      await page.screenshot({
        path: path.join(screenshotDir, `ai-draft-fallback-${vp.width}.png`),
        fullPage: true,
      });
    }

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      `TASK-109 E2E PASS: unconfigured bypass, skip flow (0 quota), generated CONTOH draft preview (empty facts, 99/100 quota), and graceful quota/provider fallback verified at 360px & 1440px with 0 overflow, >=44px mobile touch targets, and 0 console/page errors. Screenshots saved in ${screenshotDir}`,
    );
  } finally {
    if (browser) await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
