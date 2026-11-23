/* global process, console, document, URL, structuredClone */
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

const screenshotDir = process.env.TASK064_SCREENSHOT_DIR || "/tmp/task-064-screenshots";

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

const SAMPLE_PAGE_REVISIONS = [
  {
    id: "page-12-5",
    revisionId: "page-12-5",
    resourceType: "page",
    resourceId: 12,
    revisionNumber: 5,
    schemaVersion: 1,
    triggerKind: "publish",
    actorUserId: "usr_owner_01",
    summary: 'Terbitkan "Profil Perusahaan Terbaru" (/tentang-kami)',
    title: "Profil Perusahaan Terbaru",
    slug: "tentang-kami",
    createdAt: "2026-11-23T09:30:00.000Z",
  },
  {
    id: "page-12-4",
    revisionId: "page-12-4",
    resourceType: "page",
    resourceId: 12,
    revisionNumber: 4,
    schemaVersion: 1,
    triggerKind: "save",
    actorUserId: "usr_editor_01",
    summary: 'Simpan draf "Profil Perusahaan — Revisi Klien" (/tentang-kami)',
    title: "Profil Perusahaan — Revisi Klien",
    slug: "tentang-kami",
    createdAt: "2026-11-23T08:45:00.000Z",
  },
  {
    id: "page-12-3",
    revisionId: "page-12-3",
    resourceType: "page",
    resourceId: 12,
    revisionNumber: 3,
    schemaVersion: 1,
    triggerKind: "save",
    actorUserId: "usr_editor_01",
    summary: 'Simpan draf "Tentang Kami — Versi Asli" (/tentang-kami)',
    title: "Tentang Kami — Versi Asli",
    slug: "tentang-kami",
    createdAt: "2026-11-22T15:10:00.000Z",
  },
];

async function buildEditorFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t064-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const pageEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/pages/_PageEditorClient.tsx",
  );
  const postEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/posts/_PostEditorClient.tsx",
  );
  const offeringEditorImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/catalog/_OfferingEditorClient.tsx",
  );

  const editorPerms = JSON.stringify({
    role: "editor",
    roleLabel: "Editor",
    tenantStatus: "active",
    isLocked: false,
    canWriteContent: true,
    canPublishContent: true,
    canManageMedia: true,
    canUploadMedia: true,
    canManageMenus: true,
    canManageSettings: false,
    canPurgeContent: false,
  });

  const initialPageJson = JSON.stringify({
    id: 12,
    title: "Profil Perusahaan Terbaru",
    slug: "tentang-kami",
    status: "published",
    isHomepage: false,
    layoutMode: "standard",
    sections: [
      {
        id: "hero-1",
        kind: "hero",
        heading: "Solusi B2B Terpercaya",
        subheading: "Layanan profesional bergaransi resmi.",
        bodyHtml: null,
        ctaLabel: "Hubungi Kami",
        ctaHref: "/kontak",
      },
    ],
    seo: null,
    hasUnpublishedChanges: false,
    version: 5,
  });

  const initialPostJson = JSON.stringify({
    id: 21,
    title: "Panduan Renovasi Kantor 2026",
    slug: "panduan-renovasi-kantor-2026",
    excerpt: "Ringkasan panduan renovasi kantor hemat biaya.",
    body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Isi artikel panduan." }] },
    status: "published",
    featuredMediaId: null,
    authorId: null,
    primaryCategoryId: null,
    categoryIds: [],
    tagIds: [],
    enableToc: false,
    seo: null,
    hasUnpublishedChanges: false,
    version: 3,
  });

  const initialOfferingJson = JSON.stringify({
    id: 31,
    offeringType: "service",
    title: "Jasa Audit Infrastruktur",
    slug: "jasa-audit-infrastruktur",
    summary: "Audit menyeluruh untuk bisnis B2B.",
    description: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Detail layanan audit." }] },
    coverMediaId: null,
    galleryMediaIds: [],
    youtubeVideoId: "",
    priceMode: "fixed",
    price: 4500000,
    priceMax: null,
    negotiable: false,
    originalAmount: null,
    badge: "",
    ctaMode: "whatsapp",
    ctaLabel: "",
    externalUrl: "",
    whatsappOverride: "",
    whatsappTemplate: "",
    unitStatus: null,
    attributes: {},
    seo: null,
    status: "published",
    version: 4,
  });

  fs.writeFileSync(
    path.join(pagesDir, "page-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
const permissions = ${editorPerms};
const initialPage = ${initialPageJson};
---
<DashboardLayout
  title="Edit Halaman — Karya Nusantara"
  surface="dashboard"
  workspaceName="Karya Nusantara"
  workspaceSubtitle="karyanusantara.situsku.click"
  activeNavId="pages"
  basePath="/dashboard/karyanusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://karyanusantara.situsku.click"
  userDisplayName="Sari Editor"
  userRoleLabel="Editor"
>
  <PageEditorClient
    client:only="react"
    handle="karyanusantara"
    basePath="/dashboard/karyanusantara"
    permissions={permissions}
    initialPage={initialPage}
    seoAutopilotEnabled={false}
  />
</DashboardLayout>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "post-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PostEditorClient } from ${JSON.stringify(postEditorImport)};
const permissions = ${editorPerms};
const initialPost = ${initialPostJson};
---
<DashboardLayout
  title="Edit Artikel — Karya Nusantara"
  surface="dashboard"
  workspaceName="Karya Nusantara"
  workspaceSubtitle="karyanusantara.situsku.click"
  activeNavId="articles"
  basePath="/dashboard/karyanusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://karyanusantara.situsku.click"
  userDisplayName="Sari Editor"
  userRoleLabel="Editor"
>
  <PostEditorClient
    client:only="react"
    handle="karyanusantara"
    basePath="/dashboard/karyanusantara"
    permissions={permissions}
    initialPost={initialPost}
    categories={[]}
    tags={[]}
    seoAutopilotEnabled={false}
  />
</DashboardLayout>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "offering-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { OfferingEditorClient } from ${JSON.stringify(offeringEditorImport)};
const permissions = ${editorPerms};
const initialOffering = ${initialOfferingJson};
---
<DashboardLayout
  title="Edit Penawaran — Karya Nusantara"
  surface="dashboard"
  workspaceName="Karya Nusantara"
  workspaceSubtitle="karyanusantara.situsku.click"
  activeNavId="offering"
  basePath="/dashboard/karyanusantara"
  offeringLabel="Layanan"
  lifecycleStatus="active"
  publicSiteHref="https://karyanusantara.situsku.click"
  userDisplayName="Sari Editor"
  userRoleLabel="Editor"
>
  <OfferingEditorClient
    client:only="react"
    handle="karyanusantara"
    basePath="/dashboard/karyanusantara"
    permissions={permissions}
    initialOffering={initialOffering}
    seoAutopilotEnabled={false}
  />
</DashboardLayout>
`,
  );

  const { build } = await import(astroEntryUrl);
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href))
    .default;
  const react = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    integrations: [react()],
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

function startStaticServer(outDir) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      let filePath = path.join(outDir, reqUrl.pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      } else if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
        filePath = `${filePath}.html`;
      }
      if (!fs.existsSync(filePath) || !filePath.startsWith(outDir)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function assertZeroHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow detected (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`,
  );
}

async function assertMinTouchTarget(page, selector, label, minPx = 44) {
  const box = await page.locator(selector).first().boundingBox();
  assert(box !== null, `${label}: element ${selector} not visible`);
  assert(
    box.height >= minPx,
    `${label}: touch target ${selector} height ${box.height}px < ${minPx}px`,
  );
}

async function attachMockRevisionApi(page, state) {
  await page.route("**/api/tenants/*/revisions**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (req.method() === "GET" && pathname.endsWith("/revisions")) {
      const resourceType = url.searchParams.get("resourceType") || "page";
      const resourceId = Number(url.searchParams.get("resourceId") || "12");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: state.revisions,
          resourceType,
          resourceId,
          currentVersion: state.currentVersion,
          resourceStatus: "published",
          maxRetained: 20,
        }),
      });
    }

    if (req.method() === "GET" && !pathname.endsWith("/restore")) {
      const revId = pathname.split("/").pop();
      const found = state.revisions.find((r) => r.revisionId === revId) || state.revisions[0];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...found,
          currentVersion: state.currentVersion,
          resourceStatus: "published",
          snapshot: { title: found.title, slug: found.slug },
          referenceReport: {
            referencedMediaIds: found.revisionNumber === 3 ? [401] : [],
            validMediaIds: [],
            missingMediaIds: found.revisionNumber === 3 ? [401] : [],
            trashedMediaIds: [],
            unavailableMediaIds: [],
            detachedMediaIds: found.revisionNumber === 3 ? [401] : [],
            missingTaxonomyIds: [],
            missingAuthorId: null,
            warnings:
              found.revisionNumber === 3
                ? [
                    {
                      kind: "media",
                      id: 401,
                      status: "missing",
                      field: "media",
                      message:
                        "Media #401 tidak ditemukan di pustaka media situs ini dan telah dilepaskan dari draf.",
                    },
                  ]
                : [],
          },
        }),
      });
    }

    if (req.method() === "POST" && pathname.endsWith("/restore")) {
      const payload = JSON.parse(req.postData() || "{}");
      if (state.forceConflictOnce || payload.expectedVersion !== state.currentVersion) {
        state.forceConflictOnce = false;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "STALE_VERSION",
              message:
                "Versi halaman di server sudah berubah (v6). Muat ulang versi terbaru sebelum memulihkan revisi.",
            },
            requestId: "req_t064_conflict",
          }),
        });
      }

      const revId = pathname.split("/").slice(-2, -1)[0];
      const targetRev = state.revisions.find((r) => r.revisionId === revId) || state.revisions[0];
      state.currentVersion += 1;
      const nextRevNum = (state.revisions[0]?.revisionNumber ?? 5) + 1;
      const restoredEntry = {
        id: `page-12-${nextRevNum}`,
        revisionId: `page-12-${nextRevNum}`,
        resourceType: "page",
        resourceId: 12,
        revisionNumber: nextRevNum,
        schemaVersion: 1,
        triggerKind: "restore",
        actorUserId: "usr_editor_01",
        summary: `Pulihkan dari revisi #${targetRev.revisionNumber} sebagai draf ("${targetRev.title}")`,
        title: targetRev.title,
        slug: targetRev.slug,
        createdAt: "2026-11-23T10:00:00.000Z",
      };
      state.revisions = [restoredEntry, ...state.revisions].slice(0, 20);

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          restored: true,
          revisionId: restoredEntry.revisionId,
          resourceType: "page",
          resourceId: 12,
          restoredFromRevisionNumber: targetRev.revisionNumber,
          newRevisionNumber: nextRevNum,
          version: state.currentVersion,
          status: "published",
          draftOnly: true,
          hasUnpublishedChanges: true,
          warnings:
            targetRev.revisionNumber === 3
              ? [
                  {
                    kind: "media",
                    id: 401,
                    status: "missing",
                    field: "media",
                    message: "Media #401 tidak ditemukan dan dilepaskan dari draf.",
                  },
                ]
              : [],
          restoredAt: "2026-11-23T10:00:00.000Z",
          resource: {
            id: 12,
            title: targetRev.title,
            slug: targetRev.slug,
            status: "published",
            isHomepage: false,
            layoutMode: "standard",
            sections: [
              {
                id: "hero-restored",
                kind: "hero",
                heading: "Heading Versi Asli Dipulihkan",
                subheading: "Draf hasil pemulihan revisi #3.",
                bodyHtml: null,
                ctaLabel: "Hubungi Kami",
                ctaHref: "/kontak",
              },
            ],
            seo: null,
            hasUnpublishedChanges: true,
            version: state.currentVersion,
          },
        }),
      });
    }

    return route.continue();
  });
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildEditorFixtures();
  const { server, baseUrl } = await startStaticServer(outDir);

  let browser;
  try {
    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // ------------------------------------------------------------------
    // 1. Desktop 1440px — Page Editor Revision List, Dialog, Restore & 409
    // ------------------------------------------------------------------
    const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktopPage = await desktopCtx.newPage();
    const desktopErrors = [];
    desktopPage.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (text.includes("status of 409 (Conflict)")) return;
        desktopErrors.push(text);
      }
    });
    desktopPage.on("pageerror", (err) => desktopErrors.push(String(err)));

    const desktopState = {
      currentVersion: 5,
      forceConflictOnce: false,
      revisions: structuredClone(SAMPLE_PAGE_REVISIONS),
    };
    await attachMockRevisionApi(desktopPage, desktopState);

    await desktopPage.goto(`${baseUrl}/page-editor`, { waitUntil: "networkidle" });
    await desktopPage.locator('[data-testid="revision-history-panel"]').waitFor({ state: "visible" });
    await desktopPage.locator('[data-testid="revision-toggle-btn"]').click();
    await desktopPage.locator('[data-testid="revision-row-3"]').waitFor({ state: "visible" });
    await assertZeroHorizontalOverflow(desktopPage, "desktop-1440-revision-list");

    const countBadgeText = await desktopPage.locator('[data-testid="revision-count-badge"]').textContent();
    assert(countBadgeText?.includes("3 / 20"), `Unexpected revision count badge: ${countBadgeText}`);

    await desktopPage.locator('[data-testid="revision-history-panel"]').scrollIntoViewIfNeeded();
    await desktopPage.screenshot({
      path: path.join(screenshotDir, "01-revision-list-1440.png"),
      fullPage: false,
    });

    // Open Restore Confirmation Dialog for revision #3 (with missing media warning)
    await desktopPage.locator('[data-testid="revision-restore-btn-3"]').click();
    const dialog = desktopPage.locator('[data-testid="revision-restore-dialog"]');
    await dialog.waitFor({ state: "visible" });
    const dialogText = await dialog.textContent();
    assert(
      dialogText?.includes("Pulihkan sebagai Draf — tidak mengubah halaman publik sebelum Anda klik Terbitkan"),
      "Restore dialog missing draft-only confirmation text",
    );
    await desktopPage.locator('[data-testid="revision-reference-warnings"]').waitFor({ state: "visible" });
    await desktopPage.screenshot({
      path: path.join(screenshotDir, "02-restore-dialog-1440.png"),
      fullPage: false,
    });

    // Keyboard Escape closes dialog cleanly
    await desktopPage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // Re-open and confirm restore -> updates editor title & shows draft-only success banner
    await desktopPage.locator('[data-testid="revision-restore-btn-3"]').click();
    await dialog.waitFor({ state: "visible" });
    await desktopPage.locator('[data-testid="revision-restore-confirm"]').click();
    await dialog.waitFor({ state: "hidden" });

    await desktopPage.locator('[data-testid="revision-row-6"]').waitFor({ state: "visible" });
    const restoredTitleVal = await desktopPage.locator("#page-title").inputValue();
    assert(
      restoredTitleVal === "Tentang Kami — Versi Asli",
      `Expected restored draft title, got: ${restoredTitleVal}`,
    );
    await desktopPage.screenshot({
      path: path.join(screenshotDir, "03-restored-draft-banner-1440.png"),
      fullPage: false,
    });

    // Trigger 409 conflict on restore -> shows reload guidance button
    desktopState.forceConflictOnce = true;
    await desktopPage.locator('[data-testid="revision-restore-btn-4"]').click();
    await dialog.waitFor({ state: "visible" });
    await desktopPage.locator('[data-testid="revision-restore-confirm"]').click();
    await desktopPage.locator('[data-testid="revision-restore-conflict-409"]').waitFor({ state: "visible" });
    await desktopPage.locator('[data-testid="revision-conflict-reload-btn"]').waitFor({ state: "visible" });
    await desktopPage.screenshot({
      path: path.join(screenshotDir, "04-conflict-409-1440.png"),
      fullPage: false,
    });
    await desktopPage.locator('[data-testid="revision-restore-cancel"]').click();
    await dialog.waitFor({ state: "hidden" });

    // Verify RevisionHistoryPanel also mounts cleanly in Post & Offering editors
    await desktopPage.goto(`${baseUrl}/post-editor`, { waitUntil: "networkidle" });
    await desktopPage.locator('[data-testid="revision-history-panel"]').waitFor({ state: "visible" });
    await assertZeroHorizontalOverflow(desktopPage, "desktop-1440-post-editor");

    await desktopPage.goto(`${baseUrl}/offering-editor`, { waitUntil: "networkidle" });
    await desktopPage.locator('[data-testid="revision-history-panel"]').waitFor({ state: "visible" });
    await assertZeroHorizontalOverflow(desktopPage, "desktop-1440-offering-editor");

    assert(
      desktopErrors.length === 0,
      `Desktop console/page errors: ${desktopErrors.join(" | ")}`,
    );
    await desktopCtx.close();

    // ------------------------------------------------------------------
    // 2. Mobile 360px — Zero overflow + >=44px touch targets + Dialog
    // ------------------------------------------------------------------
    const mobileCtx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const mobilePage = await mobileCtx.newPage();
    const mobileErrors = [];
    mobilePage.on("console", (msg) => {
      if (msg.type() === "error") mobileErrors.push(msg.text());
    });
    mobilePage.on("pageerror", (err) => mobileErrors.push(String(err)));

    const mobileState = {
      currentVersion: 5,
      forceConflictOnce: false,
      revisions: structuredClone(SAMPLE_PAGE_REVISIONS),
    };
    await attachMockRevisionApi(mobilePage, mobileState);

    await mobilePage.goto(`${baseUrl}/page-editor`, { waitUntil: "networkidle" });
    await mobilePage.locator('[data-testid="revision-history-panel"]').waitFor({ state: "visible" });
    await assertMinTouchTarget(mobilePage, '[data-testid="revision-toggle-btn"]', "mobile-360-toggle", 44);
    await mobilePage.locator('[data-testid="revision-toggle-btn"]').click();
    await mobilePage.locator('[data-testid="revision-row-3"]').waitFor({ state: "visible" });
    await assertMinTouchTarget(mobilePage, '[data-testid="revision-restore-btn-3"]', "mobile-360-restore-btn", 44);
    await assertZeroHorizontalOverflow(mobilePage, "mobile-360-revision-list");

    await mobilePage.locator('[data-testid="revision-history-panel"]').scrollIntoViewIfNeeded();
    await mobilePage.screenshot({
      path: path.join(screenshotDir, "05-revision-list-360.png"),
      fullPage: false,
    });

    await mobilePage.locator('[data-testid="revision-restore-btn-3"]').click();
    const mDialog = mobilePage.locator('[data-testid="revision-restore-dialog"]');
    await mDialog.waitFor({ state: "visible" });
    await assertMinTouchTarget(mobilePage, '[data-testid="revision-restore-confirm"]', "mobile-360-confirm", 44);
    await assertMinTouchTarget(mobilePage, '[data-testid="revision-restore-cancel"]', "mobile-360-cancel", 44);
    await assertZeroHorizontalOverflow(mobilePage, "mobile-360-restore-dialog");

    await mobilePage.screenshot({
      path: path.join(screenshotDir, "06-restore-dialog-360.png"),
      fullPage: false,
    });

    assert(mobileErrors.length === 0, `Mobile console/page errors: ${mobileErrors.join(" | ")}`);
    await mobileCtx.close();

    console.log(
      `PASS: TASK-064 E2E passed at 1440px & 360px (screenshots in ${screenshotDir}, zero overflow, >=44px mobile targets, zero console/page errors).`,
    );
  } finally {
    if (browser) await browser.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
