export interface BackupRestoreDrillResult {
  readonly ok: boolean;
  readonly gate: "ISOLATED_BACKUP_RESTORE_AND_DEC022_TOMBSTONE_DRILL";
  readonly task: "TASK-038";
  readonly requirement: "REQ-042";
  readonly decisionReference: "DEC-022";
  readonly executedAt: string;
  readonly rtoMs: number;
  readonly rtoBudgetMs: number;
  readonly withinRtoBudget: boolean;
  readonly checksums: {
    readonly archiveManifestSha256: string;
    readonly platformSnapshotSha256: string;
    readonly activeTenantStoreSha256: string;
    readonly activeTenantChecksumMatched: boolean;
    readonly activeMediaShaMatched: boolean;
  };
  readonly platformRestore: {
    readonly tablesRestored: number;
    readonly rowsRestored: number;
    readonly rowCountsMatched: boolean;
    readonly activeBookmarkVerified: boolean;
  };
  readonly activeTenantVerification: {
    readonly tenantId: string;
    readonly status: string | null;
    readonly records: Readonly<Record<string, number>>;
    readonly mediaVerified: boolean;
  };
  readonly tombstoneReplayVerification: {
    readonly tombstonedTenantId: string;
    readonly wouldHaveResurrectedWithoutReplay: boolean;
    readonly tombstonesReplayedCount: number;
    readonly statusAfterReplay: string | null;
    readonly activeHostsAfterReplay: number;
    readonly r2ObjectsRemaining: number;
    readonly tenantStoreRemoved: boolean;
    readonly resurrectionPrevented: boolean;
  };
}

export interface VerifyRollbackPlanResult {
  readonly ok: boolean;
  readonly mode: "verify-rollback-plan";
  readonly nonDestructive: true;
  readonly verifiedAt: string;
  readonly errors: readonly string[];
  readonly drill: BackupRestoreDrillResult;
}

export function runBackupRestoreDrill(options?: {
  rootDir?: string;
  simulateTamperedChecksum?: boolean;
  simulateTamperedTenantSnapshot?: boolean;
  simulateTamperedManifest?: boolean;
  nowMs?: number;
}): BackupRestoreDrillResult;

export function verifyRollbackPlan(rootDir?: string): VerifyRollbackPlanResult;
