import {
  evaluateDeletionWarningSchedule,
  formatWibDateTimeLabel,
  type DeletionWarningStage,
} from "@punyasitus/core/billing/index";
import { createCloudflareSaasClient } from "@punyasitus/core/domains/index";
import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  createCloudflareEmailAdapter,
  createResendFallbackAdapter,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { redactJobLogRecord, sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  claimEmailDelivery,
  getEmailSuppression,
  recordEmailOutcome,
} from "@punyasitus/db/email/index";
import {
  claimTenantForOffboarding,
  executeTenantOffboardingPurge,
  listTenantsForOffboardingSweep,
  recordOffboardingWarningOutcome,
  suppressMissedOffboardingWarnings,
  claimOffboardingWarningStage,
  type ExecuteTenantOffboardingPurgeResult,
  type OffboardingCloudflareClientLike,
  type OffboardingR2BucketLike,
  type OffboardingTenantStoreNamespaceLike,
} from "@punyasitus/db/offboarding/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  DurableQueueEnv,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";
import {
  TENANT_OFFBOARDING_PURGE_TOPIC,
  TENANT_OFFBOARDING_SWEEP_TOPIC,
  type TenantOffboardingPurgeJobPayload,
  type TenantOffboardingSweepJobPayload,
} from "../dispatch/offboarding.ts";

/**
 * Locked-Tenant Retention Warnings & Serialized Offboarding Queue Workers
 * (REQ-069, PLAN §17.3, DEC-022, TASK-068).
 *
 * Hard invariants:
 * - Frozen-time deterministic: derives `deletion_due_at` from `paid_through + 45d`,
 *   `trial_ends_at + 30d`, or `created_at + 30d` regardless of scheduler delay.
 * - Delayed-job warning suppression: sends ONLY the latest missed reminder and marks
 *   earlier missed reminders `suppressed_catchup` (zero spam burst!).
 * - Atomic claim BEFORE side effects: offboarding takes the entitlement lock
 *   (`status = 'purging'`, `offboarding_started_at`) before touching Cloudflare, R2, or `TenantStore`.
 * - Resumable & idempotent: tenants already in `status = 'purging'` resume from their
 *   checkpoint in `tenant_offboarding_runs` without repeating completed external deletes.
 */

export interface OffboardingWarningDispatchOutcome {
  readonly tenantId: string;
  readonly stage: DeletionWarningStage;
  readonly deletionDueAtMs: number;
  readonly suppressedStages: readonly DeletionWarningStage[];
  readonly outcome: "submitted" | "duplicate" | "skipped" | "failed" | "unknown";
  readonly errorCode: string | null;
}

export interface OffboardingPurgeAttemptOutcome {
  readonly tenantId: string;
  readonly claimed: boolean;
  readonly blockReason: string | null;
  readonly purgeResult: ExecuteTenantOffboardingPurgeResult | null;
  readonly errorCode: string | null;
}

export interface OffboardingSweepResult {
  readonly evaluatedAtMs: number;
  readonly scannedTenants: number;
  readonly warningsSent: number;
  readonly warningsDeduplicated: number;
  readonly warningsSuppressedCatchup: number;
  readonly emailFailuresIsolated: number;
  readonly tenantsClaimed: number;
  readonly tenantsPurged: number;
  readonly tenantsResumed: number;
  readonly tenantsBlocked: number;
  readonly purgeFailures: number;
  readonly warningOutcomes: readonly OffboardingWarningDispatchOutcome[];
  readonly purgeOutcomes: readonly OffboardingPurgeAttemptOutcome[];
}

export interface RunOffboardingSweepOptions {
  readonly nowMs?: number;
  readonly emailPort?: EmailPort | null;
  readonly cloudflareClient?: OffboardingCloudflareClientLike | null;
  readonly mediaBucket?: OffboardingR2BucketLike | null;
  readonly tenantStoreNamespace?: OffboardingTenantStoreNamespaceLike | null;
  readonly appOrigin?: string;
  readonly limit?: number;
  readonly pageSize?: number;
  readonly tenantId?: string;
  readonly suppressionSalt?: string;
  readonly requestId?: string | null;
  readonly logger?: StructuredJobLogger;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function resolveOffboardingCloudflareClient(
  env: Partial<DurableQueueEnv>,
  explicit?: OffboardingCloudflareClientLike | null,
): OffboardingCloudflareClientLike | null {
  if (explicit !== undefined) return explicit;
  const cfEnv = env as Partial<DurableQueueEnv> & {
    readonly CF_SAAS_ZONE_ID?: string;
    readonly CF_SAAS_API_TOKEN?: string;
    readonly CF_API_BASE_URL?: string;
  };
  const zoneId = cfEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = cfEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) {
    return null;
  }
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: cfEnv.CF_API_BASE_URL,
  });
}

function resolveOffboardingEmailPort(
  env: Partial<DurableQueueEnv>,
  explicit?: EmailPort | null,
): EmailPort | null {
  if (explicit !== undefined) return explicit;
  const envBag = env as Record<string, unknown>;
  const providerPref =
    typeof envBag.EMAIL_PROVIDER === "string" ? envBag.EMAIL_PROVIDER.trim().toLowerCase() : "";
  const resendApiKey =
    typeof envBag.RESEND_API_KEY === "string" && envBag.RESEND_API_KEY.trim()
      ? envBag.RESEND_API_KEY.trim()
      : "";

  if (providerPref === "resend" && resendApiKey) {
    return createResendFallbackAdapter({ apiKey: resendApiKey });
  }
  if (env.EMAIL) {
    return createCloudflareEmailAdapter(env.EMAIL);
  }
  if (resendApiKey) {
    return createResendFallbackAdapter({ apiKey: resendApiKey });
  }
  return null;
}

async function sendIsolatedDeletionWarningEmail(params: {
  readonly db: D1Database;
  readonly emailPort: EmailPort | null | undefined;
  readonly tenantId: string;
  readonly messageKey: string;
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
  try {
    const suppressed = await getEmailSuppression(params.db, params.to, {
      salt: params.suppressionSalt,
    });
    if (suppressed) {
      try {
        await recordEmailOutcome(params.db, {
          messageKey: params.messageKey,
          template: "deletion-warning",
          oneShot: true,
          status: "skipped",
          provider: null,
          errorCode: "E_RECIPIENT_SUPPRESSED",
          nowMs: params.nowMs,
        });
      } catch {
        // Isolation: email bookkeeping error never affects offboarding
      }
      return { outcome: "skipped", errorCode: "E_RECIPIENT_SUPPRESSED" };
    }
  } catch {
    // Suppression table optional in minimal test harnesses
  }

  if (!params.emailPort) {
    return { outcome: "skipped", errorCode: "NO_EMAIL_TRANSPORT" };
  }

  let claimRecorded = false;
  try {
    const claim = await claimEmailDelivery(params.db, {
      messageKey: params.messageKey,
      template: "deletion-warning",
      oneShot: true,
      allowRetryOnDefiniteFailure: true,
      nowMs: params.nowMs,
    });
    claimRecorded = true;
    if (claim.outcome === "duplicate") {
      return { outcome: "duplicate", errorCode: null };
    }
  } catch {
    // Proceed cleanly if 0002_email_delivery_claims is absent
  }

  try {
    const sendRes = await params.emailPort.send({
      messageKey: params.messageKey,
      template: "deletion-warning",
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
        // Isolation
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
        // Isolation
      }
    }
    return { outcome: "failed", errorCode };
  }
}

/**
 * Executes one complete offboarding & retention-warning sweep pass at `nowMs`:
 * 1. Resumes any tenants already in `status = 'purging'` idempotently.
 * 2. Sends at-most-once pre-deletion warnings (`-7d/-3d/-1d` or `H+38/H+42/H+44`) with
 *    delayed-job latest-only suppression (no spam burst!), skipping active/paid/held tenants.
 * 3. Atomically claims (`status = 'purging'`, `offboarding_started_at`) and purges tenants
 *    at or past `deletion_due_at`, blocking on operator holds and unresolved payment attempts.
 */
export async function runTenantOffboardingSweep(
  env: Pick<DurableQueueEnv, "PLATFORM_DB"> &
    Partial<Pick<DurableQueueEnv, "MEDIA_BUCKET" | "TENANT_STORE" | "EMAIL">>,
  options: RunOffboardingSweepOptions = {},
): Promise<OffboardingSweepResult> {
  const db = env.PLATFORM_DB;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const appOrigin = (options.appOrigin ?? "https://app.punyasitus.com").replace(/\/+$/, "");
  const logger = options.logger ?? defaultLogger;

  const mediaBucket =
    options.mediaBucket !== undefined
      ? options.mediaBucket
      : ((env.MEDIA_BUCKET as unknown as OffboardingR2BucketLike | undefined) ?? null);
  const tenantStoreNamespace =
    options.tenantStoreNamespace !== undefined
      ? options.tenantStoreNamespace
      : ((env.TENANT_STORE as unknown as OffboardingTenantStoreNamespaceLike | undefined) ?? null);
  const cloudflareClient = resolveOffboardingCloudflareClient(env, options.cloudflareClient);
  const emailPort = resolveOffboardingEmailPort(env, options.emailPort);

  const pageSize = Math.max(1, Math.min(500, Math.trunc(options.pageSize ?? 200)));
  const maxTotal =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.trunc(options.limit)
      : Number.POSITIVE_INFINITY;

  let scannedTenants = 0;
  let warningsSent = 0;
  let warningsDeduplicated = 0;
  let warningsSuppressedCatchup = 0;
  let emailFailuresIsolated = 0;
  let tenantsClaimed = 0;
  let tenantsPurged = 0;
  let tenantsResumed = 0;
  let tenantsBlocked = 0;
  let purgeFailures = 0;

  const warningOutcomes: OffboardingWarningDispatchOutcome[] = [];
  const purgeOutcomes: OffboardingPurgeAttemptOutcome[] = [];

  let afterId: string | undefined;

  for (;;) {
    const remaining = Number.isFinite(maxTotal) ? maxTotal - scannedTenants : pageSize;
    if (remaining <= 0) break;
    const batchLimit = Math.min(pageSize, remaining);

    const candidates = await listTenantsForOffboardingSweep(db, {
      limit: batchLimit,
      tenantId: options.tenantId,
      afterId,
      nowMs,
    });
    if (candidates.length === 0) break;

    for (const tenant of candidates) {
      scannedTenants += 1;

      // 1. Resume any previously claimed/interrupted `purging` run idempotently
      if (tenant.status === "purging") {
        try {
          const purgeResult = await executeTenantOffboardingPurge({
            platformDb: db,
            tenantId: tenant.id,
            mediaBucket,
            tenantStoreNamespace,
            cloudflareClient,
            nowMs,
            requestId: options.requestId,
          });
          if (purgeResult.outcome === "purged") {
            tenantsResumed += 1;
            tenantsPurged += 1;
          }
          purgeOutcomes.push({
            tenantId: tenant.id,
            claimed: true,
            blockReason: null,
            purgeResult,
            errorCode: null,
          });
        } catch (err) {
          purgeFailures += 1;
          purgeOutcomes.push({
            tenantId: tenant.id,
            claimed: true,
            blockReason: null,
            purgeResult: null,
            errorCode: sanitizeErrorCode(err),
          });
        }
        continue;
      }

      // 2. Evaluate deletion warning schedule vs past-deadline offboarding eligibility
      const schedule = evaluateDeletionWarningSchedule({
        storedStatus: tenant.status,
        operatorHold: tenant.operator_hold === 1,
        retentionPausedAtMs: tenant.retention_paused_at,
        offboardingStartedAtMs: tenant.offboarding_started_at,
        paidThroughMs: tenant.paid_through,
        trialEndsAtMs: tenant.trial_ends_at,
        createdAtMs: tenant.created_at,
        explicitDeletionDueAtMs: tenant.deletion_due_at,
        nowMs,
      });

      // 2a. Pre-deletion warning window: send ONLY the latest missed reminder!
      if (schedule.latestDueWarning && schedule.deletionDueAtMs !== null) {
        const earlierStages = schedule.earlierMissedWarnings.map((m) => m.stage);
        if (earlierStages.length > 0) {
          const suppressedCount = await suppressMissedOffboardingWarnings(db, {
            tenantId: tenant.id,
            stages: earlierStages,
            deletionDueAtMs: schedule.deletionDueAtMs,
            nowMs,
          });
          warningsSuppressedCatchup += suppressedCount;
        }

        const payerEmail = tenant.payer_email?.trim() || null;
        if (payerEmail) {
          const stage = schedule.latestDueWarning.stage;
          const claim = await claimOffboardingWarningStage(db, {
            tenantId: tenant.id,
            stage,
            deletionDueAtMs: schedule.deletionDueAtMs,
            nowMs,
          });

          if (!claim.claimed) {
            warningsDeduplicated += 1;
            warningOutcomes.push({
              tenantId: tenant.id,
              stage,
              deletionDueAtMs: schedule.deletionDueAtMs,
              suppressedStages: earlierStages,
              outcome: "duplicate",
              errorCode: null,
            });
          } else {
            const messageKey = `deletion-warning:${tenant.id}:${stage}:${schedule.deletionDueAtMs}`;
            const deletionDueAtLabel =
              formatWibDateTimeLabel(schedule.deletionDueAtMs) ??
              new Date(schedule.deletionDueAtMs).toISOString();

            const rendered = renderEmailTemplate("deletion-warning", {
              recipientName: tenant.payer_name ?? undefined,
              tenantName: tenant.name,
              stage,
              daysRemaining: schedule.latestDueWarning.daysBeforeDeletion,
              deletionDueAtLabel,
              billingUrl: `${appOrigin}/dashboard/${tenant.handle}/billing`,
              leadsExportUrl: `${appOrigin}/api/tenants/${tenant.id}/leads/export`,
            });

            const sendRes = await sendIsolatedDeletionWarningEmail({
              db,
              emailPort,
              tenantId: tenant.id,
              messageKey,
              to: payerEmail,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              nowMs,
              suppressionSalt: options.suppressionSalt,
            });

            const warningOutcome =
              sendRes.outcome === "duplicate" ? "submitted" : sendRes.outcome;
            await recordOffboardingWarningOutcome(db, {
              tenantId: tenant.id,
              stage,
              deletionDueAtMs: schedule.deletionDueAtMs,
              outcome: warningOutcome,
              errorCode: sendRes.errorCode,
              nowMs,
            });

            if (sendRes.outcome === "submitted") {
              warningsSent += 1;
            } else if (sendRes.outcome === "duplicate") {
              warningsDeduplicated += 1;
            } else if (sendRes.outcome === "failed" || sendRes.outcome === "unknown") {
              emailFailuresIsolated += 1;
            }

            warningOutcomes.push({
              tenantId: tenant.id,
              stage,
              deletionDueAtMs: schedule.deletionDueAtMs,
              suppressedStages: earlierStages,
              outcome: sendRes.outcome,
              errorCode: sendRes.errorCode,
            });
          }
        }
        continue;
      }

      // 2b. Past `deletion_due_at`: claim entitlement lock atomically BEFORE any side effects, then purge!
      if (schedule.isPastDeadline) {
        const claimRes = await claimTenantForOffboarding(db, {
          tenantId: tenant.id,
          nowMs,
          requestId: options.requestId,
        });

        if (!claimRes.claimed) {
          tenantsBlocked += 1;
          purgeOutcomes.push({
            tenantId: tenant.id,
            claimed: false,
            blockReason: claimRes.reason,
            purgeResult: null,
            errorCode: null,
          });
          continue;
        }

        tenantsClaimed += 1;
        try {
          const purgeResult = await executeTenantOffboardingPurge({
            platformDb: db,
            tenantId: tenant.id,
            mediaBucket,
            tenantStoreNamespace,
            cloudflareClient,
            nowMs,
            requestId: options.requestId,
          });
          if (purgeResult.outcome === "purged") {
            tenantsPurged += 1;
          }
          purgeOutcomes.push({
            tenantId: tenant.id,
            claimed: true,
            blockReason: null,
            purgeResult,
            errorCode: null,
          });
        } catch (err) {
          purgeFailures += 1;
          purgeOutcomes.push({
            tenantId: tenant.id,
            claimed: true,
            blockReason: null,
            purgeResult: null,
            errorCode: sanitizeErrorCode(err),
          });
        }
      }
    }

    if (options.tenantId || candidates.length < batchLimit) {
      break;
    }
    const lastId = candidates[candidates.length - 1]?.id;
    if (!lastId || lastId === afterId) {
      break;
    }
    afterId = lastId;
  }

  logger(
    redactJobLogRecord({
      event: "offboarding.sweep.completed",
      requestId: options.requestId ?? null,
      evaluatedAtMs: nowMs,
      scannedTenants,
      warningsSent,
      warningsDeduplicated,
      warningsSuppressedCatchup,
      emailFailuresIsolated,
      tenantsClaimed,
      tenantsPurged,
      tenantsResumed,
      tenantsBlocked,
      purgeFailures,
    }),
  );

  return {
    evaluatedAtMs: nowMs,
    scannedTenants,
    warningsSent,
    warningsDeduplicated,
    warningsSuppressedCatchup,
    emailFailuresIsolated,
    tenantsClaimed,
    tenantsPurged,
    tenantsResumed,
    tenantsBlocked,
    purgeFailures,
    warningOutcomes,
    purgeOutcomes,
  };
}

export interface CreateOffboardingHandlersOptions
  extends Omit<RunOffboardingSweepOptions, "nowMs" | "tenantId" | "requestId"> {
  readonly now?: () => number;
  readonly onSweepCompleted?: (result: OffboardingSweepResult) => Promise<void> | void;
  readonly onPurgeCompleted?: (result: ExecuteTenantOffboardingPurgeResult) => Promise<void> | void;
}

export function createOffboardingSweepHandler(
  options: CreateOffboardingHandlersOptions = {},
): DurableJobHandler<TenantOffboardingSweepJobPayload> {
  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<TenantOffboardingSweepJobPayload>): Promise<void> {
      const scheduledAtMs =
        typeof ctx.payload?.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? Math.trunc(ctx.payload.scheduledAtMs)
          : (options.now ? options.now() : ctx.nowMs);
      const appOrigin =
        typeof ctx.payload?.appOrigin === "string" && ctx.payload.appOrigin.trim().length > 0
          ? ctx.payload.appOrigin.trim()
          : options.appOrigin;
      const limit =
        typeof ctx.payload?.limit === "number" && Number.isInteger(ctx.payload.limit)
          ? ctx.payload.limit
          : options.limit;

      const summary = await runTenantOffboardingSweep(ctx.env, {
        ...options,
        nowMs: scheduledAtMs,
        appOrigin,
        limit,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
      });

      if (options.onSweepCompleted) {
        await options.onSweepCompleted(summary);
      }

      // Surface purge failure to Durable Queue retry loop so interrupted purges resume automatically!
      if (summary.purgeFailures > 0) {
        const firstErr =
          summary.purgeOutcomes.find((o) => o.errorCode !== null)?.errorCode ??
          "OFFBOARDING_PURGE_INCOMPLETE";
        throw new Error(firstErr);
      }
    },
  };
}

export function createTenantOffboardingPurgeHandler(
  options: CreateOffboardingHandlersOptions = {},
): DurableJobHandler<TenantOffboardingPurgeJobPayload> {
  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<TenantOffboardingPurgeJobPayload>): Promise<void> {
      const tenantId = ctx.tenantId ?? ctx.payload?.tenantId;
      if (!tenantId) {
        throw new Error("OFFBOARDING_TENANT_ID_MISSING");
      }
      const nowMs =
        typeof ctx.payload?.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? Math.trunc(ctx.payload.scheduledAtMs)
          : (options.now ? options.now() : ctx.nowMs);

      const mediaBucket =
        options.mediaBucket !== undefined
          ? options.mediaBucket
          : ((ctx.env.MEDIA_BUCKET as unknown as OffboardingR2BucketLike | undefined) ?? null);
      const tenantStoreNamespace =
        options.tenantStoreNamespace !== undefined
          ? options.tenantStoreNamespace
          : ((ctx.env.TENANT_STORE as unknown as OffboardingTenantStoreNamespaceLike | undefined) ??
            null);
      const cloudflareClient = resolveOffboardingCloudflareClient(
        ctx.env,
        options.cloudflareClient,
      );

      // Claim first if not yet claimed; if already `purging`, resume directly!
      const claimRes = await claimTenantForOffboarding(ctx.env.PLATFORM_DB, {
        tenantId,
        nowMs,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        reason: ctx.payload?.reason,
      });

      if (!claimRes.claimed && claimRes.reason !== "already_claiming") {
        return;
      }

      const result = await executeTenantOffboardingPurge({
        platformDb: ctx.env.PLATFORM_DB,
        tenantId,
        mediaBucket,
        tenantStoreNamespace,
        cloudflareClient,
        nowMs,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        reason: ctx.payload?.reason,
      });

      if (options.onPurgeCompleted) {
        await options.onPurgeCompleted(result);
      }
    },
  };
}

export function createOffboardingJobRegistry(
  options: CreateOffboardingHandlersOptions = {},
): DurableJobRegistry {
  return {
    [TENANT_OFFBOARDING_SWEEP_TOPIC]: createOffboardingSweepHandler(
      options,
    ) as unknown as DurableJobHandler,
    [TENANT_OFFBOARDING_PURGE_TOPIC]: createTenantOffboardingPurgeHandler(
      options,
    ) as unknown as DurableJobHandler,
  };
}
