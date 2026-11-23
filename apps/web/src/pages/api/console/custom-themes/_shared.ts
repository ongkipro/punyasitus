import {
  consoleErrorResponse,
  mapPlatformErrorToResponse,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  CUSTOM_THEME_ALLOWED_TRANSITIONS,
  CUSTOM_THEME_STATUS_LABELS_ID,
  CustomThemeValidationError,
  SERVICE_KIND_LABELS_ID,
  STAFF_ACCESS_STATE_LABELS_ID,
  type CustomThemePackageRecord,
  type CustomThemeRequestRecord,
  type CustomThemeRequestStatus,
  type ServiceKind,
  type StaffAccessState,
} from "@punyasitus/core/custom-themes/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  CustomThemeRepositoryError,
  type TenantCustomThemeGrantSummary,
  type TenantServiceSeatUsage,
} from "@punyasitus/db/custom-themes/index";

/**
 * Shared DTO formatters, env extraction, and error mapping for
 * `/api/console/custom-themes/**` (REQ-063, REQ-051, PLAN §11.4 & §13, TASK-061).
 * ZERO runtime DDL.
 */

export interface ConsoleCustomThemePackageDto {
  readonly id: string;
  readonly serviceKind: ServiceKind;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inclusions: readonly string[];
  readonly startingPriceIdr: number | null;
  readonly priceLabel: string;
  readonly estimatedDuration: string;
  readonly sortOrder: number;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsoleCustomThemeGrantDto {
  readonly grantId: string;
  readonly themeId: string;
  readonly slug: string;
  readonly name: string;
  readonly grantedAt: string;
}

export interface ConsoleStaffAccessDto {
  readonly state: StaffAccessState;
  readonly stateLabel: string;
  readonly staffUserId: string | null;
  readonly staffEmail: string | null;
  readonly staffName: string | null;
  readonly staffMemberId: string | null;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly joinedAt: string | null;
  readonly revokedAt: string | null;
  readonly waitReason: string | null;
}

export interface ConsoleTenantSeatsDto {
  readonly activeMembersCount: number;
  readonly pendingInvitationsCount: number;
  readonly seatsUsed: number;
  readonly seatsLimit: number;
  readonly seatsRemaining: number;
}

export interface ConsoleCustomThemeRequestDto {
  readonly id: string;
  readonly requestCode: string;
  readonly serviceKind: ServiceKind;
  readonly serviceKindLabel: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly packageId: string | null;
  readonly packageName: string;
  readonly requestedByUserId: string;
  readonly status: CustomThemeRequestStatus;
  readonly statusLabel: string;
  readonly allowedNextStatuses: readonly CustomThemeRequestStatus[];
  readonly brandName: string;
  readonly brief: string;
  readonly referenceUrls: readonly string[];
  readonly budgetRange: string | null;
  readonly contactPreference: "whatsapp" | "email" | "both";
  readonly deliveredThemeId: string | null;
  readonly deliveredThemeGrantId: string | null;
  readonly statusReason: string | null;
  readonly operatorNotes: string | null;
  readonly tenantCustomThemeGrants: readonly ConsoleCustomThemeGrantDto[];
  readonly staffAccess: ConsoleStaffAccessDto;
  readonly tenantSeats: ConsoleTenantSeatsDto | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function formatConsolePackageDto(
  pkg: CustomThemePackageRecord,
): ConsoleCustomThemePackageDto {
  return {
    id: pkg.id,
    serviceKind: pkg.serviceKind,
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    inclusions: pkg.inclusions,
    startingPriceIdr: pkg.startingPriceIdr,
    priceLabel: pkg.priceLabel,
    estimatedDuration: pkg.estimatedDuration,
    sortOrder: pkg.sortOrder,
    active: pkg.active,
    version: pkg.version,
    createdAt: pkg.createdAtIso,
    updatedAt: pkg.updatedAtIso,
  };
}

export function formatConsoleRequestDto(
  req: CustomThemeRequestRecord,
  grants: readonly TenantCustomThemeGrantSummary[] = [],
  seats: TenantServiceSeatUsage | null = null,
): ConsoleCustomThemeRequestDto {
  return {
    id: req.id,
    requestCode: req.requestCode,
    serviceKind: req.serviceKind,
    serviceKindLabel: SERVICE_KIND_LABELS_ID[req.serviceKind],
    tenantId: req.tenantId,
    tenantHandle: req.tenantHandle,
    packageId: req.packageId,
    packageName: req.packageName,
    requestedByUserId: req.requestedByUserId,
    status: req.status,
    statusLabel: CUSTOM_THEME_STATUS_LABELS_ID[req.status],
    allowedNextStatuses: CUSTOM_THEME_ALLOWED_TRANSITIONS[req.status],
    brandName: req.brandName,
    brief: req.brief,
    referenceUrls: req.referenceUrls,
    budgetRange: req.budgetRange,
    contactPreference: req.contactPreference,
    deliveredThemeId: req.deliveredThemeId,
    deliveredThemeGrantId: req.deliveredThemeGrantId,
    statusReason: req.statusReason,
    operatorNotes: req.operatorNotes,
    tenantCustomThemeGrants: grants.map((g) => ({
      grantId: g.grantId,
      themeId: g.themeId,
      slug: g.slug,
      name: g.name,
      grantedAt: g.grantedAtIso,
    })),
    staffAccess: {
      state: req.staffAccessState,
      stateLabel: STAFF_ACCESS_STATE_LABELS_ID[req.staffAccessState],
      staffUserId: req.staffUserId,
      staffEmail: req.staffEmail,
      staffName: req.staffName,
      staffMemberId: req.staffMemberId,
      approvedByUserId: req.staffApprovedByUserId,
      approvedAt: req.staffApprovedAtIso,
      joinedAt: req.staffJoinedAtIso,
      revokedAt: req.staffRevokedAtIso,
      waitReason: req.staffWaitReason,
    },
    tenantSeats: seats
      ? {
          activeMembersCount: seats.activeMembersCount,
          pendingInvitationsCount: seats.pendingInvitationsCount,
          seatsUsed: seats.seatsUsed,
          seatsLimit: seats.seatsLimit,
          seatsRemaining: seats.seatsRemaining,
        }
      : null,
    version: req.version,
    createdAt: req.createdAtIso,
    updatedAt: req.updatedAtIso,
  };
}

export function resolveConsoleCustomThemesRuntimeEnv(
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

export function mapConsoleCustomThemeErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof CustomThemeValidationError) {
    return consoleErrorResponse(422, err.code, err.message, requestId, {
      reasonCode: err.code,
      fields: err.fields,
    });
  }
  if (err instanceof CustomThemeRepositoryError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.code,
    });
  }
  return mapPlatformErrorToResponse(err, requestId);
}
