-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0008_taxonomy_archive_settings
-- Durable archive index opt-in metadata for taxonomies (REQ-045, PLAN §15.2, TASK-041).
-- Additive migration preserving all existing rows; zero destructive changes.

CREATE TABLE IF NOT EXISTS taxonomy_archive_settings (
  taxonomy_id INTEGER PRIMARY KEY REFERENCES taxonomies(id) ON DELETE CASCADE,
  index_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (index_opt_in IN (0, 1)),
  updated_at INTEGER NOT NULL
);
