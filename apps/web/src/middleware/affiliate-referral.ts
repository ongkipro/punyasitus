import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  AFFILIATE_COOKIE_NAME,
  buildAffiliateSetCookieHeader,
  createSignedAffiliateCookieValue,
  parseAffiliateReferralQueryParam,
  readVerifiedAffiliateCookieFromHeader,
} from "@punyasitus/core/affiliates/index";
import { recordAffiliateFunnelVisit } from "@punyasitus/db/affiliates/index";
import type { AuthMiddlewareContext } from "./auth.ts";

/**
 * First-party `?ref=<code>` marketing attribution cookie middleware
 * (`apps/web/src/middleware/affiliate-referral.ts`; REQ-084, PLAN §19.4, TASK-084).
 *
 * Security & privacy invariants:
 * - Captures `?ref=<code>` ONLY on the `marketing` surface (`punyasitus.com`, or local
 *   loopback in `APP_ENV === "local"` on non-API GET/HEAD paths). NEVER sets referral cookies
 *   on tenant hosts (`*.situsku.click` / custom domains), `console`, or `app` surfaces.
 * - Sets a first-party HMAC-SHA256 signed `ps_ref` cookie (`HttpOnly; Secure; SameSite=Lax;
 *   Path=/; Max-Age=2592000; Domain=punyasitus.com`) containing zero visitor PII so
 *   `app.punyasitus.com` signup reads it cleanly.
 * - Prefers dedicated `AFFILIATE_COOKIE_SECRET` (fallback `AUTH_SECRET`); dev fallback is
 *   strictly restricted to `APP_ENV === "local"` (fails closed otherwise).
 * - Preserves an existing valid unexpired first-touch cookie (never extends 30-day TTL on reloads).
 * - Marks responses carrying `Set-Cookie` as `Cache-Control: private, no-store` to prevent
 *   edge/proxy cache poisoning.
 * - Increments cookieless daily aggregate visit counts (`affiliate_funnel_visits`) ONLY when
 *   issuing a new cookie (not on repeat GETs with an existing valid cookie), scheduled via
 *   `waitUntil` when provided so marketing GET latency is never blocked.
 */

const LOCAL_DEV_AFFILIATE_COOKIE_SECRET =
  "local-dev-app-punyasitus-auth-secret-0123456789abcdef";

export interface AffiliateReferralMiddlewareEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly AFFILIATE_COOKIE_SECRET?: string;
  readonly AUTH_SECRET?: string;
}

export interface AffiliateReferralMiddlewareOptions {
  readonly nowMs?: number;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Resolves the HMAC signing secret for `ps_ref` cookies.
 * Prefers `AFFILIATE_COOKIE_SECRET`, falls back to `AUTH_SECRET`, and restricts the
 * hardcoded local-dev fallback strictly to `APP_ENV === "local"` (fails closed in test/staging/prod).
 */
export function resolveAffiliateCookieSecret(
  env: AffiliateReferralMiddlewareEnv,
): string | null {
  const dedicated = env.AFFILIATE_COOKIE_SECRET?.trim();
  if (dedicated && dedicated.length >= 32) {
    return dedicated;
  }
  const authSecret = env.AUTH_SECRET?.trim();
  if (authSecret && authSecret.length >= 32) {
    return authSecret;
  }
  if (env.APP_ENV === "local") {
    return LOCAL_DEV_AFFILIATE_COOKIE_SECRET;
  }
  return null;
}

function isGetOrHeadMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

export async function executeAffiliateReferralMiddleware(
  context: AuthMiddlewareContext,
  next: () => Promise<Response>,
  env: AffiliateReferralMiddlewareEnv,
  options: AffiliateReferralMiddlewareOptions = {},
): Promise<Response> {
  if (!isGetOrHeadMethod(context.request.method)) {
    return next();
  }

  const isMarketingSurface =
    context.locals.surface === "marketing" && context.locals.tenant === null;
  if (!isMarketingSurface) {
    return next();
  }

  let url: URL;
  try {
    url = new URL(context.request.url);
  } catch {
    return next();
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return next();
  }

  const parsedRef = parseAffiliateReferralQueryParam(url.searchParams);
  if (!parsedRef) {
    return next();
  }

  const secret = resolveAffiliateCookieSecret(env);
  if (!secret) {
    return next();
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // Preserve an existing valid unexpired first-touch cookie so reloads cannot stretch 30-day TTL
  // or inflate cookieless visit counts.
  const existingCookie = await readVerifiedAffiliateCookieFromHeader({
    cookieHeader: context.request.headers.get("cookie"),
    secret,
    cookieName: AFFILIATE_COOKIE_NAME,
    nowMs,
  });

  if (existingCookie.valid) {
    return next();
  }

  // Best-effort cookieless aggregate funnel visit counter ONLY when setting a new cookie.
  // Scheduled via `waitUntil` when available so GET latency is never blocked.
  if (env.PLATFORM_DB) {
    const db = env.PLATFORM_DB;
    const visitPromise = recordAffiliateFunnelVisit(db, parsedRef.referralCode, nowMs).catch(
      () => undefined,
    );
    if (options.waitUntil) {
      options.waitUntil(visitPromise);
    } else {
      await visitPromise;
    }
  }

  const response = await next();

  const signedValue = await createSignedAffiliateCookieValue({
    referralCode: parsedRef.referralCode,
    source: parsedRef.source,
    secret,
    nowMs,
  });

  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const isLocalLoopback = context.locals.isLocalLoopback;
  const setCookieHeader = buildAffiliateSetCookieHeader({
    value: signedValue,
    cookieName: AFFILIATE_COOKIE_NAME,
    domain: isLocalLoopback ? null : platformDomain,
    secure: isLocalLoopback ? url.protocol === "https:" : true,
  });

  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", setCookieHeader);
  headers.set("Cache-Control", "private, no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
