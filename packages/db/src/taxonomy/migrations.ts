import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0008_taxonomy_archive_settings.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-045, PLAN §15.2, TASK-041).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const TAXONOMY_ARCHIVE_SETTINGS_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0008_taxonomy_archive_settings
-- Durable archive index opt-in metadata for taxonomies (REQ-045, PLAN §15.2, TASK-041).
-- Additive migration preserving all existing rows; zero destructive changes.

CREATE TABLE IF NOT EXISTS taxonomy_archive_settings (
  taxonomy_id INTEGER PRIMARY KEY REFERENCES taxonomies(id) ON DELETE CASCADE,
  index_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (index_opt_in IN (0, 1)),
  updated_at INTEGER NOT NULL
);
`;

export const TAXONOMY_ARCHIVE_SETTINGS_MIGRATION: MigrationDescriptor = {
  version: 8,
  name: "0008_taxonomy_archive_settings",
  sql: TAXONOMY_ARCHIVE_SETTINGS_MIGRATION_SQL,
} as const;
