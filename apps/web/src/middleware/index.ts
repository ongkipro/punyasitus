import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { defineMiddleware } from "astro:middleware";
import { executeAffiliateReferralMiddleware } from "./affiliate-referral.ts";
import { executeAuthMiddleware, type AuthRuntimeEnv } from "./auth.ts";
import { executeTenantWithConsentAwareCspMiddleware } from "./csp.ts";

export const onRequest = defineMiddleware((context, next) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly AFFILIATE_COOKIE_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly GOOGLE_CLIENT_ID?: string;
    readonly GOOGLE_CLIENT_SECRET?: string;
    readonly CONSOLE_GOOGLE_ALLOWLIST?: string;
    readonly TURNSTILE_SITE_KEY?: string;
    readonly TURNSTILE_SECRET_KEY?: string;
  };

  const authEnv: AuthRuntimeEnv = {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    GOOGLE_CLIENT_ID: runtimeEnv.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: runtimeEnv.GOOGLE_CLIENT_SECRET,
    CONSOLE_GOOGLE_ALLOWLIST: runtimeEnv.CONSOLE_GOOGLE_ALLOWLIST,
    TURNSTILE_SITE_KEY: runtimeEnv.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: runtimeEnv.TURNSTILE_SECRET_KEY,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };

  return executeTenantWithConsentAwareCspMiddleware(
    context,
    () =>
      executeAffiliateReferralMiddleware(
        context,
        () => {
          if (
            context.locals.surface === "marketing" &&
            context.locals.tenant === null &&
            (context.url.pathname === "/bantuan" || context.url.pathname.startsWith("/bantuan/"))
          ) {
            const rewritten = new URL(
              `/marketing${context.url.pathname}${context.url.search}`,
              context.url,
            );
            return context.rewrite(rewritten);
          }
          return executeAuthMiddleware(context, next, authEnv);
        },
        {
          APP_ENV: runtimeEnv.APP_ENV,
          PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
          PLATFORM_DB: runtimeEnv.PLATFORM_DB,
          AFFILIATE_COOKIE_SECRET: runtimeEnv.AFFILIATE_COOKIE_SECRET,
          AUTH_SECRET: runtimeEnv.AUTH_SECRET,
        },
      ),
    {
      APP_ENV: runtimeEnv.APP_ENV,
      PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
      SAAS_ZONE: runtimeEnv.SAAS_ZONE,
      PLATFORM_DB: runtimeEnv.PLATFORM_DB,
      TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    },
  );
});
