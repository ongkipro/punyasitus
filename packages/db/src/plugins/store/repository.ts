import {
  DEFAULT_PRODUCTION_SETTLEMENT_POLICY,
  evaluateAdviceSettlement,
  type AdviceSettlementPolicy,
  type RawAutoLarisAdviceObservation,
} from "@punyasitus/core/billing/advice";
import {
  BILLING_CURRENCY,
  generateAutoLarisReffId,
  generateBillingUlid,
} from "@punyasitus/core/billing/index";
import { getWibYearFromEpochMs, RECEIPT_NON_PKP_NOTICE } from "@punyasitus/core/billing/receipt-pdf";
import {
  PLUGIN_ADDON_ORDER_TTL_MS,
  PLUGIN_CUSTOM_DEV_ALLOWED_TRANSITIONS,
  PLUGIN_CUSTOM_DEV_DAILY_LIMIT,
  PluginBillingValidationError,
  assertValidPluginStoreSlug,
  calculatePluginAddonQuote,
  computePluginEntitlementExpiryMs,
  evaluatePluginStoreAccess,
  formatPluginAddonReceiptNumber,
  generatePluginAddonReceiptPdf,
  getWibDayBucket,
  validateCustomPluginRequestInput,
  type GeneratedPluginAddonReceiptPdf,
  type PluginAddonCouponRule,
  type PluginBillingModel,
  type PluginCustomDevRequestStatus,
  type PluginEntitlementSourceKind,
  type PluginPayerKind,
  type PluginVisibilityTier,
} from "@punyasitus/core/plugins/billing";
import {
  computeEffectiveAgencyDiscountPercent,
  parseStoredDiscountTiersJson,
} from "../../agencies/pricing.ts";
import {
  PlatformAuditError,
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  validateOperatorReason,
} from "../../platform/audit.ts";
import {
  PluginStoreError,
  type PluginAddonOrderRecord,
  type PluginAddonReceiptRecord,
  type PluginCatalogItemRecord,
  type PluginCustomDevRequestRecord,
  type PluginPrivateGrantRecord,
  type PluginTenantEntitlementRecord,
  type TenantPluginStoreItemView,
  type TenantPluginStoreSnapshot,
} from "./types.ts";

/**
 * Commercial Plugin Store, Bespoke Client/Agency Grants (`private_client`),
 * AutoLaris Add-on Billing, Immutable Numbered Receipts (`INV-PLG-YYYY-NNNNNN`),
 * and Custom Plugin Dev Request (`service_kind = 'custom_plugin'`) Repository
 * (`packages/db/src/plugins/store/repository.ts`; REQ-098, ADR-0010, PLAN §19.7, TASK-098).
 *
 * Hard Invariants:
 * 1. ZERO runtime DDL on hot paths (migrations live strictly in `0033_plugin_store_billing.sql`).
 * 2. `private_client` plugins are 100% invisible (omitted from store list, `null` / 404 on direct fetch)
 *    unless the tenant holds an active direct grant OR an active grant on its owning active agency.
 * 3. Agency-managed client tenants receive `403 AGENCY_PAYER_ONLY` on self-serve paid checkout;
 *    agency checkout strictly verifies agency ownership of the target client tenant (`404` on foreign client).
 * 4. Settling an order is 100% atomic & idempotent (gap-free yearly receipt counter CAS, immutable
 *    PDF receipt, entitlement activation/extension, `tenant_plugin_entitlements` sync, `platform_audit`).
 * 5. Disabling or expiring a plugin sets `enabled = 0` / `status = 'expired'` and NEVER deletes
 *    `plg_*` tenant data rows (preserved until `H+45` purge).
 * 6. Fulfilling a `custom_plugin` dev request is strictly blocked (`422 GRANT_REQUIRED`) unless linked
 *    to an existing active `private_client` grant for that tenant or its active owning agency.
 */

// ---------------------------------------------------------------------------
// Raw SQL Row Shapes & Mappers
// ---------------------------------------------------------------------------

interface RawCatalogItemRow {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly visibility_tier: PluginVisibilityTier;
  readonly billing_model: PluginBillingModel;
  readonly price_idr: number;
  readonly active: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawPrivateGrantRow {
  readonly id: string;
  readonly plugin_slug: string;
  readonly tenant_id: string | null;
  readonly agency_id: string | null;
  readonly status: "active" | "revoked";
  readonly granted_by_user_id: string;
  readonly grant_reason: string;
  readonly revoked_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawEntitlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly plugin_slug: string;
  readonly source_kind: PluginEntitlementSourceKind;
  readonly payer_kind: PluginPayerKind;
  readonly payer_agency_id: string | null;
  readonly status: "active" | "expired" | "disabled" | "revoked";
  readonly enabled: number;
  readonly expires_at: number | null;
  readonly last_payment_attempt_id: string | null;
  readonly last_receipt_id: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawAddonOrderRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly plugin_slug: string;
  readonly billing_model: Exclude<PluginBillingModel, "free">;
  readonly payer_kind: PluginPayerKind;
  readonly payer_agency_id: string | null;
  readonly payer_user_id: string;
  readonly channel_code: string;
  readonly gross_amount_idr: number;
  readonly discount_amount_idr: number;
  readonly coupon_code: string | null;
  readonly channel_fee_idr: number;
  readonly net_amount_idr: number;
  readonly total_payable_idr: number;
  readonly provider_account_id: string;
  readonly provider_reff_id: string;
  readonly payment_attempt_id: string;
  readonly receipt_id: string | null;
  readonly status: "pending" | "settled" | "expired" | "refunded";
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly payment_instructions_json: string | null;
  readonly expires_at: number;
  readonly version: number;
  readonly created_at: number;
  readonly settled_at: number | null;
  readonly updated_at: number;
}

interface RawAddonReceiptRow {
  readonly id: string;
  readonly receipt_number: string;
  readonly tenant_id: string;
  readonly payer_kind: PluginPayerKind;
  readonly payer_agency_id: string | null;
  readonly payer_user_id: string;
  readonly tenant_name_snapshot: string;
  readonly payer_name_snapshot: string;
  readonly plugin_slug: string;
  readonly plugin_name_snapshot: string;
  readonly billing_model: Exclude<PluginBillingModel, "free">;
  readonly order_id: string;
  readonly entitlement_id: string;
  readonly currency: string;
  readonly gross_amount_idr: number;
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

interface RawCustomDevRequestRow {
  readonly id: string;
  readonly request_code: string;
  readonly tenant_id: string;
  readonly tenant_handle?: string | null;
  readonly tenant_name?: string | null;
  readonly requested_by_user_id: string;
  readonly service_kind: "custom_plugin";
  readonly title: string;
  readonly requirements_summary: string;
  readonly contact_whatsapp: string;
  readonly budget_range: string | null;
  readonly status: PluginCustomDevRequestStatus;
  readonly quote_amount_idr: number | null;
  readonly operator_notes: string | null;
  readonly status_reason: string | null;
  readonly linked_grant_id: string | null;
  readonly linked_plugin_slug: string | null;
  readonly idempotency_key: string | null;
  readonly day_bucket: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
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

function mapCatalogRow(r: RawCatalogItemRow): PluginCatalogItemRecord {
  const createdAtMs = Number(r.created_at);
  const updatedAtMs = Number(r.updated_at);
  return {
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    description: r.description,
    visibilityTier: r.visibility_tier,
    billingModel: r.billing_model,
    priceIdr: Number(r.price_idr),
    active: r.active === 1,
    version: Number(r.version),
    createdAtMs,
    updatedAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
    updatedAtIso: new Date(updatedAtMs).toISOString(),
  };
}

function mapPrivateGrantRow(r: RawPrivateGrantRow): PluginPrivateGrantRecord {
  const createdAtMs = Number(r.created_at);
  const updatedAtMs = Number(r.updated_at);
  const revokedAtMs = r.revoked_at !== null ? Number(r.revoked_at) : null;
  return {
    id: r.id,
    pluginSlug: r.plugin_slug,
    tenantId: r.tenant_id,
    agencyId: r.agency_id,
    status: r.status,
    grantedByUserId: r.granted_by_user_id,
    grantReason: r.grant_reason,
    revokedAtMs,
    revokedAtIso: revokedAtMs !== null ? new Date(revokedAtMs).toISOString() : null,
    createdAtMs,
    updatedAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
    updatedAtIso: new Date(updatedAtMs).toISOString(),
  };
}

function mapEntitlementRow(r: RawEntitlementRow): PluginTenantEntitlementRecord {
  const createdAtMs = Number(r.created_at);
  const updatedAtMs = Number(r.updated_at);
  const expiresAtMs = r.expires_at !== null ? Number(r.expires_at) : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    pluginSlug: r.plugin_slug,
    sourceKind: r.source_kind,
    payerKind: r.payer_kind,
    payerAgencyId: r.payer_agency_id,
    status: r.status,
    enabled: r.enabled === 1,
    expiresAtMs,
    expiresAtIso: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    lastPaymentAttemptId: r.last_payment_attempt_id,
    lastReceiptId: r.last_receipt_id,
    version: Number(r.version),
    createdAtMs,
    updatedAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
    updatedAtIso: new Date(updatedAtMs).toISOString(),
  };
}

function safeParseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapAddonOrderRow(r: RawAddonOrderRow): PluginAddonOrderRecord {
  const createdAtMs = Number(r.created_at);
  const updatedAtMs = Number(r.updated_at);
  const expiresAtMs = Number(r.expires_at);
  const settledAtMs = r.settled_at !== null ? Number(r.settled_at) : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    pluginSlug: r.plugin_slug,
    billingModel: r.billing_model,
    payerKind: r.payer_kind,
    payerAgencyId: r.payer_agency_id,
    payerUserId: r.payer_user_id,
    channelCode: r.channel_code,
    grossAmountIdr: Number(r.gross_amount_idr),
    discountAmountIdr: Number(r.discount_amount_idr),
    couponCode: r.coupon_code,
    channelFeeIdr: Number(r.channel_fee_idr),
    netAmountIdr: Number(r.net_amount_idr),
    totalPayableIdr: Number(r.total_payable_idr),
    providerAccountId: r.provider_account_id,
    providerReffId: r.provider_reff_id,
    paymentAttemptId: r.payment_attempt_id,
    receiptId: r.receipt_id,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    paymentInstructions: safeParseJsonObject(r.payment_instructions_json),
    expiresAtMs,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    version: Number(r.version),
    createdAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
    settledAtMs,
    settledAtIso: settledAtMs !== null ? new Date(settledAtMs).toISOString() : null,
    updatedAtMs,
    updatedAtIso: new Date(updatedAtMs).toISOString(),
  };
}

function mapAddonReceiptRow(r: RawAddonReceiptRow): PluginAddonReceiptRecord {
  const issuedAtMs = Number(r.issued_at);
  const createdAtMs = Number(r.created_at);
  return {
    id: r.id,
    receiptNumber: r.receipt_number,
    tenantId: r.tenant_id,
    payerKind: r.payer_kind,
    payerAgencyId: r.payer_agency_id,
    payerUserId: r.payer_user_id,
    tenantNameSnapshot: r.tenant_name_snapshot,
    payerNameSnapshot: r.payer_name_snapshot,
    pluginSlug: r.plugin_slug,
    pluginNameSnapshot: r.plugin_name_snapshot,
    billingModel: r.billing_model,
    orderId: r.order_id,
    entitlementId: r.entitlement_id,
    currency: BILLING_CURRENCY,
    grossAmountIdr: Number(r.gross_amount_idr),
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

function mapCustomDevRequestRow(r: RawCustomDevRequestRow): PluginCustomDevRequestRecord {
  const createdAtMs = Number(r.created_at);
  const updatedAtMs = Number(r.updated_at);
  return {
    id: r.id,
    requestCode: r.request_code,
    tenantId: r.tenant_id,
    tenantHandle: r.tenant_handle ?? null,
    tenantName: r.tenant_name ?? null,
    requestedByUserId: r.requested_by_user_id,
    serviceKind: r.service_kind,
    title: r.title,
    requirementsSummary: r.requirements_summary,
    contactWhatsapp: r.contact_whatsapp,
    budgetRange: r.budget_range,
    status: r.status,
    quoteAmountIdr: r.quote_amount_idr !== null ? Number(r.quote_amount_idr) : null,
    operatorNotes: r.operator_notes,
    statusReason: r.status_reason,
    linkedGrantId: r.linked_grant_id,
    linkedPluginSlug: r.linked_plugin_slug,
    idempotencyKey: r.idempotency_key,
    dayBucket: r.day_bucket,
    version: Number(r.version),
    createdAtMs,
    updatedAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
    updatedAtIso: new Date(updatedAtMs).toISOString(),
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT/i.test(msg);
}

function isMissingTableOrColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table|no such column/i.test(msg);
}

function wrapAuditOrValidationError(err: unknown): never {
  if (err instanceof PluginStoreError) throw err;
  if (err instanceof PluginBillingValidationError) {
    throw new PluginStoreError(422, err.code, err.message, {
      reasonCode: err.code,
      fields: err.fields,
      cause: err,
    });
  }
  if (err instanceof PlatformAuditError) {
    throw new PluginStoreError(err.status === 422 ? 422 : 500, err.code, err.message, {
      cause: err,
    });
  }
  throw err;
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

// ---------------------------------------------------------------------------
// Internal Tenant Agency Ownership & Legacy Runtime Table Sync Helpers
// ---------------------------------------------------------------------------

interface TenantAgencyContext {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly owningAgencyId: string | null;
  readonly owningAgencyActive: boolean;
}

export async function resolveTenantAgencyContext(
  platformDb: D1Database,
  tenantId: string,
): Promise<TenantAgencyContext | null> {
  const row = await platformDb
    .prepare("SELECT id, handle, name, agency_id FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly name: string;
      readonly agency_id: string | null;
    }>();
  if (!row) return null;

  let owningAgencyId = row.agency_id && row.agency_id.trim() ? row.agency_id.trim() : null;
  if (!owningAgencyId) {
    try {
      const link = await platformDb
        .prepare("SELECT agency_id FROM agency_client_links WHERE tenant_id = ? LIMIT 1")
        .bind(tenantId)
        .first<{ readonly agency_id: string }>();
      if (link?.agency_id) {
        owningAgencyId = link.agency_id.trim();
      }
    } catch (err) {
      if (!isMissingTableOrColumnError(err)) throw err;
    }
  }

  let owningAgencyActive = false;
  if (owningAgencyId) {
    try {
      const ag = await platformDb
        .prepare("SELECT status FROM agencies WHERE id = ? LIMIT 1")
        .bind(owningAgencyId)
        .first<{ readonly status: string }>();
      owningAgencyActive = ag?.status === "active";
    } catch (err) {
      if (!isMissingTableOrColumnError(err)) throw err;
    }
  }

  return {
    tenantId: row.id,
    handle: row.handle,
    name: row.name,
    owningAgencyId,
    owningAgencyActive,
  };
}

/**
 * Keeps TASK-097's `plugin_catalog` table in sync with `plugin_catalog_items` so the
 * Frozen-Core plugin runtime (`plugin-runtime.ts`) stays aligned with console metadata updates.
 */
async function syncLegacyPluginCatalogRow(
  platformDb: D1Database,
  item: {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly visibilityTier: PluginVisibilityTier;
    readonly billingModel: PluginBillingModel;
    readonly priceIdr: number;
    readonly active: boolean;
  },
  nowMs: number,
): Promise<void> {
  const billingCycle =
    item.visibilityTier === "private_client" ? "custom" : item.billingModel;
  try {
    await platformDb
      .prepare(
        `INSERT INTO plugin_catalog (
           id, slug, name, description, distribution, billing_cycle, price_idr,
           latest_version, permissions_json, active, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '1.0.0', '[]', ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           distribution = excluded.distribution,
           billing_cycle = excluded.billing_cycle,
           price_idr = excluded.price_idr,
           active = excluded.active,
           version = plugin_catalog.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        item.slug,
        item.slug,
        item.name,
        item.description,
        item.visibilityTier,
        billingCycle,
        item.priceIdr,
        item.active ? 1 : 0,
        nowMs,
        nowMs,
      )
      .run();
  } catch (err) {
    if (!isMissingTableOrColumnError(err)) throw err;
    await platformDb
      .prepare(
        `INSERT INTO plugin_catalog (
           id, slug, name, distribution, price_idr, active, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           distribution = excluded.distribution,
           price_idr = excluded.price_idr,
           active = excluded.active,
           version = plugin_catalog.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        item.slug,
        item.slug,
        item.name,
        item.visibilityTier,
        item.priceIdr,
        item.active ? 1 : 0,
        nowMs,
        nowMs,
      )
      .run();
  }
}

/**
 * Keeps TASK-097's `tenant_plugin_entitlements` table aligned with TASK-098 entitlements
 * so `resolveActivePluginForTenant` honors commercial settlements, grants, revocations, and expiries.
 */
async function syncLegacyTenantPluginEntitlement(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly pluginSlug: string;
    readonly status: "active" | "expired" | "revoked";
    readonly grantedBy: string | null;
    readonly expiresAtMs: number | null;
    readonly nowMs: number;
  },
): Promise<void> {
  const catalog = await getPluginCatalogItem(platformDb, params.pluginSlug);
  if (catalog) {
    await syncLegacyPluginCatalogRow(platformDb, catalog, params.nowMs);
  }

  const id = `tpe_${generateBillingUlid(params.nowMs)}`;
  try {
    if (params.status === "active") {
      await platformDb
        .prepare(
          `INSERT INTO tenant_plugin_entitlements (
             id, tenant_id, plugin_id, granted_by, settlement_id, granted_at,
             status, expires_at, revoked_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'active', ?, NULL, ?)
           ON CONFLICT(tenant_id, plugin_id) DO UPDATE SET
             granted_by = COALESCE(excluded.granted_by, tenant_plugin_entitlements.granted_by),
             status = 'active',
             expires_at = excluded.expires_at,
             revoked_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          params.tenantId,
          params.pluginSlug,
          params.grantedBy,
          params.nowMs,
          params.expiresAtMs,
          params.nowMs,
        )
        .run();
    } else {
      await platformDb
        .prepare(
          `UPDATE tenant_plugin_entitlements
           SET status = ?,
               revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END,
               updated_at = ?
           WHERE tenant_id = ? AND plugin_id = ?`,
        )
        .bind(
          params.status,
          params.status,
          params.nowMs,
          params.nowMs,
          params.tenantId,
          params.pluginSlug,
        )
        .run();
    }
  } catch (err) {
    if (!isMissingTableOrColumnError(err)) throw err;
    // Pre-0011 fallback (no status/expires_at columns on tenant_plugin_entitlements)
    if (params.status === "active") {
      await platformDb
        .prepare(
          `INSERT OR IGNORE INTO tenant_plugin_entitlements (
             id, tenant_id, plugin_id, granted_by, settlement_id, granted_at
           ) VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(id, params.tenantId, params.pluginSlug, params.grantedBy, params.nowMs)
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Plugin Catalog Management & Tier Promotion (Console + Read)
// ---------------------------------------------------------------------------

export async function getPluginCatalogItem(
  platformDb: D1Database,
  slug: string,
): Promise<PluginCatalogItemRecord | null> {
  const cleanSlug = slug.trim().toLowerCase();
  if (!cleanSlug) return null;
  const row = await platformDb
    .prepare("SELECT * FROM plugin_catalog_items WHERE slug = ? LIMIT 1")
    .bind(cleanSlug)
    .first<RawCatalogItemRow>();
  return row ? mapCatalogRow(row) : null;
}

export async function listPluginCatalogItems(
  platformDb: D1Database,
  options: {
    readonly includeInactive?: boolean;
    readonly visibilityTier?: PluginVisibilityTier;
  } = {},
): Promise<readonly PluginCatalogItemRecord[]> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (!options.includeInactive) {
    clauses.push("active = 1");
  }
  if (options.visibilityTier) {
    clauses.push("visibility_tier = ?");
    bindings.push(options.visibilityTier);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM plugin_catalog_items ${where}
    ORDER BY CASE visibility_tier WHEN 'public_free' THEN 1 WHEN 'public_paid' THEN 2 ELSE 3 END, name ASC`;
  const res = await platformDb
    .prepare(sql)
    .bind(...bindings)
    .all<RawCatalogItemRow>();
  return (res.results ?? []).map(mapCatalogRow);
}

export interface UpsertConsolePluginCatalogItemInput {
  readonly slug: string;
  readonly name: string;
  readonly tagline?: string;
  readonly description?: string;
  readonly visibilityTier: PluginVisibilityTier;
  readonly billingModel: PluginBillingModel;
  readonly priceIdr: number;
  readonly active?: boolean;
  readonly expectedVersion?: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly reason: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

/**
 * Creates or updates a `plugin_catalog_items` entry (including promoting
 * `private_client` -> `public_free` | `public_paid` purely via audited metadata update!).
 * Requires mandatory 10–500 char `reason`, OCC `expectedVersion` on updates, and writes
 * `platform_audit` atomically inside the SAME `D1Database.batch([...])` transaction.
 */
export async function upsertConsolePluginCatalogItem(
  platformDb: D1Database,
  input: UpsertConsolePluginCatalogItemInput,
): Promise<{ readonly item: PluginCatalogItemRecord; readonly created: boolean }> {
  try {
    const slug = assertValidPluginStoreSlug(input.slug, "slug");
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new PluginStoreError(422, "VALIDATION_ERROR", "Nama plugin harus 2 hingga 80 karakter.");
    }
    const tagline = (input.tagline ?? "").trim().slice(0, 140);
    const description = (input.description ?? "").trim().slice(0, 1000);
    const active = input.active !== false;
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const validatedReason = validateOperatorReason(input.reason);

    const priceIdr = Math.trunc(input.priceIdr);
    if (!Number.isSafeInteger(priceIdr) || priceIdr < 0 || priceIdr > 999_999_999_999) {
      throw new PluginStoreError(422, "VALIDATION_ERROR", "Harga IDR tidak valid.");
    }

    if (input.visibilityTier === "public_free") {
      if (input.billingModel !== "free" || priceIdr !== 0) {
        throw new PluginStoreError(
          422,
          "VALIDATION_ERROR",
          'Plugin "public_free" wajib memiliki billingModel "free" dan priceIdr = 0.',
        );
      }
    }
    if (input.visibilityTier === "public_paid") {
      if (input.billingModel === "free" || priceIdr < 10_000) {
        throw new PluginStoreError(
          422,
          "VALIDATION_ERROR",
          'Plugin "public_paid" wajib memiliki billingModel berbayar dan harga minimal Rp 10.000.',
        );
      }
    }

    const existing = await getPluginCatalogItem(platformDb, slug);

    if (!existing) {
      const auditStmt = buildPlatformAuditStatement(platformDb, {
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: "console.plugin_catalog.create",
        targetType: "plugin_catalog_item",
        targetId: slug,
        reason: validatedReason,
        requireReason: true,
        outcome: "success",
        requestId: input.requestId ?? null,
        metadata: {
          visibilityTier: input.visibilityTier,
          billingModel: input.billingModel,
          priceIdr,
          active,
        },
        createdAtMs: nowMs,
      });

      await platformDb.batch([
        platformDb
          .prepare(
            `INSERT INTO plugin_catalog_items (
               slug, name, tagline, description, visibility_tier, billing_model,
               price_idr, active, version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            slug,
            name,
            tagline,
            description,
            input.visibilityTier,
            input.billingModel,
            priceIdr,
            active ? 1 : 0,
            nowMs,
            nowMs,
          ),
        auditStmt.statement,
      ]);

      await syncLegacyPluginCatalogRow(
        platformDb,
        {
          slug,
          name,
          description,
          visibilityTier: input.visibilityTier,
          billingModel: input.billingModel,
          priceIdr,
          active,
        },
        nowMs,
      );

      const createdItem = await getPluginCatalogItem(platformDb, slug);
      if (!createdItem) {
        throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat item katalog plugin.");
      }
      return { item: createdItem, created: true };
    }

    // Update requires OCC `expectedVersion`
    if (
      typeof input.expectedVersion !== "number" ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw new PluginStoreError(
        422,
        "VALIDATION_ERROR",
        "expectedVersion wajib disertakan untuk memperbarui item katalog plugin.",
      );
    }

    const promoted =
      existing.visibilityTier === "private_client" &&
      (input.visibilityTier === "public_free" || input.visibilityTier === "public_paid");

    const auditId = generatePlatformAuditId(nowMs);
    const updateRes = await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE plugin_catalog_items
           SET name = ?,
               tagline = ?,
               description = ?,
               visibility_tier = ?,
               billing_model = ?,
               price_idr = ?,
               active = ?,
               version = version + 1,
               updated_at = ?
           WHERE slug = ? AND version = ?`,
        )
        .bind(
          name,
          tagline,
          description,
          input.visibilityTier,
          input.billingModel,
          priceIdr,
          active ? 1 : 0,
          nowMs,
          slug,
          input.expectedVersion,
        ),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, 'plugin_catalog_item', ?, NULL, ?, 'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          input.actorUserId,
          input.actorRole,
          promoted ? "console.plugin_catalog.promote" : "console.plugin_catalog.update",
          slug,
          validatedReason,
          input.requestId ?? null,
          JSON.stringify({
            previousVisibilityTier: existing.visibilityTier,
            visibilityTier: input.visibilityTier,
            previousBillingModel: existing.billingModel,
            billingModel: input.billingModel,
            priceIdr,
            active,
            promoted,
          }),
          nowMs,
        ),
    ]);

    const changed = updateRes[0]?.meta?.changes ?? 0;
    if (changed !== 1) {
      throw new PluginStoreError(
        409,
        "VERSION_CONFLICT",
        "Item katalog plugin telah diubah oleh operator lain. Muat ulang dan coba lagi.",
      );
    }

    await syncLegacyPluginCatalogRow(
      platformDb,
      {
        slug,
        name,
        description,
        visibilityTier: input.visibilityTier,
        billingModel: input.billingModel,
        priceIdr,
        active,
      },
      nowMs,
    );

    const updatedItem = await getPluginCatalogItem(platformDb, slug);
    if (!updatedItem) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat item katalog plugin.");
    }
    return { item: updatedItem, created: false };
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

// ---------------------------------------------------------------------------
// 2. Private Client / Agency Grants (`plugin_private_grants`)
// ---------------------------------------------------------------------------

export interface IssuePluginPrivateGrantInput {
  readonly pluginSlug: string;
  readonly tenantId?: string | null;
  readonly agencyId?: string | null;
  readonly grantedByUserId: string;
  readonly actorRole: string;
  readonly grantReason: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function issuePluginPrivateGrant(
  platformDb: D1Database,
  input: IssuePluginPrivateGrantInput,
): Promise<PluginPrivateGrantRecord> {
  try {
    const slug = assertValidPluginStoreSlug(input.pluginSlug, "pluginSlug");
    const tenantId = input.tenantId?.trim() || null;
    const agencyId = input.agencyId?.trim() || null;
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const validatedReason = validateOperatorReason(input.grantReason);

    if (!tenantId && !agencyId) {
      throw new PluginStoreError(
        422,
        "VALIDATION_ERROR",
        "Minimal satu target (tenantId atau agencyId) wajib diisi untuk izin plugin privat.",
      );
    }

    const catalogItem = await getPluginCatalogItem(platformDb, slug);
    if (!catalogItem || !catalogItem.active) {
      throw new PluginStoreError(
        404,
        "PLUGIN_NOT_FOUND",
        `Plugin "${slug}" tidak ditemukan atau tidak aktif di katalog.`,
      );
    }

    if (tenantId) {
      const tRow = await platformDb
        .prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1")
        .bind(tenantId)
        .first<{ readonly id: string }>();
      if (!tRow) {
        throw new PluginStoreError(404, "TENANT_NOT_FOUND", `Tenant "${tenantId}" tidak ditemukan.`);
      }
    }

    if (agencyId) {
      const aRow = await platformDb
        .prepare("SELECT id, status FROM agencies WHERE id = ? LIMIT 1")
        .bind(agencyId)
        .first<{ readonly id: string; readonly status: string }>();
      if (!aRow) {
        throw new PluginStoreError(404, "AGENCY_NOT_FOUND", `Agensi "${agencyId}" tidak ditemukan.`);
      }
    }

    const grantId = `plggr_${generateBillingUlid(nowMs)}`;
    const auditStmt = buildPlatformAuditStatement(platformDb, {
      actorUserId: input.grantedByUserId,
      actorRole: input.actorRole,
      action: "console.plugin_grant.issue",
      targetType: "plugin_private_grant",
      targetId: grantId,
      tenantId,
      reason: validatedReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: { pluginSlug: slug, tenantId, agencyId },
      createdAtMs: nowMs,
    });

    try {
      await platformDb.batch([
        platformDb
          .prepare(
            `INSERT INTO plugin_private_grants (
               id, plugin_slug, tenant_id, agency_id, status,
               granted_by_user_id, grant_reason, revoked_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
          )
          .bind(grantId, slug, tenantId, agencyId, input.grantedByUserId, validatedReason, nowMs, nowMs),
        auditStmt.statement,
      ]);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new PluginStoreError(
          409,
          "GRANT_ALREADY_ACTIVE",
          `Izin aktif untuk plugin "${slug}" sudah ada pada target tersebut.`,
        );
      }
      throw err;
    }

    if (tenantId) {
      await syncLegacyTenantPluginEntitlement(platformDb, {
        tenantId,
        pluginSlug: slug,
        status: "active",
        grantedBy: input.grantedByUserId,
        expiresAtMs: null,
        nowMs,
      });
    }

    const row = await platformDb
      .prepare("SELECT * FROM plugin_private_grants WHERE id = ? LIMIT 1")
      .bind(grantId)
      .first<RawPrivateGrantRow>();
    if (!row) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat izin plugin yang baru dibuat.");
    }
    return mapPrivateGrantRow(row);
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

export async function revokePluginPrivateGrant(
  platformDb: D1Database,
  input: {
    readonly grantId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly reason: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<PluginPrivateGrantRecord> {
  try {
    const cleanId = input.grantId.trim();
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const validatedReason = validateOperatorReason(input.reason);

    const existing = await platformDb
      .prepare("SELECT * FROM plugin_private_grants WHERE id = ? LIMIT 1")
      .bind(cleanId)
      .first<RawPrivateGrantRow>();
    if (!existing) {
      throw new PluginStoreError(404, "GRANT_NOT_FOUND", "Izin plugin tidak ditemukan.");
    }
    if (existing.status === "revoked") {
      return mapPrivateGrantRow(existing);
    }

    // Collect agency-owned client tenants before batch commit so we can revoke both
    // `plugin_tenant_entitlements` (inside batch) and legacy `tenant_plugin_entitlements`
    // without touching `plg_*` data rows or tenants that hold an independent direct grant.
    let agencyClientLinksTableAvailable = true;
    const affectedAgencyTenantIds: string[] = [];
    if (existing.agency_id) {
      let rows: { readonly tenant_id: string }[] = [];
      try {
        const res = await platformDb
          .prepare(
            `SELECT tenant_id FROM (
               SELECT tenant_id FROM agency_client_links WHERE agency_id = ?
               UNION
               SELECT id AS tenant_id FROM tenants WHERE agency_id = ?
             )
             WHERE tenant_id NOT IN (
               SELECT tenant_id FROM plugin_private_grants
               WHERE plugin_slug = ? AND status = 'active' AND tenant_id IS NOT NULL
             )`,
          )
          .bind(existing.agency_id, existing.agency_id, existing.plugin_slug)
          .all<{ readonly tenant_id: string }>();
        rows = res.results ?? [];
      } catch (err) {
        if (!isMissingTableOrColumnError(err)) throw err;
        agencyClientLinksTableAvailable = false;
        const res = await platformDb
          .prepare(
            `SELECT id AS tenant_id FROM tenants
             WHERE agency_id = ?
               AND id NOT IN (
                 SELECT tenant_id FROM plugin_private_grants
                 WHERE plugin_slug = ? AND status = 'active' AND tenant_id IS NOT NULL
               )`,
          )
          .bind(existing.agency_id, existing.plugin_slug)
          .all<{ readonly tenant_id: string }>();
        rows = res.results ?? [];
      }
      for (const r of rows) {
        if (r.tenant_id) affectedAgencyTenantIds.push(r.tenant_id);
      }
    }

    const auditId = generatePlatformAuditId(nowMs);
    const statements: D1PreparedStatement[] = [
      platformDb
        .prepare(
          `UPDATE plugin_private_grants
           SET status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .bind(nowMs, nowMs, cleanId),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'console.plugin_grant.revoke', 'plugin_private_grant', ?, ?, ?, 'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          input.actorUserId,
          input.actorRole,
          cleanId,
          existing.tenant_id,
          validatedReason,
          input.requestId ?? null,
          JSON.stringify({
            pluginSlug: existing.plugin_slug,
            tenantId: existing.tenant_id,
            agencyId: existing.agency_id,
          }),
          nowMs,
        ),
    ];

    if (existing.tenant_id) {
      statements.push(
        platformDb
          .prepare(
            `UPDATE plugin_tenant_entitlements
             SET status = 'revoked', enabled = 0, version = version + 1, updated_at = ?
             WHERE tenant_id = ? AND plugin_slug = ? AND source_kind = 'private_grant' AND status != 'revoked'
               AND NOT EXISTS (
                 SELECT 1 FROM plugin_private_grants g
                 WHERE g.plugin_slug = ? AND g.status = 'active'
                   AND (
                     g.tenant_id = plugin_tenant_entitlements.tenant_id
                     OR g.agency_id IN (
                       SELECT t.agency_id FROM tenants t
                       INNER JOIN agencies a ON a.id = t.agency_id AND a.status = 'active'
                       WHERE t.id = plugin_tenant_entitlements.tenant_id AND t.agency_id IS NOT NULL
                     )
                   )
               )`,
          )
          .bind(nowMs, existing.tenant_id, existing.plugin_slug, existing.plugin_slug),
      );
    }

    if (existing.agency_id) {
      const agencyClientSubquery = agencyClientLinksTableAvailable
        ? `SELECT tenant_id FROM agency_client_links WHERE agency_id = ?
           UNION
           SELECT id FROM tenants WHERE agency_id = ?`
        : `SELECT id FROM tenants WHERE agency_id = ?`;
      const agencySubqueryBinds = agencyClientLinksTableAvailable
        ? [existing.agency_id, existing.agency_id]
        : [existing.agency_id];

      statements.push(
        platformDb
          .prepare(
            `UPDATE plugin_tenant_entitlements
             SET status = 'revoked', enabled = 0, version = version + 1, updated_at = ?
             WHERE tenant_id IN (${agencyClientSubquery})
               AND plugin_slug = ?
               AND source_kind = 'private_grant'
               AND status != 'revoked'
               AND NOT EXISTS (
                 SELECT 1 FROM plugin_private_grants g
                 WHERE g.plugin_slug = ?
                   AND g.tenant_id = plugin_tenant_entitlements.tenant_id
                   AND g.status = 'active'
               )`,
          )
          .bind(nowMs, ...agencySubqueryBinds, existing.plugin_slug, existing.plugin_slug),
      );
    }

    await platformDb.batch(statements);

    // Sync legacy TASK-097 `tenant_plugin_entitlements` for every newly revoked tenant
    const tenantsToSync = new Set<string>(affectedAgencyTenantIds);
    if (existing.tenant_id) {
      tenantsToSync.add(existing.tenant_id);
    }
    for (const tid of tenantsToSync) {
      const entState = await platformDb
        .prepare(
          `SELECT status FROM plugin_tenant_entitlements
           WHERE tenant_id = ? AND plugin_slug = ?
           LIMIT 1`,
        )
        .bind(tid, existing.plugin_slug)
        .first<{ readonly status: string }>();
      // Only revoke legacy entitlement if no remaining active grant covers this tenant
      if (!entState || entState.status === "revoked") {
        const tenantCtx = await resolveTenantAgencyContext(platformDb, tid);
        const remainingGrant = await findActivePluginPrivateGrantForTenant(platformDb, {
          pluginSlug: existing.plugin_slug,
          tenantId: tid,
          owningAgencyId: tenantCtx?.owningAgencyId ?? null,
          owningAgencyActive: tenantCtx?.owningAgencyActive ?? false,
        });
        if (!remainingGrant) {
          await syncLegacyTenantPluginEntitlement(platformDb, {
            tenantId: tid,
            pluginSlug: existing.plugin_slug,
            status: "revoked",
            grantedBy: null,
            expiresAtMs: null,
            nowMs,
          });
        }
      }
    }

    const updated = await platformDb
      .prepare("SELECT * FROM plugin_private_grants WHERE id = ? LIMIT 1")
      .bind(cleanId)
      .first<RawPrivateGrantRow>();
    if (!updated) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat izin plugin setelah pencabutan.");
    }
    return mapPrivateGrantRow(updated);
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

export async function listPluginPrivateGrants(
  platformDb: D1Database,
  filter: {
    readonly pluginSlug?: string;
    readonly tenantId?: string;
    readonly agencyId?: string;
    readonly status?: "active" | "revoked";
    readonly limit?: number;
  } = {},
): Promise<readonly PluginPrivateGrantRecord[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (filter.pluginSlug) {
    clauses.push("plugin_slug = ?");
    binds.push(filter.pluginSlug.trim().toLowerCase());
  }
  if (filter.tenantId) {
    clauses.push("tenant_id = ?");
    binds.push(filter.tenantId.trim());
  }
  if (filter.agencyId) {
    clauses.push("agency_id = ?");
    binds.push(filter.agencyId.trim());
  }
  if (filter.status) {
    clauses.push("status = ?");
    binds.push(filter.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, Math.trunc(filter.limit ?? 100)));
  const res = await platformDb
    .prepare(`SELECT * FROM plugin_private_grants ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<RawPrivateGrantRow>();
  return (res.results ?? []).map(mapPrivateGrantRow);
}

export async function findActivePluginPrivateGrantForTenant(
  platformDb: D1Database,
  params: {
    readonly pluginSlug: string;
    readonly tenantId: string;
    readonly owningAgencyId: string | null;
    readonly owningAgencyActive: boolean;
  },
): Promise<{ readonly grant: PluginPrivateGrantRecord; readonly scope: "tenant" | "agency" } | null> {
  const direct = await platformDb
    .prepare(
      `SELECT * FROM plugin_private_grants
       WHERE plugin_slug = ? AND tenant_id = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(params.pluginSlug, params.tenantId)
    .first<RawPrivateGrantRow>();
  if (direct) {
    return { grant: mapPrivateGrantRow(direct), scope: "tenant" };
  }

  if (params.owningAgencyId && params.owningAgencyActive) {
    const agencyGrant = await platformDb
      .prepare(
        `SELECT * FROM plugin_private_grants
         WHERE plugin_slug = ? AND agency_id = ? AND status = 'active'
         LIMIT 1`,
      )
      .bind(params.pluginSlug, params.owningAgencyId)
      .first<RawPrivateGrantRow>();
    if (agencyGrant) {
      return { grant: mapPrivateGrantRow(agencyGrant), scope: "agency" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. Tenant Store Snapshot, Direct Detail, Install/Enable/Disable & Expiry
// ---------------------------------------------------------------------------

export async function getTenantPluginStoreSnapshot(
  platformDb: D1Database,
  params: { readonly tenantId: string; readonly nowMs?: number },
): Promise<TenantPluginStoreSnapshot> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tenantCtx = await resolveTenantAgencyContext(platformDb, params.tenantId);
  if (!tenantCtx) {
    throw new PluginStoreError(404, "TENANT_NOT_FOUND", "Situs tidak ditemukan.");
  }

  const dayBucket = getWibDayBucket(nowMs);
  const [catalog, directGrantsRes, agencyGrantsRes, entRes, ordersRes, receiptsRes, reqRes] =
    await Promise.all([
      listPluginCatalogItems(platformDb, { includeInactive: false }),
      platformDb
        .prepare("SELECT * FROM plugin_private_grants WHERE tenant_id = ? AND status = 'active'")
        .bind(params.tenantId)
        .all<RawPrivateGrantRow>(),
      tenantCtx.owningAgencyId && tenantCtx.owningAgencyActive
        ? platformDb
            .prepare(
              "SELECT * FROM plugin_private_grants WHERE agency_id = ? AND status = 'active'",
            )
            .bind(tenantCtx.owningAgencyId)
            .all<RawPrivateGrantRow>()
        : Promise.resolve({ results: [] as RawPrivateGrantRow[] }),
      platformDb
        .prepare("SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ?")
        .bind(params.tenantId)
        .all<RawEntitlementRow>(),
      platformDb
        .prepare(
          "SELECT * FROM plugin_addon_orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
        )
        .bind(params.tenantId)
        .all<RawAddonOrderRow>(),
      platformDb
        .prepare(
          "SELECT * FROM plugin_addon_receipts WHERE tenant_id = ? ORDER BY issued_at DESC LIMIT 50",
        )
        .bind(params.tenantId)
        .all<RawAddonReceiptRow>(),
      platformDb
        .prepare(
          "SELECT * FROM plugin_custom_dev_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
        )
        .bind(params.tenantId)
        .all<RawCustomDevRequestRow>(),
    ]);

  const directGrantBySlug = new Map(
    (directGrantsRes.results ?? []).map((g) => [g.plugin_slug, mapPrivateGrantRow(g)]),
  );
  const agencyGrantBySlug = new Map(
    (agencyGrantsRes.results ?? []).map((g) => [g.plugin_slug, mapPrivateGrantRow(g)]),
  );
  const entBySlug = new Map(
    (entRes.results ?? []).map((e) => [e.plugin_slug, mapEntitlementRow(e)]),
  );

  const items: TenantPluginStoreItemView[] = [];
  for (const cat of catalog) {
    const directGrant = directGrantBySlug.get(cat.slug) ?? null;
    const agencyGrant = agencyGrantBySlug.get(cat.slug) ?? null;
    const ent = entBySlug.get(cat.slug) ?? null;

    const access = evaluatePluginStoreAccess({
      visibilityTier: cat.visibilityTier,
      billingModel: cat.billingModel,
      active: cat.active,
      owningAgencyId: tenantCtx.owningAgencyId,
      directGrantActive: directGrant !== null,
      agencyGrantActive: agencyGrant !== null,
      entitlement: ent
        ? {
            status: ent.status,
            enabled: ent.enabled,
            sourceKind: ent.sourceKind,
            expiresAtMs: ent.expiresAtMs,
          }
        : null,
      nowMs,
    });

    // CRITICAL INVARIANT: ungranted `private_client` plugins are 100% OMITTED!
    if (!access.visible) {
      continue;
    }

    const effectiveEntStatus =
      ent && ent.status === "active" && ent.expiresAtMs !== null && ent.expiresAtMs <= nowMs
        ? "expired"
        : (ent?.status ?? null);

    items.push({
      slug: cat.slug,
      name: cat.name,
      tagline: cat.tagline,
      description: cat.description,
      visibilityTier: cat.visibilityTier,
      billingModel: cat.billingModel,
      priceIdr: cat.priceIdr,
      entitled: access.entitled,
      installed: ent !== null,
      enabled: Boolean(ent?.enabled && effectiveEntStatus === "active" && access.entitled),
      entitlementStatus: effectiveEntStatus,
      sourceKind: ent?.sourceKind ?? null,
      expiresAtIso: ent?.expiresAtIso ?? null,
      canInstall: access.canInstall,
      canTenantCheckout: access.canTenantCheckout,
      agencyManagedBilling: tenantCtx.owningAgencyId !== null,
      checkoutBlockCode: access.checkoutBlockCode,
      activeGrantId: directGrant?.id ?? agencyGrant?.id ?? null,
      activeGrantScope: access.activeGrantScope,
    });
  }

  const customDevRequests = (reqRes.results ?? []).map(mapCustomDevRequestRow);
  const usedToday = customDevRequests.filter((r) => r.dayBucket === dayBucket).length;

  return {
    tenantId: params.tenantId,
    owningAgencyId: tenantCtx.owningAgencyId,
    billingPayer: tenantCtx.owningAgencyId ? "agency" : "tenant",
    items,
    orders:
      tenantCtx.owningAgencyId !== null
        ? []
        : (ordersRes.results ?? []).map(mapAddonOrderRow),
    receipts:
      tenantCtx.owningAgencyId !== null
        ? []
        : (receiptsRes.results ?? []).map(mapAddonReceiptRow),
    customDevRequests,
    customDevQuota: {
      used: usedToday,
      limit: PLUGIN_CUSTOM_DEV_DAILY_LIMIT,
      remaining: Math.max(0, PLUGIN_CUSTOM_DEV_DAILY_LIMIT - usedToday),
      dayBucket,
    },
  };
}

/**
 * Returns store detail for a single plugin, or `null` (404!) if not found, inactive,
 * or `private_client` without an active direct or active owning-agency grant.
 */
export async function getTenantPluginStoreItemDetail(
  platformDb: D1Database,
  params: { readonly tenantId: string; readonly pluginSlug: string; readonly nowMs?: number },
): Promise<TenantPluginStoreItemView | null> {
  const cleanSlug = params.pluginSlug.trim().toLowerCase();
  if (!cleanSlug) return null;
  const snapshot = await getTenantPluginStoreSnapshot(platformDb, params);
  return snapshot.items.find((item) => item.slug === cleanSlug) ?? null;
}

export async function installOrEnableStorePlugin(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly pluginSlug: string;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly nowMs?: number;
    readonly tenantDb?: D1Database | null;
  },
): Promise<PluginTenantEntitlementRecord> {
  try {
    const slug = assertValidPluginStoreSlug(input.pluginSlug, "pluginSlug");
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const tenantCtx = await resolveTenantAgencyContext(platformDb, input.tenantId);
    if (!tenantCtx) {
      throw new PluginStoreError(404, "TENANT_NOT_FOUND", "Situs tidak ditemukan.");
    }

    const catalog = await getPluginCatalogItem(platformDb, slug);
    if (!catalog || !catalog.active) {
      throw new PluginStoreError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
    }

    const [activeGrant, existingEntRow] = await Promise.all([
      findActivePluginPrivateGrantForTenant(platformDb, {
        pluginSlug: slug,
        tenantId: input.tenantId,
        owningAgencyId: tenantCtx.owningAgencyId,
        owningAgencyActive: tenantCtx.owningAgencyActive,
      }),
      platformDb
        .prepare(
          "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
        )
        .bind(input.tenantId, slug)
        .first<RawEntitlementRow>(),
    ]);

    const existingEnt = existingEntRow ? mapEntitlementRow(existingEntRow) : null;
    const access = evaluatePluginStoreAccess({
      visibilityTier: catalog.visibilityTier,
      billingModel: catalog.billingModel,
      active: catalog.active,
      owningAgencyId: tenantCtx.owningAgencyId,
      directGrantActive: activeGrant?.scope === "tenant",
      agencyGrantActive: activeGrant?.scope === "agency",
      entitlement: existingEnt
        ? {
            status: existingEnt.status,
            enabled: existingEnt.enabled,
            sourceKind: existingEnt.sourceKind,
            expiresAtMs: existingEnt.expiresAtMs,
          }
        : null,
      nowMs,
    });

    if (!access.visible) {
      // NEVER disclose existence of ungranted `private_client` plugins
      throw new PluginStoreError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
    }

    if (!access.entitled) {
      if (access.checkoutBlockCode === "AGENCY_PAYER_ONLY") {
        throw new PluginStoreError(
          403,
          "AGENCY_PAYER_ONLY",
          "Add-on plugin berbayar untuk situs klien dikelola dan dibayar melalui Portal Agensi.",
        );
      }
      throw new PluginStoreError(
        403,
        "ENTITLEMENT_REQUIRED",
        `Plugin "${catalog.name}" memerlukan lisensi aktif sebelum dipasang.`,
      );
    }

    const sourceKind: PluginEntitlementSourceKind =
      existingEnt &&
      (existingEnt.sourceKind === "paid_once" ||
        existingEnt.sourceKind === "paid_monthly" ||
        existingEnt.sourceKind === "paid_yearly") &&
      (existingEnt.expiresAtMs === null || existingEnt.expiresAtMs > nowMs)
        ? existingEnt.sourceKind
        : activeGrant !== null
          ? "private_grant"
          : "public_free";

    const payerKind: PluginPayerKind =
      existingEnt?.payerKind ?? (tenantCtx.owningAgencyId ? "agency" : "tenant");
    const payerAgencyId = payerKind === "agency" ? tenantCtx.owningAgencyId : null;
    const expiresAtMs = existingEnt?.expiresAtMs ?? null;
    const entId = existingEnt?.id ?? `plgent_${generateBillingUlid(nowMs)}`;

    await platformDb
      .prepare(
        `INSERT INTO plugin_tenant_entitlements (
           id, tenant_id, plugin_slug, source_kind, payer_kind, payer_agency_id,
           status, enabled, expires_at, last_payment_attempt_id, last_receipt_id,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL, NULL, 1, ?, ?)
         ON CONFLICT(tenant_id, plugin_slug) DO UPDATE SET
           source_kind = excluded.source_kind,
           status = 'active',
           enabled = 1,
           version = plugin_tenant_entitlements.version + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        entId,
        input.tenantId,
        slug,
        sourceKind,
        payerKind,
        payerAgencyId,
        expiresAtMs,
        nowMs,
        nowMs,
      )
      .run();

    await syncLegacyTenantPluginEntitlement(platformDb, {
      tenantId: input.tenantId,
      pluginSlug: slug,
      status: "active",
      grantedBy: input.actorUserId,
      expiresAtMs,
      nowMs,
    });

    if (input.tenantDb) {
      try {
        await input.tenantDb
          .prepare(
            `INSERT INTO installed_plugins (
               plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
             ) VALUES (?, '1.0.0', 1, '{}', 0, ?, ?)
             ON CONFLICT(plugin_id) DO UPDATE SET
               enabled = 1,
               updated_at = excluded.updated_at`,
          )
          .bind(slug, nowMs, nowMs)
          .run();
      } catch (err) {
        if (!isMissingTableOrColumnError(err)) throw err;
      }
    }

    const row = await platformDb
      .prepare(
        "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
      )
      .bind(input.tenantId, slug)
      .first<RawEntitlementRow>();
    if (!row) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat lisensi plugin.");
    }
    return mapEntitlementRow(row);
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

/**
 * Disables a plugin on a tenant (`enabled = 0, status = 'disabled'`).
 * DATA PRESERVATION INVARIANT: NEVER drops or deletes `plg_*` tables or rows!
 */
export async function disableStorePlugin(
  platformDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly pluginSlug: string;
    readonly nowMs?: number;
    readonly tenantDb?: D1Database | null;
  },
): Promise<PluginTenantEntitlementRecord> {
  const slug = assertValidPluginStoreSlug(input.pluginSlug, "pluginSlug");
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const existing = await platformDb
    .prepare(
      "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
    )
    .bind(input.tenantId, slug)
    .first<RawEntitlementRow>();
  if (!existing) {
    throw new PluginStoreError(404, "NOT_FOUND", "Plugin belum terpasang pada situs ini.");
  }

  await platformDb
    .prepare(
      `UPDATE plugin_tenant_entitlements
       SET status = CASE WHEN status = 'active' THEN 'disabled' ELSE status END,
           enabled = 0,
           version = version + 1,
           updated_at = ?
       WHERE tenant_id = ? AND plugin_slug = ?`,
    )
    .bind(nowMs, input.tenantId, slug)
    .run();

  if (input.tenantDb) {
    // Strictly sets `enabled = 0`; NEVER drops or deletes `plg_*` tables/rows!
    await input.tenantDb
      .prepare("UPDATE installed_plugins SET enabled = 0, updated_at = ? WHERE plugin_id = ?")
      .bind(nowMs, slug)
      .run();
  }

  const updated = await platformDb
    .prepare(
      "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
    )
    .bind(input.tenantId, slug)
    .first<RawEntitlementRow>();
  if (!updated) {
    throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memperbarui status plugin.");
  }
  return mapEntitlementRow(updated);
}

export interface ExpireLapsedPluginAddonsResult {
  readonly evaluatedAtMs: number;
  readonly expiredCount: number;
  readonly expiredEntitlements: readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly pluginSlug: string;
    readonly expiresAtMs: number;
  }[];
}

/**
 * Cleanly deactivates lapsed `paid_monthly`/`paid_yearly` add-on entitlements
 * (`status = 'expired', enabled = 0`) WITHOUT deleting any `plg_*` data rows in `TenantStore`
 * (preserved read-only until `H+45` tenant purge).
 */
export async function expireLapsedPluginAddons(
  platformDb: D1Database,
  options: {
    readonly nowMs?: number;
    readonly limit?: number;
    readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
    readonly requestId?: string | null;
  } = {},
): Promise<ExpireLapsedPluginAddonsResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 200)));

  const lapsedRes = await platformDb
    .prepare(
      `SELECT id, tenant_id, plugin_slug, expires_at
       FROM plugin_tenant_entitlements
       WHERE status = 'active'
         AND source_kind IN ('paid_monthly', 'paid_yearly')
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT ?`,
    )
    .bind(nowMs, limit)
    .all<{
      readonly id: string;
      readonly tenant_id: string;
      readonly plugin_slug: string;
      readonly expires_at: number;
    }>();

  const expiredEntitlements: {
    readonly id: string;
    readonly tenantId: string;
    readonly pluginSlug: string;
    readonly expiresAtMs: number;
  }[] = [];

  for (const row of lapsedRes.results ?? []) {
    const auditId = generatePlatformAuditId(nowMs);
    const batchRes = await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE plugin_tenant_entitlements
           SET status = 'expired',
               enabled = 0,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .bind(nowMs, row.id, nowMs),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, NULL, 'system', 'billing.plugin_addon.expired', 'plugin_tenant_entitlement', ?, ?,
                  'Masa aktif add-on plugin berakhir; dinonaktifkan dengan data plg_* tetap terjaga.',
                  'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          row.id,
          row.tenant_id,
          options.requestId ?? null,
          JSON.stringify({
            pluginSlug: row.plugin_slug,
            expiresAtMs: Number(row.expires_at),
            plgDataPreserved: true,
          }),
          nowMs,
        ),
    ]);

    if ((batchRes[0]?.meta?.changes ?? 0) === 1) {
      await syncLegacyTenantPluginEntitlement(platformDb, {
        tenantId: row.tenant_id,
        pluginSlug: row.plugin_slug,
        status: "expired",
        grantedBy: null,
        expiresAtMs: Number(row.expires_at),
        nowMs,
      });

      if (options.resolveTenantDb) {
        const tenantDb = options.resolveTenantDb(row.tenant_id);
        if (tenantDb) {
          // Set `installed_plugins.enabled = 0` ONLY — ZERO deletes/drops on `plg_*` tables!
          await tenantDb
            .prepare("UPDATE installed_plugins SET enabled = 0, updated_at = ? WHERE plugin_id = ?")
            .bind(nowMs, row.plugin_slug)
            .run();
        }
      }

      expiredEntitlements.push({
        id: row.id,
        tenantId: row.tenant_id,
        pluginSlug: row.plugin_slug,
        expiresAtMs: Number(row.expires_at),
      });
    }
  }

  return {
    evaluatedAtMs: nowMs,
    expiredCount: expiredEntitlements.length,
    expiredEntitlements,
  };
}

// ---------------------------------------------------------------------------
// 4. AutoLaris Add-on Checkout, Atomic Settlement & Immutable PDF Receipts
// ---------------------------------------------------------------------------

async function resolveValidatedPromoCoupon(
  platformDb: D1Database,
  params: {
    readonly couponCode: string | null | undefined;
    readonly payerKind: PluginPayerKind;
    readonly nowMs: number;
  },
): Promise<{ readonly id: string; readonly rule: PluginAddonCouponRule } | null> {
  const cleanCode = params.couponCode?.trim().toUpperCase() || "";
  if (!cleanCode) return null;

  let row: RawCouponRow | null;
  try {
    row = await platformDb
      .prepare(
        `SELECT id, code, discount_kind, discount_value, eligible_payer_types_json,
                max_redemptions, redeemed_count, starts_at, ends_at, active
         FROM promo_coupons
         WHERE UPPER(code) = ?
         LIMIT 1`,
      )
      .bind(cleanCode)
      .first<RawCouponRow>();
  } catch (err) {
    if (isMissingTableOrColumnError(err)) {
      throw new PluginStoreError(422, "COUPON_INVALID", `Kode kupon "${cleanCode}" tidak valid.`);
    }
    throw err;
  }

  if (!row || row.active !== 1) {
    throw new PluginStoreError(422, "COUPON_INVALID", `Kode kupon "${cleanCode}" tidak aktif.`);
  }
  if (params.nowMs < Number(row.starts_at) || params.nowMs > Number(row.ends_at)) {
    throw new PluginStoreError(
      422,
      "COUPON_EXPIRED",
      `Kode kupon "${cleanCode}" di luar masa berlaku.`,
    );
  }
  if (row.max_redemptions !== null && Number(row.redeemed_count) >= Number(row.max_redemptions)) {
    throw new PluginStoreError(422, "COUPON_EXHAUSTED", `Kuota kupon "${cleanCode}" sudah habis.`);
  }

  if (row.eligible_payer_types_json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.eligible_payer_types_json);
    } catch {
      throw new PluginStoreError(
        422,
        "INVALID_COUPON",
        `Konfigurasi kupon "${cleanCode}" tidak valid.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new PluginStoreError(
        422,
        "INVALID_COUPON",
        `Konfigurasi kupon "${cleanCode}" tidak valid.`,
      );
    }
    if (parsed.length > 0 && !parsed.includes(params.payerKind)) {
      throw new PluginStoreError(
        422,
        "COUPON_INELIGIBLE_PAYER",
        `Kode kupon "${cleanCode}" tidak berlaku untuk jenis pembayar ini.`,
      );
    }
  }

  return {
    id: row.id,
    rule: {
      code: row.code.toUpperCase(),
      discountKind: row.discount_kind,
      discountValue: Number(row.discount_value),
    },
  };
}

async function resolveAgencyDiscountPercentForAgency(
  platformDb: D1Database,
  agencyId: string,
): Promise<number> {
  try {
    const ag = await platformDb
      .prepare("SELECT discount_percent, discount_tiers_json, status FROM agencies WHERE id = ? LIMIT 1")
      .bind(agencyId)
      .first<{
        readonly discount_percent: number;
        readonly discount_tiers_json?: string | null;
        readonly status: string;
      }>();
    if (!ag || ag.status !== "active") return 0;

    let paidClients = 0;
    try {
      const countRow = await platformDb
        .prepare(
          `SELECT COUNT(DISTINCT t.id) AS cnt
           FROM tenants t
           WHERE t.agency_id = ? AND t.status IN ('active', 'grace', 'locked')`,
        )
        .bind(agencyId)
        .first<{ readonly cnt: number }>();
      paidClients = Number(countRow?.cnt ?? 0);
    } catch {
      paidClients = 0;
    }

    const tiers = parseStoredDiscountTiersJson(ag.discount_tiers_json ?? null);
    return computeEffectiveAgencyDiscountPercent({
      baseDiscountPercent: Number(ag.discount_percent ?? 0),
      discountTiers: tiers,
      paidClientCount: paidClients,
    }).effectiveDiscountPercent;
  } catch (err) {
    if (isMissingTableOrColumnError(err)) {
      const ag = await platformDb
        .prepare("SELECT discount_percent, status FROM agencies WHERE id = ? LIMIT 1")
        .bind(agencyId)
        .first<{ readonly discount_percent: number; readonly status: string }>();
      return ag && ag.status === "active" ? Number(ag.discount_percent ?? 0) : 0;
    }
    throw err;
  }
}

function buildPluginAddonSandboxInstructions(params: {
  readonly channelCode: string;
  readonly paymentAttemptId: string;
  readonly providerReffId: string;
  readonly totalPayableIdr: number;
  readonly expiresAtMs: number;
}): Record<string, unknown> {
  if (params.channelCode === "QRIS") {
    return {
      mode: "sandbox_stub",
      method: "QRIS",
      qrisPayload: `00020101021226660014ID.PUNYASITUS01189360050300000898240214${params.providerReffId}5204573453033605406${params.totalPayableIdr}5802ID5910PUNYASITUS6007JAKARTA6304PLG1`,
      paymentAttemptId: params.paymentAttemptId,
      providerReffId: params.providerReffId,
      totalPayableIdr: params.totalPayableIdr,
      expiresAt: new Date(params.expiresAtMs).toISOString(),
    };
  }
  const bankName = params.channelCode.replace(/^VA_/, "");
  const digits = params.providerReffId.replace(/\D/g, "").padEnd(10, "8").slice(0, 10);
  return {
    mode: "sandbox_stub",
    method: "VA",
    bankName,
    virtualAccountNumber: `8802${digits}`,
    paymentAttemptId: params.paymentAttemptId,
    providerReffId: params.providerReffId,
    totalPayableIdr: params.totalPayableIdr,
    expiresAt: new Date(params.expiresAtMs).toISOString(),
  };
}

export interface CreatePluginAddonOrderInput {
  readonly tenantId: string;
  readonly pluginSlug: string;
  readonly payerKind: PluginPayerKind;
  readonly payerAgencyId?: string | null;
  readonly payerUserId: string;
  readonly channelCode?: string;
  readonly couponCode?: string | null;
  readonly idempotencyKey: string;
  readonly providerAccountId?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function createPluginAddonOrder(
  platformDb: D1Database,
  input: CreatePluginAddonOrderInput,
): Promise<{
  readonly order: PluginAddonOrderRecord;
  readonly item: PluginCatalogItemRecord;
  readonly idempotentReplay: boolean;
}> {
  try {
    const slug = assertValidPluginStoreSlug(input.pluginSlug, "pluginSlug");
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const cleanIdemKey = input.idempotencyKey.trim();
    if (!cleanIdemKey || cleanIdemKey.length < 8 || cleanIdemKey.length > 128) {
      throw new PluginStoreError(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key wajib berupa string 8 hingga 128 karakter.",
      );
    }

    const tenantCtx = await resolveTenantAgencyContext(platformDb, input.tenantId);
    if (!tenantCtx) {
      throw new PluginStoreError(404, "NOT_FOUND", "Situs tidak ditemukan.");
    }

    // CRITICAL AGENCY BILLING BOUNDARY ENFORCEMENT:
    // 1. Agency-managed client tenants can NEVER initiate self-serve tenant checkout (`403 AGENCY_PAYER_ONLY`).
    // 2. Agency checkout MUST target a client owned by that exact agency (`404 NOT_FOUND` on cross-agency client!).
    if (input.payerKind === "tenant") {
      if (tenantCtx.owningAgencyId !== null) {
        throw new PluginStoreError(
          403,
          "AGENCY_PAYER_ONLY",
          "Pembayaran add-on plugin untuk situs klien dikelola langsung oleh agensi Anda.",
        );
      }
    } else {
      const cleanAgencyId = input.payerAgencyId?.trim() || null;
      if (!cleanAgencyId || tenantCtx.owningAgencyId !== cleanAgencyId) {
        throw new PluginStoreError(
          404,
          "NOT_FOUND",
          "Situs klien tidak ditemukan pada agensi ini.",
        );
      }
      if (!tenantCtx.owningAgencyActive) {
        throw new PluginStoreError(
          403,
          "AGENCY_SUSPENDED",
          "Status agensi tidak aktif sehingga tidak dapat melakukan checkout add-on.",
        );
      }
    }

    const item = await getPluginCatalogItem(platformDb, slug);
    if (!item || !item.active) {
      throw new PluginStoreError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
    }
    if (item.visibilityTier === "private_client") {
      throw new PluginStoreError(404, "NOT_FOUND", "Plugin tidak ditemukan.");
    }
    if (item.visibilityTier !== "public_paid" || item.billingModel === "free") {
      throw new PluginStoreError(
        422,
        "PLUGIN_NOT_PAID",
        `Plugin "${item.name}" gratis dan dapat dipasang langsung tanpa checkout.`,
      );
    }

    const channelCode = (input.channelCode ?? "QRIS").trim().toUpperCase();
    const cleanCoupon = input.couponCode?.trim().toUpperCase() || null;

    const requestHash = await computeRequestHash({
      tenantId: input.tenantId,
      pluginSlug: slug,
      payerKind: input.payerKind,
      payerAgencyId: input.payerKind === "agency" ? (input.payerAgencyId?.trim() ?? null) : null,
      channelCode,
      couponCode: cleanCoupon,
    });

    // Idempotent replay check
    const existingByIdem = await platformDb
      .prepare("SELECT * FROM plugin_addon_orders WHERE idempotency_key = ? LIMIT 1")
      .bind(cleanIdemKey)
      .first<RawAddonOrderRow>();
    if (existingByIdem) {
      if (existingByIdem.request_hash !== requestHash || existingByIdem.tenant_id !== input.tenantId) {
        throw new PluginStoreError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key sudah digunakan untuk parameter checkout plugin yang berbeda.",
        );
      }
      return { order: mapAddonOrderRow(existingByIdem), item, idempotentReplay: true };
    }

    // Prevent duplicate purchase for permanent `paid_once` plugin already actively entitled
    if (item.billingModel === "paid_once") {
      const existingEnt = await platformDb
        .prepare(
          `SELECT id, status, source_kind
           FROM plugin_tenant_entitlements
           WHERE tenant_id = ? AND plugin_slug = ? AND status IN ('active', 'disabled')
             AND source_kind = 'paid_once'
           LIMIT 1`,
        )
        .bind(input.tenantId, slug)
        .first<{ readonly id: string }>();
      if (existingEnt) {
        throw new PluginStoreError(
          409,
          "ALREADY_ENTITLED",
          `Situs ini sudah memiliki lisensi permanen untuk plugin "${item.name}".`,
        );
      }
    }

    const [agencyDiscountPercent, validatedCoupon] = await Promise.all([
      input.payerKind === "agency" && input.payerAgencyId
        ? resolveAgencyDiscountPercentForAgency(platformDb, input.payerAgencyId)
        : Promise.resolve(0),
      resolveValidatedPromoCoupon(platformDb, {
        couponCode: cleanCoupon,
        payerKind: input.payerKind,
        nowMs,
      }),
    ]);

    const quote = calculatePluginAddonQuote({
      grossAmountIdr: item.priceIdr,
      billingModel: item.billingModel,
      payerKind: input.payerKind,
      agencyDiscountPercent,
      coupon: validatedCoupon?.rule ?? null,
      channelCode,
    });

    const orderId = `plgord_${generateBillingUlid(nowMs)}`;
    const paymentAttemptId = `plgpat_${generateBillingUlid(nowMs + 1)}`;
    const providerReffId = generateAutoLarisReffId(nowMs);
    const providerAccountId = input.providerAccountId?.trim() || "default";
    const expiresAtMs = nowMs + PLUGIN_ADDON_ORDER_TTL_MS;
    const instructions = buildPluginAddonSandboxInstructions({
      channelCode: quote.channelCode,
      paymentAttemptId,
      providerReffId,
      totalPayableIdr: quote.totalPayableIdr,
      expiresAtMs,
    });

    const auditStmt = buildPlatformAuditStatement(platformDb, {
      actorUserId: input.payerUserId,
      actorRole: input.payerKind === "agency" ? "agency_admin" : "owner",
      action: "billing.plugin_addon.checkout_created",
      targetType: "plugin_addon_order",
      targetId: orderId,
      tenantId: input.tenantId,
      reason: `Checkout add-on plugin ${slug} (${item.billingModel}) via ${quote.channelCode}.`,
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        pluginSlug: slug,
        billingModel: item.billingModel,
        payerKind: input.payerKind,
        payerAgencyId: input.payerKind === "agency" ? input.payerAgencyId : null,
        grossAmountIdr: quote.grossAmountIdr,
        discountAmountIdr: quote.discountAmountIdr,
        netAmountIdr: quote.netAmountIdr,
        channelFeeIdr: quote.channelFeeIdr,
        totalPayableIdr: quote.totalPayableIdr,
      },
      createdAtMs: nowMs,
    });

    try {
      await platformDb.batch([
        platformDb
          .prepare(
            `INSERT INTO plugin_addon_orders (
               id, tenant_id, plugin_slug, billing_model, payer_kind, payer_agency_id, payer_user_id,
               channel_code, gross_amount_idr, discount_amount_idr, coupon_code, channel_fee_idr,
               net_amount_idr, total_payable_idr, provider_account_id, provider_reff_id,
               payment_attempt_id, receipt_id, status, idempotency_key, request_hash,
               payment_instructions_json, expires_at, version, created_at, settled_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, 1, ?, NULL, ?)`,
          )
          .bind(
            orderId,
            input.tenantId,
            slug,
            item.billingModel,
            input.payerKind,
            input.payerKind === "agency" ? (input.payerAgencyId?.trim() ?? null) : null,
            input.payerUserId,
            quote.channelCode,
            quote.grossAmountIdr,
            quote.discountAmountIdr,
            quote.couponCode,
            quote.channelFeeIdr,
            quote.netAmountIdr,
            quote.totalPayableIdr,
            providerAccountId,
            providerReffId,
            paymentAttemptId,
            cleanIdemKey,
            requestHash,
            JSON.stringify(instructions),
            expiresAtMs,
            nowMs,
            nowMs,
          ),
        auditStmt.statement,
      ]);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const raced = await platformDb
          .prepare("SELECT * FROM plugin_addon_orders WHERE idempotency_key = ? LIMIT 1")
          .bind(cleanIdemKey)
          .first<RawAddonOrderRow>();
        if (raced) {
          if (raced.request_hash !== requestHash || raced.tenant_id !== input.tenantId) {
            throw new PluginStoreError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key sudah digunakan untuk parameter checkout plugin yang berbeda.",
            );
          }
          return { order: mapAddonOrderRow(raced), item, idempotentReplay: true };
        }
      }
      throw err;
    }

    const createdRow = await platformDb
      .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? LIMIT 1")
      .bind(orderId)
      .first<RawAddonOrderRow>();
    if (!createdRow) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat pesanan add-on plugin.");
    }

    return {
      order: mapAddonOrderRow(createdRow),
      item,
      idempotentReplay: false,
    };
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

export interface PluginAddonAdvicePort {
  fetchAdvice(query: {
    readonly providerAccountId: string;
    readonly paymentAttemptId: string;
    readonly providerReffId: string;
  }): Promise<RawAutoLarisAdviceObservation>;
}

export interface SettlePluginAddonOrderInput {
  readonly orderId: string;
  readonly tenantId?: string;
  readonly payerAgencyId?: string | null;
  readonly observation: RawAutoLarisAdviceObservation;
  readonly policy?: AdviceSettlementPolicy;
  readonly mediaBucket?: R2Bucket | null;
  readonly tenantDb?: D1Database | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface SettlePluginAddonOrderResult {
  readonly settled: boolean;
  readonly idempotentReplay: boolean;
  readonly decisionKind: "confirmed_paid" | "pending" | "expired" | "failed" | "review";
  readonly safeReasonCode: string;
  readonly order: PluginAddonOrderRecord;
  readonly entitlement: PluginTenantEntitlementRecord | null;
  readonly receipt: PluginAddonReceiptRecord | null;
  readonly pdf: GeneratedPluginAddonReceiptPdf | null;
}

/**
 * Idempotently heals post-commit side effects on an already-settled plugin add-on order:
 * 1. If `mediaBucket` is provided and the PDF object is missing in R2 (e.g. first `r2.put` failed),
 *    regenerates the exact deterministic PDF and uploads it to R2.
 * 2. Re-syncs legacy TASK-097 `tenant_plugin_entitlements` so the runtime stays aligned.
 * 3. Re-syncs optional `TenantStore.installed_plugins` (`enabled = 1`) when entitlement is active.
 */
async function healSettledPluginAddonSideEffects(
  platformDb: D1Database,
  params: {
    readonly order: PluginAddonOrderRecord;
    readonly entitlement: PluginTenantEntitlementRecord | null;
    readonly receipt: PluginAddonReceiptRecord | null;
    readonly mediaBucket?: R2Bucket | null;
    readonly tenantDb?: D1Database | null;
    readonly nowMs: number;
  },
): Promise<GeneratedPluginAddonReceiptPdf | null> {
  let healedPdf: GeneratedPluginAddonReceiptPdf | null = null;
  const { order, entitlement, receipt, mediaBucket, tenantDb, nowMs } = params;

  if (receipt && mediaBucket) {
    const existingObj =
      typeof mediaBucket.head === "function"
        ? await mediaBucket.head(receipt.r2ObjectKey)
        : await mediaBucket.get(receipt.r2ObjectKey);

    if (!existingObj) {
      const tenantRow = await platformDb
        .prepare("SELECT handle FROM tenants WHERE id = ? LIMIT 1")
        .bind(order.tenantId)
        .first<{ readonly handle: string }>();

      healedPdf = await generatePluginAddonReceiptPdf({
        receiptNumber: receipt.receiptNumber,
        issuedAtMs: receipt.issuedAtMs,
        tenantName: receipt.tenantNameSnapshot,
        tenantHandle: tenantRow?.handle ?? order.tenantId,
        payerKind: receipt.payerKind,
        payerName: receipt.payerNameSnapshot,
        pluginSlug: receipt.pluginSlug,
        pluginName: receipt.pluginNameSnapshot,
        billingModel: receipt.billingModel,
        orderId: receipt.orderId,
        grossAmountIdr: receipt.grossAmountIdr,
        discountAmountIdr: receipt.discountAmountIdr,
        channelFeeIdr: receipt.channelFeeIdr,
        totalAmountIdr: receipt.totalAmountIdr,
        couponCode: receipt.couponCode,
        paymentChannel: receipt.paymentChannel,
        providerReference: receipt.providerReference,
        expiresAtMs: entitlement?.expiresAtMs ?? null,
        nonPkpNotice: receipt.nonPkpNotice,
      });

      await mediaBucket.put(healedPdf.r2ObjectKey, healedPdf.bytes, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: {
          receiptId: receipt.id,
          receiptNumber: healedPdf.receiptNumber,
          tenantId: order.tenantId,
          sha256: healedPdf.sha256Hex,
        },
      });
    }
  }

  if (entitlement && entitlement.status === "active") {
    await syncLegacyTenantPluginEntitlement(platformDb, {
      tenantId: order.tenantId,
      pluginSlug: order.pluginSlug,
      status: "active",
      grantedBy: order.payerUserId,
      expiresAtMs: entitlement.expiresAtMs,
      nowMs,
    });

    if (tenantDb && entitlement.enabled) {
      try {
        await tenantDb
          .prepare(
            `INSERT INTO installed_plugins (
               plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
             ) VALUES (?, '1.0.0', 1, '{}', 0, ?, ?)
             ON CONFLICT(plugin_id) DO UPDATE SET
               enabled = 1,
               updated_at = excluded.updated_at`,
          )
          .bind(order.pluginSlug, nowMs, nowMs)
          .run();
      } catch (err) {
        if (!isMissingTableOrColumnError(err)) throw err;
      }
    }
  }

  return healedPdf;
}

/**
 * Atomically settles a `plugin_addon_orders` row after authoritative AutoLaris Advice verification:
 * - Marks order `settled`
 * - Activates or extends `plugin_tenant_entitlements` (`paid_once` permanent, `paid_monthly` +30d, `paid_yearly` +365d)
 *   re-reading live entitlement inside each CAS attempt so concurrent renewals stack cleanly!
 * - Allocates gap-free yearly receipt number (`INV-PLG-YYYY-NNNNNN`) + immutable PDF receipt
 * - Atomically increments `promo_coupons.redeemed_count` inside the SAME `D1Database.batch([...])`
 *   gated on `max_redemptions`
 * - Syncs `tenant_plugin_entitlements` (TASK-097 runtime table) & uploads PDF to R2 (with replay healing!)
 * - Appends `platform_audit`
 * - 100% idempotent on duplicate Advice replays (zero double receipt / zero double expiry extension!).
 */
export async function settlePluginAddonOrder(
  platformDb: D1Database,
  input: SettlePluginAddonOrderInput,
): Promise<SettlePluginAddonOrderResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const policy = input.policy ?? DEFAULT_PRODUCTION_SETTLEMENT_POLICY;

  const orderRow = input.tenantId
    ? await platformDb
        .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? AND tenant_id = ? LIMIT 1")
        .bind(input.orderId, input.tenantId)
        .first<RawAddonOrderRow>()
    : await platformDb
        .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? LIMIT 1")
        .bind(input.orderId)
        .first<RawAddonOrderRow>();

  if (!orderRow) {
    throw new PluginStoreError(404, "ORDER_NOT_FOUND", "Pesanan add-on plugin tidak ditemukan.");
  }
  if (input.payerAgencyId && orderRow.payer_agency_id !== input.payerAgencyId) {
    throw new PluginStoreError(404, "ORDER_NOT_FOUND", "Pesanan add-on plugin tidak ditemukan.");
  }

  const currentOrder = mapAddonOrderRow(orderRow);

  // Fast-path idempotent replay: NEVER bump receipt sequence or double-extend expiry,
  // and heal any missing R2 PDF upload or legacy entitlement sync from a prior partial failure!
  if (currentOrder.status === "settled") {
    const [entRow, recRow] = await Promise.all([
      platformDb
        .prepare(
          "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
        )
        .bind(currentOrder.tenantId, currentOrder.pluginSlug)
        .first<RawEntitlementRow>(),
      currentOrder.receiptId
        ? platformDb
            .prepare("SELECT * FROM plugin_addon_receipts WHERE id = ? LIMIT 1")
            .bind(currentOrder.receiptId)
            .first<RawAddonReceiptRow>()
        : Promise.resolve(null),
    ]);
    const entitlement = entRow ? mapEntitlementRow(entRow) : null;
    const receipt = recRow ? mapAddonReceiptRow(recRow) : null;
    const healedPdf = await healSettledPluginAddonSideEffects(platformDb, {
      order: currentOrder,
      entitlement,
      receipt,
      mediaBucket: input.mediaBucket,
      tenantDb: input.tenantDb,
      nowMs,
    });
    return {
      settled: true,
      idempotentReplay: true,
      decisionKind: "confirmed_paid",
      safeReasonCode: "SETTLEMENT_CONFIRMED",
      order: currentOrder,
      entitlement,
      receipt,
      pdf: healedPdf,
    };
  }

  if (currentOrder.status === "expired" || currentOrder.status === "refunded") {
    return {
      settled: false,
      idempotentReplay: false,
      decisionKind: "expired",
      safeReasonCode: "ORDER_TERMINAL",
      order: currentOrder,
      entitlement: null,
      receipt: null,
      pdf: null,
    };
  }

  // Evaluate authoritative AutoLaris Advice observation
  const decision = evaluateAdviceSettlement({
    expectedProviderTransactionId: currentOrder.paymentAttemptId,
    expectedReffId: currentOrder.providerReffId,
    expectedTotalPayableIdr: currentOrder.totalPayableIdr,
    expectedCurrency: BILLING_CURRENCY,
    observation: input.observation,
    policy,
    nowMs,
  });

  if (decision.kind !== "confirmed_paid") {
    if (decision.kind === "expired" && (policy.allowSettlementGrant || nowMs >= currentOrder.expiresAtMs)) {
      await platformDb
        .prepare(
          `UPDATE plugin_addon_orders
           SET status = 'expired', version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(nowMs, currentOrder.id)
        .run();
    }
    const refreshed = await platformDb
      .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? LIMIT 1")
      .bind(currentOrder.id)
      .first<RawAddonOrderRow>();
    return {
      settled: false,
      idempotentReplay: false,
      decisionKind: decision.kind,
      safeReasonCode: decision.safeReasonCode,
      order: refreshed ? mapAddonOrderRow(refreshed) : currentOrder,
      entitlement: null,
      receipt: null,
      pdf: null,
    };
  }

  // Confirmed paid! Gather static snapshots for immutable receipt PDF
  const [tenantRow, catalogRow, payerUserRow, agencyRow] = await Promise.all([
    platformDb
      .prepare("SELECT id, handle, name FROM tenants WHERE id = ? LIMIT 1")
      .bind(currentOrder.tenantId)
      .first<{ readonly id: string; readonly handle: string; readonly name: string }>(),
    getPluginCatalogItem(platformDb, currentOrder.pluginSlug),
    platformDb
      .prepare("SELECT name, email FROM users WHERE id = ? LIMIT 1")
      .bind(currentOrder.payerUserId)
      .first<{ readonly name: string; readonly email: string }>(),
    currentOrder.payerAgencyId
      ? platformDb
          .prepare("SELECT name FROM agencies WHERE id = ? LIMIT 1")
          .bind(currentOrder.payerAgencyId)
          .first<{ readonly name: string }>()
      : Promise.resolve(null),
  ]);

  const tenantName = tenantRow?.name ?? currentOrder.tenantId;
  const tenantHandle = tenantRow?.handle ?? currentOrder.tenantId;
  const pluginName = catalogRow?.name ?? currentOrder.pluginSlug;
  const payerName =
    currentOrder.payerKind === "agency"
      ? (agencyRow?.name ?? payerUserRow?.name ?? "Agensi PunyaSitus")
      : (payerUserRow?.name ?? tenantName);

  const settledAtMs = nowMs;
  const receiptYear = getWibYearFromEpochMs(settledAtMs);
  const receiptId = `plgrec_${generateBillingUlid(nowMs + 2)}`;
  const normalizedCouponCode = currentOrder.couponCode?.trim().toUpperCase() || null;

  // Optimistic CAS loop on `plugin_addon_receipt_counters` + live `plugin_tenant_entitlements`
  // version + live `promo_coupons` redemption cap (max 5 attempts)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [freshOrder, existingEntRow, counterRow] = await Promise.all([
      platformDb
        .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? LIMIT 1")
        .bind(currentOrder.id)
        .first<RawAddonOrderRow>(),
      platformDb
        .prepare(
          "SELECT * FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ? LIMIT 1",
        )
        .bind(currentOrder.tenantId, currentOrder.pluginSlug)
        .first<RawEntitlementRow>(),
      platformDb
        .prepare("SELECT year, last_seq FROM plugin_addon_receipt_counters WHERE year = ? LIMIT 1")
        .bind(receiptYear)
        .first<{ readonly year: number; readonly last_seq: number }>(),
    ]);

    if (freshOrder && freshOrder.status === "settled") {
      const recRow = freshOrder.receipt_id
        ? await platformDb
            .prepare("SELECT * FROM plugin_addon_receipts WHERE id = ? LIMIT 1")
            .bind(freshOrder.receipt_id)
            .first<RawAddonReceiptRow>()
        : null;
      const mappedOrder = mapAddonOrderRow(freshOrder);
      const entitlement = existingEntRow ? mapEntitlementRow(existingEntRow) : null;
      const receipt = recRow ? mapAddonReceiptRow(recRow) : null;
      const healedPdf = await healSettledPluginAddonSideEffects(platformDb, {
        order: mappedOrder,
        entitlement,
        receipt,
        mediaBucket: input.mediaBucket,
        tenantDb: input.tenantDb,
        nowMs,
      });
      return {
        settled: true,
        idempotentReplay: true,
        decisionKind: "confirmed_paid",
        safeReasonCode: "SETTLEMENT_CONFIRMED",
        order: mappedOrder,
        entitlement,
        receipt,
        pdf: healedPdf,
      };
    }

    // Re-check coupon availability BEFORE allocating a receipt sequence (fail closed on exhaustion)
    if (normalizedCouponCode) {
      const couponRow = await platformDb
        .prepare(
          `SELECT id, active, max_redemptions, redeemed_count
           FROM promo_coupons
           WHERE UPPER(code) = ?
           LIMIT 1`,
        )
        .bind(normalizedCouponCode)
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
        throw new PluginStoreError(
          409,
          "COUPON_EXHAUSTED",
          `Kuota kupon promo "${normalizedCouponCode}" sudah habis sebelum pelunasan.`,
        );
      }
    }

    // Recompute live `entId` and stacked `nextExpiresAtMs` inside every CAS iteration
    const entId = existingEntRow?.id ?? `plgent_${generateBillingUlid(nowMs + 3 + attempt)}`;
    const nextExpiresAtMs = computePluginEntitlementExpiryMs({
      billingModel: currentOrder.billingModel,
      nowMs: settledAtMs,
      existingExpiresAtMs: existingEntRow?.expires_at ?? null,
    });

    const expectedSeq = counterRow ? Number(counterRow.last_seq) : 0;
    const nextSeq = expectedSeq + 1;
    const receiptNumber = formatPluginAddonReceiptNumber(receiptYear, nextSeq);

    const pdf = await generatePluginAddonReceiptPdf({
      receiptNumber,
      issuedAtMs: settledAtMs,
      tenantName,
      tenantHandle,
      payerKind: currentOrder.payerKind,
      payerName,
      pluginSlug: currentOrder.pluginSlug,
      pluginName,
      billingModel: currentOrder.billingModel,
      orderId: currentOrder.id,
      grossAmountIdr: currentOrder.grossAmountIdr,
      discountAmountIdr: currentOrder.discountAmountIdr,
      channelFeeIdr: currentOrder.channelFeeIdr,
      totalAmountIdr: currentOrder.totalPayableIdr,
      couponCode: currentOrder.couponCode,
      paymentChannel: currentOrder.channelCode,
      providerReference: decision.providerTransactionId,
      expiresAtMs: nextExpiresAtMs,
      nonPkpNotice: RECEIPT_NON_PKP_NOTICE,
    });

    const batch: D1PreparedStatement[] = [];

    // Guard counter CAS on:
    // - order STILL `pending`
    // - entitlement STILL at `existingEntRow.version` (or still absent if inserting) so we NEVER
    //   burn a receipt sequence if a concurrent install/renewal modifies the entitlement first!
    // - coupon (if used) STILL active and under `max_redemptions`!
    const entGuardSql = existingEntRow
      ? ` AND EXISTS (SELECT 1 FROM plugin_tenant_entitlements WHERE id = ? AND version = ?)`
      : ` AND NOT EXISTS (SELECT 1 FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = ?)`;
    const entGuardBinds: unknown[] = existingEntRow
      ? [existingEntRow.id, existingEntRow.version]
      : [currentOrder.tenantId, currentOrder.pluginSlug];

    const couponGuardSql = normalizedCouponCode
      ? ` AND EXISTS (
            SELECT 1 FROM promo_coupons
            WHERE UPPER(code) = ? AND active = 1
              AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
          )`
      : "";
    const couponGuardBinds: unknown[] = normalizedCouponCode ? [normalizedCouponCode] : [];

    // 1. Atomic CAS counter increment
    if (counterRow) {
      batch.push(
        platformDb
          .prepare(
            `UPDATE plugin_addon_receipt_counters
             SET last_seq = ?, updated_at = ?
             WHERE year = ? AND last_seq = ?
               AND EXISTS (SELECT 1 FROM plugin_addon_orders WHERE id = ? AND status = 'pending')${entGuardSql}${couponGuardSql}`,
          )
          .bind(
            nextSeq,
            nowMs,
            receiptYear,
            expectedSeq,
            currentOrder.id,
            ...entGuardBinds,
            ...couponGuardBinds,
          ),
      );
    } else {
      batch.push(
        platformDb
          .prepare(
            `INSERT INTO plugin_addon_receipt_counters (year, last_seq, updated_at)
             SELECT ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM plugin_addon_receipt_counters WHERE year = ?)
               AND EXISTS (SELECT 1 FROM plugin_addon_orders WHERE id = ? AND status = 'pending')${entGuardSql}${couponGuardSql}`,
          )
          .bind(
            receiptYear,
            nextSeq,
            nowMs,
            receiptYear,
            currentOrder.id,
            ...entGuardBinds,
            ...couponGuardBinds,
          ),
      );
    }

    // 2. Upsert `plugin_tenant_entitlements` ONLY when counter CAS succeeded (`changes() = 1`)
    if (existingEntRow) {
      batch.push(
        platformDb
          .prepare(
            `UPDATE plugin_tenant_entitlements
             SET source_kind = ?,
                 payer_kind = ?,
                 payer_agency_id = ?,
                 status = 'active',
                 enabled = 1,
                 expires_at = ?,
                 last_payment_attempt_id = ?,
                 last_receipt_id = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND changes() = 1`,
          )
          .bind(
            currentOrder.billingModel,
            currentOrder.payerKind,
            currentOrder.payerAgencyId,
            nextExpiresAtMs,
            currentOrder.paymentAttemptId,
            receiptId,
            nowMs,
            entId,
            existingEntRow.version,
          ),
      );
    } else {
      batch.push(
        platformDb
          .prepare(
            `INSERT INTO plugin_tenant_entitlements (
               id, tenant_id, plugin_slug, source_kind, payer_kind, payer_agency_id,
               status, enabled, expires_at, last_payment_attempt_id, last_receipt_id,
               version, created_at, updated_at
             )
             SELECT ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, 1, ?, ?
             WHERE changes() = 1`,
          )
          .bind(
            entId,
            currentOrder.tenantId,
            currentOrder.pluginSlug,
            currentOrder.billingModel,
            currentOrder.payerKind,
            currentOrder.payerAgencyId,
            nextExpiresAtMs,
            currentOrder.paymentAttemptId,
            receiptId,
            nowMs,
            nowMs,
          ),
      );
    }

    // 3. Insert immutable numbered receipt row gated on entitlement update & order pending
    batch.push(
      platformDb
        .prepare(
          `INSERT INTO plugin_addon_receipts (
             id, receipt_number, tenant_id, payer_kind, payer_agency_id, payer_user_id,
             tenant_name_snapshot, payer_name_snapshot, plugin_slug, plugin_name_snapshot,
             billing_model, order_id, entitlement_id, currency, gross_amount_idr,
             discount_amount_idr, channel_fee_idr, total_amount_idr, coupon_code,
             payment_channel, provider_reference, r2_object_key, pdf_sha256,
             pdf_byte_length, non_pkp_notice, issued_at, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM plugin_tenant_entitlements WHERE id = ? AND last_receipt_id = ?)
             AND EXISTS (SELECT 1 FROM plugin_addon_orders WHERE id = ? AND status = 'pending')`,
        )
        .bind(
          receiptId,
          pdf.receiptNumber,
          currentOrder.tenantId,
          currentOrder.payerKind,
          currentOrder.payerAgencyId,
          currentOrder.payerUserId,
          tenantName,
          payerName,
          currentOrder.pluginSlug,
          pluginName,
          currentOrder.billingModel,
          currentOrder.id,
          entId,
          currentOrder.grossAmountIdr,
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
          entId,
          receiptId,
          currentOrder.id,
        ),
    );

    // 4. Mark order `settled`
    batch.push(
      platformDb
        .prepare(
          `UPDATE plugin_addon_orders
           SET status = 'settled',
               receipt_id = ?,
               settled_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM plugin_addon_receipts WHERE id = ?)`,
        )
        .bind(receiptId, settledAtMs, nowMs, currentOrder.id, receiptId),
    );

    // 5. Append `platform_audit` gated on order transition (`changes() = 1`)
    const auditId = generatePlatformAuditId(nowMs);
    batch.push(
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'billing.plugin_addon.settled', 'plugin_addon_order', ?, ?,
                  ?, 'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          currentOrder.payerUserId,
          currentOrder.payerKind === "agency" ? "agency_admin" : "owner",
          currentOrder.id,
          currentOrder.tenantId,
          `Pelunasan add-on plugin ${currentOrder.pluginSlug} (${pdf.receiptNumber}).`,
          input.requestId ?? null,
          JSON.stringify({
            pluginSlug: currentOrder.pluginSlug,
            billingModel: currentOrder.billingModel,
            receiptNumber: pdf.receiptNumber,
            netAmountIdr: currentOrder.netAmountIdr,
            totalPayableIdr: currentOrder.totalPayableIdr,
            expiresAtMs: nextExpiresAtMs,
          }),
          nowMs,
        ),
    );

    // 6. Atomically increment `promo_coupons.redeemed_count` INSIDE the same settlement batch!
    if (normalizedCouponCode) {
      batch.push(
        platformDb
          .prepare(
            `UPDATE promo_coupons
             SET redeemed_count = redeemed_count + 1, updated_at = ?
             WHERE UPPER(code) = ?
               AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
               AND EXISTS (
                 SELECT 1 FROM plugin_addon_orders
                 WHERE id = ? AND status = 'settled' AND receipt_id = ?
               )`,
          )
          .bind(nowMs, normalizedCouponCode, currentOrder.id, receiptId),
      );
    }

    let batchResults: D1Result[];
    try {
      batchResults = await platformDb.batch(batch);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        continue;
      }
      throw err;
    }

    const orderUpdated = (batchResults[3]?.meta?.changes ?? 0) === 1;
    if (!orderUpdated) {
      continue;
    }

    // Upload PDF receipt to R2 if mediaBucket provided (re-tried cleanly on replay if it fails)
    if (input.mediaBucket) {
      await input.mediaBucket.put(pdf.r2ObjectKey, pdf.bytes, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: {
          receiptId,
          receiptNumber: pdf.receiptNumber,
          tenantId: currentOrder.tenantId,
          sha256: pdf.sha256Hex,
        },
      });
    }

    // Sync TASK-097 runtime entitlement & optional TenantStore installed_plugins
    await syncLegacyTenantPluginEntitlement(platformDb, {
      tenantId: currentOrder.tenantId,
      pluginSlug: currentOrder.pluginSlug,
      status: "active",
      grantedBy: currentOrder.payerUserId,
      expiresAtMs: nextExpiresAtMs,
      nowMs,
    });

    if (input.tenantDb) {
      try {
        await input.tenantDb
          .prepare(
            `INSERT INTO installed_plugins (
               plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
             ) VALUES (?, '1.0.0', 1, '{}', 0, ?, ?)
             ON CONFLICT(plugin_id) DO UPDATE SET
               enabled = 1,
               updated_at = excluded.updated_at`,
          )
          .bind(currentOrder.pluginSlug, nowMs, nowMs)
          .run();
      } catch (err) {
        if (!isMissingTableOrColumnError(err)) throw err;
      }
    }

    const [settledOrder, settledEnt, settledRec] = await Promise.all([
      platformDb
        .prepare("SELECT * FROM plugin_addon_orders WHERE id = ? LIMIT 1")
        .bind(currentOrder.id)
        .first<RawAddonOrderRow>(),
      platformDb
        .prepare("SELECT * FROM plugin_tenant_entitlements WHERE id = ? LIMIT 1")
        .bind(entId)
        .first<RawEntitlementRow>(),
      platformDb
        .prepare("SELECT * FROM plugin_addon_receipts WHERE id = ? LIMIT 1")
        .bind(receiptId)
        .first<RawAddonReceiptRow>(),
    ]);

    return {
      settled: true,
      idempotentReplay: false,
      decisionKind: "confirmed_paid",
      safeReasonCode: "SETTLEMENT_CONFIRMED",
      order: settledOrder ? mapAddonOrderRow(settledOrder) : currentOrder,
      entitlement: settledEnt ? mapEntitlementRow(settledEnt) : null,
      receipt: settledRec ? mapAddonReceiptRow(settledRec) : null,
      pdf,
    };
  }

  throw new PluginStoreError(
    409,
    "SETTLEMENT_CONTENTION",
    "Terjadi benturan konkurensi saat menerbitkan nomor kuitansi. Silakan coba lagi.",
  );
}

export async function getPluginAddonReceiptById(
  platformDb: D1Database,
  receiptId: string,
): Promise<PluginAddonReceiptRecord | null> {
  const row = await platformDb
    .prepare("SELECT * FROM plugin_addon_receipts WHERE id = ? LIMIT 1")
    .bind(receiptId.trim())
    .first<RawAddonReceiptRow>();
  return row ? mapAddonReceiptRow(row) : null;
}

export async function listAgencyPluginStoreOverview(
  platformDb: D1Database,
  agencyId: string,
  options: { readonly nowMs?: number } = {},
): Promise<{
  readonly agencyId: string;
  readonly effectiveDiscountPercent: number;
  readonly paidPlugins: readonly PluginCatalogItemRecord[];
  readonly privateGrants: readonly PluginPrivateGrantRecord[];
  readonly entitlements: readonly PluginTenantEntitlementRecord[];
  readonly orders: readonly PluginAddonOrderRecord[];
  readonly receipts: readonly PluginAddonReceiptRecord[];
}> {
  const cleanAgencyId = agencyId.trim();
  const [discountPct, paidPlugins, grants, entRes, ordersRes, receiptsRes] = await Promise.all([
    resolveAgencyDiscountPercentForAgency(platformDb, cleanAgencyId),
    listPluginCatalogItems(platformDb, { includeInactive: false, visibilityTier: "public_paid" }),
    listPluginPrivateGrants(platformDb, { agencyId: cleanAgencyId, status: "active" }),
    platformDb
      .prepare(
        `SELECT e.*
         FROM plugin_tenant_entitlements e
         INNER JOIN tenants t ON t.id = e.tenant_id
         WHERE t.agency_id = ? OR e.payer_agency_id = ?
         ORDER BY e.updated_at DESC
         LIMIT 200`,
      )
      .bind(cleanAgencyId, cleanAgencyId)
      .all<RawEntitlementRow>(),
    platformDb
      .prepare(
        "SELECT * FROM plugin_addon_orders WHERE payer_agency_id = ? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(cleanAgencyId)
      .all<RawAddonOrderRow>(),
    platformDb
      .prepare(
        "SELECT * FROM plugin_addon_receipts WHERE payer_agency_id = ? ORDER BY issued_at DESC LIMIT 100",
      )
      .bind(cleanAgencyId)
      .all<RawAddonReceiptRow>(),
  ]);

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const entitlements = (entRes.results ?? []).map((r) => {
    const mapped = mapEntitlementRow(r);
    if (mapped.status === "active" && mapped.expiresAtMs !== null && mapped.expiresAtMs <= nowMs) {
      return { ...mapped, status: "expired" as const, enabled: false };
    }
    return mapped;
  });

  return {
    agencyId: cleanAgencyId,
    effectiveDiscountPercent: discountPct,
    paidPlugins,
    privateGrants: grants,
    entitlements,
    orders: (ordersRes.results ?? []).map(mapAddonOrderRow),
    receipts: (receiptsRes.results ?? []).map(mapAddonReceiptRow),
  };
}

// ---------------------------------------------------------------------------
// 5. Custom Plugin Development Requests (`service_kind = "custom_plugin"`)
// ---------------------------------------------------------------------------

export interface SubmitCustomPluginDevRequestInput {
  readonly tenantId: string;
  readonly requestedByUserId: string;
  readonly actorRole: string;
  readonly rawBody: Record<string, unknown>;
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function submitCustomPluginDevRequest(
  platformDb: D1Database,
  input: SubmitCustomPluginDevRequestInput,
): Promise<{ readonly request: PluginCustomDevRequestRecord; readonly created: boolean }> {
  try {
    const validated = validateCustomPluginRequestInput(input.rawBody);
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const dayBucket = getWibDayBucket(nowMs);
    const cleanIdem = input.idempotencyKey?.trim() || null;

    if (cleanIdem) {
      const existing = await platformDb
        .prepare(
          `SELECT * FROM plugin_custom_dev_requests
           WHERE tenant_id = ? AND idempotency_key = ?
           LIMIT 1`,
        )
        .bind(input.tenantId, cleanIdem)
        .first<RawCustomDevRequestRow>();
      if (existing) {
        return { request: mapCustomDevRequestRow(existing), created: false };
      }
    }

    const id = `plgreq_${generateBillingUlid(nowMs)}`;
    const codeSuffix = id.slice(-6).toUpperCase();
    const requestCode = `PLG-${dayBucket.replace(/-/g, "")}-${codeSuffix}`;
    const auditId = generatePlatformAuditId(nowMs);

    // Atomic SQL daily quota enforcement (`COUNT(*) < 3`) + conditional `platform_audit`
    const batchRes = await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO plugin_custom_dev_requests (
             id, request_code, tenant_id, requested_by_user_id, service_kind,
             title, requirements_summary, contact_whatsapp, budget_range,
             status, quote_amount_idr, operator_notes, status_reason,
             linked_grant_id, linked_plugin_slug, idempotency_key, day_bucket,
             version, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'custom_plugin', ?, ?, ?, ?, 'submitted', NULL, NULL, NULL,
                  NULL, NULL, ?, ?, 1, ?, ?
           WHERE (
             SELECT COUNT(*) FROM plugin_custom_dev_requests
             WHERE tenant_id = ? AND day_bucket = ?
           ) < ?`,
        )
        .bind(
          id,
          requestCode,
          input.tenantId,
          input.requestedByUserId,
          validated.title,
          validated.requirementsSummary,
          validated.contactWhatsapp,
          validated.budgetRange,
          cleanIdem,
          dayBucket,
          nowMs,
          nowMs,
          input.tenantId,
          dayBucket,
          PLUGIN_CUSTOM_DEV_DAILY_LIMIT,
        ),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'tenant.custom_plugin_request.submit', 'plugin_custom_dev_request', ?, ?,
                  ?, 'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          input.requestedByUserId,
          input.actorRole,
          id,
          input.tenantId,
          `Permintaan plugin kustom (${requestCode}) dikirim.`,
          input.requestId ?? null,
          JSON.stringify({ serviceKind: "custom_plugin", requestCode, dayBucket }),
          nowMs,
        ),
    ]);

    if ((batchRes[0]?.meta?.changes ?? 0) !== 1) {
      throw new PluginStoreError(
        429,
        "DAILY_REQUEST_LIMIT_REACHED",
        `Batas maksimal ${PLUGIN_CUSTOM_DEV_DAILY_LIMIT} permintaan plugin kustom per hari telah tercapai. Coba lagi besok.`,
      );
    }

    const row = await platformDb
      .prepare("SELECT * FROM plugin_custom_dev_requests WHERE id = ? LIMIT 1")
      .bind(id)
      .first<RawCustomDevRequestRow>();
    if (!row) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat permintaan plugin kustom.");
    }
    return { request: mapCustomDevRequestRow(row), created: true };
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}

export async function listConsoleCustomPluginDevRequests(
  platformDb: D1Database,
  options: { readonly status?: PluginCustomDevRequestStatus; readonly limit?: number } = {},
): Promise<readonly PluginCustomDevRequestRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
  const where = options.status ? "WHERE r.status = ?" : "";
  const binds = options.status ? [options.status, limit] : [limit];
  const res = await platformDb
    .prepare(
      `SELECT r.*, t.handle AS tenant_handle, t.name AS tenant_name
       FROM plugin_custom_dev_requests r
       LEFT JOIN tenants t ON t.id = r.tenant_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<RawCustomDevRequestRow>();
  return (res.results ?? []).map(mapCustomDevRequestRow);
}

export interface TransitionCustomPluginDevRequestInput {
  readonly id: string;
  readonly status: PluginCustomDevRequestStatus;
  readonly expectedVersion: number;
  readonly quoteAmountIdr?: number | null;
  readonly linkedGrantId?: string | null;
  readonly operatorNotes?: string | null;
  readonly reason: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

/**
 * Transitions a `custom_plugin` dev request with strict OCC, mandatory audit reason,
 * and **HARD FULFILLMENT GUARD (`422 GRANT_REQUIRED`)**:
 * Setting `status = 'fulfilled'` is strictly blocked unless `linkedGrantId` points to
 * an existing **active `private_client` grant** for that requesting tenant (or its active agency)!
 */
export async function transitionConsoleCustomPluginDevRequest(
  platformDb: D1Database,
  input: TransitionCustomPluginDevRequestInput,
): Promise<PluginCustomDevRequestRecord> {
  try {
    const cleanId = input.id.trim();
    const nowMs = Math.trunc(input.nowMs ?? Date.now());
    const validatedReason = validateOperatorReason(input.reason);

    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new PluginStoreError(
        422,
        "VALIDATION_ERROR",
        "expectedVersion wajib berupa bilangan bulat positif.",
      );
    }

    const existing = await platformDb
      .prepare("SELECT * FROM plugin_custom_dev_requests WHERE id = ? LIMIT 1")
      .bind(cleanId)
      .first<RawCustomDevRequestRow>();
    if (!existing) {
      throw new PluginStoreError(404, "NOT_FOUND", "Permintaan plugin kustom tidak ditemukan.");
    }

    const allowedNext = PLUGIN_CUSTOM_DEV_ALLOWED_TRANSITIONS[existing.status] ?? [];
    if (!allowedNext.includes(input.status)) {
      throw new PluginStoreError(
        422,
        "INVALID_STATUS_TRANSITION",
        `Transisi status dari "${existing.status}" ke "${input.status}" tidak diizinkan.`,
      );
    }

    let quoteAmountIdr = existing.quote_amount_idr;
    if (input.quoteAmountIdr !== undefined && input.quoteAmountIdr !== null) {
      const q = Math.trunc(input.quoteAmountIdr);
      if (!Number.isSafeInteger(q) || q < 0 || q > 999_999_999_999) {
        throw new PluginStoreError(422, "VALIDATION_ERROR", "Nominal penawaran IDR tidak valid.");
      }
      quoteAmountIdr = q;
    }

    const operatorNotes =
      input.operatorNotes !== undefined
        ? (input.operatorNotes?.trim().slice(0, 2000) || null)
        : existing.operator_notes;

    let linkedGrantId = existing.linked_grant_id;
    let linkedPluginSlug = existing.linked_plugin_slug;

    // CRITICAL INVARIANT: `fulfilled` strictly requires an existing ACTIVE `private_client` grant
    // scoped to the requesting tenant (or its active owning agency)!
    if (input.status === "fulfilled") {
      const candidateGrantId = input.linkedGrantId?.trim() || existing.linked_grant_id || "";
      if (!candidateGrantId) {
        throw new PluginStoreError(
          422,
          "GRANT_REQUIRED",
          "Permintaan Custom Plugin hanya dapat diselesaikan (fulfilled) setelah menautkan izin private_client aktif untuk tenant atau agensinya.",
        );
      }

      const [grantRow, tenantCtx] = await Promise.all([
        platformDb
          .prepare("SELECT * FROM plugin_private_grants WHERE id = ? LIMIT 1")
          .bind(candidateGrantId)
          .first<RawPrivateGrantRow>(),
        resolveTenantAgencyContext(platformDb, existing.tenant_id),
      ]);

      if (!grantRow || grantRow.status !== "active") {
        throw new PluginStoreError(
          422,
          "GRANT_REQUIRED",
          "Izin plugin yang ditautkan tidak ditemukan atau sudah dicabut (harus berstatus active).",
        );
      }

      const matchesTenant = grantRow.tenant_id === existing.tenant_id;
      const matchesOwningAgency =
        grantRow.agency_id !== null &&
        tenantCtx?.owningAgencyId === grantRow.agency_id &&
        tenantCtx.owningAgencyActive;

      if (!matchesTenant && !matchesOwningAgency) {
        throw new PluginStoreError(
          422,
          "GRANT_REQUIRED",
          "Izin plugin yang ditautkan bukan milik tenant pemohon atau agensi pemiliknya.",
        );
      }

      const catalog = await getPluginCatalogItem(platformDb, grantRow.plugin_slug);
      if (!catalog || !catalog.active || catalog.visibilityTier !== "private_client") {
        throw new PluginStoreError(
          422,
          "GRANT_REQUIRED",
          "Izin yang ditautkan wajib merujuk pada plugin aktif berstatus private_client.",
        );
      }

      linkedGrantId = grantRow.id;
      linkedPluginSlug = grantRow.plugin_slug;
    }

    const auditId = generatePlatformAuditId(nowMs);
    const updateSql =
      input.status === "fulfilled"
        ? `UPDATE plugin_custom_dev_requests
           SET status = ?,
               quote_amount_idr = ?,
               operator_notes = ?,
               status_reason = ?,
               linked_grant_id = ?,
               linked_plugin_slug = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
             AND EXISTS (
               SELECT 1 FROM plugin_private_grants
               WHERE id = ? AND status = 'active'
             )`
        : `UPDATE plugin_custom_dev_requests
           SET status = ?,
               quote_amount_idr = ?,
               operator_notes = ?,
               status_reason = ?,
               linked_grant_id = ?,
               linked_plugin_slug = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`;

    const updateBinds =
      input.status === "fulfilled"
        ? [
            input.status,
            quoteAmountIdr,
            operatorNotes,
            validatedReason,
            linkedGrantId,
            linkedPluginSlug,
            nowMs,
            cleanId,
            input.expectedVersion,
            linkedGrantId,
          ]
        : [
            input.status,
            quoteAmountIdr,
            operatorNotes,
            validatedReason,
            linkedGrantId,
            linkedPluginSlug,
            nowMs,
            cleanId,
            input.expectedVersion,
          ];

    const batchRes = await platformDb.batch([
      platformDb.prepare(updateSql).bind(...updateBinds),
      platformDb
        .prepare(
          `INSERT INTO platform_audit (
             id, actor_user_id, actor_role, action, target_type, target_id,
             tenant_id, reason, outcome, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'console.custom_plugin_request.transition', 'plugin_custom_dev_request', ?, ?,
                  ?, 'success', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          auditId,
          input.actorUserId,
          input.actorRole,
          cleanId,
          existing.tenant_id,
          validatedReason,
          input.requestId ?? null,
          JSON.stringify({
            previousStatus: existing.status,
            status: input.status,
            quoteAmountIdr,
            linkedGrantId,
            linkedPluginSlug,
          }),
          nowMs,
        ),
    ]);

    if ((batchRes[0]?.meta?.changes ?? 0) !== 1) {
      throw new PluginStoreError(
        409,
        "VERSION_CONFLICT",
        "Permintaan plugin kustom telah diperbarui oleh operator lain. Muat ulang dan coba lagi.",
      );
    }

    const updated = await platformDb
      .prepare(
        `SELECT r.*, t.handle AS tenant_handle, t.name AS tenant_name
         FROM plugin_custom_dev_requests r
         LEFT JOIN tenants t ON t.id = r.tenant_id
         WHERE r.id = ? LIMIT 1`,
      )
      .bind(cleanId)
      .first<RawCustomDevRequestRow>();
    if (!updated) {
      throw new PluginStoreError(500, "INTERNAL_ERROR", "Gagal memuat permintaan setelah pembaruan.");
    }
    return mapCustomDevRequestRow(updated);
  } catch (err) {
    wrapAuditOrValidationError(err);
  }
}
