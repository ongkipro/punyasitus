-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0011_plugin_runtime_entitlements
-- Additive plugin catalog metadata & tenant plugin entitlement lifecycle columns
-- (REQ-097, ADR-0010, DEC-037, PLAN §19.7, TASK-097).
-- Safe additive migration: preserves all existing plugin_catalog and tenant_plugin_entitlements rows.

ALTER TABLE plugin_catalog
  ADD COLUMN description TEXT NOT NULL DEFAULT '';

ALTER TABLE plugin_catalog
  ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'free'
  CHECK (billing_cycle IN ('free', 'paid_once', 'paid_monthly', 'paid_yearly', 'custom'));

ALTER TABLE plugin_catalog
  ADD COLUMN latest_version TEXT NOT NULL DEFAULT '1.0.0';

ALTER TABLE plugin_catalog
  ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'expired', 'revoked'));

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN expires_at INTEGER;

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN revoked_at INTEGER;

ALTER TABLE tenant_plugin_entitlements
  ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS tenant_plugin_entitlements_tenant_status_idx
  ON tenant_plugin_entitlements(tenant_id, status);
