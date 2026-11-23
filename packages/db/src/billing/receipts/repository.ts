import {
  BILLING_CURRENCY,
  BillingConflictError,
  BillingNotFoundError,
  BillingValidationError,
  assertExactIdrInteger,
  generateBillingUlid,
} from "@punyasitus/core/billing/index";
import {
  RECEIPT_NON_PKP_NOTICE,
  buildReceiptR2ObjectKey,
  formatReceiptNumber,
  getWibYearFromEpochMs,
  type GeneratedReceiptPdf,
  type ReceiptDocumentKind,
} from "@punyasitus/core/billing/receipt-pdf";

/**
 * Atomic gap-free yearly receipt numbering & immutable `payment_receipts` repository
 * for Cloudflare D1 `PLATFORM_DB` (REQ-081, PLAN §16.1, §19.3; TASK-081).
 *
 * Concurrency & immutability guarantees:
 * 1. Every allocation increments `receipt_yearly_counters` and inserts `payment_receipts`
 *    atomically inside ONE single `db.batch([...])` guarded by optimistic CAS on `last_seq`
 *    and `NOT EXISTS` idempotency check on `settlement_id` / `refund_id`.
 * 2. Concurrent `Promise.all` settlements NEVER collide and NEVER leave sequence gaps.
 * 3. Re-issuing for the same `settlement_id` or `refund_id` is 100% idempotent and NEVER
 *    increments `receipt_yearly_counters`.
 * 4. SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers enforce strict immutability of all
 *    issued rows (only `emailed_at` may transition once from `NULL` to a timestamp).
 * 5. Zero runtime DDL: migrations are applied out-of-band (`0009_billing_receipts.sql`).
 */

export function assertReceiptAccountingSum(amounts: {
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
}): void {
  const base = assertExactIdrInteger(amounts.baseAmountIdr, "baseAmountIdr");
  const discount = assertExactIdrInteger(amounts.discountAmountIdr, "discountAmountIdr");
  const fee = assertExactIdrInteger(amounts.channelFeeIdr, "channelFeeIdr");
  const total = assertExactIdrInteger(amounts.totalAmountIdr, "totalAmountIdr");
  if (discount > base) {
    throw new BillingValidationError(
      "RECEIPT_DISCOUNT_EXCEEDS_BASE",
      `Diskon (${discount} IDR) tidak boleh melebihi harga dasar (${base} IDR).`,
    );
  }
  const expectedTotal = base - discount + fee;
  if (expectedTotal !== total) {
    throw new BillingValidationError(
      "RECEIPT_AMOUNT_MISMATCH",
      `Total kuitansi tidak cocok: ${base} - ${discount} + ${fee} = ${expectedTotal}, diterima ${total} IDR.`,
    );
  }
}

export interface PaymentReceiptRecord {
  readonly id: string;
  readonly receiptNumber: string;
  readonly documentKind: ReceiptDocumentKind;
  readonly tenantId: string;
  readonly agencyId: string | null;
  readonly obligationId: string;
  readonly settlementId: string | null;
  readonly refundId: string | null;
  readonly linkedReceiptId: string | null;
  readonly payerUserId: string;
  readonly currency: typeof BILLING_CURRENCY;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly planCode: string;
  readonly periodStartMs: number | null;
  readonly periodEndMs: number | null;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly r2ObjectKey: string;
  readonly pdfSha256: string;
  readonly pdfByteLength: number;
  readonly nonPkpNotice: string;
  readonly issuedAtMs: number;
  readonly issuedAtIso: string;
  readonly emailedAtMs: number | null;
  readonly emailedAtIso: string | null;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
}

interface PaymentReceiptSqlRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly document_kind: ReceiptDocumentKind;
  readonly tenant_id: string;
  readonly agency_id: string | null;
  readonly obligation_id: string;
  readonly settlement_id: string | null;
  readonly refund_id: string | null;
  readonly linked_receipt_id: string | null;
  readonly payer_user_id: string;
  readonly currency: string;
  readonly base_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly channel_fee_idr: number;
  readonly total_amount_idr: number;
  readonly plan_code: string;
  readonly period_start_ms: number | null;
  readonly period_end_ms: number | null;
  readonly payment_channel: string;
  readonly provider_reference: string | null;
  readonly r2_object_key: string;
  readonly pdf_sha256: string;
  readonly pdf_byte_length: number;
  readonly non_pkp_notice: string;
  readonly issued_at: number;
  readonly emailed_at: number | null;
  readonly created_at: number;
}

const RECEIPT_SELECT_COLUMNS = `
  id,
  receipt_number,
  document_kind,
  tenant_id,
  agency_id,
  obligation_id,
  settlement_id,
  refund_id,
  linked_receipt_id,
  payer_user_id,
  currency,
  base_amount_idr,
  discount_amount_idr,
  channel_fee_idr,
  total_amount_idr,
  plan_code,
  period_start_ms,
  period_end_ms,
  payment_channel,
  provider_reference,
  r2_object_key,
  pdf_sha256,
  pdf_byte_length,
  non_pkp_notice,
  issued_at,
  emailed_at,
  created_at
`.trim();

function mapReceiptRow(row: PaymentReceiptSqlRow): PaymentReceiptRecord {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    documentKind: row.document_kind,
    tenantId: row.tenant_id,
    agencyId: row.agency_id,
    obligationId: row.obligation_id,
    settlementId: row.settlement_id,
    refundId: row.refund_id,
    linkedReceiptId: row.linked_receipt_id,
    payerUserId: row.payer_user_id,
    currency: BILLING_CURRENCY,
    baseAmountIdr: row.base_amount_idr,
    discountAmountIdr: row.discount_amount_idr,
    channelFeeIdr: row.channel_fee_idr,
    totalAmountIdr: row.total_amount_idr,
    planCode: row.plan_code,
    periodStartMs: row.period_start_ms,
    periodEndMs: row.period_end_ms,
    paymentChannel: row.payment_channel,
    providerReference: row.provider_reference,
    r2ObjectKey: row.r2_object_key,
    pdfSha256: row.pdf_sha256,
    pdfByteLength: row.pdf_byte_length,
    nonPkpNotice: row.non_pkp_notice,
    issuedAtMs: row.issued_at,
    issuedAtIso: new Date(row.issued_at).toISOString(),
    emailedAtMs: row.emailed_at,
    emailedAtIso: row.emailed_at !== null ? new Date(row.emailed_at).toISOString() : null,
    createdAtMs: row.created_at,
    createdAtIso: new Date(row.created_at).toISOString(),
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

export async function findPaymentReceiptById(
  db: D1Database,
  receiptId: string,
): Promise<PaymentReceiptRecord | null> {
  const trimmed = receiptId.trim();
  if (!trimmed) return null;
  const row = await db
    .prepare(`SELECT ${RECEIPT_SELECT_COLUMNS} FROM payment_receipts WHERE id = ? LIMIT 1`)
    .bind(trimmed)
    .first<PaymentReceiptSqlRow>();
  return row ? mapReceiptRow(row) : null;
}

export async function findPaymentReceiptBySettlementId(
  db: D1Database,
  settlementId: string,
): Promise<PaymentReceiptRecord | null> {
  const trimmed = settlementId.trim();
  if (!trimmed) return null;
  const row = await db
    .prepare(
      `SELECT ${RECEIPT_SELECT_COLUMNS} FROM payment_receipts WHERE settlement_id = ? LIMIT 1`,
    )
    .bind(trimmed)
    .first<PaymentReceiptSqlRow>();
  return row ? mapReceiptRow(row) : null;
}

export async function findPaymentReceiptByRefundId(
  db: D1Database,
  refundId: string,
): Promise<PaymentReceiptRecord | null> {
  const trimmed = refundId.trim();
  if (!trimmed) return null;
  const row = await db
    .prepare(`SELECT ${RECEIPT_SELECT_COLUMNS} FROM payment_receipts WHERE refund_id = ? LIMIT 1`)
    .bind(trimmed)
    .first<PaymentReceiptSqlRow>();
  return row ? mapReceiptRow(row) : null;
}

export async function listTenantPaymentReceipts(
  db: D1Database,
  tenantId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly PaymentReceiptRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const rows = await db
    .prepare(
      `SELECT ${RECEIPT_SELECT_COLUMNS}
       FROM payment_receipts
       WHERE tenant_id = ?
       ORDER BY issued_at DESC, receipt_number DESC
       LIMIT ?`,
    )
    .bind(tenantId.trim(), safeLimit)
    .all<PaymentReceiptSqlRow>();
  return (rows.results ?? []).map(mapReceiptRow);
}

export async function listAgencyPaymentReceipts(
  db: D1Database,
  agencyId: string,
  options: { readonly tenantId?: string; readonly limit?: number } = {},
): Promise<readonly PaymentReceiptRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const tenantFilter = options.tenantId?.trim();
  const rows = tenantFilter
    ? await db
        .prepare(
          `SELECT ${RECEIPT_SELECT_COLUMNS}
           FROM payment_receipts
           WHERE agency_id = ? AND tenant_id = ?
           ORDER BY issued_at DESC, receipt_number DESC
           LIMIT ?`,
        )
        .bind(agencyId.trim(), tenantFilter, safeLimit)
        .all<PaymentReceiptSqlRow>()
    : await db
        .prepare(
          `SELECT ${RECEIPT_SELECT_COLUMNS}
           FROM payment_receipts
           WHERE agency_id = ?
           ORDER BY issued_at DESC, receipt_number DESC
           LIMIT ?`,
        )
        .bind(agencyId.trim(), safeLimit)
        .all<PaymentReceiptSqlRow>();
  return (rows.results ?? []).map(mapReceiptRow);
}

export async function markPaymentReceiptEmailed(
  db: D1Database,
  receiptId: string,
  emailedAtMs: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE payment_receipts
       SET emailed_at = ?
       WHERE id = ? AND emailed_at IS NULL`,
    )
    .bind(Math.trunc(emailedAtMs), receiptId.trim())
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

export interface SettlementReceiptSourceContext {
  readonly settlementId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly agencyId: string | null;
  readonly payerKind: "tenant" | "agency";
  readonly payerUserId: string;
  readonly payerName: string;
  readonly payerEmail: string | null;
  readonly planCode: string;
  readonly periodStartMs: number | null;
  readonly periodEndMs: number | null;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode: string | null;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly settledAtMs: number;
}

export interface RefundCreditNoteSourceContext {
  readonly refundId: string;
  readonly obligationId: string;
  readonly settlementId: string | null;
  readonly linkedReceiptId: string | null;
  readonly linkedReceiptNumber: string | null;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly agencyId: string | null;
  readonly payerKind: "tenant" | "agency";
  readonly payerUserId: string;
  readonly payerName: string;
  readonly payerEmail: string | null;
  readonly planCode: string;
  readonly periodStartMs: number | null;
  readonly periodEndMs: number | null;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly refundKind: string;
  readonly reason: string;
  readonly refundedAtMs: number;
}

async function resolvePayerIdentity(
  db: D1Database,
  tenantOrgId: string,
  agencyId: string | null,
): Promise<{
  readonly payerKind: "tenant" | "agency";
  readonly payerUserId: string;
  readonly payerName: string;
  readonly payerEmail: string | null;
}> {
  if (agencyId) {
    const agencyRow = await db
      .prepare(
        `SELECT a.owner_user_id, a.name AS agency_name, u.email AS owner_email
         FROM agencies a
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.id = ?
         LIMIT 1`,
      )
      .bind(agencyId)
      .first<{
        readonly owner_user_id: string;
        readonly agency_name: string;
        readonly owner_email: string | null;
      }>();

    if (agencyRow) {
      return {
        payerKind: "agency",
        payerUserId: agencyRow.owner_user_id,
        payerName: agencyRow.agency_name,
        payerEmail: agencyRow.owner_email,
      };
    }

    const staffRow = await db
      .prepare(
        `SELECT m.user_id, u.name, u.email
         FROM members m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND m.role = 'agency_staff'
         ORDER BY m.created_at ASC
         LIMIT 1`,
      )
      .bind(tenantOrgId)
      .first<{
        readonly user_id: string;
        readonly name: string;
        readonly email: string;
      }>();

    if (staffRow) {
      return {
        payerKind: "agency",
        payerUserId: staffRow.user_id,
        payerName: staffRow.name,
        payerEmail: staffRow.email,
      };
    }
  }

  const ownerRow = await db
    .prepare(
      `SELECT m.user_id, u.name, u.email
       FROM members m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.role = 'owner'
       ORDER BY m.created_at ASC
       LIMIT 1`,
    )
    .bind(tenantOrgId)
    .first<{
      readonly user_id: string;
      readonly name: string;
      readonly email: string;
    }>();

  if (ownerRow) {
    return {
      payerKind: agencyId ? "agency" : "tenant",
      payerUserId: ownerRow.user_id,
      payerName: ownerRow.name,
      payerEmail: ownerRow.email,
    };
  }

  return {
    payerKind: agencyId ? "agency" : "tenant",
    payerUserId: "unknown",
    payerName: agencyId ? "Agensi Pengelola" : "Pemilik Situs",
    payerEmail: null,
  };
}

function extractCouponCodeFromSnapshot(couponSnapshotJson: string | null): string | null {
  if (!couponSnapshotJson) return null;
  try {
    const parsed = JSON.parse(couponSnapshotJson) as Record<string, unknown>;
    if (typeof parsed.code === "string" && parsed.code.trim().length > 0) {
      return parsed.code.trim();
    }
  } catch {
    // Ignore malformed snapshot JSON
  }
  return null;
}

/**
 * Loads complete authoritative data from `PLATFORM_DB` to issue a numbered receipt for a confirmed settlement.
 */
export async function loadSettlementReceiptSourceContext(
  db: D1Database,
  settlementId: string,
): Promise<SettlementReceiptSourceContext> {
  const row = await db
    .prepare(
      `SELECT
         s.id AS settlement_id,
         s.obligation_id,
         s.tenant_id,
         s.amount_idr AS settled_amount_idr,
         s.settled_at,
         bo.payer_type,
         bo.payer_agency_id,
         bo.plan_interval,
         bo.gross_amount_idr,
         bo.discount_amount_idr,
         bo.net_amount_idr,
         bo.period_start_at,
         bo.period_end_at,
         bo.coupon_snapshot_json,
         pa.channel,
         pa.channel_code,
         pa.provider_transaction_id,
         pa.reff_id,
         pa.base_amount_idr,
         pa.discount_amount_idr AS attempt_discount_amount_idr,
         pa.channel_fee_idr,
         pa.total_payable_idr,
         t.organization_id,
         t.agency_id AS tenant_agency_id,
         t.name AS tenant_name,
         t.handle AS tenant_handle,
         eg.period_start AS grant_period_start,
         eg.period_end AS grant_period_end
       FROM settlements s
       INNER JOIN billing_obligations bo ON bo.id = s.obligation_id AND bo.tenant_id = s.tenant_id
       INNER JOIN payment_attempts pa ON pa.id = s.payment_attempt_id AND pa.tenant_id = s.tenant_id
       INNER JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN entitlement_grants eg ON eg.settlement_id = s.id
       WHERE s.id = ?
       LIMIT 1`,
    )
    .bind(settlementId.trim())
    .first<{
      readonly settlement_id: string;
      readonly obligation_id: string;
      readonly tenant_id: string;
      readonly settled_amount_idr: number;
      readonly settled_at: number;
      readonly payer_type: "tenant" | "agency";
      readonly payer_agency_id: string | null;
      readonly plan_interval: string;
      readonly gross_amount_idr: number;
      readonly discount_amount_idr: number;
      readonly net_amount_idr: number;
      readonly period_start_at: number | null;
      readonly period_end_at: number | null;
      readonly coupon_snapshot_json: string | null;
      readonly channel: string;
      readonly channel_code: string | null;
      readonly provider_transaction_id: string | null;
      readonly reff_id: string | null;
      readonly base_amount_idr: number | null;
      readonly attempt_discount_amount_idr: number | null;
      readonly channel_fee_idr: number | null;
      readonly total_payable_idr: number | null;
      readonly organization_id: string;
      readonly tenant_agency_id: string | null;
      readonly tenant_name: string;
      readonly tenant_handle: string;
      readonly grant_period_start: number | null;
      readonly grant_period_end: number | null;
    }>();

  if (!row) {
    throw new BillingNotFoundError("Data pelunasan tidak ditemukan untuk penerbitan kuitansi.");
  }

  const agencyId = row.payer_agency_id ?? row.tenant_agency_id ?? null;
  const payer = await resolvePayerIdentity(db, row.organization_id, agencyId);

  const baseAmountIdr =
    row.base_amount_idr && row.base_amount_idr > 0 ? row.base_amount_idr : row.gross_amount_idr;
  const discountAmountIdr = row.attempt_discount_amount_idr ?? row.discount_amount_idr ?? 0;
  const channelFeeIdr = row.channel_fee_idr ?? 0;
  const totalAmountIdr =
    row.settled_amount_idr > 0
      ? row.settled_amount_idr
      : row.total_payable_idr && row.total_payable_idr > 0
        ? row.total_payable_idr
        : Math.max(0, baseAmountIdr - discountAmountIdr + channelFeeIdr);

  assertReceiptAccountingSum({
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalAmountIdr,
  });

  const paymentChannel =
    row.channel_code && row.channel_code !== row.channel
      ? `${row.channel} (${row.channel_code})`
      : row.channel;

  return {
    settlementId: row.settlement_id,
    obligationId: row.obligation_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantHandle: row.tenant_handle,
    agencyId,
    payerKind: agencyId ? "agency" : payer.payerKind,
    payerUserId: payer.payerUserId,
    payerName: payer.payerName,
    payerEmail: payer.payerEmail,
    planCode: row.plan_interval,
    periodStartMs: row.grant_period_start ?? row.period_start_at,
    periodEndMs: row.grant_period_end ?? row.period_end_at,
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalAmountIdr,
    couponCode: extractCouponCodeFromSnapshot(row.coupon_snapshot_json),
    paymentChannel,
    providerReference: row.provider_transaction_id ?? row.reff_id ?? null,
    settledAtMs: row.settled_at,
  };
}

/**
 * Loads authoritative data from `PLATFORM_DB` to issue a linked credit note for an audited refund record.
 */
export async function loadRefundCreditNoteSourceContext(
  db: D1Database,
  refundId: string,
): Promise<RefundCreditNoteSourceContext> {
  const row = await db
    .prepare(
      `SELECT
         r.id AS refund_id,
         r.obligation_id,
         r.settlement_id,
         r.tenant_id,
         r.refund_kind,
         r.amount_idr AS refund_amount_idr,
         r.external_reference,
         r.reason,
         r.created_at AS refunded_at,
         bo.payer_agency_id,
         bo.plan_interval,
         bo.period_start_at,
         bo.period_end_at,
         pa.channel,
         pa.channel_code,
         pa.provider_transaction_id,
         pa.reff_id,
         t.organization_id,
         t.agency_id AS tenant_agency_id,
         t.name AS tenant_name,
         t.handle AS tenant_handle
       FROM billing_refund_records r
       INNER JOIN billing_obligations bo ON bo.id = r.obligation_id AND bo.tenant_id = r.tenant_id
       INNER JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN payment_attempts pa ON pa.id = r.payment_attempt_id
       WHERE r.id = ?
       LIMIT 1`,
    )
    .bind(refundId.trim())
    .first<{
      readonly refund_id: string;
      readonly obligation_id: string;
      readonly settlement_id: string | null;
      readonly tenant_id: string;
      readonly refund_kind: string;
      readonly refund_amount_idr: number;
      readonly external_reference: string | null;
      readonly reason: string;
      readonly refunded_at: number;
      readonly payer_agency_id: string | null;
      readonly plan_interval: string;
      readonly period_start_at: number | null;
      readonly period_end_at: number | null;
      readonly channel: string | null;
      readonly channel_code: string | null;
      readonly provider_transaction_id: string | null;
      readonly reff_id: string | null;
      readonly organization_id: string;
      readonly tenant_agency_id: string | null;
      readonly tenant_name: string;
      readonly tenant_handle: string;
    }>();

  if (!row) {
    throw new BillingNotFoundError("Data pengembalian dana tidak ditemukan untuk penerbitan nota kredit.");
  }

  let linkedReceipt: PaymentReceiptRecord | null = null;
  if (row.settlement_id) {
    linkedReceipt = await findPaymentReceiptBySettlementId(db, row.settlement_id);
  }
  if (!linkedReceipt) {
    const byObligation = await db
      .prepare(
        `SELECT ${RECEIPT_SELECT_COLUMNS}
         FROM payment_receipts
         WHERE obligation_id = ? AND document_kind = 'receipt'
         ORDER BY issued_at DESC
         LIMIT 1`,
      )
      .bind(row.obligation_id)
      .first<PaymentReceiptSqlRow>();
    linkedReceipt = byObligation ? mapReceiptRow(byObligation) : null;
  }

  const agencyId = linkedReceipt?.agencyId ?? row.payer_agency_id ?? row.tenant_agency_id ?? null;
  const payer = await resolvePayerIdentity(db, row.organization_id, agencyId);

  const paymentChannel =
    linkedReceipt?.paymentChannel ??
    (row.channel_code && row.channel && row.channel_code !== row.channel
      ? `${row.channel} (${row.channel_code})`
      : (row.channel ?? "Manual Refund"));

  const fullRefundReceipt =
    linkedReceipt !== null && row.refund_amount_idr === linkedReceipt.totalAmountIdr
      ? linkedReceipt
      : null;

  const baseAmountIdr = fullRefundReceipt
    ? fullRefundReceipt.baseAmountIdr
    : row.refund_amount_idr;
  const discountAmountIdr = fullRefundReceipt ? fullRefundReceipt.discountAmountIdr : 0;
  const channelFeeIdr = fullRefundReceipt ? fullRefundReceipt.channelFeeIdr : 0;
  const totalAmountIdr = row.refund_amount_idr;

  assertReceiptAccountingSum({
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalAmountIdr,
  });

  return {
    refundId: row.refund_id,
    obligationId: row.obligation_id,
    settlementId: row.settlement_id,
    linkedReceiptId: linkedReceipt?.id ?? null,
    linkedReceiptNumber: linkedReceipt?.receiptNumber ?? null,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantHandle: row.tenant_handle,
    agencyId,
    payerKind: agencyId ? "agency" : payer.payerKind,
    payerUserId: linkedReceipt?.payerUserId ?? payer.payerUserId,
    payerName: payer.payerName,
    payerEmail: payer.payerEmail,
    planCode: linkedReceipt?.planCode ?? row.plan_interval,
    periodStartMs: linkedReceipt?.periodStartMs ?? row.period_start_at,
    periodEndMs: linkedReceipt?.periodEndMs ?? row.period_end_at,
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalAmountIdr,
    paymentChannel,
    providerReference:
      row.external_reference ??
      linkedReceipt?.providerReference ??
      row.provider_transaction_id ??
      row.reff_id ??
      null,
    refundKind: row.refund_kind,
    reason: row.reason,
    refundedAtMs: row.refunded_at,
  };
}

export interface AllocatePaymentReceiptInput {
  readonly documentKind: ReceiptDocumentKind;
  readonly tenantId: string;
  readonly agencyId: string | null;
  readonly obligationId: string;
  readonly settlementId: string | null;
  readonly refundId: string | null;
  readonly linkedReceiptId: string | null;
  readonly payerUserId: string;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly planCode: string;
  readonly periodStartMs: number | null;
  readonly periodEndMs: number | null;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly issuedAtMs: number;
  readonly nowMs?: number;
  readonly maxCasRetries?: number;
  readonly buildPdf: (
    receiptNumber: string,
    r2ObjectKey: string,
  ) => Promise<GeneratedReceiptPdf>;
}

export interface AllocatePaymentReceiptResult {
  readonly created: boolean;
  readonly receipt: PaymentReceiptRecord;
  readonly pdfBytes: Uint8Array | null;
}

/**
 * Atomically allocates a gap-free yearly sequential receipt number (`PS-YYYY-NNNNNN`)
 * and inserts the immutable `payment_receipts` row in ONE D1 `batch()` transaction.
 *
 * - Re-issuing for the same `settlementId` or `refundId` is 100% idempotent and NEVER
 *   increments `receipt_yearly_counters`.
 * - Concurrent calls via `Promise.all` serialize via SQLite CAS on `receipt_yearly_counters.last_seq`
 *   so there are ZERO collisions and ZERO sequence gaps.
 */
export async function allocateAndInsertPaymentReceipt(
  db: D1Database,
  input: AllocatePaymentReceiptInput,
): Promise<AllocatePaymentReceiptResult> {
  const nowMs = Math.trunc(input.nowMs ?? input.issuedAtMs);

  const issuedAtMs = Math.trunc(input.issuedAtMs);
  const year = getWibYearFromEpochMs(issuedAtMs);
  const baseAmountIdr = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr");
  const discountAmountIdr = assertExactIdrInteger(input.discountAmountIdr, "discountAmountIdr");
  const channelFeeIdr = assertExactIdrInteger(input.channelFeeIdr, "channelFeeIdr");
  const totalAmountIdr = assertExactIdrInteger(input.totalAmountIdr, "totalAmountIdr");

  assertReceiptAccountingSum({
    baseAmountIdr,
    discountAmountIdr,
    channelFeeIdr,
    totalAmountIdr,
  });

  if (input.documentKind === "receipt") {
    if (!input.settlementId?.trim() || input.refundId !== null) {
      throw new BillingValidationError(
        "INVALID_RECEIPT_LINKAGE",
        "Kuitansi pembayaran harus terikat pada settlementId dan tidak boleh memiliki refundId.",
      );
    }
  } else {
    if (!input.refundId?.trim() || input.settlementId !== null) {
      throw new BillingValidationError(
        "INVALID_CREDIT_NOTE_LINKAGE",
        "Nota kredit harus terikat pada refundId dan tidak boleh memiliki settlementId.",
      );
    }
  }

  const findExisting = async (): Promise<PaymentReceiptRecord | null> =>
    input.documentKind === "receipt"
      ? findPaymentReceiptBySettlementId(db, input.settlementId!)
      : findPaymentReceiptByRefundId(db, input.refundId!);

  // 1. Fast-path idempotency check (never touches counter)
  const existingFast = await findExisting();
  if (existingFast) {
    return { created: false, receipt: existingFast, pdfBytes: null };
  }

  const maxRetries = Math.max(4, Math.min(64, Math.trunc(input.maxCasRetries ?? 32)));

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const counterRow = await db
      .prepare("SELECT last_seq FROM receipt_yearly_counters WHERE year = ? LIMIT 1")
      .bind(year)
      .first<{ readonly last_seq: number }>();

    const expectedPrevSeq = counterRow?.last_seq ?? 0;
    const candidateSeq = expectedPrevSeq + 1;
    const receiptNumber = formatReceiptNumber(year, candidateSeq);
    const r2ObjectKey = buildReceiptR2ObjectKey(year, receiptNumber);

    const generated = await input.buildPdf(receiptNumber, r2ObjectKey);
    if (generated.byteLength <= 0 || generated.bytes.byteLength <= 0) {
      throw new BillingValidationError("EMPTY_RECEIPT_PDF", "PDF kuitansi tidak boleh kosong.");
    }

    const receiptId =
      input.documentKind === "credit_note"
        ? `rcn_${generateBillingUlid(nowMs)}`
        : `rcp_${generateBillingUlid(nowMs)}`;
    const nonPkpNotice = generated.nonPkpNotice || RECEIPT_NON_PKP_NOTICE;

    const idempotencyGuardSql =
      input.documentKind === "receipt"
        ? "NOT EXISTS (SELECT 1 FROM payment_receipts WHERE settlement_id = ?)"
        : "NOT EXISTS (SELECT 1 FROM payment_receipts WHERE refund_id = ?)";
    const idempotencyGuardValue =
      input.documentKind === "receipt" ? input.settlementId! : input.refundId!;

    try {
      const [, updateCounterRes, insertReceiptRes] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO receipt_yearly_counters (year, last_seq, updated_at)
             VALUES (?, 0, ?)`,
          )
          .bind(year, nowMs),
        db
          .prepare(
            `UPDATE receipt_yearly_counters
             SET last_seq = last_seq + 1,
                 updated_at = ?
             WHERE year = ?
               AND last_seq = ?
               AND ${idempotencyGuardSql}`,
          )
          .bind(nowMs, year, expectedPrevSeq, idempotencyGuardValue),
        db
          .prepare(
            `INSERT INTO payment_receipts (
               id, receipt_number, document_kind, tenant_id, agency_id, obligation_id,
               settlement_id, refund_id, linked_receipt_id, payer_user_id, currency,
               base_amount_idr, discount_amount_idr, channel_fee_idr, total_amount_idr,
               plan_code, period_start_ms, period_end_ms, payment_channel, provider_reference,
               r2_object_key, pdf_sha256, pdf_byte_length, non_pkp_notice,
               issued_at, emailed_at, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
             WHERE changes() = 1`,
          )
          .bind(
            receiptId,
            receiptNumber,
            input.documentKind,
            input.tenantId,
            input.agencyId,
            input.obligationId,
            input.settlementId,
            input.refundId,
            input.linkedReceiptId,
            input.payerUserId,
            BILLING_CURRENCY,
            baseAmountIdr,
            discountAmountIdr,
            channelFeeIdr,
            totalAmountIdr,
            input.planCode,
            input.periodStartMs,
            input.periodEndMs,
            input.paymentChannel,
            input.providerReference,
            r2ObjectKey,
            generated.sha256Hex,
            generated.byteLength,
            nonPkpNotice,
            issuedAtMs,
            nowMs,
          ),
      ]);

      if ((updateCounterRes?.meta?.changes ?? 0) === 1 && (insertReceiptRes?.meta?.changes ?? 0) === 1) {
        return {
          created: true,
          receipt: {
            id: receiptId,
            receiptNumber,
            documentKind: input.documentKind,
            tenantId: input.tenantId,
            agencyId: input.agencyId,
            obligationId: input.obligationId,
            settlementId: input.settlementId,
            refundId: input.refundId,
            linkedReceiptId: input.linkedReceiptId,
            payerUserId: input.payerUserId,
            currency: BILLING_CURRENCY,
            baseAmountIdr,
            discountAmountIdr,
            channelFeeIdr,
            totalAmountIdr,
            planCode: input.planCode,
            periodStartMs: input.periodStartMs,
            periodEndMs: input.periodEndMs,
            paymentChannel: input.paymentChannel,
            providerReference: input.providerReference,
            r2ObjectKey,
            pdfSha256: generated.sha256Hex,
            pdfByteLength: generated.byteLength,
            nonPkpNotice,
            issuedAtMs,
            issuedAtIso: new Date(issuedAtMs).toISOString(),
            emailedAtMs: null,
            emailedAtIso: null,
            createdAtMs: nowMs,
            createdAtIso: new Date(nowMs).toISOString(),
          },
          pdfBytes: generated.bytes,
        };
      }
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // Concurrent winner inserted first -> fall through to idempotency re-check & retry
    }

    const racedExisting = await findExisting();
    if (racedExisting) {
      return { created: false, receipt: racedExisting, pdfBytes: null };
    }
  }

  throw new BillingConflictError(
    "CONFLICT",
    "RECEIPT_SEQUENCE_CONTENTION",
    "Gagal mengalokasikan nomor urut kuitansi setelah beberapa percobaan bersamaan.",
  );
}
