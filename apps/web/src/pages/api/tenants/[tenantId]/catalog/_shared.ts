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
import { CatalogValidationError } from "@punyasitus/core/catalog/index";
import {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import { SlugValidationError } from "@punyasitus/core/slug/index";
import { CatalogConflictError, CatalogNotFoundError } from "@punyasitus/db/catalog/index";
import {
  TrashConflictError,
  TrashNotFoundError,
  TrashProtectedReferenceError,
  TrashValidationError,
} from "@punyasitus/db/trash/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, host-isolation, CSRF, Better Auth session, RBAC/lifecycle,
 * strict JSON parsing, and error-envelope helpers for `/api/tenants/:tenantId/catalog/**`
 * (TASK-009; REQ-012, REQ-013, REQ-016, REQ-034, REQ-061).
 */

export const MAX_CATALOG_BODY_BYTES = 262_144 as const; // 256 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d{0,9}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export const NO_STORE_EMPTY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantCatalogRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantCatalogHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedCatalogRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function buildCatalogRuntimeEnv(): TenantCatalogRuntimeEnv {
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

export function catalogJsonResponse(
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

export function catalogNoContentResponse(): Response {
  return new Response(null, { status: 204, headers: new Headers(NO_STORE_EMPTY_HEADERS) });
}

export function catalogErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return catalogJsonResponse(
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

export function parseSequentialPathId(rawId: string): number | null {
  const trimmed = rawId.trim();
  if (!POSITIVE_INT_PATTERN.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 1 || num > 2_147_483_647) return null;
  return num;
}

/**
 * Enforces:
 * 1. Platform `app` host surface check (neutral `404` on tenant/marketing/console hosts).
 * 2. CSRF & Origin enforcement on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership, RBAC, and tenant lifecycle lock (`404` / `403`).
 * 5. Opens the verified tenant's physically isolated `TenantStore` via `member.tenantId` only.
 */
export async function authorizeTenantCatalogRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantCatalogRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantCatalogHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedCatalogRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();

  // 1. Host isolation — tenant admin APIs exist ONLY on `app.punyasitus.com` (or local loopback).
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: catalogErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement for state-changing admin methods.
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: catalogErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB.
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: catalogErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve authenticated session user + enforce session lifetime ceiling.
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: catalogErrorResponse(
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
      response: catalogErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses katalog tenant.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle status check against PLATFORM_DB.
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: catalogErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: catalogErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: catalogErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 6. Open the verified tenant's own physically isolated TenantStore.
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: catalogErrorResponse(
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

export type ParsedCatalogJsonBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

/**
 * Strictly parses a JSON request object with:
 * - Hard byte cap (`MAX_CATALOG_BODY_BYTES`) -> `413 PAYLOAD_TOO_LARGE`
 * - Content-Type check when body is present -> `415 UNSUPPORTED_MEDIA_TYPE`
 * - Malformed JSON -> `400 BAD_REQUEST`
 * - Non-object payload -> `422 VALIDATION_ERROR`
 * - Forbidden tenant selector keys -> `422 VALIDATION_ERROR` (`FORBIDDEN_TENANT_SELECTOR`)
 * - Unknown top-level keys -> `422 VALIDATION_ERROR` (`UNKNOWN_FIELD`)
 */
export async function parseStrictCatalogJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedCatalogJsonBody> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_CATALOG_BODY_BYTES) {
    return {
      ok: false,
      response: catalogErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_CATALOG_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    if (options.allowEmptyBody) {
      return { ok: true, body: {} };
    }
    return {
      ok: false,
      response: catalogErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    return {
      ok: false,
      response: catalogErrorResponse(
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
      response: catalogErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: catalogErrorResponse(
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
        response: catalogErrorResponse(
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
        response: catalogErrorResponse(
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

export function extractCatalogExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
  options: { readonly required: boolean },
):
  | { readonly ok: true; readonly expectedVersion: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus sama jika keduanya diisi.",
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
    if (options.required) {
      return {
        ok: false,
        response: catalogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "version atau expectedVersion wajib diisi untuk pembaruan.",
          requestId,
          [
            {
              field: "version",
              code: "INVALID_VERSION",
              message: "Optimistic concurrency version is required.",
            },
          ],
        ),
      };
    }
    return { ok: true, expectedVersion: undefined };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: catalogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa integer positif.",
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

export function mapCatalogDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof TrashProtectedReferenceError) {
    return catalogJsonResponse(409, {
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
        protectedReferences: err.references,
      },
      requestId,
    });
  }
  if (err instanceof TrashConflictError) {
    return catalogJsonResponse(409, {
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
        ...(err.suggestedSlug ? { suggestedSlug: err.suggestedSlug } : {}),
        ...(err.conflictKind ? { conflictKind: err.conflictKind } : {}),
      },
      requestId,
    });
  }
  if (err instanceof TrashValidationError) {
    return catalogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof TrashNotFoundError) {
    return catalogErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof SlugValidationError) {
    return catalogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof CatalogValidationError) {
    return catalogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof PublicationValidationError) {
    return catalogErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof CatalogNotFoundError || err instanceof PublicationNotFoundError) {
    return catalogErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof StaleRevisionError) {
    return catalogErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "version",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof CatalogConflictError) {
    return catalogErrorResponse(409, err.code, err.message, requestId, [
      {
        field: err.field,
        code: err.fieldCode,
        message: err.message,
      },
    ]);
  }
  if (err instanceof AuthorizationError) {
    return catalogErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return catalogErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyelesaikan sinkronisasi publikasi katalog.",
      requestId,
      undefined,
      { "Retry-After": "10" },
    );
  }
  return catalogErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi katalog tenant.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
