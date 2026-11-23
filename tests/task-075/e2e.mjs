/* global process, console, setTimeout, clearTimeout, document, window, getComputedStyle, fetch, URL */
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

const screenshotDir = process.env.TASK075_SCREENSHOT_DIR || "/tmp/task-075-screenshots";

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
  return res.stdout;
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

async function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, "/auth/login");
      if (res.status === 200) {
        // Warm Vite SSR dep graph for consent & connected-apps routes before opening Chromium
        await httpGet(port, "/auth/consent").catch(() => undefined);
        await httpGet(port, "/account/connected-apps").catch(() => undefined);
        return;
      }
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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function assertViewportLayoutAndTouchTargets(page, label, width) {
  const metrics = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const htmlFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const controls = Array.from(
      document.querySelectorAll("main button, main a[href], main label"),
    ).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 32) || "",
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
  fs.mkdirSync(screenshotDir, { recursive: true });

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

    const baseUrl = `http://127.0.0.1:${port}`;
    const canonicalResource = `${baseUrl}/mcp`;

    // Verify RFC 9728 & RFC 8414 discovery endpoints live
    const prmRes = await httpGet(port, "/.well-known/oauth-protected-resource");
    assert(prmRes.status === 200, `Expected 200 from RFC 9728 metadata, got ${prmRes.status}`);
    const prmJson = JSON.parse(prmRes.body);
    assert(prmJson.resource === canonicalResource, `Unexpected resource: ${prmJson.resource}`);

    const asmRes = await httpGet(port, "/.well-known/oauth-authorization-server");
    assert(asmRes.status === 200, `Expected 200 from RFC 8414 metadata, got ${asmRes.status}`);
    const asmJson = JSON.parse(asmRes.body);
    assert(
      Array.isArray(asmJson.code_challenge_methods_supported) &&
        asmJson.code_challenge_methods_supported.includes("S256"),
      "RFC 8414 metadata must advertise S256",
    );

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    // 1. Sign up synthetic owner user in browser context
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const email = `e2e.t075.${suffix}@example.test`;
    const pass = "E2eMcpPass!123";
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });

    const signupResult = await page.evaluate(
      async ({ emailArg, passArg }) => {
        const res = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email: emailArg, password: passArg, name: "Owner MCP E2E" }),
        });
        const body = await res.json();
        return { status: res.status, userId: body?.user?.id ?? "" };
      },
      { emailArg: email, passArg: pass },
    );
    assert(signupResult.status === 200 && signupResult.userId, `Signup failed: ${JSON.stringify(signupResult)}`);

    // 2. Seed synthetic tenant + owner membership + static OAuth client in local D1
    const now = Date.now();
    const paidThrough = now + 30 * 24 * 60 * 60 * 1000;
    const orgId = `org_e2e_t075_${suffix}`;
    const tenantId = `tnt_e2e_t075_${suffix}`;
    const handle = `kopi-${suffix.slice(-6)}`;
    const clientId = `mcp-client-e2e-${suffix}`;
    const callbackUrl = `${baseUrl}/account/connected-apps`;
    const sqlEsc = (s) => String(s).replace(/'/g, "''");

    runLocalD1Sql(`
      INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
      VALUES ('${sqlEsc(orgId)}', 'Kopi Nusantara E2E', '${sqlEsc(handle)}', ${now}, ${now});
      INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
      VALUES ('mem_${sqlEsc(suffix)}', '${sqlEsc(orgId)}', '${sqlEsc(signupResult.userId)}', 'owner', ${now});
      INSERT OR REPLACE INTO tenants (
        id, organization_id, handle, name, vertical, status,
        operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at
      ) VALUES (
        '${sqlEsc(tenantId)}', '${sqlEsc(orgId)}', '${sqlEsc(handle)}', 'Kopi Nusantara E2E',
        'compro', 'active', 0, ${paidThrough}, 1, 1, 1, ${now}, ${now}
      );
      INSERT OR REPLACE INTO mcp_oauth_clients (
        client_id, client_name, client_uri, redirect_uris_json, source, disabled, created_at, updated_at
      ) VALUES (
        '${sqlEsc(clientId)}', 'Claude Desktop (E2E)', 'https://claude.ai',
        '["${sqlEsc(callbackUrl)}"]', 'static', 0, ${now}, ${now}
      );
    `);

    const pkceVerifier = `e2e_pkce_verifier_${suffix}_0123456789abcdef`;
    const pkceChallenge = crypto
      .createHash("sha256")
      .update(pkceVerifier)
      .digest("base64url");

    const consentUrl = new URL(`${baseUrl}/auth/consent`);
    consentUrl.searchParams.set("client_id", clientId);
    consentUrl.searchParams.set("redirect_uri", callbackUrl);
    consentUrl.searchParams.set("resource", canonicalResource);
    consentUrl.searchParams.set("scope", "content:read content:write_draft content:publish_request");
    consentUrl.searchParams.set("code_challenge", pkceChallenge);
    consentUrl.searchParams.set("code_challenge_method", "S256");
    consentUrl.searchParams.set("state", "e2e_state_75");

    // 3. Render /auth/consent at 360px & 1440px, verify touch targets & zero overflow, save screenshots
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(consentUrl.toString(), { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/auth/consent returned ${res?.status()}`);
      const headers = res.headers();
      assert(headers["x-frame-options"] === "DENY", `Missing X-Frame-Options: DENY on /auth/consent`);
      assert(
        (headers["content-security-policy"] || "").includes("frame-ancestors 'none'"),
        `Missing CSP frame-ancestors 'none' on /auth/consent`,
      );
      assert(headers["referrer-policy"] === "no-referrer", `Missing Referrer-Policy: no-referrer on /auth/consent`);
      await page.locator('[data-testid="mcp-consent-card"]').waitFor({ state: "visible" });
      const bodyText = await page.locator("main").innerText();
      assert(bodyText.includes("Claude Desktop (E2E)"), "Consent screen must display client name");
      assert(bodyText.includes("Kopi Nusantara E2E"), "Consent screen must display bound website");
      await assertViewportLayoutAndTouchTargets(page, "/auth/consent", vp.width);
      await page.screenshot({
        path: path.join(screenshotDir, `auth-consent-${vp.width}.png`),
        fullPage: true,
      });
    }

    // 4. Approve consent -> redirects to /account/connected-apps?code=...&state=e2e_state_75
    await page.setViewportSize({ width: 1440, height: 900 });
    await Promise.all([
      page.waitForURL((u) => u.pathname === "/account/connected-apps" && u.searchParams.has("code")),
      page.locator('[data-testid="mcp-consent-approve"]').click(),
    ]);
    await page.waitForLoadState("networkidle");

    // 5. Render /account/connected-apps at 360px & 1440px, verify active grant + touch targets + zero overflow
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      const res = await page.goto(`${baseUrl}/account/connected-apps`, { waitUntil: "networkidle" });
      assert(res && res.status() === 200, `/account/connected-apps returned ${res?.status()}`);
      await page.locator('[data-testid="connected-apps-ready"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="active-grants-list"]').waitFor({ state: "visible" });
      const text = await page.locator("main").innerText();
      assert(text.includes("Claude Desktop (E2E)"), "Connected apps must show approved client");
      assert(text.includes("Kopi Nusantara E2E"), "Connected apps must show bound tenant");
      await assertViewportLayoutAndTouchTargets(page, "/account/connected-apps", vp.width);
      await page.screenshot({
        path: path.join(screenshotDir, `connected-apps-${vp.width}.png`),
        fullPage: true,
      });
    }

    // 6. Click "Cabut Akses" -> immediate revocation + persistence on reload
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-testid^="revoke-grant-"]').first().click();
    await page.locator('[data-testid="connected-apps-status-alert"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="connected-apps-empty"]').waitFor({ state: "visible" });
    await page.locator('[data-testid="revoked-grants-list"]').waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(screenshotDir, "connected-apps-revoked-1440.png"),
      fullPage: true,
    });

    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-testid="connected-apps-empty"]').waitFor({ state: "visible" });

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      `TASK-075 E2E PASS: RFC 9728/8414 discovery, /auth/consent (360px & 1440px), real OAuth consent grant creation, and /account/connected-apps (360px & 1440px) with one-click Cabut Akses immediate revocation verified with >=44px mobile touch targets, zero overflow, 0 console/page errors, and screenshots saved to ${screenshotDir}.`,
    );
  } catch (err) {
    console.error("TASK-075 E2E FAILED:", err);
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
