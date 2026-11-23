import {
  assertTenantR2Key,
  buildQuarantineR2Key,
  generateUlid,
  slugifyMediaFilename,
} from "@punyasitus/core/media/index";
import {
  MAX_VIDEOS_PER_TENANT,
  type VideoMetadataManifest,
} from "@punyasitus/core/media/video";
import type { TenantStatus } from "@punyasitus/core/schemas";
import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import {
  DEFAULT_UPLOAD_INTENT_TTL_MS,
  MEDIA_UPLOAD_DAILY_LIMIT,
  MEDIA_UPLOAD_DAY_WINDOW_MS,
  MEDIA_UPLOAD_HOUR_WINDOW_MS,
  MEDIA_UPLOAD_HOURLY_LIMIT,
  resolveStorageQuotaBytes,
  STALE_PROCESSING_TTL_MS,
  type StorageUsageSnapshot,
} from "../storage-usage/index.ts";
import type {
  MediaItemDbStatus,
  MediaItemRecord,
  MediaUploadIntentRecord,
} from "./index.ts";

/**
 * Per-tenant Short Video repository & atomic 20-video cap enforcement
 * (REQ-062, REQ-034, REQ-039, REQ-064; PLAN §5.2, §7.1–7.3; TASK-060).
 *
 * STRICT INVARIANT: ZERO request-time runtime DDL (`CREATE TABLE`, `ALTER TABLE`,
 * or `ensure*Schema`) anywhere in this module. Migrations (`0001`, `0002`, `0006`)
 * must be applied via `TenantStore.applyMigrations()`.
 */

export const SHORT_VIDEO_PIPELINE_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0006_short_video_pipeline
-- Additive indexes for atomic 20-video per-website cap enforcement and short-video queries
-- (REQ-062, REQ-064; PLAN §7.2, §7.3).

CREATE INDEX IF NOT EXISTS media_items_kind_status_idx
  ON media_items(kind, status);

CREATE INDEX IF NOT EXISTS media_upload_intents_kind_status_idx
  ON media_upload_intents(kind, status);
`;

export const SHORT_VIDEO_PIPELINE_MIGRATION: MigrationDescriptor = {
  version: 6,
  name: "0006_short_video_pipeline",
  sql: SHORT_VIDEO_PIPELINE_MIGRATION_SQL,
} as const;

interface MediaIntentSqlRow {
  readonly id: string;
  readonly idempotency_key: string | null;
  readonly payload_hash: string | null;
  readonly kind: "image" | "video";
  readonly original_filename: string;
  readonly slug: string;
  readonly declared_mime: string;
  readonly declared_bytes: number;
  readonly declared_sha256: string;
  readonly alt_text: string;
  readonly decorative: number;
  readonly quarantine_r2_key: string;
  readonly reserved_bytes: number;
  readonly media_item_id: number | null;
  readonly status: MediaUploadIntentRecord["status"];
  readonly error_code: string | null;
  readonly created_by_user_id: string | null;
  readonly expires_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface VideoMediaSqlRow {
  readonly id: number;
  readonly kind: "image" | "video";
  readonly r2_key: string;
  readonly mime_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt_text: string;
  readonly variants_json: string | null;
  readonly duration_seconds: number | null;
  readonly poster_r2_key: string | null;
  readonly captions_r2_key: string | null;
  readonly status: MediaItemDbStatus;
  readonly deleted_at: number | null;
  readonly original_filename: string | null;
  readonly slug: string | null;
  readonly decorative: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
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

export interface VideoSlotUsage {
  readonly usedSlots: number;
  readonly maxSlots: number;
  readonly remainingSlots: number;
}

function mapIntentRow(row: MediaIntentSqlRow): MediaUploadIntentRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    kind: row.kind,
    originalFilename: row.original_filename,
    slug: row.slug,
    declaredMime: row.declared_mime,
    declaredBytes: Number(row.declared_bytes),
    declaredSha256: row.declared_sha256,
    altText: row.alt_text,
    decorative: row.decorative === 1,
    quarantineR2Key: row.quarantine_r2_key,
    reservedBytes: Number(row.reserved_bytes),
    mediaItemId: row.media_item_id === null ? null : Number(row.media_item_id),
    status: row.status,
    errorCode: row.error_code,
    createdByUserId: row.created_by_user_id,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapUsageRow(row: StorageUsageRow): StorageUsageSnapshot {
  const usedBytes = Math.max(0, Number(row.used_bytes ?? 0));
  const reservedBytes = Math.max(0, Number(row.reserved_bytes ?? 0));
  const quotaBytes = Math.max(1, Number(row.quota_bytes ?? 100_000_000));
  return {
    usedBytes,
    reservedBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - (usedBytes + reservedBytes)),
    percentUsed: Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10),
    warningAt80: usedBytes >= Math.floor(quotaBytes * 0.8),
    hourlyUploads: Math.max(0, Number(row.hourly_uploads ?? 0)),
    hourlyWindowStart: Number(row.hourly_window_start ?? 0),
    dailyUploads: Math.max(0, Number(row.daily_uploads ?? 0)),
    dailyWindowStart: Number(row.daily_window_start ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function parseVideoManifest(raw: string | null): VideoMetadataManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VideoMetadataManifest>;
    if (parsed && typeof parsed === "object" && parsed.kind === "video") {
      return parsed as VideoMetadataManifest;
    }
    return null;
  } catch {
    return null;
  }
}

function mapVideoMediaRow(row: VideoMediaSqlRow): MediaItemRecord {
  const deletedAt =
    row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at);
  return {
    id: Number(row.id),
    kind: row.kind,
    r2Key: row.r2_key,
    mimeType: row.mime_type,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    altText: row.alt_text,
    decorative: row.decorative === 1,
    originalFilename: row.original_filename ?? null,
    slug: row.slug ?? null,
    variants: null,
    videoMetadata: parseVideoManifest(row.variants_json),
    durationSeconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : Number(row.duration_seconds),
    posterR2Key: row.poster_r2_key ?? null,
    captionsR2Key: row.captions_r2_key ?? null,
    status: deletedAt !== null ? "trashed" : row.status,
    dbStatus: row.status,
    deletedAt,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getVideoSlotUsage(
  tenantDb: D1Database,
  maxVideos: number = MAX_VIDEOS_PER_TENANT,
): Promise<VideoSlotUsage> {
  const row = await tenantDb
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM media_items WHERE kind = 'video' AND status != 'failed')
         +
         (SELECT COUNT(*) FROM media_upload_intents
          WHERE kind = 'video'
            AND status IN ('pending_upload', 'uploaded', 'processing')
            AND media_item_id IS NULL) AS active_video_slots`,
    )
    .first<{ active_video_slots: number }>();

  const usedSlots = Math.max(0, Number(row?.active_video_slots ?? 0));
  return {
    usedSlots,
    maxSlots: maxVideos,
    remainingSlots: Math.max(0, maxVideos - usedSlots),
  };
}

export async function getVideoMediaItemById(
  tenantDb: D1Database,
  mediaId: number,
): Promise<MediaItemRecord | null> {
  const row = await tenantDb
    .prepare(
      `SELECT id, kind, r2_key, mime_type, bytes, sha256, width, height,
              alt_text, variants_json, duration_seconds, poster_r2_key, captions_r2_key,
              status, deleted_at, original_filename, slug, decorative,
              version, created_at, updated_at
       FROM media_items
       WHERE id = ? LIMIT 1`,
    )
    .bind(mediaId)
    .first<VideoMediaSqlRow>();
  return row ? mapVideoMediaRow(row) : null;
}

export async function getVideoUploadIntentById(
  tenantDb: D1Database,
  intentId: string,
): Promise<MediaUploadIntentRecord | null> {
  const row = await tenantDb
    .prepare("SELECT * FROM media_upload_intents WHERE id = ? LIMIT 1")
    .bind(intentId)
    .first<MediaIntentSqlRow>();
  return row ? mapIntentRow(row) : null;
}

export async function failVideoUploadIntent(
  tenantDb: D1Database,
  intentId: string,
  errorCode: string,
  nowMs: number = Date.now(),
): Promise<{ readonly releasedBytes: number }> {
  const results = await tenantDb.batch([
    tenantDb
      .prepare("SELECT reserved_bytes, media_item_id FROM media_upload_intents WHERE id = ? LIMIT 1")
      .bind(intentId),
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = MAX(0, reserved_bytes - COALESCE((
               SELECT reserved_bytes FROM media_upload_intents
               WHERE id = ? AND status IN ('pending_upload', 'uploaded', 'processing')
             ), 0)),
             updated_at = ?
         WHERE id = 1`,
      )
      .bind(intentId, nowMs),
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'failed', reserved_bytes = 0, error_code = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending_upload', 'uploaded', 'processing')`,
      )
      .bind(errorCode, nowMs, intentId),
    tenantDb
      .prepare(
        `UPDATE media_items
         SET status = 'failed',
             variants_json = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = (SELECT media_item_id FROM media_upload_intents WHERE id = ?)
           AND status != 'ready'`,
      )
      .bind(JSON.stringify({ kind: "video", errorCode }), nowMs, intentId),
  ]);

  const row = (
    results[0] as D1Result<{ reserved_bytes: number; media_item_id: number | null }> | undefined
  )?.results[0];
  return { releasedBytes: Math.max(0, Number(row?.reserved_bytes ?? 0)) };
}

export interface CreateVideoUploadIntentInput {
  readonly tenantId: string;
  readonly tenantStatus: TenantStatus;
  readonly filename: string;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  readonly altText: string;
  readonly idempotencyKey?: string | null;
  readonly payloadHash?: string | null;
  readonly createdByUserId?: string | null;
  readonly ttlMs?: number;
  readonly nowMs?: number;
  readonly hourlyLimit?: number;
  readonly dailyLimit?: number;
  readonly maxVideos?: number;
}

export type CreateVideoUploadIntentResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly intent: MediaUploadIntentRecord;
      readonly usage: StorageUsageSnapshot;
      readonly videoSlots: VideoSlotUsage;
    }
  | {
      readonly ok: false;
      readonly status: 409;
      readonly code: "IDEMPOTENCY_CONFLICT";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: 429;
      readonly code: "RATE_LIMITED";
      readonly window: "hourly" | "daily";
      readonly retryAfterSeconds: number;
      readonly message: string;
      readonly usage: StorageUsageSnapshot;
    }
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: "VIDEO_LIMIT_REACHED";
      readonly message: string;
      readonly videoSlots: VideoSlotUsage;
    }
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: "STORAGE_QUOTA_EXCEEDED";
      readonly message: string;
      readonly usage: StorageUsageSnapshot;
    };

/**
 * Atomically enforces ALL short-video upload gates inside a single `TenantStore`
 * `transactionSync` batch:
 * 1. Idempotency replay / conflict detection
 * 2. Reclaiming expired `pending_upload` & stale `uploaded`/`processing` intents
 * 3. Per-website 20-video cap (existing non-failed videos + active unlinked video intents < 20)
 *    — parallel concurrent intents can NEVER exceed 20!
 * 4. Upload rate limits (50/hour, 200/day)
 * 5. Normalized storage quota (`used + reserved + declared <= quota`)
 */
export async function createVideoUploadIntent(
  tenantDb: D1Database,
  input: CreateVideoUploadIntentInput,
): Promise<CreateVideoUploadIntentResult> {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_UPLOAD_INTENT_TTL_MS;
  const expiresAt = nowMs + Math.max(1_000, ttlMs);
  const staleCutoffMs = nowMs - STALE_PROCESSING_TTL_MS;
  const targetQuotaBytes = resolveStorageQuotaBytes(input.tenantStatus);
  const hourlyLimit = input.hourlyLimit ?? MEDIA_UPLOAD_HOURLY_LIMIT;
  const dailyLimit = input.dailyLimit ?? MEDIA_UPLOAD_DAILY_LIMIT;
  const maxVideos = input.maxVideos ?? MAX_VIDEOS_PER_TENANT;
  const slug = slugifyMediaFilename(input.filename);
  const idempotencyKey = input.idempotencyKey?.trim() || null;

  if (idempotencyKey) {
    const existing = await tenantDb
      .prepare("SELECT * FROM media_upload_intents WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey)
      .first<MediaIntentSqlRow>();

    if (existing) {
      if (existing.kind !== "video") {
        return {
          ok: false,
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency-Key belongs to an image upload intent.",
        };
      }
      if (existing.status === "failed" || existing.status === "expired") {
        return {
          ok: false,
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: `Idempotency-Key belongs to a ${existing.status} upload intent; use a new Idempotency-Key.`,
        };
      }
      if (input.payloadHash && existing.payload_hash && existing.payload_hash !== input.payloadHash) {
        return {
          ok: false,
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency-Key was already used with a different upload payload.",
        };
      }
      const [usageRow, videoSlots] = await Promise.all([
        tenantDb
          .prepare(
            `SELECT used_bytes, reserved_bytes, quota_bytes,
                    hourly_uploads, hourly_window_start,
                    daily_uploads, daily_window_start, updated_at
             FROM storage_usage WHERE id = 1`,
          )
          .first<StorageUsageRow>(),
        getVideoSlotUsage(tenantDb, maxVideos),
      ]);
      return {
        ok: true,
        replayed: true,
        intent: mapIntentRow(existing),
        usage: usageRow
          ? mapUsageRow(usageRow)
          : mapUsageRow({
              used_bytes: 0,
              reserved_bytes: existing.reserved_bytes,
              quota_bytes: targetQuotaBytes,
              hourly_uploads: 1,
              hourly_window_start: nowMs,
              daily_uploads: 1,
              daily_window_start: nowMs,
              updated_at: nowMs,
            }),
        videoSlots,
      };
    }
  }

  const intentId = generateUlid(nowMs);
  const quarantineR2Key = buildQuarantineR2Key(input.tenantId, intentId, slug);

  // ONE atomic transactionSync batch enforcing 20-video cap + rate limit + storage quota simultaneously!
  const results = await tenantDb.batch([
    // 0. Ensure singleton storage_usage row
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, 0, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(targetQuotaBytes, nowMs, nowMs, nowMs),
    // 1. Sync quota tier
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET quota_bytes = ?, updated_at = ?
         WHERE id = 1 AND quota_bytes != ?`,
      )
      .bind(targetQuotaBytes, nowMs, targetQuotaBytes),
    // 2. Reclaim expired pending_upload + stale uploaded/processing byte reservations
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
    // 3. Fail linked non-ready media rows for stale uploaded/processing intents
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
    // 4. Mark expired pending intents (frees both reserved bytes AND video slot!)
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
    // 6. Conditionally insert video intent ONLY IF:
    //    - active video slots < maxVideos (20)
    //    - hourly & daily rate limits pass
    //    - storage quota fits
    //    - idempotency_key not concurrently claimed
    tenantDb
      .prepare(
        `INSERT INTO media_upload_intents (
           id, idempotency_key, payload_hash, kind, original_filename, slug,
           declared_mime, declared_bytes, declared_sha256, alt_text, decorative,
           quarantine_r2_key, reserved_bytes, media_item_id, status, error_code,
           created_by_user_id, expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 'pending_upload', NULL, ?, ?, ?, ?
         WHERE (
           (SELECT COUNT(*) FROM media_items WHERE kind = 'video' AND status != 'failed')
           +
           (SELECT COUNT(*) FROM media_upload_intents
            WHERE kind = 'video'
              AND status IN ('pending_upload', 'uploaded', 'processing')
              AND media_item_id IS NULL)
         ) < ?
         AND EXISTS (
           SELECT 1 FROM storage_usage
           WHERE id = 1
             AND (CASE WHEN (? - hourly_window_start) >= ? THEN 1 ELSE hourly_uploads + 1 END) <= ?
             AND (CASE WHEN (? - daily_window_start) >= ? THEN 1 ELSE daily_uploads + 1 END) <= ?
             AND (used_bytes + reserved_bytes + ?) <= quota_bytes
         )
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM media_upload_intents WHERE idempotency_key = ?
         ))
         RETURNING id`,
      )
      .bind(
        intentId,
        idempotencyKey,
        input.payloadHash ?? null,
        input.filename,
        slug,
        input.declaredMime,
        input.declaredBytes,
        input.declaredSha256,
        input.altText,
        quarantineR2Key,
        input.declaredBytes,
        input.createdByUserId ?? null,
        expiresAt,
        nowMs,
        nowMs,
        maxVideos,
        nowMs,
        MEDIA_UPLOAD_HOUR_WINDOW_MS,
        hourlyLimit,
        nowMs,
        MEDIA_UPLOAD_DAY_WINDOW_MS,
        dailyLimit,
        input.declaredBytes,
        idempotencyKey,
        idempotencyKey,
      ),
    // 7. Reserve bytes & increment counters ONLY IF Stmt 6 inserted the intent
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
           AND EXISTS (SELECT 1 FROM media_upload_intents WHERE id = ?)
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
        input.declaredBytes,
        nowMs,
        intentId,
      ),
    // 8. Unconditional read of storage_usage + active video slots for diagnostics & response
    tenantDb.prepare(
      `SELECT used_bytes, reserved_bytes, quota_bytes,
              hourly_uploads, hourly_window_start,
              daily_uploads, daily_window_start, updated_at
       FROM storage_usage WHERE id = 1`,
    ),
    // 9. Unconditional read of current video slot count
    tenantDb.prepare(
      `SELECT
         (SELECT COUNT(*) FROM media_items WHERE kind = 'video' AND status != 'failed')
         +
         (SELECT COUNT(*) FROM media_upload_intents
          WHERE kind = 'video'
            AND status IN ('pending_upload', 'uploaded', 'processing')
            AND media_item_id IS NULL) AS active_video_slots`,
    ),
  ]);

  const insertedIntent = (results[6] as D1Result<{ id: string }> | undefined)?.results[0];
  const updatedUsageRow = (results[7] as D1Result<StorageUsageRow> | undefined)?.results[0];
  const slotRow = (results[9] as D1Result<{ active_video_slots: number }> | undefined)?.results[0];
  const usedSlots = Math.max(0, Number(slotRow?.active_video_slots ?? 0));
  const videoSlots: VideoSlotUsage = {
    usedSlots,
    maxSlots: maxVideos,
    remainingSlots: Math.max(0, maxVideos - usedSlots),
  };

  if (!insertedIntent || !updatedUsageRow) {
    // Check concurrent idempotency winner first
    if (idempotencyKey) {
      const raced = await tenantDb
        .prepare("SELECT * FROM media_upload_intents WHERE idempotency_key = ? LIMIT 1")
        .bind(idempotencyKey)
        .first<MediaIntentSqlRow>();
      if (raced) {
        if (
          raced.kind !== "video" ||
          raced.status === "failed" ||
          raced.status === "expired" ||
          (input.payloadHash && raced.payload_hash && raced.payload_hash !== input.payloadHash)
        ) {
          return {
            ok: false,
            status: 409,
            code: "IDEMPOTENCY_CONFLICT",
            message: "Idempotency-Key conflict with existing upload intent.",
          };
        }
        const currentUsageRow = (results[8] as D1Result<StorageUsageRow> | undefined)?.results[0];
        return {
          ok: true,
          replayed: true,
          intent: mapIntentRow(raced),
          usage: currentUsageRow
            ? mapUsageRow(currentUsageRow)
            : mapUsageRow({
                used_bytes: 0,
                reserved_bytes: raced.reserved_bytes,
                quota_bytes: targetQuotaBytes,
                hourly_uploads: 1,
                hourly_window_start: nowMs,
                daily_uploads: 1,
                daily_window_start: nowMs,
                updated_at: nowMs,
              }),
          videoSlots,
        };
      }
    }

    // Check 20-video cap before quota/rate (so 21st video always gets 422 VIDEO_LIMIT_REACHED)
    if (usedSlots >= maxVideos) {
      return {
        ok: false,
        status: 422,
        code: "VIDEO_LIMIT_REACHED",
        message: `Batas maksimum ${maxVideos} video per situs telah tercapai. Hapus permanen video lama untuk membebaskan slot.`,
        videoSlots,
      };
    }

    const currentUsageRow = (results[8] as D1Result<StorageUsageRow> | undefined)?.results[0];
    if (!currentUsageRow) {
      throw new Error("STORAGE_USAGE_ROW_MISSING");
    }
    const usage = mapUsageRow(currentUsageRow);

    const hourlyElapsed = nowMs - usage.hourlyWindowStart;
    const nextHourly = hourlyElapsed >= MEDIA_UPLOAD_HOUR_WINDOW_MS ? 1 : usage.hourlyUploads + 1;
    if (nextHourly > hourlyLimit) {
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        window: "hourly",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((usage.hourlyWindowStart + MEDIA_UPLOAD_HOUR_WINDOW_MS - nowMs) / 1000),
        ),
        message: `Upload intent rate limit exceeded (max ${hourlyLimit}/hour).`,
        usage,
      };
    }

    const dailyElapsed = nowMs - usage.dailyWindowStart;
    const nextDaily = dailyElapsed >= MEDIA_UPLOAD_DAY_WINDOW_MS ? 1 : usage.dailyUploads + 1;
    if (nextDaily > dailyLimit) {
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        window: "daily",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((usage.dailyWindowStart + MEDIA_UPLOAD_DAY_WINDOW_MS - nowMs) / 1000),
        ),
        message: `Upload intent rate limit exceeded (max ${dailyLimit}/day).`,
        usage,
      };
    }

    return {
      ok: false,
      status: 422,
      code: "STORAGE_QUOTA_EXCEEDED",
      message: `Storage quota exceeded (${usage.usedBytes + usage.reservedBytes} + ${input.declaredBytes} > ${usage.quotaBytes} bytes).`,
      usage,
    };
  }

  return {
    ok: true,
    replayed: false,
    intent: {
      id: intentId,
      idempotencyKey,
      payloadHash: input.payloadHash ?? null,
      kind: "video",
      originalFilename: input.filename,
      slug,
      declaredMime: input.declaredMime,
      declaredBytes: input.declaredBytes,
      declaredSha256: input.declaredSha256,
      altText: input.altText,
      decorative: false,
      quarantineR2Key,
      reservedBytes: input.declaredBytes,
      mediaItemId: null,
      status: "pending_upload",
      errorCode: null,
      createdByUserId: input.createdByUserId ?? null,
      expiresAt,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
    usage: mapUsageRow(updatedUsageRow),
    videoSlots,
  };
}

export interface MarkVideoIntentQuarantinedInput {
  readonly tenantId: string;
  readonly intentId: string;
  readonly quarantineR2Key: string;
  readonly detectedMime: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | null;
  readonly nowMs?: number;
}

export type MarkVideoIntentQuarantinedResult =
  | { readonly ok: true; readonly mediaId: number; readonly intent: MediaUploadIntentRecord }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 410;
      readonly code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UPLOAD_INTENT_EXPIRED";
      readonly message: string;
    };

/**
 * Atomically claims a `pending_upload` video intent, allocates a sequential `media_items`
 * ID, inserts the `processing` video row, and links `media_upload_intents.media_item_id`
 * so the 20-video slot count stays invariant across the handoff.
 */
export async function markVideoIntentQuarantinedAndCreateMedia(
  tenantDb: D1Database,
  input: MarkVideoIntentQuarantinedInput,
): Promise<MarkVideoIntentQuarantinedResult> {
  const nowMs = input.nowMs ?? Date.now();

  try {
    assertTenantR2Key(input.tenantId, input.quarantineR2Key, ["quarantine"]);
  } catch {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Foreign or invalid R2 quarantine key rejected.",
    };
  }

  const intent = await getVideoUploadIntentById(tenantDb, input.intentId);
  if (!intent) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Video upload intent not found for this tenant.",
    };
  }

  if (intent.kind !== "video") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Upload intent is not a video upload intent.",
    };
  }

  if (intent.quarantineR2Key !== input.quarantineR2Key) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Object key does not match the authorized video upload intent.",
    };
  }

  if (intent.status !== "pending_upload") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Video upload intent is already in state "${intent.status}".`,
    };
  }

  if (intent.expiresAt <= nowMs) {
    await tenantDb.batch([
      tenantDb
        .prepare(
          `UPDATE storage_usage
           SET reserved_bytes = MAX(0, reserved_bytes - COALESCE((
                 SELECT reserved_bytes FROM media_upload_intents
                 WHERE id = ? AND status = 'pending_upload'
               ), 0)),
               updated_at = ?
           WHERE id = 1`,
        )
        .bind(intent.id, nowMs),
      tenantDb
        .prepare(
          `UPDATE media_upload_intents
           SET status = 'expired', reserved_bytes = 0, updated_at = ?
           WHERE id = ? AND status = 'pending_upload'`,
        )
        .bind(nowMs, intent.id),
    ]);
    return {
      ok: false,
      status: 410,
      code: "UPLOAD_INTENT_EXPIRED",
      message: "Video upload intent has expired; reservation and video slot were released.",
    };
  }

  // Atomically claim the intent and allocate sequential media ID
  const claimAndAllocate = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'uploaded', updated_at = ?
         WHERE id = ? AND kind = 'video' AND status = 'pending_upload' AND expires_at > ?
         RETURNING id`,
      )
      .bind(nowMs, intent.id, nowMs),
    tenantDb
      .prepare(
        `INSERT INTO sequences (kind, next) VALUES ('media', 1)
         ON CONFLICT(kind) DO UPDATE SET next = next + 1
         RETURNING next`,
      ),
  ]);

  const claimed = (claimAndAllocate[0] as D1Result<{ id: string }> | undefined)?.results[0];
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Video upload intent was concurrently consumed or expired.",
    };
  }

  const allocatedSeq = (claimAndAllocate[1] as D1Result<{ next: number }> | undefined)?.results[0];
  const mediaId = Number(allocatedSeq?.next ?? 0);
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new Error("FAILED_TO_ALLOCATE_MEDIA_SEQUENCE");
  }

  // Insert media_items (`kind = 'video'`, `status = 'processing'`) AND link intent in ONE batch!
  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT INTO media_items (
           id, kind, r2_key, mime_type, bytes, sha256, width, height,
           alt_text, variants_json, duration_seconds, poster_r2_key, captions_r2_key,
           status, deleted_at, original_filename, slug, decorative,
           version, created_at, updated_at
         ) VALUES (?, 'video', ?, ?, 0, ?, ?, ?, ?, NULL, ?, NULL, NULL, 'processing', NULL, ?, ?, 0, 1, ?, ?)`,
      )
      .bind(
        mediaId,
        intent.quarantineR2Key,
        input.detectedMime,
        input.sha256,
        input.width,
        input.height,
        intent.altText,
        input.durationSeconds,
        intent.originalFilename,
        intent.slug,
        nowMs,
        nowMs,
      ),
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'processing', media_item_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(mediaId, nowMs, intent.id),
  ]);

  return {
    ok: true,
    mediaId,
    intent: {
      ...intent,
      status: "processing",
      mediaItemId: mediaId,
      updatedAt: nowMs,
    },
  };
}

export interface FinalizeProcessedVideoInput {
  readonly tenantId: string;
  readonly mediaId: number;
  readonly intentId: string;
  readonly videoR2Key: string;
  readonly posterR2Key: string;
  readonly processedVideoBytes: number;
  readonly videoSha256: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | null;
  readonly manifest: VideoMetadataManifest;
  readonly nowMs?: number;
}

export type FinalizeProcessedVideoResult =
  | { readonly ok: true; readonly alreadyReady: boolean; readonly media: MediaItemRecord }
  | {
      readonly ok: false;
      readonly code: "NOT_FOUND" | "STORAGE_QUOTA_EXCEEDED" | "INVALID_R2_KEY";
      readonly message: string;
    };

/**
 * Atomically finalizes a processed short video:
 * - Validates tenant-scoped `videoR2Key` and `posterR2Key` under `t/<tenantId>/media/...`
 * - Transitions `media_items` to `ready` with `mime_type = 'video/mp4'`, `bytes = processedVideoBytes`
 * - Reconciles `storage_usage` (`used_bytes += processedVideoBytes`, `reserved_bytes -= intent.reserved_bytes`)
 * - Marks `media_upload_intents` as `completed`
 * - Strictly idempotent: retries on already-ready videos never double-count `used_bytes`.
 */
export async function finalizeProcessedVideoAtomically(
  tenantDb: D1Database,
  input: FinalizeProcessedVideoInput,
): Promise<FinalizeProcessedVideoResult> {
  const nowMs = input.nowMs ?? Date.now();

  try {
    assertTenantR2Key(input.tenantId, input.videoR2Key, ["media"]);
    assertTenantR2Key(input.tenantId, input.posterR2Key, ["media"]);
  } catch {
    return {
      ok: false,
      code: "INVALID_R2_KEY",
      message: "Derived video or poster R2 keys failed tenant R2 key validation.",
    };
  }

  const existing = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!existing || existing.kind !== "video") {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Video media item #${input.mediaId} does not exist.`,
    };
  }

  if (existing.dbStatus === "ready") {
    return { ok: true, alreadyReady: true, media: existing };
  }

  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE media_items
         SET r2_key = ?,
             mime_type = 'video/mp4',
             bytes = ?,
             sha256 = ?,
             width = ?,
             height = ?,
             duration_seconds = ?,
             poster_r2_key = ?,
             variants_json = ?,
             status = 'ready',
             version = version + 1,
             updated_at = ?
         WHERE id = ?
           AND kind = 'video'
           AND status != 'ready'
           AND EXISTS (
             SELECT 1 FROM storage_usage
             WHERE id = 1
               AND (used_bytes + MAX(0, reserved_bytes - COALESCE((
                     SELECT reserved_bytes FROM media_upload_intents
                     WHERE id = ? AND status != 'completed'
                   ), 0)) + ?) <= quota_bytes
           )
         RETURNING id`,
      )
      .bind(
        input.videoR2Key,
        input.processedVideoBytes,
        input.videoSha256,
        input.width,
        input.height,
        input.durationSeconds,
        input.posterR2Key,
        JSON.stringify(input.manifest),
        nowMs,
        input.mediaId,
        input.intentId,
        input.processedVideoBytes,
      ),
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET used_bytes = used_bytes + ?,
             reserved_bytes = MAX(0, reserved_bytes - COALESCE((
               SELECT reserved_bytes FROM media_upload_intents
               WHERE id = ? AND status != 'completed'
             ), 0)),
             updated_at = ?
         WHERE id = 1
           AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND status = 'ready')
           AND EXISTS (SELECT 1 FROM media_upload_intents WHERE id = ? AND status != 'completed')
         RETURNING used_bytes, reserved_bytes, quota_bytes`,
      )
      .bind(
        input.processedVideoBytes,
        input.intentId,
        nowMs,
        input.mediaId,
        input.intentId,
      ),
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'completed', reserved_bytes = 0, error_code = NULL, updated_at = ?
         WHERE id = ?
           AND status != 'completed'
           AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND status = 'ready')`,
      )
      .bind(nowMs, input.intentId, input.mediaId),
  ]);

  const transitioned = (results[0] as D1Result<{ id: number }> | undefined)?.results[0];
  if (!transitioned) {
    const rechecked = await getVideoMediaItemById(tenantDb, input.mediaId);
    if (rechecked && rechecked.dbStatus === "ready") {
      return { ok: true, alreadyReady: true, media: rechecked };
    }
    return {
      ok: false,
      code: "STORAGE_QUOTA_EXCEEDED",
      message: "Processed video bytes exceed tenant storage quota.",
    };
  }

  const finalized = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!finalized) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Video media item #${input.mediaId} disappeared after finalize.`,
    };
  }

  return { ok: true, alreadyReady: false, media: finalized };
}

export async function updateVideoCaptions(
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly mediaId: number;
    readonly captionsR2Key: string;
    readonly captionsLang: string;
    readonly captionsLabel: string;
    readonly nowMs?: number;
  },
): Promise<
  | { readonly ok: true; readonly media: MediaItemRecord }
  | { readonly ok: false; readonly status: 403 | 404 | 422; readonly code: string; readonly message: string }
> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    assertTenantR2Key(input.tenantId, input.captionsR2Key, ["media"]);
  } catch {
    return {
      ok: false,
      status: 403,
      code: "INVALID_R2_KEY",
      message: "Captions R2 key failed tenant boundary validation.",
    };
  }

  const existing = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  if (existing.kind !== "video") {
    return {
      ok: false,
      status: 422,
      code: "NOT_A_VIDEO",
      message: "WebVTT captions can only be attached to video media items.",
    };
  }

  const nextManifest: VideoMetadataManifest | null = existing.videoMetadata
    ? {
        ...existing.videoMetadata,
        captionsLang: input.captionsLang,
        captionsLabel: input.captionsLabel,
      }
    : null;

  await tenantDb
    .prepare(
      `UPDATE media_items
       SET captions_r2_key = ?,
           variants_json = COALESCE(?, variants_json),
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND kind = 'video'`,
    )
    .bind(
      input.captionsR2Key,
      nextManifest ? JSON.stringify(nextManifest) : null,
      nowMs,
      input.mediaId,
    )
    .run();

  const updated = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!updated) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  return { ok: true, media: updated };
}

export async function updateVideoPoster(
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly mediaId: number;
    readonly posterR2Key: string;
    readonly posterSource: "client_frame" | "container_frame" | "default";
    readonly nowMs?: number;
  },
): Promise<
  | { readonly ok: true; readonly media: MediaItemRecord }
  | { readonly ok: false; readonly status: 403 | 404 | 422; readonly code: string; readonly message: string }
> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    assertTenantR2Key(input.tenantId, input.posterR2Key, ["media"]);
  } catch {
    return {
      ok: false,
      status: 403,
      code: "INVALID_R2_KEY",
      message: "Poster R2 key failed tenant boundary validation.",
    };
  }

  const existing = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  if (existing.kind !== "video") {
    return {
      ok: false,
      status: 422,
      code: "NOT_A_VIDEO",
      message: "Video poster can only be attached to video media items.",
    };
  }

  const nextManifest: VideoMetadataManifest | null = existing.videoMetadata
    ? {
        ...existing.videoMetadata,
        posterSource: input.posterSource,
        posterMimeType: "image/webp",
      }
    : null;

  await tenantDb
    .prepare(
      `UPDATE media_items
       SET poster_r2_key = ?,
           variants_json = COALESCE(?, variants_json),
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND kind = 'video'`,
    )
    .bind(
      input.posterR2Key,
      nextManifest ? JSON.stringify(nextManifest) : null,
      nowMs,
      input.mediaId,
    )
    .run();

  const updated = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!updated) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  return { ok: true, media: updated };
}

export async function prepareFailedVideoRetry(
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly mediaId: number;
    readonly maxVideos?: number;
    readonly nowMs?: number;
  },
): Promise<
  | {
      readonly ok: true;
      readonly intent: MediaUploadIntentRecord;
      readonly media: MediaItemRecord;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422;
      readonly code: string;
      readonly message: string;
    }
> {
  const nowMs = input.nowMs ?? Date.now();
  const maxVideos = input.maxVideos ?? MAX_VIDEOS_PER_TENANT;

  const existing = await getVideoMediaItemById(tenantDb, input.mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Video media item not found." };
  }
  if (existing.kind !== "video") {
    return { ok: false, status: 422, code: "NOT_A_VIDEO", message: "Retry is only supported for videos." };
  }
  if (existing.dbStatus !== "failed") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Cannot retry video in state "${existing.dbStatus}". Only failed videos can be retried.`,
    };
  }

  const intentRow = await tenantDb
    .prepare(
      `SELECT * FROM media_upload_intents
       WHERE media_item_id = ? AND kind = 'video'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.mediaId)
    .first<MediaIntentSqlRow>();

  if (!intentRow) {
    return {
      ok: false,
      status: 409,
      code: "RETRY_SOURCE_EXPIRED",
      message: "No upload intent found for this video. Please upload the video again.",
    };
  }

  try {
    assertTenantR2Key(input.tenantId, intentRow.quarantine_r2_key, ["quarantine"]);
  } catch {
    return {
      ok: false,
      status: 409,
      code: "RETRY_SOURCE_EXPIRED",
      message: "Quarantine source key is invalid.",
    };
  }

  // Atomically re-check 20-video cap + quota and transition back to processing
  const retryBatch = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE media_items
         SET status = 'processing', version = version + 1, updated_at = ?
         WHERE id = ?
           AND kind = 'video'
           AND status = 'failed'
           AND (
             (SELECT COUNT(*) FROM media_items WHERE kind = 'video' AND status != 'failed')
             +
             (SELECT COUNT(*) FROM media_upload_intents
              WHERE kind = 'video'
                AND status IN ('pending_upload', 'uploaded', 'processing')
                AND media_item_id IS NULL)
           ) < ?
           AND EXISTS (
             SELECT 1 FROM storage_usage
             WHERE id = 1 AND (used_bytes + reserved_bytes + ?) <= quota_bytes
           )
         RETURNING id`,
      )
      .bind(nowMs, input.mediaId, maxVideos, intentRow.declared_bytes),
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = reserved_bytes + ?, updated_at = ?
         WHERE id = 1
           AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND status = 'processing')`,
      )
      .bind(intentRow.declared_bytes, nowMs, input.mediaId),
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'processing', reserved_bytes = ?, error_code = NULL, updated_at = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM media_items WHERE id = ? AND status = 'processing')`,
      )
      .bind(intentRow.declared_bytes, nowMs, intentRow.id, input.mediaId),
  ]);

  const transitioned = (retryBatch[0] as D1Result<{ id: number }> | undefined)?.results[0];
  if (!transitioned) {
    const slots = await getVideoSlotUsage(tenantDb, maxVideos);
    if (slots.usedSlots >= maxVideos) {
      return {
        ok: false,
        status: 422,
        code: "VIDEO_LIMIT_REACHED",
        message: `Batas maksimum ${maxVideos} video per situs telah tercapai.`,
      };
    }
    return {
      ok: false,
      status: 422,
      code: "STORAGE_QUOTA_EXCEEDED",
      message: "Storage quota is insufficient to retry processing this video.",
    };
  }

  const [updatedMedia, updatedIntent] = await Promise.all([
    getVideoMediaItemById(tenantDb, input.mediaId),
    getVideoUploadIntentById(tenantDb, intentRow.id),
  ]);

  if (!updatedMedia || !updatedIntent) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Video media item disappeared." };
  }

  return { ok: true, intent: updatedIntent, media: updatedMedia };
}
