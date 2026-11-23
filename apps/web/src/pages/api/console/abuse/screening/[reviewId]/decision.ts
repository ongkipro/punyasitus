import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleConsoleScreeningDecisionRequest } from "../../_screening-shared.ts";
import { buildConsoleAbuseRuntimeEnv } from "../../_shared.ts";

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleScreeningDecisionRequest(
    params.reviewId ?? "",
    request,
    buildConsoleAbuseRuntimeEnv(env),
  );
