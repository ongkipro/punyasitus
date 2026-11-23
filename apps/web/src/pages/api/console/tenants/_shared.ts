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
import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  ConsoleTenantError,
  executeConsoleTenantStateTransition,
  getConsoleTenantDetail,
  listConsoleTenantsDirectory,
  listConsoleTenantThemeGrants,
  manageConsoleTenantThemeGrant,
  type ConsoleStateTransitionAction,
  type TenantVertical,
} from "@punyasitus/db/platform";
import { ProvisioningError, provisionTenantAtomically } from "@punyasitus/db/provisioning/index";
import {
  getRegisteredTheme,
  isPlatformThemeId,
  isRegisteredCustomThemeId,
  REGISTERED_CUSTOM_THEMES,
} from "../../../../core/theme-registry.ts";
import { resolveAuthEmailPort } from "../../../../middleware/auth.ts";

/**
 * Shared Console Operasional Platform API handlers for Superadmin Tenant Directory
 * and Scoped Operations (TASK-046, REQ-049, REQ-034, REQ-035, REQ-046, REQ-051; PLAN §13).
 *
 * Security invariants:
 * - Non-console hosts ALWAYS receive a bare neutral `404` (`text/plain` "Not Found").
 * - Every endpoint verifies live session + active `platform_operators` grant + mandatory 2FA.
 * - Every mutation (`POST`) enforces CSRF/Origin, strict JSON field allowlist, 10-minute
 *   step-up 2FA (`requireStepUp: true`), mandatory audit reason (10-500 chars), optimistic
 *   `expectedVersion` (on existing tenants), and mandatory `Idempotency-Key`.
 * - ZERO request-time DDL and ZERO tenant content/PII browsing.
 */

export interface ConsoleTenantsRuntimeEnv extends ConsoleRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface ConsoleTenantsHandlerOptions extends ConsoleHandlerOptions {
  readonly emailPort?: EmailPort | null;
}

const ULID_SELECTOR_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ALLOWED_PROVISION_KEYS = new Set([
  "handle",
  "name",
  "ownerEmail",
  "vertical",
  "initialStatus",
  "reason",
  "idempotencyKey",
  "paidThroughMs",
  "trialEndsAtMs",
]);

const ALLOWED_STATE_KEYS = new Set([
  "action",
  "targetStatus",
  "operatorHold",
  "paidThroughMs",
  "trialEndsAtMs",
  "reason",
  "expectedVersion",
  "idempotencyKey",
]);

const ALLOWED_THEME_KEYS = new Set([
  "themeId",
  "action",
  "reason",
  "expectedVersion",
  "idempotencyKey",
]);

const VALID_STATE_ACTIONS = new Set<ConsoleStateTransitionAction>([
  "suspend_hold",
  "release_hold",
  "enter_recovery",
  "exit_recovery",
  "set_status",
]);

const VALID_TARGET_STATUSES = new Set([
  "trial",
  "active",
  "grace",
  "locked",
  "suspended",
  "recovery",
]);

export function buildConsoleTenantsRuntimeEnv(rawEnv: {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: unknown;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: unknown;
}): ConsoleTenantsRuntimeEnv {
  return {
    APP_ENV: rawEnv.APP_ENV,
    PLATFORM_DOMAIN: rawEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: rawEnv.SAAS_ZONE,
    PLATFORM_DB: rawEnv.PLATFORM_DB,
    TENANT_STORE: rawEnv.TENANT_STORE as TenantStoreNamespaceLike | undefined,
    AUTH_SECRET: rawEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: rawEnv.CONSOLE_AUTH_SECRET,
    EMAIL: rawEnv.EMAIL as CloudflareSendEmailBinding | undefined,
  };
}

export function listRegisteredCustomThemeSummaries() {
  return Object.values(REGISTERED_CUSTOM_THEMES).map((theme) => ({
    id: theme.id,
    slug: theme.slug,
    name: theme.name,
    description: theme.description,
    version: theme.version,
    basePlatformThemeId: theme.basePlatformThemeId,
    distribution: theme.agencyScope?.distribution ?? "private_client",
  }));
}

function parseTenantSelector(rawSelector: string): {
  readonly tenantId?: string;
  readonly handle?: string;
} | null {
  const clean = rawSelector.trim();
  if (!clean) return null;
  if (ULID_SELECTOR_RE.test(clean)) {
    return { tenantId: clean };
  }
  return { handle: clean.toLowerCase() };
}

function resolveIdempotencyKeyFromRequest(
  request: Request,
  body: Record<string, unknown>,
  requestId: string,
): { readonly ok: true; readonly key: string } | { readonly ok: false; readonly response: Response } {
  const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

  if (headerKey && bodyKey && headerKey !== bodyKey) {
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

  const resolved = headerKey || bodyKey;
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

function mapTenantDomainError(err: unknown, requestId: string): Response {
  if (err instanceof ConsoleTenantError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof ProvisioningError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }
  return consoleErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses operasi tenant console.",
    requestId,
  );
}

/**
 * `GET /api/console/tenants` (list/search/filter/paginate) and
 * `POST /api/console/tenants` (atomic audited tenant provisioning).
 */
export async function handleConsoleTenantsCollectionRequest(
  request: Request,
  runtimeEnv: ConsoleTenantsRuntimeEnv,
  options: ConsoleTenantsHandlerOptions = {},
): Promise<Response> {
  // 1. Strict non-console host isolation -> bare neutral 404 (never leaks console copy!)
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: method === "POST" ? "console.tenant.provision" : "console.tenant.list",
      requireStepUp: method === "POST",
    },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const { platformDb, actor, nowMs } = authz.ctx;
  const saasZone = runtimeEnv.SAAS_ZONE || PLATFORM_HOSTS.saasZone;

  if (method === "GET") {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const vertical = url.searchParams.get("vertical") ?? undefined;

    const rawPage = url.searchParams.get("page");
    const rawLimit = url.searchParams.get("limit");
    const parsedPage = rawPage !== null && rawPage.trim() !== "" ? Number(rawPage) : undefined;
    const parsedLimit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : undefined;

    if (
      parsedPage !== undefined &&
      (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000)
    ) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter page harus berupa bilangan bulat antara 1 hingga 1000.",
        requestId,
      );
    }

    if (
      parsedLimit !== undefined &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
    ) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter limit harus berupa bilangan bulat antara 1 hingga 100.",
        requestId,
      );
    }

    try {
      const directory = await listConsoleTenantsDirectory(platformDb, {
        search,
        status,
        vertical,
        page: parsedPage,
        limit: parsedLimit,
        nowMs,
        saasZone,
      });

      return consoleJsonResponse(200, {
        success: true,
        requestId,
        ...directory,
      });
    } catch (err) {
      return mapTenantDomainError(err, requestId);
    }
  }

  // POST /api/console/tenants — Atomic audited tenant provisioning
  const parsedBody = await parseStrictConsoleJsonBody(request, requestId, ALLOWED_PROVISION_KEYS);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.body;

  const idemp = resolveIdempotencyKeyFromRequest(request, body, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  if (
    typeof body.handle !== "string" ||
    typeof body.name !== "string" ||
    typeof body.ownerEmail !== "string" ||
    typeof body.reason !== "string"
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field handle, name, ownerEmail, dan reason wajib berupa string.",
      requestId,
    );
  }

  if (
    body.initialStatus !== undefined &&
    body.initialStatus !== "trial" &&
    body.initialStatus !== "active"
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      'Field initialStatus hanya boleh bernilai "trial" atau "active".',
      requestId,
    );
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
  const appBaseUrl = host.isLocalLoopback
    ? host.baseURL
    : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`;

  try {
    const result = await provisionTenantAtomically(platformDb, {
      actorUserId: actor.userId,
      handle: body.handle,
      name: body.name,
      ownerEmail: body.ownerEmail,
      vertical: typeof body.vertical === "string" ? (body.vertical as TenantVertical) : undefined,
      initialStatus: body.initialStatus === "active" ? "active" : "trial",
      paidThroughMs: typeof body.paidThroughMs === "number" ? body.paidThroughMs : undefined,
      trialEndsAtMs: typeof body.trialEndsAtMs === "number" ? body.trialEndsAtMs : undefined,
      reason: body.reason,
      idempotencyKey: idemp.key,
      requestId,
      saasZone,
      appBaseUrl,
      emailPort,
      tenantStore: runtimeEnv.TENANT_STORE ?? null,
      nowMs,
    });

    return consoleJsonResponse(result.replayed ? 200 : 201, {
      success: true,
      requestId,
      replayed: result.replayed,
      tenantStoreInitialized: result.tenantStoreInitialized,
      tenant: result.tenant,
      ownerAssignment:
        result.ownerAssignment.kind === "member"
          ? {
              kind: "member",
              memberId: result.ownerAssignment.memberId,
              userId: result.ownerAssignment.userId,
            }
          : {
              kind: "invitation",
              invitationId: result.ownerAssignment.invitationId,
              email: result.ownerAssignment.email,
              expiresAtMs: result.ownerAssignment.expiresAtMs,
              invitationDeliveryStatus: result.ownerAssignment.invitationDeliveryStatus,
            },
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    return mapTenantDomainError(err, requestId);
  }
}

/**
 * `GET /api/console/tenants/[tenantId]` — Control-plane tenant detail (by ULID or handle).
 */
export async function handleConsoleTenantDetailRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: ConsoleTenantsRuntimeEnv,
  options: ConsoleTenantsHandlerOptions = {},
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
    { action: "console.tenant.detail", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const selector = parseTenantSelector(tenantSelector);
  if (!selector) {
    return consoleErrorResponse(404, "NOT_FOUND", "Selector tenant tidak valid.", requestId);
  }

  const saasZone = runtimeEnv.SAAS_ZONE || PLATFORM_HOSTS.saasZone;
  try {
    const detail = await getConsoleTenantDetail(authz.ctx.platformDb, selector, {
      nowMs: authz.ctx.nowMs,
      saasZone,
      tenantStore: runtimeEnv.TENANT_STORE ?? null,
    });

    if (!detail) {
      return consoleErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId);
    }

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      ...detail,
      registeredCustomThemes: listRegisteredCustomThemeSummaries(),
    });
  } catch (err) {
    return mapTenantDomainError(err, requestId);
  }
}

/**
 * `POST /api/console/tenants/[tenantId]/state` — Strict audited service-state transition.
 */
export async function handleConsoleTenantStateActionRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: ConsoleTenantsRuntimeEnv,
  options: ConsoleTenantsHandlerOptions = {},
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
    { action: "console.tenant.state_transition", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const selector = parseTenantSelector(tenantSelector);
  if (!selector) {
    return consoleErrorResponse(404, "NOT_FOUND", "Selector tenant tidak valid.", requestId);
  }

  const parsedBody = await parseStrictConsoleJsonBody(request, requestId, ALLOWED_STATE_KEYS);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.body;

  const idemp = resolveIdempotencyKeyFromRequest(request, body, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  if (
    typeof body.action !== "string" ||
    !VALID_STATE_ACTIONS.has(body.action as ConsoleStateTransitionAction)
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Aksi transisi status tidak valid.",
      requestId,
    );
  }

  if (typeof body.reason !== "string") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Alasan operasional (10-500 karakter) wajib diisi.",
      requestId,
    );
  }

  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif.",
      requestId,
    );
  }

  let targetStatus:
    | "trial"
    | "active"
    | "grace"
    | "locked"
    | "suspended"
    | "recovery"
    | undefined;
  if (body.targetStatus !== undefined) {
    if (typeof body.targetStatus !== "string" || !VALID_TARGET_STATUSES.has(body.targetStatus)) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Nilai targetStatus "${String(body.targetStatus)}" tidak valid.`,
        requestId,
      );
    }
    targetStatus = body.targetStatus as
      | "trial"
      | "active"
      | "grace"
      | "locked"
      | "suspended"
      | "recovery";
  }

  if (body.operatorHold !== undefined && typeof body.operatorHold !== "boolean") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field operatorHold harus berupa boolean jika disertakan.",
      requestId,
    );
  }

  if (
    body.paidThroughMs !== undefined &&
    body.paidThroughMs !== null &&
    (typeof body.paidThroughMs !== "number" || !Number.isSafeInteger(body.paidThroughMs))
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field paidThroughMs harus berupa bilangan bulat epoch ms atau null jika disertakan.",
      requestId,
    );
  }

  if (
    body.trialEndsAtMs !== undefined &&
    body.trialEndsAtMs !== null &&
    (typeof body.trialEndsAtMs !== "number" || !Number.isSafeInteger(body.trialEndsAtMs))
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field trialEndsAtMs harus berupa bilangan bulat epoch ms atau null jika disertakan.",
      requestId,
    );
  }

  const paidThroughMs: number | null | undefined =
    body.paidThroughMs === undefined
      ? undefined
      : body.paidThroughMs === null
        ? null
        : body.paidThroughMs;
  const trialEndsAtMs: number | null | undefined =
    body.trialEndsAtMs === undefined
      ? undefined
      : body.trialEndsAtMs === null
        ? null
        : body.trialEndsAtMs;
  const operatorHold: boolean | undefined =
    body.operatorHold === undefined ? undefined : body.operatorHold;

  const saasZone = runtimeEnv.SAAS_ZONE || PLATFORM_HOSTS.saasZone;

  try {
    const result = await executeConsoleTenantStateTransition(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      tenantId: selector.tenantId,
      handle: selector.handle,
      action: body.action as ConsoleStateTransitionAction,
      targetStatus,
      operatorHold,
      paidThroughMs,
      trialEndsAtMs,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      idempotencyKey: idemp.key,
      requestId,
      saasZone,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: result.replayed,
      previousStatus: result.previousStatus,
      previousOperatorHold: result.previousOperatorHold,
      tenant: result.tenant,
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    return mapTenantDomainError(err, requestId);
  }
}

/**
 * `GET /api/console/tenants/[tenantId]/themes` (list tenant theme grants & registered custom themes)
 * and `POST /api/console/tenants/[tenantId]/themes` (grant or revoke registered custom theme).
 */
export async function handleConsoleTenantThemesRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: ConsoleTenantsRuntimeEnv,
  options: ConsoleTenantsHandlerOptions = {},
): Promise<Response> {
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: method === "POST" ? "console.tenant.theme_grant" : "console.tenant.themes.list",
      requireStepUp: method === "POST",
    },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const selector = parseTenantSelector(tenantSelector);
  if (!selector) {
    return consoleErrorResponse(404, "NOT_FOUND", "Selector tenant tidak valid.", requestId);
  }

  const saasZone = runtimeEnv.SAAS_ZONE || PLATFORM_HOSTS.saasZone;

  if (method === "GET") {
    try {
      const detail = await getConsoleTenantDetail(authz.ctx.platformDb, selector, {
        nowMs: authz.ctx.nowMs,
        saasZone,
        tenantStore: runtimeEnv.TENANT_STORE ?? null,
      });
      if (!detail) {
        return consoleErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId);
      }

      const grants = await listConsoleTenantThemeGrants(authz.ctx.platformDb, detail.tenant.id);
      return consoleJsonResponse(200, {
        success: true,
        requestId,
        tenantId: detail.tenant.id,
        handle: detail.tenant.handle,
        version: detail.tenant.version,
        activeThemeId: detail.activeThemeId,
        activeThemeVerificationStatus: detail.activeThemeVerificationStatus,
        grantedThemes: grants,
        registeredCustomThemes: listRegisteredCustomThemeSummaries(),
      });
    } catch (err) {
      return mapTenantDomainError(err, requestId);
    }
  }

  // POST /api/console/tenants/[tenantId]/themes — Grant or revoke registered custom theme
  const parsedBody = await parseStrictConsoleJsonBody(request, requestId, ALLOWED_THEME_KEYS);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.body;

  const idemp = resolveIdempotencyKeyFromRequest(request, body, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  if (typeof body.themeId !== "string" || !body.themeId.trim()) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field themeId wajib berupa string ID tema yang valid.",
      requestId,
    );
  }

  if (body.action !== "grant" && body.action !== "revoke") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      'Field action hanya boleh bernilai "grant" atau "revoke".',
      requestId,
    );
  }

  if (typeof body.reason !== "string") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Alasan operasional (10-500 karakter) wajib diisi.",
      requestId,
    );
  }

  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif.",
      requestId,
    );
  }

  const normalizedThemeId = body.themeId.trim();
  const isBuiltIn = isPlatformThemeId(normalizedThemeId);
  const customManifest = isRegisteredCustomThemeId(normalizedThemeId)
    ? getRegisteredTheme(normalizedThemeId)
    : null;

  try {
    const result = await manageConsoleTenantThemeGrant(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      tenantId: selector.tenantId,
      handle: selector.handle,
      themeId: normalizedThemeId,
      action: body.action,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      idempotencyKey: idemp.key,
      registeredCustomTheme:
        customManifest && customManifest.isCustom
          ? {
              id: customManifest.id,
              slug: customManifest.slug,
              name: customManifest.name,
            }
          : null,
      isBuiltInPlatformTheme: isBuiltIn,
      tenantStore: runtimeEnv.TENANT_STORE ?? null,
      requestId,
      saasZone,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      action: result.action,
      themeId: result.themeId,
      replayed: result.replayed,
      tenant: result.tenant,
      grantedThemes: result.grantedThemes,
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    return mapTenantDomainError(err, requestId);
  }
}
