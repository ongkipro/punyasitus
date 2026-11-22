import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleJobsHealthProbe } from "./probe-helpers.ts";

export { handleJobsHealthProbe };

export const GET: APIRoute = async () => {
  return handleJobsHealthProbe({
    platformDb: env.PLATFORM_DB,
  });
};
