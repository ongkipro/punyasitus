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

const screenshotDir = process.env.TASK074_SCREENSHOT_DIR || "/tmp/task-074-screenshots";
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

async function buildTask074Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t074-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const inspectorImport = path.join(
    webDir,
    "src/components/admin/editor/AiWritingInspector.tsx",
  );
  const harnessPath = path.join(srcDir, "AiWritingEditorHarness.tsx");

  fs.writeFileSync(
    harnessPath,
    `import { useState } from "react";
import { AiWritingInspector } from ${JSON.stringify(inspectorImport)};
import type { AiWritingQuotaStatus } from "@punyasitus/core/ai-writing/index";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function AiWritingEditorHarness({
  initialQuota,
  isLocked = false,
}: {
  initialQuota: AiWritingQuotaStatus;
  isLocked?: boolean;
}) {
  const [serverSaved, setServerSaved] = useState(
    "Layanan renovasi interior kantor untuk ruang kerja modern di Jakarta.",
  );
  const [draftText, setDraftText] = useState(
    "Layanan renovasi interior kantor untuk ruang kerja modern di Jakarta.",
  );
  const [titleText, setTitleText] = useState("Jasa Renovasi Kantor Modern");
  const [saveCount, setSaveCount] = useState(0);

  const isDirty = draftText !== serverSaved;

  async function handleManualSave() {
    const res = await fetch("/api/tenants/alpha-studio/draft-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: draftText }),
    });
    if (res.ok) {
      setServerSaved(draftText);
      setSaveCount((c) => c + 1);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Edit Penawaran Layanan</h1>
          <p className="text-sm text-muted-foreground">
            Uji alur bantuan tulis AI secara manusia-dalam-kendali (tanpa simpan otomatis).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={isDirty ? "warning" : "success"} data-testid="editor-dirty-badge">
            {isDirty ? "Draf lokal belum disimpan" : "Tersinkron dengan server"}
          </Badge>
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="editor-save-count">
            Simpan server: {saveCount}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 rounded-lg border border-border bg-card p-4 lg:col-span-7">
          <div className="space-y-1.5">
            <label htmlFor="e2e-title" className="block text-sm font-medium text-foreground">
              Judul penawaran
            </label>
            <input
              id="e2e-title"
              type="text"
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              className="h-11 md:h-9 w-full rounded-md border border-input bg-card px-3 text-base md:text-sm text-foreground"
              data-testid="editor-title-input"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="e2e-desc" className="block text-sm font-medium text-foreground">
              Deskripsi layanan (draf lokal)
            </label>
            <textarea
              id="e2e-desc"
              rows={5}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              className="w-full rounded-md border border-input bg-card p-3 text-base md:text-sm leading-relaxed text-foreground"
              data-testid="editor-description-input"
            />
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Konten tersimpan di server: </span>
            <span data-testid="server-saved-content">{serverSaved}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!isDirty || isLocked}
              onClick={() => void handleManualSave()}
              className="min-h-11 md:min-h-9"
              data-testid="editor-manual-save-btn"
            >
              Simpan draf
            </Button>
          </div>
        </div>

        <div className="lg:col-span-5">
          <AiWritingInspector
            tenantSelector="alpha-studio"
            fieldKind="offering_description"
            vertical="compro"
            availableFields={{
              currentText: draftText,
              title: titleText,
              category: "Arsitektur & Interior",
            }}
            isLocked={isLocked}
            canWriteContent={true}
            initialQuota={initialQuota}
            defaultOpen={true}
            onInsertSuggestion={(_kind, text) => {
              setDraftText(text);
            }}
          />
        </div>
      </div>
    </div>
  );
}
`,
  );

  const layoutProps = (title, status = "active") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="www.nusantara-arsitek.id"
    activeNavId="offerings"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus=${JSON.stringify(status)}
    publicSiteHref="https://www.nusantara-arsitek.id"
    userDisplayName="Budi Santoso"
    userRoleLabel="Editor"
  `;

  fs.writeFileSync(
    path.join(pagesDir, "editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { AiWritingEditorHarness } from ${JSON.stringify(harnessPath)};
---
<DashboardLayout ${layoutProps("Asisten Tulis AI — Editor", "active")}>
  <AiWritingEditorHarness
    client:only="react"
    initialQuota={{
      used: 12,
      limit: 100,
      remaining: 88,
      windowDays: 30,
      nextResetAt: "2026-12-20T08:00:00.000Z",
    }}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "quota-exhausted.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { AiWritingEditorHarness } from ${JSON.stringify(harnessPath)};
---
<DashboardLayout ${layoutProps("Asisten Tulis AI — Kuota Habis", "active")}>
  <AiWritingEditorHarness
    client:only="react"
    initialQuota={{
      used: 100,
      limit: 100,
      remaining: 0,
      windowDays: 30,
      nextResetAt: "2026-12-23T08:00:00.000Z",
    }}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { AiWritingEditorHarness } from ${JSON.stringify(harnessPath)};
---
<DashboardLayout ${layoutProps("Asisten Tulis AI — Terkunci", "locked")}>
  <AiWritingEditorHarness
    client:only="react"
    isLocked={true}
    initialQuota={{
      used: 5,
      limit: 100,
      remaining: 95,
      windowDays: 30,
      nextResetAt: "2026-12-20T08:00:00.000Z",
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
  const state = {
    used: 12,
    suggestCalls: 0,
    manualSaveCalls: 0,
    failNextProviderCall: false,
    lastSuggestPayload: null,
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (reqUrl.pathname === "/api/tenants/alpha-studio/ai-writing/suggest" && req.method === "POST") {
      state.suggestCalls += 1;
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8") || "{}");
      state.lastSuggestPayload = body;

      if (state.failNextProviderCall) {
        state.failNextProviderCall = false;
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code: "AI_PROVIDER_ERROR",
              message:
                "Layanan bantuan tulis AI sedang mengalami gangguan. Teks Anda di editor tetap aman dan kuota tidak terpotong.",
              retryable: true,
              quota: {
                used: state.used,
                limit: 100,
                remaining: 100 - state.used,
                windowDays: 30,
                nextResetAt: "2026-12-20T08:00:00.000Z",
              },
            },
            requestId: "req_e2e_provider_fail",
          }),
        );
        return;
      }

      state.used += 1;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          suggestion:
            "Kami menyediakan jasa renovasi interior kantor modern di Jakarta untuk ruang kerja yang nyaman, fungsional, dan selaras dengan identitas perusahaan Anda.",
          fieldKind: body.fieldKind || "offering_description",
          vertical: "compro",
          tone: body.tone || "profesional",
          model: "@cf/meta/llama-3.1-8b-instruct-fast",
          factCheckReminder:
            "Periksa kembali fakta, harga, dan izin usaha sebelum menyimpan atau menerbitkan. Saran AI tidak pernah disimpan atau diterbitkan secara otomatis.",
          quota: {
            used: state.used,
            limit: 100,
            remaining: 100 - state.used,
            windowDays: 30,
            nextResetAt: "2026-12-20T08:00:00.000Z",
          },
          requestId: `req_e2e_${state.suggestCalls}`,
        }),
      );
      return;
    }

    if (reqUrl.pathname === "/api/tenants/alpha-studio/draft-save" && req.method === "POST") {
      state.manualSaveCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let relPath = reqUrl.pathname;
    if (relPath === "/") relPath = "/editor/index.html";
    let filePath = path.join(outDir, relPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}/index.html`)) {
      filePath = `${filePath}/index.html`;
    } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function checkNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${label}: horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
}

async function checkMobileTouchTargets(page, label) {
  const smallTargets = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="ai-writing-inspector"]');
    if (!container) return [];
    const buttons = [...container.querySelectorAll("button")];
    const bad = [];
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height < 43.5) {
        bad.push({
          text: (btn.textContent || "").trim(),
          height: Math.round(rect.height),
        });
      }
    }
    return bad;
  });
  assert(
    smallTargets.length === 0,
    `${label}: mobile touch targets < 44px: ${JSON.stringify(smallTargets)}`,
  );
}

async function main() {
  const fixture = await buildTask074Fixtures();
  const server = await startFixtureServer(fixture.outDir);
  const browser = await chromium.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    // 1. Desktop 1440px end-to-end flows
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await desktopCtx.newPage();
    let expectIntentional502 = false;
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const txt = msg.text();
        if (expectIntentional502 && txt.includes("502 (Bad Gateway)")) {
          return;
        }
        consoleErrors.push(`desktop: ${txt}`);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(`desktop: ${err.message}`));

    await page.goto(`${server.baseUrl}/editor`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="ai-writing-generate-btn"]');
    await checkNoHorizontalOverflow(page, "desktop-initial");

    // 1a. Generate -> preview + fact-check reminder -> Discard leaves editor & server untouched
    const originalText = await page.inputValue('[data-testid="editor-description-input"]');
    await page.click('[data-testid="ai-writing-generate-btn"]');
    await page.waitForSelector('[data-testid="ai-writing-suggestion-box"]');
    await page.waitForSelector('[data-testid="ai-writing-fact-check-reminder"]');
    const badgeAfterFirst = await page.textContent('[data-testid="ai-writing-quota-badge"]');
    assert(
      badgeAfterFirst?.includes("87 dari 100 saran tersisa"),
      `Expected updated quota badge 87/100, got: ${badgeAfterFirst}`,
    );

    await page.screenshot({
      path: path.join(screenshotDir, "01-editor-desktop-1440.png"),
      fullPage: true,
    });

    await page.click('[data-testid="ai-writing-discard-btn"]');
    assert(
      (await page.inputValue('[data-testid="editor-description-input"]')) === originalText,
      "Discard must leave editor input untouched",
    );
    assert(
      (await page.textContent('[data-testid="server-saved-content"]')) === originalText,
      "Discard must leave server content untouched",
    );
    assert(server.state.manualSaveCalls === 0, "Zero auto-save calls allowed on discard");

    // 1b. Generate -> Edit -> Insert updates ONLY local draft (server still untouched until save!)
    await page.click('[data-testid="ai-writing-generate-btn"]');
    await page.waitForSelector('[data-testid="ai-writing-edit-btn"]');
    await page.click('[data-testid="ai-writing-edit-btn"]');
    await page.waitForSelector('[data-testid="ai-writing-edit-textarea"]');
    const editedCopy =
      "Jasa renovasi interior kantor modern di Jakarta dengan hasil rapi, tepat waktu, dan transparan.";
    await page.fill('[data-testid="ai-writing-edit-textarea"]', editedCopy);
    await page.click('[data-testid="ai-writing-insert-btn"]');

    assert(
      (await page.inputValue('[data-testid="editor-description-input"]')) === editedCopy,
      "Insert must populate local unsaved draft textarea",
    );
    assert(
      (await page.textContent('[data-testid="server-saved-content"]')) === originalText,
      "Insert MUST NOT auto-save to server!",
    );
    assert(
      server.state.manualSaveCalls === 0,
      "Zero server save calls allowed after inserting AI suggestion",
    );
    const dirtyBadge = await page.textContent('[data-testid="editor-dirty-badge"]');
    assert(dirtyBadge?.includes("belum disimpan"), `Expected dirty badge, got: ${dirtyBadge}`);

    // 1c. PII blocked UI state: typing email/phone blocks BEFORE API call & preserves user input
    const piiInput = "Hubungi tim kami di sales@nusantara.id atau 0812-3456-7890 untuk survei.";
    const callsBeforePii = server.state.suggestCalls;
    await page.fill('[data-testid="editor-description-input"]', piiInput);
    await page.click('[data-testid="ai-writing-generate-btn"]');
    await page.waitForSelector('[data-testid="ai-writing-error-pii"]');
    assert(
      server.state.suggestCalls === callsBeforePii,
      "PII-containing input must be blocked before calling suggest API",
    );
    assert(
      (await page.inputValue('[data-testid="editor-description-input"]')) === piiInput,
      "PII block must preserve editor input intact",
    );
    await page.screenshot({
      path: path.join(screenshotDir, "03-pii-blocked-1440.png"),
      fullPage: true,
    });

    // 1d. Provider failure UI state preserves input and shows retry button
    const cleanInput = "Jasa desain interior ruang kerja minimalis untuk perusahaan berkembang.";
    await page.fill('[data-testid="editor-description-input"]', cleanInput);
    server.state.failNextProviderCall = true;
    expectIntentional502 = true;
    await page.click('[data-testid="ai-writing-generate-btn"]');
    await page.waitForSelector('[data-testid="ai-writing-error-provider"]');
    expectIntentional502 = false;
    await page.waitForSelector('[data-testid="ai-writing-retry-btn"]');
    assert(
      (await page.inputValue('[data-testid="editor-description-input"]')) === cleanInput,
      "Provider failure must preserve user input",
    );

    // 1e. Quota exhausted (100/100) UI state
    await page.goto(`${server.baseUrl}/quota-exhausted`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="ai-writing-quota-exhausted-alert"]');
    assert(
      await page.isDisabled('[data-testid="ai-writing-generate-btn"]'),
      "Generate button must be disabled when quota is exhausted (100/100)",
    );
    await checkNoHorizontalOverflow(page, "desktop-quota-exhausted");
    await page.screenshot({
      path: path.join(screenshotDir, "04-quota-exhausted-1440.png"),
      fullPage: true,
    });

    // 1f. Locked tenant UI state
    await page.goto(`${server.baseUrl}/locked`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="ai-writing-locked-alert"]');
    assert(
      await page.isDisabled('[data-testid="ai-writing-generate-btn"]'),
      "Generate button must be disabled when tenant is locked",
    );

    await desktopCtx.close();

    // 2. Mobile 360px visual & touch-target checks
    const mobileCtx = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const mobilePage = await mobileCtx.newPage();
    mobilePage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`mobile: ${msg.text()}`);
    });
    mobilePage.on("pageerror", (err) => pageErrors.push(`mobile: ${err.message}`));

    await mobilePage.goto(`${server.baseUrl}/editor`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector('[data-testid="ai-writing-generate-btn"]');
    await mobilePage.click('[data-testid="ai-writing-generate-btn"]');
    await mobilePage.waitForSelector('[data-testid="ai-writing-suggestion-box"]');
    await checkNoHorizontalOverflow(mobilePage, "mobile-editor");
    await checkMobileTouchTargets(mobilePage, "mobile-editor");
    await mobilePage.screenshot({
      path: path.join(screenshotDir, "02-editor-mobile-360.png"),
      fullPage: true,
    });

    await mobilePage.goto(`${server.baseUrl}/quota-exhausted`, { waitUntil: "networkidle" });
    await mobilePage.waitForSelector('[data-testid="ai-writing-quota-exhausted-alert"]');
    await checkNoHorizontalOverflow(mobilePage, "mobile-quota-exhausted");
    await checkMobileTouchTargets(mobilePage, "mobile-quota-exhausted");
    await mobilePage.screenshot({
      path: path.join(screenshotDir, "05-quota-exhausted-mobile-360.png"),
      fullPage: true,
    });

    await mobileCtx.close();

    assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors: ${pageErrors.join("; ")}`);

    console.log(
      `PASS tests/task-074/e2e.mjs — 360px & 1440px verified (screenshots: ${screenshotDir})`,
    );
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
