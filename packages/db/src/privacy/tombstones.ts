/**
 * Deletion tombstone registry & backup-restore tombstone replay (TASK-031, REQ-039, DEC-022).
 *
 * Ensures that after an isolated backup restore of `PLATFORM_DB` or `MEDIA_BUCKET`,
 * previously purged tenants and their R2 objects cannot be resurrected into live service.
 */

import { isTenantScopedR2Key, type RetentionR2BucketLike } from "./retention.ts";

const R2_DELETE_BATCH_SIZE = 1000;
const DEFAULT_HANDLE_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeletionTombstoneRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly handle: string;
  readonly quarantineUntil: number;
  readonly googleSubHash: string | null;
  readonly emailHash: string | null;
  readonly companyNameHash: string | null;
  readonly reason: string;
  readonly deletedBy: string | null;
  readonly deletedAt: number;
}

export interface RecordDeletionTombstoneInput {
  readonly id: string;
  readonly tenantId: string;
  readonly handle: string;
  readonly reason: string;
  readonly deletedBy?: string | null;
  readonly deletedAtMs?: number;
  readonly quarantineUntilMs?: number;
  readonly googleSubHash?: string | null;
  readonly emailHash?: string | null;
  readonly companyNameHash?: string | null;
}

export interface ReplayDeletionTombstonesInput {
  readonly platformDb: D1Database;
  readonly mediaBucket?: RetentionR2BucketLike | null;
  readonly nowMs?: number;
  readonly preserveSubprefixes?: readonly string[];
}

export interface TombstoneReplayResult {
  readonly replayedAtMs: number;
  readonly tombstonesScanned: number;
  readonly tenantsRePurged: number;
  readonly hostsNeutralized: number;
  readonly r2ObjectsDeleted: number;
  readonly tenantIdsProcessed: readonly string[];
}

interface RawTombstoneRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly handle: string;
  readonly quarantine_until: number;
  readonly google_sub_hash: string | null;
  readonly email_hash: string | null;
  readonly company_name_hash: string | null;
  readonly reason: string;
  readonly deleted_by: string | null;
  readonly deleted_at: number;
}

/**
 * Records an idempotent deletion tombstone in `PLATFORM_DB.deletion_tombstones`.
 */
export async function recordDeletionTombstone(
  platformDb: D1Database,
  input: RecordDeletionTombstoneInput,
): Promise<DeletionTombstoneRecord> {
  const deletedAt = input.deletedAtMs ?? Date.now();
  const quarantineUntil = input.quarantineUntilMs ?? deletedAt + DEFAULT_HANDLE_QUARANTINE_MS;

  await platformDb
    .prepare(
      `INSERT INTO deletion_tombstones (
        id,
        tenant_id,
        handle,
        quarantine_until,
        google_sub_hash,
        email_hash,
        company_name_hash,
        reason,
        deleted_by,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id) DO UPDATE SET
        quarantine_until = MAX(deletion_tombstones.quarantine_until, excluded.quarantine_until),
        reason = excluded.reason`,
    )
    .bind(
      input.id,
      input.tenantId,
      input.handle,
      quarantineUntil,
      input.googleSubHash ?? null,
      input.emailHash ?? null,
      input.companyNameHash ?? null,
      input.reason,
      input.deletedBy ?? null,
      deletedAt,
    )
    .run();

  return {
    id: input.id,
    tenantId: input.tenantId,
    handle: input.handle,
    quarantineUntil,
    googleSubHash: input.googleSubHash ?? null,
    emailHash: input.emailHash ?? null,
    companyNameHash: input.companyNameHash ?? null,
    reason: input.reason,
    deletedBy: input.deletedBy ?? null,
    deletedAt,
  };
}

/**
 * Lists all recorded deletion tombstones ordered chronologically.
 */
export async function listDeletionTombstones(
  platformDb: D1Database,
): Promise<readonly DeletionTombstoneRecord[]> {
  const rows = await platformDb
    .prepare(
      `SELECT id, tenant_id, handle, quarantine_until, google_sub_hash, email_hash,
              company_name_hash, reason, deleted_by, deleted_at
       FROM deletion_tombstones
       ORDER BY deleted_at ASC`,
    )
    .all<RawTombstoneRow>();

  return rows.results.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    handle: r.handle,
    quarantineUntil: r.quarantine_until,
    googleSubHash: r.google_sub_hash,
    emailHash: r.email_hash,
    companyNameHash: r.company_name_hash,
    reason: r.reason,
    deletedBy: r.deleted_by,
    deletedAt: r.deleted_at,
  }));
}

function shouldPreserveKey(
  tenantId: string,
  key: string,
  preserveSubprefixes: readonly string[],
): boolean {
  if (preserveSubprefixes.length === 0) return false;
  const tenantPrefix = `t/${tenantId}/`;
  if (!key.startsWith(tenantPrefix)) return true;
  const relative = key.slice(tenantPrefix.length);
  return preserveSubprefixes.some((sub) => relative.startsWith(sub));
}

async function purgeTenantR2Objects(
  bucket: RetentionR2BucketLike,
  tenantId: string,
  preserveSubprefixes: readonly string[],
): Promise<number> {
  const prefix = `t/${tenantId}/`;
  const keysToDelete: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (!isTenantScopedR2Key(tenantId, obj.key)) continue;
      if (shouldPreserveKey(tenantId, obj.key, preserveSubprefixes)) continue;
      keysToDelete.push(obj.key);
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  let deleted = 0;
  for (let i = 0; i < keysToDelete.length; i += R2_DELETE_BATCH_SIZE) {
    const chunk = keysToDelete.slice(i, i + R2_DELETE_BATCH_SIZE);
    await bucket.delete([...chunk]);
    deleted += chunk.length;
  }
  return deleted;
}

/**
 * Replays `PLATFORM_DB.deletion_tombstones` idempotently so restored tombstoned tenants
 * remain `purged`, their host mappings stay neutralized, and any restored R2 objects under
 * `t/<tenantId>/...` are deleted again before service resumes.
 */
export async function replayDeletionTombstones(
  input: ReplayDeletionTombstonesInput,
): Promise<TombstoneReplayResult> {
  const { platformDb, mediaBucket } = input;
  const nowMs = input.nowMs ?? Date.now();
  const preserveSubprefixes = input.preserveSubprefixes ?? [];

  const tombstones = await listDeletionTombstones(platformDb);
  let tenantsRePurged = 0;
  let hostsNeutralized = 0;
  let r2ObjectsDeleted = 0;
  const tenantIdsProcessed: string[] = [];

  for (const tombstone of tombstones) {
    tenantIdsProcessed.push(tombstone.tenantId);

    // 1. Force any resurrected tenant row back to `purged` and bump cache_version
    const tenantUpdate = await platformDb
      .prepare(
        `UPDATE tenants
         SET status = 'purged',
             cache_version = cache_version + 1,
             updated_at = ?
         WHERE id = ? AND status != 'purged'`,
      )
      .bind(nowMs, tombstone.tenantId)
      .run();
    tenantsRePurged += tenantUpdate.meta.changes;

    // 2. Neutralize any resurrected host records so the tombstoned tenant cannot serve traffic
    const hostUpdate = await platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET status = 'deleting',
             is_primary = 0,
             quarantined_until = MAX(COALESCE(quarantined_until, 0), ?),
             updated_at = ?
         WHERE tenant_id = ? AND (status != 'deleting' OR is_primary != 0)`,
      )
      .bind(tombstone.quarantineUntil, nowMs, tombstone.tenantId)
      .run();
    hostsNeutralized += hostUpdate.meta.changes;

    // 3. Re-delete any restored R2 objects under `t/<tenantId>/...`
    if (mediaBucket) {
      r2ObjectsDeleted += await purgeTenantR2Objects(
        mediaBucket,
        tombstone.tenantId,
        preserveSubprefixes,
      );
    }
  }

  return {
    replayedAtMs: nowMs,
    tombstonesScanned: tombstones.length,
    tenantsRePurged,
    hostsNeutralized,
    r2ObjectsDeleted,
    tenantIdsProcessed,
  };
}
