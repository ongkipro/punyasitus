import {
  appendPlatformAudit,
  getPlatformOperatorGrant,
  grantPlatformOperator,
  revokePlatformOperator,
  type PlatformAuditRecord,
  type PlatformOperatorRecord,
} from "@punyasitus/db/platform";
import { DEFAULT_REAUTH_WINDOW_MS, verifyUserPassword } from "../account.ts";
import { SESSION_LIFETIME_POLICIES } from "../google.ts";
import {
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  getSessionSecondFactorState,
  type SessionSecondFactorMethod,
} from "./two-factor.ts";

/**
 * Authoritative platform operator authorization guard and audited grant/revoke services
 * consumed by `console.punyasitus.com` routes and TASK-026 / TASK-046 / TASK-047 / TASK-048
 * handlers (PLAN §13; REQ-051, REQ-068, REQ-034, REQ-039; DEC-021).
 *
 * Core security invariants:
 * - Every privileged call verifies BOTH a live, non-expired, non-revoked session in
 *   `PLATFORM_DB.sessions` AND an active `platform_operators` grant (`revoked_at IS NULL`).
 * - Organization / tenant roles (`owner`, `admin`, `editor`, `agency_staff`, `setup_staff`),
 *   client-supplied flags, and email suffixes NEVER confer platform operator access.
 * - Revoked operators fail subsequent privileged calls immediately even with an active session.
 * - Mandatory 2FA (`requireTwoFactor` / `requireRecentSecondFactor`) enforces live
 *   `users.two_factor_enabled = 1` AND an active session row in `session_two_factor_verifications`
 *   within the 10-minute step-up window (`DEFAULT_SECOND_FACTOR_WINDOW_MS`).
 */

export const DEFAULT_PLATFORM_REAUTH_WINDOW_MS = DEFAULT_REAUTH_WINDOW_MS;

export type PlatformGuardErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "OPERATOR_REVOKED"
  | "TOTP_ENROLLMENT_REQUIRED"
  | "TOTP_REQUIRED"
  | "RECENT_SECOND_FACTOR_REQUIRED"
  | "OPERATOR_2FA_MANDATORY"
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
  readonly twoFactorVerifiedAtMs: number | null;
  readonly twoFactorMethod: SessionSecondFactorMethod | null;
  readonly verifiedAtMs: number;
}

interface SessionDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly token: string;
  readonly created_at: number;
  readonly updated_at: number;
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

  // 1. Live session verification in PLATFORM_DB.sessions (revoked/deleted/expired sessions fail immediately)
  const sessionRow = await platformDb
    .prepare(
      "SELECT id, user_id, token, created_at, updated_at, expires_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1",
    )
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

  const superadminAbsoluteMs = SESSION_LIFETIME_POLICIES.superadmin.absoluteTimeoutSeconds * 1000;
  const superadminIdleMs = SESSION_LIFETIME_POLICIES.superadmin.idleTimeoutSeconds * 1000;
  const exceededAbsolute = nowMs - sessionRow.created_at > superadminAbsoluteMs;
  const exceededIdle = nowMs - sessionRow.updated_at > superadminIdleMs;

  if (sessionRow.expires_at <= nowMs || exceededAbsolute || exceededIdle) {
    await platformDb
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(sessionId, userId)
      .run();
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      actorRole: "expired_session",
      action,
      targetType: "session",
      targetId: sessionId,
      reason: exceededIdle
        ? "Platform operator session exceeded 30-minute idle timeout (DEC-045)"
        : exceededAbsolute
          ? "Platform operator session exceeded 8-hour absolute ceiling (DEC-045)"
          : "Expired session rejected on platform boundary",
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

  // 3. Mandatory 2FA enforcement (wired by TASK-067; backward-compatible when requireTwoFactor is unset)
  const twoFactorState = await getSessionSecondFactorState(platformDb, { sessionId, userId });
  if (params.requireTwoFactor) {
    if (!grant.twoFactorEnabled || !twoFactorState.twoFactorEnabled) {
      await recordDeniedPlatformAccess(platformDb, {
        enabled: auditOnDeny,
        actorUserId: userId,
        actorRole: "platform_operator",
        action,
        targetType: "platform_operator",
        targetId: userId,
        reason: "Platform operator two-factor enrollment is required",
        requestId: params.requestId,
        code: "TOTP_ENROLLMENT_REQUIRED",
        nowMs,
      });
      throw new PlatformGuardError(
        403,
        "TOTP_ENROLLMENT_REQUIRED",
        "Platform operator must enroll two-factor authentication before accessing console resources.",
      );
    }

    const sessionCompleted2fa =
      params.twoFactorVerified === true || twoFactorState.sessionVerified;
    if (!sessionCompleted2fa) {
      await recordDeniedPlatformAccess(platformDb, {
        enabled: auditOnDeny,
        actorUserId: userId,
        actorRole: "platform_operator",
        action,
        targetType: "platform_operator",
        targetId: userId,
        reason: "Verified two-factor session is required",
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
    twoFactorVerifiedAtMs: twoFactorState.verifiedAtMs,
    twoFactorMethod: twoFactorState.method,
    verifiedAtMs: nowMs,
  };
}

export interface RequireRecentSecondFactorParams {
  readonly session: PlatformSessionInput | null | undefined;
  readonly user: PlatformUserInput | null | undefined;
  readonly windowMs?: number;
  readonly nowMs?: number;
  readonly requestId?: string | null;
  readonly action?: string;
  readonly auditOnDeny?: boolean;
}

export interface VerifiedRecentSecondFactorContext extends VerifiedPlatformOperatorContext {
  readonly twoFactorVerifiedAtMs: number;
  readonly twoFactorMethod: SessionSecondFactorMethod;
  readonly secondFactorAgeMs: number;
}

/**
 * Reusable recent second-factor guard for privileged platform mutations (`TASK-026`, `TASK-046`,
 * `TASK-047`, `TASK-048`: grant/revoke, tenant state transition, locked domain change, custom theme grant;
 * `PLAN §13`, `DEC-021`, `REQ-068`).
 *
 * Enforces:
 * 1. Live, non-revoked, non-expired session in `PLATFORM_DB.sessions`.
 * 2. Active `platform_operators` grant (`revoked_at IS NULL`).
 * 3. Enrolled 2FA (`users.two_factor_enabled = 1`), else `403 TOTP_ENROLLMENT_REQUIRED`.
 * 4. Active session 2FA completion in `session_two_factor_verifications`, else `403 TOTP_REQUIRED`.
 * 5. Verification completed within `windowMs` (default 10 minutes = 600_000 ms), else
 *    `403 RECENT_SECOND_FACTOR_REQUIRED` with a sanitized `denied` audit entry.
 */
export async function requireRecentSecondFactor(
  platformDb: D1Database,
  params: RequireRecentSecondFactorParams,
): Promise<VerifiedRecentSecondFactorContext> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const windowMs = Math.max(1_000, Math.trunc(params.windowMs ?? DEFAULT_SECOND_FACTOR_WINDOW_MS));
  const auditOnDeny = params.auditOnDeny ?? true;
  const action = params.action?.trim() || "platform.privileged_action";

  const actor = await requireActivePlatformOperator(platformDb, {
    session: params.session,
    user: params.user,
    requestId: params.requestId,
    action,
    requireTwoFactor: true,
    nowMs,
    auditOnDeny,
  });

  if (actor.twoFactorVerifiedAtMs === null || actor.twoFactorMethod === null) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: actor.userId,
      actorRole: "platform_operator",
      action,
      targetType: "platform_operator",
      targetId: actor.userId,
      reason: "Session second-factor verification record is required",
      requestId: params.requestId,
      code: "TOTP_REQUIRED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "TOTP_REQUIRED",
      "A two-factor verified session is required for this privileged operation.",
    );
  }

  const ageMs = nowMs - actor.twoFactorVerifiedAtMs;
  if (ageMs < 0 || ageMs > windowMs) {
    await recordDeniedPlatformAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: actor.userId,
      actorRole: "platform_operator",
      action,
      targetType: "platform_operator",
      targetId: actor.userId,
      reason: "Recent second-factor verification within 10 minutes is required",
      requestId: params.requestId,
      code: "RECENT_SECOND_FACTOR_REQUIRED",
      nowMs,
    });
    throw new PlatformGuardError(
      403,
      "RECENT_SECOND_FACTOR_REQUIRED",
      "Recent two-factor verification within 10 minutes is required for this privileged operation.",
    );
  }

  return {
    ...actor,
    twoFactorVerifiedAtMs: actor.twoFactorVerifiedAtMs,
    twoFactorMethod: actor.twoFactorMethod,
    secondFactorAgeMs: ageMs,
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
  /** Enforces `requireRecentSecondFactor` (10-minute window) for TASK-067/048 callers. */
  readonly requireRecentSecondFactor?: boolean;
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
 * Enforces active session + active operator grant + recent reauthentication (and recent 2FA
 * when `requireRecentSecondFactor` is enabled), then executes the atomic
 * `platform_operators` + `platform_audit` batch.
 */
export async function executeAuditedPlatformGrant(
  platformDb: D1Database,
  params: AuditedPlatformOperatorActionParams,
): Promise<AuditedPlatformOperatorActionResult> {
  const actor = params.requireRecentSecondFactor
    ? await requireRecentSecondFactor(platformDb, {
        session: params.session,
        user: params.user,
        windowMs: params.reauthWindowMs,
        nowMs: params.nowMs,
        requestId: params.requestId,
        action: "platform_operator.grant",
      })
    : await requireActivePlatformOperator(platformDb, {
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
 * Enforces active session + active operator grant + recent reauthentication (and recent 2FA
 * when `requireRecentSecondFactor` is enabled), then executes the atomic
 * final-operator-safe revoke + `platform_audit` batch.
 */
export async function executeAuditedPlatformRevoke(
  platformDb: D1Database,
  params: AuditedPlatformOperatorActionParams,
): Promise<AuditedPlatformOperatorActionResult> {
  const actor = params.requireRecentSecondFactor
    ? await requireRecentSecondFactor(platformDb, {
        session: params.session,
        user: params.user,
        windowMs: params.reauthWindowMs,
        nowMs: params.nowMs,
        requestId: params.requestId,
        action: "platform_operator.revoke",
      })
    : await requireActivePlatformOperator(platformDb, {
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
