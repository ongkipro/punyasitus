import { env } from "cloudflare:workers";
import { canPerform } from "@punyasitus/auth";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  installOrEnablePluginForTenant,
  listTenantPluginsForAdmin,
} from "../../../../../core/plugin-runtime.ts";
import {
  authorizeTenantPluginRequest,
  createPluginRequestId,
  mapPluginDomainErrorToResponse,
  parseStrictPluginJsonBody,
  pluginErrorResponse,
  pluginJsonResponse,
  type TenantPluginHandlerOptions,
  type TenantPluginRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Plugin Catalog & Install Endpoint (`TASK-097`, `REQ-097`):
 * - `GET  /api/tenants/:tenantId/plugins`: Lists available & installed plugins
 *   (strictly excluding `builtin:*` internal features).
 * - `POST /api/tenants/:tenantId/plugins`: Installs or enables a plugin
 *   (runs `plg_<id>__*` migrations with PITR bookmark; Owner/Admin only; Editor -> 403;
 *   `locked` -> `403 SUBSCRIPTION_LOCKED`).
 */

const INSTALL_ALLOWED_KEYS = new Set(["pluginId", "config"]);

export async function handleTenantPluginsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  options: TenantPluginHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createPluginRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantPluginRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return pluginErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan.",
      requestId,
      { Allow: "GET, POST" },
    );
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

  const { member, tenant, runtimeDeps } = auth.ctx;

  try {
    if (method === "GET") {
      const items = await listTenantPluginsForAdmin(runtimeDeps, tenant);
      const isLocked = tenant.status === "locked";
      const canManagePlugins = canPerform(member.role, "settings:write") && !isLocked;
      return pluginJsonResponse(200, {
        items,
        permissions: {
          role: member.role,
          canManagePlugins,
          isLocked,
        },
        requestId,
      });
    }

    const parsedBody = await parseStrictPluginJsonBody(request, requestId, INSTALL_ALLOWED_KEYS);
    if (!parsedBody.ok) return parsedBody.response;

    const pluginId =
      typeof parsedBody.body.pluginId === "string" ? parsedBody.body.pluginId.trim() : "";
    if (!pluginId) {
      return pluginErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field pluginId wajib diisi.",
        requestId,
      );
    }

    let initialConfig: Record<string, unknown> | undefined;
    if (parsedBody.body.config !== undefined) {
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
      initialConfig = parsedBody.body.config as Record<string, unknown>;
    }

    const result = await installOrEnablePluginForTenant(runtimeDeps, {
      tenant,
      pluginId,
      actorUserId: member.userId,
      actorRole: member.role,
      initialConfig,
    });

    return pluginJsonResponse(200, {
      plugin: result.plugin,
      migration: result.migrationResult
        ? {
            outcome: result.migrationResult.outcome,
            bookmarkId: result.migrationResult.bookmarkId,
            schemaVersion: result.migrationResult.schemaVersion,
            applied: result.migrationResult.applied,
          }
        : null,
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
  handleTenantPluginsCollectionRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
