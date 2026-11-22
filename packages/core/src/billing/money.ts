import {
  MAX_IDR_AMOUNT,
  MAX_PROVIDER_FEE_MIN_CEILING_IDR,
  MAX_PROVIDER_FEE_RATIO_PERCENT,
} from "./constants.ts";
import { BillingValidationError } from "./errors.ts";

/**
 * Exact integer IDR arithmetic & decimal string parser (PLAN §16.2).
 * Never uses binary floating-point multiplication for money.
 */

const DECIMAL_RE = /^([0-9]+)(?:\.([0-9]{1,4}))?$/;
const MAX_PERCENT_FEE_SCALED = 250_000n; // 25.0000% ceiling on runtime channel preview

export function assertExactIdrInteger(
  value: unknown,
  fieldName: string,
  options?: { readonly min?: number; readonly max?: number },
): number {
  const min = options?.min ?? 0;
  const max = options?.max ?? MAX_IDR_AMOUNT;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BillingValidationError(
      "INVALID_IDR_AMOUNT",
      `Field "${fieldName}" harus berupa bilangan bulat IDR yang valid.`,
      [{ field: fieldName, code: "INVALID_IDR_AMOUNT", message: "Expected an exact integer IDR amount." }],
    );
  }
  if (value < min || value > max) {
    throw new BillingValidationError(
      "IDR_AMOUNT_OUT_OF_RANGE",
      `Field "${fieldName}" berada di luar rentang IDR yang diizinkan (${min}..${max}).`,
      [
        {
          field: fieldName,
          code: "IDR_AMOUNT_OUT_OF_RANGE",
          message: `Amount must be between ${min} and ${max} IDR.`,
        },
      ],
    );
  }
  return value;
}

/**
 * Parses a strict non-negative numeric/string integer (allowing trailing `.0` / `.00` from AutoLaris JSON)
 * into a safe JS integer without binary float drift.
 */
export function parseExactProviderInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    return assertExactIdrInteger(value, fieldName);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = DECIMAL_RE.exec(trimmed);
    if (!match) {
      throw new BillingValidationError(
        "INVALID_PROVIDER_NUMBER",
        `Nilai numerik provider "${fieldName}" tidak valid.`,
        [{ field: fieldName, code: "INVALID_PROVIDER_NUMBER", message: "Invalid decimal format." }],
      );
    }
    const wholePart = match[1]!;
    const fracPart = match[2] ?? "";
    if (fracPart.length > 0 && /[1-9]/.test(fracPart)) {
      throw new BillingValidationError(
        "NON_INTEGER_IDR_VALUE",
        `Nilai IDR provider "${fieldName}" tidak boleh mengandung pecahan sen.`,
        [{ field: fieldName, code: "NON_INTEGER_IDR_VALUE", message: "IDR amount must be a whole integer." }],
      );
    }
    const parsedBig = BigInt(wholePart);
    if (parsedBig < 0n || parsedBig > BigInt(MAX_IDR_AMOUNT)) {
      throw new BillingValidationError(
        "IDR_AMOUNT_OUT_OF_RANGE",
        `Nilai IDR provider "${fieldName}" di luar batas.`,
        [{ field: fieldName, code: "IDR_AMOUNT_OUT_OF_RANGE", message: "Amount out of bounds." }],
      );
    }
    return Number(parsedBig);
  }
  throw new BillingValidationError(
    "INVALID_PROVIDER_NUMBER",
    `Nilai numerik provider "${fieldName}" tidak valid.`,
    [{ field: fieldName, code: "INVALID_PROVIDER_NUMBER", message: "Expected integer or decimal string." }],
  );
}

/**
 * Parses a decimal string (up to 4 fractional digits) into a scaled BigInt with `scaleDigits = 4`.
 * Example: `"0.7"` -> `7000n`, `"3000.0"` -> `30000000n`.
 */
export function parseScaledDecimal4(raw: string | number, fieldName: string): bigint {
  const str = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : raw.trim();
  const match = DECIMAL_RE.exec(str);
  if (!match) {
    throw new BillingValidationError(
      "INVALID_FEE_FORMAT",
      `Format biaya "${fieldName}" tidak valid.`,
      [{ field: fieldName, code: "INVALID_FEE_FORMAT", message: "Expected non-negative decimal with at most 4 decimal places." }],
    );
  }
  const whole = BigInt(match[1]!);
  const fracPadded = (match[2] ?? "").padEnd(4, "0");
  return whole * 10_000n + BigInt(fracPadded);
}

export function computeMaxAllowedProviderFeeIdr(
  netAmountIdr: number,
  options?: { readonly maxFeeRatioPercent?: number; readonly maxAbsoluteFeeFloorIdr?: number },
): number {
  const ratio = options?.maxFeeRatioPercent ?? MAX_PROVIDER_FEE_RATIO_PERCENT;
  const floor = options?.maxAbsoluteFeeFloorIdr ?? MAX_PROVIDER_FEE_MIN_CEILING_IDR;
  const proportional = Number((BigInt(netAmountIdr) * BigInt(ratio)) / 100n);
  return Math.max(floor, proportional);
}

/**
 * Computes exact integer preview fee from AutoLaris `list_payment` channel metadata.
 * - `tipe_admin === "fix"`: whole IDR integer (e.g. `"3000.0"` -> `3000`).
 * - `tipe_admin === "persen"`: exact BigInt half-up rounding (`"0.7"` on `10_000` -> `70`, on `179_000` -> `1253`).
 */
export function estimateChannelFeeIdr(
  baseAmountIdr: number,
  feeConfig: { readonly admin: string | number; readonly tipeAdmin: string },
): number {
  const base = assertExactIdrInteger(baseAmountIdr, "baseAmountIdr");
  const mode = feeConfig.tipeAdmin.trim().toLowerCase();

  if (mode === "fix") {
    const fixedFee = parseExactProviderInteger(feeConfig.admin, "admin");
    const maxFee = computeMaxAllowedProviderFeeIdr(base);
    if (fixedFee > maxFee) {
      throw new BillingValidationError(
        "ABSURD_CHANNEL_FEE",
        `Biaya admin channel (${fixedFee}) melebihi batas wajar (${maxFee}).`,
        [{ field: "admin", code: "ABSURD_CHANNEL_FEE", message: "Fixed channel fee exceeds policy ceiling." }],
      );
    }
    return fixedFee;
  }

  if (mode === "persen") {
    const scaledPercent = parseScaledDecimal4(feeConfig.admin, "admin");
    if (scaledPercent > MAX_PERCENT_FEE_SCALED) {
      throw new BillingValidationError(
        "ABSURD_CHANNEL_FEE",
        "Persentase biaya admin channel melebihi batas wajar.",
        [{ field: "admin", code: "ABSURD_CHANNEL_FEE", message: "Percentage channel fee exceeds policy ceiling." }],
      );
    }
    // scaledPercent is percentage * 10_000, so dividing by 100 * 10_000 = 1_000_000 yields IDR
    const denominator = 1_000_000n;
    const numerator = BigInt(base) * scaledPercent;
    const rounded = (numerator + denominator / 2n) / denominator;
    const feeIdr = Number(rounded);
    const maxFee = computeMaxAllowedProviderFeeIdr(base);
    if (feeIdr > maxFee) {
      throw new BillingValidationError(
        "ABSURD_CHANNEL_FEE",
        `Biaya admin channel (${feeIdr}) melebihi batas wajar (${maxFee}).`,
        [{ field: "admin", code: "ABSURD_CHANNEL_FEE", message: "Computed percentage fee exceeds policy ceiling." }],
      );
    }
    return feeIdr;
  }

  throw new BillingValidationError(
    "INVALID_FEE_TYPE",
    `Tipe biaya admin channel "${feeConfig.tipeAdmin}" tidak didukung.`,
    [{ field: "tipe_admin", code: "INVALID_FEE_TYPE", message: "Expected 'fix' or 'persen'." }],
  );
}

export interface ProviderCostValidationInput {
  readonly expectedNetAmountIdr: number;
  readonly biayaKirim: unknown;
  readonly biayaCod: unknown;
  readonly biayaAsuransi: unknown;
  readonly biayaAdmin: unknown;
  readonly diskon: unknown;
  readonly total: unknown;
  readonly maxFeeRatioPercent?: number;
  readonly maxAbsoluteFeeFloorIdr?: number;
}

export interface ValidatedProviderCosts {
  readonly channelFeeIdr: number;
  readonly grossAdminFeeIdr: number;
  readonly providerDiscountIdr: number;
  readonly totalPayableIdr: number;
}

/**
 * Validates AutoLaris `/api/h2h/submit` cost breakdown for a non-physical subscription order (PLAN §16.2).
 * Rejects any shipping fee, COD fee, insurance fee, negative/absurd admin fee, or mismatched total.
 */
export function validateProviderCosts(input: ProviderCostValidationInput): ValidatedProviderCosts {
  const expectedNet = assertExactIdrInteger(input.expectedNetAmountIdr, "expectedNetAmountIdr", {
    min: 1,
  });

  const biayaKirim = parseExactProviderInteger(input.biayaKirim ?? 0, "biaya_kirim");
  if (biayaKirim !== 0) {
    throw new BillingValidationError(
      "UNEXPECTED_SHIPPING_FEE",
      `Biaya pengiriman tidak diizinkan untuk langganan digital (diterima: ${biayaKirim}).`,
      [{ field: "biaya_kirim", code: "UNEXPECTED_SHIPPING_FEE", message: "Expected 0 shipping fee." }],
    );
  }

  const biayaCod = parseExactProviderInteger(input.biayaCod ?? 0, "biaya_cod");
  if (biayaCod !== 0) {
    throw new BillingValidationError(
      "UNEXPECTED_COD_FEE",
      `Biaya COD tidak diizinkan untuk langganan digital (diterima: ${biayaCod}).`,
      [{ field: "biaya_cod", code: "UNEXPECTED_COD_FEE", message: "Expected 0 COD fee." }],
    );
  }

  const biayaAsuransi = parseExactProviderInteger(input.biayaAsuransi ?? 0, "biaya_asuransi");
  if (biayaAsuransi !== 0) {
    throw new BillingValidationError(
      "UNEXPECTED_INSURANCE_FEE",
      `Biaya asuransi tidak diizinkan untuk langganan digital (diterima: ${biayaAsuransi}).`,
      [{ field: "biaya_asuransi", code: "UNEXPECTED_INSURANCE_FEE", message: "Expected 0 insurance fee." }],
    );
  }

  const grossAdminFeeIdr = parseExactProviderInteger(input.biayaAdmin, "biaya_admin");
  const providerDiscountIdr = parseExactProviderInteger(input.diskon ?? 0, "diskon");

  if (providerDiscountIdr > grossAdminFeeIdr) {
    throw new BillingValidationError(
      "INVALID_PROVIDER_DISCOUNT",
      "Diskon provider melebihi biaya admin.",
      [{ field: "diskon", code: "INVALID_PROVIDER_DISCOUNT", message: "Provider discount cannot exceed biaya_admin." }],
    );
  }

  const channelFeeIdr = grossAdminFeeIdr - providerDiscountIdr;
  const maxAllowedFee = computeMaxAllowedProviderFeeIdr(expectedNet, {
    maxFeeRatioPercent: input.maxFeeRatioPercent,
    maxAbsoluteFeeFloorIdr: input.maxAbsoluteFeeFloorIdr,
  });
  if (channelFeeIdr > maxAllowedFee) {
    throw new BillingValidationError(
      "INVALID_PROVIDER_FEE",
      `Biaya channel provider (${channelFeeIdr}) melebihi batas kebijakan (${maxAllowedFee}).`,
      [{ field: "biaya_admin", code: "INVALID_PROVIDER_FEE", message: "Provider channel fee exceeds allowed ceiling." }],
    );
  }

  const totalPayableIdr = parseExactProviderInteger(input.total, "total");
  const expectedTotal = expectedNet + channelFeeIdr;
  if (totalPayableIdr !== expectedTotal) {
    throw new BillingValidationError(
      "PROVIDER_TOTAL_MISMATCH",
      `Total tagihan provider (${totalPayableIdr}) tidak sesuai dengan pokok + biaya admin (${expectedTotal}).`,
      [
        {
          field: "total",
          code: "PROVIDER_TOTAL_MISMATCH",
          message: `Expected total ${expectedTotal} IDR, received ${totalPayableIdr} IDR.`,
        },
      ],
    );
  }

  return {
    channelFeeIdr,
    grossAdminFeeIdr,
    providerDiscountIdr,
    totalPayableIdr,
  };
}

export function formatIdrDisplay(amountIdr: number): string {
  const safe = assertExactIdrInteger(amountIdr, "amountIdr");
  const formatted = String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${formatted}`;
}
