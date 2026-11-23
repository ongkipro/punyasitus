#!/usr/bin/env node
/* global process, console */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPORT_DIR = path.resolve(process.env.TASK063_REPORT_DIR || "/tmp/task-063-reports");
const SCREENSHOT_DIR = path.resolve(
  process.env.TASK063_SCREENSHOT_DIR || "/tmp/task-063-screenshots",
);
const MAX_REPORT_AGE_MS = 30 * 60 * 1000; // 30 minutes freshness window
const MAX_FIRST_PARTY_JS_GZIP_BYTES = 25 * 1024;
const MAX_INITIAL_ASSETS_GZIP_BYTES = 500 * 1024;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function runSubScript(relPath, extraArgs = []) {
  const fullPath = path.join(REPO_ROOT, relPath);
  const res = spawnSync("node", [fullPath, ...extraArgs], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TASK063_REPORT_DIR: REPORT_DIR,
      TASK063_SCREENSHOT_DIR: SCREENSHOT_DIR,
    },
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`Sub-gate ${relPath} failed with exit code ${res.status}`);
  }
}

function assertFreshTimestamp(rawIso, label) {
  assert(
    typeof rawIso === "string" && rawIso.trim().length > 0,
    `${label}: missing ISO timestamp`,
  );
  const ts = Date.parse(rawIso);
  assert(Number.isFinite(ts), `${label}: invalid ISO timestamp "${rawIso}"`);
  const ageMs = Date.now() - ts;
  assert(
    ageMs >= -60_000 && ageMs <= MAX_REPORT_AGE_MS,
    `${label}: stale or future report timestamp "${rawIso}" (ageMs=${ageMs}, max=${MAX_REPORT_AGE_MS})`,
  );
}

function readAndAssertReport(filePath, expectedGate, timestampField) {
  assert(fs.existsSync(filePath), `Missing expected M1 gate report: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(parsed.ok === true, `Gate report ${filePath} did not pass (ok=${String(parsed.ok)})`);
  assert(
    parsed.gate === expectedGate,
    `Unexpected gate id in ${filePath}: expected ${expectedGate}, got ${String(parsed.gate)}`,
  );
  assert(
    parsed.notProductionRelease === true,
    `Gate report ${filePath} must explicitly declare notProductionRelease: true (DEC-030)`,
  );
  assertFreshTimestamp(parsed[timestampField], `${expectedGate}.${timestampField}`);
  return parsed;
}

async function main() {
  const verifyExistingOnly = process.argv.includes("--verify-existing-reports");
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const gateReportPath = path.join(REPORT_DIR, "m1-gate.json");
  const budgetReportPath = path.join(REPORT_DIR, "m1-budget.json");
  const checkpointReportPath = path.join(REPORT_DIR, "m1-checkpoint.json");

  if (!verifyExistingOnly) {
    console.log("==> [1/3] Running scripts/verify/m1-gate.mjs");
    runSubScript("scripts/verify/m1-gate.mjs", ["--report-out", gateReportPath]);

    console.log("==> [2/3] Running tests/performance/m1-budget.mjs");
    runSubScript("tests/performance/m1-budget.mjs", ["--report-out", budgetReportPath]);

    console.log("==> [3/3] Running tests/e2e-gate/m1-checkpoint.mjs");
    runSubScript("tests/e2e-gate/m1-checkpoint.mjs", [
      "--report-out",
      checkpointReportPath,
      "--screenshot-dir",
      SCREENSHOT_DIR,
    ]);
  }

  const gateReport = readAndAssertReport(
    gateReportPath,
    "M1_PHASE_1_INTEGRATION_CHECKPOINT",
    "generatedAt",
  );
  const budgetReport = readAndAssertReport(
    budgetReportPath,
    "M1_PERFORMANCE_ASSET_BUDGET",
    "measuredAt",
  );
  const checkpointReport = readAndAssertReport(
    checkpointReportPath,
    "M1_E2E_CHECKPOINT_NEGATIVE_AND_VIEWPORTS",
    "verifiedAt",
  );

  // Enforce M1 gate invariants on reports (essential for --verify-existing-reports mode)
  assert(
    gateReport.checks?.taskCoverage?.m1TotalCount === 85,
    `Expected m1TotalCount === 85 in m1-gate.json, got ${String(gateReport.checks?.taskCoverage?.m1TotalCount)}`,
  );
  assert(
    Array.isArray(gateReport.externalGates) && gateReport.externalGates.length >= 9,
    "Expected >= 9 explicit externalGates in m1-gate.json",
  );
  for (const gate of gateReport.externalGates) {
    assert(
      typeof gate.status === "string" && gate.status.startsWith("UNVERIFIED"),
      `External gate "${gate.id}" must carry UNVERIFIED status, got "${String(gate.status)}"`,
    );
  }

  // Enforce performance & asset budget thresholds on m1-budget.json
  assert(
    typeof budgetReport.summary?.maxFirstPartyJsGzipBytes === "number" &&
      budgetReport.summary.maxFirstPartyJsGzipBytes <= MAX_FIRST_PARTY_JS_GZIP_BYTES,
    `m1-budget.json JS gzip ${String(budgetReport.summary?.maxFirstPartyJsGzipBytes)} exceeds ${MAX_FIRST_PARTY_JS_GZIP_BYTES}`,
  );
  assert(
    typeof budgetReport.summary?.maxInitialTransferredGzipBytes === "number" &&
      budgetReport.summary.maxInitialTransferredGzipBytes <= MAX_INITIAL_ASSETS_GZIP_BYTES,
    `m1-budget.json transferred assets ${String(budgetReport.summary?.maxInitialTransferredGzipBytes)} exceeds ${MAX_INITIAL_ASSETS_GZIP_BYTES}`,
  );
  assert(
    budgetReport.summary?.allLcpObserved === true,
    "m1-budget.json must have observed LCP on every measured run (allLcpObserved === true)",
  );

  // Confirm multi-viewport screenshots (360, 768, 1440) exist on disk and are non-empty PNGs
  for (const suffix of ["-360.png", "-768.png", "-1440.png"]) {
    const matching = checkpointReport.screenshots.filter((p) => p.endsWith(suffix));
    assert(matching.length >= 1, `Expected at least one screenshot ending with ${suffix}`);
    for (const file of matching) {
      assert(fs.existsSync(file), `Screenshot missing on disk: ${file}`);
      assert(fs.statSync(file).size > 1000, `Screenshot unexpectedly small: ${file}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        task: "TASK-063",
        milestone: "M1",
        notProductionRelease: true,
        decisionReference: "DEC-030",
        verifyExistingOnly,
        m1TasksVerified: gateReport.checks.taskCoverage.m1TotalCount,
        performanceSummary: budgetReport.summary,
        viewportsVerified: checkpointReport.viewportsVerified,
        screenshotsCount: checkpointReport.screenshotsCount,
        screenshotDir: SCREENSHOT_DIR,
        reportDir: REPORT_DIR,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("TASK-063 M1 E2E ORCHESTRATOR FAILED:", err);
    process.exit(1);
  });
}
