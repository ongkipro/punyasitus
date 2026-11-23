import {
  agencyErrorResponse,
  AgencyGuardError,
  canAgencyRolePerform,
  type AgencyPermissionAction,
  type AgencyRuntimeEnv,
  type VerifiedAgencyUserContext,
} from "@punyasitus/auth/agency/index";
import {
  BillingConflictError,
  BillingNotFoundError,
  BillingProviderError,
  BillingValidationError,
} from "@punyasitus/core/billing/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  AgencyError,
  type AgencyClientSummary,
  type AgencySummary,
  type PaymentReceiptRecord,
  type UserAgencyMembership,
} from "@punyasitus/db/agencies/index";
import {
  createAutoLarisClient,
  type AutoLarisBillingClient,
} from "../../../../../../packages/integrations/src/autolaris/index.ts";

/**
 * Shared DTO formatters, runtime env extraction, AutoLaris client resolver, and
 * error mapping for `/api/agency/**` (REQ-083, PLAN §19.4, TASK-083).
 */

export function resolveAgencyRuntimeEnv(
  rawEnv: Readonly<Record<string, unknown>>,
): AgencyRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    SAAS_ZONE: typeof rawEnv.SAAS_ZONE === "string" ? rawEnv.SAAS_ZONE : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? undefined,
    MEDIA_BUCKET: (rawEnv.MEDIA_BUCKET as R2Bucket | undefined) ?? undefined,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: rawEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    AUTOLARIS_RELAY_URL:
      typeof rawEnv.AUTOLARIS_RELAY_URL === "string" ? rawEnv.AUTOLARIS_RELAY_URL : undefined,
    AUTOLARIS_API_KEY:
      typeof rawEnv.AUTOLARIS_API_KEY === "string" ? rawEnv.AUTOLARIS_API_KEY : undefined,
    AUTOLARIS_ACCOUNT_ID:
      typeof rawEnv.AUTOLARIS_ACCOUNT_ID === "string" ? rawEnv.AUTOLARIS_ACCOUNT_ID : undefined,
  };
}

export function resolveAgencyAutoLarisClient(
  runtimeEnv: AgencyRuntimeEnv,
  override?: AutoLarisBillingClient | null,
  fetchImpl?: typeof fetch,
): AutoLarisBillingClient {
  if (override) return override;
  const relayBaseUrl = runtimeEnv.AUTOLARIS_RELAY_URL?.trim() ?? "";
  const apiKey = runtimeEnv.AUTOLARIS_API_KEY?.trim() ?? "";
  if (!relayBaseUrl || !apiKey) {
    throw new BillingProviderError(
      "relay_config_error",
      "AUTOLARIS_NOT_CONFIGURED",
      "Integrasi AutoLaris belum dikonfigurasi pada server ini.",
    );
  }
  return createAutoLarisClient({
    relayBaseUrl,
    apiKey,
    providerAccountId: runtimeEnv.AUTOLARIS_ACCOUNT_ID,
    fetchImpl,
  });
}

export interface AgencySummaryDto {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: AgencySummary["status"];
  readonly enrollmentSource: AgencySummary["enrollmentSource"];
  readonly billingEmail: string;
  readonly billingName: string;
  readonly baseDiscountPercent: number;
  readonly effectiveDiscountPercent: number;
  readonly discountTierCode: string;
  readonly discountTiers: AgencySummary["discountTiers"];
  readonly unpaidTrialCap: number;
  readonly totalClientCount: number;
  readonly trialQuota: AgencySummary["trialQuota"];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function formatAgencySummaryDto(agency: AgencySummary): AgencySummaryDto {
  return {
    id: agency.id,
    organizationId: agency.organizationId,
    name: agency.name,
    status: agency.status,
    enrollmentSource: agency.enrollmentSource,
    billingEmail: agency.billingEmail,
    billingName: agency.billingName,
    baseDiscountPercent: agency.baseDiscountPercent,
    effectiveDiscountPercent: agency.effectiveDiscountPercent,
    discountTierCode: agency.discountTierCode,
    discountTiers: agency.discountTiers,
    unpaidTrialCap: agency.unpaidTrialCap,
    totalClientCount: agency.totalClientCount,
    trialQuota: agency.trialQuota,
    version: agency.version,
    createdAt: new Date(agency.createdAt).toISOString(),
    updatedAt: new Date(agency.updatedAt).toISOString(),
  };
}

export interface AgencyClientDto {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly agencyId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: AgencyClientSummary["vertical"];
  readonly status: AgencyClientSummary["status"];
  readonly effectiveStatus: AgencyClientSummary["effectiveStatus"];
  readonly primaryHost: string;
  readonly billingPayer: "agency";
  readonly isUnpaidTrial: boolean;
  readonly hasSettledPayment: boolean;
  readonly trialEndsAt: string | null;
  readonly paidThrough: string | null;
  readonly openObligationId: string | null;
  readonly openObligationNetIdr: number | null;
  readonly dashboardUrl: string;
  readonly manageUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function formatAgencyClientDto(client: AgencyClientSummary): AgencyClientDto {
  return {
    tenantId: client.tenantId,
    organizationId: client.organizationId,
    agencyId: client.agencyId,
    handle: client.handle,
    name: client.name,
    vertical: client.vertical,
    status: client.status,
    effectiveStatus: client.effectiveStatus,
    primaryHost: client.primaryHost,
    billingPayer: "agency",
    isUnpaidTrial: client.isUnpaidTrial,
    hasSettledPayment: client.hasSettledPayment,
    trialEndsAt: client.trialEndsAt !== null ? new Date(client.trialEndsAt).toISOString() : null,
    paidThrough: client.paidThrough !== null ? new Date(client.paidThrough).toISOString() : null,
    openObligationId: client.openObligationId,
    openObligationNetIdr: client.openObligationNetIdr,
    dashboardUrl: `/dashboard/${encodeURIComponent(client.handle)}`,
    manageUrl: `/agency/clients/${encodeURIComponent(client.handle)}`,
    createdAt: new Date(client.createdAt).toISOString(),
    updatedAt: new Date(client.updatedAt).toISOString(),
  };
}

export interface AgencyReceiptDto {
  readonly id: string;
  readonly receiptNumber: string;
  readonly documentKind: PaymentReceiptRecord["documentKind"];
  readonly tenantId: string;
  readonly agencyId: string | null;
  readonly obligationId: string;
  readonly settlementId: string | null;
  readonly planCode: string;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly paymentChannel: string;
  readonly issuedAt: string;
  readonly emailedAt: string | null;
  readonly pdfDownloadUrl: string;
}

export function formatAgencyReceiptDto(receipt: PaymentReceiptRecord): AgencyReceiptDto {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    documentKind: receipt.documentKind,
    tenantId: receipt.tenantId,
    agencyId: receipt.agencyId,
    obligationId: receipt.obligationId,
    settlementId: receipt.settlementId,
    planCode: receipt.planCode,
    baseAmountIdr: receipt.baseAmountIdr,
    discountAmountIdr: receipt.discountAmountIdr,
    channelFeeIdr: receipt.channelFeeIdr,
    totalAmountIdr: receipt.totalAmountIdr,
    paymentChannel: receipt.paymentChannel,
    issuedAt: receipt.issuedAtIso,
    emailedAt: receipt.emailedAtIso,
    pdfDownloadUrl: `/api/agency/billing/receipts/${encodeURIComponent(receipt.id)}/pdf`,
  };
}

export function resolveAuthorizedTargetMembership(
  actor: VerifiedAgencyUserContext,
  bodyAgencyId: string | null,
  requiredPermission: AgencyPermissionAction,
  requestId: string,
):
  | { readonly ok: true; readonly membership: UserAgencyMembership }
  | { readonly ok: false; readonly response: Response } {
  const targetId = bodyAgencyId ?? actor.activeAgency?.id ?? null;
  if (!targetId) {
    return {
      ok: false,
      response: agencyErrorResponse(404, "NOT_FOUND", "Agensi tidak ditemukan.", requestId),
    };
  }
  const membership = actor.memberships.find((m) => m.agency.id === targetId) ?? null;
  if (!membership) {
    return {
      ok: false,
      response: agencyErrorResponse(404, "NOT_FOUND", "Agensi tidak ditemukan.", requestId),
    };
  }
  if (membership.agency.status === "suspended") {
    return {
      ok: false,
      response: agencyErrorResponse(
        403,
        "AGENCY_SUSPENDED",
        "Akun agensi ini sedang ditangguhkan. Hubungi tim support PunyaSitus.",
        requestId,
      ),
    };
  }
  if (!canAgencyRolePerform(membership.role, requiredPermission)) {
    return {
      ok: false,
      response: agencyErrorResponse(
        403,
        "FORBIDDEN",
        "Peran agensi Anda tidak memiliki izin untuk melakukan tindakan ini pada agensi tersebut.",
        requestId,
      ),
    };
  }
  return { ok: true, membership };
}

export function mapAgencyErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof AgencyGuardError) {
    return agencyErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof AgencyError) {
    return agencyErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof BillingNotFoundError) {
    return agencyErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof BillingConflictError) {
    return agencyErrorResponse(409, err.reasonCode || err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
    });
  }
  if (err instanceof BillingValidationError) {
    return agencyErrorResponse(422, err.reasonCode || err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
      fields: err.fields,
    });
  }
  if (err instanceof BillingProviderError) {
    return agencyErrorResponse(
      502,
      err.code,
      err.message,
      requestId,
      { kind: err.kind },
      { "Retry-After": "30" },
    );
  }
  return agencyErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses permintaan Portal Agensi.",
    requestId,
  );
}
