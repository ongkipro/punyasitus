import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  bumpTenantCacheVersionForOutlets,
  createOutlet,
  listOutletsForAdmin,
  OUTLET_CREATE_ALLOWED_KEYS,
} from "@punyasitus/db/outlets/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOutletsRequest,
  createOutletRequestId,
  mapOutletsDomainErrorToResponse,
  outletsErrorResponse,
  outletsJsonResponse,
  parseStrictOutletsJsonBody,
  type TenantOutletsHandlerOptions,
  type TenantOutletsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Multi-Outlet Directory Collection API (REQ-029; TASK-019):
 * - `GET  /api/tenants/:tenantId/outlets` (`content:read` — Owner, Admin, Agency Admin, Editor; locked = read-only 200)
 * - `POST /api/tenants/:tenantId/outlets` (`outlet:manage` — Owner, Admin, Agency Admin; Editor -> 403; max 10 -> 422)
 */

export async function handleTenantOutletsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantOutletsRuntimeEnv,
  options: TenantOutletsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createOutletRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantOutletsRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return outletsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint daftar gerai.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "outlet:manage";
  const auth = await authorizeTenantOutletsRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const list = await listOutletsForAdmin(tenantDb);
      return outletsJsonResponse(200, list);
    }

    const parsedBody = await parseStrictOutletsJsonBody(
      request,
      OUTLET_CREATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const created = await createOutlet(tenantDb, parsedBody.body, {
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const cacheSync = await bumpTenantCacheVersionForOutlets(
      platformDb,
      member.tenantId,
      options.nowMs,
    );
    return outletsJsonResponse(201, {
      ...created,
      cacheVersionSynced: cacheSync.synced,
    });
  } catch (err) {
    return mapOutletsDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantOutletsRuntimeEnv {
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
  handleTenantOutletsCollectionRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    authenticatedSessionId: locals.authSession?.id ?? null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
