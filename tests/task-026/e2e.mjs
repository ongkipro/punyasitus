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

const screenshotDir = process.env.TASK026_SCREENSHOT_DIR || "";
const persistTo = path.join(webDir, ".wrangler/state");

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

function runLocalD1Sql(sql) {
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
    throw new Error(`Local D1 SQL failed:\n${sql}\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

function ensureLocalD1Migrated() {
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
      document.querySelectorAll("main button, main a[href], main input, main select"),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 24) || "",
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
      assert(
        ctrl.height >= 44,
        `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}#${ctrl.id} height ${ctrl.height}px < 44px`,
      );
    }
  }
}

async function signUpInBrowser(page, { email, password, name }) {
  const res = await page.evaluate(
    async ({ email: e, password: p, name: n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, json };
    },
    { email, password, name },
  );
  assert(res.ok, `Expected sign-up for ${email} to succeed, got ${res.status}`);
  return res.json;
}

async function run() {
  ensureLocalD1Migrated();
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 9999)}`;
    const opEmail = `t026-op-${suffix}@example.com`;
    const opPass = "OperatorPass!234";
    const ownerEmail = `t026-owner-${suffix}@example.com`;
    const ownerPass = "OwnerPass!234";
    const editorEmail = `t026-editor-${suffix}@example.com`;
    const editorPass = "EditorPass!234";
    const tenantHandle = `toko-${suffix}`.slice(0, 32);

    // -----------------------------------------------------------------------
    // 1. Operator Context: enroll live 2FA, verify non-operator denial, grant operator,
    //    test /console/provisioning at 1440px & 360px (validation, create, state transition)
    // -----------------------------------------------------------------------
    const opContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opContext.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    let allowExpectedHttpErrors = false;
    opPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allowExpectedHttpErrors && /status of 4\d\d/.test(msg.text())) return;
        consoleErrors.push(msg.text());
      }
    });
    opPage.on("pageerror", (err) => pageErrors.push(String(err)));

    await opPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(opPage, {
      email: opEmail,
      password: opPass,
      name: "Operator E2E",
    });

    // Non-operator MUST be denied on /console/provisioning (403; bare gate HTML also triggers browser /favicon.ico 404)
    allowExpectedHttpErrors = true;
    const deniedConsole = await opPage.goto(`${baseUrl}/console/provisioning`, {
      waitUntil: "networkidle",
    });
    allowExpectedHttpErrors = false;
    assert(
      deniedConsole && deniedConsole.status() === 403,
      `Expected non-operator /console/provisioning to return 403, got ${deniedConsole?.status()}`,
    );

    // Enroll & verify real live TOTP 2FA via /auth/two-factor?mode=enroll
    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", opPass);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const manualSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    const totpCode = generateTotpCode(manualSecret);
    await opPage.fill("#twofa-confirm-code", totpCode);
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    // Grant active platform_operators row for opEmail in local D1
    const safeOpEmail = opEmail.replace(/'/g, "''");
    const nowMs = Date.now();
    runLocalD1Sql(
      `UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOpEmail}';
       INSERT OR REPLACE INTO platform_operators (user_id, granted_by, reason, granted_at, revoked_at)
       SELECT id, NULL, 'E2E synthetic operator grant for TASK-026', ${nowMs}, NULL
       FROM users WHERE lower(email) = '${safeOpEmail}';`,
    );

    // Also sign up owner & editor accounts in separate browser contexts so they exist in D1
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerPage = await ownerContext.newPage();
    ownerPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allowExpectedHttpErrors && /status of 4\d\d/.test(msg.text())) return;
        consoleErrors.push(msg.text());
      }
    });
    ownerPage.on("pageerror", (err) => pageErrors.push(String(err)));
    await ownerPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(ownerPage, {
      email: ownerEmail,
      password: ownerPass,
      name: "Pemilik E2E",
    });
    const safeOwnerEmail = ownerEmail.replace(/'/g, "''");
    runLocalD1Sql(`UPDATE users SET email_verified = 1 WHERE lower(email) = '${safeOwnerEmail}';`);

    const editorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const editorPage = await editorContext.newPage();
    editorPage.on("console", (msg) => {
      if (msg.type() === "error") {
        if (allowExpectedHttpErrors && /status of 4\d\d/.test(msg.text())) return;
        consoleErrors.push(msg.text());
      }
    });
    editorPage.on("pageerror", (err) => pageErrors.push(String(err)));
    await editorPage.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
    await signUpInBrowser(editorPage, {
      email: editorEmail,
      password: editorPass,
      name: "Editor E2E",
    });

    // Now open /console/provisioning as active 2FA-verified operator!
    const consoleRes = await opPage.goto(`${baseUrl}/console/provisioning`, {
      waitUntil: "networkidle",
    });
    assert(
      consoleRes && consoleRes.status() === 200,
      `Expected operator /console/provisioning 200, got ${consoleRes?.status()}`,
    );
    await opPage.waitForSelector('[data-testid="console-provisioning-page"]');
    await assertViewportLayoutAndTouchTargets(opPage, "console-provisioning", 1440);

    // Keyboard Tab focus check
    await opPage.keyboard.press("Tab");
    const activeTag = await opPage.evaluate(() => document.activeElement?.tagName ?? "");
    assert(Boolean(activeTag), "Expected keyboard focusable element on Tab");

    // Validation rejection for reserved handle ("admin")
    allowExpectedHttpErrors = true;
    await opPage.fill("#provision-name", "Toko Uji E2E");
    await opPage.fill("#provision-handle", "admin");
    await opPage.fill("#provision-owner-email", ownerEmail);
    await opPage.fill("#provision-reason", "Uji validasi handle tercadang pada console provisioning");
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-server-error"]');
    allowExpectedHttpErrors = false;

    // Valid atomic tenant provisioning
    await opPage.fill("#provision-handle", tenantHandle);
    await opPage.click('[data-testid="provision-submit-button"]');
    await opPage.waitForSelector('[data-testid="provision-success-alert"]');
    await opPage.waitForSelector(`[data-tenant-handle="${tenantHandle}"]`);

    // Audited service-state transition: suspend_hold -> release_hold
    await opPage.fill(
      "#state-reason-input",
      "Uji transisi status penangguhan operator hold dengan audit log",
    );
    await opPage.click('[data-testid="state-transition-submit"]');
    await opPage.waitForSelector('[data-testid="state-transition-success"]');
    const holdBadgeText = await opPage.textContent('[data-testid="selected-tenant-status-badge"]');
    assert(
      holdBadgeText && holdBadgeText.includes("Hold"),
      `Expected Hold badge after suspend_hold, got: ${holdBadgeText}`,
    );

    if (screenshotDir) {
      await opPage.evaluate(() => window.scrollTo(0, 0));
      await opPage.screenshot({
        path: path.join(screenshotDir, "console-provisioning-1440.png"),
        fullPage: true,
      });
    }

    // Check 360px mobile layout on /console/provisioning
    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(opPage, "console-provisioning", 360);
    if (screenshotDir) {
      await opPage.evaluate(() => window.scrollTo(0, 0));
      await opPage.screenshot({
        path: path.join(screenshotDir, "console-provisioning-360.png"),
        fullPage: true,
      });
    }

    // Release hold so tenant returns to trial for dashboard member tests
    await opPage.selectOption("#state-action-select", "release_hold");
    await opPage.fill(
      "#state-reason-input",
      "Melepas penangguhan operator setelah verifikasi operasional selesai",
    );
    await opPage.click('[data-testid="state-transition-submit"]');
    await opPage.waitForSelector('[data-testid="state-transition-success"]');

    // Add editorEmail as an active editor member of the provisioned tenant so we can test
    // non-owner denial AND atomic owner transfer in the browser!
    const safeEditorEmail = editorEmail.replace(/'/g, "''");
    const safeHandle = tenantHandle.replace(/'/g, "''");
    runLocalD1Sql(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       SELECT 'mem_e2e_ed_${suffix}', t.organization_id, u.id, 'editor', ${Date.now()}
       FROM tenants t, users u
       WHERE t.handle = '${safeHandle}' AND lower(u.email) = '${safeEditorEmail}';`,
    );

    // -----------------------------------------------------------------------
    // 2. Dashboard Members Screen (/dashboard/[handle]/settings/members)
    //    - Owner: invite up to 5 seats, 6th returns MEMBER_LIMIT_REACHED,
    //      revoke 1 invite, transfer owner (missing reauth -> error, valid password -> success)
    //    - Editor: read-only notice & denied invite API (403)
    // -----------------------------------------------------------------------
    const membersUrl = `${baseUrl}/dashboard/${tenantHandle}/settings/members`;
    const membersRes = await ownerPage.goto(membersUrl, { waitUntil: "networkidle" });
    assert(
      membersRes && membersRes.status() === 200,
      `Expected owner /settings/members 200, got ${membersRes?.status()}`,
    );
    await ownerPage.waitForSelector('[data-testid="members-settings-page"]');
    await assertViewportLayoutAndTouchTargets(ownerPage, "dashboard-members", 1440);

    // Currently 2 seats used (owner + editor). Invite 3 more to reach 5/5!
    for (let i = 1; i <= 3; i += 1) {
      const expectedCount = 2 + i;
      await ownerPage.fill("#invite-email-input", `tim-${i}-${suffix}@example.com`);
      await ownerPage.click('[data-testid="invite-submit-button"]');
      await ownerPage.waitForFunction(
        (exp) =>
          (document.querySelector('[data-testid="seat-quota-badge"]')?.textContent ?? "").includes(
            `${exp} dari 5`,
          ),
        expectedCount,
      );
      await ownerPage.waitForSelector('[data-testid="invite-success-alert"]');
    }

    const quota5 = await ownerPage.textContent('[data-testid="seat-quota-badge"]');
    assert(quota5 && quota5.includes("5 dari 5"), `Expected 5 dari 5 badge, got: ${quota5}`);

    // Attempt 6th invite -> visible MEMBER_LIMIT_REACHED alert & preserved email input!
    allowExpectedHttpErrors = true;
    const sixthEmail = `keenam-${suffix}@example.com`;
    await ownerPage.fill("#invite-email-input", sixthEmail);
    await ownerPage.click('[data-testid="invite-submit-button"]');
    await ownerPage.waitForSelector('[data-testid="invite-error-alert"]');
    const limitAlert = await ownerPage.textContent('[data-testid="invite-error-alert"]');
    assert(
      limitAlert && limitAlert.includes("5 anggota"),
      `Expected 5-member limit alert, got: ${limitAlert}`,
    );
    assert(
      (await ownerPage.inputValue("#invite-email-input")) === sixthEmail,
      "Expected email input to be preserved after MEMBER_LIMIT_REACHED error",
    );
    allowExpectedHttpErrors = false;

    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "dashboard-members-1440.png"),
        fullPage: true,
      });
    }

    // Check 360px mobile layout on /settings/members
    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(ownerPage, "dashboard-members", 360);
    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "dashboard-members-360.png"),
        fullPage: true,
      });
    }

    // Revoke 1 pending invitation -> seat quota drops to 4 dari 5
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    const firstRevokeBtn = ownerPage.locator('[data-testid^="revoke-invite-"]').first();
    await firstRevokeBtn.click();
    await ownerPage.waitForSelector('[data-testid="members-action-alert"]');
    const quota4 = await ownerPage.textContent('[data-testid="seat-quota-badge"]');
    assert(quota4 && quota4.includes("4 dari 5"), `Expected 4 dari 5 after revoke, got: ${quota4}`);

    // Editor view: verify read-only notice & direct POST invite denied (403)
    await editorPage.goto(membersUrl, { waitUntil: "networkidle" });
    await editorPage.waitForSelector('[data-testid="members-readonly-notice"]');
    allowExpectedHttpErrors = true;
    const editorDeniedStatus = await editorPage.evaluate(async (handle) => {
      const res = await fetch(`/dashboard/${handle}/settings/members/api`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "invite", email: "denied@example.com", role: "editor" }),
      });
      return res.status;
    }, tenantHandle);
    allowExpectedHttpErrors = false;
    assert(editorDeniedStatus === 403, `Expected editor invite POST to return 403, got ${editorDeniedStatus}`);

    // Service status view (/dashboard/[handle]/service-status) at 1440px & 360px
    const statusUrl = `${baseUrl}/dashboard/${tenantHandle}/service-status`;
    const statusRes = await ownerPage.goto(statusUrl, { waitUntil: "networkidle" });
    assert(statusRes && statusRes.status() === 200, `Expected /service-status 200, got ${statusRes?.status()}`);
    await ownerPage.waitForSelector('[data-testid="service-status-page"]');
    await assertViewportLayoutAndTouchTargets(ownerPage, "dashboard-service-status", 1440);
    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "dashboard-service-status-1440.png"),
        fullPage: true,
      });
    }
    await ownerPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(ownerPage, "dashboard-service-status", 360);
    if (screenshotDir) {
      await ownerPage.screenshot({
        path: path.join(screenshotDir, "dashboard-service-status-360.png"),
        fullPage: true,
      });
    }

    // Owner Transfer journey back on /settings/members:
    // 1) Missing password -> 403 REAUTH_REQUIRED visible alert
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.goto(membersUrl, { waitUntil: "networkidle" });
    allowExpectedHttpErrors = true;
    await ownerPage.fill("#transfer-confirm-handle", tenantHandle);
    await ownerPage.click('[data-testid="transfer-owner-submit"]');
    await ownerPage.waitForSelector('[data-testid="transfer-error-alert"]');
    allowExpectedHttpErrors = false;

    // 2) Valid password -> atomic transfer succeeds, old owner loses billing access!
    await ownerPage.fill("#transfer-reauth-password", ownerPass);
    await ownerPage.click('[data-testid="transfer-owner-submit"]');
    await ownerPage.waitForSelector('[data-testid="members-readonly-notice"]');
    const billingBadgeAfter = await ownerPage.textContent('[data-testid="billing-access-badge"]');
    assert(
      billingBadgeAfter && billingBadgeAfter.includes("Tanpa Akses Tagihan"),
      `Expected billing access to leave former owner, got: ${billingBadgeAfter}`,
    );

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Page errors detected:\n${pageErrors.join("\n")}`);

    await opContext.close();
    await ownerContext.close();
    await editorContext.close();

    console.log(
      "PASS: TASK-026 Chromium E2E verified /console/provisioning (2FA operator gate, atomic create, state transition), /dashboard/[handle]/settings/members (5-member cap, MEMBER_LIMIT_REACHED, revoke, non-owner denial, reauth owner transfer + billing shift), and /dashboard/[handle]/service-status at 360px & 1440px with 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-026 E2E FAILURE:", err);
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
