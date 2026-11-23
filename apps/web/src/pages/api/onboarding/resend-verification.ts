import { env } from "cloudflare:workers";
import {
  issueEmailVerificationToken,
  OnboardingAuthError,
} from "@punyasitus/auth/onboarding/index";
import {
  assertNoForbiddenOnboardingFields,
  OnboardingValidationError,
} from "@punyasitus/core/onboarding/index";
import {
  isHoneypotTriggered,
  stripTurnstileAndHoneypotFields,
  verifyTurnstileGuard,
} from "@punyasitus/core/security/turnstile";
import type { APIRoute } from "astro";
import { resolveAuthEmailPort } from "../../../middleware/auth.ts";
import {
  extractOnboardingEnvFromCloudflare,
  onboardingJsonResponse,
  parseOnboardingJsonObject,
  resolveAuthenticatedOnboardingSession,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;

/**
 * `POST /api/onboarding/resend-verification`
 * Rate-limited verification email resend on the `app` host with honeypot + Turnstile
 * protection and graceful email-outage recovery (`503 EMAIL_DELIVERY_FAILED`).
 */
export async function handleResendVerificationRequest(
  request: Request,
  runtimeEnv: OnboardingRuntimeEnv,
  options: OnboardingApiOptions = {},
): Promise<Response> {
  const host = resolveOnboardingAppHost(request, runtimeEnv);
  if (!host.ok) return host.response;

  if (request.method.toUpperCase() !== "POST") {
    return onboardingJsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode tidak didukung.",
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return onboardingJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pengiriman verifikasi email sedang tidak tersedia.",
    });
  }

  const rawBody = await parseOnboardingJsonObject(request);
  if (!rawBody) {
    return onboardingJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Format permintaan JSON tidak valid.",
    });
  }

  if (isHoneypotTriggered(rawBody)) {
    return onboardingJsonResponse(400, {
      success: false,
      code: "HONEYPOT_TRIGGERED",
      message: "Permintaan ditolak oleh perlindungan anti-spam.",
    });
  }

  const expectedHostname = new URL(host.expectedOrigin).hostname;
  const turnstileResult = await verifyTurnstileGuard({
    appEnv: runtimeEnv.APP_ENV,
    secretKey: runtimeEnv.TURNSTILE_SECRET_KEY,
    request,
    body: rawBody,
    expectedAction: "auth_verify_resend",
    expectedHostname,
    enforceWhenUnconfigured: options.enforceTurnstileWhenUnconfigured,
    fetchFn: options.turnstileFetch,
  });
  if (!turnstileResult.ok) {
    return onboardingJsonResponse(turnstileResult.status, {
      success: false,
      code: turnstileResult.code,
      message: turnstileResult.reason,
    });
  }

  const cleanedBody = stripTurnstileAndHoneypotFields(rawBody);

  try {
    assertNoForbiddenOnboardingFields(cleanedBody);
    for (const key of Object.keys(cleanedBody)) {
      if (key !== "email") {
        throw new OnboardingValidationError(
          422,
          "VALIDATION_ERROR",
          `Kolom "${key}" tidak dikenali.`,
          key,
        );
      }
    }

    const authCheck = await resolveAuthenticatedOnboardingSession(
      request,
      runtimeEnv,
      host,
      options,
    );
    if (!authCheck.ok) return authCheck.response;

    const targetEmail =
      typeof cleanedBody.email === "string" && cleanedBody.email.trim().length > 0
        ? cleanedBody.email.trim().toLowerCase()
        : undefined;

    if (!authCheck.session && !targetEmail) {
      return onboardingJsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Masukkan alamat email akun Anda untuk mengirim ulang tautan verifikasi.",
      });
    }

    if (targetEmail && !SIMPLE_EMAIL_RE.test(targetEmail)) {
      return onboardingJsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Format alamat email tidak valid.",
      });
    }

    const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
    const result = await issueEmailVerificationToken(runtimeEnv.PLATFORM_DB, {
      userId: authCheck.session?.userId,
      email: authCheck.session ? undefined : targetEmail,
      baseURL: host.baseURL,
      emailPort,
      nowMs: options.nowMs,
      enforceRateLimit: true,
    });

    if (result.status === "already_verified") {
      return onboardingJsonResponse(200, {
        success: true,
        status: "already_verified",
        emailSent: false,
        nextPath: "/auth/onboarding",
        message: "Alamat email akun Anda sudah terverifikasi. Silakan lanjut membuat website.",
      });
    }

    if (result.status === "email_outage") {
      return onboardingJsonResponse(503, {
        success: false,
        code: "EMAIL_DELIVERY_FAILED",
        emailOutage: true,
        message:
          "Layanan pengiriman email sedang mengalami gangguan sementara. Akun Anda tetap aman — silakan coba kirim ulang beberapa saat lagi atau gunakan Masuk dengan Google.",
      });
    }

    // Neutral response for both "sent" and unauthenticated "not_found" (prevents email enumeration)
    return onboardingJsonResponse(200, {
      success: true,
      status: "sent",
      emailSent: result.status === "sent",
      message:
        "Jika alamat email terdaftar dan belum terverifikasi, tautan verifikasi baru telah dikirim ke kotak masuk Anda.",
    });
  } catch (err) {
    if (err instanceof OnboardingValidationError) {
      return onboardingJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    if (err instanceof OnboardingAuthError) {
      const headers =
        err.retryAfterSeconds !== undefined
          ? { "Retry-After": String(err.retryAfterSeconds) }
          : undefined;
      return onboardingJsonResponse(
        err.status,
        {
          success: false,
          code: err.code,
          message: err.message,
          ...(err.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: err.retryAfterSeconds }
            : {}),
        },
        headers,
      );
    }
    return onboardingJsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses pengiriman ulang verifikasi email.",
    });
  }
}

export const POST: APIRoute = ({ request }) =>
  handleResendVerificationRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
