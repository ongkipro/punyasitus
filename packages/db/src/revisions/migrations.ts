import { applyTenantMigrations } from "../connections/migrations.ts";
import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import type { StorageLike } from "../connections/store-core.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0023_content_revision_history.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-048, PLAN §5.2 & §11.5, TASK-064).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner or test setup only.
 */
export const TENANT_0023_CONTENT_REVISION_HISTORY_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0023_content_revision_history
-- Additive Content Revision History metadata & lookup index (REQ-048, PLAN §5.2 & §11.5, TASK-064).
-- Preserves all existing \`content_revisions\` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE content_revisions
  ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'publish'
  CHECK (trigger_kind IN ('save', 'publish', 'restore'));

ALTER TABLE content_revisions
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (schema_version >= 1);

ALTER TABLE content_revisions
  ADD COLUMN summary TEXT;

CREATE INDEX IF NOT EXISTS content_revisions_resource_created_idx
  ON content_revisions(resource_type, resource_id, created_at DESC, revision_number DESC);
`;

export const CONTENT_REVISION_HISTORY_MIGRATION: MigrationDescriptor = {
  version: 23,
  name: "0023_content_revision_history",
  sql: TENANT_0023_CONTENT_REVISION_HISTORY_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_CONTENT_REVISION_HISTORY: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS,
  CONTENT_REVISION_HISTORY_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS` plus `0023_content_revision_history` to a
 * `TenantStore` Durable Object SQLite storage handle during provisioning or test setup.
 */
export async function applyTenantContentRevisionHistoryMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_CONTENT_REVISION_HISTORY);
}

/**
 * Pure read-only check for whether additive migration `0023_content_revision_history`
 * (`trigger_kind`, `schema_version`, `summary`) is present on `content_revisions`.
 * Zero runtime DDL. Rethrows genuine transient DO/SQL errors instead of silently returning false.
 */
export async function hasContentRevisionHistoryColumns(tenantDb: D1Database): Promise<boolean> {
  try {
    const info = await tenantDb
      .prepare("PRAGMA table_info(content_revisions)")
      .all<{ readonly name: string }>();
    const names = new Set(info.results.map((c) => c.name));
    return names.has("trigger_kind") && names.has("schema_version") && names.has("summary");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      return false;
    }
    throw err;
  }
}
