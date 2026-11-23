import { env } from "cloudflare:workers";
import { isOnboardingAiProviderConfigured } from "@punyasitus/core/onboarding/ai-draft/index";
import { getOwnerOnboardingStatus } from "@punyasitus/db/provisioning/self-service";
import type { APIRoute } from "astro";
import {
  extractOnboardingEnvFromCloudflare,
  onboardingJsonResponse,
  resolveAuthenticatedOnboardingSession,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/onboarding/status`
 * Returns verified-email state, one-trial eligibility (`trialEligible`), existing owned sites,
 * and any recoverable partial-provisioning attempts for the authenticated `app` user.
 */
export async function handleOnboardingStatusRequest(
  request: Request,
  runtimeEnv: OnboardingRuntimeEnv,
  options: OnboardingApiOptions = {},
): Promise<Response> {
  const host = resolveOnboardingAppHost(request, runtimeEnv);
  if (!host.ok) return host.response;

  if (request.method.toUpperCase() !== "GET") {
    return onboardingJsonResponse(405, {
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Metode tidak didukung.",
    });
  }

  const authCheck = await resolveAuthenticatedOnboardingSession(request, runtimeEnv, host, options);
  if (!authCheck.ok) return authCheck.response;
  if (!authCheck.session) {
    return onboardingJsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Silakan masuk terlebih dahulu untuk melanjutkan pendaftaran situs.",
    });
  }

  try {
    const status = await getOwnerOnboardingStatus(
      runtimeEnv.PLATFORM_DB!,
      authCheck.session.userId,
      {
        saasZone: runtimeEnv.SAAS_ZONE,
        nowMs: options.nowMs,
      },
    );

    if (!status) {
      return onboardingJsonResponse(401, {
        success: false,
        code: "UNAUTHENTICATED",
        message: "Akun tidak ditemukan. Silakan masuk kembali.",
      });
    }

    return onboardingJsonResponse(200, {
      success: true,
      ...status,
      aiProviderConfigured: isOnboardingAiProviderConfigured(runtimeEnv, options.providerPort),
    });
  } catch {
    return onboardingJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Gagal memuat status onboarding akun saat ini.",
    });
  }
}

export const GET: APIRoute = ({ request }) =>
  handleOnboardingStatusRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
