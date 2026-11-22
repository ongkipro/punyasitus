-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0004_billing_obligations
-- Additive subscription obligation snapshot & durable AutoLaris payment attempt constraints
-- (REQ-056, PLAN §16.2, §16.3, TASK-055).

ALTER TABLE billing_obligations ADD COLUMN currency TEXT NOT NULL DEFAULT 'IDR';
ALTER TABLE billing_obligations ADD COLUMN period_start_at INTEGER;
ALTER TABLE billing_obligations ADD COLUMN period_end_at INTEGER;
ALTER TABLE billing_obligations ADD COLUMN snapshot_json TEXT;
ALTER TABLE billing_obligations ADD COLUMN idempotency_key TEXT;
ALTER TABLE billing_obligations ADD COLUMN request_hash TEXT;
ALTER TABLE billing_obligations ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1));

ALTER TABLE payment_attempts ADD COLUMN provider_account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE payment_attempts ADD COLUMN reff_id TEXT;
ALTER TABLE payment_attempts ADD COLUMN channel_code TEXT;
ALTER TABLE payment_attempts ADD COLUMN idempotency_key TEXT;
ALTER TABLE payment_attempts ADD COLUMN request_hash TEXT;
ALTER TABLE payment_attempts ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'creating' CHECK (
  lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'expired', 'failed', 'paid', 'review')
);
ALTER TABLE payment_attempts ADD COLUMN base_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
  base_amount_idr >= 0 AND base_amount_idr <= 999999999999
);
ALTER TABLE payment_attempts ADD COLUMN discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (
  discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999
);
ALTER TABLE payment_attempts ADD COLUMN channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (
  channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999
);
ALTER TABLE payment_attempts ADD COLUMN total_payable_idr INTEGER NOT NULL DEFAULT 0 CHECK (
  total_payable_idr >= 0 AND total_payable_idr <= 999999999999
);
ALTER TABLE payment_attempts ADD COLUMN bank_name TEXT;
ALTER TABLE payment_attempts ADD COLUMN safe_failure_code TEXT;
ALTER TABLE payment_attempts ADD COLUMN provider_submitted_at INTEGER;

-- At most one open subscription obligation per tenant at a time.
CREATE UNIQUE INDEX IF NOT EXISTS billing_obligations_one_open_sub_per_tenant_uidx
  ON billing_obligations(tenant_id)
  WHERE status = 'open' AND plan_interval IN ('monthly', 'yearly');

-- At most one unresolved payment attempt per obligation (serializes creation & prevents duplicate charges).
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_unresolved_per_obligation_uidx
  ON payment_attempts(obligation_id)
  WHERE lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review');

-- Account-scoped unique partner reference (`reff_id`).
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_account_reff_uidx
  ON payment_attempts(provider_account_id, reff_id)
  WHERE reff_id IS NOT NULL;

-- Account-scoped unique provider transaction ID.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_account_provider_trx_uidx
  ON payment_attempts(provider_account_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

-- Tenant-scoped unique client idempotency key for payment attempts.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_tenant_idempotency_uidx
  ON payment_attempts(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
