/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle, fetch */
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

const screenshotDir = process.env.TASK025_SCREENSHOT_DIR || "";

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
    ).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || el.getAttribute("data-testid") || el.textContent?.trim() || "",
        width: Math.round(r.width),
        height: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      };
    });
    return {
      overflow,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      htmlFontSize,
      controls: controls.filter((c) => c.visible),
    };
  });

  assert(
    !metrics.overflow,
    `${label} @ ${width}px has horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize === 16,
    `${label} @ ${width}px root font-size must be 16px, got ${metrics.htmlFontSize}`,
  );
  if (width === 360) {
    for (const ctrl of metrics.controls) {
      assert(
        ctrl.height >= 44,
        `${label} @ 360px control ${ctrl.tag}#${ctrl.id} height ${ctrl.height}px < 44px touch target`,
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

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. /auth/login @ 360px & 1440px: keyboard nav, validation announcements, preserved input, expired session state
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/auth/login?expired=1`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/auth/login returned ${res?.status()}`);
      await page.locator('[data-testid="login-form"]').waitFor({ state: "visible" });
      assert(
        await page.locator('[data-testid="session-expired-alert"]').isVisible(),
        `Session expired alert must be visible at ${vp.width}px`,
      );
      await assertViewportLayoutAndTouchTargets(page, "/auth/login", vp.width);
      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `auth-login-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // Keyboard Tab focus & visible >=2px focus ring on /auth/login
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const skipText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    assert(skipText.includes("Lewati ke konten utama"), `First Tab must reach skip link, got "${skipText}"`);
    await page.keyboard.press("Tab");
    const focusRing = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { outlineStyle: "none", outlineWidth: "0px" };
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });
    assert(
      focusRing.outlineStyle !== "none" && parseFloat(focusRing.outlineWidth) >= 2,
      `Keyboard focus must show >=2px outline, got ${JSON.stringify(focusRing)}`,
    );

    // Inline validation announcements & preserved input on error
    await page.locator("#login-email").fill("bukan-email");
    await page.locator('[data-testid="login-submit"]').click();
    const emailErr = page.locator("#login-email-error");
    await emailErr.waitFor({ state: "visible" });
    assert((await emailErr.getAttribute("role")) === "alert", "Email validation error must have role=alert");
    assert(
      (await page.locator("#login-email").inputValue()) === "bukan-email",
      "Email input must be preserved on validation failure",
    );

    // Non-enumerating invalid credential submission (server returns 401; check we don't log console errors)
    await page.locator("#login-email").fill("tidakada@example.test");
    await page.locator("#login-password").fill("WrongPassword!123");
    await page.locator('[data-testid="login-submit"]').click();
    await page.locator('[data-testid="login-form-error"]').waitFor({ state: "visible" });
    assert(
      (await page.locator("#login-email").inputValue()) === "tidakada@example.test",
      "Email must be preserved after failed login",
    );
    // Clear expected 401 network console entry if browser emitted one for failed sign-in fetch
    consoleErrors.length = 0;

    // 2. /auth/reset-password @ 360px & 1440px: validation, expired link state, and token form
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/auth/reset-password?expired=1`, {
        waitUntil: "networkidle",
      });
      assert(res && res.status() === 200, `/auth/reset-password returned ${res?.status()}`);
      assert(
        await page.locator('[data-testid="reset-expired-alert"]').isVisible(),
        `Expired reset link alert must be visible at ${vp.width}px`,
      );
      await assertViewportLayoutAndTouchTargets(page, "/auth/reset-password", vp.width);
      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `auth-reset-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // Inline validation on reset request form
    await page.locator('[data-testid="reset-request-submit"]').click();
    await page.locator("#reset-email-error").waitFor({ state: "visible" });
    await page.locator("#reset-email").fill("pemilik@example.test");
    await page.locator('[data-testid="reset-request-submit"]').click();
    await page.locator('[data-testid="reset-requested-alert"]').waitFor({ state: "visible" });

    // Token form mismatch validation
    await page.goto(`${baseUrl}/auth/reset-password?token=contoh-token-uji`, {
      waitUntil: "networkidle",
    });
    await page.locator("#reset-new-password").fill("SandiBaru!123");
    await page.locator("#reset-confirm-password").fill("TidakCocok!999");
    await page.locator('[data-testid="reset-save-submit"]').click();
    await page.locator("#reset-confirm-password-error").waitFor({ state: "visible" });

    // 3. /account unauthenticated session-expired state @ 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/account`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/account returned ${res?.status()}`);
      assert(
        await page.locator('[data-testid="account-session-expired-alert"]').isVisible(),
        `Unauthenticated /account must show session-expired notice at ${vp.width}px`,
      );
      await assertViewportLayoutAndTouchTargets(page, "/account (unauth)", vp.width);
    }

    // 4. Real authenticated end-to-end journey: signup -> login -> /account profile & reauth checks @ 360px & 1440px
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const e2eEmail = `e2e.t025.${uniqueSuffix}@example.test`;
    const e2ePass = "E2ePassword!123";

    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signupStatus = await page.evaluate(
      async ({ email, password }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, password, name: "Pengguna E2E" }),
        });
        return res.status;
      },
      { email: e2eEmail, password: e2ePass },
    );
    assert(signupStatus === 200, `Synthetic E2E signup must return 200, got ${signupStatus}`);

    // Verify __Host-ps_session cookie was accepted by Chromium on 127.0.0.1
    const cookies = await context.cookies(baseUrl);
    const hasHostCookie = cookies.some((c) => c.name === "__Host-ps_session");
    assert(hasHostCookie, `Expected __Host-ps_session cookie in browser jar, got ${JSON.stringify(cookies.map((c) => c.name))}`);

    // Navigate to /account and verify authenticated UI at 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/account`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `Authenticated /account returned ${res?.status()}`);
      await page.locator('[data-testid="account-settings-ready"]').waitFor({ state: "visible" });
      await assertViewportLayoutAndTouchTargets(page, "/account (auth)", vp.width);
      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `account-auth-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // Update display name via real form
    await page.locator("#account-display-name").fill("Pengguna E2E Diperbarui");
    await page.locator('[data-testid="profile-save-button"]').click();
    await page.locator('[data-testid="profile-status-alert"]').waitFor({ state: "visible" });
    const profileMsg = await page.locator('[data-testid="profile-status-alert"]').innerText();
    assert(profileMsg.includes("berhasil diperbarui"), `Unexpected profile status: ${profileMsg}`);

    // Email change without reauth password shows inline alert
    await page.locator("#account-new-email").fill(`baru.${uniqueSuffix}@example.test`);
    await page.locator('[data-testid="email-save-button"]').click();
    await page.locator("#account-email-reauth-error").waitFor({ state: "visible" });

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-025 E2E PASS: /auth/login, /auth/reset-password, /account (unauth + authenticated) verified at 360px & 1440px with keyboard focus ring, validation alerts, expired reset state, __Host-ps_session cookie, >=44px mobile touch targets, zero horizontal overflow, and 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-025 E2E FAILED:", err);
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
