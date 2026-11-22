import { z } from "zod";
import {
  assertNoForbiddenTenantSelectors,
  PublicationValidationError,
  sanitizePublishedHtmlFragment,
} from "../content/index.ts";
import { validateExternalLink } from "../link-sanitizer.ts";
import { ResourceSeoInputSchema, RestrictedRichTextDocSchema } from "../schemas/cms.ts";
import {
  IdrAmountSchema,
  IsoDateSchema,
  OfferingCtaKindSchema,
  OfferingTypeSchema,
  PriceModeSchema,
  RESERVED_PUBLIC_SLUGS,
  SequentialIdSchema,
  SlugSchema,
  VehicleUnitStatusSchema,
  VersionSchema,
} from "../schemas/common.ts";
import type { PublicOfferingAttributesSchema } from "../schemas/public-dto.ts";
import {
  formatOfferingPrice,
  renderWhatsAppTemplate,
  validateIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "../wa-dispatcher.ts";

/**
 * Typed Offerings (`service`, `product`, `tour`, `vehicle`) & Categories Domain
 * Validator (`packages/core/src/catalog/index.ts`; TASK-009, REQ-012, REQ-013,
 * REQ-016, REQ-061, REQ-079, PLAN §5.2, §7.1, §7.3, §19.1).
 */

export const OFFERING_TYPES = ["service", "product", "tour", "vehicle"] as const;
export type CatalogOfferingType = (typeof OFFERING_TYPES)[number];

export const OFFERING_PUBLIC_BASE_PATHS: Readonly<Record<CatalogOfferingType, string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

export const OFFERING_SLUG_NAMESPACES = {
  service: "layanan",
  product: "produk",
  tour: "tour",
  vehicle: "kendaraan",
} as const satisfies Record<CatalogOfferingType, string>;

export type OfferingSlugNamespace =
  (typeof OFFERING_SLUG_NAMESPACES)[CatalogOfferingType];

export const CATEGORY_SLUG_NAMESPACE = "offering_category" as const;

export const PRICE_MODES = ["fixed", "from", "range", "on_request"] as const;
export type CatalogPriceMode = (typeof PRICE_MODES)[number];

export const CTA_MODES = ["whatsapp", "external_link", "inquiry", "book"] as const;
export type CatalogCtaMode = (typeof CTA_MODES)[number];

export const VEHICLE_UNIT_STATUSES = ["available", "booked", "sold"] as const;
export type CatalogVehicleUnitStatus = (typeof VEHICLE_UNIT_STATUSES)[number];

export const MAX_GALLERY_MEDIA_IDS = 12 as const;
export const MAX_OFFERING_CATEGORIES = 10 as const;
export const MAX_OFFERING_BADGES = 5 as const;
export const MAX_BADGE_LENGTH = 40 as const;
export const MAX_SLUG_LENGTH = 80 as const;
export const MAX_CATEGORY_DEPTH = 3 as const;
export const MAX_IDR_AMOUNT = 999_999_999_999 as const;

const RESERVED_CATALOG_SLUGS: ReadonlySet<string> = new Set([
  ...RESERVED_PUBLIC_SLUGS,
  ".well-known",
]);

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// ---------------------------------------------------------------------------
// Structured Validation Errors
// ---------------------------------------------------------------------------

export interface CatalogValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class CatalogValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly CatalogValidationField[];
  readonly suggestedSlug?: string;

  constructor(
    message: string,
    fields: readonly CatalogValidationField[] = [],
    options?: { readonly suggestedSlug?: string },
  ) {
    super(message);
    this.name = "CatalogValidationError";
    this.fields = fields;
    this.suggestedSlug = options?.suggestedSlug;
  }
}

// ---------------------------------------------------------------------------
// Canonical Path & Namespace Helpers
// ---------------------------------------------------------------------------

export function isCatalogOfferingType(value: unknown): value is CatalogOfferingType {
  return typeof value === "string" && (OFFERING_TYPES as readonly string[]).includes(value);
}

export function getOfferingPublicBasePath(offeringType: CatalogOfferingType): string {
  return OFFERING_PUBLIC_BASE_PATHS[offeringType];
}

export function getOfferingPublicPath(offeringType: CatalogOfferingType, slug: string): string {
  return `${OFFERING_PUBLIC_BASE_PATHS[offeringType]}/${slug}`;
}

export function getOfferingSlugNamespace(
  offeringType: CatalogOfferingType,
): OfferingSlugNamespace {
  return OFFERING_SLUG_NAMESPACES[offeringType];
}

export function getCategoryPublicPath(
  offeringType: CatalogOfferingType | null | undefined,
  slug: string,
): string {
  const base = offeringType ? OFFERING_PUBLIC_BASE_PATHS[offeringType] : "/katalog";
  return `${base}/category/${slug}`;
}

// ---------------------------------------------------------------------------
// Slug Normalization & Reserved Slug Policy (REQ-061, PLAN §7.1 & §7.3)
// ---------------------------------------------------------------------------

export function isReservedCatalogSlug(slug: string): boolean {
  return RESERVED_CATALOG_SLUGS.has(slug.trim().toLowerCase());
}

/**
 * Generates an SEO-friendly ASCII slug per PLAN §7.1:
 * Unicode NFKD -> strip diacritics -> lowercase -> replace non `[a-z0-9]` runs with `-`
 * -> trim hyphens -> cap at 80 characters on a word boundary.
 */
export function normalizeSlugSegment(raw: string, maxLength: number = MAX_SLUG_LENGTH): string {
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (ascii.length <= maxLength) {
    return ascii;
  }

  const sliced = ascii.slice(0, maxLength);
  const lastHyphen = sliced.lastIndexOf("-");
  // Keep a clean word boundary when the hyphen is reasonably near the end
  if (lastHyphen >= Math.floor(maxLength * 0.4)) {
    return sliced.slice(0, lastHyphen).replace(/-+$/g, "");
  }
  return sliced.replace(/-+$/g, "");
}

export function appendNumericSlugSuffix(baseSlug: string, suffix: number): string {
  const suffixText = `-${suffix}`;
  const maxBaseLength = Math.max(1, MAX_SLUG_LENGTH - suffixText.length);
  let trimmedBase = baseSlug;
  if (trimmedBase.length > maxBaseLength) {
    trimmedBase = normalizeSlugSegment(trimmedBase, maxBaseLength);
  }
  trimmedBase = trimmedBase.replace(/-+$/g, "");
  if (!trimmedBase) {
    trimmedBase = "item";
  }
  return `${trimmedBase}${suffixText}`;
}

export function generateSlugFromTitle(
  title: string,
  fallbackPrefix: string,
  sequenceId: number,
): string {
  const normalized = normalizeSlugSegment(title, MAX_SLUG_LENGTH);
  if (!normalized || isReservedCatalogSlug(normalized)) {
    const safePrefix = normalizeSlugSegment(fallbackPrefix, 40) || "item";
    return appendNumericSlugSuffix(safePrefix, sequenceId);
  }
  return normalized;
}

export function validateManualSlug(rawSlug: unknown, field = "slug"): string {
  if (typeof rawSlug !== "string") {
    throw new CatalogValidationError("Slug harus berupa teks.", [
      { field, code: "INVALID_SLUG", message: "Slug must be a string." },
    ]);
  }
  const trimmed = rawSlug.trim();
  const parsed = SlugSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new CatalogValidationError(
      "Format slug tidak valid. Gunakan huruf kecil ASCII, angka, dan tanda hubung (maks 80 karakter).",
      [
        {
          field,
          code: "INVALID_SLUG",
          message: parsed.error.issues[0]?.message ?? "Invalid slug format.",
        },
      ],
    );
  }
  if (isReservedCatalogSlug(parsed.data)) {
    throw new CatalogValidationError(`Slug "${parsed.data}" dicadangkan oleh sistem.`, [
      {
        field,
        code: "RESERVED_SLUG",
        message: `Slug "${parsed.data}" is reserved and cannot be used.`,
      },
    ]);
  }
  return parsed.data;
}

export function buildUniqueAutoSlug(
  baseSlug: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isReservedCatalogSlug(baseSlug) && !isTaken(baseSlug)) {
    return baseSlug;
  }
  for (let n = 2; n <= 10_000; n += 1) {
    const candidate = appendNumericSlugSuffix(baseSlug, n);
    if (!isReservedCatalogSlug(candidate) && !isTaken(candidate)) {
      return candidate;
    }
  }
  throw new CatalogValidationError("Tidak dapat menghasilkan slug unik.", [
    {
      field: "slug",
      code: "SLUG_CONFLICT",
      message: "Exhausted automatic slug collision suffixes.",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Strict Per-Type JSON Attributes Schemas (Zod `.strict()`)
// ---------------------------------------------------------------------------

export const ServiceTierSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    summary: z.string().trim().max(240).optional(),
    price: IdrAmountSchema.nullable().optional(),
  })
  .strict();

export const ServiceAttributesSchema = z
  .object({
    duration: z.string().trim().min(1).max(120).optional(),
    deliverables: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    turnaround: z.string().trim().min(1).max(120).optional(),
    serviceMode: z.enum(["onsite", "remote", "hybrid", "in_store"]).optional(),
    serviceSteps: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
    serviceArea: z.string().trim().min(1).max(160).optional(),
    warranty: z.string().trim().min(1).max(160).optional(),
    tiers: z.array(ServiceTierSchema).max(6).optional(),
  })
  .strict();

export const ProductVariantSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    values: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  })
  .strict();

export const ProductSpecItemSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

export const ProductAttributesSchema = z
  .object({
    sku: z.string().trim().min(1).max(64).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    stockStatus: z.enum(["ready", "preorder", "limited", "out_of_stock"]).optional(),
    moq: z.number().int().min(1).max(1_000_000).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    weightGrams: z.number().int().min(1).max(10_000_000).optional(),
    dimensions: z.string().trim().min(1).max(100).optional(),
    material: z.string().trim().min(1).max(120).optional(),
    variants: z.array(ProductVariantSchema).max(10).optional(),
    specs: z.array(ProductSpecItemSchema).max(20).optional(),
  })
  .strict();

export const TourDepartureSchema = z
  .object({
    departureDate: IsoDateSchema,
    seatsAvailable: z.number().int().min(0).max(1000).optional(),
    status: z.enum(["open", "limited", "full", "closed"]).default("open"),
    note: z.string().trim().max(160).optional(),
  })
  .strict();

export const TourItineraryDaySchema = z
  .object({
    day: z.number().int().min(1).max(90),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();

export const TourAttributesSchema = z
  .object({
    durationDays: z.number().int().min(1).max(90).optional(),
    durationNights: z.number().int().min(0).max(90).optional(),
    destination: z.string().trim().min(1).max(160).optional(),
    departureCity: z.string().trim().min(1).max(120).optional(),
    departures: z.array(TourDepartureSchema).max(36).optional(),
    departureDates: z.array(IsoDateSchema).max(36).optional(),
    inclusions: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    exclusions: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    itinerary: z.array(TourItineraryDaySchema).max(30).optional(),
    airline: z.string().trim().min(1).max(120).optional(),
    hotel: z.string().trim().min(1).max(160).optional(),
    umrahLicense: z.string().trim().min(1).max(120).optional(),
    ppiuNumber: z.string().trim().min(1).max(120).optional(),
    minPax: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const VehicleCreditEstimateConfigSchema = z
  .object({
    annualFlatRateBps: z.number().int().min(0).max(5000),
    dpPercents: z.array(z.number().int().min(10).max(80)).min(1).max(3),
    tenorMonths: z.array(z.number().int().min(6).max(84)).min(1).max(4),
  })
  .strict();

export const VehicleAttributesSchema = z
  .object({
    brand: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    variant: z.string().trim().min(1).max(100).optional(),
    year: z.number().int().min(1980).max(2100).optional(),
    condition: z.enum(["new", "used"]).optional(),
    transmission: z.enum(["manual", "automatic", "cvt", "dct", "ev"]).optional(),
    fuelType: z.enum(["bensin", "diesel", "hybrid", "listrik"]).optional(),
    bodyType: z
      .enum([
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
      ])
      .optional(),
    mileageKm: z.number().int().min(0).max(2_000_000).optional(),
    color: z.string().trim().min(1).max(60).optional(),
    seats: z.number().int().min(1).max(60).optional(),
    engineCc: z.number().int().min(50).max(20_000).optional(),
    location: z.string().trim().min(1).max(120).optional(),
    plateRegion: z.string().trim().min(1).max(40).optional(),
    stnkExpiry: IsoDateSchema.optional(),
    ownershipCount: z.number().int().min(1).max(20).optional(),
    otrPriceNote: z.string().trim().min(1).max(240).optional(),
    unitStatus: VehicleUnitStatusSchema.optional(),
    creditEstimateEnabled: z.boolean().optional(),
    creditEstimateConfig: VehicleCreditEstimateConfigSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.condition === "new" && val.mileageKm !== undefined && val.mileageKm > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["mileageKm"],
        message: "New vehicles cannot declare positive used mileageKm.",
      });
    }
  });

export type ServiceAttributes = z.infer<typeof ServiceAttributesSchema>;
export type ProductAttributes = z.infer<typeof ProductAttributesSchema>;
export type TourAttributes = z.infer<typeof TourAttributesSchema>;
export type VehicleAttributes = z.infer<typeof VehicleAttributesSchema>;

export interface OfferingAttributesMap {
  readonly service: ServiceAttributes;
  readonly product: ProductAttributes;
  readonly tour: TourAttributes;
  readonly vehicle: VehicleAttributes;
}

export type CatalogOfferingAttributes =
  | ServiceAttributes
  | ProductAttributes
  | TourAttributes
  | VehicleAttributes;

export const OFFERING_ATTRIBUTES_SCHEMAS = {
  service: ServiceAttributesSchema,
  product: ProductAttributesSchema,
  tour: TourAttributesSchema,
  vehicle: VehicleAttributesSchema,
} as const;

export function validateOfferingAttributes<T extends CatalogOfferingType>(
  offeringType: T,
  rawAttributes: unknown,
): OfferingAttributesMap[T] {
  const input = rawAttributes === undefined || rawAttributes === null ? {} : rawAttributes;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new CatalogValidationError("Atribut penawaran harus berupa objek JSON.", [
      {
        field: "attributes",
        code: "INVALID_ATTRIBUTES",
        message: "Offering attributes must be a JSON object.",
      },
    ]);
  }
  const schema = OFFERING_ATTRIBUTES_SCHEMAS[offeringType];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields: CatalogValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? `attributes.${issue.path.join(".")}` : "attributes",
      code: "INVALID_ATTRIBUTES",
      message: issue.message,
    }));
    throw new CatalogValidationError(
      `Atribut tidak valid untuk tipe penawaran "${offeringType}".`,
      fields,
    );
  }
  return parsed.data as OfferingAttributesMap[T];
}

/**
 * Projects full per-type catalog attributes onto the canonical `PublicOfferingAttributesSchema`
 * subset used by `publishResourceAtomically` (`OfferingSnapshotSchema`).
 */
export function projectToPublicOfferingAttributes(
  offeringType: CatalogOfferingType,
  attributes: CatalogOfferingAttributes,
): z.infer<typeof PublicOfferingAttributesSchema> {
  const projected: Record<string, unknown> = {};
  switch (offeringType) {
    case "service": {
      const a = attributes as ServiceAttributes;
      if (a.serviceSteps && a.serviceSteps.length > 0) {
        projected.serviceSteps = a.serviceSteps.slice(0, 12);
      } else if (a.deliverables && a.deliverables.length > 0) {
        projected.serviceSteps = a.deliverables.slice(0, 12);
      }
      if (a.serviceArea) projected.serviceArea = a.serviceArea;
      break;
    }
    case "product": {
      // Product showcase fields live in full attributes_json; PublicOfferingAttributes carries no product-only keys yet.
      break;
    }
    case "tour": {
      const a = attributes as TourAttributes;
      if (a.destination) projected.destination = a.destination;
      if (a.durationDays !== undefined) projected.durationDays = a.durationDays;
      if (a.departures && a.departures.length > 0) {
        projected.departureDates = a.departures.map((d) => d.departureDate).slice(0, 36);
      } else if (a.departureDates && a.departureDates.length > 0) {
        projected.departureDates = a.departureDates.slice(0, 36);
      }
      if (a.inclusions && a.inclusions.length > 0) projected.inclusions = a.inclusions.slice(0, 20);
      if (a.exclusions && a.exclusions.length > 0) projected.exclusions = a.exclusions.slice(0, 20);
      break;
    }
    case "vehicle": {
      const a = attributes as VehicleAttributes;
      if (a.year !== undefined) projected.vehicleYear = a.year;
      if (a.transmission) projected.transmission = a.transmission;
      if (a.fuelType) projected.fuelType = a.fuelType;
      if (a.mileageKm !== undefined) projected.mileageKm = a.mileageKm;
      if (a.creditEstimateEnabled !== undefined) {
        projected.creditEstimateEnabled = a.creditEstimateEnabled;
      }
      break;
    }
  }
  return projected as z.infer<typeof PublicOfferingAttributesSchema>;
}

// ---------------------------------------------------------------------------
// Strict Pricing Validation (REQ-016, PLAN §5 & §19.1)
// ---------------------------------------------------------------------------

export interface CatalogPricingInput {
  readonly priceMode: unknown;
  readonly price?: unknown;
  readonly priceMax?: unknown;
  readonly negotiable?: unknown;
  readonly originalAmount?: unknown;
}

export interface ValidatedCatalogPricing {
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
  readonly originalAmount: number | null;
}

function parseOptionalIdrAmount(
  raw: unknown,
  field: string,
  errors: CatalogValidationField[],
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_IDR_AMOUNT) {
    errors.push({
      field,
      code: "INVALID_PRICE",
      message: `${field} must be a non-negative integer between 0 and ${MAX_IDR_AMOUNT}.`,
    });
    return null;
  }
  return raw;
}

export function validateCatalogPricing(input: CatalogPricingInput): ValidatedCatalogPricing {
  const errors: CatalogValidationField[] = [];
  const modeRes = PriceModeSchema.safeParse(input.priceMode);
  if (!modeRes.success) {
    throw new CatalogValidationError("Mode harga tidak valid.", [
      {
        field: "priceMode",
        code: "INVALID_PRICE",
        message: "priceMode must be one of fixed, from, range, or on_request.",
      },
    ]);
  }
  const priceMode = modeRes.data;

  let negotiable = false;
  if (input.negotiable !== undefined) {
    if (typeof input.negotiable !== "boolean") {
      errors.push({
        field: "negotiable",
        code: "INVALID_PRICE",
        message: "negotiable must be a boolean.",
      });
    } else {
      negotiable = input.negotiable;
    }
  }

  const price = parseOptionalIdrAmount(input.price, "price", errors);
  const priceMax = parseOptionalIdrAmount(input.priceMax, "priceMax", errors);
  const originalAmount = parseOptionalIdrAmount(input.originalAmount, "originalAmount", errors);

  if (errors.length > 0) {
    throw new CatalogValidationError("Konfigurasi harga penawaran tidak valid.", errors);
  }

  switch (priceMode) {
    case "fixed":
    case "from": {
      if (price === null) {
        errors.push({
          field: "price",
          code: "INVALID_PRICE",
          message: `price is required when priceMode is "${priceMode}".`,
        });
      }
      if (priceMax !== null) {
        errors.push({
          field: "priceMax",
          code: "INVALID_PRICE",
          message: `priceMax is not allowed when priceMode is "${priceMode}".`,
        });
      }
      break;
    }
    case "range": {
      if (price === null) {
        errors.push({
          field: "price",
          code: "INVALID_PRICE",
          message: 'price is required when priceMode is "range".',
        });
      }
      if (priceMax === null) {
        errors.push({
          field: "priceMax",
          code: "INVALID_PRICE",
          message: 'priceMax is required when priceMode is "range".',
        });
      } else if (price !== null && priceMax < price) {
        errors.push({
          field: "priceMax",
          code: "INVALID_PRICE",
          message: "priceMax must be greater than or equal to price in range mode.",
        });
      }
      break;
    }
    case "on_request": {
      if (price !== null) {
        errors.push({
          field: "price",
          code: "INVALID_PRICE",
          message: 'price must be omitted or null when priceMode is "on_request".',
        });
      }
      if (priceMax !== null) {
        errors.push({
          field: "priceMax",
          code: "INVALID_PRICE",
          message: 'priceMax must be omitted or null when priceMode is "on_request".',
        });
      }
      if (originalAmount !== null) {
        errors.push({
          field: "originalAmount",
          code: "INVALID_PRICE",
          message: 'originalAmount must be omitted or null when priceMode is "on_request".',
        });
      }
      break;
    }
  }

  if (originalAmount !== null && price !== null && originalAmount <= price) {
    errors.push({
      field: "originalAmount",
      code: "INVALID_PRICE",
      message: "originalAmount must strictly exceed price when present.",
    });
  }

  if (errors.length > 0) {
    throw new CatalogValidationError("Konfigurasi harga penawaran tidak valid.", errors);
  }

  return {
    priceMode,
    price,
    priceMax,
    negotiable,
    originalAmount,
  };
}

export function formatCatalogPrice(pricing: ValidatedCatalogPricing): string {
  switch (pricing.priceMode) {
    case "on_request":
      return formatOfferingPrice({ model: "on_request" });
    case "fixed":
      return formatOfferingPrice({
        model: "fixed",
        amountIdr: pricing.price ?? 0,
        negotiable: pricing.negotiable,
      });
    case "from":
      return formatOfferingPrice({
        model: "from",
        amountIdr: pricing.price ?? 0,
        negotiable: pricing.negotiable,
      });
    case "range":
      return formatOfferingPrice({
        model: "range",
        minAmountIdr: pricing.price ?? 0,
        maxAmountIdr: pricing.priceMax ?? pricing.price ?? 0,
        negotiable: pricing.negotiable,
      });
  }
}

// ---------------------------------------------------------------------------
// Ordered Gallery, Categories & Badges Validation
// ---------------------------------------------------------------------------

export function validateGalleryMediaIds(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CatalogValidationError("galleryMediaIds harus berupa array ID media.", [
      {
        field: "galleryMediaIds",
        code: "INVALID_GALLERY",
        message: "galleryMediaIds must be an array of positive integer media IDs.",
      },
    ]);
  }
  if (raw.length > MAX_GALLERY_MEDIA_IDS) {
    throw new CatalogValidationError(
      `Galeri penawaran maksimal ${MAX_GALLERY_MEDIA_IDS} gambar.`,
      [
        {
          field: "galleryMediaIds",
          code: "GALLERY_LIMIT_EXCEEDED",
          message: `Gallery may contain at most ${MAX_GALLERY_MEDIA_IDS} images (received ${raw.length}).`,
        },
      ],
    );
  }

  const seen = new Set<number>();
  const ordered: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = SequentialIdSchema.safeParse(raw[i]);
    if (!parsed.success) {
      throw new CatalogValidationError("ID media galeri tidak valid.", [
        {
          field: `galleryMediaIds[${i}]`,
          code: "INVALID_GALLERY",
          message: "Each gallery media ID must be a positive integer.",
        },
      ]);
    }
    if (seen.has(parsed.data)) {
      throw new CatalogValidationError("ID media galeri tidak boleh duplikat.", [
        {
          field: `galleryMediaIds[${i}]`,
          code: "DUPLICATE_GALLERY_MEDIA",
          message: `Duplicate gallery media ID #${parsed.data}.`,
        },
      ]);
    }
    seen.add(parsed.data);
    ordered.push(parsed.data);
  }
  return ordered;
}

export function validateCategoryIds(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CatalogValidationError("categoryIds harus berupa array ID kategori.", [
      {
        field: "categoryIds",
        code: "INVALID_CATEGORY",
        message: "categoryIds must be an array of positive integers.",
      },
    ]);
  }
  if (raw.length > MAX_OFFERING_CATEGORIES) {
    throw new CatalogValidationError(
      `Maksimal ${MAX_OFFERING_CATEGORIES} kategori per penawaran.`,
      [
        {
          field: "categoryIds",
          code: "INVALID_CATEGORY",
          message: `At most ${MAX_OFFERING_CATEGORIES} categories may be assigned to an offering.`,
        },
      ],
    );
  }

  const seen = new Set<number>();
  const ordered: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = SequentialIdSchema.safeParse(raw[i]);
    if (!parsed.success) {
      throw new CatalogValidationError("ID kategori tidak valid.", [
        {
          field: `categoryIds[${i}]`,
          code: "INVALID_CATEGORY",
          message: "Each category ID must be a positive integer.",
        },
      ]);
    }
    if (seen.has(parsed.data)) {
      throw new CatalogValidationError("ID kategori tidak boleh duplikat.", [
        {
          field: `categoryIds[${i}]`,
          code: "INVALID_CATEGORY",
          message: `Duplicate category ID #${parsed.data}.`,
        },
      ]);
    }
    seen.add(parsed.data);
    ordered.push(parsed.data);
  }
  return ordered;
}

export function validateBadges(
  rawBadge: unknown,
  rawBadges: unknown,
): { readonly badge: string | null; readonly badges: readonly string[] } {
  const parseSingleBadge = (value: unknown, field: string): string => {
    if (typeof value !== "string") {
      throw new CatalogValidationError("Badge harus berupa teks.", [
        { field, code: "INVALID_BADGE", message: "Badge must be a non-empty string." },
      ]);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_BADGE_LENGTH) {
      throw new CatalogValidationError(
        `Panjang badge harus antara 1 hingga ${MAX_BADGE_LENGTH} karakter.`,
        [
          {
            field,
            code: "INVALID_BADGE",
            message: `Badge must be 1..${MAX_BADGE_LENGTH} characters.`,
          },
        ],
      );
    }
    return trimmed;
  };

  let primaryBadge: string | null = null;
  if (rawBadge !== undefined && rawBadge !== null && rawBadge !== "") {
    primaryBadge = parseSingleBadge(rawBadge, "badge");
  }

  const badgeList: string[] = [];
  if (rawBadges !== undefined && rawBadges !== null) {
    if (!Array.isArray(rawBadges)) {
      throw new CatalogValidationError("badges harus berupa array teks.", [
        { field: "badges", code: "INVALID_BADGE", message: "badges must be an array of strings." },
      ]);
    }
    if (rawBadges.length > MAX_OFFERING_BADGES) {
      throw new CatalogValidationError(`Maksimal ${MAX_OFFERING_BADGES} badge per penawaran.`, [
        {
          field: "badges",
          code: "INVALID_BADGE",
          message: `At most ${MAX_OFFERING_BADGES} badges are allowed.`,
        },
      ]);
    }
    const seen = new Set<string>();
    for (let i = 0; i < rawBadges.length; i += 1) {
      const normalized = parseSingleBadge(rawBadges[i], `badges[${i}]`);
      const lower = normalized.toLowerCase();
      if (seen.has(lower)) {
        throw new CatalogValidationError("Badge tidak boleh duplikat.", [
          {
            field: `badges[${i}]`,
            code: "INVALID_BADGE",
            message: `Duplicate badge "${normalized}".`,
          },
        ]);
      }
      seen.add(lower);
      badgeList.push(normalized);
    }
  }

  if (primaryBadge === null && badgeList.length > 0) {
    primaryBadge = badgeList[0] ?? null;
  } else if (primaryBadge !== null && badgeList.length === 0) {
    badgeList.push(primaryBadge);
  } else if (
    primaryBadge !== null &&
    !badgeList.some((b) => b.toLowerCase() === primaryBadge!.toLowerCase())
  ) {
    if (badgeList.length >= MAX_OFFERING_BADGES) {
      throw new CatalogValidationError(`Maksimal ${MAX_OFFERING_BADGES} badge per penawaran.`, [
        {
          field: "badges",
          code: "INVALID_BADGE",
          message: `Combining badge and badges exceeds the limit of ${MAX_OFFERING_BADGES}.`,
        },
      ]);
    }
    badgeList.unshift(primaryBadge);
  }

  return { badge: primaryBadge, badges: badgeList };
}

// ---------------------------------------------------------------------------
// CTA Discriminator Validation (REQ-013, REQ-014, REQ-015)
// ---------------------------------------------------------------------------

export interface OfferingCtaValidationInput {
  readonly ctaMode: unknown;
  readonly ctaLabel?: unknown;
  readonly externalUrl?: unknown;
  readonly whatsappOverride?: unknown;
  readonly whatsappTemplate?: unknown;
  readonly tenantWhatsAppE164?: string | null;
}

export interface ValidatedOfferingCta {
  readonly ctaMode: CatalogCtaMode;
  readonly ctaLabel: string | null;
  readonly externalUrl: string | null;
  readonly whatsappOverride: string | null;
  readonly whatsappTemplate: string | null;
  readonly resolvedWhatsAppE164: string | null;
}

export function validateOfferingCta(input: OfferingCtaValidationInput): ValidatedOfferingCta {
  const modeRes = OfferingCtaKindSchema.safeParse(input.ctaMode);
  if (!modeRes.success) {
    throw new CatalogValidationError("Tipe CTA tidak valid.", [
      {
        field: "ctaMode",
        code: "INVALID_CTA",
        message: "ctaMode must be one of whatsapp, external_link, inquiry, or book.",
      },
    ]);
  }
  const ctaMode = modeRes.data;

  let ctaLabel: string | null = null;
  if (input.ctaLabel !== undefined && input.ctaLabel !== null) {
    if (typeof input.ctaLabel !== "string") {
      throw new CatalogValidationError("ctaLabel harus berupa teks.", [
        { field: "ctaLabel", code: "INVALID_CTA", message: "ctaLabel must be a string." },
      ]);
    }
    const trimmed = input.ctaLabel.trim();
    if (trimmed.length === 0 || trimmed.length > 80) {
      throw new CatalogValidationError("ctaLabel harus berisi 1 hingga 80 karakter.", [
        { field: "ctaLabel", code: "INVALID_CTA", message: "ctaLabel must be 1..80 characters." },
      ]);
    }
    ctaLabel = trimmed;
  }

  let normalizedOverride: string | null = null;
  if (input.whatsappOverride !== undefined && input.whatsappOverride !== null && input.whatsappOverride !== "") {
    if (typeof input.whatsappOverride !== "string") {
      throw new CatalogValidationError("Nomor WhatsApp penawaran tidak valid.", [
        {
          field: "whatsappOverride",
          code: "INVALID_WHATSAPP_NUMBER",
          message: "whatsappOverride must be a valid Indonesian E.164 WhatsApp number.",
        },
      ]);
    }
    const check = validateIndonesianWhatsAppNumber(input.whatsappOverride);
    if (!check.ok) {
      throw new CatalogValidationError("Nomor WhatsApp penawaran tidak valid.", [
        {
          field: "whatsappOverride",
          code: "INVALID_WHATSAPP_NUMBER",
          message: check.message,
        },
      ]);
    }
    normalizedOverride = check.phone;
  }

  let validatedTemplate: string | null = null;
  if (input.whatsappTemplate !== undefined && input.whatsappTemplate !== null && input.whatsappTemplate !== "") {
    if (typeof input.whatsappTemplate !== "string") {
      throw new CatalogValidationError("Template pesan WhatsApp tidak valid.", [
        {
          field: "whatsappTemplate",
          code: "INVALID_WHATSAPP_TEMPLATE",
          message: "whatsappTemplate must be a string.",
        },
      ]);
    }
    try {
      renderWhatsAppTemplate(input.whatsappTemplate, {
        item_title: "Sample Item",
        item_price: "Rp 100.000",
        page_url: "https://example.situsku.click/produk/sample",
      });
    } catch (err) {
      const msg =
        err instanceof WhatsAppValidationError
          ? err.message
          : "Invalid WhatsApp message template.";
      throw new CatalogValidationError("Template pesan WhatsApp tidak valid.", [
        {
          field: "whatsappTemplate",
          code: "INVALID_WHATSAPP_TEMPLATE",
          message: msg,
        },
      ]);
    }
    validatedTemplate = input.whatsappTemplate;
  }

  let sanitizedExternalUrl: string | null = null;
  if (input.externalUrl !== undefined && input.externalUrl !== null && input.externalUrl !== "") {
    if (typeof input.externalUrl !== "string") {
      throw new CatalogValidationError("URL eksternal tidak valid.", [
        {
          field: "externalUrl",
          code: "INVALID_EXTERNAL_URL",
          message: "externalUrl must be a valid HTTPS URL string.",
        },
      ]);
    }
    const linkResult = validateExternalLink(input.externalUrl);
    if (!linkResult.ok) {
      throw new CatalogValidationError("URL eksternal tidak aman atau tidak valid.", [
        {
          field: "externalUrl",
          code: "INVALID_EXTERNAL_URL",
          message: linkResult.message,
        },
      ]);
    }
    sanitizedExternalUrl = linkResult.link.href;
  }

  let resolvedWhatsAppE164: string | null = normalizedOverride;

  if (ctaMode === "whatsapp") {
    if (!resolvedWhatsAppE164) {
      const rawTenantWa = input.tenantWhatsAppE164?.trim() ?? "";
      if (!rawTenantWa) {
        throw new CatalogValidationError(
          "CTA WhatsApp memerlukan nomor WhatsApp tenant yang valid atau whatsappOverride.",
          [
            {
              field: "ctaMode",
              code: "MISSING_WHATSAPP_CONFIG",
              message:
                "Tenant business_profile.whatsapp_e164 or offering whatsappOverride must be configured with a valid Indonesian WhatsApp E.164 number.",
            },
          ],
        );
      }
      const tenantWaCheck = validateIndonesianWhatsAppNumber(rawTenantWa);
      if (!tenantWaCheck.ok) {
        throw new CatalogValidationError(
          "Konfigurasi nomor WhatsApp tenant tidak valid untuk CTA WhatsApp.",
          [
            {
              field: "ctaMode",
              code: "INVALID_WHATSAPP_NUMBER",
              message: tenantWaCheck.message,
            },
          ],
        );
      }
      resolvedWhatsAppE164 = tenantWaCheck.phone;
    }
  } else if (ctaMode === "external_link") {
    if (!sanitizedExternalUrl) {
      throw new CatalogValidationError(
        'CTA "external_link" memerlukan URL HTTPS eksternal yang valid.',
        [
          {
            field: "externalUrl",
            code: "INVALID_EXTERNAL_URL",
            message: 'externalUrl is required when ctaMode is "external_link".',
          },
        ],
      );
    }
  }

  return {
    ctaMode,
    ctaLabel,
    externalUrl: ctaMode === "external_link" ? sanitizedExternalUrl : null,
    whatsappOverride: normalizedOverride,
    whatsappTemplate: validatedTemplate,
    resolvedWhatsAppE164,
  };
}

// ---------------------------------------------------------------------------
// Complete Offering & Category Input Validators
// ---------------------------------------------------------------------------

export type CatalogDescription = z.infer<typeof RestrictedRichTextDocSchema> | string;

export interface ValidatedOfferingDraftInput {
  readonly offeringType: CatalogOfferingType;
  readonly title: string;
  readonly manualSlug: string | null;
  readonly summary: string | null;
  readonly description: CatalogDescription | null;
  readonly coverMediaId: number | null;
  readonly galleryMediaIds: readonly number[];
  readonly videoMediaId: number | null;
  readonly youtubeVideoId: string | null;
  readonly pricing: ValidatedCatalogPricing;
  readonly badge: string | null;
  readonly badges: readonly string[];
  readonly cta: ValidatedOfferingCta;
  readonly unitStatus: CatalogVehicleUnitStatus | null;
  readonly categoryIds: readonly number[];
  readonly attributesVersion: number;
  readonly attributes: CatalogOfferingAttributes;
  readonly seo: z.infer<typeof ResourceSeoInputSchema> | null;
}

function assertCleanPayloadObject(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CatalogValidationError(`Payload ${label} harus berupa objek JSON.`, [
      { field: "body", code: "INVALID_PAYLOAD", message: `Expected a JSON object for ${label}.` },
    ]);
  }
  try {
    assertNoForbiddenTenantSelectors(raw);
  } catch (err) {
    if (err instanceof PublicationValidationError) {
      throw new CatalogValidationError(err.message, err.fields);
    }
    throw err;
  }
  return raw as Record<string, unknown>;
}

function parseOptionalSequentialId(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  const parsed = SequentialIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CatalogValidationError(`${field} harus berupa ID integer positif.`, [
      { field, code: "INVALID_ID", message: `${field} must be a positive integer.` },
    ]);
  }
  return parsed.data;
}

function parseDescription(raw: unknown): CatalogDescription | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    if (raw.length > 100_000) {
      throw new CatalogValidationError("Deskripsi melebihi batas 100.000 karakter.", [
        {
          field: "description",
          code: "INVALID_DESCRIPTION",
          message: "Description exceeds 100,000 characters.",
        },
      ]);
    }
    return sanitizePublishedHtmlFragment(raw);
  }
  const parsed = RestrictedRichTextDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CatalogValidationError("Format rich text deskripsi tidak valid.", [
      {
        field: "description",
        code: "INVALID_DESCRIPTION",
        message: parsed.error.issues[0]?.message ?? "Invalid rich text description document.",
      },
    ]);
  }
  return parsed.data;
}

function parseYoutubeVideoId(rawYoutubeVideoId: unknown, rawYoutubeId: unknown): string | null {
  if (
    rawYoutubeVideoId !== undefined &&
    rawYoutubeId !== undefined &&
    rawYoutubeVideoId !== rawYoutubeId
  ) {
    throw new CatalogValidationError("youtubeVideoId dan youtubeId harus sama jika keduanya diisi.", [
      {
        field: "youtubeVideoId",
        code: "INVALID_MEDIA",
        message: "Conflicting youtubeVideoId and youtubeId values.",
      },
    ]);
  }
  const raw = rawYoutubeVideoId !== undefined ? rawYoutubeVideoId : rawYoutubeId;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !YOUTUBE_ID_PATTERN.test(raw)) {
    throw new CatalogValidationError("youtubeVideoId harus berupa 11 karakter ID YouTube yang valid.", [
      {
        field: "youtubeVideoId",
        code: "INVALID_MEDIA",
        message: "youtubeVideoId must match /^[A-Za-z0-9_-]{11}$/.",
      },
    ]);
  }
  return raw;
}

function parseCtaModeField(rawCtaMode: unknown, rawCtaKind: unknown): unknown {
  if (rawCtaMode !== undefined && rawCtaKind !== undefined && rawCtaMode !== rawCtaKind) {
    throw new CatalogValidationError("ctaMode dan ctaKind harus sama jika keduanya diisi.", [
      {
        field: "ctaMode",
        code: "INVALID_CTA",
        message: "Conflicting ctaMode and ctaKind values.",
      },
    ]);
  }
  return rawCtaMode !== undefined ? rawCtaMode : rawCtaKind;
}

function parseSeoField(raw: unknown): z.infer<typeof ResourceSeoInputSchema> | null {
  if (raw === undefined || raw === null) return null;
  const parsed = ResourceSeoInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: CatalogValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? `seo.${issue.path.join(".")}` : "seo",
      code: "INVALID_SEO",
      message: issue.message,
    }));
    throw new CatalogValidationError("Pengaturan SEO penawaran tidak valid.", fields);
  }
  return parsed.data;
}

export const OFFERING_WRITE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "offeringType",
  "title",
  "slug",
  "summary",
  "description",
  "coverMediaId",
  "galleryMediaIds",
  "videoMediaId",
  "youtubeVideoId",
  "youtubeId",
  "priceMode",
  "price",
  "priceMax",
  "negotiable",
  "originalAmount",
  "badge",
  "badges",
  "ctaMode",
  "ctaKind",
  "ctaLabel",
  "externalUrl",
  "whatsappOverride",
  "whatsappTemplate",
  "unitStatus",
  "categoryIds",
  "attributesVersion",
  "attributes",
  "seo",
  "version",
  "expectedVersion",
]);

export function validateOfferingInput(
  rawInput: unknown,
  options: { readonly tenantWhatsAppE164?: string | null } = {},
): ValidatedOfferingDraftInput {
  const record = assertCleanPayloadObject(rawInput, "offering");

  for (const key of Object.keys(record)) {
    if (!OFFERING_WRITE_ALLOWED_KEYS.has(key)) {
      throw new CatalogValidationError(`Field tidak dikenal "${key}".`, [
        {
          field: key,
          code: "UNKNOWN_FIELD",
          message: `Unknown field "${key}" is not allowed in offering payload.`,
        },
      ]);
    }
  }

  const typeRes = OfferingTypeSchema.safeParse(record.offeringType);
  if (!typeRes.success) {
    throw new CatalogValidationError("Tipe penawaran tidak valid.", [
      {
        field: "offeringType",
        code: "INVALID_OFFERING_TYPE",
        message: "offeringType must be one of service, product, tour, or vehicle.",
      },
    ]);
  }
  const offeringType = typeRes.data;

  if (typeof record.title !== "string" || record.title.trim().length === 0 || record.title.trim().length > 200) {
    throw new CatalogValidationError("Judul penawaran wajib diisi (1-200 karakter).", [
      {
        field: "title",
        code: "INVALID_TITLE",
        message: "title must be a non-empty string up to 200 characters.",
      },
    ]);
  }
  const title = record.title.trim();

  const manualSlug =
    record.slug !== undefined && record.slug !== null && record.slug !== ""
      ? validateManualSlug(record.slug, "slug")
      : null;

  let summary: string | null = null;
  if (record.summary !== undefined && record.summary !== null) {
    if (typeof record.summary !== "string" || record.summary.length > 500) {
      throw new CatalogValidationError("Ringkasan maksimal 500 karakter.", [
        {
          field: "summary",
          code: "INVALID_SUMMARY",
          message: "summary must be a string up to 500 characters.",
        },
      ]);
    }
    summary = record.summary.trim() || null;
  }

  const description = parseDescription(record.description);
  const coverMediaId = parseOptionalSequentialId(record.coverMediaId, "coverMediaId");
  const galleryMediaIds = validateGalleryMediaIds(record.galleryMediaIds);
  const videoMediaId = parseOptionalSequentialId(record.videoMediaId, "videoMediaId");
  const youtubeVideoId = parseYoutubeVideoId(record.youtubeVideoId, record.youtubeId);

  const pricing = validateCatalogPricing({
    priceMode: record.priceMode ?? "on_request",
    price: record.price,
    priceMax: record.priceMax,
    negotiable: record.negotiable,
    originalAmount: record.originalAmount,
  });

  const { badge, badges } = validateBadges(record.badge, record.badges);
  const categoryIds = validateCategoryIds(record.categoryIds);

  const cta = validateOfferingCta({
    ctaMode: parseCtaModeField(record.ctaMode, record.ctaKind) ?? "whatsapp",
    ctaLabel: record.ctaLabel,
    externalUrl: record.externalUrl,
    whatsappOverride: record.whatsappOverride,
    whatsappTemplate: record.whatsappTemplate,
    tenantWhatsAppE164: options.tenantWhatsAppE164,
  });

  const attributes = validateOfferingAttributes(offeringType, record.attributes);

  let attributesVersion = 1;
  if (record.attributesVersion !== undefined) {
    const verParsed = VersionSchema.safeParse(record.attributesVersion);
    if (!verParsed.success || verParsed.data < 1) {
      throw new CatalogValidationError("attributesVersion harus integer >= 1.", [
        {
          field: "attributesVersion",
          code: "INVALID_ATTRIBUTES",
          message: "attributesVersion must be a positive integer.",
        },
      ]);
    }
    attributesVersion = verParsed.data;
  }

  let unitStatus: CatalogVehicleUnitStatus | null = null;
  if (record.unitStatus !== undefined && record.unitStatus !== null) {
    if (offeringType !== "vehicle") {
      throw new CatalogValidationError('unitStatus hanya berlaku untuk penawaran tipe "vehicle".', [
        {
          field: "unitStatus",
          code: "INVALID_ATTRIBUTES",
          message: 'unitStatus is only allowed when offeringType is "vehicle".',
        },
      ]);
    }
    const statusRes = VehicleUnitStatusSchema.safeParse(record.unitStatus);
    if (!statusRes.success) {
      throw new CatalogValidationError("unitStatus kendaraan tidak valid.", [
        {
          field: "unitStatus",
          code: "INVALID_ATTRIBUTES",
          message: "unitStatus must be available, booked, or sold.",
        },
      ]);
    }
    unitStatus = statusRes.data;
  }

  if (offeringType === "vehicle") {
    const vehicleAttrs = attributes as VehicleAttributes;
    if (
      unitStatus !== null &&
      vehicleAttrs.unitStatus !== undefined &&
      unitStatus !== vehicleAttrs.unitStatus
    ) {
      throw new CatalogValidationError(
        "unitStatus dan attributes.unitStatus harus sama jika keduanya diisi.",
        [
          {
            field: "unitStatus",
            code: "INVALID_ATTRIBUTES",
            message: "Conflicting top-level unitStatus and attributes.unitStatus values.",
          },
        ],
      );
    }
    unitStatus = unitStatus ?? vehicleAttrs.unitStatus ?? "available";
  }

  const seo = parseSeoField(record.seo);

  return {
    offeringType,
    title,
    manualSlug,
    summary,
    description,
    coverMediaId,
    galleryMediaIds,
    videoMediaId,
    youtubeVideoId,
    pricing,
    badge,
    badges,
    cta,
    unitStatus,
    categoryIds,
    attributesVersion,
    attributes,
    seo,
  };
}

// ---------------------------------------------------------------------------
// Category Input Validation
// ---------------------------------------------------------------------------

export const CATEGORY_WRITE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "slug",
  "offeringType",
  "description",
  "parentId",
  "sortOrder",
  "version",
  "expectedVersion",
]);

export interface ValidatedCategoryInput {
  readonly name: string;
  readonly manualSlug: string | null;
  readonly offeringType: CatalogOfferingType | null;
  readonly description: string | null;
  readonly parentId: number | null;
  readonly sortOrder: number;
}

export function validateCategoryInput(rawInput: unknown): ValidatedCategoryInput {
  const record = assertCleanPayloadObject(rawInput, "category");

  for (const key of Object.keys(record)) {
    if (!CATEGORY_WRITE_ALLOWED_KEYS.has(key)) {
      throw new CatalogValidationError(`Field tidak dikenal "${key}".`, [
        {
          field: key,
          code: "UNKNOWN_FIELD",
          message: `Unknown field "${key}" is not allowed in category payload.`,
        },
      ]);
    }
  }

  if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.trim().length > 100) {
    throw new CatalogValidationError("Nama kategori wajib diisi (1-100 karakter).", [
      {
        field: "name",
        code: "INVALID_CATEGORY",
        message: "Category name must be 1..100 characters.",
      },
    ]);
  }
  const name = record.name.trim();

  const manualSlug =
    record.slug !== undefined && record.slug !== null && record.slug !== ""
      ? validateManualSlug(record.slug, "slug")
      : null;

  let offeringType: CatalogOfferingType | null = null;
  if (record.offeringType !== undefined && record.offeringType !== null && record.offeringType !== "") {
    const parsedType = OfferingTypeSchema.safeParse(record.offeringType);
    if (!parsedType.success) {
      throw new CatalogValidationError("Tipe penawaran kategori tidak valid.", [
        {
          field: "offeringType",
          code: "INVALID_OFFERING_TYPE",
          message: "offeringType must be service, product, tour, vehicle, or null.",
        },
      ]);
    }
    offeringType = parsedType.data;
  }

  let description: string | null = null;
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== "string" || record.description.length > 500) {
      throw new CatalogValidationError("Deskripsi kategori maksimal 500 karakter.", [
        {
          field: "description",
          code: "INVALID_CATEGORY",
          message: "Category description must be up to 500 characters.",
        },
      ]);
    }
    description = record.description.trim() || null;
  }

  const parentId = parseOptionalSequentialId(record.parentId, "parentId");

  let sortOrder = 0;
  if (record.sortOrder !== undefined && record.sortOrder !== null) {
    if (
      typeof record.sortOrder !== "number" ||
      !Number.isSafeInteger(record.sortOrder) ||
      record.sortOrder < 0 ||
      record.sortOrder > 10_000
    ) {
      throw new CatalogValidationError("sortOrder harus berupa integer 0..10000.", [
        {
          field: "sortOrder",
          code: "INVALID_CATEGORY",
          message: "sortOrder must be an integer between 0 and 10000.",
        },
      ]);
    }
    sortOrder = record.sortOrder;
  }

  return {
    name,
    manualSlug,
    offeringType,
    description,
    parentId,
    sortOrder,
  };
}
