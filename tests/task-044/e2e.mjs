/* global process, console, document, URL, Buffer, structuredClone */
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

const screenshotDir = process.env.TASK044_SCREENSHOT_DIR || "/tmp/punyasitus-t044-screenshots";

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

const SAMPLE_TRASHED_PAGES = [
  {
    resourceType: "page",
    resourceId: 11,
    offeringType: null,
    slug: "promo-akhir-tahun",
    publicPath: "/promo-akhir-tahun",
    title: "Promo Akhir Tahun B2B",
    isHomepage: false,
    version: 3,
    deletedAt: "2026-11-20T08:00:00.000Z",
    purgeEligibleAt: "2026-12-20T08:00:00.000Z",
    daysRemaining: 27,
    isExpired: false,
    updatedAt: "2026-11-20T08:00:00.000Z",
    protectedReferences: [],
    mediaReferences: {
      referencedMediaIds: [401],
      validMediaIds: [],
      missingMediaIds: [401],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [
        {
          mediaId: 401,
          status: "missing",
          message: "Media #401 sudah dihapus permanen dari pustaka media.",
        },
      ],
    },
  },
  {
    resourceType: "page",
    resourceId: 12,
    offeringType: null,
    slug: "kebijakan-privasi",
    publicPath: "/kebijakan-privasi",
    title: "Kebijakan Privasi Situs",
    isHomepage: false,
    version: 2,
    deletedAt: "2026-10-20T08:00:00.000Z",
    purgeEligibleAt: "2026-11-19T08:00:00.000Z",
    daysRemaining: 0,
    isExpired: true,
    updatedAt: "2026-10-20T08:00:00.000Z",
    protectedReferences: [
      {
        kind: "policy_setting",
        sourceTable: "site_settings",
        field: "published.privacyPageId",
        reason: "Halaman ini masih ditautkan sebagai halaman kebijakan/privasi aktif di pengaturan situs (published.privacyPageId).",
      },
      {
        kind: "navigation_menu",
        sourceTable: "menus",
        location: "footer",
        label: "Privasi",
        reason: 'Tautan menu navigasi (footer: "Privasi") masih mengarah ke konten ini.',
      },
    ],
    mediaReferences: {
      referencedMediaIds: [],
      validMediaIds: [],
      missingMediaIds: [],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [],
    },
  },
  {
    resourceType: "page",
    resourceId: 13,
    offeringType: null,
    slug: "tentang-cabang-lama",
    publicPath: "/tentang-cabang-lama",
    title: "Tentang Cabang Lama",
    isHomepage: false,
    version: 4,
    deletedAt: "2026-11-10T09:30:00.000Z",
    purgeEligibleAt: "2026-12-10T09:30:00.000Z",
    daysRemaining: 17,
    isExpired: false,
    updatedAt: "2026-11-10T09:30:00.000Z",
    protectedReferences: [],
    mediaReferences: {
      referencedMediaIds: [],
      validMediaIds: [],
      missingMediaIds: [],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [],
    },
  },
];

const SAMPLE_TRASHED_POSTS = [
  {
    resourceType: "post",
    resourceId: 21,
    offeringType: null,
    slug: "tips-renovasi-hemat-2025",
    publicPath: "/blog/tips-renovasi-hemat-2025",
    title: "Tips Renovasi Kantor Hemat Energi 2025",
    isHomepage: false,
    version: 2,
    deletedAt: "2026-11-18T11:00:00.000Z",
    purgeEligibleAt: "2026-12-18T11:00:00.000Z",
    daysRemaining: 25,
    isExpired: false,
    updatedAt: "2026-11-18T11:00:00.000Z",
    protectedReferences: [],
    mediaReferences: {
      referencedMediaIds: [501],
      validMediaIds: [501],
      missingMediaIds: [],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [],
    },
  },
];

const SAMPLE_TRASHED_CATALOG = [
  {
    resourceType: "offering",
    resourceId: 31,
    offeringType: "service",
    slug: "audit-desain-2025",
    publicPath: "/layanan/audit-desain-2025",
    title: "Audit & Desain Kantor B2B (Paket Lama)",
    isHomepage: false,
    version: 5,
    deletedAt: "2026-11-15T14:00:00.000Z",
    purgeEligibleAt: "2026-12-15T14:00:00.000Z",
    daysRemaining: 22,
    isExpired: false,
    updatedAt: "2026-11-15T14:00:00.000Z",
    protectedReferences: [],
    mediaReferences: {
      referencedMediaIds: [601],
      validMediaIds: [601],
      missingMediaIds: [],
      trashedMediaIds: [],
      unavailableMediaIds: [],
      warnings: [],
    },
  },
];

async function buildTrashFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t044-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const trashClientImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/pages/_ContentTrashClient.tsx",
  );

  const ownerPerms = JSON.stringify({
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
    canPurgeContent: true,
  });

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

  const lockedPerms = JSON.stringify({
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
    canPurgeContent: false,
  });

  const layoutProps = (title, activeNavId, lifecycleStatus = "active", userRoleLabel = "Pemilik Situs") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId=${JSON.stringify(activeNavId)}
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel=${JSON.stringify(userRoleLabel)}
  `;

  // 1. Pages Trash (Owner)
  fs.writeFileSync(
    path.join(pagesDir, "pages-trash.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { ContentTrashClient } from ${JSON.stringify(trashClientImport)};
---
<DashboardLayout ${layoutProps("Sampah Halaman — PT Nusantara Arsitek", "pages")}>
  <ContentTrashClient
    client:load
    resourceType="page"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPerms}}
    initialItems={${JSON.stringify(SAMPLE_TRASHED_PAGES)}}
  />
</DashboardLayout>`,
  );

  // 2. Posts Trash (Editor RBAC view)
  fs.writeFileSync(
    path.join(pagesDir, "posts-trash-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { ContentTrashClient } from ${JSON.stringify(trashClientImport)};
---
<DashboardLayout ${layoutProps("Sampah Artikel — PT Nusantara Arsitek", "articles", "active", "Editor")}>
  <ContentTrashClient
    client:load
    resourceType="post"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${editorPerms}}
    initialItems={${JSON.stringify(SAMPLE_TRASHED_POSTS)}}
  />
</DashboardLayout>`,
  );

  // 3. Catalog Trash (Owner + Locked view)
  fs.writeFileSync(
    path.join(pagesDir, "catalog-trash.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { ContentTrashClient } from ${JSON.stringify(trashClientImport)};
---
<DashboardLayout ${layoutProps("Sampah Katalog Layanan — PT Nusantara Arsitek", "offering")}>
  <ContentTrashClient
    client:load
    resourceType="offering"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    permissions={${ownerPerms}}
    initialItems={${JSON.stringify(SAMPLE_TRASHED_CATALOG)}}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "catalog-trash-locked.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { ContentTrashClient } from ${JSON.stringify(trashClientImport)};
---
<DashboardLayout ${layoutProps("Sampah Katalog (Terkunci) — PT Nusantara Arsitek", "offering", "locked")}>
  <ContentTrashClient
    client:load
    resourceType="offering"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    permissions={${lockedPerms}}
    initialItems={${JSON.stringify(SAMPLE_TRASHED_CATALOG)}}
  />
</DashboardLayout>`,
  );

  // 4. Empty Trash state
  fs.writeFileSync(
    path.join(pagesDir, "pages-trash-empty.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { ContentTrashClient } from ${JSON.stringify(trashClientImport)};
---
<DashboardLayout ${layoutProps("Sampah Halaman Kosong — PT Nusantara Arsitek", "pages")}>
  <ContentTrashClient
    client:load
    resourceType="page"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPerms}}
    initialItems={[]}
  />
</DashboardLayout>`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcss = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;

  await build({
    root: webDir,
    configFile: false,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
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

function startStaticAndApiServer(outDir) {
  const state = {
    failNextTrashLoad: false,
    forceNextRestoreStale: false,
    forceFirstSlugConflictFor11: true,
    pagesTrash: structuredClone(SAMPLE_TRASHED_PAGES),
    postsTrash: structuredClone(SAMPLE_TRASHED_POSTS),
    catalogTrash: structuredClone(SAMPLE_TRASHED_CATALOG),
    restoreCalls: 0,
    purgeCalls: 0,
  };

  const mimeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
  };

  function sendJson(res, status, body) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    // Trash list API
    const trashListMatch = p.match(/^\/api\/tenants\/[^/]+\/(pages|posts|catalog)\/trash$/);
    if (trashListMatch && method === "GET") {
      if (state.failNextTrashLoad) {
        state.failNextTrashLoad = false;
        return sendJson(res, 503, {
          error: { code: "SERVICE_UNAVAILABLE", message: "Penyimpanan sampah sementara sibuk." },
          requestId: "req_err",
        });
      }
      const kind = trashListMatch[1];
      const items =
        kind === "pages"
          ? state.pagesTrash
          : kind === "posts"
            ? state.postsTrash
            : state.catalogTrash;
      return sendJson(res, 200, { items });
    }

    // Restore API
    const restoreMatch = p.match(/^\/api\/tenants\/[^/]+\/(pages|posts|catalog)\/(\d+)\/restore$/);
    if (restoreMatch && method === "POST") {
      const kind = restoreMatch[1];
      const id = Number(restoreMatch[2]);
      const body = await readBody(req);
      state.restoreCalls += 1;

      if (state.forceNextRestoreStale) {
        state.forceNextRestoreStale = false;
        return sendJson(res, 409, {
          error: {
            code: "STALE_VERSION",
            message: "Versi konten sudah diperbarui oleh anggota tim lain.",
            fields: [{ field: "version", code: "STALE_VERSION", message: "Stale version" }],
          },
          requestId: "req_stale",
        });
      }

      if (kind === "pages" && id === 11 && state.forceFirstSlugConflictFor11 && !body.resolvedSlug) {
        state.forceFirstSlugConflictFor11 = false;
        return sendJson(res, 409, {
          error: {
            code: "CONFLICT",
            message: 'Slug "promo-akhir-tahun" sudah digunakan oleh halaman aktif lain. Saran alternatif: "promo-akhir-tahun-2".',
            fields: [{ field: "slug", code: "SLUG_CONFLICT", message: "Slug conflict" }],
            suggestedSlug: "promo-akhir-tahun-2",
            conflictKind: "active_resource",
          },
          requestId: "req_slug_conflict",
        });
      }

      const listKey = kind === "pages" ? "pagesTrash" : kind === "posts" ? "postsTrash" : "catalogTrash";
      const found = state[listKey].find((it) => it.resourceId === id);
      state[listKey] = state[listKey].filter((it) => it.resourceId !== id);

      const finalSlug = body.resolvedSlug || found?.slug || `item-${id}`;
      return sendJson(res, 200, {
        id,
        slug: finalSlug,
        title: found?.title || `Item ${id}`,
        status: "draft",
        slugChanged: Boolean(body.resolvedSlug && found && body.resolvedSlug !== found.slug),
        previousSlug: found?.slug || finalSlug,
        mediaReferences: found?.mediaReferences || {
          referencedMediaIds: [],
          validMediaIds: [],
          missingMediaIds: [],
          trashedMediaIds: [],
          unavailableMediaIds: [],
          warnings: [],
        },
      });
    }

    // Permanent Purge API
    const purgeMatch = p.match(/^\/api\/tenants\/[^/]+\/(pages|posts|catalog)\/(\d+)\/purge$/);
    if (purgeMatch && (method === "POST" || method === "DELETE")) {
      const kind = purgeMatch[1];
      const id = Number(purgeMatch[2]);
      const body = await readBody(req);
      state.purgeCalls += 1;

      if (body.confirmPermanentDelete !== true) {
        return sendJson(res, 422, {
          error: { code: "VALIDATION_ERROR", message: "Konfirmasi wajib dicentang." },
          requestId: "req_val",
        });
      }

      const listKey = kind === "pages" ? "pagesTrash" : kind === "posts" ? "postsTrash" : "catalogTrash";
      const found = state[listKey].find((it) => it.resourceId === id);
      if (found && found.protectedReferences.length > 0) {
        return sendJson(res, 409, {
          error: {
            code: "CONFLICT",
            message: "Konten tidak dapat dihapus permanen karena masih digunakan oleh referensi terlindungi.",
            fields: [{ field: "references", code: "PROTECTED_REFERENCE", message: "Protected reference" }],
            protectedReferences: found.protectedReferences,
          },
          requestId: "req_protected",
        });
      }

      state[listKey] = state[listKey].filter((it) => it.resourceId !== id);
      return sendJson(res, 200, {
        purged: true,
        resourceType: kind === "pages" ? "page" : kind === "posts" ? "post" : "offering",
        resourceId: id,
        clearedCounts: { taxonomies: 1, resourceSlugs: 2, revisions: 1 },
        preservedMediaIds: found?.mediaReferences?.referencedMediaIds || [],
        purgedAt: new Date().toISOString(),
      });
    }

    // Static files
    let filePath = path.join(outDir, p);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function checkNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `Horizontal overflow on ${label}: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildTrashFixtures();
  const server = await startStaticAndApiServer(outDir);
  let browser;

  try {
    const executablePath = findChromeExecutable();
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
      if (msg.type() === "error") {
        const text = msg.text();
        // Deliberately induced 409 conflict & 503 retryable error tests
        if (
          text.includes("status of 409 (Conflict)") ||
          text.includes("status of 503 (Service Unavailable)")
        ) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // =========================================================================
    // 1. PAGES TRASH @ 1440x900: Ready view, 409 slug conflict recovery,
    //    media warning restore, 409 protected-reference purge block,
    //    409 stale-version recovery, retryable error, permanent purge
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/pages-trash/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="content-trash-screen"]');
    await checkNoHorizontalOverflow(page, "pages-trash @ 1440x900");

    // Capture desktop 1440px screenshot of ready state (with protected ref & media warning badges)
    await page.screenshot({
      path: path.join(screenshotDir, "pages-trash-1440.png"),
      fullPage: true,
    });

    // Keyboard navigation: focus search, type non-matching filter -> empty-filtered + Reset Filter
    await page.locator('[data-testid="trash-search-input"]').fill("tidak-ditemukan-xyz");
    await page.waitForSelector('[data-state-panel="empty-filtered"]');
    await page.locator('[data-testid="trash-reset-filter-btn"]').click();
    await page.waitForSelector('[data-testid="trash-row-11"]');

    // 409 Slug Conflict -> opens Base UI dialog with suggestedSlug, Escape closes cleanly, retry succeeds with media warning!
    await page.locator('[data-testid="trash-restore-11"]').click();
    await page.waitForSelector('[data-testid="slug-conflict-dialog"]');
    const suggestedVal = await page.locator('[data-testid="slug-conflict-input"]').inputValue();
    assert(
      suggestedVal === "promo-akhir-tahun-2",
      `Expected suggestedSlug "promo-akhir-tahun-2", got "${suggestedVal}"`,
    );

    // Screenshot of 409 Slug Conflict Recovery Dialog @ 1440x900
    await page.screenshot({
      path: path.join(screenshotDir, "pages-trash-slug-conflict-1440.png"),
      fullPage: true,
    });

    // Escape closes dialog cleanly (WCAG keyboard accessibility)
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-testid="slug-conflict-dialog"]') === null);

    // Re-trigger conflict? First conflict already flipped flag; force conflict again and confirm with alternate slug
    server.state.forceFirstSlugConflictFor11 = true;
    await page.locator('[data-testid="trash-restore-11"]').click();
    await page.waitForSelector('[data-testid="slug-conflict-dialog"]');
    await page.locator('[data-testid="slug-conflict-confirm"]').click();
    await page.waitForSelector('[data-testid="trash-feedback-alert"][data-feedback-tone="warning"]');
    const warningText = await page.locator('[data-testid="trash-feedback-alert"]').textContent();
    assert(
      warningText && warningText.includes("Media #401"),
      `Expected media warning after restore, got: ${warningText}`,
    );

    // 409 Protected-Reference Block on permanent purge of page #12
    await page.locator('[data-testid="trash-purge-12"]').click();
    await page.waitForSelector('[data-testid="permanent-purge-dialog"]');
    await page.waitForSelector('[data-testid="purge-dialog-protected-warning"]');
    assert(
      await page.locator('[data-testid="permanent-purge-confirm"]').isDisabled(),
      "Permanent purge confirm MUST stay disabled until checkbox is checked",
    );
    await page.locator('[data-testid="permanent-purge-checkbox"]').check();
    await page.locator('[data-testid="permanent-purge-confirm"]').click();
    await page.waitForSelector('[data-testid="trash-feedback-alert"][data-feedback-tone="destructive"]');
    const protectedText = await page.locator('[data-testid="trash-feedback-alert"]').textContent();
    assert(
      protectedText && protectedText.includes("referensi terlindungi"),
      `Expected protected-reference 409 alert, got: ${protectedText}`,
    );

    // 409 Stale-Version Conflict on restore -> banner + Reload latest
    server.state.forceNextRestoreStale = true;
    await page.locator('[data-testid="trash-restore-13"]').click();
    await page.waitForSelector('[data-testid="stale-conflict-banner"]');
    await page.locator('[data-testid="stale-conflict-reload-btn"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="stale-conflict-banner"]') === null);

    // Permanent purge of clean item #13 succeeds cleanly
    await page.locator('[data-testid="trash-purge-13"]').click();
    await page.waitForSelector('[data-testid="permanent-purge-dialog"]');
    await page.locator('[data-testid="permanent-purge-checkbox"]').check();
    await page.locator('[data-testid="permanent-purge-confirm"]').click();
    await page.waitForSelector('[data-testid="trash-feedback-alert"][data-feedback-tone="success"]');

    // Retryable error state on refresh
    server.state.failNextTrashLoad = true;
    await page.locator('[data-testid="trash-refresh-btn"]').click();
    await page.waitForSelector('[data-testid="trash-error-banner"]');
    await page.locator('[data-testid="trash-retry-btn"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="trash-error-banner"]') === null);

    // =========================================================================
    // 2. POSTS TRASH (EDITOR RBAC) @ 768x1024: Editor can restore, purge disabled
    // =========================================================================
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${server.baseUrl}/posts-trash-editor/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="trash-editor-notice"]');
    await checkNoHorizontalOverflow(page, "posts-trash-editor @ 768x1024");
    assert(
      !(await page.locator('[data-testid="trash-restore-21"]').isDisabled()),
      "Editor MUST be able to restore trashed post",
    );
    assert(
      await page.locator('[data-testid="trash-purge-21"]').isDisabled(),
      "Editor MUST NOT be able to permanently purge trashed post",
    );
    await page.screenshot({
      path: path.join(screenshotDir, "posts-trash-editor-768.png"),
      fullPage: true,
    });

    // =========================================================================
    // 3. CATALOG TRASH @ 360x800 (Mobile stacked cards, >=44px targets, zero overflow)
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/catalog-trash/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="trash-mobile-card-31"]');
    await checkNoHorizontalOverflow(page, "catalog-trash @ 360x800");

    const restoreBtnHeight = await page
      .locator('[data-testid="trash-mobile-restore-31"]')
      .evaluate((el) => el.getBoundingClientRect().height);
    assert(restoreBtnHeight >= 44, `Mobile restore button height must be >=44px, got ${restoreBtnHeight}`);

    await page.screenshot({
      path: path.join(screenshotDir, "catalog-trash-360.png"),
      fullPage: true,
    });

    // =========================================================================
    // 4. CATALOG TRASH LOCKED STATE @ 360x800 & EMPTY STATE @ 1440x900
    // =========================================================================
    await page.goto(`${server.baseUrl}/catalog-trash-locked/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="cms-locked-banner"]');
    await checkNoHorizontalOverflow(page, "catalog-trash-locked @ 360x800");
    assert(
      await page.locator('[data-testid="trash-mobile-restore-31"]').isDisabled(),
      "Locked tenant MUST disable restore button",
    );
    assert(
      await page.locator('[data-testid="trash-mobile-purge-31"]').isDisabled(),
      "Locked tenant MUST disable permanent purge button",
    );
    await page.screenshot({
      path: path.join(screenshotDir, "catalog-trash-locked-360.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/pages-trash-empty/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-state-panel="empty-trash"]');
    await checkNoHorizontalOverflow(page, "pages-trash-empty @ 1440x900");

    assert(consoleErrors.length === 0, `Unexpected console errors: ${JSON.stringify(consoleErrors)}`);
    assert(pageErrors.length === 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);

    console.log(
      JSON.stringify({
        ok: true,
        screenshots: [
          path.join(screenshotDir, "pages-trash-1440.png"),
          path.join(screenshotDir, "pages-trash-slug-conflict-1440.png"),
          path.join(screenshotDir, "posts-trash-editor-768.png"),
          path.join(screenshotDir, "catalog-trash-360.png"),
          path.join(screenshotDir, "catalog-trash-locked-360.png"),
        ],
        restoreCalls: server.state.restoreCalls,
        purgeCalls: server.state.purgeCalls,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
