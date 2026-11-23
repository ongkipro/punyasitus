import { isSettingsGroup, type SettingsGroup } from "@punyasitus/core/settings/index";
import { publishGroupedSettings } from "@punyasitus/db/settings/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantSettingsRequest,
  buildSettingsRuntimeEnv,
  createRequestId,
  extractRequiredSettingsVersion,
  mapSettingsDomainErrorToResponse,
  parseStrictSettingsJsonBody,
  settingsErrorResponse,
  settingsJsonResponse,
  type TenantSettingsHandlerOptions,
  type TenantSettingsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Grouped Settings atomic publish endpoint (`TASK-040`; `REQ-044`, `REQ-034`, `REQ-036`):
 * - `POST /api/tenants/:tenantId/settings/publish`
 *
 * Atomically publishes validated draft settings (`site_settings`, `business_profile`, and optional
 * `pages.is_homepage`), records a PII-free `tenant_activity_log` entry, and bumps
 * `PLATFORM_DB.tenants.cache_version`.
 * Restricted strictly to Owner & Admin (`settings:publish`); Editor -> `403 FORBIDDEN`;
 * `locked` -> `403 SUBSCRIPTION_LOCKED`.
 */

const PUBLISH_SETTINGS_ALLOWED_KEYS = new Set(["version", "expectedVersion", "group"]);

export async function handleTenantSettingsPublishRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantSettingsRuntimeEnv,
  options: TenantSettingsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantSettingsRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return settingsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk publikasi pengaturan situs.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantSettingsRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:publish",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    const parsedBody = await parseStrictSettingsJsonBody(
      request,
      PUBLISH_SETTINGS_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredSettingsVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    let responseGroup: SettingsGroup = "general";
    if (parsedBody.body.group !== undefined) {
      if (typeof parsedBody.body.group !== "string" || !isSettingsGroup(parsedBody.body.group)) {
        return settingsErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Field group tidak valid.",
          requestId,
          [{ field: "group", code: "INVALID_GROUP", message: "Invalid settings group." }],
        );
      }
      responseGroup = parsedBody.body.group;
    }

    const published = await publishGroupedSettings(platformDb, tenantDb, {
      tenantId: member.tenantId,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return settingsJsonResponse(200, {
      group: responseGroup,
      draftVersion: published.draftVersion,
      publishedVersion: published.publishedVersion,
      version: published.version,
      versions: published.versions,
      cacheVersion: published.cacheVersion,
      hasUnpublishedChanges: published.hasUnpublishedChanges,
      publishedAt: published.publishedAt,
      contentModifiedAt: published.contentModifiedAt,
      updatedAt: published.updatedAt,
      published: published.published,
    });
  } catch (err) {
    return mapSettingsDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSettingsPublishRequest(params.tenantId ?? "", request, buildSettingsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
