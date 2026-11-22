import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");

function seedLocalPlatformDb(persistToDir) {
  const migrate = spawnSync(
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
      persistToDir,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    throw new Error(`D1 migrate failed for ${persistToDir}:\n${migrate.stdout}\n${migrate.stderr}`);
  }

  const now = Date.now();
  const seedSql = [
    `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org_probe_alpha', 'Alpha Studio', 'alpha-studio', ${now}, ${now});`,
    `INSERT OR REPLACE INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, cache_version, schema_version, version, created_at, updated_at) VALUES ('01JFX00000000000000000000A', 'org_probe_alpha', 'alpha-studio', 'Alpha Studio', 'compro', 'active', 0, 1, 1, 1, ${now}, ${now});`,
    `INSERT OR REPLACE INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at) VALUES ('alpha-studio.situsku.click', '01JFX00000000000000000000A', 'subdomain', 'active', 'active', 1, ${now}, 1, ${now}, ${now});`,
  ].join(" ");

  const seed = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "punyasitus-platform",
      "--local",
      "--persist-to",
      persistToDir,
      "--command",
      seedSql,
    ],
    { cwd: webDir, env: cleanChildEnv(), encoding: "utf8" },
  );
  if (seed.status !== 0) {
    throw new Error(`D1 seed failed for ${persistToDir}:\n${seed.stdout}\n${seed.stderr}`);
  }
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

function httpGet(port, pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: { Host: hostHeader },
        timeout: 4000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("HTTP request timed out")));
    req.on("error", reject);
    req.end();
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

async function waitForServer(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, "/", "punyasitus.com");
      if (res.status > 0) return;
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`);
}

async function verifySurfaces(port, label) {
  const cases = [
    { host: "punyasitus.com", expectedStatus: 200, expectedSurface: "marketing" },
    { host: "app.punyasitus.com", expectedStatus: 200, expectedSurface: "app" },
    { host: "console.punyasitus.com", expectedStatus: 200, expectedSurface: "console" },
    { host: "alpha-studio.situsku.click", expectedStatus: 200, expectedSurface: "tenant" },
    { host: "unknown.example.invalid", expectedStatus: 404, expectedSurface: "unknown" },
  ];

  const t0 = performance.now();
  for (const c of cases) {
    const res = await httpGet(port, "/", c.host);
    const surface = res.headers["x-punyasitus-surface"];
    if (res.status !== c.expectedStatus || surface !== c.expectedSurface) {
      throw new Error(
        `[${label}] Host=${c.host}: expected status=${c.expectedStatus}, surface=${c.expectedSurface}; got status=${res.status}, surface=${String(surface)}, body=${res.body.slice(0, 200)}`,
      );
    }
  }
  const elapsedMs = Math.round(performance.now() - t0);
  console.log(`[${label}] PASS: all 5 surface/404 host probes succeeded in ${elapsedMs}ms (port ${port})`);
}

async function runWithServer(label, command, args, envExtra = {}) {
  const port = await getFreePort();
  const renderedArgs = args.map((a) => a.replace("__PORT__", String(port)));
  const child = spawn(command, renderedArgs, {
    cwd: webDir,
    env: cleanChildEnv(envExtra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr.on("data", (d) => {
    logs += d.toString();
  });

  try {
    await waitForServer(port);
    await verifySurfaces(port, label);
  } catch (err) {
    console.error(`[${label}] Logs:\n${logs.slice(-2500)}`);
    throw err;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-wrangler-probe-"));
try {
  // Migrate & seed local D1 so authoritative TASK-002 host routing resolves the synthetic tenant
  seedLocalPlatformDb(path.join(webDir, ".wrangler/state"));
  seedLocalPlatformDb(persistDir);

  // 1. Probe `astro dev` running in workerd (ephemeral port, lock-free)
  await runWithServer(
    "astro dev",
    "pnpm",
    [
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "__PORT__",
      "--ignore-lock",
    ],
    { PUNYASITUS_ALLOW_DEV_HOSTS: "1" },
  );

  // 2. Probe built Worker under `wrangler dev --local` with isolated persist state
  await runWithServer("wrangler dev", "pnpm", [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "__PORT__",
    "--persist-to",
    persistDir,
    "--show-interactive-dev-session=false",
  ]);
} finally {
  fs.rmSync(persistDir, { recursive: true, force: true });
}
