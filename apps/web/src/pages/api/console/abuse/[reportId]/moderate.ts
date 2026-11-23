import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
  buildConsoleAbuseRuntimeEnv,
  handleConsoleAbuseModerateRequest,
} from "../_shared.ts";

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleAbuseModerateRequest(
    params.reportId ?? "",
    request,
    buildConsoleAbuseRuntimeEnv(env),
  );
