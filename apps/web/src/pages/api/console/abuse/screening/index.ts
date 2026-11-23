import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleConsoleScreeningListRequest } from "../_screening-shared.ts";
import { buildConsoleAbuseRuntimeEnv } from "../_shared.ts";

export const ALL: APIRoute = ({ request }) =>
  handleConsoleScreeningListRequest(request, buildConsoleAbuseRuntimeEnv(env));
