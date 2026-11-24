#!/usr/bin/env node
/* global process, console */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPORT_DIR = path.resolve(process.env.TASK038_REPORT_DIR || "/tmp/task-038-reports");
const SCREENSHOT_DIR = path.resolve(process.env.TASK038_SCREENSHOT_DIR || "/tmp/qa-task-038");
const MAX_REPORT_AGE_MS = 30 * 60 * 1000;
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
      TASK038_REPORT_DIR: REPORT_DIR,
      TASK038_SCREENSHOT_DIR: SCREENSHOT_DIR,
    },
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`Sub-gate ${relPath} failed with exit code ${res.status}`);
  }
}

function assertFreshTimestamp(rawIso, label) {
  assert(typeof rawIso === "string" && rawIso.trim().length > 0, `${label}: missing ISO timestamp`);
  const ts = Date.parse(rawIso);
  assert(Number.isFinite(ts), `${label}: invalid ISO timestamp "${rawIso}"`);
  const ageMs = Date.now() - ts;
  assert(
    ageMs >= -60_000 && ageMs <= MAX_REPORT_AGE_MS,
    `${label}: stale or future report timestamp "${rawIso}" (ageMs=${ageMs})`,
  );
}

function readAndAssertReport(filePath, expectedGate, timestampField) {
  assert(fs.existsSync(filePath), `Missing expected TASK-038 gate report: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(parsed.ok === true, `Gate report ${filePath} did not pass (ok=${String(parsed.ok)})`);
  const target = parsed.mode === "verify-rollback-plan" ? parsed.drill : parsed;
  assert(
    target.gate === expectedGate,
    `Unexpected gate id in ${filePath}: expected ${expectedGate}, got ${String(target.gate)}`,
  );
  assertFreshTimestamp(target[timestampField], `${expectedGate}.${timestampField}`);
  return parsed;
}

async function main() {
  const verifyExistingOnly = process.argv.includes("--verify-existing-reports");
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const staticReportPath = path.join(REPORT_DIR, "release-gate.json");
  const backupReportPath = path.join(REPORT_DIR, "backup-restore-drill.json");
  const labReportPath = path.join(REPORT_DIR, "release-lab.json");
  const e2eReportPath = path.join(REPORT_DIR, "e2e-release-gate.json");

  if (!verifyExistingOnly) {
    console.log("==> [1/4] Running scripts/verify/release-gate.mjs");
    runSubScript("scripts/verify/release-gate.mjs", ["--report-out", staticReportPath]);

    console.log("==> [2/4] Running scripts/verify/backup-restore-drill.mjs --verify-rollback-plan");
    runSubScript("scripts/verify/backup-restore-drill.mjs", [
      "--verify-rollback-plan",
      "--report-out",
      backupReportPath,
    ]);

    console.log("==> [3/4] Running tests/performance/release-lab.mjs (--allow-tracked-cls-deviation=M1-FU-08)");
    runSubScript("tests/performance/release-lab.mjs", [
      "--allow-tracked-cls-deviation=M1-FU-08",
      "--report-out",
      labReportPath,
    ]);

    console.log("==> [4/4] Running tests/e2e-gate/release-gate.mjs");
    runSubScript("tests/e2e-gate/release-gate.mjs", [
      "--browsers=auto",
      "--report-out",
      e2eReportPath,
      "--screenshot-dir",
      SCREENSHOT_DIR,
    ]);
  }

  const staticReport = readAndAssertReport(
    staticReportPath,
    "FULL_PRODUCTION_RELEASE_GATE_STATIC",
    "generatedAt",
  );
  const backupReportRaw = readAndAssertReport(
    backupReportPath,
    "ISOLATED_BACKUP_RESTORE_AND_DEC022_TOMBSTONE_DRILL",
    "executedAt",
  );
  const backupDrill = backupReportRaw.mode === "verify-rollback-plan" ? backupReportRaw.drill : backupReportRaw;
  const labReport = readAndAssertReport(
    labReportPath,
    "PLAN_SECTION_9_5_RUN_MOBILE_PERFORMANCE_LAB",
    "measuredAt",
  );
  const e2eReport = readAndAssertReport(
    e2eReportPath,
    "FULL_RELEASE_MULTI_BROWSER_AND_NEGATIVE_GATE",
    "verifiedAt",
  );

  // 1. Static gate assertions
  assert(
    staticReport.checks?.taskCoverage?.totalReleaseTasks === 109,
    `Expected 109 release tasks, got ${String(staticReport.checks?.taskCoverage?.totalReleaseTasks)}`,
  );
  assert(
    staticReport.checks?.officialPlugins?.registeredCount === 5,
    `Expected 5 official plugins, got ${String(staticReport.checks?.officialPlugins?.registeredCount)}`,
  );
  assert(
    Array.isArray(staticReport.externalGates) && staticReport.externalGates.length === 10,
    "Expected 10 explicit external gates (EXT-01..EXT-10)",
  );

  // 2. Backup/restore & DEC-022 tombstone assertions
  assert(
    backupDrill.checksums?.activeTenantChecksumMatched === true,
    "Backup drill active tenant checksum mismatch",
  );
  assert(
    backupDrill.tombstoneReplayVerification?.resurrectionPrevented === true,
    "Backup drill did not prove DEC-022 tombstone resurrection prevention",
  );
  assert(backupDrill.withinRtoBudget === true, "Backup drill exceeded RTO budget");

  // 3. 5-run performance lab assertions
  assert(labReport.runsPerRoute >= 5, `Expected >= 5 runs/route, got ${String(labReport.runsPerRoute)}`);
  assert(
    labReport.summary?.bodyReadFailures === 0,
    `Expected bodyReadFailures=0, got ${String(labReport.summary?.bodyReadFailures)}`,
  );
  assert(
    labReport.summary?.maxFirstPartyJsGzipBytes <= MAX_FIRST_PARTY_JS_GZIP_BYTES,
    `JS gzip ${String(labReport.summary?.maxFirstPartyJsGzipBytes)} > ${MAX_FIRST_PARTY_JS_GZIP_BYTES}`,
  );
  assert(
    labReport.summary?.maxInitialTransferredGzipBytes <= MAX_INITIAL_ASSETS_GZIP_BYTES,
    `Initial assets ${String(labReport.summary?.maxInitialTransferredGzipBytes)} > ${MAX_INITIAL_ASSETS_GZIP_BYTES}`,
  );
  assert(
    labReport.inp?.status === "FIELD_DATA_ONLY_CRUX_RUM_28D" && labReport.inp?.valueMs === null,
    "INP must be honestly marked FIELD_DATA_ONLY_CRUX_RUM_28D with null valueMs",
  );

  // 4. Multi-browser & screenshots assertions
  assert(e2eReport.executedEnginesCount >= 1, "At least 1 browser engine must execute");
  for (const suffix of ["-360.png", "-768.png", "-1440.png"]) {
    const matching = (e2eReport.screenshots || []).filter((p) => p.endsWith(suffix));
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
        task: "TASK-038",
        milestone: "M2",
        requirement: "REQ-041",
        verifyExistingOnly,
        releaseTasksVerified: staticReport.checks.taskCoverage.totalReleaseTasks,
        backupDrill: {
          rtoMs: backupDrill.rtoMs,
          platformSnapshotSha256: backupDrill.checksums.platformSnapshotSha256,
          activeTenantChecksumMatched: backupDrill.checksums.activeTenantChecksumMatched,
          resurrectionPrevented: backupDrill.tombstoneReplayVerification.resurrectionPrevented,
        },
        performanceLab: {
          runsPerRoute: labReport.runsPerRoute,
          summary: labReport.summary,
          inp: labReport.inp.status,
        },
        browserMatrix: Object.fromEntries(
          Object.entries(e2eReport.browserMatrix).map(([k, v]) => [k, v.status]),
        ),
        screenshotsCount: e2eReport.screenshotsCount,
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
    console.error("TASK-038 RELEASE GATE ORCHESTRATOR FAILED:", err);
    process.exit(1);
  });
}
