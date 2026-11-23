import {
  assertTenantDomainSetCompatibility,
  assertTenantPaidForCustomDomain,
  assertValidCustomHostname,
  DomainConflictError,
  DomainEligibilityError,
  DomainNotFoundError,
  DomainValidationError,
  evaluateApexCapability,
  evaluateDcvTokenAge,
  MAX_CUSTOM_HOSTNAMES_PER_TENANT,
  normalizeConnectMode,
  resolveSslMethodForMode,
  type CloudflareCustomHostname,
  type DomainConnectMode,
  type DomainSslMethod,
} from "@punyasitus/core/domains/index";
import {
  REDACTED_VALUE,
  redactJobLogRecord,
  sanitizeErrorCode,
  type JobStatus,
} from "@punyasitus/core/jobs/index";
import {
  consumeDomainRecheckRateLimit,
  getTenantDomainBySelector,
  listTenantDomains,
  serializeSanitizedProviderSnapshot,
  type DomainRecheckRateLimitPolicy,
  type TenantDomainRecord,
} from "../domains/repository.ts";
import { ensureDomainMetadataSchema } from "../domains/schema.ts";
import {
  computeEffectiveTenantStatus,
  evictHostFromCache,
  evictTenantFromCache,
  type TenantHostStatus,
} from "../routing/resolver.ts";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  redactAuditMetadata,
  redactAuditText,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "./audit.ts";
import type { TenantStatus } from "./schema.ts";

/**
 * Superadmin Domain & Job Recovery Queue Repository (`packages/db/src/platform/recovery.ts`;
 * TASK-047, REQ-050, REQ-004, REQ-034, REQ-042, REQ-051, REQ-065; PLAN §13).
 *
 * Security & Atomicity Invariants:
 * - Narrow control-plane reads strictly from `PLATFORM_DB` (`tenant_hosts`, `tenant_host_metadata`,
 *   `tenants`, `job_ledger`) — NEVER opens `TenantStore` or exposes customer content/leads.
 * - Job queue reads NEVER expose raw `payload_json`; all payloads, keys, and error codes pass
 *   through multi-layer secret & PII redaction.
 * - Every mutating recovery operation commits state changes, append-only `platform_audit`
 *   (`WHERE changes() = 1`), and idempotency receipts inside ONE atomic `D1Database.batch([...])`.
 *   Follow-up batch statements gate strictly on unique per-request `platform_audit.id` or
 *   `job_ledger.idempotency_key` so losing concurrent writers mutate ZERO rows.
 * - Active job leases and completed jobs are NEVER stolen or retried (`409`); stale `queued` jobs
 *   (> 5 minutes without active lease) remain recoverable; operator retries enforce a bounded cap.
 * - Domain rechecks and domain changes enforce REQ-065 max-2 / single-domain-set compatibility,
 *   NEVER force-activate hostnames, NEVER bypass verification, NEVER rewrite `moved` to `pending`
 *   on timeout, and NEVER alter `tenants.status` or `tenants.operator_hold`.
 */

export const DEFAULT_RECOVERY_PAGE_LIMIT = 20 as const;
export const MAX_RECOVERY_PAGE_LIMIT = 100 as const;
export const DEFAULT_DOMAIN_STALE_CHECK_MS = 6 * 60 * 60 * 1000; // 6 hours
export const STALE_QUEUED_JOB_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_OPERATOR_JOB_RETRIES = 5 as const;

const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_REDACTED_SUMMARY_KEYS = 12;
const MAX_REDACTED_SUMMARY_STR_LEN = 120;

export type ConsoleRecoveryErrorCode =
  | "VALIDATION_ERROR"
  | "UNKNOWN_FIELD"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_LEASE_ACTIVE"
  | "JOB_ALREADY_COMPLETED"
  | "JOB_NOT_RETRYABLE"
  | "JOB_RETRY_LIMIT_REACHED"
  | "DOMAIN_NOT_CUSTOM"
  | "DOMAIN_CHANGE_CONFIRMATION_REQUIRED"
  | "TRIAL_DOMAIN_FORBIDDEN"
  | "TENANT_NOT_ELIGIBLE"
  | "DOMAIN_ALREADY_CLAIMED"
  | "DOMAIN_SET_MISMATCH"
  | "DOMAIN_LIMIT_REACHED"
  | "DOMAIN_CLEANUP_PENDING"
  | "RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "AUDIT_PERSISTENCE_FAILED";

export class ConsoleRecoveryError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  readonly code: ConsoleRecoveryErrorCode;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    status: 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    code: ConsoleRecoveryErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryAfterSeconds?: number;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ConsoleRecoveryError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.details = options?.details;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export function normalizeRecoveryIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ConsoleRecoveryError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib disertakan (8-128 karakter alfanumerik aman).",
    );
  }
  const clean = raw.trim();
  if (!SAFE_IDEMPOTENCY_KEY_RE.test(clean)) {
    throw new ConsoleRecoveryError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key harus terdiri dari 8-128 karakter aman (A-Z, a-z, 0-9, ., _, :, -).",
    );
  }
  return clean;
}

export function normalizeRecoveryReason(raw: unknown): string {
  try {
    return validateOperatorReason(raw);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ConsoleRecoveryError(422, "VALIDATION_ERROR", err.message, { cause: err });
    }
    throw err;
  }
}

export function normalizePositiveVersion(raw: unknown, fieldName = "expectedVersion"): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new ConsoleRecoveryError(
      422,
      "VALIDATION_ERROR",
      `Field ${fieldName} wajib berupa bilangan bulat positif.`,
    );
  }
  return raw;
}

function mapDomainLibError(err: unknown): never {
  if (err instanceof ConsoleRecoveryError) throw err;
  if (err instanceof DomainValidationError) {
    throw new ConsoleRecoveryError(err.status, "VALIDATION_ERROR", err.message, {
      cause: err,
      details: { reasonCode: err.reasonCode },
    });
  }
  if (err instanceof DomainEligibilityError) {
    const code: ConsoleRecoveryErrorCode =
      err.code === "TRIAL_DOMAIN_FORBIDDEN" ? "TRIAL_DOMAIN_FORBIDDEN" : "TENANT_NOT_ELIGIBLE";
    throw new ConsoleRecoveryError(403, code, err.message, { cause: err });
  }
  if (err instanceof DomainConflictError) {
    if (err.reasonCode === "DOMAIN_SET_MISMATCH") {
      throw new ConsoleRecoveryError(422, "DOMAIN_SET_MISMATCH", err.message, { cause: err });
    }
    const codeMap: Record<DomainConflictError["reasonCode"], ConsoleRecoveryErrorCode> = {
      DOMAIN_ALREADY_CLAIMED: "DOMAIN_ALREADY_CLAIMED",
      DOMAIN_LIMIT_REACHED: "DOMAIN_LIMIT_REACHED",
      DOMAIN_SET_MISMATCH: "DOMAIN_SET_MISMATCH",
      STALE_VERSION: "STALE_VERSION",
      IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
      DOMAIN_CLEANUP_PENDING: "DOMAIN_CLEANUP_PENDING",
      PROMOTION_GATE_FAILED: "VALIDATION_ERROR",
    };
    throw new ConsoleRecoveryError(409, codeMap[err.reasonCode], err.message, { cause: err });
  }
  if (err instanceof DomainNotFoundError) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", err.message, { cause: err });
  }
  throw err;
}

// ============================================================================
// 1. Domain Recovery Queue — Read Model & Classification
// ============================================================================

export type DomainOwnershipState = "active" | "pending" | "error";
export type DomainTlsState = "active" | "pending" | "error";

export interface ConsoleDomainQueueItem {
  readonly hostname: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantStatus: TenantStatus;
  readonly tenantEffectiveStatus: TenantStatus;
  readonly tenantOperatorHold: boolean;
  readonly cfCustomHostnameId: string | null;
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly ownershipStatus: DomainOwnershipState;
  readonly tlsStatus: DomainTlsState;
  readonly isPrimary: boolean;
  readonly everActivated: boolean;
  readonly lockedAfterActivation: boolean;
  readonly connectMode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly dnsTargetObserved: string | null;
  readonly failureCode: string | null;
  readonly isException: boolean;
  readonly exceptionReason: string | null;
  readonly canRecheck: boolean;
  readonly canOperatorChange: boolean;
  readonly version: number;
  readonly verifiedAt: number | null;
  readonly lastCheckedAt: number | null;
  readonly lastRecheckAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConsoleDomainQueueCounts {
  readonly total: number;
  readonly exceptions: number;
  readonly failed: number;
  readonly moved: number;
  readonly deleting: number;
  readonly pending: number;
  readonly active: number;
  readonly locked: number;
}

export interface ConsoleDomainQueuePage {
  readonly items: readonly ConsoleDomainQueueItem[];
  readonly page: number;
  readonly limit: number;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly counts: ConsoleDomainQueueCounts;
}

export interface ListConsoleDomainsQueueOptions {
  readonly status?: string;
  readonly search?: string;
  readonly tenantId?: string;
  readonly page?: number;
  readonly limit?: number;
  readonly nowMs?: number;
  readonly staleCheckMs?: number;
}

interface RawConsoleDomainRow {
  readonly host: string;
  readonly tenant_id: string;
  readonly cf_custom_hostname_id: string | null;
  readonly status: TenantHostStatus;
  readonly ssl_status: string;
  readonly is_primary: number;
  readonly verified_at: number | null;
  readonly last_checked_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly tenant_handle: string;
  readonly tenant_name: string;
  readonly tenant_status: TenantStatus;
  readonly tenant_operator_hold: number;
  readonly tenant_trial_ends_at: number | null;
  readonly tenant_paid_through: number | null;
  readonly connect_mode: DomainConnectMode | null;
  readonly ssl_method: DomainSslMethod | null;
  readonly provider_status: string | null;
  readonly provider_ssl_status: string | null;
  readonly dns_target_observed: string | null;
  readonly failure_code: string | null;
  readonly ever_activated: number | null;
  readonly last_recheck_at: number | null;
}

const VALID_DOMAIN_FILTERS = new Set([
  "all",
  "exceptions",
  "pending",
  "active",
  "failed",
  "moved",
  "deleting",
]);

export function classifyConsoleDomainState(params: {
  readonly status: TenantHostStatus;
  readonly sslStatus: string;
  readonly providerStatus: string | null;
  readonly providerSslStatus: string | null;
  readonly failureCode: string | null;
  readonly lastCheckedAt: number | null;
  readonly createdAt: number;
  readonly nowMs: number;
  readonly staleCheckMs?: number;
}): {
  readonly ownershipStatus: DomainOwnershipState;
  readonly tlsStatus: DomainTlsState;
  readonly isException: boolean;
  readonly exceptionReason: string | null;
} {
  const staleCheckMs = params.staleCheckMs ?? DEFAULT_DOMAIN_STALE_CHECK_MS;
  const rawOwnership = (params.providerStatus ?? params.status).trim().toLowerCase();
  const rawTls = (params.providerSslStatus ?? params.sslStatus).trim().toLowerCase();

  const ownershipStatus: DomainOwnershipState =
    rawOwnership === "active"
      ? "active"
      : rawOwnership === "blocked" || rawOwnership === "moved" || rawOwnership === "failed"
        ? "error"
        : "pending";

  const tlsStatus: DomainTlsState =
    rawTls === "active"
      ? "active"
      : rawTls === "validation_timed_out" ||
          rawTls === "failed" ||
          rawTls === "expired" ||
          rawTls === "deleted"
        ? "error"
        : "pending";

  if (params.status === "failed" || rawOwnership === "blocked") {
    return {
      ownershipStatus,
      tlsStatus,
      isException: true,
      exceptionReason: "Verifikasi domain atau SSL gagal di penyedia.",
    };
  }
  if (params.status === "moved") {
    return {
      ownershipStatus,
      tlsStatus,
      isException: true,
      exceptionReason: "Hostname dipindahkan (moved) — DNS tidak lagi mengarah ke target SaaS.",
    };
  }
  if (params.status === "deleting") {
    return {
      ownershipStatus,
      tlsStatus,
      isException: true,
      exceptionReason: "Pembersihan hostname di penyedia sedang tertunda.",
    };
  }
  if (tlsStatus === "error") {
    return {
      ownershipStatus,
      tlsStatus,
      isException: true,
      exceptionReason: "Sertifikat TLS gagal diterbitkan atau kedaluwarsa.",
    };
  }
  if (params.failureCode) {
    return {
      ownershipStatus,
      tlsStatus,
      isException: true,
      exceptionReason: `Kesalahan terakhir: ${sanitizeErrorCode(params.failureCode)}`,
    };
  }
  if (params.status === "pending") {
    const anchor = params.lastCheckedAt ?? params.createdAt;
    if (params.nowMs - anchor >= staleCheckMs) {
      return {
        ownershipStatus,
        tlsStatus,
        isException: true,
        exceptionReason: "Menunggu verifikasi terlalu lama tanpa pembaruan terbaru.",
      };
    }
  }

  return {
    ownershipStatus,
    tlsStatus,
    isException: false,
    exceptionReason: null,
  };
}

function mapConsoleDomainRow(
  row: RawConsoleDomainRow,
  nowMs: number,
  staleCheckMs: number,
): ConsoleDomainQueueItem {
  const tenantEffectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.tenant_status,
      operatorHold: row.tenant_operator_hold === 1,
      trialEndsAt: row.tenant_trial_ends_at,
      paidThrough: row.tenant_paid_through,
    },
    nowMs,
  );
  const safeFailureCode = row.failure_code ? sanitizeErrorCode(row.failure_code) : null;
  const classified = classifyConsoleDomainState({
    status: row.status,
    sslStatus: row.ssl_status,
    providerStatus: row.provider_status,
    providerSslStatus: row.provider_ssl_status,
    failureCode: safeFailureCode,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    nowMs,
    staleCheckMs,
  });
  const everActivated = row.ever_activated === 1 || row.status === "active";
  const connectMode: DomainConnectMode = row.connect_mode ?? "new_domain";
  const sslMethod: DomainSslMethod =
    row.ssl_method ?? (connectMode === "zero_downtime_migration" ? "txt" : "http");

  return {
    hostname: row.host,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    tenantEffectiveStatus,
    tenantOperatorHold: row.tenant_operator_hold === 1,
    cfCustomHostnameId: row.cf_custom_hostname_id,
    status: row.status,
    sslStatus: row.ssl_status,
    ownershipStatus: classified.ownershipStatus,
    tlsStatus: classified.tlsStatus,
    isPrimary: row.is_primary === 1,
    everActivated,
    lockedAfterActivation: everActivated,
    connectMode,
    sslMethod,
    dnsTargetObserved: row.dns_target_observed ? redactAuditText(row.dns_target_observed) : null,
    failureCode: safeFailureCode,
    isException: classified.isException,
    exceptionReason: classified.exceptionReason,
    canRecheck: row.status !== "deleting",
    canOperatorChange: row.tenant_status !== "purging" && row.tenant_status !== "purged",
    version: row.version,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    lastRecheckAt: row.last_recheck_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists custom hostnames across tenants for `console.punyasitus.com/domains`,
 * ordered exceptions-first (`failed`, `moved`, `deleting`, stuck `pending`, `active`).
 */
export async function listConsoleDomainsQueue(
  platformDb: D1Database,
  options: ListConsoleDomainsQueueOptions = {},
): Promise<ConsoleDomainQueuePage> {
  await ensureDomainMetadataSchema(platformDb);

  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const staleCheckMs = Math.max(
    60_000,
    Math.trunc(options.staleCheckMs ?? DEFAULT_DOMAIN_STALE_CHECK_MS),
  );
  const staleCutoffMs = nowMs - staleCheckMs;

  const rawStatus = (options.status ?? "all").trim().toLowerCase() || "all";
  if (!VALID_DOMAIN_FILTERS.has(rawStatus)) {
    throw new ConsoleRecoveryError(
      422,
      "VALIDATION_ERROR",
      `Filter status domain "${rawStatus}" tidak valid.`,
    );
  }

  const page = Math.max(1, Math.min(1000, Math.trunc(options.page ?? 1)));
  const limit = Math.max(
    1,
    Math.min(MAX_RECOVERY_PAGE_LIMIT, Math.trunc(options.limit ?? DEFAULT_RECOVERY_PAGE_LIMIT)),
  );
  const offset = (page - 1) * limit;

  const clauses: string[] = ["th.kind = 'custom'"];
  const bindings: (string | number)[] = [];

  if (options.tenantId?.trim()) {
    clauses.push("th.tenant_id = ?");
    bindings.push(options.tenantId.trim());
  }

  const search = options.search?.trim().toLowerCase() ?? "";
  if (search) {
    const like = `%${search}%`;
    clauses.push(
      "(LOWER(th.host) LIKE ? OR LOWER(t.handle) LIKE ? OR LOWER(t.name) LIKE ? OR th.tenant_id = ?)",
    );
    bindings.push(like, like, like, options.search!.trim());
  }

  const exceptionPredicateSql = `(
    th.status IN ('failed', 'moved', 'deleting')
    OR LOWER(th.ssl_status) IN ('failed', 'expired', 'validation_timed_out', 'deleted')
    OR LOWER(COALESCE(m.provider_status, '')) IN ('blocked', 'moved')
    OR LOWER(COALESCE(m.provider_ssl_status, '')) IN ('failed', 'expired', 'validation_timed_out', 'deleted')
    OR m.failure_code IS NOT NULL
    OR (th.status = 'pending' AND COALESCE(th.last_checked_at, th.created_at) <= ?)
  )`;

  if (rawStatus === "exceptions") {
    clauses.push(exceptionPredicateSql);
    bindings.push(staleCutoffMs);
  } else if (rawStatus !== "all") {
    clauses.push("th.status = ?");
    bindings.push(rawStatus);
  }

  const whereSql = `WHERE ${clauses.join(" AND ")}`;

  const [countRow, rowsRes, summaryRow] = await Promise.all([
    platformDb
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tenant_hosts th
         INNER JOIN tenants t ON t.id = th.tenant_id
         LEFT JOIN tenant_host_metadata m ON m.host = th.host
         ${whereSql}`,
      )
      .bind(...bindings)
      .first<{ readonly cnt: number }>(),
    platformDb
      .prepare(
        `SELECT
           th.host,
           th.tenant_id,
           th.cf_custom_hostname_id,
           th.status,
           th.ssl_status,
           th.is_primary,
           th.verified_at,
           th.last_checked_at,
           th.version,
           th.created_at,
           th.updated_at,
           t.handle AS tenant_handle,
           t.name AS tenant_name,
           t.status AS tenant_status,
           t.operator_hold AS tenant_operator_hold,
           t.trial_ends_at AS tenant_trial_ends_at,
           t.paid_through AS tenant_paid_through,
           m.connect_mode,
           m.ssl_method,
           m.provider_status,
           m.provider_ssl_status,
           m.dns_target_observed,
           m.failure_code,
           m.ever_activated,
           m.last_recheck_at
         FROM tenant_hosts th
         INNER JOIN tenants t ON t.id = th.tenant_id
         LEFT JOIN tenant_host_metadata m ON m.host = th.host
         ${whereSql}
         ORDER BY
           CASE
             WHEN th.status = 'failed' THEN 0
             WHEN th.status = 'moved' THEN 1
             WHEN th.status = 'deleting' THEN 2
             WHEN LOWER(th.ssl_status) IN ('failed', 'expired', 'validation_timed_out', 'deleted') OR m.failure_code IS NOT NULL THEN 3
             WHEN th.status = 'pending' AND COALESCE(th.last_checked_at, th.created_at) <= ? THEN 4
             WHEN th.status = 'pending' THEN 5
             ELSE 6
           END ASC,
           th.updated_at DESC,
           th.host ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, staleCutoffMs, limit, offset)
      .all<RawConsoleDomainRow>(),
    platformDb
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN ${exceptionPredicateSql} THEN 1 ELSE 0 END) AS exceptions,
           SUM(CASE WHEN th.status = 'failed' THEN 1 ELSE 0 END) AS failed_cnt,
           SUM(CASE WHEN th.status = 'moved' THEN 1 ELSE 0 END) AS moved_cnt,
           SUM(CASE WHEN th.status = 'deleting' THEN 1 ELSE 0 END) AS deleting_cnt,
           SUM(CASE WHEN th.status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt,
           SUM(CASE WHEN th.status = 'active' THEN 1 ELSE 0 END) AS active_cnt,
           SUM(CASE WHEN COALESCE(m.ever_activated, 0) = 1 OR th.status = 'active' THEN 1 ELSE 0 END) AS locked_cnt
         FROM tenant_hosts th
         LEFT JOIN tenant_host_metadata m ON m.host = th.host
         WHERE th.kind = 'custom'`,
      )
      .bind(staleCutoffMs)
      .first<{
        readonly total: number | null;
        readonly exceptions: number | null;
        readonly failed_cnt: number | null;
        readonly moved_cnt: number | null;
        readonly deleting_cnt: number | null;
        readonly pending_cnt: number | null;
        readonly active_cnt: number | null;
        readonly locked_cnt: number | null;
      }>(),
  ]);

  const totalCount = Number(countRow?.cnt ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const items = (rowsRes.results ?? []).map((row) => mapConsoleDomainRow(row, nowMs, staleCheckMs));

  return {
    items,
    page,
    limit,
    totalCount,
    totalPages,
    hasMore: page < totalPages,
    counts: {
      total: Number(summaryRow?.total ?? 0),
      exceptions: Number(summaryRow?.exceptions ?? 0),
      failed: Number(summaryRow?.failed_cnt ?? 0),
      moved: Number(summaryRow?.moved_cnt ?? 0),
      deleting: Number(summaryRow?.deleting_cnt ?? 0),
      pending: Number(summaryRow?.pending_cnt ?? 0),
      active: Number(summaryRow?.active_cnt ?? 0),
      locked: Number(summaryRow?.locked_cnt ?? 0),
    },
  };
}

export async function getConsoleDomainQueueItem(
  platformDb: D1Database,
  tenantId: string,
  hostname: string,
  options?: { readonly nowMs?: number; readonly staleCheckMs?: number },
): Promise<ConsoleDomainQueueItem | null> {
  await ensureDomainMetadataSchema(platformDb);
  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const staleCheckMs = Math.max(
    60_000,
    Math.trunc(options?.staleCheckMs ?? DEFAULT_DOMAIN_STALE_CHECK_MS),
  );
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");

  const row = await platformDb
    .prepare(
      `SELECT
         th.host,
         th.tenant_id,
         th.cf_custom_hostname_id,
         th.status,
         th.ssl_status,
         th.is_primary,
         th.verified_at,
         th.last_checked_at,
         th.version,
         th.created_at,
         th.updated_at,
         t.handle AS tenant_handle,
         t.name AS tenant_name,
         t.status AS tenant_status,
         t.operator_hold AS tenant_operator_hold,
         t.trial_ends_at AS tenant_trial_ends_at,
         t.paid_through AS tenant_paid_through,
         m.connect_mode,
         m.ssl_method,
         m.provider_status,
         m.provider_ssl_status,
         m.dns_target_observed,
         m.failure_code,
         m.ever_activated,
         m.last_recheck_at
       FROM tenant_hosts th
       INNER JOIN tenants t ON t.id = th.tenant_id
       LEFT JOIN tenant_host_metadata m ON m.host = th.host
       WHERE th.tenant_id = ? AND th.host = ? AND th.kind = 'custom'
       LIMIT 1`,
    )
    .bind(tenantId.trim(), normalizedHost)
    .first<RawConsoleDomainRow>();

  return row ? mapConsoleDomainRow(row, nowMs, staleCheckMs) : null;
}

// ============================================================================
// 2. Operator Domain Recheck — Idempotency, Rate Limit, Atomic Sync / Timeout
// ============================================================================

interface OperatorReceiptRow {
  readonly idempotency_key: string;
  readonly tenant_id: string | null;
  readonly status: string;
  readonly payload_json: string | null;
}

export interface CheckOperatorDomainRecheckPreconditionsInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly expectedVersion: number;
  readonly sslMethod?: DomainSslMethod;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly nowMs: number;
  readonly rateLimitPolicy?: Partial<DomainRecheckRateLimitPolicy>;
}

export type OperatorDomainRecheckPrecheckResult =
  | {
      readonly outcome: "replayed";
      readonly domain: ConsoleDomainQueueItem;
      readonly requestHash: string;
    }
  | {
      readonly outcome: "proceed";
      readonly record: TenantDomainRecord;
      readonly item: ConsoleDomainQueueItem;
      readonly cleanReason: string;
      readonly cleanIdempotencyKey: string;
      readonly ledgerKey: string;
      readonly requestHash: string;
    };

/**
 * Validates idempotency (including `sslMethod` in requestHash), strict tenant-to-hostname scope,
 * version match, and rate limit BEFORE calling external Cloudflare / DNS providers.
 */
export async function precheckOperatorDomainRecheck(
  platformDb: D1Database,
  input: CheckOperatorDomainRecheckPreconditionsInput,
): Promise<OperatorDomainRecheckPrecheckResult> {
  await ensureDomainMetadataSchema(platformDb);
  const cleanReason = normalizeRecoveryReason(input.reason);
  const cleanIdempotencyKey = normalizeRecoveryIdempotencyKey(input.idempotencyKey);
  const expectedVersion = normalizePositiveVersion(input.expectedVersion);
  const normalizedHost = input.hostname.trim().toLowerCase().replace(/\.$/, "");
  const cleanTenantId = input.tenantId.trim();
  if (!cleanTenantId || !normalizedHost) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Domain atau tenant tidak ditemukan.");
  }

  const ledgerKey = `console-domain-recheck:${cleanIdempotencyKey}`;
  const requestHash = await sha256Hex(
    JSON.stringify([
      cleanTenantId,
      normalizedHost,
      expectedVersion,
      input.sslMethod ?? null,
      cleanReason,
    ]),
  );

  // 1. Check idempotency receipt BEFORE version or rate limit
  const existingReceipt = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(ledgerKey)
    .first<OperatorReceiptRow>();

  if (existingReceipt) {
    const stored = existingReceipt.payload_json
      ? (JSON.parse(existingReceipt.payload_json) as {
          readonly requestHash?: string;
          readonly hostname?: string;
        })
      : null;
    if (
      existingReceipt.tenant_id !== cleanTenantId ||
      !stored ||
      stored.requestHash !== requestHash
    ) {
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk permintaan recheck domain yang berbeda.",
      );
    }
    const domain = await getConsoleDomainQueueItem(platformDb, cleanTenantId, normalizedHost, {
      nowMs: input.nowMs,
    });
    if (!domain) {
      throw new ConsoleRecoveryError(404, "NOT_FOUND", "Domain tidak ditemukan.");
    }
    return { outcome: "replayed", domain, requestHash };
  }

  // 2. Strictly enforce tenantId + hostname ownership (reject forged IDs)
  const record = await getTenantDomainBySelector(platformDb, cleanTenantId, normalizedHost);
  if (!record) {
    throw new ConsoleRecoveryError(
      404,
      "NOT_FOUND",
      "Domain tidak ditemukan untuk tenant yang ditentukan.",
    );
  }
  if (record.kind !== "custom") {
    throw new ConsoleRecoveryError(
      422,
      "DOMAIN_NOT_CUSTOM",
      "Pemeriksaan ulang penyedia hanya berlaku untuk custom domain.",
    );
  }
  if (record.status === "deleting") {
    throw new ConsoleRecoveryError(
      409,
      "DOMAIN_CLEANUP_PENDING",
      "Domain sedang dalam proses penghapusan dan tidak dapat direcheck.",
    );
  }
  if (record.version !== expectedVersion) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      `Versi domain berubah (diharapkan v${expectedVersion}, saat ini v${record.version}). Muat ulang sebelum mencoba lagi.`,
    );
  }

  const item = await getConsoleDomainQueueItem(platformDb, cleanTenantId, normalizedHost, {
    nowMs: input.nowMs,
  });
  if (!item) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Domain tidak ditemukan.");
  }

  // 3. Enforce rate limit atomically (429 RATE_LIMITED)
  try {
    await consumeDomainRecheckRateLimit(platformDb, {
      tenantId: cleanTenantId,
      hostname: normalizedHost,
      nowMs: input.nowMs,
      policy: input.rateLimitPolicy,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "DomainRateLimitError") {
      const retryAfterSeconds =
        "retryAfterSeconds" in err && typeof err.retryAfterSeconds === "number"
          ? err.retryAfterSeconds
          : 60;
      throw new ConsoleRecoveryError(429, "RATE_LIMITED", err.message, {
        cause: err,
        retryAfterSeconds,
      });
    }
    throw err;
  }

  return {
    outcome: "proceed",
    record,
    item,
    cleanReason,
    cleanIdempotencyKey,
    ledgerKey,
    requestHash,
  };
}

function mapProviderToLocalStatusStrict(params: {
  readonly providerStatus: string;
  readonly providerSslStatus: string;
  readonly cnameMatchesTarget: boolean;
}): { readonly status: TenantHostStatus; readonly sslStatus: string } {
  const pStatus = params.providerStatus.trim().toLowerCase();
  const pSsl = params.providerSslStatus.trim().toLowerCase();

  if (pStatus === "moved") return { status: "moved", sslStatus: pSsl };
  if (pStatus === "blocked") return { status: "failed", sslStatus: pSsl };
  if (pStatus === "deleted" || pStatus === "pending_deletion") {
    return { status: "deleting", sslStatus: pSsl };
  }
  // Never force-active: activate ONLY when provider status AND SSL are active AND DNS CNAME matches!
  if (pStatus === "active" && pSsl === "active" && params.cnameMatchesTarget) {
    return { status: "active", sslStatus: "active" };
  }
  return { status: "pending", sslStatus: pSsl };
}

export interface CommitOperatorDomainRecheckInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly record: TenantDomainRecord;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly ledgerKey: string;
  readonly requestHash: string;
  readonly requestId: string;
  readonly nowMs: number;
  readonly connectMode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly provider: CloudflareCustomHostname;
  readonly cnameMatchesTarget: boolean;
  readonly dnsTargetObserved: string | null;
  readonly tokenRefreshed: boolean;
}

/**
 * Atomically persists synced provider state + `platform_audit` (`WHERE changes() = 1`) +
 * idempotency receipt (`WHERE changes() = 1`) in ONE `D1Database.batch([...])`.
 * Follow-up statements (`tenant_host_metadata`, `tenants.cache_version`) gate strictly on
 * this request's unique `platform_audit.id` so a losing concurrent writer mutates ZERO rows!
 * NEVER touches `tenants.status` or `tenants.operator_hold`.
 */
export async function commitOperatorDomainRecheck(
  platformDb: D1Database,
  input: CommitOperatorDomainRecheckInput,
): Promise<{
  readonly domain: ConsoleDomainQueueItem;
  readonly audit: PlatformAuditRecord | null;
  readonly replayed: boolean;
}> {
  const mapped = mapProviderToLocalStatusStrict({
    providerStatus: input.provider.status,
    providerSslStatus: input.provider.ssl.status,
    cnameMatchesTarget: input.cnameMatchesTarget,
  });

  const hasDcvRecords =
    Boolean(input.provider.ssl.validation_records?.length) ||
    Boolean(input.provider.ssl.dcv_delegation_records?.length) ||
    Boolean(input.provider.ownership_verification);

  const tokenIssuedAt = input.tokenRefreshed
    ? input.nowMs
    : input.record.tokenIssuedAt ?? (hasDcvRecords ? input.nowMs : null);
  const tokenAssessment =
    tokenIssuedAt !== null
      ? evaluateDcvTokenAge({
          certificateAuthority: input.provider.ssl.certificate_authority,
          issuedAtMs: tokenIssuedAt,
          nowMs: input.nowMs,
        })
      : null;

  const isNowActive = mapped.status === "active" && mapped.sslStatus === "active";
  const nextEverActivated = input.record.everActivated || isNowActive ? 1 : 0;
  const nextVerifiedAt = isNowActive ? input.record.verifiedAt ?? input.nowMs : input.record.verifiedAt;
  const routingChanged =
    input.record.status !== mapped.status || input.record.sslStatus !== mapped.sslStatus;
  const snapshotJson = serializeSanitizedProviderSnapshot(input.provider);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.domain.recheck",
      targetType: "tenant_host",
      targetId: input.record.hostname,
      tenantId: input.tenantId,
      reason: input.reason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId,
      metadata: {
        hostname: input.record.hostname,
        previousStatus: input.record.status,
        nextStatus: mapped.status,
        providerStatus: input.provider.status,
        providerSslStatus: input.provider.ssl.status,
        cnameMatchesTarget: input.cnameMatchesTarget,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      },
      createdAtMs: input.nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const statements: D1PreparedStatement[] = [
    // 0. Optimistic versioned host update
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET cf_custom_hostname_id = ?,
             status = ?,
             ssl_status = ?,
             verified_at = ?,
             last_checked_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ? AND kind = 'custom' AND version = ?`,
      )
      .bind(
        input.provider.id,
        mapped.status,
        mapped.sslStatus,
        nextVerifiedAt,
        input.nowMs,
        input.nowMs,
        input.record.hostname,
        input.tenantId,
        input.expectedVersion,
      ),
    // 1. Atomic audit gated on `changes() = 1` from statement 0 (unique ULID `auditEntry.id`)
    auditStmt,
    // 2. Atomic idempotency receipt gated on `changes() = 1` from statement 1
    platformDb
      .prepare(
        `INSERT INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
         )
         SELECT ?, 'console.domain_recheck_receipt', ?, 'completed', 1, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        input.ledgerKey,
        input.tenantId,
        JSON.stringify({
          hostname: input.record.hostname,
          requestHash: input.requestHash,
          nextStatus: mapped.status,
        }),
        input.nowMs,
        input.nowMs,
      ),
    // 3. Upsert metadata strictly gated on THIS request's unique `auditEntry.id`
    platformDb
      .prepare(
        `INSERT INTO tenant_host_metadata (
           host, tenant_id, domain_id, connect_mode, ssl_method,
           certificate_authority, token_issued_at, token_expires_at,
           provider_status, provider_ssl_status, provider_snapshot_json,
           dns_target_observed, https_probe_passed, failure_code,
           ever_activated, last_recheck_at, created_at, updated_at
         )
         SELECT
           ?, ?,
           COALESCE((SELECT MAX(domain_id) FROM tenant_host_metadata WHERE tenant_id = ?), 1) + 1,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
         ON CONFLICT(host) DO UPDATE SET
           ssl_method = excluded.ssl_method,
           certificate_authority = excluded.certificate_authority,
           token_issued_at = excluded.token_issued_at,
           token_expires_at = excluded.token_expires_at,
           provider_status = excluded.provider_status,
           provider_ssl_status = excluded.provider_ssl_status,
           provider_snapshot_json = excluded.provider_snapshot_json,
           dns_target_observed = excluded.dns_target_observed,
           failure_code = NULL,
           ever_activated = MAX(tenant_host_metadata.ever_activated, excluded.ever_activated),
           last_recheck_at = excluded.last_recheck_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.record.hostname,
        input.tenantId,
        input.tenantId,
        input.connectMode,
        input.sslMethod,
        input.provider.ssl.certificate_authority ?? null,
        tokenIssuedAt,
        tokenAssessment?.expiresAtMs ?? null,
        input.provider.status,
        input.provider.ssl.status,
        snapshotJson,
        input.dnsTargetObserved,
        nextEverActivated,
        input.nowMs,
        input.nowMs,
        input.nowMs,
        auditEntry.id,
      ),
  ];

  if (routingChanged) {
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenants
           SET cache_version = cache_version + 1,
               updated_at = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
        )
        .bind(input.nowMs, input.tenantId, auditEntry.id),
    );
  }

  let results: D1Result[];
  try {
    results = await platformDb.batch(statements);
  } catch (err) {
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(input.ledgerKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === input.tenantId && stored?.requestHash === input.requestHash) {
        const refreshed = await getConsoleDomainQueueItem(
          platformDb,
          input.tenantId,
          input.record.hostname,
          { nowMs: input.nowMs },
        );
        if (refreshed) {
          return { domain: refreshed, audit: null, replayed: true };
        }
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk permintaan recheck domain yang berbeda.",
        { cause: err },
      );
    }
    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan pembaruan recheck domain dan log audit secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    // Re-check receipt for same-Idempotency-Key concurrent race
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(input.ledgerKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === input.tenantId && stored?.requestHash === input.requestHash) {
        const refreshed = await getConsoleDomainQueueItem(
          platformDb,
          input.tenantId,
          input.record.hostname,
          { nowMs: input.nowMs },
        );
        if (refreshed) {
          return { domain: refreshed, audit: null, replayed: true };
        }
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk permintaan recheck domain yang berbeda.",
      );
    }
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Versi domain berubah secara bersamaan saat recheck. Muat ulang dan coba lagi.",
    );
  }

  if (routingChanged) {
    evictHostFromCache(input.record.hostname);
    evictTenantFromCache(input.tenantId);
  }

  const updated = await getConsoleDomainQueueItem(platformDb, input.tenantId, input.record.hostname, {
    nowMs: input.nowMs,
  });
  if (!updated) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Domain tidak ditemukan setelah pembaruan.");
  }

  return { domain: updated, audit: auditEntry, replayed: false };
}

/**
 * Records a safe provider timeout/outage outcome on domain recheck WITHOUT force-activating
 * the domain, WITHOUT rewriting `moved` to `pending`, WITHOUT bumping `tenant_hosts.version`
 * (so retrying with the same `expectedVersion` works seamlessly!), and WITHOUT lifting
 * service suspension. Gates `tenant_host_metadata` strictly on unique `auditEntry.id` so a
 * losing concurrent writer mutates ZERO rows!
 */
export async function recordOperatorDomainProviderTimeout(
  platformDb: D1Database,
  input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly record: TenantDomainRecord;
    readonly expectedVersion: number;
    readonly reason: string;
    readonly requestId: string;
    readonly providerErrorCode: string;
    readonly nowMs: number;
  },
): Promise<{ readonly domain: ConsoleDomainQueueItem; readonly audit: PlatformAuditRecord }> {
  const safeErrorCode = sanitizeErrorCode(input.providerErrorCode);
  // Preserve current status exactly (`active`, `failed`, `moved`, `pending`, `deleting`) — never fabricate `active` or clobber `moved`!
  const preservedStatus: TenantHostStatus = input.record.status;

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.domain.recheck.provider_timeout",
      targetType: "tenant_host",
      targetId: input.record.hostname,
      tenantId: input.tenantId,
      reason: input.reason,
      requireReason: true,
      outcome: "error",
      requestId: input.requestId,
      metadata: {
        hostname: input.record.hostname,
        preservedStatus,
        failureCode: safeErrorCode,
        expectedVersion: input.expectedVersion,
      },
      createdAtMs: input.nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([
      // Intentionally preserve `version` so operator can retry seamlessly after transient timeout
      platformDb
        .prepare(
          `UPDATE tenant_hosts
           SET status = ?,
               last_checked_at = ?,
               updated_at = ?
           WHERE host = ? AND tenant_id = ? AND kind = 'custom' AND version = ?`,
        )
        .bind(
          preservedStatus,
          input.nowMs,
          input.nowMs,
          input.record.hostname,
          input.tenantId,
          input.expectedVersion,
        ),
      auditStmt,
      platformDb
        .prepare(
          `INSERT INTO tenant_host_metadata (
             host, tenant_id, domain_id, connect_mode, ssl_method,
             failure_code, last_recheck_at, created_at, updated_at
           )
           SELECT
             ?, ?,
             COALESCE((SELECT MAX(domain_id) FROM tenant_host_metadata WHERE tenant_id = ?), 1) + 1,
             ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
           ON CONFLICT(host) DO UPDATE SET
             failure_code = excluded.failure_code,
             last_recheck_at = excluded.last_recheck_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.record.hostname,
          input.tenantId,
          input.tenantId,
          input.record.connectMode ?? "new_domain",
          input.record.sslMethod ?? "http",
          safeErrorCode,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          auditEntry.id,
        ),
    ]);
  } catch (err) {
    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal mencatat status timeout penyedia domain secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Versi domain berubah secara bersamaan sebelum timeout tercatat. Muat ulang dan coba lagi.",
    );
  }

  const domain = await getConsoleDomainQueueItem(platformDb, input.tenantId, input.record.hostname, {
    nowMs: input.nowMs,
  });
  if (!domain) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Domain tidak ditemukan.");
  }
  return { domain, audit: auditEntry };
}

// ============================================================================
// 3. Operator Domain Change (REQ-065 Remove Locked Hostnames & Connect New)
// ============================================================================

export interface OperatorDomainChangePrecheckInput {
  readonly tenantId: string;
  readonly hostname: string;
  readonly confirmHostname: string;
  readonly confirmRemoveLocked: boolean;
  readonly removeDomainSet?: boolean;
  readonly newHostname?: string | null;
  readonly connectMode?: string;
  readonly sslMethod?: string;
  readonly confirmApexFlattening?: boolean;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly platformDomain?: string;
  readonly saasZone?: string;
  readonly allowTestTlds?: boolean;
  readonly nowMs: number;
}

export interface OperatorDomainChangePlan {
  readonly outcome: "proceed";
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly tenantEffectiveStatus: TenantStatus;
  readonly tenantOperatorHold: boolean;
  readonly primaryTarget: TenantDomainRecord;
  readonly targetsToRemove: readonly TenantDomainRecord[];
  readonly newHostname: string | null;
  readonly connectMode: DomainConnectMode | null;
  readonly sslMethod: DomainSslMethod | null;
  readonly cleanReason: string;
  readonly cleanIdempotencyKey: string;
  readonly ledgerKey: string;
  readonly requestHash: string;
}

export interface OperatorDomainChangeReplay {
  readonly outcome: "replayed";
  readonly removedHostnames: readonly string[];
  readonly newHostname: string | null;
  readonly newDomain: ConsoleDomainQueueItem | null;
  readonly restoredSubdomainPrimary: boolean;
}

export async function precheckOperatorDomainChange(
  platformDb: D1Database,
  input: OperatorDomainChangePrecheckInput,
): Promise<OperatorDomainChangePlan | OperatorDomainChangeReplay> {
  await ensureDomainMetadataSchema(platformDb);
  const cleanReason = normalizeRecoveryReason(input.reason);
  const cleanIdempotencyKey = normalizeRecoveryIdempotencyKey(input.idempotencyKey);
  const expectedVersion = normalizePositiveVersion(input.expectedVersion);

  if (input.confirmRemoveLocked !== true) {
    throw new ConsoleRecoveryError(
      422,
      "DOMAIN_CHANGE_CONFIRMATION_REQUIRED",
      "Konfirmasi eksplisit (confirmRemoveLocked: true) wajib diberikan sebelum menghapus domain terkunci.",
    );
  }

  const cleanTenantId = input.tenantId.trim();
  const normalizedTarget = input.hostname.trim().toLowerCase().replace(/\.$/, "");
  const normalizedConfirm = input.confirmHostname.trim().toLowerCase().replace(/\.$/, "");
  if (!cleanTenantId || !normalizedTarget) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Tenant atau hostname tidak ditemukan.");
  }
  if (normalizedConfirm !== normalizedTarget) {
    throw new ConsoleRecoveryError(
      422,
      "DOMAIN_CHANGE_CONFIRMATION_REQUIRED",
      `Konfirmasi hostname tidak cocok. Ketik persis "${normalizedTarget}" untuk melanjutkan.`,
    );
  }

  const rawNewHost = input.newHostname?.trim()
    ? input.newHostname.trim().toLowerCase().replace(/\.$/, "")
    : null;
  const removeDomainSet = input.removeDomainSet ?? Boolean(rawNewHost);
  const ledgerKey = `console-domain-change:${cleanIdempotencyKey}`;
  const requestHash = await sha256Hex(
    JSON.stringify([
      cleanTenantId,
      normalizedTarget,
      removeDomainSet,
      rawNewHost,
      input.connectMode ?? null,
      input.sslMethod ?? null,
      input.confirmApexFlattening ?? null,
      expectedVersion,
      cleanReason,
    ]),
  );

  // 1. Idempotency check BEFORE version check
  const existingReceipt = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(ledgerKey)
    .first<OperatorReceiptRow>();

  if (existingReceipt) {
    const stored = existingReceipt.payload_json
      ? (JSON.parse(existingReceipt.payload_json) as {
          readonly requestHash?: string;
          readonly removedHostnames?: readonly string[];
          readonly newHostname?: string | null;
          readonly restoredSubdomainPrimary?: boolean;
        })
      : null;
    if (
      existingReceipt.tenant_id !== cleanTenantId ||
      !stored ||
      stored.requestHash !== requestHash
    ) {
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk perubahan domain yang berbeda.",
      );
    }
    const newDomain = stored.newHostname
      ? await getConsoleDomainQueueItem(platformDb, cleanTenantId, stored.newHostname, {
          nowMs: input.nowMs,
        })
      : null;
    return {
      outcome: "replayed",
      removedHostnames: stored.removedHostnames ?? [normalizedTarget],
      newHostname: stored.newHostname ?? null,
      newDomain,
      restoredSubdomainPrimary: stored.restoredSubdomainPrimary ?? true,
    };
  }

  // 2. Verify tenant exists and is eligible
  const tenantRow = await platformDb
    .prepare(
      `SELECT id, handle, status, operator_hold, trial_ends_at, paid_through
       FROM tenants WHERE id = ? LIMIT 1`,
    )
    .bind(cleanTenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly status: TenantStatus;
      readonly operator_hold: number;
      readonly trial_ends_at: number | null;
      readonly paid_through: number | null;
    }>();

  if (!tenantRow) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }
  if (tenantRow.status === "purging" || tenantRow.status === "purged") {
    throw new ConsoleRecoveryError(
      409,
      "TENANT_NOT_ELIGIBLE",
      "Tenant sedang dihapus atau sudah terhapus; perubahan domain tidak diizinkan.",
    );
  }

  const tenantEffectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: tenantRow.status,
      operatorHold: tenantRow.operator_hold === 1,
      trialEndsAt: tenantRow.trial_ends_at,
      paidThrough: tenantRow.paid_through,
    },
    input.nowMs,
  );

  // 3. Load tenant domains & verify strict ownership of target hostname
  const listed = await listTenantDomains(platformDb, cleanTenantId);
  const target = listed.items.find((d) => d.hostname === normalizedTarget);
  if (!target) {
    throw new ConsoleRecoveryError(
      404,
      "NOT_FOUND",
      "Domain tidak ditemukan untuk tenant yang ditentukan.",
    );
  }
  if (target.kind !== "custom") {
    throw new ConsoleRecoveryError(
      422,
      "DOMAIN_NOT_CUSTOM",
      "Subdomain fallback platform tidak dapat dihapus atau diganti.",
    );
  }
  if (target.version !== expectedVersion) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      `Versi domain berubah (diharapkan v${expectedVersion}, saat ini v${target.version}). Muat ulang sebelum melanjutkan.`,
    );
  }

  const customDomains = listed.items.filter((d) => d.kind === "custom");
  const targetsToRemove = removeDomainSet ? customDomains : [target];
  const removedSet = new Set(targetsToRemove.map((t) => t.hostname));
  const remainingCustomHosts = customDomains
    .filter((d) => !removedSet.has(d.hostname) && d.status !== "deleting")
    .map((d) => d.hostname);

  // 4. Validate optional replacement hostname BEFORE mutating any state (including REQ-065 cap & domain-set match!)
  let validatedNewHost: string | null = null;
  let resolvedConnectMode: DomainConnectMode | null = null;
  let resolvedSslMethod: DomainSslMethod | null = null;

  if (rawNewHost) {
    try {
      assertTenantPaidForCustomDomain(tenantEffectiveStatus);
      const validated = assertValidCustomHostname(rawNewHost, {
        platformDomain: input.platformDomain,
        saasZone: input.saasZone,
        allowTestTlds: input.allowTestTlds,
      });
      validatedNewHost = validated.hostname;

      if (removedSet.has(validatedNewHost)) {
        throw new ConsoleRecoveryError(
          422,
          "VALIDATION_ERROR",
          "Domain baru tidak boleh sama dengan domain yang sedang dihapus.",
        );
      }

      if (remainingCustomHosts.includes(validatedNewHost)) {
        throw new ConsoleRecoveryError(
          409,
          "DOMAIN_ALREADY_CLAIMED",
          `Domain ${validatedNewHost} sudah terpasang pada tenant ini.`,
        );
      }

      // Enforce REQ-065 max-2 custom hostnames & single apex/www domain-set compatibility!
      assertTenantDomainSetCompatibility(remainingCustomHosts, validatedNewHost);

      resolvedConnectMode = normalizeConnectMode(input.connectMode ?? "new_domain");
      resolvedSslMethod = resolveSslMethodForMode(
        resolvedConnectMode,
        input.sslMethod as DomainSslMethod | undefined,
      );

      if (validated.isLikelyApex) {
        const apexEval = evaluateApexCapability({
          hostname: validated.hostname,
          isLikelyApex: validated.isLikelyApex,
          connectMode: resolvedConnectMode,
          confirmApexFlattening: input.confirmApexFlattening,
        });
        if (!apexEval.supported) {
          throw new ConsoleRecoveryError(
            422,
            "VALIDATION_ERROR",
            apexEval.messageId ?? "Konfirmasi CNAME flattening diperlukan untuk apex domain.",
            { details: { reasonCode: apexEval.reasonCode } },
          );
        }
      }
    } catch (err) {
      mapDomainLibError(err);
    }

    // Check global claim conflict
    const claimed = await platformDb
      .prepare("SELECT tenant_id FROM tenant_hosts WHERE host = ? LIMIT 1")
      .bind(validatedNewHost)
      .first<{ readonly tenant_id: string }>();
    if (claimed && claimed.tenant_id !== cleanTenantId) {
      throw new ConsoleRecoveryError(
        409,
        "DOMAIN_ALREADY_CLAIMED",
        `Domain ${validatedNewHost} sudah digunakan oleh website lain.`,
      );
    }
  }

  return {
    outcome: "proceed",
    tenantId: cleanTenantId,
    tenantHandle: tenantRow.handle,
    tenantStatus: tenantRow.status,
    tenantEffectiveStatus,
    tenantOperatorHold: tenantRow.operator_hold === 1,
    primaryTarget: target,
    targetsToRemove,
    newHostname: validatedNewHost,
    connectMode: resolvedConnectMode,
    sslMethod: resolvedSslMethod,
    cleanReason,
    cleanIdempotencyKey,
    ledgerKey,
    requestHash,
  };
}

/**
 * Step 1 of Operator Domain Change: atomically disables routing for locked custom hostnames
 * (`status = 'deleting'`, `is_primary = 0`), restores platform subdomain as primary,
 * bumps `tenants.cache_version` (NEVER changing `tenants.status` / `operator_hold`),
 * and writes `platform_audit` (`WHERE changes() = 1`). All follow-up statements gate on
 * THIS request's unique `auditEntry.id`.
 */
export async function beginOperatorDomainChangeRemoval(
  platformDb: D1Database,
  plan: OperatorDomainChangePlan,
  actorUserId: string,
  requestId: string,
  nowMs: number,
): Promise<{ readonly audit: PlatformAuditRecord; readonly deletingVersion: number }> {
  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "console.domain.change.started",
      targetType: "tenant_host",
      targetId: plan.primaryTarget.hostname,
      tenantId: plan.tenantId,
      reason: plan.cleanReason,
      requireReason: true,
      outcome: "success",
      requestId,
      metadata: {
        removedHostnames: plan.targetsToRemove.map((t) => t.hostname),
        newHostname: plan.newHostname,
        expectedVersion: plan.primaryTarget.version,
        idempotencyKey: plan.cleanIdempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const deletingVersion = plan.primaryTarget.version + 1;
  const statements: D1PreparedStatement[] = [
    // 0. Optimistic versioned update on primary target
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET status = 'deleting',
             is_primary = 0,
             version = version + 1,
             updated_at = ?
         WHERE host = ? AND tenant_id = ? AND kind = 'custom' AND version = ?`,
      )
      .bind(nowMs, plan.primaryTarget.hostname, plan.tenantId, plan.primaryTarget.version),
    // 1. Atomic audit gated on `changes() = 1`
    auditStmt,
  ];

  // Mark any counterpart custom hostnames as deleting ONLY if THIS request wrote `auditEntry.id`
  for (const extra of plan.targetsToRemove) {
    if (extra.hostname === plan.primaryTarget.hostname) continue;
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenant_hosts
           SET status = 'deleting',
               is_primary = 0,
               version = version + 1,
               updated_at = ?
           WHERE host = ? AND tenant_id = ? AND kind = 'custom'
             AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
        )
        .bind(nowMs, extra.hostname, plan.tenantId, auditEntry.id),
    );
  }

  // Restore verified platform subdomain as primary if no active primary remains
  statements.push(
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET is_primary = 1,
             version = version + 1,
             updated_at = ?
         WHERE tenant_id = ?
           AND kind = 'subdomain'
           AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM tenant_hosts WHERE tenant_id = ? AND is_primary = 1
           )
           AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
      )
      .bind(nowMs, plan.tenantId, plan.tenantId, auditEntry.id),
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1,
             updated_at = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
      )
      .bind(nowMs, plan.tenantId, auditEntry.id),
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch(statements);
  } catch (err) {
    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal memulai penghapusan domain terkunci secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Versi domain berubah secara bersamaan sebelum penghapusan dimulai.",
    );
  }

  for (const t of plan.targetsToRemove) {
    evictHostFromCache(t.hostname);
  }
  evictTenantFromCache(plan.tenantId);

  return { audit: auditEntry, deletingVersion };
}

/**
 * Step 2 of Operator Domain Change: after Cloudflare provider deletion succeeds,
 * atomically deletes the version-guarded locked hostnames, writes `platform_audit` (`WHERE changes() = 1`),
 * ALWAYS writes the idempotency receipt (`WHERE changes() = 1`), restores subdomain fallback,
 * and conditionally claims the optional replacement hostname in `pending` state enforcing
 * REQ-065 max-2 / single-domain-set invariants in SQL!
 */
export async function finalizeOperatorDomainChange(
  platformDb: D1Database,
  input: {
    readonly plan: OperatorDomainChangePlan;
    readonly deletingVersion: number;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{
  readonly removedHostnames: readonly string[];
  readonly restoredSubdomainPrimary: boolean;
  readonly newDomain: ConsoleDomainQueueItem | null;
  readonly audit: PlatformAuditRecord | null;
  readonly replayed: boolean;
}> {
  const { plan, deletingVersion, actorUserId, requestId, nowMs } = input;
  const removedHostnames = plan.targetsToRemove.map((t) => t.hostname);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: plan.newHostname ? "console.domain.change.completed" : "console.domain.locked_removed",
      targetType: "tenant_host",
      targetId: plan.newHostname ?? plan.primaryTarget.hostname,
      tenantId: plan.tenantId,
      reason: plan.cleanReason,
      requireReason: true,
      outcome: "success",
      requestId,
      metadata: {
        removedHostnames,
        newHostname: plan.newHostname,
        connectMode: plan.connectMode,
        sslMethod: plan.sslMethod,
        idempotencyKey: plan.cleanIdempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  // Statement 0: Version-guarded DELETE of primary deleting target
  // Statement 1: Conditional audit row (`WHERE changes() = 1`)
  // Statement 2: Conditional idempotency receipt (`WHERE changes() = 1`) — ALWAYS written atomically!
  const statements: D1PreparedStatement[] = [
    platformDb
      .prepare(
        `DELETE FROM tenant_hosts
         WHERE host = ? AND tenant_id = ? AND kind = 'custom' AND status = 'deleting' AND version = ?`,
      )
      .bind(plan.primaryTarget.hostname, plan.tenantId, deletingVersion),
    auditStmt,
    platformDb
      .prepare(
        `INSERT INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
         )
         SELECT ?, 'console.domain_change_receipt', ?, 'completed', 1, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        plan.ledgerKey,
        plan.tenantId,
        JSON.stringify({
          requestHash: plan.requestHash,
          removedHostnames,
          newHostname: plan.newHostname,
          restoredSubdomainPrimary: true,
        }),
        nowMs,
        nowMs,
      ),
    // Cleanup metadata for primary removed host (in case foreign keys pragma is off)
    platformDb
      .prepare(
        `DELETE FROM tenant_host_metadata
         WHERE host = ? AND tenant_id = ?
           AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
      )
      .bind(plan.primaryTarget.hostname, plan.tenantId, auditEntry.id),
  ];

  // Delete any counterpart targets gated on `auditEntry.id`
  for (const extra of plan.targetsToRemove) {
    if (extra.hostname === plan.primaryTarget.hostname) continue;
    statements.push(
      platformDb
        .prepare(
          `DELETE FROM tenant_host_metadata
           WHERE host = ? AND tenant_id = ?
             AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
        )
        .bind(extra.hostname, plan.tenantId, auditEntry.id),
      platformDb
        .prepare(
          `DELETE FROM tenant_hosts
           WHERE host = ? AND tenant_id = ? AND kind = 'custom' AND status = 'deleting'
             AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
        )
        .bind(extra.hostname, plan.tenantId, auditEntry.id),
    );
  }

  const restoreIdx = statements.length;
  statements.push(
    platformDb
      .prepare(
        `UPDATE tenant_hosts
         SET is_primary = 1,
             version = version + 1,
             updated_at = ?
         WHERE tenant_id = ?
           AND kind = 'subdomain'
           AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM tenant_hosts WHERE tenant_id = ? AND is_primary = 1
           )
           AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
      )
      .bind(nowMs, plan.tenantId, plan.tenantId, auditEntry.id),
  );

  let newHostInsertIdx = -1;
  if (plan.newHostname && plan.connectMode && plan.sslMethod) {
    const counterpartHost = plan.newHostname.startsWith("www.")
      ? plan.newHostname.slice(4)
      : `www.${plan.newHostname}`;
    newHostInsertIdx = statements.length;
    statements.push(
      // Atomic SQL-level REQ-065 max-2 & single-domain-set enforcement!
      platformDb
        .prepare(
          `INSERT INTO tenant_hosts (
             host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status,
             is_primary, verified_at, last_checked_at, quarantined_until,
             version, created_at, updated_at
           )
           SELECT ?, ?, 'custom', NULL, 'pending', 'pending', 0, NULL, NULL, NULL, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
             AND (
               SELECT COUNT(*) FROM tenant_hosts
               WHERE tenant_id = ? AND kind = 'custom' AND status != 'deleting'
             ) < ?
             AND NOT EXISTS (
               SELECT 1 FROM tenant_hosts
               WHERE tenant_id = ?
                 AND kind = 'custom'
                 AND status != 'deleting'
                 AND host != ?
                 AND host != ?
             )`,
        )
        .bind(
          plan.newHostname,
          plan.tenantId,
          nowMs,
          nowMs,
          auditEntry.id,
          plan.tenantId,
          MAX_CUSTOM_HOSTNAMES_PER_TENANT,
          plan.tenantId,
          plan.newHostname,
          counterpartHost,
        ),
      platformDb
        .prepare(
          `INSERT INTO tenant_host_metadata (
             host, tenant_id, domain_id, connect_mode, ssl_method,
             provider_status, provider_ssl_status, https_probe_passed,
             ever_activated, idempotency_key, created_at, updated_at
           )
           SELECT
             ?, ?,
             COALESCE((SELECT MAX(domain_id) FROM tenant_host_metadata WHERE tenant_id = ?), 1) + 1,
             ?, ?, 'pending', 'pending_validation', 0, 0, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
             AND EXISTS (SELECT 1 FROM tenant_hosts WHERE host = ? AND tenant_id = ?)`,
        )
        .bind(
          plan.newHostname,
          plan.tenantId,
          plan.tenantId,
          plan.connectMode,
          plan.sslMethod,
          plan.cleanIdempotencyKey,
          nowMs,
          nowMs,
          auditEntry.id,
          plan.newHostname,
          plan.tenantId,
        ),
    );
  }

  statements.push(
    platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1, updated_at = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
      )
      .bind(nowMs, plan.tenantId, auditEntry.id),
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch(statements);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
      const raceReceipt = await platformDb
        .prepare(
          "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
        )
        .bind(plan.ledgerKey)
        .first<OperatorReceiptRow>();
      if (raceReceipt) {
        const stored = raceReceipt.payload_json
          ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
          : null;
        if (raceReceipt.tenant_id === plan.tenantId && stored?.requestHash === plan.requestHash) {
          const newDomain = plan.newHostname
            ? await getConsoleDomainQueueItem(platformDb, plan.tenantId, plan.newHostname, { nowMs })
            : null;
          return {
            removedHostnames,
            restoredSubdomainPrimary: true,
            newDomain,
            audit: null,
            replayed: true,
          };
        }
        throw new ConsoleRecoveryError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key ini sudah digunakan untuk perubahan domain yang berbeda.",
          { cause: err },
        );
      }
      throw new ConsoleRecoveryError(
        409,
        "DOMAIN_ALREADY_CLAIMED",
        `Domain ${plan.newHostname ?? ""} sudah diklaim secara bersamaan.`,
        { cause: err },
      );
    }
    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyelesaikan perubahan domain dan mencatat audit secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(plan.ledgerKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === plan.tenantId && stored?.requestHash === plan.requestHash) {
        const newDomain = plan.newHostname
          ? await getConsoleDomainQueueItem(platformDb, plan.tenantId, plan.newHostname, { nowMs })
          : null;
        return {
          removedHostnames,
          restoredSubdomainPrimary: true,
          newDomain,
          audit: null,
          replayed: true,
        };
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk perubahan domain yang berbeda.",
      );
    }
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Versi domain berubah secara bersamaan saat finalisasi penghapusan.",
    );
  }

  if (newHostInsertIdx >= 0 && (results[newHostInsertIdx]?.meta?.changes ?? 0) === 0) {
    const freshList = await listTenantDomains(platformDb, plan.tenantId);
    const activeCustom = freshList.items
      .filter((item) => item.kind === "custom" && item.status !== "deleting")
      .map((item) => item.hostname);
    try {
      assertTenantDomainSetCompatibility(activeCustom, plan.newHostname!);
    } catch (err) {
      mapDomainLibError(err);
    }
    throw new ConsoleRecoveryError(
      409,
      "DOMAIN_LIMIT_REACHED",
      `Maksimal ${MAX_CUSTOM_HOSTNAMES_PER_TENANT} custom hostname per website.`,
    );
  }

  for (const host of removedHostnames) {
    evictHostFromCache(host);
  }
  if (plan.newHostname) {
    evictHostFromCache(plan.newHostname);
  }
  evictTenantFromCache(plan.tenantId);

  const newDomain = plan.newHostname
    ? await getConsoleDomainQueueItem(platformDb, plan.tenantId, plan.newHostname, { nowMs })
    : null;

  return {
    removedHostnames,
    restoredSubdomainPrimary: (results[restoreIdx]?.meta?.changes ?? 0) > 0,
    newDomain,
    audit: auditEntry,
    replayed: false,
  };
}

// ============================================================================
// 4. Job Recovery Queue — Redaction, Eligibility, Read Model & Atomic Actions
// ============================================================================

export type ConsoleJobLeaseState = "active" | "expired" | "none";

export interface ConsoleJobQueueItem {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly tenantHandle: string | null;
  readonly tenantName: string | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly leaseUntil: number | null;
  readonly leaseState: ConsoleJobLeaseState;
  readonly lastErrorCode: string | null;
  readonly redactedPayloadSummary: Readonly<Record<string, unknown>> | null;
  readonly payloadRedacted: boolean;
  readonly retryEligible: boolean;
  readonly retryIneligibleReasonCode: string | null;
  readonly retryIneligibleReason: string | null;
  readonly cancelEligible: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConsoleJobQueueCounts {
  readonly total: number;
  readonly exceptions: number;
  readonly failed: number;
  readonly deadLetter: number;
  readonly expiredLeaseRunning: number;
  readonly staleQueued: number;
  readonly activeLeaseRunning: number;
  readonly queued: number;
  readonly completed: number;
}

export interface ConsoleJobQueuePage {
  readonly items: readonly ConsoleJobQueueItem[];
  readonly page: number;
  readonly limit: number;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly counts: ConsoleJobQueueCounts;
  readonly topics: readonly string[];
}

export interface ListConsoleJobsQueueOptions {
  readonly status?: string;
  readonly topic?: string;
  readonly tenantId?: string;
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
  readonly nowMs?: number;
}

interface RawConsoleJobRow {
  readonly idempotency_key: string;
  readonly topic: string;
  readonly tenant_id: string | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly lease_until: number | null;
  readonly last_error_code: string | null;
  readonly payload_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly tenant_handle: string | null;
  readonly tenant_name: string | null;
}

const VALID_JOB_FILTERS = new Set([
  "all",
  "exceptions",
  "failed",
  "dead_letter",
  "running",
  "queued",
  "completed",
]);

function truncateRedactedValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return redactAuditText(value).slice(0, MAX_REDACTED_SUMMARY_STR_LEN);
  }
  if (depth >= 2) {
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => truncateRedactedValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateRedactedValue(v, depth + 1);
      count += 1;
      if (count >= 6) break;
    }
    return out;
  }
  return REDACTED_VALUE;
}

/**
 * Multi-layer redaction of `job_ledger.payload_json` for superadmin inspection (REQ-050, REQ-051).
 * NEVER returns raw secrets, tokens, cookies, passwords, emails, phone numbers, or customer lead bodies.
 */
export function redactJobPayloadSummary(
  rawPayloadJson: string | null,
): { readonly summary: Readonly<Record<string, unknown>> | null; readonly payloadRedacted: boolean } {
  if (!rawPayloadJson || !rawPayloadJson.trim()) {
    return { summary: null, payloadRedacted: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayloadJson);
  } catch {
    return { summary: { redactedMalformedPayload: REDACTED_VALUE }, payloadRedacted: true };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { summary: { value: REDACTED_VALUE }, payloadRedacted: true };
  }

  const pass1 = redactJobLogRecord(parsed as Record<string, unknown>);
  const pass2 = redactAuditMetadata(pass1);
  if (!pass2) {
    return { summary: null, payloadRedacted: true };
  }

  const bounded: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(pass2)) {
    bounded[k] = truncateRedactedValue(v, 0);
    keys += 1;
    if (keys >= MAX_REDACTED_SUMMARY_KEYS) break;
  }

  return {
    summary: keys > 0 ? bounded : null,
    payloadRedacted: true,
  };
}

/**
 * Pure job recovery eligibility evaluator (REQ-050; PLAN §13).
 * - Completed jobs are NEVER retryable or cancellable.
 * - Live running leases (`lease_until > nowMs`) can NEVER be stolen or cancelled.
 * - Failed, dead_letter, expired-lease running, and stale queued (>5m without lease) jobs are retry-eligible.
 */
export function evaluateJobRecoveryEligibility(params: {
  readonly status: JobStatus;
  readonly leaseUntil: number | null;
  readonly updatedAt?: number;
  readonly nowMs: number;
  readonly staleQueuedThresholdMs?: number;
}): {
  readonly leaseState: ConsoleJobLeaseState;
  readonly retryEligible: boolean;
  readonly retryIneligibleReasonCode: string | null;
  readonly retryIneligibleReason: string | null;
  readonly cancelEligible: boolean;
} {
  const staleQueuedThresholdMs = params.staleQueuedThresholdMs ?? STALE_QUEUED_JOB_THRESHOLD_MS;

  if (params.status === "completed") {
    return {
      leaseState: "none",
      retryEligible: false,
      retryIneligibleReasonCode: "JOB_ALREADY_COMPLETED",
      retryIneligibleReason: "Job sudah selesai dan tidak dapat dijalankan ulang.",
      cancelEligible: false,
    };
  }

  if (params.status === "running") {
    if (params.leaseUntil !== null && params.leaseUntil > params.nowMs) {
      return {
        leaseState: "active",
        retryEligible: false,
        retryIneligibleReasonCode: "JOB_LEASE_ACTIVE",
        retryIneligibleReason: "Lease job masih aktif; tidak dapat diambil alih.",
        cancelEligible: false,
      };
    }
    return {
      leaseState: "expired",
      retryEligible: true,
      retryIneligibleReasonCode: null,
      retryIneligibleReason: null,
      cancelEligible: true,
    };
  }

  if (params.status === "queued") {
    const isStaleQueued =
      params.leaseUntil === null &&
      typeof params.updatedAt === "number" &&
      params.nowMs - params.updatedAt >= staleQueuedThresholdMs;
    if (isStaleQueued) {
      return {
        leaseState: "none",
        retryEligible: true,
        retryIneligibleReasonCode: null,
        retryIneligibleReason: null,
        cancelEligible: true,
      };
    }
    return {
      leaseState: "none",
      retryEligible: false,
      retryIneligibleReasonCode: "JOB_ALREADY_QUEUED",
      retryIneligibleReason: "Job sudah berada dalam antrean eksekusi.",
      cancelEligible: true,
    };
  }

  // `failed` or `dead_letter`
  return {
    leaseState: "none",
    retryEligible: true,
    retryIneligibleReasonCode: null,
    retryIneligibleReason: null,
    cancelEligible: params.status === "failed",
  };
}

function mapConsoleJobRow(row: RawConsoleJobRow, nowMs: number): ConsoleJobQueueItem {
  const eligibility = evaluateJobRecoveryEligibility({
    status: row.status,
    leaseUntil: row.lease_until,
    updatedAt: row.updated_at,
    nowMs,
  });
  const redacted = redactJobPayloadSummary(row.payload_json);

  return {
    idempotencyKey: redactAuditText(row.idempotency_key),
    topic: row.topic,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    status: row.status,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    leaseState: eligibility.leaseState,
    lastErrorCode: row.last_error_code ? sanitizeErrorCode(row.last_error_code) : null,
    redactedPayloadSummary: redacted.summary,
    payloadRedacted: redacted.payloadRedacted,
    retryEligible: eligibility.retryEligible,
    retryIneligibleReasonCode: eligibility.retryIneligibleReasonCode,
    retryIneligibleReason: eligibility.retryIneligibleReason,
    cancelEligible: eligibility.cancelEligible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INTERNAL_RECEIPT_TOPICS_SQL = `jl.topic NOT IN (
  'tenant.state_transition',
  'tenant.theme_grant',
  'console.domain_recheck_receipt',
  'console.domain_change_receipt',
  'console.job_retry_receipt',
  'console.job_cancel_receipt'
)`;

/**
 * Lists background jobs from `PLATFORM_DB.job_ledger` with strict redaction and
 * exception-first ordering (`dead_letter`, `failed`, expired-lease `running`, stale `queued`).
 */
export async function listConsoleJobsQueue(
  platformDb: D1Database,
  options: ListConsoleJobsQueueOptions = {},
): Promise<ConsoleJobQueuePage> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const staleQueuedCutoffMs = nowMs - STALE_QUEUED_JOB_THRESHOLD_MS;
  const rawStatus = (options.status ?? "exceptions").trim().toLowerCase() || "exceptions";
  if (!VALID_JOB_FILTERS.has(rawStatus)) {
    throw new ConsoleRecoveryError(
      422,
      "VALIDATION_ERROR",
      `Filter status job "${rawStatus}" tidak valid.`,
    );
  }

  const page = Math.max(1, Math.min(1000, Math.trunc(options.page ?? 1)));
  const limit = Math.max(
    1,
    Math.min(MAX_RECOVERY_PAGE_LIMIT, Math.trunc(options.limit ?? DEFAULT_RECOVERY_PAGE_LIMIT)),
  );
  const offset = (page - 1) * limit;

  const clauses: string[] = [INTERNAL_RECEIPT_TOPICS_SQL];
  const bindings: (string | number)[] = [];

  if (options.topic?.trim() && options.topic.trim() !== "all") {
    clauses.push("jl.topic = ?");
    bindings.push(options.topic.trim());
  }
  if (options.tenantId?.trim()) {
    clauses.push("jl.tenant_id = ?");
    bindings.push(options.tenantId.trim());
  }

  const search = options.search?.trim().toLowerCase() ?? "";
  if (search) {
    const like = `%${search}%`;
    clauses.push(
      "(LOWER(jl.idempotency_key) LIKE ? OR LOWER(jl.topic) LIKE ? OR LOWER(COALESCE(jl.last_error_code, '')) LIKE ? OR LOWER(COALESCE(t.handle, '')) LIKE ? OR jl.tenant_id = ?)",
    );
    bindings.push(like, like, like, like, options.search!.trim());
  }

  if (rawStatus === "exceptions") {
    clauses.push(
      `(
        jl.status IN ('failed', 'dead_letter')
        OR (jl.status = 'running' AND (jl.lease_until IS NULL OR jl.lease_until <= ?))
        OR (jl.status = 'queued' AND jl.lease_until IS NULL AND jl.updated_at <= ?)
      )`,
    );
    bindings.push(nowMs, staleQueuedCutoffMs);
  } else if (rawStatus !== "all") {
    clauses.push("jl.status = ?");
    bindings.push(rawStatus);
  }

  const whereSql = `WHERE ${clauses.join(" AND ")}`;

  const [countRow, rowsRes, countsRow, topicsRes] = await Promise.all([
    platformDb
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM job_ledger jl
         LEFT JOIN tenants t ON t.id = jl.tenant_id
         ${whereSql}`,
      )
      .bind(...bindings)
      .first<{ readonly cnt: number }>(),
    platformDb
      .prepare(
        `SELECT
           jl.idempotency_key,
           jl.topic,
           jl.tenant_id,
           jl.status,
           jl.attempts,
           jl.lease_until,
           jl.last_error_code,
           jl.payload_json,
           jl.created_at,
           jl.updated_at,
           t.handle AS tenant_handle,
           t.name AS tenant_name
         FROM job_ledger jl
         LEFT JOIN tenants t ON t.id = jl.tenant_id
         ${whereSql}
         ORDER BY
           CASE
             WHEN jl.status = 'dead_letter' THEN 0
             WHEN jl.status = 'failed' THEN 1
             WHEN jl.status = 'running' AND (jl.lease_until IS NULL OR jl.lease_until <= ?) THEN 2
             WHEN jl.status = 'queued' AND jl.lease_until IS NULL AND jl.updated_at <= ? THEN 3
             WHEN jl.status = 'running' THEN 4
             WHEN jl.status = 'queued' THEN 5
             ELSE 6
           END ASC,
           jl.updated_at DESC,
           jl.idempotency_key ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, nowMs, staleQueuedCutoffMs, limit, offset)
      .all<RawConsoleJobRow>(),
    platformDb
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN jl.status IN ('failed', 'dead_letter')
             OR (jl.status = 'running' AND (jl.lease_until IS NULL OR jl.lease_until <= ?))
             OR (jl.status = 'queued' AND jl.lease_until IS NULL AND jl.updated_at <= ?) THEN 1 ELSE 0 END) AS exceptions,
           SUM(CASE WHEN jl.status = 'failed' THEN 1 ELSE 0 END) AS failed_cnt,
           SUM(CASE WHEN jl.status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_cnt,
           SUM(CASE WHEN jl.status = 'running' AND (jl.lease_until IS NULL OR jl.lease_until <= ?) THEN 1 ELSE 0 END) AS expired_running_cnt,
           SUM(CASE WHEN jl.status = 'queued' AND jl.lease_until IS NULL AND jl.updated_at <= ? THEN 1 ELSE 0 END) AS stale_queued_cnt,
           SUM(CASE WHEN jl.status = 'running' AND jl.lease_until > ? THEN 1 ELSE 0 END) AS active_running_cnt,
           SUM(CASE WHEN jl.status = 'queued' THEN 1 ELSE 0 END) AS queued_cnt,
           SUM(CASE WHEN jl.status = 'completed' THEN 1 ELSE 0 END) AS completed_cnt
         FROM job_ledger jl
         WHERE ${INTERNAL_RECEIPT_TOPICS_SQL}`,
      )
      .bind(nowMs, staleQueuedCutoffMs, nowMs, staleQueuedCutoffMs, nowMs)
      .first<{
        readonly total: number | null;
        readonly exceptions: number | null;
        readonly failed_cnt: number | null;
        readonly dead_letter_cnt: number | null;
        readonly expired_running_cnt: number | null;
        readonly stale_queued_cnt: number | null;
        readonly active_running_cnt: number | null;
        readonly queued_cnt: number | null;
        readonly completed_cnt: number | null;
      }>(),
    platformDb
      .prepare(
        `SELECT DISTINCT jl.topic
         FROM job_ledger jl
         WHERE ${INTERNAL_RECEIPT_TOPICS_SQL}
         ORDER BY jl.topic ASC
         LIMIT 50`,
      )
      .all<{ readonly topic: string }>(),
  ]);

  const totalCount = Number(countRow?.cnt ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const items = (rowsRes.results ?? []).map((row) => mapConsoleJobRow(row, nowMs));

  return {
    items,
    page,
    limit,
    totalCount,
    totalPages,
    hasMore: page < totalPages,
    counts: {
      total: Number(countsRow?.total ?? 0),
      exceptions: Number(countsRow?.exceptions ?? 0),
      failed: Number(countsRow?.failed_cnt ?? 0),
      deadLetter: Number(countsRow?.dead_letter_cnt ?? 0),
      expiredLeaseRunning: Number(countsRow?.expired_running_cnt ?? 0),
      staleQueued: Number(countsRow?.stale_queued_cnt ?? 0),
      activeLeaseRunning: Number(countsRow?.active_running_cnt ?? 0),
      queued: Number(countsRow?.queued_cnt ?? 0),
      completed: Number(countsRow?.completed_cnt ?? 0),
    },
    topics: (topicsRes.results ?? []).map((r) => r.topic),
  };
}

export async function getConsoleJobQueueItem(
  platformDb: D1Database,
  jobIdempotencyKey: string,
  nowMs: number,
): Promise<ConsoleJobQueueItem | null> {
  const row = await platformDb
    .prepare(
      `SELECT
         jl.idempotency_key,
         jl.topic,
         jl.tenant_id,
         jl.status,
         jl.attempts,
         jl.lease_until,
         jl.last_error_code,
         jl.payload_json,
         jl.created_at,
         jl.updated_at,
         t.handle AS tenant_handle,
         t.name AS tenant_name
       FROM job_ledger jl
       LEFT JOIN tenants t ON t.id = jl.tenant_id
       WHERE jl.idempotency_key = ? AND ${INTERNAL_RECEIPT_TOPICS_SQL}
       LIMIT 1`,
    )
    .bind(jobIdempotencyKey.trim())
    .first<RawConsoleJobRow>();

  return row ? mapConsoleJobRow(row, nowMs) : null;
}

export interface RetryConsoleJobInput {
  readonly actorUserId: string;
  readonly jobIdempotencyKey: string;
  readonly expectedTenantId: string | null;
  readonly expectedUpdatedAt: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly maxOperatorRetries?: number;
  readonly nowMs?: number;
}

export interface RetryConsoleJobResult {
  readonly job: ConsoleJobQueueItem;
  readonly replayed: boolean;
  readonly audit: PlatformAuditRecord | null;
  readonly receiptKey: string;
  readonly dispatchEnvelope: {
    readonly idempotencyKey: string;
    readonly topic: string;
    readonly tenantId: string | null;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
    readonly enqueuedAt: number;
  } | null;
}

function parseOriginalStoredPayload(raw: string | null): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Atomically resets an eligible `failed`, `dead_letter`, expired-lease `running`, or stale
 * `queued` (> 5 minutes, no lease) job to `queued` inside ONE `D1Database.batch([...])`:
 * 1. Conditional `UPDATE job_ledger` guarded by `tenant_id`, `updated_at = expectedUpdatedAt`,
 *    eligibility, AND bounded operator retry cap (`MAX_OPERATOR_JOB_RETRIES`).
 * 2. Append-only `platform_audit` gated on `WHERE changes() = 1`.
 * 3. Operator idempotency receipt (`console.job_retry_receipt`) gated on `WHERE changes() = 1`.
 */
export async function retryConsoleFailedJob(
  platformDb: D1Database,
  input: RetryConsoleJobInput,
): Promise<RetryConsoleJobResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const staleQueuedCutoffMs = nowMs - STALE_QUEUED_JOB_THRESHOLD_MS;
  const maxOperatorRetries = Math.max(
    1,
    Math.trunc(input.maxOperatorRetries ?? MAX_OPERATOR_JOB_RETRIES),
  );
  const cleanJobKey = input.jobIdempotencyKey.trim();
  if (!cleanJobKey) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan.");
  }

  const cleanReason = normalizeRecoveryReason(input.reason);
  const cleanIdempotencyKey = normalizeRecoveryIdempotencyKey(input.idempotencyKey);
  const expectedUpdatedAt = normalizePositiveVersion(input.expectedUpdatedAt, "expectedUpdatedAt");
  const normalizedExpectedTenantId =
    input.expectedTenantId === null ? null : input.expectedTenantId.trim() || null;

  const receiptKey = `console-job-retry:${cleanIdempotencyKey}`;
  const requestHash = await sha256Hex(
    JSON.stringify([
      cleanJobKey,
      normalizedExpectedTenantId,
      expectedUpdatedAt,
      cleanReason,
    ]),
  );

  // 1. Check idempotency receipt BEFORE version / eligibility checks
  const existingReceipt = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(receiptKey)
    .first<OperatorReceiptRow>();

  if (existingReceipt) {
    const stored = existingReceipt.payload_json
      ? (JSON.parse(existingReceipt.payload_json) as {
          readonly requestHash?: string;
          readonly jobIdempotencyKey?: string;
        })
      : null;
    if (
      existingReceipt.tenant_id !== normalizedExpectedTenantId ||
      !stored ||
      stored.requestHash !== requestHash
    ) {
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk retry job yang berbeda.",
      );
    }
    const existingJob = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
    if (!existingJob) {
      throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan.");
    }
    return {
      job: existingJob,
      replayed: true,
      audit: null,
      receiptKey,
      dispatchEnvelope: null,
    };
  }

  // 2. Load authoritative ledger row & enforce strict tenant scope (forged IDs -> 404)
  const rawRow = await platformDb
    .prepare(
      `SELECT
         jl.idempotency_key,
         jl.topic,
         jl.tenant_id,
         jl.status,
         jl.attempts,
         jl.lease_until,
         jl.last_error_code,
         jl.payload_json,
         jl.created_at,
         jl.updated_at,
         t.handle AS tenant_handle,
         t.name AS tenant_name
       FROM job_ledger jl
       LEFT JOIN tenants t ON t.id = jl.tenant_id
       WHERE jl.idempotency_key = ? AND ${INTERNAL_RECEIPT_TOPICS_SQL}
       LIMIT 1`,
    )
    .bind(cleanJobKey)
    .first<RawConsoleJobRow>();

  if (!rawRow || rawRow.tenant_id !== normalizedExpectedTenantId) {
    throw new ConsoleRecoveryError(
      404,
      "NOT_FOUND",
      "Job tidak ditemukan atau tidak cocok dengan lingkup tenant yang diminta.",
    );
  }

  // 3. Enforce recovery eligibility (live leases & completed jobs strictly rejected!)
  const eligibility = evaluateJobRecoveryEligibility({
    status: rawRow.status,
    leaseUntil: rawRow.lease_until,
    updatedAt: rawRow.updated_at,
    nowMs,
  });
  if (!eligibility.retryEligible) {
    const code: ConsoleRecoveryErrorCode =
      eligibility.retryIneligibleReasonCode === "JOB_ALREADY_COMPLETED"
        ? "JOB_ALREADY_COMPLETED"
        : eligibility.retryIneligibleReasonCode === "JOB_LEASE_ACTIVE"
          ? "JOB_LEASE_ACTIVE"
          : "JOB_NOT_RETRYABLE";
    throw new ConsoleRecoveryError(
      409,
      code,
      eligibility.retryIneligibleReason ?? "Job tidak memenuhi syarat untuk dijalankan ulang.",
    );
  }

  // 4. Enforce bounded operator retry cap using full-key SHA-256 hash & excluding compensated queue outages
  const jobKeyHash = await sha256Hex(cleanJobKey);
  const priorRetriesRow = await platformDb
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM platform_audit pa
       WHERE pa.action = 'console.job.retry'
         AND pa.target_type = 'job_ledger'
         AND pa.outcome = 'success'
         AND json_extract(pa.metadata_json, '$.jobKeyHash') = ?
         AND NOT EXISTS (
           SELECT 1 FROM platform_audit df
           WHERE df.action = 'console.job.retry.dispatch_failed'
             AND df.request_id = pa.request_id
         )`,
    )
    .bind(jobKeyHash)
    .first<{ readonly cnt: number }>();

  const priorOperatorRetries = Number(priorRetriesRow?.cnt ?? 0);
  if (priorOperatorRetries >= maxOperatorRetries) {
    throw new ConsoleRecoveryError(
      409,
      "JOB_RETRY_LIMIT_REACHED",
      `Batas maksimum retry operator (${maxOperatorRetries} kali) untuk job ini telah tercapai.`,
    );
  }

  // 5. Optimistic concurrency check on `updated_at`
  if (rawRow.updated_at !== expectedUpdatedAt) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Status job sudah berubah sejak terakhir dimuat. Muat ulang antrean sebelum mencoba lagi.",
    );
  }

  const nextUpdatedAt = Math.max(nowMs, rawRow.updated_at + 1);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.job.retry",
      targetType: "job_ledger",
      targetId: cleanJobKey,
      tenantId: rawRow.tenant_id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId,
      metadata: {
        topic: rawRow.topic,
        jobKeyHash,
        previousStatus: rawRow.status,
        previousAttempts: rawRow.attempts,
        operatorRetryNumber: priorOperatorRetries + 1,
        maxOperatorRetries,
        previousErrorCode: rawRow.last_error_code ? sanitizeErrorCode(rawRow.last_error_code) : null,
        expectedUpdatedAt,
        idempotencyKey: cleanIdempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const updateJobStmt = platformDb
    .prepare(
      `UPDATE job_ledger
       SET status = 'queued',
           attempts = 0,
           lease_until = NULL,
           last_error_code = NULL,
           updated_at = ?
       WHERE idempotency_key = ?
         AND ((tenant_id IS NULL AND ? IS NULL) OR tenant_id = ?)
         AND updated_at = ?
         AND (
           status IN ('failed', 'dead_letter')
           OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
           OR (status = 'queued' AND lease_until IS NULL AND updated_at <= ?)
         )
         AND (
           SELECT COUNT(*)
           FROM platform_audit pa
           WHERE pa.action = 'console.job.retry'
             AND pa.target_type = 'job_ledger'
             AND pa.outcome = 'success'
             AND json_extract(pa.metadata_json, '$.jobKeyHash') = ?
             AND NOT EXISTS (
               SELECT 1 FROM platform_audit df
               WHERE df.action = 'console.job.retry.dispatch_failed'
                 AND df.request_id = pa.request_id
             )
         ) < ?`,
    )
    .bind(
      nextUpdatedAt,
      cleanJobKey,
      normalizedExpectedTenantId,
      normalizedExpectedTenantId,
      expectedUpdatedAt,
      nowMs,
      staleQueuedCutoffMs,
      jobKeyHash,
      maxOperatorRetries,
    );

  const receiptStmt = platformDb
    .prepare(
      `INSERT INTO job_ledger (
         idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
       )
       SELECT ?, 'console.job_retry_receipt', ?, 'completed', 1, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      receiptKey,
      rawRow.tenant_id,
      JSON.stringify({
        jobIdempotencyKey: cleanJobKey,
        requestHash,
        previousStatus: rawRow.status,
      }),
      nowMs,
      nowMs,
    );

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateJobStmt, auditStmt, receiptStmt]);
  } catch (err) {
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(receiptKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === normalizedExpectedTenantId && stored?.requestHash === requestHash) {
        const refreshed = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
        if (refreshed) {
          return {
            job: refreshed,
            replayed: true,
            audit: null,
            receiptKey,
            dispatchEnvelope: null,
          };
        }
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk retry job yang berbeda.",
        { cause: err },
      );
    }

    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menjadwalkan ulang job dan menyimpan catatan audit secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    // Finding 7: Re-query receipt FIRST on concurrent same-Idempotency-Key race!
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(receiptKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === normalizedExpectedTenantId && stored?.requestHash === requestHash) {
        const refreshed = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
        if (refreshed) {
          return {
            job: refreshed,
            replayed: true,
            audit: null,
            receiptKey,
            dispatchEnvelope: null,
          };
        }
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk retry job yang berbeda.",
      );
    }

    const latest = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
    if (latest?.status === "completed") {
      throw new ConsoleRecoveryError(
        409,
        "JOB_ALREADY_COMPLETED",
        "Job sudah selesai dan tidak dapat dijalankan ulang.",
      );
    }
    if (latest?.leaseState === "active") {
      throw new ConsoleRecoveryError(
        409,
        "JOB_LEASE_ACTIVE",
        "Lease job sedang aktif dan tidak dapat diambil alih.",
      );
    }
    const retryCountNow = await platformDb
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM platform_audit pa
         WHERE pa.action = 'console.job.retry'
           AND pa.target_type = 'job_ledger'
           AND pa.outcome = 'success'
           AND json_extract(pa.metadata_json, '$.jobKeyHash') = ?
           AND NOT EXISTS (
             SELECT 1 FROM platform_audit df
             WHERE df.action = 'console.job.retry.dispatch_failed'
               AND df.request_id = pa.request_id
           )`,
      )
      .bind(jobKeyHash)
      .first<{ readonly cnt: number }>();
    if (Number(retryCountNow?.cnt ?? 0) >= maxOperatorRetries) {
      throw new ConsoleRecoveryError(
        409,
        "JOB_RETRY_LIMIT_REACHED",
        `Batas maksimum retry operator (${maxOperatorRetries} kali) untuk job ini telah tercapai.`,
      );
    }
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Status job berubah secara bersamaan. Muat ulang antrean sebelum mencoba lagi.",
    );
  }

  const updated = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
  if (!updated) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan setelah pembaruan.");
  }

  return {
    job: updated,
    replayed: false,
    audit: auditEntry,
    receiptKey,
    dispatchEnvelope: {
      idempotencyKey: cleanJobKey,
      topic: rawRow.topic,
      tenantId: rawRow.tenant_id,
      payload: parseOriginalStoredPayload(rawRow.payload_json),
      correlationId: input.requestId,
      enqueuedAt: nowMs,
    },
  };
}

/**
 * Reverts a freshly-queued retried job back to `failed` with a sanitized error code
 * and removes the failed retry idempotency receipt when downstream Cloudflare Queue
 * is unavailable or dispatch fails (never leaving a job stuck in `queued` or returning false success!).
 */
export async function markRetriedJobDispatchFailed(
  platformDb: D1Database,
  input: {
    readonly jobIdempotencyKey: string;
    readonly receiptKey: string;
    readonly errorCode: string;
    readonly actorUserId: string;
    readonly tenantId: string | null;
    readonly reason: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<ConsoleJobQueueItem | null> {
  const safeCode = sanitizeErrorCode(input.errorCode);
  const jobKeyHash = await sha256Hex(input.jobIdempotencyKey.trim());
  const { statement: auditStmt } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.job.retry.dispatch_failed",
      targetType: "job_ledger",
      targetId: input.jobIdempotencyKey,
      tenantId: input.tenantId,
      reason: input.reason,
      requireReason: true,
      outcome: "error",
      requestId: input.requestId,
      metadata: { errorCode: safeCode, jobKeyHash },
      createdAtMs: input.nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE job_ledger
         SET status = 'failed',
             last_error_code = ?,
             updated_at = ?
         WHERE idempotency_key = ? AND status = 'queued'`,
      )
      .bind(safeCode, input.nowMs + 2, input.jobIdempotencyKey),
    auditStmt,
    platformDb
      .prepare("DELETE FROM job_ledger WHERE idempotency_key = ? AND topic = 'console.job_retry_receipt'")
      .bind(input.receiptKey),
  ]);

  return getConsoleJobQueueItem(platformDb, input.jobIdempotencyKey, input.nowMs + 2);
}

export interface CancelConsoleJobInput {
  readonly actorUserId: string;
  readonly jobIdempotencyKey: string;
  readonly expectedTenantId: string | null;
  readonly expectedUpdatedAt: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly nowMs?: number;
}

/**
 * Atomically transitions an eligible `queued` / `failed` / expired-lease `running` job to
 * terminal `dead_letter` (`OPERATOR_CANCELED`) with `WHERE changes() = 1` audit + idempotency.
 * Rejects completed jobs and active leases.
 */
export async function cancelConsoleJobToDeadLetter(
  platformDb: D1Database,
  input: CancelConsoleJobInput,
): Promise<{
  readonly job: ConsoleJobQueueItem;
  readonly replayed: boolean;
  readonly audit: PlatformAuditRecord | null;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const cleanJobKey = input.jobIdempotencyKey.trim();
  if (!cleanJobKey) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan.");
  }

  const cleanReason = normalizeRecoveryReason(input.reason);
  const cleanIdempotencyKey = normalizeRecoveryIdempotencyKey(input.idempotencyKey);
  const expectedUpdatedAt = normalizePositiveVersion(input.expectedUpdatedAt, "expectedUpdatedAt");
  const normalizedExpectedTenantId =
    input.expectedTenantId === null ? null : input.expectedTenantId.trim() || null;

  const receiptKey = `console-job-cancel:${cleanIdempotencyKey}`;
  const requestHash = await sha256Hex(
    JSON.stringify([cleanJobKey, normalizedExpectedTenantId, expectedUpdatedAt, cleanReason]),
  );

  const existingReceipt = await platformDb
    .prepare(
      "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
    )
    .bind(receiptKey)
    .first<OperatorReceiptRow>();

  if (existingReceipt) {
    const stored = existingReceipt.payload_json
      ? (JSON.parse(existingReceipt.payload_json) as { readonly requestHash?: string })
      : null;
    if (
      existingReceipt.tenant_id !== normalizedExpectedTenantId ||
      !stored ||
      stored.requestHash !== requestHash
    ) {
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk pembatalan job yang berbeda.",
      );
    }
    const existingJob = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
    if (!existingJob) {
      throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan.");
    }
    return { job: existingJob, replayed: true, audit: null };
  }

  const rawRow = await platformDb
    .prepare(
      `SELECT
         jl.idempotency_key,
         jl.topic,
         jl.tenant_id,
         jl.status,
         jl.attempts,
         jl.lease_until,
         jl.last_error_code,
         jl.payload_json,
         jl.created_at,
         jl.updated_at,
         t.handle AS tenant_handle,
         t.name AS tenant_name
       FROM job_ledger jl
       LEFT JOIN tenants t ON t.id = jl.tenant_id
       WHERE jl.idempotency_key = ? AND ${INTERNAL_RECEIPT_TOPICS_SQL}
       LIMIT 1`,
    )
    .bind(cleanJobKey)
    .first<RawConsoleJobRow>();

  if (!rawRow || rawRow.tenant_id !== normalizedExpectedTenantId) {
    throw new ConsoleRecoveryError(
      404,
      "NOT_FOUND",
      "Job tidak ditemukan atau tidak cocok dengan lingkup tenant yang diminta.",
    );
  }

  const eligibility = evaluateJobRecoveryEligibility({
    status: rawRow.status,
    leaseUntil: rawRow.lease_until,
    updatedAt: rawRow.updated_at,
    nowMs,
  });

  if (!eligibility.cancelEligible) {
    const code: ConsoleRecoveryErrorCode =
      rawRow.status === "completed"
        ? "JOB_ALREADY_COMPLETED"
        : eligibility.leaseState === "active"
          ? "JOB_LEASE_ACTIVE"
          : "JOB_NOT_RETRYABLE";
    throw new ConsoleRecoveryError(
      409,
      code,
      rawRow.status === "completed"
        ? "Job sudah selesai dan tidak dapat dibatalkan."
        : eligibility.leaseState === "active"
          ? "Lease job masih aktif; tidak dapat dibatalkan saat sedang berjalan."
          : "Job sudah berada di dead-letter.",
    );
  }

  if (rawRow.updated_at !== expectedUpdatedAt) {
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Status job sudah berubah sejak terakhir dimuat. Muat ulang sebelum mencoba lagi.",
    );
  }

  const nextUpdatedAt = Math.max(nowMs, rawRow.updated_at + 1);
  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: "console.job.cancel",
      targetType: "job_ledger",
      targetId: cleanJobKey,
      tenantId: rawRow.tenant_id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId,
      metadata: {
        topic: rawRow.topic,
        previousStatus: rawRow.status,
        expectedUpdatedAt,
        idempotencyKey: cleanIdempotencyKey,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE job_ledger
           SET status = 'dead_letter',
               lease_until = NULL,
               last_error_code = 'OPERATOR_CANCELED',
               updated_at = ?
           WHERE idempotency_key = ?
             AND ((tenant_id IS NULL AND ? IS NULL) OR tenant_id = ?)
             AND updated_at = ?
             AND (
               status IN ('queued', 'failed')
               OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
             )`,
        )
        .bind(
          nextUpdatedAt,
          cleanJobKey,
          normalizedExpectedTenantId,
          normalizedExpectedTenantId,
          expectedUpdatedAt,
          nowMs,
        ),
      auditStmt,
      platformDb
        .prepare(
          `INSERT INTO job_ledger (
             idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
           )
           SELECT ?, 'console.job_cancel_receipt', ?, 'completed', 1, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          receiptKey,
          rawRow.tenant_id,
          JSON.stringify({ jobIdempotencyKey: cleanJobKey, requestHash }),
          nowMs,
          nowMs,
        ),
    ]);
  } catch (err) {
    throw new ConsoleRecoveryError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal membatalkan job dan menyimpan log audit secara atomik.",
      { cause: err },
    );
  }

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const raceReceipt = await platformDb
      .prepare(
        "SELECT idempotency_key, tenant_id, status, payload_json FROM job_ledger WHERE idempotency_key = ? LIMIT 1",
      )
      .bind(receiptKey)
      .first<OperatorReceiptRow>();
    if (raceReceipt) {
      const stored = raceReceipt.payload_json
        ? (JSON.parse(raceReceipt.payload_json) as { readonly requestHash?: string })
        : null;
      if (raceReceipt.tenant_id === normalizedExpectedTenantId && stored?.requestHash === requestHash) {
        const refreshed = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
        if (refreshed) return { job: refreshed, replayed: true, audit: null };
      }
      throw new ConsoleRecoveryError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk pembatalan job yang berbeda.",
      );
    }
    throw new ConsoleRecoveryError(
      409,
      "STALE_VERSION",
      "Status job berubah secara bersamaan. Muat ulang antrean sebelum mencoba lagi.",
    );
  }

  const updated = await getConsoleJobQueueItem(platformDb, cleanJobKey, nowMs);
  if (!updated) {
    throw new ConsoleRecoveryError(404, "NOT_FOUND", "Job tidak ditemukan setelah pembaruan.");
  }

  return { job: updated, replayed: false, audit: auditEntry };
}
