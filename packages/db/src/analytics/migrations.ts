import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import { applyTenantMigrations } from "../connections/migrations.ts";
import type { StorageLike } from "../connections/store-core.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0018_analytics_event_dedup.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-027, REQ-017, REQ-039, PLAN §5.2, §7.3, §18.1, TASK-065).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const ANALYTICS_EVENT_DEDUP_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0018_analytics_event_dedup
-- Additive per-event dedup hardening migration for bounded 24h retention & pruning
-- (REQ-027, REQ-017, REQ-039, PLAN §5.2, §7.3, §18.1, TASK-065).
-- Preserves all existing \`analytics_event_dedup\` rows from 0001_initial_tenant; zero destructive changes.

CREATE TABLE IF NOT EXISTS analytics_event_dedup (
  dedup_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_event_dedup_expires_idx
  ON analytics_event_dedup(expires_at);
`;

export const ANALYTICS_EVENT_DEDUP_MIGRATION: MigrationDescriptor = {
  version: 18,
  name: "0018_analytics_event_dedup",
  sql: ANALYTICS_EVENT_DEDUP_MIGRATION_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_ANALYTICS_DEDUP: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS,
  ANALYTICS_EVENT_DEDUP_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS` plus `0018_analytics_event_dedup` to a `TenantStore`
 * Durable Object SQLite storage handle during provisioning or test setup.
 */
export async function applyTenantAnalyticsDedupMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_ANALYTICS_DEDUP);
}
