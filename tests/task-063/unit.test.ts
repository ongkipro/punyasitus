import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  M1_EXPECTED_TASK_IDS,
  M2_EXCLUDED_TASK_IDS,
  RELEASE_1_1_EXCLUDED_TASK_IDS,
  runM1Gate,
  UNVERIFIED_EXTERNAL_GATES,
  validateTaskPartition,
  verifyM1TaskCoverage,
  verifySqlMigrations,
  verifyUiProhibitions,
  verifyWorkflowSecurity,
  verifyWranglerConfig,
} from "../../scripts/verify/m1-gate.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-063 Phase 1 Integration Checkpoint (M1) — Unit Invariants", () => {
  it("passes full M1 static & contract gate against the real repository", () => {
    const report = runM1Gate(REPO_ROOT);

    expect(report.ok).toBe(true);
    expect(report.notProductionRelease).toBe(true);
    expect(report.decisionReference).toBe("DEC-030");
    expect(report.checks.taskCoverage.ok).toBe(true);
    expect(report.checks.taskCoverage.m1TotalCount).toBe(85);
    expect(report.checks.taskCoverage.m2ExcludedCount).toBe(24);
    expect(report.checks.taskCoverage.release11ExcludedCount).toBe(1);
    expect(report.checks.migrations.ok).toBe(true);
    expect(report.checks.migrations.platform.count).toBeGreaterThanOrEqual(19);
    expect(report.checks.migrations.platform.maxVersion).toBeLessThanOrEqual(27);
    expect(report.checks.migrations.tenant.count).toBeGreaterThanOrEqual(17);
    expect(report.checks.migrations.tenant.maxVersion).toBeLessThanOrEqual(21);
    expect(report.checks.wrangler.ok).toBe(true);
    expect(report.checks.wrangler.workersDev).toBe(false);
    expect(report.checks.wrangler.previewUrls).toBe(false);
    expect(report.checks.workflows.ok).toBe(true);
    expect(report.checks.workflows.actionsPinned).toBeGreaterThanOrEqual(10);
    expect(report.checks.uiProhibitions.ok).toBe(true);
  });

  it("enforces exact M1 scope exclusion of all M2 Wave 7/8 tasks and Release 1.1 TASK-062", () => {
    const m1Set = new Set(M1_EXPECTED_TASK_IDS);
    expect(m1Set.size).toBe(85);
    expect(m1Set.has("TASK-063")).toBe(true);

    const requiredM2Exclusions = [
      "TASK-019",
      "TASK-020",
      "TASK-035",
      "TASK-038",
      "TASK-064",
      "TASK-066",
      "TASK-071",
      "TASK-072",
      "TASK-073",
      "TASK-074",
      "TASK-075",
      "TASK-078",
      "TASK-079",
      "TASK-083",
      "TASK-084",
      "TASK-085",
      "TASK-086",
      "TASK-098",
      "TASK-099",
      "TASK-100",
      "TASK-101",
      "TASK-105",
      "TASK-109",
      "TASK-110",
    ];
    for (const m2Id of requiredM2Exclusions) {
      expect(m1Set.has(m2Id)).toBe(false);
      expect(M2_EXCLUDED_TASK_IDS).toContain(m2Id);
    }

    expect(m1Set.has("TASK-062")).toBe(false);
    expect(RELEASE_1_1_EXCLUDED_TASK_IDS).toContain("TASK-062");
  });

  it("verifies .github/workflows/ci.yml pins 100% of actions to 40-char SHAs, sets timeouts & minimal permissions, and wires all M1 gates", () => {
    const ciPath = path.join(REPO_ROOT, ".github/workflows/ci.yml");
    const ciYaml = fs.readFileSync(ciPath, "utf8");

    expect(ciYaml).toContain("permissions: {}");
    expect(ciYaml).toContain("contents: read");
    expect(ciYaml).toContain("persist-credentials: false");
    expect(ciYaml).toContain("timeout-minutes: 20");
    expect(ciYaml).toContain("timeout-minutes: 15");
    expect(ciYaml).toContain("pnpm run spec:check");
    expect(ciYaml).toContain("pnpm install --frozen-lockfile");
    expect(ciYaml).toContain("pnpm lint");
    expect(ciYaml).toContain("pnpm typecheck");
    expect(ciYaml).toContain("pnpm test:unit");
    expect(ciYaml).toContain("pnpm test:integration");
    expect(ciYaml).toContain("pnpm build");
    expect(ciYaml).toContain("playwright-core install --with-deps chromium");
    expect(ciYaml).toContain("node scripts/verify/m1-gate.mjs");
    expect(ciYaml).toContain("node tests/performance/m1-budget.mjs");
    expect(ciYaml).toContain("node tests/e2e-gate/m1-checkpoint.mjs");
    expect(ciYaml).toContain("node tests/task-063/e2e.mjs");
    expect(ciYaml).toContain("retention-days: 7");

    // Zero live deploys or production credentials in CI
    expect(ciYaml).not.toMatch(/\bwrangler\s+deploy\b(?!.*--dry-run)/);
    expect(ciYaml).not.toContain("wrangler versions deploy");
    expect(ciYaml).not.toMatch(/\$\{\{\s*secrets\./);

    const wfCheck = verifyWorkflowSecurity(REPO_ROOT);
    expect(wfCheck.ok).toBe(true);
    expect(wfCheck.errors).toEqual([]);
  });

  it("rejects insecure GitHub Actions workflows (missing persist-credentials, secrets refs, missing contents: read, unpinned tags, multi-line wrangler deploy)", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t063-unit-wf-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, ".github/workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, ".github/workflows/bad.yml"),
        [
          "name: Bad",
          "on: [push]",
          "jobs:",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      id-token: write",
          "    env:",
          "      TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "      - run: |",
          "          pnpm exec wrangler \\",
          "            deploy",
        ].join("\n"),
      );

      const wfRes = verifyWorkflowSecurity(tmpRoot);
      expect(wfRes.ok).toBe(false);
      expect(wfRes.errors.some((e: string) => e.includes('permissions: {}'))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes('job "deploy"'))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes("id-token: write"))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes("forbidden secrets reference"))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes("unpinned external action"))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes('persist-credentials: false'))).toBe(true);
      expect(wfRes.errors.some((e: string) => e.includes('live "wrangler deploy"'))).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enforces per-job contents: read across multi-job workflows and rejects broadened secrets expressions", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t063-unit-wf2-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, ".github/workflows"), { recursive: true });

      // Multi-job workflow: job1 has permissions: contents: read, job2 omits permissions completely
      fs.writeFileSync(
        path.join(tmpRoot, ".github/workflows/multi-job.yml"),
        [
          "name: MultiJob",
          "on: [push]",
          "permissions: {}",
          "jobs:",
          "  job1:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      contents: read",
          "    steps:",
          "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "        with:",
          "          persist-credentials: false",
          "  job2:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo ok",
        ].join("\n"),
      );

      // Broadened secrets expressions: fallback expression, toJSON(secrets), bracket notation, secrets: inherit
      fs.writeFileSync(
        path.join(tmpRoot, ".github/workflows/secret-variants.yml"),
        [
          "name: SecretVariants",
          "on: [push]",
          "permissions: {}",
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      contents: read",
          "    env:",
          "      A: ${{ secrets.X || '' }}",
          "      B: ${{ toJSON(secrets) }}",
          "      C: ${{ secrets['Y'] }}",
          "    steps:",
          "      - run: pnpm exec wrangler --config dist/server/wrangler.json deploy",
          "  reusable:",
          "    permissions:",
          "      contents: read",
          "    uses: ./.github/workflows/other.yml",
          "    secrets: inherit",
        ].join("\n"),
      );

      const wfRes = verifyWorkflowSecurity(tmpRoot);
      expect(wfRes.ok).toBe(false);
      expect(
        wfRes.errors.some(
          (e: string) => e.includes("multi-job.yml") && e.includes('job "job2"') && e.includes("contents: read"),
        ),
      ).toBe(true);
      expect(
        wfRes.errors.some(
          (e: string) => e.includes("secret-variants.yml") && e.includes("${{ ... secrets ... }}"),
        ),
      ).toBe(true);
      expect(
        wfRes.errors.some(
          (e: string) => e.includes("secret-variants.yml") && e.includes("secrets property/index access"),
        ),
      ).toBe(true);
      expect(
        wfRes.errors.some(
          (e: string) => e.includes("secret-variants.yml") && e.includes("secrets: inherit"),
        ),
      ).toBe(true);
      expect(
        wfRes.errors.some(
          (e: string) => e.includes("secret-variants.yml") && e.includes('live "wrangler deploy"'),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects task scope overlap, missing task test directories, and TASKS.md milestone mismatch", () => {
    const overlapRes = validateTaskPartition(
      [...M1_EXPECTED_TASK_IDS, "TASK-019"],
      M2_EXCLUDED_TASK_IDS,
      RELEASE_1_1_EXCLUDED_TASK_IDS,
    );
    expect(overlapRes.ok).toBe(false);
    expect(overlapRes.errors.some((e: string) => e.includes("Scope overlap detected for TASK-019"))).toBe(
      true,
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t063-unit-tasks-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, "tests/setup"), { recursive: true });
      // Mismatched TASKS.md: falsely marks M2 task TASK-019 as M1
      fs.writeFileSync(
        path.join(tmpRoot, "TASKS.md"),
        "### TASK-019: Outlets\n- **Requirement:** REQ-029 · R2 · M1 · contract\n",
      );
      const covRes = verifyM1TaskCoverage(tmpRoot);
      expect(covRes.ok).toBe(false);
      expect(covRes.errors.some((e: string) => e.includes("TASKS.md marks TASK-019 as M1"))).toBe(true);
      expect(covRes.errors.some((e: string) => e.includes("Missing test directories for M1 tasks"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe wrangler.jsonc (workers_dev: true, leaked secrets), destructive/out-of-range SQL migrations, and forbidden UI imports/icons", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t063-unit-neg-"));
    try {
      // 1. Unsafe wrangler.jsonc
      fs.mkdirSync(path.join(tmpRoot, "apps/web"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "apps/web/wrangler.jsonc"),
        JSON.stringify({
          name: "punyasitus-web",
          workers_dev: true,
          preview_urls: true,
          vars: { CLOUDFLARE_API_TOKEN: "super-secret-leaked-value-1234" },
        }),
      );
      const wrRes = verifyWranglerConfig(tmpRoot);
      expect(wrRes.ok).toBe(false);
      expect(wrRes.errors.some((e: string) => e.includes("workers_dev: false"))).toBe(true);
      expect(wrRes.errors.some((e: string) => e.includes("preview_urls: false"))).toBe(true);
      expect(wrRes.errors.some((e: string) => e.includes("Leaked secret pattern"))).toBe(true);

      // 2. Destructive SQL + version exceeding M1 ceiling
      fs.mkdirSync(path.join(tmpRoot, "packages/db/migrations/platform"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "packages/db/migrations/tenant"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "packages/db/migrations/platform/0001_bad.sql"),
        "CREATE TABLE ok_tbl (id TEXT PRIMARY KEY);\nDROP TABLE ok_tbl;",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "packages/db/migrations/platform/0028_m2_leak.sql"),
        "CREATE TABLE m2_tbl (id TEXT PRIMARY KEY);",
      );
      fs.writeFileSync(
        path.join(tmpRoot, "packages/db/migrations/tenant/0022_m2_leak.sql"),
        "CREATE TABLE m2_tenant_tbl (id INTEGER PRIMARY KEY);",
      );
      const migRes = verifySqlMigrations(tmpRoot);
      expect(migRes.ok).toBe(false);
      expect(migRes.errors.some((e: string) => e.includes("Destructive DROP TABLE"))).toBe(true);
      expect(migRes.errors.some((e: string) => e.includes("0028_m2_leak.sql exceeds M1 migration ceiling"))).toBe(
        true,
      );
      expect(migRes.errors.some((e: string) => e.includes("0022_m2_leak.sql exceeds M1 migration ceiling"))).toBe(
        true,
      );

      // 3. Forbidden UI imports / props / icons
      fs.mkdirSync(path.join(tmpRoot, "apps/web/src/components"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "apps/web/src/components/Bad.tsx"),
        [
          'import * as Dialog from "@radix-ui/react-dialog";',
          'import { SparklesIcon } from "lucide-react";',
          "export const Bad = () => <Dialog.Trigger asChild><SparklesIcon /></Dialog.Trigger>;",
        ].join("\n"),
      );
      const uiRes = verifyUiProhibitions(tmpRoot);
      expect(uiRes.ok).toBe(false);
      expect(uiRes.errors.some((e: string) => e.includes("@radix-ui/*"))).toBe(true);
      expect(uiRes.errors.some((e: string) => e.includes("asChild"))).toBe(true);
      expect(uiRes.errors.some((e: string) => e.includes("Sparkles"))).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("verifies docs/operations/release-checklist.md enforces DEC-030, exact M1-FU-01..08 & EXT-01..10 tables, and accurate verified counts", () => {
    const checklistPath = path.join(REPO_ROOT, "docs/operations/release-checklist.md");
    expect(fs.existsSync(checklistPath)).toBe(true);

    const text = fs.readFileSync(checklistPath, "utf8");
    expect(text).toContain("DEC-030");
    expect(text).toContain("NOT a production release");
    expect(text).toContain("UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION");
    expect(text).toContain("85 unit test files (806 tests)");
    expect(text).toContain("73 integration test files (375 tests)");
    expect(text).toContain("NOT verified in M1");
    expect(text).toContain("API-level No-JS");

    for (let i = 1; i <= 8; i += 1) {
      expect(text).toContain(`M1-FU-0${i}`);
    }
    for (let i = 1; i <= 10; i += 1) {
      const code = `EXT-${String(i).padStart(2, "0")}`;
      expect(text).toContain(code);
    }

    expect(text).toContain("UU 27/2022");
    expect(text).toContain("PSE Lingkup Privat");
    expect(text).toContain("UU KUP Art. 28(11)");
    expect(text).toContain("Kepmen Komdigi 127/128");
    expect(text).toContain("AutoLaris");
    expect(text).toContain("notif.punyasitus.com");
    expect(UNVERIFIED_EXTERNAL_GATES.every((g) => g.status.startsWith("UNVERIFIED"))).toBe(true);
  });
});
