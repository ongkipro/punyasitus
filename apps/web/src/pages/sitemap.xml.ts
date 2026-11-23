import type { APIRoute } from "astro";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleSitemapIndexRequest,
} from "./sitemaps/_shared.ts";

export { handleSitemapIndexRequest };

export const GET: APIRoute = async ({ request, locals }) => {
  return handleSitemapIndexRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleSitemapIndexRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
