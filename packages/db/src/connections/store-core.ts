import {
  computeMigrationChecksum,
  splitMigrationStatements,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "./sql-splitter.ts";

/**
 * Runtime-free SQLite execution engine for per-tenant `TenantStore` Durable Objects
 * (ADR-0009, DEC-036 — aligned with adsbook.id). Runs identically inside `workerd`
 * (Durable Object SQLite storage) and under unit tests.
 */
export const TENANT_STORE_PROTOCOL = 1;

export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export interface StatementDescriptor {
  readonly sql: string;
  readonly args: readonly SqlValue[];
}

export type StoreMeta = {
  readonly duration: number;
  readonly size_after: number;
  readonly rows_read: number;
  readonly rows_written: number;
  readonly last_row_id: number;
  readonly changed_db: boolean;
  readonly changes: number;
  readonly [key: string]: unknown;
};

export interface StatementResult {
  readonly results: Row[];
  readonly raw?: SqlValue[][];
  readonly columns: string[];
  readonly meta: StoreMeta;
}

export interface CursorLike {
  toArray(): Row[];
  raw(): IterableIterator<SqlValue[]>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface SqlLike {
  exec(query: string, ...bindings: SqlValue[]): CursorLike;
  readonly databaseSize: number;
}

export interface StorageLike {
  readonly sql: SqlLike;
  transactionSync<T>(closure: () => T): T;
  getCurrentBookmark?(): Promise<string>;
}

export interface SchemaStateCapabilities {
  readonly applyMigrations?: boolean;
  readonly getCurrentBookmark?: boolean;
  readonly setRecovery?: boolean;
}

export interface SchemaState {
  readonly protocol: number;
  readonly appliedMigrations: readonly string[];
  readonly recovery: boolean;
  readonly capabilities?: SchemaStateCapabilities;
}

export const TENANT_MIGRATIONS_TABLE = "_tenant_migrations";

export const CREATE_TENANT_MIGRATIONS_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS ${TENANT_MIGRATIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

function scalar(sql: SqlLike, query: string): number {
  const row = sql.exec(query).toArray()[0];
  if (!row) return 0;
  const firstVal = Object.values(row)[0];
  return typeof firstVal === "number" ? firstVal : Number(firstVal ?? 0);
}

/**
 * Executes a single statement synchronously and returns a D1-compatible result shape.
 */
export function executeStatement(
  storage: StorageLike,
  statement: StatementDescriptor,
  raw = false,
): StatementResult {
  const start = Date.now();
  const sql = storage.sql;
  const before = scalar(sql, "SELECT total_changes()");
  const cursor = sql.exec(statement.sql, ...statement.args);
  const rawRows = raw ? [...cursor.raw()] : undefined;
  const results = raw ? [] : cursor.toArray();
  const changes = scalar(sql, "SELECT total_changes()") - before;
  return {
    results,
    ...(rawRows ? { raw: rawRows } : {}),
    columns: [...cursor.columnNames],
    meta: {
      duration: Math.max(0, Date.now() - start),
      size_after: sql.databaseSize,
      rows_read: cursor.rowsRead,
      rows_written: cursor.rowsWritten,
      last_row_id: scalar(sql, "SELECT last_insert_rowid()"),
      changed_db: changes > 0,
      changes,
    },
  };
}

/**
 * Executes all statements inside one atomic synchronous SQLite transaction.
 * If any statement fails, every prior write in the batch rolls back.
 */
export function executeBatch(
  storage: StorageLike,
  statements: readonly StatementDescriptor[],
): StatementResult[] {
  return storage.transactionSync(() =>
    statements.map((statement) => executeStatement(storage, statement)),
  );
}

export function readTenantMigrationLedger(storage: StorageLike): string[] {
  const exists =
    storage.sql
      .exec(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        TENANT_MIGRATIONS_TABLE,
      )
      .toArray().length > 0;
  if (!exists) return [];
  return storage.sql
    .exec(`SELECT name FROM ${TENANT_MIGRATIONS_TABLE} ORDER BY id ASC`)
    .toArray()
    .map((row) => String(row.name));
}

/**
 * Applies additive per-tenant SQLite migrations inside a single atomic `transactionSync`.
 * Any DDL or ledger failure rolls back the entire migration batch cleanly.
 */
export function applyTenantMigrations(
  storage: StorageLike,
  migrations: readonly MigrationDescriptor[],
  now: () => number = Date.now,
): ApplyMigrationsResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  return storage.transactionSync(() => {
    storage.sql.exec(CREATE_TENANT_MIGRATIONS_LEDGER_SQL);

    const existingRows = storage.sql
      .exec(`SELECT version, name, checksum FROM ${TENANT_MIGRATIONS_TABLE} ORDER BY id ASC`)
      .toArray();
    const existingByName = new Map<string, { version: number; checksum: string }>();
    let currentVersion = 0;
    for (const row of existingRows) {
      const version = Number(row.version ?? 0);
      const name = String(row.name);
      const checksum = String(row.checksum ?? "");
      existingByName.set(name, { version, checksum });
      if (version > currentVersion) currentVersion = version;
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of sorted) {
      const checksum = migration.checksum ?? computeMigrationChecksum(migration.sql);
      const prev = existingByName.get(migration.name);
      if (prev) {
        if (prev.checksum && prev.checksum !== checksum) {
          throw new Error(
            `TENANT_MIGRATION_CHECKSUM_MISMATCH: migration "${migration.name}" was modified after apply`,
          );
        }
        skipped.push(migration.name);
        continue;
      }

      const statements = splitMigrationStatements(migration.sql);
      for (const stmt of statements) {
        storage.sql.exec(stmt);
      }

      storage.sql.exec(
        `INSERT INTO ${TENANT_MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        migration.version,
        migration.name,
        checksum,
        now(),
      );
      applied.push(migration.name);
      if (migration.version > currentVersion) {
        currentVersion = migration.version;
      }
    }

    return { applied, skipped, currentVersion };
  });
}

export class TenantStoreEngine {
  #storage: StorageLike;
  #recovery = false;

  constructor(storage: StorageLike) {
    this.#storage = storage;
  }

  checkProtocol(protocol: number): void {
    if (protocol !== TENANT_STORE_PROTOCOL) {
      throw new Error(
        `TENANT_STORE_PROTOCOL_MISMATCH: expected ${TENANT_STORE_PROTOCOL}, got ${protocol}`,
      );
    }
  }

  query(statement: StatementDescriptor, raw = false): StatementResult {
    return executeStatement(this.#storage, statement, raw);
  }

  batch(statements: readonly StatementDescriptor[]): StatementResult[] {
    return executeBatch(this.#storage, statements);
  }

  applyMigrations(migrations: readonly MigrationDescriptor[]): ApplyMigrationsResult {
    if (this.#recovery) {
      throw new Error("TENANT_STORE_IN_RECOVERY: auto-migration paused until operator restore");
    }
    return applyTenantMigrations(this.#storage, migrations);
  }

  async getCurrentBookmark(): Promise<string> {
    if (typeof this.#storage.getCurrentBookmark === "function") {
      return this.#storage.getCurrentBookmark();
    }
    throw new Error("TENANT_STORE_BOOKMARK_UNAVAILABLE");
  }

  schemaState(): SchemaState {
    return {
      protocol: TENANT_STORE_PROTOCOL,
      appliedMigrations: readTenantMigrationLedger(this.#storage),
      recovery: this.#recovery,
    };
  }

  setRecovery(recovery: boolean): void {
    this.#recovery = recovery;
  }
}
