import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  consoleNeutralNotFoundResponse,
  createConsoleRequestId,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  resolveConsoleHostContext,
} from "@punyasitus/auth/platform/index";
import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  ContentScreeningError,
  decideScreeningReview,
  getScreeningReviewById,
  listScreeningRules,
  listScreeningReviews,
  listTrustWatchRuns,
  takedownTenantSite,
  upsertScreeningRule,
  type PublishSource,
  type ScreeningReviewDecision,
  type ScreeningReviewStatus,
} from "@punyasitus/db/content-screening/index";
import { createTenantDb, openTenantStoreStub } from "@punyasitus/db/connections";
import { resolveAuthEmailPort } from "../../../../middleware/auth.ts";
import {
  DEFAULT_FALLBACK_SAAS_ZONE,
  DEFAULT_PRIMARY_SAAS_ZONE,
  TRUST_POSITIF_IP_LIST_URL,
} from "../../../../worker/cron/trust-watch.ts";
import {
  type ConsoleAbuseHandlerOptions,
  type ConsoleAbuseRuntimeEnv,
} from "./_shared.ts";

/**
 * Shared Console API handlers for TASK-103 Shared-Domain Protection:
 * - `GET /api/console/abuse/screening`
 * - `GET /api/console/abuse/screening/:reviewId`
 * - `POST /api/console/abuse/screening/:reviewId/decision`
 * - `GET /api/console/abuse/rules` & `POST /api/console/abuse/rules`
 * - `POST /api/console/abuse/takedown`
 * - `GET /api/console/abuse/trust-watch`
 *
 * Security invariants:
 * - Non-console hosts ALWAYS receive bare neutral `404 Not Found` (`text/plain`).
 * - Active `platform_operators` grant + verified 2FA on every endpoint.
 * - All mutations require 10-minute 2FA step-up (`requireStepUp: true`), CSRF/Origin,
 *   mandatory audit reason (10–500 chars), optimistic `expectedVersion`, and atomic `platform_audit`.
 */

const DECISION_ALLOWED_KEYS = new Set([
  "decision",
  "reason",
  "expectedVersion",
  "version",
  "idempotencyKey",
]);

const TAKEDOWN_ALLOWED_KEYS = new Set([
  "tenantId",
  "expectedTenantVersion",
  "version",
  "reason",
  "reviewId",
  "reviewExpectedVersion",
  "idempotencyKey",
]);

const RULE_ALLOWED_KEYS = new Set([
  "ruleType",
  "pattern",
  "category",
  "severity",
  "active",
  "notes",
  "reason",
]);

export function mapContentScreeningErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof ContentScreeningError) {
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
 * `GET /api/console/abuse/screening` — Paginated, filterable publish screening review queue.
 */
export async function handleConsoleScreeningListRequest(
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.screening.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk melihat antrean tinjauan konten.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.screening.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
  const publishSource = (url.searchParams.get("publishSource") ?? "all").trim().toLowerCase();
  const search = url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : undefined;

  try {
    const result = await listScreeningReviews(authz.ctx.platformDb, {
      status: status as ScreeningReviewStatus | "all",
      publishSource: publishSource as PublishSource | "all",
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
    return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `GET /api/console/abuse/screening/:reviewId` — Full operator detail for a held review item.
 */
export async function handleConsoleScreeningDetailRequest(
  reviewId: string,
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.screening.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk melihat detail tinjauan konten.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.screening.read", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  try {
    const review = await getScreeningReviewById(authz.ctx.platformDb, reviewId);
    if (!review) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Item tinjauan konten tidak ditemukan.",
        authz.ctx.requestId,
      );
    }
    return consoleJsonResponse(200, {
      success: true,
      requestId: authz.ctx.requestId,
      review,
    });
  } catch (err) {
    return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `POST /api/console/abuse/screening/:reviewId/decision` — Release, reject, or takedown a held item.
 */
export async function handleConsoleScreeningDecisionRequest(
  reviewId: string,
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.screening.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk memutuskan tinjauan konten.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.screening.decision", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId, DECISION_ALLOWED_KEYS);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const decisionRaw = typeof body.decision === "string" ? body.decision.trim().toLowerCase() : "";
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

  // Bind TenantStore for release (fail closed if unavailable) or best-effort for reject/takedown
  let tenantDb: D1Database | null = null;
  const existing = await getScreeningReviewById(authz.ctx.platformDb, reviewId);
  if (existing) {
    try {
      if (options.resolveTenantDb) {
        tenantDb = await options.resolveTenantDb(existing.tenantId);
      } else if (runtimeEnv.TENANT_STORE) {
        tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, existing.tenantId));
      }
    } catch {
      if (decisionRaw === "release") {
        return consoleErrorResponse(
          503,
          "TENANT_STORE_UNAVAILABLE",
          "Penyimpanan data tenant tidak dapat dijangkau untuk mempublikasikan konten.",
          authz.ctx.requestId,
        );
      }
      tenantDb = null;
    }
    if (decisionRaw === "release" && !tenantDb) {
      return consoleErrorResponse(
        503,
        "TENANT_STORE_UNAVAILABLE",
        "Penyimpanan data tenant tidak tersedia untuk mempublikasikan konten.",
        authz.ctx.requestId,
      );
    }
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const jobsQueue = options.jobsQueue ?? runtimeEnv.JOBS_QUEUE ?? null;
  const appOrigin = host.isLocalLoopback
    ? host.baseURL
    : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`;

  try {
    const result = await decideScreeningReview(authz.ctx.platformDb, {
      reviewId,
      decision: decisionRaw as ScreeningReviewDecision,
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
      ...result,
    });
  } catch (err) {
    return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `POST /api/console/abuse/takedown` — One-click "Turunkan situs" (atomic suspend + audit).
 */
export async function handleConsoleTenantTakedownRequest(
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.takedown.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk menurunkan situs.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.tenant.takedown", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId, TAKEDOWN_ALLOWED_KEYS);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "tenantId wajib diisi untuk menurunkan situs.",
      authz.ctx.requestId,
    );
  }

  const rawVersion = body.expectedTenantVersion ?? body.version;
  let expectedTenantVersion: number | undefined;
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== "number" || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedTenantVersion harus berupa bilangan bulat positif.",
        authz.ctx.requestId,
      );
    }
    expectedTenantVersion = rawVersion;
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

  let tenantDb: D1Database | null = null;
  try {
    if (options.resolveTenantDb) {
      tenantDb = await options.resolveTenantDb(tenantId);
    } else if (runtimeEnv.TENANT_STORE) {
      tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, tenantId));
    }
  } catch {
    tenantDb = null;
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const jobsQueue = options.jobsQueue ?? runtimeEnv.JOBS_QUEUE ?? null;
  const appOrigin = host.isLocalLoopback
    ? host.baseURL
    : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`;

  const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() || null : null;
  let reviewExpectedVersion: number | undefined;
  if (reviewId) {
    if (
      typeof body.reviewExpectedVersion !== "number" ||
      !Number.isSafeInteger(body.reviewExpectedVersion) ||
      body.reviewExpectedVersion < 1
    ) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "reviewExpectedVersion wajib diisi berupa bilangan bulat positif saat menyertakan reviewId.",
        authz.ctx.requestId,
      );
    }
    reviewExpectedVersion = body.reviewExpectedVersion;
  }

  try {
    const result = await takedownTenantSite(authz.ctx.platformDb, {
      tenantId,
      expectedTenantVersion,
      reviewId,
      reviewExpectedVersion,
      reason: body.reason,
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
      ...result,
    });
  } catch (err) {
    return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
  }
}

/**
 * `GET /api/console/abuse/rules` & `POST /api/console/abuse/rules` — Denylist keyword/domain rules.
 */
export async function handleConsoleScreeningRulesRequest(
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.screening_rules.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    try {
      const rules = await listScreeningRules(authz.ctx.platformDb);
      return consoleJsonResponse(200, {
        success: true,
        requestId: authz.ctx.requestId,
        ...rules,
      });
    } catch (err) {
      return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.screening_rules.upsert", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(request, authz.ctx.requestId, RULE_ALLOWED_KEYS);
    if (!parsed.ok) return parsed.response;

    try {
      const res = await upsertScreeningRule(authz.ctx.platformDb, {
        ruleType: parsed.body.ruleType,
        pattern: parsed.body.pattern,
        category: parsed.body.category,
        severity: parsed.body.severity,
        active: parsed.body.active,
        notes: parsed.body.notes,
        reason: parsed.body.reason,
        actorUserId: authz.ctx.actor.userId,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });
      return consoleJsonResponse(res.created ? 201 : 200, {
        success: true,
        requestId: authz.ctx.requestId,
        ...res,
      });
    } catch (err) {
      return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.screening_rules.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;
  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Gunakan GET atau POST untuk mengelola aturan penyaringan.",
    requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

/**
 * `GET /api/console/abuse/trust-watch` — Daily Trust+ Komdigi watch status & fallback zone metadata.
 */
export async function handleConsoleTrustWatchRequest(
  request: Request,
  runtimeEnv: ConsoleAbuseRuntimeEnv,
  options: ConsoleAbuseHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) return consoleNeutralNotFoundResponse();

  const requestId = options.requestId ?? createConsoleRequestId();
  if (request.method.toUpperCase() !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.trust_watch.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk melihat status pantauan Trust+.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.trust_watch.read", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : 14;

  try {
    const runs = await listTrustWatchRuns(authz.ctx.platformDb, limit);
    const primaryZone = normalizeHost(runtimeEnv.SAAS_ZONE) ?? DEFAULT_PRIMARY_SAAS_ZONE;
    return consoleJsonResponse(200, {
      success: true,
      requestId: authz.ctx.requestId,
      latestRun: runs[0] ?? null,
      runs,
      listSourceUrl: TRUST_POSITIF_IP_LIST_URL,
      zones: {
        primary: {
          zone: primaryZone,
          cnameTarget: `cname.${primaryZone}`,
          fallbackOrigin: `fallback.${primaryZone}`,
        },
        standbyFallback: {
          zone: DEFAULT_FALLBACK_SAAS_ZONE,
          cnameTarget: `cname.${DEFAULT_FALLBACK_SAAS_ZONE}`,
          fallbackOrigin: `fallback.${DEFAULT_FALLBACK_SAAS_ZONE}`,
          activationMode: "manual_operator_runbook",
          automaticFailover: false,
          runbookPath: "docs/operations/trust-positif.md",
        },
      },
    });
  } catch (err) {
    return mapContentScreeningErrorToResponse(err, authz.ctx.requestId);
  }
}
