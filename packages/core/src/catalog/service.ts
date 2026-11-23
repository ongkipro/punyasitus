import { z } from "zod";
import {
  MAX_IDR_AMOUNT,
  type CatalogPriceMode,
  type ServiceAttributes,
} from "./index.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  validateIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
} from "../wa-dispatcher.ts";

/**
 * Professional Services Pricing Tiers, Consultation Process ("Cara Kerja")
 * & Specialist WhatsApp Override Domain Module
 * (`packages/core/src/catalog/service.ts`; TASK-035, REQ-030, REQ-014, REQ-016).
 *
 * Core Invariants:
 * - Zero new DB migrations: full structured attributes serialize losslessly inside existing
 *   offering snapshot envelopes (`_draftMetadata.serviceConsultationV1` for admin drafts and
 *   outer `serviceConsultationV1` on `published_snapshot_json` for frozen public `/layanan/[slug]`).
 * - Pure Zod `.strict()` schemas: zero cart, zero checkout, zero unknown keys.
 * - Three transparent pricing modes:
 *   - `"from"`: `"Mulai dari Rp ..."` (positive integer IDR required)
 *   - `"fixed"`: `"Rp ..."` (positive integer IDR required)
 *   - `"inquiry"`: `"Konsultasi / Penawaran Khusus"` / `"Hubungi untuk Penawaran"` (numeric price FORBIDDEN!)
 * - Bounded pricing tiers (`0..6`, each `<= 8` deliverables) and bounded `"Cara Kerja"` steps (`1..10`).
 * - Optional single specialist WhatsApp override normalized via `normalizeIndonesianWhatsAppNumber`
 *   (strict Indonesian E.164 `628...`, rejecting arbitrary schemes/hosts, control-char-free message).
 */

export const SERVICE_PRICING_MODES = ["from", "fixed", "inquiry"] as const;
export type ServicePricingMode = (typeof SERVICE_PRICING_MODES)[number];

export const SERVICE_PRICING_MODE_LABELS: Readonly<Record<ServicePricingMode, string>> = {
  from: "Mulai dari (Harga Awal)",
  fixed: "Harga Tetap",
  inquiry: "Konsultasi / Penawaran Khusus",
};

export const SERVICE_INQUIRY_PRICE_LABEL = "Hubungi untuk Penawaran" as const;
export const SERVICE_INQUIRY_BADGE_LABEL = "Konsultasi / Penawaran Khusus" as const;

export const MAX_SERVICE_PRICING_TIERS = 6 as const;
export const MAX_SERVICE_TIER_DELIVERABLES = 8 as const;
export const MIN_SERVICE_PROCESS_STEPS = 1 as const;
export const MAX_SERVICE_PROCESS_STEPS = 10 as const;

export const SERVICE_SNAPSHOT_METADATA_KEY = "serviceConsultationV1" as const;

const SERVICE_MODES = ["onsite", "remote", "hybrid", "in_store"] as const;
export type ServiceDeliveryMode = (typeof SERVICE_MODES)[number];

// ---------------------------------------------------------------------------
// Text Sanitization & Indonesian Rupiah Formatters
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

/**
 * Sanitizes an optional WhatsApp prefilled message: removes ALL ASCII control characters
 * (`0x00..0x1f`, `0x7f`), collapses whitespace, trims, and caps at 400 characters.
 */
export function sanitizeSpecialistPrefilledMessage(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, 400);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Pure deterministic Indonesian Rupiah formatter (e.g. `2500000` -> `"Rp 2.500.000"`).
 * Uses integer dot grouping with zero `Intl` runtime locale variance.
 */
export function formatIdrCurrency(amountIdr: number): string {
  if (!Number.isSafeInteger(amountIdr) || amountIdr < 0) {
    return SERVICE_INQUIRY_PRICE_LABEL;
  }
  const grouped = String(amountIdr).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${grouped}`;
}

/**
 * Formats a service or pricing-tier display label according to its pricing mode:
 * - `"from"` + positive integer IDR -> `"Mulai dari Rp 2.500.000"`
 * - `"fixed"` + positive integer IDR -> `"Rp 5.000.000"`
 * - `"inquiry"` (or absent/non-positive price) -> `"Hubungi untuk Penawaran"`
 */
export function formatServicePriceLabel(
  pricingMode: ServicePricingMode,
  priceIdr?: number | null,
): string {
  if (pricingMode === "inquiry") {
    return SERVICE_INQUIRY_PRICE_LABEL;
  }
  if (typeof priceIdr !== "number" || !Number.isSafeInteger(priceIdr) || priceIdr < 1) {
    return SERVICE_INQUIRY_PRICE_LABEL;
  }
  if (pricingMode === "from") {
    return `Mulai dari ${formatIdrCurrency(priceIdr)}`;
  }
  return formatIdrCurrency(priceIdr);
}

// ---------------------------------------------------------------------------
// Strict Zod Schemas (`.strict()`, zero cart/checkout/unknown keys)
// ---------------------------------------------------------------------------

export const ServicePricingModeSchema = z.enum(SERVICE_PRICING_MODES);

const CleanSingleLineString = (maxLen: number, emptyMessage?: string) =>
  z
    .string()
    .trim()
    .min(1, emptyMessage ?? "Kolom ini wajib diisi.")
    .max(maxLen)
    .refine((val) => !hasControlChars(val), {
      message: "Teks tidak boleh mengandung karakter kontrol.",
    });

export const ServicePricingTierSchema = z
  .object({
    name: CleanSingleLineString(80, "Nama paket layanan wajib diisi."),
    pricingMode: ServicePricingModeSchema,
    priceIdr: z
      .number()
      .int("Harga harus berupa bilangan bulat Rupiah (tanpa desimal).")
      .min(1, "Harga harus lebih besar dari Rp 0.")
      .max(MAX_IDR_AMOUNT, "Nominal harga melebihi batas maksimum.")
      .nullable()
      .optional(),
    billingUnit: CleanSingleLineString(60).optional(),
    summary: CleanSingleLineString(240).optional(),
    deliverables: z
      .array(CleanSingleLineString(160, "Rincian deliverable tidak boleh kosong."))
      .max(MAX_SERVICE_TIER_DELIVERABLES, "Maksimal 8 deliverables per paket harga.")
      .optional(),
    turnaroundLabel: CleanSingleLineString(80).optional(),
    highlighted: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.pricingMode === "inquiry") {
      if (val.priceIdr !== undefined && val.priceIdr !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["priceIdr"],
          message:
            "Paket dengan mode 'Konsultasi / Penawaran Khusus' tidak boleh mencantumkan nominal harga.",
        });
      }
      return;
    }

    if (typeof val.priceIdr !== "number" || !Number.isSafeInteger(val.priceIdr) || val.priceIdr < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["priceIdr"],
        message:
          "Nominal harga Rupiah positif wajib diisi untuk mode 'Mulai dari' atau 'Harga Tetap'.",
      });
    }
  });

export const ServiceProcessStepSchema = z
  .object({
    stepNumber: z
      .number()
      .int("Nomor langkah harus berupa bilangan bulat.")
      .min(MIN_SERVICE_PROCESS_STEPS, "Nomor langkah minimal 1.")
      .max(MAX_SERVICE_PROCESS_STEPS, "Maksimal 10 langkah Cara Kerja."),
    title: CleanSingleLineString(120, "Judul langkah Cara Kerja wajib diisi."),
    summary: z
      .string()
      .trim()
      .min(1, "Ringkasan langkah Cara Kerja wajib diisi.")
      .max(500)
      .refine((val) => !hasControlChars(val), {
        message: "Ringkasan langkah tidak boleh mengandung karakter kontrol.",
      }),
    estimatedDuration: CleanSingleLineString(80).optional(),
  })
  .strict();

export const ServiceSpecialistCtaSchema = z
  .object({
    specialistName: CleanSingleLineString(100, "Nama spesialis wajib diisi."),
    specialistRole: CleanSingleLineString(100, "Peran atau jabatan spesialis wajib diisi."),
    whatsappNumber: z
      .string()
      .min(1, "Nomor WhatsApp spesialis wajib diisi.")
      .max(32)
      .superRefine((raw, ctx) => {
        if (hasControlChars(raw)) {
          ctx.addIssue({
            code: "custom",
            message: "Nomor WhatsApp spesialis tidak boleh mengandung karakter kontrol.",
          });
          return;
        }
        const res = validateIndonesianWhatsAppNumber(raw);
        if (!res.ok) {
          ctx.addIssue({
            code: "custom",
            message:
              "Nomor WhatsApp spesialis harus berupa nomor seluler Indonesia yang valid (08..., 628..., atau +628...).",
          });
        }
      }),
    ctaLabel: CleanSingleLineString(80).optional(),
    prefilledMessage: z.string().max(400).optional(),
  })
  .strict();

export const ServiceConsultationAttributesSchema = z
  .object({
    pricingMode: ServicePricingModeSchema,
    basePriceIdr: z
      .number()
      .int("Harga dasar harus berupa bilangan bulat Rupiah.")
      .min(1, "Harga dasar harus lebih besar dari Rp 0.")
      .max(MAX_IDR_AMOUNT, "Nominal harga melebihi batas maksimum.")
      .nullable()
      .optional(),
    pricingTiers: z
      .array(ServicePricingTierSchema)
      .max(MAX_SERVICE_PRICING_TIERS, "Maksimal 6 paket harga per layanan.")
      .default([]),
    processSteps: z
      .array(ServiceProcessStepSchema)
      .min(MIN_SERVICE_PROCESS_STEPS, "Minimal 1 langkah Cara Kerja wajib diisi.")
      .max(MAX_SERVICE_PROCESS_STEPS, "Maksimal 10 langkah Cara Kerja."),
    specialistCta: ServiceSpecialistCtaSchema.nullable().optional(),
    serviceArea: CleanSingleLineString(160).optional(),
    turnaround: CleanSingleLineString(120).optional(),
    serviceMode: z.enum(SERVICE_MODES).optional(),
    warranty: CleanSingleLineString(160).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.pricingMode === "inquiry") {
      if (val.basePriceIdr !== undefined && val.basePriceIdr !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["basePriceIdr"],
          message:
            "Layanan mode 'Konsultasi / Penawaran Khusus' tidak boleh mencantumkan nominal harga dasar.",
        });
      }
      for (let i = 0; i < val.pricingTiers.length; i += 1) {
        const tier = val.pricingTiers[i];
        if (!tier) continue;
        if (tier.pricingMode !== "inquiry" || typeof tier.priceIdr === "number") {
          ctx.addIssue({
            code: "custom",
            path: ["pricingTiers", i, "pricingMode"],
            message:
              "Semua paket pada layanan mode 'Konsultasi / Penawaran Khusus' wajib bertipe 'inquiry' tanpa harga numerik.",
          });
        }
      }
    }

    const seenSteps = new Set<number>();
    for (let i = 0; i < val.processSteps.length; i += 1) {
      const step = val.processSteps[i];
      if (!step) continue;
      if (seenSteps.has(step.stepNumber)) {
        ctx.addIssue({
          code: "custom",
          path: ["processSteps", i, "stepNumber"],
          message: `Nomor langkah ke-${step.stepNumber} duplikat pada Cara Kerja.`,
        });
      }
      seenSteps.add(step.stepNumber);
    }
  });

export type ServicePricingTier = z.infer<typeof ServicePricingTierSchema>;
export type ServiceProcessStep = z.infer<typeof ServiceProcessStepSchema>;
export type ServiceSpecialistCta = z.infer<typeof ServiceSpecialistCtaSchema>;
export type ServiceConsultationAttributes = z.infer<typeof ServiceConsultationAttributesSchema>;

// ---------------------------------------------------------------------------
// Structured Validation Errors & Pure Strict Validator
// ---------------------------------------------------------------------------

export interface ServiceValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class ServiceValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly ServiceValidationField[];

  constructor(message: string, fields: readonly ServiceValidationField[] = []) {
    super(message);
    this.name = "ServiceValidationError";
    this.fields = fields;
  }
}

/**
 * Pure strict validator & normalizer for `ServiceConsultationAttributes`.
 * - Rejects unknown keys (including any cart/checkout fields) with `UNKNOWN_FIELD`.
 * - Normalizes `specialistCta.whatsappNumber` into canonical E.164 digits (`628...`)
 *   and sanitizes `specialistCta.prefilledMessage` to have zero control characters.
 * - Sorts `processSteps` ascending by `stepNumber`.
 * - Produces a canonical, 100% idempotent representation across repeated save -> reload cycles.
 */
export function validateServiceConsultationAttributes(
  raw: unknown,
): ServiceConsultationAttributes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServiceValidationError("Atribut layanan konsultasi harus berupa objek JSON.", [
      {
        field: "service",
        code: "INVALID_SERVICE_ATTRIBUTES",
        message: "Atribut layanan konsultasi harus berupa objek JSON.",
      },
    ]);
  }

  const parsed = ServiceConsultationAttributesSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: ServiceValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "service",
      code:
        issue.code === "unrecognized_keys"
          ? "UNKNOWN_FIELD"
          : "INVALID_SERVICE_ATTRIBUTES",
      message: issue.message,
    }));
    throw new ServiceValidationError(
      fields[0]?.message ?? "Data layanan profesional tidak valid.",
      fields,
    );
  }

  const data = parsed.data;

  const normalizedTiers: ServicePricingTier[] = data.pricingTiers.map((tier) => ({
    name: tier.name,
    pricingMode: tier.pricingMode,
    ...(tier.pricingMode !== "inquiry" && typeof tier.priceIdr === "number"
      ? { priceIdr: tier.priceIdr }
      : {}),
    ...(tier.billingUnit ? { billingUnit: tier.billingUnit } : {}),
    ...(tier.summary ? { summary: tier.summary } : {}),
    ...(tier.deliverables && tier.deliverables.length > 0
      ? { deliverables: [...tier.deliverables] }
      : {}),
    ...(tier.turnaroundLabel ? { turnaroundLabel: tier.turnaroundLabel } : {}),
    ...(tier.highlighted === true ? { highlighted: true } : {}),
  }));

  const sortedSteps: ServiceProcessStep[] = [...data.processSteps]
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((step) => ({
      stepNumber: step.stepNumber,
      title: step.title,
      summary: step.summary,
      ...(step.estimatedDuration ? { estimatedDuration: step.estimatedDuration } : {}),
    }));

  let normalizedSpecialist: ServiceSpecialistCta | undefined;
  if (data.specialistCta) {
    const normalizedPhone = normalizeIndonesianWhatsAppNumber(data.specialistCta.whatsappNumber);
    const cleanPrefilled = sanitizeSpecialistPrefilledMessage(data.specialistCta.prefilledMessage);
    normalizedSpecialist = {
      specialistName: data.specialistCta.specialistName,
      specialistRole: data.specialistCta.specialistRole,
      whatsappNumber: normalizedPhone,
      ...(data.specialistCta.ctaLabel ? { ctaLabel: data.specialistCta.ctaLabel } : {}),
      ...(cleanPrefilled ? { prefilledMessage: cleanPrefilled } : {}),
    };
  }

  return {
    pricingMode: data.pricingMode,
    ...(data.pricingMode !== "inquiry" && typeof data.basePriceIdr === "number"
      ? { basePriceIdr: data.basePriceIdr }
      : {}),
    pricingTiers: normalizedTiers,
    processSteps: sortedSteps,
    ...(normalizedSpecialist ? { specialistCta: normalizedSpecialist } : {}),
    ...(data.serviceArea ? { serviceArea: data.serviceArea } : {}),
    ...(data.turnaround ? { turnaround: data.turnaround } : {}),
    ...(data.serviceMode ? { serviceMode: data.serviceMode } : {}),
    ...(data.warranty ? { warranty: data.warranty } : {}),
  };
}

// ---------------------------------------------------------------------------
// Headline Pricing Resolver & Safe Specialist WhatsApp URL Builder
// ---------------------------------------------------------------------------

export interface ResolvedServiceHeadlinePricing {
  readonly pricingMode: ServicePricingMode;
  readonly catalogPriceMode: CatalogPriceMode;
  readonly priceIdr: number | null;
  readonly formattedLabel: string;
}

/**
 * Resolves truthful visible headline pricing from structured `ServiceConsultationAttributes`:
 * - `"inquiry"` ALWAYS resolves to `{ catalogPriceMode: "on_request", priceIdr: null, formattedLabel: "Hubungi untuk Penawaran" }`.
 * - `"from"` resolves to the lowest positive visible IDR amount across `pricingTiers` and `basePriceIdr`
 *   (or fallback offering price), formatted as `"Mulai dari Rp ..."`.
 * - `"fixed"` resolves to `basePriceIdr` (if set) or the single/lowest numeric tier price,
 *   formatted as `"Rp ..."`.
 */
export function resolveServiceHeadlinePricing(
  attrs: Pick<ServiceConsultationAttributes, "pricingMode" | "basePriceIdr" | "pricingTiers">,
  fallbackOffering?: {
    readonly priceMode?: CatalogPriceMode | null;
    readonly price?: number | null;
  },
): ResolvedServiceHeadlinePricing {
  if (attrs.pricingMode === "inquiry") {
    return {
      pricingMode: "inquiry",
      catalogPriceMode: "on_request",
      priceIdr: null,
      formattedLabel: SERVICE_INQUIRY_PRICE_LABEL,
    };
  }

  const numericTierPrices = (attrs.pricingTiers ?? [])
    .filter(
      (t): t is ServicePricingTier & { readonly priceIdr: number } =>
        t.pricingMode !== "inquiry" &&
        typeof t.priceIdr === "number" &&
        Number.isSafeInteger(t.priceIdr) &&
        t.priceIdr >= 1,
    )
    .map((t) => t.priceIdr);

  const validBase =
    typeof attrs.basePriceIdr === "number" &&
    Number.isSafeInteger(attrs.basePriceIdr) &&
    attrs.basePriceIdr >= 1
      ? attrs.basePriceIdr
      : null;

  const validFallback =
    fallbackOffering &&
    fallbackOffering.priceMode !== "on_request" &&
    typeof fallbackOffering.price === "number" &&
    Number.isSafeInteger(fallbackOffering.price) &&
    fallbackOffering.price >= 1
      ? fallbackOffering.price
      : null;

  let resolvedPrice: number | null;
  if (attrs.pricingMode === "fixed") {
    resolvedPrice =
      validBase ??
      (numericTierPrices.length > 0 ? Math.min(...numericTierPrices) : null) ??
      validFallback;
  } else {
    const candidates: number[] = [...numericTierPrices];
    if (validBase !== null) candidates.push(validBase);
    resolvedPrice =
      candidates.length > 0 ? Math.min(...candidates) : validFallback;
  }

  if (resolvedPrice === null) {
    return {
      pricingMode: attrs.pricingMode,
      catalogPriceMode: "on_request",
      priceIdr: null,
      formattedLabel: SERVICE_INQUIRY_PRICE_LABEL,
    };
  }

  return {
    pricingMode: attrs.pricingMode,
    catalogPriceMode: attrs.pricingMode,
    priceIdr: resolvedPrice,
    formattedLabel: formatServicePriceLabel(attrs.pricingMode, resolvedPrice),
  };
}

/**
 * Builds a strictly validated `https://wa.me/628...?text=...` consultation URL.
 * - Uses `specialistCta.whatsappNumber` when present and valid; otherwise falls back to `fallbackPhone`.
 * - Rejects non-Indonesian numbers, non-WhatsApp schemes/hosts, and strips all control characters.
 * - Returns `null` if neither specialist nor fallback phone is a valid Indonesian WhatsApp number.
 */
export function buildSpecialistWhatsAppHref(params: {
  readonly specialistCta?: Pick<
    ServiceSpecialistCta,
    "specialistName" | "specialistRole" | "whatsappNumber" | "prefilledMessage"
  > | null;
  readonly fallbackPhone?: string | null;
  readonly serviceTitle: string;
  readonly canonicalUrl?: string | null;
}): string | null {
  const candidatePhone =
    params.specialistCta?.whatsappNumber?.trim() || params.fallbackPhone?.trim() || "";
  if (!candidatePhone) return null;

  const validated = validateIndonesianWhatsAppNumber(candidatePhone);
  if (!validated.ok) return null;

  const cleanTitle = sanitizeSpecialistPrefilledMessage(params.serviceTitle) ?? "layanan ini";
  const customMessage = sanitizeSpecialistPrefilledMessage(
    params.specialistCta?.prefilledMessage,
  );

  let baseText: string;
  if (customMessage) {
    baseText = customMessage;
  } else if (params.specialistCta?.specialistName) {
    const cleanName =
      sanitizeSpecialistPrefilledMessage(params.specialistCta.specialistName) ?? "Tim Spesialis";
    baseText = `Halo ${cleanName}, saya ingin berkonsultasi mengenai layanan "${cleanTitle}".`;
  } else {
    baseText = `Halo, saya ingin berkonsultasi mengenai layanan "${cleanTitle}".`;
  }

  const cleanUrl =
    typeof params.canonicalUrl === "string" && /^https:\/\//i.test(params.canonicalUrl.trim())
      ? sanitizeSpecialistPrefilledMessage(params.canonicalUrl)
      : null;

  const fullText = cleanUrl && !baseText.includes(cleanUrl)
    ? `${baseText} Info: ${cleanUrl}`
    : baseText;

  return `${WA_ME_ORIGIN}/${validated.phone}?text=${encodeURIComponent(fullText)}`;
}

// ---------------------------------------------------------------------------
// Lossless Snapshot Envelope Helpers & Clean Legacy ServiceAttributes Projection
// ---------------------------------------------------------------------------

/**
 * Extracts a validated `ServiceConsultationAttributes` object from either a persisted
 * `draft_snapshot_json` (`_draftMetadata.serviceConsultationV1`) or a frozen
 * `published_snapshot_json` (`serviceConsultationV1`) envelope string.
 */
export function extractServiceConsultationFromSnapshotJson(
  rawJson: string | null | undefined,
): ServiceConsultationAttributes | null {
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
    obj[SERVICE_SNAPSHOT_METADATA_KEY] &&
    typeof obj[SERVICE_SNAPSHOT_METADATA_KEY] === "object"
  ) {
    candidate = obj[SERVICE_SNAPSHOT_METADATA_KEY];
  } else if (
    obj._draftMetadata &&
    typeof obj._draftMetadata === "object" &&
    !Array.isArray(obj._draftMetadata)
  ) {
    const meta = obj._draftMetadata as Record<string, unknown>;
    if (
      meta[SERVICE_SNAPSHOT_METADATA_KEY] &&
      typeof meta[SERVICE_SNAPSHOT_METADATA_KEY] === "object"
    ) {
      candidate = meta[SERVICE_SNAPSHOT_METADATA_KEY];
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    return validateServiceConsultationAttributes(candidate);
  } catch {
    return null;
  }
}

/**
 * Attaches the lossless `serviceConsultationV1` object into an existing `draft_snapshot_json`
 * string under `_draftMetadata.serviceConsultationV1` without altering `data` or `writeToken`.
 */
export function attachServiceConsultationToDraftSnapshotJson(
  rawDraftSnapshotJson: string | null | undefined,
  service: ServiceConsultationAttributes,
): string {
  const cleanService = validateServiceConsultationAttributes(service);
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
  existingMeta[SERVICE_SNAPSHOT_METADATA_KEY] = cleanService;
  base._draftMetadata = existingMeta;
  return JSON.stringify(base);
}

/**
 * Attaches the frozen lossless `serviceConsultationV1` object onto the outer envelope of
 * `published_snapshot_json` without mutating `envelope.data` (which stays strictly valid
 * under `OfferingSnapshotSchema`).
 */
export function attachServiceConsultationToPublishedSnapshotJson(
  rawPublishedSnapshotJson: string | null | undefined,
  service: ServiceConsultationAttributes,
): string | null {
  if (!rawPublishedSnapshotJson || !rawPublishedSnapshotJson.trim()) return null;
  const cleanService = validateServiceConsultationAttributes(service);
  try {
    const parsed = JSON.parse(rawPublishedSnapshotJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      [SERVICE_SNAPSHOT_METADATA_KEY]: cleanService,
    };
    return JSON.stringify(envelope);
  } catch {
    return null;
  }
}

/**
 * Projects structured `ServiceConsultationAttributes` into the strict legacy `ServiceAttributes`
 * shape accepted by `packages/core/src/catalog/index.ts` & `packages/db/src/catalog/index.ts`.
 * Full structured fields are preserved losslessly in the snapshot envelope (`serviceConsultationV1`).
 */
export function toCatalogServiceAttributes(
  service: ServiceConsultationAttributes,
): ServiceAttributes {
  const clean = validateServiceConsultationAttributes(service);

  const uniqueDeliverables: string[] = [];
  const seenDeliverables = new Set<string>();
  for (const tier of clean.pricingTiers) {
    for (const item of tier.deliverables ?? []) {
      const key = item.toLowerCase();
      if (!seenDeliverables.has(key) && uniqueDeliverables.length < 20) {
        seenDeliverables.add(key);
        uniqueDeliverables.push(item.slice(0, 200));
      }
    }
  }

  const serviceSteps = clean.processSteps.slice(0, 10).map((step) => {
    const combined = `${step.title} — ${step.summary}`;
    return combined.slice(0, 200);
  });

  const tiers = clean.pricingTiers.slice(0, MAX_SERVICE_PRICING_TIERS).map((tier) => ({
    name: tier.name,
    ...(tier.summary ? { summary: tier.summary.slice(0, 240) } : {}),
    price: tier.pricingMode === "inquiry" ? null : (tier.priceIdr ?? null),
  }));

  return {
    ...(uniqueDeliverables.length > 0 ? { deliverables: uniqueDeliverables } : {}),
    ...(serviceSteps.length > 0 ? { serviceSteps } : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
    ...(clean.serviceArea ? { serviceArea: clean.serviceArea } : {}),
    ...(clean.turnaround ? { turnaround: clean.turnaround } : {}),
    ...(clean.serviceMode ? { serviceMode: clean.serviceMode } : {}),
    ...(clean.warranty ? { warranty: clean.warranty } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public Display Normalization (Accepts both ServiceConsultationAttributes & legacy ServiceAttributes)
// ---------------------------------------------------------------------------

export interface NormalizedServiceDisplayModel {
  readonly pricingMode: ServicePricingMode;
  readonly pricingModeLabel: string;
  readonly headlinePriceLabel: string;
  readonly headlinePriceIdr: number | null;
  readonly pricingTiers: readonly ServicePricingTier[];
  readonly processSteps: readonly ServiceProcessStep[];
  readonly specialistCta: ServiceSpecialistCta | null;
  readonly serviceArea: string | null;
  readonly turnaround: string | null;
  readonly serviceMode: ServiceDeliveryMode | null;
  readonly warranty: string | null;
}

function cleanOptionalText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;
  return trimmed.slice(0, maxLen);
}

/**
 * Normalizes either a full `ServiceConsultationAttributes` payload or a legacy `ServiceAttributes`
 * snapshot into a safe, zero-cart display model for `SectionServiceProcess.astro` & `/layanan/[slug]`.
 */
export function normalizeServiceDisplayModel(
  raw: Record<string, unknown> | ServiceConsultationAttributes | ServiceAttributes | null | undefined,
  fallbackOffering?: {
    readonly priceMode?: CatalogPriceMode | null;
    readonly price?: number | null;
  },
): NormalizedServiceDisplayModel {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // Fast path: full `ServiceConsultationAttributes`
  const strictParsed = ServiceConsultationAttributesSchema.safeParse(src);
  if (strictParsed.success) {
    const clean = validateServiceConsultationAttributes(strictParsed.data);
    const headline = resolveServiceHeadlinePricing(clean, fallbackOffering);
    return {
      pricingMode: clean.pricingMode,
      pricingModeLabel: SERVICE_PRICING_MODE_LABELS[clean.pricingMode],
      headlinePriceLabel: headline.formattedLabel,
      headlinePriceIdr: headline.priceIdr,
      pricingTiers: clean.pricingTiers,
      processSteps: clean.processSteps,
      specialistCta: clean.specialistCta ?? null,
      serviceArea: clean.serviceArea ?? null,
      turnaround: clean.turnaround ?? null,
      serviceMode: clean.serviceMode ?? null,
      warranty: clean.warranty ?? null,
    };
  }

  // Graceful fallback for legacy `ServiceAttributes`
  const inferredMode: ServicePricingMode =
    src.pricingMode === "from" || src.pricingMode === "fixed" || src.pricingMode === "inquiry"
      ? src.pricingMode
      : fallbackOffering?.priceMode === "fixed"
        ? "fixed"
        : fallbackOffering?.priceMode === "from"
          ? "from"
          : "inquiry";

  const pricingTiers: ServicePricingTier[] = [];
  const rawTiers = Array.isArray(src.pricingTiers)
    ? src.pricingTiers
    : Array.isArray(src.tiers)
      ? src.tiers
      : [];
  for (const item of rawTiers.slice(0, MAX_SERVICE_PRICING_TIERS)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = cleanOptionalText(obj.name, 80);
    if (!name) continue;
    const rawPrice =
      typeof obj.priceIdr === "number"
        ? obj.priceIdr
        : typeof obj.price === "number"
          ? obj.price
          : null;
    const validPrice =
      rawPrice !== null && Number.isSafeInteger(rawPrice) && rawPrice >= 1 ? rawPrice : null;
    const tierMode: ServicePricingMode =
      inferredMode === "inquiry"
        ? "inquiry"
        : obj.pricingMode === "from" || obj.pricingMode === "fixed" || obj.pricingMode === "inquiry"
          ? obj.pricingMode
          : validPrice !== null
            ? inferredMode
            : "inquiry";
    const summary = cleanOptionalText(obj.summary, 240);
    const billingUnit = cleanOptionalText(obj.billingUnit, 60);
    const turnaroundLabel = cleanOptionalText(obj.turnaroundLabel, 80);
    const deliverables = Array.isArray(obj.deliverables)
      ? obj.deliverables
          .map((d) => cleanOptionalText(d, 160))
          .filter((d): d is string => d !== null)
          .slice(0, MAX_SERVICE_TIER_DELIVERABLES)
      : [];

    pricingTiers.push({
      name,
      pricingMode: tierMode,
      ...(tierMode !== "inquiry" && validPrice !== null ? { priceIdr: validPrice } : {}),
      ...(billingUnit ? { billingUnit } : {}),
      ...(summary ? { summary } : {}),
      ...(deliverables.length > 0 ? { deliverables } : {}),
      ...(turnaroundLabel ? { turnaroundLabel } : {}),
      ...(obj.highlighted === true ? { highlighted: true } : {}),
    });
  }

  const processSteps: ServiceProcessStep[] = [];
  if (Array.isArray(src.processSteps)) {
    for (const rawStep of src.processSteps.slice(0, MAX_SERVICE_PROCESS_STEPS)) {
      const parsed = ServiceProcessStepSchema.safeParse(rawStep);
      if (parsed.success) processSteps.push(parsed.data);
    }
    processSteps.sort((a, b) => a.stepNumber - b.stepNumber);
  } else if (Array.isArray(src.serviceSteps)) {
    for (let i = 0; i < Math.min(src.serviceSteps.length, MAX_SERVICE_PROCESS_STEPS); i += 1) {
      const text = cleanOptionalText(src.serviceSteps[i], 200);
      if (!text) continue;
      const sepIdx = text.indexOf(" — ");
      if (sepIdx > 0 && sepIdx < 120) {
        processSteps.push({
          stepNumber: i + 1,
          title: text.slice(0, sepIdx).trim(),
          summary: text.slice(sepIdx + 3).trim() || text,
        });
      } else {
        processSteps.push({
          stepNumber: i + 1,
          title: `Tahap ${i + 1}`,
          summary: text,
        });
      }
    }
  }

  let specialistCta: ServiceSpecialistCta | null = null;
  if (src.specialistCta && typeof src.specialistCta === "object") {
    const parsedCta = ServiceSpecialistCtaSchema.safeParse(src.specialistCta);
    if (parsedCta.success) {
      const cleanPrefilled = sanitizeSpecialistPrefilledMessage(parsedCta.data.prefilledMessage);
      specialistCta = {
        specialistName: parsedCta.data.specialistName,
        specialistRole: parsedCta.data.specialistRole,
        whatsappNumber: normalizeIndonesianWhatsAppNumber(parsedCta.data.whatsappNumber),
        ...(parsedCta.data.ctaLabel ? { ctaLabel: parsedCta.data.ctaLabel } : {}),
        ...(cleanPrefilled ? { prefilledMessage: cleanPrefilled } : {}),
      };
    }
  }

  const basePriceIdr =
    inferredMode !== "inquiry" &&
    typeof src.basePriceIdr === "number" &&
    Number.isSafeInteger(src.basePriceIdr) &&
    src.basePriceIdr >= 1
      ? src.basePriceIdr
      : null;

  const headline = resolveServiceHeadlinePricing(
    { pricingMode: inferredMode, basePriceIdr, pricingTiers },
    fallbackOffering,
  );

  const serviceMode =
    src.serviceMode === "onsite" ||
    src.serviceMode === "remote" ||
    src.serviceMode === "hybrid" ||
    src.serviceMode === "in_store"
      ? src.serviceMode
      : null;

  return {
    pricingMode: inferredMode,
    pricingModeLabel: SERVICE_PRICING_MODE_LABELS[inferredMode],
    headlinePriceLabel: headline.formattedLabel,
    headlinePriceIdr: headline.priceIdr,
    pricingTiers,
    processSteps,
    specialistCta,
    serviceArea: cleanOptionalText(src.serviceArea, 160),
    turnaround: cleanOptionalText(src.turnaround, 120),
    serviceMode,
    warranty: cleanOptionalText(src.warranty, 160),
  };
}
