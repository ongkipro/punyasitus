-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0017_tenant_offboarding
-- Additive locked-tenant retention warning ledger, resumable idempotent offboarding checkpoints,
-- and durable leads CSV export rate-limit buckets (REQ-069, PLAN §17.3, DEC-022, TASK-068).

CREATE TABLE IF NOT EXISTS tenant_offboarding_runs (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'purged')),
  claimed_at INTEGER NOT NULL,
  deletion_due_at INTEGER NOT NULL,
  original_handle TEXT NOT NULL,
  hostnames_purged_at INTEGER,
  r2_purged_at INTEGER,
  tenant_store_purged_at INTEGER,
  memberships_purged_at INTEGER,
  residuals_deidentified_at INTEGER,
  tombstone_recorded_at INTEGER,
  completed_at INTEGER,
  last_error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tenant_offboarding_runs_status_updated_idx
  ON tenant_offboarding_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS tenant_offboarding_warnings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  warning_stage TEXT NOT NULL CHECK (
    warning_stage IN (
      'unpaid_minus_7d',
      'unpaid_minus_3d',
      'unpaid_minus_1d',
      'paid_h38',
      'paid_h42',
      'paid_h44'
    )
  ),
  deletion_due_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('claimed', 'submitted', 'suppressed_catchup', 'skipped', 'failed', 'unknown')
  ),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, warning_stage, deletion_due_at)
);

CREATE INDEX IF NOT EXISTS tenant_offboarding_warnings_tenant_due_idx
  ON tenant_offboarding_warnings(tenant_id, deletion_due_at);

CREATE TABLE IF NOT EXISTS leads_export_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  window_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS leads_export_rate_limits_expires_idx
  ON leads_export_rate_limits(window_expires_at);

CREATE INDEX IF NOT EXISTS tenants_offboarding_due_idx
  ON tenants(status, deletion_due_at)
  WHERE deletion_due_at IS NOT NULL;
