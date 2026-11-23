import { env } from "cloudflare:workers";
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
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { readBoundedRequestBody } from "@punyasitus/core/plugins/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import {
  SeoConflictError,
  SeoNotFoundError,
  SeoPluginDisabledError,
  SeoServiceUnavailableError,
  SeoValidationError,
  type SeoValidationFieldError,
} from "@punyasitus/db/seo/index";
import { bindTenantDatabase } from "../../../../../core/tenant.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared auth, host-isolation, CSRF/Origin, RBAC, lifecycle, and strict DTO guards for
 * `/api/tenants/:tenantId/seo/**` (TASK-052, REQ-053, REQ-055, REQ-034, REQ-060).
 */

export const MAX_SEO_API_BODY_BYTES = 65_536 as const;
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

export const SEO_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantSeoRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly SAAS_ZONE?: string;
}

export interface TenantSeoHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly saasZone?: string;
}

export interface AuthorizedSeoApiContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly saasZone?: string;
}

export type AuthorizeSeoApiResult =
  | { readonly ok: true; readonly ctx: AuthorizedSeoApiContext }
  | { readonly ok: false; readonly response: Response };

export function createSeoRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function seoJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SEO_NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

export function seoErrorResponse(
  status: number,
  code: ApiErrorCode | string,
  message: string,
  requestId: string,
  fields?: readonly SeoValidationFieldError[],
  extraHeaders?: Record<string, string>,
): Response {
  return seoJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      requestId,
    },
    extraHeaders,
  );
}

export async function parseStrictSeoJsonBody(
  request: Request,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return {
      ok: false,
      response: seoErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
        requestId,
      ),
    };
  }

  const bounded = await readBoundedRequestBody(request, MAX_SEO_API_BODY_BYTES);
  if (!bounded.ok) {
    if (bounded.reason === "too_large") {
      return {
        ok: false,
        response: seoErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          "Ukuran body permintaan melebihi batas maksimal 64 KiB.",
          requestId,
        ),
      };
    }
    return {
      ok: false,
      response: seoErrorResponse(400, "BAD_REQUEST", "Body permintaan tidak dapat dibaca.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return {
      ok: false,
      response: seoErrorResponse(400, "BAD_REQUEST", "Body JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body JSON harus berupa objek.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_SELECTOR_KEYS.has(key)) {
      return {
        ok: false,
        response: seoErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan pada body permintaan.`,
          requestId,
          [{ field: key, code: "FORBIDDEN_FIELD", message: `Field "${key}" tidak diizinkan.` }],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export function extractRequiredExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const hasV = Object.prototype.hasOwnProperty.call(body, "version");
  const hasEv = Object.prototype.hasOwnProperty.call(body, "expectedVersion");

  if (!hasV && !hasEv) {
    return {
      ok: false,
      response: seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version atau expectedVersion wajib diisi untuk mencegah penimpaan data.",
        requestId,
        [{ field: "version", code: "REQUIRED", message: "Optimistic concurrency version wajib diisi." }],
      ),
    };
  }

  const v = hasV ? body.version : undefined;
  const ev = hasEv ? body.expectedVersion : undefined;

  if (v !== undefined && ev !== undefined && v !== ev) {
    return {
      ok: false,
      response: seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus bernilai sama jika keduanya dikirim.",
        requestId,
        [{ field: "version", code: "MISMATCH", message: "version and expectedVersion must match." }],
      ),
    };
  }

  const chosen = ev ?? v;
  if (
    typeof chosen !== "number" ||
    !Number.isSafeInteger(chosen) ||
    chosen < 1 ||
    chosen > 2_147_483_647
  ) {
    return {
      ok: false,
      response: seoErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa bilangan bulat positif.",
        requestId,
        [{ field: "version", code: "INVALID_VERSION", message: "version harus berupa integer positif." }],
      ),
    };
  }

  return { ok: true, expectedVersion: chosen };
}

export async function authorizeTenantSeoRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantSeoRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantSeoHandlerOptions = {},
): Promise<AuthorizeSeoApiResult> {
  const requestId = options.requestId ?? createSeoRequestId();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: seoErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: seoErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: seoErrorResponse(
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
        response: seoErrorResponse(
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
      response: seoErrorResponse(
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
      response: seoErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  let member: AuthorizedTenantMember;
  try {
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
        response: seoErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: seoErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  // Authoritative server-clock entitlement check BEFORE any TenantStore DB reads
  const entitlement = await loadLiveTenantEntitlement(
    runtimeEnv.PLATFORM_DB,
    { tenantId: member.tenantId },
    { nowMs: options.nowMs },
  );
  if (!entitlement) {
    return {
      ok: false,
      response: seoErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  const effectiveStatus = entitlement.evaluation.effectiveStatus;
  const storedStatus = entitlement.evaluation.storedStatus;
  if (effectiveStatus === "purged" || storedStatus === "purged") {
    return {
      ok: false,
      response: seoErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

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
      response: seoErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Akses SEO ditangguhkan hingga status situs dipulihkan.",
        requestId,
      ),
    };
  }

  if (effectiveStatus === "locked" && isMutation) {
    return {
      ok: false,
      response: seoErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Langganan sedang terkunci (mode hanya-baca). Perpanjang langganan untuk mengubah pengaturan SEO.",
        requestId,
      ),
    };
  }

  if (!canPerform(member.role, requiredPermission)) {
    return {
      ok: false,
      response: seoErrorResponse(
        403,
        "FORBIDDEN",
        "Peran akun Anda tidak memiliki izin untuk tindakan SEO ini.",
        requestId,
      ),
    };
  }

  const statusActionCheck = isActionAllowedForTenantStatus(effectiveStatus, requiredPermission);
  if (!statusActionCheck.allowed) {
    return {
      ok: false,
      response: seoErrorResponse(
        statusActionCheck.status,
        statusActionCheck.code,
        "Status langganan saat ini tidak mengizinkan tindakan ini.",
        requestId,
      ),
    };
  }

  const tenantDb = options.resolveTenantDb
    ? options.resolveTenantDb(member.tenantId)
    : runtimeEnv.TENANT_STORE
      ? bindTenantDatabase(runtimeEnv.TENANT_STORE, member.tenantId)
      : null;

  if (!tenantDb) {
    return {
      ok: false,
      response: seoErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data situs sementara tidak tersedia.",
        requestId,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member: { ...member, tenantStatus: effectiveStatus },
      platformDb: runtimeEnv.PLATFORM_DB,
      tenantDb,
      saasZone: options.saasZone ?? runtimeEnv.SAAS_ZONE,
    },
  };
}

export function mapSeoDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof SeoValidationError) {
    return seoErrorResponse(422, err.code, err.message, requestId, err.fields);
  }
  if (err instanceof SeoPluginDisabledError) {
    return seoErrorResponse(409, err.code, err.message, requestId);
  }
  if (err instanceof SeoConflictError) {
    return seoJsonResponse(409, {
      error: {
        code: err.code,
        message: err.message,
        currentVersion: err.currentVersion,
      },
      requestId,
    });
  }
  if (err instanceof SeoNotFoundError) {
    return seoErrorResponse(404, err.code, err.message, requestId);
  }
  if (err instanceof SeoServiceUnavailableError) {
    return seoErrorResponse(503, err.code, err.message, requestId);
  }
  return seoErrorResponse(
    500,
    "SERVICE_UNAVAILABLE",
    "Terjadi kesalahan internal saat memproses pengaturan SEO.",
    requestId,
  );
}

export function buildSeoRuntimeEnv(): TenantSeoRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly SAAS_ZONE?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
  };
}
