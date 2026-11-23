import { env } from "cloudflare:workers";
import type { AdviceSettlementPolicy } from "@punyasitus/core/billing/advice";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getTenantThemeStoreOrderById,
  settleThemeStoreOrderAtomically,
  type ThemeStoreAdvicePort,
} from "@punyasitus/db/themes/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemesRequest,
  createThemesRequestId,
  mapThemesDomainErrorToResponse,
  MAX_THEMES_BODY_BYTES,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "../../_shared.ts";

/**
 * Commercial Theme Store Order Settlement Verification endpoint:
 * - `POST /api/tenants/:tenantId/themes/orders/:orderId/settle`
 *
 * Security Invariants (R3):
 * - NEVER accepts client-supplied payment proof fields (`rc`, `paymentStatus`, `paidAmountIdr`,
 *   `providerTransactionId`, `reffId`, `settledAtMs`, etc.) from the HTTP request body — any
 *   such fields are completely ignored!
 * - Obtains the authoritative AutoLaris Advice observation STRICTLY from the server-side
 *   `ThemeStoreAdvicePort` (`advicePort.fetchAdvice(...)`).
 * - When no live server-side `advicePort` is configured (fail-closed production default),
 *   returns `503 AUTOLARIS_ADVICE_UNCONFIGURED` without granting any entitlement.
 * - Always uses server `nowMs` for settlement & receipt timestamps (never client clock).
 * - Confirmed settlement atomically grants `tenant_theme_entitlements` for THIS website only
 *   and issues an immutable gap-free numbered PDF receipt (`INV-THM-YYYY-NNNNNN`).
 *
 * TASK-096 (`REQ-096`, `REQ-057`, `REQ-081`).
 */

export interface ThemeStoreSettleHandlerOptions extends TenantThemesHandlerOptions {
  readonly advicePort?: ThemeStoreAdvicePort | null;
  readonly settlementPolicy?: AdviceSettlementPolicy;
}

export async function handleTenantThemeOrderSettleRequest(
  tenantId: string,
  orderId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: ThemeStoreSettleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantThemesRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST untuk memverifikasi penyelesaian pembayaran tema.",
      requestId,
      { extraHeaders: { Allow: "POST" } },
    );
  }

  const auth = await authorizeTenantThemesRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const cleanOrderId = orderId.trim();
  if (!cleanOrderId) {
    return themesErrorResponse(404, "THEME_ORDER_NOT_FOUND", "ID pesanan tema tidak valid.", requestId);
  }

  try {
    // Enforce bounded request payload; completely IGNORE any client-supplied payment proof fields.
    const rawBytes = new Uint8Array(await request.arrayBuffer());
    if (rawBytes.byteLength > MAX_THEMES_BODY_BYTES) {
      return themesErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        "Ukuran payload permintaan verifikasi melebihi batas maksimum.",
        requestId,
      );
    }

    const order = await getTenantThemeStoreOrderById(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      cleanOrderId,
    );
    if (!order) {
      return themesErrorResponse(
        404,
        "THEME_ORDER_NOT_FOUND",
        `Pesanan tema "${cleanOrderId}" tidak ditemukan untuk situs ini.`,
        requestId,
      );
    }

    // Fail-closed when server-side AutoLaris Advice port is not configured (unless already settled replay!)
    if (order.status !== "paid" && !options.advicePort) {
      return themesErrorResponse(
        503,
        "AUTOLARIS_ADVICE_UNCONFIGURED",
        "Verifikasi AutoLaris Advice server belum dikonfigurasi. Pembayaran tidak dapat dikonfirmasi secara sepihak oleh klien.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      );
    }

    // Fetch authoritative payment observation strictly from server-side AutoLaris Advice port
    const observation =
      order.status === "paid"
        ? {
            rc: "00",
            ket: null,
            providerTransactionId: order.providerTransactionId,
            reffId: order.providerReffId,
            paymentStatus: null,
            shippingStatus: null,
            paidAmountIdr: order.totalPayableIdr,
            currency: order.currency,
            settledAtMs: null,
          }
        : await options.advicePort!.fetchAdvice({
            providerAccountId: order.providerAccountId,
            providerTransactionId: order.providerTransactionId ?? order.providerReffId,
            providerReffId: order.providerReffId,
          });

    const userRow = await auth.ctx.platformDb
      .prepare("SELECT name, email FROM users WHERE id = ? LIMIT 1")
      .bind(auth.ctx.member.userId)
      .first<{ readonly name: string | null; readonly email: string | null }>();

    const payerName = userRow?.name?.trim() || userRow?.email?.trim() || "Pemilik Situs";

    const result = await settleThemeStoreOrderAtomically(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      tenantHandle: auth.ctx.member.handle,
      tenantName: auth.ctx.member.tenantName,
      payerName,
      orderId: cleanOrderId,
      observation,
      policy: options.settlementPolicy,
      mediaBucket: runtimeEnv.MEDIA_BUCKET ?? null,
      nowMs: options.nowMs,
    });

    return themesJsonResponse(200, {
      settled: result.settled,
      idempotentReplay: result.idempotentReplay,
      decisionKind: result.decisionKind,
      safeReasonCode: result.safeReasonCode,
      order: result.order,
      entitlement: result.entitlement,
      receipt: result.receipt,
    });
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantThemesRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly MEDIA_BUCKET?: R2Bucket;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET ?? null,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantThemeOrderSettleRequest(
    params.tenantId ?? "",
    params.orderId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
