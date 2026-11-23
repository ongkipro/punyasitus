import {
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  computeSettlementEntitlementTransition,
  evaluateEntitlementState,
  generateBillingUlid,
  type BillingPlanInterval,
  type EntitlementEvaluationResult,
  type RenewalReminderKind,
  type SettlementEntitlementTransition,
} from "@punyasitus/core/billing/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import { buildPlatformAuditStatement } from "../platform/audit.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Atomic D1 lifecycle transitions, exactly-once verified entitlement grants, operator manual
 * holds, and single-use grace-expiring one-click renewal pay links (`DEC-035 C17`, `REQ-060`).
 *
 * Hard invariants:
 * - Optimistic concurrency CAS (`WHERE id = ? AND version = ?`) prevents concurrent expiry
 *   sweeps, payment settlements, and operator holds from losing or duplicating entitlements.
 * - Manual operator holds ALWAYS survive payment (`status` stays `'suspended'` while `paid_through`
 *   is still extended and audited).
 * - Expiry transitions NEVER delete tenant data or mutate `TenantStore` drafts/published content.
 * - One-click renewal pay tokens are 256-bit random values stored ONLY as SHA-256 digests,
 *   bound to tenant + obligation/payer, consumed atomically (`WHERE consumed_at IS NULL AND expires_at > ?`),
 *   and expire at the exact end of the grace window (never activating service or issuing a session).
 */

const NON_COMMERCIAL_TERMINAL_STATES: ReadonlySet<TenantStatus> = new Set<TenantStatus>([
  "provisioning",
  "purging",
  "purged",
  "recovery",
]);

export class InvalidLifecycleStateError extends Error {
  readonly status = 409 as const;
  readonly code = "INVALID_LIFECYCLE_STATE" as const;
  readonly tenantId: string;
  readonly storedStatus: TenantStatus;

  constructor(tenantId: string, storedStatus: TenantStatus, message?: string) {
    super(
      message ??
        `INVALID_LIFECYCLE_STATE: tenant "${tenantId}" cannot transition while in "${storedStatus}" state`,
    );
    this.name = "InvalidLifecycleStateError";
    this.tenantId = tenantId;
    this.storedStatus = storedStatus;
  }
}

const RENEWAL_PAY_LINKS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS billing_renewal_pay_links (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    obligation_id TEXT REFERENCES billing_obligations(id),
    payer_user_id TEXT,
    payer_agency_id TEXT,
    reminder_kind TEXT NOT NULL CHECK (
      reminder_kind IN ('paid_h_minus_3', 'paid_h_minus_1', 'paid_h0', 'trial_h_minus_3', 'trial_h_minus_1')
    ),
    cycle_anchor_ms INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS billing_renewal_pay_links_dedup_uidx
    ON billing_renewal_pay_links(tenant_id, reminder_kind, cycle_anchor_ms)`,
  `CREATE INDEX IF NOT EXISTS billing_renewal_pay_links_tenant_idx
    ON billing_renewal_pay_links(tenant_id, expires_at)`,
] as const;

export async function ensureRenewalPayLinksSchema(db: D1Database): Promise<void> {
  for (const sql of RENEWAL_PAY_LINKS_SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
}

function generateSecureHexToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export async function hashRenewalPayLinkToken(rawToken: string): Promise<string> {
  const encoded = new TextEncoder().encode(rawToken);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export interface TenantLifecycleRow {
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
  readonly cache_version: number;
  readonly version: number;
}

async function loadTenantRowForLifecycle(
  db: D1Database,
  tenantId: string,
): Promise<TenantLifecycleRow | null> {
  return db
    .prepare(
      `SELECT id, organization_id, agency_id, handle, name, status,
              operator_hold, operator_hold_reason, trial_ends_at, paid_through,
              deletion_due_at, retention_paused_at, cache_version, version
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantLifecycleRow>();
}

function evaluateRow(row: TenantLifecycleRow, nowMs: number): EntitlementEvaluationResult {
  return evaluateEntitlementState({
    storedStatus: row.status,
    operatorHold: row.operator_hold === 1,
    operatorHoldReason: row.operator_hold_reason,
    trialEndsAtMs: typeof row.trial_ends_at === "number" ? row.trial_ends_at : null,
    paidThroughMs: typeof row.paid_through === "number" ? row.paid_through : null,
    deletionDueAtMs: typeof row.deletion_due_at === "number" ? row.deletion_due_at : null,
    retentionPausedAtMs:
      typeof row.retention_paused_at === "number" ? row.retention_paused_at : null,
    agencyId: row.agency_id,
    nowMs,
  });
}

export interface SyncTenantLifecycleResult {
  readonly found: boolean;
  readonly tenantId: string;
  readonly transitioned: boolean;
  readonly conflictDetected: boolean;
  readonly previousStatus: TenantStatus | null;
  readonly currentStatus: TenantStatus | null;
  readonly evaluation: EntitlementEvaluationResult | null;
}

/**
 * Synchronizes `PLATFORM_DB.tenants.status` with the wall-clock effective entitlement status
 * using optimistic CAS (`WHERE id = ? AND version = ? AND status = ? AND operator_hold = ?`).
 *
 * - Safe under concurrent payment settlements and manual operator holds: if another transaction
 *   bumped `version`, this function detects the CAS miss and returns the fresh authoritative state
 *   without overwriting payment or hold state.
 * - Never deletes tenant data or touches `TenantStore`.
 */
export async function syncTenantStoredLifecycleState(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly nowMs?: number;
  },
): Promise<SyncTenantLifecycleResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const row = await loadTenantRowForLifecycle(db, input.tenantId);
  if (!row) {
    return {
      found: false,
      tenantId: input.tenantId,
      transitioned: false,
      conflictDetected: false,
      previousStatus: null,
      currentStatus: null,
      evaluation: null,
    };
  }

  const evaluation = evaluateRow(row, nowMs);
  if (!evaluation.needsStoredSync) {
    return {
      found: true,
      tenantId: row.id,
      transitioned: false,
      conflictDetected: false,
      previousStatus: row.status,
      currentStatus: evaluation.effectiveStatus,
      evaluation,
    };
  }

  const computedDeletionDueAt =
    row.deletion_due_at ??
    (row.paid_through !== null
      ? row.paid_through + PAID_DELETION_WINDOW_MS
      : row.trial_ends_at !== null
        ? row.trial_ends_at + TRIAL_DELETION_WINDOW_MS
        : null);

  const updateRes = await db
    .prepare(
      `UPDATE tenants
       SET status = ?,
           deletion_due_at = COALESCE(deletion_due_at, ?),
           cache_version = cache_version + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?
         AND status = ?
         AND operator_hold = ?`,
    )
    .bind(
      evaluation.effectiveStatus,
      computedDeletionDueAt,
      nowMs,
      row.id,
      row.version,
      row.status,
      row.operator_hold,
    )
    .run();

  if ((updateRes.meta?.changes ?? 0) === 1) {
    evictTenantFromCache(row.id);
    const freshRow = await loadTenantRowForLifecycle(db, row.id);
    const freshEval = freshRow ? evaluateRow(freshRow, nowMs) : evaluation;
    return {
      found: true,
      tenantId: row.id,
      transitioned: true,
      conflictDetected: false,
      previousStatus: row.status,
      currentStatus: freshEval.effectiveStatus,
      evaluation: freshEval,
    };
  }

  // Concurrent write (payment settlement or operator hold) won the CAS race: re-read authoritative state!
  const freshRow = await loadTenantRowForLifecycle(db, row.id);
  const freshEval = freshRow ? evaluateRow(freshRow, nowMs) : null;
  return {
    found: Boolean(freshRow),
    tenantId: row.id,
    transitioned: false,
    conflictDetected: true,
    previousStatus: row.status,
    currentStatus: freshEval?.effectiveStatus ?? null,
    evaluation: freshEval,
  };
}

export interface ApplyVerifiedEntitlementGrantInput {
  readonly tenantId: string;
  readonly settlementId: string;
  readonly plan: BillingPlanInterval;
  readonly grantedBy: string;
  readonly nowMs?: number;
  readonly maxCasRetries?: number;
  /**
   * Optional statements prepended into the SAME atomic `db.batch([...])` transaction
   * (used by `settleVerifiedPaymentAttempt` so settlement + attempt + obligation +
   * entitlement grant + tenant update + `platform_audit` commit or roll back together).
   */
  readonly preGrantStatements?: (ctx: {
    readonly tenantRow: TenantLifecycleRow;
    readonly transition: SettlementEntitlementTransition;
    readonly grantId: string;
    readonly nowMs: number;
  }) => readonly D1PreparedStatement[];
  /**
   * Optional statements prepended atomically when the tenant is in a terminal/non-commercial
   * state (`provisioning`, `purging`, `purged`, `recovery`) so attempt/obligation review
   * flags commit together with the deferred audit row.
   */
  readonly onDeferredTerminalStateStatements?: (ctx: {
    readonly tenantRow: TenantLifecycleRow;
    readonly nowMs: number;
  }) => readonly D1PreparedStatement[];
  /** When true, requires the `settlementId` row to exist in `settlements` before inserting grant. */
  readonly requireSettlementRow?: boolean;
  /** Optional custom audit action / role / reason / requestId / metadata merged into the grant audit row. */
  readonly auditAction?: string;
  readonly auditActorRole?: string;
  readonly auditRequestId?: string | null;
  readonly auditReason?: string | null;
  readonly auditMetadata?: Readonly<Record<string, unknown>>;
  /** When true, only inserts the audit row if the preceding tenant UPDATE modified 1 row (`changes() = 1`). */
  readonly conditionalAuditOnTenantUpdate?: boolean;
}

export interface ApplyVerifiedEntitlementGrantResult {
  readonly applied: boolean;
  readonly alreadyGranted: boolean;
  readonly deferredTerminalState?: boolean;
  readonly reviewRequired?: boolean;
  readonly tenantId: string;
  readonly settlementId: string;
  readonly grantId: string | null;
  readonly auditId?: string | null;
  readonly nextStatus: TenantStatus;
  readonly operatorHoldPreserved: boolean;
  readonly periodStartAtMs: number;
  readonly periodEndAtMs: number;
  readonly paidThroughMs: number;
}

/**
 * Applies a verified subscription settlement entitlement grant **exactly once** per `settlementId`
 * with optimistic CAS retries so concurrent expiry sweeps or operator holds can NEVER lose a paid
 * period, duplicate a grant, lift an operator manual hold, or resurrect a terminal/non-commercial
 * tenant (`provisioning`, `purging`, `purged`, `recovery`) (PLAN §16.3, §17.1; REQ-057, REQ-060).
 */
export async function applyVerifiedEntitlementGrant(
  db: D1Database,
  input: ApplyVerifiedEntitlementGrantInput,
): Promise<ApplyVerifiedEntitlementGrantResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const maxRetries = Math.max(1, Math.min(8, input.maxCasRetries ?? 4));

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    // 1. Check idempotency: if this settlement already has a grant, return it without extending twice.
    const existingGrant = await db
      .prepare(
        `SELECT id, period_start, period_end
         FROM entitlement_grants
         WHERE settlement_id = ?
         LIMIT 1`,
      )
      .bind(input.settlementId)
      .first<{ readonly id: string; readonly period_start: number; readonly period_end: number }>();

    const row = await loadTenantRowForLifecycle(db, input.tenantId);
    if (!row) {
      throw new Error(`TENANT_NOT_FOUND: tenant "${input.tenantId}" does not exist`);
    }

    if (existingGrant) {
      const currentEval = evaluateRow(row, nowMs);
      return {
        applied: false,
        alreadyGranted: true,
        tenantId: row.id,
        settlementId: input.settlementId,
        grantId: existingGrant.id,
        nextStatus: currentEval.effectiveStatus,
        operatorHoldPreserved: row.operator_hold === 1,
        periodStartAtMs: existingGrant.period_start,
        periodEndAtMs: existingGrant.period_end,
        paidThroughMs: row.paid_through ?? existingGrant.period_end,
      };
    }

    // Hard guard: NEVER resurrect or alter terminal/non-commercial states (`provisioning`, `purging`, `purged`, `recovery`).
    // Record an audited deferred-review entry instead so late money is tracked without reviving the tenant.
    if (NON_COMMERCIAL_TERMINAL_STATES.has(row.status)) {
      const { statement: deferredAuditStmt, entry: deferredAuditEntry } = buildPlatformAuditStatement(db, {
        actorUserId: input.grantedBy,
        actorRole: input.auditActorRole ?? "system",
        action: "billing.entitlement.deferred_terminal_state",
        targetType: "tenant",
        targetId: row.id,
        tenantId: row.id,
        outcome: "denied",
        reason: input.auditReason ?? null,
        requestId: input.auditRequestId ?? null,
        metadata: {
          ...input.auditMetadata,
          settlementId: input.settlementId,
          plan: input.plan,
          storedStatus: row.status,
          reviewRequired: true,
        },
        createdAtMs: nowMs,
      });
      const deferredPre = input.onDeferredTerminalStateStatements
        ? input.onDeferredTerminalStateStatements({ tenantRow: row, nowMs })
        : [];
      if (deferredPre.length > 0) {
        await db.batch([...deferredPre, deferredAuditStmt]);
      } else {
        await deferredAuditStmt.run();
      }
      return {
        applied: false,
        alreadyGranted: false,
        deferredTerminalState: true,
        reviewRequired: true,
        tenantId: row.id,
        settlementId: input.settlementId,
        grantId: null,
        auditId: deferredAuditEntry.id,
        nextStatus: row.status,
        operatorHoldPreserved: row.operator_hold === 1,
        periodStartAtMs: nowMs,
        periodEndAtMs: nowMs,
        paidThroughMs: row.paid_through ?? 0,
      };
    }

    const operatorHold = row.operator_hold === 1;
    const transition = computeSettlementEntitlementTransition({
      plan: input.plan,
      storedStatus: row.status,
      operatorHold,
      paidThroughMs: row.paid_through,
      trialEndsAtMs: row.trial_ends_at,
      nowMs,
    });

    const grantId = generateBillingUlid(nowMs);
    const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
      db,
      {
        actorUserId: input.grantedBy,
        actorRole: input.auditActorRole ?? "system",
        action: input.auditAction ?? "billing.entitlement.grant_applied",
        targetType: "tenant",
        targetId: row.id,
        tenantId: row.id,
        outcome: "success",
        reason: input.auditReason ?? null,
        requestId: input.auditRequestId ?? null,
        metadata: {
          ...input.auditMetadata,
          settlementId: input.settlementId,
          grantId,
          plan: input.plan,
          renewalAnchor: transition.renewalAnchor,
          periodStartAtMs: transition.periodStartAtMs,
          periodEndAtMs: transition.periodEndAtMs,
          nextStatus: transition.nextStatus,
          operatorHoldPreserved: transition.operatorHoldPreserved,
        },
        createdAtMs: nowMs,
      },
      input.conditionalAuditOnTenantUpdate ? { onlyIfPreviousChanged: true } : undefined,
    );

    const preStmts = input.preGrantStatements
      ? input.preGrantStatements({ tenantRow: row, transition, grantId, nowMs })
      : [];

    const grantInsertStmt = input.requireSettlementRow
      ? db
          .prepare(
            `INSERT INTO entitlement_grants (
               id, tenant_id, settlement_id, period_start, period_end, granted_by, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM entitlement_grants WHERE settlement_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM settlements WHERE id = ? AND tenant_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM tenants
               WHERE id = ?
                 AND version = ?
                 AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
             )`,
          )
          .bind(
            grantId,
            row.id,
            input.settlementId,
            transition.periodStartAtMs,
            transition.periodEndAtMs,
            input.grantedBy,
            nowMs,
            input.settlementId,
            input.settlementId,
            row.id,
            row.id,
            row.version,
          )
      : db
          .prepare(
            `INSERT INTO entitlement_grants (
               id, tenant_id, settlement_id, period_start, period_end, granted_by, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM entitlement_grants WHERE settlement_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM tenants
               WHERE id = ?
                 AND version = ?
                 AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
             )`,
          )
          .bind(
            grantId,
            row.id,
            input.settlementId,
            transition.periodStartAtMs,
            transition.periodEndAtMs,
            input.grantedBy,
            nowMs,
            input.settlementId,
            row.id,
            row.version,
          );

    const tenantUpdateStmt = db
      .prepare(
        `UPDATE tenants
         SET status = CASE WHEN operator_hold = 1 THEN 'suspended' ELSE 'active' END,
             paid_through = MAX(COALESCE(paid_through, 0), ?),
             deletion_due_at = CASE WHEN operator_hold = 1 THEN deletion_due_at ELSE ? END,
             cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
           AND EXISTS (
             SELECT 1 FROM entitlement_grants WHERE id = ? AND settlement_id = ?
           )`,
      )
      .bind(
        transition.nextPaidThroughMs,
        transition.nextDeletionDueAtMs,
        nowMs,
        row.id,
        row.version,
        grantId,
        input.settlementId,
      );

    // Atomic batch:
    // - Optional pre-grant statements (settlement + attempt + obligation updates)
    // - Insert grant ONLY if no grant for settlementId exists AND tenant version still matches
    //   AND tenant is NOT in a terminal/non-commercial state (`provisioning`, `purging`, `purged`, `recovery`).
    // - Update tenant status/paid_through ONLY if version still matches, status is commercial,
    //   and grant was just inserted for this settlementId (preserving `operator_hold = 1 -> 'suspended'`
    //   and keeping `deletion_due_at` paused/unchanged while under operator hold!).
    // - Append `platform_audit` (rolls back entire batch if audit persistence fails!).
    const batchResults = await db.batch([
      ...preStmts,
      grantInsertStmt,
      tenantUpdateStmt,
      auditStmt,
    ]);

    const grantInsertRes = batchResults[preStmts.length];
    const tenantUpdateRes = batchResults[preStmts.length + 1];

    const grantInserted = (grantInsertRes?.meta?.changes ?? 0) === 1;
    const tenantUpdated = (tenantUpdateRes?.meta?.changes ?? 0) === 1;

    if (grantInserted && tenantUpdated) {
      evictTenantFromCache(row.id);
      return {
        applied: true,
        alreadyGranted: false,
        tenantId: row.id,
        settlementId: input.settlementId,
        grantId,
        auditId: auditEntry.id,
        nextStatus: transition.nextStatus,
        operatorHoldPreserved: transition.operatorHoldPreserved,
        periodStartAtMs: transition.periodStartAtMs,
        periodEndAtMs: transition.periodEndAtMs,
        paidThroughMs: transition.nextPaidThroughMs,
      };
    }

    // CAS collision (concurrent expiry sweep, concurrent operator hold, terminal transition,
    // or duplicate settlement): loop re-reads fresh state and either defers or retries cleanly.
  }

  throw new Error(
    `ENTITLEMENT_CAS_CONFLICT: failed to apply entitlement grant for tenant "${input.tenantId}" after ${maxRetries} retries`,
  );
}

export interface SetOperatorManualHoldResult {
  readonly updated: boolean;
  readonly tenantId: string;
  readonly operatorHold: boolean;
  readonly effectiveStatus: TenantStatus;
}

/**
 * Sets or lifts an explicit manual operator hold on a commercial-lifecycle tenant using atomic CAS + audit.
 * - Rejects `provisioning`, `purging`, `purged`, and `recovery` with `InvalidLifecycleStateError` (409)
 *   for BOTH hold and release so terminal/recovery states can never be overwritten or resurrected.
 * - Applying a hold forces `operator_hold = 1`, `status = 'suspended'`, pauses retention deletion clock,
 *   and survives any subsequent payment settlement.
 * - Lifting a hold recalculates the tenant's true commercial status from `paid_through`/`trial_ends_at`
 *   at `nowMs` strictly for commercial states (`trial`, `active`, `grace`, `locked`, `suspended`).
 */
export async function setOperatorManualHold(
  db: D1Database,
  input: {
    readonly tenantId: string;
    readonly hold: boolean;
    readonly reason: string | null;
    readonly operatorUserId: string;
    readonly nowMs?: number;
    readonly maxCasRetries?: number;
  },
): Promise<SetOperatorManualHoldResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const maxRetries = Math.max(1, Math.min(8, input.maxCasRetries ?? 4));
  const cleanReason =
    input.hold && input.reason && input.reason.trim().length > 0 ? input.reason.trim() : null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const row = await loadTenantRowForLifecycle(db, input.tenantId);
    if (!row) {
      throw new Error(`TENANT_NOT_FOUND: tenant "${input.tenantId}" does not exist`);
    }

    if (NON_COMMERCIAL_TERMINAL_STATES.has(row.status)) {
      throw new InvalidLifecycleStateError(row.id, row.status);
    }

    let nextStatus: TenantStatus;
    if (input.hold) {
      nextStatus = "suspended";
    } else {
      // Re-evaluate true commercial status once operator hold is removed (commercial rows only)
      const commercialEval = evaluateEntitlementState({
        storedStatus: row.paid_through !== null ? "active" : row.trial_ends_at !== null ? "trial" : "suspended",
        operatorHold: false,
        trialEndsAtMs: row.trial_ends_at,
        paidThroughMs: row.paid_through,
        nowMs,
      });
      nextStatus = commercialEval.effectiveStatus;
    }

    const { statement: auditStmt } = buildPlatformAuditStatement(db, {
      actorUserId: input.operatorUserId,
      actorRole: "platform_operator",
      action: input.hold ? "console.tenant.operator_hold_set" : "console.tenant.operator_hold_cleared",
      targetType: "tenant",
      targetId: row.id,
      tenantId: row.id,
      outcome: "success",
      reason: cleanReason,
      metadata: {
        previousStatus: row.status,
        nextStatus,
        operatorHold: input.hold,
      },
      createdAtMs: nowMs,
    });

    const [updateRes] = await db.batch([
      db
        .prepare(
          `UPDATE tenants
           SET operator_hold = ?,
               operator_hold_reason = ?,
               status = ?,
               retention_paused_at = CASE WHEN ? = 1 THEN COALESCE(retention_paused_at, ?) ELSE NULL END,
               cache_version = cache_version + 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')`,
        )
        .bind(
          input.hold ? 1 : 0,
          cleanReason,
          nextStatus,
          input.hold ? 1 : 0,
          nowMs,
          nowMs,
          row.id,
          row.version,
        ),
      auditStmt,
    ]);

    if ((updateRes?.meta?.changes ?? 0) === 1) {
      evictTenantFromCache(row.id);
      return {
        updated: true,
        tenantId: row.id,
        operatorHold: input.hold,
        effectiveStatus: nextStatus,
      };
    }
  }

  throw new Error(
    `OPERATOR_HOLD_CAS_CONFLICT: failed to update operator hold for tenant "${input.tenantId}"`,
  );
}

// ---------------------------------------------------------------------------
// Single-Use, Hashed, Grace-Expiring One-Click Renewal Pay Links (DEC-035 C17)
// ---------------------------------------------------------------------------

export interface IssueRenewalPayLinkInput {
  readonly tenantId: string;
  readonly obligationId?: string | null;
  readonly payerUserId?: string | null;
  readonly payerAgencyId?: string | null;
  readonly reminderKind: RenewalReminderKind;
  readonly cycleAnchorMs: number;
  readonly expiresAtMs: number;
  readonly appOrigin?: string;
  readonly nowMs?: number;
}

export type IssueRenewalPayLinkResult =
  | {
      readonly created: true;
      readonly id: string;
      readonly tenantId: string;
      readonly reminderKind: RenewalReminderKind;
      readonly cycleAnchorMs: number;
      readonly expiresAtMs: number;
      readonly tokenHash: string;
      /** Plaintext token returned ONLY at issuance time so caller can build the email link; never persisted! */
      readonly rawToken: string;
      readonly payUrl: string;
    }
  | {
      readonly created: false;
      readonly duplicate: true;
      readonly tenantId: string;
      readonly reminderKind: RenewalReminderKind;
      readonly cycleAnchorMs: number;
    };

/**
 * Issues a single-use, SHA-256 hashed, grace-expiring one-click renewal pay link bound to
 * `(tenantId, reminderKind, cycleAnchorMs)` (DEC-035 C17, PLAN §17.3).
 *
 * - Deduplicates atomically per `(tenantId, reminderKind, cycleAnchorMs)` so repeated sweeps
 *   never issue duplicate reminders or tokens for the same cycle.
 * - Plaintext token is NEVER stored in D1; only its SHA-256 digest is saved.
 */
export async function issueRenewalPayLink(
  db: D1Database,
  input: IssueRenewalPayLinkInput,
): Promise<IssueRenewalPayLinkResult> {
  await ensureRenewalPayLinksSchema(db);

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const cycleAnchorMs = Math.trunc(input.cycleAnchorMs);
  const expiresAtMs = Math.trunc(input.expiresAtMs);
  if (expiresAtMs <= nowMs) {
    throw new RangeError("INVALID_LINK_EXPIRY: expiresAtMs must be in the future");
  }

  const id = `rpl_${generateBillingUlid(nowMs)}`;
  const rawToken = generateSecureHexToken(32);
  const tokenHash = await hashRenewalPayLinkToken(rawToken);

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO billing_renewal_pay_links (
         id, tenant_id, obligation_id, payer_user_id, payer_agency_id,
         reminder_kind, cycle_anchor_ms, token_hash, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.obligationId ?? null,
      input.payerUserId ?? null,
      input.payerAgencyId ?? null,
      input.reminderKind,
      cycleAnchorMs,
      tokenHash,
      expiresAtMs,
      nowMs,
    )
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    return {
      created: false,
      duplicate: true,
      tenantId: input.tenantId,
      reminderKind: input.reminderKind,
      cycleAnchorMs,
    };
  }

  const origin = (input.appOrigin ?? "https://app.punyasitus.com").replace(/\/+$/, "");
  const payUrl = `${origin}/pay/renew?token=${encodeURIComponent(rawToken)}`;

  return {
    created: true,
    id,
    tenantId: input.tenantId,
    reminderKind: input.reminderKind,
    cycleAnchorMs,
    expiresAtMs,
    tokenHash,
    rawToken,
    payUrl,
  };
}

export interface ConsumedRenewalPayLink {
  readonly id: string;
  readonly tenantId: string;
  readonly obligationId: string | null;
  readonly payerUserId: string | null;
  readonly payerAgencyId: string | null;
  readonly reminderKind: RenewalReminderKind;
  readonly cycleAnchorMs: number;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number;
  /** Explicit security invariants (DEC-035 C17): NEVER activates service or creates an admin session. */
  readonly grantsAdminSession: false;
  readonly activatesService: false;
}

export type ConsumeRenewalPayLinkResult =
  | {
      readonly ok: true;
      readonly link: ConsumedRenewalPayLink;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_token" | "already_used" | "expired" | "tenant_mismatch";
    };

interface RenewalPayLinkSqlRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly obligation_id: string | null;
  readonly payer_user_id: string | null;
  readonly payer_agency_id: string | null;
  readonly reminder_kind: RenewalReminderKind;
  readonly cycle_anchor_ms: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

/**
 * Atomically consumes a single-use grace-expiring one-click renewal pay link (`DEC-035 C17`).
 *
 * - Uses atomic conditional `UPDATE ... WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
 *   so concurrent redemptions succeed at most once.
 * - Rejects expired links (`nowMs >= expiresAtMs`, i.e., after grace window ends), reused links,
 *   forged tokens, and cross-tenant binding mismatches.
 * - NEVER activates service, NEVER grants entitlement, and NEVER creates/leaks an admin session.
 */
export async function consumeRenewalPayLink(
  db: D1Database,
  input: {
    readonly rawToken: string;
    readonly expectedTenantId?: string;
    readonly nowMs?: number;
  },
): Promise<ConsumeRenewalPayLinkResult> {
  await ensureRenewalPayLinksSchema(db);

  const trimmed = input.rawToken.trim();
  if (!trimmed || trimmed.length < 16 || trimmed.length > 256) {
    return { ok: false, reason: "invalid_token" };
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tokenHash = await hashRenewalPayLinkToken(trimmed);
  const expectedTenantId = input.expectedTenantId?.trim() || null;

  const updateRes = expectedTenantId
    ? await db
        .prepare(
          `UPDATE billing_renewal_pay_links
           SET consumed_at = ?
           WHERE token_hash = ?
             AND tenant_id = ?
             AND consumed_at IS NULL
             AND expires_at > ?`,
        )
        .bind(nowMs, tokenHash, expectedTenantId, nowMs)
        .run()
    : await db
        .prepare(
          `UPDATE billing_renewal_pay_links
           SET consumed_at = ?
           WHERE token_hash = ?
             AND consumed_at IS NULL
             AND expires_at > ?`,
        )
        .bind(nowMs, tokenHash, nowMs)
        .run();

  const row = await db
    .prepare(
      `SELECT id, tenant_id, obligation_id, payer_user_id, payer_agency_id,
              reminder_kind, cycle_anchor_ms, expires_at, consumed_at
       FROM billing_renewal_pay_links
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<RenewalPayLinkSqlRow>();

  if (!row) {
    return { ok: false, reason: "invalid_token" };
  }

  if ((updateRes.meta?.changes ?? 0) === 1) {
    return {
      ok: true,
      link: {
        id: row.id,
        tenantId: row.tenant_id,
        obligationId: row.obligation_id,
        payerUserId: row.payer_user_id,
        payerAgencyId: row.payer_agency_id,
        reminderKind: row.reminder_kind,
        cycleAnchorMs: row.cycle_anchor_ms,
        expiresAtMs: row.expires_at,
        consumedAtMs: row.consumed_at ?? nowMs,
        grantsAdminSession: false,
        activatesService: false,
      },
    };
  }

  if (expectedTenantId && row.tenant_id !== expectedTenantId) {
    return { ok: false, reason: "tenant_mismatch" };
  }
  if (row.consumed_at !== null) {
    return { ok: false, reason: "already_used" };
  }
  if (nowMs >= row.expires_at) {
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "invalid_token" };
}

export interface RenewalPayLinkLookupRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly obligationId: string | null;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number | null;
}

/**
 * Looks up a renewal pay link by hashing `rawToken` (never stores or logs plaintext tokens)
 * alongside minimal tenant routing metadata needed by `GET /pay/renew`.
 */
export async function lookupRenewalPayLinkByToken(
  db: D1Database,
  rawToken: string,
): Promise<RenewalPayLinkLookupRecord | null> {
  await ensureRenewalPayLinksSchema(db);

  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.length < 16 || trimmed.length > 256) {
    return null;
  }

  const tokenHash = await hashRenewalPayLinkToken(trimmed);
  interface LookupRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly tenant_handle: string;
    readonly tenant_status: TenantStatus;
    readonly operator_hold: number;
    readonly obligation_id: string | null;
    readonly expires_at: number;
    readonly consumed_at: number | null;
  }

  const row = await db
    .prepare(
      `SELECT l.id, l.tenant_id, t.handle AS tenant_handle, t.status AS tenant_status,
              t.operator_hold, l.obligation_id, l.expires_at, l.consumed_at
       FROM billing_renewal_pay_links l
       INNER JOIN tenants t ON t.id = l.tenant_id
       WHERE l.token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<LookupRow>();

  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantStatus: row.tenant_status,
    operatorHold: row.operator_hold === 1,
    obligationId: row.obligation_id,
    expiresAtMs: row.expires_at,
    consumedAtMs: row.consumed_at,
  };
}

/**
 * Releases an unconsumed renewal pay link row after a definite email delivery refusal/error
 * so a subsequent sweep can safely re-issue and send the reminder (never deletes consumed links).
 */
export async function releaseFailedRenewalPayLink(
  db: D1Database,
  linkId: string,
): Promise<boolean> {
  await ensureRenewalPayLinksSchema(db);
  const res = await db
    .prepare("DELETE FROM billing_renewal_pay_links WHERE id = ? AND consumed_at IS NULL")
    .bind(linkId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export interface SweepCandidateTenantRow extends TenantLifecycleRow {
  readonly payer_user_id: string | null;
  readonly payer_email: string | null;
  readonly payer_name: string | null;
  readonly open_obligation_id: string | null;
}

/**
 * Lists non-terminal tenants eligible for timed entitlement synchronization or renewal reminders,
 * resolving the authoritative payer contact (agency billing email for agency-managed sites per
 * PLAN §17.2, or owner member email otherwise).
 */
export async function listTenantsForLifecycleSweep(
  db: D1Database,
  options: { readonly limit?: number } = {},
): Promise<readonly SweepCandidateTenantRow[]> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const res = await db
    .prepare(
      `SELECT t.id, t.organization_id, t.agency_id, t.handle, t.name, t.status,
              t.operator_hold, t.operator_hold_reason, t.trial_ends_at, t.paid_through,
              t.deletion_due_at, t.retention_paused_at, t.cache_version, t.version,
              CASE WHEN t.agency_id IS NOT NULL THEN a.owner_user_id ELSE om.user_id END AS payer_user_id,
              CASE WHEN t.agency_id IS NOT NULL THEN au.email ELSE ou.email END AS payer_email,
              CASE WHEN t.agency_id IS NOT NULL THEN a.name ELSE ou.name END AS payer_name,
              (
                SELECT bo.id FROM billing_obligations bo
                WHERE bo.tenant_id = t.id AND bo.status = 'open'
                ORDER BY bo.created_at DESC
                LIMIT 1
              ) AS open_obligation_id
       FROM tenants t
       LEFT JOIN agencies a ON a.id = t.agency_id
       LEFT JOIN users au ON au.id = a.owner_user_id
       LEFT JOIN members om ON om.organization_id = t.organization_id AND om.role = 'owner'
       LEFT JOIN users ou ON ou.id = om.user_id
       WHERE t.status IN ('trial', 'active', 'grace', 'locked')
       ORDER BY t.id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<SweepCandidateTenantRow>();

  return res.results ?? [];
}
