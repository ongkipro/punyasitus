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
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  FormHasLeadsError,
  FormLimitExceededError,
  FormNotFoundError,
  FormPublishComplianceError,
  FormSlugConflictError,
  FormStaleVersionError,
  FormStorageError,
  FormValidationError,
} from "@punyasitus/db/forms/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared auth, RBAC, host-isolation, CSRF, JSON parsing, and error-mapping helpers for
 * `/api/tenants/:tenantId/forms/**` (REQ-080, PLAN §19.2, TASK-080).
 *
 * RBAC Matrix:
 * - Read (`GET`): `settings:read` (Owner, Admin, Agency Admin; allowed read-only while `locked`; denied to Editor & `suspended`).
 * - Write (`POST` create, `PUT`/`PATCH` update, `DELETE`): `settings:write` (Owner, Admin, Agency Admin; denied to Editor & `locked`/`suspended`).
 * - Publish/Unpublish (`POST /publish`): `settings:publish` (Owner, Admin, Agency Admin; denied to Editor & `locked`/`suspended`).
 */

export const MAX_FORM_ADMIN_BODY_BYTES = 32_768 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HANDLE_SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_TENANT_SELECTOR_KEYS.map((k) => k.toLowerCase()),
);

export const PRIVATE_NO_STORE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  Vary: "Cookie",
} as const;

export interface TenantFormsRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantFormsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedFormRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createFormRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function formJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_NO_STORE_JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function formErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return formJsonResponse(
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

export function buildFormsRuntimeEnv(): TenantFormsRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly SAAS_ZONE?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export async function authorizeTenantFormRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantFormsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantFormsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedFormRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createFormRequestId();

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: formErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: formErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: formErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: formErrorResponse(
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
      response: formErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengelola formulir tenant.",
        requestId,
      ),
    };
  }

  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: formErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isHandleSelector = HANDLE_SELECTOR_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isHandleSelector ? { handle: trimmedSelector } : { tenantId: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: formErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: formErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: formErrorResponse(
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

export function parseFormIdParam(
  rawFormId: string,
  requestId: string,
): { readonly ok: true; readonly formId: number } | { readonly ok: false; readonly response: Response } {
  const trimmed = rawFormId.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    return {
      ok: false,
      response: formErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID formulir harus berupa bilangan bulat positif.",
        requestId,
        [{ field: "formId", code: "INVALID_FORM_ID", message: "Expected positive integer form ID." }],
      ),
    };
  }
  const formId = Number(trimmed);
  if (!Number.isSafeInteger(formId) || formId < 1 || formId > 2_147_483_647) {
    return {
      ok: false,
      response: formErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID formulir di luar rentang yang diizinkan.",
        requestId,
        [{ field: "formId", code: "INVALID_FORM_ID", message: "Form ID out of range." }],
      ),
    };
  }
  return { ok: true, formId };
}

export async function parseStrictFormJsonBody(
  request: Request,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_FORM_ADMIN_BODY_BYTES) {
    return {
      ok: false,
      response: formErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_FORM_ADMIN_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return {
      ok: false,
      response: formErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: formErrorResponse(
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
      response: formErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: formErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key.toLowerCase())) {
      return {
        ok: false,
        response: formErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan tenant.`,
          requestId,
          [
            {
              field: key,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Tenant selector "${key}" is forbidden.`,
            },
          ],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export function mapFormDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof FormValidationError || err instanceof FormPublishComplianceError) {
    return formErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof FormLimitExceededError) {
    return formErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, [
      { field: "forms", code: "FORM_LIMIT_EXCEEDED", message: err.message },
    ]);
  }
  if (err instanceof FormNotFoundError) {
    return formErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof FormSlugConflictError) {
    return formErrorResponse(409, "CONFLICT", err.message, requestId, [
      { field: "slug", code: "SLUG_CONFLICT", message: err.message },
    ]);
  }
  if (err instanceof FormStaleVersionError) {
    return formErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: `Current version is ${err.currentVersion}.`,
      },
    ]);
  }
  if (err instanceof FormHasLeadsError) {
    return formErrorResponse(409, "CONFLICT", err.message, requestId);
  }
  if (err instanceof FormStorageError) {
    return formErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId, undefined, {
      "Retry-After": "60",
    });
  }
  return formErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Terjadi kesalahan saat memproses permintaan formulir.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
