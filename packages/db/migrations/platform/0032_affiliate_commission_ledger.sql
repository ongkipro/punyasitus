-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0032_affiliate_commission_ledger
-- Additive Affiliate Commission Ledger (60%/20% integer IDR, 14-day hold, pre/post-payout
-- refund reversals & negative offsets) and Bi-Monthly Asia/Jakarta Payout Batches
-- (REQ-085, REQ-086, DEC-038, DEC-045, PLAN §19.4, TASK-085).

CREATE TABLE IF NOT EXISTS affiliate_commission_payout_batches (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  payout_period_key TEXT NOT NULL,
  total_amount_idr INTEGER NOT NULL CHECK (total_amount_idr > 0 AND total_amount_idr <= 999999999999),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 1),
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (
    status IN ('pending_review', 'paid', 'canceled')
  ),
  transfer_reference TEXT,
  paid_at INTEGER,
  paid_by_user_id TEXT REFERENCES users(id),
  canceled_at INTEGER,
  canceled_by_user_id TEXT REFERENCES users(id),
  status_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (affiliate_id, payout_period_key)
);

CREATE INDEX IF NOT EXISTS affiliate_commission_payout_batches_period_idx
  ON affiliate_commission_payout_batches(payout_period_key, status);

CREATE INDEX IF NOT EXISTS affiliate_commission_payout_batches_status_idx
  ON affiliate_commission_payout_batches(status, created_at);

CREATE TABLE IF NOT EXISTS affiliate_commission_entries (
  id TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  settlement_id TEXT REFERENCES settlements(id),
  payment_attempt_id TEXT REFERENCES payment_attempts(id),
  obligation_id TEXT REFERENCES billing_obligations(id),
  receipt_id TEXT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('first_payment', 'renewal', 'reversal_offset')),
  gross_amount_idr INTEGER NOT NULL CHECK (gross_amount_idr >= 0 AND gross_amount_idr <= 999999999999),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999),
  ppn_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (ppn_amount_idr >= 0 AND ppn_amount_idr <= 999999999999),
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999),
  net_base_idr INTEGER NOT NULL CHECK (net_base_idr >= 0 AND net_base_idr <= 999999999999),
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  commission_idr INTEGER NOT NULL CHECK (commission_idr >= -999999999999 AND commission_idr <= 999999999999),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'batched', 'paid', 'reversed')),
  confirmed_at INTEGER NOT NULL,
  hold_until_at INTEGER NOT NULL,
  approved_at INTEGER,
  reversed_at INTEGER,
  reversal_reason TEXT,
  refund_reference TEXT,
  payout_batch_id TEXT REFERENCES affiliate_commission_payout_batches(id),
  source_commission_id TEXT REFERENCES affiliate_commission_entries(id),
  settings_snapshot_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (entry_kind IN ('first_payment', 'renewal') AND commission_idr > 0 AND source_commission_id IS NULL)
    OR
    (entry_kind = 'reversal_offset' AND commission_idr < 0 AND source_commission_id IS NOT NULL)
  ),
  CHECK (
    (status IN ('batched', 'paid') AND payout_batch_id IS NOT NULL)
    OR
    (status IN ('pending', 'approved', 'reversed') AND payout_batch_id IS NULL)
  )
);

-- Strictly at most ONE commission entry per confirmed payment attempt
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commission_entries_payment_attempt_uidx
  ON affiliate_commission_entries(payment_attempt_id)
  WHERE payment_attempt_id IS NOT NULL AND entry_kind IN ('first_payment', 'renewal');

-- Strictly at most ONE commission entry per confirmed settlement
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commission_entries_settlement_uidx
  ON affiliate_commission_entries(settlement_id)
  WHERE settlement_id IS NOT NULL AND entry_kind IN ('first_payment', 'renewal');

-- Strictly at most ONE commission entry per (receipt_id, entry_kind)
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commission_entries_receipt_kind_uidx
  ON affiliate_commission_entries(receipt_id, entry_kind)
  WHERE receipt_id IS NOT NULL;

-- Strictly at most ONE active/non-reversed 60% first_payment commission per tenant
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commission_entries_one_first_payment_per_tenant_uidx
  ON affiliate_commission_entries(tenant_id)
  WHERE entry_kind = 'first_payment' AND status != 'reversed';

-- Strictly at most ONE post-payout reversal_offset per original commission entry
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commission_entries_source_commission_uidx
  ON affiliate_commission_entries(source_commission_id)
  WHERE source_commission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS affiliate_commission_entries_affiliate_status_idx
  ON affiliate_commission_entries(affiliate_id, status, hold_until_at);

CREATE INDEX IF NOT EXISTS affiliate_commission_entries_tenant_idx
  ON affiliate_commission_entries(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS affiliate_commission_entries_pending_hold_idx
  ON affiliate_commission_entries(status, hold_until_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS affiliate_commission_entries_batch_idx
  ON affiliate_commission_entries(payout_batch_id)
  WHERE payout_batch_id IS NOT NULL;

-- Paid commission entries are strictly immutable; post-payout refunds must record a negative reversal_offset
CREATE TRIGGER IF NOT EXISTS affiliate_commission_entries_paid_immutable
BEFORE UPDATE ON affiliate_commission_entries
WHEN OLD.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'PAID_COMMISSION_ENTRY_IMMUTABLE');
END;

-- Batched and paid commission entries can never be deleted from the financial ledger
CREATE TRIGGER IF NOT EXISTS affiliate_commission_entries_paid_no_delete
BEFORE DELETE ON affiliate_commission_entries
WHEN OLD.status IN ('paid', 'batched')
BEGIN
  SELECT RAISE(ABORT, 'AFFILIATE_COMMISSION_DELETE_FORBIDDEN');
END;
