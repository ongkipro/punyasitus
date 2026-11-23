/**
 * Deterministic UTC / Asia-Jakarta (WIB) Monthly Period Calculation
 * for TASK-110: Monthly Owner Performance Report Email (`REQ-110`, `PLAN.md` §20.5, `DEC-043`).
 *
 * Invariants:
 * - Evaluates the 1st day of the month in the configured IANA timezone (default `Asia/Jakarta`, WIB UTC+7).
 * - Running on `2026-12-01` summarizes `reportMonth = "2026-11"` (`2026-11-01`..`2026-11-30`)
 *   and compares against `comparisonMonth = "2026-10"` (`2026-10-01`..`2026-10-31`).
 * - Handles year boundaries (`2027-01-01` -> `2026-12` vs `2026-11`) and leap years (`2028-02` -> 29 days).
 */

export const DEFAULT_MONTHLY_REPORT_TIMEZONE = "Asia/Jakarta" as const;

export const MONTHLY_REPORT_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const INDONESIAN_MONTH_NAMES: readonly string[] = [
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
];

export interface LocalCalendarDate {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
}

export interface MonthlyReportPeriod {
  readonly reportMonth: string; // YYYY-MM
  readonly reportYear: number;
  readonly reportMonthNumber: number; // 1..12
  readonly reportMonthLabelId: string; // e.g. "November 2026"
  readonly startDay: string; // YYYY-MM-01
  readonly endDay: string; // YYYY-MM-DD (last day of reportMonth)
  readonly comparisonMonth: string; // YYYY-MM
  readonly comparisonYear: number;
  readonly comparisonMonthNumber: number; // 1..12
  readonly comparisonMonthLabelId: string; // e.g. "Oktober 2026"
  readonly comparisonStartDay: string; // YYYY-MM-01
  readonly comparisonEndDay: string; // YYYY-MM-DD (last day of comparisonMonth)
  readonly timeZone: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInCalendarMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

function formatMonthKey(year: number, month1To12: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month1To12)}`;
}

export function formatIndonesianMonthLabel(year: number, month1To12: number): string {
  const name = INDONESIAN_MONTH_NAMES[month1To12 - 1];
  if (!name) {
    throw new RangeError(`INVALID_MONTH: expected 1..12, received ${String(month1To12)}`);
  }
  return `${name} ${String(year).padStart(4, "0")}`;
}

function previousYearMonth(year: number, month1To12: number): { year: number; month: number } {
  if (month1To12 === 1) {
    return { year: year - 1, month: 12 };
  }
  return { year, month: month1To12 - 1 };
}

export function normalizeReportTimeZone(timeZone?: string | null): string {
  const candidate = (timeZone ?? "").trim() || DEFAULT_MONTHLY_REPORT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_MONTHLY_REPORT_TIMEZONE;
  }
}

/**
 * Extracts `{ year, month, day }` in the given IANA timezone (default `Asia/Jakarta`).
 */
export function getLocalCalendarDate(
  timestampMs: number,
  timeZone: string = DEFAULT_MONTHLY_REPORT_TIMEZONE,
): LocalCalendarDate {
  if (!Number.isFinite(timestampMs)) {
    throw new RangeError("INVALID_TIMESTAMP: timestampMs must be a finite number");
  }
  const safeTz = normalizeReportTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));

  const year = Number(parts.find((p) => p.type === "year")?.value ?? NaN);
  const month = Number(parts.find((p) => p.type === "month")?.value ?? NaN);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? NaN);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`FAILED_LOCAL_DATE_PARSE: unable to format timestamp in ${safeTz}`);
  }

  return { year, month, day };
}

/**
 * Returns `true` iff `timestampMs` falls on the 1st calendar day of the month
 * in the target timezone (default `Asia/Jakarta`, WIB).
 */
export function isFirstDayOfMonth(
  timestampMs: number,
  timeZone: string = DEFAULT_MONTHLY_REPORT_TIMEZONE,
): boolean {
  return getLocalCalendarDate(timestampMs, timeZone).day === 1;
}

/**
 * Builds a complete `MonthlyReportPeriod` for an explicit `YYYY-MM` report month
 * along with its immediate preceding `comparisonMonth`.
 */
export function parseReportMonthPeriod(
  reportMonth: string,
  timeZone: string = DEFAULT_MONTHLY_REPORT_TIMEZONE,
): MonthlyReportPeriod {
  const trimmed = reportMonth.trim();
  const match = MONTHLY_REPORT_MONTH_RE.exec(trimmed);
  if (!match) {
    throw new RangeError(
      `INVALID_REPORT_MONTH: expected YYYY-MM, received "${reportMonth}"`,
    );
  }

  const reportYear = Number(match[1]);
  const reportMonthNumber = Number(match[2]);
  const safeTz = normalizeReportTimeZone(timeZone);
  const reportLastDay = daysInCalendarMonth(reportYear, reportMonthNumber);
  const reportKey = formatMonthKey(reportYear, reportMonthNumber);

  const prev = previousYearMonth(reportYear, reportMonthNumber);
  const prevLastDay = daysInCalendarMonth(prev.year, prev.month);
  const prevKey = formatMonthKey(prev.year, prev.month);

  return {
    reportMonth: reportKey,
    reportYear,
    reportMonthNumber,
    reportMonthLabelId: formatIndonesianMonthLabel(reportYear, reportMonthNumber),
    startDay: `${reportKey}-01`,
    endDay: `${reportKey}-${pad2(reportLastDay)}`,
    comparisonMonth: prevKey,
    comparisonYear: prev.year,
    comparisonMonthNumber: prev.month,
    comparisonMonthLabelId: formatIndonesianMonthLabel(prev.year, prev.month),
    comparisonStartDay: `${prevKey}-01`,
    comparisonEndDay: `${prevKey}-${pad2(prevLastDay)}`,
    timeZone: safeTz,
  };
}

/**
 * Resolves the previous calendar month period relative to `runAtMs` in `timeZone`.
 *
 * Example: running on `2026-12-01` (WIB or UTC) produces:
 * - `reportMonth: "2026-11"` (`2026-11-01`..`2026-11-30`, `"November 2026"`)
 * - `comparisonMonth: "2026-10"` (`2026-10-01`..`2026-10-31`, `"Oktober 2026"`)
 */
export function resolvePreviousCalendarMonthPeriod(
  runAtMs: number,
  timeZone: string = DEFAULT_MONTHLY_REPORT_TIMEZONE,
): MonthlyReportPeriod {
  const safeTz = normalizeReportTimeZone(timeZone);
  const current = getLocalCalendarDate(runAtMs, safeTz);
  const prev = previousYearMonth(current.year, current.month);
  return parseReportMonthPeriod(formatMonthKey(prev.year, prev.month), safeTz);
}

/**
 * Deterministic idempotency / claim key per `(tenantId, reportMonth)`.
 * Guarantees at most one monthly performance report per active website per month.
 */
export function buildMonthlyReportMessageKey(tenantId: string, reportMonth: string): string {
  const cleanTenantId = tenantId.trim();
  if (!cleanTenantId || cleanTenantId.length > 128 || /[\r\n\0:]/.test(cleanTenantId)) {
    throw new RangeError("INVALID_TENANT_ID: tenantId must be a clean non-empty identifier");
  }
  const period = parseReportMonthPeriod(reportMonth);
  return `monthly-report:${cleanTenantId}:${period.reportMonth}`;
}

/**
 * Deterministic cron dispatch idempotency key per `reportMonth`.
 */
export function buildMonthlyReportCronKey(reportMonth: string): string {
  const period = parseReportMonthPeriod(reportMonth);
  return `cron:monthly-owner-report:${period.reportMonth}`;
}
