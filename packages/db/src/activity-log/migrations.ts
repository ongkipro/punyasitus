import { splitMigrationStatements, type MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Bundled SQLite migration matching `packages/db/migrations/tenant/0015_tenant_activity_log_indexes.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access and without altering `TENANT_MIGRATIONS` checksums.
 */
export const TENANT_0015_ACTIVITY_LOG_INDEXES_SQL: string = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0015_tenant_activity_log_indexes
-- Additive indexes and update-immutability guard for tenant_activity_log (REQ-094, PLAN §5.2, TASK-094).
-- Preserves DELETE capability for 90-day retention pruning (REQ-039) and transaction compensations.

CREATE INDEX IF NOT EXISTS tenant_activity_log_action_created_idx
  ON tenant_activity_log(action, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tenant_activity_log_resource_created_idx
  ON tenant_activity_log(resource_type, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS tenant_activity_log_no_update
BEFORE UPDATE ON tenant_activity_log
BEGIN
  SELECT RAISE(ABORT, 'tenant_activity_log is immutable');
END;
`;

export const TENANT_ACTIVITY_LOG_INDEXES_MIGRATION: MigrationDescriptor = {
  version: 15,
  name: "0015_tenant_activity_log_indexes",
  sql: TENANT_0015_ACTIVITY_LOG_INDEXES_SQL,
} as const;

/**
 * Idempotently ensures the additive `tenant_activity_log` indexes and update-immutability
 * trigger exist on a tenant's `TenantStore` database.
 */
export async function ensureTenantActivityLogSchema(tenantDb: D1Database): Promise<void> {
  const statements = splitMigrationStatements(TENANT_0015_ACTIVITY_LOG_INDEXES_SQL);
  if (statements.length === 0) return;
  await tenantDb.batch(statements.map((sql) => tenantDb.prepare(sql)));
}
