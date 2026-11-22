import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0002_media_upload_pipeline.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it cleanly
 * without filesystem access.
 */
export const MEDIA_PIPELINE_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0002_media_upload_pipeline
-- Additive schema for atomic storage reservation, soft-delete trash tracking, and upload intents
-- (REQ-010, REQ-034, REQ-039, REQ-064; PLAN §5.2, §7.2, §7.3).

ALTER TABLE storage_usage ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0);

ALTER TABLE media_items ADD COLUMN deleted_at INTEGER;
ALTER TABLE media_items ADD COLUMN original_filename TEXT;
ALTER TABLE media_items ADD COLUMN slug TEXT;
ALTER TABLE media_items ADD COLUMN decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1));

CREATE TABLE IF NOT EXISTS media_upload_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  original_filename TEXT NOT NULL,
  slug TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
  declared_sha256 TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1)),
  quarantine_r2_key TEXT NOT NULL UNIQUE,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  media_item_id INTEGER REFERENCES media_items(id),
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'completed', 'failed', 'expired')),
  error_code TEXT,
  created_by_user_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS media_upload_intents_status_expires_idx
  ON media_upload_intents(status, expires_at);

CREATE INDEX IF NOT EXISTS media_upload_intents_media_item_idx
  ON media_upload_intents(media_item_id);
`;

export const MEDIA_PIPELINE_MIGRATION: MigrationDescriptor = {
  version: 2,
  name: "0002_media_upload_pipeline",
  sql: MEDIA_PIPELINE_MIGRATION_SQL,
} as const;

const INITIALIZED_MEDIA_SCHEMA_DBS = new WeakSet<D1Database>();
const IN_FLIGHT_MEDIA_SCHEMA_INIT = new WeakMap<D1Database, Promise<void>>();

function isDuplicateColumnError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
      : String(err);
  return /duplicate column name/i.test(message);
}

async function listColumnNames(db: D1Database, tableName: string): Promise<Set<string>> {
  const res = await db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all<{ name: string }>();
  return new Set(res.results.map((r) => r.name));
}

async function addColumnIdempotently(db: D1Database, alterSql: string): Promise<void> {
  try {
    await db.prepare(alterSql).run();
  } catch (err) {
    if (isDuplicateColumnError(err)) {
      return;
    }
    throw err;
  }
}

async function runEnsureMediaPipelineSchema(tenantDb: D1Database): Promise<void> {
  const [storageCols, mediaCols] = await Promise.all([
    listColumnNames(tenantDb, "storage_usage"),
    listColumnNames(tenantDb, "media_items"),
  ]);

  if (!storageCols.has("reserved_bytes")) {
    await addColumnIdempotently(
      tenantDb,
      "ALTER TABLE storage_usage ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)",
    );
  }
  if (!mediaCols.has("deleted_at")) {
    await addColumnIdempotently(tenantDb, "ALTER TABLE media_items ADD COLUMN deleted_at INTEGER");
  }
  if (!mediaCols.has("original_filename")) {
    await addColumnIdempotently(
      tenantDb,
      "ALTER TABLE media_items ADD COLUMN original_filename TEXT",
    );
  }
  if (!mediaCols.has("slug")) {
    await addColumnIdempotently(tenantDb, "ALTER TABLE media_items ADD COLUMN slug TEXT");
  }
  if (!mediaCols.has("decorative")) {
    await addColumnIdempotently(
      tenantDb,
      "ALTER TABLE media_items ADD COLUMN decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1))",
    );
  }

  await tenantDb.batch([
    tenantDb.prepare(`CREATE TABLE IF NOT EXISTS media_upload_intents (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      payload_hash TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
      original_filename TEXT NOT NULL,
      slug TEXT NOT NULL,
      declared_mime TEXT NOT NULL,
      declared_bytes INTEGER NOT NULL CHECK (declared_bytes > 0),
      declared_sha256 TEXT NOT NULL,
      alt_text TEXT NOT NULL DEFAULT '',
      decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0, 1)),
      quarantine_r2_key TEXT NOT NULL UNIQUE,
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      media_item_id INTEGER REFERENCES media_items(id),
      status TEXT NOT NULL CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'completed', 'failed', 'expired')),
      error_code TEXT,
      created_by_user_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    tenantDb.prepare(
      "CREATE INDEX IF NOT EXISTS media_upload_intents_status_expires_idx ON media_upload_intents(status, expires_at)",
    ),
    tenantDb.prepare(
      "CREATE INDEX IF NOT EXISTS media_upload_intents_media_item_idx ON media_upload_intents(media_item_id)",
    ),
  ]);
}

/**
 * Concurrency-safe, memoized initializer for the additive `0002_media_upload_pipeline`
 * schema in a `TenantStore` SQLite DB.
 * - Tolerates concurrent `ALTER TABLE ... ADD COLUMN` races (`duplicate column name`).
 * - Memoizes completed `D1Database` handles in a `WeakSet` for zero steady-state PRAGMA overhead.
 */
export async function ensureMediaPipelineSchema(tenantDb: D1Database): Promise<void> {
  if (INITIALIZED_MEDIA_SCHEMA_DBS.has(tenantDb)) {
    return;
  }

  const inFlight = IN_FLIGHT_MEDIA_SCHEMA_INIT.get(tenantDb);
  if (inFlight) {
    return inFlight;
  }

  const promise = runEnsureMediaPipelineSchema(tenantDb)
    .then(() => {
      INITIALIZED_MEDIA_SCHEMA_DBS.add(tenantDb);
    })
    .finally(() => {
      IN_FLIGHT_MEDIA_SCHEMA_INIT.delete(tenantDb);
    });

  IN_FLIGHT_MEDIA_SCHEMA_INIT.set(tenantDb, promise);
  return promise;
}
