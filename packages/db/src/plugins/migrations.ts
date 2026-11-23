import {
  applyPlatformMigrations,
  orchestrateTenantMigration,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
  type OrchestrateTenantMigrationOptions,
  type OrchestrateTenantMigrationResult,
} from "../connections/migrations.ts";
import type { TenantStoreRpcStub } from "../connections/tenant-db.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0011_plugin_runtime_entitlements.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `PLATFORM_MIGRATIONS` without filesystem access (REQ-097, TASK-097).
 */
export const PLATFORM_PLUGIN_RUNTIME_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0011_plugin_runtime_entitlements
-- Additive plugin catalog metadata & tenant plugin entitlement lifecycle columns
-- (REQ-097, ADR-0010, DEC-037, PLAN §19.7, TASK-097).
-- Safe additive migration: preserves all existing plugin_catalog and tenant_plugin_entitlements rows.

ALTER TABLE plugin_catalog
  ADD COLUMN description TEXT NOT NULL DEFAULT '';

ALTER TABLE plugin_catalog
  ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'free'
  CHECK (billing_cycle IN ('free', 'paid_once', 'paid_monthly', 'paid_yearly', 'custom'));

ALTER TABLE plugin_catalog
  ADD COLUMN latest_version TEXT NOT NULL DEFAULT '1.0.0';

ALTER TABLE plugin_catalog
  ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'expired', 'revoked'));

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN expires_at INTEGER;

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN revoked_at INTEGER;

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS tenant_plugin_entitlements_tenant_status_idx
  ON tenant_plugin_entitlements(tenant_id, status);
`;

export const PLATFORM_PLUGIN_RUNTIME_MIGRATION: MigrationDescriptor = {
  version: 11,
  name: "0011_plugin_runtime_entitlements",
  sql: PLATFORM_PLUGIN_RUNTIME_MIGRATION_SQL,
} as const;

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0004_plugin_migrations_ledger.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-097, ADR-0009, ADR-0010, TASK-097).
 */
export const TENANT_PLUGIN_LEDGER_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0004_plugin_migrations_ledger
-- Additive per-tenant plugin migration ledger tracking \`plg_<id>__*\` schema versions
-- with pre-migration PITR bookmark references (REQ-097, ADR-0009, ADR-0010, TASK-097).
-- Safe additive migration: preserves all existing tenant data and \`installed_plugins\` rows.

CREATE TABLE IF NOT EXISTS _plugin_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  bookmark_id TEXT,
  applied_at INTEGER NOT NULL,
  UNIQUE (plugin_id, name)
);

CREATE INDEX IF NOT EXISTS _plugin_migrations_plugin_version_idx
  ON _plugin_migrations(plugin_id, version);
`;

export const TENANT_PLUGIN_LEDGER_MIGRATION: MigrationDescriptor = {
  version: 4,
  name: "0004_plugin_migrations_ledger",
  sql: TENANT_PLUGIN_LEDGER_MIGRATION_SQL,
} as const;

export async function applyPlatformPluginRuntimeMigration(
  platformDb: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(platformDb, [PLATFORM_PLUGIN_RUNTIME_MIGRATION], now);
}

export async function applyTenantPluginLedgerMigration(
  platformDb: D1Database,
  stub: TenantStoreRpcStub,
  tenantId: string,
  options?: OrchestrateTenantMigrationOptions,
): Promise<OrchestrateTenantMigrationResult> {
  return orchestrateTenantMigration(
    platformDb,
    stub,
    tenantId,
    [TENANT_PLUGIN_LEDGER_MIGRATION],
    options,
  );
}
