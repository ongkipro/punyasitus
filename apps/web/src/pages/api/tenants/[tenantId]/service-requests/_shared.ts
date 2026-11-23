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
  buildSetupServiceWhatsAppUrl,
  computeCustomThemeDayBucket,
  CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  CUSTOM_THEME_STATUS_LABELS_ID,
  CustomThemeValidationError,
  SERVICE_KIND_LABELS_ID,
  STAFF_ACCESS_STATE_LABELS_ID,
  type CustomThemePackageRecord,
  type CustomThemeRequestRecord,
  type CustomThemeRequestStatus,
  type ServiceKind,
  type StaffAccessState,
} from "@punyasitus/core/custom-themes/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type Role, type TenantStatus } from "@punyasitus/core/schemas";
import {
  countTenantDailyCustomThemeRequests,
  CustomThemeRepositoryError,
  getTenantSeatUsageForServiceRequest,
  listCustomThemePackages,
  listTenantCustomThemeRequests,
  type TenantServiceSeatUsage,
} from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared authorization, strict DTO validation, and response helpers for tenant
 * Terima Beres Setup Service APIs:
 * - `/api/tenants/:tenantId/service-requests`
 * - `/api/tenants/:tenantId/service-requests/:requestId`
 * - `/api/tenants/:tenantId/service-requests/:requestId/staff-access`
 *
 * (REQ-070, REQ-034, REQ-035, REQ-065; PLAN §4, §11.4, §18.2; TASK-069).
 * ZERO runtime DDL.
 */

export const MAX_SERVICE_REQUEST_BODY_BYTES = 32_768 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const SERVICE_REQUEST_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export const SERVICE_REQUEST_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "__proto__",
  "constructor",
  "prototype",
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "role",
  "roles",
  "actorId",
  "actor_id",
  "status",
  "deliveredThemeId",
  "delivered_theme_id",
  "deliveredThemeGrantId",
  "operatorNotes",
  "operator_notes",
  "startingPriceIdr",
  "starting_price_idr",
  "priceIdr",
  "price_idr",
  "staffUserId",
  "staff_user_id",
  "staffAccessState",
  "staff_access_state",
  "staffMemberId",
  "staff_member_id",
  "platformOperator",
  "isSuperadmin",
]);

export interface TenantServiceRequestRuntimeEnv extends AuthRuntimeEnv {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
}

export interface TenantServiceRequestHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
}

export interface AuthorizedTenantServiceRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly nowMs: number;
}

export interface TenantSetupPackageDto {
  readonly id: string;
  readonly serviceKind: ServiceKind;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inclusions: readonly string[];
  readonly startingPriceIdr: number | null;
  readonly priceLabel: string;
  readonly isQuoteOnly: boolean;
  readonly estimatedDuration: string;
  readonly sortOrder: number;
}

export interface TenantSetupStaffAccessDto {
  readonly state: StaffAccessState;
  readonly stateLabel: string;
  readonly staffName: string | null;
  readonly staffEmail: string | null;
  readonly approvedAt: string | null;
  readonly joinedAt: string | null;
  readonly revokedAt: string | null;
  readonly waitReason: string | null;
}

export interface TenantSetupRequestDto {
  readonly id: string;
  readonly requestCode: string;
  readonly serviceKind: ServiceKind;
  readonly serviceKindLabel: string;
  readonly tenantHandle: string;
  readonly packageId: string | null;
  readonly packageName: string;
  readonly status: CustomThemeRequestStatus;
  readonly statusLabel: string;
  readonly brandName: string;
  readonly brief: string;
  readonly referenceUrls: readonly string[];
  readonly budgetRange: string | null;
  readonly contactPreference: "whatsapp" | "email" | "both";
  readonly staffAccess: TenantSetupStaffAccessDto;
  readonly whatsappUrl: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantSetupSeatsDto {
  readonly activeMembersCount: number;
  readonly pendingInvitationsCount: number;
  readonly seatsUsed: number;
  readonly seatsLimit: number;
  readonly seatsRemaining: number;
}

export interface TenantSetupDailyQuotaDto {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly dayBucket: string;
}

export interface TenantSetupServiceStateDto {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly role: Role;
  readonly canApproveStaff: boolean;
  readonly tenantStatus: TenantStatus;
  readonly packages: readonly TenantSetupPackageDto[];
  readonly requests: readonly TenantSetupRequestDto[];
  readonly seats: TenantSetupSeatsDto;
  readonly dailyQuota: TenantSetupDailyQuotaDto;
  readonly salesWhatsappConfigured: boolean;
  readonly contactWhatsappUrl: string | null;
  readonly supportEmail: string | null;
}

export function createServiceRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function serviceRequestJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(SERVICE_REQUEST_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function serviceRequestErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  options: {
    readonly fields?: readonly {
      readonly field: string;
      readonly code: string;
      readonly message: string;
    }[];
    readonly extraHeaders?: HeadersInit;
  } = {},
): Response {
  return serviceRequestJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(options.fields && options.fields.length > 0 ? { fields: options.fields } : {}),
      },
      requestId,
    },
    options.extraHeaders,
  );
}

export function formatTenantSetupPackageDto(pkg: CustomThemePackageRecord): TenantSetupPackageDto {
  return {
    id: pkg.id,
    serviceKind: pkg.serviceKind,
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    inclusions: pkg.inclusions,
    startingPriceIdr: pkg.startingPriceIdr,
    priceLabel: pkg.priceLabel,
    isQuoteOnly: pkg.startingPriceIdr === null,
    estimatedDuration: pkg.estimatedDuration,
    sortOrder: pkg.sortOrder,
  };
}

export function formatTenantSetupRequestDto(
  req: CustomThemeRequestRecord,
  salesWhatsapp: string | null | undefined,
): TenantSetupRequestDto {
  const wa = buildSetupServiceWhatsAppUrl({
    salesWhatsapp,
    tenantHandle: req.tenantHandle,
    requestCode: req.requestCode,
    packageName: req.packageName,
  });

  return {
    id: req.id,
    requestCode: req.requestCode,
    serviceKind: req.serviceKind,
    serviceKindLabel: SERVICE_KIND_LABELS_ID[req.serviceKind],
    tenantHandle: req.tenantHandle,
    packageId: req.packageId,
    packageName: req.packageName,
    status: req.status,
    statusLabel: CUSTOM_THEME_STATUS_LABELS_ID[req.status],
    brandName: req.brandName,
    brief: req.brief,
    referenceUrls: req.referenceUrls,
    budgetRange: req.budgetRange,
    contactPreference: req.contactPreference,
    staffAccess: {
      state: req.staffAccessState,
      stateLabel: STAFF_ACCESS_STATE_LABELS_ID[req.staffAccessState],
      staffName: req.staffName,
      staffEmail: req.staffEmail,
      approvedAt: req.staffApprovedAtIso,
      joinedAt: req.staffJoinedAtIso,
      revokedAt: req.staffRevokedAtIso,
      waitReason: req.staffWaitReason,
    },
    whatsappUrl: wa?.url ?? null,
    version: req.version,
    createdAt: req.createdAtIso,
    updatedAt: req.updatedAtIso,
  };
}

export function formatTenantSeatsDto(seats: TenantServiceSeatUsage | null): TenantSetupSeatsDto {
  if (!seats) {
    return {
      activeMembersCount: 0,
      pendingInvitationsCount: 0,
      seatsUsed: 0,
      seatsLimit: 5,
      seatsRemaining: 5,
    };
  }
  return {
    activeMembersCount: seats.activeMembersCount,
    pendingInvitationsCount: seats.pendingInvitationsCount,
    seatsUsed: seats.seatsUsed,
    seatsLimit: seats.seatsLimit,
    seatsRemaining: seats.seatsRemaining,
  };
}

export async function authorizeTenantServiceRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantServiceRequestRuntimeEnv,
  options: TenantServiceRequestHandlerOptions & {
    readonly requiredPermission?: PermissionAction | null;
    readonly allowLockedOrSuspended?: boolean;
  } = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedTenantServiceRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createServiceRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const requiredPermission: PermissionAction | undefined =
    options.requiredPermission === null
      ? undefined
      : (options.requiredPermission ?? "theme:custom_request");

  // 1. Platform app host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: serviceRequestErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: serviceRequestErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: serviceRequestErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // 4. Verify Better Auth session + lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: serviceRequestErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          { extraHeaders: { "Retry-After": "60" } },
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
      response: serviceRequestErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + lifecycle status check
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: serviceRequestErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
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
        response: serviceRequestErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: serviceRequestErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  if (member.tenantStatus === "purging" || member.tenantStatus === "purged") {
    return {
      ok: false,
      response: serviceRequestErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }
  if (
    !options.allowLockedOrSuspended &&
    (member.tenantStatus === "locked" ||
      member.tenantStatus === "suspended" ||
      member.tenantStatus === "recovery")
  ) {
    return {
      ok: false,
      response: serviceRequestErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Layanan Terima Beres tidak tersedia saat situs dalam status terkunci atau ditangguhkan.",
        requestId,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      nowMs,
    },
  };
}

export async function parseStrictServiceRequestJsonBody(
  request: Request,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let rawText: string;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_SERVICE_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        response: serviceRequestErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          "Ukuran permintaan melebihi batas maksimal 32 KiB.",
          requestId,
        ),
      };
    }
    rawText = new TextDecoder().decode(buffer);
  } catch {
    return {
      ok: false,
      response: serviceRequestErrorResponse(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: serviceRequestErrorResponse(
        400,
        "BAD_REQUEST",
        "Body permintaan harus berupa JSON yang valid.",
        requestId,
      ),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: serviceRequestErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Payload permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SERVICE_REQUEST_FORBIDDEN_KEYS.has(key)) {
      return {
        ok: false,
        response: serviceRequestErrorResponse(
          422,
          "FORBIDDEN_FIELD",
          `Field "${key}" tidak diizinkan pada permintaan tenant.`,
          requestId,
          {
            fields: [
              {
                field: key,
                code: "FORBIDDEN_FIELD",
                message: `Field "${key}" tidak boleh dikirim oleh klien.`,
              },
            ],
          },
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export async function loadTenantSetupServiceState(
  platformDb: D1Database,
  member: {
    readonly tenantId: string;
    readonly handle: string;
    readonly tenantName: string;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  },
  nowMs: number = Date.now(),
): Promise<TenantSetupServiceStateDto> {
  const dayBucket = computeCustomThemeDayBucket(nowMs);

  const [packages, requests, dailyUsed, seats, settings] = await Promise.all([
    listCustomThemePackages(platformDb, { serviceKind: "setup", activeOnly: true, limit: 50 }),
    listTenantCustomThemeRequests(platformDb, {
      tenantId: member.tenantId,
      serviceKind: "setup",
      limit: 50,
    }),
    countTenantDailyCustomThemeRequests(platformDb, {
      tenantId: member.tenantId,
      serviceKind: "setup",
      dayBucket,
    }),
    getTenantSeatUsageForServiceRequest(platformDb, {
      tenantId: member.tenantId,
      nowMs,
    }),
    getPlatformSettings(platformDb),
  ]);

  const salesWhatsapp = settings.salesWhatsapp || null;
  const contactWa = buildSetupServiceWhatsAppUrl({
    salesWhatsapp,
    tenantHandle: member.handle,
    requestCode: null,
    packageName: null,
  });

  return {
    tenantId: member.tenantId,
    handle: member.handle,
    tenantName: member.tenantName,
    role: member.role,
    canApproveStaff: member.role === "owner",
    tenantStatus: member.tenantStatus,
    packages: packages.map(formatTenantSetupPackageDto),
    requests: requests.map((req) => formatTenantSetupRequestDto(req, salesWhatsapp)),
    seats: formatTenantSeatsDto(seats),
    dailyQuota: {
      used: dailyUsed,
      limit: CUSTOM_THEME_DAILY_REQUEST_LIMIT,
      remaining: Math.max(0, CUSTOM_THEME_DAILY_REQUEST_LIMIT - dailyUsed),
      dayBucket,
    },
    salesWhatsappConfigured: contactWa !== null,
    contactWhatsappUrl: contactWa?.url ?? null,
    supportEmail: settings.supportEmail || null,
  };
}

export function mapTenantServiceRequestErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof CustomThemeValidationError) {
    return serviceRequestErrorResponse(422, err.code, err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof CustomThemeRepositoryError) {
    return serviceRequestErrorResponse(err.status, err.code, err.message, requestId);
  }
  return serviceRequestErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses permintaan Layanan Terima Beres.",
    requestId,
  );
}
