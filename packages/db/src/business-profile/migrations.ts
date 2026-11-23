import type { MigrationDescriptor } from "../connections/sql-splitter.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0011_business_profile_structured.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-091, PLAN §5.2, §7.3, §19.5, TASK-091).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const BUSINESS_PROFILE_STRUCTURED_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0011_business_profile_structured
-- Additive structured business profile extensions & logo auto-derived brand assets (REQ-091, PLAN §5.2, §7.3, §19.5, TASK-091).
-- Preserves all existing site_settings and business_profile rows; zero destructive changes.

CREATE TABLE IF NOT EXISTS business_profile_structured (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name TEXT,
  privacy_contact TEXT,
  person_role_title TEXT,
  affiliated_org_name TEXT,
  closed_days_json TEXT NOT NULL DEFAULT '[]',
  credentials_json TEXT NOT NULL DEFAULT '{}',
  draft_json TEXT,
  published_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_asset_derivations (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_logo_media_id INTEGER REFERENCES media_items(id),
  favicon_override_media_id INTEGER REFERENCES media_items(id),
  og_image_override_media_id INTEGER REFERENCES media_items(id),
  derived_favicon_32_json TEXT,
  derived_apple_touch_180_json TEXT,
  derived_og_1200x630_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`;

export const BUSINESS_PROFILE_STRUCTURED_MIGRATION: MigrationDescriptor = {
  version: 11,
  name: "0011_business_profile_structured",
  sql: BUSINESS_PROFILE_STRUCTURED_MIGRATION_SQL,
} as const;
