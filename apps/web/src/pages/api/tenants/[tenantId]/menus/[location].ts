import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { assertMenuLocation } from "@punyasitus/core/menu-builder";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  createEmptyTenantMenu,
  deleteTenantMenu,
  getTenantMenuByLocation,
  saveTenantMenu,
} from "@punyasitus/db/menus/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantMenuRequest,
  createRequestId,
  extractExpectedVersion,
  formatMenuRecordResponse,
  mapMenuDomainErrorToResponse,
  menuErrorResponse,
  menuJsonResponse,
  parseStrictMenuJsonBody,
  type TenantMenusHandlerOptions,
  type TenantMenusRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped navigation menu location endpoint:
 * - `GET    /api/tenants/:tenantId/menus/:location` -> read single menu (`header` | `footer` | `mobile`)
 * - `PUT    /api/tenants/:tenantId/menus/:location` -> replace cycle-free 3-level menu with OCC
 * - `DELETE /api/tenants/:tenantId/menus/:location` -> delete/reset menu location with optional OCC
 *
 * Matches OpenAPI `tenantUpsertMenu` contract (`PUT /api/tenants/{tenantId}/menus/{location}`)
 * and TASK-004 (`REQ-006`, `REQ-007`, `REQ-034`).
 */

const UPSERT_LOCATION_ALLOWED_KEYS = new Set([
  "items",
  "version",
  "expectedVersion",
  "publish",
]);

const DELETE_LOCATION_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantMenuLocationRequest(
  tenantId: string,
  rawLocation: string,
  request: Request,
  runtimeEnv: TenantMenusRuntimeEnv,
  options: TenantMenusHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
    const auth = await authorizeTenantMenuRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return menuErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint lokasi menu.",
      requestId,
      undefined,
      { Allow: "GET, PUT, DELETE" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "menu:manage";
  const auth = await authorizeTenantMenuRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const { member, tenantDb } = auth.ctx;

  try {
    const location = assertMenuLocation(rawLocation.trim().toLowerCase(), "location");

    if (method === "GET") {
      const stored = (await getTenantMenuByLocation(tenantDb, location)) ?? createEmptyTenantMenu(location);
      return menuJsonResponse(200, formatMenuRecordResponse(stored));
    }

    if (method === "PUT") {
      const parsedBody = await parseStrictMenuJsonBody(
        request,
        UPSERT_LOCATION_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) {
        return parsedBody.response;
      }

      const body = parsedBody.body;
      const versionCheck = extractExpectedVersion(body, requestId);
      if (!versionCheck.ok) {
        return versionCheck.response;
      }

      if (body.publish !== undefined && typeof body.publish !== "boolean") {
        return menuErrorResponse(
          422,
          "VALIDATION_ERROR",
          "publish must be a boolean.",
          requestId,
          [{ field: "publish", code: "INVALID_MENU_PAYLOAD", message: "Expected a boolean." }],
        );
      }

      const saved = await saveTenantMenu(tenantDb, {
        location,
        items: body.items,
        tenantId: member.tenantId,
        expectedVersion: versionCheck.expectedVersion,
        publish: body.publish,
        nowMs: options.nowMs,
      });

      return menuJsonResponse(200, formatMenuRecordResponse(saved));
    }

    // DELETE /api/tenants/:tenantId/menus/:location
    const parsedBody = await parseStrictMenuJsonBody(
      request,
      DELETE_LOCATION_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    let expectedVersion: number | undefined;
    const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }
    expectedVersion = versionCheck.expectedVersion;

    if (expectedVersion === undefined) {
      const url = new URL(request.url);
      const queryVersion = url.searchParams.get("version") ?? url.searchParams.get("expectedVersion");
      if (queryVersion !== null) {
        if (!/^\d+$/.test(queryVersion)) {
          return menuErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Query version parameter must be a non-negative integer.",
            requestId,
            [{ field: "version", code: "INVALID_MENU_PAYLOAD", message: "Invalid version query parameter." }],
          );
        }
        expectedVersion = Number(queryVersion);
      }
    }

    const result = await deleteTenantMenu(tenantDb, location, { expectedVersion });
    return menuJsonResponse(200, {
      location: result.location,
      deleted: result.deleted,
      items: [],
      flatItems: [],
      version: result.version,
    });
  } catch (err) {
    return mapMenuDomainErrorToResponse(err, requestId);
  }
}

function buildMenusRuntimeEnv(): TenantMenusRuntimeEnv {
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
  handleTenantMenuLocationRequest(
    params.tenantId ?? "",
    params.location ?? "",
    request,
    buildMenusRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
