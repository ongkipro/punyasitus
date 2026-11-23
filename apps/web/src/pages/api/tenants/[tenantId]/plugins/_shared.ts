import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  canPerform,
  createAuth,
  enforceSessionLifetimeCeiling,
  isActionAllowedForTenantStatus,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { loadLiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  PluginSqlViolationError,
  readBoundedRequestBody,
  type PluginTenantSnapshot,
} from "@punyasitus/core/plugins/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike, TenantStoreRpcStub } from "@punyasitus/db/connections";
import {
  PluginMigrationError,
  PluginRepositoryError,
  type ScopedPluginTenantDbOptions,
} from "@punyasitus/db/plugins/index";
import type { PluginRegistry } from "../../../../../core/plugin-registry.ts";
import { PluginRuntimeError, type PluginRuntimeDeps } from "../../../../../core/plugin-runtime.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared auth, CSRF/Origin, RBAC, lifecycle, and strict DTO guards for
 * `/api/tenants/:tenantId/plugins/**` (REQ-097, REQ-034, REQ-060, TASK-097).
 */

export const MAX_PLUGIN_API_BODY_BYTES = 65_536 as const; // 64 KiB cap
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const FORBIDDEN_SELECTOR_KEYS = new Set<string>([
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "role",
  "roles",
  "actorId",
  "actor_id",
  "platformOperator",
  "isSuperadmin",
]);

export const PLUGIN_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantPluginRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantPluginHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly registry?: PluginRegistry;
  readonly resolveTenantStub?: (tenantId: string) => TenantStoreRpcStub;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly getBookmark?: () => Promise<string>;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}

export interface AuthorizedPluginApiContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly tenant: PluginTenantSnapshot;
  readonly runtimeDeps: PluginRuntimeDeps;
}

export type AuthorizePluginApiResult =
  | { readonly ok: true; readonly ctx: AuthorizedPluginApiContext }
  | { readonly ok: false; readonly response: Response };

export function createPluginRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function pluginJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...PLUGIN_NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

export function pluginErrorResponse(
  status: number,
  code: ApiErrorCode | string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  return pluginJsonResponse(
    status,
    {
      error: { code, message },
      requestId,
    },
    extraHeaders,
  );
}

export async function parseStrictPluginJsonBody(
  request: Request,
  requestId: string,
  allowedKeys?: ReadonlySet<string>,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return {
      ok: false,
      response: pluginErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
        requestId,
      ),
    };
  }

  const bounded = await readBoundedRequestBody(request, MAX_PLUGIN_API_BODY_BYTES);
  if (!bounded.ok) {
    if (bounded.reason === "too_large") {
      return {
        ok: false,
        response: pluginErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          "Ukuran body permintaan melebihi batas maksimal 64 KiB.",
          requestId,
        ),
      };
    }
    return {
      ok: false,
      response: pluginErrorResponse(400, "BAD_REQUEST", "Body permintaan tidak dapat dibaca.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return {
      ok: false,
      response: pluginErrorResponse(400, "BAD_REQUEST", "Body JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: pluginErrorResponse(422, "VALIDATION_ERROR", "Body JSON harus berupa objek.", requestId),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_SELECTOR_KEYS.has(key)) {
      return {
        ok: false,
        response: pluginErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan pada body permintaan.`,
          requestId,
        ),
      };
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      return {
        ok: false,
        response: pluginErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak dikenali.`,
          requestId,
        ),
      };
    }
  }

  return { ok: true, body: record };
}

/**
 * Authorizes `/api/tenants/:tenantId/plugins/**` requests BEFORE any `TenantStore` read:
 * 1. Host isolation (`app` surface or local loopback only)
 * 2. CSRF / Origin enforcement on mutations
 * 3. Better Auth session verification
 * 4. Tenant membership resolution (cross-tenant -> neutral 404)
 * 5. Live server-clock lifecycle entitlement gate (`locked` blocks mutations 403 SUBSCRIPTION_LOCKED;
 *    `suspended`/`recovery`/`purging`/`operatorHold` blocks access 403 with zero TenantStore reads)
 * 6. RBAC permission check (`content:read` for GET, `settings:write` for mutations; editor -> 403)
 */
export async function authorizeTenantPluginRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantPluginRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantPluginHandlerOptions = {},
): Promise<AuthorizePluginApiResult> {
  const requestId = options.requestId ?? createPluginRequestId();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: pluginErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: pluginErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: pluginErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
      ),
    };
  }

  let actorUserId = options.authenticatedUser?.id ?? null;
  if (!actorUserId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: pluginErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum siap.",
          requestId,
        ),
      };
    }
    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
      });
      const sessionRes = await auth.api.getSession({ headers: request.headers });
      if (sessionRes?.user && sessionRes.session) {
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionRes.session.id,
          userId: sessionRes.user.id,
          surface: "app",
          pathname: new URL(request.url).pathname.toLowerCase(),
          nowMs: options.nowMs,
        });
        if (lifetime.valid) {
          actorUserId = sessionRes.user.id;
        }
      }
    } catch {
      actorUserId = null;
    }
  }

  if (!actorUserId) {
    return {
      ok: false,
      response: pluginErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  const cleanSelector = tenantSelector.trim();
  if (!cleanSelector) {
    return {
      ok: false,
      response: pluginErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  let member: AuthorizedTenantMember;
  try {
    // Support both handle and ULID tenantId selector
    const isUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(cleanSelector);
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId: actorUserId,
      ...(isUlid ? { tenantId: cleanSelector } : { handle: cleanSelector.toLowerCase() }),
      surface: "app",
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: pluginErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: pluginErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  // Live server wall-clock entitlement check BEFORE any TenantStore DB reads
  const entitlement = await loadLiveTenantEntitlement(
    runtimeEnv.PLATFORM_DB,
    { tenantId: member.tenantId },
    { nowMs: options.nowMs },
  );
  if (!entitlement) {
    return {
      ok: false,
      response: pluginErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  const effectiveStatus = entitlement.evaluation.effectiveStatus;
  const storedStatus = entitlement.evaluation.storedStatus;
  if (effectiveStatus === "purged" || storedStatus === "purged") {
    return {
      ok: false,
      response: pluginErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  // Explicit `/plugins/**` lifecycle classification (never routed through generic domain/CMS
  // path heuristics so plugin subpaths like `/domains` or `/make-primary` never trigger
  // spurious `TRIAL_DOMAIN_FORBIDDEN` on trial tenants):
  const isMutation = STATE_CHANGING_METHODS.has(method);
  if (
    entitlement.evaluation.operatorHold ||
    effectiveStatus === "suspended" ||
    effectiveStatus === "recovery" ||
    effectiveStatus === "purging" ||
    storedStatus === "purging"
  ) {
    return {
      ok: false,
      response: pluginErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Akses plugin ditangguhkan hingga status situs dipulihkan.",
        requestId,
      ),
    };
  }

  if (effectiveStatus === "locked" && isMutation) {
    return {
      ok: false,
      response: pluginErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Langganan sedang terkunci (mode hanya-baca). Perpanjang langganan untuk mengubah plugin.",
        requestId,
      ),
    };
  }

  // RBAC role check (e.g. `editor` receives 403 FORBIDDEN on `settings:write`)
  if (!canPerform(member.role, requiredPermission)) {
    return {
      ok: false,
      response: pluginErrorResponse(
        403,
        "FORBIDDEN",
        "Peran akun Anda tidak memiliki izin untuk mengelola plugin.",
        requestId,
      ),
    };
  }

  const statusActionCheck = isActionAllowedForTenantStatus(effectiveStatus, requiredPermission);
  if (!statusActionCheck.allowed) {
    return {
      ok: false,
      response: pluginErrorResponse(
        statusActionCheck.status,
        statusActionCheck.code,
        "Status langganan saat ini tidak mengizinkan tindakan ini.",
        requestId,
      ),
    };
  }

  const tenant: PluginTenantSnapshot = {
    id: member.tenantId,
    handle: member.handle,
    name: member.tenantName,
    status: effectiveStatus,
  };

  const runtimeDeps: PluginRuntimeDeps = {
    platformDb: runtimeEnv.PLATFORM_DB,
    tenantStore: runtimeEnv.TENANT_STORE,
    resolveTenantStub: options.resolveTenantStub,
    resolveTenantDb: options.resolveTenantDb,
    registry: options.registry,
    nowMs: options.nowMs,
    getBookmark: options.getBookmark,
    scopedDbOptions: options.scopedDbOptions,
  };

  return {
    ok: true,
    ctx: {
      requestId,
      member: { ...member, tenantStatus: effectiveStatus },
      tenant,
      runtimeDeps,
    },
  };
}

export function mapPluginDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof PluginRuntimeError) {
    return pluginErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PluginSqlViolationError) {
    return pluginErrorResponse(400, "BAD_REQUEST", err.message, requestId);
  }
  if (err instanceof PluginRepositoryError) {
    if (err.code === "BUILTIN_PLUGIN_FORBIDDEN" || err.code === "NOT_FOUND") {
      return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
    }
    return pluginErrorResponse(400, "BAD_REQUEST", err.message, requestId);
  }
  if (err instanceof PluginMigrationError) {
    if (err.code === "BUILTIN_PLUGIN_FORBIDDEN") {
      return pluginErrorResponse(404, "NOT_FOUND", "Plugin tidak ditemukan.", requestId);
    }
    if (err.code === "TENANT_UNAVAILABLE") {
      return pluginErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId);
    }
    return pluginErrorResponse(500, "SERVICE_UNAVAILABLE", err.message, requestId);
  }
  return pluginErrorResponse(
    500,
    "SERVICE_UNAVAILABLE",
    "Terjadi kesalahan internal pada layanan plugin.",
    requestId,
  );
}
