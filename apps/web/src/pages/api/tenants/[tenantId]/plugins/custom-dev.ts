import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getTenantPluginStoreSnapshot,
  PluginStoreError,
  submitCustomPluginDevRequest,
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
} from "./_shared.ts";

/**
 * `GET / POST /api/tenants/:tenantId/plugins/custom-dev`
 * Tenant `Plugin -> Khusus Klien / Custom Dev` workflow (`service_kind = "custom_plugin"`):
 * - `GET`: Lists tenant's custom plugin requests & daily quota (`used`, `limit: 3`, `remaining`).
 * - `POST`: Owner/Admin submits rate-limited `service_kind = "custom_plugin"` request with
 *   business requirements & validated WhatsApp contact; rejects unknown keys (`422`), enforces
 *   atomic 3/day cap (`429 DAILY_REQUEST_LIMIT_REACHED`), writes `platform_audit`.
 *
 * (REQ-098, ADR-0010, PLAN §19.7, DESIGN §7, TASK-098).
 */

const CUSTOM_DEV_ALLOWED_KEYS = new Set([
  "serviceKind",
  "title",
  "requirementsSummary",
  "contactWhatsapp",
  "budgetRange",
  "idempotencyKey",
]);

export async function handleTenantCustomPluginDevRequest(
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
    return pluginErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, {
      Allow: "GET, POST",
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

  try {
    const platformDb = auth.ctx.runtimeDeps.platformDb;
    if (method === "GET") {
      const snapshot = await getTenantPluginStoreSnapshot(platformDb, {
        tenantId: auth.ctx.tenant.id,
        nowMs: options.nowMs,
      });
      return pluginJsonResponse(200, {
        requests: snapshot.customDevRequests,
        quota: snapshot.customDevQuota,
        requestId,
      });
    }

    const parsed = await parseStrictPluginJsonBody(request, requestId, CUSTOM_DEV_ALLOWED_KEYS);
    if (!parsed.ok) return parsed.response;

    const headerIdem = request.headers.get("idempotency-key")?.trim() || null;
    const bodyIdem =
      typeof parsed.body.idempotencyKey === "string" && parsed.body.idempotencyKey.trim()
        ? parsed.body.idempotencyKey.trim()
        : null;

    const created = await submitCustomPluginDevRequest(platformDb, {
      tenantId: auth.ctx.tenant.id,
      requestedByUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
      rawBody: parsed.body,
      idempotencyKey: headerIdem ?? bodyIdem,
      requestId,
      nowMs: options.nowMs,
    });

    return pluginJsonResponse(created.created ? 201 : 200, {
      request: created.request,
      created: created.created,
      requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return pluginErrorResponse(err.status, err.code, err.message, requestId);
    }
    return pluginErrorResponse(
      500,
      "SERVICE_UNAVAILABLE",
      "Terjadi kesalahan saat memproses permintaan plugin kustom.",
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
  handleTenantCustomPluginDevRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
