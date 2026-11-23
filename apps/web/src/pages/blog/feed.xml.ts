import { normalizeHost } from "@punyasitus/core";
import { createTenantDb, openTenantStoreStub } from "@punyasitus/db/connections";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import type { APIRoute } from "astro";
import {
  checkSeoAutopilotActiveInTenantDb,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
} from "../../../../../packages/plugins/seo-ai-autopilot/index.ts";
import { readDiscoveryDepsFromAstroLocals } from "../sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  handleBlogFeedRequest as baseHandleBlogFeedRequest,
  type DiscoveryHandlerDeps,
} from "../sitemaps/_shared.ts";

/**
 * Tenant-Scoped Blog RSS 2.0 Feed Endpoint (`GET /blog/feed.xml`; REQ-024, REQ-066, REQ-102).
 *
 * - Active when both `blogEnabled === true` AND `seo-ai-autopilot` is enabled.
 * - Returns `404` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) when either
 *   the tenant's blog feature or the `seo-ai-autopilot` plugin is disabled.
 * - Fails **CLOSED** with `503` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`)
 *   on TenantStore DB error — never fails open to serving RSS.
 * - Preserves `503` for `suspended`/`recovery` tenants and `301` alias redirects cleanly.
 */

export { SEO_AI_AUTOPILOT_PLUGIN_ID };

const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8" as const;

async function resolveServingTenantDbForBlogFeed(
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
      effectiveStatus === "purged" ||
      !deps.tenant.isPrimary
    ) {
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

export async function handleBlogFeedRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const isHead = request.method.toUpperCase() === "HEAD";
  const tenantDb = await resolveServingTenantDbForBlogFeed(request, deps);

  if (tenantDb) {
    const pluginCheck = await checkSeoAutopilotActiveInTenantDb(tenantDb);
    if (!pluginCheck.ok) {
      return new Response(isHead ? null : "", {
        status: 503,
        headers: {
          "Content-Type": RSS_CONTENT_TYPE,
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
          "Content-Type": RSS_CONTENT_TYPE,
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

  return baseHandleBlogFeedRequest(request, deps);
}

export const GET: APIRoute = async ({ request, locals }) => {
  return handleBlogFeedRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const HEAD: APIRoute = async ({ request, locals }) => {
  return handleBlogFeedRequest(request, readDiscoveryDepsFromAstroLocals(locals));
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
