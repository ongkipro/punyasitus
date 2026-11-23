import { env } from "cloudflare:workers";
import { canPerform } from "@punyasitus/auth";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getTenantPluginStoreSnapshot,
  PluginStoreError,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/tenants/:tenantId/plugins/store`
 * Returns the 4-tab Plugin Store snapshot (`Terpasang`, `Gratis`, `Berbayar`, `Khusus Klien`):
 * - Strictly omits `private_client` plugins unless tenant holds an active direct or active agency grant.
 * - For agency-managed client tenants, sets `billingPayer = "agency"` and hides tenant billing orders/receipts.
 *
 * (REQ-098, ADR-0010, DESIGN §7, TASK-098).
 */

export async function handleTenantPluginStoreListRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  const auth = await authorizeTenantPluginRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return pluginErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, {
      Allow: "GET",
    });
  }

  try {
    const snapshot = await getTenantPluginStoreSnapshot(auth.ctx.runtimeDeps.platformDb, {
      tenantId: auth.ctx.tenant.id,
      nowMs: options.nowMs,
    });
    const isLocked = auth.ctx.tenant.status === "locked";
    const canManagePlugins = canPerform(auth.ctx.member.role, "settings:write") && !isLocked;

    return pluginJsonResponse(200, {
      ...snapshot,
      permissions: {
        role: auth.ctx.member.role,
        canManagePlugins,
        isLocked,
      },
      requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return pluginErrorResponse(err.status, err.code, err.message, requestId);
    }
    return pluginErrorResponse(
      500,
      "SERVICE_UNAVAILABLE",
      "Terjadi kesalahan saat memuat Toko Plugin.",
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
  handleTenantPluginStoreListRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
