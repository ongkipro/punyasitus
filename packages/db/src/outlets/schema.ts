import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "@punyasitus/core/link-sanitizer";
import { FORBIDDEN_TENANT_SELECTOR_KEYS } from "@punyasitus/core/schemas/common";
import type {
  OutletWeekdayKey,
  SchemaBranchInput,
  SchemaOpeningHoursSpecInput,
  SchemaSpecialOpeningHoursSpecInput,
} from "@punyasitus/core/schema-generator";
import {
  normalizeIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";

/**
 * Multi-Outlet Directory (`outlets`) Validation, Normalization & Formatting
 * (`packages/db/src/outlets/schema.ts`; REQ-029, REQ-039, REQ-054, TASK-019).
 *
 * Hard Invariants:
 * - Bounded cap: maximum 10 outlets per website beside main business profile (REQ-029 / REQ-088).
 * - Strict payload validation rejecting unknown fields & forbidden tenant selectors.
 * - Structured weekly operating hours (Mon–Sun) and holiday hours (calendar date, label, hours/closed).
 * - E.164 validated phone & WhatsApp numbers.
 * - WGS84 coordinate bounds (`[-90, 90]`, `[-180, 180]`) with complete pair enforcement.
 * - Safe Google Maps directions URL (`https://www.google.com/maps/dir/?api=1&destination=...`)
 *   and consent-gated embed URL derivation — ZERO `javascript:`, `data:`, `http://`, localhost/private IP,
 *   or open-redirect `google.com/url?...` URLs.
 */

export const MAX_OUTLETS_PER_TENANT = 10 as const;
export const MAX_OUTLET_HOLIDAY_ENTRIES = 30 as const;
export const DEFAULT_OUTLET_TIMEZONE = "Asia/Jakarta" as const;

export const OUTLET_WEEKDAYS: readonly OutletWeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export const OUTLET_WEEKDAY_LABELS_ID: Readonly<Record<OutletWeekdayKey, string>> = {
  monday: "Senin",
  tuesday: "Selasa",
  wednesday: "Rabu",
  thursday: "Kamis",
  friday: "Jumat",
  saturday: "Sabtu",
  sunday: "Minggu",
};

export const OUTLET_TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
] as const;

export const OUTLET_TIMEZONE_LABELS_ID: Readonly<Record<string, string>> = {
  "Asia/Jakarta": "WIB (Asia/Jakarta)",
  "Asia/Makassar": "WITA (Asia/Makassar)",
  "Asia/Jayapura": "WIT (Asia/Jayapura)",
};

export const MAX_OUTLET_NAME_LENGTH = 120 as const;
export const MAX_OUTLET_SLUG_LENGTH = 80 as const;
export const MAX_OUTLET_ADDRESS_LENGTH = 500 as const;
export const MAX_OUTLET_CITY_LENGTH = 120 as const;
export const MAX_OUTLET_PROVINCE_LENGTH = 120 as const;
export const MAX_OUTLET_POSTAL_CODE_LENGTH = 20 as const;
export const MAX_OUTLET_PHONE_LENGTH = 32 as const;
export const MAX_OUTLET_HOLIDAY_LABEL_LENGTH = 100 as const;
export const MAX_OUTLET_SORT_ORDER = 100 as const;

const FORBIDDEN_SELECTOR_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9 -]{3,20}$/;
const WEEKDAY_INDEX: ReadonlyMap<OutletWeekdayKey, number> = new Map(
  OUTLET_WEEKDAYS.map((d, i) => [d, i]),
);

export const OUTLET_CREATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "slug",
  "address",
  "city",
  "province",
  "postalCode",
  "phone",
  "whatsappE164",
  "whatsappNumber",
  "mapsUrl",
  "directionsUrl",
  "latitude",
  "longitude",
  "weeklyHours",
  "holidayHours",
  "timezone",
  "sortOrder",
  "isPrimary",
  "status",
  "active",
]);

export const OUTLET_UPDATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...OUTLET_CREATE_ALLOWED_KEYS,
  "expectedVersion",
  "version",
]);

export type OutletStatus = "draft" | "published";

export interface OutletWeeklyHoursEntry {
  readonly day: OutletWeekdayKey;
  readonly open: string | null;
  readonly close: string | null;
  readonly closed: boolean;
}

export interface OutletHolidayHoursEntry {
  readonly date: string;
  readonly label: string;
  readonly open: string | null;
  readonly close: string | null;
  readonly closed: boolean;
}

export interface OutletValidationFieldIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type OutletValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly fields: readonly OutletValidationFieldIssue[];
    };

export interface OutletRecord {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly address: string;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly mapsUrl: string | null;
  readonly directionsUrl: string | null;
  readonly mapEmbedUrl: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly weeklyHours: readonly OutletWeeklyHoursEntry[];
  readonly holidayHours: readonly OutletHolidayHoursEntry[];
  readonly weekdayHoursText: string | null;
  readonly holidayHoursText: string | null;
  readonly timezone: string;
  readonly sortOrder: number;
  readonly isPrimary: boolean;
  readonly status: OutletStatus;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NormalizedOutletCreateInput {
  readonly name: string;
  readonly slug: string;
  readonly address: string;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly mapsUrl: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly weeklyHours: readonly OutletWeeklyHoursEntry[];
  readonly holidayHours: readonly OutletHolidayHoursEntry[];
  readonly timezone: string;
  readonly sortOrder?: number;
  readonly isPrimary: boolean;
  readonly status: OutletStatus;
  readonly active: boolean;
}

export interface NormalizedOutletUpdateInput {
  readonly name?: string;
  readonly slug?: string;
  readonly address?: string;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly phone?: string | null;
  readonly whatsappE164?: string | null;
  readonly mapsUrl?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly weeklyHours?: readonly OutletWeeklyHoursEntry[];
  readonly holidayHours?: readonly OutletHolidayHoursEntry[];
  readonly timezone?: string;
  readonly sortOrder?: number;
  readonly isPrimary?: boolean;
  readonly status?: OutletStatus;
  readonly active?: boolean;
  readonly expectedVersion?: number;
}

// ---------------------------------------------------------------------------
// Low-level Sanitizers & Validators
// ---------------------------------------------------------------------------

function hasControlChars(value: string, allowNewlines = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowNewlines && (code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

function collapseSingleLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeMultiLineAddress(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join(", ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isValidOutletCalendarDate(raw: string): boolean {
  const match = ISO_DATE_PATTERN.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function isValidOutletTimeHHMM(raw: string): boolean {
  return HHMM_PATTERN.test(raw);
}

export function slugifyOutletName(name: string, fallbackId?: number): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_OUTLET_SLUG_LENGTH)
    .replace(/-+$/g, "");
  if (ascii.length >= 1) {
    return ascii;
  }
  return fallbackId ? `gerai-${fallbackId}` : "gerai";
}

export function normalizeOutletSlug(
  rawSlug: string | null | undefined,
  fallbackName?: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  if (rawSlug === null || rawSlug === undefined || rawSlug.trim() === "") {
    if (fallbackName && fallbackName.trim().length > 0) {
      return { ok: true, value: slugifyOutletName(fallbackName) };
    }
    return { ok: false, message: "Slug gerai wajib diisi." };
  }
  if (hasControlChars(rawSlug, false)) {
    return { ok: false, message: "Slug gerai tidak boleh mengandung karakter kontrol." };
  }
  const normalized = rawSlug.trim().toLowerCase();
  if (normalized.length > MAX_OUTLET_SLUG_LENGTH || !SLUG_PATTERN.test(normalized)) {
    return {
      ok: false,
      message: "Slug gerai hanya boleh berisi huruf kecil, angka, dan tanda hubung (maks 80 karakter).",
    };
  }
  return { ok: true, value: normalized };
}

export function normalizeOutletPhoneE164(
  rawPhone: string | null | undefined,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly message: string } {
  if (rawPhone === null || rawPhone === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawPhone !== "string") {
    return { ok: false, message: "Nomor telepon harus berupa teks." };
  }
  if (hasControlChars(rawPhone, false)) {
    return { ok: false, message: "Nomor telepon tidak boleh mengandung karakter kontrol." };
  }
  const trimmed = rawPhone.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_OUTLET_PHONE_LENGTH) {
    return {
      ok: false,
      message: `Nomor telepon maksimal ${MAX_OUTLET_PHONE_LENGTH} karakter.`,
    };
  }
  if (!/^[0-9+ ().-]+$/.test(trimmed)) {
    return {
      ok: false,
      message: "Nomor telepon hanya boleh berisi angka, awalan +, spasi, tanda hubung, atau tanda kurung.",
    };
  }
  const plusMatches = trimmed.match(/\+/g);
  if (plusMatches && (plusMatches.length > 1 || !/^\(?\+/.test(trimmed))) {
    return {
      ok: false,
      message: "Tanda '+' hanya boleh muncul satu kali di awal nomor telepon.",
    };
  }
  const compact = trimmed.replace(/[ ().-]/g, "");
  const hasPlus = compact.startsWith("+");
  let digits = hasPlus ? compact.slice(1) : compact;
  if (!/^[0-9]+$/.test(digits)) {
    return { ok: false, message: "Format nomor telepon E.164 tidak valid." };
  }
  if (!hasPlus && digits.startsWith("0")) {
    digits = `62${digits.slice(1)}`;
  }
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) {
    return {
      ok: false,
      message: "Nomor telepon harus memenuhi format E.164 (8–15 digit, contoh: +62217191234).",
    };
  }
  return { ok: true, value: `+${digits}` };
}

export function normalizeOutletWhatsAppE164(
  rawPhone: string | null | undefined,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly message: string } {
  if (rawPhone === null || rawPhone === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawPhone !== "string") {
    return { ok: false, message: "Nomor WhatsApp harus berupa teks." };
  }
  const trimmed = rawPhone.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  try {
    const digits = normalizeIndonesianWhatsAppNumber(trimmed);
    return { ok: true, value: `+${digits}` };
  } catch (err) {
    if (err instanceof WhatsAppValidationError) {
      return {
        ok: false,
        message: "Nomor WhatsApp gerai harus nomor seluler Indonesia yang valid (E.164: +628... / 08...).",
      };
    }
    return { ok: false, message: "Nomor WhatsApp gerai tidak valid." };
  }
}

export function validateOutletCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
):
  | { readonly ok: true; readonly latitude: number | null; readonly longitude: number | null }
  | { readonly ok: false; readonly fields: readonly OutletValidationFieldIssue[] } {
  const hasLat = latitude !== null && latitude !== undefined;
  const hasLng = longitude !== null && longitude !== undefined;

  if (!hasLat && !hasLng) {
    return { ok: true, latitude: null, longitude: null };
  }

  const fields: OutletValidationFieldIssue[] = [];
  if (hasLat && !hasLng) {
    fields.push({
      field: "longitude",
      code: "INCOMPLETE_COORDINATES",
      message: "Longitude wajib diisi jika latitude diisi.",
    });
  }
  if (!hasLat && hasLng) {
    fields.push({
      field: "latitude",
      code: "INCOMPLETE_COORDINATES",
      message: "Latitude wajib diisi jika longitude diisi.",
    });
  }
  if (hasLat) {
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      fields.push({
        field: "latitude",
        code: "INVALID_COORDINATES",
        message: "Latitude harus berupa angka valid antara -90 hingga 90.",
      });
    }
  }
  if (hasLng) {
    if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      fields.push({
        field: "longitude",
        code: "INVALID_COORDINATES",
        message: "Longitude harus berupa angka valid antara -180 hingga 180.",
      });
    }
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    latitude: Math.round((latitude as number) * 1e7) / 1e7,
    longitude: Math.round((longitude as number) * 1e7) / 1e7,
  };
}

export function normalizeOutletMapsUrl(
  rawUrl: string | null | undefined,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly message: string } {
  if (rawUrl === null || rawUrl === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawUrl !== "string") {
    return { ok: false, message: "Tautan Google Maps harus berupa teks URL HTTPS." };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  let safeHref: string;
  try {
    safeHref = sanitizeExternalLink(trimmed).href;
  } catch (err) {
    if (err instanceof ExternalLinkValidationError) {
      if (err.code === "FORBIDDEN_HOST") {
        return {
          ok: false,
          message: "Tautan Google Maps tidak boleh mengarah ke localhost atau IP privat.",
        };
      }
      if (err.code === "EMBEDDED_CREDENTIALS") {
        return {
          ok: false,
          message: "Tautan Google Maps tidak boleh mengandung kredensial.",
        };
      }
      return {
        ok: false,
        message: "Tautan Google Maps harus menggunakan URL HTTPS publik yang valid.",
      };
    }
    return { ok: false, message: "Tautan Google Maps tidak valid." };
  }

  let parsed: URL;
  try {
    parsed = new URL(safeHref);
  } catch {
    return { ok: false, message: "Tautan Google Maps tidak valid." };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (/^(?:www\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host) && pathname === "/url") {
    return {
      ok: false,
      message: "Tautan pengalihan google.com/url tidak diizinkan. Gunakan tautan Google Maps langsung.",
    };
  }

  const isGoogleMapsHost =
    host === "maps.app.goo.gl" ||
    (host === "goo.gl" && (pathname === "/maps" || pathname.startsWith("/maps/"))) ||
    /^maps\.google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host) ||
    (/^(?:www\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host) &&
      (pathname === "/maps" || pathname.startsWith("/maps/")));

  if (!isGoogleMapsHost) {
    return {
      ok: false,
      message:
        "Tautan peta harus berasal dari Google Maps (contoh: https://www.google.com/maps/dir/?api=1&destination=...).",
    };
  }

  return { ok: true, value: safeHref };
}

export function validateOutletTimezone(
  rawTimezone: string | null | undefined,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  if (rawTimezone === null || rawTimezone === undefined || rawTimezone === "") {
    return { ok: true, value: DEFAULT_OUTLET_TIMEZONE };
  }
  if (typeof rawTimezone !== "string" || hasControlChars(rawTimezone, false)) {
    return { ok: false, message: "Zona waktu tidak valid." };
  }
  const trimmed = rawTimezone.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: DEFAULT_OUTLET_TIMEZONE };
  }
  if (trimmed.length > 64 || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(trimmed)) {
    return {
      ok: false,
      message: "Zona waktu harus berupa nama zona waktu IANA yang valid (contoh: Asia/Jakarta).",
    };
  }
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone: trimmed });
    return { ok: true, value: trimmed };
  } catch {
    return { ok: false, message: `Zona waktu "${trimmed}" tidak dikenali.` };
  }
}

export function validateOutletWeeklyHours(
  raw: unknown,
): OutletValidationResult<readonly OutletWeeklyHoursEntry[]> {
  if (raw === null || raw === undefined) {
    return { ok: true, data: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message: "Jam operasional mingguan harus berupa daftar jadwal harian.",
      fields: [{ field: "weeklyHours", code: "INVALID_WEEKLY_HOURS", message: "weeklyHours harus berupa array." }],
    };
  }
  if (raw.length > 7) {
    return {
      ok: false,
      message: "Jam operasional mingguan maksimal memuat 7 hari (Senin–Minggu).",
      fields: [{ field: "weeklyHours", code: "INVALID_WEEKLY_HOURS", message: "Maksimal 7 entri hari dalam seminggu." }],
    };
  }

  const seenDays = new Set<OutletWeekdayKey>();
  const normalized: OutletWeeklyHoursEntry[] = [];
  const issues: OutletValidationFieldIssue[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isPlainRecord(item)) {
      issues.push({
        field: `weeklyHours[${i}]`,
        code: "INVALID_WEEKLY_HOURS",
        message: "Setiap entri jadwal harian harus berupa objek.",
      });
      continue;
    }
    for (const k of Object.keys(item)) {
      if (k !== "day" && k !== "open" && k !== "close" && k !== "closed") {
        issues.push({
          field: `weeklyHours[${i}].${k}`,
          code: FORBIDDEN_SELECTOR_KEY_SET.has(k) ? "FORBIDDEN_TENANT_SELECTOR" : "UNKNOWN_FIELD",
          message: `Field tidak dikenal "${k}" pada jadwal harian.`,
        });
      }
    }

    const dayRaw = typeof item.day === "string" ? item.day.trim().toLowerCase() : "";
    if (!WEEKDAY_INDEX.has(dayRaw as OutletWeekdayKey)) {
      issues.push({
        field: `weeklyHours[${i}].day`,
        code: "INVALID_WEEKDAY",
        message: `Hari "${String(item.day ?? "")}" tidak valid. Gunakan monday..sunday.`,
      });
      continue;
    }
    const day = dayRaw as OutletWeekdayKey;
    if (seenDays.has(day)) {
      issues.push({
        field: `weeklyHours[${i}].day`,
        code: "DUPLICATE_WEEKDAY",
        message: `Hari ${OUTLET_WEEKDAY_LABELS_ID[day]} duplikat pada jadwal mingguan.`,
      });
      continue;
    }
    seenDays.add(day);

    const closed = Boolean(item.closed);
    if (closed) {
      normalized.push({ day, open: null, close: null, closed: true });
      continue;
    }

    const open = typeof item.open === "string" ? item.open.trim() : "";
    const close = typeof item.close === "string" ? item.close.trim() : "";
    if (!isValidOutletTimeHHMM(open)) {
      issues.push({
        field: `weeklyHours[${i}].open`,
        code: "INVALID_TIME_FORMAT",
        message: `Jam buka ${OUTLET_WEEKDAY_LABELS_ID[day]} harus berformat HH:MM (00:00–23:59).`,
      });
    }
    if (!isValidOutletTimeHHMM(close)) {
      issues.push({
        field: `weeklyHours[${i}].close`,
        code: "INVALID_TIME_FORMAT",
        message: `Jam tutup ${OUTLET_WEEKDAY_LABELS_ID[day]} harus berformat HH:MM (00:00–23:59).`,
      });
    }
    if (isValidOutletTimeHHMM(open) && isValidOutletTimeHHMM(close) && open >= close) {
      issues.push({
        field: `weeklyHours[${i}].close`,
        code: "INVALID_TIME_RANGE",
        message: `Jam tutup ${OUTLET_WEEKDAY_LABELS_ID[day]} harus lebih akhir dari jam buka.`,
      });
    }

    normalized.push({ day, open, close, closed: false });
  }

  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  normalized.sort((a, b) => (WEEKDAY_INDEX.get(a.day) ?? 0) - (WEEKDAY_INDEX.get(b.day) ?? 0));
  return { ok: true, data: normalized };
}

export function validateOutletHolidayHours(
  raw: unknown,
): OutletValidationResult<readonly OutletHolidayHoursEntry[]> {
  if (raw === null || raw === undefined) {
    return { ok: true, data: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message: "Jadwal hari libur harus berupa daftar.",
      fields: [{ field: "holidayHours", code: "INVALID_HOLIDAY_HOURS", message: "holidayHours harus berupa array." }],
    };
  }
  if (raw.length > MAX_OUTLET_HOLIDAY_ENTRIES) {
    return {
      ok: false,
      message: `Jadwal hari libur maksimal ${MAX_OUTLET_HOLIDAY_ENTRIES} tanggal per gerai.`,
      fields: [
        {
          field: "holidayHours",
          code: "TOO_MANY_HOLIDAY_ENTRIES",
          message: `Maksimal ${MAX_OUTLET_HOLIDAY_ENTRIES} entri hari libur.`,
        },
      ],
    };
  }

  const seenDates = new Set<string>();
  const normalized: OutletHolidayHoursEntry[] = [];
  const issues: OutletValidationFieldIssue[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isPlainRecord(item)) {
      issues.push({
        field: `holidayHours[${i}]`,
        code: "INVALID_HOLIDAY_HOURS",
        message: "Setiap entri hari libur harus berupa objek.",
      });
      continue;
    }
    for (const k of Object.keys(item)) {
      if (k !== "date" && k !== "label" && k !== "open" && k !== "close" && k !== "closed") {
        issues.push({
          field: `holidayHours[${i}].${k}`,
          code: FORBIDDEN_SELECTOR_KEY_SET.has(k) ? "FORBIDDEN_TENANT_SELECTOR" : "UNKNOWN_FIELD",
          message: `Field tidak dikenal "${k}" pada jadwal hari libur.`,
        });
      }
    }

    const dateStr = typeof item.date === "string" ? item.date.trim() : "";
    if (!isValidOutletCalendarDate(dateStr)) {
      issues.push({
        field: `holidayHours[${i}].date`,
        code: "INVALID_HOLIDAY_DATE",
        message: `Tanggal hari libur "${dateStr}" tidak valid. Gunakan format kalender YYYY-MM-DD.`,
      });
      continue;
    }
    if (seenDates.has(dateStr)) {
      issues.push({
        field: `holidayHours[${i}].date`,
        code: "DUPLICATE_HOLIDAY_DATE",
        message: `Tanggal hari libur ${dateStr} duplikat.`,
      });
      continue;
    }
    seenDates.add(dateStr);

    const rawLabel = typeof item.label === "string" ? item.label : "";
    if (hasControlChars(rawLabel, false)) {
      issues.push({
        field: `holidayHours[${i}].label`,
        code: "INVALID_HOLIDAY_LABEL",
        message: "Keterangan hari libur tidak boleh mengandung karakter kontrol.",
      });
      continue;
    }
    const label = collapseSingleLine(rawLabel);
    if (label.length < 1 || label.length > MAX_OUTLET_HOLIDAY_LABEL_LENGTH) {
      issues.push({
        field: `holidayHours[${i}].label`,
        code: "INVALID_HOLIDAY_LABEL",
        message: `Keterangan hari libur wajib diisi (1–${MAX_OUTLET_HOLIDAY_LABEL_LENGTH} karakter).`,
      });
      continue;
    }

    const closed = Boolean(item.closed);
    if (closed) {
      normalized.push({ date: dateStr, label, open: null, close: null, closed: true });
      continue;
    }

    const open = typeof item.open === "string" ? item.open.trim() : "";
    const close = typeof item.close === "string" ? item.close.trim() : "";
    if (!isValidOutletTimeHHMM(open)) {
      issues.push({
        field: `holidayHours[${i}].open`,
        code: "INVALID_TIME_FORMAT",
        message: `Jam buka libur (${label}) harus berformat HH:MM.`,
      });
    }
    if (!isValidOutletTimeHHMM(close)) {
      issues.push({
        field: `holidayHours[${i}].close`,
        code: "INVALID_TIME_FORMAT",
        message: `Jam tutup libur (${label}) harus berformat HH:MM.`,
      });
    }
    if (isValidOutletTimeHHMM(open) && isValidOutletTimeHHMM(close) && open >= close) {
      issues.push({
        field: `holidayHours[${i}].close`,
        code: "INVALID_TIME_RANGE",
        message: `Jam tutup libur (${label}) harus lebih akhir dari jam buka.`,
      });
    }

    normalized.push({ date: dateStr, label, open, close, closed: false });
  }

  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  normalized.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, data: normalized };
}

// ---------------------------------------------------------------------------
// Strict Payload Validators (Zero-Dependency Pure TS)
// ---------------------------------------------------------------------------

function checkAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): OutletValidationFieldIssue[] {
  const issues: OutletValidationFieldIssue[] = [];
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_SELECTOR_KEY_SET.has(key)) {
      issues.push({
        field: key,
        code: "FORBIDDEN_TENANT_SELECTOR",
        message: `Field "${key}" tidak diizinkan dalam permintaan tenant.`,
      });
    } else if (!allowedKeys.has(key)) {
      issues.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field tidak dikenal "${key}".`,
      });
    }
  }
  return issues;
}

function validateOptionalSingleLine(
  raw: unknown,
  field: string,
  maxLen: number,
  issues: OutletValidationFieldIssue[],
): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    issues.push({ field, code: "INVALID_OUTLET_FIELD", message: `Field "${field}" harus berupa teks.` });
    return null;
  }
  if (hasControlChars(raw, false)) {
    issues.push({
      field,
      code: "INVALID_OUTLET_FIELD",
      message: `Field "${field}" tidak boleh mengandung karakter kontrol.`,
    });
    return null;
  }
  const cleaned = collapseSingleLine(raw);
  if (cleaned.length > maxLen) {
    issues.push({
      field,
      code: "INVALID_OUTLET_FIELD",
      message: `Field "${field}" maksimal ${maxLen} karakter.`,
    });
    return null;
  }
  return cleaned.length > 0 ? cleaned : null;
}

function validateRequiredName(
  raw: unknown,
  issues: OutletValidationFieldIssue[],
): string {
  if (typeof raw !== "string" || hasControlChars(raw, false)) {
    issues.push({ field: "name", code: "INVALID_OUTLET_FIELD", message: "Nama gerai wajib diisi." });
    return "";
  }
  const cleaned = collapseSingleLine(raw);
  if (cleaned.length < 1 || cleaned.length > MAX_OUTLET_NAME_LENGTH) {
    issues.push({
      field: "name",
      code: "INVALID_OUTLET_FIELD",
      message: `Nama gerai wajib diisi (1–${MAX_OUTLET_NAME_LENGTH} karakter).`,
    });
    return "";
  }
  return cleaned;
}

function validateRequiredAddress(
  raw: unknown,
  issues: OutletValidationFieldIssue[],
): string {
  if (typeof raw !== "string" || hasControlChars(raw, true)) {
    issues.push({ field: "address", code: "INVALID_OUTLET_FIELD", message: "Alamat gerai wajib diisi." });
    return "";
  }
  const cleaned = normalizeMultiLineAddress(raw);
  if (cleaned.length < 1 || cleaned.length > MAX_OUTLET_ADDRESS_LENGTH) {
    issues.push({
      field: "address",
      code: "INVALID_OUTLET_FIELD",
      message: `Alamat gerai wajib diisi (1–${MAX_OUTLET_ADDRESS_LENGTH} karakter).`,
    });
    return "";
  }
  return cleaned;
}

function validatePostalCode(
  raw: unknown,
  issues: OutletValidationFieldIssue[],
): string | null {
  const cleaned = validateOptionalSingleLine(raw, "postalCode", MAX_OUTLET_POSTAL_CODE_LENGTH, issues);
  if (cleaned !== null && !POSTAL_CODE_PATTERN.test(cleaned)) {
    issues.push({
      field: "postalCode",
      code: "INVALID_OUTLET_FIELD",
      message: "Kode pos hanya boleh berisi 3–20 huruf, angka, spasi, atau tanda hubung.",
    });
    return null;
  }
  return cleaned;
}

export function validateOutletCreatePayload(
  raw: unknown,
): OutletValidationResult<NormalizedOutletCreateInput> {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      message: "Data gerai harus berupa objek JSON.",
      fields: [{ field: "body", code: "INVALID_OUTLET_PAYLOAD", message: "Expected JSON object." }],
    };
  }

  const issues: OutletValidationFieldIssue[] = checkAllowedKeys(raw, OUTLET_CREATE_ALLOWED_KEYS);
  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  const name = validateRequiredName(raw.name, issues);
  const address = validateRequiredAddress(raw.address, issues);
  const city = validateOptionalSingleLine(raw.city, "city", MAX_OUTLET_CITY_LENGTH, issues);
  const province = validateOptionalSingleLine(raw.province, "province", MAX_OUTLET_PROVINCE_LENGTH, issues);
  const postalCode = validatePostalCode(raw.postalCode, issues);

  if (raw.slug !== undefined && raw.slug !== null && typeof raw.slug !== "string") {
    issues.push({ field: "slug", code: "INVALID_SLUG", message: "Slug gerai harus berupa teks." });
  }
  const slugRes = normalizeOutletSlug(
    typeof raw.slug === "string" ? raw.slug : null,
    name,
  );
  if (!slugRes.ok) {
    issues.push({ field: "slug", code: "INVALID_SLUG", message: slugRes.message });
  }

  const phoneRes = normalizeOutletPhoneE164(raw.phone as string | null | undefined);
  if (!phoneRes.ok) {
    issues.push({ field: "phone", code: "INVALID_PHONE", message: phoneRes.message });
  }

  const rawWa = raw.whatsappE164 !== undefined ? raw.whatsappE164 : raw.whatsappNumber;
  if (
    raw.whatsappE164 !== undefined &&
    raw.whatsappNumber !== undefined &&
    raw.whatsappE164 !== raw.whatsappNumber
  ) {
    issues.push({
      field: "whatsappNumber",
      code: "CONFLICTING_WHATSAPP_FIELDS",
      message: "whatsappE164 dan whatsappNumber harus sama jika keduanya dikirim.",
    });
  }
  const waRes = normalizeOutletWhatsAppE164(rawWa as string | null | undefined);
  if (!waRes.ok) {
    issues.push({
      field: raw.whatsappE164 !== undefined ? "whatsappE164" : "whatsappNumber",
      code: "INVALID_WHATSAPP",
      message: waRes.message,
    });
  }

  const rawMaps = raw.mapsUrl !== undefined ? raw.mapsUrl : raw.directionsUrl;
  const mapsRes = normalizeOutletMapsUrl(rawMaps as string | null | undefined);
  if (!mapsRes.ok) {
    issues.push({
      field: raw.mapsUrl !== undefined ? "mapsUrl" : "directionsUrl",
      code: "INVALID_MAPS_URL",
      message: mapsRes.message,
    });
  }

  const coordsRes = validateOutletCoordinates(
    raw.latitude as number | null | undefined,
    raw.longitude as number | null | undefined,
  );
  if (!coordsRes.ok) {
    issues.push(...coordsRes.fields);
  }

  const weeklyRes = validateOutletWeeklyHours(raw.weeklyHours);
  if (!weeklyRes.ok) {
    issues.push(...weeklyRes.fields);
  }

  const holidayRes = validateOutletHolidayHours(raw.holidayHours);
  if (!holidayRes.ok) {
    issues.push(...holidayRes.fields);
  }

  const tzRes = validateOutletTimezone(raw.timezone as string | null | undefined);
  if (!tzRes.ok) {
    issues.push({ field: "timezone", code: "INVALID_TIMEZONE", message: tzRes.message });
  }

  let sortOrder: number | undefined;
  if (raw.sortOrder !== undefined) {
    if (
      typeof raw.sortOrder !== "number" ||
      !Number.isSafeInteger(raw.sortOrder) ||
      raw.sortOrder < 0 ||
      raw.sortOrder > MAX_OUTLET_SORT_ORDER
    ) {
      issues.push({
        field: "sortOrder",
        code: "INVALID_OUTLET_FIELD",
        message: `Urutan tampil harus bilangan bulat antara 0 hingga ${MAX_OUTLET_SORT_ORDER}.`,
      });
    } else {
      sortOrder = raw.sortOrder;
    }
  }

  let status: OutletStatus = "published";
  if (raw.status !== undefined) {
    if (raw.status === "draft" || raw.status === "published") {
      status = raw.status;
    } else {
      issues.push({
        field: "status",
        code: "INVALID_OUTLET_FIELD",
        message: 'Status gerai harus "draft" atau "published".',
      });
    }
  }

  if (raw.isPrimary !== undefined && typeof raw.isPrimary !== "boolean") {
    issues.push({ field: "isPrimary", code: "INVALID_OUTLET_FIELD", message: "isPrimary harus boolean." });
  }
  if (raw.active !== undefined && typeof raw.active !== "boolean") {
    issues.push({ field: "active", code: "INVALID_OUTLET_FIELD", message: "active harus boolean." });
  }

  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  return {
    ok: true,
    data: {
      name,
      slug: slugRes.ok ? slugRes.value : slugifyOutletName(name),
      address,
      city,
      province,
      postalCode,
      phone: phoneRes.ok ? phoneRes.value : null,
      whatsappE164: waRes.ok ? waRes.value : null,
      mapsUrl: mapsRes.ok ? mapsRes.value : null,
      latitude: coordsRes.ok ? coordsRes.latitude : null,
      longitude: coordsRes.ok ? coordsRes.longitude : null,
      weeklyHours: weeklyRes.ok ? weeklyRes.data : [],
      holidayHours: holidayRes.ok ? holidayRes.data : [],
      timezone: tzRes.ok ? tzRes.value : DEFAULT_OUTLET_TIMEZONE,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      isPrimary: raw.isPrimary === true,
      status,
      active: raw.active !== false,
    },
  };
}

export function validateOutletUpdatePayload(
  raw: unknown,
  existingCoords?: { readonly latitude: number | null; readonly longitude: number | null },
): OutletValidationResult<NormalizedOutletUpdateInput> {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      message: "Data pembaruan gerai harus berupa objek JSON.",
      fields: [{ field: "body", code: "INVALID_OUTLET_PAYLOAD", message: "Expected JSON object." }],
    };
  }

  const issues: OutletValidationFieldIssue[] = checkAllowedKeys(raw, OUTLET_UPDATE_ALLOWED_KEYS);
  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  let expectedVersion: number | undefined;
  const hasEv = hasOwn(raw, "expectedVersion") && raw.expectedVersion !== undefined;
  const hasVer = hasOwn(raw, "version") && raw.version !== undefined;
  if (hasEv && hasVer && raw.expectedVersion !== raw.version) {
    issues.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion dan version harus bernilai sama jika keduanya dikirim.",
    });
  } else if (hasEv || hasVer) {
    const candidate = hasEv ? raw.expectedVersion : raw.version;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      candidate > 2_147_483_647
    ) {
      issues.push({
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "expectedVersion harus berupa bilangan bulat non-negatif.",
      });
    } else {
      expectedVersion = candidate;
    }
  }

  const updateFields: Record<string, unknown> = {};

  if (hasOwn(raw, "name") && raw.name !== undefined) {
    updateFields.name = validateRequiredName(raw.name, issues);
  }
  if (hasOwn(raw, "slug")) {
    if (raw.slug !== null && typeof raw.slug !== "string") {
      issues.push({ field: "slug", code: "INVALID_SLUG", message: "Slug gerai harus berupa teks." });
    } else {
      const slugRes = normalizeOutletSlug(
        raw.slug as string | null,
        typeof updateFields.name === "string" ? updateFields.name : undefined,
      );
      if (!slugRes.ok) {
        issues.push({ field: "slug", code: "INVALID_SLUG", message: slugRes.message });
      } else {
        updateFields.slug = slugRes.value;
      }
    }
  }
  if (hasOwn(raw, "address") && raw.address !== undefined) {
    updateFields.address = validateRequiredAddress(raw.address, issues);
  }
  if (hasOwn(raw, "city")) {
    updateFields.city = validateOptionalSingleLine(raw.city, "city", MAX_OUTLET_CITY_LENGTH, issues);
  }
  if (hasOwn(raw, "province")) {
    updateFields.province = validateOptionalSingleLine(
      raw.province,
      "province",
      MAX_OUTLET_PROVINCE_LENGTH,
      issues,
    );
  }
  if (hasOwn(raw, "postalCode")) {
    updateFields.postalCode = validatePostalCode(raw.postalCode, issues);
  }
  if (hasOwn(raw, "phone")) {
    const phoneRes = normalizeOutletPhoneE164(raw.phone as string | null | undefined);
    if (!phoneRes.ok) {
      issues.push({ field: "phone", code: "INVALID_PHONE", message: phoneRes.message });
    } else {
      updateFields.phone = phoneRes.value;
    }
  }

  const hasWaE164 = hasOwn(raw, "whatsappE164");
  const hasWaNum = hasOwn(raw, "whatsappNumber");
  if (hasWaE164 && hasWaNum && raw.whatsappE164 !== raw.whatsappNumber) {
    issues.push({
      field: "whatsappNumber",
      code: "CONFLICTING_WHATSAPP_FIELDS",
      message: "whatsappE164 dan whatsappNumber harus sama jika keduanya dikirim.",
    });
  } else if (hasWaE164 || hasWaNum) {
    const waRes = normalizeOutletWhatsAppE164(
      (hasWaE164 ? raw.whatsappE164 : raw.whatsappNumber) as string | null | undefined,
    );
    if (!waRes.ok) {
      issues.push({
        field: hasWaE164 ? "whatsappE164" : "whatsappNumber",
        code: "INVALID_WHATSAPP",
        message: waRes.message,
      });
    } else {
      updateFields.whatsappE164 = waRes.value;
    }
  }

  const hasMapsUrl = hasOwn(raw, "mapsUrl");
  const hasDirectionsUrl = hasOwn(raw, "directionsUrl");
  if (hasMapsUrl || hasDirectionsUrl) {
    const mapsRes = normalizeOutletMapsUrl(
      (hasMapsUrl ? raw.mapsUrl : raw.directionsUrl) as string | null | undefined,
    );
    if (!mapsRes.ok) {
      issues.push({
        field: hasMapsUrl ? "mapsUrl" : "directionsUrl",
        code: "INVALID_MAPS_URL",
        message: mapsRes.message,
      });
    } else {
      updateFields.mapsUrl = mapsRes.value;
    }
  }

  const hasLat = hasOwn(raw, "latitude");
  const hasLng = hasOwn(raw, "longitude");
  if (hasLat || hasLng) {
    const effLat = hasLat
      ? (raw.latitude as number | null | undefined)
      : (existingCoords?.latitude ?? null);
    const effLng = hasLng
      ? (raw.longitude as number | null | undefined)
      : (existingCoords?.longitude ?? null);
    const coordsRes = validateOutletCoordinates(effLat, effLng);
    if (!coordsRes.ok) {
      issues.push(...coordsRes.fields);
    } else {
      updateFields.latitude = coordsRes.latitude;
      updateFields.longitude = coordsRes.longitude;
    }
  }

  if (hasOwn(raw, "weeklyHours")) {
    const weeklyRes = validateOutletWeeklyHours(raw.weeklyHours);
    if (!weeklyRes.ok) {
      issues.push(...weeklyRes.fields);
    } else {
      updateFields.weeklyHours = weeklyRes.data;
    }
  }

  if (hasOwn(raw, "holidayHours")) {
    const holidayRes = validateOutletHolidayHours(raw.holidayHours);
    if (!holidayRes.ok) {
      issues.push(...holidayRes.fields);
    } else {
      updateFields.holidayHours = holidayRes.data;
    }
  }

  if (hasOwn(raw, "timezone")) {
    const tzRes = validateOutletTimezone(raw.timezone as string | null | undefined);
    if (!tzRes.ok) {
      issues.push({ field: "timezone", code: "INVALID_TIMEZONE", message: tzRes.message });
    } else {
      updateFields.timezone = tzRes.value;
    }
  }

  if (hasOwn(raw, "sortOrder") && raw.sortOrder !== undefined) {
    if (
      typeof raw.sortOrder !== "number" ||
      !Number.isSafeInteger(raw.sortOrder) ||
      raw.sortOrder < 0 ||
      raw.sortOrder > MAX_OUTLET_SORT_ORDER
    ) {
      issues.push({
        field: "sortOrder",
        code: "INVALID_OUTLET_FIELD",
        message: `Urutan tampil harus bilangan bulat antara 0 hingga ${MAX_OUTLET_SORT_ORDER}.`,
      });
    } else {
      updateFields.sortOrder = raw.sortOrder;
    }
  }

  if (hasOwn(raw, "isPrimary") && raw.isPrimary !== undefined) {
    if (typeof raw.isPrimary !== "boolean") {
      issues.push({ field: "isPrimary", code: "INVALID_OUTLET_FIELD", message: "isPrimary harus boolean." });
    } else {
      updateFields.isPrimary = raw.isPrimary;
    }
  }

  if (hasOwn(raw, "status") && raw.status !== undefined) {
    if (raw.status !== "draft" && raw.status !== "published") {
      issues.push({
        field: "status",
        code: "INVALID_OUTLET_FIELD",
        message: 'Status gerai harus "draft" atau "published".',
      });
    } else {
      updateFields.status = raw.status;
    }
  }

  if (hasOwn(raw, "active") && raw.active !== undefined) {
    if (typeof raw.active !== "boolean") {
      issues.push({ field: "active", code: "INVALID_OUTLET_FIELD", message: "active harus boolean." });
    } else {
      updateFields.active = raw.active;
    }
  }

  if (Object.keys(updateFields).length === 0) {
    issues.push({
      field: "body",
      code: "EMPTY_OUTLET_PATCH",
      message: "Minimal satu field gerai harus diubah.",
    });
  }

  if (issues.length > 0) {
    return { ok: false, message: issues[0]!.message, fields: issues };
  }

  return {
    ok: true,
    data: {
      ...(updateFields as NormalizedOutletUpdateInput),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Public Formatting, Directions, Embed & Schema.org Helpers
// ---------------------------------------------------------------------------

export function formatOutletFullAddress(outlet: {
  readonly address: string;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
}): string {
  const parts: string[] = [];
  const street = outlet.address ? outlet.address.trim() : "";
  if (street) parts.push(street);
  const lowerStreet = street.toLowerCase();

  const city = outlet.city?.trim() ?? "";
  if (city && !lowerStreet.includes(city.toLowerCase())) parts.push(city);
  const province = outlet.province?.trim() ?? "";
  if (province && !lowerStreet.includes(province.toLowerCase())) parts.push(province);
  const postalCode = outlet.postalCode?.trim() ?? "";
  if (postalCode && !lowerStreet.includes(postalCode.toLowerCase())) parts.push(postalCode);

  return parts.join(", ");
}

export function buildOutletDirectionsUrl(outlet: {
  readonly mapsUrl?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
}): string | null {
  if (outlet.mapsUrl) {
    const safe = normalizeOutletMapsUrl(outlet.mapsUrl);
    if (safe.ok && safe.value) {
      try {
        const parsed = new URL(safe.value);
        if (parsed.pathname.toLowerCase().startsWith("/maps/dir")) {
          return safe.value;
        }
      } catch {
        // Fall through
      }
    }
  }

  const coords = validateOutletCoordinates(outlet.latitude, outlet.longitude);
  if (coords.ok && coords.latitude !== null && coords.longitude !== null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${coords.latitude},${coords.longitude}`;
  }

  if (outlet.mapsUrl) {
    const safe = normalizeOutletMapsUrl(outlet.mapsUrl);
    if (safe.ok && safe.value) {
      return safe.value;
    }
  }

  const fullAddress = formatOutletFullAddress({
    address: outlet.address ?? "",
    city: outlet.city,
    province: outlet.province,
    postalCode: outlet.postalCode,
  });
  if (fullAddress.length > 0) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress)}`;
  }

  return null;
}

/**
 * Strict allowlist validator for consent-gated Google Maps embed iframe URLs.
 * Allows ONLY:
 * - `https://maps.google.com/maps?...&output=embed` (exact `/maps` pathname + `output=embed`)
 * - `https://www.google.com/maps/embed` or `https://www.google.com/maps/embed/v1/...`
 * Rejects root-relative paths, non-HTTPS, credentials, custom ports, `..`, `/url`, `/maps/url`, and non-Google hosts.
 */
export function validateStrictGoogleMapsEmbedUrl(
  rawUrl: string | null | undefined,
): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || hasControlChars(trimmed, false) || trimmed.includes("..")) {
    return null;
  }
  const checked = normalizeOutletMapsUrl(trimmed);
  if (!checked.ok || !checked.value) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(checked.value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (pathname.includes("..") || pathname === "/url" || pathname === "/maps/url") {
    return null;
  }
  if (
    host === "maps.google.com" &&
    pathname === "/maps" &&
    parsed.searchParams.get("output") === "embed"
  ) {
    return checked.value;
  }
  if (
    host === "www.google.com" &&
    (pathname === "/maps/embed" || pathname.startsWith("/maps/embed/v1/"))
  ) {
    return checked.value;
  }
  return null;
}

export function buildOutletMapEmbedUrl(outlet: {
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}): string | null {
  const coords = validateOutletCoordinates(outlet.latitude, outlet.longitude);
  if (!coords.ok || coords.latitude === null || coords.longitude === null) {
    return null;
  }
  return `https://maps.google.com/maps?q=${coords.latitude},${coords.longitude}&z=15&output=embed`;
}

export function buildOutletWhatsAppHref(
  outlet: { readonly name: string; readonly whatsappE164?: string | null },
  businessName?: string | null,
): string | null {
  const wa = normalizeOutletWhatsAppE164(outlet.whatsappE164);
  if (!wa.ok || !wa.value) return null;
  const digits = wa.value.replace(/^\+/, "");
  const label = collapseSingleLine(outlet.name);
  const org = businessName ? collapseSingleLine(businessName) : "";
  const greeting = org
    ? `Halo ${org} (${label}), saya ingin menanyakan jam operasional dan lokasi gerai.`
    : `Halo ${label}, saya ingin menanyakan jam operasional dan lokasi gerai.`;
  return `${WA_ME_ORIGIN}/${digits}?text=${encodeURIComponent(greeting)}`;
}

export function formatWeeklyHoursSummary(
  weeklyHours: readonly OutletWeeklyHoursEntry[],
): string | null {
  if (!weeklyHours || weeklyHours.length === 0) return null;
  const sorted = [...weeklyHours].sort(
    (a, b) => (WEEKDAY_INDEX.get(a.day) ?? 0) - (WEEKDAY_INDEX.get(b.day) ?? 0),
  );
  const groups: { days: OutletWeekdayKey[]; schedule: string }[] = [];
  for (const entry of sorted) {
    const schedule = entry.closed
      ? "Tutup"
      : entry.open && entry.close
        ? `${entry.open}–${entry.close}`
        : "Tutup";
    const last = groups[groups.length - 1];
    if (
      last &&
      last.schedule === schedule &&
      (WEEKDAY_INDEX.get(entry.day) ?? -99) ===
        (WEEKDAY_INDEX.get(last.days[last.days.length - 1]!) ?? -100) + 1
    ) {
      last.days.push(entry.day);
    } else {
      groups.push({ days: [entry.day], schedule });
    }
  }
  return groups
    .map((g) => {
      const first = OUTLET_WEEKDAY_LABELS_ID[g.days[0]!];
      const last = OUTLET_WEEKDAY_LABELS_ID[g.days[g.days.length - 1]!];
      const dayLabel = g.days.length === 1 ? first : `${first}–${last}`;
      return `${dayLabel} ${g.schedule}`;
    })
    .join("; ");
}

export function formatHolidayHoursSummary(
  holidayHours: readonly OutletHolidayHoursEntry[],
): string | null {
  if (!holidayHours || holidayHours.length === 0) return null;
  return holidayHours
    .map((h) => {
      const hours = h.closed ? "Tutup" : h.open && h.close ? `${h.open}–${h.close}` : "Tutup";
      return `${h.date} ${h.label}: ${hours}`;
    })
    .join("; ");
}

export function mapOutletsToSchemaBranches(
  outlets: readonly OutletRecord[] | null | undefined,
): SchemaBranchInput[] {
  if (!outlets || outlets.length === 0) return [];

  return outlets
    .filter((o) => o.active && o.status === "published" && collapseSingleLine(o.name).length > 0)
    .slice(0, MAX_OUTLETS_PER_TENANT)
    .map((outlet) => {
      const weeklySpec: SchemaOpeningHoursSpecInput[] = outlet.weeklyHours.map((w) => ({
        day: w.day,
        open: w.open,
        close: w.close,
        closed: w.closed,
      }));
      const holidaySpec: SchemaSpecialOpeningHoursSpecInput[] = outlet.holidayHours.map((h) => ({
        date: h.date,
        label: h.label,
        open: h.open,
        close: h.close,
        closed: h.closed,
      }));

      const safeMapsRes = normalizeOutletMapsUrl(outlet.mapsUrl);
      const safeMapsUrl = safeMapsRes.ok ? safeMapsRes.value : null;
      const safeDirectionsUrl = buildOutletDirectionsUrl({
        mapsUrl: safeMapsUrl,
        latitude: outlet.latitude,
        longitude: outlet.longitude,
        address: outlet.address,
        city: outlet.city,
        province: outlet.province,
        postalCode: outlet.postalCode,
      });

      return {
        id: outlet.id,
        slug: outlet.slug,
        name: outlet.name,
        address: outlet.address,
        city: outlet.city,
        province: outlet.province,
        postalCode: outlet.postalCode,
        phone: outlet.phone,
        whatsappE164: outlet.whatsappE164,
        mapsUrl: safeMapsUrl,
        directionsUrl: safeDirectionsUrl,
        latitude: outlet.latitude,
        longitude: outlet.longitude,
        weekdayHours: outlet.weekdayHoursText,
        holidayHours: outlet.holidayHoursText,
        weeklyHours: weeklySpec,
        specialHolidayHours: holidaySpec,
        timezone: outlet.timezone,
        isPrimary: outlet.isPrimary,
        status: outlet.status,
        active: outlet.active,
      };
    });
}
