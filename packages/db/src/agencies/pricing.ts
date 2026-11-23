import { MAX_IDR_AMOUNT, MIN_AUTOLARIS_CHARGE_IDR } from "@punyasitus/core/billing/index";
import {
  AgencyError,
  DEFAULT_AGENCY_UNPAID_TRIAL_CAP,
  MAX_AGENCY_DISCOUNT_PERCENT,
  MAX_AGENCY_DISCOUNT_TIERS,
  type AgencyCheckoutAmounts,
  type AgencyDiscountTier,
  type AgencyTrialQuotaSummary,
} from "./types.ts";

/**
 * Pure, server-authoritative pricing, volume discount tier, and unpaid-trial-cap
 * evaluators for the Agency / Reseller Portal (REQ-083, PLAN §19.4, TASK-083).
 */

export function validateAgencyDiscountPercent(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Persentase diskon agensi harus berupa bilangan bulat.",
    );
  }
  if (raw < 0 || raw > MAX_AGENCY_DISCOUNT_PERCENT) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      `Persentase diskon agensi harus berada di antara 0% hingga ${MAX_AGENCY_DISCOUNT_PERCENT}%.`,
    );
  }
  return raw;
}

export function validateAgencyDiscountTiers(raw: unknown): readonly AgencyDiscountTier[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Daftar tier diskon volume agensi harus berupa array.",
    );
  }
  if (raw.length > MAX_AGENCY_DISCOUNT_TIERS) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      `Maksimal ${MAX_AGENCY_DISCOUNT_TIERS} tier diskon volume agensi diperbolehkan.`,
    );
  }

  const parsed: AgencyDiscountTier[] = [];
  const seenThresholds = new Set<number>();

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AgencyError(
        422,
        "VALIDATION_ERROR",
        `Entri tier diskon ke-${i + 1} tidak valid.`,
      );
    }
    const rec = item as Record<string, unknown>;
    const minPaidClients = rec.minPaidClients;
    const discountPercent = rec.discountPercent;

    if (
      typeof minPaidClients !== "number" ||
      !Number.isInteger(minPaidClients) ||
      minPaidClients < 1 ||
      minPaidClients > 10_000
    ) {
      throw new AgencyError(
        422,
        "VALIDATION_ERROR",
        `Ambang batas klien berbayar pada tier ke-${i + 1} harus bilangan bulat 1–10.000.`,
      );
    }
    if (seenThresholds.has(minPaidClients)) {
      throw new AgencyError(
        422,
        "VALIDATION_ERROR",
        `Ambang batas ${minPaidClients} klien berbayar duplikat dalam tier diskon.`,
      );
    }
    seenThresholds.add(minPaidClients);

    const validPercent = validateAgencyDiscountPercent(discountPercent);
    parsed.push({
      minPaidClients,
      discountPercent: validPercent,
    });
  }

  parsed.sort((a, b) => a.minPaidClients - b.minPaidClients);

  // Enforce monotonic non-decreasing discount percentages across ascending volume tiers
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1]!;
    const curr = parsed[i]!;
    if (curr.discountPercent < prev.discountPercent) {
      throw new AgencyError(
        422,
        "VALIDATION_ERROR",
        "Persentase diskon pada tier volume lebih tinggi tidak boleh lebih kecil dari tier sebelumnya.",
      );
    }
  }

  return parsed;
}

export function parseStoredDiscountTiersJson(rawJson: string | null | undefined): readonly AgencyDiscountTier[] {
  if (!rawJson || !rawJson.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return validateAgencyDiscountTiers(parsed);
  } catch {
    return [];
  }
}

export function computeEffectiveAgencyDiscountPercent(params: {
  readonly baseDiscountPercent: number;
  readonly discountTiers: readonly AgencyDiscountTier[];
  readonly paidClientCount: number;
}): { readonly effectiveDiscountPercent: number; readonly tierCode: string } {
  const base = Math.max(
    0,
    Math.min(MAX_AGENCY_DISCOUNT_PERCENT, Math.trunc(params.baseDiscountPercent)),
  );
  const paidCount = Math.max(0, Math.trunc(params.paidClientCount));

  let matchedTier: AgencyDiscountTier | null = null;
  for (const tier of params.discountTiers) {
    if (paidCount >= tier.minPaidClients) {
      if (!matchedTier || tier.discountPercent >= matchedTier.discountPercent) {
        matchedTier = tier;
      }
    }
  }

  if (matchedTier && matchedTier.discountPercent > base) {
    return {
      effectiveDiscountPercent: Math.min(MAX_AGENCY_DISCOUNT_PERCENT, matchedTier.discountPercent),
      tierCode: `volume_${matchedTier.minPaidClients}_${matchedTier.discountPercent}pct`,
    };
  }

  return {
    effectiveDiscountPercent: base,
    tierCode: base === 0 ? "standard_0" : `custom_${base}pct`,
  };
}

/**
 * Exact integer IDR agency checkout breakdown.
 * - Agency discount is computed server-side via integer floor (`Math.floor(base * pct / 100)`).
 * - Net payable is strictly clamped to `>= MIN_AUTOLARIS_CHARGE_IDR` (Rp 10.000) so no charge
 *   ever falls below the payment gateway minimum.
 */
export function computeAgencyClientCheckoutAmounts(params: {
  readonly baseAmountIdr: number;
  readonly agencyDiscountPercent: number;
  readonly couponDiscountIdr?: number;
}): AgencyCheckoutAmounts {
  const base = Math.trunc(params.baseAmountIdr);
  if (!Number.isSafeInteger(base) || base < MIN_AUTOLARIS_CHARGE_IDR || base > MAX_IDR_AMOUNT) {
    throw new AgencyError(
      422,
      "VALIDATION_ERROR",
      "Nominal harga dasar paket tidak valid.",
    );
  }

  const pct = validateAgencyDiscountPercent(params.agencyDiscountPercent);
  const couponRaw = Math.max(0, Math.trunc(params.couponDiscountIdr ?? 0));

  const rawAgencyDiscount = Math.floor((base * pct) / 100);
  const maxAllowedDiscount = Math.max(0, base - MIN_AUTOLARIS_CHARGE_IDR);
  const agencyDiscountIdr = Math.min(rawAgencyDiscount, maxAllowedDiscount);
  const remainingDiscountRoom = Math.max(0, maxAllowedDiscount - agencyDiscountIdr);
  const couponDiscountIdr = Math.min(couponRaw, remainingDiscountRoom);
  const totalDiscountIdr = agencyDiscountIdr + couponDiscountIdr;
  const netAmountIdr = base - totalDiscountIdr;

  return {
    baseAmountIdr: base,
    agencyDiscountPercent: pct,
    agencyDiscountIdr,
    couponDiscountIdr,
    totalDiscountIdr,
    netAmountIdr,
  };
}

/**
 * Evaluates the REQ-083 / DEC-045 unpaid trial cap:
 * - Before an agency has at least 1 paid/settled client (`paidClientCount === 0`),
 *   it may hold at most `unpaidTrialCap` (default `3`) unpaid trial clients.
 * - Once at least 1 linked client has settled a paid subscription (`paidClientCount >= 1`),
 *   the unpaid-trial cap is unlocked.
 */
export function evaluateAgencyTrialQuota(params: {
  readonly unpaidTrialCount: number;
  readonly paidClientCount: number;
  readonly unpaidTrialCap?: number;
}): AgencyTrialQuotaSummary {
  const cap = Math.max(0, Math.trunc(params.unpaidTrialCap ?? DEFAULT_AGENCY_UNPAID_TRIAL_CAP));
  const unpaid = Math.max(0, Math.trunc(params.unpaidTrialCount));
  const paid = Math.max(0, Math.trunc(params.paidClientCount));
  const unlockedByPaidClient = paid >= 1;

  if (unlockedByPaidClient) {
    return {
      unpaidTrialCap: cap,
      unpaidTrialCount: unpaid,
      paidClientCount: paid,
      unlockedByPaidClient: true,
      remainingUnpaidTrials: null,
      canCreateTrial: true,
    };
  }

  const remaining = Math.max(0, cap - unpaid);
  return {
    unpaidTrialCap: cap,
    unpaidTrialCount: unpaid,
    paidClientCount: paid,
    unlockedByPaidClient: false,
    remainingUnpaidTrials: remaining,
    canCreateTrial: unpaid < cap,
  };
}
