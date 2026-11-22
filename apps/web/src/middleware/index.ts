import { env } from "cloudflare:workers";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { defineMiddleware } from "astro:middleware";
import { executeTenantMiddleware } from "../core/tenant.ts";

export const onRequest = defineMiddleware((context, next) =>
  executeTenantMiddleware(context, next, {
    APP_ENV: env.APP_ENV,
    PLATFORM_DOMAIN: env.PLATFORM_DOMAIN,
    SAAS_ZONE: env.SAAS_ZONE,
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  }),
);
