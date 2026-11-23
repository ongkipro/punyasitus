import {
  DEFAULT_STATUS_PAGE_URL,
  listActiveBannerIncidents,
  type PublicIncidentBannerItem,
} from "@punyasitus/db/incidents/index";

export type { PublicIncidentBannerItem };

const CF_WORKERS_SPECIFIER = `${"cloudflare"}:workers`;

/**
 * Resolves `PLATFORM_DB` without a static `cloudflare:workers` import so
 * standalone Node Astro harnesses (e.g. preview E2E builds) compile cleanly
 * while Cloudflare Workers (`workerd`) resolve `env.PLATFORM_DB` at runtime.
 */
export async function resolvePlatformDbFromRuntime(
  locals: unknown,
): Promise<D1Database | null> {
  try {
    const rec = locals as { platformDb?: D1Database } | null | undefined;
    if (rec?.platformDb) return rec.platformDb;
  } catch {
    // ignore getter errors on non-standard locals proxies
  }
  try {
    const cf = (await import(/* @vite-ignore */ CF_WORKERS_SPECIFIER)) as {
      env?: { PLATFORM_DB?: D1Database };
    };
    return cf.env?.PLATFORM_DB ?? null;
  } catch {
    return null;
  }
}

/**
 * Read-only server loader for tenant dashboard pages (`app.punyasitus.com`).
 * Returns sanitized active banner incidents without leaking private console
 * operator metadata, audit logs, or internal DB errors.
 */
export async function loadActiveDashboardIncidentBanner(
  platformDb: D1Database | null | undefined,
  options: { readonly statusPageUrl?: string } = {},
): Promise<readonly PublicIncidentBannerItem[]> {
  if (!platformDb) return [];
  try {
    return await listActiveBannerIncidents(platformDb, {
      statusPageUrl: options.statusPageUrl ?? DEFAULT_STATUS_PAGE_URL,
      limit: 5,
    });
  } catch {
    return [];
  }
}
