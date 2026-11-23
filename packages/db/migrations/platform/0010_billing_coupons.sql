-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0010_billing_coupons
-- Promotional coupon catalog & atomic per-tenant redemption tracking
-- (REQ-082, PLAN §16.1, §17.1, §19.3, TASK-082).

CREATE TABLE IF NOT EXISTS promo_coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  discount_kind TEXT NOT NULL CHECK (discount_kind IN ('percent', 'fixed_idr')),
  discount_value INTEGER NOT NULL CHECK (
    discount_value > 0
    AND (
      (discount_kind = 'percent' AND discount_value <= 100)
      OR (discount_kind = 'fixed_idr' AND discount_value <= 999999999999)
    )
  ),
  eligible_plans_json TEXT NOT NULL DEFAULT '["monthly","yearly"]',
  eligible_payer_types_json TEXT NOT NULL DEFAULT '["tenant","agency"]',
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (
    redeemed_count >= 0
    AND (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
  ),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes TEXT,
  created_by_user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS promo_coupons_active_window_idx
  ON promo_coupons(active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES promo_coupons(id),
  tenant_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL UNIQUE,
  discount_amount_idr INTEGER NOT NULL CHECK (
    discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
  ),
  net_base_amount_idr INTEGER NOT NULL CHECK (
    net_base_amount_idr >= 0 AND net_base_amount_idr <= 999999999999
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Strict 1-per-tenant rule for active ('reserved' / 'consumed') redemptions;
-- releasing an expired/canceled reservation frees the tenant to re-redeem while keeping history.
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_one_active_per_tenant_uidx
  ON coupon_redemptions(coupon_id, tenant_id)
  WHERE status IN ('reserved', 'consumed');

CREATE INDEX IF NOT EXISTS coupon_redemptions_tenant_id_idx
  ON coupon_redemptions(tenant_id);

CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_status_idx
  ON coupon_redemptions(coupon_id, status);
