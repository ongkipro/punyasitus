-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0003_pages_layout_mode
-- Additive Landing Page Focus Mode column on `pages` (REQ-008, DEC-038, TASK-005).
-- Safe additive migration with default `'standard'`; compatible rollback preserves draft/published JSON envelopes.

ALTER TABLE pages
  ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (layout_mode IN ('standard', 'focused'));
