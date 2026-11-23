import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { PLUGIN_FORBIDDEN_PRICE_KEYS } from "@punyasitus/core/plugins/billing";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { createPluginAddonOrder, PluginStoreError } from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  parseStrictPluginJsonBody,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/tenants/:tenantId/plugins/checkout`
 * Creates an idempotent AutoLaris QRIS / Bank VA checkout order for a `public_paid` plugin add-on.
 *
 * Security & Commercial Invariants:
 * - Server-authoritative pricing ONLY: rejects client-supplied price/amount/discount/status fields (`422`).
 * - Agency-managed client tenants are strictly blocked with `403 AGENCY_PAYER_ONLY`!
 * - Owner/Admin only (`settings:write`; Editor -> `403`, Locked -> `403 SUBSCRIPTION_LOCKED`).
 *
 * (REQ-098, REQ-056, REQ-082, REQ-083, TASK-098).
 */

const CHECKOUT_ALLOWED_KEYS = new Set([
  "pluginSlug",
  "channelCode",
  "couponCode",
  "idempotencyKey",
]);

export async function handleTenantPluginCheckoutRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
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
    return pluginErrorResponse(405, "BAD_REQUEST", "Gunakan metode POST untuk checkout plugin.", requestId, {
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

  // Reject client price keys explicitly before generic allowed-key filtering
  const parsed = await parseStrictPluginJsonBody(request, requestId);
  if (!parsed.ok) return parsed.response;

  for (const key of Object.keys(parsed.body)) {
    if (PLUGIN_FORBIDDEN_PRICE_KEYS.has(key)) {
      return pluginErrorResponse(
        422,
        "PLUGIN_CHECKOUT_CLIENT_PRICE_FORBIDDEN",
        `Field harga "${key}" tidak boleh dikirim oleh klien; harga dihitung penuh di server.`,
        requestId,
      );
    }
    if (!CHECKOUT_ALLOWED_KEYS.has(key)) {
      return pluginErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${key}" tidak dikenali pada checkout plugin.`,
        requestId,
      );
    }
  }

  const pluginSlug =
    typeof parsed.body.pluginSlug === "string" ? parsed.body.pluginSlug.trim().toLowerCase() : "";
  if (!pluginSlug) {
    return pluginErrorResponse(422, "VALIDATION_ERROR", "pluginSlug wajib diisi.", requestId);
  }

  const headerIdem = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyIdem =
    typeof parsed.body.idempotencyKey === "string" ? parsed.body.idempotencyKey.trim() : "";
  const idempotencyKey = headerIdem || bodyIdem || crypto.randomUUID();

  try {
    const result = await createPluginAddonOrder(auth.ctx.runtimeDeps.platformDb, {
      tenantId: auth.ctx.tenant.id,
      pluginSlug,
      payerKind: "tenant",
      payerAgencyId: null,
      payerUserId: auth.ctx.member.userId,
      channelCode: typeof parsed.body.channelCode === "string" ? parsed.body.channelCode : "QRIS",
      couponCode: typeof parsed.body.couponCode === "string" ? parsed.body.couponCode : null,
      idempotencyKey,
      requestId,
      nowMs: options.nowMs,
    });

    return pluginJsonResponse(result.idempotentReplay ? 200 : 201, {
      order: result.order,
      plugin: result.item,
      idempotentReplay: result.idempotentReplay,
      requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return pluginErrorResponse(err.status, err.code, err.message, requestId);
    }
    return pluginErrorResponse(
      500,
      "SERVICE_UNAVAILABLE",
      "Terjadi kesalahan saat membuat pesanan add-on plugin.",
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
  handleTenantPluginCheckoutRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
