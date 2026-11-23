import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0023_tenant_exports_and_deletion.sql`
 * byte-for-byte so Cloudflare `workerd` tests and migration runners can apply it
 * alongside `PLATFORM_MIGRATIONS` without filesystem access.
 *
 * Hard invariant: NEVER invoke this helper from runtime request handlers, APIs,
 * or `.astro` pages (zero request-time runtime DDL).
 */
export const TENANT_EXPORTS_AND_DELETION_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0023_tenant_exports_and_deletion
-- Additive owner full-website export archive jobs, 1/day per-website rate limit,
-- 24-hour signed ephemeral download ledger, and self-service website deletion
-- with 7-day undo window (REQ-107, PLAN §20.4, DEC-043, TASK-107).

CREATE TABLE IF NOT EXISTS tenant_export_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  request_day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'ready', 'failed', 'expired', 'deleted')
  ),
  r2_key TEXT,
  archive_bytes INTEGER CHECK (archive_bytes IS NULL OR archive_bytes >= 0),
  archive_sha256 TEXT,
  manifest_json TEXT,
  download_token_hash TEXT UNIQUE,
  download_expires_at INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  error_code TEXT,
  job_idempotency_key TEXT UNIQUE,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tenant_export_jobs_tenant_created_idx
  ON tenant_export_jobs(tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_export_jobs_one_per_day_idx
  ON tenant_export_jobs(tenant_id, request_day)
  WHERE status != 'failed';

CREATE INDEX IF NOT EXISTS tenant_export_jobs_expires_idx
  ON tenant_export_jobs(status, download_expires_at)
  WHERE download_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_deletion_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (
    status IN ('scheduled', 'canceled', 'purging', 'purged')
  ),
  confirmation_method TEXT NOT NULL CHECK (
    confirmation_method IN ('totp', 'backup_code', 'password', 'fresh_reauth')
  ),
  reason TEXT,
  deletion_requested_at INTEGER NOT NULL,
  deletion_due_at INTEGER NOT NULL,
  previous_status TEXT NOT NULL CHECK (
    previous_status IN ('trial', 'active', 'grace', 'locked', 'suspended')
  ),
  previous_deletion_due_at INTEGER,
  previous_cache_version INTEGER NOT NULL DEFAULT 1,
  canceled_at INTEGER,
  canceled_by_user_id TEXT REFERENCES users(id),
  cancel_reason TEXT,
  purge_claimed_at INTEGER,
  purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_deletion_requests_one_active_idx
  ON tenant_deletion_requests(tenant_id)
  WHERE status IN ('scheduled', 'purging');

CREATE INDEX IF NOT EXISTS tenant_deletion_requests_due_idx
  ON tenant_deletion_requests(status, deletion_due_at);
`;

export const TENANT_EXPORTS_AND_DELETION_MIGRATION: MigrationDescriptor = {
  version: 23,
  name: "0023_tenant_exports_and_deletion",
  sql: TENANT_EXPORTS_AND_DELETION_MIGRATION_SQL,
} as const;

export async function applyTenantExportsAndDeletionMigration(
  db: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(db, [TENANT_EXPORTS_AND_DELETION_MIGRATION], now);
}
