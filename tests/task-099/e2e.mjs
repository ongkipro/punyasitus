/* global process, console, document, URL, Buffer */
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

const screenshotDir = process.env.TASK099_SCREENSHOT_DIR || "/tmp/qa-task-099";

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

async function buildTask099Fixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t099-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const bioAdminImport = path.join(
    root,
    "packages/plugins/bio-links/src/admin/BioLinksAdminClient.tsx",
  );
  const waAdminImport = path.join(
    root,
    "packages/plugins/wa-cs-rotator/src/admin/WaCsRotatorAdminClient.tsx",
  );
  const bioRenderImport = path.join(root, "packages/plugins/bio-links/src/render.ts");

  const layoutProps = (title) => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Properti"
    workspaceSubtitle="nusantara-properti.situsku.click"
    activeNavId="plugins"
    basePath="/dashboard/nusantara-properti"
    offeringLabel="Layanan"
    lifecycleStatus="active"
    publicSiteHref="https://nusantara-properti.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 1. Public `/link` zero-JS page rendered directly via renderBioLinksPublicHtml
  fs.writeFileSync(
    path.join(pagesDir, "public-link.astro"),
    `---
import { renderBioLinksPublicHtml } from ${JSON.stringify(bioRenderImport)};

const rendered = renderBioLinksPublicHtml({
  tenant: {
    id: "ten_e2e_099",
    handle: "nusantara-properti",
    name: "PT Nusantara Properti",
    status: "active",
    primaryHost: "nusantara-properti.situsku.click",
  },
  profile: {
    displayName: "Budi Santoso",
    headline: "Konsultan Properti Resmi Jabodetabek",
    bioText: "Pilih tautan resmi di bawah untuk brosur unit siap huni, simulasi KPR, atau jadwal kunjungan lokasi.",
    avatarUrl: "",
    themeAccent: "#0F766E",
    whatsappPhone: "6281234567890",
    whatsappLabel: "Konsultasi Langsung via WhatsApp",
    whatsappMessage: "Halo Budi, saya tertarik dengan katalog properti 2026.",
    showWhatsappButton: true,
    updatedAt: 1763942400000,
  },
  items: [
    {
      id: "bl_katalog_2026",
      label: "Katalog Rumah & Kavling 2026",
      url: "https://nusantara-properti.situsku.click/produk",
      subtitle: "Daftar harga, spesifikasi bangunan, dan promo DP ringan",
      badge: "Terbaru",
      sortOrder: 0,
      isActive: true,
      clickCount: 42,
      createdAt: 1763942400000,
      updatedAt: 1763942400000,
    },
    {
      id: "bl_kpr_simulasi",
      label: "Simulasi Cicilan KPR Syariah & Bank",
      url: "https://nusantara-properti.situsku.click/layanan/kpr",
      subtitle: "Estimasi cicilan tenor 10 hingga 20 tahun",
      badge: "Gratis",
      sortOrder: 1,
      isActive: true,
      clickCount: 19,
      createdAt: 1763942400000,
      updatedAt: 1763942400000,
    },
    {
      id: "bl_lokasi_showunit",
      label: "Lokasi Galeri Marketing & Show Unit",
      url: "https://maps.google.com/?q=Jakarta+Selatan",
      subtitle: "Buka setiap hari 09.00 - 17.00 WIB",
      badge: "",
      sortOrder: 2,
      isActive: true,
      clickCount: 11,
      createdAt: 1763942400000,
      updatedAt: 1763942400000,
    },
  ],
  clickPathPrefix: "/link/go",
});
---
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{rendered.title} — PT Nusantara Properti</title>
    <meta name="description" content={rendered.description} />
  </head>
  <body>
    <main data-plugin-id="bio-links" set:html={rendered.html} />
  </body>
</html>`,
  );

  // 2. Bio Links base-nova admin page
  fs.writeFileSync(
    path.join(pagesDir, "admin-bio-links.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { BioLinksAdminClient } from ${JSON.stringify(bioAdminImport)};
---
<DashboardLayout ${layoutProps("Bio Links (/link) — Plugin — PT Nusantara Properti")}>
  <BioLinksAdminClient
    client:load
    basePath="/dashboard/nusantara-properti"
    apiBaseUrl="/api/tenants/nusantara-properti/plugins/bio-links"
    publicLinkHref="/public-link"
    enabled={true}
    initialProfile={{
      displayName: "Budi Santoso",
      headline: "Konsultan Properti Resmi Jabodetabek",
      bioText: "Pilih tautan resmi di bawah untuk brosur unit siap huni dan jadwal survei lokasi.",
      themeAccent: "#0F766E",
      whatsappPhone: "081234567890",
      whatsappLabel: "Konsultasi Langsung via WhatsApp",
      showWhatsappButton: true,
    }}
    initialLinks={[
      {
        id: "bl_katalog_2026",
        label: "Katalog Rumah & Kavling 2026",
        url: "https://nusantara-properti.situsku.click/produk",
        subtitle: "Daftar harga dan promo DP ringan",
        badge: "Terbaru",
        sortOrder: 0,
        isActive: true,
        clickCount: 42,
      },
      {
        id: "bl_kpr_simulasi",
        label: "Simulasi Cicilan KPR",
        url: "https://nusantara-properti.situsku.click/layanan/kpr",
        subtitle: "Estimasi tenor 10-20 tahun",
        badge: "Gratis",
        sortOrder: 1,
        isActive: true,
        clickCount: 19,
      },
    ]}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 3. WhatsApp CS Rotator base-nova admin page
  fs.writeFileSync(
    path.join(pagesDir, "admin-wa-rotator.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { WaCsRotatorAdminClient } from ${JSON.stringify(waAdminImport)};
---
<DashboardLayout ${layoutProps("WhatsApp CS Rotator — Plugin — PT Nusantara Properti")}>
  <WaCsRotatorAdminClient
    client:load
    basePath="/dashboard/nusantara-properti"
    apiBaseUrl="/api/tenants/nusantara-properti/plugins/wa-cs-rotator"
    enabled={true}
    initialStrategy="weighted"
    initialFallbackPhone="081100001111"
    initialTimezone="Asia/Jakarta"
    initialFallbackClicks={6}
    initialAgents={[
      {
        id: "agt_rina",
        name: "Rina Wijaya",
        roleLabel: "Senior Sales",
        phoneE164: "6281211111111",
        weight: 3,
        scheduleDays: [1, 2, 3, 4, 5],
        startTime: "08:00",
        endTime: "17:00",
        timezone: "Asia/Jakarta",
        isActive: true,
        isOnShiftNow: true,
        totalClicks: 54,
      },
      {
        id: "agt_budi",
        name: "Budi Hartono",
        roleLabel: "Sales CS",
        phoneE164: "6281222222222",
        weight: 1,
        scheduleDays: [1, 2, 3, 4, 5, 6],
        startTime: "08:00",
        endTime: "17:00",
        timezone: "Asia/Jakarta",
        isActive: true,
        isOnShiftNow: true,
        totalClicks: 18,
      },
      {
        id: "agt_citra",
        name: "Citra Lestari",
        roleLabel: "CS Shift Malam",
        phoneE164: "6281233333333",
        weight: 2,
        scheduleDays: [1, 2, 3, 4, 5],
        startTime: "18:00",
        endTime: "23:00",
        timezone: "Asia/Jakarta",
        isActive: true,
        isOnShiftNow: false,
        totalClicks: 22,
      },
    ]}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
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

  const resolvePluginDepsFromWeb = {
    name: "resolve-plugin-deps-from-web",
    async resolveId(source, importer, options) {
      if (
        importer &&
        importer.includes(`${path.sep}packages${path.sep}plugins${path.sep}`) &&
        !source.startsWith(".") &&
        !source.startsWith("/") &&
        !source.startsWith("@/") &&
        !source.startsWith("@punyasitus/")
      ) {
        return this.resolve(source, path.join(webDir, "src", "env.d.ts"), {
          ...options,
          skipSelf: true,
        });
      }
      return null;
    },
  };

  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    integrations: [reactIntegration()],
    vite: {
      plugins: [resolvePluginDepsFromWeb, tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
        },
        dedupe: ["react", "react-dom"],
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
  let clickCount = 0;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (reqUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // First-party /link/go click redirect simulation
    if (reqUrl.pathname === "/link/go" && req.method === "GET") {
      const id = reqUrl.searchParams.get("id");
      if (id === "bl_katalog_2026") {
        clickCount += 1;
        res.writeHead(302, {
          Location: "/redirect-landed?source=bio-links",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Tautan tidak ditemukan");
      return;
    }

    if (reqUrl.pathname === "/redirect-landed") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="id"><head><meta charset="utf-8"/><title>Tujuan Tautan</title></head><body><main data-testid="redirect-landed-ok">Pengalihan berhasil tercatat (${clickCount} klik)</main></body></html>`,
      );
      return;
    }

    // Mock Bio Links admin API endpoints
    if (
      reqUrl.pathname === "/api/tenants/nusantara-properti/plugins/bio-links/links" &&
      req.method === "POST"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          link: {
            id: "bl_new_e2e",
            label: body.label || "Tautan Baru",
            url: body.url || "https://contoh.id",
            subtitle: body.subtitle || "",
            badge: body.badge || "",
            sortOrder: 2,
            isActive: true,
            clickCount: 0,
          },
        }),
      );
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/nusantara-properti/plugins/bio-links/profile" &&
      req.method === "PUT"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ profile: body }));
      return;
    }

    // Mock WA CS Rotator admin API endpoints
    if (
      reqUrl.pathname === "/api/tenants/nusantara-properti/plugins/wa-cs-rotator/settings" &&
      req.method === "PUT"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          state: {
            strategy: body.strategy || "round_robin",
            fallbackWhatsappPhone: body.fallbackWhatsappPhone ?? "",
            timezone: body.timezone || "Asia/Jakarta",
          },
        }),
      );
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/nusantara-properti/plugins/wa-cs-rotator/agents" &&
      req.method === "POST"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          agent: {
            id: "agt_new_e2e",
            name: body.name || "Agen Baru",
            roleLabel: body.roleLabel || "Sales CS",
            phoneE164: "6281299990000",
            weight: Number(body.weight || 1),
            scheduleDays: body.scheduleDays || [1, 2, 3, 4, 5],
            startTime: body.startTime || "08:00",
            endTime: body.endTime || "17:00",
            timezone: body.timezone || "Asia/Jakarta",
            isActive: true,
            isOnShiftNow: true,
            totalClicks: 0,
          },
        }),
      );
      return;
    }

    let target = path.join(outDir, reqUrl.pathname);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    } else if (!fs.existsSync(target) && fs.existsSync(`${target}.html`)) {
      target = `${target}.html`;
    } else if (!fs.existsSync(target) && fs.existsSync(path.join(target, "index.html"))) {
      target = path.join(target, "index.html");
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(target) });
    fs.createReadStream(target).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getClickCount: () => clickCount,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const built = await buildTask099Fixtures();
  const server = await startFixtureServer(built.outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const savedScreenshots = [];

  try {
    const viewports = [
      { name: "360x800", width: 360, height: 800 },
      { name: "1440x900", width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });

      // 1. Public `/link` zero-JS bio page verification
      const jsRequests = [];
      page.on("request", (req) => {
        if (req.resourceType() === "script") {
          jsRequests.push(req.url());
        }
      });

      await page.goto(`${server.baseUrl}/public-link`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="bio-links-page"]');

      const scriptTagCount = await page.evaluate(() => document.querySelectorAll("script").length);
      assert(scriptTagCount === 0, `Public /link must have 0 <script> tags, got ${scriptTagCount}`);
      assert(jsRequests.length === 0, `Public /link must load 0 JS files, got ${jsRequests.join(",")}`);

      const publicOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!publicOverflow, `Horizontal overflow on public /link at ${vp.name}`);

      const publicShot = path.join(screenshotDir, `public-bio-link-${vp.name}.png`);
      await page.screenshot({ path: publicShot, fullPage: true });
      savedScreenshots.push(publicShot);

      // Verify click redirect works without any client JS
      await page.click('[data-link-id="bl_katalog_2026"]');
      await page.waitForSelector('[data-testid="redirect-landed-ok"]');
      assert(server.getClickCount() > 0, "Clicking /link item must hit /link/go click tracker");

      // 2. Bio Links admin screen (base-nova)
      await page.goto(`${server.baseUrl}/admin-bio-links`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="bio-links-admin-shell"]');

      const bioAdminOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!bioAdminOverflow, `Horizontal overflow on Bio Links admin at ${vp.name}`);

      const bioRadix = await page.evaluate(
        () =>
          document.querySelectorAll("[data-radix-collection-item], [data-radix-popper-content-wrapper]")
            .length,
      );
      assert(bioRadix === 0, "Forbidden Radix DOM attributes on Bio Links admin");

      const bioAdminShot = path.join(screenshotDir, `admin-bio-links-${vp.name}.png`);
      await page.screenshot({ path: bioAdminShot, fullPage: true });
      savedScreenshots.push(bioAdminShot);

      // Interactive add-link proof
      await page.fill("#bio-new-label", "Brosur Promo Akhir Tahun");
      await page.fill("#bio-new-url", "https://nusantara-properti.situsku.click/promo");
      await page.click('button:has-text("Tambah Tautan")');
      await page.waitForSelector('[data-testid="bio-links-admin-notice"]');
      await page.waitForSelector('[data-testid="bio-admin-link-bl_new_e2e"]');

      // 3. WhatsApp CS Rotator admin screen (base-nova)
      await page.goto(`${server.baseUrl}/admin-wa-rotator`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="wa-rotator-admin-shell"]');

      const waAdminOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!waAdminOverflow, `Horizontal overflow on WA CS Rotator admin at ${vp.name}`);

      const waRadix = await page.evaluate(
        () =>
          document.querySelectorAll("[data-radix-collection-item], [data-radix-popper-content-wrapper]")
            .length,
      );
      assert(waRadix === 0, "Forbidden Radix DOM attributes on WA CS Rotator admin");

      const waAdminShot = path.join(screenshotDir, `admin-wa-cs-rotator-${vp.name}.png`);
      await page.screenshot({ path: waAdminShot, fullPage: true });
      savedScreenshots.push(waAdminShot);

      // Interactive add-agent proof
      await page.fill("#wa-agent-name", "Dewi Kartika");
      await page.fill("#wa-agent-phone", "0812-9999-0000");
      await page.click('button:has-text("Tambah Agen")');
      await page.waitForSelector('[data-testid="wa-rotator-admin-notice"]');
      await page.waitForSelector('[data-testid="wa-admin-agent-agt_new_e2e"]');

      assert(errors.length === 0, `Browser runtime errors at ${vp.name}: ${errors.join("; ")}`);
      await context.close();
    }

    console.log(
      JSON.stringify(
        {
          task: "TASK-099",
          status: "PASS",
          viewports: ["360x800", "1440x900"],
          publicBioLinkJsBytes: 0,
          screenshots: savedScreenshots,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await server.close();
    built.cleanup();
  }
}

run().catch((err) => {
  console.error("TASK-099 E2E FAILED:", err);
  process.exit(1);
});
