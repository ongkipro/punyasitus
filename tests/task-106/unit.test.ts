import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { splitMigrationStatements } from "@punyasitus/db/connections";
import {
  DEFAULT_STATUS_PAGE_URL,
  PLATFORM_0007_INCIDENTS_SQL,
  PlatformIncidentError,
  sanitizeIncidentText,
  toPublicIncidentBannerItem,
  validateDeclareIncidentPayload,
  validateResolveIncidentPayload,
  validateUpdateIncidentPayload,
} from "@punyasitus/db/incidents/index";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("TASK-106 unit checks — Status page independence, release runbook, CI dry-run & incident validators", () => {
  it("keeps bundled migration 0007 SQL byte-for-byte identical to disk with append-only timeline triggers", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0007_platform_incidents.sql"),
      "utf8",
    );
    expect(PLATFORM_0007_INCIDENTS_SQL).toBe(sqlOnDisk);

    const stmts = splitMigrationStatements(PLATFORM_0007_INCIDENTS_SQL);
    expect(stmts.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS platform_incidents"))).toBe(
      true,
    );
    expect(
      stmts.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS platform_incident_updates")),
    ).toBe(true);
    expect(
      stmts.some((s) =>
        s.startsWith("CREATE TRIGGER IF NOT EXISTS platform_incident_updates_no_update"),
      ),
    ).toBe(true);
    expect(
      stmts.some((s) =>
        s.startsWith("CREATE TRIGGER IF NOT EXISTS platform_incident_updates_no_delete"),
      ),
    ).toBe(true);
  });

  it("proves apps/status builds independently with zero Worker bindings and zero imports from apps/web", () => {
    const statusDir = path.join(ROOT, "apps/status");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(statusDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();

    const wranglerRaw = fs.readFileSync(path.join(statusDir, "wrangler.jsonc"), "utf8");
    const wranglerCfg = JSON.parse(stripJsonComments(wranglerRaw)) as Record<string, unknown>;
    expect(wranglerCfg.pages_build_output_dir).toBe("./dist");
    expect(wranglerCfg.main).toBeUndefined();
    expect(wranglerCfg.d1_databases).toBeUndefined();
    expect(wranglerCfg.durable_objects).toBeUndefined();
    expect(wranglerCfg.r2_buckets).toBeUndefined();
    expect(wranglerCfg.queues).toBeUndefined();
    expect(wranglerCfg.services).toBeUndefined();
    expect(wranglerCfg.ai).toBeUndefined();
    expect(wranglerCfg.send_email).toBeUndefined();
    expect(wranglerCfg.kv_namespaces).toBeUndefined();

    for (const file of walkFiles(statusDir)) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/apps\/web|@punyasitus\/web|@punyasitus\/db|@punyasitus\/auth/);
    }

    const buildRes = spawnSync("node", ["scripts/build.mjs"], {
      cwd: statusDir,
      encoding: "utf8",
    });
    expect(buildRes.status).toBe(0);

    const distHtmlPath = path.join(statusDir, "dist/index.html");
    const distJsonPath = path.join(statusDir, "dist/status.json");
    expect(fs.existsSync(distHtmlPath)).toBe(true);
    expect(fs.existsSync(distJsonPath)).toBe(true);

    const html = fs.readFileSync(distHtmlPath, "utf8");
    for (const componentLabel of [
      "Situs Publik",
      "Dashboard &amp; CMS",
      "Domain &amp; SSL",
      "Pembayaran &amp; Perpanjangan",
      "Notifikasi Email",
    ]) {
      expect(html).toContain(componentLabel);
    }
    expect(html).toContain('lang="id"');
    expect(html).toContain("status.punyasitus.com");
  });

  it("verifies docs/operations/release.md documents Cloudflare gradual deployments, TenantStore wrangler deploy rule, and rollback", () => {
    const runbook = fs.readFileSync(
      path.join(ROOT, "docs/operations/release.md"),
      "utf8",
    );
    expect(runbook).toContain("wrangler versions upload");
    expect(runbook).toContain("wrangler versions deploy");
    expect(runbook).toContain("@10%");
    expect(runbook).toContain("@50%");
    expect(runbook).toContain("@100%");
    expect(runbook).toContain("TenantStore");
    expect(runbook).toContain("wrangler deploy");
    expect(runbook).toContain("migration_bookmarks");
    expect(runbook).toContain("restore(bookmark)");
    expect(runbook).toContain("replayDeletionTombstones");
    expect(runbook).toContain("apps/status");
  });

  it("verifies .github/workflows/staged-release-dry-run.yml uses SHA-pinned actions, least privilege, and dry-run upload without deploying", () => {
    const wf = fs.readFileSync(
      path.join(ROOT, ".github/workflows/staged-release-dry-run.yml"),
      "utf8",
    );
    expect(wf).toContain("permissions: {}");
    expect(wf).toContain("contents: read");
    expect(wf).toContain("persist-credentials: false");
    expect(wf).toContain("node apps/status/scripts/build.mjs");
    expect(wf).toContain("wrangler versions upload");
    expect(wf).toContain("--dry-run");
    expect(wf).not.toMatch(/wrangler\s+versions\s+deploy/);
    expect(wf).not.toMatch(/wrangler\s+deploy(?:\s|$)/);

    const usesLines = wf.match(/uses:\s+[^\n]+/g) ?? [];
    expect(usesLines.length).toBeGreaterThanOrEqual(3);
    for (const line of usesLines) {
      expect(line).toMatch(/@[0-9a-f]{40}/);
    }

    // B2 guard: zero request-time DDL in apps/web console incident routes
    for (const rel of [
      "apps/web/src/pages/api/console/incidents/index.ts",
      "apps/web/src/pages/api/console/incidents/[incidentId].ts",
      "apps/web/src/pages/api/console/incidents/[incidentId]/resolve.ts",
      "apps/web/src/pages/console/incidents/index.astro",
      "apps/web/src/pages/console/incidents/banner-preview.astro",
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toContain("ensurePlatformIncidentsSchema");
    }
  });

  it("validates incident payloads strictly, scrubs embedded secrets/PII, and projects sanitized banner DTOs", () => {
    const declared = validateDeclareIncidentPayload({
      title: "Gangguan pembayaran QRIS sementara",
      severity: "major",
      affectedComponents: ["billing_payments", "dashboard_cms"],
      summary:
        "Sebagian transaksi QRIS mengalami keterlambatan rekonsiliasi. Bearer supersecrettoken12345, re_secretkey123456, dan email ops@punyasitus.com harus disensor.",
    });

    expect(declared.status).toBe("investigating");
    expect(declared.bannerVisible).toBe(true);
    expect(declared.affectedComponents).toEqual(["billing_payments", "dashboard_cms"]);
    expect(declared.summary).toContain("rekonsiliasi");
    expect(declared.summary).not.toContain("supersecrettoken12345");
    expect(declared.summary).not.toContain("re_secretkey123456");
    expect(declared.summary).not.toContain("ops@punyasitus.com");

    expect(() =>
      validateDeclareIncidentPayload({
        title: "Ok",
        severity: "invalid",
        affectedComponents: [],
        summary: "pendek",
      }),
    ).toThrow(PlatformIncidentError);

    expect(() =>
      validateDeclareIncidentPayload({
        title: "Judul valid minimal",
        severity: "minor",
        affectedComponents: ["public_sites"],
        summary: "Ringkasan valid minimal sepuluh karakter.",
        extraHackerField: true,
      }),
    ).toThrow(/UNKNOWN_FIELD|Field tidak dikenal/);

    const upd = validateUpdateIncidentPayload({
      expectedVersion: 1,
      status: "monitoring",
      updateMessage: "Perbaikan gateway selesai diterapkan, sedang dipantau.",
    });
    expect(upd.expectedVersion).toBe(1);
    expect(upd.status).toBe("monitoring");

    expect(() =>
      validateUpdateIncidentPayload({
        expectedVersion: 0,
        status: "monitoring",
      }),
    ).toThrow(PlatformIncidentError);

    const resolved = validateResolveIncidentPayload({
      expectedVersion: 2,
    });
    expect(resolved.expectedVersion).toBe(2);
    expect(resolved.resolutionNote.length).toBeGreaterThanOrEqual(10);

    expect(sanitizeIncidentText("Line1\r\nLine2\tsecret=abc123456789", 200)).not.toContain(
      "abc123456789",
    );

    const bannerDto = toPublicIncidentBannerItem({
      id: "inc_01TESTINCIDENT0000000001",
      title: declared.title,
      summary: declared.summary,
      severity: "major",
      status: "investigating",
      affectedComponents: ["billing_payments"],
      bannerVisible: true,
      declaredAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    expect(bannerDto).not.toBeNull();
    expect(bannerDto?.statusPageUrl).toBe(DEFAULT_STATUS_PAGE_URL);
    expect("declaredByUserId" in (bannerDto ?? {})).toBe(false);

    const hiddenResolved = toPublicIncidentBannerItem({
      id: "inc_01TESTINCIDENT0000000001",
      title: declared.title,
      summary: declared.summary,
      severity: "major",
      status: "resolved",
      affectedComponents: ["billing_payments"],
      bannerVisible: false,
      declaredAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    expect(hiddenResolved).toBeNull();
  });
});
