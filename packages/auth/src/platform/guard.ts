import {
  appendPlatformAudit,
  getPlatformOperatorGrant,
  grantPlatformOperator,
  revokePlatformOperator,
  type PlatformAuditRecord,
  type PlatformOperatorRecord,
} from "@punyasitus/db/platform";
import { DEFAULT_REAUTH_WINDOW_MS, verifyUserPassword } from "../account.ts";

/**
 * Authoritative platform operator authorization guard and audited grant/revoke services
 * consumed by `console.punyasitus.com` routes and TASK-026 / TASK-048 handlers
 * (PLAN §13; REQ-051, REQ-034, REQ-039).
 *
 * Core security invariants:
 * - Every privileged call verifies BOTH a live, non-expired, non-revoked session in
 *   `PLATFORM_DB.sessions` AND an active `platform_operators` grant (`revoked_at IS NULL`).
 * - Organization / tenant roles (`owner`, `admin`, `editor`, `agency_staff`, `setup_staff`),
 *   client-supplied flags, and email suffixes NEVER confer platform operator access.
 * - Revoked operators fail subsequent privileged calls immediately even with an active session.
 * - Sensitive mutations (grant/revoke) require recent reauthentication within 10 minutes
 *   (`DEFAULT_PLATFORM_REAUTH_WINDOW_MS`).
 */

export const DEFAULT_PLATFORM_REAUTH_WINDOW_MS = DEFAULT_REAUTH_WINDOW_MS;

export type PlatformGuardErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "OPERATOR_REVOKED"
  | "TOTP_REQUIRED"
  | "REAUTH_REQUIRED";

export class PlatformGuardError extends Error {
  readonly status: 401 | 403;
  readonly code: PlatformGuardErrorCode;

  constructor(status: 401 | 403, code: PlatformGuardErrorCode, message: string) {
    super(message);
    this.name = "PlatformGuardError";
    this.status = status;
    this.code = code;
  }
}

export interface PlatformSessionInput {
  readonly id: string;
  readonly userId?: string;
  readonly token?: string;
  readonly expiresAt?: Date | number | string;
  readonly createdAt?: Date | number | string;
}

export interface PlatformUserInput {
  readonly id: string;
  readonly email?: string;
  /**
   * Accepted only so callers cannot accidentally escalate via a user/member role field;
   * ignored for authorization (authority comes strictly from `PLATFORM_DB.platform_operators`).
   */
  readonly role?: string;
}

export interface RequireActivePlatformOperatorParams {
  readonly session: PlatformSessionInput | null | undefined;
  readonly user: PlatformUserInput | null | undefined;
  readonly requestId?: string | null;
  readonly action?: string;
  readonly requireRecentReauth?: boolean;
  /** Explicit epoch-ms timestamp when the operator completed recent step-up / 2FA reauth. */
  readonly reauthenticatedAtMs?: number | null;
  /** Optional password proof fallback for reauthentication when step-up timestamp is not present. */
  readonly currentPassword?: string;
  /** Forward-compatible 2FA enforcement hook wired by TASK-067. */
  readonly requireTwoFactor?: boolean;
  readonly twoFactorVerified?: boolean;
  readonly reauthWindowMs?: number;
  readonly nowMs?: number;
  /** Append a `denied` row in `platform_audit` when access is denied (default: true). */
  readonly auditOnDeny?: boolean;
}

export interface VerifiedPlatformOperatorContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: "platform_operator";
  readonly grant: PlatformOperatorRecord;
  readonly reauthenticated: boolean;
  readonly reauthMethod: "fresh_reauth" | "password" | null;
  readonly verifiedAtMs: number;
}

interface SessionDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly token: string;
  readonly expires_at: number;
}

async function recordDeniedPlatformAccess(
  platformDb: D1Database,
  params: {
    readonly enabled: boolean;
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason: string;
    readonly requestId?: string | null;
    readonly code: PlatformGuardErrorCode;
    readonly nowMs: number;
  },
): Promise<void> {
  if (!params.enabled) return;
  try {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      reason: params.reason,
      requireReason: false,
      outcome: "denied",
      requestId: params.requestId ?? null,
      metadata: { code: params.code },
      createdAtMs: params.nowMs,
    });
  } catch {
    // Authorization denials must always fail closed even if best-effort deny auditing fails.
  }
}

/**
 * Verifies that the caller holds BOTH:
 * 1. A live, non-revoked, non-expired session in `PLATFORM_DB.sessions` matching `user.id`, AND
 * 2. An active `platform_operators` grant (`revoked_at IS NULL`) in `PLATFORM_DB`.
 *
 * Optionally enforces 2FA (`requireTwoFactor`) and recent reauthentication (`requireRecentReauth`,
 * default 10-minute window). Explicitly denies tenant owners/admins/editors with
 * `403 PLATFORM_OPERATOR_REQUIRED` and revoked operators with `403 OPERATOR_REVOKED`.
 */
export async function requireActivePlatformOperator(
  platformDb: D1Database,
  params: RequireActivePlatformOperatorParams,
): Promise<VerifiedPlatformOperatorContext> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const auditOnDeny = params.auditOnDeny ?? true;
  const action = params.action?.trim() || "platform.access";

  const sessionId = params.session?.id?.trim();
  const userId = params.user?.id?.trim();

  if (!sessionId || !userId) {
    throw new PlatformGuardError(
      401,
      "UNAUTHENTICATED",
      "Authenticated session is required for platform operator access.",
    );
  }

  if (params.session?.userId && params.session.userId.trim() !== userId) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "unverified_session",
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Session user mismatch rejected",
      requestId: params.requestId,
      code: "SESSION_REVOKED",
      nowMs,
    });
    throw new PlatformGuardError(
      401,
      "SESSION_REVOKED",
      "Session does not match the authenticated user.",
    );
  }

  // 1. Live session verification in PLATFORM_DB.sessions (revoked/deleted sessions fail immediately)
  const sessionRow = await platformDb
    .prepare("SELECT id, user_id, token, expires_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1")
    .bind(sessionId, userId)
    .first<SessionDbRow>();

  if (!sessionRow) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "unverified_session",
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Revoked or unknown session rejected on platform boundary",
      requestId: params.requestId,
      code: "SESSION_REVOKED",
      nowMs,
    });
    throw new PlatformGuardError(
      401,
      "SESSION_REVOKED",
      "Session has been revoked or is no longer active.",
    );
  }

  if (params.session?.token !== undefined && sessionRow.token !== params.session.token) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "unverified_session",
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Session token mismatch rejected on platform boundary",
      requestId: params.requestId,
      code: "SESSION_REVOKED",
      nowMs,
    });
    throw new PlatformGuardError(401, "SESSION_REVOKED", "Session token is invalid.");
  }

  if (sessionRow.expires_at <= nowMs) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "expired_session",
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Expired session rejected on platform boundary",
      requestId: params.requestId,
      code: "SESSION_EXPIRED",
      nowMs,
    });
    throw new PlatformGuardError(401, "SESSION_EXPIRED", "Session has expired.");
  }

  // 2. Live platform_operators check (organization membership roles NEVER imply platform access)
  const grant = await getPlatformOperatorGrant(platformDb, userId);

  if (!grant) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "non_operator",
      action,
      targetType: "platform_operator",
      targetId: userId,
      reason: "Active platform operator grant is required",
      requestId: params.requestId,
      code: "PLATFORM_OPERATOR_REQUIRED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Active platform operator grant is required; tenant organization roles do not grant platform access.",
    );
  }

  if (!grant.isActive) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "revoked_platform_operator",
      action,
      targetType: "platform_operator",
      targetId: userId,
      reason: "Revoked platform operator attempted privileged access",
      requestId: params.requestId,
      code: "OPERATOR_REVOKED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "OPERATOR_REVOKED",
      "Platform operator grant has been revoked.",
    );
  }

  // 3. Optional mandatory 2FA hook (wired by TASK-067)
  if (params.requireTwoFactor && (!grant.twoFactorEnabled || !params.twoFactorVerified)) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "platform_operator",
      action,
      targetType: "platform_operator",
      targetId: userId,
      reason: "Verified two-factor authentication required",
      requestId: params.requestId,
      code: "TOTP_REQUIRED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "TOTP_REQUIRED",
      "Verified two-factor authentication is required for platform operators.",
    );
  }

  // 4. Recent reauthentication verification (PLAN §13: 10-minute window for grant/revoke)
  const windowMs = params.reauthWindowMs ?? DEFAULT_PLATFORM_REAUTH_WINDOW_MS;
  let reauthMethod: "fresh_reauth" | "password" | null = null;

  if (
    typeof params.reauthenticatedAtMs === "number" &&
    Number.isFinite(params.reauthenticatedAtMs)
  ) {
    const elapsed = nowMs - params.reauthenticatedAtMs;
    if (elapsed >= 0 && elapsed <= windowMs) {
      reauthMethod = "fresh_reauth";
    }
  }

  if (reauthMethod === null && typeof params.currentPassword === "string" && params.currentPassword.length > 0) {
    const passwordOk = await verifyUserPassword(platformDb, userId, params.currentPassword);
    if (passwordOk) {
      reauthMethod = "password";
    }
  }

  if (params.requireRecentReauth && reauthMethod === null) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "platform_operator",
      action,
      targetType: "platform_operator",
      targetId: userId,
      reason: "Recent reauthentication within 10 minutes is required",
      requestId: params.requestId,
      code: "REAUTH_REQUIRED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "REAUTH_REQUIRED",
      "Recent reauthentication within 10 minutes is required for this platform operation.",
    );
  }

  return {
    userId,
    sessionId,
    role: "platform_operator",
    grant,
    reauthenticated: reauthMethod !== null,
    reauthMethod,
    verifiedAtMs: nowMs,
  };
}

export interface AuditedPlatformOperatorActionParams {
  readonly session: PlatformSessionInput | null | undefined;
  readonly user: PlatformUserInput | null | undefined;
  readonly targetUserId: string;
  readonly reason: string;
  readonly requestId?: string;
  readonly reauthenticatedAtMs?: number | null;
  readonly currentPassword?: string;
  readonly requireTwoFactor?: boolean;
  readonly twoFactorVerified?: boolean;
  readonly reauthWindowMs?: number;
  readonly nowMs?: number;
}

export interface AuditedPlatformOperatorActionResult {
  readonly actor: VerifiedPlatformOperatorContext;
  readonly operator: PlatformOperatorRecord;
  readonly audit: PlatformAuditRecord;
}

/**
 * High-level audited operator grant service for `TASK-048` / `TASK-026`.
 * Enforces active session + active operator grant + recent reauthentication,
 * then executes the atomic `platform_operators` + `platform_audit` batch.
 */
export async function executeAuditedPlatformGrant(
  platformDb: D1Database,
  params: AuditedPlatformOperatorActionParams,
): Promise<AuditedPlatformOperatorActionResult> {
  const actor = await requireActivePlatformOperator(platformDb, {
    session: params.session,
    user: params.user,
    requestId: params.requestId,
    action: "platform_operator.grant",
    requireRecentReauth: true,
    reauthenticatedAtMs: params.reauthenticatedAtMs,
    currentPassword: params.currentPassword,
    requireTwoFactor: params.requireTwoFactor,
    twoFactorVerified: params.twoFactorVerified,
    reauthWindowMs: params.reauthWindowMs,
    nowMs: params.nowMs,
  });

  const { operator, audit } = await grantPlatformOperator(platformDb, {
    actorUserId: actor.userId,
    targetUserId: params.targetUserId,
    reason: params.reason,
    requestId: params.requestId,
    nowMs: params.nowMs,
  });

  return { actor, operator, audit };
}

/**
 * High-level audited operator revoke service for `TASK-048` / `TASK-026`.
 * Enforces active session + active operator grant + recent reauthentication,
 * then executes the atomic final-operator-safe revoke + `platform_audit` batch.
 */
export async function executeAuditedPlatformRevoke(
  platformDb: D1Database,
  params: AuditedPlatformOperatorActionParams,
): Promise<AuditedPlatformOperatorActionResult> {
  const actor = await requireActivePlatformOperator(platformDb, {
    session: params.session,
    user: params.user,
    requestId: params.requestId,
    action: "platform_operator.revoke",
    requireRecentReauth: true,
    reauthenticatedAtMs: params.reauthenticatedAtMs,
    currentPassword: params.currentPassword,
    requireTwoFactor: params.requireTwoFactor,
    twoFactorVerified: params.twoFactorVerified,
    reauthWindowMs: params.reauthWindowMs,
    nowMs: params.nowMs,
  });

  const { operator, audit } = await revokePlatformOperator(platformDb, {
    actorUserId: actor.userId,
    targetUserId: params.targetUserId,
    reason: params.reason,
    requestId: params.requestId,
    nowMs: params.nowMs,
  });

  return { actor, operator, audit };
}
