import { z } from "zod";
import {
  createPaginatedResponseSchema,
  EmailSchema,
  HttpsUrlSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IdrAmountSchema,
  IsoDatetimeSchema,
  NormalizedPhoneSchema,
  OfferingCtaKindSchema,
  OfferingTypeSchema,
  PriceModeSchema,
  RESOURCE_ID_PATH_PARAM,
  SequentialIdSchema,
  SlugSchema,
  TENANT_HANDLE_PATH_PARAM,
  ThemeIdSchema,
  UlidSchema,
  VehicleUnitStatusSchema,
  VersionSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";
import {
  PublicBusinessHoursSchema,
  PublicMenuItemLevel1Schema,
  PublicOfferingAttributesSchema,
  PublicPageSectionDtoSchema,
  PublicSocialLinkSchema,
} from "./public-dto.ts";

/**
 * CMS domain schemas: pages, posts, taxonomies, typed offerings, menus,
 * site identity & grouped settings, themes, media upload intents, branches/outlets,
 * draft preview, revisions, trash, and authenticated lead management
 * (PLAN §5.2, §6, §7, §11.2–11.4, §14, §15.3).
 *
 * Every write schema is `.strict()` and NEVER declares tenantId/organizationId.
 */

export const ContentLifecycleStatusSchema = z
  .enum(["draft", "published", "trashed"])
  .meta({ description: "CMS resource draft/published/trashed status." });

export const ResourceSeoInputSchema = z
  .object({
    titleOverride: z.string().max(200).nullable().optional(),
    descriptionOverride: z.string().max(500).nullable().optional(),
    focusKeyphrase: z.string().max(100).nullable().optional(),
    ogTitleOverride: z.string().max(200).nullable().optional(),
    ogDescriptionOverride: z.string().max(500).nullable().optional(),
    ogImageMediaId: SequentialIdSchema.nullable().optional(),
    schemaType: z
      .enum([
        "WebPage",
        "AboutPage",
        "ContactPage",
        "CollectionPage",
        "FAQPage",
        "BlogPosting",
        "Article",
        "NewsArticle",
        "Service",
        "Product",
        "TouristTrip",
      ])
      .nullable()
      .optional(),
    noindex: z.boolean().optional(),
    nofollow: z.boolean().optional(),
  })
  .strict()
  .meta({ description: "Per-resource SEO overrides (no arbitrary HTML/script/canonical; PLAN §15.3)." });

// --- Pages ---
export const PageCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: SlugSchema.optional(),
    sections: z.array(PublicPageSectionDtoSchema).max(30).default([]),
    seo: ResourceSeoInputSchema.optional(),
  })
  .strict()
  .meta({ description: "Create a new draft CMS page (rejects unknown fields and tenant selectors)." });

export const PageUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    slug: SlugSchema.optional(),
    sections: z.array(PublicPageSectionDtoSchema).max(30).optional(),
    seo: ResourceSeoInputSchema.optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Save draft edits to a page with optimistic concurrency version." });

export const ResourcePublishRequestSchema = z
  .object({
    version: VersionSchema,
    confirmSlugChange: z.boolean().optional(),
  })
  .strict()
  .meta({ description: "Atomically publish draft snapshot and bump tenant revision." });

export const ResourceUnpublishRequestSchema = z
  .object({
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Unpublish a live resource and invalidate caches atomically." });

export const PageRecordSchema = z
  .object({
    id: SequentialIdSchema,
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    status: ContentLifecycleStatusSchema,
    isHomepage: z.boolean(),
    sections: z.array(PublicPageSectionDtoSchema).max(30),
    seo: ResourceSeoInputSchema.nullable(),
    version: VersionSchema,
    publishedAt: IsoDatetimeSchema.nullable(),
    contentModifiedAt: IsoDatetimeSchema.nullable(),
    updatedAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({ description: "Admin page record with draft/published lifecycle metadata." });

export const PageListResponseSchema = createPaginatedResponseSchema(
  PageRecordSchema,
  "Paginated list of pages for the scoped tenant.",
);

// --- Revisions & Trash ---
export const RevisionSummarySchema = z
  .object({
    revisionNumber: SequentialIdSchema,
    createdByUserId: UlidSchema,
    createdAt: IsoDatetimeSchema,
    summary: z.string().max(240),
  })
  .strict()
  .meta({ description: "Content revision history entry (latest 20 retained per resource)." });

export const RevisionListResponseSchema = z
  .object({
    items: z.array(RevisionSummarySchema).max(20),
  })
  .strict();

export const RevisionRestoreRequestSchema = z
  .object({
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Restore a previous revision into draft state." });

export const TrashRestoreRequestSchema = z
  .object({
    version: VersionSchema,
    resolvedSlug: SlugSchema.optional(),
  })
  .strict()
  .meta({ description: "Restore a trashed resource as draft only, resolving slug conflicts." });

// --- Posts ---
export const RestrictedRichTextNodeSchema = z
  .object({
    type: z.enum([
      "doc",
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "table",
      "tableRow",
      "tableCell",
      "image",
      "text",
      "hardBreak",
    ]),
    text: z.string().max(10_000).optional(),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
    href: HttpsUrlSchema.optional(),
    mediaId: SequentialIdSchema.optional(),
    marks: z.array(z.enum(["bold", "italic", "underline", "code", "link"])).max(5).optional(),
  })
  .strict();

export const RestrictedRichTextDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    blocks: z.array(RestrictedRichTextNodeSchema).max(500),
  })
  .strict()
  .meta({
    description:
      "Restricted TipTap-compatible JSON document (no scripts, iframes, forms, or arbitrary styles; PLAN §7.3).",
  });

export const PostCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: SlugSchema.optional(),
    excerpt: z.string().max(500).nullable().optional(),
    body: RestrictedRichTextDocSchema,
    featuredMediaId: SequentialIdSchema.nullable().optional(),
    primaryCategoryId: SequentialIdSchema.nullable().optional(),
    categoryIds: z.array(SequentialIdSchema).max(10).optional(),
    tagIds: z.array(SequentialIdSchema).max(20).optional(),
    enableToc: z.boolean().optional(),
    seo: ResourceSeoInputSchema.optional(),
  })
  .strict()
  .meta({ description: "Create a new draft blog post." });

export const PostUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    slug: SlugSchema.optional(),
    excerpt: z.string().max(500).nullable().optional(),
    body: RestrictedRichTextDocSchema.optional(),
    featuredMediaId: SequentialIdSchema.nullable().optional(),
    primaryCategoryId: SequentialIdSchema.nullable().optional(),
    categoryIds: z.array(SequentialIdSchema).max(10).optional(),
    tagIds: z.array(SequentialIdSchema).max(20).optional(),
    enableToc: z.boolean().optional(),
    seo: ResourceSeoInputSchema.optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Update a draft blog post with optimistic concurrency version." });

export const PostRecordSchema = z
  .object({
    id: SequentialIdSchema,
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    excerpt: z.string().max(500).nullable(),
    status: ContentLifecycleStatusSchema,
    featuredMediaId: SequentialIdSchema.nullable(),
    primaryCategoryId: SequentialIdSchema.nullable(),
    categoryIds: z.array(SequentialIdSchema).max(10),
    tagIds: z.array(SequentialIdSchema).max(20),
    enableToc: z.boolean(),
    version: VersionSchema,
    publishedAt: IsoDatetimeSchema.nullable(),
    contentModifiedAt: IsoDatetimeSchema.nullable(),
    updatedAt: IsoDatetimeSchema,
  })
  .strict();

export const PostListResponseSchema = createPaginatedResponseSchema(
  PostRecordSchema,
  "Paginated list of blog posts for the scoped tenant.",
);

// --- Taxonomies ---
export const TaxonomyKindSchema = z
  .enum(["post_category", "post_tag", "offering_category"])
  .meta({ description: "Separated taxonomy namespaces (PLAN §11.3)." });

export const TaxonomyCreateRequestSchema = z
  .object({
    kind: TaxonomyKindSchema,
    name: z.string().trim().min(1).max(100),
    slug: SlugSchema.optional(),
    description: z.string().max(500).nullable().optional(),
    parentId: SequentialIdSchema.nullable().optional(),
    indexable: z.boolean().optional(),
  })
  .strict()
  .refine((val) => !(val.kind === "post_tag" && val.parentId !== undefined && val.parentId !== null), {
    message: "Tags are flat and cannot declare a parent category",
  })
  .meta({ description: "Create a category (depth <= 3) or flat tag." });

export const TaxonomyUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    slug: SlugSchema.optional(),
    description: z.string().max(500).nullable().optional(),
    parentId: SequentialIdSchema.nullable().optional(),
    indexable: z.boolean().optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Immediate taxonomy metadata update (does not publish draft post bodies)." });

export const TaxonomyRecordSchema = z
  .object({
    id: SequentialIdSchema,
    kind: TaxonomyKindSchema,
    name: z.string().min(1).max(100),
    slug: SlugSchema,
    description: z.string().max(500).nullable(),
    parentId: SequentialIdSchema.nullable(),
    depth: z.number().int().min(1).max(3),
    publishedCount: z.number().int().min(0),
    indexable: z.boolean(),
    version: VersionSchema,
  })
  .strict();

export const TaxonomyListResponseSchema = createPaginatedResponseSchema(
  TaxonomyRecordSchema,
  "Paginated list of taxonomies in the scoped tenant.",
);

// --- Typed Offerings (service | product | tour | vehicle) ---
function validateOfferingPricing(
  val: {
    readonly priceMode?: "fixed" | "from" | "range" | "on_request";
    readonly price?: number | null;
    readonly priceMax?: number | null;
    readonly originalAmount?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  if (val.priceMode === "on_request") {
    if (val.price !== undefined && val.price !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "Inquiry/on_request offerings must not supply a fabricated price (PLAN §5)",
      });
    }
    return;
  }
  if (
    (val.priceMode === "fixed" || val.priceMode === "from" || val.priceMode === "range") &&
    (val.price === undefined || val.price === null)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["price"],
      message: "Price is required for fixed, from, and range pricing modes",
    });
  }
  if (
    val.priceMode === "range" &&
    val.price !== undefined &&
    val.price !== null &&
    (val.priceMax === undefined || val.priceMax === null || val.priceMax <= val.price)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["priceMax"],
      message: "priceMax must exceed price in range pricing mode",
    });
  }
  if (
    val.originalAmount !== undefined &&
    val.originalAmount !== null &&
    val.price !== undefined &&
    val.price !== null &&
    val.originalAmount <= val.price
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["originalAmount"],
      message: "originalAmount must strictly exceed price when present (PLAN §5)",
    });
  }
}

export const OfferingCreateRequestSchema = z
  .object({
    offeringType: OfferingTypeSchema,
    title: z.string().trim().min(1).max(200),
    slug: SlugSchema.optional(),
    summary: z.string().max(500).nullable().optional(),
    description: RestrictedRichTextDocSchema,
    coverMediaId: SequentialIdSchema.nullable().optional(),
    galleryMediaIds: z.array(SequentialIdSchema).max(12).optional(),
    videoMediaId: SequentialIdSchema.nullable().optional(),
    youtubeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/)
      .nullable()
      .optional(),
    priceMode: PriceModeSchema,
    price: IdrAmountSchema.nullable().optional(),
    priceMax: IdrAmountSchema.nullable().optional(),
    negotiable: z.boolean().optional(),
    originalAmount: IdrAmountSchema.nullable().optional(),
    badge: z.string().max(40).nullable().optional(),
    ctaKind: OfferingCtaKindSchema,
    ctaLabel: z.string().trim().min(1).max(80).optional(),
    externalUrl: HttpsUrlSchema.nullable().optional(),
    whatsappOverride: NormalizedPhoneSchema.nullable().optional(),
    whatsappTemplate: z.string().max(1000).nullable().optional(),
    unitStatus: VehicleUnitStatusSchema.nullable().optional(),
    categoryIds: z.array(SequentialIdSchema).max(10).optional(),
    attributes: PublicOfferingAttributesSchema.optional(),
    seo: ResourceSeoInputSchema.optional(),
  })
  .strict()
  .superRefine(validateOfferingPricing)
  .meta({
    description:
      "Create a draft typed offering (service, product, tour, or vehicle; showcase only, no cart/checkout).",
  });

export const OfferingUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    slug: SlugSchema.optional(),
    summary: z.string().max(500).nullable().optional(),
    description: RestrictedRichTextDocSchema.optional(),
    coverMediaId: SequentialIdSchema.nullable().optional(),
    galleryMediaIds: z.array(SequentialIdSchema).max(12).optional(),
    videoMediaId: SequentialIdSchema.nullable().optional(),
    youtubeId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/)
      .nullable()
      .optional(),
    priceMode: PriceModeSchema.optional(),
    price: IdrAmountSchema.nullable().optional(),
    priceMax: IdrAmountSchema.nullable().optional(),
    negotiable: z.boolean().optional(),
    originalAmount: IdrAmountSchema.nullable().optional(),
    badge: z.string().max(40).nullable().optional(),
    ctaKind: OfferingCtaKindSchema.optional(),
    ctaLabel: z.string().trim().min(1).max(80).optional(),
    externalUrl: HttpsUrlSchema.nullable().optional(),
    whatsappOverride: NormalizedPhoneSchema.nullable().optional(),
    whatsappTemplate: z.string().max(1000).nullable().optional(),
    unitStatus: VehicleUnitStatusSchema.nullable().optional(),
    categoryIds: z.array(SequentialIdSchema).max(10).optional(),
    attributes: PublicOfferingAttributesSchema.optional(),
    seo: ResourceSeoInputSchema.optional(),
    version: VersionSchema,
  })
  .strict()
  .superRefine(validateOfferingPricing)
  .meta({ description: "Update a draft typed offering with optimistic concurrency." });

export const OfferingRecordSchema = z
  .object({
    id: SequentialIdSchema,
    offeringType: OfferingTypeSchema,
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    status: ContentLifecycleStatusSchema,
    priceMode: PriceModeSchema,
    price: IdrAmountSchema.nullable(),
    priceMax: IdrAmountSchema.nullable(),
    originalAmount: IdrAmountSchema.nullable(),
    ctaKind: OfferingCtaKindSchema,
    unitStatus: VehicleUnitStatusSchema.nullable(),
    version: VersionSchema,
    publishedAt: IsoDatetimeSchema.nullable(),
    contentModifiedAt: IsoDatetimeSchema.nullable(),
    updatedAt: IsoDatetimeSchema,
  })
  .strict();

export const OfferingListResponseSchema = createPaginatedResponseSchema(
  OfferingRecordSchema,
  "Paginated list of typed offerings for the scoped tenant.",
);

// --- Menus ---
export const MenuLocationSchema = z.enum(["header", "footer", "mobile"]);

export const MenuUpsertRequestSchema = z
  .object({
    items: z.array(PublicMenuItemLevel1Schema).max(20),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Save cycle-free 3-level navigation menu for a location." });

export const MenuRecordSchema = z
  .object({
    location: MenuLocationSchema,
    items: z.array(PublicMenuItemLevel1Schema).max(20),
    version: VersionSchema,
    updatedAt: IsoDatetimeSchema,
  })
  .strict();

// --- Site Identity & Grouped Settings ---
export const SettingsGroupSchema = z
  .enum(["general", "business", "reading", "seo", "privacy", "analytics"])
  .meta({ description: "Settings screen group (PLAN §6 & §11.2)." });

export const SiteIdentitySettingsPatchSchema = z
  .object({
    siteName: z.string().trim().min(1).max(120).optional(),
    tagline: z.string().max(240).nullable().optional(),
    businessName: z.string().trim().min(1).max(160).optional(),
    businessCategory: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(1000).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    publicEmail: EmailSchema.nullable().optional(),
    phone: NormalizedPhoneSchema.nullable().optional(),
    whatsappNumber: NormalizedPhoneSchema.nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
    openingHours: PublicBusinessHoursSchema.nullable().optional(),
    serviceAreas: z.array(z.string().min(1).max(80)).max(20).optional(),
    socialLinks: z.array(PublicSocialLinkSchema).max(10).optional(),
    logoMediaId: SequentialIdSchema.nullable().optional(),
    faviconMediaId: SequentialIdSchema.nullable().optional(),
    defaultOgMediaId: SequentialIdSchema.nullable().optional(),
    homepagePageId: SequentialIdSchema.nullable().optional(),
    blogEnabled: z.boolean().optional(),
    enabledOfferingTypes: z.array(OfferingTypeSchema).max(4).optional(),
    itemsPerPage: z.union([z.literal(6), z.literal(12), z.literal(24)]).optional(),
    siteVisibility: z.enum(["public", "noindex"]).optional(),
    aiCrawlerTrainingOptOut: z.boolean().optional(),
    ga4MeasurementId: z
      .string()
      .regex(/^G-[A-Z0-9]{6,20}$/)
      .nullable()
      .optional(),
    gtmContainerId: z
      .string()
      .regex(/^GTM-[A-Z0-9]{4,12}$/)
      .nullable()
      .optional(),
    gtmOwnerRiskAcknowledged: z.boolean().optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({
    description:
      "Grouped site identity and public configuration draft patch (no secret tokens or credentials; PLAN §11.2).",
  });

export const SettingsStateResponseSchema = z
  .object({
    group: SettingsGroupSchema,
    draftVersion: VersionSchema,
    publishedVersion: VersionSchema,
    hasUnpublishedChanges: z.boolean(),
    updatedAt: IsoDatetimeSchema,
  })
  .strict();

// --- Themes & Custom Theme Service ---
export const ThemeSummarySchema = z
  .object({
    themeId: ThemeIdSchema,
    name: z.string().min(1).max(100),
    tier: z.enum(["included", "paid_once", "custom"]),
    granted: z.boolean(),
    active: z.boolean(),
    styleVariants: z.array(z.string().min(1).max(40)).max(12),
  })
  .strict();

export const ThemeListResponseSchema = z
  .object({
    items: z.array(ThemeSummarySchema).max(50),
    activeThemeId: ThemeIdSchema,
    version: VersionSchema,
  })
  .strict();

export const ThemeActivateRequestSchema = z
  .object({
    styleVariant: z.string().min(1).max(40).optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Atomically activate a granted theme and bump tenant revision." });

export const CustomThemeRequestCreateSchema = z
  .object({
    packageId: UlidSchema.nullable().optional(),
    brandName: z.string().trim().min(1).max(100),
    brief: z.string().trim().min(10).max(2000),
    referenceUrls: z.array(HttpsUrlSchema).max(5).optional(),
    budgetRange: z.string().max(120).nullable().optional(),
    contactPreference: z.enum(["whatsapp", "email"]),
  })
  .strict()
  .meta({
    description:
      "Submit a custom theme service request (max 3/day per tenant, HTTPS reference URLs never fetched server-side; PLAN §11.4).",
  });

export const CustomThemeRequestRecordSchema = z
  .object({
    requestId: UlidSchema,
    requestNumber: z.string().min(1).max(40),
    brandName: z.string().min(1).max(100),
    status: z.enum([
      "new",
      "contacted",
      "quoted",
      "in_progress",
      "delivered",
      "declined",
      "cancelled",
    ]),
    createdAt: IsoDatetimeSchema,
  })
  .strict();

// --- Media Upload Metadata ---
export const AllowedImageMimeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/tiff",
]);

export const AllowedVideoMimeSchema = z.enum(["video/mp4", "video/quicktime", "video/webm"]);

export const MediaUploadIntentRequestSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    filename: z
      .string()
      .min(1)
      .max(180)
      .regex(/^[^/\\:*?"<>|]+$/, "Filename must not contain path separators or control characters"),
    mimeType: z.union([AllowedImageMimeSchema, AllowedVideoMimeSchema]),
    declaredBytes: z.number().int().min(1).max(10_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 must be 64 lowercase hex characters"),
    alt: z.string().max(250),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === "image") {
      if (!AllowedImageMimeSchema.safeParse(val.mimeType).success) {
        ctx.addIssue({
          code: "custom",
          path: ["mimeType"],
          message: "Unsupported image MIME type (SVG and BMP are rejected; PLAN §7.3)",
        });
      }
      if (val.declaredBytes > 5_000_000) {
        ctx.addIssue({
          code: "custom",
          path: ["declaredBytes"],
          message: "Raw image upload cannot exceed 5,000,000 bytes (PLAN §7.2)",
        });
      }
    } else if (!AllowedVideoMimeSchema.safeParse(val.mimeType).success) {
      ctx.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "Video MIME type must be MP4, MOV, or WebM (PLAN §7.3)",
      });
    }
  })
  .meta({
    description:
      "Reserve tenant storage quota and create a same-origin upload intent (rejects SVG/BMP and oversized payloads; PLAN §7.2–7.3).",
  });

export const MediaUploadIntentResponseSchema = z
  .object({
    intentId: UlidSchema,
    uploadPath: z.string().startsWith("/api/tenants/").max(256),
    expiresAt: IsoDatetimeSchema,
    reservedBytes: z.number().int().min(1),
    quotaUsedBytes: z.number().int().min(0),
    quotaLimitBytes: z.number().int().min(1),
  })
  .strict();

export const MediaItemRecordSchema = z
  .object({
    id: SequentialIdSchema,
    kind: z.enum(["image", "video"]),
    status: z.enum(["quarantined", "processing", "ready", "failed", "trashed"]),
    alt: z.string().max(250),
    normalizedBytes: z.number().int().min(0),
    width: z.number().int().min(1).nullable(),
    height: z.number().int().min(1).nullable(),
    publicUrl: HttpsUrlSchema.nullable(),
    version: VersionSchema,
    createdAt: IsoDatetimeSchema,
  })
  .strict();

export const MediaListResponseSchema = createPaginatedResponseSchema(
  MediaItemRecordSchema,
  "Paginated media library for the scoped tenant.",
);

export const MediaMetadataUpdateRequestSchema = z
  .object({
    alt: z.string().max(250),
    version: VersionSchema,
  })
  .strict();

// --- Outlets / Branches ---
export const BranchCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().min(1).max(500),
    phone: NormalizedPhoneSchema.nullable().optional(),
    whatsappNumber: NormalizedPhoneSchema.nullable().optional(),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    openingHours: PublicBusinessHoursSchema.nullable().optional(),
    timezone: z.string().min(1).max(64).default("Asia/Jakarta"),
    sortOrder: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .meta({ description: "Create a tenant branch/outlet (up to 10 branches; REQ-088)." });

export const BranchUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    phone: NormalizedPhoneSchema.nullable().optional(),
    whatsappNumber: NormalizedPhoneSchema.nullable().optional(),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    openingHours: PublicBusinessHoursSchema.nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
    version: VersionSchema,
  })
  .strict();

export const BranchRecordSchema = z
  .object({
    id: SequentialIdSchema,
    name: z.string().min(1).max(120),
    address: z.string().min(1).max(500),
    phone: NormalizedPhoneSchema.nullable(),
    whatsappNumber: NormalizedPhoneSchema.nullable(),
    mapsUrl: HttpsUrlSchema.nullable(),
    timezone: z.string().min(1).max(64),
    sortOrder: z.number().int().min(0).max(100),
    version: VersionSchema,
  })
  .strict();

export const BranchListResponseSchema = createPaginatedResponseSchema(
  BranchRecordSchema,
  "Paginated list of tenant branches/outlets.",
);

// --- Authenticated Lead Inbox ---
export const LeadStatusSchema = z.enum(["new", "contacted", "closed"]);

export const LeadRecordSchema = z
  .object({
    id: SequentialIdSchema,
    name: z.string().min(1).max(100),
    phone: NormalizedPhoneSchema,
    email: EmailSchema.nullable(),
    message: z.string().min(1).max(2000),
    status: LeadStatusSchema,
    preferredDate: z.string().nullable(),
    preferredTime: z.enum(["pagi", "siang", "sore", "malam"]).nullable(),
    branchId: SequentialIdSchema.nullable(),
    sourceCategory: z.string().max(40).nullable(),
    internalNotes: z.string().max(2000).nullable(),
    version: VersionSchema,
    createdAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({ description: "Tenant lead inbox record (owner/admin only; never public)." });

export const LeadListResponseSchema = createPaginatedResponseSchema(
  LeadRecordSchema,
  "Paginated lead inbox list for the scoped tenant.",
);

export const LeadStatusUpdateRequestSchema = z
  .object({
    status: LeadStatusSchema,
    internalNotes: z.string().max(2000).nullable().optional(),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Forward-only lead follow-up status update (owner/admin only)." });

// --- Private In-Process Draft Preview (PLAN §14) ---
export const DraftPreviewRequestSchema = z
  .object({
    resourceKind: z.enum(["page", "post", "offering"]),
    resourceId: SequentialIdSchema,
    version: VersionSchema,
    themeId: ThemeIdSchema.optional(),
  })
  .strict()
  .meta({ description: "Authorize and render an uncacheable in-process draft preview (PLAN §14)." });

export const DraftPreviewResponseSchema = z
  .object({
    html: z.string().max(500_000),
    themeId: ThemeIdSchema,
    version: VersionSchema,
  })
  .strict();

const SETTINGS_GROUP_PATH_PARAM = {
  name: "group",
  in: "path" as const,
  required: true,
  description: "Tenant settings group name.",
  schema: SettingsGroupSchema,
};

const MENU_LOCATION_PATH_PARAM = {
  name: "location",
  in: "path" as const,
  required: true,
  description: "Navigation menu location.",
  schema: MenuLocationSchema,
};

const THEME_ID_PATH_PARAM = {
  name: "themeId",
  in: "path" as const,
  required: true,
  description: "Registered theme ID.",
  schema: ThemeIdSchema,
};

const REVISION_NUMBER_PATH_PARAM = {
  name: "revisionNumber",
  in: "path" as const,
  required: true,
  description: "Per-resource sequential revision number.",
  schema: SequentialIdSchema,
};

export const CMS_ROUTES: readonly RouteContract[] = [
  // Pages
  {
    path: "/api/tenants/{tenantId}/pages",
    method: "get",
    operationId: "tenantListPages",
    tag: "CMS",
    summary: "List pages in the scoped tenant",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "PageListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages",
    method: "post",
    operationId: "tenantCreatePage",
    tag: "CMS",
    summary: "Create a draft page",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "PageCreateRequest",
    successStatus: 201,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}",
    method: "get",
    operationId: "tenantGetPage",
    tag: "CMS",
    summary: "Read a single page by sequential ID",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}",
    method: "patch",
    operationId: "tenantUpdatePage",
    tag: "CMS",
    summary: "Save draft changes to a page",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "PageUpdateRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/publish",
    method: "post",
    operationId: "tenantPublishPage",
    tag: "CMS",
    summary: "Atomically publish page draft snapshot",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:publish",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "ResourcePublishRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/unpublish",
    method: "post",
    operationId: "tenantUnpublishPage",
    tag: "CMS",
    summary: "Unpublish a page and invalidate public cache",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:publish",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "ResourceUnpublishRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/trash",
    method: "post",
    operationId: "tenantTrashPage",
    tag: "CMS",
    summary: "Move page to 30-day trash and unpublish atomically",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "ResourceUnpublishRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/restore",
    method: "post",
    operationId: "tenantRestorePage",
    tag: "CMS",
    summary: "Restore trashed page to draft state",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "TrashRestoreRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/revisions",
    method: "get",
    operationId: "tenantListPageRevisions",
    tag: "CMS",
    summary: "List latest 20 revisions for a page",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "RevisionListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/pages/{resourceId}/revisions/{revisionNumber}/restore",
    method: "post",
    operationId: "tenantRestorePageRevision",
    tag: "CMS",
    summary: "Restore a historical page revision as draft",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM, REVISION_NUMBER_PATH_PARAM],
    requestBodySchemaId: "RevisionRestoreRequest",
    successStatus: 200,
    successSchemaId: "PageRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Posts
  {
    path: "/api/tenants/{tenantId}/posts",
    method: "get",
    operationId: "tenantListPosts",
    tag: "CMS",
    summary: "List blog posts in the scoped tenant",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "PostListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/posts",
    method: "post",
    operationId: "tenantCreatePost",
    tag: "CMS",
    summary: "Create a draft blog post",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "PostCreateRequest",
    successStatus: 201,
    successSchemaId: "PostRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/posts/{resourceId}",
    method: "patch",
    operationId: "tenantUpdatePost",
    tag: "CMS",
    summary: "Save draft updates to a blog post",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "PostUpdateRequest",
    successStatus: 200,
    successSchemaId: "PostRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/posts/{resourceId}/publish",
    method: "post",
    operationId: "tenantPublishPost",
    tag: "CMS",
    summary: "Atomically publish a blog post",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:publish",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "ResourcePublishRequest",
    successStatus: 200,
    successSchemaId: "PostRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Catalog / Typed Offerings
  {
    path: "/api/tenants/{tenantId}/catalog",
    method: "get",
    operationId: "tenantListCatalog",
    tag: "CMS",
    summary: "List typed catalog offerings (service, product, tour, vehicle)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "OfferingListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/catalog",
    method: "post",
    operationId: "tenantCreateOffering",
    tag: "CMS",
    summary: "Create a draft typed offering",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "OfferingCreateRequest",
    successStatus: 201,
    successSchemaId: "OfferingRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/catalog/{resourceId}",
    method: "patch",
    operationId: "tenantUpdateOffering",
    tag: "CMS",
    summary: "Save draft updates to a typed offering",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "OfferingUpdateRequest",
    successStatus: 200,
    successSchemaId: "OfferingRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/catalog/{resourceId}/publish",
    method: "post",
    operationId: "tenantPublishOffering",
    tag: "CMS",
    summary: "Atomically publish a typed offering",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:publish",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "ResourcePublishRequest",
    successStatus: 200,
    successSchemaId: "OfferingRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Taxonomies
  {
    path: "/api/tenants/{tenantId}/categories",
    method: "get",
    operationId: "tenantListCategories",
    tag: "CMS",
    summary: "List post and offering categories",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "TaxonomyListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/categories",
    method: "post",
    operationId: "tenantCreateCategory",
    tag: "CMS",
    summary: "Create a category (depth <= 3)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "taxonomy:manage",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "TaxonomyCreateRequest",
    successStatus: 201,
    successSchemaId: "TaxonomyRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/tags",
    method: "get",
    operationId: "tenantListTags",
    tag: "CMS",
    summary: "List flat blog tags",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "TaxonomyListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/tags",
    method: "post",
    operationId: "tenantCreateTag",
    tag: "CMS",
    summary: "Create a flat blog tag",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "taxonomy:manage",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "TaxonomyCreateRequest",
    successStatus: 201,
    successSchemaId: "TaxonomyRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Menus
  {
    path: "/api/tenants/{tenantId}/menus/{location}",
    method: "put",
    operationId: "tenantUpsertMenu",
    tag: "CMS",
    summary: "Replace cycle-free 3-level navigation menu",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "menu:manage",
    parameters: [TENANT_HANDLE_PATH_PARAM, MENU_LOCATION_PATH_PARAM],
    requestBodySchemaId: "MenuUpsertRequest",
    successStatus: 200,
    successSchemaId: "MenuRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Media
  {
    path: "/api/tenants/{tenantId}/media",
    method: "get",
    operationId: "tenantListMedia",
    tag: "CMS",
    summary: "List tenant media library items",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "MediaListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/media/upload-intent",
    method: "post",
    operationId: "tenantCreateMediaUploadIntent",
    tag: "CMS",
    summary: "Reserve storage quota and issue same-origin upload intent",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "media:upload",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "MediaUploadIntentRequest",
    successStatus: 201,
    successSchemaId: "MediaUploadIntentResponse",
    errorStatuses: [400, 401, 403, 404, 413, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/tenants/{tenantId}/media/{resourceId}",
    method: "patch",
    operationId: "tenantUpdateMediaMetadata",
    tag: "CMS",
    summary: "Update media ALT metadata",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "media:manage",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "MediaMetadataUpdateRequest",
    successStatus: 200,
    successSchemaId: "MediaItemRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Outlets / Branches
  {
    path: "/api/tenants/{tenantId}/outlets",
    method: "get",
    operationId: "tenantListOutlets",
    tag: "CMS",
    summary: "List tenant branch/outlet locations",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "BranchListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/outlets",
    method: "post",
    operationId: "tenantCreateOutlet",
    tag: "CMS",
    summary: "Create a branch/outlet (owner/admin only, max 10)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "outlet:manage",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "BranchCreateRequest",
    successStatus: 201,
    successSchemaId: "BranchRecord",
    errorStatuses: [400, 401, 403, 404, 415, 422, 503],
  },
  // Settings & Themes
  {
    path: "/api/tenants/{tenantId}/settings/{group}",
    method: "get",
    operationId: "tenantGetSettingsGroup",
    tag: "CMS",
    summary: "Read a tenant settings group (owner/admin only)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "settings:read",
    parameters: [TENANT_HANDLE_PATH_PARAM, SETTINGS_GROUP_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "SettingsStateResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/settings/{group}",
    method: "patch",
    operationId: "tenantPatchSettingsGroup",
    tag: "CMS",
    summary: "Save draft updates to a tenant settings group (owner/admin only)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "settings:write",
    parameters: [TENANT_HANDLE_PATH_PARAM, SETTINGS_GROUP_PATH_PARAM],
    requestBodySchemaId: "SiteIdentitySettingsPatch",
    successStatus: 200,
    successSchemaId: "SettingsStateResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/settings/publish",
    method: "post",
    operationId: "tenantPublishSettings",
    tag: "CMS",
    summary: "Atomically publish site identity and settings draft",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "settings:publish",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "ResourcePublishRequest",
    successStatus: 200,
    successSchemaId: "SettingsStateResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/themes",
    method: "get",
    operationId: "tenantListThemes",
    tag: "CMS",
    summary: "List built-in, marketplace, and granted custom themes",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "settings:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "ThemeListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/themes/{themeId}/activate",
    method: "post",
    operationId: "tenantActivateTheme",
    tag: "CMS",
    summary: "Activate a granted theme atomically (owner/admin only)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "theme:activate",
    parameters: [TENANT_HANDLE_PATH_PARAM, THEME_ID_PATH_PARAM],
    requestBodySchemaId: "ThemeActivateRequest",
    successStatus: 200,
    successSchemaId: "ThemeListResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/themes/custom-requests",
    method: "post",
    operationId: "tenantCreateCustomThemeRequest",
    tag: "CMS",
    summary: "Submit a custom theme service request (max 3/day)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "theme:custom_request",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "CustomThemeRequestCreate",
    successStatus: 201,
    successSchemaId: "CustomThemeRequestRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  // Draft Preview
  {
    path: "/api/tenants/{tenantId}/preview",
    method: "post",
    operationId: "tenantRenderDraftPreview",
    tag: "CMS",
    summary: "Render an authorized private in-process draft preview (PLAN §14)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requiredPermission: "content:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "DraftPreviewRequest",
    successStatus: 200,
    successSchemaId: "DraftPreviewResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  // Authenticated Lead Inbox
  {
    path: "/api/tenants/{tenantId}/leads",
    method: "get",
    operationId: "tenantListLeads",
    tag: "CMS",
    summary: "List captured visitor leads (owner/admin only; never anonymous)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "lead:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "LeadListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/leads/{resourceId}",
    method: "patch",
    operationId: "tenantUpdateLeadStatus",
    tag: "CMS",
    summary: "Update lead follow-up status (owner/admin only)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "lead:update",
    parameters: [TENANT_HANDLE_PATH_PARAM, RESOURCE_ID_PATH_PARAM],
    requestBodySchemaId: "LeadStatusUpdateRequest",
    successStatus: 200,
    successSchemaId: "LeadRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
];

export const CMS_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    ContentLifecycleStatus: ContentLifecycleStatusSchema,
    ResourceSeoInput: ResourceSeoInputSchema,
    PageCreateRequest: PageCreateRequestSchema,
    PageUpdateRequest: PageUpdateRequestSchema,
    ResourcePublishRequest: ResourcePublishRequestSchema,
    ResourceUnpublishRequest: ResourceUnpublishRequestSchema,
    PageRecord: PageRecordSchema,
    PageListResponse: PageListResponseSchema,
    RevisionSummary: RevisionSummarySchema,
    RevisionListResponse: RevisionListResponseSchema,
    RevisionRestoreRequest: RevisionRestoreRequestSchema,
    TrashRestoreRequest: TrashRestoreRequestSchema,
    RestrictedRichTextNode: RestrictedRichTextNodeSchema,
    RestrictedRichTextDoc: RestrictedRichTextDocSchema,
    PostCreateRequest: PostCreateRequestSchema,
    PostUpdateRequest: PostUpdateRequestSchema,
    PostRecord: PostRecordSchema,
    PostListResponse: PostListResponseSchema,
    TaxonomyKind: TaxonomyKindSchema,
    TaxonomyCreateRequest: TaxonomyCreateRequestSchema,
    TaxonomyUpdateRequest: TaxonomyUpdateRequestSchema,
    TaxonomyRecord: TaxonomyRecordSchema,
    TaxonomyListResponse: TaxonomyListResponseSchema,
    OfferingCreateRequest: OfferingCreateRequestSchema,
    OfferingUpdateRequest: OfferingUpdateRequestSchema,
    OfferingRecord: OfferingRecordSchema,
    OfferingListResponse: OfferingListResponseSchema,
    MenuLocation: MenuLocationSchema,
    MenuUpsertRequest: MenuUpsertRequestSchema,
    MenuRecord: MenuRecordSchema,
    SettingsGroup: SettingsGroupSchema,
    SiteIdentitySettingsPatch: SiteIdentitySettingsPatchSchema,
    SettingsStateResponse: SettingsStateResponseSchema,
    ThemeSummary: ThemeSummarySchema,
    ThemeListResponse: ThemeListResponseSchema,
    ThemeActivateRequest: ThemeActivateRequestSchema,
    CustomThemeRequestCreate: CustomThemeRequestCreateSchema,
    CustomThemeRequestRecord: CustomThemeRequestRecordSchema,
    MediaUploadIntentRequest: MediaUploadIntentRequestSchema,
    MediaUploadIntentResponse: MediaUploadIntentResponseSchema,
    MediaItemRecord: MediaItemRecordSchema,
    MediaListResponse: MediaListResponseSchema,
    MediaMetadataUpdateRequest: MediaMetadataUpdateRequestSchema,
    BranchCreateRequest: BranchCreateRequestSchema,
    BranchUpdateRequest: BranchUpdateRequestSchema,
    BranchRecord: BranchRecordSchema,
    BranchListResponse: BranchListResponseSchema,
    LeadStatus: LeadStatusSchema,
    LeadRecord: LeadRecordSchema,
    LeadListResponse: LeadListResponseSchema,
    LeadStatusUpdateRequest: LeadStatusUpdateRequestSchema,
    DraftPreviewRequest: DraftPreviewRequestSchema,
    DraftPreviewResponse: DraftPreviewResponseSchema,
  },
  routes: CMS_ROUTES,
};
