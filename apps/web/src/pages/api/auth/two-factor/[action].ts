import { env } from "cloudflare:workers";
import {
  appendTwoFactorAuditEvent,
  applySessionTwoFactorMigration,
  assertAdminCsrfAndOrigin,
  createAuth,
  extractManualTotpSecret,
  generateTotpQrSvg,
  getSessionSecondFactorState,
  mergeCookieHeaders,
  recordSessionSecondFactorVerification,
  TWO_FACTOR_ISSUER,
  type SessionSecondFactorMethod,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { getActivePlatformOperator } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";
import { handleBetterAuthRequest } from "../[...all].ts";

/**
 * Two-Factor Authentication JSON endpoints under `/api/auth/two-factor/{action}`
 * (REQ-068, DEC-021, PLAN §13; TASK-067).
 *
 * Actions:
 * - `GET  /api/auth/two-factor/status`  -> returns `{ enrolled, isPlatformOperator, sessionVerified, verifiedAtMs }`
 *                                          (NEVER returns secret or backup codes)
 * - `POST /api/auth/two-factor/enroll`  -> verifies current password, invokes Better Auth `twoFactor.enable`,
 *                                          returns `{ totpUri, manualSecret, qrSvg, backupCodes }` ONCE ONLY
 * - `POST /api/auth/two-factor/verify`  -> verifies 6-digit TOTP or single-use backup code via Better Auth,
 *                                          records `session_two_factor_verifications` on the authoritative session
 * - `POST /api/auth/two-factor/disable` -> allows tenant users to disable optional 2FA after password check;
 *                                          rejects active platform operators with `403 OPERATOR_2FA_MANDATORY`
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIX_DIGIT_TOTP_RE = /^\d{6}$/;
const STEP_UP_MAX_FAILED_ATTEMPTS = 5;
const STEP_UP_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes (aligned with Better Auth accountLockout)

export interface TwoFactorApiHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
}

function getSetCookieList(headers: Headers): readonly string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraSetCookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  for (const cookie of extraSetCookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function hasPendingTwoFactorCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .some((part) => {
      const name = part.split("=")[0]?.trim() ?? "";
      return name.endsWith(".two_factor");
    });
}

async function safeReadErrorCode(response: Response): Promise<string | null> {
  try {
    const data = (await response.clone().json()) as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    if (typeof data.code === "string" && data.code.trim().length > 0) {
      return data.code.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleTwoFactorApiRequest(
  action: string,
  request: Request,
  runtimeEnv: AuthRuntimeEnv,
  options: TwoFactorApiHandlerOptions = {},
): Promise<Response> {
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed) {
    return jsonResponse(404, { success: false, code: "NOT_FOUND" });
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return jsonResponse(csrf.status, {
        success: false,
        code: csrf.code,
        message: csrf.reason,
      });
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan autentikasi dua faktor sedang tidak tersedia.",
    });
  }

  const secret = resolveSurfaceAuthSecret(hostCtx.surface, runtimeEnv);
  if (!secret) {
    return jsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
    });
  }

  // In local/test runtimes without pre-applied wrangler migrations, ensure 0003 is present.
  // Production/staging relies on pre-deploy `wrangler d1 migrations apply` (never runs DDL on live requests).
  if (runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test") {
    await applySessionTwoFactorMigration(runtimeEnv.PLATFORM_DB);
  }

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: hostCtx.surface,
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
  });

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const sessionResult = await auth.api.getSession({ headers: request.headers }).catch(() => null);

  // -------------------------------------------------------------------------
  // GET /api/auth/two-factor/status
  // -------------------------------------------------------------------------
  if (action === "status" && method === "GET") {
    if (!sessionResult?.user || !sessionResult.session) {
      if (hasPendingTwoFactorCookie(request.headers.get("cookie"))) {
        return jsonResponse(200, {
          success: true,
          authenticated: false,
          pendingChallenge: true,
          enrolled: true,
          isPlatformOperator: false,
          sessionVerified: false,
          verifiedAtMs: null,
          method: null,
        });
      }
      return jsonResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
      });
    }

    const [operatorGrant, tfState] = await Promise.all([
      getActivePlatformOperator(runtimeEnv.PLATFORM_DB, sessionResult.user.id),
      getSessionSecondFactorState(runtimeEnv.PLATFORM_DB, {
        sessionId: sessionResult.session.id,
        userId: sessionResult.user.id,
      }),
    ]);

    return jsonResponse(200, {
      success: true,
      authenticated: true,
      pendingChallenge: false,
      enrolled: tfState.twoFactorEnabled,
      isPlatformOperator: operatorGrant !== null,
      sessionVerified: tfState.sessionVerified,
      verifiedAtMs: tfState.verifiedAtMs,
      method: tfState.method,
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/two-factor/enroll
  // -------------------------------------------------------------------------
  if (action === "enroll" && method === "POST") {
    if (!sessionResult?.user || !sessionResult.session) {
      return jsonResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Anda harus masuk terlebih dahulu untuk mengaktifkan autentikasi dua faktor.",
      });
    }

    const body = await parseJsonObject(request);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password) {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Kata sandi saat ini wajib diisi untuk mengaktifkan 2FA.",
      });
    }

    const enableResponse = await auth.api.enableTwoFactor({
      headers: request.headers,
      body: {
        password,
        issuer: TWO_FACTOR_ISSUER,
      },
      asResponse: true,
    });

    if (!enableResponse.ok) {
      const errCode = await safeReadErrorCode(enableResponse);
      if (errCode === "TOTP_ALREADY_ENABLED") {
        return jsonResponse(409, {
          success: false,
          code: "TOTP_ALREADY_ENABLED",
          message: "Autentikasi dua faktor sudah aktif pada akun Anda.",
        });
      }
      return jsonResponse(enableResponse.status === 401 ? 401 : 403, {
        success: false,
        code: errCode ?? "INVALID_PASSWORD",
        message: "Kata sandi tidak sesuai atau pendaftaran 2FA tidak dapat dimulai.",
      });
    }

    const payload = (await enableResponse.json()) as {
      readonly totpURI?: string;
      readonly backupCodes?: readonly string[];
    };
    const totpUri = payload.totpURI ?? "";
    const backupCodes = Array.isArray(payload.backupCodes) ? payload.backupCodes : [];

    let manualSecret: string;
    let qrSvg: string;
    try {
      manualSecret = extractManualTotpSecret(totpUri);
      qrSvg = generateTotpQrSvg(totpUri, {
        label: "Kode QR autentikasi dua faktor PunyaSitus",
      });
    } catch {
      return jsonResponse(500, {
        success: false,
        code: "INTERNAL_ERROR",
        message: "Gagal menyiapkan konfigurasi kode QR autentikasi dua faktor.",
      });
    }

    const operatorGrant = await getActivePlatformOperator(
      runtimeEnv.PLATFORM_DB,
      sessionResult.user.id,
    );
    if (operatorGrant) {
      // NEVER log secret, totpUri, or backupCodes in platform_audit!
      await appendTwoFactorAuditEvent(runtimeEnv.PLATFORM_DB, {
        actorUserId: sessionResult.user.id,
        actorRole: "platform_operator",
        action: "platform_operator.2fa_enroll_started",
        targetId: sessionResult.user.id,
        outcome: "success",
        reason: "Operator initiated TOTP enrollment",
        metadata: { backupCodeCount: backupCodes.length },
        nowMs,
      });
    }

    return jsonResponse(
      200,
      {
        success: true,
        totpUri,
        manualSecret,
        qrSvg,
        backupCodes,
        shownOnceWarning:
          "Simpan kode cadangan ini sekarang di tempat aman. Daftar kode cadangan hanya ditampilkan satu kali.",
      },
      getSetCookieList(enableResponse.headers),
    );
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/two-factor/verify
  // -------------------------------------------------------------------------
  if (action === "verify" && method === "POST") {
    const hasPendingChallenge = hasPendingTwoFactorCookie(request.headers.get("cookie"));
    if (!sessionResult?.user && !hasPendingChallenge) {
      return jsonResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Sesi verifikasi 2FA tidak ditemukan atau telah berakhir.",
      });
    }

    const body = await parseJsonObject(request);
    const rawCode = typeof body?.code === "string" ? body.code.trim() : "";
    if (!rawCode) {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Masukkan kode verifikasi 6 digit atau kode cadangan Anda.",
      });
    }

    const requestedMethod = body?.method;
    const methodKind: SessionSecondFactorMethod =
      requestedMethod === "backup_code" ||
      (requestedMethod !== "totp" && (rawCode.includes("-") || /[A-Za-z]/.test(rawCode)))
        ? "backup_code"
        : "totp";

    // Persistent D1 lockout check for authenticated step-up verification (Better Auth enforces
    // accountLockout on sign-in challenges; this enforces the same 5-attempt / 15m budget on
    // authenticated step-up across all Cloudflare Workers isolates).
    const isAuthenticatedStepUp = Boolean(sessionResult?.user && sessionResult.session);
    if (isAuthenticatedStepUp && sessionResult?.user) {
      const lockRow = await runtimeEnv.PLATFORM_DB.prepare(
        "SELECT failed_verification_count, locked_until FROM two_factors WHERE user_id = ? LIMIT 1",
      )
        .bind(sessionResult.user.id)
        .first<{ failed_verification_count: number | null; locked_until: number | null }>();
      if (lockRow?.locked_until && lockRow.locked_until > nowMs) {
        return jsonResponse(429, {
          success: false,
          code: "ACCOUNT_TEMPORARILY_LOCKED",
          message:
            "Terlalu banyak percobaan verifikasi 2FA yang gagal. Coba lagi beberapa menit lagi.",
        });
      }
      if (lockRow?.locked_until && lockRow.locked_until <= nowMs) {
        await runtimeEnv.PLATFORM_DB.prepare(
          "UPDATE two_factors SET failed_verification_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?",
        )
          .bind(nowMs, sessionResult.user.id)
          .run();
      }
    }

    let verifyResponse: Response;
    if (methodKind === "backup_code") {
      verifyResponse = await auth.api.verifyBackupCode({
        headers: request.headers,
        body: { code: rawCode },
        asResponse: true,
      });
    } else {
      const normalizedDigits = rawCode.replace(/\s+/g, "");
      if (!SIX_DIGIT_TOTP_RE.test(normalizedDigits)) {
        return jsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "Kode autentikator harus berupa 6 digit angka.",
        });
      }
      verifyResponse = await auth.api.verifyTOTP({
        headers: request.headers,
        body: { code: normalizedDigits },
        asResponse: true,
      });
    }

    const setCookies = getSetCookieList(verifyResponse.headers);

    if (!verifyResponse.ok) {
      const errCode = await safeReadErrorCode(verifyResponse);
      let stepUpLocked = false;
      if (isAuthenticatedStepUp && sessionResult?.user) {
        await runtimeEnv.PLATFORM_DB.prepare(
          `
          UPDATE two_factors
          SET failed_verification_count = COALESCE(failed_verification_count, 0) + 1,
              locked_until = CASE
                WHEN COALESCE(failed_verification_count, 0) + 1 >= ? THEN ?
                ELSE locked_until
              END,
              updated_at = ?
          WHERE user_id = ?
          `,
        )
          .bind(
            STEP_UP_MAX_FAILED_ATTEMPTS,
            nowMs + STEP_UP_LOCKOUT_DURATION_MS,
            nowMs,
            sessionResult.user.id,
          )
          .run();
        const postFailRow = await runtimeEnv.PLATFORM_DB.prepare(
          "SELECT locked_until FROM two_factors WHERE user_id = ? LIMIT 1",
        )
          .bind(sessionResult.user.id)
          .first<{ locked_until: number | null }>();
        stepUpLocked = Boolean(postFailRow?.locked_until && postFailRow.locked_until > nowMs);
      }

      if (sessionResult?.user) {
        const operatorGrant = await getActivePlatformOperator(
          runtimeEnv.PLATFORM_DB,
          sessionResult.user.id,
        );
        if (operatorGrant) {
          await appendTwoFactorAuditEvent(runtimeEnv.PLATFORM_DB, {
            actorUserId: sessionResult.user.id,
            actorRole: "platform_operator",
            action: "platform_operator.2fa_verify",
            targetId: sessionResult.user.id,
            outcome: "denied",
            reason: "Invalid second-factor verification attempt",
            metadata: {
              method: methodKind,
              code: stepUpLocked ? "ACCOUNT_TEMPORARILY_LOCKED" : (errCode ?? "INVALID_CODE"),
            },
            nowMs,
          });
        }
      }

      const statusCode =
        stepUpLocked || verifyResponse.status === 429
          ? 429
          : verifyResponse.status === 400
            ? 400
            : 401;
      return jsonResponse(
        statusCode,
        {
          success: false,
          code: stepUpLocked
            ? "ACCOUNT_TEMPORARILY_LOCKED"
            : (errCode ?? (methodKind === "backup_code" ? "INVALID_BACKUP_CODE" : "INVALID_CODE")),
          message: stepUpLocked
            ? "Terlalu banyak percobaan verifikasi 2FA yang gagal. Coba lagi beberapa menit lagi."
            : methodKind === "backup_code"
              ? "Kode cadangan tidak valid atau sudah pernah digunakan."
              : "Kode autentikator 6 digit tidak sesuai atau sudah kedaluwarsa.",
        },
        setCookies,
      );
    }

    if (isAuthenticatedStepUp && sessionResult?.user) {
      await runtimeEnv.PLATFORM_DB.prepare(
        "UPDATE two_factors SET failed_verification_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?",
      )
        .bind(nowMs, sessionResult.user.id)
        .run();
    }

    // Resolve the authoritative session after Better Auth potentially rotated/created a session cookie
    const mergedCookieHeader = mergeCookieHeaders(
      request.headers.get("cookie"),
      verifyResponse.headers,
    );
    const postVerifySession = await auth.api
      .getSession({ headers: new Headers({ cookie: mergedCookieHeader }) })
      .catch(() => null);

    const effectiveSessionId = postVerifySession?.session?.id ?? sessionResult?.session?.id ?? null;
    const effectiveUserId = postVerifySession?.user?.id ?? sessionResult?.user?.id ?? null;

    if (!effectiveSessionId || !effectiveUserId) {
      return jsonResponse(
        500,
        {
          success: false,
          code: "INTERNAL_ERROR",
          message: "Verifikasi berhasil tetapi sesi aktif tidak dapat dipastikan.",
        },
        setCookies,
      );
    }

    const verification = await recordSessionSecondFactorVerification(runtimeEnv.PLATFORM_DB, {
      sessionId: effectiveSessionId,
      userId: effectiveUserId,
      method: methodKind,
      nowMs,
    });

    const operatorGrant = await getActivePlatformOperator(
      runtimeEnv.PLATFORM_DB,
      effectiveUserId,
    );
    if (operatorGrant) {
      await appendTwoFactorAuditEvent(runtimeEnv.PLATFORM_DB, {
        actorUserId: effectiveUserId,
        actorRole: "platform_operator",
        action: "platform_operator.2fa_verify",
        targetId: effectiveUserId,
        outcome: "success",
        reason: "Operator completed second-factor verification",
        metadata: { method: methodKind },
        nowMs,
      });
    }

    return jsonResponse(
      200,
      {
        success: true,
        ok: true,
        verifiedAtMs: verification.verifiedAtMs,
        method: verification.method,
      },
      setCookies,
    );
  }

  // -------------------------------------------------------------------------
  // POST /api/auth/two-factor/disable
  // -------------------------------------------------------------------------
  if (action === "disable" && method === "POST") {
    if (!sessionResult?.user || !sessionResult.session) {
      return jsonResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
      });
    }

    // Active platform operators CANNOT self-disable mandatory 2FA (DEC-021, REQ-068)
    const operatorGrant = await getActivePlatformOperator(
      runtimeEnv.PLATFORM_DB,
      sessionResult.user.id,
    );
    if (operatorGrant) {
      await appendTwoFactorAuditEvent(runtimeEnv.PLATFORM_DB, {
        actorUserId: sessionResult.user.id,
        actorRole: "platform_operator",
        action: "platform_operator.2fa_disable_attempt",
        targetId: sessionResult.user.id,
        outcome: "denied",
        reason: "Active platform operator attempted to self-disable mandatory 2FA",
        metadata: { code: "OPERATOR_2FA_MANDATORY" },
        nowMs,
      });
      return jsonResponse(403, {
        success: false,
        code: "OPERATOR_2FA_MANDATORY",
        message:
          "Operator platform wajib mengaktifkan 2FA dan tidak dapat menonaktifkannya sendiri. Jika perangkat hilang, gunakan prosedur pemulihan teraudit.",
      });
    }

    const body = await parseJsonObject(request);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password) {
      return jsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Kata sandi saat ini wajib diisi untuk menonaktifkan 2FA.",
      });
    }

    const disableResponse = await auth.api.disableTwoFactor({
      headers: request.headers,
      body: { password },
      asResponse: true,
    });
    const setCookies = getSetCookieList(disableResponse.headers);

    if (!disableResponse.ok) {
      const errCode = await safeReadErrorCode(disableResponse);
      return jsonResponse(disableResponse.status === 401 ? 401 : 403, {
        success: false,
        code: errCode ?? "INVALID_PASSWORD",
        message: "Kata sandi tidak sesuai. Autentikasi dua faktor tetap aktif.",
      });
    }

    await runtimeEnv.PLATFORM_DB.prepare(
      "DELETE FROM session_two_factor_verifications WHERE user_id = ?",
    )
      .bind(sessionResult.user.id)
      .run();

    return jsonResponse(
      200,
      {
        success: true,
        enrolled: false,
      },
      setCookies,
    );
  }

  // Delegate any other Better Auth native `/api/auth/two-factor/*` subroutes cleanly
  if (
    action === "enable" ||
    action === "get-totp-uri" ||
    action === "verify-totp" ||
    action === "verify-backup-code" ||
    action === "generate-backup-codes"
  ) {
    return handleBetterAuthRequest(request, runtimeEnv, { emailPort: options.emailPort });
  }

  return jsonResponse(404, { success: false, code: "NOT_FOUND" });
}

export const ALL: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleTwoFactorApiRequest(params.action ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  });
};
