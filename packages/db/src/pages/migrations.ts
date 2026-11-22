import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0003_pages_layout_mode.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-008, DEC-038, TASK-005).
 */
export const PAGES_LAYOUT_MODE_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0003_pages_layout_mode
-- Additive Landing Page Focus Mode column on \`pages\` (REQ-008, DEC-038, TASK-005).
-- Safe additive migration with default \`'standard'\`; compatible rollback preserves draft/published JSON envelopes.

ALTER TABLE pages
  ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (layout_mode IN ('standard', 'focused'));
`;

export const PAGES_LAYOUT_MODE_MIGRATION: MigrationDescriptor = {
  version: 3,
  name: "0003_pages_layout_mode",
  sql: PAGES_LAYOUT_MODE_MIGRATION_SQL,
} as const;

/**
 * Idempotently ensures the additive `pages.layout_mode` column exists on a `TenantStore`
 * SQLite database (safe to call even when only `0001_initial_tenant` has been applied,
 * or concurrently across requests).
 */
export async function ensurePagesLayoutModeColumn(tenantDb: D1Database): Promise<boolean> {
  const info = await tenantDb
    .prepare("PRAGMA table_info(pages)")
    .all<{ readonly name: string }>();

  const hasColumn = info.results.some((col) => col.name === "layout_mode");
  if (hasColumn) {
    return true;
  }

  try {
    await tenantDb
      .prepare(
        `ALTER TABLE pages
         ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'standard'
         CHECK (layout_mode IN ('standard', 'focused'))`,
      )
      .run();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(msg)) {
      return true;
    }
    throw err;
  }
}
