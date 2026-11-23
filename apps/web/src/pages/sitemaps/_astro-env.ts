import { env } from "cloudflare:workers";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantMiddlewareLocals } from "../../core/tenant.ts";
import type { DiscoveryHandlerDeps } from "./_shared.ts";

function readOptionalEnvString(key: string): string | undefined {
  const bag = env as unknown as Record<string, unknown>;
  const value = bag[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extracts `DiscoveryHandlerDeps` from Astro `locals` + `cloudflare:workers` `env`.
 * Isolated from `_shared.ts` so `_shared.ts` stays runtime-neutral for Node unit tests.
 */
export function readDiscoveryDepsFromAstroLocals(locals: unknown): DiscoveryHandlerDeps {
  const bag = (locals ?? {}) as Partial<TenantMiddlewareLocals>;
  const runtimeEnv = env as typeof env & {
    readonly MEDIA_PUBLIC_BASE_URL?: string;
  };
  return {
    surface: bag.surface,
    host: bag.host,
    tenant: bag.tenant ?? null,
    tenantDb: bag.tenantDb ?? null,
    platformDb: runtimeEnv.PLATFORM_DB ?? null,
    tenantStore: (runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike) ?? null,
    platformDomain: runtimeEnv.PLATFORM_DOMAIN,
    saasZone: runtimeEnv.SAAS_ZONE,
    mediaPublicBaseUrl: readOptionalEnvString("MEDIA_PUBLIC_BASE_URL") ?? null,
  };
}
