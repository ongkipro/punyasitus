import type { TenantStatus } from "../schemas/common.ts";
import {
  DAY_MS,
  GRACE_WINDOW_MS,
  LOCKED_WINDOW_MS,
  PAID_DELETION_WINDOW_MS,
  PAID_STORAGE_QUOTA_BYTES,
  REMINDER_H0_WINDOW_MS,
  REMINDER_H_MINUS_1_MS,
  REMINDER_H_MINUS_3_MS,
  TRIAL_DELETION_WINDOW_MS,
  TRIAL_STORAGE_QUOTA_BYTES,
} from "./constants.ts";
import {
  computeLifecycleDeadlines,
  computeSubscriptionPeriodPreview,
  type BillingPlanInterval,
  type RenewalAnchorKind,
} from "./period.ts";

/**
 * Deterministic server-side timed entitlement state machine (PLAN §17.1, §17.2; REQ-060; DEC-035 C2/C5/C17).
 *
 * Pure and wall-clock injectable (`nowMs`) so every request gate, middleware guard, cron sweep,
 * and frozen-time test evaluates identical precedence with zero client-clock trust.
 */

export type SuspensionReason =
  | "operator_hold"
  | "trial_expired"
  | "subscription_overdue"
  | "stored_suspended";

export type AdminAccessMode =
  | "full"
  | "read_only_locked"
  | "payment_recovery_only"
  | "blocked";

export type RenewalReminderKind =
  | "paid_h_minus_3"
  | "paid_h_minus_1"
  | "paid_h0"
  | "trial_h_minus_3"
  | "trial_h_minus_1";

export interface EntitlementEvaluationInput {
  readonly storedStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly operatorHoldReason?: string | null;
  readonly trialEndsAtMs: number | null;
  readonly paidThroughMs: number | null;
  readonly deletionDueAtMs?: number | null;
  readonly retentionPausedAtMs?: number | null;
  readonly agencyId?: string | null;
  readonly nowMs: number;
}

export interface EntitlementPublicAccess {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 404 | 503;
  readonly noindex: boolean;
  readonly customDomainAllowed: boolean;
  readonly cacheable: boolean;
}

export interface EntitlementAdminAccess {
  readonly mode: AdminAccessMode;
  readonly canEditContent: boolean;
  readonly canPublish: boolean;
  readonly canReadCms: boolean;
  readonly canExportLeadsCsv: boolean;
  readonly canAccessBilling: boolean;
  readonly canSignOut: true;
  readonly storageQuotaBytes: number;
  readonly writeDenyCode: "SUBSCRIPTION_LOCKED" | null;
}

export interface EntitlementDeadlinesDetail {
  readonly trialEndsAtMs: number | null;
  readonly paidThroughMs: number | null;
  readonly graceEndsAtMs: number | null;
  readonly lockedEndsAtMs: number | null;
  readonly deletionDueAtMs: number | null;
  readonly trialEndsAtIso: string | null;
  readonly paidThroughIso: string | null;
  readonly graceEndsAtIso: string | null;
  readonly lockedEndsAtIso: string | null;
  readonly deletionDueAtIso: string | null;
  readonly daysRemaining: number | null;
  readonly nextTransitionAtMs: number | null;
}

export interface EntitlementEvaluationResult {
  readonly effectiveStatus: TenantStatus;
  readonly storedStatus: TenantStatus;
  readonly needsStoredSync: boolean;
  readonly evaluatedAtMs: number;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly suspensionReason: SuspensionReason | null;
  readonly agencyManaged: boolean;
  readonly publicAccess: EntitlementPublicAccess;
  readonly adminAccess: EntitlementAdminAccess;
  readonly deadlines: EntitlementDeadlinesDetail;
}

export interface SettlementEntitlementTransition {
  readonly nextStatus: "active" | "suspended";
  readonly operatorHoldPreserved: boolean;
  readonly renewalAnchor: RenewalAnchorKind;
  readonly periodStartAtMs: number;
  readonly periodEndAtMs: number;
  readonly nextPaidThroughMs: number;
  readonly nextDeletionDueAtMs: number;
}

function normalizeOptionalMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function ceilDaysRemaining(targetMs: number, nowMs: number): number {
  const diff = targetMs - nowMs;
  if (diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / DAY_MS));
}

/**
 * Evaluates authoritative server-side tenant entitlement state per PLAN §17.1 precedence:
 * 1. Terminal/provisioning (`provisioning`, `purging`, `purged`) never resurrect.
 * 2. Explicit operator/security hold (`operatorHold = true`) -> `suspended` (survives payment!).
 * 3. `TenantStore` migration failure (`storedStatus === "recovery"`) -> `recovery`.
 * 4. Stored `suspended` stays `suspended` until explicit verified settlement transitions `status` -> `active`.
 * 5. Active `trial` (`nowMs < trialEndsAtMs`) -> `trial`; at `nowMs >= trialEndsAtMs` -> `suspended` immediately.
 * 6. Paid (`paidThroughMs !== null`):
 *    - `nowMs < paidThroughMs` -> `active`
 *    - `paidThroughMs <= nowMs < paidThroughMs + 72h` -> `grace` (H+1..H+3)
 *    - `paidThroughMs + 72h <= nowMs < paidThroughMs + 168h` -> `locked` (H+4..H+7; public site STILL live & indexable)
 *    - `nowMs >= paidThroughMs + 168h` -> `suspended` (H+8+; public HTTP 503 maintenance)
 */
export function evaluateEntitlementState(
  input: EntitlementEvaluationInput,
): EntitlementEvaluationResult {
  const nowMs = Math.trunc(input.nowMs);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite epoch millisecond timestamp");
  }

  const storedStatus = input.storedStatus;
  const operatorHold = Boolean(input.operatorHold);
  const operatorHoldReason =
    typeof input.operatorHoldReason === "string" && input.operatorHoldReason.trim().length > 0
      ? input.operatorHoldReason.trim()
      : null;
  const trialEndsAtMs = normalizeOptionalMs(input.trialEndsAtMs);
  const paidThroughMs = normalizeOptionalMs(input.paidThroughMs);
  const explicitDeletionDueAtMs = normalizeOptionalMs(input.deletionDueAtMs);
  const agencyManaged = Boolean(input.agencyId && input.agencyId.trim().length > 0);

  let effectiveStatus: TenantStatus;
  let suspensionReason: SuspensionReason | null = null;

  if (
    storedStatus === "provisioning" ||
    storedStatus === "purging" ||
    storedStatus === "purged"
  ) {
    effectiveStatus = storedStatus;
  } else if (operatorHold) {
    effectiveStatus = "suspended";
    suspensionReason = "operator_hold";
  } else if (storedStatus === "recovery") {
    effectiveStatus = "recovery";
  } else if (storedStatus === "suspended") {
    effectiveStatus = "suspended";
    if (paidThroughMs !== null && nowMs >= paidThroughMs + LOCKED_WINDOW_MS) {
      suspensionReason = "subscription_overdue";
    } else if (paidThroughMs === null && trialEndsAtMs !== null && nowMs >= trialEndsAtMs) {
      suspensionReason = "trial_expired";
    } else {
      suspensionReason = "stored_suspended";
    }
  } else if (storedStatus === "trial" && paidThroughMs === null) {
    if (trialEndsAtMs !== null && nowMs >= trialEndsAtMs) {
      effectiveStatus = "suspended";
      suspensionReason = "trial_expired";
    } else {
      effectiveStatus = "trial";
    }
  } else if (paidThroughMs !== null) {
    if (nowMs < paidThroughMs) {
      effectiveStatus = "active";
    } else if (nowMs < paidThroughMs + GRACE_WINDOW_MS) {
      effectiveStatus = "grace";
    } else if (nowMs < paidThroughMs + LOCKED_WINDOW_MS) {
      effectiveStatus = "locked";
    } else {
      effectiveStatus = "suspended";
      suspensionReason = "subscription_overdue";
    }
  } else {
    effectiveStatus = storedStatus;
  }

  const graceEndsAtMs = paidThroughMs !== null ? paidThroughMs + GRACE_WINDOW_MS : null;
  const lockedEndsAtMs = paidThroughMs !== null ? paidThroughMs + LOCKED_WINDOW_MS : null;
  const derivedDeletionDueAtMs =
    explicitDeletionDueAtMs ??
    (paidThroughMs !== null
      ? paidThroughMs + PAID_DELETION_WINDOW_MS
      : trialEndsAtMs !== null
        ? trialEndsAtMs + TRIAL_DELETION_WINDOW_MS
        : null);

  const isoDeadlines = computeLifecycleDeadlines({
    paidThroughMs,
    trialEndsAtMs,
    deletionDueAtMs: derivedDeletionDueAtMs,
  });

  let daysRemaining: number | null = null;
  let nextTransitionAtMs: number | null = null;

  if (effectiveStatus === "trial" && trialEndsAtMs !== null) {
    daysRemaining = ceilDaysRemaining(trialEndsAtMs, nowMs);
    nextTransitionAtMs = trialEndsAtMs;
  } else if (effectiveStatus === "active" && paidThroughMs !== null) {
    daysRemaining = ceilDaysRemaining(paidThroughMs, nowMs);
    nextTransitionAtMs = paidThroughMs;
  } else if (effectiveStatus === "grace" && graceEndsAtMs !== null) {
    daysRemaining = ceilDaysRemaining(graceEndsAtMs, nowMs);
    nextTransitionAtMs = graceEndsAtMs;
  } else if (effectiveStatus === "locked" && lockedEndsAtMs !== null) {
    daysRemaining = ceilDaysRemaining(lockedEndsAtMs, nowMs);
    nextTransitionAtMs = lockedEndsAtMs;
  } else if (effectiveStatus === "suspended" && !operatorHold && derivedDeletionDueAtMs !== null) {
    daysRemaining = ceilDaysRemaining(derivedDeletionDueAtMs, nowMs);
    nextTransitionAtMs = derivedDeletionDueAtMs;
  }

  let publicAccess: EntitlementPublicAccess;
  switch (effectiveStatus) {
    case "trial":
      publicAccess = {
        allowed: true,
        httpStatus: 200,
        noindex: true,
        customDomainAllowed: false,
        cacheable: true,
      };
      break;
    case "active":
    case "grace":
    case "locked":
      publicAccess = {
        allowed: true,
        httpStatus: 200,
        noindex: false,
        customDomainAllowed: true,
        cacheable: true,
      };
      break;
    case "suspended":
    case "recovery":
      publicAccess = {
        allowed: false,
        httpStatus: 503,
        noindex: true,
        customDomainAllowed: false,
        cacheable: false,
      };
      break;
    case "provisioning":
    case "purging":
    case "purged":
    default:
      publicAccess = {
        allowed: false,
        httpStatus: 404,
        noindex: true,
        customDomainAllowed: false,
        cacheable: false,
      };
      break;
  }

  let adminAccess: EntitlementAdminAccess;
  switch (effectiveStatus) {
    case "trial":
      adminAccess = {
        mode: "full",
        canEditContent: true,
        canPublish: true,
        canReadCms: true,
        canExportLeadsCsv: true,
        canAccessBilling: true,
        canSignOut: true,
        storageQuotaBytes: TRIAL_STORAGE_QUOTA_BYTES,
        writeDenyCode: null,
      };
      break;
    case "active":
    case "grace":
      adminAccess = {
        mode: "full",
        canEditContent: true,
        canPublish: true,
        canReadCms: true,
        canExportLeadsCsv: true,
        canAccessBilling: true,
        canSignOut: true,
        storageQuotaBytes: PAID_STORAGE_QUOTA_BYTES,
        writeDenyCode: null,
      };
      break;
    case "locked":
      adminAccess = {
        mode: "read_only_locked",
        canEditContent: false,
        canPublish: false,
        canReadCms: true,
        canExportLeadsCsv: true,
        canAccessBilling: true,
        canSignOut: true,
        storageQuotaBytes: PAID_STORAGE_QUOTA_BYTES,
        writeDenyCode: "SUBSCRIPTION_LOCKED",
      };
      break;
    case "suspended":
      adminAccess = {
        mode: "payment_recovery_only",
        canEditContent: false,
        canPublish: false,
        canReadCms: false,
        canExportLeadsCsv: true,
        canAccessBilling: true,
        canSignOut: true,
        storageQuotaBytes: 0,
        writeDenyCode: "SUBSCRIPTION_LOCKED",
      };
      break;
    case "provisioning":
    case "recovery":
    case "purging":
    case "purged":
    default:
      adminAccess = {
        mode: "blocked",
        canEditContent: false,
        canPublish: false,
        canReadCms: false,
        canExportLeadsCsv: false,
        canAccessBilling: false,
        canSignOut: true,
        storageQuotaBytes: 0,
        writeDenyCode: "SUBSCRIPTION_LOCKED",
      };
      break;
  }

  const syncableStoredStates = new Set<TenantStatus>(["trial", "active", "grace", "locked"]);
  const needsStoredSync =
    effectiveStatus !== storedStatus && syncableStoredStates.has(storedStatus) && !operatorHold;

  return {
    effectiveStatus,
    storedStatus,
    needsStoredSync,
    evaluatedAtMs: nowMs,
    operatorHold,
    operatorHoldReason,
    suspensionReason,
    agencyManaged,
    publicAccess,
    adminAccess,
    deadlines: {
      trialEndsAtMs,
      paidThroughMs,
      graceEndsAtMs,
      lockedEndsAtMs,
      deletionDueAtMs: derivedDeletionDueAtMs,
      trialEndsAtIso: isoDeadlines.trialEndsAtIso,
      paidThroughIso: isoDeadlines.paidThroughIso,
      graceEndsAtIso: isoDeadlines.graceEndsAtIso,
      lockedEndsAtIso: isoDeadlines.lockedEndsAtIso,
      deletionDueAtIso: isoDeadlines.deletionDueAtIso,
      daysRemaining,
      nextTransitionAtMs,
    },
  };
}

/**
 * Computes the next authoritative tenant state after a verified payment settlement (PLAN §17.1).
 *
 * Hard invariants:
 * - Manual operator hold (`operatorHold === true`) SURVIVES payment (`nextStatus` stays `"suspended"`),
 *   while the purchased `paid_through` period is still recorded so entitlement is never lost.
 * - Uses PLAN §17.1/§17.2 renewal anchors (early/grace/locked extend from `paidThrough`; active trial
 *   preserves remaining trial hours + purchased calendar period; expired/suspended starts from `nowMs`).
 */
export function computeSettlementEntitlementTransition(input: {
  readonly plan: BillingPlanInterval;
  readonly storedStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly nowMs: number;
}): SettlementEntitlementTransition {
  const current = evaluateEntitlementState({
    storedStatus: input.storedStatus,
    operatorHold: false, // evaluate underlying commercial state for anchor selection
    paidThroughMs: input.paidThroughMs,
    trialEndsAtMs: input.trialEndsAtMs,
    nowMs: input.nowMs,
  });

  const preview = computeSubscriptionPeriodPreview({
    plan: input.plan,
    tenantStatus: current.effectiveStatus,
    paidThroughMs: input.paidThroughMs,
    trialEndsAtMs: input.trialEndsAtMs,
    nowMs: input.nowMs,
  });

  const existingPaid = normalizeOptionalMs(input.paidThroughMs) ?? 0;
  const nextPaidThroughMs = Math.max(existingPaid, preview.periodEndAtMs);

  return {
    nextStatus: input.operatorHold ? "suspended" : "active",
    operatorHoldPreserved: input.operatorHold,
    renewalAnchor: preview.renewalAnchor,
    periodStartAtMs: preview.periodStartAtMs,
    periodEndAtMs: preview.periodEndAtMs,
    nextPaidThroughMs,
    nextDeletionDueAtMs: nextPaidThroughMs + PAID_DELETION_WINDOW_MS,
  };
}

export interface DueRenewalReminder {
  readonly kind: RenewalReminderKind;
  readonly cycleAnchorMs: number;
  readonly dueAtMs: number;
  readonly linkExpiresAtMs: number;
}

/**
 * Evaluates which renewal reminder stage (if any) is due for a tenant at `nowMs` (DEC-035 C17, PLAN §17.3):
 * - Paid tenants (not under operator hold):
 *   - `paid_h_minus_3`: `[paidThrough - 72h, paidThrough - 24h)`
 *   - `paid_h_minus_1`: `[paidThrough - 24h, paidThrough)`
 *   - `paid_h0`:        `[paidThrough, paidThrough + 24h)`
 *   Each paid one-click renewal pay link expires at the exact end of the grace window (`paidThrough + 72h`).
 * - Trial tenants (never paid, not under operator hold):
 *   - `trial_h_minus_3`: `[trialEndsAt - 72h, trialEndsAt - 24h)`
 *   - `trial_h_minus_1`: `[trialEndsAt - 24h, trialEndsAt)`
 *   Each trial pay link expires at `trialEndsAt`.
 */
export function evaluateDueRenewalReminder(input: {
  readonly storedStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly trialEndsAtMs: number | null;
  readonly paidThroughMs: number | null;
  readonly nowMs: number;
}): DueRenewalReminder | null {
  if (input.operatorHold) return null;
  if (
    input.storedStatus === "provisioning" ||
    input.storedStatus === "recovery" ||
    input.storedStatus === "purging" ||
    input.storedStatus === "purged"
  ) {
    return null;
  }

  const nowMs = Math.trunc(input.nowMs);
  const paidThroughMs = normalizeOptionalMs(input.paidThroughMs);
  const trialEndsAtMs = normalizeOptionalMs(input.trialEndsAtMs);

  if (paidThroughMs !== null && input.storedStatus !== "suspended") {
    const graceEndsAtMs = paidThroughMs + GRACE_WINDOW_MS;
    if (nowMs >= paidThroughMs - REMINDER_H_MINUS_3_MS && nowMs < paidThroughMs - REMINDER_H_MINUS_1_MS) {
      return {
        kind: "paid_h_minus_3",
        cycleAnchorMs: paidThroughMs,
        dueAtMs: paidThroughMs,
        linkExpiresAtMs: graceEndsAtMs,
      };
    }
    if (nowMs >= paidThroughMs - REMINDER_H_MINUS_1_MS && nowMs < paidThroughMs) {
      return {
        kind: "paid_h_minus_1",
        cycleAnchorMs: paidThroughMs,
        dueAtMs: paidThroughMs,
        linkExpiresAtMs: graceEndsAtMs,
      };
    }
    if (nowMs >= paidThroughMs && nowMs < paidThroughMs + REMINDER_H0_WINDOW_MS) {
      return {
        kind: "paid_h0",
        cycleAnchorMs: paidThroughMs,
        dueAtMs: paidThroughMs,
        linkExpiresAtMs: graceEndsAtMs,
      };
    }
    return null;
  }

  if (input.storedStatus === "trial" && trialEndsAtMs !== null) {
    if (nowMs >= trialEndsAtMs - REMINDER_H_MINUS_3_MS && nowMs < trialEndsAtMs - REMINDER_H_MINUS_1_MS) {
      return {
        kind: "trial_h_minus_3",
        cycleAnchorMs: trialEndsAtMs,
        dueAtMs: trialEndsAtMs,
        linkExpiresAtMs: trialEndsAtMs,
      };
    }
    if (nowMs >= trialEndsAtMs - REMINDER_H_MINUS_1_MS && nowMs < trialEndsAtMs) {
      return {
        kind: "trial_h_minus_1",
        cycleAnchorMs: trialEndsAtMs,
        dueAtMs: trialEndsAtMs,
        linkExpiresAtMs: trialEndsAtMs,
      };
    }
  }

  return null;
}

/**
 * Formats an epoch millisecond timestamp in Indonesian WIB (`Asia/Jakarta`) for banners and emails.
 */
export function formatWibDateTimeLabel(epochMs: number | null | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return null;
  try {
    const formatted = new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta",
    }).format(new Date(Math.trunc(epochMs)));
    return `${formatted} WIB`;
  } catch {
    return new Date(Math.trunc(epochMs)).toISOString();
  }
}
