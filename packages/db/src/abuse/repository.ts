import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import { computeAuthoritativeDeletionDueAt } from "@punyasitus/core/billing/offboarding";
import {
  ALLOWED_EMAIL_SENDER,
  renderEmailTemplate,
  type EmailPort,
  type EmailSendRequest,
  type EmailTemplateDataMap,
} from "@punyasitus/core/email/index";
import { isEmailSuppressed } from "../email/suppressions.ts";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  redactAuditText,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";
import {
  DEFAULT_ABUSE_REPORT_RATE_LIMIT_POLICY,
  hashNetworkIdentifier,
  type AbuseReportRateLimitPolicy,
} from "../rate-limits/limiter.ts";

/**
 * Public Abuse Reporting & Console Moderation Queue Repository
 * (REQ-094, REQ-039, REQ-049, REQ-051; PLAN §5.1, §6, §13, §19.5; TASK-094).
 *
 * Security & durability invariants:
 * - Public abuse submission rate limiting operates atomically on `PLATFORM_DB.abuse_rate_limit_buckets`
 *   using HMAC-SHA256 salted IP hashes, opportunistically prunes expired buckets, and FAILS CLOSED
 *   (`503 SERVICE_UNAVAILABLE`) on datastore outage.
 * - `unpublish` executes and verifies the `TenantStore` content unpublish (actual SQLite `changes === 1`)
 *   FIRST, failing closed (`503 TENANT_STORE_UNAVAILABLE` or `422 TARGET_CONTENT_NOT_FOUND`) before
 *   finalizing `PLATFORM_DB`, and compensates/restores the published snapshot cleanly if the subsequent
 *   `PLATFORM_DB` commit fails or loses an optimistic concurrency race.
 * - `suspend` enforces lifecycle, offboarding, and CAS guards (`status NOT IN ('provisioning','purging',
 *   'purged','recovery')`, `offboarding_started_at IS NULL`, `version = ?`), computes authoritative
 *   `deletion_due_at` & `retention_paused_at`, and atomically cross-guards both `tenants` and
 *   `abuse_reports` inside ONE D1 `batch()` transaction.
 * - Owner moderation notices are durably recorded in `job_ledger` inside the moderation transaction
 *   and dispatched via `JOBS_QUEUE` (or direct `EmailPort` fallback when queue is absent), truthfully
 *   recording `notification_status` (`queued` / `sent` / `skipped` / `failed`).
 * - Platform operator entries mirrored into `TenantStore.tenant_activity_log` NEVER store internal
 *   operator `actor_user_id` values (`actor_user_id = NULL`).
 */

export const ABUSE_CATEGORIES = [
  "phishing",
  "scam",
  "malware",
  "impersonation",
  "illegal_content",
  "spam",
  "other",
] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

export const ABUSE_REPORT_STATUSES = [
  "open",
  "investigating",
  "resolved",
  "dismissed",
] as const;
export type AbuseReportStatus = (typeof ABUSE_REPORT_STATUSES)[number];

export const ABUSE_MODERATION_ACTIONS = ["dismiss", "unpublish", "suspend"] as const;
export type AbuseModerationAction = (typeof ABUSE_MODERATION_ACTIONS)[number];

export const ABUSE_NOTIFICATION_STATUSES = ["queued", "sent", "skipped", "failed"] as const;
export type AbuseNotificationStatus = (typeof ABUSE_NOTIFICATION_STATUSES)[number];

export const ABUSE_CATEGORY_LABELS_ID: Readonly<Record<AbuseCategory, string>> = Object.freeze({
  phishing: "Phishing / Penipuan Tautan",
  scam: "Penipuan / Transaksi Fiktif",
  malware: "Malware / Tautan Berbahaya",
  impersonation: "Peniruan Identitas / Merek",
  illegal_content: "Konten Ilegal / Terlarang",
  spam: "Spam / Penyalahgunaan Formulir",
  other: "Pelanggaran Lainnya",
});

export const ABUSE_STATUS_LABELS_ID: Readonly<Record<AbuseReportStatus, string>> = Object.freeze({
  open: "Terbuka",
  investigating: "Ditinjau",
  resolved: "Selesai",
  dismissed: "Ditolak",
});

export const ABUSE_ACTION_LABELS_ID: Readonly<Record<AbuseModerationAction, string>> = Object.freeze({
  dismiss: "Laporan Ditolak (Tidak Melanggar)",
  unpublish: "Konten Dinonaktifkan (Unpublish)",
  suspend: "Situs Ditangguhkan (Suspended)",
});

export const MIN_ABUSE_DESCRIPTION_LENGTH = 10 as const;
export const MAX_ABUSE_DESCRIPTION_LENGTH = 2000 as const;
export const MAX_ABUSE_PATH_LENGTH = 200 as const;
export const MAX_REPORTER_EMAIL_LENGTH = 254 as const;
export const DEFAULT_ABUSE_LIST_LIMIT = 20 as const;
export const MAX_ABUSE_LIST_LIMIT = 100 as const;

const ABUSE_CATEGORY_SET: ReadonlySet<string> = new Set(ABUSE_CATEGORIES);
const ABUSE_STATUS_SET: ReadonlySet<string> = new Set(ABUSE_REPORT_STATUSES);
const ABUSE_ACTION_SET: ReadonlySet<string> = new Set(ABUSE_MODERATION_ACTIONS);
const NON_ELIGIBLE_SUSPEND_STATUSES: ReadonlySet<string> = new Set([
  "provisioning",
  "purging",
  "purged",
  "recovery",
]);
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ABUSE_MODERATION_EMAIL_TOPIC = "email.transactional.send" as const;

export interface AbuseFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type AbuseErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "ALREADY_MODERATED"
  | "TENANT_NOT_ELIGIBLE"
  | "TARGET_CONTENT_NOT_FOUND"
  | "TENANT_STORE_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "AUDIT_PERSISTENCE_FAILED"
  | "SERVICE_UNAVAILABLE";

export class AbuseModerationError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 500 | 503;
  readonly code: AbuseErrorCode;
  readonly fields: readonly AbuseFieldError[];

  constructor(
    status: 400 | 404 | 409 | 422 | 500 | 503,
    code: AbuseErrorCode,
    message: string,
    fields: readonly AbuseFieldError[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AbuseModerationError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface ValidatedPublicAbuseReportInput {
  readonly category: AbuseCategory;
  readonly reportedPath: string;
  readonly description: string;
  readonly reporterEmail: string | null;
  readonly returnTo: string | null;
}

export type ValidatePublicAbuseReportResult =
  | { readonly ok: true; readonly data: ValidatedPublicAbuseReportInput }
  | { readonly ok: false; readonly message: string; readonly fields: readonly AbuseFieldError[] };

const PUBLIC_ABUSE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "category",
  "reportedPath",
  "reportedUrl",
  "description",
  "reporterEmail",
  "returnTo",
]);

function stripDangerousControls(value: string, allowLineBreaks: boolean): string {
  let cleaned = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isLineOrTab = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code <= 0x1f && !isLineOrTab) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }
    cleaned += value[i] ?? "";
  }
  if (!allowLineBreaks) {
    return cleaned.replace(/[\r\n\t]+/g, " ");
  }
  return cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalizes and validates a relative path on the reported tenant host.
 * Rejects protocol-relative URLs, query strings, fragments, backslashes, and `..` traversals.
 */
export function normalizeReportedPath(
  rawPath: unknown,
  verifiedHost: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
  if (typeof rawPath !== "string") {
    return { ok: false, message: "Path halaman yang dilaporkan wajib diisi." };
  }
  const trimmed = stripDangerousControls(rawPath, false).trim();
  if (!trimmed) {
    return { ok: false, message: "Path halaman yang dilaporkan wajib diisi." };
  }

  let candidatePath = trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, message: "Format URL halaman yang dilaporkan tidak valid." };
    }
    const urlHost = normalizeHost(parsed.hostname);
    const expectedHost = normalizeHost(verifiedHost);
    if (!urlHost || !expectedHost || urlHost !== expectedHost) {
      return {
        ok: false,
        message: "URL yang dilaporkan harus berasal dari situs ini.",
      };
    }
    candidatePath = parsed.pathname || "/";
  }

  if (!candidatePath.startsWith("/") || candidatePath.startsWith("//")) {
    return { ok: false, message: "Path halaman harus diawali dengan '/'." };
  }
  if (candidatePath.includes("?") || candidatePath.includes("#") || candidatePath.includes("\\")) {
    return {
      ok: false,
      message: "Path halaman tidak boleh menyertakan parameter query atau karakter khusus.",
    };
  }
  if (candidatePath.includes("..")) {
    return { ok: false, message: "Path halaman tidak valid." };
  }
  if (candidatePath.length > MAX_ABUSE_PATH_LENGTH) {
    return {
      ok: false,
      message: `Path halaman maksimal ${MAX_ABUSE_PATH_LENGTH} karakter.`,
    };
  }
  return { ok: true, path: candidatePath };
}

function sanitizeOptionalReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = stripDangerousControls(raw, false).trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  if (trimmed.includes("\\") || trimmed.includes("..")) return null;
  if (trimmed.length > MAX_ABUSE_PATH_LENGTH) return null;
  return trimmed;
}

/**
 * Strictly validates and sanitizes a public abuse report payload (PLAN §6, REQ-094).
 */
export function validatePublicAbuseReportInput(
  rawPayload: Readonly<Record<string, unknown>>,
  verifiedHost: string,
): ValidatePublicAbuseReportResult {
  const fields: AbuseFieldError[] = [];

  for (const key of Object.keys(rawPayload)) {
    if (!PUBLIC_ABUSE_ALLOWED_KEYS.has(key)) {
      fields.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field tidak dikenal "${key}".`,
      });
    }
  }
  if (fields.length > 0) {
    return {
      ok: false,
      message: "Permintaan mengandung field yang tidak diizinkan.",
      fields,
    };
  }

  const rawCategory =
    typeof rawPayload.category === "string" ? rawPayload.category.trim().toLowerCase() : "";
  if (!ABUSE_CATEGORY_SET.has(rawCategory)) {
    fields.push({
      field: "category",
      code: "INVALID_CATEGORY",
      message: "Pilih kategori laporan penyalahgunaan yang valid.",
    });
  }

  const rawPathSource =
    rawPayload.reportedPath !== undefined && rawPayload.reportedPath !== ""
      ? rawPayload.reportedPath
      : rawPayload.reportedUrl;
  const pathCheck = normalizeReportedPath(rawPathSource, verifiedHost);
  if (!pathCheck.ok) {
    fields.push({
      field: rawPayload.reportedPath !== undefined ? "reportedPath" : "reportedUrl",
      code: "INVALID_PATH",
      message: pathCheck.message,
    });
  }

  const rawDescription =
    typeof rawPayload.description === "string"
      ? stripDangerousControls(rawPayload.description, true).trim()
      : "";
  if (rawDescription.length < MIN_ABUSE_DESCRIPTION_LENGTH) {
    fields.push({
      field: "description",
      code: "TOO_SHORT",
      message: `Uraian laporan minimal ${MIN_ABUSE_DESCRIPTION_LENGTH} karakter.`,
    });
  } else if (rawDescription.length > MAX_ABUSE_DESCRIPTION_LENGTH) {
    fields.push({
      field: "description",
      code: "TOO_LONG",
      message: `Uraian laporan maksimal ${MAX_ABUSE_DESCRIPTION_LENGTH} karakter.`,
    });
  }

  let reporterEmail: string | null = null;
  if (rawPayload.reporterEmail !== undefined && rawPayload.reporterEmail !== null) {
    if (typeof rawPayload.reporterEmail !== "string") {
      fields.push({
        field: "reporterEmail",
        code: "INVALID_EMAIL",
        message: "Format email pelapor tidak valid.",
      });
    } else {
      const cleanedEmail = stripDangerousControls(rawPayload.reporterEmail, false)
        .trim()
        .toLowerCase();
      if (cleanedEmail.length > 0) {
        if (
          cleanedEmail.length > MAX_REPORTER_EMAIL_LENGTH ||
          !EMAIL_FORMAT_RE.test(cleanedEmail)
        ) {
          fields.push({
            field: "reporterEmail",
            code: "INVALID_EMAIL",
            message: "Masukkan alamat email pelapor yang valid atau kosongkan field ini.",
          });
        } else {
          reporterEmail = cleanedEmail;
        }
      }
    }
  }

  if (fields.length > 0 || !pathCheck.ok) {
    return {
      ok: false,
      message: fields[0]?.message ?? "Data laporan penyalahgunaan tidak valid.",
      fields,
    };
  }

  return {
    ok: true,
    data: {
      category: rawCategory as AbuseCategory,
      reportedPath: pathCheck.path,
      description: rawDescription,
      reporterEmail,
      returnTo: sanitizeOptionalReturnPath(rawPayload.returnTo),
    },
  };
}

export type AbuseRateLimitResult =
  | { readonly ok: true; readonly allowed: true; readonly remaining: number; readonly resetAt: number }
  | {
      readonly ok: true;
      readonly allowed: false;
      readonly status: 429;
      readonly code: "RATE_LIMITED";
      readonly retryAfterSeconds: number;
      readonly resetAt: number;
      readonly violatedRule: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: 503;
      readonly code: "SERVICE_UNAVAILABLE";
      readonly message: string;
    };

interface RawRateBucketRow {
  readonly count: number;
  readonly window_start: number;
  readonly expires_at: number;
}

/**
 * Opportunistically prunes expired rows from `abuse_rate_limit_buckets` (`expires_at <= nowMs`)
 * using the `abuse_rate_limit_buckets_expires_idx` index so per-IP-hash buckets stay bounded.
 */
export async function pruneExpiredAbuseRateLimitBuckets(
  platformDb: D1Database,
  nowMs: number = Date.now(),
): Promise<number> {
  try {
    const res = await platformDb
      .prepare("DELETE FROM abuse_rate_limit_buckets WHERE expires_at <= ?")
      .bind(Math.floor(nowMs))
      .run();
    return res.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

async function consumePlatformAbuseBucket(
  platformDb: D1Database,
  bucketKey: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<
  | {
      readonly ok: true;
      readonly allowed: boolean;
      readonly remaining: number;
      readonly resetAt: number;
      readonly retryAfterSeconds: number;
    }
  | { readonly ok: false }
> {
  const nextExpiresAt = nowMs + windowMs;
  try {
    const row = await platformDb
      .prepare(
        `INSERT INTO abuse_rate_limit_buckets (bucket_key, window_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET
           window_start = CASE
             WHEN abuse_rate_limit_buckets.expires_at <= excluded.window_start THEN excluded.window_start
             ELSE abuse_rate_limit_buckets.window_start
           END,
           count = CASE
             WHEN abuse_rate_limit_buckets.expires_at <= excluded.window_start THEN 1
             ELSE abuse_rate_limit_buckets.count + 1
           END,
           expires_at = CASE
             WHEN abuse_rate_limit_buckets.expires_at <= excluded.window_start THEN excluded.expires_at
             ELSE abuse_rate_limit_buckets.expires_at
           END
         RETURNING count, window_start, expires_at`,
      )
      .bind(bucketKey, nowMs, nextExpiresAt)
      .first<RawRateBucketRow>();

    if (!row) return { ok: false };
    const count = Number(row.count);
    const expiresAt = Number(row.expires_at);
    if (!Number.isFinite(count) || !Number.isFinite(expiresAt)) return { ok: false };

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((expiresAt - nowMs) / 1000));
    return { ok: true, allowed, remaining, resetAt: expiresAt, retryAfterSeconds };
  } catch {
    return { ok: false };
  }
}

/**
 * Fail-closed atomic D1 rate limiter for `POST /api/abuse-report` (PLAN §6, REQ-094).
 * Enforces `5/min` per salted network+tenant bucket and `50/hr` per tenant by default,
 * and opportunistically prunes expired rows from `abuse_rate_limit_buckets`.
 */
export async function enforceAbuseReportRateLimit(
  platformDb: D1Database | null | undefined,
  input: {
    readonly tenantId: string;
    readonly clientIp: string | null | undefined;
    readonly salt: string | undefined;
    readonly nowMs?: number;
    readonly policy?: AbuseReportRateLimitPolicy;
  },
): Promise<AbuseRateLimitResult> {
  const salt = input.salt?.trim();
  if (!platformDb || !salt) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pelaporan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.",
    };
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const policy = input.policy ?? DEFAULT_ABUSE_REPORT_RATE_LIMIT_POLICY;

  let ipHash: string;
  try {
    ipHash = await hashNetworkIdentifier(input.clientIp, salt);
  } catch {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pelaporan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.",
    };
  }

  // Opportunistic indexed cleanup of expired buckets (never blocks or weakens fail-closed checks)
  await pruneExpiredAbuseRateLimitBuckets(platformDb, nowMs);

  const networkKey = `abuse:t:${input.tenantId}:net:${ipHash}`;
  const tenantKey = `abuse:t:${input.tenantId}:hour`;

  const netRes = await consumePlatformAbuseBucket(
    platformDb,
    networkKey,
    policy.perNetworkMinute.limit,
    policy.perNetworkMinute.windowMs,
    nowMs,
  );
  if (!netRes.ok) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pelaporan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.",
    };
  }
  if (!netRes.allowed) {
    return {
      ok: true,
      allowed: false,
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: netRes.retryAfterSeconds,
      resetAt: netRes.resetAt,
      violatedRule: policy.perNetworkMinute.name,
      message:
        "Terlalu banyak laporan dikirim dalam waktu singkat. Silakan tunggu sebentar lalu coba lagi.",
    };
  }

  const tenantRes = await consumePlatformAbuseBucket(
    platformDb,
    tenantKey,
    policy.perTenantHour.limit,
    policy.perTenantHour.windowMs,
    nowMs,
  );
  if (!tenantRes.ok) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan pelaporan sementara tidak tersedia. Silakan coba lagi beberapa saat lagi.",
    };
  }
  if (!tenantRes.allowed) {
    return {
      ok: true,
      allowed: false,
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: tenantRes.retryAfterSeconds,
      resetAt: tenantRes.resetAt,
      violatedRule: policy.perTenantHour.name,
      message: "Batas penerimaan laporan sementara tercapai. Silakan coba lagi beberapa saat lagi.",
    };
  }

  return {
    ok: true,
    allowed: true,
    remaining: Math.min(netRes.remaining, tenantRes.remaining),
    resetAt: Math.min(netRes.resetAt, tenantRes.resetAt),
  };
}

export interface CreateAbuseReportInput {
  readonly tenantId: string;
  readonly reportedHost: string;
  readonly reportedPath: string;
  readonly category: AbuseCategory;
  readonly description: string;
  readonly reporterEmail: string | null;
  readonly nowMs?: number;
}

export interface CreateAbuseReportResult {
  readonly reportId: string;
  readonly status: "received";
}

/**
 * Persists a sanitized anonymous abuse report into `PLATFORM_DB.abuse_reports`.
 */
export async function createAbuseReport(
  platformDb: D1Database,
  input: CreateAbuseReportInput,
): Promise<CreateAbuseReportResult> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const reportId = generatePlatformAuditId(nowMs);
  const host = normalizeHost(input.reportedHost) ?? input.reportedHost.trim().toLowerCase();

  try {
    const res = await platformDb
      .prepare(
        `INSERT INTO abuse_reports (
           id, tenant_id, reported_host, reported_path, category, details,
           reporter_contact, status, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
      )
      .bind(
        reportId,
        input.tenantId,
        host,
        input.reportedPath,
        input.category,
        input.description,
        input.reporterEmail,
        nowMs,
        nowMs,
      )
      .run();

    if (!res.success) {
      throw new AbuseModerationError(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal menyimpan laporan penyalahgunaan. Silakan coba lagi.",
      );
    }

    return { reportId, status: "received" };
  } catch (err) {
    if (err instanceof AbuseModerationError) throw err;
    throw new AbuseModerationError(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyimpan laporan penyalahgunaan. Silakan coba lagi.",
      [],
      err,
    );
  }
}

export interface AbuseModerationActionRecord {
  readonly id: string;
  readonly reportId: string;
  readonly tenantId: string;
  readonly action: AbuseModerationAction;
  readonly reason: string;
  readonly actorUserId: string;
  readonly previousReportStatus: AbuseReportStatus;
  readonly nextReportStatus: AbuseReportStatus;
  readonly previousTenantStatus: string | null;
  readonly nextTenantStatus: string | null;
  readonly unpublishTargetPath: string | null;
  readonly tenantNotified: boolean;
  readonly notificationStatus: AbuseNotificationStatus;
  readonly idempotencyKey: string | null;
  readonly auditId: string;
  readonly createdAt: string;
  readonly createdAtMs: number;
}

export interface ConsoleAbuseReportItem {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly tenantOperatorHold: boolean;
  readonly reportedHost: string;
  readonly reportedPath: string;
  readonly category: AbuseCategory;
  readonly details: string;
  readonly hasReporterContact: boolean;
  readonly reporterContactMasked: string | null;
  readonly status: AbuseReportStatus;
  readonly resolutionNotes: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedAtMs: number | null;
  readonly latestAction: AbuseModerationAction | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly updatedAt: string;
  readonly updatedAtMs: number;
}

export interface ConsoleAbuseReportDetail extends ConsoleAbuseReportItem {
  readonly actions: readonly AbuseModerationActionRecord[];
}

export interface AbuseStatusCounts {
  readonly all: number;
  readonly open: number;
  readonly investigating: number;
  readonly resolved: number;
  readonly dismissed: number;
}

export interface ListAbuseReportsFilter {
  readonly status?: AbuseReportStatus | "all";
  readonly category?: AbuseCategory | "all";
  readonly tenantId?: string;
  readonly search?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface ListAbuseReportsResult {
  readonly items: readonly ConsoleAbuseReportItem[];
  readonly counts: AbuseStatusCounts;
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

interface RawAbuseReportRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly tenant_handle: string;
  readonly tenant_name: string;
  readonly tenant_status: string;
  readonly tenant_operator_hold: number;
  readonly reported_host: string;
  readonly reported_path: string;
  readonly category: string;
  readonly details: string;
  readonly reporter_contact: string | null;
  readonly status: AbuseReportStatus;
  readonly resolution_notes: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: number | null;
  readonly latest_action: AbuseModerationAction | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawTenantLifecycleForModeration {
  readonly id: string;
  readonly status: string;
  readonly operator_hold: number;
  readonly version: number;
  readonly paid_through: number | null;
  readonly trial_ends_at: number | null;
  readonly created_at: number;
  readonly deletion_due_at: number | null;
  readonly retention_paused_at: number | null;
  readonly offboarding_started_at: number | null;
}

interface RawModerationActionRow {
  readonly id: string;
  readonly report_id: string;
  readonly tenant_id: string;
  readonly action: AbuseModerationAction;
  readonly reason: string;
  readonly actor_user_id: string;
  readonly previous_report_status: AbuseReportStatus;
  readonly next_report_status: AbuseReportStatus;
  readonly previous_tenant_status: string | null;
  readonly next_tenant_status: string | null;
  readonly unpublish_target_path: string | null;
  readonly tenant_notified: number;
  readonly notification_status?: AbuseNotificationStatus | null;
  readonly idempotency_key?: string | null;
  readonly audit_id: string;
  readonly created_at: number;
}

/**
 * Masks reporter email so console list/detail displays contact presence without exposing raw PII.
 */
export function maskReporterContact(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const atIdx = trimmed.indexOf("@");
  if (atIdx <= 0) return "[REDACTED]";
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!domain) return "[REDACTED]";
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

function mapRawAbuseReportRow(row: RawAbuseReportRow): ConsoleAbuseReportItem {
  const category = ABUSE_CATEGORY_SET.has(row.category)
    ? (row.category as AbuseCategory)
    : "other";
  const hasContact = Boolean(row.reporter_contact && row.reporter_contact.trim().length > 0);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    tenantName: row.tenant_name,
    tenantStatus: row.tenant_status,
    tenantOperatorHold: Number(row.tenant_operator_hold ?? 0) === 1,
    reportedHost: row.reported_host,
    reportedPath: row.reported_path,
    category,
    details: row.details,
    hasReporterContact: hasContact,
    reporterContactMasked: hasContact ? maskReporterContact(row.reporter_contact) : null,
    status: row.status,
    resolutionNotes: row.resolution_notes,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolvedAtMs: row.resolved_at,
    latestAction: row.latest_action ?? null,
    version: Number(row.version ?? 1),
    createdAt: new Date(row.created_at).toISOString(),
    createdAtMs: Number(row.created_at),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedAtMs: Number(row.updated_at),
  };
}

function mapRawModerationActionRow(row: RawModerationActionRow): AbuseModerationActionRecord {
  const notified = Number(row.tenant_notified ?? 0) === 1;
  const notificationStatus: AbuseNotificationStatus =
    row.notification_status === "queued" ||
    row.notification_status === "sent" ||
    row.notification_status === "skipped" ||
    row.notification_status === "failed"
      ? row.notification_status
      : notified
        ? "queued"
        : "skipped";
  return {
    id: row.id,
    reportId: row.report_id,
    tenantId: row.tenant_id,
    action: row.action,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    previousReportStatus: row.previous_report_status,
    nextReportStatus: row.next_report_status,
    previousTenantStatus: row.previous_tenant_status,
    nextTenantStatus: row.next_tenant_status,
    unpublishTargetPath: row.unpublish_target_path,
    tenantNotified: notified,
    notificationStatus,
    idempotencyKey: row.idempotency_key ?? null,
    auditId: row.audit_id,
    createdAt: new Date(row.created_at).toISOString(),
    createdAtMs: Number(row.created_at),
  };
}

function encodeAbuseCursor(createdAtMs: number, id: string): string {
  const json = JSON.stringify({ c: createdAtMs, i: id });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeAbuseCursor(raw: string): { readonly c: number; readonly i: string } | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + "=".repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { c?: unknown; i?: unknown };
    if (
      typeof parsed.c === "number" &&
      Number.isFinite(parsed.c) &&
      typeof parsed.i === "string" &&
      parsed.i.length > 0 &&
      parsed.i.length <= 64
    ) {
      return { c: Math.trunc(parsed.c), i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const REPORT_SELECT_BASE_SQL = `
  SELECT
    ar.id,
    ar.tenant_id,
    t.handle AS tenant_handle,
    t.name AS tenant_name,
    t.status AS tenant_status,
    t.operator_hold AS tenant_operator_hold,
    ar.reported_host,
    ar.reported_path,
    ar.category,
    ar.details,
    ar.reporter_contact,
    ar.status,
    ar.resolution_notes,
    ar.resolved_by,
    ar.resolved_at,
    (
      SELECT ama.action
      FROM abuse_moderation_actions ama
      WHERE ama.report_id = ar.id
      ORDER BY ama.created_at DESC
      LIMIT 1
    ) AS latest_action,
    ar.version,
    ar.created_at,
    ar.updated_at
  FROM abuse_reports ar
  INNER JOIN tenants t ON t.id = ar.tenant_id
`;

const REPORT_SELECT_FALLBACK_SQL = `
  SELECT
    ar.id,
    ar.tenant_id,
    t.handle AS tenant_handle,
    t.name AS tenant_name,
    t.status AS tenant_status,
    t.operator_hold AS tenant_operator_hold,
    ar.reported_host,
    ar.reported_path,
    ar.category,
    ar.details,
    ar.reporter_contact,
    ar.status,
    ar.resolution_notes,
    ar.resolved_by,
    ar.resolved_at,
    NULL AS latest_action,
    ar.version,
    ar.created_at,
    ar.updated_at
  FROM abuse_reports ar
  INNER JOIN tenants t ON t.id = ar.tenant_id
`;

/**
 * Lists incoming abuse reports for the Console Moderation Queue (`console.punyasitus.com/abuse`).
 */
export async function listAbuseReports(
  platformDb: D1Database,
  filter: ListAbuseReportsFilter = {},
): Promise<ListAbuseReportsResult> {
  const status = filter.status ?? "all";
  if (status !== "all" && !ABUSE_STATUS_SET.has(status)) {
    throw new AbuseModerationError(422, "VALIDATION_ERROR", "Filter status laporan tidak valid.", [
      { field: "status", code: "INVALID_STATUS", message: "Invalid status filter." },
    ]);
  }

  const category = filter.category ?? "all";
  if (category !== "all" && !ABUSE_CATEGORY_SET.has(category)) {
    throw new AbuseModerationError(422, "VALIDATION_ERROR", "Filter kategori laporan tidak valid.", [
      { field: "category", code: "INVALID_CATEGORY", message: "Invalid category filter." },
    ]);
  }

  const rawLimit = filter.limit ?? DEFAULT_ABUSE_LIST_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_ABUSE_LIST_LIMIT) {
    throw new AbuseModerationError(
      422,
      "VALIDATION_ERROR",
      `Batas limit harus antara 1 hingga ${MAX_ABUSE_LIST_LIMIT}.`,
      [{ field: "limit", code: "INVALID_LIMIT", message: "Invalid limit." }],
    );
  }

  let parsedCursor: { readonly c: number; readonly i: string } | null = null;
  if (filter.cursor && filter.cursor.trim().length > 0) {
    parsedCursor = decodeAbuseCursor(filter.cursor.trim());
    if (!parsedCursor) {
      throw new AbuseModerationError(422, "VALIDATION_ERROR", "Parameter cursor tidak valid.", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Invalid cursor." },
      ]);
    }
  }

  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (status !== "all") {
    clauses.push("ar.status = ?");
    bindings.push(status);
  }
  if (category !== "all") {
    clauses.push("ar.category = ?");
    bindings.push(category);
  }
  if (filter.tenantId && filter.tenantId.trim().length > 0) {
    clauses.push("ar.tenant_id = ?");
    bindings.push(filter.tenantId.trim());
  }
  const searchTrimmed = filter.search?.trim() ?? "";
  if (searchTrimmed.length > 0) {
    const like = `%${escapeSqlLike(searchTrimmed.toLowerCase())}%`;
    clauses.push(
      "(LOWER(ar.reported_host) LIKE ? ESCAPE '\\' OR LOWER(ar.reported_path) LIKE ? ESCAPE '\\' OR LOWER(t.handle) LIKE ? ESCAPE '\\' OR LOWER(t.name) LIKE ? ESCAPE '\\' OR LOWER(ar.details) LIKE ? ESCAPE '\\')",
    );
    bindings.push(like, like, like, like, like);
  }
  if (parsedCursor) {
    clauses.push("(ar.created_at < ? OR (ar.created_at = ? AND ar.id < ?))");
    bindings.push(parsedCursor.c, parsedCursor.c, parsedCursor.i);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderLimitSql = `ORDER BY ar.created_at DESC, ar.id DESC LIMIT ?`;

  const queryRows = async (baseSql: string): Promise<RawAbuseReportRow[]> => {
    const res = await platformDb
      .prepare(`${baseSql} ${whereSql} ${orderLimitSql}`)
      .bind(...bindings, rawLimit + 1)
      .all<RawAbuseReportRow>();
    return res.results ?? [];
  };

  let rawRows: RawAbuseReportRow[];
  try {
    rawRows = await queryRows(REPORT_SELECT_BASE_SQL);
  } catch {
    try {
      rawRows = await queryRows(REPORT_SELECT_FALLBACK_SQL);
    } catch (err) {
      throw new AbuseModerationError(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memuat antrean laporan penyalahgunaan.",
        [],
        err,
      );
    }
  }

  const countsRes = await platformDb
    .prepare("SELECT status, COUNT(*) AS cnt FROM abuse_reports GROUP BY status")
    .all<{ readonly status: string; readonly cnt: number }>();

  let openCount = 0;
  let investigatingCount = 0;
  let resolvedCount = 0;
  let dismissedCount = 0;
  for (const row of countsRes.results ?? []) {
    const n = Number(row.cnt ?? 0);
    if (row.status === "open") openCount = n;
    else if (row.status === "investigating") investigatingCount = n;
    else if (row.status === "resolved") resolvedCount = n;
    else if (row.status === "dismissed") dismissedCount = n;
  }

  const hasMore = rawRows.length > rawLimit;
  const pageRows = hasMore ? rawRows.slice(0, rawLimit) : rawRows;
  const items = pageRows.map(mapRawAbuseReportRow);
  const last = items[items.length - 1];

  return {
    items,
    counts: {
      all: openCount + investigatingCount + resolvedCount + dismissedCount,
      open: openCount,
      investigating: investigatingCount,
      resolved: resolvedCount,
      dismissed: dismissedCount,
    },
    page: {
      limit: rawLimit,
      hasMore,
      nextCursor: hasMore && last ? encodeAbuseCursor(last.createdAtMs, last.id) : null,
    },
  };
}

/**
 * Loads a single abuse report with its append-only moderation history.
 */
export async function getAbuseReportById(
  platformDb: D1Database,
  reportId: string,
): Promise<ConsoleAbuseReportDetail | null> {
  const trimmed = reportId.trim();
  if (!trimmed || trimmed.length > 64) return null;

  let row: RawAbuseReportRow | null;
  try {
    row = await platformDb
      .prepare(`${REPORT_SELECT_BASE_SQL} WHERE ar.id = ? LIMIT 1`)
      .bind(trimmed)
      .first<RawAbuseReportRow>();
  } catch {
    row = await platformDb
      .prepare(`${REPORT_SELECT_FALLBACK_SQL} WHERE ar.id = ? LIMIT 1`)
      .bind(trimmed)
      .first<RawAbuseReportRow>();
  }
  if (!row) return null;

  let actions: AbuseModerationActionRecord[];
  try {
    const actionsRes = await platformDb
      .prepare(
        `SELECT id, report_id, tenant_id, action, reason, actor_user_id,
                previous_report_status, next_report_status, previous_tenant_status,
                next_tenant_status, unpublish_target_path, tenant_notified,
                notification_status, idempotency_key, audit_id, created_at
         FROM abuse_moderation_actions
         WHERE report_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(trimmed)
      .all<RawModerationActionRow>();
    actions = (actionsRes.results ?? []).map(mapRawModerationActionRow);
  } catch {
    try {
      const legacyRes = await platformDb
        .prepare(
          `SELECT id, report_id, tenant_id, action, reason, actor_user_id,
                  previous_report_status, next_report_status, previous_tenant_status,
                  next_tenant_status, unpublish_target_path, tenant_notified, audit_id, created_at
           FROM abuse_moderation_actions
           WHERE report_id = ?
           ORDER BY created_at DESC`,
        )
        .bind(trimmed)
        .all<RawModerationActionRow>();
      actions = (legacyRes.results ?? []).map(mapRawModerationActionRow);
    } catch {
      actions = [];
    }
  }

  return {
    ...mapRawAbuseReportRow(row),
    actions,
  };
}

export interface UnpublishTargetResult {
  readonly matched: boolean;
  readonly resourceType: "page" | "post" | "offering" | null;
  readonly resourceId: number | null;
  readonly slug: string | null;
}

interface UnpublishCompensationSnapshot {
  readonly resourceType: "page" | "post" | "offering";
  readonly resourceId: number;
  readonly previousVersion: number;
  readonly previousUpdatedAt: number;
  readonly previousPublishedJson: string | null;
  readonly activityCreatedAt: number;
}

const OFFERING_PREFIX_MAP: Readonly<Record<string, "service" | "product" | "tour" | "vehicle">> = {
  layanan: "service",
  produk: "product",
  tour: "tour",
  kendaraan: "vehicle",
};

/**
 * Safely decodes a single percent-encoded path segment (never double-decodes, never throws on bad `%`).
 */
export function safeDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    return segment.trim();
  }
}

function buildSlugCandidates(rawSegment: string): readonly string[] {
  const trimmed = rawSegment.trim();
  const decoded = safeDecodePathSegment(trimmed);
  const candidates = new Set<string>();
  if (trimmed) candidates.add(trimmed);
  if (trimmed.toLowerCase()) candidates.add(trimmed.toLowerCase());
  if (decoded) candidates.add(decoded);
  if (decoded.toLowerCase()) candidates.add(decoded.toLowerCase());
  return [...candidates];
}

/**
 * Deterministically unpublishes the published resource matching `reportedPath` inside the tenant's
 * isolated `TenantStore`, verifying actual SQLite `changes === 1` (`RETURNING id`), recording a
 * PII-free `tenant_activity_log` row with `actor_user_id = NULL` (never exposing platform operator IDs),
 * and returning a rollback snapshot in case the subsequent `PLATFORM_DB` batch fails.
 *
 * Fails closed:
 * - Throws `422 TARGET_CONTENT_NOT_FOUND` if 0 published rows matched.
 * - Throws `503 TENANT_STORE_UNAVAILABLE` on any `TenantStore` error (never swallowed).
 */
async function unpublishReportedContentInTenantStore(
  tenantDb: D1Database,
  params: {
    readonly reportedPath: string;
    readonly reason: string;
    readonly reportId: string;
    readonly nowMs: number;
  },
): Promise<{
  readonly target: UnpublishTargetResult;
  readonly compensation: UnpublishCompensationSnapshot;
}> {
  const cleanPath = params.reportedPath.trim().replace(/\/+$/, "") || "/";
  const segments = cleanPath.split("/").filter(Boolean);
  const redactedReason = redactAuditText(params.reason).slice(0, 240);

  try {
    // Case 1: Blog post `/blog/<slug>`
    if (segments.length === 2 && safeDecodePathSegment(segments[0]!).toLowerCase() === "blog") {
      const slugCandidates = buildSlugCandidates(segments[1]!);
      for (const candidate of slugCandidates) {
        const row = await tenantDb
          .prepare(
            "SELECT id, slug, published_body_json, version, updated_at FROM posts WHERE slug = ? AND status = 'published' LIMIT 1",
          )
          .bind(candidate)
          .first<{
            readonly id: number;
            readonly slug: string;
            readonly published_body_json: string | null;
            readonly version: number;
            readonly updated_at: number;
          }>();
        if (!row) continue;

        const batchRes = await tenantDb.batch([
          tenantDb
            .prepare(
              `UPDATE posts
               SET status = 'draft',
                   published_body_json = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND status = 'published' AND version = ?
               RETURNING id`,
            )
            .bind(params.nowMs, row.id, row.version),
          tenantDb
            .prepare(
              `INSERT INTO tenant_activity_log (
                 actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
               )
               SELECT NULL, 'platform_operator', 'moderation.content_unpublished', 'post', ?, ?, ?, ?
               WHERE changes() = 1`,
            )
            .bind(
              String(row.id),
              `Artikel #${row.id} dinonaktifkan oleh moderasi platform (${cleanPath})`,
              JSON.stringify({ reportId: params.reportId, path: cleanPath, reason: redactedReason }),
              params.nowMs,
            ),
        ]);

        if ((batchRes[0]?.results?.length ?? 0) === 1) {
          return {
            target: { matched: true, resourceType: "post", resourceId: row.id, slug: row.slug },
            compensation: {
              resourceType: "post",
              resourceId: row.id,
              previousVersion: row.version,
              previousUpdatedAt: row.updated_at,
              previousPublishedJson: row.published_body_json,
              activityCreatedAt: params.nowMs,
            },
          };
        }
      }
    }

    // Case 2: Offering `/(layanan|produk|tour|kendaraan)/<slug>`
    const firstSeg = segments[0] ? safeDecodePathSegment(segments[0]).toLowerCase() : "";
    if (segments.length === 2 && OFFERING_PREFIX_MAP[firstSeg]) {
      const offeringType = OFFERING_PREFIX_MAP[firstSeg]!;
      const slugCandidates = buildSlugCandidates(segments[1]!);
      for (const candidate of slugCandidates) {
        const row = await tenantDb
          .prepare(
            "SELECT id, slug, published_snapshot_json, version, updated_at FROM offerings WHERE offering_type = ? AND slug = ? AND status = 'published' LIMIT 1",
          )
          .bind(offeringType, candidate)
          .first<{
            readonly id: number;
            readonly slug: string;
            readonly published_snapshot_json: string | null;
            readonly version: number;
            readonly updated_at: number;
          }>();
        if (!row) continue;

        const batchRes = await tenantDb.batch([
          tenantDb
            .prepare(
              `UPDATE offerings
               SET status = 'draft',
                   published_snapshot_json = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND status = 'published' AND version = ?
               RETURNING id`,
            )
            .bind(params.nowMs, row.id, row.version),
          tenantDb
            .prepare(
              `INSERT INTO tenant_activity_log (
                 actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
               )
               SELECT NULL, 'platform_operator', 'moderation.content_unpublished', 'offering', ?, ?, ?, ?
               WHERE changes() = 1`,
            )
            .bind(
              String(row.id),
              `Penawaran #${row.id} dinonaktifkan oleh moderasi platform (${cleanPath})`,
              JSON.stringify({
                reportId: params.reportId,
                path: cleanPath,
                offeringType,
                reason: redactedReason,
              }),
              params.nowMs,
            ),
        ]);

        if ((batchRes[0]?.results?.length ?? 0) === 1) {
          return {
            target: {
              matched: true,
              resourceType: "offering",
              resourceId: row.id,
              slug: row.slug,
            },
            compensation: {
              resourceType: "offering",
              resourceId: row.id,
              previousVersion: row.version,
              previousUpdatedAt: row.updated_at,
              previousPublishedJson: row.published_snapshot_json,
              activityCreatedAt: params.nowMs,
            },
          };
        }
      }
    }

    // Case 3: Homepage `/` or single-segment page `/<slug>`
    if (cleanPath === "/" || segments.length === 1) {
      let pageRow: {
        readonly id: number;
        readonly slug: string;
        readonly published_sections_json: string | null;
        readonly version: number;
        readonly updated_at: number;
      } | null = null;

      if (cleanPath === "/") {
        pageRow = await tenantDb
          .prepare(
            "SELECT id, slug, published_sections_json, version, updated_at FROM pages WHERE is_homepage = 1 AND status = 'published' LIMIT 1",
          )
          .first();
      } else {
        for (const candidate of buildSlugCandidates(segments[0]!)) {
          const found = await tenantDb
            .prepare(
              "SELECT id, slug, published_sections_json, version, updated_at FROM pages WHERE slug = ? AND status = 'published' LIMIT 1",
            )
            .bind(candidate)
            .first<{
              readonly id: number;
              readonly slug: string;
              readonly published_sections_json: string | null;
              readonly version: number;
              readonly updated_at: number;
            }>();
          if (found) {
            pageRow = found;
            break;
          }
        }
      }

      if (pageRow) {
        const batchRes = await tenantDb.batch([
          tenantDb
            .prepare(
              `UPDATE pages
               SET status = 'draft',
                   published_sections_json = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND status = 'published' AND version = ?
               RETURNING id`,
            )
            .bind(params.nowMs, pageRow.id, pageRow.version),
          tenantDb
            .prepare(
              `INSERT INTO tenant_activity_log (
                 actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
               )
               SELECT NULL, 'platform_operator', 'moderation.content_unpublished', 'page', ?, ?, ?, ?
               WHERE changes() = 1`,
            )
            .bind(
              String(pageRow.id),
              `Halaman #${pageRow.id} dinonaktifkan oleh moderasi platform (${cleanPath})`,
              JSON.stringify({ reportId: params.reportId, path: cleanPath, reason: redactedReason }),
              params.nowMs,
            ),
        ]);

        if ((batchRes[0]?.results?.length ?? 0) === 1) {
          return {
            target: {
              matched: true,
              resourceType: "page",
              resourceId: pageRow.id,
              slug: pageRow.slug,
            },
            compensation: {
              resourceType: "page",
              resourceId: pageRow.id,
              previousVersion: pageRow.version,
              previousUpdatedAt: pageRow.updated_at,
              previousPublishedJson: pageRow.published_sections_json,
              activityCreatedAt: params.nowMs,
            },
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof AbuseModerationError) throw err;
    throw new AbuseModerationError(
      503,
      "TENANT_STORE_UNAVAILABLE",
      "Penyimpanan data tenant tidak dapat diakses untuk menonaktifkan konten. Laporan belum diselesaikan.",
      [],
      err,
    );
  }

  throw new AbuseModerationError(
    422,
    "TARGET_CONTENT_NOT_FOUND",
    `Tidak ditemukan halaman, artikel, atau penawaran berstatus terbit pada jalur "${cleanPath}".`,
    [
      {
        field: "action",
        code: "TARGET_CONTENT_NOT_FOUND",
        message: "No published content matched the reported path.",
      },
    ],
  );
}

async function compensateUnpublishInTenantStore(
  tenantDb: D1Database,
  snapshot: UnpublishCompensationSnapshot,
): Promise<void> {
  try {
    const restoreStmt =
      snapshot.resourceType === "post"
        ? tenantDb
            .prepare(
              `UPDATE posts
               SET status = 'published',
                   published_body_json = ?,
                   version = ?,
                   updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .bind(
              snapshot.previousPublishedJson,
              snapshot.previousVersion,
              snapshot.previousUpdatedAt,
              snapshot.resourceId,
              snapshot.previousVersion + 1,
            )
        : snapshot.resourceType === "offering"
          ? tenantDb
              .prepare(
                `UPDATE offerings
                 SET status = 'published',
                     published_snapshot_json = ?,
                     version = ?,
                     updated_at = ?
                 WHERE id = ? AND version = ?`,
              )
              .bind(
                snapshot.previousPublishedJson,
                snapshot.previousVersion,
                snapshot.previousUpdatedAt,
                snapshot.resourceId,
                snapshot.previousVersion + 1,
              )
          : tenantDb
              .prepare(
                `UPDATE pages
                 SET status = 'published',
                     published_sections_json = ?,
                     version = ?,
                     updated_at = ?
                 WHERE id = ? AND version = ?`,
              )
              .bind(
                snapshot.previousPublishedJson,
                snapshot.previousVersion,
                snapshot.previousUpdatedAt,
                snapshot.resourceId,
                snapshot.previousVersion + 1,
              );

    const deleteLogStmt = tenantDb
      .prepare(
        `DELETE FROM tenant_activity_log
         WHERE id = (
           SELECT id FROM tenant_activity_log
           WHERE action = 'moderation.content_unpublished'
             AND resource_type = ?
             AND resource_id = ?
             AND created_at = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
      )
      .bind(snapshot.resourceType, String(snapshot.resourceId), snapshot.activityCreatedAt);

    await tenantDb.batch([restoreStmt, deleteLogStmt]);
  } catch {
    // Best-effort rollback if TenantStore became unreachable during compensation
  }
}

/**
 * Builds the canonical `abuse-moderation-notice` template data (PII-free, redacted reason).
 */
export function buildAbuseModerationNoticeTemplateData(params: {
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly action: AbuseModerationAction;
  readonly reportedPath: string;
  readonly reason: string;
  readonly reportId: string;
  readonly appOrigin: string;
}): EmailTemplateDataMap["abuse-moderation-notice"] {
  const safeReason = redactAuditText(params.reason);
  const dashboardUrl = `${params.appOrigin.replace(/\/+$/, "")}/dashboard/${encodeURIComponent(params.tenantHandle)}`;
  return {
    tenantName: params.tenantName,
    action: params.action,
    reportId: params.reportId,
    reportedPath: params.reportedPath,
    reason: safeReason,
    dashboardUrl,
  };
}

/**
 * Builds a PII-free Bahasa Indonesia moderation notice email for the website owner
 * rendered through the canonical `abuse-moderation-notice` template.
 * NEVER includes reporter email, passwords, tokens, or raw visitor PII.
 */
export function buildAbuseModerationTenantNoticeEmail(params: {
  readonly tenantId?: string;
  readonly ownerEmail: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly action: AbuseModerationAction;
  readonly reportedPath: string;
  readonly reason: string;
  readonly reportId: string;
  readonly appOrigin: string;
}): EmailSendRequest {
  const templateData = buildAbuseModerationNoticeTemplateData(params);
  const rendered = renderEmailTemplate("abuse-moderation-notice", templateData);

  return {
    messageKey: `abuse-moderation:${params.reportId}:${params.action}`,
    template: "abuse-moderation-notice",
    tenantId: params.tenantId ?? null,
    to: params.ownerEmail,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
}

async function resolveTenantOwnerEmail(
  platformDb: D1Database,
  tenantId: string,
): Promise<string | null> {
  try {
    const row = await platformDb
      .prepare(
        `SELECT u.email AS email
         FROM tenants t
         INNER JOIN members m
           ON m.organization_id = t.organization_id
          AND m.role = 'owner'
         INNER JOIN users u
           ON u.id = m.user_id
         WHERE t.id = ?
         ORDER BY m.created_at ASC
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<{ readonly email: string }>();
    const email = row?.email?.trim().toLowerCase() ?? "";
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

async function findExistingIdempotentAction(
  platformDb: D1Database,
  reportId: string,
  idempotencyKey: string,
): Promise<AbuseModerationActionRecord | null> {
  try {
    const row = await platformDb
      .prepare(
        `SELECT id, report_id, tenant_id, action, reason, actor_user_id,
                previous_report_status, next_report_status, previous_tenant_status,
                next_tenant_status, unpublish_target_path, tenant_notified,
                notification_status, idempotency_key, audit_id, created_at
         FROM abuse_moderation_actions
         WHERE report_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .bind(reportId, idempotencyKey)
      .first<RawModerationActionRow>();
    return row ? mapRawModerationActionRow(row) : null;
  } catch {
    return null;
  }
}

export interface ModerationQueueSenderLike {
  send(message: unknown): Promise<unknown>;
}

export interface ModerateAbuseReportInput {
  readonly reportId: string;
  readonly action: AbuseModerationAction;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly tenantDb?: D1Database | null;
  readonly jobsQueue?: ModerationQueueSenderLike | null;
  readonly emailPort?: EmailPort | null;
  readonly appOrigin?: string;
  readonly nowMs?: number;
}

export interface ModerateAbuseReportResult {
  readonly report: ConsoleAbuseReportDetail;
  readonly action: AbuseModerationAction;
  readonly audit: PlatformAuditRecord | null;
  readonly unpublishTarget: UnpublishTargetResult | null;
  readonly tenantSuspended: boolean;
  readonly notificationSent: boolean;
  readonly notificationStatus: AbuseNotificationStatus;
  readonly notificationJobKey: string | null;
  readonly replayed: boolean;
}

async function resolveIdempotentReplayIfMatched(
  platformDb: D1Database,
  reportId: string,
  idempotencyKey: string,
  expectedAction: AbuseModerationAction,
  expectedCleanReason: string,
): Promise<ModerateAbuseReportResult | null> {
  const existingAction = await findExistingIdempotentAction(platformDb, reportId, idempotencyKey);
  if (!existingAction) return null;

  if (existingAction.action !== expectedAction || existingAction.reason !== expectedCleanReason) {
    throw new AbuseModerationError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key telah digunakan untuk tindakan moderasi dengan parameter berbeda.",
    );
  }

  const existingReport = await getAbuseReportById(platformDb, reportId);
  if (!existingReport) {
    throw new AbuseModerationError(404, "NOT_FOUND", "Laporan penyalahgunaan tidak ditemukan.");
  }

  const jobKey = existingAction.tenantNotified
    ? `abuse-moderation:${reportId}:${existingAction.action}`
    : null;
  return {
    report: existingReport,
    action: existingAction.action,
    audit: null,
    unpublishTarget: null,
    tenantSuspended: existingAction.action === "suspend",
    notificationSent:
      existingAction.notificationStatus === "sent" || existingAction.notificationStatus === "queued",
    notificationStatus: existingAction.notificationStatus,
    notificationJobKey: jobKey,
    replayed: true,
  };
}

/**
 * Executes an audited Console Moderation action (`dismiss`, `unpublish`, `suspend`)
 * against an abuse report.
 */
export async function moderateAbuseReport(
  platformDb: D1Database,
  input: ModerateAbuseReportInput,
): Promise<ModerateAbuseReportResult> {
  const reportId = input.reportId.trim();
  if (!reportId || reportId.length > 64) {
    throw new AbuseModerationError(404, "NOT_FOUND", "Laporan penyalahgunaan tidak ditemukan.");
  }

  if (!ABUSE_ACTION_SET.has(input.action)) {
    throw new AbuseModerationError(422, "VALIDATION_ERROR", "Tindakan moderasi tidak valid.", [
      {
        field: "action",
        code: "INVALID_ACTION",
        message: "Tindakan harus bernilai dismiss, unpublish, atau suspend.",
      },
    ]);
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new AbuseModerationError(
      422,
      "VALIDATION_ERROR",
      "expectedVersion wajib berupa bilangan bulat positif.",
      [{ field: "expectedVersion", code: "INVALID_VERSION", message: "Expected positive integer." }],
    );
  }

  let cleanReason: string;
  try {
    cleanReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new AbuseModerationError(422, "VALIDATION_ERROR", err.message, [
        { field: "reason", code: "INVALID_REASON", message: err.message },
      ]);
    }
    throw err;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const rawIdempotencyKey = input.idempotencyKey?.trim() || null;

  // 1. Pre-check idempotency by `(report_id, idempotency_key)` BEFORE version/status checks
  if (rawIdempotencyKey) {
    const replay = await resolveIdempotentReplayIfMatched(
      platformDb,
      reportId,
      rawIdempotencyKey,
      input.action,
      cleanReason,
    );
    if (replay) return replay;
  }

  // 2. Load current report + live tenant lifecycle/offboarding state
  const current = await getAbuseReportById(platformDb, reportId);
  if (!current) {
    throw new AbuseModerationError(404, "NOT_FOUND", "Laporan penyalahgunaan tidak ditemukan.");
  }

  if (current.version !== input.expectedVersion) {
    throw new AbuseModerationError(
      409,
      "STALE_VERSION",
      `Versi laporan berubah (diharapkan v${input.expectedVersion}, saat ini v${current.version}). Muat ulang data lalu coba lagi.`,
      [{ field: "expectedVersion", code: "STALE_VERSION", message: "Stale report version." }],
    );
  }

  if (current.status === "resolved" || current.status === "dismissed") {
    throw new AbuseModerationError(
      409,
      "ALREADY_MODERATED",
      `Laporan ini sudah selesai dimoderasi dengan status "${current.status}".`,
    );
  }

  const tenantLifecycle = await platformDb
    .prepare(
      `SELECT id, status, operator_hold, version, paid_through, trial_ends_at,
              created_at, deletion_due_at, retention_paused_at, offboarding_started_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(current.tenantId)
    .first<RawTenantLifecycleForModeration>();

  if (!tenantLifecycle) {
    throw new AbuseModerationError(404, "NOT_FOUND", "Tenant terkait laporan tidak ditemukan.");
  }

  // Finding 2: Guard terminal / offboarding states on suspend
  let nextDeletionDueAtMs: number | null = tenantLifecycle.deletion_due_at;
  let nextRetentionPausedAtMs: number | null = tenantLifecycle.retention_paused_at;
  if (input.action === "suspend") {
    if (
      NON_ELIGIBLE_SUSPEND_STATUSES.has(tenantLifecycle.status) ||
      tenantLifecycle.offboarding_started_at !== null
    ) {
      throw new AbuseModerationError(
        409,
        "TENANT_NOT_ELIGIBLE",
        `Situs dalam status "${tenantLifecycle.offboarding_started_at !== null ? "offboarding" : tenantLifecycle.status}" tidak dapat ditangguhkan oleh moderasi.`,
      );
    }
    const clock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: tenantLifecycle.paid_through,
      trialEndsAtMs: tenantLifecycle.trial_ends_at,
      createdAtMs: tenantLifecycle.created_at,
      explicitDeletionDueAtMs: tenantLifecycle.deletion_due_at,
    });
    nextDeletionDueAtMs = clock.deletionDueAtMs;
    nextRetentionPausedAtMs = tenantLifecycle.retention_paused_at ?? nowMs;
  }

  // Finding 1 & 3: For `unpublish`, require TenantStore & execute verified unpublish BEFORE finalizing PLATFORM_DB
  let unpublishTarget: UnpublishTargetResult | null = null;
  let unpublishCompensation: UnpublishCompensationSnapshot | null = null;
  if (input.action === "unpublish") {
    if (!input.tenantDb) {
      throw new AbuseModerationError(
        503,
        "TENANT_STORE_UNAVAILABLE",
        "Penyimpanan data tenant tidak tersedia untuk menonaktifkan konten.",
      );
    }
    const unpub = await unpublishReportedContentInTenantStore(input.tenantDb, {
      reportedPath: current.reportedPath,
      reason: cleanReason,
      reportId,
      nowMs,
    });
    unpublishTarget = unpub.target;
    unpublishCompensation = unpub.compensation;
  }

  // Finding 4: Resolve owner notice eligibility BEFORE atomic batch so job_ledger & notification_status are durable and truthful
  const appOrigin = input.appOrigin?.trim() || `https://app.${PLATFORM_HOSTS.marketing}`;
  let preparedNoticeEmail: EmailSendRequest | null = null;
  let preparedEmailJobPayload: {
    readonly messageKey: string;
    readonly template: "abuse-moderation-notice";
    readonly to: string;
    readonly from: typeof ALLOWED_EMAIL_SENDER;
    readonly templateData: EmailTemplateDataMap["abuse-moderation-notice"];
    readonly oneShot: true;
  } | null = null;

  if (input.jobsQueue || input.emailPort) {
    const ownerEmail = await resolveTenantOwnerEmail(platformDb, current.tenantId);
    if (ownerEmail) {
      let suppressed: boolean;
      try {
        suppressed = await isEmailSuppressed(platformDb, ownerEmail);
      } catch {
        suppressed = false;
      }
      if (!suppressed) {
        const noticeParams = {
          tenantId: current.tenantId,
          ownerEmail,
          tenantName: current.tenantName,
          tenantHandle: current.tenantHandle,
          action: input.action,
          reportedPath: current.reportedPath,
          reason: cleanReason,
          reportId,
          appOrigin,
        };
        const templateData = buildAbuseModerationNoticeTemplateData(noticeParams);
        preparedNoticeEmail = buildAbuseModerationTenantNoticeEmail(noticeParams);
        preparedEmailJobPayload = {
          messageKey: preparedNoticeEmail.messageKey,
          template: "abuse-moderation-notice",
          to: preparedNoticeEmail.to,
          from: ALLOWED_EMAIL_SENDER,
          templateData,
          oneShot: true,
        };
      }
    }
  }

  const initialNotificationStatus: AbuseNotificationStatus = preparedNoticeEmail
    ? "queued"
    : "skipped";
  const initialTenantNotifiedFlag = preparedNoticeEmail ? 1 : 0;

  const nextReportStatus: AbuseReportStatus =
    input.action === "dismiss" ? "dismissed" : "resolved";
  const nextTenantStatus =
    input.action === "suspend" ? "suspended" : tenantLifecycle.status;
  const moderationActionId = generatePlatformAuditId(nowMs);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: `abuse_report.${input.action}`,
      targetType: "abuse_report",
      targetId: reportId,
      tenantId: current.tenantId,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        category: current.category,
        reportedHost: current.reportedHost,
        reportedPath: current.reportedPath,
        moderationAction: input.action,
        previousReportStatus: current.status,
        nextReportStatus,
        previousTenantStatus: tenantLifecycle.status,
        nextTenantStatus,
        ...(unpublishTarget
          ? {
              unpublishedResourceType: unpublishTarget.resourceType,
              unpublishedResourceId: unpublishTarget.resourceId,
              unpublishedSlug: unpublishTarget.slug,
            }
          : {}),
        ...(input.action === "suspend"
          ? {
              deletionDueAtMs: nextDeletionDueAtMs,
              retentionPausedAtMs: nextRetentionPausedAtMs,
            }
          : {}),
        notificationStatus: initialNotificationStatus,
        expectedVersion: input.expectedVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const insertActionStmt = platformDb
    .prepare(
      `INSERT INTO abuse_moderation_actions (
         id, report_id, tenant_id, action, reason, actor_user_id,
         previous_report_status, next_report_status, previous_tenant_status,
         next_tenant_status, unpublish_target_path, tenant_notified,
         notification_status, idempotency_key, audit_id, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      moderationActionId,
      reportId,
      current.tenantId,
      input.action,
      cleanReason,
      input.actorUserId,
      current.status,
      nextReportStatus,
      tenantLifecycle.status,
      nextTenantStatus,
      input.action === "unpublish" ? current.reportedPath : null,
      initialTenantNotifiedFlag,
      initialNotificationStatus,
      rawIdempotencyKey,
      auditEntry.id,
      nowMs,
    );

  // Build atomic PLATFORM_DB batch
  const statements: D1PreparedStatement[] = [];
  let reportUpdateIdx: number;
  let auditStmtIdx: number;

  if (input.action === "suspend") {
    // Cross-guarded atomic tenant suspend FIRST -> gates report, audit, action, and notification outbox!
    statements.push(
      platformDb
        .prepare(
          `UPDATE tenants
           SET status = 'suspended',
               operator_hold = 1,
               operator_hold_reason = ?,
               deletion_due_at = ?,
               retention_paused_at = ?,
               cache_version = cache_version + 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status NOT IN ('provisioning', 'purging', 'purged', 'recovery')
             AND offboarding_started_at IS NULL
             AND EXISTS (
               SELECT 1 FROM abuse_reports
               WHERE id = ? AND version = ? AND status IN ('open', 'investigating')
             )`,
        )
        .bind(
          cleanReason,
          nextDeletionDueAtMs,
          nextRetentionPausedAtMs,
          nowMs,
          current.tenantId,
          tenantLifecycle.version,
          reportId,
          input.expectedVersion,
        ),
    );
    statements.push(
      platformDb
        .prepare(
          `UPDATE abuse_reports
           SET status = ?,
               resolution_notes = ?,
               resolved_by = ?,
               resolved_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status IN ('open', 'investigating')
             AND changes() = 1`,
        )
        .bind(
          nextReportStatus,
          cleanReason,
          input.actorUserId,
          nowMs,
          nowMs,
          reportId,
          input.expectedVersion,
        ),
    );
    reportUpdateIdx = 1;
    auditStmtIdx = 2;
    statements.push(auditStmt, insertActionStmt);
  } else {
    statements.push(
      platformDb
        .prepare(
          `UPDATE abuse_reports
           SET status = ?,
               resolution_notes = ?,
               resolved_by = ?,
               resolved_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND version = ?
             AND status IN ('open', 'investigating')`,
        )
        .bind(
          nextReportStatus,
          cleanReason,
          input.actorUserId,
          nowMs,
          nowMs,
          reportId,
          input.expectedVersion,
        ),
    );
    reportUpdateIdx = 0;
    auditStmtIdx = 1;
    statements.push(auditStmt, insertActionStmt);

    if (input.action === "unpublish") {
      statements.push(
        platformDb
          .prepare(
            `UPDATE tenants
             SET cache_version = cache_version + 1,
                 updated_at = ?
             WHERE id = ? AND changes() = 1`,
          )
          .bind(nowMs, current.tenantId),
      );
    }
  }

  // Durable owner notification outbox row in `job_ledger` inside the SAME atomic transaction
  // formatted in the exact `EmailQueueJobPayload` shape expected by `createEmailQueueHandler`!
  if (preparedNoticeEmail && preparedEmailJobPayload) {
    statements.push(
      platformDb
        .prepare(
          `INSERT OR IGNORE INTO job_ledger (
             idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
           )
           SELECT ?, ?, ?, 'queued', 0, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          preparedEmailJobPayload.messageKey,
          ABUSE_MODERATION_EMAIL_TOPIC,
          current.tenantId,
          JSON.stringify(preparedEmailJobPayload),
          nowMs,
          nowMs,
        ),
    );
  }

  let results: D1Result[];
  try {
    results = await platformDb.batch(statements);
  } catch (err) {
    if (unpublishCompensation && input.tenantDb) {
      await compensateUnpublishInTenantStore(input.tenantDb, unpublishCompensation);
    }
    // Finding 6: Re-check idempotency race on UNIQUE constraint or concurrent write
    if (rawIdempotencyKey) {
      const raceReplay = await resolveIdempotentReplayIfMatched(
        platformDb,
        reportId,
        rawIdempotencyKey,
        input.action,
        cleanReason,
      );
      if (raceReplay) return raceReplay;
    }
    throw new AbuseModerationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Tindakan moderasi dibatalkan karena gagal menyimpan catatan audit secara atomik.",
      [],
      err,
    );
  }

  const reportChanges = results[reportUpdateIdx]?.meta?.changes ?? 0;
  const auditChanges = results[auditStmtIdx]?.meta?.changes ?? 0;

  if (reportChanges !== 1) {
    if (unpublishCompensation && input.tenantDb) {
      await compensateUnpublishInTenantStore(input.tenantDb, unpublishCompensation);
    }
    // Finding 6: Re-query `(report_id, idempotency_key)` on concurrent race before throwing STALE_VERSION
    if (rawIdempotencyKey) {
      const raceReplay = await resolveIdempotentReplayIfMatched(
        platformDb,
        reportId,
        rawIdempotencyKey,
        input.action,
        cleanReason,
      );
      if (raceReplay) return raceReplay;
    }

    // Distinguish tenant ineligibility vs report race
    if (input.action === "suspend") {
      const latestTenant = await platformDb
        .prepare("SELECT status, version, offboarding_started_at FROM tenants WHERE id = ? LIMIT 1")
        .bind(current.tenantId)
        .first<{ readonly status: string; readonly version: number; readonly offboarding_started_at: number | null }>();
      if (
        latestTenant &&
        (NON_ELIGIBLE_SUSPEND_STATUSES.has(latestTenant.status) ||
          latestTenant.offboarding_started_at !== null)
      ) {
        throw new AbuseModerationError(
          409,
          "TENANT_NOT_ELIGIBLE",
          `Situs berpindah ke status "${latestTenant.offboarding_started_at !== null ? "offboarding" : latestTenant.status}" sehingga tidak dapat ditangguhkan.`,
        );
      }
    }

    const latest = await getAbuseReportById(platformDb, reportId);
    if (!latest) {
      throw new AbuseModerationError(404, "NOT_FOUND", "Laporan penyalahgunaan tidak ditemukan.");
    }
    if (latest.status === "resolved" || latest.status === "dismissed") {
      throw new AbuseModerationError(
        409,
        "ALREADY_MODERATED",
        `Laporan ini sudah dimoderasi dengan status "${latest.status}".`,
      );
    }
    throw new AbuseModerationError(
      409,
      "STALE_VERSION",
      "Laporan atau status situs berubah secara bersamaan oleh operasi lain. Muat ulang lalu coba lagi.",
    );
  }

  if (auditChanges !== 1) {
    if (unpublishCompensation && input.tenantDb) {
      await compensateUnpublishInTenantStore(input.tenantDb, unpublishCompensation);
    }
    throw new AbuseModerationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit moderasi tidak berhasil tersimpan.",
    );
  }

  // 4. Immediately evict in-process tenant host cache so visibility updates right away
  if (input.action === "suspend" || input.action === "unpublish") {
    evictTenantFromCache(current.tenantId);
  }

  // 5. Mirror suspend notice in TenantStore activity log WITHOUT exposing operator userId (Finding 5)
  if (input.action === "suspend" && input.tenantDb) {
    try {
      await input.tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           ) VALUES (NULL, 'platform_operator', 'moderation.site_suspended', 'moderation', ?, ?, ?, ?)`,
        )
        .bind(
          reportId,
          "Situs ditangguhkan oleh moderasi platform",
          JSON.stringify({ reportId, reason: cleanReason }),
          nowMs,
        )
        .run();
    } catch {
      // Non-blocking activity mirror on suspend (platform suspend already committed authoritatively)
    }
  }

  // 6. Dispatch durable owner notice via JOBS_QUEUE (primary) -> direct EmailPort fallback -> honest failed job_ledger status
  let notificationStatus: AbuseNotificationStatus = initialNotificationStatus;
  let notificationSent = false;
  const notificationJobKey = preparedNoticeEmail?.messageKey ?? null;

  if (preparedNoticeEmail && preparedEmailJobPayload) {
    let queueDispatched = false;
    if (input.jobsQueue) {
      try {
        await input.jobsQueue.send({
          idempotencyKey: preparedEmailJobPayload.messageKey,
          topic: ABUSE_MODERATION_EMAIL_TOPIC,
          tenantId: current.tenantId,
          payload: preparedEmailJobPayload,
          correlationId: input.requestId ?? null,
          enqueuedAt: nowMs,
        });
        queueDispatched = true;
        notificationStatus = "queued";
        notificationSent = true;
      } catch {
        queueDispatched = false;
      }
    }

    if (!queueDispatched) {
      if (input.emailPort) {
        try {
          const sendRes = await input.emailPort.send(preparedNoticeEmail);
          if (sendRes.outcome === "submitted") {
            notificationStatus = "sent";
            notificationSent = true;
            await platformDb
              .batch([
                platformDb
                  .prepare(
                    "UPDATE job_ledger SET status = 'completed', attempts = attempts + 1, updated_at = ? WHERE idempotency_key = ?",
                  )
                  .bind(nowMs, preparedEmailJobPayload.messageKey),
                platformDb
                  .prepare(
                    "UPDATE abuse_moderation_actions SET notification_status = 'sent', tenant_notified = 1 WHERE id = ? AND notification_status = 'queued'",
                  )
                  .bind(moderationActionId),
              ])
              .catch(() => undefined);
          } else {
            notificationStatus = "failed";
            notificationSent = false;
            await platformDb
              .batch([
                platformDb
                  .prepare(
                    "UPDATE job_ledger SET status = 'failed', attempts = attempts + 1, last_error_code = ?, updated_at = ? WHERE idempotency_key = ?",
                  )
                  .bind(sendRes.errorCode, nowMs, preparedEmailJobPayload.messageKey),
                platformDb
                  .prepare(
                    "UPDATE abuse_moderation_actions SET notification_status = 'failed', tenant_notified = 0 WHERE id = ? AND notification_status = 'queued'",
                  )
                  .bind(moderationActionId),
              ])
              .catch(() => undefined);
          }
        } catch {
          notificationStatus = "failed";
          notificationSent = false;
          await platformDb
            .batch([
              platformDb
                .prepare(
                  "UPDATE job_ledger SET status = 'failed', attempts = attempts + 1, last_error_code = 'E_SEND_FAILED', updated_at = ? WHERE idempotency_key = ?",
                )
                .bind(nowMs, preparedEmailJobPayload.messageKey),
              platformDb
                .prepare(
                  "UPDATE abuse_moderation_actions SET notification_status = 'failed', tenant_notified = 0 WHERE id = ? AND notification_status = 'queued'",
                )
                .bind(moderationActionId),
            ])
            .catch(() => undefined);
        }
      } else {
        // Queue send failed and no EmailPort fallback is configured -> mark job_ledger & moderation action `failed`!
        notificationStatus = "failed";
        notificationSent = false;
        await platformDb
          .batch([
            platformDb
              .prepare(
                "UPDATE job_ledger SET status = 'failed', attempts = attempts + 1, last_error_code = 'E_QUEUE_SEND_FAILED', updated_at = ? WHERE idempotency_key = ?",
              )
              .bind(nowMs, preparedEmailJobPayload.messageKey),
            platformDb
              .prepare(
                "UPDATE abuse_moderation_actions SET notification_status = 'failed', tenant_notified = 0 WHERE id = ? AND notification_status = 'queued'",
              )
              .bind(moderationActionId),
          ])
          .catch(() => undefined);
      }
    }
  }

  const updated = await getAbuseReportById(platformDb, reportId);
  if (!updated) {
    throw new AbuseModerationError(404, "NOT_FOUND", "Laporan tidak ditemukan setelah pembaruan.");
  }

  return {
    report: updated,
    action: input.action,
    audit: auditEntry,
    unpublishTarget,
    tenantSuspended: input.action === "suspend",
    notificationSent,
    notificationStatus,
    notificationJobKey,
    replayed: false,
  };
}

export function isValidAbuseReportId(value: string): boolean {
  return ULID_RE.test(value.trim());
}
