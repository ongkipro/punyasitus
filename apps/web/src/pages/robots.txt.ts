import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  generateTenantRobotsTxt,
  isPathAllowedByRobotsTxt,
  LLMS_TXT_GENERATION_ENABLED,
} from "@punyasitus/core/seo/robots";
import type { APIRoute } from "astro";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleRobotsTxtRequest,
} from "./sitemaps/_shared.ts";

export {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  generateTenantRobotsTxt,
  handleRobotsTxtRequest,
  isPathAllowedByRobotsTxt,
  LLMS_TXT_GENERATION_ENABLED,
};

export const GET: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
