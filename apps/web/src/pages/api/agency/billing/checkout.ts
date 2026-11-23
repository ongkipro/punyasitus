import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  parseStrictAgencyJsonBody,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import {
  BillingProviderError,
  BillingValidationError,
  classifyAllowedChannel,
  computeBillingRequestHash,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import { UuidSchema } from "@punyasitus/core/schemas";
import {
  beginAgencyClientBillingCheckout,
  computeAgencyClientCheckoutAmounts,
  getAgencyClientBySelector,
} from "@punyasitus/db/agencies/index";
import {
  completePaymentAttemptPending,
  loadPlatformBillingPricing,
  markPaymentAttemptDefiniteFailure,
  markPaymentAttemptReview,
  markPaymentAttemptUncertain,
} from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import type { AutoLarisBillingClient } from "../../../../../../../packages/integrations/src/autolaris/index.ts";
import {
  mapAgencyErrorToResponse,
  resolveAgencyAutoLarisClient,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../_shared.ts";

/**
 * `POST /api/agency/billing/checkout` — Server-priced agency-payer checkout for a linked
 * client website (`billing_payer = 'agency'`) applying the agency's authoritative discount
 * percentage and creating durable AutoLaris QRIS / Bank VA payment instructions.
 *
 * Security invariants:
 * - Mandatory TOTP 2FA + CSRF/Origin verification.
 * - Cross-agency or non-existent client tenant -> neutral `404 NOT_FOUND`.
 * - Rejects ALL client-supplied price/amount/discount/paid/status fields (`422 FORBIDDEN_BILLING_FIELD`).
 * - NEVER marks paid on checkout; authoritative settlement occurs strictly via server AutoLaris Advice.
 */

const CHECKOUT_ALLOWED_KEYS = new Set([
  "agencyId",
  "tenantId",
  "plan",
  "channelCode",
  "channelKind",
  "idempotencyKey",
]);

export interface AgencyBillingCheckoutOptions extends AgencyHandlerOptions {
  readonly autolarisClient?: AutoLarisBillingClient | null;
  readonly autolarisFetch?: typeof fetch;
}

export async function handleAgencyBillingCheckoutRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyBillingCheckoutOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.billing.checkout",
      requestedAgencyId: queryAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:write",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "POST") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk membuat instruksi pembayaran agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const parsed = await parseStrictAgencyJsonBody(
    request,
    authz.ctx.requestId,
    CHECKOUT_ALLOWED_KEYS,
    { rejectForbiddenBillingFields: true },
  );
  if (!parsed.ok) return parsed.response;

  const bodyAgencyId =
    typeof parsed.body.agencyId === "string" && parsed.body.agencyId.trim().length > 0
      ? parsed.body.agencyId.trim()
      : null;
  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    bodyAgencyId,
    "agency:billing:write",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  const tenantSelector =
    typeof parsed.body.tenantId === "string" ? parsed.body.tenantId.trim() : "";
  if (!tenantSelector) {
    return agencyErrorResponse(
      422,
      "VALIDATION_ERROR",
      "tenantId situs klien wajib diisi.",
      authz.ctx.requestId,
    );
  }

  const rawPlan = typeof parsed.body.plan === "string" ? parsed.body.plan.trim().toLowerCase() : "";
  if (rawPlan !== "monthly" && rawPlan !== "yearly") {
    return agencyErrorResponse(
      422,
      "VALIDATION_ERROR",
      'Paket langganan harus berupa "monthly" atau "yearly".',
      authz.ctx.requestId,
    );
  }
  const plan: BillingPlanInterval = rawPlan;

  const rawChannelCode =
    typeof parsed.body.channelCode === "string" ? parsed.body.channelCode.trim() : "";
  const classified = classifyAllowedChannel(rawChannelCode);
  if (!classified.ok) {
    return agencyErrorResponse(
      422,
      "UNSUPPORTED_CHANNEL",
      classified.reason || "Channel pembayaran harus QRIS atau Virtual Account bank yang didukung.",
      authz.ctx.requestId,
    );
  }

  const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyKey =
    typeof parsed.body.idempotencyKey === "string" ? parsed.body.idempotencyKey.trim() : "";
  const candidateKey = headerKey || bodyKey;
  const validKey = UuidSchema.safeParse(candidateKey);
  if (!validKey.success) {
    return agencyErrorResponse(
      422,
      "INVALID_IDEMPOTENCY_KEY",
      "Header Idempotency-Key berupa UUID yang valid wajib disertakan.",
      authz.ctx.requestId,
    );
  }

  try {
    // 1. Verify strict agency ownership of client tenant (neutral 404 for cross-agency)
    const client = await getAgencyClientBySelector(
      authz.ctx.platformDb,
      targetAgency.id,
      tenantSelector,
      authz.ctx.nowMs,
      runtimeEnv.SAAS_ZONE,
    );
    if (!client) {
      return agencyErrorResponse(404, "NOT_FOUND", "Situs klien tidak ditemukan.", authz.ctx.requestId);
    }

    // 2. Resolve server-side pricing & agency discount + validate AutoLaris channel
    const pricing = await loadPlatformBillingPricing(authz.ctx.platformDb);
    const baseAmountIdr = plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr;
    const previewAmounts = computeAgencyClientCheckoutAmounts({
      baseAmountIdr,
      agencyDiscountPercent: targetAgency.effectiveDiscountPercent,
    });

    const autolaris = resolveAgencyAutoLarisClient(
      runtimeEnv,
      options.autolarisClient,
      options.autolarisFetch,
    );

    const enabledChannels = await autolaris.listPaymentChannels(previewAmounts.netAmountIdr);
    const matchedChannel = enabledChannels.find((ch) => ch.code === classified.normalizedCode);
    if (!matchedChannel) {
      throw new BillingValidationError(
        "CHANNEL_NOT_ENABLED",
        `Channel pembayaran "${classified.normalizedCode}" tidak aktif pada akun AutoLaris saat ini.`,
      );
    }

    const requestHash = await computeBillingRequestHash({
      tenantId: client.tenantId,
      plan,
      channelKind: matchedChannel.kind,
      channelCode: matchedChannel.code,
      couponCode: null,
    });

    // 3. Durable PRE-CALL persistence of agency-payer obligation + attempt (`creating`)
    const begun = await beginAgencyClientBillingCheckout(authz.ctx.platformDb, {
      agencyId: targetAgency.id,
      actorUserId: authz.ctx.actor.userId,
      actorAgencyRole: authz.ctx.actor.agencyRole ?? "agency_billing",
      tenantIdOrHandle: client.tenantId,
      plan,
      channelKind: matchedChannel.kind,
      channelCode: matchedChannel.code,
      idempotencyKey: validKey.data,
      requestHash,
      estimatedChannelFeeIdr: matchedChannel.estimatedFeeIdr,
      providerAccountId: autolaris.providerAccountId,
      nowMs: authz.ctx.nowMs,
    });

    if (begun.result.mode === "replay") {
      return agencyJsonResponse(200, {
        success: true,
        replayed: true,
        payerType: "agency",
        agencyId: targetAgency.id,
        agencyDiscountPercent: begun.amounts.agencyDiscountPercent,
        obligation: {
          obligationId: begun.result.obligation.id,
          tenantId: client.tenantId,
          payerType: begun.result.obligation.payerType,
          payerAgencyId: begun.result.obligation.payerAgencyId,
          plan: begun.result.obligation.plan,
          state: begun.result.obligation.state,
          baseAmountIdr: begun.result.obligation.baseAmountIdr,
          discountAmountIdr: begun.result.obligation.discountAmountIdr,
          netAmountIdr: begun.result.obligation.netAmountIdr,
        },
        attempt: {
          attemptId: begun.result.attempt.id,
          obligationId: begun.result.attempt.obligationId,
          reffId: begun.result.attempt.reffId,
          channelKind: begun.result.attempt.channelKind,
          channelCode: begun.result.attempt.channelCode,
          state: begun.result.attempt.state,
          baseAmountIdr: begun.result.attempt.baseAmountIdr,
          discountAmountIdr: begun.result.attempt.discountAmountIdr,
          channelFeeIdr: begun.result.attempt.channelFeeIdr,
          totalPayableIdr: begun.result.attempt.totalPayableIdr,
          qrisPayload: begun.result.attempt.qrisPayload,
          vaNumber: begun.result.attempt.vaNumber,
          bankName: begun.result.attempt.bankName,
          expiresAt: begun.result.attempt.expiresAtIso,
        },
        requestId: authz.ctx.requestId,
      });
    }

    // 4. Submit order to AutoLaris relay (addressed to agency billing contact!)
    const { obligation, attempt } = begun.result;
    try {
      const providerResult = await autolaris.submitDigitalSubscriptionOrder({
        reffId: attempt.reffId,
        channelKind: matchedChannel.kind,
        channelCode: matchedChannel.code,
        plan: obligation.plan,
        netAmountIdr: obligation.netAmountIdr,
        tenantHandle: client.handle,
        payerName: begun.agency.billingName || begun.agency.name,
        payerEmail: begun.agency.billingEmail || authz.ctx.actor.userEmail,
      });

      const completedAttempt = await completePaymentAttemptPending(authz.ctx.platformDb, {
        attemptId: attempt.id,
        obligationId: obligation.id,
        tenantId: client.tenantId,
        actorUserId: authz.ctx.actor.userId,
        actorRole: "agency_admin",
        requestId: authz.ctx.requestId,
        providerTransactionId: providerResult.providerTransactionId,
        channelFeeIdr: providerResult.channelFeeIdr,
        grossAdminFeeIdr: providerResult.grossAdminFeeIdr,
        providerDiscountIdr: providerResult.providerDiscountIdr,
        totalPayableIdr: providerResult.totalPayableIdr,
        qrisPayload: providerResult.qrisPayload,
        vaNumber: providerResult.vaNumber,
        bankName:
          providerResult.bankName ?? (matchedChannel.kind === "VA" ? matchedChannel.label : null),
        paymentRedirectUrl: providerResult.paymentRedirectUrl,
        expiresAtMs: providerResult.expiresAtMs,
        nowMs: authz.ctx.nowMs,
      });

      return agencyJsonResponse(201, {
        success: true,
        replayed: false,
        payerType: "agency",
        agencyId: targetAgency.id,
        agencyDiscountPercent: begun.amounts.agencyDiscountPercent,
        obligation: {
          obligationId: obligation.id,
          tenantId: client.tenantId,
          payerType: obligation.payerType,
          payerAgencyId: obligation.payerAgencyId,
          plan: obligation.plan,
          state: obligation.state,
          baseAmountIdr: obligation.baseAmountIdr,
          discountAmountIdr: obligation.discountAmountIdr,
          netAmountIdr: obligation.netAmountIdr,
        },
        attempt: {
          attemptId: completedAttempt.id,
          obligationId: completedAttempt.obligationId,
          reffId: completedAttempt.reffId,
          providerTransactionId: providerResult.providerTransactionId,
          channelKind: completedAttempt.channelKind,
          channelCode: completedAttempt.channelCode,
          state: completedAttempt.state,
          baseAmountIdr: completedAttempt.baseAmountIdr,
          discountAmountIdr: completedAttempt.discountAmountIdr,
          channelFeeIdr: completedAttempt.channelFeeIdr,
          totalPayableIdr: completedAttempt.totalPayableIdr,
          qrisPayload: completedAttempt.qrisPayload,
          vaNumber: completedAttempt.vaNumber,
          bankName: completedAttempt.bankName,
          expiresAt: completedAttempt.expiresAtIso,
        },
        requestId: authz.ctx.requestId,
      });
    } catch (providerErr) {
      if (providerErr instanceof BillingProviderError) {
        if (providerErr.kind === "definite_refusal") {
          await markPaymentAttemptDefiniteFailure(authz.ctx.platformDb, {
            attemptId: attempt.id,
            obligationId: obligation.id,
            tenantId: client.tenantId,
            actorUserId: authz.ctx.actor.userId,
            actorRole: "agency_admin",
            requestId: authz.ctx.requestId,
            safeFailureCode: providerErr.safeFailureCode,
            nowMs: authz.ctx.nowMs,
          });
          throw providerErr;
        }
        if (providerErr.kind === "invalid_provider_payload") {
          await markPaymentAttemptReview(authz.ctx.platformDb, {
            attemptId: attempt.id,
            obligationId: obligation.id,
            tenantId: client.tenantId,
            actorUserId: authz.ctx.actor.userId,
            actorRole: "agency_admin",
            requestId: authz.ctx.requestId,
            providerTransactionId: providerErr.providerTransactionId,
            safeFailureCode: providerErr.safeFailureCode,
            nowMs: authz.ctx.nowMs,
          });
          throw providerErr;
        }
      }
      await markPaymentAttemptUncertain(authz.ctx.platformDb, {
        attemptId: attempt.id,
        obligationId: obligation.id,
        tenantId: client.tenantId,
        actorUserId: authz.ctx.actor.userId,
        actorRole: "agency_admin",
        requestId: authz.ctx.requestId,
        safeFailureCode:
          providerErr instanceof BillingProviderError
            ? providerErr.safeFailureCode
            : "PROVIDER_UNAVAILABLE",
        nowMs: authz.ctx.nowMs,
      });
      throw providerErr;
    }
  } catch (err) {
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyBillingCheckoutRequest(
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );
