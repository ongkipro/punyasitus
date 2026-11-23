import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleAbuseRuntimeEnv,
  handleConsoleAbuseListRequest,
} from "./_shared.ts";

export const ALL: APIRoute = ({ request }) =>
  handleConsoleAbuseListRequest(request, buildConsoleAbuseRuntimeEnv(env));
