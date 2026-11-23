import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Byte-for-byte bundled SQLite migration descriptor matching
 * `packages/db/migrations/tenant/0012_starter_presets.sql` (TASK-043, REQ-047).
 *
 * Exported as a TypeScript string so Cloudflare `workerd` runtimes and integration tests
 * can apply migration 0012 without filesystem access.
 *
 * Registration note: Following the repository's additive tenant migration convention
 * (`0002`, `0003`, `0004`, `0005`, `0006`, `0008`, `0011`), `TENANT_MIGRATIONS` in
 * `packages/db/src/tenant/migrations.ts` is checksum-locked by `tests/task-001` and
 * central registration is owned by `TASK-063`.
 */
export const TENANT_0012_STARTER_PRESETS_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0012_starter_presets
-- Additive starter preset draft composition, checklist readiness state, and
-- idempotent setup operation ledger (REQ-047, PLAN §11.4, TASK-043).
-- Preserves all existing tenant pages, posts, offerings, menus, media, and published snapshots.

CREATE TABLE IF NOT EXISTS preset_setups (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL DEFAULT 'initialized_draft' CHECK (
    apply_mode IN ('initialized_draft', 'staged_draft', 'merged_draft')
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  draft_sections_json TEXT NOT NULL DEFAULT '[]',
  sample_section_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_publish_section_ids_json TEXT NOT NULL DEFAULT '[]',
  published_section_ids_json TEXT,
  last_operation_key TEXT,
  previewed_at INTEGER,
  published_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_setup_operations (
  operation_key TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL CHECK (
    apply_mode IN ('preserve_existing', 'merge_draft')
  ),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export const TENANT_0012_STARTER_PRESETS_MIGRATION: MigrationDescriptor = {
  version: 12,
  name: "0012_starter_presets",
  sql: TENANT_0012_STARTER_PRESETS_SQL,
} as const;

const CREATE_PRESET_SETUPS_SQL = `CREATE TABLE IF NOT EXISTS preset_setups (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL DEFAULT 'initialized_draft' CHECK (
    apply_mode IN ('initialized_draft', 'staged_draft', 'merged_draft')
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  draft_sections_json TEXT NOT NULL DEFAULT '[]',
  sample_section_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_publish_section_ids_json TEXT NOT NULL DEFAULT '[]',
  published_section_ids_json TEXT,
  last_operation_key TEXT,
  previewed_at INTEGER,
  published_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const CREATE_PRESET_SETUP_OPERATIONS_SQL = `CREATE TABLE IF NOT EXISTS preset_setup_operations (
  operation_key TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL CHECK (
    apply_mode IN ('preserve_existing', 'merge_draft')
  ),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

/**
 * Idempotently checks whether the additive `preset_setups` and
 * `preset_setup_operations` tables exist on a `TenantStore` SQLite database.
 */
export async function hasStarterPresetsTables(tenantDb: D1Database): Promise<boolean> {
  const rows = await tenantDb
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('preset_setups', 'preset_setup_operations')`,
    )
    .all<{ readonly name: string }>();
  const names = new Set(rows.results.map((r) => r.name));
  return names.has("preset_setups") && names.has("preset_setup_operations");
}

/**
 * Idempotently ensures the additive `preset_setups` and `preset_setup_operations`
 * tables exist on a `TenantStore` SQLite database (safe to invoke concurrently or
 * in harnesses where only `0001_initial_tenant` was initially applied).
 */
export async function ensureStarterPresetsTables(tenantDb: D1Database): Promise<void> {
  if (await hasStarterPresetsTables(tenantDb)) {
    return;
  }
  await tenantDb.batch([
    tenantDb.prepare(CREATE_PRESET_SETUPS_SQL),
    tenantDb.prepare(CREATE_PRESET_SETUP_OPERATIONS_SQL),
  ]);
}
