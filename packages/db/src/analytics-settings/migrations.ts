import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0020_gtm_kill_switch.sql`
 * byte-for-byte so Cloudflare `workerd` tests and migration runners can apply it
 * alongside `PLATFORM_MIGRATIONS` without filesystem access and without altering
 * `PLATFORM_MIGRATIONS` checksums.
 *
 * Hard invariant: NEVER invoke this helper from runtime request handlers, APIs,
 * or `.astro` pages (zero request-time runtime DDL).
 */
export const GTM_KILL_SWITCH_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0020_gtm_kill_switch
-- Additive control-plane policy table for the audited operator Google Tag Manager
-- kill switch (\`REQ-027\`, \`DEC-027\`, \`PLAN §18.1\`, \`TASK-076\`).

CREATE TABLE IF NOT EXISTS tenant_gtm_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  gtm_disabled INTEGER NOT NULL DEFAULT 0 CHECK (gtm_disabled IN (0, 1)),
  reason_category TEXT CHECK (reason_category IN ('abuse', 'malware', 'performance')),
  reason TEXT,
  disabled_by TEXT REFERENCES users(id),
  disabled_at INTEGER,
  lifted_by TEXT REFERENCES users(id),
  lifted_at INTEGER,
  lift_reason TEXT,
  last_container_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tenant_gtm_policies_disabled_idx
  ON tenant_gtm_policies(gtm_disabled, updated_at);
`;

export const GTM_KILL_SWITCH_MIGRATION: MigrationDescriptor = {
  version: 20,
  name: "0020_gtm_kill_switch",
  sql: GTM_KILL_SWITCH_MIGRATION_SQL,
} as const;

export async function applyGtmKillSwitchMigration(
  db: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(db, [GTM_KILL_SWITCH_MIGRATION], now);
}
