/**
 * Pure affiliate domain constants & types (`packages/core/src/affiliates/types.ts`;
 * REQ-084, DEC-038, DEC-045, PLAN §19.4, TASK-084).
 */

export const AFFILIATE_COOKIE_NAME = "ps_ref" as const;
export const AFFILIATE_COOKIE_VERSION = "v1" as const;
export const AFFILIATE_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60; // Exact 30 days = 2,592,000s
export const AFFILIATE_COOKIE_TTL_MS = AFFILIATE_COOKIE_TTL_SECONDS * 1000;
export const AFFILIATE_COOKIE_FUTURE_SKEW_SECONDS = 300; // 5 minutes max clock skew

export const AFFILIATE_REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;
export const AFFILIATE_PENDING_CODE_PREFIX = "__pending_" as const;
export const AFFILIATE_TERMS_VERSION_RE = /^[A-Za-z0-9._-]{2,32}$/;
export const AFFILIATE_PAYOUT_BANK_CODE_RE = /^[A-Z0-9_-]{2,24}$/;

export const DEFAULT_AFFILIATE_MARKETING_ORIGIN = "https://punyasitus.com" as const;
export const POWERED_BY_BADGE_TEXT = "Dibuat dengan PunyaSitus" as const;

export const AFFILIATE_DB_STATUSES = ["pending", "active", "suspended", "rejected"] as const;
export type AffiliateDbStatus = (typeof AFFILIATE_DB_STATUSES)[number];

/**
 * Pure helpers accept both the canonical D1 status `"active"` and the semantic alias `"approved"`.
 */
export type AffiliateStatusLike = AffiliateDbStatus | "approved";

export const AFFILIATE_ATTRIBUTION_SOURCES = [
  "cookie",
  "manual_code",
  "footer_badge",
  "superadmin_correction",
] as const;
export type AffiliateAttributionSource = (typeof AFFILIATE_ATTRIBUTION_SOURCES)[number];

export const TENANT_ATTRIBUTION_EXCLUSION_KINDS = [
  "superadmin_created",
  "complimentary",
  "platform",
  "demo",
  "agency_managed",
] as const;
export type TenantAttributionExclusionKind = (typeof TENANT_ATTRIBUTION_EXCLUSION_KINDS)[number];

export const SUPPORTED_AFFILIATE_PAYOUT_BANK_CODES = [
  "BCA",
  "MANDIRI",
  "BRI",
  "BNI",
  "BSI",
  "CIMB",
  "PERMATA",
  "DANAMON",
  "BTN",
  "OCBC",
  "PANIN",
  "MAYBANK",
  "MEGA",
  "BTPN",
  "JENIUS",
  "JAGO",
  "SEABANK",
  "BLU",
  "NEO",
  "GOPAY",
  "OVO",
  "DANA",
  "SHOPEEPAY",
  "LINKAJA",
] as const;

export type SupportedAffiliatePayoutBankCode =
  (typeof SUPPORTED_AFFILIATE_PAYOUT_BANK_CODES)[number];

export interface ValidatedAffiliateApplicationPayload {
  readonly payoutBankCode: string;
  readonly payoutAccountNumberDigits: string;
  readonly payoutAccountMasked: string;
  readonly payoutAccountHolder: string;
  readonly termsAccepted: true;
  readonly termsVersion: string;
}

export interface ParsedAffiliateCookie {
  readonly valid: true;
  readonly referralCode: string;
  readonly issuedAtSec: number;
  readonly issuedAtMs: number;
  readonly source: "cookie" | "footer_badge";
}

export interface InvalidAffiliateCookie {
  readonly valid: false;
  readonly reason:
    | "missing"
    | "malformed"
    | "invalid_code"
    | "invalid_signature"
    | "expired"
    | "future_timestamp";
}

export type AffiliateCookieVerificationResult = ParsedAffiliateCookie | InvalidAffiliateCookie;

export interface TenantPoweredByBadgeInput {
  readonly tenantStatus: string;
  readonly hidePoweredByBadge?: boolean | null;
  readonly affiliateReferralCode?: string | null;
  readonly affiliateStatus?: AffiliateStatusLike | string | null;
  readonly marketingOrigin?: string | null;
}

export interface ResolvedTenantPoweredByBadge {
  readonly visible: boolean;
  readonly canHide: boolean;
  readonly canAttachAffiliateRef: boolean;
  readonly text: typeof POWERED_BY_BADGE_TEXT;
  readonly href: string;
  readonly referralCode: string | null;
  readonly isAffiliateLinked: boolean;
  readonly rel: "noopener noreferrer";
}
