import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  bumpTenantCacheVersionForOutlets,
  deleteOutlet,
  getOutletById,
  OUTLET_UPDATE_ALLOWED_KEYS,
  updateOutlet,
} from "@punyasitus/db/outlets/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantOutletsRequest,
  createOutletRequestId,
  mapOutletsDomainErrorToResponse,
  outletsErrorResponse,
  outletsJsonResponse,
  parseOutletIdParam,
  parseStrictOutletsJsonBody,
  type TenantOutletsHandlerOptions,
  type TenantOutletsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Single Outlet API (REQ-029; TASK-019):
 * - `GET    /api/tenants/:tenantId/outlets/:outletId` (`content:read`)
 * - `PATCH  /api/tenants/:tenantId/outlets/:outletId` (`outlet:manage`; mandatory `expectedVersion` -> 409)
 * - `PUT    /api/tenants/:tenantId/outlets/:outletId` (`outlet:manage`; mandatory `expectedVersion` -> 409)
 * - `DELETE /api/tenants/:tenantId/outlets/:outletId` (`outlet:manage`; optional `expectedVersion` -> 409)
 */

const DELETE_ALLOWED_KEYS: ReadonlySet<string> = new Set(["expectedVersion", "version"]);

function parseOptionalVersionFromDelete(
  request: Request,
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion?: number }
  | { readonly ok: false; readonly response: Response } {
  const url = new URL(request.url);
  const queryVersion = url.searchParams.get("expectedVersion") ?? url.searchParams.get("version");
  let raw: unknown = body.expectedVersion !== undefined ? body.expectedVersion : body.version;

  if (
    body.expectedVersion !== undefined &&
    body.version !== undefined &&
    body.expectedVersion !== body.version
  ) {
    return {
      ok: false,
      response: outletsErrorResponse(
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
        response: outletsErrorResponse(
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

  if (raw === undefined) return { ok: true, expectedVersion: undefined };
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: outletsErrorResponse(
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

export async function handleTenantOutletItemRequest(
  tenantId: string,
  rawOutletId: string,
  request: Request,
  runtimeEnv: TenantOutletsRuntimeEnv,
  options: TenantOutletsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createOutletRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "PUT" && method !== "DELETE") {
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
      "Metode HTTP tidak diizinkan untuk endpoint detail gerai.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, PUT, DELETE" },
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

  const outletId = parseOutletIdParam(rawOutletId);
  if (outletId === null) {
    return outletsErrorResponse(404, "NOT_FOUND", "Gerai tidak ditemukan.", requestId);
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const outlet = await getOutletById(tenantDb, outletId);
      if (!outlet) {
        return outletsErrorResponse(404, "NOT_FOUND", `Gerai #${outletId} tidak ditemukan.`, requestId);
      }
      return outletsJsonResponse(200, outlet);
    }

    if (method === "PATCH" || method === "PUT") {
      const parsedBody = await parseStrictOutletsJsonBody(
        request,
        OUTLET_UPDATE_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) return parsedBody.response;

      if (
        parsedBody.body.expectedVersion === undefined &&
        parsedBody.body.version === undefined
      ) {
        return outletsErrorResponse(
          422,
          "VALIDATION_ERROR",
          "expectedVersion wajib disertakan saat memperbarui gerai.",
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

      const updated = await updateOutlet(tenantDb, outletId, parsedBody.body, {
        actorUserId: member.userId,
        actorRole: member.role,
        nowMs: options.nowMs,
      });
      const cacheSync = await bumpTenantCacheVersionForOutlets(
        platformDb,
        member.tenantId,
        options.nowMs,
      );
      return outletsJsonResponse(200, {
        ...updated,
        cacheVersionSynced: cacheSync.synced,
      });
    }

    // DELETE
    const parsedBody = await parseStrictOutletsJsonBody(
      request,
      DELETE_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = parseOptionalVersionFromDelete(request, parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const deleted = await deleteOutlet(tenantDb, outletId, {
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });
    const cacheSync = await bumpTenantCacheVersionForOutlets(
      platformDb,
      member.tenantId,
      options.nowMs,
    );
    return outletsJsonResponse(200, {
      ...deleted,
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
  handleTenantOutletItemRequest(
    params.tenantId ?? "",
    params.outletId ?? "",
    request,
    buildRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      authenticatedSessionId: locals.authSession?.id ?? null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
