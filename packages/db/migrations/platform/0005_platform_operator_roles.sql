-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0005_platform_operator_roles
-- Additive operator role & optimistic version columns for platform console lifecycle
-- (REQ-051, PLAN §13; TASK-048). Preserves all existing platform_operators rows.

ALTER TABLE platform_operators
  ADD COLUMN role TEXT NOT NULL DEFAULT 'platform_superadmin'
  CHECK (role IN ('platform_superadmin', 'platform_support'));

ALTER TABLE platform_operators
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
