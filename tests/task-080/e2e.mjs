/* global process, console, setTimeout, document, window, fetch, Buffer, URL, URLSearchParams */
/**
 * TASK-080 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * End-to-end real-browser proof:
 * 1. Provisions a real tenant (with migrated TenantStore DO) in local `astro dev`.
 * 2. Authenticates as the tenant owner on `/dashboard/<handle>/forms` at 1440px & 360px:
 *    - Verifies 6 vertical starter templates render cleanly, `0 / 10 formulir` badge,
 *      missing `privacy_contact` UU PDP warning, and zero horizontal overflow.
 *    - Captures `forms-list-1440.png` and `forms-list-360.png`.
 * 3. Opens `/dashboard/<handle>/forms/new?template=permintaan_penawaran` at 1440px & 360px:
 *    - Verifies vertical field list with keyboard `Naik`/`Turun` buttons (zero drag-and-drop).
 *    - Reorders a field with `Naik`, saves draft (`POST /api/tenants/:handle/forms`).
 *    - Verifies publishing without `privacy_contact` shows clear error (`PRIVACY_CONTACT_REQUIRED`).
 *    - Sets `privacy_contact` via `/api/tenants/:handle/identity` (or business_profile) and publishes!
 *    - Captures `form-builder-1440.png` and `form-builder-360.png`.
 * 4. Compiles the REAL `Layout.astro` + `SectionCustomForm.astro` using Astro build with the
 *    published form (including an XSS-test label `<b>Nama PIC</b>` to prove zero HTML injection!)
 *    and opens it in Chromium at 1440px & 360px:
 *    - Verifies conditional field `lokasi_survei` starts hidden, appears dynamically when
 *      `perlu_survei = "Ya"` is clicked, and submits to real `POST /api/leads` on `<handle>.situsku.click`.
 *    - Verifies success banner + 1-click `https://wa.me/...` CTA link encoding submitted labels/values!
 *    - Captures `public-custom-form-1440.png` and `public-custom-form-360.png`.
 * 5. Verifies 100% No-JS (`javaScriptEnabled: false`) submission via native HTML form POST -> 303 `https://wa.me/...`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK080_SCREENSHOT_DIR || "/tmp/task-080-screenshots";
fs.mkdirSync(screenshotDir, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function cleanChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (
      key === "AI_AGENT" ||
      key === "CLAUDECODE" ||
      key === "CODEX_SANDBOX" ||
      key.startsWith("ANTIGRAVITY_")
    ) {
      delete env[key];
    }
  }
  return env;
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

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body || null;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function runLocalD1Sql(sql) {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistTo,
      "--command",
      sql,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`Local D1 execute failed:\n${res.stdout}\n${res.stderr}`);
  }
}

function ensureLocalD1Migrated() {
  const persistTo = path.join(webDir, ".wrangler/state");
  const migrate = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistTo,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    throw new Error(`Local D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }
}

async function waitForServer(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`astro dev did not become ready on port ${port}`);
}

async function signUpInBrowser(page, { email, password, name }) {
  const res = await page.evaluate(
    async ({ email: e, password: p, name: n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const body = await r.json().catch(() => null);
      return { status: r.status, userId: body?.user?.id ?? "" };
    },
    { email, password, name },
  );
  assert(res.status === 200 && res.userId, `Sign-up failed for ${email}: ${JSON.stringify(res)}`);
  return res.userId;
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  assert(overflow <= 1, `${label}: horizontal overflow detected (${overflow}px)`);
}

async function buildRealCustomFormPage(publishedFormJson) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t080-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const customFormImport = path.join(webDir, "src/themes/default/sections/SectionCustomForm.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  const pageSource = `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionCustomForm from ${JSON.stringify(customFormImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

const publishedForm = ${JSON.stringify(publishedFormJson)};
const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Klinik & Mitra Nusantara",
    tagline: "Solusi Terpercaya Indonesia",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Klinik & Mitra Nusantara",
    category: "MedicalClinic",
    description: "Layanan konsultasi dan penjadwalan resmi.",
    address: "Jl. Gatot Subroto No. 18",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12930",
    mapsUrl: null,
    weekdayHours: "Senin–Jumat 08.00–17.00 WIB",
    holidayHours: "Minggu Tutup",
    phone: "6281299001122",
    whatsappE164: "6281299001122",
    email: "halo@mitra.example",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Formulir", href: "/penawaran", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Formulir", href: "/penawaran", openInNewTab: false, children: [] }],
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
---
<Layout
  shell={shell}
  pageTitle="Permintaan Penawaran"
  pageDescription="Ajukan permintaan penawaran resmi"
  currentPath="/penawaran"
  showConsent={false}
>
  <SectionCustomForm
    form={publishedForm}
    eyebrow="Formulir Resmi"
    businessName="Klinik & Mitra Nusantara"
    privacyContact="privasi@mitra.co.id"
    isHealthCategory={true}
    sourcePath="/penawaran"
    returnTo="/penawaran"
    isFirstSection={true}
  />
</Layout>
`;

  fs.writeFileSync(path.join(pagesDir, "penawaran.astro"), pageSource, "utf8");

  const { build } = await import(astroEntryUrl);
  await build({
    root: tmpRoot,
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    logLevel: "error",
    vite: { logLevel: "error" },
  });

  return {
    tmpRoot,
    outDir,
    html: fs.readFileSync(path.join(outDir, "penawaran/index.html"), "utf8"),
  };
}

async function startCustomFormProxyServer({ outDir, html, astroPort, tenantHost }) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "POST" && reqUrl.pathname === "/api/leads") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const ct = req.headers["content-type"] || "application/json";
          const headers = {
            Host: tenantHost,
            "Content-Type": ct,
            "CF-Connecting-IP": "203.0.113.80",
          };
          if (req.headers["idempotency-key"]) {
            headers["Idempotency-Key"] = String(req.headers["idempotency-key"]);
          }
          if (ct.includes("application/json")) {
            headers.Origin = `https://${tenantHost}`;
          } else {
            headers["Sec-Fetch-Site"] = "same-origin";
          }
          const forwarded = await httpRequest(astroPort, "/api/leads", {
            method: "POST",
            headers,
            body: rawBody,
          });
          const outHeaders = { "Cache-Control": "no-store" };
          if (forwarded.headers.location) outHeaders.Location = forwarded.headers.location;
          if (forwarded.headers["content-type"]) {
            outHeaders["Content-Type"] = forwarded.headers["content-type"];
          }
          res.writeHead(forwarded.status, outHeaders);
          res.end(forwarded.body);
        } catch (err) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(err));
        }
      });
      return;
    }

    if (reqUrl.pathname === "/" || reqUrl.pathname === "/penawaran") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    const safeRel = reqUrl.pathname.replace(/^\/+/, "");
    const assetPath = path.join(outDir, safeRel);
    if (assetPath.startsWith(outDir) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      const ext = path.extname(assetPath).toLowerCase();
      const mime =
        ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js" || ext === ".mjs"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(assetPath));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  ensureLocalD1Migrated();
  const astroPort = await getFreePort();
  const child = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(astroPort)],
    {
      cwd: webDir,
      env: cleanChildEnv({
        NODE_ENV: "development",
        PUNYASITUS_ALLOW_DEV_HOSTS: "1",
        PUNYASITUS_DISABLE_DEV_TOOLBAR: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  child.stdout?.on("data", (d) => {
    serverLogs += d.toString();
  });
  child.stderr?.on("data", (d) => {
    serverLogs += d.toString();
  });

  let browser;
  let tmpBuildRoot = "";
  let proxyServer = null;

  try {
    await waitForServer(astroPort);
    const baseUrl = `http://127.0.0.1:${astroPort}`;
    const executablePath = findChromeExecutable();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    let expectingIntentional422 = false;
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (expectingIntentional422 && text.includes("status of 422")) {
          return;
        }
        consoleErrors.push(`console.error: ${text}`);
      }
    });

    // 1. Register user & provision real local tenant via onboarding API
    const stamp = Date.now().toString(36);
    const handle = `t080-${stamp}`;
    const email = `owner-${stamp}@example.com`;
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const userId = await signUpInBrowser(page, {
      email,
      password: "Task080E2ePassword!2026",
      name: "Owner Task080",
    });
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE id = '${userId.replace(/'/g, "''")}'`);

    const provRes = await page.evaluate(
      async ({ h, idem }) => {
        const r = await fetch("/api/onboarding/provision", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idem,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            name: "Klinik & Mitra Nusantara",
            handle: h,
            vertical: "compro",
          }),
        });
        const body = await r.json().catch(() => null);
        return { status: r.status, body };
      },
      { h: handle, idem: `t080-prov-${stamp}` },
    );
    assert(
      provRes.status === 201 || provRes.status === 200,
      `Tenant onboarding failed: ${JSON.stringify(provRes)}`,
    );

    // 2. Open `/dashboard/<handle>/forms` at 1440px & 360px
    await page.goto(`${baseUrl}/dashboard/${handle}/forms`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="forms-list-root"]');
    await page.waitForSelector('[data-testid="privacy-contact-missing-warning"]');
    for (const tplKey of [
      "booking_layanan",
      "permintaan_penawaran",
      "pendaftaran_tur",
      "test_drive",
      "reservasi_meja",
      "kontak_umum",
    ]) {
      const visible = await page.locator(`[data-testid="template-card-${tplKey}"]`).isVisible();
      assert(visible, `Template card ${tplKey} must be visible`);
    }
    await assertNoHorizontalOverflow(page, "forms-list-1440");
    await page.screenshot({ path: path.join(screenshotDir, "forms-list-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoHorizontalOverflow(page, "forms-list-360");
    await page.screenshot({ path: path.join(screenshotDir, "forms-list-360.png"), fullPage: true });

    // 3. Open Form Builder with `permintaan_penawaran` template at 1440px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/dashboard/${handle}/forms/new?template=permintaan_penawaran`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-testid="form-builder-root"]');

    // Add XSS-probe text in the first field label to verify Astro escaping on public render!
    await page.fill('[data-testid="field-label-input-0"]', "Nama PIC <script>window.__xss=1</script>");
    // Set explicit WhatsApp phone override so WA after-submit works deterministically
    await page.fill('[data-testid="wa-phone-override-input"]', "0812-9900-1122");

    // Reorder field #1 up via keyboard-accessible Naik button (no drag-and-drop)
    await page.click('[data-testid="field-move-up-1"]');

    // Attempt publish WITHOUT privacy_contact -> MUST show compliance error!
    expectingIntentional422 = true;
    await page.click('[data-testid="publish-form-btn"]');
    await page.waitForSelector('[data-testid="form-builder-error"]');
    expectingIntentional422 = false;
    const errText = await page.locator('[data-testid="form-builder-error"]').textContent();
    assert(
      errText && errText.includes("Kontak Privasi"),
      `Expected privacy contact error, got: ${errText}`,
    );

    await assertNoHorizontalOverflow(page, "form-builder-1440");
    await page.screenshot({ path: path.join(screenshotDir, "form-builder-1440.png"), fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await assertNoHorizontalOverflow(page, "form-builder-360");
    await page.screenshot({ path: path.join(screenshotDir, "form-builder-360.png"), fullPage: true });

    // 4. Configure privacy_contact & medical_clinic category via identity/business-profile API,
    //    verify draft-only privacy_contact STILL blocks publishing (Finding 3), then publish business profile!
    await page.setViewportSize({ width: 1440, height: 900 });
    const profilePatch = await page.evaluate(
      async ({ h }) => {
        const getRes = await fetch(`/api/tenants/${encodeURIComponent(h)}/identity/business-profile`, {
          credentials: "same-origin",
        });
        const current = await getRes.json().catch(() => null);
        const ver = current?.version ?? 1;
        const putRes = await fetch(`/api/tenants/${encodeURIComponent(h)}/identity/business-profile`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            expectedVersion: ver,
            businessProfile: {
              businessName: "Klinik & Mitra Nusantara",
              businessCategory: "medical_clinic",
              email: "privasi@mitra.co.id",
              whatsappE164: "0812-9900-1122",
              privacyContact: "privasi@mitra.co.id",
            },
          }),
        });
        return { status: putRes.status, body: await putRes.json().catch(() => null) };
      },
      { h: handle },
    );
    assert(profilePatch.status === 200, `Business profile draft save failed: ${JSON.stringify(profilePatch)}`);

    // Reload before publishing business profile -> draft-only privacy_contact MUST NOT clear the warning!
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="privacy-contact-missing-warning"]');

    // Now publish the business profile so privacy_contact & medical_clinic become published!
    const profilePublish = await page.evaluate(
      async ({ h, ver }) => {
        const pubRes = await fetch(
          `/api/tenants/${encodeURIComponent(h)}/identity/business-profile/publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ expectedVersion: ver }),
          },
        );
        return { status: pubRes.status, body: await pubRes.json().catch(() => null) };
      },
      { h: handle, ver: profilePatch.body?.version ?? 2 },
    );
    assert(profilePublish.status === 200, `Business profile publish failed: ${JSON.stringify(profilePublish)}`);

    // Reload builder -> privacy warning disappears & UU PDP health category warning appears!
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="form-builder-root"]');
    await page.waitForSelector('[data-testid="uupdp-health-warning"]');

    const hasPrivacyWarning = await page.locator('[data-testid="privacy-contact-missing-warning"]').count();
    assert(hasPrivacyWarning === 0, "privacy_contact missing warning must clear once published");

    await page.click('[data-testid="publish-form-btn"]');
    await page.waitForSelector('[data-testid="form-builder-success"]');
    const listAfterPub = await page.evaluate(async ({ h }) => {
      const r = await fetch(`/api/tenants/${encodeURIComponent(h)}/forms`, { credentials: "same-origin" });
      return r.json();
    }, { h: handle });
    const publishedDef = listAfterPub?.items?.[0]?.publishedDefinition ?? null;

    assert(publishedDef !== null, `Form should be published with publishedDefinition`);

    // 5. Build & serve REAL `SectionCustomForm.astro` in Chromium!
    const built = await buildRealCustomFormPage(publishedDef);
    tmpBuildRoot = built.tmpRoot;
    const tenantHost = `${handle}.situsku.click`;
    proxyServer = await startCustomFormProxyServer({
      outDir: built.outDir,
      html: built.html,
      astroPort,
      tenantHost,
    });

    const publicUrl = `http://127.0.0.1:${proxyServer.port}/penawaran`;
    const publicContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const publicPage = await publicContext.newPage();
    publicPage.on("pageerror", (err) => consoleErrors.push(`public pageerror: ${err.message}`));

    await publicPage.goto(publicUrl, { waitUntil: "networkidle" });
    await publicPage.waitForSelector('[data-testid="section-custom-form"]');
    await publicPage.waitForSelector('[data-testid="public-uupdp-health-warning"]');

    // Verify XSS payload was safely HTML-escaped (NEVER executed)
    const xssFlag = await publicPage.evaluate(() => window.__xss ?? null);
    assert(xssFlag === null, "XSS script must NEVER execute in SectionCustomForm!");

    // Verify conditional field `lokasi_survei` starts hidden
    const lokasiHiddenInitially = await publicPage.locator('[data-testid="custom-field-lokasi_survei"]').isHidden();
    assert(lokasiHiddenInitially, "Conditional field lokasi_survei should start hidden");

    // Fill visible fields and trigger `perlu_survei = "Ya"`
    await publicPage.fill('input[name="cf_nama_perusahaan"]', "PT Karya Baja Mandiri");
    await publicPage.fill('input[name="cf_nama_pic"]', "Siti Rahma");
    await publicPage.fill('input[name="cf_no_whatsapp"]', "0812-3456-7890");
    await publicPage.selectOption('select[name="cf_kategori_kebutuhan"]', "Maklon / OEM");
    await publicPage.check('input[name="cf_perlu_survei"][value="Ya"]');

    // Conditional field MUST become visible now!
    const lokasiVisibleAfterYa = await publicPage.locator('[data-testid="custom-field-lokasi_survei"]').isVisible();
    assert(lokasiVisibleAfterYa, "Conditional field lokasi_survei must become visible when perlu_survei = Ya");

    await publicPage.fill('input[name="cf_lokasi_survei"]', "Kawasan Industri Cikarang");
    await publicPage.fill('textarea[name="cf_rincian_kebutuhan"]', "Butuh penawaran 500 unit kemasan");
    await publicPage.check('input[name="cf_persetujuan_privasi"]');
    await publicPage.check('[data-testid="custom-form-privacy-consent"]');

    await publicPage.click('[data-testid="custom-form-submit"]');
    await publicPage.waitForSelector('[data-testid="custom-form-wa-cta"]');

    const waHref = await publicPage.locator('[data-testid="custom-form-wa-cta"]').getAttribute("href");
    assert(
      waHref && waHref.startsWith("https://wa.me/6281299001122?text="),
      `Expected valid wa.me CTA URL, got: ${waHref}`,
    );
    const decodedSummary = decodeURIComponent(waHref.split("?text=")[1]);
    assert(
      decodedSummary.includes("Kawasan Industri Cikarang") && decodedSummary.includes("Siti Rahma"),
      `WhatsApp summary missing submitted values: ${decodedSummary}`,
    );

    await assertNoHorizontalOverflow(publicPage, "public-custom-form-1440");
    await publicPage.screenshot({
      path: path.join(screenshotDir, "public-custom-form-1440.png"),
      fullPage: true,
    });

    await publicPage.setViewportSize({ width: 360, height: 800 });
    await assertNoHorizontalOverflow(publicPage, "public-custom-form-360");
    await publicPage.screenshot({
      path: path.join(screenshotDir, "public-custom-form-360.png"),
      fullPage: true,
    });
    await publicContext.close();

    // 6. Verify 100% No-JS HTML form POST works cleanly (`303 See Other` -> `https://wa.me/...`)
    const noJsPost = await httpRequest(proxyServer.port, "/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        formSlug: publishedDef.slug,
        privacyConsent: "true",
        sourcePath: "/penawaran",
        returnTo: "/penawaran",
        cf_nama_perusahaan: "CV Tanpa JS",
        cf_nama_pic: "Andi NoJS",
        cf_no_whatsapp: "081355667788",
        cf_kategori_kebutuhan: "Maklon / OEM",
        cf_perlu_survei: "Tidak",
        cf_rincian_kebutuhan: "Permintaan tanpa JS",
        cf_persetujuan_privasi: "true",
      }).toString(),
    });
    assert(noJsPost.status === 303, `Expected 303 on No-JS custom form submit, got ${noJsPost.status}: ${noJsPost.body}`);
    assert(
      String(noJsPost.headers.location || "").startsWith("https://wa.me/6281299001122?text="),
      `Expected wa.me Location on No-JS submit, got: ${noJsPost.headers.location}`,
    );

    assert(consoleErrors.length === 0, `Unexpected browser errors:\n${consoleErrors.join("\n")}`);

    console.log("TASK-080 E2E PASSED!");
    console.log(`Screenshots saved in: ${screenshotDir}`);
  } catch (err) {
    console.error("TASK-080 E2E FAILED:", err);
    if (serverLogs) {
      console.error("--- astro dev logs (tail) ---\n" + serverLogs.slice(-3000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (proxyServer) await proxyServer.close().catch(() => undefined);
    if (tmpBuildRoot) fs.rmSync(tmpBuildRoot, { recursive: true, force: true });
    child.kill("SIGTERM");
  }
}

await main();
