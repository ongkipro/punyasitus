import { env } from "cloudflare:workers";
import type { AdviceSettlementPolicy } from "@punyasitus/core/billing/advice";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { createTenantDb, openTenantStoreStub, type TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  PluginStoreError,
  resolveTenantAgencyContext,
  type PluginAddonAdvicePort,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import { processPluginAddonAdviceSettlement } from "../../../../../../../worker/queues/billing/plugin-addons.ts";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "../../_shared.ts";

/**
 * `POST /api/tenants/:tenantId/plugins/orders/:orderId/settle`
 * Reconciles & settles a tenant plugin add-on order strictly via the server-side
 * AutoLaris Advice port (NEVER trusting client POST bodies for payment proof!).
 *
 * - Blocks agency-managed client tenants (`403 AGENCY_PAYER_ONLY`).
 * - Idempotent on duplicate Advice replays.
 * - Issues immutable numbered PDF receipt (`INV-PLG-YYYY-NNNNNN`) and credits affiliate commission (TASK-085).
 *
 * (REQ-098, REQ-081, REQ-085, TASK-098).
 */

export interface TenantPluginSettleHandlerOptions extends TenantPluginHandlerOptions {
  readonly advicePort?: PluginAddonAdvicePort | null;
  readonly policy?: AdviceSettlementPolicy;
}

export async function handleTenantPluginOrderSettleRequest(
  tenantId: string,
  orderId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginSettleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantPluginRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return pluginErrorResponse(405, "BAD_REQUEST", "Gunakan metode POST.", requestId, {
      Allow: "POST",
    });
  }

  const auth = await authorizeTenantPluginRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:write",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const cleanOrderId = orderId.trim();
  if (!cleanOrderId) {
    return pluginErrorResponse(404, "ORDER_NOT_FOUND", "Pesanan tidak ditemukan.", requestId);
  }

  const platformDb = auth.ctx.runtimeDeps.platformDb;
  const tenantCtx = await resolveTenantAgencyContext(platformDb, auth.ctx.tenant.id);
  if (tenantCtx?.owningAgencyId !== null) {
    return pluginErrorResponse(
      403,
      "AGENCY_PAYER_ONLY",
      "Rekonsiliasi pembayaran add-on situs klien hanya dapat dilakukan oleh agensi.",
      requestId,
    );
  }

  if (!options.advicePort) {
    return pluginErrorResponse(
      503,
      "AUTOLARIS_ADVICE_UNAVAILABLE",
      "Layanan verifikasi Advice AutoLaris belum tersedia.",
      requestId,
    );
  }

  try {
    const orderRow = await platformDb
      .prepare(
        `SELECT provider_account_id, payment_attempt_id, provider_reff_id
         FROM plugin_addon_orders
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
      )
      .bind(cleanOrderId, auth.ctx.tenant.id)
      .first<{
        readonly provider_account_id: string;
        readonly payment_attempt_id: string;
        readonly provider_reff_id: string;
      }>();

    if (!orderRow) {
      return pluginErrorResponse(404, "ORDER_NOT_FOUND", "Pesanan add-on plugin tidak ditemukan.", requestId);
    }

    const observation = await options.advicePort.fetchAdvice({
      providerAccountId: orderRow.provider_account_id,
      paymentAttemptId: orderRow.payment_attempt_id,
      providerReffId: orderRow.provider_reff_id,
    });

    const tenantDb = options.resolveTenantDb
      ? options.resolveTenantDb(auth.ctx.tenant.id)
      : options.resolveTenantStub
        ? createTenantDb(options.resolveTenantStub(auth.ctx.tenant.id))
        : runtimeEnv.TENANT_STORE
          ? createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, auth.ctx.tenant.id))
          : null;

    const settled = await processPluginAddonAdviceSettlement({
      db: platformDb,
      orderId: cleanOrderId,
      tenantId: auth.ctx.tenant.id,
      observation,
      policy: options.policy,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      tenantDb,
      requestId,
      nowMs: options.nowMs,
    });

    return pluginJsonResponse(200, {
      settled: settled.settled,
      idempotentReplay: settled.idempotentReplay,
      decisionKind: settled.decisionKind,
      safeReasonCode: settled.safeReasonCode,
      order: settled.order,
      entitlement: settled.entitlement,
      receipt: settled.receipt,
      affiliateCommission: settled.affiliateCommission,
      requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return pluginErrorResponse(err.status, err.code, err.message, requestId);
    }
    return pluginErrorResponse(
      500,
      "SERVICE_UNAVAILABLE",
      "Terjadi kesalahan saat memverifikasi pelunasan add-on plugin.",
      requestId,
    );
  }
}

function buildRuntimeEnv(): TenantPluginRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPluginOrderSettleRequest(
    params.tenantId ?? "",
    params.orderId ?? "",
    request,
    buildRuntimeEnv(),
    { authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null },
  );
