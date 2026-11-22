import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { publishSiteIdentity } from "@punyasitus/db/identity/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantIdentityRequest,
  createRequestId,
  extractExpectedVersion,
  identityErrorResponse,
  identityJsonResponse,
  mapIdentityDomainErrorToResponse,
  parseStrictIdentityJsonBody,
  type TenantIdentityHandlerOptions,
  type TenantIdentityRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Site Identity atomic publish endpoint:
 * - `POST /api/tenants/:tenantId/identity/publish`
 *
 * Atomically publishes validated `site_settings` & `business_profile` drafts,
 * increments resource versions AND `PLATFORM_DB.tenants.cache_version`.
 * Restricted strictly to Owner & Admin (`settings:publish`); Editor fails with `403 FORBIDDEN`.
 *
 * TASK-008 (`REQ-011`, `REQ-034`, `REQ-036`).
 */

const PUBLISH_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantIdentityPublishRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantIdentityRuntimeEnv,
  options: TenantIdentityHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
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
      "Metode HTTP tidak diizinkan untuk publikasi identitas situs.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  // PLAN §4: Only Owner & Admin may publish site identity (`settings:publish`); Editor -> 403 FORBIDDEN.
  const auth = await authorizeTenantIdentityRequest(
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
    const parsedBody = await parseStrictIdentityJsonBody(
      request,
      PUBLISH_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const published = await publishSiteIdentity(platformDb, tenantDb, {
      tenantId: member.tenantId,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      nowMs: options.nowMs,
    });

    return identityJsonResponse(200, {
      version: published.version,
      versions: published.versions,
      cacheVersion: published.cacheVersion,
      publishedAt: published.publishedAt,
      contentModifiedAt: published.contentModifiedAt,
      published: published.published,
      hasUnpublishedChanges: published.hasUnpublishedChanges,
    });
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
  handleTenantIdentityPublishRequest(params.tenantId ?? "", request, buildIdentityRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
