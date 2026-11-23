import {
  AuthorizationError,
  canPerform,
  isActionAllowedForTenantStatus,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import { loadLiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import {
  AI_WRITING_MAX_BODY_BYTES,
  AI_WRITING_QUOTA_LIMIT,
  AiWritingProviderError,
  createCloudflareWorkersAiPort,
  formatPiiBlockedMessageId,
  type AiWritingQuotaStatus,
} from "@punyasitus/core/ai-writing/index";
import { serializeDraftStoragePayload } from "@punyasitus/core/content/index";
import {
  applyOnboardingAiDraftToBlueprint,
  buildOnboardingAiDraftProviderRequest,
  buildPlainOnboardingBlueprint,
  detectPiiInOnboardingAnswers,
  isOnboardingAiProviderConfigured,
  ONBOARDING_AI_DRAFT_FACT_NOTICE_ID,
  ONBOARDING_AI_DRAFT_MARKER,
  onboardingAiDraftRequestSchema,
  parseAndSanitizeOnboardingAiDraftOutput,
  resolveDefaultBlueprintForVertical,
  type OnboardingAiDraftFallbackReason,
  type OnboardingBlueprintDraft,
} from "@punyasitus/core/onboarding/ai-draft/index";
import { readBoundedRequestBody } from "@punyasitus/core/plugins/index";
import {
  convertValidatedSectionToPublicPageSectionDto,
  disableSampleSectionsForPageDraft,
} from "@punyasitus/core/presets/index";
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
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  onboardingJsonResponse,
  resolveAuthenticatedOnboardingSession,
  resolveOnboardingAppHost,
  type OnboardingApiOptions,
  type OnboardingRuntimeEnv,
} from "./_shared.ts";

/**
 * Runtime-neutral handler for `POST /api/onboarding/ai-draft`
 * (REQ-109, PLAN §20.5, DEC-028, DEC-043, DEC-046, TASK-109).
 */

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function isUntouchedOnboardingDraftHomepage(existing: {
  readonly title: string;
  readonly draft_sections_json: string | null;
}): boolean {
  const rawJson = existing.draft_sections_json?.trim() ?? "";
  if (!rawJson || rawJson === "[]" || rawJson === "{}") {
    return true;
  }
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (Array.isArray(parsed)) {
      return parsed.length === 0;
    }
    const innerDraftRaw =
      typeof parsed.draftSectionsJson === "string"
        ? parsed.draftSectionsJson
        : typeof parsed.payload === "object" &&
            parsed.payload !== null &&
            typeof (parsed.payload as Record<string, unknown>).draftSectionsJson === "string"
          ? ((parsed.payload as Record<string, unknown>).draftSectionsJson as string)
          : null;
    if (innerDraftRaw) {
      const inner = JSON.parse(innerDraftRaw) as Record<string, unknown>;
      if (inner.source === "onboarding_ai_draft" && inner.draftMarker === ONBOARDING_AI_DRAFT_MARKER) {
        return true;
      }
    }
    if (
      parsed.source === "onboarding_ai_draft" &&
      parsed.draftMarker === ONBOARDING_AI_DRAFT_MARKER
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function persistOnboardingDraftBestEffort(
  tenantStore: TenantStoreNamespaceLike | null | undefined,
  tenantId: string,
  blueprint: OnboardingBlueprintDraft,
  nowMs: number,
): Promise<boolean> {
  if (!tenantStore) return false;
  try {
    const tenantDb = createTenantDb(openTenantStoreStub(tenantStore, tenantId));
    const existing = await tenantDb
      .prepare(
        `SELECT id, slug, title, status, version, draft_sections_json
         FROM pages
         WHERE is_homepage = 1 AND deleted_at IS NULL
         LIMIT 1`,
      )
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly status: string;
        readonly version: number;
        readonly draft_sections_json: string | null;
      }>();

    // Never overwrite a published homepage OR an already user-edited draft homepage!
    if (existing) {
      if (existing.status !== "draft") {
        return false;
      }
      if (!isUntouchedOnboardingDraftHomepage(existing)) {
        return false;
      }
    }

    // Force every CONTOH/sample section disabled in pages.draft_sections_json so generic
    // publish flows can NEVER accidentally publish unedited CONTOH drafts.
    const sampleSafeSections = disableSampleSectionsForPageDraft(blueprint.sections);
    const publicSections = sampleSafeSections
      .filter((s) => s.enabled)
      .map((s) => convertValidatedSectionToPublicPageSectionDto(s));

    const currentVersion = existing ? Number(existing.version) : 0;
    const nextVersion = currentVersion + 1;
    const slug = existing?.slug ?? "beranda";
    const payload = serializeDraftStoragePayload("page", {
      slug,
      title: blueprint.textFields.heroHeadline,
      isHomepage: true,
      layoutMode: "standard",
      sections: publicSections,
      draftSectionsJson: JSON.stringify({
        schemaVersion: 1,
        sourceVersion: nextVersion,
        source: "onboarding_ai_draft",
        draftMarker: ONBOARDING_AI_DRAFT_MARKER,
        sections: sampleSafeSections,
      }),
    });

    if (existing) {
      // NEVER touch `published_sections_json` or `published_at`; enforce optimistic concurrency (`version = ?`).
      const updateRes = await tenantDb
        .prepare(
          `UPDATE pages
           SET title = ?,
               draft_sections_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND status = 'draft' AND version = ?`,
        )
        .bind(blueprint.textFields.heroHeadline, payload.json, nowMs, existing.id, currentVersion)
        .run();
      return Number(updateRes.meta?.changes ?? 0) === 1;
    }

    const insertRes = await tenantDb
      .prepare(
        `INSERT INTO pages (
           slug, title, is_homepage, draft_sections_json,
           status, version, created_at, updated_at
         ) VALUES (?, ?, 1, ?, 'draft', 1, ?, ?)`,
      )
      .bind(slug, blueprint.textFields.heroHeadline, payload.json, nowMs, nowMs)
      .run();
    return Number(insertRes.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

function buildFallbackResponse(params: {
  readonly fallbackReason: OnboardingAiDraftFallbackReason;
  readonly message: string;
  readonly plainBlueprint: OnboardingBlueprintDraft;
  readonly quota: AiWritingQuotaStatus | null;
  readonly requestId: string;
  readonly strippedFactKeys?: readonly string[];
}): Response {
  return onboardingJsonResponse(200, {
    success: true,
    status: "fallback",
    skipped: false,
    fallback: true,
    fallbackReason: params.fallbackReason,
    message: params.message,
    applied: false,
    published: false,
    autoPublished: false,
    draftMarker: ONBOARDING_AI_DRAFT_MARKER,
    factCheckReminder: ONBOARDING_AI_DRAFT_FACT_NOTICE_ID,
    strippedFactKeys: params.strippedFactKeys ?? [],
    quota: params.quota,
    blueprint: params.plainBlueprint,
    draft: null,
    persistedAsDraft: false,
    requestId: params.requestId,
  });
}

export async function handleOnboardingAiDraftRequest(
  request: Request,
  runtimeEnv: OnboardingRuntimeEnv,
  options: OnboardingApiOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();
  const nowMs = options.nowMs ?? Date.now();

  // 1. Platform `app` host + CSRF/Origin guard
  const host = resolveOnboardingAppHost(request, runtimeEnv);
  if (!host.ok) return host.response;

  if (request.method.toUpperCase() !== "POST") {
    return onboardingJsonResponse(
      405,
      {
        success: false,
        code: "METHOD_NOT_ALLOWED",
        message: "Metode HTTP tidak diizinkan.",
        requestId,
      },
      { Allow: "POST" },
    );
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return onboardingJsonResponse(503, {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan basis data platform sementara tidak tersedia.",
      requestId,
    });
  }

  // 2. Authentication (cookie session or verified injected user)
  let actorUserId = options.authenticatedUser?.id ?? null;
  if (!actorUserId) {
    const authCheck = await resolveAuthenticatedOnboardingSession(
      request,
      runtimeEnv,
      host,
      options,
    );
    if (!authCheck.ok) return authCheck.response;
    actorUserId = authCheck.session?.userId ?? null;
  }

  if (!actorUserId) {
    return onboardingJsonResponse(401, {
      success: false,
      code: "UNAUTHENTICATED",
      message: "Silakan masuk terlebih dahulu untuk membuat draf onboarding.",
      requestId,
    });
  }

  // 3. Strict Content-Type & bounded JSON body parsing (16 KiB max)
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return onboardingJsonResponse(415, {
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Content-Type harus application/json.",
      requestId,
    });
  }

  const bounded = await readBoundedRequestBody(request, AI_WRITING_MAX_BODY_BYTES);
  if (!bounded.ok) {
    if (bounded.reason === "too_large") {
      return onboardingJsonResponse(413, {
        success: false,
        code: "PAYLOAD_TOO_LARGE",
        message: "Ukuran permintaan melebihi batas maksimal 16 KiB.",
        requestId,
      });
    }
    return onboardingJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Body permintaan tidak dapat dibaca.",
      requestId,
    });
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(bounded.text);
  } catch {
    return onboardingJsonResponse(400, {
      success: false,
      code: "BAD_REQUEST",
      message: "Format JSON permintaan tidak valid.",
      requestId,
    });
  }

  const validated = onboardingAiDraftRequestSchema.safeParse(rawJson);
  if (!validated.success) {
    return onboardingJsonResponse(422, {
      success: false,
      code: "VALIDATION_ERROR",
      message: validated.error.issues[0]?.message ?? "Input permintaan draf AI tidak valid.",
      fields: validated.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        message: issue.message,
      })),
      requestId,
    });
  }

  const input = validated.data;
  const platformDb = runtimeEnv.PLATFORM_DB;

  // 4. Strict Tenant Ownership, RBAC (`content:write`), & Live Entitlement Check
  const cleanSelector = input.tenantId.trim();
  let member: AuthorizedTenantMember;
  try {
    const isUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(cleanSelector);
    member = await resolveAuthorizedTenantMember(platformDb, {
      userId: actorUserId,
      ...(isUlid ? { tenantId: cleanSelector } : { handle: cleanSelector.toLowerCase() }),
      surface: "app",
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return onboardingJsonResponse(err.status, {
        success: false,
        code: err.code,
        message: err.message,
        requestId,
      });
    }
    return onboardingJsonResponse(404, {
      success: false,
      code: "NOT_FOUND",
      message: "Situs tidak ditemukan.",
      requestId,
    });
  }

  const entitlement = await loadLiveTenantEntitlement(
    platformDb,
    { tenantId: member.tenantId },
    { nowMs },
  );
  if (!entitlement) {
    return onboardingJsonResponse(404, {
      success: false,
      code: "NOT_FOUND",
      message: "Situs tidak ditemukan.",
      requestId,
    });
  }

  const effectiveStatus = entitlement.evaluation.effectiveStatus;
  const storedStatus = entitlement.evaluation.storedStatus;
  if (
    effectiveStatus === "purged" ||
    storedStatus === "purged" ||
    effectiveStatus === "purging" ||
    storedStatus === "purging"
  ) {
    return onboardingJsonResponse(404, {
      success: false,
      code: "NOT_FOUND",
      message: "Situs tidak ditemukan.",
      requestId,
    });
  }

  if (!canPerform(member.role, "content:write")) {
    return onboardingJsonResponse(403, {
      success: false,
      code: "FORBIDDEN",
      message: "Peran akun Anda tidak memiliki izin untuk membuat draf situs ini.",
      requestId,
    });
  }

  if (
    entitlement.evaluation.operatorHold ||
    effectiveStatus === "suspended" ||
    effectiveStatus === "recovery" ||
    effectiveStatus === "locked"
  ) {
    return onboardingJsonResponse(403, {
      success: false,
      code: "SUBSCRIPTION_LOCKED",
      message:
        "Draf AI hanya tersedia untuk situs yang sedang aktif atau dalam masa uji coba.",
      requestId,
    });
  }

  const statusActionCheck = isActionAllowedForTenantStatus(effectiveStatus, "content:write");
  if (!statusActionCheck.allowed) {
    return onboardingJsonResponse(statusActionCheck.status, {
      success: false,
      code: statusActionCheck.code,
      message: "Status langganan situs saat ini tidak mengizinkan pembuatan draf AI.",
      requestId,
    });
  }

  const authoritativeVertical =
    (await loadTenantVertical(platformDb, member.tenantId)) ?? input.vertical;
  const blueprintId =
    input.blueprintId ?? resolveDefaultBlueprintForVertical(authoritativeVertical);
  const answers = {
    businessName: input.businessName,
    vertical: authoritativeVertical,
    blueprintId,
    shortDescription: input.shortDescription,
  } as const;

  // Always build the clean, fact-free plain blueprint first (for skip & fallback paths)
  const plainBlueprint = buildPlainOnboardingBlueprint(answers);
  const quotaLimit = options.quotaLimit ?? AI_WRITING_QUOTA_LIMIT;

  // 5. Explicit Skip Path — leaves blueprint completely unchanged & consumes ZERO quota
  if (input.action === "skip") {
    const currentQuota = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
      nowMs,
      limit: quotaLimit,
    }).catch(() => null);

    return onboardingJsonResponse(200, {
      success: true,
      status: "skipped",
      skipped: true,
      fallback: false,
      fallbackReason: null,
      message:
        "Langkah draf AI dilewati. Blueprint standar Anda siap digunakan tanpa perubahan.",
      applied: false,
      published: false,
      autoPublished: false,
      draftMarker: ONBOARDING_AI_DRAFT_MARKER,
      factCheckReminder: ONBOARDING_AI_DRAFT_FACT_NOTICE_ID,
      strippedFactKeys: [],
      quota: currentQuota,
      blueprint: plainBlueprint,
      draft: null,
      persistedAsDraft: false,
      requestId,
    });
  }

  // 6. Provider Configured Gate — graceful fallback when AI provider is unconfigured
  if (!isOnboardingAiProviderConfigured(runtimeEnv, options.providerPort)) {
    return buildFallbackResponse({
      fallbackReason: "AI_PROVIDER_UNCONFIGURED",
      message:
        "Layanan draf AI belum diaktifkan pada server ini. Blueprint standar Anda tetap siap digunakan tanpa hambatan.",
      plainBlueprint,
      quota: null,
      requestId,
    });
  }

  // 7. Burst rate limit (reusing TASK-074)
  try {
    const burst = await consumeAiWritingBurstLimit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      nowMs,
      policy: options.burstPolicy,
    });
    if (!burst.allowed) {
      const currentQuota = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
        nowMs,
        limit: quotaLimit,
      }).catch(() => null);
      return buildFallbackResponse({
        fallbackReason: "AI_RATE_LIMITED",
        message: `${burst.message} Blueprint standar Anda tetap siap digunakan.`,
        plainBlueprint,
        quota: currentQuota,
        requestId,
      });
    }
  } catch {
    return buildFallbackResponse({
      fallbackReason: "AI_PROVIDER_ERROR",
      message:
        "Layanan draf AI sedang sibuk. Blueprint standar Anda tetap siap digunakan tanpa hambatan.",
      plainBlueprint,
      quota: null,
      requestId,
    });
  }

  // 8. Pre-send PII Blocker (reusing TASK-074) — runs BEFORE quota reservation & provider call
  const piiCheck = detectPiiInOnboardingAnswers(answers);
  if (piiCheck.blocked) {
    const piiMessage = formatPiiBlockedMessageId(piiCheck.detectedKinds);
    await recordAiWritingAudit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      actorRole: member.role,
      targetId: createAiUsageId(),
      outcome: "denied",
      requestId,
      reason: "AI_PII_DETECTED",
      metadata: {
        fieldKind: "offering_description",
        vertical: authoritativeVertical,
        tone: "profesional",
        selectedFieldKeys: answers.shortDescription
          ? ["title", "category", "summary"]
          : ["title", "category"],
        status: "blocked_pii",
        errorCode: "AI_PII_DETECTED",
        piiKindsDetected: piiCheck.detectedKinds,
      },
      nowMs,
    }).catch(() => undefined);

    return onboardingJsonResponse(422, {
      success: false,
      code: "AI_PII_DETECTED",
      message: piiMessage,
      detectedKinds: piiCheck.detectedKinds,
      findings: piiCheck.findings,
      fallbackBlueprint: plainBlueprint,
      requestId,
    });
  }

  // 9. Atomic DEC-028 30-Day Monthly AI Quota Reservation (reusing TASK-074)
  const usageId = createAiUsageId();
  let reservation;
  try {
    reservation = await reserveAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      fieldKind: "offering_description",
      vertical: authoritativeVertical,
      requestId,
      usageId,
      nowMs,
      limit: quotaLimit,
    });
  } catch {
    return buildFallbackResponse({
      fallbackReason: "AI_PROVIDER_ERROR",
      message:
        "Gagal memeriksa kuota AI sementara. Blueprint standar Anda tetap siap digunakan tanpa hambatan.",
      plainBlueprint,
      quota: null,
      requestId,
    });
  }

  if (!reservation.allowed) {
    await recordAiWritingAudit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      actorRole: member.role,
      targetId: usageId,
      outcome: "denied",
      requestId,
      reason: "AI_QUOTA_EXCEEDED",
      metadata: {
        fieldKind: "offering_description",
        vertical: authoritativeVertical,
        tone: "profesional",
        selectedFieldKeys: answers.shortDescription
          ? ["title", "category", "summary"]
          : ["title", "category"],
        status: "quota_exceeded",
        errorCode: "AI_QUOTA_EXCEEDED",
        quotaUsed: reservation.quota.used,
        quotaLimit: reservation.quota.limit,
        quotaRemaining: 0,
      },
      nowMs,
    }).catch(() => undefined);

    return buildFallbackResponse({
      fallbackReason: "AI_QUOTA_EXCEEDED",
      message: `${reservation.message} Lanjutkan dengan blueprint standar Anda tanpa hambatan.`,
      plainBlueprint,
      quota: reservation.quota,
      requestId,
    });
  }

  // 10. Resolve AI provider port & call with strictly minimized 3 onboarding answers
  const providerPort =
    options.providerPort ??
    createCloudflareWorkersAiPort({
      ai: runtimeEnv.AI!,
      model: runtimeEnv.AI_WRITING_MODEL,
      gatewayId: runtimeEnv.AI_WRITING_GATEWAY_ID,
    });

  const providerRequest = buildOnboardingAiDraftProviderRequest(answers, {
    gatewayId: runtimeEnv.AI_WRITING_GATEWAY_ID,
  });

  const callStartedAt = nowMs;
  let providerResult: Awaited<ReturnType<typeof providerPort.generateSuggestion>>;
  try {
    providerResult = await providerPort.generateSuggestion(providerRequest);
  } catch (err) {
    const providerErr =
      err instanceof AiWritingProviderError
        ? err
        : new AiWritingProviderError(
            "AI_PROVIDER_ERROR",
            "Layanan draf AI sedang mengalami gangguan sementara.",
            502,
          );

    const latencyMs = Math.max(0, (options.nowMs ?? Date.now()) - callStartedAt);

    await releaseAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      usageId: reservation.usageId,
      errorCode: providerErr.code,
      latencyMs,
      nowMs,
    }).catch(() => undefined);

    const quotaAfterRefund = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
      nowMs,
      limit: quotaLimit,
    }).catch(() => reservation.quota);

    await recordAiWritingAudit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      actorRole: member.role,
      targetId: reservation.usageId,
      outcome: "error",
      requestId,
      reason: providerErr.code,
      metadata: {
        fieldKind: "offering_description",
        vertical: authoritativeVertical,
        tone: "profesional",
        selectedFieldKeys: providerRequest.selectedFieldKeys,
        status: "provider_error",
        errorCode: providerErr.code,
        latencyMs,
        quotaUsed: quotaAfterRefund.used,
        quotaLimit: quotaAfterRefund.limit,
        quotaRemaining: quotaAfterRefund.remaining,
      },
      nowMs,
    }).catch(() => undefined);

    return buildFallbackResponse({
      fallbackReason: providerErr.code,
      message:
        providerErr.code === "AI_PROVIDER_TIMEOUT"
          ? "Permintaan draf AI melebihi batas waktu. Kuota tidak terpotong dan blueprint standar Anda tetap siap digunakan."
          : "Layanan draf AI sedang mengalami gangguan. Kuota tidak terpotong dan blueprint standar Anda tetap siap digunakan.",
      plainBlueprint,
      quota: quotaAfterRefund,
      requestId,
    });
  }

  const parsed = parseAndSanitizeOnboardingAiDraftOutput(providerResult.suggestion);

  if (!parsed.ok) {
    const latencyMs = Math.max(0, (options.nowMs ?? Date.now()) - callStartedAt);
    await releaseAiWritingQuotaSlot(platformDb, {
      tenantId: member.tenantId,
      usageId: reservation.usageId,
      errorCode: "AI_INVALID_OUTPUT",
      model: providerResult.model,
      latencyMs,
      nowMs,
    }).catch(() => undefined);

    const quotaAfterRefund = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
      nowMs,
      limit: quotaLimit,
    }).catch(() => reservation.quota);

    await recordAiWritingAudit(platformDb, {
      tenantId: member.tenantId,
      actorUserId: member.userId,
      actorRole: member.role,
      targetId: reservation.usageId,
      outcome: "error",
      requestId,
      reason: "AI_INVALID_OUTPUT",
      metadata: {
        fieldKind: "offering_description",
        vertical: authoritativeVertical,
        tone: "profesional",
        selectedFieldKeys: providerRequest.selectedFieldKeys,
        status: "provider_error",
        model: providerResult.model,
        errorCode: "AI_INVALID_OUTPUT",
        latencyMs,
        quotaUsed: quotaAfterRefund.used,
        quotaLimit: quotaAfterRefund.limit,
        quotaRemaining: quotaAfterRefund.remaining,
      },
      nowMs,
    }).catch(() => undefined);

    return buildFallbackResponse({
      fallbackReason: "AI_INVALID_OUTPUT",
      message:
        "Hasil draf AI tidak memenuhi standar teks aman. Kuota Anda tidak terpotong dan blueprint standar tetap siap digunakan.",
      plainBlueprint,
      quota: quotaAfterRefund,
      strippedFactKeys: parsed.strippedFactKeys,
      requestId,
    });
  }

  // 11. Apply sanitized CONTOH text fields to blueprint (facts stay strictly empty/untouched)
  const draftedBlueprint = applyOnboardingAiDraftToBlueprint(plainBlueprint, parsed);

  const latencyMs =
    typeof providerResult.latencyMs === "number" && Number.isFinite(providerResult.latencyMs)
      ? Math.max(0, Math.round(providerResult.latencyMs))
      : Math.max(0, (options.nowMs ?? Date.now()) - callStartedAt);

  // 12. Commit quota slot; post-commit operations are isolated so they NEVER trigger a
  //     misleading "Kuota tidak terpotong" fallback after quota has already been committed.
  await commitAiWritingQuotaSlot(platformDb, {
    tenantId: member.tenantId,
    usageId: reservation.usageId,
    model: providerResult.model,
    tokenCount: providerResult.tokenCount,
    latencyMs,
    nowMs,
  }).catch(() => undefined);

  const latestQuota = await getAiWritingQuotaStatus(platformDb, member.tenantId, {
    nowMs,
    limit: quotaLimit,
  }).catch(() => reservation.quota);

  await recordAiWritingAudit(platformDb, {
    tenantId: member.tenantId,
    actorUserId: member.userId,
    actorRole: member.role,
    targetId: reservation.usageId,
    outcome: "success",
    requestId,
    metadata: {
      fieldKind: "offering_description",
      vertical: authoritativeVertical,
      tone: "profesional",
      selectedFieldKeys: providerRequest.selectedFieldKeys,
      status: "succeeded",
      model: providerResult.model,
      tokenCount: providerResult.tokenCount,
      latencyMs,
      quotaUsed: latestQuota.used,
      quotaLimit: latestQuota.limit,
      quotaRemaining: latestQuota.remaining,
    },
    nowMs,
  }).catch(() => undefined);

  const tenantStore =
    options.tenantStore !== undefined ? options.tenantStore : (runtimeEnv.TENANT_STORE ?? null);
  const persistedAsDraft = await persistOnboardingDraftBestEffort(
    tenantStore,
    member.tenantId,
    draftedBlueprint,
    nowMs,
  ).catch(() => false);

  const successMessage = persistedAsDraft
    ? "Draf teks CONTOH berhasil disiapkan dan disimpan sebagai draf beranda (belum diterbitkan). Periksa dan lengkapi fakta usaha (harga, izin, WhatsApp, alamat) di dashboard sebelum menerbitkan."
    : "Draf teks CONTOH berhasil disiapkan sebagai pratinjau (belum diterbitkan). Konten beranda yang sudah ada tetap aman dan tidak ditimpa.";

  return onboardingJsonResponse(200, {
    success: true,
    status: "generated",
    skipped: false,
    fallback: false,
    fallbackReason: null,
    message: successMessage,
    applied: true,
    published: false,
    autoPublished: false,
    draftMarker: ONBOARDING_AI_DRAFT_MARKER,
    factCheckReminder: ONBOARDING_AI_DRAFT_FACT_NOTICE_ID,
    strippedFactKeys: parsed.strippedFactKeys,
    quota: latestQuota,
    blueprint: draftedBlueprint,
    draft: draftedBlueprint.textFields,
    persistedAsDraft,
    requestId,
  });
}
