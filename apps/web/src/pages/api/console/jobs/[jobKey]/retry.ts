import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleJobsRuntimeEnv,
  handleConsoleJobRetryRequest,
} from "../_shared.ts";

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleJobRetryRequest(
    request,
    buildConsoleJobsRuntimeEnv(
      env as typeof env & {
        readonly AUTH_SECRET?: string;
        readonly CONSOLE_AUTH_SECRET?: string;
      },
    ),
    { pathJobKey: params.jobKey ? decodeURIComponent(params.jobKey) : undefined },
  );
