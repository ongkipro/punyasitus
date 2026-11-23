import type {
  AffiliateAttributionSource,
  AffiliateDbStatus,
  ResolvedTenantPoweredByBadge,
} from "@punyasitus/core/affiliates/index";
import type { PlatformAuditRecord } from "../platform/audit.ts";

export type AffiliateErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "EMAIL_NOT_VERIFIED"
  | "VALIDATION_ERROR"
  | "FORBIDDEN_CLIENT_FIELD"
  | "TERMS_NOT_ACCEPTED"
  | "INVALID_REFERRAL_CODE"
  | "AFFILIATE_ALREADY_EXISTS"
  | "REFERRAL_CODE_TAKEN"
  | "NOT_FOUND"
  | "AFFILIATE_NOT_FOUND"
  | "AFFILIATE_NOT_ACTIVE"
  | "AFFILIATE_NOT_APPROVED"
  | "TRIAL_BADGE_LOCKED"
  | "INVALID_STATE_TRANSITION"
  | "STALE_VERSION"
  | "TENANT_INELIGIBLE_FOR_ATTRIBUTION"
  | "SELF_REFERRAL_FORBIDDEN"
  | "AUDIT_PERSISTENCE_FAILED";

export class AffiliateError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500;
  readonly code: AffiliateErrorCode;
  readonly field?: string;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
    code: AffiliateErrorCode,
    message: string,
    options?: { readonly field?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AffiliateError";
    this.status = status;
    this.code = code;
    this.field = options?.field;
  }
}

export interface AffiliateAccountRecord {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly status: AffiliateDbStatus;
  /** `null` until approved by a superadmin. */
  readonly referralCode: string | null;
  /** `null` unless `status === "active"` and `referralCode` is issued. */
  readonly referralLink: string | null;
  readonly payoutBankCode: string;
  readonly payoutAccountHolder: string;
  readonly payoutAccountMasked: string;
  readonly payoutAccountNumberHash: string;
  readonly payoutIdentityHash: string;
  readonly termsVersion: string;
  readonly termsAcceptedAt: number;
  readonly approvedByUserId: string | null;
  readonly approvedAt: number | null;
  readonly suspendedByUserId: string | null;
  readonly suspendedAt: number | null;
  readonly rejectedByUserId: string | null;
  readonly rejectedAt: number | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublicAffiliateSummaryDto {
  readonly id: string;
  readonly userId: string;
  readonly status: AffiliateDbStatus;
  readonly referralCode: string | null;
  readonly referralLink: string | null;
  readonly payoutBankCode: string;
  readonly payoutAccountHolder: string;
  readonly payoutAccountMasked: string;
  readonly termsVersion: string;
  readonly termsAcceptedAt: number;
  readonly approvedAt: number | null;
  readonly suspendedAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ApplyAffiliateInput {
  readonly userId: string;
  readonly payload: unknown;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface ApplyAffiliateResult {
  readonly affiliate: AffiliateAccountRecord;
  readonly audit: PlatformAuditRecord;
}

export interface ApproveAffiliateInput {
  readonly affiliateId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly referralCode?: string | null;
  readonly expectedVersion?: number;
  readonly marketingOrigin?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface SuspendAffiliateInput {
  readonly affiliateId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface RejectAffiliateInput {
  readonly affiliateId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface TenantAttributionEligibilityFlags {
  readonly isAgencyManaged?: boolean;
  readonly isSuperadminCreated?: boolean;
  readonly isComplimentary?: boolean;
  readonly isPlatform?: boolean;
  readonly isDemo?: boolean;
}

export interface TenantAffiliateAttributionRecord {
  readonly tenantId: string;
  readonly affiliateId: string | null;
  readonly referralCode: string | null;
  readonly attributionSource: AffiliateAttributionSource;
  readonly attributedAt: number;
  readonly locked: true;
  readonly correctedByUserId: string | null;
  readonly correctionReason: string | null;
  readonly correctedAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AttributionSkipReason =
  | "no_referral_candidate"
  | "invalid_code"
  | "cookie_expired"
  | "already_locked"
  | "tenant_not_found"
  | "affiliate_not_found"
  | "affiliate_not_active"
  | "self_referral_user_id"
  | "self_referral_org_member"
  | "self_referral_email"
  | "self_referral_oauth_identity"
  | "self_referral_payout_identity"
  | "ineligible_agency_managed"
  | "ineligible_superadmin_created"
  | "ineligible_complimentary"
  | "ineligible_platform"
  | "ineligible_demo"
  | "ineligible_invalid_metadata";

export interface LockTenantAffiliateAttributionInput {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly referralCode: string | null | undefined;
  readonly attributionSource: "cookie" | "manual_code" | "footer_badge";
  readonly cookieIssuedAtMs?: number;
  readonly ownerPayoutIdentityHash?: string | null;
  readonly ownerPayoutAccount?: {
    readonly payoutBankCode: string;
    readonly payoutAccountNumber: string;
  } | null;
  readonly eligibilityFlags?: TenantAttributionEligibilityFlags;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export type LockTenantAffiliateAttributionResult =
  | {
      readonly attributed: true;
      readonly attribution: TenantAffiliateAttributionRecord;
      readonly audit: PlatformAuditRecord;
    }
  | {
      readonly attributed: false;
      readonly reason: AttributionSkipReason;
      readonly existingAffiliateId?: string | null;
    };

export interface CorrectTenantAffiliateAttributionInput {
  readonly tenantId: string;
  readonly newAffiliateId: string | null;
  readonly actorUserId: string;
  readonly reason: string;
  readonly expectedVersion?: number | null;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface CorrectTenantAffiliateAttributionResult {
  readonly attribution: TenantAffiliateAttributionRecord;
  readonly previousAffiliateId: string | null;
  readonly audit: PlatformAuditRecord;
}

export interface UpdateTenantPoweredBySettingsInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly hidePoweredByBadge: boolean;
  readonly attachOwnAffiliateRef?: boolean;
  readonly marketingOrigin?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface UpdateTenantPoweredBySettingsResult {
  readonly badge: ResolvedTenantPoweredByBadge;
  readonly hidePoweredByBadge: boolean;
  readonly ownerAffiliateId: string | null;
  readonly audit: PlatformAuditRecord;
}
