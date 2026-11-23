import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { activateStoreThemeOrVariantAtomically } from "@punyasitus/db/themes/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemesRequest,
  createThemesRequestId,
  extractThemesExpectedVersion,
  loadTenantThemeLibraryState,
  mapThemesDomainErrorToResponse,
  parseStrictThemesJsonBody,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Style Variant Application endpoint:
 * - `POST /api/tenants/:tenantId/themes/variants`
 *
 * Applies a WCAG-AA-verified Style Variant to an entitled theme (`included`,
 * purchased `paid_once`, or granted `custom`) with 0% content loss.
 * Enforces `settings:publish` (Owner/Admin only — Editor -> 403), CSRF/Origin,
 * per-website entitlement (`403 THEME_NOT_ENTITLED`), and optimistic version (`409`).
 *
 * TASK-096 (`REQ-096`, `REQ-018`, `REQ-020`, `REQ-046`).
 */

const VARIANT_APPLY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "themeId",
  "styleVariantId",
  "expectedVersion",
  "version",
]);

export async function handleTenantThemeVariantApplyRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: TenantThemesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantThemesRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST untuk menerapkan varian gaya tema.",
      requestId,
      { extraHeaders: { Allow: "POST" } },
    );
  }

  const auth = await authorizeTenantThemesRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const parsedBody = await parseStrictThemesJsonBody(
      request,
      VARIANT_APPLY_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractThemesExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const rawStyleVariantId = parsedBody.body.styleVariantId;
    if (typeof rawStyleVariantId !== "string" || !rawStyleVariantId.trim()) {
      return themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "styleVariantId wajib diisi untuk menerapkan varian gaya.",
        requestId,
        {
          fields: [
            {
              field: "styleVariantId",
              code: "REQUIRED",
              message: "styleVariantId is required.",
            },
          ],
        },
      );
    }

    let targetThemeId =
      typeof parsedBody.body.themeId === "string" && parsedBody.body.themeId.trim()
        ? parsedBody.body.themeId.trim()
        : "";

    if (!targetThemeId) {
      const siteRow = await auth.ctx.tenantDb
        .prepare("SELECT active_theme_id FROM site_settings WHERE id = 1 LIMIT 1")
        .first<{ readonly active_theme_id: string }>();
      targetThemeId = siteRow?.active_theme_id ?? "compro";
    }

    const applied = await activateStoreThemeOrVariantAtomically({
      platformDb: auth.ctx.platformDb,
      tenantDb: auth.ctx.tenantDb,
      tenantId: auth.ctx.member.tenantId,
      tenantName: auth.ctx.member.tenantName,
      actorUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
      themeId: targetThemeId,
      styleVariantId: rawStyleVariantId.trim(),
      expectedVersion: versionCheck.expectedVersion,
      nowMs: options.nowMs,
    });

    const refreshedState = await loadTenantThemeLibraryState(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      auth.ctx.member,
      { extraRegisteredThemes: options.extraRegisteredThemes },
    );

    return themesJsonResponse(200, {
      ...refreshedState,
      activatedThemeId: applied.activatedThemeId,
      previousThemeId: applied.previousThemeId,
      activeStyleVariantId: applied.activeStyleVariantId,
      cacheVersion: applied.cacheVersion,
      activatedAt: applied.activatedAt,
    });
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantThemesRuntimeEnv {
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
  handleTenantThemeVariantApplyRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
