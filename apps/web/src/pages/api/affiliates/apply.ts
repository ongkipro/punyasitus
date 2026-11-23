import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
} from "@punyasitus/auth";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  AffiliateError,
  applyForAffiliateAccount,
  formatPublicAffiliateSummaryDto,
} from "@punyasitus/db/affiliates/index";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../middleware/auth.ts";

/**
 * `POST /api/affiliates/apply`
 * Self-service affiliate enrollment application endpoint (`app` host ONLY; REQ-084, PLAN §19.4, TASK-084).
 *
 * Security invariants:
 * - Platform `app` host ONLY (`404 NOT_FOUND` on marketing/console/tenant hosts).
 * - Strict CSRF/Origin (`Content-Type: application/json` + exact `app` Origin -> `403`).
 * - Authenticated Better Auth `app` session + `enforceSessionLifetimeCeiling` (`401`).
 * - Mandatory verified email (`users.email_verified === 1`, `403 EMAIL_NOT_VERIFIED`).
 * - Strict payload validation (bank/e-wallet code, account number, account holder, explicit
 *   `termsAccepted === true`, `termsVersion`; rejects forged/unknown fields with `422`).
 * - Duplicate application for same `user_id` -> `409 AFFILIATE_ALREADY_EXISTS`.
 * - Atomic write to `affiliates` (`status = 'pending'`), `affiliate_enrollment_profiles`,
 *   `user_payout_identities`, and PII-free `platform_audit` (NEVER stores raw bank account number).
 */

export type AffiliateApplyRuntimeEnv = AuthRuntimeEnv;

export interface AffiliateApplyOptions {
  readonly emailPort?: EmailPort | null;
  readonly requestId?: string;
  readonly nowMs?: number;
}

function affiliateJsonResponse(
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

function extractRequestId(request: Request, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const headerId = request.headers.get("cf-ray") ?? request.headers.get("x-request-id");
  if (headerId?.trim()) return headerId.trim();
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function extractAffiliateApplyEnvFromCloudflare(
  rawEnv: Record<string, unknown>,
): AffiliateApplyRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? null,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: (rawEnv.EMAIL as CloudflareSendEmailBinding | undefined) ?? null,
  };
}

export async function handleAffiliateApplyRequest(
  request: Request,
  runtimeEnv: AffiliateApplyRuntimeEnv,
  options: AffiliateApplyOptions = {},
): Promise<Response> {
  const requestId = extractRequestId(request, options.requestId);

  // 1. Strict `app` host isolation (marketing/console/tenant hosts MUST receive neutral 404).
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return affiliateJsonResponse(404, {
      success: false,
      code: "NOT_FOUND",
      message: "Endpoint tidak ditemukan.",
      requestId,
    });
  }

  // 2. Method gate
  if (request.method.toUpperCase() !== "POST") {
    return affiliateJsonResponse(
      405,
      {
        success: false,
        code: "METHOD_NOT_ALLOWED",
        message: "Gunakan metode POST untuk mendaftar sebagai afiliasi.",
        requestId,
      },
      { Allow: "POST" },
    );
  }

  // 3. Strict CSRF & Origin check
  const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
  if (!csrf.ok) {
    return affiliateJsonResponse(csrf.status, {
      success: false,
      code: csrf.code,
      message: csrf.reason,
      requestId,
    });
  }

  // 4. Platform DB & auth configuration availability
  if (!runtimeEnv.PLATFORM_DB) {
    return affiliateJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan afiliasi sedang tidak tersedia.",
      requestId,
    });
  }

  const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
  if (!secret) {
    return affiliateJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Konfigurasi autentikasi belum lengkap.",
      requestId,
    });
  }

  // 5. Authenticate Better Auth `app` session + enforce session lifetime ceiling (DEC-045)
  const auth = createAuth(runtimeEnv.PLATFORM_DB, {
    baseURL: hostCtx.baseURL,
    secret,
    surface: "app",
    trustedOrigins: [hostCtx.expectedOrigin],
    emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
  });

  let sessionResult: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    sessionResult = await auth.api.getSession({ headers: request.headers });
  } catch {
    sessionResult = null;
  }

  if (!sessionResult?.user || !sessionResult.session) {
    return affiliateJsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Silakan masuk terlebih dahulu sebelum mendaftar sebagai afiliasi.",
      requestId,
    });
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
    return affiliateJsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Sesi Anda telah berakhir. Silakan masuk kembali.",
      requestId,
    });
  }

  // 5b. Enforce live verified-email gate BEFORE JSON payload validation (403 precedes 422).
  const userRow = await runtimeEnv.PLATFORM_DB.prepare(
    "SELECT email_verified FROM users WHERE id = ? LIMIT 1",
  )
    .bind(sessionResult.user.id)
    .first<{ readonly email_verified: number }>();

  if (!userRow || userRow.email_verified !== 1) {
    return affiliateJsonResponse(403, {
      success: false,
      code: "EMAIL_NOT_VERIFIED",
      message: "Verifikasi alamat email Anda terlebih dahulu sebelum mendaftar sebagai afiliasi.",
      requestId,
    });
  }

  // 6. Parse JSON body strictly
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return affiliateJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Format isi permintaan JSON tidak valid.",
      requestId,
    });
  }

  // 7. Execute atomic affiliate application + verified-email check + PII-free audit
  try {
    const result = await applyForAffiliateAccount(runtimeEnv.PLATFORM_DB, {
      userId: sessionResult.user.id,
      payload: rawBody,
      requestId,
      nowMs: options.nowMs,
    });

    return affiliateJsonResponse(201, {
      success: true,
      affiliate: formatPublicAffiliateSummaryDto(result.affiliate),
      auditId: result.audit.id,
      requestId,
    });
  } catch (err) {
    if (err instanceof AffiliateError) {
      return affiliateJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
        requestId,
      });
    }
    return affiliateJsonResponse(500, {
      success: false,
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan saat memproses pendaftaran afiliasi.",
      requestId,
    });
  }
}

export const POST: APIRoute = ({ request }) =>
  handleAffiliateApplyRequest(
    request,
    extractAffiliateApplyEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ request }) =>
  handleAffiliateApplyRequest(
    request,
    extractAffiliateApplyEnvFromCloudflare(env as unknown as Record<string, unknown>),
  );
