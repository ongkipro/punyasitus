import {
  assertAdminCsrfAndOrigin,
  createAuth,
  enforceSessionLifetimeCeiling,
} from "@punyasitus/auth";
import {
  AFFILIATE_PAYOUT_MINIMUM_IDR,
  AFFILIATE_PAYOUT_TIMEZONE,
  getDaysInCalendarMonth,
  getWibCalendarDate,
  type AffiliateCommissionEntryKind,
  type AffiliateCommissionStatus,
  type AffiliatePayoutBatchStatus,
} from "@punyasitus/core/affiliates/commission";
import {
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  type AffiliateDbStatus,
} from "@punyasitus/core/affiliates/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  AffiliateError,
  formatPublicAffiliateSummaryDto,
  getAffiliateByUserId,
  getAffiliateFunnelVisitsTotal,
  type AffiliateAccountRecord,
  type PublicAffiliateSummaryDto,
} from "@punyasitus/db/affiliates/index";
import {
  getAffiliateCommissionBalanceSummary,
  listAffiliatePayoutBatches,
  loadAffiliateCommissionRatesSnapshot,
} from "@punyasitus/db/affiliates/ledger/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../middleware/auth.ts";

/**
 * Shared authentication, host-isolation, deterministic handle masking, WIB payout
 * schedule calculation, and strictly ZERO-PII portal overview loaders for
 * `/affiliate/**` and `/api/affiliate/**` (REQ-086, PLAN §19.4, DESIGN §4.3, TASK-086).
 *
 * Privacy & Isolation Invariants:
 * - Strictly `app` host ONLY (`404` on marketing/console/tenant hosts).
 * - Separate affiliate account isolation: authenticated users without an `affiliates`
 *   row receive `403 AFFILIATE_ACCOUNT_REQUIRED` on `/api/affiliate/**`.
 * - Every query is bound strictly to `actorAffiliate.id` resolved from `session.user.id`.
 * - ZERO tenant PII: never selects or serializes referred tenant owner names, emails,
 *   phone/WhatsApp numbers, custom domains, business names, page titles, or leads.
 * - Referred tenant handles are deterministically masked (e.g. `ko***ra`, `a***c`).
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const INDONESIAN_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

export const AFFILIATE_COMPLIANCE_SETTINGS_KEY = "affiliate.payout_compliance" as const;

export type AffiliatePortalRuntimeEnv = AuthRuntimeEnv;

export interface AffiliatePortalAuthOptions {
  readonly emailPort?: EmailPort | null;
  readonly requestId?: string;
  readonly nowMs?: number;
  readonly session?: {
    readonly id: string;
    readonly userId: string;
  } | null;
  readonly user?: {
    readonly id: string;
    readonly email?: string;
    readonly name?: string;
  } | null;
}

export interface AuthorizedAffiliateContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly platformDb: D1Database;
  readonly expectedOrigin: string;
  readonly marketingOrigin: string;
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly emailVerified: boolean;
  readonly sessionId: string;
  readonly affiliate: AffiliateAccountRecord | null;
}

export interface NextWibPayoutDateDto {
  readonly dateKey: string; // YYYY-MM-DD in Asia/Jakarta
  readonly labelId: string; // e.g. "15 Desember 2026 (WIB)"
  readonly daysUntil: number;
  readonly isToday: boolean;
  readonly timezone: typeof AFFILIATE_PAYOUT_TIMEZONE;
}

export interface AffiliateThresholdProgressDto {
  readonly minimumPayoutIdr: number;
  readonly netAvailableIdr: number;
  readonly progressPercent: number;
  readonly remainingToMinimumIdr: number;
  readonly eligibleForNextBatch: boolean;
}

export interface AffiliateFunnelSummaryDto {
  readonly visitsCount: number;
  readonly registrationsCount: number;
  readonly trialsCount: number;
  readonly payingTenantsCount: number;
}

/**
 * Strictly PII-free referred tenant summary shown to the owning affiliate.
 * Contains ONLY masked handle, lifecycle bucket, attribution date, and commission totals.
 */
export interface MaskedReferredTenantDto {
  readonly maskedHandle: string;
  readonly stage: "trial" | "paying" | "inactive";
  readonly tenantStatus: "trial" | "active" | "grace" | "locked" | "suspended" | "other";
  readonly attributedAt: string;
  readonly firstPaymentCommissionIdr: number;
  readonly renewalCount: number;
  readonly renewalCommissionIdr: number;
  readonly totalCommissionIdr: number;
}

/**
 * Strictly PII-free commission ledger entry shown to the owning affiliate.
 */
export interface AffiliatePortalCommissionEntryDto {
  readonly id: string;
  readonly maskedHandle: string;
  readonly entryKind: AffiliateCommissionEntryKind;
  readonly netBaseIdr: number;
  readonly rateBps: number;
  readonly commissionIdr: number;
  readonly status: AffiliateCommissionStatus;
  readonly confirmedAt: string;
  readonly holdUntilAt: string;
  readonly approvedAt: string | null;
  readonly reversedAt: string | null;
  readonly payoutBatchId: string | null;
}

export interface AffiliatePortalPayoutBatchDto {
  readonly id: string;
  readonly payoutPeriodKey: string;
  readonly totalAmountIdr: number;
  readonly entryCount: number;
  readonly status: AffiliatePayoutBatchStatus;
  readonly transferReference: string | null;
  readonly paidAt: string | null;
  readonly payoutBankCode: string;
  readonly payoutAccountMasked: string;
  readonly createdAt: string;
}

export interface AffiliatePortalComplianceDto {
  readonly termsAccepted: boolean;
  readonly termsVersion: string;
  readonly termsAcceptedAt: string | null;
  readonly platformTaxAndTermsResolved: boolean;
  readonly payoutReady: boolean;
  readonly missing: readonly string[];
}

export interface AffiliatePortalOverviewDto {
  readonly affiliate: PublicAffiliateSummaryDto;
  readonly funnel: AffiliateFunnelSummaryDto;
  readonly balances: {
    readonly pendingIdr: number;
    readonly approvedAvailableIdr: number;
    readonly batchedIdr: number;
    readonly paidIdr: number;
    readonly reversedIdr: number;
    readonly unbatchedReversalOffsetIdr: number;
    readonly totalReversalOffsetIdr: number;
    readonly netAvailableForNextPayoutIdr: number;
  };
  readonly threshold: AffiliateThresholdProgressDto;
  readonly nextPayout: NextWibPayoutDateDto;
  readonly rates: {
    readonly firstPaymentRatePercent: number;
    readonly renewalRatePercent: number;
    readonly holdDays: number;
    readonly minimumPayoutIdr: number;
  };
  readonly compliance: AffiliatePortalComplianceDto;
  readonly referredTenants: readonly MaskedReferredTenantDto[];
  readonly recentCommissions: readonly AffiliatePortalCommissionEntryDto[];
  readonly payoutBatches: readonly AffiliatePortalPayoutBatchDto[];
}

export interface AffiliatePayoutBatchDetailDto {
  readonly batch: AffiliatePortalPayoutBatchDto;
  readonly entries: readonly AffiliatePortalCommissionEntryDto[];
}

export const AFFILIATE_PRIVATE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function affiliateJsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(AFFILIATE_PRIVATE_HEADERS);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function affiliateErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Readonly<Record<string, unknown>>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return affiliateJsonResponse(
    status,
    {
      success: false,
      code,
      message,
      error: {
        code,
        message,
      },
      requestId,
      ...extra,
    },
    extraHeaders,
  );
}

export function affiliateNeutralNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function createAffiliateRequestId(request?: Request, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const headerId = request?.headers.get("cf-ray") ?? request?.headers.get("x-request-id");
  if (headerId?.trim()) return headerId.trim();
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function resolveAffiliatePortalRuntimeEnv(
  rawEnv: Readonly<Record<string, unknown>>,
): AffiliatePortalRuntimeEnv {
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

/**
 * Deterministic tenant handle masking for zero-PII affiliate reporting (REQ-086):
 * - Always hides middle characters with `***` and NEVER equals the original handle.
 * - Handles 3-char & 4-char handles safely (`abc` -> `a***c`, `toko` -> `t***o`).
 * - Handles >= 5-char handles as `ab***yz` (`kopinusantara` -> `ko***ra`, `toko-01` -> `to***01`).
 */
export function maskReferredTenantHandle(rawHandle: string): string {
  const clean = rawHandle.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (clean.length === 0) return "***";
  if (clean.length === 1) return `${clean[0]}***`;
  if (clean.length === 2) return `${clean[0]}***`;
  if (clean.length <= 4) {
    return `${clean[0]}***${clean[clean.length - 1]}`;
  }
  return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
}

/**
 * Computes the next scheduled bi-monthly `Asia/Jakarta` (WIB) payout date:
 * 15th and 30th of every month (or 28th/29th on the last day of February).
 */
export function computeNextWibPayoutDate(nowMs: number = Date.now()): NextWibPayoutDateDto {
  const wib = getWibCalendarDate(nowMs);
  const daysInCurrentMonth = getDaysInCalendarMonth(wib.year, wib.month);
  const secondDay = Math.min(30, daysInCurrentMonth);

  let targetYear = wib.year;
  let targetMonth = wib.month;
  let targetDay: number;

  if (wib.day <= 15) {
    targetDay = 15;
  } else if (wib.day <= secondDay) {
    targetDay = secondDay;
  } else {
    targetDay = 15;
    if (wib.month === 12) {
      targetYear = wib.year + 1;
      targetMonth = 1;
    } else {
      targetMonth = wib.month + 1;
    }
  }

  const currentUtcMidnight = Date.UTC(wib.year, wib.month - 1, wib.day);
  const targetUtcMidnight = Date.UTC(targetYear, targetMonth - 1, targetDay);
  const daysUntil = Math.max(0, Math.round((targetUtcMidnight - currentUtcMidnight) / 86_400_000));

  const mm = String(targetMonth).padStart(2, "0");
  const dd = String(targetDay).padStart(2, "0");
  const monthLabel = INDONESIAN_MONTHS[targetMonth - 1] ?? "Januari";

  return {
    dateKey: `${targetYear}-${mm}-${dd}`,
    labelId: `${targetDay} ${monthLabel} ${targetYear} (WIB)`,
    daysUntil,
    isToday: daysUntil === 0,
    timezone: AFFILIATE_PAYOUT_TIMEZONE,
  };
}

/**
 * Computes progress toward the `Rp 100.000` (or configured) minimum payout threshold
 * using exact integer arithmetic.
 */
export function computePayoutThresholdProgress(
  netAvailableIdr: number,
  minimumPayoutIdr: number = AFFILIATE_PAYOUT_MINIMUM_IDR,
): AffiliateThresholdProgressDto {
  const safeMin = Math.max(1, Math.trunc(minimumPayoutIdr));
  const safeNet = Math.trunc(netAvailableIdr);
  const clamped = Math.max(0, safeNet);
  const progressPercent = Math.min(100, Math.floor((clamped * 100) / safeMin));
  const remainingToMinimumIdr = Math.max(0, safeMin - safeNet);

  return {
    minimumPayoutIdr: safeMin,
    netAvailableIdr: safeNet,
    progressPercent,
    remainingToMinimumIdr,
    eligibleForNextBatch: safeNet >= safeMin,
  };
}

function resolveMarketingOrigin(runtimeEnv: AffiliatePortalRuntimeEnv): string {
  const domain = runtimeEnv.PLATFORM_DOMAIN?.trim().toLowerCase();
  if (!domain) return DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  return `https://${domain}`;
}

/**
 * Authenticates and isolates an affiliate portal request on `app.punyasitus.com`:
 * 1. Strictly `app` host ONLY (`404` on marketing/console/tenant hosts).
 * 2. Strict CSRF & Origin on state-changing HTTP methods (`403`).
 * 3. Live Better Auth `app` session + `enforceSessionLifetimeCeiling` (`401`).
 * 4. Separate affiliate account isolation (`403 AFFILIATE_ACCOUNT_REQUIRED` when
 *    `requireAffiliateAccount` is true and the user has no `affiliates` row).
 */
export async function authorizeAffiliateRequest(
  request: Request,
  runtimeEnv: AffiliatePortalRuntimeEnv,
  config: {
    readonly requireAffiliateAccount: boolean;
    readonly enforceCsrf?: boolean;
  },
  options: AffiliatePortalAuthOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedAffiliateContext }
  | { readonly ok: false; readonly code: string; readonly response: Response }
> {
  const requestId = createAffiliateRequestId(request, options.requestId);
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Strict `app` host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      code: "NOT_FOUND",
      response: affiliateErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin enforcement on state-changing methods
  const method = request.method.toUpperCase();
  const shouldEnforceCsrf = config.enforceCsrf ?? STATE_CHANGING_METHODS.has(method);
  if (shouldEnforceCsrf && STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        code: csrf.code,
        response: affiliateErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. PLATFORM_DB availability
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      response: affiliateErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan Portal Afiliasi sedang tidak tersedia.",
        requestId,
      ),
    };
  }

  // 4. Resolve Better Auth `app` session + lifetime ceiling (DEC-045)
  let sessionId: string | null = options.session?.id ?? null;
  let userId: string | null = options.user?.id ?? null;

  if (!sessionId || !userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        code: "SERVICE_UNAVAILABLE",
        response: affiliateErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
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
        sessionId = sessionRes.session.id;
        userId = sessionRes.user.id;
      }
    } catch {
      sessionId = null;
      userId = null;
    }
  }

  if (!sessionId || !userId) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      response: affiliateErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Silakan masuk terlebih dahulu untuk mengakses Portal Afiliasi.",
        requestId,
      ),
    };
  }

  const pathname = new URL(request.url).pathname.toLowerCase();
  const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
    sessionId,
    userId,
    surface: "app",
    pathname,
    nowMs,
  });

  if (!lifetime.valid) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      response: affiliateErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir. Silakan masuk kembali.",
        requestId,
      ),
    };
  }

  const userRow = await runtimeEnv.PLATFORM_DB.prepare(
    "SELECT id, name, email, email_verified FROM users WHERE id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly email_verified: number;
    }>();

  if (!userRow) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      response: affiliateErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Akun pengguna tidak ditemukan.",
        requestId,
      ),
    };
  }

  const marketingOrigin = resolveMarketingOrigin(runtimeEnv);
  const affiliate = await getAffiliateByUserId(runtimeEnv.PLATFORM_DB, userRow.id, marketingOrigin);

  if (config.requireAffiliateAccount && !affiliate) {
    return {
      ok: false,
      code: "AFFILIATE_ACCOUNT_REQUIRED",
      response: affiliateErrorResponse(
        403,
        "AFFILIATE_ACCOUNT_REQUIRED",
        "Akun afiliasi diperlukan untuk mengakses data Portal Afiliasi. Silakan daftar melalui halaman Portal Afiliasi terlebih dahulu.",
        requestId,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      nowMs,
      platformDb: runtimeEnv.PLATFORM_DB,
      expectedOrigin: hostCtx.expectedOrigin,
      marketingOrigin,
      userId: userRow.id,
      userName: userRow.name,
      userEmail: userRow.email,
      emailVerified: userRow.email_verified === 1,
      sessionId,
      affiliate,
    },
  };
}

function normalizeReferredTenantStatus(
  raw: string,
): MaskedReferredTenantDto["tenantStatus"] {
  switch (raw) {
    case "trial":
    case "active":
    case "grace":
    case "locked":
    case "suspended":
      return raw;
    default:
      return "other";
  }
}

interface PlatformAffiliateComplianceSetting {
  readonly affiliateTermsPublished: boolean;
  readonly affiliateTaxReviewCompleted: boolean;
}

async function readPlatformComplianceSetting(
  platformDb: D1Database,
): Promise<PlatformAffiliateComplianceSetting> {
  const row = await platformDb
    .prepare("SELECT value_json FROM platform_settings WHERE key = ? LIMIT 1")
    .bind(AFFILIATE_COMPLIANCE_SETTINGS_KEY)
    .first<{ readonly value_json: string }>();

  if (!row?.value_json) {
    return { affiliateTermsPublished: false, affiliateTaxReviewCompleted: false };
  }

  try {
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    return {
      affiliateTermsPublished: parsed.affiliateTermsPublished === true,
      affiliateTaxReviewCompleted: parsed.affiliateTaxReviewCompleted === true,
    };
  } catch {
    return { affiliateTermsPublished: false, affiliateTaxReviewCompleted: false };
  }
}

function evaluateAffiliatePortalCompliance(
  affiliate: AffiliateAccountRecord,
  platformSetting: PlatformAffiliateComplianceSetting,
): AffiliatePortalComplianceDto {
  const termsAccepted =
    Number.isFinite(affiliate.termsAcceptedAt) &&
    affiliate.termsAcceptedAt > 0 &&
    affiliate.termsVersion.trim().length > 0;
  const payoutDetailsPresent =
    affiliate.payoutBankCode.trim().length > 0 &&
    affiliate.payoutAccountMasked.trim().length > 0 &&
    affiliate.payoutAccountHolder.trim().length > 0;

  const missing: string[] = [];
  if (!termsAccepted) missing.push("affiliate_terms_not_accepted");
  if (!payoutDetailsPresent) missing.push("affiliate_payout_account_incomplete");
  if (!platformSetting.affiliateTermsPublished) missing.push("platform_affiliate_terms_pending");
  if (!platformSetting.affiliateTaxReviewCompleted) missing.push("platform_affiliate_tax_review_pending");

  const platformTaxAndTermsResolved =
    platformSetting.affiliateTermsPublished && platformSetting.affiliateTaxReviewCompleted;

  return {
    termsAccepted,
    termsVersion: affiliate.termsVersion,
    termsAcceptedAt: termsAccepted ? new Date(affiliate.termsAcceptedAt).toISOString() : null,
    platformTaxAndTermsResolved,
    payoutReady: missing.length === 0,
    missing,
  };
}

interface ReferredTenantAggRow {
  readonly handle: string;
  readonly status: string;
  readonly attributed_at: number;
  readonly first_payment_commission_idr: number;
  readonly renewal_count: number;
  readonly renewal_commission_idr: number;
  readonly total_commission_idr: number;
  readonly paid_entry_count: number;
}

interface CommissionWithHandleRow {
  readonly id: string;
  readonly handle: string | null;
  readonly entry_kind: AffiliateCommissionEntryKind;
  readonly net_base_idr: number;
  readonly rate_bps: number;
  readonly commission_idr: number;
  readonly status: AffiliateCommissionStatus;
  readonly confirmed_at: number;
  readonly hold_until_at: number;
  readonly approved_at: number | null;
  readonly reversed_at: number | null;
  readonly payout_batch_id: string | null;
}

/**
 * Loads the complete, strictly scoped, ZERO-PII affiliate portal overview for `affiliate`.
 * Every SQL query is strictly filtered by `affiliate.id` and NEVER selects tenant PII
 * (no owner email, phone, name, business name, domain, or leads).
 */
export async function loadAffiliatePortalOverview(
  platformDb: D1Database,
  affiliate: AffiliateAccountRecord,
  options: { readonly nowMs?: number } = {},
): Promise<AffiliatePortalOverviewDto> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  const [
    visitsCount,
    balanceSummary,
    offsetAgg,
    ratesSnapshot,
    platformCompliance,
    referredRows,
    commissionRows,
    payoutBatches,
  ] = await Promise.all([
    getAffiliateFunnelVisitsTotal(platformDb, affiliate.id),
    getAffiliateCommissionBalanceSummary(platformDb, affiliate.id),
    platformDb
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN entry_kind = 'reversal_offset' AND status = 'approved' AND payout_batch_id IS NULL THEN commission_idr ELSE 0 END), 0) AS unbatched_offset_idr,
           COALESCE(SUM(CASE WHEN entry_kind = 'reversal_offset' THEN commission_idr ELSE 0 END), 0) AS total_offset_idr
         FROM affiliate_commission_entries
         WHERE affiliate_id = ?`,
      )
      .bind(affiliate.id)
      .first<{ readonly unbatched_offset_idr: number; readonly total_offset_idr: number }>(),
    loadAffiliateCommissionRatesSnapshot(platformDb),
    readPlatformComplianceSetting(platformDb),
    // STRICT ZERO-PII PROJECTION: ONLY `t.handle` (immediately masked), `t.status`, `ar.attributed_at`, and commission aggregates!
    platformDb
      .prepare(
        `SELECT
           t.handle,
           t.status,
           ar.attributed_at,
           COALESCE(SUM(CASE WHEN e.entry_kind = 'first_payment' AND e.status != 'reversed' THEN e.commission_idr ELSE 0 END), 0) AS first_payment_commission_idr,
           COALESCE(SUM(CASE WHEN e.entry_kind = 'renewal' AND e.status != 'reversed' THEN 1 ELSE 0 END), 0) AS renewal_count,
           COALESCE(SUM(CASE WHEN e.entry_kind = 'renewal' AND e.status != 'reversed' THEN e.commission_idr ELSE 0 END), 0) AS renewal_commission_idr,
           COALESCE(SUM(CASE WHEN e.status != 'reversed' THEN e.commission_idr ELSE 0 END), 0) AS total_commission_idr,
           COALESCE(SUM(CASE WHEN e.entry_kind IN ('first_payment', 'renewal') AND e.status != 'reversed' THEN 1 ELSE 0 END), 0) AS paid_entry_count
         FROM affiliate_referrals ar
         INNER JOIN tenants t ON t.id = ar.tenant_id
         LEFT JOIN affiliate_commission_entries e
           ON e.tenant_id = ar.tenant_id AND e.affiliate_id = ar.affiliate_id
         WHERE ar.affiliate_id = ?
         GROUP BY ar.tenant_id, t.handle, t.status, ar.attributed_at
         ORDER BY ar.attributed_at DESC
         LIMIT 100`,
      )
      .bind(affiliate.id)
      .all<ReferredTenantAggRow>(),
    // STRICT ZERO-PII PROJECTION: ONLY `t.handle` (immediately masked) + commission math fields!
    platformDb
      .prepare(
        `SELECT
           e.id,
           t.handle,
           e.entry_kind,
           e.net_base_idr,
           e.rate_bps,
           e.commission_idr,
           e.status,
           e.confirmed_at,
           e.hold_until_at,
           e.approved_at,
           e.reversed_at,
           e.payout_batch_id
         FROM affiliate_commission_entries e
         LEFT JOIN tenants t ON t.id = e.tenant_id
         WHERE e.affiliate_id = ?
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT 50`,
      )
      .bind(affiliate.id)
      .all<CommissionWithHandleRow>(),
    listAffiliatePayoutBatches(platformDb, { affiliateId: affiliate.id, limit: 50 }),
  ]);

  const referredList = referredRows.results ?? [];
  let trialsCount = 0;
  let payingTenantsCount = 0;

  const referredTenants: MaskedReferredTenantDto[] = referredList.map((row) => {
    const normalizedStatus = normalizeReferredTenantStatus(row.status);
    const hasPaidCommission = Number(row.paid_entry_count ?? 0) > 0;
    let stage: MaskedReferredTenantDto["stage"];
    if (hasPaidCommission) {
      stage = "paying";
      payingTenantsCount += 1;
    } else if (normalizedStatus === "trial") {
      stage = "trial";
      trialsCount += 1;
    } else {
      stage = "inactive";
    }

    return {
      maskedHandle: maskReferredTenantHandle(row.handle),
      stage,
      tenantStatus: normalizedStatus,
      attributedAt: new Date(row.attributed_at).toISOString(),
      firstPaymentCommissionIdr: Number(row.first_payment_commission_idr ?? 0),
      renewalCount: Number(row.renewal_count ?? 0),
      renewalCommissionIdr: Number(row.renewal_commission_idr ?? 0),
      totalCommissionIdr: Number(row.total_commission_idr ?? 0),
    };
  });

  const recentCommissions: AffiliatePortalCommissionEntryDto[] = (
    commissionRows.results ?? []
  ).map((row) => ({
    id: row.id,
    maskedHandle: row.handle ? maskReferredTenantHandle(row.handle) : "***",
    entryKind: row.entry_kind,
    netBaseIdr: Number(row.net_base_idr ?? 0),
    rateBps: Number(row.rate_bps ?? 0),
    commissionIdr: Number(row.commission_idr ?? 0),
    status: row.status,
    confirmedAt: new Date(row.confirmed_at).toISOString(),
    holdUntilAt: new Date(row.hold_until_at).toISOString(),
    approvedAt: row.approved_at !== null ? new Date(row.approved_at).toISOString() : null,
    reversedAt: row.reversed_at !== null ? new Date(row.reversed_at).toISOString() : null,
    payoutBatchId: row.payout_batch_id,
  }));

  const mappedBatches: AffiliatePortalPayoutBatchDto[] = payoutBatches.map((batch) => ({
    id: batch.id,
    payoutPeriodKey: batch.payoutPeriodKey,
    totalAmountIdr: batch.totalAmountIdr,
    entryCount: batch.entryCount,
    status: batch.status,
    transferReference: batch.transferReference,
    paidAt: batch.paidAt !== null ? new Date(batch.paidAt).toISOString() : null,
    payoutBankCode: affiliate.payoutBankCode,
    payoutAccountMasked: affiliate.payoutAccountMasked,
    createdAt: new Date(batch.createdAt).toISOString(),
  }));

  const netAvailableForNextPayoutIdr = balanceSummary.approvedAvailableIdr;
  const threshold = computePayoutThresholdProgress(
    netAvailableForNextPayoutIdr,
    ratesSnapshot.minimumPayoutIdr,
  );
  const nextPayout = computeNextWibPayoutDate(nowMs);
  const compliance = evaluateAffiliatePortalCompliance(affiliate, platformCompliance);

  return {
    affiliate: formatPublicAffiliateSummaryDto(affiliate),
    funnel: {
      visitsCount,
      registrationsCount: referredList.length,
      trialsCount,
      payingTenantsCount,
    },
    balances: {
      pendingIdr: balanceSummary.pendingIdr,
      approvedAvailableIdr: balanceSummary.approvedAvailableIdr,
      batchedIdr: balanceSummary.batchedIdr,
      paidIdr: balanceSummary.paidIdr,
      reversedIdr: balanceSummary.reversedIdr,
      unbatchedReversalOffsetIdr: Number(offsetAgg?.unbatched_offset_idr ?? 0),
      totalReversalOffsetIdr: Number(offsetAgg?.total_offset_idr ?? 0),
      netAvailableForNextPayoutIdr,
    },
    threshold,
    nextPayout,
    rates: {
      firstPaymentRatePercent: Math.round(ratesSnapshot.firstPaymentRateBps / 100),
      renewalRatePercent: Math.round(ratesSnapshot.renewalRateBps / 100),
      holdDays: ratesSnapshot.holdDays,
      minimumPayoutIdr: ratesSnapshot.minimumPayoutIdr,
    },
    compliance,
    referredTenants,
    recentCommissions,
    payoutBatches: mappedBatches,
  };
}

/**
 * Loads a single payout batch strictly scoped to `affiliate.id` (returns `null` for
 * missing or foreign-affiliate batch IDs so callers return neutral `404`).
 */
export async function loadOwnedAffiliatePayoutBatchDetail(
  platformDb: D1Database,
  affiliate: AffiliateAccountRecord,
  batchId: string,
): Promise<AffiliatePayoutBatchDetailDto | null> {
  const cleanBatchId = batchId.trim();
  if (!cleanBatchId) return null;

  const batchRow = await platformDb
    .prepare(
      `SELECT
         id,
         payout_period_key,
         total_amount_idr,
         entry_count,
         status,
         transfer_reference,
         paid_at,
         created_at
       FROM affiliate_commission_payout_batches
       WHERE id = ? AND affiliate_id = ?
       LIMIT 1`,
    )
    .bind(cleanBatchId, affiliate.id)
    .first<{
      readonly id: string;
      readonly payout_period_key: string;
      readonly total_amount_idr: number;
      readonly entry_count: number;
      readonly status: AffiliatePayoutBatchStatus;
      readonly transfer_reference: string | null;
      readonly paid_at: number | null;
      readonly created_at: number;
    }>();

  if (!batchRow) return null;

  const entryRows = await platformDb
    .prepare(
      `SELECT
         e.id,
         t.handle,
         e.entry_kind,
         e.net_base_idr,
         e.rate_bps,
         e.commission_idr,
         e.status,
         e.confirmed_at,
         e.hold_until_at,
         e.approved_at,
         e.reversed_at,
         e.payout_batch_id
       FROM affiliate_commission_entries e
       LEFT JOIN tenants t ON t.id = e.tenant_id
       WHERE e.payout_batch_id = ? AND e.affiliate_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 200`,
    )
    .bind(batchRow.id, affiliate.id)
    .all<CommissionWithHandleRow>();

  return {
    batch: {
      id: batchRow.id,
      payoutPeriodKey: batchRow.payout_period_key,
      totalAmountIdr: Number(batchRow.total_amount_idr ?? 0),
      entryCount: Number(batchRow.entry_count ?? 0),
      status: batchRow.status,
      transferReference: batchRow.transfer_reference,
      paidAt: batchRow.paid_at !== null ? new Date(batchRow.paid_at).toISOString() : null,
      payoutBankCode: affiliate.payoutBankCode,
      payoutAccountMasked: affiliate.payoutAccountMasked,
      createdAt: new Date(batchRow.created_at).toISOString(),
    },
    entries: (entryRows.results ?? []).map((row) => ({
      id: row.id,
      maskedHandle: row.handle ? maskReferredTenantHandle(row.handle) : "***",
      entryKind: row.entry_kind,
      netBaseIdr: Number(row.net_base_idr ?? 0),
      rateBps: Number(row.rate_bps ?? 0),
      commissionIdr: Number(row.commission_idr ?? 0),
      status: row.status,
      confirmedAt: new Date(row.confirmed_at).toISOString(),
      holdUntilAt: new Date(row.hold_until_at).toISOString(),
      approvedAt: row.approved_at !== null ? new Date(row.approved_at).toISOString() : null,
      reversedAt: row.reversed_at !== null ? new Date(row.reversed_at).toISOString() : null,
      payoutBatchId: row.payout_batch_id,
    })),
  };
}

export function mapAffiliatePortalErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof AffiliateError) {
    return affiliateErrorResponse(err.status, err.code, err.message, requestId, {
      ...(err.field ? { field: err.field } : {}),
    });
  }
  return affiliateErrorResponse(
    500,
    "INTERNAL_ERROR",
    "Terjadi kesalahan internal saat memuat Portal Afiliasi.",
    requestId,
  );
}

export function formatAffiliateStatusLabelId(status: AffiliateDbStatus): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "pending":
      return "Menunggu Persetujuan";
    case "suspended":
      return "Ditangguhkan";
    case "rejected":
      return "Ditolak";
  }
}
