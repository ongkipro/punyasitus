import {
  DomainProviderError,
  assertTenantPaidForCustomDomain,
  doesCnameMatchTarget,
  evaluateDcvTokenAge,
  type CloudflareCustomHostname,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import {
  consumeDomainRecheckRateLimit,
  getTenantDomainBySelector,
  syncDomainProviderState,
} from "@punyasitus/db/domains/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantDomainsRequest,
  createDomainRequestId,
  domainsErrorResponse,
  domainsJsonResponse,
  formatDomainRecordResponse,
  mapDomainErrorToResponse,
  observeDnsForHostname,
  parseStrictDomainsJsonBody,
  reconcileOrCreateCloudflareHostname,
  resolveCloudflareClient,
  resolveDnsResolver,
  type TenantDomainsHandlerOptions,
  type TenantDomainsRuntimeEnv,
} from "../_shared.ts";
import { buildDomainsRuntimeEnv } from "../index.ts";

/**
 * Rate-limited "Periksa sekarang" manual domain recheck endpoint:
 * - `POST /api/tenants/:tenantId/domains/:domainId/recheck`
 *
 * Behavior (PLAN §3.2 & TASK-003):
 * 1. Rate-limited per-domain and per-tenant (`429 RATE_LIMITED`).
 * 2. If `cfCustomHostnameId` is absent (prior provider timeout), reconciles via lookup/create
 *    instead of duplicating records.
 * 3. Sends documented Cloudflare `PATCH /zones/:zone/custom_hostnames/:id` with current `ssl`
 *    settings (`method`, `type: "dv"`, `settings.min_tls_version`) to reset Cloudflare's backoff
 *    and trigger immediate validation.
 * 4. If DCV token has expired (Let's Encrypt > 7d, Google Trust Services / SSL.com > 14d) or
 *    validation records are empty, automatically re-fetches fresh DCV tokens via `GET` and
 *    refreshes `tokenIssuedAt` / `tokenExpiresAt`.
 * 5. Runs DNS observation to detect CNAME target match, conflicting `_acme-challenge` TXT, and CAA.
 */

const RECHECK_ALLOWED_KEYS = new Set(["version", "sslMethod"]);

export async function handleTenantDomainRecheckRequest(
  tenantId: string,
  domainId: string,
  request: Request,
  runtimeEnv: TenantDomainsRuntimeEnv,
  options: TenantDomainsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDomainRequestId();

  if (method !== "POST") {
    return domainsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint recheck domain.",
      requestId,
      { headers: { Allow: "POST" } },
    );
  }

  const auth = await authorizeTenantDomainsRequest(
    tenantId,
    request,
    runtimeEnv,
    "domain:recheck",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const parsedBody = await parseStrictDomainsJsonBody(request, RECHECK_ALLOWED_KEYS, requestId);
  if (!parsedBody.ok) return parsedBody.response;

  const rawVersion = parsedBody.body.version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
    return domainsErrorResponse(
      422,
      "VALIDATION_ERROR",
      "version harus berupa bilangan bulat non-negatif.",
      requestId,
      { fields: [{ field: "version", code: "INVALID_VERSION", message: "Invalid version" }] },
    );
  }

  const requestedSsl =
    parsedBody.body.sslMethod !== undefined
      ? (String(parsedBody.body.sslMethod) as DomainSslMethod)
      : undefined;
  if (requestedSsl !== undefined && requestedSsl !== "http" && requestedSsl !== "txt") {
    return domainsErrorResponse(
      422,
      "VALIDATION_ERROR",
      "sslMethod hanya boleh bernilai 'http' atau 'txt'.",
      requestId,
      { fields: [{ field: "sslMethod", code: "INVALID_SSL_METHOD", message: "Invalid sslMethod" }] },
    );
  }

  try {
    assertTenantPaidForCustomDomain(auth.ctx.member.tenantStatus);

    const existing = await getTenantDomainBySelector(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      domainId,
    );
    if (!existing) {
      return domainsErrorResponse(404, "NOT_FOUND", "Domain tidak ditemukan.", requestId);
    }

    if (existing.kind !== "custom") {
      return domainsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Recheck Cloudflare hanya berlaku untuk custom domain.",
        requestId,
      );
    }

    if (existing.version !== rawVersion) {
      return domainsErrorResponse(
        409,
        "STALE_VERSION",
        "Versi data domain sudah berubah. Muat ulang sebelum melakukan pemeriksaan ulang.",
        requestId,
      );
    }

    // 1. Atomic per-domain + per-tenant rate limit
    await consumeDomainRecheckRateLimit(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      hostname: existing.hostname,
      nowMs: auth.ctx.nowMs,
      policy: options.recheckRateLimitPolicy,
    });

    const connectMode = existing.connectMode ?? "new_domain";
    const effectiveSslMethod: DomainSslMethod =
      requestedSsl ?? existing.sslMethod ?? (connectMode === "zero_downtime_migration" ? "txt" : "http");
    const minTlsVersion =
      existing.providerSnapshot?.ssl.settings?.min_tls_version === "1.3" ? "1.3" : "1.2";

    const cloudflareClient = resolveCloudflareClient(runtimeEnv, options);

    // Check whether existing DCV token has expired BEFORE calling provider
    const priorTokenAge =
      existing.tokenIssuedAt !== null
        ? evaluateDcvTokenAge({
            certificateAuthority:
              existing.certificateAuthority ??
              existing.providerSnapshot?.ssl.certificate_authority,
            issuedAtMs: existing.tokenIssuedAt,
            nowMs: auth.ctx.nowMs,
          })
        : null;
    const tokenWasExpired = Boolean(
      priorTokenAge?.expired && (existing.providerSslStatus ?? existing.sslStatus) !== "active",
    );

    let providerHostname: CloudflareCustomHostname;
    let patchedSsl = false;
    let tokenRefetched = false;

    try {
      if (!existing.cfCustomHostnameId) {
        // Prior create timed out: reconcile against Cloudflare without duplicating!
        const reconciled = await reconcileOrCreateCloudflareHostname(cloudflareClient, {
          hostname: existing.hostname,
          cfCustomHostnameId: null,
          sslMethod: effectiveSslMethod,
        });
        providerHostname = reconciled.provider;
        tokenRefetched = true;
      } else {
        // Documented "Periksa sekarang": send PATCH /custom_hostnames/:id with current ssl settings!
        providerHostname = await cloudflareClient.patchCustomHostnameSsl(
          existing.cfCustomHostnameId,
          {
            method: effectiveSslMethod,
            type: "dv",
            minTlsVersion,
          },
        );
        patchedSsl = true;

        // If DCV token was expired OR validation_records came back empty, re-fetch fresh tokens via GET!
        const hasDcvRecords =
          Boolean(providerHostname.ssl.validation_records?.length) ||
          Boolean(providerHostname.ssl.dcv_delegation_records?.length);
        if (
          tokenWasExpired ||
          (providerHostname.ssl.status.toLowerCase() !== "active" && !hasDcvRecords)
        ) {
          providerHostname = await cloudflareClient.getCustomHostname(existing.cfCustomHostnameId);
          tokenRefetched = true;
        }
      }
    } catch (err) {
      if (err instanceof DomainProviderError && err.retryable) {
        // Provider timeout/5xx leaves existing domain cleanly in its pending state!
        return domainsErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          err.message,
          requestId,
          {
            reasonCode: `PROVIDER_${err.kind.toUpperCase()}`,
            details: {
              reconciliationPending: true,
              domain: formatDomainRecordResponse(existing, {
                cnameTarget: auth.ctx.cnameTarget,
                nowMs: auth.ctx.nowMs,
              }),
            },
            headers: { "Retry-After": "15" },
          },
        );
      }
      throw err;
    }

    const dnsObservation =
      options.dnsResolver === null
        ? undefined
        : await observeDnsForHostname(resolveDnsResolver(options), existing.hostname);
    const cnameMatches = doesCnameMatchTarget(dnsObservation?.cnameTargets, auth.ctx.cnameTarget);
    const dnsTargetObserved = dnsObservation?.cnameTargets?.[0] ?? null;

    const synced = await syncDomainProviderState(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      hostname: existing.hostname,
      connectMode,
      sslMethod: effectiveSslMethod,
      provider: providerHostname,
      cnameMatchesTarget: cnameMatches,
      dnsTargetObserved,
      tokenRefreshed: tokenRefetched || requestedSsl !== undefined,
      previousTokenIssuedAt: existing.tokenIssuedAt,
      expectedVersion: rawVersion,
      isManualRecheck: true,
      nowMs: auth.ctx.nowMs,
    });

    return domainsJsonResponse(200, {
      ...formatDomainRecordResponse(synced, {
        cnameTarget: auth.ctx.cnameTarget,
        dnsObservation,
        nowMs: auth.ctx.nowMs,
      }),
      patchedSsl,
      tokenRefetched,
    });
  } catch (err) {
    return mapDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDomainRecheckRequest(
    params.tenantId ?? "",
    params.domainId ?? "",
    request,
    buildDomainsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
