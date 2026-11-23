import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  canPerform,
  createAuth,
  enforceSessionLifetimeCeiling,
  isActionAllowedForTenantStatus,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { loadLiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import {
  AI_WRITING_MAX_BODY_BYTES,
  buildAiWritingAuditMetadata,
  buildAiWritingTelemetryMetrics,
  createCloudflareWorkersAiPort,
  findForbiddenAiWritingKey,
  type AiWritingAuditMetadataInput,
  type AiWritingProviderPort,
  type WorkersAiBindingLike,
} from "@punyasitus/core/ai-writing/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import { readBoundedRequestBody } from "@punyasitus/core/plugins/index";
import {
  emitTelemetryEvent,
  type TelemetrySink,
} from "@punyasitus/core/telemetry/index";
import type { AiWritingBurstPolicy } from "@punyasitus/db/ai-usage/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared auth, host-isolation, CSRF/Origin, RBAC, entitlement, strict body parsing,
 * and metadata-only telemetry helpers for `/api/tenants/:tenantId/ai-writing/**`
 * (REQ-075, DEC-028, DEC-046, PLAN §18.4, TASK-074).
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const AI_WRITING_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantAiWritingRuntimeEnv extends AuthRuntimeEnv {
  readonly AI?: WorkersAiBindingLike | null;
  readonly AI_WRITING_MODEL?: string;
  readonly AI_WRITING_GATEWAY_ID?: string;
}

export interface TenantAiWritingHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly providerPort?: AiWritingProviderPort | null;
  readonly telemetrySink?: TelemetrySink;
  readonly burstPolicy?: AiWritingBurstPolicy;
  readonly quotaLimit?: number;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
}

export interface AuthorizedAiWritingApiContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly effectiveStatus: string;
}

export type AuthorizeAiWritingApiResult =
  | { readonly ok: true; readonly ctx: AuthorizedAiWritingApiContext }
  | { readonly ok: false; readonly response: Response };

export function createAiWritingRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function aiWritingJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...AI_WRITING_NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

export function aiWritingErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraErrorFields?: Readonly<Record<string, unknown>>,
  extraHeaders?: Record<string, string>,
): Response {
  return aiWritingJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...extraErrorFields,
      },
      requestId,
    },
    extraHeaders,
  );
}

export async function parseStrictAiWritingJsonBody(
  request: Request,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
        requestId,
      ),
    };
  }

  const bounded = await readBoundedRequestBody(request, AI_WRITING_MAX_BODY_BYTES);
  if (!bounded.ok) {
    if (bounded.reason === "too_large") {
      return {
        ok: false,
        response: aiWritingErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          "Ukuran permintaan melebihi batas maksimal 16 KiB.",
          requestId,
        ),
      };
    }
    return {
      ok: false,
      response: aiWritingErrorResponse(
        400,
        "BAD_REQUEST",
        "Body permintaan tidak dapat dibaca.",
        requestId,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return {
      ok: false,
      response: aiWritingErrorResponse(400, "BAD_REQUEST", "Body JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body JSON harus berupa objek.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenKey = findForbiddenAiWritingKey(record);
  if (forbiddenKey) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenKey}" tidak diizinkan pada permintaan bantuan tulis AI.`,
        requestId,
        {
          fields: [
            {
              field: forbiddenKey,
              code: "FORBIDDEN_FIELD",
              message: `Field "${forbiddenKey}" tidak diizinkan.`,
            },
          ],
        },
      ),
    };
  }

  return { ok: true, body: record };
}

export async function authorizeTenantAiWritingRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantAiWritingRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantAiWritingHandlerOptions = {},
): Promise<AuthorizeAiWritingApiResult> {
  const requestId = options.requestId ?? createAiWritingRequestId();
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: aiWritingErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: aiWritingErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
      ),
    };
  }

  let actorUserId = options.authenticatedUser?.id ?? null;
  if (!actorUserId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: aiWritingErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum siap.",
          requestId,
        ),
      };
    }
    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
      });
      const sessionRes = await auth.api.getSession({ headers: request.headers });
      if (sessionRes?.user && sessionRes.session) {
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionRes.session.id,
          userId: sessionRes.user.id,
          surface: "app",
          pathname: new URL(request.url).pathname.toLowerCase(),
          nowMs: options.nowMs,
        });
        if (lifetime.valid) {
          actorUserId = sessionRes.user.id;
        }
      }
    } catch {
      actorUserId = null;
    }
  }

  if (!actorUserId) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  const cleanSelector = tenantSelector.trim();
  if (!cleanSelector) {
    return {
      ok: false,
      response: aiWritingErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  let member: AuthorizedTenantMember;
  try {
    const isUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(cleanSelector);
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId: actorUserId,
      ...(isUlid ? { tenantId: cleanSelector } : { handle: cleanSelector.toLowerCase() }),
      surface: "app",
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: aiWritingErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: aiWritingErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  // Live server-clock entitlement check BEFORE any AI usage reads or provider calls
  const entitlement = await loadLiveTenantEntitlement(
    runtimeEnv.PLATFORM_DB,
    { tenantId: member.tenantId },
    { nowMs: options.nowMs },
  );
  if (!entitlement) {
    return {
      ok: false,
      response: aiWritingErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  const effectiveStatus = entitlement.evaluation.effectiveStatus;
  const storedStatus = entitlement.evaluation.storedStatus;
  if (effectiveStatus === "purged" || storedStatus === "purged" || effectiveStatus === "purging" || storedStatus === "purging") {
    return {
      ok: false,
      response: aiWritingErrorResponse(404, "NOT_FOUND", "Situs tidak ditemukan.", requestId),
    };
  }

  const isMutation = STATE_CHANGING_METHODS.has(method);
  if (
    entitlement.evaluation.operatorHold ||
    effectiveStatus === "suspended" ||
    effectiveStatus === "recovery"
  ) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Bantuan tulis AI dinonaktifkan karena situs sedang ditangguhkan. Perpanjang atau pulihkan langganan untuk melanjutkan.",
        requestId,
      ),
    };
  }

  if (effectiveStatus === "locked" && isMutation) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Situs sedang dalam mode terkunci (hanya baca). Perpanjang langganan untuk menggunakan bantuan tulis AI.",
        requestId,
      ),
    };
  }

  if (!canPerform(member.role, requiredPermission)) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        403,
        "FORBIDDEN",
        "Peran akun Anda tidak memiliki izin untuk menggunakan bantuan tulis AI.",
        requestId,
      ),
    };
  }

  const statusActionCheck = isActionAllowedForTenantStatus(effectiveStatus, requiredPermission);
  if (!statusActionCheck.allowed) {
    return {
      ok: false,
      response: aiWritingErrorResponse(
        statusActionCheck.status,
        statusActionCheck.code,
        "Status langganan saat ini tidak mengizinkan tindakan bantuan tulis AI.",
        requestId,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member: { ...member, tenantStatus: effectiveStatus },
      platformDb: runtimeEnv.PLATFORM_DB,
      effectiveStatus,
    },
  };
}

export function resolveAiWritingProviderPort(
  runtimeEnv: TenantAiWritingRuntimeEnv,
  override?: AiWritingProviderPort | null,
): AiWritingProviderPort | null {
  if (override !== undefined) return override;
  if (!runtimeEnv.AI) return null;
  return createCloudflareWorkersAiPort({
    ai: runtimeEnv.AI,
    model: runtimeEnv.AI_WRITING_MODEL,
    gatewayId: runtimeEnv.AI_WRITING_GATEWAY_ID,
  });
}

export function emitAiWritingTelemetry(
  input: {
    readonly requestId: string;
    readonly tenantId: string;
    readonly status: number;
    readonly durationMs: number;
    readonly errorCode?: string | null;
    readonly metadata: AiWritingAuditMetadataInput;
    readonly nowMs?: number;
  },
  sink?: TelemetrySink,
): void {
  const safeMeta = buildAiWritingAuditMetadata(input.metadata);
  emitTelemetryEvent(
    {
      requestId: input.requestId,
      tenantId: input.tenantId,
      operation: "ai_writing.suggest",
      status: input.status,
      durationMs: input.durationMs,
      errorCode: input.errorCode ?? null,
      timestamp: input.nowMs ?? Date.now(),
      metrics: buildAiWritingTelemetryMetrics(safeMeta),
    },
    sink,
  );
}

export function buildAiWritingRuntimeEnv(): TenantAiWritingRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly AI?: WorkersAiBindingLike;
    readonly AI_WRITING_MODEL?: string;
    readonly AI_WRITING_GATEWAY_ID?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    AI: runtimeEnv.AI,
    AI_WRITING_MODEL: runtimeEnv.AI_WRITING_MODEL,
    AI_WRITING_GATEWAY_ID: runtimeEnv.AI_WRITING_GATEWAY_ID,
  };
}
