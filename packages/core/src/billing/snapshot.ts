import {
  REDACTED_VALUE,
  isSensitiveFieldName,
  redactSensitiveString,
} from "../jobs/redact.ts";
import {
  AUTOLARIS_REFF_ID_MAX_LENGTH,
  BILLING_CURRENCY,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
} from "./constants.ts";
import { assertExactIdrInteger } from "./money.ts";
import type { BillingPlanInterval, RenewalAnchorKind, SubscriptionPeriodPreview } from "./period.ts";

/**
 * Immutable obligation snapshots, deterministic request hashing, ULID/reff_id generation,
 * and billing-specific log redaction (PLAN §16.2, §16.4).
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface BillingObligationSnapshot {
  readonly schemaVersion: 1;
  readonly plan: BillingPlanInterval;
  readonly months: 1 | 12;
  readonly currency: typeof BILLING_CURRENCY;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly netAmountIdr: number;
  readonly estimatedChannelFeeIdr: number;
  readonly pricingSource: "platform_settings" | "default";
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly renewalAnchor: RenewalAnchorKind;
  readonly nonPkp: true;
  readonly taxNotice: string;
  readonly noRefundPolicy: true;
  readonly noRefundNotice: string;
  readonly snapshotCreatedAt: string;
}

export function buildImmutableObligationSnapshot(input: {
  readonly plan: BillingPlanInterval;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly estimatedChannelFeeIdr: number;
  readonly pricingSource: "platform_settings" | "default";
  readonly period: SubscriptionPeriodPreview;
  readonly createdAtMs: number;
}): BillingObligationSnapshot {
  const baseAmountIdr = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr", { min: 1 });
  const discountAmountIdr = assertExactIdrInteger(input.discountAmountIdr, "discountAmountIdr", {
    min: 0,
    max: baseAmountIdr,
  });
  const netAmountIdr = baseAmountIdr - discountAmountIdr;
  const estimatedChannelFeeIdr = assertExactIdrInteger(
    input.estimatedChannelFeeIdr,
    "estimatedChannelFeeIdr",
    { min: 0 },
  );

  return {
    schemaVersion: 1,
    plan: input.plan,
    months: input.period.months,
    currency: BILLING_CURRENCY,
    baseAmountIdr,
    discountAmountIdr,
    netAmountIdr,
    estimatedChannelFeeIdr,
    pricingSource: input.pricingSource,
    periodStartAt: input.period.periodStartAtIso,
    periodEndAt: input.period.periodEndAtIso,
    renewalAnchor: input.period.renewalAnchor,
    nonPkp: true,
    taxNotice: NON_PKP_TAX_NOTICE,
    noRefundPolicy: true,
    noRefundNotice: NO_REFUND_NOTICE,
    snapshotCreatedAt: new Date(Math.trunc(input.createdAtMs)).toISOString(),
  };
}

/**
 * Generates a 26-character Crockford Base32 ULID compatible with `UlidSchema`.
 */
export function generateBillingUlid(nowMs: number = Date.now()): string {
  const timestamp = Math.max(0, Math.trunc(nowMs));
  let timeRemaining = timestamp;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = CROCKFORD_BASE32[timeRemaining % 32] ?? "0";
    timeRemaining = Math.floor(timeRemaining / 32);
  }

  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const randChars = new Array<string>(16);
  for (let i = 0; i < 16; i += 1) {
    randChars[i] = CROCKFORD_BASE32[(randomBytes[i] ?? 0) & 31] ?? "0";
  }

  return `${timeChars.join("")}${randChars.join("")}`;
}

/**
 * Generates an AutoLaris-compatible partner reference (`reff_id`, <= 30 uppercase ASCII chars).
 * Format: `PS` + 9-char base36 timestamp + 15-char random hex = 26 chars (strictly <= 30).
 */
export function generateAutoLarisReffId(nowMs: number = Date.now()): string {
  const ts = Math.max(0, Math.trunc(nowMs)).toString(36).toUpperCase().padStart(9, "0").slice(-9);
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  let hex = "";
  for (const byte of randomBytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  const candidate = `PS${ts}${hex.slice(0, 15).toUpperCase()}`;
  return candidate.slice(0, AUTOLARIS_REFF_ID_MAX_LENGTH);
}

/**
 * Computes a deterministic SHA-256 hex digest of a normalized billing creation request
 * for strict idempotency payload-mismatch detection (`409 IDEMPOTENCY_CONFLICT`).
 */
export async function computeBillingRequestHash(input: {
  readonly tenantId: string;
  readonly plan: BillingPlanInterval;
  readonly channelKind: "QRIS" | "VA";
  readonly channelCode: string;
  readonly couponCode: string | null;
}): Promise<string> {
  const canonical = JSON.stringify({
    tenantId: input.tenantId.trim(),
    plan: input.plan,
    channelKind: input.channelKind,
    channelCode: input.channelCode.trim().toUpperCase(),
    couponCode: input.couponCode ? input.couponCode.trim().toUpperCase() : null,
  });
  const encoded = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const BILLING_SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^qr$/i,
  /qris[_-]?payload/i,
  /^va$/i,
  /va[_-]?number/i,
  /virtual[_-]?account/i,
  /payment[_-]?code/i,
  /payment[_-]?info/i,
  /payment[_-]?redirect[_-]?url/i,
  /buyer[_-]?info/i,
  /pickup[_-]?info/i,
  /shipper[_-]?/i,
  /receiver[_-]?/i,
  /customer[_-]?/i,
  /autolaris[_-]?key/i,
];

export function isBillingSensitiveKey(key: string): boolean {
  if (isSensitiveFieldName(key)) return true;
  const trimmed = key.trim();
  if (!trimmed) return false;
  return BILLING_SENSITIVE_KEY_PATTERNS.some((re) => re.test(trimmed));
}

function redactBillingValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (depth >= 5 || typeof value !== "object") {
    return REDACTED_VALUE;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactBillingValue(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isBillingSensitiveKey(k)) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = redactBillingValue(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Redacts secrets, Bearer tokens, API keys, QRIS/VA payment strings, and contact data
 * from billing logs and telemetry objects (PLAN §16.4).
 */
export function redactBillingLogRecord(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  seen.add(record);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isBillingSensitiveKey(key)) {
      out[key] = REDACTED_VALUE;
    } else {
      out[key] = redactBillingValue(value, 1, seen);
    }
  }
  return out;
}
