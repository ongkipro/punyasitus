import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { getTenantBillingOverviewData } from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBillingRequest,
  billingErrorResponse,
  billingJsonResponse,
  createRequestId,
  formatAttemptInstruction,
  formatObligationSummary,
  mapBillingDomainErrorToResponse,
  resolveAutoLarisClient,
  type TenantBillingHandlerOptions,
  type TenantBillingRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant Owner-Only Billing Overview endpoint:
 * - `GET /api/tenants/:tenantId/billing`
 *
 * Returns current subscription status, lifecycle deadlines, server-owned monthly/yearly pricing plans,
 * supported runtime QRIS/VA channels (when AutoLaris relay is configured), active obligation & attempt,
 * obligations history, and mandatory non-PKP + no-refund disclosures (REQ-056, PLAN §16 & §17).
 */

export async function handleTenantBillingOverviewRequest(
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
      "Metode HTTP tidak diizinkan untuk endpoint ringkasan tagihan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const overview = await getTenantBillingOverviewData(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      auth.ctx.member.tenantStatus,
    );

    let channels: {
      readonly code: string;
      readonly label: string;
      readonly kind: "QRIS" | "VA";
      readonly estimatedFeeIdr: number;
      readonly enabled: boolean;
    }[] = [];

    try {
      const autolaris = resolveAutoLarisClient(runtimeEnv, options);
      const liveChannels = await autolaris.listPaymentChannels(overview.pricing.monthlyPriceIdr);
      channels = liveChannels.map((ch) => ({
        code: ch.code,
        label: ch.label,
        kind: ch.kind,
        estimatedFeeIdr: ch.estimatedFeeIdr,
        enabled: ch.enabled,
      }));
    } catch {
      // Overview still renders status, plans, active obligations, and disclosures if provider list is offline
      channels = [];
    }

    return billingJsonResponse(200, {
      tenantStatus: overview.tenantStatus,
      trialEndsAt: overview.deadlines.trialEndsAtIso,
      paidThrough: overview.deadlines.paidThroughIso,
      graceEndsAt: overview.deadlines.graceEndsAtIso,
      lockedEndsAt: overview.deadlines.lockedEndsAtIso,
      deletionDueAt: overview.deadlines.deletionDueAtIso,
      activeObligation: overview.activeObligation
        ? formatObligationSummary(overview.activeObligation)
        : null,
      activeAttempt: overview.activeAttempt
        ? formatAttemptInstruction(overview.activeAttempt)
        : null,
      obligations: overview.obligations.map(formatObligationSummary),
      pricingPlans: [
        {
          plan: "monthly",
          months: 1,
          baseAmountIdr: overview.pricing.monthlyPriceIdr,
          currency: overview.pricing.currency,
          savingsIdr: 0,
        },
        {
          plan: "yearly",
          months: 12,
          baseAmountIdr: overview.pricing.yearlyPriceIdr,
          currency: overview.pricing.currency,
          savingsIdr: overview.pricing.yearlySavingsIdr,
        },
      ],
      channels,
      taxNotice: overview.taxNotice,
      noRefundNotice: overview.noRefundNotice,
    });
  } catch (err) {
    return mapBillingDomainErrorToResponse(err, requestId);
  }
}

export function buildBillingRuntimeEnv(): TenantBillingRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly AUTOLARIS_RELAY_URL?: string;
    readonly AUTOLARIS_API_KEY?: string;
    readonly AUTOLARIS_ACCOUNT_ID?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    AUTOLARIS_RELAY_URL: runtimeEnv.AUTOLARIS_RELAY_URL,
    AUTOLARIS_API_KEY: runtimeEnv.AUTOLARIS_API_KEY,
    AUTOLARIS_ACCOUNT_ID: runtimeEnv.AUTOLARIS_ACCOUNT_ID,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBillingOverviewRequest(params.tenantId ?? "", request, buildBillingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
