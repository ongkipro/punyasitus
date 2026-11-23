import type { TenantStatus } from "../schemas/common.ts";
import {
  GRACE_WINDOW_MS,
  LOCKED_WINDOW_MS,
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
} from "./constants.ts";

/**
 * UTC calendar-month arithmetic with month-end clamping and renewal anchor rules (PLAN §17.1, DEC-035 C2).
 */

export type BillingPlanInterval = "monthly" | "yearly";

export type RenewalAnchorKind =
  | "current_period_end"
  | "trial_end_preserved"
  | "settlement_time";

export interface SubscriptionPeriodPreview {
  readonly plan: BillingPlanInterval;
  readonly months: 1 | 12;
  readonly renewalAnchor: RenewalAnchorKind;
  readonly periodStartAtMs: number;
  readonly periodEndAtMs: number;
  readonly periodStartAtIso: string;
  readonly periodEndAtIso: string;
}

export interface LifecycleDeadlines {
  readonly trialEndsAtIso: string | null;
  readonly paidThroughIso: string | null;
  readonly graceEndsAtIso: string | null;
  readonly lockedEndsAtIso: string | null;
  readonly deletionDueAtIso: string | null;
}

/**
 * Adds exact calendar months in UTC, clamping the day-of-month to the last valid day of the target month.
 * Examples:
 * - 2026-01-31T10:00:00Z + 1 month  -> 2026-02-28T10:00:00Z
 * - 2028-01-31T10:00:00Z + 1 month  -> 2028-02-29T10:00:00Z (leap year)
 * - 2026-01-31T10:00:00Z + 12 months -> 2027-01-31T10:00:00Z
 * - 2028-02-29T10:00:00Z + 12 months -> 2029-02-28T10:00:00Z (leap year clamp)
 */
export function addCalendarMonthsUtc(anchorMs: number, months: number): number {
  if (!Number.isFinite(anchorMs)) {
    throw new RangeError("anchorMs must be a finite epoch millisecond timestamp");
  }
  if (!Number.isSafeInteger(months) || months < 1 || months > 120) {
    throw new RangeError("months must be a safe integer between 1 and 120");
  }

  const d = new Date(Math.trunc(anchorMs));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();

  const totalMonths = year * 12 + month + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12;

  // Day 0 of (targetMonth + 1) yields the exact number of days in targetMonth (handles leap years).
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  return Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms);
}

export function getPlanMonths(plan: BillingPlanInterval): 1 | 12 {
  return plan === "yearly" ? 12 : 1;
}

/**
 * Computes the server-owned subscription entitlement period preview according to PLAN §17.1:
 * - `active` / `grace` / `locked` (continuous service with `paidThrough` inside the pre-suspension window):
 *   renews from `paidThrough` (`current_period_end`).
 * - `trial` (active trial with `nowMs < trialEndsAtMs`):
 *   preserves remaining trial hours and appends the purchased calendar period (`trial_end_preserved`).
 * - `suspended` / expired trial / no prior period:
 *   starts fresh from settlement/evaluation time (`settlement_time`).
 */
export function computeSubscriptionPeriodPreview(input: {
  readonly plan: BillingPlanInterval;
  readonly tenantStatus: TenantStatus;
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly nowMs: number;
}): SubscriptionPeriodPreview {
  const nowMs = Math.trunc(input.nowMs);
  const months = getPlanMonths(input.plan);

  const hasContinuousPaidAnchor =
    input.paidThroughMs !== null &&
    (input.tenantStatus === "active" ||
      input.tenantStatus === "grace" ||
      input.tenantStatus === "locked") &&
    nowMs < input.paidThroughMs + LOCKED_WINDOW_MS;

  if (hasContinuousPaidAnchor && input.paidThroughMs !== null) {
    const startMs = Math.trunc(input.paidThroughMs);
    const endMs = addCalendarMonthsUtc(startMs, months);
    return {
      plan: input.plan,
      months,
      renewalAnchor: "current_period_end",
      periodStartAtMs: startMs,
      periodEndAtMs: endMs,
      periodStartAtIso: new Date(startMs).toISOString(),
      periodEndAtIso: new Date(endMs).toISOString(),
    };
  }

  if (
    input.tenantStatus === "trial" &&
    input.trialEndsAtMs !== null &&
    nowMs < input.trialEndsAtMs
  ) {
    const trialEndMs = Math.trunc(input.trialEndsAtMs);
    const endMs = addCalendarMonthsUtc(trialEndMs, months);
    return {
      plan: input.plan,
      months,
      renewalAnchor: "trial_end_preserved",
      periodStartAtMs: nowMs,
      periodEndAtMs: endMs,
      periodStartAtIso: new Date(nowMs).toISOString(),
      periodEndAtIso: new Date(endMs).toISOString(),
    };
  }

  const endMs = addCalendarMonthsUtc(nowMs, months);
  return {
    plan: input.plan,
    months,
    renewalAnchor: "settlement_time",
    periodStartAtMs: nowMs,
    periodEndAtMs: endMs,
    periodStartAtIso: new Date(nowMs).toISOString(),
    periodEndAtIso: new Date(endMs).toISOString(),
  };
}

export function computeLifecycleDeadlines(input: {
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly deletionDueAtMs: number | null;
  readonly createdAtMs?: number | null;
}): LifecycleDeadlines {
  const paidThroughMs = input.paidThroughMs !== null ? Math.trunc(input.paidThroughMs) : null;
  const trialEndsAtMs = input.trialEndsAtMs !== null ? Math.trunc(input.trialEndsAtMs) : null;
  const createdAtMs =
    typeof input.createdAtMs === "number" && Number.isFinite(input.createdAtMs)
      ? Math.trunc(input.createdAtMs)
      : null;

  const graceEndsAtMs = paidThroughMs !== null ? paidThroughMs + GRACE_WINDOW_MS : null;
  const lockedEndsAtMs = paidThroughMs !== null ? paidThroughMs + LOCKED_WINDOW_MS : null;

  let derivedDeletionMs = input.deletionDueAtMs !== null ? Math.trunc(input.deletionDueAtMs) : null;
  if (derivedDeletionMs === null) {
    if (paidThroughMs !== null) {
      derivedDeletionMs = paidThroughMs + PAID_DELETION_WINDOW_MS;
    } else if (trialEndsAtMs !== null) {
      derivedDeletionMs = trialEndsAtMs + TRIAL_DELETION_WINDOW_MS;
    } else if (createdAtMs !== null) {
      derivedDeletionMs = createdAtMs + UNPAID_NO_TRIAL_DELETION_WINDOW_MS;
    }
  }

  return {
    trialEndsAtIso: trialEndsAtMs !== null ? new Date(trialEndsAtMs).toISOString() : null,
    paidThroughIso: paidThroughMs !== null ? new Date(paidThroughMs).toISOString() : null,
    graceEndsAtIso: graceEndsAtMs !== null ? new Date(graceEndsAtMs).toISOString() : null,
    lockedEndsAtIso: lockedEndsAtMs !== null ? new Date(lockedEndsAtMs).toISOString() : null,
    deletionDueAtIso: derivedDeletionMs !== null ? new Date(derivedDeletionMs).toISOString() : null,
  };
}
