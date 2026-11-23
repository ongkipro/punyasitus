import { applyTenantMigrations } from "../connections/migrations.ts";
import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import type { StorageLike } from "../connections/store-core.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0024_lead_preferred_schedule.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-072, PLAN §6 & §18.4, TASK-071).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner or test setup only.
 */
export const TENANT_0024_LEAD_PREFERRED_SCHEDULE_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0024_lead_preferred_schedule
-- Additive preferred schedule branch label snapshot & schedule lookup indexes (REQ-072, PLAN §6 & §18.4, TASK-071).
-- Preserves all existing \`leads\` rows and \`preferred_date\` / \`preferred_time\` / \`branch_id\` columns from 0001_initial_tenant;
-- zero destructive changes.

ALTER TABLE leads
  ADD COLUMN preferred_branch_label TEXT;

CREATE INDEX IF NOT EXISTS leads_preferred_schedule_idx
  ON leads(preferred_date, preferred_time)
  WHERE preferred_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_branch_created_idx
  ON leads(branch_id, created_at)
  WHERE branch_id IS NOT NULL;
`;

export const LEAD_PREFERRED_SCHEDULE_MIGRATION: MigrationDescriptor = {
  version: 24,
  name: "0024_lead_preferred_schedule",
  sql: TENANT_0024_LEAD_PREFERRED_SCHEDULE_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_LEAD_PREFERRED_SCHEDULE: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS,
  LEAD_PREFERRED_SCHEDULE_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS` plus `0024_lead_preferred_schedule` to a
 * `TenantStore` Durable Object SQLite storage handle during provisioning or test setup.
 */
export async function applyTenantLeadPreferredScheduleMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_LEAD_PREFERRED_SCHEDULE);
}

/**
 * Pure read-only check for whether additive migration `0024_lead_preferred_schedule`
 * (`preferred_branch_label`) is present on `leads`.
 * Zero runtime DDL. Rethrows genuine transient DO/SQL errors instead of silently returning false.
 */
export async function hasLeadPreferredBranchLabelColumn(tenantDb: D1Database): Promise<boolean> {
  try {
    const info = await tenantDb
      .prepare("PRAGMA table_info(leads)")
      .all<{ readonly name: string }>();
    return (info.results ?? []).some((col) => col.name === "preferred_branch_label");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(msg)) {
      return false;
    }
    throw err;
  }
}
