import { estimateChannelFeeIdr } from "./money.ts";

/**
 * Runtime AutoLaris payment channel validation (PLAN §16.1, §16.2; REQ-056, CMSPRO DEC-057).
 *
 * Strictly permits ONLY:
 * - QRIS (`QRIS`, `QRIS_*`)
 * - Bank Virtual Accounts (`VA*`, e.g. `VABCA`, `VABNI`, `VABRI`, `VAMANDIRI`, `VAPERMATA`, `VABSI`, `VACIMB`, `VADANAMON`, `VA_BCA`)
 *
 * Explicitly rejects:
 * - COD
 * - Retail / OTC outlets (Alfamart, Alfamidi, Indomaret, Lawson, Dan+Dan, etc.)
 * - E-wallet redirects (OVO, DANA, ShopeePay, LinkAja, GoPay, AstraPay, JeniusPay, etc.)
 * - Cards / PayLater / unknown channel families
 */

export type AllowedPaymentChannelKind = "QRIS" | "VA";

export interface RawAutoLarisPaymentChannel {
  readonly channel_code: unknown;
  readonly name: unknown;
  readonly admin: unknown;
  readonly tipe_admin: unknown;
}

export interface ValidatedPaymentChannel {
  readonly code: string;
  readonly label: string;
  readonly kind: AllowedPaymentChannelKind;
  readonly feeType: "fix" | "persen";
  readonly rawFeeValue: string;
  readonly estimatedFeeIdr: number;
  readonly enabled: true;
}

export type ChannelClassificationResult =
  | {
      readonly ok: true;
      readonly kind: AllowedPaymentChannelKind;
      readonly normalizedCode: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | "EMPTY_CHANNEL_CODE"
        | "FORBIDDEN_COD_CHANNEL"
        | "FORBIDDEN_RETAIL_CHANNEL"
        | "FORBIDDEN_EWALLET_CHANNEL"
        | "UNSUPPORTED_PAYMENT_CHANNEL";
      readonly reason: string;
    };

const FORBIDDEN_COD_RE = /^COD(?:$|[_-])/i;
const FORBIDDEN_RETAIL_RE =
  /(?:ALFAMART|ALFAMIDI|INDOMARET|LAWSON|DANDAN|RETAIL|GERAI|OTC|CONVENIENCE|MINIMARKET)/i;
const FORBIDDEN_EWALLET_RE =
  /(?:OVO|DANA|SHOPEE|SHOPEEPAY|LINKAJA|GOPAY|ASTRAPAY|JENIUSPAY|SAKUKU|ISAKU|EWALLET|WALLET|KREDIVO|AKULAKU|PAYLATER|CREDIT|CARD|^CC$)/i;

const QRIS_CODE_RE = /^QRIS(?:_[A-Z0-9]{1,24})?$/;
const BANK_VA_CODE_RE = /^VA_?[A-Z0-9]{2,24}$/;

/**
 * Classifies a runtime AutoLaris `channel_code` against the strict QRIS & Bank VA policy.
 */
export function classifyAllowedChannel(
  rawChannelCode: string,
  rawLabel?: string,
): ChannelClassificationResult {
  const normalized = rawChannelCode.trim().toUpperCase();
  if (!normalized || normalized.length > 40 || !/^[A-Z0-9_-]+$/.test(normalized)) {
    return {
      ok: false,
      code: "EMPTY_CHANNEL_CODE",
      reason: "Kode channel pembayaran tidak valid.",
    };
  }

  const labelText = (rawLabel ?? "").trim();

  if (FORBIDDEN_COD_RE.test(normalized) || /\bCOD\b/i.test(labelText)) {
    return {
      ok: false,
      code: "FORBIDDEN_COD_CHANNEL",
      reason: "Channel COD tidak diizinkan untuk langganan platform.",
    };
  }

  if (FORBIDDEN_RETAIL_RE.test(normalized) || FORBIDDEN_RETAIL_RE.test(labelText)) {
    return {
      ok: false,
      code: "FORBIDDEN_RETAIL_CHANNEL",
      reason: "Channel gerai ritel tidak diizinkan; gunakan QRIS atau Virtual Account bank.",
    };
  }

  if (FORBIDDEN_EWALLET_RE.test(normalized) || FORBIDDEN_EWALLET_RE.test(labelText)) {
    return {
      ok: false,
      code: "FORBIDDEN_EWALLET_CHANNEL",
      reason: "Channel e-wallet redirect tidak diizinkan; gunakan QRIS atau Virtual Account bank.",
    };
  }

  if (QRIS_CODE_RE.test(normalized)) {
    return { ok: true, kind: "QRIS", normalizedCode: normalized };
  }

  if (BANK_VA_CODE_RE.test(normalized)) {
    return { ok: true, kind: "VA", normalizedCode: normalized };
  }

  return {
    ok: false,
    code: "UNSUPPORTED_PAYMENT_CHANNEL",
    reason: `Channel "${normalized}" tidak termasuk QRIS atau Virtual Account bank yang diizinkan.`,
  };
}

/**
 * Filters a runtime AutoLaris `GET /api/h2h/list_payment` response to strictly valid
 * QRIS and Bank Virtual Account channels with valid non-negative fees.
 */
export function filterAllowedAutoLarisChannels(
  rawChannels: readonly RawAutoLarisPaymentChannel[],
  referenceBaseAmountIdr: number,
): readonly ValidatedPaymentChannel[] {
  const seen = new Set<string>();
  const accepted: ValidatedPaymentChannel[] = [];

  for (const item of rawChannels) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.channel_code !== "string") continue;
    const label =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim().slice(0, 100)
        : item.channel_code.trim().toUpperCase();

    const classified = classifyAllowedChannel(item.channel_code, label);
    if (!classified.ok) continue;
    if (seen.has(classified.normalizedCode)) continue;

    if (typeof item.tipe_admin !== "string") continue;
    const feeType = item.tipe_admin.trim().toLowerCase();
    if (feeType !== "fix" && feeType !== "persen") continue;
    if (typeof item.admin !== "string" && typeof item.admin !== "number") continue;

    try {
      const estimatedFeeIdr = estimateChannelFeeIdr(referenceBaseAmountIdr, {
        admin: item.admin,
        tipeAdmin: feeType,
      });
      seen.add(classified.normalizedCode);
      accepted.push({
        code: classified.normalizedCode,
        label,
        kind: classified.kind,
        feeType,
        rawFeeValue: String(item.admin).trim(),
        estimatedFeeIdr,
        enabled: true,
      });
    } catch {
      // Drop channels with malformed, negative, or absurd fees instead of trusting them.
      continue;
    }
  }

  return accepted;
}
