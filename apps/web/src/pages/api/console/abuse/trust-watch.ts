import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleConsoleTrustWatchRequest } from "./_screening-shared.ts";
import { buildConsoleAbuseRuntimeEnv } from "./_shared.ts";

export const ALL: APIRoute = ({ request }) =>
  handleConsoleTrustWatchRequest(request, buildConsoleAbuseRuntimeEnv(env));
