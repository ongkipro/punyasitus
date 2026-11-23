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

const screenshotDir = process.env.TASK033_SCREENSHOT_DIR || "";

// Genuine 32x32 ISO BMFF AVIF (AV1 still-picture, 315 bytes) decoded natively by Chromium
const VALID_AVIF_BASE64 =
  "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAaAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAgAAAAIAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAibWRhdAoGGBE/9sAgMhAYAAAAUAAAAALl1yqyp1dK";

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

async function buildRealCmsAdminFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t033-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const pagesListImport = path.join(webDir, "src/pages/dashboard/[handle]/pages/_PagesListClient.tsx");
  const pageEditorImport = path.join(webDir, "src/pages/dashboard/[handle]/pages/_PageEditorClient.tsx");
  const postEditorImport = path.join(webDir, "src/pages/dashboard/[handle]/posts/_PostEditorClient.tsx");
  const catalogListImport = path.join(webDir, "src/pages/dashboard/[handle]/catalog/_CatalogListClient.tsx");
  const offeringEditorImport = path.join(webDir, "src/pages/dashboard/[handle]/catalog/_OfferingEditorClient.tsx");
  const menusManagerImport = path.join(webDir, "src/pages/dashboard/[handle]/menus/_MenusManagerClient.tsx");
  const mediaManagerImport = path.join(webDir, "src/components/admin/media/MediaLibraryManager.tsx");
  const identityImport = path.join(webDir, "src/pages/dashboard/[handle]/settings/identity/_IdentitySettingsClient.tsx");

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

  const editorPermissions = `{
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
  }`;

  const layoutProps = (title, activeNavId) => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId=${JSON.stringify(activeNavId)}
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus="active"
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 1. Pages List
  fs.writeFileSync(
    path.join(pagesDir, "pages-list.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PagesListClient } from ${JSON.stringify(pagesListImport)};
---
<DashboardLayout ${layoutProps("Halaman — PT Nusantara Arsitek", "pages")}>
  <PagesListClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialItems={[
      {
        id: 1,
        slug: "beranda",
        title: "Beranda Utama",
        status: "published",
        isHomepage: true,
        layoutMode: "standard",
        hasUnpublishedChanges: false,
        version: 2,
        updatedAt: "2026-11-22T10:00:00.000Z",
        publishedAt: "2026-11-22T10:00:00.000Z",
      },
      {
        id: 2,
        slug: "tentang-kami",
        title: "Tentang Perusahaan",
        status: "draft",
        isHomepage: false,
        layoutMode: "focused",
        hasUnpublishedChanges: true,
        version: 1,
        updatedAt: "2026-11-22T11:00:00.000Z",
        publishedAt: null,
      },
    ]}
    initialNextCursor={null}
    initialHasMore={false}
  />
</DashboardLayout>`,
  );

  // 2. Page Editor
  fs.writeFileSync(
    path.join(pagesDir, "page-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PageEditorClient } from ${JSON.stringify(pageEditorImport)};
---
<DashboardLayout ${layoutProps("Halaman Baru — PT Nusantara Arsitek", "pages")}>
  <PageEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialPage={{
      id: null,
      title: "",
      slug: "",
      status: "draft",
      isHomepage: false,
      layoutMode: "standard",
      sections: [],
      hasUnpublishedChanges: true,
      version: 0,
    }}
  />
</DashboardLayout>`,
  );

  // 3. Post Editor (with TipTap MIT island)
  fs.writeFileSync(
    path.join(pagesDir, "post-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { PostEditorClient } from ${JSON.stringify(postEditorImport)};
---
<DashboardLayout ${layoutProps("Tulis Artikel Baru — PT Nusantara Arsitek", "articles")}>
  <PostEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialPost={{
      id: null,
      title: "",
      slug: "",
      excerpt: "",
      body: { schemaVersion: 1, blocks: [] },
      status: "draft",
      featuredMediaId: null,
      primaryCategoryId: null,
      categoryIds: [],
      tagIds: [],
      enableToc: true,
      hasUnpublishedChanges: true,
      version: 0,
    }}
    categories={[{ id: 10, name: "Panduan Bisnis", slug: "panduan-bisnis" }]}
    tags={[{ id: 20, name: "Arsitektur", slug: "arsitektur" }]}
  />
</DashboardLayout>`,
  );

  // 4. Catalog List
  fs.writeFileSync(
    path.join(pagesDir, "catalog-list.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { CatalogListClient } from ${JSON.stringify(catalogListImport)};
---
<DashboardLayout ${layoutProps("Katalog Layanan — PT Nusantara Arsitek", "offering")}>
  <CatalogListClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    permissions={${ownerPermissions}}
    initialItems={[
      {
        id: 5,
        offeringType: "service",
        slug: "audit-desain-kantor",
        publicPath: "/layanan/audit-desain-kantor",
        title: "Audit & Desain Kantor B2B",
        status: "published",
        priceMode: "from",
        price: 15000000,
        priceMax: null,
        negotiable: true,
        ctaMode: "whatsapp",
        unitStatus: null,
        version: 3,
        updatedAt: "2026-11-22T09:00:00.000Z",
      },
      {
        id: 6,
        offeringType: "vehicle",
        slug: "toyota-innova-zenix-2024",
        publicPath: "/kendaraan/toyota-innova-zenix-2024",
        title: "Toyota Innova Zenix Hybrid 2024",
        status: "draft",
        priceMode: "fixed",
        price: 475000000,
        priceMax: null,
        negotiable: false,
        ctaMode: "whatsapp",
        unitStatus: "available",
        version: 1,
        updatedAt: "2026-11-22T10:30:00.000Z",
      },
    ]}
    initialNextCursor={null}
    initialHasMore={false}
  />
</DashboardLayout>`,
  );

  // 5. Offering Editor
  fs.writeFileSync(
    path.join(pagesDir, "offering-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { OfferingEditorClient } from ${JSON.stringify(offeringEditorImport)};
---
<DashboardLayout ${layoutProps("Tambah Penawaran — PT Nusantara Arsitek", "offering")}>
  <OfferingEditorClient
    client:only="react"
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialOffering={{
      id: null,
      offeringType: "service",
      title: "",
      slug: "",
      summary: "",
      description: { schemaVersion: 1, blocks: [] },
      coverMediaId: null,
      galleryMediaIds: [],
      youtubeVideoId: "",
      priceMode: "range",
      price: null,
      priceMax: null,
      negotiable: false,
      originalAmount: null,
      badge: "",
      ctaMode: "whatsapp",
      ctaLabel: "",
      externalUrl: "",
      whatsappOverride: "",
      whatsappTemplate: "",
      unitStatus: "available",
      attributes: {},
      status: "draft",
      version: 0,
    }}
  />
</DashboardLayout>`,
  );

  // 6. Menus Manager
  fs.writeFileSync(
    path.join(pagesDir, "menus.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { MenusManagerClient } from ${JSON.stringify(menusManagerImport)};
---
<DashboardLayout ${layoutProps("Menu Navigasi — PT Nusantara Arsitek", "settings")}>
  <MenusManagerClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialMenus={{
      header: {
        location: "header",
        version: 1,
        flatItems: [
          {
            id: "nav-home",
            parentId: null,
            label: "Beranda",
            href: "/",
            openInNewTab: false,
            targetType: "custom",
            targetResourceId: null,
          },
        ],
      },
      footer: { location: "footer", version: 1, flatItems: [] },
      mobile: { location: "mobile", version: 1, flatItems: [] },
    }}
    pageOptions={[{ id: 1, title: "Tentang Kami", href: "/tentang-kami" }]}
  />
</DashboardLayout>`,
  );

  // 7. Media Library
  fs.writeFileSync(
    path.join(pagesDir, "media.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { MediaLibraryManager } from ${JSON.stringify(mediaManagerImport)};
---
<DashboardLayout ${layoutProps("Pustaka Media — PT Nusantara Arsitek", "media")}>
  <MediaLibraryManager
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialItems={[
      {
        id: 101,
        kind: "image",
        status: "ready",
        alt: "Fasad Gedung Nusantara",
        normalizedBytes: 184320,
        width: 1600,
        height: 1000,
        publicUrl: null,
        version: 1,
        createdAt: "2026-11-22T08:00:00.000Z",
      },
    ]}
    initialNextCursor={null}
    initialHasMore={false}
    initialStorage={{
      usedBytes: 42_000_000,
      reservedBytes: 0,
      quotaBytes: 104_857_600,
      availableBytes: 62_857_600,
      percentUsed: 40,
      warningAt80: false,
    }}
  />
</DashboardLayout>`,
  );

  // 8. Identity Settings (Owner) & (Editor RBAC denied)
  fs.writeFileSync(
    path.join(pagesDir, "identity-owner.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { IdentitySettingsClient } from ${JSON.stringify(identityImport)};
---
<DashboardLayout ${layoutProps("Identitas Situs — PT Nusantara Arsitek", "settings")}>
  <IdentitySettingsClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${ownerPermissions}}
    initialIdentity={{
      siteTitle: "PT Nusantara Arsitek",
      tagline: "Konsultan & Konstruksi B2B",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      logoMediaId: 101,
      faviconMediaId: null,
      businessName: "PT Nusantara Arsitek",
      businessCategory: "ProfessionalService",
      description: "Layanan desain interior dan renovasi perkantoran.",
      email: "halo@nusantara-arsitek.id",
      phone: "62215550199",
      whatsappE164: "6281234567890",
      address: "Jl. Jenderal Sudirman No. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12190",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      holidayHours: "Sabtu–Minggu Tutup",
      hasUnpublishedChanges: false,
      version: 1,
    }}
  />
</DashboardLayout>`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "identity-editor.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { IdentitySettingsClient } from ${JSON.stringify(identityImport)};
---
<DashboardLayout ${layoutProps("Identitas Situs — PT Nusantara Arsitek", "settings")}>
  <IdentitySettingsClient
    client:load
    handle="alpha-studio"
    basePath="/dashboard/alpha-studio"
    permissions={${editorPermissions}}
    initialIdentity={{
      siteTitle: "PT Nusantara Arsitek",
      tagline: "Konsultan & Konstruksi B2B",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      logoMediaId: 101,
      faviconMediaId: null,
      businessName: "PT Nusantara Arsitek",
      businessCategory: "ProfessionalService",
      description: "Layanan desain interior dan renovasi perkantoran.",
      email: "halo@nusantara-arsitek.id",
      phone: "62215550199",
      whatsappE164: "6281234567890",
      address: "Jl. Jenderal Sudirman No. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12190",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      holidayHours: "Sabtu–Minggu Tutup",
      hasUnpublishedChanges: false,
      version: 1,
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

async function startCmsFixtureServer(outDir) {
  const state = {
    pages: [
      {
        id: 1,
        slug: "beranda",
        title: "Beranda Utama",
        status: "published",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
        hasUnpublishedChanges: false,
        version: 2,
        updatedAt: "2026-11-22T10:00:00.000Z",
        publishedAt: "2026-11-22T10:00:00.000Z",
      },
      {
        id: 2,
        slug: "tentang-kami",
        title: "Tentang Perusahaan",
        status: "draft",
        isHomepage: false,
        layoutMode: "focused",
        sections: [],
        hasUnpublishedChanges: true,
        version: 1,
        updatedAt: "2026-11-22T11:00:00.000Z",
        publishedAt: null,
      },
    ],
    pageDeleteHits: 0,
    forceNextPageConflict: false,
    lastPostPayload: null,
    lastOfferingPayload: null,
    lastMenuPayload: null,
    mediaItems: [
      {
        id: 101,
        kind: "image",
        status: "ready",
        alt: "Fasad Gedung Nusantara",
        normalizedBytes: 184320,
        width: 1600,
        height: 1000,
        publicUrl: null,
        version: 1,
        createdAt: "2026-11-22T08:00:00.000Z",
      },
    ],
    uploadIntents: [],
    uploadedBinaries: [],
    identityVersion: 1,
    identityPublished: false,
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

    // --- Pages API ---
    if (url.pathname === "/api/tenants/alpha-studio/pages") {
      if (method === "GET") {
        return json(200, {
          items: state.pages.filter((p) => p.status !== "trashed"),
          page: { nextCursor: null, limit: 20, hasMore: false },
        });
      }
      if (method === "POST") {
        const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
        const created = {
          id: 10,
          slug: body.slug || "halaman-baru",
          title: body.title,
          status: "draft",
          isHomepage: Boolean(body.isHomepage),
          layoutMode: body.layoutMode || "standard",
          sections: body.sections || [],
          hasUnpublishedChanges: true,
          version: 1,
          updatedAt: new Date().toISOString(),
          publishedAt: null,
        };
        state.pages.push(created);
        return json(201, created);
      }
    }

    const pageItemMatch = /^\/api\/tenants\/alpha-studio\/pages\/(\d+)$/.exec(url.pathname);
    if (pageItemMatch) {
      const id = Number(pageItemMatch[1]);
      const found = state.pages.find((p) => p.id === id);
      if (method === "GET") {
        return found ? json(200, found) : json(404, { error: { code: "NOT_FOUND", message: "Tidak ditemukan" } });
      }
      if (method === "PATCH") {
        if (state.forceNextPageConflict) {
          state.forceNextPageConflict = false;
          if (found) {
            found.version += 1;
            found.title = `${found.title} (Versi Rekan Tim)`;
          }
          return json(409, {
            error: {
              code: "STALE_VERSION",
              message: "Halaman telah diperbarui di sesi lain (409). Muat ulang versi terbaru.",
            },
            requestId: "req_t033conflict409",
          });
        }
        const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
        if (found) {
          found.title = body.title ?? found.title;
          found.slug = body.slug ?? found.slug;
          found.layoutMode = body.layoutMode ?? found.layoutMode;
          found.sections = body.sections ?? found.sections;
          found.version += 1;
          return json(200, found);
        }
        return json(404, { error: { code: "NOT_FOUND", message: "Tidak ditemukan" } });
      }
      if (method === "DELETE") {
        state.pageDeleteHits += 1;
        if (found) found.status = "trashed";
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const pagePublishMatch = /^\/api\/tenants\/alpha-studio\/pages\/(\d+)\/(publish|unpublish)$/.exec(url.pathname);
    if (pagePublishMatch && method === "POST") {
      const id = Number(pagePublishMatch[1]);
      const action = pagePublishMatch[2];
      const found = state.pages.find((p) => p.id === id);
      if (!found) return json(404, { error: { code: "NOT_FOUND", message: "Tidak ditemukan" } });
      found.status = action === "publish" ? "published" : "draft";
      found.hasUnpublishedChanges = action !== "publish";
      found.version += 1;
      return json(200, found);
    }

    // --- Posts API ---
    if (url.pathname === "/api/tenants/alpha-studio/posts" && method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.lastPostPayload = body;
      return json(201, {
        id: 21,
        slug: body.slug || "artikel-baru",
        title: body.title,
        excerpt: body.excerpt ?? null,
        body: body.body,
        status: "draft",
        featuredMediaId: body.featuredMediaId ?? null,
        primaryCategoryId: body.primaryCategoryId ?? null,
        categoryIds: body.categoryIds ?? [],
        tagIds: body.tagIds ?? [],
        enableToc: Boolean(body.enableToc),
        hasUnpublishedChanges: true,
        version: 1,
      });
    }

    // --- Catalog API ---
    if (url.pathname === "/api/tenants/alpha-studio/catalog" && method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.lastOfferingPayload = body;
      return json(201, {
        id: 31,
        slug: body.slug || "penawaran-baru",
        status: "draft",
        version: 1,
      });
    }
    const offeringPublishMatch = /^\/api\/tenants\/alpha-studio\/catalog\/(\d+)\/publish$/.exec(url.pathname);
    if (offeringPublishMatch && method === "POST") {
      return json(200, { id: Number(offeringPublishMatch[1]), status: "published", version: 2 });
    }

    // --- Menus API ---
    const menuMatch = /^\/api\/tenants\/alpha-studio\/menus\/(header|footer|mobile)$/.exec(url.pathname);
    if (menuMatch && method === "PUT") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.lastMenuPayload = body;
      return json(200, {
        location: menuMatch[1],
        flatItems: body.items.map((it) => ({
          id: it.id,
          parentId: it.parentId ?? null,
          label: it.label,
          href: it.href,
          openInNewTab: Boolean(it.openInNewTab),
          targetType: it.targetType || "custom",
          targetResourceId: it.targetResourceId ?? null,
        })),
        version: Number(body.version || 1) + 1,
      });
    }

    // --- Media API ---
    if (url.pathname === "/api/tenants/alpha-studio/media" && method === "GET") {
      return json(200, {
        items: state.mediaItems,
        page: { nextCursor: null, limit: 24, hasMore: false },
        storage: {
          usedBytes: 42_000_000,
          reservedBytes: 0,
          quotaBytes: 104_857_600,
          availableBytes: 62_857_600,
          percentUsed: 40,
          warningAt80: false,
        },
      });
    }
    if (url.pathname === "/api/tenants/alpha-studio/media/upload-intent" && method === "POST") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.uploadIntents.push(body);
      // Authoritative server check: reject SVG/BMP/AVIF!
      if (
        body.mimeType === "image/svg+xml" ||
        body.mimeType === "image/bmp" ||
        body.mimeType === "image/avif"
      ) {
        return json(415, {
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: `Format "${body.mimeType}" ditolak oleh validasi server (hanya JPG, PNG, WebP, HEIC, GIF, TIFF).`,
          },
          requestId: "req_t033svg415",
        });
      }
      const intentId = `01JT033INTENT0000000000${state.uploadIntents.length}`;
      return json(201, {
        intentId,
        uploadPath: `/api/tenants/alpha-studio/media/upload/${intentId}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        reservedBytes: body.declaredBytes,
        quotaUsedBytes: 42_000_000 + body.declaredBytes,
        quotaLimitBytes: 104_857_600,
      });
    }
    const uploadStreamMatch = /^\/api\/tenants\/alpha-studio\/media\/upload\/([^/]+)$/.exec(url.pathname);
    if (uploadStreamMatch && (method === "PUT" || method === "POST")) {
      const buf = await readBodyBuffer(req);
      const contentType = req.headers["content-type"] || "";
      state.uploadedBinaries.push({
        intentId: uploadStreamMatch[1],
        contentType,
        byteLength: buf.byteLength,
        magicHex: buf.subarray(0, 12).toString("hex"),
      });
      const nextId = 101 + state.uploadedBinaries.length;
      state.mediaItems.unshift({
        id: nextId,
        kind: "image",
        status: "processing",
        alt: `Unggahan #${nextId}`,
        normalizedBytes: buf.byteLength,
        width: null,
        height: null,
        publicUrl: null,
        version: 1,
        createdAt: new Date().toISOString(),
      });
      return json(202, {
        mediaId: nextId,
        intentId: uploadStreamMatch[1],
        status: "processing",
      });
    }

    // --- Identity API ---
    if (url.pathname === "/api/tenants/alpha-studio/identity" && method === "PATCH") {
      const body = JSON.parse((await readBodyBuffer(req)).toString("utf8"));
      state.identityVersion += 1;
      return json(200, {
        siteSettings: {
          siteTitle: body.siteSettings?.siteTitle || "PT Nusantara Arsitek",
          tagline: body.siteSettings?.tagline ?? null,
          timezone: body.siteSettings?.timezone || "Asia/Jakarta",
          locale: "id-ID",
          logoMediaId: body.siteSettings?.logoMediaId ?? null,
          faviconMediaId: body.siteSettings?.faviconMediaId ?? null,
        },
        businessProfile: {
          businessName: body.businessProfile?.businessName || "PT Nusantara Arsitek",
          businessCategory: body.businessProfile?.businessCategory || "ProfessionalService",
          description: body.businessProfile?.description ?? null,
          email: body.businessProfile?.email ?? null,
          phone: body.businessProfile?.phone ?? null,
          whatsappE164: body.businessProfile?.whatsappE164 ?? null,
          address: body.businessProfile?.address ?? null,
          city: body.businessProfile?.city ?? null,
          province: body.businessProfile?.province ?? null,
          postalCode: body.businessProfile?.postalCode ?? null,
          mapsUrl: body.businessProfile?.mapsUrl ?? null,
          weekdayHours: body.businessProfile?.weekdayHours ?? null,
          holidayHours: body.businessProfile?.holidayHours ?? null,
        },
        version: state.identityVersion,
        hasUnpublishedChanges: true,
      });
    }
    if (url.pathname === "/api/tenants/alpha-studio/identity/publish" && method === "POST") {
      state.identityVersion += 1;
      state.identityPublished = true;
      return json(200, {
        version: state.identityVersion,
        hasUnpublishedChanges: false,
      });
    }

    // Static built Astro fixture files
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
      "Cache-Control": "no-store",
    });
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
  const fixtures = await buildRealCmsAdminFixtures();
  const server = await startCmsFixtureServer(fixtures.outDir);
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Deliberately induced test responses: 409 stale-write conflict & 415 SVG rejection
        if (
          text.includes("status of 409 (Conflict)") ||
          text.includes("status of 415 (Unsupported Media Type)")
        ) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // =========================================================================
    // 1. PAGES LIST: Destructive confirmation dialog (cancel preserves, confirm deletes)
    // =========================================================================
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/pages-list/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="pages-list-screen"]');
    await checkNoHorizontalOverflow(page, "pages-list @ 1440px");

    await page.locator('[data-testid="page-trash-2"]').click();
    await page.waitForSelector('[data-testid="confirm-destructive-dialog"]');
    await page.locator('[data-testid="confirm-destructive-cancel"]').click();
    assert(server.state.pageDeleteHits === 0, "Cancel in destructive dialog must NOT delete item");
    assert(await page.locator('[data-testid="page-row-2"]').isVisible(), "Row 2 must still be visible after cancel");

    await page.locator('[data-testid="page-trash-2"]').click();
    await page.waitForSelector('[data-testid="confirm-destructive-dialog"]');
    await page.locator('[data-testid="confirm-destructive-confirm"]').click();
    await page.waitForSelector('[data-testid="pages-list-feedback"]');
    assert(server.state.pageDeleteHits === 1, "Confirm in destructive dialog must send DELETE");

    // =========================================================================
    // 2. PAGE EDITOR: Dirty state, add/reorder section, save, preview, publish, 409 recovery
    // =========================================================================
    await page.goto(`${server.baseUrl}/page-editor/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="page-editor-screen"]');
    await page.locator('[data-testid="page-title-input"]').fill("Layanan Konsultasi Arsitektur");
    await page.waitForSelector('[data-testid="dirty-indicator"]');
    await page.locator('[data-testid="page-layout-select"]').selectOption("focused");
    await page.locator('[data-testid="page-add-section-btn"]').click();
    await page.locator('[data-testid="page-new-section-kind"]').selectOption("cta_band");
    await page.locator('[data-testid="page-add-section-btn"]').click();
    // Keyboard reorder section #2 up to #1
    await page.locator('[data-testid="page-section-up-1"]').click();

    await page.locator('[data-testid="page-save-btn"]').click();
    await page.waitForSelector('[data-testid="page-editor-feedback"]');
    const previewHref = await page.locator('[data-testid="page-preview-link"]').getAttribute("href");
    assert(
      previewHref && previewHref.includes("/dashboard/alpha-studio/preview?kind=page&id=10"),
      `Page preview link mismatch: ${previewHref}`,
    );

    // Publish
    await page.locator('[data-testid="page-publish-btn"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="page-version-badge"]')?.textContent?.includes("v2"),
    );

    // Trigger 409 Stale-Write Conflict -> verify recovery banner & reload!
    server.state.forceNextPageConflict = true;
    await page.locator('[data-testid="page-title-input"]').fill("Judul Bentrok");
    await page.locator('[data-testid="page-save-btn"]').click();
    await page.waitForSelector('[data-testid="stale-conflict-banner"]');
    await page.locator('[data-testid="stale-conflict-reload-btn"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="stale-conflict-banner"]') === null,
    );
    const reloadedTitle = await page.locator('[data-testid="page-title-input"]').inputValue();
    assert(
      reloadedTitle.includes("(Versi Rekan Tim)"),
      `Reload after 409 must load server's latest title, got "${reloadedTitle}"`,
    );

    // =========================================================================
    // 3. POST EDITOR: Real TipTap MIT core island, unsafe URL rejection, save + 1440px screenshot
    // =========================================================================
    await page.goto(`${server.baseUrl}/post-editor/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="post-richtext-editor"]');
    await checkNoHorizontalOverflow(page, "post-editor @ 1440px");

    const editorMeta = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="post-richtext-editor"]');
      return {
        lib: el?.getAttribute("data-editor-library"),
        license: el?.getAttribute("data-editor-license"),
        schemaVersion: el?.getAttribute("data-editor-schema-version"),
      };
    });
    assert(editorMeta.lib === "@tiptap/react", `Expected @tiptap/react, got ${editorMeta.lib}`);
    assert(editorMeta.license === "MIT", `Expected MIT license, got ${editorMeta.license}`);
    assert(editorMeta.schemaVersion === "1", `Expected schemaVersion 1, got ${editorMeta.schemaVersion}`);

    await page.locator('[data-testid="post-title-input"]').fill("Tips Renovasi Kantor Hemat Energi");
    await page.locator('[data-testid="post-excerpt-input"]').fill("Langkah praktis memilih material dan pencahayaan kantor B2B.");

    // Interact with real TipTap contenteditable
    const tiptapBox = page.locator('[data-testid="post-richtext-editor-content"]');
    await tiptapBox.click();
    await page.locator('[data-testid="post-richtext-editor-btn-h2"]').click();
    await page.keyboard.type("Perencanaan Tata Ruang");
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="post-richtext-editor-btn-bold"]').click();
    await page.keyboard.type("Pencahayaan alami mengurangi biaya listrik.");

    // Reject javascript: link inline in TipTap link panel
    await page.locator('[data-testid="post-richtext-editor-btn-link"]').click();
    await page.locator('[data-testid="post-richtext-editor-link-input"]').fill("javascript:alert(1)");
    await page.locator('[data-testid="post-richtext-editor-link-apply"]').click();
    const linkErrVisible = await page.locator('[data-testid="post-richtext-editor-link-panel"] [role="alert"]').isVisible();
    assert(linkErrVisible, "TipTap link panel MUST reject javascript: URL with inline error");

    // Apply valid HTTPS link
    await page.locator('[data-testid="post-richtext-editor-link-input"]').fill("https://punyasitus.com/panduan");
    await page.locator('[data-testid="post-richtext-editor-link-apply"]').click();

    await page.locator('[data-testid="post-save-btn"]').click();
    await page.waitForSelector('[data-testid="post-editor-feedback"]');
    assert(
      server.state.lastPostPayload?.body?.schemaVersion === 1 &&
        Array.isArray(server.state.lastPostPayload.body.blocks) &&
        server.state.lastPostPayload.body.blocks.length >= 2,
      `Expected RestrictedRichTextDoc v1 blocks saved, got ${JSON.stringify(server.state.lastPostPayload)}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "post-editor-tiptap-1440.png"),
        fullPage: true,
      });
    }

    // =========================================================================
    // 4. MEDIA LIBRARY: Real Chromium Canvas AVIF->WebP conversion, >2560px downscale, SVG server reject + 1440px screenshot
    // =========================================================================
    await page.goto(`${server.baseUrl}/media/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="media-library-screen"]');
    await checkNoHorizontalOverflow(page, "media-library @ 1440px");

    // 4a. Upload real 32x32 AVIF file -> client converts via Canvas to WebP/PNG BEFORE upload-intent!
    const avifBuffer = Buffer.from(VALID_AVIF_BASE64, "base64");
    await page.locator('[data-testid="media-upload-alt-input"]').fill("Foto Proyek AVIF");
    await page.locator('[data-testid="media-file-input"]').setInputFiles({
      name: "proyek-kantor.avif",
      mimeType: "image/avif",
      buffer: avifBuffer,
    });
    await page.waitForSelector('[data-testid="media-transform-summary"]');
    const avifSummary = await page.locator('[data-testid="media-transform-summary"]').textContent();
    assert(
      avifSummary && avifSummary.includes("AVIF dikonversi"),
      `Expected AVIF conversion summary, got "${avifSummary}"`,
    );
    const firstIntent = server.state.uploadIntents[0];
    assert(
      firstIntent && (firstIntent.mimeType === "image/webp" || firstIntent.mimeType === "image/png"),
      `AVIF must be converted to image/webp or image/png before upload-intent, got ${JSON.stringify(firstIntent)}`,
    );
    assert(
      firstIntent.filename.endsWith(".webp") || firstIntent.filename.endsWith(".png"),
      `Converted AVIF filename must end with .webp or .png, got ${firstIntent.filename}`,
    );

    // 4b. Generate real 3200x1800 PNG in Chromium canvas (> 2560px) -> verify downscale to 2560x1440!
    const oversizedPngB64 = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 3200;
      c.height = 1800;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#176b51";
      ctx.fillRect(0, 0, 3200, 1800);
      const dataUrl = c.toDataURL("image/png");
      return dataUrl.split(",")[1];
    });
    await page.locator('[data-testid="media-upload-alt-input"]').fill("Foto Kamera Besar 3200px");
    await page.locator('[data-testid="media-file-input"]').setInputFiles({
      name: "foto-hp-besar.png",
      mimeType: "image/png",
      buffer: Buffer.from(oversizedPngB64, "base64"),
    });
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="media-transform-summary"]')?.textContent?.includes("2560"),
    );
    const resizeSummary = await page.locator('[data-testid="media-transform-summary"]').textContent();
    assert(
      resizeSummary && resizeSummary.includes("2560×1440"),
      `Expected 3200x1800 -> 2560x1440 downscale summary, got "${resizeSummary}"`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "media-library-1440.png"),
        fullPage: true,
      });
    }

    // 4c. Server validation stays authoritative: upload SVG -> server returns 415 UNSUPPORTED_MEDIA_TYPE
    await page.locator('[data-testid="media-file-input"]').setInputFiles({
      name: "vektor-bahaya.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="media-upload-feedback"]')?.getAttribute("data-feedback-tone") === "destructive",
    );
    const svgErr = await page.locator('[data-testid="media-upload-feedback"]').textContent();
    assert(
      svgErr && svgErr.includes("UNSUPPORTED_MEDIA_TYPE"),
      `Expected authoritative server 415 UNSUPPORTED_MEDIA_TYPE for SVG, got "${svgErr}"`,
    );

    // =========================================================================
    // 5. CATALOG: 360px list screenshot + tap target check + Typed Offering create/save/publish
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/catalog-list/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="catalog-list-screen"]');
    await checkNoHorizontalOverflow(page, "catalog-list @ 360px");

    const newOfferingBtnBox = await page.locator('[data-testid="new-offering-btn"]').boundingBox();
    assert(
      newOfferingBtnBox && newOfferingBtnBox.height >= 44,
      `Primary CTA button at 360px must be >=44px tall, got ${newOfferingBtnBox?.height}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "catalog-list-360.png"),
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/offering-editor/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="offering-editor-screen"]');
    await page.locator('[data-testid="offering-title-input"]').fill("Paket Renovasi Ruang Meeting");
    await page.locator('[data-testid="offering-price-input"]').fill("25000000");
    await page.locator('[data-testid="offering-price-max-input"]').fill("45000000");
    await page.locator('[data-testid="offering-wa-override"]').fill("6281234567890");
    await page.locator('[data-testid="offering-save-btn"]').click();
    await page.waitForSelector('[data-testid="offering-editor-feedback"]');
    assert(server.state.lastOfferingPayload?.priceMode === "range", "Expected range priceMode");
    assert(server.state.lastOfferingPayload?.price === 25000000, "Expected price 25000000");
    assert(server.state.lastOfferingPayload?.priceMax === 45000000, "Expected priceMax 45000000");

    await page.locator('[data-testid="offering-publish-btn"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="offering-version-badge"]')?.textContent?.includes("v2"),
    );

    // =========================================================================
    // 6. MENUS: Add item, reject unsafe URL, keyboard Move Up reorder, save + 360px screenshot
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/menus/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="menus-manager-screen"]');
    await checkNoHorizontalOverflow(page, "menus @ 360px");

    await page.locator('[data-testid="menu-new-label"]').fill("Kontak Kami");
    await page.locator('[data-testid="menu-new-href"]').fill("/kontak");
    await page.locator('[data-testid="menu-add-item-btn"]').click();

    // Move "Kontak Kami" (index 1) up to index 0 via keyboard-accessible Move Up button
    await page.locator('[data-testid="menu-move-up-1"]').click();
    await page.locator('[data-testid="menu-save-publish-btn"]').click();
    await page.waitForSelector('[data-testid="menus-feedback"]');
    assert(
      server.state.lastMenuPayload?.items?.[0]?.label === "Kontak Kami",
      `Expected keyboard-reordered item first in payload, got ${JSON.stringify(server.state.lastMenuPayload)}`,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "menus-360.png"),
        fullPage: true,
      });
    }

    // =========================================================================
    // 7. SITE IDENTITY: Owner save & publish + Editor RBAC denial + 360px screenshot
    // =========================================================================
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${server.baseUrl}/identity-owner/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="identity-settings-screen"]');
    await checkNoHorizontalOverflow(page, "identity-owner @ 360px");

    await page.locator('[data-testid="identity-tagline"]').fill("Mitra Arsitektur B2B Terpercaya");
    await page.locator('[data-testid="identity-save-btn"]').click();
    await page.waitForSelector('[data-testid="identity-feedback"]');
    await page.locator('[data-testid="identity-publish-btn"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="identity-version-badge"]')?.textContent?.includes("v3"),
    );

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "identity-360.png"),
        fullPage: true,
      });
    }

    // Editor RBAC denial check
    await page.goto(`${server.baseUrl}/identity-editor/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="identity-rbac-notice"]');
    assert(
      await page.locator('[data-testid="identity-save-btn"]').isDisabled(),
      "Editor role must have Identity Save button disabled",
    );
    assert(
      await page.locator('[data-testid="identity-publish-btn"]').isDisabled(),
      "Editor role must have Identity Publish button disabled",
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      JSON.stringify({
        ok: true,
        task: "TASK-033",
        journeys: [
          "pages-list-destructive-confirm",
          "page-editor-sections-publish-409-recovery",
          "post-editor-tiptap-mit-restricted-json",
          "media-avif-to-webp-and-2560px-downscale-and-server-415",
          "catalog-typed-offering-pricing-publish",
          "menus-keyboard-reorder-publish",
          "identity-owner-publish-and-editor-rbac-deny",
        ],
        viewportsTested: [360, 1440],
        consoleErrors: 0,
        pageErrors: 0,
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
  console.error("TASK-033 E2E FAILED:", err);
  process.exit(1);
});
