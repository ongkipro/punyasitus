import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  escapeHtml,
  sanitizeActionUrl,
  sanitizeHeaderValue,
  type EmailSendRequest,
} from "@punyasitus/core/email/index";
import {
  DEFAULT_TENANT_TIMEZONE,
  formatPreferredDateIndonesian,
  formatPreferredTimeLabelId,
  normalizeTenantTimeZone,
  parseOptionalBranchId,
  sanitizeBranchLabelForDisplay,
  validatePreferredDate,
  validatePreferredTime,
} from "@punyasitus/core/leads/index";
import {
  buildWhatsAppUrl,
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";
import type { LeadInsertInput } from "../lead-dedup/index.ts";
import { hasLeadPreferredBranchLabelColumn } from "./migrations.ts";

export {
  applyTenantLeadPreferredScheduleMigrations,
  hasLeadPreferredBranchLabelColumn,
  LEAD_PREFERRED_SCHEDULE_MIGRATION,
  TENANT_0024_LEAD_PREFERRED_SCHEDULE_SQL,
  TENANT_MIGRATIONS_WITH_LEAD_PREFERRED_SCHEDULE,
} from "./migrations.ts";

/**
 * Per-Tenant Native Lead Capture & Inbox Repository (`packages/db/src/leads/index.ts`;
 * TASK-021, REQ-031, REQ-032, REQ-038, REQ-039, REQ-060).
 *
 * Operates exclusively inside a single tenant's physically isolated `TenantStore` DO:
 * - Strict public lead validation & sanitization (name, Indonesian E.164 phone, optional email,
 *   bounded message, explicit privacy consent acknowledgement, source path & UTM attribution).
 * - PII-free owner email notification builder (type-level guarantee: zero visitor fields accepted).
 * - Forward-only status transitions (`new` -> `contacted` -> `closed`) with optimistic `version`
 *   concurrency control (`409 STALE_VERSION`) and PII-free `tenant_activity_log` audit entries.
 * - WhatsApp follow-up link generation via `@punyasitus/core/wa-dispatcher` (`TASK-010`).
 * - Formula-injection-safe CSV export (`=`, `+`, `-`, `@`, `\t`, `\r` neutralized).
 * - Per-tenant switchable `leadEmailNotificationsEnabled` preference (default ON).
 */

export const LEAD_STATUSES = ["new", "contacted", "closed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_PREFERRED_TIMES = ["pagi", "siang", "sore", "malam"] as const;
export type LeadPreferredTime = (typeof LEAD_PREFERRED_TIMES)[number];

export const LEAD_SOURCE_CATEGORIES = [
  "direct",
  "search",
  "social",
  "ai_assistant",
  "referral",
  "campaign",
] as const;
export type LeadSourceCategory = (typeof LEAD_SOURCE_CATEGORIES)[number];

export const MAX_LEAD_NAME_LENGTH = 100 as const;
export const MAX_LEAD_EMAIL_LENGTH = 254 as const;
export const MAX_LEAD_MESSAGE_LENGTH = 2000 as const;
export const MAX_LEAD_NOTES_LENGTH = 2000 as const;
export const MAX_LEAD_PATH_LENGTH = 200 as const;
export const MAX_LEAD_UTM_VALUE_LENGTH = 100 as const;
export const MAX_LEAD_SEARCH_LENGTH = 100 as const;
export const MAX_LEAD_CSV_EXPORT_ROWS = 10_000 as const;

const LEAD_STATUS_SET: ReadonlySet<string> = new Set(LEAD_STATUSES);
const LEAD_PREFERRED_TIME_SET: ReadonlySet<string> = new Set(LEAD_PREFERRED_TIMES);
const LEAD_SOURCE_CATEGORY_SET: ReadonlySet<string> = new Set(LEAD_SOURCE_CATEGORIES);

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_RELATIVE_PATH_RE = /^\/[A-Za-z0-9/_\-.~%]*$/;
const PATH_TRAVERSAL_SEGMENT_RE = /(?:^|\/)\.\.(?:\/|$)/;
const PII_IN_PATH_OR_UTM_RE =
  /(@|(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9]))/;

export const PUBLIC_LEAD_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "phone",
  "email",
  "message",
  "privacyConsent",
  "privacy_consent",
  "preferred_date",
  "preferredDate",
  "preferred_time",
  "preferredTime",
  "branch",
  "branch_id",
  "branchId",
  "sourcePath",
  "pagePath",
  "sourceCategory",
  "source_category",
  "utm",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "formSlug",
  "customFields",
  "idempotencyKey",
  "idempotency_key",
  "returnTo",
]);

export interface LeadValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class LeadValidationError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly status = 422 as const;
  readonly fields: readonly LeadValidationField[];

  constructor(message: string, fields: readonly LeadValidationField[]) {
    super(message);
    this.name = "LeadValidationError";
    this.fields = fields;
  }
}

export class LeadNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  readonly status = 404 as const;

  constructor(leadId: number) {
    super(`Pesan masuk #${leadId} tidak ditemukan.`);
    this.name = "LeadNotFoundError";
  }
}

export class LeadStaleVersionError extends Error {
  readonly code = "STALE_VERSION" as const;
  readonly status = 409 as const;
  readonly currentVersion: number;

  constructor(leadId: number, expectedVersion: number, currentVersion: number) {
    super(
      `Versi pesan masuk #${leadId} sudah berubah (diharapkan ${expectedVersion}, saat ini ${currentVersion}). Muat ulang data terbaru sebelum menyimpan.`,
    );
    this.name = "LeadStaleVersionError";
    this.currentVersion = currentVersion;
  }
}

export class LeadStorageError extends Error {
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly status = 503 as const;

  constructor(message = "Penyimpanan data pesan masuk sementara tidak tersedia.") {
    super(message);
    this.name = "LeadStorageError";
  }
}

export interface LeadUtmAttribution {
  readonly utm_source?: string;
  readonly utm_medium?: string;
  readonly utm_campaign?: string;
  readonly utm_term?: string;
  readonly utm_content?: string;
}

export interface ValidatedPublicLeadSubmission {
  readonly lead: LeadInsertInput;
  readonly idempotencyKey: string | null;
  readonly returnTo: string | null;
  readonly canonicalPayload: Record<string, unknown>;
}

export interface LeadRecord {
  readonly id: number;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly message: string;
  readonly status: LeadStatus;
  readonly preferredDate: string | null;
  readonly preferredTime: LeadPreferredTime | null;
  readonly branchId: number | null;
  readonly preferredBranchLabel?: string | null;
  readonly sourceCategory: string;
  readonly utm: LeadUtmAttribution | null;
  readonly pagePath: string | null;
  readonly internalNotes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface LeadStatusCounts {
  readonly all: number;
  readonly new: number;
  readonly contacted: number;
  readonly closed: number;
}

export interface ListLeadsInput {
  readonly status?: LeadStatus | "all";
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListLeadsResult {
  readonly items: readonly LeadRecord[];
  readonly counts: LeadStatusCounts;
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export interface UpdateLeadInput {
  readonly leadId: number;
  readonly status: LeadStatus;
  readonly internalNotes?: string | null;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

export interface LeadNotificationSettings {
  readonly emailEnabled: boolean;
  readonly updatedAtMs: number | null;
}

interface RawLeadRow {
  readonly id: number;
  readonly name: string;
  readonly phone_e164: string;
  readonly email: string | null;
  readonly message: string;
  readonly preferred_date: string | null;
  readonly preferred_time: string | null;
  readonly branch_id: number | null;
  readonly preferred_branch_label?: string | null;
  readonly source_category: string;
  readonly utm_json: string | null;
  readonly page_path: string | null;
  readonly status: string;
  readonly internal_notes: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function hasDisallowedControlChars(value: string, allowMultiline: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
    if (code <= 0x1f) {
      if (allowMultiline && (code === 0x09 || code === 0x0a || code === 0x0d)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [yStr, mStr, dStr] = value.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function parsePrivacyConsent(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    return normalized === "true" || normalized === "on" || normalized === "1" || normalized === "yes";
  }
  return false;
}

/**
 * Strictly validates and sanitizes an optional relative path for PRG `303` redirects and HTML links.
 * Enforces an allowlist (`^/[A-Za-z0-9/_\-.~%]*$`, max 256 chars, no `//`, no `..`, no quotes/angle brackets,
 * valid percent-encoding with no decoded HTML/control characters, and zero PII).
 */
export function sanitizeSafeRelativePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 256) return null;
  if (hasDisallowedControlChars(trimmed, false)) return null;
  const withoutHash = trimmed.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  if (
    !withoutQuery ||
    withoutQuery.length > 256 ||
    !withoutQuery.startsWith("/") ||
    withoutQuery.startsWith("//") ||
    !SAFE_RELATIVE_PATH_RE.test(withoutQuery) ||
    PATH_TRAVERSAL_SEGMENT_RE.test(withoutQuery)
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (
    hasDisallowedControlChars(decoded, false) ||
    /["'<>\\]/.test(decoded) ||
    PATH_TRAVERSAL_SEGMENT_RE.test(decoded) ||
    PII_IN_PATH_OR_UTM_RE.test(withoutQuery) ||
    PII_IN_PATH_OR_UTM_RE.test(decoded)
  ) {
    return null;
  }
  return withoutQuery;
}

function parseOptionalUtm(
  rawPayload: Readonly<Record<string, unknown>>,
  fields: LeadValidationField[],
): LeadUtmAttribution | null {
  const utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
  const sourceObj: Record<string, unknown> = {};

  if (rawPayload.utm !== undefined && rawPayload.utm !== null) {
    if (typeof rawPayload.utm !== "object" || Array.isArray(rawPayload.utm)) {
      fields.push({
        field: "utm",
        code: "INVALID_UTM",
        message: "Atribusi UTM harus berupa objek.",
      });
      return null;
    }
    const nested = rawPayload.utm as Record<string, unknown>;
    for (const [k, v] of Object.entries(nested)) {
      if (!(utmKeys as readonly string[]).includes(k)) {
        fields.push({
          field: `utm.${k}`,
          code: "UNKNOWN_FIELD",
          message: `Parameter UTM "${k}" tidak dikenal.`,
        });
      } else {
        sourceObj[k] = v;
      }
    }
  }

  for (const key of utmKeys) {
    if (rawPayload[key] !== undefined && rawPayload[key] !== null) {
      sourceObj[key] = rawPayload[key];
    }
  }

  const out: Record<string, string> = {};
  for (const key of utmKeys) {
    const raw = sourceObj[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      fields.push({
        field: key,
        code: "INVALID_UTM",
        message: `Nilai ${key} harus berupa teks.`,
      });
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_LEAD_UTM_VALUE_LENGTH || hasDisallowedControlChars(trimmed, false)) {
      fields.push({
        field: key,
        code: "INVALID_UTM",
        message: `Nilai ${key} maksimal ${MAX_LEAD_UTM_VALUE_LENGTH} karakter tanpa karakter kontrol.`,
      });
      continue;
    }
    if (PII_IN_PATH_OR_UTM_RE.test(trimmed)) {
      fields.push({
        field: key,
        code: "PII_NOT_ALLOWED",
        message: `Parameter ${key} tidak boleh berisi data pribadi.`,
      });
      continue;
    }
    out[key] = trimmed;
  }

  return Object.keys(out).length > 0 ? (out as LeadUtmAttribution) : null;
}

/**
 * Strictly validates and normalizes a public visitor lead submission (both JSON and
 * no-JS `application/x-www-form-urlencoded` form POST payloads).
 */
export function validatePublicLeadSubmission(
  rawPayload: Readonly<Record<string, unknown>>,
  options: {
    readonly requirePrivacyConsent?: boolean;
    readonly nowMs?: number;
    readonly timeZone?: string | null;
    readonly enforceDateBounds?: boolean;
  } = {},
):
  | { readonly ok: true; readonly data: ValidatedPublicLeadSubmission }
  | { readonly ok: false; readonly message: string; readonly fields: readonly LeadValidationField[] } {
  const fields: LeadValidationField[] = [];

  for (const key of Object.keys(rawPayload)) {
    if (!PUBLIC_LEAD_ALLOWED_KEYS.has(key)) {
      fields.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field "${key}" tidak diizinkan pada formulir kontak.`,
      });
    }
  }

  // 1. Name (required, 1..100 chars, single-line)
  let name = "";
  if (typeof rawPayload.name !== "string") {
    fields.push({
      field: "name",
      code: "REQUIRED",
      message: "Nama lengkap wajib diisi.",
    });
  } else if (hasDisallowedControlChars(rawPayload.name, false)) {
    fields.push({
      field: "name",
      code: "CONTROL_CHARACTERS",
      message: "Nama tidak boleh mengandung karakter kontrol atau baris baru.",
    });
  } else {
    const trimmed = rawPayload.name.trim();
    if (trimmed.length === 0) {
      fields.push({
        field: "name",
        code: "REQUIRED",
        message: "Nama lengkap wajib diisi.",
      });
    } else if (trimmed.length > MAX_LEAD_NAME_LENGTH) {
      fields.push({
        field: "name",
        code: "TOO_LONG",
        message: `Nama maksimal ${MAX_LEAD_NAME_LENGTH} karakter.`,
      });
    } else {
      name = trimmed;
    }
  }

  // 2. Phone / WhatsApp (required, normalized Indonesian E.164 `628...`)
  let phoneE164 = "";
  if (typeof rawPayload.phone !== "string" || rawPayload.phone.trim().length === 0) {
    fields.push({
      field: "phone",
      code: "REQUIRED",
      message: "Nomor WhatsApp atau telepon wajib diisi.",
    });
  } else {
    try {
      phoneE164 = normalizeIndonesianWhatsAppNumber(rawPayload.phone);
    } catch (err) {
      fields.push({
        field: "phone",
        code: "INVALID_PHONE",
        message:
          err instanceof WhatsAppValidationError
            ? "Nomor WhatsApp harus berupa nomor seluler Indonesia yang valid (contoh: 081234567890 atau +6281234567890)."
            : "Format nomor WhatsApp tidak valid.",
      });
    }
  }

  // 3. Email (optional, valid format, max 254 chars)
  let email: string | null = null;
  if (rawPayload.email !== undefined && rawPayload.email !== null) {
    if (typeof rawPayload.email !== "string") {
      fields.push({
        field: "email",
        code: "INVALID_EMAIL",
        message: "Format email tidak valid.",
      });
    } else {
      const trimmedEmail = rawPayload.email.trim().toLowerCase();
      if (trimmedEmail.length > 0) {
        if (
          trimmedEmail.length > MAX_LEAD_EMAIL_LENGTH ||
          hasDisallowedControlChars(trimmedEmail, false) ||
          !SIMPLE_EMAIL_RE.test(trimmedEmail)
        ) {
          fields.push({
            field: "email",
            code: "INVALID_EMAIL",
            message: "Alamat email tidak valid.",
          });
        } else {
          email = trimmedEmail;
        }
      }
    }
  }

  // 4. Message (required, 1..2000 chars, multiline allowed)
  let message = "";
  if (typeof rawPayload.message !== "string") {
    fields.push({
      field: "message",
      code: "REQUIRED",
      message: "Pesan wajib diisi.",
    });
  } else if (hasDisallowedControlChars(rawPayload.message, true)) {
    fields.push({
      field: "message",
      code: "CONTROL_CHARACTERS",
      message: "Pesan mengandung karakter yang tidak diizinkan.",
    });
  } else {
    const trimmed = rawPayload.message.trim();
    if (trimmed.length === 0) {
      fields.push({
        field: "message",
        code: "REQUIRED",
        message: "Pesan wajib diisi.",
      });
    } else if (trimmed.length > MAX_LEAD_MESSAGE_LENGTH) {
      fields.push({
        field: "message",
        code: "TOO_LONG",
        message: `Pesan maksimal ${MAX_LEAD_MESSAGE_LENGTH} karakter.`,
      });
    } else {
      message = trimmed;
    }
  }

  // 5. Explicit Privacy Consent acknowledgement (REQ-031 / REQ-039)
  const requireConsent = options.requirePrivacyConsent ?? true;
  const rawConsent =
    rawPayload.privacyConsent !== undefined
      ? rawPayload.privacyConsent
      : rawPayload.privacy_consent;
  if (requireConsent && !parsePrivacyConsent(rawConsent)) {
    fields.push({
      field: "privacyConsent",
      code: "PRIVACY_CONSENT_REQUIRED",
      message: "Anda harus menyetujui pemrosesan data kontak sebelum mengirim pesan.",
    });
  }

  // 6. Optional preferred_date & preferred_time (REQ-072, PLAN §6 & §18.4)
  const hasSnakeDate =
    rawPayload.preferred_date !== undefined &&
    rawPayload.preferred_date !== null &&
    rawPayload.preferred_date !== "";
  const hasCamelDate =
    rawPayload.preferredDate !== undefined &&
    rawPayload.preferredDate !== null &&
    rawPayload.preferredDate !== "";
  const rawPreferredDate = hasSnakeDate ? rawPayload.preferred_date : rawPayload.preferredDate;
  let preferredDate: string | null = null;
  if (
    hasSnakeDate &&
    hasCamelDate &&
    String(rawPayload.preferred_date).trim() !== String(rawPayload.preferredDate).trim()
  ) {
    fields.push({
      field: "preferred_date",
      code: "INVALID_DATE",
      message: "Nilai preferred_date dan preferredDate tidak konsisten.",
    });
  } else if (rawPreferredDate !== undefined && rawPreferredDate !== null && rawPreferredDate !== "") {
    if (options.enforceDateBounds === false) {
      if (typeof rawPreferredDate !== "string" || !isValidIsoCalendarDate(rawPreferredDate.trim())) {
        fields.push({
          field: "preferred_date",
          code: "INVALID_DATE",
          message: "Tanggal permintaan jadwal harus menggunakan format YYYY-MM-DD yang valid.",
        });
      } else {
        preferredDate = rawPreferredDate.trim();
      }
    } else {
      const dateCheck = validatePreferredDate(rawPreferredDate, {
        nowMs: options.nowMs,
        timeZone: options.timeZone,
      });
      if (!dateCheck.ok) {
        fields.push({
          field: "preferred_date",
          code: dateCheck.code,
          message: dateCheck.message,
        });
      } else {
        preferredDate = dateCheck.value;
      }
    }
  }

  const hasSnakeTime =
    rawPayload.preferred_time !== undefined &&
    rawPayload.preferred_time !== null &&
    rawPayload.preferred_time !== "";
  const hasCamelTime =
    rawPayload.preferredTime !== undefined &&
    rawPayload.preferredTime !== null &&
    rawPayload.preferredTime !== "";
  const rawPreferredTime = hasSnakeTime ? rawPayload.preferred_time : rawPayload.preferredTime;
  let preferredTime: LeadPreferredTime | null = null;
  if (
    hasSnakeTime &&
    hasCamelTime &&
    String(rawPayload.preferred_time).trim().toLowerCase() !==
      String(rawPayload.preferredTime).trim().toLowerCase()
  ) {
    fields.push({
      field: "preferred_time",
      code: "INVALID_PREFERRED_TIME",
      message: "Nilai preferred_time dan preferredTime tidak konsisten.",
    });
  } else if (rawPreferredTime !== undefined && rawPreferredTime !== null && rawPreferredTime !== "") {
    const timeCheck = validatePreferredTime(rawPreferredTime);
    if (!timeCheck.ok) {
      fields.push({
        field: "preferred_time",
        code: timeCheck.code,
        message: timeCheck.message,
      });
    } else {
      preferredTime = timeCheck.value;
    }
  }

  // 7. Optional branch ID (`branch_id`, `branch`, or `branchId`)
  const branchCandidates = [
    rawPayload.branch_id,
    rawPayload.branch,
    rawPayload.branchId,
  ].filter((v) => v !== undefined && v !== null && v !== "");
  let branchId: number | null = null;
  if (branchCandidates.length > 0) {
    const parsedBranchValues: number[] = [];
    let branchInvalid = false;
    for (const candidate of branchCandidates) {
      const parsed = parseOptionalBranchId(candidate);
      if (!parsed.ok || parsed.value === null) {
        branchInvalid = true;
        break;
      }
      parsedBranchValues.push(parsed.value);
    }
    if (
      branchInvalid ||
      parsedBranchValues.some((val) => val !== parsedBranchValues[0])
    ) {
      fields.push({
        field: "branch_id",
        code: "INVALID_BRANCH",
        message: "ID cabang tidak valid.",
      });
    } else {
      branchId = parsedBranchValues[0] ?? null;
    }
  }

  // 8. Optional sourcePath / pagePath (strict relative path allowlist, no query/hash/quotes/PII)
  const rawPath = rawPayload.sourcePath !== undefined ? rawPayload.sourcePath : rawPayload.pagePath;
  let pagePath: string | null = null;
  if (rawPath !== undefined && rawPath !== null && rawPath !== "") {
    if (typeof rawPath !== "string") {
      fields.push({
        field: "sourcePath",
        code: "INVALID_PATH",
        message: "Path halaman asal tidak valid.",
      });
    } else {
      const trimmedPath = rawPath.trim();
      const sanitized =
        !trimmedPath.includes("?") &&
        !trimmedPath.includes("#") &&
        trimmedPath.length <= MAX_LEAD_PATH_LENGTH
          ? sanitizeSafeRelativePath(trimmedPath)
          : null;
      if (!sanitized) {
        fields.push({
          field: "sourcePath",
          code: "INVALID_PATH",
          message: "Path halaman asal harus berupa path relatif bersih tanpa query string.",
        });
      } else {
        pagePath = sanitized;
      }
    }
  }

  // 9. Optional UTM & sourceCategory
  const utm = parseOptionalUtm(rawPayload, fields);
  const rawSourceCat =
    rawPayload.sourceCategory !== undefined
      ? rawPayload.sourceCategory
      : rawPayload.source_category;
  let sourceCategory: LeadSourceCategory = utm ? "campaign" : "direct";
  if (rawSourceCat !== undefined && rawSourceCat !== null && rawSourceCat !== "") {
    const normalizedCat =
      typeof rawSourceCat === "string" ? rawSourceCat.trim().toLowerCase() : "";
    if (!LEAD_SOURCE_CATEGORY_SET.has(normalizedCat)) {
      fields.push({
        field: "sourceCategory",
        code: "INVALID_SOURCE_CATEGORY",
        message: "Kategori sumber kunjungan tidak valid.",
      });
    } else {
      sourceCategory = normalizedCat as LeadSourceCategory;
    }
  }

  // 10. Optional body idempotencyKey (for no-JS HTML forms) & returnTo
  const rawIdem =
    rawPayload.idempotencyKey !== undefined
      ? rawPayload.idempotencyKey
      : rawPayload.idempotency_key;
  let idempotencyKey: string | null = null;
  if (rawIdem !== undefined && rawIdem !== null && rawIdem !== "") {
    if (typeof rawIdem !== "string" || rawIdem.trim().length > 128) {
      fields.push({
        field: "idempotencyKey",
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency key tidak valid.",
      });
    } else {
      idempotencyKey = rawIdem.trim();
    }
  }

  const returnTo = sanitizeSafeRelativePath(rawPayload.returnTo);

  if (fields.length > 0) {
    return {
      ok: false,
      message: "Mohon periksa kembali isian formulir Anda.",
      fields,
    };
  }

  const utmJson = utm ? JSON.stringify(utm) : null;
  const lead: LeadInsertInput = {
    name,
    phoneE164,
    email,
    message,
    preferredDate,
    preferredTime,
    branchId,
    sourceCategory,
    utmJson,
    pagePath,
  };

  const canonicalPayload: Record<string, unknown> = {
    name,
    phoneE164,
    email,
    message,
    preferredDate,
    preferredTime,
    branchId,
    sourceCategory,
    utm,
    pagePath,
  };

  return {
    ok: true,
    data: {
      lead,
      idempotencyKey,
      returnTo,
      canonicalPayload,
    },
  };
}

/**
 * Forward-only lead status transition check (`new` -> `contacted` -> `closed`).
 * Allows same-status updates so owners/admins can save `internalNotes` without changing status.
 */
export function isValidLeadStatusTransition(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return true;
  if (from === "new") return to === "contacted" || to === "closed";
  if (from === "contacted") return to === "closed";
  return false;
}

/**
 * Builds a validated `https://wa.me/<digits>?text=<encoded>` follow-up URL for an inbox lead
 * using `@punyasitus/core/wa-dispatcher` (`TASK-010`). Returns `null` if the stored phone cannot
 * be normalized as an Indonesian WhatsApp mobile number.
 */
export function buildLeadWhatsAppFollowUpUrl(params: {
  readonly phone: string;
  readonly leadName: string;
  readonly primaryOrigin: string;
  readonly pagePath?: string | null;
  readonly preferredDate?: string | null;
  readonly preferredTime?: string | null;
  readonly branchLabel?: string | null;
}): string | null {
  try {
    const safeOrigin = params.primaryOrigin.trim().startsWith("https://")
      ? params.primaryOrigin.trim().replace(/\/+$/, "")
      : `https://${params.primaryOrigin.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
    const safePath = sanitizeSafeRelativePath(params.pagePath) ?? "/";
    const cleanName = params.leadName.replace(/[\r\n\0]+/g, " ").trim() || "Bapak/Ibu";
    const formattedDate = params.preferredDate
      ? formatPreferredDateIndonesian(params.preferredDate)
      : null;
    const formattedTime = formatPreferredTimeLabelId(params.preferredTime);
    const cleanBranch = sanitizeBranchLabelForDisplay(params.branchLabel);
    const hasSchedule = Boolean(formattedDate || formattedTime || cleanBranch);

    const template = hasSchedule
      ? "Halo {{item_title}}, terima kasih telah menghubungi kami melalui {{page_url}}.\nPermintaan jadwal tanggal: {{preferred_date}}.\nWaktu pilihan: {{preferred_time}}.\nCabang tujuan: {{branch}}.\nAda yang bisa kami bantu?"
      : "Halo {{item_title}}, terima kasih telah menghubungi kami melalui {{page_url}}. Ada yang bisa kami bantu?";

    const result = buildWhatsAppUrl({
      tenantPhone: params.phone,
      template,
      itemTitle: cleanName,
      primaryOrigin: safeOrigin,
      canonicalPath: safePath,
      preferredDate: formattedDate,
      preferredTime: formattedTime,
      branch: cleanBranch,
    });
    return result.url;
  } catch {
    return null;
  }
}

export interface NewLeadOwnerNotificationEmailParams {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly leadId: number;
  readonly ownerEmail: string;
  readonly appOrigin: string;
}

/**
 * Builds a strictly PII-free Bahasa Indonesia owner notification email (`REQ-031`, `REQ-039`).
 *
 * Type-level privacy invariant: this function NEVER accepts visitor name, phone, email,
 * message body, IP, or UTM parameters, guaranteeing zero visitor PII in subject, HTML, or text.
 */
export function buildNewLeadOwnerNotificationEmail(
  params: NewLeadOwnerNotificationEmailParams,
): EmailSendRequest {
  const safeTenantName = sanitizeHeaderValue(params.tenantName) || params.tenantHandle;
  const safeHandle = params.tenantHandle.trim().toLowerCase();
  const baseOrigin = params.appOrigin.trim().replace(/\/+$/, "");
  const inboxUrl = sanitizeActionUrl(`${baseOrigin}/dashboard/${encodeURIComponent(safeHandle)}/leads`);

  const subject = sanitizeHeaderValue(`Ada pesan masuk baru — ${safeTenantName}`);
  const preheader = `Pesan masuk baru diterima di situs ${safeTenantName}. Buka kotak masuk untuk menindaklanjuti.`;

  const html = [
    "<!doctype html>",
    '<html lang="id">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;padding:24px 12px;">',
    "<tr>",
    '<td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">',
    '<tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;background-color:#0f172a;color:#ffffff;font-size:16px;font-weight:700;">PunyaSitus</td></tr>',
    '<tr><td style="padding:24px;font-size:15px;line-height:1.6;color:#0f172a;">',
    "<p>Halo,</p>",
    `<p><strong>Ada pesan masuk baru</strong> di situs <strong>${escapeHtml(safeTenantName)}</strong>.</p>`,
    "<p>Demi menjaga privasi data pengunjung, isi pesan dan kontak tidak disertakan di dalam email ini. Silakan buka kotak masuk PunyaSitus untuk melihat rincian dan menindaklanjuti melalui WhatsApp.</p>",
    `<p style="margin:20px 0;"><a href="${escapeHtml(inboxUrl)}" style="display:inline-block;padding:12px 20px;background-color:#176b51;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Buka Kotak Masuk</a></p>`,
    `<p style="font-size:13px;color:#475569;word-break:break-all;">Atau salin tautan ini: ${escapeHtml(inboxUrl)}</p>`,
    '<p style="font-size:13px;color:#64748b;">Anda dapat mematikan notifikasi email pesan masuk kapan saja melalui halaman Pesan Masuk di dashboard.</p>',
    "</td></tr>",
    '<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;background-color:#f8fafc;font-size:12px;line-height:1.5;color:#64748b;">',
    "Email ini dikirim secara otomatis oleh sistem notifikasi PunyaSitus (noreply@notif.punyasitus.com). Mohon jangan membalas email ini.",
    "</td></tr>",
    "</table>",
    "</td>",
    "</tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("");

  const text = [
    "Halo,",
    "",
    `Ada pesan masuk baru di situs ${safeTenantName}.`,
    "",
    "Demi menjaga privasi data pengunjung, isi pesan dan kontak tidak disertakan di dalam email ini.",
    `Buka kotak masuk PunyaSitus untuk melihat rincian dan menindaklanjuti: ${inboxUrl}`,
    "",
    "Anda dapat mematikan notifikasi email pesan masuk kapan saja melalui halaman Pesan Masuk di dashboard.",
    "",
    "--",
    "PunyaSitus (noreply@notif.punyasitus.com)",
  ].join("\n");

  return {
    messageKey: `new-lead:${params.tenantId}:${params.leadId}`,
    template: "lifecycle-notice",
    from: ALLOWED_EMAIL_SENDER,
    fromName: DEFAULT_EMAIL_SENDER_NAME,
    to: params.ownerEmail,
    subject,
    html,
    text,
    headers: {
      "X-PunyaSitus-Notification": "new-lead",
    },
    oneShot: true,
    tenantId: params.tenantId,
  };
}

const CSV_FORMULA_PREFIX_RE = /^[\t\r ]*[=+\-@\t\r]/;

/**
 * Escapes a single CSV cell per RFC 4180 while neutralizing spreadsheet formula injection
 * (`=`, `+`, `-`, `@`, tab, CR — even with leading spaces) by prefixing with `'`.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (str.length > 0 && CSV_FORMULA_PREFIX_RE.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const LEADS_CSV_HEADERS = [
  "id",
  "created_at",
  "status",
  "name",
  "phone",
  "email",
  "message",
  "preferred_date",
  "preferred_time",
  "branch_id",
  "source_category",
  "page_path",
  "internal_notes",
  "updated_at",
] as const;

/**
 * Serializes lead records into a formula-injection-safe RFC 4180 CSV document.
 */
export function serializeLeadsToCsv(leads: readonly LeadRecord[]): string {
  const lines: string[] = [LEADS_CSV_HEADERS.join(",")];
  for (const lead of leads) {
    lines.push(
      [
        escapeCsvCell(lead.id),
        escapeCsvCell(lead.createdAt),
        escapeCsvCell(lead.status),
        escapeCsvCell(lead.name),
        escapeCsvCell(lead.phone),
        escapeCsvCell(lead.email ?? ""),
        escapeCsvCell(lead.message),
        escapeCsvCell(lead.preferredDate ?? ""),
        escapeCsvCell(lead.preferredTime ?? ""),
        escapeCsvCell(lead.branchId ?? ""),
        escapeCsvCell(lead.sourceCategory),
        escapeCsvCell(lead.pagePath ?? ""),
        escapeCsvCell(lead.internalNotes ?? ""),
        escapeCsvCell(lead.updatedAt),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Cursor Helpers & Row Mapping
// ---------------------------------------------------------------------------

interface LeadCursorPayload {
  readonly c: number;
  readonly i: number;
}

function encodeCursor(createdAtMs: number, id: number): string {
  const json = JSON.stringify({ c: createdAtMs, i: id });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): LeadCursorPayload | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + "=".repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LeadCursorPayload>;
    if (
      typeof parsed.c === "number" &&
      Number.isSafeInteger(parsed.c) &&
      typeof parsed.i === "number" &&
      Number.isSafeInteger(parsed.i) &&
      parsed.i >= 1
    ) {
      return { c: parsed.c, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

function safeParseUtmJson(raw: string | null): LeadUtmAttribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LeadUtmAttribution;
    }
    return null;
  } catch {
    return null;
  }
}

function mapRawLeadRow(row: RawLeadRow): LeadRecord {
  const status: LeadStatus = LEAD_STATUS_SET.has(row.status)
    ? (row.status as LeadStatus)
    : "new";
  const preferredTime: LeadPreferredTime | null =
    row.preferred_time && LEAD_PREFERRED_TIME_SET.has(row.preferred_time)
      ? (row.preferred_time as LeadPreferredTime)
      : null;
  const createdAtMs = Number(row.created_at);
  const updatedAtMs = Number(row.updated_at);

  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone_e164,
    email: row.email ?? null,
    message: row.message,
    status,
    preferredDate: row.preferred_date ?? null,
    preferredTime,
    branchId: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
    preferredBranchLabel: sanitizeBranchLabelForDisplay(row.preferred_branch_label ?? null),
    sourceCategory: row.source_category || "direct",
    utm: safeParseUtmJson(row.utm_json),
    pagePath: row.page_path ?? null,
    internalNotes: row.internal_notes ?? null,
    version: Number(row.version),
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    createdAtMs,
    updatedAtMs,
  };
}

function isMissingLeadColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no such column/i.test(msg);
}

function isMissingLeadTableOrColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no such table|no such column/i.test(msg);
}

/**
 * Reads the tenant's configured IANA timezone from `site_settings` (`0001_initial_tenant.sql`),
 * defaulting to `Asia/Jakarta` when no row exists. Rethrows genuine transient storage outages.
 */
export async function resolveTenantTimeZoneForLead(tenantDb: D1Database): Promise<string> {
  try {
    const row = await tenantDb
      .prepare("SELECT timezone FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly timezone: string | null }>();
    return normalizeTenantTimeZone(row?.timezone ?? DEFAULT_TENANT_TIMEZONE);
  } catch (err) {
    if (isMissingLeadTableOrColumnError(err)) {
      return DEFAULT_TENANT_TIMEZONE;
    }
    throw new LeadStorageError();
  }
}

export interface ActiveLeadBranchInfo {
  readonly id: number;
  readonly name: string;
}

/**
 * Verifies that `branchId` exists in THIS tenant's `TenantStore.branches` table and is BOTH
 * active (`active = 1`) AND published (not `status: "draft"` or `active: false` in metadata).
 * Returns `null` for missing, inactive, or draft outlets; throws `LeadStorageError` on DB outage.
 */
export async function resolveActivePublishedBranchForLead(
  tenantDb: D1Database,
  branchId: number,
): Promise<ActiveLeadBranchInfo | null> {
  if (!Number.isSafeInteger(branchId) || branchId < 1) {
    return null;
  }
  try {
    const row = await tenantDb
      .prepare(
        `SELECT id, name, active, weekday_hours_json
         FROM branches
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(branchId)
      .first<{
        readonly id: number;
        readonly name: string;
        readonly active: number;
        readonly weekday_hours_json: string | null;
      }>();

    if (!row || Number(row.active) !== 1) {
      return null;
    }

    if (row.weekday_hours_json) {
      try {
        const parsed = JSON.parse(row.weekday_hours_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (obj.status === "draft" || obj.active === false) {
            return null;
          }
        }
      } catch {
        // Legacy plain-text weekday_hours_json string -> treat as published when SQL active = 1
      }
    }

    const label = sanitizeBranchLabelForDisplay(row.name) ?? `Cabang #${Number(row.id)}`;
    return {
      id: Number(row.id),
      name: label,
    };
  } catch (err) {
    if (isMissingLeadTableOrColumnError(err)) {
      return null;
    }
    throw new LeadStorageError();
  }
}

/**
 * Persists the branch name snapshot onto `leads.preferred_branch_label` (additive migration 0024).
 * Returns silently ONLY on pre-0024 tenant DBs lacking `preferred_branch_label`.
 * On 0024-migrated DBs, retries once on genuine transient DO/SQL errors and rethrows `LeadStorageError`
 * so real storage failures are never silently swallowed.
 */
export async function persistLeadPreferredBranchLabel(
  tenantDb: D1Database,
  leadId: number,
  branchLabel: string | null | undefined,
): Promise<void> {
  const cleanLabel = sanitizeBranchLabelForDisplay(branchLabel);
  if (!cleanLabel || !Number.isSafeInteger(leadId) || leadId < 1) {
    return;
  }
  const hasCol = await hasLeadPreferredBranchLabelColumn(tenantDb);
  if (!hasCol) {
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await tenantDb
        .prepare("UPDATE leads SET preferred_branch_label = ? WHERE id = ?")
        .bind(cleanLabel, leadId)
        .run();
      return;
    } catch (err) {
      if (isMissingLeadColumnError(err)) {
        return;
      }
      if (attempt === 1) {
        throw new LeadStorageError("Gagal menyimpan snapshot label cabang pada pesan masuk.");
      }
    }
  }
}

/**
 * Returns a lightweight `id -> name` map of all branches in this tenant's `TenantStore`
 * for Lead Inbox display fallback.
 */
export async function listLeadBranchLabels(
  tenantDb: D1Database,
): Promise<Readonly<Record<number, string>>> {
  try {
    const res = await tenantDb
      .prepare("SELECT id, name FROM branches ORDER BY id ASC")
      .all<{ readonly id: number; readonly name: string }>();
    const map: Record<number, string> = {};
    for (const row of res.results ?? []) {
      const label = sanitizeBranchLabelForDisplay(row.name);
      if (label) {
        map[Number(row.id)] = label;
      }
    }
    return map;
  } catch (err) {
    if (isMissingLeadTableOrColumnError(err)) {
      return {};
    }
    return {};
  }
}

function escapeSqlLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// TenantStore Lead Queries & Mutations
// ---------------------------------------------------------------------------

/**
 * Lists tenant leads with status filter, optional search, cursor pagination, and status counts.
 */
export async function listLeads(
  tenantDb: D1Database,
  input: ListLeadsInput = {},
): Promise<ListLeadsResult> {
  const status = input.status ?? "all";
  if (status !== "all" && !LEAD_STATUS_SET.has(status)) {
    throw new LeadValidationError("Filter status tidak valid.", [
      { field: "status", code: "INVALID_STATUS_FILTER", message: "Status harus all, new, contacted, atau closed." },
    ]);
  }

  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new LeadValidationError("Parameter limit harus antara 1 hingga 100.", [
      { field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer between 1 and 100." },
    ]);
  }

  let parsedCursor: LeadCursorPayload | null = null;
  if (input.cursor && input.cursor.trim().length > 0) {
    parsedCursor = decodeCursor(input.cursor.trim());
    if (!parsedCursor) {
      throw new LeadValidationError("Parameter cursor tidak valid.", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Malformed pagination cursor." },
      ]);
    }
  }

  const searchTrimmed = input.search?.trim() ?? "";
  if (searchTrimmed.length > MAX_LEAD_SEARCH_LENGTH) {
    throw new LeadValidationError(`Kata kunci pencarian maksimal ${MAX_LEAD_SEARCH_LENGTH} karakter.`, [
      { field: "search", code: "TOO_LONG", message: `search must be at most ${MAX_LEAD_SEARCH_LENGTH} chars.` },
    ]);
  }

  const whereClauses: string[] = [];
  const bindValues: unknown[] = [];

  if (status !== "all") {
    whereClauses.push("l.status = ?");
    bindValues.push(status);
  }

  if (searchTrimmed.length > 0) {
    const likePattern = `%${escapeSqlLike(searchTrimmed.toLowerCase())}%`;
    whereClauses.push(
      "(LOWER(l.name) LIKE ? ESCAPE '\\' OR LOWER(l.phone_e164) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(l.email, '')) LIKE ? ESCAPE '\\' OR LOWER(l.message) LIKE ? ESCAPE '\\')",
    );
    bindValues.push(likePattern, likePattern, likePattern, likePattern);
  }

  if (parsedCursor) {
    whereClauses.push("(l.created_at < ? OR (l.created_at = ? AND l.id < ?))");
    bindValues.push(parsedCursor.c, parsedCursor.c, parsedCursor.i);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const queryRows = async (includeSnapshotColumn: boolean) => {
    const branchLabelExpr = includeSnapshotColumn
      ? "COALESCE(l.preferred_branch_label, b.name)"
      : "b.name";
    return tenantDb
      .prepare(
        `SELECT l.id, l.name, l.phone_e164, l.email, l.message, l.preferred_date, l.preferred_time,
                l.branch_id, ${branchLabelExpr} AS preferred_branch_label,
                l.source_category, l.utm_json, l.page_path, l.status, l.internal_notes,
                l.version, l.created_at, l.updated_at
         FROM leads l
         LEFT JOIN branches b ON b.id = l.branch_id
         ${whereSql}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
      )
      .bind(...bindValues, limit + 1)
      .all<RawLeadRow>();
  };

  try {
    const includeSnapshotColumn = await hasLeadPreferredBranchLabelColumn(tenantDb);
    const [rowsRes, countsRes] = await Promise.all([
      queryRows(includeSnapshotColumn),
      tenantDb
        .prepare("SELECT status, COUNT(*) AS cnt FROM leads GROUP BY status")
        .all<{ readonly status: string; readonly cnt: number }>(),
    ]);

    const rawRows = rowsRes.results ?? [];
    const hasMore = rawRows.length > limit;
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const items = pageRows.map(mapRawLeadRow);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAtMs, last.id) : null;

    let newCount = 0;
    let contactedCount = 0;
    let closedCount = 0;
    for (const row of countsRes.results ?? []) {
      const n = Number(row.cnt ?? 0);
      if (row.status === "new") newCount = n;
      else if (row.status === "contacted") contactedCount = n;
      else if (row.status === "closed") closedCount = n;
    }

    return {
      items,
      counts: {
        all: newCount + contactedCount + closedCount,
        new: newCount,
        contacted: contactedCount,
        closed: closedCount,
      },
      page: {
        limit,
        hasMore,
        nextCursor,
      },
    };
  } catch (err) {
    if (err instanceof LeadValidationError) throw err;
    throw new LeadStorageError();
  }
}

/**
 * Loads a single lead by sequential integer ID within the scoped tenant.
 */
export async function getLeadById(
  tenantDb: D1Database,
  leadId: number,
): Promise<LeadRecord | null> {
  if (!Number.isSafeInteger(leadId) || leadId < 1) {
    return null;
  }
  const fetchOne = async (includeSnapshotColumn: boolean) => {
    const branchLabelExpr = includeSnapshotColumn
      ? "COALESCE(l.preferred_branch_label, b.name)"
      : "b.name";
    return tenantDb
      .prepare(
        `SELECT l.id, l.name, l.phone_e164, l.email, l.message, l.preferred_date, l.preferred_time,
                l.branch_id, ${branchLabelExpr} AS preferred_branch_label,
                l.source_category, l.utm_json, l.page_path, l.status, l.internal_notes,
                l.version, l.created_at, l.updated_at
         FROM leads l
         LEFT JOIN branches b ON b.id = l.branch_id
         WHERE l.id = ?
         LIMIT 1`,
      )
      .bind(leadId)
      .first<RawLeadRow>();
  };

  try {
    const includeSnapshotColumn = await hasLeadPreferredBranchLabelColumn(tenantDb);
    const row = await fetchOne(includeSnapshotColumn);
    return row ? mapRawLeadRow(row) : null;
  } catch {
    throw new LeadStorageError();
  }
}

/**
 * Updates a lead's follow-up status and optional internal notes with optimistic version locking
 * (`409 STALE_VERSION`), forward-only status transition validation, and PII-free activity audit.
 */
export async function updateLeadStatus(
  tenantDb: D1Database,
  input: UpdateLeadInput,
): Promise<LeadRecord> {
  if (!LEAD_STATUS_SET.has(input.status)) {
    throw new LeadValidationError("Status pesan masuk tidak valid.", [
      { field: "status", code: "INVALID_STATUS", message: "Status harus new, contacted, atau closed." },
    ]);
  }

  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LeadValidationError("Versi pesan masuk tidak valid.", [
      { field: "version", code: "INVALID_VERSION", message: "version must be a positive integer." },
    ]);
  }

  let normalizedNotes: string | null | undefined;
  if (input.internalNotes !== undefined) {
    if (input.internalNotes === null) {
      normalizedNotes = null;
    } else if (typeof input.internalNotes !== "string") {
      throw new LeadValidationError("Catatan internal harus berupa teks.", [
        { field: "internalNotes", code: "INVALID_NOTES", message: "internalNotes must be a string or null." },
      ]);
    } else if (hasDisallowedControlChars(input.internalNotes, true)) {
      throw new LeadValidationError("Catatan internal mengandung karakter kontrol tidak valid.", [
        { field: "internalNotes", code: "CONTROL_CHARACTERS", message: "Control characters are not allowed." },
      ]);
    } else {
      const trimmed = input.internalNotes.trim();
      if (trimmed.length > MAX_LEAD_NOTES_LENGTH) {
        throw new LeadValidationError(`Catatan internal maksimal ${MAX_LEAD_NOTES_LENGTH} karakter.`, [
          { field: "internalNotes", code: "TOO_LONG", message: `internalNotes must be <= ${MAX_LEAD_NOTES_LENGTH} chars.` },
        ]);
      }
      normalizedNotes = trimmed.length > 0 ? trimmed : null;
    }
  }

  const current = await getLeadById(tenantDb, input.leadId);
  if (!current) {
    throw new LeadNotFoundError(input.leadId);
  }

  if (current.version !== input.expectedVersion) {
    throw new LeadStaleVersionError(input.leadId, input.expectedVersion, current.version);
  }

  if (!isValidLeadStatusTransition(current.status, input.status)) {
    throw new LeadValidationError(
      `Transisi status dari "${current.status}" ke "${input.status}" tidak diizinkan.`,
      [
        {
          field: "status",
          code: "INVALID_STATUS_TRANSITION",
          message: `Cannot transition lead status backward from "${current.status}" to "${input.status}".`,
        },
      ],
    );
  }

  const nextNotes = normalizedNotes === undefined ? current.internalNotes : normalizedNotes;
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const nextVersion = input.expectedVersion + 1;

  try {
    // Atomic single-transaction batch (`transactionSync` in TenantStore):
    // 1. Guarded optimistic UPDATE on `leads`
    // 2. Conditional PII-free `tenant_activity_log` INSERT executed ONLY when UPDATE matched (`changes() = 1`)
    const batchResults = await tenantDb.batch<RawLeadRow>([
      tenantDb
        .prepare(
          `UPDATE leads
           SET status = ?,
               internal_notes = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
           RETURNING id, name, phone_e164, email, message, preferred_date, preferred_time,
                     branch_id, source_category, utm_json, page_path, status, internal_notes,
                     version, created_at, updated_at`,
        )
        .bind(input.status, nextNotes, nowMs, input.leadId, input.expectedVersion),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id,
             summary, metadata_json, created_at
           )
           SELECT ?, ?, 'lead.status_updated', 'lead', ?, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          input.actorUserId ?? null,
          input.actorRole ?? "admin",
          String(input.leadId),
          `Status pesan masuk #${input.leadId} diperbarui menjadi ${input.status}`,
          JSON.stringify({ from: current.status, to: input.status, version: nextVersion }),
          nowMs,
        ),
    ]);

    const updatedRow = batchResults[0]?.results?.[0] ?? null;

    if (!updatedRow) {
      const latest = await getLeadById(tenantDb, input.leadId);
      if (!latest) throw new LeadNotFoundError(input.leadId);
      throw new LeadStaleVersionError(input.leadId, input.expectedVersion, latest.version);
    }

    return {
      ...mapRawLeadRow(updatedRow),
      preferredBranchLabel: current.preferredBranchLabel ?? null,
    };
  } catch (err) {
    if (
      err instanceof LeadValidationError ||
      err instanceof LeadNotFoundError ||
      err instanceof LeadStaleVersionError ||
      err instanceof LeadStorageError
    ) {
      throw err;
    }
    throw new LeadStorageError();
  }
}

export interface ListLeadsForExportResult {
  readonly leads: readonly LeadRecord[];
  readonly truncated: boolean;
}

/**
 * Fetches tenant leads ordered newest-first for formula-injection-safe CSV export.
 * Queries `maxRows + 1` rows to detect truncation accurately (`X-Truncated: 1`).
 */
export async function listAllLeadsForExport(
  tenantDb: D1Database,
  options: { readonly maxRows?: number } = {},
): Promise<ListLeadsForExportResult> {
  const maxRows = Math.min(Math.max(1, options.maxRows ?? MAX_LEAD_CSV_EXPORT_ROWS), MAX_LEAD_CSV_EXPORT_ROWS);
  const fetchExport = async (includeSnapshotColumn: boolean) => {
    const branchLabelExpr = includeSnapshotColumn
      ? "COALESCE(l.preferred_branch_label, b.name)"
      : "b.name";
    return tenantDb
      .prepare(
        `SELECT l.id, l.name, l.phone_e164, l.email, l.message, l.preferred_date, l.preferred_time,
                l.branch_id, ${branchLabelExpr} AS preferred_branch_label,
                l.source_category, l.utm_json, l.page_path, l.status, l.internal_notes,
                l.version, l.created_at, l.updated_at
         FROM leads l
         LEFT JOIN branches b ON b.id = l.branch_id
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
      )
      .bind(maxRows + 1)
      .all<RawLeadRow>();
  };

  try {
    const includeSnapshotColumn = await hasLeadPreferredBranchLabelColumn(tenantDb);
    const res = await fetchExport(includeSnapshotColumn);
    const rawRows = res.results ?? [];
    const truncated = rawRows.length > maxRows;
    const bounded = truncated ? rawRows.slice(0, maxRows) : rawRows;
    return {
      leads: bounded.map(mapRawLeadRow),
      truncated,
    };
  } catch {
    throw new LeadStorageError();
  }
}

/**
 * Records a PII-free CSV export audit entry inside `tenant_activity_log`.
 */
export async function recordLeadCsvExportAudit(
  tenantDb: D1Database,
  input: {
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly exportedCount: number;
    readonly truncated: boolean;
    readonly nowMs?: number;
  },
): Promise<void> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  try {
    await tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id,
           summary, metadata_json, created_at
         ) VALUES (?, ?, 'lead.export_csv', 'lead', NULL, ?, ?, ?)`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        `Ekspor CSV pesan masuk (${input.exportedCount} baris${input.truncated ? ", terpotong" : ""})`,
        JSON.stringify({ exportedCount: input.exportedCount, truncated: input.truncated }),
        nowMs,
      )
      .run();
  } catch {
    // Non-blocking: never prevent an authorized owner from recovering leads CSV.
  }
}

// ---------------------------------------------------------------------------
// Per-Tenant Switchable Owner Lead Email Notification Preference (REQ-031)
// Stored in existing `installed_plugins` table (0001_initial_tenant.sql) — ZERO runtime DDL!
// ---------------------------------------------------------------------------

export const LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID = "builtin:lead-email-notifications" as const;

/**
 * Reads the tenant's lead email notification preference (`leadEmailNotificationsEnabled`)
 * from the pre-existing `installed_plugins` table (`0001_initial_tenant.sql`).
 * Defaults to `{ emailEnabled: true }` when not explicitly configured (REQ-031).
 */
export async function getLeadNotificationSettings(
  tenantDb: D1Database,
): Promise<LeadNotificationSettings> {
  try {
    const row = await tenantDb
      .prepare(
        "SELECT enabled, updated_at FROM installed_plugins WHERE plugin_id = ? LIMIT 1",
      )
      .bind(LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID)
      .first<{ readonly enabled: number; readonly updated_at: number }>();
    if (!row) {
      return { emailEnabled: true, updatedAtMs: null };
    }
    return {
      emailEnabled: row.enabled === 1,
      updatedAtMs: Number(row.updated_at),
    };
  } catch {
    throw new LeadStorageError();
  }
}

/**
 * Persists the tenant's `leadEmailNotificationsEnabled` toggle (ON/OFF) into the
 * pre-existing `installed_plugins` table (`0001_initial_tenant.sql`) with zero runtime DDL.
 */
export async function updateLeadNotificationSettings(
  tenantDb: D1Database,
  input: {
    readonly emailEnabled: boolean;
    readonly updatedBy?: string | null;
    readonly nowMs?: number;
  },
): Promise<LeadNotificationSettings> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const configJson = JSON.stringify({
    updatedBy: input.updatedBy ?? null,
  });
  try {
    await tenantDb
      .prepare(
        `INSERT INTO installed_plugins (
           plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
         ) VALUES (?, '1.0.0', ?, ?, 1, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        LEAD_EMAIL_NOTIFICATIONS_FEATURE_ID,
        input.emailEnabled ? 1 : 0,
        configJson,
        nowMs,
        nowMs,
      )
      .run();
    return {
      emailEnabled: input.emailEnabled,
      updatedAtMs: nowMs,
    };
  } catch {
    throw new LeadStorageError();
  }
}
