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
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import { SlugValidationError } from "@punyasitus/core/slug/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { PageRecord } from "@punyasitus/db/pages/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, RBAC, host-isolation, JSON parsing, and error-envelope helpers
 * for `/api/tenants/:tenantId/pages/**` (TASK-005; REQ-008, REQ-034, REQ-036, REQ-061).
 */

export const MAX_PAGE_BODY_BYTES = 262_144 as const; // 256 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantPagesRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantPagesHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  /** Optional pre-resolved authenticated user (e.g. from Astro middleware `locals.authUser`). */
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  /** Optional hook to supply a TenantStore D1Database handle directly in tests. */
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedPageRequestContext {
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

export function pageJsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function pageNoContentResponse(extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(null, { status: 204, headers });
}

export function pageErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return pageJsonResponse(
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

export function formatPageRecordResponse(page: PageRecord): Record<string, unknown> {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    isHomepage: page.isHomepage,
    layoutMode: page.layoutMode,
    sections: page.sections,
    seo: page.seo,
    published: page.published,
    hasUnpublishedChanges: page.hasUnpublishedChanges,
    formerSlugs: page.formerSlugs,
    version: page.version,
    publishedAt: page.publishedAt,
    contentModifiedAt: page.contentModifiedAt,
    deletedAt: page.deletedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

export function buildPagesRuntimeEnv(): TenantPagesRuntimeEnv {
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
 * 2. Admin CSRF & Origin check on state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership, RBAC (`content:read` / `content:write` / `content:publish`),
 *    and tenant lifecycle lock (`locked`/`suspended` -> `403`, non-member -> `404`).
 * 5. Opens the verified tenant's physically isolated `TenantStore` using `member.tenantId` only.
 */
export async function authorizeTenantPageRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantPagesHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedPageRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();

  // 1. Platform host check — tenant admin APIs live ONLY on `app.punyasitus.com` (or local loopback).
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: pageErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement for state-changing admin methods.
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: pageErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB.
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: pageErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve authenticated session user.
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: pageErrorResponse(
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
      response: pageErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses halaman tenant.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle check against PLATFORM_DB.
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: pageErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: pageErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: pageErrorResponse(
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
      response: pageErrorResponse(
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

export function parsePageIdParam(
  rawPageId: string,
  requestId: string,
): { readonly ok: true; readonly pageId: number } | { readonly ok: false; readonly response: Response } {
  const trimmed = rawPageId.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    return {
      ok: false,
      response: pageErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID halaman harus berupa bilangan bulat positif.",
        requestId,
        [
          {
            field: "pageId",
            code: "INVALID_PAGE_ID",
            message: "Expected a positive sequential integer page ID.",
          },
        ],
      ),
    };
  }
  const pageId = Number(trimmed);
  if (!Number.isSafeInteger(pageId) || pageId < 1 || pageId > 2_147_483_647) {
    return {
      ok: false,
      response: pageErrorResponse(
        422,
        "VALIDATION_ERROR",
        "ID halaman di luar rentang yang diizinkan.",
        requestId,
        [
          {
            field: "pageId",
            code: "INVALID_PAGE_ID",
            message: "Page ID must be between 1 and 2147483647.",
          },
        ],
      ),
    };
  }
  return { ok: true, pageId };
}

export type ParsedPageJsonBodyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

/**
 * Strictly reads and parses a JSON request object with:
 * - Hard byte cap (`MAX_PAGE_BODY_BYTES`) -> `413 PAYLOAD_TOO_LARGE`
 * - Content-Type check when body is non-empty -> `415 UNSUPPORTED_MEDIA_TYPE`
 * - Malformed JSON -> `400 BAD_REQUEST`
 * - Non-object payload -> `422 VALIDATION_ERROR`
 * - Forbidden tenant selector keys (top-level or nested) -> `422 VALIDATION_ERROR` (`FORBIDDEN_TENANT_SELECTOR`)
 * - Unknown top-level keys -> `422 VALIDATION_ERROR` (`UNKNOWN_FIELD`)
 */
export async function parseStrictPageJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedPageJsonBodyResult> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_PAGE_BODY_BYTES) {
    return {
      ok: false,
      response: pageErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_PAGE_BODY_BYTES} byte.`,
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
      response: pageErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: pageErrorResponse(
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
      response: pageErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: pageErrorResponse(
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
        response: pageErrorResponse(
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
        response: pageErrorResponse(
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

  // Deep scan nested objects/arrays for forbidden cross-tenant selectors
  try {
    assertNoForbiddenTenantSelectors(record);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      return {
        ok: false,
        response: pageErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields),
      };
    }
    throw err;
  }

  return { ok: true, body: record };
}

export function extractPageExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
  options: { readonly required?: boolean } = {},
):
  | { readonly ok: true; readonly expectedVersion: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: pageErrorResponse(
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
    if (options.required) {
      return {
        ok: false,
        response: pageErrorResponse(
          422,
          "VALIDATION_ERROR",
          "Field version wajib dikirim untuk kontrol konkurensi optimistik.",
          requestId,
          [
            {
              field: "version",
              code: "REQUIRED",
              message: "Optimistic concurrency version is required.",
            },
          ],
        ),
      };
    }
    return { ok: true, expectedVersion: undefined };
  }

  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: pageErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa bilangan bulat non-negatif.",
        requestId,
        [
          {
            field: hasExpectedVersion ? "expectedVersion" : "version",
            code: "INVALID_VERSION",
            message: "Expected a non-negative integer version.",
          },
        ],
      ),
    };
  }

  return { ok: true, expectedVersion: raw };
}

export function mapPageDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof SlugValidationError) {
    return pageErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof PublicationValidationError) {
    return pageErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof StaleRevisionError) {
    return pageErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "version",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof PublicationNotFoundError) {
    return pageErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return pageErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyelesaikan operasi publikasi atomik halaman.",
      requestId,
      undefined,
      { "Retry-After": "5" },
    );
  }
  if (err instanceof AuthorizationError) {
    return pageErrorResponse(err.status, err.code, err.message, requestId);
  }
  return pageErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi halaman statis.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
