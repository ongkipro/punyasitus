/**
 * Automated retention policy sweep for per-tenant `TenantStore` SQLite Durable Objects
 * and tenant-scoped R2 media objects (TASK-031, REQ-039, PLAN §5, DEC-045).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RETENTION_POLICY_DAYS = {
  leads: 180,
  dedupHours: 24,
  analyticsDailyAndHourly: 395, // 13 months
  tenantActivityLog: 90,
  securityAuditLog: 90, // platform_audit is append-only immutable in DB; archived per legal hold
  quarantineHours: 24,
  trashedContentAndMedia: 30,
  backups: 30,
} as const;

export interface RetentionPolicyMs {
  readonly leadsMs: number;
  readonly dedupMs: number;
  readonly analyticsMs: number;
  readonly activityLogMs: number;
  readonly quarantineMs: number;
  readonly trashMs: number;
}

export const DEFAULT_RETENTION_POLICY_MS: RetentionPolicyMs = {
  leadsMs: RETENTION_POLICY_DAYS.leads * DAY_MS,
  dedupMs: RETENTION_POLICY_DAYS.dedupHours * HOUR_MS,
  analyticsMs: RETENTION_POLICY_DAYS.analyticsDailyAndHourly * DAY_MS,
  activityLogMs: RETENTION_POLICY_DAYS.tenantActivityLog * DAY_MS,
  quarantineMs: RETENTION_POLICY_DAYS.quarantineHours * HOUR_MS,
  trashMs: RETENTION_POLICY_DAYS.trashedContentAndMedia * DAY_MS,
};

export interface RetentionR2BucketLike {
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(keys: string | string[]): Promise<void>;
}

export interface TenantRetentionSweepInput {
  readonly tenantDb: D1Database;
  readonly tenantId: string;
  readonly mediaBucket?: RetentionR2BucketLike | null;
  readonly nowMs?: number;
  readonly policy?: Partial<RetentionPolicyMs>;
}

export interface TenantRetentionDeletedCounts {
  readonly leads: number;
  readonly leadDedup: number;
  readonly analyticsEventDedup: number;
  readonly analyticsDaily: number;
  readonly analyticsHourlySources: number;
  readonly tenantActivityLog: number;
  readonly trashedPages: number;
  readonly trashedPosts: number;
  readonly trashedOfferings: number;
  readonly expiredMediaItems: number;
  readonly r2QuarantineObjects: number;
  readonly r2TrashedObjects: number;
}

export interface TenantRetentionSweepResult {
  readonly tenantId: string;
  readonly sweptAtMs: number;
  readonly deleted: TenantRetentionDeletedCounts;
  readonly freedStorageBytes: number;
}

interface MediaRowToPurge {
  readonly id: number;
  readonly r2_key: string;
  readonly poster_r2_key: string | null;
  readonly captions_r2_key: string | null;
  readonly variants_json: string | null;
  readonly bytes: number;
  readonly status: string;
}

const R2_DELETE_BATCH_SIZE = 1000;

/**
 * Validates that an R2 key strictly belongs to `t/<tenantId>/...` without traversal.
 */
export function isTenantScopedR2Key(tenantId: string, key: string): boolean {
  if (!tenantId || !key) return false;
  if (key.includes("..") || key.includes("\\")) return false;
  return key.startsWith(`t/${tenantId}/`);
}

function formatUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function extractVariantR2Keys(variantsJson: string | null, tenantId: string): string[] {
  if (!variantsJson) return [];
  try {
    const parsed: unknown = JSON.parse(variantsJson);
    const out: string[] = [];
    const visit = (node: unknown): void => {
      if (typeof node === "string") {
        if (isTenantScopedR2Key(tenantId, node)) out.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (typeof node === "object" && node !== null) {
        for (const value of Object.values(node as Record<string, unknown>)) {
          visit(value);
        }
      }
    };
    visit(parsed);
    return out;
  } catch {
    return [];
  }
}

async function deleteR2KeysInBatches(
  bucket: RetentionR2BucketLike,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH_SIZE) {
    const chunk = keys.slice(i, i + R2_DELETE_BATCH_SIZE);
    await bucket.delete([...chunk]);
    deleted += chunk.length;
  }
  return deleted;
}

function resolveObjectAgeTimestampMs(obj: R2Object): number {
  const meta = obj.customMetadata;
  const candidate =
    meta?.deletedAtMs ?? meta?.trashedAtMs ?? meta?.quarantinedAtMs ?? meta?.uploadedAtMs;
  if (candidate !== undefined) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return obj.uploaded.getTime();
}

async function sweepExpiredR2Prefix(
  bucket: RetentionR2BucketLike,
  tenantId: string,
  prefix: string,
  cutoffMs: number,
  alreadyDeletedKeys: ReadonlySet<string>,
): Promise<number> {
  const keysToDelete: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const listed = await bucket.list({
      prefix,
      cursor,
      include: ["customMetadata"],
    });
    for (const obj of listed.objects) {
      if (!isTenantScopedR2Key(tenantId, obj.key)) continue;
      if (alreadyDeletedKeys.has(obj.key)) continue;
      if (resolveObjectAgeTimestampMs(obj) <= cutoffMs) {
        keysToDelete.push(obj.key);
      }
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  return deleteR2KeysInBatches(bucket, keysToDelete);
}

async function hasColumn(
  db: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const info = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{ name: string }>();
  return info.results.some((col) => col.name === columnName);
}

async function isMediaItemReferenced(db: D1Database, mediaId: number): Promise<boolean> {
  const [authorRef, postRef, offeringRef] = await Promise.all([
    db
      .prepare("SELECT 1 AS hit FROM authors WHERE avatar_media_id = ? LIMIT 1")
      .bind(mediaId)
      .first<{ hit: number }>(),
    db
      .prepare("SELECT 1 AS hit FROM posts WHERE cover_media_id = ? LIMIT 1")
      .bind(mediaId)
      .first<{ hit: number }>(),
    db
      .prepare(
        "SELECT 1 AS hit FROM offerings WHERE cover_media_id = ? OR video_media_id = ? LIMIT 1",
      )
      .bind(mediaId, mediaId)
      .first<{ hit: number }>(),
  ]);
  return Boolean(authorRef || postRef || offeringRef);
}

/**
 * Executes the PLAN §5 retention sweep for a single tenant:
 * - `leads`: older than 180 days
 * - `lead_dedup` & `analytics_event_dedup`: expired or older than 24 hours
 * - `analytics_daily` & `analytics_hourly_sources`: older than 13 months (395 days)
 * - `tenant_activity_log`: older than 90 days
 * - Trashed `pages`, `posts`, `offerings`: `status = 'trashed'` and `deleted_at <= now - 30 days`
 * - Expired quarantined (`> 24h`) and trashed (`> 30d`) `media_items` + R2 objects, freeing `storage_usage.used_bytes`
 * - Expired R2 quarantine (`t/<tenantId>/quarantine/...`, > 24h) and trash (`t/<tenantId>/trash/...`, > 30d) objects
 */
export async function runTenantRetentionSweep(
  input: TenantRetentionSweepInput,
): Promise<TenantRetentionSweepResult> {
  const { tenantDb, tenantId, mediaBucket } = input;
  if (!tenantId.trim()) {
    throw new Error("tenantId is required for runTenantRetentionSweep");
  }

  const nowMs = input.nowMs ?? Date.now();
  const policy: RetentionPolicyMs = {
    ...DEFAULT_RETENTION_POLICY_MS,
    ...input.policy,
  };

  const leadsCutoffMs = nowMs - policy.leadsMs;
  const dedupCutoffMs = nowMs - policy.dedupMs;
  const analyticsCutoffDay = formatUtcDay(nowMs - policy.analyticsMs);
  const activityCutoffMs = nowMs - policy.activityLogMs;
  const quarantineCutoffMs = nowMs - policy.quarantineMs;
  const trashCutoffMs = nowMs - policy.trashMs;

  // 1. Delete expired dedup entries first (24h or explicit expires_at)
  const leadDedupRes = await tenantDb
    .prepare("DELETE FROM lead_dedup WHERE expires_at <= ? OR created_at <= ?")
    .bind(nowMs, dedupCutoffMs)
    .run();

  const analyticsDedupRes = await tenantDb
    .prepare("DELETE FROM analytics_event_dedup WHERE expires_at <= ? OR created_at <= ?")
    .bind(nowMs, dedupCutoffMs)
    .run();

  // 2. Delete expired leads (180 days; cascades any remaining lead_dedup FK rows)
  const leadsRes = await tenantDb
    .prepare("DELETE FROM leads WHERE created_at <= ?")
    .bind(leadsCutoffMs)
    .run();

  // 3. Delete expired daily & hourly analytics aggregates (13 months / 395 days)
  const analyticsDailyRes = await tenantDb
    .prepare("DELETE FROM analytics_daily WHERE day < ?")
    .bind(analyticsCutoffDay)
    .run();

  const analyticsHourlyRes = await tenantDb
    .prepare("DELETE FROM analytics_hourly_sources WHERE substr(hour_bucket, 1, 10) < ?")
    .bind(analyticsCutoffDay)
    .run();

  // 4. Delete expired tenant activity log entries (90 days)
  const activityLogRes = await tenantDb
    .prepare("DELETE FROM tenant_activity_log WHERE created_at <= ?")
    .bind(activityCutoffMs)
    .run();

  // 5. Purge trashed content older than 30 days (releases FK links to expired trashed media)
  const trashedPagesRes = await tenantDb
    .prepare("DELETE FROM pages WHERE status = 'trashed' AND deleted_at IS NOT NULL AND deleted_at <= ?")
    .bind(trashCutoffMs)
    .run();

  const trashedPostsRes = await tenantDb
    .prepare("DELETE FROM posts WHERE status = 'trashed' AND deleted_at IS NOT NULL AND deleted_at <= ?")
    .bind(trashCutoffMs)
    .run();

  const trashedOfferingsRes = await tenantDb
    .prepare(
      "DELETE FROM offerings WHERE status = 'trashed' AND deleted_at IS NOT NULL AND deleted_at <= ?",
    )
    .bind(trashCutoffMs)
    .run();

  // 6. Sweep expired quarantined (>24h) and trashed (>30d) media_items + R2 objects, freeing storage bytes
  const mediaHasDeletedAt = await hasColumn(tenantDb, "media_items", "deleted_at");
  const trashKeyPrefix = `t/${tenantId}/trash/%`;
  const quarantineKeyPrefix = `t/${tenantId}/quarantine/%`;

  const expiredMediaQuery = mediaHasDeletedAt
    ? tenantDb
        .prepare(
          `SELECT id, r2_key, poster_r2_key, captions_r2_key, variants_json, bytes, status
           FROM media_items
           WHERE (deleted_at IS NOT NULL AND deleted_at <= ?)
              OR (status = 'quarantined' AND updated_at <= ?)
              OR (r2_key LIKE ? AND updated_at <= ?)
              OR (r2_key LIKE ? AND updated_at <= ?)`,
        )
        .bind(
          trashCutoffMs,
          quarantineCutoffMs,
          trashKeyPrefix,
          trashCutoffMs,
          quarantineKeyPrefix,
          quarantineCutoffMs,
        )
    : tenantDb
        .prepare(
          `SELECT id, r2_key, poster_r2_key, captions_r2_key, variants_json, bytes, status
           FROM media_items
           WHERE (status = 'quarantined' AND updated_at <= ?)
              OR (r2_key LIKE ? AND updated_at <= ?)
              OR (r2_key LIKE ? AND updated_at <= ?)`,
        )
        .bind(
          quarantineCutoffMs,
          trashKeyPrefix,
          trashCutoffMs,
          quarantineKeyPrefix,
          quarantineCutoffMs,
        );

  const expiredMediaRows = await expiredMediaQuery.all<MediaRowToPurge>();
  let expiredMediaItems = 0;
  let freedStorageBytes = 0;
  const deletedR2KeysFromMedia = new Set<string>();
  const r2QuarantineKeysFromMedia: string[] = [];
  const r2TrashedKeysFromMedia: string[] = [];

  for (const row of expiredMediaRows.results) {
    // Respect FK integrity if a non-trashed resource still references this media ID
    if (await isMediaItemReferenced(tenantDb, row.id)) {
      continue;
    }

    const rowKeys = new Set<string>();
    if (isTenantScopedR2Key(tenantId, row.r2_key)) rowKeys.add(row.r2_key);
    if (row.poster_r2_key && isTenantScopedR2Key(tenantId, row.poster_r2_key)) {
      rowKeys.add(row.poster_r2_key);
    }
    if (row.captions_r2_key && isTenantScopedR2Key(tenantId, row.captions_r2_key)) {
      rowKeys.add(row.captions_r2_key);
    }
    for (const vKey of extractVariantR2Keys(row.variants_json, tenantId)) {
      rowKeys.add(vKey);
    }

    // Delete R2 objects first so a bucket outage never orphans R2 bytes behind a deleted DB row
    if (mediaBucket && rowKeys.size > 0) {
      const keyList = [...rowKeys];
      await deleteR2KeysInBatches(mediaBucket, keyList);
      for (const k of keyList) {
        deletedR2KeysFromMedia.add(k);
        if (k.startsWith(`t/${tenantId}/quarantine/`)) {
          r2QuarantineKeysFromMedia.push(k);
        } else {
          r2TrashedKeysFromMedia.push(k);
        }
      }
    }

    const delRes = await tenantDb
      .prepare("DELETE FROM media_items WHERE id = ?")
      .bind(row.id)
      .run();

    if (delRes.meta.changes > 0) {
      expiredMediaItems += delRes.meta.changes;
      freedStorageBytes += Math.max(0, row.bytes);
    }
  }

  if (freedStorageBytes > 0) {
    await tenantDb
      .prepare(
        "UPDATE storage_usage SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = 1",
      )
      .bind(freedStorageBytes, nowMs)
      .run();
  }

  // 7. Sweep any remaining orphaned expired R2 objects under quarantine/ (>24h) and trash/ (>30d)
  let orphanQuarantineDeleted = 0;
  let orphanTrashDeleted = 0;
  if (mediaBucket) {
    orphanQuarantineDeleted = await sweepExpiredR2Prefix(
      mediaBucket,
      tenantId,
      `t/${tenantId}/quarantine/`,
      quarantineCutoffMs,
      deletedR2KeysFromMedia,
    );
    orphanTrashDeleted = await sweepExpiredR2Prefix(
      mediaBucket,
      tenantId,
      `t/${tenantId}/trash/`,
      trashCutoffMs,
      deletedR2KeysFromMedia,
    );
  }

  return {
    tenantId,
    sweptAtMs: nowMs,
    deleted: {
      leads: leadsRes.meta.changes,
      leadDedup: leadDedupRes.meta.changes,
      analyticsEventDedup: analyticsDedupRes.meta.changes,
      analyticsDaily: analyticsDailyRes.meta.changes,
      analyticsHourlySources: analyticsHourlyRes.meta.changes,
      tenantActivityLog: activityLogRes.meta.changes,
      trashedPages: trashedPagesRes.meta.changes,
      trashedPosts: trashedPostsRes.meta.changes,
      trashedOfferings: trashedOfferingsRes.meta.changes,
      expiredMediaItems,
      r2QuarantineObjects: r2QuarantineKeysFromMedia.length + orphanQuarantineDeleted,
      r2TrashedObjects: r2TrashedKeysFromMedia.length + orphanTrashDeleted,
    },
    freedStorageBytes,
  };
}
