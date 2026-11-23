#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  computeMigrationChecksum,
  splitMigrationStatements,
} from "../../packages/db/src/connections/sql-splitter.ts";
import { stripJsoncComments, validateTopologyConfig } from "./routes.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Exact Phase 1 (M1) scope across Wave 0 through Wave 6 (85 tasks total; DEC-030, TASKS.md).
 * Strictly excludes M2 Wave 7/8 tasks and Release 1.1 TASK-062.
 */
export const M1_WAVES = Object.freeze({
  wave0: ["TASK-023"],
  wave1: ["TASK-001", "TASK-010", "TASK-011", "TASK-024", "TASK-032"],
  wave2: [
    "TASK-002",
    "TASK-025",
    "TASK-028",
    "TASK-029",
    "TASK-030",
    "TASK-031",
    "TASK-037",
    "TASK-045",
    "TASK-049",
    "TASK-067",
    "TASK-077",
    "TASK-090",
  ],
  wave3: [
    "TASK-004",
    "TASK-005",
    "TASK-006",
    "TASK-007",
    "TASK-008",
    "TASK-009",
    "TASK-012",
    "TASK-013",
    "TASK-014",
    "TASK-015",
    "TASK-016",
    "TASK-017",
    "TASK-027",
    "TASK-050",
    "TASK-051",
    "TASK-089",
  ],
  wave4: [
    "TASK-003",
    "TASK-026",
    "TASK-048",
    "TASK-055",
    "TASK-056",
    "TASK-057",
    "TASK-058",
    "TASK-059",
    "TASK-081",
    "TASK-082",
    "TASK-095",
  ],
  wave5: [
    "TASK-018",
    "TASK-021",
    "TASK-022",
    "TASK-033",
    "TASK-034",
    "TASK-036",
    "TASK-039",
    "TASK-040",
    "TASK-041",
    "TASK-042",
    "TASK-043",
    "TASK-044",
    "TASK-046",
    "TASK-047",
    "TASK-052",
    "TASK-053",
    "TASK-054",
    "TASK-060",
    "TASK-061",
    "TASK-065",
    "TASK-068",
    "TASK-069",
    "TASK-070",
    "TASK-076",
    "TASK-080",
    "TASK-087",
    "TASK-088",
    "TASK-091",
    "TASK-092",
    "TASK-093",
    "TASK-094",
    "TASK-096",
    "TASK-097",
    "TASK-102",
    "TASK-103",
    "TASK-104",
    "TASK-106",
    "TASK-107",
    "TASK-108",
  ],
  wave6: ["TASK-063"],
});

export const M1_EXPECTED_TASK_IDS = Object.freeze(
  Object.values(M1_WAVES)
    .flat()
    .sort(),
);

export const M1_PRECEDING_TASK_IDS = Object.freeze(
  M1_EXPECTED_TASK_IDS.filter((id) => id !== "TASK-063"),
);

export const M2_EXCLUDED_TASK_IDS = Object.freeze([
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
]);

export const RELEASE_1_1_EXCLUDED_TASK_IDS = Object.freeze(["TASK-062"]);

export const UNVERIFIED_EXTERNAL_GATES = Object.freeze([
  {
    id: "gate-cf-saas-staging",
    category: "provider",
    name: "Cloudflare Workers Paid / SaaS staging zone, HTTP DCV pass-through & O2O",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "Live staging / TASK-038",
  },
  {
    id: "gate-trust-positif",
    category: "provider",
    name: "Trust+ / Komdigi static-IP domain reputation check on staging/production SaaS zones",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "Live staging / TASK-038",
  },
  {
    id: "gate-google-oauth",
    category: "provider",
    name: "Google OAuth production/staging client credentials & verified redirect URIs",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "Live staging / TASK-038",
  },
  {
    id: "gate-cf-email-service",
    category: "provider",
    name: "Cloudflare Email Sending (Beta) DNS onboarding & inbox deliverability on notif.punyasitus.com",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "Live staging / TASK-038",
  },
  {
    id: "gate-autolaris-live",
    category: "provider",
    name: "AutoLaris merchant approval, static-IP relay host & live Advice reconciliation",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "Live staging / TASK-038",
  },
  {
    id: "gate-legal-uu-pdp",
    category: "legal",
    name: "Bahasa Indonesia Terms & Privacy legal review (UU 27/2022 UU PDP)",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "TASK-038 / Production Launch",
  },
  {
    id: "gate-legal-pse-komdigi",
    category: "legal",
    name: "PSE Lingkup Privat registration, UU KUP Art. 28(11), & Kepmen Komdigi 127/128 compliance text",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "TASK-038 / Production Launch",
  },
  {
    id: "gate-webmaster-gsc-bing",
    category: "launch",
    name: "Manual Google Search Console & Bing Webmaster live verification",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "TASK-038 / Production Launch",
  },
  {
    id: "gate-task-038-full-lab",
    category: "release_gate",
    name: "Full multi-browser (Firefox/WebKit) matrix, 5-run mobile lab & isolated backup restore rehearsal",
    status: "UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION",
    requiredBefore: "TASK-038 (Full Production Release Gate)",
  },
]);

const SHA40_USES_RE = /^[^@\s]+@[0-9a-f]{40}$/;
const DESTRUCTIVE_SQL_RE = /\bDROP\s+(?:TABLE|COLUMN)\b/i;
const HEX16_RE = /^[0-9a-f]{16}$/;
const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

const SECRET_VALUE_PATTERNS = [
  { name: "turnstile-live-key", re: /\b0x4[A-Za-z0-9_-]{16,}\b/ },
  { name: "private-key-pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "resend-api-key", re: /\bre_[A-Za-z0-9_]{16,}\b/ },
  { name: "stripe-live-key", re: /\b(?:sk|pk)_live_[A-Za-z0-9]{12,}\b/ },
  { name: "cloudflare-bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  { name: "github-pat", re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "google-client-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/ },
  {
    name: "inline-secret-assignment",
    re: /["']?(?:CLOUDFLARE_API_TOKEN|AUTH_SECRET|CONSOLE_AUTH_SECRET|AUTOLARIS_API_KEY|RESEND_API_KEY)["']?\s*[:=]\s*["'][^"']{8,}["']/,
  },
];

const UI_CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const RADIX_IMPORT_RE =
  /(?:from\s+["'](?:@radix-ui\/[^"']+|radix-ui)["']|import\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\)|require\s*\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']\s*\))/;
const AS_CHILD_RE = /\basChild(?:\s*=|\s*\?|\s*:|\s*,|\s*\}|\s*\)|\s*\/?>|\s+(?=[a-zA-Z0-9_$-]))/;
const SPARKLES_RE = /\bSparkles(?:Icon)?\b/;

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

export function validateTaskPartition(
  m1Ids = M1_EXPECTED_TASK_IDS,
  m2Ids = M2_EXCLUDED_TASK_IDS,
  r11Ids = RELEASE_1_1_EXCLUDED_TASK_IDS,
) {
  const errors = [];
  const m1Set = new Set(m1Ids);
  const m2Set = new Set(m2Ids);
  const r11Set = new Set(r11Ids);

  for (const id of m1Set) {
    if (m2Set.has(id) || r11Set.has(id)) {
      errors.push(`Scope overlap detected for ${id}`);
    }
  }
  for (const id of m2Set) {
    if (r11Set.has(id)) {
      errors.push(`Scope overlap detected between M2 and Release 1.1 for ${id}`);
    }
  }
  if (m1Set.size !== 85) {
    errors.push(`Expected exactly 85 M1 tasks, got ${m1Set.size}`);
  }
  if (m1Set.size + m2Set.size + r11Set.size !== 110) {
    errors.push(
      `Expected 110 total roadmap tasks (85 M1 + 24 M2 + 1 Release 1.1), got ${
        m1Set.size + m2Set.size + r11Set.size
      }`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export function verifyM1TaskCoverage(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const tasksMdPath = path.join(rootDir, "TASKS.md");
  const m1Set = new Set(M1_EXPECTED_TASK_IDS);
  const m2Set = new Set(M2_EXCLUDED_TASK_IDS);
  const r11Set = new Set(RELEASE_1_1_EXCLUDED_TASK_IDS);

  // 1. Disjoint partition invariant across TASK-001..TASK-110
  const partition = validateTaskPartition(
    M1_EXPECTED_TASK_IDS,
    M2_EXCLUDED_TASK_IDS,
    RELEASE_1_1_EXCLUDED_TASK_IDS,
  );
  errors.push(...partition.errors);

  // 2. Cross-check against TASKS.md milestones if present
  if (fs.existsSync(tasksMdPath)) {
    const tasksText = fs.readFileSync(tasksMdPath, "utf8");
    const taskBlockRe = /###\s+(TASK-\d{3}):[^\n]*\n-\s+\*\*Requirement:\*\*\s+([^\n]+)/g;
    const parsedM1 = new Set();
    const parsedM2 = new Set();
    const parsedR11 = new Set();
    for (const match of tasksText.matchAll(taskBlockRe)) {
      const taskId = match[1];
      const meta = match[2];
      if (meta.includes("· M1 ·")) parsedM1.add(taskId);
      else if (meta.includes("· M2 ·")) parsedM2.add(taskId);
      else if (meta.includes("Release 1.1")) parsedR11.add(taskId);
    }
    for (const id of parsedM1) {
      if (!m1Set.has(id)) errors.push(`TASKS.md marks ${id} as M1, but it is missing from M1_EXPECTED_TASK_IDS`);
    }
    for (const id of m1Set) {
      if (!parsedM1.has(id)) errors.push(`${id} is in M1_EXPECTED_TASK_IDS, but TASKS.md does not mark it M1`);
    }
    for (const id of parsedM2) {
      if (!m2Set.has(id)) errors.push(`TASKS.md marks ${id} as M2, but it is missing from M2_EXCLUDED_TASK_IDS`);
    }
    for (const id of parsedR11) {
      if (!r11Set.has(id)) errors.push(`TASKS.md marks ${id} as Release 1.1, but it is missing from RELEASE_1_1_EXCLUDED_TASK_IDS`);
    }
  } else {
    errors.push(`Missing ${tasksMdPath}`);
  }

  // 3. Verify all 84 preceding M1 task test suites exist and are wired into vitest / e2e
  const testsRoot = path.join(rootDir, "tests");
  const missingTaskDirs = [];
  const unwiredTasks = [];
  let unitSuiteCount = 0;
  let integrationSuiteCount = 0;
  let e2eScriptCount = 0;

  for (const taskId of M1_PRECEDING_TASK_IDS) {
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

  // Also check TASK-063 directory itself (warn/fail if missing when checking full M1)
  const task063Dir = path.join(testsRoot, "task-063");
  const hasTask063 =
    fs.existsSync(task063Dir) &&
    fs.existsSync(path.join(task063Dir, "unit.test.ts")) &&
    fs.existsSync(path.join(task063Dir, "workerd.integration.test.ts")) &&
    fs.existsSync(path.join(task063Dir, "e2e.mjs"));
  if (!hasTask063) {
    errors.push(
      "tests/task-063/ must contain unit.test.ts, workerd.integration.test.ts, and e2e.mjs",
    );
  } else {
    unitSuiteCount += 1;
    integrationSuiteCount += 1;
    e2eScriptCount += 1;
  }

  if (missingTaskDirs.length > 0) {
    errors.push(`Missing test directories for M1 tasks: ${missingTaskDirs.join(", ")}`);
  }
  if (unwiredTasks.length > 0) {
    errors.push(
      `M1 task directories with no vitest/e2e test files: ${unwiredTasks.join(", ")}`,
    );
  }

  // Verify vitest config globs cover tests/**/unit.test.ts and tests/**/workerd.integration.test.ts
  const unitCfgPath = path.join(testsRoot, "setup/vitest.unit.config.ts");
  const intCfgPath = path.join(testsRoot, "setup/vitest.integration.config.ts");
  if (!fs.existsSync(unitCfgPath) || !fs.readFileSync(unitCfgPath, "utf8").includes("tests/**/unit.test.ts")) {
    errors.push("tests/setup/vitest.unit.config.ts must include tests/**/unit.test.ts");
  }
  if (
    !fs.existsSync(intCfgPath) ||
    !fs.readFileSync(intCfgPath, "utf8").includes("tests/**/workerd.integration.test.ts")
  ) {
    errors.push(
      "tests/setup/vitest.integration.config.ts must include tests/**/workerd.integration.test.ts",
    );
  }

  return {
    ok: errors.length === 0,
    m1TotalCount: M1_EXPECTED_TASK_IDS.length,
    m1PrecedingVerifiedCount: M1_PRECEDING_TASK_IDS.length - missingTaskDirs.length,
    m2ExcludedCount: M2_EXCLUDED_TASK_IDS.length,
    release11ExcludedCount: RELEASE_1_1_EXCLUDED_TASK_IDS.length,
    unitSuiteCount,
    integrationSuiteCount,
    e2eScriptCount,
    errors,
  };
}

export function verifySqlMigrations(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const summary = {
    platform: { count: 0, maxVersion: 0, statementsTotal: 0, files: [] },
    tenant: { count: 0, maxVersion: 0, statementsTotal: 0, files: [] },
  };

  const scopes = [
    {
      key: "platform",
      dir: path.join(rootDir, "packages/db/migrations/platform"),
      maxExpectedM1Version: 27,
    },
    {
      key: "tenant",
      dir: path.join(rootDir, "packages/db/migrations/tenant"),
      maxExpectedM1Version: 21,
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
      if (version > maxVersion) maxVersion = version;

      if (version > scope.maxExpectedM1Version) {
        errors.push(
          `${scope.key}/${filename} exceeds M1 migration ceiling (${scope.maxExpectedM1Version})`,
        );
      }

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
        if (DESTRUCTIVE_SQL_RE.test(stmt)) {
          errors.push(
            `Destructive DROP TABLE / DROP COLUMN statement forbidden in ${scope.key}/${filename}: ${stmt.slice(0, 100)}`,
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

    summary[scope.key].count = entries.length;
    summary[scope.key].maxVersion = maxVersion;
  }

  return {
    ok: errors.length === 0,
    ...summary,
    errors,
  };
}

export function verifyWranglerConfig(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const wranglerPath = path.join(rootDir, "apps/web/wrangler.jsonc");
  if (!fs.existsSync(wranglerPath)) {
    return { ok: false, checksPassed: 0, errors: [`Missing ${wranglerPath}`] };
  }

  const rawText = fs.readFileSync(wranglerPath, "utf8");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.re.test(rawText)) {
      errors.push(`Leaked secret pattern (${pattern.name}) found in apps/web/wrangler.jsonc`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsoncComments(rawText));
  } catch (err) {
    errors.push(
      `Failed to parse apps/web/wrangler.jsonc: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, checksPassed: 0, errors };
  }

  if (parsed.workers_dev !== false) {
    errors.push(`apps/web/wrangler.jsonc must set workers_dev: false (got ${JSON.stringify(parsed.workers_dev)})`);
  }
  if (parsed.preview_urls !== false) {
    errors.push(
      `apps/web/wrangler.jsonc must set preview_urls: false (got ${JSON.stringify(parsed.preview_urls)})`,
    );
  }

  const topologyResult = validateTopologyConfig(rootDir);
  if (!topologyResult.ok) {
    errors.push(...topologyResult.errors);
  }

  return {
    ok: errors.length === 0,
    workersDev: parsed.workers_dev,
    previewUrls: parsed.preview_urls,
    topologyChecksPassed: topologyResult.checksPassed,
    errors,
  };
}

export function verifyWorkflowSecurity(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const workflowsDir = path.join(rootDir, ".github/workflows");
  if (!fs.existsSync(workflowsDir)) {
    return { ok: false, filesChecked: 0, actionsPinned: 0, errors: ["Missing .github/workflows/"] };
  }

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  if (files.length === 0) {
    return { ok: false, filesChecked: 0, actionsPinned: 0, errors: ["No workflow YAML files found"] };
  }

  let actionsPinned = 0;

  for (const file of files) {
    const rel = `.github/workflows/${file}`;
    const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
    const lines = text.split(/\r?\n/);

    // 1. Workflow-level minimal permissions: must declare top-level `permissions: {}`
    const hasTopEmptyPerms = /^permissions:\s*\{\s*\}\s*$/m.test(text);
    if (!hasTopEmptyPerms) {
      errors.push(`${rel}: missing top-level "permissions: {}"`);
    }

    // 2. Require EVERY job under `jobs:` to declare its own `permissions:` with `contents: read`
    const jobBlocks = [];
    let inJobsSection = false;
    let currentJob = null;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        if (currentJob) currentJob.lines.push(line);
        continue;
      }
      if (/^jobs:\s*(?:#.*)?$/.test(line)) {
        inJobsSection = true;
        currentJob = null;
        continue;
      }
      if (inJobsSection && /^[^\s]/.test(line)) {
        inJobsSection = false;
        currentJob = null;
        continue;
      }
      if (inJobsSection) {
        const jobMatch = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
        if (jobMatch) {
          currentJob = { name: jobMatch[1], lineNumber: idx + 1, lines: [] };
          jobBlocks.push(currentJob);
        } else if (currentJob) {
          currentJob.lines.push(line);
        }
      }
    }

    if (jobBlocks.length === 0) {
      errors.push(`${rel}: no jobs found under "jobs:"`);
    }
    for (const job of jobBlocks) {
      const jobText = job.lines.join("\n");
      const hasJobPermissions = /^    permissions:\s*(?:\{[^}]*contents:\s*read[^}]*\}|\r?$)/m.test(jobText);
      const hasJobContentsRead =
        /^    permissions:\s*\{[^}]*contents:\s*read[^}]*\}/m.test(jobText) ||
        (hasJobPermissions && /^      contents:\s*read\s*$/m.test(jobText));
      if (!hasJobContentsRead) {
        errors.push(
          `${rel}:${job.lineNumber}: job "${job.name}" must declare its own permissions with "contents: read"`,
        );
      }
    }

    // 3. Disallow elevated write permissions in CI workflows
    for (const forbiddenPerm of [
      "write-all",
      "id-token: write",
      "contents: write",
      "deployments: write",
      "packages: write",
      "actions: write",
      "security-events: write",
    ]) {
      if (text.includes(forbiddenPerm)) {
        errors.push(`${rel}: forbidden elevated permission "${forbiddenPerm}" in non-deploy CI workflow`);
      }
    }

    // 4. Forbid ALL secrets references (`${{ secrets.* }}`, `toJSON(secrets)`, `secrets['X']`, `secrets: inherit`)
    const nonCommentLines = lines.filter((l) => !l.trim().startsWith("#"));
    const nonCommentJoined = nonCommentLines.join("\n");
    const secretExprChecks = [
      { label: "${{ ... secrets ... }}", re: /\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gi },
      { label: "secrets property/index access", re: /\bsecrets\s*[.[]/gi },
      { label: "secrets: inherit", re: /^\s*secrets\s*:\s*inherit\b/gim },
    ];
    for (const check of secretExprChecks) {
      const matches = nonCommentJoined.match(check.re);
      if (matches && matches.length > 0) {
        errors.push(
          `${rel}: forbidden secrets reference (${check.label}: ${matches.join(", ")}) in non-deploy CI workflow`,
        );
      }
    }

    // 5. Check external `uses:` SHA pinning + `persist-credentials: false` on every actions/checkout
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;

      const usesMatch = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/.exec(line);
      if (usesMatch) {
        const ref = (usesMatch[1] || "").replace(/^["']|["']$/g, "");
        if (!ref.startsWith("./")) {
          if (!SHA40_USES_RE.test(ref)) {
            errors.push(`${rel}:${idx + 1}: unpinned external action "${ref}" (must pin 40-char commit SHA)`);
          } else {
            actionsPinned += 1;
          }
        }

        if (ref.startsWith("actions/checkout@")) {
          const stepIndent = line.search(/\S/);
          let hasPersistFalse = false;
          for (let j = idx + 1; j < lines.length; j += 1) {
            const nextLine = lines[j];
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed === "" || nextTrimmed.startsWith("#")) continue;
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent < stepIndent || /^\s*-\s+/.test(nextLine)) {
              break;
            }
            if (/^\s*persist-credentials:\s*false\b/.test(nextLine)) {
              hasPersistFalse = true;
              break;
            }
          }
          if (!hasPersistFalse) {
            errors.push(
              `${rel}:${idx + 1}: actions/checkout step must set "persist-credentials: false"`,
            );
          }
        }
      }
    }

    // 6. Multi-line-aware check for live deploy / remote DB commands in `run:` blocks.
    // lazy: regex static guard over shell run blocks after collapsing `\\\n` continuations;
    // upgrade to a YAML + shell AST analyzer (actionlint/zizmor) if workflows add dynamic shell eval.
    const normalizedCommands = nonCommentJoined.replace(/\\[ \t]*\r?\n[ \t]*/g, " ");

    const commandLines = normalizedCommands.split(/\r?\n/);
    for (let idx = 0; idx < commandLines.length; idx += 1) {
      const cmd = commandLines[idx];
      if (
        /\bwrangler\s+(?:--?[A-Za-z0-9-]+(?:=\S+|\s+\S+)?\s+)*deploy\b/.test(cmd) &&
        !/--dry-run\b/.test(cmd)
      ) {
        errors.push(`${rel}: live "wrangler deploy" without --dry-run is forbidden in CI`);
      }
      if (/\bwrangler\s+(?:--?[A-Za-z0-9-]+(?:=\S+|\s+\S+)?\s+)*versions\s+deploy\b/.test(cmd)) {
        errors.push(`${rel}: live "wrangler versions deploy" is forbidden in CI`);
      }
      if (/\bwrangler\s+d1\s+migrations\s+apply\b/.test(cmd) && /--remote\b/.test(cmd)) {
        errors.push(`${rel}: remote D1 migration is forbidden in CI`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    filesChecked: files.length,
    workflowFiles: files,
    actionsPinned,
    errors,
  };
}

export function verifyUiProhibitions(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const webSrcDir = path.join(rootDir, "apps/web/src");
  const files = walkFiles(webSrcDir, (_full, name) => UI_CODE_EXTS.has(path.extname(name)));

  for (const file of files) {
    const rel = path.relative(rootDir, file);
    const content = fs.readFileSync(file, "utf8");
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

export function runM1Gate(rootDir = DEFAULT_ROOT) {
  const taskCoverage = verifyM1TaskCoverage(rootDir);
  const migrations = verifySqlMigrations(rootDir);
  const wrangler = verifyWranglerConfig(rootDir);
  const workflows = verifyWorkflowSecurity(rootDir);
  const uiProhibitions = verifyUiProhibitions(rootDir);

  const ok =
    taskCoverage.ok &&
    migrations.ok &&
    wrangler.ok &&
    workflows.ok &&
    uiProhibitions.ok;

  return {
    ok,
    gate: "M1_PHASE_1_INTEGRATION_CHECKPOINT",
    task: "TASK-063",
    requirement: "REQ-041",
    notProductionRelease: true,
    decisionReference: "DEC-030",
    generatedAt: new Date().toISOString(),
    checks: {
      taskCoverage,
      migrations,
      wrangler,
      workflows,
      uiProhibitions,
    },
    externalGates: UNVERIFIED_EXTERNAL_GATES,
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
      console.log("Usage: node scripts/verify/m1-gate.mjs [--json] [--report-out <path>] [--root <dir>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function formatHumanSummary(report) {
  const lines = [
    "========================================================================",
    "PunyaSitus — Phase 1 Integration Checkpoint (M1 Gate / TASK-063)",
    "Status: " + (report.ok ? "PASS (Local/CI M1 Gate)" : "FAIL"),
    "Release Boundary (DEC-030): NOT A PRODUCTION RELEASE",
    "========================================================================",
    `1. M1 Task Scope & Suites : ${report.checks.taskCoverage.ok ? "PASS" : "FAIL"} (${report.checks.taskCoverage.m1TotalCount} M1 tasks verified; ${report.checks.taskCoverage.m2ExcludedCount} M2 + ${report.checks.taskCoverage.release11ExcludedCount} Release 1.1 explicitly excluded; ${report.checks.taskCoverage.unitSuiteCount} unit / ${report.checks.taskCoverage.integrationSuiteCount} integration / ${report.checks.taskCoverage.e2eScriptCount} e2e)`,
    `2. SQL Migrations         : ${report.checks.migrations.ok ? "PASS" : "FAIL"} (platform: ${report.checks.migrations.platform.count} files <= v${report.checks.migrations.platform.maxVersion}, ${report.checks.migrations.platform.statementsTotal} stmts; tenant: ${report.checks.migrations.tenant.count} files <= v${report.checks.migrations.tenant.maxVersion}, ${report.checks.migrations.tenant.statementsTotal} stmts; 0 destructive drops)`,
    `3. Wrangler & Topology    : ${report.checks.wrangler.ok ? "PASS" : "FAIL"} (workers_dev=${String(report.checks.wrangler.workersDev)}, preview_urls=${String(report.checks.wrangler.previewUrls)}, topologyChecks=${report.checks.wrangler.topologyChecksPassed})`,
    `4. GitHub Actions CI      : ${report.checks.workflows.ok ? "PASS" : "FAIL"} (${report.checks.workflows.filesChecked} workflows, ${report.checks.workflows.actionsPinned} SHA-pinned actions, minimal permissions)`,
    `5. UI Guardrails          : ${report.checks.uiProhibitions.ok ? "PASS" : "FAIL"} (${report.checks.uiProhibitions.filesScanned} files scanned; 0 @radix-ui, 0 asChild, 0 Sparkles)`,
    "------------------------------------------------------------------------",
    "External Provider, Legal & Launch Gates (Explicitly Unverified in M1):",
  ];

  for (const gate of report.externalGates) {
    lines.push(`  - [${gate.status}] ${gate.name} (${gate.requiredBefore})`);
  }

  const allErrors = [
    ...report.checks.taskCoverage.errors,
    ...report.checks.migrations.errors,
    ...report.checks.wrangler.errors,
    ...report.checks.workflows.errors,
    ...report.checks.uiProhibitions.errors,
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
  const report = runM1Gate(args.rootDir);

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
