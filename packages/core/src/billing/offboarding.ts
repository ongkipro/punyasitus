import type { TenantStatus } from "../schemas/common.ts";
import {
  DAY_MS,
  DELETION_WARNING_OFFSETS_MS,
  HOLD_RELEASE_MIN_REMAINING_MS,
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
} from "./constants.ts";

/**
 * Deterministic locked-tenant retention clock, operator-hold pause/resume arithmetic,
 * deletion warning cadence, and offboarding claim eligibility (REQ-069, PLAN §17.3, DEC-022).
 *
 * Pure and wall-clock injectable (`nowMs`) so frozen-time unit & integration tests prove exact
 * boundaries regardless of scheduler delay.
 */

export type OffboardingRetentionTrack =
  | "previously_paid"
  | "never_paid_trial"
  | "no_trial_unpaid"
  | "none";

export type DeletionWarningStage =
  | "unpaid_minus_7d"
  | "unpaid_minus_3d"
  | "unpaid_minus_1d"
  | "paid_h38"
  | "paid_h42"
  | "paid_h44";

export interface DeletionWarningMilestone {
  readonly stage: DeletionWarningStage;
  readonly daysBeforeDeletion: 7 | 3 | 1;
  readonly triggerAtMs: number;
  readonly deletionDueAtMs: number;
}

export interface DeletionClockInput {
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly createdAtMs?: number | null;
  readonly explicitDeletionDueAtMs?: number | null;
}

export interface AuthoritativeDeletionClock {
  readonly track: OffboardingRetentionTrack;
  readonly deletionDueAtMs: number | null;
  readonly baseDeletionDueAtMs: number | null;
}

function normalizeMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Computes the authoritative `deletion_due_at` timestamp regardless of scheduler delay:
 * - Previously paid website (`paidThroughMs !== null`): `paid_through + 45 days` (`H+45`).
 * - Never-paid trial (`paidThroughMs === null && trialEndsAtMs !== null`): `trial_ends_at + 30 days`.
 * - No-trial unpaid website (`paidThroughMs === null && trialEndsAtMs === null && createdAtMs !== null`):
 *   `provisioning_created_at + 30 days`.
 *
 * When an explicit `deletion_due_at` is persisted (for example shifted forward when an operator
 * hold is released), `explicitDeletionDueAtMs` is authoritative.
 */
export function computeAuthoritativeDeletionDueAt(
  input: DeletionClockInput,
): AuthoritativeDeletionClock {
  const paidThroughMs = normalizeMs(input.paidThroughMs);
  const trialEndsAtMs = normalizeMs(input.trialEndsAtMs);
  const createdAtMs = normalizeMs(input.createdAtMs);
  const explicitMs = normalizeMs(input.explicitDeletionDueAtMs);

  let track: OffboardingRetentionTrack = "none";
  let baseDeletionDueAtMs: number | null = null;

  if (paidThroughMs !== null) {
    track = "previously_paid";
    baseDeletionDueAtMs = paidThroughMs + PAID_DELETION_WINDOW_MS;
  } else if (trialEndsAtMs !== null) {
    track = "never_paid_trial";
    baseDeletionDueAtMs = trialEndsAtMs + TRIAL_DELETION_WINDOW_MS;
  } else if (createdAtMs !== null) {
    track = "no_trial_unpaid";
    baseDeletionDueAtMs = createdAtMs + UNPAID_NO_TRIAL_DELETION_WINDOW_MS;
  }

  return {
    track,
    deletionDueAtMs: explicitMs ?? baseDeletionDueAtMs,
    baseDeletionDueAtMs,
  };
}

/**
 * Computes the resumed `deletion_due_at` when an operator hold is lifted (PLAN §17.3, REQ-069):
 * - Shifts the previously scheduled `deletion_due_at` forward by the elapsed hold pause duration
 *   (`nowMs - retentionPausedAtMs`), AND
 * - Enforces a minimum floor of **at least 14 days remaining** (`nowMs + 14 days`) for any unpaid
 *   or overdue site so releasing a hold can never trigger immediate deletion.
 */
export function computeHoldResumeDeletionDueAt(input: {
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly createdAtMs?: number | null;
  readonly explicitDeletionDueAtMs: number | null;
  readonly retentionPausedAtMs: number | null;
  readonly nowMs: number;
}): number {
  const nowMs = Math.trunc(input.nowMs);
  const clock = computeAuthoritativeDeletionDueAt({
    paidThroughMs: input.paidThroughMs,
    trialEndsAtMs: input.trialEndsAtMs,
    createdAtMs: input.createdAtMs,
    explicitDeletionDueAtMs: input.explicitDeletionDueAtMs,
  });

  const paidThroughMs = normalizeMs(input.paidThroughMs);
  // If the tenant was paid during the hold and is currently active (`paid_through > nowMs`),
  // its canonical H+45 deadline is already > 45 days in the future.
  if (paidThroughMs !== null && paidThroughMs > nowMs) {
    return paidThroughMs + PAID_DELETION_WINDOW_MS;
  }

  const pausedAtMs = normalizeMs(input.retentionPausedAtMs);
  const pausedDurationMs = pausedAtMs !== null ? Math.max(0, nowMs - pausedAtMs) : 0;
  const shiftedDueAtMs =
    clock.deletionDueAtMs !== null ? clock.deletionDueAtMs + pausedDurationMs : nowMs + HOLD_RELEASE_MIN_REMAINING_MS;

  const minFloorMs = nowMs + HOLD_RELEASE_MIN_REMAINING_MS;
  return Math.max(shiftedDueAtMs, minFloorMs);
}

/**
 * Lists the ordered 3-step deletion warning milestones for a given retention track and deadline:
 * - Previously paid (`H+45`): `H+38` (-7d), `H+42` (-3d), `H+44` (-1d)
 * - Never-paid trial (`trial_ends_at + 30d`) / No-trial unpaid (`created_at + 30d`): `-7d`, `-3d`, `-1d`
 */
export function buildDeletionWarningMilestones(
  track: Exclude<OffboardingRetentionTrack, "none">,
  deletionDueAtMs: number,
): readonly DeletionWarningMilestone[] {
  const due = Math.trunc(deletionDueAtMs);
  if (track === "previously_paid") {
    return [
      {
        stage: "paid_h38",
        daysBeforeDeletion: 7,
        triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus7d,
        deletionDueAtMs: due,
      },
      {
        stage: "paid_h42",
        daysBeforeDeletion: 3,
        triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus3d,
        deletionDueAtMs: due,
      },
      {
        stage: "paid_h44",
        daysBeforeDeletion: 1,
        triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus1d,
        deletionDueAtMs: due,
      },
    ];
  }

  return [
    {
      stage: "unpaid_minus_7d",
      daysBeforeDeletion: 7,
      triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus7d,
      deletionDueAtMs: due,
    },
    {
      stage: "unpaid_minus_3d",
      daysBeforeDeletion: 3,
      triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus3d,
      deletionDueAtMs: due,
    },
    {
      stage: "unpaid_minus_1d",
      daysBeforeDeletion: 1,
      triggerAtMs: due - DELETION_WARNING_OFFSETS_MS.minus1d,
      deletionDueAtMs: due,
    },
  ];
}

export interface DeletionWarningEvaluationInput {
  readonly storedStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly retentionPausedAtMs?: number | null;
  readonly offboardingStartedAtMs?: number | null;
  readonly paidThroughMs: number | null;
  readonly trialEndsAtMs: number | null;
  readonly createdAtMs?: number | null;
  readonly explicitDeletionDueAtMs?: number | null;
  readonly nowMs: number;
}

export interface DeletionWarningEvaluationResult {
  readonly track: OffboardingRetentionTrack;
  readonly deletionDueAtMs: number | null;
  /** The single latest due warning stage at `nowMs` (prevents catch-up spam bursts on delayed jobs). */
  readonly latestDueWarning: DeletionWarningMilestone | null;
  /** Any earlier missed warning stages that MUST be suppressed rather than sent retroactively. */
  readonly earlierMissedWarnings: readonly DeletionWarningMilestone[];
  readonly isPastDeadline: boolean;
  readonly skipReason:
    | null
    | "terminal_state"
    | "operator_hold"
    | "active_paid"
    | "active_trial"
    | "no_deadline"
    | "before_first_warning"
    | "past_deadline";
}

const NON_WARNING_TERMINAL_STATES: ReadonlySet<TenantStatus> = new Set<TenantStatus>([
  "provisioning",
  "recovery",
  "purging",
  "purged",
]);

/**
 * Evaluates which deletion warning (if any) should be sent at `nowMs` (REQ-069, PLAN §17.3):
 * - Skips active paid tenants (`paidThroughMs > nowMs`), active trial tenants (`trialEndsAtMs > nowMs`),
 *   operator-held / clock-paused tenants, and terminal states (`provisioning`, `recovery`, `purging`, `purged`).
 * - At `nowMs >= deletionDueAtMs`, returns `isPastDeadline: true` and `latestDueWarning: null`
 *   so the sweep proceeds directly to offboarding claim instead of sending a late warning.
 * - When a delayed job wakes up after missing multiple milestones (e.g. `H+38` and `H+42` missed,
 *   waking at `H+44`), returns ONLY `latestDueWarning = H+44` and lists `H+38`, `H+42` in
 *   `earlierMissedWarnings` so the caller suppresses them and sends **only the latest missed reminder**.
 */
export function evaluateDeletionWarningSchedule(
  input: DeletionWarningEvaluationInput,
): DeletionWarningEvaluationResult {
  const nowMs = Math.trunc(input.nowMs);
  const paidThroughMs = normalizeMs(input.paidThroughMs);
  const trialEndsAtMs = normalizeMs(input.trialEndsAtMs);
  const pausedAtMs = normalizeMs(input.retentionPausedAtMs);
  const offboardingStartedAtMs = normalizeMs(input.offboardingStartedAtMs);

  const clock = computeAuthoritativeDeletionDueAt({
    paidThroughMs,
    trialEndsAtMs,
    createdAtMs: input.createdAtMs,
    explicitDeletionDueAtMs: input.explicitDeletionDueAtMs,
  });

  if (NON_WARNING_TERMINAL_STATES.has(input.storedStatus) || offboardingStartedAtMs !== null) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "terminal_state",
    };
  }

  if (input.operatorHold || pausedAtMs !== null) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "operator_hold",
    };
  }

  if (paidThroughMs !== null && nowMs < paidThroughMs) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "active_paid",
    };
  }

  if (paidThroughMs === null && trialEndsAtMs !== null && nowMs < trialEndsAtMs) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "active_trial",
    };
  }

  if (clock.track === "none" || clock.deletionDueAtMs === null) {
    return {
      track: "none",
      deletionDueAtMs: null,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "no_deadline",
    };
  }

  if (nowMs >= clock.deletionDueAtMs) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: true,
      skipReason: "past_deadline",
    };
  }

  const milestones = buildDeletionWarningMilestones(clock.track, clock.deletionDueAtMs);
  const dueMilestones = milestones.filter((m) => nowMs >= m.triggerAtMs);

  if (dueMilestones.length === 0) {
    return {
      track: clock.track,
      deletionDueAtMs: clock.deletionDueAtMs,
      latestDueWarning: null,
      earlierMissedWarnings: [],
      isPastDeadline: false,
      skipReason: "before_first_warning",
    };
  }

  const latestDueWarning = dueMilestones[dueMilestones.length - 1]!;
  const earlierMissedWarnings = dueMilestones.slice(0, -1);

  return {
    track: clock.track,
    deletionDueAtMs: clock.deletionDueAtMs,
    latestDueWarning,
    earlierMissedWarnings,
    isPastDeadline: false,
    skipReason: null,
  };
}

export interface OffboardingClaimEligibilityResult {
  readonly eligible: boolean;
  readonly deletionDueAtMs: number | null;
  readonly track: OffboardingRetentionTrack;
  readonly blockReason:
    | null
    | "terminal_state"
    | "already_claiming"
    | "operator_hold"
    | "active_paid"
    | "active_trial"
    | "no_deadline"
    | "before_deletion_due_at"
    | "unresolved_payment_attempt";
}

/**
 * Pure deterministic eligibility check for claiming a tenant for offboarding purge (REQ-069):
 * - Strictly requires `nowMs >= deletionDueAtMs` (1ms/1s before -> `eligible: false`).
 * - Blocks on operator hold (`operatorHold` or `retentionPausedAtMs !== null`), active paid/trial,
 *   any unresolved/review payment attempt, or non-commercial terminal states.
 */
export function evaluateOffboardingClaimEligibility(
  input: DeletionWarningEvaluationInput & { readonly hasUnresolvedPaymentAttempt?: boolean },
): OffboardingClaimEligibilityResult {
  const nowMs = Math.trunc(input.nowMs);
  const paidThroughMs = normalizeMs(input.paidThroughMs);
  const trialEndsAtMs = normalizeMs(input.trialEndsAtMs);
  const pausedAtMs = normalizeMs(input.retentionPausedAtMs);
  const offboardingStartedAtMs = normalizeMs(input.offboardingStartedAtMs);

  const clock = computeAuthoritativeDeletionDueAt({
    paidThroughMs,
    trialEndsAtMs,
    createdAtMs: input.createdAtMs,
    explicitDeletionDueAtMs: input.explicitDeletionDueAtMs,
  });

  if (input.storedStatus === "purging" || offboardingStartedAtMs !== null) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "already_claiming",
    };
  }

  if (NON_WARNING_TERMINAL_STATES.has(input.storedStatus)) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "terminal_state",
    };
  }

  if (input.operatorHold || pausedAtMs !== null) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "operator_hold",
    };
  }

  if (paidThroughMs !== null && nowMs < paidThroughMs) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "active_paid",
    };
  }

  if (paidThroughMs === null && trialEndsAtMs !== null && nowMs < trialEndsAtMs) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "active_trial",
    };
  }

  if (clock.deletionDueAtMs === null) {
    return {
      eligible: false,
      deletionDueAtMs: null,
      track: clock.track,
      blockReason: "no_deadline",
    };
  }

  if (nowMs < clock.deletionDueAtMs) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "before_deletion_due_at",
    };
  }

  if (input.hasUnresolvedPaymentAttempt) {
    return {
      eligible: false,
      deletionDueAtMs: clock.deletionDueAtMs,
      track: clock.track,
      blockReason: "unresolved_payment_attempt",
    };
  }

  return {
    eligible: true,
    deletionDueAtMs: clock.deletionDueAtMs,
    track: clock.track,
    blockReason: null,
  };
}

export function computeDaysUntilDeletion(deletionDueAtMs: number, nowMs: number): number {
  const diff = Math.trunc(deletionDueAtMs) - Math.trunc(nowMs);
  if (diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / DAY_MS));
}
