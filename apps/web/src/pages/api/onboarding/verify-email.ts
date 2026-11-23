import { env } from "cloudflare:workers";
import {
  OnboardingAuthError,
  redeemEmailVerificationToken,
} from "@punyasitus/auth/onboarding/index";
import {
  assertNoForbiddenOnboardingFields,
  OnboardingValidationError,
} from "@punyasitus/core/onboarding/index";
import type { APIRoute } from "astro";
import {
  extractOnboardingEnvFromCloudflare,
  onboardingJsonResponse,
  parseOnboardingJsonObject,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/onboarding/verify-email`
 * Redeems a single-use hashed email verification token on the `app` host.
 * - Replay-safe: returns `200 { status: "already_verified", replayed: true }` when replayed.
 * - Expired link: returns `410 VERIFICATION_TOKEN_EXPIRED` with `canResend: true`.
 * - Rejects client-supplied privilege/server fields (`422 FORBIDDEN_CLIENT_FIELD`).
 */
export async function handleVerifyEmailRequest(
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
      message: "Layanan verifikasi email sedang tidak tersedia.",
    });
  }

  const body = await parseOnboardingJsonObject(request);
  if (!body) {
    return onboardingJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Format permintaan JSON tidak valid.",
    });
  }

  try {
    assertNoForbiddenOnboardingFields(body);
    for (const key of Object.keys(body)) {
      if (key !== "token") {
        throw new OnboardingValidationError(
          422,
          "VALIDATION_ERROR",
          `Kolom "${key}" tidak dikenali.`,
          key,
        );
      }
    }
    if (typeof body.token !== "string" || body.token.trim().length === 0) {
      return onboardingJsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Token verifikasi email wajib diisi.",
      });
    }

    const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? null;
    const result = await redeemEmailVerificationToken(runtimeEnv.PLATFORM_DB, {
      token: body.token,
      requestId,
      nowMs: options.nowMs,
    });

    if (result.status === "expired") {
      return onboardingJsonResponse(410, {
        success: false,
        code: "VERIFICATION_TOKEN_EXPIRED",
        message:
          "Tautan verifikasi email sudah kedaluwarsa. Minta tautan baru di bawah untuk melanjutkan.",
        canResend: true,
      });
    }

    return onboardingJsonResponse(200, {
      success: true,
      status: result.status,
      replayed: result.replayed,
      emailVerified: true,
      nextPath: "/auth/onboarding",
      message:
        result.status === "already_verified"
          ? "Alamat email Anda sudah terverifikasi sebelumnya. Anda dapat langsung membuat website."
          : "Alamat email berhasil diverifikasi. Anda kini dapat membuat website pertama Anda.",
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
      return onboardingJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return onboardingJsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memverifikasi alamat email.",
    });
  }
}

export const POST: APIRoute = ({ request }) =>
  handleVerifyEmailRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
