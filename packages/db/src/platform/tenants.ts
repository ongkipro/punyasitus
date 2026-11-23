import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "../connections/index.ts";
import { computeEffectiveTenantStatus, evictTenantFromCache } from "../routing/resolver.ts";
import {
  appendPlatformAudit,
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  queryPlatformAuditPage,
  validateOperatorReason,
  type PlatformAuditRecord,
  type RedactedPlatformAuditRecord,
} from "./audit.ts";
import {
  TENANT_STATUSES,
  TENANT_VERTICALS,
  type TenantStatus,
  type TenantVertical,
} from "./schema.ts";

/**
 * Superadmin Tenant Directory & Scoped Operations Repository
 * (`packages/db/src/platform/tenants.ts`; TASK-046, REQ-049, REQ-034, REQ-035, REQ-046, REQ-051;
 * PLAN §13).
 *
 * Security & Atomicity Invariants:
 * - ZERO request-time DDL or runtime schema initialization.
 * - Narrow control-plane reads strictly from `PLATFORM_DB` — NEVER reads tenant pages,
 *   posts, offerings, menus, media, or customer leads.
 * - Theme grant revocation reads ONLY `site_settings.active_theme_id` from `TenantStore`
 *   and FAILS CLOSED (`503`) if active-theme verification cannot be completed.
 * - Every privileged state transition and theme grant/revoke executes inside ONE atomic
 *   `D1Database.batch([...])` gated on optimistic `version`, `WHERE changes() = 1` audit
 *   persistence, and idempotency ledger recording (`job_ledger`).
 */

export const DEFAULT_CONSOLE_TENANTS_LIMIT = 20 as const;
export const MAX_CONSOLE_TENANTS_LIMIT = 100 as const;
export const DEFAULT_CONSOLE_SAAS_ZONE = "situsku.click" as const;

const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

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

interface StateTransitionLedgerPayload {
  readonly tenantId?: string;
  readonly action?: string;
  readonly targetStatus?: string | null;
  readonly requestHash?: string;
  readonly previousStatus?: TenantStatus;
  readonly previousOperatorHold?: boolean;
}

async function computeStateTransitionRequestHash(params: {
  readonly tenantId: string;
  readonly action: ConsoleStateTransitionAction;
  readonly targetStatus: string | null;
  readonly hasPaidThroughMs: boolean;
  readonly paidThroughMs: number | null;
  readonly hasTrialEndsAtMs: boolean;
  readonly trialEndsAtMs: number | null;
  readonly hasOperatorHold: boolean;
  readonly operatorHold: boolean | null;
  readonly reason: string;
  readonly expectedVersion: number;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      params.tenantId,
      params.action,
      params.targetStatus,
      params.hasPaidThroughMs,
      params.paidThroughMs,
      params.hasTrialEndsAtMs,
      params.trialEndsAtMs,
      params.hasOperatorHold,
      params.operatorHold,
      params.reason,
      params.expectedVersion,
    ]),
  );
}

function assertStateTransitionLedgerMatches(
  ledger: JobLedgerRow,
  expected: {
    readonly tenantId: string;
    readonly action: ConsoleStateTransitionAction;
    readonly targetStatus: string | null;
    readonly requestHash: string;
  },
  cause?: unknown,
): StateTransitionLedgerPayload | null {
  if (ledger.tenant_id !== expected.tenantId) {
    throw new ConsoleTenantError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key ini sudah digunakan untuk tenant yang berbeda.",
      cause,
    );
  }
  const stored = ledger.payload_json
    ? (JSON.parse(ledger.payload_json) as StateTransitionLedgerPayload)
    : null;
  if (!stored) {
    throw new ConsoleTenantError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key ini sudah digunakan untuk transisi status yang berbeda.",
      cause,
    );
  }
  const hashMatches =
    typeof stored.requestHash === "string"
      ? stored.requestHash === expected.requestHash
      : stored.action === expected.action &&
        (stored.targetStatus ?? null) === expected.targetStatus;
  if ((stored.tenantId && stored.tenantId !== expected.tenantId) || !hashMatches) {
    throw new ConsoleTenantError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key ini sudah digunakan untuk parameter transisi status yang berbeda.",
      cause,
    );
  }
  return stored;
}

export type ConsoleTenantErrorCode =
  | "VALIDATION_ERROR"
  | "UNREGISTERED_THEME"
  | "BUILT_IN_THEME_NOT_GRANTABLE"
  | "NOT_FOUND"
  | "THEME_GRANT_NOT_FOUND"
  | "STALE_VERSION"
  | "IDEMPOTENCY_CONFLICT"
  | "THEME_ALREADY_GRANTED"
  | "ACTIVE_THEME_PROTECTED"
  | "INVALID_STATE_TRANSITION"
  | "AUDIT_PERSISTENCE_FAILED"
  | "ACTIVE_THEME_VERIFICATION_UNAVAILABLE";

export class ConsoleTenantError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 500 | 503;
  readonly code: ConsoleTenantErrorCode;

  constructor(
    status: 400 | 404 | 409 | 422 | 500 | 503,
    code: ConsoleTenantErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ConsoleTenantError";
    this.status = status;
    this.code = code;
  }
}

export type ConsoleTenantOwnerStatus = "active_member" | "pending_invitation" | "unassigned";

export interface ConsoleTenantDirectoryItem {
  readonly id: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly effectiveStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly primaryHost: string;
  readonly customDomainsCount: number;
  readonly ownerEmail: string | null;
  readonly ownerStatus: ConsoleTenantOwnerStatus;
  readonly grantedCustomThemesCount: number;
  readonly trialEndsAt: number | null;
  readonly paidThrough: number | null;
  readonly deletionDueAt: number | null;
  readonly cacheVersion: number;
  readonly schemaVersion: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConsoleTenantDirectoryPage {
  readonly items: readonly ConsoleTenantDirectoryItem[];
  readonly page: number;
  readonly limit: number;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly statusCounts: Readonly<Record<string, number>>;
}

export interface ConsoleTenantHostRecord {
  readonly host: string;
  readonly kind: "subdomain" | "custom";
  readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
  readonly sslStatus: string;
  readonly isPrimary: boolean;
  readonly verifiedAt: number | null;
  readonly lastCheckedAt: number | null;
}

export interface ConsoleTenantGrantedThemeRecord {
  readonly id: string;
  readonly themeId: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: "included" | "paid_once" | "custom";
  readonly active: boolean;
  readonly grantedBy: string | null;
  readonly settlementId: string | null;
  readonly grantedAt: number;
}

export interface ConsoleTenantOwnerSummary {
  readonly status: ConsoleTenantOwnerStatus;
  readonly memberId: string | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly pendingInvitationId: string | null;
  readonly pendingInvitationEmail: string | null;
  readonly pendingInvitationExpiresAt: number | null;
  readonly totalMembersCount: number;
}

export type ActiveThemeVerificationStatus = "verified" | "uninitialized" | "unavailable";

export interface ConsoleTenantDetailDto {
  readonly tenant: ConsoleTenantDirectoryItem;
  readonly owner: ConsoleTenantOwnerSummary;
  readonly domains: readonly ConsoleTenantHostRecord[];
  readonly grantedThemes: readonly ConsoleTenantGrantedThemeRecord[];
  readonly activeThemeId: string | null;
  readonly activeThemeVerificationStatus: ActiveThemeVerificationStatus;
  readonly allowedStateActions: readonly ConsoleAllowedStateAction[];
  readonly recentAudit: readonly RedactedPlatformAuditRecord[];
}

export type ConsoleStateTransitionAction =
  | "suspend_hold"
  | "release_hold"
  | "enter_recovery"
  | "exit_recovery"
  | "set_status";

export type ConsoleAllowedStateAction = Exclude<ConsoleStateTransitionAction, "set_status">;

export interface ConsoleTenantStateTransitionInput {
  readonly actorUserId: string;
  readonly tenantId?: string;
  readonly handle?: string;
  readonly action: ConsoleStateTransitionAction;
  readonly targetStatus?: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery";
  readonly operatorHold?: boolean;
  readonly paidThroughMs?: number | null;
  readonly trialEndsAtMs?: number | null;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly saasZone?: string;
  readonly nowMs?: number;
}

export interface ConsoleTenantStateTransitionResult {
  readonly tenant: ConsoleTenantDirectoryItem;
  readonly previousStatus: TenantStatus;
  readonly previousOperatorHold: boolean;
  readonly replayed: boolean;
  readonly audit: PlatformAuditRecord | null;
}

export interface RegisteredCustomThemeDescriptor {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface ManageConsoleTenantThemeGrantInput {
  readonly actorUserId: string;
  readonly tenantId?: string;
  readonly handle?: string;
  readonly themeId: string;
  readonly action: "grant" | "revoke";
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  /** Validated manifest from closed build-time custom theme registry (`null` if unregistered). */
  readonly registeredCustomTheme: RegisteredCustomThemeDescriptor | null;
  /** True when `themeId` is one of the 6 built-in platform themes (`compro`..`dealer`). */
  readonly isBuiltInPlatformTheme: boolean;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly requestId?: string | null;
  readonly saasZone?: string;
  readonly nowMs?: number;
}

export interface ManageConsoleTenantThemeGrantResult {
  readonly action: "grant" | "revoke";
  readonly themeId: string;
  readonly replayed: boolean;
  readonly tenant: ConsoleTenantDirectoryItem;
  readonly grantedThemes: readonly ConsoleTenantGrantedThemeRecord[];
  readonly audit: PlatformAuditRecord | null;
}

interface RawDirectoryRow {
  readonly id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly operator_hold_reason: string | null;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly deletion_due_at: number | null;
  readonly cache_version: number;
  readonly schema_version: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly primary_host: string | null;
  readonly custom_domains_count: number;
  readonly granted_custom_themes_count: number;
  readonly owner_member_id: string | null;
  readonly owner_user_id: string | null;
  readonly owner_user_email: string | null;
  readonly owner_user_name: string | null;
  readonly owner_invitation_id: string | null;
  readonly owner_invitation_email: string | null;
  readonly owner_invitation_expires_at: number | null;
  readonly total_members_count: number;
}

interface RawHostRow {
  readonly host: string;
  readonly kind: "subdomain" | "custom";
  readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
  readonly ssl_status: string;
  readonly is_primary: number;
  readonly verified_at: number | null;
  readonly last_checked_at: number | null;
}

interface RawGrantedThemeRow {
  readonly id: string;
  readonly theme_id: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: "included" | "paid_once" | "custom";
  readonly active: number;
  readonly granted_by: string | null;
  readonly settlement_id: string | null;
  readonly granted_at: number;
}

interface JobLedgerRow {
  readonly idempotency_key: string;
  readonly tenant_id: string | null;
  readonly status: string;
  readonly payload_json: string | null;
}

const DIRECTORY_SELECT_SQL = `
SELECT
  t.id,
  t.organization_id,
  t.handle,
  t.name,
  t.vertical,
  t.status,
  t.operator_hold,
  t.operator_hold_reason,
  t.trial_ends_at,
  t.paid_through,
  t.deletion_due_at,
  t.cache_version,
  t.schema_version,
  t.version,
  t.created_at,
  t.updated_at,
  (
    SELECT th.host FROM tenant_hosts th
    WHERE th.tenant_id = t.id AND th.is_primary = 1
    LIMIT 1
  ) AS primary_host,
  (
    SELECT COUNT(*) FROM tenant_hosts th
    WHERE th.tenant_id = t.id AND th.kind = 'custom'
  ) AS custom_domains_count,
  (
    SELECT COUNT(*) FROM tenant_theme_entitlements tte
    INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
    WHERE tte.tenant_id = t.id AND tc.active = 1
  ) AS granted_custom_themes_count,
  (
    SELECT m.id FROM members m
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_member_id,
  (
    SELECT m.user_id FROM members m
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_user_id,
  (
    SELECT u.email FROM members m
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_user_email,
  (
    SELECT u.name FROM members m
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = t.organization_id AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  ) AS owner_user_name,
  (
    SELECT i.id FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_id,
  (
    SELECT i.email FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_email,
  (
    SELECT i.expires_at FROM invitations i
    WHERE i.organization_id = t.organization_id AND i.role = 'owner' AND i.status = 'pending'
    ORDER BY i.created_at DESC
    LIMIT 1
  ) AS owner_invitation_expires_at,
  (
    SELECT COUNT(*) FROM members m
    WHERE m.organization_id = t.organization_id
  ) AS total_members_count
FROM tenants t
`.trim();

function normalizeIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ConsoleTenantError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib disertakan (8-128 karakter alfanumerik aman).",
    );
  }
  const clean = raw.trim();
  if (!SAFE_IDEMPOTENCY_KEY_RE.test(clean)) {
    throw new ConsoleTenantError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib berupa 8-128 karakter alfanumerik aman (UUID atau token operasi).",
    );
  }
  return clean;
}

function normalizeReason(raw: unknown): string {
  try {
    return validateOperatorReason(raw);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ConsoleTenantError(422, "VALIDATION_ERROR", err.message, err);
    }
    throw err;
  }
}

function normalizeExpectedVersion(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new ConsoleTenantError(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif.",
    );
  }
  return raw;
}

function mapDirectoryRow(
  row: RawDirectoryRow,
  nowMs: number,
  saasZone: string = DEFAULT_CONSOLE_SAAS_ZONE,
): ConsoleTenantDirectoryItem {
  const operatorHold = row.operator_hold === 1;
  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );
  const ownerStatus: ConsoleTenantOwnerStatus = row.owner_member_id
    ? "active_member"
    : row.owner_invitation_id
      ? "pending_invitation"
      : "unassigned";

  return {
    id: row.id,
    organizationId: row.organization_id,
    handle: row.handle,
    name: row.name,
    vertical: row.vertical,
    status: row.status,
    effectiveStatus,
    operatorHold,
    operatorHoldReason: row.operator_hold_reason,
    primaryHost: row.primary_host ?? `${row.handle}.${saasZone}`,
    customDomainsCount: Number(row.custom_domains_count ?? 0),
    ownerEmail: row.owner_user_email ?? row.owner_invitation_email ?? null,
    ownerStatus,
    grantedCustomThemesCount: Number(row.granted_custom_themes_count ?? 0),
    trialEndsAt: row.trial_ends_at,
    paidThrough: row.paid_through,
    deletionDueAt: row.deletion_due_at,
    cacheVersion: Number(row.cache_version ?? 1),
    schemaVersion: Number(row.schema_version ?? 0),
    version: Number(row.version ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function loadDirectoryRowBySelector(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
): Promise<RawDirectoryRow | null> {
  const tenantId = selector.tenantId?.trim();
  const handle = selector.handle?.trim().toLowerCase();

  if (tenantId) {
    const row = await platformDb
      .prepare(`${DIRECTORY_SELECT_SQL} WHERE t.id = ? LIMIT 1`)
      .bind(tenantId)
      .first<RawDirectoryRow>();
    if (row) return row;
  }

  if (handle) {
    const row = await platformDb
      .prepare(`${DIRECTORY_SELECT_SQL} WHERE t.handle = ? LIMIT 1`)
      .bind(handle)
      .first<RawDirectoryRow>();
    if (row) return row;
  }

  return null;
}

/**
 * Pure helper computing the allowed high-level operator state actions for a tenant's
 * current state (PLAN §13, DEC-035 C5).
 */
export function getAllowedConsoleStateActions(state: {
  readonly status: TenantStatus;
  readonly operatorHold: boolean;
}): readonly ConsoleAllowedStateAction[] {
  if (state.status === "purging" || state.status === "purged" || state.status === "provisioning") {
    return [];
  }

  const actions: ConsoleAllowedStateAction[] = [];
  if (!state.operatorHold) {
    actions.push("suspend_hold");
  } else {
    actions.push("release_hold");
  }

  if (state.status === "recovery") {
    actions.push("exit_recovery");
  } else {
    actions.push("enter_recovery");
  }

  return actions;
}

const ALLOWED_SET_STATUS_MATRIX: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  provisioning: [],
  trial: ["active", "suspended", "recovery"],
  active: ["grace", "locked", "suspended", "recovery"],
  grace: ["active", "locked", "suspended", "recovery"],
  locked: ["active", "suspended", "recovery"],
  suspended: ["active", "trial", "grace", "locked", "recovery"],
  recovery: ["active", "trial", "grace", "locked", "suspended"],
  purging: [],
  purged: [],
};

/**
 * Pure strict transition matrix validator & next-state resolver for console operator
 * service-state transitions (PLAN §13, DEC-035 C5, REQ-049).
 */
export function resolveConsoleServiceStateTransition(
  current: {
    readonly status: TenantStatus;
    readonly operatorHold: boolean;
    readonly operatorHoldReason: string | null;
    readonly trialEndsAt: number | null;
    readonly paidThrough: number | null;
  },
  input: {
    readonly action: ConsoleStateTransitionAction;
    readonly targetStatus?: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery";
    readonly operatorHold?: boolean;
    readonly paidThroughMs?: number | null;
    readonly trialEndsAtMs?: number | null;
    readonly cleanReason: string;
    readonly nowMs: number;
  },
): {
  readonly nextStatus: TenantStatus;
  readonly nextOperatorHold: boolean;
  readonly nextOperatorHoldReason: string | null;
  readonly nextPaidThrough: number | null;
  readonly nextTrialEndsAt: number | null;
  readonly pauseRetention: boolean;
  readonly clearRetentionPause: boolean;
} {
  if (
    current.status === "purging" ||
    current.status === "purged" ||
    current.status === "provisioning"
  ) {
    throw new ConsoleTenantError(
      409,
      "INVALID_STATE_TRANSITION",
      `Tenant dengan status "${current.status}" tidak mengizinkan transisi status layanan.`,
    );
  }

  switch (input.action) {
    case "suspend_hold": {
      if (current.operatorHold) {
        throw new ConsoleTenantError(
          409,
          "INVALID_STATE_TRANSITION",
          "Tenant sudah berada dalam status penangguhan operator (hold).",
        );
      }
      return {
        nextStatus: "suspended",
        nextOperatorHold: true,
        nextOperatorHoldReason: input.cleanReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: true,
        clearRetentionPause: false,
      };
    }

    case "release_hold": {
      if (!current.operatorHold) {
        throw new ConsoleTenantError(
          409,
          "INVALID_STATE_TRANSITION",
          "Tenant tidak sedang berada dalam penangguhan operator (hold).",
        );
      }
      // PLAN §13: Releasing a suspension recomputes entitlement state; NEVER grants free active time.
      const recomputed = computeEffectiveTenantStatus(
        {
          storedStatus:
            current.paidThrough !== null
              ? "active"
              : current.trialEndsAt !== null
                ? "trial"
                : "suspended",
          operatorHold: false,
          trialEndsAt: current.trialEndsAt,
          paidThrough: current.paidThrough,
        },
        input.nowMs,
      );
      return {
        nextStatus: recomputed,
        nextOperatorHold: false,
        nextOperatorHoldReason: null,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: true,
      };
    }

    case "enter_recovery": {
      if (current.status === "recovery") {
        throw new ConsoleTenantError(
          409,
          "INVALID_STATE_TRANSITION",
          "Tenant sudah berada dalam mode pemulihan (recovery).",
        );
      }
      return {
        nextStatus: "recovery",
        nextOperatorHold: current.operatorHold,
        nextOperatorHoldReason: current.operatorHoldReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: false,
      };
    }

    case "exit_recovery": {
      if (current.status !== "recovery") {
        throw new ConsoleTenantError(
          409,
          "INVALID_STATE_TRANSITION",
          "Tenant tidak sedang berada dalam mode pemulihan (recovery).",
        );
      }
      const recomputed = computeEffectiveTenantStatus(
        {
          storedStatus:
            current.paidThrough !== null
              ? "active"
              : current.trialEndsAt !== null
                ? "trial"
                : "suspended",
          operatorHold: current.operatorHold,
          trialEndsAt: current.trialEndsAt,
          paidThrough: current.paidThrough,
        },
        input.nowMs,
      );
      return {
        nextStatus: recomputed,
        nextOperatorHold: current.operatorHold,
        nextOperatorHoldReason: current.operatorHoldReason,
        nextPaidThrough: current.paidThrough,
        nextTrialEndsAt: current.trialEndsAt,
        pauseRetention: false,
        clearRetentionPause: false,
      };
    }

    case "set_status": {
      if (!input.targetStatus) {
        throw new ConsoleTenantError(
          422,
          "VALIDATION_ERROR",
          'targetStatus wajib diisi ketika action bernilai "set_status".',
        );
      }

      if (current.operatorHold && input.operatorHold === undefined) {
        throw new ConsoleTenantError(
          409,
          "INVALID_STATE_TRANSITION",
          "Tenant sedang dalam penangguhan operator (hold); gunakan aksi release_hold atau sertakan operatorHold secara eksplisit.",
        );
      }

      const allowedTargets = ALLOWED_SET_STATUS_MATRIX[current.status] ?? [];
      const nextHold =
        input.operatorHold !== undefined
          ? input.operatorHold
          : input.targetStatus === "suspended"
            ? current.operatorHold
            : false;

      if (!allowedTargets.includes(input.targetStatus)) {
        if (input.targetStatus === current.status && nextHold === current.operatorHold) {
          throw new ConsoleTenantError(
            409,
            "INVALID_STATE_TRANSITION",
            `Tenant sudah berstatus "${current.status}".`,
          );
        }
        if (input.targetStatus !== current.status) {
          throw new ConsoleTenantError(
            409,
            "INVALID_STATE_TRANSITION",
            `Transisi status dari "${current.status}" ke "${input.targetStatus}" tidak diizinkan.`,
          );
        }
      }

      const candidatePaidThrough =
        input.paidThroughMs !== undefined ? input.paidThroughMs : current.paidThrough;
      const candidateTrialEndsAt =
        input.trialEndsAtMs !== undefined ? input.trialEndsAtMs : current.trialEndsAt;

      if (input.targetStatus === "active") {
        if (
          typeof candidatePaidThrough !== "number" ||
          !Number.isSafeInteger(candidatePaidThrough) ||
          candidatePaidThrough <= input.nowMs
        ) {
          throw new ConsoleTenantError(
            422,
            "VALIDATION_ERROR",
            'Transisi set_status ke "active" wajib menyertakan paidThroughMs masa depan yang valid (tanpa akses gratis tak terbatas).',
          );
        }
      }

      if (input.targetStatus === "trial") {
        if (
          typeof candidateTrialEndsAt !== "number" ||
          !Number.isSafeInteger(candidateTrialEndsAt) ||
          candidateTrialEndsAt <= input.nowMs
        ) {
          throw new ConsoleTenantError(
            422,
            "VALIDATION_ERROR",
            'Transisi set_status ke "trial" wajib menyertakan trialEndsAtMs masa depan yang valid.',
          );
        }
      }

      return {
        nextStatus: input.targetStatus,
        nextOperatorHold: nextHold,
        nextOperatorHoldReason: nextHold ? input.cleanReason : null,
        nextPaidThrough: candidatePaidThrough,
        nextTrialEndsAt: candidateTrialEndsAt,
        pauseRetention: nextHold,
        clearRetentionPause: !nextHold && current.operatorHold,
      };
    }
  }
}

/**
 * Lists and searches tenants strictly from `PLATFORM_DB` metadata with safe pagination
 * and filters (name/handle/ID/hostname, status, vertical). Never opens `TenantStore`.
 */
export async function listConsoleTenantsDirectory(
  platformDb: D1Database,
  options: {
    readonly search?: string;
    readonly status?: string;
    readonly vertical?: string;
    readonly page?: number;
    readonly limit?: number;
    readonly nowMs?: number;
    readonly saasZone?: string;
  } = {},
): Promise<ConsoleTenantDirectoryPage> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  const rawSearch = options.search?.trim() ?? "";
  if (rawSearch) {
    const lowerSearch = rawSearch.toLowerCase();
    const like = `%${lowerSearch}%`;
    clauses.push(
      `(lower(t.handle) LIKE ? OR lower(t.name) LIKE ? OR t.id = ? OR EXISTS (SELECT 1 FROM tenant_hosts th WHERE th.tenant_id = t.id AND lower(th.host) LIKE ?))`,
    );
    bindings.push(like, like, rawSearch, like);
  }

  const rawStatus = options.status?.trim().toLowerCase() ?? "";
  if (rawStatus && rawStatus !== "all") {
    if (!(TENANT_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new ConsoleTenantError(
        422,
        "VALIDATION_ERROR",
        `Filter status "${rawStatus}" tidak valid.`,
      );
    }
    clauses.push("t.status = ?");
    bindings.push(rawStatus);
  }

  const rawVertical = options.vertical?.trim().toLowerCase() ?? "";
  if (rawVertical && rawVertical !== "all") {
    if (!(TENANT_VERTICALS as readonly string[]).includes(rawVertical)) {
      throw new ConsoleTenantError(
        422,
        "VALIDATION_ERROR",
        `Filter vertikal "${rawVertical}" tidak valid.`,
      );
    }
    clauses.push("t.vertical = ?");
    bindings.push(rawVertical);
  }

  const limit = Math.max(
    1,
    Math.min(MAX_CONSOLE_TENANTS_LIMIT, Math.trunc(options.limit ?? DEFAULT_CONSOLE_TENANTS_LIMIT)),
  );
  const page = Math.max(1, Math.min(1000, Math.trunc(options.page ?? 1)));
  const offset = (page - 1) * limit;

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const [countRow, listRows, statusGroupRows] = await Promise.all([
    platformDb
      .prepare(`SELECT COUNT(*) AS cnt FROM tenants t ${whereSql}`)
      .bind(...bindings)
      .first<{ readonly cnt: number }>(),
    platformDb
      .prepare(
        `${DIRECTORY_SELECT_SQL}
         ${whereSql}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, limit, offset)
      .all<RawDirectoryRow>(),
    platformDb
      .prepare("SELECT status, COUNT(*) AS cnt FROM tenants GROUP BY status")
      .all<{ readonly status: string; readonly cnt: number }>(),
  ]);

  const totalCount = Number(countRow?.cnt ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const saasZone = options.saasZone ?? DEFAULT_CONSOLE_SAAS_ZONE;
  const items = (listRows.results ?? []).map((row) => mapDirectoryRow(row, nowMs, saasZone));

  const statusCounts: Record<string, number> = {};
  for (const row of statusGroupRows.results ?? []) {
    statusCounts[row.status] = Number(row.cnt ?? 0);
  }

  return {
    items,
    page,
    limit,
    totalCount,
    totalPages,
    hasMore: page < totalPages,
    statusCounts,
  };
}

/**
 * Loads granted custom themes for a single tenant from `PLATFORM_DB` (`tenant_theme_entitlements`).
 */
export async function listConsoleTenantThemeGrants(
  platformDb: D1Database,
  tenantId: string,
): Promise<readonly ConsoleTenantGrantedThemeRecord[]> {
  const result = await platformDb
    .prepare(
      `SELECT tte.id,
              tte.theme_id,
              tc.slug,
              tc.name,
              tc.tier,
              tc.active,
              tte.granted_by,
              tte.settlement_id,
              tte.granted_at
       FROM tenant_theme_entitlements tte
       INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
       WHERE tte.tenant_id = ?
       ORDER BY tte.granted_at DESC, tte.id DESC`,
    )
    .bind(tenantId)
    .all<RawGrantedThemeRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    themeId: row.theme_id,
    slug: row.slug,
    name: row.name,
    tier: row.tier,
    active: row.active === 1,
    grantedBy: row.granted_by,
    settlementId: row.settlement_id,
    grantedAt: Number(row.granted_at),
  }));
}

/**
 * Narrow read-only probe of `TenantStore.site_settings.active_theme_id` used strictly to
 * protect against revoking a tenant's currently active custom theme (REQ-049, PLAN §13).
 * NEVER reads pages, posts, offerings, media, or visitor leads.
 */
export async function inspectTenantActiveThemeId(
  tenantStore: TenantStoreNamespaceLike | null | undefined,
  tenantId: string,
  schemaVersion: number,
): Promise<{
  readonly status: ActiveThemeVerificationStatus;
  readonly activeThemeId: string | null;
}> {
  if (!tenantStore) {
    return { status: "unavailable", activeThemeId: null };
  }

  try {
    const stub = openTenantStoreStub(tenantStore, tenantId);
    const tenantDb = createTenantDb(stub);
    const row = await tenantDb
      .prepare("SELECT active_theme_id FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly active_theme_id: string | null }>();

    if (row && typeof row.active_theme_id === "string" && row.active_theme_id.trim()) {
      return {
        status: "verified",
        activeThemeId: row.active_theme_id.trim(),
      };
    }

    if (schemaVersion === 0) {
      return { status: "uninitialized", activeThemeId: null };
    }

    // Tenant has schema_version > 0 but site_settings row is missing -> fail closed on revoke!
    return { status: "unavailable", activeThemeId: null };
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (schemaVersion === 0 && message.includes("no such table")) {
      return { status: "uninitialized", activeThemeId: null };
    }
    return { status: "unavailable", activeThemeId: null };
  }
}

/**
 * Reads full control-plane tenant detail for `console.punyasitus.com/tenants/{handle}`:
 * identity, owner membership / pending invitation summary, service state, domains,
 * granted themes, read-only active theme ID, and recent redacted audit log.
 * Never reads customer content or leads.
 */
export async function getConsoleTenantDetail(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
  options: {
    readonly nowMs?: number;
    readonly saasZone?: string;
    readonly tenantStore?: TenantStoreNamespaceLike | null;
  } = {},
): Promise<ConsoleTenantDetailDto | null> {
  const row = await loadDirectoryRowBySelector(platformDb, selector);
  if (!row) return null;

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const saasZone = options.saasZone ?? DEFAULT_CONSOLE_SAAS_ZONE;
  const tenant = mapDirectoryRow(row, nowMs, saasZone);

  const [hostsRes, grantedThemes, auditPage, activeThemeCheck] = await Promise.all([
    platformDb
      .prepare(
        `SELECT host, kind, status, ssl_status, is_primary, verified_at, last_checked_at
         FROM tenant_hosts
         WHERE tenant_id = ?
         ORDER BY is_primary DESC, created_at ASC`,
      )
      .bind(tenant.id)
      .all<RawHostRow>(),
    listConsoleTenantThemeGrants(platformDb, tenant.id),
    queryPlatformAuditPage(platformDb, { tenantId: tenant.id, limit: 20 }),
    inspectTenantActiveThemeId(options.tenantStore, tenant.id, tenant.schemaVersion),
  ]);

  const domains: ConsoleTenantHostRecord[] = (hostsRes.results ?? []).map((h) => ({
    host: h.host,
    kind: h.kind,
    status: h.status,
    sslStatus: h.ssl_status,
    isPrimary: h.is_primary === 1,
    verifiedAt: h.verified_at,
    lastCheckedAt: h.last_checked_at,
  }));

  const owner: ConsoleTenantOwnerSummary = {
    status: tenant.ownerStatus,
    memberId: row.owner_member_id,
    userId: row.owner_user_id,
    email: row.owner_user_email ?? row.owner_invitation_email ?? null,
    displayName: row.owner_user_name ?? null,
    pendingInvitationId: row.owner_invitation_id,
    pendingInvitationEmail: row.owner_invitation_email,
    pendingInvitationExpiresAt: row.owner_invitation_expires_at,
    totalMembersCount: Number(row.total_members_count ?? 0),
  };

  return {
    tenant,
    owner,
    domains,
    grantedThemes,
    activeThemeId: activeThemeCheck.activeThemeId,
    activeThemeVerificationStatus: activeThemeCheck.status,
    allowedStateActions: getAllowedConsoleStateActions({
      status: tenant.status,
      operatorHold: tenant.operatorHold,
    }),
    recentAudit: auditPage.items,
  };
}

/**
 * Executes an audited operator tenant service-state transition inside ONE atomic
 * `D1Database.batch([...])` enforcing:
 * - Strict allowed transition matrix (`409 INVALID_STATE_TRANSITION`)
 * - Mandatory reason (`10-500` chars, `422 VALIDATION_ERROR`)
 * - Optimistic concurrency (`expectedVersion`, `409 STALE_VERSION`)
 * - Mandatory idempotency key (`job_ledger`, replay `200`, mismatch `409 IDEMPOTENCY_CONFLICT`)
 * - Atomic `platform_audit` with `WHERE changes() = 1` (audit failure rolls back state update!)
 * - Immediate isolate host cache eviction (`evictTenantFromCache`)
 */
export async function executeConsoleTenantStateTransition(
  platformDb: D1Database,
  input: ConsoleTenantStateTransitionInput,
): Promise<ConsoleTenantStateTransitionResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new ConsoleTenantError(422, "VALIDATION_ERROR", "actorUserId wajib diisi.");
  }

  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
  const cleanReason = normalizeReason(input.reason);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const saasZone = input.saasZone ?? DEFAULT_CONSOLE_SAAS_ZONE;
  const ledgerKey = `state-transition:${idempotencyKey}`;

  const currentRow = await loadDirectoryRowBySelector(platformDb, {
    tenantId: input.tenantId,
    handle: input.handle,
  });
  if (!currentRow) {
    throw new ConsoleTenantError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const requestHash = await computeStateTransitionRequestHash({
    tenantId: currentRow.id,
    action: input.action,
    targetStatus: input.targetStatus ?? null,
    hasPaidThroughMs: input.paidThroughMs !== undefined,
    paidThroughMs: input.paidThroughMs ?? null,
    hasTrialEndsAtMs: input.trialEndsAtMs !== undefined,
    trialEndsAtMs: input.trialEndsAtMs ?? null,
    hasOperatorHold: input.operatorHold !== undefined,
    operatorHold: input.operatorHold ?? null,
    reason: cleanReason,
    expectedVersion,
  });

  // 1. Idempotency check BEFORE transition matrix & version check
  const existingLedger = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(ledgerKey)
    .first<JobLedgerRow>();

  if (existingLedger && existingLedger.tenant_id) {
    const stored = assertStateTransitionLedgerMatches(existingLedger, {
      tenantId: currentRow.id,
      action: input.action,
      targetStatus: input.targetStatus ?? null,
      requestHash,
    });
    return {
      tenant: mapDirectoryRow(currentRow, nowMs, saasZone),
      previousStatus: stored?.previousStatus ?? currentRow.status,
      previousOperatorHold: stored?.previousOperatorHold ?? currentRow.operator_hold === 1,
      replayed: true,
      audit: null,
    };
  }

  // 2. Optimistic concurrency check
  if (expectedVersion !== currentRow.version) {
    throw new ConsoleTenantError(
      409,
      "STALE_VERSION",
      `Versi tenant berubah (diharapkan v${expectedVersion}, saat ini v${currentRow.version}). Muat ulang data lalu coba lagi.`,
    );
  }

  // 3. Strict transition matrix evaluation
  const resolved = resolveConsoleServiceStateTransition(
    {
      status: currentRow.status,
      operatorHold: currentRow.operator_hold === 1,
      operatorHoldReason: currentRow.operator_hold_reason,
      trialEndsAt: currentRow.trial_ends_at,
      paidThrough: currentRow.paid_through,
    },
    {
      action: input.action,
      targetStatus: input.targetStatus,
      operatorHold: input.operatorHold,
      paidThroughMs: input.paidThroughMs,
      trialEndsAtMs: input.trialEndsAtMs,
      cleanReason,
      nowMs,
    },
  );

  const retentionClause = resolved.pauseRetention
    ? "retention_paused_at = COALESCE(retention_paused_at, ?)"
    : resolved.clearRetentionPause
      ? "retention_paused_at = NULL"
      : "retention_paused_at = retention_paused_at";

  const updateBindings: (string | number | null)[] = [
    resolved.nextStatus,
    resolved.nextOperatorHold ? 1 : 0,
    resolved.nextOperatorHoldReason,
    resolved.nextPaidThrough,
    resolved.nextTrialEndsAt,
  ];
  if (resolved.pauseRetention) {
    updateBindings.push(nowMs);
  }
  updateBindings.push(nowMs, currentRow.id, expectedVersion);

  const updateStmt = platformDb
    .prepare(
      `UPDATE tenants
       SET status = ?,
           operator_hold = ?,
           operator_hold_reason = ?,
           paid_through = ?,
           trial_ends_at = ?,
           ${retentionClause},
           cache_version = cache_version + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(...updateBindings);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: `tenant.state.${input.action}`,
      targetType: "tenant",
      targetId: currentRow.id,
      tenantId: currentRow.id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        handle: currentRow.handle,
        fromStatus: currentRow.status,
        toStatus: resolved.nextStatus,
        fromOperatorHold: currentRow.operator_hold === 1,
        toOperatorHold: resolved.nextOperatorHold,
        expectedVersion,
        idempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const ledgerStmt = platformDb
    .prepare(
      `INSERT INTO job_ledger (
        idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
      )
      SELECT ?, 'tenant.state_transition', ?, 'completed', 1, ?, ?, ?
      WHERE changes() = 1`,
    )
    .bind(
      ledgerKey,
      currentRow.id,
      JSON.stringify({
        tenantId: currentRow.id,
        action: input.action,
        targetStatus: input.targetStatus ?? null,
        requestHash,
        previousStatus: currentRow.status,
        previousOperatorHold: currentRow.operator_hold === 1,
      }),
      nowMs,
      nowMs,
    );

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateStmt, auditStmt, ledgerStmt]);
  } catch (err) {
    // Re-check for concurrent idempotency race
    const raceLedger = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(ledgerKey)
      .first<JobLedgerRow>();
    if (raceLedger && raceLedger.tenant_id) {
      const stored = assertStateTransitionLedgerMatches(
        raceLedger,
        {
          tenantId: currentRow.id,
          action: input.action,
          targetStatus: input.targetStatus ?? null,
          requestHash,
        },
        err,
      );
      const refreshed = await loadDirectoryRowBySelector(platformDb, {
        tenantId: raceLedger.tenant_id,
      });
      if (refreshed) {
        return {
          tenant: mapDirectoryRow(refreshed, nowMs, saasZone),
          previousStatus: stored?.previousStatus ?? refreshed.status,
          previousOperatorHold: stored?.previousOperatorHold ?? refreshed.operator_hold === 1,
          replayed: true,
          audit: null,
        };
      }
    }

    throw new ConsoleTenantError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transisi status layanan dibatalkan karena gagal menyimpan catatan audit secara atomik.",
      err,
    );
  }

  const updateChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (updateChanges !== 1) {
    throw new ConsoleTenantError(
      409,
      "STALE_VERSION",
      "Status tenant berubah secara bersamaan oleh operasi lain. Muat ulang data lalu coba lagi.",
    );
  }

  if (auditChanges !== 1) {
    throw new ConsoleTenantError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit transisi status layanan tidak berhasil tersimpan.",
    );
  }

  evictTenantFromCache(currentRow.id);

  const updatedRow = await loadDirectoryRowBySelector(platformDb, { tenantId: currentRow.id });
  if (!updatedRow) {
    throw new ConsoleTenantError(404, "NOT_FOUND", "Tenant tidak ditemukan setelah pembaruan.");
  }

  return {
    tenant: mapDirectoryRow(updatedRow, nowMs, saasZone),
    previousStatus: currentRow.status,
    previousOperatorHold: currentRow.operator_hold === 1,
    replayed: false,
    audit: auditEntry,
  };
}

/**
 * Atomically grants or revokes a registered custom theme entitlement for a tenant:
 * - Grant accepts ONLY registered custom themes from the closed build-time registry (`422` otherwise).
 * - Revoke checks `TenantStore` `site_settings.active_theme_id` (FAILS CLOSED `503` if unavailable)
 *   and BLOCKS revoking the tenant's currently active theme (`409 ACTIVE_THEME_PROTECTED`).
 * - Enforces mandatory reason (`10-500` chars), `expectedVersion` (`409 STALE_VERSION`),
 *   idempotency key (`job_ledger`), atomic `platform_audit` (`WHERE changes() = 1`), and
 *   immediate cache eviction while leaving all tenant content 100% untouched.
 */
export async function manageConsoleTenantThemeGrant(
  platformDb: D1Database,
  input: ManageConsoleTenantThemeGrantInput,
): Promise<ManageConsoleTenantThemeGrantResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new ConsoleTenantError(422, "VALIDATION_ERROR", "actorUserId wajib diisi.");
  }

  if (input.action !== "grant" && input.action !== "revoke") {
    throw new ConsoleTenantError(
      422,
      "VALIDATION_ERROR",
      'Aksi tema hanya boleh bernilai "grant" atau "revoke".',
    );
  }

  const themeId = input.themeId.trim();
  if (!themeId) {
    throw new ConsoleTenantError(422, "VALIDATION_ERROR", "themeId wajib diisi.");
  }

  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
  const cleanReason = normalizeReason(input.reason);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const saasZone = input.saasZone ?? DEFAULT_CONSOLE_SAAS_ZONE;
  const ledgerKey = `theme-grant:${idempotencyKey}`;

  const currentRow = await loadDirectoryRowBySelector(platformDb, {
    tenantId: input.tenantId,
    handle: input.handle,
  });
  if (!currentRow) {
    throw new ConsoleTenantError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  // 1. Idempotent replay check FIRST
  const existingLedger = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(ledgerKey)
    .first<JobLedgerRow>();

  if (existingLedger && existingLedger.tenant_id) {
    if (existingLedger.tenant_id !== currentRow.id) {
      throw new ConsoleTenantError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk tenant yang berbeda.",
      );
    }
    const stored = existingLedger.payload_json
      ? (JSON.parse(existingLedger.payload_json) as {
          readonly tenantId?: string;
          readonly themeId?: string;
          readonly action?: string;
        })
      : null;
    if (
      stored &&
      ((stored.tenantId && stored.tenantId !== currentRow.id) ||
        stored.themeId !== themeId ||
        stored.action !== input.action)
    ) {
      throw new ConsoleTenantError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk operasi tema yang berbeda.",
      );
    }
    const grants = await listConsoleTenantThemeGrants(platformDb, currentRow.id);
    return {
      action: input.action,
      themeId,
      replayed: true,
      tenant: mapDirectoryRow(currentRow, nowMs, saasZone),
      grantedThemes: grants,
      audit: null,
    };
  }

  if (currentRow.status === "purging" || currentRow.status === "purged") {
    throw new ConsoleTenantError(
      409,
      "INVALID_STATE_TRANSITION",
      `Tenant dengan status "${currentRow.status}" tidak dapat diubah izin temanya.`,
    );
  }

  // 2. Theme registry validation
  if (input.isBuiltInPlatformTheme) {
    throw new ConsoleTenantError(
      422,
      "BUILT_IN_THEME_NOT_GRANTABLE",
      `Tema bawaan platform "${themeId}" tersedia otomatis untuk seluruh tenant dan tidak dapat diberikan atau dicabut melalui grant tema kustom.`,
    );
  }

  if (input.action === "grant" && !input.registeredCustomTheme) {
    throw new ConsoleTenantError(
      422,
      "UNREGISTERED_THEME",
      `Tema kustom "${themeId}" tidak terdaftar pada registry tema build-time yang diverifikasi.`,
    );
  }

  // 3. Optimistic concurrency check
  if (expectedVersion !== currentRow.version) {
    throw new ConsoleTenantError(
      409,
      "STALE_VERSION",
      `Versi tenant berubah (diharapkan v${expectedVersion}, saat ini v${currentRow.version}). Muat ulang data lalu coba lagi.`,
    );
  }

  const existingGrant = await platformDb
    .prepare(
      "SELECT id FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
    )
    .bind(currentRow.id, themeId)
    .first<{ readonly id: string }>();

  if (input.action === "grant") {
    if (existingGrant) {
      throw new ConsoleTenantError(
        409,
        "THEME_ALREADY_GRANTED",
        `Tema "${themeId}" sudah diberikan kepada tenant "${currentRow.handle}".`,
      );
    }

    const customTheme = input.registeredCustomTheme!;
    const grantId = generatePlatformAuditId(nowMs);

    // Ensure verified build-time custom theme exists in `theme_catalog` inside the SAME batch
    const ensureCatalogStmt = platformDb
      .prepare(
        `INSERT OR IGNORE INTO theme_catalog (
          id, slug, name, tier, price_idr, active, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'custom', 0, 1, 1, ?, ?)`,
      )
      .bind(customTheme.id, customTheme.slug, customTheme.name, nowMs, nowMs);

    const updateTenantStmt = platformDb
      .prepare(
        `UPDATE tenants
         SET version = version + 1,
             cache_version = cache_version + 1,
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND NOT EXISTS (
             SELECT 1 FROM tenant_theme_entitlements
             WHERE tenant_id = ? AND theme_id = ?
           )`,
      )
      .bind(nowMs, currentRow.id, expectedVersion, currentRow.id, customTheme.id);

    const insertGrantStmt = platformDb
      .prepare(
        `INSERT INTO tenant_theme_entitlements (
          id, tenant_id, theme_id, granted_by, settlement_id, granted_at
        )
        SELECT ?, ?, ?, ?, NULL, ?
        WHERE changes() = 1`,
      )
      .bind(grantId, currentRow.id, customTheme.id, actorUserId, nowMs);

    const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
      platformDb,
      {
        actorUserId,
        actorRole: "platform_operator",
        action: "tenant.theme.grant",
        targetType: "tenant_theme",
        targetId: `${currentRow.id}:${customTheme.id}`,
        tenantId: currentRow.id,
        reason: cleanReason,
        requireReason: true,
        outcome: "success",
        requestId: input.requestId ?? null,
        metadata: {
          handle: currentRow.handle,
          themeId: customTheme.id,
          themeName: customTheme.name,
          expectedVersion,
          idempotencyKey,
        },
        createdAtMs: nowMs,
      },
      { onlyIfPreviousChanged: true },
    );

    const ledgerStmt = platformDb
      .prepare(
        `INSERT INTO job_ledger (
          idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
        )
        SELECT ?, 'tenant.theme_grant', ?, 'completed', 1, ?, ?, ?
        WHERE changes() = 1`,
      )
      .bind(
        ledgerKey,
        currentRow.id,
        JSON.stringify({
          tenantId: currentRow.id,
          themeId: customTheme.id,
          action: "grant",
        }),
        nowMs,
        nowMs,
      );

    let results: D1Result[];
    try {
      results = await platformDb.batch([
        ensureCatalogStmt,
        updateTenantStmt,
        insertGrantStmt,
        auditStmt,
        ledgerStmt,
      ]);
    } catch (err) {
      throw new ConsoleTenantError(
        500,
        "AUDIT_PERSISTENCE_FAILED",
        "Pemberian izin tema dibatalkan karena gagal menyimpan catatan atomik atau audit.",
        err,
      );
    }

    const tenantChanges = results[1]?.meta?.changes ?? 0;
    const grantChanges = results[2]?.meta?.changes ?? 0;
    const auditChanges = results[3]?.meta?.changes ?? 0;

    if (tenantChanges !== 1) {
      const concurrentGrant = await platformDb
        .prepare(
          "SELECT id FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
        )
        .bind(currentRow.id, customTheme.id)
        .first<{ readonly id: string }>();
      if (concurrentGrant) {
        throw new ConsoleTenantError(
          409,
          "THEME_ALREADY_GRANTED",
          `Tema "${customTheme.id}" sudah diberikan kepada tenant "${currentRow.handle}".`,
        );
      }
      throw new ConsoleTenantError(
        409,
        "STALE_VERSION",
        "Versi tenant berubah secara bersamaan. Muat ulang data lalu coba lagi.",
      );
    }

    if (grantChanges !== 1 || auditChanges !== 1) {
      throw new ConsoleTenantError(
        500,
        "AUDIT_PERSISTENCE_FAILED",
        "Catatan audit pemberian izin tema tidak berhasil tersimpan.",
      );
    }

    evictTenantFromCache(currentRow.id);

    const [updatedRow, grantedThemes] = await Promise.all([
      loadDirectoryRowBySelector(platformDb, { tenantId: currentRow.id }),
      listConsoleTenantThemeGrants(platformDb, currentRow.id),
    ]);
    if (!updatedRow) {
      throw new ConsoleTenantError(404, "NOT_FOUND", "Tenant tidak ditemukan setelah pembaruan.");
    }

    return {
      action: "grant",
      themeId: customTheme.id,
      replayed: false,
      tenant: mapDirectoryRow(updatedRow, nowMs, saasZone),
      grantedThemes,
      audit: auditEntry,
    };
  }

  // action === "revoke"
  if (!existingGrant) {
    throw new ConsoleTenantError(
      404,
      "THEME_GRANT_NOT_FOUND",
      `Izin tema "${themeId}" tidak ditemukan pada tenant "${currentRow.handle}".`,
    );
  }

  // Mandatory Active-Theme Verification — FAILS CLOSED if TenantStore cannot be verified!
  // lazy: cross-store active-theme check has an inherent TOCTOU ceiling between TenantStore and PLATFORM_DB; TASK-042 activation re-validates entitlements.
  const activeCheck = await inspectTenantActiveThemeId(
    input.tenantStore,
    currentRow.id,
    currentRow.schema_version,
  );

  if (activeCheck.status === "unavailable") {
    throw new ConsoleTenantError(
      503,
      "ACTIVE_THEME_VERIFICATION_UNAVAILABLE",
      "Tidak dapat memverifikasi tema aktif tenant pada TenantStore; pencabutan izin tema diblokir (fail-closed).",
    );
  }

  if (activeCheck.activeThemeId === themeId) {
    // Best-effort denied audit record for blocked active-theme revocation attempt
    try {
      await appendPlatformAudit(platformDb, {
        actorUserId,
        actorRole: "platform_operator",
        action: "tenant.theme.revoke",
        targetType: "tenant_theme",
        targetId: `${currentRow.id}:${themeId}`,
        tenantId: currentRow.id,
        reason: cleanReason,
        requireReason: false,
        outcome: "denied",
        requestId: input.requestId ?? null,
        metadata: {
          handle: currentRow.handle,
          themeId,
          code: "ACTIVE_THEME_PROTECTED",
        },
        createdAtMs: nowMs,
      });
    } catch {
      // Blocking active-theme revocation must remain authoritative even if deny audit fails.
    }

    throw new ConsoleTenantError(
      409,
      "ACTIVE_THEME_PROTECTED",
      `Tema "${themeId}" sedang aktif digunakan oleh tenant "${currentRow.handle}". Aktifkan tema bawaan yang kompatibel terlebih dahulu sebelum mencabut izin tema ini.`,
    );
  }

  const updateTenantStmt = platformDb
    .prepare(
      `UPDATE tenants
       SET version = version + 1,
           cache_version = cache_version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?
         AND EXISTS (
           SELECT 1 FROM tenant_theme_entitlements
           WHERE tenant_id = ? AND theme_id = ?
         )`,
    )
    .bind(nowMs, currentRow.id, expectedVersion, currentRow.id, themeId);

  const deleteGrantStmt = platformDb
    .prepare(
      `DELETE FROM tenant_theme_entitlements
       WHERE tenant_id = ?
         AND theme_id = ?
         AND changes() = 1`,
    )
    .bind(currentRow.id, themeId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "tenant.theme.revoke",
      targetType: "tenant_theme",
      targetId: `${currentRow.id}:${themeId}`,
      tenantId: currentRow.id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        handle: currentRow.handle,
        themeId,
        activeThemeAtRevoke: activeCheck.activeThemeId ?? "uninitialized",
        expectedVersion,
        idempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const ledgerStmt = platformDb
    .prepare(
      `INSERT INTO job_ledger (
        idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
      )
      SELECT ?, 'tenant.theme_revoke', ?, 'completed', 1, ?, ?, ?
      WHERE changes() = 1`,
    )
    .bind(
      ledgerKey,
      currentRow.id,
      JSON.stringify({
        tenantId: currentRow.id,
        themeId,
        action: "revoke",
      }),
      nowMs,
      nowMs,
    );

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateTenantStmt, deleteGrantStmt, auditStmt, ledgerStmt]);
  } catch (err) {
    throw new ConsoleTenantError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Pencabutan izin tema dibatalkan karena gagal menyimpan catatan audit secara atomik.",
      err,
    );
  }

  const tenantChanges = results[0]?.meta?.changes ?? 0;
  const deleteChanges = results[1]?.meta?.changes ?? 0;
  const auditChanges = results[2]?.meta?.changes ?? 0;

  if (tenantChanges !== 1) {
    const stillExists = await platformDb
      .prepare(
        "SELECT id FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
      )
      .bind(currentRow.id, themeId)
      .first<{ readonly id: string }>();
    if (!stillExists) {
      throw new ConsoleTenantError(
        404,
        "THEME_GRANT_NOT_FOUND",
        `Izin tema "${themeId}" sudah tidak tersedia pada tenant "${currentRow.handle}".`,
      );
    }
    throw new ConsoleTenantError(
      409,
      "STALE_VERSION",
      "Versi tenant berubah secara bersamaan. Muat ulang data lalu coba lagi.",
    );
  }

  if (deleteChanges !== 1 || auditChanges !== 1) {
    throw new ConsoleTenantError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit pencabutan izin tema tidak berhasil tersimpan.",
    );
  }

  evictTenantFromCache(currentRow.id);

  const [updatedRow, grantedThemes] = await Promise.all([
    loadDirectoryRowBySelector(platformDb, { tenantId: currentRow.id }),
    listConsoleTenantThemeGrants(platformDb, currentRow.id),
  ]);
  if (!updatedRow) {
    throw new ConsoleTenantError(404, "NOT_FOUND", "Tenant tidak ditemukan setelah pembaruan.");
  }

  return {
    action: "revoke",
    themeId,
    replayed: false,
    tenant: mapDirectoryRow(updatedRow, nowMs, saasZone),
    grantedThemes,
    audit: auditEntry,
  };
}
