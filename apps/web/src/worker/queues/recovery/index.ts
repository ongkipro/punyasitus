import {
  DEFAULT_SAAS_CNAME_TARGET,
  DomainProviderError,
  createCloudflareDohDnsResolver,
  createCloudflareSaasClient,
  doesCnameMatchTarget,
  type CloudflareCustomHostname,
  type CloudflareSaasClient,
  type DnsResolverPort,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import {
  JobEnvelopeSchema,
  NonRetryableJobError,
  UncertainProviderEffectError,
  type JobEnvelope,
} from "@punyasitus/core/jobs/index";
import {
  getTenantDomainBySelector,
  syncDomainProviderState,
} from "@punyasitus/db/domains/index";
import type { DurableJobHandler, DurableJobRegistry, JobExecutionContext } from "../consumer.ts";

/**
 * Durable Queue Recovery Handlers & Dispatch Helpers (`apps/web/src/worker/queues/recovery/index.ts`;
 * TASK-047, REQ-050, REQ-004, REQ-042; PLAN §13).
 *
 * Security & Correctness Invariants:
 * - Job retries preserve authoritative `idempotencyKey`, `topic`, `tenantId`, and validated original `payload`.
 * - Domain recovery jobs NEVER force-activate hostnames, NEVER bypass verification, and NEVER lift tenant suspension.
 * - Provider timeouts throw `UncertainProviderEffectError` so the consumer reconciles on retry without false success.
 */

export const RECOVERY_DOMAIN_RECHECK_TOPIC = "recovery.domain_recheck" as const;

export interface DomainRecoveryJobPayload {
  readonly hostname: string;
  readonly sslMethod?: DomainSslMethod;
  readonly initiatedByUserId?: string;
}

export interface DispatchJobRetryQueueLike {
  send(message: unknown): Promise<void>;
}

export interface DispatchJobRetryResult {
  readonly dispatched: boolean;
  readonly envelope: JobEnvelope;
}

/**
 * Validates and dispatches an operator-retried durable job envelope to `JOBS_QUEUE`.
 */
export async function dispatchJobRetryToQueue(
  queue: DispatchJobRetryQueueLike | null | undefined,
  rawEnvelope: {
    readonly idempotencyKey: string;
    readonly topic: string;
    readonly tenantId: string | null;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string | null;
    readonly enqueuedAt: number;
  },
): Promise<DispatchJobRetryResult> {
  const parsed = JobEnvelopeSchema.parse({
    idempotencyKey: rawEnvelope.idempotencyKey,
    topic: rawEnvelope.topic,
    tenantId: rawEnvelope.tenantId,
    payload: rawEnvelope.payload,
    correlationId: rawEnvelope.correlationId,
    enqueuedAt: rawEnvelope.enqueuedAt,
  });

  const envelope: JobEnvelope = {
    idempotencyKey: parsed.idempotencyKey,
    topic: parsed.topic,
    tenantId: parsed.tenantId,
    payload: parsed.payload,
    maxAttempts: parsed.maxAttempts ?? 3,
    correlationId: parsed.correlationId,
    enqueuedAt: parsed.enqueuedAt ?? rawEnvelope.enqueuedAt,
  };

  if (!queue) {
    return { dispatched: false, envelope };
  }

  await queue.send(envelope);
  return { dispatched: true, envelope };
}

export interface CreateDomainRecoveryQueueHandlerOptions {
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly cloudflareFetch?: typeof fetch;
  readonly dnsResolver?: DnsResolverPort | null;
  readonly dnsFetch?: typeof fetch;
  readonly cnameTarget?: string;
}

function resolveRecoveryCloudflareClient(
  ctx: JobExecutionContext<Record<string, unknown>>,
  options: CreateDomainRecoveryQueueHandlerOptions,
): CloudflareSaasClient {
  if (options.cloudflareClient) return options.cloudflareClient;
  const rawEnv = ctx.env as typeof ctx.env & {
    readonly CF_SAAS_ZONE_ID?: string;
    readonly CF_SAAS_API_TOKEN?: string;
    readonly CF_API_BASE_URL?: string;
  };
  const zoneId = rawEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = rawEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) {
    throw new NonRetryableJobError(
      "Cloudflare for SaaS credentials not configured",
      "CF_CONFIG_MISSING",
    );
  }
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: rawEnv.CF_API_BASE_URL,
    fetchImpl: options.cloudflareFetch,
  });
}

function resolveRecoveryCnameTarget(
  ctx: JobExecutionContext<Record<string, unknown>>,
  options: CreateDomainRecoveryQueueHandlerOptions,
): string {
  if (options.cnameTarget?.trim()) {
    return options.cnameTarget.trim().toLowerCase().replace(/\.$/, "");
  }
  const rawEnv = ctx.env as typeof ctx.env & {
    readonly SAAS_CNAME_TARGET?: string;
    readonly SAAS_ZONE?: string;
  };
  const explicit = rawEnv.SAAS_CNAME_TARGET?.trim().toLowerCase().replace(/\.$/, "");
  if (explicit) return explicit;
  const zone = rawEnv.SAAS_ZONE?.trim().toLowerCase().replace(/\.$/, "");
  return zone ? `cname.${zone}` : DEFAULT_SAAS_CNAME_TARGET;
}

/**
 * Durable queue handler for `recovery.domain_recheck` with provider-timeout safety and
 * pre-retry reconciliation (`reconcile()`).
 */
export function createDomainRecoveryQueueHandler(
  options: CreateDomainRecoveryQueueHandlerOptions = {},
): DurableJobHandler<Record<string, unknown>> {
  async function syncObservedState(
    ctx: JobExecutionContext<Record<string, unknown>>,
    provider: CloudflareCustomHostname,
  ): Promise<void> {
    if (!ctx.tenantId) {
      throw new NonRetryableJobError("Missing tenantId for domain recovery", "MISSING_TENANT_ID");
    }
    const hostname =
      typeof ctx.payload.hostname === "string" ? ctx.payload.hostname.trim().toLowerCase() : "";
    const existing = await getTenantDomainBySelector(ctx.env.PLATFORM_DB, ctx.tenantId, hostname);
    if (!existing || existing.kind !== "custom") {
      throw new NonRetryableJobError("Custom domain not found for tenant", "DOMAIN_NOT_FOUND");
    }

    const cnameTarget = resolveRecoveryCnameTarget(ctx, options);
    const dnsResolver =
      options.dnsResolver === null
        ? null
        : options.dnsResolver ?? createCloudflareDohDnsResolver({ fetchImpl: options.dnsFetch });

    const cnameTargets = dnsResolver
      ? await dnsResolver.resolveCname(existing.hostname).catch(() => [])
      : [];
    const cnameMatches = doesCnameMatchTarget(cnameTargets, cnameTarget);
    const connectMode = existing.connectMode ?? "new_domain";
    const rawSslMethod = ctx.payload.sslMethod;
    const payloadSslMethod: DomainSslMethod | undefined =
      rawSslMethod === "http" || rawSslMethod === "txt" ? rawSslMethod : undefined;
    const sslMethod: DomainSslMethod =
      payloadSslMethod ??
      existing.sslMethod ??
      (connectMode === "zero_downtime_migration" ? "txt" : "http");

    await syncDomainProviderState(ctx.env.PLATFORM_DB, {
      tenantId: ctx.tenantId,
      hostname: existing.hostname,
      connectMode,
      sslMethod,
      provider,
      cnameMatchesTarget: cnameMatches,
      dnsTargetObserved: cnameTargets[0] ?? null,
      expectedVersion: existing.version,
      isManualRecheck: true,
      nowMs: ctx.nowMs,
    });
  }

  return {
    maxAttempts: 3,
    leaseDurationMs: 60_000,

    async reconcile(ctx) {
      if (!ctx.tenantId || typeof ctx.payload.hostname !== "string") {
        return { state: "not_applied" };
      }
      const hostname = ctx.payload.hostname.trim().toLowerCase();
      const existing = await getTenantDomainBySelector(ctx.env.PLATFORM_DB, ctx.tenantId, hostname);
      if (!existing || existing.kind !== "custom") {
        return { state: "not_applied" };
      }

      const cf = resolveRecoveryCloudflareClient(ctx, options);
      try {
        const provider = existing.cfCustomHostnameId
          ? await cf.getCustomHostname(existing.cfCustomHostnameId)
          : await cf.findCustomHostnameByName(existing.hostname);

        if (!provider) {
          return { state: "not_applied" };
        }

        await syncObservedState(ctx, provider);
        if (provider.status === "active" && provider.ssl.status === "active") {
          return { state: "completed", externalReference: provider.id };
        }
        return { state: "pending", retryAfterSeconds: 30 };
      } catch (err) {
        if (err instanceof DomainProviderError && err.retryable) {
          return { state: "pending", retryAfterSeconds: 30 };
        }
        return { state: "not_applied" };
      }
    },

    async execute(ctx) {
      if (!ctx.tenantId) {
        throw new NonRetryableJobError("Missing tenantId for domain recovery", "MISSING_TENANT_ID");
      }
      const hostname =
        typeof ctx.payload.hostname === "string"
          ? ctx.payload.hostname.trim().toLowerCase().replace(/\.$/, "")
          : "";
      if (!hostname) {
        throw new NonRetryableJobError("Missing hostname in payload", "INVALID_HOSTNAME");
      }

      const existing = await getTenantDomainBySelector(ctx.env.PLATFORM_DB, ctx.tenantId, hostname);
      if (!existing || existing.kind !== "custom") {
        throw new NonRetryableJobError("Custom domain not found for tenant", "DOMAIN_NOT_FOUND");
      }
      if (existing.status === "deleting") {
        throw new NonRetryableJobError("Domain is deleting", "DOMAIN_DELETING");
      }

      const cf = resolveRecoveryCloudflareClient(ctx, options);
      const connectMode = existing.connectMode ?? "new_domain";
      const rawSslMethod = ctx.payload.sslMethod;
      const payloadSslMethod: DomainSslMethod | undefined =
        rawSslMethod === "http" || rawSslMethod === "txt" ? rawSslMethod : undefined;
      const sslMethod: DomainSslMethod =
        payloadSslMethod ??
        existing.sslMethod ??
        (connectMode === "zero_downtime_migration" ? "txt" : "http");

      try {
        let provider: CloudflareCustomHostname;
        if (existing.cfCustomHostnameId) {
          provider = await cf.patchCustomHostnameSsl(existing.cfCustomHostnameId, {
            method: sslMethod,
            type: "dv",
            minTlsVersion: "1.2",
          });
        } else {
          const found = await cf.findCustomHostnameByName(existing.hostname);
          provider =
            found ??
            (await cf.createCustomHostname({
              hostname: existing.hostname,
              sslMethod,
            }));
        }

        await syncObservedState(ctx, provider);
      } catch (err) {
        if (err instanceof DomainProviderError) {
          if (err.retryable) {
            throw new UncertainProviderEffectError(
              "Cloudflare provider timeout/outage during domain recovery",
              {
                code: `PROVIDER_${err.kind.toUpperCase()}`,
                provider: "cloudflare_saas",
                retryAfterSeconds: 30,
                reconcileImmediately: false,
              },
            );
          }
          throw new NonRetryableJobError(err.message, `PROVIDER_${err.kind.toUpperCase()}`);
        }
        throw err;
      }
    },
  };
}

export function createRecoveryJobRegistry(
  options: CreateDomainRecoveryQueueHandlerOptions = {},
): DurableJobRegistry {
  return {
    [RECOVERY_DOMAIN_RECHECK_TOPIC]: createDomainRecoveryQueueHandler(options),
  };
}
