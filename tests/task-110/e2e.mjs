/* global process, console, setTimeout, document, Buffer */
/**
 * TASK-110 E2E & Visual QA Browser Verification (Playwright Chromium).
 *
 * 1. Renders the real `monthly-owner-performance-report` HTML email template from
 *    `@punyasitus/core/email` at 375px (mobile), 680px, and 1440px (desktop), checking
 *    zero horizontal overflow and capturing screenshots to `/tmp/qa-task-110/`.
 * 2. Boots a real local `astro dev` server with local D1 + Better Auth owner session,
 *    visits `/dashboard/<handle>/settings/notifications` at 360px & 1440px, verifies
 *    enabled state, toggles opt-out OFF via the real CSRF-protected API, reloads to
 *    confirm persistence, captures both enabled & opted-out screenshots at 360px & 1440px,
 *    and toggles back ON with zero console/page errors and zero horizontal overflow.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { renderEmailTemplate } from "../../packages/core/src/email/templates.ts";
import {
  assertZeroVisitorPiiInMonthlyReport,
  buildMonthlyPerformanceReportSummary,
} from "../../packages/core/src/reports/index.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const screenshotDir = process.env.TASK110_SCREENSHOT_DIR || "/tmp/qa-task-110";

const TENANT_ID = "01JT110E2E0000000000000001";
const ORG_ID = "org_t110_e2e_studio";
const TENANT_HANDLE = "t110-studio";
const OWNER_EMAIL = "owner-t110-e2e@punyasitus.test";
const OWNER_PASSWORD = "StrongPassword!T110";

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

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body || null;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 25000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            buffer: buf,
            body: buf.toString("utf8"),
          });
        });
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

function ensureLocalD1Prepared() {
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

  const now = Date.now();
  const paidThrough = now + 30 * 24 * 60 * 60 * 1000;
  runLocalD1Sql(
    [
      `DELETE FROM platform_settings WHERE key = 'tenant_notifications:${TENANT_ID}';`,
      `DELETE FROM email_delivery_claims WHERE message_key LIKE 'monthly-report:${TENANT_ID}:%';`,
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('${ORG_ID}', 'Studio Karya Nusantara', '${TENANT_HANDLE}', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at) VALUES ('${TENANT_ID}', '${ORG_ID}', '${TENANT_HANDLE}', 'Studio Karya Nusantara', 'compro', 'active', 0, ${paidThrough}, 1, 0, 1, ${now}, ${now});`,
      `DELETE FROM tenant_hosts WHERE tenant_id = '${TENANT_ID}';`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('${TENANT_HANDLE}.situsku.click', '${TENANT_ID}', 'subdomain', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
      `INSERT OR REPLACE INTO email_delivery_claims (message_key, template, one_shot, status, provider, error_code, attempts, created_at, updated_at) VALUES ('monthly-report:${TENANT_ID}:2026-11', 'monthly-owner-performance-report', 1, 'submitted', 'cloudflare', NULL, 1, ${now}, ${now});`,
      `INSERT OR REPLACE INTO email_delivery_claims (message_key, template, one_shot, status, provider, error_code, attempts, created_at, updated_at) VALUES ('monthly-report:${TENANT_ID}:2026-10', 'monthly-owner-performance-report', 1, 'skipped', NULL, 'E_BELOW_ACTIVITY_THRESHOLD', 0, ${now - 86400000}, ${now - 86400000});`,
    ].join(" "),
  );
}

async function waitForServer(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
      if (res.status === 200 || res.status === 302) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`astro dev did not become ready on port ${port}`);
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

async function signUpOrSignInOwner(port) {
  const origin = `http://127.0.0.1:${port}`;
  let res = await httpRequest(port, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      name: "Rina Pemilik Studio",
    }),
  });

  if (res.status !== 200) {
    res = await httpRequest(port, "/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
      }),
    });
  }

  assert(res.status === 200, `Owner auth failed with status ${res.status}: ${res.body}`);
  const parsed = JSON.parse(res.body);
  const userId = parsed?.user?.id;
  assert(typeof userId === "string" && userId.length > 0, "Missing userId");

  const setCookieHeader = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  const sessionCookiePair = cookies
    .map((c) => c.split(";")[0])
    .find((pair) => pair && (pair.startsWith("__Host-ps_session=") || pair.includes("session")));
  assert(sessionCookiePair, `Missing session cookie in Set-Cookie: ${JSON.stringify(cookies)}`);

  const now = Date.now();
  runLocalD1Sql(
    `DELETE FROM members WHERE organization_id = '${ORG_ID}' AND user_id = '${userId}'; INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('mem_t110_owner_${now}', '${ORG_ID}', '${userId}', 'owner', ${now});`,
  );

  return { userId, cookieHeader: sessionCookiePair };
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth})`,
  );
}

async function main() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const savedScreenshots = [];

  const executablePath = findChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
  });

  let child;
  let logs = "";

  try {
    // -----------------------------------------------------------------------
    // Part A: Render Monthly Owner Performance Report HTML Email Template
    // -----------------------------------------------------------------------
    const summary = buildMonthlyPerformanceReportSummary({
      reportMonth: "2026-11",
      contentRows: [
        {
          day_utc: "2026-10-14",
          content_kind: "offering",
          content_id: 10,
          path: "/layanan/desain-identitas-brand",
          page_views: 110,
          wa_clicks: 14,
          external_clicks: 2,
          lead_submits: 6,
        },
        {
          day_utc: "2026-10-20",
          content_kind: "page",
          content_id: 1,
          path: "/",
          page_views: 180,
          wa_clicks: 8,
          external_clicks: 0,
          lead_submits: 3,
        },
        {
          day_utc: "2026-11-08",
          content_kind: "offering",
          content_id: 10,
          path: "/layanan/desain-identitas-brand",
          page_views: 164,
          wa_clicks: 26,
          external_clicks: 3,
          lead_submits: 11,
        },
        {
          day_utc: "2026-11-18",
          content_kind: "page",
          content_id: 1,
          path: "/",
          page_views: 248,
          wa_clicks: 12,
          external_clicks: 1,
          lead_submits: 4,
        },
      ],
      sourceRows: [
        {
          day_utc: "2026-10-15",
          source_bucket: "ai_assistant",
          utm_source: "chatgpt.com",
          page_views: 7,
          wa_clicks: 1,
          external_clicks: 0,
          lead_submits: 0,
        },
        {
          day_utc: "2026-11-12",
          source_bucket: "ai_assistant",
          utm_source: "chatgpt.com",
          page_views: 15,
          wa_clicks: 3,
          external_clicks: 0,
          lead_submits: 1,
        },
      ],
      offeringTitles: {
        byId: new Map([[10, "Desain Identitas Brand UMKM"]]),
      },
    });

    const renderedEmail = renderEmailTemplate("monthly-owner-performance-report", {
      recipientName: "Ibu Rina",
      tenantName: "Studio Karya Nusantara",
      tenantHandle: TENANT_HANDLE,
      reportMonth: summary.period.reportMonth,
      reportMonthLabel: summary.period.reportMonthLabelId,
      comparisonMonthLabel: summary.period.comparisonMonthLabelId,
      visits: summary.current.visits,
      leads: summary.current.leads,
      whatsappClicks: summary.current.whatsappClicks,
      aiAssistantReferrals: summary.current.aiAssistantReferrals,
      momVisits: { direction: summary.mom.visits.direction, labelId: summary.mom.visits.labelId },
      momLeads: { direction: summary.mom.leads.direction, labelId: summary.mom.leads.labelId },
      momWhatsappClicks: {
        direction: summary.mom.whatsappClicks.direction,
        labelId: summary.mom.whatsappClicks.labelId,
      },
      momAiAssistantReferrals: {
        direction: summary.mom.aiAssistantReferrals.direction,
        labelId: summary.mom.aiAssistantReferrals.labelId,
      },
      topOffering: summary.topOffering
        ? {
            title: summary.topOffering.title,
            path: summary.topOffering.path,
            visits: summary.topOffering.visits,
            whatsappClicks: summary.topOffering.whatsappClicks,
            leads: summary.topOffering.leads,
          }
        : null,
      actionableTip: summary.actionableTip,
      dashboardInsightsUrl: `https://app.punyasitus.com/dashboard/${TENANT_HANDLE}/insights`,
      notificationSettingsUrl: `https://app.punyasitus.com/dashboard/${TENANT_HANDLE}/settings/notifications`,
    });

    assertZeroVisitorPiiInMonthlyReport(renderedEmail);

    const emailPage = await browser.newPage();
    await emailPage.setContent(renderedEmail.html, { waitUntil: "load" });
    for (const vp of [
      { name: "mobile-375", width: 375, height: 812 },
      { name: "desktop-680", width: 680, height: 960 },
      { name: "desktop-1440", width: 1440, height: 960 },
    ]) {
      await emailPage.setViewportSize({ width: vp.width, height: vp.height });
      await assertNoHorizontalOverflow(emailPage, `email-${vp.name}`);
      const outPath = path.join(screenshotDir, `email-report-${vp.name}.png`);
      await emailPage.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }
    await emailPage.close();

    // -----------------------------------------------------------------------
    // Part B: Real Astro Dev Server Notification Settings Page & Toggle E2E
    // -----------------------------------------------------------------------
    ensureLocalD1Prepared();

    const port = await getFreePort();
    const persistTo = path.join(webDir, ".wrangler/state");
    child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persistTo,
      ],
      {
        cwd: webDir,
        env: cleanChildEnv({
          PUNYASITUS_ALLOW_DEV_HOSTS: "1",
          PUNYASITUS_DISABLE_DEV_TOOLBAR: "1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (d) => (logs += d.toString()));
    child.stderr.on("data", (d) => (logs += d.toString()));

    await waitForServer(port);
    const owner = await signUpOrSignInOwner(port);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        Cookie: owner.cookieHeader,
      },
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const notifUrl = `http://127.0.0.1:${port}/dashboard/${TENANT_HANDLE}/settings/notifications`;
    const resp = await page.goto(notifUrl, { waitUntil: "networkidle" });
    assert(resp && resp.status() === 200, `Expected 200 on ${notifUrl}, got ${resp?.status()}`);

    await page.getByTestId("monthly-report-toggle").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("monthly-report-toggle").getAttribute("aria-checked")) === "true",
      "Expected initial monthly report toggle to be enabled (aria-checked=true)",
    );
    assert(
      (await page.getByTestId("monthly-report-status-badge").textContent())?.trim() === "Aktif",
      "Expected initial status badge to read Aktif",
    );

    // Enabled screenshots at 360px & 1440px
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await assertNoHorizontalOverflow(page, `notifications-enabled-${vp.name}`);
      const outPath = path.join(screenshotDir, `notifications-enabled-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }

    // Toggle OFF via real API + verify persistence across reload
    await page.getByTestId("monthly-report-toggle").click();
    await page.getByTestId("notification-feedback").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("monthly-report-toggle").getAttribute("aria-checked")) === "false",
      "Expected toggle aria-checked=false after opting out",
    );
    assert(
      (await page.getByTestId("monthly-report-status-badge").textContent())?.trim() === "Nonaktif",
      "Expected status badge to read Nonaktif after opting out",
    );

    // Reload to verify durable persistence in local D1
    await page.reload({ waitUntil: "networkidle" });
    assert(
      (await page.getByTestId("monthly-report-toggle").getAttribute("aria-checked")) === "false",
      "Expected opted-out state to persist across page reload",
    );

    // Opted-out screenshots at 360px & 1440px
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await assertNoHorizontalOverflow(page, `notifications-opted-out-${vp.name}`);
      const outPath = path.join(screenshotDir, `notifications-opted-out-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }

    // Toggle back ON to prove bidirectional toggle works
    await page.getByTestId("monthly-report-toggle").click();
    await page.getByTestId("notification-feedback").waitFor({ state: "visible" });
    assert(
      (await page.getByTestId("monthly-report-toggle").getAttribute("aria-checked")) === "true",
      "Expected toggle aria-checked=true after re-enabling",
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    await context.close();
    console.log("TASK-110 E2E & Visual QA PASSED");
    console.log("Screenshots saved:");
    for (const s of savedScreenshots) {
      console.log(`  - ${s}`);
    }
  } catch (err) {
    console.error("TASK-110 E2E FAILED:", err);
    if (logs) console.error("Astro dev logs:\n", logs.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (child) child.kill("SIGTERM");
  }
}

await main();
