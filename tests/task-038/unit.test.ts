import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runBackupRestoreDrill,
  verifyRollbackPlan,
} from "../../scripts/verify/backup-restore-drill.mjs";
import {
  EXPECTED_OFFICIAL_PLUGIN_IDS,
  FULL_RELEASE_TASK_IDS,
  RELEASE_EXTERNAL_GATES,
  runReleaseGate,
  verifyFullSqlMigrations,
  verifyOfficialPlugins,
  verifyReleaseManifest,
  verifySecurityAssuranceArtifacts,
  verifyWorkflowHardening,
} from "../../scripts/verify/release-gate.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-038 Full Production Release Gate (M1 + M2) — Unit & Contract Invariants", () => {
  it("passes the full 109-task M1 + M2 static & contract release gate against the repository", () => {
    const report = runReleaseGate(REPO_ROOT);

    expect(report.ok, JSON.stringify(report.checks, null, 2)).toBe(true);
    expect(report.task).toBe("TASK-038");
    expect(report.requirement).toBe("REQ-041");
    expect(report.checks.taskCoverage.ok).toBe(true);
    expect(report.checks.taskCoverage.totalReleaseTasks).toBe(109);
    expect(report.checks.taskCoverage.m1Count).toBe(85);
    expect(report.checks.taskCoverage.m2Wave7Count).toBe(22);
    expect(report.checks.taskCoverage.m2Wave8Count).toBe(2);
    expect(report.checks.taskCoverage.deferredRelease11Ids).toEqual(["TASK-062"]);
    expect(report.checks.taskCoverage.verifiedTaskDirsCount).toBe(109);

    expect(report.checks.migrations.ok).toBe(true);
    expect(report.checks.migrations.platform.maxVersion).toBeGreaterThanOrEqual(33);
    expect(report.checks.migrations.tenant.maxVersion).toBeGreaterThanOrEqual(24);

    expect(report.checks.officialPlugins.ok).toBe(true);
    expect(report.checks.officialPlugins.registeredCount).toBe(5);
    expect(report.checks.officialPlugins.registeredPluginIds).toEqual([
      ...EXPECTED_OFFICIAL_PLUGIN_IDS,
    ]);
    expect(report.checks.officialPlugins.defaultActivePluginIds).toEqual(["seo-ai-autopilot"]);

    expect(report.checks.workflows.ok).toBe(true);
    expect(report.checks.workflows.workflowFiles).toContain("release-gate.yml");
    expect(report.checks.workflows.jobsChecked).toBeGreaterThanOrEqual(6);

    expect(report.checks.wrangler.ok).toBe(true);
    expect(report.checks.wrangler.workersDev).toBe(false);
    expect(report.checks.wrangler.previewUrls).toBe(false);

    expect(report.checks.uiProhibitions.ok).toBe(true);
    expect(report.checks.releaseManifest.ok).toBe(true);
    expect(report.checks.securityAssurance.ok).toBe(true);
    expect(report.checks.securityAssurance.independentReviewApproved).toBe(true);

    expect(RELEASE_EXTERNAL_GATES).toHaveLength(10);
    expect(RELEASE_EXTERNAL_GATES.every((g) => g.status.startsWith("UNVERIFIED"))).toBe(true);
    expect(FULL_RELEASE_TASK_IDS).toHaveLength(109);
    expect(FULL_RELEASE_TASK_IDS).not.toContain("TASK-062");
  });

  it("validates RELEASE.md against release-manifest and rollback-check CLI parsers (M1 and M3)", () => {
    const manifestCli = spawnSync("release-manifest", ["--json", REPO_ROOT], {
      encoding: "utf8",
    });
    if (manifestCli.error && (manifestCli.error as NodeJS.ErrnoException).code === "ENOENT") {
      // Fallback when running on a CI runner without local ~/.local/bin/release-manifest
      const check = verifyReleaseManifest(REPO_ROOT);
      expect(check.ok).toBe(true);
    } else {
      expect(manifestCli.status, manifestCli.stdout + manifestCli.stderr).toBe(0);
      const parsed = JSON.parse(manifestCli.stdout) as {
        status: string;
        fields: Record<string, string>;
        errors: string[];
      };
      expect(parsed.status).toBe("VALID");
      expect(parsed.errors).toEqual([]);
      expect(parsed.fields["Release-ID"]).toBe("punyasitus-v1.0.0-rc1");
      expect(parsed.fields.Environment).toBe("production");
      expect(parsed.fields["Declared-Risk"]).toBe("R3");
      expect(parsed.fields.Status).toBe("READY");
    }

    for (const migRisk of ["M1", "M3"] as const) {
      const rbCli = spawnSync("rollback-check", ["--json", "--migration-risk", migRisk, REPO_ROOT], {
        encoding: "utf8",
      });
      if (rbCli.error && (rbCli.error as NodeJS.ErrnoException).code === "ENOENT") {
        const check = verifyReleaseManifest(REPO_ROOT);
        expect(check.ok).toBe(true);
      } else {
        expect(rbCli.status, rbCli.stdout + rbCli.stderr).toBe(0);
        const parsed = JSON.parse(rbCli.stdout) as { status: string; errors: string[] };
        expect(parsed.status).toBe("PASS");
        expect(parsed.errors).toEqual([]);
      }
    }
  });

  it("verifies .github/workflows/release-gate.yml & ci.yml set fetch-depth: 0, 40-char SHAs, minimal permissions, 3-browser matrix & zero secrets/live deploys", () => {
    const wfPath = path.join(REPO_ROOT, ".github/workflows/release-gate.yml");
    expect(fs.existsSync(wfPath)).toBe(true);
    const yaml = fs.readFileSync(wfPath, "utf8");

    expect(yaml).toContain("permissions: {}");
    expect(yaml).toContain("contents: read");
    expect(yaml).toContain("fetch-depth: 0");
    expect(yaml).toContain("persist-credentials: false");
    expect(yaml).toContain("timeout-minutes: 30");
    expect(yaml).toContain("playwright-core install --with-deps chromium firefox webkit");
    expect(yaml).toContain("node scripts/verify/release-gate.mjs");
    expect(yaml).toContain("node scripts/verify/backup-restore-drill.mjs --verify-rollback-plan");
    expect(yaml).toContain("node tests/performance/release-lab.mjs --allow-tracked-cls-deviation=M1-FU-08");
    expect(yaml).toContain("node tests/e2e-gate/release-gate.mjs --browsers=chromium,firefox,webkit");
    expect(yaml).toContain("node tests/task-038/e2e.mjs --verify-existing-reports");
    expect(yaml).not.toMatch(/\$\{\{\s*secrets\./);
    expect(yaml).not.toMatch(/\bwrangler\s+deploy\b(?!.*--dry-run)/);

    // ci.yml verify job must also set fetch-depth: 0 so Base git ancestry checks succeed in CI
    const ciYaml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ciYaml).toMatch(/verify:[\s\S]*?fetch-depth:\s*0[\s\S]*?persist-credentials:\s*false/);

    const wfHardening = verifyWorkflowHardening(REPO_ROOT);
    expect(wfHardening.ok, wfHardening.errors.join("\n")).toBe(true);
  });

  it("executes isolated backup/restore + DEC-022 tombstone replay drill and rejects tampered platform, tenant, or manifest checksums", () => {
    const planCheck = verifyRollbackPlan(REPO_ROOT);
    expect(planCheck.ok, planCheck.errors.join("\n")).toBe(true);
    expect(planCheck.mode).toBe("verify-rollback-plan");
    expect(planCheck.nonDestructive).toBe(true);
    expect(planCheck.drill.ok).toBe(true);
    expect(planCheck.drill.withinRtoBudget).toBe(true);
    expect(planCheck.drill.checksums.activeTenantChecksumMatched).toBe(true);
    expect(planCheck.drill.checksums.activeMediaShaMatched).toBe(true);
    expect(planCheck.drill.platformRestore.activeBookmarkVerified).toBe(true);
    expect(planCheck.drill.tombstoneReplayVerification.wouldHaveResurrectedWithoutReplay).toBe(true);
    expect(planCheck.drill.tombstoneReplayVerification.resurrectionPrevented).toBe(true);
    expect(planCheck.drill.tombstoneReplayVerification.statusAfterReplay).toBe("purged");
    expect(planCheck.drill.tombstoneReplayVerification.activeHostsAfterReplay).toBe(0);
    expect(planCheck.drill.tombstoneReplayVerification.r2ObjectsRemaining).toBe(0);
    expect(planCheck.drill.tombstoneReplayVerification.tenantStoreRemoved).toBe(true);

    // Negative tests: tampered platform SQL, tenant SQL, and archive manifest MUST fail closed
    expect(() =>
      runBackupRestoreDrill({ rootDir: REPO_ROOT, simulateTamperedChecksum: true }),
    ).toThrow(/BACKUP_CHECKSUM_MISMATCH/);
    expect(() =>
      runBackupRestoreDrill({ rootDir: REPO_ROOT, simulateTamperedTenantSnapshot: true }),
    ).toThrow(/TENANT_SNAPSHOT_CHECKSUM_MISMATCH/);
    expect(() =>
      runBackupRestoreDrill({ rootDir: REPO_ROOT, simulateTamperedManifest: true }),
    ).toThrow(/BACKUP_MANIFEST_CHECKSUM_MISMATCH/);
  });

  it("rejects destructive DDL (TRUNCATE/DROP), missing job timeout-minutes, dynamic plugin loading, bad RELEASE.md & unapproved security docs", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t038-unit-neg-"));
    try {
      // 1. Destructive TRUNCATE migration
      fs.mkdirSync(path.join(tmpRoot, "packages/db/migrations/platform"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "packages/db/migrations/tenant"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "packages/db/migrations/platform/0001_bad.sql"),
        "CREATE TABLE t (id TEXT PRIMARY KEY);\nTRUNCATE TABLE t;",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "packages/db/migrations/tenant/0001_ok.sql"),
        "CREATE TABLE t (id INTEGER PRIMARY KEY);",
      );
      const migRes = verifyFullSqlMigrations(tmpRoot);
      expect(migRes.ok).toBe(false);
      expect(migRes.errors.some((e) => e.includes("Destructive DDL"))).toBe(true);

      // 2. Dynamic import + wrong default-active plugin list
      fs.mkdirSync(path.join(tmpRoot, "apps/web/src/core"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "apps/web/src/core/plugin-registry.ts"),
        [
          "export const REGISTERED_FIRST_PARTY_PLUGINS = [SEO_AI_AUTOPILOT_PLUGIN];",
          'export const DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS = ["seo-ai-autopilot", "bio-links"];',
          'export const load = (p: string) => import(p);',
        ].join("\n"),
      );
      const plugRes = verifyOfficialPlugins(tmpRoot);
      expect(plugRes.ok).toBe(false);
      expect(plugRes.errors.some((e) => e.includes("forbidden dynamic code loading"))).toBe(true);
      expect(plugRes.errors.some((e) => e.includes("ONLY seo-ai-autopilot"))).toBe(true);

      // 3. Workflow missing timeout-minutes
      fs.mkdirSync(path.join(tmpRoot, ".github/workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, ".github/workflows/ci.yml"),
        [
          "name: NoTimeout",
          "on: [push]",
          "permissions: {}",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      contents: read",
          "    steps:",
          "      - run: echo ok",
        ].join("\n"),
      );
      const wfRes = verifyWorkflowHardening(tmpRoot);
      expect(wfRes.ok).toBe(false);
      expect(wfRes.errors.some((e) => e.includes("must declare timeout-minutes"))).toBe(true);

      // 4. Draft RELEASE.md missing rollback plan + dash-prefixed git ref injection guard
      fs.writeFileSync(
        path.join(tmpRoot, "RELEASE.md"),
        "Release-ID: UNSET\nBase: --version\nEnvironment: staging\nDeclared-Risk: R0\nRollback-Ref: -evil\nRollback-Command: true\nBackup-Proof: NOT_REQUIRED\nStatus: DRAFT\n",
      );
      const relRes = verifyReleaseManifest(tmpRoot, { checkGitAncestry: false });
      expect(relRes.ok).toBe(false);
      expect(relRes.errors.some((e) => e.includes("First-Release Rollback Plan"))).toBe(true);
      expect(relRes.errors.some((e) => e.includes('Status must be "READY"'))).toBe(true);
      expect(relRes.errors.some((e) => e.includes('Base "--version" is invalid'))).toBe(true);
      expect(relRes.errors.some((e) => e.includes('Rollback-Ref "-evil" is invalid'))).toBe(true);

      // 5. Missing security artifacts
      const secRes = verifySecurityAssuranceArtifacts(tmpRoot);
      expect(secRes.ok).toBe(false);
      expect(secRes.errors.some((e) => e.includes("asvs-5.0-l2-checklist.md"))).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("verifies docs/operations/release-checklist.md and ARCHITECTURE.md capture full M1 + M2 release gate truth", () => {
    const checklist = fs.readFileSync(
      path.join(REPO_ROOT, "docs/operations/release-checklist.md"),
      "utf8",
    );
    expect(checklist).toContain("TASK-038");
    expect(checklist).toContain("TASK-078");
    expect(checklist).toContain("109 / 110");
    expect(checklist).toContain("DEC-022");
    expect(checklist).toContain("FIELD_DATA_ONLY_CRUX_RUM_28D");
    for (let i = 1; i <= 6; i += 1) {
      expect(checklist).toContain(`SEC-00${i}`);
    }
    for (let i = 1; i <= 10; i += 1) {
      expect(checklist).toContain(`EXT-${String(i).padStart(2, "0")}`);
    }

    const arch = fs.readFileSync(path.join(REPO_ROOT, "ARCHITECTURE.md"), "utf8");
    expect(arch).toContain("109 / 110");
    expect(arch).toContain("0001..0033");
    expect(arch).toContain("0001..0024");
    expect(arch).toContain("seo-ai-autopilot");
    expect(arch).toContain("bio-links");
    expect(arch).toContain("wa-cs-rotator");
    expect(arch).toContain("wp-importer");
    expect(arch).toContain("lead-notifier");
    expect(arch).toContain("MCP OAuth 2.1");
    expect(arch).toContain("DEC-022");
  });
});
