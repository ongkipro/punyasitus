import { generateTotpQrSvg } from "@punyasitus/auth/platform/qr";
import {
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
  classifyAllowedChannel,
  computeSubscriptionPeriodPreview,
  type AllowedPaymentChannelKind,
  type BillingPlanInterval,
  type RenewalAnchorKind,
} from "@punyasitus/core/billing/index";
import type { TenantStatus } from "@punyasitus/core/schemas";
import { validateApprovedPaymentRedirectUrl } from "../../../../../../packages/integrations/src/autolaris/client.ts";

/**
 * Pure presentation, idempotency, QRIS rendering, disclosure, and safety helpers
 * for Owner Payment Recovery & Scoped Console Operator Billing Views
 * (TASK-057; REQ-058, PLAN §16–17, DESIGN §9–11).
 */

export const OWNER_NO_REFUND_DISCLOSURE =
  "Pembayaran bersifat final dan tidak dapat dikembalikan, kecuali pengembalian manual oleh superadmin untuk pembayaran ganda atau salah bayar." as const;

export const OWNER_NON_PKP_DISCLOSURE = NON_PKP_TAX_NOTICE;
export const CORE_NO_REFUND_NOTICE = NO_REFUND_NOTICE;

export type OwnerAttemptState =
  | "creating"
  | "creation_unknown"
  | "pending"
  | "expired"
  | "failed"
  | "paid"
  | "review";

export type OwnerObligationState = "open" | "paid" | "cancelled" | "expired" | "review";

export type OwnerBillingVisualState =
  | "ready"
  | "pending"
  | "creation_unknown"
  | "expired"
  | "paid"
  | "review"
  | "provider_outage";

export interface OwnerBillingPlanDto {
  readonly plan: BillingPlanInterval;
  readonly months: 1 | 12;
  readonly baseAmountIdr: number;
  readonly currency: "IDR";
  readonly savingsIdr: number;
}

export interface OwnerBillingChannelDto {
  readonly code: string;
  readonly label: string;
  readonly kind: AllowedPaymentChannelKind;
  readonly estimatedFeeIdr: number;
  readonly enabled: boolean;
}

export interface OwnerBillingObligationDto {
  readonly obligationId: string;
  readonly plan: BillingPlanInterval;
  readonly payerKind: "tenant" | "agency";
  readonly state: OwnerObligationState;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly currency: "IDR";
  readonly periodStartAt: string | null;
  readonly periodEndAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface OwnerBillingAttemptDto {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly reffId: string;
  readonly plan: BillingPlanInterval;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly state: OwnerAttemptState;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly currency: "IDR";
  readonly taxNotice: string;
  readonly qrisPayload: string | null;
  readonly vaNumber: string | null;
  readonly bankName: string | null;
  readonly paymentRedirectUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface OwnerBillingOverviewDto {
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly trialEndsAt: string | null;
  readonly paidThrough: string | null;
  readonly graceEndsAt: string | null;
  readonly lockedEndsAt: string | null;
  readonly deletionDueAt: string | null;
  readonly activeObligation: OwnerBillingObligationDto | null;
  readonly activeAttempt: OwnerBillingAttemptDto | null;
  readonly obligations: readonly OwnerBillingObligationDto[];
  readonly pricingPlans: readonly OwnerBillingPlanDto[];
  readonly channels: readonly OwnerBillingChannelDto[];
  readonly taxNotice: string;
  readonly noRefundNotice: string;
  readonly providerOutage?: boolean;
}

export interface ConsoleBillingAttemptDto {
  readonly attemptId: string;
  readonly obligationId: string;
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly reffId: string;
  readonly providerTransactionId: string | null;
  readonly channelKind: AllowedPaymentChannelKind;
  readonly channelCode: string;
  readonly state: OwnerAttemptState;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly safeFailureCode: string | null;
  readonly pollCount: number;
  readonly maxPolls: number;
  readonly lastPolledAt: string | null;
  readonly lastProviderRc: string | null;
  readonly lastOutcome: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface ConsoleBillingObligationDto {
  readonly obligationId: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly payerType: "tenant" | "agency";
  readonly plan: BillingPlanInterval;
  readonly state: OwnerObligationState;
  readonly dbStatus: "open" | "paid" | "expired" | "canceled" | "refunded";
  readonly reviewRequired: boolean;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly currency: "IDR";
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly settlementId: string | null;
  readonly grantCount: number;
  readonly latestAttempt: ConsoleBillingAttemptDto | null;
}

export type ConsoleRefundKind = "duplicate_payment" | "mistaken_payment" | "late_post_purge";

export interface ConsoleBillingRefundDto {
  readonly id: string;
  readonly obligationId: string;
  readonly paymentAttemptId: string | null;
  readonly settlementId: string | null;
  readonly tenantId: string;
  readonly refundKind: ConsoleRefundKind;
  readonly amountIdr: number;
  readonly externalReference: string | null;
  readonly reason: string;
  readonly recordedBy: string;
  readonly createdAt: string;
}

export interface ConsoleSettlementPolicyDto {
  readonly profile: string;
  readonly realProviderMappingStatus: string;
  readonly policyVersion: string;
  readonly liveSettlementEnabled: boolean;
}

export const CONSOLE_ALLOWED_ACTIONS = ["advice_recheck", "record_refund"] as const;

export const CONSOLE_REFUND_KIND_OPTIONS: readonly {
  readonly value: ConsoleRefundKind;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "duplicate_payment",
    label: "Pembayaran ganda (duplicate_payment)",
    description: "Payer membayar dua kali untuk periode langganan yang sama.",
  },
  {
    value: "mistaken_payment",
    label: "Salah bayar (mistaken_payment)",
    description: "Kesalahan transfer/pembayaran yang telah diverifikasi superadmin.",
  },
  {
    value: "late_post_purge",
    label: "Pembayaran terlambat pasca-penghapusan (late_post_purge)",
    description: "Pembayaran masuk setelah situs melewati batas retensi & penghapusan.",
  },
] as const;

export const CONSOLE_FORBIDDEN_SENSITIVE_FIELDS = [
  "qrisPayload",
  "qris_payload",
  "vaNumber",
  "va_number",
  "paymentRedirectUrl",
  "payment_redirect_url",
  "providerPayload",
  "provider_payload_json",
  "apiKey",
  "api_key",
  "authorization",
  "secret",
] as const;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAYMENT_RETURN_CLAIM_PARAMS: ReadonlySet<string> = new Set([
  "status",
  "paid",
  "return",
  "result",
  "payment_status",
  "trx_status",
  "transaction_status",
  "callback",
  "success",
]);

export function formatIdr(amountIdr: number): string {
  const safe = Number.isFinite(amountIdr) ? Math.max(0, Math.trunc(amountIdr)) : 0;
  const formatted = String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${formatted}`;
}

export function formatWibDateTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined || input === "") return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return `${new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d)} WIB`;
  } catch {
    return d.toISOString();
  }
}

export function formatWibDate(input: string | number | null | undefined): string {
  if (input === null || input === undefined || input === "") return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function formatCountdownRemaining(expiresAtIso: string | null, nowMs: number): string | null {
  if (!expiresAtIso) return null;
  const expMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expMs)) return null;
  const diffSec = Math.floor((expMs - nowMs) / 1000);
  if (diffSec <= 0) return "Batas waktu berakhir";
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

export function computeYearlySavingsIdr(
  monthlyPriceIdr: number = DEFAULT_MONTHLY_PRICE_IDR,
  yearlyPriceIdr: number = DEFAULT_YEARLY_PRICE_IDR,
): number {
  const safeMonthly = Math.max(0, Math.trunc(monthlyPriceIdr));
  const safeYearly = Math.max(0, Math.trunc(yearlyPriceIdr));
  return Math.max(0, safeMonthly * 12 - safeYearly);
}

/**
 * Defense-in-depth channel filter for owner UI: permits strictly enabled QRIS & Bank VA channels.
 * Never renders COD, retail outlets, or e-wallet redirects.
 */
export function filterOwnerAllowedChannels(
  channels: readonly OwnerBillingChannelDto[],
): readonly OwnerBillingChannelDto[] {
  const seen = new Set<string>();
  const out: OwnerBillingChannelDto[] = [];
  for (const ch of channels) {
    if (!ch || !ch.enabled) continue;
    const classified = classifyAllowedChannel(ch.code, ch.label);
    if (!classified.ok) continue;
    if (classified.kind !== ch.kind) continue;
    if (seen.has(classified.normalizedCode)) continue;
    seen.add(classified.normalizedCode);
    out.push({
      ...ch,
      code: classified.normalizedCode,
      estimatedFeeIdr: Math.max(0, Math.trunc(ch.estimatedFeeIdr)),
    });
  }
  return out;
}

export interface CheckoutBreakdown {
  readonly plan: BillingPlanInterval;
  readonly planLabel: string;
  readonly months: 1 | 12;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly yearlySavingsIdr: number;
  readonly periodStartAtIso: string;
  readonly periodEndAtIso: string;
  readonly periodRangeWibLabel: string;
  readonly renewalAnchor: RenewalAnchorKind;
}

export function computeCheckoutBreakdown(input: {
  readonly plan: BillingPlanInterval;
  readonly pricingPlans: readonly OwnerBillingPlanDto[];
  readonly selectedChannel: OwnerBillingChannelDto | null;
  readonly tenantStatus: TenantStatus;
  readonly paidThroughIso: string | null;
  readonly trialEndsAtIso: string | null;
  readonly nowMs: number;
}): CheckoutBreakdown {
  const monthlyPlan = input.pricingPlans.find((p) => p.plan === "monthly");
  const yearlyPlan = input.pricingPlans.find((p) => p.plan === "yearly");
  const monthlyBase = monthlyPlan?.baseAmountIdr ?? DEFAULT_MONTHLY_PRICE_IDR;
  const yearlyBase = yearlyPlan?.baseAmountIdr ?? DEFAULT_YEARLY_PRICE_IDR;
  const yearlySavingsIdr =
    yearlyPlan?.savingsIdr ?? computeYearlySavingsIdr(monthlyBase, yearlyBase);

  const baseAmountIdr = input.plan === "yearly" ? yearlyBase : monthlyBase;
  const discountAmountIdr = 0;
  const netAmountIdr = baseAmountIdr - discountAmountIdr;
  const channelFeeIdr = input.selectedChannel
    ? Math.max(0, Math.trunc(input.selectedChannel.estimatedFeeIdr))
    : 0;
  const totalPayableIdr = netAmountIdr + channelFeeIdr;

  const paidThroughMs = input.paidThroughIso ? Date.parse(input.paidThroughIso) : null;
  const trialEndsAtMs = input.trialEndsAtIso ? Date.parse(input.trialEndsAtIso) : null;

  const preview = computeSubscriptionPeriodPreview({
    plan: input.plan,
    tenantStatus: input.tenantStatus,
    paidThroughMs: paidThroughMs !== null && Number.isFinite(paidThroughMs) ? paidThroughMs : null,
    trialEndsAtMs: trialEndsAtMs !== null && Number.isFinite(trialEndsAtMs) ? trialEndsAtMs : null,
    nowMs: input.nowMs,
  });

  return {
    plan: input.plan,
    planLabel: input.plan === "yearly" ? "Tahunan (12 bulan kalender)" : "Bulanan (1 bulan kalender)",
    months: preview.months,
    baseAmountIdr,
    discountAmountIdr,
    netAmountIdr,
    channelFeeIdr,
    totalPayableIdr,
    yearlySavingsIdr,
    periodStartAtIso: preview.periodStartAtIso,
    periodEndAtIso: preview.periodEndAtIso,
    periodRangeWibLabel: `${formatWibDate(preview.periodStartAtIso)} – ${formatWibDate(preview.periodEndAtIso)} (WIB)`,
    renewalAnchor: preview.renewalAnchor,
  };
}

/**
 * Inspects URL query parameters for payment-return claims (`?status=paid&paid=1&return=success`).
 * NEVER activates service or alters server truth — returns metadata solely for showing an
 * explicit non-activation explanation while polling/reading authoritative server status.
 */
export function inspectPaymentReturnQueryParams(search: string): {
  readonly hasPaymentReturnClaim: boolean;
  readonly matchedParams: readonly string[];
} {
  const trimmed = search.trim();
  if (!trimmed) {
    return { hasPaymentReturnClaim: false, matchedParams: [] };
  }
  const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  const matched: string[] = [];
  params.forEach((value, key) => {
    const lowerKey = key.trim().toLowerCase();
    const lowerVal = value.trim().toLowerCase();
    if (
      PAYMENT_RETURN_CLAIM_PARAMS.has(lowerKey) ||
      lowerVal === "paid" ||
      lowerVal === "settled" ||
      lowerVal === "success"
    ) {
      matched.push(lowerKey);
    }
  });
  return {
    hasPaymentReturnClaim: matched.length > 0,
    matchedParams: Array.from(new Set(matched)),
  };
}

function isPaidThroughStillFuture(paidThroughIso: string | null | undefined, nowMs: number): boolean {
  if (!paidThroughIso) return true;
  const parsed = Date.parse(paidThroughIso);
  return Number.isFinite(parsed) && parsed > nowMs;
}

/**
 * Resolves the canonical Owner Billing visual state strictly from server DB facts
 * (never from URL query params or client claims).
 *
 * Hard invariant: NEVER returns `"paid"` when `tenantStatus` is `grace`, `locked`,
 * `suspended`, `recovery`, `trial`, or under `operatorHold`, even if an older obligation
 * in `obligations[0]` has `state === "paid"`.
 */
export function resolveOwnerBillingVisualState(input: {
  readonly tenantStatus?: TenantStatus;
  readonly operatorHold?: boolean;
  readonly paidThroughIso?: string | null;
  readonly nowMs?: number;
  readonly justSettled?: boolean;
  readonly activeObligation: OwnerBillingObligationDto | null;
  readonly activeAttempt: OwnerBillingAttemptDto | null;
  readonly obligations: readonly OwnerBillingObligationDto[];
  readonly providerOutage: boolean;
  readonly channelsCount: number;
}): OwnerBillingVisualState {
  const {
    tenantStatus = "active",
    operatorHold = false,
    paidThroughIso = null,
    nowMs = Date.now(),
    justSettled = false,
    activeObligation,
    activeAttempt,
    obligations,
    providerOutage,
    channelsCount,
  } = input;

  const canShowActivePaidBanner =
    tenantStatus === "active" && !operatorHold && isPaidThroughStillFuture(paidThroughIso, nowMs);

  if (activeAttempt) {
    if (activeAttempt.state === "creation_unknown") return "creation_unknown";
    if (activeAttempt.state === "review") return "review";
    if (activeAttempt.state === "pending" || activeAttempt.state === "creating") return "pending";
    if (activeAttempt.state === "paid") {
      if (canShowActivePaidBanner) return "paid";
    }
    if (activeAttempt.state === "expired" || activeAttempt.state === "failed") {
      return providerOutage && channelsCount === 0 ? "provider_outage" : "expired";
    }
  }

  if (activeObligation) {
    if (activeObligation.state === "review") return "review";
    if (activeObligation.state === "paid" && canShowActivePaidBanner) return "paid";
    if (activeObligation.state === "expired") {
      return providerOutage && channelsCount === 0 ? "provider_outage" : "expired";
    }
  }

  if (providerOutage && channelsCount === 0) {
    return "provider_outage";
  }

  const latestObligation = obligations[0] ?? null;
  if (!activeObligation && latestObligation) {
    if (latestObligation.state === "review") return "review";
    if (latestObligation.state === "expired") return "expired";
    if (latestObligation.state === "paid" && canShowActivePaidBanner) {
      const latestPeriodEndMs = latestObligation.periodEndAt
        ? Date.parse(latestObligation.periodEndAt)
        : null;
      const coversCurrentCycle =
        justSettled ||
        latestPeriodEndMs === null ||
        (Number.isFinite(latestPeriodEndMs) && latestPeriodEndMs > nowMs);
      if (coversCurrentCycle) return "paid";
    }
  }

  return "ready";
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export function buildBillingIdempotencyScopeKey(input: {
  readonly tenantId: string;
  readonly obligationId: string | null;
  readonly latestObligationId?: string | null;
  readonly paidThroughIso?: string | null;
  readonly plan: BillingPlanInterval;
  readonly channelCode: string;
}): string {
  const oblPart = input.obligationId?.trim()
    ? `obl:${input.obligationId.trim()}`
    : `new:${input.latestObligationId?.trim() || "none"}:${input.paidThroughIso?.trim() || "none"}`;
  const channelPart = input.channelCode.trim().toUpperCase() || "NONE";
  return `ps_billing_idem_v1:${input.tenantId.trim()}:${oblPart}:${input.plan}:${channelPart}`;
}

export function clearAllTenantBillingIdempotencyKeys(
  tenantId: string,
  storage?: StorageLike | null,
): void {
  const resolvedStorage =
    storage !== undefined
      ? storage
      : typeof window !== "undefined"
        ? window.sessionStorage
        : null;
  if (!resolvedStorage) return;
  const prefix = `ps_billing_idem_v1:${tenantId.trim()}:`;
  try {
    if (typeof resolvedStorage.length === "number" && typeof resolvedStorage.key === "function") {
      const toDelete: string[] = [];
      for (let i = 0; i < resolvedStorage.length; i += 1) {
        const k = resolvedStorage.key(i);
        if (k && k.startsWith(prefix)) toDelete.push(k);
      }
      for (const k of toDelete) {
        resolvedStorage.removeItem(k);
      }
    }
  } catch {
    // Non-fatal
  }
}

export function generateUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Returns the persisted per-obligation/plan/channel `Idempotency-Key` UUID so page refresh,
 * browser back-navigation, or rapid double-clicks reuse the EXACT same key and cannot create
 * a second provider charge.
 */
export function getOrCreateIdempotencyKey(
  scopeKey: string,
  storage?: StorageLike | null,
): string {
  const resolvedStorage =
    storage !== undefined
      ? storage
      : typeof window !== "undefined"
        ? window.sessionStorage
        : null;

  if (resolvedStorage) {
    try {
      const existing = resolvedStorage.getItem(scopeKey)?.trim() ?? "";
      if (UUID_V4_RE.test(existing)) {
        return existing;
      }
    } catch {
      // Storage blocked in restricted browser contexts; continue safely.
    }
  }

  const created = generateUuidV4();
  if (resolvedStorage) {
    try {
      resolvedStorage.setItem(scopeKey, created);
    } catch {
      // Non-fatal
    }
  }
  return created;
}

export function clearIdempotencyKey(scopeKey: string, storage?: StorageLike | null): void {
  const resolvedStorage =
    storage !== undefined
      ? storage
      : typeof window !== "undefined"
        ? window.sessionStorage
        : null;
  if (!resolvedStorage) return;
  try {
    resolvedStorage.removeItem(scopeKey);
  } catch {
    // Non-fatal
  }
}

export interface QrisReadableSummary {
  readonly merchantName: string | null;
  readonly merchantCity: string | null;
  readonly amountHint: string | null;
  readonly crc: string | null;
}

/**
 * Parses basic non-mutating EMVCo TLV summary fields from a QRIS string for screen-reader
 * and readable text alternatives (never alters the raw QRIS string).
 */
export function parseQrisReadableSummary(payload: string): QrisReadableSummary {
  const raw = payload.trim();
  let merchantName: string | null = null;
  let merchantCity: string | null = null;
  let amountHint: string | null = null;
  let crc: string | null = null;

  let i = 0;
  while (i + 4 <= raw.length) {
    const tag = raw.slice(i, i + 2);
    const lenStr = raw.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) break;
    const len = Number.parseInt(lenStr, 10);
    const valStart = i + 4;
    const valEnd = valStart + len;
    if (valEnd > raw.length) break;
    const val = raw.slice(valStart, valEnd);
    if (tag === "59") merchantName = val;
    if (tag === "60") merchantCity = val;
    if (tag === "54") amountHint = val;
    if (tag === "63") crc = val;
    i = valEnd;
  }

  return { merchantName, merchantCity, amountHint, crc };
}

export interface SafeQrisRenderResult {
  readonly svg: string | null;
  readonly payload: string;
  readonly summary: QrisReadableSummary;
}

/**
 * Generates a crisp deterministic SVG QR code using `@punyasitus/auth/platform/qr`
 * with graceful fallback to readable/copyable QRIS text if payload exceeds Version 12-M.
 */
export function renderQrisSvgSafely(qrisPayload: string): SafeQrisRenderResult {
  const trimmed = qrisPayload.trim();
  const summary = parseQrisReadableSummary(trimmed);
  if (!trimmed) {
    return { svg: null, payload: "", summary };
  }
  try {
    const svg = generateTotpQrSvg(trimmed, {
      quietZone: 4,
      label: "Kode QRIS pembayaran langganan PunyaSitus",
    });
    return { svg, payload: trimmed, summary };
  } catch {
    return { svg: null, payload: trimmed, summary };
  }
}

/**
 * Returns the canonical normalized HTTPS AutoLaris redirect URL via the shared
 * `validateApprovedPaymentRedirectUrl` contract (zero drift from server client),
 * or `null` if invalid/unsafe/unapproved.
 */
export function getSafeAutoLarisRedirectHref(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    return validateApprovedPaymentRedirectUrl(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Validates that a payment redirect URL is a safe HTTPS AutoLaris destination
 * (never `javascript:`, `data:`, `http:`, credentials, or arbitrary untrusted domains).
 */
export function isSafeAutoLarisRedirectUrl(rawUrl: string | null | undefined): boolean {
  return getSafeAutoLarisRedirectHref(rawUrl) !== null;
}

/**
 * Determines whether a console billing obligation is eligible for audited manual refund recording
 * (settled/paid obligations or review/post-purge anomalies — never unpaid open/expired rows).
 */
export function isConsoleObligationRefundEligible(item: ConsoleBillingObligationDto): boolean {
  return (
    item.settlementId !== null ||
    item.state === "paid" ||
    item.state === "review" ||
    item.reviewRequired ||
    item.latestAttempt?.state === "paid" ||
    item.latestAttempt?.state === "review"
  );
}

/**
 * Safely constructs a relative `/auth/...` step-up URL with a validated `next` query param
 * using the standard `URL` API (rejects open redirects, protocol-relative URLs, and arbitrary paths).
 */
export function buildSafeConsoleAuthHref(
  verifyPath: string | null | undefined,
  nextPath: string,
): string | null {
  if (!verifyPath || typeof verifyPath !== "string") return null;
  const trimmed = verifyPath.trim();
  if (
    !trimmed.startsWith("/auth/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /[\r\n\0]/.test(trimmed)
  ) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, "https://console.punyasitus.com");
    if (parsed.origin !== "https://console.punyasitus.com" || !parsed.pathname.startsWith("/auth/")) {
      return null;
    }
    const cleanNext = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/console/billing";
    parsed.searchParams.set("next", cleanNext);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function validateConsoleAuditReason(reason: string): {
  readonly ok: boolean;
  readonly trimmed: string;
  readonly error: string | null;
} {
  const trimmed = reason.trim();
  if (trimmed.length < 10) {
    return {
      ok: false,
      trimmed,
      error: "Alasan audit wajib diisi minimal 10 karakter (tanpa data rahasia/PII).",
    };
  }
  if (trimmed.length > 500) {
    return {
      ok: false,
      trimmed,
      error: "Alasan audit maksimal 500 karakter.",
    };
  }
  return { ok: true, trimmed, error: null };
}

export function findSensitiveBillingKeys(record: unknown): readonly string[] {
  const found: string[] = [];
  const forbidden = new Set<string>(CONSOLE_FORBIDDEN_SENSITIVE_FIELDS);
  const walk = (val: unknown, prefix: string) => {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) {
      val.forEach((item, idx) => walk(item, `${prefix}[${idx}]`));
      return;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      if (forbidden.has(k)) {
        found.push(next);
      }
      walk(v, next);
    }
  };
  walk(record, "");
  return found;
}

export function getTenantStatusIndonesianLabel(status: TenantStatus, operatorHold = false): string {
  if (operatorHold) return "Penahanan Operator";
  switch (status) {
    case "trial":
      return "Uji Coba (7 Hari)";
    case "active":
      return "Aktif";
    case "grace":
      return "Masa Tenggang (H+1–H+3)";
    case "locked":
      return "Terkunci / Baca Saja (H+4–H+7)";
    case "suspended":
      return "Ditangguhkan";
    case "recovery":
      return "Pemulihan Teknis";
    case "provisioning":
      return "Menyiapkan";
    case "purging":
      return "Penghapusan";
    case "purged":
      return "Dihapus";
  }
}

export function getAttemptStateBadgeMeta(state: OwnerAttemptState): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "success" | "warning" | "info" | "destructive";
} {
  switch (state) {
    case "paid":
      return { label: "Lunas Terverifikasi", variant: "success" };
    case "pending":
      return { label: "Menunggu Pembayaran", variant: "info" };
    case "creating":
      return { label: "Membuat Instruksi", variant: "info" };
    case "creation_unknown":
      return { label: "Rekonsiliasi Berjalan", variant: "warning" };
    case "review":
      return { label: "Perlu Tinjauan Operator", variant: "destructive" };
    case "expired":
      return { label: "Kedaluwarsa", variant: "secondary" };
    case "failed":
      return { label: "Ditolak Penyedia", variant: "secondary" };
  }
}

export function getObligationStateBadgeMeta(state: OwnerObligationState): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "success" | "warning" | "info" | "destructive";
} {
  switch (state) {
    case "paid":
      return { label: "Lunas", variant: "success" };
    case "open":
      return { label: "Terbuka", variant: "info" };
    case "review":
      return { label: "Tinjauan", variant: "destructive" };
    case "expired":
      return { label: "Kedaluwarsa", variant: "secondary" };
    case "cancelled":
      return { label: "Dibatalkan", variant: "outline" };
  }
}
