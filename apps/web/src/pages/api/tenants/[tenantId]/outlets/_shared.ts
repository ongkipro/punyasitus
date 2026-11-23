import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import type { EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  OutletDuplicateSlugError,
  OutletLimitReachedError,
  OutletNotFoundError,
  OutletStaleVersionError,
  OutletValidationError,
} from "@punyasitus/db/outlets/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, RBAC, host-isolation, strict JSON parsing, and error-envelope
 * helpers for `/api/tenants/:tenantId/outlets/**` (REQ-029, REQ-034, REQ-036; TASK-019).
 */

export const MAX_OUTLET_BODY_BYTES = 32_768 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const POSITIVE_INT_PATTERN = /^[1-9][0-9]{0,9}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const OUTLETS_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantOutletsRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantOutletsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  /**
   * Trusted server-side verified user from Astro middleware (`locals.authUser`) ONLY.
   * NEVER populate from client request headers/body.
   */
  readonly authenticatedUser?: { readonly id: string } | null;
  /** Trusted server-side verified session ID (`locals.authSession?.id`) for lifetime ceiling recheck. */
  readonly authenticatedSessionId?: string | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedOutletsRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createOutletRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function outletsJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(OUTLETS_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function outletsErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return outletsJsonResponse(
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

export function parseOutletIdParam(rawOutletId: string | undefined): number | null {
  if (!rawOutletId) return null;
  const trimmed = rawOutletId.trim();
  if (!POSITIVE_INT_PATTERN.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 1 || num > 2_147_483_647) return null;
  return num;
}

/**
 * Enforces:
 * 1. Platform `app` host surface isolation (neutral `404` on tenant/marketing/console hosts).
 * 2. Admin CSRF & Origin check (`403`) on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership (cross-tenant -> neutral `404`), RBAC (`content:read` for GET,
 *    `outlet:manage` for writes so Owner/Admin/Agency Admin succeed and Editor gets `403 FORBIDDEN`),
 *    and locked/suspended tenant checks (`locked` -> GET `200`, writes `403 SUBSCRIPTION_LOCKED`;
 *    `suspended` -> all `403 SUBSCRIPTION_LOCKED`).
 * 5. Opens the verified tenant's physically isolated `TenantStore` using `member.tenantId` only.
 */
export async function authorizeTenantOutletsRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantOutletsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantOutletsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedOutletsRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createOutletRequestId();

  // 1. Platform host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: outletsErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement for state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: outletsErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: outletsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve authenticated Better Auth session user + session lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (userId && options.authenticatedSessionId) {
    // Defense-in-depth: recheck session lifetime ceiling even when hydrated via middleware locals
    try {
      const pathname = new URL(request.url).pathname.toLowerCase();
      const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
        sessionId: options.authenticatedSessionId,
        userId,
        surface: "app",
        pathname,
        nowMs: options.nowMs,
      });
      if (!lifetime.valid) {
        userId = null;
      }
    } catch {
      userId = null;
    }
  } else if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: outletsErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          undefined,
          { "Retry-After": "60" },
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
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionResult.session.id,
          userId: sessionResult.user.id,
          surface: "app",
          pathname,
          nowMs: options.nowMs,
        });
        if (lifetime.valid) {
          userId = sessionResult.user.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: outletsErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses data gerai.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle check against PLATFORM_DB
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: outletsErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: outletsErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: outletsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 6. Open verified tenant's isolated TenantStore using member.tenantId only
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: outletsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      tenantDb,
    },
  };
}

function findNestedForbiddenTenantKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenTenantKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) return nextPath;
    const hit = findNestedForbiddenTenantKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export type ParsedOutletsJsonResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

export async function parseStrictOutletsJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedOutletsJsonResult> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_OUTLET_BODY_BYTES) {
    return {
      ok: false,
      response: outletsErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_OUTLET_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    if (options.allowEmptyBody) return { ok: true, body: {} };
    return {
      ok: false,
      response: outletsErrorResponse(
        400,
        "BAD_REQUEST",
        "Body JSON tidak boleh kosong.",
        requestId,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: outletsErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: outletsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_OUTLET_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenTenantKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: outletsErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenPath}" tidak diizinkan dalam body permintaan tenant.`,
        requestId,
        [
          {
            field: forbiddenPath,
            code: "FORBIDDEN_TENANT_SELECTOR",
            message: `Tenant selector field "${forbiddenPath}" is forbidden in request body.`,
          },
        ],
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: outletsErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [
            {
              field: key,
              code: "UNKNOWN_FIELD",
              message: `Unknown field "${key}" is not allowed.`,
            },
          ],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export function mapOutletsDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof OutletDuplicateSlugError) {
    return outletsErrorResponse(409, "CONFLICT", err.message, requestId, err.fields);
  }
  if (err instanceof OutletLimitReachedError || err instanceof OutletValidationError) {
    return outletsErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof OutletStaleVersionError) {
    return outletsErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof OutletNotFoundError) {
    return outletsErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return outletsErrorResponse(err.status, err.code, err.message, requestId);
  }
  return outletsErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi daftar gerai.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
