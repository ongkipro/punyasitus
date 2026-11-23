import { z } from "zod";
import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "../link-sanitizer.ts";
import {
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  SequentialIdSchema,
  VersionSchema,
} from "../schemas/common.ts";
import type { SchemaBranchInput } from "../schema-generator.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
  WhatsAppValidationError,
} from "../wa-dispatcher.ts";

/**
 * Multi-Branch Locations (`branches`) Core Domain, Validation & Public Formatting
 * (REQ-088, REQ-022, REQ-054, REQ-091; PLAN §5.2, §19.5; TASK-088).
 *
 * Hard Invariants:
 * - Bounded cap: maximum `10` branches per website beside head office (`MAX_BRANCHES_PER_TENANT = 10`).
 * - Strict Zod v4 `.strict()` schemas rejecting unknown fields and forbidden tenant selectors.
 * - Safe URL validation via `link-sanitizer.ts` (public HTTPS only; zero `javascript:`, `data:`,
 *   `http://`, localhost/private IPs, or embedded credentials).
 * - Safe Indonesian WhatsApp E.164 normalization via `wa-dispatcher.ts` (`628...`).
 * - Coordinates must be provided as a valid complete `(latitude, longitude)` pair or both omitted.
 * - Single canonical mapper from visible branch facts to Schema.org `SchemaBranchInput`
 *   with ZERO fabricated ratings, reviews, coordinates, or hours.
 */

export const MAX_BRANCHES_PER_TENANT = 10 as const;
export const DEFAULT_BRANCH_TIMEZONE = "Asia/Jakarta" as const;

export const INDONESIAN_BRANCH_TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
] as const;

export type IndonesianBranchTimezone = (typeof INDONESIAN_BRANCH_TIMEZONES)[number];

export const BRANCH_TIMEZONE_LABELS_ID: Readonly<Record<string, string>> = {
  "Asia/Jakarta": "WIB (Asia/Jakarta)",
  "Asia/Makassar": "WITA (Asia/Makassar)",
  "Asia/Jayapura": "WIT (Asia/Jayapura)",
};

export const MAX_BRANCH_NAME_LENGTH = 120 as const;
export const MAX_BRANCH_ADDRESS_LENGTH = 500 as const;
export const MAX_BRANCH_CITY_LENGTH = 120 as const;
export const MAX_BRANCH_PROVINCE_LENGTH = 120 as const;
export const MAX_BRANCH_POSTAL_CODE_LENGTH = 20 as const;
export const MAX_BRANCH_PHONE_LENGTH = 32 as const;
export const MAX_BRANCH_HOURS_LENGTH = 160 as const;
export const MAX_BRANCH_TIMEZONE_LENGTH = 64 as const;
export const MAX_BRANCH_SORT_ORDER = 100 as const;

export const BRANCH_FORBIDDEN_SELECTOR_KEY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_TENANT_SELECTOR_KEYS,
);

export interface BranchValidationFieldIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface BranchOpeningHours {
  readonly weekday: string | null;
  readonly holiday: string | null;
}

export interface BranchRecord {
  readonly id: number;
  readonly name: string;
  readonly address: string;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly whatsappNumber: string | null;
  readonly mapsUrl: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly weekdayHours: string | null;
  readonly holidayHours: string | null;
  readonly openingHours: BranchOpeningHours | null;
  readonly timezone: string;
  readonly sortOrder: number;
  readonly isPrimary: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NormalizedBranchCreateInput {
  readonly name: string;
  readonly address: string;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly mapsUrl: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly weekdayHours: string | null;
  readonly holidayHours: string | null;
  readonly timezone: string;
  readonly sortOrder?: number;
  readonly isPrimary: boolean;
  readonly active: boolean;
}

export interface NormalizedBranchUpdateInput {
  readonly name?: string;
  readonly address?: string;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly phone?: string | null;
  readonly whatsappE164?: string | null;
  readonly mapsUrl?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
  readonly timezone?: string;
  readonly sortOrder?: number;
  readonly isPrimary?: boolean;
  readonly active?: boolean;
  readonly expectedVersion?: number;
}

export interface NormalizedBranchReorderInput {
  readonly branchIds: readonly number[];
}

export type BranchValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string; readonly fields: readonly BranchValidationFieldIssue[] };

// ---------------------------------------------------------------------------
// Low-level Sanitizers & Validators
// ---------------------------------------------------------------------------

function hasControlChars(value: string, allowNewlines = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowNewlines && (code === 0x0a || code === 0x0d)) {
        continue;
      }
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

/**
 * Normalizes an Indonesian landline or mobile phone number into clean digits
 * (`62...`, 8..15 digits) without separators. Returns `null` when empty.
 */
export function normalizeBranchPhone(
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
  if (trimmed.length > MAX_BRANCH_PHONE_LENGTH) {
    return {
      ok: false,
      message: `Nomor telepon maksimal ${MAX_BRANCH_PHONE_LENGTH} karakter.`,
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
    return { ok: false, message: "Format nomor telepon tidak valid." };
  }
  if (!hasPlus && digits.startsWith("0")) {
    digits = `62${digits.slice(1)}`;
  }
  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      message: "Nomor telepon harus terdiri dari 8 hingga 15 digit setelah normalisasi.",
    };
  }
  return { ok: true, value: digits };
}

/**
 * Normalizes an Indonesian WhatsApp mobile number into E.164 digits (`628...`) via `wa-dispatcher.ts`.
 */
export function normalizeBranchWhatsApp(
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
    return { ok: true, value: normalizeIndonesianWhatsAppNumber(trimmed) };
  } catch (err) {
    if (err instanceof WhatsAppValidationError) {
      return {
        ok: false,
        message: "Nomor WhatsApp cabang harus nomor seluler Indonesia yang valid (awalan 08, 628, atau +628).",
      };
    }
    return { ok: false, message: "Nomor WhatsApp cabang tidak valid." };
  }
}

/**
 * Validates a branch Google Maps / location URL strictly via `link-sanitizer.ts`.
 * Rejects `javascript:`, `data:`, `http://`, localhost/private IPs, embedded credentials, and control chars.
 */
export function normalizeBranchMapsUrl(
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
  try {
    const safe = sanitizeExternalLink(trimmed);
    return { ok: true, value: safe.href };
  } catch (err) {
    if (err instanceof ExternalLinkValidationError) {
      if (err.code === "UNSUPPORTED_PROTOCOL" || err.code === "MALFORMED_URL") {
        return {
          ok: false,
          message: "Tautan Google Maps harus menggunakan protokol HTTPS publik yang valid (https://...).",
        };
      }
      if (err.code === "FORBIDDEN_HOST") {
        return {
          ok: false,
          message: "Tautan Google Maps tidak boleh mengarah ke localhost atau alamat IP privat.",
        };
      }
      if (err.code === "EMBEDDED_CREDENTIALS") {
        return {
          ok: false,
          message: "Tautan Google Maps tidak boleh mengandung kredensial.",
        };
      }
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Tautan Google Maps tidak valid." };
  }
}

/**
 * Validates an IANA timezone string (defaulting to `Asia/Jakarta`).
 */
export function validateBranchTimezone(
  rawTimezone: string | null | undefined,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  if (rawTimezone === null || rawTimezone === undefined || rawTimezone === "") {
    return { ok: true, value: DEFAULT_BRANCH_TIMEZONE };
  }
  if (typeof rawTimezone !== "string" || hasControlChars(rawTimezone, false)) {
    return { ok: false, message: "Zona waktu tidak valid." };
  }
  const trimmed = rawTimezone.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: DEFAULT_BRANCH_TIMEZONE };
  }
  if (trimmed.length > MAX_BRANCH_TIMEZONE_LENGTH || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(trimmed)) {
    return {
      ok: false,
      message: "Zona waktu harus berupa nama zona waktu IANA yang valid (contoh: Asia/Jakarta).",
    };
  }
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone: trimmed });
    return { ok: true, value: trimmed };
  } catch {
    return {
      ok: false,
      message: `Zona waktu "${trimmed}" tidak dikenali. Gunakan Asia/Jakarta, Asia/Makassar, atau Asia/Jayapura.`,
    };
  }
}

/**
 * Validates coordinate pairs: either both `latitude` and `longitude` are finite numbers
 * within WGS84 bounds (`[-90, 90]`, `[-180, 180]`), or both are `null`.
 */
export function validateBranchCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
):
  | { readonly ok: true; readonly latitude: number | null; readonly longitude: number | null }
  | { readonly ok: false; readonly fields: readonly BranchValidationFieldIssue[] } {
  const hasLat = latitude !== null && latitude !== undefined;
  const hasLng = longitude !== null && longitude !== undefined;

  if (!hasLat && !hasLng) {
    return { ok: true, latitude: null, longitude: null };
  }

  const fields: BranchValidationFieldIssue[] = [];
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
        message: "Latitude harus berupa angka antara -90 hingga 90.",
      });
    }
  }
  if (hasLng) {
    if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      fields.push({
        field: "longitude",
        code: "INVALID_COORDINATES",
        message: "Longitude harus berupa angka antara -180 hingga 180.",
      });
    }
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  // Round to 7 decimal places (~1.1 cm precision) to avoid floating-point noise
  const roundedLat = Math.round((latitude as number) * 1e7) / 1e7;
  const roundedLng = Math.round((longitude as number) * 1e7) / 1e7;
  return { ok: true, latitude: roundedLat, longitude: roundedLng };
}

// ---------------------------------------------------------------------------
// Strict Zod v4 Schemas
// ---------------------------------------------------------------------------

const SafeSingleLineText = (maxLen: number) =>
  z
    .string()
    .refine((val) => !hasControlChars(val, false), "Teks tidak boleh mengandung karakter kontrol.")
    .transform(collapseSingleLine)
    .refine((val) => val.length <= maxLen, `Maksimal ${maxLen} karakter.`);

const SafeOptionalSingleLineText = (maxLen: number) =>
  z
    .union([z.null(), z.undefined(), SafeSingleLineText(maxLen)])
    .transform((val) => (typeof val === "string" && val.length > 0 ? val : null));

const SafeRequiredNameSchema = SafeSingleLineText(MAX_BRANCH_NAME_LENGTH).refine(
  (val) => val.length >= 1,
  "Nama cabang wajib diisi.",
);

const SafeRequiredAddressSchema = z
  .string()
  .refine((val) => !hasControlChars(val, true), "Alamat tidak boleh mengandung karakter kontrol.")
  .transform(normalizeMultiLineAddress)
  .refine((val) => val.length >= 1, "Alamat cabang wajib diisi.")
  .refine(
    (val) => val.length <= MAX_BRANCH_ADDRESS_LENGTH,
    `Alamat cabang maksimal ${MAX_BRANCH_ADDRESS_LENGTH} karakter.`,
  );

const SafePostalCodeSchema = z
  .union([z.null(), z.undefined(), SafeSingleLineText(MAX_BRANCH_POSTAL_CODE_LENGTH)])
  .transform((val) => (typeof val === "string" && val.length > 0 ? val : null))
  .refine(
    (val) => val === null || /^[A-Za-z0-9 -]{3,20}$/.test(val),
    "Kode pos hanya boleh berisi 3–20 huruf, angka, spasi, atau tanda hubung.",
  );

export const BranchOpeningHoursInputSchema = z
  .object({
    weekday: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
    holiday: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
  })
  .strict();

export const BranchCreateInputSchema = z
  .object({
    name: SafeRequiredNameSchema,
    address: SafeRequiredAddressSchema,
    city: SafeOptionalSingleLineText(MAX_BRANCH_CITY_LENGTH).optional(),
    province: SafeOptionalSingleLineText(MAX_BRANCH_PROVINCE_LENGTH).optional(),
    postalCode: SafePostalCodeSchema.optional(),
    phone: z.union([z.string(), z.null()]).optional(),
    whatsappE164: z.union([z.string(), z.null()]).optional(),
    whatsappNumber: z.union([z.string(), z.null()]).optional(),
    mapsUrl: z.union([z.string(), z.null()]).optional(),
    latitude: z.number().finite().min(-90).max(90).nullable().optional(),
    longitude: z.number().finite().min(-180).max(180).nullable().optional(),
    weekdayHours: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
    holidayHours: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
    openingHours: BranchOpeningHoursInputSchema.nullable().optional(),
    timezone: z.string().max(MAX_BRANCH_TIMEZONE_LENGTH).optional(),
    sortOrder: z.number().int().min(0).max(MAX_BRANCH_SORT_ORDER).optional(),
    isPrimary: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const BranchUpdateInputSchema = z
  .object({
    name: SafeRequiredNameSchema.optional(),
    address: SafeRequiredAddressSchema.optional(),
    city: SafeOptionalSingleLineText(MAX_BRANCH_CITY_LENGTH).optional(),
    province: SafeOptionalSingleLineText(MAX_BRANCH_PROVINCE_LENGTH).optional(),
    postalCode: SafePostalCodeSchema.optional(),
    phone: z.union([z.string(), z.null()]).optional(),
    whatsappE164: z.union([z.string(), z.null()]).optional(),
    whatsappNumber: z.union([z.string(), z.null()]).optional(),
    mapsUrl: z.union([z.string(), z.null()]).optional(),
    latitude: z.number().finite().min(-90).max(90).nullable().optional(),
    longitude: z.number().finite().min(-180).max(180).nullable().optional(),
    weekdayHours: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
    holidayHours: SafeOptionalSingleLineText(MAX_BRANCH_HOURS_LENGTH).optional(),
    openingHours: BranchOpeningHoursInputSchema.nullable().optional(),
    timezone: z.string().max(MAX_BRANCH_TIMEZONE_LENGTH).optional(),
    sortOrder: z.number().int().min(0).max(MAX_BRANCH_SORT_ORDER).optional(),
    isPrimary: z.boolean().optional(),
    active: z.boolean().optional(),
    expectedVersion: VersionSchema.optional(),
    version: VersionSchema.optional(),
  })
  .strict();

export const BranchReorderInputSchema = z
  .object({
    branchIds: z
      .array(SequentialIdSchema)
      .min(1, "Minimal 1 ID cabang diperlukan untuk pengurutan.")
      .max(MAX_BRANCHES_PER_TENANT, `Maksimal ${MAX_BRANCHES_PER_TENANT} cabang.`)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Daftar ID cabang tidak boleh mengandung duplikat.",
      ),
  })
  .strict();

export const BRANCH_CREATE_ALLOWED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(BranchCreateInputSchema.shape),
);

export const BRANCH_UPDATE_ALLOWED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(BranchUpdateInputSchema.shape),
);

export const BRANCH_REORDER_ALLOWED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(BranchReorderInputSchema.shape),
);

function mapZodIssuesToBranchFields(issues: readonly z.core.$ZodIssue[]): BranchValidationFieldIssue[] {
  const out: BranchValidationFieldIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && "keys" in issue && Array.isArray(issue.keys)) {
      for (const unknownKey of issue.keys) {
        const keyStr = String(unknownKey);
        const pathPrefix = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
        out.push({
          field: `${pathPrefix}${keyStr}`,
          code: BRANCH_FORBIDDEN_SELECTOR_KEY_SET.has(keyStr)
            ? "FORBIDDEN_TENANT_SELECTOR"
            : "UNKNOWN_FIELD",
          message: BRANCH_FORBIDDEN_SELECTOR_KEY_SET.has(keyStr)
            ? `Field "${keyStr}" tidak diizinkan dalam permintaan tenant.`
            : `Field tidak dikenal "${keyStr}".`,
        });
      }
      continue;
    }
    const field = issue.path.length > 0 ? issue.path.join(".") : "body";
    out.push({
      field,
      code: "INVALID_BRANCH_FIELD",
      message: issue.message,
    });
  }
  return out;
}

/**
 * Validates and normalizes a branch creation payload.
 */
export function validateBranchCreatePayload(
  raw: unknown,
): BranchValidationResult<NormalizedBranchCreateInput> {
  const parsed = BranchCreateInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = mapZodIssuesToBranchFields(parsed.error.issues);
    return {
      ok: false,
      message: fields[0]?.message ?? "Data cabang tidak valid.",
      fields,
    };
  }

  const d = parsed.data;
  const issues: BranchValidationFieldIssue[] = [];

  const phoneRes = normalizeBranchPhone(d.phone);
  if (!phoneRes.ok) {
    issues.push({ field: "phone", code: "INVALID_PHONE", message: phoneRes.message });
  }

  const rawWa = d.whatsappE164 !== undefined ? d.whatsappE164 : d.whatsappNumber;
  if (
    d.whatsappE164 !== undefined &&
    d.whatsappNumber !== undefined &&
    d.whatsappE164 !== d.whatsappNumber
  ) {
    issues.push({
      field: "whatsappNumber",
      code: "CONFLICTING_WHATSAPP_FIELDS",
      message: "whatsappE164 dan whatsappNumber harus sama jika keduanya dikirim.",
    });
  }
  const waRes = normalizeBranchWhatsApp(rawWa);
  if (!waRes.ok) {
    issues.push({
      field: d.whatsappE164 !== undefined ? "whatsappE164" : "whatsappNumber",
      code: "INVALID_WHATSAPP",
      message: waRes.message,
    });
  }

  const mapsRes = normalizeBranchMapsUrl(d.mapsUrl);
  if (!mapsRes.ok) {
    issues.push({ field: "mapsUrl", code: "INVALID_MAPS_URL", message: mapsRes.message });
  }

  const coordsRes = validateBranchCoordinates(d.latitude, d.longitude);
  if (!coordsRes.ok) {
    issues.push(...coordsRes.fields);
  }

  const tzRes = validateBranchTimezone(d.timezone);
  if (!tzRes.ok) {
    issues.push({ field: "timezone", code: "INVALID_TIMEZONE", message: tzRes.message });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      message: issues[0]!.message,
      fields: issues,
    };
  }

  const weekdayHours = d.weekdayHours ?? d.openingHours?.weekday ?? null;
  const holidayHours = d.holidayHours ?? d.openingHours?.holiday ?? null;

  return {
    ok: true,
    data: {
      name: d.name,
      address: d.address,
      city: d.city ?? null,
      province: d.province ?? null,
      postalCode: d.postalCode ?? null,
      phone: phoneRes.ok ? phoneRes.value : null,
      whatsappE164: waRes.ok ? waRes.value : null,
      mapsUrl: mapsRes.ok ? mapsRes.value : null,
      latitude: coordsRes.ok ? coordsRes.latitude : null,
      longitude: coordsRes.ok ? coordsRes.longitude : null,
      weekdayHours,
      holidayHours,
      timezone: tzRes.ok ? tzRes.value : DEFAULT_BRANCH_TIMEZONE,
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      isPrimary: d.isPrimary ?? false,
      active: d.active ?? true,
    },
  };
}

/**
 * Validates and normalizes a branch update (PATCH/PUT) payload.
 * Coordinate pair completeness is checked against merged `(existingLatitude, existingLongitude)`
 * when provided, or directly against the incoming fields.
 */
export function validateBranchUpdatePayload(
  raw: unknown,
  existingCoords?: { readonly latitude: number | null; readonly longitude: number | null },
): BranchValidationResult<NormalizedBranchUpdateInput> {
  const parsed = BranchUpdateInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = mapZodIssuesToBranchFields(parsed.error.issues);
    return {
      ok: false,
      message: fields[0]?.message ?? "Data pembaruan cabang tidak valid.",
      fields,
    };
  }

  const d = parsed.data;
  const issues: BranchValidationFieldIssue[] = [];

  if (d.expectedVersion !== undefined && d.version !== undefined && d.expectedVersion !== d.version) {
    issues.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion dan version harus bernilai sama jika keduanya dikirim.",
    });
  }

  const hasLatField = Object.prototype.hasOwnProperty.call(d, "latitude");
  const hasLngField = Object.prototype.hasOwnProperty.call(d, "longitude");
  const effectiveLat = hasLatField ? (d.latitude ?? null) : (existingCoords?.latitude ?? null);
  const effectiveLng = hasLngField ? (d.longitude ?? null) : (existingCoords?.longitude ?? null);

  let normalizedCoords: { readonly latitude: number | null; readonly longitude: number | null } | null = null;
  if (hasLatField || hasLngField) {
    const coordsRes = validateBranchCoordinates(effectiveLat, effectiveLng);
    if (!coordsRes.ok) {
      issues.push(...coordsRes.fields);
    } else {
      normalizedCoords = { latitude: coordsRes.latitude, longitude: coordsRes.longitude };
    }
  }

  let normalizedPhone: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "phone")) {
    const phoneRes = normalizeBranchPhone(d.phone);
    if (!phoneRes.ok) {
      issues.push({ field: "phone", code: "INVALID_PHONE", message: phoneRes.message });
    } else {
      normalizedPhone = phoneRes.value;
    }
  }

  let normalizedWa: string | null | undefined;
  const hasWaE164 = Object.prototype.hasOwnProperty.call(d, "whatsappE164");
  const hasWaNum = Object.prototype.hasOwnProperty.call(d, "whatsappNumber");
  if (hasWaE164 && hasWaNum && d.whatsappE164 !== d.whatsappNumber) {
    issues.push({
      field: "whatsappNumber",
      code: "CONFLICTING_WHATSAPP_FIELDS",
      message: "whatsappE164 dan whatsappNumber harus sama jika keduanya dikirim.",
    });
  } else if (hasWaE164 || hasWaNum) {
    const waRes = normalizeBranchWhatsApp(hasWaE164 ? d.whatsappE164 : d.whatsappNumber);
    if (!waRes.ok) {
      issues.push({
        field: hasWaE164 ? "whatsappE164" : "whatsappNumber",
        code: "INVALID_WHATSAPP",
        message: waRes.message,
      });
    } else {
      normalizedWa = waRes.value;
    }
  }

  let normalizedMapsUrl: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "mapsUrl")) {
    const mapsRes = normalizeBranchMapsUrl(d.mapsUrl);
    if (!mapsRes.ok) {
      issues.push({ field: "mapsUrl", code: "INVALID_MAPS_URL", message: mapsRes.message });
    } else {
      normalizedMapsUrl = mapsRes.value;
    }
  }

  let normalizedTimezone: string | undefined;
  if (Object.prototype.hasOwnProperty.call(d, "timezone")) {
    const tzRes = validateBranchTimezone(d.timezone);
    if (!tzRes.ok) {
      issues.push({ field: "timezone", code: "INVALID_TIMEZONE", message: tzRes.message });
    } else {
      normalizedTimezone = tzRes.value;
    }
  }

  const updateFields: Record<string, unknown> = {};
  if (d.name !== undefined) updateFields.name = d.name;
  if (d.address !== undefined) updateFields.address = d.address;
  if (Object.prototype.hasOwnProperty.call(d, "city")) updateFields.city = d.city ?? null;
  if (Object.prototype.hasOwnProperty.call(d, "province")) updateFields.province = d.province ?? null;
  if (Object.prototype.hasOwnProperty.call(d, "postalCode")) updateFields.postalCode = d.postalCode ?? null;
  if (normalizedPhone !== undefined) updateFields.phone = normalizedPhone;
  if (normalizedWa !== undefined) updateFields.whatsappE164 = normalizedWa;
  if (normalizedMapsUrl !== undefined) updateFields.mapsUrl = normalizedMapsUrl;
  if (normalizedCoords !== null) {
    updateFields.latitude = normalizedCoords.latitude;
    updateFields.longitude = normalizedCoords.longitude;
  }
  if (Object.prototype.hasOwnProperty.call(d, "weekdayHours")) {
    updateFields.weekdayHours = d.weekdayHours ?? null;
  } else if (Object.prototype.hasOwnProperty.call(d, "openingHours")) {
    updateFields.weekdayHours = d.openingHours?.weekday ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(d, "holidayHours")) {
    updateFields.holidayHours = d.holidayHours ?? null;
  } else if (Object.prototype.hasOwnProperty.call(d, "openingHours")) {
    updateFields.holidayHours = d.openingHours?.holiday ?? null;
  }
  if (normalizedTimezone !== undefined) updateFields.timezone = normalizedTimezone;
  if (d.sortOrder !== undefined) updateFields.sortOrder = d.sortOrder;
  if (d.isPrimary !== undefined) updateFields.isPrimary = d.isPrimary;
  if (d.active !== undefined) updateFields.active = d.active;

  if (Object.keys(updateFields).length === 0) {
    issues.push({
      field: "body",
      code: "EMPTY_BRANCH_PATCH",
      message: "Minimal satu field cabang harus diubah.",
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      message: issues[0]!.message,
      fields: issues,
    };
  }

  const expectedVersion = d.expectedVersion ?? d.version;
  return {
    ok: true,
    data: {
      ...(updateFields as NormalizedBranchUpdateInput),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

/**
 * Validates a branch reorder payload (`branchIds`).
 */
export function validateBranchReorderPayload(
  raw: unknown,
): BranchValidationResult<NormalizedBranchReorderInput> {
  const parsed = BranchReorderInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = mapZodIssuesToBranchFields(parsed.error.issues);
    return {
      ok: false,
      message: fields[0]?.message ?? "Daftar urutan cabang tidak valid.",
      fields,
    };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Public Rendering & Unified Schema.org `@graph` Helpers
// ---------------------------------------------------------------------------

export interface PublicBranchViewInput {
  readonly id?: number | string | null;
  readonly name: string;
  readonly address: string;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly phone?: string | null;
  readonly whatsappE164?: string | null;
  readonly whatsappNumber?: string | null;
  readonly mapsUrl?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
  readonly openingHours?: { readonly weekday?: string | null; readonly holiday?: string | null } | null;
  readonly timezone?: string | null;
  readonly sortOrder?: number | null;
  readonly isPrimary?: boolean | null;
  readonly active?: boolean | null;
}

/**
 * Deterministically orders branches: primary branch first, then `sortOrder ASC`, then `id ASC`.
 */
export function sortBranchesCanonically<T extends Pick<PublicBranchViewInput, "id" | "isPrimary" | "sortOrder">>(
  branches: readonly T[],
): T[] {
  return [...branches].sort((a, b) => {
    const primaryDiff = Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary));
    if (primaryDiff !== 0) return primaryDiff;
    const sortA = typeof a.sortOrder === "number" ? a.sortOrder : 0;
    const sortB = typeof b.sortOrder === "number" ? b.sortOrder : 0;
    if (sortA !== sortB) return sortA - sortB;
    const idA = typeof a.id === "number" ? a.id : Number(a.id ?? 0);
    const idB = typeof b.id === "number" ? b.id : Number(b.id ?? 0);
    return idA - idB;
  });
}

/**
 * Formats a branch's visible full address line from its structured fields without duplication.
 */
export function formatBranchFullAddress(
  branch: Pick<PublicBranchViewInput, "address" | "city" | "province" | "postalCode">,
): string {
  const parts: string[] = [];
  const street = branch.address ? branch.address.trim() : "";
  if (street) parts.push(street);
  const lowerStreet = street.toLowerCase();

  const city = branch.city ? branch.city.trim() : "";
  if (city && !lowerStreet.includes(city.toLowerCase())) {
    parts.push(city);
  }
  const province = branch.province ? branch.province.trim() : "";
  if (province && !lowerStreet.includes(province.toLowerCase())) {
    parts.push(province);
  }
  const postalCode = branch.postalCode ? branch.postalCode.trim() : "";
  if (postalCode && !lowerStreet.includes(postalCode.toLowerCase())) {
    parts.push(postalCode);
  }
  return parts.join(", ");
}

/**
 * Formats an Indonesian phone number for human display (`+62...`) and safe `tel:` href.
 */
export function buildBranchTelHref(rawPhone: string | null | undefined): string | null {
  const normalized = normalizeBranchPhone(rawPhone);
  if (!normalized.ok || !normalized.value) {
    return null;
  }
  return `tel:+${normalized.value}`;
}

export function formatBranchPhoneDisplay(rawPhone: string | null | undefined): string | null {
  const normalized = normalizeBranchPhone(rawPhone);
  if (!normalized.ok || !normalized.value) {
    return null;
  }
  return `+${normalized.value}`;
}

/**
 * Builds a static, zero-JS Google Maps link (`https://...`) without loading any third-party SDK/iframe.
 * Uses the branch's validated `mapsUrl` first, or falls back to a static Google Maps search URL
 * from valid `(latitude, longitude)` coordinates. Never emits `javascript:` or `#`.
 */
export function buildBranchStaticMapsHref(
  branch: Pick<PublicBranchViewInput, "mapsUrl" | "latitude" | "longitude">,
): string | null {
  if (branch.mapsUrl) {
    const safe = normalizeBranchMapsUrl(branch.mapsUrl);
    if (safe.ok && safe.value) {
      return safe.value;
    }
  }
  const coords = validateBranchCoordinates(branch.latitude, branch.longitude);
  if (coords.ok && coords.latitude !== null && coords.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${coords.latitude},${coords.longitude}`,
    )}`;
  }
  return null;
}

/**
 * Returns `true` only when `rawUrl` is a valid HTTPS Google Maps URL
 * (`maps.google.<tld>`, `www.google.<tld>/maps`, `maps.app.goo.gl`, `goo.gl/maps`).
 */
export function isGoogleMapsUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== "string") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === "maps.app.goo.gl") {
    return true;
  }
  if (host === "goo.gl") {
    return pathname === "/maps" || pathname.startsWith("/maps/");
  }
  if (/^maps\.google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host)) {
    return true;
  }
  if (/^(?:www\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host)) {
    return pathname === "/maps" || pathname.startsWith("/maps/");
  }
  return false;
}

/**
 * Resolves an honest Indonesian CTA label for a static branch map link:
 * `"Buka Google Maps"` only for Google Maps hosts, and `"Buka Lokasi di Peta"`
 * for any other valid public HTTPS map provider (e.g. OpenStreetMap, Apple Maps).
 */
export function resolveBranchMapsLabel(
  mapsHref: string | null | undefined,
  googleMapsLabel = "Buka Google Maps",
  genericMapsLabel = "Buka Lokasi di Peta",
): string {
  return isGoogleMapsUrl(mapsHref) ? googleMapsLabel : genericMapsLabel;
}

/**
 * Builds a branch-specific click-to-chat `https://wa.me/<digits>?text=<encoded>` link
 * using the branch's own WhatsApp number (never mutating the site's floating main WhatsApp button).
 */
export function buildBranchWhatsAppHref(
  branch: Pick<PublicBranchViewInput, "name" | "whatsappE164" | "whatsappNumber">,
  businessName?: string | null,
): string | null {
  const rawWa = branch.whatsappE164 ?? branch.whatsappNumber ?? null;
  const normalized = normalizeBranchWhatsApp(rawWa);
  if (!normalized.ok || !normalized.value) {
    return null;
  }
  const branchLabel = collapseSingleLine(branch.name);
  const orgLabel = businessName ? collapseSingleLine(businessName) : "";
  const greeting = orgLabel
    ? `Halo ${orgLabel} (${branchLabel}), saya ingin bertanya mengenai layanan dan jam operasional.`
    : `Halo ${branchLabel}, saya ingin bertanya mengenai layanan dan jam operasional.`;
  return `${WA_ME_ORIGIN}/${normalized.value}?text=${encodeURIComponent(greeting)}`;
}

/**
 * Returns the canonical Indonesian display label for a branch timezone (e.g. `WIB`, `WITA`, `WIT`).
 */
export function formatBranchTimezoneLabel(timezone: string | null | undefined): string {
  const tz = timezone?.trim() || DEFAULT_BRANCH_TIMEZONE;
  return BRANCH_TIMEZONE_LABELS_ID[tz] ?? tz;
}

/**
 * Maps visible active branches (capped at 10, canonically sorted) directly into
 * `SchemaBranchInput[]` for `generateSchemaGraph` / `generatePublishedResourceSchema`.
 * Ensures exact 1:1 visible-fact parity between `SectionBranches.astro` and JSON-LD `@graph`.
 */
export function mapBranchesToSchemaInput(
  branches: readonly PublicBranchViewInput[] | null | undefined,
): SchemaBranchInput[] {
  if (!branches || branches.length === 0) {
    return [];
  }
  const activeBranches = sortBranchesCanonically(
    branches.filter((b) => b.active !== false && collapseSingleLine(b.name).length > 0),
  ).slice(0, MAX_BRANCHES_PER_TENANT);

  return activeBranches.map((branch) => {
    const weekdayHours = branch.weekdayHours ?? branch.openingHours?.weekday ?? null;
    const holidayHours = branch.holidayHours ?? branch.openingHours?.holiday ?? null;
    const coords = validateBranchCoordinates(branch.latitude, branch.longitude);
    const safeMapsUrl = normalizeBranchMapsUrl(branch.mapsUrl);

    return {
      ...(branch.id !== undefined && branch.id !== null ? { id: branch.id } : {}),
      name: collapseSingleLine(branch.name),
      address: branch.address,
      city: branch.city ?? null,
      province: branch.province ?? null,
      postalCode: branch.postalCode ?? null,
      phone: branch.phone ?? null,
      whatsappE164: branch.whatsappE164 ?? branch.whatsappNumber ?? null,
      whatsappNumber: branch.whatsappNumber ?? branch.whatsappE164 ?? null,
      mapsUrl: safeMapsUrl.ok ? safeMapsUrl.value : null,
      latitude: coords.ok ? coords.latitude : null,
      longitude: coords.ok ? coords.longitude : null,
      weekdayHours,
      holidayHours,
      timezone: branch.timezone ?? DEFAULT_BRANCH_TIMEZONE,
      isPrimary: Boolean(branch.isPrimary),
      active: true,
    };
  });
}
