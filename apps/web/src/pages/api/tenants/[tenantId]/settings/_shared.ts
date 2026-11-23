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
  FORBIDDEN_SETTINGS_SECRET_KEYS,
  SettingsValidationError,
} from "@punyasitus/core/settings/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/db/settings/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, RBAC, host-isolation, strict JSON parsing, and error-envelope
 * helpers for `/api/tenants/:tenantId/settings/**` (`TASK-040`; `REQ-044`, `REQ-034`, `REQ-036`).
 */

export const MAX_SETTINGS_BODY_BYTES = 65_536 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const SETTINGS_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantSettingsRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantSettingsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedSettingsRequestContext {
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

export function settingsJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(SETTINGS_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function settingsErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return settingsJsonResponse(
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

export function buildSettingsRuntimeEnv(): TenantSettingsRuntimeEnv {
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
 * Authorizes a `/api/tenants/:tenantId/settings/**` request BEFORE opening `TenantStore`:
 * 1. App-host surface isolation (`404` on tenant/marketing/console hosts).
 * 2. Admin CSRF & Origin enforcement on state-changing requests (`PATCH`/`POST`/`PUT`/`DELETE`).
 * 3. Better Auth session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC (`settings:read`/`settings:write`/`settings:publish`)
 *    + tenant lifecycle gate (`locked` -> `403 SUBSCRIPTION_LOCKED` on mutations;
 *    `suspended`/`recovery`/`purging` -> `403 SUBSCRIPTION_LOCKED`; `purged`/cross-tenant -> `404`).
 * 5. Opens verified tenant's isolated `TenantStore` using `member.tenantId` only.
 */
export async function authorizeTenantSettingsRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantSettingsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantSettingsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedSettingsRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: settingsErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: settingsErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: settingsErrorResponse(
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
        response: settingsErrorResponse(
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
      response: settingsErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses pengaturan situs.",
        requestId,
      ),
    };
  }

  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: settingsErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: settingsErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: settingsErrorResponse(
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
      response: settingsErrorResponse(
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

function findNestedForbiddenKey(
  value: unknown,
  pathPrefix = "",
): { readonly path: string; readonly kind: "tenant_selector" | "secret_field" } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return { path: nextPath, kind: "tenant_selector" };
    }
    if (FORBIDDEN_SETTINGS_SECRET_KEYS.has(key)) {
      return { path: nextPath, kind: "secret_field" };
    }
    const hit = findNestedForbiddenKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictSettingsJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_SETTINGS_BODY_BYTES) {
    return {
      ok: false,
      response: settingsErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_SETTINGS_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return {
      ok: false,
      response: settingsErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: settingsErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: settingsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbidden = findNestedForbiddenKey(record);
  if (forbidden) {
    return {
      ok: false,
      response: settingsErrorResponse(
        422,
        "VALIDATION_ERROR",
        forbidden.kind === "tenant_selector"
          ? `Field "${forbidden.path}" tidak diizinkan dalam body permintaan tenant.`
          : `Field rahasia "${forbidden.path}" tidak diizinkan dalam pengaturan tenant.`,
        requestId,
        [
          {
            field: forbidden.path,
            code:
              forbidden.kind === "tenant_selector"
                ? "FORBIDDEN_TENANT_SELECTOR"
                : "FORBIDDEN_SECRET_FIELD",
            message: `Field "${forbidden.path}" is forbidden.`,
          },
        ],
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: settingsErrorResponse(
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

export function extractRequiredSettingsVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (!hasVersion && !hasExpectedVersion) {
    return {
      ok: false,
      response: settingsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field expectedVersion (atau version) wajib disertakan untuk mencegah penimpaan data.",
        requestId,
        [
          {
            field: "expectedVersion",
            code: "REQUIRED",
            message: "expectedVersion or version is required.",
          },
        ],
      ),
    };
  }

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: settingsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus sama jika keduanya dikirim.",
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
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: settingsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "expectedVersion wajib berupa bilangan bulat non-negatif.",
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

export function mapSettingsDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof SettingsValidationError || err instanceof PublicationValidationError) {
    return settingsErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof StaleRevisionError) {
    return settingsErrorResponse(409, "STALE_VERSION", err.message, requestId, [
      {
        field: "expectedVersion",
        code: "STALE_VERSION",
        message: err.message,
      },
    ]);
  }
  if (err instanceof PublicationNotFoundError) {
    return settingsErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return settingsErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return settingsErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyelesaikan publikasi pengaturan secara atomik.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }
  return settingsErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses permintaan pengaturan situs.",
    requestId,
    undefined,
    { "Retry-After": "60" },
  );
}
