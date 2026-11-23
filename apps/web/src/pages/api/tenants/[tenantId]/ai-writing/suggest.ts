import {
  AI_WRITING_FACT_CHECK_REMINDER,
  AI_WRITING_QUOTA_LIMIT,
  AiWritingProviderError,
  aiWritingSuggestRequestSchema,
  buildAiWritingProviderRequest,
  detectPiiInSelectedFields,
  formatPiiBlockedMessageId,
  minimizeAiWritingFields,
  sanitizeAiOutputText,
} from "@punyasitus/core/ai-writing/index";
import {
  commitAiWritingQuotaSlot,
  consumeAiWritingBurstLimit,
  createAiUsageId,
  getAiWritingQuotaStatus,
  loadTenantVertical,
  recordAiWritingAudit,
  releaseAiWritingQuotaSlot,
  reserveAiWritingQuotaSlot,
} from "@punyasitus/db/ai-usage/index";
import type { APIRoute } from "astro";
import {
  aiWritingErrorResponse,
  aiWritingJsonResponse,
  authorizeTenantAiWritingRequest,
  buildAiWritingRuntimeEnv,
  createAiWritingRequestId,
  emitAiWritingTelemetry,
  parseStrictAiWritingJsonBody,
  resolveAiWritingProviderPort,
  type TenantAiWritingHandlerOptions,
  type TenantAiWritingRuntimeEnv,
} from "./_shared.ts";

/**
 * `POST /api/tenants/:tenantId/ai-writing/suggest`
 *
 * Generates a single editable Indonesian editorial draft suggestion via Cloudflare Workers AI
 * (`AiWritingProviderPort` / `AiWritingPort`, DEC-046) with:
 * - Zero automatic persistence or publishing (never writes to `TenantStore` content tables)
 * - Strict field minimization (selected fields + authoritative `tenants.vertical` only)
 * - Linear O(n) pre-send PII blocker (`422 AI_PII_DETECTED` before provider call)
 * - Per-user & per-tenant per-minute burst rate limits (`429 AI_RATE_LIMITED`)
 * - Atomic 30-day rolling 100-suggestion quota (`429 AI_QUOTA_EXCEEDED`, DEC-028)
 * - Atomic failed-call refund (provider errors/timeouts consume ZERO quota)
 * - Metadata-only audit & telemetry (ZERO prompt text or suggestion text logged)
 */

export async function handleAiWritingSuggestRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAiWritingRuntimeEnv,
  options: TenantAiWritingHandlerOptions = {},
): Promise<Response> {
  const startedAt = options.nowMs ?? Date.now();
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAiWritingRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantAiWritingRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return aiWritingErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const auth = await authorizeTenantAiWritingRequest(tenantId, request, runtimeEnv, "content:write", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const { member, platformDb } = auth.ctx;
  const quotaLimit = options.quotaLimit ?? AI_WRITING_QUOTA_LIMIT;

  const parsedBody = await parseStrictAiWritingJsonBody(request, requestId);
  if (!parsedBody.ok) return parsedBody.response;

  const validated = aiWritingSuggestRequestSchema.safeParse(parsedBody.body);
  if (!validated.success) {
    const fields = validated.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      code: "VALIDATION_ERROR",
      message: issue.message,
    }));
    return aiWritingErrorResponse(
      422,
      "VALIDATION_ERROR",
      fields[0]?.message ?? "Input permintaan bantuan tulis AI tidak valid.",
      requestId,
      { fields },
    );
  }

  const vertical = (await loadTenantVertical(platformDb, member.tenantId)) ?? "compro";
  const minimized = minimizeAiWritingFields(validated.data, vertical);

  // Defense-in-depth: reject payloads that become empty after control-char stripping / normalization
  if (minimized.selectedFieldKeys.length === 0) {
    return aiWritingErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Isi minimal satu field yang dipilih dengan teks yang valid sebelum meminta saran tulis.",
      requestId,
      {
        fields: [
          {
            field: "fields",
            code: "EMPTY_AFTER_NORMALIZE",
            message: "Teks terpilih kosong setelah normalisasi karakter kontrol.",
          },
        ],
      },
    );
  }

  // 1. Per-user & per-tenant per-minute burst rate limit — runs BEFORE PII audit & quota
  //    so repeated PII-blocked requests cannot flood the append-only `platform_audit` table!
  let burstResult;
  try {
    burstResult = await consumeAiWritingBurstLimit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      nowMs: options.nowMs,
      policy: options.burstPolicy,
    });
  } catch {
    return aiWritingErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan pembatas kecepatan sementara tidak tersedia.",
      requestId,
    );
  }

  if (!burstResult.allowed) {
    const meta = {
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      selectedFieldKeys: minimized.selectedFieldKeys,
      status: "rate_limited" as const,
      errorCode: "AI_RATE_LIMITED",
    };

    emitAiWritingTelemetry(
      {
        requestId,
        tenantId: member.tenantId,
        status: 429,
        durationMs: Math.max(0, (options.nowMs ?? Date.now()) - startedAt),
        errorCode: "AI_RATE_LIMITED",
        metadata: meta,
        nowMs: options.nowMs,
      },
      options.telemetrySink,
    );

    return aiWritingErrorResponse(
      429,
      "AI_RATE_LIMITED",
      burstResult.message,
      requestId,
      {
        scope: burstResult.scope,
        resetAt: burstResult.resetAt,
        retryAfterSeconds: burstResult.retryAfterSeconds,
      },
      { "Retry-After": String(burstResult.retryAfterSeconds) },
    );
  }

  // 2. Pre-send PII blocker — MUST run BEFORE quota reservation or provider call!
  const piiCheck = detectPiiInSelectedFields(minimized.selectedFields);
  if (piiCheck.blocked) {
    const piiMessage = formatPiiBlockedMessageId(piiCheck.detectedKinds);
    const meta = {
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      selectedFieldKeys: minimized.selectedFieldKeys,
      status: "blocked_pii" as const,
      errorCode: "AI_PII_DETECTED",
      piiKindsDetected: piiCheck.detectedKinds,
    };

    try {
      await recordAiWritingAudit(platformDb, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        actorRole: member.role,
        targetId: createAiUsageId(),
        outcome: "denied",
        requestId,
        reason: "AI_PII_DETECTED",
        metadata: meta,
        nowMs: options.nowMs,
      });
    } catch {
      // Audit failure must never bypass PII block.
    }

    emitAiWritingTelemetry(
      {
        requestId,
        tenantId: member.tenantId,
        status: 422,
        durationMs: Math.max(0, (options.nowMs ?? Date.now()) - startedAt),
        errorCode: "AI_PII_DETECTED",
        metadata: meta,
        nowMs: options.nowMs,
      },
      options.telemetrySink,
    );

    return aiWritingErrorResponse(422, "AI_PII_DETECTED", piiMessage, requestId, {
      detectedKinds: piiCheck.detectedKinds,
      findings: piiCheck.findings,
    });
  }

  // 3. Atomic 30-day rolling quota reservation (DEC-028: 100 suggestions / 30 days)
  const usageId = createAiUsageId();
  let reservation;
  try {
    reservation = await reserveAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      requestId,
      usageId,
      nowMs: options.nowMs,
      limit: quotaLimit,
    });
  } catch {
    return aiWritingErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memverifikasi kuota bantuan tulis AI. Coba beberapa saat lagi.",
      requestId,
    );
  }

  if (!reservation.allowed) {
    const meta = {
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      selectedFieldKeys: minimized.selectedFieldKeys,
      status: "quota_exceeded" as const,
      errorCode: "AI_QUOTA_EXCEEDED",
      quotaUsed: reservation.quota.used,
      quotaLimit: reservation.quota.limit,
      quotaRemaining: 0,
    };

    try {
      await recordAiWritingAudit(platformDb, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        actorRole: member.role,
        targetId: usageId,
        outcome: "denied",
        requestId,
        reason: "AI_QUOTA_EXCEEDED",
        metadata: meta,
        nowMs: options.nowMs,
      });
    } catch {
      // Non-fatal
    }

    emitAiWritingTelemetry(
      {
        requestId,
        tenantId: member.tenantId,
        status: 429,
        durationMs: Math.max(0, (options.nowMs ?? Date.now()) - startedAt),
        errorCode: "AI_QUOTA_EXCEEDED",
        metadata: meta,
        nowMs: options.nowMs,
      },
      options.telemetrySink,
    );

    return aiWritingErrorResponse(
      429,
      "AI_QUOTA_EXCEEDED",
      reservation.message,
      requestId,
      {
        quota: reservation.quota,
        retryAfterSeconds: reservation.retryAfterSeconds,
      },
      { "Retry-After": String(reservation.retryAfterSeconds) },
    );
  }

  // 4. Resolve AI provider port (Cloudflare Workers AI or injected test double)
  const providerPort = resolveAiWritingProviderPort(runtimeEnv, options.providerPort);
  if (!providerPort) {
    await releaseAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      usageId: reservation.usageId,
      errorCode: "SERVICE_UNAVAILABLE",
      nowMs: options.nowMs,
    }).catch(() => undefined);

    return aiWritingErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan Cloudflare Workers AI belum dikonfigurasi. Teks Anda tetap aman dan kuota tidak terpotong.",
      requestId,
    );
  }

  // 5. Build minimized Indonesian prompt and call provider
  const providerRequest = buildAiWritingProviderRequest(minimized, {
    gatewayId: runtimeEnv.AI_WRITING_GATEWAY_ID,
  });

  const callStartedAt = options.nowMs ?? Date.now();
  try {
    const result = await providerPort.generateSuggestion(providerRequest);
    const cleanedSuggestion = sanitizeAiOutputText(result.suggestion, minimized.fieldKind);
    if (!cleanedSuggestion) {
      throw new AiWritingProviderError(
        "AI_PROVIDER_ERROR",
        "Hasil draf AI kosong setelah validasi. Teks Anda tetap aman dan kuota tidak terpotong.",
        502,
      );
    }

    const latencyMs =
      typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? Math.max(0, Math.round(result.latencyMs))
        : Math.max(0, (options.nowMs ?? Date.now()) - callStartedAt);

    await commitAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      usageId: reservation.usageId,
      model: result.model,
      tokenCount: result.tokenCount,
      latencyMs,
      nowMs: options.nowMs,
    });

    const latestQuota = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
      nowMs: options.nowMs,
      limit: quotaLimit,
    });

    const meta = {
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      selectedFieldKeys: minimized.selectedFieldKeys,
      status: "succeeded" as const,
      model: result.model,
      tokenCount: result.tokenCount,
      latencyMs,
      quotaUsed: latestQuota.used,
      quotaLimit: latestQuota.limit,
      quotaRemaining: latestQuota.remaining,
    };

    try {
      await recordAiWritingAudit(platformDb, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        actorRole: member.role,
        targetId: reservation.usageId,
        outcome: "success",
        requestId,
        metadata: meta,
        nowMs: options.nowMs,
      });
    } catch {
      // Audit best-effort after quota commit
    }

    emitAiWritingTelemetry(
      {
        requestId,
        tenantId: member.tenantId,
        status: 200,
        durationMs: latencyMs,
        metadata: meta,
        nowMs: options.nowMs,
      },
      options.telemetrySink,
    );

    return aiWritingJsonResponse(200, {
      suggestion: cleanedSuggestion,
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      model: result.model,
      factCheckReminder: AI_WRITING_FACT_CHECK_REMINDER,
      quota: latestQuota,
      requestId,
    });
  } catch (err) {
    const providerErr =
      err instanceof AiWritingProviderError
        ? err
        : new AiWritingProviderError(
            "AI_PROVIDER_ERROR",
            "Layanan bantuan tulis AI sedang mengalami gangguan. Teks Anda di editor tetap aman dan kuota tidak terpotong.",
            502,
          );

    const latencyMs = Math.max(0, (options.nowMs ?? Date.now()) - callStartedAt);

    // CRITICAL: Atomically release reserved quota slot so failed provider calls consume 0 quota!
    await releaseAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      usageId: reservation.usageId,
      errorCode: providerErr.code,
      latencyMs,
      nowMs: options.nowMs,
    }).catch(() => undefined);

    const quotaAfterRefund = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
      nowMs: options.nowMs,
      limit: quotaLimit,
    }).catch(() => reservation.quota);

    const meta = {
      fieldKind: minimized.fieldKind,
      vertical: minimized.vertical,
      tone: minimized.tone,
      selectedFieldKeys: minimized.selectedFieldKeys,
      status: "provider_error" as const,
      errorCode: providerErr.code,
      latencyMs,
      quotaUsed: quotaAfterRefund.used,
      quotaLimit: quotaAfterRefund.limit,
      quotaRemaining: quotaAfterRefund.remaining,
    };

    try {
      await recordAiWritingAudit(platformDb, {
        tenantId: member.tenantId,
        actorUserId: member.userId,
        actorRole: member.role,
        targetId: reservation.usageId,
        outcome: "error",
        requestId,
        reason: providerErr.code,
        metadata: meta,
        nowMs: options.nowMs,
      });
    } catch {
      // Non-fatal
    }

    emitAiWritingTelemetry(
      {
        requestId,
        tenantId: member.tenantId,
        status: providerErr.status,
        durationMs: latencyMs,
        errorCode: providerErr.code,
        metadata: meta,
        nowMs: options.nowMs,
      },
      options.telemetrySink,
    );

    return aiWritingErrorResponse(
      providerErr.status,
      providerErr.code,
      providerErr.message,
      requestId,
      {
        retryable: providerErr.retryable,
        quota: quotaAfterRefund,
      },
    );
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleAiWritingSuggestRequest(params.tenantId ?? "", request, buildAiWritingRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
  });
