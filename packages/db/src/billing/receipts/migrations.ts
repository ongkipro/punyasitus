import {
  applyPlatformMigrations,
  type ApplyMigrationsResult,
  type MigrationDescriptor,
} from "../../connections/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/platform/0009_billing_receipts.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and integration tests can apply it
 * without filesystem access.
 */
export const BILLING_RECEIPTS_MIGRATION_SQL = `-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0009_billing_receipts
-- Additive gap-free yearly receipt numbering, immutable payment receipts & linked credit notes
-- (REQ-081, PLAN §16.1, §19.3, TASK-081).

CREATE TABLE IF NOT EXISTS receipt_yearly_counters (
  year INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('receipt', 'credit_note')),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agency_id TEXT REFERENCES agencies(id),
  obligation_id TEXT NOT NULL REFERENCES billing_obligations(id),
  settlement_id TEXT UNIQUE REFERENCES settlements(id),
  refund_id TEXT UNIQUE,
  linked_receipt_id TEXT REFERENCES payment_receipts(id),
  payer_user_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'IDR',
  base_amount_idr INTEGER NOT NULL CHECK (base_amount_idr >= 0 AND base_amount_idr <= 999999999999),
  discount_amount_idr INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_idr >= 0 AND discount_amount_idr <= 999999999999),
  channel_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (channel_fee_idr >= 0 AND channel_fee_idr <= 999999999999),
  total_amount_idr INTEGER NOT NULL CHECK (total_amount_idr >= 0 AND total_amount_idr <= 999999999999),
  plan_code TEXT NOT NULL,
  period_start_ms INTEGER,
  period_end_ms INTEGER,
  payment_channel TEXT NOT NULL,
  provider_reference TEXT,
  r2_object_key TEXT NOT NULL UNIQUE,
  pdf_sha256 TEXT NOT NULL,
  pdf_byte_length INTEGER NOT NULL CHECK (pdf_byte_length > 0),
  non_pkp_notice TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  emailed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (document_kind = 'receipt' AND settlement_id IS NOT NULL AND refund_id IS NULL)
    OR
    (document_kind = 'credit_note' AND refund_id IS NOT NULL AND settlement_id IS NULL)
  ),
  CHECK (
    base_amount_idr >= 0
    AND discount_amount_idr >= 0
    AND channel_fee_idr >= 0
    AND total_amount_idr >= 0
    AND (base_amount_idr - discount_amount_idr + channel_fee_idr = total_amount_idr)
  )
);

CREATE INDEX IF NOT EXISTS payment_receipts_tenant_issued_idx
  ON payment_receipts(tenant_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS payment_receipts_agency_issued_idx
  ON payment_receipts(agency_id, issued_at DESC)
  WHERE agency_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_receipts_obligation_idx
  ON payment_receipts(obligation_id);

CREATE INDEX IF NOT EXISTS payment_receipts_linked_idx
  ON payment_receipts(linked_receipt_id)
  WHERE linked_receipt_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS payment_receipts_immutable_update
BEFORE UPDATE ON payment_receipts
WHEN (
  NEW.id IS NOT OLD.id
  OR NEW.receipt_number IS NOT OLD.receipt_number
  OR NEW.document_kind IS NOT OLD.document_kind
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.agency_id IS NOT OLD.agency_id
  OR NEW.obligation_id IS NOT OLD.obligation_id
  OR NEW.settlement_id IS NOT OLD.settlement_id
  OR NEW.refund_id IS NOT OLD.refund_id
  OR NEW.linked_receipt_id IS NOT OLD.linked_receipt_id
  OR NEW.payer_user_id IS NOT OLD.payer_user_id
  OR NEW.currency IS NOT OLD.currency
  OR NEW.base_amount_idr IS NOT OLD.base_amount_idr
  OR NEW.discount_amount_idr IS NOT OLD.discount_amount_idr
  OR NEW.channel_fee_idr IS NOT OLD.channel_fee_idr
  OR NEW.total_amount_idr IS NOT OLD.total_amount_idr
  OR NEW.plan_code IS NOT OLD.plan_code
  OR NEW.period_start_ms IS NOT OLD.period_start_ms
  OR NEW.period_end_ms IS NOT OLD.period_end_ms
  OR NEW.payment_channel IS NOT OLD.payment_channel
  OR NEW.provider_reference IS NOT OLD.provider_reference
  OR NEW.r2_object_key IS NOT OLD.r2_object_key
  OR NEW.pdf_sha256 IS NOT OLD.pdf_sha256
  OR NEW.pdf_byte_length IS NOT OLD.pdf_byte_length
  OR NEW.non_pkp_notice IS NOT OLD.non_pkp_notice
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.emailed_at IS NOT NULL
  OR NEW.emailed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'payment_receipts is immutable; only emailed_at may transition once from NULL to timestamp');
END;

CREATE TRIGGER IF NOT EXISTS payment_receipts_no_delete
BEFORE DELETE ON payment_receipts
BEGIN
  SELECT RAISE(ABORT, 'payment_receipts is immutable and cannot be deleted');
END;
`;

export const BILLING_RECEIPTS_MIGRATION: MigrationDescriptor = {
  version: 9,
  name: "0009_billing_receipts",
  sql: BILLING_RECEIPTS_MIGRATION_SQL,
} as const;

export async function applyBillingReceiptsMigration(
  db: D1Database,
  now: () => number = Date.now,
): Promise<ApplyMigrationsResult> {
  return applyPlatformMigrations(db, [BILLING_RECEIPTS_MIGRATION], now);
}

/**
 * Idempotent bootstrap helper for `0009_billing_receipts`.
 * Safe to call repeatedly in handlers, workers, and tests.
 */
export async function ensureBillingReceiptsSchema(
  db: D1Database,
  now: () => number = Date.now,
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('receipt_yearly_counters', 'payment_receipts')`,
    )
    .all<{ readonly name: string }>();

  if ((existing.results?.length ?? 0) === 2) {
    return;
  }

  await applyBillingReceiptsMigration(db, now);
}
