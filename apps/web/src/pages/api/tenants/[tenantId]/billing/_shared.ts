import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import {
  BillingConflictError,
  BillingNotFoundError,
  BillingProviderError,
  BillingValidationError,
  FORBIDDEN_BILLING_BODY_KEYS,
  classifyAllowedChannel,
  computeBillingRequestHash,
  type BillingPlanInterval,
} from "@punyasitus/core/billing/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  UuidSchema,
  type ApiErrorCode,
} from "@punyasitus/core/schemas";
import {
  beginDurablePaymentAttempt,
  completePaymentAttemptPending,
  ensureBillingObligationsSchema,
  getTenantObligationById,
  loadPlatformBillingPricing,
  loadTenantBillingContext,
  loadUserContactForBilling,
  markPaymentAttemptDefiniteFailure,
  markPaymentAttemptReview,
  markPaymentAttemptUncertain,
  type BillingObligationRecord,
  type PaymentAttemptRecord,
} from "@punyasitus/db/billing/index";
import {
  createAutoLarisClient,
  type AutoLarisBillingClient,
} from "../../../../../../../../packages/integrations/src/autolaris/index.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, owner-only RBAC, host-isolation, strict JSON parsing,
 * AutoLaris relay wiring, and durable obligation/attempt orchestration for
 * `/api/tenants/:tenantId/billing/**` (TASK-055; REQ-056, PLAN §16 & §17).
 */

export const MAX_BILLING_BODY_BYTES = 16_384 as const; // 16 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_BILLING_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_BILLING_BODY_KEYS);

export const PRIVATE_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantBillingRuntimeEnv extends AuthRuntimeEnv {
  readonly AUTOLARIS_RELAY_URL?: string;
  readonly AUTOLARIS_API_KEY?: string;
  readonly AUTOLARIS_ACCOUNT_ID?: string;
}

export interface TenantBillingHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  /** Optional synthetic/mocked AutoLaris client for tests. */
  readonly autolarisClient?: AutoLarisBillingClient | null;
  /** Optional injectable `fetch` transport for AutoLaris relay client in tests. */
  readonly autolarisFetch?: typeof fetch;
  /** Optional hook executed after provider submit returns but before DB persistence (for crash testing). */
  readonly onBeforePersistProviderResult?: (ctx: {
    readonly attemptId: string;
    readonly obligationId: string;
    readonly providerTransactionId: string;
  }) => Promise<void> | void;
}

export interface AuthorizedBillingRequestContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly payerType: "tenant" | "agency";
  readonly payerAgencyId: string | null;
}

export function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function billingJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function billingErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return billingJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      requestId,
    },
    extraHeaders,
  );
}

export function formatObligationSummary(record: BillingObligationRecord): Record<string, unknown> {
  return {
    obligationId: record.id,
    plan: record.plan,
    payerKind: record.payerType,
    state: record.state,
    baseAmountIdr: record.baseAmountIdr,
    discountAmountIdr: record.discountAmountIdr,
    netAmountIdr: record.netAmountIdr,
    currency: record.currency,
    periodStartAt: record.periodStartAtIso,
    periodEndAt: record.periodEndAtIso,
    version: record.version,
    createdAt: record.createdAtIso,
  };
}

export function formatAttemptInstruction(attempt: PaymentAttemptRecord): Record<string, unknown> {
  return {
    attemptId: attempt.id,
    obligationId: attempt.obligationId,
    reffId: attempt.reffId,
    plan: attempt.plan,
    channelKind: attempt.channelKind,
    channelCode: attempt.channelCode,
    state: attempt.state,
    baseAmountIdr: attempt.baseAmountIdr,
    discountAmountIdr: attempt.discountAmountIdr,
    channelFeeIdr: attempt.channelFeeIdr,
    totalPayableIdr: attempt.totalPayableIdr,
    currency: attempt.currency,
    taxNotice: attempt.taxNotice,
    qrisPayload: attempt.qrisPayload,
    vaNumber: attempt.vaNumber,
    bankName: attempt.bankName,
    paymentRedirectUrl: attempt.paymentRedirectUrl,
    expiresAt: attempt.expiresAtIso,
    createdAt: attempt.createdAtIso,
  };
}

/**
 * Resolves the server-side AutoLaris static-IP relay client from options or runtime env.
 * Fails closed with `BillingProviderError("relay_config_error", ...)` when unconfigured.
 */
export function resolveAutoLarisClient(
  runtimeEnv: TenantBillingRuntimeEnv,
  options: TenantBillingHandlerOptions = {},
): AutoLarisBillingClient {
  if (options.autolarisClient) {
    return options.autolarisClient;
  }
  const relayBaseUrl = runtimeEnv.AUTOLARIS_RELAY_URL?.trim() ?? "";
  const apiKey = runtimeEnv.AUTOLARIS_API_KEY?.trim() ?? "";
  if (!relayBaseUrl || !apiKey) {
    throw new BillingProviderError(
      "relay_config_error",
      "AUTOLARIS_NOT_CONFIGURED",
      "Integrasi AutoLaris belum dikonfigurasi pada server ini.",
    );
  }
  return createAutoLarisClient({
    relayBaseUrl,
    apiKey,
    providerAccountId: runtimeEnv.AUTOLARIS_ACCOUNT_ID,
    fetchImpl: options.autolarisFetch,
  });
}

/**
 * Enforces:
 * 1. Platform `app` host isolation (returns neutral `404` on tenant/marketing/console hosts).
 * 2. Admin CSRF & Origin check on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership & OWNER-ONLY billing authorization (`billing:read` / `billing:pay`):
 *    - Editor / Admin -> `403 FORBIDDEN`
 *    - Cross-tenant / non-member / unknown tenant -> neutral `404 NOT_FOUND`
 *    - Locked / suspended owner -> ALLOWED so owner can pay to unlock service!
 *    - Agency-managed tenant -> non-agency tenant members denied with `403 FORBIDDEN` (PLAN §17.2).
 */
export async function authorizeTenantBillingRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantBillingRuntimeEnv,
  requiredPermission: Extract<PermissionAction, "billing:read" | "billing:pay">,
  options: TenantBillingHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedBillingRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Platform app host only
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: billingErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement on state-changing requests
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: billingErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: billingErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // 4. Session verification + lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: billingErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          undefined,
          { "Retry-After": "60" },
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
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionResult.session.id,
          userId: sessionResult.user.id,
          surface: "app",
          pathname,
          nowMs,
        });
        if (lifetime.valid) {
          userId = sessionResult.user.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: billingErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengakses tagihan langganan.",
        requestId,
      ),
    };
  }

  // 5. Live membership + OWNER-ONLY RBAC check (locked/suspended allowed for billing:read & billing:pay)
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: billingErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: billingErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: billingErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  const tenantCtx = await loadTenantBillingContext(runtimeEnv.PLATFORM_DB, member.tenantId);
  if (!tenantCtx) {
    return {
      ok: false,
      response: billingErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  // Agency-managed sites: agency is sole payer; client tenant members cannot access billing APIs (PLAN §17.2)
  if (tenantCtx.agencyId !== null && member.dbRole !== "agency_staff") {
    return {
      ok: false,
      response: billingErrorResponse(
        403,
        "FORBIDDEN",
        "Tagihan langganan situs ini dikelola oleh agensi.",
        requestId,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      nowMs,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      payerType: tenantCtx.agencyId !== null ? "agency" : "tenant",
      payerAgencyId: tenantCtx.agencyId,
    },
  };
}

function findNestedForbiddenBillingKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenBillingKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_BILLING_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findNestedForbiddenBillingKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictBillingJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_BILLING_BODY_BYTES) {
    return {
      ok: false,
      response: billingErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_BILLING_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    return {
      ok: false,
      response: billingErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: billingErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: billingErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_BILLING_PAYLOAD", message: "Expected a JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenBillingKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: billingErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenPath}" tidak diizinkan dalam permintaan pembayaran.`,
        requestId,
        [
          {
            field: forbiddenPath,
            code: "FORBIDDEN_BILLING_FIELD",
            message: `Client-supplied field "${forbiddenPath}" is forbidden in billing requests.`,
          },
        ],
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: billingErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [
            {
              field: key,
              code: "UNKNOWN_FIELD",
              message: `Unknown field "${key}" is not allowed.`,
            },
          ],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export function extractValidatedIdempotencyKey(
  request: Request,
  bodyKey: unknown,
  requestId: string,
  options: { readonly allowBodyFallback?: boolean } = {},
):
  | { readonly ok: true; readonly idempotencyKey: string }
  | { readonly ok: false; readonly response: Response } {
  const headerRaw = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyRaw = typeof bodyKey === "string" ? bodyKey.trim() : "";

  if (headerRaw && bodyRaw && headerRaw !== bodyRaw) {
    return {
      ok: false,
      response: billingErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key tidak cocok dengan idempotencyKey pada body.",
        requestId,
        [
          {
            field: "idempotencyKey",
            code: "IDEMPOTENCY_KEY_MISMATCH",
            message: "Idempotency-Key header and body value must match.",
          },
        ],
      ),
    };
  }

  const candidate = headerRaw || (options.allowBodyFallback ? bodyRaw : "");
  const parsed = UuidSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      response: billingErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key berupa UUID yang valid wajib disertakan.",
        requestId,
        [
          {
            field: "Idempotency-Key",
            code: "INVALID_IDEMPOTENCY_KEY",
            message: "A valid RFC 4122 UUID Idempotency-Key header is required.",
          },
        ],
      ),
    };
  }

  return { ok: true, idempotencyKey: parsed.data };
}

export interface CreateBillingInstructionResult {
  readonly status: 200 | 201;
  readonly replayed: boolean;
  readonly obligation: BillingObligationRecord;
  readonly attempt: PaymentAttemptRecord;
}

/**
 * Shared durable creation orchestrator used by both:
 * - `POST /api/tenants/:tenantId/billing/obligations`
 * - `POST /api/tenants/:tenantId/billing/attempts`
 *
 * Strictly enforces:
 * 1. Server-owned plan price & calendar-period snapshot.
 * 2. Runtime QRIS & Bank Virtual Account channel validation against AutoLaris `list_payment`.
 * 3. Pre-call durable persistence of obligation + attempt (`creating`, `reff_id`, `idempotency_key`, `request_hash`).
 * 4. Atomic post-call persistence of `provider_transaction_id` + instructions + redacted audit row.
 * 5. Safe `creation_unknown` transition on timeout/network/5xx/crash before persistence (blocking blind retry).
 * 6. Safe `review` transition on invalid provider fees/payloads after `rc === "00"` (never marking paid).
 */
export async function createDurableBillingObligationAndInstruction(
  ctx: AuthorizedBillingRequestContext,
  runtimeEnv: TenantBillingRuntimeEnv,
  input: {
    readonly plan: unknown;
    readonly channelCode: unknown;
    readonly channelKind?: unknown;
    readonly couponCode?: unknown;
    readonly idempotencyKey: string;
  },
  options: TenantBillingHandlerOptions = {},
): Promise<CreateBillingInstructionResult> {
  // 1. Strict plan validation
  if (input.plan !== "monthly" && input.plan !== "yearly") {
    throw new BillingValidationError(
      "INVALID_PLAN",
      'Paket langganan harus "monthly" atau "yearly".',
      [{ field: "plan", code: "INVALID_PLAN", message: 'Expected "monthly" or "yearly".' }],
    );
  }
  const plan: BillingPlanInterval = input.plan;

  // 2. Strict runtime QRIS / Bank VA channel validation (rejects COD, retail, e-wallet)
  if (typeof input.channelCode !== "string" || input.channelCode.trim().length === 0) {
    throw new BillingValidationError(
      "INVALID_CHANNEL_CODE",
      "Kode channel pembayaran wajib diisi.",
      [{ field: "channelCode", code: "INVALID_CHANNEL_CODE", message: "channelCode is required." }],
    );
  }
  const classified = classifyAllowedChannel(input.channelCode);
  if (!classified.ok) {
    throw new BillingValidationError(classified.code, classified.reason, [
      { field: "channelCode", code: classified.code, message: classified.reason },
    ]);
  }
  if (input.channelKind !== undefined) {
    if (input.channelKind !== "QRIS" && input.channelKind !== "VA") {
      throw new BillingValidationError(
        "UNSUPPORTED_CHANNEL_KIND",
        'channelKind hanya mendukung "QRIS" atau "VA".',
        [
          {
            field: "channelKind",
            code: "UNSUPPORTED_CHANNEL_KIND",
            message: 'Only "QRIS" and "VA" channel kinds are permitted.',
          },
        ],
      );
    }
    if (input.channelKind !== classified.kind) {
      throw new BillingValidationError(
        "CHANNEL_KIND_MISMATCH",
        `channelKind "${input.channelKind}" tidak cocok dengan channel "${classified.normalizedCode}".`,
        [
          {
            field: "channelKind",
            code: "CHANNEL_KIND_MISMATCH",
            message: `Expected "${classified.kind}" for channel "${classified.normalizedCode}".`,
          },
        ],
      );
    }
  }

  // Coupon engine arrives in TASK-082; reject unverified coupon codes safely in TASK-055
  if (input.couponCode !== undefined) {
    if (typeof input.couponCode !== "string" || !/^[A-Z0-9_-]{2,40}$/.test(input.couponCode.trim())) {
      throw new BillingValidationError(
        "INVALID_COUPON_CODE",
        "Format kode kupon tidak valid.",
        [{ field: "couponCode", code: "INVALID_COUPON_CODE", message: "Invalid coupon code format." }],
      );
    }
    throw new BillingValidationError(
      "COUPON_NOT_FOUND",
      "Kode kupon tidak ditemukan atau tidak aktif.",
      [{ field: "couponCode", code: "COUPON_NOT_FOUND", message: "Coupon is not active." }],
    );
  }
  const normalizedCoupon: string | null = null;

  await ensureBillingObligationsSchema(ctx.platformDb, () => ctx.nowMs);

  const requestHash = await computeBillingRequestHash({
    tenantId: ctx.member.tenantId,
    plan,
    channelKind: classified.kind,
    channelCode: classified.normalizedCode,
    couponCode: normalizedCoupon,
  });

  // 3. Fast-path idempotency / existing-key check BEFORE making any outbound AutoLaris HTTP call
  const existingKeyRow = await ctx.platformDb
    .prepare(
      `SELECT id, obligation_id, request_hash, lifecycle_state
       FROM payment_attempts
       WHERE tenant_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(ctx.member.tenantId, input.idempotencyKey)
    .first<{
      readonly id: string;
      readonly obligation_id: string;
      readonly request_hash: string | null;
      readonly lifecycle_state: string | null;
    }>();

  if (existingKeyRow) {
    if (existingKeyRow.request_hash !== requestHash) {
      throw new BillingConflictError(
        "IDEMPOTENCY_CONFLICT",
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "Idempotency-Key sudah digunakan untuk permintaan pembayaran dengan payload berbeda.",
      );
    }
    if (existingKeyRow.lifecycle_state === "pending" || existingKeyRow.lifecycle_state === "paid") {
      const detail = await getTenantObligationById(
        ctx.platformDb,
        ctx.member.tenantId,
        existingKeyRow.obligation_id,
      );
      if (detail?.latestAttempt) {
        return {
          status: 200,
          replayed: true,
          obligation: detail.obligation,
          attempt: detail.latestAttempt,
        };
      }
    }
    if (
      existingKeyRow.lifecycle_state === "creation_unknown" ||
      existingKeyRow.lifecycle_state === "review"
    ) {
      throw new BillingConflictError(
        "CONFLICT",
        "RECONCILIATION_REQUIRED",
        "Percobaan pembayaran sebelumnya berada dalam status rekonsiliasi; pembuatan tagihan ganda diblokir.",
      );
    }
    if (existingKeyRow.lifecycle_state === "creating") {
      throw new BillingConflictError(
        "CONFLICT",
        "PAYMENT_CREATION_IN_PROGRESS",
        "Pembuatan instruksi pembayaran sedang diproses; silakan tunggu sebelum mengulang.",
      );
    }
    throw new BillingConflictError(
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_KEY_EXHAUSTED",
      "Percobaan pembayaran sebelumnya sudah ditutup; gunakan Idempotency-Key baru.",
    );
  }

  // 4. Fast-path unresolved attempt guard (prevents unnecessary AutoLaris list_payment calls when blocked)
  const existingUnresolved = await ctx.platformDb
    .prepare(
      `SELECT pa.lifecycle_state
       FROM payment_attempts pa
       INNER JOIN billing_obligations bo ON bo.id = pa.obligation_id
       WHERE pa.tenant_id = ?
         AND bo.status = 'open'
         AND pa.lifecycle_state IN ('creating', 'creation_unknown', 'pending', 'review')
       LIMIT 1`,
    )
    .bind(ctx.member.tenantId)
    .first<{ readonly lifecycle_state: string }>();

  if (existingUnresolved) {
    const isReconcile =
      existingUnresolved.lifecycle_state === "creation_unknown" ||
      existingUnresolved.lifecycle_state === "review";
    throw new BillingConflictError(
      "CONFLICT",
      isReconcile ? "RECONCILIATION_REQUIRED" : "ACTIVE_ATTEMPT_EXISTS",
      isReconcile
        ? "Tagihan aktif memiliki percobaan yang memerlukan rekonsiliasi sebelum percobaan baru."
        : "Tagihan aktif sudah memiliki instruksi pembayaran yang belum selesai.",
    );
  }

  // 5. Resolve server-configured AutoLaris static-IP relay client & revalidate channel at runtime
  const autolaris = resolveAutoLarisClient(runtimeEnv, options);
  const pricing = await loadPlatformBillingPricing(ctx.platformDb);
  const planBaseAmountIdr = plan === "yearly" ? pricing.yearlyPriceIdr : pricing.monthlyPriceIdr;

  const enabledChannels = await autolaris.listPaymentChannels(planBaseAmountIdr);
  const matchedChannel = enabledChannels.find((ch) => ch.code === classified.normalizedCode);
  if (!matchedChannel) {
    throw new BillingValidationError(
      "CHANNEL_NOT_ENABLED",
      `Channel pembayaran "${classified.normalizedCode}" tidak aktif pada akun AutoLaris saat ini.`,
      [
        {
          field: "channelCode",
          code: "CHANNEL_NOT_ENABLED",
          message: `Channel "${classified.normalizedCode}" is not enabled for this account.`,
        },
      ],
    );
  }

  // 6. Durable PRE-CALL persistence (no DB transaction held across outbound network call!)
  const begun = await beginDurablePaymentAttempt(ctx.platformDb, {
    tenantId: ctx.member.tenantId,
    effectiveTenantStatus: ctx.member.tenantStatus,
    payerType: ctx.payerType,
    payerAgencyId: ctx.payerAgencyId,
    plan,
    channelKind: matchedChannel.kind,
    channelCode: matchedChannel.code,
    estimatedChannelFeeIdr: matchedChannel.estimatedFeeIdr,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    providerAccountId: autolaris.providerAccountId,
    nowMs: ctx.nowMs,
  });

  if (begun.mode === "replay") {
    return {
      status: 200,
      replayed: true,
      obligation: begun.obligation,
      attempt: begun.attempt,
    };
  }

  // 7. Call AutoLaris `/api/h2h/submit` (`courir_id: 1`, `cod_value: "0"`)
  const payerContact = await loadUserContactForBilling(ctx.platformDb, ctx.member.userId);
  try {
    const providerResult = await autolaris.submitDigitalSubscriptionOrder({
      reffId: begun.attempt.reffId,
      channelKind: matchedChannel.kind,
      channelCode: matchedChannel.code,
      plan: begun.obligation.plan,
      netAmountIdr: begun.obligation.netAmountIdr,
      tenantHandle: ctx.member.handle,
      payerName: payerContact.name,
      payerEmail: payerContact.email,
    });

    if (options.onBeforePersistProviderResult) {
      await options.onBeforePersistProviderResult({
        attemptId: begun.attempt.id,
        obligationId: begun.obligation.id,
        providerTransactionId: providerResult.providerTransactionId,
      });
    }

    const completedAttempt = await completePaymentAttemptPending(ctx.platformDb, {
      attemptId: begun.attempt.id,
      obligationId: begun.obligation.id,
      tenantId: ctx.member.tenantId,
      actorUserId: ctx.member.userId,
      actorRole: ctx.member.role,
      requestId: ctx.requestId,
      providerTransactionId: providerResult.providerTransactionId,
      channelFeeIdr: providerResult.channelFeeIdr,
      grossAdminFeeIdr: providerResult.grossAdminFeeIdr,
      providerDiscountIdr: providerResult.providerDiscountIdr,
      totalPayableIdr: providerResult.totalPayableIdr,
      qrisPayload: providerResult.qrisPayload,
      vaNumber: providerResult.vaNumber,
      bankName: providerResult.bankName ?? (matchedChannel.kind === "VA" ? matchedChannel.label : null),
      paymentRedirectUrl: providerResult.paymentRedirectUrl,
      expiresAtMs: providerResult.expiresAtMs,
      nowMs: ctx.nowMs,
    });

    return {
      status: 201,
      replayed: false,
      obligation: begun.obligation,
      attempt: completedAttempt,
    };
  } catch (err) {
    if (err instanceof BillingProviderError) {
      if (err.kind === "definite_refusal") {
        await markPaymentAttemptDefiniteFailure(ctx.platformDb, {
          attemptId: begun.attempt.id,
          obligationId: begun.obligation.id,
          tenantId: ctx.member.tenantId,
          actorUserId: ctx.member.userId,
          actorRole: ctx.member.role,
          requestId: ctx.requestId,
          safeFailureCode: err.safeFailureCode,
          nowMs: ctx.nowMs,
        });
        throw err;
      }

      if (err.kind === "invalid_provider_payload") {
        await markPaymentAttemptReview(ctx.platformDb, {
          attemptId: begun.attempt.id,
          obligationId: begun.obligation.id,
          tenantId: ctx.member.tenantId,
          actorUserId: ctx.member.userId,
          actorRole: ctx.member.role,
          requestId: ctx.requestId,
          providerTransactionId: err.providerTransactionId,
          safeFailureCode: err.safeFailureCode,
          nowMs: ctx.nowMs,
        });
        throw err;
      }

      // Uncertain timeout / network / 5xx / malformed response -> `creation_unknown` (blocks blind retry!)
      await markPaymentAttemptUncertain(ctx.platformDb, {
        attemptId: begun.attempt.id,
        obligationId: begun.obligation.id,
        tenantId: ctx.member.tenantId,
        actorUserId: ctx.member.userId,
        actorRole: ctx.member.role,
        requestId: ctx.requestId,
        safeFailureCode: err.safeFailureCode,
        nowMs: ctx.nowMs,
      });
      throw err;
    }

    // Any crash or persistence error after `/submit` was invoked -> mark `creation_unknown` safely!
    const msg = err instanceof Error ? err.message : String(err);
    const isDuplicateProviderTrx = /UNIQUE constraint failed.*provider_transaction_id/i.test(msg);
    if (isDuplicateProviderTrx) {
      await markPaymentAttemptReview(ctx.platformDb, {
        attemptId: begun.attempt.id,
        obligationId: begun.obligation.id,
        tenantId: ctx.member.tenantId,
        actorUserId: ctx.member.userId,
        actorRole: ctx.member.role,
        requestId: ctx.requestId,
        providerTransactionId: null,
        safeFailureCode: "DUPLICATE_PROVIDER_TRANSACTION_ID",
        nowMs: ctx.nowMs,
      });
      throw new BillingProviderError(
        "invalid_provider_payload",
        "DUPLICATE_PROVIDER_TRANSACTION_ID",
        "AutoLaris mengembalikan transaction_id duplikat; memerlukan tinjauan.",
      );
    }

    try {
      await markPaymentAttemptUncertain(ctx.platformDb, {
        attemptId: begun.attempt.id,
        obligationId: begun.obligation.id,
        tenantId: ctx.member.tenantId,
        actorUserId: ctx.member.userId,
        actorRole: ctx.member.role,
        requestId: ctx.requestId,
        safeFailureCode: "PROVIDER_PERSISTENCE_UNCERTAIN",
        nowMs: ctx.nowMs,
      });
    } catch {
      // Row remains durably persisted in `creating` state, which ALSO blocks duplicate creation!
    }

    throw new BillingProviderError(
      "uncertain_timeout_or_network",
      "PROVIDER_PERSISTENCE_UNCERTAIN",
      "Status penyimpanan instruksi pembayaran tidak pasti; rekonsiliasi diperlukan sebelum mencoba lagi.",
    );
  }
}

export function mapBillingDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof BillingValidationError) {
    return billingErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof BillingConflictError) {
    return billingErrorResponse(409, err.code, err.message, requestId);
  }
  if (err instanceof BillingNotFoundError) {
    return billingErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return billingErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof BillingProviderError) {
    return billingErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId, undefined, {
      "Retry-After": "30",
    });
  }
  return billingErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Layanan tagihan langganan sementara tidak tersedia.",
    requestId,
    undefined,
    { "Retry-After": "30" },
  );
}
