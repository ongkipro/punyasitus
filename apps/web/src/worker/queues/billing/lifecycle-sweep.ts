import {
  DEFAULT_MONTHLY_PRICE_IDR,
  evaluateDueRenewalReminder,
  formatWibDateTimeLabel,
  type RenewalReminderKind,
} from "@punyasitus/core/billing/index";
import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  ensureRenewalPayLinksSchema,
  issueRenewalPayLink,
  listTenantsForLifecycleSweep,
  loadPlatformBillingPricing,
  releaseFailedRenewalPayLink,
  syncTenantStoredLifecycleState,
} from "@punyasitus/db/billing/index";
import {
  claimEmailDelivery,
  getEmailSuppression,
  isRetryableDefiniteRefusalCode,
  recordEmailOutcome,
} from "@punyasitus/db/email/index";
import {
  BILLING_ADVICE_RECONCILE_TOPIC,
  createBillingAdviceReconciliationHandler,
  type RunBillingAdviceSweepOptions,
} from "./advice-reconciliation.ts";
import type { DurableJobHandler, DurableQueueEnv, JobExecutionContext } from "../consumer.ts";
import { BILLING_LIFECYCLE_SWEEP_TOPIC } from "../dispatch/billing.ts";

/**
 * Timed Entitlement Lifecycle & H-3 / H-1 / H0 Renewal Reminder Sweep (REQ-060, DEC-035 C17, TASK-059).
 *
 * Hard invariants:
 * 1. Stored tenant lifecycle synchronization (`trial` -> `suspended`, `active` -> `grace` ->
 *    `locked` -> `suspended`) uses atomic optimistic CAS (`syncTenantStoredLifecycleState`) and
 *    runs FIRST, completely independent of email delivery.
 * 2. Email outages, timeouts, rejections, or suppressions NEVER block, roll back, or alter
 *    entitlement state transitions or tenant access!
 * 3. H-3, H-1, and H0 reminders carry single-use, SHA-256 hashed, grace-expiring one-click
 *    renewal pay links (`billing_renewal_pay_links`) deduplicated per `(tenantId, stage, cycleAnchorMs)`.
 * 4. One-shot email claims (`email_delivery_claims`) prevent duplicate reminder sends even if
 *    the sweep runs repeatedly inside the same window.
 */

export interface LifecycleSweepEmailAttempt {
  readonly tenantId: string;
  readonly kind: RenewalReminderKind | "lifecycle_notice";
  readonly messageKey: string;
  readonly outcome: "submitted" | "duplicate" | "skipped" | "failed" | "unknown";
  readonly errorCode: string | null;
  readonly payLinkId?: string;
  readonly payUrl?: string;
}

export interface LifecycleSweepResult {
  readonly evaluatedAtMs: number;
  readonly scannedTenants: number;
  readonly transitionedCount: number;
  readonly casConflictCount: number;
  readonly remindersIssued: number;
  readonly remindersDeduplicated: number;
  readonly emailFailuresIsolated: number;
  readonly emailAttempts: readonly LifecycleSweepEmailAttempt[];
}

export interface RunBillingLifecycleSweepOptions {
  readonly nowMs?: number;
  readonly emailPort?: EmailPort | null;
  readonly appOrigin?: string;
  readonly limit?: number;
  readonly suppressionSalt?: string;
}

async function sendIsolatedOneShotEmail(params: {
  readonly db: D1Database;
  readonly emailPort: EmailPort | null | undefined;
  readonly tenantId: string;
  readonly messageKey: string;
  readonly template: "renewal-reminder" | "lifecycle-notice";
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly nowMs: number;
  readonly suppressionSalt?: string;
}): Promise<{
  readonly outcome: "submitted" | "duplicate" | "skipped" | "failed" | "unknown";
  readonly errorCode: string | null;
}> {
  // Check suppression safely (if email_suppressions table exists)
  try {
    const suppressed = await getEmailSuppression(params.db, params.to, {
      salt: params.suppressionSalt,
    });
    if (suppressed) {
      try {
        await recordEmailOutcome(params.db, {
          messageKey: params.messageKey,
          template: params.template,
          oneShot: true,
          status: "skipped",
          provider: null,
          errorCode: "E_RECIPIENT_SUPPRESSED",
          nowMs: params.nowMs,
        });
      } catch {
        // Never allow email bookkeeping error to disrupt lifecycle sweep
      }
      return { outcome: "skipped", errorCode: "E_RECIPIENT_SUPPRESSED" };
    }
  } catch {
    // Ignore suppression lookup errors if optional table is absent
  }

  if (!params.emailPort) {
    return { outcome: "skipped", errorCode: "NO_EMAIL_TRANSPORT" };
  }

  // One-shot delivery claim (if email_delivery_claims migration is applied):
  // allows retry ONLY after a definite refusal/failure (`status = 'failed'`), NEVER after
  // `submitted` or ambiguous `unknown` outcomes (PLAN §17.4).
  let claimRecorded = false;
  try {
    const claim = await claimEmailDelivery(params.db, {
      messageKey: params.messageKey,
      template: params.template,
      oneShot: true,
      allowRetryOnDefiniteFailure: true,
      nowMs: params.nowMs,
    });
    claimRecorded = true;
    if (claim.outcome === "duplicate") {
      return { outcome: "duplicate", errorCode: null };
    }
  } catch {
    // Proceed cleanly even in minimal test DBs without 0002_email_delivery_claims
  }

  try {
    const sendRes = await params.emailPort.send({
      messageKey: params.messageKey,
      template: params.template,
      from: ALLOWED_EMAIL_SENDER,
      fromName: DEFAULT_EMAIL_SENDER_NAME,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      oneShot: true,
      tenantId: params.tenantId,
    });

    if (claimRecorded) {
      try {
        await recordEmailOutcome(params.db, {
          messageKey: params.messageKey,
          status: sendRes.outcome,
          provider: sendRes.provider,
          errorCode: sendRes.outcome === "submitted" ? null : sendRes.errorCode,
          nowMs: params.nowMs,
        });
      } catch {
        // Isolation: bookkeeping error never impacts access
      }
    }

    return {
      outcome: sendRes.outcome,
      errorCode: sendRes.outcome === "submitted" ? null : sendRes.errorCode,
    };
  } catch (err) {
    const errorCode = sanitizeErrorCode(err);
    if (claimRecorded) {
      try {
        await recordEmailOutcome(params.db, {
          messageKey: params.messageKey,
          status: "failed",
          provider: params.emailPort.provider,
          errorCode,
          nowMs: params.nowMs,
        });
      } catch {
        // Isolation: bookkeeping error never impacts access
      }
    }
    return { outcome: "failed", errorCode };
  }
}

/**
 * Executes the server-side timed entitlement synchronization & H-3/H-1/H0 renewal reminder sweep.
 */
export async function runBillingLifecycleAndReminderSweep(
  env: Pick<DurableQueueEnv, "PLATFORM_DB">,
  options: RunBillingLifecycleSweepOptions = {},
): Promise<LifecycleSweepResult> {
  const db = env.PLATFORM_DB;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const appOrigin = (options.appOrigin ?? "https://app.punyasitus.com").replace(/\/+$/, "");

  await ensureRenewalPayLinksSchema(db);

  let monthlyPriceIdr: number = DEFAULT_MONTHLY_PRICE_IDR;
  try {
    const pricing = await loadPlatformBillingPricing(db);
    monthlyPriceIdr = pricing.monthlyPriceIdr;
  } catch {
    // Fall back to canonical default monthly price when platform_settings is unavailable.
  }

  const candidates = await listTenantsForLifecycleSweep(db, { limit: options.limit });

  let transitionedCount = 0;
  let casConflictCount = 0;
  let remindersIssued = 0;
  let remindersDeduplicated = 0;
  let emailFailuresIsolated = 0;
  const emailAttempts: LifecycleSweepEmailAttempt[] = [];

  for (const tenant of candidates) {
    // 1. Atomic stored-status sync FIRST — completely decoupled from email delivery!
    const syncRes = await syncTenantStoredLifecycleState(db, {
      tenantId: tenant.id,
      nowMs,
    });

    if (syncRes.transitioned) {
      transitionedCount += 1;
    } else if (syncRes.conflictDetected) {
      casConflictCount += 1;
    }

    const effectiveEval = syncRes.evaluation;
    const payerEmail = tenant.payer_email?.trim() || null;

    // 2. Emit deduplicated lifecycle state notice if tenant transitioned into grace/locked/suspended
    if (
      syncRes.transitioned &&
      effectiveEval &&
      payerEmail &&
      (effectiveEval.effectiveStatus === "grace" ||
        effectiveEval.effectiveStatus === "locked" ||
        effectiveEval.effectiveStatus === "suspended")
    ) {
      const cycleAnchor =
        effectiveEval.deadlines.paidThroughMs ?? effectiveEval.deadlines.trialEndsAtMs ?? nowMs;
      const noticeKey = `lifecycle-notice:${tenant.id}:${effectiveEval.effectiveStatus}:${cycleAnchor}`;
      const deadlineLabel =
        effectiveEval.effectiveStatus === "grace"
          ? formatWibDateTimeLabel(effectiveEval.deadlines.graceEndsAtMs) ?? undefined
          : effectiveEval.effectiveStatus === "locked"
            ? formatWibDateTimeLabel(effectiveEval.deadlines.lockedEndsAtMs) ?? undefined
            : undefined;
      const deletionDueLabel =
        effectiveEval.effectiveStatus === "suspended"
          ? formatWibDateTimeLabel(effectiveEval.deadlines.deletionDueAtMs) ?? undefined
          : undefined;

      const renderedNotice = renderEmailTemplate("lifecycle-notice", {
        recipientName: tenant.payer_name ?? undefined,
        tenantName: tenant.name,
        state: effectiveEval.effectiveStatus,
        deadlineLabel,
        deletionDueLabel,
        billingUrl: `${appOrigin}/dashboard/${tenant.handle}/billing`,
        operatorHold: effectiveEval.operatorHold,
      });

      const sendOutcome = await sendIsolatedOneShotEmail({
        db,
        emailPort: options.emailPort,
        tenantId: tenant.id,
        messageKey: noticeKey,
        template: "lifecycle-notice",
        to: payerEmail,
        subject: renderedNotice.subject,
        html: renderedNotice.html,
        text: renderedNotice.text,
        nowMs,
        suppressionSalt: options.suppressionSalt,
      });

      if (sendOutcome.outcome === "failed" || sendOutcome.outcome === "unknown") {
        emailFailuresIsolated += 1;
      }

      emailAttempts.push({
        tenantId: tenant.id,
        kind: "lifecycle_notice",
        messageKey: noticeKey,
        outcome: sendOutcome.outcome,
        errorCode: sendOutcome.errorCode,
      });
    }

    // 3. Evaluate H-3, H-1, H0 renewal reminders & single-use grace-expiring pay links (DEC-035 C17)
    const dueReminder = evaluateDueRenewalReminder({
      storedStatus: effectiveEval?.effectiveStatus ?? tenant.status,
      operatorHold: effectiveEval?.operatorHold ?? tenant.operator_hold === 1,
      trialEndsAtMs: tenant.trial_ends_at,
      paidThroughMs: tenant.paid_through,
      nowMs,
    });

    if (!dueReminder || !payerEmail) {
      continue;
    }

    const issued = await issueRenewalPayLink(db, {
      tenantId: tenant.id,
      obligationId: tenant.open_obligation_id,
      payerUserId: tenant.payer_user_id,
      payerAgencyId: tenant.agency_id,
      reminderKind: dueReminder.kind,
      cycleAnchorMs: dueReminder.cycleAnchorMs,
      expiresAtMs: dueReminder.linkExpiresAtMs,
      appOrigin,
      nowMs,
    });

    const reminderKey = `renewal-reminder:${tenant.id}:${dueReminder.kind}:${dueReminder.cycleAnchorMs}`;
    if (!issued.created) {
      remindersDeduplicated += 1;
      emailAttempts.push({
        tenantId: tenant.id,
        kind: dueReminder.kind,
        messageKey: reminderKey,
        outcome: "duplicate",
        errorCode: null,
      });
      continue;
    }

    remindersIssued += 1;

    const dueAtLabel = formatWibDateTimeLabel(dueReminder.dueAtMs) ?? new Date(dueReminder.dueAtMs).toISOString();
    const graceEndsAtLabel = dueReminder.kind.startsWith("paid_")
      ? formatWibDateTimeLabel(dueReminder.linkExpiresAtMs) ?? undefined
      : undefined;

    const rendered = renderEmailTemplate("renewal-reminder", {
      recipientName: tenant.payer_name ?? undefined,
      tenantName: tenant.name,
      stage: dueReminder.kind,
      dueAtLabel,
      graceEndsAtLabel,
      amountIdr: monthlyPriceIdr,
      oneClickPayUrl: issued.payUrl,
    });

    const sendOutcome = await sendIsolatedOneShotEmail({
      db,
      emailPort: options.emailPort,
      tenantId: tenant.id,
      messageKey: reminderKey,
      template: "renewal-reminder",
      to: payerEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      nowMs,
      suppressionSalt: options.suppressionSalt,
    });

    if (sendOutcome.outcome === "failed") {
      emailFailuresIsolated += 1;
      // Release the unconsumed pay link ONLY after a retryable definite provider refusal
      // (e.g. `E_RATE_LIMITED`) so the next sweep can safely re-issue and send the reminder
      // (never releases on `submitted`, `unknown`, or permanent refusal per PLAN §17.4).
      if (isRetryableDefiniteRefusalCode(sendOutcome.errorCode)) {
        try {
          await releaseFailedRenewalPayLink(db, issued.id);
        } catch {
          // Isolation: link cleanup error never affects lifecycle sweep or tenant access
        }
      }
    } else if (sendOutcome.outcome === "unknown") {
      emailFailuresIsolated += 1;
    }

    emailAttempts.push({
      tenantId: tenant.id,
      kind: dueReminder.kind,
      messageKey: reminderKey,
      outcome: sendOutcome.outcome,
      errorCode: sendOutcome.errorCode,
      payLinkId: issued.id,
      payUrl: issued.payUrl,
    });
  }

  return {
    evaluatedAtMs: nowMs,
    scannedTenants: candidates.length,
    transitionedCount,
    casConflictCount,
    remindersIssued,
    remindersDeduplicated,
    emailFailuresIsolated,
    emailAttempts,
  };
}

export function createBillingLifecycleSweepHandler(
  options: Omit<RunBillingLifecycleSweepOptions, "nowMs"> & {
    readonly now?: () => number;
  } = {},
): DurableJobHandler {
  return {
    maxAttempts: 3,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const scheduledAt =
        typeof ctx.payload.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? ctx.payload.scheduledAtMs
          : (options.now ? options.now() : ctx.nowMs);
      const appOrigin =
        typeof ctx.payload.appOrigin === "string" && ctx.payload.appOrigin.trim().length > 0
          ? ctx.payload.appOrigin.trim()
          : options.appOrigin;

      await runBillingLifecycleAndReminderSweep(ctx.env, {
        nowMs: scheduledAt,
        emailPort: options.emailPort,
        appOrigin,
        limit: options.limit,
        suppressionSalt: options.suppressionSalt,
      });
    },
  };
}

export function createBillingJobRegistry(
  options: Omit<RunBillingLifecycleSweepOptions, "nowMs"> & {
    readonly now?: () => number;
    readonly adviceReconciliation?: Omit<RunBillingAdviceSweepOptions, "nowMs">;
  } = {},
): Readonly<Record<string, DurableJobHandler>> {
  const registry: Record<string, DurableJobHandler> = {
    [BILLING_LIFECYCLE_SWEEP_TOPIC]: createBillingLifecycleSweepHandler(options),
  };
  if (options.adviceReconciliation) {
    registry[BILLING_ADVICE_RECONCILE_TOPIC] = createBillingAdviceReconciliationHandler({
      ...options.adviceReconciliation,
      now: options.now,
    });
  }
  return registry;
}
