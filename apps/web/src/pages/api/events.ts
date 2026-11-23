import { env } from "cloudflare:workers";
import type { SurfaceKind } from "@punyasitus/core";
import { isBotUserAgent } from "@punyasitus/core/analytics/insights";
import {
  recordFirstPartyEvent,
  validateFirstPartyEventPayload,
} from "@punyasitus/db/analytics/index";
import {
  enforceEventRateLimit,
  type EventRateLimitPolicy,
} from "@punyasitus/db/rate-limits/index";
import type { APIRoute } from "astro";
import {
  createPublicInputErrorResponse,
  DEFAULT_PUBLIC_POST_MAX_BYTES,
  PUBLIC_EVENT_ALLOWED_CONTENT_TYPES,
  validatePublicPostRequest,
} from "../../core/public-input.ts";
import type { TenantMiddlewareLocals } from "../../core/tenant.ts";

/**
 * Public cookieless first-party event ingestion endpoint (`POST /api/events`).
 *
 * Served ONLY on verified tenant hosts (returns neutral `404` on marketing/app/console hosts).
 * Composes:
 * 1. `validatePublicPostRequest` (Origin matrix, JSON Content-Type, 16 KiB cap, forged tenantId rejection)
 * 2. `validateFirstPartyEventPayload` (strict event allowlist, PII & query-string rejection)
 * 3. `enforceEventRateLimit` (`60/min` per network bucket + `10,000/day` per tenant; over-limit drops with `204`)
 * 4. `recordFirstPartyEvent` (published resource verification + atomic `analytics_daily` counter increment)
 *
 * Zero cookies read or set. Over-limit events drop silently with `204` per PLAN §6.
 */

export interface PublicEventTenantScope {
  readonly id: string;
  readonly host: string;
  readonly siteHosts?: readonly string[];
  readonly timeZone?: string;
}

export interface HandlePublicEventPostDeps {
  readonly surface: SurfaceKind;
  readonly tenant: PublicEventTenantScope | null;
  readonly tenantDb: D1Database | null;
  readonly rateLimitSalt: string | undefined;
  readonly isLocalLoopback?: boolean;
  readonly expectedOrigin?: string;
  readonly rateLimitPolicy?: EventRateLimitPolicy;
  readonly dedupTtlMs?: number;
  readonly dedupPruneBatchSize?: number;
  readonly nowMs?: number;
  readonly requestId?: string;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function createNoContentResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: NO_STORE_HEADERS,
  });
}

function createApiErrorJsonResponse(
  status: 404 | 422 | 503,
  code: "NOT_FOUND" | "VALIDATION_ERROR" | "SERVICE_UNAVAILABLE",
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      requestId,
    },
    {
      status,
      headers: {
        ...NO_STORE_HEADERS,
        ...(status === 503 ? { "Retry-After": "60" } : {}),
      },
    },
  );
}

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function readOptionalEnvString(key: string): string | undefined {
  const bag = env as unknown as Record<string, unknown>;
  const value = bag[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Pure, testable handler for `POST /api/events` shared by the Astro API route
 * and `workerd` integration tests.
 */
export async function handlePublicEventPost(
  request: Request,
  deps: HandlePublicEventPostDeps,
): Promise<Response> {
  const requestId = deps.requestId ?? createRequestId();

  // Strictly isolated to verified tenant hosts (plus explicit local test harness with tenant scope).
  const isTenantSurface = deps.surface === "tenant";
  const isLocalHarnessWithTenant = Boolean(deps.isLocalLoopback && deps.tenant && deps.tenantDb);
  if ((!isTenantSurface && !isLocalHarnessWithTenant) || !deps.tenant) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }

  // 1. Structural, Origin, Content-Type, 16 KiB cap, forged tenantId, and honeypot guard (PLAN §6).
  const inputCheck = await validatePublicPostRequest(request, {
    tenantHost: deps.tenant.host,
    expectedOrigin: deps.expectedOrigin,
    allowedContentTypes: PUBLIC_EVENT_ALLOWED_CONTENT_TYPES,
    maxBytes: DEFAULT_PUBLIC_POST_MAX_BYTES,
    honeypotField: "honeypot",
  });
  if (!inputCheck.ok) {
    return createPublicInputErrorResponse(inputCheck, requestId);
  }

  // 2. Strict event allowlist, PII-field & query-string rejection BEFORE consuming rate-limit budget.
  const payloadCheck = validateFirstPartyEventPayload(inputCheck.rawPayload);
  if (!payloadCheck.ok) {
    return createApiErrorJsonResponse(
      422,
      "VALIDATION_ERROR",
      payloadCheck.message,
      requestId,
      payloadCheck.fields,
    );
  }

  // 2b. Bot / crawler / headless scraper User-Agent drop (REQ-073, PLAN §18.4, TASK-072):
  // Classify and quietly drop with `204` BEFORE rate-limit or aggregate writes.
  // Never persists or logs the User-Agent header.
  if (isBotUserAgent(request.headers.get("user-agent"))) {
    return createNoContentResponse();
  }

  // 3. Fail-closed check for tenant datastore and rate-limit salt.
  const rateLimitSalt = deps.rateLimitSalt?.trim();
  if (!deps.tenantDb || !rateLimitSalt) {
    return createApiErrorJsonResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan analitik sementara tidak tersedia.",
      requestId,
    );
  }

  // 4. Atomic event rate limiter (60/min network + 10,000/day tenant; over-limit drops with 204).
  const rateLimitResult = await enforceEventRateLimit(deps.tenantDb, {
    tenantId: deps.tenant.id,
    clientIp: inputCheck.clientIp,
    salt: rateLimitSalt,
    nowMs: deps.nowMs,
    policy: deps.rateLimitPolicy,
  });

  if (!rateLimitResult.ok) {
    return createApiErrorJsonResponse(
      503,
      "SERVICE_UNAVAILABLE",
      rateLimitResult.message,
      requestId,
    );
  }

  if (!rateLimitResult.allowed) {
    // PLAN §6: Event ingestion over the rate limit is dropped cleanly with HTTP 204.
    return createNoContentResponse();
  }

  // 5. Verify referenced published resource (when supplied), deduplicate per-tenant eventId (24h),
  //    and increment daily & insights aggregate counters atomically inside one TenantStore batch (TASK-065, TASK-072).
  const recorded = await recordFirstPartyEvent(deps.tenantDb, payloadCheck.data, {
    nowMs: deps.nowMs,
    timeZone: deps.tenant.timeZone,
    siteHost: deps.tenant.host,
    siteHosts: deps.tenant.siteHosts,
    dedupTtlMs: deps.dedupTtlMs,
    pruneBatchSize: deps.dedupPruneBatchSize,
  });

  if (!recorded.ok) {
    if (recorded.status === 422) {
      return createApiErrorJsonResponse(
        422,
        "VALIDATION_ERROR",
        recorded.message,
        requestId,
        recorded.fields,
      );
    }
    return createApiErrorJsonResponse(503, "SERVICE_UNAVAILABLE", recorded.message, requestId);
  }

  return createNoContentResponse();
}

function readTenantLocals(locals: unknown): TenantMiddlewareLocals {
  const bag = (locals ?? {}) as Partial<TenantMiddlewareLocals>;
  return {
    surface: bag.surface ?? "unknown",
    host: bag.host ?? "",
    isLocalLoopback: Boolean(bag.isLocalLoopback),
    tenant: bag.tenant ?? null,
    tenantDb: bag.tenantDb ?? null,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const configuredSalt = readOptionalEnvString("RATE_LIMIT_SALT");
  const rateLimitSalt =
    configuredSalt ?? (env.APP_ENV === "local" ? "local-dev-event-rate-limit-salt" : undefined);

  return handlePublicEventPost(request, {
    surface: tenantLocals.surface,
    tenant: tenantLocals.tenant
      ? {
          id: tenantLocals.tenant.id,
          host: tenantLocals.tenant.host,
          siteHosts: tenantLocals.tenant.primaryHost
            ? [tenantLocals.tenant.host, tenantLocals.tenant.primaryHost]
            : [tenantLocals.tenant.host],
        }
      : null,
    tenantDb: tenantLocals.tenantDb,
    rateLimitSalt,
    isLocalLoopback: tenantLocals.isLocalLoopback,
  });
};

export const ALL: APIRoute = async ({ locals }) => {
  const tenantLocals = readTenantLocals(locals);
  const requestId = createRequestId();
  if (tenantLocals.surface !== "tenant" && !tenantLocals.isLocalLoopback) {
    return createApiErrorJsonResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
  }
  return Response.json(
    {
      error: {
        code: "BAD_REQUEST",
        message: "Metode HTTP tidak diizinkan untuk endpoint ini.",
      },
      requestId,
    },
    {
      status: 405,
      headers: {
        ...NO_STORE_HEADERS,
        Allow: "POST",
      },
    },
  );
};
