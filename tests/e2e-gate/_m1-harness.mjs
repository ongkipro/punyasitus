/* global process, setTimeout, clearTimeout, Buffer */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitMigrationStatements } from "../../packages/db/src/connections/sql-splitter.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export const WEB_DIR = path.join(REPO_ROOT, "apps/web");
export const BUILT_WRANGLER_CONFIG = path.join(WEB_DIR, "dist/server/wrangler.json");

const requireFromWeb = createRequire(path.join(WEB_DIR, "package.json"));
export const { chromium } = requireFromWeb("playwright-core");

export function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

export function cleanChildEnv(extra = {}) {
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

export function findChromeExecutable() {
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

export function getFreePort() {
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

export function ensureWebDistBuilt(forceRebuild = false) {
  if (!forceRebuild && fs.existsSync(BUILT_WRANGLER_CONFIG)) {
    return;
  }
  const build = spawnSync("pnpm", ["--filter", "@punyasitus/web", "build"], {
    cwd: REPO_ROOT,
    env: cleanChildEnv(),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`@punyasitus/web build failed with exit code ${build.status}`);
  }
  assert(
    fs.existsSync(BUILT_WRANGLER_CONFIG),
    `Expected built wrangler config at ${BUILT_WRANGLER_CONFIG}`,
  );
}

export function findSqliteFiles(dir, out = []) {
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

export function findPlatformSqlitePath(persistDir) {
  const candidates = findSqliteFiles(persistDir).sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  );
  for (const file of candidates) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants' LIMIT 1")
        .get();
      if (row) return file;
    } finally {
      db.close();
    }
  }
  throw new Error(`Could not locate migrated PLATFORM_DB sqlite file under ${persistDir}`);
}

export function migrateLocalPlatformDb(persistDir) {
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
      persistDir,
    ],
    { cwd: WEB_DIR, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 migrations apply failed:\n${res.stdout}\n${res.stderr}`);
  }
  return findPlatformSqlitePath(persistDir);
}

/**
 * Applies all M1 tenant migrations (0002..0021) idempotently to every materialized
 * local `TenantStore` Durable Object SQLite database inside `persistDir`.
 * Must be called while the local wrangler worker is stopped to avoid lock contention.
 */
export function applyAllTenantMigrationsToLocalDos(persistDir) {
  const doDir = path.join(persistDir, "v3/do");
  const sqliteFiles = findSqliteFiles(doDir);
  const tenantMigDir = path.join(REPO_ROOT, "packages/db/migrations/tenant");
  const migFiles = fs
    .readdirSync(tenantMigDir)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("0001_"))
    .sort();

  let patchedCount = 0;
  for (const dbFile of sqliteFiles) {
    const db = new DatabaseSync(dbFile);
    try {
      const hasPages = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pages' LIMIT 1")
        .get();
      if (!hasPages) continue;

      for (const migFile of migFiles) {
        const sql = fs.readFileSync(path.join(tenantMigDir, migFile), "utf8");
        const stmts = splitMigrationStatements(sql);
        for (const stmt of stmts) {
          try {
            db.exec(stmt);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Additive idempotency for duplicate columns/indexes on re-run
            if (!/duplicate column name|already exists/i.test(msg)) {
              throw new Error(`Failed applying ${migFile} to ${dbFile}: ${msg}\nSQL: ${stmt}`, {
                cause: err,
              });
            }
          }
        }
      }
      patchedCount += 1;
    } finally {
      db.close();
    }
  }
  return patchedCount;
}

export function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        timeout: options.timeoutMs ?? 12_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyBuffer: buf,
            body: buf.toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`HTTP timeout on ${pathname}`)));
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function waitForBuiltWorker(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, "/api/health", {
        headers: { Host: "app.punyasitus.com" },
        timeoutMs: 3000,
      });
      if (res.status === 200) return;
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Built wrangler worker on port ${port} did not become ready within ${timeoutMs}ms`);
}

export async function startBuiltWranglerServer(persistDir, port) {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistDir,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WEB_DIR,
      env: cleanChildEnv({ CI: "true" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  child.stdout.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr.on("data", (d) => {
    logs += d.toString();
  });

  try {
    await waitForBuiltWorker(port);
  } catch (err) {
    child.kill("SIGTERM");
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n--- wrangler dev logs ---\n${logs.slice(-3000)}`,
      { cause: err },
    );
  }

  return {
    port,
    getLogs: () => logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export function extractCookieHeader(setCookieHeader) {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  return list
    .map((entry) => entry.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

export async function signUpAndProvisionTenant({
  port,
  sqlitePath,
  email,
  password,
  name,
  handle,
  businessName,
  activatePaid = true,
}) {
  const origin = `http://127.0.0.1:${port}`;
  const signUpRes = await httpRequest(port, "/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ email, password, name }),
  });
  assert(
    signUpRes.status === 200 || signUpRes.status === 201,
    `Sign-up failed for ${email}: status=${signUpRes.status} body=${signUpRes.body.slice(0, 300)}`,
  );

  let cookie = extractCookieHeader(signUpRes.headers["set-cookie"]);
  if (!cookie) {
    const signInRes = await httpRequest(port, "/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ email, password }),
    });
    assert(signInRes.status === 200, `Sign-in failed for ${email}: ${signInRes.status}`);
    cookie = extractCookieHeader(signInRes.headers["set-cookie"]);
  }
  assert(cookie.length > 0, `Expected session cookie for ${email}`);

  // Mark email verified in local PLATFORM_DB so onboarding provisioning succeeds cleanly
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare("UPDATE users SET email_verified = 1 WHERE lower(email) = ?").run(email.toLowerCase());
  } finally {
    db.close();
  }

  const provRes = await httpRequest(port, "/api/onboarding/provision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      handle,
      name: businessName,
      vertical: "compro",
    }),
  });
  assert(
    provRes.status === 201 || provRes.status === 200,
    `Provisioning failed for ${handle}: status=${provRes.status} body=${provRes.body.slice(0, 500)}`,
  );
  const provJson = JSON.parse(provRes.body);
  const tenantId = provJson?.tenant?.id ?? provJson?.data?.tenant?.id ?? provJson?.tenantId;
  assert(typeof tenantId === "string" && tenantId.length > 0, `Missing tenantId in provision response: ${provRes.body}`);

  if (activatePaid) {
    const db2 = new DatabaseSync(sqlitePath);
    try {
      const paidThrough = Date.now() + 30 * 24 * 60 * 60 * 1000;
      db2
        .prepare("UPDATE tenants SET status = 'active', operator_hold = 0, paid_through = ? WHERE id = ?")
        .run(paidThrough, tenantId);
    } finally {
      db2.close();
    }
  }

  return {
    email,
    cookie,
    handle,
    tenantId,
    host: `${handle}.situsku.click`,
  };
}

export async function createSeededM1Topology({ prefix = "m1-gate", withSecondTenant = true } = {}) {
  ensureWebDistBuilt(false);
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), `punyasitus-${prefix}-`));
  const sqlitePath = migrateLocalPlatformDb(persistDir);
  const port = await getFreePort();

  // Phase 1: Start built worker to provision Tenant A (and optionally Tenant B) via real APIs
  let server = await startBuiltWranglerServer(persistDir, port);
  let tenantA;
  let tenantB = null;
  try {
    tenantA = await signUpAndProvisionTenant({
      port,
      sqlitePath,
      email: `${prefix}-alpha@example.com`,
      password: "M1GateOwnerPassword!234",
      name: "Pemilik Alpha",
      handle: `${prefix}-alpha`,
      businessName: "PT Alpha Solusi Nusantara",
      activatePaid: true,
    });

    if (withSecondTenant) {
      tenantB = await signUpAndProvisionTenant({
        port,
        sqlitePath,
        email: `${prefix}-beta@example.com`,
        password: "M1GateOwnerPassword!234",
        name: "Pemilik Beta",
        handle: `${prefix}-beta`,
        businessName: "CV Beta Karya Mandiri",
        activatePaid: true,
      });
    }
  } catch (err) {
    await server.stop();
    fs.rmSync(persistDir, { recursive: true, force: true });
    throw err;
  }

  // Phase 2: Stop worker briefly, apply tenant migrations 0002..0021 to materialized DO SQLite files, restart
  await server.stop();
  const migratedDos = applyAllTenantMigrationsToLocalDos(persistDir);
  assert(
    migratedDos >= (withSecondTenant ? 2 : 1),
    `Expected at least ${withSecondTenant ? 2 : 1} TenantStore DO SQLite files, patched ${migratedDos}`,
  );
  server = await startBuiltWranglerServer(persistDir, port);

  // Phase 3: Seed published Homepage (with hero + contact form), Blog Article, and Service Offering for Tenant A
  const origin = `http://127.0.0.1:${port}`;
  const adminHeaders = (cookie) => ({
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: cookie,
  });

  // Update business profile + site settings so Floating WA & contact info render cleanly
  await httpRequest(port, `/api/tenants/${tenantA.handle}/identity/business-profile`, {
    method: "PATCH",
    headers: adminHeaders(tenantA.cookie),
    body: JSON.stringify({
      businessName: "PT Alpha Solusi Nusantara",
      businessCategory: "LocalBusiness",
      description: "Layanan audit digital, konsultasi infrastruktur bisnis, dan pendampingan UMKM Indonesia.",
      address: "Jl. Jenderal Sudirman Kav. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12190",
      phone: "6281234567890",
      whatsappE164: "6281234567890",
      email: "halo@alpha-solusi.id",
    }),
  });
  await httpRequest(port, `/api/tenants/${tenantA.handle}/identity/business-profile/publish`, {
    method: "POST",
    headers: adminHeaders(tenantA.cookie),
    body: JSON.stringify({}),
  });

  // 3a. Create & publish Homepage (includes hero, services highlight, and contact_form for no-JS test)
  const homeCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/pages`, {
    method: "POST",
    headers: adminHeaders(tenantA.cookie),
    body: JSON.stringify({
      title: "Beranda PT Alpha Solusi Nusantara",
      slug: "beranda",
      isHomepage: true,
      layoutMode: "standard",
      sections: [
        {
          id: "hero-m1",
          kind: "hero",
          heading: "Bangun Fondasi Digital Bisnis yang Andal dan Terukur",
          subheading:
            "Tim kami mendampingi audit operasional, tata kelola situs, dan strategi pertumbuhan UMKM Indonesia.",
          bodyHtml: null,
          ctaLabel: "Lihat Layanan",
          ctaHref: "/layanan/konsultasi-audit-digital",
        },
        {
          id: "contact-m1",
          kind: "contact",
          heading: "Hubungi Tim Konsultan Kami",
          subheading: "Kirim kebutuhan bisnis Anda melalui formulir berikut.",
          bodyHtml: null,
        },
      ],
    }),
  });
  assert(
    homeCreate.status === 201,
    `Create homepage failed: status=${homeCreate.status} body=${homeCreate.body.slice(0, 400)}`,
  );
  const homeJson = JSON.parse(homeCreate.body);
  const homePageId = homeJson.page?.id ?? homeJson.data?.id ?? homeJson.id;
  const homeVersion = homeJson.page?.version ?? homeJson.data?.version ?? homeJson.version ?? 1;

  const homePub = await httpRequest(
    port,
    `/api/tenants/${tenantA.handle}/pages/${homePageId}/publish`,
    {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({ expectedVersion: homeVersion }),
    },
  );
  assert(
    homePub.status === 200,
    `Publish homepage failed: status=${homePub.status} body=${homePub.body.slice(0, 400)}`,
  );

  // 3b. Create & publish Blog Article (including malicious XSS attempt to verify sanitization on real SSR!)
  const postCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/posts`, {
    method: "POST",
    headers: adminHeaders(tenantA.cookie),
    body: JSON.stringify({
      title: "Panduan Audit Energi dan Operasional Gedung Kantor",
      slug: "panduan-audit-energi-gedung",
      excerpt: "Langkah terukur mengevaluasi efisiensi energi dan kesiapan operasional ruang kerja bisnis.",
      authorName: "Raka Pratama",
      showToc: true,
      bodyHtml: [
        "<h2>1. Pemetaan Beban Listrik Harian</h2>",
        "<p>Audit energi dimulai dengan pengukuran beban puncak perangkat pendingin dan pencahayaan ruang kerja.</p>",
        '<script>window.__m1XssExecuted = "script";</script>',
        '<p><img src="javascript:alert(1)" onerror="window.__m1XssExecuted=\'img\'" alt="Ilustrasi" />',
        '<a href="javascript:window.__m1XssExecuted=\'jsurl\'" onclick="window.__m1XssExecuted=\'onclick\'">Tautan Uji Keamanan</a></p>',
        "<h2>2. Rekomendasi Penghematan Terukur</h2>",
        "<p>Pengaturan jadwal perawatan berkala membantu menekan biaya operasional tahunan tanpa mengganggu produktivitas tim.</p>",
      ].join(""),
    }),
  });
  assert(
    postCreate.status === 201,
    `Create blog post failed: status=${postCreate.status} body=${postCreate.body.slice(0, 400)}`,
  );
  const postJson = JSON.parse(postCreate.body);
  const postId = postJson.post?.id ?? postJson.data?.id ?? postJson.id;
  const postVersion = postJson.post?.version ?? postJson.data?.version ?? postJson.version ?? 1;

  const postPub = await httpRequest(
    port,
    `/api/tenants/${tenantA.handle}/posts/${postId}/publish`,
    {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({ expectedVersion: postVersion }),
    },
  );
  assert(
    postPub.status === 200,
    `Publish blog post failed: status=${postPub.status} body=${postPub.body.slice(0, 400)}`,
  );

  // 3c. Create & publish Service Offering
  const offeringCreate = await httpRequest(port, `/api/tenants/${tenantA.handle}/catalog`, {
    method: "POST",
    headers: adminHeaders(tenantA.cookie),
    body: JSON.stringify({
      offeringType: "service",
      title: "Konsultasi Audit Digital & Kinerja Situs",
      slug: "konsultasi-audit-digital",
      summary: "Evaluasi teknis menyeluruh untuk mempercepat situs bisnis dan merapikan struktur SEO.",
      description:
        "<p>Layanan mencakup pemeriksaan struktur konten, kecepatan muat seluler, serta rekomendasi arsitektur halaman.</p><ul><li>Laporan audit terstruktur</li><li>Sesi diskusi bersama tim teknis</li></ul>",
      priceMode: "fixed",
      price: 4500000,
      ctaMode: "whatsapp",
    }),
  });
  assert(
    offeringCreate.status === 201,
    `Create offering failed: status=${offeringCreate.status} body=${offeringCreate.body.slice(0, 400)}`,
  );
  const offeringJson = JSON.parse(offeringCreate.body);
  const offeringId = offeringJson.offering?.id ?? offeringJson.data?.id ?? offeringJson.id;
  const offeringVersion =
    offeringJson.offering?.version ?? offeringJson.data?.version ?? offeringJson.version ?? 1;

  const offeringPub = await httpRequest(
    port,
    `/api/tenants/${tenantA.handle}/catalog/${offeringId}/publish`,
    {
      method: "POST",
      headers: adminHeaders(tenantA.cookie),
      body: JSON.stringify({ expectedVersion: offeringVersion }),
    },
  );
  assert(
    offeringPub.status === 200,
    `Publish offering failed: status=${offeringPub.status} body=${offeringPub.body.slice(0, 400)}`,
  );

  return {
    port,
    persistDir,
    sqlitePath,
    server,
    tenantA,
    tenantB,
    seeded: {
      homePageId,
      postId,
      offeringId,
      articlePath: "/blog/panduan-audit-energi-gedung",
      offeringPath: "/layanan/konsultasi-audit-digital",
    },
    async cleanup() {
      await server.stop();
      fs.rmSync(persistDir, { recursive: true, force: true });
    },
  };
}

export async function launchM1Chromium() {
  const executablePath = findChromeExecutable();
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--host-resolver-rules=MAP *.situsku.click 127.0.0.1, MAP punyasitus.com 127.0.0.1, MAP *.punyasitus.com 127.0.0.1",
    ],
  });
}
