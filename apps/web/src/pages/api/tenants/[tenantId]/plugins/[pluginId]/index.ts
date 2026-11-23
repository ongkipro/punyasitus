import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { isBuiltinPluginId, validatePluginConfigLimits } from "@punyasitus/core/plugins/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { DEFAULT_PLUGIN_REGISTRY } from "../../../../../../core/plugin-registry.ts";
import {
  disablePluginForTenant,
  installOrEnablePluginForTenant,
  listTenantPluginsForAdmin,
  resolveActivePluginForTenant,
  updatePluginConfigForTenant,
} from "../../../../../../core/plugin-runtime.ts";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  mapPluginDomainErrorToResponse,
  parseStrictPluginJsonBody,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "../_shared.ts";

/**
 * Single Plugin Status, Toggle & Configuration Endpoint (`TASK-097`, `REQ-097`):
 * - `GET   /api/tenants/:tenantId/plugins/:pluginId`
 * - `PATCH /api/tenants/:tenantId/plugins/:pluginId` (`{ enabled?: boolean, config?: Record<string, unknown> }`)
 */

const PATCH_ALLOWED_KEYS = new Set(["enabled", "config"]);

export async function handleTenantPluginDetailRequest(
  tenantId: string,
  pluginId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantPluginRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return pluginErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, {
      Allow: "GET, PATCH",
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

  const cleanPluginId = pluginId.trim().toLowerCase();
  if (!cleanPluginId || isBuiltinPluginId(cleanPluginId)) {
    return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
  }

  const { member, tenant, runtimeDeps } = auth.ctx;
  const registry = runtimeDeps.registry ?? DEFAULT_PLUGIN_REGISTRY;
  const registered = registry.get(cleanPluginId);
  if (!registered) {
    return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
  }

  try {
    if (method === "GET") {
      const resolvedActive = await resolveActivePluginForTenant(
        runtimeDeps,
        tenant,
        cleanPluginId,
      );

      if (!resolvedActive.active && resolvedActive.reason === "unentitled") {
        if (registered.manifest.visibility === "private_client") {
          return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
        }
        return pluginErrorResponse(
          403,
          "FORBIDDEN",
          "Situs belum memiliki hak akses aktif untuk plugin ini.",
          requestId,
        );
      }

      const items = await listTenantPluginsForAdmin(runtimeDeps, tenant);
      const item = items.find((p) => p.id === cleanPluginId);
      if (!item) {
        return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
      }

      let adminState: Record<string, unknown> | null = null;
      if (resolvedActive.active && registered.adminSlots?.loadState) {
        adminState = await registered.adminSlots.loadState({
          tenant,
          actorUserId: member.userId,
          actorRole: member.role,
          config: resolvedActive.installed.config,
          db: resolvedActive.scopedDb,
        });
      }

      return pluginJsonResponse(200, {
        plugin: item,
        adminState,
        requestId,
      });
    }

    const parsedBody = await parseStrictPluginJsonBody(request, requestId, PATCH_ALLOWED_KEYS);
    if (!parsedBody.ok) return parsedBody.response;

    const hasEnabled = Object.prototype.hasOwnProperty.call(parsedBody.body, "enabled");
    const hasConfig = Object.prototype.hasOwnProperty.call(parsedBody.body, "config");

    if (!hasEnabled && !hasConfig) {
      return pluginErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Minimal satu field (enabled atau config) harus disertakan.",
        requestId,
      );
    }

    // Validate ALL inputs (enabled type + config limits + configSchema) BEFORE any state mutation
    // so an invalid `config` NEVER leaves a half-applied `enabled` change!
    if (hasEnabled && typeof parsedBody.body.enabled !== "boolean") {
      return pluginErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field enabled harus berupa boolean.",
        requestId,
      );
    }

    let validatedConfig: Record<string, unknown> | null = null;
    if (hasConfig) {
      if (
        !parsedBody.body.config ||
        typeof parsedBody.body.config !== "object" ||
        Array.isArray(parsedBody.body.config)
      ) {
        return pluginErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Field config harus berupa objek JSON.",
          requestId,
        );
      }
      const candidate = parsedBody.body.config as Record<string, unknown>;
      const limitsCheck = validatePluginConfigLimits(candidate);
      if (!limitsCheck.ok) {
        return pluginErrorResponse(
          422,
          "VALIDATION_ERROR",
          limitsCheck.reason ?? "Konfigurasi plugin melebihi batas yang diizinkan.",
          requestId,
        );
      }
      if (registered.adminSlots?.configSchema) {
        const parsedCfg = registered.adminSlots.configSchema.safeParse(candidate);
        if (!parsedCfg.success) {
          return pluginErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Konfigurasi plugin tidak valid.",
            requestId,
          );
        }
        validatedConfig = parsedCfg.data;
      } else {
        validatedConfig = candidate;
      }
    }

    let updatedPlugin = null;

    if (hasEnabled) {
      if (parsedBody.body.enabled === true) {
        const res = await installOrEnablePluginForTenant(runtimeDeps, {
          tenant,
          pluginId: cleanPluginId,
          actorUserId: member.userId,
          actorRole: member.role,
        });
        updatedPlugin = res.plugin;
      } else {
        updatedPlugin = await disablePluginForTenant(runtimeDeps, {
          tenant,
          pluginId: cleanPluginId,
          actorUserId: member.userId,
          actorRole: member.role,
        });
      }
    }

    if (validatedConfig !== null) {
      updatedPlugin = await updatePluginConfigForTenant(runtimeDeps, {
        tenant,
        pluginId: cleanPluginId,
        actorUserId: member.userId,
        actorRole: member.role,
        config: validatedConfig,
      });
    }

    return pluginJsonResponse(200, {
      plugin: updatedPlugin,
      requestId,
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
  handleTenantPluginDetailRequest(
    params.tenantId ?? "",
    params.pluginId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    },
  );
