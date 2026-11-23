import { env } from "cloudflare:workers";
import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  getSessionSecondFactorState,
  resolveAuthorizedTenantMember,
  verifyUserPassword,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import {
  evaluateTenantApiEntitlement,
  loadLiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import { formatWibDateTimeLabel } from "@punyasitus/core/billing/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  DELETION_REAUTH_WINDOW_MS,
  signExportDownloadToken,
  type DeletionConfirmationMethod,
} from "@punyasitus/core/exports/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type {
  ExportR2BucketLike,
  TenantDeletionRequestRecord,
  TenantDeletionStatusView,
  TenantExportJobRecord,
} from "@punyasitus/db/exports/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";
import { resolveExportSigningSecret } from "../../../../../worker/queues/exports/handler.ts";

/**
 * Shared owner-only auth, step-up reauthentication/2FA, CSRF/Origin, strict JSON body parsing,
 * and response serializers for `/api/tenants/:tenantId/exports/**` and
 * `/api/tenants/:tenantId/deletion/**` (REQ-107, PLAN §20.4, TASK-107).
 */

export const MAX_OWNER_DATA_BODY_BYTES = 16_384 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HANDLE_SELECTOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

export const PRIVATE_NO_STORE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  Vary: "Cookie",
} as const;

export interface TenantOwnerDataRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly MEDIA_BUCKET?: ExportR2BucketLike | null;
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  } | null;
}

export interface TenantOwnerDataHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly signingSecret?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly authenticatedSession?: {
    readonly id: string;
    readonly createdAt?: Date | number;
  } | null;
  readonly activeOrganizationId?: string | null;
  readonly reauthenticatedAtMs?: number | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly mediaBucket?: ExportR2BucketLike | null;
  /**
   * When true and `JOBS_QUEUE` is absent, executes the export job inline after enqueueing
   * into `job_ledger` (used by local dev/E2E where no background queue consumer is attached).
   */
  readonly executeInlineWhenNoQueue?: boolean;
}

export interface AuthorizedOwnerDataContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly sessionId: string | null;
  readonly sessionCreatedAtMs: number | null;
  readonly platformDb: D1Database;
  readonly signingSecret: string;
}

export function createDataRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function dataJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_NO_STORE_JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function dataErrorResponse(
  status: number,
  code: ApiErrorCode | string,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  extraHeaders?: HeadersInit,
): Response {
  return dataJsonResponse(
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

export function buildOwnerDataRuntimeEnv(): TenantOwnerDataRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly SAAS_ZONE?: string;
    readonly MEDIA_BUCKET?: ExportR2BucketLike;
    readonly TENANT_STORE?: TenantStoreNamespaceLike;
    readonly JOBS_QUEUE?: { send(message: unknown): Promise<unknown> };
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    SAAS_ZONE: runtimeEnv.SAAS_ZONE,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    MEDIA_BUCKET: runtimeEnv.MEDIA_BUCKET ?? null,
    TENANT_STORE: runtimeEnv.TENANT_STORE ?? null,
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE ?? null,
  };
}

/**
 * Authorizes an owner-only export or deletion API request:
 * 1. Platform `app` host ONLY (`404` on tenant/marketing/console hosts).
 * 2. Strict CSRF & Origin check on state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Session authentication + lifetime ceiling (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership check (`404 NOT_FOUND` for cross-tenant / non-member / purged).
 * 5. Strictly **`owner` ONLY** (`dbRole === "owner"` AND `role === "owner"`) —
 *    `admin`, `editor`, `agency_staff`, and `setup_staff` are denied with `403 FORBIDDEN`.
 * 6. Denies `purging` with `403 SUBSCRIPTION_LOCKED`.
 */
export async function authorizeTenantOwnerDataRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantOwnerDataRuntimeEnv,
  options: TenantOwnerDataHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedOwnerDataContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createDataRequestId();

  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: dataErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: dataErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  let userId: string | null = options.authenticatedUser?.id ?? null;
  let sessionId: string | null = options.authenticatedSession?.id ?? null;
  let sessionCreatedAtMs: number | null =
    options.authenticatedSession?.createdAt !== undefined
      ? options.authenticatedSession.createdAt instanceof Date
        ? options.authenticatedSession.createdAt.getTime()
        : Math.trunc(options.authenticatedSession.createdAt)
      : null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: dataErrorResponse(
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
          nowMs: options.nowMs,
        });
        if (lifetime.valid) {
          userId = sessionResult.user.id;
          sessionId = sessionResult.session.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
          sessionCreatedAtMs =
            rawSession.createdAt instanceof Date
              ? rawSession.createdAt.getTime()
              : new Date(rawSession.createdAt).getTime();
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: dataErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengelola ekspor data dan penghapusan situs.",
        requestId,
      ),
    };
  }

  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: dataErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isHandleSelector = HANDLE_SELECTOR_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isHandleSelector ? { handle: trimmedSelector } : { tenantId: trimmedSelector }),
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: dataErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  // Strictly OWNER ONLY (denies admin, editor, agency_staff, setup_staff)
  if (member.dbRole !== "owner" || member.role !== "owner") {
    return {
      ok: false,
      response: dataErrorResponse(
        403,
        "FORBIDDEN",
        "Hanya Pemilik Situs (Owner) yang dapat mengekspor arsip situs atau menghapus situs ini.",
        requestId,
      ),
    };
  }

  // Enforce live server-side entitlement gate directly (defense-in-depth for both middleware and direct calls)
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  try {
    const entitlement = await loadLiveTenantEntitlement(
      runtimeEnv.PLATFORM_DB,
      { tenantId: member.tenantId },
      { nowMs },
    );
    if (!entitlement) {
      return {
        ok: false,
        response: dataErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
      };
    }
    const rawPathname = new URL(request.url).pathname;
    const subPathMatch = /^\/api\/tenants\/[^/]+(\/.*)?$/i.exec(rawPathname);
    const subPath = subPathMatch?.[1] ?? "/exports";
    const decision = evaluateTenantApiEntitlement({
      entitlement,
      method,
      subPath,
      role: member.role,
    });
    if (!decision.allowed) {
      return {
        ok: false,
        response: dataErrorResponse(
          decision.status === 404 ? 404 : 403,
          decision.code ?? "SUBSCRIPTION_LOCKED",
          decision.message ?? "Operasi tidak diizinkan pada status layanan situs saat ini.",
          requestId,
        ),
      };
    }
  } catch {
    return {
      ok: false,
      response: dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi status hak akses layanan situs.",
        requestId,
        undefined,
        { "Retry-After": "30" },
      ),
    };
  }

  const signingSecret = resolveExportSigningSecret(runtimeEnv, options.signingSecret);
  if (!signingSecret) {
    return {
      ok: false,
      response: dataErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Konfigurasi penandatanganan ekspor belum tersedia.",
        requestId,
        undefined,
        { "Retry-After": "60" },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member,
      sessionId,
      sessionCreatedAtMs,
      platformDb: runtimeEnv.PLATFORM_DB,
      signingSecret,
    },
  };
}

export async function parseStrictOwnerDataJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_OWNER_DATA_BODY_BYTES) {
    return {
      ok: false,
      response: dataErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_OWNER_DATA_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    if (options.allowEmptyBody) {
      return { ok: true, body: {} };
    }
    return {
      ok: false,
      response: dataErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return {
      ok: false,
      response: dataErrorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type harus application/json.",
        requestId,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: dataErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: dataErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
        [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected JSON object." }],
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEY_SET.has(key)) {
      return {
        ok: false,
        response: dataErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body permintaan.`,
          requestId,
          [
            {
              field: key,
              code: "FORBIDDEN_TENANT_SELECTOR",
              message: `Tenant selector "${key}" is forbidden.`,
            },
          ],
        ),
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: dataErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [{ field: key, code: "UNKNOWN_FIELD", message: `Unknown field "${key}".` }],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export interface OwnerAuthCapabilities {
  readonly hasPasswordAccount: boolean;
  readonly twoFactorEnabled: boolean;
  readonly recentTwoFactorVerified: boolean;
  readonly recentTwoFactorVerifiedAtMs: number | null;
}

export async function inspectOwnerAuthCapabilities(
  platformDb: D1Database,
  userId: string,
  sessionId: string | null,
  nowMs: number,
): Promise<OwnerAuthCapabilities> {
  const [userRow, credRow, tfaRow] = await Promise.all([
    platformDb
      .prepare("SELECT two_factor_enabled FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ readonly two_factor_enabled: number | null }>()
      .catch(() => null),
    platformDb
      .prepare(
        "SELECT id FROM accounts WHERE user_id = ? AND provider_id = 'credential' AND password IS NOT NULL LIMIT 1",
      )
      .bind(userId)
      .first<{ readonly id: string }>()
      .catch(() => null),
    sessionId
      ? platformDb
          .prepare(
            "SELECT verified_at, method FROM session_two_factor_verifications WHERE session_id = ? AND user_id = ? LIMIT 1",
          )
          .bind(sessionId, userId)
          .first<{ readonly verified_at: number; readonly method: "totp" | "backup_code" }>()
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const twoFactorEnabled = Number(userRow?.two_factor_enabled ?? 0) === 1;
  const recentVerifiedAt =
    tfaRow &&
    typeof tfaRow.verified_at === "number" &&
    nowMs - tfaRow.verified_at >= 0 &&
    nowMs - tfaRow.verified_at <= DELETION_REAUTH_WINDOW_MS
      ? tfaRow.verified_at
      : null;

  return {
    hasPasswordAccount: Boolean(credRow),
    twoFactorEnabled,
    recentTwoFactorVerified: recentVerifiedAt !== null,
    recentTwoFactorVerifiedAtMs: recentVerifiedAt,
  };
}

/**
 * Verifies owner step-up reauthentication or recent second factor before self-service deletion
 * (REQ-107, PLAN §20.4):
 * - When the owner has 2FA enabled (`users.two_factor_enabled = 1`), STRICTLY requires a
 *   recent Better Auth second-factor verification recorded in `session_two_factor_verifications`
 *   within 10 minutes (`getSessionSecondFactorState`). Password alone NEVER bypasses active 2FA,
 *   and encrypted `two_factors.secret` rows are never read directly.
 * - When 2FA is NOT enabled, accepts:
 *   1. Valid `currentPassword` verified against `accounts.password`, OR
 *   2. Explicit recent `reauthenticatedAtMs` within 10 minutes, OR
 *   3. Fresh OAuth-only session (<= 10 minutes) for accounts without password credentials.
 */
export async function verifyOwnerStepUpForDeletion(
  platformDb: D1Database,
  input: {
    readonly userId: string;
    readonly sessionId: string | null;
    readonly sessionCreatedAtMs: number | null;
    readonly currentPassword?: string;
    readonly reauthenticatedAtMs?: number | null;
    readonly nowMs: number;
  },
): Promise<
  | { readonly ok: true; readonly method: DeletionConfirmationMethod }
  | { readonly ok: false; readonly code: "REAUTH_REQUIRED" | "TOTP_REQUIRED"; readonly message: string }
> {
  const { userId, sessionId, nowMs } = input;

  // 1. Check authoritative Better Auth 2FA enrollment & session verification state first
  const tfaState = sessionId
    ? await getSessionSecondFactorState(platformDb, { sessionId, userId })
    : {
        sessionId: "",
        userId,
        twoFactorEnabled: Boolean(
          (
            await platformDb
              .prepare("SELECT two_factor_enabled FROM users WHERE id = ? LIMIT 1")
              .bind(userId)
              .first<{ readonly two_factor_enabled: number | null }>()
              .catch(() => null)
          )?.two_factor_enabled === 1,
        ),
        sessionVerified: false,
        verifiedAtMs: null,
        method: null,
      };

  const hasRecent2fa =
    tfaState.verifiedAtMs !== null &&
    tfaState.method !== null &&
    nowMs - tfaState.verifiedAtMs >= 0 &&
    nowMs - tfaState.verifiedAtMs <= DELETION_REAUTH_WINDOW_MS;

  if (tfaState.twoFactorEnabled) {
    if (tfaState.sessionVerified && hasRecent2fa && tfaState.method) {
      return { ok: true, method: tfaState.method };
    }
    return {
      ok: false,
      code: "TOTP_REQUIRED",
      message:
        "Akun Anda mengaktifkan 2FA. Verifikasi autentikasi dua faktor (2FA) dalam 10 menit terakhir wajib dilakukan sebelum menghapus situs.",
    };
  }

  // Also honor a recent session 2FA verification record when present
  if (hasRecent2fa && tfaState.method) {
    return { ok: true, method: tfaState.method };
  }

  // 2. Check current password reauthentication (when 2FA is not enabled)
  if (typeof input.currentPassword === "string" && input.currentPassword.length > 0) {
    const valid = await verifyUserPassword(platformDb, userId, input.currentPassword);
    if (!valid) {
      return {
        ok: false,
        code: "REAUTH_REQUIRED",
        message: "Kata sandi saat ini tidak sesuai. Silakan periksa kembali.",
      };
    }
    return { ok: true, method: "password" };
  }

  // 3. Explicit recent reauthentication timestamp within 10 minutes
  if (
    typeof input.reauthenticatedAtMs === "number" &&
    Number.isFinite(input.reauthenticatedAtMs) &&
    nowMs - input.reauthenticatedAtMs >= 0 &&
    nowMs - input.reauthenticatedAtMs <= DELETION_REAUTH_WINDOW_MS
  ) {
    return { ok: true, method: "fresh_reauth" };
  }

  // 4. OAuth-only account without password & without 2FA: accept fresh login session (<= 10 min)
  const caps = await inspectOwnerAuthCapabilities(platformDb, userId, sessionId, nowMs);
  if (
    !caps.hasPasswordAccount &&
    !caps.twoFactorEnabled &&
    typeof input.sessionCreatedAtMs === "number" &&
    Number.isFinite(input.sessionCreatedAtMs) &&
    nowMs - input.sessionCreatedAtMs >= 0 &&
    nowMs - input.sessionCreatedAtMs <= DELETION_REAUTH_WINDOW_MS
  ) {
    return { ok: true, method: "fresh_reauth" };
  }

  return {
    ok: false,
    code: "REAUTH_REQUIRED",
    message:
      "Autentikasi ulang diperlukan untuk menghapus situs. Masukkan kata sandi Anda saat ini.",
  };
}

export async function serializeExportJobDto(
  job: TenantExportJobRecord,
  options: {
    readonly signingSecret: string;
    readonly nowMs: number;
  },
): Promise<Record<string, unknown>> {
  let downloadUrl: string | null = null;
  if (
    job.status === "ready" &&
    job.downloadExpiresAtMs !== null &&
    options.nowMs < job.downloadExpiresAtMs &&
    job.downloadTokenHash !== null
  ) {
    const token = await signExportDownloadToken(options.signingSecret, {
      exportId: job.id,
      tenantId: job.tenantId,
      ownerUserId: job.requestedByUserId,
      expiresAtMs: job.downloadExpiresAtMs,
    });
    downloadUrl = `/api/tenants/${encodeURIComponent(job.tenantId)}/exports/${encodeURIComponent(job.id)}/download?token=${encodeURIComponent(token)}`;
  }

  return {
    id: job.id,
    tenantId: job.tenantId,
    requestDay: job.requestDay,
    status: job.status,
    archiveBytes: job.archiveBytes,
    archiveSha256: job.archiveSha256,
    manifest: job.manifest,
    truncated: job.manifest?.truncated ?? null,
    downloadUrl,
    downloadExpiresAt: job.downloadExpiresAtMs
      ? new Date(job.downloadExpiresAtMs).toISOString()
      : null,
    downloadExpiresAtLabel: formatWibDateTimeLabel(job.downloadExpiresAtMs),
    downloadCount: job.downloadCount,
    errorCode: job.errorCode,
    createdAt: new Date(job.createdAtMs).toISOString(),
    createdAtLabel: formatWibDateTimeLabel(job.createdAtMs),
    completedAt: job.completedAtMs ? new Date(job.completedAtMs).toISOString() : null,
    completedAtLabel: formatWibDateTimeLabel(job.completedAtMs),
  };
}

export function serializeDeletionRequestDto(
  req: TenantDeletionRequestRecord | null,
): Record<string, unknown> | null {
  if (!req) return null;
  return {
    id: req.id,
    status: req.status,
    confirmationMethod: req.confirmationMethod,
    reason: req.reason,
    deletionRequestedAt: new Date(req.deletionRequestedAtMs).toISOString(),
    deletionRequestedAtLabel: formatWibDateTimeLabel(req.deletionRequestedAtMs),
    deletionDueAt: new Date(req.deletionDueAtMs).toISOString(),
    deletionDueAtLabel: formatWibDateTimeLabel(req.deletionDueAtMs),
    previousStatus: req.previousStatus,
    canceledAt: req.canceledAtMs ? new Date(req.canceledAtMs).toISOString() : null,
    canceledAtLabel: formatWibDateTimeLabel(req.canceledAtMs),
    cancelReason: req.cancelReason,
    purgedAt: req.purgedAtMs ? new Date(req.purgedAtMs).toISOString() : null,
  };
}

export function serializeDeletionStatusDto(
  view: TenantDeletionStatusView,
  capabilities?: OwnerAuthCapabilities,
): Record<string, unknown> {
  return {
    tenantId: view.tenantId,
    handle: view.tenantHandle,
    siteStatus: view.tenantStatus,
    operatorHold: view.operatorHold,
    operatorHoldReason: view.operatorHoldReason,
    undoWindowDays: 7,
    canRequestDeletion: view.canRequestDeletion,
    canCancelDeletion: view.canCancelDeletion,
    remainingUndoMs: view.remainingUndoMs,
    remainingUndoDays:
      view.remainingUndoMs > 0 ? Math.max(1, Math.ceil(view.remainingUndoMs / 86_400_000)) : 0,
    activeRequest: serializeDeletionRequestDto(view.activeRequest),
    latestRequest: serializeDeletionRequestDto(view.latestRequest),
    ...(capabilities ? { authCapabilities: capabilities } : {}),
  };
}
