/**
 * Canonical constants for PunyaSitus platform subscription billing (PLAN §16, §17; REQ-056..060).
 * Server-owned defaults and policy texts; never trust client-supplied pricing, fees, or status.
 */

export const BILLING_CURRENCY = "IDR" as const;

export const DEFAULT_MONTHLY_PRICE_IDR = 179_000 as const;
export const DEFAULT_YEARLY_PRICE_IDR = 1_790_000 as const;
export const MIN_AUTOLARIS_CHARGE_IDR = 10_000 as const;
export const MAX_IDR_AMOUNT = 999_999_999_999 as const;

/** Maximum tolerated gateway fee ratio (10%) or IDR 25.000 floor to block absurd/corrupted provider fees. */
export const MAX_PROVIDER_FEE_RATIO_PERCENT = 10 as const;
export const MAX_PROVIDER_FEE_MIN_CEILING_IDR = 25_000 as const;

/** Merchant-approved non-physical AutoLaris profile constants (PLAN §16.1, §16.2). */
export const AUTOLARIS_PROVIDER_ID = "autolaris" as const;
export const AUTOLARIS_DEFAULT_ACCOUNT_ID = "default" as const;
export const AUTOLARIS_DIGITAL_COURIR_ID = 1 as const;
export const AUTOLARIS_COD_VALUE = "0" as const;
export const AUTOLARIS_FIXED_ORIGIN = "https://api-h2h.autolaris.com" as const;
export const AUTOLARIS_REFF_ID_MAX_LENGTH = 30 as const;

export const TRIAL_DURATION_SECONDS = 604_800 as const; // Exact 7 days (168h, REQ-059 / REQ-060)
export const TRIAL_DURATION_MS = TRIAL_DURATION_SECONDS * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const GRACE_WINDOW_MS = 72 * 60 * 60 * 1000; // H+1..H+3
export const LOCKED_WINDOW_MS = 168 * 60 * 60 * 1000; // H+4..H+7
export const PAID_DELETION_WINDOW_MS = 45 * 24 * 60 * 60 * 1000; // H+45
export const TRIAL_DELETION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // +30d after trial end
export const DEFAULT_OBLIGATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const REMINDER_H_MINUS_3_MS = 3 * DAY_MS; // 72h before period end
export const REMINDER_H_MINUS_1_MS = 1 * DAY_MS; // 24h before period end
export const REMINDER_H0_WINDOW_MS = 1 * DAY_MS; // Day of expiry (H0..H+1)

export const TRIAL_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB during trial (DEC-035 C8)
export const PAID_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB when active/grace/locked

export const NON_PKP_TAX_NOTICE =
  "Harga belum termasuk PPN (penyelenggara belum PKP; bukti bayar berupa kuitansi layanan, bukan faktur pajak)." as const;

export const NO_REFUND_NOTICE =
  "Pembayaran langganan tidak dapat dikembalikan karena berubah pikiran. Pengembalian dana hanya diproses manual oleh superadmin untuk pembayaran ganda atau salah bayar." as const;

/**
 * Keys that MUST NEVER be accepted in billing write request bodies:
 * cross-tenant selectors, actor selectors, client-forged money/period/status/provider fields.
 */
export const FORBIDDEN_BILLING_BODY_KEYS: readonly string[] = [
  "tenantId",
  "tenant_id",
  "organizationId",
  "organization_id",
  "tenantHandle",
  "tenant_handle",
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "agencyId",
  "agency_id",
  "payerType",
  "payer_type",
  "amount",
  "amountIdr",
  "amount_idr",
  "price",
  "priceIdr",
  "price_idr",
  "baseAmountIdr",
  "base_amount_idr",
  "grossAmountIdr",
  "gross_amount_idr",
  "discountAmountIdr",
  "discount_amount_idr",
  "netAmountIdr",
  "net_amount_idr",
  "fee",
  "feeIdr",
  "channelFeeIdr",
  "channel_fee_idr",
  "total",
  "totalPayableIdr",
  "total_payable_idr",
  "currency",
  "status",
  "state",
  "lifecycleState",
  "lifecycle_state",
  "paid",
  "paidAt",
  "paid_at",
  "provider",
  "providerTransactionId",
  "provider_transaction_id",
  "transaction_id",
  "trx_id",
  "reffId",
  "reff_id",
  "periodStartAt",
  "period_start_at",
  "periodEndAt",
  "period_end_at",
  "courir_id",
  "courier_id",
  "cod_value",
  "callback_url",
] as const;

export const PLATFORM_BILLING_SETTING_KEYS = {
  pricing: "billing.pricing",
  monthlyPriceIdr: "billing.monthly_price_idr",
  yearlyPriceIdr: "billing.yearly_price_idr",
} as const;
