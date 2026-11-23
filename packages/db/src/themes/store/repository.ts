import {
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  evaluateAdviceSettlement,
  type AdviceSettlementPolicy,
  type RawAutoLarisAdviceObservation,
} from "@punyasitus/core/billing/advice";
import type { CouponPayerType } from "@punyasitus/core/billing/coupons";
import {
  BILLING_CURRENCY,
  BillingConflictError,
  BillingNotFoundError,
  BillingValidationError,
  DEFAULT_OBLIGATION_TTL_MS,
  generateAutoLarisReffId,
  generateBillingUlid,
} from "@punyasitus/core/billing/index";
import { getWibYearFromEpochMs, RECEIPT_NON_PKP_NOTICE } from "@punyasitus/core/billing/receipt-pdf";
import {
  PublicationAtomicError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import {
  ThemeNotFoundError,
  ThemeNotGrantedError,
  ThemeTokensSchema,
  ThemeVariantsSchema,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  StoreThemeIdSchema,
  ThemeNotEntitledError,
  ThemeStoreDomainError,
  computeThemeStoreCheckoutQuote,
  formatThemeReceiptNumber,
  generateThemeStoreReceiptPdf,
  getDefaultStyleVariantForTheme,
  getStyleVariantById,
  isPlatformThemeId,
  type GeneratedThemeStoreReceiptPdf,
  type StoreThemeTier,
  type ThemeStoreChannelCode,
  type ThemeStoreCouponInput,
  type ThemeStyleVariantDefinition,
} from "@punyasitus/core/theme/variants";
import { buildPlatformAuditStatement } from "../../platform/audit.ts";
import { bumpTenantCacheVersion } from "../../publication/index.ts";

/**
 * Commercial Theme Store & Style Variant Repository (`PLATFORM_DB` D1 + `TenantStore` DO)
 * (REQ-096, REQ-018, REQ-046, REQ-081, REQ-082; ADR-0010; PLAN §11.4 & §19.7; TASK-096).
 *
 * Security & Integrity Invariants:
 * 1. Per-website entitlement isolation: `tenant_theme_entitlements` is strictly scoped by
 *    `(tenant_id, theme_id)` — purchasing a `paid_once` theme on Website A NEVER unlocks
 *    Website B (even if owned by the same user).
 * 2. Zero client price trust: checkout prices are ALWAYS loaded from `PLATFORM_DB.theme_catalog`
 *    and validated with single-coupon server math (`computeThemeStoreCheckoutQuote`).
 * 3. Atomic & replay-safe settlement: AutoLaris Advice settlement verification rejects generic
 *    `"00"`/`"OK"`/`"SUCCESS"` or shipping tokens; confirmed settlement atomically marks order
 *    `paid`, grants per-website `tenant_theme_entitlements`, allocates a gap-free yearly receipt
 *    number (`INV-THM-YYYY-NNNNNN`), inserts immutable `theme_store_receipts`, and appends
 *    `platform_audit`. Replaying settlement returns existing entitlement & receipt idempotently.
 * 4. 0% content loss on theme/variant switching: `pages`, `posts`, `offerings`, `menus`, and
 *    `media_items` are NEVER deleted or mutated when switching style variants or themes.
 * 5. Zero runtime DDL: assumes `0027_commercial_theme_store.sql` and `0021_theme_style_variants.sql`
 *    are applied via migrations.
 */

export interface ThemeStoreCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: StoreThemeTier;
  readonly priceIdr: number;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAtMs: number;
}

export interface TenantThemeStoreEntitlementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly themeId: string;
  readonly grantedBy: string | null;
  readonly settlementId: string | null;
  readonly grantedAtMs: number;
  readonly grantedAtIso: string;
}

export interface ThemeStoreOrderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly themeId: string;
  readonly payerUserId: string;
  readonly agencyId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: "pending" | "paid" | "expired" | "failed" | "review";
  readonly currency: typeof BILLING_CURRENCY;
  readonly basePriceIdr: number;
  readonly couponId: string | null;
  readonly couponCode: string | null;
  readonly discountAmountIdr: number;
  readonly netBaseAmountIdr: number;
  readonly channelCode: string;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly providerAccountId: string;
  readonly providerReffId: string;
  readonly providerTransactionId: string | null;
  readonly paymentInstructions: Record<string, unknown> | null;
  readonly settledAtMs: number | null;
  readonly settledAtIso: string | null;
  readonly entitlementId: string | null;
  readonly receiptId: string | null;
  readonly safeFailureCode: string | null;
  readonly expiresAtMs: number;
  readonly expiresAtIso: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtMs: number;
  readonly updatedAtIso: string;
}

export interface ThemeStoreAdviceQuery {
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  readonly providerReffId: string;
}

/**
 * Server-side AutoLaris Advice port injected into the settlement handler.
 * Payment proof MUST NEVER originate from client POST bodies.
 */
export interface ThemeStoreAdvicePort {
  fetchAdvice(query: ThemeStoreAdviceQuery): Promise<RawAutoLarisAdviceObservation>;
}

export interface ThemeStoreReceiptRecord {
  readonly id: string;
  readonly receiptNumber: string;
  readonly tenantId: string;
  readonly tenantNameSnapshot: string;
  readonly payerNameSnapshot: string;
  readonly themeId: string;
  readonly orderId: string;
  readonly entitlementId: string;
  readonly payerUserId: string;
  readonly currency: typeof BILLING_CURRENCY;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode: string | null;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly r2ObjectKey: string;
  readonly pdfSha256: string;
  readonly pdfByteLength: number;
  readonly nonPkpNotice: string;
  readonly issuedAtMs: number;
  readonly issuedAtIso: string;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
}

interface RawCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: StoreThemeTier;
  readonly price_idr: number;
  readonly active: number;
  readonly version: number;
  readonly updated_at: number;
}

interface RawEntitlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly theme_id: string;
  readonly granted_by: string | null;
  readonly settlement_id: string | null;
  readonly granted_at: number;
}

interface RawOrderRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly theme_id: string;
  readonly payer_user_id: string;
  readonly agency_id: string | null;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly status: ThemeStoreOrderRecord["status"];
  readonly currency: string;
  readonly base_price_idr: number;
  readonly coupon_id: string | null;
  readonly coupon_code: string | null;
  readonly discount_amount_idr: number;
  readonly net_base_amount_idr: number;
  readonly channel_code: string;
  readonly channel_fee_idr: number;
  readonly total_payable_idr: number;
  readonly provider_account_id: string;
  readonly provider_reff_id: string;
  readonly provider_transaction_id: string | null;
  readonly payment_instructions_json: string | null;
  readonly settled_at: number | null;
  readonly entitlement_id: string | null;
  readonly receipt_id: string | null;
  readonly safe_failure_code: string | null;
  readonly expires_at: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawReceiptRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly tenant_id: string;
  readonly tenant_name_snapshot: string;
  readonly payer_name_snapshot: string;
  readonly theme_id: string;
  readonly order_id: string;
  readonly entitlement_id: string;
  readonly payer_user_id: string;
  readonly currency: string;
  readonly base_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly channel_fee_idr: number;
  readonly total_amount_idr: number;
  readonly coupon_code: string | null;
  readonly payment_channel: string;
  readonly provider_reference: string | null;
  readonly r2_object_key: string;
  readonly pdf_sha256: string;
  readonly pdf_byte_length: number;
  readonly non_pkp_notice: string;
  readonly issued_at: number;
  readonly created_at: number;
}

interface RawCouponRow {
  readonly id: string;
  readonly code: string;
  readonly discount_kind: "percent" | "fixed_idr";
  readonly discount_value: number;
  readonly eligible_payer_types_json: string | null;
  readonly max_redemptions: number | null;
  readonly redeemed_count: number;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly active: number;
}

function mapCatalogRow(r: RawCatalogRow): ThemeStoreCatalogRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    tier: r.tier,
    priceIdr: Number(r.price_idr),
    active: r.active === 1,
    version: Number(r.version),
    updatedAtMs: Number(r.updated_at),
  };
}

function mapEntitlementRow(r: RawEntitlementRow): TenantThemeStoreEntitlementRecord {
  const grantedAtMs = Number(r.granted_at);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    themeId: r.theme_id,
    grantedBy: r.granted_by,
    settlementId: r.settlement_id,
    grantedAtMs,
    grantedAtIso: new Date(grantedAtMs).toISOString(),
  };
}

function safeParseObjectJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapOrderRow(r: RawOrderRow): ThemeStoreOrderRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    themeId: r.theme_id,
    payerUserId: r.payer_user_id,
    agencyId: r.agency_id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    status: r.status,
    currency: BILLING_CURRENCY,
    basePriceIdr: Number(r.base_price_idr),
    couponId: r.coupon_id,
    couponCode: r.coupon_code,
    discountAmountIdr: Number(r.discount_amount_idr),
    netBaseAmountIdr: Number(r.net_base_amount_idr),
    channelCode: r.channel_code,
    channelFeeIdr: Number(r.channel_fee_idr),
    totalPayableIdr: Number(r.total_payable_idr),
    providerAccountId: r.provider_account_id,
    providerReffId: r.provider_reff_id,
    providerTransactionId: r.provider_transaction_id,
    paymentInstructions: safeParseObjectJson(r.payment_instructions_json),
    settledAtMs: r.settled_at !== null ? Number(r.settled_at) : null,
    settledAtIso: r.settled_at !== null ? new Date(Number(r.settled_at)).toISOString() : null,
    entitlementId: r.entitlement_id,
    receiptId: r.receipt_id,
    safeFailureCode: r.safe_failure_code,
    expiresAtMs: Number(r.expires_at),
    expiresAtIso: new Date(Number(r.expires_at)).toISOString(),
    version: Number(r.version),
    createdAtMs: Number(r.created_at),
    createdAtIso: new Date(Number(r.created_at)).toISOString(),
    updatedAtMs: Number(r.updated_at),
    updatedAtIso: new Date(Number(r.updated_at)).toISOString(),
  };
}

function mapReceiptRow(r: RawReceiptRow): ThemeStoreReceiptRecord {
  const issuedAtMs = Number(r.issued_at);
  const createdAtMs = Number(r.created_at);
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    tenantId: r.tenant_id,
    tenantNameSnapshot: r.tenant_name_snapshot,
    payerNameSnapshot: r.payer_name_snapshot,
    themeId: r.theme_id,
    orderId: r.order_id,
    entitlementId: r.entitlement_id,
    payerUserId: r.payer_user_id,
    currency: BILLING_CURRENCY,
    baseAmountIdr: Number(r.base_amount_idr),
    discountAmountIdr: Number(r.discount_amount_idr),
    channelFeeIdr: Number(r.channel_fee_idr),
    totalAmountIdr: Number(r.total_amount_idr),
    couponCode: r.coupon_code,
    paymentChannel: r.payment_channel,
    providerReference: r.provider_reference,
    r2ObjectKey: r.r2_object_key,
    pdfSha256: r.pdf_sha256,
    pdfByteLength: Number(r.pdf_byte_length),
    nonPkpNotice: r.non_pkp_notice,
    issuedAtMs,
    issuedAtIso: new Date(issuedAtMs).toISOString(),
    createdAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

async function computeRequestHash(payload: Record<string, unknown>): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

// ---------------------------------------------------------------------------
// Catalog, Entitlements & Strict Per-Website Guard
// ---------------------------------------------------------------------------

export async function listThemeStoreCatalogEntries(
  platformDb: D1Database,
  options: { readonly includeInactive?: boolean } = {},
): Promise<readonly ThemeStoreCatalogRow[]> {
  const sql = options.includeInactive
    ? `SELECT id, slug, name, tier, price_idr, active, version, updated_at
       FROM theme_catalog
       ORDER BY CASE tier WHEN 'included' THEN 1 WHEN 'paid_once' THEN 2 ELSE 3 END, name ASC`
    : `SELECT id, slug, name, tier, price_idr, active, version, updated_at
       FROM theme_catalog
       WHERE active = 1
       ORDER BY CASE tier WHEN 'included' THEN 1 WHEN 'paid_once' THEN 2 ELSE 3 END, name ASC`;
  const rows = await platformDb.prepare(sql).all<RawCatalogRow>();
  return rows.results.map(mapCatalogRow);
}

export async function listTenantThemeStoreState(
  platformDb: D1Database,
  tenantId: string,
): Promise<{
  readonly catalog: readonly ThemeStoreCatalogRow[];
  readonly entitlements: readonly TenantThemeStoreEntitlementRecord[];
  readonly orders: readonly ThemeStoreOrderRecord[];
  readonly receipts: readonly ThemeStoreReceiptRecord[];
}> {
  const [catalog, entitlementRows] = await Promise.all([
    listThemeStoreCatalogEntries(platformDb),
    platformDb
      .prepare(
        `SELECT id, tenant_id, theme_id, granted_by, settlement_id, granted_at
         FROM tenant_theme_entitlements
         WHERE tenant_id = ?
         ORDER BY granted_at DESC`,
      )
      .bind(tenantId)
      .all<RawEntitlementRow>(),
  ]);

  let orders: ThemeStoreOrderRecord[] = [];
  let receipts: ThemeStoreReceiptRecord[] = [];
  try {
    const [orderRows, receiptRows] = await Promise.all([
      platformDb
        .prepare(
          `SELECT * FROM theme_store_orders
           WHERE tenant_id = ?
           ORDER BY created_at DESC
           LIMIT 50`,
        )
        .bind(tenantId)
        .all<RawOrderRow>(),
      platformDb
        .prepare(
          `SELECT * FROM theme_store_receipts
           WHERE tenant_id = ?
           ORDER BY issued_at DESC
           LIMIT 50`,
        )
        .bind(tenantId)
        .all<RawReceiptRow>(),
    ]);
    orders = orderRows.results.map(mapOrderRow);
    receipts = receiptRows.results.map(mapReceiptRow);
  } catch (err) {
    // Allow graceful read when 0027 hasn't been applied in legacy TASK-042 suites
    if (!isMissingTableError(err)) {
      throw err;
    }
  }

  return {
    catalog,
    entitlements: entitlementRows.results.map(mapEntitlementRow),
    orders,
    receipts,
  };
}

/**
 * Strictly asserts whether `tenantId` is entitled to activate `themeId`.
 * - Platform `included` themes -> always allowed.
 * - `paid_once` themes -> MUST have an active `tenant_theme_entitlements` row for THIS `tenantId`,
 *   otherwise throws `ThemeNotEntitledError` (`403 THEME_NOT_ENTITLED`).
 * - `custom` themes -> MUST have an active `tenant_theme_entitlements` row for THIS `tenantId`,
 *   otherwise throws `ThemeNotGrantedError` (`403 THEME_NOT_GRANTED`).
 * - Unknown/inactive themes -> throws `ThemeNotFoundError` (`404 THEME_NOT_FOUND`).
 */
export async function assertTenantThemeEntitled(
  platformDb: D1Database,
  tenantId: string,
  themeId: string,
): Promise<{
  readonly catalogEntry: ThemeStoreCatalogRow | null;
  readonly tier: StoreThemeTier;
  readonly entitlement: TenantThemeStoreEntitlementRecord | null;
}> {
  const cleanId = themeId.trim();
  if (!cleanId || !StoreThemeIdSchema.safeParse(cleanId).success) {
    throw new ThemeNotFoundError(cleanId || "(kosong)");
  }

  if (isPlatformThemeId(cleanId)) {
    const row = await platformDb
      .prepare(
        `SELECT id, slug, name, tier, price_idr, active, version, updated_at
         FROM theme_catalog WHERE id = ? LIMIT 1`,
      )
      .bind(cleanId)
      .first<RawCatalogRow>();
    return {
      catalogEntry: row ? mapCatalogRow(row) : null,
      tier: "included",
      entitlement: null,
    };
  }

  const row = await platformDb
    .prepare(
      `SELECT id, slug, name, tier, price_idr, active, version, updated_at
       FROM theme_catalog
       WHERE id = ? AND active = 1
       LIMIT 1`,
    )
    .bind(cleanId)
    .first<RawCatalogRow>();

  if (!row) {
    throw new ThemeNotFoundError(cleanId);
  }

  const catalogEntry = mapCatalogRow(row);
  if (catalogEntry.tier === "included") {
    return { catalogEntry, tier: "included", entitlement: null };
  }

  const grantRow = await platformDb
    .prepare(
      `SELECT id, tenant_id, theme_id, granted_by, settlement_id, granted_at
       FROM tenant_theme_entitlements
       WHERE tenant_id = ? AND theme_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, catalogEntry.id)
    .first<RawEntitlementRow>();

  if (!grantRow) {
    if (catalogEntry.tier === "paid_once") {
      throw new ThemeNotEntitledError(catalogEntry.id);
    }
    throw new ThemeNotGrantedError(catalogEntry.id);
  }

  return {
    catalogEntry,
    tier: catalogEntry.tier,
    entitlement: mapEntitlementRow(grantRow),
  };
}

// ---------------------------------------------------------------------------
// Checkout Order Creation (Server-Side Price + Single Coupon + Idempotency)
// ---------------------------------------------------------------------------

export interface CreateThemeStoreCheckoutInput {
  readonly tenantId: string;
  readonly themeId: string;
  readonly payerUserId: string;
  readonly agencyId?: string | null;
  readonly channelCode?: string;
  readonly couponCode?: unknown;
  readonly idempotencyKey: string;
  readonly providerAccountId?: string;
  readonly nowMs?: number;
}

export interface CreateThemeStoreCheckoutResult {
  readonly order: ThemeStoreOrderRecord;
  readonly theme: ThemeStoreCatalogRow;
  readonly idempotentReplay: boolean;
}

async function loadCouponForThemeStore(
  platformDb: D1Database,
  code: string,
  tenantId: string,
): Promise<{
  readonly coupon: ThemeStoreCouponInput | null;
  readonly alreadyRedeemedByTenant: boolean;
}> {
  let couponRow: RawCouponRow | null;
  try {
    couponRow = await platformDb
      .prepare(
        `SELECT id, code, discount_kind, discount_value, eligible_payer_types_json,
                max_redemptions, redeemed_count, starts_at, ends_at, active
         FROM promo_coupons
         WHERE code = ?
         LIMIT 1`,
      )
      .bind(code)
      .first<RawCouponRow>();
  } catch (err) {
    if (isMissingTableError(err)) {
      return { coupon: null, alreadyRedeemedByTenant: false };
    }
    throw err;
  }

  if (!couponRow) {
    return { coupon: null, alreadyRedeemedByTenant: false };
  }

  let eligiblePayerTypes: CouponPayerType[] = ["tenant", "agency"];
  if (couponRow.eligible_payer_types_json) {
    try {
      const parsed = JSON.parse(couponRow.eligible_payer_types_json) as unknown;
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter(
          (v): v is CouponPayerType => v === "tenant" || v === "agency",
        );
        if (filtered.length > 0) eligiblePayerTypes = filtered;
      }
    } catch {
      // default both
    }
  }

  // Prevent a single tenant from creating multiple concurrent open/paid orders with the same coupon
  const activeOrPaidCouponOrder = await platformDb
    .prepare(
      `SELECT id FROM theme_store_orders
       WHERE tenant_id = ? AND coupon_id = ? AND status IN ('pending', 'review', 'paid')
       LIMIT 1`,
    )
    .bind(tenantId, couponRow.id)
    .first<{ readonly id: string }>();

  return {
    coupon: {
      id: couponRow.id,
      code: couponRow.code,
      discountKind: couponRow.discount_kind,
      discountValue: Number(couponRow.discount_value),
      eligiblePayerTypes,
      maxRedemptions: couponRow.max_redemptions !== null ? Number(couponRow.max_redemptions) : null,
      redeemedCount: Number(couponRow.redeemed_count),
      startsAtMs: Number(couponRow.starts_at),
      endsAtMs: Number(couponRow.ends_at),
      active: couponRow.active === 1,
    },
    alreadyRedeemedByTenant: activeOrPaidCouponOrder !== null,
  };
}

export async function getTenantThemeStoreOrderById(
  platformDb: D1Database,
  tenantId: string,
  orderId: string,
): Promise<ThemeStoreOrderRecord | null> {
  const row = await platformDb
    .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
    .bind(orderId, tenantId)
    .first<RawOrderRow>();
  return row ? mapOrderRow(row) : null;
}

export async function createThemeStoreCheckoutOrder(
  platformDb: D1Database,
  input: CreateThemeStoreCheckoutInput,
): Promise<CreateThemeStoreCheckoutResult> {
  const nowMs = input.nowMs ?? Date.now();
  const cleanThemeId = input.themeId.trim();
  const cleanIdemKey = input.idempotencyKey.trim();
  if (!cleanIdemKey || cleanIdemKey.length > 128) {
    throw new BillingValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key wajib diisi (1–128 karakter).",
    );
  }

  const catalogRow = await platformDb
    .prepare(
      `SELECT id, slug, name, tier, price_idr, active, version, updated_at
       FROM theme_catalog
       WHERE id = ? AND active = 1
       LIMIT 1`,
    )
    .bind(cleanThemeId)
    .first<RawCatalogRow>();

  if (!catalogRow) {
    throw new ThemeNotFoundError(cleanThemeId);
  }

  const theme = mapCatalogRow(catalogRow);
  if (theme.tier !== "paid_once" || theme.priceIdr <= 0) {
    throw new ThemeStoreDomainError(
      422,
      "THEME_NOT_PURCHASABLE",
      `Tema "${theme.name}" tidak tersedia untuk pembelian sekali bayar.`,
    );
  }

  // Check if this tenant ALREADY owns the theme (strict per-website entitlement!)
  const existingEntitlement = await platformDb
    .prepare(
      `SELECT id FROM tenant_theme_entitlements
       WHERE tenant_id = ? AND theme_id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, theme.id)
    .first<{ readonly id: string }>();

  // Check idempotent replay first so retrying the exact same settled order key returns cleanly
  const normalizedChannel = (input.channelCode ?? "QRIS").trim().toUpperCase();
  const normalizedCouponKey =
    typeof input.couponCode === "string" ? input.couponCode.trim().toUpperCase() : null;

  const requestHash = await computeRequestHash({
    tenantId: input.tenantId,
    themeId: theme.id,
    channelCode: normalizedChannel,
    couponCode: normalizedCouponKey,
  });

  const existingByIdem = await platformDb
    .prepare(
      `SELECT * FROM theme_store_orders
       WHERE tenant_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, cleanIdemKey)
    .first<RawOrderRow>();

  if (existingByIdem) {
    if (existingByIdem.request_hash !== requestHash) {
      throw new BillingConflictError(
        "IDEMPOTENCY_CONFLICT",
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key sudah digunakan untuk parameter checkout tema yang berbeda.",
      );
    }
    return {
      order: mapOrderRow(existingByIdem),
      theme,
      idempotentReplay: true,
    };
  }

  if (existingEntitlement) {
    throw new ThemeStoreDomainError(
      409,
      "THEME_ALREADY_ENTITLED",
      `Tema "${theme.name}" sudah dimiliki oleh situs ini dan siap langsung diaktifkan.`,
    );
  }

  // Expire any stale pending order past its server-clock expires_at before checking open-order lock
  await platformDb
    .prepare(
      `UPDATE theme_store_orders
       SET status = 'expired', safe_failure_code = 'ORDER_EXPIRED', version = version + 1, updated_at = ?
       WHERE tenant_id = ? AND theme_id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(nowMs, input.tenantId, theme.id, nowMs)
    .run();

  const existingOpenOrder = await platformDb
    .prepare(
      `SELECT * FROM theme_store_orders
       WHERE tenant_id = ? AND theme_id = ? AND status IN ('pending', 'review')
       LIMIT 1`,
    )
    .bind(input.tenantId, theme.id)
    .first<RawOrderRow>();

  if (existingOpenOrder) {
    throw new ThemeStoreDomainError(
      409,
      "OPEN_ORDER_EXISTS",
      `Masih ada pesanan pembayaran aktif (${existingOpenOrder.id}) untuk tema "${theme.name}". Selesaikan atau verifikasi pesanan tersebut terlebih dahulu.`,
    );
  }

  // Lookup optional coupon strictly on the server
  let couponLookup: {
    readonly coupon: ThemeStoreCouponInput | null;
    readonly alreadyRedeemedByTenant: boolean;
  } = { coupon: null, alreadyRedeemedByTenant: false };

  if (input.couponCode !== undefined && input.couponCode !== null && input.couponCode !== "") {
    // Pre-validate single-coupon rule via computeThemeStoreCheckoutQuote (also rejects stacking!)
    if (typeof input.couponCode === "string" && input.couponCode.trim().length > 0) {
      const cleanCode = input.couponCode.trim().toUpperCase();
      if (/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(cleanCode)) {
        couponLookup = await loadCouponForThemeStore(platformDb, cleanCode, input.tenantId);
      }
    }
  }

  const payerType: CouponPayerType = input.agencyId ? "agency" : "tenant";
  const quote = computeThemeStoreCheckoutQuote({
    themeId: theme.id,
    catalogPriceIdr: theme.priceIdr,
    channelCode: normalizedChannel,
    payerType,
    coupon: couponLookup.coupon,
    rawCouponCode: input.couponCode,
    alreadyRedeemedByTenant: couponLookup.alreadyRedeemedByTenant,
    nowMs,
  });

  const orderId = generateBillingUlid(nowMs);
  const providerReffId = generateAutoLarisReffId(nowMs);
  const providerTransactionId = `AL-THM-${orderId.slice(-12)}`;
  const expiresAt = nowMs + DEFAULT_OBLIGATION_TTL_MS;
  const providerAccountId = input.providerAccountId?.trim() || "default";

  const paymentInstructions = buildSandboxStubPaymentInstructions({
    channelCode: quote.channelCode,
    providerTransactionId,
    providerReffId,
    totalPayableIdr: quote.totalPayableIdr,
    expiresAtMs: expiresAt,
  });

  const { statement: auditStmt } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.payerUserId,
    actorRole: input.agencyId ? "agency_admin" : "owner",
    tenantId: input.tenantId,
    action: "theme_store.order.created",
    targetType: "theme_store_order",
    targetId: orderId,
    outcome: "success",
    metadata: {
      themeId: theme.id,
      basePriceIdr: quote.basePriceIdr,
      discountAmountIdr: quote.discountAmountIdr,
      channelCode: quote.channelCode,
      channelFeeIdr: quote.channelFeeIdr,
      totalPayableIdr: quote.totalPayableIdr,
      couponCode: quote.couponCode,
    },
    createdAtMs: nowMs,
  });

  try {
    await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO theme_store_orders (
             id, tenant_id, theme_id, payer_user_id, agency_id, idempotency_key, request_hash,
             status, currency, base_price_idr, coupon_id, coupon_code, discount_amount_idr,
             net_base_amount_idr, channel_code, channel_fee_idr, total_payable_idr,
             provider_account_id, provider_reff_id, provider_transaction_id,
             payment_instructions_json, expires_at, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'IDR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          orderId,
          input.tenantId,
          theme.id,
          input.payerUserId,
          input.agencyId ?? null,
          cleanIdemKey,
          requestHash,
          quote.basePriceIdr,
          quote.couponId,
          quote.couponCode,
          quote.discountAmountIdr,
          quote.netBaseAmountIdr,
          quote.channelCode,
          quote.channelFeeIdr,
          quote.totalPayableIdr,
          providerAccountId,
          providerReffId,
          providerTransactionId,
          JSON.stringify(paymentInstructions),
          expiresAt,
          nowMs,
          nowMs,
        ),
      auditStmt,
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Handle concurrent idempotency_key race or open-order race cleanly (never raw 500)
      const racedByIdem = await platformDb
        .prepare(
          `SELECT * FROM theme_store_orders
           WHERE tenant_id = ? AND idempotency_key = ?
           LIMIT 1`,
        )
        .bind(input.tenantId, cleanIdemKey)
        .first<RawOrderRow>();
      if (racedByIdem) {
        if (racedByIdem.request_hash !== requestHash) {
          throw new BillingConflictError(
            "IDEMPOTENCY_CONFLICT",
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key sudah digunakan untuk parameter checkout tema yang berbeda.",
          );
        }
        return { order: mapOrderRow(racedByIdem), theme, idempotentReplay: true };
      }

      const racedOpen = await platformDb
        .prepare(
          `SELECT id FROM theme_store_orders
           WHERE tenant_id = ? AND theme_id = ? AND status IN ('pending', 'review')
           LIMIT 1`,
        )
        .bind(input.tenantId, theme.id)
        .first<{ readonly id: string }>();
      if (racedOpen) {
        throw new ThemeStoreDomainError(
          409,
          "OPEN_ORDER_EXISTS",
          `Masih ada pesanan pembayaran aktif (${racedOpen.id}) untuk tema "${theme.name}".`,
        );
      }
    }
    throw err;
  }

  const createdRow = await platformDb
    .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
    .bind(orderId, input.tenantId)
    .first<RawOrderRow>();

  if (!createdRow) {
    throw new ThemeStoreDomainError(
      400,
      "THEME_ORDER_NOT_FOUND",
      "Gagal memuat pesanan tema setelah dibuat.",
    );
  }

  return {
    order: mapOrderRow(createdRow),
    theme,
    idempotentReplay: false,
  };
}

/**
 * SANDBOX / STUB payment instruction builder gated strictly before live AutoLaris
 * H2H Create Order (`/submit`) activation. Live QRIS/VA instructions are fetched
 * from the verified AutoLaris relay adapter when `AUTOLARIS_LIVE_ENABLED=true`.
 */
function buildSandboxStubPaymentInstructions(params: {
  readonly channelCode: ThemeStoreChannelCode;
  readonly providerTransactionId: string;
  readonly providerReffId: string;
  readonly totalPayableIdr: number;
  readonly expiresAtMs: number;
}): Record<string, unknown> {
  if (params.channelCode === "QRIS") {
    return {
      mode: "sandbox_stub",
      method: "QRIS",
      qrisPayload: `00020101021226660014ID.PUNYASITUS01189360050300000898240214${params.providerReffId}5204573453033605406${params.totalPayableIdr}5802ID5910PUNYASITUS6007JAKARTA6304ABCD`,
      providerTransactionId: params.providerTransactionId,
      providerReffId: params.providerReffId,
      totalPayableIdr: params.totalPayableIdr,
      expiresAt: new Date(params.expiresAtMs).toISOString(),
    };
  }
  const bankCode = params.channelCode.replace(/^VA_/, "");
  const digits = params.providerReffId.replace(/\D/g, "").padEnd(10, "7").slice(0, 10);
  return {
    mode: "sandbox_stub",
    method: "VA",
    bankName: bankCode,
    virtualAccountNumber: `8801${digits}`,
    providerTransactionId: params.providerTransactionId,
    providerReffId: params.providerReffId,
    totalPayableIdr: params.totalPayableIdr,
    expiresAt: new Date(params.expiresAtMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Atomic AutoLaris Settlement -> Per-Website Entitlement + Numbered PDF Receipt
// ---------------------------------------------------------------------------

export interface SettleThemeStoreOrderInput {
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly payerName: string;
  readonly orderId: string;
  readonly observation: RawAutoLarisAdviceObservation;
  readonly policy?: AdviceSettlementPolicy;
  readonly mediaBucket?: R2Bucket | null;
  readonly nowMs?: number;
}

export interface SettleThemeStoreOrderResult {
  readonly settled: boolean;
  readonly idempotentReplay: boolean;
  readonly decisionKind: "confirmed_paid" | "pending" | "expired" | "failed" | "review";
  readonly safeReasonCode: string;
  readonly order: ThemeStoreOrderRecord;
  readonly entitlement: TenantThemeStoreEntitlementRecord | null;
  readonly receipt: ThemeStoreReceiptRecord | null;
  readonly pdf: GeneratedThemeStoreReceiptPdf | null;
}

export async function settleThemeStoreOrderAtomically(
  platformDb: D1Database,
  input: SettleThemeStoreOrderInput,
): Promise<SettleThemeStoreOrderResult> {
  const nowMs = input.nowMs ?? Date.now();
  const policy = input.policy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY;

  const orderRow = await platformDb
    .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
    .bind(input.orderId, input.tenantId)
    .first<RawOrderRow>();

  if (!orderRow) {
    throw new BillingNotFoundError(
      `Pesanan tema "${input.orderId}" tidak ditemukan untuk situs ini.`,
    );
  }

  const currentOrder = mapOrderRow(orderRow);
  const catalogRow = await platformDb
    .prepare(
      "SELECT id, slug, name, tier, price_idr, active, version, updated_at FROM theme_catalog WHERE id = ? LIMIT 1",
    )
    .bind(currentOrder.themeId)
    .first<RawCatalogRow>();

  const themeName = catalogRow?.name ?? currentOrder.themeId;

  // Idempotent replay: if already settled & paid, NEVER double-grant or bump receipt sequence,
  // and NEVER return settled: true with null entitlement or receipt.
  if (currentOrder.status === "paid") {
    if (!currentOrder.entitlementId || !currentOrder.receiptId) {
      throw new BillingConflictError(
        "CONFLICT",
        "SETTLEMENT_INCONSISTENT",
        "Status pesanan sudah lunas tetapi catatan izin atau kuitansi tidak lengkap.",
      );
    }
    const [entRow, recRow] = await Promise.all([
      platformDb
        .prepare("SELECT * FROM tenant_theme_entitlements WHERE id = ? AND tenant_id = ? LIMIT 1")
        .bind(currentOrder.entitlementId, input.tenantId)
        .first<RawEntitlementRow>(),
      platformDb
        .prepare("SELECT * FROM theme_store_receipts WHERE id = ? AND tenant_id = ? LIMIT 1")
        .bind(currentOrder.receiptId, input.tenantId)
        .first<RawReceiptRow>(),
    ]);
    if (!entRow || !recRow) {
      throw new BillingConflictError(
        "CONFLICT",
        "SETTLEMENT_INCONSISTENT",
        "Catatan izin tema atau kuitansi untuk pesanan lunas ini tidak ditemukan.",
      );
    }
    return {
      settled: true,
      idempotentReplay: true,
      decisionKind: "confirmed_paid",
      safeReasonCode: "SETTLEMENT_CONFIRMED",
      order: currentOrder,
      entitlement: mapEntitlementRow(entRow),
      receipt: mapReceiptRow(recRow),
      pdf: null,
    };
  }

  // Already terminal non-paid orders cannot be settled again.
  if (currentOrder.status === "expired" || currentOrder.status === "failed") {
    return {
      settled: false,
      idempotentReplay: false,
      decisionKind: currentOrder.status === "expired" ? "expired" : "failed",
      safeReasonCode: currentOrder.safeFailureCode ?? "ORDER_TERMINAL",
      order: currentOrder,
      entitlement: null,
      receipt: null,
      pdf: null,
    };
  }

  // Pre-check: if `(tenant_id, theme_id)` ALREADY has an active entitlement (e.g. from another
  // order or console grant), fail cleanly with 409 BEFORE touching the receipt sequence counter.
  const preExistingEntitlement = await platformDb
    .prepare(
      "SELECT id FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
    )
    .bind(input.tenantId, currentOrder.themeId)
    .first<{ readonly id: string }>();

  if (preExistingEntitlement) {
    throw new ThemeStoreDomainError(
      409,
      "THEME_ALREADY_OWNED",
      `Tema "${currentOrder.themeId}" sudah memiliki izin aktif untuk situs ini.`,
      [
        {
          field: "themeId",
          code: "THEME_ALREADY_OWNED",
          message: `Tenant "${input.tenantId}" already owns theme "${currentOrder.themeId}".`,
        },
      ],
    );
  }

  // Verify AutoLaris Advice settlement observation using canonical billing policy!
  const decision = evaluateAdviceSettlement({
    expectedProviderTransactionId: currentOrder.providerTransactionId ?? currentOrder.providerReffId,
    expectedReffId: currentOrder.providerReffId,
    expectedTotalPayableIdr: currentOrder.totalPayableIdr,
    expectedCurrency: BILLING_CURRENCY,
    observation: input.observation,
    policy,
    nowMs,
  });

  if (decision.kind !== "confirmed_paid") {
    // NEVER terminalize to failed/expired on unverified policy; only allow terminal transition
    // when server-verified Advice policy allows settlement verification or server clock expired.
    let nextStatus: ThemeStoreOrderRecord["status"];
    if (decision.kind === "pending") {
      nextStatus = currentOrder.status === "review" ? "review" : "pending";
    } else if (decision.kind === "expired") {
      nextStatus =
        policy.allowSettlementGrant || nowMs >= currentOrder.expiresAtMs ? "expired" : "review";
    } else if (decision.kind === "failed") {
      nextStatus = policy.allowSettlementGrant ? "failed" : "review";
    } else {
      nextStatus = "review";
    }

    await platformDb
      .prepare(
        `UPDATE theme_store_orders
         SET status = ?, safe_failure_code = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')`,
      )
      .bind(nextStatus, decision.safeReasonCode, nowMs, currentOrder.id, input.tenantId)
      .run();

    const updated = await platformDb
      .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
      .bind(currentOrder.id, input.tenantId)
      .first<RawOrderRow>();

    return {
      settled: false,
      idempotentReplay: false,
      decisionKind: nextStatus === "review" ? "review" : decision.kind,
      safeReasonCode: decision.safeReasonCode,
      order: updated ? mapOrderRow(updated) : currentOrder,
      entitlement: null,
      receipt: null,
      pdf: null,
    };
  }

  // Pre-check coupon availability BEFORE allocating a receipt number.
  if (currentOrder.couponId) {
    const couponRow = await platformDb
      .prepare(
        "SELECT id, active, max_redemptions, redeemed_count FROM promo_coupons WHERE id = ? LIMIT 1",
      )
      .bind(currentOrder.couponId)
      .first<{
        readonly id: string;
        readonly active: number;
        readonly max_redemptions: number | null;
        readonly redeemed_count: number;
      }>();

    if (
      !couponRow ||
      couponRow.active !== 1 ||
      (couponRow.max_redemptions !== null &&
        Number(couponRow.redeemed_count) >= Number(couponRow.max_redemptions))
    ) {
      await platformDb
        .prepare(
          `UPDATE theme_store_orders
           SET status = 'review', safe_failure_code = 'COUPON_EXHAUSTED', version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')`,
        )
        .bind(nowMs, currentOrder.id, input.tenantId)
        .run();

      throw new ThemeStoreDomainError(
        409,
        "COUPON_EXHAUSTED",
        "Kuota kupon promo sudah habis sebelum penyelesaian pembayaran. Pesanan ditandai untuk peninjauan.",
        [
          {
            field: "couponCode",
            code: "COUPON_EXHAUSTED",
            message: `Coupon "${currentOrder.couponCode ?? currentOrder.couponId}" is exhausted or inactive.`,
          },
        ],
      );
    }
  }

  // Confirmed paid settlement! Always anchor timestamps & fiscal year to server `nowMs`.
  const settledAtMs = nowMs;
  const receiptYear = getWibYearFromEpochMs(nowMs);
  const entitlementId = generateBillingUlid(nowMs);
  const receiptId = generateBillingUlid(nowMs + 1);
  const couponId = currentOrder.couponId;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Re-check for concurrent settlement replay
    const freshOrder = await platformDb
      .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
      .bind(currentOrder.id, input.tenantId)
      .first<RawOrderRow>();

    if (freshOrder && freshOrder.status === "paid") {
      if (!freshOrder.entitlement_id || !freshOrder.receipt_id) {
        throw new BillingConflictError(
          "CONFLICT",
          "SETTLEMENT_INCONSISTENT",
          "Status pesanan sudah lunas tetapi catatan izin atau kuitansi tidak lengkap.",
        );
      }
      const [entRow, recRow] = await Promise.all([
        platformDb
          .prepare("SELECT * FROM tenant_theme_entitlements WHERE id = ? AND tenant_id = ? LIMIT 1")
          .bind(freshOrder.entitlement_id, input.tenantId)
          .first<RawEntitlementRow>(),
        platformDb
          .prepare("SELECT * FROM theme_store_receipts WHERE id = ? AND tenant_id = ? LIMIT 1")
          .bind(freshOrder.receipt_id, input.tenantId)
          .first<RawReceiptRow>(),
      ]);
      if (!entRow || !recRow) {
        throw new BillingConflictError(
          "CONFLICT",
          "SETTLEMENT_INCONSISTENT",
          "Catatan izin tema atau kuitansi untuk pesanan lunas ini tidak ditemukan.",
        );
      }
      return {
        settled: true,
        idempotentReplay: true,
        decisionKind: "confirmed_paid",
        safeReasonCode: "SETTLEMENT_CONFIRMED",
        order: mapOrderRow(freshOrder),
        entitlement: mapEntitlementRow(entRow),
        receipt: mapReceiptRow(recRow),
        pdf: null,
      };
    }

    // Re-check existing entitlement for `(tenant_id, theme_id)` before touching sequence counter
    const concurrentEntitlement = await platformDb
      .prepare(
        "SELECT id FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
      )
      .bind(input.tenantId, currentOrder.themeId)
      .first<{ readonly id: string }>();

    if (concurrentEntitlement) {
      throw new ThemeStoreDomainError(
        409,
        "THEME_ALREADY_OWNED",
        `Tema "${currentOrder.themeId}" sudah memiliki izin aktif untuk situs ini.`,
      );
    }

    const counterRow = await platformDb
      .prepare("SELECT year, last_seq FROM theme_store_receipt_counters WHERE year = ? LIMIT 1")
      .bind(receiptYear)
      .first<{ readonly year: number; readonly last_seq: number }>();

    const expectedSeq = counterRow ? Number(counterRow.last_seq) : 0;
    const nextSeq = expectedSeq + 1;
    const receiptNumber = formatThemeReceiptNumber(receiptYear, nextSeq);

    const pdf = await generateThemeStoreReceiptPdf({
      receiptNumber,
      issuedAtMs: settledAtMs,
      tenantName: input.tenantName,
      tenantHandle: input.tenantHandle,
      payerName: input.payerName,
      themeId: currentOrder.themeId,
      themeName,
      orderId: currentOrder.id,
      baseAmountIdr: currentOrder.basePriceIdr,
      discountAmountIdr: currentOrder.discountAmountIdr,
      channelFeeIdr: currentOrder.channelFeeIdr,
      totalAmountIdr: currentOrder.totalPayableIdr,
      couponCode: currentOrder.couponCode,
      paymentChannel: currentOrder.channelCode,
      providerReference: decision.providerTransactionId,
      nonPkpNotice: RECEIPT_NON_PKP_NOTICE,
    });

    const batch: D1PreparedStatement[] = [];

    // 1. Allocate yearly sequence atomically (CAS) ONLY when:
    //    - Order is in ('pending', 'review')
    //    - Tenant does NOT already own `(tenant_id, theme_id)` (zero burned sequence!)
    //    - If coupon_id is present, coupon is STILL active & under max_redemptions (zero burned sequence!)
    const couponGuardSql = couponId
      ? ` AND EXISTS (
           SELECT 1 FROM promo_coupons
           WHERE id = ? AND active = 1
             AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
         )`
      : "";

    if (counterRow) {
      const bindArgs: unknown[] = [
        nextSeq,
        nowMs,
        receiptYear,
        expectedSeq,
        currentOrder.id,
        input.tenantId,
        input.tenantId,
        currentOrder.themeId,
      ];
      if (couponId) bindArgs.push(couponId);
      batch.push(
        platformDb
          .prepare(
            `UPDATE theme_store_receipt_counters
             SET last_seq = ?, updated_at = ?
             WHERE year = ? AND last_seq = ?
               AND EXISTS (
                 SELECT 1 FROM theme_store_orders
                 WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM tenant_theme_entitlements
                 WHERE tenant_id = ? AND theme_id = ?
               )${couponGuardSql}`,
          )
          .bind(...bindArgs),
      );
    } else {
      const bindArgs: unknown[] = [
        receiptYear,
        nextSeq,
        nowMs,
        receiptYear,
        currentOrder.id,
        input.tenantId,
        input.tenantId,
        currentOrder.themeId,
      ];
      if (couponId) bindArgs.push(couponId);
      batch.push(
        platformDb
          .prepare(
            `INSERT INTO theme_store_receipt_counters (year, last_seq, updated_at)
             SELECT ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM theme_store_receipt_counters WHERE year = ?)
               AND EXISTS (
                 SELECT 1 FROM theme_store_orders
                 WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM tenant_theme_entitlements
                 WHERE tenant_id = ? AND theme_id = ?
               )${couponGuardSql}`,
          )
          .bind(...bindArgs),
      );
    }

    // 2. Grant per-website entitlement ONLY if counter allocation succeeded (`changes() = 1`)
    batch.push(
      platformDb
        .prepare(
          `INSERT INTO tenant_theme_entitlements (id, tenant_id, theme_id, granted_by, settlement_id, granted_at)
           SELECT ?, ?, ?, 'theme_store_autolaris', NULL, ?
           WHERE changes() = 1
             AND NOT EXISTS (
               SELECT 1 FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ?
             )`,
        )
        .bind(
          entitlementId,
          input.tenantId,
          currentOrder.themeId,
          settledAtMs,
          input.tenantId,
          currentOrder.themeId,
        ),
    );

    // 3. Insert immutable numbered receipt row with immutable tenant/payer name snapshots
    batch.push(
      platformDb
        .prepare(
          `INSERT INTO theme_store_receipts (
             id, receipt_number, tenant_id, tenant_name_snapshot, payer_name_snapshot,
             theme_id, order_id, entitlement_id, payer_user_id,
             currency, base_amount_idr, discount_amount_idr, channel_fee_idr, total_amount_idr,
             coupon_code, payment_channel, provider_reference, r2_object_key, pdf_sha256,
             pdf_byte_length, non_pkp_notice, issued_at, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM tenant_theme_entitlements WHERE id = ? AND tenant_id = ?
           )`,
        )
        .bind(
          receiptId,
          pdf.receiptNumber,
          input.tenantId,
          input.tenantName,
          input.payerName,
          currentOrder.themeId,
          currentOrder.id,
          entitlementId,
          currentOrder.payerUserId,
          currentOrder.basePriceIdr,
          currentOrder.discountAmountIdr,
          currentOrder.channelFeeIdr,
          currentOrder.totalPayableIdr,
          currentOrder.couponCode,
          currentOrder.channelCode,
          decision.providerTransactionId,
          pdf.r2ObjectKey,
          pdf.sha256Hex,
          pdf.byteLength,
          pdf.nonPkpNotice,
          settledAtMs,
          nowMs,
          entitlementId,
          input.tenantId,
        ),
    );

    // 4. Mark order `paid` (supporting both `pending -> paid` and `review -> paid`)
    batch.push(
      platformDb
        .prepare(
          `UPDATE theme_store_orders
           SET status = 'paid',
               provider_transaction_id = ?,
               settled_at = ?,
               entitlement_id = ?,
               receipt_id = ?,
               safe_failure_code = NULL,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')
             AND EXISTS (
               SELECT 1 FROM theme_store_receipts WHERE id = ? AND order_id = ?
             )`,
        )
        .bind(
          decision.providerTransactionId,
          settledAtMs,
          entitlementId,
          receiptId,
          nowMs,
          currentOrder.id,
          input.tenantId,
          receiptId,
          currentOrder.id,
        ),
    );

    // 5. Atomically increment promo_coupons.redeemed_count ONLY when order transitioned to paid
    if (couponId) {
      batch.push(
        platformDb
          .prepare(
            `UPDATE promo_coupons
             SET redeemed_count = redeemed_count + 1,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND active = 1
               AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
               AND EXISTS (
                 SELECT 1 FROM theme_store_orders
                 WHERE id = ? AND status = 'paid' AND receipt_id = ?
               )`,
          )
          .bind(nowMs, couponId, currentOrder.id, receiptId),
      );
    }

    const results = await platformDb.batch(batch);
    const counterChanges = Number(results[0]?.meta?.changes ?? 0);
    const entChanges = Number(results[1]?.meta?.changes ?? 0);
    const recChanges = Number(results[2]?.meta?.changes ?? 0);
    const orderChanges = Number(results[3]?.meta?.changes ?? 0);
    const couponChanges = couponId ? Number(results[4]?.meta?.changes ?? 0) : 1;

    if (counterChanges === 1) {
      if (entChanges !== 1 || recChanges !== 1 || orderChanges !== 1 || couponChanges !== 1) {
        throw new BillingConflictError(
          "CONFLICT",
          "SETTLEMENT_INCONSISTENT",
          "Settlement tema gagal diverifikasi secara atomik. Silakan periksa catatan audit.",
        );
      }

      const [finalOrderRow, finalEntRow, finalRecRow] = await Promise.all([
        platformDb
          .prepare("SELECT * FROM theme_store_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
          .bind(currentOrder.id, input.tenantId)
          .first<RawOrderRow>(),
        platformDb
          .prepare("SELECT * FROM tenant_theme_entitlements WHERE id = ? AND tenant_id = ? LIMIT 1")
          .bind(entitlementId, input.tenantId)
          .first<RawEntitlementRow>(),
        platformDb
          .prepare("SELECT * FROM theme_store_receipts WHERE id = ? AND tenant_id = ? LIMIT 1")
          .bind(receiptId, input.tenantId)
          .first<RawReceiptRow>(),
      ]);

      if (!finalOrderRow || finalOrderRow.status !== "paid" || !finalEntRow || !finalRecRow) {
        throw new BillingConflictError(
          "CONFLICT",
          "SETTLEMENT_INCONSISTENT",
          "Catatan izin tema atau kuitansi tidak lengkap setelah settlement.",
        );
      }

      // Append platform audit ONLY after settlement commit is verified
      await buildPlatformAuditStatement(platformDb, {
        actorUserId: currentOrder.payerUserId,
        actorRole: currentOrder.agencyId ? "agency_admin" : "owner",
        tenantId: input.tenantId,
        action: "theme_store.order.settled",
        targetType: "theme_store_order",
        targetId: currentOrder.id,
        outcome: "success",
        metadata: {
          themeId: currentOrder.themeId,
          entitlementId,
          receiptId,
          receiptNumber: pdf.receiptNumber,
          totalPayableIdr: currentOrder.totalPayableIdr,
          providerTransactionId: decision.providerTransactionId,
        },
        createdAtMs: nowMs,
      }).statement.run();

      if (input.mediaBucket) {
        await input.mediaBucket.put(pdf.r2ObjectKey, pdf.bytes, {
          httpMetadata: {
            contentType: "application/pdf",
            cacheControl: "private, no-store",
          },
          customMetadata: {
            receiptNumber: pdf.receiptNumber,
            tenantId: input.tenantId,
            themeId: currentOrder.themeId,
            sha256: pdf.sha256Hex,
          },
        });
      }

      return {
        settled: true,
        idempotentReplay: false,
        decisionKind: "confirmed_paid",
        safeReasonCode: "SETTLEMENT_CONFIRMED",
        order: mapOrderRow(finalOrderRow),
        entitlement: mapEntitlementRow(finalEntRow),
        receipt: mapReceiptRow(finalRecRow),
        pdf,
      };
    }

    // Counter CAS updated 0 rows: diagnose whether coupon became exhausted concurrently before retrying.
    if (couponId) {
      const couponAfter = await platformDb
        .prepare(
          "SELECT active, max_redemptions, redeemed_count FROM promo_coupons WHERE id = ? LIMIT 1",
        )
        .bind(couponId)
        .first<{
          readonly active: number;
          readonly max_redemptions: number | null;
          readonly redeemed_count: number;
        }>();
      if (
        !couponAfter ||
        couponAfter.active !== 1 ||
        (couponAfter.max_redemptions !== null &&
          Number(couponAfter.redeemed_count) >= Number(couponAfter.max_redemptions))
      ) {
        await platformDb
          .prepare(
            `UPDATE theme_store_orders
             SET status = 'review', safe_failure_code = 'COUPON_EXHAUSTED', version = version + 1, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'review')`,
          )
          .bind(nowMs, currentOrder.id, input.tenantId)
          .run();
        throw new ThemeStoreDomainError(
          409,
          "COUPON_EXHAUSTED",
          "Kuota kupon promo sudah habis sebelum penyelesaian pembayaran. Pesanan ditandai untuk peninjauan.",
        );
      }
    }
  }

  throw new BillingConflictError(
    "CONFLICT",
    "SETTLEMENT_CONTENTION",
    "Terjadi persaingan saat menerbitkan kuitansi tema. Silakan coba verifikasi ulang.",
  );
}

export async function getTenantThemeStoreReceiptById(
  platformDb: D1Database,
  tenantId: string,
  receiptIdOrNumber: string,
): Promise<{
  readonly receipt: ThemeStoreReceiptRecord;
  readonly themeName: string;
} | null> {
  const key = receiptIdOrNumber.trim();
  if (!key) return null;

  const row = await platformDb
    .prepare(
      `SELECT r.*, tc.name AS theme_name
       FROM theme_store_receipts r
       LEFT JOIN theme_catalog tc ON tc.id = r.theme_id
       WHERE r.tenant_id = ?
         AND (r.id = ? OR r.receipt_number = ? OR r.order_id = ?)
       LIMIT 1`,
    )
    .bind(tenantId, key, key, key)
    .first<RawReceiptRow & { readonly theme_name: string | null }>();

  if (!row) return null;
  return {
    receipt: mapReceiptRow(row),
    themeName: row.theme_name ?? row.theme_id,
  };
}

// ---------------------------------------------------------------------------
// Atomic Style Variant & Commercial Theme Activation in `TenantStore`
// ---------------------------------------------------------------------------

interface RawSiteSettingsRow {
  readonly id: number;
  readonly site_title: string;
  readonly tagline: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly active_theme_id: string;
  readonly favicon_media_id: number | null;
  readonly og_image_media_id: number | null;
  readonly blog_enabled: number;
  readonly catalog_enabled: number;
  readonly ai_training_policy: "allow" | "disallow";
  readonly analytics_config_json: string | null;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawThemeConfigRow {
  readonly theme_id: string;
  readonly tokens_json: string;
  readonly variants_json: string;
  readonly style_variant_id?: string | null;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

async function themeConfigsHasStyleVariantColumn(tenantDb: D1Database): Promise<boolean> {
  try {
    const info = await tenantDb
      .prepare("PRAGMA table_info(theme_configs)")
      .all<{ readonly name: string }>();
    return info.results.some((col) => col.name === "style_variant_id");
  } catch {
    return false;
  }
}

export async function loadTenantActiveStyleVariantId(
  tenantDb: D1Database,
  themeId: string,
): Promise<string> {
  const hasCol = await themeConfigsHasStyleVariantColumn(tenantDb);
  const row = await tenantDb
    .prepare(
      hasCol
        ? "SELECT style_variant_id, variants_json FROM theme_configs WHERE theme_id = ? LIMIT 1"
        : "SELECT variants_json FROM theme_configs WHERE theme_id = ? LIMIT 1",
    )
    .bind(themeId)
    .first<{ readonly style_variant_id?: string | null; readonly variants_json: string }>();

  if (row?.style_variant_id && row.style_variant_id !== "default") {
    return row.style_variant_id;
  }
  if (row?.variants_json) {
    try {
      const parsed = JSON.parse(row.variants_json) as { readonly styleVariant?: unknown };
      if (typeof parsed.styleVariant === "string" && parsed.styleVariant !== "default") {
        return parsed.styleVariant;
      }
    } catch {
      // fallback below
    }
  }
  return getDefaultStyleVariantForTheme(themeId)?.styleVariantKey ?? "default";
}

export interface ActivateStoreThemeOrVariantParams {
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly themeId: string;
  readonly styleVariantId?: string | null;
  readonly fallbackTokens?: ThemeTokens;
  readonly fallbackVariants?: ThemeVariants;
  readonly expectedVersion: number;
  readonly nowMs?: number;
}

export interface ActivateStoreThemeOrVariantResult {
  readonly activatedThemeId: string;
  readonly previousThemeId: string;
  readonly activeStyleVariantId: string;
  readonly appliedVariant: ThemeStyleVariantDefinition | null;
  readonly tokens: ThemeTokens;
  readonly variants: ThemeVariants;
  readonly version: number;
  readonly cacheVersion: number;
  readonly activatedAt: string;
}

/**
 * Atomically activates an entitled theme (`included`, `paid_once`, or `custom`) and/or applies
 * a WCAG-AA-verified Style Variant inside `TenantStore` + bumps `PLATFORM_DB.tenants.cache_version`.
 *
 * Guarantees:
 * - Strict entitlement check BEFORE any write (`403 THEME_NOT_ENTITLED` for unpurchased `paid_once`).
 * - Optimistic concurrency (`409 STALE_VERSION` on mismatch).
 * - ZERO mutations or deletions on `pages`, `posts`, `offerings`, `menus`, `media_items` (0% content loss).
 * - Previous theme's `theme_configs` row stays intact and recoverable.
 */
export async function activateStoreThemeOrVariantAtomically(
  params: ActivateStoreThemeOrVariantParams,
): Promise<ActivateStoreThemeOrVariantResult> {
  const nowMs = params.nowMs ?? Date.now();

  // 1. Strict server-side per-website entitlement check BEFORE any TenantStore write!
  await assertTenantThemeEntitled(params.platformDb, params.tenantId, params.themeId);

  // 2. Resolve optional Style Variant (or default variant for this theme)
  let resolvedVariant: ThemeStyleVariantDefinition | null = null;
  if (params.styleVariantId && params.styleVariantId.trim()) {
    resolvedVariant = getStyleVariantById(params.themeId, params.styleVariantId);
    if (!resolvedVariant) {
      throw new ThemeStoreDomainError(
        422,
        "THEME_VARIANT_NOT_FOUND",
        `Varian gaya "${params.styleVariantId}" tidak ditemukan untuk tema "${params.themeId}".`,
        [
          {
            field: "styleVariantId",
            code: "THEME_VARIANT_NOT_FOUND",
            message: `Unknown style variant "${params.styleVariantId}" for theme "${params.themeId}".`,
          },
        ],
      );
    }
  }

  const [priorSiteRow, priorTargetThemeRow, hasStyleVariantCol] = await Promise.all([
    params.tenantDb
      .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
      .first<RawSiteSettingsRow>(),
    params.tenantDb
      .prepare("SELECT * FROM theme_configs WHERE theme_id = ? LIMIT 1")
      .bind(params.themeId)
      .first<RawThemeConfigRow>(),
    themeConfigsHasStyleVariantColumn(params.tenantDb),
  ]);

  const currentSiteVersion = priorSiteRow ? Number(priorSiteRow.version) : 0;
  if (params.expectedVersion !== currentSiteVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: params.expectedVersion,
      actualVersion: currentSiteVersion,
    });
  }

  const previousThemeId = priorSiteRow?.active_theme_id ?? "compro";
  const nextSiteVersion = currentSiteVersion + 1;

  // Recover existing published tokens/variants if no explicit styleVariantId was requested
  let recoveredTokens: ThemeTokens | null = null;
  let recoveredVariants: ThemeVariants | null = null;
  if (!resolvedVariant && priorTargetThemeRow) {
    try {
      recoveredTokens = ThemeTokensSchema.parse(JSON.parse(priorTargetThemeRow.tokens_json));
      recoveredVariants = ThemeVariantsSchema.parse(JSON.parse(priorTargetThemeRow.variants_json));
    } catch {
      recoveredTokens = null;
      recoveredVariants = null;
    }
  }

  const defaultVariant = getDefaultStyleVariantForTheme(params.themeId);
  const effectiveTokens: ThemeTokens =
    resolvedVariant?.tokens ??
    recoveredTokens ??
    params.fallbackTokens ??
    defaultVariant?.tokens ??
    ThemeTokensSchema.parse({
      primaryColor: "#176b51",
      secondaryColor: "#0f4c5c",
    });

  const effectiveVariants: ThemeVariants =
    resolvedVariant?.variants ??
    recoveredVariants ??
    params.fallbackVariants ??
    defaultVariant?.variants ??
    ThemeVariantsSchema.parse({ styleVariant: "default" });

  const effectiveStyleVariantId =
    resolvedVariant?.styleVariantKey ??
    (effectiveVariants.styleVariant !== "default"
      ? effectiveVariants.styleVariant
      : defaultVariant?.styleVariantKey ?? "default");

  const nextPublishedSiteData = {
    siteTitle: priorSiteRow?.site_title || params.tenantName,
    tagline: priorSiteRow?.tagline ?? null,
    timezone: priorSiteRow?.timezone || "Asia/Jakarta",
    locale: priorSiteRow?.locale || "id-ID",
    activeThemeId: params.themeId,
    faviconMediaId: priorSiteRow?.favicon_media_id ?? null,
    ogImageMediaId: priorSiteRow?.og_image_media_id ?? null,
    blogEnabled: priorSiteRow ? priorSiteRow.blog_enabled === 1 : true,
    catalogEnabled: priorSiteRow ? priorSiteRow.catalog_enabled === 1 : true,
    aiTrainingPolicy:
      priorSiteRow?.ai_training_policy === "disallow" ? ("disallow" as const) : ("allow" as const),
    analyticsConfig: safeParseObjectJson(priorSiteRow?.analytics_config_json),
  };

  const siteEnvelope = {
    snapshotVersion: 1 as const,
    resourceType: "site_settings" as const,
    data: nextPublishedSiteData,
    publishedAt: priorSiteRow?.published_at ?? nowMs,
    contentModifiedAt: nowMs,
  };
  const sitePublishedJson = JSON.stringify(siteEnvelope);

  const themeEnvelope = {
    snapshotVersion: 1 as const,
    resourceType: "theme_config" as const,
    data: {
      themeId: params.themeId,
      tokens: effectiveTokens,
      variants: effectiveVariants,
    },
    publishedAt: nowMs,
    contentModifiedAt: nowMs,
  };
  const themePublishedJson = JSON.stringify(themeEnvelope);
  const tokensJson = JSON.stringify(effectiveTokens);
  const variantsJson = JSON.stringify(effectiveVariants);

  const statements: D1PreparedStatement[] = [];

  if (priorSiteRow) {
    statements.push(
      params.tenantDb
        .prepare(
          `UPDATE site_settings
           SET active_theme_id = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1 AND version = ?`,
        )
        .bind(
          params.themeId,
          sitePublishedJson,
          siteEnvelope.publishedAt,
          siteEnvelope.contentModifiedAt,
          nowMs,
          currentSiteVersion,
        ),
    );
  } else {
    statements.push(
      params.tenantDb
        .prepare(
          `INSERT INTO site_settings
             (id, site_title, tagline, timezone, locale, active_theme_id, blog_enabled, catalog_enabled,
              ai_training_policy, draft_json, published_json, published_at, content_modified_at, version, updated_at)
           SELECT 1, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE id = 1)`,
        )
        .bind(
          nextPublishedSiteData.siteTitle,
          nextPublishedSiteData.timezone,
          nextPublishedSiteData.locale,
          params.themeId,
          nextPublishedSiteData.blogEnabled ? 1 : 0,
          nextPublishedSiteData.catalogEnabled ? 1 : 0,
          nextPublishedSiteData.aiTrainingPolicy,
          sitePublishedJson,
          siteEnvelope.publishedAt,
          siteEnvelope.contentModifiedAt,
          nowMs,
        ),
    );
  }

  if (priorTargetThemeRow) {
    statements.push(
      hasStyleVariantCol
        ? params.tenantDb
            .prepare(
              `UPDATE theme_configs
               SET tokens_json = ?,
                   variants_json = ?,
                   style_variant_id = ?,
                   published_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE theme_id = ? AND changes() = 1`,
            )
            .bind(
              tokensJson,
              variantsJson,
              effectiveStyleVariantId,
              themePublishedJson,
              nowMs,
              params.themeId,
            )
        : params.tenantDb
            .prepare(
              `UPDATE theme_configs
               SET tokens_json = ?,
                   variants_json = ?,
                   published_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE theme_id = ? AND changes() = 1`,
            )
            .bind(tokensJson, variantsJson, themePublishedJson, nowMs, params.themeId),
    );
  } else {
    statements.push(
      hasStyleVariantCol
        ? params.tenantDb
            .prepare(
              `INSERT INTO theme_configs
                 (theme_id, tokens_json, variants_json, style_variant_id, draft_json, published_json, version, updated_at)
               SELECT ?, ?, ?, ?, NULL, ?, 1, ?
               WHERE changes() = 1`,
            )
            .bind(
              params.themeId,
              tokensJson,
              variantsJson,
              effectiveStyleVariantId,
              themePublishedJson,
              nowMs,
            )
        : params.tenantDb
            .prepare(
              `INSERT INTO theme_configs
                 (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
               SELECT ?, ?, ?, NULL, ?, 1, ?
               WHERE changes() = 1`,
            )
            .bind(params.themeId, tokensJson, variantsJson, themePublishedJson, nowMs),
    );
  }

  const activitySummary = resolvedVariant
    ? `Varian gaya "${resolvedVariant.name}" pada tema "${params.themeId}" diaktifkan tanpa mengubah konten.`
    : `Tema "${params.themeId}" diaktifkan (sebelumnya "${previousThemeId}") tanpa mengubah konten.`;

  statements.push(
    params.tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log
           (actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at)
         SELECT ?, ?, 'theme.variant.applied', 'site_settings', '1', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND version = ? AND active_theme_id = ?)`,
      )
      .bind(
        params.actorUserId,
        params.actorRole,
        activitySummary,
        JSON.stringify({
          previousThemeId,
          nextThemeId: params.themeId,
          styleVariantId: effectiveStyleVariantId,
        }),
        nowMs,
        nextSiteVersion,
        params.themeId,
      ),
  );

  const batchResults = await params.tenantDb.batch(statements);
  if (Number(batchResults[0]?.meta?.changes ?? 0) !== 1) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: params.expectedVersion,
      actualVersion: currentSiteVersion + 1,
    });
  }

  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(params.platformDb, params.tenantId, nowMs);
  } catch (err) {
    throw new PublicationAtomicError(
      "Gagal menaikkan versi cache setelah mengaktifkan tema/varian.",
      { compensated: false, cause: err },
    );
  }

  return {
    activatedThemeId: params.themeId,
    previousThemeId,
    activeStyleVariantId: effectiveStyleVariantId,
    appliedVariant: resolvedVariant,
    tokens: effectiveTokens,
    variants: effectiveVariants,
    version: nextSiteVersion,
    cacheVersion,
    activatedAt: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console Operator Overview & Entitlement Management
// ---------------------------------------------------------------------------

export interface ConsoleThemeStoreOverview {
  readonly catalog: readonly ThemeStoreCatalogRow[];
  readonly entitlements: readonly (TenantThemeStoreEntitlementRecord & {
    readonly tenantHandle: string | null;
    readonly themeName: string | null;
    readonly tier: StoreThemeTier | null;
  })[];
  readonly recentOrders: readonly ThemeStoreOrderRecord[];
  readonly recentReceipts: readonly ThemeStoreReceiptRecord[];
}

export async function listConsoleThemeStoreOverview(
  platformDb: D1Database,
): Promise<ConsoleThemeStoreOverview> {
  const catalog = await listThemeStoreCatalogEntries(platformDb, { includeInactive: true });

  const entRows = await platformDb
    .prepare(
      `SELECT tte.id, tte.tenant_id, tte.theme_id, tte.granted_by, tte.settlement_id, tte.granted_at,
              t.handle AS tenant_handle, tc.name AS theme_name, tc.tier AS tier
       FROM tenant_theme_entitlements tte
       LEFT JOIN tenants t ON t.id = tte.tenant_id
       LEFT JOIN theme_catalog tc ON tc.id = tte.theme_id
       ORDER BY tte.granted_at DESC
       LIMIT 100`,
    )
    .all<
      RawEntitlementRow & {
        readonly tenant_handle: string | null;
        readonly theme_name: string | null;
        readonly tier: StoreThemeTier | null;
      }
    >();

  let recentOrders: ThemeStoreOrderRecord[] = [];
  let recentReceipts: ThemeStoreReceiptRecord[] = [];
  try {
    const [orderRows, receiptRows] = await Promise.all([
      platformDb
        .prepare("SELECT * FROM theme_store_orders ORDER BY created_at DESC LIMIT 50")
        .all<RawOrderRow>(),
      platformDb
        .prepare("SELECT * FROM theme_store_receipts ORDER BY issued_at DESC LIMIT 50")
        .all<RawReceiptRow>(),
    ]);
    recentOrders = orderRows.results.map(mapOrderRow);
    recentReceipts = receiptRows.results.map(mapReceiptRow);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  return {
    catalog,
    entitlements: entRows.results.map((r) => ({
      ...mapEntitlementRow(r),
      tenantHandle: r.tenant_handle,
      themeName: r.theme_name,
      tier: r.tier,
    })),
    recentOrders,
    recentReceipts,
  };
}

export async function consoleGrantTenantThemeEntitlement(
  platformDb: D1Database,
  input: {
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly tenantId: string;
    readonly themeId: string;
    readonly reason: string;
    readonly nowMs?: number;
  },
): Promise<{ readonly entitlement: TenantThemeStoreEntitlementRecord; readonly created: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new ThemeStoreDomainError(
      422,
      "VALIDATION_ERROR",
      "Alasan pemberian akses tema minimal 5 karakter.",
    );
  }

  const [tenantRow, themeRow] = await Promise.all([
    platformDb
      .prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1")
      .bind(input.tenantId)
      .first<{ readonly id: string }>(),
    platformDb
      .prepare("SELECT id, tier, active FROM theme_catalog WHERE id = ? LIMIT 1")
      .bind(input.themeId)
      .first<{ readonly id: string; readonly tier: StoreThemeTier; readonly active: number }>(),
  ]);

  if (!tenantRow) {
    throw new ThemeStoreDomainError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }
  if (!themeRow || themeRow.active !== 1) {
    throw new ThemeNotFoundError(input.themeId);
  }
  if (themeRow.tier === "included") {
    throw new ThemeStoreDomainError(
      422,
      "THEME_GRANT_NOT_APPLICABLE",
      `Tema "${input.themeId}" sudah termasuk gratis untuk semua situs dan tidak memerlukan izin manual.`,
      [
        {
          field: "themeId",
          code: "THEME_GRANT_NOT_APPLICABLE",
          message: `Included theme "${input.themeId}" does not require a manual entitlement grant.`,
        },
      ],
    );
  }

  const existing = await platformDb
    .prepare(
      "SELECT * FROM tenant_theme_entitlements WHERE tenant_id = ? AND theme_id = ? LIMIT 1",
    )
    .bind(input.tenantId, input.themeId)
    .first<RawEntitlementRow>();

  if (existing) {
    return { entitlement: mapEntitlementRow(existing), created: false };
  }

  const grantId = generateBillingUlid(nowMs);
  await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO tenant_theme_entitlements (id, tenant_id, theme_id, granted_by, settlement_id, granted_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .bind(grantId, input.tenantId, input.themeId, input.actorUserId, nowMs),
    buildPlatformAuditStatement(platformDb, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      tenantId: input.tenantId,
      action: "console.theme_store.entitlement.granted",
      targetType: "tenant_theme_entitlement",
      targetId: grantId,
      reason,
      outcome: "success",
      metadata: {
        tenantId: input.tenantId,
        themeId: input.themeId,
        tier: themeRow.tier,
      },
      createdAtMs: nowMs,
    }).statement,
  ]);

  const created = await platformDb
    .prepare("SELECT * FROM tenant_theme_entitlements WHERE id = ? LIMIT 1")
    .bind(grantId)
    .first<RawEntitlementRow>();

  if (!created) {
    throw new ThemeStoreDomainError(400, "NOT_FOUND", "Gagal membuat izin tema tenant.");
  }

  return { entitlement: mapEntitlementRow(created), created: true };
}
