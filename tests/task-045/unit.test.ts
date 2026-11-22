import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const VERIFY_SCRIPT = path.join(ROOT, "scripts/verify/routes.mjs");

function runRoutesCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [VERIFY_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runRoutesCliAsync(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFY_SCRIPT, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("TASK-045 unit checks — Cloudflare for SaaS topology, wrangler config, hosting runbook, routes.mjs", () => {
  it("passes `scripts/verify/routes.mjs --check-config` against repository files", () => {
    const res = runRoutesCli(["--check-config"]);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ok: boolean;
      config: { ok: boolean; checksPassed: number; errors: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.config.ok).toBe(true);
    expect(parsed.config.checksPassed).toBeGreaterThanOrEqual(15);
    expect(parsed.config.errors).toEqual([]);
  });

  it("declares separate staging SaaS zone, REQ-095 settings, O2O route, and non-Enterprise bounds in topology.json", () => {
    const topology = JSON.parse(
      fs.readFileSync(path.join(ROOT, "infra/cloudflare/topology.json"), "utf8"),
    ) as {
      worker: { workers_dev: boolean; preview_urls: boolean };
      enterpriseOnlyFeatures: {
        wildcard_custom_hostnames: boolean;
        custom_metadata: boolean;
        apex_proxying: boolean;
      };
      environments: {
        production: {
          saasZone: {
            zone: string;
            fallbackOrigin: string;
            cnameTarget: string;
            workerRoutes: { pattern: string; worker: string }[];
            zoneSettings: { markdown_for_agents: boolean; bot_fight_mode: boolean };
          };
        };
        staging: {
          saasZone: {
            zone: string;
            fallbackOrigin: string;
            cnameTarget: string;
            workerRoutes: { pattern: string; worker: string }[];
            zoneSettings: { markdown_for_agents: boolean; bot_fight_mode: boolean };
          };
        };
      };
    };

    expect(topology.worker.workers_dev).toBe(false);
    expect(topology.worker.preview_urls).toBe(false);
    expect(topology.enterpriseOnlyFeatures).toEqual({
      wildcard_custom_hostnames: false,
      custom_metadata: false,
      apex_proxying: false,
    });

    const prodSaas = topology.environments.production.saasZone;
    const stgSaas = topology.environments.staging.saasZone;

    expect(prodSaas.zone).toBe("situsku.click");
    expect(stgSaas.zone).not.toBe(prodSaas.zone);
    expect(stgSaas.fallbackOrigin).not.toBe(prodSaas.fallbackOrigin);
    expect(stgSaas.cnameTarget).not.toBe(prodSaas.cnameTarget);

    for (const saas of [prodSaas, stgSaas]) {
      expect(saas.zoneSettings.markdown_for_agents).toBe(true);
      expect(saas.zoneSettings.bot_fight_mode).toBe(false);
      expect(saas.workerRoutes.some((r) => r.pattern === "*/*")).toBe(true);
      expect(saas.workerRoutes.some((r) => r.pattern === `${saas.cnameTarget}/*`)).toBe(true);
    }
  });

  it("keeps workers_dev=false, preview_urls=false, and all v1 bindings intact in apps/web/wrangler.jsonc", () => {
    const raw = fs.readFileSync(path.join(ROOT, "apps/web/wrangler.jsonc"), "utf8");
    expect(raw).toContain('"workers_dev": false');
    expect(raw).toContain('"preview_urls": false');
    for (const token of [
      '"PLATFORM_DB"',
      '"TENANT_STORE"',
      '"MEDIA_BUCKET"',
      '"BACKUP_BUCKET"',
      '"IMAGES"',
      '"JOBS_QUEUE"',
      '"AI"',
      '"EMAIL"',
      '"7 * * * *"',
    ]) {
      expect(raw).toContain(token);
    }
  });

  it("documents DCV, O2O, staging isolation, Trust+ check, Turnstile secret naming, and staging probe in docs/operations/hosting.md", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/operations/hosting.md"), "utf8");
    for (const phrase of [
      "/.well-known/pki-validation/*",
      "/.well-known/acme-challenge/*",
      "/.well-known/cf-custom-hostname-challenge/*",
      "cf-connecting-o2o: 1",
      "CF-Connecting-IP",
      "fallback_origin",
      "Markdown for Agents",
      "Free Bot Fight Mode",
      "Trust+",
      "TURNSTILE_SITE_KEY",
      "TURNSTILE_SECRET_KEY",
      "scripts/verify/routes.mjs",
    ]) {
      expect(doc).toContain(phrase);
    }
  });

  it("fails `--check-config` when staging shares production SaaS zone, Bot Fight Mode is enabled, or a raw Turnstile key leaks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-t045-neg-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "apps/web"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "infra/cloudflare"), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, "apps/web/wrangler.jsonc"),
        path.join(tmpDir, "apps/web/wrangler.jsonc"),
      );

      const broken = JSON.parse(
        fs.readFileSync(path.join(ROOT, "infra/cloudflare/topology.json"), "utf8"),
      ) as Record<string, unknown>;
      const envs = broken.environments as {
        staging: {
          saasZone: {
            zone: string;
            fallbackOrigin: string;
            zoneSettings: { bot_fight_mode: boolean };
          };
          secretsAndVars: { turnstile: { publicFormsSiteKeyVar: string } };
        };
      };
      envs.staging.saasZone.zone = "situsku.click";
      envs.staging.saasZone.fallbackOrigin = "fallback.situsku.click";
      envs.staging.saasZone.zoneSettings.bot_fight_mode = true;
      envs.staging.secretsAndVars.turnstile.publicFormsSiteKeyVar = "0x4AAAAAAFakeLeakedKeyValue1234";

      fs.writeFileSync(
        path.join(tmpDir, "infra/cloudflare/topology.json"),
        JSON.stringify(broken, null, 2),
      );

      const res = runRoutesCli(["--check-config", "--root", tmpDir]);
      expect(res.status).toBe(1);
      const parsed = JSON.parse(res.stderr) as {
        ok: boolean;
        config: { errors: string[] };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.config.errors.some((e) => e.includes("staging_separate_saas_zone"))).toBe(true);
      expect(parsed.config.errors.some((e) => e.includes("req095_ai_crawler_policy"))).toBe(true);
      expect(parsed.config.errors.some((e) => e.includes("zero_raw_secrets"))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports `--target` staging probe mode cleanly against an authorized local mock server", async () => {
    const server = http.createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      if (pathname === "/dashboard/probe") {
        res.writeHead(404, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "X-PunyaSitus-Surface": "unknown",
        });
        res.end("<h1>Halaman tidak ditemukan</h1>");
        return;
      }
      if (pathname === "/layanan") {
        res.writeHead(301, {
          Location: "https://www.staging-canary.example/layanan?utm_source=route-probe",
          "Cache-Control": "no-store",
          "X-PunyaSitus-Surface": "tenant",
        });
        res.end();
        return;
      }
      if (pathname === "/api/events") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, code: "METHOD_NOT_ALLOWED" }));
        return;
      }
      if (pathname === "/api/health") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-PunyaSitus-Surface": "app",
        });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-PunyaSitus-Surface": "tenant",
      });
      res.end("<html><body>canary-ok</body></html>");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Expected numeric TCP port");
      }
      const base = `http://127.0.0.1:${addr.port}`;
      const res = await runRoutesCliAsync([
        "--target",
        base,
        "--custom-host",
        base,
        "--platform-app",
        base,
        "--expected-primary",
        "www.staging-canary.example",
        "--alias-host",
        `http://localhost:${addr.port}`,
      ]);
      expect(res.status, res.stderr).toBe(0);
      const parsed = JSON.parse(res.stdout) as {
        ok: boolean;
        stagingProbe: { ok: boolean; probes: { name: string; status: number }[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.stagingProbe.ok).toBe(true);
      expect(parsed.stagingProbe.probes.some((p) => p.name === "primary_redirect_301" && p.status === 301)).toBe(true);
      expect(parsed.stagingProbe.probes.some((p) => p.name === "target_host_isolation" && p.status === 404)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
