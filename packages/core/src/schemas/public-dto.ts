import { z } from "zod";
import {
  EmailSchema,
  HttpsUrlSchema,
  IdrAmountSchema,
  IsoDateSchema,
  IsoDatetimeSchema,
  NormalizedPhoneSchema,
  OfferingCtaKindSchema,
  OfferingTypeSchema,
  PriceModeSchema,
  PublicDtoMetaSchema,
  PublicMediaAssetSchema,
  PublicSeoMetaSchema,
  SlugSchema,
  ThemeIdSchema,
  VehicleUnitStatusSchema,
  VersionSchema,
} from "./common.ts";

/**
 * Headless-ready published Public DTO schemas (PLAN §6, §7.3, §15).
 * Public loaders expose ONLY these DTOs — never leads, members, tokens, or control-plane rows.
 */

export const PublicSocialLinkSchema = z
  .object({
    platform: z.enum(["instagram", "facebook", "tiktok", "youtube", "linkedin", "x", "website"]),
    url: HttpsUrlSchema,
  })
  .strict();

export const PublicBusinessHoursSchema = z
  .object({
    weekday: z.string().min(1).max(160),
    holiday: z.string().max(160).nullable(),
  })
  .strict();

export const PublicSiteIdentityDtoSchema = z
  .object({
    siteName: z.string().min(1).max(120),
    tagline: z.string().max(240).nullable(),
    businessName: z.string().min(1).max(160),
    businessCategory: z.string().min(1).max(80),
    description: z.string().max(1000).nullable(),
    locale: z.literal("id-ID"),
    timezone: z.string().min(1).max(64),
    publicEmail: EmailSchema.nullable(),
    phone: NormalizedPhoneSchema.nullable(),
    whatsappNumber: NormalizedPhoneSchema.nullable(),
    address: z.string().max(500).nullable(),
    mapsUrl: HttpsUrlSchema.nullable(),
    openingHours: PublicBusinessHoursSchema.nullable(),
    serviceAreas: z.array(z.string().min(1).max(80)).max(20),
    socialLinks: z.array(PublicSocialLinkSchema).max(10),
    logo: PublicMediaAssetSchema.nullable(),
    faviconUrl: HttpsUrlSchema.nullable(),
    defaultOgImage: PublicMediaAssetSchema.nullable(),
    themeId: ThemeIdSchema,
    styleVariant: z.string().min(1).max(40),
    siteVisibility: z.enum(["public", "noindex"]),
    aiCrawlerTrainingOptOut: z.boolean(),
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({ description: "Published public site identity and business profile DTO (headless-ready)." });

export const PublicSectionKindSchema = z
  .enum([
    "hero",
    "rich_text",
    "services_grid",
    "products_grid",
    "tours_grid",
    "vehicles_grid",
    "trust_logos",
    "about",
    "gallery",
    "testimonials",
    "branches",
    "faq",
    "team",
    "cta_band",
    "latest_posts",
    "contact",
    "custom_form",
  ])
  .meta({ description: "Closed 1D section registry shared across all themes (PLAN §7.3)." });

export const PublicPageSectionDtoSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: PublicSectionKindSchema,
    heading: z.string().max(200).nullable(),
    subheading: z.string().max(500).nullable(),
    bodyHtml: z.string().max(50_000).nullable(),
    media: z.array(PublicMediaAssetSchema).max(24).optional(),
    ctaLabel: z.string().max(80).nullable().optional(),
    ctaHref: z.string().max(2048).nullable().optional(),
    formSlug: SlugSchema.nullable().optional(),
    itemSlugs: z.array(SlugSchema).max(24).optional(),
  })
  .strict()
  .meta({ description: "Published page section item from the closed theme section registry." });

export const PublicPageDtoSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    isHomepage: z.boolean(),
    sections: z.array(PublicPageSectionDtoSchema).max(30),
    seo: PublicSeoMetaSchema,
    publishedAt: IsoDatetimeSchema,
    contentModifiedAt: IsoDatetimeSchema,
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({ description: "Published public page DTO (headless-ready)." });

export const PublicAuthorDtoSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    bio: z.string().max(300).nullable(),
    avatar: PublicMediaAssetSchema.nullable(),
    sameAs: z.array(HttpsUrlSchema).max(5),
  })
  .strict()
  .meta({ description: "Public blog author byline DTO (separate from private account email)." });

export const PublicTaxonomyDtoSchema = z
  .object({
    kind: z.enum(["post_category", "post_tag", "offering_category"]),
    slug: SlugSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable(),
    parentSlug: SlugSchema.nullable(),
    publishedCount: z.number().int().min(0),
    indexable: z.boolean(),
  })
  .strict()
  .meta({ description: "Published public taxonomy archive DTO." });

export const PublicTocEntrySchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(200),
    level: z.union([z.literal(2), z.literal(3)]),
  })
  .strict();

export const PublicPostDtoSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    excerpt: z.string().max(500).nullable(),
    sanitizedHtml: z.string().max(200_000),
    toc: z.array(PublicTocEntrySchema).max(100),
    featuredImage: PublicMediaAssetSchema.nullable(),
    author: PublicAuthorDtoSchema,
    primaryCategory: PublicTaxonomyDtoSchema.nullable(),
    categories: z.array(PublicTaxonomyDtoSchema).max(10),
    tags: z.array(PublicTaxonomyDtoSchema).max(20),
    readingTimeMinutes: z.number().int().min(1).max(180),
    seo: PublicSeoMetaSchema,
    publishedAt: IsoDatetimeSchema,
    contentModifiedAt: IsoDatetimeSchema,
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({ description: "Published public blog post DTO (headless-ready)." });

export const PublicVideoAssetSchema = z
  .object({
    url: HttpsUrlSchema,
    posterUrl: HttpsUrlSchema,
    width: z.number().int().min(1).max(1920),
    height: z.number().int().min(1).max(1080),
    durationSeconds: z.number().min(0.1).max(600),
    captionsUrl: HttpsUrlSchema.nullable(),
  })
  .strict();

export const PublicOfferingAttributesSchema = z
  .object({
    serviceSteps: z.array(z.string().min(1).max(200)).max(12).optional(),
    serviceArea: z.string().max(160).optional(),
    destination: z.string().max(160).optional(),
    durationDays: z.number().int().min(1).max(90).optional(),
    departureDates: z.array(IsoDateSchema).max(36).optional(),
    inclusions: z.array(z.string().min(1).max(200)).max(20).optional(),
    exclusions: z.array(z.string().min(1).max(200)).max(20).optional(),
    vehicleYear: z.number().int().min(1980).max(2100).optional(),
    transmission: z.enum(["manual", "automatic", "cvt", "dct", "ev"]).optional(),
    fuelType: z.enum(["bensin", "diesel", "hybrid", "listrik"]).optional(),
    mileageKm: z.number().int().min(0).max(2_000_000).optional(),
    creditEstimateEnabled: z.boolean().optional(),
  })
  .strict()
  .meta({ description: "Typed per-vertical offering attributes payload." });

export const PublicOfferingDtoSchema = z
  .object({
    offeringType: OfferingTypeSchema,
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    summary: z.string().max(500).nullable(),
    descriptionHtml: z.string().max(100_000),
    coverImage: PublicMediaAssetSchema.nullable(),
    gallery: z.array(PublicMediaAssetSchema).max(12),
    video: PublicVideoAssetSchema.nullable(),
    youtubeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/, "YouTube ID must be exactly 11 valid characters")
      .nullable(),
    priceMode: PriceModeSchema,
    price: IdrAmountSchema.nullable(),
    priceMax: IdrAmountSchema.nullable(),
    negotiable: z.boolean(),
    originalAmount: IdrAmountSchema.nullable(),
    badge: z.string().max(40).nullable(),
    ctaKind: OfferingCtaKindSchema,
    ctaLabel: z.string().min(1).max(80),
    ctaHref: z.string().max(2048).nullable(),
    unitStatus: VehicleUnitStatusSchema.nullable(),
    attributesVersion: VersionSchema,
    attributes: PublicOfferingAttributesSchema,
    categories: z.array(PublicTaxonomyDtoSchema).max(10),
    seo: PublicSeoMetaSchema,
    publishedAt: IsoDatetimeSchema,
    contentModifiedAt: IsoDatetimeSchema,
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({
    description:
      "Published public typed offering DTO covering service, product, tour, and vehicle verticals (PLAN §5.2 & §6).",
  });

// Cycle-free 3-level menu tree (PLAN §5.2: max depth 3, no cycles)
export const PublicMenuItemLevel3Schema = z
  .object({
    label: z.string().min(1).max(80),
    href: z.string().min(1).max(2048),
    openInNewTab: z.boolean(),
  })
  .strict();

export const PublicMenuItemLevel2Schema = z
  .object({
    label: z.string().min(1).max(80),
    href: z.string().min(1).max(2048),
    openInNewTab: z.boolean(),
    children: z.array(PublicMenuItemLevel3Schema).max(20),
  })
  .strict();

export const PublicMenuItemLevel1Schema = z
  .object({
    label: z.string().min(1).max(80),
    href: z.string().min(1).max(2048),
    openInNewTab: z.boolean(),
    children: z.array(PublicMenuItemLevel2Schema).max(20),
  })
  .strict();

export const PublicMenuTreeDtoSchema = z
  .object({
    location: z.enum(["header", "footer", "mobile"]),
    items: z.array(PublicMenuItemLevel1Schema).max(20),
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({ description: "Published cycle-free 3-level public navigation menu tree DTO." });

export const PublicBranchDtoSchema = z
  .object({
    name: z.string().min(1).max(120),
    address: z.string().min(1).max(500),
    phone: NormalizedPhoneSchema.nullable(),
    whatsappNumber: NormalizedPhoneSchema.nullable(),
    mapsUrl: HttpsUrlSchema.nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    openingHours: PublicBusinessHoursSchema.nullable(),
    timezone: z.string().min(1).max(64),
    sortOrder: z.number().int().min(0).max(100),
  })
  .strict()
  .meta({ description: "Published public branch/outlet location DTO (REQ-088)." });

export const PublicFormConditionSchema = z
  .object({
    dependsOnField: z.string().min(1).max(64),
    equalsValue: z.string().min(1).max(200),
  })
  .strict();

export const PublicFormFieldDtoSchema = z
  .object({
    name: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    fieldType: z.enum([
      "text",
      "textarea",
      "email",
      "phone",
      "select",
      "radio",
      "checkbox",
      "date",
      "time_slot",
    ]),
    required: z.boolean(),
    placeholder: z.string().max(160).nullable(),
    options: z.array(z.string().min(1).max(120)).max(20).optional(),
    condition: PublicFormConditionSchema.nullable().optional(),
  })
  .strict();

export const PublicFormDtoSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(500).nullable(),
    fields: z.array(PublicFormFieldDtoSchema).min(1).max(12),
    submitLabel: z.string().min(1).max(60),
    afterSubmitAction: z.enum(["message", "whatsapp", "url"]),
    afterSubmitMessage: z.string().max(500).nullable(),
    formVersion: VersionSchema,
    meta: PublicDtoMetaSchema,
  })
  .strict()
  .meta({ description: "Published public custom/built-in form definition DTO (REQ-080)." });

export const PUBLIC_DTO_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  PublicSocialLink: PublicSocialLinkSchema,
  PublicBusinessHours: PublicBusinessHoursSchema,
  PublicSiteIdentityDto: PublicSiteIdentityDtoSchema,
  PublicSectionKind: PublicSectionKindSchema,
  PublicPageSectionDto: PublicPageSectionDtoSchema,
  PublicPageDto: PublicPageDtoSchema,
  PublicAuthorDto: PublicAuthorDtoSchema,
  PublicTaxonomyDto: PublicTaxonomyDtoSchema,
  PublicTocEntry: PublicTocEntrySchema,
  PublicPostDto: PublicPostDtoSchema,
  PublicVideoAsset: PublicVideoAssetSchema,
  PublicOfferingAttributes: PublicOfferingAttributesSchema,
  PublicOfferingDto: PublicOfferingDtoSchema,
  PublicMenuItemLevel3: PublicMenuItemLevel3Schema,
  PublicMenuItemLevel2: PublicMenuItemLevel2Schema,
  PublicMenuItemLevel1: PublicMenuItemLevel1Schema,
  PublicMenuTreeDto: PublicMenuTreeDtoSchema,
  PublicBranchDto: PublicBranchDtoSchema,
  PublicFormCondition: PublicFormConditionSchema,
  PublicFormFieldDto: PublicFormFieldDtoSchema,
  PublicFormDto: PublicFormDtoSchema,
};

export type PublicSiteIdentityDto = z.infer<typeof PublicSiteIdentityDtoSchema>;
export type PublicPageDto = z.infer<typeof PublicPageDtoSchema>;
export type PublicPostDto = z.infer<typeof PublicPostDtoSchema>;
export type PublicOfferingDto = z.infer<typeof PublicOfferingDtoSchema>;
export type PublicMenuTreeDto = z.infer<typeof PublicMenuTreeDtoSchema>;
export type PublicBranchDto = z.infer<typeof PublicBranchDtoSchema>;
export type PublicFormDto = z.infer<typeof PublicFormDtoSchema>;
