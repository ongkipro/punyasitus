import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleJobsRuntimeEnv,
  handleConsoleJobsListRequest,
} from "./_shared.ts";

export const GET: APIRoute = ({ request }) =>
  handleConsoleJobsListRequest(
    request,
    buildConsoleJobsRuntimeEnv(
      env as typeof env & {
        readonly AUTH_SECRET?: string;
        readonly CONSOLE_AUTH_SECRET?: string;
      },
    ),
  );
