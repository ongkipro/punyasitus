import { z } from "zod";
import {
  sanitizeNavigationHref,
  sanitizeRichTextHtml,
  sanitizeRichTextImageSrc,
} from "../content/index.ts";
import {
  HttpsUrlSchema,
  IdrAmountSchema,
  OfferingCtaKindSchema,
  OfferingTypeSchema,
  PriceModeSchema,
  SlugSchema,
  ThemeIdSchema,
  VehicleUnitStatusSchema,
} from "../schemas/common.ts";
import type { PublicPageSectionDtoSchema } from "../schemas/public-dto.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "../wa-dispatcher.ts";
import type { HeroVariant, PlatformThemeId } from "./index.ts";

/**
 * Closed Unified Modular Section Registry, Schema Validation, Lossless Theme
 * Switching & Permenkes Health-Category Compliance Guardrails
 * (REQ-018, REQ-019, REQ-036, REQ-040, PLAN §7.3, §11.4, §14, DESIGN.md §7, TASK-013).
 *
 * Guarantees:
 * - One strictly closed section registry shared across `/` and `/{pageSlug}` and
 *   all 6 platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`)
 *   plus granted `custom-<slug>` themes.
 * - Switching themes never drops or mutates section data (100% lossless).
 * - Unknown section types fail with `UNKNOWN_SECTION_TYPE`.
 * - Duplicate singleton sections (e.g. multiple `hero` sections on one page) fail
 *   with `DUPLICATE_SINGLETON_SECTION`.
 * - Unsafe URLs (`javascript:`, `data:`, `vbscript:`, protocol-relative `//`),
 *   malformed configs, and oversized section payloads are rejected cleanly.
 * - Health/medical categories default `testimonials` OFF (`enabled: false`) and
 *   always emit an explicit Permenkes compliance warning.
 */

export const SECTION_REGISTRY_SCHEMA_VERSION = 1 as const;
export const MAX_PAGE_SECTIONS = 30 as const;
export const MAX_SECTION_CONFIG_BYTES = 128_000 as const;
export const MAX_PAGE_SECTIONS_PAYLOAD_BYTES = 512_000 as const;

export const CLOSED_SECTION_TYPES = [
  "hero",
  "features",
  "highlights",
  "trust_logos",
  "offerings_grid",
  "services_grid",
  "products_grid",
  "tours_grid",
  "vehicles_grid",
  "rich_text",
  "about",
  "gallery",
  "testimonials",
  "faq",
  "blog_latest",
  "latest_posts",
  "cta_banner",
  "cta_band",
  "contact_location",
  "contact",
  "branches",
  "team",
  "custom_form",
] as const;

export type ClosedSectionType = (typeof CLOSED_SECTION_TYPES)[number];

export const CLOSED_SECTION_TYPE_SET: ReadonlySet<string> = new Set<string>(CLOSED_SECTION_TYPES);

/**
 * Canonical singleton section types: at most ONE instance may appear on any page
 * (whether enabled or disabled) to prevent duplicate H1/hero landmarks.
 */
export const SINGLETON_SECTION_TYPES = ["hero"] as const;
export type SingletonSectionType = (typeof SINGLETON_SECTION_TYPES)[number];
const SINGLETON_SECTION_TYPE_SET: ReadonlySet<string> = new Set<string>(SINGLETON_SECTION_TYPES);

export function isClosedSectionType(value: unknown): value is ClosedSectionType {
  return typeof value === "string" && CLOSED_SECTION_TYPE_SET.has(value);
}

export function isSingletonSectionType(value: unknown): value is SingletonSectionType {
  return typeof value === "string" && SINGLETON_SECTION_TYPE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Structured Section Registry Errors & Warnings
// ---------------------------------------------------------------------------

export type SectionRegistryErrorCode =
  | "UNKNOWN_SECTION_TYPE"
  | "DUPLICATE_SINGLETON_SECTION"
  | "DUPLICATE_SECTION_ID"
  | "UNSAFE_URL"
  | "OVERSIZED_SECTION_CONFIG"
  | "TOO_MANY_SECTIONS"
  | "INVALID_SECTION_CONFIG"
  | "INVALID_THEME_ID";

export interface SectionValidationIssue {
  readonly field: string;
  readonly code: SectionRegistryErrorCode | string;
  readonly message: string;
  readonly sectionId?: string;
  readonly sectionType?: string;
}

export class SectionRegistryValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code: SectionRegistryErrorCode;
  readonly fields: readonly SectionValidationIssue[];

  constructor(
    code: SectionRegistryErrorCode,
    message: string,
    fields: readonly SectionValidationIssue[] = [],
  ) {
    super(message);
    this.name = "SectionRegistryValidationError";
    this.code = code;
    this.fields = fields;
  }
}

export const PERMENKES_TESTIMONIALS_WARNING_CODE = "PERMENKES_HEALTH_TESTIMONIALS_WARNING" as const;

export const PERMENKES_TESTIMONIALS_WARNING_MESSAGE =
  "Kategori usaha kesehatan/medis tunduk pada ketentuan iklan fasilitas pelayanan kesehatan (Permenkes). Testimoni pasien dinonaktifkan secara default dan tidak disarankan menampilkan klaim hasil pengobatan." as const;

export interface SectionValidationWarning {
  readonly code: typeof PERMENKES_TESTIMONIALS_WARNING_CODE;
  readonly sectionId: string;
  readonly sectionType: "testimonials";
  readonly businessCategory: string;
  readonly defaultedOff: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Permenkes Health-Category Detection (REQ-019, DESIGN.md §7)
// ---------------------------------------------------------------------------

const HEALTH_CATEGORY_TOKENS: readonly string[] = [
  "health",
  "healthcare",
  "kesehatan",
  "klinik",
  "clinic",
  "medis",
  "medical",
  "dokter",
  "doctor",
  "physician",
  "dentist",
  "gigi",
  "rumah sakit",
  "hospital",
  "apotek",
  "pharmacy",
  "faskes",
  "bidan",
  "fisioterapi",
  "psikolog",
  "psikiater",
  "medicalclinic",
  "medicalorganization",
  "healthandbeautybusiness",
  "optik medis",
  "laboratorium medis",
];

/**
 * Returns true when a tenant's business category or vertical represents a
 * health/medical service subject to Indonesian Permenkes testimonial rules.
 */
export function isHealthBusinessCategory(category: string | null | undefined): boolean {
  if (typeof category !== "string") return false;
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  return HEALTH_CATEGORY_TOKENS.some((token) => {
    if (normalized === token) return true;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i").test(normalized);
  });
}

// ---------------------------------------------------------------------------
// Safe Primitive Helpers & Zod Schemas for Section Configs
// ---------------------------------------------------------------------------

function hasDisallowedControlChars(value: string, allowNewlines = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowNewlines && (code === 0x0a || code === 0x0d || code === 0x09)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function safeTextSchema(minLen: number, maxLen: number, label: string, allowNewlines = false) {
  return z
    .string()
    .trim()
    .min(minLen, `${label} must be at least ${minLen} character(s)`)
    .max(maxLen, `${label} must be at most ${maxLen} characters`)
    .refine((v) => !hasDisallowedControlChars(v, allowNewlines), {
      message: `${label} must not contain disallowed control characters`,
    });
}

const SafeOptionalTextSchema = (maxLen: number, label: string, allowNewlines = false) =>
  z
    .string()
    .trim()
    .max(maxLen, `${label} must be at most ${maxLen} characters`)
    .refine((v) => !hasDisallowedControlChars(v, allowNewlines), {
      message: `${label} must not contain disallowed control characters`,
    })
    .nullable()
    .optional();

/**
 * Strict navigation/CTA href validator rejecting `javascript:`, `data:`,
 * `vbscript:`, protocol-relative `//`, and control characters.
 */
export const SafeSectionHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((val, ctx) => {
    try {
      sanitizeNavigationHref(val, "href");
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : "Unsafe URL",
      });
    }
  })
  .transform((val) => sanitizeNavigationHref(val, "href"));

/**
 * Strict image source validator allowing public `https://` URLs or safe tenant
 * media paths (`/media/...`, `/t/...`, `/cdn-cgi/image/...`).
 */
export const SafeSectionImageSrcSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((val, ctx) => {
    const clean = sanitizeRichTextImageSrc(val);
    if (!clean) {
      ctx.addIssue({
        code: "custom",
        message: "Image URL must be a valid public https:// URL or safe tenant media path",
      });
    }
  })
  .transform((val) => sanitizeRichTextImageSrc(val)!);

const SafeWhatsAppPhoneSchema = z
  .string()
  .trim()
  .min(8)
  .max(25)
  .superRefine((val, ctx) => {
    try {
      normalizeIndonesianWhatsAppNumber(val);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message:
          err instanceof WhatsAppValidationError
            ? err.message
            : "Invalid Indonesian WhatsApp number",
      });
    }
  })
  .transform((val) => normalizeIndonesianWhatsAppNumber(val));

export const SectionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "Section id must be alphanumeric with hyphens or underscores");

export const SectionImageSchema = z
  .object({
    src: SafeSectionImageSrcSchema,
    alt: safeTextSchema(0, 250, "alt"),
    width: z.number().int().min(1).max(4096).default(1200),
    height: z.number().int().min(1).max(4096).default(800),
  })
  .strict();

export const SectionCtaSchema = z
  .object({
    label: safeTextSchema(1, 80, "cta.label"),
    href: SafeSectionHrefSchema,
    variant: z.enum(["primary", "secondary", "whatsapp"]).default("primary"),
    openInNewTab: z.boolean().default(false),
  })
  .strict();

// 1. Hero Section (Singleton)
export const HeroSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(500, "subheading", true),
    primaryCta: SectionCtaSchema.nullable().optional(),
    secondaryCta: SectionCtaSchema.nullable().optional(),
    media: SectionImageSchema.nullable().optional(),
    highlights: z.array(safeTextSchema(1, 80, "highlight")).max(6).default([]),
    variantOverride: z.enum(["split", "centered", "banner", "minimal"]).nullable().optional(),
  })
  .strict();

// 2. Features / Highlights / Trust Logos / Team Section
export const FeatureItemSchema = z
  .object({
    title: safeTextSchema(1, 120, "item.title"),
    description: SafeOptionalTextSchema(400, "item.description", true),
    badge: SafeOptionalTextSchema(40, "item.badge"),
    meta: SafeOptionalTextSchema(120, "item.meta"),
    image: SectionImageSchema.nullable().optional(),
    href: SafeSectionHrefSchema.nullable().optional(),
  })
  .strict();

export const FeaturesSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    items: z.array(FeatureItemSchema).max(24).default([]),
  })
  .strict();

// 3. Offerings Grid Section (`service` | `product` | `tour` | `vehicle`)
export const SectionOfferingItemSchema = z
  .object({
    slug: SlugSchema,
    offeringType: OfferingTypeSchema,
    title: safeTextSchema(1, 200, "offering.title"),
    summary: SafeOptionalTextSchema(400, "offering.summary", true),
    coverImage: SectionImageSchema.nullable().optional(),
    priceMode: PriceModeSchema.default("on_request"),
    price: IdrAmountSchema.nullable().optional(),
    priceMax: IdrAmountSchema.nullable().optional(),
    negotiable: z.boolean().default(false),
    originalAmount: IdrAmountSchema.nullable().optional(),
    badge: SafeOptionalTextSchema(40, "offering.badge"),
    categoryName: SafeOptionalTextSchema(80, "offering.categoryName"),
    unitStatus: VehicleUnitStatusSchema.nullable().optional(),
    ctaKind: OfferingCtaKindSchema.default("whatsapp"),
    ctaLabel: SafeOptionalTextSchema(80, "offering.ctaLabel"),
    ctaHref: SafeSectionHrefSchema.nullable().optional(),
    whatsappPhone: SafeWhatsAppPhoneSchema.nullable().optional(),
    metaLine: SafeOptionalTextSchema(160, "offering.metaLine"),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.priceMode === "on_request") {
      if (item.price !== undefined && item.price !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message: "on_request offering must not specify a fabricated numeric price",
        });
      }
    } else if (item.price === undefined || item.price === null) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "price is required for fixed, from, and range priceMode",
      });
    }
    if (
      item.priceMode === "range" &&
      item.price !== undefined &&
      item.price !== null &&
      (item.priceMax === undefined || item.priceMax === null || item.priceMax < item.price)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["priceMax"],
        message: "priceMax must be >= price for range pricing",
      });
    }
    if (
      item.originalAmount !== undefined &&
      item.originalAmount !== null &&
      item.price !== undefined &&
      item.price !== null &&
      item.originalAmount <= item.price
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["originalAmount"],
        message: "originalAmount must strictly exceed price",
      });
    }
    if (item.ctaKind === "external_link" && !item.ctaHref) {
      ctx.addIssue({
        code: "custom",
        path: ["ctaHref"],
        message: "ctaHref is required when ctaKind is external_link",
      });
    }
  });

export const OfferingsGridSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    offeringType: OfferingTypeSchema.nullable().optional(),
    limit: z.number().int().min(1).max(24).default(6),
    itemSlugs: z.array(SlugSchema).max(24).default([]),
    items: z.array(SectionOfferingItemSchema).max(24).default([]),
    emptyMessage: SafeOptionalTextSchema(240, "emptyMessage"),
    viewAllCta: SectionCtaSchema.nullable().optional(),
  })
  .strict();

// 4. Rich Text / About Section (sanitized via TASK-006 sanitizeRichTextHtml)
export const MilestoneItemSchema = z
  .object({
    value: safeTextSchema(1, 40, "milestone.value"),
    label: safeTextSchema(1, 80, "milestone.label"),
  })
  .strict();

export const RichTextSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: SafeOptionalTextSchema(180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    bodyHtml: z
      .string()
      .max(100_000, "bodyHtml must be at most 100,000 characters")
      .transform((raw) => sanitizeRichTextHtml(raw)),
    media: SectionImageSchema.nullable().optional(),
    milestones: z.array(MilestoneItemSchema).max(6).default([]),
    cta: SectionCtaSchema.nullable().optional(),
  })
  .strict();

// 5. Gallery Section (images + TASK-089 click-to-load YouTube ID slots)
export const GalleryImageItemSchema = z
  .object({
    kind: z.literal("image").default("image"),
    src: SafeSectionImageSrcSchema,
    alt: safeTextSchema(0, 250, "gallery.alt"),
    width: z.number().int().min(1).max(4096).default(1200),
    height: z.number().int().min(1).max(4096).default(800),
    caption: SafeOptionalTextSchema(200, "gallery.caption"),
  })
  .strict();

export const GalleryYouTubeItemSchema = z
  .object({
    kind: z.literal("youtube"),
    videoId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/, "YouTube videoId must be exactly 11 valid characters"),
    title: safeTextSchema(1, 160, "gallery.title"),
    posterUrl: SafeSectionImageSrcSchema.nullable().optional(),
    caption: SafeOptionalTextSchema(200, "gallery.caption"),
  })
  .strict();

export const GalleryItemSchema = z.union([GalleryYouTubeItemSchema, GalleryImageItemSchema]);

export const GallerySectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    items: z.array(GalleryItemSchema).max(24).default([]),
  })
  .strict();

// 6. Testimonials Section (Permenkes health-category rule enforced)
export const TestimonialItemSchema = z
  .object({
    quote: safeTextSchema(1, 600, "testimonial.quote", true),
    authorName: safeTextSchema(1, 100, "testimonial.authorName"),
    authorRole: SafeOptionalTextSchema(120, "testimonial.authorRole"),
    contextLabel: SafeOptionalTextSchema(100, "testimonial.contextLabel"),
  })
  .strict();

export const TestimonialsSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    items: z.array(TestimonialItemSchema).max(12).default([]),
    disclaimerText: SafeOptionalTextSchema(300, "disclaimerText"),
  })
  .strict();

// 7. FAQ Section (native no-JS <details>/<summary>)
export const FaqItemSchema = z
  .object({
    question: safeTextSchema(1, 240, "faq.question"),
    answer: safeTextSchema(1, 1500, "faq.answer", true),
    defaultOpen: z.boolean().default(false),
  })
  .strict();

export const FaqSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    items: z.array(FaqItemSchema).max(24).default([]),
  })
  .strict();

// 8. Blog Latest Section
export const BlogPostCardSchema = z
  .object({
    slug: SlugSchema,
    title: safeTextSchema(1, 200, "post.title"),
    excerpt: SafeOptionalTextSchema(400, "post.excerpt", true),
    coverImage: SectionImageSchema.nullable().optional(),
    categoryName: SafeOptionalTextSchema(80, "post.categoryName"),
    authorName: SafeOptionalTextSchema(120, "post.authorName"),
    publishedAt: SafeOptionalTextSchema(40, "post.publishedAt"),
    readingTimeMinutes: z.number().int().min(1).max(180).default(3),
  })
  .strict();

export const BlogLatestSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    limit: z.number().int().min(1).max(12).default(3),
    posts: z.array(BlogPostCardSchema).max(12).default([]),
    viewAllHref: SafeSectionHrefSchema.default("/blog"),
    viewAllLabel: safeTextSchema(1, 80, "viewAllLabel").default("Lihat Semua Artikel"),
  })
  .strict();

// 9. CTA Banner / Band / Custom Form Section
export const CtaBannerSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(500, "subheading", true),
    primaryCta: SectionCtaSchema,
    secondaryCta: SectionCtaSchema.nullable().optional(),
    note: SafeOptionalTextSchema(240, "note"),
    formSlug: SlugSchema.nullable().optional(),
  })
  .strict();

// 10. Contact & Location / Branches Section
export const ContactBranchSchema = z
  .object({
    name: safeTextSchema(1, 120, "branch.name"),
    address: safeTextSchema(1, 500, "branch.address", true),
    weekdayHours: SafeOptionalTextSchema(160, "branch.weekdayHours"),
    holidayHours: SafeOptionalTextSchema(160, "branch.holidayHours"),
    phone: SafeOptionalTextSchema(30, "branch.phone"),
    whatsappPhone: SafeWhatsAppPhoneSchema.nullable().optional(),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
  })
  .strict();

export const ContactLocationSectionConfigSchema = z
  .object({
    eyebrow: SafeOptionalTextSchema(80, "eyebrow"),
    heading: safeTextSchema(1, 180, "heading"),
    subheading: SafeOptionalTextSchema(400, "subheading", true),
    address: SafeOptionalTextSchema(500, "address", true),
    weekdayHours: SafeOptionalTextSchema(160, "weekdayHours"),
    holidayHours: SafeOptionalTextSchema(160, "holidayHours"),
    phone: SafeOptionalTextSchema(30, "phone"),
    email: z.email().max(254).nullable().optional(),
    whatsappPhone: SafeWhatsAppPhoneSchema.nullable().optional(),
    whatsappLabel: SafeOptionalTextSchema(80, "whatsappLabel"),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
    mapsLabel: safeTextSchema(1, 80, "mapsLabel").default("Buka di Google Maps"),
    branches: z.array(ContactBranchSchema).max(10).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Closed Discriminated Section Config Schema Map
// ---------------------------------------------------------------------------

export type SectionOfferingItem = z.infer<typeof SectionOfferingItemSchema>;
export type HeroSectionConfig = z.infer<typeof HeroSectionConfigSchema>;
export type FeaturesSectionConfig = z.infer<typeof FeaturesSectionConfigSchema>;
export type OfferingsGridSectionConfig = z.infer<typeof OfferingsGridSectionConfigSchema>;
export type RichTextSectionConfig = z.infer<typeof RichTextSectionConfigSchema>;
export type GallerySectionConfig = z.infer<typeof GallerySectionConfigSchema>;
export type TestimonialsSectionConfig = z.infer<typeof TestimonialsSectionConfigSchema>;
export type FaqSectionConfig = z.infer<typeof FaqSectionConfigSchema>;
export type BlogLatestSectionConfig = z.infer<typeof BlogLatestSectionConfigSchema>;
export type CtaBannerSectionConfig = z.infer<typeof CtaBannerSectionConfigSchema>;
export type ContactLocationSectionConfig = z.infer<typeof ContactLocationSectionConfigSchema>;

export interface SectionConfigByType {
  readonly hero: HeroSectionConfig;
  readonly features: FeaturesSectionConfig;
  readonly highlights: FeaturesSectionConfig;
  readonly trust_logos: FeaturesSectionConfig;
  readonly team: FeaturesSectionConfig;
  readonly offerings_grid: OfferingsGridSectionConfig;
  readonly services_grid: OfferingsGridSectionConfig;
  readonly products_grid: OfferingsGridSectionConfig;
  readonly tours_grid: OfferingsGridSectionConfig;
  readonly vehicles_grid: OfferingsGridSectionConfig;
  readonly rich_text: RichTextSectionConfig;
  readonly about: RichTextSectionConfig;
  readonly gallery: GallerySectionConfig;
  readonly testimonials: TestimonialsSectionConfig;
  readonly faq: FaqSectionConfig;
  readonly blog_latest: BlogLatestSectionConfig;
  readonly latest_posts: BlogLatestSectionConfig;
  readonly cta_banner: CtaBannerSectionConfig;
  readonly cta_band: CtaBannerSectionConfig;
  readonly custom_form: CtaBannerSectionConfig;
  readonly contact_location: ContactLocationSectionConfig;
  readonly contact: ContactLocationSectionConfig;
  readonly branches: ContactLocationSectionConfig;
}

export const SECTION_CONFIG_SCHEMAS: Readonly<Record<ClosedSectionType, z.ZodType>> = {
  hero: HeroSectionConfigSchema,
  features: FeaturesSectionConfigSchema,
  highlights: FeaturesSectionConfigSchema,
  trust_logos: FeaturesSectionConfigSchema,
  team: FeaturesSectionConfigSchema,
  offerings_grid: OfferingsGridSectionConfigSchema,
  services_grid: OfferingsGridSectionConfigSchema,
  products_grid: OfferingsGridSectionConfigSchema,
  tours_grid: OfferingsGridSectionConfigSchema,
  vehicles_grid: OfferingsGridSectionConfigSchema,
  rich_text: RichTextSectionConfigSchema,
  about: RichTextSectionConfigSchema,
  gallery: GallerySectionConfigSchema,
  testimonials: TestimonialsSectionConfigSchema,
  faq: FaqSectionConfigSchema,
  blog_latest: BlogLatestSectionConfigSchema,
  latest_posts: BlogLatestSectionConfigSchema,
  cta_banner: CtaBannerSectionConfigSchema,
  cta_band: CtaBannerSectionConfigSchema,
  custom_form: CtaBannerSectionConfigSchema,
  contact_location: ContactLocationSectionConfigSchema,
  contact: ContactLocationSectionConfigSchema,
  branches: ContactLocationSectionConfigSchema,
};

export interface ValidatedPageSection<T extends ClosedSectionType = ClosedSectionType> {
  readonly id: string;
  readonly type: T;
  readonly schemaVersion: typeof SECTION_REGISTRY_SCHEMA_VERSION;
  readonly enabled: boolean;
  readonly order: number;
  readonly config: SectionConfigByType[T];
}

export type AnyValidatedPageSection = {
  [K in ClosedSectionType]: ValidatedPageSection<K>;
}[ClosedSectionType];

export interface ValidatePageSectionsOptions {
  readonly businessCategory?: string | null;
}

export interface ValidatePageSectionsResult {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly enabledSections: readonly AnyValidatedPageSection[];
  readonly disabledSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly isHealthCategory: boolean;
}

// ---------------------------------------------------------------------------
// Section Registry Validation Implementation
// ---------------------------------------------------------------------------

const SECTION_ENVELOPE_KEYS = new Set(["id", "type", "schemaVersion", "enabled", "order", "config"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function measureJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function detectUnsafeUrlInError(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some((issue) => {
    const pathStr = issue.path.join(".").toLowerCase();
    const msg = issue.message.toLowerCase();
    return (
      pathStr.includes("href") ||
      pathStr.includes("url") ||
      pathStr.includes("src") ||
      msg.includes("unsafe") ||
      msg.includes("url") ||
      msg.includes("https")
    );
  });
}

/**
 * Strictly validates an ordered list of page sections against the closed unified
 * section registry (used on BOTH `/` and `/{pageSlug}`, preview & published).
 *
 * Enforces:
 * - Closed registry check (`UNKNOWN_SECTION_TYPE`)
 * - Singleton uniqueness (`DUPLICATE_SINGLETON_SECTION`, e.g. duplicate `hero`)
 * - Unique section IDs (`DUPLICATE_SECTION_ID`)
 * - Strict config schemas & safe URL sanitization (`UNSAFE_URL`, `INVALID_SECTION_CONFIG`)
 * - Bounded section count & payload size (`TOO_MANY_SECTIONS`, `OVERSIZED_SECTION_CONFIG`)
 * - Permenkes health-category testimonial rule (defaults `testimonials` OFF + warning)
 */
export function validatePageSections(
  rawSections: unknown,
  options: ValidatePageSectionsOptions = {},
): ValidatePageSectionsResult {
  if (!Array.isArray(rawSections)) {
    throw new SectionRegistryValidationError(
      "INVALID_SECTION_CONFIG",
      "Sections payload must be an array",
      [
        {
          field: "sections",
          code: "INVALID_SECTION_CONFIG",
          message: "Expected an array of section entries",
        },
      ],
    );
  }

  if (rawSections.length > MAX_PAGE_SECTIONS) {
    throw new SectionRegistryValidationError(
      "TOO_MANY_SECTIONS",
      `A page may contain at most ${MAX_PAGE_SECTIONS} sections (received ${rawSections.length})`,
      [
        {
          field: "sections",
          code: "TOO_MANY_SECTIONS",
          message: `Maximum ${MAX_PAGE_SECTIONS} sections allowed per page`,
        },
      ],
    );
  }

  const totalBytes = measureJsonBytes(rawSections);
  if (totalBytes > MAX_PAGE_SECTIONS_PAYLOAD_BYTES) {
    throw new SectionRegistryValidationError(
      "OVERSIZED_SECTION_CONFIG",
      `Sections payload exceeds ${MAX_PAGE_SECTIONS_PAYLOAD_BYTES} bytes`,
      [
        {
          field: "sections",
          code: "OVERSIZED_SECTION_CONFIG",
          message: `Total sections payload must be <= ${MAX_PAGE_SECTIONS_PAYLOAD_BYTES} bytes`,
        },
      ],
    );
  }

  const businessCategory = options.businessCategory?.trim() ?? "";
  const isHealthCategory = isHealthBusinessCategory(businessCategory);
  const seenIds = new Set<string>();
  const seenSingletons = new Map<SingletonSectionType, string>();
  const validated: AnyValidatedPageSection[] = [];
  const warnings: SectionValidationWarning[] = [];

  for (let index = 0; index < rawSections.length; index += 1) {
    const entry = rawSections[index];
    const fieldPrefix = `sections[${index}]`;

    if (!isPlainObject(entry)) {
      throw new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        `Section at index ${index} must be an object`,
        [
          {
            field: fieldPrefix,
            code: "INVALID_SECTION_CONFIG",
            message: "Section entry must be a plain object",
          },
        ],
      );
    }

    for (const key of Object.keys(entry)) {
      if (!SECTION_ENVELOPE_KEYS.has(key)) {
        throw new SectionRegistryValidationError(
          "INVALID_SECTION_CONFIG",
          `Unknown property "${key}" on section at index ${index}`,
          [
            {
              field: `${fieldPrefix}.${key}`,
              code: "INVALID_SECTION_CONFIG",
              message: `Unrecognized section property "${key}"`,
            },
          ],
        );
      }
    }

    const rawType = entry.type;
    if (!isClosedSectionType(rawType)) {
      throw new SectionRegistryValidationError(
        "UNKNOWN_SECTION_TYPE",
        `Unknown section type "${String(rawType)}" at index ${index}`,
        [
          {
            field: `${fieldPrefix}.type`,
            code: "UNKNOWN_SECTION_TYPE",
            message: `Section type "${String(rawType)}" is not registered in the closed section registry`,
            sectionType: typeof rawType === "string" ? rawType : undefined,
          },
        ],
      );
    }

    const parsedId = SectionIdSchema.safeParse(entry.id);
    if (!parsedId.success) {
      throw new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        `Invalid section id at index ${index}`,
        [
          {
            field: `${fieldPrefix}.id`,
            code: "INVALID_SECTION_CONFIG",
            message: parsedId.error.issues[0]?.message ?? "Invalid section id",
            sectionType: rawType,
          },
        ],
      );
    }
    const sectionId = parsedId.data;

    if (seenIds.has(sectionId)) {
      throw new SectionRegistryValidationError(
        "DUPLICATE_SECTION_ID",
        `Duplicate section id "${sectionId}" at index ${index}`,
        [
          {
            field: `${fieldPrefix}.id`,
            code: "DUPLICATE_SECTION_ID",
            message: `Section id "${sectionId}" already exists on this page`,
            sectionId,
            sectionType: rawType,
          },
        ],
      );
    }
    seenIds.add(sectionId);

    if (isSingletonSectionType(rawType)) {
      const firstId = seenSingletons.get(rawType);
      if (firstId !== undefined) {
        throw new SectionRegistryValidationError(
          "DUPLICATE_SINGLETON_SECTION",
          `Duplicate singleton section "${rawType}" at index ${index} (already declared by "${firstId}")`,
          [
            {
              field: `${fieldPrefix}.type`,
              code: "DUPLICATE_SINGLETON_SECTION",
              message: `Singleton section "${rawType}" may appear at most once per page`,
              sectionId,
              sectionType: rawType,
            },
          ],
        );
      }
      seenSingletons.set(rawType, sectionId);
    }

    if (entry.schemaVersion !== undefined && entry.schemaVersion !== SECTION_REGISTRY_SCHEMA_VERSION) {
      throw new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        `Unsupported schemaVersion "${String(entry.schemaVersion)}" on section "${sectionId}"`,
        [
          {
            field: `${fieldPrefix}.schemaVersion`,
            code: "INVALID_SECTION_CONFIG",
            message: `schemaVersion must be ${SECTION_REGISTRY_SCHEMA_VERSION}`,
            sectionId,
            sectionType: rawType,
          },
        ],
      );
    }

    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        `Section "${sectionId}" enabled flag must be a boolean`,
        [
          {
            field: `${fieldPrefix}.enabled`,
            code: "INVALID_SECTION_CONFIG",
            message: "enabled must be a boolean",
            sectionId,
            sectionType: rawType,
          },
        ],
      );
    }

    if (
      entry.order !== undefined &&
      (typeof entry.order !== "number" || !Number.isInteger(entry.order) || entry.order < 0 || entry.order > 100)
    ) {
      throw new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        `Section "${sectionId}" order must be an integer between 0 and 100`,
        [
          {
            field: `${fieldPrefix}.order`,
            code: "INVALID_SECTION_CONFIG",
            message: "order must be an integer between 0 and 100",
            sectionId,
            sectionType: rawType,
          },
        ],
      );
    }

    const configBytes = measureJsonBytes(entry.config);
    if (configBytes > MAX_SECTION_CONFIG_BYTES) {
      throw new SectionRegistryValidationError(
        "OVERSIZED_SECTION_CONFIG",
        `Section "${sectionId}" config exceeds ${MAX_SECTION_CONFIG_BYTES} bytes`,
        [
          {
            field: `${fieldPrefix}.config`,
            code: "OVERSIZED_SECTION_CONFIG",
            message: `Section config must be <= ${MAX_SECTION_CONFIG_BYTES} bytes`,
            sectionId,
            sectionType: rawType,
          },
        ],
      );
    }

    const configSchema = SECTION_CONFIG_SCHEMAS[rawType];
    const parsedConfig = configSchema.safeParse(entry.config);
    if (!parsedConfig.success) {
      const isUrlErr = detectUnsafeUrlInError(parsedConfig.error.issues);
      const errCode: SectionRegistryErrorCode = isUrlErr ? "UNSAFE_URL" : "INVALID_SECTION_CONFIG";
      const fields: SectionValidationIssue[] = parsedConfig.error.issues.map((issue) => ({
        field:
          issue.path.length > 0
            ? `${fieldPrefix}.config.${issue.path.join(".")}`
            : `${fieldPrefix}.config`,
        code: errCode,
        message: issue.message,
        sectionId,
        sectionType: rawType,
      }));
      throw new SectionRegistryValidationError(
        errCode,
        `Invalid config for section "${sectionId}" (${rawType}): ${parsedConfig.error.issues[0]?.message ?? "schema validation failed"}`,
        fields,
      );
    }

    // Permenkes health-category testimonial guardrail (REQ-019, DESIGN.md §7):
    // When businessCategory is health/medical, `testimonials` defaults OFF (`enabled: false`)
    // and ALWAYS emits an explicit Permenkes compliance warning.
    let resolvedEnabled: boolean;
    if (rawType === "testimonials" && isHealthCategory) {
      const defaultedOff = entry.enabled === undefined;
      resolvedEnabled = defaultedOff ? false : (entry.enabled as boolean);
      warnings.push({
        code: PERMENKES_TESTIMONIALS_WARNING_CODE,
        sectionId,
        sectionType: "testimonials",
        businessCategory,
        defaultedOff,
        message: PERMENKES_TESTIMONIALS_WARNING_MESSAGE,
      });
    } else {
      resolvedEnabled = entry.enabled === undefined ? true : (entry.enabled as boolean);
    }

    validated.push({
      id: sectionId,
      type: rawType,
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: resolvedEnabled,
      order: index,
      config: parsedConfig.data as SectionConfigByType[typeof rawType],
    } as AnyValidatedPageSection);
  }

  const enabledSections = validated.filter((s) => s.enabled);
  const disabledSectionIds = validated.filter((s) => !s.enabled).map((s) => s.id);

  return {
    sections: validated,
    enabledSections,
    disabledSectionIds,
    warnings,
    isHealthCategory,
  };
}

// ---------------------------------------------------------------------------
// Adapter from Legacy/Published PublicPageSectionDto (TASK-005 / TASK-027)
// ---------------------------------------------------------------------------

export type PublicPageSectionDtoInput = z.infer<typeof PublicPageSectionDtoSchema>;

/**
 * Converts a `PublicPageSectionDto` (`{ id, kind, heading, subheading, bodyHtml, ... }`)
 * from `PageSnapshot.sections` into a canonical `validatePageSections`-ready entry so
 * existing pages from `TASK-005`/`TASK-027` render seamlessly through the unified registry.
 */
export function convertPublicPageSectionDtoToSectionInput(
  dto: PublicPageSectionDtoInput,
  enabled?: boolean,
): {
  readonly id: string;
  readonly type: ClosedSectionType;
  readonly schemaVersion: typeof SECTION_REGISTRY_SCHEMA_VERSION;
  readonly enabled?: boolean;
  readonly config: Record<string, unknown>;
} {
  const heading = dto.heading?.trim() || "Informasi";
  const subheading = dto.subheading ?? null;
  const firstMedia = dto.media?.[0]
    ? {
        src: dto.media[0].url,
        alt: dto.media[0].alt,
        width: dto.media[0].width,
        height: dto.media[0].height,
      }
    : null;

  const base = {
    id: dto.id,
    type: dto.kind as ClosedSectionType,
    schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
    ...(enabled !== undefined ? { enabled } : {}),
  };

  switch (dto.kind) {
    case "hero":
      return {
        ...base,
        config: {
          heading,
          subheading,
          media: firstMedia,
          primaryCta:
            dto.ctaLabel && dto.ctaHref
              ? { label: dto.ctaLabel, href: dto.ctaHref, variant: "primary" }
              : null,
        },
      };
    case "rich_text":
    case "about":
      return {
        ...base,
        config: {
          heading: dto.heading ?? null,
          subheading,
          bodyHtml: dto.bodyHtml ?? "",
          media: firstMedia,
          cta:
            dto.ctaLabel && dto.ctaHref
              ? { label: dto.ctaLabel, href: dto.ctaHref, variant: "primary" }
              : null,
        },
      };
    case "services_grid":
    case "products_grid":
    case "tours_grid":
    case "vehicles_grid": {
      const offeringTypeMap = {
        services_grid: "service",
        products_grid: "product",
        tours_grid: "tour",
        vehicles_grid: "vehicle",
      } as const;
      return {
        ...base,
        config: {
          heading,
          subheading,
          offeringType: offeringTypeMap[dto.kind],
          itemSlugs: dto.itemSlugs ?? [],
          items: [],
          viewAllCta:
            dto.ctaLabel && dto.ctaHref
              ? { label: dto.ctaLabel, href: dto.ctaHref, variant: "secondary" }
              : null,
        },
      };
    }
    case "gallery":
      return {
        ...base,
        config: {
          heading,
          subheading,
          items: (dto.media ?? []).map((m) => ({
            kind: "image" as const,
            src: m.url,
            alt: m.alt,
            width: m.width,
            height: m.height,
          })),
        },
      };
    case "testimonials":
      return {
        ...base,
        config: {
          heading,
          subheading,
          items: [],
        },
      };
    case "faq":
      return {
        ...base,
        config: {
          heading,
          subheading,
          items: [],
        },
      };
    case "latest_posts":
      return {
        ...base,
        config: {
          heading,
          subheading,
          posts: [],
        },
      };
    case "cta_band":
    case "custom_form":
      return {
        ...base,
        config: {
          heading,
          subheading,
          formSlug: dto.formSlug ?? null,
          primaryCta: {
            label: dto.ctaLabel?.trim() || "Hubungi Kami",
            href: dto.ctaHref?.trim() || "#kontak",
            variant: "primary",
          },
        },
      };
    case "contact":
    case "branches":
      return {
        ...base,
        config: {
          heading,
          subheading,
        },
      };
    case "trust_logos":
    case "team":
    default:
      return {
        ...base,
        config: {
          heading,
          subheading,
          items: (dto.media ?? []).map((m, idx) => ({
            title: m.alt || `Mitra ${idx + 1}`,
            image: {
              src: m.url,
              alt: m.alt,
              width: m.width,
              height: m.height,
            },
          })),
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Six Platform Theme Section Profiles & Lossless Theme Switching
// ---------------------------------------------------------------------------

export interface PlatformThemeSectionProfile {
  readonly themeId: PlatformThemeId;
  readonly label: string;
  readonly heroVariant: HeroVariant;
  readonly cardDensity: "comfortable" | "compact" | "spacious";
  readonly gridColumnsDesktop: 2 | 3;
  readonly recommendedOfferingTypes: readonly ("service" | "product" | "tour" | "vehicle")[];
  readonly defaultSectionOrder: readonly ClosedSectionType[];
  readonly supportedSectionTypes: readonly ClosedSectionType[];
}

export const PLATFORM_THEME_SECTION_PROFILES: Readonly<
  Record<PlatformThemeId, PlatformThemeSectionProfile>
> = {
  compro: {
    themeId: "compro",
    label: "Corporate / B2B Compro",
    heroVariant: "split",
    cardDensity: "comfortable",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["service"],
    defaultSectionOrder: [
      "hero",
      "features",
      "about",
      "offerings_grid",
      "gallery",
      "testimonials",
      "faq",
      "blog_latest",
      "cta_banner",
      "contact_location",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
  sales: {
    themeId: "sales",
    label: "Sales Compro & Personal Branding",
    heroVariant: "centered",
    cardDensity: "comfortable",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["service", "product"],
    defaultSectionOrder: [
      "hero",
      "highlights",
      "offerings_grid",
      "about",
      "testimonials",
      "faq",
      "cta_banner",
      "contact_location",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
  travel: {
    themeId: "travel",
    label: "Travel & Umrah Agency",
    heroVariant: "banner",
    cardDensity: "spacious",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["tour"],
    defaultSectionOrder: [
      "hero",
      "offerings_grid",
      "features",
      "gallery",
      "testimonials",
      "faq",
      "blog_latest",
      "cta_banner",
      "contact_location",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
  catalog: {
    themeId: "catalog",
    label: "Product Showcase Catalog",
    heroVariant: "minimal",
    cardDensity: "compact",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["product"],
    defaultSectionOrder: [
      "hero",
      "offerings_grid",
      "features",
      "gallery",
      "faq",
      "cta_banner",
      "contact_location",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
  resto: {
    themeId: "resto",
    label: "F&B & Multi-Branch Outlets",
    heroVariant: "banner",
    cardDensity: "comfortable",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["product", "service"],
    defaultSectionOrder: [
      "hero",
      "offerings_grid",
      "about",
      "gallery",
      "testimonials",
      "contact_location",
      "faq",
      "cta_banner",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
  dealer: {
    themeId: "dealer",
    label: "Automotive & Vehicle Showroom",
    heroVariant: "split",
    cardDensity: "compact",
    gridColumnsDesktop: 3,
    recommendedOfferingTypes: ["vehicle"],
    defaultSectionOrder: [
      "hero",
      "offerings_grid",
      "features",
      "gallery",
      "faq",
      "blog_latest",
      "cta_banner",
      "contact_location",
    ],
    supportedSectionTypes: CLOSED_SECTION_TYPES,
  },
};

export function resolveThemeSectionProfile(themeId: string): PlatformThemeSectionProfile {
  if (Object.prototype.hasOwnProperty.call(PLATFORM_THEME_SECTION_PROFILES, themeId)) {
    return PLATFORM_THEME_SECTION_PROFILES[themeId as PlatformThemeId];
  }
  return PLATFORM_THEME_SECTION_PROFILES.compro;
}

export interface LosslessThemeSwitchResult {
  readonly fromThemeId: string;
  readonly toThemeId: string;
  readonly targetProfile: PlatformThemeSectionProfile;
  readonly sections: readonly AnyValidatedPageSection[];
  readonly enabledSections: readonly AnyValidatedPageSection[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly preservedCount: number;
  readonly droppedCount: 0;
  readonly lossless: true;
}

/**
 * Switches a validated page's section composition between any two registered
 * themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`, or
 * `custom-<slug>`) with 100% data preservation (zero sections dropped, zero
 * config fields lost, exact order and enabled state intact).
 */
export function switchPageThemeLosslessly(params: {
  readonly fromThemeId: string;
  readonly toThemeId: string;
  readonly sections: unknown;
  readonly businessCategory?: string | null;
}): LosslessThemeSwitchResult {
  const fromParsed = ThemeIdSchema.safeParse(params.fromThemeId);
  if (!fromParsed.success) {
    throw new SectionRegistryValidationError(
      "INVALID_THEME_ID",
      `Invalid source themeId "${params.fromThemeId}"`,
      [
        {
          field: "fromThemeId",
          code: "INVALID_THEME_ID",
          message: fromParsed.error.issues[0]?.message ?? "Invalid source themeId",
        },
      ],
    );
  }

  const toParsed = ThemeIdSchema.safeParse(params.toThemeId);
  if (!toParsed.success) {
    throw new SectionRegistryValidationError(
      "INVALID_THEME_ID",
      `Invalid target themeId "${params.toThemeId}"`,
      [
        {
          field: "toThemeId",
          code: "INVALID_THEME_ID",
          message: toParsed.error.issues[0]?.message ?? "Invalid target themeId",
        },
      ],
    );
  }

  const validated = validatePageSections(params.sections, {
    businessCategory: params.businessCategory,
  });

  const targetProfile = resolveThemeSectionProfile(toParsed.data);

  return {
    fromThemeId: fromParsed.data,
    toThemeId: toParsed.data,
    targetProfile,
    sections: validated.sections,
    enabledSections: validated.enabledSections,
    warnings: validated.warnings,
    preservedCount: validated.sections.length,
    droppedCount: 0,
    lossless: true,
  };
}

export interface PreviewPublishedParityResult {
  readonly equal: boolean;
  readonly previewOrder: readonly string[];
  readonly publishedOrder: readonly string[];
  readonly previewEnabledIds: readonly string[];
  readonly publishedEnabledIds: readonly string[];
  readonly mismatchReason: string | null;
}

/**
 * Verifies exact order & `enabled` toggle parity between preview DTO sections
 * and published snapshot sections using the single shared validation pipeline.
 */
export function verifyPreviewPublishedSectionParity(
  previewRawSections: unknown,
  publishedRawSections: unknown,
  options: ValidatePageSectionsOptions = {},
): PreviewPublishedParityResult {
  const preview = validatePageSections(previewRawSections, options);
  const published = validatePageSections(publishedRawSections, options);

  const previewOrder = preview.sections.map((s) => `${s.id}:${s.type}:${s.enabled ? "1" : "0"}`);
  const publishedOrder = published.sections.map((s) => `${s.id}:${s.type}:${s.enabled ? "1" : "0"}`);
  const previewEnabledIds = preview.enabledSections.map((s) => s.id);
  const publishedEnabledIds = published.enabledSections.map((s) => s.id);

  let mismatchReason: string | null = null;
  if (previewOrder.length !== publishedOrder.length) {
    mismatchReason = `Section count differs (preview=${previewOrder.length}, published=${publishedOrder.length})`;
  } else {
    for (let i = 0; i < previewOrder.length; i += 1) {
      if (previewOrder[i] !== publishedOrder[i]) {
        mismatchReason = `Section mismatch at index ${i} (preview=${previewOrder[i]}, published=${publishedOrder[i]})`;
        break;
      }
    }
    if (!mismatchReason && JSON.stringify(preview.sections) !== JSON.stringify(published.sections)) {
      mismatchReason = "Section config payloads differ between preview and published";
    }
  }

  return {
    equal: mismatchReason === null,
    previewOrder,
    publishedOrder,
    previewEnabledIds,
    publishedEnabledIds,
    mismatchReason,
  };
}
