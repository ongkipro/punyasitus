import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  activateTenantThemeFromLibrary,
  authorizeTenantThemesRequest,
  createThemesRequestId,
  extractThemesExpectedVersion,
  mapThemesDomainErrorToResponse,
  parseStrictThemesJsonBody,
  THEMES_ACTIVATE_ALLOWED_KEYS,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Atomic Theme Activation endpoint:
 * - `POST /api/tenants/:tenantId/themes/activate`
 *
 * Requires `settings:publish` (Owner/Admin ONLY — Editor -> `403 FORBIDDEN`,
 * cross-tenant -> `404 NOT_FOUND`, locked/suspended -> `403 SUBSCRIPTION_LOCKED`,
 * CSRF/Origin checked, required `expectedVersion` -> `422`/`409`).
 * Atomically switches active theme while preserving prior theme config and all content!
 *
 * TASK-042 (`REQ-046`, `REQ-018`, `REQ-021`, `REQ-034`, `REQ-036`; PLAN §11.4).
 */

export async function handleTenantThemesActivateRequest(
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
      "content:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk aktivasi tema.",
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
      THEMES_ACTIVATE_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractThemesExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    const rawThemeId = parsedBody.body.themeId;
    if (typeof rawThemeId !== "string" || !rawThemeId.trim()) {
      return themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "themeId wajib diisi untuk mengaktifkan tema.",
        requestId,
        {
          fields: [
            {
              field: "themeId",
              code: "REQUIRED",
              message: "themeId is required.",
            },
          ],
        },
      );
    }

    if (parsedBody.body.confirm === false) {
      return themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Konfirmasi eksplisit diperlukan sebelum mengaktifkan tema baru.",
        requestId,
        {
          fields: [
            {
              field: "confirm",
              code: "CONFIRMATION_REQUIRED",
              message: "Explicit confirmation is required to activate a theme.",
            },
          ],
        },
      );
    }

    const rawStyleVariantId =
      typeof parsedBody.body.styleVariantId === "string" && parsedBody.body.styleVariantId.trim()
        ? parsedBody.body.styleVariantId.trim()
        : null;

    const activated = await activateTenantThemeFromLibrary(
      auth.ctx.platformDb,
      auth.ctx.tenantDb,
      auth.ctx.member,
      {
        themeId: rawThemeId,
        styleVariantId: rawStyleVariantId,
        expectedVersion: versionCheck.expectedVersion,
        nowMs: options.nowMs,
      },
      { extraRegisteredThemes: options.extraRegisteredThemes },
    );

    return themesJsonResponse(200, activated);
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildThemesRuntimeEnv(): TenantThemesRuntimeEnv {
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
  handleTenantThemesActivateRequest(params.tenantId ?? "", request, buildThemesRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
