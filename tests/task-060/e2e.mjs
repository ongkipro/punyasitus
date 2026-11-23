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

const screenshotDir = process.env.TASK060_SCREENSHOT_DIR || "/tmp/punyasitus-t060-screenshots";

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

function createFixtureMedia(publicMediaDir) {
  fs.mkdirSync(publicMediaDir, { recursive: true });

  // Valid lossless VP8L WebP poster (same structure as built-in WebP poster)
  const webpPoster = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
    0x18, 0x00, 0x00, 0x00, 0x2f, 0x3f, 0x10, 0x0e,
    0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88,
    0xfe, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  fs.writeFileSync(path.join(publicMediaDir, "profil-proyek-poster.webp"), webpPoster);
  fs.writeFileSync(path.join(publicMediaDir, "demo-lapangan-poster.webp"), webpPoster);

  // Clean SVG portfolio photo
  const photoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#173832"/>
  <rect x="48" y="48" width="1184" height="624" rx="20" fill="#1f5348" stroke="#34d399" stroke-opacity="0.35" stroke-width="2"/>
  <text x="96" y="340" fill="#ffffff" font-family="system-ui, sans-serif" font-size="48" font-weight="700">Dokumentasi Instalasi Pabrik</text>
  <text x="96" y="400" fill="#d1fae5" font-family="system-ui, sans-serif" font-size="26">Foto Portofolio WebP · Jakarta Selatan</text>
</svg>`;
  fs.writeFileSync(path.join(publicMediaDir, "portfolio-photo.svg"), photoSvg, "utf8");

  // Minimal placeholder MP4 & valid WebVTT files served locally (preload="none" ensures MP4 isn't fetched until Play)
  fs.writeFileSync(path.join(publicMediaDir, "profil-proyek.mp4"), Buffer.from("000000186674797069736f6d", "hex"));
  fs.writeFileSync(path.join(publicMediaDir, "demo-lapangan.mp4"), Buffer.from("000000186674797069736f6d", "hex"));
  fs.writeFileSync(
    path.join(publicMediaDir, "profil-proyek-captions.vtt"),
    "WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nRingkasan proses pengerjaan proyek klien kami.\n",
    "utf8",
  );
}

async function buildTask060Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t060-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const publicDir = path.join(tmpRoot, "public");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });
  createFixtureMedia(path.join(publicDir, "media/t/demo"));

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const videoImport = path.join(webDir, "src/themes/default/components/Video.astro");
  const portfolioImport = path.join(webDir, "src/themes/default/sections/SectionPortfolio.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const adminCssImport = path.join(webDir, "src/styles/admin/globals.css");
  const pickerImport = path.join(webDir, "src/components/admin/media/MediaPickerSheet.tsx");
  const blockEditorImport = path.join(
    webDir,
    "src/components/admin/editor/blocks/video/ShortVideoBlockEditor.tsx",
  );

  fs.writeFileSync(
    path.join(srcDir, "fixture-shell.ts"),
    `import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

export function buildShell() {
  const themeStyle = buildSafeThemeStyleBlock(null, "compro");
  return {
    isPreview: false,
    layoutMode: "standard" as const,
    themeId: "compro",
    baseThemeId: themeStyle.baseThemeId,
    themeStyle,
    site: {
      title: "PT Nusantara Prima",
      tagline: "Solusi Usaha Terpadu",
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public" as const,
      analyticsConfig: null,
    },
    business: {
      name: "PT Nusantara Prima",
      category: "LocalBusiness",
      description: "Dokumentasi proyek dan portofolio video pendek.",
      address: "Jl. Jenderal Sudirman No. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12190",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      holidayHours: "Sabtu–Minggu Tutup",
      phone: "6281234567890",
      whatsappE164: "6281234567890",
      email: "halo@nusantara-prima.id",
      socialLinks: [],
    },
    menus: {
      header: [{ label: "Portofolio", href: "/portfolio/", openInNewTab: false, children: [] }],
      footer: [{ label: "Portofolio", href: "/portfolio/", openInNewTab: false, children: [] }],
      mobile: [],
    },
    page: null,
    revisions: {
      siteSettingsVersion: 1,
      businessProfileVersion: 1,
      themeConfigVersion: 1,
      pageVersion: 1,
    },
  };
}
`,
    "utf8",
  );

  // 1. /portfolio/ — Real Video.astro + SectionPortfolio.astro + rejected Hero Video test
  fs.writeFileSync(
    path.join(pagesDir, "portfolio.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import Video from ${JSON.stringify(videoImport)};
import SectionPortfolio from ${JSON.stringify(portfolioImport)};
import { buildShell } from "../fixture-shell.ts";

const shell = buildShell();
const portfolioConfig = {
  eyebrow: "Portofolio Proyek",
  heading: "Video Singkat & Dokumentasi Lapangan",
  subheading: "Seluruh video MP4 menggunakan preload=none, poster WebP, dan tanpa autoplay.",
  columns: 3 as const,
  items: [
    {
      kind: "video" as const,
      src: "/media/t/demo/profil-proyek.mp4",
      posterUrl: "/media/t/demo/profil-proyek-poster.webp",
      width: 1280,
      height: 720,
      title: "Tur Ruang Produksi Jakarta",
      caption: "Cuplikan 20 detik fasilitas produksi dengan takarir Bahasa Indonesia.",
      captionsUrl: "/media/t/demo/profil-proyek-captions.vtt",
      captionsLang: "id",
      captionsLabel: "Bahasa Indonesia",
      durationSeconds: 20,
    },
    {
      kind: "image" as const,
      src: "/media/t/demo/portfolio-photo.svg",
      alt: "Dokumentasi instalasi klien",
      width: 1280,
      height: 720,
      title: "Instalasi Sistem Gudang",
      caption: "Foto WebP berdimensi tetap.",
    },
    {
      kind: "video" as const,
      src: "/media/t/demo/demo-lapangan.mp4",
      posterUrl: "/media/t/demo/demo-lapangan-poster.webp",
      width: 1280,
      height: 720,
      title: "Uji Operasional Lapangan",
      caption: "Video ringkas tanpa autoplay.",
      durationSeconds: 15,
    },
  ],
};
---

<Layout shell={shell} title="Portofolio Video — PT Nusantara Prima" canonicalPath="/portfolio/">
  <SectionPortfolio id="portofolio-utama" config={portfolioConfig} isFirstSection={true} />
  {/* Guardrail check: placement="hero" MUST render nothing */}
  <div data-testid="hero-video-rejection-slot">
    <Video
      src="/media/t/demo/profil-proyek.mp4"
      posterUrl="/media/t/demo/profil-proyek-poster.webp"
      width={1280}
      height={720}
      title="Video Hero Ditolak"
      placement="hero"
      testId="forbidden-hero-video"
    />
  </div>
</Layout>
`,
    "utf8",
  );

  // 2. React harness for MediaPickerSheet & ShortVideoBlockEditor states
  fs.writeFileSync(
    path.join(srcDir, "AdminVideoPickerHarness.tsx"),
    `import * as React from "react";
import { MediaPickerSheet, type MediaLibraryItemDto } from ${JSON.stringify(pickerImport)};
import { ShortVideoBlockEditor } from ${JSON.stringify(blockEditorImport)};

export function AdminVideoPickerHarness() {
  const [open, setOpen] = React.useState(true);
  const [picked, setPicked] = React.useState<MediaLibraryItemDto | null>(null);

  return (
    <div className="min-h-screen bg-background p-4 text-foreground md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Pengelola &amp; Pemilih Video Pendek</h1>
          <p className="text-sm text-muted-foreground">
            Uji seluruh status media picker: kesalahan ukuran/format, sedang diproses, gagal + coba lagi, takarir WebVTT, dan penolakan Hero.
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="min-h-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            data-testid="open-video-picker-btn"
          >
            Buka Pemilih Video
          </button>
          {picked && (
            <span className="inline-flex items-center rounded-md border border-border px-3 py-2 text-xs font-medium" data-testid="picked-video-label">
              Dipilih: #{picked.id} — {picked.alt}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ShortVideoBlockEditor handle="demo-tenant" placement="portfolio" contextLabel="Portofolio" />
          <ShortVideoBlockEditor handle="demo-tenant" placement="hero" contextLabel="Hero" />
        </div>
      </div>

      <MediaPickerSheet
        open={open}
        onOpenChange={setOpen}
        handle="demo-tenant"
        title="Pilih atau Unggah Video Pendek"
        acceptKind="video"
        placement="portfolio"
        selectedMediaId={picked?.id ?? null}
        canUpload={true}
        onSelect={(item) => setPicked(item)}
      />
    </div>
  );
}
`,
    "utf8",
  );

  // 3. /admin-picker/ page
  fs.writeFileSync(
    path.join(pagesDir, "admin-picker.astro"),
    `---
import ${JSON.stringify(adminCssImport)};
import { AdminVideoPickerHarness } from "../AdminVideoPickerHarness.tsx";
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Video Picker — TASK-060</title>
  </head>
  <body>
    <AdminVideoPickerHarness client:only="react" />
  </body>
</html>
`,
    "utf8",
  );

  const astro = await import(astroEntryUrl);
  const reactIntegration = (await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)).default;
  const tailwindcssVite = (await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)).default;

  await astro.build({
    root: webDir,
    configFile: false,
    srcDir,
    publicDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    devToolbar: { enabled: false },
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcssVite()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
      },
    },
  });

  return { tmpRoot, outDir };
}

function startStaticServer(dir) {
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".vtt": "text/vtt; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      let filePath = path.join(dir, decodeURIComponent(reqUrl.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const { tmpRoot, outDir } = await buildTask060Fixtures();
  const { server, baseUrl } = await startStaticServer(outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const savedScreenshots = [];

  try {
    // -------------------------------------------------------------------------
    // PART 1: Public Video.astro & SectionPortfolio.astro across 360 / 768 / 1440px
    // -------------------------------------------------------------------------
    const viewports = [
      { label: "360", width: 360, height: 800 },
      { label: "768", width: 768, height: 1024 },
      { label: "1440", width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      const mp4Requests = [];
      page.on("request", (req) => {
        if (req.url().endsWith(".mp4")) mp4Requests.push(req.url());
      });

      await page.goto(`${baseUrl}/portfolio/`, { waitUntil: "networkidle" });

      // Assert zero horizontal overflow
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert(overflow <= 1, `Public portfolio overflow at ${vp.label}px: ${overflow}px`);

      // Assert Video.astro attributes strictly: controls, preload="none", playsinline, poster, width, height, NO autoplay!
      const videoChecks = await page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll("video"));
        return videos.map((v) => ({
          controls: v.hasAttribute("controls"),
          preload: v.getAttribute("preload"),
          playsinline: v.hasAttribute("playsinline"),
          autoplay: v.hasAttribute("autoplay"),
          poster: v.getAttribute("poster"),
          width: v.getAttribute("width"),
          height: v.getAttribute("height"),
          tracks: Array.from(v.querySelectorAll("track")).map((t) => ({
            kind: t.getAttribute("kind"),
            src: t.getAttribute("src"),
            srclang: t.getAttribute("srclang"),
          })),
        }));
      });

      assert(videoChecks.length === 2, `Expected 2 rendered portfolio videos, got ${videoChecks.length}`);
      for (const vc of videoChecks) {
        assert(vc.controls === true, "Video must have controls attribute");
        assert(vc.preload === "none", `Video preload must be "none", got "${vc.preload}"`);
        assert(vc.playsinline === true, "Video must have playsinline attribute");
        assert(vc.autoplay === false, "Video MUST NOT have autoplay attribute");
        assert(Boolean(vc.poster) && vc.poster.endsWith(".webp"), `Video poster must be WebP, got ${vc.poster}`);
        assert(vc.width === "1280" && vc.height === "720", `Explicit dimensions expected, got ${vc.width}x${vc.height}`);
      }
      assert(
        videoChecks[0].tracks.length === 1 && videoChecks[0].tracks[0].kind === "captions",
        "First portfolio video must include WebVTT captions track",
      );

      // Hero placement video MUST NOT render
      const heroCount = await page.locator('[data-testid="hero-video-rejection-slot"] video').count();
      assert(heroCount === 0, "Hero placement video must never render");

      // preload="none" should avoid eager MP4 fetches on initial load
      assert(mp4Requests.length === 0, `Expected 0 eager MP4 requests, saw: ${mp4Requests.join(", ")}`);

      const shotPath = path.join(screenshotDir, `public-portfolio-${vp.label}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      savedScreenshots.push(shotPath);
      await context.close();
    }

    // -------------------------------------------------------------------------
    // PART 2: Admin Media Picker Video States (size/format error, processing, failure/retry, caption upload, hero rejection)
    // -------------------------------------------------------------------------
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();

      // Stateful mock API backing MediaPickerSheet so every real browser interaction executes end-to-end
      let mediaItems = [
        {
          id: 101,
          kind: "video",
          status: "ready",
          alt: "Tur Ruang Produksi Jakarta",
          normalizedBytes: 3_420_000,
          width: 1280,
          height: 720,
          publicUrl: `${baseUrl}/media/t/demo/profil-proyek.mp4`,
          posterUrl: `${baseUrl}/media/t/demo/profil-proyek-poster.webp`,
          captionsUrl: null,
          version: 1,
          createdAt: "2026-11-23T04:00:00.000Z",
        },
        {
          id: 102,
          kind: "video",
          status: "processing",
          alt: "Demo Instalasi Mesin Baru",
          normalizedBytes: 0,
          width: 1280,
          height: 720,
          publicUrl: null,
          posterUrl: null,
          captionsUrl: null,
          version: 1,
          createdAt: "2026-11-23T04:10:00.000Z",
        },
        {
          id: 103,
          kind: "video",
          status: "failed",
          alt: "Cuplikan iPhone HEVC (Gagal)",
          normalizedBytes: 0,
          width: 1920,
          height: 1080,
          publicUrl: null,
          posterUrl: null,
          captionsUrl: null,
          errorCode: "TRANSCODER_TIMEOUT",
          version: 1,
          createdAt: "2026-11-23T04:15:00.000Z",
        },
      ];

      await page.route("**/api/tenants/demo-tenant/media**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "GET" && url.pathname.endsWith("/media")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              items: mediaItems,
              page: { nextCursor: null, limit: 50, hasMore: false },
              videoSlots: { used: 2, limit: 20, remaining: 18 },
            }),
          });
          return;
        }
        if (req.method() === "POST" && url.pathname.endsWith("/103/retry")) {
          mediaItems = mediaItems.map((it) =>
            it.id === 103 ? { ...it, status: "processing", errorCode: null } : it,
          );
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({ id: 103, status: "processing" }),
          });
          return;
        }
        if (req.method() === "PUT" && url.pathname.endsWith("/101/captions")) {
          mediaItems = mediaItems.map((it) =>
            it.id === 101
              ? { ...it, captionsUrl: `${baseUrl}/media/t/demo/profil-proyek-captions.vtt` }
              : it,
          );
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: 101,
              captionsUrl: `${baseUrl}/media/t/demo/profil-proyek-captions.vtt`,
              cueCount: 1,
              strippedHtml: false,
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto(`${baseUrl}/admin-picker/`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="media-picker-sheet"]');
      await page.waitForSelector('[data-testid="media-picker-video-card-101"]');

      // Verify Hero guardrail renders on background ShortVideoBlockEditor
      assert(
        (await page.locator('[data-testid="video-hero-placement-error"]').count()) === 1,
        "Hero ShortVideoBlockEditor must show hero rejection alert",
      );

      // Verify processing state (#102 disabled & shows processing copy)
      assert(
        await page.locator('[data-testid="media-picker-item-102"]').isDisabled(),
        "Processing video #102 must be disabled for selection",
      );
      assert(
        (await page.locator('[data-testid="video-processing-note-102"]').textContent())?.includes(
          "Sedang memproses video",
        ),
        "Processing video #102 must display processing notice",
      );

      // Verify failure state (#103 shows failure note + Retry button)
      assert(
        (await page.locator('[data-testid="video-failed-note-103"]').textContent())?.includes(
          "Pemrosesan gagal",
        ),
        "Failed video #103 must show failure reason",
      );

      // Test 1: Video format error (.avi rejected client-side immediately)
      const videoInput = page.locator('[data-testid="media-picker-video-input"]');
      await videoInput.setInputFiles({
        name: "clip-unsupported.avi",
        mimeType: "video/x-msvideo",
        buffer: Buffer.from("RIFF1234AVI "),
      });
      await page.waitForSelector('[data-testid="video-upload-error"][data-error-kind="format"]');

      // Capture picker screenshot with format error + processing + failed/retry states visible!
      const pickerStatesShot = path.join(screenshotDir, `admin-picker-states-${vp.label}.png`);
      await page.screenshot({ path: pickerStatesShot, fullPage: false });
      savedScreenshots.push(pickerStatesShot);

      // Test 2: Video size error (10,000,001 bytes rejected client-side immediately)
      await videoInput.setInputFiles({
        name: "oversized-video.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.alloc(10_000_001, 0x41),
      });
      await page.waitForSelector('[data-testid="video-upload-error"][data-error-kind="size"]');

      // Test 3: Failure -> Retry button transitions #103 from failed -> processing
      await page.locator('[data-testid="video-retry-btn-103"]').click();
      await page.waitForSelector('[data-testid="media-picker-video-card-103"][data-video-status="processing"]');

      // Test 4: Invalid WebVTT caption rejected, then valid WebVTT caption succeeds
      const captionInput = page.locator('[data-testid="video-caption-input-101"]');
      await captionInput.setInputFiles({
        name: "bad-caption.vtt",
        mimeType: "text/vtt",
        buffer: Buffer.from("NOT_WEBVTT\n00:00:00.000 --> 00:00:02.000\nOops"),
      });
      await page.waitForSelector('[data-testid="video-caption-feedback"][data-feedback-tone="destructive"]');

      await captionInput.setInputFiles({
        name: "id-caption.vtt",
        mimeType: "text/vtt",
        buffer: Buffer.from("WEBVTT\n\n00:00:00.500 --> 00:00:03.000\nHalo pengunjung PunyaSitus.\n"),
      });
      await page.waitForSelector('[data-testid="video-caption-feedback"][data-feedback-tone="success"]');

      if (vp.label === "1440") {
        const captionShot = path.join(screenshotDir, "admin-picker-caption-retry-1440.png");
        await page.screenshot({ path: captionShot, fullPage: false });
        savedScreenshots.push(captionShot);
      }

      // Close sheet via Escape (keyboard accessibility check) and verify editor view at this viewport
      await page.keyboard.press("Escape");
      const overflowAdmin = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert(overflowAdmin <= 1, `Admin editor overflow at ${vp.label}px: ${overflowAdmin}px`);

      if (vp.label === "360" || vp.label === "1440") {
        const editorShot = path.join(screenshotDir, `admin-video-editor-${vp.label}.png`);
        await page.screenshot({ path: editorShot, fullPage: true });
        savedScreenshots.push(editorShot);
      }

      await context.close();
    }

    console.log("TASK-060 E2E PASSED. Screenshots saved:");
    for (const s of savedScreenshots) {
      console.log(`  - ${s}`);
    }
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
