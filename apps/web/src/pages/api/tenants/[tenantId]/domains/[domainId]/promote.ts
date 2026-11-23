import {
  DomainProviderError,
  computeTenantDomainMarker,
  doesCnameMatchTarget,
  evaluatePrimaryPromotionGates,
} from "@punyasitus/core/domains/index";
import {
  getTenantDomainBySelector,
  promoteDomainToPrimary,
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
  resolveCloudflareClient,
  resolveDnsResolver,
  resolveDomainMarkerSecret,
  resolveHttpsProbe,
  type TenantDomainsHandlerOptions,
  type TenantDomainsRuntimeEnv,
} from "../_shared.ts";
import { buildDomainsRuntimeEnv } from "../index.ts";

/**
 * Primary Domain Promotion endpoint:
 * - `POST /api/tenants/:tenantId/domains/:domainId/promote` (and `/make-primary` alias)
 *
 * Enforces ALL 4 mandatory primary promotion gates (PLAN §3.1, §12.2 & TASK-003):
 *   1. Cloudflare hostname ownership `status === "active"`
 *   2. Cloudflare `ssl.status === "active"`
 *   3. Target CNAME verification passing (`cnameTarget`)
 *   4. Live HTTPS tenant-marker probe confirming THIS exact tenant answers on the hostname
 *
 * If ANY single gate fails, promotion is denied (`409 CONFLICT`), the previous primary stays
 * untouched, and all gate outcomes are returned transparently.
 */

const PROMOTE_ALLOWED_KEYS = new Set(["version"]);

export async function handleTenantDomainPromoteRequest(
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
      "Metode HTTP tidak diizinkan untuk endpoint promosi domain utama.",
      requestId,
      { headers: { Allow: "POST" } },
    );
  }

  const auth = await authorizeTenantDomainsRequest(
    tenantId,
    request,
    runtimeEnv,
    "domain:make_primary",
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const parsedBody = await parseStrictDomainsJsonBody(request, PROMOTE_ALLOWED_KEYS, requestId);
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

  try {
    const existing = await getTenantDomainBySelector(
      auth.ctx.platformDb,
      auth.ctx.member.tenantId,
      domainId,
    );
    if (!existing) {
      return domainsErrorResponse(404, "NOT_FOUND", "Domain tidak ditemukan.", requestId);
    }

    if (existing.version !== rawVersion) {
      return domainsErrorResponse(
        409,
        "STALE_VERSION",
        "Versi domain sudah berubah. Muat ulang sebelum mengubah domain utama.",
        requestId,
      );
    }

    // Platform fallback subdomain can always be restored as primary when active
    if (existing.kind === "subdomain") {
      if (existing.status !== "active") {
        return domainsErrorResponse(
          409,
          "CONFLICT",
          "Subdomain platform belum berstatus aktif.",
          requestId,
        );
      }
      const promotedFallback = await promoteDomainToPrimary(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        hostname: existing.hostname,
        expectedVersion: rawVersion,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        requestId,
        dnsTargetObserved: null,
        nowMs: auth.ctx.nowMs,
      });
      return domainsJsonResponse(200, {
        ...formatDomainRecordResponse(promotedFallback, {
          cnameTarget: auth.ctx.cnameTarget,
          nowMs: auth.ctx.nowMs,
        }),
        gates: {
          ownershipActive: true,
          sslActive: true,
          cnameVerified: true,
          httpsProbePassed: true,
        },
      });
    }

    // Custom domain MUST pass ALL 4 live promotion gates!
    if (!existing.cfCustomHostnameId) {
      return domainsErrorResponse(
        409,
        "CONFLICT",
        "Custom hostname belum terdaftar pada Cloudflare. Lakukan sinkronisasi terlebih dahulu.",
        requestId,
        {
          reasonCode: "PROMOTION_GATE_FAILED",
          details: {
            gates: {
              ownershipActive: false,
              sslActive: false,
              cnameVerified: false,
              httpsProbePassed: false,
            },
            failedGates: [
              {
                gate: "ownership_active",
                code: "GATE_PROVIDER_NOT_CREATED",
                messageId: "Custom hostname belum terdaftar di Cloudflare.",
              },
            ],
          },
        },
      );
    }

    // Gate 1 & 2: Live Cloudflare custom hostname status & SSL status
    const cloudflareClient = resolveCloudflareClient(runtimeEnv, options);
    let liveProvider;
    try {
      liveProvider = await cloudflareClient.getCustomHostname(existing.cfCustomHostnameId);
    } catch (err) {
      if (err instanceof DomainProviderError && err.retryable) {
        return domainsErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId, {
          reasonCode: `PROVIDER_${err.kind.toUpperCase()}`,
          headers: { "Retry-After": "15" },
        });
      }
      throw err;
    }

    // Gate 3: Live DNS CNAME check (defaults to Cloudflare DoH; injectable in tests)
    const dnsObservation = await observeDnsForHostname(
      resolveDnsResolver(options),
      existing.hostname,
    );
    const observedCnames = dnsObservation?.cnameTargets ?? [];

    // Gate 4: Live HTTPS tenant-marker probe confirming THIS exact tenant answers
    // Fails closed with 503 DOMAIN_MARKER_SECRET_UNCONFIGURED when DOMAIN_MARKER_SECRET is missing!
    const markerSecret = resolveDomainMarkerSecret(runtimeEnv, {
      testMarkerSecret: options.testMarkerSecret,
    });
    const expectedMarker = await computeTenantDomainMarker(
      auth.ctx.member.tenantId,
      existing.hostname,
      markerSecret,
    );
    const httpsProbe = resolveHttpsProbe(options);
    const probeResult = await httpsProbe.probeTenantMarker({
      hostname: existing.hostname,
      expectedTenantId: auth.ctx.member.tenantId,
      expectedMarker,
    });

    const evaluation = evaluatePrimaryPromotionGates({
      providerStatus: liveProvider.status,
      providerSslStatus: liveProvider.ssl.status,
      observedCnameTargets: observedCnames,
      cnameTarget: auth.ctx.cnameTarget,
      httpsProbe: probeResult,
      expectedTenantId: auth.ctx.member.tenantId,
    });

    if (!evaluation.eligible) {
      return domainsErrorResponse(
        409,
        "CONFLICT",
        "Domain belum memenuhi seluruh 4 syarat promosi menjadi domain utama.",
        requestId,
        {
          reasonCode: "PROMOTION_GATE_FAILED",
          details: {
            gates: evaluation.gates,
            failedGates: evaluation.failedGates,
          },
        },
      );
    }

    const dnsTargetObserved =
      observedCnames.find((t) => doesCnameMatchTarget([t], auth.ctx.cnameTarget)) ??
      observedCnames[0] ??
      auth.ctx.cnameTarget;

    const promoted = await promoteDomainToPrimary(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      hostname: existing.hostname,
      expectedVersion: rawVersion,
      actorUserId: auth.ctx.member.userId,
      actorRole: auth.ctx.member.role,
      requestId,
      dnsTargetObserved,
      provider: liveProvider,
      nowMs: auth.ctx.nowMs,
    });

    return domainsJsonResponse(200, {
      ...formatDomainRecordResponse(promoted, {
        cnameTarget: auth.ctx.cnameTarget,
        dnsObservation,
        nowMs: auth.ctx.nowMs,
      }),
      gates: evaluation.gates,
    });
  } catch (err) {
    return mapDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDomainPromoteRequest(
    params.tenantId ?? "",
    params.domainId ?? "",
    request,
    buildDomainsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
