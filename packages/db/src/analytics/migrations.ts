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

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0022_insights_aggregates.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-073, PLAN §7.3, §18.4, TASK-072).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const INSIGHTS_AGGREGATES_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0022_insights_aggregates
-- Additive privacy-first daily per-tenant aggregate tables for First-Party Insights:
-- popular items (pages, posts, offerings/catalog), coarse traffic sources, and UTC hourly buckets
-- dynamically projected to the tenant's IANA timezone at query time
-- (REQ-073, REQ-017, REQ-033, REQ-039, PLAN §7.3, §18.4, TASK-072).
-- ZERO cookies, IP addresses, user agents, full referrer URLs, or visitor identifiers.

CREATE TABLE IF NOT EXISTS analytics_content_daily (
  day_utc TEXT NOT NULL,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('page', 'post', 'offering', 'taxonomy', 'other')),
  content_id INTEGER NOT NULL DEFAULT 0 CHECK (content_id >= 0),
  path TEXT NOT NULL,
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, content_kind, content_id, path)
);

CREATE INDEX IF NOT EXISTS analytics_content_daily_day_idx
  ON analytics_content_daily(day_utc);

CREATE TABLE IF NOT EXISTS analytics_hourly_utc (
  day_utc TEXT NOT NULL,
  utc_hour INTEGER NOT NULL CHECK (utc_hour >= 0 AND utc_hour <= 23),
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, utc_hour)
);

CREATE INDEX IF NOT EXISTS analytics_hourly_utc_day_idx
  ON analytics_hourly_utc(day_utc);

CREATE TABLE IF NOT EXISTS analytics_sources_daily (
  day_utc TEXT NOT NULL,
  source_bucket TEXT NOT NULL CHECK (
    source_bucket IN ('search', 'social', 'campaign', 'ai_assistant', 'referral', 'direct')
  ),
  utm_source TEXT NOT NULL DEFAULT '',
  page_views INTEGER NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  wa_clicks INTEGER NOT NULL DEFAULT 0 CHECK (wa_clicks >= 0),
  external_clicks INTEGER NOT NULL DEFAULT 0 CHECK (external_clicks >= 0),
  lead_submits INTEGER NOT NULL DEFAULT 0 CHECK (lead_submits >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, source_bucket, utm_source)
);

CREATE INDEX IF NOT EXISTS analytics_sources_daily_day_idx
  ON analytics_sources_daily(day_utc);
`;

export const INSIGHTS_AGGREGATES_MIGRATION: MigrationDescriptor = {
  version: 22,
  name: "0022_insights_aggregates",
  sql: INSIGHTS_AGGREGATES_MIGRATION_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_INSIGHTS: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS_WITH_ANALYTICS_DEDUP,
  INSIGHTS_AGGREGATES_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS`, `0018_analytics_event_dedup`, and
 * `0022_insights_aggregates` to a `TenantStore` Durable Object SQLite storage handle
 * during provisioning or test setup.
 */
export async function applyTenantInsightsMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_INSIGHTS);
}
