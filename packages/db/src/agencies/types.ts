import type { TenantStatus, TenantVertical } from "../platform/schema.ts";

export type AgencyStatus = "pending" | "active" | "suspended";
export type AgencyMemberRole = "agency_owner" | "agency_admin" | "agency_billing" | "agency_staff";
export type AgencyMemberStatus = "active" | "revoked";
export type AgencyEnrollmentSource = "self_registered" | "operator_invited";
export type AgencyInvitationKind = "agency_onboarding" | "agency_member";
export type AgencyInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export const DEFAULT_AGENCY_TERMS_VERSION = "2026-11-agency-v1" as const;
export const DEFAULT_AGENCY_UNPAID_TRIAL_CAP = 3 as const;
export const MAX_AGENCY_DISCOUNT_PERCENT = 50 as const;
export const MAX_AGENCY_DISCOUNT_TIERS = 5 as const;

export type AgencyErrorCode =
  | "VALIDATION_ERROR"
  | "EMAIL_NOT_VERIFIED"
  | "AGENCY_TERMS_REQUIRED"
  | "AGENCY_ALREADY_EXISTS"
  | "AGENCY_SUSPENDED"
  | "AGENCY_TRIAL_LIMIT_REACHED"
  | "INVALID_HANDLE"
  | "RESERVED_HANDLE"
  | "HANDLE_TAKEN"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_INVITATION"
  | "INVITATION_EXPIRED"
  | "INVITATION_EMAIL_MISMATCH"
  | "STALE_VERSION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "AUDIT_PERSISTENCE_FAILED"
  | "TENANT_STORE_INIT_FAILED";

export class AgencyError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 503;
  readonly code: AgencyErrorCode;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 503,
    code: AgencyErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AgencyError";
    this.status = status;
    this.code = code;
  }
}

export interface AgencyDiscountTier {
  readonly minPaidClients: number;
  readonly discountPercent: number;
}

export interface AgencyTrialQuotaSummary {
  readonly unpaidTrialCap: number;
  readonly unpaidTrialCount: number;
  readonly paidClientCount: number;
  readonly unlockedByPaidClient: boolean;
  readonly remainingUnpaidTrials: number | null;
  readonly canCreateTrial: boolean;
}

export interface AgencySummary {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
  readonly name: string;
  readonly status: AgencyStatus;
  readonly enrollmentSource: AgencyEnrollmentSource;
  readonly termsVersion: string | null;
  readonly termsAcceptedAt: number | null;
  readonly billingEmail: string;
  readonly billingName: string;
  readonly baseDiscountPercent: number;
  readonly effectiveDiscountPercent: number;
  readonly discountTierCode: string;
  readonly discountTiers: readonly AgencyDiscountTier[];
  readonly unpaidTrialCap: number;
  readonly totalClientCount: number;
  readonly trialQuota: AgencyTrialQuotaSummary;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgencyMemberRecord {
  readonly id: string;
  readonly agencyId: string;
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly role: AgencyMemberRole;
  readonly status: AgencyMemberStatus;
  readonly invitedByUserId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

export interface UserAgencyMembership {
  readonly agency: AgencySummary;
  readonly role: AgencyMemberRole;
}

export interface AgencyInvitationRecord {
  readonly id: string;
  readonly kind: AgencyInvitationKind;
  readonly agencyId: string | null;
  readonly email: string;
  readonly agencyName: string | null;
  readonly role: AgencyMemberRole;
  readonly status: AgencyInvitationStatus;
  readonly invitedByUserId: string;
  readonly acceptedByUserId: string | null;
  readonly acceptedAt: number | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgencyClientSummary {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly agencyId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly effectiveStatus: TenantStatus;
  readonly primaryHost: string;
  readonly billingPayer: "agency";
  readonly isUnpaidTrial: boolean;
  readonly hasSettledPayment: boolean;
  readonly trialEndsAt: number | null;
  readonly paidThrough: number | null;
  readonly openObligationId: string | null;
  readonly openObligationNetIdr: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgencyClientContextBannerPayload {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly clientTenantId: string;
  readonly clientName: string;
  readonly clientHandle: string;
  readonly returnHref: string;
  readonly dashboardUrl: string;
}

export interface AgencyCheckoutAmounts {
  readonly baseAmountIdr: number;
  readonly agencyDiscountPercent: number;
  readonly agencyDiscountIdr: number;
  readonly couponDiscountIdr: number;
  readonly totalDiscountIdr: number;
  readonly netAmountIdr: number;
}
