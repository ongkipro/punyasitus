import type {
  DeletionWarningStage,
  OffboardingRetentionTrack,
} from "@punyasitus/core/billing/index";
import type { TenantStatus } from "@punyasitus/core/schemas";

/**
 * Port interfaces and domain records for locked-tenant offboarding, resumable purge,
 * deletion warning tracking, and owner leads CSV export rate-limiting (REQ-069, DEC-022).
 */

export interface OffboardingR2BucketLike {
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(keys: string | string[]): Promise<void>;
}

export interface OffboardingCloudflareClientLike {
  deleteCustomHostname(customHostnameId: string): Promise<{
    readonly deleted: boolean;
    readonly alreadyAbsent: boolean;
  }>;
}

export interface OffboardingTenantStoreStubLike {
  /** Optional native DO purge RPC (`deleteAlarm()` + `deleteAll()`). */
  purgeAll?(protocol: number): Promise<{ readonly purged: boolean } | void>;
  deleteAlarm?(): Promise<void>;
  deleteAll?(): Promise<void>;
  query?(
    protocol: number,
    statement: { readonly sql: string; readonly args: readonly unknown[] },
    raw: boolean,
  ): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  batch?(
    protocol: number,
    statements: readonly { readonly sql: string; readonly args: readonly unknown[] }[],
  ): Promise<unknown>;
  schemaState?(protocol: number): Promise<{
    readonly appliedMigrations: readonly string[];
    readonly recovery: boolean;
  }>;
}

export interface OffboardingTenantStoreNamespaceLike {
  getByName(name: string, options?: { locationHint?: string }): OffboardingTenantStoreStubLike;
}

export interface OffboardingCandidateRow {
  readonly id: string;
  readonly organization_id: string;
  readonly agency_id: string | null;
  readonly handle: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly operator_hold_reason: string | null;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly deletion_due_at: number | null;
  readonly retention_paused_at: number | null;
  readonly offboarding_started_at: number | null;
  readonly created_at: number;
  readonly version: number;
  readonly payer_user_id: string | null;
  readonly payer_email: string | null;
  readonly payer_name: string | null;
}

export interface TenantOffboardingRunRecord {
  readonly tenantId: string;
  readonly status: "claimed" | "purged";
  readonly claimedAtMs: number;
  readonly deletionDueAtMs: number;
  readonly originalHandle: string;
  readonly hostnamesPurgedAtMs: number | null;
  readonly r2PurgedAtMs: number | null;
  readonly tenantStorePurgedAtMs: number | null;
  readonly membershipsPurgedAtMs: number | null;
  readonly residualsDeidentifiedAtMs: number | null;
  readonly tombstoneRecordedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly lastErrorCode: string | null;
  readonly attempts: number;
  readonly updatedAtMs: number;
}

export type OffboardingClaimBlockReason =
  | "not_found"
  | "terminal_state"
  | "already_claiming"
  | "operator_hold"
  | "active_paid"
  | "active_trial"
  | "no_deadline"
  | "before_deletion_due_at"
  | "unresolved_payment_attempt"
  | "review_required_obligation"
  | "concurrent_conflict";

export type ClaimTenantForOffboardingResult =
  | {
      readonly claimed: true;
      readonly tenantId: string;
      readonly originalHandle: string;
      readonly offboardingStartedAtMs: number;
      readonly deletionDueAtMs: number;
      readonly track: OffboardingRetentionTrack;
      readonly auditId: string;
    }
  | {
      readonly claimed: false;
      readonly tenantId: string;
      readonly reason: OffboardingClaimBlockReason;
      readonly deletionDueAtMs: number | null;
    };

export interface ExecuteTenantOffboardingPurgeInput {
  readonly platformDb: D1Database;
  readonly tenantId: string;
  readonly mediaBucket?: OffboardingR2BucketLike | null;
  readonly tenantStoreNamespace?: OffboardingTenantStoreNamespaceLike | null;
  readonly cloudflareClient?: OffboardingCloudflareClientLike | null;
  readonly nowMs?: number;
  readonly requestId?: string | null;
  readonly reason?: string;
}

export interface ExecuteTenantOffboardingPurgeResult {
  readonly outcome: "purged" | "already_purged" | "not_claimed";
  readonly tenantId: string;
  readonly originalHandle: string | null;
  readonly quarantineUntilMs: number | null;
  readonly customHostnamesDeleted: number;
  readonly hostsRowsRemoved: number;
  readonly r2ObjectsDeleted: number;
  readonly tenantStorePurged: boolean;
  readonly tenantStorePurgeMethod: "purgeAll" | "deleteAll" | "sql_wipe" | "skipped";
  readonly membershipsRemoved: number;
  readonly sessionsRevoked: number;
  readonly unsettledObligationsDeidentified: number;
  readonly tombstoneId: string | null;
  readonly stepsExecuted: readonly string[];
  readonly stepsResumedFromCheckpoint: readonly string[];
}

export type OffboardingWarningOutcome =
  | "claimed"
  | "submitted"
  | "suppressed_catchup"
  | "skipped"
  | "failed"
  | "unknown";

export interface RecordedOffboardingWarning {
  readonly id: string;
  readonly tenantId: string;
  readonly stage: DeletionWarningStage;
  readonly deletionDueAtMs: number;
  readonly outcome: OffboardingWarningOutcome;
  readonly errorCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LeadsExportRateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly resetAtMs: number;
}
