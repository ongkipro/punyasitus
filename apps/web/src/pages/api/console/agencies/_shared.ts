import {
  consoleErrorResponse,
  mapPlatformErrorToResponse,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  AgencyError,
  type AgencyInvitationRecord,
  type AgencySummary,
} from "@punyasitus/db/agencies/index";

/**
 * Shared DTO formatting, env extraction, and error mapping for
 * `/api/console/agencies/**` (REQ-083, REQ-051, PLAN §13 & §19.4, TASK-083).
 */

export interface ConsoleAgencyDto {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
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
  readonly unpaidTrialCount: number;
  readonly paidClientCount: number;
  readonly unlockedByPaidClient: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsoleAgencyInvitationDto {
  readonly id: string;
  readonly email: string;
  readonly agencyName: string | null;
  readonly status: AgencyInvitationRecord["status"];
  readonly expiresAt: string;
  readonly createdAt: string;
}

export function formatConsoleAgencyDto(agency: AgencySummary): ConsoleAgencyDto {
  return {
    id: agency.id,
    organizationId: agency.organizationId,
    ownerUserId: agency.ownerUserId,
    ownerEmail: agency.ownerEmail,
    ownerName: agency.ownerName,
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
    unpaidTrialCount: agency.trialQuota.unpaidTrialCount,
    paidClientCount: agency.trialQuota.paidClientCount,
    unlockedByPaidClient: agency.trialQuota.unlockedByPaidClient,
    version: agency.version,
    createdAt: new Date(agency.createdAt).toISOString(),
    updatedAt: new Date(agency.updatedAt).toISOString(),
  };
}

export function formatConsoleAgencyInvitationDto(
  inv: AgencyInvitationRecord,
): ConsoleAgencyInvitationDto {
  return {
    id: inv.id,
    email: inv.email,
    agencyName: inv.agencyName,
    status: inv.status,
    expiresAt: new Date(inv.expiresAt).toISOString(),
    createdAt: new Date(inv.createdAt).toISOString(),
  };
}

export function resolveConsoleAgenciesRuntimeEnv(
  rawEnv: Readonly<Record<string, unknown>>,
): ConsoleRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? undefined,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: rawEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export function mapConsoleAgencyErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof AgencyError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }
  return mapPlatformErrorToResponse(err, requestId);
}
