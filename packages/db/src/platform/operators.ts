import {
  appendPlatformAudit,
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "./audit.ts";

/**
 * Authoritative `PLATFORM_DB.platform_operators` grant repository and atomic
 * bootstrap / grant / revoke mutations (PLAN §13; REQ-051).
 *
 * Security invariants:
 * - Active platform operator authority exists ONLY when `platform_operators.revoked_at IS NULL`.
 * - Every bootstrap, grant, and revoke commits its state change AND its `platform_audit`
 *   row inside a SINGLE atomic `D1Database.batch([...])` transaction: if audit persistence
 *   fails, the operator state mutation is rolled back completely.
 * - Revocation enforces final-operator protection atomically in SQL (`COUNT(*) > 1`)
 *   so concurrent revocations can NEVER remove the final active operator.
 * - Initial bootstrap requires an existing verified account (`users.email_verified = 1`);
 *   never creates public signups or default passwords.
 */

export type PlatformOperatorErrorCode =
  | "VALIDATION_ERROR"
  | "USER_NOT_FOUND"
  | "USER_NOT_VERIFIED"
  | "OPERATOR_NOT_FOUND"
  | "OPERATOR_ALREADY_ACTIVE"
  | "OPERATOR_ALREADY_REVOKED"
  | "ALREADY_BOOTSTRAPPED"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "FINAL_OPERATOR_PROTECTED"
  | "AUDIT_PERSISTENCE_FAILED";

export class PlatformOperatorError extends Error {
  readonly status: 403 | 404 | 409 | 422 | 500;
  readonly code: PlatformOperatorErrorCode;

  constructor(
    status: 403 | 404 | 409 | 422 | 500,
    code: PlatformOperatorErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PlatformOperatorError";
    this.status = status;
    this.code = code;
  }
}

export const PLATFORM_OPERATOR_ROLES = [
  "platform_superadmin",
  "platform_support",
] as const;
export type PlatformOperatorRole = (typeof PLATFORM_OPERATOR_ROLES)[number];

export function isValidPlatformOperatorRole(raw: unknown): raw is PlatformOperatorRole {
  return (
    typeof raw === "string" &&
    (PLATFORM_OPERATOR_ROLES as readonly string[]).includes(raw)
  );
}

interface TableInfoColumnRow {
  readonly name: string;
}

async function hasOperatorRoleColumns(platformDb: D1Database): Promise<boolean> {
  try {
    const info = await platformDb
      .prepare("PRAGMA table_info(platform_operators)")
      .all<TableInfoColumnRow>();
    const names = new Set((info.results ?? []).map((r) => r.name));
    return names.has("role") && names.has("version");
  } catch {
    return false;
  }
}

/**
 * Idempotently applies migration `0005_platform_operator_roles` in local/test runtimes
 * without altering `PLATFORM_MIGRATIONS` (preserving TASK-001/049/067 checksums).
 */
export async function ensurePlatformOperatorRolesSchema(
  platformDb: D1Database,
): Promise<void> {
  const info = await platformDb
    .prepare("PRAGMA table_info(platform_operators)")
    .all<TableInfoColumnRow>();
  const existing = new Set((info.results ?? []).map((r) => r.name));
  if (existing.size === 0) return;

  if (!existing.has("role")) {
    await platformDb
      .prepare(
        "ALTER TABLE platform_operators ADD COLUMN role TEXT NOT NULL DEFAULT 'platform_superadmin' CHECK (role IN ('platform_superadmin', 'platform_support'))",
      )
      .run();
  }
  if (!existing.has("version")) {
    await platformDb
      .prepare("ALTER TABLE platform_operators ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
      .run();
  }
}

export interface PlatformOperatorRecord {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  readonly role: PlatformOperatorRole;
  readonly version: number;
  readonly grantedBy: string | null;
  readonly reason: string;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly isActive: boolean;
}

export interface BootstrapPlatformOperatorInput {
  readonly userId?: string;
  readonly email?: string;
  readonly reason: string;
  readonly requestId?: string;
  /**
   * Set true ONLY during explicit audited lost-factor recovery when another active
   * operator already exists. Default false refuses bootstrap once any active operator exists.
   */
  readonly allowAdditional?: boolean;
  readonly nowMs?: number;
}

export interface GrantPlatformOperatorInput {
  readonly actorUserId: string;
  readonly targetUserId?: string;
  readonly targetEmail?: string;
  readonly role?: PlatformOperatorRole;
  readonly reason: string;
  readonly requestId?: string;
  readonly nowMs?: number;
}

export interface RevokePlatformOperatorInput {
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly reason: string;
  readonly requestId?: string;
  readonly nowMs?: number;
}

export interface PlatformOperatorMutationResult {
  readonly operator: PlatformOperatorRecord;
  readonly audit: PlatformAuditRecord;
}

interface OperatorJoinedRow {
  readonly user_id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly email_verified: number;
  readonly two_factor_enabled: number;
  readonly role?: string | null;
  readonly version?: number | null;
  readonly granted_by: string | null;
  readonly reason: string;
  readonly granted_at: number;
  readonly revoked_at: number | null;
  readonly revoked_by: string | null;
  readonly revoke_reason: string | null;
}

interface UserLookupRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly email_verified: number;
  readonly two_factor_enabled: number;
}

function mapOperatorRow(row: OperatorJoinedRow): PlatformOperatorRecord {
  const role: PlatformOperatorRole = isValidPlatformOperatorRole(row.role)
    ? row.role
    : "platform_superadmin";
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    emailVerified: row.email_verified === 1,
    twoFactorEnabled: row.two_factor_enabled === 1,
    role,
    version: typeof row.version === "number" && Number.isFinite(row.version) ? row.version : 1,
    grantedBy: row.granted_by,
    reason: row.reason,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    isActive: row.revoked_at === null,
  };
}

function normalizeValidatedReason(rawReason: string): string {
  try {
    return validateOperatorReason(rawReason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new PlatformOperatorError(422, "VALIDATION_ERROR", err.message, err);
    }
    throw err;
  }
}

async function lookupUserByIdOrEmail(
  platformDb: D1Database,
  selector: { readonly userId?: string; readonly email?: string },
): Promise<UserLookupRow | null> {
  const userId = selector.userId?.trim();
  if (userId) {
    const row = await platformDb
      .prepare(
        "SELECT id, email, name, email_verified, two_factor_enabled FROM users WHERE id = ? LIMIT 1",
      )
      .bind(userId)
      .first<UserLookupRow>();
    return row ?? null;
  }

  const email = selector.email?.trim().toLowerCase();
  if (email) {
    const row = await platformDb
      .prepare(
        "SELECT id, email, name, email_verified, two_factor_enabled FROM users WHERE lower(email) = ? LIMIT 1",
      )
      .bind(email)
      .first<UserLookupRow>();
    return row ?? null;
  }

  throw new PlatformOperatorError(
    422,
    "VALIDATION_ERROR",
    "Either userId or email must be provided.",
  );
}

/**
 * Returns the active `platform_operators` grant for `userId` (`revoked_at IS NULL`),
 * or `null` when the user has no grant or their grant was revoked.
 */
export async function getActivePlatformOperator(
  platformDb: D1Database,
  userId: string,
): Promise<PlatformOperatorRecord | null> {
  const cleanUserId = userId.trim();
  if (!cleanUserId) return null;

  const hasRoles = await hasOperatorRoleColumns(platformDb);
  const roleSelect = hasRoles ? "po.role, po.version," : "";

  const row = await platformDb
    .prepare(
      `
      SELECT
        po.user_id,
        u.email,
        u.name,
        u.email_verified,
        u.two_factor_enabled,
        ${roleSelect}
        po.granted_by,
        po.reason,
        po.granted_at,
        po.revoked_at,
        po.revoked_by,
        po.revoke_reason
      FROM platform_operators po
      INNER JOIN users u ON u.id = po.user_id
      WHERE po.user_id = ? AND po.revoked_at IS NULL
      LIMIT 1
      `,
    )
    .bind(cleanUserId)
    .first<OperatorJoinedRow>();

  return row ? mapOperatorRow(row) : null;
}

/**
 * Returns the `platform_operators` grant row (active or revoked) for `userId`, or `null`.
 */
export async function getPlatformOperatorGrant(
  platformDb: D1Database,
  userId: string,
): Promise<PlatformOperatorRecord | null> {
  const cleanUserId = userId.trim();
  if (!cleanUserId) return null;

  const hasRoles = await hasOperatorRoleColumns(platformDb);
  const roleSelect = hasRoles ? "po.role, po.version," : "";

  const row = await platformDb
    .prepare(
      `
      SELECT
        po.user_id,
        u.email,
        u.name,
        u.email_verified,
        u.two_factor_enabled,
        ${roleSelect}
        po.granted_by,
        po.reason,
        po.granted_at,
        po.revoked_at,
        po.revoked_by,
        po.revoke_reason
      FROM platform_operators po
      INNER JOIN users u ON u.id = po.user_id
      WHERE po.user_id = ?
      LIMIT 1
      `,
    )
    .bind(cleanUserId)
    .first<OperatorJoinedRow>();

  return row ? mapOperatorRow(row) : null;
}

/**
 * Lists platform operator grants (active first, then revoked).
 */
export async function listPlatformOperators(
  platformDb: D1Database,
  options: { readonly includeRevoked?: boolean; readonly limit?: number } = {},
): Promise<readonly PlatformOperatorRecord[]> {
  const includeRevoked = options.includeRevoked ?? true;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const whereClause = includeRevoked ? "" : "WHERE po.revoked_at IS NULL";
  const hasRoles = await hasOperatorRoleColumns(platformDb);
  const roleSelect = hasRoles ? "po.role, po.version," : "";

  const result = await platformDb
    .prepare(
      `
      SELECT
        po.user_id,
        u.email,
        u.name,
        u.email_verified,
        u.two_factor_enabled,
        ${roleSelect}
        po.granted_by,
        po.reason,
        po.granted_at,
        po.revoked_at,
        po.revoked_by,
        po.revoke_reason
      FROM platform_operators po
      INNER JOIN users u ON u.id = po.user_id
      ${whereClause}
      ORDER BY (po.revoked_at IS NULL) DESC, po.granted_at DESC, po.user_id ASC
      LIMIT ?
      `,
    )
    .bind(boundedLimit)
    .all<OperatorJoinedRow>();

  return (result.results ?? []).map(mapOperatorRow);
}

/**
 * Counts currently active platform operators (`revoked_at IS NULL`).
 */
export async function countActivePlatformOperators(platformDb: D1Database): Promise<number> {
  const row = await platformDb
    .prepare("SELECT COUNT(*) AS count FROM platform_operators WHERE revoked_at IS NULL")
    .first<{ readonly count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * Trusted-environment initial operator bootstrap for an existing verified account
 * (`users.email_verified = 1`, never public signup, never default passwords; PLAN §13).
 *
 * Atomically inserts/reactivates `platform_operators` and appends a `platform_audit`
 * row inside one `db.batch([...])` transaction.
 */
export async function bootstrapInitialPlatformOperator(
  platformDb: D1Database,
  input: BootstrapPlatformOperatorInput,
): Promise<PlatformOperatorMutationResult> {
  const cleanReason = normalizeValidatedReason(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const allowAdditional = input.allowAdditional === true;

  const user = await lookupUserByIdOrEmail(platformDb, {
    userId: input.userId,
    email: input.email,
  });
  if (!user) {
    throw new PlatformOperatorError(404, "USER_NOT_FOUND", "Target user account was not found.");
  }
  if (user.email_verified !== 1) {
    throw new PlatformOperatorError(
      403,
      "USER_NOT_VERIFIED",
      "Platform operator bootstrap requires an existing verified account (email_verified = 1).",
    );
  }

  if (!allowAdditional) {
    const activeCount = await countActivePlatformOperators(platformDb);
    if (activeCount > 0) {
      throw new PlatformOperatorError(
        409,
        "ALREADY_BOOTSTRAPPED",
        "An active platform operator already exists; use an authenticated operator grant or explicit recovery mode.",
      );
    }
  }

  const upsertSql = allowAdditional
    ? `
      INSERT INTO platform_operators (
        user_id, granted_by, reason, granted_at, revoked_at, revoked_by, revoke_reason
      )
      SELECT ?, NULL, ?, ?, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 1)
      ON CONFLICT(user_id) DO UPDATE SET
        granted_by = NULL,
        reason = excluded.reason,
        granted_at = excluded.granted_at,
        revoked_at = NULL,
        revoked_by = NULL,
        revoke_reason = NULL
    `
    : `
      INSERT INTO platform_operators (
        user_id, granted_by, reason, granted_at, revoked_at, revoked_by, revoke_reason
      )
      SELECT ?, NULL, ?, ?, NULL, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 1)
        AND (SELECT COUNT(*) FROM platform_operators WHERE revoked_at IS NULL) = 0
      ON CONFLICT(user_id) DO UPDATE SET
        granted_by = NULL,
        reason = excluded.reason,
        granted_at = excluded.granted_at,
        revoked_at = NULL,
        revoked_by = NULL,
        revoke_reason = NULL
      WHERE (SELECT COUNT(*) FROM platform_operators WHERE revoked_at IS NULL) = 0
    `;

  const upsertStmt = platformDb
    .prepare(upsertSql)
    .bind(user.id, cleanReason, nowMs, user.id);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: null,
      actorRole: "system_bootstrap",
      action: "platform_operator.bootstrap",
      targetType: "platform_operator",
      targetId: user.id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        mode: allowAdditional ? "recovery" : "initial_bootstrap",
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([upsertStmt, auditStmt]);
  } catch (err) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Bootstrap transaction failed and was rolled back (audit persistence required).",
      err,
    );
  }

  const upsertChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (upsertChanges !== 1) {
    const activeCount = await countActivePlatformOperators(platformDb);
    if (!allowAdditional && activeCount > 0) {
      throw new PlatformOperatorError(
        409,
        "ALREADY_BOOTSTRAPPED",
        "An active platform operator already exists.",
      );
    }
    throw new PlatformOperatorError(
      403,
      "USER_NOT_VERIFIED",
      "Target account is not eligible for platform operator bootstrap.",
    );
  }

  if (auditChanges !== 1) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Bootstrap audit record was not persisted.",
    );
  }

  const operator = await getPlatformOperatorGrant(platformDb, user.id);
  if (!operator || !operator.isActive) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Bootstrapped platform operator record could not be verified after commit.",
    );
  }

  return { operator, audit: auditEntry };
}

/**
 * Grants (or reactivates) a `platform_operators` role for an existing verified account.
 * Requires an active granting operator and commits grant + `platform_audit` atomically.
 */
export async function grantPlatformOperator(
  platformDb: D1Database,
  input: GrantPlatformOperatorInput,
): Promise<PlatformOperatorMutationResult> {
  const actorUserId = input.actorUserId.trim();
  const rawTargetUserId = input.targetUserId?.trim() ?? "";
  const rawTargetEmail = input.targetEmail?.trim().toLowerCase() ?? "";
  if (!actorUserId || (!rawTargetUserId && !rawTargetEmail)) {
    throw new PlatformOperatorError(
      422,
      "VALIDATION_ERROR",
      "Both actorUserId and either targetUserId or targetEmail are required.",
    );
  }

  const assignedRole: PlatformOperatorRole = input.role ?? "platform_superadmin";
  if (!isValidPlatformOperatorRole(assignedRole)) {
    throw new PlatformOperatorError(
      422,
      "VALIDATION_ERROR",
      `Unsupported platform operator role "${String(input.role)}".`,
    );
  }

  const cleanReason = normalizeValidatedReason(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const actorGrant = await getActivePlatformOperator(platformDb, actorUserId);
  if (!actorGrant) {
    throw new PlatformOperatorError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "An active platform operator grant is required to grant operator access.",
    );
  }

  const targetUser = await lookupUserByIdOrEmail(platformDb, {
    userId: rawTargetUserId || undefined,
    email: rawTargetEmail || undefined,
  });
  if (!targetUser) {
    throw new PlatformOperatorError(404, "USER_NOT_FOUND", "Target user account was not found.");
  }
  const targetUserId = targetUser.id;
  if (targetUser.email_verified !== 1) {
    throw new PlatformOperatorError(
      403,
      "USER_NOT_VERIFIED",
      "Target account must have a verified email before receiving a platform operator grant.",
    );
  }

  const existingGrant = await getPlatformOperatorGrant(platformDb, targetUserId);
  if (existingGrant?.isActive) {
    throw new PlatformOperatorError(
      409,
      "OPERATOR_ALREADY_ACTIVE",
      "Target user already holds an active platform operator grant.",
    );
  }

  const hasRoles = await hasOperatorRoleColumns(platformDb);
  const upsertStmt = hasRoles
    ? platformDb
        .prepare(
          `
          INSERT INTO platform_operators (
            user_id, role, version, granted_by, reason, granted_at, revoked_at, revoked_by, revoke_reason
          )
          SELECT ?, ?, 1, ?, ?, ?, NULL, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
          )
            AND EXISTS (
              SELECT 1 FROM users WHERE id = ? AND email_verified = 1
            )
            AND NOT EXISTS (
              SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
            )
          ON CONFLICT(user_id) DO UPDATE SET
            role = excluded.role,
            version = platform_operators.version + 1,
            granted_by = excluded.granted_by,
            reason = excluded.reason,
            granted_at = excluded.granted_at,
            revoked_at = NULL,
            revoked_by = NULL,
            revoke_reason = NULL
          WHERE platform_operators.revoked_at IS NOT NULL
        `,
        )
        .bind(
          targetUserId,
          assignedRole,
          actorUserId,
          cleanReason,
          nowMs,
          actorUserId,
          targetUserId,
          targetUserId,
        )
    : platformDb
        .prepare(
          `
          INSERT INTO platform_operators (
            user_id, granted_by, reason, granted_at, revoked_at, revoked_by, revoke_reason
          )
          SELECT ?, ?, ?, ?, NULL, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
          )
            AND EXISTS (
              SELECT 1 FROM users WHERE id = ? AND email_verified = 1
            )
            AND NOT EXISTS (
              SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
            )
          ON CONFLICT(user_id) DO UPDATE SET
            granted_by = excluded.granted_by,
            reason = excluded.reason,
            granted_at = excluded.granted_at,
            revoked_at = NULL,
            revoked_by = NULL,
            revoke_reason = NULL
          WHERE platform_operators.revoked_at IS NOT NULL
        `,
        )
        .bind(
          targetUserId,
          actorUserId,
          cleanReason,
          nowMs,
          actorUserId,
          targetUserId,
          targetUserId,
        );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "platform_operator.grant",
      targetType: "platform_operator",
      targetId: targetUserId,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        reactivated: existingGrant !== null,
        role: assignedRole,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([upsertStmt, auditStmt]);
  } catch (err) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Operator grant transaction failed and was rolled back (audit persistence required).",
      err,
    );
  }

  const grantChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (grantChanges !== 1) {
    const stillActiveActor = await getActivePlatformOperator(platformDb, actorUserId);
    if (!stillActiveActor) {
      throw new PlatformOperatorError(
        403,
        "PLATFORM_OPERATOR_REQUIRED",
        "Acting operator grant is no longer active.",
      );
    }
    const latestTarget = await getPlatformOperatorGrant(platformDb, targetUserId);
    if (latestTarget?.isActive) {
      throw new PlatformOperatorError(
        409,
        "OPERATOR_ALREADY_ACTIVE",
        "Target user already holds an active platform operator grant.",
      );
    }
    throw new PlatformOperatorError(
      403,
      "USER_NOT_VERIFIED",
      "Target account is not eligible for platform operator grant.",
    );
  }

  if (auditChanges !== 1) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Operator grant audit record was not persisted.",
    );
  }

  const operator = await getPlatformOperatorGrant(platformDb, targetUserId);
  if (!operator || !operator.isActive) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Granted platform operator record could not be verified after commit.",
    );
  }

  return { operator, audit: auditEntry };
}

/**
 * Revokes an active `platform_operators` grant atomically while guaranteeing at least
 * one active platform operator always remains (PLAN §13; REQ-051).
 *
 * Uses a single conditional SQL UPDATE guarded by `(SELECT COUNT(*) ... WHERE revoked_at IS NULL) > 1`
 * paired with a conditional `platform_audit` INSERT (`WHERE changes() = 1`) in one `db.batch()`.
 * Under concurrent revocations (`Promise.all([revoke(op1), revoke(op2)])`), SQLite serializes
 * the batch transactions so at most N-1 revocations succeed and the final active operator is preserved.
 */
export async function revokePlatformOperator(
  platformDb: D1Database,
  input: RevokePlatformOperatorInput,
): Promise<PlatformOperatorMutationResult> {
  const actorUserId = input.actorUserId.trim();
  const targetUserId = input.targetUserId.trim();
  if (!actorUserId || !targetUserId) {
    throw new PlatformOperatorError(
      422,
      "VALIDATION_ERROR",
      "Both actorUserId and targetUserId are required.",
    );
  }

  const cleanReason = normalizeValidatedReason(input.reason);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const actorGrant = await getActivePlatformOperator(platformDb, actorUserId);
  if (!actorGrant) {
    throw new PlatformOperatorError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "An active platform operator grant is required to revoke operator access.",
    );
  }

  const hasRoles = await hasOperatorRoleColumns(platformDb);
  const conditionalRevokeStmt = hasRoles
    ? platformDb
        .prepare(
          `
          UPDATE platform_operators
          SET revoked_at = ?, revoked_by = ?, revoke_reason = ?, version = version + 1
          WHERE user_id = ?
            AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM platform_operators
              WHERE user_id = ? AND revoked_at IS NULL
            )
            AND (
              SELECT COUNT(*) FROM platform_operators
              WHERE revoked_at IS NULL
            ) > 1
            AND (
              role != 'platform_superadmin'
              OR (
                SELECT COUNT(*) FROM platform_operators
                WHERE revoked_at IS NULL AND role = 'platform_superadmin'
              ) > 1
            )
          `,
        )
        .bind(nowMs, actorUserId, cleanReason, targetUserId, actorUserId)
    : platformDb
        .prepare(
          `
          UPDATE platform_operators
          SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
          WHERE user_id = ?
            AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM platform_operators
              WHERE user_id = ? AND revoked_at IS NULL
            )
            AND (
              SELECT COUNT(*) FROM platform_operators
              WHERE revoked_at IS NULL
            ) > 1
          `,
        )
        .bind(nowMs, actorUserId, cleanReason, targetUserId, actorUserId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "platform_operator.revoke",
      targetType: "platform_operator",
      targetId: targetUserId,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        selfRevoke: actorUserId === targetUserId,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([conditionalRevokeStmt, auditStmt]);
  } catch (err) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Operator revocation transaction failed and was rolled back (audit persistence required).",
      err,
    );
  }

  const revokeChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (revokeChanges !== 1) {
    const stillActiveActor = await getActivePlatformOperator(platformDb, actorUserId);
    if (!stillActiveActor) {
      throw new PlatformOperatorError(
        403,
        "PLATFORM_OPERATOR_REQUIRED",
        "Acting operator grant is no longer active.",
      );
    }

    const targetGrant = await getPlatformOperatorGrant(platformDb, targetUserId);
    if (!targetGrant) {
      throw new PlatformOperatorError(
        404,
        "OPERATOR_NOT_FOUND",
        "Target platform operator grant was not found.",
      );
    }
    if (!targetGrant.isActive) {
      throw new PlatformOperatorError(
        409,
        "OPERATOR_ALREADY_REVOKED",
        "Target platform operator grant is already revoked.",
      );
    }

    // Target is active and actor is active, so the atomic COUNT(*) > 1 guard blocked removal.
    try {
      await appendPlatformAudit(platformDb, {
        actorUserId,
        actorRole: "platform_operator",
        action: "platform_operator.revoke",
        targetType: "platform_operator",
        targetId: targetUserId,
        reason: cleanReason,
        requireReason: true,
        outcome: "denied",
        requestId: input.requestId ?? null,
        metadata: { code: "FINAL_OPERATOR_PROTECTED" },
        createdAtMs: nowMs,
      });
    } catch {
      // No operator state changed; preserve the canonical 409 FINAL_OPERATOR_PROTECTED error.
    }

    throw new PlatformOperatorError(
      409,
      "FINAL_OPERATOR_PROTECTED",
      "Cannot revoke the final active platform operator.",
    );
  }

  if (auditChanges !== 1) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Operator revocation audit record was not persisted.",
    );
  }

  const operator = await getPlatformOperatorGrant(platformDb, targetUserId);
  if (!operator || operator.isActive) {
    throw new PlatformOperatorError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Revoked platform operator record could not be verified after commit.",
    );
  }

  return { operator, audit: auditEntry };
}
