import { createCloudflareSaasClient } from "@punyasitus/core/domains/index";
import {
  buildSiteExportArchive,
  buildTenantExportR2Key,
  EXPORT_LINK_TTL_MS,
  hashExportDownloadToken,
  signExportDownloadToken,
  TENANT_EXPORT_CLEANUP_TOPIC,
  TENANT_EXPORT_GENERATE_TOPIC,
  TENANT_SELF_DELETION_SWEEP_TOPIC,
} from "@punyasitus/core/exports/index";
import { NonRetryableJobError, redactJobLogRecord, sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  cleanupExpiredTenantExports,
  collectTenantDataForExport,
  completeTenantExportJob,
  executeDueSelfServiceDeletionPurges,
  failTenantExportJob,
  getTenantExportJobById,
  markTenantExportJobProcessing,
  type DueSelfServiceDeletionSweepResult,
  type ExportR2BucketLike,
  type TenantExportJobRecord,
} from "@punyasitus/db/exports/index";
import type {
  OffboardingCloudflareClientLike,
  OffboardingR2BucketLike,
  OffboardingTenantStoreNamespaceLike,
} from "@punyasitus/db/offboarding/index";
import type {
  DurableJobHandler,
  DurableJobRegistry,
  DurableQueueEnv,
  JobExecutionContext,
  StructuredJobLogger,
} from "../consumer.ts";
import type {
  TenantExportCleanupJobPayload,
  TenantExportGenerateJobPayload,
  TenantSelfDeletionSweepJobPayload,
} from "./dispatch.ts";

/**
 * Durable Queue Workers for Owner Full-Website Export Archives & Self-Service Deletion Purge
 * (REQ-107, PLAN §20.4, TASK-107).
 *
 * Security & durability invariants:
 * - Writes every export ZIP strictly under `t/<tenantId>/exports/<exportId>.zip` in R2.
 * - Signs ephemeral 24-hour download tokens with HMAC-SHA256 bound to `(exportId, tenantId, ownerUserId, expiresAtMs)`;
 *   persists ONLY SHA-256 hash in `PLATFORM_DB` and never logs raw tokens.
 * - Enforces bounded memory/file caps and zero path traversal.
 * - Runs due self-service deletion purges after the exact 7-day undo window through the existing
 *   resumable REQ-069 purge path (`executeTenantOffboardingPurge`).
 */

const LOCAL_DEV_EXPORT_SIGNING_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";

export interface ExportWorkerRuntimeEnv extends Partial<DurableQueueEnv> {
  readonly PLATFORM_DB: D1Database;
  readonly AUTH_SECRET?: string;
  readonly APP_ENV?: string;
  readonly CF_SAAS_ZONE_ID?: string;
  readonly CF_SAAS_API_TOKEN?: string;
  readonly CF_API_BASE_URL?: string;
}

export interface ExecuteExportArchiveOptions {
  readonly nowMs?: number;
  readonly signingSecret?: string;
  readonly mediaBucket?: ExportR2BucketLike | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly maxArchiveBytes?: number;
  readonly maxMediaFiles?: number;
  readonly maxSingleMediaBytes?: number;
  readonly requestId?: string | null;
  readonly logger?: StructuredJobLogger;
}

export interface CreateExportHandlersOptions {
  readonly now?: () => number;
  readonly signingSecret?: string;
  readonly mediaBucket?: ExportR2BucketLike | null;
  readonly tenantStoreNamespace?: OffboardingTenantStoreNamespaceLike | null;
  readonly cloudflareClient?: OffboardingCloudflareClientLike | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly maxArchiveBytes?: number;
  readonly maxMediaFiles?: number;
  readonly maxSingleMediaBytes?: number;
  readonly logger?: StructuredJobLogger;
  readonly onExportCompleted?: (job: TenantExportJobRecord) => Promise<void> | void;
  readonly onDeletionSweepCompleted?: (result: DueSelfServiceDeletionSweepResult) => Promise<void> | void;
}

function defaultLogger(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

export function resolveExportSigningSecret(
  env: { readonly AUTH_SECRET?: string; readonly APP_ENV?: string },
  explicit?: string,
): string | null {
  if (explicit && explicit.trim().length >= 16) return explicit.trim();
  const configured = env.AUTH_SECRET?.trim();
  if (configured && configured.length >= 16) return configured;
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    return LOCAL_DEV_EXPORT_SIGNING_SECRET;
  }
  return null;
}

function resolveCloudflareClient(
  env: ExportWorkerRuntimeEnv,
  explicit?: OffboardingCloudflareClientLike | null,
): OffboardingCloudflareClientLike | null {
  if (explicit !== undefined) return explicit;
  const zoneId = env.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = env.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) return null;
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: env.CF_API_BASE_URL,
  });
}

/**
 * Generates one tenant's full-website ZIP archive, writes it under `t/<tenantId>/exports/<exportId>.zip`,
 * signs the 24-hour owner-bound download token, and transitions the job row to `ready`.
 */
export async function executeTenantExportArchiveJob(
  env: ExportWorkerRuntimeEnv,
  payload: TenantExportGenerateJobPayload,
  options: ExecuteExportArchiveOptions = {},
): Promise<{
  readonly job: TenantExportJobRecord;
  readonly downloadToken: string;
}> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const logger = options.logger ?? defaultLogger;
  const { exportId, tenantId } = payload;

  const existingJob = await getTenantExportJobById(env.PLATFORM_DB, tenantId, exportId, nowMs);
  if (!existingJob) {
    throw new NonRetryableJobError("EXPORT_JOB_NOT_FOUND", `Export job ${exportId} not found.`);
  }

  const signingSecret = resolveExportSigningSecret(env, options.signingSecret);
  if (!signingSecret) {
    await failTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      errorCode: "EXPORT_SIGNING_SECRET_MISSING",
      nowMs,
      requestId: options.requestId,
    });
    throw new NonRetryableJobError(
      "EXPORT_SIGNING_SECRET_MISSING",
      "Export signing secret is not configured.",
    );
  }

  // Idempotent short-circuit if already built and still valid
  if (
    existingJob.status === "ready" &&
    existingJob.downloadExpiresAtMs &&
    nowMs < existingJob.downloadExpiresAtMs
  ) {
    const token = await signExportDownloadToken(signingSecret, {
      exportId: existingJob.id,
      tenantId: existingJob.tenantId,
      ownerUserId: existingJob.requestedByUserId,
      expiresAtMs: existingJob.downloadExpiresAtMs,
    });
    return { job: existingJob, downloadToken: token };
  }

  const tenantRow = await env.PLATFORM_DB.prepare(
    "SELECT id, handle, name, vertical, status FROM tenants WHERE id = ? LIMIT 1",
  )
    .bind(tenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly name: string;
      readonly vertical: string;
      readonly status: string;
    }>();

  if (!tenantRow || tenantRow.status === "purged" || tenantRow.status === "purging") {
    await failTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      errorCode: "TENANT_UNAVAILABLE_FOR_EXPORT",
      nowMs,
      requestId: options.requestId,
    });
    throw new NonRetryableJobError(
      "TENANT_UNAVAILABLE_FOR_EXPORT",
      `Tenant ${tenantId} is not available for export.`,
    );
  }

  const mediaBucket: ExportR2BucketLike | null =
    options.mediaBucket !== undefined
      ? options.mediaBucket
      : ((env.MEDIA_BUCKET as unknown as ExportR2BucketLike | undefined) ?? null);

  if (!mediaBucket) {
    await failTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      errorCode: "MEDIA_BUCKET_UNAVAILABLE",
      nowMs,
      requestId: options.requestId,
    });
    throw new Error("MEDIA_BUCKET_UNAVAILABLE");
  }

  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(tenantId);
  } else if (env.TENANT_STORE) {
    tenantDb = createTenantDb(
      openTenantStoreStub(env.TENANT_STORE as unknown as TenantStoreNamespaceLike, tenantId),
    );
  }

  if (!tenantDb) {
    await failTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      errorCode: "TENANT_STORE_UNAVAILABLE",
      nowMs,
      requestId: options.requestId,
    });
    throw new Error("TENANT_STORE_UNAVAILABLE");
  }

  const claimedForProcessing = await markTenantExportJobProcessing(
    env.PLATFORM_DB,
    tenantId,
    exportId,
    nowMs,
  );
  if (!claimedForProcessing) {
    throw new NonRetryableJobError(
      "EXPORT_JOB_NOT_QUEUED",
      `Export job ${exportId} is no longer queued (already processing or terminal).`,
    );
  }

  try {
    const collected = await collectTenantDataForExport({
      tenantId,
      tenantDb,
      mediaBucket,
      maxArchiveBytes: options.maxArchiveBytes,
      maxMediaFiles: options.maxMediaFiles,
      maxSingleMediaBytes: options.maxSingleMediaBytes,
    });

    const built = await buildSiteExportArchive({
      exportId,
      tenantId,
      tenantHandle: tenantRow.handle,
      tenantName: tenantRow.name,
      vertical: tenantRow.vertical,
      siteSettings: collected.siteSettings,
      businessProfile: collected.businessProfile,
      pages: collected.pages,
      posts: collected.posts,
      offerings: collected.offerings,
      leads: collected.leads,
      mediaFiles: collected.mediaFiles,
      preSkippedMedia: collected.skippedMedia,
      truncatedCollections: collected.truncated,
      generatedAtMs: nowMs,
      maxArchiveBytes: options.maxArchiveBytes,
      maxMediaFiles: options.maxMediaFiles,
      maxSingleMediaBytes: options.maxSingleMediaBytes,
    });

    const r2Key = buildTenantExportR2Key(tenantId, exportId);
    await mediaBucket.put(r2Key, built.zipBytes, {
      httpMetadata: {
        contentType: "application/zip",
        cacheControl: "private, no-store",
      },
      customMetadata: {
        tenantId,
        exportId,
        sha256: built.sha256Hex,
      },
    });

    const downloadExpiresAtMs = nowMs + EXPORT_LINK_TTL_MS;
    const downloadToken = await signExportDownloadToken(signingSecret, {
      exportId,
      tenantId,
      ownerUserId: existingJob.requestedByUserId,
      expiresAtMs: downloadExpiresAtMs,
    });
    const downloadTokenHash = await hashExportDownloadToken(downloadToken);

    const completedJob = await completeTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      actorUserId: existingJob.requestedByUserId,
      r2Key,
      archiveBytes: built.zipBytes.byteLength,
      archiveSha256: built.sha256Hex,
      manifest: built.manifest,
      downloadTokenHash,
      downloadExpiresAtMs,
      nowMs,
      requestId: options.requestId,
    });

    logger(
      redactJobLogRecord({
        event: "exports.archive.completed",
        tenantId,
        exportId,
        r2Key,
        archiveBytes: built.zipBytes.byteLength,
        counts: built.manifest.counts,
        downloadExpiresAtMs,
        requestId: options.requestId ?? null,
      }),
    );

    return { job: completedJob, downloadToken };
  } catch (err) {
    const errorCode = sanitizeErrorCode(err);
    await failTenantExportJob(env.PLATFORM_DB, {
      tenantId,
      exportId,
      errorCode,
      nowMs,
      requestId: options.requestId,
    });
    logger(
      redactJobLogRecord({
        event: "exports.archive.failed",
        tenantId,
        exportId,
        errorCode,
        requestId: options.requestId ?? null,
      }),
    );
    throw err;
  }
}

export function createExportArchiveJobHandler(
  options: CreateExportHandlersOptions = {},
): DurableJobHandler<TenantExportGenerateJobPayload> {
  return {
    maxAttempts: 3,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<TenantExportGenerateJobPayload>): Promise<void> {
      const payload = ctx.payload;
      if (!payload?.exportId || !payload?.tenantId) {
        throw new NonRetryableJobError(
          "INVALID_EXPORT_PAYLOAD",
          "Export archive payload missing exportId or tenantId.",
        );
      }
      const nowMs = options.now ? options.now() : ctx.nowMs;
      const result = await executeTenantExportArchiveJob(
        ctx.env as ExportWorkerRuntimeEnv,
        payload,
        {
          nowMs,
          signingSecret: options.signingSecret,
          mediaBucket: options.mediaBucket,
          resolveTenantDb: options.resolveTenantDb,
          maxArchiveBytes: options.maxArchiveBytes,
          maxMediaFiles: options.maxMediaFiles,
          maxSingleMediaBytes: options.maxSingleMediaBytes,
          requestId: ctx.correlationId ?? ctx.idempotencyKey,
          logger: options.logger,
        },
      );
      if (options.onExportCompleted) {
        await options.onExportCompleted(result.job);
      }
    },
  };
}

export function createExportCleanupJobHandler(
  options: CreateExportHandlersOptions = {},
): DurableJobHandler<TenantExportCleanupJobPayload> {
  return {
    maxAttempts: 3,
    leaseDurationMs: 60_000,
    async execute(ctx: JobExecutionContext<TenantExportCleanupJobPayload>): Promise<void> {
      const nowMs =
        typeof ctx.payload?.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? Math.trunc(ctx.payload.scheduledAtMs)
          : options.now
            ? options.now()
            : ctx.nowMs;
      const mediaBucket: ExportR2BucketLike | null =
        options.mediaBucket !== undefined
          ? options.mediaBucket
          : ((ctx.env.MEDIA_BUCKET as unknown as ExportR2BucketLike | undefined) ?? null);

      const summary = await cleanupExpiredTenantExports(ctx.env.PLATFORM_DB, mediaBucket, {
        nowMs,
        limit: ctx.payload?.limit,
      });

      const logger = options.logger ?? defaultLogger;
      logger(
        redactJobLogRecord({
          event: "exports.cleanup_expired.completed",
          nowMs,
          ...summary,
        }),
      );
    },
  };
}

export function createSelfServiceDeletionSweepHandler(
  options: CreateExportHandlersOptions = {},
): DurableJobHandler<TenantSelfDeletionSweepJobPayload> {
  return {
    maxAttempts: 5,
    leaseDurationMs: 120_000,
    async execute(ctx: JobExecutionContext<TenantSelfDeletionSweepJobPayload>): Promise<void> {
      const nowMs =
        typeof ctx.payload?.scheduledAtMs === "number" && Number.isFinite(ctx.payload.scheduledAtMs)
          ? Math.trunc(ctx.payload.scheduledAtMs)
          : options.now
            ? options.now()
            : ctx.nowMs;

      const mediaBucket: OffboardingR2BucketLike | null =
        options.mediaBucket !== undefined
          ? options.mediaBucket
          : ((ctx.env.MEDIA_BUCKET as unknown as OffboardingR2BucketLike | undefined) ?? null);
      const tenantStoreNamespace: OffboardingTenantStoreNamespaceLike | null =
        options.tenantStoreNamespace !== undefined
          ? options.tenantStoreNamespace
          : ((ctx.env.TENANT_STORE as unknown as OffboardingTenantStoreNamespaceLike | undefined) ??
            null);
      const cloudflareClient = resolveCloudflareClient(
        ctx.env as ExportWorkerRuntimeEnv,
        options.cloudflareClient,
      );

      const summary = await executeDueSelfServiceDeletionPurges({
        platformDb: ctx.env.PLATFORM_DB,
        mediaBucket,
        tenantStoreNamespace,
        cloudflareClient,
        nowMs,
        tenantId: ctx.payload?.tenantId,
        limit: ctx.payload?.limit,
        requestId: ctx.correlationId ?? ctx.idempotencyKey,
      });

      const logger = options.logger ?? defaultLogger;
      logger(
        redactJobLogRecord({
          event: "exports.deletion_sweep.completed",
          nowMs,
          scannedRequests: summary.scannedRequests,
          claimedCount: summary.claimedCount,
          purgedCount: summary.purgedCount,
          blockedCount: summary.blockedCount,
          failedCount: summary.failedCount,
        }),
      );

      if (options.onDeletionSweepCompleted) {
        await options.onDeletionSweepCompleted(summary);
      }

      if (summary.failedCount > 0) {
        const firstErr =
          summary.outcomes.find((o) => o.errorCode !== null)?.errorCode ??
          "SELF_SERVICE_DELETION_PURGE_INCOMPLETE";
        throw new Error(firstErr);
      }
    },
  };
}

export function createExportJobRegistry(
  options: CreateExportHandlersOptions = {},
): DurableJobRegistry {
  return {
    [TENANT_EXPORT_GENERATE_TOPIC]: createExportArchiveJobHandler(
      options,
    ) as unknown as DurableJobHandler,
    [TENANT_EXPORT_CLEANUP_TOPIC]: createExportCleanupJobHandler(
      options,
    ) as unknown as DurableJobHandler,
    [TENANT_SELF_DELETION_SWEEP_TOPIC]: createSelfServiceDeletionSweepHandler(
      options,
    ) as unknown as DurableJobHandler,
  };
}
