import { z } from "zod";
import type { TourAttributes } from "./index.ts";
import { validateIndonesianWhatsAppNumber, WA_ME_ORIGIN } from "../wa-dispatcher.ts";

/**
 * Travel & Umrah Itinerary & Departure Domain Module
 * (`packages/core/src/catalog/travel.ts`; TASK-020, REQ-028, DEC-038, DEC-042).
 *
 * Core Invariants:
 * - Zero new DB migrations: structured attributes serialize losslessly inside existing
 *   offering snapshot metadata envelopes while keeping `offerings.attributes_json` 100%
 *   compatible with `TourAttributesSchema`.
 * - Date-only calendar values (`YYYY-MM-DD`) are validated and formatted from pure
 *   `(year, month, day)` integer components — NEVER shifted via `new Date(str)` / local TZ.
 * - Agency Showcase -> WhatsApp / Inquiry ONLY (DEC-038): ZERO live seat inventory,
 *   ZERO seat counters, ZERO OTA checkout or flight/hotel ticketing fields.
 * - Umrah & Hajj Publish Gate (DEC-042, RG-9) — FAIL-CLOSED, SERVER-TRUSTED ONLY:
 *   - `general_tour` publishes freely without an `SK PPIU` / `SK PIHK` gate.
 *   - `umrah` and `hajj` packages are FAIL-CLOSED until ALL THREE hold:
 *     1. Valid `skPpiuNumber` (or `skPihkNumber` for `hajj`) is provided,
 *     2. Server-trusted `trustedGateState.operatorVerified === true`, AND
 *     3. Server-trusted `trustedGateState.umrahCounselApproved === true`.
 *   - Client-supplied `operatorVerified` / `umrahCounselApproved` flags are NEVER trusted.
 */

export const TRAVEL_PACKAGE_KINDS = ["general_tour", "umrah", "hajj"] as const;
export type TravelPackageKind = (typeof TRAVEL_PACKAGE_KINDS)[number];

export const MIN_TRAVEL_DURATION_DAYS = 1 as const;
export const MAX_TRAVEL_DURATION_DAYS = 60 as const;
export const MIN_TRAVEL_DURATION_NIGHTS = 0 as const;
export const MAX_TRAVEL_DURATION_NIGHTS = 60 as const;
export const MIN_TRAVEL_ITINERARY_DAYS = 1 as const;
export const MAX_TRAVEL_ITINERARY_DAYS = 30 as const;
export const MAX_TRAVEL_DEPARTURES = 24 as const;
export const MAX_TRAVEL_HOTELS = 10 as const;
export const MAX_TRAVEL_INCLUSIONS = 20 as const;
export const MAX_TRAVEL_EXCLUSIONS = 20 as const;

export const UMRAH_LICENSE_REQUIRED = "UMRAH_LICENSE_REQUIRED" as const;
export const UMRAH_OPERATOR_VERIFICATION_REQUIRED =
  "UMRAH_OPERATOR_VERIFICATION_REQUIRED" as const;
export const UMRAH_COUNSEL_GATE_REQUIRED = "UMRAH_COUNSEL_GATE_REQUIRED" as const;

export const UNTRUSTED_TRAVEL_GATE_FIELDS = [
  "operatorVerified",
  "operatorVerifiedAt",
  "umrahCounselApproved",
] as const;

export type TravelPublishGateDenialCode =
  | typeof UMRAH_LICENSE_REQUIRED
  | typeof UMRAH_OPERATOR_VERIFICATION_REQUIRED
  | typeof UMRAH_COUNSEL_GATE_REQUIRED;

export const TRAVEL_PACKAGE_KIND_LABELS: Readonly<Record<TravelPackageKind, string>> = {
  general_tour: "Tur Umum",
  umrah: "Paket Umrah (PPIU)",
  hajj: "Paket Haji Khusus (PIHK)",
};

export const INDONESIAN_MONTH_NAMES = [
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

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLACEHOLDER_LICENSE_VALUES = new Set([
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "tbd",
  "pending",
  "belum ada",
  "tidak ada",
  "0000",
]);

// ---------------------------------------------------------------------------
// Timezone-Invariant Calendar Date-Only Helpers
// ---------------------------------------------------------------------------

export interface DateOnlyParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInGregorianMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isGregorianLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Strictly parses a calendar-valid ISO date-only string (`YYYY-MM-DD`) into
 * integer `(year, month, day)` components WITHOUT calling `new Date()`.
 * Rejects impossible calendar dates such as `2026-02-29`, `2026-02-30`, `2026-04-31`,
 * timestamps with `T...Z`, or whitespace/non-ASCII digits.
 */
export function parseCalendarDateOnly(raw: unknown): DateOnlyParts | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = DATE_ONLY_PATTERN.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isSafeInteger(year) ||
    year < 1900 ||
    year > 2199 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInGregorianMonth(year, month)
  ) {
    return null;
  }
  return { year, month, day };
}

export function isValidTravelDateOnly(raw: unknown): raw is string {
  return parseCalendarDateOnly(raw) !== null;
}

/**
 * Compares two validated `YYYY-MM-DD` date-only strings purely by calendar components.
 */
export function compareDateOnly(a: string, b: string): -1 | 0 | 1 {
  const pa = parseCalendarDateOnly(a);
  const pb = parseCalendarDateOnly(b);
  if (!pa || !pb) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (pa.year !== pb.year) return pa.year < pb.year ? -1 : 1;
  if (pa.month !== pb.month) return pa.month < pb.month ? -1 : 1;
  if (pa.day !== pb.day) return pa.day < pb.day ? -1 : 1;
  return 0;
}

/**
 * Formats a calendar-valid `YYYY-MM-DD` date-only string into Indonesian display format
 * (e.g. `"2026-12-15"` -> `"15 Desember 2026"`) purely from `(year, month, day)` integers.
 *
 * Guaranteed identical across `UTC`, `Asia/Jakarta`, `America/Los_Angeles`,
 * `America/New_York`, and `Pacific/Auckland` — ZERO off-by-one timezone shifts.
 */
export function formatTravelDateOnlyIndonesian(isoDate: string): string {
  const parts = parseCalendarDateOnly(isoDate);
  if (!parts) return isoDate;
  const monthName = INDONESIAN_MONTH_NAMES[parts.month - 1];
  if (!monthName) return isoDate;
  return `${parts.day} ${monthName} ${parts.year}`;
}

/**
 * Formats an optional departure/return date-only pair in Indonesian without timezone conversion.
 */
export function formatTravelDateRangeIndonesian(
  departureDate: string,
  returnDate?: string | null,
): string {
  const dep = parseCalendarDateOnly(departureDate);
  if (!dep) return departureDate;
  if (!returnDate) {
    return formatTravelDateOnlyIndonesian(departureDate);
  }
  const ret = parseCalendarDateOnly(returnDate);
  if (!ret || compareDateOnly(returnDate, departureDate) <= 0) {
    return formatTravelDateOnlyIndonesian(departureDate);
  }
  const depMonth = INDONESIAN_MONTH_NAMES[dep.month - 1] ?? "";
  const retMonth = INDONESIAN_MONTH_NAMES[ret.month - 1] ?? "";
  if (dep.year === ret.year && dep.month === ret.month) {
    return `${dep.day}–${ret.day} ${depMonth} ${dep.year}`;
  }
  if (dep.year === ret.year) {
    return `${dep.day} ${depMonth} – ${ret.day} ${retMonth} ${dep.year}`;
  }
  return `${dep.day} ${depMonth} ${dep.year} – ${ret.day} ${retMonth} ${ret.year}`;
}

export function formatTravelDurationLabel(
  durationDays?: number | null,
  durationNights?: number | null,
): string | null {
  if (
    typeof durationDays !== "number" ||
    !Number.isSafeInteger(durationDays) ||
    durationDays < 1
  ) {
    return null;
  }
  if (
    typeof durationNights === "number" &&
    Number.isSafeInteger(durationNights) &&
    durationNights >= 0
  ) {
    return `${durationDays} Hari / ${durationNights} Malam`;
  }
  return `${durationDays} Hari`;
}

// ---------------------------------------------------------------------------
// License Sanity Check (`SK PPIU` / `SK PIHK`) & Untrusted Gate-Field Stripping
// ---------------------------------------------------------------------------

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Removes server-owned DEC-042 verification flags (`operatorVerified`, `operatorVerifiedAt`,
 * `umrahCounselApproved`) from any untrusted client payload before validation or persistence.
 */
export function stripUntrustedTravelGateFields<T extends Record<string, unknown>>(
  raw: T,
): Omit<T, (typeof UNTRUSTED_TRAVEL_GATE_FIELDS)[number]> {
  const cleaned: Record<string, unknown> = {};
  const blocked = new Set<string>(UNTRUSTED_TRAVEL_GATE_FIELDS);
  for (const [key, value] of Object.entries(raw)) {
    if (blocked.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned as Omit<T, (typeof UNTRUSTED_TRAVEL_GATE_FIELDS)[number]>;
}

/**
 * Validates that an `SK PPIU` / `SK PIHK` Kemenag license number is non-empty,
 * free of control characters, not a placeholder token, and contains at least
 * 4 alphanumeric characters (including at least 1 digit).
 */
export function isValidReligiousTravelLicenseNumber(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 120 || hasControlChars(trimmed)) {
    return false;
  }
  if (PLACEHOLDER_LICENSE_VALUES.has(trimmed.toLowerCase())) {
    return false;
  }
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, "");
  return alnum.length >= 4 && /\d/.test(alnum);
}

// ---------------------------------------------------------------------------
// Strict Travel & Umrah Schemas (Zod `.strict()`)
// ---------------------------------------------------------------------------

export const TravelPackageKindSchema = z.enum(TRAVEL_PACKAGE_KINDS);

export const TravelDateOnlySchema = z
  .string()
  .trim()
  .refine((val) => isValidTravelDateOnly(val), {
    message: "Tanggal harus berformat kalender valid YYYY-MM-DD (tanpa waktu/zona waktu).",
  });

export const TravelHotelSchema = z
  .object({
    name: z.string().trim().min(1, "Nama hotel wajib diisi.").max(160),
    city: z.string().trim().min(1).max(80).optional(),
    starClass: z.number().int().min(1).max(5).optional(),
    distanceNote: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const TravelItineraryDaySchema = z
  .object({
    dayNumber: z
      .number()
      .int()
      .min(MIN_TRAVEL_ITINERARY_DAYS, "Nomor hari minimal 1.")
      .max(MAX_TRAVEL_ITINERARY_DAYS, "Maksimal 30 hari rencana perjalanan."),
    title: z.string().trim().min(1, "Judul hari perjalanan wajib diisi.").max(160),
    summary: z.string().trim().min(1, "Ringkasan kegiatan harian wajib diisi.").max(1000),
    city: z.string().trim().min(1).max(80).optional(),
    meals: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

/**
 * Date-only departure schedule schema (`REQ-028`, `DEC-038`).
 * Explicitly forbids live seat inventory, seat counters, and OTA checkout fields via `.strict()`.
 */
export const TravelDepartureSchema = z
  .object({
    departureDate: TravelDateOnlySchema,
    returnDate: TravelDateOnlySchema.optional(),
    departureCity: z.string().trim().min(1).max(120).optional(),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.returnDate && compareDateOnly(val.returnDate, val.departureDate) < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["returnDate"],
        message: "Tanggal pulang tidak boleh lebih awal dari tanggal keberangkatan.",
      });
    }
  });

/**
 * Strict authorable schema for Travel & Umrah offering attributes.
 * Server-owned gate flags (`operatorVerified`, `umrahCounselApproved`) are NOT authorable
 * fields and are rejected if supplied raw (use `stripUntrustedTravelGateFields` at API ingress).
 */
export const TravelPackageAttributesSchema = z
  .object({
    packageKind: TravelPackageKindSchema.default("general_tour"),
    destination: z.string().trim().min(1).max(160).optional(),
    durationDays: z
      .number()
      .int()
      .min(MIN_TRAVEL_DURATION_DAYS, "Durasi minimal 1 hari.")
      .max(MAX_TRAVEL_DURATION_DAYS, "Durasi maksimal 60 hari."),
    durationNights: z
      .number()
      .int()
      .min(MIN_TRAVEL_DURATION_NIGHTS, "Durasi malam minimal 0.")
      .max(MAX_TRAVEL_DURATION_NIGHTS, "Durasi malam maksimal 60 malam."),
    departureCity: z.string().trim().min(1).max(120).optional(),
    airline: z.string().trim().min(1).max(120).optional(),
    transport: z.string().trim().min(1).max(160).optional(),
    accommodation: z.string().trim().min(1).max(200).optional(),
    hotels: z.array(TravelHotelSchema).max(MAX_TRAVEL_HOTELS).optional(),
    inclusions: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_TRAVEL_INCLUSIONS)
      .optional(),
    exclusions: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_TRAVEL_EXCLUSIONS)
      .optional(),
    travelInsurance: z.string().trim().min(1).max(200).optional(),
    officialVisa: z.string().trim().min(1).max(200).optional(),
    itinerary: z
      .array(TravelItineraryDaySchema)
      .min(MIN_TRAVEL_ITINERARY_DAYS, "Minimal 1 hari rencana perjalanan wajib diisi.")
      .max(MAX_TRAVEL_ITINERARY_DAYS, "Maksimal 30 hari rencana perjalanan."),
    departures: z
      .array(TravelDepartureSchema)
      .max(MAX_TRAVEL_DEPARTURES, "Maksimal 24 jadwal keberangkatan.")
      .optional(),
    skPpiuNumber: z.string().trim().min(1).max(120).optional(),
    skPihkNumber: z.string().trim().min(1).max(120).optional(),
    minPax: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.durationNights > val.durationDays) {
      ctx.addIssue({
        code: "custom",
        path: ["durationNights"],
        message: "Jumlah malam tidak boleh melebihi jumlah hari perjalanan.",
      });
    }

    const seenDays = new Set<number>();
    for (let i = 0; i < val.itinerary.length; i += 1) {
      const dayItem = val.itinerary[i];
      if (!dayItem) continue;
      if (seenDays.has(dayItem.dayNumber)) {
        ctx.addIssue({
          code: "custom",
          path: ["itinerary", i, "dayNumber"],
          message: `Nomor hari ke-${dayItem.dayNumber} duplikat pada rencana perjalanan.`,
        });
      }
      seenDays.add(dayItem.dayNumber);
      if (dayItem.dayNumber > val.durationDays) {
        ctx.addIssue({
          code: "custom",
          path: ["itinerary", i, "dayNumber"],
          message: `Hari ke-${dayItem.dayNumber} melebihi total durasi paket (${val.durationDays} hari).`,
        });
      }
    }

    if (
      val.skPpiuNumber !== undefined &&
      !isValidReligiousTravelLicenseNumber(val.skPpiuNumber)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["skPpiuNumber"],
        message: "Format nomor SK PPIU Kemenag tidak valid (minimal 4 karakter alfanumerik dengan angka).",
      });
    }

    if (
      val.skPihkNumber !== undefined &&
      !isValidReligiousTravelLicenseNumber(val.skPihkNumber)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["skPihkNumber"],
        message: "Format nomor SK PIHK Kemenag tidak valid (minimal 4 karakter alfanumerik dengan angka).",
      });
    }
  });

export type TravelHotel = z.infer<typeof TravelHotelSchema>;
export type TravelItineraryDay = z.infer<typeof TravelItineraryDaySchema>;
export type TravelDeparture = z.infer<typeof TravelDepartureSchema>;
export type TravelPackageAttributes = z.infer<typeof TravelPackageAttributesSchema>;

// ---------------------------------------------------------------------------
// Structured Validation & Gate Errors
// ---------------------------------------------------------------------------

export interface TravelValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class TravelValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly TravelValidationField[];

  constructor(message: string, fields: readonly TravelValidationField[] = []) {
    super(message);
    this.name = "TravelValidationError";
    this.fields = fields;
  }
}

export interface TravelPublishGateDenial {
  readonly code: TravelPublishGateDenialCode;
  readonly field: string;
  readonly message: string;
}

export class TravelPublishGateError extends Error {
  readonly status = 422 as const;
  readonly code = "UMRAH_PUBLISH_BLOCKED" as const;
  readonly reasons: readonly TravelPublishGateDenial[];

  constructor(message: string, reasons: readonly TravelPublishGateDenial[]) {
    super(message);
    this.name = "TravelPublishGateError";
    this.reasons = reasons;
  }
}

/**
 * Pure strict validator for Travel & Umrah offering attributes.
 * Returns normalized attributes with itinerary sorted by `dayNumber` and departures
 * sorted ascending by `departureDate`.
 */
export function validateTravelPackageAttributes(raw: unknown): TravelPackageAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TravelValidationError("Atribut paket perjalanan harus berupa objek JSON.", [
      {
        field: "attributes",
        code: "INVALID_TRAVEL_ATTRIBUTES",
        message: "Atribut paket perjalanan harus berupa objek JSON.",
      },
    ]);
  }

  const parsed = TravelPackageAttributesSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: TravelValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "attributes",
      code:
        issue.code === "unrecognized_keys"
          ? "UNKNOWN_FIELD"
          : "INVALID_TRAVEL_ATTRIBUTES",
      message: issue.message,
    }));
    throw new TravelValidationError(
      fields[0]?.message ?? "Data paket perjalanan tidak valid.",
      fields,
    );
  }

  const sortedItinerary = [...parsed.data.itinerary].sort(
    (a, b) => a.dayNumber - b.dayNumber,
  );
  const sortedDepartures = parsed.data.departures
    ? [...parsed.data.departures].sort((a, b) =>
        compareDateOnly(a.departureDate, b.departureDate),
      )
    : undefined;

  return {
    ...parsed.data,
    itinerary: sortedItinerary,
    ...(sortedDepartures !== undefined ? { departures: sortedDepartures } : {}),
  };
}

// ---------------------------------------------------------------------------
// DEC-042 Umrah & Hajj Publish Gate (Fail-Closed, Server-Trusted State ONLY)
// ---------------------------------------------------------------------------

export interface TravelPublishGateInput {
  readonly packageKind?: TravelPackageKind | null;
  readonly skPpiuNumber?: string | null;
  readonly skPihkNumber?: string | null;
  readonly ppiuNumber?: string | null;
  readonly umrahLicense?: string | null;
}

/**
 * Authoritative server-resolved compliance state for DEC-042.
 * Both `operatorVerified` and `umrahCounselApproved` default strictly to `false` (fail-closed)
 * and are NEVER read from untrusted tenant/client request bodies.
 */
export interface TrustedTravelGateState {
  readonly operatorVerified?: boolean;
  readonly umrahCounselApproved?: boolean;
  /** Optional `SK PPIU` stored on the tenant's Business Profile. */
  readonly businessProfileSkPpiu?: string | null;
  /** Optional `SK PIHK` stored on the tenant's Business Profile. */
  readonly businessProfileSkPihk?: string | null;
}

/** Backward-compatible type alias for `TrustedTravelGateState`. */
export type TravelPublishGateOptions = TrustedTravelGateState;

export interface TravelPublishGateResult {
  readonly allowed: boolean;
  readonly packageKind: TravelPackageKind;
  readonly requiresReligiousTravelGate: boolean;
  readonly verifiedLicenseKind: "SK PPIU" | "SK PIHK" | null;
  readonly verifiedLicenseNumber: string | null;
  readonly showVerifiedBadge: boolean;
  readonly reasons: readonly TravelPublishGateDenial[];
}

/**
 * Evaluates DEC-042 publication eligibility for travel/Umrah/Hajj offerings:
 * - `general_tour`: always allowed (not subject to PPIU/PIHK gate).
 * - `umrah` / `hajj`: FAIL-CLOSED unless ALL THREE hold:
 *   1. Valid `SK PPIU` (for `umrah`) or `SK PIHK` (for `hajj`) number is present,
 *   2. Server-trusted `trustedGateState.operatorVerified === true`, AND
 *   3. Server-trusted `trustedGateState.umrahCounselApproved === true`.
 *
 * Never trusts client-supplied flags on `pkg`.
 */
export function canPublishTravelPackage(
  pkg: TravelPublishGateInput,
  trustedGateState: TrustedTravelGateState = {},
): TravelPublishGateResult {
  const packageKind: TravelPackageKind =
    pkg.packageKind === "umrah" || pkg.packageKind === "hajj"
      ? pkg.packageKind
      : "general_tour";

  if (packageKind === "general_tour") {
    return {
      allowed: true,
      packageKind,
      requiresReligiousTravelGate: false,
      verifiedLicenseKind: null,
      verifiedLicenseNumber: null,
      showVerifiedBadge: false,
      reasons: [],
    };
  }

  const reasons: TravelPublishGateDenial[] = [];
  const isHajj = packageKind === "hajj";
  const licenseKind = isHajj ? "SK PIHK" : "SK PPIU";
  const licenseField = isHajj ? "skPihkNumber" : "skPpiuNumber";

  const candidateLicense = isHajj
    ? (pkg.skPihkNumber ?? trustedGateState.businessProfileSkPihk ?? null)
    : (pkg.skPpiuNumber ??
        pkg.ppiuNumber ??
        pkg.umrahLicense ??
        trustedGateState.businessProfileSkPpiu ??
        null);

  const hasValidLicense = isValidReligiousTravelLicenseNumber(candidateLicense);
  if (!hasValidLicense) {
    reasons.push({
      code: UMRAH_LICENSE_REQUIRED,
      field: licenseField,
      message: isHajj
        ? "Paket Haji Khusus wajib mencantumkan nomor izin resmi SK PIHK Kemenag yang valid sebelum dipublikasikan (UU 8/2019, DEC-042)."
        : "Paket Umrah wajib mencantumkan nomor izin resmi SK PPIU Kemenag yang valid sebelum dipublikasikan (UU 8/2019, DEC-042).",
    });
  }

  // Strictly server-trusted — NEVER read from untrusted `pkg`!
  const isOperatorVerified = trustedGateState.operatorVerified === true;
  if (!isOperatorVerified) {
    reasons.push({
      code: UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      field: "operatorVerified",
      message: `Izin ${licenseKind} harus diperiksa dan ditandai terverifikasi oleh operator PunyaSitus sebelum paket dapat dipublikasikan (DEC-042).`,
    });
  }

  // Strictly server-trusted — NEVER read from untrusted `pkg`!
  const isCounselApproved = trustedGateState.umrahCounselApproved === true;
  if (!isCounselApproved) {
    reasons.push({
      code: UMRAH_COUNSEL_GATE_REQUIRED,
      field: "umrahCounselApproved",
      message:
        "Redaksi publikasi paket Umrah/Haji ditahan sampai tinjauan hukum (counsel review) produksi disetujui sesuai DEC-042.",
    });
  }

  const allowed = reasons.length === 0;
  return {
    allowed,
    packageKind,
    requiresReligiousTravelGate: true,
    verifiedLicenseKind: allowed && hasValidLicense ? licenseKind : null,
    verifiedLicenseNumber: allowed && hasValidLicense ? candidateLicense.trim() : null,
    showVerifiedBadge: allowed && hasValidLicense && isOperatorVerified && isCounselApproved,
    reasons,
  };
}

export function assertCanPublishTravelPackage(
  pkg: TravelPublishGateInput,
  trustedGateState: TrustedTravelGateState = {},
): TravelPublishGateResult {
  const result = canPublishTravelPackage(pkg, trustedGateState);
  if (!result.allowed) {
    throw new TravelPublishGateError(
      result.reasons[0]?.message ??
        "Publikasi paket Umrah/Haji ditolak oleh gerbang verifikasi SK PPIU/PIHK (DEC-042).",
      result.reasons,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lossless Snapshot Envelope Helpers & Clean TourAttributes Projection
// ---------------------------------------------------------------------------

export const TRAVEL_SNAPSHOT_METADATA_KEY = "travelPackageV1" as const;

/**
 * Extracts a validated, client-flag-stripped `TravelPackageAttributes` object from
 * either a persisted `draft_snapshot_json` (`_draftMetadata.travelPackageV1`) or a
 * frozen `published_snapshot_json` (`travelPackageV1`) envelope string.
 */
export function extractTravelPackageFromSnapshotJson(
  rawJson: string | null | undefined,
): TravelPackageAttributes | null {
  if (!rawJson || !rawJson.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  let candidate: unknown = null;
  if (
    obj[TRAVEL_SNAPSHOT_METADATA_KEY] &&
    typeof obj[TRAVEL_SNAPSHOT_METADATA_KEY] === "object"
  ) {
    candidate = obj[TRAVEL_SNAPSHOT_METADATA_KEY];
  } else if (
    obj._draftMetadata &&
    typeof obj._draftMetadata === "object" &&
    !Array.isArray(obj._draftMetadata)
  ) {
    const meta = obj._draftMetadata as Record<string, unknown>;
    if (
      meta[TRAVEL_SNAPSHOT_METADATA_KEY] &&
      typeof meta[TRAVEL_SNAPSHOT_METADATA_KEY] === "object"
    ) {
      candidate = meta[TRAVEL_SNAPSHOT_METADATA_KEY];
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    const stripped = stripUntrustedTravelGateFields(candidate as Record<string, unknown>);
    return validateTravelPackageAttributes(stripped);
  } catch {
    return null;
  }
}

/**
 * Attaches the lossless `travelPackageV1` object into an existing `draft_snapshot_json`
 * string under `_draftMetadata.travelPackageV1` without altering `data` or `writeToken`.
 */
export function attachTravelPackageToDraftSnapshotJson(
  rawDraftSnapshotJson: string | null | undefined,
  travel: TravelPackageAttributes,
): string {
  const cleanTravel = validateTravelPackageAttributes(
    stripUntrustedTravelGateFields(travel as unknown as Record<string, unknown>),
  );
  let base: Record<string, unknown> = {};
  if (rawDraftSnapshotJson && rawDraftSnapshotJson.trim()) {
    try {
      const parsed = JSON.parse(rawDraftSnapshotJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      base = {};
    }
  }
  const existingMeta =
    base._draftMetadata &&
    typeof base._draftMetadata === "object" &&
    !Array.isArray(base._draftMetadata)
      ? { ...(base._draftMetadata as Record<string, unknown>) }
      : {};
  existingMeta[TRAVEL_SNAPSHOT_METADATA_KEY] = cleanTravel;
  base._draftMetadata = existingMeta;
  return JSON.stringify(base);
}

/**
 * Attaches the frozen lossless `travelPackageV1` object onto the outer envelope of
 * `published_snapshot_json` without mutating `envelope.data` (which remains strictly
 * valid under `OfferingSnapshotSchema`).
 */
export function attachTravelPackageToPublishedSnapshotJson(
  rawPublishedSnapshotJson: string | null | undefined,
  travel: TravelPackageAttributes,
): string | null {
  if (!rawPublishedSnapshotJson || !rawPublishedSnapshotJson.trim()) return null;
  const cleanTravel = validateTravelPackageAttributes(
    stripUntrustedTravelGateFields(travel as unknown as Record<string, unknown>),
  );
  try {
    const parsed = JSON.parse(rawPublishedSnapshotJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      [TRAVEL_SNAPSHOT_METADATA_KEY]: cleanTravel,
    };
    return JSON.stringify(envelope);
  } catch {
    return null;
  }
}

/**
 * Projects structured `TravelPackageAttributes` into the strict `TourAttributes`
 * shape accepted by `packages/core/src/catalog/index.ts` & `packages/db/src/catalog/index.ts`.
 *
 * Non-mutating & idempotent: keeps `itinerary[].description` strictly equal to `day.summary`
 * and `departures[].note` strictly equal to `dep.label` (zero repeated string suffixes,
 * zero `seatsAvailable` / OTA fields). Full structured fields are preserved losslessly in
 * the snapshot envelope (`travelPackageV1`).
 */
export function toCatalogTourAttributes(
  pkg: TravelPackageAttributes,
  trustedGateState: TrustedTravelGateState = {},
): TourAttributes {
  const gate = canPublishTravelPackage(pkg, trustedGateState);

  const hotelSummary =
    pkg.hotels && pkg.hotels.length > 0
      ? pkg.hotels
          .map((h) => {
            const parts = [h.name];
            if (h.city) parts.push(`(${h.city})`);
            if (h.starClass) parts.push(`★${h.starClass}`);
            return parts.join(" ");
          })
          .join("; ")
          .slice(0, 160)
      : pkg.accommodation?.slice(0, 160);

  const airlineSummary = (pkg.airline ?? pkg.transport)?.slice(0, 120);

  const mappedItinerary = pkg.itinerary.map((day) => ({
    day: day.dayNumber,
    title: day.title,
    description: day.summary.slice(0, 1000),
  }));

  const mappedDepartures = pkg.departures?.map((dep) => ({
    departureDate: dep.departureDate,
    status: "open" as const,
    ...(dep.label ? { note: dep.label.slice(0, 160) } : {}),
  }));

  const out: TourAttributes = {
    durationDays: pkg.durationDays,
    durationNights: pkg.durationNights,
    ...(pkg.destination ? { destination: pkg.destination } : {}),
    ...(pkg.departureCity ? { departureCity: pkg.departureCity } : {}),
    ...(airlineSummary ? { airline: airlineSummary } : {}),
    ...(hotelSummary ? { hotel: hotelSummary } : {}),
    ...(pkg.inclusions && pkg.inclusions.length > 0 ? { inclusions: [...pkg.inclusions] } : {}),
    ...(pkg.exclusions && pkg.exclusions.length > 0 ? { exclusions: [...pkg.exclusions] } : {}),
    ...(mappedItinerary.length > 0 ? { itinerary: mappedItinerary } : {}),
    ...(mappedDepartures && mappedDepartures.length > 0
      ? {
          departures: mappedDepartures,
          departureDates: mappedDepartures.map((d) => d.departureDate),
        }
      : {}),
    ...(gate.verifiedLicenseKind === "SK PPIU" && gate.verifiedLicenseNumber
      ? { ppiuNumber: gate.verifiedLicenseNumber }
      : {}),
    ...(gate.verifiedLicenseKind === "SK PIHK" && gate.verifiedLicenseNumber
      ? { umrahLicense: gate.verifiedLicenseNumber }
      : {}),
    ...(pkg.minPax !== undefined ? { minPax: pkg.minPax } : {}),
  };

  return out;
}

// ---------------------------------------------------------------------------
// Public Display Normalization (Accepts both TravelPackageAttributes & TourAttributes)
// ---------------------------------------------------------------------------

export interface NormalizedTravelDisplayModel {
  readonly packageKind: TravelPackageKind;
  readonly packageKindLabel: string;
  readonly destination: string | null;
  readonly durationDays: number | null;
  readonly durationNights: number | null;
  readonly durationLabel: string | null;
  readonly departureCity: string | null;
  readonly airline: string | null;
  readonly transport: string | null;
  readonly accommodation: string | null;
  readonly hotels: readonly TravelHotel[];
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly travelInsurance: string | null;
  readonly officialVisa: string | null;
  readonly itinerary: readonly TravelItineraryDay[];
  readonly departures: readonly TravelDeparture[];
  readonly minPax: number | null;
  readonly verifiedLicenseKind: "SK PPIU" | "SK PIHK" | null;
  readonly verifiedLicenseNumber: string | null;
  readonly showVerifiedBadge: boolean;
}

function cleanOptionalText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;
  return trimmed.slice(0, maxLen);
}

/**
 * Normalizes either a full `TravelPackageAttributes` object or a frozen legacy `TourAttributes`
 * snapshot into a safe, timezone-invariant, zero-inventory public display model for
 * `SectionTravelItinerary.astro` and `/tour/[slug]`.
 *
 * `showVerifiedBadge` is `true` ONLY when server-trusted `trustedGateState` explicitly
 * confirms both `operatorVerified === true` and `umrahCounselApproved === true`.
 */
export function normalizeTravelDisplayModel(
  raw: Record<string, unknown> | TravelPackageAttributes | TourAttributes | null | undefined,
  trustedGateState: TrustedTravelGateState = {},
): NormalizedTravelDisplayModel {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const packageKind: TravelPackageKind =
    src.packageKind === "umrah" || src.packageKind === "hajj"
      ? src.packageKind
      : "general_tour";

  const durationDays =
    typeof src.durationDays === "number" &&
    Number.isSafeInteger(src.durationDays) &&
    src.durationDays >= 1 &&
    src.durationDays <= 90
      ? src.durationDays
      : null;

  const durationNights =
    typeof src.durationNights === "number" &&
    Number.isSafeInteger(src.durationNights) &&
    src.durationNights >= 0 &&
    src.durationNights <= 90
      ? src.durationNights
      : null;

  const hotels: TravelHotel[] = [];
  if (Array.isArray(src.hotels)) {
    for (const item of src.hotels.slice(0, MAX_TRAVEL_HOTELS)) {
      const parsed = TravelHotelSchema.safeParse(item);
      if (parsed.success) hotels.push(parsed.data);
    }
  }

  const itinerary: TravelItineraryDay[] = [];
  if (Array.isArray(src.itinerary)) {
    for (const rawDay of src.itinerary.slice(0, MAX_TRAVEL_ITINERARY_DAYS)) {
      if (!rawDay || typeof rawDay !== "object") continue;
      const obj = rawDay as Record<string, unknown>;
      const dayNum =
        typeof obj.dayNumber === "number"
          ? obj.dayNumber
          : typeof obj.day === "number"
            ? obj.day
            : null;
      const title = cleanOptionalText(obj.title, 160);
      const summary =
        cleanOptionalText(obj.summary, 1000) ??
        cleanOptionalText(obj.description, 1000) ??
        "";
      if (
        dayNum === null ||
        !Number.isSafeInteger(dayNum) ||
        dayNum < 1 ||
        dayNum > MAX_TRAVEL_ITINERARY_DAYS ||
        !title
      ) {
        continue;
      }
      const city = cleanOptionalText(obj.city, 80);
      const meals = cleanOptionalText(obj.meals, 120);
      itinerary.push({
        dayNumber: dayNum,
        title,
        summary,
        ...(city ? { city } : {}),
        ...(meals ? { meals } : {}),
      });
    }
    itinerary.sort((a, b) => a.dayNumber - b.dayNumber);
  }

  const departures: TravelDeparture[] = [];
  const seenDepKeys = new Set<string>();
  if (Array.isArray(src.departures)) {
    for (const rawDep of src.departures.slice(0, MAX_TRAVEL_DEPARTURES)) {
      if (!rawDep || typeof rawDep !== "object") continue;
      const obj = rawDep as Record<string, unknown>;
      if (obj.status === "closed") continue;
      const depDate = typeof obj.departureDate === "string" ? obj.departureDate.trim() : "";
      if (!isValidTravelDateOnly(depDate)) continue;
      const retRaw = typeof obj.returnDate === "string" ? obj.returnDate.trim() : "";
      const returnDate =
        isValidTravelDateOnly(retRaw) && compareDateOnly(retRaw, depDate) >= 0
          ? retRaw
          : undefined;
      const departureCity = cleanOptionalText(obj.departureCity, 120) ?? undefined;
      const label =
        cleanOptionalText(obj.label, 120) ?? cleanOptionalText(obj.note, 160) ?? undefined;
      const dedupKey = `${depDate}|${returnDate ?? ""}|${departureCity ?? ""}|${label ?? ""}`;
      if (seenDepKeys.has(dedupKey)) continue;
      seenDepKeys.add(dedupKey);
      departures.push({
        departureDate: depDate,
        ...(returnDate ? { returnDate } : {}),
        ...(departureCity ? { departureCity } : {}),
        ...(label ? { label } : {}),
      });
    }
  } else if (Array.isArray(src.departureDates)) {
    for (const rawIso of src.departureDates.slice(0, MAX_TRAVEL_DEPARTURES)) {
      if (typeof rawIso !== "string") continue;
      const depDate = rawIso.trim();
      if (!isValidTravelDateOnly(depDate) || seenDepKeys.has(depDate)) continue;
      seenDepKeys.add(depDate);
      departures.push({ departureDate: depDate });
    }
  }
  departures.sort((a, b) => compareDateOnly(a.departureDate, b.departureDate));

  const inclusions = Array.isArray(src.inclusions)
    ? src.inclusions
        .map((v) => cleanOptionalText(v, 200))
        .filter((v): v is string => v !== null)
        .slice(0, MAX_TRAVEL_INCLUSIONS)
    : [];

  const exclusions = Array.isArray(src.exclusions)
    ? src.exclusions
        .map((v) => cleanOptionalText(v, 200))
        .filter((v): v is string => v !== null)
        .slice(0, MAX_TRAVEL_EXCLUSIONS)
    : [];

  const gate = canPublishTravelPackage(
    {
      packageKind,
      skPpiuNumber: cleanOptionalText(src.skPpiuNumber, 120),
      skPihkNumber: cleanOptionalText(src.skPihkNumber, 120),
      ppiuNumber: cleanOptionalText(src.ppiuNumber, 120),
      umrahLicense: cleanOptionalText(src.umrahLicense, 120),
    },
    trustedGateState,
  );

  // Verified badge renders ONLY for Umrah/Hajj packages whose DEC-042 trusted gate passes.
  const verifiedLicenseKind = gate.showVerifiedBadge ? gate.verifiedLicenseKind : null;
  const verifiedLicenseNumber = gate.showVerifiedBadge ? gate.verifiedLicenseNumber : null;

  return {
    packageKind,
    packageKindLabel: TRAVEL_PACKAGE_KIND_LABELS[packageKind],
    destination: cleanOptionalText(src.destination, 160),
    durationDays,
    durationNights,
    durationLabel: formatTravelDurationLabel(durationDays, durationNights),
    departureCity: cleanOptionalText(src.departureCity, 120),
    airline: cleanOptionalText(src.airline, 120),
    transport: cleanOptionalText(src.transport, 160),
    accommodation:
      cleanOptionalText(src.accommodation, 200) ?? cleanOptionalText(src.hotel, 160),
    hotels,
    inclusions,
    exclusions,
    travelInsurance: cleanOptionalText(src.travelInsurance, 200),
    officialVisa: cleanOptionalText(src.officialVisa, 200),
    itinerary,
    departures,
    minPax:
      typeof src.minPax === "number" && Number.isSafeInteger(src.minPax) && src.minPax >= 1
        ? src.minPax
        : null,
    verifiedLicenseKind,
    verifiedLicenseNumber,
    showVerifiedBadge: gate.showVerifiedBadge,
  };
}

/**
 * Builds a clean zero-JS `https://wa.me/...` inquiry link for a travel package.
 * Returns `null` if the phone number is invalid.
 */
export function buildTravelInquiryWhatsAppHref(params: {
  readonly phone: string | null | undefined;
  readonly packageTitle: string;
  readonly departureDate?: string | null;
  readonly canonicalUrl?: string | null;
}): string | null {
  if (!params.phone || !params.phone.trim()) return null;
  const validated = validateIndonesianWhatsAppNumber(params.phone);
  if (!validated.ok) return null;
  const parts = [`Halo, saya ingin menanyakan paket "${params.packageTitle.trim()}"`];
  if (params.departureDate && isValidTravelDateOnly(params.departureDate)) {
    parts.push(
      `untuk jadwal keberangkatan ${formatTravelDateOnlyIndonesian(params.departureDate)}`,
    );
  }
  const text = params.canonicalUrl
    ? `${parts.join(" ")}. Info: ${params.canonicalUrl}`
    : `${parts.join(" ")}.`;
  return `${WA_ME_ORIGIN}/${validated.phone}?text=${encodeURIComponent(text)}`;
}
