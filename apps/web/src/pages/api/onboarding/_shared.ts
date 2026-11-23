import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
} from "@punyasitus/auth";
import type {
  AiWritingProviderPort,
  WorkersAiBindingLike,
} from "@punyasitus/core/ai-writing/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import type { AiWritingBurstPolicy } from "@punyasitus/db/ai-usage/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { OnboardingRetryQueueProducer } from "@punyasitus/db/provisioning/self-service";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../middleware/auth.ts";

/**
 * Shared platform-`app`-host guard, CSRF/Origin check, session lifetime enforcement,
 * and `private, no-store` / `noindex, nofollow` response builders for `/api/onboarding/**`
 * (REQ-059, REQ-109, PLAN §4, §17.2, §20.5, TASK-058, TASK-109).
 */

export interface OnboardingRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly JOBS_QUEUE?: OnboardingRetryQueueProducer | null;
  readonly AI?: WorkersAiBindingLike | null;
  readonly AI_WRITING_MODEL?: string;
  readonly AI_WRITING_GATEWAY_ID?: string;
  readonly AI_ONBOARDING_ENABLED?: string;
}

export interface OnboardingApiOptions {
  readonly emailPort?: EmailPort | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly jobsQueue?: OnboardingRetryQueueProducer | null;
  readonly providerPort?: AiWritingProviderPort | null;
  readonly burstPolicy?: AiWritingBurstPolicy;
  readonly quotaLimit?: number;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly requestId?: string;
  readonly turnstileFetch?: typeof fetch;
  readonly enforceTurnstileWhenUnconfigured?: boolean;
  readonly nowMs?: number;
}

export interface AuthenticatedOnboardingSession {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly sessionId: string;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function onboardingJsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export async function parseOnboardingJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
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

/**
 * Enforces that `/api/onboarding/**` is reachable ONLY on the `app` platform surface
 * (`app.punyasitus.com` or local loopback in `APP_ENV === "local"`).
 * Tenant hosts, marketing apex, and `console.punyasitus.com` MUST receive `404 NOT_FOUND`.
 */
export function resolveOnboardingAppHost(
  request: Request,
  runtimeEnv: OnboardingRuntimeEnv,
):
  | {
      readonly ok: true;
      readonly baseURL: string;
      readonly expectedOrigin: string;
      readonly isLocalLoopback: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    } {
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: onboardingJsonResponse(404, {
        success: false,
        code: "NOT_FOUND",
        message: "Endpoint tidak ditemukan.",
      }),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: onboardingJsonResponse(csrf.status, {
          success: false,
          code: csrf.code,
          message: csrf.reason,
        }),
      };
    }
  }

  return {
    ok: true,
    baseURL: hostCtx.baseURL,
    expectedOrigin: hostCtx.expectedOrigin,
    isLocalLoopback: hostCtx.isLocalLoopback,
  };
}

/**
 * Authenticates the current `app` session and enforces `enforceSessionLifetimeCeiling` (DEC-045).
 */
export async function resolveAuthenticatedOnboardingSession(
  request: Request,
  runtimeEnv: OnboardingRuntimeEnv,
  host: { readonly baseURL: string; readonly expectedOrigin: string },
  options: OnboardingApiOptions = {},
): Promise<
  | { readonly ok: true; readonly session: AuthenticatedOnboardingSession | null }
  | { readonly ok: false; readonly response: Response }
> {
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: onboardingJsonResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Layanan onboarding sedang tidak tersedia.",
      }),
    };
  }

  const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
  if (!secret) {
    return {
      ok: false,
      response: onboardingJsonResponse(503, {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        message: "Konfigurasi autentikasi belum lengkap.",
      }),
    };
  }

  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: host.baseURL,
    secret,
    surface: "app",
    trustedOrigins: [host.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
  });

  let sessionResult: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    sessionResult = await auth.api.getSession({ headers: request.headers });
  } catch {
    return { ok: true, session: null };
  }

  if (!sessionResult?.user || !sessionResult.session) {
    return { ok: true, session: null };
  }

  const pathname = new URL(request.url).pathname.toLowerCase();
  const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId: sessionResult.session.id,
    userId: sessionResult.user.id,
    surface: "app",
    pathname,
    nowMs: options.nowMs,
  });

  if (!lifetime.valid) {
    return { ok: true, session: null };
  }

  return {
    ok: true,
    session: {
      userId: sessionResult.user.id,
      name: sessionResult.user.name,
      email: sessionResult.user.email,
      emailVerified: Boolean(sessionResult.user.emailVerified),
      sessionId: sessionResult.session.id,
    },
  };
}

export function extractOnboardingEnvFromCloudflare(
  rawEnv: Record<string, unknown>,
): OnboardingRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    SAAS_ZONE: typeof rawEnv.SAAS_ZONE === "string" ? rawEnv.SAAS_ZONE : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? null,
    TENANT_STORE: (rawEnv.TENANT_STORE as TenantStoreNamespaceLike | undefined) ?? null,
    JOBS_QUEUE: (rawEnv.JOBS_QUEUE as OnboardingRetryQueueProducer | undefined) ?? null,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    TURNSTILE_SITE_KEY:
      typeof rawEnv.TURNSTILE_SITE_KEY === "string" ? rawEnv.TURNSTILE_SITE_KEY : undefined,
    TURNSTILE_SECRET_KEY:
      typeof rawEnv.TURNSTILE_SECRET_KEY === "string" ? rawEnv.TURNSTILE_SECRET_KEY : undefined,
    EMAIL: (rawEnv.EMAIL as CloudflareSendEmailBinding | undefined) ?? null,
    AI: (rawEnv.AI as WorkersAiBindingLike | undefined) ?? null,
    AI_WRITING_MODEL:
      typeof rawEnv.AI_WRITING_MODEL === "string" ? rawEnv.AI_WRITING_MODEL : undefined,
    AI_WRITING_GATEWAY_ID:
      typeof rawEnv.AI_WRITING_GATEWAY_ID === "string" ? rawEnv.AI_WRITING_GATEWAY_ID : undefined,
    AI_ONBOARDING_ENABLED:
      typeof rawEnv.AI_ONBOARDING_ENABLED === "string" ? rawEnv.AI_ONBOARDING_ENABLED : undefined,
  };
}
