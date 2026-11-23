import { splitMigrationStatements, type MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Byte-for-byte bundled SQLite migration descriptor matching
 * `packages/db/migrations/tenant/0013_seo_editor_settings.sql` (TASK-052, REQ-053, REQ-055).
 *
 * Uses the single canonical `plg_seo_ai_autopilot__settings` plugin-scoped table
 * (matching `packages/plugins/seo-ai-autopilot/index.ts` and `AGENTS.md` `plg_<id>__*` rule).
 * Exported as a TypeScript string so Cloudflare `workerd` runtimes and integration tests
 * can apply migration 0013 idempotently without modifying the checksum-locked `TENANT_MIGRATIONS`.
 */
export const TENANT_0013_SEO_EDITOR_SETTINGS_SQL: string =
  "-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0013_seo_editor_settings\n-- Additive durable plugin-scoped singleton table for `seo-ai-autopilot`\n-- SEO Editor Controls & Verification Settings (REQ-053, REQ-055, DEC-039, PLAN §15.3/§15.5/§15.7, TASK-052).\n-- Uses canonical plugin prefix `plg_seo_ai_autopilot__*` with zero duplicate tables.\n\nCREATE TABLE IF NOT EXISTS plg_seo_ai_autopilot__settings (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  draft_json TEXT NOT NULL,\n  published_json TEXT,\n  version INTEGER NOT NULL DEFAULT 1,\n  updated_at INTEGER NOT NULL,\n  published_at INTEGER\n);\n";

export const TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION: MigrationDescriptor = {
  version: 13,
  name: "0013_seo_editor_settings",
  sql: TENANT_0013_SEO_EDITOR_SETTINGS_SQL,
} as const;

/**
 * Idempotently applies migration `0013_seo_editor_settings` to a tenant database.
 */
export async function applyTenantSeoEditorMigration(tenantDb: D1Database): Promise<void> {
  const statements = splitMigrationStatements(TENANT_0013_SEO_EDITOR_SETTINGS_SQL);
  if (statements.length === 0) return;
  await tenantDb.batch(statements.map((sql) => tenantDb.prepare(sql)));
}
