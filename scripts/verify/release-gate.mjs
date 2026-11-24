#!/usr/bin/env node
/* global process, console */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  computeMigrationChecksum,
  splitMigrationStatements,
} from "../../packages/db/src/connections/sql-splitter.ts";
import {
  M1_EXPECTED_TASK_IDS,
  M1_WAVES,
  M2_EXCLUDED_TASK_IDS,
  RELEASE_1_1_EXCLUDED_TASK_IDS,
  validateTaskPartition,
  verifyWorkflowSecurity,
  verifyWranglerConfig,
} from "./m1-gate.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");

export const M2_WAVE_7_TASK_IDS = Object.freeze(
  M2_EXCLUDED_TASK_IDS.filter((id) => id !== "TASK-078" && id !== "TASK-038"),
);

export const M2_WAVE_8_TASK_IDS = Object.freeze(["TASK-038", "TASK-078"]);

export const RELEASE_WAVES = Object.freeze({
  ...M1_WAVES,
  wave7: M2_WAVE_7_TASK_IDS,
  wave8: M2_WAVE_8_TASK_IDS,
});

/**
 * Full 109-task M1 + M2 production release scope (85 M1 + 22 Wave 7 M2 + 2 Wave 8 M2).
 * TASK-062 remains explicitly deferred to Release 1.1 per DEC-035 C16.
 */
export const FULL_RELEASE_TASK_IDS = Object.freeze(
  [...M1_EXPECTED_TASK_IDS, ...M2_EXCLUDED_TASK_IDS].sort(),
);

export const EXPECTED_OFFICIAL_PLUGIN_IDS = Object.freeze([
  "seo-ai-autopilot",
  "bio-links",
  "wa-cs-rotator",
  "wp-importer",
  "lead-notifier",
]);

export const EXPECTED_OFFICIAL_PLUGIN_CONSTANTS = Object.freeze([
  "SEO_AI_AUTOPILOT_PLUGIN",
  "BIO_LINKS_PLUGIN",
  "WA_CS_ROTATOR_PLUGIN",
  "WP_IMPORTER_PLUGIN",
  "LEAD_NOTIFIER_PLUGIN",
]);

export const EXPECTED_MIN_PLATFORM_MIGRATION_VERSION = 33;
export const EXPECTED_MIN_TENANT_MIGRATION_VERSION = 24;

export const RELEASE_EXTERNAL_GATES = Object.freeze([
  {
    id: "EXT-01",
    category: "provider",
    name: "Cloudflare Workers Paid account with isolated punyasitus-* D1, R2, Queues, Images & AI bindings",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-02",
    category: "provider",
    name: "Cloudflare for SaaS staging/production zone, live HTTP DCV pass-through & O2O customer zone",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-03",
    category: "provider",
    name: "Trust+ / Komdigi static-IP reputation check against live SaaS zones",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-04",
    category: "provider",
    name: "Google OAuth live client credentials, consent screen verification & redirect URIs",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-05",
    category: "provider",
    name: "Cloudflare Email Sending (Beta) DNS onboarding on notif.punyasitus.com & inbox deliverability",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-06",
    category: "provider",
    name: "AutoLaris merchant approval, static-IP relay host & live Advice reconciliation",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-07",
    category: "legal",
    name: "Indonesian legal counsel review of Bahasa Indonesia Terms & Privacy Policy (UU 27/2022 UU PDP)",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-08",
    category: "legal",
    name: "PSE Lingkup Privat registration, UU KUP Art. 28(11) tax retention & Kepmen Komdigi 127/128 compliance text",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-09",
    category: "launch",
    name: "Manual Google Search Console & Bing Webmaster live domain verification",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
  {
    id: "EXT-10",
    category: "release_gate",
    name: "Live staging OWASP ZAP full active scan, live staging 3-browser lab & production pre-launch backup snapshot",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
  },
]);

const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const HEX16_RE = /^[0-9a-f]{16}$/;
const DESTRUCTIVE_DDL_RE = /\b(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE\s+TABLE|TRUNCATE)\b/i;
const UI_CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const RADIX_IMPORT_RE =
  /(?:from\s+["'](?:@radix-ui\/[^"']+|radix-ui)["']|import\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\)|require\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\))/;
const AS_CHILD_RE = /\basChild(?:\s*=|\s*\?|\s*:|\s*,|\s*\}|\s*\)|\s*\/?>|\s+(?=[a-zA-Z0-9_$-]))/;
const SPARKLES_RE = /\bSparkles(?:Icon)?\b/;

const ROLLBACK_COMMAND_RE =
  /^(?:git|docker|kubectl|wrangler|npm|pnpm|yarn|bun|bash|sh|\.\/|\/)[^\r\n]*$/i;
const BACKUP_PROOF_RE = /^(?:backup|snapshot|artifact|s3|r2|gs):\/\/[A-Za-z0-9][A-Za-z0-9._/@:+-]{5,}$/i;
const UNSET_VALUES = new Set(["", "UNSET", "TBD", "NONE"]);
const RELEASE_REQUIRED_FIELDS = [
  "Release-ID",
  "Base",
  "Environment",
  "Declared-Risk",
  "Rollback-Ref",
  "Rollback-Command",
  "Backup-Proof",
  "Status",
];

function stripJsComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\r\n]*/g, "$1");
}

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full, entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function verifyFullTaskCoverage(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const partition = validateTaskPartition(
    M1_EXPECTED_TASK_IDS,
    M2_EXCLUDED_TASK_IDS,
    RELEASE_1_1_EXCLUDED_TASK_IDS,
  );
  errors.push(...partition.errors);

  if (FULL_RELEASE_TASK_IDS.length !== 109) {
    errors.push(`Expected exactly 109 M1+M2 release tasks, got ${FULL_RELEASE_TASK_IDS.length}`);
  }
  if (M2_WAVE_7_TASK_IDS.length !== 22) {
    errors.push(`Expected 22 Wave 7 M2 tasks, got ${M2_WAVE_7_TASK_IDS.length}`);
  }
  if (M2_WAVE_8_TASK_IDS.length !== 2) {
    errors.push(`Expected 2 Wave 8 M2 tasks, got ${M2_WAVE_8_TASK_IDS.length}`);
  }

  const tasksMdPath = path.join(rootDir, "TASKS.md");
  const expectedSet = new Set(FULL_RELEASE_TASK_IDS);
  const deferredSet = new Set(RELEASE_1_1_EXCLUDED_TASK_IDS);
  if (fs.existsSync(tasksMdPath)) {
    const tasksText = fs.readFileSync(tasksMdPath, "utf8");
    const taskBlockRe = /###\s+(TASK-\d{3}):[^\n]*\n-\s+\*\*Requirement:\*\*\s+([^\n]+)/g;
    const parsedRelease = new Set();
    const parsedDeferred = new Set();
    for (const match of tasksText.matchAll(taskBlockRe)) {
      const taskId = match[1];
      const meta = match[2];
      if (meta.includes("· M1 ·") || meta.includes("· M2 ·")) parsedRelease.add(taskId);
      else if (meta.includes("Release 1.1")) parsedDeferred.add(taskId);
    }
    for (const id of parsedRelease) {
      if (!expectedSet.has(id)) {
        errors.push(`TASKS.md marks ${id} as M1/M2, but it is missing from FULL_RELEASE_TASK_IDS`);
      }
    }
    for (const id of expectedSet) {
      if (!parsedRelease.has(id)) {
        errors.push(`${id} is in FULL_RELEASE_TASK_IDS, but TASKS.md does not mark it M1/M2`);
      }
    }
    for (const id of deferredSet) {
      if (!parsedDeferred.has(id)) {
        errors.push(`${id} must remain explicitly deferred as Release 1.1 in TASKS.md (DEC-035 C16)`);
      }
    }
  } else {
    errors.push(`Missing ${tasksMdPath}`);
  }

  const testsRoot = path.join(rootDir, "tests");
  const missingTaskDirs = [];
  const unwiredTasks = [];
  let unitSuiteCount = 0;
  let integrationSuiteCount = 0;
  let e2eScriptCount = 0;

  for (const taskId of FULL_RELEASE_TASK_IDS) {
    const slug = taskId.toLowerCase();
    const taskDir = path.join(testsRoot, slug);
    if (!fs.existsSync(taskDir) || !fs.statSync(taskDir).isDirectory()) {
      missingTaskDirs.push(taskId);
      continue;
    }
    const files = fs.readdirSync(taskDir);
    const hasUnit = files.some((f) => f === "unit.test.ts" || f.endsWith(".unit.test.ts"));
    const hasIntegration = files.some(
      (f) => f === "workerd.integration.test.ts" || f.endsWith(".integration.test.ts"),
    );
    const hasE2e = files.includes("e2e.mjs");
    if (hasUnit) unitSuiteCount += 1;
    if (hasIntegration) integrationSuiteCount += 1;
    if (hasE2e) e2eScriptCount += 1;
    if (!hasUnit && !hasIntegration && !hasE2e) {
      unwiredTasks.push(taskId);
    }
  }

  const task038Dir = path.join(testsRoot, "task-038");
  for (const requiredFile of ["unit.test.ts", "workerd.integration.test.ts", "e2e.mjs"]) {
    if (!fs.existsSync(path.join(task038Dir, requiredFile))) {
      errors.push(`tests/task-038/${requiredFile} is required for TASK-038 release gate coverage`);
    }
  }

  if (missingTaskDirs.length > 0) {
    errors.push(`Missing test directories for M1+M2 tasks: ${missingTaskDirs.join(", ")}`);
  }
  if (unwiredTasks.length > 0) {
    errors.push(`M1+M2 task directories with no test files: ${unwiredTasks.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    totalReleaseTasks: FULL_RELEASE_TASK_IDS.length,
    m1Count: M1_EXPECTED_TASK_IDS.length,
    m2Wave7Count: M2_WAVE_7_TASK_IDS.length,
    m2Wave8Count: M2_WAVE_8_TASK_IDS.length,
    deferredRelease11Ids: [...RELEASE_1_1_EXCLUDED_TASK_IDS],
    verifiedTaskDirsCount: FULL_RELEASE_TASK_IDS.length - missingTaskDirs.length,
    unitSuiteCount,
    integrationSuiteCount,
    e2eScriptCount,
    errors,
  };
}

export function verifyFullSqlMigrations(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const summary = {
    platform: { count: 0, minVersion: 0, maxVersion: 0, statementsTotal: 0, files: [] },
    tenant: { count: 0, minVersion: 0, maxVersion: 0, statementsTotal: 0, files: [] },
  };

  const scopes = [
    {
      key: "platform",
      dir: path.join(rootDir, "packages/db/migrations/platform"),
      minExpectedMaxVersion: EXPECTED_MIN_PLATFORM_MIGRATION_VERSION,
    },
    {
      key: "tenant",
      dir: path.join(rootDir, "packages/db/migrations/tenant"),
      minExpectedMaxVersion: EXPECTED_MIN_TENANT_MIGRATION_VERSION,
    },
  ];

  for (const scope of scopes) {
    if (!fs.existsSync(scope.dir)) {
      errors.push(`Missing migration directory: ${path.relative(rootDir, scope.dir)}`);
      continue;
    }
    const entries = fs
      .readdirSync(scope.dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    if (entries.length === 0) {
      errors.push(`No SQL migrations found in ${path.relative(rootDir, scope.dir)}`);
      continue;
    }

    const seenVersions = new Set();
    let minVersion = Number.POSITIVE_INFINITY;
    let maxVersion = 0;

    for (const filename of entries) {
      const m = MIGRATION_FILE_RE.exec(filename);
      if (!m) {
        errors.push(`Invalid migration filename format: ${scope.key}/${filename}`);
        continue;
      }
      const version = Number.parseInt(m[1], 10);
      if (seenVersions.has(version)) {
        errors.push(`Duplicate migration version ${m[1]} in ${scope.key}/${filename}`);
      }
      seenVersions.add(version);
      if (version < minVersion) minVersion = version;
      if (version > maxVersion) maxVersion = version;

      const fullPath = path.join(scope.dir, filename);
      const sql = fs.readFileSync(fullPath, "utf8");
      const checksum = computeMigrationChecksum(sql);
      if (!HEX16_RE.test(checksum)) {
        errors.push(`Invalid checksum generated for ${scope.key}/${filename}: ${checksum}`);
      }

      let statements;
      try {
        statements = splitMigrationStatements(sql);
      } catch (err) {
        errors.push(
          `Failed to parse ${scope.key}/${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (statements.length === 0) {
        errors.push(`Migration ${scope.key}/${filename} contains zero executable SQL statements`);
      }

      for (const stmt of statements) {
        if (DESTRUCTIVE_DDL_RE.test(stmt)) {
          errors.push(
            `Destructive DDL (DROP TABLE / DROP COLUMN / TRUNCATE) forbidden in ${scope.key}/${filename}: ${stmt.slice(0, 100)}`,
          );
        }
      }

      summary[scope.key].statementsTotal += statements.length;
      summary[scope.key].files.push({
        filename,
        version,
        statements: statements.length,
        checksum,
      });
    }

    if (minVersion !== 1) {
      errors.push(`${scope.key} migrations must start at version 0001 (got ${String(minVersion)})`);
    }
    if (maxVersion < scope.minExpectedMaxVersion) {
      errors.push(
        `${scope.key} max migration version ${maxVersion} is below expected M1+M2 version ${scope.minExpectedMaxVersion}`,
      );
    }

    summary[scope.key].count = entries.length;
    summary[scope.key].minVersion = Number.isFinite(minVersion) ? minVersion : 0;
    summary[scope.key].maxVersion = maxVersion;
  }

  return {
    ok: errors.length === 0,
    ...summary,
    errors,
  };
}

export function verifyOfficialPlugins(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const registryPath = path.join(rootDir, "apps/web/src/core/plugin-registry.ts");
  if (!fs.existsSync(registryPath)) {
    return {
      ok: false,
      registeredCount: 0,
      registeredPluginIds: [],
      defaultActivePluginIds: [],
      errors: ["Missing apps/web/src/core/plugin-registry.ts"],
    };
  }

  const text = fs.readFileSync(registryPath, "utf8");
  const codeOnly = stripJsComments(text);

  // Enforce static Frozen-Core invariants (no dynamic import / eval / new Function)
  if (
    /\bimport\s*\(/.test(codeOnly) ||
    /\beval\s*\(/.test(codeOnly) ||
    /\bnew\s+Function\s*\(/.test(codeOnly)
  ) {
    errors.push("apps/web/src/core/plugin-registry.ts contains forbidden dynamic code loading");
  }

  // Extract REGISTERED_FIRST_PARTY_PLUGINS array block
  const regBlockMatch = /REGISTERED_FIRST_PARTY_PLUGINS[\s\S]*?=\s*\[([\s\S]*?)\]/m.exec(text);
  const regBlock = regBlockMatch ? regBlockMatch[1] : "";
  const registeredConstants = [];
  for (const constantName of EXPECTED_OFFICIAL_PLUGIN_CONSTANTS) {
    if (!new RegExp(`\\b${constantName}\\b`).test(regBlock)) {
      errors.push(`Missing official plugin ${constantName} in REGISTERED_FIRST_PARTY_PLUGINS`);
    } else {
      registeredConstants.push(constantName);
    }
  }

  // Verify each plugin package exists on disk under packages/plugins/<id>/index.ts
  const registeredPluginIds = [];
  for (const pluginId of EXPECTED_OFFICIAL_PLUGIN_IDS) {
    const pluginEntry = path.join(rootDir, "packages/plugins", pluginId, "index.ts");
    if (!fs.existsSync(pluginEntry)) {
      errors.push(`Missing official plugin package entrypoint: packages/plugins/${pluginId}/index.ts`);
    } else if (text.includes(`packages/plugins/${pluginId}/index.ts`)) {
      registeredPluginIds.push(pluginId);
    } else {
      errors.push(`apps/web/src/core/plugin-registry.ts does not import packages/plugins/${pluginId}/index.ts`);
    }
  }

  // Verify DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS contains ONLY seo-ai-autopilot
  const defaultBlockMatch = /DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS\s*=\s*\[([\s\S]*?)\]/m.exec(text);
  const defaultTokens = defaultBlockMatch
    ? defaultBlockMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const defaultActivePluginIds = [];
  if (
    defaultTokens.length !== 1 ||
    (defaultTokens[0] !== "SEO_AI_AUTOPILOT_PLUGIN_ID" &&
      defaultTokens[0] !== '"seo-ai-autopilot"' &&
      defaultTokens[0] !== "'seo-ai-autopilot'")
  ) {
    errors.push(
      `DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS must contain ONLY seo-ai-autopilot (DEC-042), got [${defaultTokens.join(", ")}]`,
    );
  } else {
    defaultActivePluginIds.push("seo-ai-autopilot");
  }

  return {
    ok: errors.length === 0,
    registeredCount: registeredConstants.length,
    registeredPluginIds,
    defaultActivePluginIds,
    errors,
  };
}

export function verifyWorkflowHardening(rootDir = DEFAULT_ROOT) {
  const base = verifyWorkflowSecurity(rootDir);
  const errors = [...base.errors];
  const workflowsDir = path.join(rootDir, ".github/workflows");
  const requiredWorkflows = [
    "ci.yml",
    "security.yml",
    "staged-release-dry-run.yml",
    "release-gate.yml",
  ];

  let jobsChecked = 0;
  if (fs.existsSync(workflowsDir)) {
    const existing = new Set(fs.readdirSync(workflowsDir));
    for (const reqWf of requiredWorkflows) {
      if (!existing.has(reqWf)) {
        errors.push(`Missing required workflow .github/workflows/${reqWf}`);
      }
    }

    const files = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();

    for (const file of files) {
      const rel = `.github/workflows/${file}`;
      const lines = fs.readFileSync(path.join(workflowsDir, file), "utf8").split(/\r?\n/);
      let inJobs = false;
      let currentJob = null;
      const jobs = [];

      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        if (/^jobs:\s*(?:#.*)?$/.test(line)) {
          inJobs = true;
          currentJob = null;
          continue;
        }
        if (inJobs && /^[^\s]/.test(line)) {
          inJobs = false;
          currentJob = null;
          continue;
        }
        if (inJobs) {
          const m = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
          if (m) {
            currentJob = { name: m[1], lineNumber: idx + 1, hasTimeout: false };
            jobs.push(currentJob);
          } else if (currentJob && /^    timeout-minutes:\s*\d+\s*$/.test(line)) {
            currentJob.hasTimeout = true;
          }
        }
      }

      for (const job of jobs) {
        jobsChecked += 1;
        if (!job.hasTimeout) {
          errors.push(`${rel}:${job.lineNumber}: job "${job.name}" must declare timeout-minutes`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    filesChecked: base.filesChecked,
    workflowFiles: base.workflowFiles ?? [],
    actionsPinned: base.actionsPinned,
    jobsChecked,
    errors,
  };
}

export function verifyFullUiProhibitions(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const scanDirs = [
    path.join(rootDir, "apps/web/src"),
    path.join(rootDir, "packages/plugins"),
  ];
  const files = [];
  for (const dir of scanDirs) {
    walkFiles(dir, (_full, name) => UI_CODE_EXTS.has(path.extname(name)), files);
  }

  for (const file of files) {
    const rel = path.relative(rootDir, file);
    const content = stripJsComments(fs.readFileSync(file, "utf8"));
    if (RADIX_IMPORT_RE.test(content)) {
      errors.push(`${rel}: forbidden @radix-ui/* or radix-ui import (DEC-036)`);
    }
    if (AS_CHILD_RE.test(content)) {
      errors.push(`${rel}: forbidden Radix asChild prop (DEC-036)`);
    }
    if (SPARKLES_RE.test(content)) {
      errors.push(`${rel}: forbidden Sparkles / SparklesIcon usage (DESIGN.md anti-slop rule)`);
    }
  }

  return {
    ok: errors.length === 0,
    filesScanned: files.length,
    errors,
  };
}

function parseReleaseFields(text) {
  const out = {};
  for (const name of RELEASE_REQUIRED_FIELDS) {
    const m = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im").exec(text);
    if (m) out[name] = m[1].trim();
  }
  return out;
}

function runGit(rootDir, args) {
  return spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
}

const SAFE_GIT_COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function isSafeGitRefValue(ref) {
  return typeof ref === "string" && !ref.startsWith("-") && SAFE_GIT_COMMIT_SHA_RE.test(ref);
}

export function verifyReleaseManifest(rootDir = DEFAULT_ROOT, options = {}) {
  const checkGitAncestry = options.checkGitAncestry !== false;
  const errors = [];
  const releasePath = path.join(rootDir, "RELEASE.md");
  if (!fs.existsSync(releasePath)) {
    return { ok: false, fields: {}, errors: ["Missing RELEASE.md"] };
  }

  const text = fs.readFileSync(releasePath, "utf8");
  const fields = parseReleaseFields(text);

  for (const name of RELEASE_REQUIRED_FIELDS) {
    if (!fields[name] || UNSET_VALUES.has(fields[name])) {
      errors.push(`RELEASE.md field "${name}" is missing or unset`);
    }
  }

  if (fields.Environment && fields.Environment !== "production") {
    errors.push(`RELEASE.md Environment must be "production" (got "${fields.Environment}")`);
  }
  if (fields["Declared-Risk"] && fields["Declared-Risk"] !== "R3") {
    errors.push(`RELEASE.md Declared-Risk must be "R3" (got "${fields["Declared-Risk"]}")`);
  }
  if (fields.Status && fields.Status !== "READY") {
    errors.push(`RELEASE.md Status must be "READY" (got "${fields.Status}")`);
  }
  if (fields["Rollback-Command"] && !ROLLBACK_COMMAND_RE.test(fields["Rollback-Command"])) {
    errors.push(
      `RELEASE.md Rollback-Command "${fields["Rollback-Command"]}" does not match rollback-check supported command pattern`,
    );
  }
  if (fields["Backup-Proof"] && !BACKUP_PROOF_RE.test(fields["Backup-Proof"])) {
    errors.push(
      `RELEASE.md Backup-Proof "${fields["Backup-Proof"]}" must be a structured backup://, snapshot://, or artifact:// URI`,
    );
  }

  if (!/First-Release Rollback Plan/i.test(text)) {
    errors.push("RELEASE.md must document the First-Release Rollback Plan (REQ-041)");
  }
  if (!/DEC-022/i.test(text)) {
    errors.push("RELEASE.md must reference DEC-022 tombstone replay in rollback/restore plan");
  }

  if (fields.Base && !UNSET_VALUES.has(fields.Base)) {
    if (!isSafeGitRefValue(fields.Base)) {
      errors.push(
        `RELEASE.md Base "${fields.Base}" is invalid (must be a 7-40 char hex commit SHA and never start with "-")`,
      );
    } else if (checkGitAncestry) {
      const headRes = runGit(rootDir, ["rev-parse", "HEAD^{commit}"]);
      const baseRes = runGit(rootDir, ["rev-parse", "--verify", "--end-of-options", `${fields.Base}^{commit}`]);
      if (baseRes.status !== 0) {
        errors.push(`RELEASE.md Base "${fields.Base}" is not a valid git commit`);
      } else if (headRes.status === 0) {
        const headSha = headRes.stdout.trim();
        const baseSha = baseRes.stdout.trim();
        const ancRes = runGit(rootDir, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
        if (ancRes.status !== 0) {
          errors.push(`RELEASE.md Base "${baseSha}" is not an ancestor of HEAD`);
        } else if (baseSha === headSha) {
          errors.push("RELEASE.md Base equals HEAD; release delta must be non-empty");
        }
      }
    }
  }

  if (fields["Rollback-Ref"] && !UNSET_VALUES.has(fields["Rollback-Ref"])) {
    if (!isSafeGitRefValue(fields["Rollback-Ref"])) {
      errors.push(
        `RELEASE.md Rollback-Ref "${fields["Rollback-Ref"]}" is invalid (must be a 7-40 char hex commit SHA and never start with "-")`,
      );
    } else if (checkGitAncestry) {
      const headRes = runGit(rootDir, ["rev-parse", "HEAD^{commit}"]);
      const rbRes = runGit(rootDir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${fields["Rollback-Ref"]}^{commit}`,
      ]);
      if (rbRes.status !== 0) {
        errors.push(`RELEASE.md Rollback-Ref "${fields["Rollback-Ref"]}" is not a valid git commit`);
      } else if (headRes.status === 0) {
        const headSha = headRes.stdout.trim();
        const rbSha = rbRes.stdout.trim();
        const ancRes = runGit(rootDir, ["merge-base", "--is-ancestor", rbSha, "HEAD"]);
        if (ancRes.status !== 0) {
          errors.push(`RELEASE.md Rollback-Ref "${rbSha}" is not an ancestor of HEAD`);
        } else if (rbSha === headSha) {
          errors.push("RELEASE.md Rollback-Ref must identify a commit before HEAD");
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    fields,
    errors,
  };
}

export function verifySecurityAssuranceArtifacts(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const required = {
    asvsChecklist: "docs/security/asvs-5.0-l2-checklist.md",
    findingsRegister: "docs/security/findings-register.md",
    zapScanReport: "docs/security/zap-scan-report.md",
    surfaceInventory: "docs/security/surface-inventory.json",
  };
  const present = {};

  for (const [key, rel] of Object.entries(required)) {
    const full = path.join(rootDir, rel);
    const exists = fs.existsSync(full);
    present[key] = exists;
    if (!exists) {
      errors.push(`Missing TASK-078 security artifact: ${rel}`);
    }
  }

  let independentReviewApproved = false;
  if (present.zapScanReport) {
    const zapText = fs.readFileSync(path.join(rootDir, required.zapScanReport), "utf8");
    independentReviewApproved =
      /Independent Reviewer Sign-Off[\s\S]*?`?APPROVED`?/i.test(zapText) &&
      /VERDICT:\s*APPROVE/i.test(zapText);
    if (!independentReviewApproved) {
      errors.push(
        "docs/security/zap-scan-report.md must record APPROVED independent review sign-off (DEC-032)",
      );
    }
  }

  let trackedFindingsCount = 0;
  if (present.findingsRegister) {
    const findingsText = fs.readFileSync(path.join(rootDir, required.findingsRegister), "utf8");
    const ids = new Set(findingsText.match(/\bSEC-\d{3}\b/g) ?? []);
    trackedFindingsCount = ids.size;
    if (trackedFindingsCount < 6) {
      errors.push(
        `docs/security/findings-register.md expected >= 6 tracked SEC-00x findings, found ${trackedFindingsCount}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    present,
    independentReviewApproved,
    trackedFindingsCount,
    errors,
  };
}

export function runReleaseGate(rootDir = DEFAULT_ROOT, options = {}) {
  const taskCoverage = verifyFullTaskCoverage(rootDir);
  const migrations = verifyFullSqlMigrations(rootDir);
  const officialPlugins = verifyOfficialPlugins(rootDir);
  const workflows = verifyWorkflowHardening(rootDir);
  const wrangler = verifyWranglerConfig(rootDir);
  const uiProhibitions = verifyFullUiProhibitions(rootDir);
  const releaseManifest = verifyReleaseManifest(rootDir, options);
  const securityAssurance = verifySecurityAssuranceArtifacts(rootDir);

  const ok =
    taskCoverage.ok &&
    migrations.ok &&
    officialPlugins.ok &&
    workflows.ok &&
    wrangler.ok &&
    uiProhibitions.ok &&
    releaseManifest.ok &&
    securityAssurance.ok;

  return {
    ok,
    gate: "FULL_PRODUCTION_RELEASE_GATE_STATIC",
    task: "TASK-038",
    milestone: "M2",
    requirement: "REQ-041",
    constraints: ["REQ-040", "REQ-042"],
    decisionReference: "DEC-030",
    generatedAt: new Date().toISOString(),
    checks: {
      taskCoverage,
      migrations,
      officialPlugins,
      workflows,
      wrangler,
      uiProhibitions,
      releaseManifest,
      securityAssurance,
    },
    externalGates: RELEASE_EXTERNAL_GATES,
  };
}

function parseCliArgs(argv) {
  const args = {
    rootDir: DEFAULT_ROOT,
    jsonOnly: false,
    reportOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--root" && argv[i + 1]) {
      args.rootDir = path.resolve(argv[++i]);
    } else if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node scripts/verify/release-gate.mjs [--json] [--report-out <path>] [--root <dir>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function formatHumanSummary(report) {
  const c = report.checks;
  const lines = [
    "========================================================================",
    "PunyaSitus — Full Production Release Gate (M1 + M2 / TASK-038)",
    "Status: " + (report.ok ? "PASS (Static & Contract Release Gate)" : "FAIL"),
    "Scope : 109 / 110 tasks (85 M1 + 22 Wave 7 M2 + 2 Wave 8 M2; TASK-062 deferred R1.1)",
    "========================================================================",
    `1. M1+M2 Task Coverage : ${c.taskCoverage.ok ? "PASS" : "FAIL"} (${c.taskCoverage.verifiedTaskDirsCount}/${c.taskCoverage.totalReleaseTasks} task suites; ${c.taskCoverage.unitSuiteCount} unit / ${c.taskCoverage.integrationSuiteCount} integration / ${c.taskCoverage.e2eScriptCount} e2e)`,
    `2. SQL Migrations      : ${c.migrations.ok ? "PASS" : "FAIL"} (platform: ${c.migrations.platform.count} files v${c.migrations.platform.minVersion}..v${c.migrations.platform.maxVersion}; tenant: ${c.migrations.tenant.count} files v${c.migrations.tenant.minVersion}..v${c.migrations.tenant.maxVersion}; 0 destructive DDL)`,
    `3. Official Plugins    : ${c.officialPlugins.ok ? "PASS" : "FAIL"} (${c.officialPlugins.registeredCount}/5 registered: ${c.officialPlugins.registeredPluginIds.join(", ")}; default-active: ${c.officialPlugins.defaultActivePluginIds.join(", ")})`,
    `4. Workflows Hardening : ${c.workflows.ok ? "PASS" : "FAIL"} (${c.workflows.filesChecked} workflows, ${c.workflows.jobsChecked} jobs with timeout-minutes, ${c.workflows.actionsPinned} SHA-pinned actions)`,
    `5. Wrangler & Topology : ${c.wrangler.ok ? "PASS" : "FAIL"} (workers_dev=${String(c.wrangler.workersDev)}, preview_urls=${String(c.wrangler.previewUrls)}, topologyChecks=${c.wrangler.topologyChecksPassed})`,
    `6. UI Guardrails       : ${c.uiProhibitions.ok ? "PASS" : "FAIL"} (${c.uiProhibitions.filesScanned} files scanned across apps/web/src & packages/plugins)`,
    `7. RELEASE.md Manifest : ${c.releaseManifest.ok ? "PASS" : "FAIL"} (Release-ID=${c.releaseManifest.fields["Release-ID"] ?? "UNSET"}, Risk=${c.releaseManifest.fields["Declared-Risk"] ?? "UNSET"}, Status=${c.releaseManifest.fields.Status ?? "UNSET"})`,
    `8. TASK-078 Security   : ${c.securityAssurance.ok ? "PASS" : "FAIL"} (independentReviewApproved=${String(c.securityAssurance.independentReviewApproved)}, trackedFindings=${c.securityAssurance.trackedFindingsCount})`,
    "------------------------------------------------------------------------",
    "External Provider, Legal & Live Staging Gates (Explicitly Unverified):",
  ];
  for (const gate of report.externalGates) {
    lines.push(`  - [${gate.id}] [${gate.status}] ${gate.name}`);
  }
  const allErrors = [
    ...c.taskCoverage.errors,
    ...c.migrations.errors,
    ...c.officialPlugins.errors,
    ...c.workflows.errors,
    ...c.wrangler.errors,
    ...c.uiProhibitions.errors,
    ...c.releaseManifest.errors,
    ...c.securityAssurance.errors,
  ];
  if (allErrors.length > 0) {
    lines.push("------------------------------------------------------------------------");
    lines.push("Failures:");
    for (const err of allErrors) {
      lines.push(`  * ${err}`);
    }
  }
  lines.push("========================================================================");
  return lines.join("\n");
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = runReleaseGate(args.rootDir);

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanSummary(report));
    console.log(JSON.stringify({ ok: report.ok, gate: report.gate, reportOut: args.reportOut }));
  }

  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
