/* global process, console, Buffer, setTimeout, clearTimeout, document, window, getComputedStyle, fetch */
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

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(base32Input) {
  const clean = base32Input.trim().toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  const out = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) throw new Error(`Invalid base32 char: ${clean[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function generateTotpCode(base32Secret, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const hmac = crypto.createHmac("sha1", decodeBase32(base32Secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
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
      const res = await httpGet(port, "/auth/two-factor");
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
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || "",
          height: Math.round(rect.height),
        };
      });
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
    `[${label} @ ${width}px] Horizontal overflow detected (scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth})`,
  );
  assert(
    metrics.htmlFontSize >= 14,
    `[${label} @ ${width}px] Root font size too small (${metrics.htmlFontSize}px)`,
  );

  if (width <= 400) {
    for (const ctrl of metrics.controls) {
      if (ctrl.tag === "BUTTON" || ctrl.tag === "A") {
        assert(
          ctrl.height >= 44,
          `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}#${ctrl.id} height ${ctrl.height}px < 44px`,
        );
      }
    }
  }
}

async function run() {
  ensureLocalD1Migrated();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(port), "--ignore-lock"],
    {
      cwd: webDir,
      env: cleanChildEnv({ PUNYASITUS_DISABLE_DEV_TOOLBAR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  server.stdout.on("data", (d) => (serverLogs += d.toString()));
  server.stderr.on("data", (d) => (serverLogs += d.toString()));

  let browser;
  try {
    await waitForServer(port);

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    let allowExpected401 = false;
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (allowExpected401 && text.includes("status of 401")) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Create a fresh synthetic tenant owner session on loopback
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const userEmail = `t067-owner-${uniqueSuffix}@example.com`;
    const userPassword = "OwnerPassword!234";

    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    const signUpStatus = await page.evaluate(
      async ({ email, password }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email,
            password,
            name: "Pemilik Situs 2FA",
          }),
        });
        return { ok: res.ok, status: res.status };
      },
      { email: userEmail, password: userPassword },
    );
    assert(signUpStatus.ok, `Expected sign-up to succeed, got status ${signUpStatus.status}`);

    // 2. Visit /auth/two-factor?mode=enroll at 1440px -> verify keyboard + validation + QR + manual key + backup codes
    await page.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-enroll-start-form"]');
    await assertViewportLayoutAndTouchTargets(page, "two-factor-enroll-start", 1440);

    // Keyboard submit with empty password announces role="alert"
    await page.click('[data-testid="twofa-enroll-start-button"]');
    const pwdAlert = await page.textContent("#twofa-enroll-password-error");
    assert(pwdAlert && pwdAlert.includes("Kata sandi"), `Expected password validation alert, got: ${pwdAlert}`);

    // Start enrollment with valid password
    await page.fill("#twofa-enroll-password", userPassword);
    await page.press("#twofa-enroll-password", "Enter");
    await page.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');

    // Verify scannable SVG QR code, manual secret key, 10 backup codes, and once-only warning
    const qrSvgCount = await page.locator('[data-testid="twofa-qr-container"] svg path').count();
    assert(qrSvgCount >= 1, "Expected rendered QR SVG path inside twofa-qr-container");

    const manualSecret = (await page.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    assert(manualSecret.length >= 16, `Expected valid Base32 manual secret, got "${manualSecret}"`);

    const backupCodes = await page.locator('[data-testid="twofa-backup-codes"] li').allTextContents();
    assert(backupCodes.length === 10, `Expected 10 one-time backup codes, got ${backupCodes.length}`);
    const warningText = await page.textContent('[data-testid="twofa-backup-once-warning"]');
    assert(
      warningText && warningText.includes("satu kali"),
      `Expected once-only backup code warning, got: ${warningText}`,
    );

    // Check 360px mobile layout & >=44px touch targets on the enrollment secret screen!
    await page.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(page, "two-factor-enroll-secrets", 360);

    // Invalid 6-digit code announces role="alert" / destructive error
    await page.fill("#twofa-confirm-code", "123");
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    const shortCodeErr = await page.textContent("#twofa-code-error");
    assert(shortCodeErr && shortCodeErr.includes("6 digit"), `Expected 6-digit validation alert, got: ${shortCodeErr}`);

    // Generate REAL live RFC 6238 TOTP code from the displayed manual secret and confirm enrollment!
    const validTotpCode = generateTotpCode(manualSecret);
    await page.fill("#twofa-confirm-code", validTotpCode);
    await page.click('[data-testid="twofa-confirm-enroll-button"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // Secrets & backup codes MUST be cleared from DOM immediately after confirmation
    const secretPanelCount = await page.locator('[data-testid="twofa-enroll-secret-panel"]').count();
    assert(secretPanelCount === 0, "Enrollment secret panel must be cleared after confirmation");

    // 3. Test verification screen (/auth/two-factor?mode=verify) with single-use backup code toggle
    await page.goto(`${baseUrl}/auth/two-factor?mode=verify`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="twofa-verify-panel"]');
    await assertViewportLayoutAndTouchTargets(page, "two-factor-verify", 360);

    await page.click('[data-testid="twofa-method-backup"]');
    const firstBackup = backupCodes[0].trim();
    await page.fill("#twofa-verify-code", firstBackup);
    await page.click('[data-testid="twofa-verify-submit"]');
    await page.waitForSelector('[data-testid="twofa-success-alert"]');

    // Reusing the exact same single-use backup code MUST fail visibly (intentional 401)
    allowExpected401 = true;
    await page.fill("#twofa-verify-code", firstBackup);
    await page.click('[data-testid="twofa-verify-submit"]');
    await page.waitForSelector('[data-testid="twofa-form-error"]');
    allowExpected401 = false;

    // 4. Visit /account/security at 360px & 1440px -> verify active status & optional tenant disable flow
    await page.goto(`${baseUrl}/account/security`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="account-security-ready"]');
    await assertViewportLayoutAndTouchTargets(page, "account-security-active", 360);

    await page.setViewportSize({ width: 1440, height: 900 });
    await assertViewportLayoutAndTouchTargets(page, "account-security-active", 1440);

    const activeBadge = await page.textContent('[data-testid="security-2fa-status-badge"]');
    assert(activeBadge && activeBadge.includes("2FA Aktif"), `Expected "2FA Aktif" badge, got: ${activeBadge}`);

    // Disable optional 2FA as tenant owner
    await page.fill("#security-disable-password", userPassword);
    await page.click('[data-testid="security-disable-submit"]');
    await page.waitForSelector('[data-testid="security-enable-card"]');

    const disabledBadge = await page.textContent('[data-testid="security-2fa-status-badge"]');
    assert(
      disabledBadge && disabledBadge.includes("Belum Aktif"),
      `Expected "2FA Belum Aktif" badge after disable, got: ${disabledBadge}`,
    );

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Page errors detected:\n${pageErrors.join("\n")}`);

    console.log(
      "PASS: TASK-067 Chromium E2E verified /auth/two-factor (QR SVG, manual key, 10 once-only backup codes, live TOTP + single-use backup code) & /account/security (tenant optional enable/disable) at 360px & 1440px with 0 console/page errors.",
    );
  } catch (err) {
    console.error("E2E FAILURE:", err);
    console.error("Astro dev logs:\n", serverLogs.slice(-3000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 4000);
      server.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

await run();
