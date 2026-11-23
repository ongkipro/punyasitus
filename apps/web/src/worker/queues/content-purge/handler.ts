import { DEFAULT_MAX_JOB_ATTEMPTS, redactJobLogRecord } from "@punyasitus/core/jobs/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  sweepExpiredTrashedContent,
  TRASH_RETENTION_MS,
  type ProtectedReferencePurgeFailure,
  type TenantContentPurgeSweepResult,
} from "@punyasitus/db/trash/index";
import {
  DEFAULT_CRON_EXPRESSION,
  type ScheduledCronJobDefinition,
} from "../../cron/index.ts";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";

/**
 * Scheduled 30-Day Content Trash Purge Queue Worker
 * (`apps/web/src/worker/queues/content-purge/handler.ts`; TASK-044, REQ-048, PLAN §11.5).
 *
 * - Runs per-tenant or across all active tenants via deterministic keyset pagination.
 * - Uses `sweepExpiredTrashedContent` to atomically clear taxonomy joins, `resource_slugs`,
 *   and `content_revisions` (TASK-064 ready) while preserving shared media unconditionally.
 * - Surfaces protected-reference purge failures cleanly via redacted structured telemetry
 *   and optional operator alert callback without aborting other eligible items.
 */

export const CONTENT_PURGE_SWEEP_TOPIC = "content.trash_purge_sweep" as const;

export const CONTENT_PURGE_CRON_JOB_DEFINITIONS: readonly ScheduledCronJobDefinition[] = [
  {
    name: "daily-content-trash-purge",
    cron: DEFAULT_CRON_EXPRESSION,
    topic: CONTENT_PURGE_SWEEP_TOPIC,
    cadence: "daily",
    tenantId: null,
    maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
  },
];

export interface ContentPurgeSweepJobPayload {
  readonly nowMs?: number;
  readonly retentionMs?: number;
  readonly pageSize?: number;
  readonly tenantLimit?: number;
  readonly afterTenantId?: string;
}

export interface ContentPurgeQueueSummary {
  readonly topic: string;
  readonly idempotencyKey: string;
  readonly tenantsSwept: number;
  readonly scannedCount: number;
  readonly purgedCount: number;
  readonly skippedConcurrentCount: number;
  readonly blockedCount: number;
  readonly tenantResults: readonly TenantContentPurgeSweepResult[];
  readonly blockedFailures: readonly ProtectedReferencePurgeFailure[];
}

export interface CreateContentPurgeQueueHandlerOptions {
  readonly retentionMs?: number;
  readonly defaultTenantBatchLimit?: number;
  readonly logger?: StructuredJobLogger;
  readonly onProtectedReferenceBlocked?: (
    failure: ProtectedReferencePurgeFailure,
  ) => Promise<void> | void;
  readonly onSweepCompleted?: (summary: ContentPurgeQueueSummary) => Promise<void> | void;
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

async function listSweepableTenantIdsPage(
  platformDb: D1Database,
  afterId: string,
  pageSize: number,
): Promise<readonly string[]> {
  const res = await platformDb
    .prepare(
      `SELECT id FROM tenants
       WHERE status IN ('trial', 'active', 'grace', 'locked', 'suspended')
         AND schema_version >= 1
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(afterId, pageSize)
    .all<{ readonly id: string }>();
  return res.results.map((r) => r.id);
}

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
    const lastId = page[page.length - 1];
    if (!lastId) break;
    cursor = lastId;
    if (page.length < take) break;
  }

  return collected;
}

export function createContentPurgeQueueHandler(
  options?: CreateContentPurgeQueueHandlerOptions,
): DurableJobHandler<ContentPurgeSweepJobPayload> {
  const logger = options?.logger ?? defaultLogger;
  const defaultPageSize = options?.defaultTenantBatchLimit ?? DEFAULT_TENANT_PAGE_SIZE;
  const defaultRetentionMs = options?.retentionMs ?? TRASH_RETENTION_MS;

  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,

    async execute(ctx: JobExecutionContext<ContentPurgeSweepJobPayload>): Promise<void> {
      const payload = ctx.payload ?? {};
      const effectiveNowMs = parseOptionalPositiveInt(payload.nowMs) ?? ctx.nowMs;
      const retentionMs = parseOptionalPositiveInt(payload.retentionMs) ?? defaultRetentionMs;
      const pageSize = parseOptionalPositiveInt(payload.pageSize) ?? defaultPageSize;
      const maxTenants = parseOptionalPositiveInt(payload.tenantLimit);
      const afterTenantId =
        typeof payload.afterTenantId === "string" && payload.afterTenantId.trim()
          ? payload.afterTenantId.trim()
          : undefined;

      const tenantStoreNs = ctx.env.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined;

      const targetTenantIds: readonly string[] = ctx.tenantId
        ? [ctx.tenantId]
        : await listAllSweepableTenantIds(ctx.env.PLATFORM_DB, {
            pageSize,
            afterTenantId,
            maxTenants,
          });

      const tenantResults: TenantContentPurgeSweepResult[] = [];
      const blockedFailures: ProtectedReferencePurgeFailure[] = [];

      if (tenantStoreNs) {
        for (const tenantId of targetTenantIds) {
          const stub = openTenantStoreStub(tenantStoreNs, tenantId);
          const schemaState = await stub.schemaState(1);
          if (schemaState.recovery || schemaState.appliedMigrations.length === 0) {
            continue;
          }
          const tenantDb = createTenantDb(stub);
          const result = await sweepExpiredTrashedContent(tenantDb, {
            tenantId,
            nowMs: effectiveNowMs,
            retentionMs,
          });
          tenantResults.push(result);

          for (const failure of result.blockedItems) {
            blockedFailures.push(failure);
            logger(
              redactJobLogRecord({
                event: "content_purge.protected_reference_blocked",
                idempotencyKey: ctx.idempotencyKey,
                topic: ctx.topic,
                tenantId: failure.tenantId,
                correlationId: ctx.correlationId,
                resourceType: failure.resourceType,
                resourceId: failure.resourceId,
                slug: failure.slug,
                deletedAt: failure.deletedAt,
                errorCode: failure.errorCode,
                protectedReferences: failure.protectedReferences.map((r) => ({
                  kind: r.kind,
                  sourceTable: r.sourceTable,
                  location: r.location ?? null,
                  field: r.field ?? null,
                })),
                timestamp: effectiveNowMs,
              }),
            );
            if (options?.onProtectedReferenceBlocked) {
              await options.onProtectedReferenceBlocked(failure);
            }
          }
        }
      }

      const totals = tenantResults.reduce(
        (acc, item) => ({
          scannedCount: acc.scannedCount + item.scannedCount,
          purgedCount: acc.purgedCount + item.purgedCount,
          skippedConcurrentCount: acc.skippedConcurrentCount + item.skippedConcurrentCount,
          blockedCount: acc.blockedCount + item.blockedCount,
        }),
        { scannedCount: 0, purgedCount: 0, skippedConcurrentCount: 0, blockedCount: 0 },
      );

      const summary: ContentPurgeQueueSummary = {
        topic: ctx.topic,
        idempotencyKey: ctx.idempotencyKey,
        tenantsSwept: tenantResults.length,
        scannedCount: totals.scannedCount,
        purgedCount: totals.purgedCount,
        skippedConcurrentCount: totals.skippedConcurrentCount,
        blockedCount: totals.blockedCount,
        tenantResults,
        blockedFailures,
      };

      logger(
        redactJobLogRecord({
          event: "content_purge.sweep.completed",
          idempotencyKey: ctx.idempotencyKey,
          topic: ctx.topic,
          tenantId: ctx.tenantId,
          correlationId: ctx.correlationId,
          tenantsSwept: summary.tenantsSwept,
          scannedCount: summary.scannedCount,
          purgedCount: summary.purgedCount,
          skippedConcurrentCount: summary.skippedConcurrentCount,
          blockedCount: summary.blockedCount,
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
 * Convenience registry fragment binding `content.trash_purge_sweep` to the 30-day
 * content purge queue handler for composition into `WORKER_JOB_REGISTRY`.
 */
export function createContentPurgeJobRegistry(
  options?: CreateContentPurgeQueueHandlerOptions,
): DurableJobRegistry {
  const handler = createContentPurgeQueueHandler(options) as DurableJobHandler;
  return {
    [CONTENT_PURGE_SWEEP_TOPIC]: handler,
  };
}
