import {
  listUserAgencyMemberships,
  type AgencyMemberRole,
  type AgencySummary,
  type UserAgencyMembership,
} from "@punyasitus/db/agencies/index";
import { appendPlatformAudit } from "@punyasitus/db/platform";
import { SESSION_LIFETIME_POLICIES } from "../google.ts";
import {
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  getSessionSecondFactorState,
  type SessionSecondFactorMethod,
} from "../platform/two-factor.ts";

/**
 * Authoritative Agency Portal authorization guard, mandatory TOTP 2FA gate,
 * explicit per-action agency RBAC matrix, cross-agency 404 isolation,
 * verified-email check, and 100% agency-payer billing isolation helpers
 * (REQ-083, REQ-068, REQ-034, PLAN §4 & §19.4, TASK-083).
 */

export type AgencyPermissionAction =
  | "agency:read"
  | "agency:clients:write"
  | "agency:clients:switch"
  | "agency:billing:read"
  | "agency:billing:write"
  | "agency:members:manage";

const FULL_AGENCY_PERMISSIONS: readonly AgencyPermissionAction[] = [
  "agency:read",
  "agency:clients:write",
  "agency:clients:switch",
  "agency:billing:read",
  "agency:billing:write",
  "agency:members:manage",
];

/**
 * Canonical per-action RBAC matrix across `agency_members.role`:
 * - `agency_owner` / `agency_admin`: full agency permissions
 * - `agency_billing`: read clients + full billing (checkout/reconcile/receipts); NO client provisioning or CMS switch
 * - `agency_staff`: read clients + CMS switch ONLY; NO client provisioning and NO billing access
 */
export const AGENCY_ROLE_PERMISSIONS: Readonly<
  Record<AgencyMemberRole, ReadonlySet<AgencyPermissionAction>>
> = Object.freeze({
  agency_owner: new Set<AgencyPermissionAction>(FULL_AGENCY_PERMISSIONS),
  agency_admin: new Set<AgencyPermissionAction>(FULL_AGENCY_PERMISSIONS),
  agency_billing: new Set<AgencyPermissionAction>([
    "agency:read",
    "agency:billing:read",
    "agency:billing:write",
  ]),
  agency_staff: new Set<AgencyPermissionAction>([
    "agency:read",
    "agency:clients:switch",
  ]),
});

export function canAgencyRolePerform(
  role: AgencyMemberRole,
  action: AgencyPermissionAction,
): boolean {
  return AGENCY_ROLE_PERMISSIONS[role].has(action);
}

export type AgencyGuardErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "EMAIL_NOT_VERIFIED"
  | "TOTP_ENROLLMENT_REQUIRED"
  | "TOTP_REQUIRED"
  | "RECENT_SECOND_FACTOR_REQUIRED"
  | "AGENCY_MEMBERSHIP_REQUIRED"
  | "AGENCY_SUSPENDED"
  | "FORBIDDEN"
  | "NOT_FOUND";

export class AgencyGuardError extends Error {
  readonly status: 401 | 403 | 404;
  readonly code: AgencyGuardErrorCode;

  constructor(status: 401 | 403 | 404, code: AgencyGuardErrorCode, message: string) {
    super(message);
    this.name = "AgencyGuardError";
    this.status = status;
    this.code = code;
  }
}

export interface AgencySessionInput {
  readonly id: string;
  readonly userId?: string;
  readonly token?: string;
}

export interface AgencyUserInput {
  readonly id: string;
  readonly email?: string;
  readonly name?: string;
}

export interface RequireActiveAgencyUserParams {
  readonly session: AgencySessionInput | null | undefined;
  readonly user: AgencyUserInput | null | undefined;
  readonly requestedAgencyId?: string | null;
  /** Default true; set false for self-registration / invitation acceptance / onboarding screen. */
  readonly requireAgencyMembership?: boolean;
  /** Optional explicit RBAC permission check against active `agency_members.role`. */
  readonly requiredPermission?: AgencyPermissionAction;
  /** Default false; enforce 10-minute step-up 2FA freshness when true. */
  readonly requireRecentSecondFactor?: boolean;
  readonly secondFactorWindowMs?: number;
  readonly requestId?: string | null;
  readonly action?: string;
  readonly nowMs?: number;
  readonly auditOnDeny?: boolean;
}

export interface VerifiedAgencyUserContext {
  readonly userId: string;
  readonly userEmail: string;
  readonly userName: string;
  readonly emailVerified: boolean;
  readonly sessionId: string;
  readonly twoFactorVerifiedAtMs: number;
  readonly twoFactorMethod: SessionSecondFactorMethod;
  readonly memberships: readonly UserAgencyMembership[];
  readonly agencies: readonly AgencySummary[];
  readonly activeAgency: AgencySummary | null;
  readonly agencyRole: AgencyMemberRole | null;
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

interface UserDbRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly email_verified: number;
}

async function recordDeniedAgencyAccess(
  platformDb: D1Database,
  params: {
    readonly enabled: boolean;
    readonly actorUserId: string | null;
    readonly actorRole?: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason: string;
    readonly requestId?: string | null;
    readonly code: AgencyGuardErrorCode;
    readonly nowMs: number;
  },
): Promise<void> {
  if (!params.enabled) return;
  try {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole ?? "agency_admin",
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
    // Authorization denials always fail closed even if best-effort deny audit fails.
  }
}

export async function requireActiveAgencyUser(
  platformDb: D1Database,
  params: RequireActiveAgencyUserParams,
): Promise<VerifiedAgencyUserContext> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const auditOnDeny = params.auditOnDeny ?? true;
  const action = params.action?.trim() || "agency.access";
  const requireMembership = params.requireAgencyMembership ?? true;

  const sessionId = params.session?.id?.trim() ?? "";
  const userId = params.user?.id?.trim() ?? "";

  if (!sessionId || !userId) {
    throw new AgencyGuardError(
      401,
      "UNAUTHENTICATED",
      "Sesi terautentikasi wajib digunakan untuk mengakses Portal Agensi.",
    );
  }

  if (params.session?.userId && params.session.userId.trim() !== userId) {
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Agency session user mismatch rejected",
      requestId: params.requestId,
      code: "SESSION_REVOKED",
      nowMs,
    });
    throw new AgencyGuardError(401, "SESSION_REVOKED", "Sesi tidak cocok dengan pengguna.");
  }

  // 1. Verify live session + DEC-045 agency lifetime ceiling (60m idle / 12h absolute)
  const sessionRow = await platformDb
    .prepare(
      "SELECT id, user_id, token, created_at, updated_at, expires_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1",
    )
    .bind(sessionId, userId)
    .first<SessionDbRow>();

  if (!sessionRow) {
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "session",
      targetId: sessionId,
      reason: "Revoked or unknown session rejected on agency boundary",
      requestId: params.requestId,
      code: "SESSION_REVOKED",
      nowMs,
    });
    throw new AgencyGuardError(401, "SESSION_REVOKED", "Sesi telah berakhir atau dicabut.");
  }

  if (params.session?.token !== undefined && sessionRow.token !== params.session.token) {
    throw new AgencyGuardError(401, "SESSION_REVOKED", "Token sesi tidak valid.");
  }

  const agencyIdleMs = SESSION_LIFETIME_POLICIES.agency.idleTimeoutSeconds * 1000;
  const agencyAbsoluteMs = SESSION_LIFETIME_POLICIES.agency.absoluteTimeoutSeconds * 1000;
  const exceededIdle = nowMs - sessionRow.updated_at > agencyIdleMs;
  const exceededAbsolute = nowMs - sessionRow.created_at > agencyAbsoluteMs;

  if (sessionRow.expires_at <= nowMs || exceededIdle || exceededAbsolute) {
    await platformDb
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(sessionId, userId)
      .run();
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "session",
      targetId: sessionId,
      reason: exceededIdle
        ? "Agency session exceeded 60-minute idle timeout (DEC-045)"
        : exceededAbsolute
          ? "Agency session exceeded 12-hour absolute ceiling (DEC-045)"
          : "Expired session rejected on agency boundary",
      requestId: params.requestId,
      code: "SESSION_EXPIRED",
      nowMs,
    });
    throw new AgencyGuardError(
      401,
      "SESSION_EXPIRED",
      "Sesi agensi telah kedaluwarsa. Silakan masuk kembali.",
    );
  }

  const userRow = await platformDb
    .prepare("SELECT id, email, name, email_verified FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<UserDbRow>();

  if (!userRow) {
    throw new AgencyGuardError(401, "UNAUTHENTICATED", "Akun pengguna tidak ditemukan.");
  }

  // 2. Verified email requirement on agency portal (REQ-083)
  if (userRow.email_verified !== 1) {
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "agency_user",
      targetId: userId,
      reason: "Verified email is required for agency portal access",
      requestId: params.requestId,
      code: "EMAIL_NOT_VERIFIED",
      nowMs,
    });
    throw new AgencyGuardError(
      403,
      "EMAIL_NOT_VERIFIED",
      "Alamat email akun harus terverifikasi sebelum mengakses Portal Agensi.",
    );
  }

  // 3. MANDATORY TOTP 2FA ENFORCEMENT FOR ALL AGENCY USERS (REQ-083, REQ-068)
  const twoFactorState = await getSessionSecondFactorState(platformDb, { sessionId, userId });

  if (!twoFactorState.twoFactorEnabled) {
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "agency_user",
      targetId: userId,
      reason: "Agency user must enroll TOTP two-factor authentication",
      requestId: params.requestId,
      code: "TOTP_ENROLLMENT_REQUIRED",
      nowMs,
    });
    throw new AgencyGuardError(
      403,
      "TOTP_ENROLLMENT_REQUIRED",
      "Autentikasi dua faktor (TOTP 2FA) wajib diaktifkan untuk seluruh pengguna Portal Agensi.",
    );
  }

  if (
    !twoFactorState.sessionVerified ||
    twoFactorState.verifiedAtMs === null ||
    twoFactorState.method === null
  ) {
    await recordDeniedAgencyAccess(platformDb, {
      enabled: auditOnDeny,
      actorUserId: userId,
      action,
      targetType: "agency_user",
      targetId: userId,
      reason: "Agency session requires verified TOTP second factor",
      requestId: params.requestId,
      code: "TOTP_REQUIRED",
      nowMs,
    });
    throw new AgencyGuardError(
      403,
      "TOTP_REQUIRED",
      "Verifikasi kode autentikasi dua faktor (2FA) diperlukan untuk sesi Portal Agensi ini.",
    );
  }

  if (params.requireRecentSecondFactor) {
    const windowMs = Math.max(
      1_000,
      Math.trunc(params.secondFactorWindowMs ?? DEFAULT_SECOND_FACTOR_WINDOW_MS),
    );
    const ageMs = nowMs - twoFactorState.verifiedAtMs;
    if (ageMs < 0 || ageMs > windowMs) {
      await recordDeniedAgencyAccess(platformDb, {
        enabled: auditOnDeny,
        actorUserId: userId,
        action,
        targetType: "agency_user",
        targetId: userId,
        reason: "Agency operation requires recent 2FA verification within 10 minutes",
        requestId: params.requestId,
        code: "RECENT_SECOND_FACTOR_REQUIRED",
        nowMs,
      });
      throw new AgencyGuardError(
        403,
        "RECENT_SECOND_FACTOR_REQUIRED",
        "Verifikasi ulang 2FA dalam 10 menit terakhir diperlukan untuk tindakan ini.",
      );
    }
  }

  // 4. Resolve active `agency_members` strictly (revoked members are NEVER matched!)
  const allMemberships = await listUserAgencyMemberships(platformDb, userId, {
    includeSuspended: true,
  });
  const activeMemberships = allMemberships.filter((m) => m.agency.status === "active");

  const requestedAgencyId = params.requestedAgencyId?.trim() || null;
  let selectedMembership: UserAgencyMembership | null;

  if (requestedAgencyId) {
    const matchedAny = allMemberships.find((m) => m.agency.id === requestedAgencyId);
    if (!matchedAny) {
      await recordDeniedAgencyAccess(platformDb, {
        enabled: auditOnDeny,
        actorUserId: userId,
        action,
        targetType: "agency",
        targetId: requestedAgencyId,
        reason: "Cross-agency access denied with neutral 404",
        requestId: params.requestId,
        code: "NOT_FOUND",
        nowMs,
      });
      throw new AgencyGuardError(404, "NOT_FOUND", "Agensi tidak ditemukan.");
    }
    if (matchedAny.agency.status !== "active") {
      throw new AgencyGuardError(
        403,
        "AGENCY_SUSPENDED",
        "Agensi sedang ditangguhkan oleh operator platform.",
      );
    }
    selectedMembership = matchedAny;
  } else {
    selectedMembership = activeMemberships[0] ?? null;
  }

  if (requireMembership && !selectedMembership) {
    if (allMemberships.length > 0 && activeMemberships.length === 0) {
      throw new AgencyGuardError(
        403,
        "AGENCY_SUSPENDED",
        "Akun agensi Anda sedang ditangguhkan oleh operator platform.",
      );
    }
    throw new AgencyGuardError(
      403,
      "AGENCY_MEMBERSHIP_REQUIRED",
      "Akun Anda belum tergabung dalam agensi aktif. Daftarkan agensi terlebih dahulu.",
    );
  }

  // 5. Per-action RBAC check against active agency member role
  if (params.requiredPermission && selectedMembership) {
    if (!canAgencyRolePerform(selectedMembership.role, params.requiredPermission)) {
      await recordDeniedAgencyAccess(platformDb, {
        enabled: auditOnDeny,
        actorUserId: userId,
        actorRole: selectedMembership.role,
        action,
        targetType: "agency",
        targetId: selectedMembership.agency.id,
        reason: `Agency role "${selectedMembership.role}" lacks permission "${params.requiredPermission}"`,
        requestId: params.requestId,
        code: "FORBIDDEN",
        nowMs,
      });
      throw new AgencyGuardError(
        403,
        "FORBIDDEN",
        `Peran "${selectedMembership.role}" tidak memiliki izin untuk aksi ini.`,
      );
    }
  }

  return {
    userId: userRow.id,
    userEmail: userRow.email,
    userName: userRow.name,
    emailVerified: true,
    sessionId,
    twoFactorVerifiedAtMs: twoFactorState.verifiedAtMs,
    twoFactorMethod: twoFactorState.method,
    memberships: activeMemberships,
    agencies: activeMemberships.map((m) => m.agency),
    activeAgency: selectedMembership?.agency ?? null,
    agencyRole: selectedMembership?.role ?? null,
    verifiedAtMs: nowMs,
  };
}

export async function assertAgencyOwnsClientTenant(
  platformDb: D1Database,
  params: {
    readonly agencyId: string;
    readonly tenantIdOrHandle: string;
  },
): Promise<{
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly agencyId: string;
}> {
  const selector = params.tenantIdOrHandle.trim();
  const agencyId = params.agencyId.trim();
  if (!selector || !agencyId) {
    throw new AgencyGuardError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
  }

  const row = await platformDb
    .prepare(
      `SELECT id, organization_id, handle, name, agency_id, status
       FROM tenants
       WHERE agency_id = ?
         AND status != 'purged'
         AND (id = ? OR handle = ?)
       LIMIT 1`,
    )
    .bind(agencyId, selector, selector.toLowerCase())
    .first<{
      readonly id: string;
      readonly organization_id: string;
      readonly handle: string;
      readonly name: string;
      readonly agency_id: string;
      readonly status: string;
    }>();

  if (!row) {
    throw new AgencyGuardError(404, "NOT_FOUND", "Situs klien tidak ditemukan.");
  }

  return {
    tenantId: row.id,
    organizationId: row.organization_id,
    handle: row.handle,
    name: row.name,
    agencyId: row.agency_id,
  };
}

export async function assertClientBillingAccessForTenant(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly userId: string;
    readonly memberDbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  },
): Promise<{ readonly payerType: "tenant" | "agency"; readonly payerAgencyId: string | null }> {
  const row = await platformDb
    .prepare("SELECT id, agency_id, status FROM tenants WHERE id = ? LIMIT 1")
    .bind(params.tenantId.trim())
    .first<{
      readonly id: string;
      readonly agency_id: string | null;
      readonly status: string;
    }>();

  if (!row || row.status === "purged") {
    throw new AgencyGuardError(404, "NOT_FOUND", "Situs tidak ditemukan.");
  }

  if (row.agency_id !== null) {
    if (params.memberDbRole !== "agency_staff") {
      throw new AgencyGuardError(
        403,
        "FORBIDDEN",
        "Tagihan, pengingat perpanjangan, dan kuitansi situs ini dikelola sepenuhnya oleh agensi.",
      );
    }

    const memberships = await listUserAgencyMemberships(platformDb, params.userId);
    const matched = memberships.find((m) => m.agency.id === row.agency_id);
    if (!matched) {
      throw new AgencyGuardError(404, "NOT_FOUND", "Situs tidak ditemukan.");
    }
    if (!canAgencyRolePerform(matched.role, "agency:billing:read")) {
      throw new AgencyGuardError(
        403,
        "FORBIDDEN",
        "Peran agensi Anda tidak memiliki izin akses penagihan.",
      );
    }

    return { payerType: "agency", payerAgencyId: row.agency_id };
  }

  if (params.memberDbRole !== "owner") {
    throw new AgencyGuardError(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs (Owner) yang dapat mengakses penagihan situs ini.",
    );
  }

  return { payerType: "tenant", payerAgencyId: null };
}
