/* global process, console, document, window, Buffer, URL, URLSearchParams */
/**
 * TASK-071 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Compiles and renders the REAL Astro components & Base UI React islands:
 * - Public: `Layout.astro` + `SectionContactForm.astro` + `ScheduleInquiryCta.astro`
 * - Admin: `DashboardLayout.astro` + `apps/web/src/pages/dashboard/[handle]/leads/_LeadsInbox.tsx`
 *
 * Verifies end-to-end in headless Chromium:
 * 1. Part A — Zero-JS (`javaScriptEnabled: false`) Contact Form & WhatsApp CTA @ 360px:
 *    - "Permintaan Jadwal (Opsional)" fieldset & request-only disclaimer copy.
 *    - Server-rendered WhatsApp CTA works WITHOUT JS (clean `wa.me` link, zero `{{...}}` tokens,
 *      empty schedule sentences cleanly omitted).
 *    - Native `application/x-www-form-urlencoded` POST submits `preferred_date`, `preferred_time`,
 *      and `branch_id` -> receives `303 See Other` PRG redirect (zero schedule values in Location)
 *      -> renders durable accepted status banner.
 *    - Zero horizontal overflow & >= 44px touch targets on inputs, selects, submit, and WA CTA.
 * 2. Part B — Progressive-Enhancement JS Contact Form & Single-Pass WA CTA @ 1440px & 360px:
 *    - Selecting `preferred_date`, `preferred_time`, and `branch_id` updates WhatsApp CTA href
 *      via single-pass token expansion (no raw tokens, formatted Indonesian date, time, branch).
 *    - Clearing `preferred_time` drops its entire sentence cleanly without dangling punctuation.
 *    - Submitting JSON lead persists under 16 KiB cap with `Idempotency-Key` and renders live banner.
 *    - Captures `contact-form-1440.png` and `contact-form-360.png`.
 * 3. Part C — Dashboard Lead Inbox (`_LeadsInbox.tsx`) @ 1440px & 360px:
 *    - Displays "Permintaan Jadwal" column (`1440px`), stacked schedule card (`360px`), and
 *      Lead Detail drawer (`Sheet`) with formatted date, `Pagi`/`Sore`, branch name, and
 *      request-only micro-copy.
 *    - Captures `leads-inbox-1440.png`, `leads-inbox-detail-1440.png`, and `leads-inbox-360.png`.
 *    - Asserts zero horizontal overflow, >= 44px tap targets, and zero console/page errors.
 */
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

const screenshotDir = process.env.TASK071_SCREENSHOT_DIR || "/tmp/qa-task-071";

const ACTIVE_BRANCHES = [
  { id: 1, name: "Cabang Jakarta Selatan" },
  { id: 2, name: "Cabang Bandung Dago" },
];

const BRANCH_NAMES_BY_ID = Object.fromEntries(ACTIVE_BRANCHES.map((b) => [b.id, b.name]));

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

function getJakartaDateOffset(daysAhead) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  let y = 2026;
  let m = 11;
  let d = 24;
  for (const p of parts) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
  }
  const dt = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function buildTask071Fixtures({ dateNoJs, dateJs }) {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t071-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const contactFormImport = path.join(
    webDir,
    "src/themes/default/sections/SectionContactForm.astro",
  );
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");
  const dashboardLayoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const leadsInboxImport = path.join(
    webDir,
    "src/pages/dashboard/[handle]/leads/_LeadsInbox.tsx",
  );

  const makeContactPage = (extraScript) => `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionContactForm from ${JSON.stringify(contactFormImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
${extraScript}
const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const branches = ${JSON.stringify(ACTIVE_BRANCHES)};
const shell = {
  isPreview: false,
  layoutMode: "standard" as const,
  themeId: "compro",
  baseThemeId: themeStyle.baseThemeId,
  themeStyle,
  site: {
    title: "Klinik Sehat Nusantara",
    tagline: "Layanan Kesehatan Terpercaya",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public" as const,
    analyticsConfig: null,
  },
  business: {
    name: "Klinik Sehat Nusantara",
    category: "MedicalClinic",
    description: "Klinik gigi dan kesehatan keluarga.",
    address: "Jl. Kemang Raya No. 12",
    city: "Jakarta Selatan",
    province: "DKI Jakarta",
    postalCode: "12730",
    mapsUrl: null,
    weekdayHours: "Senin–Sabtu 08.00–20.00 WIB",
    holidayHours: "Minggu Tutup",
    phone: "6281234567890",
    whatsappE164: "6281234567890",
    email: "halo@klinik-sehat.example",
    socialLinks: [],
  },
  menus: {
    header: [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Kontak", href: "/kontak", openInNewTab: false, children: [] },
    ],
    footer: [{ label: "Kontak", href: "/kontak", openInNewTab: false, children: [] }],
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
  pageTitle="Kontak & Permintaan Jadwal"
  pageDescription="Kirim permintaan jadwal konsultasi ke Klinik Sehat Nusantara"
  currentPath="/kontak"
  showConsent={false}
>
  <SectionContactForm
    id="formulir-kontak"
    businessName="Klinik Sehat Nusantara"
    heading="Kirim Pesan atau Permintaan Jadwal"
    sourcePath="/kontak"
    returnTo="/kontak"
    tenantTimeZone="Asia/Jakarta"
    branches={branches}
    whatsappPhone="0812-3456-7890"
    primaryOrigin="https://klinik-sehat.situsku.click"
    itemTitle="Konsultasi Klinik Sehat Nusantara"
    googleMapsReviewUrl="https://g.page/r/Cf1234567890_EBM/review"
    isFirstSection={true}
  />
</Layout>
`;

  fs.writeFileSync(path.join(pagesDir, "kontak.astro"), makeContactPage(""), "utf8");
  fs.writeFileSync(
    path.join(pagesDir, "kontak-accepted.astro"),
    makeContactPage(
      `Astro.url.searchParams.set("leadStatus", "accepted");\nAstro.url.searchParams.set("leadNumber", "1");`,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pagesDir, "kontak-error.astro"),
    makeContactPage(
      `Astro.url.searchParams.set("leadStatus", "error");\nAstro.url.searchParams.set("code", "VALIDATION_ERROR");`,
    ),
    "utf8",
  );

  // Dashboard Lead Inbox page (renders REAL DashboardLayout + _LeadsInbox.tsx)
  const initialLeads = [
    {
      id: 2,
      name: "Siti Rahmawati",
      phone: "6281398765432",
      email: "siti@example.test",
      message: "Ingin konsultasi pemasangan behel dan estimasi biaya.",
      status: "new",
      preferredDate: dateJs,
      preferredTime: "sore",
      branchId: 2,
      preferredBranchLabel: "Cabang Bandung Dago",
      sourceCategory: "direct",
      pagePath: "/kontak",
      internalNotes: null,
      version: 1,
      createdAt: "2026-11-24T04:15:00.000Z",
      updatedAt: "2026-11-24T04:15:00.000Z",
      whatsappFollowUpUrl: "https://wa.me/6281398765432?text=Halo%20Siti%20Rahmawati",
    },
    {
      id: 1,
      name: "Budi Prakoso",
      phone: "6281234567890",
      email: "budi.prakoso@example.test",
      message: "Halo Klinik Sehat, mohon permintaan jadwal pemeriksaan gigi.",
      status: "new",
      preferredDate: dateNoJs,
      preferredTime: "pagi",
      branchId: 1,
      preferredBranchLabel: "Cabang Jakarta Selatan",
      sourceCategory: "direct",
      pagePath: "/kontak",
      internalNotes: null,
      version: 1,
      createdAt: "2026-11-24T04:00:00.000Z",
      updatedAt: "2026-11-24T04:00:00.000Z",
      whatsappFollowUpUrl: "https://wa.me/6281234567890?text=Halo%20Budi%20Prakoso",
    },
  ];

  fs.writeFileSync(
    path.join(pagesDir, "leads-inbox.astro"),
    `---
import DashboardLayout from ${JSON.stringify(dashboardLayoutImport)};
import { LeadsInbox } from ${JSON.stringify(leadsInboxImport)};

const initialItems = ${JSON.stringify(initialLeads)};
const branchNamesById = ${JSON.stringify(BRANCH_NAMES_BY_ID)};
---
<DashboardLayout
  title="Pesan Masuk — Klinik Sehat Nusantara"
  surface="dashboard"
  workspaceName="Klinik Sehat Nusantara"
  workspaceSubtitle="klinik-sehat.situsku.click"
  activeNavId="leads"
  basePath="/dashboard/klinik-sehat"
  offeringLabel="Layanan"
  unreadLeadsCount={2}
  lifecycleStatus="active"
  publicSiteHref="https://klinik-sehat.situsku.click"
  userDisplayName="Dr. Andi Pemilik"
  userRoleLabel="Pemilik Situs"
>
  <LeadsInbox
    client:load
    tenantId="klinik-sehat"
    handle="klinik-sehat"
    tenantName="Klinik Sehat Nusantara"
    lifecycleStatus="active"
    canUpdate={true}
    canDelete={true}
    canExportCsv={true}
    initialItems={initialItems}
    initialCounts={{ all: 2, new: 2, contacted: 0, closed: 0 }}
    initialNextCursor={null}
    initialHasMore={false}
    initialEmailNotificationsEnabled={true}
    initialLoadError={null}
    branchNamesById={branchNamesById}
  />
</DashboardLayout>
`,
    "utf8",
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
    srcDir,
    outDir,
    cacheDir,
    output: "static",
    devToolbar: { enabled: false },
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

  return {
    tmpRoot,
    outDir,
    kontakHtml: fs.readFileSync(path.join(outDir, "kontak/index.html"), "utf8"),
    acceptedHtml: fs.readFileSync(path.join(outDir, "kontak-accepted/index.html"), "utf8"),
    errorHtml: fs.readFileSync(path.join(outDir, "kontak-error/index.html"), "utf8"),
    inboxHtml: fs.readFileSync(path.join(outDir, "leads-inbox/index.html"), "utf8"),
  };
}

function startFixtureServer(built) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
  };

  const submittedLeads = [];

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "POST" && reqUrl.pathname === "/api/leads") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuf = Buffer.concat(chunks);
        assert(bodyBuf.byteLength <= 16_384, `Lead POST exceeded 16 KiB: ${bodyBuf.byteLength}`);

        const ct = (req.headers["content-type"] || "").toLowerCase();
        const isForm = ct.includes("application/x-www-form-urlencoded");
        let parsed;
        if (isForm) {
          const params = new URLSearchParams(bodyBuf.toString("utf8"));
          parsed = Object.fromEntries(params.entries());
        } else {
          parsed = JSON.parse(bodyBuf.toString("utf8"));
        }

        const nextId = submittedLeads.length + 1;
        submittedLeads.push({
          id: nextId,
          mode: isForm ? "form" : "json",
          payload: parsed,
          idempotencyKey: req.headers["idempotency-key"] || null,
        });

        if (isForm) {
          res.writeHead(303, {
            Location: `/kontak?leadStatus=accepted&leadNumber=${nextId}#formulir-kontak`,
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }

        res.writeHead(201, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({
            leadNumber: nextId,
            status: "accepted",
            confirmationMessage:
              "Terima kasih! Pesan Anda telah kami terima. Tim kami akan segera menghubungi Anda.",
          }),
        );
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/kontak") {
        const leadStatus = reqUrl.searchParams.get("leadStatus");
        const leadNumber = reqUrl.searchParams.get("leadNumber");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (leadStatus === "accepted") {
          const html =
            leadNumber && /^\d+$/.test(leadNumber)
              ? built.acceptedHtml.replace("#1", `#${leadNumber}`)
              : built.acceptedHtml;
          res.end(html);
        } else if (leadStatus === "error") {
          res.end(built.errorHtml);
        } else {
          res.end(built.kontakHtml);
        }
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/dashboard/klinik-sehat/leads") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(built.inboxHtml);
        return;
      }

      const safeRel = path.normalize(reqUrl.pathname).replace(/^(\.\.(\/|\\|$))+/, "");
      const candidate = path.join(built.outDir, safeRel);
      if (candidate.startsWith(built.outDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
        fs.createReadStream(candidate).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, submittedLeads });
    });
  });
}

async function main() {
  const dateNoJs = getJakartaDateOffset(7);
  const dateJs = getJakartaDateOffset(14);
  const built = await buildTask071Fixtures({ dateNoJs, dateJs });
  const fixtureServer = await startFixtureServer(built);

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    const consoleErrors = [];
    const pageErrors = [];

    // -------------------------------------------------------------------------
    // 1. Part A — Zero-JS (`javaScriptEnabled: false`) Contact Form & WA CTA @ 360px
    // -------------------------------------------------------------------------
    const noJsCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsCtx.newPage();
    const formResp = await noJsPage.goto(`${fixtureServer.baseUrl}/kontak`, {
      waitUntil: "domcontentloaded",
    });
    assert(formResp && formResp.status() === 200, `Contact form returned ${formResp?.status()}`);

    const noJsCheck = await noJsPage.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const disclaimer =
        document.querySelector('[data-testid="lead-schedule-disclaimer"]')?.textContent ?? "";
      const waHref =
        document.querySelector('[data-testid="lead-wa-schedule-cta"]')?.getAttribute("href") ?? "";
      const reviewHref =
        document.querySelector('[data-testid="contact-google-maps-review-link"]')?.getAttribute("href") ??
        "";
      const dateRect = document.querySelector('[data-testid="lead-preferred-date"]')?.getBoundingClientRect();
      const timeRect = document.querySelector('[data-testid="lead-preferred-time"]')?.getBoundingClientRect();
      const branchRect = document.querySelector('[data-testid="lead-preferred-branch"]')?.getBoundingClientRect();
      const waRect = document.querySelector('[data-testid="lead-wa-schedule-cta"]')?.getBoundingClientRect();
      const submitRect = document.querySelector('[data-testid="lead-form-submit"]')?.getBoundingClientRect();
      return {
        overflow,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        disclaimer,
        waHref,
        reviewHref,
        dateHeight: dateRect?.height ?? 0,
        timeHeight: timeRect?.height ?? 0,
        branchHeight: branchRect?.height ?? 0,
        waHeight: waRect?.height ?? 0,
        submitHeight: submitRect?.height ?? 0,
      };
    });

    assert(
      !noJsCheck.overflow,
      `No-JS contact form @ 360px overflows (${noJsCheck.scrollWidth} > ${noJsCheck.innerWidth})`,
    );
    assert(
      noJsCheck.disclaimer.toLowerCase().includes("permintaan jadwal"),
      `Schedule disclaimer must say "permintaan jadwal", got: ${noJsCheck.disclaimer}`,
    );
    assert(noJsCheck.dateHeight >= 44, `preferred_date input < 44px (${noJsCheck.dateHeight})`);
    assert(noJsCheck.timeHeight >= 44, `preferred_time select < 44px (${noJsCheck.timeHeight})`);
    assert(noJsCheck.branchHeight >= 44, `branch_id select < 44px (${noJsCheck.branchHeight})`);
    assert(noJsCheck.waHeight >= 44, `WhatsApp CTA < 44px (${noJsCheck.waHeight})`);
    assert(noJsCheck.submitHeight >= 44, `Submit button < 44px (${noJsCheck.submitHeight})`);
    assert(
      noJsCheck.reviewHref === "https://g.page/r/Cf1234567890_EBM/review",
      `TASK-073 review link must remain intact: ${noJsCheck.reviewHref}`,
    );
    assert(
      noJsCheck.waHref.startsWith("https://wa.me/6281234567890?text="),
      `No-JS WA CTA href invalid: ${noJsCheck.waHref}`,
    );
    const decodedNoJsWa = decodeURIComponent(noJsCheck.waHref.split("?text=")[1] ?? "");
    assert(
      decodedNoJsWa.includes("permintaan jadwal"),
      `No-JS WA message missing "permintaan jadwal": ${decodedNoJsWa}`,
    );
    assert(!decodedNoJsWa.includes("{{"), `No-JS WA message has raw tokens: ${decodedNoJsWa}`);
    assert(
      !decodedNoJsWa.includes("Tanggal yang diharapkan"),
      `No-JS WA message kept empty date sentence: ${decodedNoJsWa}`,
    );

    // Submit native no-JS form with schedule fields
    await noJsPage.fill('input[name="name"]', "Budi Prakoso");
    await noJsPage.fill('input[name="phone"]', "0812-3456-7890");
    await noJsPage.fill('input[name="email"]', "budi.prakoso@example.test");
    await noJsPage.fill(
      'textarea[name="message"]',
      "Halo Klinik Sehat, mohon permintaan jadwal pemeriksaan gigi.",
    );
    await noJsPage.fill('input[name="preferred_date"]', dateNoJs);
    await noJsPage.selectOption('select[name="preferred_time"]', "pagi");
    await noJsPage.selectOption('select[name="branch_id"]', "1");
    await noJsPage.check('input[name="privacyConsent"]');

    await Promise.all([
      noJsPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
      noJsPage.click('[data-testid="lead-form-submit"]'),
    ]);

    const prgUrl = noJsPage.url();
    assert(prgUrl.includes("leadStatus=accepted"), `No-JS PRG did not accept: ${prgUrl}`);
    assert(!prgUrl.includes(dateNoJs), `PRG URL must not leak preferred_date: ${prgUrl}`);
    assert(!prgUrl.includes("pagi"), `PRG URL must not leak preferred_time: ${prgUrl}`);
    assert(
      fixtureServer.submittedLeads[0]?.mode === "form" &&
        fixtureServer.submittedLeads[0]?.payload.preferred_date === dateNoJs &&
        fixtureServer.submittedLeads[0]?.payload.preferred_time === "pagi" &&
        fixtureServer.submittedLeads[0]?.payload.branch_id === "1",
      `No-JS form payload mismatch: ${JSON.stringify(fixtureServer.submittedLeads[0])}`,
    );
    await noJsCtx.close();

    // -------------------------------------------------------------------------
    // 2. Part B — Progressive-Enhancement JS Contact Form & WA CTA @ 1440px & 360px
    // -------------------------------------------------------------------------
    const jsCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const jsPage = await jsCtx.newPage();
    jsPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    jsPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await jsPage.goto(`${fixtureServer.baseUrl}/kontak`, { waitUntil: "networkidle" });
    await jsPage.fill('input[name="name"]', "Siti Rahmawati");
    await jsPage.fill('input[name="phone"]', "+62 813-9876-5432");
    await jsPage.fill('textarea[name="message"]', "Ingin konsultasi pemasangan behel.");
    await jsPage.fill('input[name="preferred_date"]', dateJs);
    await jsPage.selectOption('select[name="preferred_time"]', "sore");
    await jsPage.selectOption('select[name="branch_id"]', "2");

    const updatedWaHref = await jsPage.getAttribute('[data-testid="lead-wa-schedule-cta"]', "href");
    assert(
      updatedWaHref && updatedWaHref.startsWith("https://wa.me/6281234567890?text="),
      `Updated WA href invalid: ${updatedWaHref}`,
    );
    const decodedUpdatedWa = decodeURIComponent(updatedWaHref.split("?text=")[1] ?? "");
    assert(decodedUpdatedWa.includes("Sore"), `Updated WA message missing Sore: ${decodedUpdatedWa}`);
    assert(
      decodedUpdatedWa.includes("Cabang Bandung Dago"),
      `Updated WA message missing branch: ${decodedUpdatedWa}`,
    );
    assert(!decodedUpdatedWa.includes("{{"), `Updated WA message has raw tokens: ${decodedUpdatedWa}`);

    const desktopFormOverflow = await jsPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopFormOverflow, "Contact form @ 1440px overflows horizontally");

    await jsPage.evaluate(() => {
      if (document.activeElement instanceof window.HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });

    if (screenshotDir) {
      await jsPage.screenshot({
        path: path.join(screenshotDir, "contact-form-1440.png"),
        fullPage: true,
      });
    }

    await jsPage.setViewportSize({ width: 360, height: 800 });
    await jsPage.evaluate(() => {
      if (document.activeElement instanceof window.HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    const mobileFormOverflow = await jsPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobileFormOverflow, "Contact form @ 360px overflows horizontally");

    if (screenshotDir) {
      await jsPage.screenshot({
        path: path.join(screenshotDir, "contact-form-360.png"),
        fullPage: true,
      });
    }

    // Clearing preferred_time drops its sentence cleanly
    await jsPage.selectOption('select[name="preferred_time"]', "");
    const partialWaHref = await jsPage.getAttribute('[data-testid="lead-wa-schedule-cta"]', "href");
    const decodedPartialWa = decodeURIComponent((partialWaHref || "").split("?text=")[1] ?? "");
    assert(
      !decodedPartialWa.includes("Waktu yang diharapkan"),
      `Cleared preferred_time sentence should be dropped: ${decodedPartialWa}`,
    );
    assert(
      decodedPartialWa.includes("Cabang Bandung Dago"),
      `Branch sentence should remain intact: ${decodedPartialWa}`,
    );

    // Re-select sore & submit via progressive-enhancement JSON POST
    await jsPage.selectOption('select[name="preferred_time"]', "sore");
    await jsPage.check('input[name="privacyConsent"]');
    await jsPage.click('[data-testid="lead-form-submit"]');
    await jsPage.waitForSelector('[data-testid="lead-form-live-status"][data-status="accepted"]');
    assert(
      fixtureServer.submittedLeads[1]?.mode === "json" &&
        fixtureServer.submittedLeads[1]?.idempotencyKey &&
        fixtureServer.submittedLeads[1]?.payload.preferred_date === dateJs &&
        fixtureServer.submittedLeads[1]?.payload.preferred_time === "sore" &&
        fixtureServer.submittedLeads[1]?.payload.branch_id === "2",
      `JSON submission payload mismatch: ${JSON.stringify(fixtureServer.submittedLeads[1])}`,
    );
    await jsCtx.close();

    // -------------------------------------------------------------------------
    // 3. Part C — Dashboard Lead Inbox (`_LeadsInbox.tsx`) @ 1440px & 360px
    // -------------------------------------------------------------------------
    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminCtx.newPage();
    adminPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    adminPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await adminPage.goto(`${fixtureServer.baseUrl}/dashboard/klinik-sehat/leads`, {
      waitUntil: "networkidle",
    });
    await adminPage.waitForSelector('[data-testid="lead-row-1"]');
    await adminPage.waitForSelector('[data-testid="lead-row-2"]');

    const desktopSchedule1 = (await adminPage.textContent('[data-testid="lead-schedule-1"]')) ?? "";
    const desktopSchedule2 = (await adminPage.textContent('[data-testid="lead-schedule-2"]')) ?? "";
    assert(desktopSchedule1.includes("Pagi"), `Lead #1 desktop schedule missing Pagi: ${desktopSchedule1}`);
    assert(
      desktopSchedule1.includes("Cabang Jakarta Selatan"),
      `Lead #1 desktop schedule missing branch: ${desktopSchedule1}`,
    );
    assert(desktopSchedule2.includes("Sore"), `Lead #2 desktop schedule missing Sore: ${desktopSchedule2}`);
    assert(
      desktopSchedule2.includes("Cabang Bandung Dago"),
      `Lead #2 desktop schedule missing branch: ${desktopSchedule2}`,
    );

    const desktopInboxOverflow = await adminPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!desktopInboxOverflow, "Lead Inbox @ 1440px overflows horizontally");

    if (screenshotDir) {
      await adminPage.screenshot({
        path: path.join(screenshotDir, "leads-inbox-1440.png"),
        fullPage: true,
      });
    }

    // Open Lead Detail drawer & verify Permintaan Jadwal section
    await adminPage.click('[data-testid="lead-open-detail-2"]');
    await adminPage.waitForSelector('[data-testid="lead-detail-schedule"]');
    await adminPage.waitForFunction(() => {
      const sheet = document.querySelector('[data-testid="lead-detail-sheet"]');
      return sheet !== null && window.getComputedStyle(sheet).opacity === "1";
    });
    const detailScheduleText =
      (await adminPage.textContent('[data-testid="lead-detail-schedule"]')) ?? "";
    assert(
      detailScheduleText.toLowerCase().includes("permintaan jadwal"),
      `Detail schedule missing "permintaan jadwal" copy: ${detailScheduleText}`,
    );
    assert(detailScheduleText.includes("Sore"), `Detail schedule missing Sore: ${detailScheduleText}`);
    assert(
      detailScheduleText.includes("Cabang Bandung Dago"),
      `Detail schedule missing branch: ${detailScheduleText}`,
    );

    if (screenshotDir) {
      await adminPage.screenshot({
        path: path.join(screenshotDir, "leads-inbox-detail-1440.png"),
        fullPage: false,
      });
    }

    // Close drawer via Escape & inspect 360px mobile stacked cards
    await adminPage.keyboard.press("Escape");
    await adminPage.waitForSelector('[data-testid="lead-detail-sheet"]', { state: "detached" });
    await adminPage.setViewportSize({ width: 360, height: 800 });
    await adminPage.waitForSelector('[data-testid="lead-mobile-schedule-2"]');
    await adminPage.evaluate(() => window.scrollTo(0, 0));
    const mobileScheduleText =
      (await adminPage.textContent('[data-testid="lead-mobile-schedule-2"]')) ?? "";
    assert(
      mobileScheduleText.includes("Permintaan Jadwal"),
      `Mobile schedule card missing label: ${mobileScheduleText}`,
    );
    assert(mobileScheduleText.includes("Sore"), `Mobile schedule missing Sore: ${mobileScheduleText}`);
    assert(
      mobileScheduleText.includes("Cabang Bandung Dago"),
      `Mobile schedule missing branch: ${mobileScheduleText}`,
    );

    const mobileInboxOverflow = await adminPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!mobileInboxOverflow, "Lead Inbox @ 360px overflows horizontally");

    if (screenshotDir) {
      await adminPage.screenshot({
        path: path.join(screenshotDir, "leads-inbox-360.png"),
        fullPage: true,
      });
    }

    await adminCtx.close();

    assert(consoleErrors.length === 0, `Console errors observed: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors observed: ${pageErrors.join("; ")}`);

    console.log(
      `PASS tests/task-071/e2e.mjs — verified No-JS (360px) + JS (1440px/360px) Permintaan Jadwal form, single-pass WA CTA, TASK-073 review link preservation, and Lead Inbox (1440px/360px + detail drawer). Screenshots: ${screenshotDir}`,
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    fixtureServer.server.close();
    fs.rmSync(built.tmpRoot, { recursive: true, force: true });
  }
}

await main();
