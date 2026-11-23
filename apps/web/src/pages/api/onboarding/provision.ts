import { env } from "cloudflare:workers";
import {
  assertNoForbiddenOnboardingFields,
  OnboardingValidationError,
  validateOnboardingProvisionPayload,
} from "@punyasitus/core/onboarding/index";
import {
  provisionSelfServiceTenant,
  resumeOnboardingTenantStoreInit,
  SelfServiceOnboardingError,
} from "@punyasitus/db/provisioning/self-service";
import type { APIRoute } from "astro";
import {
  extractOnboardingEnvFromCloudflare,
  onboardingJsonResponse,
  parseOnboardingJsonObject,
  resolveAuthenticatedOnboardingSession,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/onboarding/provision`
 * Authenticated verified-owner atomic self-service website provisioning & idempotent
 * partial-provisioning recovery endpoint (`app` host ONLY; REQ-059, PLAN §17.1-§17.3, TASK-058).
 *
 * Security invariants:
 * - Platform `app` host ONLY (`404` on console/tenant/marketing hosts).
 * - Strict CSRF/Origin (`application/json` + exact `app` Origin).
 * - Authenticated session + `enforceSessionLifetimeCeiling` (`401` if missing/expired).
 * - Mandatory verified email (`403 EMAIL_NOT_VERIFIED` if `users.email_verified !== 1`).
 * - Rejects ALL client-supplied server/privileged fields (`trialEndsAt`, `status`, `role`,
 *   `platformOperator`, `isPlatformOperator`, `isPlatformAdmin`, etc.) with `422`.
 * - Enforces one 7-day (`604,800`s) trial per verified owner atomically in D1; 2nd+ site
 *   starts strictly payment-only (`suspended`, `trialEndsAt = null`, `awaitingFirstPayment = true`).
 * - Returns `202` with `recoveryRequired: true` if `TenantStore` init fails transiently after
 *   `PLATFORM_DB` commit so the owner or queue worker can resume idempotently.
 */
export async function handleOnboardingProvisionRequest(
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

  const authCheck = await resolveAuthenticatedOnboardingSession(request, runtimeEnv, host, options);
  if (!authCheck.ok) return authCheck.response;
  if (!authCheck.session) {
    return onboardingJsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Silakan masuk terlebih dahulu sebelum membuat website.",
    });
  }

  const rawBody = await parseOnboardingJsonObject(request);
  if (!rawBody) {
    return onboardingJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Format isi permintaan JSON tidak valid.",
    });
  }

  const tenantStore =
    options.tenantStore !== undefined ? options.tenantStore : (runtimeEnv.TENANT_STORE ?? null);
  const jobsQueue =
    options.jobsQueue !== undefined ? options.jobsQueue : (runtimeEnv.JOBS_QUEUE ?? null);

  try {
    // Explicit recovery resume path for an existing partially provisioned site
    if (rawBody.action === "resume_recovery") {
      assertNoForbiddenOnboardingFields(rawBody);
      for (const key of Object.keys(rawBody)) {
        if (key !== "action" && key !== "resumeTenantId") {
          throw new OnboardingValidationError(
            422,
            "VALIDATION_ERROR",
            `Kolom "${key}" tidak dikenali pada permintaan pemulihan.`,
            key,
          );
        }
      }
      const resumeTenantId =
        typeof rawBody.resumeTenantId === "string" ? rawBody.resumeTenantId.trim() : "";
      if (!resumeTenantId) {
        return onboardingJsonResponse(422, {
          success: false,
          code: "VALIDATION_ERROR",
          message: "ID situs yang akan dilanjutkan penyiapannya wajib diisi.",
        });
      }
      if (!tenantStore) {
        return onboardingJsonResponse(503, {
          success: false,
          code: "TENANT_STORE_INIT_FAILED",
          message: "Layanan penyimpanan situs sementara tidak tersedia. Silakan coba lagi.",
        });
      }
      const resumed = await resumeOnboardingTenantStoreInit(
        runtimeEnv.PLATFORM_DB!,
        tenantStore,
        {
          tenantId: resumeTenantId,
          userId: authCheck.session.userId,
          saasZone: runtimeEnv.SAAS_ZONE,
          nowMs: options.nowMs,
        },
      );
      const awaitingFirstPayment =
        resumed.tenant.effectiveStatus === "suspended" &&
        resumed.tenant.trialEndsAt === null &&
        resumed.tenant.paidThrough === null;
      return onboardingJsonResponse(200, {
        success: true,
        replayed: true,
        alreadyCompleted: resumed.alreadyCompleted,
        tenantStoreInitialized: resumed.tenantStoreInitialized,
        provisioningState: resumed.provisioningState,
        recoveryRequired: false,
        awaitingFirstPayment,
        tenant: resumed.tenant,
        nextPath: awaitingFirstPayment
          ? `/dashboard/${encodeURIComponent(resumed.tenant.handle)}/billing`
          : `/dashboard/${encodeURIComponent(resumed.tenant.handle)}`,
      });
    }

    const validated = validateOnboardingProvisionPayload(rawBody);
    const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const resolvedIdempotencyKey = headerKey || validated.idempotencyKey || "";
    if (!resolvedIdempotencyKey) {
      return onboardingJsonResponse(422, {
        success: false,
        code: "VALIDATION_ERROR",
        message: "Header Idempotency-Key wajib disertakan untuk membuat website secara aman.",
      });
    }

    const requestId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? null;
    const result = await provisionSelfServiceTenant(runtimeEnv.PLATFORM_DB!, {
      userId: authCheck.session.userId,
      handle: validated.handle,
      name: validated.name,
      vertical: validated.vertical,
      idempotencyKey: resolvedIdempotencyKey,
      requestId,
      saasZone: runtimeEnv.SAAS_ZONE,
      tenantStore,
      jobsQueue,
      nowMs: options.nowMs,
    });

    const httpStatus = result.recoveryRequired ? 202 : result.replayed ? 200 : 201;
    return onboardingJsonResponse(httpStatus, {
      success: true,
      replayed: result.replayed,
      grantedTrial: result.grantedTrial,
      trialDurationSeconds: result.trialDurationSeconds,
      awaitingFirstPayment: result.awaitingFirstPayment,
      billingMode: result.billingMode,
      tenantStoreInitialized: result.tenantStoreInitialized,
      provisioningState: result.provisioningState,
      recoveryRequired: result.recoveryRequired,
      retryEnqueued: result.retryEnqueued,
      idempotencyKey: result.idempotencyKey,
      nextPath: result.nextPath,
      tenant: result.tenant,
    });
  } catch (err) {
    if (err instanceof OnboardingValidationError) {
      return onboardingJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
      });
    }
    if (err instanceof SelfServiceOnboardingError) {
      return onboardingJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    return onboardingJsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat menyiapkan website Anda. Silakan coba lagi.",
    });
  }
}

export const POST: APIRoute = ({ request }) =>
  handleOnboardingProvisionRequest(
    request,
    extractOnboardingEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
