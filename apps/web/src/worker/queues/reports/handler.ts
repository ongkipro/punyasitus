import {
  ALLOWED_EMAIL_SENDER,
  assertValidRecipient,
  createCloudflareEmailAdapter,
  createResendFallbackAdapter,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { NonRetryableJobError, redactJobLogRecord, sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  MonthlyReportPiiLeakError,
  assertZeroVisitorPiiInMonthlyReport,
  buildMonthlyReportMessageKey,
  parseReportMonthPeriod,
  sanitizeReportDisplayText,
  type MonthlyActivityThreshold,
  type MonthlyPerformanceReportSummary,
} from "@punyasitus/core/reports/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  addEmailSuppression,
  claimEmailDelivery,
  getEmailSuppression,
  recordEmailOutcome,
} from "@punyasitus/db/email/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  DurableQueueEnv,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";
import { loadTenantMonthlyReportSummary } from "./loader.ts";
import {
  getTenantNotificationPreferences,
  recordMonthlyReportPreClaimSkipIfUnclaimed,
} from "./preferences.ts";

/**
 * Durable Queue Worker for Monthly Owner Performance Report Emails
 * (`REQ-110`, `PLAN.md` §20.5, `DEC-041`, `DEC-043`, `TASK-110`).
 *
 * Accepted invariants enforced here:
 * 1. At most ONE report per active website per month (`monthly-report:<tenantId>:<YYYY-MM>` claim).
 * 2. Sends ONLY to the website's own `owner` member (never `agency_staff`, `admin`, `editor`, or `setup_staff`).
 * 3. Checks owner opt-out preference before sending; opted-out websites receive NO email.
 * 4. Checks minimum activity threshold (`< 5` visits AND `0` leads AND `0` WA clicks); low-activity websites receive NO email.
 * 5. Enforces ZERO visitor personal data by design + explicit `assertZeroVisitorPiiInMonthlyReport` guard.
 * 6. DEC-041 No Blind Retry: `maxAttempts = 1`, `allowRetryOnDefiniteFailure = false`. Any `failed` or `unknown`
 *    send outcome is recorded durably in `email_delivery_claims` with a sanitized error code and is NEVER replayed.
 */

export const MONTHLY_REPORT_SEND_TOPIC = "reports.monthly_owner.send" as const;
export const MONTHLY_REPORT_EMAIL_TEMPLATE = "monthly-owner-performance-report" as const;

export type MonthlyReportDeliveryStatus =
  | "submitted"
  | "duplicate"
  | "skipped_inactive_tenant"
  | "skipped_opted_out"
  | "skipped_no_owner"
  | "skipped_suppressed"
  | "skipped_below_threshold"
  | "skipped_no_transport"
  | "failed_no_retry"
  | "unknown_no_retry";

export interface MonthlyReportSendJobPayload {
  readonly tenantId: string;
  readonly reportMonth: string;
  readonly timeZone?: string;
}

export interface MonthlyReportSendExecutionResult {
  readonly tenantId: string;
  readonly reportMonth: string;
  readonly messageKey: string;
  readonly status: MonthlyReportDeliveryStatus;
  readonly errorCode: string | null;
  readonly summary?: MonthlyPerformanceReportSummary;
}

export interface MonthlyReportWorkerEnv extends Partial<DurableQueueEnv> {
  readonly PLATFORM_DB: D1Database;
  readonly TENANT_STORE?: DurableQueueEnv["TENANT_STORE"];
  readonly PLATFORM_DOMAIN?: string;
  readonly EMAIL_PROVIDER?: string;
  readonly RESEND_API_KEY?: string;
  readonly EMAIL_SUPPRESSION_SALT?: string;
}

export interface ExecuteMonthlyReportOptions {
  readonly emailPort?: EmailPort | null;
  readonly resolvePort?: (env: MonthlyReportWorkerEnv) => EmailPort | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly threshold?: MonthlyActivityThreshold;
  readonly suppressionSalt?: string;
  readonly now?: () => number;
  readonly logger?: StructuredJobLogger;
  readonly appBaseUrl?: string;
}

interface ActiveTenantOwnerRow {
  readonly tenant_id: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly operator_hold: number;
  readonly deletion_due_at: number | null;
  readonly offboarding_started_at: number | null;
  readonly owner_user_id: string | null;
  readonly owner_name: string | null;
  readonly owner_email: string | null;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function resolveTransport(
  env: MonthlyReportWorkerEnv,
  options?: ExecuteMonthlyReportOptions,
): EmailPort | null {
  if (options?.emailPort !== undefined) {
    return options.emailPort;
  }
  if (options?.resolvePort) {
    return options.resolvePort(env);
  }
  const providerPref =
    typeof env.EMAIL_PROVIDER === "string" ? env.EMAIL_PROVIDER.trim().toLowerCase() : "";
  const resendApiKey =
    typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.trim()
      ? env.RESEND_API_KEY.trim()
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

function resolveSuppressionSalt(
  env: MonthlyReportWorkerEnv,
  options?: ExecuteMonthlyReportOptions,
): string | undefined {
  if (options?.suppressionSalt !== undefined) {
    return options.suppressionSalt;
  }
  return typeof env.EMAIL_SUPPRESSION_SALT === "string" && env.EMAIL_SUPPRESSION_SALT.trim()
    ? env.EMAIL_SUPPRESSION_SALT.trim()
    : undefined;
}

function resolveAppBaseUrl(
  env: MonthlyReportWorkerEnv,
  options?: ExecuteMonthlyReportOptions,
): string {
  if (options?.appBaseUrl && options.appBaseUrl.trim()) {
    return options.appBaseUrl.trim().replace(/\/+$/, "");
  }
  const domain = (env.PLATFORM_DOMAIN ?? "punyasitus.com").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://app.${domain}`;
}

async function resolveTenantDatabase(
  env: MonthlyReportWorkerEnv,
  tenantId: string,
  options?: ExecuteMonthlyReportOptions,
): Promise<D1Database> {
  if (options?.resolveTenantDb) {
    return await options.resolveTenantDb(tenantId);
  }
  if (!env.TENANT_STORE) {
    throw new NonRetryableJobError(
      "TENANT_STORE binding is unavailable for monthly report generation",
      "E_TENANT_STORE_UNAVAILABLE",
    );
  }
  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    tenantId,
  );
  return createTenantDb(stub);
}

/**
 * Resolves the tenant and its strictly own `owner` member (`members.role = 'owner'`).
 * Never returns `agency_staff`, `admin`, `editor`, or `setup_staff`.
 */
async function loadTenantAndOwnOwner(
  platformDb: D1Database,
  tenantId: string,
): Promise<ActiveTenantOwnerRow | null> {
  return platformDb
    .prepare(
      `SELECT
         t.id AS tenant_id,
         t.handle,
         t.name,
         t.status,
         t.operator_hold,
         t.deletion_due_at,
         t.offboarding_started_at,
         u.id AS owner_user_id,
         u.name AS owner_name,
         u.email AS owner_email
       FROM tenants t
       LEFT JOIN members m
         ON m.organization_id = t.organization_id
        AND m.role = 'owner'
       LEFT JOIN users u
         ON u.id = m.user_id
       WHERE t.id = ?
       ORDER BY m.created_at ASC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<ActiveTenantOwnerRow>();
}

function sanitizeOwnerGreetingName(rawName: string | null | undefined): string | undefined {
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.includes("@")) {
    return undefined;
  }
  const cleaned = sanitizeReportDisplayText(trimmed, 80);
  if (!cleaned || cleaned.includes("[redacted]")) {
    return undefined;
  }
  return cleaned;
}

/**
 * Executes monthly performance report generation and one-shot delivery for a single website.
 * Strictly enforces opt-out, minimum activity threshold, zero visitor PII, idempotency per
 * `(tenantId, reportMonth)`, and DEC-041 no blind retry.
 */
export async function executeMonthlyOwnerReportForTenant(
  env: MonthlyReportWorkerEnv,
  input: MonthlyReportSendJobPayload,
  options?: ExecuteMonthlyReportOptions,
): Promise<MonthlyReportSendExecutionResult> {
  const now = options?.now ?? (() => Date.now());
  const logger = options?.logger ?? defaultLogger;
  const nowMs = Math.trunc(now());

  const tenantId = input.tenantId.trim();
  const period = parseReportMonthPeriod(input.reportMonth, input.timeZone);
  const messageKey = buildMonthlyReportMessageKey(tenantId, period.reportMonth);
  const db = env.PLATFORM_DB;

  // 1. Verify website is active and has its own owner
  const tenantRow = await loadTenantAndOwnOwner(db, tenantId);
  if (
    !tenantRow ||
    tenantRow.status !== "active" ||
    tenantRow.operator_hold === 1 ||
    tenantRow.deletion_due_at !== null ||
    tenantRow.offboarding_started_at !== null
  ) {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "E_TENANT_NOT_ACTIVE",
      nowMs,
    });
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_inactive_tenant",
      errorCode: "E_TENANT_NOT_ACTIVE",
    };
  }

  // 2. Check owner opt-out preference BEFORE reading TenantStore or claiming
  const prefs = await getTenantNotificationPreferences(db, tenantId);
  if (!prefs.monthlyPerformanceReportEnabled) {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "E_REPORT_OPTED_OUT",
      nowMs,
    });
    logger(
      redactJobLogRecord({
        event: "monthly_report.skipped_opted_out",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        timestamp: nowMs,
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_opted_out",
      errorCode: "E_REPORT_OPTED_OUT",
    };
  }

  // 3. Validate owner recipient (strictly the website's own owner)
  let recipientEmail: string;
  try {
    if (!tenantRow.owner_user_id || !tenantRow.owner_email) {
      throw new Error("OWNER_MISSING");
    }
    recipientEmail = assertValidRecipient(tenantRow.owner_email);
  } catch {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "E_OWNER_NOT_FOUND",
      nowMs,
    });
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_no_owner",
      errorCode: "E_OWNER_NOT_FOUND",
    };
  }

  // 4. Check recipient suppression BEFORE claiming or sending
  const suppressionSalt = resolveSuppressionSalt(env, options);
  const existingSuppression = await getEmailSuppression(db, recipientEmail, {
    salt: suppressionSalt,
  });
  if (existingSuppression) {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "E_RECIPIENT_SUPPRESSED",
      nowMs,
    });
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_suppressed",
      errorCode: "E_RECIPIENT_SUPPRESSED",
    };
  }

  // 5. Aggregate monthly metrics from TenantStore (strictly anonymized insights tables, zero PII)
  const tenantDb = await resolveTenantDatabase(env, tenantId, options);
  const summary = await loadTenantMonthlyReportSummary(tenantDb, {
    reportMonth: period.reportMonth,
    timeZone: period.timeZone,
    threshold: options?.threshold,
  });

  // 6. Enforce minimum activity threshold
  if (!summary.meetsActivityThreshold) {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "E_BELOW_ACTIVITY_THRESHOLD",
      nowMs: now(),
    });
    logger(
      redactJobLogRecord({
        event: "monthly_report.skipped_below_threshold",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        visits: summary.current.visits,
        leads: summary.current.leads,
        whatsappClicks: summary.current.whatsappClicks,
        timestamp: now(),
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_below_threshold",
      errorCode: "E_BELOW_ACTIVITY_THRESHOLD",
      summary,
    };
  }

  // 7. Resolve email transport; record skipped without claiming if unbound
  const port = resolveTransport(env, options);
  if (!port) {
    await recordMonthlyReportPreClaimSkipIfUnclaimed(db, {
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      errorCode: "NO_EMAIL_TRANSPORT",
      nowMs: now(),
    });
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_no_transport",
      errorCode: "NO_EMAIL_TRANSPORT",
      summary,
    };
  }

  // 8. Atomically claim (tenantId, reportMonth) BEFORE calling EmailPort.send()
  //    `allowRetryOnDefiniteFailure: false` guarantees DEC-041 no blind retry even if re-invoked.
  const claim = await claimEmailDelivery(db, {
    messageKey,
    template: MONTHLY_REPORT_EMAIL_TEMPLATE,
    oneShot: true,
    allowRetryOnDefiniteFailure: false,
    nowMs: now(),
  });

  if (claim.outcome === "duplicate") {
    logger(
      redactJobLogRecord({
        event: "monthly_report.deduplicated",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        existingStatus: claim.record.status,
        timestamp: now(),
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "duplicate",
      errorCode: claim.record.errorCode,
      summary,
    };
  }

  // 9. Render escaped Bahasa Indonesia email template + assert ZERO visitor PII
  //    Guarded inside try/catch AFTER claim so any render/URL/Zod/PII failure records `failed`
  //    durably instead of leaving the claim stuck in `claimed` forever.
  let rendered: ReturnType<typeof renderEmailTemplate>;
  try {
    const appBase = resolveAppBaseUrl(env, options);
    const safeTenantName = sanitizeReportDisplayText(tenantRow.name, 140) || tenantRow.handle;
    rendered = renderEmailTemplate(MONTHLY_REPORT_EMAIL_TEMPLATE, {
      recipientName: sanitizeOwnerGreetingName(tenantRow.owner_name),
      tenantName: safeTenantName,
      tenantHandle: tenantRow.handle,
      reportMonth: summary.period.reportMonth,
      reportMonthLabel: summary.period.reportMonthLabelId,
      comparisonMonthLabel: summary.period.comparisonMonthLabelId,
      visits: summary.current.visits,
      leads: summary.current.leads,
      whatsappClicks: summary.current.whatsappClicks,
      aiAssistantReferrals: summary.current.aiAssistantReferrals,
      momVisits: {
        direction: summary.mom.visits.direction,
        labelId: summary.mom.visits.labelId,
      },
      momLeads: {
        direction: summary.mom.leads.direction,
        labelId: summary.mom.leads.labelId,
      },
      momWhatsappClicks: {
        direction: summary.mom.whatsappClicks.direction,
        labelId: summary.mom.whatsappClicks.labelId,
      },
      momAiAssistantReferrals: {
        direction: summary.mom.aiAssistantReferrals.direction,
        labelId: summary.mom.aiAssistantReferrals.labelId,
      },
      topOffering: summary.topOffering
        ? {
            title: summary.topOffering.title,
            path: summary.topOffering.path,
            visits: summary.topOffering.visits,
            whatsappClicks: summary.topOffering.whatsappClicks,
            leads: summary.topOffering.leads,
          }
        : null,
      actionableTip: summary.actionableTip,
      dashboardInsightsUrl: `${appBase}/dashboard/${tenantRow.handle}/insights`,
      notificationSettingsUrl: `${appBase}/dashboard/${tenantRow.handle}/settings/notifications`,
    });

    assertZeroVisitorPiiInMonthlyReport(rendered, {
      allowedBoilerplateEmails: [ALLOWED_EMAIL_SENDER],
    });
  } catch (err) {
    const errorCode =
      err instanceof MonthlyReportPiiLeakError ? err.code : sanitizeErrorCode(err);
    await recordEmailOutcome(db, {
      messageKey,
      status: "failed",
      provider: port.provider,
      errorCode,
      nowMs: now(),
    });
    logger(
      redactJobLogRecord({
        event:
          err instanceof MonthlyReportPiiLeakError
            ? "monthly_report.blocked_pii_guard"
            : "monthly_report.render_failed_no_retry",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        errorCode,
        timestamp: now(),
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "failed_no_retry",
      errorCode,
      summary,
    };
  }

  // 10. Send via EmailPort (DEC-041: NEVER blind-retry any failed or ambiguous outcome;
  //     a thrown transport/network exception has an ambiguous delivery state -> record `unknown`)
  let sendResult: Awaited<ReturnType<EmailPort["send"]>>;
  try {
    sendResult = await port.send({
      messageKey,
      template: MONTHLY_REPORT_EMAIL_TEMPLATE,
      from: ALLOWED_EMAIL_SENDER,
      to: recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      oneShot: true,
      tenantId,
    });
  } catch (err) {
    const errorCode = sanitizeErrorCode(err);
    await recordEmailOutcome(db, {
      messageKey,
      status: "unknown",
      provider: port.provider,
      errorCode,
      nowMs: now(),
    });
    logger(
      redactJobLogRecord({
        event: "monthly_report.send_thrown_unknown_no_retry",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        provider: port.provider,
        errorCode,
        timestamp: now(),
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "unknown_no_retry",
      errorCode,
      summary,
    };
  }

  const finishedAt = now();

  if (sendResult.outcome === "submitted") {
    await recordEmailOutcome(db, {
      messageKey,
      status: "submitted",
      provider: sendResult.provider,
      errorCode: null,
      nowMs: finishedAt,
    });
    logger(
      redactJobLogRecord({
        event: "monthly_report.submitted",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        provider: sendResult.provider,
        timestamp: finishedAt,
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "submitted",
      errorCode: null,
      summary,
    };
  }

  if (sendResult.outcome === "unknown") {
    const errorCode = sanitizeErrorCode(sendResult.errorCode);
    await recordEmailOutcome(db, {
      messageKey,
      status: "unknown",
      provider: sendResult.provider,
      errorCode,
      nowMs: finishedAt,
    });
    logger(
      redactJobLogRecord({
        event: "monthly_report.send_unknown_no_retry",
        tenantId,
        reportMonth: period.reportMonth,
        messageKey,
        provider: sendResult.provider,
        errorCode,
        timestamp: finishedAt,
      }),
    );
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "unknown_no_retry",
      errorCode,
      summary,
    };
  }

  // sendResult.outcome === "failed"
  if (sendResult.suppressed) {
    await addEmailSuppression(db, {
      email: recipientEmail,
      reason: "hard_bounce",
      source: `provider:${sendResult.provider}`,
      salt: suppressionSalt,
      nowMs: finishedAt,
    });
    await recordEmailOutcome(db, {
      messageKey,
      status: "skipped",
      provider: sendResult.provider,
      errorCode: "E_RECIPIENT_SUPPRESSED",
      nowMs: finishedAt,
    });
    return {
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      status: "skipped_suppressed",
      errorCode: "E_RECIPIENT_SUPPRESSED",
      summary,
    };
  }

  const errorCode = sanitizeErrorCode(sendResult.errorCode);
  await recordEmailOutcome(db, {
    messageKey,
    status: "failed",
    provider: sendResult.provider,
    errorCode,
    nowMs: finishedAt,
  });
  logger(
    redactJobLogRecord({
      event: "monthly_report.send_failed_no_retry",
      tenantId,
      reportMonth: period.reportMonth,
      messageKey,
      provider: sendResult.provider,
      errorCode,
      timestamp: finishedAt,
    }),
  );
  return {
    tenantId,
    reportMonth: period.reportMonth,
    messageKey,
    status: "failed_no_retry",
    errorCode,
    summary,
  };
}

export interface CreateMonthlyReportQueueHandlerOptions extends ExecuteMonthlyReportOptions {
  readonly leaseDurationMs?: number;
  readonly onResult?: (result: MonthlyReportSendExecutionResult) => Promise<void> | void;
}

/**
 * Creates a `DurableJobHandler` for `reports.monthly_owner.send`.
 *
 * Strictly configured with `maxAttempts = 1` (DEC-041):
 * - A failed `EmailPort.send()` records the sanitized error durably in `email_delivery_claims`
 *   AND raises `NonRetryableJobError` so `processDurableQueueBatch` marks `job_ledger` as
 *   terminal `dead_letter` and immediately calls `message.ack()` (NEVER `message.retry()`).
 * - An ambiguous `unknown` outcome records `unknown` in `email_delivery_claims` and acks cleanly
 *   without retry.
 */
export function createMonthlyReportSendHandler(
  options?: CreateMonthlyReportQueueHandlerOptions,
): DurableJobHandler {
  return {
    maxAttempts: 1,
    leaseDurationMs: options?.leaseDurationMs,
    async execute(ctx: JobExecutionContext): Promise<void> {
      const rawTenantId =
        typeof ctx.payload.tenantId === "string" && ctx.payload.tenantId.trim()
          ? ctx.payload.tenantId.trim()
          : (ctx.tenantId ?? "").trim();
      const rawReportMonth =
        typeof ctx.payload.reportMonth === "string" ? ctx.payload.reportMonth.trim() : "";
      const rawTimeZone =
        typeof ctx.payload.timeZone === "string" && ctx.payload.timeZone.trim()
          ? ctx.payload.timeZone.trim()
          : undefined;

      if (!rawTenantId || !rawReportMonth) {
        throw new NonRetryableJobError(
          "Monthly report job payload requires tenantId and reportMonth",
          "E_INVALID_MONTHLY_REPORT_PAYLOAD",
        );
      }

      const result = await executeMonthlyOwnerReportForTenant(
        ctx.env as MonthlyReportWorkerEnv,
        {
          tenantId: rawTenantId,
          reportMonth: rawReportMonth,
          timeZone: rawTimeZone,
        },
        options,
      );

      if (options?.onResult) {
        await options.onResult(result);
      }

      if (result.status === "failed_no_retry" || result.status === "unknown_no_retry") {
        // NonRetryableJobError causes `processDurableQueueBatch` to mark job_ledger `dead_letter`
        // and immediately `message.ack()` (retried = 0, zero blind replay!).
        throw new NonRetryableJobError(
          `Monthly report delivery ended with ${result.status} (${result.errorCode ?? "EMAIL_SEND_FAILED"})`,
          result.errorCode ?? "EMAIL_SEND_FAILED",
        );
      }
    },
  };
}

export function createMonthlyReportQueueRegistry(
  options?: CreateMonthlyReportQueueHandlerOptions,
): DurableJobRegistry {
  return {
    [MONTHLY_REPORT_SEND_TOPIC]: createMonthlyReportSendHandler(options),
  };
}
