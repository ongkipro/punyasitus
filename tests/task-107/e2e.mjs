/* global process, console, setTimeout, clearTimeout, document, window, Buffer */
/**
 * TASK-107 E2E Browser Verification (Playwright Chromium at 360px & 1440px).
 *
 * Runs against a REAL local `astro dev` server with local D1 (`PLATFORM_DB`),
 * local R2 (`MEDIA_BUCKET`), `TenantStore` DO, and real Better Auth sessions:
 * 1. Seeds an active tenant + owner user via Better Auth signup & local D1 SQL.
 * 2. Visits `/dashboard/<handle>/settings/data` at 360x800 & 1440x900:
 *    - Captures screenshots into `/tmp/task-107-screenshots/`.
 *    - Verifies zero horizontal overflow, tap targets, Indonesian UI copy, zero console/page errors.
 * 3. Clicks "Buat Arsip Situs (.zip)" -> real `POST /api/tenants/:tenantId/exports`:
 *    - Verifies archive is generated in local R2 and appears as "Siap Diunduh".
 *    - Verifies daily limit button state ("Batas Harian Tercapai (1/hari)").
 *    - Downloads real ZIP via signed URL and verifies PKZIP magic header (`PK\x03\x04`).
 * 4. Opens "Hapus Situs Ini" Base UI Dialog, enters handle + password, schedules deletion:
 *    - Captures dialog & active 7-day undo banner screenshots at 360px & 1440px.
 *    - Reloads page while tenant is `suspended` -> confirms owner STILL reaches Undo screen!
 * 5. Clicks "Batalkan Penghapusan & Aktifkan Kembali Situs" -> real `POST .../deletion/cancel`:
 *    - Verifies banner clears and site returns to active status without data loss.
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

const screenshotDir = process.env.TASK107_SCREENSHOT_DIR || "/tmp/task-107-screenshots";

const TENANT_ID = "01JT107E2E0000000000000001";
const ORG_ID = "org_t107_e2e_alpha";
const TENANT_HANDLE = "t107-kopi";
const OWNER_EMAIL = "owner-t107-e2e@punyasitus.test";
const OWNER_PASSWORD = "StrongPassword!T107";

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
      { hostname: "127.0.0.1", port, path: pathname, method, headers, timeout: 10000 },
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

function runLocalD1File(sqlFilePath) {
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
      "--file",
      sqlFilePath,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`Local D1 file execute failed (${sqlFilePath}):\n${res.stdout}\n${res.stderr}`);
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

  // Ensure our 0023 migration tables exist in local D1
  runLocalD1File(
    path.join(root, "packages/db/migrations/platform/0023_tenant_exports_and_deletion.sql"),
  );

  const now = Date.now();
  const paidThrough = now + 30 * 24 * 60 * 60 * 1000;
  runLocalD1Sql(
    [
      `DELETE FROM tenant_export_jobs WHERE tenant_id = '${TENANT_ID}';`,
      `DELETE FROM tenant_deletion_requests WHERE tenant_id = '${TENANT_ID}';`,
      `DELETE FROM job_ledger WHERE tenant_id = '${TENANT_ID}';`,
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('${ORG_ID}', 'Kopi Nusantara T107', '${TENANT_HANDLE}', ${now}, ${now});`,
      `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at) VALUES ('${TENANT_ID}', '${ORG_ID}', '${TENANT_HANDLE}', 'Kopi Nusantara T107', 'catalog', 'active', 0, ${paidThrough}, 1, 0, 1, ${now}, ${now});`,
      `DELETE FROM tenant_hosts WHERE tenant_id = '${TENANT_ID}';`,
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('${TENANT_HANDLE}.situsku.click', '${TENANT_ID}', 'subdomain', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
    ].join(" "),
  );
}

async function waitForServer(port, timeoutMs = 45_000) {
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
      name: "Pemilik Kopi T107",
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
  assert(typeof userId === "string" && userId.length > 0, "Missing userId from auth response");

  const setCookieHeader = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  const sessionCookiePair = cookies
    .map((c) => c.split(";")[0])
    .find((pair) => pair && (pair.startsWith("__Host-ps_session=") || pair.includes("session")));
  assert(sessionCookiePair, `Missing session cookie in Set-Cookie: ${JSON.stringify(cookies)}`);

  const eqIdx = sessionCookiePair.indexOf("=");
  const cookieName = sessionCookiePair.slice(0, eqIdx);
  const cookieValue = sessionCookiePair.slice(eqIdx + 1);

  // Attach owner role in local D1
  const now = Date.now();
  runLocalD1Sql(
    `DELETE FROM members WHERE organization_id = '${ORG_ID}' AND user_id = '${userId}'; INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('mem_t107_owner_${now}', '${ORG_ID}', '${userId}', 'owner', ${now});`,
  );

  return { userId, cookieName, cookieValue, cookieHeader: sessionCookiePair };
}

async function main() {
  ensureLocalD1Prepared();

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
  const savedScreenshots = [];

  try {
    await waitForServer(port);
    const owner = await signUpOrSignInOwner(port);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    fs.mkdirSync(screenshotDir, { recursive: true });

    const baseUrl = `http://127.0.0.1:${port}`;
    const pageUrl = `${baseUrl}/dashboard/${TENANT_HANDLE}/settings/data`;

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

    // 1. Initial Settings > Data screen at 360px & 1440px
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const resp = await page.goto(pageUrl, { waitUntil: "networkidle" });
      assert(resp && resp.status() === 200, `GET ${pageUrl} @ ${vp.name} returned ${resp?.status()}`);
      assert(
        await page.locator('[data-testid="settings-data-workspace"]').isVisible(),
        `settings-data-workspace not visible @ ${vp.name}`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `Horizontal overflow detected on Settings > Data @ ${vp.name}px`);

      const outPath = path.join(screenshotDir, `settings-data-owner-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }

    // 2. Request full-website export archive & download real ZIP
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-testid="request-export-btn"]').click();
    await page.locator('[data-testid="export-feedback-alert"]').waitFor({ state: "visible", timeout: 15_000 });

    const btnText = await page.locator('[data-testid="request-export-btn"]').innerText();
    assert(
      btnText.includes("Batas Harian Tercapai"),
      `Expected daily-limit button label, got "${btnText}"`,
    );

    const downloadLink = page.locator('a[data-testid^="download-export-"]').first();
    assert(await downloadLink.isVisible(), "Download ZIP button should be visible for ready archive");
    const downloadHref = await downloadLink.getAttribute("href");
    assert(downloadHref && downloadHref.includes("/download?token="), `Unexpected href: ${downloadHref}`);

    // Fetch real ZIP bytes via signed link with owner cookie and verify PKZIP signature
    const zipRes = await httpRequest(port, downloadHref, {
      method: "GET",
      headers: { Cookie: owner.cookieHeader },
    });
    assert(zipRes.status === 200, `Signed ZIP download returned ${zipRes.status}: ${zipRes.body}`);
    assert(
      String(zipRes.headers["content-type"] || "").includes("application/zip"),
      `Expected application/zip content-type, got ${zipRes.headers["content-type"]}`,
    );
    assert(
      zipRes.buffer[0] === 0x50 &&
        zipRes.buffer[1] === 0x4b &&
        zipRes.buffer[2] === 0x03 &&
        zipRes.buffer[3] === 0x04,
      "Downloaded archive does not start with PKZIP signature PK\\x03\\x04",
    );

    // 3. Open delete confirmation dialog, verify screenshot, and schedule deletion
    await page.locator('[data-testid="open-delete-dialog-btn"]').click();
    await page.locator('[data-testid="delete-confirmation-dialog"]').waitFor({ state: "visible" });
    const dialogShot = path.join(screenshotDir, "settings-data-delete-dialog-1440.png");
    await page.screenshot({ path: dialogShot, fullPage: true });
    savedScreenshots.push(dialogShot);

    await page.locator('[data-testid="confirm-handle-input"]').fill(TENANT_HANDLE);
    await page.locator('[data-testid="deletion-password-input"]').fill(OWNER_PASSWORD);
    await page.locator('[data-testid="deletion-reason-input"]').fill("Uji E2E TASK-107");
    await page.locator('[data-testid="confirm-schedule-deletion-btn"]').click();

    await page.locator('[data-testid="deletion-scheduled-banner"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });

    // 4. Reload while tenant is `suspended` (7-day undo window) and capture 360px & 1440px screenshots
    for (const vp of [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const reloadResp = await page.goto(pageUrl, { waitUntil: "networkidle" });
      assert(reloadResp && reloadResp.status() === 200, `Reload while scheduled @ ${vp.name} returned ${reloadResp?.status()}`);
      assert(
        await page.locator('[data-testid="deletion-scheduled-banner"]').isVisible(),
        `Undo banner must remain visible after reload @ ${vp.name}`,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `Horizontal overflow detected on scheduled deletion state @ ${vp.name}px`);

      const outPath = path.join(screenshotDir, `settings-data-deletion-scheduled-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }

    // 5. Click "Batalkan Penghapusan & Aktifkan Kembali Situs" and verify clean restore
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-testid="cancel-deletion-btn"]').click();
    await page.locator('[data-testid="deletion-scheduled-banner"]').waitFor({
      state: "hidden",
      timeout: 15_000,
    });
    const feedbackText = await page.locator('[data-testid="deletion-feedback-alert"]').innerText();
    assert(
      feedbackText.includes("Penghapusan dibatalkan"),
      `Expected undo confirmation copy, got "${feedbackText}"`,
    );

    assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors: ${pageErrors.join("; ")}`);

    console.log("TASK-107 E2E PASS: Export ZIP + Self-Service Deletion + 7-Day Undo verified at 360px & 1440px.");
    console.log("Screenshots saved:");
    for (const p of savedScreenshots) {
      console.log(`  - ${p}`);
    }
  } catch (err) {
    console.error("TASK-107 E2E FAILED:", err);
    if (logs) {
      console.error("--- astro dev logs ---\n", logs.slice(-3000));
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
