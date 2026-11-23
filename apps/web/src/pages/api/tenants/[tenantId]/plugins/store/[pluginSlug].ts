import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { createTenantDb, openTenantStoreStub, type TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  disableStorePlugin,
  getTenantPluginStoreItemDetail,
  installOrEnableStorePlugin,
  PluginStoreError,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  parseStrictPluginJsonBody,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "../_shared.ts";

/**
 * Single Store Plugin Detail, Install/Enable, and Disable Endpoint:
 * - `GET   /api/tenants/:tenantId/plugins/store/:pluginSlug`: returns `404` on ungranted `private_client`!
 * - `POST  /api/tenants/:tenantId/plugins/store/:pluginSlug`: installs or enables entitled/`public_free` plugin.
 * - `PATCH /api/tenants/:tenantId/plugins/store/:pluginSlug`: `{ enabled: boolean }` — disabling NEVER deletes `plg_*` rows!
 *
 * (REQ-098, ADR-0010, TASK-098).
 */

const PATCH_ALLOWED_KEYS = new Set(["enabled"]);

function resolveOptionalTenantDb(
  tenantId: string,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions,
): D1Database | null {
  if (options.resolveTenantDb) {
    return options.resolveTenantDb(tenantId);
  }
  if (options.resolveTenantStub) {
    return createTenantDb(options.resolveTenantStub(tenantId));
  }
  if (runtimeEnv.TENANT_STORE) {
    return createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, tenantId));
  }
  return null;
}

export async function handleTenantPluginStoreItemRequest(
  tenantId: string,
  pluginSlug: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  if (method !== "GET" && method !== "POST" && method !== "PATCH") {
    const auth = await authorizeTenantPluginRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return pluginErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, {
      Allow: "GET, POST, PATCH",
    });
  }

  const requiredPermission = method === "GET" ? "content:read" : "settings:write";
  const auth = await authorizeTenantPluginRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const cleanSlug = pluginSlug.trim().toLowerCase();
  if (!cleanSlug) {
    return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
  }

  try {
    const platformDb = auth.ctx.runtimeDeps.platformDb;
    const resolvedTenantId = auth.ctx.tenant.id;

    if (method === "GET") {
      const item = await getTenantPluginStoreItemDetail(platformDb, {
        tenantId: resolvedTenantId,
        pluginSlug: cleanSlug,
        nowMs: options.nowMs,
      });
      if (!item) {
        return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
      }
      return pluginJsonResponse(200, { plugin: item, requestId });
    }

    const tenantDb = resolveOptionalTenantDb(resolvedTenantId, runtimeEnv, options);

    if (method === "POST") {
      const entitlement = await installOrEnableStorePlugin(platformDb, {
        tenantId: resolvedTenantId,
        pluginSlug: cleanSlug,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        nowMs: options.nowMs,
        tenantDb,
      });
      const item = await getTenantPluginStoreItemDetail(platformDb, {
        tenantId: resolvedTenantId,
        pluginSlug: cleanSlug,
        nowMs: options.nowMs,
      });
      return pluginJsonResponse(200, { entitlement, plugin: item, requestId });
    }

    const parsed = await parseStrictPluginJsonBody(request, requestId, PATCH_ALLOWED_KEYS);
    if (!parsed.ok) return parsed.response;

    if (typeof parsed.body.enabled !== "boolean") {
      return pluginErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field enabled wajib berupa boolean.",
        requestId,
      );
    }

    const entitlement = parsed.body.enabled
      ? await installOrEnableStorePlugin(platformDb, {
          tenantId: resolvedTenantId,
          pluginSlug: cleanSlug,
          actorUserId: auth.ctx.member.userId,
          actorRole: auth.ctx.member.role,
          nowMs: options.nowMs,
          tenantDb,
        })
      : await disableStorePlugin(platformDb, {
          tenantId: resolvedTenantId,
          pluginSlug: cleanSlug,
          nowMs: options.nowMs,
          tenantDb,
        });

    const item = await getTenantPluginStoreItemDetail(platformDb, {
      tenantId: resolvedTenantId,
      pluginSlug: cleanSlug,
      nowMs: options.nowMs,
    });

    return pluginJsonResponse(200, { entitlement, plugin: item, requestId });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return pluginErrorResponse(err.status, err.code, err.message, requestId);
    }
    return pluginErrorResponse(
      500,
      "SERVICE_UNAVAILABLE",
      "Terjadi kesalahan saat memproses status plugin.",
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
  handleTenantPluginStoreItemRequest(
    params.tenantId ?? "",
    params.pluginSlug ?? "",
    request,
    buildRuntimeEnv(),
    { authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null },
  );
