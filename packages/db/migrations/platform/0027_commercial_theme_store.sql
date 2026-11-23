-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0027_commercial_theme_store
-- Commercial Theme Store orders, gap-free numbered theme receipts (INV-THM-YYYY-NNNNNN),
-- immutability guards, and curated paid_once catalog seeding (REQ-096, ADR-0010, PLAN §11.4 & §19.7, TASK-096).

CREATE TABLE IF NOT EXISTS theme_store_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  theme_id TEXT NOT NULL REFERENCES theme_catalog(id),
  payer_user_id TEXT NOT NULL,
  agency_id TEXT REFERENCES agencies(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'expired', 'failed', 'review')
  ),
  currency TEXT NOT NULL DEFAULT 'IDR',
  base_price_idr INTEGER NOT NULL CHECK (base_price_idr > 0 AND base_price_idr <= 999999999999),
  coupon_id TEXT,
  coupon_code TEXT,
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
  ),
  net_base_amount_idr INTEGER NOT NULL CHECK (
    net_base_amount_idr >= 0 AND net_base_amount_idr <= 999999999999
  ),
  channel_code TEXT NOT NULL DEFAULT 'QRIS',
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999
  ),
  total_payable_idr INTEGER NOT NULL CHECK (
    total_payable_idr > 0 AND total_payable_idr <= 999999999999
  ),
  provider_account_id TEXT NOT NULL DEFAULT 'default',
  provider_reff_id TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  payment_instructions_json TEXT,
  settled_at INTEGER,
  entitlement_id TEXT REFERENCES tenant_theme_entitlements(id),
  receipt_id TEXT,
  safe_failure_code TEXT,
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (base_price_idr - discount_amount_idr = net_base_amount_idr),
  CHECK (net_base_amount_idr + channel_fee_idr = total_payable_idr)
);

CREATE UNIQUE INDEX IF NOT EXISTS theme_store_orders_tenant_idem_uidx
  ON theme_store_orders(tenant_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS theme_store_orders_open_tenant_theme_uidx
  ON theme_store_orders(tenant_id, theme_id)
  WHERE status IN ('pending', 'review');

CREATE UNIQUE INDEX IF NOT EXISTS theme_store_orders_tenant_theme_paid_uidx
  ON theme_store_orders(tenant_id, theme_id)
  WHERE status = 'paid';

CREATE INDEX IF NOT EXISTS theme_store_orders_tenant_created_idx
  ON theme_store_orders(tenant_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS theme_store_orders_immutable_financial_update
BEFORE UPDATE ON theme_store_orders
WHEN (
  NEW.id IS NOT OLD.id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.theme_id IS NOT OLD.theme_id
  OR NEW.payer_user_id IS NOT OLD.payer_user_id
  OR NEW.agency_id IS NOT OLD.agency_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.currency IS NOT OLD.currency
  OR NEW.base_price_idr IS NOT OLD.base_price_idr
  OR NEW.coupon_id IS NOT OLD.coupon_id
  OR NEW.coupon_code IS NOT OLD.coupon_code
  OR NEW.discount_amount_idr IS NOT OLD.discount_amount_idr
  OR NEW.net_base_amount_idr IS NOT OLD.net_base_amount_idr
  OR NEW.channel_code IS NOT OLD.channel_code
  OR NEW.channel_fee_idr IS NOT OLD.channel_fee_idr
  OR NEW.total_payable_idr IS NOT OLD.total_payable_idr
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.provider_reff_id IS NOT OLD.provider_reff_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (
    OLD.status = 'paid'
    AND (
      NEW.status IS NOT 'paid'
      OR NEW.settled_at IS NOT OLD.settled_at
      OR NEW.entitlement_id IS NOT OLD.entitlement_id
      OR NEW.receipt_id IS NOT OLD.receipt_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'theme_store_orders financial columns and paid status are immutable');
END;

CREATE TRIGGER IF NOT EXISTS theme_store_orders_no_delete
BEFORE DELETE ON theme_store_orders
BEGIN
  SELECT RAISE(ABORT, 'theme_store_orders cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS theme_store_receipt_counters (
  year INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_store_receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tenant_name_snapshot TEXT NOT NULL,
  payer_name_snapshot TEXT NOT NULL,
  theme_id TEXT NOT NULL REFERENCES theme_catalog(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES theme_store_orders(id),
  entitlement_id TEXT NOT NULL REFERENCES tenant_theme_entitlements(id),
  payer_user_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'IDR',
  base_amount_idr INTEGER NOT NULL CHECK (base_amount_idr >= 0 AND base_amount_idr <= 999999999999),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
  ),
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (
    channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999
  ),
  total_amount_idr INTEGER NOT NULL CHECK (total_amount_idr >= 0 AND total_amount_idr <= 999999999999),
  coupon_code TEXT,
  payment_channel TEXT NOT NULL,
  provider_reference TEXT,
  r2_object_key TEXT NOT NULL UNIQUE,
  pdf_sha256 TEXT NOT NULL,
  pdf_byte_length INTEGER NOT NULL CHECK (pdf_byte_length > 0),
  non_pkp_notice TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (base_amount_idr - discount_amount_idr + channel_fee_idr = total_amount_idr)
);

CREATE INDEX IF NOT EXISTS theme_store_receipts_tenant_issued_idx
  ON theme_store_receipts(tenant_id, issued_at DESC);

CREATE TRIGGER IF NOT EXISTS theme_store_receipts_immutable_update
BEFORE UPDATE ON theme_store_receipts
BEGIN
  SELECT RAISE(ABORT, 'theme_store_receipts is immutable');
END;

CREATE TRIGGER IF NOT EXISTS theme_store_receipts_no_delete
BEFORE DELETE ON theme_store_receipts
BEGIN
  SELECT RAISE(ABORT, 'theme_store_receipts is immutable and cannot be deleted');
END;

INSERT OR IGNORE INTO theme_catalog (id, slug, name, tier, price_idr, active, version, created_at, updated_at)
VALUES
  ('compro', 'compro', 'Corporate / B2B Compro', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('sales', 'sales', 'Sales Compro & Personal Branding', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('travel', 'travel', 'Travel & Umrah Agency', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('catalog', 'catalog', 'Product Showcase Catalog', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('resto', 'resto', 'F&B & Multi-Branch Outlets', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('dealer', 'dealer', 'Automotive & Vehicle Showroom', 'included', 0, 1, 1, 1763942400000, 1763942400000),
  ('premium-atelier-editorial', 'atelier-editorial', 'Atelier Editorial Pro', 'paid_once', 499000, 1, 1, 1763942400000, 1763942400000),
  ('premium-nusantara-flagship', 'nusantara-flagship', 'Nusantara Flagship Commerce', 'paid_once', 699000, 1, 1, 1763942400000, 1763942400000);
