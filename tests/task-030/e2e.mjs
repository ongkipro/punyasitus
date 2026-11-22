/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle, fetch */
/**
 * TASK-030 E2E Browser Verification (Playwright Chromium at 360px, 768px, 1440px & 200% zoom).
 *
 * Verifies `/dashboard/alpha-studio` end-to-end with real TASK-025 Better Auth `__Host-ps_session`
 * authentication and `alpha-studio` organization membership in local D1:
 * - Unauthenticated `/dashboard/alpha-studio` redirects `302` to `/auth/login`.
 * - Authenticated non-member/unknown handle returns `404`.
 * - Authenticated member renders first-party KPIs (`Klik WhatsApp`, `Klik tautan eksternal`,
 *   `Pesan masuk (lead)`, `Kunjungan halaman`) with `tabular-nums`.
 * - Explicitly labels clicks as visitor interest signals (`sinyal minat pengunjung`),
 *   NEVER as confirmed purchases or completed sales.
 * - Zero horizontal overflow at 360px, 768px, 1440px, and 200% zoom (640px CSS width).
 * - Period range switcher (`7 hari terakhir` / `30 hari terakhir`) works with `aria-current="page"`.
 * - Keyboard navigation reaches skip link & controls with visible >= 2px focus outline.
 * - `/api/events` rejects non-tenant loopback requests with 404.
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

const screenshotDir = process.env.TASK030_SCREENSHOT_DIR || "";

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
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 5000 },
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
  runLocalD1Sql(
    [
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_probe_alpha', 'Alpha Studio', 'alpha-studio', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at) VALUES ('01JFX00000000000000000000A', 'org_probe_alpha', 'alpha-studio', 'Alpha Studio', 'compro', 'active', 0, 1, 1, 1, ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('alpha-studio.situsku.click', '01JFX00000000000000000000A', 'subdomain', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
    ].join(" "),
  );
}

async function waitForServer(port, timeoutMs = 30_000) {
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

    // 1. Verify unauthenticated redirect & non-tenant /api/events 404 via direct HTTP
    const unauthDashRes = await httpRequest(port, "/dashboard/alpha-studio");
    assert(
      unauthDashRes.status === 302 &&
        String(unauthDashRes.headers.location ?? "").includes("/auth/login"),
      `Unauthenticated /dashboard/alpha-studio must redirect 302 to /auth/login, got ${unauthDashRes.status} (${String(unauthDashRes.headers.location ?? "")})`,
    );

    const nonTenantEventRes = await httpRequest(port, "/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ eventType: "wa_click", path: "/" }),
    });
    assert(
      nonTenantEventRes.status === 404,
      `POST /api/events without verified tenant host must return 404, got ${nonTenantEventRes.status}`,
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

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1b. Authenticate a real fixture member of `alpha-studio` via Better Auth + local D1 membership
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const e2eEmail = `e2e.t030.${uniqueSuffix}@example.test`;
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signupResult = await page.evaluate(
      async ({ email }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email,
            password: "E2ePassword!123",
            name: "Pemilik Alpha E2E",
          }),
        });
        const body = await res.json();
        return { status: res.status, userId: body?.user?.id ?? "" };
      },
      { email: e2eEmail },
    );
    assert(
      signupResult.status === 200 && signupResult.userId,
      `E2E fixture signup failed: ${JSON.stringify(signupResult)}`,
    );

    const safeUserId = String(signupResult.userId).replace(/[^a-zA-Z0-9_-]/g, "");
    const memberId = `mem_t030_${Date.now()}`;
    const nowMs = Date.now();
    runLocalD1Sql(
      `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at) VALUES ('${memberId}', 'org_probe_alpha', '${safeUserId}', 'owner', ${nowMs});`,
    );

    // Authenticated unknown/non-member handle MUST return 404
    const unknownRes = await page.goto(`${baseUrl}/dashboard/tenant-tidak-ada-999`, {
      waitUntil: "networkidle",
    });
    assert(
      unknownRes && unknownRes.status() === 404,
      `Authenticated unknown dashboard handle must return 404, got ${unknownRes?.status()}`,
    );
    consoleErrors.length = 0;

    // 2. Render /dashboard/alpha-studio across 360px, 768px, and 1440px
    const viewports = [
      { name: "360", width: 360, height: 800 },
      { name: "768", width: 768, height: 1024 },
      { name: "1440", width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const resp = await page.goto(`${baseUrl}/dashboard/alpha-studio`, {
        waitUntil: "networkidle",
      });
      assert(resp && resp.status() === 200, `/dashboard/alpha-studio @ ${vp.name} returned ${resp?.status()}`);
      assert(
        (resp.headers()["x-robots-tag"] ?? "").includes("noindex"),
        `Dashboard response must set X-Robots-Tag: noindex`,
      );

      const snapshot = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth > window.innerWidth;
        const disclaimerEl = document.querySelector('[data-testid="metrics-interest-disclaimer"]');
        const disclaimerText = disclaimerEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const bodyText = document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const metricIds = ["wa_clicks", "external_clicks", "lead_submits", "pageviews"];
        const metrics = metricIds.map((id) => {
          const card = document.querySelector(`[data-metric="${id}"]`);
          const val = document.querySelector(`[data-metric-value="${id}"]`);
          const cs = val ? getComputedStyle(val) : null;
          return {
            id,
            present: Boolean(card && val),
            text: card?.textContent?.replace(/\s+/g, " ").trim() ?? "",
            valueText: val?.textContent?.trim() ?? "",
            fontVariantNumeric: cs?.fontVariantNumeric ?? "",
          };
        });
        const range7 = document.querySelector('[data-testid="range-7d"]');
        const range30 = document.querySelector('[data-testid="range-30d"]');
        return {
          overflow,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          disclaimerText,
          bodyText,
          metrics,
          range7Rect: range7 ? range7.getBoundingClientRect() : null,
          range30Rect: range30 ? range30.getBoundingClientRect() : null,
          range7Current: range7?.getAttribute("aria-current") ?? null,
        };
      });

      assert(
        !snapshot.overflow,
        `/dashboard/alpha-studio @ ${vp.name}px has horizontal overflow (${snapshot.scrollWidth} > ${snapshot.innerWidth})`,
      );

      // Verify all 4 KPI cards exist with expected Indonesian labels & tabular-nums
      const expectedLabels = {
        wa_clicks: "Klik WhatsApp",
        external_clicks: "Klik tautan eksternal",
        lead_submits: "Pesan masuk (lead)",
        pageviews: "Kunjungan halaman",
      };
      for (const m of snapshot.metrics) {
        assert(m.present, `KPI card ${m.id} missing @ ${vp.name}px`);
        assert(
          m.text.includes(expectedLabels[m.id]),
          `KPI ${m.id} missing label "${expectedLabels[m.id]}", got "${m.text}"`,
        );
        assert(
          m.fontVariantNumeric.includes("tabular-nums"),
          `KPI ${m.id} must use tabular-nums, got "${m.fontVariantNumeric}"`,
        );
      }

      // Verify explicit interest-signal disclaimer (never calls clicks confirmed purchases)
      assert(
        snapshot.disclaimerText.toLowerCase().includes("sinyal minat pengunjung") &&
          snapshot.disclaimerText.toLowerCase().includes("bukan konfirmasi penjualan"),
        `Disclaimer must state clicks are interest signals, not confirmed sales. Got: "${snapshot.disclaimerText}"`,
      );
      assert(
        !snapshot.bodyText.toLowerCase().includes("pembelian terkonfirmasi") &&
          !snapshot.bodyText.toLowerCase().includes("confirmed purchase"),
        `Dashboard must never label clicks as confirmed purchases`,
      );
      assert(snapshot.range7Current === "page", `7-day range link must default to aria-current="page"`);

      if (vp.width === 360) {
        assert(
          snapshot.range7Rect && snapshot.range7Rect.height >= 44,
          `Mobile range-7d touch target must be >= 44px, got ${snapshot.range7Rect?.height}`,
        );
        assert(
          snapshot.range30Rect && snapshot.range30Rect.height >= 44,
          `Mobile range-30d touch target must be >= 44px, got ${snapshot.range30Rect?.height}`,
        );
      }

      if (screenshotDir && (vp.width === 360 || vp.width === 1440)) {
        await page.screenshot({
          path: path.join(screenshotDir, `dashboard-alpha-studio-${vp.name}.png`),
          fullPage: true,
        });
      }
    }

    // 3. Switch period to 30 days and verify active state
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/dashboard/alpha-studio`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="range-30d"]').click();
    await page.waitForURL("**/dashboard/alpha-studio?range=30");
    const range30Current = await page.locator('[data-testid="range-30d"]').getAttribute("aria-current");
    assert(range30Current === "page", `30-day range must be active after click, got ${range30Current}`);

    // 4. Keyboard navigation & visible focus ring at 1440px
    await page.goto(`${baseUrl}/dashboard/alpha-studio`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const firstTabText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(
      firstTabText.includes("Lewati ke konten utama"),
      `First Tab must reach skip link, got "${firstTabText}"`,
    );
    await page.keyboard.press("Tab");
    const outlineStyle = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { outlineWidth: "0px", outlineStyle: "none" };
      const cs = getComputedStyle(el);
      return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
    });
    assert(
      outlineStyle.outlineStyle !== "none" && parseFloat(outlineStyle.outlineWidth) >= 2,
      `Keyboard focus must show >= 2px outline, got ${JSON.stringify(outlineStyle)}`,
    );

    // 5. 200% zoom simulation (640px CSS width) -> zero horizontal overflow
    await page.setViewportSize({ width: 640, height: 450 });
    await page.goto(`${baseUrl}/dashboard/alpha-studio`, { waitUntil: "networkidle" });
    const zoomOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!zoomOverflow, "200% zoom (640px CSS width) must not cause horizontal overflow");

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-030 E2E PASS: /dashboard/alpha-studio verified at 360/768/1440px + 200% zoom, 4 tabular-nums KPIs, explicit interest-signal disclaimer, 7d/30d switcher, keyboard focus ring, 404 guards, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-030 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs ---\n", logs.slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

await main();
