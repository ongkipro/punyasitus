export interface M1ExternalGate {
  readonly id: string;
  readonly category: "provider" | "legal" | "launch" | "release_gate";
  readonly name: string;
  readonly status: string;
  readonly requiredBefore: string;
}

export interface M1TaskCoverageResult {
  readonly ok: boolean;
  readonly m1TotalCount: number;
  readonly m1PrecedingVerifiedCount: number;
  readonly m2ExcludedCount: number;
  readonly release11ExcludedCount: number;
  readonly unitSuiteCount: number;
  readonly integrationSuiteCount: number;
  readonly e2eScriptCount: number;
  readonly errors: readonly string[];
}

export interface M1MigrationScopeSummary {
  readonly count: number;
  readonly maxVersion: number;
  readonly statementsTotal: number;
  readonly files: readonly {
    readonly filename: string;
    readonly version: number;
    readonly statements: number;
    readonly checksum: string;
  }[];
}

export interface M1SqlMigrationsResult {
  readonly ok: boolean;
  readonly platform: M1MigrationScopeSummary;
  readonly tenant: M1MigrationScopeSummary;
  readonly errors: readonly string[];
}

export interface M1WranglerConfigResult {
  readonly ok: boolean;
  readonly workersDev?: boolean;
  readonly previewUrls?: boolean;
  readonly topologyChecksPassed?: number;
  readonly errors: readonly string[];
}

export interface M1WorkflowSecurityResult {
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly workflowFiles?: readonly string[];
  readonly actionsPinned: number;
  readonly errors: readonly string[];
}

export interface M1UiProhibitionsResult {
  readonly ok: boolean;
  readonly filesScanned: number;
  readonly errors: readonly string[];
}

export interface M1GateReport {
  readonly ok: boolean;
  readonly gate: "M1_PHASE_1_INTEGRATION_CHECKPOINT";
  readonly task: "TASK-063";
  readonly requirement: "REQ-041";
  readonly notProductionRelease: true;
  readonly decisionReference: "DEC-030";
  readonly generatedAt: string;
  readonly checks: {
    readonly taskCoverage: M1TaskCoverageResult;
    readonly migrations: M1SqlMigrationsResult;
    readonly wrangler: M1WranglerConfigResult;
    readonly workflows: M1WorkflowSecurityResult;
    readonly uiProhibitions: M1UiProhibitionsResult;
  };
  readonly externalGates: readonly M1ExternalGate[];
}

export const M1_WAVES: Readonly<Record<string, readonly string[]>>;
export const M1_EXPECTED_TASK_IDS: readonly string[];
export const M1_PRECEDING_TASK_IDS: readonly string[];
export const M2_EXCLUDED_TASK_IDS: readonly string[];
export const RELEASE_1_1_EXCLUDED_TASK_IDS: readonly string[];
export const UNVERIFIED_EXTERNAL_GATES: readonly M1ExternalGate[];

export function validateTaskPartition(
  m1Ids?: readonly string[],
  m2Ids?: readonly string[],
  r11Ids?: readonly string[],
): { readonly ok: boolean; readonly errors: readonly string[] };
export function verifyM1TaskCoverage(rootDir?: string): M1TaskCoverageResult;
export function verifySqlMigrations(
  rootDir?: string,
  options?: { enforceM1Ceiling?: boolean },
): M1SqlMigrationsResult;
export function verifyWranglerConfig(rootDir?: string): M1WranglerConfigResult;
export function verifyWorkflowSecurity(rootDir?: string): M1WorkflowSecurityResult;
export function verifyUiProhibitions(rootDir?: string): M1UiProhibitionsResult;
export function runM1Gate(rootDir?: string): M1GateReport;
