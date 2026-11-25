import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareInventories,
  enumerateAllSurfaces,
  INVENTORY_PATH,
  REPO_ROOT,
} from "../../scripts/security/enumerate-surfaces.mjs";

const ASVS_PATH = path.join(REPO_ROOT, "docs/security/asvs-5.0-l2-checklist.md");
const FINDINGS_PATH = path.join(REPO_ROOT, "docs/security/findings-register.md");
const ZAP_REPORT_PATH = path.join(REPO_ROOT, "docs/security/zap-scan-report.md");
const ZAP_RULES_PATH = path.join(REPO_ROOT, "scripts/security/zap-rules.tsv");
const SECURITY_WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/security.yml");

const VALID_ASVS_STATUSES = new Set([
  "VERIFIED_AUTOMATED",
  "VERIFIED_STATIC",
  "FINDING_REOPEN_REQUIRED",
  "ACCEPTED_RISK",
  "UNVERIFIED_STAGING_GATE",
  "NOT_APPLICABLE",
]);

const VALID_ZAP_RULE_LEVELS = new Set(["IGNORE", "INFO", "WARN", "FAIL"]);

const REQUIRED_ZAP_FAIL_RULES = [
  "10010",
  "10011",
  "10020",
  "10021",
  "10035",
  "10038",
  "10054",
  "10055",
  "40012",
  "40014",
  "40016",
  "40017",
  "40018",
  "90022",
] as const;

const REPO_FILE_PATH_RE =
  /`((?:apps|packages|docs|scripts|tests|infra|\.github)\/[A-Za-z0-9._\-/[\]]+\.(?:ts|tsx|js|mjs|cjs|astro|md|json|jsonc|yml|yaml|tsv|sql))(?::\d+(?:-\d+)?)?`/g;

function extractCitedRepoPaths(markdown: string): string[] {
  const paths = new Set<string>();
  for (const match of markdown.matchAll(REPO_FILE_PATH_RE)) {
    if (match[1]) paths.add(match[1]);
  }
  return [...paths].sort();
}

describe("TASK-078 Pre-Launch Security Assurance Contract & Evidence Verification", () => {
  it("maps every OWASP ASVS 5.0 Level 2 control group domain (V1..V17) with valid statuses and 100% existing file citations", () => {
    expect(fs.existsSync(ASVS_PATH)).toBe(true);
    const md = fs.readFileSync(ASVS_PATH, "utf8");

    expect(md).toContain("| Control Group |");
    for (let v = 1; v <= 17; v += 1) {
      expect(md).toMatch(new RegExp(`^## V${v}\\s+—`, "m"));
    }
    expect(md).toContain("`NOT_APPLICABLE`");
    // V13.2 ZAP CI baseline verified on live hosted GitHub Actions runner (run 45577200637)
    expect(md).toMatch(/\|\s*`V13\.2`[\s\S]*?\|\s*`VERIFIED_AUTOMATED`\s*\|/);
    // Post-hardening resolved controls (SEC-001..SEC-006) are VERIFIED_AUTOMATED
    for (const controlId of ["V1.5", "V3.2", "V3.3", "V3.4", "V5.3", "V6.4", "V16.3"]) {
      const escaped = controlId.replace(".", "\\.");
      expect(md).toMatch(new RegExp(`\\|\\s*\`${escaped}\`[^\\n]*\\|\\s*\`VERIFIED_AUTOMATED\`\\s*\\|`));
    }
    // V16 includes explicit error-handling control
    expect(md).toContain("`V16.4`");

    const statusRows = md
      .split("\n")
      .filter((line) => /^\| `V\d+\.\d+`/.test(line.trim()));
    expect(statusRows.length).toBeGreaterThanOrEqual(41);
    for (const row of statusRows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const rawStatus = (cells[cells.length - 1] ?? "").replace(/`/g, "");
      expect(
        VALID_ASVS_STATUSES.has(rawStatus),
        `Invalid ASVS status "${rawStatus}" in row: ${row}`,
      ).toBe(true);
    }

    // Every cited repo file path in ASVS checklist MUST exist on disk (no invented paths!)
    const citedPaths = extractCitedRepoPaths(md);
    expect(citedPaths.length).toBeGreaterThanOrEqual(35);
    const missing = citedPaths.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it("records verified real findings (M1-FU-03, M1-FU-07, TASK-086, SEC-003, SEC-006) & EXT-01..EXT-10 with real file citations", () => {
    expect(fs.existsSync(FINDINGS_PATH)).toBe(true);
    const md = fs.readFileSync(FINDINGS_PATH, "utf8");

    for (const requiredRef of [
      "SEC-001",
      "M1-FU-03",
      "SEC-002",
      "M1-FU-07",
      "SEC-003",
      "SEC-004",
      "TASK-086",
      "SEC-005",
      "SEC-006",
      "RESOLVED_VERIFIED",
      "CUSTOM-REFERRER-POLICY",
      "EXT-01",
      "EXT-10",
    ]) {
      expect(md).toContain(requiredRef);
    }
    expect(md).not.toContain("10035-ref");

    const citedPaths = extractCitedRepoPaths(md).filter(
      (p) => p !== "docs/api/openapi.json" && p !== "apps/web/dist/server/wrangler.json",
    );
    expect(citedPaths.length).toBeGreaterThanOrEqual(10);
    const missing = citedPaths.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it("records real executed built-Worker DAST output (0 alerts PASS) and separates UNVERIFIED_STAGING_GATE (EXT-10) in zap-scan-report.md", () => {
    expect(fs.existsSync(ZAP_REPORT_PATH)).toBe(true);
    const md = fs.readFileSync(ZAP_REPORT_PATH, "utf8");

    expect(md).toContain("UNVERIFIED_STAGING_GATE");
    expect(md).toContain("0 High, 0 Medium, 0 Low");
    expect(md).toContain("`PASS`");
    expect(md).toContain("EXT-10");
    expect(md).toContain("SEC-003");
    expect(md).toContain("SEC-006");
    expect(md).toContain("CUSTOM-REFERRER-POLICY");
    expect(md).not.toContain("10035-ref");
    expect(md).toContain("zaproxy/action-baseline");
    expect(md).toContain("Independent Reviewer");
  });

  it("enforces strict GitHub Actions security hardening and valid Host-routed ZAP CLI flags in .github/workflows/security.yml", () => {
    expect(fs.existsSync(SECURITY_WORKFLOW_PATH)).toBe(true);
    const yml = fs.readFileSync(SECURITY_WORKFLOW_PATH, "utf8");

    expect(yml).toMatch(/^permissions:\s*\{\s*\}/m);
    expect(yml).toContain("contents: read");
    expect(yml).toContain("persist-credentials: false");
    expect(yml).toContain("timeout-minutes:");
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("schedule:");
    expect(yml).toContain("workflow_dispatch:");
    expect(yml).toContain("scripts/security/zap-rules.tsv");
    expect(yml).toContain("fail_action: true");
    expect(yml).toContain("allow_issue_writing: false");
    expect(yml).not.toMatch(/\$\{\{\s*secrets\./);

    // Must NOT pass invalid `-l MEDIUM` / `-l HIGH` / `-l LOW` to zap-baseline.py (H1)
    expect(yml).not.toMatch(/-l\s+(?:HIGH|MEDIUM|LOW)\b/i);

    // Must inject Host: app.punyasitus.com via ZAP replacer targeting a rendered route (H2)
    expect(yml).toContain("http://127.0.0.1:8787/auth/login");
    expect(yml).toContain("replacer.full_list(0).replacement=app.punyasitus.com");

    // Must pass exact unit & integration test files to vitest (L4)
    expect(yml).toContain(
      "tests/task-078/unit.test.ts tests/security/cross-tenant-bola.unit.test.ts",
    );
    expect(yml).toContain(
      "tests/task-078/workerd.integration.test.ts tests/security/workerd.bola.integration.test.ts",
    );

    // Every `uses:` MUST be pinned to a real 40-char commit SHA
    const usesMatches = [...yml.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)];
    expect(usesMatches.length).toBeGreaterThanOrEqual(8);
    for (const m of usesMatches) {
      const ref = m[1] ?? "";
      expect(
        /^[^@]+@[0-9a-f]{40}$/.test(ref),
        `Workflow action "${ref}" MUST be pinned to a 40-char commit SHA`,
      ).toBe(true);
    }
    expect(
      usesMatches.some((m) => (m[1] ?? "").startsWith("zaproxy/action-baseline@")),
    ).toBe(true);
  });

  it("enforces explicit FAIL rules for High/Medium ZAP alerts and valid levels in scripts/security/zap-rules.tsv", () => {
    expect(fs.existsSync(ZAP_RULES_PATH)).toBe(true);
    const tsv = fs.readFileSync(ZAP_RULES_PATH, "utf8");
    const ruleLines = tsv
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(ruleLines.length).toBeGreaterThanOrEqual(REQUIRED_ZAP_FAIL_RULES.length);

    const parsedRules = new Map<string, string>();
    for (const line of ruleLines) {
      const [ruleId, action, rationale] = line.split("\t");
      expect(ruleId).toBeTruthy();
      expect(
        VALID_ZAP_RULE_LEVELS.has(action ?? ""),
        `Invalid ZAP rule action "${action}" for rule ${ruleId}`,
      ).toBe(true);
      expect((rationale ?? "").length).toBeGreaterThanOrEqual(20);
      parsedRules.set(ruleId!, action!);
    }

    for (const requiredFailRule of REQUIRED_ZAP_FAIL_RULES) {
      expect(
        parsedRules.get(requiredFailRule),
        `ZAP rule ${requiredFailRule} MUST be explicitly set to FAIL`,
      ).toBe("FAIL");
    }
  });

  it("maintains zero drift between scripts/security/enumerate-surfaces.mjs and docs/security/surface-inventory.json", () => {
    const actual = enumerateAllSurfaces();
    const recorded = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
    expect(compareInventories(actual, recorded)).toEqual([]);
    expect(actual.summary.mcpAllowedToolCount).toBe(16);
    expect(actual.summary.registeredPluginCount).toBe(5);
  });
});
