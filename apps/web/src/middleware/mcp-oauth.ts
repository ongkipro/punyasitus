import {
  exchangeMcpOAuthToken,
  handleMcpTokenRevocation,
  validateMcpAuthorizeRequest,
} from "@punyasitus/auth/mcp/index";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  type FetchCimdOptions,
} from "@punyasitus/core/mcp/index";
import { consumeMcpAuthorizeRateLimit } from "@punyasitus/db/mcp/index";
import { generatePlatformAuditId } from "@punyasitus/db/platform";
import type { SurfaceKind } from "@punyasitus/core";
import {
  normalizeMiddlewarePathname,
  resolvePlatformAuthHostContext,
  type AuthRuntimeEnv,
} from "./auth.ts";

/**
 * Admin-host-only OAuth 2.1 discovery & protocol endpoint handler for the Tenant MCP Server
 * (`apps/web/src/middleware/mcp-oauth.ts`; REQ-076, ADR-0008, PLAN §18.3, TASK-075).
 *
 * Exposes on `app.punyasitus.com` (or local loopback in `APP_ENV === "local"`):
 * - `GET  /.well-known/oauth-protected-resource` (+ `/mcp` suffix) — RFC 9728
 * - `GET  /.well-known/oauth-authorization-server`                 — RFC 8414
 * - `GET  /oauth2/authorize`                                       — OAuth 2.1 + PKCE + RFC 8707 + CIMD
 * - `POST /oauth2/token`                                           — authorization_code & rotating refresh_token
 * - `POST /oauth2/revoke`                                          — RFC 7009 immediate grant revocation
 * - `POST /oauth2/register`                                        — 403 disabled (CIMD preferred, DCR off)
 *
 * Returns neutral `404` on tenant hosts, marketing host, and console host.
 */

export interface McpOAuthProtocolOptions extends FetchCimdOptions {
  readonly nowMs?: number;
  readonly authorizePerCallerPerMinute?: number;
  readonly authorizeGlobalPerMinute?: number;
}

function oauthJsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Robots-Tag": "noindex, nofollow",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function neutralNotFoundResponse(surface: SurfaceKind | "unknown"): Response {
  return new Response(JSON.stringify({ success: false, code: "NOT_FOUND" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'",
      "X-PunyaSitus-Surface": surface,
    },
  });
}

async function parseOAuthFormOrJsonParams(request: Request): Promise<URLSearchParams | null> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    const raw = await request.text();
    if (contentType.includes("application/json")) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") {
          params.set(k, v);
        }
      }
      return params;
    }
    return new URLSearchParams(raw);
  } catch {
    return null;
  }
}

export function isMcpOAuthHandledPath(pathnameLower: string): boolean {
  return (
    pathnameLower === "/.well-known/oauth-protected-resource" ||
    pathnameLower === "/.well-known/oauth-protected-resource/mcp" ||
    pathnameLower === "/.well-known/oauth-authorization-server" ||
    pathnameLower === "/oauth2/authorize" ||
    pathnameLower === "/oauth2/token" ||
    pathnameLower === "/oauth2/revoke" ||
    pathnameLower === "/oauth2/register"
  );
}

/**
 * Handles MCP OAuth 2.1 discovery and protocol endpoints.
 * Returns `null` when the pathname is not an OAuth protocol path.
 */
export async function handleMcpOAuthProtocolRequest(
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: McpOAuthProtocolOptions = {},
): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return neutralNotFoundResponse("unknown");
  }

  const normalized = normalizeMiddlewarePathname(url.pathname);
  if (!normalized) {
    return oauthJsonResponse(400, { error: "invalid_request", error_description: "Path tidak valid." });
  }
  const pathnameLower = normalized.toLowerCase();
  if (!isMcpOAuthHandledPath(pathnameLower)) {
    return null;
  }

  // Strictly admin (`app`) host ONLY — return neutral 404 on tenant, console, and marketing hosts!
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return neutralNotFoundResponse(hostCtx.allowed ? hostCtx.surface : "unknown");
  }

  const method = request.method.toUpperCase();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestId =
    request.headers.get("x-request-id")?.trim() || `oauth_${generatePlatformAuditId(nowMs)}`;

  // 1. RFC 9728 Protected Resource Metadata
  if (
    pathnameLower === "/.well-known/oauth-protected-resource" ||
    pathnameLower === "/.well-known/oauth-protected-resource/mcp"
  ) {
    if (method !== "GET" && method !== "HEAD") {
      return oauthJsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    return oauthJsonResponse(200, buildProtectedResourceMetadata(hostCtx.expectedOrigin));
  }

  // 2. RFC 8414 Authorization Server Metadata
  if (pathnameLower === "/.well-known/oauth-authorization-server") {
    if (method !== "GET" && method !== "HEAD") {
      return oauthJsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    }
    return oauthJsonResponse(200, buildAuthorizationServerMetadata(hostCtx.expectedOrigin));
  }

  // 3. Dynamic Client Registration disabled by default (ADR-0008: CIMD preferred)
  if (pathnameLower === "/oauth2/register") {
    return oauthJsonResponse(403, {
      error: "registration_not_supported",
      error_description:
        "Dynamic Client Registration dinonaktifkan. Gunakan Client ID Metadata Document (CIMD) HTTPS.",
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return oauthJsonResponse(503, {
      error: "temporarily_unavailable",
      error_description: "Layanan otorisasi sedang tidak tersedia.",
    });
  }

  // 4. OAuth 2.1 Authorization Endpoint (`GET /oauth2/authorize`)
  if (pathnameLower === "/oauth2/authorize") {
    if (method !== "GET") {
      return oauthJsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
    }

    // Rate-limit BEFORE performing any outbound CIMD fetch or D1 upsert
    const callerKey =
      request.headers.get("cf-connecting-ip")?.trim() ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "anonymous-authorize-caller";
    const authzRl = await consumeMcpAuthorizeRateLimit(runtimeEnv.PLATFORM_DB, {
      callerKey,
      perCallerPerMinute: options.authorizePerCallerPerMinute,
      globalPerMinute: options.authorizeGlobalPerMinute,
      nowMs,
    });
    if (!authzRl.allowed) {
      return oauthJsonResponse(
        429,
        {
          error: "rate_limit_exceeded",
          error_description: "Terlalu banyak permintaan otorisasi OAuth. Coba lagi sebentar.",
        },
        {
          "Retry-After": String(authzRl.retryAfterSeconds),
          "X-Request-Id": requestId,
        },
      );
    }

    const validation = await validateMcpAuthorizeRequest(
      runtimeEnv.PLATFORM_DB,
      url.searchParams,
      hostCtx.expectedOrigin,
      {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        nowMs,
      },
    );
    if (!validation.ok) {
      return oauthJsonResponse(validation.status, {
        error: validation.error,
        error_description: validation.description,
      });
    }

    const consentParams = new URLSearchParams({
      client_id: validation.params.client.clientId,
      redirect_uri: validation.params.redirectUri,
      resource: validation.params.resource,
      scope: validation.params.scopes.join(" "),
      code_challenge: validation.params.codeChallenge,
      code_challenge_method: validation.params.codeChallengeMethod,
      ...(validation.params.state ? { state: validation.params.state } : {}),
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `/auth/consent?${consentParams.toString()}`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Request-Id": requestId,
      },
    });
  }

  // 5. OAuth 2.1 Token Endpoint (`POST /oauth2/token`)
  if (pathnameLower === "/oauth2/token") {
    if (method !== "POST") {
      return oauthJsonResponse(405, { error: "method_not_allowed" }, { Allow: "POST" });
    }
    const formParams = await parseOAuthFormOrJsonParams(request);
    if (!formParams) {
      return oauthJsonResponse(400, {
        error: "invalid_request",
        error_description: "Body permintaan token tidak dapat diparsing.",
      });
    }
    const result = await exchangeMcpOAuthToken(
      runtimeEnv.PLATFORM_DB,
      formParams,
      hostCtx.expectedOrigin,
      { requestId, nowMs },
    );
    return oauthJsonResponse(result.status, result.body, { "X-Request-Id": requestId });
  }

  // 6. RFC 7009 Token Revocation Endpoint (`POST /oauth2/revoke`)
  if (pathnameLower === "/oauth2/revoke") {
    if (method !== "POST") {
      return oauthJsonResponse(405, { error: "method_not_allowed" }, { Allow: "POST" });
    }
    const formParams = await parseOAuthFormOrJsonParams(request);
    if (!formParams) {
      return oauthJsonResponse(400, {
        error: "invalid_request",
        error_description: "Body permintaan pencabutan token tidak valid.",
      });
    }
    const result = await handleMcpTokenRevocation(runtimeEnv.PLATFORM_DB, formParams, {
      requestId,
      nowMs,
    });
    return oauthJsonResponse(result.status, result.body, { "X-Request-Id": requestId });
  }

  return null;
}
