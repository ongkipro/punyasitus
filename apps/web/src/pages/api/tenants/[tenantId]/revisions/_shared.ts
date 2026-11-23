import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  RevisionConflictError,
  RevisionNotFoundError,
  RevisionSchemaUnsupportedError,
  RevisionValidationError,
} from "@punyasitus/db/revisions/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, RBAC, host-isolation, CSRF, JSON parsing, and error-envelope helpers
 * for `/api/tenants/:tenantId/revisions/**` (TASK-064; REQ-048, REQ-034, REQ-036).
 */

export const MAX_REVISION_BODY_BYTES = 16_384 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantRevisionsRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantRevisionsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedRevisionRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createRevisionRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function revisionJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function revisionErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return revisionJsonResponse(
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

export function buildRevisionsRuntimeEnv(): TenantRevisionsRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

/**
 * Enforces:
 * 1. Platform `app` host surface check (`404` on tenant/marketing/console hosts).
 * 2. Admin CSRF & Origin check on state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE` -> `403`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership, RBAC (`content:read` / `content:write`), and tenant
 *    lifecycle lock (`locked`/`suspended` -> `403 SUBSCRIPTION_LOCKED`, cross-tenant -> `404`).
 * 5. Opens the verified tenant's own physically isolated `TenantStore` via `member.tenantId` only.
 */
export async function authorizeTenantRevisionRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantRevisionsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantRevisionsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedRevisionRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRevisionRequestId();

  // 1. Host surface check
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: revisionErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement for state-changing requests
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: revisionErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: revisionErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve authenticated session user
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: revisionErrorResponse(
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
      response: revisionErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses riwayat revisi.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle check against PLATFORM_DB
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: revisionErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: revisionErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: revisionErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 6. Open verified tenant's physically isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: revisionErrorResponse(
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
    ctx: { requestId, member, platformDb: runtimeEnv.PLATFORM_DB, tenantDb },
  };
}

export async function parseStrictRevisionJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null && /^\d+$/.test(rawContentLength.trim())) {
    const declaredLength = Number(rawContentLength.trim());
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REVISION_BODY_BYTES) {
      return {
        ok: false,
        response: revisionErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          `Ukuran payload melebihi batas maksimum ${MAX_REVISION_BODY_BYTES} byte.`,
          requestId,
        ),
      };
    }
  }

  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_REVISION_BODY_BYTES) {
    return {
      ok: false,
      response: revisionErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_REVISION_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    return {
      ok: false,
      response: revisionErrorResponse(
        400,
        "BAD_REQUEST",
        "Body JSON wajib dikirim bersama expectedVersion.",
        requestId,
      ),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: revisionErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
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
      response: revisionErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return {
        ok: false,
        response: revisionErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan tenant.`,
          requestId,
          [
            {
              field: key,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Tenant selector field "${key}" is forbidden in request body.`,
            },
          ],
        ),
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: revisionErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [{ field: key, code: "UNKNOWN_FIELD", message: `Unknown field "${key}" is not allowed.` }],
        ),
      };
    }
  }

  try {
    assertNoForbiddenTenantSelectors(record);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      return {
        ok: false,
        response: revisionErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields),
      };
    }
    throw err;
  }

  return { ok: true, body: record };
}

export function extractRevisionExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus bernilai sama jika keduanya dikirim.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "INVALID_VERSION",
            message: "Conflicting version and expectedVersion values.",
          },
        ],
      ),
    };
  }

  const raw = hasExpectedVersion ? body.expectedVersion : body.version;
  if (raw === undefined) {
    return {
      ok: false,
      response: revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field expectedVersion wajib dikirim untuk kontrol konkurensi optimistik.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "REQUIRED",
            message: "Optimistic concurrency expectedVersion is required.",
          },
        ],
      ),
    };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: revisionErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion harus berupa bilangan bulat positif.",
        requestId,
        [
          {
            field: hasExpectedVersion ? "expectedVersion" : "version",
            code: "INVALID_VERSION",
            message: "Expected a positive integer version.",
          },
        ],
      ),
    };
  }

  return { ok: true, expectedVersion: raw };
}

export function mapRevisionDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof RevisionNotFoundError) {
    return revisionErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof StaleRevisionError) {
    return revisionErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof RevisionConflictError) {
    return revisionErrorResponse(
      409,
      err.code === "STALE_VERSION" ? "STALE_VERSION" : "CONFLICT",
      err.message,
      requestId,
      err.fields,
    );
  }
  if (err instanceof RevisionSchemaUnsupportedError) {
    return revisionErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof RevisionValidationError) {
    return revisionErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof AuthorizationError) {
    return revisionErrorResponse(err.status, err.code, err.message, requestId);
  }
  return revisionErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi riwayat revisi.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
