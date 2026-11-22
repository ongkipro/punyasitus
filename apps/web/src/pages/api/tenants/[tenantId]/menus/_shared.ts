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
import { MenuValidationError } from "@punyasitus/core/menu-builder";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { MenuConflictError, type StoredTenantMenu } from "@punyasitus/db/menus/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, host-isolation, JSON parsing, and error-envelope helpers
 * for `/api/tenants/:tenantId/menus/**` (TASK-004; REQ-006, REQ-007, REQ-034).
 */

export const MAX_MENU_BODY_BYTES = 131_072 as const; // 128 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantMenusRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantMenusHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  /** Optional pre-resolved authenticated user (e.g. from Astro middleware `locals.authUser`). */
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  /** Optional hook to supply a TenantStore D1Database handle directly in tests. */
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedMenuRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly tenantDb: D1Database;
}

export function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function menuJsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function menuErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return menuJsonResponse(
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

export function formatMenuRecordResponse(menu: StoredTenantMenu): Record<string, unknown> {
  return {
    location: menu.location,
    items: menu.items,
    flatItems: menu.flatItems,
    version: menu.version,
    updatedAt: menu.updatedAt,
  };
}

/**
 * Enforces:
 * 1. Platform `app` host surface check (never exposed on public tenant/marketing/console hosts -> neutral `404`).
 * 2. Admin CSRF & Origin check on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership, RBAC (`content:read` / `menu:manage`), and lifecycle lock (`404` / `403`).
 * 5. Opens the authorized tenant's physically isolated `TenantStore` using `member.tenantId` only.
 */
export async function authorizeTenantMenuRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantMenusRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantMenusHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedMenuRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();

  // 1. Platform host check — tenant admin APIs live ONLY on `app.punyasitus.com` (or local loopback).
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: menuErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement for state-changing admin methods.
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: menuErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB.
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: menuErrorResponse(
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
        response: menuErrorResponse(
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
      response: menuErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses menu tenant.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant lifecycle status check against PLATFORM_DB.
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: menuErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: menuErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: menuErrorResponse(
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
      response: menuErrorResponse(
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
    ctx: { requestId, member, tenantDb },
  };
}

export type ParsedJsonBodyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

/**
 * Strictly reads and parses a JSON request object with:
 * - Hard byte cap (`MAX_MENU_BODY_BYTES`)
 * - Malformed JSON -> `400 BAD_REQUEST`
 * - Non-object payload -> `422 VALIDATION_ERROR`
 * - Forbidden tenant selector keys -> `422 VALIDATION_ERROR` (`MENU_CROSS_TENANT_REFERENCE`)
 * - Unknown top-level keys -> `422 VALIDATION_ERROR` (`UNKNOWN_FIELD`)
 */
export async function parseStrictMenuJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<ParsedJsonBodyResult> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_MENU_BODY_BYTES) {
    return {
      ok: false,
      response: menuErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_MENU_BODY_BYTES} byte.`,
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
      response: menuErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: menuErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: menuErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_MENU_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return {
        ok: false,
        response: menuErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan tenant.`,
          requestId,
          [
            {
              field: key,
              code: "MENU_CROSS_TENANT_REFERENCE",
              message: `Tenant selector field "${key}" is forbidden in request body.`,
            },
          ],
        ),
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: menuErrorResponse(
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

export function extractExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
): { readonly ok: true; readonly expectedVersion: number | undefined } | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: menuErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version and expectedVersion must match when both are provided.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "INVALID_MENU_PAYLOAD",
            message: "Conflicting version and expectedVersion values.",
          },
        ],
      ),
    };
  }

  const raw = hasExpectedVersion ? body.expectedVersion : body.version;
  if (raw === undefined) {
    return { ok: true, expectedVersion: undefined };
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: menuErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version must be a non-negative integer.",
        requestId,
        [
          {
            field: hasExpectedVersion ? "expectedVersion" : "version",
            code: "INVALID_MENU_PAYLOAD",
            message: "Expected a non-negative integer version.",
          },
        ],
      ),
    };
  }

  return { ok: true, expectedVersion: raw };
}

export function mapMenuDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof MenuValidationError) {
    return menuErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof MenuConflictError) {
    return menuErrorResponse(409, "CONFLICT", err.message, requestId, [
      {
        field: "version",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof AuthorizationError) {
    return menuErrorResponse(err.status, err.code, err.message, requestId);
  }
  return menuErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi menu navigasi.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
