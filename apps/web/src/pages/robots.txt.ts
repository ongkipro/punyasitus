import type { APIRoute } from "astro";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleRobotsTxtRequest,
} from "./sitemaps/_shared.ts";

export { handleRobotsTxtRequest };

export const GET: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
