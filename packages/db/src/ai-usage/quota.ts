import {
  AI_WRITING_BURST_PER_TENANT_MINUTE,
  AI_WRITING_BURST_PER_USER_MINUTE,
  AI_WRITING_BURST_WINDOW_MS,
  AI_WRITING_QUOTA_LIMIT,
  AI_WRITING_QUOTA_WINDOW_DAYS,
  AI_WRITING_QUOTA_WINDOW_MS,
  AI_WRITING_VERTICALS,
  buildAiWritingAuditMetadata,
  type AiWritingAuditMetadataInput,
  type AiWritingFieldKind,
  type AiWritingQuotaStatus,
  type AiWritingVertical,
} from "@punyasitus/core/ai-writing/index";

/**
 * Atomic 30-day rolling AI writing quota ledger & per-minute burst rate limiter
 * backed by `PLATFORM_DB` (`0029_ai_writing_usage.sql`).
 *
 * Concurrency & cost-protection invariants:
 * - `reserveAiWritingQuotaSlot` executes a single atomic `INSERT ... SELECT ... WHERE (COUNT < 100)`
 *   statement so concurrent requests at the 99/100 boundary NEVER exceed 100 slots.
 * - Stale uncompleted reservations older than `AI_WRITING_RESERVATION_TTL_MS` (2 min) expire
 *   automatically so crashed Workers never permanently leak quota.
 * - Failed provider calls immediately transition the reservation row to `'failed'` (or `'refunded'`)
 *   via `releaseAiWritingQuotaSlot`, freeing the quota slot immediately so failed calls consume ZERO quota.
 * - Zero prompt text or suggestion text is ever persisted in `ai_writing_usage` or `platform_audit`.
 */

export const AI_WRITING_RESERVATION_TTL_MS = 120_000 as const;
export const AI_WRITING_USAGE_RETENTION_DAYS = 90 as const;
export const AI_WRITING_USAGE_RETENTION_MS = AI_WRITING_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const AI_WRITING_RATE_BUCKET_TTL_MS = 60 * 60 * 1000;
export const AI_WRITING_PRUNE_BATCH_LIMIT = 50 as const;

export interface AiWritingQuotaReservationAllowed {
  readonly allowed: true;
  readonly usageId: string;
  readonly quota: AiWritingQuotaStatus;
}

export interface AiWritingQuotaReservationExceeded {
  readonly allowed: false;
  readonly code: "AI_QUOTA_EXCEEDED";
  readonly quota: AiWritingQuotaStatus;
  readonly retryAfterSeconds: number;
  readonly message: string;
}

export type ReserveAiWritingQuotaResult =
  | AiWritingQuotaReservationAllowed
  | AiWritingQuotaReservationExceeded;

export interface AiWritingBurstLimitAllowed {
  readonly allowed: true;
  readonly userRemaining: number;
  readonly tenantRemaining: number;
}

export interface AiWritingBurstLimitExceeded {
  readonly allowed: false;
  readonly code: "AI_RATE_LIMITED";
  readonly scope: "user" | "tenant";
  readonly retryAfterSeconds: number;
  readonly resetAt: string;
  readonly message: string;
}

export type ConsumeAiWritingBurstResult =
  | AiWritingBurstLimitAllowed
  | AiWritingBurstLimitExceeded;

export interface AiWritingBurstPolicy {
  readonly perUserPerMinute?: number;
  readonly perTenantPerMinute?: number;
  readonly windowMs?: number;
}

export function createAiUsageId(): string {
  try {
    return `aiu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  } catch {
    return `aiu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function createAuditId(): string {
  try {
    return `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  } catch {
    return `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function formatIndonesianResetTime(iso: string | null): string {
  if (!iso) return "dalam 30 hari";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(d) + " WIB";
  } catch {
    return iso;
  }
}

export function buildQuotaExceededMessageId(nextResetAt: string | null, limit: number): string {
  const resetHint = nextResetAt
    ? ` Slot kuota berikutnya tersedia pada ${formatIndonesianResetTime(nextResetAt)}.`
    : "";
  return `Kuota bantuan tulis AI (${limit}/${limit} saran dalam 30 hari terakhir) telah habis untuk situs ini.${resetHint}`;
}

/**
 * Loads the authoritative `vertical` from `PLATFORM_DB.tenants` for the verified tenant.
 */
export async function loadTenantVertical(
  platformDb: D1Database,
  tenantId: string,
): Promise<AiWritingVertical | null> {
  const row = await platformDb
    .prepare("SELECT vertical FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ vertical: string }>();

  if (!row || typeof row.vertical !== "string") return null;
  const candidate = row.vertical as AiWritingVertical;
  return (AI_WRITING_VERTICALS as readonly string[]).includes(candidate) ? candidate : "compro";
}

/**
 * Computes the tenant's active 30-day rolling quota usage and exact next reset timestamp.
 */
export async function getAiWritingQuotaStatus(
  platformDb: D1Database,
  tenantId: string,
  options: {
    readonly nowMs?: number;
    readonly limit?: number;
    readonly windowMs?: number;
  } = {},
): Promise<AiWritingQuotaStatus> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? AI_WRITING_QUOTA_LIMIT;
  const windowMs = options.windowMs ?? AI_WRITING_QUOTA_WINDOW_MS;
  const windowStartMs = nowMs - windowMs;
  const staleReservationCutoffMs = nowMs - AI_WRITING_RESERVATION_TTL_MS;

  const agg = await platformDb
    .prepare(
      `SELECT
         COUNT(*) AS active_count,
         MIN(created_at) AS oldest_created_at
       FROM ai_writing_usage
       WHERE tenant_id = ?
         AND (
           (status = 'succeeded' AND created_at > ?)
           OR (status = 'reserved' AND created_at > ?)
         )`,
    )
    .bind(tenantId, windowStartMs, staleReservationCutoffMs)
    .first<{ active_count: number | null; oldest_created_at: number | null }>();

  const used = Math.max(0, Number(agg?.active_count ?? 0));
  const remaining = Math.max(0, limit - used);
  const oldestMs =
    typeof agg?.oldest_created_at === "number" && Number.isFinite(agg.oldest_created_at)
      ? agg.oldest_created_at
      : null;

  const nextResetAt =
    used > 0 && oldestMs !== null ? new Date(oldestMs + windowMs).toISOString() : null;

  return {
    used,
    limit,
    remaining,
    windowDays: AI_WRITING_QUOTA_WINDOW_DAYS,
    nextResetAt,
  };
}

/**
 * Opportunistically prunes up to `batchLimit` metadata rows in `ai_writing_usage`
 * strictly older than 90 days (`AI_WRITING_USAGE_RETENTION_MS`).
 */
export async function pruneExpiredAiWritingUsage(
  platformDb: D1Database,
  options: {
    readonly nowMs?: number;
    readonly retentionMs?: number;
    readonly batchLimit?: number;
  } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.retentionMs ?? AI_WRITING_USAGE_RETENTION_MS);
  const limit = Math.max(1, Math.min(500, Math.round(options.batchLimit ?? AI_WRITING_PRUNE_BATCH_LIMIT)));

  const res = await platformDb
    .prepare(
      `DELETE FROM ai_writing_usage
       WHERE id IN (
         SELECT id FROM ai_writing_usage
         WHERE created_at < ?
         LIMIT ?
       )`,
    )
    .bind(cutoffMs, limit)
    .run();

  return Number(res.meta?.changes ?? 0);
}

/**
 * Opportunistically prunes up to `batchLimit` expired burst rate-limit buckets
 * strictly older than 1 hour (`AI_WRITING_RATE_BUCKET_TTL_MS`).
 */
export async function pruneExpiredAiWritingRateBuckets(
  platformDb: D1Database,
  options: {
    readonly nowMs?: number;
    readonly ttlMs?: number;
    readonly batchLimit?: number;
  } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.ttlMs ?? AI_WRITING_RATE_BUCKET_TTL_MS);
  const limit = Math.max(1, Math.min(500, Math.round(options.batchLimit ?? AI_WRITING_PRUNE_BATCH_LIMIT)));

  const res = await platformDb
    .prepare(
      `DELETE FROM ai_writing_rate_buckets
       WHERE bucket_key IN (
         SELECT bucket_key FROM ai_writing_rate_buckets
         WHERE updated_at < ?
         LIMIT ?
       )`,
    )
    .bind(cutoffMs, limit)
    .run();

  return Number(res.meta?.changes ?? 0);
}

/**
 * Atomically reserves 1 quota slot in `ai_writing_usage` if the tenant's active trailing 30-day
 * count is strictly below `limit` (default `100`, DEC-028).
 *
 * Executes as a single atomic SQLite `INSERT ... SELECT ... WHERE (COUNT < limit)` so
 * concurrent requests can NEVER push active usage past `100`.
 */
export async function reserveAiWritingQuotaSlot(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly fieldKind: AiWritingFieldKind;
    readonly vertical: AiWritingVertical;
    readonly requestId: string;
    readonly usageId?: string;
    readonly nowMs?: number;
    readonly limit?: number;
    readonly windowMs?: number;
  },
): Promise<ReserveAiWritingQuotaResult> {
  const nowMs = input.nowMs ?? Date.now();
  const limit = input.limit ?? AI_WRITING_QUOTA_LIMIT;
  const windowMs = input.windowMs ?? AI_WRITING_QUOTA_WINDOW_MS;
  const windowStartMs = nowMs - windowMs;
  const staleReservationCutoffMs = nowMs - AI_WRITING_RESERVATION_TTL_MS;
  const usageId = input.usageId ?? createAiUsageId();

  // Bounded opportunistic pruning of >90-day usage metadata rows (best-effort)
  await pruneExpiredAiWritingUsage(platformDb, { nowMs }).catch(() => undefined);

  const insertResult = await platformDb
    .prepare(
      `INSERT INTO ai_writing_usage (
         id, tenant_id, actor_user_id, field_kind, vertical, status, request_id, created_at
       )
       SELECT ?, ?, ?, ?, ?, 'reserved', ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM ai_writing_usage
         WHERE tenant_id = ?
           AND (
             (status = 'succeeded' AND created_at > ?)
             OR (status = 'reserved' AND created_at > ?)
           )
       ) < ?`,
    )
    .bind(
      usageId,
      input.tenantId,
      input.actorUserId,
      input.fieldKind,
      input.vertical,
      input.requestId,
      nowMs,
      input.tenantId,
      windowStartMs,
      staleReservationCutoffMs,
      limit,
    )
    .run();

  const changes = Number(insertResult.meta?.changes ?? 0);
  const quota = await getAiWritingQuotaStatus(platformDb, input.tenantId, {
    nowMs,
    limit,
    windowMs,
  });

  if (changes === 1) {
    return {
      allowed: true,
      usageId,
      quota,
    };
  }

  const resetMs = quota.nextResetAt ? Date.parse(quota.nextResetAt) : nowMs + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));

  return {
    allowed: false,
    code: "AI_QUOTA_EXCEEDED",
    quota: {
      ...quota,
      remaining: 0,
    },
    retryAfterSeconds,
    message: buildQuotaExceededMessageId(quota.nextResetAt, limit),
  };
}

/**
 * Finalizes a reserved slot as `'succeeded'` after a valid provider suggestion is produced.
 */
export async function commitAiWritingQuotaSlot(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly usageId: string;
    readonly model: string;
    readonly tokenCount: number | null;
    readonly latencyMs: number;
    readonly nowMs?: number;
  },
): Promise<boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const res = await platformDb
    .prepare(
      `UPDATE ai_writing_usage
       SET status = 'succeeded',
           model = ?,
           token_count = ?,
           latency_ms = ?,
           completed_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND status = 'reserved'`,
    )
    .bind(
      input.model,
      input.tokenCount,
      Math.max(0, Math.round(input.latencyMs)),
      nowMs,
      input.usageId,
      input.tenantId,
    )
    .run();

  return Number(res.meta?.changes ?? 0) === 1;
}

/**
 * Releases/refunds a reserved slot on provider error or timeout so failed calls consume ZERO quota.
 */
export async function releaseAiWritingQuotaSlot(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly usageId: string;
    readonly errorCode: string;
    readonly model?: string | null;
    readonly latencyMs?: number | null;
    readonly nowMs?: number;
  },
): Promise<boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const res = await platformDb
    .prepare(
      `UPDATE ai_writing_usage
       SET status = 'failed',
           model = COALESCE(?, model),
           latency_ms = ?,
           error_code = ?,
           completed_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND status = 'reserved'`,
    )
    .bind(
      input.model ?? null,
      input.latencyMs !== undefined && input.latencyMs !== null
        ? Math.max(0, Math.round(input.latencyMs))
        : null,
      input.errorCode.slice(0, 48),
      nowMs,
      input.usageId,
      input.tenantId,
    )
    .run();

  return Number(res.meta?.changes ?? 0) === 1;
}

async function incrementBucketAtomic(
  platformDb: D1Database,
  bucketKey: string,
  windowStart: number,
  nowMs: number,
): Promise<number> {
  const row = await platformDb
    .prepare(
      `INSERT INTO ai_writing_rate_buckets (bucket_key, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE
           WHEN ai_writing_rate_buckets.window_start = excluded.window_start
             THEN ai_writing_rate_buckets.count + 1
           ELSE 1
         END,
         window_start = excluded.window_start,
         updated_at = excluded.updated_at
       RETURNING count`,
    )
    .bind(bucketKey, windowStart, nowMs)
    .first<{ count: number }>();

  return Number(row?.count ?? 1);
}

/**
 * Enforces atomic per-user and per-tenant per-minute burst rate limits.
 */
export async function consumeAiWritingBurstLimit(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly nowMs?: number;
    readonly policy?: AiWritingBurstPolicy;
  },
): Promise<ConsumeAiWritingBurstResult> {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.policy?.windowMs ?? AI_WRITING_BURST_WINDOW_MS;
  const userLimit = input.policy?.perUserPerMinute ?? AI_WRITING_BURST_PER_USER_MINUTE;
  const tenantLimit = input.policy?.perTenantPerMinute ?? AI_WRITING_BURST_PER_TENANT_MINUTE;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStart + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  // Bounded opportunistic pruning of expired (>1h) rate-limit buckets (best-effort)
  await pruneExpiredAiWritingRateBuckets(platformDb, { nowMs }).catch(() => undefined);

  const userKey = `aiw:u:${input.tenantId}:${input.actorUserId}`;
  const userCount = await incrementBucketAtomic(platformDb, userKey, windowStart, nowMs);
  if (userCount > userLimit) {
    return {
      allowed: false,
      code: "AI_RATE_LIMITED",
      scope: "user",
      retryAfterSeconds,
      resetAt: new Date(resetAtMs).toISOString(),
      message: `Terlalu banyak permintaan bantuan tulis dalam satu menit. Coba lagi dalam ${retryAfterSeconds} detik.`,
    };
  }

  const tenantKey = `aiw:t:${input.tenantId}`;
  const tenantCount = await incrementBucketAtomic(platformDb, tenantKey, windowStart, nowMs);
  if (tenantCount > tenantLimit) {
    return {
      allowed: false,
      code: "AI_RATE_LIMITED",
      scope: "tenant",
      retryAfterSeconds,
      resetAt: new Date(resetAtMs).toISOString(),
      message: `Batas permintaan bantuan tulis per menit untuk situs ini tercapai. Coba lagi dalam ${retryAfterSeconds} detik.`,
    };
  }

  return {
    allowed: true,
    userRemaining: Math.max(0, userLimit - userCount),
    tenantRemaining: Math.max(0, tenantLimit - tenantCount),
  };
}

/**
 * Appends a strictly metadata-only audit entry into `PLATFORM_DB.platform_audit`.
 * Guarantees ZERO prompt text, ZERO input text, and ZERO suggestion text are persisted.
 */
export async function recordAiWritingAudit(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly targetId: string;
    readonly outcome: "success" | "denied" | "error";
    readonly requestId: string;
    readonly reason?: string | null;
    readonly metadata: AiWritingAuditMetadataInput;
    readonly nowMs?: number;
  },
): Promise<string> {
  const auditId = createAuditId();
  const safeMeta = buildAiWritingAuditMetadata(input.metadata);
  const nowMs = input.nowMs ?? Date.now();

  await platformDb
    .prepare(
      `INSERT INTO platform_audit (
         id, actor_user_id, actor_role, action, target_type, target_id,
         tenant_id, reason, outcome, request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, 'ai_writing.suggest', 'ai_writing', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      auditId,
      input.actorUserId,
      input.actorRole,
      input.targetId,
      input.tenantId,
      input.reason ? input.reason.slice(0, 120) : null,
      input.outcome,
      input.requestId,
      JSON.stringify(safeMeta),
      nowMs,
    )
    .run();

  return auditId;
}
