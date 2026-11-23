import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  BILLING_CURRENCY,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
  assertExactIdrInteger,
  classifyAllowedChannel,
  formatIdrDisplay,
} from "../billing/index.ts";
import {
  RECEIPT_NON_PKP_NOTICE,
  computeSha256Hex,
  formatWibDateTime,
  getWibYearFromEpochMs,
} from "../billing/receipt-pdf.ts";
import { isBuiltinPluginId, isValidPluginId } from "./sql-guard.ts";

/**
 * Pure Commercial Plugin Store Pricing, Visibility, Entitlement, Custom Dev Validation,
 * and Numbered PDF Receipt Generation (`packages/core/src/plugins/billing.ts`).
 *
 * (REQ-098, ADR-0010, PLAN §19.7, DESIGN §7, TASK-098).
 *
 * Financial & Security Invariants:
 * 1. Exact integer IDR arithmetic ONLY — zero floating-point drift, never negative,
 *    and net payable strictly clamped to `>= MIN_AUTOLARIS_CHARGE_IDR` (Rp 10.000).
 * 2. `private_client` plugins are 100% INVISIBLE (`visible: false`, `reasonCode: "NOT_FOUND"`)
 *    unless the tenant holds an active direct grant OR an active grant on its owning active agency.
 * 3. Agency-managed client tenants NEVER see or initiate paid add-on checkout (`AGENCY_PAYER_ONLY`);
 *    checkout routes strictly to the owning agency payer (`/api/agency/plugins/**`).
 * 4. Disabling or expiring a plugin sets `enabled = false` / `status = "expired"` and NEVER deletes
 *    `plg_*` tenant data rows (preserved until `H+45` purge).
 */

export const PLUGIN_VISIBILITY_TIERS = [
  "public_free",
  "public_paid",
  "private_client",
] as const;
export type PluginVisibilityTier = (typeof PLUGIN_VISIBILITY_TIERS)[number];

export const PLUGIN_BILLING_MODELS = [
  "free",
  "paid_once",
  "paid_monthly",
  "paid_yearly",
] as const;
export type PluginBillingModel = (typeof PLUGIN_BILLING_MODELS)[number];

export const PLUGIN_ENTITLEMENT_SOURCE_KINDS = [
  "public_free",
  "paid_once",
  "paid_monthly",
  "paid_yearly",
  "private_grant",
] as const;
export type PluginEntitlementSourceKind = (typeof PLUGIN_ENTITLEMENT_SOURCE_KINDS)[number];

export const PLUGIN_ENTITLEMENT_STATUSES = [
  "active",
  "expired",
  "disabled",
  "revoked",
] as const;
export type PluginEntitlementStatus = (typeof PLUGIN_ENTITLEMENT_STATUSES)[number];

export const PLUGIN_PAYER_KINDS = ["tenant", "agency"] as const;
export type PluginPayerKind = (typeof PLUGIN_PAYER_KINDS)[number];

export const PLUGIN_PRIVATE_GRANT_STATUSES = ["active", "revoked"] as const;
export type PluginPrivateGrantStatus = (typeof PLUGIN_PRIVATE_GRANT_STATUSES)[number];

export const PLUGIN_ADDON_ORDER_STATUSES = [
  "pending",
  "settled",
  "expired",
  "refunded",
] as const;
export type PluginAddonOrderStatus = (typeof PLUGIN_ADDON_ORDER_STATUSES)[number];

export const PLUGIN_CUSTOM_DEV_REQUEST_STATUSES = [
  "submitted",
  "quoted",
  "in_progress",
  "fulfilled",
  "declined",
] as const;
export type PluginCustomDevRequestStatus =
  (typeof PLUGIN_CUSTOM_DEV_REQUEST_STATUSES)[number];

export const PLUGIN_CUSTOM_DEV_ALLOWED_TRANSITIONS: Readonly<
  Record<PluginCustomDevRequestStatus, readonly PluginCustomDevRequestStatus[]>
> = {
  submitted: ["quoted", "in_progress", "declined"],
  quoted: ["in_progress", "fulfilled", "declined"],
  in_progress: ["fulfilled", "declined"],
  fulfilled: [],
  declined: [],
};

export const PLUGIN_MONTHLY_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const PLUGIN_YEARLY_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
export const PLUGIN_ADDON_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_CUSTOM_DEV_DAILY_LIMIT = 3;
export const MAX_AGENCY_PLUGIN_DISCOUNT_PERCENT = 50;

export const PLUGIN_ADDON_RECEIPT_NUMBER_PATTERN = /^INV-PLG-(\d{4})-(\d{6,})$/;

export const PLUGIN_FORBIDDEN_PRICE_KEYS: ReadonlySet<string> = new Set([
  "price",
  "priceIdr",
  "price_idr",
  "grossAmountIdr",
  "gross_amount_idr",
  "basePriceIdr",
  "base_price_idr",
  "discountAmountIdr",
  "discount_amount_idr",
  "netAmountIdr",
  "net_amount_idr",
  "channelFeeIdr",
  "channel_fee_idr",
  "totalPayableIdr",
  "total_payable_idr",
  "totalAmountIdr",
  "total_amount_idr",
  "amount",
  "amountIdr",
  "status",
  "paid",
  "settled",
  "settledAt",
]);

export class PluginBillingValidationError extends Error {
  readonly code: string;
  readonly fields?: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];

  constructor(
    code: string,
    message: string,
    fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  ) {
    super(message);
    this.name = "PluginBillingValidationError";
    this.code = code;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Slug & Channel Helpers
// ---------------------------------------------------------------------------

export function assertValidPluginStoreSlug(raw: unknown, field = "slug"): string {
  if (typeof raw !== "string") {
    throw new PluginBillingValidationError("INVALID_PLUGIN_SLUG", "Slug plugin wajib berupa teks.", [
      { field, code: "INVALID_PLUGIN_SLUG", message: "Slug plugin wajib berupa teks." },
    ]);
  }
  const slug = raw.trim().toLowerCase();
  if (!slug || isBuiltinPluginId(slug) || !isValidPluginId(slug)) {
    throw new PluginBillingValidationError(
      "INVALID_PLUGIN_SLUG",
      `Slug plugin "${raw}" tidak valid (gunakan 3-48 karakter huruf kecil/angka/tanda hubung dan bukan prefiks builtin:).`,
      [{ field, code: "INVALID_PLUGIN_SLUG", message: "Invalid plugin slug format." }],
    );
  }
  return slug;
}

/**
 * Deterministic server-authoritative AutoLaris channel fee (exact integer IDR).
 * - QRIS: 0.7% rounded up (ceil(net * 7 / 1000))
 * - Bank Virtual Account: flat Rp 4.000
 */
export function computePluginAddonChannelFeeIdr(
  netAmountIdr: number,
  channelCode: string,
): number {
  const net = assertExactIdrInteger(netAmountIdr, "netAmountIdr");
  const classified = classifyAllowedChannel(channelCode);
  if (!classified.ok) {
    throw new PluginBillingValidationError(
      "UNSUPPORTED_CHANNEL",
      classified.reason || "Channel pembayaran harus QRIS atau Virtual Account bank yang didukung.",
      [{ field: "channelCode", code: "UNSUPPORTED_CHANNEL", message: "Unsupported payment channel." }],
    );
  }
  if (classified.kind === "QRIS") {
    return Math.ceil((net * 7) / 1000);
  }
  return 4_000;
}

// ---------------------------------------------------------------------------
// Exact Integer IDR Add-on Quote Calculator
// ---------------------------------------------------------------------------

export interface PluginAddonCouponRule {
  readonly code: string;
  readonly discountKind: "percent" | "fixed_idr";
  readonly discountValue: number;
}

export interface PluginAddonQuoteInput {
  readonly grossAmountIdr: number;
  readonly billingModel: Exclude<PluginBillingModel, "free">;
  readonly payerKind: PluginPayerKind;
  readonly agencyDiscountPercent?: number;
  readonly coupon?: PluginAddonCouponRule | null;
  readonly channelCode: string;
  readonly overrideChannelFeeIdr?: number;
}

export interface PluginAddonQuote {
  readonly currency: typeof BILLING_CURRENCY;
  readonly billingModel: Exclude<PluginBillingModel, "free">;
  readonly payerKind: PluginPayerKind;
  readonly grossAmountIdr: number;
  readonly agencyDiscountPercent: number;
  readonly agencyDiscountIdr: number;
  readonly couponCode: string | null;
  readonly couponDiscountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly channelCode: string;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
}

export function calculatePluginAddonQuote(input: PluginAddonQuoteInput): PluginAddonQuote {
  const gross = assertExactIdrInteger(input.grossAmountIdr, "grossAmountIdr");
  if (gross < MIN_AUTOLARIS_CHARGE_IDR || gross > MAX_IDR_AMOUNT) {
    throw new PluginBillingValidationError(
      "INVALID_PLUGIN_PRICE",
      `Harga add-on plugin harus berada di antara Rp ${MIN_AUTOLARIS_CHARGE_IDR.toLocaleString("id-ID")} dan batas maksimum IDR.`,
      [{ field: "priceIdr", code: "INVALID_PLUGIN_PRICE", message: "Invalid plugin add-on price." }],
    );
  }

  const classified = classifyAllowedChannel(input.channelCode);
  if (!classified.ok) {
    throw new PluginBillingValidationError(
      "UNSUPPORTED_CHANNEL",
      classified.reason || "Channel pembayaran harus QRIS atau Virtual Account bank yang didukung.",
      [{ field: "channelCode", code: "UNSUPPORTED_CHANNEL", message: "Unsupported channel." }],
    );
  }

  const rawAgencyPct =
    input.payerKind === "agency" ? Math.trunc(input.agencyDiscountPercent ?? 0) : 0;
  if (
    !Number.isSafeInteger(rawAgencyPct) ||
    rawAgencyPct < 0 ||
    rawAgencyPct > MAX_AGENCY_PLUGIN_DISCOUNT_PERCENT
  ) {
    throw new PluginBillingValidationError(
      "INVALID_AGENCY_DISCOUNT",
      `Diskon agensi harus bilangan bulat 0% hingga ${MAX_AGENCY_PLUGIN_DISCOUNT_PERCENT}%.`,
    );
  }

  const maxAllowedDiscount = Math.max(0, gross - MIN_AUTOLARIS_CHARGE_IDR);

  // 1. Agency discount via exact integer floor
  const rawAgencyDiscount = Math.floor((gross * rawAgencyPct) / 100);
  const agencyDiscountIdr = Math.min(rawAgencyDiscount, maxAllowedDiscount);
  const roomAfterAgency = Math.max(0, maxAllowedDiscount - agencyDiscountIdr);

  // 2. Optional single promo coupon applied on remaining base, strictly clamped
  let couponDiscountIdr = 0;
  let couponCode: string | null = null;
  if (input.coupon) {
    const cleanCode = input.coupon.code.trim().toUpperCase();
    const val = Math.trunc(input.coupon.discountValue);
    if (!Number.isSafeInteger(val) || val < 0) {
      throw new PluginBillingValidationError(
        "INVALID_COUPON_VALUE",
        "Nilai diskon kupon tidak valid.",
      );
    }
    const baseAfterAgency = gross - agencyDiscountIdr;
    const rawCoupon =
      input.coupon.discountKind === "percent"
        ? Math.floor((baseAfterAgency * Math.min(100, val)) / 100)
        : val;
    couponDiscountIdr = Math.min(Math.max(0, rawCoupon), roomAfterAgency);
    couponCode = cleanCode || null;
  }

  const discountAmountIdr = agencyDiscountIdr + couponDiscountIdr;
  const netAmountIdr = gross - discountAmountIdr;
  const channelFeeIdr =
    input.overrideChannelFeeIdr !== undefined
      ? assertExactIdrInteger(input.overrideChannelFeeIdr, "channelFeeIdr")
      : computePluginAddonChannelFeeIdr(netAmountIdr, classified.normalizedCode);
  const totalPayableIdr = netAmountIdr + channelFeeIdr;

  return {
    currency: BILLING_CURRENCY,
    billingModel: input.billingModel,
    payerKind: input.payerKind,
    grossAmountIdr: gross,
    agencyDiscountPercent: rawAgencyPct,
    agencyDiscountIdr,
    couponCode,
    couponDiscountIdr,
    discountAmountIdr,
    netAmountIdr,
    channelCode: classified.normalizedCode,
    channelFeeIdr,
    totalPayableIdr,
  };
}

// ---------------------------------------------------------------------------
// Entitlement Expiry & Visibility / Access Evaluator
// ---------------------------------------------------------------------------

/**
 * Computes new `expires_at` timestamp (epoch ms) for a settled or granted entitlement:
 * - `free` / `paid_once` / `private_grant` -> `null` (never expires)
 * - `paid_monthly` -> `anchor + 30d` (extends from existing unexpired `expiresAtMs` on renewal)
 * - `paid_yearly` -> `anchor + 365d`
 */
export function computePluginEntitlementExpiryMs(params: {
  readonly billingModel: PluginBillingModel;
  readonly nowMs: number;
  readonly existingExpiresAtMs?: number | null;
}): number | null {
  const now = Math.trunc(params.nowMs);
  if (params.billingModel === "free" || params.billingModel === "paid_once") {
    return null;
  }
  const anchor =
    typeof params.existingExpiresAtMs === "number" && params.existingExpiresAtMs > now
      ? Math.trunc(params.existingExpiresAtMs)
      : now;
  if (params.billingModel === "paid_monthly") {
    return anchor + PLUGIN_MONTHLY_DURATION_MS;
  }
  return anchor + PLUGIN_YEARLY_DURATION_MS;
}

export interface EvaluatePluginAccessInput {
  readonly visibilityTier: PluginVisibilityTier;
  readonly billingModel: PluginBillingModel;
  readonly active: boolean;
  readonly owningAgencyId: string | null;
  readonly directGrantActive: boolean;
  readonly agencyGrantActive: boolean;
  readonly entitlement: {
    readonly status: PluginEntitlementStatus;
    readonly enabled: boolean;
    readonly sourceKind: PluginEntitlementSourceKind;
    readonly expiresAtMs: number | null;
  } | null;
  readonly nowMs: number;
}

export interface PluginAccessEvaluation {
  readonly visible: boolean;
  readonly entitled: boolean;
  readonly activeGrantScope: "tenant" | "agency" | null;
  readonly canInstall: boolean;
  readonly canTenantCheckout: boolean;
  readonly agencyCanCheckout: boolean;
  readonly checkoutBlockCode: "AGENCY_PAYER_ONLY" | null;
  readonly reasonCode:
    | "OK"
    | "NOT_FOUND"
    | "INACTIVE_PLUGIN"
    | "ENTITLEMENT_REQUIRED"
    | "ENTITLEMENT_EXPIRED"
    | "AGENCY_PAYER_ONLY";
}

/**
 * Pure visibility & entitlement evaluator implementing all REQ-098 invariants:
 * - `private_client` without an active tenant or owning-agency grant is 100% INVISIBLE (`NOT_FOUND`).
 * - Promoting `private_client` -> `public_free` or `public_paid` makes it immediately visible.
 * - `public_free` is always 1-click installable.
 * - `public_paid` requires an active unexpired entitlement or active grant; agency-managed clients
 *   are strictly blocked from tenant checkout (`AGENCY_PAYER_ONLY`) and routed to agency checkout.
 */
export function evaluatePluginStoreAccess(
  input: EvaluatePluginAccessInput,
): PluginAccessEvaluation {
  const now = Math.trunc(input.nowMs);
  const activeGrantScope: "tenant" | "agency" | null = input.directGrantActive
    ? "tenant"
    : input.agencyGrantActive
      ? "agency"
      : null;
  const hasActiveGrant = activeGrantScope !== null;
  const isAgencyManaged = Boolean(input.owningAgencyId && input.owningAgencyId.trim().length > 0);

  if (!input.active) {
    return {
      visible: false,
      entitled: false,
      activeGrantScope,
      canInstall: false,
      canTenantCheckout: false,
      agencyCanCheckout: false,
      checkoutBlockCode: null,
      reasonCode: "INACTIVE_PLUGIN",
    };
  }

  // `private_client` is strictly invisible without an active direct or agency grant!
  if (input.visibilityTier === "private_client") {
    if (!hasActiveGrant) {
      return {
        visible: false,
        entitled: false,
        activeGrantScope: null,
        canInstall: false,
        canTenantCheckout: false,
        agencyCanCheckout: false,
        checkoutBlockCode: null,
        reasonCode: "NOT_FOUND",
      };
    }
    return {
      visible: true,
      entitled: true,
      activeGrantScope,
      canInstall: true,
      canTenantCheckout: false,
      agencyCanCheckout: false,
      checkoutBlockCode: null,
      reasonCode: "OK",
    };
  }

  if (input.visibilityTier === "public_free") {
    return {
      visible: true,
      entitled: true,
      activeGrantScope,
      canInstall: true,
      canTenantCheckout: false,
      agencyCanCheckout: false,
      checkoutBlockCode: null,
      reasonCode: "OK",
    };
  }

  // `public_paid`
  const ent = input.entitlement;
  const entUnexpired =
    ent !== null &&
    (ent.status === "active" || ent.status === "disabled") &&
    (ent.expiresAtMs === null || ent.expiresAtMs > now);
  const entIsExpired =
    ent !== null &&
    (ent.status === "expired" || (ent.expiresAtMs !== null && ent.expiresAtMs <= now));

  const entitled = hasActiveGrant || entUnexpired;
  if (entitled) {
    return {
      visible: true,
      entitled: true,
      activeGrantScope,
      canInstall: true,
      canTenantCheckout: !isAgencyManaged && input.billingModel !== "paid_once",
      agencyCanCheckout: isAgencyManaged && input.billingModel !== "paid_once",
      checkoutBlockCode: isAgencyManaged ? "AGENCY_PAYER_ONLY" : null,
      reasonCode: "OK",
    };
  }

  if (isAgencyManaged) {
    return {
      visible: true,
      entitled: false,
      activeGrantScope: null,
      canInstall: false,
      canTenantCheckout: false,
      agencyCanCheckout: true,
      checkoutBlockCode: "AGENCY_PAYER_ONLY",
      reasonCode: "AGENCY_PAYER_ONLY",
    };
  }

  return {
    visible: true,
    entitled: false,
    activeGrantScope: null,
    canInstall: false,
    canTenantCheckout: true,
    agencyCanCheckout: false,
    checkoutBlockCode: null,
    reasonCode: entIsExpired ? "ENTITLEMENT_EXPIRED" : "ENTITLEMENT_REQUIRED",
  };
}

// ---------------------------------------------------------------------------
// Custom Plugin Dev Request Validation (`service_kind = "custom_plugin"`)
// ---------------------------------------------------------------------------

export interface ValidatedCustomPluginRequestInput {
  readonly serviceKind: "custom_plugin";
  readonly title: string;
  readonly requirementsSummary: string;
  readonly contactWhatsapp: string;
  readonly budgetRange: string | null;
}

const WHATSAPP_DIGITS_RE = /^(?:08|628|\+628)[0-9]{7,13}$/;

export function normalizeWhatsappNumber(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new PluginBillingValidationError(
      "INVALID_WHATSAPP",
      "Nomor WhatsApp wajib diisi.",
      [{ field: "contactWhatsapp", code: "INVALID_WHATSAPP", message: "WhatsApp number is required." }],
    );
  }
  const stripped = raw.trim().replace(/[\s\-().]/g, "");
  if (!WHATSAPP_DIGITS_RE.test(stripped)) {
    throw new PluginBillingValidationError(
      "INVALID_WHATSAPP",
      "Format nomor WhatsApp tidak valid (gunakan nomor Indonesia, contoh 081234567890 atau +6281234567890).",
      [{ field: "contactWhatsapp", code: "INVALID_WHATSAPP", message: "Invalid WhatsApp format." }],
    );
  }
  if (stripped.startsWith("08")) {
    return `62${stripped.slice(1)}`;
  }
  if (stripped.startsWith("+")) {
    return stripped.slice(1);
  }
  return stripped;
}

export function validateCustomPluginRequestInput(
  raw: Record<string, unknown>,
): ValidatedCustomPluginRequestInput {
  if (raw.serviceKind !== undefined && raw.serviceKind !== "custom_plugin") {
    throw new PluginBillingValidationError(
      "INVALID_SERVICE_KIND",
      'serviceKind harus bernilai "custom_plugin".',
      [{ field: "serviceKind", code: "INVALID_SERVICE_KIND", message: 'Must be "custom_plugin".' }],
    );
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length < 4 || title.length > 120) {
    throw new PluginBillingValidationError(
      "INVALID_TITLE",
      "Judul fitur/plugin kustom harus antara 4 hingga 120 karakter.",
      [{ field: "title", code: "INVALID_TITLE", message: "Title must be 4-120 chars." }],
    );
  }

  const requirementsSummary =
    typeof raw.requirementsSummary === "string" ? raw.requirementsSummary.trim() : "";
  if (requirementsSummary.length < 20 || requirementsSummary.length > 3000) {
    throw new PluginBillingValidationError(
      "INVALID_REQUIREMENTS",
      "Ringkasan kebutuhan bisnis harus antara 20 hingga 3.000 karakter.",
      [
        {
          field: "requirementsSummary",
          code: "INVALID_REQUIREMENTS",
          message: "Requirements summary must be 20-3000 chars.",
        },
      ],
    );
  }

  const contactWhatsapp = normalizeWhatsappNumber(raw.contactWhatsapp);

  let budgetRange: string | null = null;
  if (raw.budgetRange !== undefined && raw.budgetRange !== null && raw.budgetRange !== "") {
    if (typeof raw.budgetRange !== "string") {
      throw new PluginBillingValidationError(
        "INVALID_BUDGET_RANGE",
        "Estimasi anggaran harus berupa teks.",
        [{ field: "budgetRange", code: "INVALID_BUDGET_RANGE", message: "Must be string." }],
      );
    }
    const cleanBudget = raw.budgetRange.trim();
    if (cleanBudget.length > 80) {
      throw new PluginBillingValidationError(
        "INVALID_BUDGET_RANGE",
        "Estimasi anggaran maksimal 80 karakter.",
        [{ field: "budgetRange", code: "INVALID_BUDGET_RANGE", message: "Max 80 chars." }],
      );
    }
    budgetRange = cleanBudget || null;
  }

  return {
    serviceKind: "custom_plugin",
    title,
    requirementsSummary,
    contactWhatsapp,
    budgetRange,
  };
}

export function getWibDayBucket(epochMs: number): string {
  const wibMs = Math.trunc(epochMs) + 7 * 60 * 60 * 1000;
  const d = new Date(wibMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Gap-Free Numbered Add-on PDF Receipt Generator (`INV-PLG-YYYY-NNNNNN`)
// ---------------------------------------------------------------------------

export function formatPluginAddonReceiptNumber(year: number, sequence: number): string {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
    throw new PluginBillingValidationError("INVALID_RECEIPT_YEAR", "Tahun kuitansi tidak valid.");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new PluginBillingValidationError(
      "INVALID_RECEIPT_SEQUENCE",
      "Nomor urut kuitansi harus bilangan bulat positif.",
    );
  }
  return `INV-PLG-${year}-${String(sequence).padStart(6, "0")}`;
}

export function buildPluginAddonReceiptR2Key(year: number, receiptNumber: string): string {
  const trimmed = receiptNumber.trim();
  if (!PLUGIN_ADDON_RECEIPT_NUMBER_PATTERN.test(trimmed)) {
    throw new PluginBillingValidationError(
      "INVALID_RECEIPT_NUMBER",
      `Format nomor kuitansi plugin "${trimmed}" tidak valid.`,
    );
  }
  return `platform/plugin-receipts/${year}/${trimmed}.pdf`;
}

export interface PluginAddonReceiptPdfInput {
  readonly receiptNumber: string;
  readonly issuedAtMs: number;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly payerKind: PluginPayerKind;
  readonly payerName: string;
  readonly pluginSlug: string;
  readonly pluginName: string;
  readonly billingModel: Exclude<PluginBillingModel, "free">;
  readonly orderId: string;
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode?: string | null;
  readonly paymentChannel: string;
  readonly providerReference?: string | null;
  readonly expiresAtMs?: number | null;
  readonly nonPkpNotice?: string;
}

export interface GeneratedPluginAddonReceiptPdf {
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly receiptNumber: string;
  readonly r2ObjectKey: string;
  readonly nonPkpNotice: string;
}

function toAsciiSafe(raw: string): string {
  return (
    raw
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[^\x20-\x7e]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "-"
  );
}

function billingModelLabel(model: Exclude<PluginBillingModel, "free">): string {
  if (model === "paid_monthly") return "Langganan Add-on Bulanan (+30 Hari)";
  if (model === "paid_yearly") return "Langganan Add-on Tahunan (+365 Hari)";
  return "Lisensi Add-on Sekali Bayar (Permanen)";
}

export async function generatePluginAddonReceiptPdf(
  input: PluginAddonReceiptPdfInput,
): Promise<GeneratedPluginAddonReceiptPdf> {
  const year = getWibYearFromEpochMs(input.issuedAtMs);
  const r2ObjectKey = buildPluginAddonReceiptR2Key(year, input.receiptNumber);
  const nonPkpNotice = input.nonPkpNotice ?? RECEIPT_NON_PKP_NOTICE;

  const pdfDoc = await PDFDocument.create();
  const pinnedDate = new Date(Math.trunc(input.issuedAtMs));
  pdfDoc.setTitle(`Kuitansi Plugin Add-on ${input.receiptNumber}`);
  pdfDoc.setAuthor("PunyaSitus");
  pdfDoc.setSubject(`Bukti Pembayaran Add-on Plugin ${input.pluginSlug}`);
  pdfDoc.setCreator("PunyaSitus Billing Engine");
  pdfDoc.setProducer("PunyaSitus");
  pdfDoc.setCreationDate(pinnedDate);
  pdfDoc.setModificationDate(pinnedDate);

  const page = pdfDoc.addPage([595.28, 841.89]);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const dark = rgb(0.11, 0.13, 0.17);
  const muted = rgb(0.38, 0.42, 0.48);
  const accent = rgb(0.06, 0.4, 0.35);

  let y = 785;
  page.drawText("PUNYASITUS - BUKTI PEMBAYARAN ADD-ON PLUGIN", {
    x: 48,
    y,
    size: 14,
    font: fontBold,
    color: accent,
  });

  y -= 24;
  const headerLines = [
    `Nomor Kuitansi   : ${toAsciiSafe(input.receiptNumber)}`,
    `Tanggal Terbit   : ${toAsciiSafe(formatWibDateTime(input.issuedAtMs))}`,
    `ID Pesanan       : ${toAsciiSafe(input.orderId)}`,
    `Situs            : ${toAsciiSafe(input.tenantName)} (${toAsciiSafe(input.tenantHandle)})`,
    `Pembayar         : ${toAsciiSafe(input.payerName)} (${input.payerKind === "agency" ? "Agensi" : "Pemilik Situs"})`,
    `Metode Bayar     : ${toAsciiSafe(input.paymentChannel)}${input.providerReference ? ` | Ref: ${toAsciiSafe(input.providerReference)}` : ""}`,
  ];

  for (const line of headerLines) {
    page.drawText(line, { x: 48, y, size: 10, font: fontRegular, color: dark });
    y -= 16;
  }

  y -= 14;
  page.drawText("RINCIAN ADD-ON PLUGIN", { x: 48, y, size: 11, font: fontBold, color: dark });
  y -= 18;

  const itemLines = [
    `Plugin           : ${toAsciiSafe(input.pluginName)} (${toAsciiSafe(input.pluginSlug)})`,
    `Skema Lisensi    : ${billingModelLabel(input.billingModel)}`,
    ...(input.expiresAtMs
      ? [`Masa Berlaku s/d : ${toAsciiSafe(formatWibDateTime(input.expiresAtMs))}`]
      : ["Masa Berlaku     : Permanen selama situs aktif"]),
    `Harga Dasar      : ${formatIdrDisplay(input.grossAmountIdr)}`,
    `Diskon${input.couponCode ? ` (${toAsciiSafe(input.couponCode)})` : ""}      : -${formatIdrDisplay(input.discountAmountIdr)}`,
    `Biaya Channel    : ${formatIdrDisplay(input.channelFeeIdr)}`,
  ];

  for (const line of itemLines) {
    page.drawText(line, { x: 48, y, size: 10, font: fontRegular, color: dark });
    y -= 16;
  }

  y -= 8;
  page.drawText(`TOTAL DIBAYAR    : ${formatIdrDisplay(input.totalAmountIdr)}`, {
    x: 48,
    y,
    size: 12,
    font: fontBold,
    color: accent,
  });

  y -= 32;
  page.drawText(toAsciiSafe(nonPkpNotice), {
    x: 48,
    y,
    size: 8.5,
    font: fontRegular,
    color: muted,
  });

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const sha256Hex = await computeSha256Hex(bytes);

  return {
    bytes,
    sha256Hex,
    byteLength: bytes.byteLength,
    receiptNumber: input.receiptNumber,
    r2ObjectKey,
    nonPkpNotice,
  };
}
