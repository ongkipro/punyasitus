import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleDbHealthProbe } from "./probe-helpers.ts";

export { handleDbHealthProbe };

export const GET: APIRoute = async () => {
  return handleDbHealthProbe({
    platformDb: env.PLATFORM_DB,
  });
};
