import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemeRequest,
  createThemeRequestId,
  extractThemeExpectedVersion,
  loadThemeCustomizerAdminState,
  mapThemeDomainErrorToResponse,
  parseStrictThemeJsonBody,
  saveThemeCustomizerDraft,
  THEME_PATCH_ALLOWED_KEYS,
  themeErrorResponse,
  themeJsonResponse,
  type TenantThemeHandlerOptions,
  type TenantThemeRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Theme & Homepage Section Customizer endpoint:
 * - `GET   /api/tenants/:tenantId/theme` -> read current draft & published theme tokens,
 *   homepage sections order/toggles, version, Permenkes health flag & available platform themes.
 * - `PATCH /api/tenants/:tenantId/theme` -> validate & persist theme tokens + section order/toggles
 *   strictly to DRAFT with optimistic `expectedVersion` (`409 STALE_VERSION`) without mutating
 *   published snapshots (Owner/Admin only; Editor gets `403`, locked gets `403 SUBSCRIPTION_LOCKED`).
 *
 * TASK-034 (`REQ-037`, `REQ-019`, `REQ-020`, `REQ-036`).
 */

export async function handleTenantThemeRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemeRuntimeEnv,
  options: TenantThemeHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemeRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantThemeRequest(
      tenantId,
      request,
      runtimeEnv,
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themeErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint kustomisasi tema.",
      requestId,
      undefined,
      { Allow: "GET, PATCH" },
    );
  }

  // Owner & Admin may mutate theme settings (`settings:write`); Editor -> 403 FORBIDDEN on PATCH.
  const requiredPermission = method === "GET" ? "content:read" : "settings:write";
  const auth = await authorizeTenantThemeRequest(
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
      const state = await loadThemeCustomizerAdminState(tenantDb, member);
      return themeJsonResponse(200, state);
    }

    const parsedBody = await parseStrictThemeJsonBody(
      request,
      THEME_PATCH_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractThemeExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const saved = await saveThemeCustomizerDraft(tenantDb, member, {
      tokens: parsedBody.body.tokens as Record<string, unknown> | undefined,
      variants: parsedBody.body.variants as Record<string, unknown> | undefined,
      sections: parsedBody.body.sections,
      expectedVersion: versionCheck.expectedVersion,
      expectedVersions: versionCheck.expectedVersions,
      nowMs: options.nowMs,
    });

    return themeJsonResponse(200, saved);
  } catch (err) {
    return mapThemeDomainErrorToResponse(err, requestId);
  }
}

function buildThemeRuntimeEnv(): TenantThemeRuntimeEnv {
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
  handleTenantThemeRequest(params.tenantId ?? "", request, buildThemeRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
