import {
  isBuiltinPluginId,
  pluginIdToTablePrefix,
  PluginSqlViolationError,
  validatePluginMigrationSql,
  type PluginMigrationDescriptor,
} from "@punyasitus/core/plugins/index";
import { computeMigrationChecksum, splitMigrationStatements } from "../connections/sql-splitter.ts";
import { TENANT_STORE_PROTOCOL, type StatementDescriptor } from "../connections/store-core.ts";
import type { TenantStoreRpcStub } from "../connections/tenant-db.ts";

/**
 * Controlled per-plugin `TenantStore` migration runner (REQ-097, ADR-0009, ADR-0010, TASK-097).
 *
 * Security & Durability Invariants:
 * 1. Rejects `builtin:*` and validates EVERY migration SQL statement with
 *    `validatePluginMigrationSql` BEFORE opening bookmarks or touching `TenantStore`.
 * 2. Executes ZERO runtime DDL for core/ledger tables (`_plugin_migrations` MUST exist
 *    from additive tenant migration `0004_plugin_migrations_ledger.sql`).
 * 3. Fails CLOSED (`PITR_BOOKMARK_UNAVAILABLE`) when neither an explicit `getBookmark`
 *    callback nor `stub.getCurrentBookmark()` is available — never fabricates synthetic tokens.
 * 4. Records the verified pre-migration PITR bookmark in `PLATFORM_DB.migration_bookmarks`
 *    BEFORE executing any plugin DDL on `TenantStore`.
 * 5. Applies all pending plugin DDL + `_plugin_migrations` inserts inside ONE atomic
 *    `TenantStore` `transactionSync` batch, and separates post-commit `'applied'` bookmark
 *    updates from the DDL `try/catch` so a post-commit D1 hiccup never falsely marks a
 *    committed migration as `'failed'`.
 * 6. Never drops `plg_*` tables or data.
 */

export const PLUGIN_MIGRATIONS_TABLE = "_plugin_migrations" as const;

export class PluginMigrationError extends Error {
  readonly code:
    | "BUILTIN_PLUGIN_FORBIDDEN"
    | "TENANT_NOT_FOUND"
    | "TENANT_UNAVAILABLE"
    | "PLUGIN_LEDGER_NOT_INITIALIZED"
    | "PLUGIN_MIGRATION_CHECKSUM_MISMATCH"
    | "PITR_BOOKMARK_UNAVAILABLE"
    | "PLUGIN_MIGRATION_FAILED";

  constructor(
    code: PluginMigrationError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`${code}: ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginMigrationError";
    this.code = code;
  }
}

export interface RunPluginMigrationsOptions {
  readonly getBookmark?: () => Promise<string>;
  readonly now?: () => number;
}

export interface RunPluginMigrationsResult {
  readonly outcome: "migrated" | "up_to_date";
  readonly tenantId: string;
  readonly pluginId: string;
  readonly tablePrefix: `plg_${string}__`;
  readonly bookmarkId: string | null;
  readonly bookmark: string | null;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly schemaVersion: number;
}

function createPluginBookmarkId(tenantId: string, pluginId: string, nowMs: number): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(16).slice(2, 12);
  const safePlugin = pluginId.replace(/[^a-z0-9]/gi, "").slice(0, 16);
  return `bm_plg_${safePlugin}_${tenantId.slice(-8)}_${nowMs}_${randomPart}`;
}

async function resolvePluginPitrBookmark(
  stub: TenantStoreRpcStub,
  tenantId: string,
  pluginId: string,
  options?: RunPluginMigrationsOptions,
): Promise<string> {
  if (options?.getBookmark) {
    const bm = await options.getBookmark();
    if (!bm.trim()) {
      throw new PluginMigrationError(
        "PITR_BOOKMARK_UNAVAILABLE",
        `Received empty PITR bookmark before migrating plugin "${pluginId}" on tenant "${tenantId}"`,
      );
    }
    return bm.trim();
  }

  const state = await stub.schemaState(TENANT_STORE_PROTOCOL);
  if (state.capabilities?.getCurrentBookmark && typeof stub.getCurrentBookmark === "function") {
    const bm = await stub.getCurrentBookmark(TENANT_STORE_PROTOCOL);
    if (!bm.trim()) {
      throw new PluginMigrationError(
        "PITR_BOOKMARK_UNAVAILABLE",
        `TenantStore returned empty PITR bookmark for plugin "${pluginId}" on tenant "${tenantId}"`,
      );
    }
    return bm.trim();
  }

  // Fail closed: NEVER fabricate synthetic PITR bookmark tokens in production
  throw new PluginMigrationError(
    "PITR_BOOKMARK_UNAVAILABLE",
    `TenantStore does not expose getCurrentBookmark() for plugin "${pluginId}" on tenant "${tenantId}"; refusing to execute DDL without a verified pre-migration PITR bookmark`,
  );
}

export async function runPluginMigrations(
  platformDb: D1Database,
  stub: TenantStoreRpcStub,
  tenantId: string,
  pluginId: string,
  migrations: readonly PluginMigrationDescriptor[],
  options?: RunPluginMigrationsOptions,
): Promise<RunPluginMigrationsResult> {
  const now = options?.now ?? Date.now;

  if (isBuiltinPluginId(pluginId)) {
    throw new PluginMigrationError(
      "BUILTIN_PLUGIN_FORBIDDEN",
      `Cannot run plugin migrations for builtin identifier "${pluginId}"`,
    );
  }

  // Validate pluginId and EVERY migration SQL statement BEFORE any DB/bookmark touch
  const tablePrefix = pluginIdToTablePrefix(pluginId);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const mig of sorted) {
    validatePluginMigrationSql(pluginId, mig.sql);
  }

  if (sorted.length === 0) {
    return {
      outcome: "up_to_date",
      tenantId,
      pluginId,
      tablePrefix,
      bookmarkId: null,
      bookmark: null,
      applied: [],
      skipped: [],
      schemaVersion: 0,
    };
  }

  const tenantRow = await platformDb
    .prepare("SELECT id, status FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ readonly id: string; readonly status: string }>();

  if (!tenantRow) {
    throw new PluginMigrationError("TENANT_NOT_FOUND", `Tenant "${tenantId}" not found`);
  }

  if (
    tenantRow.status === "recovery" ||
    tenantRow.status === "purging" ||
    tenantRow.status === "purged"
  ) {
    throw new PluginMigrationError(
      "TENANT_UNAVAILABLE",
      `Tenant "${tenantId}" in status "${tenantRow.status}" cannot run plugin migrations`,
    );
  }

  // Verify `_plugin_migrations` ledger exists (from migration 0004_plugin_migrations_ledger.sql) — ZERO runtime DDL!
  const ledgerCheck = await stub.query(
    TENANT_STORE_PROTOCOL,
    {
      sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [PLUGIN_MIGRATIONS_TABLE],
    },
    false,
  );
  if (ledgerCheck.results.length === 0) {
    throw new PluginMigrationError(
      "PLUGIN_LEDGER_NOT_INITIALIZED",
      `TenantStore for "${tenantId}" is missing "${PLUGIN_MIGRATIONS_TABLE}"; apply 0004_plugin_migrations_ledger first`,
    );
  }

  const existingQuery = await stub.query(
    TENANT_STORE_PROTOCOL,
    {
      sql: `SELECT version, name, checksum FROM ${PLUGIN_MIGRATIONS_TABLE} WHERE plugin_id = ? ORDER BY version ASC, id ASC`,
      args: [pluginId],
    },
    false,
  );

  const existingByName = new Map<string, { version: number; checksum: string }>();
  let currentVersion = 0;
  for (const row of existingQuery.results) {
    const ver = Number(row.version ?? 0);
    const name = String(row.name);
    const checksum = String(row.checksum ?? "");
    existingByName.set(name, { version: ver, checksum });
    if (ver > currentVersion) currentVersion = ver;
  }

  const pending: PluginMigrationDescriptor[] = [];
  const skipped: string[] = [];

  for (const mig of sorted) {
    const checksum = mig.checksum ?? computeMigrationChecksum(mig.sql);
    const prev = existingByName.get(mig.name);
    if (prev) {
      if (prev.checksum && prev.checksum !== checksum) {
        throw new PluginMigrationError(
          "PLUGIN_MIGRATION_CHECKSUM_MISMATCH",
          `Plugin "${pluginId}" migration "${mig.name}" was modified after apply`,
        );
      }
      skipped.push(mig.name);
    } else {
      pending.push(mig);
    }
  }

  if (pending.length === 0) {
    return {
      outcome: "up_to_date",
      tenantId,
      pluginId,
      tablePrefix,
      bookmarkId: null,
      bookmark: null,
      applied: [],
      skipped,
      schemaVersion: currentVersion,
    };
  }

  const targetMigration = pending[pending.length - 1]!;
  const startedAt = now();
  const bookmarkId = createPluginBookmarkId(tenantId, pluginId, startedAt);
  const bookmark = await resolvePluginPitrBookmark(stub, tenantId, pluginId, options);

  // ADR-0009 / REQ-097 invariant: record PITR bookmark BEFORE executing any plugin DDL on TenantStore
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
      `plugin:${pluginId}:${targetMigration.name}`,
      bookmark,
      startedAt,
    )
    .run();

  const batchStatements: StatementDescriptor[] = [];
  for (const mig of pending) {
    const checksum = mig.checksum ?? computeMigrationChecksum(mig.sql);
    validatePluginMigrationSql(pluginId, mig.sql);
    for (const stmtSql of splitMigrationStatements(mig.sql)) {
      batchStatements.push({ sql: stmtSql, args: [] });
    }
    batchStatements.push({
      sql: `INSERT INTO ${PLUGIN_MIGRATIONS_TABLE} (
              plugin_id, version, name, checksum, bookmark_id, applied_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [pluginId, mig.version, mig.name, checksum, bookmarkId, now()],
    });
  }

  // Step 1: Execute atomic DDL batch inside TenantStore's `transactionSync`
  try {
    await stub.batch(TENANT_STORE_PROTOCOL, batchStatements);
  } catch (err) {
    const failedAt = now();
    const errorMessage = err instanceof Error ? err.message : String(err);
    await platformDb
      .prepare(
        "UPDATE migration_bookmarks SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
      )
      .bind(errorMessage.slice(0, 500), failedAt, bookmarkId)
      .run();

    if (err instanceof PluginSqlViolationError) {
      throw err;
    }
    throw new PluginMigrationError(
      "PLUGIN_MIGRATION_FAILED",
      `Failed applying migration for plugin "${pluginId}" on tenant "${tenantId}": ${errorMessage}`,
      { cause: err },
    );
  }

  // Step 2: Separated post-commit bookmark status update — DDL is ALREADY committed in TenantStore,
  // so a transient D1 error here MUST NOT overwrite the bookmark as 'failed'.
  const completedAt = now();
  try {
    await platformDb
      .prepare("UPDATE migration_bookmarks SET status = 'applied', completed_at = ? WHERE id = ?")
      .bind(completedAt, bookmarkId)
      .run();
  } catch {
    // Bookmark remains 'pending' for reconciliation; never falsely marked 'failed' after commit
  }

  return {
    outcome: "migrated",
    tenantId,
    pluginId,
    tablePrefix,
    bookmarkId,
    bookmark,
    applied: pending.map((m) => m.name),
    skipped,
    schemaVersion: Math.max(currentVersion, targetMigration.version),
  };
}
