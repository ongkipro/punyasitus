import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  mapPlatformErrorToResponse,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
  type VerifiedPlatformOperatorContext,
} from "@punyasitus/auth/platform/index";
import type { AffiliatePayoutBatchStatus } from "@punyasitus/core/affiliates/commission";
import {
  AFFILIATE_PENDING_CODE_PREFIX,
  buildAffiliateReferralLink,
  DEFAULT_AFFILIATE_MARKETING_ORIGIN,
  normalizeAffiliateReferralCode,
  type AffiliateDbStatus,
} from "@punyasitus/core/affiliates/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  AffiliateError,
  approveAffiliate,
  getAffiliateById,
  rejectAffiliate,
  suspendAffiliate,
} from "@punyasitus/db/affiliates/index";
import {
  AffiliateLedgerError,
  getAffiliateCommissionBalanceSummary,
  listAffiliatePayoutBatches,
} from "@punyasitus/db/affiliates/ledger/index";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "@punyasitus/db/platform";

/**
 * Shared console affiliate DTOs, REQ-095 compliance gate evaluator, spreadsheet
 * formula-injection-safe CSV serializers, RBAC guard, and audited mutation helpers
 * for `/console/affiliates` & `/api/console/affiliates/**` (REQ-086, REQ-095,
 * REQ-051, REQ-068, PLAN §19.4, TASK-086).
 */

export const AFFILIATE_COMPLIANCE_SETTINGS_KEY = "affiliate.payout_compliance" as const;

export const CONSOLE_AFFILIATE_DASHBOARD_MAX_ROWS = 200;
export const CONSOLE_AFFILIATE_CSV_MAX_ROWS = 5_000;
export const CONSOLE_AFFILIATE_CSV_MAX_OFFSET = 1_000_000;

export interface BoundedExportPage<T> {
  readonly rows: readonly T[];
  readonly rowCount: number;
  readonly maxRows: number;
  readonly offset: number;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export function parseConsoleCsvExportOffset(raw: string | null): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(CONSOLE_AFFILIATE_CSV_MAX_OFFSET, parsed);
}

export function resolveConsoleCsvMaxRows(
  rawQueryLimit: string | null,
  configuredMaxRows?: number,
): number {
  const ceiling =
    typeof configuredMaxRows === "number" && Number.isFinite(configuredMaxRows)
      ? Math.max(1, Math.min(CONSOLE_AFFILIATE_CSV_MAX_ROWS, Math.trunc(configuredMaxRows)))
      : CONSOLE_AFFILIATE_CSV_MAX_ROWS;
  if (!rawQueryLimit) return ceiling;
  const trimmed = rawQueryLimit.trim();
  if (!/^\d+$/.test(trimmed)) return ceiling;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return ceiling;
  return Math.min(ceiling, parsed);
}

export function finalizeBoundedExportPage<T>(
  fetchedPlusOneRows: readonly T[],
  maxRows: number,
  offset = 0,
): BoundedExportPage<T> {
  const safeMax = Math.max(1, Math.trunc(maxRows));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const truncated = fetchedPlusOneRows.length > safeMax;
  const rows = truncated ? fetchedPlusOneRows.slice(0, safeMax) : fetchedPlusOneRows;
  return {
    rows,
    rowCount: rows.length,
    maxRows: safeMax,
    offset: safeOffset,
    truncated,
    nextOffset: truncated ? safeOffset + rows.length : null,
  };
}

const CSV_FORMULA_PREFIX_RE = /^[\s]*[=+\-@\t\r]/;
const CSV_LEADING_CONTROL_RE = /^[\t\r]/;

export interface PlatformAffiliateComplianceState {
  readonly affiliateTermsPublished: boolean;
  readonly affiliateTaxReviewCompleted: boolean;
  readonly resolved: boolean;
  readonly resolvedAt: string | null;
  readonly resolvedByUserId: string | null;
  readonly notes: string | null;
  readonly missing: readonly string[];
}

export interface AffiliatePayoutComplianceCheck {
  readonly resolved: boolean;
  readonly affiliateTermsAccepted: boolean;
  readonly affiliateTermsVersion: string;
  readonly affiliateTermsAcceptedAt: string | null;
  readonly affiliatePayoutAccountReady: boolean;
  readonly platformCompliance: PlatformAffiliateComplianceState;
  readonly missing: readonly string[];
}

export interface ConsoleAffiliateDto {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly status: AffiliateDbStatus;
  readonly referralCode: string | null;
  readonly referralLink: string | null;
  readonly payoutBankCode: string;
  readonly payoutAccountHolder: string;
  readonly payoutAccountMasked: string;
  readonly termsVersion: string;
  readonly termsAcceptedAt: string | null;
  readonly hasTermsAccepted: boolean;
  readonly visitsCount: number;
  readonly referralsCount: number;
  readonly payingTenantsCount: number;
  readonly balances: {
    readonly pendingIdr: number;
    readonly approvedAvailableIdr: number;
    readonly batchedIdr: number;
    readonly paidIdr: number;
    readonly reversedIdr: number;
  };
  readonly approvedAt: string | null;
  readonly suspendedAt: string | null;
  readonly rejectedAt: string | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsoleAffiliatePayoutBatchDto {
  readonly id: string;
  readonly affiliateId: string;
  readonly affiliateEmail: string;
  readonly affiliateReferralCode: string | null;
  readonly affiliateStatus: AffiliateDbStatus;
  readonly affiliateHasTermsAccepted: boolean;
  readonly payoutBankCode: string;
  readonly payoutAccountHolder: string;
  readonly payoutAccountMasked: string;
  readonly payoutPeriodKey: string;
  readonly totalAmountIdr: number;
  readonly entryCount: number;
  readonly status: AffiliatePayoutBatchStatus;
  readonly transferReference: string | null;
  readonly paidAt: string | null;
  readonly paidByUserId: string | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsoleAffiliatesDashboardData {
  readonly affiliates: readonly ConsoleAffiliateDto[];
  readonly batches: readonly ConsoleAffiliatePayoutBatchDto[];
  readonly compliance: PlatformAffiliateComplianceState;
  readonly summary: {
    readonly totalAffiliates: number;
    readonly pendingAffiliates: number;
    readonly activeAffiliates: number;
    readonly suspendedAffiliates: number;
    readonly pendingReviewBatches: number;
    readonly pendingReviewTotalIdr: number;
    readonly paidTotalIdr: number;
  };
}

export function resolveConsoleAffiliatesRuntimeEnv(
  rawEnv: Readonly<Record<string, unknown>>,
): ConsoleRuntimeEnv {
  return {
    APP_ENV: typeof rawEnv.APP_ENV === "string" ? rawEnv.APP_ENV : undefined,
    PLATFORM_DOMAIN:
      typeof rawEnv.PLATFORM_DOMAIN === "string" ? rawEnv.PLATFORM_DOMAIN : undefined,
    PLATFORM_DB: (rawEnv.PLATFORM_DB as D1Database | undefined) ?? undefined,
    AUTH_SECRET: typeof rawEnv.AUTH_SECRET === "string" ? rawEnv.AUTH_SECRET : undefined,
    CONSOLE_AUTH_SECRET:
      typeof rawEnv.CONSOLE_AUTH_SECRET === "string" ? rawEnv.CONSOLE_AUTH_SECRET : undefined,
    EMAIL: rawEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
  };
}

export function resolveConsoleMarketingOrigin(runtimeEnv: ConsoleRuntimeEnv): string {
  const domain = runtimeEnv.PLATFORM_DOMAIN?.trim().toLowerCase();
  if (!domain) return DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  return `https://${domain}`;
}

/**
 * Operator RBAC check for affiliate status/payout/compliance mutations:
 * Only active `platform_superadmin` operators may approve/suspend affiliates,
 * mark payout batches paid, or update compliance gates.
 */
export function assertConsoleAffiliateSuperadminRole(
  actor: VerifiedPlatformOperatorContext,
  requestId: string,
): Response | null {
  if (actor.grant.role !== "platform_superadmin") {
    return consoleErrorResponse(
      403,
      "FORBIDDEN",
      "Hanya operator dengan peran platform_superadmin yang diizinkan mengubah status afiliasi atau menandai payout dibayar.",
      requestId,
    );
  }
  return null;
}

export function mapConsoleAffiliateErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof AffiliateError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      ...(err.field ? { field: err.field } : {}),
    });
  }
  if (err instanceof AffiliateLedgerError) {
    return consoleErrorResponse(err.status, err.code, err.message, requestId, {
      ...(err.field ? { field: err.field } : {}),
    });
  }
  return mapPlatformErrorToResponse(err, requestId);
}

/**
 * Neutralizes spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`) and
 * applies RFC 4180 CSV quoting. Safe for Excel, Google Sheets, and LibreOffice Calc.
 */
export function sanitizeCsvCell(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let str = String(raw);
  if (CSV_LEADING_CONTROL_RE.test(str) || CSV_FORMULA_PREFIX_RE.test(str)) {
    str = `'${str}`;
  }
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeConsoleAffiliatesCsv(affiliates: readonly ConsoleAffiliateDto[]): string {
  const header = [
    "affiliate_id",
    "email",
    "status",
    "referral_code",
    "payout_bank_code",
    "payout_account_holder",
    "payout_account_masked",
    "terms_version",
    "terms_accepted_at",
    "visits_count",
    "referrals_count",
    "paying_tenants_count",
    "pending_idr",
    "approved_available_idr",
    "batched_idr",
    "paid_idr",
    "reversed_idr",
    "created_at",
  ].join(",");

  const rows = affiliates.map((a) =>
    [
      sanitizeCsvCell(a.id),
      sanitizeCsvCell(a.email),
      sanitizeCsvCell(a.status),
      sanitizeCsvCell(a.referralCode ?? ""),
      sanitizeCsvCell(a.payoutBankCode),
      sanitizeCsvCell(a.payoutAccountHolder),
      sanitizeCsvCell(a.payoutAccountMasked),
      sanitizeCsvCell(a.termsVersion),
      sanitizeCsvCell(a.termsAcceptedAt ?? ""),
      String(a.visitsCount),
      String(a.referralsCount),
      String(a.payingTenantsCount),
      String(a.balances.pendingIdr),
      String(a.balances.approvedAvailableIdr),
      String(a.balances.batchedIdr),
      String(a.balances.paidIdr),
      String(a.balances.reversedIdr),
      sanitizeCsvCell(a.createdAt),
    ].join(","),
  );

  return [header, ...rows].join("\r\n") + "\r\n";
}

export function serializeConsolePayoutBatchesCsv(
  batches: readonly ConsoleAffiliatePayoutBatchDto[],
): string {
  const header = [
    "batch_id",
    "payout_period_key",
    "status",
    "affiliate_id",
    "affiliate_email",
    "affiliate_referral_code",
    "payout_bank_code",
    "payout_account_holder",
    "payout_account_masked",
    "total_amount_idr",
    "entry_count",
    "transfer_reference",
    "paid_at",
    "status_reason",
    "created_at",
  ].join(",");

  const rows = batches.map((b) =>
    [
      sanitizeCsvCell(b.id),
      sanitizeCsvCell(b.payoutPeriodKey),
      sanitizeCsvCell(b.status),
      sanitizeCsvCell(b.affiliateId),
      sanitizeCsvCell(b.affiliateEmail),
      sanitizeCsvCell(b.affiliateReferralCode ?? ""),
      sanitizeCsvCell(b.payoutBankCode),
      sanitizeCsvCell(b.payoutAccountHolder),
      sanitizeCsvCell(b.payoutAccountMasked),
      String(b.totalAmountIdr),
      String(b.entryCount),
      sanitizeCsvCell(b.transferReference ?? ""),
      sanitizeCsvCell(b.paidAt ?? ""),
      sanitizeCsvCell(b.statusReason ?? ""),
      sanitizeCsvCell(b.createdAt),
    ].join(","),
  );

  return [header, ...rows].join("\r\n") + "\r\n";
}

/**
 * Reads platform-level REQ-095 affiliate tax & terms compliance resolution from `platform_settings`.
 */
export async function loadPlatformAffiliateComplianceState(
  platformDb: D1Database,
): Promise<PlatformAffiliateComplianceState> {
  const row = await platformDb
    .prepare("SELECT value_json FROM platform_settings WHERE key = ? LIMIT 1")
    .bind(AFFILIATE_COMPLIANCE_SETTINGS_KEY)
    .first<{ readonly value_json: string }>();

  let affiliateTermsPublished = false;
  let affiliateTaxReviewCompleted = false;
  let resolvedAt: string | null = null;
  let resolvedByUserId: string | null = null;
  let notes: string | null = null;

  if (row?.value_json) {
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
      affiliateTermsPublished = parsed.affiliateTermsPublished === true;
      affiliateTaxReviewCompleted = parsed.affiliateTaxReviewCompleted === true;
      if (typeof parsed.resolvedAt === "number" && Number.isFinite(parsed.resolvedAt)) {
        resolvedAt = new Date(parsed.resolvedAt).toISOString();
      } else if (typeof parsed.resolvedAt === "string" && parsed.resolvedAt.trim()) {
        resolvedAt = parsed.resolvedAt.trim();
      }
      if (typeof parsed.resolvedByUserId === "string" && parsed.resolvedByUserId.trim()) {
        resolvedByUserId = parsed.resolvedByUserId.trim();
      }
      if (typeof parsed.notes === "string" && parsed.notes.trim()) {
        notes = parsed.notes.trim();
      }
    } catch {
      // Malformed JSON fails closed (unresolved)
    }
  }

  const missing: string[] = [];
  if (!affiliateTermsPublished) missing.push("platform_affiliate_terms_pending");
  if (!affiliateTaxReviewCompleted) missing.push("platform_affiliate_tax_review_pending");

  return {
    affiliateTermsPublished,
    affiliateTaxReviewCompleted,
    resolved: missing.length === 0,
    resolvedAt,
    resolvedByUserId,
    notes,
    missing,
  };
}

/**
 * Evaluates the full REQ-095 tax & terms payout gate for a specific affiliate before
 * any payout batch can be marked paid.
 */
export async function evaluateAffiliatePayoutCompliance(
  platformDb: D1Database,
  affiliateId: string,
): Promise<AffiliatePayoutComplianceCheck> {
  const [platformCompliance, profileRow] = await Promise.all([
    loadPlatformAffiliateComplianceState(platformDb),
    platformDb
      .prepare(
        `SELECT
           terms_version,
           terms_accepted_at,
           payout_bank_code,
           payout_account_holder,
           payout_account_masked
         FROM affiliate_enrollment_profiles
         WHERE affiliate_id = ?
         LIMIT 1`,
      )
      .bind(affiliateId.trim())
      .first<{
        readonly terms_version: string | null;
        readonly terms_accepted_at: number | null;
        readonly payout_bank_code: string | null;
        readonly payout_account_holder: string | null;
        readonly payout_account_masked: string | null;
      }>(),
  ]);

  const affiliateTermsVersion = profileRow?.terms_version?.trim() ?? "";
  const affiliateTermsAccepted =
    Boolean(profileRow) &&
    typeof profileRow!.terms_accepted_at === "number" &&
    Number.isFinite(profileRow!.terms_accepted_at) &&
    profileRow!.terms_accepted_at > 0 &&
    affiliateTermsVersion.length > 0;

  const affiliatePayoutAccountReady =
    Boolean(profileRow) &&
    (profileRow!.payout_bank_code?.trim().length ?? 0) > 0 &&
    (profileRow!.payout_account_holder?.trim().length ?? 0) > 0 &&
    (profileRow!.payout_account_masked?.trim().length ?? 0) > 0;

  const missing: string[] = [...platformCompliance.missing];
  if (!affiliateTermsAccepted) missing.push("affiliate_terms_not_accepted");
  if (!affiliatePayoutAccountReady) missing.push("affiliate_payout_account_incomplete");

  return {
    resolved: missing.length === 0,
    affiliateTermsAccepted,
    affiliateTermsVersion,
    affiliateTermsAcceptedAt:
      affiliateTermsAccepted && profileRow?.terms_accepted_at
        ? new Date(profileRow.terms_accepted_at).toISOString()
        : null,
    affiliatePayoutAccountReady,
    platformCompliance,
    missing,
  };
}

/**
 * Atomically updates platform REQ-095 affiliate tax & terms compliance in `platform_settings`
 * alongside an audited `platform_audit` row.
 */
export async function updatePlatformAffiliateCompliance(
  platformDb: D1Database,
  input: {
    readonly actorUserId: string;
    readonly affiliateTermsPublished: boolean;
    readonly affiliateTaxReviewCompleted: boolean;
    readonly notes?: string | null;
    readonly reason: string;
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<{
  readonly compliance: PlatformAffiliateComplianceState;
  readonly audit: PlatformAuditRecord;
}> {
  let validatedReason: string;
  try {
    validatedReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new AffiliateError(422, "VALIDATION_ERROR", err.message, {
        field: "reason",
        cause: err,
      });
    }
    throw err;
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const cleanNotes =
    typeof input.notes === "string" && input.notes.trim().length > 0
      ? input.notes.trim().slice(0, 300)
      : null;
  const resolved = input.affiliateTermsPublished && input.affiliateTaxReviewCompleted;

  const valueJson = JSON.stringify({
    affiliateTermsPublished: input.affiliateTermsPublished,
    affiliateTaxReviewCompleted: input.affiliateTaxReviewCompleted,
    resolvedAt: resolved ? nowMs : null,
    resolvedByUserId: resolved ? input.actorUserId : null,
    notes: cleanNotes,
  });

  const upsertStmt = platformDb
    .prepare(
      `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         version = version + 1,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(AFFILIATE_COMPLIANCE_SETTINGS_KEY, valueJson, input.actorUserId, nowMs);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(platformDb, {
    actorUserId: input.actorUserId,
    actorRole: "platform_operator",
    action: "console.affiliate.compliance.update",
    targetType: "platform_settings",
    targetId: AFFILIATE_COMPLIANCE_SETTINGS_KEY,
    reason: validatedReason,
    requireReason: true,
    outcome: "success",
    requestId: input.requestId ?? null,
    createdAtMs: nowMs,
    metadata: {
      affiliateTermsPublished: input.affiliateTermsPublished,
      affiliateTaxReviewCompleted: input.affiliateTaxReviewCompleted,
      resolved,
    },
  });

  await platformDb.batch([upsertStmt, auditStmt]);

  const compliance = await loadPlatformAffiliateComplianceState(platformDb);
  return { compliance, audit };
}

interface ConsoleAffiliateListSqlRow {
  readonly id: string;
  readonly user_id: string;
  readonly referral_code: string;
  readonly status: AffiliateDbStatus;
  readonly payout_method: string | null;
  readonly payout_account_name: string | null;
  readonly payout_account_number: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly user_email: string | null;
  readonly profile_email: string | null;
  readonly approved_referral_code: string | null;
  readonly payout_bank_code: string | null;
  readonly payout_account_holder: string | null;
  readonly payout_account_masked: string | null;
  readonly terms_version: string | null;
  readonly terms_accepted_at: number | null;
  readonly approved_at: number | null;
  readonly suspended_at: number | null;
  readonly rejected_at: number | null;
  readonly status_reason: string | null;
  readonly visits_count: number;
  readonly referrals_count: number;
  readonly paying_tenants_count: number;
  readonly pending_idr: number;
  readonly approved_available_idr: number;
  readonly batched_idr: number;
  readonly paid_idr: number;
  readonly reversed_idr: number;
}

interface ConsoleBatchListSqlRow {
  readonly id: string;
  readonly affiliate_id: string;
  readonly payout_period_key: string;
  readonly total_amount_idr: number;
  readonly entry_count: number;
  readonly status: AffiliatePayoutBatchStatus;
  readonly transfer_reference: string | null;
  readonly paid_at: number | null;
  readonly paid_by_user_id: string | null;
  readonly status_reason: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly affiliate_status: AffiliateDbStatus;
  readonly referral_code: string;
  readonly approved_referral_code: string | null;
  readonly user_email: string | null;
  readonly profile_email: string | null;
  readonly payout_method: string | null;
  readonly payout_account_name: string | null;
  readonly payout_account_number: string | null;
  readonly payout_bank_code: string | null;
  readonly payout_account_holder: string | null;
  readonly payout_account_masked: string | null;
  readonly terms_version: string | null;
  readonly terms_accepted_at: number | null;
}

function resolvePublicCode(rawCode: string, approvedCode: string | null): string | null {
  const candidate = approvedCode ?? rawCode;
  if (!candidate || candidate.toLowerCase().startsWith(AFFILIATE_PENDING_CODE_PREFIX)) {
    return null;
  }
  return normalizeAffiliateReferralCode(candidate);
}

function mapConsoleAffiliateSqlRow(
  row: ConsoleAffiliateListSqlRow,
  marketingOrigin: string,
): ConsoleAffiliateDto {
  const publicCode = resolvePublicCode(row.referral_code, row.approved_referral_code);
  const referralLink =
    row.status === "active" && publicCode
      ? buildAffiliateReferralLink(publicCode, marketingOrigin)
      : null;
  const hasTermsAccepted =
    typeof row.terms_accepted_at === "number" &&
    row.terms_accepted_at > 0 &&
    (row.terms_version?.trim().length ?? 0) > 0;

  return {
    id: row.id,
    userId: row.user_id,
    email: row.profile_email ?? row.user_email ?? "",
    status: row.status,
    referralCode: publicCode,
    referralLink,
    payoutBankCode: row.payout_bank_code ?? row.payout_method ?? "",
    payoutAccountHolder: row.payout_account_holder ?? row.payout_account_name ?? "",
    payoutAccountMasked: row.payout_account_masked ?? row.payout_account_number ?? "",
    termsVersion: row.terms_version ?? "",
    termsAcceptedAt:
      hasTermsAccepted && row.terms_accepted_at
        ? new Date(row.terms_accepted_at).toISOString()
        : null,
    hasTermsAccepted,
    visitsCount: Number(row.visits_count ?? 0),
    referralsCount: Number(row.referrals_count ?? 0),
    payingTenantsCount: Number(row.paying_tenants_count ?? 0),
    balances: {
      pendingIdr: Number(row.pending_idr ?? 0),
      approvedAvailableIdr: Number(row.approved_available_idr ?? 0),
      batchedIdr: Number(row.batched_idr ?? 0),
      paidIdr: Number(row.paid_idr ?? 0),
      reversedIdr: Number(row.reversed_idr ?? 0),
    },
    approvedAt: row.approved_at !== null ? new Date(row.approved_at).toISOString() : null,
    suspendedAt: row.suspended_at !== null ? new Date(row.suspended_at).toISOString() : null,
    rejectedAt: row.rejected_at !== null ? new Date(row.rejected_at).toISOString() : null,
    statusReason: row.status_reason ?? null,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapConsoleBatchSqlRow(row: ConsoleBatchListSqlRow): ConsoleAffiliatePayoutBatchDto {
  const publicCode = resolvePublicCode(row.referral_code, row.approved_referral_code);
  const affiliateHasTermsAccepted =
    typeof row.terms_accepted_at === "number" &&
    row.terms_accepted_at > 0 &&
    (row.terms_version?.trim().length ?? 0) > 0;

  return {
    id: row.id,
    affiliateId: row.affiliate_id,
    affiliateEmail: row.profile_email ?? row.user_email ?? "",
    affiliateReferralCode: publicCode,
    affiliateStatus: row.affiliate_status,
    affiliateHasTermsAccepted,
    payoutBankCode: row.payout_bank_code ?? row.payout_method ?? "",
    payoutAccountHolder: row.payout_account_holder ?? row.payout_account_name ?? "",
    payoutAccountMasked: row.payout_account_masked ?? row.payout_account_number ?? "",
    payoutPeriodKey: row.payout_period_key,
    totalAmountIdr: Number(row.total_amount_idr ?? 0),
    entryCount: Number(row.entry_count ?? 0),
    status: row.status,
    transferReference: row.transfer_reference,
    paidAt: row.paid_at !== null ? new Date(row.paid_at).toISOString() : null,
    paidByUserId: row.paid_by_user_id,
    statusReason: row.status_reason,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function queryConsoleAffiliateRows(
  platformDb: D1Database,
  params: {
    readonly status?: AffiliateDbStatus;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<readonly ConsoleAffiliateListSqlRow[]> {
  const affWhere = params.status ? "WHERE a.status = ?" : "";
  const affBindings: (string | number)[] = params.status
    ? [params.status, params.limit, params.offset]
    : [params.limit, params.offset];

  const affRows = await platformDb
    .prepare(
      `SELECT
         a.id,
         a.user_id,
         a.referral_code,
         a.status,
         a.payout_method,
         a.payout_account_name,
         a.payout_account_number,
         a.version,
         a.created_at,
         a.updated_at,
         u.email AS user_email,
         p.email AS profile_email,
         p.approved_referral_code,
         p.payout_bank_code,
         p.payout_account_holder,
         p.payout_account_masked,
         p.terms_version,
         p.terms_accepted_at,
         p.approved_at,
         p.suspended_at,
         p.rejected_at,
         p.status_reason,
         COALESCE((SELECT SUM(v.visit_count) FROM affiliate_funnel_visits v WHERE v.affiliate_id = a.id), 0) AS visits_count,
         COALESCE((SELECT COUNT(*) FROM affiliate_referrals r WHERE r.affiliate_id = a.id), 0) AS referrals_count,
         COALESCE((SELECT COUNT(DISTINCT e2.tenant_id) FROM affiliate_commission_entries e2 WHERE e2.affiliate_id = a.id AND e2.entry_kind IN ('first_payment', 'renewal') AND e2.status != 'reversed'), 0) AS paying_tenants_count,
         COALESCE((SELECT SUM(CASE WHEN e.status = 'pending' THEN e.commission_idr ELSE 0 END) FROM affiliate_commission_entries e WHERE e.affiliate_id = a.id), 0) AS pending_idr,
         COALESCE((SELECT SUM(CASE WHEN e.status = 'approved' AND e.payout_batch_id IS NULL THEN e.commission_idr ELSE 0 END) FROM affiliate_commission_entries e WHERE e.affiliate_id = a.id), 0) AS approved_available_idr,
         COALESCE((SELECT SUM(CASE WHEN e.status = 'batched' THEN e.commission_idr ELSE 0 END) FROM affiliate_commission_entries e WHERE e.affiliate_id = a.id), 0) AS batched_idr,
         COALESCE((SELECT SUM(CASE WHEN e.status = 'paid' THEN e.commission_idr ELSE 0 END) FROM affiliate_commission_entries e WHERE e.affiliate_id = a.id), 0) AS paid_idr,
         COALESCE((SELECT SUM(CASE WHEN e.status = 'reversed' THEN e.commission_idr ELSE 0 END) FROM affiliate_commission_entries e WHERE e.affiliate_id = a.id), 0) AS reversed_idr
       FROM affiliates a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN affiliate_enrollment_profiles p ON p.affiliate_id = a.id
       ${affWhere}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...affBindings)
    .all<ConsoleAffiliateListSqlRow>();

  return affRows.results ?? [];
}

async function queryConsoleBatchRows(
  platformDb: D1Database,
  params: {
    readonly batchStatus?: AffiliatePayoutBatchStatus;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<readonly ConsoleBatchListSqlRow[]> {
  const batchWhere = params.batchStatus ? "WHERE b.status = ?" : "";
  const batchBindings: (string | number)[] = params.batchStatus
    ? [params.batchStatus, params.limit, params.offset]
    : [params.limit, params.offset];

  const batchRows = await platformDb
    .prepare(
      `SELECT
         b.id,
         b.affiliate_id,
         b.payout_period_key,
         b.total_amount_idr,
         b.entry_count,
         b.status,
         b.transfer_reference,
         b.paid_at,
         b.paid_by_user_id,
         b.status_reason,
         b.version,
         b.created_at,
         b.updated_at,
         a.status AS affiliate_status,
         a.referral_code,
         p.approved_referral_code,
         u.email AS user_email,
         p.email AS profile_email,
         a.payout_method,
         a.payout_account_name,
         a.payout_account_number,
         p.payout_bank_code,
         p.payout_account_holder,
         p.payout_account_masked,
         p.terms_version,
         p.terms_accepted_at
       FROM affiliate_commission_payout_batches b
       INNER JOIN affiliates a ON a.id = b.affiliate_id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN affiliate_enrollment_profiles p ON p.affiliate_id = a.id
       ${batchWhere}
       ORDER BY
         CASE b.status WHEN 'pending_review' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END ASC,
         b.payout_period_key DESC,
         b.created_at DESC,
         b.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...batchBindings)
    .all<ConsoleBatchListSqlRow>();

  return batchRows.results ?? [];
}

/**
 * Loads a single bounded CSV export page for either affiliates or payout batches,
 * querying `maxRows + 1` rows so truncation is known authoritatively (SEC-004).
 */
export async function loadConsoleAffiliatesCsvExport(
  platformDb: D1Database,
  options: {
    readonly scope: "affiliates" | "batches";
    readonly status?: AffiliateDbStatus;
    readonly batchStatus?: AffiliatePayoutBatchStatus;
    readonly marketingOrigin?: string;
    readonly maxRows?: number;
    readonly offset?: number;
  },
): Promise<
  | ({ readonly scope: "affiliates" } & BoundedExportPage<ConsoleAffiliateDto>)
  | ({ readonly scope: "batches" } & BoundedExportPage<ConsoleAffiliatePayoutBatchDto>)
> {
  const marketingOrigin = options.marketingOrigin ?? DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  const maxRows = Math.max(
    1,
    Math.min(CONSOLE_AFFILIATE_CSV_MAX_ROWS, Math.trunc(options.maxRows ?? CONSOLE_AFFILIATE_CSV_MAX_ROWS)),
  );
  const offset = Math.max(
    0,
    Math.min(CONSOLE_AFFILIATE_CSV_MAX_OFFSET, Math.trunc(options.offset ?? 0)),
  );

  if (options.scope === "batches") {
    const rawRows = await queryConsoleBatchRows(platformDb, {
      batchStatus: options.batchStatus,
      limit: maxRows + 1,
      offset,
    });
    const mapped = rawRows.map(mapConsoleBatchSqlRow);
    return {
      scope: "batches",
      ...finalizeBoundedExportPage(mapped, maxRows, offset),
    };
  }

  const rawRows = await queryConsoleAffiliateRows(platformDb, {
    status: options.status,
    limit: maxRows + 1,
    offset,
  });
  const mapped = rawRows.map((row) => mapConsoleAffiliateSqlRow(row, marketingOrigin));
  return {
    scope: "affiliates",
    ...finalizeBoundedExportPage(mapped, maxRows, offset),
  };
}

/**
 * Loads the complete Console Affiliates & Payout Batches dataset with optional status filters.
 */
export async function loadConsoleAffiliatesDashboard(
  platformDb: D1Database,
  options: {
    readonly status?: AffiliateDbStatus;
    readonly batchStatus?: AffiliatePayoutBatchStatus;
    readonly marketingOrigin?: string;
    readonly limit?: number;
  } = {},
): Promise<ConsoleAffiliatesDashboardData> {
  const marketingOrigin = options.marketingOrigin ?? DEFAULT_AFFILIATE_MARKETING_ORIGIN;
  const limit = Math.max(
    1,
    Math.min(CONSOLE_AFFILIATE_DASHBOARD_MAX_ROWS, Math.trunc(options.limit ?? 100)),
  );

  const [affRawRows, batchRawRows, compliance] = await Promise.all([
    queryConsoleAffiliateRows(platformDb, { status: options.status, limit, offset: 0 }),
    queryConsoleBatchRows(platformDb, { batchStatus: options.batchStatus, limit, offset: 0 }),
    loadPlatformAffiliateComplianceState(platformDb),
  ]);

  const affiliates: ConsoleAffiliateDto[] = affRawRows.map((row) =>
    mapConsoleAffiliateSqlRow(row, marketingOrigin),
  );
  const batches: ConsoleAffiliatePayoutBatchDto[] = batchRawRows.map(mapConsoleBatchSqlRow);

  let pendingAffiliates = 0;
  let activeAffiliates = 0;
  let suspendedAffiliates = 0;
  for (const a of affiliates) {
    if (a.status === "pending") pendingAffiliates += 1;
    else if (a.status === "active") activeAffiliates += 1;
    else if (a.status === "suspended") suspendedAffiliates += 1;
  }

  let pendingReviewBatches = 0;
  let pendingReviewTotalIdr = 0;
  let paidTotalIdr = 0;
  for (const b of batches) {
    if (b.status === "pending_review") {
      pendingReviewBatches += 1;
      pendingReviewTotalIdr += b.totalAmountIdr;
    } else if (b.status === "paid") {
      paidTotalIdr += b.totalAmountIdr;
    }
  }

  return {
    affiliates,
    batches,
    compliance,
    summary: {
      totalAffiliates: affiliates.length,
      pendingAffiliates,
      activeAffiliates,
      suspendedAffiliates,
      pendingReviewBatches,
      pendingReviewTotalIdr,
      paidTotalIdr,
    },
  };
}

const AFFILIATE_STATUS_MUTATION_ALLOWED_KEYS = new Set([
  "action",
  "reason",
  "expectedVersion",
  "referralCode",
]);

/**
 * Shared handler for `POST /api/console/affiliates/[affiliateId]/status` and
 * `PATCH /api/console/affiliates/[affiliateId]`.
 *
 * Enforces:
 * - Console host isolation + CSRF/Origin
 * - Active `platform_superadmin` operator + fresh 10-minute 2FA step-up
 * - Mandatory `reason` (10–500 chars) + OCC `expectedVersion` (required positive integer)
 * - Atomic `platform_audit` written by `approveAffiliate` / `suspendAffiliate` / `rejectAffiliate`
 */
export async function handleConsoleAffiliateStatusMutation(
  affiliateId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.status", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const rbacErr = assertConsoleAffiliateSuperadminRole(authz.ctx.actor, authz.ctx.requestId);
  if (rbacErr) return rbacErr;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    AFFILIATE_STATUS_MUTATION_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  const rawAction = typeof parsed.body.action === "string" ? parsed.body.action.trim().toLowerCase() : "";
  if (rawAction !== "approve" && rawAction !== "suspend" && rawAction !== "reject") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field action wajib berupa approve, suspend, atau reject.",
      authz.ctx.requestId,
      { field: "action" },
    );
  }

  const rawExpectedVersion = parsed.body.expectedVersion;
  if (
    typeof rawExpectedVersion !== "number" ||
    !Number.isSafeInteger(rawExpectedVersion) ||
    rawExpectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif untuk proteksi konkurensi.",
      authz.ctx.requestId,
      { field: "expectedVersion" },
    );
  }

  const reason = typeof parsed.body.reason === "string" ? parsed.body.reason : "";
  const referralCode =
    typeof parsed.body.referralCode === "string" ? parsed.body.referralCode : undefined;
  const marketingOrigin = resolveConsoleMarketingOrigin(runtimeEnv);

  try {
    const result =
      rawAction === "approve"
        ? await approveAffiliate(authz.ctx.platformDb, {
            affiliateId,
            actorUserId: authz.ctx.user.id,
            reason,
            referralCode,
            expectedVersion: rawExpectedVersion,
            marketingOrigin,
            requestId: authz.ctx.requestId,
            nowMs: authz.ctx.nowMs,
          })
        : rawAction === "suspend"
          ? await suspendAffiliate(authz.ctx.platformDb, {
              affiliateId,
              actorUserId: authz.ctx.user.id,
              reason,
              expectedVersion: rawExpectedVersion,
              requestId: authz.ctx.requestId,
              nowMs: authz.ctx.nowMs,
            })
          : await rejectAffiliate(authz.ctx.platformDb, {
              affiliateId,
              actorUserId: authz.ctx.user.id,
              reason,
              expectedVersion: rawExpectedVersion,
              requestId: authz.ctx.requestId,
              nowMs: authz.ctx.nowMs,
            });

    const [balances, batches] = await Promise.all([
      getAffiliateCommissionBalanceSummary(authz.ctx.platformDb, result.affiliate.id),
      listAffiliatePayoutBatches(authz.ctx.platformDb, {
        affiliateId: result.affiliate.id,
        limit: 20,
      }),
    ]);

    return consoleJsonResponse(200, {
      success: true,
      action: rawAction,
      affiliate: {
        id: result.affiliate.id,
        userId: result.affiliate.userId,
        email: result.affiliate.email,
        status: result.affiliate.status,
        referralCode: result.affiliate.referralCode,
        referralLink: result.affiliate.referralLink,
        payoutBankCode: result.affiliate.payoutBankCode,
        payoutAccountHolder: result.affiliate.payoutAccountHolder,
        payoutAccountMasked: result.affiliate.payoutAccountMasked,
        termsVersion: result.affiliate.termsVersion,
        termsAcceptedAt:
          result.affiliate.termsAcceptedAt > 0
            ? new Date(result.affiliate.termsAcceptedAt).toISOString()
            : null,
        approvedAt:
          result.affiliate.approvedAt !== null
            ? new Date(result.affiliate.approvedAt).toISOString()
            : null,
        suspendedAt:
          result.affiliate.suspendedAt !== null
            ? new Date(result.affiliate.suspendedAt).toISOString()
            : null,
        rejectedAt:
          result.affiliate.rejectedAt !== null
            ? new Date(result.affiliate.rejectedAt).toISOString()
            : null,
        statusReason: result.affiliate.statusReason,
        version: result.affiliate.version,
        balances: {
          pendingIdr: balances.pendingIdr,
          approvedAvailableIdr: balances.approvedAvailableIdr,
          batchedIdr: balances.batchedIdr,
          paidIdr: balances.paidIdr,
          reversedIdr: balances.reversedIdr,
        },
        batchCount: batches.length,
        createdAt: new Date(result.affiliate.createdAt).toISOString(),
        updatedAt: new Date(result.affiliate.updatedAt).toISOString(),
      },
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleAffiliateErrorToResponse(err, authz.ctx.requestId);
  }
}

export async function handleConsoleAffiliateRead(
  affiliateId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.read", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  try {
    const affiliate = await getAffiliateById(
      authz.ctx.platformDb,
      affiliateId,
      resolveConsoleMarketingOrigin(runtimeEnv),
    );
    if (!affiliate) {
      return consoleErrorResponse(
        404,
        "AFFILIATE_NOT_FOUND",
        "Akun afiliasi tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    const [balances, batches, compliance] = await Promise.all([
      getAffiliateCommissionBalanceSummary(authz.ctx.platformDb, affiliate.id),
      listAffiliatePayoutBatches(authz.ctx.platformDb, { affiliateId: affiliate.id, limit: 50 }),
      evaluateAffiliatePayoutCompliance(authz.ctx.platformDb, affiliate.id),
    ]);

    return consoleJsonResponse(200, {
      success: true,
      affiliate: {
        id: affiliate.id,
        userId: affiliate.userId,
        email: affiliate.email,
        status: affiliate.status,
        referralCode: affiliate.referralCode,
        referralLink: affiliate.referralLink,
        payoutBankCode: affiliate.payoutBankCode,
        payoutAccountHolder: affiliate.payoutAccountHolder,
        payoutAccountMasked: affiliate.payoutAccountMasked,
        termsVersion: affiliate.termsVersion,
        termsAcceptedAt:
          affiliate.termsAcceptedAt > 0 ? new Date(affiliate.termsAcceptedAt).toISOString() : null,
        approvedAt:
          affiliate.approvedAt !== null ? new Date(affiliate.approvedAt).toISOString() : null,
        suspendedAt:
          affiliate.suspendedAt !== null ? new Date(affiliate.suspendedAt).toISOString() : null,
        rejectedAt:
          affiliate.rejectedAt !== null ? new Date(affiliate.rejectedAt).toISOString() : null,
        statusReason: affiliate.statusReason,
        version: affiliate.version,
        balances: {
          pendingIdr: balances.pendingIdr,
          approvedAvailableIdr: balances.approvedAvailableIdr,
          batchedIdr: balances.batchedIdr,
          paidIdr: balances.paidIdr,
          reversedIdr: balances.reversedIdr,
        },
        createdAt: new Date(affiliate.createdAt).toISOString(),
        updatedAt: new Date(affiliate.updatedAt).toISOString(),
      },
      compliance,
      batches: batches.map((b) => ({
        id: b.id,
        payoutPeriodKey: b.payoutPeriodKey,
        totalAmountIdr: b.totalAmountIdr,
        entryCount: b.entryCount,
        status: b.status,
        transferReference: b.transferReference,
        paidAt: b.paidAt !== null ? new Date(b.paidAt).toISOString() : null,
        statusReason: b.statusReason,
        version: b.version,
        createdAt: new Date(b.createdAt).toISOString(),
      })),
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleAffiliateErrorToResponse(err, authz.ctx.requestId);
  }
}
