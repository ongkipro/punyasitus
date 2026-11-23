import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import {
  createLocalMailSink,
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import {
  ensurePlatformOperatorRolesSchema,
  PlatformAuditError,
  PlatformOperatorError,
  PlatformSettingsError,
} from "@punyasitus/db/platform";
import type { AuthSurface } from "../cookies.ts";
import { enforceSessionLifetimeCeiling } from "../google.ts";
import { createAuth } from "../index.ts";
import { assertAdminCsrfAndOrigin } from "../session-guard.ts";
import {
  PlatformGuardError,
  requireActivePlatformOperator,
  requireRecentSecondFactor,
  type PlatformSessionInput,
  type PlatformUserInput,
  type VerifiedPlatformOperatorContext,
  type VerifiedRecentSecondFactorContext,
} from "./guard.ts";
import { applySessionTwoFactorMigration } from "./two-factor.ts";

/**
 * Shared security, host-isolation, CSRF, live-session, operator-2FA, and strict-JSON
 * helpers for all `console.punyasitus.com` pages and `/api/console/**` endpoints
 * (REQ-051, REQ-034, REQ-039, REQ-042, REQ-068; PLAN §13; TASK-048).
 */

const LOCAL_DEV_APP_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";
const LOCAL_DEV_CONSOLE_SECRET = "local-dev-console-punyasitus-auth-secret-fedcba9876543210";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const MAX_CONSOLE_JSON_BODY_BYTES = 16_384 as const; // 16 KiB

export const CONSOLE_PRIVATE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * Bare neutral `404 Not Found` response returned whenever a console page or API route is
 * requested on a non-console host (`app.`, tenant hosts, marketing host). Never renders
 * console HTML or discloses console operational copy.
 */
export function consoleNeutralNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export interface ConsoleRuntimeEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly BACKUP_BUCKET?: {
    get(key: string): Promise<{
      readonly key?: string;
      readonly uploaded?: Date;
      text(): Promise<string>;
    } | null>;
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
      readonly objects: readonly { readonly key: string; readonly uploaded?: Date }[];
      readonly truncated: boolean;
      readonly cursor?: string;
    }>;
  } | null;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: CloudflareSendEmailBinding | null;
}

export interface ConsoleHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly reauthWindowMs?: number;
  /** Optional pre-resolved session/user (still verified live against PLATFORM_DB). */
  readonly session?: PlatformSessionInput | null;
  readonly user?: PlatformUserInput | null;
}

export interface ConsoleHostResolution {
  readonly allowed: true;
  readonly authSurface: AuthSurface;
  readonly baseURL: string;
  readonly expectedOrigin: string;
  readonly isLocalLoopback: boolean;
  readonly host: string;
}

export interface AuthorizedConsoleContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly platformDb: D1Database;
  readonly host: ConsoleHostResolution;
  readonly actor: VerifiedPlatformOperatorContext;
  readonly user: PlatformUserInput;
  readonly session: PlatformSessionInput;
}

export interface AuthorizedConsoleMutationContext extends AuthorizedConsoleContext {
  readonly actor: VerifiedRecentSecondFactorContext;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

export function createConsoleRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function consoleJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(CONSOLE_PRIVATE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function consoleErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Readonly<Record<string, unknown>>,
  extraHeaders?: HeadersInit,
): Response {
  return consoleJsonResponse(
    status,
    {
      success: false,
      code,
      message,
      error: {
        code,
        message,
        ...(extra?.fields ? { fields: extra.fields } : {}),
      },
      requestId,
      ...extra,
    },
    extraHeaders,
  );
}

/**
 * Strictly enforces `console.punyasitus.com` host isolation (or loopback in `APP_ENV === "local"`).
 * Tenant hosts, `app.punyasitus.com`, `punyasitus.com`, and unknown hosts ALWAYS fail with `null` -> 404.
 */
export function resolveConsoleHostContext(
  request: Request,
  env: ConsoleRuntimeEnv,
): ConsoleHostResolution | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (env.APP_ENV === "local" && isLoopbackHost(url.hostname)) {
    return {
      allowed: true,
      authSurface: "app",
      baseURL: url.origin,
      expectedOrigin: url.origin,
      isLocalLoopback: true,
      host: url.host,
    };
  }

  const normalizedHost = normalizeHost(url.hostname);
  if (!normalizedHost) return null;

  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const consoleHost = `console.${platformDomain}`;
  if (normalizedHost !== consoleHost) {
    return null;
  }

  const origin = `https://${consoleHost}`;
  return {
    allowed: true,
    authSurface: "console",
    baseURL: origin,
    expectedOrigin: origin,
    isLocalLoopback: false,
    host: consoleHost,
  };
}

function resolveConsoleAuthSecret(surface: AuthSurface, env: ConsoleRuntimeEnv): string | null {
  const configured =
    surface === "console" ? env.CONSOLE_AUTH_SECRET?.trim() : env.AUTH_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    return surface === "console" ? LOCAL_DEV_CONSOLE_SECRET : LOCAL_DEV_APP_SECRET;
  }
  return null;
}

function resolveConsoleEmailPort(
  env: ConsoleRuntimeEnv,
  override?: EmailPort | null,
): EmailPort | null {
  if (override !== undefined) return override;
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    return createLocalMailSink();
  }
  return resolveEmailPort({ cloudflareBinding: env.EMAIL ?? null });
}

/**
 * Authenticates and authorizes a `console.punyasitus.com` request:
 * 1. Strict console host isolation (`404` on non-console hosts).
 * 2. CSRF / Origin check on state-changing HTTP methods (`403`).
 * 3. Live Better Auth session verification + `enforceSessionLifetimeCeiling` (30m idle / 8h absolute).
 * 4. Live `PLATFORM_DB.platform_operators` check + mandatory verified 2FA (`requireActivePlatformOperator`),
 *    plus 10-minute step-up reauthentication (`requireRecentSecondFactor`) when `requireStepUp: true`.
 */
export async function authorizeConsoleRequest(
  request: Request,
  env: ConsoleRuntimeEnv,
  config: {
    readonly action: string;
    readonly requireStepUp?: boolean;
    readonly enforceCsrf?: boolean;
  },
  options: ConsoleHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedConsoleContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createConsoleRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Strict console host boundary
  const host = resolveConsoleHostContext(request, env);
  if (!host) {
    return {
      ok: false,
      response: consoleErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement on state-changing requests
  const method = request.method.toUpperCase();
  const shouldEnforceCsrf = config.enforceCsrf ?? STATE_CHANGING_METHODS.has(method);
  if (shouldEnforceCsrf && STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, host.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: consoleErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. PLATFORM_DB availability
  if (!env.PLATFORM_DB) {
    return {
      ok: false,
      response: consoleErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sedang tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // Ensure additive local/test schemas (0003 & 0005) exist without mutating prod at request time
  if (env.APP_ENV === "local" || env.APP_ENV === "test") {
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
  }

  // 4. Resolve session via Better Auth (or pre-passed test session, still live-checked in DB)
  let session: PlatformSessionInput | null = options.session ?? null;
  let user: PlatformUserInput | null = options.user ?? null;

  if (!session || !user) {
    const secret = resolveConsoleAuthSecret(host.authSurface, env);
    if (!secret) {
      return {
        ok: false,
        response: consoleErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi console belum lengkap.",
          requestId,
        ),
      };
    }

    try {
      const auth = createAuth(env.PLATFORM_DB, {
        baseURL: host.baseURL,
        secret,
        surface: host.authSurface,
        trustedOrigins: [host.expectedOrigin],
        emailPort: resolveConsoleEmailPort(env, options.emailPort),
      });
      const sessionRes = await auth.api.getSession({ headers: request.headers });
      if (sessionRes?.user && sessionRes.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(env.PLATFORM_DB, {
          sessionId: sessionRes.session.id,
          userId: sessionRes.user.id,
          surface: "console",
          pathname,
          nowMs,
        });
        if (!lifetime.valid) {
          return {
            ok: false,
            response: consoleErrorResponse(
              401,
              "SESSION_EXPIRED",
              "Sesi operator platform telah kedaluwarsa. Silakan masuk kembali.",
              requestId,
            ),
          };
        }
        session = {
          id: sessionRes.session.id,
          userId: sessionRes.session.userId,
          token: sessionRes.session.token,
          createdAt: sessionRes.session.createdAt,
          expiresAt: sessionRes.session.expiresAt,
        };
        user = {
          id: sessionRes.user.id,
          email: sessionRes.user.email,
        };
      }
    } catch {
      session = null;
      user = null;
    }
  }

  if (!session || !user) {
    return {
      ok: false,
      response: consoleErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi operator platform yang terautentikasi wajib digunakan.",
        requestId,
      ),
    };
  }

  // 5. Live operator grant + mandatory 2FA (+ optional 10-minute step-up reauth)
  try {
    const actor = config.requireStepUp
      ? await requireRecentSecondFactor(env.PLATFORM_DB, {
          session,
          user,
          windowMs: options.reauthWindowMs,
          nowMs,
          requestId,
          action: config.action,
        })
      : await requireActivePlatformOperator(env.PLATFORM_DB, {
          session,
          user,
          requireTwoFactor: true,
          nowMs,
          requestId,
          action: config.action,
        });

    return {
      ok: true,
      ctx: {
        requestId,
        nowMs,
        platformDb: env.PLATFORM_DB,
        host,
        actor,
        user,
        session,
      },
    };
  } catch (err) {
    if (err instanceof PlatformGuardError) {
      return {
        ok: false,
        response: mapPlatformErrorToResponse(err, requestId),
      };
    }
    return {
      ok: false,
      response: consoleErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi operator platform.",
        requestId,
      ),
    };
  }
}

/**
 * Maps domain errors (`PlatformGuardError`, `PlatformOperatorError`, `PlatformSettingsError`,
 * `PlatformAuditError`) to canonical HTTP JSON responses for `/api/console/**`.
 */
export function mapPlatformErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof PlatformGuardError) {
    // Normalize stale step-up 2FA to canonical `REAUTH_REQUIRED` while preserving `reasonCode`
    if (err.code === "RECENT_SECOND_FACTOR_REQUIRED" || err.code === "REAUTH_REQUIRED") {
      return consoleErrorResponse(
        403,
        "REAUTH_REQUIRED",
        "Verifikasi ulang autentikasi dua faktor (dalam 10 menit terakhir) diperlukan sebelum melanjutkan tindakan ini.",
        requestId,
        {
          reasonCode: err.code,
          verifyPath: "/auth/two-factor?mode=verify",
        },
      );
    }
    const extra =
      err.code === "TOTP_ENROLLMENT_REQUIRED"
        ? { enrollmentPath: "/auth/two-factor?mode=enroll" }
        : err.code === "TOTP_REQUIRED"
          ? { verifyPath: "/auth/two-factor?mode=verify" }
          : undefined;
    return consoleErrorResponse(err.status, err.code, err.message, requestId, extra);
  }

  if (err instanceof PlatformOperatorError) {
    if (err.code === "FINAL_OPERATOR_PROTECTED") {
      return consoleErrorResponse(
        409,
        "LAST_OPERATOR_PROTECTED",
        "Tidak dapat mencabut operator superadmin aktif terakhir di platform.",
        requestId,
        { canonicalCode: "FINAL_OPERATOR_PROTECTED" },
      );
    }
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }

  if (err instanceof PlatformSettingsError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      fields: err.fields,
    });
  }

  if (err instanceof PlatformAuditError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId);
  }

  return consoleErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses permintaan console.",
    requestId,
  );
}

/**
 * Parses a strict JSON object body with byte-size cap and optional key allowlist.
 */
export async function parseStrictConsoleJsonBody(
  request: Request,
  requestId: string,
  allowedKeys?: ReadonlySet<string>,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return {
      ok: false,
      response: consoleErrorResponse(400, "BAD_REQUEST", "Body permintaan tidak dapat dibaca.", requestId),
    };
  }

  if (rawBytes.byteLength > MAX_CONSOLE_JSON_BODY_BYTES) {
    return {
      ok: false,
      response: consoleErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_CONSOLE_JSON_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const text = new TextDecoder().decode(rawBytes).trim();
  if (!text) {
    return {
      ok: false,
      response: consoleErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: consoleErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  if (allowedKeys) {
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        return {
          ok: false,
          response: consoleErrorResponse(
            422,
            "UNKNOWN_FIELD",
            `Field tidak dikenal "${key}".`,
            requestId,
            {
              fields: [
                {
                  field: key,
                  code: "UNKNOWN_FIELD",
                  message: `Unknown field "${key}" is not allowed.`,
                },
              ],
            },
          ),
        };
      }
    }
  }

  return { ok: true, body: record };
}
