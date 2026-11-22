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

const screenshotDir = process.env.TASK032_SCREENSHOT_DIR || "";

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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
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
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--password-store=basic",
      ],
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

    // 1. Check all 4 shells across 360px, 768px, and 1440px
    const shells = [
      { id: "dashboard", url: "/_dev/design-fixtures/dashboard" },
      { id: "dashboard-agency-ctx", url: "/_dev/design-fixtures/dashboard?agencyContext=1" },
      { id: "agency", url: "/_dev/design-fixtures/agency" },
      { id: "affiliate", url: "/_dev/design-fixtures/affiliate" },
      { id: "console", url: "/_dev/design-fixtures/console" },
    ];
    const viewports = [
      { name: "360", width: 360, height: 800 },
      { name: "768", width: 768, height: 1024 },
      { name: "1440", width: 1440, height: 900 },
    ];

    for (const shell of shells) {
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const resp = await page.goto(`${baseUrl}${shell.url}`, { waitUntil: "networkidle" });
        assert(resp && resp.status() === 200, `${shell.id} @ ${vp.name} returned ${resp?.status()}`);

        const metrics = await page.evaluate(() => {
          const overflow = document.documentElement.scrollWidth > window.innerWidth;
          const sidebar = document.querySelector('[data-slot="sidebar-container"]');
          const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
          const mobileNav = document.querySelector('[data-slot="mobile-bottom-nav"]');
          const mobileNavRect = mobileNav ? mobileNav.getBoundingClientRect() : null;
          const mobileSlots = mobileNav
            ? Array.from(mobileNav.querySelectorAll("a, button")).map((el) => {
                const r = el.getBoundingClientRect();
                return { width: r.width, height: r.height, text: el.textContent?.trim() };
              })
            : [];
          const header = document.querySelector('header[data-slot="admin-topbar"]');
          const headerHeight = header ? Math.round(header.getBoundingClientRect().height) : 0;
          const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
          return {
            overflow,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            sidebarWidth: sidebarRect ? Math.round(sidebarRect.width) : 0,
            mobileNavVisible: Boolean(mobileNavRect && mobileNavRect.height > 0),
            mobileSlots,
            headerHeight,
            htmlFontSize,
          };
        });

        assert(
          !metrics.overflow,
          `${shell.id} @ ${vp.name}px has horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
        );
        assert(metrics.htmlFontSize === 16, `${shell.id} @ ${vp.name}px root fontSize must be 16px, got ${metrics.htmlFontSize}`);
        assert(metrics.headerHeight === 56, `${shell.id} @ ${vp.name}px topbar must be 56px, got ${metrics.headerHeight}`);

        if (vp.width === 1440) {
          assert(metrics.sidebarWidth === 256, `${shell.id} @ 1440px sidebar must be 256px, got ${metrics.sidebarWidth}`);
          assert(!metrics.mobileNavVisible, `${shell.id} @ 1440px mobile bottom nav must be hidden`);
        } else if (vp.width === 768) {
          assert(metrics.sidebarWidth === 48, `${shell.id} @ 768px icon rail must be 48px, got ${metrics.sidebarWidth}`);
          assert(!metrics.mobileNavVisible, `${shell.id} @ 768px mobile bottom nav must be hidden`);
        } else if (vp.width === 360) {
          assert(metrics.sidebarWidth === 0, `${shell.id} @ 360px desktop sidebar must be hidden`);
          assert(metrics.mobileNavVisible, `${shell.id} @ 360px mobile bottom nav must be visible`);
          assert(metrics.mobileSlots.length === 5, `${shell.id} @ 360px must have 5 bottom slots, got ${metrics.mobileSlots.length}`);
          for (const slot of metrics.mobileSlots) {
            assert(slot.height >= 44 && slot.width >= 44, `${shell.id} @ 360px slot "${slot.text}" below 44px target (${slot.width}x${slot.height})`);
          }
        }

        if (shell.id === "console") {
          const badgeText = await page.locator('[data-testid="console-identity-badge"]').innerText();
          assert(
            badgeText.includes("Console Operasional Platform"),
            `Console topbar must state Console Operasional Platform, got "${badgeText}"`,
          );
        }

        if (shell.id === "dashboard-agency-ctx") {
          const barVisible = await page.locator('[data-testid="agency-client-context-bar"]').isVisible();
          assert(barVisible, `Agency client-context bar must be visible at ${vp.name}px`);
        }

        if (screenshotDir && (vp.width === 360 || vp.width === 1440)) {
          await page.screenshot({
            path: path.join(screenshotDir, `${shell.id}-${vp.name}.png`),
            fullPage: true,
          });
        }
      }
    }

    // 2. Mobile "Lainnya" Sheet drawer keyboard Escape + focus restoration at 360px
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${baseUrl}/_dev/design-fixtures/dashboard`, { waitUntil: "networkidle" });
    const moreTrigger = page.locator('[data-testid="mobile-more-trigger"]');
    await moreTrigger.focus();
    await page.keyboard.press("Enter");
    const drawer = page.locator('[data-testid="mobile-more-drawer"]');
    await drawer.waitFor({ state: "visible", timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mobile-more-drawer"]');
      return el && parseFloat(getComputedStyle(el).opacity) >= 0.99;
    });
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, "mobile-more-drawer-360.png") });
    }
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 5000 });
    const focusedAfterEsc = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    );
    assert(
      focusedAfterEsc === "mobile-more-trigger",
      `Focus must return to mobile-more-trigger after Escape, got "${focusedAfterEsc}"`,
    );

    // 3. Keyboard Tab navigation & visible focus indicator at 1440px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/_dev/design-fixtures/dashboard`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const firstTabText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(firstTabText.includes("Lewati ke konten utama"), `First Tab must reach skip link, got "${firstTabText}"`);
    await page.keyboard.press("Tab");
    const outlineStyle = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { outlineWidth: "0px", outlineStyle: "none" };
      const cs = getComputedStyle(el);
      return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
    });
    assert(
      outlineStyle.outlineStyle !== "none" && parseFloat(outlineStyle.outlineWidth) >= 2,
      `Keyboard focus must show >=2px outline, got ${JSON.stringify(outlineStyle)}`,
    );

    // 4. All key states: loading, empty-first-run, empty-filtered, error (input preserved on retry), permission-denied, conflict
    for (const st of ["loading", "empty-first-run", "empty-filtered", "error", "permission-denied", "conflict"]) {
      await page.goto(`${baseUrl}/_dev/design-fixtures/dashboard?state=${st}`, { waitUntil: "networkidle" });
      const panelSelector =
        st === "conflict" ? '[data-state-panel="conflict-409"]' : `[data-state-panel="${st}"]`;
      const visible = await page.locator(panelSelector).isVisible();
      assert(visible, `State panel ${st} must be visible`);

      if (st === "error") {
        const input = page.locator("#error-preserved-title");
        await input.fill("Paket Pemeriksaan Gigi Keluarga");
        await page.locator('[data-testid="retry-action"]').click();
        const afterRetryVal = await input.inputValue();
        assert(
          afterRetryVal === "Paket Pemeriksaan Gigi Keluarga",
          `Retryable error must preserve user input, got "${afterRetryVal}"`,
        );
      }

      if (screenshotDir && (st === "empty-first-run" || st === "error")) {
        await page.screenshot({
          path: path.join(screenshotDir, `state-${st}-1440.png`),
          fullPage: true,
        });
      }
    }

    // 5. All lifecycle banners: trial, grace, locked, suspended
    for (const lc of ["trial", "grace", "locked", "suspended"]) {
      await page.goto(`${baseUrl}/_dev/design-fixtures/dashboard?lifecycle=${lc}`, { waitUntil: "networkidle" });
      const bannerVisible = await page.locator(`[data-lifecycle-banner="${lc}"]`).isVisible();
      assert(bannerVisible, `Lifecycle banner ${lc} must be visible`);
      if (screenshotDir && lc === "grace") {
        await page.screenshot({
          path: path.join(screenshotDir, "lifecycle-grace-1440.png"),
          fullPage: true,
        });
      }
    }

    // 6. 200% zoom check (simulate 200% zoom by halving CSS viewport from 1440->720 & 1280->640 and checking zero horizontal overflow)
    await page.setViewportSize({ width: 640, height: 450 });
    await page.goto(`${baseUrl}/_dev/design-fixtures/dashboard`, { waitUntil: "networkidle" });
    const zoomOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert(!zoomOverflow, "200% zoom (640px CSS width) must not cause horizontal overflow");

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-032 E2E PASS: 4 shells x 3 viewports (360/768/1440), agency context bar, console identity, 5-slot mobile nav + Escape focus return, keyboard focus ring, 6 UI states (retry preserves input), 4 lifecycle banners, 200% zoom, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-032 E2E FAILED:", err);
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
