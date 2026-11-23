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
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { JobEnvelopeSchema, sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import { ConsoleJobRetryRequestSchema, OperatorReasonSchema } from "@punyasitus/core/schemas";
import {
  cancelConsoleJobToDeadLetter,
  ConsoleRecoveryError,
  listConsoleJobsQueue,
  markRetriedJobDispatchFailed,
  retryConsoleFailedJob,
} from "@punyasitus/db/platform";
import {
  dispatchJobRetryToQueue,
  type DispatchJobRetryQueueLike,
} from "../../../../worker/queues/recovery/index.ts";

/**
 * Shared Console Operasional Platform API handlers for Superadmin Job Recovery Queue
 * (`TASK-047`, `REQ-050`, `REQ-034`, `REQ-042`, `REQ-051`; `PLAN §13`).
 */

export interface ConsoleJobsRuntimeEnv extends ConsoleRuntimeEnv {
  readonly JOBS_QUEUE?: DispatchJobRetryQueueLike | null;
}

export interface ConsoleJobsHandlerOptions extends ConsoleHandlerOptions {
  readonly jobsQueue?: DispatchJobRetryQueueLike | null;
  readonly maxOperatorRetries?: number;
}

const PositiveEpochMsSchema = JobEnvelopeSchema.shape.enqueuedAt.unwrap().min(1);
const OptionalJobKeySchema = JobEnvelopeSchema.shape.idempotencyKey.optional();
const RequiredJobKeySchema = JobEnvelopeSchema.shape.idempotencyKey;
const NullableTenantIdSchema = JobEnvelopeSchema.shape.tenantId;
const OptionalIdempotencyKeySchema = JobEnvelopeSchema.shape.idempotencyKey.optional();

/**
 * Real Zod v4 `.strict()` schemas composed from `@punyasitus/core` primitives.
 */
export const ConsoleJobRetryBodySchema = ConsoleJobRetryRequestSchema.pick({ reason: true })
  .extend({
    jobIdempotencyKey: OptionalJobKeySchema,
    tenantId: NullableTenantIdSchema,
    expectedUpdatedAt: PositiveEpochMsSchema,
    reason: OperatorReasonSchema,
    idempotencyKey: OptionalIdempotencyKeySchema,
  })
  .strict();

export const ConsoleJobCancelBodySchema = ConsoleJobRetryRequestSchema.pick({ reason: true })
  .extend({
    jobIdempotencyKey: RequiredJobKeySchema,
    tenantId: NullableTenantIdSchema,
    expectedUpdatedAt: PositiveEpochMsSchema,
    reason: OperatorReasonSchema,
    idempotencyKey: OptionalIdempotencyKeySchema,
  })
  .strict();

export interface ParsedJobActionPayload {
  readonly jobIdempotencyKey?: string;
  readonly tenantId: string | null;
  readonly expectedUpdatedAt: number;
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

export function validateConsoleJobRetryPayload(
  raw: Record<string, unknown>,
):
  | { readonly ok: true; readonly data: ParsedJobActionPayload }
  | { readonly ok: false; readonly code: "UNKNOWN_FIELD" | "VALIDATION_ERROR"; readonly message: string } {
  const parsed = ConsoleJobRetryBodySchema.safeParse(raw);
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

export function validateConsoleJobCancelPayload(
  raw: Record<string, unknown>,
):
  | { readonly ok: true; readonly data: ParsedJobActionPayload & { readonly jobIdempotencyKey: string } }
  | { readonly ok: false; readonly code: "UNKNOWN_FIELD" | "VALIDATION_ERROR"; readonly message: string } {
  const parsed = ConsoleJobCancelBodySchema.safeParse(raw);
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

export function buildConsoleJobsRuntimeEnv(rawEnv: {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly JOBS_QUEUE?: unknown;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: unknown;
}): ConsoleJobsRuntimeEnv {
  return {
    APP_ENV: rawEnv.APP_ENV,
    PLATFORM_DOMAIN: rawEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: rawEnv.PLATFORM_DB,
    JOBS_QUEUE: rawEnv.JOBS_QUEUE as DispatchJobRetryQueueLike | undefined,
    AUTH_SECRET: rawEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: rawEnv.CONSOLE_AUTH_SECRET,
    EMAIL: rawEnv.EMAIL as CloudflareSendEmailBinding | undefined,
  };
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

function mapJobRecoveryError(err: unknown, requestId: string): Response {
  if (err instanceof ConsoleRecoveryError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, err.details);
  }
  return consoleErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses antrean pemulihan job.",
    requestId,
  );
}

/**
 * `GET /api/console/jobs` — List redacted background jobs (exceptions first).
 */
export async function handleConsoleJobsListRequest(
  request: Request,
  runtimeEnv: ConsoleJobsRuntimeEnv,
  options: ConsoleJobsHandlerOptions = {},
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
    { action: "console.jobs.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "exceptions";
  const topic = url.searchParams.get("topic") ?? undefined;
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
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
    const queue = await listConsoleJobsQueue(authz.ctx.platformDb, {
      status,
      topic,
      tenantId,
      search,
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
    return mapJobRecoveryError(err, requestId);
  }
}

/**
 * `POST /api/console/jobs/retry` & `POST /api/console/jobs/[jobKey]/retry`
 * Atomically retries an eligible failed/dead_letter/expired-lease/stale-queued job without
 * editing payload. Never leaves a job stuck in `queued` if `JOBS_QUEUE` is absent or fails!
 */
export async function handleConsoleJobRetryRequest(
  request: Request,
  runtimeEnv: ConsoleJobsRuntimeEnv,
  options: ConsoleJobsHandlerOptions & { readonly pathJobKey?: string } = {},
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
    { action: "console.job.retry", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const rawBody = await parseStrictConsoleJsonBody(request, requestId);
  if (!rawBody.ok) {
    return rawBody.response;
  }

  const parsed = validateConsoleJobRetryPayload(rawBody.body);
  if (!parsed.ok) {
    return consoleErrorResponse(422, parsed.code, parsed.message, requestId);
  }

  const normalizedPathKey = options.pathJobKey?.trim() ?? "";
  const normalizedBodyKey = parsed.data.jobIdempotencyKey?.trim() ?? "";
  if (normalizedPathKey && normalizedBodyKey && normalizedPathKey !== normalizedBodyKey) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Kunci job pada path URL dan field body jobIdempotencyKey tidak cocok.",
      requestId,
    );
  }

  const jobKey = normalizedPathKey || normalizedBodyKey;
  if (!jobKey) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "jobIdempotencyKey wajib diisi.",
      requestId,
    );
  }

  const idemp = resolveIdempotencyKey(request, parsed.data.idempotencyKey, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  try {
    const result = await retryConsoleFailedJob(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      jobIdempotencyKey: jobKey,
      expectedTenantId: parsed.data.tenantId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      reason: parsed.data.reason,
      idempotencyKey: idemp.key,
      requestId,
      maxOperatorRetries: options.maxOperatorRetries,
      nowMs: authz.ctx.nowMs,
    });

    if (!result.replayed && result.dispatchEnvelope) {
      const queue = options.jobsQueue !== undefined ? options.jobsQueue : runtimeEnv.JOBS_QUEUE;
      if (!queue) {
        const reverted = await markRetriedJobDispatchFailed(authz.ctx.platformDb, {
          jobIdempotencyKey: jobKey,
          receiptKey: result.receiptKey,
          errorCode: "QUEUE_UNAVAILABLE",
          actorUserId: authz.ctx.actor.userId,
          tenantId: parsed.data.tenantId,
          reason: parsed.data.reason,
          requestId,
          nowMs: authz.ctx.nowMs,
        });
        return consoleErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Binding Cloudflare Queue (JOBS_QUEUE) tidak tersedia. Job dikembalikan ke status gagal agar tidak tertahan di antrean.",
          requestId,
          {
            reasonCode: "QUEUE_UNAVAILABLE",
            job: reverted ?? result.job,
          },
          { "Retry-After": "15" },
        );
      }

      try {
        await dispatchJobRetryToQueue(queue, result.dispatchEnvelope);
      } catch (err) {
        const safeCode = sanitizeErrorCode(err);
        const reverted = await markRetriedJobDispatchFailed(authz.ctx.platformDb, {
          jobIdempotencyKey: jobKey,
          receiptKey: result.receiptKey,
          errorCode: safeCode === "JOB_EXECUTION_ERROR" ? "QUEUE_DISPATCH_FAILED" : safeCode,
          actorUserId: authz.ctx.actor.userId,
          tenantId: parsed.data.tenantId,
          reason: parsed.data.reason,
          requestId,
          nowMs: authz.ctx.nowMs,
        });
        return consoleErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Gagal mengirim ulang pesan ke Cloudflare Queue. Job dikembalikan ke status gagal agar aman dicoba lagi.",
          requestId,
          {
            reasonCode: "QUEUE_DISPATCH_FAILED",
            job: reverted ?? result.job,
          },
          { "Retry-After": "15" },
        );
      }
    }

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: result.replayed,
      dispatched: !result.replayed,
      job: result.job,
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    return mapJobRecoveryError(err, requestId);
  }
}

/**
 * `POST /api/console/jobs/cancel`
 * Atomically moves an eligible queued/failed/expired-lease job to terminal `dead_letter`.
 */
export async function handleConsoleJobCancelRequest(
  request: Request,
  runtimeEnv: ConsoleJobsRuntimeEnv,
  options: ConsoleJobsHandlerOptions = {},
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
    { action: "console.job.cancel", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const rawBody = await parseStrictConsoleJsonBody(request, requestId);
  if (!rawBody.ok) {
    return rawBody.response;
  }

  const parsed = validateConsoleJobCancelPayload(rawBody.body);
  if (!parsed.ok) {
    return consoleErrorResponse(422, parsed.code, parsed.message, requestId);
  }

  const idemp = resolveIdempotencyKey(request, parsed.data.idempotencyKey, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  try {
    const result = await cancelConsoleJobToDeadLetter(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      jobIdempotencyKey: parsed.data.jobIdempotencyKey,
      expectedTenantId: parsed.data.tenantId,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
      reason: parsed.data.reason,
      idempotencyKey: idemp.key,
      requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: result.replayed,
      job: result.job,
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    return mapJobRecoveryError(err, requestId);
  }
}
