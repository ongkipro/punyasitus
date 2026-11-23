import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Byte-for-byte bundled SQLite migration descriptor matching
 * `packages/db/migrations/tenant/0005_site_settings_grouped.sql` (TASK-040, REQ-044).
 *
 * Exported as a TypeScript string so Cloudflare `workerd` runtimes and integration tests
 * can apply migration 0005 without filesystem access (zero request-time runtime DDL).
 *
 * Registration note: Following the repository's additive tenant migration convention
 * (`0002`, `0003`, `0004`, `0006`, `0008`), `TENANT_MIGRATIONS` in
 * `packages/db/src/tenant/migrations.ts` is checksum-locked by `tests/task-001` and
 * central registration of all Wave 3-5 additive tenant migrations is owned by `TASK-063`
 * (M1 Integration Gate). Runtime queries check `sqlite_master` read-only and gracefully
 * fall back in pre-0005 harnesses.
 */
export const TENANT_0005_SITE_SETTINGS_GROUPED_SQL: string =
  "-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0005_site_settings_grouped\n-- Dedicated durable singleton table for grouped-only settings (homepageMode, homepagePageId,\n-- enabledOfferingTypes, itemsPerPage, defaultTitle, defaultDescription, verification tokens,\n-- privacyPageId, consentBannerText, consentPolicyVersion) so TASK-008/TASK-095 updates to\n-- `site_settings` never overwrite grouped settings (REQ-044, TASK-040).\n\nCREATE TABLE IF NOT EXISTS site_settings_grouped (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  draft_json TEXT NOT NULL,\n  published_json TEXT,\n  version INTEGER NOT NULL DEFAULT 1,\n  updated_at INTEGER NOT NULL,\n  published_at INTEGER\n);\n";

export const TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION: MigrationDescriptor = {
  version: 5,
  name: "0005_site_settings_grouped",
  sql: TENANT_0005_SITE_SETTINGS_GROUPED_SQL,
} as const;
