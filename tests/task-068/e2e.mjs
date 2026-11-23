/* global process, console, setTimeout, clearTimeout, document, window */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const screenshotDir =
  process.env.TASK068_SCREENSHOT_DIR || "/tmp/punyasitus-t068-screenshots";

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

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method: "GET", timeout: 4000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, "/_dev/design-fixtures");
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
    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    fs.mkdirSync(screenshotDir, { recursive: true });

    const baseUrl = `http://127.0.0.1:${port}`;
    const consoleErrors = [];
    const pageErrors = [];

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const viewports = [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ];

    // 1. Payment-only Suspended Recovery Shell (Paid H+45 Owner):
    //    Must show clear Indonesian deletion date + owner-only Leads CSV Export button + zero CMS sidebar
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const resp = await page.goto(
        `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner`,
        { waitUntil: "networkidle" },
      );
      assert(resp && resp.status() === 200, `paid-suspended-owner @ ${vp.name} returned ${resp?.status()}`);

      const shell = page.locator('[data-service-access-shell="suspended"]');
      assert(await shell.isVisible(), `paid-suspended-owner @ ${vp.name}: shell must be visible`);

      const sidebarCount = await page.locator('[data-slot="sidebar-container"]').count();
      assert(sidebarCount === 0, `paid-suspended-owner @ ${vp.name}: zero CMS sidebar allowed`);

      const dueBox = page.locator('[data-testid="deletion-due-date"]');
      assert(await dueBox.isVisible(), `paid-suspended-owner @ ${vp.name}: deletion-due-date must be visible`);
      const dueText = await dueBox.innerText();
      assert(
        dueText.includes("Jadwal penghapusan permanen") && dueText.includes("H+45") && dueText.includes("WIB"),
        `paid-suspended-owner @ ${vp.name}: unexpected deletion due copy: "${dueText}"`,
      );

      const exportBtn = page.locator('[data-testid="recovery-leads-export-btn"]');
      assert(await exportBtn.isVisible(), `paid-suspended-owner @ ${vp.name}: owner Leads CSV Export button must be visible`);
      const exportText = await exportBtn.innerText();
      assert(
        exportText.includes("Ekspor Prospek (CSV)"),
        `paid-suspended-owner @ ${vp.name}: unexpected export label "${exportText}"`,
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `paid-suspended-owner @ ${vp.name}px has horizontal overflow`);

      const outPath = path.join(screenshotDir, `suspended-paid-owner-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      savedScreenshots.push(outPath);
    }

    // 2. Payment-only Suspended Recovery Shell (Trial Expired +30d Owner)
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const resp = await page.goto(
        `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner&reason=trial_expired`,
        { waitUntil: "networkidle" },
      );
      assert(resp && resp.status() === 200, `trial-suspended-owner @ ${vp.name} returned ${resp?.status()}`);

      const dueBox = page.locator('[data-testid="deletion-due-date"]');
      assert(await dueBox.isVisible(), `trial-suspended-owner @ ${vp.name}: deletion-due-date must be visible`);
      const dueText = await dueBox.innerText();
      assert(
        dueText.includes("Trial + 30 hari") && dueText.includes("WIB"),
        `trial-suspended-owner @ ${vp.name}: expected Trial + 30 hari WIB, got "${dueText}"`,
      );

      const exportBtn = page.locator('[data-testid="recovery-leads-export-btn"]');
      assert(await exportBtn.isVisible(), `trial-suspended-owner @ ${vp.name}: owner export button must be visible`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `trial-suspended-owner @ ${vp.name}px has horizontal overflow`);
    }

    // 3. Payment-only Suspended Recovery Shell (Non-Owner Member):
    //    Leads CSV Export MUST be hidden; contact-owner notice visible
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=member`,
      { waitUntil: "networkidle" },
    );
    assert(
      (await page.locator('[data-testid="recovery-leads-export-btn"]').count()) === 0,
      "Non-owner member MUST NOT see Leads CSV Export button",
    );
    assert(
      await page.locator('[data-testid="member-contact-owner-notice"]').isVisible(),
      "Non-owner member must see contact-owner notice",
    );

    // 4. Operator Hold: deletion clock paused notice visible
    await page.goto(
      `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner&hold=1`,
      { waitUntil: "networkidle" },
    );
    const pausedBox = page.locator('[data-testid="deletion-clock-paused"]');
    assert(await pausedBox.isVisible(), "Operator hold must display deletion-clock-paused notice");
    const pausedText = await pausedBox.innerText();
    assert(
      pausedText.includes("dijeda") && pausedText.includes("14 hari"),
      `Expected paused + 14 hari copy, got "${pausedText}"`,
    );
    const holdPath = path.join(screenshotDir, "suspended-operator-hold-1440.png");
    await page.screenshot({ path: holdPath, fullPage: true });
    savedScreenshots.push(holdPath);

    // 5. Locked Owner Banner at 360px & 1440px: deletion date + owner-only Leads CSV Export button
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(
        `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=locked&serviceAccess=1&role=owner`,
        { waitUntil: "networkidle" },
      );
      const lockedDue = page.locator('[data-testid="locked-deletion-due-date"]');
      assert(await lockedDue.isVisible(), `locked-owner @ ${vp.name}: locked-deletion-due-date must be visible`);
      const lockedExport = page.locator('[data-testid="locked-leads-export-btn"]');
      assert(await lockedExport.isVisible(), `locked-owner @ ${vp.name}: locked-leads-export-btn must be visible`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `locked-owner @ ${vp.name}px has horizontal overflow`);

      const lockedPath = path.join(screenshotDir, `locked-owner-${vp.name}.png`);
      await page.screenshot({ path: lockedPath, fullPage: true });
      savedScreenshots.push(lockedPath);
    }

    // 6. Keyboard Tab accessibility check on Suspended Payment-Only Shell
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner`,
      { waitUntil: "networkidle" },
    );
    await page.keyboard.press("Tab");
    const firstFocused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(
      firstFocused.includes("Lewati ke konten utama"),
      `Expected skip link on first Tab, got "${firstFocused}"`,
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log("TASK-068 E2E PASS: payment-only shell & locked banner verified at 360x800 and 1440x900.");
    console.log("Screenshots saved:");
    for (const p of savedScreenshots) {
      console.log(`  - ${p}`);
    }
  } catch (err) {
    console.error("TASK-068 E2E FAILED:", err);
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
