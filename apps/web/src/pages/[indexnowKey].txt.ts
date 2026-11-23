import { env } from "cloudflare:workers";
import { classifySurfaceHost, normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  constantTimeEqualStrings,
  evaluateIndexNowEligibility,
  isValidIndexNowKey,
} from "@punyasitus/core/seo/indexnow";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import type { APIRoute } from "astro";
import {
  checkSeoAutopilotActiveInTenantDb,
  resolveAutopilotIndexNowKey,
} from "../../../../packages/plugins/seo-ai-autopilot/index.ts";
import type { TenantContext } from "../core/tenant.ts";
import { readTenantSeoPluginConfig } from "../worker/queues/seo/indexnow.ts";
import { readDiscoveryDepsFromAstroLocals } from "./sitemaps/_astro-env.ts";
import {
  createMethodNotAllowedResponse,
  type DiscoveryHandlerDeps,
} from "./sitemaps/_shared.ts";

/**
 * Verified Custom-Domain `IndexNow` Key Verification Endpoint (`GET /<indexnowKey>.txt`, REQ-095, REQ-102).
 *
 * Security & Isolation Invariants:
 * - IndexNow key files are **public domain-control proofs** per the IndexNow protocol (never
 *   authentication secrets). Deterministic zero-config keys use HMAC-SHA-256 keyed by Worker
 *   secret (`INDEXNOW_KEY_SECRET ?? BETTER_AUTH_SECRET ?? AUTH_SECRET`) when configured.
 * - Fails **CLOSED** (`404`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) on
 *   any TenantStore DB error, disabled `seo-ai-autopilot`, wrong/cross-tenant key, `.situsku.click`
 *   trial/subdomain, unverified domain, `noindex`, or `suspended`/`recovery`/`purged` tenant.
 * - Emits `Cache-Control: no-store` on `200` responses so disabling `seo-ai-autopilot` or
 *   switching primary domains immediately serves `404` with zero stale edge cache.
 */

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8" as const;

export interface IndexNowKeyHandlerDeps extends DiscoveryHandlerDeps {
  /** Optional Worker secret for HMAC-SHA-256 zero-config IndexNow key derivation. */
  readonly indexnowKeySecret?: string | null;
}

function readIndexNowKeySecretFromWorkerEnv(): string | null {
  try {
    const bag = env as unknown as Record<string, unknown>;
    for (const key of ["INDEXNOW_KEY_SECRET", "BETTER_AUTH_SECRET", "AUTH_SECRET"]) {
      const value = bag[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  } catch {
    // Ignore outside workerd runtime
  }
  return null;
}

function createNeutralNotFound(request: Request): Response {
  const isHead = request.method.toUpperCase() === "HEAD";
  return new Response(isHead ? null : "", {
    status: 404,
    headers: {
      "Content-Type": TEXT_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleIndexNowKeyRequest(
  request: Request,
  rawKeyParam: string | undefined,
  deps: IndexNowKeyHandlerDeps,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return createMethodNotAllowedResponse(request);
  }

  const keyParam = (rawKeyParam ?? "").trim();
  if (!isValidIndexNowKey(keyParam)) {
    return createNeutralNotFound(request);
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return createNeutralNotFound(request);
  }

  const normalizedUrlHost = normalizeHost(url.hostname);
  if (!normalizedUrlHost) {
    return createNeutralNotFound(request);
  }

  // Reject platform surfaces (`marketing`, `app`, `console`, `unknown`)
  if (
    deps.surface === "marketing" ||
    deps.surface === "app" ||
    deps.surface === "console" ||
    deps.surface === "unknown"
  ) {
    return createNeutralNotFound(request);
  }
  const classified = classifySurfaceHost(normalizedUrlHost);
  if (
    classified.surface === "marketing" ||
    classified.surface === "app" ||
    classified.surface === "console"
  ) {
    return createNeutralNotFound(request);
  }

  const saasZone = (deps.saasZone ?? PLATFORM_HOSTS.saasZone).trim().toLowerCase();
  if (normalizedUrlHost === saasZone || normalizedUrlHost.endsWith(`.${saasZone}`)) {
    return createNeutralNotFound(request);
  }

  // Resolve authoritative tenant from middleware locals or live PLATFORM_DB host routing
  let tenant: TenantContext | null = deps.tenant ?? null;
  let tenantDb: D1Database | null = deps.tenantDb ?? null;

  if (!tenant) {
    if (!deps.platformDb) {
      return createNeutralNotFound(request);
    }
    const resolution = await resolveTenantByHost(deps.platformDb, normalizedUrlHost, {
      nowMs: deps.nowMs,
      bypassCache: deps.bypassHostCache,
    });
    if (resolution.kind !== "resolved") {
      return createNeutralNotFound(request);
    }
    tenant = {
      id: resolution.tenant.id,
      organizationId: resolution.tenant.organizationId,
      handle: resolution.tenant.handle,
      name: resolution.tenant.name,
      vertical: resolution.tenant.vertical,
      status: resolution.tenant.effectiveStatus,
      storedStatus: resolution.tenant.storedStatus,
      operatorHold: resolution.tenant.operatorHold,
      cacheVersion: resolution.tenant.cacheVersion,
      schemaVersion: resolution.tenant.schemaVersion,
      host: resolution.hostRecord.host,
      hostKind: resolution.hostRecord.kind,
      isPrimary: resolution.hostRecord.isPrimary,
      primaryHost: resolution.primaryHost,
      primaryHostKind: resolution.primaryHostKind,
    };
  }

  // Request MUST arrive on the tenant's verified active primary custom domain
  if (
    tenant.hostKind !== "custom" ||
    !tenant.isPrimary ||
    tenant.host.toLowerCase() !== normalizedUrlHost ||
    (tenant.primaryHost && tenant.primaryHost.toLowerCase() !== normalizedUrlHost)
  ) {
    return createNeutralNotFound(request);
  }

  // Fail closed against the authoritative `tenant_hosts` verification row
  if (!deps.platformDb) {
    return createNeutralNotFound(request);
  }

  const hostRow = await deps.platformDb
    .prepare(
      `SELECT kind, status, ssl_status, is_primary, verified_at
       FROM tenant_hosts
       WHERE host = ? AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(normalizedUrlHost, tenant.id)
    .first<{
      readonly kind: "subdomain" | "custom";
      readonly status: "pending" | "active" | "failed" | "moved" | "deleting";
      readonly ssl_status: string;
      readonly is_primary: number;
      readonly verified_at: number | null;
    }>();

  if (!hostRow || hostRow.kind !== "custom" || hostRow.is_primary !== 1) {
    return createNeutralNotFound(request);
  }
  const hostStatus = hostRow.status;
  const hostSslStatus = hostRow.ssl_status;
  const hostVerified =
    hostRow.status === "active" &&
    hostRow.ssl_status === "active" &&
    hostRow.verified_at !== null;

  if (!tenantDb && deps.tenantStore) {
    try {
      const stub = openTenantStoreStub(deps.tenantStore as TenantStoreNamespaceLike, tenant.id);
      tenantDb = createTenantDb(stub);
    } catch {
      return createNeutralNotFound(request);
    }
  }
  if (!tenantDb) {
    return createNeutralNotFound(request);
  }

  // Fail CLOSED on TenantStore DB error before serving any IndexNow proof
  const pluginCheck = await checkSeoAutopilotActiveInTenantDb(tenantDb);
  if (!pluginCheck.ok || !pluginCheck.active) {
    return createNeutralNotFound(request);
  }

  const [publishedSiteSettings, pluginConfig] = await Promise.all([
    getPublishedResource(tenantDb, {
      resourceType: "site_settings",
      resourceId: 1,
    }).catch(() => null),
    readTenantSeoPluginConfig(tenantDb),
  ]);

  const eligibility = evaluateIndexNowEligibility({
    tenantStatus: tenant.status,
    operatorHold: tenant.operatorHold,
    primaryHost: tenant.primaryHost ?? tenant.host,
    primaryHostKind: tenant.primaryHostKind ?? tenant.hostKind,
    primaryHostStatus: hostStatus,
    primaryHostSslStatus: hostSslStatus,
    primaryHostVerified: hostVerified,
    siteVisibility: publishedSiteSettings?.data.siteVisibility ?? "public",
    seoAutopilotEnabled: pluginCheck.active && pluginConfig.enabled,
    saasZone,
  });

  if (!eligibility.eligible) {
    return createNeutralNotFound(request);
  }

  // Zero-config IndexNow key resolution (TASK-102): prefers stored tenant key if present
  // (TASK-095 compatibility), otherwise derives the HMAC-SHA-256 keyed tenant-scoped key.
  const keySecret =
    deps.indexnowKeySecret !== undefined
      ? deps.indexnowKeySecret
      : readIndexNowKeySecretFromWorkerEnv();

  const expectedKey = await resolveAutopilotIndexNowKey({
    tenantId: tenant.id,
    seoAutopilotActive: pluginCheck.active && pluginConfig.enabled,
    storedKey: pluginConfig.indexnowKey,
    secret: keySecret,
  });

  if (!expectedKey || !isValidIndexNowKey(expectedKey)) {
    return createNeutralNotFound(request);
  }

  if (!constantTimeEqualStrings(keyParam, expectedKey)) {
    return createNeutralNotFound(request);
  }

  const isHead = method === "HEAD";
  return new Response(isHead ? null : expectedKey, {
    status: 200,
    headers: {
      "Content-Type": TEXT_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const GET: APIRoute = async ({ request, params, locals }) => {
  return handleIndexNowKeyRequest(request, params.indexnowKey, {
    ...readDiscoveryDepsFromAstroLocals(locals),
    indexnowKeySecret: readIndexNowKeySecretFromWorkerEnv(),
  });
};

export const HEAD: APIRoute = async ({ request, params, locals }) => {
  return handleIndexNowKeyRequest(request, params.indexnowKey, {
    ...readDiscoveryDepsFromAstroLocals(locals),
    indexnowKeySecret: readIndexNowKeySecretFromWorkerEnv(),
  });
};

export const ALL: APIRoute = async ({ request }) => {
  return createMethodNotAllowedResponse(request);
};
