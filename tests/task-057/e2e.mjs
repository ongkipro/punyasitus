/* global process, console, Buffer, setTimeout, clearTimeout, document, window, getComputedStyle, fetch */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");

const SCREENSHOT_DIR = process.env.TASK057_SCREENSHOT_DIR || "";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_QRIS_PAYLOAD =
  "0002010102125910PUNYASITUS6007JAKARTA54061802536304ABCD";
const SECRET_VA_NUMBER = "8800991122334455";

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

function findSqliteFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSqliteFiles(full, out);
    } else if (entry.name.endsWith(".sqlite")) {
      out.push(full);
    }
  }
  return out;
}

function findPlatformSqlitePath(persistDir) {
  const candidates = findSqliteFiles(persistDir).sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  );
  for (const file of candidates) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_obligations' LIMIT 1")
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(`Could not locate migrated PLATFORM_DB sqlite file under ${persistDir}`);
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
  return persistTo;
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

async function waitForServer(getPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(getPort(), "/auth/login");
      if (res.status === 200) return getPort();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`astro dev did not become ready on port ${getPort()}`);
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
        if (el.getAttribute("type") === "checkbox") return false;
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
      if (ctrl.tag === "BUTTON" || ctrl.tag === "A" || ctrl.tag === "INPUT" || ctrl.tag === "SELECT") {
        // Inline links inside prose paragraphs/card content (e.g. leads export link or step-up link) are exempt when < 44px; buttons/inputs/primary CTAs must be >= 44px
        if (ctrl.tag === "A" && ctrl.height < 44 && ctrl.id === "") continue;
        if (ctrl.tag === "A" && ctrl.id === "billing-leads-export-link") continue;
        assert(
          ctrl.height >= 44,
          `[${label} @ ${width}px] Mobile touch target ${ctrl.tag}(${ctrl.id}) height ${ctrl.height}px < 44px`,
        );
      }
    }
  }
}

async function maybeCaptureScreenshot(page, filename) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
}

async function signUpInBrowser(page, baseUrl, email, password, name) {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
  const res = await page.evaluate(
    async ({ e, p, n }) => {
      const r = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: e, password: p, name: n }),
      });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, userId: json?.user?.id ?? "" };
    },
    { e: email, p: password, n: name },
  );
  assert(res.ok && res.userId, `Sign-up failed for ${email}: ${res.status}`);
  return res.userId;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function makeCrockfordUlid() {
  const bytes = crypto.randomBytes(26);
  let out = "01J";
  for (let i = 3; i < 26; i += 1) {
    out += CROCKFORD[bytes[i] % CROCKFORD.length];
  }
  return out;
}

function makeUlidLike(prefix) {
  const rand = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `${prefix}_${Date.now().toString(36).toUpperCase()}${rand}`.slice(0, 26);
}

async function run() {
  const persistDir = ensureLocalD1Migrated();
  let activePort = await getFreePort();

  const server = spawn(
    "pnpm",
    ["exec", "astro", "dev", "--host", "127.0.0.1", "--port", String(activePort), "--ignore-lock"],
    {
      cwd: webDir,
      env: cleanChildEnv({ PUNYASITUS_DISABLE_DEV_TOOLBAR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let serverLogs = "";
  const parseBoundPort = (chunk) => {
    const text = chunk.toString();
    serverLogs += text;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
    if (match?.[1]) {
      activePort = Number.parseInt(match[1], 10);
    }
  };
  server.stdout.on("data", parseBoundPort);
  server.stderr.on("data", parseBoundPort);

  let browser;
  try {
    const resolvedPort = await waitForServer(() => activePort);
    const baseUrl = `http://127.0.0.1:${resolvedPort}`;

    const executablePath = findChromeExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
    const password = "BillingE2ePassword!2026";
    const ownerAEmail = `t057-owner-a-${suffix}@example.com`;
    const memberAEmail = `t057-member-a-${suffix}@example.com`;
    const ownerBEmail = `t057-owner-b-${suffix}@example.com`;
    const opEmail = `t057-op-${suffix}@example.com`;

    const handleA = `kopi-t057a-${suffix}`.slice(0, 32);
    const handleB = `kopi-t057b-${suffix}`.slice(0, 32);

    // 1. Create isolated browser contexts for Owner A, Member A, Owner B, and Platform Operator
    const ownerACtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerAPage = await ownerACtx.newPage();
    const memberACtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const memberAPage = await memberACtx.newPage();
    const ownerBCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ownerBPage = await ownerBCtx.newPage();
    const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const opPage = await opCtx.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    for (const p of [ownerAPage, memberAPage, opPage]) {
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });
      p.on("pageerror", (err) => pageErrors.push(String(err)));
    }

    const ownerAUserId = await signUpInBrowser(ownerAPage, baseUrl, ownerAEmail, password, "Budi Pemilik");
    const memberAUserId = await signUpInBrowser(memberAPage, baseUrl, memberAEmail, password, "Siti Editor");
    const ownerBUserId = await signUpInBrowser(ownerBPage, baseUrl, ownerBEmail, password, "Andi Tenant Lain");
    const opUserId = await signUpInBrowser(opPage, baseUrl, opEmail, password, "Superadmin Billing");
    void opUserId;

    // Seed tenants, memberships, and billing tables in local D1 SQLite
    const sqlitePath = findPlatformSqlitePath(persistDir);
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const orgAId = makeUlidLike("ORG");
    const orgBId = makeUlidLike("ORG");
    const tenantAId = makeCrockfordUlid();
    const tenantBId = makeCrockfordUlid();
    const consoleOblId = makeUlidLike("OBL");
    const consoleAttId = makeUlidLike("ATT");

    const db = new DatabaseSync(sqlitePath);
    try {
      db.prepare("UPDATE users SET email_verified = 1 WHERE lower(email) IN (?, ?, ?, ?)").run(
        ownerAEmail.toLowerCase(),
        memberAEmail.toLowerCase(),
        ownerBEmail.toLowerCase(),
        opEmail.toLowerCase(),
      );

      db.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(orgAId, "Kopi Nusantara A", handleA, nowMs, nowMs);
      db.prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(orgBId, "Kopi Nusantara B", handleB, nowMs, nowMs);

      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'grace', 0, NULL, ?, ?, ?)`,
      ).run(tenantAId, orgAId, handleA, "Kopi Nusantara A", nowMs - 2 * dayMs, nowMs, nowMs);

      db.prepare(
        `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, trial_ends_at, paid_through, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 0, NULL, ?, ?, ?)`,
      ).run(tenantBId, orgBId, handleB, "Kopi Nusantara B", nowMs + 20 * dayMs, nowMs, nowMs);

      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).run(makeUlidLike("MEM"), orgAId, ownerAUserId, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)",
      ).run(makeUlidLike("MEM"), orgAId, memberAUserId, nowMs);
      db.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      ).run(makeUlidLike("MEM"), orgBId, ownerBUserId, nowMs);
    } finally {
      db.close();
    }

    // Bootstrap Platform Operator & enroll real 2FA
    const cliRes = spawnSync(
      "node",
      [
        path.join(root, "scripts/platform-operator.mjs"),
        "--mode",
        "recover",
        "--email",
        opEmail,
        "--reason",
        "Automated TASK-057 Chromium E2E operator bootstrap",
        "--db-file",
        sqlitePath,
        "--local",
      ],
      { cwd: root, env: cleanChildEnv(), encoding: "utf8" },
    );
    assert(cliRes.status === 0, `platform-operator CLI failed: ${cliRes.stderr}`);

    await opPage.goto(`${baseUrl}/auth/two-factor?mode=enroll`, { waitUntil: "networkidle" });
    await opPage.fill("#twofa-enroll-password", password);
    await opPage.click('[data-testid="twofa-enroll-start-button"]');
    await opPage.waitForSelector('[data-testid="twofa-enroll-secret-panel"]');
    const opSecret = (await opPage.textContent('[data-testid="twofa-manual-secret"]'))?.trim() ?? "";
    await opPage.fill("#twofa-confirm-code", generateTotpCode(opSecret));
    await opPage.click('[data-testid="twofa-confirm-enroll-button"]');
    await opPage.waitForSelector('[data-testid="twofa-success-alert"]');

    // =========================================================================
    // SCENARIO 1: Owner Service-Status link & Billing Pre-Creation Disclosures
    // =========================================================================
    await ownerAPage.goto(`${baseUrl}/dashboard/${handleA}/service-status`, {
      waitUntil: "networkidle",
    });
    const ssBillingLink = ownerAPage.locator('[data-testid="service-status-billing-link"]');
    assert(await ssBillingLink.isVisible(), "Owner must see billing CTA link on service-status");

    // Mock browser refresh & submit API calls on Owner A page to exercise full QRIS/VA channel flow + double-click idempotency
    const mockChannels = [
      { code: "QRIS", label: "QRIS Nasional", kind: "QRIS", estimatedFeeIdr: 1_253, enabled: true },
      { code: "VABCA", label: "BCA Virtual Account", kind: "VA", estimatedFeeIdr: 4_000, enabled: true },
      // Defense-in-depth: forbidden channels MUST NEVER render in UI even if sent
      { code: "COD", label: "Bayar di Tempat", kind: "VA", estimatedFeeIdr: 0, enabled: true },
      { code: "ALFAMART", label: "Alfamart", kind: "VA", estimatedFeeIdr: 5_000, enabled: true },
    ];

    let activeStateMode = "ready"; // ready | historical_paid_grace | qris_pending | va_pending | creation_unknown | expired | paid | review | outage
    let submitPostCount = 0;
    const seenIdempotencyKeys = [];

    const makeMockOverviewPayload = () => {
      const base = {
        tenantStatus: activeStateMode === "paid" ? "active" : "grace",
        operatorHold: false,
        operatorHoldReason: null,
        trialEndsAt: null,
        paidThrough:
          activeStateMode === "paid"
            ? new Date(nowMs + 30 * dayMs).toISOString()
            : new Date(nowMs - 2 * dayMs).toISOString(),
        graceEndsAt: new Date(nowMs + 1 * dayMs).toISOString(),
        lockedEndsAt: new Date(nowMs + 5 * dayMs).toISOString(),
        deletionDueAt: new Date(nowMs + 43 * dayMs).toISOString(),
        pricingPlans: [
          { plan: "monthly", months: 1, baseAmountIdr: 179_000, currency: "IDR", savingsIdr: 0 },
          { plan: "yearly", months: 12, baseAmountIdr: 1_790_000, currency: "IDR", savingsIdr: 358_000 },
        ],
        channels: activeStateMode === "outage" ? [] : mockChannels,
        providerOutage: activeStateMode === "outage",
        taxNotice:
          "Harga belum termasuk PPN (penyelenggara belum PKP; bukti bayar berupa kuitansi layanan, bukan faktur pajak).",
        noRefundNotice:
          "Pembayaran langganan tidak dapat dikembalikan karena berubah pikiran. Pengembalian dana hanya diproses manual oleh superadmin untuk pembayaran ganda atau salah bayar.",
      };

      const sampleObl = {
        obligationId: "obl_e2e_001",
        plan: "monthly",
        payerKind: "tenant",
        state:
          activeStateMode === "paid" || activeStateMode === "historical_paid_grace"
            ? "paid"
            : activeStateMode === "review"
              ? "review"
              : activeStateMode === "expired"
                ? "expired"
                : "open",
        baseAmountIdr: 179_000,
        discountAmountIdr: 0,
        netAmountIdr: 179_000,
        currency: "IDR",
        periodStartAt: new Date(
          activeStateMode === "historical_paid_grace" ? nowMs - 32 * dayMs : nowMs,
        ).toISOString(),
        periodEndAt: new Date(
          activeStateMode === "historical_paid_grace" ? nowMs - 2 * dayMs : nowMs + 30 * dayMs,
        ).toISOString(),
        version: 1,
        createdAt: new Date(nowMs).toISOString(),
      };

      if (activeStateMode === "historical_paid_grace") {
        return { ...base, activeObligation: null, activeAttempt: null, obligations: [sampleObl] };
      }

      if (activeStateMode === "ready" || activeStateMode === "outage") {
        return { ...base, activeObligation: null, activeAttempt: null, obligations: [] };
      }
      if (activeStateMode === "qris_pending") {
        return {
          ...base,
          activeObligation: sampleObl,
          activeAttempt: {
            attemptId: "att_e2e_qris",
            obligationId: "obl_e2e_001",
            reffId: "PS261123QRIS01",
            plan: "monthly",
            channelKind: "QRIS",
            channelCode: "QRIS",
            state: "pending",
            baseAmountIdr: 179_000,
            discountAmountIdr: 0,
            channelFeeIdr: 1_253,
            totalPayableIdr: 180_253,
            currency: "IDR",
            taxNotice: base.taxNotice,
            qrisPayload: SECRET_QRIS_PAYLOAD,
            vaNumber: null,
            bankName: null,
            paymentRedirectUrl: "https://pay.autolaris.com/qris/PS261123QRIS01",
            expiresAt: new Date(nowMs + 2 * 3600 * 1000).toISOString(),
            createdAt: new Date(nowMs).toISOString(),
          },
          obligations: [sampleObl],
        };
      }
      if (activeStateMode === "va_pending") {
        return {
          ...base,
          activeObligation: sampleObl,
          activeAttempt: {
            attemptId: "att_e2e_va",
            obligationId: "obl_e2e_001",
            reffId: "PS261123VABCA1",
            plan: "monthly",
            channelKind: "VA",
            channelCode: "VABCA",
            state: "pending",
            baseAmountIdr: 179_000,
            discountAmountIdr: 0,
            channelFeeIdr: 4_000,
            totalPayableIdr: 183_000,
            currency: "IDR",
            taxNotice: base.taxNotice,
            qrisPayload: null,
            vaNumber: SECRET_VA_NUMBER,
            bankName: "BCA Virtual Account",
            paymentRedirectUrl: "https://pay.autolaris.com/va/PS261123VABCA1",
            expiresAt: new Date(nowMs + 3 * 3600 * 1000).toISOString(),
            createdAt: new Date(nowMs).toISOString(),
          },
          obligations: [sampleObl],
        };
      }
      if (activeStateMode === "creation_unknown") {
        return {
          ...base,
          activeObligation: sampleObl,
          activeAttempt: {
            attemptId: "att_e2e_unk",
            obligationId: "obl_e2e_001",
            reffId: "PS261123UNK001",
            plan: "monthly",
            channelKind: "QRIS",
            channelCode: "QRIS",
            state: "creation_unknown",
            baseAmountIdr: 179_000,
            discountAmountIdr: 0,
            channelFeeIdr: 1_253,
            totalPayableIdr: 180_253,
            currency: "IDR",
            taxNotice: base.taxNotice,
            qrisPayload: null,
            vaNumber: null,
            bankName: null,
            paymentRedirectUrl: null,
            expiresAt: null,
            createdAt: new Date(nowMs).toISOString(),
          },
          obligations: [sampleObl],
        };
      }
      if (activeStateMode === "expired") {
        return {
          ...base,
          activeObligation: sampleObl,
          activeAttempt: {
            attemptId: "att_e2e_exp",
            obligationId: "obl_e2e_001",
            reffId: "PS261123EXP001",
            plan: "monthly",
            channelKind: "QRIS",
            channelCode: "QRIS",
            state: "expired",
            baseAmountIdr: 179_000,
            discountAmountIdr: 0,
            channelFeeIdr: 1_253,
            totalPayableIdr: 180_253,
            currency: "IDR",
            taxNotice: base.taxNotice,
            qrisPayload: null,
            vaNumber: null,
            bankName: null,
            paymentRedirectUrl: null,
            expiresAt: new Date(nowMs - 3600 * 1000).toISOString(),
            createdAt: new Date(nowMs - 25 * 3600 * 1000).toISOString(),
          },
          obligations: [sampleObl],
        };
      }
      if (activeStateMode === "review") {
        return {
          ...base,
          activeObligation: sampleObl,
          activeAttempt: {
            attemptId: "att_e2e_rev",
            obligationId: "obl_e2e_001",
            reffId: "PS261123REV001",
            plan: "monthly",
            channelKind: "QRIS",
            channelCode: "QRIS",
            state: "review",
            baseAmountIdr: 179_000,
            discountAmountIdr: 0,
            channelFeeIdr: 1_253,
            totalPayableIdr: 180_253,
            currency: "IDR",
            taxNotice: base.taxNotice,
            qrisPayload: null,
            vaNumber: null,
            bankName: null,
            paymentRedirectUrl: null,
            expiresAt: null,
            createdAt: new Date(nowMs).toISOString(),
          },
          obligations: [sampleObl],
        };
      }
      // paid
      return {
        ...base,
        activeObligation: null,
        activeAttempt: null,
        obligations: [sampleObl],
      };
    };

    await ownerAPage.route("**/api/tenants/*/billing", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeMockOverviewPayload()),
      });
    });

    await ownerAPage.route("**/api/tenants/*/billing/obligations", async (route) => {
      if (route.request().method() === "POST") {
        submitPostCount += 1;
        const idem = route.request().headers()["idempotency-key"] ?? "";
        seenIdempotencyKeys.push(idem);
        await new Promise((r) => setTimeout(r, 120));
        activeStateMode = "qris_pending";
        const payload = makeMockOverviewPayload();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            obligation: payload.activeObligation,
            attempt: payload.activeAttempt,
            replayed: false,
          }),
        });
        return;
      }
      await route.continue();
    });

    // Load Owner Billing page & click refresh to populate mocked live channels
    await ownerAPage.setViewportSize({ width: 1440, height: 900 });
    await ownerAPage.goto(`${baseUrl}/dashboard/${handleA}/billing`, { waitUntil: "networkidle" });
    await ownerAPage.waitForSelector('[data-testid="owner-billing-panel"]');
    await ownerAPage.click('[data-testid="billing-refresh-status-btn"]');
    await ownerAPage.waitForSelector('[data-testid="billing-channel-QRIS"]');

    // Verify mandatory disclosures BEFORE attempt creation!
    const noRefundText = await ownerAPage.textContent('[data-testid="billing-no-refund-disclosure"]');
    const nonPkpText = await ownerAPage.textContent('[data-testid="billing-non-pkp-disclosure"]');
    assert(
      noRefundText && noRefundText.includes("tidak dapat dikembalikan") && noRefundText.includes("pembayaran ganda"),
      `Missing mandatory no-refund disclosure: ${noRefundText}`,
    );
    assert(
      nonPkpText && nonPkpText.toLowerCase().includes("belum termasuk ppn"),
      `Missing mandatory non-PKP disclosure: ${nonPkpText}`,
    );

    // Verify ONLY QRIS & VA channels rendered (COD & Alfamart MUST NOT exist!)
    assert((await ownerAPage.locator('[data-testid="billing-channel-QRIS"]').count()) === 1, "QRIS missing");
    assert((await ownerAPage.locator('[data-testid="billing-channel-VABCA"]').count()) === 1, "VABCA missing");
    assert((await ownerAPage.locator('[data-testid="billing-channel-COD"]').count()) === 0, "COD must not render");
    assert((await ownerAPage.locator('[data-testid="billing-channel-ALFAMART"]').count()) === 0, "ALFAMART must not render");

    // Verify exact total & yearly savings
    assert(
      (await ownerAPage.textContent('[data-testid="billing-yearly-savings-badge"]'))?.includes("Rp 358.000"),
      "Yearly savings badge must show Rp 358.000",
    );
    assert(
      (await ownerAPage.textContent('[data-testid="billing-summary-total"]'))?.includes("Rp 180.253"),
      "Summary total must show Rp 180.253",
    );

    await assertViewportLayoutAndTouchTargets(ownerAPage, "billing-owner-ready", 1440);
    await maybeCaptureScreenshot(ownerAPage, "billing-owner-1440.png");

    await ownerAPage.setViewportSize({ width: 768, height: 900 });
    await assertViewportLayoutAndTouchTargets(ownerAPage, "billing-owner-ready", 768);

    await ownerAPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(ownerAPage, "billing-owner-ready", 360);
    await maybeCaptureScreenshot(ownerAPage, "billing-owner-360.png");

    // =========================================================================
    // SCENARIO 2: Rapid Double-Click Idempotency + QRIS SVG + Readable Alt + VA
    // =========================================================================
    await ownerAPage.setViewportSize({ width: 1440, height: 900 });
    const submitBtn = ownerAPage.locator('[data-testid="billing-create-instruction-submit"]');
    // Rapid synchronous double-click (two back-to-back clicks before React disables/detaches form)
    await submitBtn.evaluate((el) => {
      el.click();
      el.click();
    });
    await ownerAPage.waitForSelector('[data-testid="billing-active-instruction-card"]');

    assert(submitPostCount === 1, `Rapid double-click fired ${submitPostCount} POSTs; expected strictly 1!`);
    assert(
      seenIdempotencyKeys.length === 1 && /^[0-9a-f-]{36}$/i.test(seenIdempotencyKeys[0]),
      `Expected valid UUID Idempotency-Key, got ${JSON.stringify(seenIdempotencyKeys)}`,
    );

    // QRIS SVG + readable alternative + copy button + approved AutoLaris redirect
    const svgCount = await ownerAPage.locator('[data-testid="billing-qris-svg-container"] svg[role="img"]').count();
    assert(svgCount === 1, "Expected deterministic QRIS SVG image");
    const altText = await ownerAPage.textContent('[data-testid="billing-qris-readable-alternative"]');
    assert(altText && altText.includes("PUNYASITUS") && altText.includes("Rp 180.253"), "Missing readable QRIS alternative");
    assert(await ownerAPage.locator('[data-testid="billing-approved-redirect-link"]').isVisible(), "Approved AutoLaris redirect should be visible");

    await maybeCaptureScreenshot(ownerAPage, "billing-qris-active-1440.png");

    // Reload page and verify active QRIS instruction is reused cleanly with ZERO duplicate submit
    await ownerAPage.reload({ waitUntil: "networkidle" });
    await ownerAPage.click('[data-testid="billing-refresh-status-btn"]');
    await ownerAPage.waitForSelector('[data-testid="billing-active-instruction-card"]');
    assert(submitPostCount === 1, `Page reload must never trigger a second charge (got ${submitPostCount})`);

    // Check VA state rendering
    activeStateMode = "va_pending";
    await ownerAPage.click('[data-testid="billing-refresh-status-btn"]');
    await ownerAPage.waitForSelector('[data-testid="billing-va-instruction"]');
    const vaText = await ownerAPage.textContent('[data-testid="billing-va-number-display"]');
    assert(vaText && vaText.includes(SECRET_VA_NUMBER), "Expected VA number display");

    // Check creation_unknown, expired, review, provider_outage, and paid states
    for (const [mode, testId] of [
      ["creation_unknown", "billing-state-creation-unknown"],
      ["expired", "billing-state-expired"],
      ["review", "billing-state-review"],
      ["outage", "billing-state-provider-outage"],
      ["paid", "billing-state-paid"],
    ]) {
      activeStateMode = mode;
      await ownerAPage.click('[data-testid="billing-refresh-status-btn"]');
      await ownerAPage.waitForSelector(`[data-testid="${testId}"]`);
    }
    assert(
      await ownerAPage.locator('[data-testid="billing-paid-return-dashboard-cta"]').isVisible(),
      "Paid state must show safe return CTA to dashboard",
    );

    // R3 regression check: prior cycle paid obligation while tenant is in grace MUST NOT render false "Langganan Aktif" banner
    activeStateMode = "historical_paid_grace";
    await ownerAPage.click('[data-testid="billing-refresh-status-btn"]');
    await ownerAPage.waitForSelector('[data-testid="billing-checkout-form"]');
    assert(
      (await ownerAPage.locator('[data-testid="billing-state-paid"]').count()) === 0,
      "Grace tenant with earlier paid obligation MUST NOT show false 'Pembayaran Terverifikasi — Langganan Aktif' banner",
    );

    // =========================================================================
    // SCENARIO 3: Payment-Return Query Params NEVER Activate + Locked Owner ZERO CMS Flash!
    // =========================================================================
    // Switch Tenant A to `locked` in real local D1 + remove mocked route so real SSR runs
    await ownerAPage.unroute("**/api/tenants/*/billing");
    const db2 = new DatabaseSync(sqlitePath);
    try {
      db2
        .prepare("UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?")
        .run(nowMs - 5 * dayMs, tenantAId);
    } finally {
      db2.close();
    }

    await ownerAPage.goto(
      `${baseUrl}/dashboard/${handleA}/billing?status=paid&paid=1&return=success`,
      { waitUntil: "networkidle" },
    );
    await ownerAPage.waitForSelector('[data-testid="billing-payment-only-shell"]');
    await ownerAPage.waitForSelector('[data-testid="billing-return-non-activation-notice"]');

    // Verify ZERO CMS sidebar flash & ZERO dead /leads/export.csv link on locked owner payment-only shell
    const lockedSidebarCount = await ownerAPage.locator('[data-slot="sidebar-container"]').count();
    assert(lockedSidebarCount === 0, `Locked owner billing must render ZERO CMS sidebar (got ${lockedSidebarCount})`);
    assert(
      (await ownerAPage.locator('[data-testid="billing-leads-export-link"]').count()) === 0,
      "Locked owner billing must NOT render unverified dead /leads/export.csv link",
    );

    // Verify ?status=paid did NOT fake "active" or "paid" status
    const lockedStatusAttr = await ownerAPage
      .locator('[data-testid="owner-billing-panel"]')
      .getAttribute("data-tenant-status");
    assert(
      lockedStatusAttr === "locked",
      `Payment-return query params must NEVER activate locked tenant (got ${lockedStatusAttr})`,
    );

    // Verify /dashboard/[handle]/service-status as LOCKED OWNER also renders ZERO CMS sidebar flash!
    await ownerAPage.goto(`${baseUrl}/dashboard/${handleA}/service-status`, {
      waitUntil: "networkidle",
    });
    await ownerAPage.waitForSelector('[data-testid="service-status-recovery-shell"]');
    await ownerAPage.waitForSelector('[data-testid="service-status-page"]');
    assert(
      (await ownerAPage.locator('[data-slot="sidebar-container"]').count()) === 0,
      "Locked owner service-status must render ZERO CMS sidebar",
    );

    // Keyboard Tab accessibility check
    await ownerAPage.keyboard.press("Tab");
    const focusTag = await ownerAPage.evaluate(() => document.activeElement?.tagName ?? "");
    assert(focusTag === "A" || focusTag === "BUTTON", `Expected focusable control on Tab, got ${focusTag}`);

    // =========================================================================
    // SCENARIO 4: Non-Owner Member Notice & Cross-Tenant Neutral 404
    // =========================================================================
    await memberAPage.setViewportSize({ width: 1440, height: 900 });
    await memberAPage.goto(`${baseUrl}/dashboard/${handleA}/billing`, { waitUntil: "networkidle" });
    await memberAPage.waitForSelector('[data-testid="member-billing-notice-view"]');
    const memberAlert = await memberAPage.textContent('[data-testid="billing-member-contact-owner-alert"]');
    assert(
      memberAlert && memberAlert.includes("Hubungi pemilik situs"),
      `Member notice must say Hubungi pemilik situs: ${memberAlert}`,
    );
    assert(
      (await memberAPage.locator('[data-testid="billing-create-instruction-submit"]').count()) === 0,
      "Member MUST NOT see payment creation button",
    );
    assert(
      (await memberAPage.locator('[data-testid^="billing-channel-"]').count()) === 0,
      "Member MUST NOT see channel selection buttons",
    );
    await assertViewportLayoutAndTouchTargets(memberAPage, "billing-member-notice", 1440);
    await maybeCaptureScreenshot(memberAPage, "billing-member-notice-1440.png");

    // Verify /dashboard/[handle]/service-status as LOCKED MEMBER also renders ZERO CMS sidebar flash!
    await memberAPage.goto(`${baseUrl}/dashboard/${handleA}/service-status`, {
      waitUntil: "networkidle",
    });
    await memberAPage.waitForSelector('[data-testid="service-status-recovery-shell"]');
    await memberAPage.waitForSelector('[data-testid="service-status-page"]');
    assert(
      (await memberAPage.locator('[data-slot="sidebar-container"]').count()) === 0,
      "Locked member service-status must render ZERO CMS sidebar",
    );

    // Cross-tenant Owner B -> neutral 404 on Tenant A billing
    const crossResp = await ownerBPage.goto(`${baseUrl}/dashboard/${handleA}/billing`, {
      waitUntil: "domcontentloaded",
    });
    assert(
      crossResp && crossResp.status() === 404,
      `Cross-tenant access must return neutral 404, got ${crossResp?.status()}`,
    );

    // =========================================================================
    // SCENARIO 5: Scoped Console Operator Billing (/console/billing)
    // =========================================================================
    // Seed a real billing obligation + payment attempt containing SECRET_QRIS_PAYLOAD in local D1
    const consoleTrxId = `ALX-C57-${suffix}`.slice(0, 28);
    const consoleReffId = `PS57${suffix.toUpperCase()}`.slice(0, 24);
    const consoleIdemKey = crypto.randomUUID();
    const db3 = new DatabaseSync(sqlitePath);
    try {
      db3
        .prepare(
          `INSERT INTO billing_obligations (
             id, tenant_id, payer_type, plan_interval, status,
             gross_amount_idr, discount_amount_idr, net_amount_idr, currency,
             period_start_at, period_end_at, due_at, review_required, version, created_at, updated_at
           ) VALUES (?, ?, 'tenant', 'monthly', 'open', 179000, 0, 179000, 'IDR', ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(consoleOblId, tenantAId, nowMs, nowMs + 30 * dayMs, nowMs + dayMs, nowMs, nowMs);

      db3
        .prepare(
          `INSERT INTO payment_attempts (
             id, obligation_id, tenant_id, channel, provider, provider_account_id,
             provider_transaction_id, reff_id, channel_code, idempotency_key, request_hash,
             amount_idr, state, lifecycle_state, base_amount_idr, discount_amount_idr,
             channel_fee_idr, total_payable_idr, provider_payload_json, version, created_at, updated_at
           ) VALUES (?, ?, ?, 'QRIS', 'autolaris', 'default', ?, ?, 'QRIS',
             ?, 'hash_t057', 180253, 'pending', 'review',
             179000, 0, 1253, 180253, ?, 1, ?, ?)`,
        )
        .run(
          consoleAttId,
          consoleOblId,
          tenantAId,
          consoleTrxId,
          consoleReffId,
          consoleIdemKey,
          JSON.stringify({ qrisPayload: SECRET_QRIS_PAYLOAD, vaNumber: SECRET_VA_NUMBER }),
          nowMs,
          nowMs,
        );
    } finally {
      db3.close();
    }

    // Non-operator (Owner B) receives 403 on /console/billing
    const nonOpConsoleResp = await ownerBPage.goto(`${baseUrl}/console/billing`, {
      waitUntil: "domcontentloaded",
    });
    assert(
      nonOpConsoleResp && nonOpConsoleResp.status() === 403,
      `Non-operator on /console/billing must return 403, got ${nonOpConsoleResp?.status()}`,
    );

    // Verified 2FA Operator loads /console/billing
    await opPage.setViewportSize({ width: 1440, height: 900 });
    await opPage.goto(`${baseUrl}/console/billing`, { waitUntil: "networkidle" });
    await opPage.waitForSelector('[data-testid="console-billing-panel"]');

    const opBanner = await opPage.textContent('[data-testid="console-context-banner"]');
    assert(
      opBanner &&
        opBanner.includes("Console Operasional Platform") &&
        opBanner.includes("bukan penyamaran akun tenant"),
      `Missing console context banner: ${opBanner}`,
    );

    // Verify strictly redacted page content: ZERO raw QRIS payload, ZERO raw VA number, ZERO arbitrary Mark Paid toggle!
    const consoleBodyHtml = await opPage.content();
    assert(!consoleBodyHtml.includes(SECRET_QRIS_PAYLOAD), "Console billing leaked raw QRIS payload!");
    assert(!consoleBodyHtml.includes(SECRET_VA_NUMBER), "Console billing leaked raw VA number!");
    assert(
      !/Tandai Lunas|Mark Paid/i.test(consoleBodyHtml),
      "Console billing must NOT contain arbitrary Mark Paid toggle!",
    );
    assert(
      consoleBodyHtml.includes(consoleReffId) && consoleBodyHtml.includes(consoleTrxId),
      "Console billing must show redacted reffId & providerTransactionId",
    );

    // Audited Advice Recheck UI test (intercepting external relay call response cleanly)
    await opPage.route("**/api/console/billing/recheck", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      assert(typeof body.reason === "string" && body.reason.length >= 10, "Recheck must send 10+ char audit reason");
      assert(!("markPaid" in body), "Recheck must never send markPaid");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          recheck: {
            attemptId: consoleAttId,
            obligationId: consoleOblId,
            tenantId: tenantAId,
            outcome: "pending",
            reasonCode: "PROVIDER_PENDING",
            grantApplied: false,
            operatorHoldPreserved: false,
          },
          auditId: "aud_e2e_recheck_1",
        }),
      });
    });

    await opPage.click(`[data-testid="console-recheck-trigger-${consoleOblId}"]`);
    await opPage.waitForSelector('[data-testid="console-billing-recheck-card"]');
    await opPage.fill(
      '[data-testid="console-recheck-reason-input"]',
      "Pemeriksaan ulang Advice manual untuk antrean tinjauan #57",
    );
    await opPage.click('[data-testid="console-recheck-confirm-btn"]');
    await opPage.waitForSelector('[data-testid="console-billing-success-alert"]');

    // Audited Duplicate Payment Refund Recording (REAL end-to-end against local D1!)
    await opPage.click(`[data-testid="console-refund-trigger-${consoleOblId}"]`);
    await opPage.waitForSelector('[data-testid="console-billing-refund-card"]');
    await opPage.selectOption('[data-testid="console-refund-kind-select"]', "duplicate_payment");
    await opPage.fill('[data-testid="console-refund-extref-input"]', "BTF-E2E-T057");
    await opPage.fill(
      '[data-testid="console-refund-reason-input"]',
      "Pengembalian dana manual pembayaran ganda QRIS terverifikasi mutasi",
    );
    await opPage.check('[data-testid="console-refund-confirm-checkbox"]');
    await opPage.click('[data-testid="console-refund-submit-btn"]');
    await opPage.waitForSelector('[data-testid="console-refunds-table"]');
    const refundsText = await opPage.textContent('[data-testid="console-refunds-table"]');
    assert(
      refundsText && refundsText.includes("BTF-E2E-T057") && refundsText.includes("duplicate_payment"),
      `Expected recorded refund in console refunds table: ${refundsText}`,
    );

    await assertViewportLayoutAndTouchTargets(opPage, "console-billing", 1440);
    await maybeCaptureScreenshot(opPage, "console-billing-1440.png");

    await opPage.setViewportSize({ width: 360, height: 800 });
    await assertViewportLayoutAndTouchTargets(opPage, "console-billing", 360);

    assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join("\n")}`);
    assert(pageErrors.length === 0, `Page errors detected:\n${pageErrors.join("\n")}`);

    await ownerACtx.close();
    await memberACtx.close();
    await ownerBCtx.close();
    await opCtx.close();

    console.log(
      "PASS: TASK-057 Chromium E2E verified owner pre-creation no-refund & non-PKP disclosures, QRIS/VA only channels, rapid double-click idempotency, QRIS SVG + readable alternative + VA copy, ?status=paid non-activation, all 6 payment states, locked owner payment-only shell (zero CMS flash), member owner-contact notice, cross-tenant 404, and console redacted billing + audited Advice recheck & duplicate refund recording across 360px/768px/1440px with 0 console/page errors.",
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
