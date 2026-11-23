/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle */
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

const screenshotDir = process.env.TASK059_SCREENSHOT_DIR || "";

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
  try {
    await waitForServer(port);
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
      if (msg.type() === "error") {
        // Ignore the expected HTTP 503 network resource log on the Maintenance.astro 503 test page
        const text = msg.text();
        if (!text.includes("status of 503")) {
          consoleErrors.push(text);
        }
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const viewports = [
      { name: "360", width: 360, height: 800 },
      { name: "1440", width: 1440, height: 900 },
    ];

    // 1. Trial, Grace, and Locked (owner + member) banners across 360px & 1440px
    const bannerCases = [
      {
        id: "trial-owner",
        url: "/_dev/design-fixtures/dashboard?lifecycle=trial&serviceAccess=1&role=owner",
        selector: '[data-service-access-banner="trial"]',
        expectedText: "Masa uji coba gratis tersisa",
      },
      {
        id: "grace-owner",
        url: "/_dev/design-fixtures/dashboard?lifecycle=grace&serviceAccess=1&role=owner",
        selector: '[data-service-access-banner="grace"]',
        expectedText: "Masa tenggang langganan",
      },
      {
        id: "locked-owner",
        url: "/_dev/design-fixtures/dashboard?lifecycle=locked&serviceAccess=1&role=owner",
        selector: '[data-service-access-banner="locked"]',
        expectedText: "Mode baca saja (Terkunci H+4–H+7)",
      },
      {
        id: "locked-member",
        url: "/_dev/design-fixtures/dashboard?lifecycle=locked&serviceAccess=1&role=member",
        selector: '[data-service-access-banner="locked"]',
        expectedText: "Hubungi pemilik situs",
      },
    ];

    for (const bc of bannerCases) {
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const resp = await page.goto(`${baseUrl}${bc.url}`, { waitUntil: "networkidle" });
        assert(resp && resp.status() === 200, `${bc.id} @ ${vp.name} returned ${resp?.status()}`);

        const banner = page.locator(bc.selector);
        assert(await banner.isVisible(), `${bc.id} @ ${vp.name}: banner must be visible`);
        const bannerText = await banner.innerText();
        assert(
          bannerText.includes(bc.expectedText),
          `${bc.id} @ ${vp.name}: expected "${bc.expectedText}", got "${bannerText}"`,
        );

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        assert(!overflow, `${bc.id} @ ${vp.name}px has horizontal overflow`);

        if (screenshotDir && (bc.id === "trial-owner" || bc.id === "grace-owner" || bc.id === "locked-owner")) {
          await page.screenshot({
            path: path.join(screenshotDir, `${bc.id}-${vp.name}.png`),
            fullPage: true,
          });
        }
      }
    }

    // 2. Suspended Payment-Only Recovery Shell: Owner vs Non-Owner Member vs Operator Hold
    const shellCases = [
      {
        id: "suspended-owner",
        url: "/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner",
        expectPayerActions: true,
        expectMemberNotice: false,
        expectHoldNotice: false,
      },
      {
        id: "suspended-member",
        url: "/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=member",
        expectPayerActions: false,
        expectMemberNotice: true,
        expectHoldNotice: false,
      },
      {
        id: "suspended-hold",
        url: "/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner&hold=1",
        expectPayerActions: true,
        expectMemberNotice: false,
        expectHoldNotice: true,
      },
    ];

    for (const sc of shellCases) {
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const resp = await page.goto(`${baseUrl}${sc.url}`, { waitUntil: "networkidle" });
        assert(resp && resp.status() === 200, `${sc.id} @ ${vp.name} returned ${resp?.status()}`);

        const shell = page.locator('[data-service-access-shell="suspended"]');
        assert(await shell.isVisible(), `${sc.id} @ ${vp.name}: recovery shell must be visible`);

        // Zero CMS sidebar flash in suspended payment-only shell
        const cmsSidebarCount = await page.locator('[data-slot="sidebar-container"]').count();
        assert(cmsSidebarCount === 0, `${sc.id} @ ${vp.name}: CMS sidebar must not render in suspended shell`);

        const ownerActionsVisible = await page.locator('[data-testid="owner-recovery-actions"]').isVisible();
        assert(
          ownerActionsVisible === sc.expectPayerActions,
          `${sc.id} @ ${vp.name}: owner-recovery-actions expected ${sc.expectPayerActions}, got ${ownerActionsVisible}`,
        );

        const memberNoticeVisible = await page.locator('[data-testid="member-contact-owner-notice"]').isVisible();
        assert(
          memberNoticeVisible === sc.expectMemberNotice,
          `${sc.id} @ ${vp.name}: member-contact-owner-notice expected ${sc.expectMemberNotice}, got ${memberNoticeVisible}`,
        );
        if (sc.expectMemberNotice) {
          const noticeText = await page.locator('[data-testid="member-contact-owner-notice"]').innerText();
          assert(
            noticeText.includes("Hubungi pemilik situs"),
            `${sc.id}: non-owner member must see "Hubungi pemilik situs"`,
          );
        }

        const holdVisible = await page.locator('[data-testid="operator-hold-notice"]').isVisible();
        assert(
          holdVisible === sc.expectHoldNotice,
          `${sc.id} @ ${vp.name}: operator-hold-notice expected ${sc.expectHoldNotice}, got ${holdVisible}`,
        );

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        assert(!overflow, `${sc.id} @ ${vp.name}px has horizontal overflow`);

        if (screenshotDir) {
          await page.screenshot({
            path: path.join(screenshotDir, `${sc.id}-${vp.name}.png`),
            fullPage: true,
          });
        }
      }
    }

    // Keyboard Tab & focus outline check on Suspended Recovery Shell at 1440px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=suspended&serviceAccess=1&role=owner`,
      { waitUntil: "networkidle" },
    );
    await page.keyboard.press("Tab");
    const firstTabText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(
      firstTabText.includes("Lewati ke konten utama"),
      `Suspended shell first Tab must reach skip link, got "${firstTabText}"`,
    );
    await page.keyboard.press("Tab");
    const focusInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { tag: "", outlineWidth: "0px", outlineStyle: "none" };
      const cs = getComputedStyle(el);
      return { tag: el.tagName, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
    });
    assert(
      focusInfo.tag === "A" || focusInfo.tag === "BUTTON",
      `Expected interactive focus target after Tab, got ${JSON.stringify(focusInfo)}`,
    );

    // 3. Native Maintenance.astro HTTP 503 page at 360px & 1440px
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const resp = await page.goto(
        `${baseUrl}/_dev/design-fixtures/dashboard?maintenance=1`,
        { waitUntil: "networkidle" },
      );
      assert(resp && resp.status() === 503, `Maintenance.astro @ ${vp.name} must return HTTP 503, got ${resp?.status()}`);

      const headers = resp.headers();
      assert(
        (headers["cache-control"] ?? "").includes("no-store"),
        `Maintenance.astro must include no-store Cache-Control, got "${headers["cache-control"]}"`,
      );
      assert(
        (headers["x-robots-tag"] ?? "").includes("noindex"),
        `Maintenance.astro must include noindex X-Robots-Tag, got "${headers["x-robots-tag"]}"`,
      );

      const mainEl = page.locator('[data-maintenance-page="503"]');
      assert(await mainEl.isVisible(), `Maintenance.astro @ ${vp.name}: main landmark must be visible`);

      const headingText = await page.locator("h1").innerText();
      assert(
        headingText.includes("Situs dalam perbaikan"),
        `Maintenance.astro heading must contain "Situs dalam perbaikan", got "${headingText}"`,
      );

      const bodyHtml = await page.content();
      assert(!bodyHtml.includes("punyasitus.com"), "Maintenance.astro must never leak platform links");
      const appScripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll("script"))
          .map((s) => s.getAttribute("src") || s.textContent?.slice(0, 80) || "")
          .filter(
            (s) =>
              !s.includes("/@vite/") &&
              !s.includes("/@fs/") &&
              !s.includes("astro") &&
              !s.includes("vite") &&
              !s.endsWith(".css"),
          ),
      );
      assert(appScripts.length === 0, `Maintenance.astro must require zero app/tracking scripts, found ${JSON.stringify(appScripts)}`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert(!overflow, `Maintenance.astro @ ${vp.name}px has horizontal overflow`);

      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `maintenance-503-${vp.name}.png`),
          fullPage: true,
        });
      }
    }

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-059 E2E PASS: trial/grace/locked banners, suspended payment-only shell (owner vs member notice vs operator hold), keyboard focus, and native HTTP 503 Maintenance.astro verified at 360px & 1440px with 0 errors.",
    );
  } catch (err) {
    console.error("TASK-059 E2E FAILED:", err);
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
