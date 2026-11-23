/**
 * Preferred Schedule Fields for Inquiries — Pure Domain Rules & Tenant-Timezone Calendar Math
 * (`packages/core/src/leads/schedule.ts`; REQ-072, PLAN §6 & §18.4, TASK-071).
 *
 * Invariants:
 * - Date-only calendar values (`YYYY-MM-DD`): NEVER shifted across timezone conversions.
 * - Valid window is strictly `[todayInTenantTz, todayInTenantTz + 180 days]` computed in the
 *   tenant's configured IANA timezone (default `Asia/Jakarta`).
 * - `preferred_time` accepts ONLY `"pagi" | "siang" | "sore" | "malam"`.
 * - Request-only semantics ("permintaan jadwal"): zero slot inventory, availability check,
 *   or automatic booking confirmation.
 * - Privacy invariant: schedule values MUST NEVER be emitted into analytics payloads,
 *   ad pixels, or structured console/audit logs (`stripScheduleFieldsForTelemetry`).
 */

export const DEFAULT_TENANT_TIMEZONE = "Asia/Jakarta" as const;
export const MAX_PREFERRED_DATE_AHEAD_DAYS = 180 as const;
export const MAX_PREFERRED_BRANCH_LABEL_LENGTH = 120 as const;

export const PREFERRED_TIME_WINDOWS = ["pagi", "siang", "sore", "malam"] as const;
export type PreferredTimeWindow = (typeof PREFERRED_TIME_WINDOWS)[number];

const PREFERRED_TIME_WINDOW_SET: ReadonlySet<string> = new Set(PREFERRED_TIME_WINDOWS);

export const PREFERRED_TIME_LABELS_ID: Readonly<Record<PreferredTimeWindow, string>> = {
  pagi: "Pagi",
  siang: "Siang",
  sore: "Sore",
  malam: "Malam",
};

export const SCHEDULE_SENSITIVE_FIELD_KEYS = [
  "preferred_date",
  "preferredDate",
  "preferred_time",
  "preferredTime",
  "branch",
  "branch_id",
  "branchId",
  "preferred_branch_label",
  "preferredBranchLabel",
] as const;

const SCHEDULE_SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(SCHEDULE_SENSITIVE_FIELD_KEYS);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_INT_STRING_RE = /^[1-9]\d{0,9}$/;

const INDONESIAN_MONTH_NAMES = [
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

export interface PreferredDateBounds {
  readonly minDate: string;
  readonly maxDate: string;
  readonly timeZone: string;
}

export type ScheduleValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Validates an IANA timezone string using `Intl.DateTimeFormat`, falling back cleanly
 * to `Asia/Jakarta` when blank or unsupported.
 */
export function normalizeTenantTimeZone(rawTimeZone?: string | null): string {
  const candidate = typeof rawTimeZone === "string" ? rawTimeZone.trim() : "";
  if (!candidate) return DEFAULT_TENANT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

/**
 * Strictly validates that `value` is a real Gregorian calendar `YYYY-MM-DD` date
 * (rejecting e.g. `2026-02-29`, `2026-04-31`, `2026-13-01`, or timestamp strings).
 */
export function isValidCalendarIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
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

/**
 * Computes today's date (`YYYY-MM-DD`) strictly in `timeZone` using `Intl.DateTimeFormat.formatToParts`.
 * Never uses `Date.prototype.toISOString().slice(0, 10)` which would shift across UTC boundaries.
 */
export function getTodayIsoDateInTimeZone(
  nowMs: number = Date.now(),
  timeZone?: string | null,
): string {
  const safeTz = normalizeTenantTimeZone(timeZone);
  const safeMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(safeMs));

  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Pure calendar day arithmetic over `YYYY-MM-DD` strings.
 * Immune to host timezone and daylight-saving transitions.
 */
export function addCalendarDaysToIsoDate(isoDate: string, days: number): string {
  if (!isValidCalendarIsoDate(isoDate)) {
    throw new RangeError(`Invalid ISO calendar date: "${isoDate}"`);
  }
  if (!Number.isInteger(days)) {
    throw new RangeError(`Calendar day offset must be an integer, got: ${days}`);
  }
  const [yStr, mStr, dStr] = isoDate.split("-");
  const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + days));
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns `[minDate, maxDate]` (`today` to `today + 180 days`) in the tenant's timezone.
 */
export function getPreferredDateBounds(options?: {
  readonly nowMs?: number;
  readonly timeZone?: string | null;
}): PreferredDateBounds {
  const timeZone = normalizeTenantTimeZone(options?.timeZone);
  const minDate = getTodayIsoDateInTimeZone(options?.nowMs ?? Date.now(), timeZone);
  const maxDate = addCalendarDaysToIsoDate(minDate, MAX_PREFERRED_DATE_AHEAD_DAYS);
  return { minDate, maxDate, timeZone };
}

/**
 * Validates optional `preferred_date` as a strict date-only `YYYY-MM-DD` value within
 * `[todayInTenantTz, todayInTenantTz + 180 days]`. Never shifts the date across timezones.
 */
export function validatePreferredDate(
  raw: unknown,
  options?: {
    readonly nowMs?: number;
    readonly timeZone?: string | null;
  },
): ScheduleValidationResult<string | null> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "INVALID_DATE",
      message: "Tanggal permintaan jadwal harus menggunakan format YYYY-MM-DD yang valid.",
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (!isValidCalendarIsoDate(trimmed)) {
    return {
      ok: false,
      code: "INVALID_DATE",
      message: "Tanggal permintaan jadwal harus menggunakan format YYYY-MM-DD yang valid.",
    };
  }

  const bounds = getPreferredDateBounds(options);
  if (trimmed < bounds.minDate) {
    return {
      ok: false,
      code: "DATE_IN_PAST",
      message: "Tanggal permintaan jadwal tidak boleh berada di masa lalu.",
    };
  }
  if (trimmed > bounds.maxDate) {
    return {
      ok: false,
      code: "DATE_TOO_FAR",
      message: `Tanggal permintaan jadwal maksimal ${MAX_PREFERRED_DATE_AHEAD_DAYS} hari ke depan.`,
    };
  }

  return { ok: true, value: trimmed };
}

/**
 * Validates optional `preferred_time` strictly against `"pagi" | "siang" | "sore" | "malam"`.
 */
export function validatePreferredTime(
  raw: unknown,
): ScheduleValidationResult<PreferredTimeWindow | null> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "INVALID_PREFERRED_TIME",
      message: "Waktu pilihan harus salah satu dari pagi, siang, sore, atau malam.",
    };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (!PREFERRED_TIME_WINDOW_SET.has(trimmed)) {
    return {
      ok: false,
      code: "INVALID_PREFERRED_TIME",
      message: "Waktu pilihan harus salah satu dari pagi, siang, sore, atau malam.",
    };
  }
  return { ok: true, value: trimmed as PreferredTimeWindow };
}

/**
 * Parses an optional per-tenant sequential positive integer branch/outlet ID.
 */
export function parseOptionalBranchId(raw: unknown): ScheduleValidationResult<number | null> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw === "string" && raw.trim().length === 0) {
    return { ok: true, value: null };
  }
  const numericBranch =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && POSITIVE_INT_STRING_RE.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;

  if (
    !Number.isSafeInteger(numericBranch) ||
    numericBranch < 1 ||
    numericBranch > 2_147_483_647
  ) {
    return {
      ok: false,
      code: "INVALID_BRANCH",
      message: "ID cabang tidak valid.",
    };
  }

  return { ok: true, value: numericBranch };
}

/**
 * Formats a date-only `YYYY-MM-DD` string in Bahasa Indonesia (e.g. `"2026-12-05"` -> `"5 Desember 2026"`)
 * using pure integer calendar indexing so runtime/browser timezone NEVER shifts the date.
 */
export function formatPreferredDateIndonesian(isoDate: string): string {
  if (!isValidCalendarIsoDate(isoDate)) return isoDate;
  const [yStr, mStr, dStr] = isoDate.split("-");
  const monthIdx = Number(mStr) - 1;
  const day = Number(dStr);
  const monthName = INDONESIAN_MONTH_NAMES[monthIdx] ?? mStr;
  return `${day} ${monthName} ${yStr}`;
}

/**
 * Maps canonical `PreferredTimeWindow` (`pagi`..`malam`) to its Bahasa Indonesia display label.
 */
export function formatPreferredTimeLabelId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!PREFERRED_TIME_WINDOW_SET.has(normalized)) return null;
  return PREFERRED_TIME_LABELS_ID[normalized as PreferredTimeWindow];
}

/**
 * Sanitizes a branch/outlet name snapshot for storage and display (single-line, bounded).
 */
export function sanitizeBranchLabelForDisplay(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let clean = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      clean += " ";
    } else {
      clean += raw[i] ?? "";
    }
  }
  const collapsed = clean.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= MAX_PREFERRED_BRANCH_LABEL_LENGTH
    ? collapsed
    : collapsed.slice(0, MAX_PREFERRED_BRANCH_LABEL_LENGTH).trimEnd();
}

/**
 * Deeply removes all preferred-schedule keys from an arbitrary telemetry, analytics,
 * or structured log object so visitor schedule choices NEVER leak into analytics or logs.
 */
export function stripScheduleFieldsForTelemetry(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sanitizeValue = (val: unknown): unknown => {
    if (Array.isArray(val)) {
      return val.map(sanitizeValue);
    }
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (SCHEDULE_SENSITIVE_KEY_SET.has(k)) continue;
        out[k] = sanitizeValue(v);
      }
      return out;
    }
    return val;
  };

  return sanitizeValue(input) as Record<string, unknown>;
}

/**
 * Returns `true` if any nested object contains a preferred-schedule field key.
 */
export function containsScheduleFieldKey(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  if (Array.isArray(input)) {
    return input.some((item) => containsScheduleFieldKey(item));
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SCHEDULE_SENSITIVE_KEY_SET.has(k)) return true;
    if (containsScheduleFieldKey(v)) return true;
  }
  return false;
}
