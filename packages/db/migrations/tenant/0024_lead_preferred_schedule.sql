-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0024_lead_preferred_schedule
-- Additive preferred schedule branch label snapshot & schedule lookup indexes (REQ-072, PLAN §6 & §18.4, TASK-071).
-- Preserves all existing `leads` rows and `preferred_date` / `preferred_time` / `branch_id` columns from 0001_initial_tenant;
-- zero destructive changes.

ALTER TABLE leads
  ADD COLUMN preferred_branch_label TEXT;

CREATE INDEX IF NOT EXISTS leads_preferred_schedule_idx
  ON leads(preferred_date, preferred_time)
  WHERE preferred_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_branch_created_idx
  ON leads(branch_id, created_at)
  WHERE branch_id IS NOT NULL;
