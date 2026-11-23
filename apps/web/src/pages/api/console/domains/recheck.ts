import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleDomainsRuntimeEnv,
  handleConsoleDomainRecheckRequest,
} from "./_shared.ts";

export const POST: APIRoute = ({ request }) =>
  handleConsoleDomainRecheckRequest(
    request,
    buildConsoleDomainsRuntimeEnv(
      env as typeof env & {
        readonly AUTH_SECRET?: string;
        readonly CONSOLE_AUTH_SECRET?: string;
        readonly SAAS_CNAME_TARGET?: string;
        readonly CF_SAAS_ZONE_ID?: string;
        readonly CF_SAAS_API_TOKEN?: string;
        readonly CF_API_BASE_URL?: string;
      },
    ),
  );
