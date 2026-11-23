import { env } from "cloudflare:workers";
import {
  DomainProviderError,
  assertTenantPaidForCustomDomain,
  assertValidCustomHostname,
  doesCnameMatchTarget,
  evaluateApexCapability,
  normalizeConnectMode,
  resolveSslMethodForMode,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  claimTenantCustomHostname,
  finalizeDomainRemoval,
  listTenantDomains,
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
} from "./_shared.ts";

/**
 * Tenant Domains collection endpoints:
 * - `GET /api/tenants/:tenantId/domains` — list fallback + custom hostnames (`domain:read`)
 * - `POST /api/tenants/:tenantId/domains` — connect custom hostname (create-before-CNAME,
 *   3 connect modes, paid-only, safe timeout/retry reconciliation; `domain:connect`)
 */

const CONNECT_ALLOWED_KEYS = new Set([
  "hostname",
  "mode",
  "sslMethod",
  "confirmApexFlattening",
]);

export async function handleTenantDomainsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantDomainsRuntimeEnv,
  options: TenantDomainsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDomainRequestId();

  if (method === "GET") {
    const auth = await authorizeTenantDomainsRequest(
      tenantId,
      request,
      runtimeEnv,
      "domain:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;

    try {
      const listed = await listTenantDomains(auth.ctx.platformDb, auth.ctx.member.tenantId);
      const items = listed.items.map((record) =>
        formatDomainRecordResponse(record, {
          cnameTarget: auth.ctx.cnameTarget,
          nowMs: auth.ctx.nowMs,
        }),
      );
      return domainsJsonResponse(200, {
        items,
        customDomainLocked: listed.customDomainLocked,
        maxCustomHostnames: listed.maxCustomHostnames,
      });
    } catch (err) {
      return mapDomainErrorToResponse(err, requestId);
    }
  }

  if (method === "POST") {
    const auth = await authorizeTenantDomainsRequest(
      tenantId,
      request,
      runtimeEnv,
      "domain:connect",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;

    const parsedBody = await parseStrictDomainsJsonBody(request, CONNECT_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    try {
      // 1. Paid websites only (defense-in-depth alongside RBAC assertion)
      assertTenantPaidForCustomDomain(auth.ctx.member.tenantStatus);

      // 2. Hostname normalization & strict validation (<= 64 chars, no wildcards/IP/platform/SaaS zone)
      const validatedHost = assertValidCustomHostname(parsedBody.body.hostname, {
        platformDomain: auth.ctx.platformDomain,
        saasZone: auth.ctx.saasZone,
        allowTestTlds: options.allowTestTlds,
      });

      // 3. Connect mode & SSL method validation
      const connectMode = normalizeConnectMode(parsedBody.body.mode);
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
      const sslMethod = resolveSslMethodForMode(connectMode, requestedSsl);

      if (
        parsedBody.body.confirmApexFlattening !== undefined &&
        typeof parsedBody.body.confirmApexFlattening !== "boolean"
      ) {
        return domainsErrorResponse(
          422,
          "VALIDATION_ERROR",
          "confirmApexFlattening harus berupa boolean.",
          requestId,
          {
            fields: [
              {
                field: "confirmApexFlattening",
                code: "INVALID_TYPE",
                message: "Must be boolean",
              },
            ],
          },
        );
      }

      // 3b. Evaluate apex capability before claiming or contacting Cloudflare (PLAN §3.1, TASK-039)
      const providerSupportsApex =
        options.apexCapabilitySupported !== undefined
          ? options.apexCapabilitySupported
          : runtimeEnv.CF_APEX_CAPABILITY_SUPPORTED?.trim().toLowerCase() !== "false";
      const apexEval = evaluateApexCapability({
        hostname: validatedHost.hostname,
        isLikelyApex: validatedHost.isLikelyApex,
        connectMode,
        confirmApexFlattening: parsedBody.body.confirmApexFlattening as boolean | undefined,
        providerSupportsApex,
      });
      if (!apexEval.supported) {
        return domainsErrorResponse(
          422,
          "VALIDATION_ERROR",
          apexEval.messageId ?? "Domain apex tidak didukung pada konfigurasi penyedia saat ini.",
          requestId,
          {
            reasonCode: apexEval.reasonCode,
            fields: [
              {
                field: "hostname",
                code: apexEval.reasonCode,
                message: apexEval.messageId ?? "Unsupported apex capability",
              },
            ],
            details: {
              suggestedWwwHostname: apexEval.suggestedWwwHostname,
            },
          },
        );
      }

      const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;

      // 4. Persist local `pending` claim first (prevents duplicate cross-tenant races & enables retry reconciliation)
      const claim = await claimTenantCustomHostname(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        hostname: validatedHost.hostname,
        connectMode,
        sslMethod,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        requestId,
        idempotencyKey,
        nowMs: auth.ctx.nowMs,
      });

      // 5. Create-before-CNAME at Cloudflare for SaaS (or reconcile existing record on retry!)
      const cloudflareClient = resolveCloudflareClient(runtimeEnv, options);
      let providerResult;
      try {
        providerResult = await reconcileOrCreateCloudflareHostname(cloudflareClient, {
          hostname: claim.record.hostname,
          cfCustomHostnameId: claim.record.cfCustomHostnameId,
          sslMethod: claim.record.sslMethod ?? sslMethod,
        });
      } catch (err) {
        if (err instanceof DomainProviderError && err.retryable) {
          // Leave local record cleanly in `pending` state; subsequent retry reconciles safely!
          return domainsErrorResponse(
            503,
            "SERVICE_UNAVAILABLE",
            err.message,
            requestId,
            {
              reasonCode: `PROVIDER_${err.kind.toUpperCase()}`,
              details: {
                reconciliationPending: true,
                domain: formatDomainRecordResponse(claim.record, {
                  cnameTarget: auth.ctx.cnameTarget,
                  nowMs: auth.ctx.nowMs,
                }),
              },
              headers: { "Retry-After": "15" },
            },
          );
        }
        // Non-retryable provider rejection (provider never created a custom hostname):
        // release the brand-new local pending claim so it does not strand a 2-hostname slot!
        if (!claim.alreadyExisted && !claim.record.cfCustomHostnameId) {
          try {
            await finalizeDomainRemoval(auth.ctx.platformDb, {
              tenantId: auth.ctx.member.tenantId,
              hostname: claim.record.hostname,
              cfCustomHostnameId: null,
              actorUserId: auth.ctx.member.userId,
              actorRole: auth.ctx.member.role,
              requestId,
              action: "domain.connect.rolled_back",
              reason: "Provider rejected custom hostname creation with non-retryable error",
              nowMs: auth.ctx.nowMs,
            });
          } catch {
            // Preserve the original provider error if rollback cleanup fails
          }
        }
        throw err;
      }

      // 6. Bounded DNS observation (defaults to Cloudflare DoH; injectable in tests)
      const dnsObservation =
        options.dnsResolver === null
          ? undefined
          : await observeDnsForHostname(resolveDnsResolver(options), claim.record.hostname);
      const cnameMatches = doesCnameMatchTarget(dnsObservation?.cnameTargets, auth.ctx.cnameTarget);
      const dnsTargetObserved = dnsObservation?.cnameTargets?.[0] ?? null;

      // 7. Sync Cloudflare snapshot & token timestamps to PLATFORM_DB
      const synced = await syncDomainProviderState(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        hostname: claim.record.hostname,
        connectMode: claim.record.connectMode ?? connectMode,
        sslMethod: claim.record.sslMethod ?? sslMethod,
        provider: providerResult.provider,
        cnameMatchesTarget: cnameMatches,
        dnsTargetObserved,
        nowMs: auth.ctx.nowMs,
      });

      const status = claim.alreadyExisted || providerResult.reconciledExisting ? 200 : 201;
      return domainsJsonResponse(status, {
        ...formatDomainRecordResponse(synced, {
          cnameTarget: auth.ctx.cnameTarget,
          dnsObservation,
          nowMs: auth.ctx.nowMs,
        }),
        reconciledExisting: claim.alreadyExisted || providerResult.reconciledExisting,
        apexGuidance: validatedHost.isLikelyApex
          ? "Domain root/apex memerlukan dukungan CNAME flattening/ALIAS/ANAME di penyedia DNS Anda; jika tidak didukung, gunakan www." +
            validatedHost.hostname +
            " sebagai domain utama."
          : null,
      });
    } catch (err) {
      return mapDomainErrorToResponse(err, requestId);
    }
  }

  return domainsErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk endpoint domain.",
    requestId,
    { headers: { Allow: "GET, POST" } },
  );
}

export function buildDomainsRuntimeEnv(): TenantDomainsRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly SAAS_ZONE?: string;
    readonly SAAS_CNAME_TARGET?: string;
    readonly CF_SAAS_ZONE_ID?: string;
    readonly CF_SAAS_API_TOKEN?: string;
    readonly CF_API_BASE_URL?: string;
    readonly CF_APEX_CAPABILITY_SUPPORTED?: string;
    readonly DOMAIN_MARKER_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    SAAS_CNAME_TARGET: runtimeEnv.SAAS_CNAME_TARGET,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    CF_SAAS_ZONE_ID: runtimeEnv.CF_SAAS_ZONE_ID,
    CF_SAAS_API_TOKEN: runtimeEnv.CF_SAAS_API_TOKEN,
    CF_API_BASE_URL: runtimeEnv.CF_API_BASE_URL,
    CF_APEX_CAPABILITY_SUPPORTED: runtimeEnv.CF_APEX_CAPABILITY_SUPPORTED,
    DOMAIN_MARKER_SECRET: runtimeEnv.DOMAIN_MARKER_SECRET,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDomainsRequest(params.tenantId ?? "", request, buildDomainsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
