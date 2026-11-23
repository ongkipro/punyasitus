import { normalizeHost } from "@punyasitus/core";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  FACETED_FILTER_DISALLOW_PATTERNS,
  generateTenantRobotsTxt,
  isPathAllowedByRobotsTxt,
  LLMS_TXT_GENERATION_ENABLED,
} from "@punyasitus/core/seo/robots";
import { createTenantDb, openTenantStoreStub } from "@punyasitus/db/connections";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import type { APIRoute } from "astro";
import {
  buildAutopilotRobotsTxt,
  buildMinimalFallbackRobotsTxt,
  checkSeoAutopilotActiveInTenantDb,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
} from "../../../../packages/plugins/seo-ai-autopilot/index.ts";
import { CACHE_VERSION_HEADER_NAME } from "../core/cache.ts";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  DISCOVERY_CACHE_MAX_AGE_SECONDS,
  handleRobotsTxtRequest as baseHandleRobotsTxtRequest,
  type DiscoveryHandlerDeps,
} from "./sitemaps/_shared.ts";

/**
 * Tenant-Scoped AI-Aware `/robots.txt` Endpoint (`REQ-095`, `REQ-102`, `DEC-039`, `PLAN §15.1 & §15.7`).
 *
 * - When `seo-ai-autopilot` is active: serves the full AI-split policy (9 search/answer bots
 *   allowed, 4 training bots per owner toggle, faceted filter disallows, canonical `Sitemap:`).
 * - When `seo-ai-autopilot` is disabled on an active indexable paid site: emits the clean minimal
 *   fallback (`User-agent: *`, `Allow: /`, private path disallows — NO `Sitemap:`, NO AI bot split)
 *   with freshly constructed explicit headers.
 * - When `TenantStore` raises a DB error: fails **CLOSED** with `503` (`User-agent: *\nDisallow: /\n`,
 *   `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Retry-After: 60`).
 * - Mandatory safety rules (`trial`, `noindex`, `suspended`, `recovery`, unknown/platform hosts)
 *   ALWAYS remain intact regardless of plugin state.
 */

export {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  buildAutopilotRobotsTxt,
  buildMinimalFallbackRobotsTxt,
  FACETED_FILTER_DISALLOW_PATTERNS,
  generateTenantRobotsTxt,
  isPathAllowedByRobotsTxt,
  LLMS_TXT_GENERATION_ENABLED,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
};

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8" as const;
const ROBOTS_FAIL_CLOSED_BODY = "User-agent: *\nDisallow: /\n" as const;

async function resolveTenantDbForRobots(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<D1Database | null> {
  if (deps.tenantDb) return deps.tenantDb;
  if (deps.tenant && deps.tenantStore) {
    try {
      return createTenantDb(openTenantStoreStub(deps.tenantStore, deps.tenant.id));
    } catch {
      return null;
    }
  }
  if (!deps.platformDb || !deps.tenantStore) return null;
  try {
    const url = new URL(request.url);
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    const resolution = await resolveTenantByHost(deps.platformDb, host, {
      nowMs: deps.nowMs,
      bypassCache: deps.bypassHostCache,
    });
    if (resolution.kind !== "resolved") return null;
    return createTenantDb(openTenantStoreStub(deps.tenantStore, resolution.tenant.id));
  } catch {
    return null;
  }
}

export async function handleRobotsTxtRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const baseResponse = await baseHandleRobotsTxtRequest(request, deps);

  // Never alter `trial`/`noindex` (`X-Robots-Tag: noindex, nofollow`), `503` suspended,
  // `301` alias, `404` unknown host, or `marketing`/`app`/`console` platform surfaces.
  if (
    baseResponse.status !== 200 ||
    deps.surface === "marketing" ||
    deps.surface === "app" ||
    deps.surface === "console" ||
    baseResponse.headers.get("X-Robots-Tag")?.toLowerCase().includes("noindex")
  ) {
    return baseResponse;
  }

  const tenantDb = await resolveTenantDbForRobots(request, deps);
  if (!tenantDb) {
    return baseResponse;
  }

  const isHead = request.method.toUpperCase() === "HEAD";
  const pluginCheck = await checkSeoAutopilotActiveInTenantDb(tenantDb);

  // Fail closed on TenantStore DB error: never serve full AI-split robots or Sitemap
  if (!pluginCheck.ok) {
    return new Response(isHead ? null : ROBOTS_FAIL_CLOSED_BODY, {
      status: 503,
      headers: {
        "Content-Type": TEXT_CONTENT_TYPE,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Retry-After": "60",
        Vary: "Host",
      },
    });
  }

  if (pluginCheck.active) {
    return baseResponse;
  }

  // Disabled path: construct fresh explicit headers (never reuse stale headers/ETag from baseResponse)
  const headers = new Headers({
    "Content-Type": TEXT_CONTENT_TYPE,
    "Cache-Control": `public, max-age=${DISCOVERY_CACHE_MAX_AGE_SECONDS}, s-maxage=${DISCOVERY_CACHE_MAX_AGE_SECONDS}`,
    Vary: "Host, Accept-Encoding",
  });
  const cacheVersion = baseResponse.headers.get(CACHE_VERSION_HEADER_NAME);
  if (cacheVersion) {
    headers.set(CACHE_VERSION_HEADER_NAME, cacheVersion);
  }

  return new Response(isHead ? null : buildMinimalFallbackRobotsTxt(), {
    status: 200,
    headers,
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleRobotsTxtRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
