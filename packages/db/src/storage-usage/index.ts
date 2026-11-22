import type { TenantStatus } from "@punyasitus/core/schemas";
import { ensureMediaPipelineSchema } from "./migrations.ts";

export {
  MEDIA_PIPELINE_MIGRATION,
  MEDIA_PIPELINE_MIGRATION_SQL,
  ensureMediaPipelineSchema,
} from "./migrations.ts";

/**
 * Atomic per-tenant storage quota & upload rate limiter (REQ-064; PLAN §7.2).
 *
 * Canonical quota ceilings (PLAN §7.2):
 * - Trial: 100 MB = 100,000,000 bytes
 * - Paid / Grace / Locked: 1 GB = 1,000,000,000 bytes
 * - Upload intent rate limits: 50 intents / rolling hour AND 200 intents / rolling day
 *
 * Invariants:
 * - `used_bytes + reserved_bytes + incoming_bytes <= quota_bytes` passes at exact limit
 *   and fails at +1 byte with `STORAGE_QUOTA_EXCEEDED`.
 * - Single atomic SQLite conditional `UPDATE ... WHERE` inside `TenantStore` ensures
 *   parallel upload intents can never exceed quota or rate caps.
 * - Expired `pending_upload` intents AND stale `uploaded`/`processing` intents older than
 *   `STALE_PROCESSING_TTL_MS` are reaped atomically, freeing `reserved_bytes`.
 * - Trashed (`deleted_at IS NOT NULL`) media continues counting in `used_bytes` until purged.
 */

export const TRIAL_STORAGE_QUOTA_BYTES = 100_000_000 as const; // 100 MB (PLAN §7.2)
export const PAID_STORAGE_QUOTA_BYTES = 1_000_000_000 as const; // 1 GB (PLAN §7.2)

export const MEDIA_UPLOAD_HOURLY_LIMIT = 50 as const;
export const MEDIA_UPLOAD_DAILY_LIMIT = 200 as const;
export const MEDIA_UPLOAD_HOUR_WINDOW_MS = 60 * 60 * 1000;
export const MEDIA_UPLOAD_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const STALE_PROCESSING_TTL_MS = 15 * 60 * 1000; // 15 minutes for stuck uploaded/processing jobs

export interface StorageUsageSnapshot {
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly quotaBytes: number;
  readonly availableBytes: number;
  readonly percentUsed: number;
  readonly warningAt80: boolean;
  readonly hourlyUploads: number;
  readonly hourlyWindowStart: number;
  readonly dailyUploads: number;
  readonly dailyWindowStart: number;
  readonly updatedAt: number;
}

interface StorageUsageRow {
  readonly used_bytes: number;
  readonly reserved_bytes: number;
  readonly quota_bytes: number;
  readonly hourly_uploads: number;
  readonly hourly_window_start: number;
  readonly daily_uploads: number;
  readonly daily_window_start: number;
  readonly updated_at: number;
}

export function resolveStorageQuotaBytes(tenantStatus: TenantStatus): number {
  if (tenantStatus === "active" || tenantStatus === "grace" || tenantStatus === "locked") {
    return PAID_STORAGE_QUOTA_BYTES;
  }
  return TRIAL_STORAGE_QUOTA_BYTES;
}

function mapStorageUsageRow(row: StorageUsageRow): StorageUsageSnapshot {
  const usedBytes = Math.max(0, Number(row.used_bytes ?? 0));
  const reservedBytes = Math.max(0, Number(row.reserved_bytes ?? 0));
  const quotaBytes = Math.max(1, Number(row.quota_bytes ?? TRIAL_STORAGE_QUOTA_BYTES));
  const effectiveUsed = usedBytes + reservedBytes;
  const availableBytes = Math.max(0, quotaBytes - effectiveUsed);
  const percentUsed = Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10);
  return {
    usedBytes,
    reservedBytes,
    quotaBytes,
    availableBytes,
    percentUsed,
    warningAt80: usedBytes >= Math.floor(quotaBytes * 0.8),
    hourlyUploads: Math.max(0, Number(row.hourly_uploads ?? 0)),
    hourlyWindowStart: Number(row.hourly_window_start ?? 0),
    dailyUploads: Math.max(0, Number(row.daily_uploads ?? 0)),
    dailyWindowStart: Number(row.daily_window_start ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * Ensures the singleton `storage_usage` row (`id = 1`) exists and synchronizes
 * `quota_bytes` with the tenant's live billing status (so trial -> paid lifts
 * the quota from 100 MB to 1 GB immediately per REQ-064).
 */
export async function syncTenantStorageQuota(
  tenantDb: D1Database,
  tenantStatus: TenantStatus,
  nowMs: number = Date.now(),
): Promise<StorageUsageSnapshot> {
  await ensureMediaPipelineSchema(tenantDb);
  const targetQuotaBytes = resolveStorageQuotaBytes(tenantStatus);

  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, 0, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(targetQuotaBytes, nowMs, nowMs, nowMs),
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET quota_bytes = ?, updated_at = ?
         WHERE id = 1 AND quota_bytes != ?`,
      )
      .bind(targetQuotaBytes, nowMs, targetQuotaBytes),
    tenantDb.prepare(
      `SELECT used_bytes, reserved_bytes, quota_bytes,
              hourly_uploads, hourly_window_start,
              daily_uploads, daily_window_start, updated_at
       FROM storage_usage WHERE id = 1`,
    ),
  ]);

  const selectResult = results[2] as D1Result<StorageUsageRow> | undefined;
  const row = selectResult?.results[0];
  if (!row) {
    throw new Error("STORAGE_USAGE_ROW_MISSING");
  }
  return mapStorageUsageRow(row);
}

export async function getStorageUsageSnapshot(
  tenantDb: D1Database,
  options?: { readonly tenantStatus?: TenantStatus; readonly nowMs?: number },
): Promise<StorageUsageSnapshot> {
  if (options?.tenantStatus) {
    return syncTenantStorageQuota(tenantDb, options.tenantStatus, options.nowMs ?? Date.now());
  }
  await ensureMediaPipelineSchema(tenantDb);
  const nowMs = options?.nowMs ?? Date.now();
  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, 0, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(TRIAL_STORAGE_QUOTA_BYTES, nowMs, nowMs, nowMs),
    tenantDb.prepare(
      `SELECT used_bytes, reserved_bytes, quota_bytes,
              hourly_uploads, hourly_window_start,
              daily_uploads, daily_window_start, updated_at
       FROM storage_usage WHERE id = 1`,
    ),
  ]);
  const row = (results[1] as D1Result<StorageUsageRow> | undefined)?.results[0];
  if (!row) {
    throw new Error("STORAGE_USAGE_ROW_MISSING");
  }
  return mapStorageUsageRow(row);
}

export interface ReleasedExpiredReservationsResult {
  readonly expiredIntentIds: readonly string[];
  readonly staleProcessingIntentIds: readonly string[];
  readonly quarantineKeys: readonly string[];
  readonly releasedBytes: number;
}

interface ExpiredIntentSqlRow {
  readonly id: string;
  readonly status: string;
  readonly quarantine_r2_key: string;
  readonly reserved_bytes: number;
}

/**
 * Atomically releases:
 * 1. Expired `pending_upload` intents (`expires_at <= nowMs`) -> `status = 'expired'`
 * 2. Stuck `uploaded` / `processing` intents (`updated_at <= nowMs - staleProcessingTtlMs`)
 *    -> `status = 'failed'`, `error_code = 'PROCESSING_TIMEOUT'`, and linked non-ready
 *       `media_items` -> `status = 'failed'`
 *
 * Runs inside ONE `TenantStore` `batch()` (`transactionSync`), freeing `reserved_bytes`
 * atomically and returning all affected quarantine R2 keys for cleanup.
 */
export async function releaseExpiredReservations(
  tenantDb: D1Database,
  nowMs: number = Date.now(),
  options?: { readonly staleProcessingTtlMs?: number },
): Promise<ReleasedExpiredReservationsResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const staleCutoffMs = nowMs - Math.max(1_000, options?.staleProcessingTtlMs ?? STALE_PROCESSING_TTL_MS);

  const results = await tenantDb.batch([
    // 0. Select all expired pending_upload + stale uploaded/processing intents
    tenantDb
      .prepare(
        `SELECT id, status, quarantine_r2_key, reserved_bytes
         FROM media_upload_intents
         WHERE (status = 'pending_upload' AND expires_at <= ?)
            OR (status IN ('uploaded', 'processing') AND updated_at <= ?)`,
      )
      .bind(nowMs, staleCutoffMs),
    // 1. Reclaim reserved_bytes atomically for both expired pending and stale processing intents
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = MAX(0, reserved_bytes - COALESCE((
               SELECT SUM(reserved_bytes)
               FROM media_upload_intents
               WHERE (status = 'pending_upload' AND expires_at <= ?)
                  OR (status IN ('uploaded', 'processing') AND updated_at <= ?)
             ), 0)),
             updated_at = ?
         WHERE id = 1`,
      )
      .bind(nowMs, staleCutoffMs, nowMs),
    // 2. Mark linked non-ready media rows for stale uploaded/processing intents as failed
    tenantDb
      .prepare(
        `UPDATE media_items
         SET status = 'failed', version = version + 1, updated_at = ?
         WHERE status != 'ready'
           AND id IN (
             SELECT media_item_id FROM media_upload_intents
             WHERE status IN ('uploaded', 'processing')
               AND updated_at <= ?
               AND media_item_id IS NOT NULL
           )`,
      )
      .bind(nowMs, staleCutoffMs),
    // 3. Transition expired pending_upload intents
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'expired', reserved_bytes = 0, updated_at = ?
         WHERE status = 'pending_upload' AND expires_at <= ?`,
      )
      .bind(nowMs, nowMs),
    // 4. Transition stale uploaded/processing intents
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'failed', error_code = 'PROCESSING_TIMEOUT', reserved_bytes = 0, updated_at = ?
         WHERE status IN ('uploaded', 'processing') AND updated_at <= ?`,
      )
      .bind(nowMs, staleCutoffMs),
  ]);

  const rows = (results[0] as D1Result<ExpiredIntentSqlRow> | undefined)?.results ?? [];
  let releasedBytes = 0;
  const expiredIntentIds: string[] = [];
  const staleProcessingIntentIds: string[] = [];
  const quarantineKeys: string[] = [];

  for (const row of rows) {
    if (row.status === "pending_upload") {
      expiredIntentIds.push(row.id);
    } else {
      staleProcessingIntentIds.push(row.id);
    }
    quarantineKeys.push(row.quarantine_r2_key);
    releasedBytes += Math.max(0, Number(row.reserved_bytes ?? 0));
  }

  return {
    expiredIntentIds,
    staleProcessingIntentIds,
    quarantineKeys,
    releasedBytes,
  };
}

export interface ReserveStorageQuotaInput {
  readonly incomingBytes: number;
  readonly tenantStatus: TenantStatus;
  readonly nowMs?: number;
  readonly hourlyLimit?: number;
  readonly dailyLimit?: number;
  readonly staleProcessingTtlMs?: number;
}

export type ReserveStorageQuotaResult =
  | {
      readonly ok: true;
      readonly snapshot: StorageUsageSnapshot;
    }
  | {
      readonly ok: false;
      readonly status: 429;
      readonly code: "RATE_LIMITED";
      readonly window: "hourly" | "daily";
      readonly retryAfterSeconds: number;
      readonly message: string;
      readonly snapshot: StorageUsageSnapshot;
    }
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: "STORAGE_QUOTA_EXCEEDED";
      readonly incomingBytes: number;
      readonly message: string;
      readonly snapshot: StorageUsageSnapshot;
    };

/**
 * Atomically releases expired/stale reservations, syncs tier quota, enforces upload intent
 * rate limits (50/hour and 200/day), and reserves `incomingBytes` in `storage_usage`.
 *
 * Executes inside ONE `tenantDb.batch()` (`transactionSync` in `TenantStore`), so
 * parallel concurrent intents can NEVER exceed quota or rate limits.
 */
export async function reserveStorageQuotaAtomically(
  tenantDb: D1Database,
  input: ReserveStorageQuotaInput,
): Promise<ReserveStorageQuotaResult> {
  if (!Number.isInteger(input.incomingBytes) || input.incomingBytes < 1) {
    throw new RangeError("incomingBytes must be a positive integer");
  }

  await ensureMediaPipelineSchema(tenantDb);

  const nowMs = input.nowMs ?? Date.now();
  const staleCutoffMs =
    nowMs - Math.max(1_000, input.staleProcessingTtlMs ?? STALE_PROCESSING_TTL_MS);
  const targetQuotaBytes = resolveStorageQuotaBytes(input.tenantStatus);
  const hourlyLimit = input.hourlyLimit ?? MEDIA_UPLOAD_HOURLY_LIMIT;
  const dailyLimit = input.dailyLimit ?? MEDIA_UPLOAD_DAILY_LIMIT;

  const results = await tenantDb.batch([
    // 0. Ensure singleton row exists
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, 0, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(targetQuotaBytes, nowMs, nowMs, nowMs),
    // 1. Sync quota tier (trial <-> active/grace/locked)
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET quota_bytes = ?, updated_at = ?
         WHERE id = 1 AND quota_bytes != ?`,
      )
      .bind(targetQuotaBytes, nowMs, targetQuotaBytes),
    // 2. Reclaim expired pending + stale uploaded/processing reservations atomically
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = MAX(0, reserved_bytes - COALESCE((
               SELECT SUM(reserved_bytes)
               FROM media_upload_intents
               WHERE (status = 'pending_upload' AND expires_at <= ?)
                  OR (status IN ('uploaded', 'processing') AND updated_at <= ?)
             ), 0)),
             updated_at = ?
         WHERE id = 1`,
      )
      .bind(nowMs, staleCutoffMs, nowMs),
    // 3. Fail linked non-ready media items for stale processing intents
    tenantDb
      .prepare(
        `UPDATE media_items
         SET status = 'failed', version = version + 1, updated_at = ?
         WHERE status != 'ready'
           AND id IN (
             SELECT media_item_id FROM media_upload_intents
             WHERE status IN ('uploaded', 'processing')
               AND updated_at <= ?
               AND media_item_id IS NOT NULL
           )`,
      )
      .bind(nowMs, staleCutoffMs),
    // 4. Mark expired pending intents
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'expired', reserved_bytes = 0, updated_at = ?
         WHERE status = 'pending_upload' AND expires_at <= ?`,
      )
      .bind(nowMs, nowMs),
    // 5. Mark stale uploaded/processing intents failed
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'failed', error_code = 'PROCESSING_TIMEOUT', reserved_bytes = 0, updated_at = ?
         WHERE status IN ('uploaded', 'processing') AND updated_at <= ?`,
      )
      .bind(nowMs, staleCutoffMs),
    // 6. Conditional atomic rate-limit + quota reservation
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET
           hourly_uploads = CASE WHEN (? - hourly_window_start) >= ? THEN 1 ELSE hourly_uploads + 1 END,
           hourly_window_start = CASE WHEN (? - hourly_window_start) >= ? THEN ? ELSE hourly_window_start END,
           daily_uploads = CASE WHEN (? - daily_window_start) >= ? THEN 1 ELSE daily_uploads + 1 END,
           daily_window_start = CASE WHEN (? - daily_window_start) >= ? THEN ? ELSE daily_window_start END,
           reserved_bytes = reserved_bytes + ?,
           updated_at = ?
         WHERE id = 1
           AND (CASE WHEN (? - hourly_window_start) >= ? THEN 1 ELSE hourly_uploads + 1 END) <= ?
           AND (CASE WHEN (? - daily_window_start) >= ? THEN 1 ELSE daily_uploads + 1 END) <= ?
           AND (used_bytes + reserved_bytes + ?) <= quota_bytes
         RETURNING used_bytes, reserved_bytes, quota_bytes,
                   hourly_uploads, hourly_window_start,
                   daily_uploads, daily_window_start, updated_at`,
      )
      .bind(
        nowMs,
        MEDIA_UPLOAD_HOUR_WINDOW_MS,
        nowMs,
        MEDIA_UPLOAD_HOUR_WINDOW_MS,
        nowMs,
        nowMs,
        MEDIA_UPLOAD_DAY_WINDOW_MS,
        nowMs,
        MEDIA_UPLOAD_DAY_WINDOW_MS,
        nowMs,
        input.incomingBytes,
        nowMs,
        nowMs,
        MEDIA_UPLOAD_HOUR_WINDOW_MS,
        hourlyLimit,
        nowMs,
        MEDIA_UPLOAD_DAY_WINDOW_MS,
        dailyLimit,
        input.incomingBytes,
      ),
    // 7. Read current state for diagnostics if conditional UPDATE matched 0 rows
    tenantDb.prepare(
      `SELECT used_bytes, reserved_bytes, quota_bytes,
              hourly_uploads, hourly_window_start,
              daily_uploads, daily_window_start, updated_at
       FROM storage_usage WHERE id = 1`,
    ),
  ]);

  const updatedRow = (results[6] as D1Result<StorageUsageRow> | undefined)?.results[0];
  if (updatedRow) {
    return {
      ok: true,
      snapshot: mapStorageUsageRow(updatedRow),
    };
  }

  const currentRow = (results[7] as D1Result<StorageUsageRow> | undefined)?.results[0];
  if (!currentRow) {
    throw new Error("STORAGE_USAGE_ROW_MISSING");
  }
  const snapshot = mapStorageUsageRow(currentRow);

  const hourlyElapsed = nowMs - snapshot.hourlyWindowStart;
  const nextHourly = hourlyElapsed >= MEDIA_UPLOAD_HOUR_WINDOW_MS ? 1 : snapshot.hourlyUploads + 1;
  if (nextHourly > hourlyLimit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((snapshot.hourlyWindowStart + MEDIA_UPLOAD_HOUR_WINDOW_MS - nowMs) / 1000),
    );
    return {
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      window: "hourly",
      retryAfterSeconds,
      message: `Upload intent rate limit exceeded (max ${hourlyLimit} per hour).`,
      snapshot,
    };
  }

  const dailyElapsed = nowMs - snapshot.dailyWindowStart;
  const nextDaily = dailyElapsed >= MEDIA_UPLOAD_DAY_WINDOW_MS ? 1 : snapshot.dailyUploads + 1;
  if (nextDaily > dailyLimit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((snapshot.dailyWindowStart + MEDIA_UPLOAD_DAY_WINDOW_MS - nowMs) / 1000),
    );
    return {
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      window: "daily",
      retryAfterSeconds,
      message: `Upload intent rate limit exceeded (max ${dailyLimit} per day).`,
      snapshot,
    };
  }

  return {
    ok: false,
    status: 422,
    code: "STORAGE_QUOTA_EXCEEDED",
    incomingBytes: input.incomingBytes,
    message: `Storage quota exceeded (${snapshot.usedBytes + snapshot.reservedBytes} + ${input.incomingBytes} > ${snapshot.quotaBytes} bytes).`,
    snapshot,
  };
}

/**
 * Releases a specific reservation amount back to `storage_usage.reserved_bytes`
 * (e.g. when an upload fails validation or expires).
 */
export async function releaseReservedBytes(
  tenantDb: D1Database,
  bytesToRelease: number,
  nowMs: number = Date.now(),
): Promise<void> {
  if (bytesToRelease <= 0) return;
  await ensureMediaPipelineSchema(tenantDb);
  await tenantDb
    .prepare(
      `UPDATE storage_usage
       SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = ?
       WHERE id = 1`,
    )
    .bind(bytesToRelease, nowMs)
    .run();
}

/**
 * Frees `used_bytes` when a media item is permanently purged (NOT on soft-delete/trash).
 */
export async function releaseUsedBytes(
  tenantDb: D1Database,
  bytesToRelease: number,
  nowMs: number = Date.now(),
): Promise<void> {
  if (bytesToRelease <= 0) return;
  await ensureMediaPipelineSchema(tenantDb);
  await tenantDb
    .prepare(
      `UPDATE storage_usage
       SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
       WHERE id = 1`,
    )
    .bind(bytesToRelease, nowMs)
    .run();
}
