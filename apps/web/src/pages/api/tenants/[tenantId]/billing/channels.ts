import { NON_PKP_TAX_NOTICE } from "@punyasitus/core/billing/index";
import { loadPlatformBillingPricing } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createRequestId,
  mapBillingDomainErrorToResponse,
  resolveAutoLarisClient,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "./_shared.ts";
import { buildBillingRuntimeEnv } from "./index.ts";

/**
 * Tenant Owner-Only Enabled Payment Channels endpoint:
 * - `GET /api/tenants/:tenantId/billing/channels`
 *
 * Reads runtime enabled QRIS & Bank Virtual Account channels from AutoLaris via static-IP relay
 * (excluding COD, retail outlets, and e-wallet redirects; REQ-056, PLAN §16.2).
 */

export async function handleTenantBillingChannelsRequest(
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

  if (method !== "GET") {
    return billingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint daftar channel pembayaran.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const pricing = await loadPlatformBillingPricing(auth.ctx.platformDb);
    const autolaris = resolveAutoLarisClient(runtimeEnv, options);
    const liveChannels = await autolaris.listPaymentChannels(pricing.monthlyPriceIdr);

    return billingJsonResponse(200, {
      channels: liveChannels.map((ch) => ({
        code: ch.code,
        label: ch.label,
        kind: ch.kind,
        estimatedFeeIdr: ch.estimatedFeeIdr,
        enabled: ch.enabled,
      })),
      monthlyBasePriceIdr: pricing.monthlyPriceIdr,
      yearlyBasePriceIdr: pricing.yearlyPriceIdr,
      currency: pricing.currency,
      taxNotice: NON_PKP_TAX_NOTICE,
    });
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingChannelsRequest(params.tenantId ?? "", request, buildBillingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
