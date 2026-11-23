import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleAbuseRuntimeEnv,
  handleConsoleAbuseDetailRequest,
} from "./_shared.ts";

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleAbuseDetailRequest(
    params.reportId ?? "",
    request,
    buildConsoleAbuseRuntimeEnv(env),
  );
