import {
  BillingValidationError,
  classifyAllowedChannel,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import { parseSingleCouponCodeInput } from "@punyasitus/core/billing/coupons";
import { loadPlatformBillingPricing } from "@punyasitus/db/billing/index";
import { previewCouponForTenantCheckout } from "@punyasitus/db/billing/coupons/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createRequestId,
  mapBillingDomainErrorToResponse,
  parseStrictBillingJsonBody,
  resolveAutoLarisClient,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "../_shared.ts";
import { buildBillingRuntimeEnv } from "../index.ts";

/**
 * Tenant Owner/Payer-Only Promotional Coupon Preview & Validation endpoint:
 * - `POST /api/tenants/:tenantId/billing/coupons/validate`
 *
 * Returns exact integer IDR discount, net base amount (after coupon discount),
 * affiliate commissionable net base, optional estimated AutoLaris channel fee,
 * and final estimated payable total — or explicit 422/409 error codes for
 * expired, exhausted, wrong-plan, inactive, stacked, already-used, or below-floor coupons.
 *
 * ZERO runtime DDL; read-only preview (does not consume redemption quota).
 */

const COUPON_VALIDATE_ALLOWED_KEYS = new Set([
  "plan",
  "couponCode",
  "channelCode",
  "channelKind",
]);

export async function handleTenantBillingCouponValidateRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBillingRuntimeEnv,
  options: TenantBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantBillingRequest(
    tenantId,
    request,
    runtimeEnv,
    "billing:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  if (method !== "POST") {
    return billingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint validasi kupon.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  try {
    const parsedBody = await parseStrictBillingJsonBody(
      request,
      COUPON_VALIDATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const rawPlan = parsedBody.body.plan;
    if (rawPlan !== "monthly" && rawPlan !== "yearly") {
      throw new BillingValidationError(
        "INVALID_PLAN",
        'Paket langganan harus "monthly" atau "yearly".',
        [{ field: "plan", code: "INVALID_PLAN", message: 'Expected "monthly" or "yearly".' }],
      );
    }
    const plan: BillingPlanInterval = rawPlan;

    const normalizedCode = parseSingleCouponCodeInput(parsedBody.body.couponCode, {
      required: true,
    })!;

    let requestedChannelCode: string | null = null;
    if (parsedBody.body.channelCode !== undefined && parsedBody.body.channelCode !== null) {
      if (typeof parsedBody.body.channelCode !== "string" || !parsedBody.body.channelCode.trim()) {
        throw new BillingValidationError(
          "INVALID_CHANNEL_CODE",
          "Kode channel pembayaran tidak valid.",
          [{ field: "channelCode", code: "INVALID_CHANNEL_CODE", message: "Invalid channelCode." }],
        );
      }
      const classified = classifyAllowedChannel(parsedBody.body.channelCode);
      if (!classified.ok) {
        throw new BillingValidationError(classified.code, classified.reason, [
          { field: "channelCode", code: classified.code, message: classified.reason },
        ]);
      }
      requestedChannelCode = classified.normalizedCode;
    }

    const pricing = await loadPlatformBillingPricing(auth.ctx.platformDb);
    const baseAmountIdr = plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr;

    const evaluated = await previewCouponForTenantCheckout(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      plan,
      payerType: auth.ctx.payerType,
      couponCode: normalizedCode,
      baseAmountIdr,
      nowMs: auth.ctx.nowMs,
    });

    if (!evaluated.ok) {
      if (evaluated.status === 409) {
        return billingErrorResponse(
          409,
          "CONFLICT",
          evaluated.message,
          requestId,
          [{ field: "couponCode", code: evaluated.code, message: evaluated.message }],
          undefined,
          evaluated.code,
        );
      }
      return billingErrorResponse(
        422,
        "VALIDATION_ERROR",
        evaluated.message,
        requestId,
        [{ field: "couponCode", code: evaluated.code, message: evaluated.message }],
        undefined,
        evaluated.code,
      );
    }

    let estimatedChannelFeeIdr = 0;
    if (requestedChannelCode) {
      try {
        const autolaris = resolveAutoLarisClient(runtimeEnv, options);
        const channels = await autolaris.listPaymentChannels(evaluated.breakdown.netBaseAmountIdr);
        const matched = channels.find((ch) => ch.code === requestedChannelCode);
        if (matched) {
          estimatedChannelFeeIdr = matched.estimatedFeeIdr;
        }
      } catch {
        // Preview remains responsive with 0 estimated fee if AutoLaris relay is offline
        estimatedChannelFeeIdr = 0;
      }
    }

    const estimatedTotalPayableIdr = evaluated.breakdown.netBaseAmountIdr + estimatedChannelFeeIdr;

    return billingJsonResponse(200, {
      valid: true,
      plan,
      coupon: {
        id: evaluated.coupon.id,
        code: evaluated.coupon.code,
        discountKind: evaluated.coupon.discountKind,
        discountValue: evaluated.coupon.discountValue,
        eligiblePlans: evaluated.coupon.eligiblePlans,
        endsAt: evaluated.coupon.endsAtIso,
      },
      pricing: {
        baseAmountIdr: evaluated.breakdown.baseAmountIdr,
        discountAmountIdr: evaluated.breakdown.discountAmountIdr,
        netBaseAmountIdr: evaluated.breakdown.netBaseAmountIdr,
        affiliateCommissionableBaseIdr: evaluated.breakdown.affiliateCommissionableBaseIdr,
        estimatedChannelFeeIdr,
        estimatedTotalPayableIdr,
        yearlySavingsIdr: pricing.yearlySavingsIdr,
        currency: pricing.currency,
      },
      requestId,
    });
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingCouponValidateRequest(
    params.tenantId ?? "",
    request,
    buildBillingRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
