import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { CloudflareImagesBinding } from "@punyasitus/core/media/index";
import {
  getStructuredBusinessProfileForAdmin,
  saveStructuredBusinessProfileDraft,
  STRUCTURED_BUSINESS_PROFILE_ALLOWED_KEYS,
  STRUCTURED_IDENTITY_PATCH_ALLOWED_KEYS,
} from "@punyasitus/db/business-profile/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { IdentityValidationError, SITE_SETTINGS_ALLOWED_KEYS } from "@punyasitus/db/identity/index";
import type { APIRoute } from "astro";
import type { MediaWorkerR2BucketLike } from "../../../../../../worker/queues/media/index.ts";
import {
  authorizeTenantIdentityRequest,
  createRequestId,
  extractExpectedVersion,
  formatStructuredBusinessProfileResponse,
  identityErrorResponse,
  identityJsonResponse,
  mapIdentityDomainErrorToResponse,
  parseStrictIdentityJsonBody,
  triggerBrandAssetsDerivationForLogo,
  type BrandAssetsQueueProducerLike,
  type TenantIdentityHandlerOptions,
  type TenantIdentityRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped Structured Business Profile API (TASK-091, REQ-091, REQ-044):
 * - `GET   /api/tenants/:tenantId/identity/business-profile` (`settings:read` — Editor gets 403!)
 * - `PATCH /api/tenants/:tenantId/identity/business-profile` (`settings:write` — Owner/Admin only, OCC + audit)
 * - `PUT   /api/tenants/:tenantId/identity/business-profile` (`settings:write` — Owner/Admin only, OCC + audit)
 */

function parsePayload(body: Record<string, unknown>): {
  readonly siteSettingsPatch: Record<string, unknown>;
  readonly businessProfilePatch: Record<string, unknown>;
  readonly hasSiteSettingsFields: boolean;
  readonly hasBusinessProfileFields: boolean;
} {
  const siteSettingsPatch: Record<string, unknown> = {};
  const businessProfilePatch: Record<string, unknown> = {};

  if (body.siteSettings !== undefined) {
    if (
      typeof body.siteSettings !== "object" ||
      body.siteSettings === null ||
      Array.isArray(body.siteSettings)
    ) {
      throw new IdentityValidationError("siteSettings must be a JSON object.", [
        { field: "siteSettings", code: "INVALID_IDENTITY_PAYLOAD", message: "Expected a JSON object." },
      ]);
    }
    for (const [k, v] of Object.entries(body.siteSettings as Record<string, unknown>)) {
      if (!SITE_SETTINGS_ALLOWED_KEYS.has(k)) {
        throw new IdentityValidationError(`Unknown field "${k}" in siteSettings.`, [
          { field: `siteSettings.${k}`, code: "UNKNOWN_FIELD", message: `Unknown field "${k}".` },
        ]);
      }
      siteSettingsPatch[k] = v;
    }
  }

  if (body.businessProfile !== undefined) {
    if (
      typeof body.businessProfile !== "object" ||
      body.businessProfile === null ||
      Array.isArray(body.businessProfile)
    ) {
      throw new IdentityValidationError("businessProfile must be a JSON object.", [
        {
          field: "businessProfile",
          code: "INVALID_IDENTITY_PAYLOAD",
          message: "Expected a JSON object.",
        },
      ]);
    }
    for (const [k, v] of Object.entries(body.businessProfile as Record<string, unknown>)) {
      if (!STRUCTURED_BUSINESS_PROFILE_ALLOWED_KEYS.has(k)) {
        throw new IdentityValidationError(`Unknown field "${k}" in businessProfile.`, [
          {
            field: `businessProfile.${k}`,
            code: "UNKNOWN_FIELD",
            message: `Unknown field "${k}".`,
          },
        ]);
      }
      businessProfilePatch[k] = v;
    }
  }

  for (const [key, value] of Object.entries(body)) {
    if (
      key === "siteSettings" ||
      key === "businessProfile" ||
      key === "expectedVersion" ||
      key === "version"
    ) {
      continue;
    }
    if (SITE_SETTINGS_ALLOWED_KEYS.has(key)) {
      siteSettingsPatch[key] = value;
    } else if (STRUCTURED_BUSINESS_PROFILE_ALLOWED_KEYS.has(key)) {
      businessProfilePatch[key] = value;
    }
  }

  const hasSiteSettingsFields = Object.keys(siteSettingsPatch).length > 0;
  const hasBusinessProfileFields = Object.keys(businessProfilePatch).length > 0;
  if (!hasSiteSettingsFields && !hasBusinessProfileFields) {
    throw new IdentityValidationError(
      "At least one siteSettings or businessProfile field must be provided.",
      [{ field: "body", code: "EMPTY_IDENTITY_PATCH", message: "Empty patch payload." }],
    );
  }

  return {
    siteSettingsPatch,
    businessProfilePatch,
    hasSiteSettingsFields,
    hasBusinessProfileFields,
  };
}

export async function handleTenantBusinessProfileRequest(
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
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return identityErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint profil bisnis.",
      requestId,
      undefined,
      { Allow: "GET, PUT, PATCH" },
    );
  }

  // Strictly require `settings:read` on GET (Editor -> 403 FORBIDDEN) and `settings:write` on PUT/PATCH!
  const requiredPermission = method === "GET" ? "settings:read" : "settings:write";
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

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const profile = await getStructuredBusinessProfileForAdmin(tenantDb);
      return identityJsonResponse(
        200,
        formatStructuredBusinessProfileResponse(profile, { includeStructuredVersionKey: true }),
      );
    }

    const parsedBody = await parseStrictIdentityJsonBody(
      request,
      STRUCTURED_IDENTITY_PATCH_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const priorProfile = await getStructuredBusinessProfileForAdmin(tenantDb);
    const previousLogoMediaId = priorProfile.siteSettings?.logoMediaId ?? null;

    const normalized = parsePayload(parsedBody.body);
    let saved = await saveStructuredBusinessProfileDraft(tenantDb, {
      siteSettings: normalized.hasSiteSettingsFields ? normalized.siteSettingsPatch : undefined,
      businessProfile: normalized.hasBusinessProfileFields
        ? normalized.businessProfilePatch
        : undefined,
      expectedVersion: versionCheck.expectedVersion,
      mode: method === "PUT" ? "put" : "patch",
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    // When logoMediaId is set/changed, enqueue durable `media.derive_brand_assets` on JOBS_QUEUE
    // (or derive inline ONLY when JOBS_QUEUE is unbound in local/test mode)
    const derivationTrigger = await triggerBrandAssetsDerivationForLogo({
      tenantId: member.tenantId,
      logoMediaId: saved.siteSettings?.logoMediaId ?? null,
      previousLogoMediaId,
      savedVersion: saved.version,
      requestId,
      platformDb,
      tenantDb,
      runtimeEnv,
      nowMs: options.nowMs,
    });

    if (derivationTrigger.mode === "inline_derived") {
      saved = await getStructuredBusinessProfileForAdmin(tenantDb);
    }

    return identityJsonResponse(
      200,
      formatStructuredBusinessProfileResponse(saved, { includeStructuredVersionKey: true }),
    );
  } catch (err) {
    return mapIdentityDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantIdentityRuntimeEnv {
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
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET as unknown as MediaWorkerR2BucketLike | undefined,
    IMAGES: runtimeEnv.IMAGES as unknown as CloudflareImagesBinding | undefined,
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE as unknown as BrandAssetsQueueProducerLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantBusinessProfileRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
