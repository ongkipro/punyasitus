import { env } from "cloudflare:workers";
import { checkHandleAvailability } from "@punyasitus/db/provisioning/self-service";
import type { APIRoute } from "astro";
import {
  extractOnboardingEnvFromCloudflare,
  onboardingJsonResponse,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/onboarding/check-handle?handle=...`
 * Inline handle normalization, reserved-label check, and live availability check on the
 * `app` host only (REQ-059, PLAN §17.2, TASK-058).
 */
export async function handleCheckHandleRequest(
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

  if (!runtimeEnv.PLATFORM_DB) {
    return onboardingJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pemeriksaan alamat situs sedang tidak tersedia.",
    });
  }

  const url = new URL(request.url);
  const rawHandle = url.searchParams.get("handle") ?? "";

  try {
    const result = await checkHandleAvailability(runtimeEnv.PLATFORM_DB, rawHandle, {
      saasZone: runtimeEnv.SAAS_ZONE,
      nowMs: options.nowMs,
    });

    return onboardingJsonResponse(200, {
      success: true,
      available: result.available,
      normalizedHandle: result.normalizedHandle,
      primaryHost: result.primaryHost,
      saasZone: result.saasZone,
      code: result.code,
      message: result.message,
    });
  } catch {
    return onboardingJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Tidak dapat memeriksa ketersediaan alamat situs saat ini.",
    });
  }
}

export const GET: APIRoute = ({ request }) =>
  handleCheckHandleRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
