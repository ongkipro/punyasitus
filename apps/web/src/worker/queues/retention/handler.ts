import { redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  replayDeletionTombstones,
  runTenantRetentionSweep,
  type RetentionPolicyMs,
  type TenantRetentionSweepResult,
  type TombstoneReplayResult,
} from "@punyasitus/db/privacy/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

export const RETENTION_SWEEP_TOPIC = "privacy.retention_sweep" as const;
export const HOURLY_HOUSEKEEPING_TOPIC = "cron.hourly_housekeeping" as const;

export interface RetentionSweepJobPayload {
  readonly nowMs?: number;
  readonly pageSize?: number;
  readonly tenantLimit?: number;
  readonly afterTenantId?: string;
  readonly replayTombstones?: boolean;
  readonly preserveTombstoneSubprefixes?: readonly string[];
}

export interface RetentionQueueSummary {
  readonly topic: string;
  readonly idempotencyKey: string;
  readonly tenantsSwept: number;
  readonly tenantResults: readonly TenantRetentionSweepResult[];
  readonly tombstones: TombstoneReplayResult | null;
}

export interface CreateRetentionQueueHandlerOptions {
  readonly policy?: Partial<RetentionPolicyMs>;
  readonly defaultTenantBatchLimit?: number;
  readonly logger?: StructuredJobLogger;
  readonly onSweepCompleted?: (summary: RetentionQueueSummary) => Promise<void> | void;
}

const DEFAULT_TENANT_PAGE_SIZE = 100;

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

function parsePreserveSubprefixes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return valid;
}

async function listSweepableTenantIdsPage(
  platformDb: D1Database,
  afterId: string,
  pageSize: number,
): Promise<readonly string[]> {
  const res = await platformDb
    .prepare(
      `SELECT id FROM tenants
       WHERE status NOT IN ('provisioning', 'purging', 'purged')
         AND schema_version >= 1
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(afterId, pageSize)
    .all<{ id: string }>();
  return res.results.map((r) => r.id);
}

/**
 * Paginates deterministically over ALL sweepable tenants using keyset cursor (`id > ?`)
 * so deployments with > 100 tenants never starve tenants beyond the first page.
 */
async function listAllSweepableTenantIds(
  platformDb: D1Database,
  opts: {
    readonly pageSize: number;
    readonly afterTenantId?: string;
    readonly maxTenants?: number;
  },
): Promise<readonly string[]> {
  const collected: string[] = [];
  let cursor = opts.afterTenantId ?? "";
  const pageSize = Math.max(1, opts.pageSize);
  const maxTenants = opts.maxTenants;

  for (;;) {
    const remaining = maxTenants !== undefined ? maxTenants - collected.length : pageSize;
    if (remaining <= 0) break;
    const take = Math.min(pageSize, remaining);
    const page = await listSweepableTenantIdsPage(platformDb, cursor, take);
    if (page.length === 0) break;
    collected.push(...page);
    cursor = page[page.length - 1]!;
    if (page.length < take) break;
  }

  return collected;
}

/**
 * Creates an idempotent Durable Queue handler for `privacy.retention_sweep`
 * (and compatible with `cron.hourly_housekeeping`), integrating with TASK-028
 * `processDurableQueueBatch`. Executes per-tenant retention sweeps and deletion
 * tombstone replay while emitting strictly PII-free structured telemetry.
 */
export function createRetentionQueueHandler(
  options?: CreateRetentionQueueHandlerOptions,
): DurableJobHandler<RetentionSweepJobPayload> {
  const logger = options?.logger ?? defaultLogger;
  const defaultPageSize = options?.defaultTenantBatchLimit ?? DEFAULT_TENANT_PAGE_SIZE;

  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,

    async execute(ctx: JobExecutionContext<RetentionSweepJobPayload>): Promise<void> {
      const payload = ctx.payload ?? {};
      const effectiveNowMs = parseOptionalPositiveInt(payload.nowMs) ?? ctx.nowMs;
      const pageSize = parseOptionalPositiveInt(payload.pageSize) ?? defaultPageSize;
      const maxTenants = parseOptionalPositiveInt(payload.tenantLimit);
      const afterTenantId =
        typeof payload.afterTenantId === "string" && payload.afterTenantId.trim()
          ? payload.afterTenantId.trim()
          : undefined;
      const shouldReplayTombstones = payload.replayTombstones !== false;
      const preserveSubprefixes = parsePreserveSubprefixes(payload.preserveTombstoneSubprefixes);

      const tenantStoreNs = ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined;
      const mediaBucket = ctx.env.MEDIA_BUCKET ?? null;

      const targetTenantIds: readonly string[] = ctx.tenantId
        ? [ctx.tenantId]
        : await listAllSweepableTenantIds(ctx.env.PLATFORM_DB, {
            pageSize,
            afterTenantId,
            maxTenants,
          });

      const tenantResults: TenantRetentionSweepResult[] = [];

      if (tenantStoreNs) {
        for (const tenantId of targetTenantIds) {
          const stub = openTenantStoreStub(tenantStoreNs, tenantId);
          const schemaState = await stub.schemaState(1);
          if (schemaState.recovery || schemaState.appliedMigrations.length === 0) {
            continue;
          }
          const tenantDb = createTenantDb(stub);
          const sweepRes = await runTenantRetentionSweep({
            tenantDb,
            tenantId,
            mediaBucket,
            nowMs: effectiveNowMs,
            policy: options?.policy,
          });
          tenantResults.push(sweepRes);
        }
      }

      const tombstoneResult = shouldReplayTombstones
        ? await replayDeletionTombstones({
            platformDb: ctx.env.PLATFORM_DB,
            mediaBucket,
            nowMs: effectiveNowMs,
            preserveSubprefixes,
          })
        : null;

      const summary: RetentionQueueSummary = {
        topic: ctx.topic,
        idempotencyKey: ctx.idempotencyKey,
        tenantsSwept: tenantResults.length,
        tenantResults,
        tombstones: tombstoneResult,
      };

      const totals = tenantResults.reduce(
        (acc, item) => ({
          leads: acc.leads + item.deleted.leads,
          leadDedup: acc.leadDedup + item.deleted.leadDedup,
          analyticsEventDedup: acc.analyticsEventDedup + item.deleted.analyticsEventDedup,
          analyticsDaily: acc.analyticsDaily + item.deleted.analyticsDaily,
          analyticsHourlySources: acc.analyticsHourlySources + item.deleted.analyticsHourlySources,
          tenantActivityLog: acc.tenantActivityLog + item.deleted.tenantActivityLog,
          expiredMediaItems: acc.expiredMediaItems + item.deleted.expiredMediaItems,
          r2QuarantineObjects: acc.r2QuarantineObjects + item.deleted.r2QuarantineObjects,
          r2TrashedObjects: acc.r2TrashedObjects + item.deleted.r2TrashedObjects,
          freedStorageBytes: acc.freedStorageBytes + item.freedStorageBytes,
        }),
        {
          leads: 0,
          leadDedup: 0,
          analyticsEventDedup: 0,
          analyticsDaily: 0,
          analyticsHourlySources: 0,
          tenantActivityLog: 0,
          expiredMediaItems: 0,
          r2QuarantineObjects: 0,
          r2TrashedObjects: 0,
          freedStorageBytes: 0,
        },
      );

      // Strictly PII-free structured summary log
      logger(
        redactJobLogRecord({
          event: "privacy.retention_sweep.completed",
          idempotencyKey: ctx.idempotencyKey,
          topic: ctx.topic,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          tenantsSwept: tenantResults.length,
          deletedTotals: totals,
          tombstonesScanned: tombstoneResult?.tombstonesScanned ?? 0,
          tombstoneTenantsRePurged: tombstoneResult?.tenantsRePurged ?? 0,
          tombstoneHostsNeutralized: tombstoneResult?.hostsNeutralized ?? 0,
          tombstoneR2ObjectsDeleted: tombstoneResult?.r2ObjectsDeleted ?? 0,
          timestamp: effectiveNowMs,
        }),
      );

      if (options?.onSweepCompleted) {
        await options.onSweepCompleted(summary);
      }
    },
  };
}

/**
 * Convenience registry fragment binding both `privacy.retention_sweep` and
 * `cron.hourly_housekeeping` to the retention queue handler.
 */
export function createRetentionJobRegistry(
  options?: CreateRetentionQueueHandlerOptions,
): DurableJobRegistry {
  const handler = createRetentionQueueHandler(options) as DurableJobHandler;
  return {
    [RETENTION_SWEEP_TOPIC]: handler,
    [HOURLY_HOUSEKEEPING_TOPIC]: handler,
  };
}
