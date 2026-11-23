import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  consoleNeutralNotFoundResponse,
  createConsoleRequestId,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  resolveConsoleHostContext,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  AbuseModerationError,
  getAbuseReportById,
  listAbuseReports,
  moderateAbuseReport,
  type AbuseCategory,
  type AbuseModerationAction,
  type AbuseReportStatus,
  type ModerationQueueSenderLike,
} from "@punyasitus/db/abuse/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { resolveAuthEmailPort } from "../../../../middleware/auth.ts";

/**
 * Shared Console Moderation Queue API handlers (`/api/console/abuse/**`;
 * REQ-094, REQ-039, REQ-049, REQ-051; PLAN §13, §19.5; TASK-094).
 *
 * Security invariants:
 * - Non-console hosts ALWAYS receive a bare neutral `404` (`text/plain` "Not Found").
 * - Every endpoint verifies live session + active `platform_operators` grant + mandatory 2FA.
 * - Moderation mutations (`POST /api/console/abuse/:reportId/moderate`) enforce CSRF/Origin,
 *   10-minute recent 2FA step-up (`requireStepUp: true`), mandatory reason (10-500 chars),
 *   optimistic `expectedVersion`, atomic `platform_audit` (`WHERE changes() = 1`),
 *   immediate public visibility updates, and owner notice via `EmailPort`.
 */

export interface ConsoleAbuseRuntimeEnv extends ConsoleRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly JOBS_QUEUE?: ModerationQueueSenderLike | null;
}

export interface ConsoleAbuseHandlerOptions extends ConsoleHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly jobsQueue?: ModerationQueueSenderLike | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database | null> | D1Database | null;
}

const MODERATE_ALLOWED_KEYS = new Set([
  "action",
  "reason",
  "expectedVersion",
  "version",
  "idempotencyKey",
]);

export function buildConsoleAbuseRuntimeEnv(rawEnv: {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: unknown;
  readonly JOBS_QUEUE?: unknown;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: unknown;
}): ConsoleAbuseRuntimeEnv {
  return {
    APP_ENV: rawEnv.APP_ENV,
    PLATFORM_DOMAIN: rawEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: rawEnv.SAAS_ZONE,
    PLATFORM_DB: rawEnv.PLATFORM_DB,
    TENANT_STORE: rawEnv.TENANT_STORE as TenantStoreNamespaceLike | undefined,
    JOBS_QUEUE: rawEnv.JOBS_QUEUE as ModerationQueueSenderLike | undefined,
    AUTH_SECRET: rawEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: rawEnv.CONSOLE_AUTH_SECRET,
    EMAIL: rawEnv.EMAIL as CloudflareSendEmailBinding | undefined,
  };
}

export function mapAbuseModerationErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof AbuseModerationError) {
    return consoleErrorResponse(
      err.status,
      err.code,
      err.message,
      requestId,
      err.fields.length > 0 ? { fields: err.fields } : undefined,
    );
  }
  return mapPlatformErrorToResponse(err, requestId);
}

/**
 * `GET /api/console/abuse` — Paginated, filterable abuse moderation queue.
 */
export async function handleConsoleAbuseListRequest(
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.abuse.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan. Gunakan GET untuk melihat antrean laporan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.abuse.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const statusParam = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
  const categoryParam = (url.searchParams.get("category") ?? "all").trim().toLowerCase();
  const search = url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : undefined;

  try {
    const result = await listAbuseReports(authz.ctx.platformDb, {
      status: statusParam as AbuseReportStatus | "all",
      category: categoryParam as AbuseCategory | "all",
      search,
      cursor,
      limit,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId: authz.ctx.requestId,
      ...result,
    });
  } catch (err) {
    return mapAbuseModerationErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `GET /api/console/abuse/:reportId` — Single abuse report detail & moderation history.
 */
export async function handleConsoleAbuseDetailRequest(
  reportId: string,
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.abuse.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan untuk detail laporan.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.abuse.read", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  try {
    const detail = await getAbuseReportById(authz.ctx.platformDb, reportId);
    if (!detail) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Laporan penyalahgunaan tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    return consoleJsonResponse(200, {
      success: true,
      requestId: authz.ctx.requestId,
      report: detail,
    });
  } catch (err) {
    return mapAbuseModerationErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `POST /api/console/abuse/:reportId/moderate` — Executes audited `dismiss`, `unpublish`,
 * or `suspend` action requiring recent 2FA step-up, operator reason, and optimistic `expectedVersion`.
 */
export async function handleConsoleAbuseModerateRequest(
  reportId: string,
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.abuse.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk mengeksekusi tindakan moderasi.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  // Enforce active operator + mandatory 2FA + recent 10-minute 2FA step-up + CSRF/Origin
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.abuse.moderate", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId, MODERATE_ALLOWED_KEYS);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const actionRaw = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const reasonRaw = typeof body.reason === "string" ? body.reason : "";

  const hasExpected = body.expectedVersion !== undefined;
  const hasVersion = body.version !== undefined;
  if (hasExpected && hasVersion && body.expectedVersion !== body.version) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "expectedVersion dan version harus bernilai sama.",
      authz.ctx.requestId,
    );
  }
  const expectedVersion = hasExpected ? body.expectedVersion : body.version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "expectedVersion wajib berupa bilangan bulat positif.",
      authz.ctx.requestId,
    );
  }

  const headerIdemp = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyIdemp = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (headerIdemp && bodyIdemp && headerIdemp !== bodyIdemp) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Header Idempotency-Key dan field body idempotencyKey tidak cocok.",
      authz.ctx.requestId,
    );
  }
  const idempotencyKey = headerIdemp || bodyIdemp || null;

  // Pre-load report target tenantId so we can bind isolated TenantStore when unpublishing/suspending.
  // For `unpublish`, fail closed with 503 TENANT_STORE_UNAVAILABLE if TenantStore cannot be bound!
  let tenantDb: D1Database | null = null;
  if (actionRaw === "unpublish" || actionRaw === "suspend") {
    let existing;
    try {
      existing = await getAbuseReportById(authz.ctx.platformDb, reportId);
    } catch (err) {
      return mapAbuseModerationErrorToResponse(err, authz.ctx.requestId);
    }

    if (existing) {
      try {
        if (options.resolveTenantDb) {
          tenantDb = await options.resolveTenantDb(existing.tenantId);
        } else if (runtimeEnv.TENANT_STORE) {
          tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, existing.tenantId));
        }
      } catch (err) {
        if (actionRaw === "unpublish") {
          return consoleErrorResponse(
            503,
            "TENANT_STORE_UNAVAILABLE",
            "Penyimpanan data tenant tidak dapat dijangkau untuk menonaktifkan konten.",
            authz.ctx.requestId,
          );
        }
        tenantDb = null;
        void err;
      }

      if (actionRaw === "unpublish" && !tenantDb) {
        return consoleErrorResponse(
          503,
          "TENANT_STORE_UNAVAILABLE",
          "Penyimpanan data tenant tidak tersedia untuk menonaktifkan konten.",
          authz.ctx.requestId,
        );
      }
    }
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const jobsQueue = options.jobsQueue ?? runtimeEnv.JOBS_QUEUE ?? null;
  const appOrigin = host.isLocalLoopback
    ? host.baseURL
    : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`;

  try {
    const result = await moderateAbuseReport(authz.ctx.platformDb, {
      reportId,
      action: actionRaw as AbuseModerationAction,
      reason: reasonRaw,
      expectedVersion,
      actorUserId: authz.ctx.actor.userId,
      idempotencyKey,
      requestId: authz.ctx.requestId,
      tenantDb,
      jobsQueue,
      emailPort,
      appOrigin,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId: authz.ctx.requestId,
      report: result.report,
      action: result.action,
      auditId: result.audit?.id ?? null,
      unpublishTarget: result.unpublishTarget,
      tenantSuspended: result.tenantSuspended,
      notificationSent: result.notificationSent,
      notificationStatus: result.notificationStatus,
      notificationJobKey: result.notificationJobKey,
      replayed: result.replayed,
    });
  } catch (err) {
    return mapAbuseModerationErrorToResponse(err, authz.ctx.requestId);
  }
}
