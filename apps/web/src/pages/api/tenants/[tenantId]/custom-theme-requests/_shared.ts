import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import {
  buildCustomThemeWhatsAppUrl,
  computeCustomThemeDayBucket,
  CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  CUSTOM_THEME_STATUS_LABELS_ID,
  CustomThemeValidationError,
  type CustomThemePackageRecord,
  type CustomThemeRequestRecord,
  type CustomThemeRequestStatus,
} from "@punyasitus/core/custom-themes/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type Role, type TenantStatus } from "@punyasitus/core/schemas";
import { PLATFORM_THEME_IDS } from "@punyasitus/core/theme/index";
import {
  countTenantDailyCustomThemeRequests,
  CustomThemeRepositoryError,
  listCustomThemePackages,
  listTenantCustomThemeRequests,
} from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import { loadTenantThemeGrantsFromPlatformDb } from "@punyasitus/db/themes/index";
import {
  getRegisteredTheme,
  REGISTERED_PLATFORM_THEMES,
} from "../../../../../core/theme-registry.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared authorization, strict DTO validation, and response helpers for tenant
 * Custom Theme Service APIs:
 * - `/api/tenants/:tenantId/custom-theme-packages`
 * - `/api/tenants/:tenantId/custom-theme-requests/**`
 *
 * (REQ-063, REQ-034, REQ-060; PLAN §4, §11.4, §17.1; TASK-061).
 * ZERO runtime DDL.
 */

export const MAX_CUSTOM_THEME_BODY_BYTES = 32_768 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const CUSTOM_THEME_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export const CUSTOM_THEME_REQUEST_CREATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "packageId",
  "brandName",
  "brief",
  "referenceUrls",
  "budgetRange",
  "contactPreference",
  "idempotencyKey",
]);

export const CUSTOM_THEME_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
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
  "serviceKind",
  "service_kind",
  "platformOperator",
  "isSuperadmin",
]);

export interface TenantCustomThemeRuntimeEnv extends AuthRuntimeEnv {
  readonly JOBS_QUEUE?: {
    send(message: unknown): Promise<unknown>;
  };
}

export interface TenantCustomThemeHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
}

export interface AuthorizedTenantCustomThemeContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly nowMs: number;
}

export interface TenantCustomThemePackageDto {
  readonly id: string;
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

export interface TenantCustomThemeRequestDto {
  readonly id: string;
  readonly requestCode: string;
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
  readonly deliveredThemeId: string | null;
  readonly deliveredThemeGrantId: string | null;
  readonly whatsappUrl: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantAvailableThemeSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly tier: "included" | "custom";
  readonly isCustom: boolean;
}

export interface TenantCustomThemeDailyQuotaDto {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly dayBucket: string;
}

export interface TenantCustomThemeServiceStateDto {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly role: Role;
  readonly tenantStatus: TenantStatus;
  readonly defaultThemes: readonly TenantAvailableThemeSummaryDto[];
  readonly grantedCustomThemes: readonly TenantAvailableThemeSummaryDto[];
  readonly packages: readonly TenantCustomThemePackageDto[];
  readonly requests: readonly TenantCustomThemeRequestDto[];
  readonly dailyQuota: TenantCustomThemeDailyQuotaDto;
  readonly salesWhatsappConfigured: boolean;
  readonly contactWhatsappUrl: string | null;
  readonly supportEmail: string | null;
}

export function createCustomThemeRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function customThemeJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(CUSTOM_THEME_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function customThemeErrorResponse(
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
  return customThemeJsonResponse(
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

export function formatTenantCustomThemePackageDto(
  pkg: CustomThemePackageRecord,
): TenantCustomThemePackageDto {
  return {
    id: pkg.id,
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

export function formatTenantCustomThemeRequestDto(
  req: CustomThemeRequestRecord,
  salesWhatsapp: string | null | undefined,
): TenantCustomThemeRequestDto {
  const wa = buildCustomThemeWhatsAppUrl({
    salesWhatsapp,
    tenantHandle: req.tenantHandle,
    requestCode: req.requestCode,
    packageName: req.packageName,
  });

  return {
    id: req.id,
    requestCode: req.requestCode,
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
    deliveredThemeId: req.deliveredThemeId,
    deliveredThemeGrantId: req.deliveredThemeGrantId,
    whatsappUrl: wa?.url ?? null,
    version: req.version,
    createdAt: req.createdAtIso,
    updatedAt: req.updatedAtIso,
  };
}

export async function authorizeTenantCustomThemeRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantCustomThemeRuntimeEnv,
  options: TenantCustomThemeHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedTenantCustomThemeContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createCustomThemeRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Platform app host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: customThemeErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: customThemeErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: customThemeErrorResponse(
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
        response: customThemeErrorResponse(
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
      response: customThemeErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC (`theme:custom_request`) + lifecycle status check (denies locked/suspended/editors/other tenants)
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: customThemeErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission: "theme:custom_request",
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: customThemeErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: customThemeErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // Extra defense-in-depth check for operator hold or purging/purged/locked
  if (member.tenantStatus === "purging" || member.tenantStatus === "purged") {
    return {
      ok: false,
      response: customThemeErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }
  if (
    member.tenantStatus === "locked" ||
    member.tenantStatus === "suspended" ||
    member.tenantStatus === "recovery"
  ) {
    return {
      ok: false,
      response: customThemeErrorResponse(
        403,
        "SUBSCRIPTION_LOCKED",
        "Layanan tema kustom tidak tersedia saat situs dalam status terkunci atau ditangguhkan.",
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

export async function parseStrictTenantCustomThemeJsonBody(
  request: Request,
  requestId: string,
  allowedKeys: ReadonlySet<string>,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let rawText: string;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_CUSTOM_THEME_BODY_BYTES) {
      return {
        ok: false,
        response: customThemeErrorResponse(
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
      response: customThemeErrorResponse(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: customThemeErrorResponse(
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
      response: customThemeErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Payload permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CUSTOM_THEME_FORBIDDEN_KEYS.has(key)) {
      return {
        ok: false,
        response: customThemeErrorResponse(
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
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        response: customThemeErrorResponse(
          422,
          "UNKNOWN_FIELD",
          `Field tidak dikenal: "${key}".`,
          requestId,
          {
            fields: [
              {
                field: key,
                code: "UNKNOWN_FIELD",
                message: `Field "${key}" tidak dikenali.`,
              },
            ],
          },
        ),
      };
    }
  }

  return { ok: true, body: record };
}

export async function loadTenantCustomThemeServiceState(
  platformDb: D1Database,
  member: {
    readonly tenantId: string;
    readonly handle: string;
    readonly tenantName: string;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  },
  nowMs: number = Date.now(),
): Promise<TenantCustomThemeServiceStateDto> {
  const dayBucket = computeCustomThemeDayBucket(nowMs);

  const [packages, requests, dailyUsed, grants, settings] = await Promise.all([
    listCustomThemePackages(platformDb, { serviceKind: "custom_theme", activeOnly: true, limit: 50 }),
    listTenantCustomThemeRequests(platformDb, {
      tenantId: member.tenantId,
      serviceKind: "custom_theme",
      limit: 50,
    }),
    countTenantDailyCustomThemeRequests(platformDb, {
      tenantId: member.tenantId,
      serviceKind: "custom_theme",
      dayBucket,
    }),
    loadTenantThemeGrantsFromPlatformDb(platformDb, member.tenantId),
    getPlatformSettings(platformDb),
  ]);

  const salesWhatsapp = settings.salesWhatsapp || null;
  const contactWa = buildCustomThemeWhatsAppUrl({
    salesWhatsapp,
    tenantHandle: member.handle,
    requestCode: null,
    packageName: null,
  });

  const defaultThemes: TenantAvailableThemeSummaryDto[] = PLATFORM_THEME_IDS.map((id) => ({
    id,
    name: REGISTERED_PLATFORM_THEMES[id].name,
    tier: "included",
    isCustom: false,
  }));

  const grantedCustomThemes: TenantAvailableThemeSummaryDto[] = grants
    .filter((g) => g.active && g.tier === "custom")
    .map((g) => {
      const registered = getRegisteredTheme(g.themeId) ?? getRegisteredTheme(g.slug);
      return {
        id: registered?.id ?? g.themeId,
        name: registered?.name ?? g.name,
        tier: "custom" as const,
        isCustom: true,
      };
    });

  return {
    tenantId: member.tenantId,
    handle: member.handle,
    tenantName: member.tenantName,
    role: member.role,
    tenantStatus: member.tenantStatus,
    defaultThemes,
    grantedCustomThemes,
    packages: packages.map(formatTenantCustomThemePackageDto),
    requests: requests.map((req) => formatTenantCustomThemeRequestDto(req, salesWhatsapp)),
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

export function mapTenantCustomThemeErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof CustomThemeValidationError) {
    return customThemeErrorResponse(422, err.code, err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof CustomThemeRepositoryError) {
    return customThemeErrorResponse(err.status, err.code, err.message, requestId);
  }
  return customThemeErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memproses permintaan tema kustom.",
    requestId,
  );
}
