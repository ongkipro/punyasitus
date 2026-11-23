-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0017_branches
-- Additive multi-branch extensions & single-primary-branch invariant (REQ-088, PLAN §5.2, §19.5, TASK-088).
-- Preserves all existing `branches` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE branches ADD COLUMN city TEXT;
ALTER TABLE branches ADD COLUMN province TEXT;
ALTER TABLE branches ADD COLUMN postal_code TEXT;
ALTER TABLE branches ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS branches_single_primary_idx
  ON branches(is_primary)
  WHERE is_primary = 1;

CREATE INDEX IF NOT EXISTS branches_sort_order_idx
  ON branches(is_primary DESC, sort_order ASC, id ASC);

CREATE INDEX IF NOT EXISTS branches_active_sort_idx
  ON branches(active, is_primary DESC, sort_order ASC, id ASC);
