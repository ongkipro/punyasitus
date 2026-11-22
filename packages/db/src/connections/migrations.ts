import {
  computeMigrationChecksum,
  splitMigrationStatements,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "./sql-splitter.ts";
import {
  CREATE_TENANT_MIGRATIONS_LEDGER_SQL,
  TENANT_MIGRATIONS_TABLE,
  TENANT_STORE_PROTOCOL,
  applyTenantMigrations,
  type StatementDescriptor,
} from "./store-core.ts";
import type { TenantStoreRpcStub } from "./tenant-db.ts";

export {
  applyTenantMigrations,
  computeMigrationChecksum,
  splitMigrationStatements,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
};

export const PLATFORM_MIGRATIONS_TABLE = "_platform_migrations";

const CREATE_PLATFORM_MIGRATIONS_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS ${PLATFORM_MIGRATIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/**
 * Applies additive `PLATFORM_DB` (Cloudflare D1) migrations idempotently using
 * the `_platform_migrations` ledger. Each pending migration executes in a single
 * D1 `batch()` transaction together with its ledger row.
 */
export async function applyPlatformMigrations(
  platformDb: D1Database,
  migrations: readonly MigrationDescriptor[],
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  await platformDb.prepare(CREATE_PLATFORM_MIGRATIONS_LEDGER_SQL).run();

  const existing = await platformDb
    .prepare(`SELECT version, name, checksum FROM ${PLATFORM_MIGRATIONS_TABLE} ORDER BY id ASC`)
    .all<{ version: number; name: string; checksum: string }>();

  const existingByName = new Map<string, { version: number; checksum: string }>();
  let currentVersion = 0;
  for (const row of existing.results) {
    existingByName.set(row.name, { version: row.version, checksum: row.checksum });
    if (row.version > currentVersion) currentVersion = row.version;
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of sorted) {
    const checksum = migration.checksum ?? computeMigrationChecksum(migration.sql);
    const prev = existingByName.get(migration.name);
    if (prev) {
      if (prev.checksum && prev.checksum !== checksum) {
        throw new Error(
          `PLATFORM_MIGRATION_CHECKSUM_MISMATCH: migration "${migration.name}" was modified after apply`,
        );
      }
      skipped.push(migration.name);
      continue;
    }

    const statements = splitMigrationStatements(migration.sql);
    const batch: D1PreparedStatement[] = statements.map((stmt) => platformDb.prepare(stmt));
    batch.push(
      platformDb
        .prepare(
          `INSERT INTO ${PLATFORM_MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(migration.version, migration.name, checksum, now()),
    );
    await platformDb.batch(batch);
    applied.push(migration.name);
    if (migration.version > currentVersion) {
      currentVersion = migration.version;
    }
  }

  return { applied, skipped, currentVersion };
}

export interface OrchestrateTenantMigrationOptions {
  /**
   * Optional explicit PITR bookmark provider (e.g. `ctx.storage.getCurrentBookmark()`).
   * Used when the RPC stub does not yet expose `getCurrentBookmark`.
   */
  readonly getBookmark?: () => Promise<string>;
  /**
   * When `true`, throws `TenantMigrationRecoveryError` on migration failure after
   * marking the tenant `recovery` in `PLATFORM_DB`. Defaults to `false` (returns
   * `{ outcome: "recovery", httpStatus: 503, ... }`).
   */
  readonly throwOnFailure?: boolean;
  readonly now?: () => number;
}

export interface OrchestrateTenantMigrationResult {
  readonly outcome: "migrated" | "up_to_date" | "recovery";
  readonly httpStatus: 200 | 503;
  readonly tenantId: string;
  readonly bookmarkId: string | null;
  readonly bookmark: string | null;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly schemaVersion: number;
  readonly error?: string;
}

export class TenantMigrationRecoveryError extends Error {
  readonly httpStatus = 503 as const;
  readonly tenantId: string;
  readonly bookmarkId: string | null;
  readonly bookmark: string | null;

  constructor(
    message: string,
    details: { tenantId: string; bookmarkId: string | null; bookmark: string | null; cause?: unknown },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "TenantMigrationRecoveryError";
    this.tenantId = details.tenantId;
    this.bookmarkId = details.bookmarkId;
    this.bookmark = details.bookmark;
  }
}

function createBookmarkId(tenantId: string, nowMs: number): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
  return `bm_${tenantId}_${nowMs}_${randomPart}`;
}

async function resolvePitrBookmark(
  stub: TenantStoreRpcStub,
  tenantId: string,
  appliedCount: number,
  nowMs: number,
  supportsBookmarkRpc: boolean,
  options?: OrchestrateTenantMigrationOptions,
): Promise<string> {
  if (options?.getBookmark) {
    const bm = await options.getBookmark();
    if (!bm.trim()) throw new Error("EMPTY_PITR_BOOKMARK");
    return bm;
  }
  if (supportsBookmarkRpc && typeof stub.getCurrentBookmark === "function") {
    const bm = await stub.getCurrentBookmark(TENANT_STORE_PROTOCOL);
    if (!bm.trim()) throw new Error("EMPTY_PITR_BOOKMARK");
    return bm;
  }
  // Fallback checkpoint token when running against a stub without direct PITR RPC
  const versionProbe = await stub.query(
    TENANT_STORE_PROTOCOL,
    { sql: "PRAGMA data_version", args: [] },
    false,
  );
  const dataVersion = Object.values(versionProbe.results[0] ?? {})[0] ?? 0;
  return `pitr:${tenantId}:m${appliedCount}:dv${String(dataVersion)}:${nowMs}`;
}

/**
 * Worker-side ADR-0009 safe per-tenant migration protocol:
 * 1. Verifies tenant row in `PLATFORM_DB` and refuses auto-migration if already in `recovery`.
 * 2. Reads `stub.schemaState()` (constructor never migrates).
 * 3. Captures and persists a PITR bookmark into `PLATFORM_DB.migration_bookmarks` BEFORE
 *    executing any DDL inside `TenantStore`'s atomic `transactionSync`.
 * 4. On success, marks the bookmark `applied` and updates `tenants.schema_version`.
 * 5. On failure, preserves the pre-migration bookmark (`status = 'failed'`), sets
 *    `tenants.status = 'recovery'`, bumps `tenants.cache_version`, and returns HTTP 503
 *    recovery status (or throws `TenantMigrationRecoveryError` if `throwOnFailure: true`).
 */
export async function orchestrateTenantMigration(
  platformDb: D1Database,
  stub: TenantStoreRpcStub,
  tenantId: string,
  targetMigrations: readonly MigrationDescriptor[],
  options?: OrchestrateTenantMigrationOptions,
): Promise<OrchestrateTenantMigrationResult> {
  const now = options?.now ?? Date.now;
  const sorted = [...targetMigrations].sort((a, b) => a.version - b.version);

  const tenantRow = await platformDb
    .prepare("SELECT id, status, schema_version, cache_version FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ id: string; status: string; schema_version: number; cache_version: number }>();

  if (!tenantRow) {
    throw new Error(`TENANT_NOT_FOUND: ${tenantId}`);
  }

  const state = await stub.schemaState(TENANT_STORE_PROTOCOL);
  if (tenantRow.status === "recovery" || state.recovery) {
    const msg = `Tenant ${tenantId} is in recovery mode; automatic migrations are paused`;
    if (options?.throwOnFailure) {
      throw new TenantMigrationRecoveryError(msg, {
        tenantId,
        bookmarkId: null,
        bookmark: null,
      });
    }
    return {
      outcome: "recovery",
      httpStatus: 503,
      tenantId,
      bookmarkId: null,
      bookmark: null,
      applied: [],
      skipped: [...state.appliedMigrations],
      schemaVersion: tenantRow.schema_version,
      error: msg,
    };
  }

  const appliedSet = new Set(state.appliedMigrations);
  const pending = sorted.filter((m) => !appliedSet.has(m.name));
  const skipped = sorted.filter((m) => appliedSet.has(m.name)).map((m) => m.name);
  const latestVersion = sorted.length > 0 ? sorted[sorted.length - 1]!.version : tenantRow.schema_version;

  if (pending.length === 0) {
    if (tenantRow.schema_version < latestVersion) {
      await platformDb
        .prepare("UPDATE tenants SET schema_version = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .bind(latestVersion, now(), tenantId)
        .run();
    }
    return {
      outcome: "up_to_date",
      httpStatus: 200,
      tenantId,
      bookmarkId: null,
      bookmark: null,
      applied: [],
      skipped,
      schemaVersion: Math.max(tenantRow.schema_version, latestVersion),
    };
  }

  const targetMigration = pending[pending.length - 1]!;
  const startedAt = now();
  const bookmarkId = createBookmarkId(tenantId, startedAt);
  const bookmark = await resolvePitrBookmark(
    stub,
    tenantId,
    state.appliedMigrations.length,
    startedAt,
    Boolean(state.capabilities?.getCurrentBookmark),
    options,
  );

  // ADR-0009 invariant: persist PITR bookmark BEFORE any DDL executes on the TenantStore DO
  await platformDb
    .prepare(
      `INSERT INTO migration_bookmarks (
        id, tenant_id, target_version, target_migration, bookmark, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      bookmarkId,
      tenantId,
      targetMigration.version,
      targetMigration.name,
      bookmark,
      startedAt,
    )
    .run();

  try {
    if (state.capabilities?.applyMigrations && typeof stub.applyMigrations === "function") {
      await stub.applyMigrations(TENANT_STORE_PROTOCOL, pending);
    } else {
      const batchStatements: StatementDescriptor[] = [
        { sql: CREATE_TENANT_MIGRATIONS_LEDGER_SQL, args: [] },
      ];
      for (const migration of pending) {
        const checksum = migration.checksum ?? computeMigrationChecksum(migration.sql);
        for (const stmt of splitMigrationStatements(migration.sql)) {
          batchStatements.push({ sql: stmt, args: [] });
        }
        batchStatements.push({
          sql: `INSERT INTO ${TENANT_MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
          args: [migration.version, migration.name, checksum, now()],
        });
      }
      // Executes inside TenantStore's synchronous `ctx.storage.transactionSync()`
      await stub.batch(TENANT_STORE_PROTOCOL, batchStatements);
    }

    const finishedAt = now();
    await platformDb.batch([
      platformDb
        .prepare(
          "UPDATE migration_bookmarks SET status = 'applied', completed_at = ? WHERE id = ?",
        )
        .bind(finishedAt, bookmarkId),
      platformDb
        .prepare(
          "UPDATE tenants SET schema_version = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .bind(targetMigration.version, finishedAt, tenantId),
    ]);

    return {
      outcome: "migrated",
      httpStatus: 200,
      tenantId,
      bookmarkId,
      bookmark,
      applied: pending.map((m) => m.name),
      skipped,
      schemaVersion: targetMigration.version,
    };
  } catch (err) {
    const failedAt = now();
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (state.capabilities?.setRecovery && typeof stub.setRecovery === "function") {
      try {
        await stub.setRecovery(TENANT_STORE_PROTOCOL, true);
      } catch {
        // Best-effort in-memory flag; PLATFORM_DB.tenants.status is authoritative.
      }
    }

    await platformDb.batch([
      platformDb
        .prepare(
          "UPDATE migration_bookmarks SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
        )
        .bind(errorMessage.slice(0, 500), failedAt, bookmarkId),
      platformDb
        .prepare(
          "UPDATE tenants SET status = 'recovery', cache_version = cache_version + 1, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .bind(failedAt, tenantId),
    ]);

    if (options?.throwOnFailure) {
      throw new TenantMigrationRecoveryError(
        `Tenant ${tenantId} migration failed and entered recovery (503): ${errorMessage}`,
        { tenantId, bookmarkId, bookmark, cause: err },
      );
    }

    return {
      outcome: "recovery",
      httpStatus: 503,
      tenantId,
      bookmarkId,
      bookmark,
      applied: [],
      skipped,
      schemaVersion: tenantRow.schema_version,
      error: errorMessage,
    };
  }
}
