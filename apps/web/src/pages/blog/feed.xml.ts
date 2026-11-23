import type { APIRoute } from "astro";
import { readDiscoveryDepsFromAstroLocals } from "../sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleBlogFeedRequest,
} from "../sitemaps/_shared.ts";

export { handleBlogFeedRequest };

export const GET: APIRoute = async ({ request, locals }) => {
  return handleBlogFeedRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleBlogFeedRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
