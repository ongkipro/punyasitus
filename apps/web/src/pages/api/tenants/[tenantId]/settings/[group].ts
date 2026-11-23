import {
  ALLOWED_KEYS_BY_GROUP,
  isSettingsGroup,
  type SettingsGroup,
} from "@punyasitus/core/settings/index";
import {
  getGroupedSettingsForAdmin,
  saveGroupedSettingsDraft,
} from "@punyasitus/db/settings/index";
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
 * Tenant-scoped Grouped Settings endpoint (`TASK-040`; `REQ-044`, `REQ-034`, `REQ-036`):
 * - `GET   /api/tenants/:tenantId/settings/:group` -> reads group state (`settings:read`, Owner/Admin only; Editor -> 403)
 * - `PATCH /api/tenants/:tenantId/settings/:group` -> saves validated draft updates with OCC (`settings:write`, Owner/Admin only; Editor -> 403; locked -> 403 SUBSCRIPTION_LOCKED)
 */

export async function handleTenantSettingsGroupRequest(
  tenantId: string,
  rawGroup: string,
  request: Request,
  runtimeEnv: TenantSettingsRuntimeEnv,
  options: TenantSettingsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();
  const normalizedGroup = rawGroup.trim().toLowerCase();

  // Enforce auth & RBAC before revealing valid/invalid sub-group names to unauthorized callers
  const requiredPermission =
    method === "GET" ? "settings:read" : method === "PATCH" ? "settings:write" : "settings:read";

  const auth = await authorizeTenantSettingsRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  if (!isSettingsGroup(normalizedGroup)) {
    return settingsErrorResponse(
      404,
      "NOT_FOUND",
      `Grup pengaturan "${rawGroup}" tidak ditemukan.`,
      requestId,
    );
  }
  const group: SettingsGroup = normalizedGroup;

  if (group === "analytics" && method !== "GET") {
    return settingsErrorResponse(
      405,
      "BAD_REQUEST",
      "Pengaturan analitik hanya dapat diubah melalui endpoint khusus /api/tenants/:tenantId/analytics.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  if (method !== "GET" && method !== "PATCH") {
    return settingsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk grup pengaturan situs.",
      requestId,
      undefined,
      { Allow: "GET, PATCH" },
    );
  }

  const { member, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const state = await getGroupedSettingsForAdmin(tenantDb);
      return settingsJsonResponse(200, {
        group,
        draftVersion: state.draftVersion,
        publishedVersion: state.publishedVersion,
        version: state.version,
        versions: state.versions,
        hasUnpublishedChanges: state.hasUnpublishedChanges,
        updatedAt: state.updatedAt ?? new Date(options.nowMs ?? Date.now()).toISOString(),
        publishedAt: state.publishedAt,
        data: state.draft[group],
        publishedData: state.published ? state.published[group] : null,
        draft: state.draft,
        published: state.published,
        availablePages: state.availablePages,
      });
    }

    const parsedBody = await parseStrictSettingsJsonBody(
      request,
      ALLOWED_KEYS_BY_GROUP[group],
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredSettingsVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const saved = await saveGroupedSettingsDraft(tenantDb, {
      group,
      patch: parsedBody.body,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return settingsJsonResponse(200, {
      group,
      draftVersion: saved.draftVersion,
      publishedVersion: saved.publishedVersion,
      version: saved.version,
      versions: saved.versions,
      hasUnpublishedChanges: saved.hasUnpublishedChanges,
      updatedAt: saved.updatedAt ?? new Date(options.nowMs ?? Date.now()).toISOString(),
      publishedAt: saved.publishedAt,
      data: saved.draft[group],
      publishedData: saved.published ? saved.published[group] : null,
      draft: saved.draft,
      published: saved.published,
      availablePages: saved.availablePages,
    });
  } catch (err) {
    return mapSettingsDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantSettingsGroupRequest(
    params.tenantId ?? "",
    params.group ?? "",
    request,
    buildSettingsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
