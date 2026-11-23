import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import { applyTenantMigrations } from "../connections/migrations.ts";
import type { StorageLike } from "../connections/store-core.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0017_branches.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-088, PLAN §5.2, §19.5, TASK-088).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const BRANCHES_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0017_branches
-- Additive multi-branch extensions & single-primary-branch invariant (REQ-088, PLAN §5.2, §19.5, TASK-088).
-- Preserves all existing \`branches\` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE branches ADD COLUMN city TEXT;
ALTER TABLE branches ADD COLUMN province TEXT;
ALTER TABLE branches ADD COLUMN postal_code TEXT;
ALTER TABLE branches ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS branches_single_primary_idx
  ON branches(is_primary)
  WHERE is_primary = 1;

CREATE INDEX IF NOT EXISTS branches_sort_order_idx
  ON branches(is_primary DESC, sort_order ASC, id ASC);

CREATE INDEX IF NOT EXISTS branches_active_sort_idx
  ON branches(active, is_primary DESC, sort_order ASC, id ASC);
`;

export const BRANCHES_MIGRATION: MigrationDescriptor = {
  version: 17,
  name: "0017_branches",
  sql: BRANCHES_MIGRATION_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_BRANCHES: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS,
  BRANCHES_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS` plus `0017_branches` to a `TenantStore`
 * Durable Object SQLite storage handle during provisioning or test setup.
 */
export async function applyTenantBranchesMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_BRANCHES);
}
