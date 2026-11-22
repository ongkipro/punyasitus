import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  getSiteIdentityForAdmin,
  IDENTITY_PATCH_ALLOWED_KEYS,
  normalizeIdentityRequestPayload,
  saveSiteIdentityDraft,
} from "@punyasitus/db/identity/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantIdentityRequest,
  createRequestId,
  extractExpectedVersion,
  formatIdentityAdminResponse,
  identityErrorResponse,
  identityJsonResponse,
  mapIdentityDomainErrorToResponse,
  parseStrictIdentityJsonBody,
  type TenantIdentityHandlerOptions,
  type TenantIdentityRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Site Identity & Brand Configuration endpoint:
 * - `GET   /api/tenants/:tenantId/identity` -> read current draft & published identity (Owner/Admin/Editor)
 * - `PUT   /api/tenants/:tenantId/identity` -> replace draft site identity & business profile with OCC (Owner/Admin only)
 * - `PATCH /api/tenants/:tenantId/identity` -> partially update draft site identity & business profile with OCC (Owner/Admin only)
 *
 * TASK-008 (`REQ-011`, `REQ-034`, `REQ-036`).
 */

export async function handleTenantIdentityRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantIdentityRuntimeEnv,
  options: TenantIdentityHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PUT" && method !== "PATCH") {
    const auth = await authorizeTenantIdentityRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return identityErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint identitas situs.",
      requestId,
      undefined,
      { Allow: "GET, PUT, PATCH" },
    );
  }

  // PLAN §4: Owner & Admin may mutate identity (`settings:write`); Editor is rejected with 403 FORBIDDEN on mutations.
  const requiredPermission = method === "GET" ? "content:read" : "settings:write";
  const auth = await authorizeTenantIdentityRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const identity = await getSiteIdentityForAdmin(tenantDb);
      return identityJsonResponse(200, formatIdentityAdminResponse(identity));
    }

    const parsedBody = await parseStrictIdentityJsonBody(
      request,
      IDENTITY_PATCH_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const normalized = normalizeIdentityRequestPayload(parsedBody.body);
    const saved = await saveSiteIdentityDraft(tenantDb, {
      siteSettings: normalized.hasSiteSettingsFields ? normalized.siteSettingsPatch : undefined,
      businessProfile: normalized.hasBusinessProfileFields
        ? normalized.businessProfilePatch
        : undefined,
      expectedVersion: versionCheck.expectedVersion,
      mode: method === "PUT" ? "put" : "patch",
      nowMs: options.nowMs,
    });

    return identityJsonResponse(200, formatIdentityAdminResponse(saved));
  } catch (err) {
    return mapIdentityDomainErrorToResponse(err, requestId);
  }
}

function buildIdentityRuntimeEnv(): TenantIdentityRuntimeEnv {
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
  handleTenantIdentityRequest(params.tenantId ?? "", request, buildIdentityRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
