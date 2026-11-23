import { env } from "cloudflare:workers";
import { BRANCH_UPDATE_ALLOWED_KEYS } from "@punyasitus/core/branches/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  bumpTenantCacheVersionForBranches,
  deleteBranch,
  getBranchById,
  updateBranch,
} from "@punyasitus/db/branches/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  authorizeTenantBranchesRequest,
  branchesErrorResponse,
  branchesJsonResponse,
  createBranchRequestId,
  mapBranchesDomainErrorToResponse,
  parseBranchIdParam,
  parseStrictBranchesJsonBody,
  type TenantBranchesHandlerOptions,
  type TenantBranchesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Single Branch API (REQ-088; TASK-088):
 * - `GET    /api/tenants/:tenantId/branches/:branchId` (`content:read` — Owner, Admin, Agency Admin, Editor)
 * - `PATCH  /api/tenants/:tenantId/branches/:branchId` (`outlet:manage` — Owner, Admin, Agency Admin; OCC)
 * - `PUT    /api/tenants/:tenantId/branches/:branchId` (`outlet:manage` — Owner, Admin, Agency Admin; OCC)
 * - `DELETE /api/tenants/:tenantId/branches/:branchId` (`outlet:manage` — Owner, Admin, Agency Admin; optional OCC)
 */

const DELETE_ALLOWED_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "version"]);

function parseOptionalVersionFromDelete(
  request: Request,
  body: Record<string, unknown>,
  requestId: string,
): { readonly ok: true; readonly expectedVersion?: number } | { readonly ok: false; readonly response: Response } {
  const url = new URL(request.url);
  const queryVersion = url.searchParams.get("expectedVersion") ?? url.searchParams.get("version");
  let raw: unknown = body.expectedVersion !== undefined ? body.expectedVersion : body.version;

  if (body.expectedVersion !== undefined && body.version !== undefined && body.expectedVersion !== body.version) {
    return {
      ok: false,
      response: branchesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion dan version harus bernilai sama.",
        requestId,
        [{ field: "expectedVersion", code: "INVALID_VERSION", message: "Conflicting version fields." }],
      ),
    };
  }

  if (raw === undefined && queryVersion !== null && queryVersion.trim() !== "") {
    if (!/^[0-9]{1,10}$/.test(queryVersion.trim())) {
      return {
        ok: false,
        response: branchesErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersion harus berupa bilangan bulat non-negatif.",
          requestId,
          [{ field: "expectedVersion", code: "INVALID_VERSION", message: "Expected non-negative integer." }],
        ),
      };
    }
    raw = Number(queryVersion.trim());
  }

  if (raw === undefined) {
    return { ok: true, expectedVersion: undefined };
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: branchesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion harus berupa bilangan bulat non-negatif.",
        requestId,
        [{ field: "expectedVersion", code: "INVALID_VERSION", message: "Expected non-negative integer." }],
      ),
    };
  }
  return { ok: true, expectedVersion: raw };
}

export async function handleTenantBranchItemRequest(
  tenantId: string,
  rawBranchId: string,
  request: Request,
  runtimeEnv: TenantBranchesRuntimeEnv,
  options: TenantBranchesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBranchRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "PUT" && method !== "DELETE") {
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
      "Metode HTTP tidak diizinkan untuk endpoint detail cabang.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, PUT, DELETE" },
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

  const branchId = parseBranchIdParam(rawBranchId);
  if (branchId === null) {
    return branchesErrorResponse(404, "NOT_FOUND", "Cabang tidak ditemukan.", requestId);
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const branch = await getBranchById(tenantDb, branchId);
      if (!branch) {
        return branchesErrorResponse(404, "NOT_FOUND", `Cabang #${branchId} tidak ditemukan.`, requestId);
      }
      return branchesJsonResponse(200, branch);
    }

    if (method === "PATCH" || method === "PUT") {
      const parsedBody = await parseStrictBranchesJsonBody(
        request,
        BRANCH_UPDATE_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) {
        return parsedBody.response;
      }

      if (
        parsedBody.body.expectedVersion === undefined &&
        parsedBody.body.version === undefined
      ) {
        return branchesErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersion wajib disertakan saat memperbarui cabang.",
          requestId,
          [
            {
              field: "expectedVersion",
              code: "EXPECTED_VERSION_REQUIRED",
              message: "expectedVersion wajib disertakan untuk mencegah penimpaan data.",
            },
          ],
        );
      }

      const updated = await updateBranch(tenantDb, branchId, parsedBody.body, {
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
        ...updated,
        cacheVersionSynced: cacheSync.synced,
      });
    }

    // DELETE
    const parsedBody = await parseStrictBranchesJsonBody(
      request,
      DELETE_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = parseOptionalVersionFromDelete(request, parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const deleted = await deleteBranch(tenantDb, branchId, {
      expectedVersion: versionCheck.expectedVersion,
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
      ...deleted,
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
  handleTenantBranchItemRequest(
    params.tenantId ?? "",
    params.branchId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
