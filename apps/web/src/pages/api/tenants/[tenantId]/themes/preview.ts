import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { renderPreviewDocumentInProcess } from "../../../../../core/preview/astro-renderer.ts";
import {
  handleTenantThemesPreviewRequest,
  type TenantThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Theme Compatibility Draft Preview endpoint:
 * - `POST /api/tenants/:tenantId/themes/preview`
 *
 * Always renders the exact registered Astro theme shell directly in-process via
 * `renderPreviewDocumentInProcess`.
 *
 * TASK-042 (`REQ-046`, `REQ-021`, `REQ-034`, `REQ-036`; PLAN §11.4 & §14).
 */

export { handleTenantThemesPreviewRequest };

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
  handleTenantThemesPreviewRequest(params.tenantId ?? "", request, buildThemesRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    renderShellDocument: renderPreviewDocumentInProcess,
  });
