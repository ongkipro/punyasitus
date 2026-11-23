import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { validateUpdatePromoCouponInput } from "@punyasitus/core/billing/coupons";
import { getPromoCouponById, updatePromoCoupon } from "@punyasitus/db/billing/coupons/index";
import type { APIRoute } from "astro";
import {
  formatPromoCouponDto,
  mapConsoleCouponErrorToResponse,
  resolveConsoleCouponsRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/coupons/:couponId` — Inspect & audited optimistic-locked mutation of a coupon
 * (REQ-082, REQ-051, PLAN §13 & §19.3, TASK-082).
 *
 * Enforces:
 * - Strictly `console` host + active 2FA platform operator + 10m step-up on PATCH + CSRF/Origin.
 * - Mandatory `expectedVersion` (`409 STALE_VERSION` on mismatch).
 * - Never reduces `maxRedemptions` below `redeemedCount` (`422 INVALID_MAX_REDEMPTIONS_CAP`).
 * - Atomic `platform_audit` insert inside single `batch()` (`WHERE changes() = 1`).
 * - ZERO runtime DDL.
 */

const UPDATE_COUPON_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "discountKind",
  "discountValue",
  "eligiblePlans",
  "eligiblePayerTypes",
  "maxRedemptions",
  "startsAt",
  "endsAt",
  "active",
  "notes",
  "reason",
]);

export async function handleConsoleCouponDetailRequest(
  couponId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();
  const cleanCouponId = couponId.trim();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.coupons.read", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanCouponId) {
      return consoleErrorResponse(404, "NOT_FOUND", "Kupon promo tidak ditemukan.", authz.ctx.requestId);
    }

    try {
      const coupon = await getPromoCouponById(authz.ctx.platformDb, cleanCouponId);
      if (!coupon) {
        return consoleErrorResponse(
          404,
          "NOT_FOUND",
          "Kupon promo tidak ditemukan.",
          authz.ctx.requestId,
        );
      }
      return consoleJsonResponse(200, {
        success: true,
        coupon: formatPromoCouponDto(coupon),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCouponErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.coupons.update", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanCouponId) {
      return consoleErrorResponse(404, "NOT_FOUND", "Kupon promo tidak ditemukan.", authz.ctx.requestId);
    }

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      UPDATE_COUPON_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const validated = validateUpdatePromoCouponInput(parsed.body);
      const result = await updatePromoCoupon(authz.ctx.platformDb, {
        couponId: cleanCouponId,
        input: validated,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(200, {
        success: true,
        coupon: formatPromoCouponDto(result.coupon),
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCouponErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.coupons.detail_method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk detail kupon promo console. Gunakan GET atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PATCH" },
  );
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleCouponDetailRequest(
    params.couponId ?? "",
    request,
    resolveConsoleCouponsRuntimeEnv(env as unknown as Record<string, unknown>),
  );
