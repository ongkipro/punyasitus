import {
  AFFILIATE_PAYOUT_BANK_CODE_RE,
  AFFILIATE_PENDING_CODE_PREFIX,
  AFFILIATE_REFERRAL_CODE_RE,
  AFFILIATE_TERMS_VERSION_RE,
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  type AffiliateStatusLike,
  type ValidatedAffiliateApplicationPayload,
} from "./types.ts";

/**
 * Pure affiliate enrollment validation, payout identity hashing, email anti-abuse
 * canonicalization, and referral link builders (`packages/core/src/affiliates/validation.ts`;
 * REQ-084, PLAN §19.4, TASK-084).
 */

const ALLOWED_APPLY_KEYS: ReadonlySet<string> = new Set([
  "payoutBankCode",
  "payoutAccountNumber",
  "payoutAccountHolder",
  "termsAccepted",
  "termsVersion",
]);

const FORBIDDEN_APPLY_CLIENT_FIELDS = [
  "id",
  "affiliateId",
  "affiliate_id",
  "userId",
  "user_id",
  "email",
  "emailVerified",
  "email_verified",
  "status",
  "referralCode",
  "referral_code",
  "approvedReferralCode",
  "approved_referral_code",
  "approvedBy",
  "approved_by",
  "approvedByUserId",
  "approved_by_user_id",
  "approvedAt",
  "approved_at",
  "suspendedAt",
  "suspended_at",
  "commissionRate",
  "commission_rate",
  "payoutIdentityHash",
  "payout_identity_hash",
  "payoutAccountNumberHash",
  "payout_account_number_hash",
  "version",
  "role",
  "isPlatformOperator",
  "platformOperator",
] as const;

const FORBIDDEN_APPLY_FIELD_LOWER_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_APPLY_CLIENT_FIELDS.map((k) => k.toLowerCase()),
);

const CONTROL_CHARS_RE = /[\r\n\t\p{Cc}]+/gu;
const PAYOUT_NUMBER_SEPARATORS_RE = /[\s.-]+/g;
const DIGITS_ONLY_RE = /^\d{6,32}$/;

export type AffiliateValidationErrorCode =
  | "VALIDATION_ERROR"
  | "FORBIDDEN_CLIENT_FIELD"
  | "TERMS_NOT_ACCEPTED"
  | "INVALID_REFERRAL_CODE";

export class AffiliateValidationError extends Error {
  readonly status: 400 | 422;
  readonly code: AffiliateValidationErrorCode;
  readonly field?: string;

  constructor(
    status: 400 | 422,
    code: AffiliateValidationErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "AffiliateValidationError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/**
 * Returns `true` when `status` represents an approved/active affiliate eligible for
 * attribution and footer badge referral links.
 */
export function isAffiliateApprovedStatus(
  status: AffiliateStatusLike | string | null | undefined,
): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "active" || normalized === "approved";
}

/**
 * Validates and normalizes a public referral code (`^[A-Za-z0-9_-]{4,32}$`).
 * Rejects internal pending placeholders (`__pending_*`) and control/URL characters.
 * Returns normalized uppercase string or `null` if invalid.
 */
export function normalizeAffiliateReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith(AFFILIATE_PENDING_CODE_PREFIX)) {
    return null;
  }
  if (!AFFILIATE_REFERRAL_CODE_RE.test(trimmed)) {
    return null;
  }
  return trimmed.toUpperCase();
}

export function isValidAffiliateReferralCode(raw: unknown): boolean {
  return normalizeAffiliateReferralCode(raw) !== null;
}

/**
 * Builds the canonical `https://punyasitus.com/?ref=<code>` link for an approved affiliate.
 */
export function buildAffiliateReferralLink(
  referralCode: string,
  marketingOrigin: string = DEFAULT_AFFILIATE_MARKETING_ORIGIN,
): string {
  const normalized = normalizeAffiliateReferralCode(referralCode);
  if (!normalized) {
    throw new AffiliateValidationError(
      422,
      "INVALID_REFERRAL_CODE",
      "Kode referral afiliasi tidak valid.",
      "referralCode",
    );
  }
  const cleanOrigin = marketingOrigin.trim().replace(/\/+$/, "") || DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  return `${cleanOrigin}/?ref=${encodeURIComponent(normalized)}`;
}

/**
 * Masks a payout bank/e-wallet account number so raw account digits NEVER appear
 * in API responses, UI summaries, or `platform_audit` records.
 */
export function maskPayoutAccountNumber(digits: string): string {
  const clean = digits.replace(PAYOUT_NUMBER_SEPARATORS_RE, "").trim();
  if (clean.length <= 4) {
    return "*".repeat(Math.max(4, clean.length));
  }
  const visibleTail = clean.slice(-4);
  const hiddenCount = Math.max(4, clean.length - 4);
  return `${"*".repeat(hiddenCount)}${visibleTail}`;
}

/**
 * Canonicalizes an email address for anti-self-referral detection:
 * - Trims and lowercases
 * - Maps `googlemail.com` -> `gmail.com`
 * - Strips `+tag` subaddressing from local part
 * - Strips dots from `gmail.com` local part (`b.u.d.i+promo@gmail.com` -> `budi@gmail.com`)
 */
export function normalizeEmailForAntiAbuse(rawEmail: string): string {
  const trimmed = rawEmail.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return trimmed;
  }
  let local = trimmed.slice(0, atIndex);
  let domain = trimmed.slice(atIndex + 1);

  if (domain === "googlemail.com") {
    domain = "gmail.com";
  }

  const plusIdx = local.indexOf("+");
  if (plusIdx > 0) {
    local = local.slice(0, plusIdx);
  }

  if (domain === "gmail.com") {
    local = local.replace(/\./g, "");
  }

  return `${local}@${domain}`;
}

export function normalizePayoutBankCode(rawBankCode: string): string {
  return rawBankCode
    .replace(CONTROL_CHARS_RE, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

export function normalizePayoutAccountDigits(rawAccountNumber: string): string {
  return rawAccountNumber.replace(PAYOUT_NUMBER_SEPARATORS_RE, "").trim();
}

export function normalizePayoutHolderForHash(rawHolder: string): string {
  return rawHolder
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function sha256HexLower(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Computes the deterministic SHA-256 hash of a normalized payout account number
 * scoped to bank/e-wallet code.
 */
export async function computePayoutAccountNumberHash(
  bankCode: string,
  accountNumber: string,
): Promise<string> {
  const normBank = normalizePayoutBankCode(bankCode);
  const normDigits = normalizePayoutAccountDigits(accountNumber);
  return sha256HexLower(`ps:acct:v1:${normBank}:${normDigits}`);
}

/**
 * Computes the deterministic SHA-256 `payout_identity_hash` used for anti-self-referral
 * detection across users sharing the same bank/e-wallet payout destination.
 */
export async function computePayoutIdentityHash(params: {
  readonly payoutBankCode: string;
  readonly payoutAccountNumber: string;
}): Promise<string> {
  const normBank = normalizePayoutBankCode(params.payoutBankCode);
  const normDigits = normalizePayoutAccountDigits(params.payoutAccountNumber);
  return sha256HexLower(`ps:payout_identity:v1:${normBank}:${normDigits}`);
}

export async function computeNormalizedEmailHash(email: string): Promise<string> {
  return sha256HexLower(`ps:email:v1:${normalizeEmailForAntiAbuse(email)}`);
}

/**
 * Strictly validates `POST /api/affiliates/apply` JSON payload.
 * Rejects forged server/privilege fields, unknown keys, unaccepted terms, and invalid payout details.
 */
export function validateAffiliateApplicationPayload(
  rawBody: unknown,
): ValidatedAffiliateApplicationPayload {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw new AffiliateValidationError(
      400,
      "VALIDATION_ERROR",
      "Format isi permintaan JSON harus berupa objek.",
    );
  }

  const record = rawBody as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_APPLY_FIELD_LOWER_SET.has(key.toLowerCase())) {
      throw new AffiliateValidationError(
        422,
        "FORBIDDEN_CLIENT_FIELD",
        `Kolom "${key}" dikelola sepenuhnya oleh server dan tidak boleh dikirim oleh klien.`,
        key,
      );
    }
    if (!ALLOWED_APPLY_KEYS.has(key)) {
      throw new AffiliateValidationError(
        422,
        "VALIDATION_ERROR",
        `Kolom "${key}" tidak dikenali pada pendaftaran afiliasi.`,
        key,
      );
    }
  }

  if (typeof record.payoutBankCode !== "string") {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Kode bank atau e-wallet pencairan wajib diisi.",
      "payoutBankCode",
    );
  }
  const payoutBankCode = normalizePayoutBankCode(record.payoutBankCode);
  if (!AFFILIATE_PAYOUT_BANK_CODE_RE.test(payoutBankCode)) {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Kode bank atau e-wallet harus terdiri dari 2-24 karakter alfanumerik (contoh: BCA, MANDIRI, GOPAY).",
      "payoutBankCode",
    );
  }

  if (typeof record.payoutAccountNumber !== "string") {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Nomor rekening atau nomor e-wallet pencairan wajib diisi.",
      "payoutAccountNumber",
    );
  }
  const payoutAccountNumberDigits = normalizePayoutAccountDigits(record.payoutAccountNumber);
  if (!DIGITS_ONLY_RE.test(payoutAccountNumberDigits)) {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Nomor rekening atau e-wallet harus terdiri dari 6 hingga 32 digit angka.",
      "payoutAccountNumber",
    );
  }

  if (typeof record.payoutAccountHolder !== "string") {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Nama pemilik rekening pencairan wajib diisi.",
      "payoutAccountHolder",
    );
  }
  const payoutAccountHolder = record.payoutAccountHolder
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (payoutAccountHolder.length < 2 || payoutAccountHolder.length > 120) {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Nama pemilik rekening harus terdiri dari 2 hingga 120 karakter.",
      "payoutAccountHolder",
    );
  }

  if (record.termsAccepted !== true) {
    throw new AffiliateValidationError(
      422,
      "TERMS_NOT_ACCEPTED",
      "Anda wajib menyetujui syarat dan ketentuan program afiliasi PunyaSitus.",
      "termsAccepted",
    );
  }

  if (typeof record.termsVersion !== "string") {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Versi syarat dan ketentuan afiliasi wajib disertakan.",
      "termsVersion",
    );
  }
  const termsVersion = record.termsVersion.trim();
  if (!AFFILIATE_TERMS_VERSION_RE.test(termsVersion)) {
    throw new AffiliateValidationError(
      422,
      "VALIDATION_ERROR",
      "Format versi syarat dan ketentuan afiliasi tidak valid.",
      "termsVersion",
    );
  }

  return {
    payoutBankCode,
    payoutAccountNumberDigits,
    payoutAccountMasked: maskPayoutAccountNumber(payoutAccountNumberDigits),
    payoutAccountHolder,
    termsAccepted: true,
    termsVersion,
  };
}
