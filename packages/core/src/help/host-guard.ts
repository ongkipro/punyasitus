import { normalizeHost, PLATFORM_HOSTS, type SurfaceKind } from "../index.ts";
import { createMarketingHostRedirectResponse } from "../marketing/redirect.ts";

/**
 * Marketing-host gating for Help Center routes (`/marketing/bantuan/**`, REQ-104, TASK-104).
 *
 * Security & Isolation Invariants:
 * - Redirects `www.<platformDomain>` -> `308` -> `https://<platformDomain><path><query>` (zero cookies).
 * - Allows canonical marketing apex (`punyasitus.com`) and local loopback (`127.0.0.1`/`localhost`)
 *   strictly when `appEnv === "local" || appEnv === "test"`.
 * - Rejects ALL tenant hosts (`*.situsku.click`, custom tenant domains), `app.*`, `console.*`,
 *   and unknown hosts with a neutral `404` carrying zero tenant data and `default-src 'none'` CSP.
 */

export interface GuardMarketingHelpHostOptions {
  readonly appEnv?: string;
  readonly platformDomain?: string;
  readonly localsSurface?: SurfaceKind;
  readonly hasTenantContext?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function createNeutralHelpNotFoundResponse(surface: SurfaceKind): Response {
  const html =
    '<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>';
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'",
      "X-PunyaSitus-Surface": surface,
    },
  });
}

/**
 * Returns a `Response` (308 redirect or neutral 404) when the request must NOT be served
 * by the Help Center, or `null` when it is safely authorized on the marketing host.
 */
export function guardMarketingHelpHost(
  request: Request,
  options: GuardMarketingHelpHostOptions = {},
): Response | null {
  // 1. Canonical `www.<platformDomain>` -> 308 apex redirect (consistent with TASK-087).
  const wwwRedirect = createMarketingHostRedirectResponse(request, {
    platformDomain: options.platformDomain,
  });
  if (wwwRedirect) {
    return wwwRedirect;
  }

  // 2. Never serve Help Center routes when middleware resolved a tenant context.
  if (options.hasTenantContext || options.localsSurface === "tenant") {
    return createNeutralHelpNotFoundResponse("tenant");
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return createNeutralHelpNotFoundResponse("unknown");
  }

  // 3. Explicit local loopback dev/test mode only.
  const isLocalOrTest = options.appEnv === "local" || options.appEnv === "test";
  if (isLocalOrTest && isLoopbackHostname(url.hostname)) {
    return null;
  }

  // 4. Strictly require canonical marketing apex host (`punyasitus.com`).
  const platformDomain = normalizeHost(options.platformDomain) ?? PLATFORM_HOSTS.marketing;
  const requestHost = normalizeHost(url.hostname);
  if (requestHost === platformDomain) {
    return null;
  }

  return createNeutralHelpNotFoundResponse(options.localsSurface ?? "unknown");
}
