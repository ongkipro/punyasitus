-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0021_theme_style_variants
-- Additive style_variant_id column on theme_configs for per-theme Style Variant persistence
-- (REQ-096, ADR-0010, PLAN §11.4 & §19.7, TASK-096).

ALTER TABLE theme_configs ADD COLUMN style_variant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS theme_configs_style_variant_idx
  ON theme_configs(theme_id, style_variant_id);
