-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0016_custom_theme_service
-- Superadmin-managed service packages & tenant-scoped custom theme requests
-- (REQ-063, REQ-070, PLAN §5.1, §11.4, §13, TASK-061).

CREATE TABLE IF NOT EXISTS custom_theme_packages (
  id TEXT PRIMARY KEY,
  service_kind TEXT NOT NULL DEFAULT 'custom_theme' CHECK (
    service_kind IN ('custom_theme', 'setup', 'custom_plugin')
  ),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  inclusions_json TEXT NOT NULL DEFAULT '[]',
  starting_price_idr INTEGER CHECK (
    starting_price_idr IS NULL
    OR (starting_price_idr > 0 AND starting_price_idr <= 999999999999)
  ),
  estimated_duration TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 10000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS custom_theme_packages_kind_active_sort_idx
  ON custom_theme_packages(service_kind, active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS custom_theme_requests (
  id TEXT PRIMARY KEY,
  request_code TEXT NOT NULL UNIQUE,
  service_kind TEXT NOT NULL DEFAULT 'custom_theme' CHECK (
    service_kind IN ('custom_theme', 'setup', 'custom_plugin')
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tenant_handle TEXT NOT NULL,
  package_id TEXT REFERENCES custom_theme_packages(id),
  package_name_snapshot TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  day_bucket TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'contacted', 'quoted', 'in_progress', 'delivered', 'declined', 'cancelled')
  ),
  brand_name TEXT NOT NULL,
  brief TEXT NOT NULL,
  reference_urls_json TEXT NOT NULL DEFAULT '[]',
  budget_range TEXT,
  contact_preference TEXT NOT NULL DEFAULT 'whatsapp' CHECK (
    contact_preference IN ('whatsapp', 'email', 'both')
  ),
  delivered_theme_id TEXT REFERENCES theme_catalog(id),
  delivered_theme_grant_id TEXT REFERENCES tenant_theme_entitlements(id),
  status_reason TEXT,
  operator_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_theme_requests_tenant_idem_uidx
  ON custom_theme_requests(tenant_id, service_kind, idempotency_key);

CREATE INDEX IF NOT EXISTS custom_theme_requests_tenant_day_idx
  ON custom_theme_requests(tenant_id, service_kind, day_bucket, created_at);

CREATE INDEX IF NOT EXISTS custom_theme_requests_status_created_idx
  ON custom_theme_requests(service_kind, status, created_at DESC);
