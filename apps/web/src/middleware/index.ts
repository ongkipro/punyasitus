import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { defineMiddleware } from "astro:middleware";
import { executeTenantMiddleware } from "../core/tenant.ts";
import { executeAuthMiddleware, type AuthRuntimeEnv } from "./auth.ts";

export const onRequest = defineMiddleware((context, next) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };

  const authEnv: AuthRuntimeEnv = {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };

  return executeTenantMiddleware(
    context,
    () => executeAuthMiddleware(context, next, authEnv),
    {
      APP_ENV: runtimeEnv.APP_ENV,
      PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
      SAAS_ZONE: runtimeEnv.SAAS_ZONE,
      PLATFORM_DB: runtimeEnv.PLATFORM_DB,
      TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    },
  );
});
