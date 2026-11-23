-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0004_plugin_migrations_ledger
-- Additive per-tenant plugin migration ledger tracking `plg_<id>__*` schema versions
-- with pre-migration PITR bookmark references (REQ-097, ADR-0009, ADR-0010, TASK-097).
-- Safe additive migration: preserves all existing tenant data and `installed_plugins` rows.

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
