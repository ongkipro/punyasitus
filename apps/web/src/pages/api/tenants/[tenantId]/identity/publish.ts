import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { publishStructuredBusinessProfile } from "@punyasitus/db/business-profile/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  ContentScreeningError,
  publishResourceWithScreening,
} from "@punyasitus/db/content-screening/index";
import { publishSiteIdentity, StaleRevisionError } from "@punyasitus/db/identity/index";
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

    // Probe base identity rows + optional 0011 structured business profile table
    const [siteRow, profileRow] = await Promise.all([
      tenantDb
        .prepare("SELECT version, draft_json FROM site_settings WHERE id = 1 LIMIT 1")
        .first<{ readonly version: number; readonly draft_json: string | null }>(),
      tenantDb
        .prepare("SELECT version FROM business_profile WHERE id = 1 LIMIT 1")
        .first<{ readonly version: number }>(),
    ]);

    interface StructuredIdentityProbeRow {
      readonly id: number;
      readonly version: number;
      readonly draft_json: string | null;
      readonly privacy_contact: string | null;
      readonly person_role_title: string | null;
      readonly affiliated_org_name: string | null;
      readonly credentials_json: string | null;
    }
    let structuredRow: StructuredIdentityProbeRow | null = null;
    try {
      structuredRow = await tenantDb
        .prepare(
          `SELECT id, version, draft_json, privacy_contact, person_role_title,
                  affiliated_org_name, credentials_json
           FROM business_profile_structured
           WHERE id = 1
           LIMIT 1`,
        )
        .first<StructuredIdentityProbeRow>();
    } catch {
      structuredRow = null;
    }
    const hasStructuredTable = structuredRow !== null;

    // Preserve exact 422 IDENTITY_NOT_INITIALIZED validation without ever calling unscreened publish
    if (!siteRow || !profileRow) {
      return identityErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Site identity must be saved before it can be published.",
        requestId,
        [
          {
            field: "identity",
            code: "IDENTITY_NOT_INITIALIZED",
            message: "Save site identity draft before publishing.",
          },
        ],
      );
    }

    const ssVersion = Number(siteRow.version);
    const bpVersion = Number(profileRow.version);
    const extVersion = structuredRow ? Number(structuredRow.version) : 0;
    const currentUnifiedVersion = Math.max(ssVersion, bpVersion, extVersion);

    if (
      versionCheck.expectedVersion !== undefined &&
      versionCheck.expectedVersion !== currentUnifiedVersion
    ) {
      throw new StaleRevisionError({
        resourceType: hasStructuredTable ? "business_profile" : "site_settings",
        resourceId: 1,
        expectedVersion: versionCheck.expectedVersion,
        actualVersion: currentUnifiedVersion,
      });
    }

    // Pin OCC to the exact screened unified version to prevent TOCTOU when caller omits expectedVersion
    const pinnedExpectedVersion = versionCheck.expectedVersion ?? currentUnifiedVersion;

    // Extract any outer `_brandAssets` logo media IDs from `site_settings.draft_json` so logo ALTs are also screened
    const extraBrandMediaIds: number[] = [];
    if (siteRow.draft_json) {
      try {
        const parsedSiteDraft = JSON.parse(siteRow.draft_json) as {
          readonly _brandAssets?: Record<string, unknown>;
        };
        const assets = parsedSiteDraft?._brandAssets;
        if (assets && typeof assets === "object") {
          for (const v of Object.values(assets)) {
            if (typeof v === "number" && Number.isInteger(v) && v > 0) {
              extraBrandMediaIds.push(v);
            }
          }
        }
      } catch {
        // Ignore malformed JSON; screening will still inspect canonical draft snapshot
      }
    }

    const structuredExtraSnapshots: unknown[] = [];
    if (structuredRow) {
      let parsedExtDraft: unknown = null;
      if (structuredRow.draft_json) {
        try {
          parsedExtDraft = JSON.parse(structuredRow.draft_json);
        } catch {
          parsedExtDraft = structuredRow.draft_json;
        }
      }
      let parsedCredentials: unknown = null;
      if (structuredRow.credentials_json) {
        try {
          parsedCredentials = JSON.parse(structuredRow.credentials_json);
        } catch {
          parsedCredentials = structuredRow.credentials_json;
        }
      }
      structuredExtraSnapshots.push({
        draft: parsedExtDraft,
        privacyContact: structuredRow.privacy_contact,
        personRoleTitle: structuredRow.person_role_title,
        affiliatedOrgName: structuredRow.affiliated_org_name,
        credentials: parsedCredentials,
      });
    }

    // Screen BOTH `site_settings` and `business_profile` (+ structured extension) atomically
    // before committing either table (`REQ-103`, `SEC-001`).
    const siteGateOutcome = await publishResourceWithScreening(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: ssVersion,
      publishSource: "dashboard",
      actorUserId: member.userId,
      extraMediaIds: extraBrandMediaIds,
      nowMs: options.nowMs,
      executePublish: () =>
        publishResourceWithScreening(platformDb, tenantDb, {
          tenantId: member.tenantId,
          resourceType: "business_profile",
          resourceId: 1,
          expectedVersion: bpVersion,
          publishSource: "dashboard",
          actorUserId: member.userId,
          extraSnapshots: structuredExtraSnapshots.length > 0 ? structuredExtraSnapshots : undefined,
          nowMs: options.nowMs,
          executePublish: async () => {
            if (hasStructuredTable) {
              const published = await publishStructuredBusinessProfile(platformDb, tenantDb, {
                tenantId: member.tenantId,
                expectedVersion: pinnedExpectedVersion,
                actorUserId: member.userId,
                actorRole: member.role,
                nowMs: options.nowMs,
              });
              return {
                version: published.version,
                versions: {
                  siteSettings: published.versions.siteSettings,
                  businessProfile: published.versions.businessProfile,
                },
                cacheVersion: published.cacheVersion,
                publishedAt: published.publishedAt,
                contentModifiedAt: published.contentModifiedAt,
                published: published.published,
                hasUnpublishedChanges: published.hasUnpublishedChanges,
              };
            }

            const published = await publishSiteIdentity(platformDb, tenantDb, {
              tenantId: member.tenantId,
              expectedVersion: pinnedExpectedVersion,
              actorUserId: member.userId,
              nowMs: options.nowMs,
            });
            return {
              version: published.version,
              versions: published.versions,
              cacheVersion: published.cacheVersion,
              publishedAt: published.publishedAt,
              contentModifiedAt: published.contentModifiedAt,
              published: published.published,
              hasUnpublishedChanges: published.hasUnpublishedChanges,
            };
          },
        }),
    });

    if (siteGateOutcome.outcome === "held_for_review") {
      return identityJsonResponse(
        202,
        {
          outcome: "held_for_review",
          held: true,
          status: siteGateOutcome.ownerNotice.status,
          reason: siteGateOutcome.ownerNotice.reason,
          reviewId: siteGateOutcome.reviewId,
          message: siteGateOutcome.ownerNotice.message,
          ownerNotice: siteGateOutcome.ownerNotice,
          requestId,
        },
        { "Cache-Control": "private, no-store" },
      );
    }

    const profileGateOutcome = siteGateOutcome.published;
    if (profileGateOutcome.outcome === "held_for_review") {
      return identityJsonResponse(
        202,
        {
          outcome: "held_for_review",
          held: true,
          status: profileGateOutcome.ownerNotice.status,
          reason: profileGateOutcome.ownerNotice.reason,
          reviewId: profileGateOutcome.reviewId,
          message: profileGateOutcome.ownerNotice.message,
          ownerNotice: profileGateOutcome.ownerNotice,
          requestId,
        },
        { "Cache-Control": "private, no-store" },
      );
    }

    return identityJsonResponse(200, profileGateOutcome.published);
  } catch (err) {
    if (err instanceof ContentScreeningError) {
      if (err.code === "STALE_VERSION") {
        return identityErrorResponse(409, "STALE_VERSION", err.message, requestId, [
          { field: "expectedVersion", code: "STALE_VERSION", message: err.message },
        ]);
      }
      if (err.code === "NOT_FOUND") {
        return identityErrorResponse(404, "NOT_FOUND", err.message, requestId);
      }
      if (err.code === "TOO_MANY_PENDING_REVIEWS") {
        return identityErrorResponse(429, "RATE_LIMITED", err.message, requestId);
      }
      if (err.code === "VALIDATION_ERROR") {
        return identityErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
      }
      return identityErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId);
    }
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
