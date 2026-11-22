import {
  emitTelemetryEvent,
  type TelemetrySink,
} from "@punyasitus/core/telemetry/index";
import {
  TENANT_STORE_PROTOCOL,
  createTenantDb,
  openTenantStoreStub,
  splitMigrationStatements,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  listDeletionTombstones,
  recordDeletionTombstone,
  replayDeletionTombstones,
  type RecordDeletionTombstoneInput,
  type RetentionR2BucketLike,
  type TombstoneReplayResult,
} from "@punyasitus/db/privacy/index";
import {
  PLATFORM_BACKUP_LATEST_KEY,
  computeSha256Hex,
  type BackupR2BucketLike,
  type PlatformBackupLatestMarker,
  type PlatformBackupManifest,
} from "./platform-backup.ts";

const RESTORE_BATCH_SIZE = 50;

export interface RestoreMediaR2BucketLike extends RetentionR2BucketLike {
  head(key: string): Promise<{ readonly key: string; readonly size?: number } | null>;
}

export interface TenantRestoreSnapshotExpectation {
  readonly tenantId: string;
  readonly expectedBookmark?: string;
  readonly expectedMinRecords?: number;
  readonly expectedMediaKeys?: readonly string[];
  /**
   * Optional operator hook simulating or executing Durable Object `restore(bookmark)`
   * PITR verification against the recorded bookmark token.
   */
  readonly verifyBookmarkRestore?: (bookmark: string) => Promise<boolean> | boolean;
}

export interface IsolatedRestoreDrillInput {
  readonly backupBucket: BackupR2BucketLike;
  readonly snapshotKey?: string;
  readonly manifestKey?: string;
  readonly targetPlatformDb: D1Database;
  readonly tenantStoreNamespace: TenantStoreNamespaceLike;
  readonly tenantSnapshots?: readonly TenantRestoreSnapshotExpectation[];
  readonly mediaBucket: RestoreMediaR2BucketLike;
  /**
   * Authoritative `deletion_tombstones` recorded after the snapshot timestamp
   * (synced into restored `PLATFORM_DB` prior to `replayDeletionTombstones` so
   * offboarded tenants cannot resurrect from older backups per DEC-022).
   */
  readonly authoritativeTombstones?: readonly RecordDeletionTombstoneInput[];
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly telemetrySink?: TelemetrySink;
}

export interface TenantRestoreVerificationRecord {
  readonly tenantId: string;
  readonly status: string;
  readonly bookmarkCount: number;
  readonly latestBookmark: string | null;
  readonly bookmarkMatched: boolean;
  readonly schemaMigrationsCount: number;
  readonly recovery: boolean;
  readonly liveRecordCount: number;
  readonly coherent: boolean;
}

export interface IsolatedRestoreDrillResult {
  readonly ok: boolean;
  readonly drillCompletedAt: string;
  readonly durationMs: number;
  readonly snapshotKey: string;
  readonly manifestKey: string;
  readonly sha256: string;
  readonly checksumVerified: boolean;
  readonly platformDb: {
    readonly tablesRestored: number;
    readonly rowsRestored: number;
    readonly statementsExecuted: number;
    readonly rowCountsMatched: boolean;
  };
  readonly tenantChecks: readonly TenantRestoreVerificationRecord[];
  readonly mediaCheck: {
    readonly checkedKeys: readonly string[];
    readonly verifiedCount: number;
    readonly missingKeys: readonly string[];
  };
  readonly tombstoneReplay: TombstoneReplayResult;
  readonly postReplayVerified: boolean;
}

function deriveManifestKey(snapshotKey: string): string {
  if (snapshotKey.endsWith("/snapshot.sql")) {
    return `${snapshotKey.slice(0, -"/snapshot.sql".length)}/manifest.json`;
  }
  return `${snapshotKey}.manifest.json`;
}

async function resolveSnapshotKeys(
  backupBucket: BackupR2BucketLike,
  snapshotKey?: string,
  manifestKey?: string,
): Promise<{ readonly snapshotKey: string; readonly manifestKey: string }> {
  if (snapshotKey) {
    return {
      snapshotKey,
      manifestKey: manifestKey ?? deriveManifestKey(snapshotKey),
    };
  }
  const latestObj = await backupBucket.get(PLATFORM_BACKUP_LATEST_KEY);
  if (!latestObj) {
    throw new Error("BACKUP_LATEST_MARKER_MISSING");
  }
  const latest = JSON.parse(await latestObj.text()) as Partial<PlatformBackupLatestMarker>;
  if (!latest.snapshotKey || !latest.manifestKey) {
    throw new Error("BACKUP_LATEST_MARKER_INVALID");
  }
  return {
    snapshotKey: latest.snapshotKey,
    manifestKey: manifestKey ?? latest.manifestKey,
  };
}

async function executeStatementsInBatches(
  db: D1Database,
  statements: readonly string[],
): Promise<number> {
  let executed = 0;
  for (let i = 0; i < statements.length; i += RESTORE_BATCH_SIZE) {
    const chunk = statements.slice(i, i + RESTORE_BATCH_SIZE);
    const prepared = chunk.map((stmt) => db.prepare(stmt));
    await db.batch(prepared);
    executed += chunk.length;
  }
  return executed;
}

async function verifyRestoredTableCounts(
  db: D1Database,
  expectedCounts: Readonly<Record<string, number>>,
): Promise<{ readonly matched: boolean; readonly totalRows: number }> {
  let matched = true;
  let totalRows = 0;
  for (const [tableName, expected] of Object.entries(expectedCounts)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      matched = false;
      continue;
    }
    const row = await db
      .prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`)
      .first<{ cnt: number }>();
    const actual = Number(row?.cnt ?? 0);
    totalRows += actual;
    if (actual !== expected) {
      matched = false;
    }
  }
  return { matched, totalRows };
}

async function inspectTenantLiveState(
  tenantStoreNamespace: TenantStoreNamespaceLike,
  tenantId: string,
): Promise<{
  readonly schemaMigrationsCount: number;
  readonly recovery: boolean;
  readonly liveRecordCount: number;
  readonly activeMediaKeys: readonly string[];
}> {
  const stub = openTenantStoreStub(tenantStoreNamespace, tenantId);
  const state = await stub.schemaState(TENANT_STORE_PROTOCOL);
  const tenantDb = createTenantDb(stub);

  const tablesRes = await tenantDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const existingTables = new Set(tablesRes.results.map((r) => r.name));

  let liveRecordCount = 0;
  for (const table of ["pages", "posts", "offerings"] as const) {
    if (!existingTables.has(table)) continue;
    const countRow = await tenantDb
      .prepare(`SELECT COUNT(*) AS cnt FROM "${table}" WHERE deleted_at IS NULL`)
      .first<{ cnt: number }>();
    liveRecordCount += Number(countRow?.cnt ?? 0);
  }

  const activeMediaKeys: string[] = [];
  if (existingTables.has("media_items")) {
    const mediaRows = await tenantDb
      .prepare(
        `SELECT r2_key, poster_r2_key, captions_r2_key
         FROM media_items
         WHERE status = 'ready'`,
      )
      .all<{
        r2_key: string | null;
        poster_r2_key: string | null;
        captions_r2_key: string | null;
      }>();

    liveRecordCount += mediaRows.results.length;
    for (const row of mediaRows.results) {
      if (row.r2_key) activeMediaKeys.push(row.r2_key);
      if (row.poster_r2_key) activeMediaKeys.push(row.poster_r2_key);
      if (row.captions_r2_key) activeMediaKeys.push(row.captions_r2_key);
    }
  }

  return {
    schemaMigrationsCount: state.appliedMigrations.length,
    recovery: state.recovery,
    liveRecordCount,
    activeMediaKeys,
  };
}

async function verifyPostTombstoneReplay(
  platformDb: D1Database,
  mediaBucket: RestoreMediaR2BucketLike,
): Promise<boolean> {
  const tombstones = await listDeletionTombstones(platformDb);
  for (const tombstone of tombstones) {
    const tenantRow = await platformDb
      .prepare("SELECT status FROM tenants WHERE id = ?")
      .bind(tombstone.tenantId)
      .first<{ status: string }>();
    if (tenantRow && tenantRow.status !== "purged") {
      return false;
    }

    const activeHosts = await platformDb
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tenant_hosts
         WHERE tenant_id = ? AND (status != 'deleting' OR is_primary != 0)`,
      )
      .bind(tombstone.tenantId)
      .first<{ cnt: number }>();
    if (Number(activeHosts?.cnt ?? 0) > 0) {
      return false;
    }

    const listed = await mediaBucket.list({ prefix: `t/${tombstone.tenantId}/` });
    if (listed.objects.length > 0) {
      return false;
    }
  }
  return true;
}

/**
 * Executes an isolated end-to-end backup restore drill (TASK-037, PLAN §9, DEC-022):
 * 1. Fetches `snapshot.sql` + `manifest.json` from `BACKUP_BUCKET` and verifies SHA-256.
 * 2. Restores the logical SQL snapshot into isolated `targetPlatformDb` and checks table row counts.
 * 3. Syncs any post-backup `authoritativeTombstones` and runs `replayDeletionTombstones` so purged
 *    tenants, hosts, and R2 objects remain purged before service resumes.
 * 4. Verifies `TenantStore` DO PITR bookmark metadata (`migration_bookmarks`), live tenant records,
 *    and referenced R2 media objects for active tenants.
 */
export async function runIsolatedRestoreDrill(
  input: IsolatedRestoreDrillInput,
): Promise<IsolatedRestoreDrillResult> {
  const startedAt = Date.now();
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const keys = await resolveSnapshotKeys(
    input.backupBucket,
    input.snapshotKey,
    input.manifestKey,
  );

  const [snapshotObj, manifestObj] = await Promise.all([
    input.backupBucket.get(keys.snapshotKey),
    input.backupBucket.get(keys.manifestKey),
  ]);

  if (!snapshotObj) {
    throw new Error("BACKUP_SNAPSHOT_NOT_FOUND");
  }
  if (!manifestObj) {
    throw new Error("BACKUP_MANIFEST_NOT_FOUND");
  }

  const sqlText = await snapshotObj.text();
  const manifest = JSON.parse(await manifestObj.text()) as PlatformBackupManifest;
  const actualSha256 = await computeSha256Hex(sqlText);
  const checksumVerified =
    typeof manifest.sha256 === "string" && manifest.sha256 === actualSha256;

  if (!checksumVerified) {
    throw new Error("BACKUP_CHECKSUM_MISMATCH");
  }

  // 1. Restore PLATFORM_DB logical SQL into isolated target DB
  const statements = splitMigrationStatements(sqlText);
  const statementsExecuted = await executeStatementsInBatches(input.targetPlatformDb, statements);
  const countCheck = await verifyRestoredTableCounts(
    input.targetPlatformDb,
    manifest.tableRowCounts,
  );

  // 2. Sync any post-snapshot deletion tombstones and execute mandatory DEC-022 tombstone replay
  if (input.authoritativeTombstones && input.authoritativeTombstones.length > 0) {
    for (const tombstone of input.authoritativeTombstones) {
      await recordDeletionTombstone(input.targetPlatformDb, tombstone);
    }
  }

  const tombstoneReplay = await replayDeletionTombstones({
    platformDb: input.targetPlatformDb,
    mediaBucket: input.mediaBucket,
    nowMs,
  });

  const postReplayVerified = await verifyPostTombstoneReplay(
    input.targetPlatformDb,
    input.mediaBucket,
  );

  // 3. Verify non-purged tenants' PITR migration bookmarks, live TenantStore DO records, and R2 media
  const tombstonedIds = new Set(tombstoneReplay.tenantIdsProcessed);
  const expectationsByTenant = new Map<string, TenantRestoreSnapshotExpectation>();
  for (const exp of input.tenantSnapshots ?? []) {
    expectationsByTenant.set(exp.tenantId, exp);
  }

  const tenantsRes = await input.targetPlatformDb
    .prepare("SELECT id, status FROM tenants ORDER BY id ASC")
    .all<{ id: string; status: string }>();

  const tenantChecks: TenantRestoreVerificationRecord[] = [];
  const mediaKeysToCheck = new Set<string>();

  for (const tenant of tenantsRes.results) {
    if (tenant.status === "purged" || tombstonedIds.has(tenant.id)) {
      continue;
    }

    const exp = expectationsByTenant.get(tenant.id);
    const bookmarksRes = await input.targetPlatformDb
      .prepare(
        `SELECT bookmark, status
         FROM migration_bookmarks
         WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(tenant.id)
      .all<{ bookmark: string; status: string }>();

    const latestBookmark = bookmarksRes.results[0]?.bookmark ?? null;
    let bookmarkMatched = bookmarksRes.results.length > 0 && latestBookmark !== null;
    if (exp?.expectedBookmark && latestBookmark !== exp.expectedBookmark) {
      bookmarkMatched = false;
    }
    if (bookmarkMatched && latestBookmark && exp?.verifyBookmarkRestore) {
      bookmarkMatched = Boolean(await exp.verifyBookmarkRestore(latestBookmark));
    }

    const live = await inspectTenantLiveState(input.tenantStoreNamespace, tenant.id);
    for (const key of live.activeMediaKeys) {
      mediaKeysToCheck.add(key);
    }
    for (const key of exp?.expectedMediaKeys ?? []) {
      mediaKeysToCheck.add(key);
    }

    const minRecordsOk =
      exp?.expectedMinRecords === undefined || live.liveRecordCount >= exp.expectedMinRecords;

    const coherent =
      bookmarkMatched &&
      live.schemaMigrationsCount > 0 &&
      !live.recovery &&
      minRecordsOk;

    tenantChecks.push({
      tenantId: tenant.id,
      status: tenant.status,
      bookmarkCount: bookmarksRes.results.length,
      latestBookmark,
      bookmarkMatched,
      schemaMigrationsCount: live.schemaMigrationsCount,
      recovery: live.recovery,
      liveRecordCount: live.liveRecordCount,
      coherent,
    });
  }

  // 4. Verify every referenced R2 media object exists for active tenants
  const checkedKeys = [...mediaKeysToCheck].sort();
  const missingKeys: string[] = [];
  let verifiedCount = 0;

  for (const key of checkedKeys) {
    const head = await input.mediaBucket.head(key);
    if (head) {
      verifiedCount += 1;
    } else {
      missingKeys.push(key);
    }
  }

  const allTenantsCoherent = tenantChecks.every((c) => c.coherent);
  const ok =
    checksumVerified &&
    countCheck.matched &&
    postReplayVerified &&
    allTenantsCoherent &&
    missingKeys.length === 0;

  const durationMs = Math.max(0, Date.now() - startedAt);
  const drillCompletedAt = new Date(nowMs).toISOString();

  emitTelemetryEvent(
    {
      requestId: input.requestId ?? `restore-drill-${nowMs}`,
      tenantId: null,
      operation: "backup.isolated_restore_drill",
      status: ok ? "ok" : "degraded",
      durationMs,
      errorCode: ok ? null : "RESTORE_DRILL_VERIFICATION_FAILED",
      timestamp: nowMs,
      metrics: {
        tablesRestored: manifest.tableCount,
        rowsRestored: countCheck.totalRows,
        tenantsVerified: tenantChecks.length,
        mediaVerified: verifiedCount,
        mediaMissing: missingKeys.length,
        tombstonesReplayed: tombstoneReplay.tombstonesScanned,
        r2TombstonePurged: tombstoneReplay.r2ObjectsDeleted,
      },
    },
    input.telemetrySink,
  );

  return {
    ok,
    drillCompletedAt,
    durationMs,
    snapshotKey: keys.snapshotKey,
    manifestKey: keys.manifestKey,
    sha256: actualSha256,
    checksumVerified,
    platformDb: {
      tablesRestored: manifest.tableCount,
      rowsRestored: countCheck.totalRows,
      statementsExecuted,
      rowCountsMatched: countCheck.matched,
    },
    tenantChecks,
    mediaCheck: {
      checkedKeys,
      verifiedCount,
      missingKeys,
    },
    tombstoneReplay,
    postReplayVerified,
  };
}
