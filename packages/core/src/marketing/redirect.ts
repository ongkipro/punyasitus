import { normalizeHost, PLATFORM_HOSTS } from "../index.ts";

/**
 * Canonical marketing host redirect & origin guards (REQ-087, PLAN §3.3 & §19.5).
 *
 * Security invariants:
 * - Never reads `X-Forwarded-Host`, `Host` override headers, or untrusted redirect params.
 * - Redirects `www.<platformDomain>` -> `308` -> `https://<platformDomain><path><query>`.
 * - Rejects open-redirect payloads (`//evil.com`, backslashes, CRLF/control characters,
 *   userinfo `@`, non-http(s) schemes) before constructing any `Location` header.
 */

export type MarketingHostRedirectResult =
  | {
      readonly redirect: true;
      readonly status: 308;
      readonly location: string;
    }
  | {
      readonly redirect: false;
      readonly reason: "apex" | "other_host" | "invalid_url";
    };

const CONTROL_CHARS_RE = /\p{Cc}/u;

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function sanitizeRedirectPathname(rawPathname: string): string {
  if (!rawPathname || rawPathname.includes("\\") || CONTROL_CHARS_RE.test(rawPathname)) {
    return "/";
  }
  // Collapse leading multiple slashes so `//evil.com/path` can NEVER become a protocol-relative open redirect.
  const collapsed = rawPathname.replace(/^\/+/, "/");
  if (!collapsed.startsWith("/")) {
    return `/${collapsed}`;
  }
  return collapsed;
}

function sanitizeRedirectSearch(rawSearch: string): string {
  if (!rawSearch) return "";
  if (CONTROL_CHARS_RE.test(rawSearch) || rawSearch.includes("\\")) {
    return "";
  }
  return rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`;
}

/**
 * Resolves whether a request URL targeting `www.<platformDomain>` must be redirected
 * with HTTP `308 Permanent Redirect` to canonical apex `https://<platformDomain><path><query>`.
 */
export function resolveMarketingHostRedirect(
  requestUrl: string | URL,
  options?: { readonly platformDomain?: string },
): MarketingHostRedirectResult {
  const rawInput = typeof requestUrl === "string" ? requestUrl : requestUrl.toString();
  if (!rawInput || CONTROL_CHARS_RE.test(rawInput)) {
    return { redirect: false, reason: "invalid_url" };
  }

  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { redirect: false, reason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { redirect: false, reason: "invalid_url" };
  }

  // Reject credential-bearing URLs (`https://www.punyasitus.com@evil.com/...`)
  if (url.username !== "" || url.password !== "") {
    return { redirect: false, reason: "invalid_url" };
  }

  const normalizedRequestHost = normalizeHost(url.hostname);
  if (!normalizedRequestHost) {
    return { redirect: false, reason: "invalid_url" };
  }

  const platformDomain = normalizeHost(options?.platformDomain) ?? PLATFORM_HOSTS.marketing;
  const wwwHost = `www.${platformDomain}`;

  if (normalizedRequestHost === platformDomain) {
    return { redirect: false, reason: "apex" };
  }

  if (normalizedRequestHost !== wwwHost) {
    return { redirect: false, reason: "other_host" };
  }

  const safePath = sanitizeRedirectPathname(url.pathname);
  const safeSearch = sanitizeRedirectSearch(url.search);
  const location = `https://${platformDomain}${safePath}${safeSearch}`;

  // Final defense-in-depth verification that target host & protocol cannot escape apex.
  try {
    const parsedTarget = new URL(location);
    if (parsedTarget.protocol !== "https:" || parsedTarget.hostname !== platformDomain) {
      return { redirect: false, reason: "invalid_url" };
    }
  } catch {
    return { redirect: false, reason: "invalid_url" };
  }

  return {
    redirect: true,
    status: 308,
    location,
  };
}

/**
 * Convenience helper for Astro marketing routes: returns a `308` Response when the request
 * arrived on `www.<platformDomain>`, or `null` when normal rendering should proceed.
 * Never sets cookies.
 */
export function createMarketingHostRedirectResponse(
  request: Request,
  options?: { readonly platformDomain?: string },
): Response | null {
  const decision = resolveMarketingHostRedirect(request.url, options);
  if (!decision.redirect) return null;
  return new Response(null, {
    status: decision.status,
    headers: {
      Location: decision.location,
      "Cache-Control": "public, max-age=300",
      "X-PunyaSitus-Surface": "marketing",
    },
  });
}

/**
 * Validates that a cookieless funnel POST request arrived on the canonical marketing host
 * (or local loopback during dev/test) AND carries a valid same-origin signal (`Origin` matching
 * the marketing host, or `Sec-Fetch-Site: same-origin`). Requests with neither header or with a
 * cross-site signal are rejected to prevent anonymous cross-origin / script flooding.
 */
export function validateMarketingFunnelOrigin(
  request: Request,
  options?: { readonly platformDomain?: string; readonly allowLocalLoopback?: boolean },
): boolean {
  let reqUrl: URL;
  try {
    reqUrl = new URL(request.url);
  } catch {
    return false;
  }

  const allowLoopback = options?.allowLocalLoopback ?? false;
  const platformDomain = normalizeHost(options?.platformDomain) ?? PLATFORM_HOSTS.marketing;

  const isLocalReq = allowLoopback && isLoopbackHost(reqUrl.hostname);
  const normalizedReqHost = normalizeHost(reqUrl.hostname);
  const isApexReq = normalizedReqHost === platformDomain;

  if (!isLocalReq && !isApexReq) {
    return false;
  }

  const originHeader = request.headers.get("origin");
  const rawSecFetchSite = request.headers.get("sec-fetch-site");
  const secFetchSite = rawSecFetchSite !== null ? rawSecFetchSite.trim().toLowerCase() : null;

  // Reject cross-site browser requests explicitly.
  if (secFetchSite !== null && secFetchSite !== "same-origin") {
    return false;
  }

  // Require either a valid same-origin `Origin` header OR `Sec-Fetch-Site: same-origin`.
  if (originHeader === null) {
    return secFetchSite === "same-origin";
  }

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }

  if (isLocalReq) {
    return isLoopbackHost(originUrl.hostname) && originUrl.port === reqUrl.port;
  }

  const normalizedOriginHost = normalizeHost(originUrl.hostname);
  return originUrl.protocol === "https:" && normalizedOriginHost === platformDomain;
}
