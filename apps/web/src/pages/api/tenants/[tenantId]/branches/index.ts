import { env } from "cloudflare:workers";
import { BRANCH_CREATE_ALLOWED_KEYS } from "@punyasitus/core/branches/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  bumpTenantCacheVersionForBranches,
  createBranch,
  listBranchesForAdmin,
} from "@punyasitus/db/branches/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  authorizeTenantBranchesRequest,
  branchesErrorResponse,
  branchesJsonResponse,
  createBranchRequestId,
  mapBranchesDomainErrorToResponse,
  parseStrictBranchesJsonBody,
  type TenantBranchesHandlerOptions,
  type TenantBranchesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Multi-Branch Locations Collection API (REQ-088; TASK-088):
 * - `GET  /api/tenants/:tenantId/branches` (`content:read` — Owner, Admin, Agency Admin, Editor; locked = read-only 200)
 * - `POST /api/tenants/:tenantId/branches` (`outlet:manage` — Owner, Admin, Agency Admin only; Editor -> 403; max 10 -> 422)
 */

export async function handleTenantBranchesCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBranchesRuntimeEnv,
  options: TenantBranchesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBranchRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantBranchesRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return branchesErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint daftar cabang.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "outlet:manage";
  const auth = await authorizeTenantBranchesRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const list = await listBranchesForAdmin(tenantDb);
      return branchesJsonResponse(200, list);
    }

    const parsedBody = await parseStrictBranchesJsonBody(
      request,
      BRANCH_CREATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const created = await createBranch(tenantDb, parsedBody.body, {
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    const cacheSync = await bumpTenantCacheVersionForBranches(
      platformDb,
      member.tenantId,
      options.nowMs,
    );
    return branchesJsonResponse(201, {
      ...created,
      cacheVersionSynced: cacheSync.synced,
    });
  } catch (err) {
    return mapBranchesDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantBranchesRuntimeEnv {
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
  handleTenantBranchesCollectionRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
