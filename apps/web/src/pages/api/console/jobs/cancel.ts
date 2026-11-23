import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleJobsRuntimeEnv,
  handleConsoleJobCancelRequest,
} from "./_shared.ts";

export const POST: APIRoute = ({ request }) =>
  handleConsoleJobCancelRequest(
    request,
    buildConsoleJobsRuntimeEnv(
      env as typeof env & {
        readonly AUTH_SECRET?: string;
        readonly CONSOLE_AUTH_SECRET?: string;
      },
    ),
  );
