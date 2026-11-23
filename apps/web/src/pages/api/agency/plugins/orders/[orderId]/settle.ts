import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import type { AdviceSettlementPolicy } from "@punyasitus/core/billing/advice";
import {
  PluginStoreError,
  type PluginAddonAdvicePort,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import { processPluginAddonAdviceSettlement } from "../../../../../../worker/queues/billing/plugin-addons.ts";
import {
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../../../_shared.ts";

/**
 * `POST /api/agency/plugins/orders/:orderId/settle`
 * Settles an agency-billed client plugin add-on order via server-side AutoLaris Advice.
 * Strictly checks `resolveAuthorizedTargetMembership` with `agency:billing:write` and
 * order ownership by the target agency (`404` on foreign agency order).
 *
 * (REQ-098, REQ-083, TASK-098).
 */

export interface AgencyPluginSettleOptions extends AgencyHandlerOptions {
  readonly advicePort?: PluginAddonAdvicePort | null;
  readonly policy?: AdviceSettlementPolicy;
  readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
}

export async function handleAgencyPluginOrderSettleRequest(
  orderId: string,
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyPluginSettleOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.plugins.order.settle",
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
      "Gunakan metode POST.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    queryAgencyId,
    "agency:billing:write",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  const cleanOrderId = orderId.trim();
  if (!cleanOrderId) {
    return agencyErrorResponse(404, "ORDER_NOT_FOUND", "Pesanan tidak ditemukan.", authz.ctx.requestId);
  }

  if (!options.advicePort) {
    return agencyErrorResponse(
      503,
      "AUTOLARIS_ADVICE_UNAVAILABLE",
      "Layanan verifikasi Advice AutoLaris belum tersedia.",
      authz.ctx.requestId,
    );
  }

  try {
    const orderRow = await authz.ctx.platformDb
      .prepare(
        `SELECT tenant_id, provider_account_id, payment_attempt_id, provider_reff_id
         FROM plugin_addon_orders
         WHERE id = ? AND payer_agency_id = ?
         LIMIT 1`,
      )
      .bind(cleanOrderId, targetAgency.id)
      .first<{
        readonly tenant_id: string;
        readonly provider_account_id: string;
        readonly payment_attempt_id: string;
        readonly provider_reff_id: string;
      }>();

    if (!orderRow) {
      return agencyErrorResponse(
        404,
        "ORDER_NOT_FOUND",
        "Pesanan add-on plugin tidak ditemukan pada agensi ini.",
        authz.ctx.requestId,
      );
    }

    const observation = await options.advicePort.fetchAdvice({
      providerAccountId: orderRow.provider_account_id,
      paymentAttemptId: orderRow.payment_attempt_id,
      providerReffId: orderRow.provider_reff_id,
    });

    const settled = await processPluginAddonAdviceSettlement({
      db: authz.ctx.platformDb,
      orderId: cleanOrderId,
      tenantId: orderRow.tenant_id,
      payerAgencyId: targetAgency.id,
      observation,
      policy: options.policy,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      tenantDb: options.resolveTenantDb ? options.resolveTenantDb(orderRow.tenant_id) : null,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return agencyJsonResponse(200, {
      settled: settled.settled,
      idempotentReplay: settled.idempotentReplay,
      decisionKind: settled.decisionKind,
      safeReasonCode: settled.safeReasonCode,
      order: settled.order,
      entitlement: settled.entitlement,
      receipt: settled.receipt,
      affiliateCommission: settled.affiliateCommission,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return agencyErrorResponse(err.status, err.code, err.message, authz.ctx.requestId);
    }
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAgencyPluginOrderSettleRequest(
    params.orderId ?? "",
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
