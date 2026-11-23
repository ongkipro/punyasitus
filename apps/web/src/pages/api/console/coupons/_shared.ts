import {
  consoleErrorResponse,
  mapPlatformErrorToResponse,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { BillingValidationError } from "@punyasitus/core/billing/index";
import type { PromoCouponRecord } from "@punyasitus/core/billing/coupons";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { CouponRepositoryError } from "@punyasitus/db/billing/coupons/index";

/**
 * Shared DTO formatting, env extraction, and error mapping for
 * `/api/console/coupons/**` (REQ-082, REQ-051, PLAN §13 & §19.3, TASK-082).
 *
 * ZERO runtime DDL in any console coupon handler!
 */

export interface ConsolePromoCouponDto {
  readonly id: string;
  readonly code: string;
  readonly discountKind: "percent" | "fixed_idr";
  readonly discountValue: number;
  readonly eligiblePlans: readonly ("monthly" | "yearly")[];
  readonly eligiblePayerTypes: readonly ("tenant" | "agency")[];
  readonly maxRedemptions: number | null;
  readonly redeemedCount: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly active: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function formatPromoCouponDto(record: PromoCouponRecord): ConsolePromoCouponDto {
  return {
    id: record.id,
    code: record.code,
    discountKind: record.discountKind,
    discountValue: record.discountValue,
    eligiblePlans: record.eligiblePlans,
    eligiblePayerTypes: record.eligiblePayerTypes,
    maxRedemptions: record.maxRedemptions,
    redeemedCount: record.redeemedCount,
    startsAt: record.startsAtIso,
    endsAt: record.endsAtIso,
    startsAtMs: record.startsAtMs,
    endsAtMs: record.endsAtMs,
    active: record.active,
    notes: record.notes,
    version: record.version,
    createdAt: record.createdAtIso,
    updatedAt: record.updatedAtIso,
  };
}

export function resolveConsoleCouponsRuntimeEnv(
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

export function mapConsoleCouponErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof BillingValidationError) {
    return consoleErrorResponse(422, err.reasonCode || err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
      fields: err.fields,
    });
  }
  if (err instanceof CouponRepositoryError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.code,
    });
  }
  return mapPlatformErrorToResponse(err, requestId);
}
