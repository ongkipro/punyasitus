import {
  assertTenantR2Key,
  buildQuarantineR2Key,
  generateUlid,
  slugifyMediaFilename,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import type { VideoMetadataManifest } from "@punyasitus/core/media/video";
import type { TenantStatus } from "@punyasitus/core/schemas";
import {
  DEFAULT_UPLOAD_INTENT_TTL_MS,
  ensureMediaPipelineSchema,
  MEDIA_UPLOAD_DAILY_LIMIT,
  MEDIA_UPLOAD_DAY_WINDOW_MS,
  MEDIA_UPLOAD_HOUR_WINDOW_MS,
  MEDIA_UPLOAD_HOURLY_LIMIT,
  resolveStorageQuotaBytes,
  STALE_PROCESSING_TTL_MS,
  type StorageUsageSnapshot,
} from "../storage-usage/index.ts";

/**
 * Per-tenant Media Library repository & published reference protection
 * (REQ-010, REQ-034, REQ-039, REQ-064; PLAN §5.2, §7.1–7.3).
 */

export type MediaIntentStatus =
  | "pending_upload"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

export type MediaItemDbStatus = "processing" | "ready" | "failed" | "quarantined";
export type MediaItemPublicStatus = MediaItemDbStatus | "trashed";

export interface MediaUploadIntentRecord {
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly payloadHash: string | null;
  readonly kind: "image" | "video";
  readonly originalFilename: string;
  readonly slug: string;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  readonly altText: string;
  readonly decorative: boolean;
  readonly quarantineR2Key: string;
  readonly reservedBytes: number;
  readonly mediaItemId: number | null;
  readonly status: MediaIntentStatus;
  readonly errorCode: string | null;
  readonly createdByUserId: string | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MediaItemRecord {
  readonly id: number;
  readonly kind: "image" | "video";
  readonly r2Key: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string;
  readonly decorative: boolean;
  readonly originalFilename: string | null;
  readonly slug: string | null;
  readonly variants: MediaVariantsManifest | null;
  readonly videoMetadata?: VideoMetadataManifest | null;
  readonly durationSeconds?: number | null;
  readonly posterR2Key?: string | null;
  readonly captionsR2Key?: string | null;
  readonly status: MediaItemPublicStatus;
  readonly dbStatus: MediaItemDbStatus;
  readonly deletedAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

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
  readonly status: MediaIntentStatus;
  readonly error_code: string | null;
  readonly created_by_user_id: string | null;
  readonly expires_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface MediaItemSqlRow {
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
  readonly duration_seconds?: number | null;
  readonly poster_r2_key?: string | null;
  readonly captions_r2_key?: string | null;
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

function parseVariantsJson(raw: string | null): MediaVariantsManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MediaVariantsManifest> & { kind?: string };
    if (!parsed || typeof parsed !== "object" || parsed.kind === "video") return null;
    return parsed as MediaVariantsManifest;
  } catch {
    return null;
  }
}

function parseVideoMetadataJson(raw: string | null): VideoMetadataManifest | null {
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

function mapMediaRow(row: MediaItemSqlRow): MediaItemRecord {
  const deletedAt = row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at);
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
    variants: parseVariantsJson(row.variants_json),
    videoMetadata: parseVideoMetadataJson(row.variants_json),
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

export interface CreateMediaUploadIntentInput {
  readonly tenantId: string;
  readonly tenantStatus: TenantStatus;
  readonly filename: string;
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  readonly altText: string;
  readonly decorative?: boolean;
  readonly idempotencyKey?: string | null;
  readonly payloadHash?: string | null;
  readonly createdByUserId?: string | null;
  readonly ttlMs?: number;
  readonly nowMs?: number;
  readonly hourlyLimit?: number;
  readonly dailyLimit?: number;
}

export type CreateMediaUploadIntentResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly intent: MediaUploadIntentRecord;
      readonly usage: StorageUsageSnapshot;
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
      readonly code: "STORAGE_QUOTA_EXCEEDED";
      readonly message: string;
      readonly usage: StorageUsageSnapshot;
    };

/**
 * Atomically checks idempotency, releases expired reservations, enforces rate limits
 * (50/hour, 200/day) and quota (`used + reserved + incoming <= quota`), and inserts
 * the `media_upload_intents` row inside a single `TenantStore` `transactionSync` batch.
 */
export async function createMediaUploadIntent(
  tenantDb: D1Database,
  input: CreateMediaUploadIntentInput,
): Promise<CreateMediaUploadIntentResult> {
  await ensureMediaPipelineSchema(tenantDb);

  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_UPLOAD_INTENT_TTL_MS;
  const expiresAt = nowMs + Math.max(1_000, ttlMs);
  const staleCutoffMs = nowMs - STALE_PROCESSING_TTL_MS;
  const targetQuotaBytes = resolveStorageQuotaBytes(input.tenantStatus);
  const hourlyLimit = input.hourlyLimit ?? MEDIA_UPLOAD_HOURLY_LIMIT;
  const dailyLimit = input.dailyLimit ?? MEDIA_UPLOAD_DAILY_LIMIT;
  const slug = slugifyMediaFilename(input.filename);
  const idempotencyKey = input.idempotencyKey?.trim() || null;

  // 1. Check idempotency key first before consuming quota or rate limit
  if (idempotencyKey) {
    const existing = await tenantDb
      .prepare("SELECT * FROM media_upload_intents WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey)
      .first<MediaIntentSqlRow>();

    if (existing) {
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
      const usageRow = await tenantDb
        .prepare(
          `SELECT used_bytes, reserved_bytes, quota_bytes,
                  hourly_uploads, hourly_window_start,
                  daily_uploads, daily_window_start, updated_at
           FROM storage_usage WHERE id = 1`,
        )
        .first<StorageUsageRow>();
      return {
        ok: true,
        replayed: true,
        intent: mapIntentRow(existing),
        usage: usageRow
          ? mapUsageRow(usageRow)
          : {
              usedBytes: 0,
              reservedBytes: existing.reserved_bytes,
              quotaBytes: targetQuotaBytes,
              availableBytes: Math.max(0, targetQuotaBytes - existing.reserved_bytes),
              percentUsed: 0,
              warningAt80: false,
              hourlyUploads: 1,
              hourlyWindowStart: nowMs,
              dailyUploads: 1,
              dailyWindowStart: nowMs,
              updatedAt: nowMs,
            },
      };
    }
  }

  const intentId = generateUlid(nowMs);
  const quarantineR2Key = buildQuarantineR2Key(input.tenantId, intentId, slug);

  // 2. ONE atomic transactionSync batch:
  //    sync quota -> reap expired/stale -> conditionally insert intent -> reserve bytes ONLY IF inserted!
  //    Zero reservation leak possible if insert fails or quota/rate/idempotency rejects.
  const results = await tenantDb.batch([
    // 0. Ensure storage_usage singleton row
    tenantDb
      .prepare(
        `INSERT OR IGNORE INTO storage_usage
           (id, used_bytes, reserved_bytes, quota_bytes, hourly_uploads, hourly_window_start, daily_uploads, daily_window_start, updated_at)
         VALUES (1, 0, 0, ?, 0, ?, 0, ?, ?)`,
      )
      .bind(targetQuotaBytes, nowMs, nowMs, nowMs),
    // 1. Sync quota bytes to live tenant tier
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET quota_bytes = ?, updated_at = ?
         WHERE id = 1 AND quota_bytes != ?`,
      )
      .bind(targetQuotaBytes, nowMs, targetQuotaBytes),
    // 2. Reclaim expired pending_upload + stale uploaded/processing reservations atomically
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
    // 6. Conditionally insert intent ONLY IF rate limits, quota, and idempotency all pass
    tenantDb
      .prepare(
        `INSERT INTO media_upload_intents (
           id, idempotency_key, payload_hash, kind, original_filename, slug,
           declared_mime, declared_bytes, declared_sha256, alt_text, decorative,
           quarantine_r2_key, reserved_bytes, media_item_id, status, error_code,
           created_by_user_id, expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending_upload', NULL, ?, ?, ?, ?
         WHERE EXISTS (
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
        input.decorative ? 1 : 0,
        quarantineR2Key,
        input.declaredBytes,
        input.createdByUserId ?? null,
        expiresAt,
        nowMs,
        nowMs,
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
    // 7. Atomically reserve bytes & increment counters ONLY IF Stmt 6 inserted the intent!
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
    // 8. Read storage_usage unconditionally for accurate error details
    tenantDb.prepare(
      `SELECT used_bytes, reserved_bytes, quota_bytes,
              hourly_uploads, hourly_window_start,
              daily_uploads, daily_window_start, updated_at
       FROM storage_usage WHERE id = 1`,
    ),
  ]);

  const insertedIntent = (results[6] as D1Result<{ id: string }> | undefined)?.results[0];
  const updatedUsageRow = (results[7] as D1Result<StorageUsageRow> | undefined)?.results[0];

  if (!insertedIntent || !updatedUsageRow) {
    // Check if a concurrent caller inserted the same Idempotency-Key between step 1 and step 6
    if (idempotencyKey) {
      const raced = await tenantDb
        .prepare("SELECT * FROM media_upload_intents WHERE idempotency_key = ? LIMIT 1")
        .bind(idempotencyKey)
        .first<MediaIntentSqlRow>();
      if (raced) {
        if (
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
          usage: currentUsageRow ? mapUsageRow(currentUsageRow) : mapUsageRow({
            used_bytes: 0,
            reserved_bytes: raced.reserved_bytes,
            quota_bytes: targetQuotaBytes,
            hourly_uploads: 1,
            hourly_window_start: nowMs,
            daily_uploads: 1,
            daily_window_start: nowMs,
            updated_at: nowMs,
          }),
        };
      }
    }

    const currentUsageRow = (results[8] as D1Result<StorageUsageRow> | undefined)?.results[0];
    if (!currentUsageRow) {
      throw new Error("STORAGE_USAGE_ROW_MISSING");
    }
    const usage = mapUsageRow(currentUsageRow);
    const hourlyElapsed = nowMs - usage.hourlyWindowStart;
    const nextHourly = hourlyElapsed >= MEDIA_UPLOAD_HOUR_WINDOW_MS ? 1 : usage.hourlyUploads + 1;
    if (nextHourly > hourlyLimit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((usage.hourlyWindowStart + MEDIA_UPLOAD_HOUR_WINDOW_MS - nowMs) / 1000),
      );
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        window: "hourly",
        retryAfterSeconds,
        message: `Upload intent rate limit exceeded (max ${hourlyLimit}/hour).`,
        usage,
      };
    }

    const dailyElapsed = nowMs - usage.dailyWindowStart;
    const nextDaily = dailyElapsed >= MEDIA_UPLOAD_DAY_WINDOW_MS ? 1 : usage.dailyUploads + 1;
    if (nextDaily > dailyLimit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((usage.dailyWindowStart + MEDIA_UPLOAD_DAY_WINDOW_MS - nowMs) / 1000),
      );
      return {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        window: "daily",
        retryAfterSeconds,
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

  const intent: MediaUploadIntentRecord = {
    id: intentId,
    idempotencyKey,
    payloadHash: input.payloadHash ?? null,
    kind: "image",
    originalFilename: input.filename,
    slug,
    declaredMime: input.declaredMime,
    declaredBytes: input.declaredBytes,
    declaredSha256: input.declaredSha256,
    altText: input.altText,
    decorative: Boolean(input.decorative),
    quarantineR2Key,
    reservedBytes: input.declaredBytes,
    mediaItemId: null,
    status: "pending_upload",
    errorCode: null,
    createdByUserId: input.createdByUserId ?? null,
    expiresAt,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  return {
    ok: true,
    replayed: false,
    intent,
    usage: mapUsageRow(updatedUsageRow),
  };
}

export async function getMediaUploadIntent(
  tenantDb: D1Database,
  intentId: string,
): Promise<MediaUploadIntentRecord | null> {
  await ensureMediaPipelineSchema(tenantDb);
  const row = await tenantDb
    .prepare("SELECT * FROM media_upload_intents WHERE id = ? LIMIT 1")
    .bind(intentId)
    .first<MediaIntentSqlRow>();
  return row ? mapIntentRow(row) : null;
}

/**
 * Marks a pending/processing intent failed and atomically releases its reserved bytes.
 */
export async function failMediaUploadIntent(
  tenantDb: D1Database,
  intentId: string,
  errorCode: string,
  nowMs: number = Date.now(),
): Promise<{ readonly releasedBytes: number }> {
  await ensureMediaPipelineSchema(tenantDb);

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
         SET status = 'failed', version = version + 1, updated_at = ?
         WHERE id = (SELECT media_item_id FROM media_upload_intents WHERE id = ?)
           AND status != 'ready'`,
      )
      .bind(nowMs, intentId),
  ]);

  const row = (
    results[0] as D1Result<{ reserved_bytes: number; media_item_id: number | null }> | undefined
  )?.results[0];
  return { releasedBytes: Math.max(0, Number(row?.reserved_bytes ?? 0)) };
}

export interface MarkIntentUploadedInput {
  readonly tenantId: string;
  readonly intentId: string;
  readonly quarantineR2Key: string;
  readonly detectedMime: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly nowMs?: number;
}

export type MarkIntentUploadedResult =
  | { readonly ok: true; readonly mediaId: number; readonly intent: MediaUploadIntentRecord }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 410;
      readonly code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UPLOAD_INTENT_EXPIRED";
      readonly message: string;
    };

/**
 * Transitions a `pending_upload` intent to `processing` and allocates a sequential
 * `media_items` row atomically inside `TenantStore` after the quarantine R2 write succeeds.
 *
 * Enforces:
 * - Strict tenant R2 key validation (rejects foreign object keys)
 * - Intent existence and `pending_upload` state (rejects replay/bypass)
 * - Expiry check (expired intents release their reservation and fail closed with 410)
 */
export async function markUploadIntentQuarantinedAndCreateMedia(
  tenantDb: D1Database,
  input: MarkIntentUploadedInput,
): Promise<MarkIntentUploadedResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const nowMs = input.nowMs ?? Date.now();

  // Strict R2 key boundary check
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

  const intent = await getMediaUploadIntent(tenantDb, input.intentId);
  if (!intent) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Upload intent not found for this tenant.",
    };
  }

  if (intent.quarantineR2Key !== input.quarantineR2Key) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Object key does not match the authorized upload intent.",
    };
  }

  if (intent.status !== "pending_upload") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Upload intent is already in state "${intent.status}".`,
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
      message: "Upload intent has expired; storage reservation was released.",
    };
  }

  // Atomically claim the intent and allocate a non-reusable sequential media ID (PLAN §7.1)
  const claimAndAllocate = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = 'uploaded', updated_at = ?
         WHERE id = ? AND status = 'pending_upload' AND expires_at > ?
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
      message: "Upload intent was concurrently consumed or expired.",
    };
  }

  const allocatedSeq = (claimAndAllocate[1] as D1Result<{ next: number }> | undefined)?.results[0];
  const mediaId = Number(allocatedSeq?.next ?? 0);
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new Error("FAILED_TO_ALLOCATE_MEDIA_SEQUENCE");
  }

  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT INTO media_items (
           id, kind, r2_key, mime_type, bytes, sha256, width, height,
           alt_text, variants_json, status, deleted_at, original_filename,
           slug, decorative, version, created_at, updated_at
         ) VALUES (?, 'image', ?, ?, 0, ?, ?, ?, ?, NULL, 'processing', NULL, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        mediaId,
        intent.quarantineR2Key,
        input.detectedMime,
        input.sha256,
        input.width,
        input.height,
        intent.altText,
        intent.originalFilename,
        intent.slug,
        intent.decorative ? 1 : 0,
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

export interface FinalizeProcessedMediaInput {
  readonly tenantId: string;
  readonly mediaId: number;
  readonly intentId: string;
  readonly masterR2Key: string;
  readonly normalizedMasterBytes: number;
  readonly masterSha256: string;
  readonly masterWidth: number;
  readonly masterHeight: number;
  readonly variants: MediaVariantsManifest;
  readonly nowMs?: number;
}

export type FinalizeProcessedMediaResult =
  | { readonly ok: true; readonly alreadyReady: boolean; readonly media: MediaItemRecord }
  | {
      readonly ok: false;
      readonly code: "NOT_FOUND" | "STORAGE_QUOTA_EXCEEDED" | "INVALID_R2_KEY";
      readonly message: string;
    };

/**
 * Atomically transitions a processed media item to `ready` and reconciles
 * `storage_usage`: replaces the intent's `reserved_bytes` with the exact
 * normalized stored master bytes (`<= 2,000,000`), verifying quota invariant.
 *
 * Strictly idempotent: retrying on an already-`ready` media record returns
 * `{ ok: true, alreadyReady: true }` without double-counting `used_bytes`.
 */
export async function finalizeProcessedMediaAtomically(
  tenantDb: D1Database,
  input: FinalizeProcessedMediaInput,
): Promise<FinalizeProcessedMediaResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const nowMs = input.nowMs ?? Date.now();

  try {
    assertTenantR2Key(input.tenantId, input.masterR2Key, ["media"]);
    assertTenantR2Key(input.tenantId, input.variants.master.key, ["media"]);
    assertTenantR2Key(input.tenantId, input.variants.w640.key, ["media"]);
    assertTenantR2Key(input.tenantId, input.variants.w1280.key, ["media"]);
    assertTenantR2Key(input.tenantId, input.variants.thumb.key, ["media"]);
    assertTenantR2Key(input.tenantId, input.variants.og.key, ["media"]);
  } catch {
    return {
      ok: false,
      code: "INVALID_R2_KEY",
      message: "Derived media keys failed tenant R2 key validation.",
    };
  }

  const existing = await getMediaItemById(tenantDb, input.mediaId);
  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Media item #${input.mediaId} does not exist.`,
    };
  }

  // Idempotent retry: already finalized -> zero double-counting!
  if (existing.dbStatus === "ready") {
    return { ok: true, alreadyReady: true, media: existing };
  }

  // Execute ALL THREE updates inside ONE SINGLE atomic `tenantDb.batch()` (`transactionSync`):
  // 0. Transition `media_items` to `ready` ONLY IF not already ready AND quota fits.
  // 1. Swap `storage_usage` (`used_bytes += normalizedMasterBytes`, `reserved_bytes -= intent.reserved_bytes`)
  //    ONLY IF `media_items` is now `ready` AND `media_upload_intents` has not yet been completed.
  // 2. Mark `media_upload_intents` as `completed` with `reserved_bytes = 0` ONLY IF `media_items` is `ready`.
  // Concurrent/retried workers can NEVER double-count `used_bytes` or corrupt other intents' `reserved_bytes`.
  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE media_items
         SET r2_key = ?,
             mime_type = 'image/webp',
             bytes = ?,
             sha256 = ?,
             width = ?,
             height = ?,
             variants_json = ?,
             status = 'ready',
             version = version + 1,
             updated_at = ?
         WHERE id = ?
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
        input.masterR2Key,
        input.normalizedMasterBytes,
        input.masterSha256,
        input.masterWidth,
        input.masterHeight,
        JSON.stringify(input.variants),
        nowMs,
        input.mediaId,
        input.intentId,
        input.normalizedMasterBytes,
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
        input.normalizedMasterBytes,
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

  const mediaTransitioned = (results[0] as D1Result<{ id: number }> | undefined)?.results[0];
  if (!mediaTransitioned) {
    // Re-check whether a concurrent worker just marked it ready (idempotent win!)
    const rechecked = await getMediaItemById(tenantDb, input.mediaId);
    if (rechecked && rechecked.dbStatus === "ready") {
      return { ok: true, alreadyReady: true, media: rechecked };
    }
    return {
      ok: false,
      code: "STORAGE_QUOTA_EXCEEDED",
      message: "Normalized media bytes exceed tenant storage quota.",
    };
  }

  const finalized = await getMediaItemById(tenantDb, input.mediaId);
  if (!finalized) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Media item #${input.mediaId} disappeared after finalize.`,
    };
  }

  return { ok: true, alreadyReady: false, media: finalized };
}

// ---------------------------------------------------------------------------
// Media Queries, Metadata Update, Published Reference Protection & Deletion
// ---------------------------------------------------------------------------

export async function getMediaItemById(
  tenantDb: D1Database,
  mediaId: number,
): Promise<MediaItemRecord | null> {
  await ensureMediaPipelineSchema(tenantDb);
  const row = await tenantDb
    .prepare(
      `SELECT id, kind, r2_key, mime_type, bytes, sha256, width, height,
              alt_text, variants_json, duration_seconds, poster_r2_key, captions_r2_key,
              status, deleted_at, original_filename, slug, decorative,
              version, created_at, updated_at
       FROM media_items WHERE id = ? LIMIT 1`,
    )
    .bind(mediaId)
    .first<MediaItemSqlRow>();
  return row ? mapMediaRow(row) : null;
}

export interface ListMediaItemsOptions {
  readonly cursorId?: number | null;
  readonly limit?: number;
  readonly includeTrashed?: boolean;
  readonly status?: MediaItemPublicStatus;
  readonly kind?: "image" | "video";
}

export interface ListMediaItemsResult {
  readonly items: readonly MediaItemRecord[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

export async function listMediaItems(
  tenantDb: D1Database,
  options: ListMediaItemsOptions = {},
): Promise<ListMediaItemsResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const whereClauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (options.kind === "image" || options.kind === "video") {
    whereClauses.push("kind = ?");
    bindings.push(options.kind);
  }

  if (options.status === "trashed") {
    whereClauses.push("deleted_at IS NOT NULL");
  } else if (options.status) {
    whereClauses.push("deleted_at IS NULL AND status = ?");
    bindings.push(options.status);
  } else if (!options.includeTrashed) {
    whereClauses.push("deleted_at IS NULL");
  }

  if (options.cursorId && Number.isInteger(options.cursorId) && options.cursorId > 0) {
    whereClauses.push("id < ?");
    bindings.push(options.cursorId);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const query = `SELECT id, kind, r2_key, mime_type, bytes, sha256, width, height,
                        alt_text, variants_json, duration_seconds, poster_r2_key, captions_r2_key,
                        status, deleted_at, original_filename, slug, decorative,
                        version, created_at, updated_at
                 FROM media_items
                 ${whereSql}
                 ORDER BY id DESC
                 LIMIT ?`;
  bindings.push(limit + 1);

  const res = await tenantDb
    .prepare(query)
    .bind(...bindings)
    .all<MediaItemSqlRow>();

  const hasMore = res.results.length > limit;
  const sliced = hasMore ? res.results.slice(0, limit) : res.results;
  const items = sliced.map(mapMediaRow);
  const lastItem = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && lastItem ? String(lastItem.id) : null,
    hasMore,
    limit,
  };
}

export type UpdateMediaMetadataResult =
  | { readonly ok: true; readonly media: MediaItemRecord }
  | { readonly ok: false; readonly status: 404 | 409; readonly code: "NOT_FOUND" | "STALE_VERSION"; readonly message: string };

export async function updateMediaMetadata(
  tenantDb: D1Database,
  input: {
    readonly mediaId: number;
    readonly altText: string;
    readonly decorative?: boolean;
    readonly version: number;
    readonly nowMs?: number;
  },
): Promise<UpdateMediaMetadataResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const nowMs = input.nowMs ?? Date.now();
  const existing = await getMediaItemById(tenantDb, input.mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }

  const decorativeVal = input.decorative !== undefined ? (input.decorative ? 1 : 0) : existing.decorative ? 1 : 0;
  const res = await tenantDb
    .prepare(
      `UPDATE media_items
       SET alt_text = ?, decorative = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(input.altText, decorativeVal, nowMs, input.mediaId, input.version)
    .run();

  if (res.meta.changes === 0) {
    return {
      ok: false,
      status: 409,
      code: "STALE_VERSION",
      message: "Media item was concurrently modified; reload and retry.",
    };
  }

  const updated = await getMediaItemById(tenantDb, input.mediaId);
  if (!updated) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  return { ok: true, media: updated };
}

export interface PublishedMediaReference {
  readonly resourceType: "site_settings" | "page" | "post" | "offering" | "author";
  readonly resourceId: number;
  readonly field: string;
}

function jsonContainsMediaId(rawJson: string | null | undefined, mediaId: number, mediaR2Key?: string): boolean {
  if (!rawJson) return false;
  if (mediaR2Key && rawJson.includes(mediaR2Key)) return true;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const visit = (node: unknown, parentKey?: string): boolean => {
      if (node === null || node === undefined) return false;
      if (typeof node === "number") {
        if (
          node === mediaId &&
          parentKey !== undefined &&
          /mediaid|media_id|logomediaid|faviconmediaid|ogimagemediaid|defaultogmediaid|covermediaid|avatarmediaid|featuredmediaid/i.test(
            parentKey,
          )
        ) {
          return true;
        }
        return false;
      }
      if (typeof node === "string") {
        return Boolean(mediaR2Key && node.includes(mediaR2Key));
      }
      if (Array.isArray(node)) {
        if (parentKey && /gallerymediaids|gallery_media_ids/i.test(parentKey)) {
          if (node.includes(mediaId)) return true;
        }
        return node.some((item) => visit(item));
      }
      if (typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (visit(v, k)) return true;
        }
      }
      return false;
    };
    return visit(parsed);
  } catch {
    return false;
  }
}

/**
 * Checks whether a media ID is referenced by ANY published tenant resource:
 * - `site_settings` (`favicon_media_id`, `og_image_media_id`, or `published_json`)
 * - published `pages` (`published_sections_json`, `seo_json`)
 * - published `posts` (`cover_media_id`, `published_body_json`, `seo_json`)
 * - published `offerings` (`cover_media_id`, `video_media_id`, `gallery_media_ids_json`, `published_snapshot_json`, `seo_json`)
 * - `authors` referenced by published posts (`avatar_media_id`)
 */
export async function findPublishedMediaReferences(
  tenantDb: D1Database,
  mediaId: number,
  mediaR2Key?: string,
): Promise<readonly PublishedMediaReference[]> {
  const refs: PublishedMediaReference[] = [];

  const [settingsRow, pagesRes, postsRes, offeringsRes, authorRef] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT id, favicon_media_id, og_image_media_id, published_json, published_at
         FROM site_settings WHERE id = 1 LIMIT 1`,
      )
      .first<{
        id: number;
        favicon_media_id: number | null;
        og_image_media_id: number | null;
        published_json: string | null;
        published_at: number | null;
      }>(),
    tenantDb
      .prepare(
        `SELECT id, published_sections_json, seo_json
         FROM pages
         WHERE status = 'published' AND deleted_at IS NULL`,
      )
      .all<{
        id: number;
        published_sections_json: string | null;
        seo_json: string | null;
      }>(),
    tenantDb
      .prepare(
        `SELECT id, cover_media_id, published_body_json, seo_json
         FROM posts
         WHERE status = 'published' AND deleted_at IS NULL`,
      )
      .all<{
        id: number;
        cover_media_id: number | null;
        published_body_json: string | null;
        seo_json: string | null;
      }>(),
    tenantDb
      .prepare(
        `SELECT id, cover_media_id, video_media_id, gallery_media_ids_json, published_snapshot_json, seo_json
         FROM offerings
         WHERE status = 'published' AND deleted_at IS NULL`,
      )
      .all<{
        id: number;
        cover_media_id: number | null;
        video_media_id: number | null;
        gallery_media_ids_json: string | null;
        published_snapshot_json: string | null;
        seo_json: string | null;
      }>(),
    tenantDb
      .prepare(
        `SELECT a.id
         FROM authors a
         INNER JOIN posts p ON p.author_id = a.id
         WHERE a.avatar_media_id = ? AND p.status = 'published' AND p.deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(mediaId)
      .first<{ id: number }>(),
  ]);

  if (settingsRow) {
    if (settingsRow.favicon_media_id === mediaId) {
      refs.push({ resourceType: "site_settings", resourceId: settingsRow.id, field: "favicon_media_id" });
    }
    if (settingsRow.og_image_media_id === mediaId) {
      refs.push({ resourceType: "site_settings", resourceId: settingsRow.id, field: "og_image_media_id" });
    }
    if (jsonContainsMediaId(settingsRow.published_json, mediaId, mediaR2Key)) {
      refs.push({ resourceType: "site_settings", resourceId: settingsRow.id, field: "published_json" });
    }
  }

  for (const page of pagesRes.results) {
    if (
      jsonContainsMediaId(page.published_sections_json, mediaId, mediaR2Key) ||
      jsonContainsMediaId(page.seo_json, mediaId, mediaR2Key)
    ) {
      refs.push({ resourceType: "page", resourceId: page.id, field: "published_sections_json" });
    }
  }

  for (const post of postsRes.results) {
    if (post.cover_media_id === mediaId) {
      refs.push({ resourceType: "post", resourceId: post.id, field: "cover_media_id" });
    } else if (
      jsonContainsMediaId(post.published_body_json, mediaId, mediaR2Key) ||
      jsonContainsMediaId(post.seo_json, mediaId, mediaR2Key)
    ) {
      refs.push({ resourceType: "post", resourceId: post.id, field: "published_body_json" });
    }
  }

  for (const offering of offeringsRes.results) {
    let inGallery = false;
    if (offering.gallery_media_ids_json) {
      try {
        const parsed: unknown = JSON.parse(offering.gallery_media_ids_json);
        if (Array.isArray(parsed) && parsed.includes(mediaId)) {
          inGallery = true;
        }
      } catch {
        // ignore malformed JSON
      }
    }
    if (offering.cover_media_id === mediaId) {
      refs.push({ resourceType: "offering", resourceId: offering.id, field: "cover_media_id" });
    } else if (offering.video_media_id === mediaId) {
      refs.push({ resourceType: "offering", resourceId: offering.id, field: "video_media_id" });
    } else if (inGallery) {
      refs.push({ resourceType: "offering", resourceId: offering.id, field: "gallery_media_ids_json" });
    } else if (
      jsonContainsMediaId(offering.published_snapshot_json, mediaId, mediaR2Key) ||
      jsonContainsMediaId(offering.seo_json, mediaId, mediaR2Key)
    ) {
      refs.push({ resourceType: "offering", resourceId: offering.id, field: "published_snapshot_json" });
    }
  }

  if (authorRef) {
    refs.push({ resourceType: "author", resourceId: authorRef.id, field: "avatar_media_id" });
  }

  return refs;
}

export type TrashMediaResult =
  | { readonly ok: true; readonly media: MediaItemRecord }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: "NOT_FOUND" | "MEDIA_IN_USE";
      readonly message: string;
      readonly references?: readonly PublishedMediaReference[];
    };

/**
 * Soft-deletes (`trashes`) a media item.
 * - Blocks with `409 MEDIA_IN_USE` if referenced by any published resource.
 * - Preserves `storage_usage.used_bytes` unchanged (REQ-064: trashed media counts until purge).
 */
export async function trashMediaItem(
  tenantDb: D1Database,
  mediaId: number,
  nowMs: number = Date.now(),
): Promise<TrashMediaResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const existing = await getMediaItemById(tenantDb, mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }

  const references = await findPublishedMediaReferences(tenantDb, mediaId, existing.r2Key);
  if (references.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "MEDIA_IN_USE",
      message: "Media item is currently referenced by published content and cannot be deleted.",
      references,
    };
  }

  if (existing.deletedAt !== null) {
    return { ok: true, media: existing };
  }

  await tenantDb
    .prepare(
      `UPDATE media_items
       SET deleted_at = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(nowMs, nowMs, mediaId)
    .run();

  const updated = await getMediaItemById(tenantDb, mediaId);
  if (!updated) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  return { ok: true, media: updated };
}

export type RestoreMediaResult =
  | { readonly ok: true; readonly media: MediaItemRecord }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: "NOT_FOUND" | "CONFLICT" | "STALE_VERSION";
      readonly message: string;
    };

export async function restoreTrashedMediaItem(
  tenantDb: D1Database,
  mediaId: number,
  version?: number,
  nowMs: number = Date.now(),
): Promise<RestoreMediaResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const existing = await getMediaItemById(tenantDb, mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  if (existing.deletedAt === null) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Media item is not in trash.",
    };
  }

  const res =
    version !== undefined
      ? await tenantDb
          .prepare(
            `UPDATE media_items
             SET deleted_at = NULL, version = version + 1, updated_at = ?
             WHERE id = ? AND deleted_at IS NOT NULL AND version = ?`,
          )
          .bind(nowMs, mediaId, version)
          .run()
      : await tenantDb
          .prepare(
            `UPDATE media_items
             SET deleted_at = NULL, version = version + 1, updated_at = ?
             WHERE id = ? AND deleted_at IS NOT NULL`,
          )
          .bind(nowMs, mediaId)
          .run();

  if (res.meta.changes === 0) {
    return {
      ok: false,
      status: 409,
      code: "STALE_VERSION",
      message: "Media item version is stale.",
    };
  }

  const restored = await getMediaItemById(tenantDb, mediaId);
  if (!restored) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }
  return { ok: true, media: restored };
}

export interface MediaR2DeleteLike {
  delete(keys: string | string[]): Promise<void>;
}

export type PurgeMediaResult =
  | { readonly ok: true; readonly freedBytes: number; readonly deletedR2Keys: readonly string[] }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: "NOT_FOUND" | "MEDIA_IN_USE";
      readonly message: string;
      readonly references?: readonly PublishedMediaReference[];
    };

export function collectMediaR2Keys(tenantId: string, media: MediaItemRecord): string[] {
  const keys = new Set<string>();
  try {
    assertTenantR2Key(tenantId, media.r2Key, ["media", "quarantine", "trash"]);
    keys.add(media.r2Key);
  } catch {
    // Ignore non-tenant keys defensively
  }
  if (media.variants) {
    for (const entry of [
      media.variants.master,
      media.variants.w640,
      media.variants.w1280,
      media.variants.thumb,
      media.variants.og,
    ]) {
      try {
        assertTenantR2Key(tenantId, entry.key, ["media", "trash"]);
        keys.add(entry.key);
      } catch {
        // Ignore non-tenant keys defensively
      }
    }
  }
  for (const extraKey of [media.posterR2Key, media.captionsR2Key]) {
    if (!extraKey) continue;
    try {
      assertTenantR2Key(tenantId, extraKey, ["media", "trash"]);
      keys.add(extraKey);
    } catch {
      // Ignore non-tenant keys defensively
    }
  }
  return [...keys];
}

/**
 * Permanently purges a media item, removing all tenant-scoped R2 objects first,
 * deleting the `media_items` row, and decrementing `storage_usage.used_bytes` atomically.
 *
 * Blocks with `409 MEDIA_IN_USE` if referenced by any published resource (or active FK row).
 */
export async function purgeMediaItem(
  tenantDb: D1Database,
  options: {
    readonly tenantId: string;
    readonly mediaId: number;
    readonly mediaBucket?: MediaR2DeleteLike | null;
    readonly nowMs?: number;
  },
): Promise<PurgeMediaResult> {
  await ensureMediaPipelineSchema(tenantDb);
  const nowMs = options.nowMs ?? Date.now();
  const existing = await getMediaItemById(tenantDb, options.mediaId);
  if (!existing) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Media item not found." };
  }

  const references = await findPublishedMediaReferences(tenantDb, options.mediaId, existing.r2Key);
  if (references.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "MEDIA_IN_USE",
      message: "Media item is currently referenced by published content and cannot be purged.",
      references,
    };
  }

  // Also check any direct FK references (draft posts/offerings/authors) so SQLite FK delete never fails mid-purge
  const [authorFk, postFk, offeringFk] = await Promise.all([
    tenantDb
      .prepare("SELECT id FROM authors WHERE avatar_media_id = ? LIMIT 1")
      .bind(options.mediaId)
      .first<{ id: number }>(),
    tenantDb
      .prepare("SELECT id FROM posts WHERE cover_media_id = ? LIMIT 1")
      .bind(options.mediaId)
      .first<{ id: number }>(),
    tenantDb
      .prepare(
        "SELECT id FROM offerings WHERE cover_media_id = ? OR video_media_id = ? LIMIT 1",
      )
      .bind(options.mediaId, options.mediaId)
      .first<{ id: number }>(),
  ]);

  if (authorFk || postFk || offeringFk) {
    return {
      ok: false,
      status: 409,
      code: "MEDIA_IN_USE",
      message: "Media item is still linked to an existing content record.",
    };
  }

  const keysToDelete = collectMediaR2Keys(options.tenantId, existing);
  if (options.mediaBucket && keysToDelete.length > 0) {
    await options.mediaBucket.delete(keysToDelete);
  }

  const freedBytes = existing.dbStatus === "ready" ? Math.max(0, existing.bytes) : 0;

  // Atomically release any remaining reserved_bytes on linked intents (e.g. purging a `processing` item),
  // fail/unlink those intents, delete the media row, and decrement used_bytes.
  await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE storage_usage
         SET reserved_bytes = MAX(0, reserved_bytes - COALESCE((
               SELECT SUM(reserved_bytes)
               FROM media_upload_intents
               WHERE media_item_id = ? AND reserved_bytes > 0
             ), 0)),
             used_bytes = MAX(0, used_bytes - ?),
             updated_at = ?
         WHERE id = 1`,
      )
      .bind(options.mediaId, freedBytes, nowMs),
    tenantDb
      .prepare(
        `UPDATE media_upload_intents
         SET status = CASE WHEN status IN ('pending_upload', 'uploaded', 'processing') THEN 'failed' ELSE status END,
             error_code = CASE WHEN status IN ('pending_upload', 'uploaded', 'processing') THEN 'PURGED_BEFORE_READY' ELSE error_code END,
             reserved_bytes = 0,
             media_item_id = NULL,
             updated_at = ?
         WHERE media_item_id = ?`,
      )
      .bind(nowMs, options.mediaId),
    tenantDb.prepare("DELETE FROM media_items WHERE id = ?").bind(options.mediaId),
  ]);

  return {
    ok: true,
    freedBytes,
    deletedR2Keys: keysToDelete,
  };
}
