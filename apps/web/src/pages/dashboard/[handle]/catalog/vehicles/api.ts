import { env } from "cloudflare:workers";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  handleDashboardVehiclesApiRequest,
  type DashboardVehiclesRuntimeEnv,
} from "./_api-handler.ts";

function buildRuntimeEnv(): DashboardVehiclesRuntimeEnv {
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
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleDashboardVehiclesApiRequest(params.handle ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    authenticatedSessionId: locals.authSession?.id ?? null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
