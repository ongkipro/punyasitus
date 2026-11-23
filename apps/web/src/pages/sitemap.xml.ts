import { normalizeHost } from "@punyasitus/core";
import { createTenantDb, openTenantStoreStub } from "@punyasitus/db/connections";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import type { APIRoute } from "astro";
import {
  checkSeoAutopilotActiveInTenantDb,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
} from "../../../../packages/plugins/seo-ai-autopilot/index.ts";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleSitemapIndexRequest as baseHandleSitemapIndexRequest,
  type DiscoveryHandlerDeps,
} from "./sitemaps/_shared.ts";

/**
 * Tenant-Scoped XML Sitemap Index Endpoint (`GET /sitemap.xml`; REQ-024, REQ-066, REQ-102).
 *
 * Powered by the official free `seo-ai-autopilot` plugin (`packages/plugins/seo-ai-autopilot`):
 * - Active by default on newly provisioned paid websites (`DEC-042`) with zero configuration.
 * - Immediately returns `404` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`)
 *   whenever `seo-ai-autopilot` is disabled on the tenant.
 * - Fails **CLOSED** with `503` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`)
 *   if `TenantStore` raises a DB error — never fails open to serving tenant URLs.
 */

export { SEO_AI_AUTOPILOT_PLUGIN_ID };

const XML_CONTENT_TYPE = "application/xml; charset=utf-8" as const;

async function resolveServingTenantDbForSitemap(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<D1Database | null> {
  if (
    deps.surface === "marketing" ||
    deps.surface === "app" ||
    deps.surface === "console" ||
    deps.surface === "unknown"
  ) {
    return null;
  }
  if (deps.tenant) {
    const effectiveStatus = deps.tenant.operatorHold ? "suspended" : deps.tenant.status;
    if (
      effectiveStatus === "suspended" ||
      effectiveStatus === "recovery" ||
      effectiveStatus === "provisioning" ||
      effectiveStatus === "purging" ||
      effectiveStatus === "purged"
    ) {
      return null;
    }
    if (!deps.tenant.isPrimary) {
      return null;
    }
    if (deps.tenantDb) return deps.tenantDb;
    if (deps.tenantStore) {
      try {
        return createTenantDb(openTenantStoreStub(deps.tenantStore, deps.tenant.id));
      } catch {
        return null;
      }
    }
    return null;
  }

  if (deps.tenantDb) return deps.tenantDb;
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
    const effectiveStatus = resolution.tenant.operatorHold
      ? "suspended"
      : resolution.tenant.effectiveStatus;
    if (
      effectiveStatus === "suspended" ||
      effectiveStatus === "recovery" ||
      effectiveStatus === "provisioning" ||
      effectiveStatus === "purging" ||
      effectiveStatus === "purged" ||
      !resolution.hostRecord.isPrimary
    ) {
      return null;
    }
    return createTenantDb(openTenantStoreStub(deps.tenantStore, resolution.tenant.id));
  } catch {
    return null;
  }
}

export async function handleSitemapIndexRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const isHead = request.method.toUpperCase() === "HEAD";
  const tenantDb = await resolveServingTenantDbForSitemap(request, deps);

  if (tenantDb) {
    const pluginCheck = await checkSeoAutopilotActiveInTenantDb(tenantDb);
    if (!pluginCheck.ok) {
      return new Response(isHead ? null : "", {
        status: 503,
        headers: {
          "Content-Type": XML_CONTENT_TYPE,
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Retry-After": "60",
        },
      });
    }
    if (!pluginCheck.active) {
      return new Response(isHead ? null : "", {
        status: 404,
        headers: {
          "Content-Type": XML_CONTENT_TYPE,
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

  return baseHandleSitemapIndexRequest(request, deps);
}

export const GET: APIRoute = async ({ request, locals }) => {
  return handleSitemapIndexRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleSitemapIndexRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
