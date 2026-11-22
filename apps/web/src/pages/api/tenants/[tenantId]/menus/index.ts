import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { assertMenuLocation } from "@punyasitus/core/menu-builder";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { listTenantMenus, saveTenantMenu } from "@punyasitus/db/menus/index";
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
 * Tenant-scoped navigation menus collection endpoint:
 * - `GET  /api/tenants/:tenantId/menus` -> list all navigation menus for the tenant
 * - `PUT  /api/tenants/:tenantId/menus` -> save/replace menu for `body.location`
 * - `POST /api/tenants/:tenantId/menus` -> save/replace menu for `body.location`
 *
 * TASK-004 (`REQ-006`, `REQ-007`, `REQ-034`).
 */

const UPSERT_COLLECTION_ALLOWED_KEYS = new Set([
  "location",
  "items",
  "version",
  "expectedVersion",
  "publish",
]);

export async function handleTenantMenusRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantMenusRuntimeEnv,
  options: TenantMenusHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PUT" && method !== "POST") {
    const auth = await authorizeTenantMenuRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return menuErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint menu.",
      requestId,
      undefined,
      { Allow: "GET, POST, PUT" },
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
    if (method === "GET") {
      const url = new URL(request.url);
      const includeEmpty = url.searchParams.get("includeEmpty") === "true";
      const menus = await listTenantMenus(tenantDb, { includeEmpty });
      return menuJsonResponse(200, {
        menus: menus.map(formatMenuRecordResponse),
      });
    }

    // PUT / POST upsert by body.location
    const parsedBody = await parseStrictMenuJsonBody(
      request,
      UPSERT_COLLECTION_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const body = parsedBody.body;
    const location = assertMenuLocation(body.location, "location");

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
  handleTenantMenusRequest(params.tenantId ?? "", request, buildMenusRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
