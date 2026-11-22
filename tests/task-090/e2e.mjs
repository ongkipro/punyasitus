/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle */
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

const screenshotDir = process.env.TASK090_SCREENSHOT_DIR || "";

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

function ensureLocalD1Migrated() {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
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
  if (res.status !== 0) {
    throw new Error(`Local D1 migrations failed:\n${res.stdout}\n${res.stderr}`);
  }
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
      const res = await httpGet(port, "/auth/login");
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

async function assertViewportLayoutAndTouchTargets(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll("main button, main a[href], main input"),
    )
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim() || "",
          width: Math.round(r.width),
          height: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      })
      .filter((c) => c.visible);

    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      controls,
    };
  });

  assert(
    !metrics.overflow,
    `[${label} @ ${width}px] Horizontal overflow detected (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize === 16,
    `[${label} @ ${width}px] Root font-size must be 16px, got ${metrics.htmlFontSize}`,
  );
  if (width === 360) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `[${label} @ 360px] Control ${ctrl.tag}#${ctrl.id} height ${ctrl.height}px < 44px touch target`,
      );
    }
  }
}

async function main() {
  ensureLocalD1Migrated();

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

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Verify /auth/login @ 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/auth/login returned ${res?.status()}`);
      assert(
        (res.headers()["cache-control"] ?? "").includes("no-store"),
        `/auth/login must send Cache-Control: no-store, got ${res.headers()["cache-control"]}`,
      );
      assert(
        (res.headers()["x-robots-tag"] ?? "").includes("noindex"),
        `/auth/login must send X-Robots-Tag: noindex, nofollow, got ${res.headers()["x-robots-tag"]}`,
      );

      const googleBtn = page.locator('[data-testid="google-signin-button"]');
      const emailInput = page.locator("#login-email");
      await googleBtn.waitFor({ state: "visible" });
      await emailInput.waitFor({ state: "visible" });

      const googleText = (await googleBtn.innerText()).trim();
      assert(
        googleText.includes("Masuk dengan Google"),
        `Primary CTA must read "Masuk dengan Google", got "${googleText}"`,
      );

      const googleBox = await googleBtn.boundingBox();
      const emailBox = await emailInput.boundingBox();
      assert(
        googleBox && emailBox && googleBox.y < emailBox.y,
        `Primary Google CTA must sit above email fallback (google.y=${googleBox?.y}, email.y=${emailBox?.y})`,
      );

      // Accessible honeypot & inert Turnstile slot present
      const hpAttrs = await page.evaluate(() => {
        const el = document.querySelector('input[name="hp_website"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          ariaHidden: el.getAttribute("aria-hidden"),
          tabIndex: el.getAttribute("tabindex"),
          width: r.width,
          height: r.height,
        };
      });
      assert(hpAttrs !== null, "Honeypot input[name=hp_website] must exist on /auth/login");
      assert(hpAttrs.ariaHidden === "true", "Honeypot must have aria-hidden=true");
      assert(hpAttrs.tabIndex === "-1", "Honeypot must have tabindex=-1");
      assert(
        hpAttrs.width === 0 && hpAttrs.height === 0,
        `Honeypot must be zero-size, got ${JSON.stringify(hpAttrs)}`,
      );

      assert(
        (await page.locator('[data-testid="turnstile-slot"]').count()) === 1,
        "Turnstile slot must exist on /auth/login",
      );

      await assertViewportLayoutAndTouchTargets(page, "/auth/login", vp.width);

      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `task090-login-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // Keyboard navigation & visible focus ring on Google CTA
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab"); // skip link
    await page.keyboard.press("Tab"); // header brand link
    await page.keyboard.press("Tab"); // primary Google CTA
    const focusedOnGoogle = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        testId: el.getAttribute("data-testid"),
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth),
      };
    });
    assert(
      focusedOnGoogle?.testId === "google-signin-button",
      `Third Tab should focus primary Google CTA, got ${JSON.stringify(focusedOnGoogle)}`,
    );
    assert(
      focusedOnGoogle.outlineStyle !== "none" && focusedOnGoogle.outlineWidth >= 2,
      `Google CTA keyboard focus must show >=2px outline, got ${JSON.stringify(focusedOnGoogle)}`,
    );

    // 2. Verify /auth/register @ 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/auth/register`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/auth/register returned ${res?.status()}`);
      assert(
        (res.headers()["cache-control"] ?? "").includes("no-store"),
        `/auth/register must send Cache-Control: no-store`,
      );
      assert(
        (res.headers()["x-robots-tag"] ?? "").includes("noindex"),
        `/auth/register must send X-Robots-Tag: noindex, nofollow`,
      );

      const googleSignupBtn = page.locator('[data-testid="google-signup-button"]');
      const nameInput = page.locator("#register-name");
      await googleSignupBtn.waitFor({ state: "visible" });
      await nameInput.waitFor({ state: "visible" });

      const googleText = (await googleSignupBtn.innerText()).trim();
      assert(
        googleText.includes("Masuk dengan Google"),
        `Register primary CTA must read "Masuk dengan Google", got "${googleText}"`,
      );

      const googleBox = await googleSignupBtn.boundingBox();
      const nameBox = await nameInput.boundingBox();
      assert(
        googleBox && nameBox && googleBox.y < nameBox.y,
        `Register Google CTA must sit above email registration form`,
      );

      assert(
        (await page.locator('[data-testid="turnstile-slot"]').count()) === 1,
        "Turnstile slot must exist on /auth/register",
      );

      await assertViewportLayoutAndTouchTargets(page, "/auth/register", vp.width);

      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `task090-register-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // Inline validation announcements & preserved input on /auth/register
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/auth/register`, { waitUntil: "networkidle" });
    await page.locator("#register-name").fill("Siti Rahma");
    await page.locator("#register-email").fill("bukan-email");
    await page.locator("#register-password").fill("pendek");
    await page.locator('[data-testid="register-submit"]').click();

    const regEmailErr = page.locator("#register-email-error");
    await regEmailErr.waitFor({ state: "visible" });
    assert((await regEmailErr.getAttribute("role")) === "alert", "Email error must have role=alert");
    assert(
      (await page.locator("#register-name").inputValue()) === "Siti Rahma",
      "Name input must be preserved on validation failure",
    );

    // End-to-end registration via /auth/register form -> sets __Host-ps_session and navigates to /account
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const regEmail = `e2e.t090.${uniqueSuffix}@example.test`;
    await page.locator("#register-email").fill(regEmail);
    await page.locator("#register-password").fill("DaftarBaru!123");
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/account", { timeout: 15_000 }),
      page.locator('[data-testid="register-submit"]').click(),
    ]);

    const cookies = await context.cookies(baseUrl);
    assert(
      cookies.some((c) => c.name === "__Host-ps_session"),
      `Expected __Host-ps_session after registration, got ${JSON.stringify(cookies.map((c) => c.name))}`,
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-090 E2E PASS: /auth/login & /auth/register verified at 360px & 1440px with primary 'Masuk dengan Google' CTA above email fallback, keyboard focus ring, >=44px mobile touch targets, zero horizontal overflow, honeypot + Turnstile slot, no-store/noindex headers, inline validation, real email registration flow, and 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-090 E2E FAILED:", err);
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
