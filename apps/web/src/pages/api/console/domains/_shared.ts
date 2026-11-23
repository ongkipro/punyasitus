import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  consoleNeutralNotFoundResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  resolveConsoleHostContext,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { PLATFORM_HOSTS } from "@punyasitus/core";
import {
  DEFAULT_SAAS_CNAME_TARGET,
  DomainProviderError,
  createCloudflareDohDnsResolver,
  createCloudflareSaasClient,
  doesCnameMatchTarget,
  evaluateDcvTokenAge,
  type CloudflareCustomHostname,
  type CloudflareSaasClient,
  type DnsResolverPort,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { JobEnvelopeSchema } from "@punyasitus/core/jobs/index";
import {
  ConsoleAbuseModerationActionRequestSchema,
  ConsoleJobRetryRequestSchema,
  DomainConnectModeSchema,
  DomainSslMethodSchema,
  OperatorReasonSchema,
  SequentialIdSchema,
} from "@punyasitus/core/schemas";
import type { DomainRecheckRateLimitPolicy } from "@punyasitus/db/domains/index";
import {
  appendPlatformAudit,
  beginOperatorDomainChangeRemoval,
  commitOperatorDomainRecheck,
  ConsoleRecoveryError,
  finalizeOperatorDomainChange,
  getConsoleDomainQueueItem,
  listConsoleDomainsQueue,
  precheckOperatorDomainChange,
  precheckOperatorDomainRecheck,
  recordOperatorDomainProviderTimeout,
} from "@punyasitus/db/platform";

/**
 * Shared Console Operasional Platform API handlers for Superadmin Domain Recovery Queue
 * (`TASK-047`, `REQ-050`, `REQ-004`, `REQ-034`, `REQ-042`, `REQ-051`, `REQ-065`; `PLAN §13`).
 */

export interface ConsoleDomainsRuntimeEnv extends ConsoleRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly SAAS_CNAME_TARGET?: string;
  readonly CF_SAAS_ZONE_ID?: string;
  readonly CF_SAAS_API_TOKEN?: string;
  readonly CF_API_BASE_URL?: string;
}

export interface ConsoleDomainsHandlerOptions extends ConsoleHandlerOptions {
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly cloudflareFetch?: typeof fetch;
  readonly dnsResolver?: DnsResolverPort | null;
  readonly dnsFetch?: typeof fetch;
  readonly recheckRateLimitPolicy?: Partial<DomainRecheckRateLimitPolicy>;
  readonly allowTestTlds?: boolean;
}

const NonEmptyTenantIdSchema = JobEnvelopeSchema.shape.tenantId.unwrap();
const NonEmptyHostStringSchema = JobEnvelopeSchema.shape.idempotencyKey;
const StrictBooleanSchema = ConsoleAbuseModerationActionRequestSchema.shape.applyOperatorHold;
const OptionalIdempotencyKeySchema = JobEnvelopeSchema.shape.idempotencyKey.optional();

/**
 * Real Zod v4 `.strict()` schemas composed from `@punyasitus/core` primitives.
 */
export const ConsoleDomainRecheckBodySchema = ConsoleJobRetryRequestSchema.pick({ reason: true })
  .extend({
    tenantId: NonEmptyTenantIdSchema,
    hostname: NonEmptyHostStringSchema.optional(),
    expectedVersion: SequentialIdSchema,
    sslMethod: DomainSslMethodSchema.optional(),
    reason: OperatorReasonSchema,
    idempotencyKey: OptionalIdempotencyKeySchema,
  })
  .strict();

export const ConsoleDomainChangeBodySchema = ConsoleJobRetryRequestSchema.pick({ reason: true })
  .extend({
    tenantId: NonEmptyTenantIdSchema,
    hostname: NonEmptyHostStringSchema,
    confirmHostname: NonEmptyHostStringSchema,
    confirmRemoveLocked: StrictBooleanSchema,
    removeDomainSet: StrictBooleanSchema.optional(),
    newHostname: NonEmptyHostStringSchema.nullable().optional(),
    connectMode: DomainConnectModeSchema.optional(),
    sslMethod: DomainSslMethodSchema.optional(),
    confirmApexFlattening: StrictBooleanSchema.optional(),
    expectedVersion: SequentialIdSchema,
    reason: OperatorReasonSchema,
    idempotencyKey: OptionalIdempotencyKeySchema,
  })
  .strict();

export interface ParsedDomainRecheckPayload {
  readonly tenantId: string;
  readonly hostname?: string;
  readonly expectedVersion: number;
  readonly sslMethod?: "http" | "txt";
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface ParsedDomainChangePayload {
  readonly tenantId: string;
  readonly hostname: string;
  readonly confirmHostname: string;
  readonly confirmRemoveLocked: boolean;
  readonly removeDomainSet?: boolean;
  readonly newHostname?: string | null;
  readonly connectMode?: "new_domain" | "zero_downtime_migration" | "cloudflare_o2o";
  readonly sslMethod?: "http" | "txt";
  readonly confirmApexFlattening?: boolean;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

function mapZodIssues(
  issues: readonly { readonly code: string; readonly message: string; readonly keys?: readonly string[] }[],
): { readonly code: "UNKNOWN_FIELD" | "VALIDATION_ERROR"; readonly message: string } {
  const unrecognized = issues.find((i) => i.code === "unrecognized_keys");
  if (unrecognized && Array.isArray(unrecognized.keys) && unrecognized.keys.length > 0) {
    return {
      code: "UNKNOWN_FIELD",
      message: `Field tidak dikenal tidak diizinkan: ${unrecognized.keys.join(", ")}.`,
    };
  }
  return {
    code: "VALIDATION_ERROR",
    message: issues[0]?.message ?? "Payload permintaan tidak valid.",
  };
}

export function validateConsoleDomainRecheckPayload(
  raw: Record<string, unknown>,
):
  | { readonly ok: true; readonly data: ParsedDomainRecheckPayload }
  | { readonly ok: false; readonly code: "UNKNOWN_FIELD" | "VALIDATION_ERROR"; readonly message: string } {
  const parsed = ConsoleDomainRecheckBodySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      ...mapZodIssues(
        parsed.error.issues as readonly {
          readonly code: string;
          readonly message: string;
          readonly keys?: readonly string[];
        }[],
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validateConsoleDomainChangePayload(
  raw: Record<string, unknown>,
):
  | { readonly ok: true; readonly data: ParsedDomainChangePayload }
  | { readonly ok: false; readonly code: "UNKNOWN_FIELD" | "VALIDATION_ERROR"; readonly message: string } {
  const parsed = ConsoleDomainChangeBodySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      ...mapZodIssues(
        parsed.error.issues as readonly {
          readonly code: string;
          readonly message: string;
          readonly keys?: readonly string[];
        }[],
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

export function buildConsoleDomainsRuntimeEnv(rawEnv: {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly SAAS_CNAME_TARGET?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly CF_SAAS_ZONE_ID?: string;
  readonly CF_SAAS_API_TOKEN?: string;
  readonly CF_API_BASE_URL?: string;
  readonly EMAIL?: unknown;
}): ConsoleDomainsRuntimeEnv {
  return {
    APP_ENV: rawEnv.APP_ENV,
    PLATFORM_DOMAIN: rawEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: rawEnv.SAAS_ZONE,
    SAAS_CNAME_TARGET: rawEnv.SAAS_CNAME_TARGET,
    PLATFORM_DB: rawEnv.PLATFORM_DB,
    AUTH_SECRET: rawEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: rawEnv.CONSOLE_AUTH_SECRET,
    CF_SAAS_ZONE_ID: rawEnv.CF_SAAS_ZONE_ID,
    CF_SAAS_API_TOKEN: rawEnv.CF_SAAS_API_TOKEN,
    CF_API_BASE_URL: rawEnv.CF_API_BASE_URL,
    EMAIL: rawEnv.EMAIL as CloudflareSendEmailBinding | undefined,
  };
}

function resolveCnameTarget(runtimeEnv: ConsoleDomainsRuntimeEnv): string {
  const explicit = runtimeEnv.SAAS_CNAME_TARGET?.trim().toLowerCase().replace(/\.$/, "");
  if (explicit) return explicit;
  const zone = runtimeEnv.SAAS_ZONE?.trim().toLowerCase().replace(/\.$/, "");
  return zone ? `cname.${zone}` : DEFAULT_SAAS_CNAME_TARGET;
}

function resolveOptionalCloudflareClient(
  runtimeEnv: ConsoleDomainsRuntimeEnv,
  options: ConsoleDomainsHandlerOptions,
): CloudflareSaasClient | null {
  if (options.cloudflareClient !== undefined) {
    return options.cloudflareClient;
  }
  const zoneId = runtimeEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = runtimeEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) {
    return null;
  }
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: runtimeEnv.CF_API_BASE_URL,
    fetchImpl: options.cloudflareFetch,
  });
}

function resolveIdempotencyKey(
  request: Request,
  bodyKey: string | undefined,
  requestId: string,
): { readonly ok: true; readonly key: string } | { readonly ok: false; readonly response: Response } {
  const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const cleanBodyKey = bodyKey?.trim() ?? "";

  if (headerKey && cleanBodyKey && headerKey !== cleanBodyKey) {
    return {
      ok: false,
      response: consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key dan field body idempotencyKey tidak cocok.",
        requestId,
      ),
    };
  }
  const resolved = headerKey || cleanBodyKey;
  if (!resolved) {
    return {
      ok: false,
      response: consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key wajib disertakan pada header atau body permintaan.",
        requestId,
      ),
    };
  }
  return { ok: true, key: resolved };
}

function mapRecoveryError(err: unknown, requestId: string): Response {
  if (err instanceof ConsoleRecoveryError) {
    const extraHeaders =
      err.retryAfterSeconds !== undefined
        ? { "Retry-After": String(err.retryAfterSeconds) }
        : undefined;
    return consoleErrorResponse(
      err.status,
      err.code,
      err.message,
      requestId,
      err.details,
      extraHeaders,
    );
  }
  if (err instanceof DomainProviderError) {
    const status = err.retryable ? 503 : 502;
    return consoleErrorResponse(
      status,
      err.kind === "timeout" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
      err.message,
      requestId,
      { reasonCode: `PROVIDER_${err.kind.toUpperCase()}`, reconciliationPending: err.retryable },
      err.retryable ? { "Retry-After": "15" } : undefined,
    );
  }
  return consoleErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses antrean pemulihan domain.",
    requestId,
  );
}

/**
 * `GET /api/console/domains` — List/filter/search/paginate custom hostnames (exceptions first).
 */
export async function handleConsoleDomainsListRequest(
  request: Request,
  runtimeEnv: ConsoleDomainsRuntimeEnv,
  options: ConsoleDomainsHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.domains.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const search = url.searchParams.get("search") ?? undefined;
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  const rawPage = url.searchParams.get("page");
  const rawLimit = url.searchParams.get("limit");

  const page = rawPage !== null && rawPage.trim() !== "" ? Number(rawPage) : undefined;
  const limit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : undefined;

  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 1000)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Parameter page harus bilangan bulat antara 1 hingga 1000.",
      requestId,
    );
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Parameter limit harus bilangan bulat antara 1 hingga 100.",
      requestId,
    );
  }

  try {
    const queue = await listConsoleDomainsQueue(authz.ctx.platformDb, {
      status,
      search,
      tenantId,
      page,
      limit,
      nowMs: authz.ctx.nowMs,
    });
    return consoleJsonResponse(200, {
      success: true,
      requestId,
      ...queue,
    });
  } catch (err) {
    return mapRecoveryError(err, requestId);
  }
}

/**
 * `POST /api/console/domains/recheck` & `POST /api/console/domains/[hostname]/recheck`
 * Rate-limited operator domain reconciliation with step-up 2FA, strict Zod v4 validation,
 * path-vs-body match enforcement, reason, idempotency, atomic audit, and safe provider timeout.
 */
export async function handleConsoleDomainRecheckRequest(
  request: Request,
  runtimeEnv: ConsoleDomainsRuntimeEnv,
  options: ConsoleDomainsHandlerOptions & { readonly pathHostname?: string } = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "POST") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.domain.recheck", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const rawBody = await parseStrictConsoleJsonBody(request, requestId);
  if (!rawBody.ok) {
    return rawBody.response;
  }

  const parsed = validateConsoleDomainRecheckPayload(rawBody.body);
  if (!parsed.ok) {
    return consoleErrorResponse(422, parsed.code, parsed.message, requestId);
  }

  const normalizedPathHost = options.pathHostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  const normalizedBodyHost = parsed.data.hostname?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (normalizedPathHost && normalizedBodyHost && normalizedPathHost !== normalizedBodyHost) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Hostname pada path URL dan field body hostname tidak cocok.",
      requestId,
    );
  }

  const targetHostname = normalizedPathHost || normalizedBodyHost;
  if (!targetHostname) {
    return consoleErrorResponse(422, "VALIDATION_ERROR", "Hostname domain wajib diisi.", requestId);
  }

  const idemp = resolveIdempotencyKey(request, parsed.data.idempotencyKey, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  try {
    const precheck = await precheckOperatorDomainRecheck(authz.ctx.platformDb, {
      tenantId: parsed.data.tenantId,
      hostname: targetHostname,
      expectedVersion: parsed.data.expectedVersion,
      sslMethod: parsed.data.sslMethod,
      reason: parsed.data.reason,
      idempotencyKey: idemp.key,
      nowMs: authz.ctx.nowMs,
      rateLimitPolicy: options.recheckRateLimitPolicy,
    });

    if (precheck.outcome === "replayed") {
      return consoleJsonResponse(200, {
        success: true,
        requestId,
        replayed: true,
        domain: precheck.domain,
        auditId: null,
      });
    }

    const { record, cleanReason, cleanIdempotencyKey, ledgerKey, requestHash } = precheck;
    const connectMode = record.connectMode ?? "new_domain";
    const effectiveSslMethod: DomainSslMethod =
      parsed.data.sslMethod ??
      record.sslMethod ??
      (connectMode === "zero_downtime_migration" ? "txt" : "http");
    const minTlsVersion =
      record.providerSnapshot?.ssl.settings?.min_tls_version === "1.3" ? "1.3" : "1.2";

    const cfClient = resolveOptionalCloudflareClient(runtimeEnv, options);
    if (!cfClient) {
      const timedOut = await recordOperatorDomainProviderTimeout(authz.ctx.platformDb, {
        actorUserId: authz.ctx.actor.userId,
        tenantId: parsed.data.tenantId,
        record,
        expectedVersion: parsed.data.expectedVersion,
        reason: cleanReason,
        requestId,
        providerErrorCode: "PROVIDER_UNCONFIGURED",
        nowMs: authz.ctx.nowMs,
      });
      return consoleErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Kredensial Cloudflare for SaaS belum dikonfigurasi; status domain dipertahankan.",
        requestId,
        {
          reasonCode: "PROVIDER_UNCONFIGURED",
          reconciliationPending: true,
          expectedVersion: timedOut.domain.version,
          domain: timedOut.domain,
          auditId: timedOut.audit.id,
        },
        { "Retry-After": "30" },
      );
    }

    const priorTokenAge =
      record.tokenIssuedAt !== null
        ? evaluateDcvTokenAge({
            certificateAuthority:
              record.certificateAuthority ?? record.providerSnapshot?.ssl.certificate_authority,
            issuedAtMs: record.tokenIssuedAt,
            nowMs: authz.ctx.nowMs,
          })
        : null;
    const tokenWasExpired = Boolean(
      priorTokenAge?.expired && (record.providerSslStatus ?? record.sslStatus) !== "active",
    );

    let providerHostname: CloudflareCustomHostname;
    let tokenRefreshed = false;

    try {
      if (!record.cfCustomHostnameId) {
        const found = await cfClient.findCustomHostnameByName(record.hostname);
        providerHostname =
          found ??
          (await cfClient.createCustomHostname({
            hostname: record.hostname,
            sslMethod: effectiveSslMethod,
          }));
        tokenRefreshed = true;
      } else {
        providerHostname = await cfClient.patchCustomHostnameSsl(record.cfCustomHostnameId, {
          method: effectiveSslMethod,
          type: "dv",
          minTlsVersion,
        });
        const hasDcv =
          Boolean(providerHostname.ssl.validation_records?.length) ||
          Boolean(providerHostname.ssl.dcv_delegation_records?.length);
        if (tokenWasExpired || (providerHostname.ssl.status.toLowerCase() !== "active" && !hasDcv)) {
          providerHostname = await cfClient.getCustomHostname(record.cfCustomHostnameId);
          tokenRefreshed = true;
        }
      }
    } catch (err) {
      if (err instanceof DomainProviderError && err.retryable) {
        const providerErrorCode = `PROVIDER_${err.kind.toUpperCase()}`;
        const recorded = await recordOperatorDomainProviderTimeout(authz.ctx.platformDb, {
          actorUserId: authz.ctx.actor.userId,
          tenantId: parsed.data.tenantId,
          record,
          expectedVersion: parsed.data.expectedVersion,
          reason: cleanReason,
          requestId,
          providerErrorCode,
          nowMs: authz.ctx.nowMs,
        });
        return consoleErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Penyedia domain mengalami timeout/gangguan. Status domain tetap dipertahankan dan aman diulang tanpa melewati verifikasi.",
          requestId,
          {
            reasonCode: providerErrorCode,
            reconciliationPending: true,
            expectedVersion: recorded.domain.version,
            domain: recorded.domain,
            auditId: recorded.audit.id,
          },
          { "Retry-After": "15" },
        );
      }
      throw err;
    }

    const cnameTarget = resolveCnameTarget(runtimeEnv);
    const dnsResolver =
      options.dnsResolver === null
        ? null
        : options.dnsResolver ?? createCloudflareDohDnsResolver({ fetchImpl: options.dnsFetch });
    const cnameTargets = dnsResolver
      ? await dnsResolver.resolveCname(record.hostname).catch(() => [])
      : [];
    const cnameMatches = doesCnameMatchTarget(cnameTargets, cnameTarget);

    const committed = await commitOperatorDomainRecheck(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      tenantId: parsed.data.tenantId,
      record,
      expectedVersion: parsed.data.expectedVersion,
      reason: cleanReason,
      idempotencyKey: cleanIdempotencyKey,
      ledgerKey,
      requestHash,
      requestId,
      nowMs: authz.ctx.nowMs,
      connectMode,
      sslMethod: effectiveSslMethod,
      provider: providerHostname,
      cnameMatchesTarget: cnameMatches,
      dnsTargetObserved: cnameTargets[0] ?? null,
      tokenRefreshed: tokenRefreshed || parsed.data.sslMethod !== undefined,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: committed.replayed,
      domain: committed.domain,
      auditId: committed.audit?.id ?? null,
    });
  } catch (err) {
    return mapRecoveryError(err, requestId);
  }
}

/**
 * `POST /api/console/domains/change`
 * Operator-only locked domain removal & replacement connection (REQ-065, REQ-050; PLAN §13).
 */
export async function handleConsoleDomainChangeRequest(
  request: Request,
  runtimeEnv: ConsoleDomainsRuntimeEnv,
  options: ConsoleDomainsHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "POST") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.domain.change", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const rawBody = await parseStrictConsoleJsonBody(request, requestId);
  if (!rawBody.ok) {
    return rawBody.response;
  }

  const parsed = validateConsoleDomainChangePayload(rawBody.body);
  if (!parsed.ok) {
    return consoleErrorResponse(422, parsed.code, parsed.message, requestId);
  }

  const idemp = resolveIdempotencyKey(request, parsed.data.idempotencyKey, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  try {
    const plan = await precheckOperatorDomainChange(authz.ctx.platformDb, {
      tenantId: parsed.data.tenantId,
      hostname: parsed.data.hostname,
      confirmHostname: parsed.data.confirmHostname,
      confirmRemoveLocked: parsed.data.confirmRemoveLocked,
      removeDomainSet: parsed.data.removeDomainSet,
      newHostname: parsed.data.newHostname ?? null,
      connectMode: parsed.data.connectMode,
      sslMethod: parsed.data.sslMethod,
      confirmApexFlattening: parsed.data.confirmApexFlattening,
      reason: parsed.data.reason,
      expectedVersion: parsed.data.expectedVersion,
      idempotencyKey: idemp.key,
      platformDomain: runtimeEnv.PLATFORM_DOMAIN ?? PLATFORM_HOSTS.marketing,
      saasZone: runtimeEnv.SAAS_ZONE ?? PLATFORM_HOSTS.saasZone,
      allowTestTlds:
        options.allowTestTlds ?? (runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test"),
      nowMs: authz.ctx.nowMs,
    });

    if (plan.outcome === "replayed") {
      return consoleJsonResponse(200, {
        success: true,
        requestId,
        replayed: true,
        removedHostnames: plan.removedHostnames,
        restoredSubdomainPrimary: plan.restoredSubdomainPrimary,
        newDomain: plan.newDomain,
        auditId: null,
      });
    }

    const cfClient = resolveOptionalCloudflareClient(runtimeEnv, options);
    const hasProviderIdsToDelete = plan.targetsToRemove.some((t) => Boolean(t.cfCustomHostnameId));

    if (!cfClient && runtimeEnv.APP_ENV !== "local" && (hasProviderIdsToDelete || plan.newHostname)) {
      return consoleErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Kredensial Cloudflare for SaaS belum dikonfigurasi; perubahan domain tidak dapat dilanjutkan.",
        requestId,
        { reasonCode: "PROVIDER_UNCONFIGURED" },
      );
    }

    // Step 1: Disable routing atomically, restore fallback subdomain, write audit
    const begun = await beginOperatorDomainChangeRemoval(
      authz.ctx.platformDb,
      plan,
      authz.ctx.actor.userId,
      requestId,
      authz.ctx.nowMs,
    );

    // Step 2: Delete each custom hostname at Cloudflare (if registered)
    if (cfClient) {
      for (const target of plan.targetsToRemove) {
        if (!target.cfCustomHostnameId) continue;
        try {
          await cfClient.deleteCustomHostname(target.cfCustomHostnameId);
        } catch (err) {
          if (err instanceof DomainProviderError && err.retryable) {
            await appendPlatformAudit(authz.ctx.platformDb, {
              actorUserId: authz.ctx.actor.userId,
              actorRole: "platform_operator",
              action: "console.domain.change.delete_timeout",
              targetType: "tenant_host",
              targetId: target.hostname,
              tenantId: plan.tenantId,
              reason: plan.cleanReason,
              requireReason: true,
              outcome: "error",
              requestId,
              metadata: {
                hostname: target.hostname,
                providerError: `PROVIDER_${err.kind.toUpperCase()}`,
              },
              createdAtMs: authz.ctx.nowMs,
            });
            return consoleErrorResponse(
              503,
              "SERVICE_UNAVAILABLE",
              "Routing domain lama telah dinonaktifkan, tetapi penghapusan di Cloudflare mengalami timeout. Status tetap deleting hingga pembersihan selesai.",
              requestId,
              {
                reasonCode: `PROVIDER_${err.kind.toUpperCase()}`,
                cleanupPending: true,
                hostname: target.hostname,
              },
              { "Retry-After": "15" },
            );
          }
          throw err;
        }
      }
    }

    // Step 3: Finalize local removal + ALWAYS write atomic idempotency receipt + claim optional new domain (`pending`)
    const finalized = await finalizeOperatorDomainChange(authz.ctx.platformDb, {
      plan,
      deletingVersion: begun.deletingVersion,
      actorUserId: authz.ctx.actor.userId,
      requestId,
      nowMs: authz.ctx.nowMs,
    });

    if (finalized.replayed) {
      return consoleJsonResponse(200, {
        success: true,
        requestId,
        replayed: true,
        removedHostnames: finalized.removedHostnames,
        restoredSubdomainPrimary: finalized.restoredSubdomainPrimary,
        newDomain: finalized.newDomain,
        auditId: null,
      });
    }

    // Step 4: If connecting a replacement domain and Cloudflare client is present, register at Cloudflare
    let newDomain = finalized.newDomain;

    if (plan.newHostname && plan.connectMode && plan.sslMethod && cfClient && newDomain) {
      try {
        const found = await cfClient.findCustomHostnameByName(plan.newHostname);
        const created =
          found ??
          (await cfClient.createCustomHostname({
            hostname: plan.newHostname,
            sslMethod: plan.sslMethod,
          }));

        const snapshotJson = JSON.stringify({
          id: created.id,
          hostname: created.hostname,
          status: created.status,
          ssl: created.ssl,
        });
        await authz.ctx.platformDb.batch([
          authz.ctx.platformDb
            .prepare(
              `UPDATE tenant_hosts
               SET cf_custom_hostname_id = ?,
                   status = 'pending',
                   ssl_status = ?,
                   last_checked_at = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE host = ? AND tenant_id = ? AND kind = 'custom'`,
            )
            .bind(
              created.id,
              created.ssl.status.toLowerCase(),
              authz.ctx.nowMs,
              authz.ctx.nowMs,
              plan.newHostname,
              plan.tenantId,
            ),
          authz.ctx.platformDb
            .prepare(
              `UPDATE tenant_host_metadata
               SET provider_status = ?,
                   provider_ssl_status = ?,
                   provider_snapshot_json = ?,
                   updated_at = ?
               WHERE host = ? AND tenant_id = ?`,
            )
            .bind(
              created.status,
              created.ssl.status,
              snapshotJson,
              authz.ctx.nowMs,
              plan.newHostname,
              plan.tenantId,
            ),
        ]);
        newDomain = await getConsoleDomainQueueItem(
          authz.ctx.platformDb,
          plan.tenantId,
          plan.newHostname,
          { nowMs: authz.ctx.nowMs },
        );
      } catch (err) {
        if (err instanceof DomainProviderError) {
          const providerCode = `PROVIDER_${err.kind.toUpperCase()}`;
          const errorAuditAction = err.retryable
            ? "console.domain.change.create_timeout"
            : "console.domain.change.provider_failed";

          await authz.ctx.platformDb
            .prepare(
              `UPDATE tenant_host_metadata
               SET failure_code = ?, updated_at = ?
               WHERE host = ? AND tenant_id = ?`,
            )
            .bind(providerCode, authz.ctx.nowMs, plan.newHostname, plan.tenantId)
            .run();

          const errorAudit = await appendPlatformAudit(authz.ctx.platformDb, {
            actorUserId: authz.ctx.actor.userId,
            actorRole: "platform_operator",
            action: errorAuditAction,
            targetType: "tenant_host",
            targetId: plan.newHostname,
            tenantId: plan.tenantId,
            reason: plan.cleanReason,
            requireReason: true,
            outcome: "error",
            requestId,
            metadata: {
              newHostname: plan.newHostname,
              removedHostnames: finalized.removedHostnames,
              providerError: providerCode,
              retryable: err.retryable,
            },
            createdAtMs: authz.ctx.nowMs,
          });

          newDomain = await getConsoleDomainQueueItem(
            authz.ctx.platformDb,
            plan.tenantId,
            plan.newHostname,
            { nowMs: authz.ctx.nowMs },
          );

          if (err.retryable) {
            return consoleErrorResponse(
              503,
              "SERVICE_UNAVAILABLE",
              "Domain lama berhasil dihapus, tetapi pendaftaran domain baru di Cloudflare mengalami timeout. Domain baru tetap berstatus pending dan aman direcheck ulang.",
              requestId,
              {
                reasonCode: providerCode,
                reconciliationPending: true,
                removedHostnames: finalized.removedHostnames,
                restoredSubdomainPrimary: finalized.restoredSubdomainPrimary,
                newDomain,
                auditId: errorAudit.id,
              },
              { "Retry-After": "15" },
            );
          }

          return consoleErrorResponse(
            502,
            "PROVIDER_UNAVAILABLE",
            "Domain lama telah dilepas, tetapi penyedia domain menolak pendaftaran hostname baru. Status tetap pending dengan kode kegagalan tercatat.",
            requestId,
            {
              reasonCode: providerCode,
              reconciliationPending: false,
              removedHostnames: finalized.removedHostnames,
              restoredSubdomainPrimary: finalized.restoredSubdomainPrimary,
              newDomain,
              auditId: errorAudit.id,
            },
          );
        }
        throw err;
      }
    }

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: false,
      removedHostnames: finalized.removedHostnames,
      restoredSubdomainPrimary: finalized.restoredSubdomainPrimary,
      newDomain,
      providerSyncDeferred: Boolean(plan.newHostname && !cfClient),
      auditId: finalized.audit?.id ?? null,
    });
  } catch (err) {
    return mapRecoveryError(err, requestId);
  }
}
