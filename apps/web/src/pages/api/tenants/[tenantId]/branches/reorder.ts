import { env } from "cloudflare:workers";
import { BRANCH_REORDER_ALLOWED_KEYS } from "@punyasitus/core/branches/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  bumpTenantCacheVersionForBranches,
  reorderBranches,
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
 * Tenant-scoped Branch Reorder API (REQ-088; TASK-088):
 * - `POST /api/tenants/:tenantId/branches/reorder` (`outlet:manage` — Owner, Admin, Agency Admin only)
 */

export async function handleTenantBranchesReorderRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBranchesRuntimeEnv,
  options: TenantBranchesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBranchRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantBranchesRequest(
      tenantId,
      request,
      runtimeEnv,
      "outlet:manage",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return branchesErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint pengurutan cabang.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantBranchesRequest(
    tenantId,
    request,
    runtimeEnv,
    "outlet:manage",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const parsedBody = await parseStrictBranchesJsonBody(
      request,
      BRANCH_REORDER_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const updatedList = await reorderBranches(tenantDb, parsedBody.body, {
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });
    const cacheSync = await bumpTenantCacheVersionForBranches(
      platformDb,
      member.tenantId,
      options.nowMs,
    );
    return branchesJsonResponse(200, {
      ...updatedList,
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
  handleTenantBranchesReorderRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
