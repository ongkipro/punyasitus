import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
  PlatformGuardError,
  requireActivePlatformOperator,
  requireRecentSecondFactor,
  resolveExpectedAdminOrigin,
} from "@punyasitus/auth";
import { normalizeHost, PLATFORM_HOSTS, type SurfaceKind } from "@punyasitus/core";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantStatus, TenantVertical } from "@punyasitus/db/platform";
import {
  listProvisionedTenants,
  ProvisioningError,
  provisionTenantAtomically,
  transitionTenantServiceState,
  type ServiceStateTransitionAction,
} from "@punyasitus/db/provisioning/index";
import {
  resolveAuthEmailPort,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";

/**
 * Shared Console Operasional Platform API guards & handlers for tenant provisioning
 * and audited service-state transitions (TASK-026, REQ-035, REQ-005, REQ-034; PLAN §13).
 *
 * Security boundaries:
 * - Served ONLY on `console.punyasitus.com` (or explicit local loopback when `APP_ENV === "local"`).
 * - State-changing methods require `Content-Type: application/json` + exact expected console `Origin`.
 * - Reads enforce active session lifetime ceiling + active `platform_operators` grant + verified 2FA.
 * - Privileged mutations (provisioning & state transitions) enforce `requireRecentSecondFactor`
 *   (2FA verification within the last 10 minutes).
 */

export interface ConsoleProvisioningEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface ConsoleProvisioningHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  /** Optional explicit reauth window override for unit/integration tests (default 10 minutes). */
  readonly secondFactorWindowMs?: number;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

export function jsonConsoleResponse(
  status: number,
  body: Readonly<Record<string, unknown>>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveConsoleHostContext(
  request: Request,
  runtimeEnv: ConsoleProvisioningEnv,
): {
  readonly allowed: true;
  readonly surface: "console" | "app";
  readonly authSurface: "console" | "app";
  readonly expectedOrigin: string;
  readonly baseURL: string;
  readonly isLocalLoopback: boolean;
} | {
  readonly allowed: false;
} {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { allowed: false };
  }

  if (runtimeEnv.APP_ENV === "local" && isLoopbackHostname(url.hostname)) {
    return {
      allowed: true,
      surface: "console",
      authSurface: "app",
      expectedOrigin: url.origin,
      baseURL: url.origin,
      isLocalLoopback: true,
    };
  }

  const normalizedHost = normalizeHost(url.hostname);
  if (!normalizedHost) return { allowed: false };

  const platformDomain = normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const consoleHost = `console.${platformDomain}`;
  if (normalizedHost !== consoleHost) {
    return { allowed: false };
  }

  const expectedOrigin =
    resolveExpectedAdminOrigin(request, {
      surface: "console" as SurfaceKind,
      platformDomain: runtimeEnv.PLATFORM_DOMAIN,
      isLocalLoopback: false,
    }) ?? `https://${consoleHost}`;

  return {
    allowed: true,
    surface: "console",
    authSurface: "console",
    expectedOrigin,
    baseURL: expectedOrigin,
    isLocalLoopback: false,
  };
}

async function authenticateConsoleOperator(
  request: Request,
  runtimeEnv: ConsoleProvisioningEnv,
  options: ConsoleProvisioningHandlerOptions & {
    readonly requireRecent2fa: boolean;
    readonly action: string;
  },
): Promise<
  | {
      readonly ok: true;
      readonly userId: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly saasZone: string;
      readonly appBaseUrl: string;
      readonly platformDb: D1Database;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const hostCtx = resolveConsoleHostContext(request, runtimeEnv);
  if (!hostCtx.allowed) {
    return {
      ok: false,
      response: jsonConsoleResponse(404, {
        success: false,
        code: "NOT_FOUND",
        message: "Endpoint hanya tersedia pada console.punyasitus.com.",
      }),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: jsonConsoleResponse(csrf.status, {
          success: false,
          code: csrf.code,
          message: csrf.reason,
        }),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: jsonConsoleResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Layanan database platform sedang tidak tersedia.",
      }),
    };
  }

  const secret = resolveSurfaceAuthSecret(hostCtx.authSurface, runtimeEnv);
  if (!secret) {
    return {
      ok: false,
      response: jsonConsoleResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Konfigurasi autentikasi console belum lengkap.",
      }),
    };
  }

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requestId =
    request.headers.get("x-request-id")?.trim() ||
    `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: hostCtx.authSurface,
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv),
  });

  const sessionResult = await auth.api.getSession({ headers: request.headers });
  if (!sessionResult?.user || !sessionResult.session) {
    return {
      ok: false,
      response: jsonConsoleResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Sesi operator platform yang terautentikasi wajib digunakan.",
      }),
    };
  }

  const lifetimeCheck = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "console",
    pathname: new URL(request.url).pathname,
    nowMs,
  });
  if (!lifetimeCheck.valid) {
    return {
      ok: false,
      response: jsonConsoleResponse(401, {
        success: false,
        code: "SESSION_EXPIRED",
        message: "Sesi operator platform telah kedaluwarsa. Silakan masuk kembali.",
      }),
    };
  }

  try {
    const actor = options.requireRecent2fa
      ? await requireRecentSecondFactor(runtimeEnv.PLATFORM_DB, {
          session: {
            id: sessionResult.session.id,
            userId: sessionResult.session.userId,
            token: sessionResult.session.token,
          },
          user: {
            id: sessionResult.user.id,
            email: sessionResult.user.email,
          },
          action: options.action,
          requestId,
          windowMs: options.secondFactorWindowMs,
          nowMs,
        })
      : await requireActivePlatformOperator(runtimeEnv.PLATFORM_DB, {
          session: {
            id: sessionResult.session.id,
            userId: sessionResult.session.userId,
            token: sessionResult.session.token,
          },
          user: {
            id: sessionResult.user.id,
            email: sessionResult.user.email,
          },
          requireTwoFactor: true,
          action: options.action,
          requestId,
          nowMs,
        });

    return {
      ok: true,
      userId: actor.userId,
      sessionId: actor.sessionId,
      requestId,
      saasZone: runtimeEnv.SAAS_ZONE || PLATFORM_HOSTS.saasZone,
      appBaseUrl: hostCtx.isLocalLoopback
        ? hostCtx.baseURL
        : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`,
      platformDb: runtimeEnv.PLATFORM_DB,
    };
  } catch (err) {
    if (err instanceof PlatformGuardError) {
      return {
        ok: false,
        response: jsonConsoleResponse(err.status, {
          success: false,
          code: err.code,
          message: err.message,
        }),
      };
    }
    return {
      ok: false,
      response: jsonConsoleResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Gagal memverifikasi otorisasi operator platform.",
      }),
    };
  }
}

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

export async function handleConsoleProvisioningRequest(
  request: Request,
  runtimeEnv: ConsoleProvisioningEnv,
  options: ConsoleProvisioningHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonConsoleResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  const authCtx = await authenticateConsoleOperator(request, runtimeEnv, {
    ...options,
    requireRecent2fa: method === "POST",
    action: method === "POST" ? "console.tenant.provision" : "console.tenant.list",
  });
  if (!authCtx.ok) {
    return authCtx.response;
  }

  if (method === "GET") {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? undefined;
    const rawStatus = url.searchParams.get("status") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const tenants = await listProvisionedTenants(authCtx.platformDb, {
      search,
      status: rawStatus as TenantStatus | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      nowMs: options.nowMs,
      saasZone: authCtx.saasZone,
    });

    return jsonConsoleResponse(200, {
      success: true,
      items: tenants,
    });
  }

  // POST: Atomic Operator Provisioning
  const body = await parseJsonBody(request);
  if (!body) {
    return jsonConsoleResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Body JSON permintaan tidak valid.",
    });
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_PROVISION_KEYS.has(key)) {
      return jsonConsoleResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: `Field tidak dikenal: "${key}".`,
      });
    }
  }

  const headerIdemp = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyIdemp = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (headerIdemp && bodyIdemp && headerIdemp !== bodyIdemp) {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Header Idempotency-Key dan field body idempotencyKey tidak cocok.",
    });
  }
  const idempotencyKey = headerIdemp || bodyIdemp;
  if (!idempotencyKey) {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Idempotency-Key wajib disertakan untuk provisioning tenant.",
    });
  }

  if (
    typeof body.handle !== "string" ||
    typeof body.name !== "string" ||
    typeof body.ownerEmail !== "string" ||
    typeof body.reason !== "string"
  ) {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Field handle, name, ownerEmail, dan reason wajib berupa string.",
    });
  }

  const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);

  try {
    const result = await provisionTenantAtomically(authCtx.platformDb, {
      actorUserId: authCtx.userId,
      handle: body.handle,
      name: body.name,
      ownerEmail: body.ownerEmail,
      vertical: typeof body.vertical === "string" ? (body.vertical as TenantVertical) : undefined,
      initialStatus:
        body.initialStatus === "active" || body.initialStatus === "trial"
          ? body.initialStatus
          : "trial",
      paidThroughMs: typeof body.paidThroughMs === "number" ? body.paidThroughMs : undefined,
      trialEndsAtMs: typeof body.trialEndsAtMs === "number" ? body.trialEndsAtMs : undefined,
      reason: body.reason,
      idempotencyKey,
      requestId: authCtx.requestId,
      saasZone: authCtx.saasZone,
      appBaseUrl: authCtx.appBaseUrl,
      emailPort,
      tenantStore: runtimeEnv.TENANT_STORE ?? null,
      nowMs: options.nowMs,
    });

    return jsonConsoleResponse(result.replayed ? 200 : 201, {
      success: true,
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
    if (err instanceof ProvisioningError) {
      return jsonConsoleResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonConsoleResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses provisioning tenant.",
    });
  }
}

const VALID_STATE_ACTIONS = new Set<ServiceStateTransitionAction>([
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

export async function handleConsoleTenantStateRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: ConsoleProvisioningEnv,
  options: ConsoleProvisioningHandlerOptions = {},
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return jsonConsoleResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode HTTP tidak diizinkan.",
    });
  }

  const authCtx = await authenticateConsoleOperator(request, runtimeEnv, {
    ...options,
    requireRecent2fa: true,
    action: "console.tenant.state_transition",
  });
  if (!authCtx.ok) {
    return authCtx.response;
  }

  const cleanSelector = tenantSelector.trim();
  if (!cleanSelector) {
    return jsonConsoleResponse(404, {
      success: false,
      code: "NOT_FOUND",
      message: "Selector tenant tidak valid.",
    });
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonConsoleResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Body JSON permintaan tidak valid.",
    });
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_STATE_KEYS.has(key)) {
      return jsonConsoleResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: `Field tidak dikenal: "${key}".`,
      });
    }
  }

  if (typeof body.action !== "string" || !VALID_STATE_ACTIONS.has(body.action as ServiceStateTransitionAction)) {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Aksi transisi status tidak valid.",
    });
  }

  if (typeof body.reason !== "string") {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Alasan operasional (10-500 karakter) wajib diisi.",
    });
  }

  const targetStatus =
    typeof body.targetStatus === "string" && VALID_TARGET_STATUSES.has(body.targetStatus)
      ? (body.targetStatus as "trial" | "active" | "grace" | "locked" | "suspended" | "recovery")
      : undefined;

  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return jsonConsoleResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: "Field expectedVersion wajib berupa bilangan bulat positif.",
    });
  }
  const expectedVersion = body.expectedVersion;

  const paidThroughMs =
    body.paidThroughMs === null
      ? null
      : typeof body.paidThroughMs === "number"
        ? body.paidThroughMs
        : undefined;
  const trialEndsAtMs =
    body.trialEndsAtMs === null
      ? null
      : typeof body.trialEndsAtMs === "number"
        ? body.trialEndsAtMs
        : undefined;

  const headerIdemp = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyIdemp = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey = headerIdemp || bodyIdemp || undefined;

  const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(cleanSelector);

  try {
    const result = await transitionTenantServiceState(authCtx.platformDb, {
      actorUserId: authCtx.userId,
      tenantId: looksLikeUlid ? cleanSelector : undefined,
      handle: looksLikeUlid ? undefined : cleanSelector.toLowerCase(),
      action: body.action as ServiceStateTransitionAction,
      targetStatus,
      operatorHold: typeof body.operatorHold === "boolean" ? body.operatorHold : undefined,
      paidThroughMs,
      trialEndsAtMs,
      reason: body.reason,
      expectedVersion,
      idempotencyKey,
      requestId: authCtx.requestId,
      nowMs: options.nowMs,
    });

    return jsonConsoleResponse(200, {
      success: true,
      replayed: result.replayed,
      previousStatus: result.previousStatus,
      previousOperatorHold: result.previousOperatorHold,
      tenant: result.tenant,
      auditId: result.audit?.id ?? null,
    });
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return jsonConsoleResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return jsonConsoleResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat mengubah status layanan tenant.",
    });
  }
}

export function buildConsoleRuntimeEnv(rawEnv: {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly TENANT_STORE?: unknown;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: unknown;
}): ConsoleProvisioningEnv {
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
