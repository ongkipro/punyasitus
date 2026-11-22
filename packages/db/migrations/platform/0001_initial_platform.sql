-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0001_initial_platform
-- Additive initial schema pre-declaring finalized v1 control-plane tables (PLAN §5.1, ADR-0009).

-- ---------------------------------------------------------------------------
-- 1. Auth & IAM (Better Auth SQLite + Organizations + 2FA + MCP OAuth 2.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts(user_id);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications(identifier);

CREATE TABLE IF NOT EXISTS two_factors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'agency_staff', 'setup_staff')),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user_id_idx ON members(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled', 'expired')),
  expires_at INTEGER NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invitations_org_email_idx ON invitations(organization_id, email);

CREATE TABLE IF NOT EXISTS oauth_applications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  name TEXT NOT NULL,
  redirect_urls TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'public',
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  user_id TEXT REFERENCES users(id),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL UNIQUE,
  refresh_token TEXT UNIQUE,
  access_token_expires_at INTEGER NOT NULL,
  refresh_token_expires_at INTEGER,
  client_id TEXT NOT NULL REFERENCES oauth_applications(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_id_idx ON oauth_access_tokens(user_id);

CREATE TABLE IF NOT EXISTS oauth_consents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_applications(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  consent_given INTEGER NOT NULL DEFAULT 0 CHECK (consent_given IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (client_id, user_id)
);

CREATE TABLE IF NOT EXISTS platform_operators (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  granted_by TEXT REFERENCES users(id),
  reason TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users(id),
  revoke_reason TEXT
);

-- ---------------------------------------------------------------------------
-- 2. Agencies & Affiliates (REQ-083..086)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
  discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  unpaid_trial_cap INTEGER NOT NULL DEFAULT 3 CHECK (unpaid_trial_cap >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS affiliates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  referral_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  payout_method TEXT,
  payout_account_name TEXT,
  payout_account_number TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. Tenancy, Routing, PITR Migration Bookmarks & Tombstones
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  agency_id TEXT REFERENCES agencies(id),
  referred_by_affiliate_id TEXT REFERENCES affiliates(id),
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  vertical TEXT NOT NULL DEFAULT 'compro' CHECK (vertical IN ('compro', 'sales', 'travel', 'catalog', 'resto', 'dealer')),
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (
    status IN ('provisioning', 'trial', 'active', 'grace', 'locked', 'suspended', 'recovery', 'purging', 'purged')
  ),
  operator_hold INTEGER NOT NULL DEFAULT 0 CHECK (operator_hold IN (0, 1)),
  operator_hold_reason TEXT,
  trial_ends_at INTEGER,
  paid_through INTEGER,
  deletion_due_at INTEGER,
  retention_paused_at INTEGER,
  offboarding_started_at INTEGER,
  cache_version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tenants_org_id_idx ON tenants(organization_id);
CREATE INDEX IF NOT EXISTS tenants_agency_id_idx ON tenants(agency_id);
CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_hosts (
  host TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('subdomain', 'custom')),
  cf_custom_hostname_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'moved', 'deleting')),
  ssl_status TEXT NOT NULL DEFAULT 'pending',
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  verified_at INTEGER,
  last_checked_at INTEGER,
  quarantined_until INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tenant_hosts_tenant_id_idx ON tenant_hosts(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_hosts_one_primary_per_tenant_idx
  ON tenant_hosts(tenant_id)
  WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS migration_bookmarks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  target_version INTEGER NOT NULL,
  target_migration TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'restored')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS migration_bookmarks_tenant_created_idx
  ON migration_bookmarks(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL,
  quarantine_until INTEGER NOT NULL,
  google_sub_hash TEXT,
  email_hash TEXT,
  company_name_hash TEXT,
  reason TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deletion_tombstones_handle_idx ON deletion_tombstones(handle);

-- ---------------------------------------------------------------------------
-- 4. Billing, Coupons, Settlements, Entitlements & Numbered Receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed_idr')),
  discount_value INTEGER NOT NULL CHECK (discount_value >= 0),
  max_redemptions INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  valid_from INTEGER,
  valid_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_obligations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  payer_type TEXT NOT NULL CHECK (payer_type IN ('tenant', 'agency')),
  payer_agency_id TEXT REFERENCES agencies(id),
  plan_interval TEXT NOT NULL CHECK (plan_interval IN ('monthly', 'yearly', 'one_time')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'canceled', 'refunded')),
  gross_amount_idr INTEGER NOT NULL CHECK (gross_amount_idr >= 0 AND gross_amount_idr <= 999999999999),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999),
  net_amount_idr INTEGER NOT NULL CHECK (net_amount_idr >= 0 AND net_amount_idr <= 999999999999),
  coupon_id TEXT REFERENCES coupons(id),
  coupon_snapshot_json TEXT,
  due_at INTEGER NOT NULL,
  paid_at INTEGER,
  deidentified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_obligations_tenant_id_idx ON billing_obligations(tenant_id);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES billing_obligations(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  channel TEXT NOT NULL CHECK (channel IN ('QRIS', 'VA')),
  provider TEXT NOT NULL DEFAULT 'autolaris',
  provider_transaction_id TEXT UNIQUE,
  amount_idr INTEGER NOT NULL CHECK (amount_idr >= 0 AND amount_idr <= 999999999999),
  state TEXT NOT NULL DEFAULT 'initiated' CHECK (state IN ('initiated', 'pending', 'settled', 'failed', 'expired')),
  expires_at INTEGER,
  provider_payload_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_attempts_tenant_id_idx ON payment_attempts(tenant_id);
CREATE INDEX IF NOT EXISTS payment_attempts_obligation_id_idx ON payment_attempts(obligation_id);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES billing_obligations(id),
  payment_attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  amount_idr INTEGER NOT NULL CHECK (amount_idr >= 0 AND amount_idr <= 999999999999),
  settled_at INTEGER NOT NULL,
  reconciled_via TEXT NOT NULL CHECK (reconciled_via IN ('webhook', 'advice', 'manual')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_tenant_id_idx ON settlements(tenant_id);

CREATE TABLE IF NOT EXISTS entitlement_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  settlement_id TEXT REFERENCES settlements(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  granted_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entitlement_grants_tenant_id_idx ON entitlement_grants(tenant_id);

CREATE TABLE IF NOT EXISTS receipt_sequences (
  year INTEGER PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  settlement_id TEXT REFERENCES settlements(id),
  receipt_number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt', 'credit_note')),
  related_receipt_id TEXT,
  amount_idr INTEGER NOT NULL CHECK (amount_idr >= 0 AND amount_idr <= 999999999999),
  r2_pdf_key TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_tenant_id_idx ON receipts(tenant_id);

-- ---------------------------------------------------------------------------
-- 5. Affiliate Commissions & Payout Batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_payout_batches (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  batch_date TEXT NOT NULL,
  total_amount_idr INTEGER NOT NULL CHECK (total_amount_idr >= 0 AND total_amount_idr <= 999999999999),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled')),
  transfer_reference TEXT,
  paid_at INTEGER,
  paid_by TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS affiliate_payout_batches_affiliate_idx ON affiliate_payout_batches(affiliate_id);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  payout_batch_id TEXT REFERENCES affiliate_payout_batches(id),
  commission_type TEXT NOT NULL CHECK (commission_type IN ('first_payment', 'renewal', 'offset')),
  rate_percent INTEGER NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  amount_idr INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'reversed')),
  eligible_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_idx ON affiliate_commissions(affiliate_id);
CREATE INDEX IF NOT EXISTS affiliate_commissions_tenant_idx ON affiliate_commissions(tenant_id);

-- ---------------------------------------------------------------------------
-- 6. Theme/Plugin Catalogs, Service Requests & Platform Operations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theme_catalog (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('included', 'paid_once', 'custom')),
  price_idr INTEGER NOT NULL DEFAULT 0 CHECK (price_idr >= 0 AND price_idr <= 999999999999),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_theme_entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  theme_id TEXT NOT NULL REFERENCES theme_catalog(id),
  granted_by TEXT,
  settlement_id TEXT REFERENCES settlements(id),
  granted_at INTEGER NOT NULL,
  UNIQUE (tenant_id, theme_id)
);

CREATE TABLE IF NOT EXISTS plugin_catalog (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  distribution TEXT NOT NULL CHECK (distribution IN ('private_client', 'public_free', 'public_paid')),
  price_idr INTEGER NOT NULL DEFAULT 0 CHECK (price_idr >= 0 AND price_idr <= 999999999999),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_plugin_entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plugin_id TEXT NOT NULL REFERENCES plugin_catalog(id),
  granted_by TEXT,
  settlement_id TEXT REFERENCES settlements(id),
  granted_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS service_packages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('custom_theme', 'custom_plugin', 'setup')),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_idr INTEGER NOT NULL CHECK (price_idr >= 0 AND price_idr <= 999999999999),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  package_id TEXT NOT NULL REFERENCES service_packages(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'in_review', 'in_progress', 'delivered', 'declined', 'canceled')
  ),
  brief_json TEXT NOT NULL,
  delivered_theme_id TEXT REFERENCES theme_catalog(id),
  delivered_plugin_id TEXT REFERENCES plugin_catalog(id),
  operator_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS service_requests_tenant_id_idx ON service_requests(tenant_id);

CREATE TABLE IF NOT EXISTS marketing_funnel_events (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  event_name TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS marketing_funnel_events_day_idx ON marketing_funnel_events(day, event_name);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reported_host TEXT NOT NULL,
  reported_path TEXT NOT NULL,
  category TEXT NOT NULL,
  details TEXT NOT NULL,
  reporter_contact TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_notes TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS abuse_reports_tenant_id_idx ON abuse_reports(tenant_id);
CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports(status);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  tenant_id TEXT,
  reason TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  request_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_audit_tenant_created_idx ON platform_audit(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS platform_audit_action_created_idx ON platform_audit(action, created_at);

CREATE TRIGGER IF NOT EXISTS platform_audit_no_update
BEFORE UPDATE ON platform_audit
BEGIN
  SELECT RAISE(ABORT, 'platform_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS platform_audit_no_delete
BEFORE DELETE ON platform_audit
BEGIN
  SELECT RAISE(ABORT, 'platform_audit is append-only');
END;

CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual_opt_out')),
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_ledger (
  idempotency_key TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until INTEGER,
  last_error_code TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_ledger_status_idx ON job_ledger(status, updated_at);
