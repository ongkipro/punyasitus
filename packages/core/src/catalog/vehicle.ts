import { z } from "zod";
import {
  MAX_IDR_AMOUNT,
  type CatalogPriceMode,
  type CatalogVehicleUnitStatus,
  type VehicleAttributes,
} from "./index.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  validateIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
} from "../wa-dispatcher.ts";

/**
 * Vehicle Showroom Offering (`/kendaraan`) & Static Credit-Estimate Table Domain Module
 * (`packages/core/src/catalog/vehicle.ts`; TASK-079, REQ-079, PLAN §19.1, DESIGN §12).
 *
 * Core Invariants:
 * - Zero new DB migrations: full structured vehicle attributes serialize losslessly inside
 *   existing offering snapshot envelopes (`_draftMetadata.vehicleShowroomV1` for drafts and
 *   outer `vehicleShowroomV1` on `published_snapshot_json` for frozen public `/kendaraan/[slug]`).
 * - Supports BOTH cars (`car` / Mobil) and motorcycles (`motorcycle` / Motor), including
 *   Indonesian body classes (`mpv`, `suv`, `sedan`, `hatchback`, `crossover`, `double_cabin`,
 *   `pickup`, `city_car`, `niaga`, `matic`, `bebek`, `sport`, `naked`, `trail`, `electric`).
 * - `mileageKm` and `ownershipCount` are allowed ONLY on `"used"` units and STRICTLY REJECTED
 *   (`422`) when `condition === "new"`.
 * - Date-only `stnkTaxExpiryDate` (`YYYY-MM-DD`) is parsed and formatted from pure integer
 *   `(year, month, day)` components — ZERO timezone shift.
 * - `sold` units stay published & indexable with a visible `TERJUAL` badge; `hideSoldInGrids`
 *   filters `sold` items out of showroom grids while keeping `/kendaraan/[slug]` indexable 200 OK.
 * - Static Credit-Estimate Table uses EXACT `BigInt` integer `round_half_up` arithmetic with
 *   ZERO floating-point drift, ZERO client JavaScript, fixed Indonesian non-financing disclaimer,
 *   and renders ONLY when `publicationStatus === "published"` AND `unitStatus === "available"`
 *   AND `priceModel === "fixed"` AND `creditEstimate.enabled === true`.
 */

export const VEHICLE_CATEGORIES = ["car", "motorcycle"] as const;
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];

export const VEHICLE_CONDITIONS = ["new", "used"] as const;
export type VehicleCondition = (typeof VEHICLE_CONDITIONS)[number];

export const VEHICLE_SHOWROOM_UNIT_STATUSES = ["available", "booked", "sold"] as const;
export type VehicleShowroomUnitStatus = (typeof VEHICLE_SHOWROOM_UNIT_STATUSES)[number];

export const VEHICLE_PRICE_MODELS = ["fixed", "from", "range", "on_request"] as const;
export type VehiclePriceModel = (typeof VEHICLE_PRICE_MODELS)[number];

export const VEHICLE_TRANSMISSIONS = ["manual", "automatic", "cvt", "dct", "ev"] as const;
export type VehicleTransmission = (typeof VEHICLE_TRANSMISSIONS)[number];

export const VEHICLE_FUELS = ["bensin", "diesel", "hybrid", "listrik"] as const;
export type VehicleFuel = (typeof VEHICLE_FUELS)[number];

export const VEHICLE_CAR_BODY_TYPES = [
  "mpv",
  "suv",
  "sedan",
  "hatchback",
  "crossover",
  "double_cabin",
  "pickup",
  "city_car",
  "niaga",
  "other",
] as const;
export type VehicleCarBodyType = (typeof VEHICLE_CAR_BODY_TYPES)[number];

export const VEHICLE_MOTORCYCLE_BODY_TYPES = [
  "matic",
  "bebek",
  "sport",
  "naked",
  "trail",
  "electric",
  "other",
] as const;
export type VehicleMotorcycleBodyType = (typeof VEHICLE_MOTORCYCLE_BODY_TYPES)[number];

export const VEHICLE_BODY_TYPES = [
  "mpv",
  "suv",
  "sedan",
  "hatchback",
  "crossover",
  "double_cabin",
  "pickup",
  "city_car",
  "niaga",
  "matic",
  "bebek",
  "sport",
  "naked",
  "trail",
  "electric",
  "other",
] as const;
export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];

const CAR_ONLY_BODY_TYPES: ReadonlySet<VehicleBodyType> = new Set([
  "mpv",
  "suv",
  "sedan",
  "hatchback",
  "crossover",
  "double_cabin",
  "pickup",
  "city_car",
  "niaga",
]);

const MOTORCYCLE_ONLY_BODY_TYPES: ReadonlySet<VehicleBodyType> = new Set([
  "matic",
  "bebek",
  "naked",
  "trail",
  "electric",
]);

const LEGACY_CATALOG_BODY_TYPES: ReadonlySet<string> = new Set([
  "mpv",
  "suv",
  "sedan",
  "hatchback",
  "pickup",
  "double_cabin",
  "crossover",
  "matic",
  "bebek",
  "sport",
  "niaga",
  "other",
]);

export const MIN_VEHICLE_YEAR = 1950 as const;
export const MAX_VEHICLE_MILEAGE_KM = 2_000_000 as const;
export const MIN_VEHICLE_OWNERSHIP_COUNT = 1 as const;
export const MAX_VEHICLE_OWNERSHIP_COUNT = 10 as const;

export const MIN_CREDIT_RATE_BPS = 0 as const;
export const MAX_CREDIT_RATE_BPS = 3_000 as const;
export const MIN_CREDIT_DP_PERCENT = 10 as const;
export const MAX_CREDIT_DP_PERCENT = 80 as const;
export const MAX_CREDIT_DP_OPTIONS = 3 as const;
export const MIN_CREDIT_TENOR_MONTHS = 6 as const;
export const MAX_CREDIT_TENOR_MONTHS = 84 as const;
export const MAX_CREDIT_TENOR_OPTIONS = 4 as const;

export const VEHICLE_SNAPSHOT_METADATA_KEY = "vehicleShowroomV1" as const;

export const VEHICLE_ON_REQUEST_PRICE_LABEL = "Hubungi untuk harga" as const;

export const VEHICLE_CREDIT_DISCLAIMER =
  "Estimasi cicilan bersifat indikatif (bukan penawaran pembiayaan atau persetujuan kredit leasing resmi). Nilai uang muka, suku bunga flat, biaya administrasi, asuransi, dan angsuran aktual mengikuti ketentuan serta verifikasi lembaga pembiayaan yang berlaku." as const;

export const VEHICLE_CATEGORY_LABELS: Readonly<Record<VehicleCategory, string>> = {
  car: "Mobil",
  motorcycle: "Motor",
};

export const VEHICLE_CONDITION_LABELS: Readonly<Record<VehicleCondition, string>> = {
  new: "Baru",
  used: "Bekas",
};

export const VEHICLE_UNIT_STATUS_BADGE_LABELS: Readonly<
  Record<VehicleShowroomUnitStatus, string>
> = {
  available: "TERSEDIA",
  booked: "BOOKED",
  sold: "TERJUAL",
};

export const VEHICLE_PRICE_MODEL_LABELS: Readonly<Record<VehiclePriceModel, string>> = {
  fixed: "Harga Pasti",
  from: "Mulai Dari",
  range: "Rentang Harga",
  on_request: "Hubungi untuk Harga",
};

export const VEHICLE_TRANSMISSION_LABELS: Readonly<Record<VehicleTransmission, string>> = {
  manual: "Manual",
  automatic: "Otomatis",
  cvt: "CVT",
  dct: "DCT",
  ev: "Listrik (EV)",
};

export const VEHICLE_FUEL_LABELS: Readonly<Record<VehicleFuel, string>> = {
  bensin: "Bensin",
  diesel: "Diesel",
  hybrid: "Hybrid",
  listrik: "Listrik (EV)",
};

export const VEHICLE_BODY_TYPE_LABELS: Readonly<Record<VehicleBodyType, string>> = {
  mpv: "MPV",
  suv: "SUV",
  sedan: "Sedan",
  hatchback: "Hatchback",
  crossover: "Crossover",
  double_cabin: "Double Cabin",
  pickup: "Pickup",
  city_car: "City Car",
  niaga: "Niaga",
  matic: "Skutik / Matic",
  bebek: "Motor Bebek",
  sport: "Sport",
  naked: "Naked Bike",
  trail: "Trail / Dual Sport",
  electric: "Motor Listrik",
  other: "Lainnya",
};

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

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Text, Calendar Date-Only (Zero TZ Shift) & IDR Formatting Helpers
// ---------------------------------------------------------------------------

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
      continue;
    }
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out += value[i];
  }
  return out;
}

export function getMaxAllowedVehicleYear(referenceYear?: number): number {
  const baseYear =
    typeof referenceYear === "number" && Number.isSafeInteger(referenceYear) && referenceYear >= 2000
      ? referenceYear
      : new Date().getUTCFullYear();
  return baseYear + 2;
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

export interface VehicleDateOnlyParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Strictly parses a calendar-valid ISO date-only string (`YYYY-MM-DD`) into integer
 * `(year, month, day)` components WITHOUT calling `new Date()`. Zero timezone shift.
 */
export function parseVehicleDateOnly(raw: unknown): VehicleDateOnlyParts | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = DATE_ONLY_PATTERN.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isSafeInteger(year) ||
    year < 1950 ||
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

export function isValidVehicleDateOnly(raw: unknown): raw is string {
  return parseVehicleDateOnly(raw) !== null;
}

/**
 * Formats a calendar-valid `YYYY-MM-DD` date-only string into Indonesian display format
 * (e.g. `"2027-08-15"` -> `"15 Agustus 2027"`) purely from integer components.
 * Identical across every timezone (`UTC`, `Asia/Jakarta`, `America/Los_Angeles`, `Pacific/Auckland`).
 */
export function formatVehicleDateOnlyIndonesian(isoDate: string): string {
  const parts = parseVehicleDateOnly(isoDate);
  if (!parts) return isoDate;
  const monthName = INDONESIAN_MONTH_NAMES[parts.month - 1];
  if (!monthName) return isoDate;
  return `${parts.day} ${monthName} ${parts.year}`;
}

/**
 * Deterministic Indonesian Rupiah integer formatter (e.g. `250000000` -> `"Rp 250.000.000"`).
 */
export function formatVehicleIdr(amountIdr: number): string {
  if (!Number.isSafeInteger(amountIdr) || amountIdr < 0) {
    return VEHICLE_ON_REQUEST_PRICE_LABEL;
  }
  const grouped = String(amountIdr).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${grouped}`;
}

export function formatVehicleMileageKm(mileageKm: number): string {
  if (!Number.isSafeInteger(mileageKm) || mileageKm < 0) return "";
  const grouped = String(mileageKm).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped} km`;
}

/**
 * Formats basis points (e.g. `650` -> `"6,5%"`, `600` -> `"6%"`, `625` -> `"6,25%"`)
 * purely via integer arithmetic with zero floating-point inaccuracy.
 */
export function formatFlatAnnualRateBpsLabel(flatAnnualRateBps: number): string {
  if (!Number.isSafeInteger(flatAnnualRateBps) || flatAnnualRateBps < 0) {
    return "0%";
  }
  const whole = Math.floor(flatAnnualRateBps / 100);
  const frac = flatAnnualRateBps % 100;
  if (frac === 0) return `${whole}%`;
  const padded = String(frac).padStart(2, "0").replace(/0+$/, "");
  return `${whole},${padded}%`;
}

export function formatVehiclePriceLabel(input: {
  readonly priceModel: VehiclePriceModel | CatalogPriceMode;
  readonly priceIdr?: number | null;
  readonly minPriceIdr?: number | null;
  readonly maxPriceIdr?: number | null;
  readonly negotiable?: boolean;
}): string {
  if (input.priceModel === "on_request") {
    return VEHICLE_ON_REQUEST_PRICE_LABEL;
  }
  const negoSuffix = input.negotiable ? " (Nego)" : "";
  if (input.priceModel === "fixed") {
    if (typeof input.priceIdr !== "number" || !Number.isSafeInteger(input.priceIdr) || input.priceIdr < 1) {
      return VEHICLE_ON_REQUEST_PRICE_LABEL;
    }
    return `${formatVehicleIdr(input.priceIdr)}${negoSuffix}`;
  }
  if (input.priceModel === "from") {
    if (typeof input.priceIdr !== "number" || !Number.isSafeInteger(input.priceIdr) || input.priceIdr < 1) {
      return VEHICLE_ON_REQUEST_PRICE_LABEL;
    }
    return `Mulai ${formatVehicleIdr(input.priceIdr)}${negoSuffix}`;
  }
  if (input.priceModel === "range") {
    const minVal = input.minPriceIdr ?? input.priceIdr ?? null;
    const maxVal = input.maxPriceIdr ?? null;
    if (
      typeof minVal !== "number" ||
      !Number.isSafeInteger(minVal) ||
      minVal < 1 ||
      typeof maxVal !== "number" ||
      !Number.isSafeInteger(maxVal) ||
      maxVal <= minVal
    ) {
      return VEHICLE_ON_REQUEST_PRICE_LABEL;
    }
    return `${formatVehicleIdr(minVal)} – ${formatVehicleIdr(maxVal)}${negoSuffix}`;
  }
  return VEHICLE_ON_REQUEST_PRICE_LABEL;
}

// ---------------------------------------------------------------------------
// Strict Zod Schemas (`.strict()`)
// ---------------------------------------------------------------------------

const CleanSingleLineString = (maxLen: number, emptyMessage?: string) =>
  z
    .string()
    .trim()
    .min(1, emptyMessage ?? "Kolom ini wajib diisi.")
    .max(maxLen)
    .refine((val) => !hasControlChars(val), {
      message: "Teks tidak boleh mengandung karakter kontrol.",
    });

export const VehicleCategorySchema = z.enum(VEHICLE_CATEGORIES);
export const VehicleConditionSchema = z.enum(VEHICLE_CONDITIONS);
export const VehicleShowroomUnitStatusSchema = z.enum(VEHICLE_SHOWROOM_UNIT_STATUSES);
export const VehiclePriceModelSchema = z.enum(VEHICLE_PRICE_MODELS);
export const VehicleTransmissionSchema = z.enum(VEHICLE_TRANSMISSIONS);
export const VehicleFuelSchema = z.enum(VEHICLE_FUELS);
export const VehicleBodyTypeSchema = z.enum(VEHICLE_BODY_TYPES);

export const VehicleDateOnlySchema = z
  .string()
  .trim()
  .refine((val) => isValidVehicleDateOnly(val), {
    message: "Tanggal pajak STNK harus berformat kalender valid YYYY-MM-DD (tanpa zona waktu).",
  });

export const VehicleCreditEstimateConfigSchema = z
  .object({
    enabled: z.boolean(),
    flatAnnualRateBps: z
      .number()
      .int("Suku bunga flat tahunan (bps) harus berupa bilangan bulat.")
      .min(MIN_CREDIT_RATE_BPS, "Suku bunga flat minimal 0 bps (0%).")
      .max(MAX_CREDIT_RATE_BPS, "Suku bunga flat maksimal 3000 bps (30% / tahun)."),
    dpPercents: z
      .array(
        z
          .number()
          .int("Persentase DP harus berupa bilangan bulat.")
          .min(MIN_CREDIT_DP_PERCENT, "DP minimal 10%.")
          .max(MAX_CREDIT_DP_PERCENT, "DP maksimal 80%."),
      )
      .min(1, "Minimal 1 pilihan persentase DP wajib diisi.")
      .max(MAX_CREDIT_DP_OPTIONS, "Maksimal 3 pilihan persentase DP."),
    tenorMonths: z
      .array(
        z
          .number()
          .int("Tenor bulan harus berupa bilangan bulat.")
          .min(MIN_CREDIT_TENOR_MONTHS, "Tenor minimal 6 bulan.")
          .max(MAX_CREDIT_TENOR_MONTHS, "Tenor maksimal 84 bulan."),
      )
      .min(1, "Minimal 1 pilihan tenor bulan wajib diisi.")
      .max(MAX_CREDIT_TENOR_OPTIONS, "Maksimal 4 pilihan tenor bulan."),
  })
  .strict()
  .superRefine((val, ctx) => {
    const seenDp = new Set<number>();
    for (let i = 0; i < val.dpPercents.length; i += 1) {
      const pct = val.dpPercents[i];
      if (pct === undefined) continue;
      if (seenDp.has(pct)) {
        ctx.addIssue({
          code: "custom",
          path: ["dpPercents", i],
          message: `Persentase DP ${pct}% tidak boleh duplikat.`,
        });
      }
      seenDp.add(pct);
    }

    const seenTenor = new Set<number>();
    for (let i = 0; i < val.tenorMonths.length; i += 1) {
      const m = val.tenorMonths[i];
      if (m === undefined) continue;
      if (seenTenor.has(m)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenorMonths", i],
          message: `Tenor ${m} bulan tidak boleh duplikat.`,
        });
      }
      seenTenor.add(m);
    }
  });

export type VehicleCreditEstimateConfig = z.infer<typeof VehicleCreditEstimateConfigSchema>;

export function createVehicleShowroomAttributesSchema(referenceYear?: number) {
  const maxYear = getMaxAllowedVehicleYear(referenceYear);
  return z
    .object({
      vehicleCategory: VehicleCategorySchema,
      brand: CleanSingleLineString(80, "Merek kendaraan wajib diisi."),
      model: CleanSingleLineString(100, "Model kendaraan wajib diisi."),
      variant: CleanSingleLineString(100).optional(),
      year: z
        .number()
        .int("Tahun kendaraan harus berupa bilangan bulat.")
        .min(MIN_VEHICLE_YEAR, `Tahun kendaraan minimal ${MIN_VEHICLE_YEAR}.`)
        .max(maxYear, `Tahun kendaraan maksimal ${maxYear}.`),
      condition: VehicleConditionSchema,
      mileageKm: z
        .number()
        .int("Jarak tempuh harus berupa bilangan bulat (km).")
        .min(0, "Jarak tempuh tidak boleh negatif.")
        .max(MAX_VEHICLE_MILEAGE_KM, "Jarak tempuh melebihi batas maksimum.")
        .nullable()
        .optional(),
      transmission: VehicleTransmissionSchema,
      fuel: VehicleFuelSchema,
      bodyType: VehicleBodyTypeSchema,
      color: CleanSingleLineString(60, "Warna kendaraan wajib diisi."),
      seats: z
        .number()
        .int("Kapasitas kursi harus berupa bilangan bulat.")
        .min(1, "Kapasitas kursi minimal 1.")
        .max(60, "Kapasitas kursi maksimal 60.")
        .nullable()
        .optional(),
      engineCc: z
        .number()
        .int("Kapasitas mesin (cc) harus berupa bilangan bulat.")
        .min(50, "Kapasitas mesin minimal 50 cc.")
        .max(20_000, "Kapasitas mesin maksimal 20.000 cc.")
        .nullable()
        .optional(),
      location: CleanSingleLineString(120, "Lokasi unit wajib diisi."),
      plateRegion: CleanSingleLineString(40).optional(),
      stnkTaxExpiryDate: VehicleDateOnlySchema.nullable().optional(),
      ownershipCount: z
        .number()
        .int("Jumlah kepemilikan harus berupa bilangan bulat.")
        .min(MIN_VEHICLE_OWNERSHIP_COUNT, "Kepemilikan minimal tangan ke-1.")
        .max(MAX_VEHICLE_OWNERSHIP_COUNT, "Kepemilikan maksimal tangan ke-10.")
        .nullable()
        .optional(),
      priceModel: VehiclePriceModelSchema,
      priceIdr: z
        .number()
        .int("Harga harus berupa bilangan bulat Rupiah.")
        .min(1, "Harga harus lebih besar dari Rp 0.")
        .max(MAX_IDR_AMOUNT, "Nominal harga melebihi batas maksimum.")
        .nullable()
        .optional(),
      minPriceIdr: z
        .number()
        .int("Harga minimum harus berupa bilangan bulat Rupiah.")
        .min(1, "Harga minimum harus lebih besar dari Rp 0.")
        .max(MAX_IDR_AMOUNT, "Nominal harga minimum melebihi batas maksimum.")
        .nullable()
        .optional(),
      maxPriceIdr: z
        .number()
        .int("Harga maksimum harus berupa bilangan bulat Rupiah.")
        .min(1, "Harga maksimum harus lebih besar dari Rp 0.")
        .max(MAX_IDR_AMOUNT, "Nominal harga maksimum melebihi batas maksimum.")
        .nullable()
        .optional(),
      negotiable: z.boolean().default(false),
      unitStatus: VehicleShowroomUnitStatusSchema.default("available"),
      hideSoldInGrids: z.boolean().default(false),
      otrPriceNote: CleanSingleLineString(240).optional(),
      salesWhatsappOverride: z
        .string()
        .max(32)
        .superRefine((raw, ctx) => {
          if (hasControlChars(raw)) {
            ctx.addIssue({
              code: "custom",
              message: "Nomor WhatsApp sales tidak boleh mengandung karakter kontrol.",
            });
            return;
          }
          const res = validateIndonesianWhatsAppNumber(raw);
          if (!res.ok) {
            ctx.addIssue({
              code: "custom",
              message:
                "Nomor WhatsApp sales harus berupa nomor seluler Indonesia yang valid (08..., 628..., atau +628...).",
            });
          }
        })
        .nullable()
        .optional(),
      creditEstimate: VehicleCreditEstimateConfigSchema.nullable().optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      // 1. Category vs bodyType coherence
      if (val.vehicleCategory === "car" && MOTORCYCLE_ONLY_BODY_TYPES.has(val.bodyType)) {
        ctx.addIssue({
          code: "custom",
          path: ["bodyType"],
          message: `Tipe bodi "${VEHICLE_BODY_TYPE_LABELS[val.bodyType]}" hanya berlaku untuk kategori Motor.`,
        });
      }
      if (val.vehicleCategory === "motorcycle" && CAR_ONLY_BODY_TYPES.has(val.bodyType)) {
        ctx.addIssue({
          code: "custom",
          path: ["bodyType"],
          message: `Tipe bodi "${VEHICLE_BODY_TYPE_LABELS[val.bodyType]}" hanya berlaku untuk kategori Mobil.`,
        });
      }

      // 2. Strict condition vs mileageKm & ownershipCount invariants (REQ-079)
      if (val.condition === "new") {
        if (val.mileageKm !== undefined && val.mileageKm !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["mileageKm"],
            message:
              "Jarak tempuh (mileageKm) tidak diperbolehkan pada kendaraan kondisi baru (new).",
          });
        }
        if (val.ownershipCount !== undefined && val.ownershipCount !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["ownershipCount"],
            message:
              "Jumlah kepemilikan (ownershipCount) hanya berlaku untuk kendaraan kondisi bekas (used).",
          });
        }
      } else if (val.condition === "used") {
        if (val.mileageKm === undefined || val.mileageKm === null) {
          ctx.addIssue({
            code: "custom",
            path: ["mileageKm"],
            message: "Jarak tempuh (mileageKm) wajib diisi untuk kendaraan kondisi bekas (used).",
          });
        }
      }

      // 3. Strict price model validation
      switch (val.priceModel) {
        case "fixed":
        case "from": {
          if (typeof val.priceIdr !== "number") {
            ctx.addIssue({
              code: "custom",
              path: ["priceIdr"],
              message: `Nominal harga (priceIdr) wajib diisi untuk mode harga "${val.priceModel}".`,
            });
          }
          if (val.minPriceIdr !== undefined && val.minPriceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["minPriceIdr"],
              message: `minPriceIdr tidak diperbolehkan pada mode harga "${val.priceModel}".`,
            });
          }
          if (val.maxPriceIdr !== undefined && val.maxPriceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["maxPriceIdr"],
              message: `maxPriceIdr tidak diperbolehkan pada mode harga "${val.priceModel}".`,
            });
          }
          break;
        }
        case "range": {
          if (val.priceIdr !== undefined && val.priceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["priceIdr"],
              message: 'Gunakan minPriceIdr dan maxPriceIdr untuk mode harga "range".',
            });
          }
          if (typeof val.minPriceIdr !== "number") {
            ctx.addIssue({
              code: "custom",
              path: ["minPriceIdr"],
              message: 'Harga minimum (minPriceIdr) wajib diisi untuk mode harga "range".',
            });
          }
          if (typeof val.maxPriceIdr !== "number") {
            ctx.addIssue({
              code: "custom",
              path: ["maxPriceIdr"],
              message: 'Harga maksimum (maxPriceIdr) wajib diisi untuk mode harga "range".',
            });
          }
          if (
            typeof val.minPriceIdr === "number" &&
            typeof val.maxPriceIdr === "number" &&
            val.minPriceIdr >= val.maxPriceIdr
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["maxPriceIdr"],
              message: "Harga maksimum (maxPriceIdr) harus lebih besar dari harga minimum (minPriceIdr).",
            });
          }
          break;
        }
        case "on_request": {
          if (val.priceIdr !== undefined && val.priceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["priceIdr"],
              message: 'Mode harga "on_request" tidak boleh mencantumkan nominal harga numerik.',
            });
          }
          if (val.minPriceIdr !== undefined && val.minPriceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["minPriceIdr"],
              message: 'Mode harga "on_request" tidak boleh mencantumkan minPriceIdr.',
            });
          }
          if (val.maxPriceIdr !== undefined && val.maxPriceIdr !== null) {
            ctx.addIssue({
              code: "custom",
              path: ["maxPriceIdr"],
              message: 'Mode harga "on_request" tidak boleh mencantumkan maxPriceIdr.',
            });
          }
          break;
        }
      }
    });
}

export const VehicleShowroomAttributesSchema = createVehicleShowroomAttributesSchema();
export type VehicleShowroomAttributes = z.infer<typeof VehicleShowroomAttributesSchema>;

// ---------------------------------------------------------------------------
// Structured Validation Errors & Pure Strict Validator
// ---------------------------------------------------------------------------

export interface VehicleValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class VehicleValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly VehicleValidationField[];

  constructor(message: string, fields: readonly VehicleValidationField[] = []) {
    super(message);
    this.name = "VehicleValidationError";
    this.fields = fields;
  }
}

/**
 * Pure strict validator & canonical normalizer for `VehicleShowroomAttributes`.
 * - Rejects unknown keys (`UNKNOWN_FIELD`).
 * - Rejects `mileageKm` and `ownershipCount` on `"new"` vehicles (`422`).
 * - Normalizes `salesWhatsappOverride` to Indonesian E.164 digits (`628...`).
 * - Sorts `creditEstimate.dpPercents` and `creditEstimate.tenorMonths` ascending
 *   for 100% deterministic, idempotent persistence across repeated save -> reload cycles.
 */
export function validateVehicleShowroomAttributes(
  raw: unknown,
  options?: { readonly referenceYear?: number },
): VehicleShowroomAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VehicleValidationError("Atribut kendaraan showroom harus berupa objek JSON.", [
      {
        field: "vehicle",
        code: "INVALID_VEHICLE_ATTRIBUTES",
        message: "Atribut kendaraan showroom harus berupa objek JSON.",
      },
    ]);
  }

  const schema =
    options?.referenceYear !== undefined
      ? createVehicleShowroomAttributesSchema(options.referenceYear)
      : VehicleShowroomAttributesSchema;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: VehicleValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "vehicle",
      code:
        issue.code === "unrecognized_keys"
          ? "UNKNOWN_FIELD"
          : "INVALID_VEHICLE_ATTRIBUTES",
      message: issue.message,
    }));
    throw new VehicleValidationError(
      fields[0]?.message ?? "Data unit kendaraan tidak valid.",
      fields,
    );
  }

  const d = parsed.data;
  const normalizedPhone =
    typeof d.salesWhatsappOverride === "string" && d.salesWhatsappOverride.trim()
      ? normalizeIndonesianWhatsAppNumber(d.salesWhatsappOverride)
      : undefined;

  const normalizedCredit: VehicleCreditEstimateConfig | undefined = d.creditEstimate
    ? {
        enabled: d.creditEstimate.enabled,
        flatAnnualRateBps: d.creditEstimate.flatAnnualRateBps,
        dpPercents: [...d.creditEstimate.dpPercents].sort((a, b) => a - b),
        tenorMonths: [...d.creditEstimate.tenorMonths].sort((a, b) => a - b),
      }
    : undefined;

  return {
    vehicleCategory: d.vehicleCategory,
    brand: d.brand,
    model: d.model,
    ...(d.variant ? { variant: d.variant } : {}),
    year: d.year,
    condition: d.condition,
    ...(d.condition === "used" && typeof d.mileageKm === "number"
      ? { mileageKm: d.mileageKm }
      : {}),
    transmission: d.transmission,
    fuel: d.fuel,
    bodyType: d.bodyType,
    color: d.color,
    ...(typeof d.seats === "number" ? { seats: d.seats } : {}),
    ...(typeof d.engineCc === "number" ? { engineCc: d.engineCc } : {}),
    location: d.location,
    ...(d.plateRegion ? { plateRegion: d.plateRegion } : {}),
    ...(d.stnkTaxExpiryDate ? { stnkTaxExpiryDate: d.stnkTaxExpiryDate } : {}),
    ...(d.condition === "used" && typeof d.ownershipCount === "number"
      ? { ownershipCount: d.ownershipCount }
      : {}),
    priceModel: d.priceModel,
    ...(d.priceModel === "fixed" || d.priceModel === "from"
      ? typeof d.priceIdr === "number"
        ? { priceIdr: d.priceIdr }
        : {}
      : {}),
    ...(d.priceModel === "range" &&
    typeof d.minPriceIdr === "number" &&
    typeof d.maxPriceIdr === "number"
      ? { minPriceIdr: d.minPriceIdr, maxPriceIdr: d.maxPriceIdr }
      : {}),
    negotiable: d.negotiable === true,
    unitStatus: d.unitStatus,
    hideSoldInGrids: d.hideSoldInGrids === true,
    ...(d.otrPriceNote ? { otrPriceNote: d.otrPriceNote } : {}),
    ...(normalizedPhone ? { salesWhatsappOverride: normalizedPhone } : {}),
    ...(normalizedCredit ? { creditEstimate: normalizedCredit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exact BigInt Integer `round_half_up` Static Credit-Estimate Table (REQ-079)
// ---------------------------------------------------------------------------

/**
 * Exact non-negative integer `round_half_up(numerator / denominator)` using `BigInt`.
 *
 * Uses `floor((2 * numerator + denominator) / (2 * denominator))`, which is exact for
 * BOTH even and odd positive denominators with ZERO floating-point rounding drift.
 * Examples:
 * - `roundHalfUpDiv(5n, 2n)`   -> `3n` (2.5 -> 3)
 * - `roundHalfUpDiv(1n, 2n)`   -> `1n` (0.5 -> 1)
 * - `roundHalfUpDiv(7n, 3n)`   -> `2n` (2.333... -> 2)
 * - `roundHalfUpDiv(8n, 3n)`   -> `3n` (2.666... -> 3)
 */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("Denominator must be a positive BigInt.");
  }
  if (numerator < 0n) {
    throw new RangeError("Numerator must be a non-negative BigInt.");
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface StaticVehicleCreditInstallmentCell {
  readonly tenorMonths: number;
  readonly totalInterestIdr: number;
  readonly totalPayableIdr: number;
  readonly monthlyInstallmentIdr: number;
  readonly monthlyLabel: string;
}

export interface StaticVehicleCreditRow {
  readonly dpPercent: number;
  readonly dpIdr: number;
  readonly dpLabel: string;
  readonly principalIdr: number;
  readonly installments: readonly StaticVehicleCreditInstallmentCell[];
}

export interface StaticVehicleCreditEstimateTable {
  readonly priceIdr: number;
  readonly flatAnnualRateBps: number;
  readonly flatAnnualRateLabel: string;
  readonly tenorMonths: readonly number[];
  readonly rows: readonly StaticVehicleCreditRow[];
  readonly disclaimer: typeof VEHICLE_CREDIT_DISCLAIMER;
}

export interface VehicleCreditVisibilityInput {
  readonly publicationStatus?: string | null;
  readonly unitStatus?: VehicleShowroomUnitStatus | CatalogVehicleUnitStatus | string | null;
  readonly priceModel?: VehiclePriceModel | CatalogPriceMode | string | null;
  readonly priceIdr?: number | null;
  readonly creditEstimate?: VehicleCreditEstimateConfig | null;
}

/**
 * Strict visibility gate for the static server-rendered vehicle credit-estimate table (REQ-079).
 *
 * Returns `true` ONLY when ALL conditions hold:
 * 1. `publicationStatus === "published"`
 * 2. `unitStatus === "available"` (HIDDEN on `booked` and `sold`)
 * 3. `priceModel === "fixed"` (HIDDEN on `from`, `range`, `on_request`)
 * 4. Positive integer `priceIdr > 0`
 * 5. `creditEstimate.enabled === true` with valid bounded `flatAnnualRateBps`, `dpPercents` (<=3),
 *    and `tenorMonths` (<=4).
 */
export function shouldRenderVehicleCreditTable(input: VehicleCreditVisibilityInput): boolean {
  if (input.publicationStatus !== "published") return false;
  if (input.unitStatus !== "available") return false;
  if (input.priceModel !== "fixed") return false;
  if (
    typeof input.priceIdr !== "number" ||
    !Number.isSafeInteger(input.priceIdr) ||
    input.priceIdr < 1 ||
    input.priceIdr > MAX_IDR_AMOUNT
  ) {
    return false;
  }
  if (!input.creditEstimate || input.creditEstimate.enabled !== true) return false;
  const parsedCfg = VehicleCreditEstimateConfigSchema.safeParse(input.creditEstimate);
  return parsedCfg.success;
}

/**
 * Pure server-side integer static credit-estimate table generator using `BigInt` `round_half_up`:
 * - `dpIdr = roundHalfUpDiv(price * dpPct, 100)`
 * - `principalIdr = price - dpIdr`
 * - `totalInterestIdr = roundHalfUpDiv(principalIdr * flatAnnualRateBps * tenorMonths, 10_000 * 12)`
 * - `monthlyInstallmentIdr = roundHalfUpDiv(principalIdr + totalInterestIdr, tenorMonths)`
 *
 * Returns `null` if inputs are invalid or outside the bounded contract (`<=3` DP %, `<=4` tenors).
 */
export function computeStaticVehicleCreditEstimateTable(input: {
  readonly priceIdr: number;
  readonly flatAnnualRateBps: number;
  readonly dpPercents: readonly number[];
  readonly tenorMonths: readonly number[];
}): StaticVehicleCreditEstimateTable | null {
  if (
    !Number.isSafeInteger(input.priceIdr) ||
    input.priceIdr < 1 ||
    input.priceIdr > MAX_IDR_AMOUNT
  ) {
    return null;
  }

  const parsedCfg = VehicleCreditEstimateConfigSchema.safeParse({
    enabled: true,
    flatAnnualRateBps: input.flatAnnualRateBps,
    dpPercents: [...input.dpPercents],
    tenorMonths: [...input.tenorMonths],
  });
  if (!parsedCfg.success) {
    return null;
  }

  const priceBig = BigInt(input.priceIdr);
  const rateBpsBig = BigInt(parsedCfg.data.flatAnnualRateBps);
  const sortedDpPercents = [...parsedCfg.data.dpPercents].sort((a, b) => a - b);
  const sortedTenors = [...parsedCfg.data.tenorMonths].sort((a, b) => a - b);

  const rows: StaticVehicleCreditRow[] = sortedDpPercents.map((dpPercent) => {
    const dpBig = roundHalfUpDiv(priceBig * BigInt(dpPercent), 100n);
    const principalBig = priceBig - dpBig;
    const dpIdr = Number(dpBig);
    const principalIdr = Number(principalBig);

    const installments: StaticVehicleCreditInstallmentCell[] = sortedTenors.map((tenor) => {
      const tenorBig = BigInt(tenor);
      const totalInterestBig = roundHalfUpDiv(
        principalBig * rateBpsBig * tenorBig,
        10_000n * 12n,
      );
      const totalPayableBig = principalBig + totalInterestBig;
      const monthlyBig = roundHalfUpDiv(totalPayableBig, tenorBig);
      const monthlyInstallmentIdr = Number(monthlyBig);

      return {
        tenorMonths: tenor,
        totalInterestIdr: Number(totalInterestBig),
        totalPayableIdr: Number(totalPayableBig),
        monthlyInstallmentIdr,
        monthlyLabel: `${formatVehicleIdr(monthlyInstallmentIdr)} / bln`,
      };
    });

    return {
      dpPercent,
      dpIdr,
      dpLabel: `${dpPercent}% (${formatVehicleIdr(dpIdr)})`,
      principalIdr,
      installments,
    };
  });

  return {
    priceIdr: input.priceIdr,
    flatAnnualRateBps: parsedCfg.data.flatAnnualRateBps,
    flatAnnualRateLabel: `${formatFlatAnnualRateBpsLabel(parsedCfg.data.flatAnnualRateBps)} / tahun (flat)`,
    tenorMonths: sortedTenors,
    rows,
    disclaimer: VEHICLE_CREDIT_DISCLAIMER,
  };
}

/**
 * Convenience helper combining the strict visibility gate with exact `BigInt` credit calculation.
 */
export function buildGatedVehicleCreditEstimateTable(
  input: VehicleCreditVisibilityInput,
): StaticVehicleCreditEstimateTable | null {
  if (!shouldRenderVehicleCreditTable(input) || !input.creditEstimate || !input.priceIdr) {
    return null;
  }
  return computeStaticVehicleCreditEstimateTable({
    priceIdr: input.priceIdr,
    flatAnnualRateBps: input.creditEstimate.flatAnnualRateBps,
    dpPercents: input.creditEstimate.dpPercents,
    tenorMonths: input.creditEstimate.tenorMonths,
  });
}

// ---------------------------------------------------------------------------
// Grid Filtering & Direct WhatsApp Inquiry Helper
// ---------------------------------------------------------------------------

export function filterVehicleGridItems<
  T extends {
    readonly unitStatus?: VehicleShowroomUnitStatus | CatalogVehicleUnitStatus | string | null;
    readonly hideSoldInGrids?: boolean;
  },
>(
  items: readonly T[],
  options?: { readonly hideSoldInGrids?: boolean },
): readonly T[] {
  const hideGlobally = options?.hideSoldInGrids === true;
  return items.filter((item) => {
    if (item.unitStatus !== "sold") return true;
    if (hideGlobally || item.hideSoldInGrids === true) return false;
    return true;
  });
}

export function buildVehicleInquiryWhatsAppHref(params: {
  readonly salesWhatsappOverride?: string | null;
  readonly fallbackPhone?: string | null;
  readonly vehicleTitle: string;
  readonly unitStatus?: VehicleShowroomUnitStatus | CatalogVehicleUnitStatus | null;
  readonly canonicalUrl?: string | null;
}): string | null {
  const candidate =
    params.salesWhatsappOverride?.trim() || params.fallbackPhone?.trim() || "";
  if (!candidate) return null;
  const validated = validateIndonesianWhatsAppNumber(candidate);
  if (!validated.ok) return null;

  const cleanTitle = stripControlChars(params.vehicleTitle).replace(/\s+/g, " ").trim().slice(0, 180) || "unit ini";
  const baseText =
    params.unitStatus === "sold"
      ? `Halo, saya melihat unit "${cleanTitle}" berstatus TERJUAL. Apakah tersedia unit serupa yang siap dipesan?`
      : params.unitStatus === "booked"
        ? `Halo, saya tertarik dengan unit "${cleanTitle}" (status BOOKED). Mohon info ketersediaan atau unit alternatif.`
        : `Halo, saya tertarik dengan unit "${cleanTitle}". Mohon informasi ketersediaan, promo, dan jadwal lihat unit / test drive.`;

  const cleanUrl =
    typeof params.canonicalUrl === "string" && /^https:\/\//i.test(params.canonicalUrl.trim())
      ? stripControlChars(params.canonicalUrl).trim().slice(0, 300)
      : null;

  const fullText = cleanUrl ? `${baseText} Info: ${cleanUrl}` : baseText;
  return `${WA_ME_ORIGIN}/${validated.phone}?text=${encodeURIComponent(fullText)}`;
}

// ---------------------------------------------------------------------------
// Lossless Snapshot Envelope Helpers & Clean Legacy Projection
// ---------------------------------------------------------------------------

/**
 * Extracts a validated `VehicleShowroomAttributes` object from either a persisted
 * `draft_snapshot_json` (`_draftMetadata.vehicleShowroomV1`) or a frozen
 * `published_snapshot_json` (`vehicleShowroomV1`) envelope string.
 */
export function extractVehicleShowroomFromSnapshotJson(
  rawJson: string | null | undefined,
): VehicleShowroomAttributes | null {
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
    obj[VEHICLE_SNAPSHOT_METADATA_KEY] &&
    typeof obj[VEHICLE_SNAPSHOT_METADATA_KEY] === "object"
  ) {
    candidate = obj[VEHICLE_SNAPSHOT_METADATA_KEY];
  } else if (
    obj._draftMetadata &&
    typeof obj._draftMetadata === "object" &&
    !Array.isArray(obj._draftMetadata)
  ) {
    const meta = obj._draftMetadata as Record<string, unknown>;
    if (
      meta[VEHICLE_SNAPSHOT_METADATA_KEY] &&
      typeof meta[VEHICLE_SNAPSHOT_METADATA_KEY] === "object"
    ) {
      candidate = meta[VEHICLE_SNAPSHOT_METADATA_KEY];
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    return validateVehicleShowroomAttributes(candidate);
  } catch {
    return null;
  }
}

/**
 * Attaches the lossless `vehicleShowroomV1` object into an existing `draft_snapshot_json`
 * string under `_draftMetadata.vehicleShowroomV1` without altering `data` or `writeToken`.
 */
export function attachVehicleShowroomToDraftSnapshotJson(
  rawDraftSnapshotJson: string | null | undefined,
  vehicle: VehicleShowroomAttributes,
): string {
  const cleanVehicle = validateVehicleShowroomAttributes(vehicle);
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
  existingMeta[VEHICLE_SNAPSHOT_METADATA_KEY] = cleanVehicle;
  base._draftMetadata = existingMeta;
  return JSON.stringify(base);
}

/**
 * Attaches the frozen lossless `vehicleShowroomV1` object onto the outer envelope of
 * `published_snapshot_json` without mutating `envelope.data` (which stays strictly valid
 * under `OfferingSnapshotSchema`).
 */
export function attachVehicleShowroomToPublishedSnapshotJson(
  rawPublishedSnapshotJson: string | null | undefined,
  vehicle: VehicleShowroomAttributes,
): string | null {
  if (!rawPublishedSnapshotJson || !rawPublishedSnapshotJson.trim()) return null;
  const cleanVehicle = validateVehicleShowroomAttributes(vehicle);
  try {
    const parsed = JSON.parse(rawPublishedSnapshotJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      [VEHICLE_SNAPSHOT_METADATA_KEY]: cleanVehicle,
    };
    return JSON.stringify(envelope);
  } catch {
    return null;
  }
}

/**
 * Projects structured `VehicleShowroomAttributes` into the legacy `VehicleAttributes`
 * shape accepted by `packages/core/src/catalog/index.ts` & `packages/db/src/catalog/index.ts`.
 * Full structured fields (including `vehicleCategory`, `city_car`/`naked`/`trail`/`electric`,
 * pre-1980 classic years — since legacy `VehicleAttributesSchema` enforces `1980..2100` —
 * and `hideSoldInGrids`) are preserved 100% losslessly in `vehicleShowroomV1`.
 */
export function toCatalogVehicleAttributes(
  vehicle: VehicleShowroomAttributes,
): VehicleAttributes {
  const clean = validateVehicleShowroomAttributes(vehicle);
  const legacyBodyType = (
    LEGACY_CATALOG_BODY_TYPES.has(clean.bodyType) ? clean.bodyType : "other"
  ) as VehicleAttributes["bodyType"];

  return {
    brand: clean.brand,
    model: clean.model,
    ...(clean.variant ? { variant: clean.variant } : {}),
    // Legacy `VehicleAttributesSchema` bounds `year` to 1980..2100; exact classic years (1950..1979)
    // live losslessly in `vehicleShowroomV1` and are NEVER fabricated or shifted.
    ...(clean.year >= 1980 && clean.year <= 2100 ? { year: clean.year } : {}),
    condition: clean.condition,
    transmission: clean.transmission,
    fuelType: clean.fuel,
    bodyType: legacyBodyType,
    ...(clean.condition === "used" && typeof clean.mileageKm === "number"
      ? { mileageKm: clean.mileageKm }
      : {}),
    color: clean.color,
    ...(typeof clean.seats === "number" ? { seats: clean.seats } : {}),
    ...(typeof clean.engineCc === "number" ? { engineCc: clean.engineCc } : {}),
    location: clean.location,
    ...(clean.plateRegion ? { plateRegion: clean.plateRegion } : {}),
    ...(clean.stnkTaxExpiryDate ? { stnkExpiry: clean.stnkTaxExpiryDate } : {}),
    ...(clean.condition === "used" && typeof clean.ownershipCount === "number"
      ? { ownershipCount: clean.ownershipCount }
      : {}),
    ...(clean.otrPriceNote ? { otrPriceNote: clean.otrPriceNote } : {}),
    unitStatus: clean.unitStatus,
    creditEstimateEnabled: clean.creditEstimate?.enabled === true,
    ...(clean.creditEstimate
      ? {
          creditEstimateConfig: {
            annualFlatRateBps: clean.creditEstimate.flatAnnualRateBps,
            dpPercents: [...clean.creditEstimate.dpPercents],
            tenorMonths: [...clean.creditEstimate.tenorMonths],
          },
        }
      : {}),
  };
}

export interface CatalogVehiclePricingProjection {
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
}

export function toCatalogVehiclePricing(
  vehicle: VehicleShowroomAttributes,
): CatalogVehiclePricingProjection {
  const clean = validateVehicleShowroomAttributes(vehicle);
  switch (clean.priceModel) {
    case "fixed":
    case "from":
      return {
        priceMode: clean.priceModel,
        price: clean.priceIdr ?? null,
        priceMax: null,
        negotiable: clean.negotiable,
      };
    case "range":
      return {
        priceMode: "range",
        price: clean.minPriceIdr ?? null,
        priceMax: clean.maxPriceIdr ?? null,
        negotiable: clean.negotiable,
      };
    case "on_request":
      return {
        priceMode: "on_request",
        price: null,
        priceMax: null,
        negotiable: clean.negotiable,
      };
  }
}

/**
 * Truthful nullable display model for rendering either full `vehicleShowroomV1` snapshots
 * OR partial legacy `VehicleAttributes` rows WITHOUT inventing any missing facts
 * (never fabricates `mileageKm: 0`, current `year`, `color: "Standar"`, `location: "Indonesia"`,
 * `condition: "used"`, or first-word `brand`).
 */
export interface PartialVehicleDisplayModel {
  readonly vehicleCategory: VehicleCategory | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly variant: string | null;
  readonly year: number | null;
  readonly condition: VehicleCondition | null;
  readonly mileageKm: number | null;
  readonly transmission: VehicleTransmission | null;
  readonly fuel: VehicleFuel | null;
  readonly bodyType: VehicleBodyType | null;
  readonly color: string | null;
  readonly seats: number | null;
  readonly engineCc: number | null;
  readonly location: string | null;
  readonly plateRegion: string | null;
  readonly stnkTaxExpiryDate: string | null;
  readonly ownershipCount: number | null;
  readonly priceModel: VehiclePriceModel;
  readonly priceIdr: number | null;
  readonly minPriceIdr: number | null;
  readonly maxPriceIdr: number | null;
  readonly negotiable: boolean;
  readonly unitStatus: VehicleShowroomUnitStatus;
  readonly hideSoldInGrids: boolean;
  readonly otrPriceNote: string | null;
  readonly salesWhatsappOverride: string | null;
  readonly creditEstimate: VehicleCreditEstimateConfig | null;
}

function cleanOptionalDisplayText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;
  return trimmed.slice(0, maxLen);
}

/**
 * Converts either a full `VehicleShowroomAttributes` snapshot or a partial/legacy
 * `VehicleAttributes` object into a truthful `PartialVehicleDisplayModel` with ZERO
 * fabricated defaults: missing fields stay `null` and are omitted from visible UI.
 */
export function normalizeVehicleDisplayModel(
  raw: Record<string, unknown> | VehicleShowroomAttributes | VehicleAttributes | null | undefined,
  fallback?: {
    readonly priceMode?: CatalogPriceMode | null;
    readonly price?: number | null;
    readonly priceMax?: number | null;
    readonly negotiable?: boolean | null;
    readonly unitStatus?: CatalogVehicleUnitStatus | null;
  },
): PartialVehicleDisplayModel {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // Fast path: validated full `VehicleShowroomAttributes`
  const strict = VehicleShowroomAttributesSchema.safeParse(src);
  if (strict.success) {
    const clean = validateVehicleShowroomAttributes(strict.data);
    return {
      vehicleCategory: clean.vehicleCategory,
      brand: clean.brand,
      model: clean.model,
      variant: clean.variant ?? null,
      year: clean.year,
      condition: clean.condition,
      mileageKm: clean.condition === "used" && typeof clean.mileageKm === "number" ? clean.mileageKm : null,
      transmission: clean.transmission,
      fuel: clean.fuel,
      bodyType: clean.bodyType,
      color: clean.color,
      seats: typeof clean.seats === "number" ? clean.seats : null,
      engineCc: typeof clean.engineCc === "number" ? clean.engineCc : null,
      location: clean.location,
      plateRegion: clean.plateRegion ?? null,
      stnkTaxExpiryDate: clean.stnkTaxExpiryDate ?? null,
      ownershipCount:
        clean.condition === "used" && typeof clean.ownershipCount === "number"
          ? clean.ownershipCount
          : null,
      priceModel: clean.priceModel,
      priceIdr: typeof clean.priceIdr === "number" ? clean.priceIdr : null,
      minPriceIdr: typeof clean.minPriceIdr === "number" ? clean.minPriceIdr : null,
      maxPriceIdr: typeof clean.maxPriceIdr === "number" ? clean.maxPriceIdr : null,
      negotiable: clean.negotiable,
      unitStatus: clean.unitStatus,
      hideSoldInGrids: clean.hideSoldInGrids,
      otrPriceNote: clean.otrPriceNote ?? null,
      salesWhatsappOverride: clean.salesWhatsappOverride ?? null,
      creditEstimate: clean.creditEstimate ?? null,
    };
  }

  // Truthful partial extraction for legacy rows — NEVER fabricate missing specs!
  const rawBody = typeof src.bodyType === "string" ? src.bodyType.trim().toLowerCase() : null;
  const bodyType: VehicleBodyType | null =
    rawBody && (VEHICLE_BODY_TYPES as readonly string[]).includes(rawBody)
      ? (rawBody as VehicleBodyType)
      : null;

  const vehicleCategory: VehicleCategory | null =
    src.vehicleCategory === "car" || src.vehicleCategory === "motorcycle"
      ? src.vehicleCategory
      : bodyType && MOTORCYCLE_ONLY_BODY_TYPES.has(bodyType)
        ? "motorcycle"
        : bodyType && CAR_ONLY_BODY_TYPES.has(bodyType)
          ? "car"
          : null;

  const condition: VehicleCondition | null =
    src.condition === "new" || src.condition === "used" ? src.condition : null;

  const rawYear =
    typeof src.year === "number"
      ? src.year
      : typeof src.vehicleYear === "number"
        ? src.vehicleYear
        : null;
  const maxYear = getMaxAllowedVehicleYear();
  const year =
    rawYear !== null && Number.isSafeInteger(rawYear) && rawYear >= MIN_VEHICLE_YEAR && rawYear <= maxYear
      ? rawYear
      : null;

  // NEVER fabricate `mileageKm: 0` when missing; NEVER emit mileage when condition !== "used"
  const mileageKm =
    condition === "used" &&
    typeof src.mileageKm === "number" &&
    Number.isSafeInteger(src.mileageKm) &&
    src.mileageKm >= 0 &&
    src.mileageKm <= MAX_VEHICLE_MILEAGE_KM
      ? src.mileageKm
      : null;

  const transmission: VehicleTransmission | null =
    typeof src.transmission === "string" &&
    (VEHICLE_TRANSMISSIONS as readonly string[]).includes(src.transmission)
      ? (src.transmission as VehicleTransmission)
      : null;

  const rawFuel =
    typeof src.fuel === "string" ? src.fuel : typeof src.fuelType === "string" ? src.fuelType : null;
  const fuel: VehicleFuel | null =
    rawFuel && (VEHICLE_FUELS as readonly string[]).includes(rawFuel) ? (rawFuel as VehicleFuel) : null;

  const unitStatus: VehicleShowroomUnitStatus =
    src.unitStatus === "available" || src.unitStatus === "booked" || src.unitStatus === "sold"
      ? src.unitStatus
      : fallback?.unitStatus === "available" ||
          fallback?.unitStatus === "booked" ||
          fallback?.unitStatus === "sold"
        ? fallback.unitStatus
        : "available";

  const rawPriceMode =
    typeof src.priceModel === "string" &&
    (VEHICLE_PRICE_MODELS as readonly string[]).includes(src.priceModel)
      ? (src.priceModel as VehiclePriceModel)
      : fallback?.priceMode ?? "on_request";

  let priceModel: VehiclePriceModel = rawPriceMode;
  let priceIdr: number | null = null;
  let minPriceIdr: number | null = null;
  let maxPriceIdr: number | null = null;

  if (priceModel === "fixed" || priceModel === "from") {
    const p = typeof src.priceIdr === "number" ? src.priceIdr : fallback?.price;
    if (typeof p === "number" && Number.isSafeInteger(p) && p >= 1 && p <= MAX_IDR_AMOUNT) {
      priceIdr = p;
    } else {
      priceModel = "on_request";
    }
  } else if (priceModel === "range") {
    const lo = typeof src.minPriceIdr === "number" ? src.minPriceIdr : fallback?.price;
    const hi = typeof src.maxPriceIdr === "number" ? src.maxPriceIdr : fallback?.priceMax;
    if (
      typeof lo === "number" &&
      Number.isSafeInteger(lo) &&
      lo >= 1 &&
      typeof hi === "number" &&
      Number.isSafeInteger(hi) &&
      hi > lo &&
      hi <= MAX_IDR_AMOUNT
    ) {
      minPriceIdr = lo;
      maxPriceIdr = hi;
    } else {
      priceModel = "on_request";
    }
  }

  let creditEstimate: VehicleCreditEstimateConfig | null = null;
  if (src.creditEstimate && typeof src.creditEstimate === "object") {
    const parsedCredit = VehicleCreditEstimateConfigSchema.safeParse(src.creditEstimate);
    if (parsedCredit.success) creditEstimate = parsedCredit.data;
  } else if (src.creditEstimateConfig && typeof src.creditEstimateConfig === "object") {
    const legacyCfg = src.creditEstimateConfig as Record<string, unknown>;
    const parsedLegacy = VehicleCreditEstimateConfigSchema.safeParse({
      enabled: src.creditEstimateEnabled === true,
      flatAnnualRateBps: legacyCfg.annualFlatRateBps,
      dpPercents: legacyCfg.dpPercents,
      tenorMonths: legacyCfg.tenorMonths,
    });
    if (parsedLegacy.success) creditEstimate = parsedLegacy.data;
  }

  let salesWhatsappOverride: string | null = null;
  if (typeof src.salesWhatsappOverride === "string" && src.salesWhatsappOverride.trim()) {
    const res = validateIndonesianWhatsAppNumber(src.salesWhatsappOverride);
    if (res.ok) salesWhatsappOverride = res.phone;
  }

  return {
    vehicleCategory,
    brand: cleanOptionalDisplayText(src.brand, 80),
    model: cleanOptionalDisplayText(src.model, 100),
    variant: cleanOptionalDisplayText(src.variant, 100),
    year,
    condition,
    mileageKm,
    transmission,
    fuel,
    bodyType,
    color: cleanOptionalDisplayText(src.color, 60),
    seats:
      typeof src.seats === "number" && Number.isSafeInteger(src.seats) && src.seats >= 1 && src.seats <= 60
        ? src.seats
        : null,
    engineCc:
      typeof src.engineCc === "number" &&
      Number.isSafeInteger(src.engineCc) &&
      src.engineCc >= 50 &&
      src.engineCc <= 20_000
        ? src.engineCc
        : null,
    location: cleanOptionalDisplayText(src.location, 120),
    plateRegion: cleanOptionalDisplayText(src.plateRegion, 40),
    stnkTaxExpiryDate:
      typeof src.stnkTaxExpiryDate === "string" && isValidVehicleDateOnly(src.stnkTaxExpiryDate)
        ? src.stnkTaxExpiryDate
        : typeof src.stnkExpiry === "string" && isValidVehicleDateOnly(src.stnkExpiry)
          ? src.stnkExpiry
          : null,
    ownershipCount:
      condition === "used" &&
      typeof src.ownershipCount === "number" &&
      Number.isSafeInteger(src.ownershipCount) &&
      src.ownershipCount >= 1 &&
      src.ownershipCount <= MAX_VEHICLE_OWNERSHIP_COUNT
        ? src.ownershipCount
        : null,
    priceModel,
    priceIdr,
    minPriceIdr,
    maxPriceIdr,
    negotiable: src.negotiable === true || (src.negotiable === undefined && fallback?.negotiable === true),
    unitStatus,
    hideSoldInGrids: src.hideSoldInGrids === true,
    otrPriceNote: cleanOptionalDisplayText(src.otrPriceNote, 240),
    salesWhatsappOverride,
    creditEstimate,
  };
}

/**
 * Strictly normalizes a complete `VehicleShowroomAttributes` object ONLY when all required
 * facts are genuinely present (returns `null` instead of fabricating defaults like `mileageKm: 0`,
 * current year, `"Standar"`, or `"Indonesia"`). Use `normalizeVehicleDisplayModel` when rendering
 * partial legacy records truthfully.
 */
export function normalizeVehicleShowroomModel(
  raw: Record<string, unknown> | VehicleShowroomAttributes | VehicleAttributes | null | undefined,
  fallback?: {
    readonly priceMode?: CatalogPriceMode | null;
    readonly price?: number | null;
    readonly priceMax?: number | null;
    readonly negotiable?: boolean | null;
    readonly unitStatus?: CatalogVehicleUnitStatus | null;
  },
): VehicleShowroomAttributes | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const strict = VehicleShowroomAttributesSchema.safeParse(raw);
  if (strict.success) {
    return validateVehicleShowroomAttributes(strict.data);
  }

  const partial = normalizeVehicleDisplayModel(raw, fallback);
  if (
    !partial.vehicleCategory ||
    !partial.brand ||
    !partial.model ||
    partial.year === null ||
    !partial.condition ||
    !partial.transmission ||
    !partial.fuel ||
    !partial.bodyType ||
    !partial.color ||
    !partial.location
  ) {
    return null;
  }
  if (partial.condition === "used" && partial.mileageKm === null) {
    return null;
  }

  try {
    return validateVehicleShowroomAttributes({
      vehicleCategory: partial.vehicleCategory,
      brand: partial.brand,
      model: partial.model,
      ...(partial.variant ? { variant: partial.variant } : {}),
      year: partial.year,
      condition: partial.condition,
      ...(partial.condition === "used" && partial.mileageKm !== null
        ? { mileageKm: partial.mileageKm }
        : {}),
      transmission: partial.transmission,
      fuel: partial.fuel,
      bodyType: partial.bodyType,
      color: partial.color,
      ...(partial.seats !== null ? { seats: partial.seats } : {}),
      ...(partial.engineCc !== null ? { engineCc: partial.engineCc } : {}),
      location: partial.location,
      ...(partial.plateRegion ? { plateRegion: partial.plateRegion } : {}),
      ...(partial.stnkTaxExpiryDate ? { stnkTaxExpiryDate: partial.stnkTaxExpiryDate } : {}),
      ...(partial.condition === "used" && partial.ownershipCount !== null
        ? { ownershipCount: partial.ownershipCount }
        : {}),
      priceModel: partial.priceModel,
      ...(partial.priceIdr !== null ? { priceIdr: partial.priceIdr } : {}),
      ...(partial.minPriceIdr !== null ? { minPriceIdr: partial.minPriceIdr } : {}),
      ...(partial.maxPriceIdr !== null ? { maxPriceIdr: partial.maxPriceIdr } : {}),
      negotiable: partial.negotiable,
      unitStatus: partial.unitStatus,
      hideSoldInGrids: partial.hideSoldInGrids,
      ...(partial.otrPriceNote ? { otrPriceNote: partial.otrPriceNote } : {}),
      ...(partial.salesWhatsappOverride ? { salesWhatsappOverride: partial.salesWhatsappOverride } : {}),
      ...(partial.creditEstimate ? { creditEstimate: partial.creditEstimate } : {}),
    });
  } catch {
    return null;
  }
}
