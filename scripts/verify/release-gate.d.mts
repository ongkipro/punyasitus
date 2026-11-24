import type {
  M1SqlMigrationsResult,
  M1UiProhibitionsResult,
  M1WorkflowSecurityResult,
  M1WranglerConfigResult,
} from "./m1-gate.mjs";

export interface ReleaseExternalGate {
  readonly id: string;
  readonly category: "provider" | "legal" | "launch" | "release_gate";
  readonly name: string;
  readonly status: string;
}

export interface FullTaskCoverageResult {
  readonly ok: boolean;
  readonly totalReleaseTasks: number;
  readonly m1Count: number;
  readonly m2Wave7Count: number;
  readonly m2Wave8Count: number;
  readonly deferredRelease11Ids: readonly string[];
  readonly verifiedTaskDirsCount: number;
  readonly unitSuiteCount: number;
  readonly integrationSuiteCount: number;
  readonly e2eScriptCount: number;
  readonly errors: readonly string[];
}

export interface FullSqlMigrationsResult extends M1SqlMigrationsResult {
  readonly platform: M1SqlMigrationsResult["platform"] & { readonly minVersion: number };
  readonly tenant: M1SqlMigrationsResult["tenant"] & { readonly minVersion: number };
}

export interface OfficialPluginsCheckResult {
  readonly ok: boolean;
  readonly registeredCount: number;
  readonly registeredPluginIds: readonly string[];
  readonly defaultActivePluginIds: readonly string[];
  readonly errors: readonly string[];
}

export interface WorkflowHardeningResult extends M1WorkflowSecurityResult {
  readonly jobsChecked: number;
}

export interface ReleaseManifestCheckResult {
  readonly ok: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

export interface SecurityAssuranceCheckResult {
  readonly ok: boolean;
  readonly present: Readonly<Record<string, boolean>>;
  readonly independentReviewApproved: boolean;
  readonly trackedFindingsCount: number;
  readonly errors: readonly string[];
}

export interface ReleaseGateReport {
  readonly ok: boolean;
  readonly gate: "FULL_PRODUCTION_RELEASE_GATE_STATIC";
  readonly task: "TASK-038";
  readonly milestone: "M2";
  readonly requirement: "REQ-041";
  readonly constraints: readonly string[];
  readonly decisionReference: "DEC-030";
  readonly generatedAt: string;
  readonly checks: {
    readonly taskCoverage: FullTaskCoverageResult;
    readonly migrations: FullSqlMigrationsResult;
    readonly officialPlugins: OfficialPluginsCheckResult;
    readonly workflows: WorkflowHardeningResult;
    readonly wrangler: M1WranglerConfigResult;
    readonly uiProhibitions: M1UiProhibitionsResult;
    readonly releaseManifest: ReleaseManifestCheckResult;
    readonly securityAssurance: SecurityAssuranceCheckResult;
  };
  readonly externalGates: readonly ReleaseExternalGate[];
}

export const M2_WAVE_7_TASK_IDS: readonly string[];
export const M2_WAVE_8_TASK_IDS: readonly string[];
export const RELEASE_WAVES: Readonly<Record<string, readonly string[]>>;
export const FULL_RELEASE_TASK_IDS: readonly string[];
export const EXPECTED_OFFICIAL_PLUGIN_IDS: readonly string[];
export const EXPECTED_OFFICIAL_PLUGIN_CONSTANTS: readonly string[];
export const EXPECTED_MIN_PLATFORM_MIGRATION_VERSION: number;
export const EXPECTED_MIN_TENANT_MIGRATION_VERSION: number;
export const RELEASE_EXTERNAL_GATES: readonly ReleaseExternalGate[];

export function verifyFullTaskCoverage(rootDir?: string): FullTaskCoverageResult;
export function verifyFullSqlMigrations(rootDir?: string): FullSqlMigrationsResult;
export function verifyOfficialPlugins(rootDir?: string): OfficialPluginsCheckResult;
export function verifyWorkflowHardening(rootDir?: string): WorkflowHardeningResult;
export function verifyFullUiProhibitions(rootDir?: string): M1UiProhibitionsResult;
export function verifyReleaseManifest(
  rootDir?: string,
  options?: { checkGitAncestry?: boolean },
): ReleaseManifestCheckResult;
export function verifySecurityAssuranceArtifacts(rootDir?: string): SecurityAssuranceCheckResult;
export function runReleaseGate(
  rootDir?: string,
  options?: { checkGitAncestry?: boolean },
): ReleaseGateReport;
