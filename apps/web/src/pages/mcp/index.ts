import { env } from "cloudflare:workers";
import { handleMcpHttpRequest } from "@punyasitus/auth/mcp/index";
import type { McpRateLimitPolicy } from "@punyasitus/core/mcp/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import { resolvePlatformAuthHostContext, type AuthRuntimeEnv } from "../../middleware/auth.ts";

/**
 * Streamable HTTP Tenant MCP Endpoint (`apps/web/src/pages/mcp/index.ts`; REQ-076, ADR-0008, TASK-075).
 *
 * Security invariants:
 * - Exposed ONLY on `app.punyasitus.com` (or local loopback in `APP_ENV === "local"`).
 *   Tenant hosts, marketing host, and console host ALWAYS receive neutral `404`.
 * - Ignores & rejects `__Host-` session cookies (Bearer token ONLY).
 * - Live per-call verification of bearer token, RFC 8707 `resource`, active `owner`/`admin`
 *   membership, active entitlement, per-token & per-tenant rate limits, and redacted audit logging.
 */

export interface McpRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface McpEndpointOptions {
  readonly openTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly rateLimitPolicy?: McpRateLimitPolicy;
  readonly nowMs?: number;
}

function neutralNotFoundResponse(): Response {
  return new Response(JSON.stringify({ success: false, code: "NOT_FOUND" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

export async function handleMcpEndpointRequest(
  request: Request,
  runtimeEnv: McpRuntimeEnv,
  options: McpEndpointOptions = {},
): Promise<Response> {
  // Strictly admin (`app`) host ONLY — 404 on tenant, marketing, and console hosts
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return neutralNotFoundResponse();
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return new Response(
      JSON.stringify({
        error: "temporarily_unavailable",
        message: "Layanan MCP sedang tidak tersedia.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }

  const openTenantDb =
    options.openTenantDb ??
    ((tenantId: string): D1Database => {
      if (!runtimeEnv.TENANT_STORE) {
        throw new Error("TENANT_STORE binding tidak tersedia.");
      }
      const stub = openTenantStoreStub(runtimeEnv.TENANT_STORE, tenantId);
      return createTenantDb(stub);
    });

  return handleMcpHttpRequest(request, {
    platformDb: runtimeEnv.PLATFORM_DB,
    adminOrigin: hostCtx.expectedOrigin,
    openTenantDb,
    rateLimitPolicy: options.rateLimitPolicy,
    nowMs: options.nowMs,
  });
}

export const ALL: APIRoute = ({ request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMcpEndpointRequest(request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  });
};
