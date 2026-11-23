import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemeRequest,
  createThemeRequestId,
  extractThemeExpectedVersion,
  mapThemeDomainErrorToResponse,
  parseStrictThemeJsonBody,
  publishThemeCustomizerAtomically,
  THEME_PUBLISH_ALLOWED_KEYS,
  themeErrorResponse,
  themeJsonResponse,
  type TenantThemeHandlerOptions,
  type TenantThemeRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Theme & Homepage Section atomic publish endpoint:
 * - `POST /api/tenants/:tenantId/theme/publish`
 *
 * Atomically publishes validated theme tokens/variants and homepage sections
 * via `publishResourceAtomically`, bumping `PLATFORM_DB.tenants.cache_version`.
 * Restricted strictly to Owner & Admin (`settings:publish`); Editor -> `403 FORBIDDEN`,
 * locked/suspended -> `403 SUBSCRIPTION_LOCKED`, stale version -> `409 STALE_VERSION`.
 *
 * TASK-034 (`REQ-037`, `REQ-019`, `REQ-020`, `REQ-036`).
 */

export async function handleTenantThemePublishRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemeRuntimeEnv,
  options: TenantThemeHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemeRequestId();

  if (method !== "POST") {
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
      "Metode HTTP tidak diizinkan untuk publikasi tema.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantThemeRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const parsedBody = await parseStrictThemeJsonBody(
      request,
      THEME_PUBLISH_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractThemeExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const published = await publishThemeCustomizerAtomically(platformDb, tenantDb, member, {
      expectedVersion: versionCheck.expectedVersion,
      expectedVersions: versionCheck.expectedVersions,
      nowMs: options.nowMs,
    });

    return themeJsonResponse(200, {
      ...published.state,
      cacheVersion: published.cacheVersion,
      publishedAt: published.publishedAt,
    });
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
  handleTenantThemePublishRequest(params.tenantId ?? "", request, buildThemeRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
