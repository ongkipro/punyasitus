/**
 * Cloudflare Turnstile server-side Siteverify verifier and accessible honeypot guard
 * (REQ-090, PLAN §4, §6, §17.2; TASK-090).
 *
 * Security & fail-closed invariants:
 * - Official Cloudflare Siteverify endpoint (`https://challenges.cloudflare.com/turnstile/v0/siteverify`)
 *   called with a bounded timeout (`AbortSignal.timeout(5000)` by default).
 * - Outside `APP_ENV === "local" || APP_ENV === "test"`, ALWAYS fails closed:
 *   - Missing `TURNSTILE_SECRET_KEY` -> `503 TURNSTILE_NOT_CONFIGURED`
 *   - Missing token -> `403 TURNSTILE_REQUIRED`
 *   - Invalid/expired/mismatched token -> `403 TURNSTILE_INVALID`
 * - In `APP_ENV === "local" || APP_ENV === "test"`, enforces full Siteverify whenever
 *   `TURNSTILE_SECRET_KEY` is configured OR `enforceWhenUnconfigured: true`; otherwise
 *   bypasses cleanly so local dev and upstream E2E/workerd suites without Turnstile env stay green.
 * - NEVER logs, returns, or embeds raw Turnstile secret keys or response tokens in any error.
 */

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify" as const;

export const TURNSTILE_MAX_TOKEN_LENGTH = 2048 as const;
export const TURNSTILE_DEFAULT_TIMEOUT_MS = 5000 as const;

export const TURNSTILE_TOKEN_HEADER = "x-turnstile-token" as const;
export const TURNSTILE_TOKEN_BODY_FIELDS = ["cf-turnstile-response", "turnstileToken"] as const;

export const HONEYPOT_FIELD_NAMES = ["hp_website", "_hp_field", "website_url"] as const;

export const TURNSTILE_PROTECTED_AUTH_PATHS = [
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
] as const;

export const TURNSTILE_AUTH_PATH_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  "/api/auth/sign-up/email": "auth_register",
  "/api/auth/sign-in/email": "auth_login",
  "/api/auth/request-password-reset": "auth_reset_password",
  "/api/auth/forget-password": "auth_reset_password",
});

const PROTECTED_AUTH_PATH_SET = new Set<string>(TURNSTILE_PROTECTED_AUTH_PATHS);

export type TurnstileErrorCode =
  | "TURNSTILE_NOT_CONFIGURED"
  | "TURNSTILE_REQUIRED"
  | "TURNSTILE_INVALID"
  | "TURNSTILE_UNAVAILABLE";

export interface TurnstileVerificationSuccess {
  readonly ok: true;
  readonly bypassed: boolean;
  readonly hostname: string | null;
  readonly action: string | null;
  readonly challengeTs: string | null;
}

export interface TurnstileVerificationFailure {
  readonly ok: false;
  readonly status: 403 | 503;
  readonly code: TurnstileErrorCode;
  readonly reason: string;
  readonly errorCodes: readonly string[];
}

export type TurnstileVerificationResult =
  | TurnstileVerificationSuccess
  | TurnstileVerificationFailure;

export interface VerifyTurnstileTokenParams {
  readonly secretKey: string;
  readonly token: string;
  readonly remoteIp?: string | null;
  readonly expectedAction?: string | readonly string[];
  readonly expectedHostname?: string | readonly string[];
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly endpoint?: string;
}

export interface VerifyTurnstileGuardParams {
  readonly appEnv?: string | null;
  readonly secretKey?: string | null;
  readonly token?: string | null;
  readonly request?: Request;
  readonly body?: unknown;
  readonly remoteIp?: string | null;
  readonly expectedAction?: string | readonly string[];
  readonly expectedHostname?: string | readonly string[];
  readonly idempotencyKey?: string;
  /** Forces enforcement even in `local`/`test` when `secretKey` is empty/unset. */
  readonly enforceWhenUnconfigured?: boolean;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly endpoint?: string;
}

interface CloudflareSiteverifyPayload {
  readonly success?: unknown;
  readonly hostname?: unknown;
  readonly action?: unknown;
  readonly challenge_ts?: unknown;
  readonly "error-codes"?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHostnameValue(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;
  // Strip optional port (e.g. "127.0.0.1:4321" -> "127.0.0.1")
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1 && !trimmed.startsWith("[")) {
    return trimmed.slice(0, colonIdx) || null;
  }
  return trimmed;
}

function normalizeExpectedList(
  expected: string | readonly string[] | undefined,
  normalizer: (v: string) => string | null,
): readonly string[] {
  if (expected === undefined) return [];
  const items = typeof expected === "string" ? [expected] : expected;
  const out: string[] = [];
  for (const item of items) {
    const normalized = normalizer(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function sanitizeErrorCodes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const codes: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const clean = item.trim().slice(0, 64);
      if (clean && /^[a-z0-9_-]+$/i.test(clean)) {
        codes.push(clean);
      }
    }
    if (codes.length >= 10) break;
  }
  return codes;
}

/**
 * Returns true if `normalizedPathLower` is a public/auth password endpoint protected
 * by Cloudflare Turnstile and honeypot verification.
 */
export function isTurnstileProtectedAuthPath(normalizedPathLower: string): boolean {
  const clean = normalizedPathLower.trim().toLowerCase().replace(/\/+$/, "");
  return PROTECTED_AUTH_PATH_SET.has(clean);
}

/**
 * Resolves the expected Turnstile widget `action` bound to a protected auth endpoint
 * (preventing cross-widget token replay between login, register, password reset, and lead forms).
 */
export function resolveTurnstileActionForAuthPath(normalizedPathLower: string): string | null {
  const clean = normalizedPathLower.trim().toLowerCase().replace(/\/+$/, "");
  return TURNSTILE_AUTH_PATH_ACTIONS[clean] ?? null;
}

/**
 * Extracts a Turnstile token from the parsed request body (`cf-turnstile-response` or
 * `turnstileToken`) or the `X-Turnstile-Token` request header.
 */
export function extractTurnstileToken(request: Request, body?: unknown): string | null {
  if (isPlainObject(body)) {
    for (const field of TURNSTILE_TOKEN_BODY_FIELDS) {
      const value = body[field];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
  }

  const headerValue = request.headers.get(TURNSTILE_TOKEN_HEADER);
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

/**
 * Returns true if any hidden honeypot trap field (`hp_website`, `_hp_field`, `website_url`)
 * was populated in the submitted body.
 */
export function isHoneypotTriggered(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  for (const field of HONEYPOT_FIELD_NAMES) {
    const value = body[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }
    if (Array.isArray(value) && value.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Returns a shallow copy of `body` with Turnstile and honeypot transport fields stripped
 * so downstream handlers (e.g., Better Auth or strict Zod schemas) never see them.
 */
export function stripTurnstileAndHoneypotFields(
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  const excluded = new Set<string>([...TURNSTILE_TOKEN_BODY_FIELDS, ...HONEYPOT_FIELD_NAMES]);
  for (const [key, value] of Object.entries(body)) {
    if (!excluded.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Verifies a Cloudflare Turnstile response token directly against Cloudflare Siteverify.
 * Never logs or echoes raw `secretKey` or `token` values in any returned payload.
 */
export async function verifyTurnstileToken(
  params: VerifyTurnstileTokenParams,
): Promise<TurnstileVerificationResult> {
  const secretKey = params.secretKey.trim();
  if (!secretKey) {
    return {
      ok: false,
      status: 503,
      code: "TURNSTILE_NOT_CONFIGURED",
      reason: "Turnstile secret key is not configured.",
      errorCodes: ["missing-input-secret"],
    };
  }

  const token = params.token.trim();
  if (!token) {
    return {
      ok: false,
      status: 403,
      code: "TURNSTILE_REQUIRED",
      reason: "Verifikasi keamanan Turnstile wajib diselesaikan.",
      errorCodes: ["missing-input-response"],
    };
  }

  if (token.length > TURNSTILE_MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 403,
      code: "TURNSTILE_INVALID",
      reason: "Token verifikasi keamanan Turnstile tidak valid.",
      errorCodes: ["invalid-input-response"],
    };
  }

  const formBody = new URLSearchParams();
  formBody.set("secret", secretKey);
  formBody.set("response", token);

  const remoteIp = params.remoteIp?.trim();
  if (remoteIp) {
    formBody.set("remoteip", remoteIp);
  }

  const idempotencyKey = params.idempotencyKey?.trim();
  if (idempotencyKey) {
    formBody.set("idempotency_key", idempotencyKey);
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? Math.trunc(params.timeoutMs)
      : TURNSTILE_DEFAULT_TIMEOUT_MS;
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const endpoint = params.endpoint ?? TURNSTILE_SITEVERIFY_URL;

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      code: "TURNSTILE_UNAVAILABLE",
      reason: "Layanan verifikasi keamanan sedang tidak dapat dijangkau. Silakan coba lagi.",
      errorCodes: ["siteverify-network-error"],
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 503,
      code: "TURNSTILE_UNAVAILABLE",
      reason: "Layanan verifikasi keamanan sedang tidak tersedia. Silakan coba lagi.",
      errorCodes: [`siteverify-http-${response.status}`],
    };
  }

  let payload: CloudflareSiteverifyPayload;
  try {
    const parsed: unknown = await response.json();
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        status: 403,
        code: "TURNSTILE_INVALID",
        reason: "Respons verifikasi keamanan tidak valid.",
        errorCodes: ["invalid-siteverify-payload"],
      };
    }
    payload = parsed as CloudflareSiteverifyPayload;
  } catch {
    return {
      ok: false,
      status: 403,
      code: "TURNSTILE_INVALID",
      reason: "Respons verifikasi keamanan tidak dapat dibaca.",
      errorCodes: ["invalid-siteverify-json"],
    };
  }

  const errorCodes = sanitizeErrorCodes(payload["error-codes"]);
  if (payload.success !== true) {
    return {
      ok: false,
      status: 403,
      code: "TURNSTILE_INVALID",
      reason: "Verifikasi keamanan Turnstile gagal atau telah kedaluwarsa. Muat ulang lalu coba lagi.",
      errorCodes: errorCodes.length > 0 ? errorCodes : ["verification-failed"],
    };
  }

  const responseAction =
    typeof payload.action === "string" && payload.action.trim().length > 0
      ? payload.action.trim()
      : null;
  const expectedActions = normalizeExpectedList(params.expectedAction, (v) => {
    const t = v.trim();
    return t.length > 0 ? t : null;
  });
  if (expectedActions.length > 0) {
    if (!responseAction || !expectedActions.includes(responseAction)) {
      return {
        ok: false,
        status: 403,
        code: "TURNSTILE_INVALID",
        reason: "Aksi verifikasi keamanan Turnstile tidak sesuai.",
        errorCodes: ["action-mismatch"],
      };
    }
  }

  const responseHostname =
    typeof payload.hostname === "string" ? normalizeHostnameValue(payload.hostname) : null;
  const expectedHostnames = normalizeExpectedList(params.expectedHostname, normalizeHostnameValue);
  if (expectedHostnames.length > 0) {
    if (!responseHostname || !expectedHostnames.includes(responseHostname)) {
      return {
        ok: false,
        status: 403,
        code: "TURNSTILE_INVALID",
        reason: "Domain verifikasi keamanan Turnstile tidak sesuai.",
        errorCodes: ["hostname-mismatch"],
      };
    }
  }

  const challengeTs =
    typeof payload.challenge_ts === "string" && payload.challenge_ts.trim().length > 0
      ? payload.challenge_ts.trim()
      : null;

  return {
    ok: true,
    bypassed: false,
    hostname: responseHostname,
    action: responseAction,
    challengeTs,
  };
}

/**
 * Environment-aware fail-closed Turnstile guard for auth endpoints and public mutation routes
 * (leads, custom forms, abuse reports).
 */
export async function verifyTurnstileGuard(
  params: VerifyTurnstileGuardParams,
): Promise<TurnstileVerificationResult> {
  const isLocalOrTest = params.appEnv === "local" || params.appEnv === "test";
  const secretKey = params.secretKey?.trim() ?? "";

  const resolvedToken =
    params.token !== undefined
      ? (params.token?.trim() ?? "")
      : params.request
        ? (extractTurnstileToken(params.request, params.body) ?? "")
        : "";

  const resolvedRemoteIp =
    params.remoteIp !== undefined
      ? params.remoteIp
      : (params.request?.headers.get("cf-connecting-ip") ?? null);

  if (!isLocalOrTest) {
    if (!secretKey) {
      return {
        ok: false,
        status: 503,
        code: "TURNSTILE_NOT_CONFIGURED",
        reason: "Konfigurasi verifikasi keamanan Turnstile belum tersedia.",
        errorCodes: ["missing-input-secret"],
      };
    }
    return verifyTurnstileToken({
      secretKey,
      token: resolvedToken,
      remoteIp: resolvedRemoteIp,
      expectedAction: params.expectedAction,
      expectedHostname: params.expectedHostname,
      idempotencyKey: params.idempotencyKey,
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
      endpoint: params.endpoint,
    });
  }

  if (!secretKey && params.enforceWhenUnconfigured !== true) {
    return {
      ok: true,
      bypassed: true,
      hostname: null,
      action: null,
      challengeTs: null,
    };
  }

  if (!secretKey) {
    if (!resolvedToken) {
      return {
        ok: false,
        status: 403,
        code: "TURNSTILE_REQUIRED",
        reason: "Verifikasi keamanan Turnstile wajib diselesaikan.",
        errorCodes: ["missing-input-response"],
      };
    }
    return {
      ok: false,
      status: 503,
      code: "TURNSTILE_NOT_CONFIGURED",
      reason: "Konfigurasi verifikasi keamanan Turnstile belum tersedia.",
      errorCodes: ["missing-input-secret"],
    };
  }

  return verifyTurnstileToken({
    secretKey,
    token: resolvedToken,
    remoteIp: resolvedRemoteIp,
    expectedAction: params.expectedAction,
    expectedHostname: params.expectedHostname,
    idempotencyKey: params.idempotencyKey,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    endpoint: params.endpoint,
  });
}
