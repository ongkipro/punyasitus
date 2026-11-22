import {
  emitTelemetryEvent,
  type TelemetrySink,
} from "@punyasitus/core/telemetry/index";

export const DAILY_PLATFORM_BACKUP_TOPIC = "cron.daily_platform_backup" as const;
export const PLATFORM_BACKUP_PREFIX = "platform-db" as const;
export const PLATFORM_BACKUP_LATEST_KEY = `${PLATFORM_BACKUP_PREFIX}/latest.json` as const;

const SAFE_SQLITE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BackupR2ObjectLike {
  readonly key: string;
  readonly uploaded?: Date;
  text(): Promise<string>;
}

export interface BackupR2BucketLike {
  get(key: string): Promise<BackupR2ObjectLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    readonly objects: readonly { readonly key: string; readonly uploaded?: Date }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

export interface PlatformBackupManifest {
  readonly formatVersion: 1;
  readonly backupDate: string;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly snapshotKey: string;
  readonly manifestKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly tableCount: number;
  readonly totalRows: number;
  readonly tableRowCounts: Readonly<Record<string, number>>;
  readonly schemaVersion: number;
}

export interface PlatformBackupLatestMarker {
  readonly formatVersion: 1;
  readonly backupDate: string;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly snapshotKey: string;
  readonly manifestKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly tableCount: number;
  readonly totalRows: number;
  readonly schemaVersion: number;
}

export interface LogicalSqlExportResult {
  readonly sql: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly tableCount: number;
  readonly totalRows: number;
  readonly tableRowCounts: Readonly<Record<string, number>>;
  readonly schemaVersion: number;
}

export interface RunDailyPlatformBackupInput {
  readonly platformDb: D1Database;
  readonly backupBucket: BackupR2BucketLike;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly telemetrySink?: TelemetrySink;
}

export interface RunDailyPlatformBackupResult {
  readonly backupDate: string;
  readonly snapshotKey: string;
  readonly manifestKey: string;
  readonly latestKey: string;
  readonly manifest: PlatformBackupManifest;
}

interface SqliteMasterRow {
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface PragmaTableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly pk: number;
}

interface PragmaForeignKeyRow {
  readonly table: string;
}

function quoteIdent(name: string): string {
  if (!SAFE_SQLITE_IDENT_RE.test(name)) {
    throw new Error(`UNSAFE_SQLITE_IDENTIFIER: ${name}`);
  }
  return `"${name}"`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes a lowercase hex SHA-256 digest using Web Crypto (works in both `workerd` and Node).
 */
export async function computeSha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Serializes a SQLite column value into a deterministic, injection-safe SQL literal.
 */
export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (value instanceof Uint8Array) {
    return `X'${bytesToHex(value).toUpperCase()}'`;
  }
  if (value instanceof ArrayBuffer) {
    return `X'${bytesToHex(new Uint8Array(value)).toUpperCase()}'`;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return `X'${bytesToHex(Uint8Array.from(value)).toUpperCase()}'`;
  }
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function normalizeCreateDdl(ddl: string): string {
  const trimmed = ddl.trim().replace(/;+\s*$/, "");
  if (/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ");
  }
  if (/^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  }
  if (/^CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
  }
  if (/^CREATE\s+TRIGGER\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+TRIGGER\s+/i, "CREATE TRIGGER IF NOT EXISTS ");
  }
  return trimmed;
}

/**
 * Topologically sorts tables so referenced parent tables come before child tables,
 * breaking ties alphabetically for 100% deterministic SQL dumps.
 */
function sortTablesByForeignKeys(
  tableNames: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const known = new Set(tableNames);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const name of tableNames) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const table of tableNames) {
    const parents = dependencies.get(table);
    if (!parents) continue;
    for (const parent of parents) {
      if (parent === table || !known.has(parent)) continue;
      inDegree.set(table, (inDegree.get(table) ?? 0) + 1);
      dependents.get(parent)!.push(table);
    }
  }

  const ready = tableNames.filter((t) => (inDegree.get(t) ?? 0) === 0).sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);
    const children = dependents.get(next) ?? [];
    for (const child of children) {
      const remaining = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  // Fallback for cyclic FKs: append remaining tables deterministically
  if (ordered.length < tableNames.length) {
    const seen = new Set(ordered);
    for (const name of [...tableNames].sort()) {
      if (!seen.has(name)) {
        ordered.push(name);
      }
    }
  }

  return ordered;
}

export function formatUtcBackupDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function buildPlatformBackupKeys(backupDate: string): {
  readonly snapshotKey: string;
  readonly manifestKey: string;
  readonly latestKey: string;
} {
  return {
    snapshotKey: `${PLATFORM_BACKUP_PREFIX}/${backupDate}/snapshot.sql`,
    manifestKey: `${PLATFORM_BACKUP_PREFIX}/${backupDate}/manifest.json`,
    latestKey: PLATFORM_BACKUP_LATEST_KEY,
  };
}

/**
 * Exports a coherent, deterministic logical SQL snapshot of `PLATFORM_DB`
 * (tables in FK-safe order, rows ordered deterministically by primary key,
 * followed by indexes and triggers) plus its SHA-256 digest.
 */
export async function exportPlatformDbLogicalSql(
  platformDb: D1Database,
): Promise<LogicalSqlExportResult> {
  const tablesRes = await platformDb
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND sql IS NOT NULL
       ORDER BY name ASC`,
    )
    .all<SqliteMasterRow>();

  const indexesRes = await platformDb
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'index'
         AND name NOT LIKE 'sqlite_%'
         AND tbl_name NOT LIKE '_cf_%'
         AND sql IS NOT NULL
       ORDER BY tbl_name ASC, name ASC`,
    )
    .all<SqliteMasterRow>();

  const triggersRes = await platformDb
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'trigger'
         AND tbl_name NOT LIKE '_cf_%'
         AND sql IS NOT NULL
       ORDER BY tbl_name ASC, name ASC`,
    )
    .all<SqliteMasterRow>();

  const tableDdlByName = new Map<string, string>();
  const dependencies = new Map<string, Set<string>>();

  for (const row of tablesRes.results) {
    if (!row.sql || !SAFE_SQLITE_IDENT_RE.test(row.name)) continue;
    tableDdlByName.set(row.name, normalizeCreateDdl(row.sql));
    const fkRes = await platformDb
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(row.name)})`)
      .all<PragmaForeignKeyRow>();
    const parents = new Set<string>();
    for (const fk of fkRes.results) {
      if (fk.table && fk.table !== row.name) {
        parents.add(fk.table);
      }
    }
    dependencies.set(row.name, parents);
  }

  const orderedTables = sortTablesByForeignKeys([...tableDdlByName.keys()], dependencies);

  const lines: string[] = [
    "-- PunyaSitus PLATFORM_DB logical SQL export (format v1)",
    "-- Deterministic FK-ordered schema, data, indexes, and triggers.",
    "",
  ];

  // 1. Table DDL in parent-before-child order
  for (const tableName of orderedTables) {
    lines.push(`${tableDdlByName.get(tableName)!};`);
  }
  lines.push("");

  // 2. Table rows in parent-before-child order with deterministic PK ordering
  const tableRowCounts: Record<string, number> = {};
  let totalRows = 0;

  for (const tableName of orderedTables) {
    const quotedTable = quoteIdent(tableName);
    const colsRes = await platformDb
      .prepare(`PRAGMA table_info(${quotedTable})`)
      .all<PragmaTableInfoRow>();

    const columns = [...colsRes.results].sort((a, b) => a.cid - b.cid);
    const colNames = columns.map((c) => c.name);
    const pkCols = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quoteIdent(c.name));

    const orderBy =
      pkCols.length > 0
        ? pkCols.join(", ")
        : colNames.length > 0
          ? quoteIdent(colNames[0]!)
          : "1";

    const selectCols = colNames.map((c) => quoteIdent(c)).join(", ");
    const dataRes = await platformDb
      .prepare(`SELECT ${selectCols} FROM ${quotedTable} ORDER BY ${orderBy}`)
      .all<Record<string, unknown>>();

    tableRowCounts[tableName] = dataRes.results.length;
    totalRows += dataRes.results.length;

    if (dataRes.results.length > 0) {
      for (const row of dataRes.results) {
        const values = colNames.map((c) => formatSqlLiteral(row[c])).join(", ");
        lines.push(`INSERT INTO ${quotedTable} (${selectCols}) VALUES (${values});`);
      }
    }
  }
  lines.push("");

  // 3. Indexes
  for (const idx of indexesRes.results) {
    if (!idx.sql) continue;
    lines.push(`${normalizeCreateDdl(idx.sql)};`);
  }
  lines.push("");

  // 4. Triggers (created after inserts so append-only triggers protect post-restore state)
  for (const trig of triggersRes.results) {
    if (!trig.sql) continue;
    lines.push(`${normalizeCreateDdl(trig.sql)};`);
  }
  lines.push("");

  let schemaVersion = 0;
  if (tableDdlByName.has("_platform_migrations")) {
    const verRow = await platformDb
      .prepare("SELECT MAX(version) AS max_version FROM _platform_migrations")
      .first<{ max_version: number | null }>();
    schemaVersion = Number(verRow?.max_version ?? 0);
  }

  const sql = lines.join("\n");
  const bytes = new TextEncoder().encode(sql);
  const sha256 = await computeSha256Hex(bytes);

  return {
    sql,
    sha256,
    byteLength: bytes.byteLength,
    tableCount: orderedTables.length,
    totalRows,
    tableRowCounts,
    schemaVersion,
  };
}

/**
 * Runs the daily `PLATFORM_DB` logical SQL export and writes:
 * - `platform-db/<YYYY-MM-DD>/snapshot.sql`
 * - `platform-db/<YYYY-MM-DD>/manifest.json`
 * - `platform-db/latest.json` (written last for atomic freshness visibility)
 */
export async function runDailyPlatformBackup(
  input: RunDailyPlatformBackupInput,
): Promise<RunDailyPlatformBackupResult> {
  const startedAt = Date.now();
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const backupDate = formatUtcBackupDate(nowMs);
  const keys = buildPlatformBackupKeys(backupDate);

  const exported = await exportPlatformDbLogicalSql(input.platformDb);
  const createdAt = new Date(nowMs).toISOString();

  const manifest: PlatformBackupManifest = {
    formatVersion: 1,
    backupDate,
    createdAt,
    createdAtMs: nowMs,
    snapshotKey: keys.snapshotKey,
    manifestKey: keys.manifestKey,
    sha256: exported.sha256,
    byteLength: exported.byteLength,
    tableCount: exported.tableCount,
    totalRows: exported.totalRows,
    tableRowCounts: exported.tableRowCounts,
    schemaVersion: exported.schemaVersion,
  };

  const latestMarker: PlatformBackupLatestMarker = {
    formatVersion: 1,
    backupDate,
    createdAt,
    createdAtMs: nowMs,
    snapshotKey: keys.snapshotKey,
    manifestKey: keys.manifestKey,
    sha256: exported.sha256,
    byteLength: exported.byteLength,
    tableCount: exported.tableCount,
    totalRows: exported.totalRows,
    schemaVersion: exported.schemaVersion,
  };

  // Write snapshot -> manifest -> latest marker so probes never observe a dangling latest.json
  await input.backupBucket.put(keys.snapshotKey, exported.sql, {
    httpMetadata: { contentType: "application/sql; charset=utf-8" },
    customMetadata: {
      backupDate,
      sha256: exported.sha256,
      formatVersion: "1",
    },
  });

  await input.backupBucket.put(keys.manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      backupDate,
      sha256: exported.sha256,
    },
  });

  await input.backupBucket.put(keys.latestKey, JSON.stringify(latestMarker, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      backupDate,
      sha256: exported.sha256,
    },
  });

  emitTelemetryEvent(
    {
      requestId: input.requestId ?? `backup-${backupDate}`,
      tenantId: null,
      operation: "backup.daily_platform_db",
      status: "ok",
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: null,
      timestamp: nowMs,
      metrics: {
        tableCount: manifest.tableCount,
        totalRows: manifest.totalRows,
        byteLength: manifest.byteLength,
        schemaVersion: manifest.schemaVersion,
      },
    },
    input.telemetrySink,
  );

  return {
    backupDate,
    snapshotKey: keys.snapshotKey,
    manifestKey: keys.manifestKey,
    latestKey: keys.latestKey,
    manifest,
  };
}

export interface DailyBackupQueueEnv {
  readonly PLATFORM_DB: D1Database;
  readonly BACKUP_BUCKET?: BackupR2BucketLike | null;
}

export interface DailyBackupJobContext {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
  readonly enqueuedAt: number;
  readonly env: DailyBackupQueueEnv;
  readonly nowMs: number;
}

export type DailyBackupReconcileResult =
  | { readonly state: "completed"; readonly externalReference?: string }
  | { readonly state: "not_applied" }
  | { readonly state: "pending"; readonly retryAfterSeconds?: number };

export interface DailyBackupQueueHandler {
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly execute: (ctx: DailyBackupJobContext) => Promise<void>;
  readonly reconcile?: (ctx: DailyBackupJobContext) => Promise<DailyBackupReconcileResult>;
}

export interface CreateDailyBackupQueueHandlerOptions {
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly telemetrySink?: TelemetrySink;
  readonly onBackupCompleted?: (result: RunDailyPlatformBackupResult) => void;
}

class BackupBindingError extends Error {
  readonly code = "BACKUP_BUCKET_UNAVAILABLE" as const;
  constructor() {
    super("Backup storage binding is unavailable");
    this.name = "BackupBindingError";
  }
}

/**
 * Ready-to-wire `DurableJobHandler` for topic `"cron.daily_platform_backup"`.
 * Plug directly into `WORKER_JOB_REGISTRY` in `apps/web/src/worker/index.ts`.
 */
export function createDailyBackupQueueHandler(
  options?: CreateDailyBackupQueueHandlerOptions,
): DailyBackupQueueHandler {
  return {
    maxAttempts: options?.maxAttempts ?? 3,
    leaseDurationMs: options?.leaseDurationMs ?? 120_000,
    async execute(ctx) {
      const bucket = ctx.env.BACKUP_BUCKET;
      if (!bucket) {
        throw new BackupBindingError();
      }
      const result = await runDailyPlatformBackup({
        platformDb: ctx.env.PLATFORM_DB,
        backupBucket: bucket,
        nowMs: ctx.nowMs,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        telemetrySink: options?.telemetrySink,
      });
      options?.onBackupCompleted?.(result);
    },
    async reconcile(ctx) {
      const bucket = ctx.env.BACKUP_BUCKET;
      if (!bucket) {
        return { state: "not_applied" };
      }
      const backupDate = formatUtcBackupDate(ctx.nowMs);
      const keys = buildPlatformBackupKeys(backupDate);
      const [manifestObj, snapshotObj] = await Promise.all([
        bucket.get(keys.manifestKey),
        bucket.get(keys.snapshotKey),
      ]);
      if (!manifestObj || !snapshotObj) {
        return { state: "not_applied" };
      }
      try {
        const manifest = JSON.parse(await manifestObj.text()) as Partial<PlatformBackupManifest>;
        const sqlText = await snapshotObj.text();
        const actualSha256 = await computeSha256Hex(sqlText);
        if (typeof manifest.sha256 === "string" && manifest.sha256 === actualSha256) {
          return { state: "completed", externalReference: keys.snapshotKey };
        }
      } catch {
        // Corrupt or incomplete prior write; allow execute() to overwrite cleanly
      }
      return { state: "not_applied" };
    },
  };
}
