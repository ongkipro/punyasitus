/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const screenshotDir = process.env.TASK058_SCREENSHOT_DIR || "";

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

function runWranglerD1(args) {
  const persistTo = path.join(webDir, ".wrangler/state");
  const res = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", ...args, "--local", "--persist-to", persistTo],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

function ensureLocalD1Migrated() {
  runWranglerD1(["migrations", "apply", "punyasitus-platform"]);
}

function execLocalD1Sql(sql) {
  return runWranglerD1(["execute", "punyasitus-platform", "--command", sql, "--json"]);
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
      const res = await httpGet(port, "/auth/verify-email");
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
      document.querySelectorAll(
        'main button, main a[href], main input:not([type="radio"]):not([type="checkbox"])',
      ),
    )
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 32) || "",
          width: Math.round(r.width),
          height: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      })
      .filter((c) => c.visible);

    const radioLabels = Array.from(document.querySelectorAll('main label[data-testid^="vertical-option-"]'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-testid") || "radio-label",
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
      radioLabels,
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
    for (const lbl of metrics.radioLabels) {
      assert(
        lbl.height >= 44,
        `[${label} @ 360px] Radio card ${lbl.id} height ${lbl.height}px < 44px touch target`,
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

    // 1. Verify /auth/verify-email expired link + email outage states at 360px & 1440px
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(
        `${baseUrl}/auth/verify-email?status=expired&email=pemilik%40contoh.id`,
        { waitUntil: "networkidle" },
      );
      assert(res && res.status() === 200, `/auth/verify-email returned ${res?.status()}`);
      assert(
        (res.headers()["cache-control"] ?? "").includes("no-store"),
        `/auth/verify-email must send Cache-Control: private, no-store`,
      );
      assert(
        (res.headers()["x-robots-tag"] ?? "").includes("noindex"),
        `/auth/verify-email must send X-Robots-Tag: noindex, nofollow`,
      );
      await page.locator('[data-testid="verify-expired-alert"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="resend-verification-btn"]').waitFor({ state: "visible" });
      await assertViewportLayoutAndTouchTargets(page, "/auth/verify-email?status=expired", vp.width);

      if (vp.width === 1440 && screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, "verify-email-1440.png"),
          fullPage: true,
        });
      }
    }

    // Verify email-outage recovery banner state
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/auth/verify-email?status=email_outage`, {
      waitUntil: "networkidle",
    });
    await page.locator('[data-testid="verify-email-outage-banner"]').waitFor({ state: "visible" });

    // 2. Register a real user via /auth/register?next=/auth/onboarding
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const email = `e2e.t058.${suffix}@example.test`;
    await page.goto(`${baseUrl}/auth/register?next=%2Fauth%2Fonboarding`, {
      waitUntil: "networkidle",
    });
    await page.locator("#register-name").fill("Nadia Pratama");
    await page.locator("#register-email").fill(email);
    await page.locator("#register-password").fill("Onboarding!1234");
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/auth/onboarding", { timeout: 15_000 }),
      page.locator('[data-testid="register-submit"]').click(),
    ]);

    // Unverified user sees verification blocker on /auth/onboarding
    await page.locator('[data-testid="onboarding-unverified-gate"]').waitFor({ state: "visible" });

    // 3. Seed a real hashed single-use verification token in local D1 and redeem via /auth/verify-email?token=...
    const userJson = JSON.parse(
      execLocalD1Sql(`SELECT id FROM users WHERE lower(email) = '${email}' LIMIT 1;`),
    );
    const userId = userJson?.[0]?.results?.[0]?.id;
    assert(typeof userId === "string" && userId.length > 0, `Could not find created user for ${email}`);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const nowMs = Date.now();
    const verPayload = JSON.stringify({
      userId,
      email,
      createdAtMs: nowMs,
      consumedAtMs: null,
    }).replace(/'/g, "''");
    execLocalD1Sql(
      `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES ('emver_e2e_${suffix}', 'onboarding-verify:${tokenHash}', '${verPayload}', ${nowMs + 1800000}, ${nowMs}, ${nowMs});`,
    );

    await page.goto(`${baseUrl}/auth/verify-email?token=${rawToken}`, {
      waitUntil: "networkidle",
    });
    await page.locator('[data-testid="verify-success-alert"]').waitFor({ state: "visible", timeout: 10_000 });
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/auth/onboarding", { timeout: 15_000 }),
      page.locator('[data-testid="verify-continue-onboarding"]').click(),
    ]);

    // 4. Verify /auth/onboarding for 1st-site trial at 1440px & 360px
    const firstHandle = `kopi-${suffix.slice(-6)}`;
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto(`${baseUrl}/auth/onboarding`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="trial-disclosure-banner"]').waitFor({ state: "visible" });

      const badgeText = (await page.locator('[data-testid="trial-eligibility-badge"]').innerText()).trim();
      assert(
        badgeText.toLowerCase().includes("uji coba gratis 7 hari"),
        `1st site badge must indicate 7-day free trial, got "${badgeText}"`,
      );

      const suffixText = (await page.locator('[data-testid="fixed-domain-suffix"]').innerText()).trim();
      assert(
        suffixText === ".situsku.click",
        `Fixed domain suffix must read ".situsku.click", got "${suffixText}"`,
      );

      await assertViewportLayoutAndTouchTargets(page, "/auth/onboarding (1st site)", vp.width);

      if (screenshotDir) {
        await page.screenshot({
          path: path.join(screenshotDir, `onboarding-${vp.width}.png`),
          fullPage: true,
        });
      }
    }

    // 5. Keyboard navigation + visible focus ring on onboarding form
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/auth/onboarding`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab"); // skip link
    await page.keyboard.press("Tab"); // header brand link
    await page.keyboard.press("Tab"); // business name input
    const focusedName = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        id: el.id,
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth),
      };
    });
    assert(focusedName?.id === "onboarding-name", `Expected #onboarding-name focus, got ${JSON.stringify(focusedName)}`);
    assert(
      focusedName.outlineStyle !== "none" && focusedName.outlineWidth >= 2,
      `Keyboard focus must show >=2px outline, got ${JSON.stringify(focusedName)}`,
    );

    // 6. Inline handle validation errors (reserved & invalid)
    await page.locator("#onboarding-name").fill("Kopi Nadia Nusantara");
    await page.locator("#onboarding-handle").fill("console");
    await page.locator('[data-testid="onboarding-handle-error"]').waitFor({ state: "visible" });
    assert(
      (await page.locator('[data-testid="onboarding-handle-error"]').getAttribute("role")) === "alert",
      "Handle error must use role=alert",
    );

    await page.locator("#onboarding-handle").fill("-tidak-valid-");
    await page.locator('[data-testid="onboarding-handle-error"]').waitFor({ state: "visible" });

    // Valid free handle shows availability preview -> submit 1st site (7-day trial)
    await page.locator("#onboarding-handle").fill(firstHandle);
    await page.locator('[data-testid="handle-available-preview"]').waitFor({ state: "visible", timeout: 8_000 });
    await page.locator('[data-testid="vertical-option-resto"]').click();
    await page.locator('[data-testid="onboarding-submit"]').click();

    await page.locator('[data-testid="onboarding-success"]').waitFor({ state: "visible", timeout: 15_000 });
    const firstResultBadge = (await page.locator('[data-testid="onboarding-result-badge"]').innerText()).trim();
    assert(
      firstResultBadge.toLowerCase().includes("uji coba gratis 7 hari"),
      `Expected 1st site result badge "Uji Coba Gratis 7 Hari", got "${firstResultBadge}"`,
    );

    // 7. Return to /auth/onboarding as same verified owner -> 2nd site payment-only disclosure
    await page.goto(`${baseUrl}/auth/onboarding`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="payment-only-disclosure-banner"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="owned-sites-summary"]').waitFor({ state: "visible" });
    const secondBadgeText = (await page.locator('[data-testid="trial-eligibility-badge"]').innerText()).trim();
    assert(
      secondBadgeText.toLowerCase().includes("aktif setelah pembayaran"),
      `2nd site badge must indicate payment-only, got "${secondBadgeText}"`,
    );
    await assertViewportLayoutAndTouchTargets(page, "/auth/onboarding (2nd site)", 1440);

    if (screenshotDir) {
      await page.screenshot({
        path: path.join(screenshotDir, "onboarding-second-site-1440.png"),
        fullPage: true,
      });
    }

    // Submit 2nd site -> starts payment-only (suspended, no free trial)
    const secondHandle = `toko2-${suffix.slice(-6)}`;
    await page.locator("#onboarding-name").fill("Toko Nadia Cabang Dua");
    await page.locator("#onboarding-handle").fill(secondHandle);
    await page.locator('[data-testid="handle-available-preview"]').waitFor({ state: "visible", timeout: 8_000 });
    await page.locator('[data-testid="onboarding-submit"]').click();
    await page.locator('[data-testid="onboarding-success"]').waitFor({ state: "visible", timeout: 15_000 });
    const secondResultBadge = (await page.locator('[data-testid="onboarding-result-badge"]').innerText()).trim();
    assert(
      secondResultBadge.toLowerCase().includes("menunggu pembayaran"),
      `Expected 2nd site result badge "Menunggu Pembayaran Pertama", got "${secondResultBadge}"`,
    );

    // 8. Partial-provisioning recovery flow in UI (mark 2nd site schema_version=0 & attempt needs_recovery, then click Resume!)
    execLocalD1Sql(
      `UPDATE tenants SET schema_version = 0 WHERE handle = '${secondHandle}'; UPDATE onboarding_attempts SET provisioning_state = 'needs_recovery', last_error_code = 'TENANT_STORE_INIT_FAILED' WHERE handle = '${secondHandle}';`,
    );
    await page.goto(`${baseUrl}/auth/onboarding`, { waitUntil: "networkidle" });
    await page.locator('[data-testid="partial-provisioning-recovery"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="resume-provisioning-btn"]').click();
    await page.locator('[data-testid="onboarding-success"]').waitFor({ state: "visible", timeout: 15_000 });

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-058 E2E PASS: /auth/verify-email (expired link + email outage + real token redemption) and /auth/onboarding (fixed .situsku.click suffix, inline handle errors, 1st-site 7-day trial, 2nd-site payment-only disclosure, partial-provisioning recovery, keyboard focus ring, >=44px mobile touch targets, 0 overflow, 0 console/page errors) verified at 360px & 1440px.",
    );
  } catch (err) {
    console.error("TASK-058 E2E FAILED:", err);
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
