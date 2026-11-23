import {
  DEFAULT_MAX_JOB_ATTEMPTS,
  NonRetryableJobError,
  parseJobEnvelope,
  redactJobLogRecord,
} from "@punyasitus/core/jobs/index";
import {
  buildIndexNowBatchIdempotencyKey,
  buildIndexNowKeyLocation,
  buildIndexNowSubmissionPayload,
  evaluateIndexNowEligibility,
  generateIndexNowKey,
  isValidIndexNowKey,
  normalizeAndDeduplicateIndexNowUrls,
  submitIndexNowBatch,
  type IndexNowSkipReason,
} from "@punyasitus/core/seo/indexnow";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { enqueueDurableJob, releaseUnstartedQueuedJob } from "@punyasitus/db/jobs/index";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import { computeEffectiveTenantStatus } from "@punyasitus/db/routing/index";
import type { TenantStatus } from "@punyasitus/db/platform";
import type { JobQueuePayload, PunyasitusEnv } from "../../env.d.ts";
import type {
  DurableJobHandler,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

/**
 * Verified Custom-Domain `IndexNow` Queue & Cron Flush Engine (REQ-095, PLAN §19.6, TASK-095).
 *
 * Invariants:
 * - Stores each tenant's cryptographic 32-hex `indexnowKey` and pending URL buffer inside
 *   the tenant's own `TenantStore` (`installed_plugins` row `plugin_id = 'seo-ai-autopilot'`),
 *   keeping tenant state strictly isolated with zero schema migrations.
 * - Strictly skips `.situsku.click` trial/subdomain sites, unverified custom domains,
 *   `noindex` sites, disabled `seo-ai-autopilot`, and `suspended`/`recovery`/`purged` tenants.
 * - Deduplicates repeated CMS and confirmed MCP publish events into ONE IndexNow batch POST
 *   via deterministic SHA-256 `job_ledger` idempotency keys + URL deduplication.
 */

export const SEO_AUTOPILOT_PLUGIN_ID = "seo-ai-autopilot" as const;
export const SEO_INDEXNOW_PING_TOPIC = "seo.indexnow_ping" as const;
export const SEO_INDEXNOW_FLUSH_TOPIC = "seo.indexnow_flush" as const;

export type IndexNowPublishSource = "cms" | "mcp" | "cron";

export interface TenantSeoPluginConfig {
  readonly enabled: boolean;
  readonly indexnowKey: string | null;
  readonly pendingIndexNowUrls: readonly string[];
  readonly lastIndexNowPingAt: number | null;
  readonly lastIndexNowStatus: "accepted" | "failed" | null;
  readonly lastIndexNowUrlCount: number;
  readonly rawConfig: Record<string, unknown>;
}

interface InstalledPluginRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly enabled: number;
  readonly config_json: string;
}

interface EligibleTenantPlatformRow {
  readonly id: string;
  readonly handle: string;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly primary_host: string | null;
  readonly primary_host_kind: "subdomain" | "custom" | null;
  readonly primary_host_status: "pending" | "active" | "failed" | "moved" | "deleting" | null;
  readonly primary_host_ssl_status: string | null;
  readonly primary_host_verified_at: number | null;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Ignore corrupt JSON and fall back cleanly
  }
  return {};
}

/**
 * Reads the tenant's `seo-ai-autopilot` plugin config (IndexNow key + pending URL buffer)
 * from the tenant's isolated `TenantStore`.
 */
export async function readTenantSeoPluginConfig(
  tenantDb: D1Database,
): Promise<TenantSeoPluginConfig> {
  try {
    const row = await tenantDb
      .prepare(
        `SELECT plugin_id, version, enabled, config_json
         FROM installed_plugins
         WHERE plugin_id = ?
         LIMIT 1`,
      )
      .bind(SEO_AUTOPILOT_PLUGIN_ID)
      .first<InstalledPluginRow>();

    if (!row) {
      return {
        enabled: true,
        indexnowKey: null,
        pendingIndexNowUrls: [],
        lastIndexNowPingAt: null,
        lastIndexNowStatus: null,
        lastIndexNowUrlCount: 0,
        rawConfig: {},
      };
    }

    const rawConfig = parseJsonRecord(row.config_json);
    const keyCandidate = rawConfig.indexnowKey;
    const indexnowKey = isValidIndexNowKey(keyCandidate) ? keyCandidate : null;
    const rawPending = Array.isArray(rawConfig.pendingIndexNowUrls)
      ? rawConfig.pendingIndexNowUrls.filter((u): u is string => typeof u === "string")
      : [];
    const lastPingAt =
      typeof rawConfig.lastIndexNowPingAt === "number" &&
      Number.isFinite(rawConfig.lastIndexNowPingAt)
        ? rawConfig.lastIndexNowPingAt
        : null;
    const lastStatus =
      rawConfig.lastIndexNowStatus === "accepted" || rawConfig.lastIndexNowStatus === "failed"
        ? rawConfig.lastIndexNowStatus
        : null;
    const lastCount =
      typeof rawConfig.lastIndexNowUrlCount === "number" &&
      Number.isFinite(rawConfig.lastIndexNowUrlCount) &&
      rawConfig.lastIndexNowUrlCount >= 0
        ? Math.floor(rawConfig.lastIndexNowUrlCount)
        : 0;

    return {
      enabled: Number(row.enabled) !== 0,
      indexnowKey,
      pendingIndexNowUrls: rawPending,
      lastIndexNowPingAt: lastPingAt,
      lastIndexNowStatus: lastStatus,
      lastIndexNowUrlCount: lastCount,
      rawConfig,
    };
  } catch {
    return {
      enabled: true,
      indexnowKey: null,
      pendingIndexNowUrls: [],
      lastIndexNowPingAt: null,
      lastIndexNowStatus: null,
      lastIndexNowUrlCount: 0,
      rawConfig: {},
    };
  }
}

async function writeTenantSeoPluginConfig(
  tenantDb: D1Database,
  nextConfig: Record<string, unknown>,
  options: { readonly enabled?: boolean; readonly nowMs?: number } = {},
): Promise<void> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const enabledFlag = options.enabled === false ? 0 : 1;
  const serialized = JSON.stringify(nextConfig);

  await tenantDb
    .prepare(
      `INSERT INTO installed_plugins (
         plugin_id,
         version,
         enabled,
         config_json,
         schema_version,
         installed_at,
         updated_at
       )
       VALUES (?, '1.0.0', ?, ?, 0, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    )
    .bind(SEO_AUTOPILOT_PLUGIN_ID, enabledFlag, serialized, nowMs, nowMs)
    .run();
}

/**
 * Ensures the tenant has a persisted cryptographic 32-hex `indexnowKey` in `TenantStore`.
 * Never overwrites an existing valid key unless `rotate: true` is explicitly passed.
 */
export async function ensureTenantIndexNowKey(
  tenantDb: D1Database,
  options: {
    readonly nowMs?: number;
    readonly rotate?: boolean;
    readonly keyOverride?: string;
  } = {},
): Promise<{ readonly key: string; readonly created: boolean }> {
  const current = await readTenantSeoPluginConfig(tenantDb);
  if (!options.rotate && current.indexnowKey && isValidIndexNowKey(current.indexnowKey)) {
    return { key: current.indexnowKey, created: false };
  }

  const nextKey =
    options.keyOverride && isValidIndexNowKey(options.keyOverride)
      ? options.keyOverride
      : generateIndexNowKey();

  const merged: Record<string, unknown> = {
    ...current.rawConfig,
    indexnowKey: nextKey,
  };
  await writeTenantSeoPluginConfig(tenantDb, merged, {
    enabled: current.enabled,
    nowMs: options.nowMs,
  });

  return { key: nextKey, created: true };
}

async function loadTenantPlatformRow(
  platformDb: D1Database,
  tenantId: string,
): Promise<EligibleTenantPlatformRow | null> {
  return platformDb
    .prepare(
      `SELECT
         t.id AS id,
         t.handle AS handle,
         t.status AS status,
         t.operator_hold AS operator_hold,
         t.trial_ends_at AS trial_ends_at,
         t.paid_through AS paid_through,
         ph.host AS primary_host,
         ph.kind AS primary_host_kind,
         ph.status AS primary_host_status,
         ph.ssl_status AS primary_host_ssl_status,
         ph.verified_at AS primary_host_verified_at
       FROM tenants t
       LEFT JOIN tenant_hosts ph
         ON ph.tenant_id = t.id
         AND ph.is_primary = 1
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<EligibleTenantPlatformRow>();
}

async function resolveTenantIndexNowContext(
  platformDb: D1Database,
  tenantDb: D1Database,
  tenantId: string,
  options: { readonly nowMs?: number; readonly saasZone?: string } = {},
): Promise<
  | {
      readonly eligible: true;
      readonly host: string;
      readonly origin: string;
      readonly config: TenantSeoPluginConfig;
    }
  | {
      readonly eligible: false;
      readonly reason: IndexNowSkipReason | "tenant_not_found";
    }
> {
  const row = await loadTenantPlatformRow(platformDb, tenantId);
  if (!row) {
    return { eligible: false, reason: "tenant_not_found" };
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold: row.operator_hold === 1,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );

  const [publishedSiteSettings, pluginConfig] = await Promise.all([
    getPublishedResource(tenantDb, {
      resourceType: "site_settings",
      resourceId: 1,
    }).catch(() => null),
    readTenantSeoPluginConfig(tenantDb),
  ]);

  const eligibility = evaluateIndexNowEligibility({
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    primaryHost: row.primary_host,
    primaryHostKind: row.primary_host_kind,
    primaryHostStatus: row.primary_host_status,
    primaryHostSslStatus: row.primary_host_ssl_status,
    primaryHostVerified:
      row.primary_host_kind === "custom" &&
      row.primary_host_status === "active" &&
      row.primary_host_ssl_status === "active" &&
      row.primary_host_verified_at !== null,
    siteVisibility: publishedSiteSettings?.data.siteVisibility ?? "public",
    seoAutopilotEnabled: pluginConfig.enabled,
    saasZone: options.saasZone,
  });

  if (!eligibility.eligible) {
    return eligibility;
  }

  return {
    eligible: true,
    host: eligibility.host,
    origin: eligibility.origin,
    config: pluginConfig,
  };
}

export interface EnqueueIndexNowPublishPingInput {
  readonly tenantId: string;
  readonly urls: readonly string[];
  readonly source: IndexNowPublishSource;
  readonly dedupBucket?: string;
  readonly windowMs?: number;
  readonly nowMs?: number;
  readonly saasZone?: string;
}

export type EnqueueIndexNowPublishPingResult =
  | {
      readonly enqueued: true;
      readonly deduplicated: false;
      readonly idempotencyKey: string;
      readonly host: string;
      readonly keyLocation: string;
      readonly urlList: readonly string[];
      readonly source: IndexNowPublishSource;
    }
  | {
      readonly enqueued: false;
      readonly deduplicated: true;
      readonly idempotencyKey: string;
      readonly host: string;
      readonly keyLocation: string;
      readonly urlList: readonly string[];
      readonly source: IndexNowPublishSource;
    }
  | {
      readonly enqueued: false;
      readonly deduplicated: false;
      readonly skippedReason: IndexNowSkipReason | "tenant_not_found" | "no_valid_urls";
    };

export interface IndexNowEnqueueEnv {
  readonly PLATFORM_DB: D1Database;
  readonly JOBS_QUEUE: { readonly send: (message: JobQueuePayload) => Promise<unknown> };
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly tenantDb?: D1Database | null;
}

function resolveTenantDb(env: {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly tenantDb?: D1Database | null;
}, tenantId: string): D1Database | null {
  if (env.tenantDb) return env.tenantDb;
  if (!env.TENANT_STORE) return null;
  return createTenantDb(openTenantStoreStub(env.TENANT_STORE, tenantId));
}

/**
 * Enqueues a deduplicated `seo.indexnow_ping` job after a CMS publish/unpublish
 * OR a confirmed MCP publish.
 *
 * Strictly skipped on `.situsku.click` trial/subdomain sites and non-indexable tenants.
 */
export async function enqueueIndexNowPublishPing(
  env: IndexNowEnqueueEnv,
  input: EnqueueIndexNowPublishPingInput,
): Promise<EnqueueIndexNowPublishPingResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tenantDb = resolveTenantDb(env, input.tenantId);
  if (!tenantDb) {
    return { enqueued: false, deduplicated: false, skippedReason: "tenant_not_found" };
  }

  const ctx = await resolveTenantIndexNowContext(env.PLATFORM_DB, tenantDb, input.tenantId, {
    nowMs,
    saasZone: input.saasZone,
  });
  if (!ctx.eligible) {
    return { enqueued: false, deduplicated: false, skippedReason: ctx.reason };
  }

  const urlList = normalizeAndDeduplicateIndexNowUrls(ctx.host, input.urls);
  if (urlList.length === 0) {
    return { enqueued: false, deduplicated: false, skippedReason: "no_valid_urls" };
  }

  const { key } = await ensureTenantIndexNowKey(tenantDb, { nowMs });
  const keyLocation = buildIndexNowKeyLocation(ctx.host, key);

  // Merge URLs into TenantStore pending buffer for cron-flush resilience
  const refreshedConfig = await readTenantSeoPluginConfig(tenantDb);
  const mergedPending = normalizeAndDeduplicateIndexNowUrls(ctx.host, [
    ...refreshedConfig.pendingIndexNowUrls,
    ...urlList,
  ]);
  await writeTenantSeoPluginConfig(
    tenantDb,
    {
      ...refreshedConfig.rawConfig,
      indexnowKey: key,
      pendingIndexNowUrls: mergedPending,
    },
    { enabled: refreshedConfig.enabled, nowMs },
  );

  const idempotencyKey = await buildIndexNowBatchIdempotencyKey({
    tenantId: input.tenantId,
    host: ctx.host,
    urls: urlList,
    dedupBucket: input.dedupBucket,
    nowMs,
    windowMs: input.windowMs,
  });

  const envelope = parseJobEnvelope(
    {
      idempotencyKey,
      topic: SEO_INDEXNOW_PING_TOPIC,
      tenantId: input.tenantId,
      payload: {
        host: ctx.host,
        urls: urlList,
        source: input.source,
      },
      maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
      correlationId: idempotencyKey,
      enqueuedAt: nowMs,
    },
    { nowMs },
  );

  const ledgerRes = await enqueueDurableJob(env.PLATFORM_DB, {
    idempotencyKey: envelope.idempotencyKey,
    topic: envelope.topic,
    tenantId: envelope.tenantId,
    payload: envelope.payload,
    nowMs,
  });

  if (!ledgerRes.enqueued) {
    return {
      enqueued: false,
      deduplicated: true,
      idempotencyKey,
      host: ctx.host,
      keyLocation,
      urlList,
      source: input.source,
    };
  }

  try {
    await env.JOBS_QUEUE.send(envelope as unknown as JobQueuePayload);
  } catch (err) {
    await releaseUnstartedQueuedJob(env.PLATFORM_DB, envelope.idempotencyKey);
    throw err;
  }

  return {
    enqueued: true,
    deduplicated: false,
    idempotencyKey,
    host: ctx.host,
    keyLocation,
    urlList,
    source: input.source,
  };
}

export interface SeoIndexNowPingJobPayload {
  readonly host?: string;
  readonly urls?: readonly string[];
  readonly source?: IndexNowPublishSource;
}

export interface CreateSeoIndexNowHandlerOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly saasZone?: string;
  readonly logger?: StructuredJobLogger;
  readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
}

async function flushTenantIndexNowUrls(params: {
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly tenantId: string;
  readonly extraUrls?: readonly string[];
  readonly source: IndexNowPublishSource;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly saasZone?: string;
  readonly logger: StructuredJobLogger;
}): Promise<{
  readonly submitted: boolean;
  readonly submittedCount: number;
  readonly skippedReason?: string;
}> {
  const ctx = await resolveTenantIndexNowContext(
    params.platformDb,
    params.tenantDb,
    params.tenantId,
    { nowMs: params.nowMs, saasZone: params.saasZone },
  );

  if (!ctx.eligible) {
    params.logger(
      redactJobLogRecord({
        event: "seo.indexnow_skipped",
        tenantId: params.tenantId,
        source: params.source,
        reason: ctx.reason,
        timestamp: params.nowMs,
      }),
    );
    return { submitted: false, submittedCount: 0, skippedReason: ctx.reason };
  }

  const candidateUrls = [
    ...ctx.config.pendingIndexNowUrls,
    ...(params.extraUrls ?? []),
  ];
  const dedupedUrls = normalizeAndDeduplicateIndexNowUrls(ctx.host, candidateUrls);
  if (dedupedUrls.length === 0) {
    return { submitted: false, submittedCount: 0, skippedReason: "no_valid_urls" };
  }

  const { key } = await ensureTenantIndexNowKey(params.tenantDb, { nowMs: params.nowMs });
  const payload = buildIndexNowSubmissionPayload({
    host: ctx.host,
    key,
    urls: dedupedUrls,
  });

  const result = await submitIndexNowBatch(payload, {
    fetchImpl: params.fetchImpl,
    endpoint: params.endpoint,
  });

  if (!result.ok) {
    await writeTenantSeoPluginConfig(
      params.tenantDb,
      {
        ...ctx.config.rawConfig,
        indexnowKey: key,
        pendingIndexNowUrls: dedupedUrls,
        lastIndexNowPingAt: params.nowMs,
        lastIndexNowStatus: "failed",
      },
      { enabled: ctx.config.enabled, nowMs: params.nowMs },
    );

    if (!result.retryable) {
      throw new NonRetryableJobError(result.message, result.code);
    }
    const retryableErr = new Error(result.message);
    retryableErr.name = result.code;
    throw retryableErr;
  }

  const submittedSet = new Set(payload.urlList);
  const remainingPending = ctx.config.pendingIndexNowUrls.filter((u) => !submittedSet.has(u));
  await writeTenantSeoPluginConfig(
    params.tenantDb,
    {
      ...ctx.config.rawConfig,
      indexnowKey: key,
      pendingIndexNowUrls: remainingPending,
      lastIndexNowPingAt: params.nowMs,
      lastIndexNowStatus: "accepted",
      lastIndexNowUrlCount: result.submittedCount,
    },
    { enabled: ctx.config.enabled, nowMs: params.nowMs },
  );

  params.logger(
    redactJobLogRecord({
      event: "seo.indexnow_submitted",
      tenantId: params.tenantId,
      host: ctx.host,
      source: params.source,
      submittedCount: result.submittedCount,
      httpStatus: result.status,
      timestamp: params.nowMs,
    }),
  );

  return { submitted: true, submittedCount: result.submittedCount };
}

/**
 * Creates the durable Cloudflare Queue handler for `seo.indexnow_ping`.
 */
export function createSeoIndexNowPingHandler(
  options: CreateSeoIndexNowHandlerOptions = {},
): DurableJobHandler<SeoIndexNowPingJobPayload> {
  const logger = options.logger ?? defaultLogger;

  return {
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
    async execute(ctx: JobExecutionContext<SeoIndexNowPingJobPayload>): Promise<void> {
      if (!ctx.tenantId) {
        throw new NonRetryableJobError(
          "seo.indexnow_ping requires a tenantId.",
          "MISSING_TENANT_ID",
        );
      }

      const tenantDb =
        options.resolveTenantDb?.(ctx.tenantId) ??
        resolveTenantDb(
          {
            TENANT_STORE: ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
          },
          ctx.tenantId,
        );

      if (!tenantDb) {
        throw new Error("TENANT_STORE_UNAVAILABLE");
      }

      const payloadUrls = Array.isArray(ctx.payload?.urls)
        ? ctx.payload.urls.filter((u): u is string => typeof u === "string")
        : [];
      const source: IndexNowPublishSource =
        ctx.payload?.source === "mcp" || ctx.payload?.source === "cron"
          ? ctx.payload.source
          : "cms";

      await flushTenantIndexNowUrls({
        platformDb: ctx.env.PLATFORM_DB,
        tenantDb,
        tenantId: ctx.tenantId,
        extraUrls: payloadUrls,
        source,
        nowMs: ctx.nowMs,
        fetchImpl: options.fetchImpl,
        endpoint: options.endpoint,
        saasZone: options.saasZone ?? ctx.env.SAAS_ZONE,
        logger,
      });
    },
  };
}

export interface SeoIndexNowCronFlushResult {
  readonly scannedTenants: number;
  readonly flushedTenants: number;
  readonly submittedUrls: number;
  readonly skippedTenants: number;
}

/**
 * Scans active/grace/locked tenants with verified primary custom domains and flushes
 * any buffered `pendingIndexNowUrls` in ONE deduplicated IndexNow batch per tenant.
 */
export async function runSeoIndexNowCronFlush(params: {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly resolveTenantDb?: (tenantId: string) => D1Database | null;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly saasZone?: string;
  readonly nowMs?: number;
  readonly limit?: number;
  readonly logger?: StructuredJobLogger;
}): Promise<SeoIndexNowCronFlushResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const limit = Math.max(1, Math.min(500, Math.floor(params.limit ?? 100)));
  const logger = params.logger ?? defaultLogger;

  const candidates = await params.platformDb
    .prepare(
      `SELECT t.id AS id
       FROM tenants t
       INNER JOIN tenant_hosts ph
         ON ph.tenant_id = t.id
         AND ph.is_primary = 1
         AND ph.kind = 'custom'
         AND ph.status = 'active'
         AND ph.ssl_status = 'active'
       WHERE t.status IN ('active', 'grace', 'locked')
         AND t.operator_hold = 0
       ORDER BY t.updated_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ readonly id: string }>();

  let flushedTenants = 0;
  let submittedUrls = 0;
  let skippedTenants = 0;

  for (const row of candidates.results) {
    const tenantDb =
      params.resolveTenantDb?.(row.id) ??
      resolveTenantDb({ TENANT_STORE: params.tenantStore }, row.id);
    if (!tenantDb) {
      skippedTenants += 1;
      continue;
    }

    const res = await flushTenantIndexNowUrls({
      platformDb: params.platformDb,
      tenantDb,
      tenantId: row.id,
      source: "cron",
      nowMs,
      fetchImpl: params.fetchImpl,
      endpoint: params.endpoint,
      saasZone: params.saasZone,
      logger,
    });

    if (res.submitted) {
      flushedTenants += 1;
      submittedUrls += res.submittedCount;
    } else {
      skippedTenants += 1;
    }
  }

  return {
    scannedTenants: candidates.results.length,
    flushedTenants,
    submittedUrls,
    skippedTenants,
  };
}

/**
 * Creates the durable Cloudflare Queue handler for `seo.indexnow_flush` (triggered by Cron).
 */
export function createSeoIndexNowCronFlushHandler(
  options: CreateSeoIndexNowHandlerOptions = {},
): DurableJobHandler<{ readonly limit?: number }> {
  return {
    maxAttempts: 3,
    async execute(ctx: JobExecutionContext<{ readonly limit?: number }>): Promise<void> {
      const env = ctx.env as Pick<PunyasitusEnv, "PLATFORM_DB"> &
        Partial<Pick<PunyasitusEnv, "TENANT_STORE" | "SAAS_ZONE">>;

      await runSeoIndexNowCronFlush({
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
        resolveTenantDb: options.resolveTenantDb,
        fetchImpl: options.fetchImpl,
        endpoint: options.endpoint,
        saasZone: options.saasZone ?? env.SAAS_ZONE,
        nowMs: ctx.nowMs,
        limit: typeof ctx.payload?.limit === "number" ? ctx.payload.limit : undefined,
        logger: options.logger,
      });
    },
  };
}
