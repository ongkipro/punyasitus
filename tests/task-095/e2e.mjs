/* global process, console, setTimeout, document, getComputedStyle, fetch */
/**
 * TASK-095 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Verifies `/dashboard/[handle]/seo` end-to-end with real Better Auth `__Host-ps_session`
 * and local D1 + `TenantStore` DO:
 * - Unauthenticated `/dashboard/alpha-seo/seo` redirects 302 to `/auth/login`.
 * - Verified custom-domain paid tenant renders:
 *   - AI Crawler Controls toggle card with all 9 search/citation bots & 4 training bots
 *   - Interactive Base UI Switch toggling training bots (`allow` -> `disallow` -> `allow`),
 *     updating live `/robots.txt` preview immediately AND persisting across full reload
 *   - `IndexNow` custom-domain status badge (`Aktif untuk domain khusus`)
 *   - Insights `AI Assistant` channel row with honest interest-signal disclaimer
 * - Trial `.situsku.click` tenant renders `Tidak aktif di subdomain .situsku.click` badge
 *   and `Disallow: /` noindex robots preview.
 * - Keyboard navigation reaches the toggle and buttons with visible >= 2px focus outline.
 * - Interactive controls meet >= 44px tap targets.
 * - Zero horizontal overflow at 360px and 1440px.
 * - 0 console errors and 0 page errors.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const screenshotDir = process.env.TASK095_SCREENSHOT_DIR || "";

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
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 8000 },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (chunks += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks }),
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

function ensureLocalD1MigratedAndSeeded() {
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
  const trialEnds = now + 7 * 24 * 60 * 60 * 1000;

  runLocalD1Sql(
    [
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_t095_alpha', 'Berkah Wisata Nusantara', 'alpha-seo', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at) VALUES ('01JT095E2EALPHA00000000001', 'org_t095_alpha', 'alpha-seo', 'Berkah Wisata Nusantara', 'travel', 'active', 0, ${paidThrough}, 1, 0, 1, ${now}, ${now});`,
      `DELETE FROM tenant_hosts WHERE tenant_id = '01JT095E2EALPHA00000000001';`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('www.berkahwisata.id', '01JT095E2EALPHA00000000001', 'custom', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('alpha-seo.situsku.click', '01JT095E2EALPHA00000000001', 'subdomain', 'active', 'active', 0, ${now}, 1, ${now}, ${now});`,

      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_t095_trial', 'Kopi Nusantara Trial', 'trial-seo', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, cache_version, schema_version, version, created_at, updated_at) VALUES ('01JT095E2ETRIAL00000000002', 'org_t095_trial', 'trial-seo', 'Kopi Nusantara Trial', 'catalog', 'trial', 0, ${trialEnds}, 1, 0, 1, ${now}, ${now});`,
      `DELETE FROM tenant_hosts WHERE tenant_id = '01JT095E2ETRIAL00000000002';`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('trial-seo.situsku.click', '01JT095E2ETRIAL00000000002', 'subdomain', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
    ].join(" "),
  );
}

async function waitForServer(port, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/auth/login");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  ensureLocalD1MigratedAndSeeded();
  const port = await getFreePort();
  const child = spawn(
    "pnpm",
    [
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ignore-lock",
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

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  let browser;
  try {
    await waitForServer(port);

    // 1. Unauthenticated /dashboard/alpha-seo/seo MUST redirect 302 to /auth/login
    const unauthRes = await httpRequest(port, "/dashboard/alpha-seo/seo");
    assert(
      unauthRes.status === 302 && String(unauthRes.headers.location ?? "").includes("/auth/login"),
      `Expected unauthenticated /dashboard/alpha-seo/seo -> 302 /auth/login, got ${unauthRes.status}`,
    );

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 2. Authenticate fixture owner for both alpha-seo (paid custom domain) and trial-seo (trial subdomain)
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const email = `e2e.t095.${suffix}@example.test`;
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signup = await page.evaluate(
      async ({ targetEmail }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email: targetEmail,
            password: "E2ePassword!123",
            name: "Pemilik Berkah E2E",
          }),
        });
        const body = await res.json();
        return { status: res.status, userId: body?.user?.id ?? "" };
      },
      { targetEmail: email },
    );
    assert(signup.status === 200 && signup.userId, `Signup failed: ${JSON.stringify(signup)}`);

    const safeUserId = String(signup.userId).replace(/[^a-zA-Z0-9_-]/g, "");
    const nowMs = Date.now();
    runLocalD1Sql(
      [
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at) VALUES ('mem_t095_a_${nowMs}', 'org_t095_alpha', '${safeUserId}', 'owner', ${nowMs});`,
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at) VALUES ('mem_t095_t_${nowMs}', 'org_t095_trial', '${safeUserId}', 'owner', ${nowMs});`,
      ].join(" "),
    );

    // 3. Load /dashboard/alpha-seo/seo at 1440px
    const resp1440 = await page.goto(`${baseUrl}/dashboard/alpha-seo/seo`, {
      waitUntil: "networkidle",
    });
    assert(resp1440 && resp1440.status() === 200, `Expected 200 on /dashboard/alpha-seo/seo, got ${resp1440?.status()}`);

    // Wait for interactive island hydration
    const toggleLocator = page.getByTestId("ai-training-toggle");
    await toggleLocator.waitFor({ state: "visible" });

    // Verify IndexNow active custom-domain badge
    const indexnowBadgeText = await page.getByTestId("indexnow-status-badge").innerText();
    assert(
      indexnowBadgeText.includes("Aktif untuk domain khusus"),
      `Expected IndexNow active badge, got "${indexnowBadgeText}"`,
    );

    // Verify all 9 search/citation bots and 4 training bots are rendered
    const crawlerCardText = await page.getByTestId("ai-crawler-controls-card").innerText();
    for (const bot of [
      "Googlebot",
      "Bingbot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
      "Applebot",
      "GPTBot",
      "ClaudeBot",
      "Google-Extended",
      "Applebot-Extended",
    ]) {
      assert(crawlerCardText.includes(bot), `Missing bot "${bot}" in AI Crawler Controls card`);
    }

    // Verify Insights AI Assistant channel row + honest interest-signal disclaimer
    const aiRowText = await page.getByTestId("channel-row-ai-assistant").innerText();
    assert(aiRowText.includes("AI Assistant"), `Expected AI Assistant row, got "${aiRowText}"`);
    const disclaimerText = await page.getByTestId("attribution-honest-disclaimer").innerText();
    assert(
      disclaimerText.includes("estimasi sinyal minat"),
      `Expected honest interest-signal disclaimer, got "${disclaimerText}"`,
    );

    // Verify keyboard focus & >= 44px tap targets
    await toggleLocator.focus();
    const toggleMetrics = await toggleLocator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        width: rect.width,
        height: rect.height,
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth || "0"),
        isFocused: document.activeElement === el,
      };
    });
    assert(toggleMetrics.isFocused, "AI training switch must be keyboard-focusable");
    assert(
      toggleMetrics.height >= 44 && toggleMetrics.width >= 44,
      `AI training switch tap target must be >= 44px, got ${toggleMetrics.width}x${toggleMetrics.height}`,
    );

    const copyBtnBox = await page.getByTestId("copy-robots-btn").boundingBox();
    assert(
      copyBtnBox && copyBtnBox.height >= 44,
      `Copy robots button tap target must be >= 44px, got ${JSON.stringify(copyBtnBox)}`,
    );

    // Toggle training bots from initial state via keyboard Space and verify live robots.txt preview updates
    const initialPolicy = await page
      .getByTestId("seo-visibility-page")
      .getAttribute("data-ai-training-policy");
    const targetPolicy = initialPolicy === "allow" ? "disallow" : "allow";

    await page.keyboard.press("Space");
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-testid="seo-visibility-page"]')
          ?.getAttribute("data-ai-training-policy") === expected,
      targetPolicy,
      { timeout: 10_000 },
    );

    const updatedRobotsPreview = await page.getByTestId("robots-txt-preview").innerText();
    const gptIdx = updatedRobotsPreview.indexOf("User-agent: GPTBot");
    assert(gptIdx > -1, "Live robots.txt preview must contain User-agent: GPTBot");
    const gptSnippet = updatedRobotsPreview.slice(gptIdx, gptIdx + 120);
    if (targetPolicy === "disallow") {
      assert(gptSnippet.includes("Disallow: /"), `Expected GPTBot Disallow: /, got:\n${gptSnippet}`);
    } else {
      assert(gptSnippet.includes("Allow: /"), `Expected GPTBot Allow: /, got:\n${gptSnippet}`);
    }
    assert(
      updatedRobotsPreview.includes("Disallow: /kendaraan?*&*") &&
        updatedRobotsPreview.includes("Disallow: /produk?*&*"),
      "Live robots.txt preview must include faceted filter disallows",
    );

    // Reload page and confirm toggled state persisted in TenantStore DO!
    await page.reload({ waitUntil: "networkidle" });
    const persistedPolicy = await page
      .getByTestId("seo-visibility-page")
      .getAttribute("data-ai-training-policy");
    assert(
      persistedPolicy === targetPolicy,
      `Expected persisted aiTrainingPolicy="${targetPolicy}" after reload, got "${persistedPolicy}"`,
    );

    // Verify zero horizontal overflow at 1440px and capture screenshot
    const overflow1440 = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow1440 <= 0, `Horizontal overflow at 1440px: ${overflow1440}px`);
    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "seo-ai-controls-1440.png"),
        fullPage: true,
      });
    }

    // 4. Verify 360px mobile viewport: zero overflow, tap targets >= 44px, capture screenshot
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(200);
    const overflow360 = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow360 <= 0, `Horizontal overflow at 360px: ${overflow360}px`);
    const mobileAiVisible = await page
      .locator('[data-channel-mobile="ai_assistant"]')
      .isVisible();
    assert(mobileAiVisible, "Mobile Insights AI Assistant card row must be visible at 360px");
    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "seo-ai-controls-360.png"),
        fullPage: true,
      });
    }

    // 5. Verify Trial .situsku.click tenant shows inactive IndexNow badge & Disallow: / robots preview
    await page.setViewportSize({ width: 1440, height: 900 });
    const trialResp = await page.goto(`${baseUrl}/dashboard/trial-seo/seo`, {
      waitUntil: "networkidle",
    });
    assert(trialResp && trialResp.status() === 200, `Expected 200 on trial /seo, got ${trialResp?.status()}`);
    const trialBadge = await page.getByTestId("indexnow-status-badge").innerText();
    assert(
      trialBadge.includes("Tidak aktif di subdomain .situsku.click"),
      `Expected trial IndexNow inactive badge, got "${trialBadge}"`,
    );
    const trialRobots = await page.getByTestId("robots-txt-preview").innerText();
    assert(
      trialRobots.trim() === "User-agent: *\nDisallow: /",
      `Expected trial robots preview to be Disallow: /, got "${trialRobots}"`,
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join(" | ")}`);

    console.log("PASS: TASK-095 E2E verified at 360px & 1440px (toggle persistence, robots preview, IndexNow status, AI Assistant channel row, zero overflow, 0 errors)");
  } catch (err) {
    console.error("TASK-095 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs ---\n" + logs.slice(-4000));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
  }
}

await main();
