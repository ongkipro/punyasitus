import {
  DEFAULT_SAAS_CNAME_TARGET,
  createCloudflareSaasClient,
  type CloudflareCustomHostnameQuota,
  type CloudflareSaasClient,
} from "@punyasitus/core/domains/index";
import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  STALE_HOSTNAME_REAPER_THRESHOLD_MS,
  finalizeDomainRemoval,
  listStaleCustomHostnamesForReaper,
  type StaleHostnameReaperCandidate,
} from "@punyasitus/db/domains/index";
import type {
  DurableJobHandler,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

/**
 * 7-Day Stale-Hostname Reaper (REQ-004, PLAN §3.1, §3.2 & §12.2).
 *
 * Deletes abandoned `pending`, `moved`, and `failed` custom hostnames older than 7 days
 * from Cloudflare for SaaS (stopping $0.10/month billing), releases the local `PLATFORM_DB`
 * claim cleanly with an append-only `platform_audit` record, bumps `tenants.cache_version`,
 * evicts isolate host cache, and monitors `/custom_hostnames/quota`.
 */

export const DOMAIN_STALE_REAPER_TOPIC = "domains.stale_reaper" as const;

export interface DomainReaperJobPayload {
  readonly nowMs?: number;
  readonly staleAfterMs?: number;
  readonly limit?: number;
}

export interface ReapedHostnameOutcome {
  readonly host: string;
  readonly tenantId: string;
  readonly previousStatus: string;
  readonly cfCustomHostnameId: string | null;
  readonly ageDays: number;
  readonly outcome: "reaped" | "failed_provider";
  readonly providerAlreadyAbsent?: boolean;
  readonly errorCode?: string;
}

export interface StaleHostnameReaperResult {
  readonly scanned: number;
  readonly reaped: number;
  readonly failed: number;
  readonly quota: CloudflareCustomHostnameQuota | null;
  readonly items: readonly ReapedHostnameOutcome[];
}

export interface RunStaleHostnameReaperOptions {
  readonly platformDb: D1Database;
  readonly cloudflareClient: CloudflareSaasClient;
  readonly nowMs?: number;
  readonly staleAfterMs?: number;
  readonly limit?: number;
  readonly requestId?: string;
  readonly logger?: StructuredJobLogger;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function buildReaperRequestId(nowMs: number): string {
  return `reaper_${Math.trunc(nowMs)}`;
}

async function reapSingleCandidate(
  candidate: StaleHostnameReaperCandidate,
  options: {
    readonly platformDb: D1Database;
    readonly cloudflareClient: CloudflareSaasClient;
    readonly nowMs: number;
    readonly requestId: string;
  },
): Promise<ReapedHostnameOutcome> {
  let providerAlreadyAbsent = false;

  if (candidate.cfCustomHostnameId) {
    try {
      const delRes = await options.cloudflareClient.deleteCustomHostname(
        candidate.cfCustomHostnameId,
      );
      providerAlreadyAbsent = delRes.alreadyAbsent;
    } catch (err) {
      const errorCode =
        err instanceof Error && "kind" in err
          ? `CF_${String((err as { kind?: unknown }).kind).toUpperCase()}`
          : "CF_DELETE_FAILED";
      return {
        host: candidate.host,
        tenantId: candidate.tenantId,
        previousStatus: candidate.status,
        cfCustomHostnameId: candidate.cfCustomHostnameId,
        ageDays: candidate.ageDays,
        outcome: "failed_provider",
        errorCode,
      };
    }
  }

  await finalizeDomainRemoval(options.platformDb, {
    tenantId: candidate.tenantId,
    hostname: candidate.host,
    cfCustomHostnameId: candidate.cfCustomHostnameId,
    actorUserId: null,
    actorRole: "system_reaper",
    requestId: options.requestId,
    action: "domain.reaper.deleted",
    reason:
      candidate.status === "deleting"
        ? "Completed pending custom hostname deletion cleanup"
        : `Stale custom hostname (${candidate.status}) exceeded 7-day reaper window`,
    extraMetadata: {
      previousStatus: candidate.status,
      ageDays: candidate.ageDays,
      providerAlreadyAbsent,
    },
    nowMs: options.nowMs,
  });

  return {
    host: candidate.host,
    tenantId: candidate.tenantId,
    previousStatus: candidate.status,
    cfCustomHostnameId: candidate.cfCustomHostnameId,
    ageDays: candidate.ageDays,
    outcome: "reaped",
    providerAlreadyAbsent,
  };
}

export async function runStaleHostnameReaper(
  options: RunStaleHostnameReaperOptions,
): Promise<StaleHostnameReaperResult> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestId = options.requestId ?? buildReaperRequestId(nowMs);
  const logger = options.logger ?? defaultLogger;

  const candidates = await listStaleCustomHostnamesForReaper(options.platformDb, {
    nowMs,
    staleAfterMs: options.staleAfterMs ?? STALE_HOSTNAME_REAPER_THRESHOLD_MS,
    limit: options.limit,
  });

  const items: ReapedHostnameOutcome[] = [];
  let reaped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const res = await reapSingleCandidate(candidate, {
      platformDb: options.platformDb,
      cloudflareClient: options.cloudflareClient,
      nowMs,
      requestId,
    });
    items.push(res);
    if (res.outcome === "reaped") {
      reaped += 1;
    } else {
      failed += 1;
    }
  }

  let quota: CloudflareCustomHostnameQuota | null = null;
  try {
    quota = await options.cloudflareClient.getCustomHostnameQuota();
  } catch {
    // Non-fatal: quota remains null if provider endpoint is temporarily unavailable
  }

  logger(
    redactJobLogRecord({
      event: "domains.stale_reaper.completed",
      requestId,
      scanned: candidates.length,
      reaped,
      failed,
      cnameTarget: DEFAULT_SAAS_CNAME_TARGET,
      quotaAllocated: quota?.allocated ?? null,
      quotaUsed: quota?.used ?? null,
      timestamp: nowMs,
    }),
  );

  return {
    scanned: candidates.length,
    reaped,
    failed,
    quota,
    items,
  };
}

export interface CreateDomainReaperQueueHandlerOptions {
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly staleAfterMs?: number;
  readonly logger?: StructuredJobLogger;
  readonly onCompleted?: (result: StaleHostnameReaperResult) => Promise<void> | void;
}

function resolveReaperCloudflareClient(
  env: JobExecutionContext["env"],
  explicit?: CloudflareSaasClient | null,
): CloudflareSaasClient | null {
  if (explicit) return explicit;
  const cfEnv = env as typeof env & {
    readonly CF_SAAS_ZONE_ID?: string;
    readonly CF_SAAS_API_TOKEN?: string;
    readonly CF_API_BASE_URL?: string;
  };
  const zoneId = cfEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = cfEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) {
    return null;
  }
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: cfEnv.CF_API_BASE_URL,
  });
}

export function createDomainReaperQueueHandler(
  options: CreateDomainReaperQueueHandlerOptions = {},
): DurableJobHandler<DomainReaperJobPayload> {
  const logger = options.logger ?? defaultLogger;
  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<DomainReaperJobPayload>): Promise<void> {
      const payload = ctx.payload ?? {};
      const nowMs =
        typeof payload.nowMs === "number" && Number.isFinite(payload.nowMs)
          ? Math.trunc(payload.nowMs)
          : ctx.nowMs;
      const cloudflareClient = resolveReaperCloudflareClient(ctx.env, options.cloudflareClient);
      if (!cloudflareClient) {
        logger(
          redactJobLogRecord({
            event: "domains.stale_reaper.skipped_unconfigured",
            idempotencyKey: ctx.idempotencyKey,
            timestamp: nowMs,
          }),
        );
        return;
      }
      const result = await runStaleHostnameReaper({
        platformDb: ctx.env.PLATFORM_DB,
        cloudflareClient,
        nowMs,
        staleAfterMs: payload.staleAfterMs ?? options.staleAfterMs,
        limit: payload.limit,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
        logger,
      });
      if (options.onCompleted) {
        await options.onCompleted(result);
      }
    },
  };
}
