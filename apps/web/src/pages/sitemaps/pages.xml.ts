import type { APIRoute } from "astro";
import { readDiscoveryDepsFromAstroLocals } from "./_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleSubSitemapRequest,
} from "./_shared.ts";

export const GET: APIRoute = async ({ request, locals }) => {
  return handleSubSitemapRequest(request, "pages", readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleSubSitemapRequest(request, "pages", readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
