import {
  evaluateEntitlementState,
  generateBillingUlid,
} from "@punyasitus/core/billing/index";
import {
  computeSelfServiceDeletionSchedule,
  EXPORT_LINK_TTL_MS,
  getJakartaDayKey,
  isEligibleTenantMediaR2Key,
  isWithinDeletionUndoWindow,
  MAX_EXPORT_ARCHIVE_BYTES,
  MAX_EXPORT_MEDIA_FILES,
  MAX_EXPORT_ROWS_PER_COLLECTION,
  MAX_EXPORT_SINGLE_MEDIA_BYTES,
  secondsUntilNextJakartaDay,
  STALE_EXPORT_PROCESSING_TIMEOUT_MS,
  type DeletionConfirmationMethod,
  type ExportLeadRowInput,
  type ExportManifest,
  type ExportMediaFileInput,
  type ExportSkippedMediaRecord,
  type ExportTruncationFlags,
  type TenantDeletionRequestStatus,
  type TenantExportJobStatus,
} from "@punyasitus/core/exports/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import { listAllLeadsForExport } from "../leads/index.ts";
import { executeTenantOffboardingPurge } from "../offboarding/repository.ts";
import { buildPlatformAuditStatement } from "../platform/audit.ts";
import { isTenantScopedR2Key } from "../privacy/retention.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";
import {
  DeletionConflictError,
  DeletionNotFoundError,
  DeletionWindowExpiredError,
  ExportConflictError,
  ExportDailyLimitError,
  type DueSelfServiceDeletionSweepResult,
  type ExecuteDueSelfServiceDeletionsInput,
  type ExportR2BucketLike,
  type TenantDeletionRequestRecord,
  type TenantDeletionStatusView,
  type TenantExportJobRecord,
} from "./types.ts";

/**
 * Platform & TenantStore repository for Owner Full-Website Export Archives and
 * Self-Service Website Deletion with 7-Day Undo Window (REQ-107, PLAN §20.4, TASK-107).
 *
 * Hard invariants:
 * - ZERO runtime DDL (schema lives strictly in `0023_tenant_exports_and_deletion.sql`).
 * - At most 1 non-failed export archive per website per Asia/Jakarta day (enforced atomically
 *   via partial unique index `tenant_export_jobs_one_per_day_idx`).
 * - Export archives are strictly scoped under `t/<tenantId>/exports/<exportId>.zip` and never
 *   include secrets, tokens, password hashes, or cross-tenant data.
 * - Self-service deletion takes the public site offline immediately (`status = 'suspended'`,
 *   `cache_version + 1`, host cache evicted), supports clean undo before the exact 7-day
 *   deadline without data loss, and after the deadline runs the existing REQ-069 purge path
 *   (`executeTenantOffboardingPurge`) while keeping billing & audit records intact (`DEC-022`).
 */

interface RawExportJobRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly requested_by_user_id: string;
  readonly request_day: string;
  readonly status: TenantExportJobStatus;
  readonly r2_key: string | null;
  readonly archive_bytes: number | null;
  readonly archive_sha256: string | null;
  readonly manifest_json: string | null;
  readonly download_token_hash: string | null;
  readonly download_expires_at: number | null;
  readonly download_count: number;
  readonly error_code: string | null;
  readonly job_idempotency_key: string | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawDeletionRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly requested_by_user_id: string;
  readonly status: TenantDeletionRequestStatus;
  readonly confirmation_method: DeletionConfirmationMethod;
  readonly reason: string | null;
  readonly deletion_requested_at: number;
  readonly deletion_due_at: number;
  readonly previous_status: "trial" | "active" | "grace" | "locked" | "suspended";
  readonly previous_deletion_due_at: number | null;
  readonly previous_cache_version: number;
  readonly canceled_at: number | null;
  readonly canceled_by_user_id: string | null;
  readonly cancel_reason: string | null;
  readonly purge_claimed_at: number | null;
  readonly purged_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawTenantRow {
  readonly id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: string;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly operator_hold_reason: string | null;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly deletion_due_at: number | null;
  readonly retention_paused_at: number | null;
  readonly offboarding_started_at: number | null;
  readonly cache_version: number;
  readonly version: number;
  readonly created_at: number;
}

function parseManifestSafe(raw: string | null): ExportManifest | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExportManifest;
  } catch {
    return null;
  }
}

function mapExportJobRow(row: RawExportJobRow, nowMs?: number): TenantExportJobRecord {
  let effectiveStatus = row.status;
  if (
    effectiveStatus === "ready" &&
    typeof row.download_expires_at === "number" &&
    typeof nowMs === "number" &&
    nowMs >= row.download_expires_at
  ) {
    effectiveStatus = "expired";
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestedByUserId: row.requested_by_user_id,
    requestDay: row.request_day,
    status: effectiveStatus,
    r2Key: row.r2_key,
    archiveBytes: row.archive_bytes,
    archiveSha256: row.archive_sha256,
    manifest: parseManifestSafe(row.manifest_json),
    downloadTokenHash: row.download_token_hash,
    downloadExpiresAtMs: row.download_expires_at,
    downloadCount: row.download_count,
    errorCode: row.error_code,
    jobIdempotencyKey: row.job_idempotency_key,
    startedAtMs: row.started_at,
    completedAtMs: row.completed_at,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

function mapDeletionRequestRow(row: RawDeletionRequestRow): TenantDeletionRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestedByUserId: row.requested_by_user_id,
    status: row.status,
    confirmationMethod: row.confirmation_method,
    reason: row.reason,
    deletionRequestedAtMs: row.deletion_requested_at,
    deletionDueAtMs: row.deletion_due_at,
    previousStatus: row.previous_status,
    previousDeletionDueAtMs: row.previous_deletion_due_at,
    previousCacheVersion: row.previous_cache_version,
    canceledAtMs: row.canceled_at,
    canceledByUserId: row.canceled_by_user_id,
    cancelReason: row.cancel_reason,
    purgeClaimedAtMs: row.purge_claimed_at,
    purgedAtMs: row.purged_at,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

async function hasTableSafe(db: D1Database, tableName: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(tableName)
    .first<{ readonly name: string }>();
  return Boolean(row);
}

async function hasColumnSafe(
  db: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const info = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{ readonly name: string }>();
  return (info.results ?? []).some((col) => col.name === columnName);
}

// ---------------------------------------------------------------------------
// 1. Export Archive Repository (1/day limit, 24h expiry, R2 cleanup)
// ---------------------------------------------------------------------------

/**
 * Atomically creates a queued full-website export job for `(tenantId, requestDay)`
 * enforcing at most 1 non-failed export per website per Asia/Jakarta calendar day.
 */
export async function requestTenantExportJob(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly requestedByUserId: string;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<TenantExportJobRecord> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const requestDay = getJakartaDayKey(nowMs);
  const retryAfterSeconds = secondsUntilNextJakartaDay(nowMs);

  const tenant = await platformDb
    .prepare("SELECT id, status FROM tenants WHERE id = ? LIMIT 1")
    .bind(input.tenantId)
    .first<{ readonly id: string; readonly status: TenantStatus }>();

  if (!tenant || tenant.status === "purged") {
    throw new ExportConflictError("NOT_FOUND", "Situs tidak ditemukan.");
  }
  if (tenant.status === "purging" || tenant.status === "provisioning" || tenant.status === "recovery") {
    throw new ExportConflictError(
      "EXPORT_NOT_AVAILABLE",
      "Ekspor tidak dapat dibuat pada status layanan situs saat ini.",
    );
  }

  const existingToday = await platformDb
    .prepare(
      `SELECT id FROM tenant_export_jobs
       WHERE tenant_id = ? AND request_day = ? AND status != 'failed'
       LIMIT 1`,
    )
    .bind(input.tenantId, requestDay)
    .first<{ readonly id: string }>();

  if (existingToday) {
    throw new ExportDailyLimitError(requestDay, retryAfterSeconds);
  }

  const exportId = `exp_${generateBillingUlid(nowMs)}`;
  const jobIdempotencyKey = `tenant-export:${input.tenantId}:${requestDay}:${exportId}`;

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.requestedByUserId,
    actorRole: "owner",
    action: "tenant.export.requested",
    targetType: "tenant_export_job",
    targetId: exportId,
    tenantId: input.tenantId,
    reason: `Owner requested full-website export archive (${requestDay})`,
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      exportId,
      requestDay,
      jobIdempotencyKey,
    },
    createdAtMs: nowMs,
  });

  try {
    await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO tenant_export_jobs (
             id, tenant_id, requested_by_user_id, request_day, status,
             job_idempotency_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .bind(
          exportId,
          input.tenantId,
          input.requestedByUserId,
          requestDay,
          jobIdempotencyKey,
          nowMs,
          nowMs,
        ),
      auditStmt,
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ExportDailyLimitError(requestDay, retryAfterSeconds);
    }
    throw err;
  }

  const created = await getTenantExportJobById(platformDb, input.tenantId, exportId, nowMs);
  if (!created) {
    throw new Error("EXPORT_JOB_CREATION_FAILED");
  }
  return created;
}

export async function listTenantExportJobs(
  platformDb: D1Database,
  tenantId: string,
  options: { readonly limit?: number; readonly nowMs?: number } = {},
): Promise<readonly TenantExportJobRecord[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const res = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, request_day, status,
              r2_key, archive_bytes, archive_sha256, manifest_json,
              download_token_hash, download_expires_at, download_count,
              error_code, job_idempotency_key, started_at, completed_at,
              created_at, updated_at
       FROM tenant_export_jobs
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(tenantId, limit)
    .all<RawExportJobRow>();

  return (res.results ?? []).map((row) => mapExportJobRow(row, nowMs));
}

export async function getTenantExportJobById(
  platformDb: D1Database,
  tenantId: string,
  exportId: string,
  nowMs?: number,
): Promise<TenantExportJobRecord | null> {
  const row = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, request_day, status,
              r2_key, archive_bytes, archive_sha256, manifest_json,
              download_token_hash, download_expires_at, download_count,
              error_code, job_idempotency_key, started_at, completed_at,
              created_at, updated_at
       FROM tenant_export_jobs
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(exportId, tenantId)
    .first<RawExportJobRow>();

  return row ? mapExportJobRow(row, nowMs) : null;
}

export async function markTenantExportJobProcessing(
  platformDb: D1Database,
  tenantId: string,
  exportId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const safeNow = Math.trunc(nowMs);
  const res = await platformDb
    .prepare(
      `UPDATE tenant_export_jobs
       SET status = 'processing',
           started_at = COALESCE(started_at, ?),
           error_code = NULL,
           updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND status = 'queued'`,
    )
    .bind(safeNow, safeNow, exportId, tenantId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function completeTenantExportJob(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly exportId: string;
    readonly actorUserId: string;
    readonly r2Key: string;
    readonly archiveBytes: number;
    readonly archiveSha256: string;
    readonly manifest: ExportManifest;
    readonly downloadTokenHash: string;
    readonly downloadExpiresAtMs?: number;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<TenantExportJobRecord> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const expiresAtMs = Math.trunc(input.downloadExpiresAtMs ?? nowMs + EXPORT_LINK_TTL_MS);

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "system_export",
      action: "tenant.export.completed",
      targetType: "tenant_export_job",
      targetId: input.exportId,
      tenantId: input.tenantId,
      reason: "Full-website export archive generated and stored in tenant R2 prefix",
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        exportId: input.exportId,
        r2Key: input.r2Key,
        archiveBytes: input.archiveBytes,
        counts: input.manifest.counts,
        truncated: input.manifest.truncated,
        downloadExpiresAtMs: expiresAtMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const batchRes = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenant_export_jobs
         SET status = 'ready',
             r2_key = ?,
             archive_bytes = ?,
             archive_sha256 = ?,
             manifest_json = ?,
             download_token_hash = ?,
             download_expires_at = ?,
             error_code = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND tenant_id = ?
           AND status = 'processing'`,
      )
      .bind(
        input.r2Key,
        Math.trunc(input.archiveBytes),
        input.archiveSha256,
        JSON.stringify(input.manifest),
        input.downloadTokenHash,
        expiresAtMs,
        nowMs,
        nowMs,
        input.exportId,
        input.tenantId,
      ),
    auditStmt,
  ]);

  if ((batchRes[0]?.meta?.changes ?? 0) !== 1) {
    throw new ExportConflictError(
      "EXPORT_JOB_STATE_CONFLICT",
      "Status pekerjaan ekspor berubah sebelum penyelesaian dan tidak dapat ditimpa.",
    );
  }

  const updated = await getTenantExportJobById(platformDb, input.tenantId, input.exportId, nowMs);
  if (!updated) {
    throw new Error("EXPORT_JOB_NOT_FOUND_AFTER_COMPLETE");
  }
  return updated;
}

export async function failTenantExportJob(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly exportId: string;
    readonly errorCode: string;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<void> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const cleanCode = sanitizeErrorCode(input.errorCode);
  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: null,
    actorRole: "system_export",
    action: "tenant.export.failed",
    targetType: "tenant_export_job",
    targetId: input.exportId,
    tenantId: input.tenantId,
    reason: `Export archive generation failed (${cleanCode})`,
    outcome: "error",
    requestId: input.requestId ?? null,
    metadata: {
      exportId: input.exportId,
      errorCode: cleanCode,
    },
    createdAtMs: nowMs,
  });

  await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenant_export_jobs
         SET status = 'failed',
             error_code = ?,
             updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('queued', 'processing')`,
      )
      .bind(cleanCode, nowMs, input.exportId, input.tenantId),
    auditStmt,
  ]);
}

export async function recordTenantExportDownload(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly exportId: string;
    readonly actorUserId: string;
    readonly tokenHash: string;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<
  | { readonly ok: true; readonly job: TenantExportJobRecord }
  | { readonly ok: false; readonly reason: "not_found" | "not_ready" | "expired" | "token_mismatch" }
> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const row = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, request_day, status,
              r2_key, archive_bytes, archive_sha256, manifest_json,
              download_token_hash, download_expires_at, download_count,
              error_code, job_idempotency_key, started_at, completed_at,
              created_at, updated_at
       FROM tenant_export_jobs
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(input.exportId, input.tenantId)
    .first<RawExportJobRow>();

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  if (row.status === "expired" || row.status === "deleted") {
    return { ok: false, reason: "expired" };
  }

  if (row.status !== "ready" || !row.r2_key || !row.download_token_hash || !row.download_expires_at) {
    return { ok: false, reason: "not_ready" };
  }

  if (nowMs >= row.download_expires_at) {
    await platformDb
      .prepare(
        `UPDATE tenant_export_jobs
         SET status = 'expired',
             updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'ready'`,
      )
      .bind(nowMs, input.exportId, input.tenantId)
      .run();
    return { ok: false, reason: "expired" };
  }

  if (row.download_token_hash !== input.tokenHash) {
    return { ok: false, reason: "token_mismatch" };
  }

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.actorUserId,
    actorRole: "owner",
    action: "tenant.export.downloaded",
    targetType: "tenant_export_job",
    targetId: input.exportId,
    tenantId: input.tenantId,
    reason: "Owner downloaded signed full-website export archive",
    outcome: "success",
    requestId: input.requestId ?? null,
    metadata: {
      exportId: input.exportId,
      archiveBytes: row.archive_bytes,
      downloadCount: row.download_count + 1,
    },
    createdAtMs: nowMs,
  });

  await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenant_export_jobs
         SET download_count = download_count + 1,
             updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'ready'`,
      )
      .bind(nowMs, input.exportId, input.tenantId),
    auditStmt,
  ]);

  return {
    ok: true,
    job: mapExportJobRow({ ...row, download_count: row.download_count + 1, updated_at: nowMs }, nowMs),
  };
}

/**
 * Cleans up expired export archives (`download_expires_at <= nowMs`):
 * deletes R2 objects strictly under `t/<tenantId>/exports/` and transitions status to `expired`/`deleted`.
 */
export async function cleanupExpiredTenantExports(
  platformDb: D1Database,
  mediaBucket: ExportR2BucketLike | null | undefined,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
): Promise<{
  readonly scanned: number;
  readonly r2ObjectsDeleted: number;
  readonly expiredRowsUpdated: number;
  readonly staleProcessingReaped: number;
}> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));

  // Reap stale `processing` jobs (> 15 minutes without update) so daily quota never stays permanently stuck.
  const staleCutoffMs = nowMs - STALE_EXPORT_PROCESSING_TIMEOUT_MS;
  const staleRes = await platformDb
    .prepare(
      `UPDATE tenant_export_jobs
       SET status = 'failed',
           error_code = 'STALE_PROCESSING_TIMEOUT',
           updated_at = ?
       WHERE status = 'processing'
         AND updated_at < ?`,
    )
    .bind(nowMs, staleCutoffMs)
    .run();
  const staleProcessingReaped = staleRes.meta?.changes ?? 0;

  const rows = await platformDb
    .prepare(
      `SELECT id, tenant_id, r2_key, status
       FROM tenant_export_jobs
       WHERE status IN ('ready', 'expired')
         AND download_expires_at IS NOT NULL
         AND download_expires_at <= ?
       ORDER BY download_expires_at ASC
       LIMIT ?`,
    )
    .bind(nowMs, limit)
    .all<{
      readonly id: string;
      readonly tenant_id: string;
      readonly r2_key: string | null;
      readonly status: TenantExportJobStatus;
    }>();

  const items = rows.results ?? [];
  let r2ObjectsDeleted = 0;
  let expiredRowsUpdated = 0;

  for (const item of items) {
    if (
      mediaBucket &&
      item.r2_key &&
      isTenantScopedR2Key(item.tenant_id, item.r2_key) &&
      item.r2_key.startsWith(`t/${item.tenant_id}/exports/`)
    ) {
      await mediaBucket.delete(item.r2_key);
      r2ObjectsDeleted += 1;
    }

    const res = await platformDb
      .prepare(
        `UPDATE tenant_export_jobs
         SET status = 'deleted',
             r2_key = NULL,
             download_token_hash = NULL,
             updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(nowMs, item.id, item.tenant_id)
      .run();
    expiredRowsUpdated += res.meta?.changes ?? 0;
  }

  return {
    scanned: items.length,
    r2ObjectsDeleted,
    expiredRowsUpdated,
    staleProcessingReaped,
  };
}

// ---------------------------------------------------------------------------
// 2. TenantStore Data Collector (strictly scoped to single tenant DO + R2 prefix)
// ---------------------------------------------------------------------------

export interface CollectedTenantExportData {
  readonly siteSettings: Record<string, unknown> | null;
  readonly businessProfile: Record<string, unknown> | null;
  readonly pages: readonly Record<string, unknown>[];
  readonly posts: readonly Record<string, unknown>[];
  readonly offerings: readonly Record<string, unknown>[];
  readonly leads: readonly ExportLeadRowInput[];
  readonly mediaFiles: readonly ExportMediaFileInput[];
  readonly skippedMedia: readonly ExportSkippedMediaRecord[];
  readonly truncated: ExportTruncationFlags;
}

function parseJsonColumnSafe(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Extracts all exportable website content (`site_settings`, `business_profile`,
 * `pages`, `posts`, `offerings`, `leads`, and `media_items` binaries from R2)
 * strictly from ONE verified tenant's isolated `TenantStore` and `t/<tenantId>/` R2 prefix.
 */
export async function collectTenantDataForExport(input: {
  readonly tenantId: string;
  readonly tenantDb: D1Database;
  readonly mediaBucket?: ExportR2BucketLike | null;
  readonly maxRowsPerCollection?: number;
  readonly maxMediaFiles?: number;
  readonly maxSingleMediaBytes?: number;
  readonly maxArchiveBytes?: number;
}): Promise<CollectedTenantExportData> {
  const maxRows = Math.max(
    1,
    Math.min(MAX_EXPORT_ROWS_PER_COLLECTION, Math.trunc(input.maxRowsPerCollection ?? MAX_EXPORT_ROWS_PER_COLLECTION)),
  );
  const maxMediaFiles = Math.max(0, Math.trunc(input.maxMediaFiles ?? MAX_EXPORT_MEDIA_FILES));
  const maxSingleMediaBytes = Math.max(
    1024,
    Math.trunc(input.maxSingleMediaBytes ?? MAX_EXPORT_SINGLE_MEDIA_BYTES),
  );
  const maxArchiveBytes = Math.max(
    16_384,
    Math.trunc(input.maxArchiveBytes ?? MAX_EXPORT_ARCHIVE_BYTES),
  );

  const [siteRow, bizRow, pagesRes, postsRes, offeringsRes, leadsExport, mediaRes] =
    await Promise.all([
      input.tenantDb
        .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
        .first<Record<string, unknown>>()
        .catch(() => null),
      input.tenantDb
        .prepare("SELECT * FROM business_profile WHERE id = 1 LIMIT 1")
        .first<Record<string, unknown>>()
        .catch(() => null),
      input.tenantDb
        .prepare(
          `SELECT id, slug, title, is_homepage, draft_sections_json, published_sections_json,
                  seo_json, status, published_at, content_modified_at, version, created_at, updated_at
           FROM pages
           WHERE deleted_at IS NULL
           ORDER BY id ASC
           LIMIT ?`,
        )
        .bind(maxRows + 1)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] })),
      input.tenantDb
        .prepare(
          `SELECT id, slug, title, excerpt, draft_body_json, published_body_json,
                  primary_category_id, author_id, cover_media_id, reading_time_minutes,
                  show_toc, seo_json, status, published_at, content_modified_at, version,
                  created_at, updated_at
           FROM posts
           WHERE deleted_at IS NULL
           ORDER BY id ASC
           LIMIT ?`,
        )
        .bind(maxRows + 1)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] })),
      input.tenantDb
        .prepare(
          `SELECT id, offering_type, slug, title, summary, description, cover_media_id,
                  gallery_media_ids_json, video_media_id, youtube_video_id, price_mode,
                  price, price_max, negotiable, original_amount, badge, cta_mode,
                  external_url, unit_status, attributes_version, attributes_json,
                  draft_snapshot_json, published_snapshot_json, seo_json, status,
                  published_at, content_modified_at, version, created_at, updated_at
           FROM offerings
           WHERE deleted_at IS NULL
           ORDER BY id ASC
           LIMIT ?`,
        )
        .bind(maxRows + 1)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] })),
      listAllLeadsForExport(input.tenantDb, { maxRows }).catch(() => ({
        leads: [],
        truncated: false,
      })),
      input.tenantDb
        .prepare(
          `SELECT id, kind, r2_key, mime_type, bytes, sha256, alt_text, status
           FROM media_items
           WHERE status = 'ready'
           ORDER BY id ASC
           LIMIT ?`,
        )
        .bind(maxMediaFiles + 1)
        .all<{
          readonly id: number;
          readonly kind: string;
          readonly r2_key: string;
          readonly mime_type: string;
          readonly bytes: number;
          readonly sha256: string;
          readonly alt_text: string;
          readonly status: string;
        }>()
        .catch(() => ({ results: [] })),
    ]);

  const rawPages = pagesRes.results ?? [];
  const pagesTruncated = rawPages.length > maxRows;
  const pages = rawPages.slice(0, maxRows).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    isHomepage: Number(row.is_homepage ?? 0) === 1,
    draftSections: parseJsonColumnSafe(row.draft_sections_json) ?? [],
    publishedSections: parseJsonColumnSafe(row.published_sections_json),
    seo: parseJsonColumnSafe(row.seo_json),
    status: row.status,
    publishedAt: row.published_at ?? null,
    contentModifiedAt: row.content_modified_at ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const rawPosts = postsRes.results ?? [];
  const postsTruncated = rawPosts.length > maxRows;
  const posts = rawPosts.slice(0, maxRows).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt ?? null,
    draftBody: parseJsonColumnSafe(row.draft_body_json),
    publishedBody: parseJsonColumnSafe(row.published_body_json),
    primaryCategoryId: row.primary_category_id ?? null,
    authorId: row.author_id ?? null,
    coverMediaId: row.cover_media_id ?? null,
    readingTimeMinutes: row.reading_time_minutes ?? 1,
    showToc: Number(row.show_toc ?? 0) === 1,
    seo: parseJsonColumnSafe(row.seo_json),
    status: row.status,
    publishedAt: row.published_at ?? null,
    contentModifiedAt: row.content_modified_at ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const rawOfferings = offeringsRes.results ?? [];
  const offeringsTruncated = rawOfferings.length > maxRows;
  const offerings = rawOfferings.slice(0, maxRows).map((row) => ({
    id: row.id,
    offeringType: row.offering_type,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? null,
    description: row.description ?? null,
    coverMediaId: row.cover_media_id ?? null,
    galleryMediaIds: parseJsonColumnSafe(row.gallery_media_ids_json) ?? [],
    videoMediaId: row.video_media_id ?? null,
    youtubeVideoId: row.youtube_video_id ?? null,
    priceMode: row.price_mode,
    price: row.price ?? null,
    priceMax: row.price_max ?? null,
    negotiable: Number(row.negotiable ?? 0) === 1,
    originalAmount: row.original_amount ?? null,
    badge: row.badge ?? null,
    ctaMode: row.cta_mode,
    externalUrl: row.external_url ?? null,
    unitStatus: row.unit_status ?? null,
    attributesVersion: row.attributes_version ?? 1,
    attributes: parseJsonColumnSafe(row.attributes_json) ?? {},
    draftSnapshot: parseJsonColumnSafe(row.draft_snapshot_json),
    publishedSnapshot: parseJsonColumnSafe(row.published_snapshot_json),
    seo: parseJsonColumnSafe(row.seo_json),
    status: row.status,
    publishedAt: row.published_at ?? null,
    contentModifiedAt: row.content_modified_at ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const leads: ExportLeadRowInput[] = leadsExport.leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    message: lead.message,
    status: lead.status,
    preferredDate: lead.preferredDate,
    preferredTime: lead.preferredTime,
    branchId: lead.branchId,
    sourceCategory: lead.sourceCategory,
    pagePath: lead.pagePath,
    utm: lead.utm
      ? Object.fromEntries(
          Object.entries(lead.utm).filter(([, v]) => typeof v === "string") as [string, string][],
        )
      : null,
    internalNotes: lead.internalNotes,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  }));

  const mediaFiles: ExportMediaFileInput[] = [];
  const skippedMedia: ExportSkippedMediaRecord[] = [];
  let loadedMediaBytes = 0;

  for (const item of mediaRes.results ?? []) {
    if (!isEligibleTenantMediaR2Key(input.tenantId, item.r2_key)) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "outside_tenant_prefix",
      });
      continue;
    }
    if (mediaFiles.length >= maxMediaFiles) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "max_files_reached",
      });
      continue;
    }
    if (item.bytes > maxSingleMediaBytes) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "single_file_too_large",
      });
      continue;
    }
    if (loadedMediaBytes + item.bytes > maxArchiveBytes) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "archive_budget_exceeded",
      });
      continue;
    }
    if (!input.mediaBucket) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "missing_r2_object",
      });
      continue;
    }

    const obj = await input.mediaBucket.get(item.r2_key);
    if (!obj) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "missing_r2_object",
      });
      continue;
    }
    const data = new Uint8Array(await obj.arrayBuffer());
    if (data.byteLength > maxSingleMediaBytes) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "single_file_too_large",
      });
      continue;
    }
    if (loadedMediaBytes + data.byteLength > maxArchiveBytes) {
      skippedMedia.push({
        id: item.id,
        r2Key: item.r2_key,
        reason: "archive_budget_exceeded",
      });
      continue;
    }
    loadedMediaBytes += data.byteLength;
    mediaFiles.push({
      id: item.id,
      r2Key: item.r2_key,
      mimeType: item.mime_type,
      bytes: data.byteLength,
      sha256: item.sha256,
      altText: item.alt_text,
      data,
    });
  }

  const rawMedia = mediaRes.results ?? [];
  const mediaListTruncated = rawMedia.length > maxMediaFiles;
  const mediaTruncated =
    mediaListTruncated ||
    skippedMedia.some(
      (s) =>
        s.reason === "max_files_reached" ||
        s.reason === "single_file_too_large" ||
        s.reason === "archive_budget_exceeded",
    );
  const leadsTruncated = Boolean(leadsExport.truncated);

  return {
    siteSettings: siteRow ?? null,
    businessProfile: bizRow ?? null,
    pages,
    posts,
    offerings,
    leads,
    mediaFiles,
    skippedMedia,
    truncated: {
      pages: pagesTruncated,
      posts: postsTruncated,
      offerings: offeringsTruncated,
      leads: leadsTruncated,
      media: mediaTruncated,
      any:
        pagesTruncated ||
        postsTruncated ||
        offeringsTruncated ||
        leadsTruncated ||
        mediaTruncated,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Self-Service Deletion with 7-Day Undo Window & REQ-069 Purge Handoff
// ---------------------------------------------------------------------------

export async function getTenantDeletionStatus(
  platformDb: D1Database,
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<TenantDeletionStatusView | null> {
  const safeNow = Math.trunc(nowMs);
  const tenant = await platformDb
    .prepare(
      `SELECT id, organization_id, handle, name, vertical, status,
              operator_hold, operator_hold_reason, trial_ends_at, paid_through,
              deletion_due_at, retention_paused_at, offboarding_started_at,
              cache_version, version, created_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<RawTenantRow>();

  if (!tenant) return null;

  let activeRequest: TenantDeletionRequestRecord | null = null;
  let latestRequest: TenantDeletionRequestRecord | null = null;

  if (await hasTableSafe(platformDb, "tenant_deletion_requests")) {
    const activeRow = await platformDb
      .prepare(
        `SELECT id, tenant_id, requested_by_user_id, status, confirmation_method,
                reason, deletion_requested_at, deletion_due_at, previous_status,
                previous_deletion_due_at, previous_cache_version, canceled_at,
                canceled_by_user_id, cancel_reason, purge_claimed_at, purged_at,
                created_at, updated_at
         FROM tenant_deletion_requests
         WHERE tenant_id = ? AND status IN ('scheduled', 'purging')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<RawDeletionRequestRow>();
    activeRequest = activeRow ? mapDeletionRequestRow(activeRow) : null;

    const latestRow = activeRow
      ? activeRow
      : await platformDb
          .prepare(
            `SELECT id, tenant_id, requested_by_user_id, status, confirmation_method,
                    reason, deletion_requested_at, deletion_due_at, previous_status,
                    previous_deletion_due_at, previous_cache_version, canceled_at,
                    canceled_by_user_id, cancel_reason, purge_claimed_at, purged_at,
                    created_at, updated_at
             FROM tenant_deletion_requests
             WHERE tenant_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
          )
          .bind(tenantId)
          .first<RawDeletionRequestRow>();
    latestRequest = latestRow ? mapDeletionRequestRow(latestRow) : null;
  }

  const operatorHold = Number(tenant.operator_hold) === 1 || tenant.retention_paused_at !== null;
  const canRequestDeletion =
    !operatorHold &&
    !activeRequest &&
    (tenant.status === "trial" ||
      tenant.status === "active" ||
      tenant.status === "grace" ||
      tenant.status === "locked" ||
      tenant.status === "suspended");

  const remainingUndoMs =
    activeRequest && activeRequest.status === "scheduled"
      ? Math.max(0, activeRequest.deletionDueAtMs - safeNow)
      : 0;

  const canCancelDeletion =
    !operatorHold &&
    activeRequest !== null &&
    activeRequest.status === "scheduled" &&
    tenant.status !== "purging" &&
    tenant.status !== "purged" &&
    tenant.offboarding_started_at === null &&
    isWithinDeletionUndoWindow(activeRequest.deletionDueAtMs, safeNow);

  return {
    tenantId: tenant.id,
    tenantHandle: tenant.handle,
    tenantStatus: tenant.status,
    operatorHold,
    operatorHoldReason: tenant.operator_hold_reason,
    activeRequest,
    latestRequest,
    canRequestDeletion,
    canCancelDeletion,
    remainingUndoMs,
  };
}

/**
 * Atomically schedules owner self-service website deletion with a 7-day undo window:
 * - Takes the public site offline AT ONCE (`tenants.status = 'suspended'`, `cache_version + 1`,
 *   evicts host resolution cache so the very next public request returns neutral HTTP 503).
 * - Persists `tenant_deletion_requests` (`status = 'scheduled'`, `deletion_requested_at = nowMs`,
 *   `deletion_due_at = nowMs + 7d`) and `platform_audit` atomically in one D1 batch.
 */
export async function requestTenantSelfServiceDeletion(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly requestedByUserId: string;
    readonly confirmationMethod: DeletionConfirmationMethod;
    readonly reason?: string | null;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<TenantDeletionRequestRecord> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenant = await platformDb
    .prepare(
      `SELECT id, organization_id, handle, name, vertical, status,
              operator_hold, operator_hold_reason, trial_ends_at, paid_through,
              deletion_due_at, retention_paused_at, offboarding_started_at,
              cache_version, version, created_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<RawTenantRow>();

  if (!tenant || tenant.status === "purged") {
    throw new DeletionConflictError("NOT_FOUND", "Situs tidak ditemukan.");
  }

  if (Number(tenant.operator_hold) === 1 || tenant.retention_paused_at !== null) {
    throw new DeletionConflictError(
      "OPERATOR_HOLD_ACTIVE",
      "Situs sedang dalam peninjauan kepatuhan operator. Hubungi dukungan untuk memproses penghapusan.",
    );
  }

  if (
    tenant.status === "purging" ||
    tenant.status === "provisioning" ||
    tenant.status === "recovery" ||
    tenant.offboarding_started_at !== null
  ) {
    throw new DeletionConflictError(
      "DELETION_NOT_ALLOWED_IN_STATE",
      `Penghapusan mandiri tidak dapat dimulai saat status situs "${tenant.status}".`,
    );
  }

  const existingActive = await platformDb
    .prepare(
      `SELECT id FROM tenant_deletion_requests
       WHERE tenant_id = ? AND status IN ('scheduled', 'purging')
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<{ readonly id: string }>();

  if (existingActive) {
    throw new DeletionConflictError(
      "DELETION_ALREADY_SCHEDULED",
      "Penghapusan situs ini sudah dijadwalkan dan masih dalam masa pembatalan 7 hari.",
    );
  }

  const schedule = computeSelfServiceDeletionSchedule(nowMs);
  const deletionRequestId = `del_${generateBillingUlid(nowMs)}`;
  const previousStatus = tenant.status;
  const cleanReason = input.reason?.trim() ? input.reason.trim() : null;

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.requestedByUserId,
      actorRole: "owner",
      action: "tenant.deletion.requested",
      targetType: "tenant",
      targetId: tenant.id,
      tenantId: tenant.id,
      reason: cleanReason ?? "Owner initiated self-service website deletion (7-day undo window)",
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        deletionRequestId,
        confirmationMethod: input.confirmationMethod,
        previousStatus,
        deletionRequestedAtMs: schedule.deletionRequestedAtMs,
        deletionDueAtMs: schedule.deletionDueAtMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const batchResults = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenants
         SET status = 'suspended',
             deletion_due_at = ?,
             cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND operator_hold = 0
           AND retention_paused_at IS NULL
           AND offboarding_started_at IS NULL
           AND status IN ('trial', 'active', 'grace', 'locked', 'suspended')`,
      )
      .bind(schedule.deletionDueAtMs, nowMs, tenant.id, tenant.version),
    platformDb
      .prepare(
        `INSERT INTO tenant_deletion_requests (
           id, tenant_id, requested_by_user_id, status, confirmation_method,
           reason, deletion_requested_at, deletion_due_at, previous_status,
           previous_deletion_due_at, previous_cache_version, created_at, updated_at
         )
         SELECT ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        deletionRequestId,
        tenant.id,
        input.requestedByUserId,
        input.confirmationMethod,
        cleanReason,
        schedule.deletionRequestedAtMs,
        schedule.deletionDueAtMs,
        previousStatus,
        tenant.deletion_due_at,
        tenant.cache_version,
        nowMs,
        nowMs,
      ),
    auditStmt,
  ]);

  if ((batchResults[0]?.meta?.changes ?? 0) !== 1) {
    throw new DeletionConflictError(
      "CONCURRENT_MODIFICATION",
      "Status situs berubah secara bersamaan. Muat ulang halaman dan coba lagi.",
    );
  }

  evictTenantFromCache(tenant.id);

  const created = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, status, confirmation_method,
              reason, deletion_requested_at, deletion_due_at, previous_status,
              previous_deletion_due_at, previous_cache_version, canceled_at,
              canceled_by_user_id, cancel_reason, purge_claimed_at, purged_at,
              created_at, updated_at
       FROM tenant_deletion_requests
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(deletionRequestId)
    .first<RawDeletionRequestRow>();

  if (!created) {
    throw new DeletionConflictError(
      "CONCURRENT_MODIFICATION",
      "Gagal mencatat permintaan penghapusan situs.",
    );
  }

  return mapDeletionRequestRow(created);
}

/**
 * Atomically cancels an active self-service deletion request before the 7-day deadline,
 * restoring service cleanly without any data loss while preserving accurate commercial entitlement.
 */
export async function cancelTenantSelfServiceDeletion(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly canceledByUserId: string;
    readonly cancelReason?: string | null;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<{
  readonly request: TenantDeletionRequestRecord;
  readonly restoredStatus: TenantStatus;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenant = await platformDb
    .prepare(
      `SELECT id, organization_id, handle, name, vertical, status,
              operator_hold, operator_hold_reason, trial_ends_at, paid_through,
              deletion_due_at, retention_paused_at, offboarding_started_at,
              cache_version, version, created_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<RawTenantRow>();

  if (!tenant || tenant.status === "purged") {
    throw new DeletionNotFoundError("Situs tidak ditemukan.");
  }

  const activeReq = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, status, confirmation_method,
              reason, deletion_requested_at, deletion_due_at, previous_status,
              previous_deletion_due_at, previous_cache_version, canceled_at,
              canceled_by_user_id, cancel_reason, purge_claimed_at, purged_at,
              created_at, updated_at
       FROM tenant_deletion_requests
       WHERE tenant_id = ? AND status IN ('scheduled', 'purging')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<RawDeletionRequestRow>();

  if (!activeReq) {
    throw new DeletionNotFoundError();
  }

  if (
    activeReq.status === "purging" ||
    tenant.status === "purging" ||
    tenant.offboarding_started_at !== null ||
    !isWithinDeletionUndoWindow(activeReq.deletion_due_at, nowMs)
  ) {
    throw new DeletionWindowExpiredError();
  }

  if (Number(tenant.operator_hold) === 1 || tenant.retention_paused_at !== null) {
    throw new DeletionConflictError(
      "OPERATOR_HOLD_ACTIVE",
      "Situs sedang ditahan oleh operator sehingga belum dapat diaktifkan kembali secara mandiri.",
    );
  }

  // Re-evaluate commercial entitlement at `nowMs` using saved `previous_status` so undo restores
  // live service cleanly without accidentally extending an expired trial or paid cycle.
  const evaluated = evaluateEntitlementState({
    storedStatus: activeReq.previous_status,
    operatorHold: false,
    trialEndsAtMs: tenant.trial_ends_at,
    paidThroughMs: tenant.paid_through,
    createdAtMs: tenant.created_at,
    deletionDueAtMs: activeReq.previous_deletion_due_at,
    nowMs,
  });
  const restoredStatus: TenantStatus = evaluated.effectiveStatus;
  const cleanCancelReason = input.cancelReason?.trim() ? input.cancelReason.trim() : null;

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.canceledByUserId,
      actorRole: "owner",
      action: "tenant.deletion.canceled",
      targetType: "tenant",
      targetId: tenant.id,
      tenantId: tenant.id,
      reason: cleanCancelReason ?? "Owner canceled self-service website deletion within 7-day undo window",
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        deletionRequestId: activeReq.id,
        restoredStatus,
        deletionDueAtMs: activeReq.deletion_due_at,
        canceledAtMs: nowMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE tenants
         SET status = ?,
             deletion_due_at = ?,
             cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND status NOT IN ('purging', 'purged')
           AND operator_hold = 0
           AND offboarding_started_at IS NULL`,
      )
      .bind(restoredStatus, activeReq.previous_deletion_due_at, nowMs, tenant.id, tenant.version),
    platformDb
      .prepare(
        `UPDATE tenant_deletion_requests
         SET status = 'canceled',
             canceled_at = ?,
             canceled_by_user_id = ?,
             cancel_reason = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'scheduled'
           AND deletion_due_at > ?
           AND changes() = 1`,
      )
      .bind(
        nowMs,
        input.canceledByUserId,
        cleanCancelReason,
        nowMs,
        activeReq.id,
        nowMs,
      ),
    auditStmt,
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new DeletionWindowExpiredError(
      "Penghapusan tidak dapat dibatalkan karena masa pembatalan telah berakhir atau status berubah.",
    );
  }

  evictTenantFromCache(tenant.id);

  const updated = await platformDb
    .prepare(
      `SELECT id, tenant_id, requested_by_user_id, status, confirmation_method,
              reason, deletion_requested_at, deletion_due_at, previous_status,
              previous_deletion_due_at, previous_cache_version, canceled_at,
              canceled_by_user_id, cancel_reason, purge_claimed_at, purged_at,
              created_at, updated_at
       FROM tenant_deletion_requests
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(activeReq.id)
    .first<RawDeletionRequestRow>();

  return {
    request: updated ? mapDeletionRequestRow(updated) : mapDeletionRequestRow({
      ...activeReq,
      status: "canceled",
      canceled_at: nowMs,
      canceled_by_user_id: input.canceledByUserId,
      cancel_reason: cleanCancelReason,
      updated_at: nowMs,
    }),
    restoredStatus,
  };
}

/**
 * Atomically claims a due self-service deletion (`status = 'scheduled'` AND `nowMs >= deletion_due_at`)
 * into `tenants.status = 'purging'` + `tenant_offboarding_runs` so the existing REQ-069 purge path
 * (`executeTenantOffboardingPurge`) executes cleanly even if the tenant had remaining paid/trial time.
 */
export async function claimSelfServiceDeletionForOffboarding(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly nowMs?: number;
    readonly requestId?: string | null;
  },
): Promise<
  | { readonly claimed: true; readonly requestId: string; readonly tenantId: string }
  | { readonly claimed: false; readonly reason: string }
> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const reqRow = await platformDb
    .prepare(
      `SELECT id, tenant_id, status, deletion_due_at
       FROM tenant_deletion_requests
       WHERE tenant_id = ? AND status IN ('scheduled', 'purging')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<{
      readonly id: string;
      readonly tenant_id: string;
      readonly status: TenantDeletionRequestStatus;
      readonly deletion_due_at: number;
    }>();

  if (!reqRow) {
    return { claimed: false, reason: "no_active_deletion_request" };
  }
  if (reqRow.status === "purging") {
    return { claimed: true, requestId: reqRow.id, tenantId: reqRow.tenant_id };
  }
  if (nowMs < reqRow.deletion_due_at) {
    return { claimed: false, reason: "within_undo_window" };
  }

  const tenant = await platformDb
    .prepare(
      `SELECT id, handle, status, operator_hold, retention_paused_at,
              offboarding_started_at, version
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly status: TenantStatus;
      readonly operator_hold: number;
      readonly retention_paused_at: number | null;
      readonly offboarding_started_at: number | null;
      readonly version: number;
    }>();

  if (!tenant) {
    return { claimed: false, reason: "not_found" };
  }
  if (tenant.status === "purged") {
    return { claimed: false, reason: "already_purged" };
  }
  if (tenant.status === "purging" && tenant.offboarding_started_at !== null) {
    return { claimed: true, requestId: reqRow.id, tenantId: tenant.id };
  }
  if (Number(tenant.operator_hold) === 1 || tenant.retention_paused_at !== null) {
    return { claimed: false, reason: "operator_hold" };
  }

  const hasLifecycleCol = await hasColumnSafe(platformDb, "payment_attempts", "lifecycle_state");
  const hasReviewCol = await hasColumnSafe(platformDb, "billing_obligations", "review_required");
  const hasRunsTable = await hasTableSafe(platformDb, "tenant_offboarding_runs");

  const unresolvedSql = hasLifecycleCol
    ? `SELECT 1 AS hit FROM payment_attempts
       WHERE tenant_id = ? AND lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       LIMIT 1`
    : `SELECT 1 AS hit FROM payment_attempts
       WHERE tenant_id = ? AND state IN ('initiated', 'pending')
       LIMIT 1`;

  const [unresolvedAttempt, reviewObligation] = await Promise.all([
    platformDb.prepare(unresolvedSql).bind(tenant.id).first<{ readonly hit: number }>(),
    hasReviewCol
      ? platformDb
          .prepare(
            "SELECT 1 AS hit FROM billing_obligations WHERE tenant_id = ? AND review_required = 1 LIMIT 1",
          )
          .bind(tenant.id)
          .first<{ readonly hit: number }>()
      : Promise.resolve(null),
  ]);

  if (unresolvedAttempt) {
    return { claimed: false, reason: "unresolved_payment_attempt" };
  }
  if (reviewObligation) {
    return { claimed: false, reason: "review_required_obligation" };
  }

  const notExistsAttemptPredicate = hasLifecycleCol
    ? `AND NOT EXISTS (
         SELECT 1 FROM payment_attempts pa
         WHERE pa.tenant_id = tenants.id
           AND pa.lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       )`
    : `AND NOT EXISTS (
         SELECT 1 FROM payment_attempts pa
         WHERE pa.tenant_id = tenants.id
           AND pa.state IN ('initiated', 'pending')
       )`;

  const notExistsReviewPredicate = hasReviewCol
    ? `AND NOT EXISTS (
         SELECT 1 FROM billing_obligations bo
         WHERE bo.tenant_id = tenants.id
           AND bo.review_required = 1
       )`
    : "";

  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: null,
      actorRole: "system_offboarding",
      action: "tenant.deletion.purge_claimed",
      targetType: "tenant",
      targetId: tenant.id,
      tenantId: tenant.id,
      reason: "Owner self-service deletion undo window elapsed; claimed for REQ-069 purge",
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        deletionRequestId: reqRow.id,
        deletionDueAtMs: reqRow.deletion_due_at,
        claimedAtMs: nowMs,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const stmts: D1PreparedStatement[] = [
    platformDb
      .prepare(
        `UPDATE tenants
         SET status = 'purging',
             offboarding_started_at = ?,
             deletion_due_at = ?,
             cache_version = cache_version + 1,
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND version = ?
           AND status NOT IN ('purging', 'purged')
           AND operator_hold = 0
           AND retention_paused_at IS NULL
           AND offboarding_started_at IS NULL
           ${notExistsAttemptPredicate}
           ${notExistsReviewPredicate}`,
      )
      .bind(nowMs, reqRow.deletion_due_at, nowMs, tenant.id, tenant.version),
    platformDb
      .prepare(
        `UPDATE tenant_deletion_requests
         SET status = 'purging',
             purge_claimed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'scheduled'
           AND deletion_due_at <= ?
           AND changes() = 1`,
      )
      .bind(nowMs, nowMs, reqRow.id, nowMs),
  ];

  if (hasRunsTable) {
    stmts.push(
      platformDb
        .prepare(
          `INSERT OR IGNORE INTO tenant_offboarding_runs (
             tenant_id, status, claimed_at, deletion_due_at, original_handle,
             attempts, updated_at
           )
           SELECT ?, 'claimed', ?, ?, ?, 1, ?
           WHERE changes() = 1`,
        )
        .bind(tenant.id, nowMs, reqRow.deletion_due_at, tenant.handle, nowMs),
    );
  }
  stmts.push(auditStmt);

  const batchRes = await platformDb.batch(stmts);
  if ((batchRes[0]?.meta?.changes ?? 0) !== 1) {
    return { claimed: false, reason: "concurrent_conflict" };
  }

  evictTenantFromCache(tenant.id);
  return { claimed: true, requestId: reqRow.id, tenantId: tenant.id };
}

/**
 * Sweeps due self-service deletion requests (`nowMs >= deletion_due_at`) and executes
 * the existing serialized, resumable REQ-069 purge path (`executeTenantOffboardingPurge`),
 * keeping billing obligations, settlements, receipts, and immutable `platform_audit` rows intact.
 */
export async function executeDueSelfServiceDeletionPurges(
  input: ExecuteDueSelfServiceDeletionsInput,
): Promise<DueSelfServiceDeletionSweepResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));

  if (!(await hasTableSafe(input.platformDb, "tenant_deletion_requests"))) {
    return {
      evaluatedAtMs: nowMs,
      scannedRequests: 0,
      claimedCount: 0,
      purgedCount: 0,
      blockedCount: 0,
      failedCount: 0,
      outcomes: [],
    };
  }

  const clauses = ["status IN ('scheduled', 'purging')", "deletion_due_at <= ?"];
  const bindings: (string | number)[] = [nowMs];
  if (input.tenantId) {
    clauses.push("tenant_id = ?");
    bindings.push(input.tenantId);
  }
  bindings.push(limit);

  const dueRows = await input.platformDb
    .prepare(
      `SELECT id, tenant_id, status, deletion_due_at
       FROM tenant_deletion_requests
       WHERE ${clauses.join(" AND ")}
       ORDER BY deletion_due_at ASC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{
      readonly id: string;
      readonly tenant_id: string;
      readonly status: TenantDeletionRequestStatus;
      readonly deletion_due_at: number;
    }>();

  const items = dueRows.results ?? [];
  let claimedCount = 0;
  let purgedCount = 0;
  let blockedCount = 0;
  let failedCount = 0;
  const outcomes: DueSelfServiceDeletionSweepResult["outcomes"][number][] = [];

  for (const item of items) {
    if (item.status === "scheduled") {
      const claim = await claimSelfServiceDeletionForOffboarding(input.platformDb, {
        tenantId: item.tenant_id,
        nowMs,
        requestId: input.requestId,
      });
      if (!claim.claimed) {
        blockedCount += 1;
        outcomes.push({
          requestId: item.id,
          tenantId: item.tenant_id,
          outcome: "blocked",
          blockReason: claim.reason,
          errorCode: null,
          purgeResult: null,
        });
        continue;
      }
      claimedCount += 1;
    }

    try {
      const purgeResult = await executeTenantOffboardingPurge({
        platformDb: input.platformDb,
        tenantId: item.tenant_id,
        mediaBucket: input.mediaBucket,
        tenantStoreNamespace: input.tenantStoreNamespace,
        cloudflareClient: input.cloudflareClient,
        nowMs,
        requestId: input.requestId,
        reason: "REQ-107 owner self-service deletion purge after 7-day undo window",
      });

      if (purgeResult.outcome === "purged" || purgeResult.outcome === "already_purged") {
        await input.platformDb
          .prepare(
            `UPDATE tenant_deletion_requests
             SET status = 'purged',
                 purged_at = COALESCE(purged_at, ?),
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(nowMs, nowMs, item.id)
          .run();

        if (purgeResult.outcome === "purged") {
          purgedCount += 1;
        }
        outcomes.push({
          requestId: item.id,
          tenantId: item.tenant_id,
          outcome: purgeResult.outcome,
          blockReason: null,
          errorCode: null,
          purgeResult,
        });
      } else {
        blockedCount += 1;
        outcomes.push({
          requestId: item.id,
          tenantId: item.tenant_id,
          outcome: "blocked",
          blockReason: "not_claimed",
          errorCode: null,
          purgeResult,
        });
      }
    } catch (err) {
      failedCount += 1;
      outcomes.push({
        requestId: item.id,
        tenantId: item.tenant_id,
        outcome: "failed",
        blockReason: null,
        errorCode: sanitizeErrorCode(err),
        purgeResult: null,
      });
    }
  }

  return {
    evaluatedAtMs: nowMs,
    scannedRequests: items.length,
    claimedCount,
    purgedCount,
    blockedCount,
    failedCount,
    outcomes,
  };
}
