-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0015_tenant_activity_log_indexes
-- Additive indexes and update-immutability guard for tenant_activity_log (REQ-094, PLAN §5.2, TASK-094).
-- Preserves DELETE capability for 90-day retention pruning (REQ-039) and transaction compensations.

CREATE INDEX IF NOT EXISTS tenant_activity_log_action_created_idx
  ON tenant_activity_log(action, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tenant_activity_log_resource_created_idx
  ON tenant_activity_log(resource_type, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS tenant_activity_log_no_update
BEFORE UPDATE ON tenant_activity_log
BEGIN
  SELECT RAISE(ABORT, 'tenant_activity_log is immutable');
END;
