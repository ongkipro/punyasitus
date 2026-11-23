import { env } from "cloudflare:workers";
import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  DomainMarkerConfigError,
  TENANT_DOMAIN_MARKER_HEADER,
  computeTenantDomainMarker,
  resolveDomainMarkerSecret,
} from "@punyasitus/core/domains/index";
import {
  isTenantServingStatus,
  resolveTenantByHost,
} from "@punyasitus/db/routing/index";
import type { APIRoute } from "astro";

/**
 * Tenant-host signed domain-ownership marker endpoint:
 * `GET /.well-known/punyasitus-domain-check` (REQ-004, PLAN §3.1 & §12.2).
 *
 * Security & isolation invariants:
 * - Resolves tenant strictly from `request.url` Host via TASK-002 `resolveTenantByHost`
 *   (NEVER trusts `X-Forwarded-Host`, query params, or cookies).
 * - Returns neutral `404` on platform hosts (`punyasitus.com`, `app.`, `console.`, SaaS apex),
 *   unknown/pending/failed/moved/quarantined hosts, and non-serving tenants (`suspended`, etc.).
 * - Fails closed with `503 DOMAIN_MARKER_SECRET_UNCONFIGURED` when dedicated `DOMAIN_MARKER_SECRET`
 *   is missing or `< 32` characters outside `local`/`test`.
 * - Always emits `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and ZERO cookies.
 */

export interface DomainMarkerEndpointEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly DOMAIN_MARKER_SECRET?: string;
}

export interface HandleDomainMarkerOptions {
  readonly nowMs?: number;
  readonly testMarkerSecret?: string;
}

const NO_STORE_MARKER_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function jsonNoCookieResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(NO_STORE_MARKER_HEADERS);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function isPlatformOrZoneRootHost(
  host: string,
  platformDomain: string,
  saasZone: string,
): boolean {
  return (
    host === platformDomain ||
    host === `www.${platformDomain}` ||
    host === `app.${platformDomain}` ||
    host === `console.${platformDomain}` ||
    host.endsWith(`.${platformDomain}`) ||
    host === saasZone ||
    host === `www.${saasZone}`
  );
}

export async function handleDomainMarkerRequest(
  request: Request,
  runtimeEnv: DomainMarkerEndpointEnv,
  options: HandleDomainMarkerOptions = {},
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return jsonNoCookieResponse(
      405,
      { error: { code: "BAD_REQUEST", message: "Method not allowed." } },
      { Allow: "GET" },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return jsonNoCookieResponse(404, { error: { code: "NOT_FOUND" } });
  }

  const normalizedHost = normalizeHost(parsedUrl.hostname);
  if (!normalizedHost) {
    return jsonNoCookieResponse(404, { error: { code: "NOT_FOUND" } });
  }

  const platformDomain = normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const saasZone = normalizeHost(runtimeEnv.SAAS_ZONE) ?? PLATFORM_HOSTS.saasZone;
  if (isPlatformOrZoneRootHost(normalizedHost, platformDomain, saasZone)) {
    return jsonNoCookieResponse(404, { error: { code: "NOT_FOUND" } });
  }

  const resolution = await resolveTenantByHost(runtimeEnv.PLATFORM_DB, normalizedHost, {
    nowMs: options.nowMs,
    bypassCache: true,
  });

  if (resolution.kind === "db_unavailable") {
    return jsonNoCookieResponse(
      503,
      { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." } },
      { "Retry-After": "60" },
    );
  }

  if (resolution.kind !== "resolved" || !isTenantServingStatus(resolution.tenant.effectiveStatus)) {
    return jsonNoCookieResponse(404, { error: { code: "NOT_FOUND" } });
  }

  let secret: string;
  try {
    secret = resolveDomainMarkerSecret(runtimeEnv, {
      testMarkerSecret: options.testMarkerSecret,
    });
  } catch (err) {
    if (err instanceof DomainMarkerConfigError) {
      return jsonNoCookieResponse(503, {
        error: {
          code: err.code,
          reasonCode: err.reasonCode,
          message: err.message,
        },
      });
    }
    throw err;
  }

  const marker = await computeTenantDomainMarker(
    resolution.tenant.id,
    resolution.hostRecord.host,
    secret,
  );

  return jsonNoCookieResponse(
    200,
    {
      tenantId: resolution.tenant.id,
      host: resolution.hostRecord.host,
      marker,
    },
    { [TENANT_DOMAIN_MARKER_HEADER]: marker },
  );
}

function buildMarkerRuntimeEnv(): DomainMarkerEndpointEnv {
  const runtimeEnv = env as typeof env & { readonly DOMAIN_MARKER_SECRET?: string };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    DOMAIN_MARKER_SECRET: runtimeEnv.DOMAIN_MARKER_SECRET,
  };
}

export const GET: APIRoute = ({ request }) =>
  handleDomainMarkerRequest(request, buildMarkerRuntimeEnv());

export const ALL: APIRoute = ({ request }) =>
  handleDomainMarkerRequest(request, buildMarkerRuntimeEnv());
