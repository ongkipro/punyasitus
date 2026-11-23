-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0020_gtm_kill_switch
-- Additive control-plane policy table for the audited operator Google Tag Manager
-- kill switch (`REQ-027`, `DEC-027`, `PLAN §18.1`, `TASK-076`).

CREATE TABLE IF NOT EXISTS tenant_gtm_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  gtm_disabled INTEGER NOT NULL DEFAULT 0 CHECK (gtm_disabled IN (0, 1)),
  reason_category TEXT CHECK (reason_category IN ('abuse', 'malware', 'performance')),
  reason TEXT,
  disabled_by TEXT REFERENCES users(id),
  disabled_at INTEGER,
  lifted_by TEXT REFERENCES users(id),
  lifted_at INTEGER,
  lift_reason TEXT,
  last_container_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tenant_gtm_policies_disabled_idx
  ON tenant_gtm_policies(gtm_disabled, updated_at);
