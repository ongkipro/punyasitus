-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0028_agency_portal
-- Additive Agency / Reseller Portal enrollment, membership, invitations, client links,
-- atomic unpaid-trial cap enforcement, and volume discount tier storage
-- (REQ-083, PLAN §19.4, TASK-083).

CREATE UNIQUE INDEX IF NOT EXISTS agencies_owner_user_uidx
  ON agencies(owner_user_id);

CREATE TABLE IF NOT EXISTS agency_enrollment_records (
  agency_id TEXT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  enrollment_source TEXT NOT NULL CHECK (enrollment_source IN ('self_registered', 'operator_invited')),
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  terms_accepted_by_user_id TEXT NOT NULL REFERENCES users(id),
  billing_email TEXT NOT NULL,
  billing_name TEXT NOT NULL,
  discount_tier_code TEXT NOT NULL DEFAULT 'standard_0',
  discount_tiers_json TEXT NOT NULL DEFAULT '[]',
  first_paid_at INTEGER,
  first_paid_tenant_id TEXT REFERENCES tenants(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_members (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('agency_owner', 'agency_admin', 'agency_billing', 'agency_staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  invited_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (agency_id, user_id)
);

CREATE INDEX IF NOT EXISTS agency_members_user_status_idx
  ON agency_members(user_id, status);

CREATE TABLE IF NOT EXISTS agency_invitations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agency_onboarding', 'agency_member')),
  agency_id TEXT REFERENCES agencies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  agency_name TEXT,
  role TEXT NOT NULL DEFAULT 'agency_owner' CHECK (role IN ('agency_owner', 'agency_admin', 'agency_billing', 'agency_staff')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  accepted_by_user_id TEXT REFERENCES users(id),
  accepted_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agency_invitations_email_status_idx
  ON agency_invitations(email, status);

CREATE TABLE IF NOT EXISTS agency_client_links (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  billing_payer TEXT NOT NULL DEFAULT 'agency' CHECK (billing_payer = 'agency'),
  provisioned_by_user_id TEXT NOT NULL REFERENCES users(id),
  is_unpaid_trial INTEGER NOT NULL DEFAULT 1 CHECK (is_unpaid_trial IN (0, 1)),
  first_settled_at INTEGER,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agency_client_links_agency_idx
  ON agency_client_links(agency_id, is_unpaid_trial);

CREATE UNIQUE INDEX IF NOT EXISTS agency_client_links_agency_idem_uidx
  ON agency_client_links(agency_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS agency_client_links_enforce_trial_cap
BEFORE INSERT ON agency_client_links
WHEN (
  NEW.is_unpaid_trial = 1
  AND (
    SELECT COUNT(*)
    FROM agency_client_links acl
    INNER JOIN tenants t ON t.id = acl.tenant_id
    WHERE acl.agency_id = NEW.agency_id
      AND t.status != 'purged'
      AND acl.first_settled_at IS NOT NULL
  ) = 0
  AND (
    SELECT COUNT(*)
    FROM settlements s
    INNER JOIN tenants t ON t.id = s.tenant_id
    WHERE t.agency_id = NEW.agency_id
      AND t.status != 'purged'
  ) = 0
  AND (
    SELECT COUNT(*)
    FROM agency_client_links acl
    INNER JOIN tenants t ON t.id = acl.tenant_id
    WHERE acl.agency_id = NEW.agency_id
      AND t.status != 'purged'
      AND acl.is_unpaid_trial = 1
      AND acl.first_settled_at IS NULL
  ) >= COALESCE((SELECT unpaid_trial_cap FROM agencies WHERE id = NEW.agency_id), 3)
)
BEGIN
  SELECT RAISE(ABORT, 'AGENCY_TRIAL_LIMIT_REACHED');
END;

CREATE TRIGGER IF NOT EXISTS agency_client_links_enforce_trial_cap_update
BEFORE UPDATE ON agency_client_links
WHEN (
  OLD.is_unpaid_trial = 0
  AND NEW.is_unpaid_trial = 1
  AND (
    SELECT COUNT(*)
    FROM agency_client_links acl
    INNER JOIN tenants t ON t.id = acl.tenant_id
    WHERE acl.agency_id = NEW.agency_id
      AND t.status != 'purged'
      AND acl.first_settled_at IS NOT NULL
  ) = 0
  AND (
    SELECT COUNT(*)
    FROM settlements s
    INNER JOIN tenants t ON t.id = s.tenant_id
    WHERE t.agency_id = NEW.agency_id
      AND t.status != 'purged'
  ) = 0
  AND (
    SELECT COUNT(*)
    FROM agency_client_links acl
    INNER JOIN tenants t ON t.id = acl.tenant_id
    WHERE acl.agency_id = NEW.agency_id
      AND acl.tenant_id != NEW.tenant_id
      AND t.status != 'purged'
      AND acl.is_unpaid_trial = 1
      AND acl.first_settled_at IS NULL
  ) >= COALESCE((SELECT unpaid_trial_cap FROM agencies WHERE id = NEW.agency_id), 3)
)
BEGIN
  SELECT RAISE(ABORT, 'AGENCY_TRIAL_LIMIT_REACHED');
END;
