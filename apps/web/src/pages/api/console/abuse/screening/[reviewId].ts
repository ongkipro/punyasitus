import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleConsoleScreeningDetailRequest } from "../_screening-shared.ts";
import { buildConsoleAbuseRuntimeEnv } from "../_shared.ts";

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleScreeningDetailRequest(
    params.reviewId ?? "",
    request,
    buildConsoleAbuseRuntimeEnv(env),
  );
