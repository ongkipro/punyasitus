-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0012_starter_presets
-- Additive starter preset draft composition, checklist readiness state, and
-- idempotent setup operation ledger (REQ-047, PLAN §11.4, TASK-043).
-- Preserves all existing tenant pages, posts, offerings, menus, media, and published snapshots.

CREATE TABLE IF NOT EXISTS preset_setups (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL DEFAULT 'initialized_draft' CHECK (
    apply_mode IN ('initialized_draft', 'staged_draft', 'merged_draft')
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  draft_sections_json TEXT NOT NULL DEFAULT '[]',
  sample_section_ids_json TEXT NOT NULL DEFAULT '[]',
  selected_publish_section_ids_json TEXT NOT NULL DEFAULT '[]',
  published_section_ids_json TEXT,
  last_operation_key TEXT,
  previewed_at INTEGER,
  published_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_setup_operations (
  operation_key TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL CHECK (preset_id IN ('company_profile', 'services', 'travel', 'outlets')),
  apply_mode TEXT NOT NULL CHECK (
    apply_mode IN ('preserve_existing', 'merge_draft')
  ),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
