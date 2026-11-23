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

const screenshotDir = process.env.TASK089_SCREENSHOT_DIR || "";

const FORBIDDEN_INITIAL_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "ytimg.com",
  "i.ytimg.com",
  "googlevideo.com",
  "google.com",
  "ggpht.com",
];

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function isForbiddenHost(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    return FORBIDDEN_INITIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
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

function createFixtureArtwork(publicMediaDir) {
  fs.mkdirSync(publicMediaDir, { recursive: true });
  const posters = [
    {
      name: "yt-poster-gallery.svg",
      bg: "#0f4c5c",
      accent: "#176b51",
      title: "Tur Pabrik & Ruang Kerja",
      subtitle: "Poster Lokal · Tanpa Koneksi YouTube",
    },
    {
      name: "yt-poster-post.svg",
      bg: "#1e3a5f",
      accent: "#2563eb",
      title: "Panduan Memilih Paket Layanan",
      subtitle: "Artikel Blog · Poster Lokal WebP/SVG",
    },
    {
      name: "yt-poster-offering.svg",
      bg: "#1f2937",
      accent: "#0d9488",
      title: "Demo Unit & Inspeksi 160 Titik",
      subtitle: "Halaman Penawaran · Poster Lokal",
    },
    {
      name: "gallery-photo.svg",
      bg: "#27374d",
      accent: "#526d82",
      title: "Dokumentasi Layanan Klien",
      subtitle: "Jakarta Selatan · 2026",
    },
  ];

  const escapeXml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  for (const item of posters) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="${item.bg}"/>
  <rect x="56" y="56" width="1168" height="608" rx="22" fill="${item.accent}" fill-opacity="0.34" stroke="#ffffff" stroke-opacity="0.24" stroke-width="2"/>
  <circle cx="1050" cy="180" r="130" fill="#ffffff" fill-opacity="0.08"/>
  <circle cx="210" cy="560" r="170" fill="#ffffff" fill-opacity="0.06"/>
  <text x="108" y="340" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="700">${escapeXml(item.title)}</text>
  <text x="108" y="408" fill="#e2e8f0" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="500">${escapeXml(item.subtitle)}</text>
</svg>`;
    fs.writeFileSync(path.join(publicMediaDir, item.name), svg, "utf8");
  }
}

async function buildRealYouTubeFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t089-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const publicDir = path.join(tmpRoot, "public");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });
  createFixtureArtwork(path.join(publicDir, "media/t/demo"));

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const facadeImport = path.join(webDir, "src/themes/default/components/YouTubeFacade.astro");
  const rendererImport = path.join(webDir, "src/themes/default/sections/SectionRenderer.astro");
  const galleryImport = path.join(webDir, "src/themes/default/sections/SectionGallery.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  fs.writeFileSync(
    path.join(srcDir, "fixture-shell.ts"),
    `import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

export function buildShell(isPreview = false) {
  const themeStyle = buildSafeThemeStyleBlock(null, "compro");
  return {
    isPreview,
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
      description: "Mitra layanan usaha dan dokumentasi proyek profesional.",
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
      header: [
        { label: "Galeri", href: "/gallery/", openInNewTab: false, children: [] },
        { label: "Artikel", href: "/post/", openInNewTab: false, children: [] },
        { label: "Penawaran", href: "/offering/", openInNewTab: false, children: [] },
      ],
      footer: [{ label: "Galeri", href: "/gallery/", openInNewTab: false, children: [] }],
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

  // 1. /gallery/ — Real SectionRenderer + SectionGallery with local poster, SVG placeholder, and hostile ytimg.com poster stripped!
  fs.writeFileSync(
    path.join(pagesDir, "gallery.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell } from "../fixture-shell.ts";

const shell = buildShell(false);
const sections = [
  {
    id: "galeri-video",
    type: "gallery",
    enabled: true,
    config: {
      eyebrow: "Galeri Dokumentasi",
      heading: "Video Profil & Dokumentasi Proyek",
      subheading: "Seluruh video YouTube dimuat dengan mode ramah privasi klik-untuk-putar.",
      columns: 3,
      items: [
        {
          kind: "youtube",
          videoId: "dQw4w9WgXcQ",
          title: "Tur Pabrik & Ruang Kerja Utama",
          posterUrl: "/media/t/demo/yt-poster-gallery.svg",
          caption: "Poster lokal dari Pustaka Media tenant",
        },
        {
          kind: "youtube",
          videoId: "9bZkp7q19f0",
          title: "Ringkasan Alur Layanan Pelanggan",
          posterUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg",
          caption: "Poster eksternal ditolak otomatis ke placeholder SVG lokal",
        },
        {
          kind: "image",
          src: "/media/t/demo/gallery-photo.svg",
          alt: "Dokumentasi layanan klien",
          width: 1280,
          height: 720,
          caption: "Foto ruang konsultasi cabang utama",
        },
      ],
    },
  },
];
---
<Layout shell={shell} pageTitle="Galeri Video" currentPath="/gallery/" showConsent={false}>
  <SectionRenderer
    sections={sections}
    themeId="compro"
    routePath="/gallery"
    isHomepage={false}
    mode="published"
    fallbackBusiness={shell.business}
  />
</Layout>
`,
  );

  // 2. /post/ — Blog article page with YouTubeFacade (context="post")
  fs.writeFileSync(
    path.join(pagesDir, "post.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import YouTubeFacade from ${JSON.stringify(facadeImport)};
import { buildShell } from "../fixture-shell.ts";

const shell = buildShell(false);
---
<Layout shell={shell} pageTitle="Panduan Layanan" currentPath="/post/" showConsent={false}>
  <article class="ps-container" style="padding-block: 2.5rem; max-width: 48rem;">
    <h1>Panduan Memilih Paket Layanan Bisnis</h1>
    <p>Pelajari langkah evaluasi kebutuhan operasional usaha Anda melalui ringkasan video di bawah ini.</p>
    <div style="margin-top: 1.5rem;">
      <YouTubeFacade
        videoId="M7lc1UVf-VE"
        title="Video Panduan Memilih Paket Layanan"
        posterUrl="/media/t/demo/yt-poster-post.svg"
        caption="Durasi 3 menit · Penjelasan ringkas untuk pemilik usaha"
        context="post"
        headingLevel="h2"
        testId="post-youtube-facade"
      />
    </div>
  </article>
</Layout>
`,
  );

  // 3. /offering/ — Offering detail page with YouTubeFacade (context="offering")
  fs.writeFileSync(
    path.join(pagesDir, "offering.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import YouTubeFacade from ${JSON.stringify(facadeImport)};
import { buildShell } from "../fixture-shell.ts";

const shell = buildShell(false);
---
<Layout shell={shell} pageTitle="SUV Keluarga 2023" currentPath="/offering/" showConsent={false}>
  <section class="ps-container" style="padding-block: 2.5rem; max-width: 48rem;">
    <h1>SUV Keluarga 2023 Automatic — Inspeksi 160 Titik</h1>
    <p>Harga Rp 345.000.000 · Lihat video inspeksi unit sebelum menjadwalkan kunjungan showroom.</p>
    <div style="margin-top: 1.5rem;">
      <YouTubeFacade
        videoId="aqz-KE-bpKQ"
        title="Video Inspeksi Unit SUV Keluarga 2023"
        posterUrl="/media/t/demo/yt-poster-offering.svg"
        context="offering"
        headingLevel="h2"
        testId="offering-youtube-facade"
      />
    </div>
  </section>
</Layout>
`,
  );

  // 4. /preview/ — Preview mode page proving YouTubeFacade stays 100% inert!
  fs.writeFileSync(
    path.join(pagesDir, "preview.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionGallery from ${JSON.stringify(galleryImport)};
import { buildShell } from "../fixture-shell.ts";

const shell = buildShell(true);
const galleryConfig = {
  eyebrow: "Pratinjau Draf",
  heading: "Pratinjau Galeri Video",
  columns: 2 as const,
  items: [
    {
      kind: "youtube" as const,
      videoId: "dQw4w9WgXcQ",
      title: "Video Pratinjau Draf",
      posterUrl: "/media/t/demo/yt-poster-gallery.svg",
      caption: "Tombol putar dinonaktifkan pada mode pratinjau",
    },
  ],
};
---
<Layout shell={shell} pageTitle="Pratinjau" currentPath="/preview/" showConsent={false}>
  <SectionGallery id="preview-gallery" config={galleryConfig} isPreview={true} isFirstSection={true} />
</Layout>
`,
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    publicDir,
    outDir,
    cacheDir,
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
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function startStaticServer(outDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
    res.writeHead(200, { "Content-Type": getContentType(fullPath) });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealYouTubeFixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // -----------------------------------------------------------------------
    // 0. Static SSR HTML Hygiene Checks across gallery, post, offering, preview
    // -----------------------------------------------------------------------
    for (const route of ["gallery", "post", "offering", "preview"]) {
      const html = fs.readFileSync(path.join(fixtures.outDir, route, "index.html"), "utf8");
      assert(!html.includes("<iframe"), `Route /${route}/ MUST NOT emit <iframe> in initial SSR HTML`);
      assert(
        !html.includes("i.ytimg.com") && !html.includes("ytimg.com"),
        `Route /${route}/ MUST NOT reference ytimg.com in initial SSR HTML`,
      );
      assert(
        !html.includes('rel="preconnect"'),
        `Route /${route}/ MUST NOT preconnect to YouTube/Google in initial SSR HTML`,
      );
      assert(
        html.includes("Video dari YouTube tidak dimuat otomatis demi privasi Anda."),
        `Route /${route}/ MUST include honest Indonesian privacy disclosure`,
      );
    }

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // -----------------------------------------------------------------------
    // 1. ZERO-Network-Before-Click Proof across gallery, post, offering, preview
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const interceptedEmbedRequests = [];
    // Offline-deterministic mock for youtube-nocookie.com ONLY (activates after explicit click!)
    await page.route("https://www.youtube-nocookie.com/**", async (route) => {
      const reqUrl = route.request().url();
      interceptedEmbedRequests.push(reqUrl);
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html lang="id">
<head><meta charset="utf-8" /><title>Mock YouTube NoCookie Player</title>
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; }
  .mock-player { text-align: center; padding: 1.25rem; border: 1px solid #334155; border-radius: 10px; background: #1e293b; max-width: 90%; }
  .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 999px; background: #176b51; color: #fff; font-size: 0.75rem; font-weight: 700; margin-bottom: 0.5rem; }
  .title { font-size: 0.95rem; font-weight: 700; margin: 0 0 0.35rem; }
  .url { font-size: 0.72rem; color: #cbd5e1; word-break: break-all; margin: 0; font-family: monospace; }
</style></head>
<body>
  <div class="mock-player" data-testid="mock-yt-nocookie-player">
    <span class="badge">youtube-nocookie.com · Aktif setelah klik</span>
    <p class="title">Pemutar YouTube Dimuat (Mode Privasi)</p>
    <p class="url">${reqUrl.replace(/</g, "&lt;")}</p>
  </div>
</body></html>`,
      });
    });

    for (const routePath of ["/gallery/", "/post/", "/offering/", "/preview/"]) {
      const preClickRequests = [];
      const onRequest = (req) => {
        preClickRequests.push(req.url());
      };
      page.on("request", onRequest);

      await page.goto(`${server.baseUrl}${routePath}`, { waitUntil: "networkidle" });
      await page.evaluate(async () => {
        for (const img of Array.from(document.querySelectorAll("img"))) {
          img.loading = "eager";
        }
        await Promise.all(
          Array.from(document.querySelectorAll("img")).map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                }),
          ),
        );
      });

      page.off("request", onRequest);

      const forbiddenHits = preClickRequests.filter(
        (u) => !u.startsWith(server.baseUrl) || isForbiddenHost(u),
      );
      assert(
        forbiddenHits.length === 0,
        `Route ${routePath} MUST make ZERO third-party/YouTube/Google requests on initial load (got: ${forbiddenHits.join(", ")})`,
      );

      const iframeCount = await page.locator("iframe").count();
      assert(iframeCount === 0, `Route ${routePath} MUST have 0 <iframe> before click (got ${iframeCount})`);

      const brokenImages = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img"))
          .filter((img) => !img.complete || img.naturalWidth === 0)
          .map((img) => img.getAttribute("src")),
      );
      assert(
        brokenImages.length === 0,
        `Route ${routePath} has broken local images: ${brokenImages.join(", ")}`,
      );
    }

    assert(
      interceptedEmbedRequests.length === 0,
      `ZERO requests to youtube-nocookie.com allowed before any click (got ${interceptedEmbedRequests.length})`,
    );

    // -----------------------------------------------------------------------
    // 2. Layout, Tap Targets (>= 48px play button, >= 44px controls), & Screenshots @ 1440px & 360px
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/gallery/`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      for (const img of Array.from(document.querySelectorAll("img"))) img.loading = "eager";
      await Promise.all(
        Array.from(document.querySelectorAll("img")).map((img) =>
          img.complete ? Promise.resolve() : new Promise((r) => img.addEventListener("load", r, { once: true })),
        ),
      );
    });

    const desktopMetrics = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const playBtns = Array.from(document.querySelectorAll("[data-ps-yt-play]")).map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") || "", w: r.width, h: r.height };
      });
      const fallbackLinks = Array.from(document.querySelectorAll(".ps-yt-fallback")).map((el) => {
        const r = el.getBoundingClientRect();
        return { href: el.getAttribute("href"), w: r.width, h: r.height };
      });
      return { overflow, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, playBtns, fallbackLinks };
    });

    assert(
      !desktopMetrics.overflow,
      `Gallery @ 1440px horizontal overflow (${desktopMetrics.scrollWidth} > ${desktopMetrics.innerWidth})`,
    );
    assert(desktopMetrics.playBtns.length === 2, `Expected 2 YouTube facade buttons in /gallery/, got ${desktopMetrics.playBtns.length}`);
    for (const btn of desktopMetrics.playBtns) {
      assert(btn.h >= 48 && btn.w >= 48, `Desktop play button "${btn.label}" must be >= 48px (got ${btn.w}x${btn.h})`);
    }
    for (const link of desktopMetrics.fallbackLinks) {
      assert(link.h >= 44, `Desktop fallback link must be >= 44px tall (got ${link.h})`);
    }

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "youtube-facade-1440.png"),
        fullPage: true,
      });
    }

    // Mobile 360px layout + tap targets + screenshot
    await page.setViewportSize({ width: 360, height: 800 });
    const mobileMetrics = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const playBtns = Array.from(document.querySelectorAll("[data-ps-yt-play]")).map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") || "", w: r.width, h: r.height };
      });
      const fallbackLinks = Array.from(document.querySelectorAll(".ps-yt-fallback")).map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      return { overflow, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, playBtns, fallbackLinks };
    });

    assert(
      !mobileMetrics.overflow,
      `Gallery @ 360px horizontal overflow (${mobileMetrics.scrollWidth} > ${mobileMetrics.innerWidth})`,
    );
    for (const btn of mobileMetrics.playBtns) {
      assert(btn.h >= 48 && btn.w >= 48, `Mobile 360px play button "${btn.label}" must be >= 48px (got ${btn.w}x${btn.h})`);
    }
    for (const link of mobileMetrics.fallbackLinks) {
      assert(link.h >= 44, `Mobile 360px fallback link must be >= 44px tall (got ${link.h})`);
    }

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "youtube-facade-360.png"),
        fullPage: true,
      });
    }

    // -----------------------------------------------------------------------
    // 3. Mouse Click Activation on /gallery/ -> Mounts youtube-nocookie.com iframe
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    const firstPlayBtn = page.locator('[data-testid="section-galeri-video-youtube-0-play"]');
    await firstPlayBtn.click();

    const firstFacade = page.locator('[data-testid="section-galeri-video-youtube-0"]');
    const mountedIframe = firstFacade.locator('iframe[data-testid="yt-embed-iframe"]');
    await mountedIframe.waitFor({ state: "visible", timeout: 5000 });

    const iframeAttrs = await mountedIframe.evaluate((el) => ({
      src: el.getAttribute("src"),
      title: el.getAttribute("title"),
      allow: el.getAttribute("allow"),
      allowFullscreen: el.hasAttribute("allowfullscreen"),
      referrerPolicy: el.getAttribute("referrerpolicy"),
      state: el.closest("[data-ps-yt-facade]")?.getAttribute("data-yt-state"),
    }));

    assert(
      iframeAttrs.src === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1",
      `Unexpected click-activated iframe src: ${iframeAttrs.src}`,
    );
    assert(
      iframeAttrs.title === "Tur Pabrik & Ruang Kerja Utama",
      `Unexpected iframe title: ${iframeAttrs.title}`,
    );
    assert(
      iframeAttrs.allow?.includes("autoplay") && iframeAttrs.allow?.includes("picture-in-picture"),
      `Unexpected iframe allow attribute: ${iframeAttrs.allow}`,
    );
    assert(iframeAttrs.allowFullscreen, "Mounted iframe MUST have allowfullscreen attribute");
    assert(
      iframeAttrs.referrerPolicy === "strict-origin-when-cross-origin",
      `Unexpected iframe referrerpolicy: ${iframeAttrs.referrerPolicy}`,
    );
    assert(iframeAttrs.state === "active", `Expected data-yt-state=active, got ${iframeAttrs.state}`);
    assert(
      interceptedEmbedRequests.some((u) =>
        u.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"),
      ),
      "Expected intercepted network request to youtube-nocookie.com after explicit click",
    );

    // Ensure the SECOND video card in /gallery/ is still unloaded (independent per-card activation!)
    const secondIframeCount = await page
      .locator('[data-testid="section-galeri-video-youtube-1"] iframe')
      .count();
    assert(secondIframeCount === 0, "Clicking card 0 MUST NOT activate card 1");

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "youtube-activated-1440.png"),
        fullPage: true,
      });
    }

    // -----------------------------------------------------------------------
    // 4. Keyboard Activation (Tab -> Enter on /post/, Tab -> Space on /offering/)
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/post/`, { waitUntil: "networkidle" });
    const postPlayBtn = page.locator('[data-testid="post-youtube-facade-play"]');

    // Traverse with real Tab presses until play button receives focus
    let focusedPostPlay = false;
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press("Tab");
      const isFocused = await postPlayBtn.evaluate((el) => document.activeElement === el);
      if (isFocused) {
        focusedPostPlay = true;
        break;
      }
    }
    assert(focusedPostPlay, "Play button on /post/ MUST be reachable via keyboard Tab");

    const focusStyle = await postPlayBtn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth) };
    });
    assert(
      focusStyle.outlineStyle !== "none" && focusStyle.outlineWidth >= 2,
      `Keyboard focused Play button must show >= 2px focus ring, got ${JSON.stringify(focusStyle)}`,
    );

    await page.keyboard.press("Enter");
    const postIframe = page.locator('[data-testid="post-youtube-facade"] iframe[data-testid="yt-embed-iframe"]');
    await postIframe.waitFor({ state: "visible", timeout: 5000 });
    const postIframeSrc = await postIframe.getAttribute("src");
    assert(
      postIframeSrc === "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=1&rel=0&modestbranding=1",
      `Keyboard Enter on /post/ produced wrong iframe src: ${postIframeSrc}`,
    );

    // Offering page: keyboard Space activation
    await page.goto(`${server.baseUrl}/offering/`, { waitUntil: "networkidle" });
    const offeringPlayBtn = page.locator('[data-testid="offering-youtube-facade-play"]');
    await offeringPlayBtn.focus();
    await page.keyboard.press("Space");
    const offeringIframe = page.locator('[data-testid="offering-youtube-facade"] iframe[data-testid="yt-embed-iframe"]');
    await offeringIframe.waitFor({ state: "visible", timeout: 5000 });
    const offeringIframeSrc = await offeringIframe.getAttribute("src");
    assert(
      offeringIframeSrc === "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0&modestbranding=1",
      `Keyboard Space on /offering/ produced wrong iframe src: ${offeringIframeSrc}`,
    );

    // -----------------------------------------------------------------------
    // 5. Preview Mode Inert Check (/preview/)
    // -----------------------------------------------------------------------
    const countBeforePreview = interceptedEmbedRequests.length;
    await page.goto(`${server.baseUrl}/preview/`, { waitUntil: "networkidle" });
    const previewPlayBtn = page.locator('[data-testid="section-preview-gallery-youtube-0-play"]');
    assert(
      await previewPlayBtn.isDisabled(),
      "Preview mode Play button MUST be disabled",
    );
    await previewPlayBtn.click({ force: true });
    assert(
      (await page.locator("iframe").count()) === 0,
      "Preview mode click MUST NOT mount any YouTube iframe",
    );
    assert(
      interceptedEmbedRequests.length === countBeforePreview,
      "Preview mode click MUST NOT send any network request to youtube-nocookie.com",
    );

    // -----------------------------------------------------------------------
    // 6. No-JS Fallback Verification (javaScriptEnabled: false)
    // -----------------------------------------------------------------------
    const noJsCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();
    const noJsExternalRequests = [];
    noJsPage.on("request", (req) => {
      const u = req.url();
      if (!u.startsWith(server.baseUrl)) noJsExternalRequests.push(u);
    });
    await noJsPage.goto(`${server.baseUrl}/gallery/`, { waitUntil: "load" });
    const noJsMetrics = await noJsPage.evaluate(() => {
      const link = document.querySelector('[data-testid="section-galeri-video-youtube-0-fallback-link"]');
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        iframeCount: document.querySelectorAll("iframe").length,
        fallbackHref: link?.getAttribute("href"),
        fallbackTarget: link?.getAttribute("target"),
        fallbackRel: link?.getAttribute("rel"),
      };
    });
    assert(!noJsMetrics.overflow, "No-JS @ 360px MUST NOT overflow horizontally");
    assert(noJsMetrics.iframeCount === 0, "No-JS MUST render 0 iframes");
    assert(
      noJsMetrics.fallbackHref === "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      `No-JS fallback link href mismatch: ${noJsMetrics.fallbackHref}`,
    );
    assert(noJsMetrics.fallbackTarget === "_blank", "No-JS fallback link must open in _blank");
    assert(
      noJsMetrics.fallbackRel === "noopener noreferrer",
      `No-JS fallback link rel mismatch: ${noJsMetrics.fallbackRel}`,
    );
    assert(
      noJsExternalRequests.length === 0,
      `No-JS MUST make zero third-party requests (got ${noJsExternalRequests.join(", ")})`,
    );
    await noJsCtx.close();

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-089 E2E PASS: Zero requests to youtube.com/youtube-nocookie.com/ytimg.com/googlevideo.com/google.com across gallery, post, offering, and preview routes; hostile i.ytimg.com poster stripped to local SVG placeholder; mouse click and keyboard Tab->Enter/Space mount youtube-nocookie.com iframe with accessible title/disclosure; preview mode stays completely inert; no-JS fallback link works cleanly; 360px/1440px zero overflow, >=48px play button, >=44px controls, >=2px focus ring, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-089 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

await main();
