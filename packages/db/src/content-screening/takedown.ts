import { PLATFORM_HOSTS } from "@punyasitus/core";
import { computeAuthoritativeDeletionDueAt } from "@punyasitus/core/billing/offboarding";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  buildAbuseModerationTenantNoticeEmail,
  type ModerationQueueSenderLike,
} from "../abuse/index.ts";
import { isEmailSuppressed } from "../email/suppressions.ts";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  validateOperatorReason,
} from "../platform/audit.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";
import { ContentScreeningError } from "./errors.ts";

/**
 * One-click Operator Takedown ("Turunkan situs") & Trust+ Watch Run Ledger
 * (REQ-103, REQ-005, REQ-049, PLAN §20.1, DEC-043, TASK-103).
 *
 * Security & atomicity invariants:
 * - "Turunkan situs" uses the existing `suspended` state (`operator_hold = 1`,
 *   `status = 'suspended'`, `cache_version = cache_version + 1`), enforcing lifecycle,
 *   offboarding, cross-tenant `reviewId` ownership (`AND tenant_id = ?`), and optimistic
 *   version CAS guards inside ONE atomic `PLATFORM_DB.batch()` alongside `platform_audit`
 *   (`WHERE changes() = 1`) and append-only `tenant_takedown_actions`.
 * - Operator internal audit reasons NEVER leak into tenant-facing fields (`operator_hold_reason`)
 *   or owner emails: tenants receive `OWNER_SAFE_TAKEDOWN_NOTICE` while internal reasons remain
 *   strictly in `platform_audit` and `tenant_takedown_actions`.
 * - Immediately calls `evictTenantFromCache(tenantId)` so the very next public request renders
 *   the suspended page (`HTTP 503`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`).
 */

export const OWNER_SAFE_TAKEDOWN_NOTICE =
  "Situs ditangguhkan sementara karena pelanggaran kebijakan konten platform. Hubungi dukungan PunyaSitus untuk peninjauan." as const;

export const MAX_TRUST_WATCH_TENANT_HOSTS = 2000 as const;

const NON_ELIGIBLE_TAKEDOWN_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "purging",
  "purged",
  "recovery",
]);

const EMAIL_DELIVERY_TOPIC = "email.transactional.send" as const;

interface TenantLifecycleRow {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly operator_hold: number;
  readonly version: number;
  readonly cache_version: number;
  readonly paid_through: number | null;
  readonly trial_ends_at: number | null;
  readonly deletion_due_at: number | null;
  readonly retention_paused_at: number | null;
  readonly offboarding_started_at: number | null;
  readonly organization_id: string;
  readonly created_at: number;
}

interface TakedownActionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly review_id: string | null;
  readonly reason: string;
  readonly actor_user_id: string;
  readonly previous_status: string;
  readonly next_status: "suspended";
  readonly idempotency_key: string | null;
  readonly audit_id: string;
  readonly notification_status: "queued" | "sent" | "skipped" | "failed";
  readonly created_at: number;
}

export interface TakedownTenantSiteInput {
  readonly tenantId: string;
  readonly expectedTenantVersion?: number;
  readonly reviewId?: string | null;
  readonly reviewExpectedVersion?: number;
  readonly reason: unknown;
  readonly actorUserId: string;
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly tenantDb?: D1Database | null;
  readonly jobsQueue?: ModerationQueueSenderLike | null;
  readonly emailPort?: EmailPort | null;
  readonly appOrigin?: string;
  readonly nowMs?: number;
}

export interface TakedownTenantSiteResult {
  readonly takedownId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly previousStatus: string;
  readonly nextStatus: "suspended";
  readonly cacheVersion: number;
  readonly tenantVersion: number;
  readonly auditId: string;
  readonly notificationStatus: "queued" | "sent" | "skipped" | "failed";
  readonly replayed: boolean;
}

async function resolveIdempotentTakedownReplay(
  platformDb: D1Database,
  tenantId: string,
  idempotencyKey: string,
  expectedReviewId: string | null,
): Promise<TakedownTenantSiteResult | null> {
  const existingAction = await platformDb
    .prepare(
      `SELECT id, tenant_id, review_id, reason, actor_user_id, previous_status,
              next_status, idempotency_key, audit_id, notification_status, created_at
       FROM tenant_takedown_actions
       WHERE tenant_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(tenantId, idempotencyKey)
    .first<TakedownActionRow>();

  if (!existingAction) return null;

  if ((existingAction.review_id ?? null) !== expectedReviewId) {
    throw new ContentScreeningError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key sudah digunakan untuk tindakan penurunan situs yang berbeda.",
    );
  }
  const tenantSnap = await platformDb
    .prepare("SELECT handle, cache_version, version FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ readonly handle: string; readonly cache_version: number; readonly version: number }>();

  return {
    takedownId: existingAction.id,
    tenantId,
    tenantHandle: tenantSnap?.handle ?? "",
    previousStatus: existingAction.previous_status,
    nextStatus: "suspended",
    cacheVersion: Number(tenantSnap?.cache_version ?? 1),
    tenantVersion: Number(tenantSnap?.version ?? 1),
    auditId: existingAction.audit_id,
    notificationStatus: existingAction.notification_status,
    replayed: true,
  };
}

export async function takedownTenantSite(
  platformDb: D1Database,
  input: TakedownTenantSiteInput,
): Promise<TakedownTenantSiteResult> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new ContentScreeningError(404, "NOT_FOUND", "Situs tenant tidak ditemukan.");
  }

  const normalizedReviewId = input.reviewId?.trim() || null;
  if (normalizedReviewId) {
    if (
      typeof input.reviewExpectedVersion !== "number" ||
      !Number.isSafeInteger(input.reviewExpectedVersion) ||
      input.reviewExpectedVersion < 1
    ) {
      throw new ContentScreeningError(
        422,
        "VALIDATION_ERROR",
        "reviewExpectedVersion wajib diisi berupa bilangan bulat positif saat menyertakan reviewId.",
        [
          {
            field: "reviewExpectedVersion",
            code: "REQUIRED",
            message: "reviewExpectedVersion is required when reviewId is provided.",
          },
        ],
      );
    }
  }

  let cleanReason: string;
  try {
    cleanReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ContentScreeningError(422, "VALIDATION_ERROR", err.message, [
        { field: "reason", code: "INVALID_REASON", message: err.message },
      ]);
    }
    throw err;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const rawIdemp = input.idempotencyKey?.trim() || null;

  // Check idempotent replay & cross-review idempotency conflict before mutating
  if (rawIdemp) {
    const replay = await resolveIdempotentTakedownReplay(
      platformDb,
      tenantId,
      rawIdemp,
      normalizedReviewId,
    );
    if (replay) return replay;

    if (normalizedReviewId) {
      const conflictingReview = await platformDb
        .prepare(
          `SELECT id
           FROM content_screening_reviews
           WHERE tenant_id = ? AND idempotency_key = ? AND id != ?
           LIMIT 1`,
        )
        .bind(tenantId, rawIdemp, normalizedReviewId)
        .first<{ readonly id: string }>();
      if (conflictingReview) {
        throw new ContentScreeningError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key sudah digunakan pada item tinjauan lain untuk situs ini.",
        );
      }
    }
  }

  const tenant = await platformDb
    .prepare(
      `SELECT id, handle, name, status, operator_hold, version, cache_version,
              paid_through, trial_ends_at, deletion_due_at, retention_paused_at,
              offboarding_started_at, organization_id, created_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<TenantLifecycleRow>();

  if (!tenant) {
    throw new ContentScreeningError(404, "NOT_FOUND", "Situs tenant tidak ditemukan.");
  }

  if (
    NON_ELIGIBLE_TAKEDOWN_STATUSES.has(tenant.status) ||
    tenant.offboarding_started_at !== null
  ) {
    throw new ContentScreeningError(
      409,
      "TENANT_NOT_ELIGIBLE",
      `Situs dengan status "${tenant.status}" tidak memenuhi syarat untuk tindakan penurunan.`,
    );
  }

  const expectedTenantVersion = input.expectedTenantVersion ?? Number(tenant.version);
  if (Number(tenant.version) !== expectedTenantVersion) {
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      "Versi data tenant sudah berubah. Muat ulang sebelum menurunkan situs.",
    );
  }

  const deletionDue = computeAuthoritativeDeletionDueAt({
    paidThroughMs: tenant.paid_through,
    trialEndsAtMs: tenant.trial_ends_at,
    createdAtMs: tenant.created_at,
    explicitDeletionDueAtMs: tenant.deletion_due_at,
  });
  const nextDeletionDueAtMs = deletionDue.deletionDueAtMs;
  const nextRetentionPausedAtMs = tenant.retention_paused_at ?? nowMs;

  // Resolve owner email for notification (best-effort; never blocks takedown)
  const ownerRow = await platformDb
    .prepare(
      `SELECT u.email
       FROM members m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.role = 'owner'
       ORDER BY m.created_at ASC
       LIMIT 1`,
    )
    .bind(tenant.organization_id)
    .first<{ readonly email: string }>();

  const ownerEmail = ownerRow?.email?.trim().toLowerCase() ?? null;
  let suppressed = false;
  if (ownerEmail) {
    try {
      suppressed = await isEmailSuppressed(platformDb, ownerEmail);
    } catch {
      suppressed = false;
    }
  }

  const takedownId = generatePlatformAuditId(nowMs);
  const appOrigin = input.appOrigin ?? `https://${PLATFORM_HOSTS.app}`;
  // Privacy/security: owner email receives ONLY generic policy message (never internal operator reason!)
  const noticeEmail =
    ownerEmail && !suppressed
      ? buildAbuseModerationTenantNoticeEmail({
          ownerEmail,
          tenantName: tenant.name,
          tenantHandle: tenant.handle,
          action: "suspend",
          reportedPath: "/",
          reason: OWNER_SAFE_TAKEDOWN_NOTICE,
          reportId: takedownId,
          appOrigin,
        })
      : null;

  const canDeliverEmail = Boolean(noticeEmail && (input.jobsQueue || input.emailPort));
  const initialNotificationStatus: "queued" | "skipped" = canDeliverEmail ? "queued" : "skipped";
  const emailMessageKey = `takedown-notice:${tenantId}:${takedownId}`;

  const { statement: auditStmt, entry: auditRecord } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.tenant.takedown",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        previousStatus: tenant.status,
        nextStatus: "suspended",
        operatorHold: true,
        reviewId: normalizedReviewId,
        takedownId,
        deletionDueAtMs: nextDeletionDueAtMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const statements: D1PreparedStatement[] = [];

  // 1. Atomic tenant suspension + operator_hold (generic tenant-safe hold reason) + cache_version bump
  if (normalizedReviewId) {
    const reviewExpectedVersion = input.reviewExpectedVersion!;
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenants
           SET status = 'suspended',
               operator_hold = 1,
               operator_hold_reason = ?,
               deletion_due_at = ?,
               retention_paused_at = ?,
               cache_version = cache_version + 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
             AND offboarding_started_at IS NULL
             AND EXISTS (
               SELECT 1 FROM content_screening_reviews
               WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'held_for_review'
             )`,
        )
        .bind(
          OWNER_SAFE_TAKEDOWN_NOTICE,
          nextDeletionDueAtMs,
          nextRetentionPausedAtMs,
          nowMs,
          tenantId,
          expectedTenantVersion,
          normalizedReviewId,
          tenantId,
          reviewExpectedVersion,
        ),
    );
    statements.push(
      platformDb
        .prepare(
          `UPDATE content_screening_reviews
           SET status = 'takedown',
               reviewed_by_user_id = ?,
               reviewed_at = ?,
               resolution_reason = ?,
               audit_id = ?,
               idempotency_key = COALESCE(idempotency_key, ?),
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'held_for_review' AND changes() = 1`,
        )
        .bind(
          input.actorUserId,
          nowMs,
          cleanReason,
          auditRecord.id,
          rawIdemp,
          nowMs,
          normalizedReviewId,
          tenantId,
          reviewExpectedVersion,
        ),
    );
  } else {
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenants
           SET status = 'suspended',
               operator_hold = 1,
               operator_hold_reason = ?,
               deletion_due_at = ?,
               retention_paused_at = ?,
               cache_version = cache_version + 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
             AND offboarding_started_at IS NULL`,
        )
        .bind(
          OWNER_SAFE_TAKEDOWN_NOTICE,
          nextDeletionDueAtMs,
          nextRetentionPausedAtMs,
          nowMs,
          tenantId,
          expectedTenantVersion,
        ),
    );
  }

  const auditStmtIdx = statements.length;
  statements.push(auditStmt);

  const actionStmtIdx = statements.length;
  statements.push(
    platformDb
      .prepare(
        `INSERT INTO tenant_takedown_actions (
           id, tenant_id, review_id, reason, actor_user_id,
           previous_status, next_status, idempotency_key, audit_id,
           notification_status, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'suspended', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        takedownId,
        tenantId,
        normalizedReviewId,
        cleanReason,
        input.actorUserId,
        tenant.status,
        rawIdemp,
        auditRecord.id,
        initialNotificationStatus,
        nowMs,
      ),
  );

  if (canDeliverEmail && noticeEmail) {
    statements.push(
      platformDb
        .prepare(
          `INSERT OR IGNORE INTO job_ledger (
             idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
           )
           SELECT ?, ?, ?, 'queued', 0, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          emailMessageKey,
          EMAIL_DELIVERY_TOPIC,
          tenantId,
          JSON.stringify({
            messageKey: emailMessageKey,
            template: "abuse-moderation-notice",
            to: noticeEmail.to,
            subject: noticeEmail.subject,
            html: noticeEmail.html,
            text: noticeEmail.text,
            tenantId,
          }),
          nowMs,
          nowMs,
        ),
    );
  }

  let batchRes: D1Result[];
  try {
    batchRes = await platformDb.batch(statements);
  } catch (err) {
    // Handle concurrent duplicate Idempotency-Key race gracefully -> 200 replay or 409 conflict
    const msg = err instanceof Error ? err.message : String(err);
    if (rawIdemp && msg.toLowerCase().includes("unique")) {
      const replay = await resolveIdempotentTakedownReplay(
        platformDb,
        tenantId,
        rawIdemp,
        normalizedReviewId,
      );
      if (replay) return replay;
      throw new ContentScreeningError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan pada tindakan lain untuk situs ini.",
      );
    }
    throw err;
  }

  const tenantChanged = Number(batchRes[0]?.meta?.changes ?? 0);
  const auditChanged = Number(batchRes[auditStmtIdx]?.meta?.changes ?? 0);
  const actionChanged = Number(batchRes[actionStmtIdx]?.meta?.changes ?? 0);

  if (tenantChanged !== 1) {
    if (rawIdemp) {
      const replay = await resolveIdempotentTakedownReplay(
        platformDb,
        tenantId,
        rawIdemp,
        normalizedReviewId,
      );
      if (replay) return replay;
    }
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      "Status/versi situs atau kepemilikan tinjauan tidak cocok. Muat ulang dan coba lagi.",
    );
  }
  if (auditChanged !== 1 || actionChanged !== 1) {
    throw new ContentScreeningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal mencatat audit penurunan situs.",
    );
  }

  // Immediately evict in-isolate host/tenant cache so the very next public request returns suspended!
  evictTenantFromCache(tenantId);

  // Dispatch owner notice
  let finalNotificationStatus: "queued" | "sent" | "skipped" | "failed" = initialNotificationStatus;
  if (canDeliverEmail && noticeEmail) {
    if (input.jobsQueue) {
      try {
        await input.jobsQueue.send({
          idempotencyKey: emailMessageKey,
          topic: EMAIL_DELIVERY_TOPIC,
          tenantId,
          payload: {
            messageKey: emailMessageKey,
            template: "abuse-moderation-notice",
            to: noticeEmail.to,
            subject: noticeEmail.subject,
            html: noticeEmail.html,
            text: noticeEmail.text,
            tenantId,
          },
          attempt: 0,
          maxAttempts: 3,
          correlationId: input.requestId ?? takedownId,
          enqueuedAt: nowMs,
        });
        finalNotificationStatus = "queued";
      } catch {
        finalNotificationStatus = "failed";
        try {
          await platformDb
            .prepare("UPDATE tenant_takedown_actions SET notification_status = 'failed' WHERE id = ?")
            .bind(takedownId)
            .run();
        } catch {
          // Non-fatal
        }
      }
    } else if (input.emailPort) {
      try {
        const res = await input.emailPort.send({
          messageKey: emailMessageKey,
          template: "abuse-moderation-notice",
          to: noticeEmail.to,
          subject: noticeEmail.subject,
          html: noticeEmail.html,
          text: noticeEmail.text,
          tenantId,
        });
        finalNotificationStatus = res.outcome === "submitted" ? "sent" : "failed";
      } catch {
        finalNotificationStatus = "failed";
      }
      try {
        await platformDb
          .prepare("UPDATE tenant_takedown_actions SET notification_status = ? WHERE id = ?")
          .bind(finalNotificationStatus, takedownId)
          .run();
      } catch {
        // Non-fatal
      }
    }
  }

  // Mirror operator takedown into TenantStore activity log (actor_user_id = NULL)
  if (input.tenantDb) {
    try {
      await input.tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           ) VALUES (NULL, 'platform_operator', 'moderation.site_takedown', 'tenant', ?, ?, ?, ?)`,
        )
        .bind(
          tenantId,
          "Situs diturunkan sementara (suspended) oleh tim keamanan platform",
          JSON.stringify({ takedownId }),
          nowMs,
        )
        .run();
    } catch {
      // Non-blocking
    }
  }

  return {
    takedownId,
    tenantId,
    tenantHandle: tenant.handle,
    previousStatus: tenant.status,
    nextStatus: "suspended",
    cacheVersion: Number(tenant.cache_version) + 1,
    tenantVersion: Number(tenant.version) + 1,
    auditId: auditRecord.id,
    notificationStatus: finalNotificationStatus,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------
// Trust+ Komdigi Daily Watch Run Ledger & Once-Per-Day Alert Deduplication
// ---------------------------------------------------------------------------

export type TrustWatchRunStatus = "clean" | "hit" | "unknown";

export interface TrustWatchHostHit {
  readonly host: string;
  readonly ip: string;
  readonly source: "platform" | "saas_zone" | "fallback_zone" | "tenant_host";
  readonly tenantId: string | null;
}

export interface TrustWatchHostFailure {
  readonly host: string;
  readonly reason: string;
}

export interface TrustWatchRunRecord {
  readonly id: string;
  readonly runDay: string;
  readonly status: TrustWatchRunStatus;
  readonly listSourceUrl: string;
  readonly listEntryCount: number | null;
  readonly checkedHostsCount: number;
  readonly resolvedHostsCount: number;
  readonly failedHostsCount: number;
  readonly hitCount: number;
  readonly hits: readonly TrustWatchHostHit[];
  readonly failures: readonly TrustWatchHostFailure[];
  readonly alertSent: boolean;
  readonly alertDeduplicated: boolean;
  readonly alertMessageKey: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

interface TrustWatchRunDbRow {
  readonly id: string;
  readonly run_day: string;
  readonly status: TrustWatchRunStatus;
  readonly list_source_url: string;
  readonly list_entry_count: number | null;
  readonly checked_hosts_count: number;
  readonly resolved_hosts_count: number;
  readonly failed_hosts_count: number;
  readonly hit_count: number;
  readonly hits_json: string;
  readonly failures_json: string;
  readonly alert_sent: number;
  readonly alert_deduplicated: number;
  readonly alert_message_key: string | null;
  readonly error_code: string | null;
  readonly created_at: number;
}

function mapTrustWatchRunRow(row: TrustWatchRunDbRow): TrustWatchRunRecord {
  let hits: TrustWatchHostHit[] = [];
  let failures: TrustWatchHostFailure[] = [];
  try {
    const parsedHits = JSON.parse(row.hits_json);
    if (Array.isArray(parsedHits)) hits = parsedHits as TrustWatchHostHit[];
  } catch {
    hits = [];
  }
  try {
    const parsedFailures = JSON.parse(row.failures_json);
    if (Array.isArray(parsedFailures)) failures = parsedFailures as TrustWatchHostFailure[];
  } catch {
    failures = [];
  }

  return {
    id: row.id,
    runDay: row.run_day,
    status: row.status,
    listSourceUrl: row.list_source_url,
    listEntryCount: row.list_entry_count,
    checkedHostsCount: Number(row.checked_hosts_count),
    resolvedHostsCount: Number(row.resolved_hosts_count),
    failedHostsCount: Number(row.failed_hosts_count),
    hitCount: Number(row.hit_count),
    hits,
    failures,
    alertSent: Number(row.alert_sent) === 1,
    alertDeduplicated: Number(row.alert_deduplicated) === 1,
    alertMessageKey: row.alert_message_key,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface RecordTrustWatchRunInput {
  readonly id?: string;
  readonly runDay: string;
  readonly status: TrustWatchRunStatus;
  readonly listSourceUrl: string;
  readonly listEntryCount: number | null;
  readonly checkedHostsCount: number;
  readonly resolvedHostsCount: number;
  readonly failedHostsCount: number;
  readonly hits: readonly TrustWatchHostHit[];
  readonly failures: readonly TrustWatchHostFailure[];
  readonly alertSent: boolean;
  readonly alertDeduplicated: boolean;
  readonly alertMessageKey: string | null;
  readonly errorCode: string | null;
  readonly createdAtMs?: number;
}

export async function recordTrustWatchRun(
  platformDb: D1Database,
  input: RecordTrustWatchRunInput,
): Promise<TrustWatchRunRecord> {
  const createdAtMs = Math.floor(input.createdAtMs ?? Date.now());
  const id = input.id ?? generatePlatformAuditId(createdAtMs);

  await platformDb
    .prepare(
      `INSERT INTO trust_watch_runs (
         id, run_day, status, list_source_url, list_entry_count,
         checked_hosts_count, resolved_hosts_count, failed_hosts_count,
         hit_count, hits_json, failures_json, alert_sent, alert_deduplicated,
         alert_message_key, error_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.runDay,
      input.status,
      input.listSourceUrl,
      input.listEntryCount,
      input.checkedHostsCount,
      input.resolvedHostsCount,
      input.failedHostsCount,
      input.hits.length,
      JSON.stringify(input.hits),
      JSON.stringify(input.failures),
      input.alertSent ? 1 : 0,
      input.alertDeduplicated ? 1 : 0,
      input.alertMessageKey,
      input.errorCode,
      createdAtMs,
    )
    .run();

  return {
    id,
    runDay: input.runDay,
    status: input.status,
    listSourceUrl: input.listSourceUrl,
    listEntryCount: input.listEntryCount,
    checkedHostsCount: input.checkedHostsCount,
    resolvedHostsCount: input.resolvedHostsCount,
    failedHostsCount: input.failedHostsCount,
    hitCount: input.hits.length,
    hits: input.hits,
    failures: input.failures,
    alertSent: input.alertSent,
    alertDeduplicated: input.alertDeduplicated,
    alertMessageKey: input.alertMessageKey,
    errorCode: input.errorCode,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/**
 * Atomically claims the single allowed operator Trust+ hit notification slot for `runDay`.
 * Returns `claimed: true` at most once per `runDay` even under concurrent cron runs.
 */
export async function claimDailyTrustWatchAlert(
  platformDb: D1Database,
  params: {
    readonly runDay: string;
    readonly runId: string;
    readonly messageKey: string;
    readonly hits: readonly TrustWatchHostHit[];
    readonly nowMs?: number;
  },
): Promise<{ readonly claimed: boolean }> {
  const nowMs = Math.floor(params.nowMs ?? Date.now());
  const res = await platformDb
    .prepare(
      `INSERT OR IGNORE INTO trust_watch_alert_days (
         run_day, first_run_id, message_key, hit_summary_json, notified_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(params.runDay, params.runId, params.messageKey, JSON.stringify(params.hits), nowMs)
    .run();
  return { claimed: Number(res.meta?.changes ?? 0) === 1 };
}

/**
 * Releases a previously claimed daily alert slot when alert delivery fails or no delivery channel
 * is configured, preventing transient outages from silently swallowing alerts for the entire day.
 */
export async function releaseDailyTrustWatchAlert(
  platformDb: D1Database,
  runDay: string,
  runId: string,
): Promise<void> {
  await platformDb
    .prepare("DELETE FROM trust_watch_alert_days WHERE run_day = ? AND first_run_id = ?")
    .bind(runDay, runId)
    .run();
}

export async function listTrustWatchRuns(
  platformDb: D1Database,
  limit: number = 14,
): Promise<readonly TrustWatchRunRecord[]> {
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  try {
    const res = await platformDb
      .prepare(
        `SELECT id, run_day, status, list_source_url, list_entry_count,
                checked_hosts_count, resolved_hosts_count, failed_hosts_count,
                hit_count, hits_json, failures_json, alert_sent, alert_deduplicated,
                alert_message_key, error_code, created_at
         FROM trust_watch_runs
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(safeLimit)
      .all<TrustWatchRunDbRow>();
    return (res.results ?? []).map(mapTrustWatchRunRow);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) return [];
    throw err;
  }
}

export async function listActiveTenantHostsForTrustWatch(
  platformDb: D1Database,
  maxHosts: number = MAX_TRUST_WATCH_TENANT_HOSTS,
): Promise<{
  readonly hosts: readonly { readonly host: string; readonly tenantId: string }[];
  readonly hostsCapped: boolean;
}> {
  const safeMax = Math.max(1, Math.trunc(maxHosts));
  const res = await platformDb
    .prepare(
      `SELECT th.host, th.tenant_id
       FROM tenant_hosts th
       INNER JOIN tenants t ON t.id = th.tenant_id
       WHERE th.status = 'active'
         AND t.status NOT IN ('purging', 'purged')
       ORDER BY th.host ASC
       LIMIT ?`,
    )
    .bind(safeMax + 1)
    .all<{ readonly host: string; readonly tenant_id: string }>();

  const rows = res.results ?? [];
  const hostsCapped = rows.length > safeMax;
  const trimmed = hostsCapped ? rows.slice(0, safeMax) : rows;
  return {
    hosts: trimmed.map((row) => ({
      host: row.host,
      tenantId: row.tenant_id,
    })),
    hostsCapped,
  };
}

export async function listOperatorAlertEmails(platformDb: D1Database): Promise<readonly string[]> {
  const res = await platformDb
    .prepare(
      `SELECT DISTINCT lower(u.email) AS email
       FROM platform_operators po
       INNER JOIN users u ON u.id = po.user_id
       WHERE po.revoked_at IS NULL
       ORDER BY email ASC
       LIMIT 25`,
    )
    .all<{ readonly email: string }>();
  return (res.results ?? []).map((r) => r.email).filter(Boolean);
}
