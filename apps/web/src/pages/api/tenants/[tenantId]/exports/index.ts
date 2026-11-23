import { getJakartaDayKey, secondsUntilNextJakartaDay } from "@punyasitus/core/exports/index";
import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  ExportConflictError,
  ExportDailyLimitError,
  failTenantExportJob,
  listTenantExportJobs,
  requestTenantExportJob,
} from "@punyasitus/db/exports/index";
import type { APIRoute } from "astro";
import {
  enqueueTenantExportArchiveJob,
  executeTenantExportArchiveJob,
  type ExportWorkerRuntimeEnv,
} from "../../../../../worker/queues/exports/index.ts";
import {
  authorizeTenantOwnerDataRequest,
  buildOwnerDataRuntimeEnv,
  createDataRequestId,
  dataErrorResponse,
  dataJsonResponse,
  parseStrictOwnerDataJsonBody,
  serializeExportJobDto,
  type TenantOwnerDataHandlerOptions,
  type TenantOwnerDataRuntimeEnv,
} from "./_shared.ts";

/**
 * Owner-Only Full-Website Export Archive Collection Endpoint (REQ-107, PLAN §20.4, TASK-107):
 * - `GET  /api/tenants/:tenantId/exports` — list recent archives & today's quota status
 * - `POST /api/tenants/:tenantId/exports` — request a new ZIP archive (max 1/day per website)
 */

const POST_EXPORT_ALLOWED_KEYS: ReadonlySet<string> = new Set([]);

export async function handleTenantExportsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantOwnerDataRuntimeEnv,
  options: TenantOwnerDataHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDataRequestId();

  const auth = await authorizeTenantOwnerDataRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const { member, platformDb, signingSecret } = auth.ctx;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const todayKey = getJakartaDayKey(nowMs);

  if (method === "GET") {
    try {
      const jobs = await listTenantExportJobs(platformDb, member.tenantId, { nowMs, limit: 20 });
      const items = await Promise.all(
        jobs.map((job) => serializeExportJobDto(job, { signingSecret, nowMs })),
      );
      const hasExportToday = jobs.some(
        (j) => j.requestDay === todayKey && j.status !== "failed",
      );

      return dataJsonResponse(200, {
        tenantId: member.tenantId,
        handle: member.handle,
        todayKey,
        dailyLimit: 1,
        hasExportToday,
        nextAllowedInSeconds: hasExportToday ? secondsUntilNextJakartaDay(nowMs) : 0,
        items,
        requestId,
      });
    } catch {
      return dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memuat daftar arsip ekspor situs.",
        requestId,
        undefined,
        { "Retry-After": "30" },
      );
    }
  }

  if (method === "POST") {
    const parsedBody = await parseStrictOwnerDataJsonBody(
      request,
      POST_EXPORT_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) return parsedBody.response;

    try {
      const createdJob = await requestTenantExportJob(platformDb, {
        tenantId: member.tenantId,
        requestedByUserId: member.userId,
        nowMs,
        requestId,
      });

      const idempotencyKey =
        createdJob.jobIdempotencyKey ??
        `tenant-export:${member.tenantId}:${createdJob.requestDay}:${createdJob.id}`;

      try {
        await enqueueTenantExportArchiveJob(
          {
            PLATFORM_DB: platformDb,
            JOBS_QUEUE: runtimeEnv.JOBS_QUEUE ?? undefined,
          },
          {
            idempotencyKey,
            exportId: createdJob.id,
            tenantId: member.tenantId,
            requestedByUserId: member.userId,
            requestDay: createdJob.requestDay,
            correlationId: requestId,
            nowMs,
          },
        );
      } catch (enqueueErr) {
        await failTenantExportJob(platformDb, {
          tenantId: member.tenantId,
          exportId: createdJob.id,
          errorCode: sanitizeErrorCode(enqueueErr),
          nowMs,
          requestId,
        }).catch(() => undefined);
        throw enqueueErr;
      }

      let finalJob = createdJob;
      let httpStatus = 202;

      const canRunInlineInDevOrNoQueue =
        !runtimeEnv.JOBS_QUEUE || runtimeEnv.APP_ENV === "local";
      const shouldRunInline =
        canRunInlineInDevOrNoQueue &&
        (options.executeInlineWhenNoQueue === true ||
          (options.executeInlineWhenNoQueue !== false &&
            (options.mediaBucket !== undefined || Boolean(runtimeEnv.MEDIA_BUCKET)) &&
            (options.resolveTenantDb !== undefined || Boolean(runtimeEnv.TENANT_STORE))));

      if (shouldRunInline) {
        const executed = await executeTenantExportArchiveJob(
          runtimeEnv as ExportWorkerRuntimeEnv,
          {
            exportId: createdJob.id,
            tenantId: member.tenantId,
            requestedByUserId: member.userId,
            requestDay: createdJob.requestDay,
            scheduledAtMs: nowMs,
          },
          {
            nowMs,
            signingSecret,
            mediaBucket: options.mediaBucket ?? runtimeEnv.MEDIA_BUCKET ?? null,
            resolveTenantDb: options.resolveTenantDb,
            requestId,
          },
        );
        finalJob = executed.job;
        httpStatus = 201;
      }

      const dto = await serializeExportJobDto(finalJob, { signingSecret, nowMs });
      return dataJsonResponse(httpStatus, {
        export: dto,
        requestId,
      });
    } catch (err) {
      if (err instanceof ExportDailyLimitError) {
        return dataErrorResponse(
          429,
          "RATE_LIMITED",
          err.message,
          requestId,
          undefined,
          {
            "Retry-After": String(err.retryAfterSeconds),
            "X-RateLimit-Limit": "1",
            "X-RateLimit-Remaining": "0",
          },
        );
      }
      if (err instanceof ExportConflictError) {
        return dataErrorResponse(err.status, err.code, err.message, requestId);
      }
      return dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memproses permintaan ekspor arsip situs.",
        requestId,
        undefined,
        { "Retry-After": "30" },
      );
    }
  }

  return dataErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan.",
    requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantExportsCollectionRequest(params.tenantId ?? "", request, buildOwnerDataRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    authenticatedSession: locals.authSession
      ? { id: locals.authSession.id, createdAt: locals.authSession.createdAt }
      : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
