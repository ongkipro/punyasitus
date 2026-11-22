import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { renderPreviewDocumentInProcess } from "../../../../../core/preview/astro-renderer.ts";
import { handleTenantPreviewRequest, type TenantPreviewRuntimeEnv } from "./_shared.ts";

/**
 * Private In-Process Draft Preview Endpoint (`POST /api/tenants/:tenantId/preview`)
 * (REQ-036, REQ-001, REQ-034, REQ-039; PLAN §14; TASK-050).
 *
 * Always renders the exact same registered Astro theme shell (`themes/default/Layout.astro`)
 * directly in-process via `renderPreviewDocumentInProcess`.
 */

function buildPreviewRuntimeEnv(): TenantPreviewRuntimeEnv {
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
  handleTenantPreviewRequest(params.tenantId ?? "", request, buildPreviewRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    renderShellDocument: renderPreviewDocumentInProcess,
  });
