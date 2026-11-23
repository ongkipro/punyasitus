import {
  evaluateEntitlementState,
  formatWibDateTimeLabel,
  type EntitlementEvaluationResult,
} from "@punyasitus/core/billing/index";
import type { ApiErrorCode, Role, TenantStatus } from "@punyasitus/core/schemas";
import { AuthorizationError, isActionAllowedForTenantStatus, type PermissionAction } from "../permissions.ts";

/**
 * Live server-side tenant entitlement loader and request enforcement gate
 * (PLAN §4, §17.1; REQ-060; TASK-059).
 *
 * Hard invariants:
 * - Always queries `PLATFORM_DB.tenants` directly using server wall-clock `nowMs` (never cached,
 *   never trusts client timestamps or stale tenant state from another workspace).
 * - Recalculates independently on every tenant switch.
 * - Blocks all CMS write/publish mutations in `locked` and `suspended` with `403 SUBSCRIPTION_LOCKED`.
 * - Allows payer billing recovery, owner leads CSV export, and sign-out across `grace`, `locked`,
 *   and `suspended`.
 */

export interface LiveTenantEntitlement {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly agencyId: string | null;
  readonly version: number;
  readonly evaluation: EntitlementEvaluationResult;
}

interface LiveTenantEntitlementSqlRow {
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
  readonly version: number;
}

interface JoinedTenantEntitlementRow extends LiveTenantEntitlementSqlRow {
  readonly member_id: string;
  readonly member_role: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
}

/**
 * Loads the live tenant record directly from `PLATFORM_DB` and evaluates its server-owned
 * entitlement state at `nowMs`. Returns `null` if the tenant does not exist.
 */
export async function loadLiveTenantEntitlement(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
  options: { readonly nowMs?: number } = {},
): Promise<LiveTenantEntitlement | null> {
  const tenantId = selector.tenantId?.trim() || "";
  const handle = selector.handle?.trim().toLowerCase() || "";
  if (!tenantId && !handle) return null;

  let row: LiveTenantEntitlementSqlRow | null;
  if (tenantId) {
    row = await platformDb
      .prepare(
        `SELECT id, organization_id, agency_id, handle, name, status,
                operator_hold, operator_hold_reason, trial_ends_at,
                paid_through, deletion_due_at, retention_paused_at, version
         FROM tenants
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<LiveTenantEntitlementSqlRow>();
  } else {
    row = await platformDb
      .prepare(
        `SELECT id, organization_id, agency_id, handle, name, status,
                operator_hold, operator_hold_reason, trial_ends_at,
                paid_through, deletion_due_at, retention_paused_at, version
         FROM tenants
         WHERE handle = ?
         LIMIT 1`,
      )
      .bind(handle)
      .first<LiveTenantEntitlementSqlRow>();
  }

  if (!row) return null;

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const evaluation = evaluateEntitlementState({
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

  return {
    tenantId: row.id,
    organizationId: row.organization_id,
    handle: row.handle,
    tenantName: row.name,
    agencyId: row.agency_id,
    version: row.version,
    evaluation,
  };
}

/**
 * Resolves a tenant selector (either ULID `tenantId` or lowercase `handle`) from `/api/tenants/{selector}/...`
 * alongside the authenticated user's live membership and fresh server-side entitlement evaluation.
 */
export async function loadMemberTenantEntitlement(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly selector: string;
    readonly nowMs?: number;
  },
): Promise<{
  readonly entitlement: LiveTenantEntitlement;
  readonly memberId: string;
  readonly dbRole: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
  readonly role: Role;
} | null> {
  const userId = params.userId.trim();
  const rawSelector = params.selector.trim();
  if (!userId || !rawSelector) return null;

  const row = await platformDb
    .prepare(
      `SELECT t.id, t.organization_id, t.agency_id, t.handle, t.name, t.status,
              t.operator_hold, t.operator_hold_reason, t.trial_ends_at,
              t.paid_through, t.deletion_due_at, t.retention_paused_at, t.version,
              m.id AS member_id, m.role AS member_role
       FROM tenants t
       INNER JOIN members m
         ON m.organization_id = t.organization_id
        AND m.user_id = ?
       WHERE (t.id = ? OR t.handle = ?)
       LIMIT 1`,
    )
    .bind(userId, rawSelector, rawSelector.toLowerCase())
    .first<JoinedTenantEntitlementRow>();

  if (!row || row.status === "purged") return null;

  const nowMs = Math.trunc(optionsNow(params.nowMs));
  const evaluation = evaluateEntitlementState({
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

  const role: Role =
    row.member_role === "owner" || row.member_role === "admin" || row.member_role === "editor"
      ? row.member_role
      : row.member_role === "agency_staff"
        ? "agency_admin"
        : "editor";

  return {
    entitlement: {
      tenantId: row.id,
      organizationId: row.organization_id,
      handle: row.handle,
      tenantName: row.name,
      agencyId: row.agency_id,
      version: row.version,
      evaluation,
    },
    memberId: row.member_id,
    dbRole: row.member_role,
    role,
  };
}

function optionsNow(nowMs?: number): number {
  return typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
}

export type TenantApiOperationCategory =
  | "billing"
  | "leads_export"
  | "service_status"
  | "domain_connect"
  | "cms_read"
  | "cms_write";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Classifies a sub-path beneath `/api/tenants/{tenantIdOrHandle}` into its entitlement action category.
 */
export function classifyTenantApiOperation(
  method: string,
  subPath: string,
): { readonly category: TenantApiOperationCategory; readonly action: PermissionAction } {
  const upperMethod = method.toUpperCase();
  const isRead = READ_ONLY_METHODS.has(upperMethod);
  const normalized = subPath.startsWith("/") ? subPath.toLowerCase() : `/${subPath.toLowerCase()}`;

  if (normalized === "/billing" || normalized.startsWith("/billing/")) {
    return {
      category: "billing",
      action: isRead ? "billing:read" : "billing:pay",
    };
  }

  if (
    normalized === "/leads/export" ||
    normalized === "/leads/export.csv" ||
    normalized.startsWith("/leads/export/")
  ) {
    return {
      category: "leads_export",
      action: "lead:export_csv",
    };
  }

  if (normalized === "/service-status" || normalized.startsWith("/service-status/")) {
    return {
      category: "service_status",
      action: "billing:read",
    };
  }

  if (
    !isRead &&
    (normalized === "/domains" ||
      normalized === "/domains/" ||
      normalized.endsWith("/make-primary") ||
      normalized.endsWith("/primary"))
  ) {
    return {
      category: "domain_connect",
      action: normalized.includes("primary") ? "domain:make_primary" : "domain:connect",
    };
  }

  if (isRead) {
    return {
      category: "cms_read",
      action: "content:read",
    };
  }

  return {
    category: "cms_write",
    action: normalized.includes("/publish") ? "content:publish" : "content:write",
  };
}

export interface TenantApiEntitlementDecision {
  readonly allowed: boolean;
  readonly status: 200 | 403 | 404;
  readonly code?: ApiErrorCode;
  readonly message?: string;
  readonly category: TenantApiOperationCategory;
  readonly effectiveStatus: TenantStatus;
}

/**
 * Evaluates whether a tenant API request is permitted under the tenant's live timed entitlement state.
 * - `trial`: CMS read/write allowed; custom domain connect/primary promotion denied (`403 TRIAL_DOMAIN_FORBIDDEN`).
 * - `active` & `grace`: full CMS + billing + leads export allowed.
 * - `locked`: CMS reads, billing, leads CSV export, and service-status allowed; ALL CMS writes/publishes
 *   denied with `403 SUBSCRIPTION_LOCKED`.
 * - `suspended`: ONLY billing, leads CSV export, and service-status allowed; all CMS reads & writes
 *   denied with `403 SUBSCRIPTION_LOCKED`.
 */
export function evaluateTenantApiEntitlement(input: {
  readonly entitlement: LiveTenantEntitlement;
  readonly method: string;
  readonly subPath: string;
  readonly role?: Role;
}): TenantApiEntitlementDecision {
  const { evaluation } = input.entitlement;
  const effectiveStatus = evaluation.effectiveStatus;
  const { category, action } = classifyTenantApiOperation(input.method, input.subPath);

  if (effectiveStatus === "purged") {
    return {
      allowed: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Tenant tidak ditemukan.",
      category,
      effectiveStatus,
    };
  }

  // Service-status inspection is readable in any non-purged state so owners/members can view status.
  if (category === "service_status" && READ_ONLY_METHODS.has(input.method.toUpperCase())) {
    return {
      allowed: true,
      status: 200,
      category,
      effectiveStatus,
    };
  }

  const check = isActionAllowedForTenantStatus(effectiveStatus, action);
  if (!check.allowed) {
    const message =
      check.code === "TRIAL_DOMAIN_FORBIDDEN"
        ? "Domain kustom tidak dapat dihubungkan selama masa uji coba 7 hari."
        : effectiveStatus === "locked"
          ? "Langganan dalam mode terkunci (baca saja). Selesaikan perpanjangan untuk menyunting atau memublikasikan konten."
          : effectiveStatus === "suspended"
            ? "Situs ditangguhkan sementara. Hanya pembayaran perpanjangan dan ekspor prospek CSV yang tersedia."
            : "Operasi tidak tersedia pada status layanan saat ini.";

    return {
      allowed: false,
      status: check.status,
      code: check.code,
      message,
      category,
      effectiveStatus,
    };
  }

  // Additional payer-only check for billing & leads export when role is supplied
  if (input.role && (category === "billing" || category === "leads_export")) {
    const isPayerRole = evaluation.agencyManaged
      ? input.role === "agency_admin"
      : input.role === "owner" || input.role === "agency_admin";
    if (!isPayerRole) {
      return {
        allowed: false,
        status: 403,
        code: "FORBIDDEN",
        message: evaluation.agencyManaged
          ? "Hanya admin agensi yang dapat mengakses penagihan atau ekspor prospek situs ini."
          : "Hanya pemilik situs yang dapat mengakses penagihan atau ekspor prospek CSV.",
        category,
        effectiveStatus,
      };
    }
  }

  return {
    allowed: true,
    status: 200,
    category,
    effectiveStatus,
  };
}

/**
 * Throws `AuthorizationError` if the request is blocked by the tenant's live entitlement state.
 */
export function assertTenantApiEntitlement(input: {
  readonly entitlement: LiveTenantEntitlement;
  readonly method: string;
  readonly subPath: string;
  readonly role?: Role;
}): void {
  const decision = evaluateTenantApiEntitlement(input);
  if (!decision.allowed) {
    throw new AuthorizationError(
      decision.status === 404 ? 404 : 403,
      decision.code ?? "SUBSCRIPTION_LOCKED",
      decision.message ?? "Akses dibatasi oleh status langganan.",
    );
  }
}

export interface ServiceAccessViewModel {
  readonly status: "trial" | "active" | "grace" | "locked" | "suspended";
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly suspensionReason: EntitlementEvaluationResult["suspensionReason"];
  readonly agencyManaged: boolean;
  readonly isPayer: boolean;
  readonly canExportLeadsCsv: boolean;
  readonly daysRemaining: number | null;
  readonly trialEndsAtLabel: string | null;
  readonly paidThroughLabel: string | null;
  readonly graceEndsAtLabel: string | null;
  readonly lockedEndsAtLabel: string | null;
  readonly deletionDueAtLabel: string | null;
  readonly billingHref: string;
  readonly leadsExportHref: string;
  readonly signOutHref: string;
}

/**
 * Derives UI-ready Bahasa Indonesia service-access banner & recovery shell state
 * from an authoritative `LiveTenantEntitlement` and member role.
 */
export function buildServiceAccessViewModel(params: {
  readonly entitlement: LiveTenantEntitlement;
  readonly role: Role;
  readonly basePath?: string;
}): ServiceAccessViewModel {
  const { evaluation, handle } = params.entitlement;
  const basePath = params.basePath ?? `/dashboard/${handle}`;

  const uiStatus: ServiceAccessViewModel["status"] =
    evaluation.effectiveStatus === "trial" ||
    evaluation.effectiveStatus === "active" ||
    evaluation.effectiveStatus === "grace" ||
    evaluation.effectiveStatus === "locked"
      ? evaluation.effectiveStatus
      : "suspended";

  const isPayer = evaluation.agencyManaged
    ? params.role === "agency_admin"
    : params.role === "owner" || params.role === "agency_admin";

  return {
    status: uiStatus,
    operatorHold: evaluation.operatorHold,
    operatorHoldReason: evaluation.operatorHoldReason,
    suspensionReason: evaluation.suspensionReason,
    agencyManaged: evaluation.agencyManaged,
    isPayer,
    canExportLeadsCsv: isPayer && evaluation.adminAccess.canExportLeadsCsv,
    daysRemaining: evaluation.deadlines.daysRemaining,
    trialEndsAtLabel: formatWibDateTimeLabel(evaluation.deadlines.trialEndsAtMs),
    paidThroughLabel: formatWibDateTimeLabel(evaluation.deadlines.paidThroughMs),
    graceEndsAtLabel: formatWibDateTimeLabel(evaluation.deadlines.graceEndsAtMs),
    lockedEndsAtLabel: formatWibDateTimeLabel(evaluation.deadlines.lockedEndsAtMs),
    deletionDueAtLabel: formatWibDateTimeLabel(evaluation.deadlines.deletionDueAtMs),
    billingHref: `${basePath}/billing`,
    leadsExportHref: `/api/tenants/${params.entitlement.tenantId}/leads/export.csv`,
    signOutHref: "/auth/login?signOut=1",
  };
}
