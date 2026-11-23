import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import { FORBIDDEN_BILLING_BODY_KEYS } from "@punyasitus/core/billing/index";
import {
  createLocalMailSink,
  resolveEmailPort,
  type CloudflareSendEmailBinding,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { enforceSessionLifetimeCeiling } from "../google.ts";
import { createAuth } from "../index.ts";
import { assertAdminCsrfAndOrigin } from "../session-guard.ts";
import {
  AgencyGuardError,
  requireActiveAgencyUser,
  type AgencyPermissionAction,
  type AgencySessionInput,
  type AgencyUserInput,
  type VerifiedAgencyUserContext,
} from "./guard.ts";

/**
 * Shared HTTP boundary, host isolation, CSRF/Origin enforcement, strict JSON parsing,
 * and mandatory 2FA response helpers for `/agency/**` and `/api/agency/**`
 * (REQ-083, REQ-034, REQ-068, PLAN §4 & §19.4, TASK-083).
 */

const LOCAL_DEV_APP_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_BILLING_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_BILLING_BODY_KEYS);

export const MAX_AGENCY_JSON_BODY_BYTES = 16_384 as const; // 16 KiB

export const AGENCY_PRIVATE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface AgencyRuntimeEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly SAAS_ZONE?: string;
  readonly PLATFORM_DB?: D1Database | null;
  readonly MEDIA_BUCKET?: R2Bucket | null;
  readonly AUTH_SECRET?: string;
  readonly CONSOLE_AUTH_SECRET?: string;
  readonly EMAIL?: CloudflareSendEmailBinding | null;
  readonly AUTOLARIS_RELAY_URL?: string;
  readonly AUTOLARIS_API_KEY?: string;
  readonly AUTOLARIS_ACCOUNT_ID?: string;
}

export interface AgencyHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly session?: AgencySessionInput | null;
  readonly user?: AgencyUserInput | null;
}

export interface AgencyHostResolution {
  readonly allowed: true;
  readonly baseURL: string;
  readonly expectedOrigin: string;
  readonly isLocalLoopback: boolean;
  readonly host: string;
}

export function createAgencyRequestId(): string {
  try {
    return `ag_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `ag_${Date.now().toString(36)}`;
  }
}

export function agencyJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(AGENCY_PRIVATE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function agencyErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Readonly<Record<string, unknown>>,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("X-PunyaSitus-Auth-Error", code);
  return agencyJsonResponse(
    status,
    {
      success: false,
      error: {
        code,
        message,
        ...(extra ?? {}),
      },
      requestId,
    },
    headers,
  );
}

export function agencyNeutralNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function agencyGatePageErrorResponse(
  status: 401 | 403 | 404,
  code: string,
  message: string,
): Response {
  const safeMessage = message.replace(/[<>&"]/g, "");
  const actionBlock =
    code === "TOTP_ENROLLMENT_REQUIRED"
      ? `<p style="margin-top:16px;"><a href="/auth/two-factor?mode=enroll" data-testid="agency-2fa-enroll-link" style="display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:6px;background:#176b51;color:#ffffff;text-decoration:none;font-weight:600;">Aktifkan Autentikasi Dua Faktor (2FA)</a></p>`
      : code === "TOTP_REQUIRED" || code === "RECENT_SECOND_FACTOR_REQUIRED"
        ? `<p style="margin-top:16px;"><a href="/auth/two-factor?mode=verify" data-testid="agency-2fa-verify-link" style="display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:6px;background:#176b51;color:#ffffff;text-decoration:none;font-weight:600;">Verifikasi Kode 2FA</a></p>`
        : status === 401
          ? `<p style="margin-top:16px;"><a href="/auth/login?next=%2Fagency" data-testid="agency-login-link" style="display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:6px;background:#176b51;color:#ffffff;text-decoration:none;font-weight:600;">Masuk ke PunyaSitus</a></p>`
          : "";

  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Portal Agensi Dibatasi — PunyaSitus</title></head><body style="margin:0;padding:24px;background:#f8faf9;color:#182522;font-family:system-ui,-apple-system,sans-serif;"><main style="max-width:560px;margin:48px auto;padding:24px;background:#ffffff;border:1px solid #d9e2dd;border-radius:8px;" data-testid="agency-gate-error" data-auth-error-code="${code}"><h1 style="margin:0 0 12px;font-size:20px;">Akses Portal Agensi Dibatasi</h1><p style="margin:0;line-height:1.6;color:#52635c;">${safeMessage}</p>${actionBlock}</main></body></html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-PunyaSitus-Auth-Error": code,
    },
  });
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

export function resolveAgencyHostContext(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
): AgencyHostResolution | { readonly allowed: false } {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { allowed: false };
  }

  const isLocal = runtimeEnv.APP_ENV === "local";
  if (isLocal && isLoopbackHost(url.hostname)) {
    return {
      allowed: true,
      baseURL: url.origin,
      expectedOrigin: url.origin,
      isLocalLoopback: true,
      host: url.host,
    };
  }

  const normalizedHost = normalizeHost(url.hostname);
  if (!normalizedHost) return { allowed: false };

  const platformDomain = normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing;
  const appHost = `app.${platformDomain}`;
  if (normalizedHost === appHost) {
    const origin = `https://${appHost}`;
    return {
      allowed: true,
      baseURL: origin,
      expectedOrigin: origin,
      isLocalLoopback: false,
      host: appHost,
    };
  }

  return { allowed: false };
}

function resolveAppAuthSecret(runtimeEnv: AgencyRuntimeEnv): string | null {
  const configured = runtimeEnv.AUTH_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test") {
    return LOCAL_DEV_APP_SECRET;
  }
  return null;
}

function resolveAgencyEmailPort(
  runtimeEnv: AgencyRuntimeEnv,
  override?: EmailPort | null,
): EmailPort | null {
  if (override !== undefined) return override;
  if (runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test") {
    return createLocalMailSink();
  }
  return resolveEmailPort({ cloudflareBinding: runtimeEnv.EMAIL ?? null });
}

export interface AuthorizeAgencyRequestPolicy {
  readonly action: string;
  readonly requestedAgencyId?: string | null;
  readonly requireAgencyMembership?: boolean;
  readonly requiredPermission?: AgencyPermissionAction;
  readonly requireRecentSecondFactor?: boolean;
  readonly enforceCsrf?: boolean;
}

export interface AuthorizedAgencyHttpContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly host: AgencyHostResolution;
  readonly platformDb: D1Database;
  readonly actor: VerifiedAgencyUserContext;
}

export async function authorizeAgencyRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  policy: AuthorizeAgencyRequestPolicy,
  options: AgencyHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedAgencyHttpContext }
  | { readonly ok: false; readonly response: Response; readonly code: string }
> {
  const requestId = options.requestId ?? createAgencyRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Strict `app.punyasitus.com` host boundary (neutral 404 on tenant/console/marketing hosts)
  const host = resolveAgencyHostContext(request, runtimeEnv);
  if (!host.allowed) {
    return {
      ok: false,
      code: "NOT_FOUND",
      response: agencyErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement on state-changing requests
  const method = request.method.toUpperCase();
  const enforceCsrf = policy.enforceCsrf ?? STATE_CHANGING_METHODS.has(method);
  if (enforceCsrf && STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, host.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        code: csrf.code,
        response: agencyErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed DB check
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      response: agencyErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Resolve session + user (prefer explicit pre-resolved locals or live Better Auth cookie)
  let session: AgencySessionInput | null = options.session ?? null;
  let user: AgencyUserInput | null = options.user ?? null;

  if (!session || !user) {
    const secret = resolveAppAuthSecret(runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        code: "SERVICE_UNAVAILABLE",
        response: agencyErrorResponse(
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
        baseURL: host.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [host.expectedOrigin],
        emailPort: resolveAgencyEmailPort(runtimeEnv, options.emailPort),
      });
      const sessionRes = await auth.api.getSession({ headers: request.headers });
      if (sessionRes?.user && sessionRes.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionRes.session.id,
          userId: sessionRes.user.id,
          surface: "app",
          pathname,
          nowMs,
        });
        if (lifetime.valid) {
          session = {
            id: sessionRes.session.id,
            userId: sessionRes.session.userId,
            token: sessionRes.session.token,
          };
          user = {
            id: sessionRes.user.id,
            email: sessionRes.user.email,
            name: sessionRes.user.name,
          };
        }
      }
    } catch {
      session = null;
      user = null;
    }
  }

  try {
    const actor = await requireActiveAgencyUser(runtimeEnv.PLATFORM_DB, {
      session,
      user,
      requestedAgencyId: policy.requestedAgencyId,
      requireAgencyMembership: policy.requireAgencyMembership,
      requiredPermission: policy.requiredPermission,
      requireRecentSecondFactor: policy.requireRecentSecondFactor,
      requestId,
      action: policy.action,
      nowMs,
    });

    return {
      ok: true,
      ctx: {
        requestId,
        nowMs,
        host,
        platformDb: runtimeEnv.PLATFORM_DB,
        actor,
      },
    };
  } catch (err) {
    if (err instanceof AgencyGuardError) {
      const extra =
        err.code === "TOTP_ENROLLMENT_REQUIRED"
          ? { enrollmentPath: "/auth/two-factor?mode=enroll" }
          : err.code === "TOTP_REQUIRED" || err.code === "RECENT_SECOND_FACTOR_REQUIRED"
            ? { verifyPath: "/auth/two-factor?mode=verify" }
            : undefined;
      return {
        ok: false,
        code: err.code,
        response: agencyErrorResponse(err.status, err.code, err.message, requestId, extra),
      };
    }
    return {
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      response: agencyErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi Portal Agensi.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }
}

function findNestedForbiddenKey(
  value: unknown,
  allowedTopLevelKeys: ReadonlySet<string>,
  pathPrefix = "",
): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenKey(value[i], allowedTopLevelKeys, `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    const isExplicitAllowedTopKey = pathPrefix === "" && allowedTopLevelKeys.has(key);
    if (!isExplicitAllowedTopKey && FORBIDDEN_BILLING_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findNestedForbiddenKey(nested, allowedTopLevelKeys, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictAgencyJsonBody(
  request: Request,
  requestId: string,
  allowedKeys: ReadonlySet<string>,
  options: { readonly rejectForbiddenBillingFields?: boolean } = {},
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_AGENCY_JSON_BODY_BYTES) {
    return {
      ok: false,
      response: agencyErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_AGENCY_JSON_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    return {
      ok: false,
      response: agencyErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: agencyErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: agencyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;

  if (options.rejectForbiddenBillingFields) {
    const forbiddenPath = findNestedForbiddenKey(record, allowedKeys);
    if (forbiddenPath) {
      return {
        ok: false,
        response: agencyErrorResponse(
          422,
          "FORBIDDEN_BILLING_FIELD",
          `Field "${forbiddenPath}" tidak diizinkan pada permintaan penagihan agensi.`,
          requestId,
          { field: forbiddenPath },
        ),
      };
    }
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: agencyErrorResponse(
          422,
          "UNKNOWN_FIELD",
          `Field tidak dikenal "${key}".`,
          requestId,
          { field: key },
        ),
      };
    }
  }

  return { ok: true, body: record };
}
