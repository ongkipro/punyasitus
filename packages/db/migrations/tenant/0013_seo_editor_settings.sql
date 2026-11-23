-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0013_seo_editor_settings
-- Additive durable plugin-scoped singleton table for `seo-ai-autopilot`
-- SEO Editor Controls & Verification Settings (REQ-053, REQ-055, DEC-039, PLAN §15.3/§15.5/§15.7, TASK-052).
-- Uses canonical plugin prefix `plg_seo_ai_autopilot__*` with zero duplicate tables.

CREATE TABLE IF NOT EXISTS plg_seo_ai_autopilot__settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_json TEXT NOT NULL,
  published_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
