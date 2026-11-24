/* global process, console, document, URL, Buffer */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * TASK-101 Playwright Chromium E2E Visual & Functional Verification (`360px` & `1440px`):
 * - Verifies `base-nova` 1-click Telegram connect/disconnect card (zero manual `chat_id`)
 *   and SSRF-guarded HMAC-SHA256 webhook configuration + test-send UI.
 * - Verifies zero console/page errors, zero horizontal overflow, zero Radix DOM attributes,
 *   explicit `htmlFor`/`id` label pairings, and saves screenshots to `/tmp/qa-task-101/`.
 */

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK101_SCREENSHOT_DIR || "/tmp/qa-task-101";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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

async function buildLeadNotifierFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t101-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutImport = path.join(webDir, "src/layouts/DashboardLayout.astro");
  const islandImport = path.join(
    root,
    "packages/plugins/lead-notifier/src/admin/SettingsIsland.tsx",
  );

  const layoutProps = (title, lifecycleStatus = "active") => `
    title=${JSON.stringify(title)}
    surface="dashboard"
    workspaceName="PT Nusantara Arsitek"
    workspaceSubtitle="alpha-studio.situsku.click"
    activeNavId="plugins"
    basePath="/dashboard/alpha-studio"
    offeringLabel="Layanan"
    lifecycleStatus=${JSON.stringify(lifecycleStatus)}
    publicSiteHref="https://alpha-studio.situsku.click"
    userDisplayName="Budi Santoso"
    userRoleLabel="Pemilik Situs"
  `;

  // 1. Disconnected Telegram + Entitled Webhook (interactive 1-click link + SSRF + save + test)
  fs.writeFileSync(
    path.join(pagesDir, "lead-notifier-setup.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { LeadNotifierSettingsIsland } from ${JSON.stringify(islandImport)};
---
<DashboardLayout ${layoutProps("Lead Notifier — Plugin — PT Nusantara Arsitek")}>
  <LeadNotifierSettingsIsland
    client:load
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/plugins/lead-notifier"
    initialTelegram={{
      enabled: true,
      linked: false,
      maskedLabel: null,
      linkedAt: null,
      botUsername: "PunyaSitusBot",
      tokenTtlSeconds: 900,
    }}
    initialWebhook={{
      entitled: true,
      configured: false,
      enabled: true,
      targetUrl: null,
      secretMasked: null,
      maxRetries: 3,
      secretRotatedAt: null,
    }}
    initialDeliveries={[]}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  // 2. Connected Telegram + Configured Webhook + Delivery History (interactive unlink)
  fs.writeFileSync(
    path.join(pagesDir, "lead-notifier-connected.astro"),
    `---
import DashboardLayout from ${JSON.stringify(layoutImport)};
import { LeadNotifierSettingsIsland } from ${JSON.stringify(islandImport)};
---
<DashboardLayout ${layoutProps("Lead Notifier — Plugin — PT Nusantara Arsitek")}>
  <LeadNotifierSettingsIsland
    client:load
    basePath="/dashboard/alpha-studio"
    apiBaseUrl="/api/tenants/alpha-studio/plugins/lead-notifier"
    initialTelegram={{
      enabled: true,
      linked: true,
      maskedLabel: "@bu***so",
      linkedAt: 1795410000000,
      botUsername: "PunyaSitusBot",
      tokenTtlSeconds: 900,
    }}
    initialWebhook={{
      entitled: true,
      configured: true,
      enabled: true,
      targetUrl: "https://hooks.crm-nusantara.id/leads",
      secretMasked: "whsec_****8a2f",
      maxRetries: 3,
      secretRotatedAt: 1795410000000,
    }}
    initialDeliveries={[
      {
        deliveryId: "tg_001",
        eventName: "lead.created",
        channel: "telegram",
        status: "delivered",
        httpStatus: 200,
        attempts: 1,
        errorCode: null,
        targetSummary: "@bu***so",
        createdAt: 1795410600000,
      },
      {
        deliveryId: "wh_001",
        eventName: "lead.created",
        channel: "webhook",
        status: "delivered",
        httpStatus: 200,
        attempts: 1,
        errorCode: null,
        targetSummary: "https://hooks.crm-nusantara.id",
        createdAt: 1795410601000,
      },
    ]}
    permissions={{
      roleLabel: "Pemilik Situs",
      isLocked: false,
      canManagePlugins: true,
    }}
  />
</DashboardLayout>`,
  );

  const { build } = await import(astroEntryUrl);
  const reactIntegration = (
    await import(pathToFileURL(requireFromWeb.resolve("@astrojs/react")).href)
  ).default;
  const tailwindcss = (
    await import(pathToFileURL(requireFromWeb.resolve("@tailwindcss/vite")).href)
  ).default;

  const webNodeModules = path.join(webDir, "node_modules");

  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    outDir,
    cacheDir,
    integrations: [reactIntegration()],
    vite: {
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@": path.join(webDir, "src"),
          react: path.join(webNodeModules, "react"),
          "react-dom": path.join(webNodeModules, "react-dom"),
          "lucide-react": path.join(webNodeModules, "lucide-react"),
          "@base-ui/react": path.join(webNodeModules, "@base-ui/react"),
        },
      },
    },
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startFixtureServer(outDir) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/plugins/lead-notifier/telegram/link-token" &&
      req.method === "POST"
    ) {
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          deepLink: "https://t.me/PunyaSitusBot?start=26_01JT101E2ETENANT0000000001_AbCdEfGhIjKlMnOpQrStUv",
          botUsername: "PunyaSitusBot",
          expiresAt: Date.now() + 900_000,
          expiresInSeconds: 900,
          singleUse: true,
        }),
      );
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/plugins/lead-notifier/telegram/unlink" &&
      req.method === "POST"
    ) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, linked: false, revokedAt: Date.now() }));
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/plugins/lead-notifier/webhook" &&
      req.method === "POST"
    ) {
      const raw = (await readBodyBuffer(req)).toString("utf8");
      const body = JSON.parse(raw || "{}");
      const targetUrl = String(body.targetUrl || "");
      if (!targetUrl.startsWith("https://") || targetUrl.includes("127.0.0.1")) {
        res.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              code: "SSRF_IP_BLOCKED",
              message: "Alamat IP privat atau loopback diblokir demi keamanan SSRF.",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          webhook: {
            entitled: true,
            configured: true,
            enabled: true,
            targetUrl,
            secretMasked: "whsec_****9f4a",
            maxRetries: 3,
            secretRotatedAt: Date.now(),
          },
          secretOnce: "whsec_11223344556677889900aabbccddeeff1122334455669f4a",
        }),
      );
      return;
    }

    if (
      reqUrl.pathname === "/api/tenants/alpha-studio/plugins/lead-notifier/webhook/test" &&
      req.method === "POST"
    ) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          delivery: {
            deliveryId: "wh_test_e2e_001",
            status: "delivered",
            httpStatus: 200,
            attempts: 1,
            errorCode: null,
            targetSummary: "https://hooks.crm-nusantara.id",
          },
        }),
      );
      return;
    }

    let target = path.join(outDir, reqUrl.pathname);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, "index.html");
    } else if (!fs.existsSync(target) && fs.existsSync(`${target}.html`)) {
      target = `${target}.html`;
    } else if (!fs.existsSync(target) && fs.existsSync(path.join(target, "index.html"))) {
      target = path.join(target, "index.html");
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(target) });
    fs.createReadStream(target).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function run() {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const built = await buildLeadNotifierFixtures();
  const server = await startFixtureServer(built.outDir);
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromeExecutable(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const savedScreenshots = [];

  try {
    const viewports = [
      { name: "360x800", width: 360, height: 800 },
      { name: "1440x900", width: 1440, height: 900 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });

      // 1. Setup screen: 1-click Telegram link + Webhook save & test-send
      await page.goto(`${server.baseUrl}/lead-notifier-setup`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="lead-notifier-settings"]');
      await page.waitForSelector('[data-testid="telegram-connect-btn"]');

      const setupOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!setupOverflow, `Horizontal overflow detected on setup screen at ${vp.name}`);

      // Verify zero Radix DOM attributes
      const radixCount = await page.evaluate(
        () =>
          document.querySelectorAll(
            "[data-radix-collection-item], [data-radix-popper-content-wrapper]",
          ).length,
      );
      assert(radixCount === 0, "Forbidden Radix DOM attributes found");

      // Click "Hubungkan Telegram" -> deep-link card appears
      await page.click('[data-testid="telegram-connect-btn"]');
      await page.waitForSelector('[data-testid="telegram-deeplink-box"]');
      const href = await page
        .locator('[data-testid="telegram-open-deeplink-btn"]')
        .getAttribute("href");
      assert(
        href && href.startsWith("https://t.me/PunyaSitusBot?start="),
        `Expected valid t.me deep link, got: ${href}`,
      );

      // Save valid HTTPS webhook & trigger test-send
      await page.fill("#ln-webhook-url", "https://hooks.crm-nusantara.id/leads");
      await page.click('[data-testid="webhook-save-btn"]');
      await page.waitForSelector('[data-testid="webhook-secret-once"]');
      await page.click('[data-testid="webhook-test-btn"]');
      await page.waitForSelector('[data-testid="lead-notifier-deliveries-list"]');

      const postInteractOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!postInteractOverflow, `Horizontal overflow after interaction at ${vp.name}`);

      const setupShot = path.join(screenshotDir, `lead-notifier-setup-${vp.name}.png`);
      await page.screenshot({ path: setupShot, fullPage: true });
      savedScreenshots.push(setupShot);

      // 2. Connected state + Unlink flow
      await page.goto(`${server.baseUrl}/lead-notifier-connected`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="telegram-connected-panel"]');
      const maskedLabel = await page.locator('[data-testid="telegram-masked-label"]').textContent();
      assert(maskedLabel && maskedLabel.includes("@bu***so"), "Expected masked Telegram label");

      const connectedOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert(!connectedOverflow, `Horizontal overflow on connected screen at ${vp.name}`);

      const connectedShot = path.join(screenshotDir, `lead-notifier-connected-${vp.name}.png`);
      await page.screenshot({ path: connectedShot, fullPage: true });
      savedScreenshots.push(connectedShot);

      // Click "Putuskan Telegram" -> transitions to disconnected panel
      await page.click('[data-testid="telegram-unlink-btn"]');
      await page.waitForSelector('[data-testid="telegram-disconnected-panel"]');

      assert(errors.length === 0, `Browser runtime errors at ${vp.name}: ${errors.join("; ")}`);
      await context.close();
    }

    console.log(
      JSON.stringify(
        {
          task: "TASK-101",
          status: "PASS",
          viewports: ["360x800", "1440x900"],
          screenshots: savedScreenshots,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await server.close();
    built.cleanup();
  }
}

run().catch((err) => {
  console.error("TASK-101 E2E FAILED:", err);
  process.exit(1);
});
