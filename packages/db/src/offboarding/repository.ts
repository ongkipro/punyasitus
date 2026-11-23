import {
  DAY_MS,
  HANDLE_QUARANTINE_WINDOW_MS,
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
  computeAuthoritativeDeletionDueAt,
  evaluateOffboardingClaimEligibility,
  generateBillingUlid,
  type DeletionWarningStage,
} from "@punyasitus/core/billing/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import { buildPlatformAuditStatement } from "../platform/audit.ts";
import { isTenantScopedR2Key } from "../privacy/retention.ts";
import { recordDeletionTombstone, replayDeletionTombstones } from "../privacy/tombstones.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";
import type {
  ClaimTenantForOffboardingResult,
  ExecuteTenantOffboardingPurgeInput,
  ExecuteTenantOffboardingPurgeResult,
  LeadsExportRateLimitResult,
  OffboardingCandidateRow,
  OffboardingCloudflareClientLike,
  OffboardingR2BucketLike,
  OffboardingTenantStoreNamespaceLike,
  OffboardingTenantStoreStubLike,
  OffboardingWarningOutcome,
  RecordedOffboardingWarning,
  TenantOffboardingRunRecord,
} from "./types.ts";

/**
 * Atomic locked-tenant offboarding claim, resumable idempotent purge, warning ledger,
 * tombstone replay, and leads CSV export rate-limiter (REQ-069, PLAN §17.3, DEC-022).
 *
 * Hard invariants:
 * - ZERO runtime DDL (schema statements live strictly in
 *   `packages/db/migrations/platform/0017_tenant_offboarding.sql`).
 * - Offboarding ALWAYS claims the entitlement lock (`status = 'purging'`, `offboarding_started_at`)
 *   atomically in D1 BEFORE any external side effect (Cloudflare, R2, TenantStore).
 * - Operator holds (`operator_hold = 1` / `retention_paused_at IS NOT NULL`) and unresolved
 *   payment attempts (`creating`, `creation_unknown`, `pending`, `review`) BLOCK claim atomically.
 * - Billing, payment, receipt, audit, and tombstone rows ALWAYS survive tenant purge; unsettled
 *   obligations are converted to de-identified residual records.
 * - Released handles stay quarantined in `deletion_tombstones` for 30 days while the residual
 *   `tenants` row is renamed to a de-identified sentinel so the handle unlocks cleanly at day 30.
 */

const R2_DELETE_BATCH_SIZE = 1000;
const TENANT_STORE_PROTOCOL = 1;
const WARNING_LEAD_WINDOW_MS = 7 * DAY_MS;

const IN_MEMORY_EXPORT_RATE_LIMITS = new Map<string, { count: number; expiresAtMs: number }>();

function isCloudflareNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const rec = err as {
      readonly status?: unknown;
      readonly statusCode?: unknown;
      readonly kind?: unknown;
      readonly code?: unknown;
    };
    if (rec.status === 404 || rec.statusCode === 404) return true;
    if (rec.kind === "not_found" || rec.code === "CF_NOT_FOUND" || rec.code === "NOT_FOUND") {
      return true;
    }
  }
  if (err instanceof Error) {
    return /\b404\b|not[_ ]?found/i.test(err.message);
  }
  return false;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

async function hasTableSafe(db: D1Database, tableName: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(tableName)
    .first<{ readonly name: string }>();
  return Boolean(row);
}

async function hasColumnSafe(
  db: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const info = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{ readonly name: string }>();
  return (info.results ?? []).some((col) => col.name === columnName);
}

interface RawOffboardingRunRow {
  readonly tenant_id: string;
  readonly status: "claimed" | "purged";
  readonly claimed_at: number;
  readonly deletion_due_at: number;
  readonly original_handle: string;
  readonly hostnames_purged_at: number | null;
  readonly r2_purged_at: number | null;
  readonly tenant_store_purged_at: number | null;
  readonly memberships_purged_at: number | null;
  readonly residuals_deidentified_at: number | null;
  readonly tombstone_recorded_at: number | null;
  readonly completed_at: number | null;
  readonly last_error_code: string | null;
  readonly attempts: number;
  readonly updated_at: number;
}

function mapOffboardingRunRow(row: RawOffboardingRunRow): TenantOffboardingRunRecord {
  return {
    tenantId: row.tenant_id,
    status: row.status,
    claimedAtMs: row.claimed_at,
    deletionDueAtMs: row.deletion_due_at,
    originalHandle: row.original_handle,
    hostnamesPurgedAtMs: row.hostnames_purged_at,
    r2PurgedAtMs: row.r2_purged_at,
    tenantStorePurgedAtMs: row.tenant_store_purged_at,
    membershipsPurgedAtMs: row.memberships_purged_at,
    residualsDeidentifiedAtMs: row.residuals_deidentified_at,
    tombstoneRecordedAtMs: row.tombstone_recorded_at,
    completedAtMs: row.completed_at,
    lastErrorCode: row.last_error_code,
    attempts: row.attempts,
    updatedAtMs: row.updated_at,
  };
}

export async function getTenantOffboardingRun(
  db: D1Database,
  tenantId: string,
): Promise<TenantOffboardingRunRecord | null> {
  if (!(await hasTableSafe(db, "tenant_offboarding_runs"))) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT tenant_id, status, claimed_at, deletion_due_at, original_handle,
              hostnames_purged_at, r2_purged_at, tenant_store_purged_at,
              memberships_purged_at, residuals_deidentified_at, tombstone_recorded_at,
              completed_at, last_error_code, attempts, updated_at
       FROM tenant_offboarding_runs
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<RawOffboardingRunRow>();
  return row ? mapOffboardingRunRow(row) : null;
}

/**
 * Lists candidate tenants eligible for offboarding warning evaluation, offboarding claim,
 * or resuming an interrupted `purging` run using SQL filtering + keyset pagination (`afterId`).
 *
 * Excludes healthy active paid tenants outside the 7-day warning horizon in SQL so large
 * fleets (>500 active tenants) can never starve due or `purging` tenants.
 */
export async function listTenantsForOffboardingSweep(
  db: D1Database,
  options: {
    readonly limit?: number;
    readonly tenantId?: string;
    readonly afterId?: string;
    readonly nowMs?: number;
  } = {},
): Promise<readonly OffboardingCandidateRow[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 200)));
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const warningHorizonMs = nowMs + WARNING_LEAD_WINDOW_MS;

  const clauses: string[] = [
    "t.status IN ('trial', 'active', 'grace', 'locked', 'suspended', 'purging')",
    `(t.status IN ('purging', 'trial', 'grace', 'locked', 'suspended')
      OR (t.deletion_due_at IS NOT NULL AND t.deletion_due_at <= ?)
      OR (t.paid_through IS NOT NULL AND t.paid_through <= ?)
      OR (t.paid_through IS NULL AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at <= ?)
      OR (t.paid_through IS NULL AND t.trial_ends_at IS NULL AND (t.created_at + ?) <= ?))`,
  ];
  const bindings: (string | number)[] = [
    warningHorizonMs,
    nowMs,
    nowMs,
    UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
    warningHorizonMs,
  ];

  if (options.tenantId) {
    clauses.push("t.id = ?");
    bindings.push(options.tenantId);
  }
  if (options.afterId) {
    clauses.push("t.id > ?");
    bindings.push(options.afterId);
  }
  bindings.push(limit);

  const res = await db
    .prepare(
      `SELECT t.id, t.organization_id, t.agency_id, t.handle, t.name, t.status,
              t.operator_hold, t.operator_hold_reason, t.trial_ends_at, t.paid_through,
              t.deletion_due_at, t.retention_paused_at, t.offboarding_started_at,
              t.created_at, t.version,
              CASE WHEN t.agency_id IS NOT NULL THEN a.owner_user_id ELSE om.user_id END AS payer_user_id,
              CASE WHEN t.agency_id IS NOT NULL THEN au.email ELSE ou.email END AS payer_email,
              CASE WHEN t.agency_id IS NOT NULL THEN a.name ELSE ou.name END AS payer_name
       FROM tenants t
       LEFT JOIN agencies a ON a.id = t.agency_id
       LEFT JOIN users au ON au.id = a.owner_user_id
       LEFT JOIN members om ON om.organization_id = t.organization_id AND om.role = 'owner'
       LEFT JOIN users ou ON ou.id = om.user_id
       WHERE ${clauses.join("\n         AND ")}
       ORDER BY t.id ASC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<OffboardingCandidateRow>();

  return res.results ?? [];
}

/**
 * Atomically claims a tenant for offboarding (`status -> 'purging'`, `offboarding_started_at = nowMs`)
 * in ONE serialized D1 batch BEFORE any external purge side effect (`DEC-022`, `REQ-069`).
 *
 * Atomic SQLite guards guarantee:
 * - Never claims 1ms before `deletion_due_at`.
 * - Never claims while `operator_hold = 1` or `retention_paused_at IS NOT NULL`.
 * - Never claims while any payment attempt is in `creating`, `creation_unknown`, `pending`, or `review`.
 * - Never claims while any obligation has `review_required = 1`.
 * - Concurrent payment attempt creation, settlement, or operator hold can NEVER yield a
 *   deleted-but-paid or held-but-deleted tenant.
 */
export async function claimTenantForOffboarding(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly nowMs?: number;
    readonly requestId?: string | null;
    readonly reason?: string;
  },
): Promise<ClaimTenantForOffboardingResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const row = await db
    .prepare(
      `SELECT id, organization_id, agency_id, handle, name, status,
              operator_hold, operator_hold_reason, trial_ends_at, paid_through,
              deletion_due_at, retention_paused_at, offboarding_started_at,
              created_at, version
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<Omit<OffboardingCandidateRow, "payer_user_id" | "payer_email" | "payer_name">>();

  if (!row) {
    return { claimed: false, tenantId: input.tenantId, reason: "not_found", deletionDueAtMs: null };
  }

  const hasLifecycleCol = await hasColumnSafe(db, "payment_attempts", "lifecycle_state");
  const hasReviewCol = await hasColumnSafe(db, "billing_obligations", "review_required");
  const hasRunsTable = await hasTableSafe(db, "tenant_offboarding_runs");

  const unresolvedAttemptSql = hasLifecycleCol
    ? `SELECT 1 AS hit FROM payment_attempts
       WHERE tenant_id = ?
         AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       LIMIT 1`
    : `SELECT 1 AS hit FROM payment_attempts
       WHERE tenant_id = ?
         AND state IN ('initiated', 'pending')
       LIMIT 1`;

  const [unresolvedAttempt, reviewObligation] = await Promise.all([
    db.prepare(unresolvedAttemptSql).bind(row.id).first<{ readonly hit: number }>(),
    hasReviewCol
      ? db
          .prepare(
            "SELECT 1 AS hit FROM billing_obligations WHERE tenant_id = ? AND review_required = 1 LIMIT 1",
          )
          .bind(row.id)
          .first<{ readonly hit: number }>()
      : Promise.resolve(null),
  ]);

  const eligibility = evaluateOffboardingClaimEligibility({
    storedStatus: row.status,
    operatorHold: row.operator_hold === 1,
    retentionPausedAtMs: row.retention_paused_at,
    offboardingStartedAtMs: row.offboarding_started_at,
    paidThroughMs: row.paid_through,
    trialEndsAtMs: row.trial_ends_at,
    createdAtMs: row.created_at,
    explicitDeletionDueAtMs: row.deletion_due_at,
    hasUnresolvedPaymentAttempt: Boolean(unresolvedAttempt),
    nowMs,
  });

  if (!eligibility.eligible || eligibility.deletionDueAtMs === null) {
    return {
      claimed: false,
      tenantId: row.id,
      reason: eligibility.blockReason ?? "before_deletion_due_at",
      deletionDueAtMs: eligibility.deletionDueAtMs,
    };
  }

  if (reviewObligation) {
    return {
      claimed: false,
      tenantId: row.id,
      reason: "review_required_obligation",
      deletionDueAtMs: eligibility.deletionDueAtMs,
    };
  }

  const notExistsAttemptPredicate = hasLifecycleCol
    ? `AND NOT EXISTS (
         SELECT 1 FROM payment_attempts pa
         WHERE pa.tenant_id = tenants.id
           AND pa.lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       )`
    : `AND NOT EXISTS (
         SELECT 1 FROM payment_attempts pa
         WHERE pa.tenant_id = tenants.id
           AND pa.state IN ('initiated', 'pending')
       )`;

  const notExistsReviewPredicate = hasReviewCol
    ? `AND NOT EXISTS (
         SELECT 1 FROM billing_obligations bo
         WHERE bo.tenant_id = tenants.id
           AND bo.review_required = 1
       )`
    : "";

  const claimUpdateStmt = db
    .prepare(
      `UPDATE tenants
       SET status = 'purging',
           offboarding_started_at = ?,
           deletion_due_at = COALESCE(deletion_due_at, ?),
           cache_version = cache_version + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?
         AND status IN ('trial', 'active', 'grace', 'locked', 'suspended')
         AND operator_hold = 0
         AND retention_paused_at IS NULL
         AND offboarding_started_at IS NULL
         AND (
           (deletion_due_at IS NOT NULL AND deletion_due_at <= ?)
           OR (deletion_due_at IS NULL AND paid_through IS NOT NULL AND (paid_through + ?) <= ?)
           OR (deletion_due_at IS NULL AND paid_through IS NULL AND trial_ends_at IS NOT NULL AND (trial_ends_at + ?) <= ?)
           OR (deletion_due_at IS NULL AND paid_through IS NULL AND trial_ends_at IS NULL AND (created_at + ?) <= ?)
         )
         AND (paid_through IS NULL OR paid_through <= ?)
         AND (trial_ends_at IS NULL OR paid_through IS NOT NULL OR trial_ends_at <= ?)
         ${notExistsAttemptPredicate}
         ${notExistsReviewPredicate}`,
    )
    .bind(
      nowMs,
      eligibility.deletionDueAtMs,
      nowMs,
      row.id,
      row.version,
      nowMs,
      PAID_DELETION_WINDOW_MS,
      nowMs,
      TRIAL_DELETION_WINDOW_MS,
      nowMs,
      UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
      nowMs,
      nowMs,
      nowMs,
    );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: null,
      actorRole: "system_offboarding",
      action: "tenant.offboarding.claimed",
      targetType: "tenant",
      targetId: row.id,
      tenantId: row.id,
      reason: input.reason ?? `Automated offboarding claim (${eligibility.track}) at deletion_due_at`,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        track: eligibility.track,
        deletionDueAtMs: eligibility.deletionDueAtMs,
        offboardingStartedAtMs: nowMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const statements: D1PreparedStatement[] = [claimUpdateStmt];
  if (hasRunsTable) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tenant_offboarding_runs (
             tenant_id, status, claimed_at, deletion_due_at, original_handle,
             attempts, updated_at
           )
           SELECT ?, 'claimed', ?, ?, ?, 1, ?
           WHERE changes() = 1`,
        )
        .bind(row.id, nowMs, eligibility.deletionDueAtMs, row.handle, nowMs),
    );
  }
  statements.push(auditStmt);

  const results = await db.batch(statements);
  const updated = (results[0]?.meta?.changes ?? 0) === 1;

  if (!updated) {
    return {
      claimed: false,
      tenantId: row.id,
      reason: "concurrent_conflict",
      deletionDueAtMs: eligibility.deletionDueAtMs,
    };
  }

  evictTenantFromCache(row.id);

  return {
    claimed: true,
    tenantId: row.id,
    originalHandle: row.handle,
    offboardingStartedAtMs: nowMs,
    deletionDueAtMs: eligibility.deletionDueAtMs,
    track: eligibility.track,
    auditId: auditEntry.id,
  };
}

async function purgeTenantR2AllObjects(
  bucket: OffboardingR2BucketLike,
  tenantId: string,
): Promise<number> {
  const prefix = `t/${tenantId}/`;
  const keysToDelete: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (isTenantScopedR2Key(tenantId, obj.key)) {
        keysToDelete.push(obj.key);
      }
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  let deleted = 0;
  for (let i = 0; i < keysToDelete.length; i += R2_DELETE_BATCH_SIZE) {
    const chunk = keysToDelete.slice(i, i + R2_DELETE_BATCH_SIZE);
    await bucket.delete([...chunk]);
    deleted += chunk.length;
  }
  return deleted;
}

/**
 * Purges a tenant's physically isolated `TenantStore` Durable Object using the strongest
 * available wipe method (`purgeAll` -> `deleteAlarm()` + `deleteAll()` -> SQL table drop/wipe).
 */
export async function purgeTenantStoreData(
  stub: OffboardingTenantStoreStubLike,
): Promise<"purgeAll" | "deleteAll" | "sql_wipe" | "skipped"> {
  if (typeof stub.purgeAll === "function") {
    await stub.purgeAll(TENANT_STORE_PROTOCOL);
    return "purgeAll";
  }

  if (typeof stub.deleteAll === "function") {
    if (typeof stub.deleteAlarm === "function") {
      await stub.deleteAlarm();
    }
    await stub.deleteAll();
    return "deleteAll";
  }

  if (typeof stub.query === "function") {
    const tablesRes = await stub.query(
      TENANT_STORE_PROTOCOL,
      {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        args: [],
      },
      false,
    );
    const tableNames = tablesRes.results
      .map((r) => String(r.name ?? ""))
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

    if (tableNames.length > 0) {
      const statements: { readonly sql: string; readonly args: readonly unknown[] }[] = [
        { sql: "PRAGMA foreign_keys = OFF", args: [] },
        ...tableNames.map((name) => ({ sql: `DELETE FROM "${name}"`, args: [] as const })),
        { sql: "PRAGMA foreign_keys = ON", args: [] },
      ];
      if (typeof stub.batch === "function") {
        await stub.batch(TENANT_STORE_PROTOCOL, statements);
      } else {
        for (const stmt of statements) {
          await stub.query(TENANT_STORE_PROTOCOL, stmt, false);
        }
      }
    }
    return "sql_wipe";
  }

  return "skipped";
}

async function markRunStepCheckpoint(
  db: D1Database,
  hasRunsTable: boolean,
  tenantId: string,
  column:
    | "hostnames_purged_at"
    | "r2_purged_at"
    | "tenant_store_purged_at"
    | "memberships_purged_at"
    | "residuals_deidentified_at",
  nowMs: number,
): Promise<void> {
  if (!hasRunsTable) return;
  await db
    .prepare(
      `UPDATE tenant_offboarding_runs
       SET ${column} = COALESCE(${column}, ?),
           last_error_code = NULL,
           updated_at = ?
       WHERE tenant_id = ?`,
    )
    .bind(nowMs, nowMs, tenantId)
    .run();
}

async function recordRunStepFailure(
  db: D1Database,
  hasRunsTable: boolean,
  tenantId: string,
  errorCode: string,
  nowMs: number,
): Promise<void> {
  if (!hasRunsTable) return;
  try {
    await db
      .prepare(
        `UPDATE tenant_offboarding_runs
         SET last_error_code = ?,
             attempts = attempts + 1,
             updated_at = ?
         WHERE tenant_id = ?`,
      )
      .bind(errorCode, nowMs, tenantId)
      .run();
  } catch {
    // Non-fatal bookkeeping error
  }
}

/**
 * Executes or resumes the idempotent tenant-scoped offboarding purge for a tenant
 * ALREADY claimed into `status = 'purging'` (`offboarding_started_at IS NOT NULL`).
 *
 * Steps (each checkpointed in `tenant_offboarding_runs` so an interrupted job resumes
 * cleanly with ZERO duplicate external side effects):
 * 1. Delete custom hostnames via Cloudflare provider client & remove `tenant_hosts` rows.
 * 2. Delete all R2 objects strictly scoped under `t/<tenantId>/`.
 * 3. Wipe `TenantStore` (`deleteAlarm()` + `deleteAll()`).
 * 4. Remove tenant sessions, renewal pay links, and org memberships/invitations (if single-tenant org).
 * 5. Convert unsettled charges to de-identified residual records while PRESERVING all
 *    `billing_obligations`, `payment_attempts`, `settlements`, `entitlement_grants`,
 *    `receipts`, `payment_receipts`, and `platform_audit` rows.
 * 6. Write `deletion_tombstones` (30-day handle quarantine), rename residual `tenants.handle`
 *    to `purged-<id>` (`status = 'purged'`, `name = 'Deleted Tenant'`), complete checkpoint,
 *    and append immutable `platform_audit` atomically.
 */
export async function executeTenantOffboardingPurge(
  input: ExecuteTenantOffboardingPurgeInput,
): Promise<ExecuteTenantOffboardingPurgeResult> {
  const { platformDb: db, tenantId } = input;
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const tenantRow = await db
    .prepare(
      `SELECT id, organization_id, handle, name, status, offboarding_started_at, deletion_due_at,
              paid_through, trial_ends_at, created_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{
      readonly id: string;
      readonly organization_id: string;
      readonly handle: string;
      readonly name: string;
      readonly status: string;
      readonly offboarding_started_at: number | null;
      readonly deletion_due_at: number | null;
      readonly paid_through: number | null;
      readonly trial_ends_at: number | null;
      readonly created_at: number;
    }>();

  if (!tenantRow) {
    return {
      outcome: "not_claimed",
      tenantId,
      originalHandle: null,
      quarantineUntilMs: null,
      customHostnamesDeleted: 0,
      hostsRowsRemoved: 0,
      r2ObjectsDeleted: 0,
      tenantStorePurged: false,
      tenantStorePurgeMethod: "skipped",
      membershipsRemoved: 0,
      sessionsRevoked: 0,
      unsettledObligationsDeidentified: 0,
      tombstoneId: null,
      stepsExecuted: [],
      stepsResumedFromCheckpoint: [],
    };
  }

  if (tenantRow.status === "purged") {
    const tombstone = await db
      .prepare(
        "SELECT id, handle, quarantine_until FROM deletion_tombstones WHERE tenant_id = ? LIMIT 1",
      )
      .bind(tenantId)
      .first<{ readonly id: string; readonly handle: string; readonly quarantine_until: number }>();

    return {
      outcome: "already_purged",
      tenantId,
      originalHandle: tombstone?.handle ?? null,
      quarantineUntilMs: tombstone?.quarantine_until ?? null,
      customHostnamesDeleted: 0,
      hostsRowsRemoved: 0,
      r2ObjectsDeleted: 0,
      tenantStorePurged: false,
      tenantStorePurgeMethod: "skipped",
      membershipsRemoved: 0,
      sessionsRevoked: 0,
      unsettledObligationsDeidentified: 0,
      tombstoneId: tombstone?.id ?? null,
      stepsExecuted: [],
      stepsResumedFromCheckpoint: ["already_purged"],
    };
  }

  if (tenantRow.status !== "purging" || tenantRow.offboarding_started_at === null) {
    return {
      outcome: "not_claimed",
      tenantId,
      originalHandle: tenantRow.handle,
      quarantineUntilMs: null,
      customHostnamesDeleted: 0,
      hostsRowsRemoved: 0,
      r2ObjectsDeleted: 0,
      tenantStorePurged: false,
      tenantStorePurgeMethod: "skipped",
      membershipsRemoved: 0,
      sessionsRevoked: 0,
      unsettledObligationsDeidentified: 0,
      tombstoneId: null,
      stepsExecuted: [],
      stepsResumedFromCheckpoint: [],
    };
  }

  const hasRunsTable = await hasTableSafe(db, "tenant_offboarding_runs");
  let run = hasRunsTable ? await getTenantOffboardingRun(db, tenantId) : null;
  const originalHandle = run?.originalHandle ?? tenantRow.handle;

  if (hasRunsTable && !run) {
    const clock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: tenantRow.paid_through,
      trialEndsAtMs: tenantRow.trial_ends_at,
      createdAtMs: tenantRow.created_at,
      explicitDeletionDueAtMs: tenantRow.deletion_due_at,
    });
    await db
      .prepare(
        `INSERT OR IGNORE INTO tenant_offboarding_runs (
           tenant_id, status, claimed_at, deletion_due_at, original_handle, attempts, updated_at
         ) VALUES (?, 'claimed', ?, ?, ?, 1, ?)`,
      )
      .bind(
        tenantId,
        tenantRow.offboarding_started_at,
        clock.deletionDueAtMs ?? nowMs,
        originalHandle,
        nowMs,
      )
      .run();
    run = await getTenantOffboardingRun(db, tenantId);
  }

  const stepsExecuted: string[] = [];
  const stepsResumedFromCheckpoint: string[] = [];

  let customHostnamesDeleted = 0;
  let hostsRowsRemoved = 0;
  let r2ObjectsDeleted = 0;
  let tenantStorePurged = false;
  let tenantStorePurgeMethod: ExecuteTenantOffboardingPurgeResult["tenantStorePurgeMethod"] =
    "skipped";
  let membershipsRemoved = 0;
  let sessionsRevoked = 0;
  let unsettledObligationsDeidentified = 0;

  // Capture owner identity hashes BEFORE removing org memberships (for DEC-022 tombstone anti-trial-abuse)
  const ownerRow = await db
    .prepare(
      `SELECT u.email, a.account_id AS google_sub
       FROM members m
       INNER JOIN users u ON u.id = m.user_id
       LEFT JOIN accounts a ON a.user_id = u.id AND a.provider_id = 'google'
       WHERE m.organization_id = ? AND m.role = 'owner'
       LIMIT 1`,
    )
    .bind(tenantRow.organization_id)
    .first<{ readonly email: string | null; readonly google_sub: string | null }>();

  const emailHash = ownerRow?.email ? await sha256Hex(ownerRow.email.trim().toLowerCase()) : null;
  const googleSubHash = ownerRow?.google_sub ? await sha256Hex(ownerRow.google_sub.trim()) : null;
  const companyNameHash =
    tenantRow.name && tenantRow.name !== "Deleted Tenant"
      ? await sha256Hex(tenantRow.name.trim().toLowerCase())
      : null;

  // Step 1: Purge custom hostnames via Cloudflare provider client & release tenant_hosts
  // Per-row resumable: each custom host row is deleted locally ONLY AFTER Cloudflare confirms
  // deletion (or 404/alreadyAbsent). Missing Cloudflare client with active custom hostnames
  // fails retryably without deleting `tenant_hosts` or checkpointing (never orphans CF billing!).
  if (run?.hostnamesPurgedAtMs) {
    stepsResumedFromCheckpoint.push("hostnames");
  } else {
    try {
      const customHosts = await db
        .prepare(
          `SELECT host, cf_custom_hostname_id
           FROM tenant_hosts
           WHERE tenant_id = ? AND kind = 'custom'
           ORDER BY host ASC`,
        )
        .bind(tenantId)
        .all<{ readonly host: string; readonly cf_custom_hostname_id: string | null }>();

      const customRows = customHosts.results ?? [];
      const hasExternalCustomHostnames = customRows.some((h) => Boolean(h.cf_custom_hostname_id));
      if (hasExternalCustomHostnames && !input.cloudflareClient) {
        const missingCfErr = new Error("CLOUDFLARE_CLIENT_UNAVAILABLE") as Error & { code: string };
        missingCfErr.code = "CLOUDFLARE_CLIENT_UNAVAILABLE";
        throw missingCfErr;
      }

      for (const h of customRows) {
        if (h.cf_custom_hostname_id && input.cloudflareClient) {
          try {
            await input.cloudflareClient.deleteCustomHostname(h.cf_custom_hostname_id);
          } catch (cfErr) {
            if (!isCloudflareNotFoundError(cfErr)) {
              throw cfErr;
            }
          }
          customHostnamesDeleted += 1;
        }
        const delRowRes = await db
          .prepare("DELETE FROM tenant_hosts WHERE tenant_id = ? AND host = ?")
          .bind(tenantId, h.host)
          .run();
        hostsRowsRemoved += delRowRes.meta?.changes ?? 0;
      }

      const delRemainingHostsRes = await db
        .prepare("DELETE FROM tenant_hosts WHERE tenant_id = ?")
        .bind(tenantId)
        .run();
      hostsRowsRemoved += delRemainingHostsRes.meta?.changes ?? 0;

      await markRunStepCheckpoint(db, hasRunsTable, tenantId, "hostnames_purged_at", nowMs);
      stepsExecuted.push("hostnames");
    } catch (err) {
      await recordRunStepFailure(db, hasRunsTable, tenantId, sanitizeErrorCode(err), nowMs);
      throw err;
    }
  }

  // Step 2: Purge all R2 objects strictly scoped under `t/<tenantId>/`
  if (run?.r2PurgedAtMs) {
    stepsResumedFromCheckpoint.push("r2");
  } else {
    try {
      if (input.mediaBucket) {
        r2ObjectsDeleted = await purgeTenantR2AllObjects(input.mediaBucket, tenantId);
      }
      await markRunStepCheckpoint(db, hasRunsTable, tenantId, "r2_purged_at", nowMs);
      stepsExecuted.push("r2");
    } catch (err) {
      await recordRunStepFailure(db, hasRunsTable, tenantId, sanitizeErrorCode(err), nowMs);
      throw err;
    }
  }

  // Step 3: Purge per-tenant `TenantStore` (`deleteAlarm()` + `deleteAll()`)
  if (run?.tenantStorePurgedAtMs) {
    stepsResumedFromCheckpoint.push("tenant_store");
  } else {
    try {
      if (input.tenantStoreNamespace) {
        const stub = input.tenantStoreNamespace.getByName(tenantId, { locationHint: "apac-se" });
        tenantStorePurgeMethod = await purgeTenantStoreData(stub);
        tenantStorePurged = tenantStorePurgeMethod !== "skipped";
      }
      await markRunStepCheckpoint(db, hasRunsTable, tenantId, "tenant_store_purged_at", nowMs);
      stepsExecuted.push("tenant_store");
    } catch (err) {
      await recordRunStepFailure(db, hasRunsTable, tenantId, sanitizeErrorCode(err), nowMs);
      throw err;
    }
  }

  // Step 4: Purge tenant-scoped sessions, renewal pay links, and single-tenant org memberships
  if (run?.membershipsPurgedAtMs) {
    stepsResumedFromCheckpoint.push("memberships");
  } else {
    try {
      const otherActiveTenant = await db
        .prepare(
          `SELECT id FROM tenants
           WHERE organization_id = ? AND id != ? AND status NOT IN ('purged', 'purging')
           LIMIT 1`,
        )
        .bind(tenantRow.organization_id, tenantId)
        .first<{ readonly id: string }>();

      const sessRes = await db
        .prepare("DELETE FROM sessions WHERE active_organization_id = ?")
        .bind(tenantRow.organization_id)
        .run();
      sessionsRevoked = sessRes.meta?.changes ?? 0;

      if (await hasTableSafe(db, "billing_renewal_pay_links")) {
        await db
          .prepare("DELETE FROM billing_renewal_pay_links WHERE tenant_id = ?")
          .bind(tenantId)
          .run();
      }

      if (!otherActiveTenant) {
        const [memRes] = await db.batch([
          db
            .prepare("DELETE FROM members WHERE organization_id = ?")
            .bind(tenantRow.organization_id),
          db
            .prepare("DELETE FROM invitations WHERE organization_id = ?")
            .bind(tenantRow.organization_id),
          db
            .prepare(
              `UPDATE organizations
               SET name = 'Deleted Organization',
                   logo = NULL,
                   metadata = NULL,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(nowMs, tenantRow.organization_id),
        ]);
        membershipsRemoved = memRes?.meta?.changes ?? 0;
      }

      await markRunStepCheckpoint(db, hasRunsTable, tenantId, "memberships_purged_at", nowMs);
      stepsExecuted.push("memberships");
    } catch (err) {
      await recordRunStepFailure(db, hasRunsTable, tenantId, sanitizeErrorCode(err), nowMs);
      throw err;
    }
  }

  // Step 5: Convert unsettled charges to de-identified residual records while PRESERVING
  // all billing/payment/settlement/receipt/audit rows (CMSPRO DEC-027, REQ-069).
  if (run?.residualsDeidentifiedAtMs) {
    stepsResumedFromCheckpoint.push("residuals");
  } else {
    try {
      const hasCouponRedemptions = await hasTableSafe(db, "coupon_redemptions");
      const hasLifecycleCol = await hasColumnSafe(db, "payment_attempts", "lifecycle_state");

      const residualStmts: D1PreparedStatement[] = [
        // Convert unsettled open obligations to canceled + deidentified residual rows
        db
          .prepare(
            `UPDATE billing_obligations
             SET status = 'canceled',
                 deidentified_at = COALESCE(deidentified_at, ?),
                 coupon_snapshot_json = NULL,
                 version = version + 1,
                 updated_at = ?
             WHERE tenant_id = ?
               AND status = 'open'`,
          )
          .bind(nowMs, nowMs, tenantId),
        // Mark any remaining obligations as de-identified while preserving financial amounts & snapshots
        db
          .prepare(
            `UPDATE billing_obligations
             SET deidentified_at = COALESCE(deidentified_at, ?),
                 updated_at = ?
             WHERE tenant_id = ?
               AND deidentified_at IS NULL`,
          )
          .bind(nowMs, nowMs, tenantId),
        // Scrub mutable provider instruction payloads on non-paid attempts while keeping all ledger columns
        hasLifecycleCol
          ? db
              .prepare(
                `UPDATE payment_attempts
                 SET provider_payload_json = NULL,
                     updated_at = ?
                 WHERE tenant_id = ?
                   AND lifecycle_state != 'paid'
                   AND provider_payload_json IS NOT NULL`,
              )
              .bind(nowMs, tenantId)
          : db
              .prepare(
                `UPDATE payment_attempts
                 SET provider_payload_json = NULL,
                     updated_at = ?
                 WHERE tenant_id = ?
                   AND state != 'settled'
                   AND provider_payload_json IS NOT NULL`,
              )
              .bind(nowMs, tenantId),
      ];

      if (hasCouponRedemptions) {
        residualStmts.push(
          db
            .prepare(
              `UPDATE promo_coupons
               SET redeemed_count = CASE WHEN redeemed_count > 0 THEN redeemed_count - 1 ELSE 0 END,
                   updated_at = ?
               WHERE id IN (
                 SELECT coupon_id FROM coupon_redemptions
                 WHERE tenant_id = ? AND status = 'reserved'
               )`,
            )
            .bind(nowMs, tenantId),
          db
            .prepare(
              `UPDATE coupon_redemptions
               SET status = 'released',
                   updated_at = ?
               WHERE tenant_id = ? AND status = 'reserved'`,
            )
            .bind(nowMs, tenantId),
        );
      }

      const residualResults = await db.batch(residualStmts);
      unsettledObligationsDeidentified =
        (residualResults[0]?.meta?.changes ?? 0) + (residualResults[1]?.meta?.changes ?? 0);

      await markRunStepCheckpoint(db, hasRunsTable, tenantId, "residuals_deidentified_at", nowMs);
      stepsExecuted.push("residuals");
    } catch (err) {
      await recordRunStepFailure(db, hasRunsTable, tenantId, sanitizeErrorCode(err), nowMs);
      throw err;
    }
  }

  // Step 6: Record DEC-022 tombstone (30-day handle quarantine), transition residual tenant row to `purged`
  // with de-identified handle sentinel so original handle unlocks cleanly after 30 days, and append audit.
  const quarantineUntilMs = nowMs + HANDLE_QUARANTINE_WINDOW_MS;
  const tombstoneId = `tmb_${generateBillingUlid(nowMs)}`;
  const deidentifiedHandle = `purged-${tenantId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;

  await recordDeletionTombstone(db, {
    id: tombstoneId,
    tenantId,
    handle: originalHandle,
    quarantineUntilMs,
    googleSubHash,
    emailHash,
    companyNameHash,
    reason: input.reason ?? "DEC-022 automated retention offboarding purge",
    deletedBy: "system:offboarding",
    deletedAtMs: nowMs,
  });

  const { statement: purgeAuditStmt } = buildPlatformAuditStatement(db, {
    actorUserId: null,
    actorRole: "system_offboarding",
    action: "tenant.offboarding.purged",
    targetType: "tenant",
    targetId: tenantId,
    tenantId,
    reason: input.reason ?? "Completed idempotent tenant offboarding purge (DEC-022)",
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      tombstoneId,
      quarantineUntilMs,
      customHostnamesDeleted,
      hostsRowsRemoved,
      r2ObjectsDeleted,
      tenantStorePurged,
      tenantStorePurgeMethod,
      membershipsRemoved,
      sessionsRevoked,
      unsettledObligationsDeidentified,
    },
    createdAtMs: nowMs,
  });

  const finalizeStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE tenants
         SET status = 'purged',
             handle = ?,
             name = 'Deleted Tenant',
             operator_hold = 0,
             operator_hold_reason = NULL,
             retention_paused_at = NULL,
             cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND status = 'purging'`,
      )
      .bind(deidentifiedHandle, nowMs, tenantId),
    purgeAuditStmt,
  ];

  if (hasRunsTable) {
    finalizeStmts.push(
      db
        .prepare(
          `UPDATE tenant_offboarding_runs
           SET status = 'purged',
               tombstone_recorded_at = COALESCE(tombstone_recorded_at, ?),
               completed_at = COALESCE(completed_at, ?),
               last_error_code = NULL,
               updated_at = ?
           WHERE tenant_id = ?`,
        )
        .bind(nowMs, nowMs, nowMs, tenantId),
    );
  }

  await db.batch(finalizeStmts);
  evictTenantFromCache(tenantId);
  stepsExecuted.push("tombstone_and_finalize");

  const finalTombstone = await db
    .prepare("SELECT id FROM deletion_tombstones WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ readonly id: string }>();

  return {
    outcome: "purged",
    tenantId,
    originalHandle,
    quarantineUntilMs,
    customHostnamesDeleted,
    hostsRowsRemoved,
    r2ObjectsDeleted,
    tenantStorePurged,
    tenantStorePurgeMethod,
    membershipsRemoved,
    sessionsRevoked,
    unsettledObligationsDeidentified,
    tombstoneId: finalTombstone?.id ?? tombstoneId,
    stepsExecuted,
    stepsResumedFromCheckpoint,
  };
}

/**
 * Full DEC-022 tombstone replay across `PLATFORM_DB`, `MEDIA_BUCKET`, `TenantStore` DOs,
 * and optional Cloudflare custom hostnames after a backup restore drill.
 * Re-purges any resurrected tenant so deleted data never returns after restore!
 */
export async function replayOffboardingTombstonesFull(input: {
  readonly platformDb: D1Database;
  readonly mediaBucket?: OffboardingR2BucketLike | null;
  readonly tenantStoreNamespace?: OffboardingTenantStoreNamespaceLike | null;
  readonly cloudflareClient?: OffboardingCloudflareClientLike | null;
  readonly nowMs?: number;
}): Promise<{
  readonly replayedAtMs: number;
  readonly tombstonesScanned: number;
  readonly tenantsRePurged: number;
  readonly hostsNeutralized: number;
  readonly r2ObjectsDeleted: number;
  readonly tenantStoresPurged: number;
  readonly customHostnamesDeleted: number;
  readonly membershipsRemoved: number;
  readonly sessionsRevoked: number;
  readonly tenantIdsProcessed: readonly string[];
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const baseReplay = await replayDeletionTombstones({
    platformDb: input.platformDb,
    mediaBucket: input.mediaBucket,
    nowMs,
  });

  let tenantStoresPurged = 0;
  let customHostnamesDeleted = 0;
  let membershipsRemoved = 0;
  let sessionsRevoked = 0;

  for (const tenantId of baseReplay.tenantIdsProcessed) {
    const resurrected = await input.platformDb
      .prepare("SELECT organization_id FROM tenants WHERE id = ? LIMIT 1")
      .bind(tenantId)
      .first<{ readonly organization_id: string }>();

    // Re-deidentify resurrected handle so 30-day quarantine remains solely in deletion_tombstones
    const deidentifiedHandle = `purged-${tenantId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;
    await input.platformDb
      .prepare(
        `UPDATE tenants
         SET status = 'purged',
             handle = ?,
             name = 'Deleted Tenant',
             cache_version = cache_version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(deidentifiedHandle, nowMs, tenantId)
      .run();

    // Re-delete resurrected sessions and single-tenant org memberships/invitations
    if (resurrected?.organization_id) {
      const sessRes = await input.platformDb
        .prepare("DELETE FROM sessions WHERE active_organization_id = ?")
        .bind(resurrected.organization_id)
        .run();
      sessionsRevoked += sessRes.meta?.changes ?? 0;

      const otherLiveTenant = await input.platformDb
        .prepare(
          `SELECT id FROM tenants
           WHERE organization_id = ? AND id != ? AND status NOT IN ('purged', 'purging')
           LIMIT 1`,
        )
        .bind(resurrected.organization_id, tenantId)
        .first<{ readonly id: string }>();

      if (!otherLiveTenant) {
        const [memRes] = await input.platformDb.batch([
          input.platformDb
            .prepare("DELETE FROM members WHERE organization_id = ?")
            .bind(resurrected.organization_id),
          input.platformDb
            .prepare("DELETE FROM invitations WHERE organization_id = ?")
            .bind(resurrected.organization_id),
          input.platformDb
            .prepare(
              `UPDATE organizations
               SET name = 'Deleted Organization',
                   logo = NULL,
                   metadata = NULL,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(nowMs, resurrected.organization_id),
        ]);
        membershipsRemoved += memRes?.meta?.changes ?? 0;
      }
    }

    // Re-delete any resurrected custom hostnames at provider (404-tolerant)
    if (input.cloudflareClient) {
      const customHosts = await input.platformDb
        .prepare(
          `SELECT cf_custom_hostname_id
           FROM tenant_hosts
           WHERE tenant_id = ? AND kind = 'custom' AND cf_custom_hostname_id IS NOT NULL`,
        )
        .bind(tenantId)
        .all<{ readonly cf_custom_hostname_id: string }>();
      for (const h of customHosts.results ?? []) {
        try {
          await input.cloudflareClient.deleteCustomHostname(h.cf_custom_hostname_id);
        } catch (cfErr) {
          if (!isCloudflareNotFoundError(cfErr)) {
            throw cfErr;
          }
        }
        customHostnamesDeleted += 1;
      }
    }

    // Re-purge resurrected TenantStore Durable Object data
    if (input.tenantStoreNamespace) {
      const stub = input.tenantStoreNamespace.getByName(tenantId, { locationHint: "apac-se" });
      const method = await purgeTenantStoreData(stub);
      if (method !== "skipped") {
        tenantStoresPurged += 1;
      }
    }

    evictTenantFromCache(tenantId);
  }

  return {
    replayedAtMs: baseReplay.replayedAtMs,
    tombstonesScanned: baseReplay.tombstonesScanned,
    tenantsRePurged: baseReplay.tenantsRePurged,
    hostsNeutralized: baseReplay.hostsNeutralized,
    r2ObjectsDeleted: baseReplay.r2ObjectsDeleted,
    tenantStoresPurged,
    customHostnamesDeleted,
    membershipsRemoved,
    sessionsRevoked,
    tenantIdsProcessed: baseReplay.tenantIdsProcessed,
  };
}

// ---------------------------------------------------------------------------
// Deletion Warning Ledger (Zero Runtime DDL; Deduplicated per tenant+stage+deadline)
// ---------------------------------------------------------------------------

interface RawWarningRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly warning_stage: DeletionWarningStage;
  readonly deletion_due_at: number;
  readonly outcome: OffboardingWarningOutcome;
  readonly error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export async function listOffboardingWarningsForDeadline(
  db: D1Database,
  tenantId: string,
  deletionDueAtMs: number,
): Promise<readonly RecordedOffboardingWarning[]> {
  if (!(await hasTableSafe(db, "tenant_offboarding_warnings"))) {
    return [];
  }
  const rows = await db
    .prepare(
      `SELECT id, tenant_id, warning_stage, deletion_due_at, outcome, error_code, created_at, updated_at
       FROM tenant_offboarding_warnings
       WHERE tenant_id = ? AND deletion_due_at = ?
       ORDER BY created_at ASC`,
    )
    .bind(tenantId, Math.trunc(deletionDueAtMs))
    .all<RawWarningRow>();

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    stage: r.warning_stage,
    deletionDueAtMs: r.deletion_due_at,
    outcome: r.outcome,
    errorCode: r.error_code,
    createdAtMs: r.created_at,
    updatedAtMs: r.updated_at,
  }));
}

/**
 * Marks earlier missed warning stages as `suppressed_catchup` when a delayed job wakes up
 * past multiple warning milestones so earlier stages are NEVER sent retroactively (no spam burst!).
 */
export async function suppressMissedOffboardingWarnings(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly stages: readonly DeletionWarningStage[];
    readonly deletionDueAtMs: number;
    readonly nowMs: number;
  },
): Promise<number> {
  if (input.stages.length === 0) return 0;
  if (!(await hasTableSafe(db, "tenant_offboarding_warnings"))) return 0;

  const nowMs = Math.trunc(input.nowMs);
  const dueMs = Math.trunc(input.deletionDueAtMs);
  let suppressed = 0;

  for (const stage of input.stages) {
    const id = `owrn_${generateBillingUlid(nowMs)}`;
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO tenant_offboarding_warnings (
           id, tenant_id, warning_stage, deletion_due_at, outcome, error_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'suppressed_catchup', NULL, ?, ?)`,
      )
      .bind(id, input.tenantId, stage, dueMs, nowMs, nowMs)
      .run();
    suppressed += res.meta?.changes ?? 0;
  }

  return suppressed;
}

/**
 * Claims a single warning stage atomically (`UNIQUE(tenant_id, warning_stage, deletion_due_at)`).
 * Returns `{ claimed: false }` if already claimed/submitted/suppressed/unknown.
 */
export async function claimOffboardingWarningStage(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly stage: DeletionWarningStage;
    readonly deletionDueAtMs: number;
    readonly nowMs: number;
  },
): Promise<{ readonly claimed: boolean; readonly id: string | null }> {
  if (!(await hasTableSafe(db, "tenant_offboarding_warnings"))) {
    return { claimed: true, id: null };
  }

  const nowMs = Math.trunc(input.nowMs);
  const dueMs = Math.trunc(input.deletionDueAtMs);
  const id = `owrn_${generateBillingUlid(nowMs)}`;

  const insertRes = await db
    .prepare(
      `INSERT OR IGNORE INTO tenant_offboarding_warnings (
         id, tenant_id, warning_stage, deletion_due_at, outcome, error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'claimed', NULL, ?, ?)`,
    )
    .bind(id, input.tenantId, input.stage, dueMs, nowMs, nowMs)
    .run();

  if ((insertRes.meta?.changes ?? 0) === 1) {
    return { claimed: true, id };
  }

  // Allow retry ONLY if a previous attempt definitely failed (`outcome = 'failed'`)
  const retryRes = await db
    .prepare(
      `UPDATE tenant_offboarding_warnings
       SET outcome = 'claimed',
           error_code = NULL,
           updated_at = ?
       WHERE tenant_id = ?
         AND warning_stage = ?
         AND deletion_due_at = ?
         AND outcome = 'failed'`,
    )
    .bind(nowMs, input.tenantId, input.stage, dueMs)
    .run();

  return { claimed: (retryRes.meta?.changes ?? 0) === 1, id: null };
}

export async function recordOffboardingWarningOutcome(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly stage: DeletionWarningStage;
    readonly deletionDueAtMs: number;
    readonly outcome: Exclude<OffboardingWarningOutcome, "claimed">;
    readonly errorCode?: string | null;
    readonly nowMs: number;
  },
): Promise<void> {
  if (!(await hasTableSafe(db, "tenant_offboarding_warnings"))) return;
  await db
    .prepare(
      `UPDATE tenant_offboarding_warnings
       SET outcome = ?,
           error_code = ?,
           updated_at = ?
       WHERE tenant_id = ?
         AND warning_stage = ?
         AND deletion_due_at = ?`,
    )
    .bind(
      input.outcome,
      input.errorCode ?? null,
      Math.trunc(input.nowMs),
      input.tenantId,
      input.stage,
      Math.trunc(input.deletionDueAtMs),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Owner Leads CSV Export Rate Limiter (Zero Runtime DDL)
// ---------------------------------------------------------------------------

export const DEFAULT_LEADS_EXPORT_RATE_LIMIT_MAX = 10 as const;
export const DEFAULT_LEADS_EXPORT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Enforces a per-(tenant, user) fixed-window rate limit for owner leads CSV export.
 * Uses `PLATFORM_DB.leads_export_rate_limits` when `0017_tenant_offboarding` is migrated,
 * or falls back cleanly to a bounded isolate map in minimal test harnesses (ZERO runtime DDL!).
 */
export async function checkAndConsumeLeadsExportRateLimit(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly nowMs?: number;
    readonly maxRequests?: number;
    readonly windowMs?: number;
  },
): Promise<LeadsExportRateLimitResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(1000, Math.trunc(input.maxRequests ?? DEFAULT_LEADS_EXPORT_RATE_LIMIT_MAX)));
  const windowMs = Math.max(1000, Math.trunc(input.windowMs ?? DEFAULT_LEADS_EXPORT_RATE_LIMIT_WINDOW_MS));
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStartMs + windowMs;
  const bucketKey = `${input.tenantId}:${input.userId}:${windowStartMs}`;

  if (await hasTableSafe(db, "leads_export_rate_limits")) {
    const results = await db.batch([
      db
        .prepare("DELETE FROM leads_export_rate_limits WHERE window_expires_at <= ?")
        .bind(nowMs),
      db
        .prepare(
          `INSERT INTO leads_export_rate_limits (bucket_key, request_count, window_expires_at, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(bucket_key) DO UPDATE SET
             request_count = leads_export_rate_limits.request_count + 1,
             updated_at = excluded.updated_at
           WHERE leads_export_rate_limits.request_count < ?
           RETURNING request_count`,
        )
        .bind(bucketKey, resetAtMs, nowMs, limit),
    ]);

    const returnedRows = (results[1]?.results ?? []) as readonly {
      readonly request_count: number;
    }[];
    const consumedRow = returnedRows[0];
    if (!consumedRow) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
        resetAtMs,
      };
    }

    const count = consumedRow.request_count;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: 0,
      resetAtMs,
    };
  }

  // Fallback for minimal test harnesses without 0017 migration (zero runtime DDL)
  for (const [k, v] of IN_MEMORY_EXPORT_RATE_LIMITS.entries()) {
    if (v.expiresAtMs <= nowMs) {
      IN_MEMORY_EXPORT_RATE_LIMITS.delete(k);
    }
  }
  const existing = IN_MEMORY_EXPORT_RATE_LIMITS.get(bucketKey);
  if (existing && existing.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
      resetAtMs,
    };
  }
  const nextCount = (existing?.count ?? 0) + 1;
  IN_MEMORY_EXPORT_RATE_LIMITS.set(bucketKey, { count: nextCount, expiresAtMs: resetAtMs });

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - nextCount),
    retryAfterSeconds: 0,
    resetAtMs,
  };
}

export function resetInMemoryLeadsExportRateLimits(): void {
  IN_MEMORY_EXPORT_RATE_LIMITS.clear();
}
