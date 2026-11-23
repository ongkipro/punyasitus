import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { isBuiltinPluginId } from "@punyasitus/core/plugins/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { dispatchPluginAdminApi } from "../../../../../../core/plugin-runtime.ts";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  mapPluginDomainErrorToResponse,
  pluginErrorResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "../_shared.ts";

/**
 * Slot 3 Plugin-Scoped Admin JSON API Dispatcher (`TASK-097`, `REQ-097`):
 * `ALL /api/tenants/:tenantId/plugins/:pluginId/:subpath`
 *
 * Centrally enforces host isolation, auth, CSRF/Origin, RBAC (`content:read` for GET,
 * `settings:write` for mutations), live lifecycle state, and `PLATFORM_DB` plugin
 * entitlement BEFORE passing a namespace-locked `PluginTenantDb` (`plg_<id>__*`)
 * to the plugin's `adminSlots.apiHandler`.
 */

export async function handleTenantPluginSubpathApiRequest(
  tenantId: string,
  pluginId: string,
  subpath: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createPluginRequestId();
  const method = request.method.toUpperCase();
  const requiredPermission =
    method === "GET" || method === "HEAD" || method === "OPTIONS"
      ? "content:read"
      : "settings:write";

  const auth = await authorizeTenantPluginRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const cleanPluginId = pluginId.trim().toLowerCase();
  if (!cleanPluginId || isBuiltinPluginId(cleanPluginId)) {
    return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
  }

  const normalizedSubPath = subpath.startsWith("/") ? subpath : `/${subpath}`;

  try {
    const response = await dispatchPluginAdminApi(auth.ctx.runtimeDeps, {
      tenant: auth.ctx.tenant,
      pluginId: cleanPluginId,
      subPath: normalizedSubPath,
      request,
      actorUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
    });

    // Ensure private no-store headers on all admin plugin responses
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    return mapPluginDomainErrorToResponse(err, requestId);
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
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPluginSubpathApiRequest(
    params.tenantId ?? "",
    params.pluginId ?? "",
    params.subpath ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    },
  );
